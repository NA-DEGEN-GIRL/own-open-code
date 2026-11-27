export * as ClaudeSession from "./session.js"

import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider"
import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-044) begin
import type { SpareProcess } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-044) end
import { ToolNames } from "../tools/names.js"
import { ClaudeProbe } from "./probe.js"
import { ClaudeSDK } from "./sdk.js"

interface Turn {
  readonly drained: PromiseWithResolvers<void>
  readonly messages: SDKMessage[]
  wake?: () => void
  finished: boolean
}

export type Interface = Awaited<ReturnType<typeof start>>

export async function start(
  options: Options,
  // OWN-PATCH(P-044) begin
  // A spare claude prewarmed with these options' host-level half: the session binds it instead of starting one.
  spare?: SpareProcess,
  // OWN-PATCH(P-044) end
  // OWN-PATCH(P-051) begin
  readVersion?: ClaudeProbe.ReadVersion,
  // OWN-PATCH(P-051) end
) {
  const { query } = await ClaudeSDK.load()
  let input!: ReadableStreamDefaultController<SDKUserMessage>
  const prompt = new ReadableStream<SDKUserMessage>({
    start(controller) {
      input = controller
    },
  })
  // OWN-PATCH(P-044) begin
  const session = spare
    ? spare.claim({
        prompt,
        options: { cwd: options.cwd ?? process.cwd(), ...(options.model === undefined ? {} : { model: options.model }) },
      })
    : query({ prompt, options })
  // The claimed session's id comes from the claim; a refused claim fails `ready`, so the caller starts one instead.
  const claimed = spare?.claimed.then((info) => info.sessionId)
  let claimedID: string | undefined
  // OWN-PATCH(P-044) end
  let turn: Turn | undefined
  let initialized = false
  let ended = false
  let failure: unknown
  let stopping: Promise<void> | undefined
  let persisted = false
  // OWN-PATCH(P-044) begin
  const ready = Promise.all([session.initializationResult(), claimed]).then(
    async ([init, id]): Promise<ClaudeProbe.Result> => {
      claimedID = id
      // OWN-PATCH(P-044) end
      // OWN-PATCH(P-051) begin
      const version = await ClaudeProbe.resolveVersion(init.claude_code_version, options, readVersion)
      const error = ClaudeProbe.versionError(version)
      if (error) throw error
      initialized = true
      return { version, account: init.account, models: init.models }
      // OWN-PATCH(P-051) end
    },
  )
  // A cancel during startup can stop the session before anything awaits ready.
  ready.catch(() => {})

  function finishTurn() {
    if (!turn) return
    turn.finished = true
    turn.drained.resolve()
  }

  // The only reader of the SDK iterator, including while a turn is being cancelled.
  async function readAll() {
    try {
      for await (const message of session) {
        if (turn) {
          turn.messages.push(message)
          turn.wake?.()
        }
        if (message.type === "assistant" || message.type === "result") persisted = true
        if (message.type === "result") finishTurn()
      }
    } catch (error) {
      failure = error
    } finally {
      ended = true
      finishTurn()
      turn?.wake?.()
    }
  }
  const pump = readAll()

  async function interrupt() {
    const active = turn
    if (!active || active.finished || ended) return
    await session.interrupt()
    // interrupt() resolves before the result and transcript flush, so wait for the drain before another turn starts.
    await active.drained.promise
  }

  async function shutdown() {
    try {
      if (initialized && !ended) {
        await session.interrupt()
        if (turn && !turn.finished) await turn.drained.promise
      }
      input.close()
      // An uninitialized process has no conversation to flush.
      if (!initialized) session.close()
      await pump
    } finally {
      session.close()
    }
  }

  function stop() {
    if (!stopping) stopping = shutdown()
    return stopping
  }

  function begin(content: SDKUserMessage["message"]["content"], uuid = crypto.randomUUID()) {
    if (ended || stopping) throw failure ?? new Error("Claude Code session has stopped")
    if (turn && !turn.finished) throw new Error("Claude Code is still finishing the previous turn")
    turn = { drained: Promise.withResolvers<void>(), messages: [], finished: false }
    input.enqueue({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null })
  }

  async function readStep(
    emit: (message: SDKMessage) => void,
    tools: readonly LanguageModelV3FunctionTool[],
  ): Promise<SDKResultMessage | "tools"> {
    const active = turn
    if (!active) throw new Error("No Claude turn to read")
    let calledTools = false
    while (true) {
      const message = active.messages.shift()
      if (!message) {
        if (ended) throw failure ?? new Error("Claude Code stopped before finishing its reply")
        await new Promise<void>((resolve) => {
          active.wake = resolve
        })
        continue
      }
      emit(message)
      if (message.type === "assistant" && message.parent_tool_use_id === null) {
        for (const part of message.message.content) {
          // Calls to tools we did not offer get Claude Code's own error, and the turn continues without OpenCode.
          if (part.type === "tool_use" && ToolNames.original(part.name, tools)) calledTools = true
        }
      }
      const replyEnded =
        message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_stop"
      if (calledTools && replyEnded) return "tools"
      if (message.type === "result") return message
    }
  }

  return {
    // OWN-PATCH(P-044) begin
    get id() {
      return claimedID ?? options.resume ?? options.sessionId!
    },
    // OWN-PATCH(P-044) end
    ready,
    get ended() {
      return ended
    },
    get persisted() {
      return persisted
    },
    get running() {
      return !!turn && !turn.finished
    },
    begin,
    readStep,
    addUser(content: SDKUserMessage["message"]["content"], uuid: NonNullable<SDKUserMessage["uuid"]>) {
      input.enqueue({
        type: "user",
        uuid,
        priority: "next",
        message: { role: "user", content },
        parent_tool_use_id: null,
      })
    },
    interrupt,
    stop,
    setModel: (model: string) => session.setModel(model),
    setEffort: (effort: Options["effort"]) => session.applyFlagSettings({ effortLevel: effort ?? null }),
    // OWN-PATCH(P-060) begin
    setFastMode: (fast: boolean) => session.applyFlagSettings({ fastMode: fast }),
    // OWN-PATCH(P-060) end
    // OWN-PATCH(P-039) begin
    usage: () => session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
    // OWN-PATCH(P-039) end
  }
}
