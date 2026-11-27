// Session header running menu (03 §4.4; upstream 3a861ff8b0, b9db2f6915, ae57dd0cf5) in Edge against the real server:
// a foreground shell stays out, a background shell is listed as `실행 중 1` and Delete on its row stops it; a running
// subagent is `작업 중 1`, its row opens the child session (the menu closes first), and inside the child the parent's
// list leaves the viewed subagent out.
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { idle, openHarness, shots, wt } from "./support"

test.describe.configure({ mode: "serial" })

async function localSession(page: Page, title: string) {
  await wt(page, "home")
  await expect(page.getByTestId("worktree-select")).toContainText("프로젝트 폴더")
  await page.getByTestId("wt-new-input").fill(title)
  await page.getByTestId("wt-create").click()
  await expect(page.getByTestId("wt-header")).toContainText(title, { timeout: 60_000 })
  const id = (await wt<string>(page, "current"))!
  await idle(page, id)
  return id
}

test("a background shell is listed in the header and Delete on its row stops it", async ({ page }) => {
  const errors = await openHarness(page)
  const id = await localSession(page, "실행 메뉴 셸")
  const input = page.getByTestId("wt-input")
  await input.fill("[bg-long] 오래 걸리는 명령")
  await input.press("Enter")
  await expect(page.getByTestId("background-blocking")).toBeVisible({ timeout: 30_000 })
  // The foreground shell is the transcript's; the header lists nothing yet.
  const trigger = page.getByTestId("running-menu")
  await expect(trigger).toHaveCount(0)

  await page.getByTestId("background-send").click()
  await expect(trigger).toHaveText(/실행 중 1/, { timeout: 20_000 })
  await idle(page, id)
  await trigger.click()
  const list = page.getByTestId("running-menu-list")
  const item = list.getByTestId("running-item")
  await expect(item).toHaveCount(1)
  await expect(item).toContainText("셸")
  await expect(item).toBeFocused()
  await expect(item).toHaveAttribute("aria-keyshortcuts", "Delete")
  await page.screenshot({ path: path.join(shots(), "running-menu-shell-dark.png") })

  await page.keyboard.press("Delete")
  await expect.poll(() => wt<{ status: string }[]>(page, "shells", id).then((shells) => shells.length)).toBe(0)
  await expect(trigger).toHaveCount(0, { timeout: 20_000 })
  expect(errors).toEqual([])
})

test("a running subagent is `작업 중 1`; its row opens the child, where the parent's list leaves it out", async ({
  page,
}) => {
  const errors = await openHarness(page, "?scheme=light")
  const id = await localSession(page, "실행 메뉴 하위 에이전트")
  const input = page.getByTestId("wt-input")
  await input.fill("[bg-agent] 조사를 맡겨 줘")
  await input.press("Enter")
  const trigger = page.getByTestId("running-menu")
  await expect(trigger).toHaveText(/작업 중 1/, { timeout: 30_000 })
  await trigger.click()
  const item = page.getByTestId("running-menu-list").getByTestId("running-item")
  await expect(item).toContainText("General")
  await expect(item).toContainText("느린 조사")
  await page.screenshot({ path: path.join(shots(), "running-menu-subagent-light.png") })

  await item.click()
  await expect(page.getByTestId("running-menu-list")).toBeHidden()
  await expect.poll(() => wt<string>(page, "current")).not.toBe(id)
  // Inside the child: the only running work is the one on screen.
  await expect(trigger).toHaveCount(0)
  await wt(page, "open", id)
  await idle(page, id)
  expect(errors).toEqual([])
})
