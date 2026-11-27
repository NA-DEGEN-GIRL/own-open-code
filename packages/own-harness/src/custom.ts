// 내 지시문 (10 §3.11): the user's text for the editable part of a harness's prompt (Codex's base instructions, Pi's
// opening paragraph), one per harness, kept in this plugin's storage like the defaults (defaults.ts) so every
// Location's instance and every client sees the same text. A `custom` session reads it at each request; while none is
// saved it runs `own`. Nothing else of the prompt is stored: the permissions text, the tools and the rest stay
// generated.
export * as Custom from "./custom.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect, Schema } from "effect"

/** The longest text `prompt.custom.set` takes, in characters (Codex's longest template is about 21,000). */
export const LIMIT = 100_000

const Entry = Schema.Struct({ text: Schema.String, updatedAt: Schema.Number })
export type Entry = typeof Entry.Type

const key = (harness: OwnHarness.CustomHarnessID) => `prompt/custom/${harness}`

/** `harness`'s saved text, or undefined when none is saved or it no longer decodes. */
export function get(ctx: Pick<Context, "storage">, harness: OwnHarness.CustomHarnessID) {
  return ctx.storage.get(key(harness)).pipe(
    Effect.map((value) => Schema.decodeUnknownOption(Entry)(value)),
    Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value : undefined)),
  )
}

/** The harnesses with a saved text, in `CUSTOM_HARNESSES` order. */
export function saved(ctx: Pick<Context, "storage">) {
  return Effect.forEach(OwnHarness.CUSTOM_HARNESSES, (harness) =>
    get(ctx, harness).pipe(Effect.map((entry) => (entry === undefined ? [] : [harness]))),
  ).pipe(Effect.map((found) => found.flat()))
}

/** Saves `text` for `harness`; `null` deletes it (기본으로 되돌리기). Check {@link problem} first. */
export function save(ctx: Pick<Context, "storage">, harness: OwnHarness.CustomHarnessID, text: string | null) {
  if (text === null) return ctx.storage.remove(key(harness))
  return ctx.storage.set(key(harness), { text, updatedAt: Date.now() })
}

/** Why `text` cannot be saved: only blanks, or longer than {@link LIMIT}. */
export function problem(text: string) {
  if (text.trim() === "") return "empty" as const
  if (text.length > LIMIT) return "too_long" as const
  return undefined
}
