// Number and time formats of the transcript (03 §7.5 rounding rules, §4.5 footer and `날짜·시각`). Pure, so the
// footer, markers and tests share one definition.
import type { I18n } from "@/i18n"

/** Tokens: `940`, `2.1k` (under 10k), `118k`, `1.2M`. */
export function formatTokens(value: number) {
  const n = Math.max(0, Math.round(value))
  if (n < 1_000) return String(n)
  if (n < 10_000) return `${trim((n / 1_000).toFixed(1))}k`
  if (n < 999_500) return `${Math.round(n / 1_000)}k`
  return `${trim((n / 1_000_000).toFixed(1))}M`
}

/** USD: two decimals under $1, one above (7.5). Returns the number part; the `$` comes from the catalog. */
export function formatUsd(value: number) {
  return Math.abs(value) < 1 ? value.toFixed(2) : value.toFixed(1)
}

/** Credits: one decimal (7.5). */
export function formatCredits(value: number) {
  return value.toFixed(1)
}

/** Cache hit ratio 0..1 as `96%`; `null` when there was no input. */
export function formatPercent(ratio: number | null) {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`
}

export function formatDuration(i18n: I18n, ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return i18n.t("own.transcript.seconds", { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return i18n.t("own.transcript.minutesSeconds", { m: minutes, s: seconds % 60 })
  return i18n.t("own.transcript.hoursMinutes", { h: Math.floor(minutes / 60), m: minutes % 60 })
}

/** Tokens per second: one decimal under 10 (`7.4`), whole numbers above (`42`). Number part only. */
export function formatSpeed(tokensPerSecond: number) {
  return tokensPerSecond < 10 ? trim(tokensPerSecond.toFixed(1)) : String(Math.round(tokensPerSecond))
}

/** Seconds with one decimal under 10 s (`1.2`, `0.4`), whole seconds above. Number part only. */
export function formatSeconds(ms: number) {
  const seconds = Math.max(0, ms) / 1_000
  return seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))
}

/**
 * `날짜·시각` (03 §4.5, UC 2026-10-18), local time: `10월 18일 오후 3:42`. The date is always there, so a line reads the
 * same tomorrow; the year only when it is not this year's (`2025년 10월 18일 오후 3:42`).
 */
export function formatClock(i18n: I18n, at: number, now = Date.now()) {
  const year = new Date(at).getFullYear() !== new Date(now).getFullYear()
  return clock(i18n, {
    ...(year ? { year: "numeric" } : {}),
    month: i18n.locale() === "ko" ? "long" : "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at)
}

/** The tooltip of a `날짜·시각`: `2026년 10월 18일 일요일 오후 3:42:08`. */
export function formatClockFull(i18n: I18n, at: number) {
  return clock(i18n, {
    year: "numeric",
    month: i18n.locale() === "ko" ? "long" : "short",
    day: "numeric",
    weekday: i18n.locale() === "ko" ? "long" : "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(at)
}

/** A step's start in the step table (steps of one turn share their date): `오후 3:42:08`. */
export function formatClockTime(i18n: I18n, at: number) {
  return clock(i18n, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(at)
}

const clocks = new Map<string, Intl.DateTimeFormat>()

function clock(i18n: I18n, options: Intl.DateTimeFormatOptions) {
  const key = `${i18n.locale()}:${JSON.stringify(options)}`
  const cached = clocks.get(key) ?? new Intl.DateTimeFormat(i18n.locale(), options)
  clocks.set(key, cached)
  return cached
}

/**
 * Splits a translated phrase at an unfilled `{placeholder}` so an element (a link, a chip) can sit inside the whole
 * phrase instead of concatenating fragments. Without the placeholder the phrase is the head.
 */
export function splitAt(text: string, placeholder: string): [string, string] {
  const index = text.indexOf(placeholder)
  if (index < 0) return [text, ""]
  return [text.slice(0, index), text.slice(index + placeholder.length)]
}

function trim(value: string) {
  return value.endsWith(".0") ? value.slice(0, -2) : value
}
