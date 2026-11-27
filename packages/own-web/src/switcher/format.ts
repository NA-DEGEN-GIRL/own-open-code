// Number formats of 03 §7.5 shared by the switcher, the cost dialog, the composer and the context meter. The UI never
// computes a cost (03 P10); these only print what `switch.estimate` and `cache.state` return.
import type { Estimate } from "@own/protocol"
import type { I18n } from "@/i18n"

/** Tokens in 1k units (`118k`), `1.2M` from a million, `<1k` below (03 §7.5 "반올림 규칙"). */
export function formatTokens(value: number) {
  const abs = Math.abs(value)
  if (abs >= 999_500) return `${trimZero((value / 1_000_000).toFixed(1))}M`
  if (abs >= 500) return `${Math.round(value / 1_000)}k`
  return abs === 0 ? "0" : "<1k"
}

/** Dollars: two decimals under $1, one from $1 (03 §7.5). */
export function formatMoney(usd: number) {
  const abs = Math.abs(usd)
  const text = abs < 1 ? abs.toFixed(2) : abs.toFixed(1)
  return `${usd < 0 ? "−" : ""}$${text}`
}

/** One amount in an estimate unit, without sign. Credits always carry `≈` (03 §4.5, §7.5). */
export function formatAmount(i18n: I18n, value: number, unit: Estimate.Unit) {
  const abs = Math.abs(value)
  if (unit === "USD") return formatMoney(abs)
  if (unit === "credits") return i18n.t("own.cost.credits", { value: abs.toFixed(1) })
  return `${trimZero(abs.toFixed(1))}%`
}

/**
 * A Δ against staying (03 §7.5): `+$0.72`, `+≈13.5 cr`, a range `+$0.12~$0.40`. Negative values (a cheaper target)
 * print with `−`.
 */
export function formatDelta(i18n: I18n, delta: Estimate.Delta) {
  const lo = Math.min(delta.lo, delta.hi)
  const hi = Math.max(delta.lo, delta.hi)
  const sign = (value: number) => (value < 0 ? "−" : "+")
  if (nearlyEqual(lo, hi)) return `${sign(hi)}${formatAmount(i18n, hi, delta.unit)}`
  if (delta.unit === "USD") return `${sign(lo)}${formatMoney(Math.abs(lo))}~${formatMoney(hi)}`
  const tail = formatAmount(i18n, hi, delta.unit)
  const head = delta.unit === "credits" ? `≈${Math.abs(lo).toFixed(1)}` : trimZero(Math.abs(lo).toFixed(1))
  return `${sign(lo)}${head}~${tail.replace(/^≈/, "")}`
}

/** A plain amount range without sign, e.g. the first request on the target when units differ (03 §7.5). */
export function formatRange(i18n: I18n, delta: Estimate.Delta) {
  const lo = Math.min(delta.lo, delta.hi)
  const hi = Math.max(delta.lo, delta.hi)
  if (nearlyEqual(lo, hi)) return formatAmount(i18n, hi, delta.unit)
  if (delta.unit === "USD") return `${formatMoney(lo)}~${formatMoney(hi)}`
  return `${formatAmount(i18n, lo, delta.unit)}~${formatAmount(i18n, hi, delta.unit).replace(/^≈/, "")}`
}

/** Percent for bars and quota impact: integers, one decimal under 10. */
export function formatPercent(value: number) {
  return value < 10 && !Number.isInteger(value) ? trimZero(value.toFixed(1)) : `${Math.round(value)}`
}

/** `14:20` for resets, deadlines and scheduled messages (local time). */
export function formatClock(at: number) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function nearlyEqual(a: number, b: number) {
  return Math.abs(a - b) < 0.005
}

function trimZero(text: string) {
  return text.endsWith(".0") ? text.slice(0, -2) : text
}
