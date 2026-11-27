// `탐색기에서 열기` (03 §19.5, 05 §7.10) must not exist where the page is not on the PC whose folders it shows: the
// phone and a 원격 PC window both get the gateway's page (the mobile host, `auth: "device"`), whose host has no
// `explorer`. Runs on a phone (`s23`) and on an unfolded foldable (`fold8u-main`, the handheld tablet layout).
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

interface World {
  readonly sessions: Readonly<Record<string, string>>
}

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

test.beforeEach(({}, info) =>
  test.skip(!["s23", "fold8u-main"].includes(info.project.name), "one phone and one unfolded foldable"),
)

async function openSession(page: Page, key: string) {
  const id = world().sessions[key]!
  await page.goto(`/srv/local/s/${id}`)
  await page.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
}

test("a paired device has no 탐색기에서 열기: the folder is on the PC, not here", async ({ page }) => {
  await openSession(page, "enemy")
  await page.getByTestId("session-menu").tap()
  const menu = page.locator("[popover][role=menu]:popover-open")
  // The menu's lazy entries rebuild every item when they arrive: wait for them before reading it.
  await expect(menu.locator('[data-testid^="session-menu-reset"]').first()).toBeAttached()
  await expect(menu.getByRole("menuitem").first()).toBeVisible()
  await expect(menu.getByTestId("session-menu-explorer")).toHaveCount(0)
  await expect(menu.getByRole("menuitem", { name: /탐색기/ })).toHaveCount(0)
  // The lazy chunk was never asked for: nothing of it is on this page.
  const loaded = await page.evaluate(() =>
    performance.getEntriesByType("resource").some((entry) => /\/explorer\/actions/.test(entry.name)),
  )
  expect(loaded).toBe(false)
})
