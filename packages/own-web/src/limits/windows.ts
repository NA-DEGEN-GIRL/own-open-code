// Limit windows as the screen shows them (03 §7.1–7.3). The router sends normalized `Limit.Window`s (02 §7.3); this
// file only decides how to draw them: bar percent, tone, hatching, fading and the confidence tag. The one ranking of an
// account's windows that every surface leads with is own-protocol's `LimitRank`, which own-accounts names the
// account's state with too. Freshness is re-derived from `observedAt` on the minute clock because a `live` value turns
// `recent` and then `stale` without a new event (7.3: 2 and 15 minute boundaries of 02 §7.4).
import type { Limit } from "@own/protocol"
import { storedLocale, type Locale } from "@/i18n"
import { LimitRank } from "@own/protocol/limit-rank"

export { ordered, primary, stateOnly, tighter, tone } from "@own/protocol/limit-rank"

export type Tone = LimitRank.Tone
export type Confidence = Limit.Confidence

const LIVE_MS = 2 * 60_000
const RECENT_MS = 15 * 60_000

export interface WindowView {
  readonly id: string
  readonly label: string
  readonly kind: Limit.WindowKind
  /**
   * Percent used (0..100+), as the router reports it; surfaces draw it through ./display (remaining or used).
   * `undefined` when the window has none (e.g. a balance).
   */
  readonly percent: number | undefined
  /** Draw no bar and write `— 알 수 없음`. */
  readonly unknown: boolean
  /** Hatched fill (estimates only, 7.2). */
  readonly hatched: boolean
  /** Faded fill (stale, 7.2). */
  readonly faded: boolean
  /** The reset passed without a new observation: `리셋됨(추정)` from 0 % (7.2). */
  readonly resetEstimated: boolean
  readonly resetAt: number | undefined
  readonly tone: Tone
  readonly confidence: Confidence
  readonly source: Limit.Source
  readonly observedAt: number
  readonly status: Limit.Status
  readonly remaining: number | undefined
  readonly limit: number | undefined
  readonly unit: Limit.Unit | undefined
}

/** 7.3: `live` ≤ 2 min, `recent` ≤ 15 min, then `stale`; `estimated`/`unknown` stay as the router said. */
export function confidence(window: Pick<Limit.Window, "confidence" | "observedAt">, now: number): Confidence {
  if (window.confidence === "estimated" || window.confidence === "unknown") return window.confidence
  const age = now - window.observedAt
  if (age <= LIVE_MS) return "live"
  if (age <= RECENT_MS) return "recent"
  return "stale"
}

/**
 * A window as drawn at `now` (`LimitRank.facts`): a reset that passed unobserved draws 0 %, and a model bucket without a
 * reset whose observation is stale (`LimitModel.lapsed`) keeps its last value, faded with the stale tag, but its state
 * no longer counts (status `unknown`), like the store says.
 */
export function view(window: Limit.Window, now: number): WindowView {
  const facts = LimitRank.facts(window, now)
  const level = facts.confidence === "estimated" ? "estimated" : confidence(window, now)
  return {
    id: window.id,
    label: labelOf(window.label, storedLocale()),
    kind: window.kind,
    percent: facts.percent,
    unknown: LimitRank.unknown({ ...facts, confidence: level }),
    hatched: level === "estimated",
    faded: level === "stale",
    resetEstimated: window.resetAt !== undefined && facts.resetAt === undefined,
    resetAt: facts.resetAt,
    tone: LimitRank.tone(facts.percent, facts.status),
    confidence: level,
    source: window.source,
    observedAt: window.observedAt,
    status: facts.status,
    remaining: window.remaining,
    limit: window.limit,
    unit: window.unit,
  }
}

/** The English of the labels the router gives windows (02 §7.3 writes them in Korean). */
const ENGLISH: Readonly<Record<string, string>> = {
  주간: "Weekly",
  사용량: "Usage",
  "사용량 한도": "Usage limit",
  "추가 사용량": "Extra usage",
  크레딧: "Credits",
  잔액: "Balance",
  보너스: "Bonus",
  "이번 달 예산": "Budget this month",
  "분당 요청": "Requests/min",
  "분당 토큰": "Tokens/min",
  "분당 입력 토큰": "Input tokens/min",
  "분당 출력 토큰": "Output tokens/min",
  "외부 앱": "Other apps",
}
const UNITS: Readonly<Record<string, string>> = { 시간: "hour", 일: "day", 분: "minute" }

/** A window's label in `locale`: `5시간` → `5 hours`, `주간 · Opus` → `Weekly · Opus`; an unknown one stays as it is. */
export function labelOf(label: string, locale: Locale) {
  if (locale === "ko") return label
  return label
    .split(" · ")
    .map(
      (part) =>
        ENGLISH[part] ??
        part.replace(/^([\d.]+)(시간|일|분)$/, (_, n, unit) => `${n} ${UNITS[unit]}${n === "1" ? "" : "s"}`),
    )
    .join(" · ")
}

/**
 * Windows the screen keeps: all but a DeepSeek 보너스 window at 0. The router replaces windows and never deletes one,
 * so a spent or expired bonus comes back at 0 once to replace its last amount (own-accounts `Windows.deepseekBalance`)
 * and would otherwise stay on the card as "보너스 0" for good.
 */
export function kept(windows: readonly Limit.Window[]) {
  return windows.filter(
    (window) => !(window.kind === "balance" && window.id.endsWith(".granted") && window.remaining === 0),
  )
}

/** The one ranking of an account's windows for `model` (`LimitRank.ranked`), drawn at `now`. */
export function ranked(windows: readonly Limit.Window[], now: number, model?: string) {
  return LimitRank.ranked(windows, now, model).map((window) => view(window, now))
}

/** The window a surface leads with, see {@link ranked}. */
export function tightest(windows: readonly Limit.Window[], now: number, model?: string): WindowView | undefined {
  return ranked(windows, now, model)[0]
}
