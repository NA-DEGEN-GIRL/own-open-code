export * as Prefix from "./prefix.js"

import type { Ledger } from "@own/protocol"

/**
 * Per-block prefix fingerprint (P0-2b, 02 §7.8): a request split into its blocks in cache order (the tool definitions,
 * each system part, each message or input item), each hashed on its own, so two requests of one slot compare block by
 * block and the first block that differs is where the cached prefix broke. Only hashes come out, never content. Pure.
 *
 * A block is hashed in a canonical form like `Hash.canonical`'s (sorted keys, `undefined` members dropped, arrays in
 * order), without the {@link VOLATILE} keys and with bytes hashed as bytes. Key order inside a block therefore never
 * counts (whether a server's cache sees JSON key order is unverified ⚠); the order of blocks, of tools and of array
 * items does. The hash is 64-bit wyhash (`Bun.hash`): a request of 1,000 messages and a 25 MiB image takes about 23 ms
 * against 231 ms with SHA-256, and 64 bits are plenty to tell two requests of one slot apart. It is a comparison key of
 * this process, never stored or compared across Bun versions.
 */

export type Kind = Ledger.PrefixBlock

export interface Block {
  readonly kind: Kind
  /** {@link HASH_CHARS} hex characters of the 64-bit hash of the kind and the block's canonical form. */
  readonly hash: string
}

/** Hex characters kept of a block hash. */
export const HASH_CHARS = 16

/**
 * Keys that never belong to a prefix: cache breakpoints (own's and core's `cache` hints, the wire's `cache_control`)
 * move with every request without changing what the model reads. Folded by name, never by content.
 */
export const VOLATILE: ReadonlySet<string> = new Set(["cache", "cache_control"])

/** Shorter pieces of a block are gathered up to this many characters before hashing; longer ones go in as they are. */
const CHUNK_CHARS = 4 * 1024

/**
 * The blocks of a request as the session `context` hook shapes it: the tools as one block (in their order, by name),
 * then each system part, then each message.
 */
export function blocks(request: {
  readonly tools: Readonly<Record<string, unknown>>
  readonly system: ReadonlyArray<unknown>
  readonly messages: ReadonlyArray<unknown>
}): Block[] {
  return [
    block("tools", Object.entries(request.tools)),
    ...request.system.map((part) => block("system", part)),
    ...request.messages.map((message) => block("message", message)),
  ]
}

/**
 * The blocks of a request body as sent: Responses `tools`, `instructions` (or core's leading developer message with
 * text content, since upstream v2.3.2), then each `input` item (another `developer` item there is a mid-conversation
 * update, so a message); Anthropic `tools`, each `system` block, then each message; Chat
 * `tools`, then each message, the leading `system` or `developer` ones as system blocks. A body without tools still
 * starts with a (empty) tools block.
 */
export function body(json: unknown): Block[] {
  const value = record(json)
  const tools = block("tools", value.tools ?? [])
  if (Array.isArray(value.input)) {
    // Since upstream v2.3.2 (#64542) core sends the system prompt as a leading developer message with text content on
    // every Responses route instead of `instructions`; Codex's own developer items carry content parts and stay messages.
    // A chained request (`previous_response_id`) carries it in the previous response: its first item is new input.
    const lead =
      value.instructions === undefined && value.previous_response_id === undefined && leadingSystem(value.input[0])
        ? 1
        : 0
    return [
      tools,
      ...(value.instructions === undefined ? [] : [block("system", value.instructions)]),
      ...value.input.map((item: unknown, index: number) => block(index < lead ? "system" : "message", item)),
    ]
  }
  const system = value.system === undefined ? [] : Array.isArray(value.system) ? value.system : [value.system]
  const messages: ReadonlyArray<unknown> = Array.isArray(value.messages) ? value.messages : []
  const lead = messages.findIndex((message) => !isSystem(message))
  const cut = lead < 0 ? messages.length : lead
  return [
    tools,
    ...system.map((part: unknown) => block("system", part)),
    ...messages.map((message, index) => block(index < cut ? "system" : "message", message)),
  ]
}

/** One hash over the blocks of one kind of a request body ({@link body}): equal when that section is. */
export function section(json: unknown, kind: Kind) {
  return hex(
    Bun.hash.wyhash(
      body(json)
        .filter((item) => item.kind === kind)
        .map((item) => item.hash)
        .join(","),
    ),
  )
}

/**
 * How many leading blocks `next` shares with `previous`. Equal to `previous.length` when the next request reuses the
 * whole previous one (it only appended, or it is the same request again).
 */
export function lcp(previous: ReadonlyArray<Block>, next: ReadonlyArray<Block>) {
  const at = previous.findIndex((item, index) => next[index]?.hash !== item.hash)
  return at < 0 ? previous.length : at
}

function block(kind: Kind, value: unknown): Block {
  const state = { seed: Bun.hash.wyhash(kind), text: "" }
  const flush = () => {
    if (state.text.length > 0) state.seed = Bun.hash.wyhash(state.text, state.seed)
    state.text = ""
  }
  feed(value, (piece) => {
    if (typeof piece === "string" && piece.length < CHUNK_CHARS) {
      state.text += piece
      if (state.text.length >= CHUNK_CHARS) flush()
      return
    }
    flush()
    state.seed = Bun.hash.wyhash(piece, state.seed)
  })
  flush()
  return { kind, hash: hex(state.seed) }
}

// The canonical form, written piece by piece so a large block (a long tool output, an inline image) is hashed without
// another copy of it. Strings carry their length instead of JSON escapes; bytes go in raw behind theirs.
function feed(value: unknown, write: (piece: string | Uint8Array) => void): void {
  if (value === null || value === undefined) return write("null")
  if (typeof value === "string") {
    write(`"${value.length}:`)
    return write(value)
  }
  // Before `toJSON`: a Buffer would turn into an array of numbers.
  if (value instanceof Uint8Array) {
    write(`<${value.byteLength}:`)
    return write(value)
  }
  if (typeof value !== "object") return write(JSON.stringify(value) ?? "null")
  if ("toJSON" in value && typeof value.toJSON === "function") return feed(value.toJSON(), write)
  if (Array.isArray(value)) {
    write("[")
    value.forEach((item: unknown, index) => {
      if (index > 0) write(",")
      feed(item, write)
    })
    return write("]")
  }
  write("{")
  Object.entries(value)
    .filter((entry) => entry[1] !== undefined && !VOLATILE.has(entry[0]))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .forEach((entry, index) => {
      write(`${index > 0 ? "," : ""}${JSON.stringify(entry[0])}:`)
      feed(entry[1], write)
    })
  write("}")
}

function hex(hash: bigint) {
  return BigInt.asUintN(64, hash).toString(16).padStart(HASH_CHARS, "0")
}

function leadingSystem(item: unknown) {
  const value = record(item)
  return value.role === "developer" && typeof value.content === "string"
}

function isSystem(item: unknown) {
  const role = record(item).role
  return role === "system" || role === "developer"
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}
