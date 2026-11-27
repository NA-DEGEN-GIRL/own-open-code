// OWN-PATCH(P-021) begin
// A system message with a text part marked with `OpenResponses.INPUT_TEXT_KEY` (its provider metadata) becomes a
// developer message whose text parts stay separate input_text items, as Codex sends its developer fragments; unmarked
// system messages are joined as before.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ai, Message } from "../../src/effect.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import * as OpenAIResponses from "../../src/protocols/openai-responses.js"
import { Auth } from "../../src/route/auth.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5.5" })

describe("developer message content", () => {
  it.effect("keeps marked text parts as input_text items and joins unmarked ones", () =>
    Effect.gen(function* () {
      const parts = [
        { type: "text" as const, text: "<skills_instructions>a</skills_instructions>" },
        { type: "text" as const, text: "<permissions instructions>b</permissions instructions>" },
      ]
      const prepared = yield* compileRequest(
        ai.request({
          model,
          messages: [
            Message.make({
              role: "system",
              content: [{ ...parts[0], providerMetadata: { [OpenResponses.INPUT_TEXT_KEY]: {} } }, parts[1]],
            }),
            Message.make({ role: "system", content: parts }),
            Message.user("hi"),
          ],
        }),
      )
      expect(prepared.body.input.slice(0, 2)).toEqual([
        {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "<skills_instructions>a</skills_instructions>" },
            { type: "input_text", text: "<permissions instructions>b</permissions instructions>" },
          ],
        },
        {
          type: "message",
          role: "developer",
          content:
            "<skills_instructions>a</skills_instructions>\n<permissions instructions>b</permissions instructions>",
        },
      ])
    }),
  )
})
// OWN-PATCH(P-021) end
