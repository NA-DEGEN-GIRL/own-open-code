// Split panes (03 §4.1.1, §20.1): the budgets with more than one session on screen.
//  - PF2 while two panes stream: sessions T and U side by side, both answering at 200 deltas/s; Korean IME typing in
//    T's composer (the focused pane) through CDP, every input event counted (gate: processing p95 ≤ 16 ms).
//  - T1 with four panes: A, B, S and a filler in a 2 × 2 grid, then six more sessions opened in the focused pane
//    (ten in all); JS heap after a forced GC (tracked: ≤ 300 MB).
//  - Pane focus switch (tracked like PF7): Ctrl+Alt+n → the header shows that pane's session, two frames later.
// The pane tree is seeded in this window's storage (`own.web.panes.web`) before the app starts.
import type { Page } from "@playwright/test"
import { benchmark, expect } from "./benchmark"
import { inputLatency } from "./metrics"
import { installInputProbe, readInputProbe } from "./probes"
import {
  benchContext,
  clearComposer,
  imeWorkload,
  openApp,
  perfState,
  sessionRoute,
  transcriptReady,
  typeIme,
  type PerfSession,
} from "./support"

const state = perfState()
const DELTAS = Number(process.env.OWN_PERF_STREAM_DELTAS ?? 4_000)
const RATE = Number(process.env.OWN_PERF_STREAM_RATE ?? 200)
const PACE_MS = Number(process.env.OWN_PERF_KEY_PACE_MS ?? 35)
const PHASE_MS = Number(process.env.OWN_PERF_STREAM_PHASE_MS ?? 8_000)
const FOCUSED = '[data-pane-focused] textarea[data-own-keys="composer"]'

type Leaf = {
  kind: "leaf"
  id: string
  view: "chat"
  route: { name: "session"; serverKey: "local"; sessionID: string }
}
const leaf = (id: string, session: PerfSession): Leaf => ({
  kind: "leaf",
  id,
  view: "chat",
  route: { name: "session", serverKey: "local", sessionID: session.id },
})

async function seed(page: Page, tree: unknown, focused: string) {
  await page.addInitScript(
    (value) => localStorage.setItem("own.web.panes.web", value),
    JSON.stringify({ tree, focused }),
  )
}

benchmark("split panes: PF2 input in one pane while two panes stream", async ({ page, report }, testInfo) => {
  benchmark.setTimeout(300_000)
  await page.setViewportSize({ width: 1724, height: 960 })
  const { t, u } = state.sessions
  await seed(page, { kind: "split", dir: "row", sizes: [0.5, 0.5], children: [leaf("p1", t), leaf("p2", u)] }, "p1")
  await openApp(page, state, sessionRoute(t.id))
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(2)
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")
  await transcriptReady(page, [t.tag, "X", "Y"])
  await transcriptReady(page, [u.tag, "X", "Y"])

  const run = `${process.env.OPENCODE_PERFORMANCE_RUN_ID ?? "manual"}-${testInfo.repeatEachIndex}`
  // Three digits and the pane: `OWNB-X-<4 digits>-R`, the form the marker locator counts (a later repeat finds it).
  const tag = String(testInfo.repeatEachIndex % 1_000).padStart(3, "0")
  const plans = [t, u].map((session, index) => ({
    session,
    plan: {
      marker: `OWNBP-split${index}-${run}`,
      deltas: DELTAS,
      rate: RATE,
      startMarker: `OWNB-X-${tag}${index}-R`,
      doneMarker: `OWNB-Y-${tag}${index}-R`,
    },
  }))
  const provider = async () =>
    (await (await fetch(`${state.provider.url}/__bench/state`)).json()) as {
      streams: { marker: string; sent: number; finishedAt?: number }[]
    }
  for (const { session, plan } of plans) {
    await fetch(`${state.provider.url}/__bench/stream`, { method: "POST", body: JSON.stringify(plan) })
    const prompted = await page.request.post(`${state.preview}/api/session/${session.id}/prompt`, {
      data: { text: `분할 스트리밍 측정입니다. ${plan.marker}` },
      headers: { "x-opencode-directory": encodeURIComponent(state.workspace) },
    })
    expect(prompted.ok(), await prompted.text()).toBe(true)
  }
  const sending = async () =>
    (await provider()).streams.filter(
      (stream) => plans.some(({ plan }) => plan.marker === stream.marker) && stream.sent > 0,
    ).length
  await expect.poll(sending, { timeout: 120_000 }).toBe(2)

  const composer = page.locator(FOCUSED)
  await composer.focus()
  const typing = await page.context().newCDPSession(page)
  await page.evaluate(installInputProbe, FOCUSED)
  const started = Date.now()
  const typed = await typeIme(typing, imeWorkload(10_000), PACE_MS, () => Date.now() - started > PHASE_MS)
  const input = await page.evaluate(readInputProbe)
  const live = (await provider()).streams.filter(
    (stream) => plans.some(({ plan }) => plan.marker === stream.marker) && !stream.finishedAt,
  ).length
  await typing.detach()
  await clearComposer(page)
  expect(input.events.filter((event) => event.type === "compositionupdate").length).toBeGreaterThan(0)
  for (const { session } of plans)
    await page.request.post(`${state.preview}/api/experimental/session/${session.id}/wait`, {
      headers: { "x-opencode-directory": encodeURIComponent(state.workspace) },
    })
  report(
    {
      input: { ...inputLatency(input.events, input.timings), processingSamples: undefined, paintSamples: undefined },
      keystrokes: typed,
      streamsLiveAtEnd: live,
    },
    { ...benchContext(page, state), panes: 2, streaming: 2, deltas: DELTAS, rate: RATE, paceMs: PACE_MS },
  )
})

benchmark("split panes: heap with 4 panes and 10 sessions; pane focus switch", async ({ page, report }) => {
  benchmark.setTimeout(300_000)
  await page.setViewportSize({ width: 1724, height: 960 })
  const { a, b, s } = state.sessions
  const fillers = state.fillers.slice(0, 7)
  const filler = (index: number) => ({ id: fillers[index]!.id, title: fillers[index]!.title }) as PerfSession
  await seed(
    page,
    {
      kind: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        { kind: "split", dir: "column", sizes: [0.5, 0.5], children: [leaf("p1", a), leaf("p3", s)] },
        { kind: "split", dir: "column", sizes: [0.5, 0.5], children: [leaf("p2", b), leaf("p4", filler(0))] },
      ],
    },
    "p4",
  )
  await openApp(page, state, sessionRoute(fillers[0]!.id))
  await expect(page.locator('[data-testid="pane"][data-view="chat"]:not([hidden])')).toHaveCount(4)
  await transcriptReady(page, [a.tag, b.tag, s.tag])
  // Six more sessions through the focused pane (p4): ten sessions in all.
  for (const item of fillers.slice(1)) {
    // Like a sidebar click: the path router follows history (the filler rows may be outside the windowed list).
    await page.evaluate((path) => {
      history.pushState(null, "", path)
      dispatchEvent(new PopStateEvent("popstate"))
    }, sessionRoute(item.id))
    await expect(page.getByTestId("header-title")).toHaveText(item.title)
    await page.waitForTimeout(300)
  }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  const heap = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number }

  // Pane focus switch: key → header title of that pane, two frames later.
  const focusSwitch: number[] = []
  for (const [key, title] of [
    ["Digit1", a.title],
    ["Digit2", b.title],
    ["Digit3", s.title],
    ["Digit1", a.title],
    ["Digit2", b.title],
  ] as const) {
    await page.keyboard.down("Control")
    await page.keyboard.down("Alt")
    const start = await page.evaluate(() => performance.now())
    await page.keyboard.press(key)
    await page.keyboard.up("Alt")
    await page.keyboard.up("Control")
    await expect(page.getByTestId("header-title")).toHaveText(title)
    const end = await page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
        ),
    )
    focusSwitch.push(Math.round(end - start))
  }
  await cdp.detach()
  report(
    {
      jsHeapMB: Math.round(heap.usedSize / 1024 / 1024),
      jsHeapTotalMB: Math.round(heap.totalSize / 1024 / 1024),
      sessionsOpened: 10,
      paneFocusSwitchMs: focusSwitch,
    },
    { ...benchContext(page, state), panes: 4 },
  )
})
