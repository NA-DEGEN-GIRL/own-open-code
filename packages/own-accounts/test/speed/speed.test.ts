// 02 §4.8 speed module: per-session choice, offers discovered per account, request edits, the fallback on a refused
// tier, downgrade detection, the Anthropic beta that stays, subagent inheritance and the Claude slot's consent. Real
// slots, Codex metadata and runtime; every account, token and response is made up.

import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { Account, Kv, Speed } from "@own/protocol"
import { Hooks } from "../../src/hooks.js"
import { failure, rpcContext } from "../slots/support.js"
import {
  ANTH,
  CODEX_A,
  CODEX_B,
  DS,
  OAI,
  SIWC,
  contextEvent,
  httpRequest,
  httpResponse,
  responsesSse,
  retryEvent,
  speedSetup,
  wsReceive,
} from "./support.js"

const ROOT = "ses_root"
const CHILD = "ses_child"
const sid = (id: string) => SessionID.make(id)

/** `session.speed.get` of a session; a declared error fails the test. */
async function viewOf(s: Awaited<ReturnType<typeof speedSetup>>, sessionID: string) {
  const value = await s.speed.get({ sessionID: sid(sessionID) }, rpcContext())
  if (!("offers" in value)) throw new Error(`session.speed.get failed: ${JSON.stringify(value)}`)
  return value
}

/** The account catalog row of gpt-6.1-sol as `GET /v1/models` lists it for a plan with both tiers. */
const SOL_LISTED = {
  slug: "gpt-6.1-sol",
  display_name: "GPT-6.1 Sol",
  visibility: "list",
  context_window: 400_000,
  input_modalities: ["text"],
  service_tiers: [
    { id: "priority", name: "Fast" },
    { id: "ultrafast", name: "Ultrafast" },
  ],
}

/** A Responses SSE whose created and completed events name these tiers (none when absent). */
function sse(tiers: ReadonlyArray<string>) {
  const event = (type: string, tier: string | undefined) =>
    `data: ${JSON.stringify({ type, response: tier === undefined ? {} : { service_tier: tier } })}`
  const text = [event("response.created", tiers[0]), "", event("response.completed", tiers[1]), ""].join("\n")
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
}

describe("Speed: offers and the stored choice", () => {
  test("a new conversation is Standard; each Codex account offers what its own list names", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    s.session("ses_b", CODEX_B, "gpt-6-astra")
    const view = await viewOf(s, ROOT)
    expect(view).toMatchObject({ choice: "standard", effective: "standard", tier: null, beta: false })
    expect(view.offers).toEqual([
      {
        choice: "fast",
        tier: "priority",
        wire: "service_tier",
        basis: "account",
        status: "available",
        name: "Fast",
        billing: { type: "plan", included: 2.5, credits: 2 },
      },
      {
        choice: "ultrafast",
        tier: "ultrafast",
        wire: "service_tier",
        basis: "account",
        status: "available",
        name: "Ultrafast",
        billing: { type: "plan", included: 8, credits: 6 },
      },
    ])
    const other = await viewOf(s, "ses_b")
    expect(other.offers.map((offer) => offer.choice)).toEqual(["fast"])
    // A model the account lists without tiers offers none; nothing is stored by reading.
    s.session("ses_luna", CODEX_A, "gpt-6-luna")
    expect((await viewOf(s, "ses_luna")).offers).toEqual([])
    expect(s.kv.values.has(Kv.speed(ROOT))).toBe(false)
  })

  test("set: a dry run estimates and stores nothing; set stores the root's choice and announces it", async () => {
    await using s = await speedSetup()
    s.session(ROOT, OAI, "gpt-6-astra")
    const dry = await s.speed.set({ sessionID: sid(ROOT), speed: "fast", dryRun: true }, rpcContext())
    if ("type" in dry) throw new Error("dry run failed")
    expect(dry.dryRun).toBe(true)
    expect(dry.view).toMatchObject({ choice: "fast", effective: "fast", tier: "priority" })
    // An API key: the mode price is twice the base price; without a measured tier change the cache is a range.
    expect(dry.change).toMatchObject({ from: "standard", to: "fast", unit: "USD", factor: 2, cache: "unknown" })
    expect(s.kv.values.has(Kv.speed(ROOT))).toBe(false)
    const done = await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    if ("type" in done) throw new Error("set failed")
    expect(done.view).toMatchObject({ choice: "fast", effective: "fast", tier: "priority" })
    expect(s.kv.values.get(Kv.speed(ROOT))).toMatchObject({ choice: "fast" })
    await s.settle()
    expect(s.changes()).toEqual([[ROOT, "user", "fast"]])
  })

  test("a speed the main does not offer is refused, as is a fixed-speed mode entry", async () => {
    await using s = await speedSetup()
    s.session("ses_b", CODEX_B, "gpt-6-astra")
    expect(failure(await s.speed.set({ sessionID: sid("ses_b"), speed: "ultrafast" }, rpcContext()))).toMatchObject({
      type: "speed_unavailable",
      data: { speed: "ultrafast", reason: "not_offered" },
    })
    s.session("ses_mode", OAI, "gpt-6-astra-fast")
    const view = await viewOf(s, "ses_mode")
    expect(view).toMatchObject({ fixed: "fast", effective: "fast", offers: [] })
    expect(failure(await s.speed.set({ sessionID: sid("ses_mode"), speed: "fast" }, rpcContext()))).toMatchObject({
      type: "speed_unavailable",
      data: { reason: "fixed_model" },
    })
    // Back to Standard is always allowed.
    expect(failure(await s.speed.set({ sessionID: sid("ses_mode"), speed: "standard" }, rpcContext()))).toBeUndefined()
  })
})

describe("Speed: a main's offers before a session exists (speed.offers, 2026-10-10)", () => {
  /** `speed.offers` of a main; a declared error fails the test. */
  async function offersOf(s: Awaited<ReturnType<typeof speedSetup>>, providerID: string, modelID: string) {
    const value = await s.speed.offers(
      { providerID: Provider.ID.make(providerID), modelID: Model.ID.make(modelID) },
      rpcContext(),
    )
    if (!("offers" in value)) throw new Error(`speed.offers failed: ${JSON.stringify(value)}`)
    return value
  }

  test("the same offers as a session on that main; without one, why: kind, model or provider", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    const codex = await offersOf(s, CODEX_A, "gpt-6-astra")
    expect(codex.offers).toEqual((await viewOf(s, ROOT)).offers)
    expect(codex.offers.map((offer) => offer.choice)).toEqual(["fast", "ultrafast"])
    expect(codex.none).toBeUndefined()
    // Each account's own list: the other plan lists Fast only.
    expect((await offersOf(s, CODEX_B, "gpt-6-astra")).offers.map((offer) => offer.choice)).toEqual(["fast"])
    // A Codex model its account lists without tiers, DeepSeek (no tier at all), a provider own does not run.
    expect(await offersOf(s, CODEX_A, "gpt-6-luna")).toEqual({
      providerID: CODEX_A,
      modelID: "gpt-6-luna",
      offers: [],
      none: "model",
    })
    expect(await offersOf(s, DS, "deepseek-flash")).toMatchObject({ offers: [], none: "kind" })
    expect(await offersOf(s, "anthropic", "claude-opus-5-5")).toMatchObject({ offers: [], none: "provider" })
    expect(s.kv.values.has(Kv.speed(ROOT))).toBe(false)
  })

  test("the Claude slot says whether Fast still needs the usage-credit consent", async () => {
    await using s = await speedSetup({ claude: true })
    const claude = await offersOf(s, "anthropic", "claude-opus-5-5")
    expect(claude).toMatchObject({ consent: "needed", offers: [{ choice: "fast", billing: { type: "extra" } }] })
    expect(claude.none).toBeUndefined()
  })

  test("a session the service does not know yet (an optimistic create) says so instead of a plausible empty view", async () => {
    await using s = await speedSetup()
    expect(await viewOf(s, "ses_unknown")).toMatchObject({ offers: [], choice: "standard", none: "session" })
    s.session("ses_ds", DS, "deepseek-flash")
    expect(await viewOf(s, "ses_ds")).toMatchObject({ offers: [], none: "kind" })
  })
})

describe("Speed: OpenAI-family requests", () => {
  test("the root's speed goes as serviceTier on context and compaction, never on generate", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    const standard = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.onRequestShape(standard, "context")
    expect(standard.options).toEqual({})
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    for (const hook of ["context", "compaction"] as const) {
      const event = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
      await s.speed.onRequestShape(event, hook)
      expect(event.options.serviceTier).toBe("ultrafast")
    }
    const generate = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.onRequestShape(generate, "generate")
    expect(generate.options).toEqual({})
    // Not an own OpenAI-family slot: untouched.
    const other = contextEvent(ROOT, "openai", "gpt-6-astra")
    await s.speed.onRequestShape(other, "context")
    expect(other.options).toEqual({})
  })

  test("a child inherits on the root main's account when its model lists the speed; never elsewhere", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    const shaped = async (sessionID: string, providerID: string, modelID: string) => {
      s.session(sessionID, providerID, modelID, ROOT)
      const event = contextEvent(sessionID, providerID, modelID)
      await s.speed.onRequestShape(event, "context")
      return event.options.serviceTier
    }
    // `메인과 같게`: the same account and model.
    expect(await shaped(CHILD, CODEX_A, "gpt-6-astra")).toBe("ultrafast")
    // The account's lighter model lists only Fast: Standard, not a slower fallback.
    expect(await shaped("ses_light", CODEX_A, "gpt-6-sol")).toBeUndefined()
    // Another account of the same company, or an API key: never.
    expect(await shaped("ses_other", CODEX_B, "gpt-6-astra")).toBeUndefined()
    expect(await shaped("ses_api", OAI, "gpt-6-astra")).toBeUndefined()
    const view = await viewOf(s, CHILD)
    expect(view).toMatchObject({ root: ROOT, choice: "ultrafast", effective: "ultrafast" })
  })

  test("a refused Ultrafast falls back to Fast at once, until the account's list is read again", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    await s.speed.onRequestShape(contextEvent(ROOT, CODEX_A, "gpt-6-astra"), "context")
    // The Codex WebSocket answers with an error frame before any output (the exact text is ⚠ live check 2).
    s.speed.onWsReceive(
      wsReceive(ROOT, CODEX_A, "gpt-6-astra", {
        type: "error",
        status: 400,
        error: { type: "invalid_request_error", message: "service_tier 'ultrafast' is not available for this plan" },
      }),
    )
    const retry = retryEvent(ROOT, CODEX_A, "gpt-6-astra", { type: "provider.invalid-request", message: "bad request" })
    await s.speed.onRetry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    const next = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.onRequestShape(next, "context")
    expect(next.options.serviceTier).toBe("priority")
    const view = await viewOf(s, ROOT)
    expect(view).toMatchObject({ choice: "ultrafast", effective: "fast", tier: "priority" })
    expect(view.offers.find((offer) => offer.choice === "ultrafast")).toMatchObject({
      status: "unavailable",
      reason: "status_400",
    })
    expect(s.alerts.map((alert) => [alert.code, alert.fields?.tier])).toEqual([["speed_fallback", "ultrafast"]])
    await s.settle()
    expect(s.changes()).toContainEqual([ROOT, "fallback", "fast"])
    // The account was not switched: the binding is as it was, and no other slot was asked.
    expect(s.t.deps.runtime.sessions.get(ROOT)?.providerID).toBe(CODEX_A)
    // The list is read again (a codex-meta fetch): Ultrafast is offered again.
    s.t.deps.runtime.speed.clear("acc_aaaa")
    const again = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.onRequestShape(again, "context")
    expect(again.options.serviceTier).toBe("ultrafast")
  })

  test("the Codex backend's Unsupported service_tier frame says why in Korean, with its own words", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    await s.speed.onRequestShape(contextEvent(ROOT, CODEX_A, "gpt-6-astra"), "context")
    // The frame as the backend sends it (live, 2026-10-18).
    s.speed.onWsReceive(
      wsReceive(ROOT, CODEX_A, "gpt-6-astra", {
        type: "error",
        status: 400,
        error: { type: "invalid_request_error", message: "Unsupported service_tier: ultrafast" },
      }),
    )
    const retry = retryEvent(ROOT, CODEX_A, "gpt-6-astra", { type: "provider.invalid-request", message: "bad request" })
    await s.speed.onRetry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    const offer = (await viewOf(s, ROOT)).offers.find((item) => item.choice === "ultrafast")
    expect(offer).toMatchObject({ status: "unavailable", reason: "unsupported_tier" })
    expect(s.alerts).toEqual([
      expect.objectContaining({
        code: "speed_fallback",
        fields: expect.objectContaining({ reason: "unsupported_tier", detail: "Unsupported service_tier: ultrafast" }),
        message: expect.stringContaining("이 계정·모델은 그 속도를 지원하지 않는다고 답했습니다."),
      }),
    ])
    expect(s.alerts[0]?.message).toContain('provider 답: "Unsupported service_tier: ultrafast"')
  })

  test("an error that is not the tier's leaves the retry alone", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    await s.speed.onRequestShape(contextEvent(ROOT, CODEX_A, "gpt-6-astra"), "context")
    const retry = retryEvent(ROOT, CODEX_A, "gpt-6-astra", {
      type: "provider.rate-limit",
      message: "usage_limit_reached",
      status: 429,
    })
    await s.speed.onRetry(retry)
    expect(retry.decision).toEqual({ retry: false })
    expect(s.alerts).toEqual([])
  })

  test("Sign in with ChatGPT: catalog tiers are unverified; unsupported_capability makes Fast unavailable", async () => {
    await using s = await speedSetup()
    s.session(ROOT, SIWC, "gpt-6-astra")
    const view = await viewOf(s, ROOT)
    expect(view.offers.map((offer) => [offer.choice, offer.basis, offer.status])).toEqual([
      ["fast", "catalog", "unverified"],
      ["ultrafast", "catalog", "unverified"],
    ])
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    await s.speed.onRequestShape(contextEvent(ROOT, SIWC, "gpt-6-astra"), "context")
    await s.speed.onHttpResponse(
      httpResponse(
        ROOT,
        SIWC,
        "gpt-6-astra",
        new Response(
          JSON.stringify({
            error: {
              code: "subscription_sharing_unsupported_capability",
              param: "service_tier",
              message: "Remove the unsupported service-tier override.",
            },
          }),
          { status: 400 },
        ),
      ),
    )
    const retry = retryEvent(ROOT, SIWC, "gpt-6-astra", { type: "provider.invalid-request", message: "400" })
    await s.speed.onRetry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    // A real refusal says why, in Korean and in the route's own words, and the toast gets the code.
    expect(s.alerts).toEqual([
      expect.objectContaining({
        code: "speed_fallback",
        fields: expect.objectContaining({
          reason: "subscription_sharing_unsupported_capability",
          detail: "Remove the unsupported service-tier override.",
        }),
        message: expect.stringContaining("구독 공유는 그 속도를 지원하지 않습니다."),
      }),
    ])
    await s.modules.speed.stop()
    expect(s.events.filter((item) => item.name === "session.speed.changed").at(-1)?.payload).toMatchObject({
      reason: "fallback",
      cause: "subscription_sharing_unsupported_capability",
    })
    const next = contextEvent(ROOT, SIWC, "gpt-6-astra")
    await s.speed.onRequestShape(next, "context")
    expect(next.options.serviceTier).toBeUndefined()
    expect((await viewOf(s, ROOT)).effective).toBe("standard")
    // The account's catalog names tiers after all (`accounts.test`): they are the account's and confirmed.
    s.speed.sharing("acc_ssss", [
      {
        slug: "gpt-6-astra",
        display_name: "GPT-6 Astra",
        visibility: "list",
        context_window: 400_000,
        input_modalities: ["text"],
        service_tiers: [{ id: "priority", name: "Fast" }],
      },
    ])
    const listed = await viewOf(s, ROOT)
    expect(listed.offers.map((offer) => [offer.choice, offer.basis, offer.status])).toEqual([
      ["fast", "account", "available"],
    ])
  })

  test("a silent downgrade is the ledger's served tier, a grey badge and an alert", async () => {
    await using s = await speedSetup()
    s.session(ROOT, OAI, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    await s.speed.onRequestShape(contextEvent(ROOT, OAI, "gpt-6-astra"), "context")
    await s.speed.onHttpResponse(httpResponse(ROOT, OAI, "gpt-6-astra", responsesSse("default")))
    await s.modules.speed.stop()
    const tokens = { input: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null, output: 10, reasoning: 0 }
    expect(s.speed.step({ sessionID: ROOT, providerID: OAI, endedAt: s.t.clock.now(), tokens })).toEqual({
      requested: "priority",
      served: "default",
    })
    expect((await viewOf(s, ROOT)).served).toMatchObject({
      requested: "priority",
      served: "default",
      downgraded: true,
    })
    expect(s.alerts.map((alert) => alert.code)).toEqual(["speed_downgraded"])
  })

  test("Sign in with ChatGPT reports no served tier either: default answers leave the listed Ultrafast on", async () => {
    // The user's sessions (2026-10-10 to 10-22, siwc, gpt-6.1-sol and gpt-6-astra): every answer to `ultrafast` and
    // `priority` named `default` (three named none), while those steps decoded faster than the account's
    // Standard ones. The 2026-10-10, 10-18 and 10-22 reports (Ultrafast → Fast → Standard) were own's misreading.
    await using s = await speedSetup()
    s.session(ROOT, SIWC, "gpt-6.1-sol")
    s.speed.sharing("acc_ssss", [SOL_LISTED])
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    const sent: unknown[] = []
    for (const answer of [responsesSse("default"), sse(["default", "default"]), sse([]), responsesSse("default")]) {
      const event = contextEvent(ROOT, SIWC, "gpt-6.1-sol")
      await s.speed.onRequestShape(event, "context")
      sent.push(event.options.serviceTier)
      await s.speed.onHttpResponse(httpResponse(ROOT, SIWC, "gpt-6.1-sol", answer))
      await s.modules.speed.stop()
    }
    expect(sent).toEqual(["ultrafast", "ultrafast", "ultrafast", "ultrafast"])
    expect(s.changes()).toEqual([[ROOT, "user", "ultrafast"]])
    expect(s.alerts).toEqual([])
    const view = await viewOf(s, ROOT)
    expect(view).toMatchObject({ choice: "ultrafast", effective: "ultrafast", tier: "ultrafast" })
    expect(view.served).toBeUndefined()
    expect(view.offers.map((offer) => [offer.choice, offer.basis, offer.status])).toEqual([
      ["fast", "account", "available"],
      ["ultrafast", "account", "available"],
    ])
    // The ledger bills the tier sent: the answer did not say another.
    const tokens = { input: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null, output: 10, reasoning: 0 }
    expect(s.speed.step({ sessionID: ROOT, providerID: SIWC, endedAt: s.t.clock.now(), tokens })).toEqual({
      requested: "ultrafast",
      served: null,
    })
  })

  test("Sign in with ChatGPT: a slower tier the answer names itself counts; three in a row fall back once", async () => {
    await using s = await speedSetup()
    s.session(ROOT, SIWC, "gpt-6.1-sol")
    s.speed.sharing("acc_ssss", [SOL_LISTED])
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    const send = async (served: string) => {
      const event = contextEvent(ROOT, SIWC, "gpt-6.1-sol")
      await s.speed.onRequestShape(event, "context")
      await s.speed.onHttpResponse(httpResponse(ROOT, SIWC, "gpt-6.1-sol", responsesSse(served)))
      await s.modules.speed.stop()
      return event.options.serviceTier
    }
    expect(await send("priority")).toBe("ultrafast")
    expect(s.changes()).toEqual([
      [ROOT, "user", "ultrafast"],
      [ROOT, "downgraded", "ultrafast"],
    ])
    expect(await send("priority")).toBe("ultrafast")
    // Announced once per run: the second slower answer adds no notice and no alert.
    expect(s.changes()).toHaveLength(2)
    expect(await send("priority")).toBe("ultrafast")
    expect(s.changes().at(-1)).toEqual([ROOT, "ignored", "fast"])
    expect(s.alerts.map((alert) => [alert.code, alert.fields?.reason])).toEqual([
      ["speed_downgraded", undefined],
      ["speed_fallback", "ignored"],
    ])
    expect(s.alerts[0]?.message).toBe(
      "gpt-6.1-sol에 ultrafast로 보낸 요청을 provider가 priority(Fast 속도, 그 요금)로 처리했습니다.",
    )
    const fell = await viewOf(s, ROOT)
    expect(fell).toMatchObject({ choice: "ultrafast", effective: "fast", tier: "priority" })
    expect(fell.offers.map((offer) => [offer.choice, offer.status, offer.reason])).toEqual([
      ["fast", "available", undefined],
      ["ultrafast", "unavailable", "ignored"],
    ])
    // Fast answered `default` is unreported as well: no notice, Fast stays.
    expect(await send("default")).toBe("priority")
    expect(s.changes()).toHaveLength(3)
    // The account's list read again tries Ultrafast once more.
    s.speed.sharing("acc_ssss", [SOL_LISTED])
    expect(await send("default")).toBe("ultrafast")
  })

  test("a tier honored before is downgraded only for a while: one notice per run, never marked", async () => {
    await using s = await speedSetup()
    s.session(ROOT, OAI, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    const send = async (served: string) => {
      await s.speed.onRequestShape(contextEvent(ROOT, OAI, "gpt-6-astra"), "context")
      await s.speed.onHttpResponse(httpResponse(ROOT, OAI, "gpt-6-astra", responsesSse(served)))
      await s.modules.speed.stop()
    }
    await send("priority")
    for (const _ of [1, 2, 3, 4]) await send("default")
    expect(s.changes()).toEqual([
      [ROOT, "user", "fast"],
      [ROOT, "downgraded", "fast"],
    ])
    expect((await viewOf(s, ROOT)).offers.find((offer) => offer.choice === "fast")?.status).toBe("available")
    await send("priority")
    await send("default")
    expect(s.changes().filter((change) => change[1] === "downgraded")).toHaveLength(2)
    expect(s.alerts.every((alert) => alert.code === "speed_downgraded")).toBe(true)
  })

  test("Codex reports no served tier: auto and default answers leave Ultrafast and Fast as they are", async () => {
    // Live 2026-10-18 (account 01, gpt-6-astra): `response.created` says `auto` and `response.completed` says
    // `default` whatever was sent, over the WebSocket and HTTP alike, while `ultrafast` streamed about 8 times and
    // `priority` about 1.6 times faster than Standard. Codex CLI never reads the field.
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    const frame = (type: string, tier: string) =>
      wsReceive(ROOT, CODEX_A, "gpt-6-astra", { type, sequence_number: 0, response: { service_tier: tier } })
    const sent: unknown[] = []
    for (const _ of [1, 2, 3, 4]) {
      const event = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
      await s.speed.onRequestShape(event, "context")
      sent.push(event.options.serviceTier)
      s.speed.onWsReceive(frame("response.created", "auto"))
      s.speed.onWsReceive(frame("response.in_progress", "auto"))
      s.speed.onWsReceive(frame("response.completed", "default"))
      await s.modules.speed.stop()
    }
    // The same over HTTP (a compaction): the SSE copy names the same tiers.
    const compaction = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.onRequestShape(compaction, "compaction")
    sent.push(compaction.options.serviceTier)
    const sse = new Response(
      [
        `data: ${JSON.stringify({ type: "response.created", response: { service_tier: "auto" } })}`,
        "",
        `data: ${JSON.stringify({ type: "response.completed", response: { service_tier: "default" } })}`,
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
    await s.speed.onHttpResponse(httpResponse(ROOT, CODEX_A, "gpt-6-astra", sse))
    await s.modules.speed.stop()
    expect(sent).toEqual(["ultrafast", "ultrafast", "ultrafast", "ultrafast", "ultrafast"])
    expect(s.changes()).toEqual([[ROOT, "user", "ultrafast"]])
    expect(s.alerts).toEqual([])
    const view = await viewOf(s, ROOT)
    expect(view).toMatchObject({ choice: "ultrafast", effective: "ultrafast", tier: "ultrafast" })
    expect(view.served).toBeUndefined()
    expect(view.offers.map((offer) => [offer.choice, offer.status])).toEqual([
      ["fast", "available"],
      ["ultrafast", "available"],
    ])
    // The ledger bills the tier sent: the response did not say another.
    const tokens = { input: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null, output: 10, reasoning: 0 }
    expect(s.speed.step({ sessionID: ROOT, providerID: CODEX_A, endedAt: s.t.clock.now(), tokens })).toEqual({
      requested: "ultrafast",
      served: null,
    })
  })

  test("over the Codex WebSocket the ending event decides: a slower tier it names itself is a downgrade", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "ultrafast" }, rpcContext())
    for (const _ of [1, 2, 3]) {
      await s.speed.onRequestShape(contextEvent(ROOT, CODEX_A, "gpt-6-astra"), "context")
      const frame = (type: string, tier: string) =>
        wsReceive(ROOT, CODEX_A, "gpt-6-astra", { type, response: { service_tier: tier } })
      s.speed.onWsReceive(frame("response.created", "ultrafast"))
      s.speed.onWsReceive(frame("response.completed", "priority"))
      await s.modules.speed.stop()
    }
    expect(s.changes().map((change) => change[1])).toEqual(["user", "downgraded", "ignored"])
    expect(await viewOf(s, ROOT)).toMatchObject({
      effective: "fast",
      served: { requested: "ultrafast", served: "priority", downgraded: true },
    })
  })

  test("the first request after a tier change says whether the cache was kept", async () => {
    await using s = await speedSetup()
    s.session(ROOT, CODEX_A, "gpt-6-astra")
    const step = async (cacheRead: number) => {
      await s.speed.onRequestShape(contextEvent(ROOT, CODEX_A, "gpt-6-astra"), "context")
      s.t.clock.advance(1_000)
      const tokens = {
        input: 100_000 - cacheRead,
        cacheRead,
        cacheWrite: 0,
        cacheWrite1h: null,
        output: 10,
        reasoning: 0,
      }
      return s.speed.step({ sessionID: ROOT, providerID: CODEX_A, endedAt: s.t.clock.now(), tokens })
    }
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    expect(await step(0)).toEqual({ requested: "priority", served: null })
    expect(await step(99_000)).toEqual({ requested: "priority", served: null })
    expect(s.t.deps.runtime.speed.retention("codex")).toBeUndefined()
    await s.speed.set({ sessionID: sid(ROOT), speed: "standard" }, rpcContext())
    expect(await step(99_000)).toBeUndefined()
    expect(s.t.deps.runtime.speed.retention("codex")).toEqual({ kept: 1, lost: 0 })
  })
})

describe("Speed: Anthropic requests", () => {
  test("Fast adds speed and the beta; the beta stays when Fast goes off; a compaction drops it", async () => {
    await using s = await speedSetup()
    s.session(ROOT, ANTH, "claude-opus-5-5")
    const standard = httpRequest(ROOT, ANTH, "claude-opus-5-5")
    const untouched = standard.request
    await s.speed.onHttpRequest(standard)
    expect(standard.request).toBe(untouched)
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    const fast = httpRequest(ROOT, ANTH, "claude-opus-5-5")
    await s.speed.onHttpRequest(fast)
    expect(fast.request.headers.get("anthropic-beta")).toBe(`interleaved-thinking-2025-05-14,${Speed.ANTHROPIC_BETA}`)
    expect(await fast.request.json()).toMatchObject({ speed: "fast" })
    expect(s.kv.values.get(Kv.speed(ROOT))).toMatchObject({ choice: "fast", beta: { modelID: "claude-opus-5-5" } })
    // Off again: the header is part of the cache key, so it stays and only `speed` goes.
    await s.speed.set({ sessionID: sid(ROOT), speed: "standard" }, rpcContext())
    const after = httpRequest(ROOT, ANTH, "claude-opus-5-5")
    await s.speed.onHttpRequest(after)
    expect(after.request.headers.get("anthropic-beta")).toContain(Speed.ANTHROPIC_BETA)
    expect(await after.request.json()).not.toHaveProperty("speed")
    expect((await viewOf(s, ROOT)).beta).toBe(true)
    // A title or generate request is another prompt: untouched.
    const title = httpRequest(ROOT, ANTH, "claude-opus-5-5", "title")
    const titleRequest = title.request
    await s.speed.onHttpRequest(title)
    expect(title.request).toBe(titleRequest)
    // A compaction rebuilds the prefix: the next Standard request goes without the header.
    await s.speed.onEvent?.(
      // SAFETY: the speed module reads the type and the session id of the event.
      { type: "session.compaction.ended", data: { sessionID: sid(ROOT) } } as never,
      { local: true },
    )
    const compacted = httpRequest(ROOT, ANTH, "claude-opus-5-5")
    const plain = compacted.request
    await s.speed.onHttpRequest(compacted)
    expect(compacted.request).toBe(plain)
  })

  test("Anthropic's fast 429 sends Standard during a cooldown, then Fast again", async () => {
    await using s = await speedSetup()
    s.session(ROOT, ANTH, "claude-opus-5-5")
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    await s.speed.onHttpRequest(httpRequest(ROOT, ANTH, "claude-opus-5-5"))
    await s.speed.onHttpResponse(
      httpResponse(
        ROOT,
        ANTH,
        "claude-opus-5-5",
        new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "retry-after": "5" },
        }),
      ),
    )
    const retry = retryEvent(ROOT, ANTH, "claude-opus-5-5", {
      type: "provider.rate-limit",
      message: "429",
      status: 429,
    })
    await s.speed.onRetry(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
    const cooling = await viewOf(s, ROOT)
    expect(cooling).toMatchObject({ choice: "fast", effective: "standard", tier: null, beta: true })
    expect(cooling.offers[0]).toMatchObject({ status: "cooldown", reason: "status_429" })
    const during = httpRequest(ROOT, ANTH, "claude-opus-5-5")
    await s.speed.onHttpRequest(during)
    expect(during.request.headers.get("anthropic-beta")).toContain(Speed.ANTHROPIC_BETA)
    expect(await during.request.json()).not.toHaveProperty("speed")
    // The cooldown (at least a minute) ends: Fast again, and the root hears it.
    s.t.clock.advance(61_000)
    await s.settle()
    expect(s.changes()).toContainEqual([ROOT, "cooldown", "standard"])
    expect(s.changes()).toContainEqual([ROOT, "recovered", "fast"])
    const recovered = httpRequest(ROOT, ANTH, "claude-opus-5-5")
    await s.speed.onHttpRequest(recovered)
    expect(await recovered.request.json()).toMatchObject({ speed: "fast" })
  })
})

describe("Speed: the Claude subscription slot (02 §8.3 I5a)", () => {
  test("Fast needs the one-time usage-credit consent; then the slot's requests carry speed and the beta", async () => {
    await using s = await speedSetup({ claude: true })
    s.session(ROOT, "anthropic", "claude-opus-5-5")
    const view = await viewOf(s, ROOT)
    expect(view).toMatchObject({ consent: "needed", effective: "standard" })
    expect(view.offers).toEqual([
      {
        choice: "fast",
        tier: "fast",
        wire: "speed",
        basis: "catalog",
        status: "available",
        billing: { type: "extra", input: 8, output: 40 },
      },
    ])
    const dry = await s.speed.set({ sessionID: sid(ROOT), speed: "fast", dryRun: true }, rpcContext())
    if ("type" in dry) throw new Error("dry run failed")
    expect(dry.change?.warnings).toContain("extra_usage")
    expect(failure(await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext()))).toMatchObject({
      type: "speed_consent_required",
    })
    expect(s.kv.values.has(Kv.ackClaudeFast)).toBe(false)
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast", consent: true }, rpcContext())
    expect(s.kv.values.has(Kv.ackClaudeFast)).toBe(true)
    const request = httpRequest(ROOT, "anthropic", "claude-opus-5-5")
    await s.speed.onHttpRequest(request)
    expect(request.request.headers.get("anthropic-beta")).toContain(Speed.ANTHROPIC_BETA)
    expect(await request.request.json()).toMatchObject({ speed: "fast" })
    // A model without a fast mode: nothing is offered, the request is left alone.
    s.session("ses_sonnet", "anthropic", "claude-sonnet-5-5")
    expect((await viewOf(s, "ses_sonnet")).offers).toEqual([])
  })

  // SL-17: after a restart the plugin's sync `peek` answers the default account (AC-01) until a request or a binding
  // read ran; the estimate reads the cache of the account the root's tree is bound to (AC-03). This session has no
  // context yet (`P` 0), so the cache read cannot show in `change.delta`; the account it was read for is what is
  // checked.
  test("after a restart the Fast estimate reads the cache of the tree's Claude account, not the default's", async () => {
    const read: string[] = []
    await using s = await speedSetup({
      claude: true,
      claudeAccounts: {
        accountOf: async (sessionID) => {
          read.push(sessionID)
          return Account.ID.make("acc_cl3")
        },
        peek: () => Account.ID.make("acc_cl1"),
      },
    })
    s.session(ROOT, "anthropic", "claude-opus-5-5")
    const dry = await s.speed.set({ sessionID: sid(ROOT), speed: "fast", dryRun: true }, rpcContext())
    if ("type" in dry) throw new Error("dry run failed")
    expect(dry.change).toMatchObject({ from: "standard", to: "fast" })
    expect(read).toEqual([ROOT])
  })

  // SL-22 (fixed in merge round 7): the price lookup mapped Anthropic's `speed: "fast"` to OpenAI's `priority` and
  // never found the Fast mode's price, so every Anthropic Fast estimate was `rate_unknown` with no delta.
  test("the Fast estimate finds Anthropic's Fast price, for the Claude slot and an anth key alike", async () => {
    await using s = await speedSetup({ claude: true })
    for (const [sessionID, providerID] of [
      [ROOT, "anthropic"],
      ["ses_key", ANTH],
    ] as const) {
      s.session(sessionID, providerID, "claude-opus-5-5")
      const dry = await s.speed.set({ sessionID: sid(sessionID), speed: "fast", dryRun: true }, rpcContext())
      if ("type" in dry) throw new Error("dry run failed")
      expect([providerID, dry.change?.warnings ?? []]).not.toContainEqual(expect.arrayContaining(["rate_unknown"]))
      expect([providerID, dry.change?.delta ?? null]).not.toEqual([providerID, null])
    }
  })

  test("without the Claude slot the anthropic provider is not ours: no offer, no edit", async () => {
    await using s = await speedSetup()
    s.session(ROOT, "anthropic", "claude-opus-5-5")
    expect(failure(await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext()))).toMatchObject({
      type: "speed_unavailable",
      data: { reason: "not_offered" },
    })
    const request = httpRequest(ROOT, "anthropic", "claude-opus-5-5")
    const before = request.request
    await s.speed.onHttpRequest(request)
    expect(request.request).toBe(before)
  })
})

describe("Speed: through the registered hooks (hooks.ts)", () => {
  test("context shapes then adds serviceTier; http.request edits Anthropic; retry asks the speed last", async () => {
    await using s = await speedSetup()
    const hooks = new Map<string, (event: unknown) => unknown>()
    const registration = { dispose: async () => {} }
    const none = async () => registration
    const ctx = {
      ...s.t.deps.ctx,
      provider: { transform: none },
      model: { transform: none },
      agent: { transform: none },
      skill: { transform: none },
      session: {
        hook: async (name: string, callback: (event: unknown) => unknown) => {
          hooks.set(name, callback)
          return registration
        },
      },
      tool: { hook: none },
      permission: { hook: none },
    }
    // SAFETY: the context parts `Hooks.register` touches; only the session hooks are kept.
    await Hooks.register({ ...s.t.deps, ctx: ctx as unknown as typeof s.t.deps.ctx }, s.modules)
    // `http.request` is registered on this PC too now (02 §4.8), not only on a remote service.
    expect([...hooks.keys()]).toContain("http.request")

    s.session(ROOT, CODEX_A, "gpt-6-astra")
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    const context = contextEvent(ROOT, CODEX_A, "gpt-6-astra")
    await hooks.get("context")?.(context)
    expect(context.options.serviceTier).toBe("priority")

    s.session("ses_anth", ANTH, "claude-opus-5-5")
    await s.speed.set({ sessionID: sid("ses_anth"), speed: "fast" }, rpcContext())
    const http = httpRequest("ses_anth", ANTH, "claude-opus-5-5")
    await hooks.get("http.request")?.(http)
    expect(await http.request.json()).toMatchObject({ speed: "fast" })

    s.speed.onWsReceive(
      wsReceive(ROOT, CODEX_A, "gpt-6-astra", {
        type: "error",
        status: 400,
        error: { message: "service_tier 'priority' is not allowed" },
      }),
    )
    const retry = retryEvent(ROOT, CODEX_A, "gpt-6-astra", { type: "provider.invalid-request", message: "400" })
    await hooks.get("retry")?.(retry)
    expect(retry.decision).toEqual({ retry: true, delay: 0 })
  })
})
