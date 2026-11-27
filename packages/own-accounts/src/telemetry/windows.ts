export * as Windows from "./windows.js"

import type { Provider } from "@opencode/schema/provider"
import { Hash } from "@own/runtime"
import type { Account, Kind, Limit } from "@own/protocol"

/**
 * Pure parsers from provider signals to {@link Limit.Window}s (02 §7.1, §7.3). No I/O, no clock: callers pass the
 * observation time. Unknown or malformed values are skipped, never guessed.
 */

/** Whose limits these are. */
export interface Subject {
  readonly accountID: Account.ID
  readonly providerID: Provider.ID
}

export interface Observation {
  readonly observedAt: number
  /** `header` for a success, `error` for a status ≥ 400, `ws_event` for a frame, `poll` for a poller. */
  readonly source: Limit.Source
}

/** Used percent from which a window shows `warning` (02 §7.3). */
export const WARNING_PERCENT = 85

/** 02 §7.3 label rule: 300 → "5시간", 10080 → "주간", otherwise "{h}시간". */
export function codexLabel(minutes: number | undefined) {
  if (minutes === undefined) return "사용량"
  if (minutes === 300) return "5시간"
  if (minutes === 10_080) return "주간"
  if (minutes % 1_440 === 0 && minutes >= 1_440) return `${minutes / 1_440}일`
  if (minutes < 60) return `${minutes}분`
  return `${Math.round((minutes / 60) * 10) / 10}시간`
}

/** Parsed header view: lower-case names, first value wins. */
function table(headers: Hash.HeadersLike) {
  const map = new Map<string, string>()
  for (const entry of Hash.entries(headers)) if (!map.has(entry[0])) map.set(entry[0], entry[1].trim())
  return map
}

function number(value: string | undefined) {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function flag(value: string | undefined) {
  if (value === undefined) return undefined
  if (value.toLowerCase() === "true" || value === "1") return true
  if (value.toLowerCase() === "false" || value === "0") return false
  return undefined
}

function percentStatus(usedPercent: number): Limit.Status {
  if (usedPercent >= 100) return "exhausted"
  if (usedPercent >= WARNING_PERCENT) return "warning"
  return "ok"
}

// ---------------------------------------------------------------------------------------------------------------
// Codex (`x-codex-*`, `x-<limit_id>-*`, `codex.rate_limits` frames)

/** One codex rate-limit window before normalization. */
interface CodexWindow {
  readonly usedPercent: number
  readonly windowMinutes?: number
  /** Epoch ms. */
  readonly resetAt?: number
}

interface CodexSnapshot {
  /** `codex` for the default family, otherwise the metered limit id (`codex_other`, …). */
  readonly limitId: string
  readonly primary?: CodexWindow
  readonly secondary?: CodexWindow
  readonly credits?: { readonly hasCredits: boolean; readonly unlimited: boolean; readonly balance?: number }
  readonly reachedType?: string
}

const LIMIT_HEADER = /^x-([a-z0-9_-]+)-primary-used-percent$/

/** `codex_other` style id, as codex-rs `normalize_limit_id` (`[R-codex-rl]`). */
function normalizeLimitId(name: string) {
  return name.trim().toLowerCase().replaceAll("-", "_")
}

function codexHeaderWindow(map: Map<string, string>, prefix: string, name: "primary" | "secondary", now: number) {
  const usedPercent = number(map.get(`${prefix}-${name}-used-percent`))
  if (usedPercent === undefined) return undefined
  const windowMinutes = number(map.get(`${prefix}-${name}-window-minutes`))
  const resetSeconds = number(map.get(`${prefix}-${name}-reset-at`))
  // codex-rs drops a window without data (`has_data`: no use, no length, no `reset-at`). The backend sends a plan's
  // missing window that way: used and minutes `0`, `reset-at` empty and `reset-after-seconds: 0` (2026-10-18).
  if (usedPercent === 0 && !windowMinutes && resetSeconds === undefined) return undefined
  const afterSeconds = number(map.get(`${prefix}-${name}-reset-after-seconds`))
  const resetAt =
    resetSeconds !== undefined
      ? resetSeconds * 1000
      : afterSeconds !== undefined
        ? now + afterSeconds * 1000
        : undefined
  return {
    usedPercent: Math.max(0, usedPercent),
    ...(windowMinutes ? { windowMinutes } : {}),
    ...(resetAt === undefined ? {} : { resetAt }),
  }
}

function codexCredits(map: Map<string, string>) {
  const hasCredits = flag(map.get("x-codex-credits-has-credits"))
  const unlimited = flag(map.get("x-codex-credits-unlimited"))
  if (hasCredits === undefined || unlimited === undefined) return undefined
  const balance = number(map.get("x-codex-credits-balance"))
  return { hasCredits, unlimited, ...(balance === undefined ? {} : { balance }) }
}

/** Every codex header family present (`[R-codex-rl]` `parse_all_rate_limits`). */
function codexSnapshots(headers: Hash.HeadersLike, now: number): CodexSnapshot[] {
  const map = table(headers)
  const ids = new Set(["codex"])
  for (const name of map.keys()) {
    const match = LIMIT_HEADER.exec(name)
    if (match) ids.add(normalizeLimitId(match[1]))
  }
  const reachedType = map.get("x-codex-rate-limit-reached-type") || undefined
  return [...ids].flatMap((limitId) => {
    const prefix = `x-${limitId.replaceAll("_", "-")}`
    const primary = codexHeaderWindow(map, prefix, "primary", now)
    const secondary = codexHeaderWindow(map, prefix, "secondary", now)
    const credits = limitId === "codex" ? codexCredits(map) : undefined
    if (!primary && !secondary && !credits) return []
    return [
      {
        limitId,
        ...(primary ? { primary } : {}),
        ...(secondary ? { secondary } : {}),
        ...(credits ? { credits } : {}),
        ...(reachedType && limitId === "codex" ? { reachedType } : {}),
      },
    ]
  })
}

/**
 * Whether `x-codex-rate-limit-reached-type` applies to a window. codex-rs values (`rate_limit_reached`,
 * `workspace_*_usage_limit_reached`, `workspace_*_credits_depleted`) do not name a window, so the window that is
 * full (or the fullest one) carries it; the test fake sends `primary`/`secondary`.
 */
function reachedWindows(snapshot: CodexSnapshot): ReadonlySet<"primary" | "secondary" | "credits"> {
  const type = snapshot.reachedType?.toLowerCase()
  if (!type) return new Set()
  if (type.includes("credits")) return new Set(["credits"])
  if (type === "primary" || type === "secondary") return new Set([type])
  const candidates = (["primary", "secondary"] as const).flatMap((name) => {
    const window = snapshot[name]
    return window ? [{ name, used: window.usedPercent }] : []
  })
  const full = candidates.filter((item) => item.used >= 100)
  if (full.length > 0) return new Set(full.map((item) => item.name))
  const top = candidates.toSorted((a, b) => b.used - a.used)[0]
  return new Set(top ? [top.name] : [])
}

function codexWindows(snapshot: CodexSnapshot, subject: Subject, observation: Observation): Limit.Window[] {
  const reached = reachedWindows(snapshot)
  const base = {
    accountID: subject.accountID,
    providerID: subject.providerID,
    confidence: "live" as const,
    source: observation.source,
    observedAt: observation.observedAt,
  }
  const windows = (["primary", "secondary"] as const).flatMap((name): Limit.Window[] => {
    const window = snapshot[name]
    if (!window) return []
    const status: Limit.Status = reached.has(name) ? "exhausted" : percentStatus(window.usedPercent)
    return [
      {
        ...base,
        id: snapshot.limitId === "codex" ? `codex.${name}` : `codex.${snapshot.limitId}.${name}`,
        scope: "account",
        kind: "rolling_quota",
        label: codexLabel(window.windowMinutes),
        ...(window.windowMinutes === undefined ? {} : { windowMinutes: window.windowMinutes }),
        usedPercent: window.usedPercent,
        ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
        status,
      },
    ]
  })
  const credits = snapshot.credits
  if (!credits) return windows
  // Credits are a separate window; they never clear the plan windows above (02 §7.3 merge rule).
  const creditStatus: Limit.Status = reached.has("credits")
    ? "exhausted"
    : credits.unlimited || (credits.hasCredits && (credits.balance === undefined || credits.balance > 0))
      ? "ok"
      : credits.hasCredits
        ? "exhausted"
        : "unknown"
  return [
    ...windows,
    {
      ...base,
      id: "codex.credits",
      scope: "account",
      kind: "balance",
      label: "크레딧",
      ...(credits.balance === undefined ? {} : { remaining: credits.balance }),
      unit: "credits",
      status: creditStatus,
    },
  ]
}

/** `x-codex-*` (and `x-<limit_id>-*`) response headers → windows. `[]` when none is present. */
export function codexHeaders(headers: Hash.HeadersLike, subject: Subject, observation: Observation): Limit.Window[] {
  return codexSnapshots(headers, observation.observedAt).flatMap((snapshot) =>
    codexWindows(snapshot, subject, observation),
  )
}

/** Header value of `x-codex-rate-limit-reached-type`, if any. */
export function codexReachedType(headers: Hash.HeadersLike) {
  return table(headers).get("x-codex-rate-limit-reached-type") || undefined
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function finite(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") return number(value.trim())
  return undefined
}

function frameWindow(value: unknown): CodexWindow | undefined {
  const window = record(value)
  const usedPercent = finite(window?.used_percent)
  if (!window || usedPercent === undefined) return undefined
  const windowMinutes = finite(window.window_minutes)
  const resetAt = finite(window.reset_at)
  return {
    usedPercent: Math.max(0, usedPercent),
    ...(windowMinutes ? { windowMinutes } : {}),
    ...(resetAt === undefined ? {} : { resetAt: resetAt * 1000 }),
  }
}

/**
 * A parsed WebSocket frame → windows (02 §7.1): `codex.rate_limits` (`rate_limits.primary/secondary`, `credits`,
 * `metered_limit_name`), and `error` frames that carry a `headers` object with `x-codex-*` values (codex-rs
 * `parse_wrapped_websocket_error_event`). Anything else yields `[]`.
 */
export function codexFrame(frame: unknown, subject: Subject, observation: Observation): Limit.Window[] {
  const json = record(frame)
  if (!json) return []
  if (json.type === "error") {
    const headers = record(json.headers)
    if (!headers) return []
    const pairs = Object.entries(headers).flatMap((entry): Array<[string, string]> => {
      const value = entry[1]
      return typeof value === "string" || typeof value === "number" ? [[entry[0], String(value)]] : []
    })
    return codexHeaders(pairs, subject, { ...observation, source: "error" })
  }
  if (json.type !== "codex.rate_limits") return []
  const limits = record(json.rate_limits)
  const primary = frameWindow(limits?.primary)
  const secondary = frameWindow(limits?.secondary)
  const credits = jsonCredits(json.credits)
  const named = [json.metered_limit_name, json.limit_name].find((value) => typeof value === "string" && value !== "")
  const limitId = typeof named === "string" ? normalizeLimitId(named) : "codex"
  return codexWindows(
    {
      limitId,
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(credits ? { credits } : {}),
    },
    subject,
    observation,
  )
}

/**
 * `GET <chatgpt>/wham/usage` (what Codex CLI's `/status` reads, codex-rs `backend-client`
 * `rate_limit_snapshots_from_payload`) → the windows the headers and frames give: `rate_limit.primary_window` and
 * `secondary_window` (`used_percent`, `limit_window_seconds`, `reset_at` in epoch seconds), `credits`, the reached
 * type (`rate_limit_reached_type.type`), and each `additional_rate_limits[]` entry under its `metered_feature`.
 * Anything else yields `[]`.
 */
export function codexUsage(json: unknown, subject: Subject, observation: Observation): Limit.Window[] {
  const body = record(json)
  if (!body) return []
  const reached = record(body.rate_limit_reached_type)?.type
  const credits = jsonCredits(body.credits)
  const additional = Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []
  const families = [
    { limitId: "codex", limit: record(body.rate_limit) },
    ...additional.flatMap((item) => {
      const entry = record(item)
      const feature = entry?.metered_feature
      return typeof feature === "string" && feature !== ""
        ? [{ limitId: normalizeLimitId(feature), limit: record(entry?.rate_limit) }]
        : []
    }),
  ]
  return families.flatMap((family) => {
    const primary = usageWindow(family.limit?.primary_window)
    const secondary = usageWindow(family.limit?.secondary_window)
    const own = family.limitId === "codex"
    return codexWindows(
      {
        limitId: family.limitId,
        ...(primary ? { primary } : {}),
        ...(secondary ? { secondary } : {}),
        ...(own && credits ? { credits } : {}),
        ...(own && typeof reached === "string" && reached !== "" ? { reachedType: reached } : {}),
      },
      subject,
      observation,
    )
  })
}

/** One `wham/usage` window; the length comes in seconds and is rounded up to minutes, as codex-rs does. */
function usageWindow(value: unknown): CodexWindow | undefined {
  const window = record(value)
  const usedPercent = finite(window?.used_percent)
  if (!window || usedPercent === undefined) return undefined
  const seconds = finite(window.limit_window_seconds)
  const windowMinutes = seconds !== undefined && seconds > 0 ? Math.ceil(seconds / 60) : undefined
  const resetAt = finite(window.reset_at)
  if (usedPercent === 0 && windowMinutes === undefined && resetAt === undefined) return undefined
  return {
    usedPercent: Math.max(0, usedPercent),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetAt === undefined ? {} : { resetAt: resetAt * 1000 }),
  }
}

/** A `credits` object of a frame or the usage answer: both flags are needed, the balance is a decimal string. */
function jsonCredits(value: unknown): CodexSnapshot["credits"] {
  const credits = record(value)
  if (!credits || typeof credits.has_credits !== "boolean" || typeof credits.unlimited !== "boolean") return undefined
  const balance = finite(credits.balance)
  return {
    hasCredits: credits.has_credits,
    unlimited: credits.unlimited,
    ...(balance === undefined ? {} : { balance }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rate windows (`anthropic-ratelimit-*`, `x-ratelimit-*`)

interface RateSpec {
  readonly id: string
  readonly label: string
  readonly unit: Limit.Unit
  readonly limit: string
  readonly remaining: string
  readonly reset: string
}

function rateWindow(
  map: Map<string, string>,
  spec: RateSpec,
  resetOf: (value: string) => number | undefined,
  subject: Subject,
  observation: Observation,
): Limit.Window[] {
  const limit = number(map.get(spec.limit))
  const remaining = number(map.get(spec.remaining))
  if (limit === undefined || remaining === undefined || limit <= 0) return []
  const usedPercent = Math.min(100, Math.max(0, 100 * (1 - remaining / limit)))
  const reset = map.get(spec.reset)
  const resetAt = reset === undefined ? undefined : resetOf(reset)
  return [
    {
      id: spec.id,
      accountID: subject.accountID,
      providerID: subject.providerID,
      scope: "quota_domain",
      kind: "rate",
      label: spec.label,
      windowMinutes: 1,
      usedPercent: Math.round(usedPercent * 100) / 100,
      remaining,
      limit,
      unit: spec.unit,
      ...(resetAt === undefined ? {} : { resetAt }),
      status: remaining <= 0 ? "exhausted" : percentStatus(usedPercent),
      confidence: "live",
      source: observation.source,
      observedAt: observation.observedAt,
    },
  ]
}

const ANTHROPIC: ReadonlyArray<Omit<RateSpec, "limit" | "remaining" | "reset"> & { readonly name: string }> = [
  { id: "anth.requests", name: "requests", label: "분당 요청", unit: "requests" },
  { id: "anth.input_tokens", name: "input-tokens", label: "분당 입력 토큰", unit: "input_tokens" },
  { id: "anth.output_tokens", name: "output-tokens", label: "분당 출력 토큰", unit: "output_tokens" },
]

/** `anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}` (reset RFC 3339). */
export function anthropicHeaders(
  headers: Hash.HeadersLike,
  subject: Subject,
  observation: Observation,
): Limit.Window[] {
  const map = table(headers)
  return ANTHROPIC.flatMap((spec) =>
    rateWindow(
      map,
      {
        ...spec,
        limit: `anthropic-ratelimit-${spec.name}-limit`,
        remaining: `anthropic-ratelimit-${spec.name}-remaining`,
        reset: `anthropic-ratelimit-${spec.name}-reset`,
      },
      (value) => {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : undefined
      },
      subject,
      observation,
    ),
  )
}

/**
 * OpenAI-style `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`; `reset` is a Go duration (`6m0s`, `20ms`)
 * added to the observation time. Window ids use the account kind: `oai.requests`, `xai.tokens`, …
 */
export function xRateLimit(
  headers: Hash.HeadersLike,
  prefix: string,
  subject: Subject,
  observation: Observation,
): Limit.Window[] {
  const map = table(headers)
  const specs: RateSpec[] = [
    {
      id: `${prefix}.requests`,
      label: "분당 요청",
      unit: "requests",
      limit: "x-ratelimit-limit-requests",
      remaining: "x-ratelimit-remaining-requests",
      reset: "x-ratelimit-reset-requests",
    },
    {
      id: `${prefix}.tokens`,
      label: "분당 토큰",
      unit: "tokens",
      limit: "x-ratelimit-limit-tokens",
      remaining: "x-ratelimit-remaining-tokens",
      reset: "x-ratelimit-reset-tokens",
    },
  ]
  return specs.flatMap((spec) =>
    rateWindow(
      map,
      spec,
      (value) => {
        const ms = durationMs(value)
        return ms === undefined ? undefined : observation.observedAt + ms
      },
      subject,
      observation,
    ),
  )
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/g
const UNIT_MS: Readonly<Record<string, number>> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 1e-6,
}

/** Go-style duration (`1h2m3.5s`, `6m0s`, `20ms`) or plain seconds → milliseconds. */
export function durationMs(value: string) {
  const text = value.trim()
  const seconds = number(text)
  if (seconds !== undefined) return seconds * 1000
  const parts = [...text.matchAll(DURATION_PART)]
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) return undefined
  return parts.reduce((total, part) => total + Number(part[1]) * (UNIT_MS[part[2]] ?? 0), 0)
}

// ---------------------------------------------------------------------------------------------------------------
// Balances

/** Id suffix of the promotional part of a DeepSeek balance (`ds.balance.granted`, `ds.balance.usd.granted`). */
const GRANTED = ".granted"

/**
 * DeepSeek `GET /user/balance` → `ds.balance` (first currency) and `ds.balance.<currency>` for the others, each the
 * `total_balance`. A positive `granted_balance` (promotional credit) adds `<id>.granted` labelled 보너스, so it is
 * never read as topped-up money; the total already contains it and `topped_up_balance`, so neither is added again.
 * Only the total decides `exhausted`: `is_available: false` or a total at or below zero (02 §7.3).
 *
 * `previous` are the account's windows so far: a bonus window the reply no longer carries (spent or expired) comes
 * back at 0, since a window is only ever replaced and would otherwise keep its last amount.
 */
export function deepseekBalance(
  json: unknown,
  subject: Subject,
  observation: Observation,
  previous: ReadonlyArray<Limit.Window> = [],
): Limit.Window[] {
  const body = record(json)
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  const available = body?.is_available
  const windows = infos.flatMap((item, index): Limit.Window[] => {
    const info = record(item)
    const total = finite(info?.total_balance)
    if (!info || total === undefined) return []
    const currency = typeof info.currency === "string" ? info.currency.toUpperCase() : undefined
    const unit: Limit.Unit | undefined = currency === "USD" || currency === "CNY" ? currency : undefined
    const balance: Limit.Window = {
      id: index === 0 ? "ds.balance" : `ds.balance.${(currency ?? String(index)).toLowerCase()}`,
      accountID: subject.accountID,
      providerID: subject.providerID,
      scope: "account",
      kind: "balance",
      label: "잔액",
      remaining: total,
      ...(unit ? { unit } : {}),
      status: available === false || total <= 0 ? "exhausted" : "ok",
      confidence: "live",
      source: observation.source,
      observedAt: observation.observedAt,
    }
    const granted = finite(info.granted_balance)
    if (granted === undefined || granted <= 0) return [balance]
    return [balance, { ...balance, id: `${balance.id}${GRANTED}`, label: "보너스", remaining: granted, status: "ok" }]
  })
  const spent = previous
    .filter((window) => window.id.endsWith(GRANTED) && window.remaining !== 0)
    .filter((window) => !windows.some((next) => next.id === window.id))
    .map(
      (window): Limit.Window => ({
        ...window,
        remaining: 0,
        status: "ok",
        confidence: "live",
        source: observation.source,
        observedAt: observation.observedAt,
      }),
    )
  return [...windows, ...spent]
}

/**
 * Windows carried by an HTTP response of an own slot of `kind` (02 §7.1 table). A `siwc` slot reads the Codex plan
 * header families as well as `x-ratelimit-*`: token sharing spends the ChatGPT plan usage the Codex backend reports in
 * `x-codex-*`. So far real token-sharing answers carried neither (2026-10-10 to 10-22, 02 §7.1, 12장 48); both stay
 * read, so a route that starts sending them shows up at once.
 */
export function fromResponse(
  kind: Kind.Own,
  headers: Hash.HeadersLike,
  subject: Subject,
  observation: Observation,
): Limit.Window[] {
  if (kind === "codex") return codexHeaders(headers, subject, observation)
  if (kind === "siwc")
    return [...codexHeaders(headers, subject, observation), ...xRateLimit(headers, kind, subject, observation)]
  if (kind === "anth") return anthropicHeaders(headers, subject, observation)
  return xRateLimit(headers, kind, subject, observation)
}

/** The window of a Sign in with ChatGPT usage limit that named its own reset ({@link sharingLimit}). */
export const SHARING_LIMIT_ID = "siwc.usage"

/**
 * The error body of a Sign in with ChatGPT usage limit (`subscription_sharing_usage_limit_exceeded`, 02 §3.2c) → a full
 * {@link SHARING_LIMIT_ID} window, when the body says when the limit resets: `resets_at` (epoch s) or
 * `resets_in_seconds`, the names of Codex's `usage_limit_reached` body, under `error` or at the top. No real
 * token-sharing body has been seen with either (12장 48); without one there is no window and no reset is made up (an
 * app-specific cap may apply).
 */
export function sharingLimit(json: unknown, subject: Subject, observation: Observation): Limit.Window[] {
  const body = record(json)
  const error = record(body?.error) ?? body
  const at = finite(error?.resets_at)
  const after = finite(error?.resets_in_seconds)
  const resetAt = at !== undefined ? at * 1000 : after !== undefined ? observation.observedAt + after * 1000 : undefined
  if (resetAt === undefined || resetAt <= observation.observedAt) return []
  return [
    {
      id: SHARING_LIMIT_ID,
      accountID: subject.accountID,
      providerID: subject.providerID,
      scope: "account",
      kind: "rolling_quota",
      label: "사용량 한도",
      usedPercent: 100,
      resetAt,
      status: "exhausted",
      confidence: "live",
      source: observation.source,
      observedAt: observation.observedAt,
    },
  ]
}
