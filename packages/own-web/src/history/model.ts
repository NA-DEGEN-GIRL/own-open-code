// Prompt history and draft decisions (03 §19.9), pure so they are unit-tested as tables. The navigator (navigator.ts)
// reads the textarea and applies what these decide; the stores (store.ts, drafts.ts) persist.
//
// History follows upstream `composer/history/*` (re-written for own-web, not vendored): one list for prompts and one
// for `!` shell commands, newest first, at most 100 each, the whole app (every session) shares them. An entry keeps
// its mention chips, so ↑ brings back `@file` and `@skill` chips with the text; attachments are not kept in history
// (upstream keeps ids only; own-web's drafts keep the bytes, 19.9).
import { chipID, type MentionChip } from "@/mentions"

export type HistoryMode = "normal" | "shell"

export interface HistoryEntry {
  readonly text: string
  readonly chips?: readonly MentionChip[]
  /** Epoch ms of the send. */
  readonly at: number
}

export const MAX_HISTORY = 100
/** Same cap as the text drafts (composer/drafts.ts). */
export const MAX_ENTRY_LENGTH = 20_000

/**
 * Adds a sent prompt at the top. Empty sends (no text, no chips) are not recorded; an identical older entry moves to
 * the top instead of repeating (the list stays useful for ↑).
 */
export function pushEntry(entries: readonly HistoryEntry[], entry: HistoryEntry, max = MAX_HISTORY) {
  const text = entry.text.slice(0, MAX_ENTRY_LENGTH)
  const chips = entry.chips?.length ? entry.chips : undefined
  if (!text.trim() && !chips) return entries
  const next: HistoryEntry = { text, at: entry.at, ...(chips ? { chips: [...chips] } : {}) }
  if (entries[0] && sameEntry(entries[0], next)) return entries
  return [next, ...entries.filter((item) => !sameEntry(item, next))].slice(0, max)
}

export function sameEntry(a: Pick<HistoryEntry, "text" | "chips">, b: Pick<HistoryEntry, "text" | "chips">) {
  if (a.text !== b.text) return false
  const left = (a.chips ?? []).map(chipID)
  const right = (b.chips ?? []).map(chipID)
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export interface CaretState {
  readonly text: string
  readonly start: number
  readonly end: number
  /** A history entry is on screen (↓ can go back toward the draft). */
  readonly browsing: boolean
}

/**
 * 03 §19.9: ↑/↓ walk the history only when the box is empty or the caret is on the first (↑) or last (↓) line, and
 * only with a collapsed selection; otherwise the arrow moves the caret as usual. ↓ does nothing until ↑ started
 * browsing. Composition is checked by the caller (keys during an IME composition are never taken, 03 §12 rule 3).
 */
export function canNavigate(direction: "up" | "down", state: CaretState) {
  if (state.start !== state.end) return false
  if (direction === "up") return state.text === "" || !state.text.slice(0, state.start).includes("\n")
  return state.browsing && !state.text.slice(state.end).includes("\n")
}

/**
 * Next position in the list: `-1` is the draft the user was writing, `0` the newest entry. `undefined` when the key
 * has nowhere to go (↑ at the oldest entry, ↓ on the draft), so the arrow keeps its caret meaning.
 */
export function step(index: number, direction: "up" | "down", length: number) {
  if (direction === "up") return index + 1 < length ? index + 1 : undefined
  return index >= 0 ? index - 1 : undefined
}

/** Shape check at the storage boundary: foreign or old records read as an empty list. */
export function readEntries(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return []
    const entry = item as Record<string, unknown>
    if (typeof entry.text !== "string" || typeof entry.at !== "number") return []
    const chips = Array.isArray(entry.chips) ? entry.chips.filter(isChip) : undefined
    return [{ text: entry.text, at: entry.at, ...(chips?.length ? { chips } : {}) }]
  })
}

/** A stored mention chip: only the kinds and fields the chip store knows. */
export function isChip(value: unknown): value is MentionChip {
  if (typeof value !== "object" || value === null) return false
  const chip = value as Record<string, unknown>
  switch (chip.kind) {
    case "file":
      return typeof chip.path === "string"
    case "reference":
      return typeof chip.name === "string" && typeof chip.path === "string"
    case "agent":
      return typeof chip.name === "string"
    case "skill":
      return typeof chip.id === "string" && typeof chip.name === "string"
    case "resource":
      return typeof chip.server === "string" && typeof chip.uri === "string" && typeof chip.name === "string"
    default:
      return false
  }
}
