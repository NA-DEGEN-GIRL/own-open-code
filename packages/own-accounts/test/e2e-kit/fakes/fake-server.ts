import type { Server, ServerWebSocket, WebSocketHandler } from "bun"
import { PromptCache, type PromptCacheOptions } from "./prompt-cache"
import {
  jsonResponse,
  parseJson,
  recordHeaders,
  resetResponse,
  sha256,
  systemClock,
  type CacheUsage,
  type Clock,
  type CredentialInfo,
  type RecordedRequest,
  type Reply,
  type Responder,
  type WireFault,
} from "./shared"

/** Options every fake provider accepts. */
export interface FakeOptions {
  readonly hostname?: string
  /** 0 (default) picks a free port. */
  readonly port?: number
  /** Replaces `Date.now()` for cache TTLs and rate-limit windows; see `manualClock()`. */
  readonly clock?: Clock
  /** Called for each model request when no reply is queued. Return undefined for the default reply. */
  readonly responder?: Responder
  readonly cache?: PromptCacheOptions
  /**
   * Known credentials and the cache/limit domain each belongs to. When set, unknown credentials get
   * 401. When omitted, any non-empty credential is accepted and is its own domain.
   */
  readonly credentials?: Readonly<Record<string, CredentialInfo>>
}

export interface FakeProvider {
  readonly name: string
  /** Origin of the fake, e.g. `http://127.0.0.1:53211`. */
  readonly url: string
  /** Value for the provider's `settings.baseURL`. */
  readonly baseURL: string
  readonly cache: PromptCache
  readonly clock: Clock
  /** Every request received, in arrival order, including rejected ones. */
  readonly requests: readonly RecordedRequest[]
  /** Queues scripted replies consumed by the next model requests (FIFO). */
  enqueue(...replies: Reply[]): void
  /** Resolves once at least `count` requests matching `filter` were recorded. */
  waitForRequests(
    count: number,
    options?: { readonly timeoutMs?: number; readonly filter?: (request: RecordedRequest) => boolean },
  ): Promise<readonly RecordedRequest[]>
  /** Clears recordings and queued replies. The prompt cache is kept; use `cache.clear()` for that. */
  reset(): void
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface HandledRequest {
  readonly response: Response
  readonly identity?: string
  readonly model?: string
  readonly cache?: CacheUsage
  /** The wire fault the response carries (recorded; `reset` and `delayed-listen` record status 0). */
  readonly fault?: WireFault["type"]
  /**
   * Leave the request out of `requests` (a background read such as the Codex usage poll, which a test counts on its
   * own), so request marks and `waitForRequests` see the model requests only.
   */
  readonly unrecorded?: boolean
}

export interface FakeRequestContext {
  readonly request: Request
  readonly url: URL
  readonly body: string
  readonly json: unknown
  readonly now: number
  readonly server: Server<unknown>
  /** Picks the reply for a model request: queued reply, then responder, then the default. */
  reply(draft: { readonly identity?: string; readonly model?: string; readonly cache?: CacheUsage }): Reply
}

export interface FakeDefinition<Data> {
  readonly name: string
  readonly basePath: string
  readonly options: FakeOptions
  readonly defaultCache: PromptCacheOptions
  /** Rewrites the body kept in recordings (e.g. to hash token values); handlers still see the raw body. */
  readonly redactBody?: (url: URL, body: string) => string
  /** Returns undefined after upgrading the request to a WebSocket. */
  readonly handle: (context: FakeRequestContext, fake: FakeInternals) => Promise<HandledRequest | undefined>
  readonly websocket?: WebSocketHandler<Data>
}

/** Recorder and reply queue shared with protocol-specific handlers (HTTP and WebSocket). */
export interface FakeInternals {
  readonly cache: PromptCache
  readonly clock: Clock
  record(entry: Omit<RecordedRequest, "seq" | "fake" | "at">): RecordedRequest
  nextReply(draft: RecordedRequest): Reply
  /**
   * `delayed-listen`: stops listening at once, force-closing every open connection (the current request's too), and
   * listens again on the same port after `ms`.
   */
  unlisten(ms: number): void
}

const DEFAULT_REPLY: Reply = { type: "text", text: "ok" }

export function startFake<Data>(definition: FakeDefinition<Data>): FakeProvider & FakeInternals {
  const clock = definition.options.clock ?? systemClock
  const cache = new PromptCache({ ...definition.defaultCache, ...definition.options.cache, clock })
  const requests: RecordedRequest[] = []
  const queue: Reply[] = []
  const internals: FakeInternals = {
    cache,
    clock,
    record(entry) {
      const recorded = { ...entry, seq: requests.length + 1, fake: definition.name, at: clock.now() }
      requests.push(recorded)
      return recorded
    },
    nextReply(draft) {
      return queue.shift() ?? definition.options.responder?.(draft) ?? DEFAULT_REPLY
    },
    unlisten(ms) {
      void live.server.stop(true)
      clearTimeout(live.relisten)
      live.relisten = setTimeout(() => {
        live.server = serve(port)
      }, ms)
    },
  }
  const serve = (listen: number) =>
    Bun.serve<Data>({
      hostname: definition.options.hostname ?? "127.0.0.1",
      port: listen,
      idleTimeout: 0,
      async fetch(request, server) {
        const url = new URL(request.url)
        const raw = new Uint8Array(await request.arrayBuffer())
        const encoding = request.headers.get("content-encoding")
        const decoded = decodeBody(raw, encoding)
        const body = decoded ?? ""
        const json = parseJson(body)
        const recordedBody = definition.redactBody?.(url, body) ?? body
        const base = {
          transport: "http" as const,
          method: request.method,
          path: url.pathname + url.search,
          headers: recordHeaders(request.headers),
          body: recordedBody,
          bodyHash: sha256(body),
          json: recordedBody === body ? json : parseJson(recordedBody),
          ...(encoding ? { wireBytes: raw.byteLength } : {}),
        }
        // A body its `content-encoding` does not decode: the real routes answer 400 before reading it.
        if (decoded === undefined) {
          const response = jsonResponse(400, {
            error: { message: `undecodable ${encoding} body`, type: "invalid_request_error" },
          })
          internals.record({
            ...base,
            identity: undefined,
            model: undefined,
            cache: undefined,
            status: 400,
            responseHeaders: Object.fromEntries(response.headers.entries()),
          })
          return response
        }
        const handled = await definition.handle(
          {
            request,
            url,
            body,
            json,
            now: clock.now(),
            server,
            reply: (draft) =>
              internals.nextReply({
                ...base,
                identity: draft.identity,
                model: draft.model,
                cache: draft.cache,
                status: 0,
                responseHeaders: {},
                seq: requests.length + 1,
                fake: definition.name,
                at: clock.now(),
              }),
          },
          internals,
        )
        if (!handled) return undefined
        if (handled.unrecorded) return handled.response
        internals.record({
          ...base,
          identity: handled.identity,
          model: handled.model,
          cache: handled.cache,
          status: handled.fault === "reset" || handled.fault === "delayed-listen" ? 0 : handled.response.status,
          responseHeaders: Object.fromEntries(handled.response.headers.entries()),
          ...(handled.fault ? { fault: handled.fault } : {}),
        })
        return handled.response
      },
      websocket: definition.websocket ?? {
        message(socket: ServerWebSocket<Data>) {
          socket.close(1003, "WebSocket is not supported by this fake")
        },
      },
    })
  const live: { server: Server<Data>; relisten?: ReturnType<typeof setTimeout> } = {
    server: serve(definition.options.port ?? 0),
  }
  const port = live.server.port ?? 0
  const url = `http://${live.server.hostname}:${port}`
  const stop = async () => {
    clearTimeout(live.relisten)
    await live.server.stop(true)
  }
  return {
    ...internals,
    name: definition.name,
    url,
    baseURL: url + definition.basePath,
    requests,
    enqueue: (...replies) => {
      queue.push(...replies)
    },
    waitForRequests: (count, options) =>
      waitFor(
        () => {
          const matching = requests.filter(options?.filter ?? (() => true))
          return matching.length >= count ? matching : undefined
        },
        options?.timeoutMs ?? 30_000,
        () => `${definition.name}: expected ${count} request(s), got ${requests.length}`,
      ),
    reset: () => {
      requests.length = 0
      queue.length = 0
    },
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

/**
 * The HTTP answer to a wire fault that sends no response head: the connection resets before any header, and for
 * `delayed-listen` the listener closes first.
 */
export function interrupted(fake: FakeInternals, reply: Extract<Reply, { readonly type: "reset" | "delayed-listen" }>) {
  if (reply.type === "delayed-listen") fake.unlisten(reply.ms)
  return { fault: reply.type, response: resetResponse() }
}

/**
 * A request body as text. The ChatGPT routes decode `zstd` bodies (own codex and siwc slots send them, upstream
 * 5673bfa4a8) and gzip, so the fakes do too. `undefined` for any other encoding or a body that does not decode.
 */
function decodeBody(raw: Uint8Array<ArrayBuffer>, encoding: string | null) {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  if (!encoding || encoding === "identity") return text(raw)
  if (encoding !== "zstd" && encoding !== "gzip") return undefined
  // A corrupt frame throws; the caller answers it like the route would.
  try {
    return text(encoding === "zstd" ? Bun.zstdDecompressSync(raw) : Bun.gunzipSync(raw))
  } catch {
    return undefined
  }
}

/** Polls `probe` until it returns a value or the timeout elapses. */
export async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, message: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  const value = probe()
  if (value !== undefined) return value
  throw new Error(`Timed out after ${timeoutMs}ms: ${message()}`)
}
