// The pure part of the reset credit surfaces (03 §7.1.1 리셋권): what the line shows, the dialog's options, whether
// every plan window is still below its limit, and the result's words. No signals, no RPC; the unit tests cover it.
import type { Limit } from "@own/protocol"
import type { ResetCreditKey } from "./reset-credits-strings"

/** What the card's line shows: the count, `리셋권 없음` (unfolded only), `리셋권 확인` (unfolded only) or nothing. */
export type LineState = "count" | "none" | "check" | "hidden"

export function lineState(credits: Limit.ResetCredits | undefined, expanded: boolean): LineState {
  if (credits && credits.availableCount > 0) return "count"
  if (!expanded) return "hidden"
  return credits ? "none" : "check"
}

/** The credits that can be used, soonest expiry first and never-expiring ones last (codex-rs `reset_credit_options`). */
export function usable(credits: Limit.ResetCredits | undefined): Limit.ResetCredit[] {
  return (credits?.credits ?? [])
    .filter((credit) => credit.status === "available")
    .toSorted((a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY))
}

/** When the soonest credit expires, once the dialog listed them. */
export function soonest(credits: Limit.ResetCredits | undefined) {
  return usable(credits)[0]?.expiresAt
}

export interface CreditOption {
  /** Absent: ChatGPT picks one (no list known). */
  readonly creditID?: string
  readonly title?: string
  readonly description?: string
  readonly expiresAt?: number
}

/**
 * The dialog's choices: the listed credits, at most as many as the count; without a list (the count only) one choice
 * that lets ChatGPT pick, as Codex does. No choice when the count is 0.
 */
export function options(credits: Limit.ResetCredits): CreditOption[] {
  if (credits.availableCount <= 0) return []
  const listed = usable(credits)
    .slice(0, credits.availableCount)
    .map((credit) => ({
      creditID: credit.id,
      ...(credit.title === undefined ? {} : { title: credit.title }),
      ...(credit.description === undefined ? {} : { description: credit.description }),
      ...(credit.expiresAt === undefined ? {} : { expiresAt: credit.expiresAt }),
    }))
  return listed.length > 0 ? listed : [{}]
}

/**
 * What a choice says of its expiry: when it ends, `never` (a listed credit without one), or `unknown` when ChatGPT
 * picks the credit (the count only, no list): which one it takes, and so its expiry, is not known.
 */
export function expiryOf(option: CreditOption, expiresAt = option.expiresAt): number | "never" | "unknown" {
  if (option.creditID === undefined) return "unknown"
  return expiresAt ?? "never"
}

/** The ChatGPT plan windows a reset refills (`codex.*` rolling windows; not the paid credits). */
export function planWindows(windows: readonly Limit.Window[]) {
  return windows.filter((window) => window.id.startsWith("codex.") && window.kind === "rolling_quota")
}

/** Every observed plan window is below its limit: the confirmation asks once more. Unknown (none observed) is no. */
export function belowLimit(windows: readonly Limit.Window[]) {
  const plan = planWindows(windows)
  return plan.length > 0 && plan.every((window) => window.status !== "exhausted" && (window.usedPercent ?? 0) < 100)
}

/** A plan window is used up: the conversation's banner may offer a credit. */
export function reached(windows: readonly Limit.Window[] | undefined) {
  return planWindows(windows ?? []).some((window) => window.status === "exhausted" || (window.usedPercent ?? 0) >= 100)
}

export type Outcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"

/** The result's words: a picked credit that is gone asks for a refresh, `no_credit` without a pick says none is left. */
export function outcomeKey(outcome: Outcome, picked: boolean, counted: boolean): ResetCreditKey {
  if (outcome === "nothing_to_reset") return "own.rc.nothingToReset"
  if (outcome === "no_credit") return picked ? "own.rc.creditGone" : "own.rc.noCredit"
  return counted ? "own.rc.done" : "own.rc.doneNoCount"
}

/** A login not usable as it is (`credential_not_ready{cause}`): what is wrong with it and what fixes it. */
export function loginKey(cause: string | undefined): ResetCreditKey {
  if (cause === "expiring") return "own.rc.loginExpiring"
  if (cause === "needs_reauth") return "own.rc.loginReauth"
  if (cause === "missing") return "own.rc.loginMissing"
  if (cause === "source_stale") return "own.rc.loginStale"
  return "own.rc.loginNotReady"
}

/**
 * Why a redeem got no outcome (`limit_reset_failed{status?}`), and whether `다시 시도` sends it again. ChatGPT refusing
 * the login (401) is not retried: the same login would be refused again, so the words say to sign in again.
 */
export function failure(status: number | undefined): { readonly key: ResetCreditKey; readonly retry: boolean } {
  if (status === undefined) return { key: "own.rc.failedNote", retry: true }
  if (status === 401) return { key: "own.rc.failedLogin", retry: false }
  return { key: "own.rc.failedStatus", retry: true }
}

/**
 * A `redeem.execute` the service refused before it sent anything, and what to say: the account was removed
 * (`account_not_found`, checked before the send), the service is an SSH host's (`remote_managed`), or this device may
 * not redeem (`own.scope_denied`). The credit is certainly unused, so the words say so rather than "unknown".
 */
export function notSentKey(type: string | undefined): ResetCreditKey | undefined {
  if (type === "account_not_found") return "own.rc.notSentAccount"
  if (type === "remote_managed") return "own.rc.notSentRemote"
  if (type === "own.scope_denied") return "own.rc.notSentScope"
  return undefined
}

/**
 * Whether a failed `redeem.execute` leaves it unknown if the credit was used. ChatGPT's missing or error answer
 * (`limit_reset_failed`) keeps the request for a retry, and a plan too old, a login not usable or a refusal of
 * {@link notSentKey} sent nothing. Any other failure (the answer lost on its way to this window) may follow a redeem
 * that went through.
 */
export function outcomeUnknown(type: string | undefined) {
  return (
    type !== "limit_reset_failed" &&
    type !== "nonce_invalid" &&
    type !== "credential_not_ready" &&
    notSentKey(type) === undefined
  )
}

const dates = new Map<string, Intl.DateTimeFormat>()

/** `11월 3일` (`Nov 3`): the date part of an expiry; the caller adds the clock (./format `clock`). */
export function day(locale: string, at: number) {
  const format = dates.get(locale) ?? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
  dates.set(locale, format)
  return format.format(new Date(at))
}
