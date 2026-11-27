// 보내는 키 (03 §4.6, §10, §12; EM 2026-10-18, EM-10 2026-10-23) against the real server: the default is
// `Ctrl+Enter로 보내기`, so Enter breaks lines and Ctrl+Enter sends the multi-line text once (also out of a real Chromium
// composition); the `▾` beside 전송 switches to `Enter로 보내기` and a second window follows; only a change is stored,
// and the first key's `enter` (written while Enter was the default) is not read; a running turn takes Ctrl+Enter (끼워
// 넣기) and Alt+Enter (대기열, also from an open composition, which the composer commits itself); shell mode's
// placeholder names the key; 설정 > 일반 and the palette switch it too, and `실행 중 보내기 동작`'s note names both keys.
// Each test has its own browser context, so it starts at the default.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { backend, watchErrors } from "./support"

const STORED = "own.web.composer.sendKey.v2"

const state = backend()
const session = { id: "" }

async function userTexts(request: APIRequestContext, sessionID: string) {
  const response = await request.get(`/api/session/${sessionID}/message`)
  if (!response.ok()) return []
  const body = (await response.json()) as { data: { type: string; text?: string }[] }
  return body.data.flatMap((message) => (message.type === "user" && message.text ? [message.text] : []))
}

async function openSession(page: Page) {
  await page.goto(`/srv/local/s/${session.id}`)
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  await expect(page.locator("#own-composer-input")).toBeEditable()
}

/** A Korean composition through CDP, then the given key while it is still open (CDP modifiers: 1 Alt, 2 Ctrl). */
async function composeThenKey(page: Page, text: string, modifiers: number, commit: boolean) {
  const cdp = await page.context().newCDPSession(page)
  await page.locator("#own-composer-input").focus()
  for (let end = 1; end <= text.length; end++)
    await cdp.send("Input.imeSetComposition", { text: text.slice(0, end), selectionStart: end, selectionEnd: end })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    modifiers,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  if (commit) await cdp.send("Input.insertText", { text })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    modifiers,
    windowsVirtualKeyCode: 13,
  })
  await cdp.detach()
}

async function pickSendKey(page: Page, mode: "enter" | "modEnter") {
  await page.getByTestId("composer-send-key").click()
  await expect(page.getByTestId("composer-send-key-menu")).toBeVisible()
  await page.getByTestId(`composer-send-key-${mode}`).click()
  await expect(page.getByTestId("composer-send-key-menu")).toHaveCount(0)
  await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", mode)
}

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  const created = await request.post("/api/session", {
    data: {
      title: "보내는 키 e2e",
      model: { providerID: state.account.providerID, id: state.model },
      location: { directory: state.workspace },
    },
  })
  expect(created.ok()).toBe(true)
  const info = (await created.json()) as { id?: string; data?: { id: string } }
  session.id = info.data?.id ?? info.id ?? ""
})

test.afterAll(async ({ request }) => {
  if (session.id) await request.delete(`/api/session/${session.id}`)
})

test.describe("보내는 키 (03 §4.6)", () => {
  test("the default Ctrl+Enter: Enter breaks lines, Ctrl+Enter sends once; the menu beside 전송 switches, other windows follow", async ({
    page,
    context,
    request,
  }) => {
    const errors = watchErrors(page)
    await openSession(page)
    const composer = page.locator("#own-composer-input")
    const send = page.getByTestId("composer-send")
    const stored = (target: Page) => target.evaluate((key) => localStorage.getItem(key), STORED)
    // The default: Ctrl+Enter sends, and the placeholder and 전송 say so; nothing is stored for it.
    await expect(send).toHaveAttribute("title", "전송 (Ctrl+Enter) · Enter 줄바꿈")
    await expect(composer).toHaveAttribute("enterkeyhint", "enter")
    await expect(composer).toHaveAttribute("placeholder", "메시지를 입력하세요. Ctrl+Enter로 보내요 · / 명령, @ 파일")
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "modEnter")
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute(
      "title",
      "보내는 키 바꾸기 (지금: Ctrl+Enter로 보내기)",
    )
    expect(await stored(page)).toBeNull()
    // Shell mode's placeholder replaces the send hint, so it names the key too (and follows the setting, below).
    await composer.focus()
    await page.keyboard.type("!")
    await expect(composer).toHaveAttribute("placeholder", "셸 명령 — Ctrl+Enter로 실행 · 에이전트를 깨우지 않아요")
    await page.keyboard.press("Escape")
    await expect(composer).toHaveAttribute("placeholder", "메시지를 입력하세요. Ctrl+Enter로 보내요 · / 명령, @ 파일")

    // Multi-line text: Enter breaks the line, nothing is sent until Ctrl+Enter.
    const stamp = Date.now() % 10_000
    await composer.focus()
    await page.keyboard.type(`첫 줄 ${stamp}`)
    await page.keyboard.press("Enter")
    await page.keyboard.type("둘째 줄")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("셋째 줄")
    const text = `첫 줄 ${stamp}\n둘째 줄\n셋째 줄`
    await expect(composer).toHaveValue(text)
    await page.waitForTimeout(300)
    expect(await userTexts(request, session.id)).not.toContain(text)
    await page.keyboard.press("Control+Enter")
    await expect(composer).toHaveValue("")
    await expect.poll(() => userTexts(request, session.id)).toContain(text)

    // A Korean composition: Enter only commits (no send), Ctrl+Enter during the composition sends once.
    await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
    const korean = `조합 ${stamp}`
    await composeThenKey(page, "줄바꿈", 0, true)
    await expect(composer).toHaveValue("줄바꿈")
    await page.waitForTimeout(300)
    expect(await userTexts(request, session.id)).not.toContain("줄바꿈")
    await composer.fill("")
    await composeThenKey(page, korean, 2, true)
    await expect(composer).toHaveValue("")
    await expect.poll(() => userTexts(request, session.id)).toContain(korean)
    await page.waitForTimeout(500)
    expect((await userTexts(request, session.id)).filter((item) => item === korean)).toHaveLength(1)
    await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })

    // ▾ opens the two choices with their keys, the default first; the current one is checked and focused.
    await page.getByTestId("composer-send-key").click()
    const menu = page.getByTestId("composer-send-key-menu")
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitemradio")).toHaveText([/^Ctrl\+Enter로 보내기/, /^Enter로 보내기/])
    await expect(page.getByTestId("composer-send-key-modEnter")).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("composer-send-key-modEnter")).toBeFocused()
    await expect(page.getByTestId("composer-send-key-modEnter")).toContainText(
      "Enter 줄바꿈 · 실행 중 Alt+Enter 대기열",
    )
    await expect(page.getByTestId("composer-send-key-enter")).toContainText(
      "Shift+Enter 줄바꿈 · 실행 중 Ctrl+Enter 대기열",
    )
    // Arrow keys move inside, Esc closes and gives the focus back.
    await page.keyboard.press("ArrowDown")
    await expect(page.getByTestId("composer-send-key-enter")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId("composer-send-key")).toBeFocused()
    // Picking the current choice changes and stores nothing.
    await pickSendKey(page, "modEnter")
    expect(await stored(page)).toBeNull()

    // A second window of this browser opens with the default; a change comes back here live (the storage event).
    const other = await context.newPage()
    await openSession(other)
    await expect(other.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "modEnter")
    await page.bringToFront()

    await pickSendKey(page, "enter")
    await expect(
      page.getByTestId("toast").filter({ hasText: "Enter로 보내요. Shift+Enter는 줄바꿈이에요." }),
    ).toBeVisible()
    await expect(send).toHaveAttribute("title", "전송 (Enter) · Shift+Enter 줄바꿈")
    await expect(composer).toHaveAttribute("enterkeyhint", "send")
    await expect(composer).toHaveAttribute("placeholder", "메시지를 입력하세요. / 명령, @ 파일")
    expect(await stored(page)).toBe("enter")
    await expect(other.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "enter")
    await composer.focus()
    await page.keyboard.type("!")
    await expect(composer).toHaveAttribute("placeholder", "셸 명령 — Enter로 실행 · 에이전트를 깨우지 않아요")
    await page.keyboard.press("Escape")
    await expect(composer).toHaveAttribute("placeholder", "메시지를 입력하세요. / 명령, @ 파일")
    // Enter sends now, Shift+Enter breaks the line.
    const single = `엔터로 ${stamp}\n한 번`
    await composer.focus()
    await page.keyboard.type(`엔터로 ${stamp}`)
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("한 번")
    await page.keyboard.press("Enter")
    await expect(composer).toHaveValue("")
    await expect.poll(() => userTexts(request, session.id)).toContain(single)

    // Back to Ctrl+Enter in the second window: the first follows.
    await other.bringToFront()
    await expect(other.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
    await pickSendKey(other, "modEnter")
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "modEnter")
    await expect(composer).toHaveAttribute("placeholder", "메시지를 입력하세요. Ctrl+Enter로 보내요 · / 명령, @ 파일")
    await other.close()
    // Errors of this feature only: a conversation opened by its link may log an unrelated preset race.
    expect(errors.filter((error) => /send-key|sendKey|composer\/input|ime-enter/i.test(error))).toEqual([])
  })

  test("a chosen Enter survives a reload; the first key's enter (Enter was the default then) is not read", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("own.web.composer.sendKey", "enter"))
    await openSession(page)
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "modEnter")
    await pickSendKey(page, "enter")
    await page.reload()
    await expect(page.locator("#own-composer-input")).toBeEditable()
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "enter")
    expect(await page.evaluate((key) => localStorage.getItem(key), STORED)).toBe("enter")
  })

  test("while running under the default: the hint names the keys, Ctrl+Enter steers, Alt+Enter queues (also mid-composition)", async ({
    page,
  }) => {
    await openSession(page)
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "modEnter")
    const composer = page.locator("#own-composer-input")
    await composer.fill("[slow 30000] 천천히 답해 주세요")
    await composer.press("Control+Enter")
    await expect(page.getByTestId("composer-stop")).toBeVisible()
    await expect(page.getByTestId("composer-hint")).toHaveText(
      "실행 중 · Ctrl+Enter 끼워 넣기 · Alt+Enter 대기열 · Esc 두 번 중단",
    )
    // Enter is still a new line while running.
    await composer.fill("끼워 넣을 말")
    await composer.press("Enter")
    await expect(composer).toHaveValue("끼워 넣을 말\n")
    await composer.fill("끼워 넣을 말")
    await composer.press("Control+Enter")
    const panel = page.getByTestId("queue-panel")
    await expect(panel).toContainText("끼워 넣을 말")
    await expect(panel).toContainText("실행 중 Ctrl+Enter: 끼워 넣기")
    await expect(page.getByTestId("queue-row").filter({ hasText: "끼워 넣을 말" })).toHaveAttribute(
      "data-delivery",
      "steer",
    )
    await composer.fill("대기 하나")
    await composer.press("Alt+Enter")
    await expect(page.getByTestId("queue-row").filter({ hasText: "대기 하나" })).toHaveAttribute(
      "data-delivery",
      "queue",
    )
    // Alt+Enter while the composition stays open (no commit from the IME): the composer commits it within 300 ms.
    await composeThenKey(page, "대기 둘", 1, false)
    await expect(page.getByTestId("queue-row").filter({ hasText: "대기 둘" })).toHaveAttribute("data-delivery", "queue")
    await expect(composer).toHaveValue("")
    await expect(page.getByTestId("queue-row").filter({ hasText: "대기 둘" })).toHaveCount(1)
    // Every answer of this conversation is slow now (the fake reads the whole history): clear the rows, then stop.
    for (let left = 3; left > 0; left--) {
      await page.getByTestId("queue-row").first().getByTestId("queue-cancel").click()
      await expect(page.getByTestId("queue-row")).toHaveCount(left - 1)
    }
    await page.getByTestId("composer-stop").click()
    await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  })

  test("설정 > 일반 and the palette switch the send key; the running-delivery note names both keys", async ({
    page,
  }) => {
    await page.goto("/settings/general")
    const choices = page.getByTestId("settings-send-key")
    await expect(choices.getByRole("radio")).toHaveText(["Ctrl+Enter로 보내기", "Enter로 보내기"])
    await expect(choices.getByRole("radio", { name: "Ctrl+Enter로 보내기" })).toHaveAttribute("aria-checked", "true")
    const row = choices.locator("xpath=..")
    await expect(row).toContainText("대화 입력창에만 적용돼요. Enter는 줄바꿈이에요.")
    const followUp = page.getByTestId("settings-follow-up")
    const followUpRow = followUp.locator("xpath=..")
    await expect(followUpRow).toContainText("실행 중 보내기 동작")
    await expect(followUpRow).toContainText("Ctrl+Enter는 끼워 넣기로, Alt+Enter는 대기열로 보내요.")
    await followUp.getByRole("radio", { name: "대기열" }).click()
    await expect(followUpRow).toContainText("Ctrl+Enter는 대기열로, Alt+Enter는 끼워 넣기로 보내요.")
    await followUp.getByRole("radio", { name: "끼워 넣기" }).click()
    // The checked choice clicked again stores nothing (the device keeps following the default).
    await choices.getByRole("radio", { name: "Ctrl+Enter로 보내기" }).click()
    expect(await page.evaluate((key) => localStorage.getItem(key), STORED)).toBeNull()
    await choices.getByRole("radio", { name: "Enter로 보내기", exact: true }).click()
    await expect(row).toContainText("대화 입력창에만 적용돼요. Shift+Enter는 줄바꿈이에요.")
    await expect(followUpRow).toContainText("Enter는 끼워 넣기로, Ctrl+Enter는 대기열로 보내요.")

    await openSession(page)
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "enter")
    await page.keyboard.press("Control+KeyK")
    await expect(page.getByTestId("palette-input")).toBeFocused()
    await page.keyboard.type("보내는 키")
    const command = page.getByRole("option", { name: /보내는 키 바꾸기/ })
    await expect(command).toContainText("지금 Enter로 보내기 → Ctrl+Enter로 보내기")
    await command.click()
    await expect(
      page.getByTestId("toast").filter({ hasText: "Ctrl+Enter로 보내요. Enter는 줄바꿈이에요." }),
    ).toBeVisible()
    await expect(page.getByTestId("composer-send-key")).toHaveAttribute("data-send-key", "modEnter")
  })
})
