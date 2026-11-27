// PF7 (01 §6.6, 03 §20.1): switching to a cached session shows its content within 100 ms, measured like upstream
// timeline/session-tab-switch-benchmark.spec.ts (`firstCorrectObservedMs`: from the row's mousedown to the first
// frame where the destination's last answer is visible and nothing of the source is) but with a sidebar row click
// instead of a titlebar tab (03 §20.4). The cold entry (never opened, fetched on click) is a tracked metric
// (< 500 ms), ported from timeline/session-entry-benchmark.spec.ts ("cold session from Home").
import type { Page } from "@playwright/test"
import { benchmark, expect } from "./benchmark"
import { classifySwitch } from "./metrics"
import { installMarkerLocator, installSwitchProbe, readSwitchProbe } from "./probes"
import {
  benchContext,
  openApp,
  perfState,
  scroller,
  sessionRoute,
  TRANSCRIPT_PENDING,
  transcriptReady,
  waitForMarker,
  type PerfSession,
} from "./support"

const state = perfState()
const LIMIT_MS = 3_000
benchmark.use({ traceScope: "interaction" })

benchmark("PF7 warm switch: sidebar row to a cached 2,000-message session", async ({ page, report }) => {
  const [source, destination] = [state.sessions.a, state.sessions.b]
  await openApp(page, state, sessionRoute(source.id))
  benchmark.skip(!(await transcriptReady(page, source.lastMarker)), TRANSCRIPT_PENDING)
  // Warm the destination (timeline LRU, 03 §16.4), then come back.
  await row(page, destination).click()
  expect(await waitForMarker(page, destination.lastMarker, 30_000)).toBe(true)
  await row(page, source).click()
  expect(await waitForMarker(page, source.lastMarker, 30_000)).toBe(true)
  await page.waitForTimeout(500)

  const fetches = watchMessageFetches(page, destination.id)
  const result = await measureSwitch(page, source, destination)
  expect(result.firstCorrectObservedMs).not.toBeNull()
  report(
    { ...result, messageFetches: fetches.length },
    { ...benchContext(page, state), data: "cached", input: "sidebar row mousedown" },
  )
})

benchmark("PF7 cold entry: sidebar row to an unopened 2,000-message session", async ({ page, report }) => {
  const destination = state.sessions.b
  await openApp(page, state)
  await expect(page.getByTestId("session-list").getByText(destination.title)).toBeVisible()
  const fetches = watchMessageFetches(page, destination.id)
  const result = await measureSwitch(page, state.sessions.a, destination)
  benchmark.skip(
    result.firstCorrectObservedMs === null && !(await waitForMarker(page, destination.lastMarker, 10_000)),
    TRANSCRIPT_PENDING,
  )
  expect(result.firstCorrectObservedMs).not.toBeNull()
  report(
    { ...result, messageFetches: fetches.length },
    { ...benchContext(page, state), data: "on demand", input: "sidebar row mousedown", from: "home" },
  )
})

function row(page: Page, session: PerfSession) {
  return page.getByTestId("session-list").getByText(session.title, { exact: true })
}

function watchMessageFetches(page: Page, sessionID: string) {
  const fetches: string[] = []
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname.startsWith(`/api/session/${sessionID}/message`))
      fetches.push(request.url())
  })
  return fetches
}

async function measureSwitch(page: Page, source: PerfSession, destination: PerfSession) {
  const target = row(page, destination)
  await target.evaluate((element) => {
    document.querySelectorAll("[data-ownb-trigger]").forEach((item) => item.removeAttribute("data-ownb-trigger"))
    ;(element.closest("a, button, [role='link'], li") ?? element).setAttribute("data-ownb-trigger", "")
  })
  await scroller(page).catch(() => undefined)
  await page.evaluate(installMarkerLocator)
  await page.evaluate(installSwitchProbe, {
    trigger: "[data-ownb-trigger]",
    destination: destination.tag,
    source: source.tag,
    last: destination.lastMarker,
    limitMs: LIMIT_MS,
  })
  await target.click()
  await page.waitForFunction(
    () => (window as Window & { __ownbSwitch?: { done: boolean } }).__ownbSwitch?.done,
    undefined,
    {
      timeout: LIMIT_MS + 5_000,
    },
  )
  return classifySwitch((await page.evaluate(readSwitchProbe)).samples)
}
