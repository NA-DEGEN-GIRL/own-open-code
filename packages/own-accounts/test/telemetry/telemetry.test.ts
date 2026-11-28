import { describe, expect, test } from "bun:test"
import { Home } from "@own/runtime"
import { Account, Kv } from "@own/protocol"
import type { ClaudeAccounts } from "../../src/claude/accounts.js"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import { Poller } from "../../src/telemetry/poller.js"
import { Telemetry } from "../../src/telemetry/telemetry.js"
import { hashSecret, startFakeCodex, startFakeOpenAIChat } from "../e2e-kit"
import {
  ANTH,
  ANTH2_ACCOUNT,
  ANTH_ACCOUNT,
  CODEX,
  CODEX_ACCOUNT,
  DEFAULT_SEEDS,
  DS_ACCOUNT,
  OTHER_SESSION,
  SESSION,
  SIWC,
  SIWC_ACCOUNT,
  call,
  event,
  fakeLogins,
  httpEvent,
  modelSelected,
  ok,
  registry,
  retryEvent,
  setup,
  step,
  wsEvent,
} from "./support.js"

const CODEX_CARD = {
  match: { kind: "codex", model: "gpt-5.5" },
  unit: "credits",
  in: 125,
  read: 12.5,
  write: null,
  out: 750,
  ttl: { warmLowerSec: 300, coldUpperSec: null },
} as const

function codexHeaders(primary: number, now: number, extra: Record<string, string> = {}) {
  return {
    "x-codex-primary-used-percent": String(primary),
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 3_600),
    "x-codex-secondary-used-percent": "12.5",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(Math.floor(now / 1000) + 86_400),
    ...extra,
  }
}

describe("limits capture", () => {
  test("http.response codex headers → runtime windows, quota.snapshot, quota.updated (throttled)", async () => {
    await using t = await setup()
    const now = t.clock.now()
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: CODEX, response: new Response("data: {}\n\n", { headers: codexHeaders(40, now) }) }),
    )
    const snapshot = await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })
    expect(snapshot.windows.map((window) => [window.id, window.usedPercent, window.status, window.source])).toEqual([
      ["codex.primary", 40, "ok", "header"],
      ["codex.secondary", 12.5, "ok", "header"],
    ])
    expect(snapshot.windows[0]).toMatchObject({ label: "5시간", resetAt: (Math.floor(now / 1000) + 3_600) * 1000 })
    expect(t.deps.runtime.lastResponse.get(SESSION)).toMatchObject({ providerID: CODEX, status: 200 })
    // The account's own; the budget of the account that has one went out at start (LV 2026-10-25).
    const codex = () => t.emitted("quota.updated").filter((item) => item.data.accountID === CODEX_ACCOUNT)
    expect(codex()).toHaveLength(1)
    expect(codex()[0].data).toMatchObject({ accountID: CODEX_ACCOUNT, origin: "global" })

    // Within 5 s the next update is held back and sent once when the interval ends.
    t.clock.advance(1_000)
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: CODEX, response: new Response("", { headers: codexHeaders(45, t.clock.now()) }) }),
    )
    expect(codex()).toHaveLength(1)
    t.clock.advance(4_000)
    expect(codex()).toHaveLength(2)
    const windows = codex()[1].data.windows as ReadonlyArray<{ id: string; usedPercent: number }>
    expect(windows.find((window) => window.id === "codex.primary")?.usedPercent).toBe(45)
  })

  test("providers that are not own slots are ignored", async () => {
    await using t = await setup()
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: "openai", response: new Response("", { headers: codexHeaders(40, t.clock.now()) }) }),
    )
    expect((await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).windows).toEqual([])
    expect(t.deps.runtime.lastResponse.get(SESSION)).toBeUndefined()
  })

  test("ws.receive: codex.rate_limits frames update windows; other frames are not parsed", async () => {
    await using t = await setup()
    const now = t.clock.now()
    const frame = JSON.stringify({
      type: "codex.rate_limits",
      rate_limits: {
        primary: { used_percent: 91, window_minutes: 300, reset_at: Math.floor(now / 1000) + 60 },
        secondary: { used_percent: 30, window_minutes: 10080, reset_at: Math.floor(now / 1000) + 600 },
      },
    })
    const event = wsEvent({ providerID: CODEX, frame })
    t.telemetry.onWsReceive(event)
    expect(event.frame).toBe(frame)
    t.telemetry.onWsReceive(wsEvent({ providerID: CODEX, frame: '{"type":"response.output_text.delta","delta":"x"}' }))
    const windows = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).windows
    expect(windows.map((window) => [window.id, window.usedPercent, window.status, window.source])).toEqual([
      ["codex.primary", 91, "warning", "ws_event"],
      ["codex.secondary", 30, "ok", "ws_event"],
    ])
    expect(t.deps.runtime.lastResponse.get(SESSION)?.frame?.type).toBe("codex.rate_limits")
  })

  test("ws.receive: a live WebSocket answer's frames (2026-10-18) make the weekly and credits windows and an event", async () => {
    await using t = await setup()
    // The frames a real answer starts with, in order, as sent (the turn state shortened, it is opaque).
    const frames = [
      JSON.stringify({
        type: "codex.rate_limits",
        plan_type: "promax",
        rate_limits: {
          allowed: true,
          limit_reached: false,
          primary: { used_percent: 7, window_minutes: 10080, reset_after_seconds: 550663, reset_at: 1792876670 },
          secondary: null,
        },
        code_review_rate_limits: null,
        additional_rate_limits: null,
        credits: { has_credits: true, unlimited: false, balance: "21001.0966250000" },
        promo: null,
      }),
      JSON.stringify({ type: "codex.response.metadata", headers: { "x-models-etag": "e", "x-codex-turn-state": "s" } }),
      JSON.stringify({
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_1", service_tier: "auto" },
      }),
    ]
    for (const frame of frames) t.telemetry.onWsReceive(wsEvent({ providerID: CODEX, frame }))
    const windows = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).windows
    expect(windows.map((window) => [window.id, window.label, window.usedPercent, window.remaining])).toEqual([
      ["codex.primary", "주간", 7, undefined],
      ["codex.credits", "크레딧", undefined, 21001.096625],
    ])
    // The leader announces them to the screens (02 §9.1); the other one is the budget account's, at start.
    expect(
      t
        .emitted("quota.updated")
        .map((item) => item.data.accountID)
        .toSorted(),
    ).toEqual([ANTH_ACCOUNT, CODEX_ACCOUNT])
  })

  test("anthropic and x-ratelimit headers of API slots", async () => {
    await using t = await setup()
    const reset = new Date(t.clock.now() + 60_000).toISOString()
    await t.telemetry.onHttpResponse(
      httpEvent({
        providerID: ANTH,
        response: new Response("", {
          headers: {
            "anthropic-ratelimit-requests-limit": "50",
            "anthropic-ratelimit-requests-remaining": "49",
            "anthropic-ratelimit-requests-reset": reset,
          },
        }),
      }),
    )
    const windows = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [ANTH_ACCOUNT] })).windows
    expect(windows.filter((window) => window.id.startsWith("anth."))).toEqual([
      expect.objectContaining({ id: "anth.requests", usedPercent: 2, remaining: 49, limit: 50 }),
    ])
  })
})

describe("retry classification", () => {
  test("codex WS usage_limit frame → hard: no retry, exhaustion, events ledger, account.status", async () => {
    await using t = await setup()
    const now = t.clock.now()
    t.telemetry.onWsReceive(
      wsEvent({
        providerID: CODEX,
        frame: JSON.stringify({
          type: "error",
          status: 429,
          error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 600 },
        }),
      }),
    )
    const retry = retryEvent({ providerID: CODEX, status: 429, message: "The usage limit has been reached" })
    const verdict = await t.telemetry.onRetry(retry)
    expect(retry.decision).toEqual({ retry: false })
    expect(verdict.class).toBe("hard")
    expect(verdict.accountID as string | undefined).toBe(CODEX_ACCOUNT)
    expect(verdict.until).toBeGreaterThanOrEqual(now + 600_000 + 60_000)
    expect(verdict.until).toBeLessThanOrEqual(now + 600_000 + 180_000)
    expect(t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)).toMatchObject({ class: "hard" })
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({ accountID: CODEX_ACCOUNT, status: "exhausted" })
    await t.deps.runtime.ledger.flush()
    const events = await t.deps.runtime.ledger.eventsOf(Home.month(now))
    expect(events).toEqual([
      expect.objectContaining({ type: "exhaustion", accountID: CODEX_ACCOUNT, sessionID: SESSION }),
    ])

    // A success clears it and the leader announces the account ready again.
    await t.telemetry.onHttpResponse(
      httpEvent({
        providerID: CODEX,
        sessionID: OTHER_SESSION,
        response: new Response("", { headers: codexHeaders(50, now) }),
      }),
    )
    expect(t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)).toBeUndefined()
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({ accountID: CODEX_ACCOUNT, status: "ready" })
  })

  test("an earlier step's ledger line written after the exhaustion keeps it; a later step clears it", async () => {
    // The sharing e2e's race (2026-10-18): the session queue wrote the first turn's line just after the next request
    // was refused with a usage limit, and the line cleared the new exhaustion.
    await using t = await setup()
    const directory = t.deps.location.directory
    const before = t.clock.now() - 5_000
    t.clock.advance(1_000)
    await t.telemetry.onHttpResponse(
      httpEvent({
        providerID: CODEX,
        response: Response.json(
          { error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 600 } },
          { status: 429, headers: codexHeaders(100, t.clock.now()) },
        ),
      }),
    )
    expect((await t.telemetry.onRetry(retryEvent({ providerID: CODEX, status: 429 }))).class).toBe("hard")
    const usage = { input: 100, read: 0 }
    for (const item of step({ providerID: CODEX, messageID: "msg_late", at: before, directory, usage }))
      await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    expect(t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)).toMatchObject({ class: "hard" })
    t.clock.advance(1_000)
    for (const item of step({
      providerID: CODEX,
      sessionID: OTHER_SESSION,
      messageID: "msg_after",
      at: t.clock.now(),
      directory,
      usage,
    }))
      await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    expect(t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)).toBeUndefined()
  })

  test("a transient 429 keeps core's decision", async () => {
    await using t = await setup()
    await t.telemetry.onHttpResponse(
      httpEvent({
        providerID: CODEX,
        response: new Response(JSON.stringify({ error: { type: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "retry-after": "3", ...codexHeaders(20, t.clock.now()) },
        }),
      }),
    )
    const retry = retryEvent({ providerID: CODEX, status: 429 })
    expect((await t.telemetry.onRetry(retry)).class).toBe("transient")
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
    expect(t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)).toBeUndefined()
  })

  test("anthropic spend limit exhausts the whole quota domain", async () => {
    await using t = await setup()
    await t.telemetry.onHttpResponse(
      httpEvent({
        providerID: ANTH,
        response: new Response(JSON.stringify({ error: { type: "enforced_spend_limit_reached" } }), { status: 429 }),
      }),
    )
    const verdict = await t.telemetry.onRetry(retryEvent({ providerID: ANTH, status: 429 }))
    expect(verdict.class).toBe("hard")
    // Unknown reset → first backoff step (15 min).
    expect(verdict.until).toBe(t.clock.now() + 15 * 60_000)
    expect(t.deps.runtime.limits.exhaustion(ANTH_ACCOUNT)?.class).toBe("hard")
    expect(t.deps.runtime.limits.exhaustion(ANTH2_ACCOUNT)?.class).toBe("hard")
    expect(t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)).toBeUndefined()
  })

  test("401: refresh first (transient), auth on the second; linked codex raises codex_source_stale", async () => {
    await using t = await setup({
      registry: registry([
        {
          ...DEFAULT_SEEDS[0],
          credential: {
            type: "linked-codex-source",
            source: {
              app: "codex-multi-provider",
              profileID: "01",
              authPath: "C:\\fake\\profiles\\01\\codex\\auth.json",
              alias: null,
            },
            linkedAt: "2026-09-26T00:00:00Z",
          },
        },
      ]),
    })
    const first = await t.telemetry.onRetry(retryEvent({ providerID: CODEX, status: 401, type: "provider.auth" }))
    expect(first.class).toBe("transient")
    expect(t.calls.unauthorized).toEqual([CODEX_ACCOUNT])
    const second = await t.telemetry.onRetry(retryEvent({ providerID: CODEX, status: 401, type: "provider.auth" }))
    expect(second.class).toBe("auth")
    expect(t.deps.runtime.limits.exhaustion(CODEX_ACCOUNT)?.class).toBe("auth")
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({ status: "auth_failed" })
    expect(t.emitted("alert").map((item) => item.data.code)).toEqual(["codex_source_stale"])
  })

  // RS (2026-11-28): a connection test's 401 wrote `auth_failed`; the token refreshed (or the key works again) and the
  // requests succeed, but the card, the limits tab and the picker kept `인증 실패` until another passing test.
  test("a success on an account the registry shows auth_failed ends it (logins.accepted); a ready one is left alone", async () => {
    await using t = await setup({
      registry: registry([...DEFAULT_SEEDS.slice(0, 1), { ...DEFAULT_SEEDS[1]!, status: "auth_failed" }]),
    })
    await t.telemetry.onHttpResponse(httpEvent({ providerID: ANTH, response: new Response("{}", { status: 200 }) }))
    await t.telemetry.onHttpResponse(httpEvent({ providerID: CODEX, response: new Response("{}", { status: 200 }) }))
    expect(t.calls.accepted).toEqual([ANTH_ACCOUNT])
  })

  test("a second 401 tells logins the credential was refused (the card says 인증 실패); the first only refreshes", async () => {
    await using t = await setup()
    await t.telemetry.onRetry(retryEvent({ providerID: ANTH, status: 401, type: "provider.auth" }))
    expect(t.calls.refused).toEqual([])
    await t.telemetry.onRetry(retryEvent({ providerID: ANTH, status: 401, type: "provider.auth" }))
    expect(t.calls.refused).toEqual([ANTH_ACCOUNT])
  })
})

describe("Sign in with ChatGPT retry classification (02 §3.2c)", () => {
  const siwc = () => registry([...DEFAULT_SEEDS, { id: SIWC_ACCOUNT, kind: "siwc", providerID: SIWC }])
  const sharingResponse = (status: number, code: string) =>
    httpEvent({
      providerID: SIWC,
      response: new Response(JSON.stringify({ error: { code, message: "fake", type: "invalid_request_error" } }), {
        status,
      }),
    })

  test("with no capture the code in the error's response body still decides (upstream c14a1f5acf)", async () => {
    await using t = await setup({ registry: siwc() })
    // Upstream's friendly message names no code; the provider's body rides on the session error.
    const retry = retryEvent({
      providerID: SIWC,
      status: 429,
      message: "You have reached your ChatGPT usage limit.",
      body: JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "fake" } }),
    })
    expect(await t.telemetry.onRetry(retry)).toMatchObject({ class: "hard", accountID: SIWC_ACCOUNT })
    expect(retry.decision).toEqual({ retry: false })
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({
      accountID: SIWC_ACCOUNT,
      status: "exhausted",
      reason: "subscription_sharing_usage_limit_exceeded",
    })
  })

  test("a usage limit stops core's retries and exhausts the account without inventing a reset time", async () => {
    const logs: string[] = []
    await using t = await setup({ registry: siwc(), logs })
    await t.telemetry.onHttpResponse(sharingResponse(429, "subscription_sharing_usage_limit_exceeded"))
    const retry = retryEvent({ providerID: SIWC, status: 429 })
    const verdict = await t.telemetry.onRetry(retry)
    expect(retry.decision).toEqual({ retry: false })
    expect(verdict).toMatchObject({ class: "hard", accountID: SIWC_ACCOUNT, until: t.clock.now() + 15 * 60_000 })
    expect(t.deps.runtime.limits.exhaustion(SIWC_ACCOUNT)).toMatchObject({ class: "hard" })
    // No reset in the body: no window, and the log names the body's fields so a later build can read the real shape.
    expect((await ok(t.telemetry.quotaSnapshot, { accountIDs: [SIWC_ACCOUNT] })).windows).toEqual([])
    expect(logs.map((line) => JSON.parse(line)).filter((line) => line.msg === "usage_limit_answer")).toEqual([
      expect.objectContaining({
        accountID: SIWC_ACCOUNT,
        status: 429,
        fields: ["error", "error.code", "error.message", "error.type"],
        reset: false,
      }),
    ])
    // The UI keys its usage-limit notice on this code (no window names the limit).
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({
      accountID: SIWC_ACCOUNT,
      status: "exhausted",
      reason: "subscription_sharing_usage_limit_exceeded",
    })
    await t.deps.runtime.ledger.flush()
    const events = await t.deps.runtime.ledger.eventsOf(Home.month(t.clock.now()))
    expect(events.at(-1)).toMatchObject({
      type: "exhaustion",
      accountID: SIWC_ACCOUNT,
      data: { reason: "subscription_sharing_usage_limit_exceeded" },
    })
  })

  test("plan headers on token-sharing responses become the account's windows and date its usage limit", async () => {
    await using t = await setup({ registry: siwc() })
    const now = t.clock.now()
    const plan = (used: string) => ({
      "x-codex-primary-used-percent": used,
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 1800),
    })
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: SIWC, response: new Response("", { status: 200, headers: plan("64") }) }),
    )
    expect((await ok(t.telemetry.quotaSnapshot, { accountIDs: [SIWC_ACCOUNT] })).windows).toEqual([
      expect.objectContaining({ id: "codex.primary", accountID: SIWC_ACCOUNT, usedPercent: 64, source: "header" }),
    ])
    const body = JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "fake" } })
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: SIWC, response: new Response(body, { status: 429, headers: plan("100") }) }),
    )
    const verdict = await t.telemetry.onRetry(retryEvent({ providerID: SIWC, status: 429 }))
    // The plan window's own reset plus the 1–3 minute jitter, not the 15-minute backoff.
    expect(verdict.until).toBeGreaterThanOrEqual(Math.floor(now / 1000) * 1000 + 1_800_000 + 60_000)
    expect(verdict.until).toBeLessThanOrEqual(Math.floor(now / 1000) * 1000 + 1_800_000 + 180_000)
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({
      status: "exhausted",
      reason: "subscription_sharing_usage_limit_exceeded",
    })
  })

  test("a usage limit whose body names its reset is a full siwc.usage window; a later success lifts it", async () => {
    const logs: string[] = []
    await using t = await setup({ registry: siwc(), logs })
    const now = t.clock.now()
    const limited = (extra: Record<string, unknown>) =>
      httpEvent({
        providerID: SIWC,
        response: new Response(
          JSON.stringify({
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "fake",
              type: "invalid_request_error",
              ...extra,
            },
          }),
          { status: 429, headers: { "x-request-id": "req_fake" } },
        ),
      })
    await t.telemetry.onHttpResponse(limited({ resets_in_seconds: 7_200 }))
    const windows = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [SIWC_ACCOUNT] })).windows
    expect(windows).toEqual([
      expect.objectContaining({
        id: "siwc.usage",
        accountID: SIWC_ACCOUNT,
        providerID: SIWC,
        kind: "rolling_quota",
        label: "사용량 한도",
        usedPercent: 100,
        resetAt: now + 7_200_000,
        status: "exhausted",
        source: "error",
      }),
    ])
    // The exhaustion ends with that reset (plus the 1–3 minute jitter), not with the 15-minute backoff.
    const verdict = await t.telemetry.onRetry(retryEvent({ providerID: SIWC, status: 429 }))
    expect(verdict.until).toBeGreaterThanOrEqual(now + 7_200_000 + 60_000)
    expect(verdict.until).toBeLessThanOrEqual(now + 7_200_000 + 180_000)
    // `resets_at` (epoch s) as well; the log line is written once per account.
    await t.telemetry.onHttpResponse(limited({ resets_at: Math.floor(now / 1000) + 3_600 }))
    expect((await ok(t.telemetry.quotaSnapshot, { accountIDs: [SIWC_ACCOUNT] })).windows).toEqual([
      expect.objectContaining({ id: "siwc.usage", resetAt: (Math.floor(now / 1000) + 3_600) * 1000 }),
    ])
    expect(logs.map((line) => JSON.parse(line)).filter((line) => line.msg === "usage_limit_answer")).toEqual([
      expect.objectContaining({
        accountID: SIWC_ACCOUNT,
        providerID: SIWC,
        status: 429,
        headers: ["x-request-id"],
        fields: ["error", "error.code", "error.message", "error.resets_in_seconds", "error.type"],
        reset: true,
      }),
    ])
    // A success before that reset: the limit no longer blocks, so the window shows it reset (estimated, from 0 %).
    t.clock.advance(10 * 60_000)
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: SIWC, response: new Response("data: {}\n\n", { status: 200 }) }),
    )
    t.clock.advance(1_000)
    expect((await ok(t.telemetry.quotaSnapshot, { accountIDs: [SIWC_ACCOUNT] })).windows).toEqual([
      expect.objectContaining({ id: "siwc.usage", usedPercent: 0, status: "ok", confidence: "estimated" }),
    ])
    expect(t.deps.runtime.limits.exhaustion(SIWC_ACCOUNT)).toBeUndefined()
  })

  test("a usage limit's full plan window comes from the plan headers, not from a reset in its body", async () => {
    await using t = await setup({ registry: siwc() })
    const now = t.clock.now()
    const body = JSON.stringify({
      error: { code: "subscription_sharing_usage_limit_exceeded", message: "fake", resets_in_seconds: 60 },
    })
    const headers = {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 1_800),
    }
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: SIWC, response: new Response(body, { status: 429, headers }) }),
    )
    expect(
      (await ok(t.telemetry.quotaSnapshot, { accountIDs: [SIWC_ACCOUNT] })).windows.map((window) => window.id),
    ).toEqual(["codex.primary"])
  })

  test("an answer without plan headers stores no window and logs its header names once per account", async () => {
    // The token-sharing route as the user's 2026-10-10 to 10-22 answers came: no x-codex-* and no x-ratelimit-* pair
    // (the speed hook read those same answers, and state\limits.json kept no siwc window).
    const logs: string[] = []
    await using t = await setup({ registry: siwc(), logs })
    const answer = () =>
      httpEvent({
        providerID: SIWC,
        response: new Response("data: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream", "x-request-id": "req_fake", "openai-processing-ms": "812" },
        }),
      })
    await t.telemetry.onHttpResponse(answer())
    await t.telemetry.onHttpResponse(answer())
    expect((await ok(t.telemetry.quotaSnapshot, { accountIDs: [SIWC_ACCOUNT] })).windows).toEqual([])
    const lines = logs.map((line) => JSON.parse(line)).filter((line) => line.msg === "limits_absent")
    expect(lines).toEqual([
      expect.objectContaining({
        accountID: SIWC_ACCOUNT,
        providerID: SIWC,
        headers: ["content-type", "openai-processing-ms", "x-request-id"],
      }),
    ])
    // Never for another kind.
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: CODEX, response: new Response("", { status: 200, headers: { "x-request-id": "r" } }) }),
    )
    expect(logs.filter((line) => line.includes("limits_absent"))).toHaveLength(1)
  })

  test("quota.snapshot reports an exhaustion in force with the reason account.status announced", async () => {
    await using t = await setup({ registry: siwc() })
    expect((await ok(t.telemetry.quotaSnapshot, {})).exhausted).toEqual([])
    await t.telemetry.onHttpResponse(sharingResponse(429, "subscription_sharing_usage_limit_exceeded"))
    const verdict = await t.telemetry.onRetry(retryEvent({ providerID: SIWC, status: 429 }))
    const reported = { reason: "subscription_sharing_usage_limit_exceeded", until: verdict.until }
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({ status: "exhausted", ...reported })
    const exhausted = (await ok(t.telemetry.quotaSnapshot, {})).exhausted
    expect(exhausted).toHaveLength(1)
    expect(exhausted).toMatchObject([{ accountID: SIWC_ACCOUNT, ...reported }])
    expect((await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).exhausted).toEqual([])
    // Ended: a window reconnecting now (its `ready` lost) learns that from the snapshot.
    t.clock.advance(15 * 60_000)
    expect((await ok(t.telemetry.quotaSnapshot, {})).exhausted).toEqual([])
  })

  test("a model week's exhaustion is not the account's: no account.status (no phone push), none in the snapshot (LV)", async () => {
    await using t = await setup()
    const record = (windowId: string) => ({
      accountID: Account.ID.claudeSlot,
      windowId,
      until: t.clock.now() + 5 * 86_400_000,
      class: "hard" as const,
    })
    const before = t.emitted("account.status").length
    // As own-telemetry records a refused Opus request: the Opus week's record, for Opus only.
    t.deps.runtime.limits.exhaust(record("claude.7d_opus"))
    t.deps.runtime.broadcast.emit("exhausted", {
      exhaustion: record("claude.7d_opus"),
      providerID: "anthropic",
      sessionID: "ses_opus",
    })
    expect(t.emitted("account.status")).toHaveLength(before)
    expect((await ok(t.telemetry.quotaSnapshot, {})).exhausted).toEqual([])
    // The 5 hours are the account's.
    t.deps.runtime.limits.exhaust(record("claude.5h"))
    t.deps.runtime.broadcast.emit("exhausted", { exhaustion: record("claude.5h"), providerID: "anthropic" })
    expect(t.emitted("account.status").at(-1)?.data).toMatchObject({
      accountID: Account.ID.claudeSlot,
      status: "exhausted",
      reason: "claude.5h",
    })
    expect((await ok(t.telemetry.quotaSnapshot, {})).exhausted).toMatchObject([
      { accountID: Account.ID.claudeSlot, reason: "claude.5h" },
    ])
  })

  test("an eligibility 403 (legacy name included) is a hard stop, not an auth failure", async () => {
    await using t = await setup({ registry: siwc() })
    await t.telemetry.onHttpResponse(sharingResponse(403, "subscription_sharing_v2_user_not_eligible"))
    const retry = retryEvent({ providerID: SIWC, status: 403, type: "provider.auth" })
    expect((await t.telemetry.onRetry(retry)).class).toBe("hard")
    expect(retry.decision).toEqual({ retry: false })
    expect(t.calls.unauthorized).toEqual([])
  })

  test("an unsupported feature in a failed stream stops the retries without exhausting the account", async () => {
    await using t = await setup({ registry: siwc() })
    const retry = retryEvent({
      providerID: SIWC,
      type: "provider.invalid-request",
      message: "subscription_sharing_unsupported_capability: temperature is not supported",
    })
    const verdict = await t.telemetry.onRetry(retry)
    expect(verdict.class).toBe("unknown")
    expect(retry.decision).toEqual({ retry: false })
    expect(t.deps.runtime.limits.exhaustion(SIWC_ACCOUNT)).toBeUndefined()
  })

  test("a rejected login is final at once: no retry, needs re-login, auth exhaustion", async () => {
    await using t = await setup({ registry: siwc() })
    await t.telemetry.onHttpResponse(sharingResponse(401, "subscription_sharing_invalid_user"))
    const retry = retryEvent({ providerID: SIWC, status: 401, type: "provider.auth" })
    const verdict = await t.telemetry.onRetry(retry)
    expect(verdict.class).toBe("auth")
    expect(retry.decision).toEqual({ retry: false })
    expect(t.calls.rejected).toEqual([`${SIWC_ACCOUNT}:subscription_sharing_invalid_user`])
    expect(t.calls.unauthorized).toEqual([])
    expect(t.deps.runtime.limits.exhaustion(SIWC_ACCOUNT)).toMatchObject({ class: "auth" })
  })

  test("temporary unavailability keeps core's bounded retry", async () => {
    await using t = await setup({ registry: siwc() })
    await t.telemetry.onHttpResponse(sharingResponse(503, "subscription_sharing_user_unavailable"))
    const retry = retryEvent({ providerID: SIWC, status: 503, type: "provider.internal" })
    expect((await t.telemetry.onRetry(retry)).class).toBe("transient")
    expect(retry.decision).toEqual({ retry: true, delay: 2_000 })
  })
})

describe("OpenRouter's 402 for an unaffordable max_tokens (02 §5.2)", () => {
  const OR = "own-or-tst6"
  const OR_ACCOUNT = "acc_01TESTOR0000000000000000"
  const body = (affordable: number) =>
    JSON.stringify({
      error: {
        code: 402,
        message: `This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford ${affordable}.`,
      },
    })

  test("leaves the account usable while the balance still pays for an answer; an empty one exhausts it", async () => {
    await using t = await setup({
      registry: registry([...DEFAULT_SEEDS, { id: OR_ACCOUNT, kind: "or", providerID: OR }]),
    })
    const retry = retryEvent({ providerID: OR, status: 402, type: "provider.quota", body: body(9_861) })
    const verdict = await t.telemetry.onRetry(retry)
    expect(verdict).toMatchObject({ class: "unknown", accountID: OR_ACCOUNT })
    expect(verdict).not.toHaveProperty("until")
    expect(t.deps.runtime.limits.exhaustion(OR_ACCOUNT)).toBeUndefined()
    expect(t.emitted("account.status").filter((item) => item.data.accountID === OR_ACCOUNT)).toEqual([])

    const empty = retryEvent({ providerID: OR, status: 402, type: "provider.quota", body: body(12) })
    expect(await t.telemetry.onRetry(empty)).toMatchObject({ class: "hard", accountID: OR_ACCOUNT })
    expect(empty.decision).toEqual({ retry: false })
    expect(t.deps.runtime.limits.exhaustion(OR_ACCOUNT)).toMatchObject({ class: "hard" })
  })

  test("the same 402 again soon exhausts the account for the shortest backoff; later it starts over", async () => {
    await using t = await setup({
      registry: registry([...DEFAULT_SEEDS, { id: OR_ACCOUNT, kind: "or", providerID: OR }]),
    })
    const again = () => retryEvent({ providerID: OR, status: 402, type: "provider.quota", body: body(9_861) })
    expect(await t.telemetry.onRetry(again())).toMatchObject({ class: "unknown" })
    t.clock.advance(Telemetry.UNAFFORDABLE_REPEAT_MS + 1)
    // Outside the window the count starts over.
    expect(await t.telemetry.onRetry(again())).toMatchObject({ class: "unknown" })
    expect(t.deps.runtime.limits.exhaustion(OR_ACCOUNT)).toBeUndefined()
    t.clock.advance(60_000)
    const repeat = again()
    expect(await t.telemetry.onRetry(repeat)).toMatchObject({
      class: "hard",
      accountID: OR_ACCOUNT,
      until: t.clock.now() + Telemetry.BACKOFF_MINUTES[0] * 60_000,
    })
    expect(repeat.decision).toEqual({ retry: false })
    expect(t.deps.runtime.limits.exhaustion(OR_ACCOUNT)).toMatchObject({
      class: "hard",
      reason: "max_tokens_unaffordable",
    })
  })
})

describe("ledger", () => {
  test("one line per step with cache fields; duplicates and other Locations are ignored", async () => {
    await using t = await setup()
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const directory = t.deps.location.directory
    const now = t.clock.now()
    const [started, ended] = step({
      providerID: CODEX,
      messageID: "msg_1",
      at: now,
      directory,
      usage: { input: 2_000, read: 8_000, write: 0, output: 100 },
      endedID: "evt_step_1",
    })
    await t.telemetry.onEvent?.(started, { local: true })
    await t.telemetry.onEvent?.(ended, { local: true })
    // The same event again (another subscription) and a foreign Location's step.
    await t.telemetry.onEvent?.(ended, { local: true })
    for (const item of step({
      providerID: CODEX,
      messageID: "msg_x",
      at: now,
      directory: "D:\\elsewhere",
      usage: { input: 5 },
    }))
      await t.telemetry.onEvent?.(item, { local: false })
    await t.telemetry.flush()
    await t.deps.runtime.ledger.flush()

    const lines = await t.deps.runtime.ledger.usageOf(Home.month(now))
    expect(lines).toHaveLength(1)
    expect(lines[0].eid).toBe("evt_step_1")
    expect(lines[0].line).toMatchObject({
      sessionID: SESSION,
      messageID: "msg_1",
      kind: "primary",
      accountID: CODEX_ACCOUNT,
      providerID: CODEX,
      modelID: "gpt-5.5",
      transport: "websocket",
      switchEpoch: 0,
      compactionEpoch: 0,
      tokens: { input: 2_000, cacheRead: 8_000, cacheWrite: 0, cacheWrite1h: null, output: 100, reasoning: 0 },
      P: 10_000,
      hit: 0.8,
      cost: { unit: "credits", amount: 0.425, source: "ratecard" },
    })
    expect(t.emitted("ledger.step")).toHaveLength(1)
    expect(t.emitted("ledger.step")[0].data).toMatchObject({ origin: "session", line: { messageID: "msg_1" } })

    const cache = t.storage.map.get(Kv.cache(SESSION, CODEX))
    // The lifetime counts from the request start (step.started at now), not from the reply end (CC 2026-10-24).
    expect(cache).toMatchObject({ L: 10_000, lastReqAt: now, epoch: 0, modelID: "gpt-5.5", blocksSince: 0 })
    const state = t.emitted("cache.state").at(-1)?.data
    expect(state).toMatchObject({ sessionID: SESSION, slots: [{ providerID: CODEX, state: "warm", L: 10_000 }] })

    // cache.state temperature moves with time: TTL_lo 5 min, TTL_hi unknown → "unknown" afterwards.
    t.clock.advance(6 * 60_000)
    const later = await ok(t.telemetry.cacheState, { sessionID: SESSION })
    expect(later.slots[0].state).toBe("unknown")
  })

  test("ledger.session totals, pagination and switch count; accounts.usage groupings", async () => {
    await using t = await setup()
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const directory = t.deps.location.directory
    const base = t.clock.now()
    const feed = async (items: ReadonlyArray<Parameters<NonNullable<Telemetry.Api["onEvent"]>>[0]>) => {
      for (const item of items) await t.telemetry.onEvent?.(item, { local: true })
    }
    await feed(step({ providerID: CODEX, messageID: "m1", at: base, directory, usage: { input: 1_000, read: 0 } }))
    await feed([modelSelected({ providerID: ANTH, previous: CODEX, at: base + 2_000, directory })])
    await feed(
      step({
        providerID: ANTH,
        modelID: "claude-opus-5-5",
        messageID: "m2",
        at: base + 3_000,
        directory,
        usage: { input: 500, write: 700 },
        cost: 0.01,
      }),
    )
    await feed(
      step({
        providerID: ANTH,
        modelID: "claude-opus-5-5",
        messageID: "m3",
        at: base + 3_700_000,
        directory,
        usage: { input: 50, read: 1_200 },
        cost: 0.002,
      }),
    )
    await t.telemetry.flush()

    const all = await ok(t.telemetry.ledgerSession, { sessionID: SESSION })
    expect(all.steps.map((line) => [line.messageID, line.switchEpoch])).toEqual([
      ["m1", 0],
      ["m2", 1],
      ["m3", 1],
    ])
    expect(all.switchCount).toBe(1)
    expect(all.cursor).toBeUndefined()
    expect(all.totals.byAccount[CODEX_ACCOUNT]).toMatchObject({ requests: 1, cost: [{ unit: "credits", amount: 0.2 }] })
    expect(all.totals.byAccount[ANTH_ACCOUNT]).toMatchObject({
      requests: 2,
      tokens: { input: 550, cacheRead: 1_200, cacheWrite: 700, output: 200, reasoning: 0 },
      cost: [{ unit: "USD", amount: 0.012 }],
    })

    const page = await ok(t.telemetry.ledgerSession, { sessionID: SESSION, limit: 2 })
    expect(page.steps.map((line) => line.messageID)).toEqual(["m2", "m3"])
    const rest = await ok(t.telemetry.ledgerSession, { sessionID: SESSION, limit: 2, cursor: page.cursor })
    expect(rest.steps.map((line) => line.messageID)).toEqual(["m1"])
    expect(rest.cursor).toBeUndefined()

    const hours = await ok(t.telemetry.usage, { from: base - 1, to: base + 4_000_000, groupBy: "hour" })
    expect(hours.rows.map((row) => row.requests)).toEqual([2, 1])
    const sessions = await ok(t.telemetry.usage, { from: base - 1, to: base + 4_000_000, groupBy: "session" })
    expect(sessions.rows).toEqual([
      expect.objectContaining({ key: SESSION, requests: 3, switchCount: 1, accountIDs: [CODEX_ACCOUNT, ANTH_ACCOUNT] }),
    ])
    const models = await ok(t.telemetry.usage, {
      accountID: ANTH_ACCOUNT,
      from: base - 1,
      to: base + 4_000_000,
      groupBy: "model",
    })
    expect(models.rows.map((row) => [row.key, row.requests])).toEqual([["claude-opus-5-5", 2]])
    const missing = await call(t.telemetry.usage, { accountID: "acc_UNKNOWN", from: 0, to: 1, groupBy: "day" } as never)
    expect(missing).toMatchObject({ ok: false, type: "account_not_found" })
  })

  test("compaction.ended writes a compaction line and makes every slot cold", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const now = t.clock.now()
    for (const item of step({ providerID: CODEX, messageID: "m1", at: now, directory, usage: { input: 1_000 } }))
      await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.onEvent?.(
      event({
        type: "session.compaction.ended",
        at: now + 5_000,
        directory,
        data: {
          sessionID: SESSION,
          reason: "auto",
          model: { providerID: CODEX, id: "gpt-5.5" },
          text: "summary",
          recent: "",
          cost: 0,
          tokens: { input: 900, output: 300, reasoning: 0, cache: { read: 100, write: 0 } },
        },
      }),
      { local: true },
    )
    await t.telemetry.flush()
    const session = await ok(t.telemetry.ledgerSession, { sessionID: SESSION })
    expect(session.steps.map((line) => [line.kind, line.compactionEpoch])).toEqual([
      ["primary", 0],
      ["compaction", 0],
    ])
    expect(t.storage.map.get(Kv.epoch(SESSION))).toBe(1)
    expect((await ok(t.telemetry.cacheState, { sessionID: SESSION })).slots[0].state).toBe("cold")
  })

  // SL 2026-10-26: the UI names the account that signed a compaction from its line, found by the compaction message.
  test("a compaction line names its compaction message: the admitted id, the started event's, the failed one's", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const now = t.clock.now()
    for (const item of step({ providerID: CODEX, messageID: "msg_m1", at: now, directory, usage: { input: 1_000 } }))
      await t.telemetry.onEvent?.(item, { local: true })
    const usage = { cost: 0, tokens: { input: 900, output: 300, reasoning: 0, cache: { read: 100, write: 0 } } }
    const ended = { model: { providerID: CODEX, id: "gpt-5.5" }, text: "summary", recent: "", ...usage }
    const send = (type: string, at: number, data: Record<string, unknown>, id?: string) =>
      t.telemetry.onEvent?.(
        event({ type, at, directory, data: { sessionID: SESSION, reason: "auto", ...data }, ...(id ? { id } : {}) }),
        { local: true },
      )
    await send("session.compaction.started", now + 2_000, { recent: "", inputID: "msg_admitted" })
    await send("session.compaction.ended", now + 3_000, ended)
    await send("session.compaction.started", now + 4_000, { recent: "" }, "evt_started_2")
    await send("session.compaction.ended", now + 5_000, ended)
    await send("session.compaction.failed", now + 6_000, {
      inputID: "msg_failed",
      error: { type: "provider", message: "boom" },
      ...usage,
    })
    await t.telemetry.flush()
    const lines = (await ok(t.telemetry.ledgerSession, { sessionID: SESSION })).steps
    expect(lines.map((line) => [line.kind, line.messageID])).toEqual([
      ["primary", "msg_m1"],
      ["compaction", "msg_admitted"],
      ["compaction", "msg_started_2"],
      ["compaction", "msg_failed"],
    ])
    // The compaction message is no breakpoint of a later request: the slot's watermark stays the last step's.
    expect(t.storage.map.get(Kv.cache(SESSION, CODEX))).toMatchObject({ watermark: { messageID: "msg_m1" } })
  })

  // SL 2026-10-26: several Claude accounts share `anthropic`; a company's cache is one account's.
  test("a cache slot names the Claude account that signed its last request", async () => {
    // The plugin's accounts AC-02 and AC-03 (their entries are all the attribution reads).
    const claude = (deps: Parameters<Modules.Factories["claude"]>[0], peers: Module.Peers) => ({
      ...Modules.FACTORIES.claude(deps, peers),
      // SAFETY: telemetry only asks whether the account is listed.
      entry: (accountID: string) =>
        accountID.startsWith("acc_cl") ? ({ accountID } as unknown as ClaudeAccounts.Entry) : undefined,
      accountOf: async () => Account.ID.claudeSlot,
      peek: () => Account.ID.claudeSlot,
    })
    await using t = await setup({ claudeSlot: true, peers: { claude } })
    const directory = t.deps.location.directory
    const now = t.clock.now()
    const slots = async (accountID: string, messageID: string, at: number) => {
      t.deps.runtime.claude.remember(SESSION, accountID)
      for (const item of step({
        providerID: "anthropic",
        modelID: "claude-haiku-5-5",
        messageID,
        at,
        directory,
        usage: { input: 30_000 },
      }))
        await t.telemetry.onEvent?.(item, { local: true })
      await t.telemetry.flush()
      return (await ok(t.telemetry.cacheState, { sessionID: SESSION })).slots
    }
    const named = (list: ReadonlyArray<{ providerID: string; accountID?: string | null }>) =>
      list.map((item) => [String(item.providerID), String(item.accountID)])
    expect(named(await slots("acc_cl3", "msg_s1", now))).toEqual([["anthropic", "acc_cl3"]])
    // SL-8: each account keeps its own entry (newest first); AC-03's stays, aged by AC-02's step.
    expect(named(await slots("acc_cl2", "msg_s2", now + 60_000))).toEqual([
      ["anthropic", "acc_cl2"],
      ["anthropic", "acc_cl3"],
    ])
    expect(t.storage.map.get(Kv.cache(SESSION, "anthropic", "acc_cl3"))).toMatchObject({
      lastReqAt: now,
      blocksSince: 2,
      accountID: "acc_cl3",
    })
    expect(t.storage.map.get(Kv.cache(SESSION, "anthropic", "acc_cl2"))).toMatchObject({
      lastReqAt: now + 60_000,
      blocksSince: 0,
    })
    expect(t.storage.map.has(Kv.cache(SESSION, "anthropic"))).toBe(false)
    expect(named((await ok(t.telemetry.ledgerSession, { sessionID: SESSION })).steps)).toEqual([
      ["anthropic", "acc_cl3"],
      ["anthropic", "acc_cl2"],
    ])
  })

  // SL-8: an `anthropic` entry written before per-account keys is the previous entry of the account it names, and the
  // per-account entry replaces it; one that names another account stays that account's.
  test("an entry from before per-account keys hands over to the account it names", async () => {
    const claude = (deps: Parameters<Modules.Factories["claude"]>[0], peers: Module.Peers) => ({
      ...Modules.FACTORIES.claude(deps, peers),
      // SAFETY: telemetry only asks whether the account is listed.
      entry: (accountID: string) =>
        accountID.startsWith("acc_cl") ? ({ accountID } as unknown as ClaudeAccounts.Entry) : undefined,
      accountOf: async () => Account.ID.make("acc_cl3"),
      peek: () => Account.ID.make("acc_cl3"),
    })
    await using t = await setup({ claudeSlot: true, peers: { claude } })
    const directory = t.deps.location.directory
    const now = t.clock.now()
    const legacy = {
      lastReqAt: now - 120_000,
      L: 20_000,
      epoch: 0,
      modelID: "claude-haiku-5-5",
      variant: null,
      watermark: null,
      blocksSince: 0,
      messageEndsSince: 0,
      imageTrimEpoch: 3,
      accountID: "acc_cl2",
    }
    t.storage.map.set(Kv.cache(SESSION, "anthropic"), legacy)
    const run = async (accountID: string, messageID: string, at: number) => {
      t.deps.runtime.claude.remember(SESSION, accountID)
      for (const item of step({
        providerID: "anthropic",
        modelID: "claude-haiku-5-5",
        messageID,
        at,
        directory,
        usage: { input: 30_000 },
      }))
        await t.telemetry.onEvent?.(item, { local: true })
      await t.telemetry.flush()
    }
    // AC-03's first step: the old entry is AC-02's, so it stays (aged) and AC-03 starts its own.
    await run("acc_cl3", "msg_s1", now)
    expect(t.storage.map.get(Kv.cache(SESSION, "anthropic"))).toMatchObject({ accountID: "acc_cl2", blocksSince: 2 })
    expect(t.storage.map.get(Kv.cache(SESSION, "anthropic", "acc_cl3"))).toMatchObject({ imageTrimEpoch: 0 })
    // AC-02's step takes the old entry over (its image trim epoch carries on) and removes it.
    await run("acc_cl2", "msg_s2", now + 60_000)
    expect(t.storage.map.has(Kv.cache(SESSION, "anthropic"))).toBe(false)
    expect(t.storage.map.get(Kv.cache(SESSION, "anthropic", "acc_cl2"))).toMatchObject({
      imageTrimEpoch: 3,
      lastReqAt: now + 60_000,
    })
    const slots = (await ok(t.telemetry.cacheState, { sessionID: SESSION })).slots
    expect(slots.map((slot) => [String(slot.accountID), slot.lastReqAt])).toEqual([
      ["acc_cl2", now + 60_000],
      ["acc_cl3", now],
    ])
  })

  // SL-17: after a restart the plugin's sync `peek` answers the default account (AC-01) until a request or a binding
  // read ran; `cache.state` compares the session's model with the slot of the account its tree is bound to (AC-03).
  test("after a restart the session's model meets its tree account's slot, not the default account's", async () => {
    const claude = (deps: Parameters<Modules.Factories["claude"]>[0], peers: Module.Peers) => ({
      ...Modules.FACTORIES.claude(deps, peers),
      // SAFETY: telemetry only asks whether the account is listed.
      entry: (accountID: string) =>
        accountID.startsWith("acc_cl") ? ({ accountID } as unknown as ClaudeAccounts.Entry) : undefined,
      accountOf: async () => Account.ID.make("acc_cl3"),
      peek: () => Account.ID.make("acc_cl1"),
    })
    await using t = await setup({ claudeSlot: true, peers: { claude } })
    const directory = t.deps.location.directory
    const now = t.clock.now()
    for (const accountID of ["acc_cl1", "acc_cl3"])
      t.storage.map.set(Kv.cache(SESSION, "anthropic", accountID), {
        lastReqAt: now - 60_000,
        L: 40_000,
        epoch: 0,
        modelID: "claude-haiku-5-5",
        variant: null,
        watermark: null,
        blocksSince: 0,
        messageEndsSince: 0,
        imageTrimEpoch: 0,
        accountID,
      })
    // The conversation moved to Opus since: the Haiku prefix of its own account no longer counts.
    await t.telemetry.onEvent?.(
      event({
        type: "session.model.selected",
        at: now,
        directory,
        data: {
          sessionID: SESSION,
          model: { providerID: "anthropic", id: "claude-opus-5-5" },
          previous: { providerID: "anthropic", id: "claude-haiku-5-5" },
        },
      }),
      { local: true },
    )
    await t.telemetry.flush()
    const slots = (await ok(t.telemetry.cacheState, { sessionID: SESSION })).slots
    expect(
      slots.map((slot) => [String(slot.accountID), slot.state]).toSorted((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ["acc_cl1", "warm"],
      ["acc_cl3", "cold"],
    ])
  })

  test("generate usage is read from a clone of the stream", async () => {
    await using t = await setup()
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const body = [
      { type: "response.output_text.delta", delta: "OK" },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 4_000, input_tokens_details: { cached_tokens: 3_000 }, output_tokens: 2 } },
      },
    ]
      .map((data) => `data: ${JSON.stringify(data)}\n\n`)
      .join("")
    const response = new Response(body, { headers: codexHeaders(10, t.clock.now()) })
    const hook = httpEvent({ providerID: CODEX, kind: "generate", response })
    await t.telemetry.onHttpResponse(hook)
    // Core still reads the original body.
    expect(await hook.response.text()).toBe(body)
    await t.telemetry.flush()
    const [line] = (await ok(t.telemetry.ledgerSession, { sessionID: SESSION })).steps
    expect(line).toMatchObject({
      kind: "generate",
      messageID: null,
      tokens: { input: 1_000, cacheRead: 3_000, output: 2 },
      P: 4_000,
      hit: 0.75,
      cost: { unit: "credits", source: "ratecard" },
      usageSource: "stream",
    })
  })

  test("generate lines without stream usage are estimates; more than three in an hour raise one alert", async () => {
    await using t = await setup()
    for (const index of [0, 1, 2, 3]) {
      const response = new Response(`data: {"type":"response.output_text.delta","delta":"${index}"}\n\n`)
      await t.telemetry.onHttpResponse(httpEvent({ providerID: CODEX, kind: "generate", response }))
      await t.telemetry.flush()
      t.clock.advance(60_000)
    }
    const steps = (await ok(t.telemetry.ledgerSession, { sessionID: SESSION })).steps
    expect(steps.map((line) => [line.kind, line.tokens, line.usageSource])).toEqual(
      Array.from({ length: 4 }, () => ["generate", null, "estimate"]),
    )
    expect(t.emitted("alert").map((item) => [item.data.code, item.data.severity, item.data.origin])).toEqual([
      ["generate_usage_missing", "info", "global"],
    ])
  })
})

describe("alerts", () => {
  test("low_hit after five poor steps on one provider, raised once", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const base = t.clock.now()
    for (const index of [0, 1, 2, 3, 4, 5])
      for (const item of step({
        providerID: CODEX,
        messageID: `m${index}`,
        at: base + index * 10_000,
        directory,
        usage: { input: 13_000, read: 17_000 },
      }))
        await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    expect(t.emitted("alert").map((item) => [item.data.code, item.data.sessionID, item.data.origin])).toEqual([
      ["low_hit", SESSION, "session"],
    ])
  })

  test("return_miss when a slot comes back inside TTL_lo with a cold prefix", async () => {
    await using t = await setup()
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const directory = t.deps.location.directory
    const base = t.clock.now()
    const feed = async (items: ReadonlyArray<Parameters<NonNullable<Telemetry.Api["onEvent"]>>[0]>) => {
      for (const item of items) await t.telemetry.onEvent?.(item, { local: true })
    }
    await feed(step({ providerID: CODEX, messageID: "a1", at: base, directory, usage: { input: 1_000, read: 30_000 } }))
    await feed(
      step({
        providerID: ANTH,
        modelID: "claude-opus-5-5",
        messageID: "b1",
        at: base + 10_000,
        directory,
        usage: { input: 31_000 },
      }),
    )
    await feed(
      step({ providerID: CODEX, messageID: "a2", at: base + 20_000, directory, usage: { input: 33_000, read: 0 } }),
    )
    await t.telemetry.flush()
    expect(t.emitted("alert").map((item) => item.data.code)).toContain("return_miss")
  })

  test("prefix_drift when the cold input of 15 minutes exceeds 3·P", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const base = t.clock.now()
    for (const index of [0, 1, 2, 3])
      for (const item of step({
        providerID: CODEX,
        messageID: `c${index}`,
        at: base + index * 30_000,
        directory,
        usage: { input: 25_000 },
      }))
        await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    expect(t.emitted("alert").map((item) => item.data.code)).toContain("prefix_drift")
  })

  test("a full codex quota window and a large input raise no compaction advice (07 §6.2 #11)", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    await t.telemetry.onHttpResponse(
      httpEvent({ providerID: CODEX, response: new Response("", { headers: codexHeaders(88, t.clock.now()) }) }),
    )
    for (const item of step({
      providerID: CODEX,
      messageID: "big",
      at: t.clock.now(),
      directory,
      usage: { input: 5_000, read: 45_000 },
    }))
      await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    expect(t.emitted("alert")).toEqual([])
  })

  test("flap on A → B → A within ten minutes", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const base = t.clock.now()
    await t.telemetry.onEvent?.(modelSelected({ providerID: CODEX, at: base, directory }), { local: true })
    await t.telemetry.onEvent?.(modelSelected({ providerID: ANTH, previous: CODEX, at: base + 60_000, directory }), {
      local: true,
    })
    await t.telemetry.onEvent?.(modelSelected({ providerID: CODEX, previous: ANTH, at: base + 120_000, directory }), {
      local: true,
    })
    await t.telemetry.flush()
    expect(t.emitted("alert").map((item) => item.data.code)).toEqual(["flap"])
  })

  test("flap on A → B → A when the session started on A (the first selection names A only as previous)", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const base = t.clock.now()
    await t.telemetry.onEvent?.(modelSelected({ providerID: ANTH, previous: CODEX, at: base, directory }), {
      local: true,
    })
    await t.telemetry.onEvent?.(modelSelected({ providerID: CODEX, previous: ANTH, at: base + 60_000, directory }), {
      local: true,
    })
    await t.telemetry.flush()
    expect(t.emitted("alert").map((item) => item.data.code)).toEqual(["flap"])
  })

  test("a global alert repeats only within its subject: another model of the same code is raised (07 §8.1)", async () => {
    await using t = await setup()
    const unverified = (modelID: string) =>
      t.telemetry.alert({ code: "codex_window_unverified", severity: "info", subject: modelID, message: modelID })
    unverified("gpt-6.1-sol")
    unverified("gpt-6.1-sol")
    unverified("gpt-6.2-nova")
    expect(t.emitted("alert").map((item) => item.data.message)).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    // The subject only keys the de-duplication; it is not part of the alert event.
    expect(t.emitted("alert").every((item) => !("subject" in item.data))).toBe(true)
  })

  test("global alerts from a non-leader go through the leader; relayed session alerts go to the session's Location", async () => {
    await using t = await setup()
    const follower = Telemetry.create(
      { ...t.deps, runtime: { ...t.deps.runtime, isLeader: () => false } },
      () => t.modules,
    )
    await follower.start()
    follower.alert({ code: "codex_source_stale", severity: "warning", accountID: CODEX_ACCOUNT, message: "stale" })
    expect(t.emitted("alert").map((item) => [item.data.code, item.data.origin])).toEqual([
      ["codex_source_stale", "global"],
    ])

    // own-telemetry's session alert: emitted once the session's Location is known to be this one.
    await t.telemetry.onEvent?.(
      modelSelected({ providerID: "anthropic", at: t.clock.now(), directory: t.deps.location.directory }),
      {
        local: true,
      },
    )
    t.deps.runtime.broadcast.emit("alert", {
      code: "claude_extra_usage",
      severity: "danger",
      sessionID: SESSION,
      accountID: "acc_claude_slot",
      message: "extra usage",
    })
    expect(t.emitted("alert").at(-1)?.data).toMatchObject({
      code: "claude_extra_usage",
      origin: "session",
      sessionID: SESSION,
    })
    await follower.stop()
  })
})

describe("RPC", () => {
  test("cache.setTtlMode: 5m only in the MVP", async () => {
    await using t = await setup()
    expect(
      await call(t.telemetry.cacheSetTtlMode, { sessionID: SESSION, providerID: ANTH, mode: "5m" } as never),
    ).toMatchObject({
      ok: true,
      output: { mode: "5m" },
    })
    expect(
      await call(t.telemetry.cacheSetTtlMode, { sessionID: SESSION, providerID: ANTH, mode: "1h" } as never),
    ).toMatchObject({
      ok: false,
      type: "unsupported_strategy",
    })
  })

  test("ratecards.get / set round trip and broadcast", async () => {
    await using t = await setup()
    const changes: string[] = []
    t.deps.runtime.broadcast.on("store.changed", (payload) => changes.push(payload.store))
    const saved = await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    expect(saved.cards).toHaveLength(1)
    expect(saved.updatedAt).toBe("2026-09-27")
    expect((await ok(t.telemetry.ratecardsGet, {})).cards[0].match).toEqual({ kind: "codex", model: "gpt-5.5" })
    expect(changes).toEqual(["ratecards"])
  })

  test("quota.snapshot adds the monthly budget window from the ledger", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    for (const item of step({
      providerID: ANTH,
      modelID: "claude-opus-5-5",
      messageID: "m1",
      at: t.clock.now(),
      directory,
      usage: { input: 10 },
      cost: 9,
    }))
      await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    const budget = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [ANTH_ACCOUNT] })).windows.find(
      (window) => window.id === "api.budget_month",
    )
    expect(budget).toMatchObject({
      kind: "budget",
      usedPercent: 90,
      remaining: 1,
      limit: 10,
      status: "warning",
      source: "ledger",
    })
  })
})

describe("balance poller", () => {
  test("DeepSeek /user/balance for opted-in accounts, at most every 15 minutes, leader only", async () => {
    const chat = startFakeOpenAIChat()
    chat.setBalance(hashSecret("fake-key"), { available: true, currency: "CNY", total: "5.00" })
    try {
      await using t = await setup({
        options: { endpoints: { deepseek: chat.baseURL } },
        registry: registry(
          DEFAULT_SEEDS.map((seed) => (seed.id === DS_ACCOUNT ? { ...seed, pollBalance: true } : seed)),
        ),
      })
      t.clock.advance(Poller.TICK_MS)
      await t.telemetry.flush()
      const windows = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [DS_ACCOUNT] })).windows
      expect(windows).toEqual([
        expect.objectContaining({ id: "ds.balance", remaining: 5, unit: "CNY", status: "ok", source: "poll" }),
      ])
      expect(t.calls.headers).toEqual([DS_ACCOUNT])
      t.clock.advance(Poller.TICK_MS)
      await t.telemetry.flush()
      expect(t.calls.headers).toEqual([DS_ACCOUNT])
      expect(chat.requests.filter((request) => request.path.includes("/user/balance"))).toHaveLength(1)
    } finally {
      await chat.stop()
    }
  })

  test("Codex wham/usage fills the gap: only with a ready login, never while the requests report the windows", async () => {
    const codex = startFakeCodex({ weeklyOnly: true })
    const tokens = codex.login({ accountID: "acct-poll", plan: "promax" })
    try {
      const calls = { unauthorized: [], headers: [], rejected: [], accepted: [], refused: [] }
      const auth = { authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": tokens.accountID }
      await using t = await setup({
        options: { endpoints: { chatgpt: `${codex.url}/backend-api` } },
        peers: { logins: fakeLogins(calls, auth) },
      })
      const windows = async () => (await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).windows
      // No stored login (or one about to expire): nothing is asked, nothing refreshed.
      t.clock.advance(Poller.TICK_MS)
      await t.telemetry.flush()
      expect(codex.usagePolls).toEqual([])
      expect(calls.headers).toEqual([])
      await t.deps.runtime.credentials.store(CODEX_ACCOUNT, {
        type: "oauth",
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresAt: t.clock.now() + 3_600_000,
      })
      t.clock.advance(Poller.INTERVAL_MS)
      await t.telemetry.flush()
      expect(codex.usagePolls).toEqual(["acct-poll"])
      expect((await windows()).map((window) => [window.id, window.label, window.source])).toEqual([
        ["codex.primary", "주간", "poll"],
        ["codex.credits", "크레딧", "poll"],
      ])
      // A conversation's frame reports the windows: the next due tick asks nothing while it is fresh.
      t.clock.advance(Poller.INTERVAL_MS - 2 * Poller.TICK_MS)
      const frame = JSON.stringify({
        type: "codex.rate_limits",
        rate_limits: { primary: { used_percent: 9, window_minutes: 10080, reset_at: 1792876670 }, secondary: null },
      })
      t.telemetry.onWsReceive(wsEvent({ providerID: CODEX, frame }))
      t.clock.advance(4 * Poller.TICK_MS)
      await t.telemetry.flush()
      expect(codex.usagePolls).toEqual(["acct-poll"])
      expect((await windows()).find((window) => window.id === "codex.primary")).toMatchObject({
        usedPercent: 9,
        source: "ws_event",
      })
      // Quiet again for the whole interval: asked once more.
      t.clock.advance(Poller.INTERVAL_MS)
      await t.telemetry.flush()
      expect(codex.usagePolls).toEqual(["acct-poll", "acct-poll"])
    } finally {
      await codex.stop()
    }
  })

  test("Codex wham/usage is off for an account whose balance polling was turned off", async () => {
    const codex = startFakeCodex()
    const tokens = codex.login({ accountID: "acct-poll-off" })
    try {
      const calls = { unauthorized: [], headers: [], rejected: [], accepted: [], refused: [] }
      await using t = await setup({
        options: { endpoints: { chatgpt: `${codex.url}/backend-api` } },
        registry: registry(
          DEFAULT_SEEDS.map((seed) => (seed.id === CODEX_ACCOUNT ? { ...seed, pollBalance: false } : seed)),
        ),
        peers: { logins: fakeLogins(calls, { authorization: `Bearer ${tokens.accessToken}` }) },
      })
      await t.deps.runtime.credentials.store(CODEX_ACCOUNT, {
        type: "oauth",
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
        expiresAt: t.clock.now() + 3_600_000,
      })
      t.clock.advance(Poller.INTERVAL_MS)
      await t.telemetry.flush()
      expect(codex.usagePolls).toEqual([])
    } finally {
      await codex.stop()
    }
  })
})

describe("revert committed (02 §4.7.4)", () => {
  test("moves the cold point epoch, re-baselines every slot and emits cache.state", async () => {
    await using t = await setup()
    await ok(t.telemetry.ratecardsSet, { cards: [CODEX_CARD] })
    const directory = t.deps.location.directory
    const now = t.clock.now()
    for (const item of step({
      providerID: CODEX,
      messageID: "msg_0005",
      at: now,
      directory,
      usage: { input: 2_000, read: 8_000 },
    }))
      await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    expect(t.storage.map.get(Kv.cache(SESSION, CODEX))).toMatchObject({
      epoch: 0,
      watermark: { messageID: "msg_0005" },
    })
    const before = t.emitted("cache.state").length

    const committed = event({
      type: "session.revert.committed",
      at: now + 5_000,
      directory,
      data: { sessionID: SESSION, to: "msg_0003" },
    })
    await t.telemetry.onEvent?.(committed, { local: true })
    await t.telemetry.flush()
    expect(t.storage.map.get(Kv.epoch(SESSION))).toBe(1)
    // The watermark pointed past the boundary: dropped; the counters restart.
    expect(t.storage.map.get(Kv.cache(SESSION, CODEX))).toMatchObject({ watermark: null, blocksSince: 0, L: 10_000 })
    expect(t.emitted("cache.state").length).toBe(before + 1)
    expect(t.emitted("cache.state").at(-1)?.data).toMatchObject({ slots: [{ providerID: CODEX, state: "cold" }] })
  })
})
