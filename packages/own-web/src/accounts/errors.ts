// Declared `own.accounts` errors (02 §9.4) and client-side `own.*` errors as short sentences for the screens.
import { OwnRpcError } from "@/data"
import type { I18n } from "@/i18n"
import { isSharingCode, USAGE_LIMIT_CODE } from "./chatgpt-plan"

export function errorType(error: unknown) {
  return error instanceof OwnRpcError ? error.type : undefined
}

export function errorData<T>(error: unknown): Partial<T> {
  if (!(error instanceof OwnRpcError) || typeof error.data !== "object" || error.data === null) return {}
  return error.data as Partial<T>
}

export function errorMessage(i18n: I18n, error: unknown, labelOf?: (accountID: string) => string | undefined) {
  const type = errorType(error)
  if (type === "own.scope_denied") return i18n.t("own.acct.err.scope")
  if (type === "vault_unavailable") return i18n.t("own.acct.err.vault")
  if (type === "template_unavailable") return i18n.t("own.acct.err.template")
  if (type === "nonce_invalid") return i18n.t("own.acct.err.nonce")
  if (type === "account_not_found") return i18n.t("own.acct.err.notFound")
  if (type === "policy_denied") return i18n.t("own.acct.err.policy")
  if (type === "needs_reauth") return i18n.t("own.acct.err.reauth")
  if (type === "plugin_not_installed") return i18n.t("own.acct.err.pluginMissing")
  if (type === "ack_required") return i18n.t("own.acct.err.ack")
  if (type === "session_busy") return i18n.t("own.acct.err.busy")
  if (type === "duplicate_account") {
    const id = errorData<{ accountID: string }>(error).accountID
    return i18n.t("own.acct.err.duplicate", { account: (id && labelOf?.(id)) || id || "—" })
  }
  if (type === "legacy_key_not_found") return i18n.t("own.acct.err.legacyNotFound")
  if (type === "legacy_key_invalid") {
    const reason = errorData<{ reason: string }>(error).reason
    return i18n.t("own.acct.err.legacyInvalid", { reason: reason ?? "—" })
  }
  if (type === "probe_failed") {
    const data = errorData<{ status: number; message: string }>(error)
    // Sign in with ChatGPT names its refusal (eligibility, policy, region, usage); a "key rejected" line would misread it.
    if (data.message === USAGE_LIMIT_CODE) return i18n.t("own.chatgpt.usageLimit")
    if (isSharingCode(data.message)) return i18n.t("own.acct.err.probe", { reason: data.message })
    if (data.status !== undefined) return i18n.t("own.accounts.testFail", { status: data.status })
    return i18n.t("own.acct.err.probe", { reason: data.message ?? "—" })
  }
  if (type === "setting_out_of_range") {
    const data = errorData<{ min: number | null; max: number | null }>(error)
    return i18n.t("own.compact.outOfRange", { min: data.min ?? "—", max: data.max ?? "—" })
  }
  return i18n.t("own.lim.failed", { reason: error instanceof Error ? error.message : String(error) })
}
