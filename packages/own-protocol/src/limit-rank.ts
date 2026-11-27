export * as LimitRank from "./limit-rank.js"

import type { Confidence, Status, Window, WindowKind } from "./limit.js"
import { lapsed, limits } from "./limit-model.js"

/**
 * The one ranking of an account's limit windows (03 §7.2, LV 2026-10-24), tightest first, for both sides: own-web leads
 * every surface with its first window (the sidebar and composer glance, the switcher row, the cards, the 계정·한도 tab,
 * the dashboard, the ultra line, the team view) and own-accounts names the account's state with it
 * (`accounts.list` `limitsSummary.worst`: the card's state). No runtime imports beyond `LimitModel`, so own-web's
 * first chunk reads it.
 *
 * Candidates are the windows that limit `model` (`LimitModel.limits`: account-wide windows, and a model weekly bucket
 * only when `model` is of its family; without a model account-wide windows only), never a lapsed bucket
 * (`LimitModel.lapsed`) nor Claude's extra usage ({@link extra}), and per-minute rate windows only when nothing else is
 * there ({@link primary}). Order: windows with a known percent, an exhausted plan window known only by its state and an
 * exhausted balance, the exhausted ones first (the one that frees last, or never, leads), then the least left; then
 * balances with a known amount (DeepSeek `잔액`, Codex credits); a budget the user set with room left after those, so
 * DeepSeek reads `잔액 $7.42 · 이번 달 예산 남음 100%`. The Claude `representative-claim` does not choose: Anthropic
 * names `five_hour` while the weekly window is far tighter.
 */

export type Tone = "neutral" | "warn" | "danger"

/** What the ranking reads of a window at a moment (own-web's `WindowView` carries the same fields). */
export interface Facts {
  readonly kind: WindowKind
  /** Used share, 0..100+; 0 after a reset that passed unobserved; `undefined` without one (a balance). */
  readonly percent: number | undefined
  readonly remaining: number | undefined
  /** `undefined` once the reset passed. */
  readonly resetAt: number | undefined
  /** `unknown` after a reset that passed unobserved, and for a lapsed bucket. */
  readonly status: Status
  /** `estimated` after a reset that passed unobserved. */
  readonly confidence: Confidence
}

/**
 * Claude's extra usage (`claude.overage`, 02 §8.9): extra headroom past the plan, not a limit of its own. It never
 * ranks, never names the account's state and never blocks alone; its verdict goes with the plan limit it would have
 * covered ({@link covering}).
 */
export function extra(windowID: string) {
  return windowID === "claude.overage"
}

/** A window as it counts at `now`. */
export function facts(window: Window, now: number): Facts {
  const passed = window.resetAt !== undefined && window.resetAt <= now && window.observedAt < window.resetAt
  const measured = percentOf(window)
  return {
    kind: window.kind,
    percent: passed && measured !== undefined ? 0 : measured,
    remaining: window.remaining,
    resetAt: passed ? undefined : window.resetAt,
    status: passed || lapsed(window, now) ? "unknown" : window.status,
    confidence: passed ? "estimated" : window.confidence,
  }
}

/**
 * 03 §7.2 colors of a used percent, keyed on what remains so they mean the same whether the screen shows the remaining
 * or the used share: danger at 10 % or less left (or exhausted), warning at 30 % or less, neutral otherwise; a window
 * without a percent is warned only when its status says so.
 */
export function tone(percent: number | undefined, status?: Status): Tone {
  if (status === "exhausted") return "danger"
  if (percent === undefined) return status === "warning" ? "warn" : "neutral"
  const left = 100 - percent
  if (left <= 10) return "danger"
  if (left <= 30) return "warn"
  return "neutral"
}

/** No value to show: an unknown observation, or neither a percent nor an amount. */
export function unknown(item: Pick<Facts, "percent" | "remaining" | "confidence">) {
  return item.confidence === "unknown" || (item.percent === undefined && item.remaining === undefined)
}

/**
 * A plan window or spend cap known only by its state (Claude `추가 사용량` without a percent, a claimed `주간 · Opus`):
 * no percent and no amount, but a status the response gave. A balance without an amount (Codex credits that only say
 * they exist) stays unknown.
 */
export function stateOnly(item: Pick<Facts, "kind" | "percent" | "remaining" | "confidence" | "status">) {
  return (
    (item.kind === "rolling_quota" || item.kind === "spend_cap") &&
    item.percent === undefined &&
    item.remaining === undefined &&
    item.confidence !== "unknown" &&
    item.status !== "unknown"
  )
}

/**
 * Display order: plan windows (5 h, then weekly/7 d), spend and budgets, balances, per-minute rate windows last.
 * Stable for equal ranks so the server order is kept.
 */
export function ordered<W extends Pick<Window, "kind" | "windowMinutes">>(windows: readonly W[]) {
  return windows.toSorted((a, b) => rank(a) - rank(b) || (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0))
}

/** Windows worth a place in compact views: everything but per-minute rate windows (all of them when only those). */
export function primary<W extends Pick<Window, "kind" | "windowMinutes">>(windows: readonly W[]) {
  const main = ordered(windows).filter((window) => window.kind !== "rate")
  return main.length ? main : ordered(windows)
}

/** The account's windows for `model` in the one order (see the module comment). */
export function ranked<W extends Window>(windows: readonly W[], now: number, model?: string): W[] {
  const read = primary(
    windows.filter((window) => limits(window.id, model) && !lapsed(window, now) && !extra(window.id)),
  ).map((window) => ({ window, ...facts(window, now) }))
  const amount = (item: Facts) => !unknown(item) && item.percent === undefined && item.remaining !== undefined
  const tight = read
    .filter(
      (item) =>
        (!unknown(item) && item.percent !== undefined) ||
        (item.status === "exhausted" && ((stateOnly(item) && item.kind === "rolling_quota") || amount(item))),
    )
    .toSorted(tighter)
  const amounts = read.filter((item) => amount(item) && item.status !== "exhausted")
  const roomy = (item: Facts) => item.kind === "budget" && tone(item.percent, item.status) === "neutral"
  return [...tight.filter((item) => !roomy(item)), ...amounts, ...tight.filter(roomy)].map((item) => item.window)
}

/** {@link ranked}'s order of two windows with a percent or a blocked state, also across accounts. */
export function tighter(a: Pick<Facts, "status" | "resetAt" | "percent">, b: Pick<Facts, "status" | "resetAt" | "percent">) {
  return frees(b) - frees(a) || (b.percent ?? 0) - (a.percent ?? 0)
}

/**
 * Whether a window holds back requests of `model` now: exhausted (a passed reset and a lapsed bucket no longer count),
 * limiting that model (`LimitModel.limits`), and not Claude's extra usage, which only blocks together with the plan
 * window it would have covered (that window blocks).
 */
export function blocks(window: Window, now: number, model: string | undefined) {
  return facts(window, now).status === "exhausted" && limits(window.id, model) && !extra(window.id)
}

/**
 * Whether Claude's extra usage is in play for `model`: a plan window that limits the model is used up, so extra usage
 * would cover it, or refuses. Only then does its verdict lead with that limit (the folded line's note, a warning or
 * danger tone); otherwise it is a quiet note.
 */
export function covering(windows: readonly Window[], now: number, model: string | undefined) {
  return windows.some((window) => window.kind === "rolling_quota" && blocks(window, now, model))
}

/**
 * The Claude window a choice between Claude accounts compares first (02 §8.8, §7.1.2): the five hours, or the week for
 * an account without a five-hour window (a verified Ultra account), which only its weeks limit. The week stays the
 * tiebreak.
 */
export function claudeFirst<W extends Pick<Window, "id">>(windows: readonly W[]) {
  return windows.find((window) => window.id === "claude.5h") ?? windows.find((window) => window.id === "claude.7d")
}

/** When an exhausted window frees (never: `Infinity`); 0 for one that is not exhausted. */
function frees(item: Pick<Facts, "status" | "resetAt">) {
  return item.status === "exhausted" ? (item.resetAt ?? Infinity) : 0
}

/** Used share: `usedPercent`, else derived from `remaining/limit` (key limits, rate windows). */
function percentOf(window: Window) {
  if (window.usedPercent !== undefined) return window.usedPercent
  if (window.limit !== undefined && window.limit > 0 && window.remaining !== undefined)
    return Math.max(0, Math.min(100, (100 * (window.limit - window.remaining)) / window.limit))
  return undefined
}

function rank(window: Pick<Window, "kind">) {
  if (window.kind === "rolling_quota") return 0
  if (window.kind === "budget" || window.kind === "spend_cap") return 1
  if (window.kind === "balance") return 2
  return 3
}
