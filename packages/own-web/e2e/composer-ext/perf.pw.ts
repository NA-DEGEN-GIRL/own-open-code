// Suggestion costs on the typing path (01 §6.6 PF2, 03 §20.2 R3/R6) and file search on a large workspace (03 §18.12
// Windows fs.find note). Every textarea handler is timed in the harness (all events counted, like the PF2 gate);
// Event Timing adds event→paint for the slow ones. Numbers are printed and attached to the report.
import { expect, test, type Locator, type Page } from "@playwright/test"
import { backend, newSession, openHarness, options } from "./support"

function p(values: readonly number[], quantile: number) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]! : 0
}

interface Slow {
  readonly name: string
  readonly duration: number
}

/** Types mention queries with the list open; returns handler times, slow events and list latency. */
async function typeQueries(page: Page, textarea: Locator, queries: readonly string[]) {
  await page.evaluate(() => {
    window.__harness!.timings.length = 0
    ;(window as unknown as { __slow: Slow[] }).__slow.length = 0
  })
  const landed: number[] = []
  for (const query of queries) {
    await textarea.pressSequentially(` ${query}`, { delay: 30 })
    const started = Date.now()
    await expect(options(page).first()).toContainText(query.slice(1).split("/").at(-1)!)
    landed.push(Date.now() - started)
    await textarea.press("Escape")
  }
  const timings = await page.evaluate(() => [...window.__harness!.timings])
  const slow = await page.evaluate(() => [...(window as unknown as { __slow: Slow[] }).__slow])
  const inputs = slow.filter((entry) => entry.name === "keydown" || entry.name === "input" || entry.name === "keypress")
  return {
    handlers: { events: timings.length, p95: p(timings, 0.95), max: Math.max(...timings) },
    /** Event Timing reports only events ≥ 16 ms; the rest count as fast (01 §6.6 "표본 0개를 지연 0으로 읽지 않는다"). */
    slowInputEvents: inputs.length,
    eventToPaintP95: p(
      [...inputs.map((entry) => entry.duration), ...Array(Math.max(0, timings.length - inputs.length)).fill(8)],
      0.95,
    ),
    listAfterLastKey: { p50: p(landed, 0.5), max: Math.max(...landed) },
  }
}

test("typing with the list open stays within PF2; file answers land fast on 3,000+ files", async ({
  page,
  request,
}) => {
  const state = backend()
  const sessionID = await newSession(request, "성능 e2e")
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await page.evaluate(() => {
    const slow: Slow[] = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[])
        slow.push({ name: entry.name, duration: entry.duration })
    }).observe({ type: "event", buffered: false, durationThreshold: 16 } as PerformanceObserverInit)
    Object.assign(window, { __slow: slow })
  })

  // Warm the chunk and the server index (the first fs.find of a location builds it).
  await textarea.pressSequentially("@mod")
  await expect(options(page).first()).toContainText("big/")
  await textarea.fill("")

  const queries = ["@pkg1/mod2", "@mod4", "@router", "@pkg4/mod5"]
  const short = await typeQueries(page, textarea, queries)
  // A ~100k-character draft: our detection is bounded by the word (handlers stay flat); the browser's own textarea
  // layout of that much text is what the paint numbers show.
  await textarea.fill(`${"긴 초안 ".repeat(20_000)}\n`)
  const long = await typeQueries(page, textarea, queries)

  // fs.find round trips through the Vite proxy on the big workspace, warm index.
  const directory = encodeURIComponent(state.workspace)
  const find: number[] = []
  for (const query of ["mod1", "pkg2/mod3", "big/pkg4", "index", "라우", "plan", "mod59", "pkg49"]) {
    const started = performance.now()
    const response = await request.get(
      `/api/fs/find?location[directory]=${directory}&query=${encodeURIComponent(query)}&limit=20`,
    )
    expect(response.ok()).toBe(true)
    find.push(performance.now() - started)
  }

  const report = { short, long, fsFind: { p50: p(find, 0.5), p95: p(find, 0.95), files: state.bigFiles } }
  console.log(`COMPOSER_EXT_PERF ${JSON.stringify(report)}`)
  test.info().annotations.push({ type: "perf", description: JSON.stringify(report) })
  // PF2: processing p95 ≤ 16 ms over every counted event, with a short and with a very long draft.
  expect(short.handlers.events).toBeGreaterThan(40)
  expect(short.handlers.p95).toBeLessThanOrEqual(16)
  expect(long.handlers.p95).toBeLessThanOrEqual(16)
  // PF2 event→paint p95 ≤ 33 ms for normal drafts.
  expect(short.eventToPaintP95).toBeLessThanOrEqual(33)
  // 80 ms debounce + a warm fs.find: the list follows typing quickly (Playwright polling included).
  expect(short.listAfterLastKey.max).toBeLessThan(1_000)
})
