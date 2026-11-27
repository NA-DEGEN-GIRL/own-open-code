// In-page probes (serialized into the page by `page.evaluate`, so each function is self-contained). They observe
// the app from outside: window listeners, PerformanceObservers, rAF, and marker text inside the transcript. No
// probe touches app state, and none reads keys or text beyond the fixture markers (03 §20.2 R11 for the app;
// probes only run in benchmarks).

export interface InputProbeResult {
  readonly events: { type: string; start: number; end: number }[]
  readonly timings: {
    name: string
    startTime: number
    processingStart: number
    processingEnd: number
    duration: number
  }[]
}

export interface FrameProbeResult {
  readonly raf: number[]
  readonly longTasks: number[]
  /** Start of each long task, ms after the `ownb:measure:start` mark (to match a profile trace's tasks). */
  readonly longTaskStarts: number[]
  readonly longAnimationFrames: { duration: number; blocking: number }[]
}

export interface MarkerState {
  /** Markers whose text is visible inside the transcript's scroll viewport, by session tag. */
  readonly visible: Record<string, number>
  /** Specific markers asked for, and whether each is visible. */
  readonly wanted: Record<string, boolean>
  /** How many markers are in the DOM at all (virtualization keeps this bounded). */
  readonly mounted: number
  /** Earliest mounted turn per tag (paging progress while loading older history). */
  readonly earliest: Record<string, number>
  /** Whether each asked-for marker is in the DOM at all (visible or not). */
  readonly present: Record<string, boolean>
}

type ProbeWindow = Window & {
  __ownbInput?: InputProbeResult & { stop: () => void }
  __ownbFrames?: FrameProbeResult & { stop: () => void }
  __ownbSwitch?: { samples: { at: number; last: boolean; destination: number; source: number }[]; done: boolean }
}

/** PF2 targets (01 §6.6): keydown, beforeinput, composition*, input on the given element. */
export function installInputProbe(selector: string) {
  const host = window as ProbeWindow
  host.__ownbInput?.stop()
  const events: InputProbeResult["events"] = []
  const timings: InputProbeResult["timings"] = []
  const types = ["keydown", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]
  // Registered now (after the app booted), on window, bubble phase: runs after the app's element, document
  // (Solid delegation) and earlier window listeners, i.e. at the end of dispatch.
  const listener = (event: Event) => {
    if (!(event.target instanceof Element) || !event.target.matches(selector)) return
    events.push({ type: event.type, start: event.timeStamp, end: performance.now() })
  }
  types.forEach((type) => window.addEventListener(type, listener))
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceEventTiming[]) {
      if (!types.includes(entry.name)) continue
      if (entry.target && !(entry.target instanceof Element && entry.target.matches(selector))) continue
      timings.push({
        name: entry.name,
        startTime: entry.startTime,
        processingStart: entry.processingStart,
        processingEnd: entry.processingEnd,
        duration: entry.duration,
      })
    }
  })
  observer.observe({ type: "event", durationThreshold: 16, buffered: false } as PerformanceObserverInit)
  host.__ownbInput = {
    events,
    timings,
    stop() {
      types.forEach((type) => window.removeEventListener(type, listener))
      observer.disconnect()
    },
  }
}

export async function readInputProbe(): Promise<InputProbeResult> {
  const probe = (window as ProbeWindow).__ownbInput
  if (!probe) throw new Error("input probe not installed")
  // Event Timing entries are delivered after the next paint; give the observer two frames.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))
  probe.stop()
  return { events: probe.events.slice(), timings: probe.timings.slice() }
}

/** rAF timestamps, long tasks and long animation frames from now until `stopFrameProbe`. */
export function startFrameProbe() {
  const host = window as ProbeWindow
  host.__ownbFrames?.stop()
  const raf: number[] = []
  const longTasks: number[] = []
  const longTaskStarts: number[] = []
  const longAnimationFrames: FrameProbeResult["longAnimationFrames"] = []
  let running = true
  const tick = (time: number) => {
    if (!running) return
    raf.push(time)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  let origin = performance.now()
  const tasks = new PerformanceObserver((list) =>
    list.getEntries().forEach((entry) => {
      longTasks.push(entry.duration)
      longTaskStarts.push(entry.startTime - origin)
    }),
  )
  tasks.observe({ type: "longtask" })
  const frames = new PerformanceObserver((list) =>
    list.getEntries().forEach((entry) =>
      longAnimationFrames.push({
        duration: entry.duration,
        blocking: (entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0,
      }),
    ),
  )
  try {
    frames.observe({ type: "long-animation-frame" })
  } catch {}
  origin = performance.mark("ownb:measure:start").startTime
  host.__ownbFrames = {
    raf,
    longTasks,
    longTaskStarts,
    longAnimationFrames,
    stop() {
      running = false
      tasks.disconnect()
      frames.disconnect()
    },
  }
}

export async function stopFrameProbe(): Promise<FrameProbeResult> {
  const probe = (window as ProbeWindow).__ownbFrames
  if (!probe) throw new Error("frame probe not started")
  performance.mark("ownb:measure:end")
  await new Promise((resolve) => setTimeout(resolve, 60))
  probe.stop()
  return {
    raf: probe.raf.slice(),
    longTasks: probe.longTasks.slice(),
    longTaskStarts: probe.longTaskStarts.slice(),
    longAnimationFrames: probe.longAnimationFrames.slice(),
  }
}

/** Idle refresh interval: median rAF interval over `frames` idle frames (recorded with PF3/PF4, not a threshold). */
export async function idleRefresh(frames: number) {
  const times = await new Promise<number[]>((resolve) => {
    const collected: number[] = []
    const tick = (time: number) => {
      collected.push(time)
      if (collected.length > frames) resolve(collected)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const intervals = times
    .slice(1)
    .map((value, index) => value - times[index]!)
    .toSorted((a, b) => a - b)
  return intervals[Math.floor(intervals.length / 2)]!
}

/**
 * Marks the transcript's scroll container with `data-ownb-scroller`: the element inside (or being)
 * `[data-testid="transcript"]` that scrolls vertically and has the most overflow. Returns its geometry.
 */
export function findScroller() {
  const root = document.querySelector<HTMLElement>('[data-testid="transcript"]')
  if (!root) return null
  const candidates = [root, ...root.querySelectorAll<HTMLElement>("*")].filter((element) => {
    const overflow = getComputedStyle(element).overflowY
    return (overflow === "auto" || overflow === "scroll") && element.clientHeight > 0
  })
  const scroller = candidates.toSorted((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))[0]
  if (!scroller) return null
  document.querySelectorAll("[data-ownb-scroller]").forEach((element) => element.removeAttribute("data-ownb-scroller"))
  scroller.setAttribute("data-ownb-scroller", "")
  const rect = scroller.getBoundingClientRect()
  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

/** One located fixture marker; `visible` = rendered and intersecting the transcript viewport. */
export interface LocatedMarker {
  readonly marker: string
  readonly tag: string
  readonly turn: number
  readonly visible: boolean
}

/**
 * Installs `window.__ownbLocate()`: every fixture marker (`OWNB-<tag>-<turn>-U|R`) in the transcript, found in the
 * text content (so markers split across text nodes by streaming or highlighting still count) and measured with a Range
 * over its own characters; visible = the Range's closest element is rendered and a rect of it intersects the
 * transcript viewport. One walk over the text nodes per call: the earlier per-marker search for the deepest element
 * containing it read `textContent` of every level (O(markers × depth × text)) and took over a second per call once a
 * streamed answer was long (many-sessions bench, SR 2026-10-20). Idempotent; call it after each navigation before
 * `markerState` or the switch probe.
 */
export function installMarkerLocator() {
  const host = window as Window & { __ownbLocate?: () => LocatedMarker[] }
  if (host.__ownbLocate) return
  host.__ownbLocate = () => {
    const root = document.querySelector<HTMLElement>('[data-testid="transcript"]')
    if (!root) return []
    const scroller = document.querySelector<HTMLElement>("[data-ownb-scroller]") ?? root
    const view = scroller.getBoundingClientRect()
    const top = Math.max(view.top, 0)
    const bottom = Math.min(view.bottom, innerHeight)
    const nodes: Text[] = []
    const starts: number[] = []
    let text = ""
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node as Text)
      starts.push(text.length)
      text += (node as Text).data
    }
    // The text node holding character `offset` of `text` (binary search over the starts).
    const point = (offset: number, end: boolean) => {
      let low = 0
      let high = nodes.length - 1
      while (low < high) {
        const middle = (low + high + 1) >> 1
        if (starts[middle]! < offset || (!end && starts[middle] === offset)) low = middle
        else high = middle - 1
      }
      return { node: nodes[low]!, offset: offset - starts[low]! }
    }
    const visible = new Map<string, boolean>()
    for (const match of text.matchAll(/OWNB-([A-Z0-9]+)-(\d{4})-([UR])/g)) {
      const marker = match[0]
      if (visible.get(marker)) continue
      const from = point(match.index, false)
      const to = point(match.index + marker.length, true)
      const range = document.createRange()
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
      const common = range.commonAncestorContainer
      const element = common instanceof Element ? common : common.parentElement
      const shown =
        !!element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
        [...range.getClientRects()].some((rect) => rect.height > 0 && rect.bottom > top && rect.top < bottom)
      visible.set(marker, shown)
    }
    return [...visible].map(([marker, shown]) => {
      const [, tag, turn] = marker.split("-")
      return { marker, tag: tag!, turn: Number(turn), visible: shown }
    })
  }
}

/** Visible markers per tag, the asked-for markers, and the mounted range (see `installMarkerLocator`). */
export function markerState(wanted: string[]): MarkerState {
  const locate = (window as Window & { __ownbLocate?: () => LocatedMarker[] }).__ownbLocate
  if (!locate) throw new Error("installMarkerLocator first")
  const located = locate()
  const visible: Record<string, number> = {}
  const earliest: Record<string, number> = {}
  for (const item of located) {
    earliest[item.tag] = Math.min(earliest[item.tag] ?? Infinity, item.turn)
    if (item.visible) visible[item.tag] = (visible[item.tag] ?? 0) + 1
  }
  const found = Object.fromEntries(
    wanted.map((item) => [item, located.some((entry) => entry.visible && entry.marker === item)]),
  )
  const present = Object.fromEntries(wanted.map((item) => [item, located.some((entry) => entry.marker === item)]))
  return { visible, wanted: found, mounted: located.length, earliest, present }
}

/**
 * PF7 probe (upstream session-tab-switch semantics): starts at the `mousedown` on an element matching
 * `trigger` (time origin = that event's timeStamp) and samples every frame (rAF → task) for `limitMs`.
 * Needs `installMarkerLocator` and a scroller tagged by `findScroller` (the view is not rebuilt on a switch, PF7),
 * so sampling adds no layout-wide search to the measured frames.
 */
export function installSwitchProbe(input: {
  trigger: string
  destination: string
  source: string
  last: string
  limitMs: number
}) {
  const host = window as ProbeWindow & { __ownbLocate?: () => LocatedMarker[] }
  const locate = host.__ownbLocate
  if (!locate) throw new Error("installMarkerLocator first")
  const samples: { at: number; last: boolean; destination: number; source: number }[] = []
  host.__ownbSwitch = { samples, done: false }
  const sample = (origin: number) => {
    // The state is the DOM's when the sample starts; the locator's own time is not part of the switch.
    const at = performance.now() - origin
    const visible = locate().filter((item) => item.visible)
    samples.push({
      at,
      destination: visible.filter((item) => item.tag === input.destination).length,
      source: visible.filter((item) => item.tag === input.source).length,
      last: visible.some((item) => item.marker === input.last),
    })
    if (at < input.limitMs) requestAnimationFrame(() => setTimeout(() => sample(origin), 0))
    else host.__ownbSwitch!.done = true
  }
  const start = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest(input.trigger)) return
    document.removeEventListener("mousedown", start, true)
    performance.mark("ownb:switch:start")
    requestAnimationFrame(() => setTimeout(() => sample(event.timeStamp), 0))
  }
  document.addEventListener("mousedown", start, true)
}

export function readSwitchProbe() {
  return (window as ProbeWindow).__ownbSwitch ?? { samples: [], done: false }
}
