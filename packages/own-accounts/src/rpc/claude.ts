export * as ClaudeRpc from "./claude.js"

import type { Deps } from "../deps.js"
import type { Modules } from "../modules.js"
import { builtIn } from "./plugins.js"
import type { RpcTypes } from "./types.js"

/** Owner: CLAUDE ACCOUNTS (02 §8.7); the retired patch job (the plugin is patched at build time, 02 §8.2). */
export type Methods =
  | "plugin.claudeAuth.patch.plan"
  | "plugin.claudeAuth.patch.execute"
  | "plugin.claudeAuth.accounts.add.plan"
  | "plugin.claudeAuth.accounts.add.execute"
  | "plugin.claudeAuth.accounts.add.status"
  | "plugin.claudeAuth.accounts.detect"
  | "plugin.claudeAuth.accounts.remove.plan"
  | "plugin.claudeAuth.accounts.remove.execute"
  | "plugin.claudeAuth.session.get"
  | "plugin.claudeAuth.session.set"
  | "plugin.claudeAuth.default.set"

export function handlers(modules: Modules.All, deps: Deps): RpcTypes.Group<Methods> {
  const log = deps.log.child("claude-rpc")
  return {
    "plugin.claudeAuth.patch.plan": builtIn<"plugin.claudeAuth.patch.plan">(),
    "plugin.claudeAuth.patch.execute": builtIn<"plugin.claudeAuth.patch.execute">(),
    "plugin.claudeAuth.accounts.add.plan": guard(log, "plugin.claudeAuth.accounts.add.plan", modules.claude.addPlan),
    "plugin.claudeAuth.accounts.add.execute": guard(
      log,
      "plugin.claudeAuth.accounts.add.execute",
      modules.claude.addExecute,
    ),
    "plugin.claudeAuth.accounts.add.status": guard(
      log,
      "plugin.claudeAuth.accounts.add.status",
      modules.claude.addStatus,
    ),
    "plugin.claudeAuth.accounts.detect": guard(log, "plugin.claudeAuth.accounts.detect", modules.claude.detect),
    "plugin.claudeAuth.accounts.remove.plan": guard(
      log,
      "plugin.claudeAuth.accounts.remove.plan",
      modules.claude.removePlan,
    ),
    "plugin.claudeAuth.accounts.remove.execute": guard(
      log,
      "plugin.claudeAuth.accounts.remove.execute",
      modules.claude.removeExecute,
    ),
    "plugin.claudeAuth.session.get": guard(log, "plugin.claudeAuth.session.get", modules.claude.sessionGet),
    "plugin.claudeAuth.session.set": guard(log, "plugin.claudeAuth.session.set", modules.claude.sessionSet),
    "plugin.claudeAuth.default.set": guard(log, "plugin.claudeAuth.default.set", modules.claude.defaultSet),
  }
}

/**
 * Handlers never throw (02 §9.4): an unexpected exception is logged (redacted) and answered as `internal_error`, a
 * declared 400 instead of the host's 500 `rpc.internal`.
 */
function guard<N extends RpcTypes.MethodName>(
  log: Deps["log"],
  method: N,
  handler: RpcTypes.Handler<N>,
): RpcTypes.Handler<N> {
  const run = handler as unknown as (input: unknown, context: RpcTypes.Context<N>) => Promise<unknown>
  const guarded = (input: unknown, context: RpcTypes.Context<N>) =>
    run(input, context).catch((error: unknown) => {
      log.error("handler_failed", { method, error })
      // SAFETY: every own.accounts method declares `internal_error` with empty data (`OwnError.pick` adds it).
      const fail = context.error as unknown as (type: string, message: string, data: object) => unknown
      return fail("internal_error", "unexpected", {})
    })
  // SAFETY: `guarded` takes the parameters of `handler` and returns its result or a declared error.
  return guarded as unknown as RpcTypes.Handler<N>
}
