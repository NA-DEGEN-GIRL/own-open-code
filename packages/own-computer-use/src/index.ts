import { Plugin } from "@opencode/plugin/effect"
import { SessionMessage } from "@opencode/schema/session-message"
import type { OwnComputer } from "@own/protocol/rpc-computer"
import { Effect, Result, Stream } from "effect"
import { Agents } from "./agents.js"
import { Build } from "./build.js"
import { Keys } from "./core/keys.js"
import { Hooks } from "./hooks.js"
import { Options } from "./options.js"
import { ComputerRpc } from "./rpc.js"
import { Desktop } from "./singleton.js"
import { Tools } from "./tools.js"

/**
 * own.computer-use (01 §10.2, ARCHITECTURE.md): Windows desktop control as ordinary plugin tools in the `computer`
 * namespace. Consent is layered: an agent-wide `computer` deny keeps the tools out of every catalog, config-defined
 * agents included (`Agents`, registered again after each activation); own-accounts'
 * `session.approval.set{computerUse:"on"}` adds the session allow that lists them, and the gate re-checks that session
 * rule on every call, refuses subagents off the root's main model and turns that own.team started. Loading the plugin
 * is cheap: the driver's worker threads start on the first computer action.
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const decoded = Options.decodeResult(ctx.options)
      const options = Result.getOrUndefined(decoded)
      const blocked =
        options === undefined
          ? undefined
          : Result.getOrUndefined(Keys.blockList([...Keys.DEFAULT_BLOCKED, ...options.policy.blockedChords]))
      const build = { buildId: options?.buildId ?? Build.BUILD_ID, version: Build.PLUGIN_VERSION }
      const reason = unavailable(ctx.app.version, options, blocked)
      if (options === undefined || blocked === undefined || reason !== undefined) {
        warn("guard_failed", { reason, appVersion: ctx.app.version })
        return yield* ComputerRpc.registerUnavailable(ctx, {
          available: false,
          reason: reason ?? "invalid_options",
          ...build,
        })
      }
      const desktop = yield* Desktop.acquire({ buildId: build.buildId, options })
      yield* Agents.register(ctx)
      yield* Tools.register(ctx, {
        codemode: options.codemode,
        deps: {
          desktop,
          blocked,
          session: (sessionID) =>
            ctx.session.get({ sessionID }).pipe(
              Effect.map((info) => ({ parentID: info.parentID, permissions: info.permissions, model: info.model })),
              Effect.orElseSucceed(() => undefined),
            ),
          history: (sessionID) => ctx.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => undefined)),
          earlier: (input) =>
            ctx.session
              .messages({
                sessionID: input.sessionID,
                order: "desc",
                cursor: { id: SessionMessage.ID.make(input.before), direction: "next" },
                limit: input.limit,
              })
              .pipe(Effect.orElseSucceed(() => undefined)),
          images: (model) =>
            ctx.model.list().pipe(
              Effect.map((list) => {
                const info = list.data.find((item) => item.providerID === model.providerID && item.id === model.id)
                return info?.capabilities.input.some((item) => item.startsWith("image"))
              }),
              Effect.orElseSucceed(() => undefined),
            ),
        },
      })
      const hooks = yield* Hooks.register(ctx, options.history)
      yield* ComputerRpc.register(ctx, desktop, build)
      yield* ctx.event.subscribe().pipe(
        Stream.runForEach((event) => {
          if (event.type === "session.deleted")
            return Desktop.forget(desktop, event.data.sessionID).pipe(
              Effect.andThen(hooks.forget(event.data.sessionID)),
            )
          // A run that ended (done, failed or stopped) lets go of a button it left down and of the desktop lease, so
          // the user's mouse is free and another session need not wait out `leaseIdleSeconds`.
          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          )
            return Desktop.settle(desktop, event.data.sessionID)
          return Effect.void
        }),
        Effect.forkScoped({ startImmediately: true }),
      )
    }),
})

/** Guard 1 (01 §5.4) plus this plugin's own conditions. */
function unavailable(
  appVersion: string,
  options: Options.Info | undefined,
  blocked: ReadonlyArray<Keys.Chord> | undefined,
): OwnComputer.Unavailable | undefined {
  if (process.env[Build.ENV_MARKER] !== "1") return "unmanaged"
  if (appVersion !== Build.EXPECTED_APP_VERSION) return "skew"
  if (options === undefined || blocked === undefined) return "invalid_options"
  if (options.driver !== "fake" && process.platform !== "win32") return "unsupported"
  return undefined
}

function warn(message: string, fields: Readonly<Record<string, unknown>>) {
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), level: "warn", scope: Build.PLUGIN_ID, msg: message, ...fields })}\n`,
  )
}
