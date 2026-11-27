export * as GitHubMcp from "./mcp.js"

import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { OwnGitHub } from "@own/protocol"
import { ProcessTree } from "@own/runtime"

/**
 * own's client of GitHub's MCP server (16 §5): one MCP session per account, so one conversation's call goes out with
 * its own account's token whatever the next one uses. GitHub's hosted server (Streamable HTTP) gets the token as
 * `Authorization: Bearer` and the toolsets and read-only mode as `X-MCP-Toolsets` / `X-MCP-Readonly` on every request;
 * a program on this PC (`github-mcp-server stdio`) runs once per account with the token in its environment only
 * (`GITHUB_PERSONAL_ACCESS_TOKEN`, never a file or an argument). Sessions are shared by every Location of the process
 * and closed after {@link IDLE_MS} unused. Plain JSON-RPC as the connection test speaks it (`McpProbe`), plus
 * `tools/call`.
 */

export const PROTOCOL = "2025-06-18"
const CLIENT = { name: "own-open-code", version: "1" }
export const INIT_TIMEOUT_MS = 20_000
export const CALL_TIMEOUT_MS = 120_000
export const IDLE_MS = 10 * 60_000
const PAGES = 20

/** Where a session goes and as whom. `readOnly`: the account allows no writes (the server hides and refuses them). */
export interface Target {
  /** own's id of the account, so its sessions alone can be closed ({@link ofAccount}). */
  readonly account: string
  readonly server: OwnGitHub.Server
  /** The hosted server's address for this account's site (github.com or `*.ghe.com`), when the server is hosted. */
  readonly url?: string
  readonly site: string
  readonly token: string
  readonly toolsets: ReadonlyArray<string>
  readonly readOnly: boolean
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly input: unknown
  /** The server's `annotations.readOnlyHint`; whether the tool counts as a read is `GitHubReads.isRead`'s answer. */
  readonly readOnlyHint: boolean
  readonly title?: string
}

export interface CallResult {
  readonly text: string
  readonly isError: boolean
}

export interface Session {
  readonly server?: string
  list(signal?: AbortSignal): Promise<Tool[]>
  call(name: string, args: unknown, signal?: AbortSignal): Promise<CallResult>
  close(): Promise<void>
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "http" | "protocol" | "timeout" | "spawn" | "exited",
    readonly status?: number,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The process-wide pool

interface Entry {
  session: Promise<Session>
  used: number
  timer?: ReturnType<typeof setTimeout>
}

const POOL_KEY = Symbol.for("own-open-code.github-mcp-pool")

function pool() {
  // Shared by every Location's plugin instance (modules are imported per Location), like the runtime singleton.
  const holder = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>
  const existing = holder[POOL_KEY]
  if (existing) return existing
  const created = new Map<string, Entry>()
  holder[POOL_KEY] = created
  return created
}

/** A session for `target`, opened once and shared; a session that failed is dropped so the next call opens anew. */
export async function session(target: Target): Promise<Session> {
  const key = keyOf(target)
  const entries = pool()
  const known = entries.get(key)
  const entry: Entry = known ?? { session: open(target), used: Date.now() }
  if (!known) {
    entries.set(key, entry)
    entry.session.catch(() => entries.delete(key))
  }
  entry.used = Date.now()
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => void drop(key), IDLE_MS)
  entry.timer.unref?.()
  return entry.session
}

/** Calls `name` in `target`'s session; a session the server forgot (404) is opened again once. */
export async function call(target: Target, name: string, args: unknown, signal?: AbortSignal) {
  const first = await session(target)
  return first.call(name, args, signal).catch(async (error: unknown) => {
    if (!(error instanceof McpError) || error.status !== 404) throw error
    await drop(keyOf(target))
    return (await session(target)).call(name, args, signal)
  })
}

/** Closes the session of `target`, if one is open (an account removed or its token replaced). */
export async function drop(key: string) {
  const entries = pool()
  const entry = entries.get(key)
  if (!entry) return
  entries.delete(key)
  if (entry.timer) clearTimeout(entry.timer)
  await entry.session.then((open) => open.close()).catch(() => undefined)
}

/** Closes every session `match` picks by its key (all of them by default: the server or the toolsets changed). */
export async function dropAll(match: (key: string) => boolean = () => true) {
  await Promise.all([...pool().keys()].filter(match).map(drop))
}

/** For {@link dropAll}: the sessions of one account (its token replaced, its writing changed, it was removed). */
export function ofAccount(account: string) {
  return (key: string) => key.startsWith(`${JSON.stringify([account]).slice(0, -1)},`)
}

/** The keys of the sessions open now (a test reads which accounts have one). */
export function openKeys() {
  return [...pool().keys()]
}

/** The pool's key of a target: the account, the server, the site, the mode and a hash of the token (never the token). */
export function keyOf(target: Target) {
  const server = target.server.type === "remote" ? (target.url ?? "") : [target.server.command, ...target.server.args]
  const token = createHash("sha256").update(target.token).digest("hex").slice(0, 16)
  return JSON.stringify([target.account, server, target.site, target.toolsets.toSorted(), target.readOnly, token])
}

function open(target: Target): Promise<Session> {
  if (target.server.type === "remote") return openHttp(target, target.url ?? target.server.url)
  return openStdio(target, target.server)
}

// ---------------------------------------------------------------------------------------------------------------
// Streamable HTTP (GitHub's hosted server)

async function openHttp(target: Target, url: string): Promise<Session> {
  const state: { id?: string; version: string; next: number } = { version: PROTOCOL, next: 1 }
  const headers = () => ({
    authorization: `Bearer ${target.token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-mcp-toolsets": target.toolsets.join(","),
    ...(target.readOnly ? { "x-mcp-readonly": "true" } : {}),
    ...(state.id ? { "mcp-session-id": state.id, "mcp-protocol-version": state.version } : {}),
  })
  const request = async (method: string, params: unknown, timeoutMs: number, signal?: AbortSignal) => {
    const id = state.next++
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((error: unknown) => {
      throw timeout.aborted
        ? new McpError("GitHub's MCP server did not answer in time", "timeout")
        : new McpError(`GitHub's MCP server could not be reached: ${message(error)}`, "http")
    })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      throw new McpError("GitHub refused the account's token", "auth", response.status)
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => "")).slice(0, 500)
      throw new McpError(
        `GitHub's MCP server answered ${response.status}${text ? `: ${text}` : ""}`,
        "http",
        response.status,
      )
    }
    state.id = response.headers.get("mcp-session-id") ?? state.id
    const frame = await read(response, id)
    if (!frame) throw new McpError("GitHub's MCP server gave no answer", "protocol")
    if (frame.error !== undefined) throw new McpError(rpcError(frame.error), "protocol")
    return frame.result
  }
  const init = await request(
    "initialize",
    { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
    INIT_TIMEOUT_MS,
  )
  state.version = isRecord(init) && typeof init.protocolVersion === "string" ? init.protocolVersion : PROTOCOL
  await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(INIT_TIMEOUT_MS),
  })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
  return {
    ...serverOf(init),
    list: (signal) => listTools((params) => request("tools/list", params, INIT_TIMEOUT_MS, signal)),
    call: async (name, args, signal) =>
      callResult(await request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, signal)),
    close: async () => {
      if (!state.id) return
      await fetch(url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(2_000) })
        .then((response) => response.body?.cancel())
        .catch(() => undefined)
    },
  }
}

/** The JSON-RPC answer `id` of a JSON body or an event stream. */
async function read(response: Response, id: number) {
  const type = response.headers.get("content-type") ?? ""
  if (!type.includes("text/event-stream")) return parse(await response.text())
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  const state = { buffer: "", data: [] as string[] }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    state.buffer += decoder.decode(next.value, { stream: true })
    const lines = state.buffer.split(/\r?\n/)
    state.buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.startsWith("data:")) state.data.push(line.slice(5).replace(/^ /, ""))
      if (line !== "") continue
      const frame = parse(state.data.join("\n"))
      state.data = []
      if (frame?.id === id) {
        await reader.cancel().catch(() => undefined)
        return frame
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------
// stdio (a program on this PC, one process per account)

/**
 * The variables of the service's environment a GitHub server process gets (GH-22): what a program needs to start, find
 * its files and go through the user's proxy, nothing else (no other token, no own or OpenCode variable). The same list
 * as the Claude login window's (`claude-agent`, P-042).
 */
export const ENV_ALLOW = new Set(
  [
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ].map((name) => name.toUpperCase()),
)

/** A stdio server's environment: {@link ENV_ALLOW} of `source`, and the account's token and the server's settings. */
export function serverEnvironment(target: Target, source: Readonly<Record<string, string | undefined>>) {
  const picked = Object.entries(source).flatMap(([name, value]) =>
    value !== undefined && ENV_ALLOW.has(name.toUpperCase()) ? [[name, value] as const] : [],
  )
  return {
    ...Object.fromEntries(picked),
    // Windows' process start (libuv, in Bun as in Node) copies these from this process into a child environment that
    // lacks them; an empty value keeps them out.
    USERNAME: "",
    USERDOMAIN: "",
    LOGONSERVER: "",
    COMPUTERNAME: "",
    GITHUB_PERSONAL_ACCESS_TOKEN: target.token,
    GITHUB_TOOLSETS: target.toolsets.join(","),
    ...(target.readOnly ? { GITHUB_READ_ONLY: "1" } : {}),
    ...(new URL(target.site).origin === OwnGitHub.GITHUB_COM ? {} : { GITHUB_HOST: new URL(target.site).origin }),
  }
}

async function openStdio(target: Target, server: Extract<OwnGitHub.Server, { type: "local" }>): Promise<Session> {
  const proc = (() => {
    try {
      return Bun.spawn([server.command, ...server.args], {
        env: serverEnvironment(target, process.env),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ...ProcessTree.SPAWN,
      })
    } catch (error) {
      throw new McpError(`could not start ${server.command}: ${message(error)}`, "spawn")
    }
  })()
  const state = {
    next: 1,
    stderr: "",
    closed: false,
    waiting: new Map<number, { resolve: (frame: Frame) => void; reject: (error: Error) => void }>(),
  }
  const send = (frame: unknown) => {
    if (state.closed) return
    void Promise.resolve()
      .then(() => {
        proc.stdin.write(JSON.stringify(frame) + "\n")
        return proc.stdin.flush()
      })
      .catch(() => undefined)
  }
  const fail = (error: Error) => {
    state.closed = true
    for (const waiter of state.waiting.values()) waiter.reject(error)
    state.waiting.clear()
  }
  void (async () => {
    const decoder = new TextDecoder()
    const reader = proc.stderr.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) return
      state.stderr = (state.stderr + decoder.decode(next.value, { stream: true })).slice(-2_000)
    }
  })().catch(() => undefined)
  void (async () => {
    for await (const line of lines(proc.stdout)) {
      const frame = parse(line)
      if (!frame) continue
      // The server's own requests (roots, sampling, ping) are refused at once, so it never waits on us.
      if (frame.method !== undefined && frame.id !== undefined) {
        send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "not supported" } })
        continue
      }
      if (typeof frame.id !== "number") continue
      state.waiting.get(frame.id)?.resolve(frame)
      state.waiting.delete(frame.id)
    }
    const code = await proc.exited
    fail(new McpError(`${server.command} ended (exit ${code})${tail(state.stderr)}`, "exited"))
  })().catch((error: unknown) => fail(new McpError(message(error), "exited")))
  const request = (method: string, params: unknown, timeoutMs: number, signal?: AbortSignal) => {
    if (state.closed) return Promise.reject(new McpError(`${server.command} is not running`, "exited"))
    const id = state.next++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.waiting.delete(id)
        reject(new McpError(`${server.command} did not answer in time`, "timeout"))
      }, timeoutMs)
      const abort = () => {
        clearTimeout(timer)
        state.waiting.delete(id)
        reject(new McpError("cancelled", "timeout"))
      }
      signal?.addEventListener("abort", abort, { once: true })
      state.waiting.set(id, {
        resolve: (frame) => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          if (frame.error !== undefined) reject(new McpError(rpcError(frame.error), "protocol"))
          else resolve(frame.result)
        },
        reject: (error) => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          reject(error)
        },
      })
      send({ jsonrpc: "2.0", id, method, params })
    })
  }
  const stop = async () => {
    state.closed = true
    await Promise.resolve()
      .then(() => proc.stdin.end())
      .catch(() => undefined)
    await ProcessTree.kill(proc)
  }
  const init = await request(
    "initialize",
    { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
    INIT_TIMEOUT_MS,
  ).catch(async (error: unknown) => {
    await stop()
    throw error
  })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  return {
    ...serverOf(init),
    list: (signal) => listTools((params) => request("tools/list", params, INIT_TIMEOUT_MS, signal)),
    call: async (name, args, signal) =>
      callResult(await request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, signal)),
    close: stop,
  }
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const state = { buffer: "" }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    state.buffer += decoder.decode(next.value, { stream: true })
    const parts = state.buffer.split("\n")
    state.buffer = parts.pop() ?? ""
    for (const part of parts) if (part.trim()) yield part
  }
  if (state.buffer.trim()) yield state.buffer
}

function tail(stderr: string) {
  const text = stderr.trim()
  return text ? `: ${text.slice(-500)}` : ""
}

// ---------------------------------------------------------------------------------------------------------------

async function listTools(list: (params: unknown) => Promise<unknown>) {
  const found: Tool[] = []
  const page = async (index: number, cursor: string | undefined): Promise<void> => {
    const result = await list(cursor ? { cursor } : {})
    const items = isRecord(result) && Array.isArray(result.tools) ? result.tools : []
    found.push(...items.flatMap(toolOf))
    const next = isRecord(result) && typeof result.nextCursor === "string" ? result.nextCursor : undefined
    if (next && index + 1 < PAGES) await page(index + 1, next)
  }
  await page(0, undefined)
  return found
}

function toolOf(item: unknown): Tool[] {
  if (!isRecord(item) || typeof item.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.name)) return []
  const annotations = isRecord(item.annotations) ? item.annotations : {}
  const title =
    typeof annotations.title === "string" ? annotations.title : typeof item.title === "string" ? item.title : undefined
  return [
    {
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      input: isRecord(item.inputSchema) ? item.inputSchema : { type: "object", properties: {} },
      readOnlyHint: annotations.readOnlyHint === true,
      ...(title ? { title } : {}),
    },
  ]
}

/** A `tools/call` result as text: its text parts (and embedded text resources), and whether it is an error. */
function callResult(result: unknown): CallResult {
  if (!isRecord(result)) return { text: "", isError: false }
  const parts = Array.isArray(result.content) ? result.content : []
  const texts = parts.flatMap((part): string[] => {
    if (!isRecord(part)) return []
    if (part.type === "text" && typeof part.text === "string") return [part.text]
    if (part.type === "resource" && isRecord(part.resource) && typeof part.resource.text === "string")
      return [part.resource.text]
    if (part.type === "resource_link" && typeof part.uri === "string") return [part.uri]
    return []
  })
  const text =
    texts.length > 0
      ? texts.join("\n\n")
      : result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent)
        : ""
  return { text, isError: result.isError === true }
}

function serverOf(init: unknown) {
  const info = isRecord(init) && isRecord(init.serverInfo) ? init.serverInfo : undefined
  const name = typeof info?.name === "string" ? info.name : undefined
  if (!name) return {}
  return { server: typeof info?.version === "string" ? `${name} ${info.version}` : name }
}

interface Frame {
  readonly id?: unknown
  readonly method?: string
  readonly result?: unknown
  readonly error?: unknown
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parse(text: string): Frame | undefined {
  const value = Option.getOrUndefined(decodeJson(text))
  // SAFETY: a JSON-RPC frame is an object; its fields are read through the optional members of Frame.
  return isRecord(value) ? (value as Frame) : undefined
}

function rpcError(error: unknown) {
  if (!isRecord(error)) return String(error)
  return typeof error.message === "string" ? error.message : JSON.stringify(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
