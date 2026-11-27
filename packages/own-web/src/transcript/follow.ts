// Follow-the-tail state and history paging of one session view (the subset of upstream
// `packages/app/src/session/timeline/interaction.ts` the vendored virtualizer needs). `pinned` is the single source
// of "follow the newest content"; the virtualizer pins and unpins it from scroll geometry and user input, so a user
// who scrolls up while a turn streams is never pulled back down (PF4). Scroll-state updates run at most once per
// frame, read after the frame is rendered (03 §20.2 R3, R7).
import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

/** Distance from the top that asks for older messages. */
const HISTORY_EDGE = 200

export function createFollow(input: {
  readonly ready: Accessor<boolean>
  readonly more: Accessor<boolean>
  readonly loading: Accessor<boolean>
  readonly loadOlder: () => Promise<void>
}) {
  const [state, setState] = createStore({
    pinned: true,
    scroll: { overflow: false, jump: false },
    refs: { scroller: undefined as HTMLDivElement | undefined, content: undefined as HTMLDivElement | undefined },
  })
  let scrollToEnd = () => {}
  let stateFrame: (() => void) | undefined
  let stateTarget: HTMLDivElement | undefined
  let fillFrame: (() => void) | undefined
  let continueFrame: number | undefined
  let requesting = false

  const pin = () => setState("pinned", true)
  const unpin = () => {
    const scroller = state.refs.scroller
    if (!scroller || scroller.scrollHeight - scroller.clientHeight <= 1) return
    setState("pinned", false)
  }
  const updateScrollState = (element: HTMLDivElement) => {
    const max = element.scrollHeight - element.clientHeight
    const overflow = max > 1
    const jump = overflow && max - element.scrollTop > Math.max(400, element.clientHeight)
    if (state.scroll.overflow === overflow && state.scroll.jump === jump) return
    setState("scroll", { overflow, jump })
  }
  const scheduleScrollState = (element: HTMLDivElement) => {
    stateTarget = element
    if (stateFrame !== undefined) return
    stateFrame = afterFrame(() => {
      stateFrame = undefined
      const target = stateTarget
      stateTarget = undefined
      if (target) updateScrollState(target)
    })
  }

  async function loadOlder() {
    if (requesting || input.loading() || !input.more()) return
    requesting = true
    try {
      await input.loadOlder()
    } finally {
      requesting = false
    }
    const scroller = state.refs.scroller
    if (state.pinned || !scroller || scroller.scrollTop >= HISTORY_EDGE || !input.more()) return
    if (continueFrame !== undefined) cancelAnimationFrame(continueFrame)
    continueFrame = requestAnimationFrame(() => {
      continueFrame = undefined
      onHistoryScroll()
    })
  }
  function onHistoryScroll() {
    const scroller = state.refs.scroller
    if (requesting || input.loading() || state.pinned || !scroller || scroller.scrollTop >= HISTORY_EDGE) return
    void loadOlder().catch(() => undefined)
  }
  /** A short tail that does not fill the viewport pulls older pages until it does. */
  const fill = () => {
    if (fillFrame !== undefined) return
    fillFrame = afterFrame(() => {
      fillFrame = undefined
      const scroller = state.refs.scroller
      if (!input.ready() || !state.pinned || input.loading() || !scroller) return
      if (scroller.scrollHeight > scroller.clientHeight + 1 || !input.more()) return
      void loadOlder().catch(() => undefined)
    })
  }

  // The composer growing or the window resizing shrinks the viewport: keep following the tail.
  observe(
    () => state.refs.scroller,
    () => {
      const scroller = state.refs.scroller
      if (!scroller) return
      // Next frame, not inside the observer: re-pinning resizes the list and would loop the observer.
      if (state.pinned) requestAnimationFrame(() => state.pinned && scrollToEnd())
      scheduleScrollState(scroller)
      fill()
    },
  )
  observe(
    () => state.refs.content,
    () => {
      const scroller = state.refs.scroller
      if (scroller) scheduleScrollState(scroller)
      fill()
    },
  )
  onCleanup(() => {
    stateFrame?.()
    fillFrame?.()
    if (continueFrame !== undefined) cancelAnimationFrame(continueFrame)
  })

  return {
    scroller: () => state.refs.scroller,
    pinned: () => state.pinned,
    scroll: () => state.scroll,
    pin,
    unpin,
    fill,
    onHistoryScroll,
    scheduleScrollState,
    resume() {
      pin()
      scrollToEnd()
      const scroller = state.refs.scroller
      if (scroller) scheduleScrollState(scroller)
    },
    setScrollRef(element: HTMLDivElement | undefined) {
      setState("refs", "scroller", element)
      if (!element) return
      scheduleScrollState(element)
      fill()
    },
    setContentRef(element: HTMLDivElement | undefined) {
      setState("refs", "content", element)
    },
    setScrollToEnd(fn: () => void) {
      scrollToEnd = fn
    },
    /** Selecting text while following would fight the selection: stop following. */
    selectionInteraction() {
      const selection = window.getSelection()
      if (selection && selection.toString().length > 0) unpin()
    },
  }
}

/** ResizeObserver on a reactive element; the callback runs once per observer delivery. */
function observe(element: Accessor<Element | undefined>, callback: () => void) {
  createEffect(() => {
    const target = element()
    if (!target) return
    const observer = new ResizeObserver(() => callback())
    observer.observe(target)
    onCleanup(() => observer.disconnect())
  })
}

/**
 * Runs `fn` right after the next frame is rendered, when layout is clean: reading scroll geometry there costs nothing,
 * while the same read inside a rAF callback forces the frame's layout early, next to the row mounts (R7).
 */
function afterFrame(fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(fn, 0)
  })
  return () => {
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}
