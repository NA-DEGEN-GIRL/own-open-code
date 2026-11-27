// Number and time formatting of 03 §7.2 (reset text), §7.3 (ages) and §7.5 (rounding): tokens in 1k steps
// (`118k`, `1.2M`), money with 2 decimals below $1 and 1 above, credits with 1 decimal and `≈`. Pure except for
// the translation function, so the unit tests cover every branch.
import type { I18n } from "@/i18n"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** `950`, `118k`, `1.2M` (7.5 "토큰: 1k 단위, 1M 이상이면 1.2M"). */
export function tokens(value: number) {
  const abs = Math.abs(value)
  if (abs < 1_000) return String(Math.round(value))
  if (abs < 999_500) return `${Math.round(value / 1_000)}k`
  return `${trim((value / 1_000_000).toFixed(1))}M`
}

/** 7.5: below $1 two decimals, otherwise one (`$0.42`, `$1.3`). `exact` keeps two decimals (spend, budgets). */
export function usd(value: number, exact = false) {
  const digits = exact || Math.abs(value) < 1 ? 2 : 1
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** Credits are always an estimate: `≈42.6 cr` (7.5, 4.5). */
export function credits(value: number) {
  return `≈${value.toFixed(1)} cr`
}

/** An amount in a ledger/limit unit. */
export function amount(value: number, unit: string | undefined, exact = true) {
  if (unit === "USD") return usd(value, exact)
  if (unit === "credits") return credits(value)
  if (unit === "CNY") return `¥${value.toFixed(2)}`
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2)
}

/** A budget or limit amount: whole dollars without decimals (`$100`), otherwise the exact form (`$23.10`). */
export function budget(value: number, unit: string | undefined) {
  if (unit === "USD" && Number.isInteger(value)) return `$${value.toLocaleString("en-US")}`
  return amount(value, unit)
}

/** What the formatting reads of the translator: the words and the locale. */
type Words = Pick<I18n, "t" | "locale">

/** `42분`, `2시간 14분`, `3일 4시간` for a positive span. */
export function duration(i18n: Words, ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE))
  if (minutes < 60) return i18n.t("own.time.minutes", { n: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? i18n.t("own.lim.durHM", { h: hours, m: rest }) : i18n.t("own.time.hours", { n: hours })
  const days = Math.floor(hours / 24)
  const hourRest = hours % 24
  return hourRest ? i18n.t("own.lim.durDH", { d: days, h: hourRest }) : i18n.t("own.time.days", { n: days })
}

/** `방금`, `3분 전`, `2시간 전`, `4일 전` (7.3 ages). */
export function ago(i18n: I18n, now: number, then: number) {
  const span = Math.max(0, now - then)
  if (span < MINUTE) return i18n.t("own.time.now")
  if (span < HOUR) return i18n.t("own.lim.agoMinutes", { n: Math.floor(span / MINUTE) })
  if (span < DAY) return i18n.t("own.lim.agoHours", { n: Math.floor(span / HOUR) })
  return i18n.t("own.lim.agoDays", { n: Math.floor(span / DAY) })
}

/**
 * 7.2 reset text: within 24 hours relative (`42분 후 리셋`, `2시간 14분 후 리셋`), later {@link when} it is
 * (`월 오전 9:00 리셋`, `11월 1일 오전 9:00 리셋`). A reset in the past is not formatted here (the caller shows
 * `리셋됨(추정)`).
 */
export function resetText(i18n: Words, now: number, resetAt: number) {
  const span = resetAt - now
  if (span < DAY) return i18n.t("own.limit.resetIn", { duration: duration(i18n, span) })
  return i18n.t("own.limit.resetAt", { when: when(i18n, now, resetAt) })
}

/**
 * A coming time in a sentence, the reset text's rule (7.2, LV 2026-10-24): within 24 hours the time left (`2시간 14분 후`,
 * `2 h 14 min from now`), later {@link when} it is (`월 오전 9:00`, `11월 1일 오전 9:00`). Every future time on screen
 * reads so: the 리셋까지 대기 chip, a scheduled switch's deadline, the team's 한도 대기 and its held updates, a choice's
 * expiry, a speed's rest; never a bare `14:20` that may be tomorrow or next week.
 */
export function coming(i18n: Words, now: number, at: number) {
  if (at - now < DAY) return i18n.t("own.time.in", { duration: duration(i18n, at - now) })
  return when(i18n, now, at)
}

/**
 * A coming time in the one clock style of the limit surfaces (7.2): `오후 5:40` today, the weekday and the clock within
 * 6 days when that is not today's weekday (`화 오전 9:00`), otherwise the date (`11월 1일 오전 9:00`). Never a bare
 * weekday that could be today's next week; a day within 6 days has a weekday of its own.
 */
export function when(i18n: Words, now: number, at: number) {
  const date = new Date(at)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return clock(i18n, at)
  const day =
    at - now <= 6 * DAY && date.getDay() !== today.getDay()
      ? format(i18n, { weekday: "short" })
      : format(i18n, { month: "short", day: "numeric" })
  return `${day.format(date)} ${clock(i18n, at)}`
}

/** `오후 5:40` (`5:40 PM`): the clock of every limit text, folded, unfolded and on hover (7.2). */
export function clock(i18n: Words, at: number) {
  return format(i18n, { hour: "numeric", minute: "2-digit" }).format(new Date(at))
}

/** Hover text of a reset (7.2): `2026-09-26 (토) 오후 2:20 리셋`. */
export function resetTitle(i18n: Words, resetAt: number) {
  return i18n.t("own.lim.resetAbsolute", { date: absolute(i18n, resetAt) })
}

/** `2026-09-26 (토) 오후 2:20` in local time. */
export function absolute(i18n: Words, at: number) {
  const date = new Date(at)
  const day = format(i18n, { weekday: "short" }).format(date)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} (${day}) ${clock(i18n, at)}`
}

const formats = new Map<string, Intl.DateTimeFormat>()

function format(i18n: Words, options: Intl.DateTimeFormatOptions) {
  const key = `${i18n.locale()}:${JSON.stringify(options)}`
  const cached = formats.get(key) ?? new Intl.DateTimeFormat(i18n.locale(), options)
  formats.set(key, cached)
  return cached
}

/** `1,234,567` for inputs and read-only token counts. */
export function grouped(value: number) {
  return Math.round(value).toLocaleString("en-US")
}

/** Parses a token count typed with thousands separators or a `k`/`M` suffix; `undefined` when not a number. */
export function parseTokens(text: string) {
  const cleaned = text.replaceAll(/[,\s_]/g, "").toLowerCase()
  if (!cleaned) return undefined
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(cleaned)
  if (!match) return undefined
  const scale = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1
  return Math.round(Number(match[1]) * scale)
}

/** Percent text without trailing zeros: `62%`, `8.5%`. */
export function percent(value: number) {
  return `${trim(value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1))}%`
}

function trim(text: string) {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}
