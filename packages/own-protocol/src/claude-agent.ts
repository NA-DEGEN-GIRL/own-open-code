export * as ClaudeAgent from "./claude-agent.js"

import { Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import type { Account } from "./account.js"
import type { Limit } from "./limit.js"
import { Unified } from "./unified.js"

/**
 * The Claude Agent route (02 §8.10, CAG 2026-10-31): Claude Code itself, run by upstream's built-in provider through the
 * Agent SDK, logged in by the user in a folder own made. This file holds what the route's parts share: the provider
 * id, and how Claude Code's own limit reports become own's limit windows (P-039, 02 §8.10.4).
 */

/** Upstream's built-in provider (`packages/core/src/plugin/provider/claude-agent`, `Provider.ID.claudeAgent`). */
export const PROVIDER_ID = Provider.ID.make("claude-agent")

/** The external connect method upstream registers; own makes the connection itself once the account is set up. */
export const METHOD_ID = "claude-login"

/** The default own harness of a session on this provider (10 §3.13): core's request with Claude Code's own prompt. */
export const HARNESS = "claude-code"

/** The default cap on live claude processes of a service, and its bounds (02 §8.10.12, core P-044). */
export const PROCESSES = 8
export const Processes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })).annotate({
  identifier: "Own.ClaudeAgent.Processes",
})
/** Spare processes per account for new conversations: off by default (02 §8.10.12). */
export const Spares = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })).annotate({
  identifier: "Own.ClaudeAgent.Spares",
})

/**
 * The process pool of the service (02 §8.10.12): live claude processes (`live`), the cap, how many started over it so
 * a parked parent's subagent could run (`over`), the spares setting, and the conversations waiting for a slot.
 */
export interface Pool extends Schema.Schema.Type<typeof Pool> {}
export const Pool = Schema.Struct({
  live: Schema.Int,
  cap: Schema.Int,
  over: Schema.Int,
  spares: Schema.Int,
  waiting: Schema.Array(Schema.Struct({ sessionID: Schema.optional(Schema.String), since: Schema.Number })),
}).annotate({ identifier: "Own.ClaudeAgent.Pool" })

/** What Claude Code's stream says of plan limits (`rate_limit_event.rate_limit_info`, SDK `SDKRateLimitInfo`). */
export interface RateLimitInfo {
  readonly status?: string
  readonly resetsAt?: number
  readonly rateLimitType?: string
  /** A fraction (0.05 = 5 %), as in the unified headers. */
  readonly utilization?: number
  readonly overageStatus?: string
  readonly overageResetsAt?: number
  readonly overageDisabledReason?: string
  readonly isUsingOverage?: boolean
  readonly overageInUse?: boolean
  readonly surpassedThreshold?: number
  /** Not in the SDK's type, but in its recordings: the account-wide windows of the same response. */
  readonly unifiedWindows?: Readonly<Record<string, { readonly utilization?: number; readonly resetsAt?: number }>>
}

/** What a usage question answers (SDK `SDKControlGetUsageResponse`, experimental), as far as own reads it. */
export interface UsageAnswer {
  readonly subscription_type?: string | null
  readonly rate_limits_available?: boolean
  readonly rate_limits?: {
    readonly five_hour?: UsageWindow | null
    readonly seven_day?: UsageWindow | null
    readonly seven_day_oauth_apps?: UsageWindow | null
    readonly seven_day_opus?: UsageWindow | null
    readonly seven_day_sonnet?: UsageWindow | null
    readonly model_scoped?: ReadonlyArray<UsageWindow & { readonly display_name: string }>
    readonly extra_usage?: {
      readonly is_enabled: boolean
      readonly utilization: number | null
    } | null
  } | null
}

/** One window of a usage answer: `utilization` 0–100, `resets_at` ISO. */
export interface UsageWindow {
  readonly utilization: number | null
  readonly resets_at: string | null
}

/** Claude Code's window names (`rateLimitType`, usage keys) and own's window ids (02 §7.3). */
const WINDOWS: Readonly<Record<string, { readonly id: string; readonly label: string; readonly minutes: number }>> = {
  five_hour: { id: "claude.5h", label: "5시간", minutes: 300 },
  seven_day: { id: "claude.7d", label: "주간", minutes: 10_080 },
  seven_day_overage_included: { id: "claude.7d_oi", label: "주간 · Fable", minutes: 10_080 },
  seven_day_opus: { id: "claude.7d_opus", label: "주간 · Opus", minutes: 10_080 },
  seven_day_sonnet: { id: "claude.7d_sonnet", label: "주간 · Sonnet", minutes: 10_080 },
  // Usage through OAuth apps such as this one, counted on its own (⚠ how it caps a Claude Agent account is unknown).
  seven_day_oauth_apps: { id: "claude.7d_apps", label: "주간 · 외부 앱", minutes: 10_080 },
}

/** `model_scoped` display names and the model weekly window each is. */
const MODEL_SCOPED: Readonly<Record<string, string>> = {
  fable: "seven_day_overage_included",
  opus: "seven_day_opus",
  sonnet: "seven_day_sonnet",
}

/**
 * One `rate_limit_event` as own's windows for the Claude Agent account (02 §8.10.4): the window it names
 * (`rateLimitType`) with its status, reset and use; every `unifiedWindows` entry with its use and reset; and, when the
 * event speaks of extra usage, `claude.overage` with how the account is billed (02 §8.9). `usedPercent = utilization ×
 * 100`, `resetAt = resetsAt × 1000`, source `header` (Claude Code read them from the response headers), confidence
 * `live`. Empty when the event names nothing.
 */
export function fromRateLimit(info: RateLimitInfo, observedAt: number, accountID: Account.ID): Limit.Window[] {
  const base = {
    accountID,
    providerID: PROVIDER_ID,
    scope: "account" as const,
    confidence: "live" as const,
    observedAt,
  }
  const named = info.rateLimitType === undefined ? undefined : WINDOWS[info.rateLimitType]
  const unified = Object.entries(info.unifiedWindows ?? {}).flatMap(([name, value]): Limit.Window[] => {
    const spec = WINDOWS[name]
    if (!spec || spec.id === named?.id) return []
    const usedPercent = percent(value.utilization)
    return [
      {
        ...base,
        source: "header",
        id: spec.id,
        kind: "rolling_quota",
        label: spec.label,
        windowMinutes: spec.minutes,
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(value.resetsAt === undefined ? {} : { resetAt: value.resetsAt * 1000 }),
        status: Unified.statusOf(undefined, usedPercent),
      },
    ]
  })
  const own = named ? info.unifiedWindows?.[info.rateLimitType ?? ""] : undefined
  const usedPercent = percent(info.utilization ?? own?.utilization)
  const resetsAt = info.resetsAt ?? own?.resetsAt
  const window: Limit.Window[] = named
    ? [
        {
          ...base,
          source: "header",
          id: named.id,
          kind: "rolling_quota",
          label: named.label,
          windowMinutes: named.minutes,
          ...(usedPercent === undefined ? {} : { usedPercent }),
          ...(resetsAt === undefined ? {} : { resetAt: resetsAt * 1000 }),
          status: Unified.statusOf(info.status, usedPercent, info.surpassedThreshold !== undefined),
        },
      ]
    : []
  if (info.overageStatus === undefined && info.rateLimitType !== "overage") return [...window, ...unified]
  const billed =
    info.isUsingOverage || info.overageInUse
      ? "extra_usage"
      : Unified.billing(info.status, info.overageStatus, undefined)
  const meta = {
    ...(billed === undefined ? {} : { billing: billed }),
    ...(info.overageDisabledReason === undefined ? {} : { disabledReason: info.overageDisabledReason }),
  }
  const overage: Limit.Window = {
    ...base,
    source: "header",
    id: "claude.overage",
    kind: "spend_cap",
    label: "추가 사용량",
    ...(info.overageResetsAt === undefined ? {} : { resetAt: info.overageResetsAt * 1000 }),
    status: Unified.statusOf(info.overageStatus, undefined),
    ...(Object.keys(meta).length === 0 ? {} : { meta }),
  }
  return [...window.filter((item) => item.id !== "claude.overage"), ...unified, overage]
}

/**
 * A usage answer as own's windows (02 §8.10.4): `five_hour`, `seven_day`, the model weeks (`seven_day_opus`,
 * `seven_day_sonnet`, `model_scoped` Fable/Opus/Sonnet), `seven_day_oauth_apps`, and extra usage when it is on, source
 * `poll`. `utilization` is already a percent here. Empty when the plan's limits are not available (an API key).
 */
export function fromUsage(answer: UsageAnswer, observedAt: number, accountID: Account.ID): Limit.Window[] {
  const limits = answer.rate_limits
  if (!limits || answer.rate_limits_available === false) return []
  const base = {
    accountID,
    providerID: PROVIDER_ID,
    scope: "account" as const,
    confidence: "live" as const,
    source: "poll" as const,
    observedAt,
  }
  const scoped = (limits.model_scoped ?? []).flatMap((item) => {
    const name = MODEL_SCOPED[item.display_name.toLowerCase()]
    return name === undefined ? [] : [[name, item] as const]
  })
  const named = [
    ["five_hour", limits.five_hour],
    ["seven_day", limits.seven_day],
    ["seven_day_opus", limits.seven_day_opus],
    ["seven_day_sonnet", limits.seven_day_sonnet],
    ["seven_day_oauth_apps", limits.seven_day_oauth_apps],
    ...scoped,
  ] as const
  const windows = named.flatMap(([name, value]): Limit.Window[] => {
    const spec = WINDOWS[name]
    if (!spec || !value) return []
    const usedPercent = value.utilization === null ? undefined : round(Math.max(0, value.utilization))
    const resetAt = value.resets_at === null ? undefined : Date.parse(value.resets_at)
    return [
      {
        ...base,
        id: spec.id,
        kind: "rolling_quota",
        label: spec.label,
        windowMinutes: spec.minutes,
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetAt === undefined || Number.isNaN(resetAt) ? {} : { resetAt }),
        status: Unified.statusOf(undefined, usedPercent),
      },
    ]
  })
  const unique = windows.filter((item, index) => windows.findIndex((other) => other.id === item.id) === index)
  const extra = limits.extra_usage
  if (!extra?.is_enabled) return unique
  const used = extra.utilization === null ? undefined : round(Math.max(0, extra.utilization))
  return [
    ...unique,
    {
      ...base,
      id: "claude.overage",
      kind: "spend_cap",
      label: "추가 사용량",
      ...(used === undefined ? {} : { usedPercent: used }),
      status: Unified.statusOf(undefined, used),
    },
  ]
}

/**
 * Whether a usage answer says the account has no five-hour window (02 §8.10.4, N5H 2026-11-03): its plan limits are
 * available and carry `seven_day` but no `five_hour` (absent, as Claude Code's own status line reads it, or `null`).
 * A `rate_limit_event` names one window only, so its silence about the five hours says nothing.
 */
export function withoutFiveHour(answer: UsageAnswer) {
  const limits = answer.rate_limits
  return answer.rate_limits_available !== false && !!limits?.seven_day && !limits.five_hour
}

function percent(fraction: number | undefined) {
  return fraction === undefined ? undefined : round(Math.max(0, fraction * 100))
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

// ---------------------------------------------------------------------------------------------------------------
// The SSH-host relay (02 §8.10.13, core P-052)

/**
 * The account folder a host's provider names (`settings.configDir`, the provider option `configDir`): never a path on
 * either side; the PC maps it to the account's folder (core `ClaudeRelay.TOKEN_PREFIX`, a test keeps them equal).
 */
export const RELAY_PREFIX = "relay:"

export function relayToken(accountID: string) {
  return `${RELAY_PREFIX}${accountID}`
}

export function relayAccount(configDir: string | undefined) {
  return configDir?.startsWith(RELAY_PREFIX) ? configDir.slice(RELAY_PREFIX.length) : undefined
}

/** One relayed stream (core `ClaudeRelay.Stream` / `Hosted`), read by shape on the observer channel. */
export interface HostStream {
  start(spawn: { readonly args: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> }): void
  write(data: string): void
  end(): void
  close(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (code: number | null, error?: string) => void): void
}

export type HostOp = "exists" | "fork" | "remove" | "chain" | "write" | "list" | "discard" | "version"

/** The PC provider's server for hosts (core `ClaudeRelay.Server`, the channel's `hosts`). */
export interface HostServer {
  open(
    input: {
      readonly configDir: string
      readonly directory: string
      readonly member: { readonly sessionID?: string; readonly parentID?: string; readonly side: boolean }
    },
    signal?: AbortSignal,
  ): Promise<HostStream>
  callStream(input: { readonly configDir: string; readonly directory: string; readonly root: string }, op: HostOp): HostStream
}

/** What own-accounts gives a host's provider (core `ClaudeRelay.Transport`, the channel's `relay`). */
export interface HostTransport {
  open(
    input: {
      readonly kind: "process" | "call"
      readonly configDir: string
      readonly directory: string
      readonly member?: { readonly sessionID?: string; readonly parentID?: string; readonly side: boolean }
      readonly op?: HostOp
    },
    signal?: AbortSignal,
  ): Promise<HostStream>
}
