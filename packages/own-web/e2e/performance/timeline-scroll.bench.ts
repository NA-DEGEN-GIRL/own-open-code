// PF3 (01 §6.6, 03 §20.1): scrolling the 2,000-message session (40% of messages with tool cards). The whole history
// is paged in first (scroll to the top until the first prompt shows), then synthesized mouse-wheel gestures fling
// up and back down for ~10 s while a CDP trace records presented frames (PipelineReporter) and in-page probes
// record rAF intervals, long tasks and long animation frames. Ported from upstream
// timeline/session-timeline-benchmark.spec.ts and timeline-stability/scroll-interaction.spec.ts (own fixture size,
// presented frames instead of rAF-only diagnostics, 03's long-frame ratio).
import { benchmark } from "./benchmark"
import { firstMarker } from "./fixture/history"
import { markerState } from "./probes"
import {
  benchContext,
  loadHistory,
  measureFrames,
  openApp,
  perfState,
  scroller,
  scrollGesture,
  scrollToBottom,
  sessionRoute,
  TRANSCRIPT_PENDING,
  transcriptReady,
  waitForStableBottom,
} from "./support"

const state = perfState()
const SPEED = Number(process.env.OWN_PERF_SCROLL_SPEED ?? 4_000)
const SECONDS = Number(process.env.OWN_PERF_SCROLL_SECONDS ?? 10)
benchmark.use({ traceScope: "interaction" })

benchmark("PF3 timeline scroll: 2,000 messages, wheel fling up and down", async ({ page, report }) => {
  benchmark.setTimeout(420_000)
  const session = state.sessions.a
  await openApp(page, state, sessionRoute(session.id))
  const opened = performance.now()
  const ready = await transcriptReady(page, session.lastMarker)
  benchmark.skip(!ready, TRANSCRIPT_PENDING)
  const entryMs = performance.now() - opened

  const start = await scroller(page)
  const history = await loadHistory(page, {
    x: start.x,
    y: start.y,
    tag: session.tag,
    first: firstMarker(session.tag),
    timeoutMs: Number(process.env.OWN_PERF_HISTORY_TIMEOUT_MS ?? 240_000),
    idleMs: 15_000,
  })
  await scrollToBottom(page)
  await waitForStableBottom(page)
  const geometry = await scroller(page)
  // JS heap with the whole history paged in (Chromium's `performance.memory`, bucketed): major GCs during the fling
  // scale with it (see README "Profiling").
  const heapMB = () =>
    page.evaluate(() => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
      return memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null
    })
  const heapBefore = await heapMB()

  const cdp = await page.context().newCDPSession(page)
  const distance = (SPEED * SECONDS) / 2
  const frames = await measureFrames(page, "PF3 timeline scroll", async () => {
    await scrollGesture(cdp, { x: geometry.x, y: geometry.y, distance, speed: SPEED })
    await scrollGesture(cdp, { x: geometry.x, y: geometry.y, distance: -distance, speed: SPEED })
  })
  await cdp.detach()
  const heapAfter = await heapMB()
  // Content check after the fling: rows are on screen (a blank viewport would make the frame numbers meaningless).
  const after = await page.evaluate(markerState, [session.lastMarker])
  report(
    {
      ...frames,
      entryMs: Math.round(entryMs),
      history,
      jsHeapMB: { beforeFling: heapBefore, afterFling: heapAfter },
      scrolledHeight: geometry.scrollHeight,
      visibleMarkersAfter: after.visible[session.tag] ?? 0,
      mountedMarkersAfter: after.mounted,
    },
    {
      ...benchContext(page, state),
      messages: session.stats.messages,
      toolShare: 0.4,
      stats: session.stats,
      speed: SPEED,
      seconds: SECONDS,
      input: "Input.synthesizeScrollGesture mouse",
    },
  )
})
