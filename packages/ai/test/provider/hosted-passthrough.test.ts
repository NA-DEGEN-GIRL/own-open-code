// OWN-PATCH(P-023) begin
// A tool whose input schema carries `x-opencode-hosted` goes out on OpenAI Responses as that hosted tool definition
// (Codex's `web_search`); other tools are unchanged.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ai, ToolDefinition } from "../../src/effect.js"
import * as OpenAIResponses from "../../src/protocols/openai-responses.js"
import { Auth } from "../../src/route/auth.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5.5" })

const WEB_SEARCH = { type: "web_search", external_web_access: true, search_content_types: ["text", "image"] }

describe("hosted tool passthrough", () => {
  it.effect("sends the hosted definition in place of a function tool", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        ai.request({
          model,
          prompt: "search",
          tools: [
            ToolDefinition.make({
              name: "web_search",
              description: "Hosted web search.",
              inputSchema: { type: "object", [OpenAIResponses.HOSTED_KEY]: WEB_SEARCH },
            }),
            ToolDefinition.make({ name: "lookup", description: "Look up.", inputSchema: { type: "object" } }),
          ],
        }),
      )
      expect(prepared.body.tools).toEqual([
        WEB_SEARCH,
        { type: "function", name: "lookup", description: "Look up.", parameters: { type: "object" }, strict: false },
      ])
    }),
  )
})
// OWN-PATCH(P-023) end
