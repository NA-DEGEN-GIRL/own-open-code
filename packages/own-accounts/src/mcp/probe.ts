export * as McpProbe from "./probe.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { McpDsn, McpJson, McpSecrets, OwnMcp } from "@own/protocol"
import { ProcessTree } from "@own/runtime"

/**
 * `연결 시험` (03 §18.14, SM): own starts a server on its own for a moment, or calls its URL, asks `initialize` and
 * `tools/list` (up to {@link PAGES} pages) and stops it. Plain JSON-RPC, enough of MCP for a test: stdio frames are one
 * JSON text per line; Streamable HTTP answers JSON or an event stream, and its session id comes back as
 * `mcp-session-id`. A 401 means the server wants a sign-in, which core does once the server is saved. Every value the
 * caller names in `secrets` is cut out of what the answer quotes (`••••`, {@link mask}): the server's name and
 * version, its tools' names and descriptions and the error, so a server that echoes its key keeps it out of
 * `mcp.json` and the page. Never throws.
 */

export type Target =
  | {
      readonly type: "local"
      readonly command: string
      readonly args: ReadonlyArray<string>
      /** Absolute: the caller resolved a relative `cwd` against the project folder. */
      readonly cwd: string
      readonly env: Readonly<Record<string, string>>
    }
  | { readonly type: "remote"; readonly url: string; readonly headers: Readonly<Record<string, string>> }

export interface Options {
  readonly timeoutMs?: number
  readonly now?: () => number
  /** Values to cut out of quoted errors ({@link mask}). */
  readonly secrets?: ReadonlyArray<string>
  readonly signal?: AbortSignal
}

export const TIMEOUT_MS = 20_000
const PAGES = 10
const STDERR_TAIL = 1_500
/**
 * What of a quoted text the masker keeps before it masks it whole and then cuts it to what the answer shows (SM-24,
 * SM-25, SM-26): far more than a cut text plus the longest stored value, so a value near where it is cut is whole when
 * the masker sees it, even in a text made of nothing but copies of it (they become one `••••`, and the cut lies far
 * beyond what is shown). Where a longer text is cut here (by {@link Masker.head}, or the stderr kept so far), the part
 * of a value at the cut is masked too ({@link EDGE_MIN}).
 */
export const RAW = 256 * 1024
const PROTOCOL = "2025-06-18"
const CLIENT = { name: "own-open-code", version: "1" }

type Result = Omit<OwnMcp.Check, "at">

export async function probe(target: Target, options: Options = {}): Promise<OwnMcp.Check> {
  const now = options.now ?? Date.now
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const clean = masker(options.secrets ?? [])
  const result = await (target.type === "local" ? stdio(target, signal, clean) : http(target, signal, clean)).catch(
    (error: unknown): Result =>
      signal.aborted
        ? { ok: false, tools: [], failure: "timeout" }
        : { ok: false, tools: [], failure: "protocol", error: message(error) },
  )
  // Masked first, then cut (SM-24): a cut could leave part of a value too short to be recognized.
  return {
    at: now(),
    ...result,
    ...(result.server === undefined ? {} : { server: clean.head(result.server, 300) }),
    tools: result.tools.map((tool) => ({
      name: clean.head(tool.name, 200),
      ...(tool.description === undefined ? {} : { description: clean.head(tool.description, 300) }),
    })),
    ...(result.error === undefined ? {} : { error: clean.head(result.error, 2_000) }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// stdio

async function stdio(target: Extract<Target, { type: "local" }>, signal: AbortSignal, clean: Masker): Promise<Result> {
  const child = spawn(target)
  if (!child.ok) return { ok: false, tools: [], failure: "spawn", error: child.error }
  const proc = child.proc
  // `cut` once the start was dropped: then the tail's start is a real cut (SM-27).
  const stderr = { text: "", cut: false }
  const reading = chunks(proc.stderr, (text) => {
    const joined = stderr.text + text
    stderr.cut ||= joined.length > RAW
    stderr.text = joined.slice(-RAW)
  }).catch(() => undefined)
  const lines = frames(proc.stdout)
  // A server that already ended refuses the write; its exit is reported instead.
  const send = (message: unknown) =>
    void Promise.resolve()
      .then(() => {
        proc.stdin.write(JSON.stringify(message) + "\n")
        return proc.stdin.flush()
      })
      .catch(() => undefined)
  const stop = () => ProcessTree.kill(proc)
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted")
    signal.addEventListener("abort", () => resolve("aborted"), { once: true })
  })
  const failed = (failure: OwnMcp.Failure, error?: string): Result => ({
    ok: false,
    tools: [],
    failure,
    ...(error ? { error } : {}),
  })
  try {
    const request = async (id: number, method: string, params: unknown) => {
      send({ jsonrpc: "2.0", id, method, params })
      while (true) {
        // stdout ends with the process, so a server that exits is a finished stream.
        const next = await Promise.race([lines.next(), aborted])
        if (next === "aborted") return next
        if (next.done) return "exited" as const
        const frame = parse(next.value)
        if (frame === undefined) continue
        // A server's own request (roots, sampling, ping) gets a refusal, so it never waits on us.
        if (frame.method !== undefined && frame.id !== undefined) {
          send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "not supported by this test" } })
          continue
        }
        if (frame.id === id) return frame
      }
    }
    const answer = async (id: number, method: string, params: unknown) => {
      const frame = await request(id, method, params)
      if (frame === "aborted") return failed("timeout")
      if (frame === "exited") {
        // The stderr read to its end too (a long one is still coming in when the process ends), at most 500 ms.
        await Promise.race([Promise.all([proc.exited, reading]), Bun.sleep(500)])
        const tail = clean.tail(stderr.text.trim(), STDERR_TAIL, stderr.cut)
        const code = proc.exitCode
        return failed("exited", [code === null ? "" : `exit ${code}`, tail].filter(Boolean).join(": ") || undefined)
      }
      if (frame.error !== undefined) return failed("protocol", rpcError(frame.error))
      return frame.result
    }
    const init = await answer(1, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT })
    if (isResult(init)) return init
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    const listed = await tools((id, cursor) => answer(id, "tools/list", cursor ? { cursor } : {}))
    return { ...listed, ...serverOf(init) }
  } finally {
    await Promise.resolve()
      .then(() => proc.stdin.end())
      .catch(() => undefined)
    await stop()
  }
}

function spawn(target: Extract<Target, { type: "local" }>) {
  try {
    const proc = Bun.spawn([target.command, ...target.args], {
      cwd: target.cwd,
      env: { ...process.env, ...target.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...ProcessTree.SPAWN,
    })
    return { ok: true as const, proc }
  } catch (error) {
    return { ok: false as const, error: message(error) }
  }
}

/** One JSON text per line (MCP stdio framing). */
async function* frames(stream: ReadableStream<Uint8Array>) {
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

async function chunks(stream: ReadableStream<Uint8Array>, take: (text: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const next = await reader.read()
    if (next.done) return
    take(decoder.decode(next.value, { stream: true }))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Streamable HTTP

async function http(target: Extract<Target, { type: "remote" }>, signal: AbortSignal, clean: Masker): Promise<Result> {
  const session: { id?: string; version: string } = { version: PROTOCOL }
  const post = async (body: unknown) => {
    const response = await fetch(target.url, {
      method: "POST",
      signal,
      headers: {
        ...target.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session.id ? { "mcp-session-id": session.id, "mcp-protocol-version": session.version } : {}),
      },
      body: JSON.stringify(body),
    })
    return response
  }
  const answer = async (id: number, method: string, params: unknown): Promise<Result | unknown> => {
    const response = await post({ jsonrpc: "2.0", id, method, params })
    if (response.status === 401) {
      await response.body?.cancel()
      return { ok: false, tools: [], failure: "auth", status: 401 } satisfies Result
    }
    if (!response.ok) {
      const text = clean.head(await response.text().catch(() => ""), 500)
      return { ok: false, tools: [], failure: "http", status: response.status, ...(text ? { error: text } : {}) }
    }
    session.id = response.headers.get("mcp-session-id") ?? session.id
    const frame = await read(response, id)
    if (frame === undefined) return { ok: false, tools: [], failure: "protocol", error: "no answer" } satisfies Result
    if (frame.error !== undefined) return { ok: false, tools: [], failure: "protocol", error: rpcError(frame.error) }
    return frame.result
  }
  const init = await answer(1, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT })
  if (isResult(init)) return init
  const version = isRecord(init) && typeof init.protocolVersion === "string" ? init.protocolVersion : PROTOCOL
  session.version = version
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
  const listed = await tools((id, cursor) => answer(id, "tools/list", cursor ? { cursor } : {}))
  if (session.id)
    await fetch(target.url, {
      method: "DELETE",
      headers: { ...target.headers, "mcp-session-id": session.id },
      signal: AbortSignal.timeout(2_000),
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined)
  return { ...listed, ...serverOf(init) }
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

async function tools(list: (id: number, cursor: string | undefined) => Promise<Result | unknown>): Promise<Result> {
  const found: OwnMcp.Tool[] = []
  const page = async (index: number, cursor: string | undefined): Promise<Result> => {
    const result = await list(2 + index, cursor)
    if (isResult(result)) return result
    const items = isRecord(result) && Array.isArray(result.tools) ? result.tools : []
    found.push(
      ...items.flatMap((item): OwnMcp.Tool[] =>
        isRecord(item) && typeof item.name === "string"
          ? [
              {
                name: item.name,
                ...(typeof item.description === "string" && item.description.trim()
                  ? { description: item.description.trim() }
                  : {}),
              },
            ]
          : [],
      ),
    )
    const next = isRecord(result) && typeof result.nextCursor === "string" ? result.nextCursor : undefined
    if (next && index + 1 < PAGES && found.length < OwnMcp.MAX_TOOLS) return page(index + 1, next)
    return { ok: true, tools: [] }
  }
  const done = await page(0, undefined)
  if (!done.ok) return done
  return {
    ok: true,
    tools: found.slice(0, OwnMcp.MAX_TOOLS),
    ...(found.length > OwnMcp.MAX_TOOLS ? { more: true } : {}),
  }
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

function isResult(value: unknown): value is Result {
  return isRecord(value) && value.ok === false && Array.isArray(value.tools)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A stored value's part this long or longer is masked where it shows whole. Shorter secrets stay readable by design
 * (SM-25): masking `ro` or a 7-character password would hide ordinary words of the same letters.
 */
export const MASK_MIN = 8
/** Runs of this many characters of a part are masked too, for parts at least {@link WINDOW_MIN} long. */
export const MASK_RUN = 8
export const WINDOW_MIN = 12
/**
 * At a real cut of a quoted text (SM-26, SM-27), the start of a part this long or longer that ends a head (or the end
 * of one that starts a tail) is masked too; shorter pieces say too little to hide ordinary text for. A real cut is
 * where the masker cut a text longer than {@link RAW}, where the stderr kept so far dropped its start, or where the
 * server marks one ({@link serverCut}). A text that was never cut keeps its edges (`Example Server 2024`).
 */
export const EDGE_MIN = 4
type Edge = "start" | "end"
/**
 * How a server marks where it cut a text, at a head's end or a tail's start ({@link serverCut}, in any case, spaces
 * beside it allowed): `[truncated]`, `[truncated 12 chars]`, `(truncated)`, `(output truncated)`, `<truncated>`,
 * `(12 more characters)`, `[…]`, `[...]`, an ellipsis before one at a head's end (`...(truncated)`, `… [truncated]`,
 * `... (12 more characters)`) or after one at a tail's start (SM-28). An ellipsis alone (`…`, `...`) marks a cut only
 * right at it, and there a plain number stays as a plain word does: a sentence may end `Loading 2024...` (SM-28).
 */
const MARK =
  String.raw`\[truncated(?:[ \t]+\d+[ \t]+(?:chars?|characters?|bytes?))?\]|\((?:output[ \t]+)?truncated\)|` +
  String.raw`<truncated>|\(\d+[ \t]+more[ \t]+(?:chars?|characters?|bytes?)\)|\[(?:…|\.\.\.)\]`
const ELLIPSIS = String.raw`…|\.\.\.`
const MARKED = String.raw`(?:(?:${ELLIPSIS})[ \t]*)?(?:${MARK})(?:[ \t]*(?:${ELLIPSIS}))?`
const MARKED_END = new RegExp(String.raw`${MARKED}$|(${ELLIPSIS})$`, "i")
const MARKED_START = new RegExp(String.raw`^(?:${MARKED}|(${ELLIPSIS}))`, "i")
/** Longer than any mark: only this much of a text's end or start is searched, so a long text costs nothing more. */
const MARK_MAX = 64
const NUMBER = /^[0-9]+$/

/** The scheme word of an `Authorization` value, which is no secret. */
const SCHEME = /^(bearer|basic|token|digest)\s+([\s\S]+)$/i
/** A word as prose has it (`production`, `Production`, `PRODUCTION`): never masked, whole or as a run. */
const COMMON = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)$/
/** An address's authority, path and `?` part; a scheme of several words (`jdbc:postgresql://`, SM-27) too. */
const URL_PARTS = /^[A-Za-z][A-Za-z0-9+.-]*(?::[A-Za-z][A-Za-z0-9+.-]*)*:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/

export interface Masker {
  /** The text with every secret part of the stored values cut out (`••••`). */
  readonly text: (text: string) => string
  /** The first `limit` characters of the text, masked whole before it is cut (past {@link RAW}, cut there first). */
  readonly head: (text: string, limit: number) => string
  /** The last `limit` characters of the text, masked whole before it is cut; `cut`: its start was already cut. */
  readonly tail: (text: string, limit: number, cut?: boolean) => string
}

/**
 * A quoted text with the secret parts of the stored values cut out (`••••`, SM-24): of a `?…` part its values, not its
 * names; of an address its user info, key-like path segments (`McpSecrets.pathKeys`), query values and secret
 * `;password=…` properties, never `https://` or the host; of a connection string its secret parts' values
 * (`McpSecrets.connectionSecrets`: `Password=…`, libpq's `password=…`, Go MySQL's and Oracle's password); of
 * `Bearer <token>` the token; of any other value the value and its words. Each part also as a JSON string writes it
 * (SM-26) and as a connection string quotes it (SM-28). A part of {@link MASK_MIN} or more characters that is not a plain word ({@link COMMON}) is masked where it
 * shows whole, and every run of {@link MASK_RUN} characters of a part of {@link WINDOW_MIN} or more (a server that
 * quotes part of a key, or cuts it across lines), unless the run is a plain word. So `MODE=production` leaves "Runs in
 * production mode" readable.
 */
export function mask(text: string, secrets: ReadonlyArray<string>) {
  return masker(secrets).text(text)
}

/** {@link mask} for many texts against the same values (a test's tool list): the values are split once. */
export function masker(secrets: ReadonlyArray<string>): Masker {
  const parts = [
    ...new Set(
      secrets
        .flatMap(partsOf)
        .flatMap(forms)
        .filter((part) => part.length >= MASK_MIN && !COMMON.test(part)),
    ),
  ].toSorted((a, b) => b.length - a.length)
  // Every window of MASK_RUN characters of a long part; a common run of at least that length is covered by its windows.
  const windows = new Set(
    parts
      .filter((part) => part.length >= WINDOW_MIN)
      .flatMap((part) =>
        Array.from({ length: part.length - MASK_RUN + 1 }, (_, at) => part.slice(at, at + MASK_RUN)),
      )
      .filter((run) => !COMMON.test(run)),
  )
  // The starts (`end`) or ends (`start`) of the parts that the windows do not catch, from EDGE_MIN characters.
  const pieces = (side: Edge) =>
    parts.flatMap((part) =>
      Array.from(
        { length: Math.max(0, (part.length >= WINDOW_MIN ? MASK_RUN : part.length) - EDGE_MIN) },
        (_, at) => (side === "end" ? part.slice(0, EDGE_MIN + at) : part.slice(-(EDGE_MIN + at))),
      ).filter((piece) => !COMMON.test(piece)),
    )
  const edges = { end: pieces("end"), start: pieces("start") }
  /** The text masked; `edge`: the side it was cut on, by the masker (`own`) or where the server marks it. */
  const text = (input: string, edge?: Edge, own = false) => {
    if (parts.length === 0) return input
    const whole = parts.reduce((out, value) => out.replaceAll(value, "\u0000"), input)
    const hidden = new Uint8Array(whole.length)
    for (let at = 0; at + MASK_RUN <= whole.length; at++)
      if (windows.has(whole.slice(at, at + MASK_RUN))) hidden.fill(1, at, at + MASK_RUN)
    const cut =
      edge === undefined
        ? undefined
        : own
          ? { at: edge === "end" ? whole.length : 0, bare: false }
          : serverCut(whole, edge)
    if (edge !== undefined && cut !== undefined) {
      const side = edge === "end" ? whole.slice(0, cut.at) : whole.slice(cut.at)
      const length = Math.max(
        0,
        ...edges[edge]
          .filter((piece) => !(cut.bare && NUMBER.test(piece)))
          .filter((piece) => (edge === "end" ? side.endsWith(piece) : side.startsWith(piece)))
          .map((piece) => piece.length),
      )
      if (edge === "end") hidden.fill(1, cut.at - length, cut.at)
      if (edge === "start") hidden.fill(1, cut.at, cut.at + length)
    }
    // By UTF-16 unit, as `hidden` is.
    return whole
      .split("")
      .map((char, index) => (char === "\u0000" || hidden[index] ? "\u0000" : char))
      .join("")
      .replace(/\u0000+/g, "••••")
  }
  // The whole text, then the cut (SM-25): a cut before masking can split a value, and once earlier values became
  // `••••` the text is shorter, so the split part would land inside what is kept. A text cut before the masker saw it
  // (past RAW here, the stderr's start, or by the server) may end with the start of a value, or a tail start with the
  // end of one, too short for the windows: that edge is masked too (SM-26), and only a real cut's (SM-27).
  return {
    text: (input) => text(input),
    head: (input, limit) => {
      const over = input.length > RAW
      return text(over ? input.slice(0, RAW) : input, "end", over).slice(0, limit)
    },
    tail: (input, limit, cut = false) => {
      const over = input.length > RAW
      return text(over ? input.slice(-RAW) : input, "start", over || cut).slice(-limit)
    },
  }
}

/**
 * Where a server marked its cut ({@link MARK}, {@link ELLIPSIS}): the place before the mark at a head's end, after it
 * at a tail's start, and whether the mark is an ellipsis alone (`bare`); else undefined.
 */
function serverCut(text: string, edge: Edge) {
  if (edge === "end") {
    const trimmed = text.trimEnd()
    const match = MARKED_END.exec(trimmed.slice(-MARK_MAX))
    if (!match) return undefined
    const before = trimmed.length - match[0].length
    if (match[1] !== undefined) return { at: before, bare: true }
    return { at: trimmed.slice(0, before).trimEnd().length, bare: false }
  }
  const trimmed = text.trimStart()
  const match = MARKED_START.exec(trimmed.slice(0, MARK_MAX))
  if (!match) return undefined
  const after = text.length - trimmed.length + match[0].length
  if (match[1] !== undefined) return { at: after, bare: true }
  return { at: text.length - text.slice(after).trimStart().length, bare: false }
}

/**
 * A part as stored, as the inside of a JSON string writes it (`"` as `\"`: a server may echo its JSON argument; and
 * with every character past ASCII as `\uXXXX`, as Python's `json.dumps` writes it, SM-27), and, when it holds JSON
 * escapes, as they read (SM-26); and as a connection string quotes it and as a quoted one reads (`a""b` and `a"b`,
 * `}}`, libpq's `\'`, `McpDsn`): a lifted password is stored as the driver reads it, and a server may echo it as
 * written (SM-28).
 */
function forms(part: string) {
  const quoted = McpDsn.QUOTES.flatMap((quote) => [McpDsn.write(part, quote), McpDsn.read(part, quote)])
  return [
    ...new Set([part, McpJson.escape(part), McpJson.escape(part, true), McpJson.unescape(part) ?? part, ...quoted]),
  ]
}

/** The parts of one stored value that are secret (see {@link mask}), raw and, for address parts, decoded too. */
function partsOf(value: string): string[] {
  if (value.startsWith("?")) return query(value)
  const address = URL_PARTS.exec(value)
  if (address) {
    const authority = address[1] ?? ""
    const at = authority.lastIndexOf("@")
    const user = at < 0 ? "" : authority.slice(0, at)
    return [
      ...(user === "" ? [] : [user, ...user.split(":")]),
      ...McpSecrets.pathKeys(address[2] ?? ""),
      ...query(address[3] ?? ""),
      // `jdbc:sqlserver://h:1433;password=…`: the secret properties (SM-27).
      ...McpSecrets.connectionSecrets(value),
    ].flatMap(decoded)
  }
  // `Server=…;Password=…`, libpq, Go MySQL, Oracle: only the secret parts' values (SM-26, SM-27), as an address's.
  const connection = McpSecrets.connectionSecrets(value)
  if (connection.length > 0) return connection
  const scheme = SCHEME.exec(value)
  const rest = scheme ? scheme[2]! : value
  const words = rest.split(/\s+/).filter((word) => word !== "")
  return [...(scheme ? [] : [value]), ...(words.length > 1 || scheme ? words : [])]
}

/** The values of a `?a=b&c=d` part, never its names. */
function query(search: string) {
  return search
    .replace(/^\?/, "")
    .split("&")
    .flatMap((param) => {
      const equals = param.indexOf("=")
      return equals < 0 || equals === param.length - 1 ? [] : [param.slice(equals + 1)]
    })
    .flatMap(decoded)
}

/** A part as written and, when it holds escapes, as a server may echo it decoded (`URLSearchParams` never throws). */
function decoded(part: string) {
  if (!part.includes("%") && !part.includes("+")) return [part]
  const plain = new URLSearchParams(`v=${part.replaceAll("&", "%26")}`).get("v") ?? part
  return plain === part ? [part] : [part, plain]
}

/** A command's working folder: `cwd` against the project folder, else the project folder (core's rule). */
export function workingFolder(cwd: string | undefined, directory: string) {
  if (cwd === undefined) return directory
  return path.isAbsolute(cwd) ? cwd : path.resolve(directory, cwd)
}
