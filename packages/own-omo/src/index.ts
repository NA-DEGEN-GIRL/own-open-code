import { Plugin } from "@opencode/plugin/effect"
import { SessionID } from "@opencode/schema/session-id"
import { Effect, Result, Stream } from "effect"
import { Build } from "./build.js"
import { V1Events } from "./host/events.js"
import { Bridge } from "./host/hooks.js"
import { Overlays } from "./host/overlay.js"
import { OmoSessions } from "./host/session.js"
import { Todos } from "./host/todo.js"
import type { V1Event } from "./omo-runtime.js"
import { Options } from "./options.js"
import { Runtime } from "./runtime.js"

/**
 * own.omo (15): oh-my-opencode on OpenCode 2. The vendored omo (own/vendor/oh-my-opencode, SUL-1.0, patched at build)
 * runs as the OpenCode 1 plugin it is, through a host that gives it an OpenCode 1 client, OpenCode 1 events and its
 * OpenCode 1 hooks on OpenCode 2's, in sessions bound to the `omo` harness only. Everything else (other harnesses'
 * sessions, other Locations' sessions) sees nothing of it: its tools carry own-harness's `own_harness_omo` gate, its
 * agents are hidden, and every hook and event returns early outside omo sessions. `enabled: false` turns it off.
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = Result.getOrUndefined(Options.decodeResult(ctx.options))
      if (
        options === undefined ||
        process.env[Build.ENV_MARKER] !== "1" ||
        ctx.app.version !== Build.EXPECTED_APP_VERSION
      ) {
        // The bundle names its build like the other own plugins (01 §4), so a release bundle carries its build id.
        warn("guard_failed", { appVersion: ctx.app.version, buildId: Build.BUILD_ID, options: options !== undefined })
        return
      }
      if (!options.enabled) return
      const scope = yield* Effect.scope
      const state = new V1Events.State()
      const sessions = new OmoSessions.Cache(ctx)
      const overlays = new Overlays.Store(ctx)
      const todos = new Todos.Store(ctx)
      // OpenCode 1 delivered events to a plugin one at a time; per session, the pump keeps that order.
      const chains = new Map<string, Promise<void>>()
      const deliver = (sessionID: string, events: ReadonlyArray<V1Event>) => {
        if (events.length === 0) return
        const hook = host.current()?.hooks.event
        if (hook === undefined) return
        const next = (chains.get(sessionID) ?? Promise.resolve()).then(async () => {
          for (const event of events)
            await hook({ event }).catch((error: unknown) => warn("event_hook_failed", { type: event.type, error: String(error) }))
        })
        chains.set(sessionID, next)
        void next.finally(() => {
          if (chains.get(sessionID) === next) chains.delete(sessionID)
        })
      }
      const host: Runtime.Host = new Runtime.Host(ctx, options, { state, overlays, todos, sessions, scope, deliver })
      const busy = new OmoSessions.Busy(ctx)
      // Marks an omo session running from its execution's start to its end; a shutdown keeps the mark (15 §3.2).
      const running = (event: V1Events.V2Event, sessionID: string) => {
        if (event.type === "session.execution.started") return busy.mark(sessionID)
        if (
          event.type === "session.execution.succeeded" ||
          event.type === "session.execution.failed" ||
          (event.type === "session.execution.interrupted" && event.data.reason !== "shutdown") ||
          event.type === "session.deleted"
        )
          return busy.clear(sessionID)
        return Effect.void
      }
      // The agent and model a delivered message names, as the session has them now.
      const selection = (sessionID: string) =>
        Effect.runPromise(
          ctx.session.get({ sessionID: SessionID.make(sessionID) }).pipe(
            Effect.map((info) => ({
              ...(info.agent === undefined ? {} : { agent: info.agent }),
              ...(info.model === undefined ? {} : { model: info.model }),
            })),
            Effect.orElseSucceed(() => ({})),
          ),
        )
      // The marks the last run left, taken before the pump can mark a resumed run anew.
      const resumed = yield* busy.take().pipe(
        Effect.flatMap((ids) =>
          Effect.promise(() => Promise.all(ids.map((id) => sessions.isOmo(id).then((omo) => (omo ? [id] : []))))),
        ),
        Effect.map((ids) => ids.flat()),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => host.dispose().catch((error: unknown) => warn("dispose_failed", { error: String(error) }))),
      )
      yield* Bridge.register(ctx, { host, sessions, overlays, warn })
      // The todo tool needs no runtime, so it is registered now: own.harness offers `omo` where tools carry omo's gate.
      yield* ctx.tool.transform((editor) =>
        editor.add(
          Todos.tool(todos, (sessionID, list) => Effect.sync(() => deliver(sessionID, [Runtime.todoUpdated(sessionID, list)])), Runtime.GATE),
        ),
      )
      yield* ctx.event.subscribe().pipe(
        Stream.runForEach((event) =>
          Effect.promise(async () => {
            if (event.type === "session.metadata.updated") {
              sessions.forget(event.data.sessionID)
              // A session bound to omo now starts this Location's omo, so its first request has omo's tools.
              if (await sessions.isOmo(event.data.sessionID)) void host.ensure().catch(() => undefined)
              return
            }
            const sessionID = V1Events.sessionOf(event)
            if (sessionID === undefined) return
            // own.team runs this session from now on (an owner it adopted carries no `own.team` metadata, 15 §3.10).
            if (event.type === "session.inbox.enqueued" && OmoSessions.fromTeam(event.data.item)) sessions.join(sessionID)
            if (!(await sessions.isOmo(sessionID))) {
              if (event.type === "session.deleted") sessions.drop(sessionID)
              return
            }
            if (event.type === "session.created") await host.ensure().catch(() => undefined)
            await Effect.runPromise(running(event, sessionID))
            const events = V1Events.project(event, state, {
              agents: host.current()?.agents ?? { toV1: (agent) => agent, toV2: (agent) => agent },
              directory: ctx.location.directory,
              now: Date.now(),
              ...(event.type === "session.inbox.delivered" && state.pending(sessionID, event.data.inboxID)
                ? { session: await selection(sessionID) }
                : {}),
            })
            deliver(sessionID, events)
            if (event.type === "session.deleted") {
              sessions.drop(sessionID)
              await Effect.runPromise(Effect.all([overlays.forget(sessionID), todos.forget(sessionID)], { discard: true }))
            }
          }).pipe(Effect.catchCause((cause) => Effect.sync(() => warn("event_failed", { cause: String(cause) })))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Restart recovery resumes a run with the tools registered when its drain starts, before any hook of ours runs.
      // Every drain waits for the plugins' activation, so omo starts here when an omo session of this Location was
      // still running when the service stopped (15 §3.2).
      if (resumed.length > 0)
        yield* Effect.promise(() =>
          host.ensure().then(
            () => undefined,
            (error: unknown) => warn("resume_start_failed", { sessions: resumed, error: String(error) }),
          ),
        )
    }),
})

function warn(message: string, fields: Readonly<Record<string, unknown>>) {
  process.stderr.write(`${JSON.stringify({ ts: Date.now(), level: "warn", scope: Build.PLUGIN_ID, msg: message, ...fields })}\n`)
}
