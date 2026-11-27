// The Galaxy Z Fold8 and Z Fold8 Ultra folded and unfolded (Fold8 pass, 2026-11-20; decisions FD, report
// own/reports/fold8-2026-11-20.md; sizes in playwright.config.ts). Folded, each cover is a phone (the S23 rules);
// unfolded, the tablet tier on a touch screen is handheld (`data-handheld`): from 840 px the conversation list stays
// beside the conversation, the header keeps one row with `모델 @ 계정` as the one model control, and its idea notes,
// settings and manual move into the conversation `⋯`. Folding and unfolding with a conversation open keeps the draft,
// the place in the transcript, and an open menu (beside its button) or sheet. Runs on the `fold8*` projects only.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"

interface World {
  readonly sessions: Readonly<Record<string, string>>
}

/** Per project: the keyboard-up height, and for a cover the main screen it unfolds to. */
const DEVICES: Readonly<
  Record<string, { readonly keyboard: number; readonly unfolds?: { readonly width: number; readonly height: number } }>
> = {
  "fold8-cover": { keyboard: 380, unfolds: { width: 932, height: 623 } },
  "fold8u-cover": { keyboard: 557, unfolds: { width: 859, height: 873 } },
  "fold8-main": { keyboard: 333 },
  "fold8-main-portrait": { keyboard: 521 },
  "fold8u-main": { keyboard: 543 },
  "fold8u-main-landscape": { keyboard: 488 },
}
const device = (name: string) => DEVICES[name]

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

async function openSession(page: Page, key: string) {
  const id = world().sessions[key]!
  await page.goto(`/srv/local/s/${id}`)
  // The transcript's scroller, not only its body: the body is there a moment before the scroll view inside it, and
  // `place()` read `null` in that moment (2.2.6-own.12's tier, RL21-T).
  await page
    .locator(`[data-testid="transcript-body"][data-session-id="${id}"] .scroll-view__viewport`)
    .waitFor({ timeout: 60_000 })
  await expect(page.getByTestId("running-on").first()).not.toContainText("own-codex", { timeout: 60_000 })
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error("not laid out")
  return value
}

/** Visible buttons of the header and the composer toolbar: any that overlap, and any under 44 px. */
function controls(page: Page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll<HTMLElement>(".own-header, .own-cp-bar")]
    return roots.flatMap((root) => {
      const buttons = [...root.querySelectorAll<HTMLElement>("button")].filter((element) => element.checkVisibility())
      const name = (element: HTMLElement) => element.dataset.testid ?? element.className.slice(0, 32)
      const small = buttons.flatMap((one) => {
        const r = one.getBoundingClientRect()
        return Math.round(Math.min(r.width, r.height)) < 44 ? [`small ${name(one)}`] : []
      })
      const overlaps = buttons.flatMap((one, index) =>
        buttons.slice(index + 1).flatMap((other) => {
          if (one.contains(other) || other.contains(one)) return []
          const a = one.getBoundingClientRect()
          const b = other.getBoundingClientRect()
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          return x > 0.5 && y > 0.5 ? [`${name(one)} × ${name(other)}`] : []
        }),
      )
      return [...small, ...overlaps]
    })
  })
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

/**
 * Text an ellipsis shortens: its text set alone in its font is wider than its box. A range over the text measures the
 * box's own layout, which a fraction of a pixel of flex shrink leaves equal while the paint drops `ol` of
 * `GPT-5.6 Sol` for the ellipsis.
 */
function shortened(part: Locator) {
  return part.evaluate((element) => {
    const style = getComputedStyle(element)
    const probe = document.createElement("span")
    probe.textContent = element.textContent
    probe.style.cssText = `position: fixed; left: -9999px; white-space: pre; font: ${style.font}; letter-spacing: ${style.letterSpacing}`
    document.body.append(probe)
    const whole = probe.getBoundingClientRect().width
    probe.remove()
    return whole > element.getBoundingClientRect().width + 0.02
  })
}

async function pillWhole(page: Page, label: string) {
  for (const part of await page.locator('[data-testid="running-on"] > [data-part]').all())
    expect(await shortened(part), `${label} ${await part.textContent()}`).toBe(false)
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
}

/** The transcript's scroller and the row across its middle: the place a resize must keep in view. */
function place(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="transcript-body"] .scroll-view__viewport')!
    const view = scroller.getBoundingClientRect()
    const middle = view.top + view.height / 2
    const row = [...scroller.querySelectorAll<HTMLElement>("[data-timeline-key]")].find((element) => {
      const r = element.getBoundingClientRect()
      return r.top <= middle && r.bottom > middle
    })
    return {
      key: row?.dataset.timelineKey,
      bottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    }
  })
}

/** Whether the row of `key` is still on screen in the transcript. */
function inView(page: Page, key: string) {
  return page.evaluate((key) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="transcript-body"] .scroll-view__viewport')!
    const view = scroller.getBoundingClientRect()
    const row = scroller.querySelector<HTMLElement>(`[data-timeline-key="${key}"]`)
    if (!row) return false
    const r = row.getBoundingClientRect()
    return r.bottom > view.top + 1 && r.top < view.bottom - 1
  }, key)
}

test.beforeEach(({}, info) => test.skip(!device(info.project.name), "the Galaxy Z Fold8 and Fold8 Ultra"))

test.describe("folded", () => {
  test.beforeEach(({}, info) => test.skip(!device(info.project.name)?.unfolds, "the cover screen"))

  test("a conversation on the cover: two header rows, `모델 @ 계정` whole, 44 px controls, nothing overlaps", async ({
    page,
  }) => {
    for (const key of ["enemy", "hud", "level"]) {
      await openSession(page, key)
      await expect(page.getByTestId("app")).toHaveAttribute("data-tier", "phone")
      await expect(page.getByTestId("composer-switcher").first()).toBeHidden()
      await pillWhole(page, key)
      expect(await controls(page), key).toEqual([])
      const header = await box(page.getByTestId("header"))
      expect(header.height, key).toBeGreaterThan(56)
      expect(header.height, key).toBeLessThanOrEqual(110)
      expect((await box(page.getByTestId("approval-pill"))).width, key).toBeLessThanOrEqual(48)
      await noSidewaysScroll(page)
    }
  })

  test("the keyboard up on the cover: `전송` and the `⋯` menu inside the window, the transcript keeps room", async ({
    page,
  }, info) => {
    const size = page.viewportSize()!
    const keyboard = device(info.project.name)!.keyboard
    await openSession(page, "enemy")
    await page.setViewportSize({ width: size.width, height: keyboard })
    const header = await box(page.getByTestId("header"))
    // Up to 500 px the header keeps one row (S23 pass); the Ultra's taller cover keeps both.
    if (keyboard <= 500) expect(header.height).toBeLessThanOrEqual(56)
    const send = await box(page.getByTestId("composer-send").first())
    expect(send.y + send.height).toBeLessThanOrEqual(keyboard)
    expect((await box(page.getByTestId("composer"))).y - (header.y + header.height)).toBeGreaterThan(120)
    const menu = await box(await openSessionMenu(page))
    expect(menu.y).toBeGreaterThanOrEqual(0)
    expect(menu.y + menu.height).toBeLessThanOrEqual(keyboard)
    await page.keyboard.press("Escape")
    await page.setViewportSize(size)
  })

  test("unfolding and folding with a conversation open keeps the draft, the place, an open menu and the sheet", async ({
    page,
  }, info) => {
    const folded = page.viewportSize()!
    const unfolded = device(info.project.name)!.unfolds!
    await openSession(page, "enemy")
    const input = page.locator("#own-composer-input")
    await input.fill("접었다 펴도 남는 초안")
    // At the end of the conversation, it stays at the end.
    expect((await place(page)).bottom).toBeLessThan(2)
    await page.setViewportSize(unfolded)
    await expect(page.getByTestId("app")).toHaveAttribute("data-tier", "tablet")
    await expect.poll(async () => (await place(page)).bottom).toBeLessThan(2)
    await page.setViewportSize(folded)
    await expect(page.getByTestId("app")).toHaveAttribute("data-tier", "phone")
    // Up in the conversation (a wheel, as a thumb's swipe, leaves the end: a script's scrollTop alone does not), the row
    // on screen stays on screen.
    const view = await box(page.locator('[data-testid="transcript-body"] .scroll-view__viewport'))
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
    await page.mouse.wheel(0, -150)
    await expect.poll(async () => (await place(page)).bottom).toBeGreaterThan(100)
    const before = await place(page)
    expect(before.key).toBeTruthy()
    for (const size of [unfolded, folded]) {
      await page.setViewportSize(size)
      await expect.poll(() => inView(page, before.key!)).toBe(true)
      await expect(input).toHaveValue("접었다 펴도 남는 초안")
    }
    // The conversation `⋯` stays open beside its button.
    const menu = await openSessionMenu(page)
    for (const size of [unfolded, folded]) {
      await page.setViewportSize(size)
      await expect(menu).toHaveCount(1)
      await expect
        .poll(async () => {
          const open = await box(menu)
          const button = await box(page.getByTestId("session-menu"))
          // Below or above its button and within reach of it, inside the window.
          const near =
            open.x + open.width >= button.x - 8 &&
            open.x <= button.x + button.width + 8 &&
            open.y >= 0 &&
            open.y + open.height <= size.height &&
            open.x + open.width <= size.width
          return near || JSON.stringify({ size, open, button })
        })
        .toBe(true)
    }
    await page.keyboard.press("Escape")
    // The model sheet stays open and inside the window.
    await page.getByTestId("running-on-pill").first().tap()
    const sheet = page.getByTestId("switcher")
    await expect(sheet).toBeVisible()
    for (const size of [unfolded, folded]) {
      await page.setViewportSize(size)
      await expect(sheet).toBeVisible()
      const open = await box(sheet)
      expect(open.y).toBeGreaterThanOrEqual(0)
      expect(open.y + open.height).toBeLessThanOrEqual(size.height + 1)
    }
    await page.keyboard.press("Escape")
    await expect(input).toHaveValue("접었다 펴도 남는 초안")
    await input.fill("")
  })
})

test.describe("unfolded", () => {
  test.beforeEach(({}, info) => test.skip(!!device(info.project.name)?.unfolds, "the main screen"))

  test("the list beside the conversation from 840 px, one header row, `모델 @ 계정` whole, 44 px controls", async ({
    page,
  }) => {
    const size = page.viewportSize()!
    const beside = size.width >= 840
    const app = page.getByTestId("app")
    for (const key of ["enemy", "hud", "level"]) {
      await openSession(page, key)
      await expect(app).toHaveAttribute("data-tier", "tablet")
      await expect(app).toHaveAttribute("data-handheld", "")
      await expect(app).toHaveAttribute("data-sidebar-mode", beside ? "column" : "drawer")
      // One model control, as folded: the header pill; the composer's button is gone from a bound conversation.
      await expect(page.getByTestId("composer-switcher").first()).toBeHidden()
      await pillWhole(page, key)
      expect(await controls(page), key).toEqual([])
      expect((await box(page.getByTestId("header"))).height, key).toBeLessThanOrEqual(56)
      // What the device cannot use or reaches from `⋯` gives the conversation its room.
      for (const gone of ["header-ideas", "header-settings", "header-manual", "browser-tool-notice", "git-status-chip"])
        await expect(page.getByTestId(gone).first(), `${key} ${gone}`).toBeHidden()
      await expect(page.locator(".own-workspace-tabs")).toBeHidden()
      await noSidewaysScroll(page)
    }
    const sidebar = page.getByTestId("sidebar")
    if (beside) {
      // The list stays beside the conversation while another one opens from it.
      expect((await box(sidebar)).x + (await box(sidebar)).width).toBeLessThanOrEqual((await box(page.getByTestId("main"))).x + 1)
      await sidebar.getByText("적 AI 길찾기 고치기").first().tap()
      await expect(page.getByTestId("header-title")).toContainText("적 AI 길찾기 고치기")
      // Its row is still on screen beside the conversation (the list may have scrolled to it: the phone tests of the
      // run before add conversations at its top).
      await expect(sidebar.getByTestId("session-row").filter({ hasText: "적 AI 길찾기 고치기" }).first()).toBeInViewport()
    }
    if (!beside) {
      await page.getByTestId("sidebar-toggle").tap()
      await expect(app).toHaveAttribute("data-sidebar", "open")
      await sidebar.getByText("적 AI 길찾기 고치기").first().tap()
      await expect(page.getByTestId("header-title")).toContainText("적 AI 길찾기 고치기")
      await expect(app).toHaveAttribute("data-sidebar", "closed")
    }
    // The header's idea notes and settings are in the conversation `⋯`.
    await openSessionMenu(page)
    await expect(page.getByTestId("session-menu-ideas")).toBeVisible()
    await expect(page.getByTestId("session-menu-project-notes")).toBeVisible()
    const shortest = await page
      .locator("[popover][role=menu]:popover-open")
      .evaluate((menu) =>
        Math.min(...[...menu.querySelectorAll('[role="menuitem"]')].map((item) => Math.round(item.getBoundingClientRect().height))),
      )
    expect(shortest).toBeGreaterThanOrEqual(44)
    await page.getByTestId("session-menu-settings").tap()
    await expect(page.getByTestId("page-settings")).toHaveAttribute("data-section", "general")
  })

  test("the keyboard up: the same layout, one header row, `전송` on screen, the transcript keeps room", async ({
    page,
  }, info) => {
    const size = page.viewportSize()!
    const keyboard = device(info.project.name)!.keyboard
    await openSession(page, "enemy")
    const mode = await page.getByTestId("app").getAttribute("data-sidebar-mode")
    await page.setViewportSize({ width: size.width, height: keyboard })
    await page.locator("#own-composer-input").tap()
    // Typing does not flip the list into a drawer.
    await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar-mode", mode!)
    const header = await box(page.getByTestId("header"))
    expect(header.height).toBeLessThanOrEqual(56)
    const send = await box(page.getByTestId("composer-send").first())
    expect(send.y + send.height).toBeLessThanOrEqual(keyboard)
    expect((await box(page.getByTestId("composer"))).y - (header.y + header.height)).toBeGreaterThan(100)
    expect(await controls(page)).toEqual([])
    const menu = await box(await openSessionMenu(page))
    expect(menu.y).toBeGreaterThanOrEqual(0)
    expect(menu.y + menu.height).toBeLessThanOrEqual(keyboard)
    await page.keyboard.press("Escape")
    await page.setViewportSize(size)
  })
})
