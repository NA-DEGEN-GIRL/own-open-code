// 5 h / 7 d usage trend buckets of the limits dashboard (03 §5.5), from `accounts.usage{groupBy:"hour"}` rows, and
// its "at this rate" estimate of one window. Pure, lazy with the dashboard.
import type { Ledger } from "@own/protocol"

const HOUR = 3_600_000
const DAY = 24 * HOUR

export type Range = "5h" | "7d"

/** Tokens of a usage row (input side + output). */
function volume(row: Pick<Ledger.UsageRow, "tokens">) {
  return row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite + row.tokens.output + row.tokens.reasoning
}

/**
 * Buckets for the trend: the last 5 hours, or the last 7 days (hour rows summed per local day). Missing buckets are
 * zero; the keys of hour rows are UTC hour starts (ISO).
 */
export function buckets(rows: readonly Pick<Ledger.UsageRow, "key" | "tokens">[], range: Range, now: number) {
  const byHour = new Map(rows.map((row) => [Date.parse(row.key), volume(row)]))
  if (range === "5h") {
    const top = Math.floor(now / HOUR) * HOUR
    return Array.from({ length: 5 }, (_, index) => byHour.get(top - (4 - index) * HOUR) ?? 0)
  }
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime() - 6 * DAY
  const days = Array.from({ length: 7 }, () => 0)
  for (const [at, value] of byHour) {
    const index = Math.floor((at - start) / DAY)
    if (index >= 0 && index < 7) days[index] = days[index]! + value
  }
  return days
}

/**
 * 5.5 "현재 속도면 약 N 뒤 한도 도달": least-squares slope of the last 30 minutes of one window. `undefined` with fewer
 * than three observations, a flat or falling slope, or when the reset comes first.
 */
export function eta(
  points: readonly { readonly at: number; readonly percent: number }[],
  now: number,
  resetAt: number | undefined,
) {
  const recent = points.filter((point) => now - point.at <= 30 * 60_000)
  if (recent.length < 3) return undefined
  const meanX = recent.reduce((sum, point) => sum + point.at, 0) / recent.length
  const meanY = recent.reduce((sum, point) => sum + point.percent, 0) / recent.length
  const cov = recent.reduce((sum, point) => sum + (point.at - meanX) * (point.percent - meanY), 0)
  const variance = recent.reduce((sum, point) => sum + (point.at - meanX) ** 2, 0)
  if (variance === 0) return undefined
  const slope = cov / variance
  if (slope <= 0) return undefined
  const last = recent.at(-1)!
  const reach = last.at + (100 - last.percent) / slope
  if (reach <= now || (resetAt !== undefined && reach >= resetAt)) return undefined
  return reach - now
}
