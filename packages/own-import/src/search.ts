export * as Search from "./search.js"

import { NonNegativeInt } from "@opencode/schema/schema"
import type { OwnImport } from "@own/protocol/rpc-import"
import { Redact } from "@own/runtime"
import { Option, Schema } from "effect"
import { View } from "./render/view.js"
import type { Transcript } from "./transcript/ir.js"

/**
 * Searching other tools' conversations (09 §3 검색), read only and in memory:
 *
 * - {@link titles}: the list's search box over titles and first prompts the index holds (`sessions.list{query}`).
 * - {@link conversation}: Ctrl+F in the viewer (`sessions.search{ref}`): the whole conversation, tool calls and their
 *   output included, one hit per turn (a hit jumps to its turn).
 * - {@link folder}: `내용까지` (`sessions.search{directory}`): the folder's conversations in list order, the human's and
 *   the model's text only (tool output is most of the bytes and seldom what "what did we talk about" means), at most
 *   {@link LIMIT} hits within a {@link BUDGET_MS} budget.
 *
 * Matching is a case-insensitive substring match of the trimmed query (NFC); hits show secrets redacted ({@link find}).
 * A search that ran out of hits or time answers `complete: false` and a `cursor` (`일부만 찾음 · 계속 찾기`) that
 * resumes at the turn it had not finished.
 * Conversations are streamed through the viewer's walk (a Codex rollout one turn at a time, from a known turn offset
 * when the viewer read it before); nothing is cached and every search is cancellable.
 */

/** The longest snippet (`OwnImport.Hit`). */
export const SNIPPET_MAX = 160
/** Hits per answer when `limit` is not given (09 §3: at most 100). */
export const LIMIT = 100
/** Time per answer (09 §3: 5 s budget). */
export const BUDGET_MS = 5_000
/** Characters of context a snippet keeps before the match. */
const LEAD = 40

export interface Input {
  readonly query: string
  readonly cursor?: string
  /** Default {@link LIMIT}. */
  readonly limit?: number
  /** Default {@link BUDGET_MS}. */
  readonly budget?: number
  readonly signal?: AbortSignal
}

export interface Found {
  readonly hits: ReadonlyArray<OwnImport.Hit>
  readonly complete: boolean
  readonly cursor?: string
}

/** The query as a case-insensitive pattern; `undefined` for a blank query. */
export function matcher(query: string) {
  const text = query.normalize("NFC").trim()
  if (text === "") return undefined
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu")
}

/** List rows whose title or first prompt contains the query, in their order; a blank query keeps all. */
export function titles<T extends { readonly title: string; readonly firstPrompt?: string }>(
  items: ReadonlyArray<T>,
  query: string,
): T[] {
  const pattern = matcher(query)
  if (pattern === undefined) return [...items]
  return items.filter(
    (item) => pattern.test(item.title) || (item.firstPrompt !== undefined && pattern.test(item.firstPrompt)),
  )
}

/** One conversation, tool calls and output included (Ctrl+F in the viewer). */
export async function conversation(
  viewer: View.Viewer,
  target: View.Target,
  input: Input,
): Promise<View.Result<Found>> {
  const pattern = matcher(input.query)
  if (pattern === undefined) return { ok: true, value: { hits: [], complete: true } }
  const name = View.key(target.ref)
  const cursor = decodeCursor(input.cursor)
  const from = cursor?.k === name ? cursor.t : 0
  const limit = input.limit ?? LIMIT
  const hits: OwnImport.Hit[] = []
  const walked = await viewer.walk(
    target,
    { from, signal: input.signal, until: Date.now() + (input.budget ?? BUDGET_MS) },
    collector(target.ref, pattern, "all", hits, limit),
  )
  if (!walked.ok) return walked
  if (walked.value.complete) return { ok: true, value: { hits, complete: true } }
  return { ok: true, value: { hits, complete: false, cursor: encode({ v: 1, k: name, i: 0, t: walked.value.next }) } }
}

/**
 * A folder's conversations (`targets` in list order), the human's and the model's text only. A conversation that
 * cannot be read is passed over; a cancelled search answers `cancelled`.
 */
export async function folder(
  viewer: View.Viewer,
  targets: ReadonlyArray<View.Target>,
  input: Input,
): Promise<View.Result<Found>> {
  const pattern = matcher(input.query)
  if (pattern === undefined) return { ok: true, value: { hits: [], complete: true } }
  const cursor = decodeCursor(input.cursor)
  const found = cursor === undefined ? -1 : targets.findIndex((target) => View.key(target.ref) === cursor.k)
  // A conversation the cursor named that left the list: resume at its old place, from its start.
  const first = found !== -1 ? found : Math.min(cursor?.i ?? 0, targets.length)
  const limit = input.limit ?? LIMIT
  const until = Date.now() + (input.budget ?? BUDGET_MS)
  const hits: OwnImport.Hit[] = []
  const stopAt = (index: number, turn: number): View.Result<Found> => ({
    ok: true,
    value: { hits, complete: false, cursor: encode({ v: 1, k: View.key(targets[index].ref), i: index, t: turn }) },
  })

  const step = async (index: number, from: number): Promise<View.Result<Found>> => {
    if (index >= targets.length) return { ok: true, value: { hits, complete: true } }
    if (input.signal?.aborted) return { ok: false, reason: "cancelled" }
    if (hits.length >= limit || Date.now() > until) return stopAt(index, from)
    const target = targets[index]
    const walked = await viewer.walk(
      target,
      { from, signal: input.signal, until },
      collector(target.ref, pattern, "text", hits, limit),
    )
    if (!walked.ok && walked.reason === "cancelled") return walked
    if (walked.ok && !walked.value.complete) return stopAt(index, walked.value.next)
    return step(index + 1, 0)
  }
  return step(first, found !== -1 && cursor !== undefined ? cursor.t : 0)
}

/**
 * The first match of a turn: `text` searches the human's and the model's text, `all` every step. A text that matches
 * is matched again with its secrets as `[redacted:<label>]` (`Redact.named`, 09 §5.5), so a hit never shows a secret,
 * not even a part of one cut at the snippet's edge, and a query that only matched inside a secret finds nothing.
 */
function find(turn: Transcript.Turn, pattern: RegExp, scope: "text" | "all") {
  const texts = [turn.user.text, ...turn.steps.flatMap((step) => searched(step, scope))]
  return texts.reduce<string | undefined>((found, raw) => {
    if (found !== undefined || !pattern.test(raw)) return found
    const text = Redact.named(raw).text
    const match = pattern.exec(text)
    return match === null ? undefined : snippet(text, match.index)
  }, undefined)
}

function searched(step: Transcript.Step, scope: "text" | "all"): string[] {
  if (step.type === "text") return [step.text]
  if (scope === "text") return []
  if (step.type !== "tool") return [step.text]
  const input = typeof step.input === "string" ? step.input : (JSON.stringify(step.input) ?? "")
  return [step.name, input, step.output?.text ?? ""]
}

function collector(
  ref: OwnImport.SourceRef,
  pattern: RegExp,
  scope: "text" | "all",
  hits: OwnImport.Hit[],
  limit: number,
): View.Visitor {
  return {
    turn: (turn) => {
      const snippet = find(turn, pattern, scope)
      if (snippet !== undefined) hits.push({ ref, turn: turn.index, snippet })
      return hits.length < limit
    },
    // Hits in turns the tool rolled back later in the file are gone with them.
    rollback: (count) => {
      const kept = hits.filter((hit) => hit.ref !== ref || hit.turn < count)
      hits.splice(0, hits.length, ...kept)
    },
  }
}

/**
 * At most {@link SNIPPET_MAX} characters around a match at `index`: up to {@link LEAD} characters before it, the
 * rest after, whitespace runs as one space, `…` where text was cut. A surrogate pair is never split.
 */
export function snippet(text: string, index: number) {
  const flat = (part: string) => part.replace(/\s+/g, " ")
  const from = Math.max(0, index - LEAD * 4)
  const before = flat(text.slice(from, index))
  const head = from === 0 ? before.trimStart() : before
  const lead = head.length > LEAD ? head.slice(-LEAD).replace(/^[\uDC00-\uDFFF]/, "") : head
  const cutStart = from > 0 || lead.length < head.length
  const to = index + SNIPPET_MAX * 4
  const after = flat(text.slice(index, to))
  const tail = to >= text.length ? after.trimEnd() : after
  const room = SNIPPET_MAX - (cutStart ? 1 : 0) - lead.length
  const cutEnd = to < text.length || tail.length > room
  const body = cutEnd ? tail.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, "") : tail
  return `${cutStart ? "…" : ""}${lead}${body}${cutEnd ? "…" : ""}`
}

// ---------------------------------------------------------------------------------------------------------------
// Cursors: base64url JSON of where to resume (`k`: the conversation key, `i`: its index in the list, `t`: the turn)

const Cursor = Schema.Struct({ v: Schema.Literal(1), k: Schema.String, i: NonNegativeInt, t: NonNegativeInt })
type Cursor = typeof Cursor.Type
const decodeCursorJson = Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))

function encode(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

/** A cursor from an earlier answer; anything else starts from the beginning. */
function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined
  return Option.getOrUndefined(decodeCursorJson(Buffer.from(cursor, "base64url").toString("utf8")))
}
