// The quick capture's state (03 §4.4.1): the draft, its color and what the last save did. One flow per window, shared
// by the popover and the board's capture field, so a draft closed with Esc is there again the next time either opens.
// Saving never sends anything anywhere but this PC's `ideas.put`.
import { Ideas } from "@own/protocol/ideas"
import { createRoot, createSignal } from "solid-js"
import { cleanText, type Idea } from "./model"
import type { WriteOutcome } from "./store"

export type CaptureProblem =
  | { readonly kind: "tooLong"; readonly max: number }
  | { readonly kind: "limit"; readonly max: number }
  | { readonly kind: "error"; readonly message: string }

export function createCaptureFlow() {
  const [draft, setDraft] = createSignal("")
  const [color, setColor] = createSignal<Idea["color"]>("yellow")
  const [saving, setSaving] = createSignal(false)
  const [problem, setProblem] = createSignal<CaptureProblem>()

  return {
    draft,
    color,
    saving,
    problem,
    /** The field's value as the user types (clears a "too long" notice once it fits again). */
    input(value: string) {
      setDraft(value)
      if (problem()?.kind === "tooLong" && value.length <= Ideas.TEXT_MAX) setProblem(undefined)
    },
    setColor,
    /**
     * Saves the draft as a new idea; `add` is the window's store. Resolves the saved idea (the draft is emptied), or
     * `undefined` when nothing was saved: an empty draft, one that is too long, one already on its way, or a refusal
     * (the draft stays for another try).
     */
    async save(add: (text: string, color: Idea["color"]) => Promise<WriteOutcome>) {
      const text = cleanText(draft())
      if (saving() || text === undefined) return undefined
      if (text.length > Ideas.TEXT_MAX) return void setProblem({ kind: "tooLong", max: Ideas.TEXT_MAX })
      setSaving(true)
      setProblem(undefined)
      const result = await add(text, color()).finally(() => setSaving(false))
      if (result.type === "ok") {
        // Text typed while the save was out stays: only what was sent is taken out.
        setDraft((current) => (cleanText(current) === text ? "" : current))
        return result.idea
      }
      if (result.type === "limit") setProblem({ kind: "limit", max: result.max })
      else if (result.type === "error") setProblem({ kind: "error", message: result.message })
      // A fresh id cannot conflict; were it to, the next try uses another one.
      else setProblem({ kind: "error", message: "conflict" })
      return undefined
    },
    dismissProblem: () => setProblem(undefined),
  }
}

/** The window's capture flow. */
export const captureFlow = createRoot(() => createCaptureFlow())
