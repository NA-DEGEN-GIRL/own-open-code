// OWN-PATCH(P-022) begin
// Responses Lite on OpenAI Responses (Codex's request shape for GPT-6 code mode): tools travel in an
// `additional_tools` input item (top-level tools in the `functions` namespace, then the request's namespaces) instead
// of `tools`, `reasoning.context` and an explicit `tool_choice: "auto"` are options, and a call in the `functions`
// namespace reads as a top-level call. Requests without these options are unchanged.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ai, LLMEvent, Message, ToolCallPart, ToolDefinition, ToolNamespace } from "../../src/effect.js"
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

const exec = ToolDefinition.make({
  name: "exec",
  description: "Run JavaScript.",
  inputSchema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  // Upstream's freeform tools (v2.2.1) replace P-020's input marker; the own harness sets it through core's seam.
  freeform: { type: "lark", grammar: "start: SOURCE\nSOURCE: /[\\s\\S]+/\n" },
})
const wait = ToolDefinition.make({
  name: "wait",
  description: "Wait on a cell.",
  inputSchema: { type: "object", properties: { cell_id: { type: "string" } } },
})
const clock = ToolNamespace.make({
  name: "clock",
  description: "Tools for reading and waiting on time.",
  tools: [
    ToolDefinition.make({
      name: "sleep",
      description: "Sleep.",
      inputSchema: { type: "object", properties: { duration_ms: { type: "number" } } },
    }),
  ],
})

const LITE = {
  responsesLite: { id: "at_1" },
  reasoningEffort: "low",
  reasoningContext: "all_turns",
  parallelToolCalls: false,
  toolChoiceAuto: true,
}

describe("Responses Lite", () => {
  it.effect("moves the tools into an additional_tools item", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        ai.request({ model, prompt: "go", tools: [exec, wait, clock], providerOptions: LITE }),
      )
      expect(prepared.body.tools).toBeUndefined()
      expect(prepared.body.tool_choice).toBe("auto")
      expect(prepared.body.parallel_tool_calls).toBe(false)
      expect(prepared.body.reasoning).toEqual({ effort: "low", context: "all_turns" })
      expect(prepared.body.input[0]).toEqual({
        type: "additional_tools",
        id: "at_1",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: [
              {
                type: "custom",
                name: "exec",
                description: "Run JavaScript.",
                format: { type: "grammar", syntax: "lark", definition: "start: SOURCE\nSOURCE: /[\\s\\S]+/\n" },
              },
              {
                type: "function",
                name: "wait",
                description: "Wait on a cell.",
                parameters: { type: "object", properties: { cell_id: { type: "string" } } },
                strict: false,
              },
            ],
          },
          {
            type: "namespace",
            name: "clock",
            description: "Tools for reading and waiting on time.",
            tools: [
              {
                type: "function",
                name: "sleep",
                description: "Sleep.",
                parameters: { type: "object", properties: { duration_ms: { type: "number" } } },
                strict: false,
              },
            ],
          },
        ],
      })
    }),
  )

  it.effect("leaves requests without the options as they were", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(ai.request({ model, prompt: "go", tools: [wait] }))
      expect(prepared.body.tools).toHaveLength(1)
      expect(prepared.body.tool_choice).toBeUndefined()
      expect(prepared.body.input[0]).toMatchObject({ role: "user" })
    }),
  )

  it.effect("reads a call in the functions namespace as a top-level call", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        ai.request({ model, prompt: "go", tools: [wait], providerOptions: LITE }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "wait",
                  namespace: "functions",
                  arguments: '{"cell_id":"3"}',
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      const calls = response.events.filter(LLMEvent.is.toolCall)
      expect(calls.map((call) => ({ name: call.name, namespace: call.namespace, input: call.input }))).toEqual([
        { name: "wait", namespace: undefined, input: { cell_id: "3" } },
      ])
    }),
  )

  it.effect("replays a function call as completed only with completedCalls", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("What is in hello.txt?"),
        Message.assistant([ToolCallPart.make({ id: "call_1", name: "wait", input: { cell_id: "3" } })]),
        Message.tool({ id: "call_1", name: "wait", result: "done" }),
      ]
      const replay = (providerOptions?: Record<string, unknown>) =>
        compileRequest(ai.request({ model, messages, tools: [wait], providerOptions })).pipe(
          Effect.map((prepared) => prepared.body.input.find((item: { type: string }) => item.type === "function_call")),
        )
      expect(yield* replay({ completedCalls: true })).toEqual({
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "wait",
        arguments: '{"cell_id":"3"}',
      })
      expect((yield* replay()).status).toBeUndefined()
    }),
  )
})
// OWN-PATCH(P-022) end
