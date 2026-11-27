// PF1 (web variant, 03 §20.1): navigationStart → `own:sessions-visible` (first session rows painted, two rAFs after
// the rows landed). A fresh context has no cache (the server list paints); the warm reload paints the IndexedDB
// snapshot first and `own:sessions-fresh` marks the server list replacing it. Ported from upstream
// timeline/home-session-index-benchmark.spec.ts (cached index path) and first-navigation-benchmark.spec.ts.
import type { Page } from "@playwright/test"
import { benchmark, expect } from "./benchmark"
import { benchContext, openApp, perfState } from "./support"

const state = perfState()
benchmark.use({ traceScope: "interaction" })

const MARKS = [
  "own:boot",
  "own:first-paint",
  "own:sessions-visible",
  "own:sessions-fresh",
  "own:accounts-ready",
] as const

benchmark("PF1 session list: cold load, then warm reload from IndexedDB", async ({ page, report }) => {
  await openApp(page, state)
  const list = page.getByTestId("session-list")
  await expect(list.getByText(state.sessions.a.title)).toBeVisible()
  await settledMarks(page)
  const cold = await marks(page)
  // The snapshot is persisted when idle; wait for it like the shell spec does, then reload.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const open = indexedDB.open("own-web")
              open.onsuccess = () => {
                const get = open.result.transaction("session-list").objectStore("session-list").get("local")
                get.onsuccess = () => resolve(get.result?.sessions?.length ?? 0)
                get.onerror = () => resolve(-1)
              }
              open.onerror = () => resolve(-1)
            }),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0)
  await page.reload()
  await expect(list.getByText(state.sessions.a.title)).toBeVisible()
  await settledMarks(page)
  const warm = await marks(page)
  const rows = await list.locator("a").count()
  expect(warm["own:sessions-visible"]).toBeGreaterThan(0)
  report(
    { cold, warm, rows },
    { ...benchContext(page, state), sessions: 5 + state.fillers.length, data: "real server + IndexedDB snapshot" },
  )
})

/** The session list and the own.accounts resync finish independently; both marks are set once per page load. */
async function settledMarks(page: Page) {
  await Promise.all(
    ["own:sessions-fresh", "own:accounts-ready"].map((name) =>
      expect.poll(() => page.evaluate((mark) => performance.getEntriesByName(mark).length, name)).toBe(1),
    ),
  )
}

async function marks(page: Page) {
  const values = await page.evaluate(
    (names) =>
      Object.fromEntries(names.map((name) => [name, performance.getEntriesByName(name)[0]?.startTime ?? null])),
    [...MARKS],
  )
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, value === null ? null : Math.round(value * 10) / 10]),
  ) as Record<(typeof MARKS)[number], number | null>
}
