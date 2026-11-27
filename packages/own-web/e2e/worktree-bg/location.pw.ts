// 03 §8 세션 폴더 없음 (upstream 4fb800734d, 3e1aa1e58c) in Edge against the real server: a session whose folder was
// deleted gets the notice above the composer once the server answers 404 LocationNotFoundError, and `다른 폴더
// 고르기…` moves it to a folder chosen in the picker; the notice leaves with the move.
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { norm, openHarness, shots, wt } from "./support"

test("a session whose folder is gone shows the notice and moves to a folder chosen in the picker", async ({ page }) => {
  const errors = await openHarness(page)
  const root = path.join(process.env.OWN_WEB_WTBG_TMP!, "location-missing")
  const gone = path.join(root, "gone-folder")
  const next = path.join(root, "next-folder")
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(gone, { recursive: true })
  fs.mkdirSync(next, { recursive: true })
  const id = await wt<string>(page, "createIn", gone, "폴더 없음 테스트")
  fs.rmSync(gone, { recursive: true, force: true })

  // A fresh page resolves the session's folder and gets the typed 404.
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __wt?: { ready(): boolean } }).__wt?.ready() ?? false))
    .toBe(true)
  await wt(page, "open", id)
  const notice = page.getByTestId("location-missing")
  await expect(notice).toContainText("이 대화의 폴더가 없어요")
  await expect(notice.getByTestId("location-missing-path")).toContainText("gone-folder")
  // Not a Git project: only the folder choice.
  await expect(notice.getByTestId("location-missing-worktree")).toHaveCount(0)
  await page.screenshot({ path: path.join(shots(), "location-missing.png") })

  await notice.getByTestId("location-missing-choose").click()
  const picker = page.getByTestId("project-picker")
  await expect(picker).toContainText("대화 폴더 고르기")
  const input = picker.getByTestId("project-path")
  await input.fill(next)
  await input.press("Enter")
  await expect(input).toHaveValue(next)
  await picker.getByTestId("project-choose").click()
  await expect(picker.getByTestId("project-confirm")).toContainText("이 폴더로 대화를 옮길까요?")
  await picker.getByTestId("project-start").click()
  await expect(picker).toBeHidden()

  await expect(page.getByTestId("toast").filter({ hasText: /대화를 next-folder.* 옮겼어요/ })).toBeVisible()
  await expect.poll(async () => norm(await wt<string>(page, "directory", id))).toBe(norm(next))
  await expect(notice).toHaveCount(0)
  expect(errors).toEqual([])
})
