export * as Wiretap from "./wiretap.js"

import { Option, Schema } from "effect"
import { canonical, entries, short, type HeadersLike } from "./hash.js"
import { HEADER_NAMES, HEADER_PREFIXES } from "./last-response.js"
import { HEADERS, text } from "./redact.js"

/**
 * Pure helpers of the opt-in wire evidence capture (P0-3a, 02 §7.8): every response header name a provider sends,
 * and the JSON *shape* of error bodies, WebSocket frames, stream events and usage objects. A shape keeps the
 * structure, protocol enum values ({@link ENUM_KEYS}) and the numbers of usage and limit objects ({@link NUMBER_SCOPE});
 * every other string becomes `<str:N>` (its length) and every other number `<num>`, so a shape can be kept and compared
 * without the text it came from:
 * `{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"<str:83>","resets_in_seconds":"<num>"}}`.
 */

/** Header names whose values a shape capture keeps besides `LastResponse`'s allowlist: limits and retry hints. */
export const VALUE_NAME = /ratelimit|retry|reset|quota|usage|credit|limit|balance/i
/** Longest header value kept (after redaction). */
export const VALUE_CHARS = 256
/** Keys whose values are protocol enums or codes; a value is kept when it looks like one ({@link ENUM_VALUE}). */
export const ENUM_KEYS: ReadonlySet<string> = new Set([
  "type",
  "object",
  "status",
  "status_code",
  "code",
  "reason",
  "event",
  "param",
  "plan_type",
  "finish_reason",
])
/** One token of at most 64 characters. A sentence under an enum key still becomes `<str:N>`. */
export const ENUM_VALUE = /^[\w.:/-]{1,64}$/
/** Objects under a key like these keep their numbers: token usage and limits. */
export const NUMBER_SCOPE = /usage|limit|tokens/i
/** Arrays keep this many items; the rest is counted as `<+N>`. */
export const MAX_ITEMS = 20
/** Deeper values become `<deep>`. */
export const MAX_DEPTH = 12

/** Object keys kept as they are; any other key (a sentence, an id map key) becomes `<key<index>:<length>>`. */
const LABEL = /^[\w.$@:/-]{1,64}$/

/** What a response's headers say without their values: every name, and the values of limit-like names. */
export interface Census {
  /** Every header name, lower-cased, sorted, once. */
  readonly names: ReadonlyArray<string>
  /** `LastResponse` allowlist ∪ {@link VALUE_NAME} names, never credential headers; values redacted and truncated. */
  readonly values: Readonly<Record<string, string>>
}

export function census(headers: HeadersLike): Census {
  const all = entries(headers)
  return {
    names: [...new Set(all.map((entry) => entry[0]))].sort(),
    values: Object.fromEntries(
      all.filter((entry) => valued(entry[0])).map((entry) => [entry[0], text(entry[1]).slice(0, VALUE_CHARS)]),
    ),
  }
}

/** The shape of a JSON value (see the module comment). */
export function shape(value: unknown): unknown {
  return walk(value, undefined, false, 0, true)
}

/** Hash of {@link shape}: equal for values of one structure with equal enums, kept numbers and string lengths. */
export function hash(value: unknown) {
  return short(canonical(shape(value)), 16)
}

/**
 * Hash of the structure alone: keys, value kinds and enums, without string lengths or numbers. Frames of one kind
 * (every text delta of a stream) share it, so a capture writes each structure once.
 */
export function structure(value: unknown) {
  return short(canonical(walk(value, undefined, false, 0, false)), 16)
}

/**
 * Where limits, errors and usage live in a frame or stream event. A Responses lifecycle event (`response.created`,
 * `response.completed`, `response.failed` …) echoes the whole response, instructions and tools included, so only its
 * `status`, `error`, `incomplete_details`, `usage` and `service_tier` stay; every other event is kept whole.
 */
export function essentials(json: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const response = json.response
  if (typeof response !== "object" || response === null || Array.isArray(response)) return json
  return {
    ...json,
    response: Object.fromEntries(Object.entries(response).filter((entry) => RESPONSE_KEYS.has(entry[0]))),
  }
}

const RESPONSE_KEYS: ReadonlySet<string> = new Set(["status", "error", "incomplete_details", "usage", "service_tier"])

/** A JSON text's value, or `undefined` when it is not JSON. */
export function parse(input: string): unknown {
  return Option.getOrUndefined(decodeJson(input))
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** One server-sent event: its `event:` name and its `data:` lines joined. */
export interface ServerEvent {
  readonly name?: string
  readonly data: string
}

/** Splits buffered SSE text into the complete events and the unfinished rest. Comment-only blocks are dropped. */
export function events(buffer: string): { readonly events: ReadonlyArray<ServerEvent>; readonly rest: string } {
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ""
  return { events: blocks.flatMap(event), rest }
}

/** The event of one block (also the last block of a finished stream); none for a block without `data:`. */
export function event(block: string): ServerEvent[] {
  const lines = block.split(/\r?\n/)
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart())
  if (data.length === 0) return []
  const name = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim()
  return [{ ...(name ? { name } : {}), data: data.join("\n") }]
}

function valued(name: string) {
  return (
    !HEADERS.has(name) &&
    (HEADER_NAMES.has(name) || HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)) || VALUE_NAME.test(name))
  )
}

// `exact`: string lengths and kept numbers (a shape) or neither (a structure).
function walk(value: unknown, key: string | undefined, numbers: boolean, depth: number, exact: boolean): unknown {
  if (value === null || typeof value === "boolean") return value
  const enumKey = key !== undefined && ENUM_KEYS.has(key)
  if (typeof value === "string")
    return enumKey && ENUM_VALUE.test(value) ? value : exact ? `<str:${value.length}>` : "<str>"
  if (typeof value === "number") return enumKey || (exact && numbers) ? value : "<num>"
  if (typeof value !== "object") return `<${typeof value}>`
  if (depth >= MAX_DEPTH) return "<deep>"
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => walk(item, key, numbers, depth + 1, exact))
    return value.length > MAX_ITEMS ? [...items, `<+${value.length - MAX_ITEMS}>`] : items
  }
  return Object.fromEntries(
    Object.entries(value).map((entry, index) => [
      LABEL.test(entry[0]) ? entry[0] : `<key${index}:${entry[0].length}>`,
      walk(entry[1], entry[0], numbers || NUMBER_SCOPE.test(entry[0]), depth + 1, exact),
    ]),
  )
}
