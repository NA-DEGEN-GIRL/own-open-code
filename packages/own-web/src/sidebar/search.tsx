// Session search (03 §4.3 "검색 입력(IME 규칙 적용)", 19.11 "세션 ID 붙여넣기"). The input is uncontrolled: the
// value is never written while composing (IME rule 5); results update outside the input on every `input` event,
// composition included (applied on the next frame). Enter follows the switcher/palette rule (12 rule 8 exception) because it opens a result:
// the Enter that commits Hangul only commits, the next one opens the first match. Esc clears, ↓ enters the list.
import { onCleanup, Show } from "solid-js"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { clearNextFrame, createImeEnter } from "@/ime/ime-enter"
import { inputSampler } from "@/perf/event-timing"
import { Icon } from "@/shell/icons"
import { useSidebar } from "./context"
import { useSidebarText } from "./strings"

export function SearchBox(props: {
  readonly onEnterList: () => void
  /** Enter: opens the first conversation found. */
  readonly onSubmit: () => void
  /** Gives the caller a way to focus the box (the desktop title-bar search button, 4.2.1). */
  readonly ref?: (api: { focus(): void }) => void
}) {
  const ctl = useSidebar()
  const i18n = useI18n()
  const text = useSidebarText()
  let input!: HTMLInputElement
  props.ref?.({ focus: () => input.focus() })

  // The input handler only records the value; the list filters on the next frame (R6: no list work inside the
  // input event, PF2). Enter and Esc apply or drop a pending value first.
  let pending: { readonly value: string; readonly cancel: () => void } | undefined
  function schedule(value: string) {
    pending?.cancel()
    const cancel = nextFrame(() => {
      pending = undefined
      ctl.setQuery(value)
    })
    pending = { value, cancel }
  }
  function flush() {
    if (!pending) return
    const { value, cancel } = pending
    pending = undefined
    cancel()
    ctl.setQuery(value)
  }
  onCleanup(() => pending?.cancel())

  const ime = createImeEnter({
    commitOnly: true,
    onEnter: () => {
      flush()
      props.onSubmit()
    },
  })

  function clear() {
    pending?.cancel()
    pending = undefined
    clearNextFrame(input, () => ctl.setQuery(""))
  }

  return (
    <div
      class="own-target flex h-8 items-center gap-1.5 rounded-lg border border-own-border-input bg-own-bg pr-1 pl-2 text-own-faint focus-within:border-own-focus"
      role="search"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" class="size-3.5 flex-none fill-none stroke-current stroke-[1.8]">
        <path d="M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4" />
      </svg>
      <label class="own-sr-only" for="own-sidebar-search">
        {i18n.t("own.nav.search")}
      </label>
      <input
        ref={input}
        id="own-sidebar-search"
        type="text"
        role="searchbox"
        enterkeyhint="search"
        autocomplete="off"
        spellcheck={false}
        placeholder={i18n.t("own.nav.search")}
        class="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] text-own-text outline-none placeholder:text-own-faint"
        data-testid="sidebar-search"
        onKeyDown={(event) => {
          const handled = ime.keydown(event)
          if (!handled && !event.isComposing && event.keyCode !== 229) {
            if (event.code === "Escape" && input.value) {
              event.preventDefault()
              event.stopPropagation()
              clear()
            } else if (event.code === "ArrowDown") {
              event.preventDefault()
              flush()
              props.onEnterList()
            }
          }
          inputSampler.record(event)
        }}
        onKeyUp={(event) => ime.keyup(event)}
        onCompositionStart={(event) => {
          ime.compositionstart()
          inputSampler.record(event)
        }}
        onCompositionEnd={(event) => {
          ime.compositionend()
          inputSampler.record(event)
        }}
        onInput={(event) => {
          ime.input()
          schedule(event.currentTarget.value)
          inputSampler.record(event)
        }}
      />
      <Show when={ctl.query()}>
        <button
          type="button"
          class="own-target grid size-6 flex-none place-items-center rounded-md text-own-muted hover:bg-own-hover hover:text-own-text [&_svg]:size-3 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-2"
          aria-label={text("own.sidebar.searchClear")}
          data-testid="sidebar-search-clear"
          onClick={() => {
            clear()
            input.focus()
          }}
        >
          <Icon name="x" />
        </button>
      </Show>
    </div>
  )
}
