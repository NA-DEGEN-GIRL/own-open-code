import { Plugin } from "@opencode/plugin/effect"
import { Effect, Result } from "effect"
import { Build } from "./build.js"
import { Options } from "./options.js"
import { ImportRpc } from "./rpc.js"
import { Singleton } from "./singleton.js"

/**
 * own.import (09, ARCHITECTURE.md): finds Codex and Claude Code conversations of a project on this PC, shows them read
 * only and moves them into own sessions. It never writes, moves, deletes or locks another tool's files (IM-D2).
 * Loading does no I/O (PF1/PF6): the plugin decodes its options, checks the own guard, joins the build's process
 * singleton and registers `own.import` at this Location (`rpc.ts`). Every instance serves the same singleton state;
 * the Worker that scans and reads starts on the first `sources.list` or `sessions.list`. The control Location's
 * instance also starts the one activation cleanup of hidden helper sessions in the background (09 §4.4). A failed
 * guard registers nothing.
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = Result.getOrUndefined(Options.decodeResult(ctx.options))
      const reason = unavailable(ctx.app.version, options)
      if (options === undefined || reason !== undefined) {
        ImportRpc.warn("guard_failed", { reason: reason ?? "invalid_options", appVersion: ctx.app.version })
        return
      }
      const shared = yield* Singleton.acquire({ buildId: options.buildId ?? Build.BUILD_ID, options })
      const control = yield* ImportRpc.register(ctx, shared)
      // 09 §4.4: once per process, after the control Location activated, the helpers a restart left go. In the
      // background, so activation never waits for the service (and ends it with this instance).
      if (control) yield* Effect.forkScoped(ImportRpc.cleanup(shared))
    }),
})

export type Unavailable = "unmanaged" | "skew" | "invalid_options"

/** Guard 1 (01 §5.4) plus valid options. */
function unavailable(appVersion: string, options: Options.Info | undefined): Unavailable | undefined {
  if (process.env[Build.ENV_MARKER] !== "1") return "unmanaged"
  if (appVersion !== Build.EXPECTED_APP_VERSION) return "skew"
  if (options === undefined) return "invalid_options"
  return undefined
}
