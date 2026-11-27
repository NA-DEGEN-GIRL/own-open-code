// Screenshots of the workspace at the three reference widths (1724, 1280, 375), with and without the fake browser
// pane, for the before/after comparison of the split view (own/.out/split-view/<tag>-*.png, not committed). Only UI
// that exists before and after is driven (session row, Ctrl+Shift+B), so the same file runs on both.
//   OWN_WEB_SPLIT_SHOT_TAG=before bunx playwright test --config e2e/split-view/playwright.config.ts screens
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

const shots = process.env.OWN_WEB_SPLIT_SHOTS!
const tag = process.env.OWN_WEB_SPLIT_SHOT_TAG ?? "after"
fs.mkdirSync(shots, { recursive: true })

async function open(page: Page, query: string) {
  await page.goto(`/e2e/split-view/harness.html${query}`)
  await expect(page.getByTestId("sidebar")).toContainText("알파 작업", { timeout: 60_000 })
  await page.getByTestId("session-list").getByText("알파 작업").click()
  await expect(page.getByTestId("header-title")).toHaveText("알파 작업")
}

for (const width of [1724, 1280, 375]) {
  test(`workspace at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 960 })
    await open(page, "")
    if (width === 375) await expect(page.getByTestId("app")).toHaveAttribute("data-phone-view", "session")
    await page.screenshot({ path: path.join(shots, `${tag}-${width}-web.png`) })
    await open(page, "?pane")
    await page.keyboard.press("Control+Shift+KeyB")
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(shots, `${tag}-${width}-pane-browser.png`) })
  })
}
