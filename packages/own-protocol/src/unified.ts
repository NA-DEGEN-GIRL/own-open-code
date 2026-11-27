export * as Unified from "./unified.js"

import { Provider } from "@opencode/schema/provider"
import { Account } from "./account.js"
import type { Limit } from "./limit.js"

/**
 * Pure parser of the Claude subscription limit headers, shared by own-telemetry (the local observer) and the
 * own-accounts egress relay, which observes remote hosts' requests on this PC (04 §8.11.10).
 */

/** Header prefix of the subscription limits Anthropic sends on every `anthropic` response (02 §7.1, §8.5). */
export const PREFIX = "anthropic-ratelimit-unified-"

/** The five-hour window, which verified Ultra accounts no longer have ({@link withoutFiveHour}, 02 §7.1.2). */
export const FIVE_HOUR = "claude.5h"

/** Used percent from which a window without its own status header shows `warning`. */
export const WARNING_PERCENT = 85

/**
 * The window families with their own `{name}-{utilization, reset, status, surpassed-threshold}` headers, as Claude Code
 * reads them (its `[five_hour, 5h], [seven_day, 7d], [seven_day_overage_included, 7d_oi]` table). `7d_oi` is Claude
 * Code's "Fable limit", a per-model weekly bucket that only some accounts' responses carry.
 */
const WINDOWS = [
  { name: "5h", id: FIVE_HOUR, label: "5시간", minutes: 300 },
  { name: "7d", id: "claude.7d", label: "주간", minutes: 10_080 },
  { name: "7d_oi", id: "claude.7d_oi", label: "주간 · Fable", minutes: 10_080 },
] as const

/**
 * Model weekly windows without a header family: a response names one only as its `representative-claim`, and then the
 * top-level `status` and `reset` describe it (Claude Code's `rateLimitType` `seven_day_opus`, `seven_day_sonnet`), so
 * the window has a status and a reset but no percent.
 */
const CLAIMED = [
  { claim: "seven_day_opus", id: "claude.7d_opus", label: "주간 · Opus" },
  { claim: "seven_day_sonnet", id: "claude.7d_sonnet", label: "주간 · Sonnet" },
] as const

/**
 * Parses `anthropic-ratelimit-unified-{status, reset, representative-claim, 5h-*, 7d-*, 7d_oi-*, overage-status,
 * overage-utilization, overage-reset, overage-surpassed-threshold, overage-in-use, overage-disabled-reason}` (each
 * family `utilization`, `reset`, `status`, `surpassed-threshold`) into `claude.5h`, `claude.7d`, `claude.7d_oi`, a
 * claimed model weekly window ({@link CLAIMED}) and `claude.overage` for `accountID` (the Claude account the request
 * was signed with, 02 §8.5; default `acc_claude_slot`, the slot's own account), source `header`, confidence `live`
 * (02 §7.3 "claude unified"): `usedPercent = utilization × 100`, `resetAt = reset × 1000`, `allowed → ok`,
 * `allowed_warning` or a `surpassed-threshold` → `warning`, `rejected → exhausted`, `representative-claim →
 * meta.representative`; the overage window also carries {@link billing} and the raw `overage-disabled-reason`
 * (02 §8.9). Returns `[]` when no unified header is present. `source` is `error` for a status ≥ 400 response.
 */
export function parse(
  headers: Headers,
  observedAt: number,
  source: Limit.Source = "header",
  accountID: Account.ID = Account.ID.claudeSlot,
): Limit.Window[] {
  const get = (name: string) => headers.get(`${PREFIX}${name}`)?.trim() || undefined
  const representative = get("representative-claim")
  const base = {
    accountID,
    providerID: Provider.ID.anthropic,
    scope: "account" as const,
    confidence: "live" as const,
    source,
    observedAt,
    ...(representative === undefined ? {} : { meta: { representative } }),
  }
  const families = WINDOWS.flatMap((spec): Limit.Window[] => {
    const utilization = number(get(`${spec.name}-utilization`))
    const reset = number(get(`${spec.name}-reset`))
    const statusHeader = get(`${spec.name}-status`)
    const surpassed = number(get(`${spec.name}-surpassed-threshold`)) !== undefined
    if (utilization === undefined && reset === undefined && statusHeader === undefined && !surpassed) return []
    const usedPercent = utilization === undefined ? undefined : round(Math.max(0, utilization * 100))
    return [
      {
        ...base,
        id: spec.id,
        kind: "rolling_quota",
        label: spec.label,
        windowMinutes: spec.minutes,
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(reset === undefined ? {} : { resetAt: reset * 1000 }),
        status: statusOf(statusHeader, usedPercent, surpassed),
      },
    ]
  })
  const claimed = CLAIMED.find((item) => item.claim === representative)
  const topReset = number(get("reset"))
  const windows: Limit.Window[] = claimed
    ? [
        ...families,
        {
          ...base,
          id: claimed.id,
          kind: "rolling_quota",
          label: claimed.label,
          windowMinutes: 10_080,
          ...(topReset === undefined ? {} : { resetAt: topReset * 1000 }),
          status: statusOf(get("status"), undefined),
        },
      ]
    : families
  const overage = get("overage-status")
  if (overage === undefined) return windows
  const overageUtilization = number(get("overage-utilization"))
  const overageReset = number(get("overage-reset"))
  const billed = billing(get("status"), overage, get("overage-in-use"))
  const disabledReason = get("overage-disabled-reason")
  const meta = {
    ...base.meta,
    ...(billed === undefined ? {} : { billing: billed }),
    ...(disabledReason === undefined ? {} : { disabledReason }),
  }
  return [
    ...windows,
    {
      ...base,
      id: "claude.overage",
      kind: "spend_cap",
      label: "추가 사용량",
      ...(overageUtilization === undefined ? {} : { usedPercent: round(Math.max(0, overageUtilization * 100)) }),
      ...(overageReset === undefined ? {} : { resetAt: overageReset * 1000 }),
      status: statusOf(overage, undefined, number(get("overage-surpassed-threshold")) !== undefined),
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    },
  ]
}

/**
 * How a response's headers say the account is billed (02 §8.9, CW 2026-10-19), or `undefined` when they do not say.
 * `extra_usage` is Claude Code's own reading (its `claudeAiLimits.ts` `isUsingOverage`): the plan refused the request
 * (`status: rejected`) and extra usage took it (`overage-status` `allowed` or `allowed_warning`); newer Claude Code also
 * reads `overage-in-use: true`. `rejected`: both refused it, so extra usage is off, used up or capped (the reason is in
 * `overage-disabled-reason`). Anthropic documents none of these headers and no marker of a third-party request billed
 * to extra usage.
 */
export function billing(
  status: string | undefined,
  overage: string | undefined,
  inUse: string | undefined,
): "extra_usage" | "rejected" | undefined {
  if (inUse === "true") return "extra_usage"
  if (status !== "rejected") return undefined
  if (overage === "allowed" || overage === "allowed_warning") return "extra_usage"
  return overage === "rejected" ? "rejected" : undefined
}

/**
 * The windows of an error response whose body says Anthropic refused it for extra usage (`ExtraUsage.detect`, 02 §8.9):
 * its `claude.overage` window says `billing: "rejected"`; a response without overage headers gets one (status
 * `exhausted`, source `error`).
 */
export function refused(
  windows: ReadonlyArray<Limit.Window>,
  observedAt: number,
  accountID: Account.ID = Account.ID.claudeSlot,
): Limit.Window[] {
  const overage: Limit.Window = windows.find((window) => window.id === "claude.overage") ?? {
    id: "claude.overage",
    accountID,
    providerID: Provider.ID.anthropic,
    scope: "account",
    kind: "spend_cap",
    label: "추가 사용량",
    status: "exhausted",
    confidence: "live",
    source: "error",
    observedAt,
  }
  return [
    ...windows.filter((window) => window.id !== "claude.overage"),
    { ...overage, meta: { ...overage.meta, billing: "rejected" } },
  ]
}

/**
 * Whether a response says its account has no five-hour window (02 §7.1.2, N5H 2026-11-03: Anthropic removed it for
 * verified Ultra accounts; their responses keep only the weekly windows). Only a successful response (`status` < 400)
 * that carries the weekly family (`7d-*`) and no header of the five-hour family, and whose `representative-claim` is
 * not `five_hour`, says so: an error response, or one without unified headers at all (an API key, a proxy that strips
 * them), says nothing. The caller then forgets the account's `claude.5h`; a later response that carries it brings it
 * back.
 */
export function withoutFiveHour(headers: Headers, status: number) {
  if (status >= 400) return false
  const has = (family: string) =>
    ["utilization", "reset", "status", "surpassed-threshold"].some(
      (field) => (headers.get(`${PREFIX}${family}-${field}`)?.trim() ?? "") !== "",
    )
  return has("7d") && !has("5h") && headers.get(`${PREFIX}representative-claim`)?.trim() !== "five_hour"
}

/** The last unified `status` (e.g. `allowed`, `allowed_warning`, `rejected`), for the retry decision (02 §8.8). */
export function status(headers: Headers) {
  return headers.get(`${PREFIX}status`) ?? undefined
}

/** `representative-claim` values and the window family each names (Claude Code's `rateLimitType`). */
const CLAIMS: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d_oi",
  seven_day_opus: "7d_opus",
  seven_day_sonnet: "7d_sonnet",
}

/** The limit that refused a request ({@link rejected}). */
export interface Rejection {
  /** `claude.5h`, `claude.7d`, a model weekly bucket (`claude.7d_oi`, `claude.7d_opus`, `claude.7d_sonnet`), or `null`. */
  readonly windowId: string | null
  /** `5h_rejected`, `7d_rejected`, `7d_oi_rejected`, `7d_opus_rejected`, `7d_sonnet_rejected` or `rejected`. */
  readonly reason: string
  /** The named window's reset, when the headers give one. */
  readonly resetAt?: number
}

/**
 * Which limit refused a request (02 §8.8, LV 2026-10-24), the one reading of the exhaustion record (own-telemetry) and
 * the Claude auto-switch trigger (own-accounts): a family's own `-status: rejected` (`5h`, `7d`, then `7d_oi`, so an
 * account-wide window, which holds back every model, comes first), else, when the overall `status` is `rejected`, the
 * window its `representative-claim` names (`seven_day_overage_included` is the Fable week `claude.7d_oi`;
 * `seven_day_opus` and `seven_day_sonnet` have no header family and use the top-level `reset`), else none (`windowId:
 * null`, the account). A model bucket holds back only its own model family (`LimitModel`). `undefined` when nothing
 * was refused.
 */
export function rejected(headers: Headers): Rejection | undefined {
  const get = (name: string) => headers.get(`${PREFIX}${name}`)?.trim() || undefined
  const reset = (name: string) => {
    const value = number(get(name))
    return value !== undefined && value > 0 ? value * 1000 : undefined
  }
  const family = WINDOWS.find((spec) => get(`${spec.name}-status`) === "rejected")
  if (family) return named(family.name, reset(`${family.name}-reset`))
  if (get("status") !== "rejected") return undefined
  const claimed = CLAIMS[get("representative-claim") ?? ""]
  if (claimed === undefined) return { windowId: null, reason: "rejected" }
  return named(claimed, reset(`${claimed}-reset`) ?? reset("reset"))
}

function named(name: string, resetAt: number | undefined): Rejection {
  return { windowId: `claude.${name}`, reason: `${name}_rejected`, ...(resetAt === undefined ? {} : { resetAt }) }
}

/**
 * `rejected → exhausted`, `allowed_warning → warning`, `allowed → ok`; otherwise from the used percent. A
 * `surpassed-threshold` header (`surpassed`) makes an allowed or unrated window a warning, as Claude Code reads it.
 */
export function statusOf(value: string | undefined, usedPercent: number | undefined, surpassed = false): Limit.Status {
  if (value === "rejected") return "exhausted"
  if (value === "allowed_warning") return "warning"
  if (value === "allowed") return surpassed ? "warning" : "ok"
  if (usedPercent !== undefined && usedPercent >= 100) return "exhausted"
  if (surpassed || (usedPercent !== undefined && usedPercent >= WARNING_PERCENT)) return "warning"
  return usedPercent === undefined ? "unknown" : "ok"
}

function number(value: string | undefined) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
