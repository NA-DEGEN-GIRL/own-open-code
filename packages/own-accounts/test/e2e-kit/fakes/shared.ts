import { createHash } from "node:crypto"
import { Option, Schema } from "effect"

/**
 * One request that reached a fake provider. Secret header values (authorization, x-api-key, ...) are
 * replaced by `hashSecret(value)` before recording, so a recording can be printed or snapshotted
 * without leaking even fake credentials. The raw body is kept for assertions.
 */
export interface RecordedRequest {
  readonly seq: number
  readonly fake: string
  readonly transport: "http" | "websocket"
  readonly method: string
  /** Path plus query string, e.g. `/v1/messages?beta=true`. */
  readonly path: string
  /** Lower-case header names; secret values hashed. */
  readonly headers: Readonly<Record<string, string>>
  /** Cache/rate-limit domain the fake attributed the request to, or undefined when unauthenticated. */
  readonly identity: string | undefined
  /** The body as the route reads it: a `zstd` or gzip body decoded (`content-encoding` stays in `headers`). */
  readonly body: string
  readonly bodyHash: string
  readonly json: unknown
  /** Bytes on the wire when the body came with a `content-encoding`, else absent. */
  readonly wireBytes?: number
  readonly model: string | undefined
  readonly cache: CacheUsage | undefined
  readonly status: number
  readonly responseHeaders: Readonly<Record<string, string>>
  readonly at: number
  /** The wire fault the reply carried. `status` is 0 when no response head was sent (`reset`, `delayed-listen`). */
  readonly fault?: WireFault["type"]
}

export interface CacheUsage {
  /** Estimated prompt tokens (ceil(chars / 4) of the serialized prompt). */
  readonly promptTokens: number
  readonly cachedTokens: number
  readonly writtenTokens: number
  /** Hash of the serialized cacheable prompt, useful to compare prefixes across requests. */
  readonly promptHash: string
}

/** A scripted model reply. Fakes pop one per model request, falling back to their responder and then `ok`. */
export type Reply =
  | AnswerReply
  | {
      readonly type: "error"
      readonly status: number
      readonly body: unknown
      readonly headers?: Readonly<Record<string, string>>
    }
  | {
      /** Starts a successful stream, then fails it with a provider error event (SSE or WebSocket frame). */
      readonly type: "stream-error"
      readonly error: Readonly<Record<string, unknown>>
    }
  | WireFault

/** A complete streamed answer: what a wire fault breaks. */
export type AnswerReply =
  | {
      readonly type: "text"
      readonly text: string
      readonly outputTokens?: number
      readonly headers?: Readonly<Record<string, string>>
      /** Pause before the first byte (keeps the session busy, e.g. to test steering). */
      readonly delayMs?: number
      /** Pause between stream events. */
      readonly eventDelayMs?: number
      /** Splits the text over this many deltas (default 1), so a `drop` can cut between them. */
      readonly deltas?: number
    }
  | {
      readonly type: "tool-call"
      readonly name: string
      readonly input: Readonly<Record<string, unknown>>
      /** Responses fakes: send a freeform `custom_tool_call` with this text as its input instead of `input`. */
      readonly freeform?: string
      readonly id?: string
      readonly headers?: Readonly<Record<string, string>>
      readonly delayMs?: number
      readonly eventDelayMs?: number
    }

/**
 * What a broken connection or proxy does to a reply (P1-9b, after dsh's llm-mock-server failure list). The codex,
 * openai-responses and openai-chat fakes serve them; the anthropic fake answers 501 instead. A "delta" is a text or
 * tool-call arguments delta event, so `after: 1` on a tool-call reply cuts right behind the tool-call delta. There is
 * no stall: core's WebSocket idle timeout is a deliberate 30 minutes.
 */
export type WireFault =
  | {
      /** The connection resets before any response header (HTTP), or the WebSocket drops before any frame. */
      readonly type: "reset"
    }
  | {
      /** Sends `reply` through its `after`-th delta, then resets the connection (WebSocket: no close frame). */
      readonly type: "drop"
      readonly reply: AnswerReply
      readonly after: number
      /**
       * Resets once this settles instead of after {@link RESET_SETTLE_MS}, e.g. when the server has published the event
       * the sent part produces. A fixed pause can lose the sent events under CPU load (2026-10-14).
       */
      readonly until?: () => Promise<unknown>
    }
  | {
      /** Sends `reply` without its terminal event(s), then ends the stream cleanly (WebSocket: close 1000). */
      readonly type: "eof"
      readonly reply: AnswerReply
    }
  | {
      /** Sends `reply` with the event behind its `after`-th delta cut in half (invalid JSON); the rest follows. */
      readonly type: "malformed"
      readonly reply: AnswerReply
      readonly after: number
    }
  | {
      /** Codex WebSocket only: sends `reply` through its `after`-th delta, then closes with `code` (default 1011). */
      readonly type: "ws-close"
      readonly reply: AnswerReply
      readonly after: number
      readonly code?: number
    }
  | {
      /**
       * The listener closes, resetting this request and every open connection, and listens again on the same port after
       * `ms`; connections in between are refused.
       */
      readonly type: "delayed-listen"
      readonly ms: number
    }

/** A reply that sends a stream: an answer, a provider stream error, or an answer a wire fault breaks. */
export type StreamedReply = Exclude<Reply, { readonly type: "error" | "reset" | "delayed-listen" }>

export type Responder = (request: RecordedRequest) => Reply | undefined

/** Stream pacing requested by a reply (a broken reply keeps its answer's pacing). */
export function timing(reply: Reply): { readonly delayMs?: number; readonly eventDelayMs?: number } {
  if ("reply" in reply) return timing(reply.reply)
  return reply.type === "text" || reply.type === "tool-call"
    ? { delayMs: reply.delayMs, eventDelayMs: reply.eventDelayMs }
    : {}
}

/** Response headers a streamed reply adds (a broken reply keeps its answer's). */
export function replyHeaders(reply: StreamedReply): Readonly<Record<string, string>> | undefined {
  if ("reply" in reply) return reply.reply.headers
  return reply.type === "stream-error" ? undefined : reply.headers
}

/** The answer or stream error a streamed reply builds its events from. */
export function answerOf(reply: StreamedReply) {
  return "reply" in reply ? reply.reply : reply
}

/** `text` in at most `count` nearly equal pieces; an empty text is one empty piece. */
export function pieces(text: string, count = 1) {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, count)))
  return Array.from({ length: Math.max(1, Math.ceil(text.length / size)) }, (_, index) =>
    text.slice(index * size, (index + 1) * size),
  )
}

/** Which of a protocol's events a wire fault counts and leaves out. */
export interface WireMarks<T> {
  /** A text or tool-call arguments delta. */
  readonly delta: (event: T) => boolean
  /** An end-of-response event (`eof` leaves these out). */
  readonly terminal: (event: T) => boolean
}

/** The events a streamed reply sends and how the stream ends after them. */
export interface Cut<T> {
  readonly events: readonly T[]
  /** Index of the event sent cut in half (`malformed`). */
  readonly corrupt?: number
  /**
   * `complete`: the response ended normally (HTTP: the body closes; WebSocket: the socket stays open for the next
   * turn). `eof`: the stream ends cleanly (WebSocket: close 1000). `reset`: the connection breaks without a close.
   * `close`: a WebSocket close frame with `code`.
   */
  readonly end: "complete" | "eof" | "reset" | "close"
  readonly code?: number
  /** `drop`: what the reset waits for instead of {@link RESET_SETTLE_MS}. */
  readonly until?: () => Promise<unknown>
}

/** Applies a streamed reply's wire fault (if any) to the complete event list of its answer. */
export function cut<T>(reply: StreamedReply, events: readonly T[], marks: WireMarks<T>): Cut<T> {
  if (!("reply" in reply)) return { events, end: "complete" }
  if (reply.type === "eof") return { events: events.filter((event) => !marks.terminal(event)), end: "eof" }
  const at = behindDelta(events, reply.after, marks.delta)
  if (reply.type === "malformed") return { events, corrupt: at, end: "complete" }
  if (reply.type === "drop") return { events: events.slice(0, at), end: "reset", until: reply.until }
  return { events: events.slice(0, at), end: "close", code: reply.code ?? 1011 }
}

/** Index right behind the `after`-th delta (the first delta for 0, behind the last one when there are fewer). */
function behindDelta<T>(events: readonly T[], after: number, delta: (event: T) => boolean) {
  const deltas = events.flatMap((event, index) => (delta(event) ? [index] : []))
  if (after <= 0) return deltas[0] ?? 0
  const last = deltas[Math.min(after, deltas.length) - 1]
  return last === undefined ? 0 : last + 1
}

/** A serialized event cut in half, so it is no longer valid JSON. */
export function corrupted(text: string) {
  return text.slice(0, Math.ceil(text.length / 2))
}

/** The 501 a fake answers a wire fault it does not simulate with (an OpenAI-style error body). */
export function unsupportedFault(fake: string, fault: WireFault["type"]) {
  return jsonResponse(501, {
    error: { message: `The ${fake} fake does not simulate the wire fault '${fault}'.`, type: "fake_unsupported" },
  })
}

/** Maps a credential (API key or OAuth access token) to the domain that owns its cache and limits. */
export interface CredentialInfo {
  readonly domain: string
}

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** A clock tests can move forward to cross cache TTLs or rate-limit resets. */
export function manualClock(start = Date.UTC(2026, 8, 27, 0, 0, 0)) {
  const state = { now: start }
  return {
    now: () => state.now,
    advance(ms: number) {
      state.now += ms
    },
    set(ms: number) {
      state.now = ms
    },
  }
}

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

/** Stable short hash used in recordings instead of secret values. */
export function hashSecret(value: string) {
  return `sha256:${sha256(value).slice(0, 12)}`
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "x-goog-api-key",
])

export function recordHeaders(headers: Headers) {
  return Object.fromEntries(
    Array.from(headers.entries()).map(([name, value]) => [
      name.toLowerCase(),
      SECRET_HEADERS.has(name.toLowerCase()) ? hashSecret(value) : value,
    ]),
  )
}

export function bearerToken(headers: Headers) {
  const value = headers.get("authorization")
  if (!value) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match ? match[1].trim() : undefined
}

/** Resolves the cache/limit domain of a credential: the configured domain, else a hash of the credential. */
export function credentialDomain(
  credential: string,
  credentials: Readonly<Record<string, CredentialInfo>> | undefined,
): string | undefined {
  const known = credentials?.[credential]
  if (known) return known.domain
  if (credentials !== undefined && Object.keys(credentials).length > 0) return undefined
  return hashSecret(credential)
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Parses a request body; undefined when it is empty or not JSON (the fake then answers 400). */
export function parseJson(body: string): unknown {
  return Option.getOrUndefined(decodeJson(body))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringField(value: unknown, key: string) {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "string" ? field : undefined
}

export interface SseEvent {
  readonly event?: string
  readonly data: unknown
}

export function encodeSse(event: SseEvent) {
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data)
  return `${event.event ? `event: ${event.event}\n` : ""}data: ${data}\n\n`
}

/** Parses an SSE body into events; `data` is decoded JSON when possible, else the raw string. */
export function parseSse(text: string): SseEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/))
    .filter((lines) => lines.some((line) => line.startsWith("data:")))
    .map((lines) => {
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim()
      return { ...(event ? { event } : {}), data: parseJson(data) ?? data }
    })
}

/** Pause before a reset or close so the events sent ahead of it reach the client first. */
export const RESET_SETTLE_MS = 50

/**
 * Streams SSE events, optionally pausing before the first byte and between events. A wire fault's {@link cut} may
 * corrupt one event and end the stream with a connection reset instead of a clean close.
 */
export function sseResponse(
  events: readonly SseEvent[],
  init: {
    readonly headers?: Readonly<Record<string, string>>
    readonly delayMs?: number
    readonly eventDelayMs?: number
    readonly corrupt?: number
    readonly end?: Cut<SseEvent>["end"]
    readonly until?: Cut<SseEvent>["until"]
  },
) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (init.delayMs) await Bun.sleep(init.delayMs)
      for (const [index, event] of events.entries()) {
        const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data)
        controller.enqueue(
          encoder.encode(encodeSse(index === init.corrupt ? { ...event, data: corrupted(data) } : event)),
        )
        if (init.eventDelayMs) await Bun.sleep(init.eventDelayMs)
      }
      if (init.end !== "reset") return controller.close()
      if (events.length > 0) await settle(init.until)
      // Erroring the body resets the connection; `undefined` keeps Bun from printing it as an uncaught error.
      controller.error(undefined)
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...init.headers },
  })
}

/**
 * The pause before a reset or close: the `until` gate of a `drop` (a failed gate still resets), else
 * {@link RESET_SETTLE_MS}.
 */
export function settle(until: Cut<unknown>["until"]) {
  return until ? until().catch(() => undefined) : Bun.sleep(RESET_SETTLE_MS)
}

/** A response whose connection resets before any header is sent. */
export function resetResponse() {
  return sseResponse([], { end: "reset" })
}

export function jsonResponse(status: number, body: unknown, headers?: Readonly<Record<string, string>>) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}
