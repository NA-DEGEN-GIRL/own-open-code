// P7 acceptance walkthrough (03 §19, items 17–32) in the whole app, in Edge, against e2e/p7/backend.ts. Each test
// is one item or a pair that belongs together, in the dark theme (the default) with light spot-checks at the end.
// The feature suites (e2e/review-git, files, worktree-bg, composer-plus, session-ux, palette-shell) test each module
// in its own harness in depth; this suite checks the wiring in the app: shell, header, work panel, composer,
// transcript, sidebar, settings, palette and keyboard. Screenshots: $OWN_WEB_P7_SHOTS.
import { execFileSync } from "node:child_process"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  answered,
  composer,
  currentSession,
  idle,
  messages,
  newSession,
  openPath,
  openSession,
  prepare,
  scheme,
  send,
  sessionInfo,
  shot,
  state,
  turn,
  watchErrors,
} from "./support"

test.describe.configure({ mode: "serial" })

const git = (...args: string[]) => execFileSync("git", args, { cwd: state.workspace, encoding: "utf8" })
const tab = (page: Page, name: string) => page.locator(`#own-tab-${name}`)
const dock = (page: Page) => page.getByTestId("git-dock")
const sessionMenu = async (page: Page, item: string) => {
  await page.getByTestId("session-menu").click()
  await page.getByTestId(`session-menu-${item}`).click()
}
const list = (page: Page) => page.getByTestId("session-list")
const row = (page: Page, id: string) => list(page).locator(`[data-testid="session-row"][data-session-id="${id}"]`)

/** Runs a Git dock action with Enter and waits for its result. */
async function confirmGit(page: Page) {
  await expect(dock(page)).toHaveAttribute("data-phase", "confirm")
  await page.keyboard.press("Enter")
  await expect(dock(page)).toHaveAttribute("data-phase", /done|failed/, { timeout: 60_000 })
}

test.beforeEach(async ({ page }) => {
  await prepare(page)
})

test("dark theme is the default; the session header carries the Git chip and the `⋯` menu (4.4, 19.15)", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await openSession(page, state.session)
  expect(await scheme(page)).toBe("dark")
  const chip = page.getByTestId("git-status-chip")
  await expect(chip).toBeVisible()
  await expect(page.getByTestId("git-status-branch")).toHaveText("feature")
  await expect(page.getByTestId("git-status-count")).toHaveText("· ±2")
  await page.getByTestId("session-menu").click()
  await expect(page.getByRole("menuitem")).toHaveText([
    "포크",
    "이 메시지에서 포크…",
    "지금 압축",
    "압축 내용 보기",
    "문맥 비우기",
    // 곁질문 (BTW, 2.2.6-own.18): the phone's way in.
    "곁질문…",
    "내보내기",
    "대화 메모",
    "고정",
    "보관",
    "에이전트 방식 바꾸기…",
    "다른 작업 폴더로 옮기기…",
    "삭제…",
  ])
  await shot(page, "p7-header-menu-dark")
  await page.keyboard.press("Escape")
  // The chip opens 리뷰 on 커밋 안 된 변경 (there are uncommitted files).
  await chip.click()
  await expect(tab(page, "review")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("review-mode")).toHaveValue("working", { timeout: 60_000 })
  expect(errors).toEqual([])
})

test("17 line comments: select lines in 리뷰 → comment chip above the composer → sent with the next prompt; Ctrl+Shift+L", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await openSession(page, state.session)
  await page.keyboard.press("Control+Shift+KeyR")
  const mode = page.getByTestId("review-mode")
  await expect(mode.locator("option[value=working]")).toHaveCount(1, { timeout: 60_000 })
  await mode.selectOption("working")
  await page.locator('[data-testid=review-list] [data-file="src/router.ts"]').click()
  const line = page.locator('[data-column-number="3"][data-line-type="change-addition"]')
  await line.hover()
  await page.mouse.down()
  await line.hover()
  await page.mouse.up()
  const editor = page.locator("[data-slot=line-comment-v2-textarea]")
  await expect(editor).toBeFocused()
  // Ctrl+Shift+L (context.addSelection, 03 §10) from inside the comment editor: a file mention for the composer.
  await page.keyboard.press("Control+Shift+KeyL")
  await expect(page.getByTestId("mention-chip")).toContainText("router.ts")
  await editor.fill("이 값을 3으로 되돌려 주세요")
  await editor.press("Enter")
  const chip = page.getByTestId("review-comment-chip")
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText("router.ts:3")
  await shot(page, "p7-17-comment-chip-dark")
  // Sent with the next prompt: the note line, the commented line as a file part, the comment card metadata.
  await turn(page, state.session, "리뷰 코멘트를 반영해 주세요")
  await expect(chip).toHaveCount(0)
  const user = (await messages(page, state.session)).find((message) => message.type === "user")
  expect(user?.text).toContain("리뷰 코멘트를 반영해 주세요")
  expect(user?.text).toContain("The user made the following comment regarding line 3 of src/router.ts")
  expect(user?.files?.map((file) => file.name)).toContain("router.ts#L3")
  expect(user?.metadata?.displayText).toBe("리뷰 코멘트를 반영해 주세요")
  // The transcript draws it as a comment card above the typed text.
  await expect(
    page.locator('[data-slot="user-message-comments"]').filter({ hasText: "router.ts" }).first(),
  ).toBeVisible()
  await shot(page, "p7-17-comment-card-dark")
  expect(errors).toEqual([])
})

test("18 Git actions in 리뷰: stage all → commit with a message → push to origin → PR through gh; palette `푸시`", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await openSession(page, state.session)
  await page.getByTestId("git-status-chip").click()
  await expect(page.getByTestId("git-bar")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("git-branch")).toContainText("feature")
  await page.getByTestId("git-stage-all").click()
  await expect(page.getByTestId("git-command")).toHaveText("git add -A")
  await confirmGit(page)
  await expect(page.getByTestId("git-done")).toBeVisible()
  await page.getByTestId("git-close").click()
  await page.getByTestId("git-commit").click()
  const message = page.getByTestId("git-message")
  await expect(message).toBeFocused()
  await expect(page.getByTestId("git-effect")).toContainText("feature")
  await message.fill("feat: p7 라우터")
  await shot(page, "p7-18-commit-confirm-dark")
  await message.press("Control+Enter")
  await expect(page.getByTestId("git-done")).toBeVisible({ timeout: 60_000 })
  expect(git("log", "-1", "--format=%s").trim()).toBe("feat: p7 라우터")
  await expect(page.getByTestId("git-status-chip")).not.toHaveAttribute("data-files", "2")
  await page.getByTestId("git-close").click()

  // 19.15: the palette's `Git: 푸시` opens the same confirmation (nothing runs before Enter).
  await page.keyboard.press("Control+KeyK")
  await page.getByTestId("palette-input").fill("푸시")
  await expect(page.locator('[data-testid="palette-item"][data-id="git.push"]')).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("git-dock-title")).toHaveText("푸시")
  await expect(page.getByTestId("git-command")).toHaveText("git push")
  await confirmGit(page)
  await expect(page.getByTestId("git-done")).toBeVisible()
  expect(execFileSync("git", ["--git-dir", state.remote, "rev-parse", "feature"], { encoding: "utf8" })).toBe(
    git("rev-parse", "HEAD"),
  )
  await page.getByTestId("git-close").click()

  await page.getByTestId("git-pr").click()
  await expect(page.getByTestId("git-command")).toHaveText("gh pr create --fill")
  await confirmGit(page)
  await expect(page.getByTestId("git-pr-link")).toContainText("https://github.example.test/own/p7/pull/7")
  await shot(page, "p7-18-pr-done-dark")
  await page.getByTestId("git-close").click()
  expect(errors).toEqual([])
})

test("20–21 files: a link in the answer opens the files tab at its line; Ctrl+P; viewers; editor link; Ctrl+F per surface", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await newSession(page, "라우터 파일을 알려 줘 [link]")
  await page.getByRole("link", { name: "src/router.ts 12줄" }).click()
  await expect(tab(page, "files")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("files-tabs").getByRole("tab")).toHaveText(["router.ts"])
  await expect(page.getByTestId("files-title")).toContainText("12번째 줄")
  // pierre highlights in its worker (a lazy chunk on first use); line 12 is scrolled into view and marked.
  await expect(page.getByTestId("files-code").locator('[data-line="12"]').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("files-tree").locator('[role=treeitem][data-path="src"]')).toBeVisible()
  // 19.5 on the web: a vscode:// link to the absolute path and line.
  await expect(page.getByTestId("files-editor")).toHaveAttribute("href", /^vscode:\/\/file\/.+\/src\/router\.ts/)
  await shot(page, "p7-20-files-code-dark")

  // Ctrl+F in the code view is the file's find bar; in the transcript it is the session find (19.13).
  await page.getByTestId("files-code").click()
  await page.keyboard.press("Control+KeyF")
  await expect(page.getByTestId("find-bar")).toHaveCount(0)
  await page.keyboard.press("Escape")

  // Ctrl+P from the composer: quick open, then the markdown preview with mermaid.
  await composer(page).click()
  await page.keyboard.press("Control+KeyP")
  const input = page.getByTestId("files-quick-input")
  await expect(input).toBeFocused()
  await input.pressSequentially("guide")
  await expect(page.getByTestId("files-quick-open").getByRole("option").first()).toHaveAttribute(
    "data-path",
    "docs/guide.md",
  )
  await input.press("Enter")
  await expect(page.getByTestId("files-markdown").locator("h1")).toHaveText("가이드")
  await expect(page.getByTestId("files-markdown").locator("[data-component=markdown-mermaid] svg")).toBeVisible({
    timeout: 30_000,
  })
  await shot(page, "p7-20-files-markdown-dark")

  // 리뷰's per-file links: 파일 탭에서 열기 and the editor link.
  await page.keyboard.press("Control+Shift+KeyR")
  await page.getByTestId("review-mode").selectOption("branch")
  await page.getByTestId("review-base").selectOption("main")
  await page.locator('[data-testid=review-list] [data-file="src/util.ts"]').click()
  await expect(page.getByTestId("review-open-editor")).toHaveAttribute("href", /^vscode:\/\/file\/.+\/src\/util\.ts$/)
  await page.getByTestId("review-open-files").click()
  await expect(tab(page, "files")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("files-tabs").getByRole("tab").last()).toHaveText("util.ts")
  expect(errors).toEqual([])
})

test("19 worktrees: a new session in a new worktree, its `⑂` group in the sidebar, move it back to 로컬", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const projectID = (await sessionInfo(page, state.session)).projectID
  await openPath(page, `/srv/local/p/${projectID}`)
  const select = page.getByTestId("worktree-select")
  await expect(select).toContainText("프로젝트 폴더")
  await select.click()
  const pop = page.getByTestId("worktree-popover")
  await pop.getByTestId("worktree-option-new").click()
  await shot(page, "p7-19-worktree-picker-dark")
  await page.keyboard.press("Escape")
  await expect(select).toContainText("새 작업 폴더")
  await send(page, "작업 폴더에서 시작해요")
  await expect(page.getByTestId("toast").filter({ hasText: "만들었어요" })).toBeVisible({ timeout: 90_000 })
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toMatch(/\/s\/ses_/)
  const id = currentSession(page)
  await answered(page, id)
  const info = await sessionInfo(page, id)
  expect(path.resolve(info.location.directory)).not.toBe(path.resolve(state.workspace))
  const group = list(page).locator(
    `[data-testid="worktree-row"][title="${info.location.directory.replaceAll("\\", "\\\\")}"]`,
  )
  await expect(group).toHaveCount(1)
  await expect(group).toContainText("⑂")
  await expect(row(page, id)).toBeVisible()
  await shot(page, "p7-19-worktree-group-dark")

  await sessionMenu(page, "move")
  const dialog = page.getByTestId("worktree-move")
  await expect(dialog).toBeVisible()
  await dialog.getByTestId("worktree-move-target").filter({ hasText: "프로젝트 폴더" }).click()
  await dialog.getByTestId("worktree-move-confirm").click()
  await expect(page.getByTestId("toast").filter({ hasText: "옮겼어요" })).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => path.resolve((await sessionInfo(page, id)).location.directory))
    .toBe(path.resolve(state.workspace))
  await expect(group).toHaveCount(0)
  expect(errors).toEqual([])
})

test("23 background: Alt+B sends the running shell to the background; ⧗ in the sidebar; list, output, stop; finish toast", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const id = await newSession(page, "백그라운드 작업을 시작합니다")
  await send(page, "[bg-long] 오래 걸리는 명령")
  const blocking = page.getByTestId("background-blocking")
  await expect(blocking).toContainText("실행 중", { timeout: 30_000 })
  await expect(page.getByTestId("background-send")).toContainText("Alt+B")
  await shot(page, "p7-23-background-blocking-dark")
  // Ctrl+B in the composer is text editing (03 §10); Alt+B moves the shell.
  await composer(page).focus()
  await page.keyboard.press("Control+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "open")
  await page.keyboard.press("Alt+KeyB")
  await expect(blocking).toBeHidden({ timeout: 20_000 })
  const toggle = page.getByTestId("background-toggle")
  await expect(toggle).toContainText("백그라운드 1")
  await idle(page)
  await expect(row(page, id).locator("[aria-label], [title]").filter({ hasText: "⧗" }).first()).toBeVisible()
  await toggle.click()
  const item = page.getByTestId("background-item")
  await expect(item).toHaveCount(1)
  await item.getByTestId("background-item-output").click()
  const view = page.getByTestId("background-output")
  await expect(view.getByTestId("background-output-text")).toContainText("tick 1", { timeout: 15_000 })
  await shot(page, "p7-23-background-output-dark")
  await page.keyboard.press("Escape")
  await item.getByTestId("background-stop").click()
  await expect(page.getByTestId("background-dock")).toBeHidden({ timeout: 20_000 })

  // A background shell that finishes: toast with 출력 보기 (03 §9).
  await send(page, "[bg-quick] 짧은 명령")
  const toast = page.getByTestId("toast").filter({ hasText: "끝났어요 (exit 0)" })
  await expect(toast).toBeVisible({ timeout: 45_000 })
  await shot(page, "p7-23-background-done-dark")
  expect(errors).toEqual([])
})

test("22 + 25 composer: skills chip, `!` shell mode, ↑ history, drafts with chips survive a reload", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const id = await newSession(page, "입력창 편의 기능")
  const box = page.getByTestId("composer").locator(".own-cp-box")

  // 22: ✦ 스킬 → the project skill as a chip, sent as `skills[]`.
  await page.getByTestId("skills-button").click()
  const panel = page.getByTestId("skills-panel")
  await expect(panel.locator('[data-skill="review-guide"]')).toContainText("리뷰 체크리스트")
  await shot(page, "p7-22-skills-dark")
  await page.getByTestId("skills-search").fill("review")
  await page.getByTestId("skills-search").press("Enter")
  await expect(page.getByTestId("mention-chip")).toContainText("review-guide")
  await turn(page, id, "스킬과 함께 보냅니다")
  await expect
    .poll(async () => (await messages(page, id)).find((message) => message.type === "user"))
    .toMatchObject({ skills: [expect.objectContaining({ id: "review-guide" })] })

  // 25: `!` switches to shell mode and is consumed; the command runs without waking the agent.
  const input = composer(page)
  await input.click()
  await input.press("Shift+Digit1")
  await expect(input).toHaveValue("")
  await expect(box).toHaveAttribute("data-shell", "")
  await expect(page.getByTestId("shell-hint")).toBeVisible()
  await shot(page, "p7-25-shell-mode-dark")
  await input.pressSequentially("echo p7-shell")
  await input.press("Control+Enter")
  await expect(box).not.toHaveAttribute("data-shell", "")
  await expect
    .poll(async () => (await messages(page, id)).filter((message) => message.type === "shell").map((m) => m.command))
    .toEqual(["echo p7-shell"])

  // ↑ on an empty box: the last prompt with its chips; ↓ back to the draft.
  await input.press("ArrowUp")
  await expect(input).toHaveValue("스킬과 함께 보냅니다")
  await expect(page.getByTestId("history-position")).toBeVisible()
  await input.press("ArrowDown")
  await expect(input).toHaveValue("")

  // A draft with a chip survives a reload (text in localStorage, chips in IndexedDB, 500 ms debounce).
  await page.getByTestId("skills-button").click()
  await page.getByTestId("skills-search").fill("review")
  await page.getByTestId("skills-search").press("Enter")
  await input.pressSequentially("저장될 초안")
  await input.blur()
  await page.waitForTimeout(1_200)
  await page.reload()
  await expect(composer(page)).toHaveValue("저장될 초안", { timeout: 30_000 })
  await expect(page.getByTestId("mention-chip")).toContainText("review-guide")
  expect(errors).toEqual([])
})

test("28 fork from a message and compact now from the header `⋯`", async ({ page }) => {
  const errors = watchErrors(page)
  const parent = await newSession(page, "포크할 첫 질문")
  await turn(page, parent, "포크할 두 번째 질문")
  await sessionMenu(page, "forkFrom")
  const dialog = page.getByTestId("fork-dialog")
  await expect(dialog.getByTestId("fork-option")).toHaveCount(2)
  await expect(dialog.getByTestId("fork-note-cache")).toBeVisible()
  await shot(page, "p7-28-fork-dialog-dark")
  await page.getByTestId("fork-search").press("Enter")
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => currentSession(page)).not.toBe(parent)
  await expect(composer(page)).toHaveValue("포크할 두 번째 질문")
  const forked = currentSession(page)
  expect((await sessionInfo(page, forked)).fork?.sessionID).toBe(parent)
  await composer(page).fill("")

  await openPath(page, `/srv/local/s/${parent}`)
  // The `압축 중…` chip can come and go within a frame on the fake model: record every phase it shows.
  await page.evaluate(() => {
    const seen: string[] = []
    Object.assign(window, { __compactionPhases: seen })
    new MutationObserver(() => {
      const phase = document.querySelector('[data-testid="compaction-status"]')?.getAttribute("data-phase")
      if (phase && seen.at(-1) !== phase) seen.push(phase)
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
  })
  await sessionMenu(page, "compact")
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __compactionPhases: string[] }).__compactionPhases.length))
    .toBeGreaterThan(0)
  await shot(page, "p7-28-compacting-dark")
  await expect(page.getByTestId("compaction-status")).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId("compaction-failed")).toHaveCount(0)
  await expect
    .poll(async () => (await messages(page, parent)).some((message) => message.type === "compaction"))
    .toBe(true)
  expect(errors).toEqual([])
})

test("26 notes: UI-only by default; `모델에게도 보이기` appends the note at the end and keeps the prefix", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const id = await newSession(page, "노트 첫 질문")
  await sessionMenu(page, "notes")
  const dialog = page.getByTestId("notes-dialog")
  const input = dialog.getByTestId("notes-input")
  await expect(input).toBeEnabled()
  await input.fill("배포 전에 결제 로그 확인")
  await dialog.getByTestId("notes-save").click()
  await expect(dialog.getByTestId("notes-status")).toHaveText("저장했어요")
  await expect.poll(async () => (await sessionInfo(page, id)).metadata?.["own.note"]).toBe("배포 전에 결제 로그 확인")
  await dialog.getByTestId("notes-model-toggle").check()
  await expect(dialog.getByTestId("notes-pending")).toHaveText("다음 요청에서 이 메모가 대화 끝에 더해져요")
  await shot(page, "p7-26-notes-dark")
  await dialog.getByTestId("notes-save").click()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  const requests = async () =>
    (await (await fetch(`${state.inspect}/requests`)).json()) as { instructions: unknown; input: unknown[] }[]
  const before = (await requests()).length
  await turn(page, id, "노트 다음 질문")
  const all = await requests()
  const next = all.at(-1)!
  const previous = all.slice(0, before).findLast((request) => JSON.stringify(request.input).includes("노트 첫 질문"))!
  expect(JSON.stringify(next.input)).toContain("배포 전에 결제 로그 확인")
  // The previous request is an exact prefix of the next one (01 §17.1 #26).
  expect(next.instructions).toEqual(previous.instructions)
  expect(next.input.slice(0, previous.input.length)).toEqual(previous.input)
  expect(errors).toEqual([])
})

test("27 pin and archive from the header `⋯` and the row menu; the 보관 undo toast; a pasted session id finds it", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const id = await newSession(page, "고정 보관 시험")
  await sessionMenu(page, "pin")
  await expect(page.getByTestId("pinned-group")).toBeVisible()
  await expect.poll(async () => (await sessionInfo(page, id)).metadata?.["own.pinned"]).toBeTruthy()
  await shot(page, "p7-27-pinned-dark")
  await page.getByTestId("session-menu").click()
  await expect(page.getByTestId("session-menu-pin")).toHaveText("고정 해제")
  await page.getByTestId("session-menu-archive").click()
  await expect(row(page, id)).toHaveCount(0)
  const toast = page.getByTestId("toast").filter({ hasText: "보관했어요" })
  await expect(toast).toBeVisible()
  await toast.getByRole("button", { name: "보관 취소" }).click()
  await expect(row(page, id)).toBeVisible()
  await expect.poll(async () => (await sessionInfo(page, id)).metadata?.["own.archived"]).toBeUndefined()
  // Row menu: 고정 해제.
  await row(page, id).hover()
  await row(page, id).locator("xpath=..").getByTestId("row-menu-button").click()
  await page.getByTestId("row-menu").getByTestId("row-pin").click()
  await expect(page.getByTestId("pinned-group")).toHaveCount(0)
  // A pasted session link finds the session.
  await page.getByTestId("sidebar-search").fill(`${state.dev}/srv/local/s/${id}`)
  await expect(row(page, id)).toBeVisible()
  expect(errors).toEqual([])
})

test("29 find in session: Ctrl+F over the transcript, count, Enter; Ctrl+Alt+[ / ] between messages", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await newSession(page, "찾기 시험용 답을 주세요 [link]")
  await page.keyboard.press("Control+KeyF")
  const input = page.getByTestId("find-input")
  await expect(input).toBeFocused()
  await input.fill("오렌지")
  await expect(page.getByTestId("find-count")).toContainText("1/1")
  await input.press("Enter")
  await shot(page, "p7-29-find-dark")
  await input.press("Escape")
  await expect(page.getByTestId("find-bar")).toHaveCount(0)
  await page.keyboard.press("Control+Alt+BracketLeft")
  await page.keyboard.press("Control+Alt+BracketRight")
  expect(errors).toEqual([])
})

test("31 timeline presets in 설정 > 일반 (간단/보통/자세히) and 24 the Windows shell setting", async ({ page }) => {
  const errors = watchErrors(page)
  await openPath(page, "/settings/general")
  const preset = page.getByTestId("settings-timeline-preset")
  await expect(preset).toBeVisible()
  await preset.getByRole("radio", { name: "자세히" }).click()
  await expect(page.getByTestId("settings-timeline-describe")).not.toBeEmpty()
  await shot(page, "p7-31-timeline-setting-dark")
  expect(await page.evaluate(() => localStorage.getItem("own.web.timeline.detail"))).toBe("detailed")
  await openSession(page, state.session)
  await expect(page.getByTestId("transcript-body")).toBeVisible()
  await openPath(page, "/settings/general")
  await page.getByTestId("settings-timeline-preset").getByRole("radio", { name: "보통" }).click()

  await openPath(page, "/settings/shell")
  const options = page.getByTestId("shell-option")
  await expect(options.first()).toBeVisible()
  const values = await options.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-value")))
  const cmd = values.find((value) => value && /\\cmd\.exe$/i.test(value))
  if (cmd) {
    await page.locator(`[data-testid="shell-option"][data-value="${cmd.replaceAll("\\", "\\\\")}"]`).click()
    await expect(page.getByTestId("shell-confirm-cache")).toContainText("캐시")
    await shot(page, "p7-24-shell-confirm-dark")
    await page.getByTestId("shell-cancel").click()
  }
  expect(errors).toEqual([])
})

test("32 palette and shortcuts: Ctrl+K with Korean initials, feature commands, the shortcut audit, Ctrl+B / Ctrl+.", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await openSession(page, state.session)
  await page.keyboard.press("Control+KeyK")
  const input = page.getByTestId("palette-input")
  await expect(input).toBeFocused()
  await input.fill("ㅌㅁㄴ")
  await expect(page.getByTestId("palette-item").first()).toContainText("터미널")
  // `노트` finds the workspace notes tab (project notes); the conversation memo is `대화 메모 열기`.
  await input.fill("노트")
  await expect(page.locator('[data-testid="palette-item"][data-id="notes.workspace"]')).toBeVisible()
  await input.fill("메모")
  await expect(page.locator('[data-testid="palette-item"][data-id="notes.open"]')).toBeVisible()
  await shot(page, "p7-32-palette-dark")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("notes-dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+KeyK")
  await input.fill("작업 폴더")
  await expect(page.locator('[data-testid="palette-item"][data-id="worktree.move"]')).toBeVisible()
  await page.keyboard.press("Escape")

  // Ctrl+B outside the composer toggles the sidebar; Ctrl+. opens the switcher (03 §10 conflict table).
  await page.getByTestId("header-title").click()
  await page.keyboard.press("Control+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "closed")
  await page.keyboard.press("Control+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "open")
  await page.keyboard.press("Control+Period")
  await expect(page.getByTestId("switcher")).toBeVisible()
  await page.keyboard.press("Escape")

  await openPath(page, "/settings/shortcuts")
  await expect(page.getByTestId("settings-shortcuts")).toBeVisible()
  await expect(page.getByTestId("settings-shortcuts")).toContainText("충돌 없음")
  await shot(page, "p7-32-shortcuts-dark")
  expect(errors).toEqual([])
})

test("light theme spot-checks: header, files tab, palette, composer docks", async ({ page }) => {
  await prepare(page, "light")
  const errors = watchErrors(page)
  await newSession(page, "라우터 파일을 알려 줘 [link]")
  expect(await scheme(page)).toBe("light")
  await page.getByTestId("session-menu").click()
  await shot(page, "p7-light-header-menu")
  await page.keyboard.press("Escape")
  await page.getByRole("link", { name: "src/router.ts 12줄" }).click()
  await expect(page.getByTestId("files-title")).toContainText("12번째 줄")
  await expect(page.getByTestId("files-code").locator('[data-line="12"]').first()).toBeVisible({ timeout: 30_000 })
  await shot(page, "p7-light-files")
  await page.keyboard.press("Control+KeyK")
  await page.getByTestId("palette-input").fill("git")
  await shot(page, "p7-light-palette")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+KeyF")
  await page.getByTestId("find-input").fill("답변")
  await shot(page, "p7-light-find")
  // Readable accent text on both schemes: the chip's text color is not the background color.
  const colors = await page
    .getByTestId("git-status-chip")
    .evaluate((element) => [getComputedStyle(element).color, getComputedStyle(element).backgroundColor])
  expect(colors[0]).not.toBe(colors[1])
  expect(errors).toEqual([])
})
