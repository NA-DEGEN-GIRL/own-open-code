import { describe, expect, test } from "bun:test"
import { Wiretap } from "../src/index.js"

// Every credential here is fake.

describe("census", () => {
  test("every name once, sorted; values only for limit-like names, never credentials", () => {
    const headers = new Headers([
      ["Content-Type", "text/event-stream"],
      ["Authorization", "Bearer fake-token-0123456789abcdef"],
      ["Set-Cookie", "session=fake"],
      ["x-codex-primary-used-percent", "12.5"],
      ["X-Should-Retry", "false"],
      ["retry-after", "30"],
      ["openai-processing-ms", "812"],
      ["x-unknown-quota-left", "Bearer fake-token-0123456789abcdef"],
    ])
    const census = Wiretap.census(headers)
    expect(census.names).toEqual([
      "authorization",
      "content-type",
      "openai-processing-ms",
      "retry-after",
      "set-cookie",
      "x-codex-primary-used-percent",
      "x-should-retry",
      "x-unknown-quota-left",
    ])
    expect(census.values).toEqual({
      "x-codex-primary-used-percent": "12.5",
      "x-should-retry": "false",
      "retry-after": "30",
      "x-unknown-quota-left": expect.stringMatching(/^Bearer \[redacted:[0-9a-f]{8}\]$/),
    })
  })

  test("long values are cut after redaction", () => {
    const census = Wiretap.census({ "x-ratelimit-note": "a".repeat(1_000) })
    expect(census.values["x-ratelimit-note"]).toHaveLength(Wiretap.VALUE_CHARS)
  })
})

describe("shape", () => {
  test("keeps structure, enums and usage numbers; strings become lengths and other numbers <num>", () => {
    const body = {
      type: "error",
      status: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached for this account, try again in a while.",
        resets_in_seconds: 1234,
        plan_type: "plus",
      },
    }
    expect(Wiretap.shape(body)).toEqual({
      type: "error",
      status: 429,
      error: {
        type: "usage_limit_reached",
        message: "<str:72>",
        resets_in_seconds: "<num>",
        plan_type: "plus",
      },
    })
    const usage = {
      usage: { input_tokens: 4_000, input_tokens_details: { cached_tokens: 3_072 }, output_tokens: 12 },
      rate_limits: { primary: { used_percent: 41.5, window_minutes: 300 } },
      sequence_number: 7,
    }
    expect(Wiretap.shape(usage)).toEqual({
      usage: { input_tokens: 4_000, input_tokens_details: { cached_tokens: 3_072 }, output_tokens: 12 },
      rate_limits: { primary: { used_percent: 41.5, window_minutes: 300 } },
      sequence_number: "<num>",
    })
  })

  test("an enum key holding a sentence or a secret keeps only its length", () => {
    expect(
      Wiretap.shape({ code: "Incorrect API key provided: sk-fake0123456789abcdefghij", reason: "x".repeat(65) }),
    ).toEqual({ code: "<str:55>", reason: "<str:65>" })
  })

  test("odd keys, long arrays and deep values are bounded", () => {
    const value = {
      "a key with spaces": 1,
      items: Array.from({ length: Wiretap.MAX_ITEMS + 3 }, (_, index) => index),
      deep: Array.from({ length: Wiretap.MAX_DEPTH }).reduce<unknown>((inner) => ({ inner }), "leaf"),
    }
    const shaped = Wiretap.shape(value) as Record<string, unknown>
    expect(shaped["<key0:17>"]).toBe("<num>")
    expect(shaped.items).toHaveLength(Wiretap.MAX_ITEMS + 1)
    expect((shaped.items as unknown[]).at(-1)).toBe("<+3>")
    expect(JSON.stringify(shaped.deep)).toContain("<deep>")
    expect(JSON.stringify(shaped.deep)).not.toContain("leaf")
  })

  test("hash follows the shape; structure ignores lengths and numbers", () => {
    const delta = (text: string, n: number) => ({ type: "response.output_text.delta", delta: text, sequence_number: n })
    expect(Wiretap.hash(delta("ab", 1))).toBe(Wiretap.hash(delta("cd", 2)))
    expect(Wiretap.hash(delta("ab", 1))).not.toBe(Wiretap.hash(delta("abc", 1)))
    expect(Wiretap.structure(delta("ab", 1))).toBe(Wiretap.structure(delta("a much longer delta", 99)))
    expect(Wiretap.structure(delta("ab", 1))).not.toBe(Wiretap.structure({ type: "response.completed", delta: "ab" }))
    const limits = (percent: number) => ({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: percent } },
    })
    expect(Wiretap.hash(limits(1))).not.toBe(Wiretap.hash(limits(2)))
    expect(Wiretap.structure(limits(1))).toBe(Wiretap.structure(limits(2)))
  })
})

describe("essentials", () => {
  test("a Responses lifecycle event keeps only status, error, incomplete details, usage and tier", () => {
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_fake",
        status: "completed",
        instructions: "You are a helpful assistant.",
        tools: [{ type: "function", name: "read" }],
        output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
        usage: { input_tokens: 10, output_tokens: 2 },
        service_tier: "default",
      },
    }
    expect(Wiretap.essentials(completed)).toEqual({
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2 }, service_tier: "default" },
    })
    const frame = { type: "codex.rate_limits", plan_type: "plus", rate_limits: {} }
    expect(Wiretap.essentials(frame)).toBe(frame)
  })
})

describe("server-sent events", () => {
  test("splits complete events, keeps the unfinished rest and joins data lines", () => {
    const split = Wiretap.events(
      'event: response.created\ndata: {"type":"response.created"}\n\n: keep-alive\n\ndata: {"a":\ndata: 1}\r\n\r\ndata: {"partial"',
    )
    expect(split.events).toEqual([
      { name: "response.created", data: '{"type":"response.created"}' },
      { data: '{"a":\n1}' },
    ])
    expect(split.rest).toBe('data: {"partial"')
    expect(Wiretap.event("data: [DONE]")).toEqual([{ data: "[DONE]" }])
    expect(Wiretap.event(": comment")).toEqual([])
  })

  test("parse answers undefined for text that is not JSON", () => {
    expect(Wiretap.parse('{"a":1}')).toEqual({ a: 1 })
    expect(Wiretap.parse('{"a":')).toBeUndefined()
    expect(Wiretap.parse("<html>")).toBeUndefined()
  })
})
