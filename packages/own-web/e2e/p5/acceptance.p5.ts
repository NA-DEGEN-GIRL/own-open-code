// P5 acceptance walkthrough in Edge (integrator; see playwright.config.ts): items 1–15 of 03 §18 (except the native
// browser pane, 18.17, which needs the desktop shell) in the real app — shell, composer, transcript, work panel and
// settings as wired in P5 — against the real server. Each test leaves screenshots in $OWN_WEB_P5_SHOTS.
import { expect, test, type Page } from "@playwright/test"
import {
  api,
  composer,
  currentSession,
  idle,
  messages,
  openSession,
  pendingPermissions,
  ready,
  rpc,
  send,
  sessionInfo,
  shot,
  state,
  watchErrors,
  type Rule,
} from "./support"

test.describe.configure({ mode: "serial" })

/** A fresh session in the workspace (Git) created through the API as another client would, with `묻기`. */
async function newSession(page: Page, title: string, directory = state.workspace) {
  const created = await api<{ data: { id: string } }>(page, "POST", "/api/session", {
    title,
    model: { providerID: state.accounts.alpha.providerID, id: state.model },
    location: { directory },
  })
  await rpc(page, "session.approval.set", { sessionID: created.data.id, mode: "ask" }, directory)
  return created.data.id
}

const panelTab = (page: Page, tab: string) => page.locator(`#own-tab-${tab}`)

test("4 work panel: tabs 리뷰·파일·터미널·계정·한도 (no 브라우저 on the web), Ctrl+Alt+B, lazy tab content", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await openSession(page, state.session)
  const panel = page.getByTestId("panel")
  await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "open")
  await expect(panel.getByRole("tab")).toHaveText(["리뷰", "파일", "터미널", "계정·한도"])
  await expect(panelTab(page, "browser")).toHaveCount(0)
  await page.locator("body").click({ position: { x: 700, y: 300 } })
  await page.keyboard.press("Control+Alt+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "closed")
  await page.keyboard.press("Control+Alt+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "open")
  await panelTab(page, "review").click()
  await expect(page.locator("#own-tabpanel-review").getByTestId("review-mode")).toBeVisible()
  await shot(page, "04-work-panel-review")
  expect(errors).toEqual([])
})

test("1 permission dock: shell ask in the real composer, no focus theft, Ctrl+Shift+Enter then Enter", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 권한 dock")
  await openSession(page, sessionID)
  await expect(page.getByTestId("approval-pill")).toHaveAttribute("data-mode", "ask")
  await send(page, "[shell echo p5-permission-ok]")
  const dock = page.getByTestId("permission-dock")
  await expect(dock).toBeVisible()
  await expect(dock.getByTestId("request-title")).toHaveText("셸 명령 실행 승인")
  await expect(dock.getByTestId("permission-command")).toHaveText("echo p5-permission-ok")
  // The dock never takes focus from the composer (the user may be typing).
  await expect(composer(page)).toBeFocused()
  await composer(page).pressSequentially("draft")
  await shot(page, "01-permission-dock")
  await page.keyboard.press("Control+Shift+Enter")
  await expect(dock).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(dock).toHaveCount(0)
  await idle(page)
  await expect(
    page.getByTestId("transcript").getByText("도구 실행을 마쳤습니다.", { exact: true }).last(),
  ).toBeVisible()
  await expect(composer(page)).toHaveValue("draft")
  await composer(page).fill("")
  await shot(page, "01-permission-done")
  expect(errors).toEqual([])
})

test("8 approval modes: 읽기 전용 = resource ** deny (no * deny), shell refused without a dock; 전체 허용 confirms once; settings", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 승인 모드")
  await openSession(page, sessionID)
  const pill = page.getByTestId("approval-pill")
  await pill.click()
  const menu = page.getByTestId("approval-menu")
  await expect(menu).toBeVisible()
  await shot(page, "08-approval-menu")
  await menu.getByTestId("approval-mode-read-only").click()
  await expect(pill).toHaveAttribute("data-mode", "read-only")
  const rules = (await sessionInfo(page, sessionID)).permissions ?? []
  // The mode rules (`**` deny for edit and shell), then the protected-path denies the router keeps last.
  const mode = (action: string) => rules.some((rule: Rule) => rule.action === action && rule.resource === "**")
  expect(mode("edit") && mode("shell")).toBe(true)
  expect(rules.at(-1)?.effect).toBe("deny")
  // Mode changes never remove a tool from the list (01 §17.1 #8): no `*` deny, no wildcard action.
  expect(rules.some((rule) => rule.resource === "*" && rule.effect === "deny" && rule.action !== "browser")).toBe(false)
  expect(rules.some((rule) => rule.action === "*")).toBe(false)

  await send(page, "[shell echo read-only]")
  await idle(page)
  await expect(page.getByTestId("permission-dock")).toHaveCount(0)
  expect(await pendingPermissions(page, sessionID)).toEqual([])

  await pill.click()
  await menu.getByTestId("approval-mode-full").click()
  await expect(page.getByTestId("approval-confirm")).toBeVisible()
  await shot(page, "08-approval-full-confirm")
  await page.getByTestId("approval-confirm-full").click()
  await expect(pill).toHaveAttribute("data-mode", "full")
  await pill.click()
  await menu.getByTestId("approval-mode-ask").click()
  await expect(pill).toHaveAttribute("data-mode", "ask")

  // 설정 > 승인·권한 (lazy page of the requests module).
  await page.goto("/settings/approval")
  await expect(page.getByTestId("settings-approval")).toBeVisible()
  await shot(page, "08-settings-approval")
  expect(errors).toEqual([])
})

test("2 question form and web search consent: the question tool's form answers in the dock; consent shows three choices", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 질문 폼")
  await openSession(page, sessionID)
  await send(page, "[question] 데이터베이스를 골라 줘")
  const form = page.getByTestId("form-dock")
  await expect(form).toBeVisible()
  await expect(form).toContainText("어느 데이터베이스를 쓸까요?")
  await shot(page, "02-question-form")
  await form.getByTestId("form-option").filter({ hasText: "Postgres" }).click()
  await form.getByTestId("form-submit").click()
  await expect(form).toHaveCount(0)
  await idle(page)
  await expect(
    page.getByTestId("transcript").getByText("도구 실행을 마쳤습니다.", { exact: true }).last(),
  ).toBeVisible()

  // Web search: approve the permission if core asks, then the first-use consent dock (three choices, 18.2). Skipping
  // fails this call without sending a query anywhere (no network in the walkthrough).
  await send(page, "[websearch] 최신 소식")
  const permission = page.getByTestId("permission-dock")
  const consent = page.getByTestId("websearch-dock")
  await expect(permission.or(consent).first()).toBeVisible()
  if (await permission.isVisible()) {
    await expect(permission.getByTestId("request-title")).toHaveText("웹 검색 승인")
    await permission.getByTestId("permission-once").click()
  }
  await expect(consent).toBeVisible()
  await expect(consent.getByTestId("websearch-allow")).toContainText("검색 허용")
  await expect(consent.getByTestId("websearch-choose")).toBeVisible()
  await expect(consent.getByTestId("websearch-disable")).toBeVisible()
  await shot(page, "02-websearch-consent")
  await consent.getByTestId("websearch-skip").click()
  await expect(consent).toHaveCount(0)
  await idle(page)
  expect(errors).toEqual([])
})

test("11 subagent: the child's request shows in the parent dock and strip, 열기 → child with breadcrumb and notice", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const parentID = await newSession(page, "P5 하위 에이전트")
  await openSession(page, parentID)
  await send(page, "[subagent] 라우터를 조사해 줘")
  const dock = page.getByTestId("permission-dock")
  await expect(dock).toBeVisible({ timeout: 30_000 })
  await expect(dock.getByTestId("request-origin")).toContainText('하위 에이전트 "general"의 요청')
  const strip = page.getByTestId("subagent-strip")
  await expect(strip).toBeVisible()
  await expect(strip.getByTestId("child-request-badge")).toContainText("? 1")
  await shot(page, "11-subagent-parent")
  await strip.getByTestId("subagent-open").first().click()
  await expect.poll(() => currentSession(page)).not.toBe(parentID)
  const childID = currentSession(page)
  expect((await sessionInfo(page, childID)).parentID).toBe(parentID)
  await expect(page.getByTestId("header").getByTestId("subagent-breadcrumb")).toBeVisible()
  await expect(page.getByTestId("child-notice")).toContainText("하위 에이전트 대화는 부모 대화가 제어해요")
  await expect(composer(page)).toHaveAttribute("readonly", "")
  await shot(page, "11-subagent-child")
  // Approve from the child's own dock, then back to the parent, whose turn completes.
  await page.getByTestId("permission-dock").getByTestId("permission-once").click()
  await page.getByTestId("child-back").click()
  await expect.poll(() => currentSession(page)).toBe(parentID)
  await idle(page, 60_000)
  await expect(page.getByTestId("subagent-strip")).toHaveCount(0)
  expect(errors).toEqual([])
})

test("9 queue panel: steer and queue rows while a turn runs, badge toggle, 편집 puts the text back", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 대기열")
  await openSession(page, sessionID)
  await send(page, "[slow 8] 천천히")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await send(page, "끼워 넣을 메시지")
  await send(page, "대기열 메시지", true)
  const panel = page.getByTestId("queue-panel")
  await expect(panel).toBeVisible()
  const rows = panel.getByTestId("queue-row")
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: "끼워 넣을 메시지" })).toHaveAttribute("data-delivery", "steer")
  await expect(rows.filter({ hasText: "대기열 메시지" })).toHaveAttribute("data-delivery", "queue")
  await shot(page, "09-queue-panel")
  await rows.filter({ hasText: "대기열 메시지" }).getByTestId("queue-edit").click()
  await expect(composer(page)).toHaveValue("대기열 메시지")
  await expect(rows).toHaveCount(1)
  await composer(page).fill("")
  await idle(page, 60_000)
  const texts = (await messages(page, sessionID)).map((message) => message.text)
  expect(texts).toContain("끼워 넣을 메시지")
  expect(texts).not.toContain("대기열 메시지")
  expect(errors).toEqual([])
})

test("12 @ mentions: files from fs.find in the real composer, Enter makes a chip, the server stores the range", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 멘션")
  await openSession(page, sessionID)
  const box = composer(page)
  await box.click()
  await box.pressSequentially("이 줄 봐줘 @router#L10-40")
  const list = page.getByTestId("suggest-list")
  await expect(list).toBeVisible()
  await expect(list.getByTestId("suggest-option").first()).toHaveText(/src\/router\.ts#L10-40/)
  await shot(page, "12-mention-list")
  await box.press("Enter")
  await expect(page.getByTestId("mention-chip")).toHaveText(/src\/router\.ts#L10-40/)
  await box.press("Control+Enter")
  await expect(box).toHaveValue("")
  await expect(page.getByTestId("mention-chips")).toHaveCount(0)
  await idle(page)
  await expect
    .poll(async () => (await messages(page, sessionID)).find((message) => message.type === "user")?.text)
    .toBe("@src/router.ts#L10-40\n이 줄 봐줘")
  expect(errors).toEqual([])
})

test("13 / commands: the list mixes server and client commands; a user command runs on the server", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 명령")
  await openSession(page, sessionID)
  const box = composer(page)
  await box.click()
  await box.pressSequentially("/")
  const list = page.getByTestId("suggest-list")
  await expect(list).toBeVisible()
  for (const name of ["/hello", "/undo", "/model", "/terminal"]) await expect(list).toContainText(name)
  await expect(list).toContainText("마지막 턴 복원(파일 포함)")
  await shot(page, "13-command-list")
  await box.fill("")
  await box.pressSequentially("/hel")
  await expect(list.getByTestId("suggest-option").first()).toContainText("/hello")
  await box.press("Enter")
  await expect(box).toHaveValue("/hello ")
  await box.pressSequentially("세계")
  await box.press("Control+Enter")
  await expect(box).toHaveValue("")
  await idle(page)
  await expect
    .poll(async () => (await messages(page, sessionID)).find((message) => message.type === "user")?.text)
    .toBe("Say hello to 세계")
  // A client command: /terminal opens the terminal where the layout puts it (the 터미널 tab here).
  await box.pressSequentially("/terminal")
  await box.press("Enter")
  await expect(page.locator("#own-tab-terminal")).toHaveAttribute("aria-selected", "true")
  expect(errors).toEqual([])
})

test("10 attachments: ＋ uploads to the server temp folder, the chip shows progress/ready, sent as a path reference", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 첨부")
  await openSession(page, sessionID)
  const chooser = page.waitForEvent("filechooser")
  await page.getByTestId("attach-button").click()
  await (await chooser).setFiles({ name: "메모.txt", mimeType: "text/plain", buffer: Buffer.from("첨부 내용\n") })
  const chip = page.getByTestId("attachment-chip")
  await expect(chip).toHaveAttribute("data-state", "ready")
  await expect(chip).toContainText("메모.txt")
  await shot(page, "10-attachment-chip")
  await send(page, "첨부 파일을 읽어 줘")
  await expect(chip).toHaveCount(0)
  await idle(page)
  const user = (await messages(page, sessionID)).find((message) => message.type === "user")
  expect(user?.text).toMatch(/^첨부 파일을 읽어 줘\nAttached file: `.*메모\.txt`$/)
  // The transcript shows the typed text and the reference as a card (attachments' presentation).
  await expect(page.getByTestId("transcript").getByText("첨부 파일을 읽어 줘", { exact: true })).toBeVisible()
  await shot(page, "10-attachment-sent")

  // Attachments only (no text) may be sent too (03 §18.10).
  const again = page.waitForEvent("filechooser")
  await page.keyboard.press("Control+KeyU")
  await (await again).setFiles({ name: "only.txt", mimeType: "text/plain", buffer: Buffer.from("x\n") })
  await expect(chip).toHaveAttribute("data-state", "ready")
  await composer(page).press("Control+Enter")
  await expect(chip).toHaveCount(0)
  await idle(page)
  expect(errors).toEqual([])
})

test("5 + 7 review and revert: turn badge and footer link, review modes, 이 지점으로 복원 → bar → 변경 보기 → 복원 취소", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 리뷰와 복원")
  await openSession(page, sessionID)
  // Make the accounts tab the visible one, so the review badge is not cleared by seeing the tab.
  await panelTab(page, "accounts").click()
  const file = `p5-revert-${Date.now()}.txt`
  const prompt = `[write notes/${file}] 파일을 만들어 줘`
  await send(page, prompt)
  const dock = page.getByTestId("permission-dock")
  await expect(dock).toBeVisible()
  await dock.getByTestId("permission-once").click()
  await idle(page)
  await expect(page.getByTestId("tab-badge-review")).toHaveText("1")
  const link = page.getByTestId("review-footer-link")
  await expect(link).toHaveText(/변경 1개/)
  await shot(page, "05-review-badge-footer")
  await link.click()
  await expect(panelTab(page, "review")).toHaveAttribute("aria-selected", "true")
  const review = page.locator("#own-tabpanel-review")
  await expect(review.getByTestId("review-mode")).toHaveValue("lastTurn")
  await expect(review.getByTestId("review-list")).toContainText(file)
  await shot(page, "05-review-last-turn")
  await review.getByTestId("review-mode").selectOption("working")
  await expect(review.getByTestId("review-list")).toContainText("router.ts")
  await review.getByTestId("review-mode").selectOption("branch")
  // A local feature branch without an upstream: the server cannot infer the base, so the tab asks (18.5).
  await expect(review.getByTestId("review-base-needed")).toHaveText("base를 고르세요")
  await review.getByTestId("review-base").selectOption("main")
  await expect(review.getByTestId("review-list")).toContainText("estimate.ts")
  await shot(page, "05-review-branch")

  // 18.7: the session-ui message action in the bubble's menu (upstream ae0fde771d), labelled with the own verb (복원,
  // never 되돌리기) also on the newest prompt, whose upstream label is `Undo`.
  const message = page.getByTestId("transcript").locator('[data-component="user-message"]').filter({ hasText: prompt })
  // The chevron shows (and takes the pointer) while the bubble itself is hovered.
  await message.locator('[data-slot="user-message-text"]').hover()
  await message.getByRole("button", { name: "메시지 메뉴" }).click()
  await page.getByRole("menu").getByRole("menuitem", { name: "이 지점으로 복원" }).click()
  const dialog = page.getByTestId("revert-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("revert-files")).toBeChecked()
  await shot(page, "07-revert-dialog")
  await dialog.getByTestId("revert-confirm").click()
  const bar = page.getByTestId("revert-bar")
  await expect(bar).toBeVisible()
  await expect(composer(page)).toHaveValue(prompt)
  await bar.getByTestId("revert-view").click()
  await expect(review.getByTestId("review-mode")).toHaveValue("reverted")
  await expect(review.getByTestId("review-list")).toContainText(file)
  await shot(page, "07-revert-bar-review")
  await bar.getByTestId("revert-clear").click()
  await expect(bar).toHaveCount(0)
  await expect(composer(page)).toHaveValue("")
  expect(errors).toEqual([])
})

test("5 review without Git: only 마지막 턴 / 이 세션 전체 and the no-Git note", async ({ page }) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 Git 없음", state.folders.plain)
  await openSession(page, sessionID)
  await panelTab(page, "review").click()
  const review = page.locator("#own-tabpanel-review")
  await expect(review.getByTestId("review-novcs")).toBeVisible()
  const options = await review
    .getByTestId("review-mode")
    .locator("option")
    .evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value))
  expect(options).toEqual(["lastTurn", "session"])
  await shot(page, "05-review-no-git")
  expect(errors).toEqual([])
})

/** Terminal output as text (the terminal's own `출력을 텍스트로 보기`, 11장), for assertions. */
async function terminalText(page: Page) {
  const button = page.getByTestId("terminal-view-text").first()
  await button.click()
  const text = await page.getByTestId("terminal-text").locator("pre").innerText()
  await button.click()
  return text
}

/** The per-window layout is saved 300 ms after a change; wait for it before a reload. */
async function placementSaved(page: Page, placement: "tab" | "bottom") {
  await expect
    .poll(() =>
      page.evaluate(
        (value) =>
          Object.keys(localStorage).some(
            (key) =>
              key.startsWith("own.web.layout.") &&
              (localStorage.getItem(key) ?? "").includes(`"terminalPlacement":"${value}"`),
          ),
        placement,
      ),
    )
    .toBe(true)
}

test("6 terminal: Ctrl+` opens the 터미널 tab in the session's folder, a command runs; 대화 아래 docks it under the composer", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 터미널")
  await openSession(page, sessionID)
  await page.locator("body").click({ position: { x: 700, y: 300 } })
  await page.keyboard.press("Control+Backquote")
  await expect(panelTab(page, "terminal")).toHaveAttribute("aria-selected", "true")
  const tab = page.getByTestId("terminal-tab").first()
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await expect(tab).toContainText("workspace")
  const view = page.locator("#own-tabpanel-terminal")
  // Type once the shell shows its prompt: keys sent while it still starts (its profile, PSReadLine) can be lost, and a
  // loaded PC takes many seconds there (2026-10-17).
  await expect
    .poll(async () => /(>|\$|#)\s*$/.test((await terminalText(page)).trimEnd() + " "), { timeout: 60_000 })
    .toBe(true)
  await view.locator(".own-terminal-screen canvas").first().click()
  await page.keyboard.type("echo p5-term-ok")
  await page.keyboard.press("Enter")
  await expect
    .poll(async () => (await terminalText(page)).split("p5-term-ok").length - 1, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(2)
  await expect(page.getByTestId("tab-badge-terminal")).toHaveText("1")
  await shot(page, "06-terminal-tab")

  // 설정 > 레이아웃 > 터미널 위치: 대화 아래 — the 터미널 tab leaves the panel, Ctrl+` toggles the dock (4.7.3).
  await page.goto("/settings/layout")
  await page.getByTestId("settings-layout").getByRole("radio", { name: "대화 아래" }).click()
  await placementSaved(page, "bottom")
  await openSession(page, sessionID)
  await expect(panelTab(page, "terminal")).toHaveCount(0)
  await page.locator("body").click({ position: { x: 700, y: 300 } })
  await page.keyboard.press("Control+Backquote")
  const dock = page.getByTestId("terminal-dock")
  await expect(dock).toBeVisible()
  await expect(dock.getByTestId("terminal-tab").first()).toBeVisible({ timeout: 30_000 })
  await shot(page, "06-terminal-dock")
  await page.locator("body").click({ position: { x: 700, y: 300 } })
  await page.keyboard.press("Control+Backquote")
  await expect(dock).toBeHidden()
  await page.goto("/settings/layout")
  await page.getByTestId("settings-layout").getByRole("radio", { name: "작업 패널 탭" }).click()
  await placementSaved(page, "tab")
  expect(errors).toEqual([])
})

test("3 + 15 project open and the web browser rule: Ctrl+O picker, confirm card, new session there with the deny rule", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await page.goto("/")
  await ready(page)
  await page.locator("body").click({ position: { x: 700, y: 300 } })
  await page.keyboard.press("Control+KeyO")
  const picker = page.getByTestId("project-picker")
  await expect(picker).toBeVisible()
  const listed: string[] = []
  page.on("request", (request) => {
    // Core `fs.list`, or own.accounts `folderPicker.list` since 2.2.6-own.16 (the path in its body).
    if (request.url().includes("/api/fs/list") || request.url().includes("/api/rpc/own.accounts/folderPicker.list"))
      listed.push(request.url())
  })
  await picker.getByTestId("project-path").fill(state.folders.hash)
  await picker.getByTestId("project-path").press("Enter")
  await picker.getByTestId("project-choose").click()
  await expect(picker.getByTestId("project-confirm-path")).toContainText("#2 한글 폴더")
  await expect(picker.getByTestId("project-confirm-git")).toContainText("Git 저장소가 아니에요")
  await shot(page, "03-project-confirm")
  // Browsing uses the control location with the path as an encoded query value (01 G15).
  for (const url of listed) expect(new URL(url).searchParams.get("location[directory]")).toBe(state.control)
  await picker.getByTestId("project-start").click()
  await expect(picker).toHaveCount(0)
  await expect(page).toHaveURL(/\/srv\/local\/p\/[^/]+$/)
  await expect(page.getByTestId("project-select")).toContainText("#2 한글 폴더")
  // 18.15 (01 §17.1 #5): a window without the browser pane says what the next session gets.
  await expect(page.getByTestId("composer").getByTestId("browser-tool-notice")).toBeVisible()
  await shot(page, "15-new-session-browser-note")
  await send(page, "새 폴더에서 시작")
  await expect(page).toHaveURL(/\/srv\/local\/s\/[^/]+$/)
  const sessionID = currentSession(page)
  // Exact: the live-region announcement inside the transcript ("Alpha 응답 완료: 답변: …") contains the same text.
  await expect(page.getByTestId("transcript").getByText("답변: 새 폴더에서 시작", { exact: true })).toBeVisible()
  await idle(page)
  const info = await sessionInfo(page, sessionID)
  expect(info.location.directory.replaceAll("\\", "/")).toBe(state.folders.hash.replaceAll("\\", "/"))
  const rules = info.permissions ?? []
  expect(rules).toContainEqual({ action: "browser", resource: "*", effect: "deny" })
  // The new-session approval mode (묻기) went in before the first prompt (5.1).
  expect(rules.some((rule: Rule) => rule.action === "shell" && rule.effect === "ask")).toBe(true)
  await expect(page.getByTestId("approval-pill")).toHaveAttribute("data-mode", "ask")
  expect(errors).toEqual([])
})

test("14 MCP: settings list with status and cache notes, Ctrl+; dialog, server popover summary, OAuth sign-in", async ({
  page,
}) => {
  const errors = watchErrors(page)
  await openSession(page, state.session)
  await page.goto("/settings/mcp")
  const settings = page.getByTestId("settings-mcp")
  const row = (name: string) => settings.locator(`[data-testid=mcp-row][data-name="${name}"]`)
  await expect(row("docs")).toHaveAttribute("data-status", "connected")
  await expect(row("direct")).toHaveAttribute("data-status", "connected")
  await expect(row("secure")).toHaveAttribute("data-status", "needs_auth")
  await shot(page, "14-settings-mcp")

  await openSession(page, state.session)
  await page.getByTestId("server-status").click()
  const panel = page.getByTestId("server-panel")
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId("server-panel-mcp")).toContainText("MCP 3")
  await expect(panel.getByTestId("server-panel-mcp-auth")).toHaveText("로그인 필요 1")
  await shot(page, "14-server-popover")
  await page.keyboard.press("Escape")
  await page.locator("body").click({ position: { x: 700, y: 300 } })
  await page.keyboard.press("Control+Semicolon")
  const dialog = page.getByTestId("mcp-dialog")
  await expect(dialog).toBeVisible()
  const secure = dialog.locator('[data-testid=mcp-row][data-name="secure"]')
  await expect(secure).toHaveAttribute("data-status", "needs_auth")
  const connects: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/integration/") && request.method() === "POST") connects.push(request.url())
  })
  const popup = page.context().waitForEvent("page")
  await secure.getByTestId("mcp-login").click()
  const authorization = await popup
  await authorization.waitForURL(/\/callback\?/)
  await expect(page.getByTestId("mcp-signin-body")).toHaveAttribute("data-phase", "done")
  await shot(page, "14-mcp-signin")
  await page.getByTestId("mcp-signin").getByRole("button", { name: "닫기" }).last().click()
  await expect(secure).toHaveAttribute("data-status", "connected")
  expect(connects).toHaveLength(1)
  expect(new URL(connects[0]!).pathname).toMatch(/^\/api\/integration\/mcp_[0-9a-f]{16}\/connect\/oauth$/)
  expect(errors).toEqual([])
})

test("9 × 02 §5.3 WAIT_SAFE: follow-ups queue behind a pending switch and the rows name the account; the chip shows it", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 전환 대기")
  await openSession(page, sessionID)
  await send(page, "[slow 10] 오래 걸리는 일")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  const target = { providerID: state.accounts.bravo.providerID, id: state.model }
  const estimate = await rpc<{ estimateID: string }>(page, "switch.estimate", { sessionID, target })
  await rpc(page, "switch.apply", {
    sessionID,
    estimateID: estimate.estimateID,
    target,
    strategy: "now",
    reason: "manual",
  })
  await send(page, "전환 뒤에 할 일")
  const row = page.getByTestId("queue-row").filter({ hasText: "전환 뒤에 할 일" })
  await expect(row).toHaveAttribute("data-delivery", "queue")
  await expect(row.getByTestId("queue-note")).toHaveText("전환 뒤 Bravo로 실행")
  await shot(page, "09-queue-wait-safe")
  await rpc(page, "switch.cancel", { sessionID })
  await expect(row.getByTestId("queue-note")).toHaveText("턴이 끝나면 보냄")
  await page.getByTestId("composer-stop").click()
  await idle(page)
  expect(errors).toEqual([])
})

test("03 §12 IME in the wired composer: Ctrl+Enter during a Korean composition sends once; §10 key decisions hold", async ({
  page,
}) => {
  const errors = watchErrors(page)
  const sessionID = await newSession(page, "P5 IME")
  await openSession(page, sessionID)
  const prompts: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(new URL(request.url()).pathname))
      prompts.push(request.url())
  })
  const box = composer(page)
  await box.focus()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 })
  await cdp.send("Input.imeSetComposition", { text: "한글", selectionStart: 2, selectionEnd: 2 })
  // The default `보내는 키` is Ctrl+Enter (03 §4.6); CDP modifier 2 is Ctrl.
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    modifiers: 2,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text: "한글" })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  })
  await cdp.detach()
  await expect(page.getByTestId("transcript").getByText("한글", { exact: true })).toHaveCount(1)
  await expect(box).toHaveValue("")
  await idle(page)
  expect(prompts).toHaveLength(1)

  // Ctrl+B edits text in the composer (not the sidebar); Ctrl+Shift+L is 문맥에 추가, not the panel; Ctrl+. opens the
  // "모델 @ 계정" switcher (03 §10 conflict table).
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "open")
  await box.press("Control+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "open")
  const panel = await page.getByTestId("app").getAttribute("data-panel")
  await box.press("Control+Shift+KeyL")
  await expect(page.getByTestId("app")).toHaveAttribute("data-panel", panel!)
  await box.press("Control+Period")
  await expect(page.getByTestId("switcher")).toBeVisible()
  await page.keyboard.press("Escape")
  await page.locator("body").click({ position: { x: 700, y: 300 } })
  await page.keyboard.press("Control+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "closed")
  await page.keyboard.press("Control+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "open")
  expect(errors).toEqual([])
})

test("03 §9 OS notifications on the web: settings asks for the browser permission; granted shows 허용됨", async ({
  page,
  context,
}) => {
  await page.goto("/settings/general")
  await ready(page)
  await expect(page.getByTestId("settings-notify-allow")).toBeVisible()
  await context.grantPermissions(["notifications"])
  await page.reload()
  await expect(page.getByTestId("settings-notify-state")).toHaveAttribute("data-state", "granted")
  await shot(page, "09-settings-notifications")
})
