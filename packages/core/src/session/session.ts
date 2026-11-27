export * as Session from "./session.js"

import { DateTime, Effect, Fiber, Scope } from "effect"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { Permission } from "@opencode/schema/permission"
import { Event } from "@opencode/schema/event"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { ShellResult } from "../shell/result.js"
import type { Skill } from "../skill.js"
import {
  BusyError,
  CompactionConflictError,
  InboxConflictError,
  NotFoundError,
  PromptConflictError,
  // OWN-PATCH(P-035) begin
  MessageNotFoundError,
  ResetConflictError,
  // OWN-PATCH(P-035) end
} from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionPrompt } from "./prompt.js"
import { SessionRevert } from "./revert.js"
import { SessionShell } from "./shell.js"
import { SessionSkill } from "./skill.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
// OWN-PATCH(P-035) begin
import { and, eq } from "drizzle-orm"
import { SessionHistory } from "./history.js"
import { SessionMessageTable } from "./sql.js"
// OWN-PATCH(P-035) end
import { SessionSynthetic } from "./synthetic.js"

type PromptRequest = SessionPrompt.Input & {
  id?: SessionMessage.ID
  resume?: boolean
}

/**
 * Build once in the host Scope: `const sessions = yield* Session.make()`.
 * Use `sessions.forSession(id)` for handles that share host services and reload current state.
 */
export const make = Effect.fn("Session.make")(function* () {
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  const execution = yield* SessionExecution.Service
  const admission = yield* SessionInbox.Service
  const fs = yield* FSUtil.Service
  const scope = yield* Scope.Scope

  const get = Effect.fn("Session.get")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* new NotFoundError({ sessionID })
    return session
  })
  const message = Effect.fn("Session.message")(function* (sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
    const stored = yield* store.message(messageID)
    return stored?.sessionID === sessionID ? stored.message : undefined
  })
  const view = Effect.fn("Session.view")(function* (sessionID: SessionSchema.ID, input: { idle: number }) {
    const session = yield* get(sessionID)
    if (
      session.time.idle === undefined ||
      input.idle > DateTime.toEpochMillis(session.time.idle) ||
      (session.time.viewed !== undefined && DateTime.toEpochMillis(session.time.viewed) >= input.idle)
    )
      return
    yield* bus.publish(SessionEvent.Viewed, { sessionID, idle: input.idle })
  })
  const rename = Effect.fn("Session.rename")(function* (sessionID: SessionSchema.ID, input: { title: string }) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Renamed, { sessionID, title: input.title })
  })
  const archive = Effect.fn("Session.archive")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (session.time.archived) return
    yield* bus.publish(SessionEvent.Archived, { sessionID })
  })
  const unarchive = Effect.fn("Session.unarchive")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (!session.time.archived) return
    yield* bus.publish(SessionEvent.Unarchived, { sessionID })
  })
  const setMetadata = Effect.fn("Session.setMetadata")(function* (
    sessionID: SessionSchema.ID,
    input: { metadata: SessionSchema.Metadata },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.MetadataUpdated, { sessionID, metadata: input.metadata })
  })
  const setPermissions = Effect.fn("Session.setPermissions")(function* (
    sessionID: SessionSchema.ID,
    input: { permissions: Permission.Ruleset },
  ) {
    yield* get(sessionID)
    yield* bus.publish(SessionEvent.Permissions, { sessionID, permissions: input.permissions })
  })
  const switchAgent = Effect.fn("Session.switchAgent")(function* (
    sessionID: SessionSchema.ID,
    input: { agent: Agent.ID },
  ) {
    const session = yield* get(sessionID)
    // Without a stored agent the Session runs as its Location's default, which its last step records.
    const current =
      session.agent ?? (yield* store.lastAssistantAfter({ sessionID }).pipe(Effect.orElseSucceed(() => undefined)))?.agent
    if (current === input.agent) return
    yield* bus.publish(SessionEvent.AgentSelected, { sessionID, agent: input.agent, previous: session.agent })
  })
  const switchModel = Effect.fn("Session.switchModel")(function* (
    sessionID: SessionSchema.ID,
    input: { model: Model.Ref },
  ) {
    const session = yield* get(sessionID)
    if (
      session.model?.providerID === input.model.providerID &&
      session.model.id === input.model.id &&
      (session.model.variant ?? "default") === (input.model.variant ?? "default")
    )
      return
    yield* bus.publish(SessionEvent.ModelSelected, { sessionID, model: input.model, previous: session.model })
  })
  const mutatePending = (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
    mutation: (input: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
    }) => Effect.Effect<void, SessionInbox.LifecycleConflict>,
  ) =>
    mutation({ sessionID, id: inboxID }).pipe(
      Effect.catchTag("SessionInbox.LifecycleConflict", () =>
        Effect.gen(function* () {
          yield* get(sessionID)
          return yield* new InboxConflictError({ sessionID, inboxID })
        }),
      ),
    )

  const inbox = Effect.fn("Session.inbox")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    return yield* admission.list(sessionID)
  })
  const cancelInbox = Effect.fn("Session.cancelInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.cancel),
    Effect.uninterruptible,
  )
  const steerInbox = Effect.fn("Session.steerInbox")(function* (
    sessionID: SessionSchema.ID,
    inboxID: SessionMessage.ID,
  ) {
    yield* mutatePending(sessionID, inboxID, admission.steer)
    yield* execution.wake(sessionID)
  }, Effect.uninterruptible)
  const queueInbox = Effect.fn("Session.queueInbox")(
    (sessionID: SessionSchema.ID, inboxID: SessionMessage.ID) => mutatePending(sessionID, inboxID, admission.queue),
    Effect.uninterruptible,
  )
  const prompt = Effect.fn("Session.prompt")(
    (sessionID: SessionSchema.ID, input: PromptRequest, onAccepted?: Effect.Effect<void>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const session = yield* get(sessionID)
          const messageID = input.id ?? SessionMessage.ID.create()
          const admitted = yield* Effect.gen(function* () {
            const existing = yield* admission.reconcile({
              id: messageID,
              sessionID: session.id,
              type: "user",
              delivery: input.delivery ?? "steer",
            })
            if (existing) return existing
            // Preparation, the staged revert commit and admission share one acquisition of the session's location
            // services, so projections see its config whoever called prompt.
            return yield* Effect.gen(function* () {
              const item = yield* restore(SessionPrompt.prepare({ session, messageID, input }))
              // Commit a staged revert only after preparation succeeds, before admitting new work.
              if (session.revert) yield* SessionRevert.commit(bus, session)
              return yield* admission.admit({
                id: messageID,
                sessionID: session.id,
                item,
              })
            }).pipe(
              instances.provide(session),
              Effect.provideService(Database.Service, database),
              Effect.provideService(FSUtil.Service, fs),
            )
          }).pipe(
            Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID, messageID })),
          )
          if (input.resume !== false) yield* execution.wake(sessionID)
          // Checkpoint an accepted handoff before observing cancellation. Prompt preparation above stays interruptible.
          if (onAccepted) yield* onAccepted
          return admitted
        }),
      ),
  )
  const shell = Effect.fn("Session.shell")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; command: string },
  ) {
    const session = yield* get(sessionID)
    // The server owns completion recording even if the submitting client disconnects.
    const running = yield* Effect.gen(function* () {
      const started = yield* SessionShell.start({ session, command: input.command }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.tapError((error) =>
          synthetic(sessionID, {
            text: `User shell command failed to start:\n${input.command}\n\n${error.message}`,
            description: input.command,
            metadata: { source: "shell", state: "error" },
            resume: false,
          }),
        ),
        Effect.orDie,
      )
      yield* bus.publish(
        SessionEvent.Shell.Started,
        {
          sessionID,
          shell: started.info,
        },
        { id: input.id ? Event.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined },
      )
      const terminal = yield* started.result
      const preview = yield* started.output
      yield* bus.publish(SessionEvent.Shell.Ended, {
        sessionID,
        shell: terminal.info,
        output: preview,
      })
      yield* synthetic(sessionID, {
        ...ShellResult.userNotification(terminal),
        resume: false,
      }).pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.orDie,
      )
    }).pipe(Effect.forkIn(scope, { startImmediately: true }))
    yield* Fiber.join(running)
  })
  const skill = Effect.fn("Session.skill")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID?: SessionMessage.ID; skill: Skill.ID; resume?: boolean },
  ) {
    const session = yield* get(sessionID)
    const skill = yield* SessionSkill.get({ session, skill: input.skill }).pipe(
      Effect.provideService(Instance.Service, instances),
    )
    yield* bus.publish(
      SessionEvent.Skill.Activated,
      {
        sessionID,
        id: skill.id,
        name: skill.name,
        text: skill.content,
      },
      { id: input.messageID ? Event.ID.make(input.messageID.replace(/^msg_/, "evt_")) : undefined },
    )
    if (input.resume !== false)
      yield* execution
        .resume(sessionID)
        .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
  })
  const compact = Effect.fn("Session.compact")(function* (
    sessionID: SessionSchema.ID,
    input: { id?: SessionMessage.ID; delivery?: SessionInbox.Delivery },
  ) {
    const session = yield* get(sessionID)
    if (session.revert) yield* SessionRevert.commit(bus, session)
    const inputID = input.id ?? SessionMessage.ID.create()
    const admitted = yield* admission
      .admitCompaction({
        id: inputID,
        sessionID,
        delivery: input.delivery ?? "steer",
      })
      .pipe(
        Effect.catchTag("SessionInbox.LifecycleConflict", () => new CompactionConflictError({ sessionID, inputID })),
      )
    yield* execution.wake(sessionID)
    return admitted
  })
  // OWN-PATCH(P-035) begin
  /**
   * Admits a context reset. While the Session is idle it delivers at once, ahead of whatever input is still pending
   * (prompts parked by a stop, notices admitted without resuming): that input stays pending and starts the new context.
   * While a turn runs it waits for the turn (and input queued before it); its wake leaves parked queued prompts parked.
   * Either way it starts no model call of its own. Checking and delivering under the inbox lock keeps a starting drain
   * from loading history in between.
   */
  const reset = Effect.fn("Session.reset")(function* (sessionID: SessionSchema.ID, input: { id?: SessionMessage.ID }) {
    const session = yield* get(sessionID)
    const resetID = input.id ?? SessionMessage.ID.create()
    // A subagent's context belongs to the task its parent gave it.
    if (session.parentID) return yield* new ResetConflictError({ sessionID, resetID, reason: "subagent" })
    if (session.revert) yield* SessionRevert.commit(bus, session)
    const admitted = yield* admission
      .admitReset({ id: resetID, sessionID })
      .pipe(
        Effect.catchTag(
          "SessionInbox.LifecycleConflict",
          () => new ResetConflictError({ sessionID, resetID, reason: "id" }),
        ),
      )
    const delivered = yield* SessionInbox.serialized(
      sessionID,
      Effect.gen(function* () {
        if (yield* execution.isActive(sessionID)) return false
        if (!(yield* admission.list(sessionID)).some((item) => item.id === admitted.id)) return true
        yield* SessionInbox.deliverReset(database.db, bus, sessionID, admitted.id)
        return true
      }),
    )
    if (!delivered) yield* execution.wake(sessionID, "steer")
    return admitted
  }, Effect.uninterruptible)
  /**
   * Cancels a pending reset, or undoes a delivered one while it is the newest boundary (last in, first out): its marker
   * stays and history starts at the boundary before it again. Undo needs an idle Session without a staged revert;
   * checking and publishing under the inbox lock keeps a starting drain from loading history in between.
   */
  const undoReset = Effect.fn("Session.undoReset")(function* (sessionID: SessionSchema.ID, resetID: SessionMessage.ID) {
    yield* get(sessionID)
    const pending = (yield* admission.list(sessionID)).find((item) => item.id === resetID)
    // A cancel wakes nothing, also through the queue dock's `✕` (`cancelInbox`): the notices a pending reset holds
    // passive keep the `resume` they were admitted with. Named at admission (`notice`, no execution active), a wake its
    // caller asked for went to a drain that applies the reset first or, after this cancel, delivers it; one admitted
    // without a wake (or moved here by an undo, then admitted without one) waits for the next input, as without a reset.
    if (pending?.type === "reset") {
      const cancelled = yield* admission.cancel({ sessionID, id: resetID }).pipe(Effect.option)
      if (cancelled._tag === "Some") return
    }
    // The undo makes the notices the reset held passive ordinary (the projection releases them). Their wakes went to
    // drains that found them passive, so they wake the restored context as an ordinary notice would.
    const held = (yield* admission.list(sessionID)).flatMap((item) =>
      item.type === "synthetic" && item.payload.beforeReset === resetID ? [item.id] : [],
    )
    yield* SessionInbox.serialized(
      sessionID,
      Effect.gen(function* () {
        if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
        if ((yield* get(sessionID)).revert)
          return yield* new ResetConflictError({ sessionID, resetID, reason: "revert" })
        const row = yield* database.db
          .select()
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, resetID)))
          .get()
          .pipe(Effect.orDie)
        const marker = row ? yield* SessionHistory.decodeMessageRow(row).pipe(Effect.orDie) : undefined
        if (!row || marker?.type !== "compaction" || marker.status !== "completed" || marker.reason !== "reset")
          return yield* new MessageNotFoundError({ sessionID, messageID: resetID })
        if (marker.undone) return yield* new ResetConflictError({ sessionID, resetID, reason: "undone" })
        const newest = yield* SessionHistory.latestCompaction(database.db, sessionID, "latest")
        if (newest?.seq !== row.seq) return yield* new ResetConflictError({ sessionID, resetID, reason: "superseded" })
        yield* bus.publish(SessionEvent.Reset.Undone, { sessionID, messageID: resetID })
      }),
    )
    if (held.length === 0) return
    const released = (yield* admission.list(sessionID)).some(
      (item) => held.includes(item.id) && item.type === "synthetic" && item.payload.beforeReset === undefined,
    )
    if (released && !(yield* store.get(sessionID))?.revert) yield* execution.wake(sessionID)
  })
  // OWN-PATCH(P-035) end
  const wait = Effect.fn("Session.wait")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.awaitIdle(sessionID)
  })
  const resume = Effect.fn("Session.resume")(function* (sessionID: SessionSchema.ID) {
    yield* get(sessionID)
    yield* execution.resume(sessionID)
  })
  // OWN-PATCH(P-035) begin: background notices follow a context reset (SessionSynthetic `resets`)
  const admitSynthetic = SessionSynthetic.make(store, admission, execution.wake, {
    db: database.db,
    isActive: execution.isActive,
  })
  // OWN-PATCH(P-035) end
  const synthetic = (sessionID: SessionSchema.ID, input: Omit<Parameters<typeof admitSynthetic>[0], "sessionID">) =>
    admitSynthetic({ ...input, sessionID })
  const interrupt = Effect.fn("Session.interrupt")(
    (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) =>
      Effect.uninterruptible(execution.interrupt(sessionID, options)),
  )
  const stage = Effect.fn("Session.revert.stage")(function* (
    sessionID: SessionSchema.ID,
    input: { messageID: SessionMessage.ID; files?: boolean },
  ) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Database.Service, database),
      Effect.provideService(Bus.Service, bus),
    )
  })
  const clear = Effect.fn("Session.revert.clear")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    yield* SessionRevert.clear(session).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(Bus.Service, bus),
    )
    return yield* execution.wake(sessionID)
  })
  const commit = Effect.fn("Session.revert.commit")(function* (sessionID: SessionSchema.ID) {
    const session = yield* get(sessionID)
    if (yield* execution.isActive(sessionID)) return yield* new BusyError({ sessionID })
    return yield* SessionRevert.commit(bus, session)
  })
  const revert = { stage, clear, commit }
  const operations = {
    get,
    message,
    view,
    rename,
    archive,
    unarchive,
    setMetadata,
    setPermissions,
    switchAgent,
    switchModel,
    inbox,
    prompt,
    // OWN-PATCH(P-035) begin
    synthetic,
    // OWN-PATCH(P-035) end
    shell,
    skill,
    compact,
    // OWN-PATCH(P-035) begin
    reset,
    undoReset,
    // OWN-PATCH(P-035) end
    wait,
    resume,
    interrupt,
    cancelInbox,
    steerInbox,
    queueInbox,
    revert,
  }

  const forSession = (sessionID: SessionSchema.ID) => {
    const get = operations.get.bind(undefined, sessionID)
    const message = operations.message.bind(undefined, sessionID)
    const view = operations.view.bind(undefined, sessionID)
    const rename = operations.rename.bind(undefined, sessionID)
    const archive = operations.archive.bind(undefined, sessionID)
    const unarchive = operations.unarchive.bind(undefined, sessionID)
    const setMetadata = operations.setMetadata.bind(undefined, sessionID)
    const setPermissions = operations.setPermissions.bind(undefined, sessionID)
    const switchAgent = operations.switchAgent.bind(undefined, sessionID)
    const switchModel = operations.switchModel.bind(undefined, sessionID)
    const inbox = operations.inbox.bind(undefined, sessionID)
    const prompt = operations.prompt.bind(undefined, sessionID)
    const synthetic = operations.synthetic.bind(undefined, sessionID)
    const shell = operations.shell.bind(undefined, sessionID)
    const skill = operations.skill.bind(undefined, sessionID)
    const compact = operations.compact.bind(undefined, sessionID)
    // OWN-PATCH(P-035) begin
    const reset = operations.reset.bind(undefined, sessionID)
    const undoReset = operations.undoReset.bind(undefined, sessionID)
    // OWN-PATCH(P-035) end
    const wait = operations.wait.bind(undefined, sessionID)
    const resume = operations.resume.bind(undefined, sessionID)
    const interrupt = operations.interrupt.bind(undefined, sessionID)
    const cancelInbox = operations.cancelInbox.bind(undefined, sessionID)
    const steerInbox = operations.steerInbox.bind(undefined, sessionID)
    const queueInbox = operations.queueInbox.bind(undefined, sessionID)
    const stage = operations.revert.stage.bind(undefined, sessionID)
    const clear = operations.revert.clear.bind(undefined, sessionID)
    const commit = operations.revert.commit.bind(undefined, sessionID)
    const revert = { stage, clear, commit }

    return {
      id: sessionID,
      get,
      message,
      view,
      rename,
      archive,
      unarchive,
      setMetadata,
      setPermissions,
      switchAgent,
      switchModel,
      inbox,
      prompt,
      synthetic,
      shell,
      skill,
      compact,
      // OWN-PATCH(P-035) begin
      reset,
      undoReset,
      // OWN-PATCH(P-035) end
      wait,
      resume,
      interrupt,
      cancelInbox,
      steerInbox,
      queueInbox,
      revert,
    }
  }
  return { forSession }
})

export type Handle = ReturnType<Effect.Success<ReturnType<typeof make>>["forSession"]>

// Mirrors the shell tool's in-memory preview safety limit.
