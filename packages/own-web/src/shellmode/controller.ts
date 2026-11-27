// Shell mode of the composer box (03 §4.6 "첫 글자가 `!`이면 셸 모드다", §10, §19.9). Kept per draft, so each session
// remembers whether its box was in shell mode. IME-safe (03 §12): the `!` is consumed only from an `input` event that
// is not part of a composition, keys are ignored while composing, and the textarea is never re-created.
import { createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { isImeKey, type ImeKeyEvent } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import { entersShell, leavesShell, shellCommand } from "./model"

export interface ShellModeOptions {
  readonly element: () => HTMLTextAreaElement | undefined
  /** The composer's draft key: shell mode is remembered per draft. */
  readonly draftKey: () => string
  /** The composer's own composition flag. */
  readonly composing: () => boolean
  /** Shell mode is unavailable (child session, a device without the terminal scope, `shellAllowed`). */
  readonly disabled?: () => boolean
  /** The text changed without an `input` event (the consumed `!`): save the draft, resize. */
  readonly changed?: (text: string) => void
}

export type ShellMode = ReturnType<typeof createShellMode>

export function createShellMode(options: ShellModeOptions) {
  const [state, setState] = createStore<{ active: Record<string, boolean | undefined> }>({ active: {} })
  /** The text starts with `!` (pasted or typed after the mode was left): the send is a shell command too. */
  const [prefixed, setPrefixed] = createSignal(false)
  const active = createMemo(() => !options.disabled?.() && !!state.active[options.draftKey()])
  const set = (on: boolean) => setState("active", options.draftKey(), on || undefined)

  return {
    /** The box is in shell mode (entered with `!`, Ctrl+Shift+X). */
    active,
    /** Border and placeholder: shell mode, or a text that starts with `!`. */
    visual: () => active() || (!options.disabled?.() && prefixed()),
    enter() {
      if (options.disabled?.()) return false
      set(true)
      return true
    },
    exit() {
      set(false)
    },
    /** The command a send of `text` runs, or `undefined` for a prompt. */
    command: (text: string) => (options.disabled?.() ? undefined : shellCommand(text, active())),
    /** Call from the textarea's `input` after the composer's own handling. Returns true when the `!` was consumed. */
    input(event?: { readonly isComposing?: boolean }) {
      const element = options.element()
      if (!element) return false
      if (
        !event?.isComposing &&
        !options.composing() &&
        !options.disabled?.() &&
        entersShell(element.value, active())
      ) {
        element.value = ""
        set(true)
        setPrefixed(false)
        options.changed?.("")
        return true
      }
      setPrefixed(element.value.startsWith("!"))
      return false
    },
    /** Call from keydown after the suggestion list and the composer's IME machine; true means handled. */
    keydown(event: ImeKeyEvent): boolean {
      if (isImeKey(event, options.composing())) return false
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
      const element = options.element()
      if (!element || !leavesShell(eventCode(event), element.value, active())) return false
      event.preventDefault()
      set(false)
      return true
    },
    /** After the composer replaced the text itself (draft swap, history, restore): look at the prefix again. */
    sync() {
      setPrefixed(options.element()?.value.startsWith("!") ?? false)
    },
    /** After a shell command was sent: back to prompt mode (upstream `clearSubmission`). */
    sent() {
      set(false)
      setPrefixed(false)
    },
  }
}
