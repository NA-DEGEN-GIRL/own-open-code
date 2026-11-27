// The user's Galaxy S23 Ultra (S23 pass, 2026-11-19; decisions S23, report own/reports/mobile-s23-2026-11-19.md): 384×742
// CSS px at 2.8125 under the phone's bars, 384×420 with the keyboard up. The user's screenshot showed the microphone
// under `모델 @ 계정` in the composer, the model twice (header and composer), `Dee… @ local-flash-mo…` in the header
// beside a wide `⚠ 전체 허용`, and usage lines wrapping to three lines. Runs on the `s23` project only.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"

interface World {
  readonly dev: string
  readonly control: string
  readonly sessions: Readonly<Record<string, string>>
}

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

test.beforeEach(({}, info) => test.skip(info.project.name !== "s23", "the Galaxy S23 Ultra (384 px)"))

async function openSession(page: Page, key: string) {
  const id = world().sessions[key]!
  await page.goto(`/srv/local/s/${id}`)
  await page.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
  await expect(page.getByTestId("running-on").first()).not.toContainText("own-codex", { timeout: 60_000 })
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error("not laid out")
  return value
}

/**
 * Opens the conversation `⋯` and waits for its lazily loaded 문맥 비우기 entries (context-reset/menu.ts): their arrival
 * rebuilds every item, and an item read or scrolled before that could be one just replaced (`not attached`, in full
 * runs on 2026-11-20).
 */
async function openSessionMenu(page: Page) {
  await page.getByTestId("session-menu").tap()
  const menu = page.locator("[popover][role=menu]:popover-open")
  await expect(menu.locator('[data-testid^="session-menu-reset"]').first()).toBeAttached()
  return menu
}

/** The open menu's shortest item, read in one go. */
function shortestItem(page: Page) {
  return page
    .locator("[popover][role=menu]:popover-open")
    .evaluate((menu) =>
      Math.min(...[...menu.querySelectorAll('[role="menuitem"]')].map((item) => Math.round(item.getBoundingClientRect().height))),
    )
}

/** The PC's own window (the world's dev page, `local` scope) asks own.accounts what a phone may not. */
async function pcRpc(page: Page, method: string, input: unknown) {
  const state = world()
  const pc = await page.context().browser()!.newPage({ baseURL: state.dev })
  await pc.goto("/e2e/ime-harness.html")
  const status = await pc.evaluate(
    async (call) => {
      const url = `/api/rpc/own.accounts/${call.method}?location%5Bdirectory%5D=${encodeURIComponent(call.control)}`
      const answer = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: call.input }),
      })
      return answer.status
    },
    { method, input, control: state.control },
  )
  await pc.close()
  expect(status, method).toBe(200)
}

/** Visible buttons of the composer toolbar that overlap another one (the user's microphone under the switcher). */
function overlaps(bar: Locator) {
  return bar.evaluate((root) => {
    const buttons = [...root.querySelectorAll<HTMLElement>("button")].filter((element) => element.checkVisibility())
    return buttons.flatMap((one, index) =>
      buttons.slice(index + 1).flatMap((other) => {
        if (one.contains(other) || other.contains(one)) return []
        const a = one.getBoundingClientRect()
        const b = other.getBoundingClientRect()
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        return x > 0.5 && y > 0.5 ? [`${one.dataset.testid ?? one.className} × ${other.dataset.testid ?? other.className}`] : []
      }),
    )
  })
}

/** Text an ellipsis shortens: its own text is wider than its box (composer/limit-fit.ts `cut`, without the caps). */
function shortened(part: Locator) {
  return part.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return range.getBoundingClientRect().width > element.getBoundingClientRect().width + 0.5
  })
}

test("a conversation: one model control in the header, whole; the toolbar's tools do not overlap", async ({ page }) => {
  await pcRpc(page, "voice.key.set", { provider: "openai", key: "sk-test-mobile-s23-fake" })
  await pcRpc(page, "voice.set", { enabled: true, provider: "openai" })
  try {
    for (const key of ["hud", "level", "enemy"]) {
      await openSession(page, key)
      const bar = page.locator(".own-cp-bar").first()
      await page.getByTestId("voice-start").first().waitFor()
      // The header's pill is the phone's one model control; the composer's button is gone from a bound conversation.
      await expect(page.getByTestId("composer-switcher").first()).toBeHidden()
      expect(await overlaps(bar), key).toEqual([])
      for (const tool of await bar.locator("button:visible").all()) {
        const size = await box(tool)
        expect(Math.round(Math.min(size.width, size.height)), key).toBeGreaterThanOrEqual(44)
      }
      // `모델 @ 계정` whole on the second row, beside the approval mark (no `Dee… @ local-flash-mo…`).
      for (const part of await page.locator('[data-testid="running-on"] > [data-part]').all())
        expect(await shortened(part), `${key} ${await part.textContent()}`).toBe(false)
      const approval = await box(page.getByTestId("approval-pill"))
      expect(approval.width, key).toBeLessThanOrEqual(48)
      const pill = await box(page.getByTestId("running-on-pill"))
      expect(Math.abs(approval.y + approval.height / 2 - (pill.y + pill.height / 2)), key).toBeLessThan(2)
      // Two header rows of 44 px targets, not three: the bulb and the gear moved into ⋯.
      await expect(page.getByTestId("header-ideas")).toBeHidden()
      await expect(page.getByTestId("header-settings")).toBeHidden()
      expect((await box(page.getByTestId("header"))).height, key).toBeLessThanOrEqual(110)
    }
    // A full-approval conversation keeps the warning in its mark's colour and its name.
    await page.getByTestId("approval-pill").tap()
    await page.getByTestId("approval-mode-full").tap()
    await page.getByTestId("approval-confirm-full").tap()
    const full = page.getByTestId("approval-pill")
    await expect(full).toHaveAttribute("data-mode", "full", { timeout: 30_000 })
    await expect(full).toHaveAccessibleName(/전체 허용/)
    expect((await box(full)).width).toBeLessThanOrEqual(48)
    await full.tap()
    await page.getByTestId("approval-menu").getByTestId("approval-mode-ask").tap()
    await expect(full).toHaveAttribute("data-mode", "ask", { timeout: 30_000 })
  } finally {
    await pcRpc(page, "voice.set", { enabled: false })
  }
})

test("the conversation ⋯ holds 아이디어 노트 and 설정 at thumb size", async ({ page }) => {
  await openSession(page, "enemy")
  await openSessionMenu(page)
  await expect(page.getByTestId("session-menu-ideas")).toBeVisible()
  expect(await shortestItem(page)).toBeGreaterThanOrEqual(44)
  await page.getByTestId("session-menu-settings").tap()
  await expect(page.getByTestId("page-settings")).toHaveAttribute("data-section", "general")
})

test("a turn's usage line: one line until tapped, then the whole line and the steps", async ({ page }) => {
  // 레벨 에디터 버그: DeepSeek, a recomputed cost, and a first step that rewrote the cache.
  await openSession(page, "level")
  const footer = page.getByTestId("turn-footer").last()
  const line = footer.locator(".own-seps-in")
  await footer.scrollIntoViewIfNeeded()
  expect((await box(line)).height).toBeLessThan(24)
  await expect(footer.locator('[data-slot="model"]')).toBeHidden()
  await expect(footer.getByTestId("footer-rewrite")).toBeHidden()
  await expect(footer.locator('[data-slot="input"]')).toBeVisible()
  await expect(footer.locator('[data-slot="output"]')).toBeVisible()
  // The rewrite shows as 입력 in the caution colour.
  const warn = await footer.locator('[data-slot="input"]').evaluate((element) => getComputedStyle(element).color)
  const muted = await footer.locator('[data-slot="output"]').evaluate((element) => getComputedStyle(element).color)
  expect(warn).not.toBe(muted)
  // The whole line reads out in any case.
  await expect(footer.locator(".own-foot")).toHaveAccessibleName(/DeepSeek V4\.1 Flash 1017/)
  await footer.locator(".own-foot").tap()
  await expect(footer.locator('[data-slot="model"]')).toBeVisible()
  await expect(footer.getByTestId("footer-rewrite")).toBeVisible()
  await expect(footer.getByTestId("step-table")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})

test("the keyboard up (384×420): one header row, 전송 on screen, the ⋯ menu inside the window", async ({ page }) => {
  await page.setViewportSize({ width: 384, height: 420 })
  await openSession(page, "enemy")
  const header = await box(page.getByTestId("header"))
  expect(header.height).toBeLessThanOrEqual(56)
  await expect(page.getByTestId("running-on-pill")).toBeHidden()
  const send = await box(page.getByTestId("composer-send").first())
  expect(send.y + send.height).toBeLessThanOrEqual(420)
  // The transcript keeps more room than the chrome around it.
  const composer = await box(page.getByTestId("composer"))
  expect(composer.y - (header.y + header.height)).toBeGreaterThan(150)
  const menu = await openSessionMenu(page)
  const open = await box(menu)
  expect(open.y).toBeGreaterThanOrEqual(0)
  expect(open.y + open.height).toBeLessThanOrEqual(420)
  await menu.getByTestId("session-menu-settings").scrollIntoViewIfNeeded()
  await expect(menu.getByTestId("session-menu-settings")).toBeInViewport()
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 384, height: 742 })
  await expect(page.getByTestId("running-on-pill")).toBeVisible()
})
