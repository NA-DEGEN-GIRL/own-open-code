// Putting a transcript into a text field (03 §4.6 받아쓰기, §12 IME rules): at the cursor (replacing a selection), with
// a space where it would otherwise run into a neighbouring word, never while an IME composition is running (rule 5:
// the text waits for `compositionend` and goes in on the next frame), and never sent. The field's owner sees an
// ordinary `input` event, so drafts, autosave and counters follow as if the user had typed it.
import { nextFrame } from "@/data/frame"

export type TextTarget = HTMLTextAreaElement | HTMLInputElement

/** The new value, the exact string inserted (with its spaces) and the caret after it. */
export function joinAt(value: string, start: number, end: number, text: string) {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lead = before !== "" && !/\s$/.test(before) && !/^[\s,.!?;:)\]}…]/.test(text) ? " " : ""
  const trail = after !== "" && !/^\s/.test(after) && !/\s$/.test(text) ? " " : ""
  const inserted = `${lead}${text}${trail}`
  return { value: before + inserted + after, inserted, caret: before.length + inserted.length }
}

/**
 * Inserts at the field's selection. `document.execCommand("insertText")` keeps the browser's undo stack (Ctrl+Z takes
 * the dictation back) and fires a trusted `input` event; where it is unavailable the value is set and an `input`
 * event dispatched.
 */
export function insertText(element: TextTarget, text: string) {
  const start = element.selectionStart ?? element.value.length
  const end = element.selectionEnd ?? start
  const plan = joinAt(element.value, start, end, text)
  element.focus({ preventScroll: true })
  element.setSelectionRange(start, end)
  const previous = element.value
  const native =
    document.activeElement === element &&
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, plan.inserted)
  // Some engines answer true without editing a form field; only an unchanged value falls back (never a second insert).
  if (native && element.value !== previous) return
  element.value = plan.value
  element.setSelectionRange(plan.caret, plan.caret)
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: plan.inserted }))
}

/**
 * Inserts into whatever field `target` returns, deferring while that field is composing. It watches composition on
 * the field itself (`compositionstart`/`compositionend`), so the owner needs no hook for it.
 */
export function createInserter(target: () => TextTarget | undefined) {
  let watched: TextTarget | undefined
  let composing = false
  let pending: string[] = []
  const start = () => {
    composing = true
  }
  const end = () => {
    composing = false
    if (!pending.length) return
    // Rule 5/7: never in the same tick as `compositionend`; the IME has written its last character by the next frame.
    nextFrame(() => {
      if (composing) return
      const element = watched
      const texts = pending
      pending = []
      if (element) for (const text of texts) insertText(element, text)
    })
  }
  const watch = () => {
    const element = target()
    if (element === watched) return element
    unwatch()
    watched = element
    composing = false
    element?.addEventListener("compositionstart", start)
    element?.addEventListener("compositionend", end)
    return element
  }
  const unwatch = () => {
    watched?.removeEventListener("compositionstart", start)
    watched?.removeEventListener("compositionend", end)
    watched = undefined
  }
  return {
    /** Starts watching the field now (call on mount, so a composition that starts mid-recording is seen). */
    watch: () => void watch(),
    composing: () => composing,
    /** `deferred`: a composition is running; the text goes in after it ends. */
    insert(text: string): "inserted" | "deferred" | "no_target" {
      const element = watch()
      if (!element) return "no_target"
      if (composing) {
        pending.push(text)
        return "deferred"
      }
      insertText(element, text)
      return "inserted"
    },
    dispose() {
      pending = []
      unwatch()
    },
  }
}
