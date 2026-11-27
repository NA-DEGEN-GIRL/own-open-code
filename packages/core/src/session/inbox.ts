export * as SessionInbox from "./inbox.js"

// OWN-PATCH(P-035) begin: gt, ne, sql
import { and, asc, eq, gt, ne, or, sql } from "drizzle-orm"
// OWN-PATCH(P-035) end
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  // OWN-PATCH(P-035) begin
  Reset,
  ResetPayload,
  // OWN-PATCH(P-035) end
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
} from "@opencode/schema/session-inbox"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { SessionEvent } from "./event.js"
import { SessionBlob } from "./blob.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionStored } from "./stored.js"
import { SessionInboxTable, SessionMessageTable } from "./sql.js"
import { SessionHistory } from "./history.js"

type DatabaseService = Database.Interface["db"]

export {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  // OWN-PATCH(P-035) begin
  Reset,
  ResetPayload,
  // OWN-PATCH(P-035) end
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
}

/**
 * Which pending input `promote` may consume: "steer" promotes steers only (a step
 * boundary mid-work), while "input" also allows one queued input when no steers are
 * waiting (the idle boundary, where the Session picks up fresh work).
 */
export type Promotable = "input" | "steer"

const decodeUser = Schema.decodeUnknownSync(UserPayload)
const decodeMediaUser = Schema.decodeUnknownSync(MediaUserPayload)
const decodeStoredUser = Schema.decodeUnknownSync(SessionStored.UserPayload)
const encodeStoredUser = Schema.encodeSync(SessionStored.UserPayload)
const decodeSynthetic = Schema.decodeUnknownSync(SyntheticPayload)
const encodeSynthetic = Schema.encodeSync(SyntheticPayload)
const decodeCompaction = Schema.decodeUnknownSync(CompactionPayload)
const encodeCompaction = Schema.encodeSync(CompactionPayload)
const decodeMove = Schema.decodeUnknownSync(MovePayload)
const encodeMove = Schema.encodeSync(MovePayload)
// OWN-PATCH(P-035) begin
const decodeReset = Schema.decodeUnknownSync(ResetPayload)
const encodeReset = Schema.encodeSync(ResetPayload)
// OWN-PATCH(P-035) end
const inboxLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
type PendingRef = { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID }

export const serialized = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
  inboxLocks.withLock(sessionID)(effect)

export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()("SessionInbox.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

function matches<Type extends Item["type"]>(
  stored: Info,
  request: PendingRef & { readonly type: Type },
): stored is Extract<Info, { readonly type: Type }> {
  return stored.sessionID === request.sessionID && stored.type === request.type
}

const fromRow = (row: typeof SessionInboxTable.$inferSelect): Info => {
  const base = {
    id: row.id,
    sessionID: row.session_id,
    time: { created: DateTime.makeUnsafe(row.time_created) },
  }
  if (row.type === "compaction")
    return Compaction.make({
      ...base,
      type: "compaction",
      payload: decodeCompaction(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "move")
    return Move.make({ ...base, type: "move", payload: decodeMove(row.payload), delivery: row.delivery })
  // OWN-PATCH(P-035) begin
  if (row.type === "reset")
    return Reset.make({ ...base, type: "reset", payload: decodeReset(row.payload), delivery: row.delivery })
  // OWN-PATCH(P-035) end
  if (row.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: decodeUser(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: decodeSynthetic(row.payload),
      delivery: row.delivery,
    })
  throw new LifecycleConflict({ id: base.id })
}

export const find = Effect.fn("SessionInbox.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie)
  if (row === undefined) return undefined
  const [hydrated] = yield* SessionBlob.hydrateInbox(db, [row])
  return hydrated && fromRow(hydrated)
})

const promotedFromMessage = Effect.fn("SessionInbox.promotedFromMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  if (row.session_id !== sessionID || (row.type !== "user" && row.type !== "synthetic"))
    return yield* new LifecycleConflict({ id })
  const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
  if (!message) return undefined
  const base = { id, sessionID, time: { created: message.time.created }, delivery }
  if (message.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: UserPayload.make({
        text: message.text,
        files: message.files,
        agents: message.agents,
        skills: message.skills,
        metadata: message.metadata,
      }),
    })
  if (message.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: SyntheticPayload.make({
        text: message.text,
        description: message.description,
        metadata: message.metadata,
      }),
    })
})

export type Interface = Effect.Success<ReturnType<typeof make>>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInbox") {}

export const make = Effect.fn("SessionInbox.make")(function* () {
  const database = yield* Database.Service
  const db = database.db
  const bus = yield* Bus.Service

  /** First admission wins for matching Session and type, without preparing a new payload. */
  const reconcile = Effect.fn("SessionInbox.reconcile")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly type: Type
    readonly delivery: Delivery
  }) {
    const existing =
      (yield* find(db, request.id)) ?? (yield* promotedFromMessage(db, request.sessionID, request.id, request.delivery))
    if (existing === undefined) return undefined
    // OWN-PATCH(P-035) begin: like compaction, a reset owns its admission (`admitReset`)
    if (existing.type === "compaction" || existing.type === "reset" || !matches(existing, request))
      // OWN-PATCH(P-035) end
      return yield* new LifecycleConflict({ id: request.id })
    return existing
  })

  const admit = Effect.fn("SessionInbox.admit")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item & { readonly type: Type }
  }) {
    const existing = yield* reconcile({ ...request, type: request.item.type, delivery: request.item.delivery })
    if (existing !== undefined) return existing
    const admitted = yield* bus
      .publish(SessionEvent.InboxEnqueued, {
        inboxID: request.id,
        sessionID: request.sessionID,
        item: request.item,
      })
      .pipe(
        Effect.map((event) =>
          Info.make({
            id: request.id,
            sessionID: request.sessionID,
            time: { created: DateTime.makeUnsafe(event.created) },
            ...request.item,
          }),
        ),
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, request.id).pipe(
                Effect.flatMap((stored) => (stored === undefined ? Effect.fail(defect) : Effect.succeed(stored))),
              )
            : Effect.die(defect),
        ),
      )
    if (!matches(admitted, { ...request, type: request.item.type }))
      return yield* new LifecycleConflict({ id: request.id })
    return admitted
  })

  const admitCompaction = Effect.fn("SessionInbox.admitCompaction")(function* (input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly delivery: Delivery
  }) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const exact = yield* find(db, input.id)
        if (exact) {
          if (exact.type === "compaction" && exact.sessionID === input.sessionID) return exact
          return yield* new LifecycleConflict({ id: input.id })
        }
        if (yield* promotedFromMessage(db, input.sessionID, input.id, input.delivery))
          return yield* new LifecycleConflict({ id: input.id })
        const pending = (yield* list(db, input.sessionID)).find((item) => item.type === "compaction")
        if (pending) return pending
        return yield* admit({
          id: input.id,
          sessionID: input.sessionID,
          item: { type: "compaction", payload: {}, delivery: input.delivery },
        })
      }),
    )
  })

  // OWN-PATCH(P-035) begin
  /**
   * A context reset is always queued: it delivers at an idle boundary, after the running turn. A second request while
   * one is pending returns the pending item; reusing a delivered ID, or another item's, conflicts.
   */
  const admitReset = Effect.fn("SessionInbox.admitReset")(function* (input: PendingRef) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const exact = yield* find(db, input.id)
        if (exact) {
          if (exact.type === "reset" && exact.sessionID === input.sessionID) return exact
          return yield* new LifecycleConflict({ id: input.id })
        }
        const message = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, input.id))
          .get()
          .pipe(Effect.orDie)
        if (message) return yield* new LifecycleConflict({ id: input.id })
        const pending = (yield* list(db, input.sessionID)).find((item) => item.type === "reset")
        if (pending) return pending
        return yield* admit({ ...input, item: { type: "reset", payload: {}, delivery: Delivery.make("queue") } })
      }),
    )
  })
  // OWN-PATCH(P-035) end

  const cancel = Effect.fn("SessionInbox.cancel")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxCancelled, {
        sessionID: input.sessionID,
        inboxID: input.id,
      }),
    ),
  )

  const steer = Effect.fn("SessionInbox.steer")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "steer",
      }),
    ),
  )

  const queue = Effect.fn("SessionInbox.queue")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "queue",
      }),
    ),
  )

  return {
    list: (sessionID: SessionSchema.ID) => list(db, sessionID),
    reconcile,
    admit,
    admitCompaction,
    // OWN-PATCH(P-035) begin
    admitReset,
    // OWN-PATCH(P-035) end
    cancel,
    steer,
    queue,
  }
})

export const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })

export const projectAdmitted = Effect.fn("SessionInbox.projectAdmitted")(function* (
  db: DatabaseService,
  request: {
    readonly enqueuedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item
    readonly timeCreated: number
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, request.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  const payload =
    request.item.type === "user"
      ? encodeStoredUser(yield* SessionBlob.externalizePayload(db, request.item.payload))
      : request.item.type === "synthetic"
        ? encodeSynthetic(request.item.payload)
        : request.item.type === "compaction"
          ? encodeCompaction(request.item.payload)
          : // OWN-PATCH(P-035) begin
            request.item.type === "reset"
            ? encodeReset(request.item.payload)
            : // OWN-PATCH(P-035) end
              encodeMove(request.item.payload)
  const stored = yield* db
    .insert(SessionInboxTable)
    .values({
      id: request.id,
      session_id: request.sessionID,
      type: request.item.type,
      payload,
      delivery: request.item.delivery,
      enqueued_seq: request.enqueuedSeq,
      time_created: request.timeCreated,
    })
    .onConflictDoNothing()
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  yield* SessionBlob.recordRefs(
    db,
    { sessionID: request.sessionID, messageID: request.id, seq: request.enqueuedSeq },
    payload,
  )
})

/**
 * Consume one pending row at promotion. The row's content feeds the projected
 * message insert inside the same event transaction; the deleted row is what
 * makes the table pending-only.
 */
export const projectDelivered = Effect.fn("SessionInbox.projectDelivered")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(and(eq(SessionInboxTable.id, input.id), eq(SessionInboxTable.session_id, input.sessionID)))
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return delivered(deleted)
})

/** A consumed row with its payload as stored, so user file refs reach the message without their blobs. */
export type Delivered =
  | { readonly id: SessionMessage.ID; readonly type: "user"; readonly payload: SessionStored.UserPayload }
  | { readonly id: SessionMessage.ID; readonly type: "synthetic"; readonly payload: SyntheticPayload }
  // OWN-PATCH(P-035) begin: a context reset
  | { readonly id: SessionMessage.ID; readonly type: "compaction" | "move" | "reset" }
  // OWN-PATCH(P-035) end

const delivered = (row: typeof SessionInboxTable.$inferSelect): Delivered => {
  if (row.type === "user") return { id: row.id, type: "user", payload: decodeStoredUser(row.payload) }
  if (row.type === "synthetic") return { id: row.id, type: "synthetic", payload: decodeSynthetic(row.payload) }
  return { id: row.id, type: row.type }
}

export const projectCancelled = Effect.fn("SessionInbox.projectCancelled")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        or(eq(SessionInboxTable.delivery, "queue"), eq(SessionInboxTable.delivery, "steer")),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  yield* SessionBlob.releaseMessage(db, input.sessionID, input.id)
})

const projectDelivery = Effect.fn("SessionInbox.projectDelivery")(function* (
  db: DatabaseService,
  input: PendingRef & { readonly from: Delivery; readonly to: Delivery },
) {
  const updated = yield* db
    .update(SessionInboxTable)
    .set({ delivery: input.to })
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        eq(SessionInboxTable.delivery, input.from),
        // OWN-PATCH(P-035) begin: a reset stays queued; it never steers into a running turn
        ne(SessionInboxTable.type, "reset"),
        // OWN-PATCH(P-035) end
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectDeliveryChanged = Effect.fn("SessionInbox.projectDeliveryChanged")(
  (db: DatabaseService, input: PendingRef & { readonly delivery: Delivery }) =>
    projectDelivery(db, {
      ...input,
      from: input.delivery === "steer" ? "queue" : "steer",
      to: input.delivery,
    }),
)

const listRows = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, sessionID))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)

export const list = Effect.fn("SessionInbox.list")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* SessionBlob.hydrateInbox(db, yield* listRows(db, sessionID))).map(fromRow)
})

/** {@link list} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
export const listWithRefs = Effect.fn("SessionInbox.listWithRefs")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const kept = yield* SessionBlob.keepInboxRefs(db, yield* listRows(db, sessionID))
  return kept.rows.map((row): MediaInfo => {
    if (row.type !== "user") return fromRow(row)
    const payload = decodeMediaUser(row.payload)
    return MediaUser.make({
      id: row.id,
      sessionID: row.session_id,
      time: { created: DateTime.makeUnsafe(row.time_created) },
      type: "user",
      payload: payload.files ? { ...payload, files: SessionBlob.describe(payload.files, kept.meta) } : payload,
      delivery: row.delivery,
    })
  })
})

export const moveIDs = Effect.fn("SessionInbox.moveIDs")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.type, "move")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)
})

export const nextPromotable = Effect.fn("SessionInbox.nextPromotable")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotable: Promotable,
  // OWN-PATCH(P-035) begin
  options?: {
    /** Queued prompts stay parked at this boundary (a stop, a steer-scoped drain): none of them holds a waiting reset. */
    readonly parked?: boolean
    /** A boundary inside a running turn: its background notices cross a waiting reset (`pendingSteers`). */
    readonly turn?: boolean
  },
) {
  // Passive input never comes next on its own.
  const steer = (yield* pendingSteers(db, sessionID, options?.turn === true)).find((row) => !passive(row))
  if (steer) return promotion(steer)
  if (promotable !== "input") return undefined
  const queued = yield* firstQueued(db, sessionID, options?.parked === true)
  // OWN-PATCH(P-035) end
  return queued ? promotion(queued) : undefined
})

/** What a boundary decides on: prompts are promoted by id, so only a move's payload is read. */
export type Promotion =
  | {
      readonly id: SessionMessage.ID
      // OWN-PATCH(P-035) begin
      readonly type: "user" | "synthetic" | "compaction" | "reset"
      // OWN-PATCH(P-035) end
      readonly delivery: Delivery
    }
  | {
      readonly id: SessionMessage.ID
      readonly type: "move"
      readonly delivery: Delivery
      readonly payload: MovePayload
    }

const promotion = (row: typeof SessionInboxTable.$inferSelect): Promotion =>
  row.type === "move"
    ? { id: row.id, type: "move", delivery: row.delivery, payload: decodeMove(row.payload) }
    : { id: row.id, type: row.type, delivery: row.delivery }

/** Which pending rows count: "input" means any item in either delivery mode. */
export type Scope = "input" | Delivery

export const has = Effect.fn("SessionInbox.has")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  scope: Scope,
) {
  const row = yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.session_id, sessionID),
        scope === "input"
          ? or(eq(SessionInboxTable.delivery, "steer"), eq(SessionInboxTable.delivery, "queue"))
          : eq(SessionInboxTable.delivery, scope),
        // OWN-PATCH(P-035) begin: passive input (a notice before a reset) never starts work on its own, so the idle
        // hook's check (upstream v2.2.1) does not keep a drain going for it
        sql`json_extract(${SessionInboxTable.payload}, '$.beforeReset') is null`,
        // OWN-PATCH(P-035) end
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

const publishMutation = <A, E, R>(input: PendingRef, effect: Effect.Effect<A, E, R>) =>
  serialized(input.sessionID, effect).pipe(
    Effect.asVoid,
    // Bus projectors abort their transaction through the defect channel.
    Effect.catchDefect((defect) => (defect instanceof LifecycleConflict ? Effect.fail(defect) : Effect.die(defect))),
  )

const publish = Effect.fn("SessionInbox.publish")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInboxTable.$inferSelect>,
) {
  yield* Effect.forEach(
    rows,
    (row) => {
      if (row.type !== "move" && row.type !== "user" && row.type !== "synthetic")
        return Effect.die(new LifecycleConflict({ id: row.id }))
      return bus
        .publish(SessionEvent.InboxDelivered, {
          sessionID,
          inboxID: row.id,
        })
        .pipe(
          Effect.catchDefect((defect) =>
            defect instanceof LifecycleConflict
              ? promotedFromMessage(db, sessionID, row.id, row.delivery).pipe(
                  Effect.flatMap((stored) => (stored !== undefined ? Effect.void : Effect.die(defect))),
                  Effect.orDie,
                )
              : Effect.die(defect),
          ),
        )
    },
    { discard: true },
  )
  return rows.length
})

/**
 * Promotes pending input into visible messages and returns the promoted count,
 * or undefined when the runner must first handle a pending control.
 * Steered compaction takes priority over pending prompts, without crossing a move.
 * Only the "input" scope may fall through to one queued input.
 */
export const promote = Effect.fn("SessionInbox.promote")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  scope: Promotable,
  // OWN-PATCH(P-035) begin: a boundary inside a running turn (`nextPromotable`)
  options?: { readonly turn?: boolean },
  // OWN-PATCH(P-035) end
) {
  return yield* serialized(
    sessionID,
    Effect.gen(function* () {
      // OWN-PATCH(P-035) begin: passive steers ride with other input; alone they are nothing to promote
      const turn = options?.turn === true
      const steers = yield* pendingSteers(db, sessionID, turn)
      if (steers.some((row) => !passive(row)) || scope === "steer") {
        const batch = beforeControl(steers)
        if (!batch.some((row) => !passive(row))) return batch.length === steers.length ? 0 : undefined
        return yield* publish(db, bus, sessionID, batch)
      }

      const queued = yield* firstQueued(db, sessionID, false)
      if (!queued) return 0
      if (isControl(queued) || queued.type === "reset") return undefined
      // The passive steers waiting before the barrier ride with it, in enqueue order.
      const promoted = yield* publish(
        db,
        bus,
        sessionID,
        [...steers, queued].toSorted((a, b) => a.enqueued_seq - b.enqueued_seq),
      )
      return promoted + (yield* publish(db, bus, sessionID, beforeControl(yield* pendingSteers(db, sessionID, turn))))
      // OWN-PATCH(P-035) end
    }),
  )
})

const isControl = (row: typeof SessionInboxTable.$inferSelect) => row.type === "compaction" || row.type === "move"

const beforeControl = (rows: Array<typeof SessionInboxTable.$inferSelect>) => {
  const control = rows.findIndex(isControl)
  return control === -1 ? rows : rows.slice(0, control)
}

// OWN-PATCH(P-035) begin: `turn`, a boundary inside a running turn
const pendingSteers = (db: DatabaseService, sessionID: SessionSchema.ID, turn = false) =>
  // OWN-PATCH(P-035) end
  db
    .select()
    .from(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.session_id, sessionID),
        // OWN-PATCH(P-035) begin: a passive item rides like a steer whatever its delivery
        or(eq(SessionInboxTable.delivery, "steer"), eq(SessionInboxTable.type, "reset"), passiveRow),
        // OWN-PATCH(P-035) end
      ),
    )
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((pending) => {
        // OWN-PATCH(P-035) begin: a pending context reset (always queued) is a barrier. Input admitted after it
        // delivers after it, at every boundary, so it starts the new context instead of joining the old one. A
        // background notice belongs to the turn still running, though (`ofTurn`): at that turn's boundaries it crosses
        // the barrier as if there were no reset; once the turn ended, the reset's delivery makes it passive.
        const barrier = pending.findIndex((row) => row.type === "reset")
        const rows =
          barrier === -1
            ? pending
            : [...pending.slice(0, barrier), ...(turn ? pending.slice(barrier + 1).filter(ofTurn) : [])]
        // OWN-PATCH(P-035) end
        // A move changes the context's Location: never pull compaction across it.
        // Within that boundary, compact before promoting even earlier steers so
        // their text stays verbatim after the checkpoint, not inside its summary.
        const control = rows.findIndex(isControl)
        if (control > 0 && rows[control].type === "compaction") rows.unshift(...rows.splice(control, 1))
        return rows
      }),
    )

// OWN-PATCH(P-035) begin
/** The line a passive notice's message starts with, written at delivery (11 §7.2). */
export const BEFORE_RESET = "(This background task started before the context was reset.)"

/**
 * A passive synthetic (a background notice of work started before a context reset that still waits or applies, 11
 * §7.2: its pending row names that reset, `beforeReset`) never promotes on its own: it delivers only in the same
 * promotion as other input, in enqueue order. A boundary with only passive input pending is idle.
 */
const passive = (row: typeof SessionInboxTable.$inferSelect) =>
  row.type === "synthetic" && "beforeReset" in row.payload && typeof row.payload.beforeReset === "string"
const passiveRow = sql`json_extract(${SessionInboxTable.payload}, '$.beforeReset') is not null`
/** A background notice (`payload.background`) steered into the running turn, not passive. */
const ofTurn = (row: typeof SessionInboxTable.$inferSelect) =>
  row.type === "synthetic" &&
  row.delivery === "steer" &&
  "background" in row.payload &&
  row.payload.background === true &&
  !passive(row)

/**
 * A reset that no longer applies (cancelled while it waited, or undone) releases the notices it held passive: they
 * become ordinary, unless a reset admitted before them still waits, which they then precede. Projection data, so
 * replay derives it again from the cancel or undo event.
 */
export const projectReleased = Effect.fn("SessionInbox.projectReleased")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly resetID: SessionMessage.ID },
) {
  const held = and(
    eq(SessionInboxTable.session_id, input.sessionID),
    sql`json_extract(${SessionInboxTable.payload}, '$.beforeReset') = ${input.resetID}`,
  )
  const waiting = yield* db
    .select({ id: SessionInboxTable.id, seq: SessionInboxTable.enqueued_seq })
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, input.sessionID), eq(SessionInboxTable.type, "reset")))
    .get()
    .pipe(Effect.orDie)
  if (waiting)
    yield* db
      .update(SessionInboxTable)
      .set({ payload: sql`json_set(${SessionInboxTable.payload}, '$.beforeReset', ${waiting.id})` })
      .where(and(held, gt(SessionInboxTable.enqueued_seq, waiting.seq)))
      .run()
      .pipe(Effect.orDie)
  yield* db
    .update(SessionInboxTable)
    .set({ payload: sql`json_remove(${SessionInboxTable.payload}, '$.beforeReset')` })
    .where(held)
    .run()
    .pipe(Effect.orDie)
})

/**
 * A reset delivers once the turn it waited for has ended (at its end, a stop, an idle reset, a restart): the background
 * notices still pending, admitted before it was requested or while it waited, report work of the context it ends, so
 * they now precede it, passive (those naming an earlier reset keep it). Input a user typed stays ordinary. Projection
 * data of the reset's delivery, so replay derives it again, and a cancel or undo of that reset releases them
 * (`projectReleased`).
 */
export const projectOvertaken = Effect.fn("SessionInbox.projectOvertaken")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly resetID: SessionMessage.ID },
) {
  yield* db
    .update(SessionInboxTable)
    .set({ payload: sql`json_set(${SessionInboxTable.payload}, '$.beforeReset', ${input.resetID})` })
    .where(
      and(
        eq(SessionInboxTable.session_id, input.sessionID),
        eq(SessionInboxTable.type, "synthetic"),
        sql`json_extract(${SessionInboxTable.payload}, '$.background') = 1`,
        sql`json_extract(${SessionInboxTable.payload}, '$.beforeReset') is null`,
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

/**
 * Delivers a pending context reset; callers hold the inbox lock. A pending compaction, admitted before the reset (which
 * overtook it: a stop, an idle reset, a parked queue) or behind it, would summarize the emptied context: it is settled
 * as not needed, cancelled with the reset's delivery, so no failed compaction appears (11 §7.2).
 */
export const deliverReset = Effect.fn("SessionInbox.deliverReset")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  resetID: SessionMessage.ID,
) {
  const settled = (yield* list(db, sessionID)).flatMap((item) =>
    item.type === "compaction" ? [[SessionEvent.InboxCancelled, { sessionID, inboxID: item.id }] as const] : [],
  )
  // One transaction: no reader sees the reset applied while a compaction it settles still waits.
  yield* bus.publishAll([[SessionEvent.InboxDelivered, { sessionID, inboxID: resetID }], ...settled])
})

/** The first queued item that is not passive; where queued prompts stay parked, a waiting reset comes before them. */
const firstQueued = (db: DatabaseService, sessionID: SessionSchema.ID, parked: boolean) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "queue")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const queued = rows.filter((row) => !passive(row))
        return (parked ? queued.find((row) => row.type === "reset") : undefined) ?? queued[0]
      }),
    )
// OWN-PATCH(P-035) end
