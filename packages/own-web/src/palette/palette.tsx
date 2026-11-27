// Command palette dialog (03 §3 "명령 팔레트 (Ctrl+K)", §10, §11, 19.15). Lazy chunk (20.2 R5), rendered by
// `PaletteLayer` while open and prefetched when the page is idle.
//   - Search follows 03 §12: the input element is never re-rendered, results update on every `input` (also while
//     composing, test 11), Enter uses the `commitOnly` rule (the Enter that commits a composition only commits; the
//     next one runs the item), keys during a composition are ignored.
//   - Modal (11장): focus stays in the box, Esc or the backdrop close it, focus goes back to the opener; other global
//     shortcuts do not fire under it (Ctrl+K itself closes it). It is portaled to <body> with role=dialog, so the
//     native browser pane hides itself while they overlap (4.7.2).
//   - Long lists (every loaded session) are windowed: fixed row heights, only the rows in view are in the DOM (R2).
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { createImeEnter, isImeKey } from "@/ime/ime-enter"
import { chordLabel, chordOf, eventCode, useShortcuts } from "@/keyboard"
import { normalizeChord } from "@/keyboard/chord"
import { inputSampler } from "@/perf/event-timing"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher"
import { sessionIdCommand, useBuiltinCommands, useSessionCommands } from "./builtin"
import type { PaletteOpen } from "./control"
import { prepareEntries, rankRows, type Row } from "./rank"
import { recentCommands, rememberCommand } from "./recent"
import { paletteSources, type PaletteCommand } from "./registry"
import { usePaletteText } from "./strings"
import "./palette.css"

const ITEM_HEIGHT = 36
const HEADER_HEIGHT = 26
const OVERSCAN = 6
const PAGE = 8
/** Fallback list height until the element was measured once (CSS max-height). */
const LIST_MAX = 420

export default function Palette(props: { readonly request: PaletteOpen; readonly onClose: () => void }) {
  const i18n = useI18n()
  const text = usePaletteText()
  const router = useRouter()
  const registry = useShortcuts()
  const builtin = useBuiltinCommands()
  const sessions = useSessionCommands()
  const recent = recentCommands()
  const [query, setQuery] = createSignal(props.request.query ?? "")
  const [active, setActive] = createSignal(0)
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewport, setViewport] = createSignal(LIST_MAX)
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  let root: HTMLDivElement | undefined

  const entries = createMemo(() => prepareEntries([...builtin(), ...external(), ...sessions()]))
  const rows = createMemo<Row[]>(() => {
    const ranked = rankRows(entries(), query(), { recent })
    // A pasted id of a session the loaded list does not have: offer to open it directly.
    const pasted = sessionIdCommand(query(), i18n.locale(), (route) => router.navigate(route))
    if (!pasted || entries().some((entry) => entry.command.keywords?.[0] === query().trim())) return ranked
    return [{ kind: "item", command: pasted, positions: [] }, ...ranked]
  })
  const items = createMemo(() => rows().flatMap((row, index) => (row.kind === "item" ? [index] : [])))
  const offsets = createMemo(() => {
    const list = rows()
    const result = new Float64Array(list.length + 1)
    list.forEach((row, index) => {
      result[index + 1] = result[index]! + (row.kind === "header" ? HEADER_HEIGHT : ITEM_HEIGHT)
    })
    return result
  })
  const visible = createMemo(() => {
    const top = scrollTop()
    const bounds = offsets()
    const count = rows().length
    const first = Math.max(0, rowAt(bounds, top) - OVERSCAN)
    const last = Math.min(count, rowAt(bounds, top + viewport()) + OVERSCAN + 1)
    return Array.from({ length: Math.max(0, last - first) }, (_, offset) => first + offset)
  })
  const activeRow = () => items()[active()]
  const activeCommand = () => {
    const index = activeRow()
    const row = index === undefined ? undefined : rows()[index]
    return row?.kind === "item" ? row.command : undefined
  }
  const optionID = (index: number) => `own-palette-option-${index}`

  // A new query starts at its first result, scrolled to the top. (Rows that change under the user, like a session
  // turning busy, keep the position.)
  createEffect(
    on(
      query,
      () => {
        setActive(0)
        if (list) list.scrollTop = 0
        setScrollTop(0)
      },
      { defer: true },
    ),
  )
  // Rows that went away: keep the active index inside the list.
  createEffect(() => {
    const count = items().length
    if (active() >= count) setActive(Math.max(0, count - 1))
  })

  const ime = createImeEnter({ commitOnly: true, onEnter: () => run(activeCommand()) })

  function run(command: PaletteCommand | undefined) {
    if (!command) return
    rememberCommand(command.id)
    props.onClose()
    // After the dialog is gone and focus is back on the opener: the command may move focus itself.
    nextFrame(() => {
      Promise.resolve()
        .then(() => command.run())
        .catch((error: unknown) => {
          console.error("[own-web] palette command failed", command.id, error)
          showToast({ message: text("own.palette.failed"), tone: "danger" })
        })
    })
  }

  /** Arrows wrap around at the ends; Page Up/Down stop there. */
  function move(delta: number) {
    const count = items().length
    if (!count) return
    const current = active()
    const wrap = (delta === 1 && current === count - 1) || (delta === -1 && current === 0)
    setActive(wrap ? (delta === 1 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, current + delta)))
    reveal()
  }

  /** Scrolls the active row into view from the known offsets (no layout read). */
  function reveal() {
    const index = activeRow()
    if (index === undefined || !list) return
    const bounds = offsets()
    // Keep the group header above the first item of a group visible too.
    const top = bounds[index > 0 && rows()[index - 1]?.kind === "header" ? index - 1 : index]!
    const bottom = bounds[index + 1]!
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + viewport()) list.scrollTop = bottom - viewport()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (ime.keydown(event)) return inputSampler.record(event)
    const code = eventCode(event)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const delta =
      code === "ArrowDown" ? 1 : code === "ArrowUp" ? -1 : code === "PageDown" ? PAGE : code === "PageUp" ? -PAGE : 0
    if (delta) {
      event.preventDefault()
      move(delta)
    }
    // Focus stays in the search box (the list is not tabbable; options are reached with the arrows).
    if (code === "Tab") event.preventDefault()
    inputSampler.record(event)
  }

  // Modal: no global shortcut fires under the palette. Keys of the keymap are also kept from the browser (Ctrl+P
  // would print); Ctrl+K reaches the registry and closes the palette.
  const keymapChords = createMemo(
    () => new Set(Object.values(registry.keymap).flatMap((definition) => definition.chords.map(normalizeChord))),
  )
  function contain(event: KeyboardEvent) {
    if (isImeKey(event)) return event.stopPropagation()
    const chord = chordOf(event)
    if (registry.keymap["palette.open"].chords.some((item) => normalizeChord(item) === chord)) return
    if (chord && keymapChords().has(chord)) event.preventDefault()
    event.stopPropagation()
  }

  onMount(() => {
    if (input) {
      input.value = props.request.query ?? ""
      input.focus()
      input.select()
    }
    const measure = () => {
      if (list?.clientHeight) setViewport(list.clientHeight)
    }
    nextFrame(measure)
    window.addEventListener("resize", measure)
    root?.addEventListener("keydown", contain)
    onCleanup(() => {
      window.removeEventListener("resize", measure)
      root?.removeEventListener("keydown", contain)
    })
  })

  return (
    <Portal>
      <div
        class="own-pal-scrim"
        data-own-overlay=""
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) props.onClose()
        }}
      >
        <div
          ref={root}
          class="own-pal"
          role="dialog"
          aria-modal="true"
          aria-label={text("own.palette.title")}
          data-testid="palette"
          data-own-keys="palette"
        >
          <label class="own-pal-search">
            <span class="own-sr-only">{text("own.palette.title")}</span>
            <input
              ref={input}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="own-palette-list"
              aria-autocomplete="list"
              aria-activedescendant={activeRow() === undefined ? undefined : optionID(activeRow()!)}
              placeholder={text("own.palette.placeholder")}
              autocomplete="off"
              spellcheck={false}
              data-testid="palette-input"
              on:keydown={onKeyDown}
              on:keyup={(event) => ime.keyup(event)}
              on:compositionstart={(event) => {
                ime.compositionstart()
                inputSampler.record(event)
              }}
              on:compositionend={(event) => {
                ime.compositionend()
                inputSampler.record(event)
              }}
              on:input={(event) => {
                ime.input()
                // Results only: the input element itself is never re-rendered (03 §12 rule 5).
                setQuery(event.currentTarget.value)
                inputSampler.record(event)
              }}
            />
          </label>
          <div
            ref={list}
            id="own-palette-list"
            class="own-pal-list"
            role="listbox"
            aria-label={text("own.palette.title")}
            data-testid="palette-list"
            data-count={items().length}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            // Clicking a row must not take focus from the search box (the composition and caret stay).
            onMouseDown={(event) => event.preventDefault()}
          >
            <div class="own-pal-space" style={{ height: `${offsets()[rows().length]}px` }}>
              <For each={visible()}>
                {(index) => (
                  <Show when={rows()[index]}>
                    {(row) => (
                      <PaletteRow
                        row={row()}
                        index={index}
                        top={offsets()[index]!}
                        active={activeRow() === index}
                        searching={!!query().trim()}
                        optionID={optionID(index)}
                        chord={(id) => registry.keymap[id].chords[0]}
                        onPoint={() => {
                          const position = items().indexOf(index)
                          if (position >= 0 && position !== active()) setActive(position)
                        }}
                        onRun={run}
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
          </div>
          <Show when={query().trim() && !items().length}>
            <p class="own-pal-empty" data-testid="palette-empty">
              {text("own.palette.empty", { query: query().trim() })}
            </p>
          </Show>
          <div class="own-pal-foot" aria-hidden="true">
            {text("own.palette.hint")}
          </div>
          <div class="own-sr-only" aria-live="polite">
            <Show when={query().trim()}>{text("own.palette.count", { n: items().length })}</Show>
          </div>
        </div>
      </div>
    </Portal>
  )
}

function PaletteRow(props: {
  readonly row: Row
  readonly index: number
  readonly top: number
  readonly active: boolean
  readonly searching: boolean
  readonly optionID: string
  readonly chord: (id: NonNullable<PaletteCommand["shortcut"]>) => string | undefined
  readonly onPoint: () => void
  readonly onRun: (command: PaletteCommand) => void
}) {
  const text = usePaletteText()
  return (
    <Show
      when={props.row.kind === "item" ? props.row : undefined}
      fallback={
        <div class="own-pal-header" role="presentation" style={{ top: `${props.top}px`, height: `${HEADER_HEIGHT}px` }}>
          {props.row.kind === "header" ? text(`own.palette.group.${props.row.group}`) : ""}
        </div>
      }
    >
      {(item) => {
        const chord = () => (item().command.shortcut ? props.chord(item().command.shortcut!) : undefined)
        return (
          <div
            id={props.optionID}
            class="own-pal-item"
            role="option"
            aria-selected={props.active}
            data-active={props.active ? "" : undefined}
            data-testid="palette-item"
            data-id={item().command.id}
            data-group={item().command.group}
            style={{ top: `${props.top}px`, height: `${ITEM_HEIGHT}px` }}
            onPointerMove={() => props.onPoint()}
            onClick={() => props.onRun(item().command)}
          >
            <span class="own-pal-title">
              <Highlight text={item().command.title} positions={item().positions} />
            </span>
            <Show when={item().command.detail}>
              <span class="own-pal-detail">{item().command.detail}</span>
            </Show>
            <span class="own-pal-end">
              <Show when={props.searching}>
                <span class="own-pal-group">{text(`own.palette.group.${item().command.group}`)}</span>
              </Show>
              <Show when={chord()}>{(value) => <kbd class="own-pal-kbd">{chordLabel(value())}</kbd>}</Show>
            </span>
          </div>
        )
      }}
    </Show>
  )
}

function Highlight(props: { readonly text: string; readonly positions: readonly number[] }) {
  const parts = createMemo(() => {
    if (!props.positions.length) return [{ text: props.text, hit: false }]
    const hits = new Set(props.positions)
    const result: { text: string; hit: boolean }[] = []
    for (let index = 0; index < props.text.length; index++) {
      const hit = hits.has(index)
      const last = result.at(-1)
      if (last && last.hit === hit) last.text += props.text[index]
      else result.push({ text: props.text[index]!, hit })
    }
    return result
  })
  return <For each={parts()}>{(part) => (part.hit ? <mark class="own-pal-hit">{part.text}</mark> : part.text)}</For>
}

/** Index of the row that contains `y` (binary search over the prefix offsets). */
function rowAt(offsets: Float64Array, y: number) {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle + 1]! <= y) low = middle + 1
    else high = middle
  }
  return low
}

/** Sources other modules registered; a failing source is skipped, never the whole palette. */
function external(): PaletteCommand[] {
  return paletteSources().flatMap((source) => {
    try {
      return [...source()]
    } catch (error) {
      console.error("[own-web] palette source failed", error)
      return []
    }
  })
}
