// The browser pane's address bar (03 §18.17, §18.15 rule 3, 05 §8.7) in Edge against the real server, with the
// harness's fake native pane (`?pane&empty`: registrations report no tabs; every command the pane sends is recorded and
// changes the fake inventory like main's). What the user can do in each state:
//   - a conversation with the browser tools and no tab: type an address (a new tab opens), a phrase (a search), never
//     on an IME Enter, and an address that does not open says so;
//   - no conversation: the read-only bar and how to get a browser;
//   - a conversation started without the browser tools: typing an address asks to turn them on and opens it after
//     "켜고 열기"; where they cannot be turned on, the read-only bar says why. The conversation's notice says the
//     same thing as the pane (it can be turned on here, the cache stays; or the plain reason).
// Screenshots go to $OWN_WEB_SPLIT_SHOTS.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

interface State {
  readonly folders: { readonly alpha: string }
  readonly accounts: { readonly alpha: { readonly providerID: string } }
  readonly sessions: { readonly alpha: string }
}

const state = (): State =>
  JSON.parse(fs.readFileSync(path.join(process.env.OWN_WEB_SPLIT_E2E_TMP!, "backend.json"), "utf8")) as State
const shots = process.env.OWN_WEB_SPLIT_SHOTS!
fs.mkdirSync(shots, { recursive: true })

const DENY = { action: "browser", resource: "*", effect: "deny" }
const search = (text: string) => `https://www.google.com/search?q=${encodeURIComponent(text)}`

type Recorded = { session: string; command: Record<string, unknown> }
const commands = (page: Page) =>
  page.evaluate(() => (window as unknown as { __splitHarness: { commands: Recorded[] } }).__splitHarness.commands)
const browserPane = (page: Page) => page.locator('[data-testid="pane"][data-view="browser"]:not([hidden])')
const row = (page: Page, title: string) => page.getByTestId("session-list").getByText(title, { exact: true })

async function open(page: Page) {
  await page.setViewportSize({ width: 1724, height: 960 })
  await page.goto("/e2e/split-view/harness.html?pane&empty")
  await expect(page.getByTestId("sidebar")).toContainText("알파 작업", { timeout: 60_000 })
}

async function showBrowser(page: Page) {
  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Shift+KeyB")
  await expect(browserPane(page)).toBeVisible()
}

async function openSession(page: Page, title: string) {
  await row(page, title).click()
  await expect(page.getByTestId("header-title")).toHaveText(title)
}

/** A session as a window without the browser pane creates it (rule 1's deny), optionally with an approval mode. */
async function webSession(request: APIRequestContext, title: string, mode?: "ask") {
  const created = await request.post("/api/session", {
    data: {
      title,
      model: { providerID: state().accounts.alpha.providerID, id: "gpt-5.5" },
      location: { directory: state().folders.alpha },
      permissions: [DENY],
    },
  })
  expect(created.ok()).toBe(true)
  const body = (await created.json()) as { id?: string; data?: { id: string } }
  const id = body.data?.id ?? body.id ?? ""
  if (mode) {
    const set = await request.post("/api/rpc/own.accounts/session.approval.set", {
      data: { input: { sessionID: id, mode } },
      params: { "location[directory]": state().folders.alpha },
    })
    expect(set.ok()).toBe(true)
  }
  return id
}

async function permissions(request: APIRequestContext, sessionID: string) {
  const response = await request.get(`/api/session/${sessionID}`)
  return ((await response.json()) as { data: { permissions?: unknown[] } }).data.permissions ?? []
}

/** Enter during a real Chromium composition (CDP), the order the Windows IME produces in Edge (03 §12). */
async function composeAndEnter(page: Page, selector: string, text: string) {
  const cdp = await page.context().newCDPSession(page)
  await page.locator(selector).focus()
  for (let end = 1; end <= text.length; end++)
    await cdp.send("Input.imeSetComposition", { text: text.slice(0, end), selectionStart: end, selectionEnd: end })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await cdp.detach()
}

test.describe.configure({ mode: "serial" })

test("no tab yet: an address opens a new tab, a phrase searches, an IME Enter waits, a refused address says so", async ({
  page,
}) => {
  await open(page)
  await openSession(page, "알파 작업")
  await showBrowser(page)
  const pane = browserPane(page)
  const address = pane.getByTestId("browser-address")
  await expect(pane.getByTestId("browser-empty")).toContainText("위 주소 칸에 주소나 검색어를 넣으면 새 탭으로 열려요.")
  await expect(address).toHaveAttribute("placeholder", "주소나 검색어 입력")
  await expect(address).toBeEditable()
  await page.screenshot({ path: path.join(shots, "address-empty.png") })

  const alpha = state().sessions.alpha
  await address.fill("localhost:5173/x")
  await address.press("Enter")
  await expect
    .poll(() => commands(page))
    .toEqual([{ session: alpha, command: { type: "tabs.open", url: "http://localhost:5173/x", focus: true } }])
  await expect(pane.locator(".own-browser-tab")).toHaveCount(1)
  await expect(pane.getByTestId("browser-empty")).toHaveCount(0)
  await expect(address).toHaveValue("http://localhost:5173/x")

  // Enter that commits a Korean composition is not a submit; the next Enter is.
  await address.fill("")
  await composeAndEnter(
    page,
    '[data-testid="pane"][data-view="browser"] [data-testid="browser-address"]',
    "리액트 문서",
  )
  await expect(address).toHaveValue("리액트 문서")
  expect(await commands(page)).toHaveLength(1)
  await address.press("Enter")
  const tabID = `tab-${alpha}-1`
  await expect
    .poll(async () => (await commands(page)).at(-1))
    .toEqual({ session: alpha, command: { type: "navigate", tabID, url: search("리액트 문서") } })
  await expect(address).toHaveValue(search("리액트 문서"))

  // An address the pane does not open: a note, no command, gone once the text changes.
  await address.fill("file:///C:/Windows")
  await address.press("Enter")
  await expect(pane.getByTestId("browser-address-refused")).toHaveText(
    "이 주소는 열 수 없어요. http·https 주소나 검색어를 넣어 주세요.",
  )
  expect(await commands(page)).toHaveLength(2)
  await page.screenshot({ path: path.join(shots, "address-refused.png") })
  await address.fill("example.com")
  await expect(pane.getByTestId("browser-address-refused")).toHaveCount(0)
  await address.press("Enter")
  await expect
    .poll(async () => (await commands(page)).at(-1))
    .toEqual({ session: alpha, command: { type: "navigate", tabID, url: "https://example.com" } })
})

test("a page that did not load: the view's place says why and offers 새로 고침 (05 §8.6)", async ({ page }) => {
  await open(page)
  await openSession(page, "알파 작업")
  await showBrowser(page)
  const pane = browserPane(page)
  const address = pane.getByTestId("browser-address")
  await address.fill("localhost:5173/unreachable")
  await address.press("Enter")
  const failed = pane.getByTestId("browser-load-failed")
  await expect(failed).toContainText("페이지를 열 수 없어요")
  await expect(failed).toContainText(
    "localhost:5173에 연결하지 못했어요. 주소와 인터넷 연결을 확인한 뒤 새로 고침하세요.",
  )
  await expect(pane.getByTestId("browser-load-error")).toHaveText("502 Bad Gateway")
  // The native view is hidden while the reason shows: its layout is not visible.
  const alpha = state().sessions.alpha
  await expect
    .poll(() =>
      page.evaluate(
        (session) =>
          (window as unknown as { __splitHarness: { visible: () => { session: string }[] } }).__splitHarness
            .visible()
            .some((item) => item.session === session),
        alpha,
      ),
    )
    .toBe(false)
  await page.screenshot({ path: path.join(shots, "address-load-failed.png") })
  await pane.getByTestId("browser-load-retry").click()
  await expect
    .poll(async () => (await commands(page)).at(-1))
    .toEqual({ session: alpha, command: { type: "reload", tabID: `tab-${alpha}-1` } })
  // An address that loads: the reason goes and the view is shown again.
  await address.fill("example.com")
  await address.press("Enter")
  await expect(failed).toHaveCount(0)
})

test("no conversation: the read-only address bar says how to get a browser", async ({ page }) => {
  await open(page)
  await page.getByTestId("sidebar-new-session").first().click()
  await showBrowser(page)
  const pane = browserPane(page)
  await expect(pane.getByTestId("browser-no-session")).toContainText(
    "브라우저는 대화마다 따로 있어요. 대화를 열거나, 새 대화에서 첫 메시지를 보내면 여기서 주소를 넣을 수 있어요.",
  )
  const address = pane.getByTestId("browser-address")
  await expect(address).toHaveAttribute("placeholder", "대화를 열면 여기에 주소를 넣을 수 있어요")
  await expect(address).toHaveAttribute("readonly", "")
  await address.click()
  await page.keyboard.type("example.com")
  await page.keyboard.press("Enter")
  await expect(address).toHaveValue("")
  expect(await commands(page)).toEqual([])
  await page.screenshot({ path: path.join(shots, "address-no-session.png") })
})

test("started without the browser tools: an address asks to turn them on and opens after 켜고 열기", async ({
  page,
  request,
}) => {
  const title = `웹에서 만든 대화 ${Date.now()}`
  const sessionID = await webSession(request, title, "ask")
  await open(page)
  await openSession(page, title)
  await showBrowser(page)
  const pane = browserPane(page)
  const removed = pane.getByTestId("browser-removed")
  await expect(removed).toHaveAttribute("data-state", "offer")
  const address = pane.getByTestId("browser-address")
  await expect(address).toHaveAttribute("placeholder", "주소를 넣으면 먼저 브라우저 도구를 켤지 물어요")
  await expect(address).toBeEditable()
  // The conversation's notice says what the pane offers, not "make a new conversation".
  const notice = page.getByTestId("browser-tool-notice")
  await expect(notice).toHaveText(
    "ⓘ이 대화는 브라우저 도구 없이 시작했어요. 브라우저 칸의 ‘이 대화에서 켜기’로 여기서 켤 수 있어요. 대화 앞부분 캐시는 유지돼요.",
  )
  await page.screenshot({ path: path.join(shots, "address-removed-offer.png") })

  // Cancelling forgets the address: the plain switch afterwards opens nothing.
  await address.fill("example.com")
  await address.press("Enter")
  const confirm = pane.getByTestId("browser-enable-confirm")
  await expect(confirm.getByTestId("browser-enable-address")).toHaveText(
    "‘example.com’을 열려면 이 대화에서 브라우저 도구를 먼저 켜야 해요.",
  )
  await expect(confirm.getByTestId("browser-enable-apply")).toHaveText("켜고 열기")
  await page.screenshot({ path: path.join(shots, "address-removed-confirm.png") })
  await confirm.getByRole("button", { name: "취소" }).click()
  await expect(removed).toHaveAttribute("data-state", "offer")
  await pane.getByTestId("browser-enable").click()
  await expect(confirm.getByTestId("browser-enable-address")).toHaveCount(0)
  await expect(confirm.getByTestId("browser-enable-apply")).toHaveText("켜기")

  // Typed while the confirmation is open: it names the address now, and 켜고 열기 opens it once the tools are on.
  await address.fill("solid 문서")
  await address.press("Enter")
  await expect(confirm.getByTestId("browser-enable-address")).toHaveText(
    "‘solid 문서’를 열려면 이 대화에서 브라우저 도구를 먼저 켜야 해요.",
  )
  expect(await commands(page)).toEqual([])
  await confirm.getByTestId("browser-enable-apply").click()
  await expect(pane.getByTestId("browser-pane")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => commands(page))
    .toEqual([{ session: sessionID, command: { type: "tabs.open", url: search("solid 문서"), focus: true } }])
  await expect(pane.locator(".own-browser-tab")).toHaveCount(1)
  expect(await permissions(request, sessionID)).not.toContainEqual(DENY)
  // Turned on: the notice goes with the deny.
  await expect(notice).toHaveCount(0)
  await page.screenshot({ path: path.join(shots, "address-removed-opened.png") })
})

test("started without the browser tools and no switch here: the read-only bar says why", async ({ page, request }) => {
  // Only the creation deny, no approval bundle: the mode reads `custom`, so the router cannot switch it (enable.ts).
  const title = `규칙 직접 쓴 대화 ${Date.now()}`
  await webSession(request, title)
  await open(page)
  await openSession(page, title)
  await showBrowser(page)
  const pane = browserPane(page)
  await expect(pane.getByTestId("browser-removed")).toHaveAttribute("data-state", "new-session")
  // The plain reason, in the same words in the pane and in the conversation's notice.
  const reason = "승인 모드가 ‘사용자 지정’이라 이 대화에서는 켤 수 없어요. 필요하면 새 대화를 만드세요."
  await expect(pane.getByTestId("browser-enable-new")).toHaveText(reason)
  await expect(pane.getByTestId("browser-enable-new")).toHaveAttribute("data-reason", "custom")
  await expect(page.getByTestId("browser-tool-notice")).toHaveText(
    `ⓘ이 대화는 브라우저 도구 없이 시작했어요. ${reason}`,
  )
  const address = pane.getByTestId("browser-address")
  await expect(address).toHaveAttribute("placeholder", "브라우저 도구가 없어 주소를 열 수 없어요")
  await expect(address).toHaveAttribute("readonly", "")
  await page.screenshot({ path: path.join(shots, "address-removed-new-session.png") })
})
