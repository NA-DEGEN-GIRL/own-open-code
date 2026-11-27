// Performance marks (03 §20.3). Names are shared with the shell benchmarks (05 §9.4), so do not rename them.
// Marks carry no keys, text, DOM or URLs (R11).

export type OwnMark =
  | "own:boot"
  | "own:shell-start"
  | "own:first-paint"
  | "own:sessions-visible"
  | "own:sessions-fresh"
  | "own:accounts-ready"
  | `own:session-ready:${string}`
  | `own:panel-open:${string}`

const done = new Set<string>()

/** Records a mark once per page load; later calls are ignored. */
export function markOnce(name: OwnMark, startTime?: number) {
  if (done.has(name) || typeof performance === "undefined") return
  done.add(name)
  performance.mark(name, startTime === undefined ? undefined : { startTime })
}

/**
 * Marks after the frame that contains the current DOM changes was painted: two rAFs (03 §20.1 PF1 "rAF 2번"), and
 * never before the page's first contentful paint was presented. Two rAFs only mean the renderer produced the frame:
 * at startup the GPU process may still be compiling the shaders for it (Electron keeps no Skia shader cache between
 * launches, ~300 ms on this PC), so a list rendered early would be marked visible before any pixel reached the
 * screen. With paint timing the mark takes `max(two rAFs, first-contentful-paint)`; FCP carries the presentation time.
 * Hidden pages do not paint, so the mark waits until they do.
 */
export function markAfterPaint(name: OwnMark) {
  if (done.has(name) || typeof requestAnimationFrame !== "function") return
  requestAnimationFrame(() => requestAnimationFrame(() => afterFirstContentfulPaint(name)))
}

function afterFirstContentfulPaint(name: OwnMark) {
  const supported =
    typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("paint") === true
  const fcp = () => performance.getEntriesByName("first-contentful-paint", "paint")[0]?.startTime
  if (!supported || fcp() !== undefined) return markOnce(name)
  const framed = performance.now()
  const observer = new PerformanceObserver(() => {
    const at = fcp()
    if (at === undefined) return
    observer.disconnect()
    markOnce(name, Math.max(framed, at))
  })
  observer.observe({ type: "paint", buffered: true })
}

/** Milliseconds from navigation start to a mark, or `undefined`. */
export function markTime(name: OwnMark) {
  const entry = performance.getEntriesByName(name, "mark")[0]
  return entry?.startTime
}
