// `보내는 키` (03 §4.6, §10; EM 2026-10-18, EM-10 2026-10-23): which Enter sends in the conversation composer —
// `Ctrl+Enter로 보내기` (the default; ⌘+Enter on macOS: Enter and Shift+Enter are new lines, Alt+Enter the other
// delivery while a turn runs) or `Enter로 보내기` (Shift+Enter is a new line, Ctrl/⌘+Enter the other delivery). Kept per
// viewer in localStorage like `실행 중 보내기 동작` (./send.ts `followUp`); the other windows of this origin follow a
// change through the `storage` event. Only the composer reads it: notes, ideas, team goals and forms keep their own
// Enter rules.
import { createRoot, createSignal } from "solid-js"
import type { SendKey } from "@/ime/ime-enter"
import { chordLabel, isMac } from "@/keyboard/chord"

export type { SendKey } from "@/ime/ime-enter"

/** The default first (the menu beside 전송, 설정 > 일반). */
export const SEND_KEYS = ["modEnter", "enter"] as const satisfies readonly SendKey[]

/**
 * `.v2` since the default became Ctrl+Enter (EM-10): the first key (`own.web.composer.sendKey`) was written while Enter
 * was the default, also by a click on the already chosen `Enter로 보내기` in 설정 > 일반, so its `enter` cannot be told
 * from a choice and is not read. Only a change is stored now.
 */
export const SEND_KEY_STORAGE = "own.web.composer.sendKey.v2"

/** A stored value to a choice; anything else is the default. */
export function parseSendKey(value: unknown): SendKey {
  return value === "enter" ? "enter" : "modEnter"
}

export const sendKey = createRoot(() => {
  const [value, setValue] = createSignal(parseSendKey(read()))
  if (typeof window === "object")
    window.addEventListener("storage", (event) => {
      if (event.key === SEND_KEY_STORAGE) setValue(parseSendKey(event.newValue))
    })
  return {
    value,
    set(next: SendKey) {
      if (next === value()) return
      setValue(next)
      try {
        localStorage.setItem(SEND_KEY_STORAGE, next)
      } catch {}
    },
  }
})

/** Key names for hints: `send` sends the setting's way, `other` the other delivery while running, `newline`. */
export function sendKeyLabels(mode: SendKey, mac = isMac) {
  const mod = chordLabel("Mod+Enter", mac)
  if (mode === "modEnter") return { send: mod, other: "Alt+Enter", newline: "Enter" }
  return { send: "Enter", other: mod, newline: "Shift+Enter" }
}

function read() {
  try {
    return localStorage.getItem(SEND_KEY_STORAGE)
  } catch {
    return null
  }
}
