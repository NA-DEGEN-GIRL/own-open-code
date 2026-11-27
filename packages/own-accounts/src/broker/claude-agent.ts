export * as BrokerClaudeAgent from "./claude-agent.js"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Broker, ClaudeAgent as Route } from "@own/protocol"
import type { Logger } from "../logger.js"
import type { Contract } from "./contract.js"

/**
 * The PC side of the Claude Agent route on SSH hosts (02 §8.10.13, 04 §8.13, CAG-R1). A host's provider runs its claude
 * processes and transcript work here: each is a stream of the host's broker session, and the core provider on this PC
 * runs it ({@link Route.HostServer}, P-052) in the account folder the host names (when the host's account scope allows
 * it) and in a working folder of its own per host folder (`<OWN_HOME>\claude-agent\hosts\<host>\<hash>`). The provider
 * checks claude's arguments and the host's input, counts the process in this PC's pool and keeps the login's e-mail
 * here; this module checks the account and ties the streams to the session (a lost connection closes them).
 */

export interface Backend {
  readonly log: Logger.Logger
  /** The provider's server on the observer channel; absent while no provider runs (then nothing opens). */
  readonly server: () => Route.HostServer | undefined
  /**
   * The account folder of a Claude Agent account a host with this scope may use, its transcript link checked; throws
   * the refusal (Korean) otherwise.
   */
  readonly folder: (accountID: string, scope: Contract.AccountScope) => Promise<string>
  /** `<OWN_HOME>\claude-agent\hosts`. */
  readonly root: string
}

type Push = (event: Broker.PushEvent, data: unknown) => void

interface Open {
  readonly stream: Route.HostStream
}

export function make(backend: Backend) {
  const hosts = new Map<string, Map<string, Open>>()
  const streamsOf = (hostId: string) => {
    const known = hosts.get(hostId)
    if (known) return known
    const made = new Map<string, Open>()
    hosts.set(hostId, made)
    return made
  }

  return {
    open: async (
      hostId: string,
      scope: Contract.AccountScope,
      params: Broker.ClaudeAgentOpen,
      push: Push,
    ): Promise<Broker.ClaudeAgentOpened> => {
      const streams = streamsOf(hostId)
      if (streams.has(params.stream)) return { refused: "closed", message: "Claude Agent: the stream is already open" }
      if (streams.size >= Broker.CLAUDE_AGENT_STREAMS_MAX)
        return { refused: "busy", message: "Claude Agent: 이 호스트가 PC에서 연 Claude 작업이 너무 많아요." }
      const server = backend.server()
      if (!server) return { refused: "off", message: "Claude Agent: PC에서 Claude Agent가 아직 준비되지 않았어요." }
      const configDir = await backend.folder(params.accountID, scope).catch((error: unknown) => error as Error)
      if (configDir instanceof Error) return { refused: "account", message: configDir.message }
      const root = path.join(backend.root, safe(hostId))
      const directory =
        params.directory === "" ? root : path.join(root, createHash("sha256").update(params.directory).digest("hex").slice(0, 16))
      await fs.mkdir(directory, { recursive: true })
      // A placeholder, so a close or a lost session while the pool makes the host wait finds the stream.
      const waiting = new AbortController()
      const holder: Open = {
        stream: {
          start: () => {},
          write: () => {},
          end: () => {},
          close: () => waiting.abort(),
          onData: () => {},
          onExit: () => {},
        },
      }
      streams.set(params.stream, holder)
      const opened = await (
        params.kind === "process"
          ? server.open(
              {
                configDir,
                directory,
                member: {
                  side: params.side === true,
                  ...(params.sessionID === undefined ? {} : { sessionID: params.sessionID }),
                  ...(params.parentID === undefined ? {} : { parentID: params.parentID }),
                },
              },
              waiting.signal,
            )
          : Promise.resolve(server.callStream({ configDir, directory, root }, params.op ?? "version"))
      ).catch((error: unknown) => error as Error)
      if (streams.get(params.stream) !== holder || opened instanceof Error) {
        if (!(opened instanceof Error)) opened.close()
        if (streams.get(params.stream) === holder) streams.delete(params.stream)
        backend.log.info("claude_agent_open_failed", { hostId, kind: params.kind, error: opened instanceof Error ? opened.message : "closed" })
        return { refused: "closed", message: opened instanceof Error ? opened.message : "Claude Agent: the stream was closed" }
      }
      streams.set(params.stream, { stream: opened })
      opened.onData((data) => {
        for (let at = 0; at < data.length; at += Broker.CLAUDE_AGENT_CHUNK)
          push("claudeAgent.data", { stream: params.stream, data: data.slice(at, at + Broker.CLAUDE_AGENT_CHUNK) })
      })
      opened.onExit((code, error) => {
        if (streams.get(params.stream)?.stream === opened) streams.delete(params.stream)
        push("claudeAgent.exit", { stream: params.stream, code, ...(error === undefined ? {} : { error }) })
      })
      if (params.kind === "process") backend.log.info("claude_agent_process", { hostId, account: params.accountID })
      return { opened: true }
    },

    start: (hostId: string, params: Broker.ClaudeAgentStart) => {
      const open = hosts.get(hostId)?.get(params.stream)
      if (!open) return false
      open.stream.start({ args: params.args, env: params.env })
      return true
    },

    write: (hostId: string, params: Broker.ClaudeAgentWrite) => {
      const open = hosts.get(hostId)?.get(params.stream)
      if (!open) return false
      if (params.data !== undefined) open.stream.write(params.data)
      if (params.end) open.stream.end()
      return true
    },

    close: (hostId: string, params: Broker.ClaudeAgentClose) => {
      const open = hosts.get(hostId)?.get(params.stream)
      hosts.get(hostId)?.delete(params.stream)
      open?.stream.close()
      return true
    },

    /** The host's session ended (a lost connection, another session, the host removed): every stream of it closes. */
    drop: (hostId: string) => {
      const streams = hosts.get(hostId)
      if (!streams || streams.size === 0) return
      backend.log.info("claude_agent_dropped", { hostId, streams: streams.size })
      const all = [...streams.values()]
      streams.clear()
      for (const open of all) open.stream.close()
    },

    /** Streams open per host (status, tests). */
    count: (hostId: string) => hosts.get(hostId)?.size ?? 0,
  }
}

export type Relay = ReturnType<typeof make>

function safe(hostId: string) {
  return hostId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "host"
}
