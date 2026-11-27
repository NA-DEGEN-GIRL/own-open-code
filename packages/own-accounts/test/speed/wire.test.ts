// 02 §4.8: the request edits of a speed and the reading of the tier a response served (pure; made-up bodies).

import { describe, expect, test } from "bun:test"
import { Speed } from "@own/protocol"
import { SpeedEstimate } from "../../src/speed/estimate.js"
import { SpeedRefusal } from "../../src/speed/refusal.js"
import { SpeedWire } from "../../src/speed/wire.js"

const MESSAGES = "https://api.anthropic.example/v1/messages"

function anthropicRequest(body: unknown, beta?: string) {
  return new Request(MESSAGES, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-fake",
      ...(beta ? { "anthropic-beta": beta } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("SpeedWire: Anthropic requests", () => {
  test("Fast adds speed and appends the beta once; other headers and fields stay", async () => {
    const shaped = await SpeedWire.anthropic(
      anthropicRequest({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }, "interleaved-thinking-2025-05-14"),
      { speed: "fast" },
    )
    expect(shaped?.url).toBe(MESSAGES)
    expect(shaped?.method).toBe("POST")
    expect(shaped?.headers.get("x-api-key")).toBe("sk-fake")
    expect(shaped?.headers.get("anthropic-beta")).toBe(`interleaved-thinking-2025-05-14,${Speed.ANTHROPIC_BETA}`)
    expect(await shaped?.json()).toEqual({ model: "claude-opus-5-5", max_tokens: 10, messages: [], speed: "fast" })
    // Again on a request that already carries it: no duplicate.
    const twice = await SpeedWire.anthropic(anthropicRequest({ model: "m" }, Speed.ANTHROPIC_BETA), { speed: "fast" })
    expect(twice?.headers.get("anthropic-beta")).toBe(Speed.ANTHROPIC_BETA)
  })

  test("a Standard request of a conversation with the beta keeps the header and sends no speed", async () => {
    const shaped = await SpeedWire.anthropic(anthropicRequest({ model: "m", speed: "fast" }), { speed: undefined })
    expect(shaped?.headers.get("anthropic-beta")).toBe(Speed.ANTHROPIC_BETA)
    expect(await shaped?.json()).toEqual({ model: "m" })
  })

  test("a body that is not a JSON object is left alone", async () => {
    const request = new Request(MESSAGES, { method: "POST", body: "not json" })
    expect(await SpeedWire.anthropic(request, { speed: "fast" })).toBeUndefined()
  })
})

describe("SpeedWire: the served tier", () => {
  test("a Responses event names it in response.service_tier; an Anthropic event in usage.speed", () => {
    expect(SpeedWire.servedOf({ type: "response.completed", response: { service_tier: "default" } })).toBe("default")
    expect(SpeedWire.servedOf({ type: "message_start", message: { usage: { speed: "fast" } } })).toBe("fast")
    expect(SpeedWire.servedOf({ type: "message_delta", usage: { output_tokens: 3, speed: "standard" } })).toBe(
      "standard",
    )
    expect(SpeedWire.servedOf({ type: "response.output_text.delta", delta: '"service_tier":"x"' })).toBeUndefined()
  })

  test("the last tier an SSE stream names wins; escaped text in a delta is not a tier", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.created", response: { service_tier: "priority" } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: '{"service_tier":"ultrafast"}' })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: { service_tier: "default" } })}`,
      "",
    ].join("\n")
    // Split mid-line so the reader has to join chunks.
    const bytes = new TextEncoder().encode(sse)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 40))
        controller.enqueue(bytes.slice(40))
        controller.close()
      },
    })
    expect(await SpeedWire.servedOfStream(new Response(stream), AbortSignal.timeout(5_000))).toBe("default")
    expect(await SpeedWire.servedOfStream(new Response("data: {}\n\n"), AbortSignal.timeout(5_000))).toBeUndefined()
  })

  test("a ChatGPT plan (codex, siwc) never says the tier it ran; API kinds are taken at their word", () => {
    // Both plan routes answer `auto` then `default` (or nothing) whatever they ran (live 2026-10-18, 2026-10-22).
    for (const kind of ["codex", "siwc"]) {
      expect(SpeedWire.reported(kind, "auto")).toBeUndefined()
      expect(SpeedWire.reported(kind, "default")).toBeUndefined()
      expect(SpeedWire.reported(kind, undefined)).toBeUndefined()
      // A tier the answer names itself still counts (Ultrafast answered `priority` is a downgrade).
      expect(SpeedWire.reported(kind, "priority")).toBe("priority")
      expect(SpeedWire.reported(kind, "ultrafast")).toBe("ultrafast")
    }
    for (const kind of ["oai", "anth", "claude-sub", undefined]) {
      expect(SpeedWire.reported(kind, "default")).toBe("default")
      expect(SpeedWire.reported(kind, "standard")).toBe("standard")
    }
  })
})

describe("SpeedRefusal (decision 6)", () => {
  test("Sign in with ChatGPT's unsupported capability on service_tier is a refusal", () => {
    const text = JSON.stringify({
      error: { code: "subscription_sharing_unsupported_capability", param: "service_tier", message: "not allowed" },
    })
    expect(SpeedRefusal.judge({ wire: "service_tier", tier: "priority", status: 400, text })).toEqual({
      type: "refused",
      reason: "subscription_sharing_unsupported_capability",
    })
    // The same code about a tool is not the tier's.
    const tool = JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "tools" } })
    expect(SpeedRefusal.judge({ wire: "service_tier", tier: "priority", status: 400, text: tool })).toBeUndefined()
  })

  test("an OpenAI 4xx naming the tier is a refusal; 401, 429 and unrelated errors are not", () => {
    const named = '{"error":{"message":"service_tier ultrafast is not available for your plan"}}'
    expect(SpeedRefusal.judge({ wire: "service_tier", tier: "ultrafast", status: 403, text: named })).toEqual({
      type: "refused",
      reason: "status_403",
    })
    expect(SpeedRefusal.judge({ wire: "service_tier", tier: "ultrafast", status: 429, text: named })).toBeUndefined()
    expect(SpeedRefusal.judge({ wire: "service_tier", tier: "priority", status: 401, text: named })).toBeUndefined()
    expect(
      SpeedRefusal.judge({ wire: "service_tier", tier: "priority", status: 400, text: "input too long" }),
    ).toBeUndefined()
    // A WebSocket error frame without a status that names the tier.
    expect(
      SpeedRefusal.judge({ wire: "service_tier", tier: "ultrafast", status: undefined, text: "Invalid service_tier" }),
    ).toEqual({ type: "refused", reason: "rejected" })
  })

  test("the Codex backend's answer to a tier it does not take (live, 2026-10-18), and the provider's words", () => {
    // HTTP: 400 with a `detail`; the WebSocket: an `error` frame with the status and an `error.message`.
    const http = '{"detail":"Unsupported service_tier: ultrafast"}'
    const frame = JSON.stringify({
      type: "error",
      status: 400,
      error: { type: "invalid_request_error", message: "Unsupported service_tier: ultrafast" },
    })
    for (const text of [http, `${frame}\nprovider.invalid-request\nbad request`])
      expect(SpeedRefusal.judge({ wire: "service_tier", tier: "ultrafast", status: 400, text })).toEqual({
        type: "refused",
        reason: "unsupported_tier",
      })
    expect(SpeedRefusal.detail(http)).toBe("Unsupported service_tier: ultrafast")
    expect(SpeedRefusal.detail(`${frame}\nprovider.invalid-request\nbad request`)).toBe(
      "Unsupported service_tier: ultrafast",
    )
    expect(SpeedRefusal.detail("plain text\nprovider.invalid-request")).toBeUndefined()
    expect(SpeedRefusal.detail(JSON.stringify({ detail: "x".repeat(500) }))).toHaveLength(SpeedRefusal.DETAIL_CHARS)
  })

  test("Anthropic: 429/529 is a cooldown, a 4xx about speed or credits a refusal", () => {
    expect(
      SpeedRefusal.judge({ wire: "speed", tier: "fast", status: 429, text: "rate_limit", retryAfterMs: 3_000 }),
    ).toEqual({
      type: "cooldown",
      reason: "status_429",
      retryAfterMs: 3_000,
    })
    expect(SpeedRefusal.judge({ wire: "speed", tier: "fast", status: 529, text: "overloaded" })?.type).toBe("cooldown")
    expect(
      SpeedRefusal.judge({
        wire: "speed",
        tier: "fast",
        status: 400,
        text: "speed: fast is not supported for this model",
      }),
    ).toEqual({ type: "refused", reason: "status_400" })
    expect(SpeedRefusal.judge({ wire: "speed", tier: "fast", status: 400, text: "You're out of extra usage" })).toEqual(
      { type: "refused", reason: "usage_credits" },
    )
    expect(SpeedRefusal.judge({ wire: "speed", tier: "fast", status: 400, text: "prompt is too long" })).toBeUndefined()
  })

  test("cooldowns grow while the fast pool keeps refusing, within bounds", () => {
    expect(SpeedRefusal.cooldownMs(undefined, 0)).toBe(SpeedRefusal.COOLDOWN_MS)
    expect(SpeedRefusal.cooldownMs(5_000, 0)).toBe(SpeedRefusal.COOLDOWN_MS)
    expect(SpeedRefusal.cooldownMs(120_000, 0)).toBe(120_000)
    expect(SpeedRefusal.cooldownMs(undefined, 2)).toBe(4 * SpeedRefusal.COOLDOWN_MS)
    expect(SpeedRefusal.cooldownMs(undefined, 40)).toBe(SpeedRefusal.COOLDOWN_MAX_MS)
  })
})

describe("SpeedEstimate (decision 7)", () => {
  const standard = { unit: "USD" as const, input: 10, read: 1, cold: 10 }
  const fast = SpeedEstimate.scale(standard, 2)

  test("OpenAI before any measure: a range from the cache kept to the prefix written again", () => {
    const change = SpeedEstimate.change({
      from: "standard",
      to: "fast",
      wire: "service_tier",
      P: 100_000,
      L: 90_000,
      before: standard,
      after: fast,
      beta: false,
      extra: false,
      unverified: false,
    })
    // Stay: 90k × 1 + 10k × 10 = 0.19; kept: 90k × 2 + 10k × 20 = 0.38; lost: 100k × 20 = 2.0.
    expect(change).toMatchObject({ cache: "unknown", basis: "rule", factor: 2, P: 100_000, unit: "USD" })
    expect(change.delta).toEqual({ lo: 0.19, hi: 1.81, unit: "USD" })
    expect(change.warnings).toEqual(["cache_unverified"])
  })

  test("measured tier changes of the kind decide the cache once enough agree", () => {
    const input = {
      from: "standard" as const,
      to: "fast" as const,
      wire: "service_tier" as const,
      P: 100_000,
      L: 90_000,
      before: standard,
      after: fast,
      beta: false,
      extra: false,
      unverified: false,
    }
    expect(SpeedEstimate.change({ ...input, retention: { kept: 4, lost: 0 } })).toMatchObject({
      cache: "kept",
      basis: "measured",
      delta: { lo: 0.19, hi: 0.19 },
      warnings: [],
    })
    expect(SpeedEstimate.change({ ...input, retention: { kept: 0, lost: 3 } }).delta).toEqual({
      lo: 1.81,
      hi: 1.81,
      unit: "USD",
    })
    expect(SpeedEstimate.change({ ...input, retention: { kept: 1, lost: 1 } }).cache).toBe("unknown")
  })

  test("Anthropic: the first fast request rewrites the prefix; later changes keep it", () => {
    const input = {
      from: "standard" as const,
      to: "fast" as const,
      wire: "speed" as const,
      P: 100_000,
      L: 90_000,
      before: standard,
      after: fast,
      extra: false,
      unverified: false,
    }
    const first = SpeedEstimate.change({ ...input, beta: false })
    expect(first).toMatchObject({ cache: "lost", warnings: ["first_fast_rewrite"], delta: { lo: 1.81, hi: 1.81 } })
    const later = SpeedEstimate.change({ ...input, beta: true })
    expect(later).toMatchObject({ cache: "kept", warnings: ["cache_unverified"], delta: { lo: 0.19, hi: 0.19 } })
    expect(
      SpeedEstimate.change({ ...input, from: "fast", to: "standard", before: fast, after: standard, beta: true }),
    ).toMatchObject({ cache: "kept", delta: { lo: -0.19, hi: -0.19 } })
  })

  test("the Claude slot: the fast request costs usage credits; back to Standard costs none", () => {
    const extra = { unit: "USD" as const, input: 8, read: 0.4, cold: 10 }
    const on = SpeedEstimate.change({
      from: "standard",
      to: "fast",
      wire: "speed",
      P: 100_000,
      L: 0,
      before: undefined,
      after: extra,
      beta: false,
      extra: true,
      unverified: false,
    })
    expect(on).toMatchObject({ unit: "USD", delta: { lo: 1, hi: 1 }, warnings: ["first_fast_rewrite", "extra_usage"] })
    const off = SpeedEstimate.change({
      from: "fast",
      to: "standard",
      wire: "speed",
      P: 100_000,
      L: 0,
      before: extra,
      after: undefined,
      beta: true,
      extra: true,
      unverified: false,
    })
    expect(off.delta).toEqual({ lo: 0, hi: 0, unit: "USD" })
  })

  test("plan kinds without rates show the plan multiple and rate_unknown", () => {
    const change = SpeedEstimate.change({
      from: "standard",
      to: "fast",
      wire: "service_tier",
      P: 50_000,
      L: 0,
      before: undefined,
      after: undefined,
      multiple: 2.5,
      beta: false,
      extra: false,
      unverified: true,
    })
    expect(change).toMatchObject({ delta: null, factor: 2.5 })
    expect(change.warnings).toEqual(["cache_unverified", "unverified_tier", "rate_unknown"])
  })
})
