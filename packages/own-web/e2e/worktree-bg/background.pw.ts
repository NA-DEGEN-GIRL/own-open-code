// Background jobs (03 §19.7, 01 §17.1 #23) in Edge against the real server: a running shell tool shows in the dock,
// Alt+B (composer; Ctrl+B stays the sidebar) sends it to the background (`session.background`), the `⧗ 백그라운드 n`
// list, the output view (터미널처럼), `종료` (`shell.remove`), the sidebar `⧗`, and a background shell that finishes:
// toast `… — 끝났습니다 (exit 0) · 출력 보기` (03 §9).
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { idle, openHarness, shots, wt, wtState } from "./support"

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

test("Alt+B sends the running shell to the background; list, output view, stop", async ({ page }) => {
  const errors = await openHarness(page)
  const state = wtState()
  const id = await localSession(page, "백그라운드 세션")

  const input = page.getByTestId("wt-input")
  await input.fill("[bg-long] 오래 걸리는 명령")
  await input.press("Enter")
  const blocking = page.getByTestId("background-blocking")
  await expect(blocking).toContainText(`실행 중: ${state.commands.long.slice(0, 20)}`, { timeout: 30_000 })
  await expect(page.getByTestId("background-send")).toContainText("Alt+B")
  await page.screenshot({ path: path.join(shots(), "background-blocking-dark.png") })

  // Ctrl+B in the composer does nothing here (sidebar key, not in the composer); Alt+B moves the shell.
  await input.focus()
  await page.keyboard.press("Control+b")
  await expect(blocking).toBeVisible()
  await page.keyboard.press("Alt+b")
  await expect(blocking).toBeHidden({ timeout: 20_000 })
  const toggle = page.getByTestId("background-toggle")
  await expect(toggle).toContainText("백그라운드 1")
  // The tool returned "moved to the background"; the turn ends while the shell keeps running.
  await idle(page, id)
  await expect(
    page.getByTestId("wt-row").filter({ hasText: "백그라운드 세션" }).getByTestId("wt-row-background"),
  ).toBeVisible()

  await toggle.click()
  const item = page.getByTestId("background-item")
  await expect(item).toHaveCount(1)
  await expect(item).toContainText("셸")
  await page.screenshot({ path: path.join(shots(), "background-list-dark.png") })

  await item.getByTestId("background-item-output").click()
  const view = page.getByTestId("background-output")
  await expect(view).toBeVisible()
  await expect(view.getByTestId("background-output-status")).toHaveText("실행 중")
  await expect(view.getByTestId("background-output-text")).toContainText("tick 1", { timeout: 15_000 })
  await page.screenshot({ path: path.join(shots(), "background-output-dark.png") })
  await page.keyboard.press("Escape")
  await expect(view).toBeHidden()

  await item.getByTestId("background-stop").click()
  await expect(page.getByTestId("background-dock")).toBeHidden({ timeout: 20_000 })
  await expect.poll(() => wt<{ status: string }[]>(page, "shells", id).then((list) => list.length)).toBe(0)
  // Stopped by the user: no "끝났어요" toast.
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId("toast").filter({ hasText: "끝났어요" })).toHaveCount(0)
  expect(errors).toEqual([])
})

test("a background shell that finishes: toast with 출력 보기, exit code in the viewer (light)", async ({ page }) => {
  const errors = await openHarness(page, "?scheme=light")
  await localSession(page, "끝나는 작업")
  const input = page.getByTestId("wt-input")
  await input.fill("[bg-quick] 짧은 명령")
  await input.press("Enter")
  const toast = page.getByTestId("toast").filter({ hasText: "끝났어요 (exit 0)" })
  await expect(toast).toBeVisible({ timeout: 45_000 })
  await page.screenshot({ path: path.join(shots(), "background-done-light.png") })
  await toast.getByRole("button", { name: "출력 보기" }).click()
  const view = page.getByTestId("background-output")
  await expect(view.getByTestId("background-output-status")).toHaveText("끝남 (exit 0)")
  await expect(view.getByTestId("background-output-text")).toContainText("tick 3")
  await page.screenshot({ path: path.join(shots(), "background-output-light.png") })
  await view.getByTestId("background-output-close").click()
  await expect(view).toBeHidden()
  expect(errors).toEqual([])
})

// Since upstream v2.3.0 (#63382) a subagent always runs in the background: nothing blocks, so there is no
// `background-send` step; it shows under 백그라운드 at once.
test("a running subagent is background work: 열기 → its session, toast when it finishes", async ({ page }) => {
  const errors = await openHarness(page)
  const id = await localSession(page, "하위 에이전트 대화")
  const input = page.getByTestId("wt-input")
  await input.fill("[bg-agent] 조사를 맡겨 줘")
  await input.press("Enter")
  await expect(page.getByTestId("background-toggle")).toContainText("백그라운드 1", { timeout: 30_000 })
  await idle(page, id)
  await page.getByTestId("background-toggle").click()
  const item = page.getByTestId("background-item")
  await expect(item).toContainText("하위 에이전트")
  await expect(item).toContainText("느린 조사")
  await expect(item.getByTestId("background-open")).toBeVisible()
  const toast = page.getByTestId("toast").filter({ hasText: "하위 에이전트가 끝났어요" })
  await expect(toast).toBeVisible({ timeout: 45_000 })
  await toast.getByRole("button", { name: "열기" }).click()
  await expect.poll(() => wt<string>(page, "current")).not.toBe(id)
  expect(errors).toEqual([])
})
