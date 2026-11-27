// What the limits summary says (03 §7.2, LV 2026-10-24), pure so the unit tests read the exact words. Folded, an
// account is one line: the first windows of the one ranking (./windows `ranked`, the same window every surface leads
// with), the first one's reset attached to it in parentheses (`주간 남음 26% (화 오전 4:00 리셋) · 5시간 남음 98%`, UX
// 2026-10-26) and, when a used-up plan limit leads that Claude's extra usage would cover, its billing verdict (02 §8.9).
// Unfolded, every window is a row (./meter `LimitRow`, see {@link rows}) whose reset also gives the clock time
// (`2시간 14분 후 리셋 (오후 5:40)`) and whose window known only by its state (Claude `추가 사용량` without a percent, a
// claimed `주간 · Opus`) reads as a word with the reason the response gave. Lazy with its screens (./summary.tsx).
import type { Limit } from "@own/protocol"
import { LimitRank } from "@own/protocol/limit-rank"
import type { I18n, I18nParams } from "@/i18n"
import { billingOf } from "@/accounts/claude-billing"
import { resetOf, windowValue, type LimitMode } from "./display"
import { duration, when } from "./format"
import { limitSummaryText, type LimitSummaryKey } from "./summary-strings"
import { ordered, primary, ranked, view, type Tone, type WindowView } from "./windows"

export interface Part {
  /** The window id of a `window` part; `reset` or `billing` otherwise. */
  readonly key: string
  readonly role: "window" | "reset" | "billing"
  readonly text: string
  readonly tone: Tone
}

/**
 * The folded line in parts: `{label} {value}` for the first `max` windows of {@link ranked} for `model` (the session's
 * or the row's; without one, account-wide windows only), the first window's reset after it, and the Claude account's
 * billing verdict when its responses gave one and a used-up plan limit that extra usage would cover holds this model
 * back (`LimitRank.covering`); otherwise extra usage is a quiet note of the unfolded rows. Empty when no window has a
 * value (the line then reads `— 알 수 없음`).
 */
export function foldedParts(
  i18n: I18n,
  windows: readonly Limit.Window[],
  now: number,
  max: number,
  mode?: LimitMode,
  model?: string,
): Part[] {
  const items = ranked(windows, now, model).slice(0, max)
  const reset = items[0] ? resetOf(i18n, items[0], now) : undefined
  const billing = LimitRank.covering(windows, now, model) ? billingOf(windows) : undefined
  return [
    ...items.flatMap((item, index): Part[] => [
      { key: item.id, role: "window", text: `${item.label} ${windowValue(i18n, item, mode)}`, tone: item.tone },
      ...(index === 0 && reset
        ? [{ key: "reset", role: "reset" as const, text: reset, tone: "neutral" as const }]
        : []),
    ]),
    ...(billing
      ? [
          {
            key: "billing",
            role: "billing" as const,
            text: text(i18n, `own.lim.sum.billing.${billing.state}`),
            tone: billing.state === "rejected" ? ("danger" as const) : ("warn" as const),
          },
        ]
      : []),
  ]
}

/**
 * The folded line's groups as drawn (UX 2026-10-26): a window with the reset that follows it, which reads faint in
 * parentheses with no separator before it (`주간 남음 20% (3시간 45분 후 리셋) · 5시간 남음 99%`); each group is one
 * unbreakable piece that carries its `·` before it (styles/seps.css `.own-seps`).
 */
export function foldedGroups(parts: readonly Part[]) {
  return parts.flatMap((part, index) => {
    if (part.role === "reset") return []
    const next = parts[index + 1]
    return [{ part, reset: next?.role === "reset" ? next : undefined }]
  })
}

/**
 * A state word's tone: the window's, except that Claude's extra usage stays neutral, a quiet note, unless its verdict
 * goes with a used-up plan limit it would cover (`covering`, `LimitRank.covering`): extra usage being off (`추가 사용량
 * 차단` without a billing verdict) is no limit reached.
 */
export function stateTone(item: WindowView, window: Limit.Window, covering: boolean): Tone {
  return item.kind === "spend_cap" && (!window.meta?.billing || !covering) ? "neutral" : item.tone
}

/**
 * What a Claude window's response said beyond its value (02 §8.9, 03 §5.4.1(d)): the billing verdict
 * (`추가 사용량으로 청구 중`, `추가 사용량 거절됨`) and the `overage-disabled-reason` in words (`꺼져 있어요`); the raw header
 * value is the hover text. Warned only while it goes with a used-up plan limit (`covering`), else a quiet note.
 * `undefined` for every other window.
 */
export function windowNote(i18n: I18n, window: Limit.Window, covering: boolean) {
  const billing = window.meta?.billing
  const reason = window.meta?.disabledReason
  if (!billing && !reason) return undefined
  return {
    text: [
      billing ? text(i18n, `own.lim.sum.billing.${billing}`) : undefined,
      reason ? reasonText(i18n, reason) : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    tone:
      !covering || !billing ? ("neutral" as const) : billing === "rejected" ? ("danger" as const) : ("warn" as const),
    title: reason ? `overage-disabled-reason: ${reason}` : undefined,
  }
}

/**
 * Claude Code's `overage-disabled-reason` values in plain words: turned off for the organization, member or seat
 * (`*_disabled*`), no credits, a zero credit limit, the spend cap, not in the plan; anything else as it came.
 */
export function reasonText(i18n: I18n, reason: string) {
  if (reason.includes("disabled")) return text(i18n, "own.lim.sum.reason.disabled")
  if (reason === "out_of_credits") return text(i18n, "own.lim.sum.reason.credits")
  if (reason.endsWith("zero_credit_limit")) return text(i18n, "own.lim.sum.reason.zero")
  if (reason.includes("spend_cap")) return text(i18n, "own.lim.sum.reason.cap")
  if (reason === "overage_not_provisioned") return text(i18n, "own.lim.sum.reason.plan")
  return reason
}

/**
 * Unfolded reset: the time left and the clock in the folded views' style (./format `when`): `2시간 14분 후 리셋 (오후 5:40)`,
 * `2일 17시간 후 리셋 (화 오전 9:00)`, `6일 23시간 후 리셋 (10월 31일 오전 9:00)`.
 */
export function resetLong(i18n: I18n, now: number, resetAt: number) {
  return text(i18n, "own.lim.sum.resetLong", {
    duration: duration(i18n, resetAt - now),
    clock: when(i18n, now, resetAt),
  })
}

/**
 * The rows of an unfolded summary: every window in display order, per-minute rate windows only with `rates`. A
 * credits window (Codex `크레딧`) with no value or nothing left says nothing a ChatGPT plan needs (UX 2026-10-26: `크레딧
 * — 알 수 없음` on every Plus account): it is left out unless it leads the ranking for `model` or its state warns
 * (`주의`, `차단`).
 */
export function rows(windows: readonly Limit.Window[], rates: boolean | undefined, now: number, model?: string) {
  const lead = ranked(windows, now, model)[0]?.id
  return (rates ? ordered(windows) : primary(windows)).filter(
    (window) => !quietCredits(window, now) || window.id === lead,
  )
}

/** A credits balance whose amount is unknown or 0 and whose state does not warn. */
function quietCredits(window: Limit.Window, now: number) {
  if (window.kind !== "balance" || window.unit !== "credits") return false
  if (window.status === "warning" || window.status === "exhausted") return false
  return view(window, now).unknown || !window.remaining
}

/** The summary's own strings in the viewer's locale. */
export function text(i18n: Pick<I18n, "locale">, key: LimitSummaryKey, params?: I18nParams) {
  return limitSummaryText.text(i18n.locale(), key, params)
}
