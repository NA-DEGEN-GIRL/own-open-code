export * as LastResponse from "./last-response.js"

import { entries, type HeadersLike } from "./hash.js"
import { HEADERS, text } from "./redact.js"

/** Captures older than this are ignored (02 §7.2 "TTL은 30초다"). */
export const TTL_MS = 30_000
/** Injected auth hashes are kept this long; the matching response arrives within one request. */
export const INJECTED_TTL_MS = 10 * 60_000
/** Error bodies keep at most this many characters (02 §7.2 "앞 2KB"). */
export const BODY_HEAD_CHARS = 2048

/** Response headers worth keeping: limits, retry hints and domain identifiers (02 §7.1). */
export const HEADER_PREFIXES = ["x-codex-", "anthropic-ratelimit-", "x-ratelimit-"] as const
export const HEADER_NAMES: ReadonlySet<string> = new Set([
  "retry-after",
  "retry-after-ms",
  "anthropic-workspace-id",
  "anthropic-organization-id",
  "openai-organization",
  "openai-project",
  "x-request-id",
  "request-id",
])

/**
 * Summary of a rate-limit WebSocket frame (`codex.rate_limits`, `error`, `response.failed`, 01 §14.3). Only the
 * fields the retry classification needs; the frame itself is never stored.
 */
export interface Frame {
  readonly type: string
  readonly status?: number
  readonly code?: string
  readonly resetsInSeconds?: number
  readonly rateLimits?: unknown
}

/** `lastResponse[sessionID]` (02 §7.2): the latest own-slot or `anthropic` response of a session. */
export interface Capture {
  readonly providerID: string
  readonly status: number | null
  readonly headers: Readonly<Record<string, string>>
  readonly bodyHead: string | null
  readonly frame: Frame | null
  /** `hash8` of the credential header the request carried. */
  readonly authHash8: string | null
  readonly at: number
}

export interface CaptureInput {
  readonly providerID: string
  readonly status?: number | null
  readonly headers?: HeadersLike
  readonly bodyHead?: string | null
  readonly frame?: Frame | null
  readonly authHash8?: string | null
  readonly at?: number
}

/** Only the {@link HEADER_PREFIXES}/{@link HEADER_NAMES} headers, never credentials or cookies. */
export function pickHeaders(headers: HeadersLike): Record<string, string> {
  return Object.fromEntries(
    entries(headers).filter(
      (entry) =>
        !HEADERS.has(entry[0]) &&
        (HEADER_NAMES.has(entry[0]) || HEADER_PREFIXES.some((prefix) => entry[0].startsWith(prefix))),
    ),
  )
}

/**
 * Per-session capture store written by the `http.response` / `experimental.ws.receive` hooks of both plugins and
 * read by their `retry` hooks (01 §14.3). Also keeps the credential hash `model.request` injected per
 * `(sessionID, providerID)` for the auth swap check (02 §4.1). Headers are filtered and bodies truncated and
 * redacted on the way in. Expired entries are dropped lazily.
 */
export class Store {
  readonly #now: () => number
  readonly #captures = new Map<string, Capture>()
  readonly #injected = new Map<string, { readonly hash: string; readonly at: number }>()
  #writes = 0

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  record(sessionID: string, input: CaptureInput): Capture {
    const capture: Capture = {
      providerID: input.providerID,
      status: input.status ?? null,
      headers: input.headers ? pickHeaders(input.headers) : {},
      bodyHead: input.bodyHead ? text(input.bodyHead.slice(0, BODY_HEAD_CHARS)) : null,
      frame: input.frame ?? null,
      authHash8: input.authHash8 ?? null,
      at: input.at ?? this.#now(),
    }
    this.#captures.set(sessionID, capture)
    this.#sweepSometimes()
    return capture
  }

  /** The session's capture if it is younger than {@link TTL_MS}. */
  get(sessionID: string): Capture | undefined {
    const capture = this.#captures.get(sessionID)
    if (!capture) return undefined
    if (this.#now() - capture.at <= TTL_MS) return capture
    this.#captures.delete(sessionID)
    return undefined
  }

  clear(sessionID: string) {
    this.#captures.delete(sessionID)
    for (const key of this.#injected.keys()) if (key.startsWith(`${sessionID}\u0000`)) this.#injected.delete(key)
  }

  /** Remembers the credential hash injected into a request (`own-runtime.injected[sessionID][providerID]`). */
  recordInjected(sessionID: string, providerID: string, hash: string) {
    this.#injected.set(`${sessionID}\u0000${providerID}`, { hash, at: this.#now() })
    this.#sweepSometimes()
  }

  injected(sessionID: string, providerID: string) {
    const entry = this.#injected.get(`${sessionID}\u0000${providerID}`)
    if (!entry || this.#now() - entry.at > INJECTED_TTL_MS) return undefined
    return entry.hash
  }

  /** Drops expired entries. */
  sweep() {
    const now = this.#now()
    for (const [key, capture] of this.#captures) if (now - capture.at > TTL_MS) this.#captures.delete(key)
    for (const [key, entry] of this.#injected) if (now - entry.at > INJECTED_TTL_MS) this.#injected.delete(key)
  }

  get size() {
    return { captures: this.#captures.size, injected: this.#injected.size }
  }

  #sweepSometimes() {
    this.#writes += 1
    if (this.#writes % 256 === 0) this.sweep()
  }
}
