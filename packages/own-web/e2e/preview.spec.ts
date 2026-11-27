// The production build under `vite preview` (same assets the CLI embeds, P-001/P-002): the CSP meta allows the
// single inline theme script by hash, nothing violates it, the app connects through the proxy, and PF1 is logged.
import { expect, test } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()

test.skip(!state.preview, "run `bun run build` before the e2e backend starts")

test("production build: CSP without violations, cached-first session list, lazy chunks", async ({ page }) => {
  const errors = watchErrors(page)
  const failed: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
  const violations: string[] = []
  await page.exposeFunction("__cspViolation", (text: string) => void violations.push(text))
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (event) =>
      (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(
        `${event.violatedDirective} ${event.blockedURI}`,
      ),
    ),
  )
  await page.goto(state.preview!)
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", /light|dark/)
  for (const session of state.sessions)
    await expect(page.getByTestId("session-list").getByText(session.title)).toBeVisible()
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")

  // Second load paints from IndexedDB; log PF1 marks for the report.
  await page.waitForTimeout(2_500)
  await page.reload()
  await expect(page.getByTestId("session-list").getByText(state.sessions[0]!.title)).toBeVisible()
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName("own:sessions-fresh").length)).toBe(1)
  const marks = await page.evaluate(() =>
    Object.fromEntries(
      ["own:boot", "own:first-paint", "own:sessions-visible", "own:sessions-fresh"].map((name) => [
        name,
        Math.round(performance.getEntriesByName(name)[0]?.startTime ?? -1),
      ]),
    ),
  )
  console.log(`PF1 marks (preview build, warm reload, ms since navigation): ${JSON.stringify(marks)}`)
  expect(marks["own:sessions-visible"]).toBeGreaterThan(0)
  expect(marks["own:sessions-visible"]).toBeLessThan(1_000)

  // Lazy page chunk loads under the CSP too.
  await page.getByTestId("sidebar-accounts").click()
  await expect(page.getByTestId("page-accounts").getByText(state.account.label)).toBeVisible()
  expect(violations).toEqual([])
  // This backend loads no own-remote: `own.remote hosts.list` answers 400 `rpc.unavailable`, which the sidebar shows as
  // no remote hosts (04 §16.1). It loads no own-import either: `own.import health` answers 400 `rpc.unavailable` and
  // the sidebar hides the 다른 도구의 대화 row (09 §6). No own-team: `own.team health` answers 400 `rpc.unavailable`
  // and the project rows show no team button (03 §4.3.1). No own-harness: `own.harness list` answers 400 and the new
  // conversation names no 에이전트 방식, so the server's own default applies (10 §3.8). The browser logs each as a failed
  // resource. Nothing else may fail.
  const allowed: string[] = failed.filter(
    (entry) =>
      entry === "400 /api/rpc/own.remote/hosts.list" ||
      entry === "400 /api/rpc/own.import/health" ||
      entry === "400 /api/rpc/own.team/health" ||
      entry === "400 /api/rpc/own.harness/list",
  )
  expect(failed.filter((entry) => !allowed.includes(entry))).toEqual([])
  const resource = "Failed to load resource: the server responded with a status of 400 (Bad Request)"
  expect(errors.filter((text) => text !== resource)).toEqual([])
  expect(errors.filter((text) => text === resource)).toHaveLength(allowed.length)
})
