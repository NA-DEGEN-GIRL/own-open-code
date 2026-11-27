// The composer's IME state machine (03 §12): the shared `createImeEnter` rules plus what a send needs around them —
// read the committed value, clear on the next frame (rule 7), let a button or shortcut commit a running composition
// first (rule 6), and the Esc-twice interrupt. The `보내는 키` setting (03 §4.6) picks the keys: Ctrl/⌘+Enter sends,
// Enter is a newline and Alt+Enter carries the "other delivery" modifier (the setting's default); or Enter sends,
// Shift+Enter is a newline and Ctrl/⌘+Enter the other delivery. No DOM creation and no store writes in the key path (R6).
// Unit-tested with both Chromium orders and both send keys.
import { commitComposition, createImeEnter, type ImeKeyEvent, type SendKey } from "@/ime/ime-enter"
import { nextFrame } from "@/data/frame"
import { eventCode } from "@/keyboard/chord"

/**
 * - `false`: keep the text (nothing was sent, e.g. offline).
 * - a function: runs right after the box was cleared on the next frame (navigation to a created session).
 */
export type SubmitResult = void | false | (() => void)

export interface ComposerInputOptions {
  readonly element: () => HTMLTextAreaElement | undefined
  /** One call per user send, with the committed text. */
  readonly submit: (text: string, modifier: boolean) => SubmitResult
  /** Esc pressed twice within `escapeMs` while `busy()` (03 §10 "실행 중단"). */
  readonly interrupt?: () => void
  readonly busy?: () => boolean
  /** After the box was cleared (auto-height). */
  readonly cleared?: () => void
  readonly escapeMs?: number
  readonly now?: () => number
  /** Whether an empty text may still be sent (attachments only, 18.10); default no. */
  readonly sendEmpty?: () => boolean
  /** `보내는 키` (03 §4.6); without it Enter sends, like every other field's IME machine. */
  readonly sendKey?: () => SendKey
}

export interface ComposerInput {
  /** Our own composition flag (rule 2). */
  composing(): boolean
  /** True while a sent text waits for its next-frame clear: session changes must not save it as a draft. */
  clearing(): boolean
  keydown(event: ImeKeyEvent): boolean
  keyup(event: Pick<ImeKeyEvent, "code" | "key">): void
  compositionstart(): void
  compositionend(): void
  input(): void
  /** Send button / shortcut path (rule 6): commits a running composition (≤ 300 ms), then sends once. */
  sendNow(modifier?: boolean): Promise<void>
}

/** Rule 6: how long a modified send key waits for the IME's own commit. */
const COMMIT_WAIT_MS = 300

export function createComposerInput(options: ComposerInputOptions): ComposerInput {
  const now = options.now ?? Date.now
  let lastEscape = Number.NEGATIVE_INFINITY
  let clearing = 0

  const send = (modifier: boolean) => {
    const element = options.element()
    if (!element) return
    const text = element.value
    if (!text.trim() && !options.sendEmpty?.()) return
    const result = options.submit(text, modifier)
    if (result === false) return
    clearing++
    // Rule 7: never clear in the same tick as compositionend; Chromium may re-insert the last syllable.
    nextFrame(() => {
      element.value = ""
      clearing--
      options.cleared?.()
      if (typeof result === "function") result()
    })
  }

  const ime = createImeEnter({ onEnter: send, sendKey: options.sendKey })

  return {
    composing: ime.composing,
    clearing: () => clearing > 0,
    keydown(event) {
      if (ime.keydown(event)) {
        // Rule 6: an IME commits on Enter, but Ctrl/⌘/Alt+Enter may leave the composition open. Without a commit
        // within 300 ms, blur/focus commits it, and that compositionend sends once (rule 8).
        if (ime.awaitingCommit() && (event.ctrlKey || event.metaKey || event.altKey))
          setTimeout(() => {
            const element = options.element()
            if (!element || !ime.awaitingCommit()) return
            element.blur()
            element.focus()
          }, COMMIT_WAIT_MS)
        return true
      }
      if (eventCode(event) !== "Escape" || !options.busy?.() || !options.interrupt) return false
      const at = now()
      if (at - lastEscape <= (options.escapeMs ?? 1_000)) {
        lastEscape = Number.NEGATIVE_INFINITY
        options.interrupt()
        return true
      }
      lastEscape = at
      return false
    },
    keyup: ime.keyup,
    compositionstart: ime.compositionstart,
    compositionend: ime.compositionend,
    input: ime.input,
    async sendNow(modifier = false) {
      const element = options.element()
      if (!element) return
      await commitComposition(element, ime.composing())
      send(modifier)
    },
  }
}
