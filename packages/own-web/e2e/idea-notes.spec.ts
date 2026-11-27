// 아이디어 노트 (03 §4.4.1) in Edge against the real server and own.accounts `ideas.*`: the quick capture from a
// conversation keeps the composer's draft and focus, the idea is on the board, another browser profile (another device)
// sees it and its new idea reaches this board live, `새 대화로 시작` only drafts it, a removal can be undone, an idea moves
// into a project's notes, and the phone board is a full screen with a floating `+`.
import { expect, test, type APIRequestContext } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()

async function rpc(request: APIRequestContext, method: string, input: unknown) {
  const response = await request.post(`/api/rpc/own.accounts/${method}`, {
    data: { input },
    params: { "location[directory]": state.control },
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

test("ideas: quick capture mid-conversation, the shared board, a new conversation's draft, undo and moving", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000)
  // The backend is shared by the suite (OWN_WEB_E2E_REUSE): start from an empty board.
  const listed = (await rpc(page.request, "ideas.list", {})) as { ideas?: { id: string }[] }
  for (const idea of listed.ideas ?? []) await rpc(page.request, "ideas.remove", { id: idea.id })
  // Other modules' known console noise (health probes of absent RPC ids, presets on the new-session screen) is not
  // this feature's; every failed ideas.* or notes.* call and every error naming the feature is.
  const errors = watchErrors(page)
  const failed: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400 && /\/(ideas|notes)\./.test(response.url())) failed.push(response.url())
  })
  await page.goto(`/srv/local/s/${state.sessions[0]!.id}`)
  await expect(page.getByTestId("header-title")).toHaveText(state.sessions[0]!.title, { timeout: 60_000 })
  const composer = page.locator("#own-composer-input")
  await composer.fill("보내기 전의 초안")
  await composer.focus()

  // Ctrl+Alt+I from the composer: the popover takes the idea, Enter sticks it, the composer is as it was.
  await page.keyboard.press("Control+Alt+KeyI")
  const capture = page.getByTestId("idea-capture")
  await expect(capture).toBeVisible({ timeout: 30_000 })
  const field = capture.getByLabel("아이디어", { exact: true })
  await expect(field).toBeFocused()
  await field.pressSequentially("회의록 자동 요약 #도구")
  await field.press("Shift+Enter")
  await field.pressSequentially("화자 구분까지")
  await page.screenshot({ path: "e2e/test-results/idea-capture.png" })
  await field.press("Enter")
  await expect(capture).toBeHidden()
  await expect(composer).toHaveValue("보내기 전의 초안")
  await expect(composer).toBeFocused()
  const toast = page.getByTestId("toast").filter({ hasText: "아이디어를 붙였어요" })
  await expect(toast).toBeVisible()

  // Esc closes and keeps the draft for the next time.
  await page.keyboard.press("Control+Alt+KeyI")
  await capture.getByLabel("아이디어", { exact: true }).fill("반쯤 쓴 생각")
  await page.keyboard.press("Escape")
  await expect(capture).toBeHidden()
  await expect(composer).toBeFocused()
  await page.keyboard.press("Control+Alt+KeyI")
  await expect(capture.getByLabel("아이디어", { exact: true })).toHaveValue("반쯤 쓴 생각")
  await capture.getByLabel("아이디어", { exact: true }).fill("")
  await page.keyboard.press("Escape")

  // The board from the header button: the sticky with its tag; nothing went to the browser's storage.
  await page.getByTestId("header-ideas").click()
  const board = page.getByTestId("idea-board")
  await expect(board).toBeVisible()
  const cards = board.getByTestId("idea-card")
  await expect(cards).toHaveCount(1)
  await expect(cards.first().getByTestId("idea-text")).toHaveText("회의록 자동 요약 #도구\n화자 구분까지")
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => (localStorage.getItem(key) ?? "").includes("회의록 자동 요약")),
  )
  expect(stored).toEqual([])

  // Another device (a browser profile of its own) sees it, and its new idea reaches this open board.
  const device = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: "ko-KR" })
  const other = await device.newPage()
  await other.goto(`/srv/local/s/${state.sessions[1]!.id}`)
  await expect(other.getByTestId("header-title")).toHaveText(state.sessions[1]!.title, { timeout: 60_000 })
  await other.getByTestId("header-ideas").click()
  const otherBoard = other.getByTestId("idea-board")
  await expect(otherBoard.getByTestId("idea-card")).toHaveCount(1)
  await expect(otherBoard.getByTestId("idea-text")).toHaveText("회의록 자동 요약 #도구\n화자 구분까지")
  const otherField = otherBoard.getByLabel("아이디어", { exact: true })
  await otherField.fill("다른 기기에서 적은 생각 #앱")
  await otherField.press("Enter")
  await expect(otherBoard.getByTestId("idea-card")).toHaveCount(2)
  await expect(cards).toHaveCount(2)
  await expect(cards.first().getByTestId("idea-text")).toHaveText("다른 기기에서 적은 생각 #앱")

  // Pin the older one to the top; the other device sees the order too. Tags filter the board.
  await cards.nth(1).getByTestId("idea-pin").click()
  await expect(cards.first()).toHaveAttribute("data-pinned", "")
  await expect(otherBoard.getByTestId("idea-card").first().getByTestId("idea-text")).toHaveText(
    "회의록 자동 요약 #도구\n화자 구분까지",
  )
  await board.getByTestId("idea-tag").filter({ hasText: "#앱" }).click()
  await expect(cards).toHaveCount(1)
  await board.getByRole("button", { name: "전체", exact: true }).click()
  await expect(cards).toHaveCount(2)
  await page.screenshot({ path: "e2e/test-results/idea-board.png" })

  // Delete and undo: the card comes back in its place.
  await cards.nth(1).getByTestId("idea-more").click()
  await cards.nth(1).getByTestId("idea-delete").click()
  await expect(cards).toHaveCount(1)
  await board.getByTestId("idea-undo").click()
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(1).getByTestId("idea-text")).toHaveText("다른 기기에서 적은 생각 #앱")

  // Edit in place.
  await cards.nth(1).getByTestId("idea-edit").click()
  const editor = cards.nth(1).getByTestId("idea-edit-input")
  await editor.fill("다른 기기에서 적은 생각 #앱\n고쳐 씀")
  await editor.press("Control+Enter")
  await expect(cards.nth(1).getByTestId("idea-text")).toHaveText("다른 기기에서 적은 생각 #앱\n고쳐 씀")
  await expect(otherBoard.getByTestId("idea-card").nth(1).getByTestId("idea-text")).toHaveText(
    "다른 기기에서 적은 생각 #앱\n고쳐 씀",
  )

  // Into a project's notes: the idea leaves the board and is a note of that folder.
  await cards.nth(1).getByTestId("idea-more").click()
  await cards.nth(1).getByTestId("idea-move").click()
  const move = page.getByTestId("idea-move-dialog")
  await expect(move).toBeVisible()
  await move.getByTestId("idea-move-project").first().click()
  await expect(board.getByTestId("idea-notice")).toContainText("프로젝트 노트로 옮겼어요")
  await expect(cards).toHaveCount(1)

  // 새 대화로 시작: the new-session screen with the idea in its draft, never sent.
  await cards.first().getByTestId("idea-more").click()
  await cards.first().getByTestId("idea-start-chat").click()
  await expect(board).toBeHidden()
  await expect(page.getByTestId("header-title")).toHaveText("새 대화")
  await expect(composer).toHaveValue("회의록 자동 요약 #도구\n화자 구분까지")
  await expect(composer).toBeFocused()
  await page.waitForTimeout(1_000)
  await expect(page.getByTestId("header-title")).toHaveText("새 대화")

  // The moved note is in the project's 노트 tab.
  await page.goto(`/srv/local/s/${state.sessions[0]!.id}`)
  await expect(page.getByTestId("header-title")).toHaveText(state.sessions[0]!.title, { timeout: 60_000 })
  await page.getByTestId("workspace-notes-toggle").click()
  const notes = page.getByTestId("workspace-notes")
  await expect(notes.getByLabel("저장된 노트 열기").locator("option")).toContainText(["다른 기기에서 적은 생각 #앱"])

  // The phone: the board is the whole screen and the floating + opens its capture field.
  const phoneContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    locale: "ko-KR",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  })
  const phone = await phoneContext.newPage()
  await phone.goto(`/srv/local/s/${state.sessions[0]!.id}`)
  // A phone's conversation header has no bulb: 아이디어 노트 is in the conversation ⋯ (S23 pass).
  await expect(phone.getByTestId("header-ideas")).toBeHidden()
  await phone.getByTestId("session-menu").click()
  await phone.getByTestId("session-menu-ideas").click()
  const phoneBoard = phone.getByTestId("idea-board")
  await expect(phoneBoard.getByTestId("idea-card")).toHaveCount(1)
  const box = await phoneBoard.boundingBox()
  expect(box?.width).toBe(390)
  await expect(phoneBoard.getByLabel("아이디어", { exact: true })).toHaveCount(0)
  await phoneBoard.getByTestId("idea-fab").click()
  const phoneField = phoneBoard.getByLabel("아이디어", { exact: true })
  await expect(phoneField).toBeFocused()
  await phoneField.fill("휴대폰에서 급하게 적음")
  await phoneBoard.getByTestId("idea-capture-save").click()
  await expect(phoneBoard.getByTestId("idea-card")).toHaveCount(2)
  await expect(phoneBoard.getByTestId("idea-fab")).toBeVisible()
  await phone.screenshot({ path: "e2e/test-results/idea-board-phone.png" })

  await phoneContext.close()
  await device.close()
  expect(failed).toEqual([])
  expect(errors.filter((error) => /idea/i.test(error))).toEqual([])
})
