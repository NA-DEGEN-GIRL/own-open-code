// Swipe gestures (swipe pass, 2026-11-20; src/shell/swipe.ts, report own/reports/visual-polish-2026-11-20.md). Real
// touch input through the DevTools protocol (Input.dispatchTouchEvent), so the browser's own touch-action and
// scrolling decide as on a phone. Runs on `s23` and `fold8-cover` (the phone: the list is a screen) and
// `fold8-main-portrait` (704 px upright: the list is a drawer).
import fs from "node:fs"
import path from "node:path"
import { expect, test, type CDPSession, type Page } from "@playwright/test"

interface World {
  readonly sessions: Readonly<Record<string, string>>
}

const PHONES = ["s23", "fold8-cover"]
const DRAWER = "fold8-main-portrait"

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

test.beforeEach(({}, info) =>
  test.skip(![...PHONES, DRAWER].includes(info.project.name), "the S23, the Fold8's cover and its main screen upright"),
)

async function openSession(page: Page, key: string) {
  const id = world().sessions[key]!
  await page.goto(`/srv/local/s/${id}`)
  await page
    .locator(`[data-testid="transcript-body"][data-session-id="${id}"] [data-slot="session-timeline-scroll"]`)
    .waitFor({ timeout: 60_000 })
  await expect(page.getByTestId("running-on").first()).not.toContainText("own-codex", { timeout: 60_000 })
  // The gesture chunk is loaded once the shell mounted on a touch screen.
  await expect(page.locator("html[data-swipe]")).toBeAttached()
  await page.evaluate(() => document.querySelectorAll<HTMLElement>(".own-sw-toast-close").forEach((close) => close.click()))
  return id
}

/** A finger from `from` to `to` in `ms`, in even steps, then lifted. */
async function swipe(
  page: Page,
  cdp: CDPSession,
  from: [number, number],
  to: [number, number],
  ms = 120,
  settle = true,
) {
  const steps = 10
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] })
  for (let step = 1; step <= steps; step++) {
    const x = from[0] + ((to[0] - from[0]) * step) / steps
    const y = from[1] + ((to[1] - from[1]) * step) / steps
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] })
    await page.waitForTimeout(ms / steps)
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  // A finger is off the glass for a moment before the next tap. A tap 70–150 ms after the touchEnd can land while the
  // page still flings from the swipe's few px of vertical drift, and Chromium turns it into a fling stop with no click
  // (2.2.6-own.12's tier, RL21-T: the work panel's toggle on `s23`). The scrim closes on such a tap anyway
  // (shell/swipe.ts); other buttons are the browser's.
  if (settle) await page.waitForTimeout(300)
}

/** A point in the transcript on plain text (not a code block, a button or a field), near the left edge. */
function plainPoint(page: Page) {
  return page.evaluate(() => {
    const view = document
      .querySelector('[data-slot="session-timeline-scroll"] > .scroll-view__viewport')!
      .getBoundingClientRect()
    for (let y = view.top + 20; y < view.bottom - 20; y += 8) {
      const hit = document.elementFromPoint(40, y)
      if (hit && !hit.closest("pre, button, textarea, input, a, [role=button]") && hit.closest(".scroll-view__viewport"))
        return [40, y] as [number, number]
    }
    throw new Error("no plain point in the transcript")
  })
}

const shell = (page: Page) =>
  page.getByTestId("app").evaluate((app) => ({
    view: app.dataset.phoneView,
    sidebar: app.dataset.sidebar,
    panel: app.dataset.panel,
    // Whatever a gesture drew is handed back to the stylesheet once it settles.
    styled: !!(app.querySelector<HTMLElement>(":scope > .own-sidebar")!.getAttribute("style") ?? ""),
  }))

/** The Android app's back button: what PcActivity asks the page first (src/host/app-bridge.ts). */
const appBack = () => (window as { ownApp?: { back(): boolean } }).ownApp?.back()

test.describe("the phone", () => {
  test.beforeEach(({}, info) => test.skip(!PHONES.includes(info.project.name), "the phone tier"))

  test("a swipe right opens the conversation list and a swipe left goes back; a short slow drag springs back", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page)
    const id = await openSession(page, "enemy")
    const width = page.viewportSize()!.width
    const [x, y] = await plainPoint(page)
    await swipe(page, cdp, [x, y], [x + 50, y + 2], 700)
    await expect.poll(() => shell(page)).toMatchObject({ view: "session", styled: false })
    await swipe(page, cdp, [x, y], [width - 40, y + 6])
    await expect.poll(() => shell(page)).toMatchObject({ view: "list", styled: false })
    await expect(page).toHaveURL(/\/$/)
    const row = page.locator(`[data-testid="session-row"][data-session-id="${id}"]`)
    const middle = (await row.boundingBox())!.y + 10
    await swipe(page, cdp, [width - 40, middle], [20, middle + 4])
    await expect.poll(() => shell(page)).toMatchObject({ view: "session" })
    await expect(page).toHaveURL(new RegExp(`/s/${id}`))
  })

  test("a sideways drag inside a code block scrolls it, a vertical drag scrolls the transcript; neither opens the list", async ({
    page,
  }, info) => {
    const cdp = await page.context().newCDPSession(page)
    await openSession(page, "enemy")
    const code = page.locator('[data-component="markdown-code"] pre').first()
    await code.scrollIntoViewIfNeeded()
    const box = (await code.boundingBox())!
    const y = box.y + box.height / 2
    // The demo's one-line block is wider than the S23 (not the Fold8's cover): a sideways drag scrolls it.
    const wide = await code.evaluate((element) => element.scrollWidth > element.clientWidth)
    expect(wide || info.project.name !== "s23").toBe(true)
    if (wide) {
      await swipe(page, cdp, [box.x + box.width - 60, y], [box.x + 20, y + 2])
      await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    }
    await swipe(page, cdp, [box.x + 20, y], [box.x + box.width - 60, y + 2])
    await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBe(0)
    await expect.poll(() => shell(page)).toMatchObject({ view: "session" })
    const scroller = page.locator('[data-slot="session-timeline-scroll"] > .scroll-view__viewport').first()
    const before = await scroller.evaluate((element) => element.scrollTop)
    const [x, top] = await plainPoint(page)
    // The transcript opens at its end: a finger moving down scrolls it back.
    await swipe(page, cdp, [x + 100, top], [x + 112, top + 200], 200)
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).not.toBe(before)
    await expect.poll(() => shell(page)).toMatchObject({ view: "session", styled: false })
  })

  test("the model sheet closes when dragged down from its top; its list scrolls when dragged up", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    await openSession(page, "enemy")
    await page.getByTestId("running-on-pill").first().tap()
    const sheet = page.locator(".own-sw-sheet")
    await expect(sheet).toBeVisible()
    const list = sheet.locator(".own-sw-col").first()
    const box = (await list.boundingBox())!
    const x = box.x + box.width - 40
    await swipe(page, cdp, [x, box.y + 150], [x + 2, box.y + 60])
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(sheet).toBeVisible()
    await list.evaluate((element) => element.scrollTo(0, 0))
    await expect(list).not.toHaveAttribute("data-scrolled")
    await swipe(page, cdp, [x, box.y + 40], [x + 2, box.y + 400], 160)
    await expect(sheet).toBeHidden()
  })

  test("the work panel closes with a swipe right, and with Back", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    await openSession(page, "enemy")
    await page.getByTestId("panel-toggle").first().tap()
    await expect.poll(() => shell(page)).toMatchObject({ panel: "open" })
    const panel = (await page.getByTestId("panel").boundingBox())!
    await swipe(page, cdp, [panel.x + 60, panel.y + 300], [panel.x + panel.width - 20, panel.y + 304])
    await expect.poll(() => shell(page)).toMatchObject({ panel: "closed" })
    // A person's next tap comes later than the test's: Chromium turns a tap within about 100 ms of a flick into the end
    // of that flick's gesture and sends no click (the touches arrive, the toggle never hears it: the panel stayed
    // closed on the Fold8's cover, 1 run in 10, MBR 2026-11-21).
    await page.waitForTimeout(500)
    await page.getByTestId("panel-toggle").first().tap()
    await expect.poll(() => shell(page)).toMatchObject({ panel: "open" })
    expect(await page.evaluate(appBack)).toBe(true)
    await expect.poll(() => shell(page)).toMatchObject({ panel: "closed", view: "session" })
  })
})

test.describe("the drawer (the Fold8 upright)", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== DRAWER, "the drawer layout"))

  test("a swipe right opens the drawer, a swipe left or the scrim closes it, a short slow drag springs back", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page)
    await openSession(page, "enemy")
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "closed" })
    const [x, y] = await plainPoint(page)
    await swipe(page, cdp, [x, y], [x + 60, y + 2], 700)
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "closed", styled: false })
    await swipe(page, cdp, [x, y], [x + 300, y + 4])
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "open", styled: false })
    const drawer = (await page.getByTestId("sidebar").boundingBox())!
    await swipe(page, cdp, [drawer.width - 30, y], [10, y + 4])
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "closed", styled: false })
    // No pause before the scrim's tap: one in the fling stop's moment must still close (shell/swipe.ts, RL21-T).
    await swipe(page, cdp, [x, y], [x + 300, y + 4], 120, false)
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "open" })
    await page.getByTestId("scrim").tap({ position: { x: page.viewportSize()!.width - 40, y: 200 } })
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "closed" })
  })

  test("Back closes the drawer before it goes back a page", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    const id = await openSession(page, "enemy")
    const [x, y] = await plainPoint(page)
    await swipe(page, cdp, [x, y], [x + 300, y + 4])
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "open" })
    expect(await page.evaluate(appBack)).toBe(true)
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "closed" })
    await expect(page).toHaveURL(new RegExp(`/s/${id}`))
  })

  test("a sideways drag in a code block scrolls it and leaves the drawer closed", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    await openSession(page, "enemy")
    const code = page.locator('[data-component="markdown-code"] pre').first()
    await code.scrollIntoViewIfNeeded()
    const box = (await code.boundingBox())!
    const y = box.y + box.height / 2
    if (await code.evaluate((element) => element.scrollWidth > element.clientWidth)) {
      await swipe(page, cdp, [box.x + box.width - 60, y], [box.x + 20, y + 2])
      expect(await code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    }
    await swipe(page, cdp, [box.x + 20, y], [box.x + box.width - 60, y + 2])
    await expect.poll(() => shell(page)).toMatchObject({ sidebar: "closed" })
  })
})
