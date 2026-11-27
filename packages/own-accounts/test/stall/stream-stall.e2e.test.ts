// P-018 on a real upstream server (own/ledger/core-patches.yaml P-018): a fake OpenAI Responses endpoint starts a
// tool call, sends half of its arguments, then only keepalive comments and `response.in_progress` (what the
// 2026-10-11 incident's stream did for an hour). The byte-level chunk timeout never fires on such a stream; the
// watchdog on parsed events does, with the provider's `toolInputTimeout`/`progressTimeout` settings set short here.
// 1. Stalled mid tool call: the step continues (the partial call is settled, never executed) and the next request
//    reuses the first one's input as its prefix.
// 2. Stalled before any output on every attempt: three timeout retries, then a visible step error and idle session.
// No own plugin is loaded: the patch is core's. Every credential is fake.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { opencodeConfig, startOpencodeServer, type OpencodeServer } from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000
const PROVIDER = "fake-stall"
const TOOL_STALL = "stall-tool"
const ALWAYS_STALL = "stall-always"
const FILE = "half-written.txt"

describe("P-018: a model stream that keeps sending keepalives but no progress", () => {
  const state: { fake?: StallingResponses; server?: OpencodeServer } = {}

  beforeAll(async () => {
    state.fake = startStallingResponses()
    state.server = await startOpencodeServer({
      config: opencodeConfig({
        providers: {
          [PROVIDER]: {
            name: "Fake stalling Responses",
            package: "@opencode/ai/providers/openai",
            settings: {
              baseURL: state.fake.baseURL,
              apiKey: "fake-key-stall",
              progressTimeout: 2_000,
              toolInputTimeout: 1_500,
            },
            models: { [TOOL_STALL]: { name: TOOL_STALL }, [ALWAYS_STALL]: { name: ALWAYS_STALL } },
          },
        },
        model: `${PROVIDER}/${TOOL_STALL}`,
      }),
    })
    await state.server.waitForModels([
      { providerID: PROVIDER, id: TOOL_STALL },
      { providerID: PROVIDER, id: ALWAYS_STALL },
    ])
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    state.fake?.stop()
  }, 60_000)

  test(
    "a stall inside tool-call arguments continues the step without running the half-written call",
    async () => {
      const server = required(state.server)
      const fake = required(state.fake)
      const session = await server.createSession({ model: { providerID: PROVIDER, id: TOOL_STALL }, title: "stall" })
      const started = Date.now()
      await server.prompt(session.id, "Write the file")
      await server.waitIdle(session.id)
      // Detected by the 1.5 s tool-input limit, not after the 5-minute byte gap or an hour of inactivity.
      expect(Date.now() - started).toBeLessThan(60_000)

      const turns = fake.turns(TOOL_STALL)
      expect(turns).toHaveLength(2)
      const [first, second] = turns.map((turn) => required(turn))
      // Same cache key and the same input: upstream retries a stream that failed after output with the same request
      // (v2.3.0 #60674), so the half-written call never reaches the provider.
      expect(second.prompt_cache_key).toBe(first.prompt_cache_key)
      expect(second.input).toEqual([...first.input])

      const messages = await server.messages(session.id)
      const assistants = messages.filter((message) => message.type === "assistant")
      expect(assistants).toHaveLength(2)
      // The message list is newest first.
      expect(assistants[1]).toMatchObject({
        finish: "error",
        error: { type: "provider.transport", message: "A tool call input made no progress for 2 seconds" },
        content: [{ type: "tool", name: fake.toolName, executed: false, state: { status: "error" } }],
      })
      expect(assistants[0]).toMatchObject({ finish: "stop", content: [{ type: "text", text: "Recovered" }] })
      expect(await Bun.file(path.join(server.paths.workspace, FILE)).exists()).toBe(false)
      await expect(fs.readdir(server.paths.workspace)).resolves.not.toContain(FILE)
    },
    TURN_TIMEOUT,
  )

  test(
    "stalls on every attempt end in a visible error after three timeout retries",
    async () => {
      const server = required(state.server)
      const fake = required(state.fake)
      const session = await server.createSession({ model: { providerID: PROVIDER, id: ALWAYS_STALL }, title: "stall" })
      await server.prompt(session.id, "Answer")
      await server.waitIdle(session.id)

      expect(fake.turns(ALWAYS_STALL)).toHaveLength(4)
      const assistants = (await server.messages(session.id)).filter((message) => message.type === "assistant")
      expect(assistants).toHaveLength(1)
      expect(assistants[0]).toMatchObject({
        finish: "error",
        error: { type: "provider.transport", message: "The model stream made no progress for 2 seconds" },
      })
    },
    TURN_TIMEOUT,
  )
})

interface Turn {
  readonly model: string
  readonly prompt_cache_key?: string
  readonly input: readonly unknown[]
  readonly tools?: readonly { readonly name?: string }[]
}

interface StallingResponses {
  readonly baseURL: string
  readonly toolName: string
  turns(model: string): readonly Turn[]
  stop(): void
}

/**
 * `POST /v1/responses`: the first tool-bearing request for TOOL_STALL starts a call and stalls inside its arguments,
 * every request for ALWAYS_STALL stalls before output, anything else (the continued step, titles) answers at once.
 */
function startStallingResponses(): StallingResponses {
  const turns: Turn[] = []
  const timers = new Set<ReturnType<typeof setInterval>>()
  let toolName = "write"
  const sse = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
  // Keepalives every 250 ms until the client gives up on the response (cancel) or the fake stops.
  const stalled = (opening: readonly Record<string, unknown>[]) => {
    const encoder = new TextEncoder()
    const keepalive = encoder.encode(
      `: keepalive\n\n${sse({ type: "response.in_progress", response: { id: "resp_stall" } })}`,
    )
    let timer: ReturnType<typeof setInterval> | undefined
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(opening.map(sse).join("")))
        timer = setInterval(() => controller.enqueue(keepalive), 250)
        timers.add(timer)
      },
      cancel() {
        clearInterval(timer)
      },
    })
  }
  const answer = (text: string) =>
    [
      { type: "response.created", response: { id: "resp_ok" } },
      { type: "response.output_item.added", item: { type: "message", id: "msg_ok", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_ok", delta: text },
      {
        type: "response.output_item.done",
        item: { type: "message", id: "msg_ok", role: "assistant", content: [{ type: "output_text", text }] },
      },
      { type: "response.completed", response: { id: "resp_ok", usage: { input_tokens: 10, output_tokens: 2 } } },
    ]
      .map(sse)
      .join("")
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/v1/models")
        return Response.json({
          object: "list",
          data: [TOOL_STALL, ALWAYS_STALL].map((id) => ({ id, object: "model" })),
        })
      if (request.method !== "POST" || url.pathname !== "/v1/responses")
        return new Response("not found", { status: 404 })
      const body = (await request.json()) as Turn
      const headers = { "content-type": "text/event-stream" }
      if (!body.tools?.length) return new Response(answer("Title"), { headers })
      turns.push(body)
      const names = body.tools.flatMap((tool) => (tool.name ? [tool.name] : []))
      toolName = names.includes("write") ? "write" : (names[0] ?? toolName)
      const created = { type: "response.created", response: { id: "resp_stall" } }
      if (body.model === ALWAYS_STALL) return new Response(stalled([created]), { headers })
      if (turns.filter((turn) => turn.model === TOOL_STALL).length > 1)
        return new Response(answer("Recovered"), { headers })
      const call = { type: "function_call", id: "fc_stall", call_id: "call_stall", name: toolName, arguments: "" }
      const half = `{"filePath":"${FILE}","content":"half-wri`
      return new Response(
        stalled([
          created,
          { type: "response.output_item.added", output_index: 0, item: call },
          { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_stall", delta: half },
        ]),
        { headers },
      )
    },
  })
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    get toolName() {
      return toolName
    },
    turns: (model) => turns.filter((turn) => turn.model === model),
    stop() {
      timers.forEach(clearInterval)
      server.stop(true)
    },
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value")
  return value
}
