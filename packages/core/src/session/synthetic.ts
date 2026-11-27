export * as SessionSynthetic from "./synthetic.js"

import { Effect } from "effect"
// OWN-PATCH(P-035) begin
import { and, asc, eq, gt, sql } from "drizzle-orm"
import type { Database } from "../database/database.js"
import { SessionMessageTable } from "./sql.js"
// OWN-PATCH(P-035) end
import { NotFoundError, SyntheticConflictError } from "./error.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import type { SessionStore } from "./store.js"

export const make = (
  store: SessionStore.Interface,
  inbox: SessionInbox.Interface,
  wake: (id: SessionSchema.ID) => Effect.Effect<void>,
  // OWN-PATCH(P-035) begin: with it a background job's notice follows a context reset (`notice`)
  resets?: Resets,
  // OWN-PATCH(P-035) end
) => {
  const admit = Effect.fn("Session.synthetic")(function* (input: {
    sessionID: SessionSchema.ID
    id?: SessionMessage.ID
    text: string
    description?: string
    metadata?: Record<string, unknown>
    delivery?: SessionInbox.Delivery
    resume?: boolean
    // OWN-PATCH(P-035) begin
    beforeReset?: SessionMessage.ID
    background?: boolean
    startedAt?: number
    // OWN-PATCH(P-035) end
  }) {
    const sessionID = input.sessionID
    const get = store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : new NotFoundError({ sessionID }))))
    yield* get
    const id = input.id ?? SessionMessage.ID.create()
    const admitted = yield* inbox
      .admit({
        id,
        sessionID,
        item: {
          type: "synthetic",
          delivery: input.delivery ?? "steer",
          payload: SessionInbox.SyntheticPayload.make({
            text: input.text,
            description: input.description,
            metadata: input.metadata,
            // OWN-PATCH(P-035) begin
            ...(input.beforeReset ? { beforeReset: input.beforeReset } : {}),
            ...(input.background ? { background: true } : {}),
            // OWN-PATCH(P-035) end
          }),
        },
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => new SyntheticConflictError({ sessionID, inputID: id })),
      )
    if (input.resume !== false && !(yield* get).revert) yield* wake(sessionID)
    return admitted
  }, Effect.uninterruptible)
  // OWN-PATCH(P-035) begin
  /**
   * A background job's notice (`startedAt`: when the job started; `background` alone when that is unknown, as for a
   * job recovered from a record without it; both reach plugins through `ctx.session.synthetic`) is admitted as one
   * (`payload.background`). While a reset waits for the running turn the notice belongs to that turn: it crosses the
   * barrier and delivers at the turn's next boundary, as without a reset (`SessionInbox.pendingSteers`); once the turn
   * ended, the reset's delivery makes it passive if still pending (`projectOvertaken`). For work started before a reset
   * that already applies (03 §18.18) it names that reset (`beforeReset`, see `resetBefore`) and is passive: it never
   * promotes on its own, so it starts no turn; it rides with the next input that promotes, in enqueue order, and its
   * message then starts with `BEFORE_RESET`. Cancelling or undoing that reset makes it ordinary (`undoReset`). The
   * caller's `resume` stays for a reset still waiting: a wake just applies the reset. Under the inbox lock, so a reset
   * delivered meanwhile either names it here or overtakes it at its delivery.
   */
  return Effect.fn("Session.notice")(function* (input: Parameters<typeof admit>[0]) {
    if (resets === undefined || (input.startedAt === undefined && !input.background)) return yield* admit(input)
    const background = { ...input, background: true }
    return yield* SessionInbox.serialized(
      input.sessionID,
      Effect.gen(function* () {
        const reset = yield* resetBefore(resets, input.sessionID, input.startedAt)
        if (reset?.delivered) return yield* admit({ ...background, resume: false, beforeReset: reset.id })
        return yield* admit(reset ? { ...background, beforeReset: reset.id } : background)
      }),
    )
  })
  // OWN-PATCH(P-035) end
}

// OWN-PATCH(P-035) begin
export type Resets = {
  readonly db: Database.Interface["db"]
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

/**
 * The reset a background notice for work started at `startedAt` comes after: the earliest applied one since then that
 * is not undone (`delivered`), else one waiting while the Session has no active execution. Read under the inbox lock.
 */
export const resetBefore = Effect.fnUntraced(function* (
  resets: Resets,
  sessionID: SessionSchema.ID,
  startedAt: number | undefined,
) {
  // Without a start time no applied reset is known to come after the job.
  const delivered =
    startedAt === undefined
      ? undefined
      : yield* resets.db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, "compaction"),
              gt(SessionMessageTable.time_created, startedAt),
              sql`json_extract(${SessionMessageTable.data}, '$.reason') = 'reset'`,
              sql`json_extract(${SessionMessageTable.data}, '$.undone') is null`,
            ),
          )
          .orderBy(asc(SessionMessageTable.seq))
          .get()
          .pipe(Effect.orDie)
  if (delivered) return { id: SessionMessage.ID.make(delivered.id), delivered: true }
  if (yield* resets.isActive(sessionID)) return undefined
  const waiting = (yield* SessionInbox.list(resets.db, sessionID)).find((item) => item.type === "reset")
  return waiting ? { id: waiting.id, delivered: false } : undefined
})
// OWN-PATCH(P-035) end
