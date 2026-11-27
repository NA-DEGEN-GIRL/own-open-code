// Vendored from packages/app/src/session/timeline/virtualizer.tsx @ bd55d4895f (MIT). See own/ledger/vendored.yaml
// Local changes (marked `own:`): generic row type with `rowKey` and row predicates instead of session-ui
// `TimelineRow` (own-web adds turn-footer rows), own-web i18n instead of `@/runtime/i18n/language`, a header height
// input instead of the fixed 64 px, no workspace-session attributes, and a hidden 맨 아래로 button that takes no clicks.
import {
  createVirtualizer,
  defaultRangeExtractor,
  elementScroll,
  observeElementRect,
  type Range,
  type VirtualItem,
} from "@tanstack/solid-virtual"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner, ScrollView } from "@opencode/ui/scroll-view"
import { useI18n } from "@/i18n"
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { observeElementOffsetReconnectAware } from "./observe-element-offset"
import { filterVirtualIndexes } from "./virtual-items"

const fallbackItemSize = 60
const pendingMarkdown = '[data-component="markdown"]:not([data-markdown-ready])'
// Distance from the bottom that counts as "at the end". Deliberately tight: a collapse clamps
// exactly to the end, while a one-pixel nudge upward is a deliberate move away from it.
const endEpsilon = 0.5
// Chrome rounds scrollHeight and clientHeight to whole pixels but scrolls in zoomed ones, so under page zoom (down to
// 25%) the furthest offset it reaches can sit up to 4px short of scrollHeight - clientHeight.
const zoomSlack = 4
const upwardKeys = new Set(["up", "page-up", "home"])
const cache = new Map<
  string,
  {
    measurements: VirtualItem[]
    toolOpen: Record<string, boolean | undefined>
    patchGroupKeys: Map<string, string>
    presentationKey?: string
  }
>()

// own: the rows the virtualizer lays out, with the indexes it needs; upstream picked these from session-ui's
// projection, own-web passes its own row list (projection rows plus turn footers).
type Projection<Row> = {
  activeMessageID: Accessor<string | undefined>
  messageLastRowIndex: Accessor<Map<string, number>>
  messageRowIndex: Accessor<Map<string, number>>
  rowByKey: Accessor<Map<string, Row>>
  rows: Accessor<Row[]>
}

type Input<Row> = {
  /** own: stable identity of a row across projections (upstream `TimelineRow.key`). */
  rowKey: (row: Row) => string
  /** own: spacer rows keep `overflow-clip-margin` unset (upstream `TurnGap`). */
  isGap?: (row: Row) => boolean
  /** own: an optimistic user row pins the tail on mount (upstream `UserMessage`). */
  isUserMessage?: (row: Row) => boolean
  /** own: row index of an assistant part, for `revealMessage(id, partID)`. */
  partIndex?: (partID: string) => number
  /** own: height of `header` when shown (upstream fixed 64 px). */
  headerHeight?: number
  active?: Accessor<boolean>
  sessionKey: Accessor<string>
  presentationKey?: Accessor<string>
  projection: Projection<Row>
  showHeader: Accessor<boolean>
  /** True while the timeline follows the newest content. Drives every anchoring decision. */
  pinned: Accessor<boolean>
  scroll: Accessor<{ overflow: boolean; jump: boolean }>
  onResumeScroll: () => void
  setScrollRef: (element: HTMLDivElement | undefined) => void
  setContentRef: (element: HTMLDivElement) => void
  onScheduleScrollState: (element: HTMLDivElement) => void
  onPin: () => void
  onUnpin: () => void
  onSelectionInteraction: (event: MouseEvent) => void
  onUserScroll: (target?: EventTarget | null) => void
  onHistoryScroll: () => void
  canRenderImmediately?: (row: Row, disclosed: (key: string) => boolean | undefined) => boolean
  setRevealMessage?: (fn: (id: string, partID?: string) => void) => void
  setScrollToEnd?: (fn: () => void) => void
}

type ViewProps<Row> = {
  header: JSX.Element
  bottomSpacer?: JSX.Element
  deferred: (row: Row) => boolean
  renderRow: (row: Accessor<Row>, onSizeChange?: () => void) => JSX.Element
}

export function createTimelineVirtualizer<Row>(input: Input<Row>) {
  const i18n = useI18n()
  const active = () => input.active?.() !== false
  // own: the 16 px top spacer is shown at every width (own-web pads the transcript itself).
  const topOffset = () => (input.showHeader() ? (input.headerHeight ?? 64) : 16)
  const ownerSessionKey = input.sessionKey()
  const entry = cache.get(ownerSessionKey)
  const cached = entry?.presentationKey === input.presentationKey?.() ? entry : undefined
  const initialMeasurements = cached?.measurements
  const coldBottomMount = !initialMeasurements?.length && input.pinned()
  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  // own: a key nobody set is read behind one signal. Solid's store keeps a signal for every key read in a tracking
  // scope, and every row of a long transcript reads its own key: thousands of keys that are never set (2026-11
  // renderer memory bench).
  const [keysAdded, setKeysAdded] = createSignal(0)
  const disclosed = (key: string) => {
    if (untrack(() => !(key in toolOpen))) return void keysAdded()
    return toolOpen[key]
  }
  const patchGroupKeys = cached?.patchGroupKeys ?? new Map<string, string>()
  createEffect(
    on(
      () => input.presentationKey?.(),
      () => setToolOpen(reconcile({})),
      { defer: true },
    ),
  )
  const [rendering, setRendering] = createStore({ initialTail: coldBottomMount, scrollAdjustment: 0 })
  const rows = input.projection.rows
  const rowByKey = input.projection.rowByKey
  const rowKeys = createMemo(() => rows().map(input.rowKey), undefined, {
    equals: (previous, next) => previous.length === next.length && previous.every((key, index) => key === next[index]),
  })
  const knownKeys = new Set(rowKeys())
  const addedKeys = new Set<string>()
  const getItemKey = createMemo(() => {
    const keys = rowKeys()
    // own: rows that left the list are forgotten, so a row that comes back counts as added again: a long transcript's
    // window and its dropped pages pass every row of the session through here (both sets grew by every row key seen).
    const current = new Set(keys)
    knownKeys.forEach((key) => current.has(key) || knownKeys.delete(key))
    addedKeys.forEach((key) => current.has(key) || addedKeys.delete(key))
    keys
      .filter((key) => !knownKeys.has(key))
      .forEach((key) => {
        knownKeys.add(key)
        addedKeys.add(key)
      })
    return (index: number) => keys[index] ?? `removed:${index}`
  })
  const rangeExtractor = createMemo(() => {
    const id = input.projection.activeMessageID()
    const active = id ? (input.projection.messageLastRowIndex().get(id) ?? -1) : -1
    const initialTail = rendering.initialTail && input.pinned()
    return (range: Range) => {
      // Batch a bounded cheap suffix, but stop before unknown/large content.
      // A large tail still mounts alone before estimates expose earlier history.
      const start = Math.max(0, range.startIndex - 2)
      const boundary = initialTail
        ? rows()
            .slice(start, range.count)
            // own: the collapsed-context-group case moved into `canRenderImmediately`.
            .findLastIndex((row) => !input.canRenderImmediately?.(row, disclosed))
        : -1
      const first = Math.min(range.count - 1, start + boundary + 1)
      const indexes = initialTail
        ? Array.from({ length: range.count - first }, (_, index) => first + index)
        : defaultRangeExtractor({ ...range, overscan: 2 })
      return filterVirtualIndexes(
        [...new Set([...indexes, ...(active < 0 ? [] : [active])])].sort((a, b) => a - b),
        range.count,
      )
    }
  })
  const measuredElements = new WeakSet<Element>()
  let touchStart: number | undefined
  let touchTarget: EventTarget | null = null
  let touchNested = false
  let touchScrolling = false
  let touchAdjustment = 0
  let pointerHeld = false
  let maxScroll = 0
  let virtualContent: HTMLDivElement | undefined
  let scrollTop = 0
  // A scroll arrived within the zoom slack of the end and may have reached it.
  let endPending = false
  let reportOffset: ((offset: number, scrolling: boolean) => void) | undefined
  let reportRect: ((rect: { width: number; height: number }) => void) | undefined
  let batchingColdSizes = false

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rows().length
    },
    getScrollElement: () => listRoot() ?? null,
    observeElementRect: (instance, callback) => {
      reportRect = callback
      return observeElementRect(instance, (rect) => {
        if (active()) callback(rect)
      })
    },
    // Route navigation detaches and reattaches the scroll element, which drops its offset.
    observeElementOffset: (instance, callback) => {
      reportOffset = (offset, scrolling) => {
        if (!active()) return
        // Rows and the sizer use the opposite translation while native touch
        // scrolling keeps its own offset. Range selection uses the logical offset.
        batch(() => {
          const logicalOffset = offset + rendering.scrollAdjustment
          callback(rendering.scrollAdjustment ? Math.max(0, logicalOffset) : offset, scrolling)
          // Reconcile both start boundaries in one native write. Gradually
          // clamping row translations lets the compositor paint between
          // corrections and makes the content oscillate at the top.
          const root = listRoot()
          if (
            rendering.scrollAdjustment !== 0 &&
            root &&
            (logicalOffset <= 0 || offset <= 0 || (touchStart !== undefined && offset <= root.clientHeight))
          )
            flushTouchAdjustment()
          if (!scrolling && touchStart === undefined) finishTouchScroll()
          if (scrolling || touchStart !== undefined || !endPending) return
          endPending = false
          if (root && !input.pinned() && atReachableEnd(root)) input.onPin()
        })
        settleColdBottom()
      }
      return observeElementOffsetReconnectAware(instance, reportOffset, () => {
        if (!active()) return
        virtualContent?.querySelectorAll<HTMLDivElement>("[data-index]").forEach(virtualizer.measureElement)
        if (input.pinned()) virtualizer.scrollToEnd()
        settleColdBottom()
      })
    },
    initialOffset: () => (input.pinned() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: () => fallbackItemSize,
    // A newly observed element gets a real ResizeObserver box before paint. Reuse
    // its snapshot on attachment, but later explicit measurements must read layout
    // so deferred/rewrapped content cannot keep stale, clipped heights (TanStack/virtual#1183).
    measureElement: (element, entry, instance) => {
      if (!active() || !element.isConnected)
        return (
          instance.itemSizeCache.get(instance.options.getItemKey(instance.indexFromElement(element))) ??
          fallbackItemSize
        )
      const initial = !measuredElements.has(element)
      measuredElements.add(element)
      const box = entry?.borderBoxSize[0]
      if (box) return Math.round(box.blockSize)
      if (initial) {
        const size = instance.itemSizeCache.get(instance.options.getItemKey(instance.indexFromElement(element)))
        if (size !== undefined || coldPending) return size ?? fallbackItemSize
      }
      return element.offsetHeight
    },
    scrollToFn: (offset, options, instance) => {
      if (!active()) return
      if (batchingColdSizes && input.pinned()) return
      setRendering("scrollAdjustment", 0)
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      return getItemKey()
    },
    get anchorTo() {
      return input.pinned() ? "end" : "start"
    },
    get followOnAppend() {
      return input.pinned()
    },
    scrollEndThreshold: 80,
    get scrollMargin() {
      // Empty projections still need the bottom spacer for running status.
      return rows().length > 0 ? topOffset() : 0
    },
    paddingEnd: 64,
    get rangeExtractor() {
      return rangeExtractor()
    },
  })
  // own: the measured sizes of rows that left the list are forgotten too (TanStack keeps every key it measured, and a
  // long transcript passes every row of the session through its window and dropped pages).
  createEffect(
    on(rowKeys, (keys) => {
      const current = new Set(keys)
      virtualizer.itemSizeCache.forEach((_, key) => current.has(String(key)) || virtualizer.itemSizeCache.delete(key))
    }),
  )
  const resizeItem = virtualizer.resizeItem
  const pendingSizes = new Map<number, { key: string; size: number }>()
  let resizeScheduled = false
  // Read the whole measurement delivery before committing reactive row sizes.
  // Otherwise each row can render and force layout before the next is measured.
  virtualizer.resizeItem = (index, size) => {
    if (!active()) return
    const row = rows()[index]
    if (!row) return
    const key = input.rowKey(row)
    if ((virtualizer.itemSizeCache.get(key) ?? fallbackItemSize) === size) {
      pendingSizes.delete(index)
      return
    }
    pendingSizes.set(index, { key, size })
    if (resizeScheduled) return
    resizeScheduled = true
    queueMicrotask(() => {
      resizeScheduled = false
      if (!pendingSizes.size) return
      const sizes = [...pendingSizes]
      pendingSizes.clear()
      if (!active()) return
      // The hidden pinned mount needs one bottom write after the whole batch,
      // not a layout-forcing scroll adjustment for every measured row.
      batchingColdSizes = coldPending && input.pinned()
      batch(() => {
        sizes.forEach(([index, value]) => {
          const row = rows()[index]
          if (!row || input.rowKey(row) !== value.key) return
          resizeItem(index, value.size)
          // TanStack recalculates its range after each resize. Advance the
          // logical fold before deciding whether the next row needs anchoring.
          if (!touchAdjustment) return
          setRendering("scrollAdjustment", (value) => value + touchAdjustment)
          touchAdjustment = 0
          const root = listRoot()
          if (root) reportOffset?.(root.scrollTop, virtualizer.isScrolling)
        })
      })
      batchingColdSizes = false
      if (coldPending) pinColdBottom()
      settleColdBottom()
      if (coldPending) return
      if (!input.pinned()) return
      const root = listRoot()
      // Reopening a settled scroll-to-end operation can fight subsequent keyboard scrolling.
      if (root && !atReachableEnd(root)) virtualizer.scrollToEnd()
    })
  }
  onCleanup(() => pendingSizes.clear())
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    // Prepended rows can resize more than once as deferred content mounts. Keep
    // compensating while they remain entirely above the visible content fold.
    const first = instance.range?.startIndex
    const adjust = addedKeys.has(String(item.key))
      ? item.end <= (instance.scrollOffset ?? 0) + instance.scrollAdjustments + instance.options.scrollMargin
      : first !== undefined && item.index < first
    if (!touchScrolling || input.pinned()) return adjust
    // iOS defers native scroll writes until momentum ends. Keep the same visual
    // anchor now, rather than moving rows now and snapping the viewport back later.
    if (adjust) touchAdjustment += delta
    return false
  }

  function finishTouchScroll() {
    touchScrolling = false
    flushTouchAdjustment()
  }

  function prepareNavigation() {
    if (touchStart === undefined) touchScrolling = false
    flushTouchAdjustment()
  }

  function flushTouchAdjustment() {
    const adjustment = rendering.scrollAdjustment
    const root = listRoot()
    if (!adjustment || !root) return
    // Transfer the translation into the native offset in the same paint.
    batch(() => {
      setRendering("scrollAdjustment", 0)
      if (virtualContent) virtualContent.style.height = `${virtualizer.getTotalSize()}px`
      elementScroll(Math.max(0, root.scrollTop + adjustment), {}, virtualizer)
    })
  }
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  // Upstream #64565 (792cf31f7f) in this copy's terms: TanStack lists the rows it last read, which one flush can replace
  // before it reads them again, so a listed key the projection dropped is not a row (its mount read an undefined row
  // and crashed the view); one row mounts per key.
  const virtualRowKeys = createMemo(() => [
    ...new Set(
      virtualizer
        .getVirtualItems()
        .map((item) => String(item.key))
        .filter((key) => rowByKey().has(key)),
    ),
  ])

  createEffect(() => {
    if (!active()) return
    const root = listRoot()
    if (root) input.setScrollRef(root)
    if (virtualContent) input.setContentRef(virtualContent)
    queueMicrotask(() => {
      if (!active() || !root?.isConnected) return
      // A detached view can miss its nonzero ResizeObserver delivery. Publish
      // its real viewport before restoring the offset and admitting rows.
      reportRect?.({ width: root.offsetWidth, height: root.offsetHeight })
      if (input.pinned()) virtualizer.scrollToEnd()
      reportOffset?.(root.scrollTop, false)
      settleColdBottom()
    })
    input.setRevealMessage?.((id, partID) => {
      if (!active()) return
      const partIndex = partID ? (input.partIndex?.(partID) ?? -1) : -1
      const index = partIndex >= 0 ? partIndex : input.projection.messageRowIndex().get(id)
      if (index === undefined) return
      prepareNavigation()
      virtualizer.scrollToIndex(index, { align: "center" })
    })
    input.setScrollToEnd?.(() => {
      if (!active() || !listRoot()?.isConnected) return
      prepareNavigation()
      input.onPin()
      virtualizer.scrollToEnd()
    })
  })

  let coldPending = coldBottomMount
  let settleQueued = false
  let contentObserver: MutationObserver | undefined
  let viewportObserver: ResizeObserver | undefined
  // Within the zoom slack only a write finds the end the browser reaches: one that does not move proves the view is
  // already there, and one that does is undone before anything paints.
  function atReachableEnd(root: HTMLDivElement) {
    const top = root.scrollTop
    const distance = root.scrollHeight - root.clientHeight - top
    if (distance <= endEpsilon) return true
    if (distance > zoomSlack) return false
    root.scrollTop = root.scrollHeight
    if (root.scrollTop === top) return true
    root.scrollTop = top
    return false
  }
  // Returns whether the view now rests at its end with that offset reported.
  const pinColdBottom = () => {
    if (!active()) return false
    const root = listRoot()
    if (!input.pinned() || !virtualContent || !root) return false
    // scrollToEnd computes its target from the DOM, not the new size cache.
    virtualContent.style.height = `${virtualizer.getTotalSize()}px`
    if (!atReachableEnd(root)) virtualizer.scrollToEnd()
    // Report after core size adjustments finish so they cannot apply a delta
    // twice. This avoids waiting a frame for the native scroll event.
    if (virtualizer.scrollOffset !== root.scrollTop) reportOffset?.(root.scrollTop, false)
    return true
  }
  const pendingMeasurements = () => {
    const items = virtualizer.getVirtualItems()
    return (
      (rows().length > 0 && items.length === 0) ||
      items.some((item) => !virtualizer.elementsCache.get(item.key)?.isConnected)
    )
  }
  const settleColdBottom = () => {
    if (!active() || !coldPending || settleQueued) return
    settleQueued = true
    queueMicrotask(() => {
      settleQueued = false
      const root = listRoot()
      if (!coldPending || !virtualContent?.isConnected || !root) return
      if (virtualContent.querySelector(pendingMarkdown)) return
      if (!root.clientHeight) return
      // Markdown can finish before ResizeObserver delivers its new box. The
      // normal measureElement path skips reads while scrolling; this gate needs
      // current boxes before expanding the estimated range or revealing it.
      virtualizer.elementsCache.forEach((element) => {
        if (element.isConnected) virtualizer.resizeItem(virtualizer.indexFromElement(element), element.offsetHeight)
      })
      if (pendingSizes.size || pendingMeasurements()) return
      const pinned = input.pinned()
      // A pinned view rests at the end pinColdBottom reaches. Under page zoom that end can be more than a pixel short
      // of scrollHeight - clientHeight, and TanStack keeps the offset it wrote rather than the one reached. Waiting
      // for either distance to close never ends: each pass reported the offset again, which queued the next pass as
      // a microtask, and the renderer froze.
      if (pinned && !pinColdBottom()) return
      // The scroll event must update the range before newly exposed rows can reveal.
      if (
        !pinned &&
        root.scrollHeight > root.clientHeight &&
        Math.abs((virtualizer.scrollOffset ?? 0) - root.scrollTop) > 1
      )
        return
      if (rendering.initialTail) {
        setRendering("initialTail", false)
        settleColdBottom()
        return
      }
      if (pendingSizes.size || pendingMeasurements() || virtualContent.querySelector(pendingMarkdown)) return
      coldPending = false
      contentObserver?.disconnect()
      viewportObserver?.disconnect()
      virtualContent.style.removeProperty("visibility")
    })
  }
  onMount(() => {
    if (!coldPending || !virtualContent) return
    contentObserver = new MutationObserver(settleColdBottom)
    contentObserver.observe(virtualContent, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-markdown-ready"],
    })
    viewportObserver = new ResizeObserver(settleColdBottom)
    const root = listRoot()
    if (root) viewportObserver.observe(root)
    settleColdBottom()
  })

  let measuredSessionKey = input.sessionKey()
  createEffect(() => {
    const key = input.sessionKey()
    if (measuredSessionKey !== key) {
      measuredSessionKey = key
      virtualizer.measure()
    }
  })

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    // TanStack owns anchoring; browser scroll anchoring would fight its adjustments.
    root.style.overflowAnchor = "none"
    setListRoot(root)
    scrollTop = root.scrollTop
    maxScroll = root.scrollHeight - root.clientHeight
    if (active()) input.setScrollRef(root)
    viewportObserver?.observe(root)
    settleColdBottom()
    // The scrollbar thumb sits beside the viewport and stops its pointerdown from propagating, so
    // listen on the ScrollView root in the capture phase: thumb drags are user scrolls too.
    const scrollView = root.parentElement
    if (!scrollView) return
    scrollView.addEventListener("pointerdown", handleListPointerDown, { capture: true })
    onCleanup(() => scrollView.removeEventListener("pointerdown", handleListPointerDown, { capture: true }))
  }

  // Upward input is the one intent geometry cannot recover: nudging up while still a pixel from
  // the end must stop following, even though the resulting position still looks like the end.
  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    input.onUserScroll(event.target)
    if (event.deltaY < 0) input.onUnpin()
  }

  const handleListTouchStart = (event: TouchEvent) => {
    clearTouchTarget()
    input.onUserScroll(event.target)
    touchScrolling = true
    touchStart = event.touches[0]?.clientY
    const root = listRoot()
    const nested = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-scrollable]") : null
    touchNested = !!nested && nested !== root && nested.scrollHeight > nested.clientHeight
    // Native touch events keep their original target, even when streaming or
    // virtualization detaches it. Listen there instead of relying on bubbling.
    touchTarget = event.target
    touchTarget?.addEventListener("touchmove", handleListTouchMove, { passive: true })
    touchTarget?.addEventListener("touchend", handleListTouchEnd, { passive: true })
    touchTarget?.addEventListener("touchcancel", handleListTouchEnd, { passive: true })
    if (root) reportOffset?.(root.scrollTop, virtualizer.isScrolling)
  }

  const handleListTouchMove = (event: Event) => {
    if (!(event instanceof TouchEvent)) return
    const current = event.touches[0]?.clientY
    if (current === undefined || touchStart === undefined) return
    const previous = touchStart
    touchStart = current
    // A retained target can outlive its whole session view. Only the active
    // timeline may change the shared follow state; release still cleans up below.
    if (!active()) return
    // Dragging the content downward reveals earlier messages.
    if (current <= previous) return
    // A nested scrollport owns the intent. If it chains into the timeline at a
    // boundary, the resulting native timeline scroll below will unpin instead.
    if (touchNested) return
    input.onUnpin()
  }

  const handleListTouchEnd = () => {
    clearTouchTarget()
    touchStart = undefined
    if (!virtualizer.isScrolling) finishTouchScroll()
  }

  function clearTouchTarget() {
    touchTarget?.removeEventListener("touchmove", handleListTouchMove)
    touchTarget?.removeEventListener("touchend", handleListTouchEnd)
    touchTarget?.removeEventListener("touchcancel", handleListTouchEnd)
    touchTarget = null
  }
  onCleanup(clearTouchTarget)

  // Drag-selecting past the edge and dragging the scrollbar both scroll without a wheel or key,
  // so a held pointer is what separates those from the virtualizer's own measurement adjustments.
  const handleListPointerDown = (event: PointerEvent) => {
    input.onUserScroll(event.target)
    pointerHeld = true
  }
  const releasePointer = () => {
    pointerHeld = false
  }
  onMount(() => {
    window.addEventListener("pointerup", releasePointer)
    window.addEventListener("pointercancel", releasePointer)
  })
  onCleanup(() => {
    window.removeEventListener("pointerup", releasePointer)
    window.removeEventListener("pointercancel", releasePointer)
  })

  const handleListKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const key = scrollKey(event)
    if (!key) return
    if (!isScrollKeyTarget(event.target, key)) return
    if (scrollKeyOwner(event.currentTarget, event.target, key) !== event.currentTarget) return
    input.onUserScroll(event.currentTarget)
    if (upwardKeys.has(key)) input.onUnpin()
  }

  // Following resumes by arriving at the end, either by scrolling there or by content shrinking
  // under a viewport that was already there. Merely resting near the end is not enough, otherwise
  // a later scroll would overwrite an upward intent expressed a pixel short of the bottom.
  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (!active()) return
    const root = event.currentTarget
    const previousTop = scrollTop
    const previousMaxScroll = maxScroll
    scrollTop = root.scrollTop
    maxScroll = root.scrollHeight - root.clientHeight
    const atEnd = maxScroll - scrollTop <= endEpsilon
    const arrived = scrollTop > previousTop + endEpsilon || maxScroll < previousMaxScroll
    if (scrollTop < previousTop) endPending = false
    if (maxScroll <= 1 || (atEnd && arrived)) input.onPin()
    else if ((pointerHeld || touchScrolling) && scrollTop < previousTop - endEpsilon) input.onUnpin()
    // Probing the zoomed end now would cancel a scroll still in motion, so it waits for the scroll to settle.
    else if (arrived && maxScroll - scrollTop <= zoomSlack) endPending = true
    settleColdBottom()
    input.onScheduleScrollState(root)
    input.onHistoryScroll()
  }

  function View(props: ViewProps<Row>) {
    function VirtualRow(rowProps: { rowKey: string }) {
      let element: HTMLDivElement
      const initialItem = virtualItemByKey().get(rowProps.rowKey)!
      const initialRow = rowByKey().get(rowProps.rowKey)!
      const item = createMemo(() => virtualItemByKey().get(rowProps.rowKey) ?? initialItem)
      const row = createMemo(() => rowByKey().get(rowProps.rowKey) ?? rows()[item().index] ?? initialRow)
      const [ready, setReady] = createSignal(initialItem.size <= fallbackItemSize || !props.deferred(initialRow))
      let contentMeasureFrame: number | undefined

      onMount(() => virtualizer.measureElement(element))
      // Prepending history changes data-index, not the keyed element's identity.
      // Its observer reads the current index and delivers any actual size change.
      onCleanup(() => {
        if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
        queueMicrotask(() => virtualizer.measureElement(null))
      })

      return (
        <div
          data-timeline-key={rowProps.rowKey}
          style={{
            position: "absolute",
            top: `${item().start - topOffset() - rendering.scrollAdjustment}px`,
            left: "0",
            width: "100%",
            height: `${item().size}px`,
            overflow: "clip",
            "overflow-clip-margin": input.isGap?.(row()) ? undefined : "0.5px",
          }}
        >
          <div
            ref={(value) => {
              element = value
              if (!input.isUserMessage?.(row()) || !addedKeys.has(rowProps.rowKey) || !input.pinned() || coldPending)
                return
              // The optimistic row can paint before ResizeObserver corrects the tail estimates.
              // Measure the mounted tail and pin it in this render's microtask instead.
              queueMicrotask(() => {
                if (!input.pinned() || !virtualContent?.isConnected) return
                virtualizer.elementsCache.forEach((item) => {
                  if (item.isConnected) virtualizer.resizeItem(virtualizer.indexFromElement(item), item.offsetHeight)
                })
                virtualizer.resizeItem(item().index, element.offsetHeight)
                virtualContent.style.height = `${virtualizer.getTotalSize()}px`
                virtualizer.scrollToEnd()
              })
            }}
            data-index={item().index}
            style={{ "min-height": ready() ? undefined : `${initialItem.size}px` }}
          >
            {props.renderRow(row, () => {
              setReady(true)
              if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
              contentMeasureFrame = requestAnimationFrame(() => {
                contentMeasureFrame = undefined
                if (active() && element.isConnected) virtualizer.measureElement(element)
              })
            })}
          </div>
        </div>
      )
    }

    return (
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 z-[60] pointer-events-none transition-all duration-200 ease-out"
          classList={{
            "bottom-8": true,
            "opacity-100 translate-y-0 scale-100": input.scroll().overflow && input.scroll().jump,
            "opacity-0 translate-y-2 pointer-events-none": !input.scroll().overflow || !input.scroll().jump,
            "scale-[0.8]": !input.scroll().overflow || !input.scroll().jump,
          }}
        >
          {/* own: while hidden the button takes no clicks or focus; it used to swallow clicks meant for the composer's
              popovers above it (pointer-events-auto under the hidden wrapper). Its test id gives touch screens a 44 px
              target (transcript.css, the S23 pass). */}
          <button
            type="button"
            aria-label={i18n.t("own.transcript.jumpToLatest")}
            data-testid="transcript-jump-latest"
            aria-hidden={input.scroll().overflow && input.scroll().jump ? undefined : "true"}
            tabIndex={input.scroll().overflow && input.scroll().jump ? undefined : -1}
            class="flex items-center justify-center w-8 h-7 px-2 py-1.5 rounded-lg border-none cursor-pointer text-v2-text-text-base backdrop-blur-[2px]"
            classList={{ "pointer-events-auto": input.scroll().overflow && input.scroll().jump }}
            style={{
              background: "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
              "box-shadow": "var(--v2-elevation-raised), 0px 2px 8px var(--v2-background-bg-base)",
            }}
            onClick={input.onResumeScroll}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
                stroke="currentColor"
                stroke-linecap="square"
              />
            </svg>
          </button>
        </div>
        <ScrollView
          data-slot="session-timeline-scroll"
          viewportRef={bindListRoot}
          onBeforeScroll={prepareNavigation}
          verticalScrollAdjustment={rendering.scrollAdjustment}
          onWheel={handleListWheel}
          onTouchStart={handleListTouchStart}
          onKeyDown={handleListKeyDown}
          onScroll={handleListScroll}
          onClick={input.onSelectionInteraction}
          class="relative min-w-0 w-full h-full"
          style={{ "--sticky-accordion-top": input.showHeader() ? "48px" : "0px" }}
        >
          <Show when={input.showHeader()} fallback={<div aria-hidden="true" class="h-4" />}>
            {props.header}
          </Show>
          <div
            data-timeline-virtual-content
            ref={(element) => {
              virtualContent = element
              if (active()) input.setContentRef(element)
            }}
            style={{
              height: `${virtualizer.getTotalSize() - rendering.scrollAdjustment}px`,
              position: "relative",
              width: "100%",
              visibility: coldBottomMount ? "hidden" : undefined,
            }}
          >
            <For each={virtualRowKeys()}>{(rowKey) => <VirtualRow rowKey={rowKey} />}</For>
            <div
              data-timeline-row="bottom-spacer"
              class="h-16 absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualizer.getTotalSize() - 64 - rendering.scrollAdjustment}px)` }}
            >
              {props.bottomSpacer}
            </div>
          </div>
        </ScrollView>
      </div>
    )
  }

  onCleanup(() => {
    cache.delete(ownerSessionKey)
    cache.set(ownerSessionKey, {
      measurements: virtualizer.takeSnapshot(),
      toolOpen: { ...toolOpen },
      patchGroupKeys,
      presentationKey: input.presentationKey?.(),
    })
    while (cache.size > 16) cache.delete(cache.keys().next().value!)
    coldPending = false
    contentObserver?.disconnect()
    viewportObserver?.disconnect()
    if (active()) {
      input.setScrollRef(undefined)
      input.setRevealMessage?.(() => {})
      input.setScrollToEnd?.(() => {})
    }
  })

  return {
    disclosure: {
      patchGroupKeys,
      value: disclosed,
      set: (key: string, open: boolean) => {
        const added = untrack(() => !(key in toolOpen))
        setToolOpen(key, open)
        if (added) setKeysAdded((count) => count + 1)
      },
    },
    View,
  }
}
