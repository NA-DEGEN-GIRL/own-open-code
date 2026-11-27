// 설정 > MCP 서버 `SSH 호스트에서 쓰기` (04 §13 "MCP", 03 §18.14, MH 2026-11-26) in Edge against the fake-SSH backend
// (backend.ts): a calm summary per host; a server installed without its value stays off until `이 키를 <host>에
// 보내기`; the host's connection test; the bulk review with nothing sent by default; `PC와 다름` after a change on this
// PC and the one-click update; an older host; `AI에게 설치 맡기기` starting a host conversation with the brief whose
// install tool only that conversation sees; a host conversation's dismissible line; the host settings page's line; and
// the section at 360 px without sideways scrolling. The value is scanned for in the page and the host's files.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { backend, providerRequests, SECRET, type BackendState } from "./support"

test.describe.configure({ mode: "serial" })

const SHOTS = process.env.OWN_WEB_MCP_HOSTS_SHOTS!
let state: BackendState
let context: BrowserContext
let page: Page
const pageErrors: string[] = []

async function shot(target: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true })
}

/** PC-side own.accounts call from the test (the same server the page talks to). */
async function pc(method: string, input: unknown) {
  const response = await fetch(new URL(`/api/rpc/own.accounts/${method}`, state.api), {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`opencode:${state.localPassword}`)}`,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(state.control),
    },
    body: JSON.stringify({ input }),
  })
  expect(response.ok).toBe(true)
  return ((await response.json()) as { output: Record<string, unknown> }).output
}

const section = (target: Page) => target.getByTestId("mcp-hosts")
const row = (target: Page, name: string) => section(target).locator(`[data-testid="mcp-hosts-row"][data-name="${name}"]`)

async function openSettings(target: Page) {
  await target.goto("/settings/mcp")
  await expect(section(target)).toBeVisible({ timeout: 120_000 })
  await section(target).locator(`[data-testid="mcp-hosts-host"][data-host="${state.hosts.buildbox}"]`).click()
  await expect(section(target).getByTestId("mcp-hosts-panel")).toHaveAttribute("data-status", "ready", { timeout: 120_000 })
}

async function showRows(target: Page) {
  const toggle = section(target).getByTestId("mcp-hosts-toggle")
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
}

test.beforeAll(async ({ browser }) => {
  state = backend()
  context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on("pageerror", (error) => pageErrors.push(error.message))
})

test.afterAll(async () => {
  await context?.close()
})

test("a host conversation says once which servers the host lacks; closing keeps it closed", async () => {
  await page.goto(`/srv/${state.hosts.buildbox}/s/${state.hostSession}`)
  const hint = page.getByTestId("mcp-host-hint")
  await expect(hint).toBeVisible({ timeout: 180_000 })
  await expect(hint).toContainText("buildbox에 없어요")
  await shot(page, "01-host-conversation-hint")
  await hint.getByTestId("mcp-host-hint-dismiss").click()
  await expect(hint).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId("session-view").first()).toBeVisible()
  await page.waitForTimeout(3_000)
  await expect(page.getByTestId("mcp-host-hint")).toHaveCount(0)
})

test("the section is calm: one summary per host, rows on demand; an older host says so", async () => {
  await openSettings(page)
  const summary = section(page).getByTestId("mcp-hosts-summary")
  await expect(summary.locator('[data-state="ready"]')).toBeVisible()
  await expect(summary.locator('[data-state="pc-only"]')).toContainText("이 PC 전용 1")
  await expect(summary.locator('[data-state="assist"]')).toContainText("AI 도움 필요 1")
  await expect(section(page).getByTestId("mcp-hosts-row")).toHaveCount(0)
  await shot(page, "02-summary")
  await section(page).locator(`[data-testid="mcp-hosts-host"][data-host="${state.hosts.oldbox}"]`).click()
  // Not connected yet, its release is unknown: it offers to connect; connected, it says it needs the update.
  await expect(section(page).getByTestId("mcp-hosts-panel")).toHaveAttribute("data-status", "offline")
  await section(page).getByTestId("mcp-hosts-connect").click()
  await expect(section(page).getByTestId("mcp-hosts-old")).toContainText("예전 판", { timeout: 420_000 })
  await expect(section(page).getByTestId("mcp-hosts-install-all")).toHaveCount(0)
  await shot(page, "03-old-host")
})

test("install without the value: off on the host until it is sent; then its test passes", async () => {
  await openSettings(page)
  await showRows(page)
  const tiny = row(page, "tiny")
  await expect(tiny).toHaveAttribute("data-state", "ready")
  await tiny.getByTestId("mcp-hosts-more").click()
  await expect(tiny.getByTestId("mcp-hosts-reasons")).toContainText("own-tiny-mcp")
  // Nothing is checked to go before the user checks it.
  await expect(tiny.locator('[data-testid="mcp-hosts-value"][data-name="API_KEY"]')).not.toBeChecked()
  await tiny.getByTestId("mcp-hosts-install").click()
  await expect(tiny).toHaveAttribute("data-state", "installed", { timeout: 120_000 })
  await expect(tiny.getByTestId("mcp-hosts-off")).toContainText("값을 보내기 전에는")
  await expect(tiny.getByTestId("mcp-hosts-check")).toContainText("연결 시험 실패")
  await shot(page, "04-installed-off")
  await tiny.getByTestId("mcp-hosts-send").click()
  await expect(tiny.getByTestId("mcp-hosts-off")).toHaveCount(0, { timeout: 60_000 })
  await tiny.getByTestId("mcp-hosts-test").click()
  await expect(tiny.getByTestId("mcp-hosts-check")).toContainText("연결됐어요 · 도구 2개", { timeout: 60_000 })
  await shot(page, "05-sent-and-tested")
})

test("bulk: the review lists what goes and sends nothing unless checked", async () => {
  await openSettings(page)
  await section(page).getByTestId("mcp-hosts-install-all").click()
  const review = page.getByTestId("mcp-hosts-review")
  await expect(review).toBeVisible()
  await expect(review.locator('[data-testid="mcp-hosts-review-row"][data-name="ctx"]')).toBeVisible()
  await expect(review.locator('[data-testid="mcp-hosts-review-row"][data-name="winonly"]')).toHaveCount(0)
  await expect(review.locator('[data-testid="mcp-hosts-review-value"][data-name="Authorization"]')).not.toBeChecked()
  await shot(page, "06-review")
  await review.getByTestId("mcp-hosts-review-confirm").click()
  await expect(review).toHaveCount(0, { timeout: 120_000 })
  await showRows(page)
  await expect(row(page, "ctx")).toHaveAttribute("data-state", "installed", { timeout: 60_000 })
  // Not sent: the address server stays off there.
  await expect(row(page, "ctx").getByTestId("mcp-hosts-off")).toBeVisible()
})

test("a change on this PC shows `PC와 다름`; one click updates the host", async () => {
  await pc("mcp.save", {
    id: state.servers.tiny,
    name: "tiny",
    scope: { type: "global" },
    transport: { type: "local", command: "own-tiny-mcp", args: ["search"], env: [{ name: "API_KEY" }] },
  })
  await openSettings(page)
  await showRows(page)
  const tiny = row(page, "tiny")
  await expect(tiny).toHaveAttribute("data-state", "differs", { timeout: 60_000 })
  await expect(tiny.getByTestId("mcp-hosts-changed")).toContainText("서버 정의가 바뀌었어요")
  await shot(page, "07-differs")
  await tiny.getByTestId("mcp-hosts-update").click()
  await expect(tiny).toHaveAttribute("data-state", "installed", { timeout: 120_000 })
  // The update sent again what had been sent.
  await expect(tiny.getByTestId("mcp-hosts-off")).toHaveCount(0)
})

test("AI에게 설치 맡기기: a host conversation with the brief; only it sees the install tool", async () => {
  await openSettings(page)
  await showRows(page)
  const script = row(page, "script")
  await expect(script).toHaveAttribute("data-state", "assist")
  await script.getByTestId("mcp-hosts-assist-open").click()
  const dialog = page.getByTestId("mcp-hosts-assist")
  await expect(dialog.getByTestId("mcp-hosts-brief")).toContainText("[MCP 서버 설치]")
  await expect(dialog.getByTestId("mcp-hosts-brief")).toContainText("sudo")
  await shot(page, "08-assist-brief")
  const before = providerRequests().length
  await dialog.getByTestId("mcp-hosts-assist-start").click()
  await expect(page).toHaveURL(new RegExp(`/srv/${state.hosts.buildbox}/s/`), { timeout: 180_000 })
  await expect.poll(() => providerRequests().slice(before).some((item) => item.brief), { timeout: 180_000 }).toBe(true)
  const sent = providerRequests().slice(before).filter((item) => item.brief)
  expect(sent.every((item) => item.tool)).toBe(true)
  // Every other request of the run (the host conversation's title, the plain ones) went without the tool.
  expect(providerRequests().filter((item) => !item.brief).every((item) => !item.tool)).toBe(true)
  await shot(page, "09-assist-conversation")
})

test("the host settings page names what the host has and leads to the section", async () => {
  await page.goto("/settings/remote")
  await page.getByTestId("remote-settings-host").filter({ hasText: "buildbox" }).click()
  const line = page.getByTestId("remote-host-mcp")
  await expect(line).toContainText("설치됨 2", { timeout: 60_000 })
  await line.getByTestId("remote-host-mcp-open").click()
  await expect(page).toHaveURL(/\/settings\/mcp/)
  await expect(section(page).getByTestId("mcp-hosts-panel")).toHaveAttribute("data-host", state.hosts.buildbox)
})

test("360 px: the section fits without sideways scrolling", async ({ browser }) => {
  const narrow = await browser.newContext({ locale: "ko-KR", viewport: { width: 360, height: 780 }, hasTouch: true })
  const phone = await narrow.newPage()
  try {
    await openSettings(phone)
    await showRows(phone)
    await row(phone, "tiny").getByTestId("mcp-hosts-more").click()
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const box = await section(phone).boundingBox()
    expect(box!.width).toBeLessThanOrEqual(360)
    await shot(phone, "10-narrow")
  } finally {
    await narrow.close()
  }
})

test("no value in the page, its storage or the host's files", async () => {
  await openSettings(page)
  expect(await page.content()).not.toContain(SECRET)
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(stored).not.toContain(SECRET)
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && !file.endsWith(".db-shm") && entry.name !== "service.lock")
        if (fs.readFileSync(file).includes(SECRET)) hits.push(file)
    }
  }
  walk(state.buildboxHome)
  expect(hits).toEqual([])
  expect(providerRequests().some((item) => (item as { secret?: boolean }).secret)).toBe(false)
  expect(pageErrors).toEqual([])
})
