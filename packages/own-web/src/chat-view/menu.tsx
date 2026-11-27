// Session header `보기` (03 §4.4, §4.5 "대화 보기"): an eye button that opens a menu of check items, one per kind of
// meta information, plus `대화만 보기` and `기본으로`. The same choices are in 설정 > 일반 > 대화 보기 (./setting.tsx),
// and the palette and the `view.chatOnly` shortcut (Ctrl+Alt+R) toggle `대화만 보기`. Popover API like the header `⋯` (servers/menu.tsx): top layer,
// light dismiss, Esc, arrow keys; picking an item keeps the menu open so several can be changed in a row.
import { createSignal, createUniqueId, For, Show } from "solid-js"
import { chordLabel } from "@/keyboard"
import { effectiveKeymap } from "@/palette/keymap-store"
import { Icon } from "@/shell/icons"
import {
  CHAT_META,
  chatView,
  chatViewState,
  isChatOnly,
  isDefault,
  resetChatView,
  setChatMeta,
  toggleChatOnly,
} from "./state"
import { useChatViewText } from "./strings"

export function ChatViewMenu() {
  const text = useChatViewText()
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement
  const hiddenCount = () => chatViewState().hidden.length
  const keys = () => {
    const chord = effectiveKeymap()["view.chatOnly"].chords[0]
    return chord ? chordLabel(chord) : undefined
  }
  const items = () => [...popover.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")]
  const place = () => {
    const rect = button.getBoundingClientRect()
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    popover.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`
    popover.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") return event.stopPropagation()
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.code === "ArrowDown"
        ? (index + 1) % list.length
        : event.code === "ArrowUp"
          ? (index - 1 + list.length) % list.length
          : event.code === "Home"
            ? 0
            : event.code === "End"
              ? list.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    list[next]?.focus()
  }
  const label = () =>
    hiddenCount()
      ? `${text("own.chatView.button")} (${text("own.chatView.hiddenCount", { n: hiddenCount() })})`
      : text("own.chatView.button")
  const itemClass =
    "flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-inherit hover:bg-own-hover focus-visible:bg-own-hover"
  return (
    <>
      <button
        ref={button}
        type="button"
        class="own-icon-button own-target relative"
        aria-label={label()}
        title={label()}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={id}
        popovertarget={id}
        data-testid="chat-view-menu"
        data-hidden={hiddenCount() || undefined}
      >
        <Icon name={hiddenCount() ? "eyeOff" : "eye"} />
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="menu"
        aria-label={text("own.chatView.title")}
        class="m-0 min-w-[232px] rounded-lg border border-own-border bg-own-bg p-1 text-[13px] text-own-text shadow-lg"
        style={{ position: "fixed", inset: "auto" }}
        data-testid="chat-view-popover"
        onToggle={(event) => {
          const opened = event.newState === "open"
          setOpen(opened)
          if (!opened) return
          place()
          items()[0]?.focus()
        }}
        onKeyDown={onKeyDown}
      >
        <Show when={open()}>
          <div class="px-2.5 pb-1 pt-1.5 text-[11.5px] text-own-faint" aria-hidden="true">
            {text("own.chatView.title")}
          </div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={isChatOnly(chatViewState())}
            class={itemClass}
            data-testid="chat-view-only"
            onClick={() => toggleChatOnly()}
          >
            <Check on={isChatOnly(chatViewState())} />
            <span class="font-semibold">{text("own.chatView.chatOnly")}</span>
            <Show when={keys()}>
              {(chord) => <kbd class="ml-auto text-[11px] text-own-faint pointer-coarse:hidden">{chord()}</kbd>}
            </Show>
          </button>
          <hr class="my-1 border-0 border-t border-own-border" />
          <For each={CHAT_META}>
            {(key) => (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={chatView()[key]}
                class={itemClass}
                data-testid={`chat-view-${key}`}
                onClick={() => setChatMeta(key, !chatView()[key])}
              >
                <Check on={chatView()[key]} />
                <span>{text(`own.chatView.meta.${key}`)}</span>
              </button>
            )}
          </For>
          <hr class="my-1 border-0 border-t border-own-border" />
          <button
            type="button"
            role="menuitem"
            class={itemClass}
            aria-disabled={isDefault(chatViewState())}
            classList={{ "text-own-faint": isDefault(chatViewState()) }}
            data-testid="chat-view-reset"
            onClick={() => resetChatView()}
          >
            <span class="inline-block w-4" aria-hidden="true" />
            <span>{text("own.chatView.reset")}</span>
          </button>
        </Show>
      </div>
    </>
  )
}

function Check(props: { readonly on: boolean }) {
  return (
    <span
      aria-hidden="true"
      class="inline-flex size-4 flex-none items-center justify-center rounded border border-own-border-input text-[11px] leading-none"
      classList={{ "border-own-accent bg-own-accent text-own-on-accent": props.on }}
    >
      {props.on ? "✓" : ""}
    </span>
  )
}
