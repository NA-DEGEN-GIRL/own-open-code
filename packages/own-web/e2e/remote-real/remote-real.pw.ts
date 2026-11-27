// own-web (web fallback, dev path) against the approved real SSH host (04 §20.3 RG13, RG16): reconnect the host
// from the sidebar, open a remote folder, create a session that runs on the host and answers through a PC-only fake
// account leased by the broker, reload. RG16: every request to the host endpoint (127.0.<k>.2) carries own-remote's
// short token and never a cookie or this PC's service password, even with a local `opencode_session_*` cookie set on
// 127.0.0.1; a page on the host endpoint's origin cannot read this PC's API (CORS). Opt-in: OWN_REAL_HOST=dev-host.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { readState, type RealBackendState } from "./support"

test.describe.configure({ mode: "serial" })

const SHOTS = process.env.OWN_WEB_REMOTE_REAL_SHOTS!
const LOOPBACK = /^127\.0\.([1-9]\d{0,2})\.2$/

let state: RealBackendState
let context: BrowserContext
let page: Page
const hostRequests: Array<{ url: string; method: string; cookie: string | null; auth: string | null }> = []
const localCookieSeen: string[] = []
const failed: string[] = []
const consoleText: string[] = []

async function shot(target: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

function group(target: Page) {
  return target.locator(`[data-testid="host-group"][data-host="${state.hostId}"]`)
}

test.beforeAll(async ({ browser }) => {
  const loaded = readState()
  if (!loaded) throw new Error("backend state missing")
  state = loaded
  context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1440, height: 900 } })
  // A local session cookie as the web fallback's pairing would leave it (04 §7.3): host 127.0.0.1, every port.
  const localPort = new URL(state.localServer).port
  await context.addCookies([
    { name: `opencode_session_${localPort}`, value: "rg16-local-cookie-probe", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
    { name: "opencode_session_5422", value: "rg16-local-cookie-probe", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
  ])
  page = await context.newPage()
  page.on("console", (message) => consoleText.push(`${message.type()}: ${message.text()}`))
  page.on("requestfailed", (request) => {
    const url = new URL(request.url())
    // The reload below aborts the open event stream; that is the page leaving, not a blocked request.
    if (url.pathname === "/api/event" && request.failure()?.errorText === "net::ERR_ABORTED") return
    if (LOOPBACK.test(url.hostname)) failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`)
  })
  page.on("request", async (request) => {
    const url = new URL(request.url())
    const headers = await request.allHeaders().catch(() => request.headers())
    if (LOOPBACK.test(url.hostname))
      hostRequests.push({ url: `${url.origin}${url.pathname}`, method: request.method(), cookie: headers.cookie ?? null, auth: headers.authorization ?? null })
    else if (url.hostname === "127.0.0.1" && headers.cookie?.includes("rg16-local-cookie-probe")) localCookieSeen.push(url.pathname)
  })
})

test.afterAll(async () => {
  fs.writeFileSync(
    path.join(state.evidence, "rg13-rg16-web.json"),
    JSON.stringify(
      {
        hostRequests: hostRequests.map((entry) => ({
          ...entry,
          auth: entry.auth ? `${entry.auth.slice(0, 6)}…(${entry.auth.length})` : null,
        })),
        localCookieSeenOn: [...new Set(localCookieSeen)].slice(0, 20),
        failed,
        privateNetworkConsole: consoleText.filter((line) => /private network|local network|Access-Control/i.test(line)),
      },
      null,
      2,
    ),
  )
  await context?.close()
})

test("the approved host is in the sidebar from the host list; reconnect from its menu → ready", async () => {
  await page.goto("/")
  const host = group(page)
  await expect(host).toBeVisible()
  await expect(host.getByTestId("host-header")).toContainText(state.alias)
  await shot(page, "01-sidebar")
  if ((await host.getAttribute("data-status")) !== "ready") {
    await host.getByTestId("host-menu").click()
    await page.getByTestId("host-reconnect").click()
  }
  await expect(host).toHaveAttribute("data-status", "ready", { timeout: 180_000 })
  await expect(host.getByTestId("host-symbol")).toHaveText("●")
  await shot(page, "02-ready")
})

test("remote folder picker → a session on the host answered through the PC-only account", async () => {
  const host = group(page)
  await host.getByTestId("host-menu").click()
  await page.getByTestId("host-open-folder").click()
  const picker = page.getByTestId("remote-picker")
  await expect(picker).toBeVisible()
  await expect(picker.getByTestId("remote-picker-path")).toHaveValue(/^\/home\//)
  await picker.getByTestId("remote-picker-path").fill(state.project)
  await picker.getByTestId("remote-picker-path").press("Enter")
  await expect(picker.getByTestId("remote-picker-crumbs")).toContainText(path.posix.basename(state.project))
  // The picker lists folders only: the repository's .git shows the listing is the host's.
  await expect(picker.locator('[data-testid="remote-picker-entry"][data-name=".git"]')).toBeVisible()
  await picker.getByTestId("remote-picker-choose").click()
  const confirm = picker.getByTestId("remote-picker-confirm")
  await expect(confirm.getByTestId("remote-picker-confirm-path")).toContainText(path.posix.basename(state.project))
  await shot(page, "03-picker")
  await confirm.getByTestId("remote-picker-start").click()
  await expect(page).toHaveURL(new RegExp(`/srv/${state.hostId}/p/`))
  const composer = page.locator("#own-composer-input")
  await composer.fill("실제 원격 호스트에서 안녕")
  await composer.press("Control+Enter")
  await expect(page).toHaveURL(new RegExp(`/srv/${state.hostId}/s/`), { timeout: 60_000 })
  await expect(page.getByTestId("transcript").getByText("alpha 계정으로 온 답 (실제 호스트)").first()).toBeVisible({ timeout: 120_000 })
  await shot(page, "04-remote-session")
})

test("RG13: a reload keeps the remote route and the transcript", async () => {
  const url = page.url()
  await page.reload()
  await expect(page).toHaveURL(url)
  await expect(page.getByTestId("transcript").getByText("alpha 계정으로 온 답 (실제 호스트)").first()).toBeVisible({ timeout: 120_000 })
})

test("RG13/RG16: host requests carry only own-remote's token; no cookie, no local password; nothing stored", async () => {
  expect(hostRequests.length).toBeGreaterThan(0)
  const origins = new Set(hostRequests.map((entry) => new URL(entry.url).origin))
  expect(origins.size).toBe(1)
  for (const entry of hostRequests) {
    expect(entry.cookie).toBeNull()
    if (entry.auth) {
      const secret = atob(entry.auth.replace(/^Basic /, "")).replace(/^opencode:/, "")
      expect(secret).not.toBe(state.localPassword)
      expect(secret).toMatch(/^\d{10}\.[A-Za-z0-9_-]{20,}$/)
    } else expect(["OPTIONS", "GET"]).toContain(entry.method)
  }
  // Control: the same cookie does travel to this PC's own origin (127.0.0.1), so its absence above is the scoping.
  expect(localCookieSeen.length).toBeGreaterThan(0)
  expect(failed).toEqual([])
  const stored = await page.evaluate(() => {
    const dump: string[] = []
    for (const storage of [localStorage, sessionStorage])
      for (let index = 0; index < storage.length; index++) dump.push(`${storage.key(index)}=${storage.getItem(storage.key(index)!)}`)
    return dump.join("\n") + location.href
  })
  for (const entry of hostRequests.filter((item) => item.auth))
    expect(stored).not.toContain(atob(entry.auth!.replace(/^Basic /, "")).replace(/^opencode:/, ""))
  expect(stored).not.toContain(state.localPassword)
  for (const key of state.keys) expect(stored).not.toContain(key)
})

test("RG16: a page on the host endpoint's origin cannot read this PC's API", async () => {
  const origin = new URL(hostRequests[0]!.url).origin
  const other = await context.newPage()
  await other.goto(`${origin}/`).catch(() => undefined)
  expect(new URL(other.url()).origin).toBe(origin)
  const result = await other.evaluate(async (target) => {
    const read = await fetch(`${target}/api/info`, { credentials: "include" })
      .then((response) => `status ${response.status}`)
      .catch((error: unknown) => `blocked ${String(error)}`)
    const preflighted = await fetch(`${target}/api/session`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((response) => `status ${response.status}`)
      .catch((error: unknown) => `blocked ${String(error)}`)
    return { read, preflighted }
  }, state.localServer)
  fs.writeFileSync(path.join(state.evidence, "rg16-cors.json"), JSON.stringify({ origin, localServer: state.localServer, result }, null, 2))
  for (const outcome of [result.read, result.preflighted]) expect(outcome.startsWith("blocked") || outcome === "status 401").toBe(true)
  await other.close()
})
