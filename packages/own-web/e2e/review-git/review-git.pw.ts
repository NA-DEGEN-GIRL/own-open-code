// Review line comments (03 §19.1), Git actions (§19.2) and the branch chip (§19.15) in Edge against the real server
// (e2e/review-git/backend.ts). The tests share one backend and run in order: each leaves the working copy as the
// next one expects (comments change nothing; staging, committing, pushing and reverting do).
import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyReverse, commit, push, revert, shellKind, stage, unstage } from "../../src/git/commands"

interface Backend {
  readonly dev: string
  readonly workspace: string
  readonly remote: string
  readonly session: string
  readonly shell: string
  readonly fakeGh: boolean
}

const backend = (): Backend =>
  JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "own-web-review-git-e2e", "backend.json"), "utf8")) as Backend
const shots = process.env.OWN_WEB_REVIEW_GIT_SHOTS ?? path.join(os.tmpdir(), "own-web-review-git-e2e", "shots")
fs.mkdirSync(shots, { recursive: true })
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`) })

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: backend().workspace, encoding: "utf8" })
}

async function open(page: Page) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`/e2e/review-git/harness.html?session=${backend().session}`)
  await working(page)
  return errors
}

/** Right after the first test's prompt the tab opens on 마지막 턴 (18.5): the Git actions live in 커밋 안 된 변경. */
async function working(page: Page) {
  const mode = page.getByTestId("review-mode")
  await expect(mode.locator("option[value=working]")).toHaveCount(1, { timeout: 60_000 })
  await mode.selectOption("working")
  await expect(page.getByTestId("git-bar")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("git-branch")).toContainText("feature/git")
}

const row = (page: Page, file: string) => page.locator(`[data-testid=review-list] [data-file="${file}"]`)
const dock = (page: Page) => page.getByTestId("git-dock")

/**
 * Drags over the diff's line numbers (pierre renders them in its shadow root; Playwright's CSS pierces it). `hover`
 * waits until each row is visible and stable: the diff redraws once its highlight work is done.
 */
async function selectLines(page: Page, from: string, to: string) {
  await page.locator(from).hover()
  await page.mouse.down()
  await page.locator(to).first().hover()
  await page.mouse.up()
}

/**
 * Runs the dock's action with Enter and waits for the result. The dock takes the focus on its next frame (`focusDock`):
 * an Enter pressed before that reaches the button that opened it, or the page, and the dock stays at its confirmation
 * (RL34-T, a loaded PC: the frame came later than the key). The key goes once the focus is in the dock.
 */
async function confirm(page: Page) {
  await expect(dock(page)).toHaveAttribute("data-phase", "confirm")
  await expect
    .poll(() => dock(page).evaluate((node) => node.contains(document.activeElement)), { timeout: 20_000 })
    .toBe(true)
  await page.keyboard.press("Enter")
  await expect(dock(page)).toHaveAttribute("data-phase", /done|failed/, { timeout: 60_000 })
}

test("line comments: select lines → comment → chip above the composer → sent with the next prompt; Ctrl+Shift+L adds the lines as a mention", async ({
  page,
}) => {
  const errors = await open(page)
  await row(page, "src/router.ts").click()
  // Line 3 (added side) through line 4.
  await selectLines(page, '[data-column-number="3"][data-line-type="change-addition"]', '[data-column-number="4"]')
  const editor = page.locator("[data-slot=line-comment-v2-textarea]")
  await expect(editor).toBeFocused()
  // Ctrl+Shift+L from inside the comment editor still reaches the tab (capture phase), and keeps the selection.
  await page.keyboard.press("Control+Shift+KeyL")
  await expect(page.getByTestId("mentions")).toContainText(
    '{"kind":"file","path":"src/router.ts","range":{"start":3,"end":4}}',
  )
  await expect(page.getByTestId("toast").last()).toContainText("src/router.ts 3-4줄을 입력창에 넣었어요")

  await editor.fill("이 이름을 route2Top으로 바꿔 주세요")
  await editor.press("Enter")
  await expect(page.locator("[data-comment-id]")).toHaveCount(1)
  const chip = page.getByTestId("review-comment-chip")
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText("router.ts:3-4")
  await expect(chip).toContainText("route2Top")
  await expect(page.getByTestId("review-comment-hint")).toHaveCount(0)
  await shot(page, "19-1-comment-chip")

  // The chip opens the comment in the review tab (own:open-review).
  await chip.locator(".own-rc-open").click()
  await expect(page.getByTestId("review-intents")).toHaveText("1")

  // Sent with the next prompt of the session: note line, file part of the lines, comment card metadata.
  await page.getByTestId("composer-input").fill("리뷰 반영해 주세요")
  await page.getByTestId("composer-send").click()
  await expect(page.getByTestId("composer-status")).toHaveText("sent")
  await expect(chip).toHaveCount(0)
  const messages = (await (await page.request.get(`/api/session/${backend().session}/message?limit=20`)).json()) as {
    data: {
      type: string
      text?: string
      files?: { name?: string }[]
      metadata?: { displayText?: string; comments?: { path: string; comment: string; origin?: string }[] }
    }[]
  }
  const user = messages.data.find((message) => message.type === "user")
  expect(user?.text).toBe(
    "리뷰 반영해 주세요\nThe user made the following comment regarding lines 3 through 4 of src/router.ts: 이 이름을 route2Top으로 바꿔 주세요",
  )
  expect(user?.files?.map((file) => file.name)).toContain("router.ts#L3-4")
  expect(user?.metadata?.displayText).toBe("리뷰 반영해 주세요")
  expect(user?.metadata?.comments).toEqual([
    expect.objectContaining({
      path: "src/router.ts",
      comment: "이 이름을 route2Top으로 바꿔 주세요",
      origin: "review",
    }),
  ])
  expect(errors).toEqual([])
})

test("stage and unstage one file: the dock shows the exact command, the file state and the bar follow", async ({
  page,
}) => {
  const state = backend()
  const kind = shellKind(state.shell)
  const errors = await open(page)
  await row(page, "src/한 글.ts").click()
  await expect(page.getByTestId("git-file-state")).toHaveText("스테이징 안 됨")
  await page.getByTestId("git-stage").click()
  await expect(dock(page)).toBeVisible()
  await expect(page.getByTestId("git-dock-title")).toHaveText("파일 스테이징")
  await expect(page.getByTestId("git-command")).toHaveText(stage(kind, ["src/한 글.ts"], () => "unused").commands[0]!)
  await expect(page.getByTestId("git-effect")).toContainText("src/한 글.ts의 변경을 다음 커밋에 넣어요")
  await shot(page, "19-2-stage-confirm")
  await confirm(page)
  await expect(page.getByTestId("git-done")).toBeVisible()
  await expect(page.getByTestId("git-file-state")).toHaveText("스테이징됨")
  await expect(page.getByTestId("git-staged-count")).toContainText("스테이징됨 1")
  expect(git("diff", "--cached", "--name-only", "-z").split("\0")).toContain("src/한 글.ts")

  await page.getByTestId("git-close").click()
  await expect(dock(page)).toHaveCount(0)
  await page.getByTestId("git-unstage").click()
  await expect(page.getByTestId("git-command")).toHaveText(
    unstage(kind, ["src/한 글.ts"], false, () => "unused").commands[0]!,
  )
  // Esc cancels; nothing ran.
  await page.keyboard.press("Escape")
  await expect(dock(page)).toHaveCount(0)
  await expect(page.getByTestId("git-file-state")).toHaveText("스테이징됨")
  await page.getByTestId("git-unstage").click()
  await confirm(page)
  await expect(page.getByTestId("git-file-state")).toHaveText("스테이징 안 됨")
  expect(git("diff", "--cached", "--name-only")).toBe("")
  expect(errors).toEqual([])
})

test("commit with a message (never sent mid-composition), push to origin, PR through gh", async ({ page }) => {
  const state = backend()
  const kind = shellKind(state.shell)
  const errors = await open(page)
  const chip = page.getByTestId("git-status-chip")
  await expect(chip).toHaveAttribute("data-files", "4")
  await expect(page.getByTestId("git-commit")).toBeDisabled()

  await row(page, "src/it's.ts").click()
  await page.getByTestId("git-stage").click()
  await confirm(page)
  await page.getByTestId("git-close").click()
  await page.getByTestId("git-commit").click()
  const message = page.getByTestId("git-message")
  await expect(message).toBeFocused()
  const command = await page.getByTestId("git-command").textContent()
  expect(command).toMatch(/^git commit -F .+own-git\/.+-commit-message\.txt'?$/)
  expect(command).toBe(commit(kind, command!.replace(/^git commit -F '?|'?$/g, "")).commands[0])
  await expect(page.getByTestId("git-effect")).toContainText("스테이징된 파일 1개를 feature/git에 커밋해요")
  // An empty message never runs.
  await page.keyboard.press("Control+Enter")
  await expect(dock(page)).toHaveAttribute("data-phase", "confirm")
  await message.fill("fix: 따옴표 파일 고침")
  // Ctrl+Enter while an IME composes is ignored (03 §12).
  await message.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, isComposing: true, bubbles: true }),
    ),
  )
  await expect(dock(page)).toHaveAttribute("data-phase", "confirm")
  await shot(page, "19-2-commit-confirm")
  await message.press("Control+Enter")
  await expect(page.getByTestId("git-done")).toBeVisible({ timeout: 60_000 })
  expect(git("log", "-1", "--format=%s").trim()).toBe("fix: 따옴표 파일 고침")
  await expect(chip).toHaveAttribute("data-files", "3")
  await expect(page.getByTestId("git-branch")).toContainText("↑1")
  await page.getByTestId("git-close").click()

  await page.getByTestId("git-push").click()
  await expect(page.getByTestId("git-command")).toHaveText(push(true))
  await expect(page.getByTestId("git-effect")).toContainText("origin/feature/git")
  await confirm(page)
  await expect(page.getByTestId("git-done")).toBeVisible()
  expect(execFileSync("git", ["--git-dir", state.remote, "rev-parse", "feature/git"], { encoding: "utf8" })).toBe(
    git("rev-parse", "HEAD"),
  )
  await page.getByTestId("git-close").click()

  // Only with the fake gh first on the server's PATH: the real one would talk to GitHub.
  if (state.fakeGh) {
    await page.getByTestId("git-pr").click()
    await expect(page.getByTestId("git-command")).toHaveText("gh pr create --fill")
    await confirm(page)
    await expect(page.getByTestId("git-pr-link")).toContainText("https://github.example.test/own/e2e/pull/7")
    await shot(page, "19-2-pr-done")
    await page.getByTestId("git-close").click()
  }
  expect(errors).toEqual([])
})

test("hunk revert, file revert (tracked and untracked) change the working copy; a failing command shows its exit and output", async ({
  page,
}) => {
  const state = backend()
  const kind = shellKind(state.shell)
  const errors = await open(page)
  const router = path.join(state.workspace, "src/router.ts")

  await row(page, "src/router.ts").click()
  await page.getByTestId("git-hunks").click()
  const hunks = page.getByTestId("git-hunk")
  await expect(hunks).toHaveCount(2)
  await hunks.nth(1).getByTestId("git-hunk-revert").click()
  const command = await page.getByTestId("git-command").textContent()
  expect(command).toBe(applyReverse(kind, command!.replace(/^git apply -R --whitespace=nowarn '?|'?$/g, "")))
  await expect(page.getByTestId("git-patch")).toContainText("changed near the end")
  await shot(page, "19-2-hunk-confirm")
  await confirm(page)
  await expect(page.getByTestId("git-done")).toBeVisible()
  const after = fs.readFileSync(router, "utf8")
  expect(after).toContain("export const route36 = 36\n")
  expect(after).toContain("changed near the top")
  await page.getByTestId("git-close").click()

  await page.getByTestId("git-revert").click()
  await expect(page.getByTestId("git-effect")).toHaveAttribute("data-destructive", "")
  await expect(page.getByTestId("git-command")).toHaveText(
    revert(kind, { tracked: ["src/router.ts"], untracked: [], initial: false }, () => "unused").commands[0]!,
  )
  await confirm(page)
  expect(fs.readFileSync(router, "utf8")).not.toContain("changed")
  await page.getByTestId("git-close").click()

  await row(page, "notes/new.md").click()
  await expect(page.getByTestId("git-file-state")).toHaveText("추적 안 되는 새 파일")
  await page.getByTestId("git-revert").click()
  await expect(page.getByTestId("git-effect")).toContainText("추적 안 되는 새 파일 notes/new.md")
  await expect(page.getByTestId("git-command")).toHaveText(
    revert(kind, { tracked: [], untracked: ["notes/new.md"], initial: false }, () => "unused").commands[0]!,
  )
  await confirm(page)
  expect(fs.existsSync(path.join(state.workspace, "notes/new.md"))).toBe(false)
  await page.getByTestId("git-close").click()

  // Errors: the remote is gone.
  git("remote", "set-url", "origin", path.join(path.dirname(state.remote), "missing.git"))
  try {
    await row(page, "src/한 글.ts").click()
    await page.getByTestId("git-stage").click()
    await confirm(page)
    await page.getByTestId("git-close").click()
    await page.getByTestId("git-commit").click()
    await page.getByTestId("git-message").fill("한글 파일")
    await page.getByTestId("git-message").press("Control+Enter")
    await expect(page.getByTestId("git-done")).toBeVisible({ timeout: 60_000 })
    await page.getByTestId("git-close").click()
    await page.getByTestId("git-push").click()
    await confirm(page)
    const failed = page.getByTestId("git-failed")
    await expect(failed).toBeVisible()
    await expect(failed).toContainText(/명령이 실패했어요 \(exit \d+\)/)
    await expect(page.getByTestId("git-output")).toContainText(/missing\.git|does not appear to be a git repository/)
    await shot(page, "19-2-push-failed")
    // 다시 시도 brings the same command back to its confirmation.
    await page.getByTestId("git-retry").click()
    await expect(dock(page)).toHaveAttribute("data-phase", "confirm")
    await page.keyboard.press("Escape")
  } finally {
    git("remote", "set-url", "origin", state.remote)
  }
  expect(errors).toEqual([])
})

test("branch chip: ⑂ branch · ±n opens the review tab; dark and light", async ({ page }) => {
  // The tests above committed or reverted everything: one change for the count.
  fs.appendFileSync(path.join(backend().workspace, "README.md"), "\n더 적을 것\n")
  const errors = await open(page)
  const chip = page.getByTestId("git-status-chip")
  await expect(page.getByTestId("git-status-branch")).toHaveText("feature/git")
  const files = Number(await chip.getAttribute("data-files"))
  expect(files).toBeGreaterThan(0)
  await expect(page.getByTestId("git-status-count")).toHaveText(`· ±${files}`)
  await expect(chip).toHaveAttribute("aria-label", `브랜치 feature/git, 커밋 안 된 변경 파일 ${files}개. 리뷰 열기`)
  await chip.click()
  await expect(page.getByTestId("review-intents")).toHaveText("1")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await shot(page, "19-15-chip-dark")
  await page.evaluate(() => localStorage.setItem("opencode-color-scheme", "light"))
  await page.reload()
  await working(page)
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await row(page, "README.md").click()
  await page.getByTestId("git-stage").click()
  await expect(dock(page)).toHaveAttribute("data-phase", "confirm")
  await shot(page, "19-15-light")
  await page.keyboard.press("Escape")
  await page.evaluate(() => localStorage.removeItem("opencode-color-scheme"))
  expect(errors).toEqual([])
})
