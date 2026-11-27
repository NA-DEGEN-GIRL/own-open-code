export * as LimitResetRpc from "./limit-reset.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: TELEMETRY agent. ChatGPT usage-limit reset credits (02 §7.1.1 리셋권): read for the dialog, and redeemed in
 * two steps after the user confirms there. The control Location (the runtime leader) runs them; a remote service
 * answers `remote_managed` (`Register.REMOTE_MANAGED`), so an SSH host never redeems.
 */
export type Methods = "quota.resetCredits.list" | "quota.resetCredits.redeem.plan" | "quota.resetCredits.redeem.execute"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "quota.resetCredits.list": (input, context) => modules.telemetry.resetCreditsList(input, context),
    "quota.resetCredits.redeem.plan": (input, context) => modules.telemetry.resetCreditsPlan(input, context),
    "quota.resetCredits.redeem.execute": (input, context) => modules.telemetry.resetCreditsExecute(input, context),
  }
}
