// Local forwarder for the live harness test. The test server's providers point here with placeholder keys; this
// process swaps in the real credential and forwards to the official endpoint only:
//   /chatgpt/<alias>/...  → https://chatgpt.com/backend-api/codex/...   (ChatGPT subscription, Codex backend)
//   /chatgpt-team/...     → the same, the login picked by the request's `chatgpt-account-id` (`accounts`: the
//                           team test's seeded fake account ids, team.ts); any other id is refused
//   /chatgpt-backend/<alias>/wham/usage → https://chatgpt.com/backend-api/wham/usage (the plan usage Codex CLI's
//                           `/status` reads; own-accounts' leader poll), nothing else under that root. Any path
//                           naming `rate-limit-reset-credits` is refused (404) on every route, before a credential
//                           is read: a live test never lists or spends a reset credit (own-accounts 02 §7.1.1)
//   /deepseek/...         → https://api.deepseek.com/...
//   /anthropic/...        → https://api.anthropic.com/...           (the key from set-key.ps1)
//   /local/v1/...         → the user's local model server (OWN_LIVE_LOCAL_URL, default http://localhost:64644/v1): it
//                           takes no key, so nothing leaves the user's machines (real-host phase E's stand-in model).
//                           With OWN_LIVE_LOCAL_UPSTREAM=deepseek it goes to https://api.deepseek.com/v1/... with the
//                           DeepSeek key instead: a keyless `로컬 모델` account still takes the relay path, and the
//                           user's own local model is never asked (decisions MR18)
//   /openai/v1/models, /openai/v1/images/generations, /openai/v1/images/edits, /openai/v1/responses →
//                           https://api.openai.com/v1/... (the key from `set-key.ps1 -Provider openai`; nothing else
//                           under that root: live images, and the side-question cache check's Responses requests)
// The ChatGPT routes also forward a WebSocket upgrade (the Responses WebSocket transport of own codex slots) to the
// same path on wss://chatgpt.com, frames passed through untouched.
// The test server therefore never holds a credential (its config and logs stay clean), and nothing is refreshed.
// Each request is logged without headers or bodies: route, path, model, size, status, time, the names of the plan-limit
// headers it carried (`limits`), and for a WebSocket the count of each frame type. A model response logs a second
// `stream` line when its body ends: first byte, bytes, SSE events and comment lines, longest pause, outcome. With
// `OWN_LIVE_BODIES=<dir>` the request bodies are written there too (they hold no credential; ChatGPT's zstd bodies
// decoded), and the frames a client sends on a ChatGPT WebSocket, to compare the bytes of a cached prefix across runs and
// see what a harness sent.
// With a `meter` (the compaction-cache suite) each model request is checked against a spending cap first (refused
// with 402 once the cap is reached), and the usage its response reports (Messages, Chat Completions or Responses,
// streamed or not) is logged as a `usage` line and handed to the meter: token counts only, never content.
// Every request body and client frame has this PC's identity replaced before it goes out ({@link redact}), and one that
// lists a Windows profile is refused ({@link profileListing}).
import fs from "node:fs"
import { appendFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { Option, Schema } from "effect"
import { anthropic, chatgpt, deepseek, openai } from "./credentials.js"

const DROPPED_REQUEST = new Set(["host", "authorization", "x-api-key", "chatgpt-account-id", "content-length", "connection"])
// fetch decodes a compressed response, so its encoding and length headers no longer apply.
const DROPPED_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"])
/** The upgrade's own headers; the upstream socket negotiates its own. */
const DROPPED_SOCKET = new Set([
  ...DROPPED_REQUEST,
  "upgrade",
  "accept-encoding",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
])
const BODIES = process.env.OWN_LIVE_BODIES
/** Codex plan-limit headers (02 §7.1): only their names are logged. */
const LIMIT_HEADER = /^x-codex-(primary|secondary|credits)-|^x-ratelimit-/

interface Socket {
  readonly pathname: string
  readonly search: string
  readonly headers: Readonly<Record<string, string>>
  readonly team: string | undefined
  readonly started: number
  readonly queue: Array<string | Buffer>
  readonly frames: Map<string, number>
  upstream?: WebSocket
}

export interface Forwarder {
  readonly url: string
  stop(): Promise<void>
}

/** Tokens one model response reported: uncached input, cache read, cache write, and output with reasoning. */
export interface Usage {
  readonly input: number
  readonly read: number
  readonly write: number
  readonly output: number
}

export interface Meter {
  /** Whether a model request on `route` (`anthropic`, `deepseek`, `chatgpt-01`, …) may still go out. */
  readonly allow: (route: string, model: string | undefined) => boolean
  readonly record: (entry: {
    readonly at: string
    readonly route: string
    readonly model: string | undefined
    readonly usage: Usage
  }) => void
}

/** `port` 0 picks a free one; real-host phase E names the port its `ssh -R` forwards. */
export function startForwarder(
  log: string,
  accounts: Readonly<Record<string, string>> = {},
  port = 0,
  meter?: Meter,
): Forwarder {
  const server = Bun.serve<Socket>({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 255,
    async fetch(request, server) {
      const started = Date.now()
      const url = new URL(request.url)
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const data: Socket = {
          pathname: url.pathname,
          search: url.search,
          headers: Object.fromEntries([...request.headers].filter(([name]) => !DROPPED_SOCKET.has(name.toLowerCase()))),
          team: accounts[request.headers.get("chatgpt-account-id") ?? ""],
          started,
          queue: [],
          frames: new Map(),
        }
        return server.upgrade(request, { data }) ? undefined : new Response("upgrade failed", { status: 400 })
      }
      const target = await route(url.pathname, accounts[request.headers.get("chatgpt-account-id") ?? ""])
      if (target === undefined) return new Response("unknown route", { status: 404 })
      const raw = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      const encoding = request.headers.get("content-encoding")
      const decoded = decode(raw, encoding)
      const text = decoded === undefined ? undefined : redact(decoded)
      const body = text === undefined || text === decoded ? raw : encode(text, encoding)
      if (text !== undefined && profileListing(text)) {
        await appendFile(
          log,
          JSON.stringify({ at: new Date(started).toISOString(), route: target.name, refused: "profile listing" }) + "\n",
        )
        return Response.json(
          { type: "error", error: { type: "privacy", message: "live test: the request held a Windows profile listing" } },
          { status: 403 },
        )
      }
      const metered = meter !== undefined && MODEL_PATH.test(url.pathname)
      if (metered && !meter.allow(target.name, model(text))) {
        // A refused request's body is kept too: a dry run checks what would have gone out.
        if (BODIES && text !== undefined) await Bun.write(path.join(BODIES, `${started}-${target.name}-refused.json`), text)
        return Response.json(
          { type: "error", error: { type: "budget", message: "live test budget reached" } },
          { status: 402 },
        )
      }
      const headers = new Headers(
        [...request.headers].filter(([name]) => !DROPPED_REQUEST.has(name.toLowerCase())),
      )
      Object.entries(target.headers).forEach(([name, value]) => headers.set(name, value))
      // The ChatGPT backend keys its prompt cache on `session-id` (2026-10-14 probe: no hits without it). own codex slots
      // add it from core's affinity header (own-accounts auth.ts); these plain test providers do not, so add it here.
      const affinity = request.headers.get("x-session-affinity")
      if (target.name.startsWith("chatgpt") && affinity && !headers.has("session-id")) headers.set("session-id", affinity)
      headers.set("accept-encoding", "identity")
      // Anthropic wants its version header on every route; an OpenAI-style client (a compat account on its
      // OpenAI-compatible endpoints, real-host phase E) sends none.
      if (target.name === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
      const upstream = await fetch(target.url + url.search, {
        method: request.method,
        headers,
        body,
      }).catch((error: unknown) => new Response(`forwarder: ${String(error)}`, { status: 502 }))
      const entry = {
        at: new Date(started).toISOString(),
        route: target.name,
        path: url.pathname.replace(/^\/(chatgpt\/[^/]+|chatgpt-team|deepseek|anthropic|openai|local)/, ""),
        model: model(text),
        bytes: body?.byteLength ?? 0,
        status: upstream.status,
        ms: Date.now() - started,
        limits: [...upstream.headers.keys()].filter((name) => LIMIT_HEADER.test(name)).sort(),
        // The body held this PC's user name or the user's email and went out redacted: a run checks for none.
        ...(text !== undefined && text !== decoded ? { redacted: true } : {}),
        ...(upstream.ok ? {} : { error: (await upstream.clone().text()).slice(0, 400) }),
        // The body held this PC's identity and went out with it replaced (a privacy finding to look at).
        ...(text !== decoded ? { redacted: true } : {}),
      }
      await appendFile(log, JSON.stringify(entry) + "\n")
      if (BODIES && text !== undefined) await Bun.write(path.join(BODIES, `${started}-${target.name}.json`), text)
      const [returned, copy] =
        metered && upstream.ok && upstream.body ? upstream.body.tee() : [upstream.body, undefined]
      if (copy && meter)
        void new Response(copy)
          .text()
          .then(async (reply) => {
            const usage = usageOf(reply)
            if (usage === undefined) return
            const line = { at: entry.at, route: target.name, model: entry.model, usage }
            meter.record(line)
            await appendFile(log, JSON.stringify(line) + "\n")
          })
          .catch(() => undefined)
      const counted = returned && MODEL_PATH.test(url.pathname) ? countedStream(returned, log, entry.at, started) : returned
      return new Response(counted, {
        status: upstream.status,
        headers: [...upstream.headers].filter(([name]) => !DROPPED_RESPONSE.has(name.toLowerCase())),
      })
    },
    websocket: {
      async open(socket) {
        const data = socket.data
        const target = await route(data.pathname, data.team)
        if (target === undefined || !target.name.startsWith("chatgpt")) return socket.close(1008, "unknown route")
        // The client left while the credential was read.
        if (socket.readyState !== WebSocket.OPEN) return
        // Bun's WebSocket takes handshake headers; the DOM type does not know them.
        const upstream = new WebSocket(`${target.url.replace(/^https:/, "wss:")}${data.search}`, {
          headers: { ...data.headers, ...target.headers },
        } as never)
        data.upstream = upstream
        upstream.onopen = () =>
          data.queue
            .splice(0)
            .forEach((message) => upstream.send(typeof message === "string" ? message : new Uint8Array(message)))
        upstream.onmessage = (event) => {
          const type = typeof event.data === "string" ? frameType(event.data) : "<binary>"
          data.frames.set(type, (data.frames.get(type) ?? 0) + 1)
          socket.send(event.data)
        }
        upstream.onclose = (event) => {
          void record(log, target.name, socket, event.code)
          // 1005 and 1006 cannot be sent in a close frame.
          socket.close(event.code === 1005 || event.code === 1006 ? 1011 : event.code, event.reason)
        }
        upstream.onerror = () => socket.close(1011, "upstream error")
      },
      message(socket, received) {
        const message = typeof received === "string" ? redact(received) : received
        if (typeof message === "string" && profileListing(message)) return socket.close(1008, "profile listing")
        // Not awaited: frames must go on in the order they came.
        if (BODIES && typeof message === "string")
          void Bun.write(path.join(BODIES, `${Date.now()}-${process.hrtime.bigint()}-websocket.json`), message)
        const upstream = socket.data.upstream
        if (upstream?.readyState === WebSocket.OPEN) return upstream.send(message)
        socket.data.queue.push(message)
      },
      close(socket) {
        socket.data.upstream?.close()
      },
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: async () => void (await server.stop(true)) }
}

/**
 * A model response's body passed through unchanged while it is counted, and a `stream` line logged once it ends: when
 * its first byte came (ms after the request started), its bytes, SSE `data:` events and comment lines (`: keep-alive`),
 * the longest pause between two reads, and how it ended (`end`, `error: …`, or `cancel` when the client left). Real-host
 * phase E reads it to tell a silent upstream from one that sent keepalives, and either from our own relay (RL31).
 */
function countedStream(source: ReadableStream<Uint8Array>, log: string, at: string, started: number) {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const seen = {
    bytes: 0,
    events: 0,
    comments: 0,
    first: undefined as number | undefined,
    last: 0,
    maxGapMs: 0,
    line: "",
    logged: false,
  }
  // Once: a cancel also ends the read that was waiting.
  const done = (outcome: string) => {
    if (seen.logged) return
    seen.logged = true
    void appendFile(
      log,
      JSON.stringify({
        at,
        stream: {
          firstByteMs: seen.first === undefined ? null : seen.first - started,
          bytes: seen.bytes,
          events: seen.events,
          comments: seen.comments,
          maxGapMs: seen.maxGapMs,
          ms: Date.now() - started,
          outcome,
        },
      }) + "\n",
    ).catch(() => undefined)
  }
  const count = (text: string) => {
    const lines = (seen.line + text).split("\n")
    seen.line = lines.pop() ?? ""
    lines.forEach((line) => {
      if (line.startsWith("data:")) seen.events++
      if (line.startsWith(":")) seen.comments++
    })
  }
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      const next = await reader.read().then(
        (read) => read,
        (error: unknown) => ({ error }),
      )
      const now = Date.now()
      seen.maxGapMs = Math.max(seen.maxGapMs, now - (seen.last || started))
      seen.last = now
      if ("error" in next) {
        done(`error: ${String(next.error).slice(0, 200)}`)
        return stream.error(next.error)
      }
      if (next.done) {
        done("end")
        return stream.close()
      }
      seen.first ??= now
      seen.bytes += next.value.byteLength
      count(decoder.decode(next.value, { stream: true }))
      stream.enqueue(next.value)
    },
    cancel(reason) {
      done("cancel")
      return reader.cancel(reason)
    },
  })
}

/**
 * ChatGPT's usage-limit reset credits (`wham/rate-limit-reset-credits`, its `/consume`, and Codex's `api/codex/…` form,
 * own-accounts 02 §7.1.1): never forwarded on any route, so no live test can list or spend a real account's credit.
 * Checked before a credential is read.
 */
const REFUSED = /rate-limit-reset-credits/i
/** The user's local model server: stand-in runs use it instead of the DeepSeek API (user request, 2026-11-12). */
const LOCAL_URL = (process.env.OWN_LIVE_LOCAL_URL ?? "http://localhost:64644/v1").replace(/\/+$/, "")

export async function route(pathname: string, teamAlias: string | undefined) {
  if (REFUSED.test(pathname)) return undefined
  const team = /^\/chatgpt-team(\/.*)$/.exec(pathname)
  if (team && teamAlias === undefined) return undefined
  const codex = team ? [teamAlias!, team[1]!] : /^\/chatgpt\/([^/]+)(\/.*)$/.exec(pathname)?.slice(1)
  if (codex) {
    const auth = await chatgpt(codex[0]!)
    return {
      name: `chatgpt-${codex[0]}`,
      url: `https://chatgpt.com/backend-api/codex${codex[1]}`,
      headers: { authorization: `Bearer ${auth.token}`, "chatgpt-account-id": auth.account },
    }
  }
  const usage = /^\/chatgpt-backend\/([^/]+)\/wham\/usage$/.exec(pathname)
  if (usage) {
    const auth = await chatgpt(usage[1]!)
    return {
      name: `chatgpt-${usage[1]}`,
      url: "https://chatgpt.com/backend-api/wham/usage",
      headers: { authorization: `Bearer ${auth.token}`, "chatgpt-account-id": auth.account },
    }
  }
  const ds = /^\/deepseek(\/.*)$/.exec(pathname)
  if (ds) return { name: "deepseek", url: `https://api.deepseek.com${ds[1]}`, headers: { authorization: `Bearer ${await deepseek()}` } }
  const own = /^\/local\/v1(\/.*)$/.exec(pathname)
  if (own && process.env.OWN_LIVE_LOCAL_UPSTREAM === "deepseek")
    return {
      name: "local-deepseek",
      url: `https://api.deepseek.com/v1${own[1]}`,
      headers: { authorization: `Bearer ${await deepseek()}` },
    }
  if (own) return { name: "local", url: `${LOCAL_URL}${own[1]}`, headers: { authorization: "Bearer local" } }
  const anth = /^\/anthropic(\/.*)$/.exec(pathname)
  if (anth) return { name: "anthropic", url: `https://api.anthropic.com${anth[1]}`, headers: { "x-api-key": await anthropic() } }
  const oai = /^\/openai(\/v1\/(?:models|images\/generations|images\/edits|responses))$/.exec(pathname)
  if (oai) return { name: "openai", url: `https://api.openai.com${oai[1]}`, headers: { authorization: `Bearer ${await openai()}` } }
  return undefined
}

/** One line per WebSocket when its upstream closes: frame types and counts, never their content. */
const recorded = new WeakSet<object>()
async function record(log: string, name: string, socket: ServerWebSocket<Socket>, code: number) {
  if (recorded.has(socket.data)) return
  recorded.add(socket.data)
  const entry = {
    at: new Date(socket.data.started).toISOString(),
    route: name,
    path: socket.data.pathname.replace(/^\/(chatgpt\/[^/]+|chatgpt-team)/, ""),
    websocket: true,
    close: code,
    ms: Date.now() - socket.data.started,
    frames: Object.fromEntries(socket.data.frames),
  }
  await appendFile(log, JSON.stringify(entry) + "\n")
}

function frameType(text: string) {
  return /^\s*\{\s*"type"\s*:\s*"([^"]{1,80})"/.exec(text)?.[1] ?? "<other>"
}

/** A request body as text: plain, or zstd as own codex slots and the test's ChatGPT providers send it. */
function decode(body: ArrayBuffer | undefined, encoding: string | null) {
  if (body === undefined) return undefined
  if (!encoding) return new TextDecoder().decode(body)
  if (encoding === "zstd") return new TextDecoder().decode(Bun.zstdDecompressSync(new Uint8Array(body)))
  return undefined
}

/** A redacted body in the encoding it came in. */
function encode(text: string, encoding: string | null) {
  if (encoding === "zstd") return new Uint8Array(Bun.zstdCompressSync(new TextEncoder().encode(text)))
  return new TextEncoder().encode(text)
}

/**
 * This PC's identity, which no live test sends anywhere: the Windows user name (the home folder's name, which Bun's
 * `userInfo().username` misses without USERNAME, so also every path under it), git's global name and e-mail, and the
 * e-mails the user keeps private (only their SHA-256 here). A tool's output carries them whatever environment the test
 * server gets: on 2026-11-07 a sub-agent's `bunx biome` printed its default cache folder under the user's profile.
 */
const IDENTITY = identity()
const PRIVATE_EMAILS = new Set([
  "af27838cc6fac1fa480221818f0f9bfde7edbf681c7217ef8a6e926d4a003b34",
  "e0f180ae7ea011bb25f781d5042c31b0757f540093a5d68645fe98d66d49daad",
])
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

/** `text` with the identity replaced by `user` and `user@example.invalid`. */
export function redact(text: string) {
  return IDENTITY.names
    .reduce((result, name) => result.replace(name, "user"), text)
    .replace(EMAIL, (email) =>
      IDENTITY.emails.includes(email.toLowerCase()) ||
      PRIVATE_EMAILS.has(new Bun.CryptoHasher("sha256").update(email.toLowerCase()).digest("hex"))
        ? "user@example.invalid"
        : email,
    )
}

/**
 * A listing of the Windows user profiles or of one profile's own folders (two of their fixed names): such a request is
 * refused, not sent. Redaction hides the user name, not what the folders hold: on 2026-11-07 a sub-agent listed
 * `C:\Users`, read the name from it and listed the user's home folder into a DeepSeek request.
 */
const PROFILE_NAMES =
  /\b(?:All Users|Default User|NetHood|PrintHood|SendTo|Saved Games|Application Data|Local Settings|My Documents)\b/g

export function profileListing(text: string) {
  return new Set(text.match(PROFILE_NAMES)).size >= 2
}

function identity() {
  const user = os.userInfo()
  const config = path.join(user.homedir, ".gitconfig")
  const section = /^\s*\[user\]([^[]*)/im.exec(fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "")?.[1] ?? ""
  const git = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "im").exec(section)?.[1] ?? ""
  // Short or generic names would replace ordinary words.
  // The account name from the logon token (`whoami`), not the environment: test runs give Bun a fake USERPROFILE and
  // no USERNAME, and on 2026-11-12 a sub-agent's `ls -l` owner column went out with the real name that way.
  const account = Bun.spawnSync(["whoami"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim().split("\\").pop() ?? ""
  const names = [...new Set([path.basename(user.homedir), user.username, account, git("name")])].filter(
    (name) => name.length >= 4 && !["unknown", "user", "admin", "test"].includes(name.toLowerCase()),
  )
  return {
    // Not `\b`: in a JSON body a name right after a line break follows the escape's letter (`\nname`), and on
    // 2026-11-07 a `C:\Users` listing went out with the name in it that way. An underscore bounds it too (`_tool_name`).
    names: names.map(
      (name) =>
        new RegExp(`(?<=^|[^A-Za-z0-9]|\\\\[nrtbfv])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi"),
    ),
    emails: [git("email").toLowerCase()].filter((email) => email !== ""),
  }
}

/** The model endpoints a meter counts (not `count_tokens`, model lists or plan usage reads). */
const MODEL_PATH = /\/(messages|chat\/completions|responses)$/
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * The usage a model response reported: Anthropic Messages (`message_start` and `message_delta`), Chat Completions
 * (DeepSeek's `prompt_cache_hit_tokens`, else `prompt_tokens_details.cached_tokens`) or Responses
 * (`response.completed`), as server-sent events or one JSON body. Each field is the largest any event gave.
 */
function usageOf(reply: string): Usage | undefined {
  const datas = reply.trimStart().startsWith("{")
    ? [reply]
    : reply
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
  const found = datas.flatMap((data) => {
    const value = objectOf(Option.getOrUndefined(decodeJson(data)))
    return [value?.usage, objectOf(value?.message)?.usage, objectOf(value?.response)?.usage].flatMap((usage) => {
      const object = objectOf(usage)
      return object === undefined ? [] : [normalize(object)]
    })
  })
  if (found.length === 0) return undefined
  return {
    input: Math.max(...found.map((usage) => usage.input)),
    read: Math.max(...found.map((usage) => usage.read)),
    write: Math.max(...found.map((usage) => usage.write)),
    output: Math.max(...found.map((usage) => usage.output)),
  }
}

function normalize(usage: Readonly<Record<string, unknown>>): Usage {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  if ("prompt_tokens" in usage) {
    const cached = count(usage.prompt_cache_hit_tokens) || count(objectOf(usage.prompt_tokens_details)?.cached_tokens)
    return {
      input: count(usage.prompt_tokens) - cached,
      read: cached,
      write: 0,
      output: count(usage.completion_tokens),
    }
  }
  const details = objectOf(usage.input_tokens_details)
  if (details !== undefined) {
    const cached = count(details.cached_tokens)
    return { input: count(usage.input_tokens) - cached, read: cached, write: 0, output: count(usage.output_tokens) }
  }
  return {
    input: count(usage.input_tokens),
    read: count(usage.cache_read_input_tokens),
    write: count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
  }
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function model(text: string | undefined) {
  if (text === undefined) return undefined
  return /"model"\s*:\s*"([^"]+)"/.exec(text.slice(0, 4096))?.[1] ?? /"model"\s*:\s*"([^"]+)"/.exec(text)?.[1]
}
