export * as Audit from "./audit.js"

import { createHash } from "node:crypto"
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Result, Schema } from "effect"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { Keys } from "./keys.js"
import type { ToolSchema } from "./schema.js"

/**
 * Append-only JSON-lines log of every computer action, one file per UTC month (`computer-YYYY-MM.jsonl`). It never
 * stores images, typed text or window titles: text becomes only its length, key presses that type a character only
 * their count, titles a short hash. Writing
 * is best effort — a full disk or a locked file never fails the action that is being audited. The entry shape is the
 * `own.computer` contract (`audit.list`).
 */
export const Entry = OwnComputer.AuditEntry
export type Entry = typeof Entry.Type

/**
 * Keeps every argument except typed text. The text of `type` becomes only its length. The chords of `key` and
 * `hold_key` keep only the ones that do more than type a character (`ctrl+s`, `Return`), in order, plus the count of
 * the rest: a PIN or one-time code pressed digit by digit is typed text too. No hash: a short typed value would be
 * found from an unsalted hash by trying every candidate.
 */
export function redactArgs(name: ToolSchema.Name, input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (key !== "text" || typeof value !== "string") return [key, value]
      if (name === "type") return [key, { length: value.length }]
      if (name === "key" || name === "hold_key") return [key, chords(value)]
      return [key, value]
    }),
  )
}

/** Chord text without its character presses; text that does not parse keeps only its length. */
function chords(text: string) {
  const parsed = Keys.parse(text)
  if (Result.isFailure(parsed)) return { length: text.length }
  return {
    chords: parsed.success.filter((chord) => !Keys.character(chord)).map(Keys.format),
    characters: parsed.success.filter(Keys.character).length,
  }
}

export function titleHash(title: string) {
  return digest(title)
}

export function monthFile(ts: number) {
  return `computer-${new Date(ts).toISOString().slice(0, 7)}.jsonl`
}

/** Appends one entry; never fails. */
export function append(dir: string, entry: Entry) {
  return Effect.tryPromise(async () => {
    await mkdir(dir, { recursive: true })
    await appendFile(path.join(dir, monthFile(entry.ts)), `${JSON.stringify(entry)}\n`, "utf8")
  }).pipe(Effect.ignore)
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Entry))

/**
 * Newest entries first, optionally of one session and older than `before` (ms). Reads month files from the newest
 * until `limit` entries are found; unreadable files and malformed lines are skipped.
 */
export function list(
  dir: string,
  input: { readonly sessionID?: string; readonly limit: number; readonly before?: number },
) {
  return Effect.gen(function* () {
    const files = yield* Effect.tryPromise(() => readdir(dir)).pipe(Effect.orElseSucceed((): Array<string> => []))
    const months = files
      .filter((file) => /^computer-\d{4}-\d{2}\.jsonl$/.test(file))
      .toSorted()
      .toReversed()
    const found: Array<Entry> = []
    for (const file of months) {
      if (found.length >= input.limit) break
      const text = yield* Effect.tryPromise(() => readFile(path.join(dir, file), "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      )
      const entries = text
        .split("\n")
        .flatMap((line) => Option.toArray(decodeLine(line)))
        .filter(
          (entry) =>
            (input.sessionID === undefined || entry.sessionID === input.sessionID) &&
            (input.before === undefined || entry.ts < input.before),
        )
        // Reversed first, so calls within the same millisecond also come newest first (by append order).
        .toReversed()
        .toSorted((left, right) => right.ts - left.ts)
      found.push(...entries.slice(0, input.limit - found.length))
    }
    return found
  })
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12)
}
