// PF4 (01 §6.6, 03 §20.1): PF2 and PF3 must hold while an answer streams at 200 deltas/s into the 2,000-message
// session, and scrolling up must release the bottom anchor without jumps. The real server runs the turn against the
// paced fake provider (fixture/stream-provider.ts); the prompt goes through the same `/api` proxy the app uses.
// Phase A types Korean through the IME (CDP) while following the stream; phase B scrolls up with the wheel while
// typing continues, recording presented frames, and then checks that the viewport stays put while deltas land.
// Ported from upstream timeline/session-timeline-benchmark.spec.ts (streaming throughput, rAF gaps, long tasks,
// geometry) with own additions (IME input during streaming, presented frames).
import { benchmark, expect } from "./benchmark"
import { inputLatency } from "./metrics"
import { idleRefresh, installInputProbe, markerState, readInputProbe } from "./probes"
import {
  benchContext,
  clearComposer,
  COMPOSER,
  imeWorkload,
  measureFrames,
  openApp,
  perfState,
  scroller,
  scrollGesture,
  scrollToBottom,
  sessionRoute,
  transcriptReady,
  typeIme,
  waitForMarker,
  waitForStableBottom,
  type ScrollMeasurement,
} from "./support"

const state = perfState()
const DELTAS = Number(process.env.OWN_PERF_STREAM_DELTAS ?? 4_000)
const RATE = Number(process.env.OWN_PERF_STREAM_RATE ?? 200)
const PACE_MS = Number(process.env.OWN_PERF_KEY_PACE_MS ?? 35)
const PHASE_MS = Number(process.env.OWN_PERF_STREAM_PHASE_MS ?? 5_000)
benchmark.use({ traceScope: "interaction" })

type ProviderState = {
  streams: { marker: string; sent: number; deltas: number; startedAt?: number; finishedAt?: number }[]
}

benchmark("PF4 streaming: IME input and wheel scroll while 200 deltas/s arrive", async ({ page, report }, testInfo) => {
  benchmark.setTimeout(300_000)
  const session = state.sessions.s
  const run = `${process.env.OPENCODE_PERFORMANCE_RUN_ID ?? "manual"}-${testInfo.repeatEachIndex}`
  const tag = String(testInfo.repeatEachIndex % 10_000).padStart(4, "0")
  const plan = {
    marker: `OWNBP-${run}`,
    deltas: DELTAS,
    rate: RATE,
    startMarker: `OWNB-X-${tag}-R`,
    doneMarker: `OWNB-Y-${tag}-R`,
  }
  await openApp(page, state, sessionRoute(session.id))
  // Earlier repetitions appended streamed answers (tags X/Y), so any fixture marker of this session counts.
  const transcript = await transcriptReady(page, [session.tag, "X", "Y"])
  if (transcript) {
    await scroller(page)
    await scrollToBottom(page)
    await waitForStableBottom(page)
  }
  const composer = page.locator(COMPOSER).first()
  await composer.focus()
  // The recorded refresh rate comes from idle frames, so it is measured before the stream starts.
  const refreshMs = await page.evaluate(idleRefresh, 120)

  const provider = async () => (await (await fetch(`${state.provider.url}/__bench/state`)).json()) as ProviderState
  const stream = async () => (await provider()).streams.find((item) => item.marker === plan.marker)
  await fetch(`${state.provider.url}/__bench/stream`, { method: "POST", body: JSON.stringify(plan) })
  const prompted = await page.request.post(`${state.preview}/api/session/${session.id}/prompt`, {
    data: { text: `스트리밍 성능 측정 요청입니다. ${plan.marker}` },
    headers: { "x-opencode-directory": encodeURIComponent(state.workspace) },
  })
  expect(prompted.ok(), await prompted.text()).toBe(true)
  const promptedAt = Date.now()
  await expect.poll(async () => (await stream())?.sent ?? 0, { timeout: 120_000 }).toBeGreaterThan(0)
  const firstDeltaMs = ((await stream())!.startedAt ?? promptedAt) - promptedAt
  // Milliseconds since the prompt at each phase boundary, reported with the metrics.
  const timeline: Record<string, number> = { firstDelta: firstDeltaMs }
  const markTime = (name: string) => (timeline[name] = Date.now() - promptedAt)
  // The answer's first line scrolls away while following, so "rendered" means mounted, not visible.
  const renderStart = Date.now()
  const startRendered = transcript
    ? await expect
        .poll(async () => (await page.evaluate(markerState, [plan.startMarker])).present[plan.startMarker], {
          timeout: 10_000,
        })
        .toBe(true)
        .then(
          () => Date.now() - renderStart,
          () => null,
        )
    : null

  // Phase A: typing while following the stream at the bottom.
  const typing = await page.context().newCDPSession(page)
  const steps = imeWorkload(10_000)
  await page.evaluate(installInputProbe, COMPOSER)
  const phaseA = Date.now()
  markTime("phaseA")
  const typedA = await typeIme(typing, steps, PACE_MS, () => Date.now() - phaseA > PHASE_MS)
  const sentAfterA = (await stream())?.sent ?? 0
  markTime("phaseAEnd")
  // Phase B must start while deltas still arrive, or it measures an idle session. (It may overrun the stream when
  // the app is slow; that slowness is what the frame and input numbers then show.)
  expect(
    sentAfterA,
    `the stream ended before phase B (${JSON.stringify(timeline)}); raise OWN_PERF_STREAM_DELTAS`,
  ).toBeLessThan(DELTAS)
  const inputA = await page.evaluate(readInputProbe)

  // Phase B: wheel up while typing continues; then the viewport must stay where the user left it.
  await page.evaluate(installInputProbe, COMPOSER)
  let scroll: ScrollMeasurement | null = null
  let anchor: { releasedPx: number; jumpPx: number; pulledBack: number } | null = null
  let typedB = 0
  if (transcript) {
    const geometry = await scroller(page)
    const wheel = await page.context().newCDPSession(page)
    markTime("phaseB")
    scroll = await measureFrames(
      page,
      "PF4 streaming scroll",
      async () => {
        const typingFrom = Date.now()
        const typed = typeIme(typing, steps.slice(typedA), PACE_MS, () => Date.now() - typingFrom > PHASE_MS)
        await scrollGesture(wheel, { x: geometry.x, y: geometry.y, distance: 3_000, speed: 1_500 })
        markTime("gestureEnd")
        const left = await page.evaluate(() => {
          const element = document.querySelector<HTMLElement>("[data-ownb-scroller]")!
          return { top: element.scrollTop, fromBottom: element.scrollHeight - element.clientHeight - element.scrollTop }
        })
        await page.waitForTimeout(1_500)
        const later = await page.evaluate(() => document.querySelector<HTMLElement>("[data-ownb-scroller]")!.scrollTop)
        anchor = {
          releasedPx: Math.round(left.fromBottom),
          jumpPx: Math.round(Math.abs(later - left.top)),
          // Scrolling up must release the bottom anchor (03 §20.1 PF4); 1 = the view was pulled back to the tail.
          pulledBack: left.fromBottom < 100 ? 1 : 0,
        }
        typedB = await typed
      },
      refreshMs,
    )
    await wheel.detach()
  } else {
    const phaseB = Date.now()
    typedB = await typeIme(typing, steps.slice(typedA), PACE_MS, () => Date.now() - phaseB > PHASE_MS)
  }
  const inputB = await page.evaluate(readInputProbe)
  const sentAfterB = (await stream())?.sent ?? 0
  markTime("phaseBEnd")
  await typing.detach()
  await clearComposer(page)

  // Completion: the provider finished, the server went idle, and (with a transcript) the last delta rendered.
  await expect.poll(async () => (await stream())?.finishedAt ?? 0, { timeout: 120_000 }).toBeGreaterThan(0)
  const finished = (await stream())!
  const waited = await page.request.post(`${state.preview}/api/experimental/session/${session.id}/wait`, {
    headers: { "x-opencode-directory": encodeURIComponent(state.workspace) },
  })
  expect(waited.ok()).toBe(true)
  let doneVisible: boolean | null = null
  if (transcript) {
    await scrollToBottom(page)
    doneVisible = await waitForMarker(page, plan.doneMarker, 15_000)
  }
  const visible = transcript ? await page.evaluate(markerState, []) : null
  const events = [...inputA.events, ...inputB.events]
  const timings = [...inputA.timings, ...inputB.timings]
  expect(events.filter((event) => event.type === "compositionupdate").length).toBeGreaterThan(0)
  report(
    {
      input: inputLatency(events, timings),
      inputFollowing: {
        ...inputLatency(inputA.events, inputA.timings),
        processingSamples: undefined,
        paintSamples: undefined,
      },
      inputWhileScrolling: {
        ...inputLatency(inputB.events, inputB.timings),
        processingSamples: undefined,
        paintSamples: undefined,
      },
      scroll,
      anchor,
      transcriptRendersFixture: transcript,
      stream: {
        deltas: finished.deltas,
        rate: RATE,
        firstDeltaMs,
        providerMs: (finished.finishedAt ?? 0) - (finished.startedAt ?? 0),
        sentAfterPhaseA: sentAfterA,
        sentAfterPhaseB: sentAfterB,
        timeline,
        startRenderedMs: startRendered,
        doneVisible,
      },
      keystrokes: { following: typedA, scrolling: typedB },
      visibleMarkers: visible?.visible ?? null,
    },
    {
      ...benchContext(page, state),
      deltas: DELTAS,
      rate: RATE,
      paceMs: PACE_MS,
      phaseMs: PHASE_MS,
      messages: session.stats.messages,
      composer: COMPOSER,
    },
  )
})
