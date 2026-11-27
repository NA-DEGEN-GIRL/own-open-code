// The find bar over the transcript (03 §19.13): floating at the top right of the transcript area, like a browser's
// find. The input is uncontrolled (IME rule 5): typing records the value and the search runs on the next frame (R6);
// the Enter that commits a Hangul composition only commits, the next Enter moves (12 rule 8, as the sidebar search and
// the palette). Enter / ↓ / F3 next, Shift+Enter / ↑ / Shift+F3 previous, Esc closes and gives focus back.
import { createEffect, createUniqueId, on, onCleanup, onMount, Show } from "solid-js"
import { nextFrame } from "@/data/frame"
import { createImeEnter, isImeKey } from "@/ime/ime-enter"
import { inputSampler } from "@/perf/event-timing"
import type { SessionFindController } from "./controller"
import { useFindText } from "./strings"
import "./find.css"

export function FindBar(props: { readonly find: SessionFindController }) {
  return (
    <Show when={props.find.state.open}>
      <Bar find={props.find} />
    </Show>
  )
}

function Bar(props: { readonly find: SessionFindController }) {
  const find = props.find
  const text = useFindText()
  const id = createUniqueId()
  const opener = document.activeElement
  let input!: HTMLInputElement

  let pending: (() => void) | undefined
  const schedule = (value: string) => {
    pending?.()
    pending = nextFrame(() => {
      pending = undefined
      find.setQuery(value)
    })
  }
  const flush = () => {
    if (!pending) return
    pending()
    pending = undefined
    find.setQuery(input.value)
  }
  onCleanup(() => pending?.())

  const ime = createImeEnter({
    commitOnly: true,
    onEnter: () => {
      flush()
      find.move(1)
    },
  })

  onMount(() => {
    input.value = find.state.query
  })
  createEffect(
    on(
      () => find.state.focus,
      () =>
        requestAnimationFrame(() => {
          input.focus()
          input.select()
        }),
    ),
  )

  function close() {
    find.close()
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  }

  const count = () => {
    if (!find.state.needle) return ""
    if (find.state.searching && !find.count()) return text("own.find.searching")
    if (!find.count()) return text("own.find.none")
    return text(find.capped() ? "own.find.countCapped" : "own.find.count", {
      n: find.state.active + 1,
      total: find.capped() ? find.result().hits.length : find.count(),
    })
  }

  return (
    <div class="own-find" role="search" aria-label={text("own.find.label")} data-testid="find-bar">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="own-find-icon">
        <path d="M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4" />
      </svg>
      <input
        ref={input}
        type="text"
        role="searchbox"
        enterkeyhint="search"
        autocomplete="off"
        spellcheck={false}
        aria-label={text("own.find.label")}
        aria-describedby={`${id}-status`}
        placeholder={text("own.find.placeholder")}
        title={text("own.find.scope")}
        data-testid="find-input"
        onInput={(event) => {
          ime.input()
          schedule(event.currentTarget.value)
          inputSampler.record(event)
        }}
        onKeyDown={(event) => {
          const handled = ime.keydown(event)
          inputSampler.record(event)
          if (handled || isImeKey(event, ime.composing())) return
          const key = event.code
          if (key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            return close()
          }
          const back =
            ((key === "Enter" || key === "NumpadEnter") && event.shiftKey) ||
            key === "ArrowUp" ||
            (key === "F3" && event.shiftKey)
          const forward = key === "ArrowDown" || (key === "F3" && !event.shiftKey)
          if (!back && !forward) return
          event.preventDefault()
          flush()
          find.move(back ? -1 : 1)
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
      />
      <span class="own-find-count" data-testid="find-count" aria-hidden="true">
        {count()}
      </span>
      <button
        type="button"
        class="own-find-button"
        aria-label={text("own.find.previous")}
        title={text("own.find.previous")}
        disabled={!find.count()}
        data-testid="find-previous"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => find.move(-1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 15l6-6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        class="own-find-button"
        aria-label={text("own.find.next")}
        title={text("own.find.next")}
        disabled={!find.count()}
        data-testid="find-next"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => find.move(1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        type="button"
        class="own-find-button"
        aria-label={text("own.find.close")}
        title={text("own.find.close")}
        data-testid="find-close"
        onClick={() => close()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <Show when={find.state.needle && find.more()}>
        <button
          type="button"
          class="own-find-older"
          disabled={find.loadingOlder()}
          data-testid="find-older"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void find.loadOlder()}
        >
          {text(find.loadingOlder() ? "own.find.olderLoading" : "own.find.older")}
        </button>
      </Show>
      <span id={`${id}-status`} class="own-sr-only" role="status" aria-live="polite" data-testid="find-status">
        {find.state.needle && !find.state.searching
          ? find.count()
            ? text("own.find.status", { n: find.state.active + 1, total: find.count() })
            : text("own.find.statusNone", { query: find.state.query.trim() })
          : ""}
      </span>
    </div>
  )
}
