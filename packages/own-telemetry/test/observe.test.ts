import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session"
import { Broadcast, Home, Runtime, Vault } from "@own/runtime"
import { Observe } from "../src/observe.js"
import { Unified } from "../src/unified.js"
import { removeTree } from "./remove.js"

const NOW = Date.UTC(2026, 8, 27, 3, 0, 0)
const SESSION = "ses_telemetry_plugin_1"

let builds = 0

async function setup() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-telemetry-test-")))
  const clock = { now: NOW }
  const runtime = await Runtime.acquire({
    buildId: `test-telemetry-${process.pid}-${++builds}`,
    home,
    vault: { transport: Vault.memory() },
    now: () => clock.now,
  })
  const warnings: string[] = []
  const observe = Observe.create({
    runtime,
    now: () => clock.now,
    log: { warn: (message) => warnings.push(message) },
    jitter: () => 60_000,
  })
  const topics: Array<{ topic: Broadcast.Topic; payload: unknown }> = []
  for (const topic of ["limits.updated", "alert", "exhausted"] as const)
    runtime.broadcast.on(topic, (payload) => topics.push({ topic, payload }))
  return {
    runtime,
    observe,
    clock,
    topics,
    warnings,
    async [Symbol.asyncDispose]() {
      await runtime.release()
      await removeTree(home)
    },
  }
}

function unified(input: { status: string; five: number; seven: number; fiveStatus?: string }) {
  return {
    "anthropic-ratelimit-unified-status": input.status,
    "anthropic-ratelimit-unified-5h-status": input.fiveStatus ?? "allowed",
    "anthropic-ratelimit-unified-5h-utilization": String(input.five),
    "anthropic-ratelimit-unified-5h-reset": String(NOW / 1000 + 3_600),
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": String(input.seven),
    "anthropic-ratelimit-unified-7d-reset": String(NOW / 1000 + 86_400),
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-overage-status": "rejected",
  }
}

function http(response: Response, providerID = "anthropic", model = "claude-opus-5-5"): SessionHttpResponse {
  // SAFETY: hook events are built from plain values; ids are branded strings at runtime.
  return {
    sessionID: SESSION,
    agent: "build",
    model: { providerID, id: model },
    kind: "primary",
    request: new Request("http://fake.local/v1/messages", { method: "POST", headers: { authorization: "Bearer x" } }),
    response,
  } as unknown as SessionHttpResponse
}

function retry(status: number): SessionRetry {
  // SAFETY: as in `http`.
  return {
    sessionID: SESSION,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5-5" },
    error: { type: "provider.rate-limit", message: "rate limited", status },
    attempt: 2,
    decision: { retry: true, delay: 2_000 },
  } as unknown as SessionRetry
}

describe("Unified.parse", () => {
  test("maps unified headers to claude.* windows (02 §7.3)", () => {
    const windows = Unified.parse(new Headers(unified({ status: "allowed_warning", five: 0.91, seven: 0.4 })), NOW)
    expect(windows).toEqual([
      expect.objectContaining({
        id: "claude.5h",
        accountID: "acc_claude_slot",
        providerID: "anthropic",
        label: "5시간",
        windowMinutes: 300,
        usedPercent: 91,
        resetAt: NOW + 3_600_000,
        status: "ok",
        source: "header",
        confidence: "live",
        meta: { representative: "five_hour" },
      }),
      expect.objectContaining({ id: "claude.7d", usedPercent: 40, resetAt: NOW + 86_400_000, label: "주간" }),
      expect.objectContaining({ id: "claude.overage", kind: "spend_cap", status: "exhausted" }),
    ])
  })

  test("no unified headers → no windows; status mapping", () => {
    expect(Unified.parse(new Headers({ "content-type": "text/event-stream" }), NOW)).toEqual([])
    expect(Unified.statusOf("allowed_warning", 10)).toBe("warning")
    expect(Unified.statusOf(undefined, 100)).toBe("exhausted")
    expect(Unified.statusOf(undefined, undefined)).toBe("unknown")
  })
})

describe("Observe", () => {
  test("http.response: unified windows to the runtime, broadcast, lastResponse", async () => {
    await using t = await setup()
    await t.observe.onHttpResponse(
      http(new Response("data: {}\n\n", { headers: unified({ status: "allowed", five: 0.2, seven: 0.1 }) })),
    )
    expect(
      t.runtime.limits.list({ accountID: "acc_claude_slot" }).map((window) => [window.id, window.usedPercent]),
    ).toEqual([
      ["claude.5h", 20],
      ["claude.7d", 10],
      ["claude.overage", undefined],
    ])
    expect(t.topics.map((item) => item.topic)).toEqual(["limits.updated"])
    expect(t.runtime.lastResponse.get(SESSION)).toMatchObject({ providerID: "anthropic", status: 200 })
    // An unchanged snapshot is not broadcast again.
    await t.observe.onHttpResponse(
      http(new Response("", { headers: unified({ status: "allowed", five: 0.2, seven: 0.1 }) })),
    )
    expect(t.topics).toHaveLength(1)
  })

  test("http.response: a success without the five-hour family forgets the account's claude.5h; errors and 5 h accounts keep it (02 §7.1.2)", async () => {
    await using t = await setup()
    await t.observe.onHttpResponse(
      http(new Response("", { headers: unified({ status: "allowed", five: 0.3, seven: 0.1 }) })),
    )
    const ultra = (values: Record<string, string>) =>
      Object.fromEntries(Object.entries(values).filter(([name]) => !name.includes("-5h-")))
    const weekOnly = (seven: number) => ({
      ...ultra(unified({ status: "allowed", five: 0, seven })),
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
    })
    // A refusal says nothing about the windows the account has: the five hours stay.
    t.clock.now = NOW + 1_000
    await t.observe.onHttpResponse(http(new Response("{}", { status: 429, headers: weekOnly(0.15) })))
    expect(t.runtime.limits.list({ accountID: "acc_claude_slot" }).map((window) => window.id)).toContain("claude.5h")
    t.topics.length = 0
    t.clock.now = NOW + 2_000
    await t.observe.onHttpResponse(http(new Response("", { headers: weekOnly(0.2) })))
    expect(
      t.runtime.limits.list({ accountID: "acc_claude_slot" }).map((window) => [window.id, window.usedPercent]),
    ).toEqual([
      ["claude.7d", 20],
      ["claude.overage", undefined],
    ])
    expect(t.topics).toEqual([
      {
        topic: "limits.updated",
        payload: {
          windows: [expect.objectContaining({ id: "claude.7d", usedPercent: 20 })],
          dropped: [{ accountID: "acc_claude_slot", id: "claude.5h" }],
        },
      },
    ])
    // Nothing more to forget: the next such answer is quiet.
    t.clock.now = NOW + 3_000
    await t.observe.onHttpResponse(http(new Response("", { headers: weekOnly(0.2) })))
    expect(t.topics).toHaveLength(1)
    // An answer that carries the five hours again brings the window back.
    t.clock.now = NOW + 4_000
    await t.observe.onHttpResponse(
      http(new Response("", { headers: unified({ status: "allowed", five: 0.05, seven: 0.2 }) })),
    )
    expect(t.runtime.limits.list({ accountID: "acc_claude_slot" }).map((window) => window.id)).toContain("claude.5h")
  })

  test("http.response: the per-model weekly bucket (`7d_oi`, 주간 · Fable) reaches the store beside 5 h and weekly", async () => {
    await using t = await setup()
    await t.observe.onHttpResponse(
      http(
        new Response("", {
          headers: {
            ...unified({ status: "allowed", five: 0.02, seven: 0.74 }),
            "anthropic-ratelimit-unified-7d_oi-utilization": "0.31",
            "anthropic-ratelimit-unified-7d_oi-reset": String(NOW / 1000 + 86_400),
          },
        }),
      ),
    )
    expect(
      t.runtime.limits
        .list({ accountID: "acc_claude_slot" })
        .map((window) => [window.id, window.label, window.usedPercent]),
    ).toEqual([
      ["claude.5h", "5시간", 2],
      ["claude.7d", "주간", 74],
      ["claude.7d_oi", "주간 · Fable", 31],
      ["claude.overage", "추가 사용량", undefined],
    ])
  })

  test("other providers are ignored", async () => {
    await using t = await setup()
    await t.observe.onHttpResponse(
      http(new Response("", { headers: unified({ status: "allowed", five: 0.2, seven: 0.1 }) }), "openai"),
    )
    expect(t.runtime.limits.list()).toEqual([])
  })

  test("on an SSH host, a refusal of the PC relay or the fail-closed sink is not Anthropic's answer (04 §8.11.4.6)", async () => {
    await using t = await setup()
    const marks: ReadonlyArray<Record<string, string>> = [{ "x-own-egress-error": "off" }, { "x-own-fail-closed": "sink" }]
    for (const headers of marks)
      await t.observe.onHttpResponse(
        http(
          new Response("Third-party apps now draw from your extra usage", {
            status: 403,
            headers: { ...headers, ...unified({ status: "rejected", five: 1, seven: 0.1, fiveStatus: "rejected" }) },
          }),
        ),
      )
    expect(t.runtime.limits.list()).toEqual([])
    expect(t.runtime.lastResponse.get(SESSION)).toBeUndefined()
    expect(t.topics).toEqual([])
    // A relayed Anthropic answer (`x-own-egress: 1`) is observed as usual.
    await t.observe.onHttpResponse(
      http(
        new Response("", { headers: { "x-own-egress": "1", ...unified({ status: "allowed", five: 0.2, seven: 0.1 }) } }),
      ),
    )
    expect(t.runtime.limits.list().map((window) => window.id)).toContain("claude.5h")
  })

  test("400 with the extra-usage phrase → the account's refusal verdict and the claude_extra_usage alert (danger)", async () => {
    await using t = await setup()
    // The refusal as users reported it (anthropics/claude-code#45134, 2026-04-08), without unified headers.
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.",
      },
    })
    const event = http(new Response(body, { status: 400 }))
    await t.observe.onHttpResponse(event)
    expect(await event.response.text()).toBe(body)
    const verdict = expect.objectContaining({
      id: "claude.overage",
      accountID: "acc_claude_slot",
      kind: "spend_cap",
      status: "exhausted",
      source: "error",
      meta: { billing: "rejected" },
    })
    expect(t.topics).toEqual([
      { topic: "limits.updated", payload: { windows: [verdict] } },
      {
        topic: "alert",
        payload: expect.objectContaining({
          code: "claude_extra_usage",
          severity: "danger",
          sessionID: SESSION,
          accountID: "acc_claude_slot",
        }),
      },
    ])
    expect(t.runtime.lastResponse.get(SESSION)?.bodyHead).toContain("extra usage")
  })

  test("02 §8.9: a refusal with overage headers keeps them; the next success clears the verdict", async () => {
    await using t = await setup()
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "You’re out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      },
    })
    await t.observe.onHttpResponse(
      http(
        new Response(body, {
          status: 400,
          headers: {
            ...unified({ status: "allowed", five: 0.1, seven: 0.1 }),
            "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
          },
        }),
      ),
    )
    const overage = () =>
      t.runtime.limits.list({ accountID: "acc_claude_slot" }).find((window) => window.id === "claude.overage")
    expect(overage()).toMatchObject({
      status: "exhausted",
      source: "error",
      meta: { representative: "five_hour", billing: "rejected", disabledReason: "org_level_disabled" },
    })
    // A success without any overage header still ends the refusal.
    t.clock.now += 60_000
    const success = unified({ status: "allowed", five: 0.1, seven: 0.1 })
    const { "anthropic-ratelimit-unified-overage-status": _overage, ...withoutOverage } = success
    await t.observe.onHttpResponse(http(new Response("data: {}\n\n", { headers: withoutOverage })))
    expect(overage()?.meta).toEqual({ representative: "five_hour", disabledReason: "org_level_disabled" })
    // The refusal's state goes with it (LV): extra usage is headroom, unknown until a response says.
    expect(overage()).toMatchObject({ observedAt: NOW + 60_000, source: "header", status: "unknown" })
    expect(t.topics.at(-1)).toEqual({
      topic: "limits.updated",
      payload: { windows: [expect.objectContaining({ id: "claude.overage" })] },
    })
  })

  test("02 §8.9: a Sonnet success after #5920 keeps the Fable conversation's refused extra usage; a Fable one clears it (LV)", async () => {
    await using t = await setup()
    const on = (model: string, response: Response) => http(response, "anthropic", model)
    // router-for-me/CLIProxyAPI#5920 (2026-09-17) on a Fable conversation: the Fable week used up, extra usage capped.
    const issue = Object.fromEntries(
      Object.entries({
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
      }).map(([name, value]) => [`anthropic-ratelimit-unified-${name}`, value]),
    )
    await t.observe.onHttpResponse(on("claude-fable-5-1", new Response("{}", { status: 429, headers: issue })))
    const overage = () =>
      t.runtime.limits.list({ accountID: "acc_claude_slot" }).find((window) => window.id === "claude.overage")
    expect(overage()?.meta?.billing).toBe("rejected")
    // A Sonnet answer through the plan, without overage headers: the Fable week still holds Fable back.
    t.clock.now += 60_000
    const plan = {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.24",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.73",
    }
    await t.observe.onHttpResponse(on("claude-sonnet-4-5", new Response("data: {}\n\n", { headers: plan })))
    expect(overage()).toMatchObject({ status: "exhausted", meta: { billing: "rejected" } })
    // A Fable answer: requests of the model the refusal covered go through again.
    t.clock.now += 60_000
    await t.observe.onHttpResponse(on("claude-fable-5-1", new Response("data: {}\n\n", { headers: plan })))
    expect(overage()?.meta?.billing).toBeUndefined()
    expect(overage()?.status).toBe("unknown")
  })

  test("02 §8.9: the headers' own verdict, from Claude Code's reading of them", async () => {
    await using t = await setup()
    const using = {
      ...unified({ status: "rejected", five: 1, seven: 0.5, fiveStatus: "rejected" }),
      "anthropic-ratelimit-unified-overage-status": "allowed",
    }
    await t.observe.onHttpResponse(http(new Response("data: {}\n\n", { headers: using })))
    const overage = () =>
      t.runtime.limits.list({ accountID: "acc_claude_slot" }).find((window) => window.id === "claude.overage")
    expect(overage()?.meta?.billing).toBe("extra_usage")
    // Back on the plan: the verdict goes, and that change alone is announced.
    t.clock.now += 1_000
    const plan = {
      ...using,
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
    }
    const before = t.topics.length
    await t.observe.onHttpResponse(http(new Response("data: {}\n\n", { headers: plan })))
    expect(overage()?.meta?.billing).toBeUndefined()
    expect(t.topics.length).toBe(before + 1)
  })

  test("retry: a refusal for extra usage (429 `credits_required`) is never sent again, and is no exhaustion", async () => {
    await using t = await setup()
    // router-for-me/CLIProxyAPI#5920 (2026-09-17): no Retry-After, no plan window refused, credits off.
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        code: "credits_required",
        message: "Usage credits are required for this model",
      },
    })
    await t.observe.onHttpResponse(
      http(
        new Response(body, {
          status: 429,
          headers: { "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled" },
        }),
      ),
    )
    const event = retry(429)
    await t.observe.onRetry(event)
    expect(event.decision).toEqual({ retry: false })
    expect(t.runtime.limits.exhaustion("acc_claude_slot")).toBeUndefined()
    // After own-accounts moved the conversation to another Claude account, its immediate retry stays.
    t.runtime.claude.markSwitched(SESSION)
    const moved = retry(429)
    await t.observe.onRetry(moved)
    expect(moved.decision).toEqual({ retry: true, delay: 2_000 })
  })

  test("retry: unified rejected → no retry, exhaustion until reset + jitter, events ledger, broadcast", async () => {
    await using t = await setup()
    await t.observe.onHttpResponse(
      http(
        new Response("{}", {
          status: 429,
          headers: unified({ status: "rejected", five: 1, seven: 0.5, fiveStatus: "rejected" }),
        }),
      ),
    )
    const event = retry(429)
    await t.observe.onRetry(event)
    expect(event.decision).toEqual({ retry: false })
    const exhaustion = t.runtime.limits.exhaustion("acc_claude_slot")
    expect(exhaustion).toMatchObject({
      accountID: "acc_claude_slot",
      windowId: "claude.5h",
      until: NOW + 3_600_000 + 60_000,
      class: "hard",
    })
    expect(t.topics.at(-1)).toEqual({
      topic: "exhausted",
      payload: { exhaustion, providerID: "anthropic", sessionID: SESSION },
    })
    await t.runtime.ledger.flush()
    expect(await t.runtime.ledger.eventsOf(Home.month(NOW))).toEqual([
      expect.objectContaining({
        type: "exhaustion",
        accountID: "acc_claude_slot",
        providerID: "anthropic",
        sessionID: SESSION,
      }),
    ])
    // A later success clears the exhaustion.
    await t.observe.onHttpResponse(
      http(new Response("", { headers: unified({ status: "allowed", five: 0.1, seven: 0.5 }) })),
    )
    expect(t.runtime.limits.exhaustion("acc_claude_slot")).toBeUndefined()
  })

  test("retry: a used-up model week is recorded for its model only, until its reset (LV)", async () => {
    await using t = await setup()
    const reset = NOW / 1000 + 5 * 86_400
    // A refused Opus request: the Opus week (claim `seven_day_opus`, top-level status and reset) ran out for 5 days.
    await t.observe.onHttpResponse(
      http(
        new Response("{}", {
          status: 429,
          headers: {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": String(reset),
            "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
            "anthropic-ratelimit-unified-5h-status": "allowed",
            "anthropic-ratelimit-unified-5h-utilization": "0.12",
            "anthropic-ratelimit-unified-7d-status": "allowed",
            "anthropic-ratelimit-unified-7d-utilization": "0.44",
          },
        }),
      ),
    )
    const event = retry(429)
    await t.observe.onRetry(event)
    expect(event.decision).toEqual({ retry: false })
    expect(t.runtime.limits.exhaustion("acc_claude_slot", "claude-opus-5-5")).toMatchObject({
      accountID: "acc_claude_slot",
      windowId: "claude.7d_opus",
      until: reset * 1000 + 60_000,
      class: "hard",
    })
    // The account is not exhausted for Sonnet, nor as a whole.
    expect(t.runtime.limits.exhaustion("acc_claude_slot", "claude-sonnet-4-5")).toBeUndefined()
    expect(t.runtime.limits.exhaustion("acc_claude_slot")).toBeUndefined()
    await t.runtime.ledger.flush()
    expect(await t.runtime.ledger.eventsOf(Home.month(NOW))).toEqual([
      expect.objectContaining({
        type: "exhaustion",
        data: expect.objectContaining({ windowId: "claude.7d_opus", reason: "unified_7d_opus_rejected" }),
      }),
    ])
    // A Sonnet answer of the same account says nothing of the Opus week; an Opus answer ends it.
    const sonnet = http(new Response("", { headers: unified({ status: "allowed", five: 0.13, seven: 0.45 }) }))
    await t.observe.onHttpResponse({ ...sonnet, model: { ...sonnet.model, id: "claude-sonnet-4-5" } } as SessionHttpResponse)
    expect(t.runtime.limits.exhaustion("acc_claude_slot", "claude-opus-5-5")).toMatchObject({ windowId: "claude.7d_opus" })
    await t.observe.onHttpResponse(
      http(new Response("", { headers: unified({ status: "allowed", five: 0.14, seven: 0.45 }) })),
    )
    expect(t.runtime.limits.exhaustion("acc_claude_slot", "claude-opus-5-5")).toBeUndefined()
  })

  test("retry: a 429 with retry-after over 15 minutes is cut short; a short one is left to core", async () => {
    await using t = await setup()
    await t.observe.onHttpResponse(http(new Response("{}", { status: 429, headers: { "retry-after": "60" } })))
    const short = retry(429)
    await t.observe.onRetry(short)
    expect(short.decision).toEqual({ retry: true, delay: 2_000 })
    await t.observe.onHttpResponse(http(new Response("{}", { status: 429, headers: { "retry-after": "3600" } })))
    const long = retry(429)
    await t.observe.onRetry(long)
    expect(long.decision).toEqual({ retry: false })
    expect(t.runtime.limits.exhaustion("acc_claude_slot")).toMatchObject({
      windowId: null,
      until: NOW + 3_600_000 + 60_000,
    })
  })
})

describe("several Claude accounts (02 §8.5, §8.8, G4)", () => {
  test("windows, the last answer and the exhaustion belong to the account that signed the request", async () => {
    await using t = await setup()
    const two = "acc_01J9CLAUDETWO0000000000000"
    const event = http(new Response("", { headers: unified({ status: "allowed", five: 0.7, seven: 0.2 }) }))
    t.runtime.claude.install((request) => (request.url.startsWith("http://fake.local/") ? two : undefined))
    await t.observe.onHttpResponse(event)
    expect(t.runtime.limits.list({ accountID: two }).map((window) => window.id)).toEqual([
      "claude.5h",
      "claude.7d",
      "claude.overage",
    ])
    expect(t.runtime.limits.list({ accountID: "acc_claude_slot" })).toEqual([])
    expect(t.runtime.claude.lastOf(SESSION)).toBe(two)
    // The account then runs out: its exhaustion, not the slot's own.
    await t.observe.onHttpResponse(
      http(new Response("", { status: 429, headers: unified({ status: "rejected", five: 1, seven: 0.2, fiveStatus: "rejected" }) })),
    )
    const cut = retry(429)
    await t.observe.onRetry(cut)
    expect(cut.decision).toEqual({ retry: false })
    expect(t.runtime.limits.exhaustion(two)).toMatchObject({ accountID: two, windowId: "claude.5h" })
    expect(t.runtime.limits.exhaustion("acc_claude_slot")).toBeUndefined()
  })

  test("own-accounts moved the conversation to another Claude account: the retry stays, the exhaustion is recorded", async () => {
    await using t = await setup()
    t.runtime.claude.install(() => "acc_claude_slot")
    await t.observe.onHttpResponse(
      http(new Response("", { status: 429, headers: unified({ status: "rejected", five: 1, seven: 0.2, fiveStatus: "rejected" }) })),
    )
    t.runtime.claude.markSwitched(SESSION)
    const switched = { ...retry(429), decision: { retry: true, delay: 0 } } as SessionRetry
    await t.observe.onRetry(switched)
    expect(switched.decision).toEqual({ retry: true, delay: 0 })
    expect(t.runtime.limits.exhaustion("acc_claude_slot")).toMatchObject({ windowId: "claude.5h" })
    // Review finding 4 (2026-10-11): the conversation already runs on a healthy account, so the exhaustion is not
    // announced as its own (the switching planner would otherwise move it away from Claude).
    expect(t.topics.at(-1)).toEqual({
      topic: "exhausted",
      payload: { exhaustion: t.runtime.limits.exhaustion("acc_claude_slot"), providerID: "anthropic" },
    })
    // The mark is used once: the next refusal stops as before.
    const next = retry(429)
    await t.observe.onRetry(next)
    expect(next.decision).toEqual({ retry: false })
  })
})
