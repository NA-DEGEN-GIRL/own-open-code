// How a Claude subscription response says the account is billed (02 §8.9, CW 2026-10-19): the unified headers' verdict
// (`Unified.parse`, shared by own-telemetry and the egress relay that observes SSH hosts' requests) and the error
// bodies of an extra-usage refusal (`ExtraUsage.detect`). Fixtures are the shapes Claude Code reads
// (`claudeAiLimits.ts` of the 2026-03-31 source, `isUsingOverage`) and the header dumps and error bodies users posted;
// Anthropic documents none of them. No request goes anywhere.
import { describe, expect, test } from "bun:test"
import { Provider } from "@opencode/schema/provider"
import { Account, ExtraUsage, Unified } from "@own/protocol"

const NOW = Date.UTC(2026, 9, 19, 3, 0, 0)
const TWO = Account.ID.make("acc_01J9CLAUDETWO0000000000000")
const P = "anthropic-ratelimit-unified-"

const headers = (values: Record<string, string>) =>
  new Headers(Object.fromEntries(Object.entries(values).map(([name, value]) => [`${P}${name}`, value])))
const overageOf = (values: Record<string, string>, accountID?: Account.ID) =>
  Unified.parse(headers(values), NOW, "header", accountID).find((window) => window.id === "claude.overage")
const body = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } })

describe("the unified headers' verdict", () => {
  test("on the plan: no verdict (anthropics/claude-code#12829, 2025-12-01, no overage-status header at all)", () => {
    const windows = Unified.parse(
      headers({
        status: "allowed",
        "5h-status": "allowed",
        "5h-reset": "1764554400",
        "5h-utilization": "0.018416969696969696",
        "7d-status": "allowed",
        "7d-reset": "1764615600",
        "7d-utilization": "0.7370692663445869",
        "representative-claim": "five_hour",
        "fallback-percentage": "0.2",
        reset: "1764554400",
        "overage-disabled-reason": "org_level_disabled",
      }),
      NOW,
    )
    expect(windows.map((window) => window.id)).toEqual(["claude.5h", "claude.7d"])
    expect(windows.every((window) => window.meta?.billing === undefined)).toBe(true)
    // With an overage status but the plan allowing: still no verdict, and the reason is kept raw.
    expect(
      overageOf({ status: "allowed", "overage-status": "rejected", "overage-disabled-reason": "org_level_disabled" }),
    ).toMatchObject({ status: "exhausted", meta: { disabledReason: "org_level_disabled" } })
    expect(overageOf({ status: "allowed", "overage-status": "rejected" })?.meta).toBeUndefined()
  })

  test("the plan refused it and extra usage took it: billed as extra usage (Claude Code's `isUsingOverage`)", () => {
    for (const overage of ["allowed", "allowed_warning"])
      expect(
        overageOf(
          {
            status: "rejected",
            "5h-status": "rejected",
            "5h-utilization": "1.0",
            "representative-claim": "five_hour",
            "overage-status": overage,
            "overage-reset": "1793491200",
          },
          TWO,
        ),
      ).toMatchObject({
        accountID: TWO,
        status: overage === "allowed" ? "ok" : "warning",
        resetAt: 1793491200 * 1000,
        meta: { representative: "five_hour", billing: "extra_usage" },
      })
  })

  test("`overage-in-use: true` (newer Claude Code) is billed as extra usage too", () => {
    expect(
      overageOf({
        status: "allowed",
        "representative-claim": "overage",
        "overage-status": "allowed",
        "overage-in-use": "true",
      })?.meta?.billing,
    ).toBe("extra_usage")
    expect(
      overageOf({ status: "allowed", "overage-status": "allowed", "overage-in-use": "false" })?.meta?.billing,
    ).toBe(undefined)
  })

  test("both refused it: rejected, with the reason (router-for-me/CLIProxyAPI#5920, 2026-09-17, a 429)", () => {
    expect(
      overageOf({
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
      }),
    ).toMatchObject({
      status: "exhausted",
      meta: {
        representative: "seven_day_overage_included",
        billing: "rejected",
        disabledReason: "org_spend_cap_reached",
      },
    })
    expect(Unified.billing("rejected", undefined, undefined)).toBeUndefined()
    expect(Unified.billing(undefined, "allowed", undefined)).toBeUndefined()
  })
})

describe("an extra-usage refusal in the error body", () => {
  test("the bodies users posted are refusals for extra usage; the January sign-in block and a spend cap are not", () => {
    for (const refusal of [
      // anthropics/claude-code#45134 (2026-04-08), HTTP 400
      body(
        "invalid_request_error",
        "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.",
      ),
      // router-for-me/CLIProxyAPI#6432 (2026-10-07), HTTP 400
      body(
        "invalid_request_error",
        "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.",
      ),
      // NousResearch/hermes-agent#48176 (a Team workspace, 2026-06-18), HTTP 400
      body(
        "invalid_request_error",
        "Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin to add more and keep going.",
      ),
      // claude-code#45134, HTTP 400, also with extra usage off
      body("invalid_request_error", "You're out of extra usage. Add more at claude.ai/settings/usage and keep going."),
      // CLIProxyAPI#5920, HTTP 429 with `overage-disabled-reason: org_level_disabled`
      JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          code: "credits_required",
          message: "Usage credits are required for this model",
        },
      }),
    ])
      expect(ExtraUsage.detect(refusal.slice(0, 2_048))).toBe(true)
    // The safeguard since 2026-01-09 (claude-code#8052, Roo-Code#10566): a sign-in refusal, not about extra usage.
    expect(
      ExtraUsage.detect(
        body(
          "invalid_request_error",
          "This credential is only authorized for use with Claude Code and cannot be used for other API requests.",
        ),
      ),
    ).toBe(false)
    // A monthly spend cap is told by its headers (`overage-disabled-reason: org_spend_cap_reached`), not by this body.
    expect(
      ExtraUsage.detect(body("rate_limit_error", "This request would exceed your account's monthly spend limit.")),
    ).toBe(false)
  })

  test("a refusal marks the account's overage window, made from nothing when the response had no overage header", () => {
    expect(Unified.refused([], NOW, TWO)).toEqual([
      {
        id: "claude.overage",
        accountID: TWO,
        providerID: Provider.ID.anthropic,
        scope: "account",
        kind: "spend_cap",
        label: "추가 사용량",
        status: "exhausted",
        confidence: "live",
        source: "error",
        observedAt: NOW,
        meta: { billing: "rejected" },
      },
    ])
    const parsed = Unified.parse(
      headers({
        status: "allowed",
        "5h-utilization": "0.1",
        "representative-claim": "five_hour",
        "overage-status": "allowed",
      }),
      NOW,
      "error",
    )
    const marked = Unified.refused(parsed, NOW)
    expect(marked.map((window) => [window.id, window.meta])).toEqual([
      ["claude.5h", { representative: "five_hour" }],
      ["claude.overage", { representative: "five_hour", billing: "rejected" }],
    ])
  })
})
