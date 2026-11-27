// Worktree flow (03 §19.3, 01 §17.1 #19) in Edge against the real server: new session in a new worktree from a base
// branch with the project's startup script, `⑂` sidebar group, move to another place (`session.move`, location
// follows), a new session in an existing worktree, the cleanup confirmation with git's force-required refusal, and the
// cleanup guard (06 §10.4 #5, TG13 (a)(b)(c)) on the backend's wt-nested, wt-locked and wt-ignored worktrees.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { idle, norm, openHarness, shots, wt, wtState } from "./support"

test.describe.configure({ mode: "serial" })

const SCRIPT = "echo own-start> started.txt"
let created = ""

async function newSession(page: Page, text: string) {
  await wt(page, "home")
  await page.getByTestId("wt-new-input").fill(text)
  await page.getByTestId("wt-create").click()
  await expect(page.getByTestId("wt-header")).toContainText(text, { timeout: 90_000 })
  return (await wt<string>(page, "current"))!
}

test("new session in a new worktree: base branch, startup script, ⑂ group", async ({ page }) => {
  const errors = await openHarness(page)
  const state = wtState()
  const select = page.getByTestId("worktree-select")
  await expect(select).toContainText("프로젝트 폴더")
  await expect(select).toHaveAttribute("aria-label", "작업 위치: 프로젝트 폴더")

  await select.click()
  const pop = page.getByTestId("worktree-popover")
  await expect(pop.getByTestId("worktree-picker")).toBeVisible()
  await pop.getByTestId("worktree-option-new").click()
  const base = pop.getByTestId("worktree-base")
  await expect(base).toContainText("현재 브랜치 (main)")
  await expect(base.getByTestId("worktree-base-option").filter({ hasText: "feature-x" })).toBeVisible()
  // Server-side branch search, IME-safe input.
  await base.getByTestId("worktree-base-search").fill("feat")
  await expect(base.getByTestId("worktree-base-option")).toHaveCount(1)
  await base.getByTestId("worktree-base-option").filter({ hasText: "feature-x" }).click()

  // Startup script: saved on the project (`commands.start`), applies to every new worktree.
  const script = pop.getByTestId("worktree-script")
  await script.fill(SCRIPT)
  await pop.getByTestId("worktree-script-save").click()
  await expect(page.getByTestId("toast").filter({ hasText: "시작 스크립트를 저장했어요" })).toBeVisible()
  await page.screenshot({ path: path.join(shots(), "worktree-picker-dark.png") })
  await page.keyboard.press("Escape")
  await expect(pop).toBeHidden()
  await expect(select).toContainText("새 작업 폴더 · feature-x")

  const id = await newSession(page, "워크트리 세션")
  await expect(page.getByTestId("toast").filter({ hasText: "만들었어요" })).toBeVisible()
  created = (await wt<string>(page, "directory", id))!
  expect(norm(created)).not.toBe(norm(state.gitProject))
  // Made from feature-x, and the server ran the startup script inside it before answering.
  expect(fs.existsSync(path.join(created, "FEATURE.md"))).toBe(true)
  expect(fs.existsSync(path.join(created, "started.txt"))).toBe(true)
  await expect(page.getByTestId("wt-place")).toContainText(`⑂ ${path.basename(created)}`)
  // Sidebar: the session sits in a ⑂ group of the project.
  const group = page.getByTestId("wt-group").filter({ hasText: path.basename(created) })
  await expect(group.getByTestId("wt-row").filter({ hasText: "워크트리 세션" })).toBeVisible()
  await idle(page, id)
  await page.screenshot({ path: path.join(shots(), "worktree-session-dark.png") })
  expect(errors).toEqual([])
})

test("move a session to the project folder and back (session.move, location follows)", async ({ page }) => {
  const errors = await openHarness(page)
  const state = wtState()
  const row = page.getByTestId("wt-row").filter({ hasText: "워크트리 세션" })
  await row.click()
  await expect(page.getByTestId("wt-place")).toContainText("⑂")

  await page.getByTestId("wt-move").click()
  const dialog = page.getByTestId("worktree-move")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("앞부분 캐시는 그대로 써요")
  const local = dialog.getByTestId("worktree-move-target").filter({ hasText: "프로젝트 폴더" })
  await expect(local).toBeVisible()
  await page.screenshot({ path: path.join(shots(), "worktree-move-dark.png") })
  await local.click()
  await dialog.getByTestId("worktree-move-confirm").click()
  await expect(page.getByTestId("toast").filter({ hasText: "프로젝트 폴더로 옮겼어요" })).toBeVisible({ timeout: 30_000 })
  const id = (await wt<string>(page, "current"))!
  await expect.poll(() => wt<string>(page, "directory", id).then(norm)).toBe(norm(state.gitProject))
  await expect(page.getByTestId("wt-place")).toHaveText("프로젝트 폴더")
  // Sidebar: back in the project's own list.
  await expect(page.getByTestId("wt-group").filter({ hasText: "워크트리 세션" })).toHaveCount(0)

  // And back into the worktree.
  await page.getByTestId("wt-move").click()
  const target = dialog.getByTestId("worktree-move-target").filter({ hasText: path.basename(created) })
  await target.click()
  await dialog.getByTestId("worktree-move-confirm").click()
  await expect.poll(() => wt<string>(page, "directory", id).then(norm), { timeout: 30_000 }).toBe(norm(created))
  expect(errors).toEqual([])
})

test("a new session in an existing worktree", async ({ page }) => {
  const errors = await openHarness(page)
  await wt(page, "home")
  const select = page.getByTestId("worktree-select")
  await select.click()
  const existing = page.getByTestId("worktree-existing").filter({ hasText: path.basename(created) })
  await expect(existing).toBeVisible()
  await expect(existing).toContainText("대화 1")
  await existing.locator("input[type=radio]").click()
  await expect(page.getByTestId("worktree-popover")).toBeHidden()
  await expect(select).toContainText(path.basename(created))
  const id = await newSession(page, "기존 워크트리 세션")
  expect(norm(await wt<string>(page, "directory", id))).toBe(norm(created))
  await idle(page, id)
  expect(errors).toEqual([])
})

test("cleanup: confirmation says what happens; git's refusal turns into 강제로 정리", async ({ page }) => {
  const errors = await openHarness(page, "?scheme=light")
  await wt(page, "home")
  const select = page.getByTestId("worktree-select")
  // Choose the worktree first: after the cleanup the saved choice must fall back to 로컬.
  await select.click()
  const existing = page.getByTestId("worktree-existing").filter({ hasText: path.basename(created) })
  await existing.locator("input[type=radio]").click()
  await expect(select).toContainText(path.basename(created))
  await select.click()
  await existing.getByTestId("worktree-cleanup").click()
  const dialog = page.getByTestId("worktree-remove")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("worktree-remove-command")).toContainText("git worktree remove")
  await expect(dialog.getByTestId("worktree-remove-sessions")).toContainText("대화 2개")
  await page.screenshot({ path: path.join(shots(), "worktree-remove-light.png") })
  await dialog.getByTestId("worktree-remove-confirm").click()
  // started.txt is untracked: git refuses without --force.
  await expect(dialog.getByTestId("worktree-remove-dirty")).toBeVisible()
  await expect(dialog.getByTestId("worktree-remove-confirm")).toHaveText("강제로 정리")
  await expect(dialog.getByTestId("worktree-remove-command")).toContainText("--force")
  await dialog.getByTestId("worktree-remove-confirm").click()
  await expect(page.getByTestId("toast").filter({ hasText: "정리했어요" })).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toBeHidden()
  expect(fs.existsSync(created)).toBe(false)
  const list = await wt<{ directory: string }[]>(page, "worktrees")
  expect(list.some((item) => norm(item.directory) === norm(created))).toBe(false)
  // The saved `기존 작업 폴더` choice no longer applies.
  await expect(select).toContainText("프로젝트 폴더")
  expect(errors).toEqual([])
})

/** Opens `정리…` of the existing worktree named `name` from the new-session picker. */
async function openCleanup(page: Page, name: string) {
  await wt(page, "home")
  await page.getByTestId("worktree-select").click()
  const row = page.getByTestId("worktree-existing").filter({ has: page.getByText(`⑂ ${name}`, { exact: true }) })
  await expect(row).toHaveCount(1)
  await row.getByTestId("worktree-cleanup").click()
  const dialog = page.getByTestId("worktree-remove")
  await expect(dialog).toBeVisible()
  return dialog
}

/** Every `worktree.remove` (DELETE /api/worktree) the page sends. */
function removals(page: Page) {
  const sent: string[] = []
  page.on("request", (request) => {
    if (request.method() === "DELETE" && new URL(request.url()).pathname === "/api/worktree") sent.push(request.url())
  })
  return sent
}

const guardDir = (name: string) => path.join(path.dirname(wtState().gitProject), name)

test("TG13 (a): a worktree with another worktree inside is refused, with the reason and the nested path", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const sent = removals(page)
  const dialog = await openCleanup(page, "wt-nested")
  await expect(dialog).toHaveAttribute("data-guard", "refuse-nested")
  await expect(dialog.getByTestId("worktree-remove-nested")).toContainText("다른 저장소가 들어 있어요")
  const nested = dialog.getByTestId("worktree-remove-nested-item")
  await expect(nested).toHaveCount(1)
  // Shown relative to the worktree, so the part that matters is not cut off.
  await expect(nested.locator(".own-wt-guard-path")).toHaveText(/^\.worktrees[\\/]inner$/)
  await expect(nested).toContainText("작업 폴더")
  const confirm = dialog.getByTestId("worktree-remove-confirm")
  await expect(confirm).toBeDisabled()
  await expect(confirm).toHaveText("정리")
  await page.screenshot({ path: path.join(shots(), "worktree-guard-nested-dark.png") })
  await confirm.dispatchEvent("click")
  await dialog.getByRole("button", { name: "취소" }).click()
  await expect(dialog).toBeHidden()
  expect(sent).toEqual([])
  expect(fs.existsSync(path.join(guardDir("wt-nested"), ".worktrees", "inner"))).toBe(true)
  expect(errors).toEqual([])
})

test("TG13 (b): a team-mode lock shows the team guidance and never calls worktree.remove", async ({ page }) => {
  const errors = await openHarness(page, "?scheme=light")
  const sent = removals(page)
  const dialog = await openCleanup(page, "wt-locked")
  await expect(dialog).toHaveAttribute("data-guard", "own-lock")
  const guidance = dialog.getByTestId("worktree-remove-own-lock")
  await expect(guidance).toContainText("팀 화면")
  await expect(guidance).toContainText("own.team area:ar_x")
  const confirm = dialog.getByTestId("worktree-remove-confirm")
  await expect(confirm).toBeDisabled()
  await expect(confirm).toHaveText("정리")
  await page.screenshot({ path: path.join(shots(), "worktree-guard-locked-light.png") })
  // Even a synthetic click on the disabled button must not reach the server.
  await confirm.dispatchEvent("click")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  expect(sent).toEqual([])
  expect(fs.existsSync(guardDir("wt-locked"))).toBe(true)
  expect(errors).toEqual([])
})

test("TG13 (c): ignored files are listed with sizes, count and total; the confirm names the size; a failed inspection fails closed", async ({
  page,
}) => {
  const errors = await openHarness(page)
  // The first inspection fails: nothing may be removed until a retry answers.
  let failOnce = true
  await page.route("**/api/rpc/own.accounts/worktree.inspect**", async (route) => {
    if (!failOnce) return route.fallback()
    failOnce = false
    await route.abort("failed")
  })
  const dialog = await openCleanup(page, "wt-ignored")
  await expect(dialog.getByTestId("worktree-remove-inspect-failed")).toBeVisible()
  await expect(dialog).toHaveAttribute("data-guard", "unknown")
  await expect(dialog.getByTestId("worktree-remove-confirm")).toBeDisabled()
  await dialog.getByTestId("worktree-remove-retry").click()

  await expect(dialog).toHaveAttribute("data-guard", "confirm-ignored")
  await expect(dialog.getByTestId("worktree-remove-retry")).toHaveCount(0)
  const items = dialog.getByTestId("worktree-remove-ignored-item")
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText("build/")
  await expect(items.nth(1)).toContainText("debug.log")
  const total = await page.evaluate(() =>
    new Intl.NumberFormat("ko", {
      style: "unit",
      unit: "megabyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(2.5),
  )
  await expect(dialog.getByTestId("worktree-remove-ignored")).toContainText(`2개(${total})`)
  const confirm = dialog.getByTestId("worktree-remove-confirm")
  await expect(confirm).toHaveText(`무시된 파일 ${total}까지 정리`)
  await page.screenshot({ path: path.join(shots(), "worktree-guard-ignored-dark.png") })
  await confirm.click()
  await expect(page.getByTestId("toast").filter({ hasText: "wt-ignored" })).toBeVisible({ timeout: 30_000 })
  await expect(dialog).toBeHidden()
  expect(fs.existsSync(guardDir("wt-ignored"))).toBe(false)
  expect(errors).toEqual([])
})

test("base branch search is IME-safe: Enter during composition only commits, Esc while composing keeps the popover", async ({
  page,
}) => {
  const errors = await openHarness(page)
  await wt(page, "home")
  const select = page.getByTestId("worktree-select")
  await select.click()
  const pop = page.getByTestId("worktree-popover")
  await pop.getByTestId("worktree-option-new").click()
  const base = pop.getByTestId("worktree-base")
  const search = base.getByTestId("worktree-base-search")
  await expect(base.getByTestId("worktree-base-option").filter({ hasText: "기능-한글" })).toBeVisible()
  const cdp = await page.context().newCDPSession(page)
  await search.focus()
  // Esc while composing belongs to the IME: the popover stays.
  await cdp.send("Input.imeSetComposition", { text: "ㄱ", selectionStart: 1, selectionEnd: 1 })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await expect(pop).toBeVisible()
  // Enter during composition commits "기능" and does not pick anything yet (commitOnly, 03 §12).
  await cdp.send("Input.imeSetComposition", { text: "기", selectionStart: 1, selectionEnd: 1 })
  await cdp.send("Input.imeSetComposition", { text: "기능", selectionStart: 2, selectionEnd: 2 })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text: "기능" })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await expect(search).toHaveValue("기능")
  await expect(base.getByTestId("worktree-base-option")).toHaveCount(1)
  await expect(select).toContainText("새 작업 폴더")
  await expect(select).not.toContainText("기능-한글")
  // The next Enter applies the first match.
  await search.press("Enter")
  await expect(select).toContainText("새 작업 폴더 · 기능-한글")
  await expect(base.getByTestId("worktree-base-option").locator("input")).toBeChecked()
  expect(errors).toEqual([])
})

test("keyboard: focus lands on the current place, arrows move without closing, Enter closes", async ({ page }) => {
  const errors = await openHarness(page, "?scheme=light")
  await wt(page, "home")
  const select = page.getByTestId("worktree-select")
  await select.focus()
  await page.keyboard.press("Enter")
  const pop = page.getByTestId("worktree-popover")
  const local = pop.getByTestId("worktree-option-local").locator("input")
  await expect(local).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(pop.getByTestId("worktree-option-new").locator("input")).toBeChecked()
  await expect(pop.getByTestId("worktree-base")).toBeVisible()
  await page.keyboard.press("ArrowUp")
  await expect(local).toBeChecked()
  await expect(pop).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(pop).toBeHidden()
  await expect(select).toBeFocused()
  await expect(select).toContainText("프로젝트 폴더")
  expect(errors).toEqual([])
})
