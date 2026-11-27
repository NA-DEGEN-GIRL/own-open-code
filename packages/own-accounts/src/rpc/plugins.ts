export * as PluginsRpc from "./plugins.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: PLUGINS agent. `plugin.claudeAuth.importSubscription` is in `logins.ts` (CREDENTIALS agent). */
export type Methods =
  | "plugin.claudeAuth.status"
  | "plugin.claudeAuth.ack"
  | "plugin.claudeAuth.remote.ack"
  | "plugin.claudeAuth.remote.set"
  | "plugin.claudeAuth.fastAck"
  | "plugin.claudeAuth.install.plan"
  | "plugin.claudeAuth.install.execute"
  | "plugin.claudeAuth.uninstall.plan"
  | "plugin.claudeAuth.uninstall.execute"
  | "plugin.claudeAuth.changeSource.plan"
  | "plugin.claudeAuth.changeSource.execute"
  | "plugin.trust.list"
  | "plugin.trust.approve.plan"
  | "plugin.trust.approve.execute"
  | "plugin.trust.revoke"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "plugin.claudeAuth.status": (input, context) => modules.plugins.claudeAuthStatus(input, context),
    "plugin.claudeAuth.ack": (input, context) => modules.plugins.claudeAuthAck(input, context),
    "plugin.claudeAuth.remote.ack": (input, context) => modules.plugins.claudeRemoteAck(input, context),
    "plugin.claudeAuth.remote.set": (input, context) => modules.plugins.claudeRemoteSet(input, context),
    "plugin.claudeAuth.fastAck": (input, context) => modules.plugins.claudeFastAck(input, context),
    "plugin.claudeAuth.install.plan": builtIn<"plugin.claudeAuth.install.plan">(),
    "plugin.claudeAuth.install.execute": builtIn<"plugin.claudeAuth.install.execute">(),
    "plugin.claudeAuth.uninstall.plan": builtIn<"plugin.claudeAuth.uninstall.plan">(),
    "plugin.claudeAuth.uninstall.execute": builtIn<"plugin.claudeAuth.uninstall.execute">(),
    "plugin.claudeAuth.changeSource.plan": (input, context) => modules.plugins.changeSourcePlan(input, context),
    "plugin.claudeAuth.changeSource.execute": (input, context) => modules.plugins.changeSourceExecute(input, context),
    "plugin.trust.list": (input, context) => modules.plugins.trustList(input, context),
    "plugin.trust.approve.plan": (input, context) => modules.plugins.trustApprovePlan(input, context),
    "plugin.trust.approve.execute": (input, context) => modules.plugins.trustApproveExecute(input, context),
    "plugin.trust.revoke": (input, context) => modules.plugins.trustRevoke(input, context),
  }
}

/**
 * The Claude plugin's install, uninstall and patch jobs of services before 2026-10-18: the plugin now ships inside the
 * app, patched at build time and always on (02 §8.2), so an older client's call is refused with a declared error.
 */
export function builtIn<N extends RpcTypes.MethodName>(): RpcTypes.Handler<N> {
  const refuse = async (_input: unknown, context: RpcTypes.Context<N>) => {
    // SAFETY: every own.accounts method declares `internal_error` with empty data (`OwnError.pick` adds it).
    const fail = context.error as unknown as (type: string, message: string, data: object) => unknown
    return fail("internal_error", "built_in: the Claude plugin ships with the app and is always on", {})
  }
  // SAFETY: `refuse` takes the parameters of the method's handler and returns a declared error.
  return refuse as unknown as RpcTypes.Handler<N>
}
