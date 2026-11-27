// OWN-PATCH(P-026) begin
// Client tool search on OpenAI Responses (Codex's `tool_search` with deferred tools): the search tool's definition is
// sent as is (P-023), its `tool_search_call` reads as a call of the flat tool, replays go back as tool_search_call and
// tool_search_output, and a deferred placed tool (P-024 with `deferred`) is not sent but its calls map back.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ai, LLMEvent, Message, ToolCallPart, ToolDefinition } from "../../src/effect.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import * as OpenAIResponses from "../../src/protocols/openai-responses.js"
import { LLMClient } from "../../src/route.js"
import { Auth } from "../../src/route/auth.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5.5" })

const DEFINITION = {
  type: "tool_search",
  execution: "client",
  description: "Search deferred tools.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
}
const search = ToolDefinition.make({
  name: "tool_search",
  description: "Search deferred tools.",
  inputSchema: { type: "object", properties: {}, [OpenAIResponses.HOSTED_KEY]: DEFINITION },
})
const spawn = ToolDefinition.make({
  name: "multi_agent_v1__spawn_agent",
  description: "Spawn an agent.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    [OpenResponses.NAMESPACE_KEY]: { namespace: "multi_agent_v1", name: "spawn_agent", deferred: true },
  },
})

describe("client tool search", () => {
  it.effect("sends the search definition and leaves deferred tools out", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(ai.request({ model, prompt: "go", tools: [search, spawn] }))
      expect(prepared.body.tools).toEqual([DEFINITION])
    }),
  )

  it.effect("reads tool_search_call as a call of the search tool, and a deferred tool's call by its flat name", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(ai.request({ model, prompt: "go", tools: [search, spawn] })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "tool_search_call",
                  id: "ts_1",
                  call_id: "call_1",
                  status: "completed",
                  execution: "client",
                  arguments: { query: "spawn agent" },
                },
              },
              {
                type: "response.output_item.done",
                output_index: 1,
                item: {
                  type: "function_call",
                  id: "fc_2",
                  call_id: "call_2",
                  name: "spawn_agent",
                  namespace: "multi_agent_v1",
                  arguments: '{"message":"hi"}',
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      const calls = response.events.filter(LLMEvent.is.toolCall)
      expect(calls.map((call) => ({ name: call.name, input: call.input }))).toEqual([
        { name: "tool_search", input: { query: "spawn agent" } },
        { name: "multi_agent_v1__spawn_agent", input: { message: "hi" } },
      ])
    }),
  )

  it.effect("replays the search as tool_search_call and tool_search_output", () =>
    Effect.gen(function* () {
      const loaded = [{ type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent" }] }]
      const prepared = yield* compileRequest(
        ai.request({
          model,
          tools: [search, spawn],
          messages: [
            Message.user("go"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "tool_search", input: { query: "spawn" } })]),
            Message.tool({ id: "call_1", name: "tool_search", result: JSON.stringify(loaded), resultType: "text" }),
          ],
        }),
      )
      expect(prepared.body.input.slice(1)).toEqual([
        { type: "tool_search_call", call_id: "call_1", status: "completed", execution: "client", arguments: { query: "spawn" } },
        { type: "tool_search_output", call_id: "call_1", status: "completed", execution: "client", tools: loaded },
      ])
    }),
  )
})
// OWN-PATCH(P-026) end
