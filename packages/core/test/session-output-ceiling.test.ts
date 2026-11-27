// OWN-PATCH(P-032) begin
// The request hooks see `outputCeiling`: core's default output limit without its 256,000 cap, so a hook can apply a
// cap of its own the way core applies 256,000 (own/ledger/core-patches.yaml P-032). Default limits stay as they were.
import { describe, expect } from "bun:test"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionRequest, SessionRequestKind } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const session = Session.Info.make({
  id: Session.ID.make("ses_output_ceiling"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const modelWith = (limit: { readonly context: number; readonly output: number }) =>
  SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "large-output", provider: "test" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit,
  })
// DeepSeek V4's limits: more output than core's 256,000 cap.
const large = modelWith({ context: 1_000_000, output: 393_216 })
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

const seen = (kind: SessionRequestKind, input: Partial<SessionModelRequest.Input> = {}) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const prepared = yield* requests[kind]({
      session,
      agent: Agent.ID.make("build"),
      model: large,
      system: [],
      messages: [],
      ...input,
    })
    const event: SessionRequest = prepared.event
    return { ceiling: event.outputCeiling, maxTokens: prepared.request.maxTokens }
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

describe("SessionModelRequest outputCeiling (P-032)", () => {
  it.effect("primary requests keep core's 256,000 default and see the model's own limit", () =>
    Effect.gen(function* () {
      expect(yield* seen("primary")).toEqual({ ceiling: 393_216, maxTokens: 256_000 })
      // Since upstream v2.1 a summary gets the same output limit as a normal turn (#57564).
      expect(yield* seen("compaction")).toEqual({ ceiling: 393_216, maxTokens: 256_000 })
      // Titles and generate get neither.
      expect(yield* seen("title")).toEqual({ ceiling: undefined, maxTokens: undefined })
      expect(yield* seen("generate")).toEqual({ ceiling: undefined, maxTokens: undefined })
    }),
  )

  it.effect("both are fitted to the room the prompt leaves", () =>
    Effect.gen(function* () {
      // Primary requests leave upstream's 1% window headroom (v2.2.1, #59934):
      // 990,000 − 700,000 − ceil(10,000 × 1.15) = 278,500: above the cap, below the model's limit.
      expect(yield* seen("primary", { inputTokens: { measured: 700_000, estimated: 10_000 } })).toEqual({
        ceiling: 278_500,
        maxTokens: 256_000,
      })
      // Below both: the same value.
      expect(yield* seen("primary", { inputTokens: { measured: 900_000, estimated: 30_000 } })).toEqual({
        ceiling: 55_500,
        maxTokens: 55_500,
      })
      // Compaction keeps the whole window (its own reserve sizes the summary).
      expect(yield* seen("compaction", { inputTokens: { measured: 900_000, estimated: 30_000 } })).toEqual({
        ceiling: 65_500,
        maxTokens: 65_500,
      })
      // Never below core's floor.
      expect(yield* seen("primary", { inputTokens: { measured: 999_900, estimated: 0 } })).toEqual({
        ceiling: 1_024,
        maxTokens: 1_024,
      })
    }),
  )

  it.effect("a model below the cap has one value; one without a catalog limit gets core's fallback", () =>
    Effect.gen(function* () {
      expect(yield* seen("primary", { model: modelWith({ context: 200_000, output: 64_000 }) })).toEqual({
        ceiling: 64_000,
        maxTokens: 64_000,
      })
      expect(yield* seen("primary", { model: modelWith({ context: 200_000, output: 0 }) })).toEqual({
        ceiling: 32_000,
        maxTokens: 32_000,
      })
    }),
  )

  it.effect("a hook that applies its own cap through outputCeiling is what the request sends", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.options.maxTokens = Math.min(event.outputCeiling ?? 0, 300_000)
        }),
      )
      expect(yield* seen("primary")).toEqual({ ceiling: 393_216, maxTokens: 300_000 })
    }),
  )
})
// OWN-PATCH(P-032) end
