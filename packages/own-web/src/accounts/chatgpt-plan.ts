// Sign in with ChatGPT presentation rules (03 §5.4 "ChatGPT 로그인", 02 §3.2c): which login methods the dialog offers,
// the login errors with their own notice, the "사용량 관리" page, the usage-limit code and the one-time "connected"
// notice. Pure apart from the notice flag, whose storage is passed in by tests.
import type { Kind, OwnAccounts } from "@own/protocol"
import type { I18nKey } from "@/i18n"

/** ChatGPT Settings → Usage: plan use, the per-app weekly limit and credits per app are managed there. */
export const USAGE_URL = "https://chatgpt.com/settings/usage"

/**
 * The token-sharing usage limit as the router names it in `account.status{reason}` (02 §3.2c). Matched by code, never
 * by message text (OpenAI already changed that text once). No reset time is promised (an app-specific cap may apply)
 * unless the 429 named one, which the router keeps as the account's `siwc.usage` window.
 */
export const USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded"

/** A token-sharing error code, which the router passes on as a failed probe's message (02 §3.2c `accounts.test`). */
export function isSharingCode(value: string | undefined): value is string {
  return value !== undefined && /^(subscription_sharing|chatpass)_[a-z0-9_]+$/.test(value)
}

/** A re-login keeps its account's kind (the router refuses a cross-kind target); a new login offers all three. */
export function loginMethods(kind: Kind.Any | undefined): readonly OwnAccounts.LoginMethod[] {
  if (kind === "siwc") return ["siwc"]
  if (kind === "codex") return ["device", "browser"]
  return ["device", "browser", "siwc"]
}

/** `accounts.add.chatgpt.status` errors with their own notice; others show the generic failure. */
export const LOGIN_ERRORS: Readonly<Record<string, I18nKey>> = {
  token_sharing_not_granted: "own.chatgpt.err.sharingDenied",
  authorization_denied: "own.chatgpt.err.denied",
  client_mismatch: "own.chatgpt.err.clientMismatch",
  client_id_missing: "own.chatgpt.err.clientMissing",
  client_id_invalid: "own.chatgpt.err.clientMissing",
  id_token_invalid: "own.chatgpt.err.idToken",
  id_token_missing: "own.chatgpt.err.idToken",
  jwks_unavailable: "own.chatgpt.err.jwks",
  identity_missing: "own.chatgpt.err.identity",
}

/** `accounts.add.chatgpt.start` refusals: an `internal_error` whose message is the reason. */
export const START_ERRORS: Readonly<Record<string, I18nKey>> = {
  callback_ports_in_use: "own.chatgpt.err.ports",
  host_id_unavailable: "own.chatgpt.err.hostId",
  client_id_missing: "own.chatgpt.err.noSavedClient",
}

/**
 * A Sign in with ChatGPT attempt that ended without plan use (the sharing scope was not granted, or the user declined)
 * offers "동의 후 다시 시도": the same flow with `consent:true`. Only on this explicit action, never by default.
 */
export function offersConsent(method: OwnAccounts.LoginMethod | undefined, error: string | undefined) {
  return method === "siwc" && (error === "token_sharing_not_granted" || error === "authorization_denied")
}

const WELCOME_KEY = "own.web.chatgpt.planWelcome.v1"

/**
 * True the first time a new Sign in with ChatGPT account is added in this browser ("ChatGPT 요금제로 연결됨" shows
 * once), false afterwards. A blocked storage cannot remember, so the notice shows.
 */
export function firstPlanLogin(storage?: Pick<Storage, "getItem" | "setItem">) {
  try {
    const store = storage ?? localStorage
    if (store.getItem(WELCOME_KEY) !== null) return false
    store.setItem(WELCOME_KEY, "1")
  } catch {}
  return true
}
