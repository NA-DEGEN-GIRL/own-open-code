// P3 integration walkthrough in Edge against dev/serve.ts (see playwright.config.ts). One page walks the product the
// way a user would; every step leaves a screenshot in $OWN_WEB_SHOTS:
//   sidebar + chips → Korean IME send-once + streaming → switcher → cost dialog → applied → limits tab (Codex 5 h / 7 d)
//   → /limits → add an API key (fake) → "이 계정으로 새 대화" → Codex import (fake old-app profile, linked)
//   → auto-compaction settings within 3 clicks.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

interface DevState {
  readonly web: string
  readonly control: string
  readonly accounts: Record<"alpha" | "bravo" | "device", { id: string; providerID: string; label: string }>
  readonly legacy: readonly { id: string; alias: string }[]
  readonly sessions: readonly { id: string; title: string; account: string }[]
}

const tmp = process.env.OWN_WEB_INTEGRATION_TMP!
const shots = process.env.OWN_WEB_SHOTS!
const state = JSON.parse(fs.readFileSync(path.join(tmp, "own-web-dev", "state.json"), "utf8")) as DevState
const session = (title: string) => state.sessions.find((item) => item.title === title)!
fs.mkdirSync(shots, { recursive: true })

test.describe.configure({ mode: "serial" })

let page: Page
const errors: string[] = []
const shot = (name: string) => page.screenshot({ path: path.join(shots, `${name}.png`) })

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
})

test.afterAll(async () => {
  // Nothing in the walkthrough may throw in the page.
  expect(errors).toEqual([])
  await page.context().close()
})

test("sidebar: projects, sessions and account chips from own.accounts", async () => {
  await page.goto("/")
  const list = page.getByTestId("session-list")
  for (const item of state.sessions) await expect(list.getByText(item.title, { exact: true })).toBeVisible()
  await expect(list.getByTestId("project-row")).toHaveCount(2)
  for (const label of ["Alpha", "Bravo", "개인 Pro"])
    await expect(list.getByTestId("account-chip").filter({ hasText: label }).first()).toBeVisible()
  await expect(page.getByTestId("accounts-in-use").getByText("개인 Pro")).toBeVisible()
  await shot("01-sidebar-chips")
})

test("composer: a Korean IME composition sent with Ctrl+Enter (the default) goes once, and the answer streams", async () => {
  const target = session("own-web 뼈대")
  await page.getByTestId("session-list").getByText(target.title, { exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/srv/local/s/${target.id}$`))
  const prompts: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(new URL(request.url()).pathname))
      prompts.push(request.url())
  })
  const composer = page.locator("#own-composer-input")
  await composer.focus()
  const cdp = await page.context().newCDPSession(page)
  // Chromium order A2 (03 §12): compositionstart → keydown 229 (composing) → commit → keyup Enter, with Ctrl held
  // (`보내는 키` defaults to Ctrl+Enter, 03 §4.6; CDP modifier 2).
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 })
  await cdp.send("Input.imeSetComposition", { text: "한도", selectionStart: 2, selectionEnd: 2 })
  await cdp.send("Input.insertText", { text: "한도" })
  await cdp.send("Input.insertText", { text: " " })
  await cdp.send("Input.imeSetComposition", { text: "확", selectionStart: 1, selectionEnd: 1 })
  await cdp.send("Input.imeSetComposition", { text: "확인", selectionStart: 2, selectionEnd: 2 })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    modifiers: 2,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text: "확인" })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    modifiers: 2,
    windowsVirtualKeyCode: 13,
  })
  await cdp.detach()

  const transcript = page.getByTestId("transcript")
  await expect(transcript.getByText("한도 확인", { exact: true })).toHaveCount(1)
  await expect(composer).toHaveValue("")
  // Streaming: the stop button is up and the answer grows before the turn ends.
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await expect(transcript.getByText(/전환 비용은/).first()).toBeVisible()
  await shot("02-ime-streaming")
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  await expect(transcript.getByText(/가짜 provider가 만든 문장/).first()).toBeVisible()
  expect(prompts).toHaveLength(1)
  await shot("03-streamed")
})

test("switcher: pick another account → cost dialog (≈118k context) → applied", async () => {
  const target = session("긴 문맥 세션")
  await page.getByTestId("session-list").getByText(target.title, { exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/srv/local/s/${target.id}$`))
  await expect(page.getByTestId("running-on")).toContainText("@ Alpha")
  await page.locator("#own-composer-input").focus()
  await page.keyboard.press("Control+Period")
  const switcher = page.getByTestId("switcher")
  await expect(switcher).toBeVisible()
  await switcher.getByTestId("switcher-account").filter({ hasText: "Bravo" }).click()
  await expect(switcher.getByTestId("switcher-estimate")).toContainText("@ Bravo")
  await expect(switcher.getByTestId("switcher-cost")).toContainText(/\d/)
  await shot("04-switcher")
  await switcher.getByTestId("switcher-apply").click()
  const dialog = page.getByTestId("switch-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("switch-option-now")).toBeVisible()
  await shot("05-cost-dialog")
  await dialog.getByTestId("switch-option-now").click()
  await dialog.getByTestId("switch-dialog-confirm").click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("running-on")).toContainText("@ Bravo")
  await expect(page.getByTestId("transcript").getByTestId("switch-marker").last()).toContainText("Bravo")
  await shot("06-switched")
})

test("manual compaction from the context meter completes and draws the compaction marker", async () => {
  // Still on "긴 문맥 세션" (now on Bravo). The dev fake answers the summary prompt with the core template.
  await page.getByTestId("context-meter").click()
  await expect(page.getByTestId("context-meter-popover")).toBeVisible()
  await page.getByTestId("compact-now").click()
  const marker = page.getByTestId("transcript").getByTestId("compaction-marker").last()
  await expect(marker).toBeVisible({ timeout: 60_000 })
  await expect(marker.getByTestId("compaction-sizes")).toContainText("→")
  await shot("06b-compaction-marker")
})

test("계정·한도 tab: the Codex account shows the fake 5 h / 7 d windows", async () => {
  const tab = page.getByTestId("tab-accounts")
  await expect(tab).toBeVisible()
  const codex = tab.locator(`[data-testid=account-row][data-account-id="${state.accounts.device.id}"]`)
  // Remaining by default, folded (설정 > 일반 > 한도 표시): the two tightest windows on one line, every one on hover.
  const line = codex.getByTestId("limit-summary-line")
  await expect(line).toBeVisible()
  await expect(line).toContainText("5시간 남음 58%")
  await expect(line).toContainText("주간 남음 82%")
  await expect(line).toHaveAttribute("title", /주간 남음 82%/)
  await shot("07-limits-tab")
  await page.getByTestId("link-limits").click()
  await expect(page.getByTestId("page-limits")).toBeVisible()
  await expect(page.getByTestId("page-limits")).toContainText("개인 Pro")
  await shot("08-limits-dashboard")
})

test("accounts: add an OpenAI API key (fake) through the connection test, then 이 계정으로 새 세션", async () => {
  await page.goto("/accounts")
  await page.getByTestId("open-add-account").click()
  const dialog = page.getByTestId("add-account-dialog")
  await dialog.getByText("OpenAI API 키", { exact: true }).click()
  await dialog.getByTestId("key-label").fill("Charlie")
  await dialog.getByTestId("key-secret").fill("sk-proj-ownWebIntegrationCharlieFake0000003")
  await dialog.getByTestId("key-submit").click()
  await expect(dialog).toContainText("확인됨")
  await expect(dialog).toContainText("계정이 추가되었어요")
  await shot("09-add-key-done")
  await dialog.getByRole("button", { name: "이 계정으로 새 대화" }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Charlie")
  await expect(page.locator("#own-composer-input")).toBeFocused()
  await shot("10-new-session-with-charlie")
})

test("Codex import: the fake old-app profile is linked, not copied", async () => {
  await page.goto("/accounts")
  await page.getByTestId("open-codex-import").click()
  const dialog = page.locator("dialog[open]")
  await expect(dialog.getByTestId("codex-list")).toBeVisible()
  for (const profile of state.legacy) await expect(dialog.getByText(profile.alias, { exact: true })).toBeVisible()
  await shot("11-codex-import-list")
  await dialog.getByTestId("codex-row-check").first().check()
  await dialog.getByTestId("codex-next").click()
  await expect(dialog.getByTestId("codex-confirm")).toBeVisible()
  await expect(dialog.getByTestId("codex-label")).toHaveValue(state.legacy[0]!.alias)
  await dialog.getByTestId("codex-execute").click()
  await expect(dialog).toContainText("연결했어요")
  await dialog.getByRole("button", { name: "닫기" }).last().click()
  const card = page.getByTestId("account-card").filter({ hasText: state.legacy[0]!.alias })
  await expect(card).toContainText("연결")
  await expect(card).toContainText("읽기 전용")
  await shot("12-codex-linked")
})

test("auto-compaction settings are two clicks from a session (context meter) and from anywhere (settings)", async () => {
  await page.goto(`/srv/local/s/${session("계정 라우터 RPC 설계").id}`)
  await page.getByTestId("context-meter").click() // 1
  await expect(page.getByTestId("context-meter-popover")).toBeVisible()
  await page.getByRole("button", { name: "자동 압축 설정 열기" }).click() // 2
  await expect(page).toHaveURL(/\/settings\/compaction$/)
  await expect(page.getByTestId("page-settings")).toContainText("자동 압축")
  await page.goto("/")
  await page.getByTestId("sidebar-settings").click() // 1
  await page.getByTestId("page-settings").getByRole("link", { name: "자동 압축" }).click() // 2
  await expect(page).toHaveURL(/\/settings\/compaction$/)
  await shot("13-compaction-settings")
})
