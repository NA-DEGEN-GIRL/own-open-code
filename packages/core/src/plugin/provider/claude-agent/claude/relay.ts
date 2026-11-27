// OWN-PATCH(P-052) begin
export * as ClaudeRelay from "./relay.js"

import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import type { SessionMessage, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeFork } from "./fork.js"
import { FolderStore } from "./folder-store.js"
import type { ClaudeIO } from "./io.js"
import { ClaudeObserver } from "./observer.js"
import { ClaudeQueryOptions } from "./query-options.js"

// own (02 §8.10.13, 04 §8.13, decisions CAG-R1): the Claude Agent route on an SSH host. `claude` runs on the PC, where
// its login, account folders, transcripts and process pool are; the host's provider drives it through own's broker.
// The host's OpenCode keeps everything else: the turn loop, the records, the in-process MCP tool server and the hooks
// (they travel as control messages over claude's stdio), so every tool runs on the host. The host never receives a
// token: the PC builds claude's arguments and environment itself and lets through only what the provider sends.
//
// Host side: own-accounts (remote mode) names a {@link Transport} on the observer channel (`relay`), and `ClaudeIO.real`
// then runs the provider's processes and transcript work through {@link io}. PC side: the provider serves hosts
// ({@link server}, the channel's `hosts`), and own-accounts' broker hands it the account folder and working folder of
// each request.

/** Who a process is for: the pool on the PC counts it like a local one (P-044). */
export interface Member {
  readonly sessionID?: string
  readonly parentID?: string
  readonly side: boolean
}

/** One relayed stream: a claude process, or one transcript call. Text in both directions (stream-json, JSON). */
export interface Stream {
  start(spawn: { readonly args: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> }): void
  write(data: string): void
  end(): void
  close(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (code: number | null, error?: string) => void): void
}

/** What own-accounts (remote mode) gives the host's provider. */
export interface Transport {
  /**
   * A process stream once the PC granted it a slot of its pool (which may wait), or a call stream at once. `configDir`
   * is the account token the provider got from own-accounts ({@link TOKEN_PREFIX}); `directory` the host folder.
   */
  open(
    input: {
      readonly kind: "process" | "call"
      readonly configDir: string
      readonly directory: string
      readonly member?: Member
      readonly op?: Op
    },
    signal?: AbortSignal,
  ): Promise<Stream>
}

/** The account folder a host's provider names: `relay:<accountID>`. It is never a path on either side. */
export const TOKEN_PREFIX = "relay:"

export function token(accountID: string) {
  return `${TOKEN_PREFIX}${accountID}`
}

export function accountOf(configDir: string | undefined) {
  if (!configDir?.startsWith(TOKEN_PREFIX)) return undefined
  return configDir.slice(TOKEN_PREFIX.length)
}

/** Transcript and version work done on the PC (02 §8.10.11 through the relay). */
export type Op = "exists" | "fork" | "remove" | "chain" | "write" | "list" | "discard" | "version"

export const OPS: ReadonlyArray<Op> = ["exists", "fork", "remove", "chain", "write", "list", "discard", "version"]

/** Text per relayed piece (a broker frame is at most 1 MiB; a character is at most 6 bytes of JSON). */
export const CHUNK = 128 * 1024
/** A call's request or answer beyond this is refused (a transcript is a few MB). */
export const CALL_MAX = 64 * 1024 * 1024

/** What Claude Code is told on a host, where its own working folder and platform are not the workspace's. */
export const NOTE =
  "<runtime_info>Claude Code runs on the user's PC while OpenCode and its tools run on an SSH host where the workspace is. The working directory, platform and git status Claude Code reports describe the PC, not the workspace: use OpenCode's environment information and the host's paths.</runtime_info>"

// ---------------------------------------------------------------------------------------------------------------------
// Host side

/** The provider's IO on a host: every process and transcript operation goes to the PC. */
export function io(transport: Transport): ClaudeIO.Interface {
  const ask = <A>(op: Op, folder: { readonly configDir: string; readonly directory: string }, request: unknown) =>
    call<A>(transport, op, folder, request)
  const folderOf = (folder: ClaudeIO.Folder | undefined) => {
    if (!folder) throw new Error("Claude Agent has no account for this conversation's transcript.")
    return folder
  }
  return {
    // Any file that exists: the SDK runs no binary here, our spawn takes the arguments.
    which: () => process.execPath,
    // Nothing of the host goes to the PC: the PC builds claude's environment itself.
    env: () => ({}),
    requiresFolder: true,
    note: NOTE,
    spawn: (options) => relayed(transport, undefined, options),
    admit: async (member, folder, signal) => {
      const stream = await transport.open({ kind: "process", ...folder, member }, signal)
      return { spawn: (options) => relayed(transport, stream, options), release: () => stream.close() }
    },
    sessionExists: (sessionID, folder) => ask<boolean>("exists", folderOf(folder), { sessionID }),
    fork: async (sessionID, messageID, folder) => {
      const result = await ask<{ sessionID: string; messages: Array<[string, string]> } | null>(
        "fork",
        folderOf(folder),
        { sessionID, messageID },
      )
      return result ? { sessionID: result.sessionID, messages: new Map(result.messages) } : undefined
    },
    remove: async (sessionID, folder) => {
      await ask("remove", folderOf(folder), { sessionID })
    },
    transcripts: {
      chain: async (sessionID, folder) => {
        const result = await ask<{ messages: SessionMessage[]; timestamps: Array<[string, string]> } | null>(
          "chain",
          folder,
          { sessionID },
        )
        return result ? { messages: result.messages, timestamps: new Map(result.timestamps) } : undefined
      },
      write: async (sessionID, folder, entries, replace) => {
        await ask("write", folder, { sessionID, entries, replace })
      },
      list: (configDir) => ask("list", { configDir, directory: "" }, {}),
      discard: async (configDir, projectKey, sessionID) => {
        await ask("discard", { configDir, directory: "" }, { projectKey, sessionID })
      },
    },
    version: (_executable, env) =>
      ask<string | null>("version", { configDir: env.CLAUDE_CONFIG_DIR ?? "", directory: "" }, {}).then(
        (version) => version ?? undefined,
      ),
  }
}

/** The environment names the PC takes from the provider (the SDK's own and the output cap); the PC checks values. */
export const HOST_ENV = [
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SDK_READS_SESSION_STATE",
] as const

async function call<A>(
  transport: Transport,
  op: Op,
  folder: { readonly configDir: string; readonly directory: string },
  request: unknown,
): Promise<A> {
  const stream = await transport.open({ kind: "call", configDir: folder.configDir, directory: folder.directory, op })
  const text = JSON.stringify(request)
  const parts: string[] = []
  const done = new Promise<A>((resolve, reject) => {
    let size = 0
    stream.onData((data) => {
      size += data.length
      if (size > CALL_MAX) {
        stream.close()
        reject(new Error("Claude Agent: the PC's answer is too large"))
        return
      }
      parts.push(data)
    })
    stream.onExit((code, error) => {
      if (code !== 0) return reject(new Error(error ?? `Claude Agent: the PC could not do ${op}`))
      const answer = parts.join("")
      resolve((answer === "" ? undefined : JSON.parse(answer)) as A)
    })
  })
  for (let at = 0; at < text.length; at += CHUNK) stream.write(text.slice(at, at + CHUNK))
  stream.end()
  return done
}

/** A claude on the PC as the SDK sees a child process. Writes before the stream opened are kept in order. */
function relayed(transport: Transport, admitted: Stream | undefined, options: SpawnOptions): SpawnedProcess {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const decoder = new StringDecoder("utf8")
  const queued: string[] = []
  const state = {
    stream: undefined as Stream | undefined,
    exitCode: null as number | null,
    killed: false,
    ended: false,
    exited: false,
  }
  const exit = (code: number | null, error?: string) => {
    if (state.exited) return
    state.exited = true
    state.exitCode = code ?? 1
    if (error) events.emit("error", new Error(error))
    stdout.end()
    events.emit("exit", state.exitCode, null)
  }
  const send = (text: string) => {
    if (text === "") return
    if (!state.stream) return void queued.push(text)
    for (let at = 0; at < text.length; at += CHUNK) state.stream.write(text.slice(at, at + CHUNK))
  }
  const attach = (stream: Stream) => {
    if (state.killed) return stream.close()
    state.stream = stream
    stream.onData((data) => stdout.write(data))
    stream.onExit(exit)
    const env = Object.fromEntries(
      HOST_ENV.flatMap((name) => (options.env[name] === undefined ? [] : [[name, options.env[name]!] as const])),
    )
    stream.start({ args: options.args, env })
    for (const text of queued.splice(0)) send(text)
    if (state.ended) stream.end()
  }
  const stdin = new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, callback) {
      send(typeof chunk === "string" ? chunk : decoder.write(chunk))
      callback()
    },
    final(callback) {
      send(decoder.end())
      state.ended = true
      state.stream?.end()
      callback()
    },
  })
  if (admitted) attach(admitted)
  if (!admitted)
    transport
      .open({
        kind: "process",
        configDir: options.env.CLAUDE_CONFIG_DIR ?? "",
        directory: options.cwd ?? "",
        member: { side: true },
      })
      .then(attach, (error: unknown) => exit(1, error instanceof Error ? error.message : String(error)))
  return {
    stdin,
    stdout,
    get killed() {
      return state.killed
    },
    get exitCode() {
      return state.exitCode
    },
    kill: () => {
      state.killed = true
      state.stream?.close()
      return true
    },
    on: (event: "exit" | "error", listener: (...args: any[]) => void) => void events.on(event, listener),
    once: (event: "exit" | "error", listener: (...args: any[]) => void) => void events.once(event, listener),
    off: (event: "exit" | "error", listener: (...args: any[]) => void) => void events.off(event, listener),
  } as SpawnedProcess
}

// ---------------------------------------------------------------------------------------------------------------------
// PC side

/** A refused host request; `message` is what the host's conversation shows (Korean). */
export class Refused extends Error {}

/** Where a host's request runs on this PC: the account folder and the working folder own-accounts chose for it. */
export interface Placement {
  readonly configDir: string
  readonly directory: string
}

/** A host's claude on this PC, as own-accounts' broker drives it. */
export interface Hosted {
  start(spawn: { readonly args: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> }): void
  write(data: string): void
  end(): void
  close(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (code: number | null, error?: string) => void): void
}

/** What the PC's provider serves to own-accounts' broker (the observer channel's `hosts`). */
export interface Server {
  /** A process for a host's conversation once this service's pool granted it a slot (a start may wait). */
  open(input: Placement & { readonly member: Member }, signal?: AbortSignal): Promise<Hosted>
  /** One transcript or version operation; `root` is the host's working-folder root (its transcripts only). */
  call(input: Placement & { readonly root: string }, op: Op, request: unknown): Promise<unknown>
  /** {@link call} as a stream: the written text is the request, the data the answer. */
  callStream(input: Placement & { readonly root: string }, op: Op): Hosted
}

/** A pool slot for a host's process (sessions.ts `host`): its state decides closing and waiting like a local one's. */
export interface Slot {
  readonly release: () => void
  /** The process's state changed (a turn ended, a tool call came or went). */
  readonly changed: () => void
}

export interface Watched {
  readonly busy: () => boolean
  readonly stuck: () => { readonly since: number; readonly child: boolean } | undefined
  readonly close: () => Promise<void>
}

export function server(input: {
  readonly io: ClaudeIO.Interface
  /** The provider's connection environment (settings' base URL, key, headers), as local requests get. */
  readonly connection: () => Promise<Readonly<Record<string, string>>>
  /** A slot of this service's pool for a host's process (waits like a local start). */
  readonly slot: (member: Member, watched: Watched, signal?: AbortSignal) => Promise<Slot>
}): Server {
  const served: Server = {
    open: async (placement, signal) => {
      const process = hosted(input, placement)
      const slot = await input.slot(placement.member, process.watched, signal)
      process.bind(slot)
      return process.api
    },
    call: (placement, op, request) => perform(input.io, placement, op, request),
    callStream: (placement, op) => callStream(served, placement, op),
  }
  return served
}

/** A call as a stream, so the broker relays both kinds alike: the written text is the request, the data the answer. */
export function callStream(target: Server, placement: Placement & { readonly root: string }, op: Op): Hosted {
  const events = new EventEmitter()
  const parts: string[] = []
  const state = { size: 0, done: false }
  const finish = (code: number, error?: string) => {
    if (state.done) return
    state.done = true
    events.emit("exit", code, error)
  }
  return {
    start: () => {},
    write: (data) => {
      if (state.done) return
      state.size += data.length
      if (state.size > CALL_MAX) return finish(1, "Claude Agent: the host's request is too large")
      parts.push(data)
    },
    end: () => {
      if (state.done) return
      const text = parts.join("")
      Promise.resolve()
        .then(() => target.call(placement, op, text === "" ? undefined : JSON.parse(text)))
        .then(
          (result) => {
            const answer = JSON.stringify(result ?? null)
            for (let at = 0; at < answer.length; at += CHUNK) events.emit("data", answer.slice(at, at + CHUNK))
            finish(0)
          },
          (error: unknown) => finish(1, error instanceof Error ? error.message : String(error)),
        )
    },
    close: () => finish(1, "Claude Agent: the call was closed"),
    onData: (listener) => void events.on("data", listener),
    onExit: (listener) => void events.on("exit", listener),
  }
}

// What one hosted process does on this PC: claude starts only with arguments this file allows, its input passes only
// what the provider sends, and its output loses the login's e-mail and organization. A close (the host's, the pool's, a
// lost connection) tells the host at once and ends claude's input, so claude flushes its transcript and exits; the
// slot comes back once claude is gone (after 5 s it is killed).
function hosted(input: Parameters<typeof server>[0], placement: Placement & { readonly member: Member }) {
  const events = new EventEmitter()
  const state = {
    child: undefined as ReturnType<typeof spawn> | undefined,
    slot: undefined as Slot | undefined,
    running: false,
    // The host was told the process ended; nothing more goes either way.
    told: false,
    // claude is gone (or never started): the slot went back.
    gone: false,
    // The input ended (the host's end, or a close).
    ended: false,
    // Tool calls claude waits for: request id → since, and whether it waits for another conversation.
    calls: new Map<string, { readonly since: number; readonly waits?: "child" | "reply" }>(),
    stderr: "",
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }
  const tell = (code: number | null, error?: string) => {
    if (state.told) return
    state.told = true
    events.emit("exit", code, error)
  }
  const gone = () => {
    if (state.gone) return
    state.gone = true
    clearTimeout(state.timer)
    state.slot?.release()
    events.emit("gone")
  }
  const stdin = lines((line) => {
    if (state.told || state.ended) return
    const verdict = admitInput(line)
    if (verdict.kind === "refuse") {
      events.emit("data", JSON.stringify(verdict.answer) + "\n")
      return
    }
    watchInput(state, verdict.message)
    state.child?.stdin?.write(JSON.stringify(verdict.message) + "\n")
    state.slot?.changed()
  })
  const stdout = lines((line) => {
    const message = parse(line)
    if (!message) return
    watchOutput(state, message, placement.configDir, placement.member.sessionID)
    if (!state.told) events.emit("data", JSON.stringify(scrub(message)) + "\n")
    state.slot?.changed()
  })
  const pending: string[] = []
  const endInput = () => {
    if (state.ended) return
    state.ended = true
    if (!state.child) return
    stdin.flush()
    state.child.stdin?.end()
  }
  const watched: Watched = {
    busy: () => state.running || state.calls.size > 0,
    stuck: () => {
      const waits = [...state.calls.values()].filter((item) => item.waits !== undefined)
      if (waits.length === 0) return undefined
      return { since: Math.max(...waits.map((item) => item.since)), child: waits.some((item) => item.waits === "child") }
    },
    close: () =>
      new Promise<void>((resolve) => {
        tell(null, "Claude Agent: the PC closed the process")
        if (state.gone) return resolve()
        events.once("gone", () => resolve())
        if (!state.child) return gone()
        endInput()
        setTimeout(() => state.child?.kill(), 5_000).unref?.()
      }),
  }
  const api: Hosted = {
    start: (spawnInput) => {
      if (state.child || state.told) return
      clearTimeout(state.timer)
      void launch(input, placement, spawnInput).then(
        (child) => {
          if (state.told) {
            child.kill()
            return gone()
          }
          state.child = child
          child.stdin?.on("error", () => {})
          child.stdout?.setEncoding("utf8")
          child.stdout?.on("data", (chunk: string) => stdout.push(chunk))
          child.stderr?.setEncoding("utf8")
          child.stderr?.on("data", (chunk: string) => {
            state.stderr = (state.stderr + chunk).slice(-2_048)
          })
          child.on("error", (error) => {
            tell(1, `Claude Agent: claude did not start on the PC: ${error.message}`)
            gone()
          })
          child.on("close", (code) => {
            stdout.flush()
            tell(code, code === 0 ? undefined : state.stderr.trim() || undefined)
            gone()
          })
          const ended = state.ended
          state.ended = false
          for (const text of pending.splice(0)) stdin.push(text)
          if (ended) endInput()
        },
        (error: unknown) => {
          tell(1, error instanceof Error ? error.message : String(error))
          gone()
        },
      )
    },
    write: (data) => {
      if (state.told) return
      if (!state.child) return void pending.push(data)
      stdin.push(data)
    },
    end: () => {
      if (!state.child) return void (state.ended = true)
      endInput()
    },
    close: () => void watched.close(),
    onData: (listener) => void events.on("data", listener),
    onExit: (listener) => void events.on("exit", listener),
  }
  return {
    api,
    watched,
    bind: (slot: Slot) => {
      state.slot = slot
      // Not started within a minute of its slot: the slot goes back.
      state.timer = setTimeout(() => void watched.close(), 60_000)
      state.timer.unref?.()
    },
  }
}

async function launch(
  input: Parameters<typeof server>[0],
  placement: Placement,
  spawnInput: { readonly args: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> },
) {
  const args = gate(spawnInput.args)
  const executable = input.io.which()
  if (!executable) throw new Refused("이 PC에 Claude Code가 없어요. PC에 Claude Code를 설치한 뒤 다시 보내 주세요.")
  const options = ClaudeQueryOptions.base({
    executable,
    io: input.io,
    connection: { ...(await input.connection()), CLAUDE_CONFIG_DIR: placement.configDir },
  })
  const script = /\.(m?js|ts)$/.test(executable)
  // A script `claude` (tests' fake CLI) runs on this process's Bun; a compiled own binary is Bun again with BUN_BE_BUN.
  const env = { ...options.env, ...hostEnv(spawnInput.env), ...(script ? { BUN_BE_BUN: "1" } : {}) }
  return spawn(script ? process.execPath : executable, script ? [executable, ...args] : args, {
    cwd: placement.directory,
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The checks

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]\/-]{0,127}$/

// Flags the provider's options produce (query-options.ts, the SDK 0.3.x argument builder). Fixed ones must be there
// with their value: they keep Claude Code's own tools, settings, hooks and MCP servers off on the PC.
const FIXED: ReadonlyArray<readonly [string, string | true]> = [
  ["--output-format", "stream-json"],
  ["--verbose", true],
  ["--input-format", "stream-json"],
  ["--allowedTools", "mcp__opencode__*"],
  ["--tools", ""],
  ["--setting-sources", ""],
  ["--strict-mcp-config", true],
  ["--permission-mode", "dontAsk"],
  ["--settings", '{"disableAllHooks":true}'],
]
const OPTIONAL: Readonly<Record<string, true | ((value: string) => boolean)>> = {
  "--thinking": (value) => value === "adaptive" || value === "disabled",
  "--thinking-display": (value) => value === "summarized" || value === "omitted",
  "--max-thinking-tokens": (value) => /^\d{1,7}$/.test(value),
  "--effort": (value) => ["low", "medium", "high", "xhigh", "max"].includes(value),
  "--model": (value) => MODEL.test(value),
  "--resume": (value) => UUID.test(value),
  "--session-id": (value) => UUID.test(value),
  "--resume-session-at": (value) => UUID.test(value),
  "--include-partial-messages": true,
  "--fork-session": true,
  "--no-session-persistence": true,
}
// Flags written as two arguments when present (the SDK's `--name value` form).
const SPLIT = new Set(["--output-format", "--input-format", "--settings"])

/** The arguments a host's claude may start with, as given; anything else refuses the start. */
export function gate(args: ReadonlyArray<string>): string[] {
  const seen = new Map<string, string | true>()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const equals = arg.indexOf("=")
    const name = equals > 0 ? arg.slice(0, equals) : arg
    const value: string | true =
      equals > 0 ? arg.slice(equals + 1) : SPLIT.has(arg) && index + 1 < args.length ? args[++index]! : true
    if (seen.has(name)) throw refused(name)
    const fixed = FIXED.find((item) => item[0] === name)
    if (fixed) {
      if (fixed[1] !== value) throw refused(name)
      seen.set(name, value)
      continue
    }
    const check = OPTIONAL[name]
    if (check === undefined) throw refused(name)
    if (check === true ? value !== true : value === true || !check(value)) throw refused(name)
    seen.set(name, value)
  }
  const missing = FIXED.find((item) => !seen.has(item[0]))
  if (missing) throw refused(missing[0])
  return [...args]
}

function refused(name: string) {
  return new Refused(`Claude Agent: 원격 호스트가 보낸 claude 실행 인자를 PC가 받지 않았어요(${name}).`)
}

function hostEnv(env: Readonly<Record<string, string>>) {
  const checks: Readonly<Record<(typeof HOST_ENV)[number], (value: string) => boolean>> = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: (value) => /^\d{1,7}$/.test(value),
    CLAUDE_CODE_ENTRYPOINT: (value) => value === "sdk-ts",
    CLAUDE_AGENT_SDK_VERSION: (value) => /^[0-9A-Za-z.+-]{1,32}$/.test(value),
    CLAUDE_CODE_SDK_READS_SESSION_STATE: (value) => value === "1",
  }
  return Object.fromEntries(HOST_ENV.flatMap((name) => (env[name] !== undefined && checks[name](env[name]) ? [[name, env[name]]] : [])))
}

// The control requests the provider sends (initialize, the turn controls, its usage and context reads). Anything else a
// host could send (new MCP servers, settings, file reads, logins, a working folder) never reaches the PC's claude.
const CONTROLS = new Set(["initialize", "interrupt", "set_model", "apply_flag_settings", "get_usage", "get_context_usage", "mcp_status"])
const INITIALIZE = new Set([
  "subtype",
  "hooks",
  "sdkMcpServers",
  "sdkMcpServerConfigs",
  "sdkMcpServerManifests",
  "jsonSchema",
  "systemPrompt",
  "appendSystemPrompt",
  "systemPromptSnapshot",
  "excludeDynamicSections",
  "skills",
  "title",
  "promptSuggestions",
  "agentProgressSummaries",
  "forwardSubagentText",
])

type Input =
  | { readonly kind: "pass"; readonly message: Record<string, any> }
  | { readonly kind: "refuse"; readonly answer: Record<string, unknown> }

/** One line of the host's input: passed (user messages always verbatim, 02 §8.10), or refused with an error answer. */
export function admitInput(line: string): Input {
  const message = parse(line)
  if (!message) return refuse(undefined, "not JSON")
  if (message.type === "user") {
    // Never a Claude Code command on the PC: the provider's `verbatimPrompts` marks every message, the PC makes sure.
    return { kind: "pass", message: { ...message, client_composed: true } }
  }
  if (message.type === "control_response" || message.type === "control_cancel_request" || message.type === "keep_alive")
    return { kind: "pass", message }
  if (message.type !== "control_request") return refuse(undefined, `message type ${String(message.type)}`)
  const request = message.request as Record<string, any> | undefined
  const subtype = request?.subtype
  if (typeof subtype !== "string" || !CONTROLS.has(subtype)) return refuse(message.request_id, `control ${String(subtype)}`)
  if (subtype === "initialize") {
    const extra = Object.keys(request!).find((key) => !INITIALIZE.has(key))
    if (extra) return refuse(message.request_id, `initialize ${extra}`)
    const servers: unknown[] = Array.isArray(request!.sdkMcpServers) ? request!.sdkMcpServers : []
    if (servers.some((name) => name !== "opencode")) return refuse(message.request_id, "an MCP server")
    if (Array.isArray(request!.skills) && request!.skills.length > 0) return refuse(message.request_id, "skills")
    for (const key of ["sdkMcpServerManifests", "sdkMcpServerConfigs"])
      if (request![key] && Object.keys(request![key]).some((name) => name !== "opencode"))
        return refuse(message.request_id, key)
  }
  if (subtype === "apply_flag_settings") {
    const keys = Object.keys(request!.settings ?? {})
    // OWN-PATCH(P-060) begin
    // Fast mode (a boolean) passes too: the speed own's provider asks for a turn.
    if (keys.some((key) => key !== "effortLevel" && key !== "fastMode")) return refuse(message.request_id, "settings")
    if (keys.includes("fastMode") && typeof request!.settings.fastMode !== "boolean")
      return refuse(message.request_id, "settings")
    // OWN-PATCH(P-060) end
  }
  if (subtype === "set_model" && request!.model !== undefined && !MODEL.test(String(request!.model)))
    return refuse(message.request_id, "model")
  return { kind: "pass", message }
}

function refuse(requestID: unknown, what: string): Input {
  return {
    kind: "refuse",
    answer:
      typeof requestID === "string"
        ? {
            type: "control_response",
            response: { subtype: "error", request_id: requestID, error: `own's relay refused ${what}` },
          }
        : { type: "system", subtype: "own_relay_refused", detail: what },
  }
}

// The provider's tools that wait for another conversation (sessions.ts CHILD_TOOLS, REPLY_TOOLS, CAG-43).
const CHILD_TOOLS = new Set(["subagent", "task"])
const REPLY_TOOLS = new Set(["question"])

function watchInput(state: { running: boolean; calls: Map<string, unknown> }, message: Record<string, any>) {
  if (message.type === "user" && message.parent_tool_use_id == null) {
    const content = message.message?.content
    const results = Array.isArray(content) && content.every((part: { type?: unknown }) => part?.type === "tool_result")
    if (!results || content.length === 0) state.running = true
  }
  if (message.type === "control_response") {
    const id = message.response?.request_id
    if (typeof id === "string") state.calls.delete(id)
  }
}

function watchOutput(
  state: { running: boolean; calls: Map<string, { readonly since: number; readonly waits?: "child" | "reply" }> },
  message: Record<string, any>,
  configDir: string,
  sessionID: string | undefined,
) {
  if (message.type === "result") state.running = false
  if (message.type === "rate_limit_event") ClaudeObserver.emit({ configDir, sessionID, rateLimit: message.rate_limit_info })
  if (message.type === "control_response" && message.response?.response?.account)
    ClaudeObserver.emit({ configDir, sessionID, account: ClaudeObserver.plan(message.response.response.account) })
  if (message.type !== "control_request" || message.request?.subtype !== "mcp_message") return
  const rpc = message.request.message
  if (rpc?.method !== "tools/call" || typeof message.request_id !== "string") return
  const name = String(rpc.params?.name ?? "")
  const waits = CHILD_TOOLS.has(name) ? "child" : REPLY_TOOLS.has(name) ? "reply" : undefined
  state.calls.set(message.request_id, { since: Date.now(), ...(waits ? { waits } : {}) })
}

/** The login's e-mail and organization never leave the PC: the initialize answer keeps only its plan. */
export function scrub(message: Record<string, any>) {
  const account = message.type === "control_response" ? message.response?.response?.account : undefined
  if (!account) return message
  return {
    ...message,
    response: { ...message.response, response: { ...message.response.response, account: ClaudeObserver.plan(account) } },
  }
}

function parse(line: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Splits text into lines for `each`; `flush` hands over a last line without its newline. */
function lines(each: (line: string) => void) {
  const buffer = { text: "" }
  return {
    push: (text: string) => {
      buffer.text += text
      const parts = buffer.text.split("\n")
      buffer.text = parts.pop() ?? ""
      for (const line of parts) if (line.trim() !== "") each(line)
    },
    flush: () => {
      const rest = buffer.text
      buffer.text = ""
      if (rest.trim() !== "") each(rest)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Transcript work on the PC

async function perform(io: ClaudeIO.Interface, placement: Placement & { readonly root: string }, op: Op, request: any) {
  const folder = { configDir: placement.configDir, directory: placement.directory }
  const transcripts = io.transcripts
  // A host sees and removes only the transcripts of its own working folders.
  const prefix = `${FolderStore.projectKey(placement.root)}-`
  const sessionID = () => {
    if (typeof request?.sessionID !== "string" || !UUID.test(request.sessionID)) throw new Refused("bad session id")
    return request.sessionID as string
  }
  if (op === "exists") return io.sessionExists(sessionID(), folder)
  if (op === "fork") {
    if (typeof request?.messageID !== "string") throw new Refused("bad message id")
    const fork: ClaudeFork.Result | undefined = await io.fork(sessionID(), request.messageID, folder)
    return fork ? { sessionID: fork.sessionID, messages: [...fork.messages] } : null
  }
  if (op === "remove") return io.remove(sessionID(), folder).then(() => null)
  if (op === "version") {
    const executable = io.which()
    return executable && io.version ? ((await io.version(executable, io.env())) ?? null) : null
  }
  if (!transcripts) throw new Refused("no transcripts")
  if (op === "chain") {
    const chain = await transcripts.chain(sessionID(), folder)
    return chain ? { messages: chain.messages, timestamps: [...chain.timestamps] } : null
  }
  if (op === "write") {
    if (!Array.isArray(request?.entries)) throw new Refused("bad entries")
    await transcripts.write(sessionID(), folder, request.entries, request.replace === true)
    return null
  }
  if (op === "list") return (await transcripts.list(placement.configDir)).filter((item) => item.projectKey.startsWith(prefix))
  if (op === "discard") {
    if (typeof request?.projectKey !== "string" || !request.projectKey.startsWith(prefix)) throw new Refused("not this host's")
    await transcripts.discard(placement.configDir, request.projectKey, sessionID())
    return null
  }
  throw new Refused(`unknown operation ${String(op)}`)
}

/** The project folder names under a hosts root (the PC's own sweep leaves them to their hosts). */
export function hostsKey(root: string) {
  return `${FolderStore.projectKey(root)}-`
}
// OWN-PATCH(P-052) end
