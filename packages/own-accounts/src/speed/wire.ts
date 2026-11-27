export * as SpeedWire from "./wire.js"

import { Option, Schema } from "effect"
import { Kind, Speed } from "@own/protocol"

/**
 * Owner: SPEED (02 §4.8). The request edits of a speed and the reading of the tier a response served. Pure.
 * - OpenAI family (`codex`, `siwc`, `oai`): the request option `serviceTier`, which core's Responses protocol sends as
 *   `service_tier` on HTTP and in the WebSocket `response.create` (`ai/src/protocols/open-responses.ts`).
 * - Anthropic (`anth`, the Claude subscription slot): core's Anthropic options have no `speed`, so the body field and
 *   the beta header {@link Speed.ANTHROPIC_BETA} are added on the HTTP request itself.
 */

/** The beta header list with {@link Speed.ANTHROPIC_BETA} added once; other betas keep their order. */
export function withBeta(value: string | null) {
  const betas = (value ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean)
  return betas.includes(Speed.ANTHROPIC_BETA) ? betas.join(",") : [...betas, Speed.ANTHROPIC_BETA].join(",")
}

/**
 * An Anthropic request with the beta header and, for `fast`, `speed: "fast"` in its JSON body (a Standard request of a
 * conversation that already sent the header keeps it and sends no `speed`). `undefined` when the body is not a JSON
 * object, so the request goes as it was. Method, URL, signal and every other header and field stay.
 */
export async function anthropic(request: Request, input: { readonly speed: string | undefined }) {
  const body = record(Option.getOrUndefined(decodeJson(await request.clone().text())))
  if (!body) return undefined
  const { speed: _previous, ...rest } = body
  const headers = new Headers(request.headers)
  headers.set("anthropic-beta", withBeta(headers.get("anthropic-beta")))
  headers.delete("content-length")
  return new Request(request, {
    headers,
    body: JSON.stringify(input.speed === undefined ? rest : { ...rest, speed: input.speed }),
  })
}

/**
 * The tier a Responses event names (`response.created`, `response.completed`, …: `response.service_tier`) or an
 * Anthropic event's usage (`message_start.message.usage.speed`, `message_delta.usage.speed`). `undefined` when the
 * event says nothing.
 */
export function servedOf(event: unknown): string | undefined {
  const json = record(event)
  if (!json) return undefined
  const response = record(json.response)
  const tier = response?.service_tier ?? json.service_tier
  if (typeof tier === "string") return tier
  const usage = record(json.usage) ?? record(record(json.message)?.usage)
  return typeof usage?.speed === "string" ? usage.speed : undefined
}

/**
 * The served tier a response of a slot of `kind` reports, as own reads it: {@link servedOf}'s, except that a ChatGPT plan
 * ({@link Kind.isOAuth}: `codex`, and `siwc` through the public API's token sharing) does not report the tier it ran. It
 * names `auto` or `default` whatever was sent:
 * - Codex backend, 2026-10-18 and 2026-10-22 (live, account 01): `priority` streamed at about 1.6–1.8 times and
 *   `ultrafast` at about 7–8 times Standard's output speed, over HTTP and the WebSocket alike, every answer saying
 *   `default` (Codex CLI never reads the field).
 * - Sign in with ChatGPT, 2026-10-22 (the user's own sessions, 2026-10-10 to 10-22): every answer to `ultrafast` and
 *   `priority` said `default` (or nothing) while those steps decoded faster than the same account's Standard ones.
 * A plan answer is therefore unreported unless it names a faster tier itself.
 */
export function reported(kind: string | undefined, tier: string | undefined) {
  if (kind === undefined || !Kind.isOAuth(kind) || tier === undefined) return tier
  return Speed.choiceOf({ id: tier }) === undefined ? undefined : tier
}

/** The last tier the `data:` lines of an SSE text name ({@link servedOf}); lines without one are skipped unparsed. */
export function servedOfLines(lines: ReadonlyArray<string>): string | undefined {
  return lines
    .flatMap((line) => {
      if (!line.startsWith("data:")) return []
      const data = line.slice(5).trim()
      if (!data.includes('"service_tier"') && !data.includes('"speed"')) return []
      const served = servedOf(Option.getOrUndefined(decodeJson(data)))
      return served === undefined ? [] : [served]
    })
    .at(-1)
}

/**
 * Reads a cloned SSE response to its end (or until `signal`) and answers the last tier it named ({@link servedOf}).
 * Never throws; `undefined` when the stream named none.
 */
export async function servedOfStream(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  const abort = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener("abort", abort, { once: true })
  const read = async (rest: string, found: string | undefined): Promise<string | undefined> => {
    const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }))
    if (chunk.done || signal.aborted) return servedOfLines([rest]) ?? found
    const text = rest + decoder.decode(chunk.value, { stream: true })
    const lines = text.split(/\r?\n/)
    const tail = lines.pop() ?? ""
    return read(tail, servedOfLines(lines) ?? found)
  }
  const served = await read("", undefined)
  signal.removeEventListener("abort", abort)
  await reader.cancel().catch(() => undefined)
  return served
}

/** The first `limit` characters of a response body; stops reading there. Read-only on a clone. */
export async function head(response: Response, limit: number) {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  const read = async (text: string): Promise<string> => {
    if (text.length >= limit) return text
    const chunk = await reader.read()
    if (chunk.done) return text
    return read(text + decoder.decode(chunk.value, { stream: true }))
  }
  const text = await read("")
  await reader.cancel().catch(() => undefined)
  return text.slice(0, limit)
}

/** A frame or event as JSON; `undefined` for anything else. */
export function json(text: string): Readonly<Record<string, unknown>> | undefined {
  return record(Option.getOrUndefined(decodeJson(text)))
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}
