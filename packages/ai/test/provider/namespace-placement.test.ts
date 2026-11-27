// OWN-PATCH(P-024) begin
// Native namespace placement on OpenAI Responses: a flat tool whose input schema carries `x-opencode-namespace` is
// sent inside that native namespace under its leaf name, its calls (namespace + leaf) read as calls of the flat tool,
// and replayed calls go back placed. Tools without the key are unchanged.
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
  .model({ id: "gpt-6.1-sol" })

const SLEEP_INPUT = { type: "object", properties: { duration_ms: { type: "number" } } }
const sleep = ToolDefinition.make({
  name: "clock__sleep",
  description: "Sleep.",
  inputSchema: {
    ...SLEEP_INPUT,
    [OpenResponses.NAMESPACE_KEY]: {
      namespace: "clock",
      name: "sleep",
      description: "Tools for reading and waiting on time.",
    },
  },
})
const wait = ToolDefinition.make({
  name: "wait",
  description: "Wait on a cell.",
  inputSchema: { type: "object", properties: { cell_id: { type: "string" } } },
})
const SLEEP_LEAF = { type: "function", name: "sleep", description: "Sleep.", parameters: SLEEP_INPUT, strict: false }
const CLOCK = {
  type: "namespace",
  name: "clock",
  description: "Tools for reading and waiting on time.",
  tools: [SLEEP_LEAF],
}

describe("native namespace placement", () => {
  it.effect("sends a placed tool inside its namespace", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(ai.request({ model, prompt: "go", tools: [sleep, wait] }))
      expect(prepared.body.tools).toEqual([
        CLOCK,
        {
          type: "function",
          name: "wait",
          description: "Wait on a cell.",
          parameters: { type: "object", properties: { cell_id: { type: "string" } } },
          strict: false,
        },
      ])
    }),
  )

  it.effect("places the namespace after the functions namespace in Responses Lite", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        ai.request({ model, prompt: "go", tools: [sleep, wait], providerOptions: { responsesLite: {} } }),
      )
      expect(prepared.body.input[0]).toMatchObject({
        type: "additional_tools",
        tools: [{ type: "namespace", name: "functions", tools: [{ name: "wait" }] }, CLOCK],
      })
    }),
  )

  it.effect("replays calls of a placed tool with the namespace and leaf", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        ai.request({
          model,
          tools: [sleep, wait],
          messages: [
            Message.user("go"),
            Message.assistant([
              ToolCallPart.make({ id: "call_1", name: "clock__sleep", input: { duration_ms: 5 } }),
              ToolCallPart.make({ id: "call_2", name: "wait", input: { cell_id: "1" } }),
            ]),
            Message.tool({ id: "call_1", name: "clock__sleep", result: "Sleep completed.", resultType: "text" }),
            Message.tool({ id: "call_2", name: "wait", result: "done", resultType: "text" }),
          ],
        }),
      )
      expect(prepared.body.input.slice(1, 3)).toEqual([
        { type: "function_call", call_id: "call_1", name: "sleep", namespace: "clock", arguments: '{"duration_ms":5}' },
        { type: "function_call", call_id: "call_2", name: "wait", arguments: '{"cell_id":"1"}' },
      ])
    }),
  )

  it.effect("reads a call in the namespace as a call of the flat tool", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(ai.request({ model, prompt: "go", tools: [sleep] })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "sleep", namespace: "clock" },
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "sleep",
                  namespace: "clock",
                  arguments: '{"duration_ms":5}',
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      const calls = response.events.filter(LLMEvent.is.toolCall)
      expect(calls.map((call) => ({ name: call.name, namespace: call.namespace, input: call.input }))).toEqual([
        { name: "clock__sleep", namespace: undefined, input: { duration_ms: 5 } },
      ])
    }),
  )
})
// OWN-PATCH(P-024) end
