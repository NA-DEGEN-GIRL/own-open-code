// Windowed tree (03 §11 `role="tree"`, §20.2 R2/R7) inside the sidebar's one scroll area (./scroller.ts). Rows have
// fixed heights per kind, so offsets are exact prefix sums: no per-row measuring, no ResizeObserver per row, and
// scrolling only changes which keys are rendered. Below the threshold every row renders (screen readers and
// find-in-page see the whole list); above it only the rows in view plus an overscan, between two spacers. `<For>` over
// string keys keeps row components across list changes.
// Keyboard: roving tabindex, ↑/↓/Home/End move, →/← open/close or go to the parent, Enter/Space activate.
import { createEffect, createMemo, createSelector, createSignal, For, on, type Accessor, type JSX } from "solid-js"
import { nextFrame } from "@/data/frame"
import { isFocusable, offsetsOf, rangeOf } from "./model"
import { useScroller } from "./scroller"

const OVERSCAN_PX = 480
/** Load the next page when the bottom of the list is this close (infinite list, 03 §3 `cursor`). */
const NEAR_END_PX = 400

export interface TreeApi {
  /** The single row that is in the tab order (roving tabindex). */
  readonly isTabStop: (key: string) => boolean
  /** Moves focus to a row, scrolling it into the window first. */
  focus(key: string): void
  focusFirst(): void
  /** Scrolls a row into view without moving focus (route changes, Alt+↑/↓). */
  reveal(key: string): void
}

export interface TreeProps {
  readonly keys: Accessor<readonly string[]>
  readonly height: (key: string) => number
  readonly virtual: Accessor<boolean>
  readonly label: string
  /** The row that is tab stop when focus has not been in the tree yet (the open session). */
  readonly activeKey: Accessor<string | undefined>
  readonly row: (key: string, tree: TreeApi) => JSX.Element
  /** Keys currently in the DOM (bindings are loaded for these). */
  readonly onRendered?: (keys: readonly string[]) => void
  readonly onNearEnd?: () => void
  /** The sticky section header over the tree, which a revealed row must not end up under. */
  readonly top?: () => number
  /** →/←: open or close the row; return true when something changed. */
  readonly onExpand?: (key: string, open: boolean) => boolean
  readonly parentOf?: (key: string) => string | undefined
  readonly ref?: (api: TreeApi) => void
  readonly testId?: string
}

export function WindowedTree(props: TreeProps) {
  let container!: HTMLDivElement
  const scroller = useScroller()
  /** Where the tree starts in the scroll area; kept while it is windowed. */
  const [start, setStart] = createSignal(0)
  const [focusKey, setFocusKey] = createSignal<string>()

  const offsets = createMemo(() => offsetsOf(props.keys().map(props.height)))
  const total = () => {
    const values = offsets()
    return values[values.length - 1] ?? 0
  }
  const range = createMemo<readonly [number, number]>(
    () => {
      const count = props.keys().length
      if (!props.virtual()) return [0, count]
      const top = scroller.top() - start()
      return rangeOf(offsets(), top - OVERSCAN_PX, top + scroller.height() + OVERSCAN_PX)
    },
    [0, 0],
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  )
  const shown = createMemo(() => {
    const [start, end] = range()
    const keys = props.keys()
    return start === 0 && end === keys.length ? keys : keys.slice(start, end)
  })
  const before = () => (props.virtual() ? (offsets()[range()[0]] ?? 0) : 0)
  const after = () => (props.virtual() ? total() - (offsets()[range()[1]] ?? total()) : 0)

  const tabStop = createMemo(() => {
    const keys = props.keys()
    const focused = focusKey()
    if (focused && keys.includes(focused)) return focused
    const active = props.activeKey()
    if (active && keys.includes(active)) return active
    return keys.find(isFocusable)
  })
  const isTabStop = createSelector(tabStop)

  function reveal(key: string) {
    const index = props.keys().indexOf(key)
    const element = scroller.element()
    // A folded section's rows have no place to scroll to.
    if (index < 0 || !element || !container.offsetParent) return
    const from = container.offsetTop
    const top = from + (offsets()[index] ?? 0) - (props.top?.() ?? 0)
    const bottom = from + (offsets()[index + 1] ?? 0)
    const current = element.scrollTop
    if (top < current) return scroller.to(top)
    if (bottom > current + element.clientHeight) scroller.to(bottom - element.clientHeight)
  }

  function focus(key: string) {
    setFocusKey(key)
    reveal(key)
    nextFrame(() => rowElement(key)?.focus({ preventScroll: true }))
  }

  function rowElement(key: string) {
    return container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
  }

  const api: TreeApi = {
    isTabStop,
    focus,
    focusFirst() {
      const key = tabStop()
      if (key) focus(key)
    },
    reveal,
  }
  props.ref?.(api)

  createEffect(
    on([() => props.virtual(), scroller.content], ([virtual]) => {
      if (virtual) setStart(container.offsetTop)
    }),
  )
  createEffect(on(shown, (keys) => props.onRendered?.(keys)))
  createEffect(() => {
    const content = scroller.content()
    if (content > 0 && scroller.top() + scroller.height() >= content - NEAR_END_PX) props.onNearEnd?.()
  })

  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-key]") : null
    const key = target?.dataset.key
    if (!target || !key) return
    const list = props.keys().filter(isFocusable)
    const index = list.indexOf(key)
    const move = (next: string | undefined) => {
      if (next) focus(next)
    }
    switch (event.code) {
      case "ArrowDown":
        move(list[index + 1])
        break
      case "ArrowUp":
        move(list[index - 1])
        break
      case "Home":
        move(list[0])
        break
      case "End":
        move(list.at(-1))
        break
      case "ArrowRight":
        props.onExpand?.(key, true)
        break
      case "ArrowLeft":
        if (!props.onExpand?.(key, false)) move(props.parentOf?.(key))
        break
      case "Space":
      case "Enter":
        // Anchors follow Enter natively; everything else (project headers, "more") acts on click.
        if (event.code === "Enter" && target instanceof HTMLAnchorElement) return
        target.click()
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div
      ref={container}
      role="tree"
      aria-label={props.label}
      class="px-2"
      // A window replaces rows at its edges while scrolling: the browser must not anchor on them.
      style={{ "overflow-anchor": props.virtual() ? "none" : undefined }}
      data-testid={props.testId}
      data-virtual={props.virtual() ? "true" : "false"}
      onKeyDown={onKeyDown}
      onFocusIn={(event) => {
        const key =
          event.target instanceof Element ? event.target.closest<HTMLElement>("[data-key]")?.dataset.key : undefined
        if (key) setFocusKey(key)
      }}
    >
      <div aria-hidden="true" style={{ height: `${before()}px` }} />
      <For each={shown()}>{(key) => props.row(key, api)}</For>
      <div aria-hidden="true" style={{ height: `${after()}px` }} />
    </div>
  )
}
