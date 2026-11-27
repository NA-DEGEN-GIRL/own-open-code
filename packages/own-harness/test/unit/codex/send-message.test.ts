// `send_message_to_user_async` (Codex rust-v0.171.0 send_message_to_user_async.rs): Codex's declaration, argument
// errors and answer, and which models get it (10 §6.14).
import { describe, expect, test } from "bun:test"
import GPT62 from "../../golden/codex/exec-gpt62.json" with { type: "json" }
import { Catalog } from "../../../src/codex/catalog.js"
import { SendMessage } from "../../../src/codex/send-message.js"

describe("SendMessage", () => {
  test("the declaration is the one Codex 0.171.0 sent for gpt-6.2-sol", () => {
    const functions = (GPT62.requests[0]!.body.input[0] as { tools: Array<{ name: string; tools: Array<Record<string, unknown>> }> })
      .tools.find((namespace) => namespace.name === "functions")!
    const captured = functions.tools.find((tool) => tool.name === SendMessage.NAME)!
    expect(captured).toEqual({
      type: "function",
      name: SendMessage.NAME,
      description: SendMessage.DESCRIPTION,
      strict: false,
      parameters: SendMessage.PARAMETERS,
    })
  })

  test("trimmed message, Codex's errors otherwise", () => {
    expect(SendMessage.render({ message: "  **Blocked:** the build needs a token.  " })).toEqual({
      ok: true,
      text: "**Blocked:** the build needs a token.",
    })
    expect(SendMessage.render({ message: "   " })).toEqual({ ok: false, text: "message must not be empty" })
    expect(SendMessage.render({})).toEqual({ ok: false, text: "failed to parse function arguments: missing field `message` at line 1 column 2" })
    expect(SendMessage.render({ message: "hi", extra: 1 }).ok).toBe(false)
  })

  test("only models whose catalog lists it", () => {
    expect(SendMessage.available(Catalog.lookup("gpt-6.2-sol"))).toBe(true)
    expect(SendMessage.available(Catalog.lookup("gpt-6.1-sol"))).toBe(false)
    expect(SendMessage.available(Catalog.lookup("own-unknown-model"))).toBe(false)
  })
})
