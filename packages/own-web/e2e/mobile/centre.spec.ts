// Icon marks in the middle of their buttons (visual polish, 2026-11-20; report own/reports/visual-polish-2026-11-20.md).
// The user saw the composer's `✦` (skills) and `⋯` (more tools) drawn left of their 44 px buttons on the Galaxy S23
// Ultra: text glyphs at the start of an inline-flex box that a touch screen widens, and a symbol font that sets `⋯` on
// the math axis and `＋` low. This reads the pixels: each button's screenshot, the ink against the button's own
// background, and the ink's middle against the box's, within 1 px. Runs on `s23`, `fold8-cover` and `desktop`.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { centred } from "./ink"

interface World {
  readonly sessions: Readonly<Record<string, string>>
}

const PROJECTS = ["s23", "fold8-cover", "desktop"]

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

test.beforeEach(({}, info) => test.skip(!PROJECTS.includes(info.project.name), "the S23, the Fold8's cover, a desktop"))

async function openSession(page: Page, key: string) {
  const id = world().sessions[key]!
  await page.goto(`/srv/local/s/${id}`)
  await page.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
  await expect(page.getByTestId("running-on").first()).not.toContainText("own-codex", { timeout: 60_000 })
  // Toasts (a model the demo world no longer offers) sit over the header on a touch screen.
  await page.evaluate(() => document.querySelectorAll<HTMLElement>(".own-sw-toast-close").forEach((close) => close.click()))
  await page.mouse.move(0, 0)
}

test("the composer's marks (+, ✦, ⋯) and the header's icons sit in the middle of their buttons", async ({ page }, info) => {
  await openSession(page, "enemy")
  const bar = page.locator(".own-cp-bar").first()
  await centred(page, bar.getByTestId("attach-button"), "+")
  await centred(page, bar.getByTestId("skills-button"), "✦")
  // `⋯` (the folded tools) shows where the composer folds them: below 720 px, and on a touch screen below 800 px.
  if (info.project.name !== "desktop") await centred(page, bar.getByTestId("composer-more"), "composer ⋯")
  const header = page.getByTestId("header")
  await centred(page, header.getByTestId("session-menu"), "header ⋯")
  await centred(page, header.getByTestId("panel-toggle"), "panel")
  await centred(page, header.getByTestId("chat-view-menu"), "대화 보기")
})

test("the model sheet's or popover's close mark sits in the middle of its button", async ({ page }) => {
  await openSession(page, "enemy")
  const pill = page.getByTestId("running-on-pill").first()
  await ((await pill.isVisible()) ? pill.click() : page.getByTestId("composer-switcher").first().click())
  await centred(page, page.getByTestId("switcher").locator(".own-sw-head .own-sw-icon"), "×")
})

test("the conversation list's project marks sit in the middle of their buttons", async ({ page }, info) => {
  await openSession(page, "enemy")
  if (info.project.name !== "desktop") {
    await page.getByTestId("header-back").tap()
    await page.getByTestId("session-row").first().waitFor()
  }
  const project = page.getByTestId("project-row").first()
  await project.hover()
  await centred(page, project.getByTestId("project-menu"), "project ⋯")
  await centred(page, project.getByTestId("project-new-session"), "project +")
  // The worktree mark is a 44 px target on a touch screen; with a mouse it only shows on the open project.
  if (info.project.name !== "desktop") await centred(page, project.getByTestId("project-worktree-button"), "project ⑂")
})
