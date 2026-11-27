// Korean IME rules for every text input (03 §12). One helper, `createImeEnter`, for the composer, titles, search
// boxes and dialogs. It never uses a time window to drop duplicates: every decision follows event order.
//
// Event orders it must survive (03 §12 "자동 시험"):
//   (A) Chromium/Edge: keydown(Enter, 229, isComposing) → compositionend → (A1) keydown(Enter, 13) again | (A2) none
//   (B) Safari:        compositionend → keydown(Enter, 229, isComposing: false)
import { nextFrame } from "@/data/frame"
import { eventCode } from "@/keyboard/chord"

/** The fields the rules read; a DOM KeyboardEvent satisfies it. */
export interface ImeKeyEvent {
  readonly code: string
  readonly key: string
  readonly keyCode: number
  readonly isComposing: boolean
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly repeat: boolean
  preventDefault(): void
}

/**
 * Which Enter sends (03 §4.6 `보내는 키`; only the conversation composer passes it, every other field keeps `enter`):
 * - `enter`: Enter sends, Shift+Enter is a new line, Ctrl/⌘+Enter is the other delivery while a turn runs;
 * - `modEnter` (the composer's default): Ctrl/⌘+Enter sends, Enter and Shift+Enter are new lines, Alt+Enter is the
 *   other delivery.
 */
export type SendKey = "enter" | "modEnter"

/** What an Enter keydown does under `sendKey`: `send`, `other` (the other delivery), or nothing (a new line). */
export function enterAction(
  event: Pick<ImeKeyEvent, "code" | "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
  sendKey: SendKey = "enter",
) {
  if (!isEnter(event) || event.shiftKey) return undefined
  const mod = event.ctrlKey || event.metaKey
  if (sendKey === "enter") return event.altKey ? undefined : mod ? "other" : "send"
  if (mod) return event.altKey ? undefined : "send"
  return event.altKey ? "other" : undefined
}

export interface ImeEnterOptions {
  /**
   * One call per send key, after any composition committed (rule 8). `modifier`: the other-delivery key (queue vs
   * steer): Ctrl/⌘+Enter, or Alt+Enter under `modEnter`.
   */
  readonly onEnter: (modifier: boolean) => void
  /**
   * Switcher and command palette search (rule 8 exception): the Enter that commits a composition only commits;
   * the next Enter applies. The duplicate keydown of order A1 is recognized because no keyup came in between.
   */
  readonly commitOnly?: boolean
  /** The composer's `보내는 키` (default `enter`); read on every keydown so a change applies at once. */
  readonly sendKey?: () => SendKey
}

export interface ImeEnter {
  /** Our own composition flag (rule 2), independent of the event's `isComposing`. */
  composing(): boolean
  /** A send key came during a composition and waits for its commit (rule 8 `sendAfterCommit`). */
  awaitingCommit(): boolean
  /** Returns true when the event was handled here (callers stop their own key handling). */
  keydown(event: ImeKeyEvent): boolean
  keyup(event: Pick<ImeKeyEvent, "code" | "key">): void
  compositionstart(): void
  compositionend(): void
  input(): void
  /** DOM listeners for an element (`<textarea on:keydown={...}>` style). */
  readonly listeners: {
    readonly onKeyDown: (event: KeyboardEvent) => void
    readonly onKeyUp: (event: KeyboardEvent) => void
    readonly onCompositionStart: () => void
    readonly onCompositionEnd: () => void
    readonly onInput: () => void
  }
}

/** Rule 3's test: true while an IME owns the key (Chromium `isComposing`, Safari 229, or our flag). */
export function isImeKey(event: Pick<ImeKeyEvent, "isComposing" | "keyCode">, composing = false) {
  return event.isComposing || event.keyCode === 229 || composing
}

export function isEnter(event: Pick<ImeKeyEvent, "code" | "key">) {
  const code = eventCode(event)
  return code === "Enter" || code === "NumpadEnter" || event.key === "Enter"
}

export function createImeEnter(options: ImeEnterOptions): ImeEnter {
  const state = {
    composing: false,
    /** Enter pressed during composition: send once when it commits (Chromium order A). */
    afterCommit: false,
    /** A commit-send is scheduled for the next frame. */
    pending: false,
    /** Already sent for this commit; cleared by the next input or compositionstart (rule 8). */
    sent: false,
    modifier: false,
    /** commitOnly: the committing Enter is still held down (no keyup yet). */
    commitHeld: false,
  }

  const fire = () => {
    if (state.pending || state.sent) return
    state.pending = true
    nextFrame(() => {
      state.pending = false
      if (state.sent) return
      state.sent = true
      options.onEnter(state.modifier)
    })
  }

  const api: ImeEnter = {
    composing: () => state.composing,
    awaitingCommit: () => state.afterCommit,
    keydown(event) {
      const action = enterAction(event, options.sendKey?.())
      const enter = action !== undefined
      const ime = isImeKey(event, state.composing)
      if (enter) state.modifier = action === "other"
      if (enter && ime) {
        if (options.commitOnly) {
          state.commitHeld = true
          // Safari has committed already; keep the Enter from reaching the form. Chromium: let it commit.
          if (!event.isComposing && !state.composing) event.preventDefault()
          return true
        }
        if (event.isComposing || state.composing) {
          state.afterCommit = true
          return true
        }
        event.preventDefault()
        fire()
        return true
      }
      if (ime) return true
      if (!enter) return false
      event.preventDefault()
      if (options.commitOnly) {
        if (state.commitHeld || event.repeat) return true
        options.onEnter(state.modifier)
        return true
      }
      if (event.repeat || state.pending || state.sent) return true
      options.onEnter(state.modifier)
      return true
    },
    keyup(event) {
      if (isEnter(event)) state.commitHeld = false
    },
    compositionstart() {
      state.composing = true
      state.sent = false
      state.commitHeld = false
    },
    compositionend() {
      state.composing = false
      if (!state.afterCommit) return
      state.afterCommit = false
      fire()
    },
    input() {
      state.sent = false
    },
    listeners: {
      onKeyDown: (event) => void api.keydown(event),
      onKeyUp: (event) => api.keyup(event),
      onCompositionStart: () => api.compositionstart(),
      onCompositionEnd: () => api.compositionend(),
      onInput: () => api.input(),
    },
  }
  return api
}

/**
 * Rule 6: a send that does not come from Enter (button click, Ctrl+Enter shortcut) first commits a running
 * composition by blur/focus, then waits for `compositionend` (at most 300 ms) and reads the value on the next frame.
 */
export function commitComposition(element: HTMLTextAreaElement | HTMLInputElement, composing: boolean) {
  return new Promise<void>((resolve) => {
    if (!composing) return nextFrame(resolve)
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      element.removeEventListener("compositionend", finish)
      clearTimeout(timer)
      nextFrame(resolve)
    }
    element.addEventListener("compositionend", finish)
    const timer = setTimeout(finish, 300)
    element.blur()
    element.focus()
  })
}

/** Rule 7: clear on the next frame, never in the same tick as `compositionend`. */
export function clearNextFrame(element: HTMLTextAreaElement | HTMLInputElement, after?: () => void) {
  nextFrame(() => {
    element.value = ""
    after?.()
  })
}
