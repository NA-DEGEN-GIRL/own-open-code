// `보내는 키` at the composer (03 §4.6, EM 2026-10-18): a small `▾` attached to `전송` opens the two choices, each with
// its new-line key and its other-delivery key, so the key is changed where it is used, with one pick. `전송`'s tooltip
// names the current key. Hidden on touch screens (composer.css), where `전송` always sends; 설정 > 일반 and the palette
// (`보내는 키 바꾸기`) change it there. Same menu pattern as the effort menu (./binding-button.tsx).
import { createSignal, For, onCleanup, Show } from "solid-js"
import { useI18n } from "@/i18n"
import { eventCode, isMac } from "@/keyboard"
import type { FeatureText } from "@/queue/text"
import { showToast } from "@/switcher"
import { followUp } from "./send"
import { SEND_KEYS, sendKey, sendKeyLabels, type SendKey } from "./send-key"
import { useSendKeyText, type SendKeyKey } from "./send-key-strings"

type Text = FeatureText<SendKeyKey>

export function SendKeyMenu() {
  const i18n = useI18n()
  const text = useSendKeyText()
  const [open, setOpen] = createSignal(false)
  let button: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  const label = () => text("own.sendKey.button", { current: sendKeyName(sendKey.value(), text) })
  /** The other delivery is the one `실행 중 보내기 동작` does not pick. */
  const otherDelivery = () => i18n.t(followUp.value() === "steer" ? "own.set.followUp.queue" : "own.set.followUp.steer")

  const close = (refocus = true) => {
    setOpen(false)
    document.removeEventListener("pointerdown", outside, true)
    if (refocus) button?.focus()
  }
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && (menu?.contains(event.target) || button?.contains(event.target))) return
    close(false)
  }
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))

  const onMenuKey = (event: KeyboardEvent) => {
    const code = eventCode(event)
    const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return close()
    }
    if (code !== "ArrowDown" && code !== "ArrowUp") return
    event.preventDefault()
    items[code === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length]?.focus()
  }

  return (
    <span class="own-cp-send-key-wrap">
      <button
        ref={button}
        type="button"
        class="own-cp-send own-cp-send-key"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={label()}
        title={label()}
        data-testid="composer-send-key"
        data-send-key={sendKey.value()}
        onClick={() => {
          if (open()) return close()
          setOpen(true)
          document.addEventListener("pointerdown", outside, true)
          queueMicrotask(() => menu?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
        }}
      >
        <span aria-hidden="true">▾</span>
      </button>
      <Show when={open()}>
        <div
          ref={menu}
          class="own-cp-menu own-cp-send-key-menu"
          role="menu"
          aria-label={text("own.sendKey.title")}
          data-testid="composer-send-key-menu"
          onKeyDown={onMenuKey}
        >
          <div class="own-cp-send-key-head" aria-hidden="true">
            {text("own.sendKey.title")}
          </div>
          <For each={SEND_KEYS}>
            {(mode) => {
              const keys = sendKeyLabels(mode)
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={sendKey.value() === mode}
                  class="own-cp-menu-item own-cp-menu-rich"
                  data-testid={`composer-send-key-${mode}`}
                  onClick={() => {
                    close()
                    if (sendKey.value() !== mode) changeSendKey(mode, text)
                  }}
                >
                  <span>{sendKeyName(mode, text)}</span>
                  <span class="own-cp-menu-note">
                    {text("own.sendKey.detail", {
                      newline: keys.newline,
                      other: keys.other,
                      delivery: otherDelivery(),
                    })}
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </span>
  )
}

/** `Enter로 보내기` / `Ctrl+Enter로 보내기` (⌘ on macOS). */
export function sendKeyName(mode: SendKey, text: Text) {
  return text(`own.sendKey.${mode}`, { mod: isMac ? "⌘" : "Ctrl" })
}

/** Sets the send key and says which keys send and break lines now (the composer menu and the palette). */
export function changeSendKey(next: SendKey, text: Text) {
  sendKey.set(next)
  const keys = sendKeyLabels(next)
  showToast({ message: text("own.sendKey.changed", { send: keys.send, newline: keys.newline }) })
}
