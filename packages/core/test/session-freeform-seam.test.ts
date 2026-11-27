// OWN-PATCH(P-020) begin
// A request hook marks a tool freeform with `x-opencode-freeform: {syntax, definition}` on its input schema (the own
// harness: Codex's apply_patch and Code Mode's exec). Core turns the marker into @opencode/ai's `freeform`, so OpenAI
// Responses sends a custom tool with that grammar and its raw call text still reaches the tool as `{ input }`.
import { describe, expect } from "bun:test"
import { LLMEvent, ToolDefinition } from "@opencode/ai/effect"
import { OpenAIChat, OpenAIResponses } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Tool } from "@opencode/core/tool"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const GRAMMAR = 'start: "*** Begin Patch" LF "*** End Patch"'
const session = Session.Info.make({
  id: Session.ID.make("ses_freeform_seam"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = (route: typeof OpenAIResponses.route | typeof OpenAIChat.route) =>
  SessionRunnerModel.resolved(route.model({ id: "gpt-test", provider: "openai" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})
const patchTool = ToolDefinition.make({
  name: "apply_patch",
  description: "Apply a patch",
  inputSchema: {
    type: "object",
    properties: { input: { type: "string", description: "The entire contents of the apply_patch command" } },
    required: ["input"],
    additionalProperties: false,
  },
})
const tools = { definitions: [patchTool], execute: () => new Tool.Error({ message: "unused" }) }

/** The primary request after a hook that marks apply_patch freeform, as own-harness's codex request does. */
const prepared = (route: typeof OpenAIResponses.route | typeof OpenAIChat.route, marked = true) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    if (marked)
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          const entry = event.tools.apply_patch
          if (entry)
            event.tools.apply_patch = {
              ...entry,
              input: { ...entry.input, "x-opencode-freeform": { syntax: "lark", definition: GRAMMAR } },
            }
        }),
      )
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    return yield* requests.primary({
      session,
      agent: Agent.ID.make("build"),
      model: model(route),
      tools,
      system: [],
      messages: [],
    })
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

describe("freeform tools from a hook's input marker (P-020)", () => {
  it.effect("become @opencode/ai freeform tools, sent as Responses custom tools with their grammar", () =>
    Effect.gen(function* () {
      const request = (yield* prepared(OpenAIResponses.route)).request
      expect(request.tools).toHaveLength(1)
      expect(request.tools[0]).toMatchObject({ name: "apply_patch", freeform: { type: "lark", grammar: GRAMMAR } })
      const body = (yield* compileRequest(request)).body as { tools?: ReadonlyArray<unknown> }
      // Byte for byte what P-020's protocol half sent (the own-harness goldens).
      expect(JSON.stringify(body.tools)).toBe(
        JSON.stringify([
          {
            type: "custom",
            name: "apply_patch",
            description: "Apply a patch",
            format: { type: "grammar", syntax: "lark", definition: GRAMMAR },
          },
        ]),
      )
    }),
  )

  it.effect("leave tools without the marker as they were", () =>
    Effect.gen(function* () {
      const request = (yield* prepared(OpenAIResponses.route, false)).request
      // Upstream always writes the key since #61703 (undefined unless the capabilities list the format).
      expect(JSON.stringify(request.tools[0])).not.toContain('"freeform"')
      const body = (yield* compileRequest(request)).body as { tools?: ReadonlyArray<{ type: string }> }
      expect(body.tools?.[0]?.type).toBe("function")
    }),
  )

  it.effect("decode a raw call into the tool's one string field, `input`", () =>
    Effect.gen(function* () {
      const request = (yield* prepared(OpenAIResponses.route)).request
      const raw = "*** Begin Patch\n*** End Patch"
      const call = LLMEvent.toolCall({ id: "call_1", name: "apply_patch", input: { input: raw } })
      // The call event core receives is the ordinary one (upstream's freeform-tools tests cover the wire decoding);
      // the custom tool's field is the input schema's only property.
      const tool = request.tools[0]
      expect(tool?.type === "tool" ? ToolDefinition.freeformField(tool.inputSchema) : undefined).toBe("input")
      expect(call.input).toEqual({ input: raw })
    }),
  )
})
// OWN-PATCH(P-020) end
