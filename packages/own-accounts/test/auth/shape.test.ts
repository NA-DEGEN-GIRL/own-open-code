import { describe, expect, test } from "bun:test"
import type { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Kv } from "@own/protocol"
import { Hash } from "@own/runtime"
import { Auth } from "../../src/auth/auth.js"
import { Shape } from "../../src/auth/shape.js"
import type { Module } from "../../src/module.js"
import { registryWith } from "../slots/support.js"
import { authSetup, context, httpResponse, message, modelRequest, ref } from "./support.js"

const KEY = "sk-proj-fakeshape00000000000000000000001"
const SESSION = "ses_shape_test"
const OAI = ref("own-oai-aaaa", "gpt-5.5")
const ANTH = ref("own-anth-nnnn", "claude-opus-5-5")
const OR = ref("own-or-rrrr", "anthropic/claude-opus-4.5")
const DS = ref("own-ds-dddd", "deepseek-flash")

function identityBlock(providerID: string) {
  return {
    type: "text" as const,
    text: `# Your Model\n- Name: GPT-5.5\n- Provider ID: ${providerID}\n- Model ID: gpt-5.5`,
  }
}

async function setup() {
  const registry = await registryWith([
    { kind: "oai", label: "A", slug: "aaaa" },
    { kind: "anth", label: "N", slug: "nnnn" },
    { kind: "or", label: "R", slug: "rrrr" },
  ])
  const s = await authSetup({ registry })
  await s.t.deps.runtime.credentials.store("acc_aaaa", { type: "key", key: KEY })
  return s
}

function history() {
  return [
    message({ id: "msg_u1", role: "user", content: [{ type: "text", text: "hi" }] }),
    message({
      id: "msg_a1",
      role: "assistant",
      providerMetadata: { openai: { itemId: "msg_item_1" } },
      content: [
        { type: "reasoning", text: "", encrypted: "gAAAA-opaque", providerMetadata: { openai: { itemId: "rs_1" } } },
        { type: "reasoning", text: "visible", providerMetadata: { openai: { itemId: "rs_2" } } },
        { type: "text", text: "answer", providerMetadata: { openai: { itemId: "msg_1" } } },
        { type: "tool-call", id: "call_1", name: "read", input: {}, providerMetadata: { openai: { itemId: "fc_1" } } },
      ],
    }),
    message({ id: "msg_u2", role: "user", content: [{ type: "text", text: "next" }] }),
    message({
      id: "msg_a2",
      role: "assistant",
      content: [{ type: "text", text: "new", providerMetadata: { openai: { itemId: "msg_2" } } }],
    }),
  ]
}

describe("D9 identity normalization", () => {
  test("the Provider ID line of an own slot becomes the slot-neutral canonical value", () => {
    const system = [{ type: "text" as const, text: "base" }, identityBlock("own-oai-aaaa")]
    expect(Shape.normalizeIdentity(system, "own-oai-aaaa", "openai")).toBe("normalized")
    expect(system[1]?.text).toBe("# Your Model\n- Name: GPT-5.5\n- Provider ID: openai\n- Model ID: gpt-5.5")
    expect(system[0]?.text).toBe("base")
    expect(Shape.normalizeIdentity(system, "own-oai-aaaa", "openai")).toBe("already")
    expect(Shape.normalizeIdentity([{ type: "text", text: "no identity" }], "own-oai-aaaa", "openai")).toBe("missing")
  })

  test("two slots of one kind produce byte-identical system parts; other providers are untouched", async () => {
    await using s = await setup()
    const a = context(SESSION, OAI, { system: [identityBlock("own-oai-aaaa")] })
    const b = context(SESSION, ref("own-oai-bbbb", "gpt-5.5"), { system: [identityBlock("own-oai-bbbb")] })
    const builtin = context(SESSION, ref("openai", "gpt-5.5"), { system: [identityBlock("openai")] })
    const anthropic = context(SESSION, ref("anthropic", "claude"), { system: [identityBlock("anthropic")] })
    await s.auth.onRequestShape(a)
    await s.auth.onRequestShape(b)
    await s.auth.onRequestShape(builtin)
    await s.auth.onRequestShape(anthropic)
    expect(a.system[0]?.text).toContain("- Provider ID: openai")
    // own-oai-bbbb is not registered in this registry, so it stays as it is (filter by the slot registry).
    expect(b.system[0]?.text).toContain("- Provider ID: own-oai-bbbb")
    expect(builtin.system).toEqual([identityBlock("openai")])
    expect(anthropic.system).toEqual([identityBlock("anthropic")])
  })

  test("a changed identity format raises identity_format_changed once and changes nothing", async () => {
    await using s = await setup()
    const first = context(SESSION, OAI, { system: [{ type: "text", text: "## Model\nProvider: own-oai-aaaa" }] })
    await s.auth.onRequestShape(first)
    await s.auth.onRequestShape(context(SESSION, OAI))
    expect(first.system[0]?.text).toBe("## Model\nProvider: own-oai-aaaa")
    expect(s.alerts.map((alert) => alert.code)).toEqual(["identity_format_changed"])
  })

  test("the transform is deterministic: the same input shapes to the same output", async () => {
    await using s = await setup()
    const one = context(SESSION, OAI, { system: [identityBlock("own-oai-aaaa")], messages: history() })
    const two = context(SESSION, OAI, { system: [identityBlock("own-oai-aaaa")], messages: history() })
    await s.auth.onRequestShape(one)
    await s.auth.onRequestShape(two)
    expect(JSON.stringify(two.system)).toBe(JSON.stringify(one.system))
    expect(JSON.stringify(two.messages)).toBe(JSON.stringify(one.messages))
  })
})

describe("strip rules (02 §4.4)", () => {
  test("applyStrip removes provider-bound state up to dropBefore and keeps readable text", () => {
    const messages = history()
    const changed = Shape.applyStrip(
      messages,
      [
        {
          providerID: Provider.ID.make("own-oai-aaaa"),
          dropBefore: "msg_u2",
          kinds: ["reasoning.encrypted", "item.id"],
          until: "next-compaction",
        },
      ],
      "own-oai-aaaa",
    )
    expect(changed).toBe(true)
    expect(JSON.parse(JSON.stringify(messages[1]))).toEqual({
      id: "msg_a1",
      role: "assistant",
      content: [
        { type: "reasoning", text: "visible" },
        { type: "text", text: "answer" },
        { type: "tool-call", id: "call_1", name: "read", input: {} },
      ],
    })
    // After dropBefore: untouched.
    expect(messages[3]).toEqual(history()[3] ?? never())
    // Another slot's rule or an unknown message changes nothing.
    const other = history()
    expect(
      Shape.applyStrip(
        other,
        [
          {
            providerID: Provider.ID.make("own-oai-zzzz"),
            dropBefore: "msg_u2",
            kinds: ["item.id"],
            until: "next-compaction",
          },
        ],
        "own-oai-aaaa",
      ),
    ).toBe(false)
    expect(
      Shape.applyStrip(
        other,
        [
          {
            providerID: Provider.ID.make("own-oai-aaaa"),
            dropBefore: "msg_gone",
            kinds: ["item.id"],
            until: "next-compaction",
          },
        ],
        "own-oai-aaaa",
      ),
    ).toBe(false)
    expect(other).toEqual(history())
  })

  test("a WebSocket error frame with a strip pattern stores the same rule; other frames are ignored", async () => {
    await using s = await setup()
    await s.auth.onRequestShape(context(SESSION, OAI, { messages: history() }))
    const frame = (text: string) => ({
      sessionID: SESSION as never,
      agent: "build" as never,
      model: OAI,
      kind: "primary" as const,
      frame: text,
    })
    await s.auth.onWsReceive(frame('{"type":"response.output_text.delta","delta":"invalid_encrypted_content"}'))
    expect(s.kv.values.has(Kv.strip(SESSION))).toBe(false)
    await s.auth.onWsReceive(
      frame('{"type":"error","status":400,"error":{"code":"invalid_encrypted_content","message":"could not verify"}}'),
    )
    expect(s.kv.values.get(Kv.strip(SESSION))).toEqual([expect.objectContaining({ providerID: "own-oai-aaaa" })])
  })

  test("an error pattern on an own slot stores a rule in KV that the next request applies until compaction", async () => {
    await using s = await setup()
    const failing = context(SESSION, OAI, { messages: history() })
    await s.auth.onRequestShape(failing)
    await s.auth.onHttpResponse(
      httpResponse(SESSION, OAI, {
        status: 400,
        body: JSON.stringify({
          error: { code: "invalid_encrypted_content", message: "The encrypted content could not be verified." },
        }),
      }),
    )
    expect(s.kv.values.get(Kv.strip(SESSION))).toEqual([
      {
        providerID: "own-oai-aaaa",
        dropBefore: "msg_a2",
        kinds: ["reasoning.encrypted", "thinking.signature", "item.id"],
        until: "next-compaction",
      },
    ])
    const retried = context(SESSION, OAI, { messages: history() })
    await s.auth.onRequestShape(retried)
    expect(JSON.stringify(retried.messages)).not.toContain("itemId")
    expect(JSON.stringify(retried.messages)).not.toContain("gAAAA-opaque")

    // Another slot's requests keep their state; a non-matching error adds nothing.
    await s.auth.onHttpResponse(httpResponse(SESSION, OAI, { status: 429, body: '{"error":{"type":"rate_limit"}}' }))
    expect((s.kv.values.get(Kv.strip(SESSION)) as unknown[]).length).toBe(1)

    // compaction.ended of another Location's session is not ours; ours clears the rules.
    const ended = { type: "session.compaction.ended", data: { sessionID: SESSION } } as unknown as Module.OpenCodeEvent
    await s.auth.onEvent?.(ended, { local: false })
    expect(s.kv.values.has(Kv.strip(SESSION))).toBe(true)
    await s.auth.onEvent?.(ended, { local: true })
    expect(s.kv.values.has(Kv.strip(SESSION))).toBe(false)
    const after = context(SESSION, OAI, { messages: history() })
    await s.auth.onRequestShape(after)
    expect(JSON.stringify(after.messages)).toContain("itemId")
  })

  test("rules persisted by an earlier process are read back from KV", async () => {
    await using s = await setup()
    await s.kv.storage.set(Kv.strip("ses_restart"), [
      { providerID: "own-oai-aaaa", dropBefore: "msg_a1", kinds: ["item.id"], until: "next-compaction" },
    ])
    const request = context("ses_restart", OAI, { messages: history() })
    await s.auth.onRequestShape(request)
    expect(JSON.stringify(request.messages[1])).not.toContain("itemId")
    expect(JSON.stringify(request.messages[3])).toContain("itemId")
  })
})

describe("auth swap check (02 §4.2)", () => {
  test("the observed credential must be exactly the injected one", async () => {
    await using s = await setup()
    const request = modelRequest(SESSION, OAI)
    expect(s.auth.authSwap("own-oai-aaaa")).toBe("unknown")
    await s.auth.onModelRequest(request)
    await s.auth.onHttpResponse(httpResponse(SESSION, OAI, { requestHeaders: request.headers }))
    expect(s.alerts).toEqual([])
    expect(s.auth.authSwap("own-oai-aaaa")).toBe("ok")
    await s.auth.onHttpResponse(
      httpResponse(SESSION, OAI, {
        requestHeaders: { ...request.headers, "x-api-key": "sk-ant-api03-other-00000000000000000" },
      }),
    )
    expect(s.alerts.map((alert) => alert.code)).toEqual(["auth_swap_broken"])
    expect(s.auth.authSwap("own-oai-aaaa")).toBe("broken")
    for (const _ of Array.from({ length: 50 }))
      if (s.modules.slots.account("acc_aaaa")?.status !== "misconfigured") await Bun.sleep(20)
    expect(s.modules.slots.account("acc_aaaa")?.status).toBe("misconfigured")
    expect(s.logs.join("\n")).not.toContain(KEY)
  })

  test("a WebSocket handshake is checked like an HTTP request", async () => {
    await using s = await setup()
    const request = modelRequest(SESSION, OAI)
    await s.auth.onModelRequest(request)
    const handshake = (headers: Record<string, string>) => ({
      sessionID: SESSION as never,
      agent: "build" as never,
      model: OAI,
      kind: "primary" as const,
      url: "wss://example.invalid/responses",
      headers,
    })
    await s.auth.onWsHandshake(handshake({ ...request.headers }))
    expect([s.auth.authSwap("own-oai-aaaa"), s.alerts]).toEqual(["ok", []])
    await s.auth.onWsHandshake(handshake({ "x-session-affinity": SESSION }))
    expect(s.auth.authSwap("own-oai-aaaa")).toBe("broken")
    expect(s.alerts.map((alert) => alert.code)).toEqual(["auth_swap_broken"])
  })

  test("the verdict is process-wide: another Location's instance (e.g. selfTest in control) sees it", async () => {
    await using s = await setup()
    const control = Auth.create(s.t.deps, () => s.modules)
    await control.start()
    const request = modelRequest(SESSION, OAI)
    await s.auth.onModelRequest(request)
    await s.auth.onHttpResponse(httpResponse(SESSION, OAI, { requestHeaders: request.headers }))
    expect(control.authSwap("own-oai-aaaa")).toBe("ok")
    await s.auth.onHttpResponse(httpResponse(SESSION, OAI, { requestHeaders: {} }))
    expect(control.authSwap("own-oai-aaaa")).toBe("broken")
    await control.stop()
  })

  test("a credential on a request where nothing was injected is foreign", async () => {
    await using s = await setup()
    s.trust.value = "blocked_by_plugin"
    await s.auth.onModelRequest(modelRequest(SESSION, OAI))
    await s.auth.onHttpResponse(
      httpResponse(SESSION, OAI, { requestHeaders: { authorization: "Bearer from-someone-else-000000" } }),
    )
    expect(s.alerts.map((alert) => alert.code)).toEqual(["auth_swap_broken"])
  })

  test("the hash recorded for the swap check never contains the key", async () => {
    await using s = await setup()
    await s.auth.onModelRequest(modelRequest(SESSION, OAI))
    expect(s.t.deps.runtime.lastResponse.injected(SESSION, "own-oai-aaaa")).toBe(Hash.short(`Bearer ${KEY}`))
  })
})

describe("Anthropic cache hints (02 §4.5)", () => {
  test("anth: after 15+ new blocks the watermark and the tail get manual 5-minute hints", async () => {
    await using s = await setup()
    const entry = (blocksSince: number) => ({
      lastReqAt: 1,
      L: 1000,
      epoch: 0,
      modelID: "claude-opus-5-5",
      variant: null,
      watermark: { messageID: "msg_u1", partIndex: 0 },
      blocksSince,
      messageEndsSince: 0,
      imageTrimEpoch: 0,
    })
    await s.kv.storage.set(Kv.cache(SESSION, "own-anth-nnnn"), entry(3))
    const early = context(SESSION, ANTH, { messages: history() })
    await s.auth.onRequestShape(early)
    expect(JSON.stringify(early.messages)).not.toContain("ephemeral")

    await s.kv.storage.set(Kv.cache(SESSION, "own-anth-nnnn"), entry(15))
    const back = context(SESSION, ANTH, { messages: history() })
    await s.auth.onRequestShape(back)
    const hinted = back.messages.flatMap((item, index) =>
      item.content.flatMap((part, at) => ("cache" in part && part.cache ? [`${index}:${at}`] : [])),
    )
    expect(hinted).toEqual(["0:0", "3:0"])
  })

  test("a completed assistant watermark restores the cached input boundary, never its new thinking block", async () => {
    await using s = await setup()
    await s.kv.storage.set(Kv.cache(SESSION, "own-anth-nnnn"), {
      lastReqAt: 1,
      L: 1000,
      epoch: 0,
      modelID: "claude-opus-5-5",
      variant: null,
      watermark: { messageID: "msg_a1", partIndex: 0 },
      blocksSince: 16,
      messageEndsSince: 8,
      imageTrimEpoch: 0,
    })
    const request = context(SESSION, ANTH, { messages: history() })
    await s.auth.onRequestShape(request)
    expect(request.messages[0]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
    expect(request.messages[1]?.content[0]).not.toHaveProperty("cache")
    expect(request.messages[3]?.content[0]).toMatchObject({ cache: { type: "ephemeral" } })
  })

  test("OpenRouter gets no manual hints: core's auto policy places them on its Claude models", async () => {
    // Upstream 74dbc509d7: `gatewayPolicy` gives OpenRouter `anthropic/` models tools, system and tail breakpoints.
    // Hints added here would only take budget from that policy (it fills what manual hints leave of four).
    await using s = await setup()
    const request = context(SESSION, OR, {
      system: [{ type: "text", text: "base" }, identityBlock("own-or-rrrr")],
      messages: history(),
    })
    await s.auth.onRequestShape(request)
    expect(request.system.map((part) => part.cache)).toEqual([undefined, undefined])
    expect(
      request.messages
        .flatMap((message): ReadonlyArray<Shape.Part> => message.content)
        .some((part) => "cache" in part && part.cache),
    ).toBe(false)
  })

  test("hints never exceed the four-breakpoint budget", () => {
    const system = [0, 1, 2].map((index) => ({
      type: "text" as const,
      text: `s${index}`,
      cache: { type: "ephemeral" } as never,
    }))
    const messages = history()
    expect(
      Shape.addHints(system, messages, [
        { type: "message", index: 0 },
        { type: "message", index: 3 },
      ]),
    ).toBe(1)
  })
})

function never(): never {
  throw new Error("missing fixture")
}

describe("Sign in with ChatGPT request options (02 §3.2c)", () => {
  const SIWC = ref("own-siwc-ssss", "gpt-5.5")
  const options = (): Record<string, unknown> => ({
    maxTokens: 4_096,
    temperature: 0.2,
    topP: 0.9,
    topLogprobs: 2,
    metadata: { trace: "x" },
    safetyIdentifier: "user-1",
    truncation: "auto",
    maxToolCalls: 4,
    reasoningEffort: "high",
    serviceTier: "priority",
    store: false,
  })

  test("a siwc slot drops the options the route rejects and keeps the rest; other slots keep everything", async () => {
    const registry = await registryWith([
      { kind: "ds", label: "D", slug: "dddd" },
      { kind: "siwc", label: "S", slug: "ssss" },
    ])
    await using s = await authSetup({ registry })
    const siwc = { ...context(SESSION, SIWC), options: options() }
    const ds = { ...context(SESSION, DS), options: options() }
    await s.auth.onRequestShape(siwc)
    await s.auth.onRequestShape(ds)
    expect(siwc.options).toEqual({ reasoningEffort: "high", serviceTier: "priority", store: false })
    expect(ds.options).toEqual(options())
  })

  test("stripSharingOptions reports what it removed", () => {
    const value: Record<string, unknown> = { temperature: 1, maxTokens: undefined, reasoningEffort: "low" }
    expect(Shape.stripSharingOptions(value)).toEqual(["temperature"])
    expect(value).toEqual({ reasoningEffort: "low" })
    expect(Shape.SHARING_UNSUPPORTED).toContain("maxTokens")
  })
})

describe("output limit of the ChatGPT, OpenAI and OpenRouter routes (upstream d9987ef9c8 omitOutputLimit)", () => {
  test("codex, oai and or slots drop maxTokens from context requests; other kinds and providers keep it", async () => {
    const registry = await registryWith([
      { kind: "codex", label: "C", slug: "cccc" },
      { kind: "oai", label: "A", slug: "aaaa" },
      { kind: "ds", label: "D", slug: "dddd" },
      { kind: "anth", label: "N", slug: "nnnn" },
      { kind: "or", label: "R", slug: "rrrr" },
    ])
    await using s = await authSetup({ registry })
    const shaped = async (model: Model.Ref, hook?: "context" | "compaction" | "generate") => {
      const options: Record<string, unknown> = { maxTokens: 128_000, reasoningEffort: "high" }
      await s.auth.onRequestShape({ ...context(SESSION, model), options }, hook)
      return options
    }
    expect(await shaped(ref("own-codex-cccc", "gpt-5.5"))).toEqual({ reasoningEffort: "high" })
    expect(await shaped(OAI)).toEqual({ reasoningEffort: "high" })
    // OpenRouter prices the requested output against the balance: a low balance would answer 402 to a request a
    // shorter answer fits (02 §4.1, §5.2). Summary requests go without one too; a `generate` caller's limit stays.
    expect(await shaped(OR)).toEqual({ reasoningEffort: "high" })
    expect(await shaped(OR, "compaction")).toEqual({ reasoningEffort: "high" })
    expect(await shaped(OR, "generate")).toEqual({ maxTokens: 128_000, reasoningEffort: "high" })
    // Other kinds keep core's limit; the built-in `openai` and `openrouter` providers are never shaped here.
    for (const model of [DS, ANTH, ref("openai", "gpt-5.5"), ref("openrouter", "anthropic/claude-opus-4.5")])
      expect(await shaped(model)).toEqual({ maxTokens: 128_000, reasoningEffort: "high" })
  })
})
