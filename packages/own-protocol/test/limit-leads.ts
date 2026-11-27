// The window every surface leads with (03 §7.2, LV 2026-10-24), the shared fixtures of the one ranking (`LimitRank`):
// own-protocol checks the order, own-accounts the account's state (`accounts.list` `limitsSummary.worst`), own-web
// every surface (src/limits/lead.test.ts, e2e/accounts-limits.spec.ts). They are the cases where surfaces, or the server
// and the screen, used to disagree. `value` is own-web's folded value of the lead.
import type { Limit } from "../src/limit.js"
import { Unified } from "../src/unified.js"

const MIN = 60_000
/** Saturday 2026-10-24 06:26 UTC (15:26 in Seoul). */
export const LEADS_AT = Date.UTC(2026, 9, 24, 6, 26)
const P = "anthropic-ratelimit-unified-"

/** A Claude account's windows from response headers (names without the unified prefix), observed a minute ago. */
export function claude(values: Record<string, string>) {
  return Unified.parse(
    new Headers(Object.fromEntries(Object.entries(values).map(([name, value]) => [`${P}${name}`, value]))),
    LEADS_AT - MIN,
  )
}

/** A unified reset `minutes` from {@link LEADS_AT}, in seconds. */
export const reset = (minutes: number) => String(Math.floor((LEADS_AT + minutes * MIN) / 1000))

/** Another kind's window, observed a minute ago (default: Codex `5시간`). */
export function window(patch: Partial<Limit.Window>): Limit.Window {
  return {
    id: "codex.primary",
    accountID: "acc_a" as Limit.Window["accountID"],
    providerID: "own-codex-abcd" as Limit.Window["providerID"],
    scope: "account",
    kind: "rolling_quota",
    label: "5시간",
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: LEADS_AT - MIN,
    ...patch,
  }
}

/** router-for-me/CLIProxyAPI#5920 (2026-09-17, a 429) as it came: the Fable week ran out, extra usage capped. */
export const ISSUE_5920 = {
  status: "rejected",
  "representative-claim": "seven_day_overage_included",
  "5h-status": "allowed",
  "5h-utilization": "0.23",
  "7d-status": "allowed",
  "7d-utilization": "0.73",
  "7d_oi-status": "rejected",
  "7d_oi-utilization": "1.02",
  "overage-status": "rejected",
  "overage-disabled-reason": "org_spend_cap_reached",
}

/** A refused Opus request: the Opus week (`seven_day_opus`, state and reset only) ran out for 5 days. */
const OPUS_WEEK = {
  status: "rejected",
  reset: reset(5 * 24 * 60),
  "representative-claim": "seven_day_opus",
  "5h-status": "allowed",
  "5h-utilization": "0.12",
  "5h-reset": reset(65),
  "7d-status": "allowed",
  "7d-utilization": "0.44",
  "7d-reset": reset(3 * 24 * 60),
}

export interface Lead {
  readonly name: string
  readonly windows: readonly Limit.Window[]
  /** The surface's model; without one the account-wide windows only (the cards, the dashboard, the server's state). */
  readonly model?: string
  readonly lead: string
  readonly value: string
}

export const LEADS: readonly Lead[] = [
  {
    name: "the week the claim does not name (#12829)",
    windows: claude({
      "5h-utilization": "0.0184",
      "5h-reset": reset(65),
      "7d-utilization": "0.7371",
      "7d-reset": reset(2 * 24 * 60),
      "representative-claim": "five_hour",
    }),
    lead: "claude.7d",
    value: "남음 26%",
  },
  {
    name: "a 5 hours past its threshold at 50 % beside a week at 80 %",
    windows: claude({
      status: "allowed",
      "5h-utilization": "0.5",
      "5h-surpassed-threshold": "0.5",
      "5h-reset": reset(65),
      "7d-utilization": "0.8",
      "7d-reset": reset(3 * 24 * 60),
    }),
    lead: "claude.7d",
    value: "남음 20%",
  },
  {
    name: "an exhausted 5 hours known only by its state",
    windows: claude({ status: "rejected", "5h-status": "rejected", "5h-reset": reset(65), "7d-utilization": "0.4" }),
    lead: "claude.5h",
    value: "차단",
  },
  {
    name: "#5920 without a model: neither the Fable week nor the refused extra usage names the account",
    windows: claude(ISSUE_5920),
    lead: "claude.7d",
    value: "남음 27%",
  },
  {
    name: "#5920 on a GPT session",
    windows: claude(ISSUE_5920),
    model: "gpt-5.5",
    lead: "claude.7d",
    value: "남음 27%",
  },
  {
    name: "#5920 on a Fable session",
    windows: claude(ISSUE_5920),
    model: "claude-fable-5-1",
    lead: "claude.7d_oi",
    value: "남음 0%",
  },
  {
    name: "a used-up Opus week on an Opus session",
    windows: claude(OPUS_WEEK),
    model: "claude-opus-5-5",
    lead: "claude.7d_opus",
    value: "차단",
  },
  {
    name: "the same account on a Sonnet session",
    windows: claude(OPUS_WEEK),
    model: "claude-sonnet-4-5",
    lead: "claude.7d",
    value: "남음 56%",
  },
  {
    name: "a DeepSeek balance before a roomy budget",
    windows: [
      window({
        id: "api.budget_month",
        kind: "budget",
        label: "이번 달 예산",
        usedPercent: 0,
        remaining: 5,
        limit: 5,
        unit: "USD",
      }),
      window({ id: "ds.balance", kind: "balance", label: "잔액", remaining: 7.42, unit: "USD" }),
    ],
    lead: "ds.balance",
    value: "$7.42",
  },
  {
    name: "a spent DeepSeek balance before a tight budget",
    windows: [
      window({
        id: "api.budget_month",
        kind: "budget",
        label: "이번 달 예산",
        usedPercent: 80,
        remaining: 1,
        limit: 5,
        unit: "USD",
      }),
      window({ id: "ds.balance", kind: "balance", label: "잔액", remaining: 0, unit: "USD", status: "exhausted" }),
    ],
    lead: "ds.balance",
    value: "$0.00",
  },
  {
    name: "Codex with a nearly spent per-minute window",
    windows: [
      window({ usedPercent: 84, status: "warning" }),
      window({ id: "codex.secondary", label: "주간", usedPercent: 61 }),
      window({ id: "oai.requests", kind: "rate", label: "분당 요청", usedPercent: 99 }),
    ],
    lead: "codex.primary",
    value: "남음 16%",
  },
]
