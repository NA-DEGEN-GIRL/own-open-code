// Shared steps of the team suites (2026-10-16): the `팀 모드 켜기…` dialog every enable entry point opens now, and the
// area menu's folded `구성 바꾸기 ▸` group that the structural items sit in.
import { expect, type Locator, type Page } from "@playwright/test"

/** The items inside `구성 바꾸기 ▸` (team/view-model.ts `AREA_GROUPS`). */
const STRUCTURE = new Set([
  "area-menu-rename",
  "area-menu-split",
  "area-menu-merge",
  "area-menu-convert",
  "area-menu-move",
])

/**
 * Confirms the `팀 모드 켜기…` dialog an entry point opened, with an optional goal and 영역 폴더 (06 §4.12: `inside`,
 * the default, or `beside`); it closes before enable runs.
 */
export async function enableTeam(
  page: Page,
  options: { readonly goal?: string; readonly root?: "inside" | "beside" } = {},
) {
  const dialog = page.getByTestId("team-enable")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("team-enable-root-inside")).toBeChecked()
  if (options.goal !== undefined) await dialog.getByTestId("team-enable-goal").fill(options.goal)
  if (options.root === "beside") await dialog.getByTestId("team-enable-root-beside").check()
  await dialog.getByTestId("team-enable-submit").click()
  await expect(dialog).toHaveCount(0)
}

/** Clicks an item of an open area menu, unfolding `구성 바꾸기 ▸` first when the item is inside it. */
export async function areaMenuItem(menu: Locator, item: string) {
  if (STRUCTURE.has(item)) {
    const group = menu.getByTestId("area-menu-group-structure")
    if ((await group.getAttribute("aria-expanded")) !== "true") await group.click()
  }
  await menu.getByTestId(item).click()
}
