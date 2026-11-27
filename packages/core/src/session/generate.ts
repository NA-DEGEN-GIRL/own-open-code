export * as SessionGenerate from "./generate.js"

import type { FileSystem } from "../filesystem.js"
import { LLMClient, LLMEvent, Message, type AIError, type Usage } from "@opencode/ai/effect"
import { Effect, Stream } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionModelRequest } from "./model-request.js"
import { ModelRetry } from "../model-retry.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"

export type Error =
  | AgentNotFoundError
  | Instructions.InitializationBlocked
  | SessionRunnerModel.Error
  | AIError
  | FileSystem.DirectoryNotFoundError

export type Result = SessionUsage.Recorded & { readonly text: string }

/**
 * Generates text from current Session context without mutating history.
 * Usage is reported like a step's and added to the Session's totals.
 */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session, { kind: "generate", agent: selection.agent.id })
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
        Message.user(input.prompt),
      ],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const response = yield* llm.generate(prepared.request, prepared.options).pipe(ModelRetry.retry)
    const usage = SessionUsage.record(response.usage, model.cost)
    yield* bus.publish(SessionEvent.UsageRecorded, { sessionID: selection.session.id, source: "generate", ...usage })
    return { text: response.text, ...usage }
  }).pipe(instances.provide(input.session))
})

// OWN-PATCH(P-061) begin
export interface SideInput {
  readonly turns: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>
  readonly toolChoice?: "none"
  readonly onText?: (text: string) => void
}

export interface SideResult {
  readonly text: string
  readonly finish: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other"
  readonly model: SessionRunnerModel.Resolved["ref"]
  readonly tokens?: SessionUsage.Recorded["tokens"]
  readonly cost?: number
}

const FINISHES = new Set<string>(["stop", "length", "tool-calls", "content-filter", "error"])

/**
 * A side question (own's /btw): one streamed `generate` request on the history the next primary request would carry
 * (settled messages, the epoch's instructions and the pending instruction update), with the side thread after it. Hooks
 * see `side: true` so they can shape it like that primary request and keep the provider's prompt cache. It records
 * nothing: no input, message, step, usage or event; the caller accounts for the usage it returns. A tool call ends it:
 * a side call never runs tools. No retry: text already streamed would repeat.
 */
export const side = Effect.fn("SessionGenerate.side")(function* (input: SideInput & { session: SessionSchema.Info }) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const llm = yield* LLMClient.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    // The primary request's model: a side question is that request's next step, for its prompt cache.
    const model = yield* context.resolveModel(selection.session, { kind: "primary", agent: selection.agent.id })
    const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
    const transcript = SessionModelRequest.baseTranscript({
      agent: selection.agent.info,
      model,
      tools: selection.tools,
      initial: history.initial,
      messages: history.messages,
    })
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: transcript.system,
      messages: [
        ...transcript.messages,
        ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
        ...input.turns.map((turn) => (turn.role === "user" ? Message.user(turn.text) : Message.assistant(turn.text))),
      ],
      toolChoice: input.toolChoice,
      side: true,
    })
    const streamed = yield* llm.stream(prepared.request, prepared.options).pipe(
      Stream.takeUntil((event) => LLMEvent.is.toolInputStart(event) || LLMEvent.is.toolCall(event)),
      Stream.runFold(
        (): { text: string; finish?: string; usage?: Usage; tool: boolean } => ({ text: "", tool: false }),
        (state, event) => {
          if (LLMEvent.is.textDelta(event)) {
            input.onText?.(event.text)
            return { ...state, text: state.text + event.text }
          }
          if (LLMEvent.is.toolInputStart(event) || LLMEvent.is.toolCall(event)) return { ...state, tool: true }
          if (LLMEvent.is.stepFinish(event)) return { ...state, usage: event.usage ?? state.usage }
          if (LLMEvent.is.finish(event))
            return { ...state, finish: event.reason.normalized, usage: event.usage ?? state.usage }
          return state
        },
      ),
    )
    const recorded = streamed.usage ? SessionUsage.record(streamed.usage, model.cost) : undefined
    const finish = streamed.tool ? "tool-calls" : (streamed.finish ?? "other")
    return {
      text: streamed.text,
      finish: FINISHES.has(finish) ? (finish as SideResult["finish"]) : "other",
      model: model.ref,
      ...(recorded ? { tokens: recorded.tokens, cost: recorded.cost } : {}),
    } satisfies SideResult
  }).pipe(instances.provide(input.session))
})
// OWN-PATCH(P-061) end
