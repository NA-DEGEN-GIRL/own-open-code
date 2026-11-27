// OWN-PATCH(P-018) begin
// The no-progress watchdog on parsed model events (route/client.ts watchProgress, own/ledger/core-patches.yaml P-018).
// A scripted SSE server sends events while the test clock moves; keepalives keep the byte-level chunk timeout quiet.
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AIError, isRetryable, ai, type TimeoutConfig } from "../src/effect.js"
import { Auth, LLMClient } from "../src/route.js"
import * as OpenAIResponses from "../src/protocols/openai-responses.js"
import { configure } from "../src/providers/openai.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { it } from "./lib/effect.js"

const responses = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5" })
const chat = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
const KEEPALIVE = ": keepalive\n\n"
const IN_PROGRESS = { type: "response.in_progress", response: { id: "resp_1" } }
const CALL = { type: "function_call", id: "fc_1", call_id: "call_1", name: "patch", arguments: "" }
const MESSAGE = { type: "message", id: "msg_1", role: "assistant", content: [] }
const args = (delta: string) => ({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta })
const text = (delta: string) => ({ type: "response.output_text.delta", item_id: "msg_1", delta })
const added = (item: unknown) => ({ type: "response.output_item.added", item })
const COMPLETED = { type: "response.completed", response: { id: "resp_1" } }

/** One streamed response the test writes event by event; each write waits until the client read it. */
const scripted = (model: typeof responses | typeof chat, timeout?: TimeoutConfig) =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>()
    const pending: string[] = []
    let wake = () => {}
    let closed = false
    const layer = dynamicResponse((input) =>
      Effect.sync(() => {
        Deferred.doneUnsafe(requested, Effect.void)
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            while (pending.length === 0 && !closed) await new Promise<void>((resolve) => (wake = resolve))
            if (pending.length === 0) return controller.close()
            controller.enqueue(new TextEncoder().encode(pending.splice(0).join("")))
          },
        })
        return input.respond(body, { headers: { "content-type": "text/event-stream" } })
      }),
    )
    const fiber = yield* LLMClient.generate(ai.request({ model, prompt: "Hello", timeout })).pipe(
      Effect.provide(layer),
      Effect.exit,
      Effect.forkChild({ startImmediately: true }),
    )
    yield* Deferred.await(requested)
    const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
    const send = (...events: unknown[]) =>
      Effect.gen(function* () {
        pending.push(
          ...events.map((event) => (typeof event === "string" ? event : `data: ${JSON.stringify(event)}\n\n`)),
        )
        wake()
        yield* flush
      })
    // Moves the clock in steps, sending `each` (a keepalive by default) before every step.
    const wait = (seconds: number, step = 60, each: unknown = KEEPALIVE) =>
      Effect.gen(function* () {
        for (let at = 0; at < seconds; at += step) {
          yield* send(each)
          yield* TestClock.adjust(`${Math.min(step, seconds - at)} seconds`)
          yield* flush
        }
      })
    const end = (...events: unknown[]) =>
      Effect.gen(function* () {
        yield* send(...events)
        closed = true
        wake()
      })
    const done = () => fiber.pollUnsafe() !== undefined
    return { send, wait, end, done, exit: Fiber.join(fiber) }
  })

const failure = (exit: Exit.Exit<unknown, AIError>) => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (!(error instanceof AIError))
    throw new Error(`expected an AIError, got ${Exit.isSuccess(exit) ? "success" : "a defect"}`)
  return error
}
const expectTimeout = (exit: Exit.Exit<unknown, AIError>, message: string) => {
  const error = failure(exit)
  expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read", code: "Timeout", message })
  expect(isRetryable(error)).toBe(true)
}

describe("P-018 stream progress watchdog", () => {
  it.effect(
    "fails a keepalive-only stall at the progress timeout, not before",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.send({ type: "response.created", response: { id: "resp_1" } }, IN_PROGRESS)
        yield* stream.wait(299, 60, IN_PROGRESS)
        expect(stream.done()).toBe(false)
        yield* stream.wait(1)
        expectTimeout(yield* stream.exit, "The model stream made no progress for 300 seconds")
      }),
    30_000,
  )

  it.effect(
    "fails a stall inside tool-call arguments after 120 seconds",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.send(added(CALL), args('{"patchText":"*** Begin'))
        yield* stream.wait(119, 30)
        expect(stream.done()).toBe(false)
        yield* stream.wait(1)
        expectTimeout(yield* stream.exit, "A tool call input made no progress for 120 seconds")
      }),
    30_000,
  )

  it.effect(
    "does not count empty deltas as progress",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.send(added(MESSAGE), text("Hi"))
        yield* stream.wait(300, 30, text(""))
        expectTimeout(yield* stream.exit, "The model stream made no progress for 300 seconds")
      }),
    30_000,
  )

  it.effect(
    "caps a tool-call input that keeps growing at 600 seconds",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.send(added(CALL))
        yield* stream.wait(599, 30, args("x"))
        expect(stream.done()).toBe(false)
        yield* stream.wait(1, 1, args("x"))
        expectTimeout(yield* stream.exit, "A tool call input stayed open for 600 seconds")
      }),
    30_000,
  )

  it.effect(
    "caps the size of one tool-call input",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.send(added(CALL), args("x".repeat(1_000_001)))
        expectTimeout(yield* stream.exit, "A tool call input grew past 1000000 characters without completing")
      }),
    30_000,
  )

  it.effect(
    "lets a stream with short gaps run past the progress timeout (chat route: no attempt cap)",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(chat)
        yield* stream.wait(1_000, 10, deltaChunk({ content: "a" }))
        yield* stream.end(finishChunk("stop"), "data: [DONE]\n\n")
        expect(Exit.isSuccess(yield* stream.exit)).toBe(true)
      }),
    30_000,
  )

  it.effect(
    "counts reasoning-summary deltas as progress",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.send(added({ type: "reasoning", id: "rs_1" }))
        const summary = { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "…" }
        yield* stream.wait(750, 250, summary)
        expect(stream.done()).toBe(false)
        yield* stream.end(added(MESSAGE), text("Done"), COMPLETED)
        expect(Exit.isSuccess(yield* stream.exit)).toBe(true)
      }),
    30_000,
  )

  it.effect(
    "caps one Responses attempt at 900 seconds even with steady progress",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.send(added(MESSAGE))
        yield* stream.wait(899, 10, text("a"))
        expect(stream.done()).toBe(false)
        yield* stream.wait(1, 1, text("a"))
        expectTimeout(yield* stream.exit, "The model response did not complete within 900 seconds")
      }),
    30_000,
  )

  it.effect(
    "retries the backend's request_timeout like the attempt cap",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(responses)
        yield* stream.end(added(MESSAGE), text("a"), {
          type: "error",
          error: { type: "invalid_request_error", code: "request_timeout", message: "Request timed out." },
        })
        const error = failure(yield* stream.exit)
        expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read", code: "Timeout" })
        expect(error.reason.message).toContain("request_timeout")
        expect(isRetryable(error)).toBe(true)
      }),
    30_000,
  )

  it.effect(
    "follows per-model settings: shorter limits, or none",
    () =>
      Effect.gen(function* () {
        const short = yield* scripted(responses, { progress: 10_000, toolInput: 5_000 })
        yield* short.send(added(CALL), args("{"))
        yield* short.wait(5, 1)
        expectTimeout(yield* short.exit, "A tool call input made no progress for 5 seconds")

        const off = yield* scripted(responses, { progress: false, toolInput: false, total: false })
        yield* off.send(added(CALL), args("{"))
        yield* off.wait(1_200)
        expect(off.done()).toBe(false)
        yield* off.end(args("}"), { type: "response.output_item.done", item: { ...CALL, arguments: "{}" } }, COMPLETED)
        expect(Exit.isSuccess(yield* off.exit)).toBe(true)
      }),
    30_000,
  )

  it.effect(
    "has no progress limit by default when the chunk timeout is disabled",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(chat, { chunk: false })
        yield* stream.send(deltaChunk({ content: "a" }))
        yield* TestClock.adjust("20 minutes")
        expect(stream.done()).toBe(false)
        yield* stream.end(finishChunk("stop"), "data: [DONE]\n\n")
        expect(Exit.isSuccess(yield* stream.exit)).toBe(true)
      }),
    30_000,
  )

  it.effect(
    "fails a keepalive-only stream at 300 s when the chunk timeout is disabled, and silence never",
    () =>
      Effect.gen(function* () {
        const queued = yield* scripted(chat, { chunk: false })
        yield* queued.wait(299)
        expect(queued.done()).toBe(false)
        yield* queued.wait(1)
        expectTimeout(yield* queued.exit, "The response sent only keepalives for 300 seconds")

        // Silence first (a local server reading a long prompt) does not count; the window opens at the first comment.
        const silent = yield* scripted(chat, { chunk: false })
        yield* TestClock.adjust("20 minutes")
        yield* silent.wait(240)
        expect(silent.done()).toBe(false)
        yield* silent.end(deltaChunk({ content: "a" }), finishChunk("stop"), "data: [DONE]\n\n")
        expect(Exit.isSuccess(yield* silent.exit)).toBe(true)
      }),
    30_000,
  )

  it.effect(
    "restarts the keepalive window on any other byte and leaves it to an explicit progress setting",
    () =>
      Effect.gen(function* () {
        const stream = yield* scripted(chat, { chunk: false })
        yield* stream.wait(240)
        yield* stream.send(deltaChunk({ role: "assistant" }))
        yield* stream.wait(240)
        expect(stream.done()).toBe(false)
        yield* stream.end(deltaChunk({ content: "a" }), finishChunk("stop"), "data: [DONE]\n\n")
        expect(Exit.isSuccess(yield* stream.exit)).toBe(true)

        const off = yield* scripted(chat, { chunk: false, progress: false })
        yield* off.wait(1_200)
        expect(off.done()).toBe(false)
        yield* off.end(deltaChunk({ content: "a" }), finishChunk("stop"), "data: [DONE]\n\n")
        expect(Exit.isSuccess(yield* off.exit)).toBe(true)
      }),
    30_000,
  )
})
// OWN-PATCH(P-018) end
