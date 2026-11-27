export * as SideQuestions from "./side.js"

import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { Kv, OwnAccounts, OwnID, Side, type Ledger } from "@own/protocol"
import type { SessionSideResult } from "@opencode/plugin/promise/session"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"

/**
 * Owner: SIDE (곁질문, `/btw`, 02 §9.7, 03 §4.4.2). A side question is one model call on the conversation's history as
 * its next step would send it (core P-061 `ctx.session.side`: the same system, instructions, tools and messages, so the
 * provider's prompt cache holds), with the side thread after it and no tool run. Nothing enters the conversation: core
 * writes no event, message, step or usage, and the threads live in this plugin's KV (`sess:<id>:side`), which no
 * instruction or compaction reads. The usage is a `kind: "side"` ledger line (telemetry `recordSide`), never a step.
 * The text streams as `side.delta` events and ends with `side.ended`. The service that runs the conversation answers,
 * an SSH host's for a host conversation. Running answers are process state: a restart ends them as failed.
 */
export interface Api extends Module.Lifecycle {
  ask: RpcTypes.Handler<"side.ask">
  get: RpcTypes.Handler<"side.get">
  list: RpcTypes.Handler<"side.list">
  cancel: RpcTypes.Handler<"side.cancel">
  remove: RpcTypes.Handler<"side.remove">
}

type Thread = OwnAccounts.SideThread
type Turn = OwnAccounts.SideTurn

/**
 * Read before the first question of a thread, in the same user message, so later follow-ups resend it byte for byte.
 * English like the harnesses' own instructions; the model answers in the user's language.
 */
export const INSTRUCTION = [
  "<side-question>",
  "The user asks a quick side question about this conversation. It is not part of the conversation: the main work",
  "goes on without it and never sees this question or your answer. Answer directly and concisely from what the",
  "conversation already shows, in the user's language. No tools are available for this answer: do not call any tool",
  "and do not take any action. If a good answer needs a look at files or a command, say briefly what you would check.",
  "</side-question>",
].join("\n")

/** Deltas are sent at most this often; a slow phone link gets fewer, larger frames. */
const DELTA_MS = 80

const Threads = Schema.Struct({ threads: Schema.Array(OwnAccounts.SideThread) })
const decodeThreads = Schema.decodeUnknownOption(Threads)
const toJson = Schema.decodeUnknownSync(Schema.Json)

interface Running {
  readonly sessionID: string
  readonly index: number
  readonly controller: AbortController
  text: string
}

// Process state shared by every Location's instance: any of them may answer `side.get` or `side.cancel`.
const running = new Map<string, Running>()
const queues = new Map<string, Promise<unknown>>()

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("side")

  const ask: Api["ask"] = async (input, context) => {
    const known = await deps.ctx.session.get({ sessionID: input.sessionID }).then(
      () => true,
      () => false,
    )
    if (!known) return context.error("side_unavailable", "no such conversation", { reason: "session" })
    const now = deps.clock.now()
    const added = await serial(input.sessionID, async () => {
      const threads = await read(input.sessionID)
      const current = input.threadID === undefined ? undefined : threads.find((item) => item.id === input.threadID)
      if (input.threadID !== undefined && !current) return { type: "missing" as const }
      const busy = [...running.values()].filter((item) => item.sessionID === input.sessionID).length
      if (busy >= Side.RUNNING_MAX) return { type: "busy" as const, max: Side.RUNNING_MAX }
      if (current && (running.has(current.id) || current.turns.length >= Side.TURNS_MAX))
        return { type: "busy" as const, max: Side.TURNS_MAX }
      const turn: Turn = { question: input.question, answer: "", status: "running", startedAt: now }
      const thread: Thread = current
        ? { ...current, updatedAt: now, turns: [...current.turns, turn] }
        : { id: `side_${OwnID.ulid(now)}`, sessionID: SessionID.make(input.sessionID), createdAt: now, updatedAt: now, turns: [turn] }
      await write(input.sessionID, [thread, ...threads.filter((item) => item.id !== thread.id)])
      running.set(thread.id, {
        sessionID: input.sessionID,
        index: thread.turns.length - 1,
        controller: new AbortController(),
        text: "",
      })
      return { type: "ok" as const, thread }
    })
    if (added.type === "missing")
      return context.error("side_not_found", "no such side thread", { threadID: input.threadID ?? "" })
    if (added.type === "busy")
      return context.error("side_busy", "the conversation already waits for side answers", { max: added.max })
    void answer(added.thread, toolChoiceOf())
    return { thread: added.thread }
  }

  const get: Api["get"] = async (input, context) => {
    const thread = (await read(input.sessionID)).find((item) => item.id === input.threadID)
    if (!thread) return context.error("side_not_found", "no such side thread", { threadID: input.threadID })
    return { thread: live(thread) }
  }

  const list: Api["list"] = async (input) => ({
    threads: (await read(input.sessionID)).map((thread) => {
      const shown = live(thread)
      const last = shown.turns[shown.turns.length - 1]!
      return {
        id: thread.id,
        question: thread.turns[0]!.question.slice(0, 200),
        turns: thread.turns.length,
        status: last.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      }
    }),
  })

  const cancel: Api["cancel"] = async (input) => ({ cancelled: stop(input.sessionID, input.threadID) })

  const remove: Api["remove"] = async (input) => {
    stop(input.sessionID, input.threadID)
    return serial(input.sessionID, async () => {
      const threads = await read(input.sessionID)
      if (!threads.some((item) => item.id === input.threadID)) return { removed: false }
      await write(
        input.sessionID,
        threads.filter((item) => item.id !== input.threadID),
      )
      return { removed: true }
    })
  }

  /** Streams one answer and stores how it ended. Never throws. */
  const answer = async (thread: Thread, toolChoice: "none" | undefined) => {
    const entry = running.get(thread.id)!
    const index = entry.index
    const timer = setTimeout(() => entry.controller.abort("timeout"), Side.TIMEOUT_MS)
    const pending = { text: "", offset: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    const flush = () => {
      pending.timer = undefined
      if (pending.text === "") return
      const text = pending.text
      const offset = pending.offset
      pending.offset += text.length
      pending.text = ""
      void deps.emitter.session("side.delta", { sessionID: thread.sessionID, threadID: thread.id, turn: index, offset, text })
    }
    const onText = (text: string) => {
      entry.text += text
      pending.text += text
      pending.timer ??= setTimeout(flush, DELTA_MS)
    }
    const startedAt = deps.clock.now()
    const ask = (toolChoice: "none" | undefined) =>
      deps.ctx.session.side(
        { sessionID: thread.sessionID, turns: turnsOf(thread, index), ...(toolChoice ? { toolChoice } : {}), onText },
        { signal: entry.controller.signal },
      )
    const outcome = await ask(toolChoice)
      // A model that went for a tool before saying anything gets one more try that asks for no tool call.
      .then((result) => (result.finish === "tool-calls" && result.text.trim() === "" ? ask("none") : result))
      .then(
        (result) => ({ type: "done" as const, result }),
        (error: unknown) => ({ type: "failed" as const, error }),
      )
    clearTimeout(timer)
    if (pending.timer) clearTimeout(pending.timer)
    flush()
    const reason = entry.controller.signal.aborted ? entry.controller.signal.reason : undefined
    const turn: Turn =
      outcome.type === "done"
        ? await finished(thread, index, outcome.result, startedAt)
        : {
            ...thread.turns[index]!,
            answer: Side.cut(entry.text),
            status: reason === "cancelled" ? "cancelled" : "failed",
            endedAt: deps.clock.now(),
            ...(reason === "cancelled" ? {} : { error: failure(reason, outcome.error) }),
          }
    if (outcome.type === "failed" && reason !== "cancelled")
      log.warn("side_failed", { sessionID: thread.sessionID, threadID: thread.id, error: String(outcome.error) })
    running.delete(thread.id)
    await serial(thread.sessionID, async () => {
      const threads = await read(thread.sessionID)
      const stored = threads.find((item) => item.id === thread.id)
      // Removed while it ran: the answer still reaches open panels, nothing is stored.
      if (!stored || stored.turns.length <= index) return
      const updated = { ...stored, updatedAt: deps.clock.now(), turns: stored.turns.map((item, at) => (at === index ? turn : item)) }
      await write(thread.sessionID, threads.map((item) => (item.id === thread.id ? updated : item)))
    }).catch((error: unknown) => log.warn("side_store_failed", { sessionID: thread.sessionID, error }))
    void deps.emitter.session("side.ended", { sessionID: thread.sessionID, threadID: thread.id, index, turn })
  }

  /** A finished answer's turn and its `side` ledger line. */
  const finished = async (thread: Thread, index: number, result: SessionSideResult, startedAt: number): Promise<Turn> => {
    const tokens: Ledger.Tokens | null = result.tokens
      ? {
          input: result.tokens.input,
          cacheRead: result.tokens.cache.read,
          cacheWrite: result.tokens.cache.write,
          cacheWrite1h: null,
          output: result.tokens.output,
          reasoning: result.tokens.reasoning,
        }
      : null
    const cost = await peers()
      .telemetry.recordSide({
        sessionID: thread.sessionID,
        model: result.model,
        at: startedAt,
        tokens,
        costUSD: result.cost ?? null,
      })
      .catch((error: unknown) => {
        log.warn("side_ledger_failed", { sessionID: thread.sessionID, error })
        return null
      })
    return {
      ...thread.turns[index]!,
      answer: Side.cut(result.text),
      status: "done",
      endedAt: deps.clock.now(),
      finish: result.finish,
      model: {
        providerID: result.model.providerID,
        id: result.model.id,
        ...(result.model.variant === undefined ? {} : { variant: result.model.variant }),
      },
      ...(tokens ? { tokens } : {}),
      cost,
      ...(result.finish === "length" ? { error: "답이 너무 길어 중간에 끊겼어요." } : {}),
      ...(result.finish === "content-filter" ? { error: "제공자가 답을 막았어요." } : {}),
    }
  }

  /** The stored thread with a running turn's text so far; a running turn nothing runs any more failed (a restart). */
  const live = (thread: Thread): Thread => ({
    ...thread,
    turns: thread.turns.map((turn, index) => {
      if (turn.status !== "running") return turn
      const entry = running.get(thread.id)
      if (entry && entry.index === index) return { ...turn, answer: entry.text }
      return { ...turn, status: "failed", error: "서비스가 다시 시작돼 답이 끊겼어요." }
    }),
  })

  const read = async (sessionID: string): Promise<ReadonlyArray<Thread>> => {
    const stored = await deps.ctx.storage.get(Kv.side(sessionID))
    if (stored === undefined) return []
    const decoded = decodeThreads(stored)
    // Side threads are a convenience: a row this build cannot read starts the list again rather than block asking.
    if (Option.isNone(decoded)) log.warn("side_unreadable", { sessionID })
    return Option.match(decoded, { onNone: () => [], onSome: (value) => value.threads })
  }

  const write = (sessionID: string, threads: ReadonlyArray<Thread>) => {
    const kept = threads.slice(0, Side.THREADS_MAX)
    if (kept.length === 0) return deps.ctx.storage.remove(Kv.side(sessionID))
    return deps.ctx.storage.set(Kv.side(sessionID), toJson(Schema.encodeSync(Threads)({ threads: kept })))
  }

  return {
    ask,
    get,
    list,
    cancel,
    remove,
    start: async () => {},
    stop: async () => {
      for (const entry of running.values()) entry.controller.abort("stopped")
    },
    onEvent: (event, meta) => {
      if (event.type !== "session.deleted" || !meta.local) return
      const sessionID = event.data.sessionID
      for (const [id, entry] of running) if (entry.sessionID === sessionID) running.get(id)?.controller.abort("cancelled")
      void serial(sessionID, () => deps.ctx.storage.remove(Kv.side(sessionID))).catch(() => undefined)
    },
  }
}

/** The side thread as model turns: every finished turn before `index`, then the question at `index`. */
export function turnsOf(thread: Thread, index: number) {
  const prompt = (question: string, at: number) => (at === 0 ? `${INSTRUCTION}\n\n${question}` : question)
  const before = thread.turns
    .slice(0, index)
    .flatMap((turn, at) =>
      turn.status === "done" && turn.answer !== ""
        ? [
            { role: "user" as const, text: prompt(turn.question, at) },
            { role: "assistant" as const, text: turn.answer },
          ]
        : [],
    )
  return [...before, { role: "user" as const, text: prompt(thread.turns[index]!.question, index) }]
}

/**
 * The first attempt's tool choice: none sent, on every route. The tools stay in every side request so the conversation's
 * cached prefix holds, and `tool_choice:"none"` measured as a cache break on ChatGPT and DeepSeek (0 % read on the first side
 * question against 96-99 % without it) and as no tools at all on the Claude Agent route; the Anthropic and OpenAI keys
 * read the same either way
 * (own/reports/side-question-2026-11-22.md §3). The instruction keeps the model off tools; a textless tool call is asked
 * again once with `none`. `OWN_SIDE_TOOL_CHOICE=none` forces it for the live check.
 */
export function toolChoiceOf(): "none" | undefined {
  return process.env.OWN_SIDE_TOOL_CHOICE === "none" ? "none" : undefined
}

/** Ends a thread's running answer; false when nothing of that conversation ran. */
function stop(sessionID: string, threadID: string) {
  const entry = running.get(threadID)
  if (!entry || entry.sessionID !== sessionID) return false
  entry.controller.abort("cancelled")
  return true
}

/** Korean text for a failed answer; the provider's own message stays in the log. */
function failure(reason: unknown, error: unknown) {
  if (reason === "timeout") return "5분 안에 답이 끝나지 않아 멈췄어요."
  if (reason === "stopped") return "서비스가 멈춰 답이 끊겼어요."
  const text = error instanceof Error ? error.message : String(error)
  return `답을 받지 못했어요: ${text.slice(0, 200)}`
}

/** Runs one session's KV read-modify-writes in order, across this process's instances. */
function serial<A>(sessionID: string, task: () => Promise<A>): Promise<A> {
  const next = (queues.get(sessionID) ?? Promise.resolve()).then(task, task)
  queues.set(
    sessionID,
    next.catch(() => undefined),
  )
  return next
}
