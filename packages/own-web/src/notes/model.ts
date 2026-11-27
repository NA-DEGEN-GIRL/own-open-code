// Thread notes (03 §19.10, 01 §17.1 #26), pure part. A note is UI-only by default: its text lives in the session's
// metadata under `own.note` (`PATCH /api/session/:id {metadata}`), which the model never sees and which leaves the
// cached prefix alone. `모델에게도 보이기` adds the same text as the instruction entry `own.note`
// (`PUT /api/experimental/session/:id/instructions/entries/own.note`): core announces entry changes at the next step
// boundary as an appended update, so the note joins the end of the conversation and the prefix stays (R8). Removing
// the entry is announced the same way ("no longer applies"). Nothing else is ever written into model input.
import type { JsonValue } from "@opencode/client"

/** Metadata key of the note text (own namespace, next to `own.pinned` / `own.archived`). */
export const NOTE_KEY = "own.note"
/** Instruction entry key when the note is visible to the model (core renders it as `api/own.note`). */
export const NOTE_ENTRY = "own.note"
/**
 * Session metadata rides along every session list row, so notes stay short (the entry limit is 256 KiB, the list
 * is not the place for that).
 */
export const NOTE_LIMIT = 4_000

export interface NoteValue {
  text: string
  /** The instruction entry exists (the model sees the note). */
  visible: boolean
}

type Metadata = Readonly<Record<string, JsonValue>>

export function noteOf(metadata: unknown) {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return ""
  const value = NOTE_KEY in metadata ? metadata[NOTE_KEY] : undefined
  return typeof value === "string" ? value : ""
}

/** `metadata` with the note set, or removed when `text` is blank; every other key unchanged. */
export function withNote(metadata: Metadata | undefined, text: string): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = { ...metadata }
  if (text.trim()) next[NOTE_KEY] = text
  else delete next[NOTE_KEY]
  return next
}

/** The note entry's text, when the entry exists (a value another client wrote as non-text is shown as JSON). */
export function entryNote(entries: readonly { readonly key: string; readonly value: JsonValue }[]) {
  const entry = entries.find((item) => item.key === NOTE_ENTRY)
  if (!entry) return undefined
  return typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value)
}

export interface SavePlan {
  readonly metadata: boolean
  readonly entry: "put" | "remove" | "none"
}

/**
 * What a save writes. The metadata changes with the text. The entry is written only when the model's view changes:
 * put when it becomes visible or its visible text changes, removed when it stops being visible (or the note is
 * cleared). Each entry write reaches the model as one appended update, so an unchanged note writes nothing.
 */
export function planSave(saved: NoteValue, next: NoteValue): SavePlan {
  const text = next.text.trim()
  const visible = next.visible && text !== ""
  return {
    metadata: next.text !== saved.text,
    entry: visible ? (!saved.visible || next.text !== saved.text ? "put" : "none") : saved.visible ? "remove" : "none",
  }
}

/** The line under the editor: what the next request will carry, if anything. */
export function pendingEffect(saved: NoteValue, draft: NoteValue): "add" | "remove" | undefined {
  const plan = planSave(saved, draft)
  if (plan.entry === "put") return "add"
  if (plan.entry === "remove") return "remove"
  return undefined
}
