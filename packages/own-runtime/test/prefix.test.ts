import { describe, expect, test } from "bun:test"
import { Prefix } from "../src/index.js"

// P0-2b: per-block prefix fingerprints of fake request bodies and hook-shaped requests. No real request is involved.

const READ = { type: "function", name: "read", description: "Read a file.", parameters: { type: "object" } }
const SHELL = { type: "function", name: "shell", description: "Run a command.", parameters: { type: "object" } }

const responses = (input: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => ({
  model: "gpt-6-sol",
  tools: [READ, SHELL],
  instructions: "You are OpenCode.",
  input,
  prompt_cache_key: "ses_fake",
  ...extra,
})

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] })
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] })

const kinds = (blocks: ReadonlyArray<Prefix.Block>) => blocks.map((block) => block.kind)

describe("body: blocks in each protocol's cache order", () => {
  test("Responses: tools, instructions, then each input item (a developer item is an update, so a message)", () => {
    const blocks = Prefix.body(responses([{ role: "developer", content: "update" }, user("hi"), assistant("hello")]))
    expect(kinds(blocks)).toEqual(["tools", "system", "message", "message", "message"])
    expect(blocks.every((block) => /^[0-9a-f]{16}$/.test(block.hash))).toBe(true)
  })

  test("Responses without instructions (upstream v2.3.2): core's leading text developer message is the system", () => {
    const system = { role: "developer", content: "You are OpenCode." }
    const codex = { role: "developer", content: [{ type: "input_text", text: "Codex base instructions" }] }
    expect(kinds(Prefix.body(responses([system, user("hi")], { instructions: undefined })))).toEqual([
      "tools",
      "system",
      "message",
    ])
    // A chained request's first item is new input (its system is in the previous response).
    expect(
      kinds(Prefix.body(responses([system, user("hi")], { instructions: undefined, previous_response_id: "resp_1" }))),
    ).toEqual(["tools", "message", "message"])
    // Codex's developer items carry content parts: they stay messages, as before.
    expect(kinds(Prefix.body(responses([codex, user("hi")], { instructions: undefined })))).toEqual([
      "tools",
      "message",
      "message",
    ])
  })

  test("Anthropic: tools, each system block, then each message; Chat: tools, then messages", () => {
    const anthropic = Prefix.body({
      tools: [{ name: "read", input_schema: { type: "object" } }],
      system: [
        { type: "text", text: "You are OpenCode." },
        { type: "text", text: "# Your Model" },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(kinds(anthropic)).toEqual(["tools", "system", "system", "message"])
    const plain = Prefix.body({ system: "one string", messages: [{ role: "user", content: "hi" }] })
    expect(kinds(plain)).toEqual(["tools", "system", "message"])
    const chat = Prefix.body({
      messages: [
        { role: "system", content: "You are OpenCode." },
        { role: "user", content: "hi" },
        { role: "system", content: "an instruction update later in the conversation" },
      ],
    })
    expect(kinds(chat)).toEqual(["tools", "system", "message", "message"])
    expect(kinds(Prefix.body(undefined))).toEqual(["tools"])
  })

  test("the envelope (model, prompt_cache_key, options) is not a block", () => {
    const a = Prefix.body(responses([user("hi")]))
    const b = Prefix.body(responses([user("hi")], { model: "gpt-5.5", prompt_cache_key: "ses_other", reasoning: {} }))
    expect(b).toEqual(a)
  })
})

describe("lcp: the first block that differs", () => {
  const first = Prefix.body(responses([user("one")]))

  test("an appended request reuses the whole previous one; the same request again does too", () => {
    const next = Prefix.body(responses([user("one"), assistant("1"), user("two")]))
    expect(Prefix.lcp(first, next)).toBe(first.length)
    expect(Prefix.lcp(first, first)).toBe(first.length)
    expect(Prefix.lcp([], next)).toBe(0)
  })

  test("a rewritten message, instruction or tool definition is found where it is", () => {
    const history = [user("one"), assistant("1"), user("two")]
    const previous = Prefix.body(responses(history))
    const rewritten = Prefix.body(responses([user("one"), assistant("1 (edited)"), user("two"), user("three")]))
    expect(Prefix.lcp(previous, rewritten)).toBe(3)
    expect(previous[3]?.kind).toBe("message")
    const instructions = Prefix.body(responses(history, { instructions: "You are OpenCode!" }))
    expect(Prefix.lcp(previous, instructions)).toBe(1)
    const tools = Prefix.body(responses(history, { tools: [READ, { ...SHELL, description: "Run it." }] }))
    expect(Prefix.lcp(previous, tools)).toBe(0)
  })

  test("a shorter request stops at its end", () => {
    const previous = Prefix.body(responses([user("one"), assistant("1"), user("two")]))
    expect(Prefix.lcp(previous, Prefix.body(responses([user("one")])))).toBe(3)
  })

  test("cache breakpoints and key order inside a block do not count; tool order does", () => {
    const marked = Prefix.body({
      tools: [{ name: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
      system: [{ type: "text", text: "You are OpenCode." }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    })
    const moved = Prefix.body({
      tools: [{ input_schema: { type: "object" }, name: "read" }],
      system: [{ text: "You are OpenCode.", type: "text", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
    })
    expect(moved).toEqual(marked)
    const reordered = Prefix.body(responses([user("one")], { tools: [SHELL, READ] }))
    expect(Prefix.lcp(first, reordered)).toBe(0)
  })
})

describe("blocks: a request as the context hook shapes it", () => {
  const request = (input: { tools?: Record<string, unknown>; system?: string[]; messages?: unknown[] }) => ({
    tools: input.tools ?? { read: { description: "Read a file.", input: { type: "object" } } },
    system: (input.system ?? ["You are OpenCode.", "# Your Model"]).map((text) => ({ type: "text", text })),
    messages: input.messages ?? [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  })

  test("tools as one block in their order, each system part, each message; `cache` hints folded", () => {
    const blocks = Prefix.blocks(request({}))
    expect(kinds(blocks)).toEqual(["tools", "system", "system", "message"])
    const hinted = Prefix.blocks({
      ...request({}),
      system: [
        { type: "text", text: "You are OpenCode.", cache: { type: "ephemeral" } },
        { type: "text", text: "# Your Model" },
      ],
    })
    expect(hinted).toEqual(blocks)
    const tools = { read: { description: "Read a file.", input: {} }, shell: { description: "Run.", input: {} } }
    const swapped = { shell: tools.shell, read: tools.read }
    expect(Prefix.lcp(Prefix.blocks(request({ tools })), Prefix.blocks(request({ tools: swapped })))).toBe(0)
  })

  test("bytes are hashed as bytes: equal bytes match, one changed byte does not", () => {
    const image = (data: Uint8Array) =>
      request({
        messages: [{ role: "user", content: [{ type: "media", media: { source: { type: "bytes", data } } }] }],
      })
    const a = new Uint8Array(1024).fill(7)
    const b = Uint8Array.from(a)
    expect(Prefix.blocks(image(b))).toEqual(Prefix.blocks(image(a)))
    b[512] = 8
    expect(Prefix.lcp(Prefix.blocks(image(a)), Prefix.blocks(image(b)))).toBe(3)
  })

  test("toJSON values hash as their JSON; undefined members drop", () => {
    const at = new Date(Date.UTC(2026, 9, 6))
    const withDate = Prefix.blocks(request({ messages: [{ role: "user", at, extra: undefined }] }))
    const asText = Prefix.blocks(request({ messages: [{ role: "user", at: at.toJSON() }] }))
    expect(withDate).toEqual(asText)
  })
})

describe("section", () => {
  test("one hash per section of a body: equal sections, equal hashes", () => {
    const a = responses([user("one")])
    const b = responses([user("one"), assistant("1"), user("two")])
    expect(Prefix.section(b, "tools")).toBe(Prefix.section(a, "tools"))
    expect(Prefix.section(b, "system")).toBe(Prefix.section(a, "system"))
    expect(Prefix.section(b, "message")).not.toBe(Prefix.section(a, "message"))
    expect(Prefix.section(responses([user("one")], { instructions: "Other." }), "system")).not.toBe(
      Prefix.section(a, "system"),
    )
  })
})

describe("cost", () => {
  test("a large request (400 messages, 4 MB of text, a 10 MB inline image) is hashed well under a second", () => {
    const messages = Array.from({ length: 400 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `${index}:`.padEnd(10_000, "가나다abc ") }],
    }))
    const image = { type: "media", media: { source: { type: "base64", data: "A".repeat(10 * 1024 * 1024) } } }
    const request = {
      tools: { read: { description: "Read a file.", input: { type: "object" } } },
      system: [{ type: "text", text: "You are OpenCode." }],
      messages: [...messages, { role: "user", content: [image] }],
    }
    Prefix.blocks(request)
    const started = performance.now()
    const blocks = Prefix.blocks(request)
    const ms = performance.now() - started
    expect(blocks).toHaveLength(403)
    expect(ms).toBeLessThan(1_000)
  })
})
