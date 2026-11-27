// Web fallback check (01 §6.1 "웹 폴백", G11 subset on the local channel): the real server from source serves the
// own-web production build itself through P-002 (`OPENCODE_WEB_APP=own-web` → packages/own-web/dist), and a browser
// signs in with a pairing link (HttpOnly same-origin cookie, never `?auth_token=`), exactly as `own open --browser`
// will. Checks in the installed Edge: pairing redirect + control fragment, the app and the session list over the
// cookie, own.accounts RPC, a streamed answer, path-route reload through the SPA fallback, the server CSP header, and
// zero CSP violations / page errors (markdown worker included).
//
//   bun run build && bun dev/web-fallback-check.ts [--shots <dir>] [--headed]
//
// Fake credentials only (dev/service.ts); prints a JSON report and exits 1 when a check fails.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { chromium, type Page } from "@playwright/test"
import { startDevService } from "./service"

const args = parseArgs({
  options: { shots: { type: "string" }, headed: { type: "boolean", default: false } },
}).values
const PACKAGE = path.resolve(import.meta.dirname, "..")
const shots = args.shots ?? path.join(os.tmpdir(), "own-web-fallback")
if (!(await Bun.file(path.join(PACKAGE, "dist/index.html")).exists()))
  throw new Error("no production build: run `bun run build` in packages/own-web first")
await fs.mkdir(shots, { recursive: true })

const checks: { name: string; ok: boolean; detail?: unknown }[] = []
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail })

// own.remote and own.harness too, as in a release config (launcher 0.2.0; own.harness last, 10 H0): the page's host
// list and its harness list must answer, not 400.
const service = await startDevService({ env: { OPENCODE_WEB_APP: "own-web" }, remote: true, harness: true })
const browser = await chromium.launch({ channel: "msedge", headless: !args.headed })
let current: Page | undefined
const errors: string[] = []
try {
  const origin = service.server.url
  const index = await fetch(`${origin}/`)
  const csp = index.headers.get("content-security-policy") ?? ""
  const html = await index.text()
  check(
    "server serves own-web dist (P-002)",
    index.ok && html.includes('id="oc-theme-preload-script"') && html.includes("/_assets/"),
    {
      status: index.status,
    },
  )
  check(
    "server CSP hashes the theme preload script",
    /script-src 'self' 'wasm-unsafe-eval' 'sha256-[^']+'/.test(csp),
    csp,
  )
  const unauthenticated = await fetch(`${origin}/api/session`)
  check("API refuses a request without credentials", unauthenticated.status === 401, unauthenticated.status)

  const paired = (await service.server.call("POST", "/api/pair")) as { code?: string; data?: { code?: string } }
  const code = paired.code ?? paired.data?.code
  if (!code) throw new Error(`no pairing code in ${JSON.stringify(paired)}`)

  const context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __cspViolations: string[] }).__cspViolations = seen
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  const page = await context.newPage()
  current = page
  errors.length = 0
  const urls: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("request", (request) => urls.push(request.url()))
  // Which request a "Failed to load resource" console error belongs to (no query strings: they may carry ids only).
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`)
  })

  // The launcher's link: the server consumes the code, sets the cookie and redirects to "/"; the browser keeps the
  // fragment across the redirect, so the control location arrives as `#control=` (02 §9.1).
  await page.goto(`${origin}/auth/connect/${code}#control=${encodeURIComponent(service.control)}`)
  await page.waitForURL((url) => url.origin === origin && url.pathname === "/")
  const cookies = await context.cookies(origin)
  check(
    "pairing sets an HttpOnly SameSite=Lax session cookie",
    cookies.some(
      (cookie) => cookie.name.startsWith("opencode_session_") && cookie.httpOnly && cookie.sameSite === "Lax",
    ),
    cookies.map((cookie) => ({ name: cookie.name, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite })),
  )
  const list = page.getByTestId("session-list")
  await list.getByText(service.sessions[0]!.title).waitFor({ timeout: 30_000 })
  check("session list over the cookie", true)
  await page.getByTestId("accounts-in-use").getByText("Alpha").waitFor({ timeout: 15_000 })
  check("own.accounts RPC over the cookie (accounts in use)", true)
  await page.screenshot({ path: path.join(shots, "fallback-home.png") })

  const session = service.sessions.find((item) => item.title === "own-web 뼈대") ?? service.sessions[0]!
  await list.getByText(session.title).click()
  await page.waitForURL(new RegExp(`/srv/local/s/${session.id}$`))
  const composer = page.locator("#own-composer-input")
  await composer.fill("웹 폴백에서 보내는 메시지")
  await composer.press("Control+Enter")
  await page.getByTestId("transcript").getByText("가짜 provider가 만든 문장").first().waitFor({ timeout: 60_000 })
  check("prompt and streamed answer over the cookie", true)
  await page.screenshot({ path: path.join(shots, "fallback-session.png") })

  // Path routes survive a reload through the WebUi SPA fallback (01 §6.2).
  await page.reload()
  await page.getByTestId("transcript").getByText("웹 폴백에서 보내는 메시지").first().waitFor({ timeout: 30_000 })
  check(
    "path-route reload restores the session (SPA fallback)",
    page.url().endsWith(`/srv/local/s/${session.id}`),
    page.url(),
  )

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)
  check("no CSP violations (workers included)", violations.length === 0, violations)
  check("no page errors", errors.length === 0, errors.length === 0 ? errors : { errors, failedResponses })
  check(
    "no credentials in URLs (?auth_token=, /api/pair)",
    !urls.some((url) => url.includes("auth_token") || url.includes("/api/pair")),
  )
  const workers = page.workers().map((worker) => worker.url())
  check(
    "markdown worker is a same-origin file",
    workers.every((url) => url.startsWith(`${origin}/_assets/`)),
    workers,
  )
  await context.close()
} catch (error) {
  check("walkthrough completed", false, {
    error: error instanceof Error ? error.message.split("\n")[0] : String(error),
    url: current?.url(),
    errors,
    text: await current
      ?.locator("body")
      .innerText()
      .then((text) => text.slice(0, 400))
      .catch(() => undefined),
  })
  await current?.screenshot({ path: path.join(shots, "fallback-failure.png") }).catch(() => undefined)
} finally {
  await browser.close()
  await service.stop()
}

const failed = checks.filter((item) => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, shots, checks }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
