// 03 §19.11a against the real server: deleting a session from the row `⋯` (the confirmation names it, `취소` has the
// focus, Esc keeps it, `삭제` removes it on the server and leaves its route), the hover `보관` button and the `보관함 ·
// n` entry under the list, the archive's selection (`선택한 n개 삭제…`) and `보관함 비우기…`, and a project of its own
// folder: `프로젝트 보관` hides it with a `보관 취소` toast, `프로젝트 복원` in the archive brings it back, and
// `목록에서 빼고 대화 삭제…` (count, folder, check box) deletes its sessions while the folder and its files stay. Runs
// before sidebar.pw.ts (file order) and leaves the archive empty.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { createSession, openHarness, shots, ux, uxState } from "./support"

test.describe.configure({ mode: "serial" })

const list = (page: Page) => page.getByTestId("session-list")
const row = (page: Page, id: string) => list(page).locator(`[data-testid="session-row"][data-session-id="${id}"]`)
const rowBox = (page: Page, id: string) => row(page, id).locator("xpath=..")
const projectRow = (page: Page, projectID: string) =>
  list(page).locator(`[data-testid="project-row"][data-project-id="${projectID}"]`)

async function rowMenu(page: Page, id: string, item: string) {
  await row(page, id).hover()
  await rowBox(page, id).getByTestId("row-menu-button").click()
  await expect(page.getByTestId("row-menu")).toBeVisible()
  await page.getByTestId("row-menu").getByTestId(item).click()
}

async function projectMenu(page: Page, projectID: string, item: string) {
  await projectRow(page, projectID).hover()
  await projectRow(page, projectID).getByTestId("project-menu").click()
  await page.getByTestId(item).click()
}

const exists = (page: Page, id: string) => ux<boolean>(page, "exists", id)

test("delete: ⋯ → 삭제… names the session with 취소 focused; Esc keeps it; 삭제 removes it and leaves its route", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "지울 세션")
  await rowMenu(page, id, "row-delete")
  const dialog = page.getByTestId("session-delete")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("session-delete-body")).toContainText('"지울 세션" 대화를 영구히 삭제해요')
  await expect(dialog.getByTestId("session-delete-body")).toContainText("하위 에이전트 대화도 함께 삭제돼요")
  await expect(dialog.getByTestId("session-delete-archive-hint")).toBeVisible()
  await expect(dialog.getByTestId("session-delete-cancel")).toBeFocused()
  await page.screenshot({ path: path.join(shots(), "session-delete-dark.png") })
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  expect(await exists(page, id)).toBe(true)

  await rowMenu(page, id, "row-delete")
  await expect(dialog.getByTestId("session-delete-confirm")).toBeEnabled()
  await dialog.getByTestId("session-delete-confirm").click()
  await expect(dialog).toBeHidden()
  await expect(row(page, id)).toHaveCount(0)
  await expect(page.getByText('"지울 세션" 대화를 삭제했어요')).toBeVisible()
  await expect(page.getByTestId("route")).toHaveText("home")
  expect(await exists(page, id)).toBe(false)
  expect(errors).toEqual([])
})

test("archive: the hover button archives; 보관함 · n opens the archive; selection deletes; 보관함 비우기 empties it", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const ids = [
    await createSession(page, "보관 하나"),
    await createSession(page, "보관 둘"),
    await createSession(page, "보관 셋"),
  ]
  for (const id of ids) {
    await row(page, id).hover()
    await rowBox(page, id).getByTestId("row-archive-button").click()
    await expect(row(page, id)).toHaveCount(0)
  }
  await expect(page.getByText('"보관 셋" 대화를 보관했어요')).toBeVisible()
  const entry = page.getByTestId("archive-entry")
  await expect(entry).toHaveText(/보관함 · 3/)
  await entry.click()
  await expect(page.getByTestId("archive-header")).toContainText("보관함 · 3")

  // Selection: clicks select instead of opening; 선택한 2개 삭제… lists both.
  await page.getByTestId("archive-select").click()
  await row(page, ids[0]!).click()
  await row(page, ids[1]!).focus()
  await page.keyboard.press("Space")
  await expect(row(page, ids[0]!)).toHaveAttribute("aria-selected", "true")
  await expect(row(page, ids[1]!)).toHaveAttribute("aria-selected", "true")
  await expect(row(page, ids[2]!)).toHaveAttribute("aria-selected", "false")
  await expect(page.getByTestId("archive-selected")).toHaveText("2개 선택됨")
  await page.screenshot({ path: path.join(shots(), "archive-selection-dark.png") })
  await page.getByTestId("archive-delete-selected").click()
  const dialog = page.getByTestId("session-delete")
  await expect(dialog).toContainText("대화 2개를 삭제할까요?")
  await expect(dialog.getByTestId("session-delete-list")).toContainText("보관 하나")
  await expect(dialog.getByTestId("session-delete-list")).toContainText("보관 둘")
  await dialog.getByTestId("session-delete-confirm").click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText("대화 2개를 삭제했어요")).toBeVisible()
  expect(await exists(page, ids[0]!)).toBe(false)
  expect(await exists(page, ids[1]!)).toBe(false)
  await expect(page.getByTestId("archive-header")).toContainText("보관함 · 1")
  await page.getByTestId("archive-select-done").click()

  // 보관함 비우기…: the count, then nothing left.
  await page.getByTestId("archive-empty-all").click()
  await expect(dialog).toContainText("보관함을 비울까요?")
  await expect(dialog).toContainText("보관함의 대화 1개를 모두 영구히 삭제해요")
  await dialog.getByTestId("session-delete-confirm").click()
  await expect(page.getByTestId("archive-empty")).toBeVisible()
  expect(await exists(page, ids[2]!)).toBe(false)
  await page.getByTestId("archive-back").click()
  await expect(page.getByTestId("archive-entry")).toHaveCount(0)
  expect(errors).toEqual([])
})

test("project: 보관 hides it (보관 취소 undoes), 복원 brings it back, 목록에서 삭제 deletes its sessions, never its files", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const folder = path.join(process.env.OWN_WEB_SESSION_UX_TMP!, `manage-project-${Date.now()}`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, "keep.txt"), "stays")
  const state = uxState()
  const create = (title: string) =>
    ux<string>(page, "create", {
      title,
      providerID: state.account.providerID,
      model: state.model,
      directory: folder,
    })
  const first = await create("프로젝트 대화 하나")
  const second = await create("프로젝트 대화 둘")
  const projectID = await ux<string>(page, "projectOf", first)
  await ux(page, "home")
  await expect(projectRow(page, projectID)).toBeVisible()

  // 프로젝트 보관: the row leaves with both sessions; 보관 취소 brings it back.
  await projectMenu(page, projectID, "project-menu-archive")
  await expect(projectRow(page, projectID)).toHaveCount(0)
  const toast = page.getByText(/프로젝트를 보관했어요\(대화 2개\)/)
  await expect(toast).toBeVisible()
  await page.getByRole("button", { name: "보관 취소" }).last().click()
  // 보관 취소 says `…프로젝트를 복원했어요(대화 2개)` too, for 5 s. It is gone before the 복원 below, which is checked on
  // its own toast (a fast run still had this one on screen, and two matched: merge round 7).
  const undone = page.getByText(/프로젝트를 복원했어요\(대화 2개\)/)
  await expect(undone).toBeVisible()
  await expect(projectRow(page, projectID)).toBeVisible()
  await expect.poll(async () => Object.keys(await ux<object>(page, "metadata", first))).toEqual([])
  await expect(undone).toHaveCount(0)

  // Again, then 프로젝트 복원 from the archive.
  await projectMenu(page, projectID, "project-menu-archive")
  await expect(projectRow(page, projectID)).toHaveCount(0)
  await expect
    .poll(async () => Object.keys(await ux<object>(page, "metadata", second)).toSorted())
    .toEqual(["own.archived", "own.archivedWithProject"])
  await page.getByTestId("archive-entry").click()
  await expect(projectRow(page, projectID).getByTestId("project-archived-tag")).toHaveText("프로젝트 보관됨")
  await projectMenu(page, projectID, "project-menu-restore")
  await expect(page.getByText(/프로젝트를 복원했어요\(대화 2개\)/)).toBeVisible()
  await page.getByTestId("archive-back").click()
  await expect(projectRow(page, projectID)).toBeVisible()

  // 프로젝트 목록에서 삭제…: count, folder, check box first; files stay.
  await projectMenu(page, projectID, "project-menu-delete")
  const dialog = page.getByTestId("project-manage")
  await expect(dialog.getByTestId("project-manage-count")).toHaveAttribute("data-count", "2")
  await expect(dialog.getByTestId("project-manage-disk")).toContainText(folder)
  await expect(dialog.getByTestId("project-manage-cancel")).toBeFocused()
  await expect(dialog.getByTestId("project-manage-confirm")).toBeDisabled()
  await page.screenshot({ path: path.join(shots(), "project-delete-dark.png") })
  await dialog.getByTestId("project-manage-ack").check()
  await expect(dialog.getByTestId("project-manage-confirm")).toHaveText("대화 2개 삭제")
  await dialog.getByTestId("project-manage-confirm").click()
  await expect(dialog).toBeHidden()
  await expect(projectRow(page, projectID)).toHaveCount(0)
  expect(await exists(page, first)).toBe(false)
  expect(await exists(page, second)).toBe(false)
  expect(fs.readFileSync(path.join(folder, "keep.txt"), "utf8")).toBe("stays")
  expect(errors).toEqual([])
})

test("phone width (375 px): the archive bar and the delete dialog fit without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 760 })
  const errors = await openHarness(page)
  const id = await createSession(page, "좁은 화면")
  await row(page, id).click({ button: "right" })
  await page.getByTestId("row-menu").getByTestId("row-archive").click()
  await page.getByTestId("archive-entry").click()
  await page.getByTestId("archive-select").click()
  await row(page, id).click()
  const bar = page.getByTestId("archive-bar")
  await expect(bar).toBeVisible()
  const fits = await bar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  expect(fits).toBe(true)
  await page.getByTestId("archive-delete-selected").click()
  const dialog = page.getByTestId("session-delete")
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: path.join(shots(), "archive-phone-dark.png") })
  await dialog.getByTestId("session-delete-confirm").click()
  await expect(page.getByTestId("archive-empty")).toBeVisible()
  expect(errors).toEqual([])
})
