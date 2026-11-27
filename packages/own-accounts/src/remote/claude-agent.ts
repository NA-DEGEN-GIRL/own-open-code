export * as RemoteClaudeAgent from "./claude-agent.js"

import { Option, Schema } from "effect"
import { Broker, ClaudeAgent as Route } from "@own/protocol"
import type { Logger } from "../logger.js"
import type { Client } from "./client.js"

/**
 * The host side of the Claude Agent route on SSH hosts (02 §8.10.13, 04 §8.13, CAG-R1): the relay this service's
 * provider runs its claude processes and transcript work through (core P-052, the observer channel's `relay`). Each
 * process or call is a stream of the broker session: `claudeAgent.open` (a process waits for a slot of the PC's pool),
 * `claudeAgent.start` with the SDK's arguments, `claudeAgent.write` in order, and the PC's `claudeAgent.data` /
 * `claudeAgent.exit` pushes back. Only on a normal-mode session (the PC is this build), like GitHub. A lost session ends
 * every stream at once, so the provider sees its claude gone and resumes the conversation on the next turn.
 */

export interface Input {
  readonly request: (method: Broker.Method, params: unknown, timeoutMs: number) => Promise<Client.Reply>
  /** The session is normal mode now. */
  readonly normal: () => boolean
  /** Waits for a session up to the broker wait; `true` when one is there. */
  readonly wait: () => Promise<boolean>
  readonly log: Logger.Logger
}

interface Local {
  readonly data: Array<(data: string) => void>
  readonly exit: Array<(code: number | null, error?: string) => void>
  readonly early: string[]
  done: boolean
  /** How it ended, for a listener that comes later. */
  ended?: { readonly code: number | null; readonly error?: string }
}

const decodeOpened = Schema.decodeUnknownOption(Broker.ClaudeAgentOpened)
const decodeData = Schema.decodeUnknownOption(Broker.ClaudeAgentData)
const decodeExit = Schema.decodeUnknownOption(Broker.ClaudeAgentExit)

const UNREACHABLE = "PC에 연결되어 있지 않아 Claude Agent를 쓸 수 없어요. 연결이 돌아오면 다시 보내 주세요."

export function make(input: Input) {
  const streams = new Map<string, Local>()
  const counter = { next: 1 }

  const finish = (id: string, code: number | null, error?: string) => {
    const local = streams.get(id)
    if (!local || local.done) return
    local.done = true
    local.ended = { code, ...(error === undefined ? {} : { error }) }
    streams.delete(id)
    for (const listener of local.exit) listener(code, error)
  }

  const transport: Route.HostTransport = {
    open: async (open, signal) => {
      const accountID = Route.relayAccount(open.configDir)
      if (accountID === undefined) throw new Error("Claude Agent: no account for this conversation")
      if (!input.normal() && !((await input.wait()) && input.normal())) throw new Error(UNREACHABLE)
      const id = `ca${counter.next++}_${Math.random().toString(36).slice(2, 10)}`
      const local: Local = { data: [], exit: [], early: [], done: false }
      streams.set(id, local)
      const abort = () => {
        void input.request("claudeAgent.close", { stream: id }, 15_000)
        finish(id, 1, "cancelled")
      }
      signal?.addEventListener("abort", abort, { once: true })
      const reply = await input.request(
        "claudeAgent.open",
        {
          stream: id,
          kind: open.kind,
          accountID,
          directory: open.directory,
          ...(open.op === undefined ? {} : { op: open.op }),
          ...(open.member?.sessionID === undefined ? {} : { sessionID: open.member.sessionID }),
          ...(open.member?.parentID === undefined ? {} : { parentID: open.member.parentID }),
          ...(open.member === undefined ? {} : { side: open.member.side }),
        },
        open.kind === "process" ? Broker.CLAUDE_AGENT_OPEN_TIMEOUT_MS : 30_000,
      )
      signal?.removeEventListener("abort", abort)
      const opened = reply.ok ? Option.getOrUndefined(decodeOpened(reply.result)) : undefined
      if (!opened || "refused" in opened || local.done) {
        finish(id, 1)
        if (local.done && signal?.aborted) throw new Error("cancelled")
        throw new Error(opened && "refused" in opened ? opened.message : reply.ok ? UNREACHABLE : unreachable(reply.error))
      }
      const send = (params: Record<string, unknown>) =>
        void input.request("claudeAgent.write", { stream: id, ...params }, 60_000).then((answer) => {
          if (!answer.ok) finish(id, 1, unreachable(answer.error))
        })
      return {
        start: (spawn) => {
          void input
            .request("claudeAgent.start", { stream: id, args: spawn.args, env: spawn.env }, 30_000)
            .then((answer) => {
              if (!answer.ok) finish(id, 1, unreachable(answer.error))
            })
        },
        write: (data) => {
          if (local.done) return
          for (let at = 0; at < data.length; at += Broker.CLAUDE_AGENT_CHUNK)
            send({ data: data.slice(at, at + Broker.CLAUDE_AGENT_CHUNK) })
        },
        end: () => {
          if (!local.done) send({ end: true })
        },
        close: () => {
          if (local.done) return
          void input.request("claudeAgent.close", { stream: id }, 15_000)
          finish(id, null)
        },
        onData: (listener) => {
          local.data.push(listener)
          for (const text of local.early.splice(0)) listener(text)
        },
        onExit: (listener) => {
          if (local.ended) return listener(local.ended.code, local.ended.error)
          local.exit.push(listener)
        },
      }
    },
  }

  return {
    transport,
    /** `claudeAgent.data` / `claudeAgent.exit` pushes. */
    push: (push: Broker.Push) => {
      if (push.event === "claudeAgent.data") {
        const data = Option.getOrUndefined(decodeData(push.data))
        const local = data ? streams.get(data.stream) : undefined
        if (!data || !local) return
        if (local.data.length === 0) return void local.early.push(data.data)
        for (const listener of local.data) listener(data.data)
        return
      }
      if (push.event === "claudeAgent.exit") {
        const data = Option.getOrUndefined(decodeExit(push.data))
        if (data) finish(data.stream, data.code, data.error)
      }
    },
    /** The session ended: every stream ends now (the PC closes its side too). */
    drop: () => {
      if (streams.size === 0) return
      input.log.info("claude_agent_dropped", { streams: streams.size })
      for (const id of [...streams.keys()]) finish(id, 1, UNREACHABLE)
    },
    count: () => streams.size,
  }
}

function unreachable(error: string) {
  return error === "unavailable" || error === "timeout" ? UNREACHABLE : `Claude Agent: the PC answered ${error}`
}
