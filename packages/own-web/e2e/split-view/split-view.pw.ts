// Split view (03 §4.1.1, 05 §7.2, §8.2) in Edge against the real server: the default `나란히` mode with the browser
// beside the chat, the `탭으로 보기` switch and its automatic fallback on narrow widths (1724, 1280, 375), several
// sessions in panes (2–4) with the URL, header and keys following the focused pane, and one native browser view per
// pane (the harness's fake pane draws where each view would be). Screenshots go to $OWN_WEB_SPLIT_SHOTS.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

interface State {
  readonly sessions: { readonly fix: string; readonly search: string; readonly alpha: string }
}

const state = (): State =>
  JSON.parse(fs.readFileSync(path.join(process.env.OWN_WEB_SPLIT_E2E_TMP!, "backend.json"), "utf8")) as State
const shots = process.env.OWN_WEB_SPLIT_SHOTS!
fs.mkdirSync(shots, { recursive: true })

const route = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __splitHarness: { router: { route(): Record<string, string> } } }
    ).__splitHarness.router.route(),
  )
const visibleViews = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __splitHarness: { visible(): { session: string; bounds: { x: number; y: number; width: number } }[] }
      }
    ).__splitHarness.visible(),
  )
const panes = (page: Page) => page.locator('[data-testid="pane"]:not([hidden])')
const pane = (page: Page, view: "chat" | "browser", index = 0) =>
  page.locator(`[data-testid="pane"][data-view="${view}"]:not([hidden])`).nth(index)
const row = (page: Page, title: string) => page.getByTestId("session-list").getByText(title, { exact: true })

async function open(page: Page, query = "", width = 1724) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 960 })
  await page.goto(`/e2e/split-view/harness.html${query}`)
  await expect(page.getByTestId("sidebar")).toContainText("알파 작업", { timeout: 60_000 })
}

/** Drags a session row from the sidebar onto a pane's edge (synthetic drag events with one DataTransfer). */
async function dropRow(page: Page, title: string, target: ReturnType<typeof pane>, edge: "right" | "bottom") {
  const box = (await target.boundingBox())!
  const point =
    edge === "right"
      ? { clientX: box.x + box.width - 20, clientY: box.y + box.height / 2 }
      : { clientX: box.x + box.width / 2, clientY: box.y + box.height - 20 }
  const data = await page.evaluateHandle(() => new DataTransfer())
  await row(page, title).dispatchEvent("dragstart", { dataTransfer: data })
  await page.getByTestId("panes").dispatchEvent("dragover", { dataTransfer: data, ...point })
  await expect(page.getByTestId("pane-drop")).toHaveAttribute("data-edge", edge)
  await page.getByTestId("panes").dispatchEvent("drop", { dataTransfer: data, ...point })
}

async function openSession(page: Page, title: string) {
  await row(page, title).click()
  await expect(page.getByTestId("header-title")).toHaveText(title)
}

test.describe.configure({ mode: "serial" })

test("나란히 by default: Ctrl+Shift+B opens the browser beside the chat, both on screen; tabs mode switches per window", async ({
  page,
}) => {
  await open(page, "?pane")
  await openSession(page, "알파 작업")
  const app = page.getByTestId("app")
  await expect(app).toHaveAttribute("data-tier", "wide")
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")
  // 브라우저 is a toggle button in 나란히, not a tab; no pane bar while the chat is alone.
  await expect(page.getByRole("tab", { name: /브라우저/ })).toHaveCount(0)
  await expect(page.getByTestId("workspace-browser-toggle")).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByTestId("pane-bar")).toHaveCount(0)

  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Shift+KeyB")
  await expect(pane(page, "browser")).toBeVisible()
  await expect(page.getByTestId("workspace-browser-toggle")).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("pane-bar")).toHaveCount(2)
  // The chat stays usable beside it, and the native view sits right of the chat pane.
  await expect(page.locator("#own-composer-input")).toBeVisible()
  await expect
    .poll(async () => (await visibleViews(page)).map((view) => view.session))
    .toEqual([state().sessions.alpha])
  const chatBox = (await pane(page, "chat").boundingBox())!
  const view = (await visibleViews(page))[0]!
  expect(view.bounds.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 2)
  await page.screenshot({ path: path.join(shots, "after-1724-chat-browser.png") })

  // The URL follows the chat pane even when the browser pane is focused.
  await pane(page, "browser").getByTestId("pane-bar").click()
  expect(await route(page)).toMatchObject({ name: "session", sessionID: state().sessions.alpha })

  // 탭으로 보기 (this window): one pane with 채팅 | 브라우저 tabs; the browser view hides under 채팅.
  await page.getByTestId("workspace-mode").click()
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "tabs")
  await expect(page.getByRole("tab", { name: /브라우저/ })).toBeVisible()
  await expect.poll(() => visibleViews(page)).toEqual([])
  await page.getByRole("tab", { name: /브라우저/ }).click()
  await expect.poll(async () => (await visibleViews(page)).length).toBe(1)
  await page.getByRole("tab", { name: "대화", exact: true }).click()
  // Reload: the window keeps its own mode and tree.
  await page.reload()
  await expect(page.getByTestId("sidebar")).toContainText("알파 작업", { timeout: 60_000 })
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "tabs")
  await page.getByTestId("workspace-mode").click()
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")
  await expect(pane(page, "browser")).toBeVisible()
  // Ctrl+Shift+B again closes it.
  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Shift+KeyB")
  await expect(panes(page)).toHaveCount(1)
})

test("settings > 레이아웃 > 워크스페이스 보기 sets the device default", async ({ page }) => {
  await open(page)
  await openSession(page, "알파 작업")
  await page.goto("/e2e/split-view/harness.html")
  await page.getByTestId("sidebar-settings").click()
  await page.getByRole("link", { name: "화면 배치" }).click()
  const view = page.getByTestId("settings-workspace-view")
  await expect(view).toBeVisible()
  await view.getByText("탭으로 보기").click()
  expect(await page.evaluate(() => localStorage.getItem("own.web.panes.default"))).toBe("tabs")
  await page.screenshot({ path: path.join(shots, "after-settings-layout.png") })
  await view.getByText("나란히 (기본)").click()
  expect(await page.evaluate(() => localStorage.getItem("own.web.panes.default"))).toBe("split")
})

test("fallback thresholds: 1280 splits until the work panel leaves too little room; 375 has no split UI", async ({
  page,
}) => {
  await open(page, "?pane", 1280)
  await openSession(page, "알파 작업")
  await expect(page.getByTestId("app")).toHaveAttribute("data-tier", "desk")
  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Shift+KeyB")
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")
  const width = await page.getByTestId("panes").evaluate((element) => element.clientWidth)
  expect(width).toBeGreaterThanOrEqual(780)
  await page.screenshot({ path: path.join(shots, "after-1280-chat-browser.png") })
  // The pushed work panel takes 380 px: chat 420 + browser 360 no longer fit, so tabs show (saved mode unchanged).
  if ((await page.getByTestId("app").getAttribute("data-panel")) !== "open")
    await page.keyboard.press("Control+Alt+KeyB")
  await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "open")
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "tabs")
  await expect(page.getByTestId("workspace-fallback")).toHaveText("창이 좁아 탭으로 보여요")
  await expect(page.getByRole("tab", { name: /브라우저/ })).toBeVisible()
  await page.screenshot({ path: path.join(shots, "after-1280-fallback.png") })
  await page.keyboard.press("Control+Alt+KeyB")
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")

  // Phone width: the focused pane with tabs, no split buttons, the split keys do nothing.
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByTestId("app")).toHaveAttribute("data-tier", "phone")
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "tabs")
  await expect(page.getByTestId("workspace-mode")).toHaveCount(0)
  await expect(page.getByTestId("workspace-split")).toHaveCount(0)
  await expect(page.getByTestId("workspace-fallback")).toHaveCount(0)
  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Alt+Backslash")
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(1)
  await page.screenshot({ path: path.join(shots, "after-375-tabs.png") })
})

test("several sessions in panes (1724): Ctrl+click, keys, URL and header follow the focused pane, 4 at most", async ({
  page,
}) => {
  await open(page)
  await openSession(page, "알파 작업")
  // Ctrl+click on a row: the session opens beside the focused pane and takes the focus.
  await row(page, "세션 검색 테스트").click({ modifiers: ["Control"] })
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(2)
  await expect(page.getByTestId("header-title")).toHaveText("세션 검색 테스트")
  expect(await route(page)).toMatchObject({ sessionID: state().sessions.search })
  // One #own-composer-input (the focused pane's); each pane keeps its own draft.
  await expect(page.locator("#own-composer-input")).toHaveCount(1)
  await page.locator("#own-composer-input").fill("둘째 분할 초안")
  await pane(page, "chat", 0).locator("textarea").click()
  await expect(page.getByTestId("header-title")).toHaveText("알파 작업")
  expect(await route(page)).toMatchObject({ sessionID: state().sessions.alpha })
  await page.locator("#own-composer-input").fill("첫째 분할 초안")
  await expect(pane(page, "chat", 1).locator("textarea")).toHaveValue("둘째 분할 초안")
  // Ctrl+Alt+2 focuses pane 2 (and its composer).
  await page.keyboard.press("Control+Alt+Digit2")
  await expect(page.getByTestId("header-title")).toHaveText("세션 검색 테스트")
  await expect(page.locator("#own-composer-input")).toBeFocused()
  await expect(page.getByTestId("pane-announcement")).toContainText("분할 2")
  // A sidebar click opens in the focused pane; a session already in a pane only focuses it.
  await row(page, "터미널 고치기").click()
  await expect(pane(page, "chat", 1).getByTestId("pane-title")).toHaveText("터미널 고치기")
  await row(page, "알파 작업").click()
  await expect(page.locator("[data-pane-focused]")).toHaveAttribute("data-pane-id", "p1")
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(2)
  await page.screenshot({ path: path.join(shots, "after-1724-two-sessions.png") })

  // Ctrl+Alt+Shift+\ splits down: a new conversation (the project's new-session screen) below pane 1.
  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Alt+Shift+Backslash")
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(3)
  expect((await route(page)).name).not.toBe("session")
  await expect(page.locator("#own-composer-input")).toBeFocused()
  // Pane 2 (top right, reading order) split down too: a 2 × 2 grid, the limit.
  await page.keyboard.press("Control+Alt+Digit2")
  await expect(page.getByTestId("header-title")).toHaveText("터미널 고치기")
  await page.keyboard.press("Control+Alt+Shift+Backslash")
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(4)
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")
  await page.screenshot({ path: path.join(shots, "after-1724-four-panes.png") })
  await page.keyboard.press("Control+Alt+Backslash")
  await expect(page.getByText("분할은 4개까지예요")).toBeVisible()
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(4)

  // Dividers: a separator per split, arrow keys move it 20 px.
  const divider = page.locator('[data-testid="pane-divider"][data-dir="row"]').first()
  const before = Number(await divider.getAttribute("aria-valuenow"))
  await divider.focus()
  await page.keyboard.press("ArrowRight")
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(before)

  // F6 goes from the sidebar through the panes; Ctrl+Alt+W closes the focused pane.
  await page.keyboard.press("Control+Alt+Digit1")
  await page.keyboard.press("F6")
  await expect(page.locator(":focus")).toHaveAttribute("id", "own-composer-input")
  await expect(page.locator("[data-pane-focused]")).not.toHaveAttribute("data-pane-id", "p1")
  await page.keyboard.press("Control+Alt+KeyW")
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(3)

  // The tree survives a reload (per window, on this device).
  await page.reload()
  await expect(page.getByTestId("sidebar")).toContainText("알파 작업", { timeout: 60_000 })
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(3)

  // Tabs mode: the focused pane alone; the others stay mounted (drafts kept) and come back with 나란히.
  await page.getByTestId("workspace-mode").click()
  await expect(panes(page)).toHaveCount(1)
  await page.getByTestId("workspace-mode").click()
  await expect(page.locator('[data-testid="pane"][data-view="chat"]:not([hidden])')).toHaveCount(3)
})

test("a session row dropped on a pane edge opens beside it; the row menu has 분할해서 열기", async ({ page }) => {
  await open(page)
  await openSession(page, "알파 작업")
  await dropRow(page, "세션 검색 테스트", pane(page, "chat", 0), "right")
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(2)
  await expect(pane(page, "chat", 1).getByTestId("pane-title")).toHaveText("세션 검색 테스트")
  // Row menu.
  await row(page, "터미널 고치기").click({ button: "right" })
  await page.getByTestId("row-open-beside").click()
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(3)
  // Three in a row need 1,260 px: without the work panel they fit.
  if ((await page.getByTestId("app").getAttribute("data-panel")) === "open")
    await page.keyboard.press("Control+Alt+KeyB")
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")

  // Pane 3's bar dragged onto pane 1's bottom edge: it moves below pane 1 (the pane order follows reading order).
  const first = (await pane(page, "chat", 0).boundingBox())!
  const point = { clientX: first.x + first.width / 2, clientY: first.y + first.height - 20 }
  const data = await page.evaluateHandle(() => new DataTransfer())
  await pane(page, "chat", 2).getByTestId("pane-bar").dispatchEvent("dragstart", { dataTransfer: data })
  await page.getByTestId("panes").dispatchEvent("dragover", { dataTransfer: data, ...point })
  await expect(page.getByTestId("pane-drop")).toHaveAttribute("data-edge", "bottom")
  await page.getByTestId("panes").dispatchEvent("drop", { dataTransfer: data, ...point })
  const moved = page.locator('[data-pane-id="p3"]')
  await expect.poll(async () => (await moved.boundingBox())!.y).toBeGreaterThan(first.y + first.height / 3)
  await expect(page.getByTestId("header-title")).toHaveText("터미널 고치기")
  await page.screenshot({ path: path.join(shots, "after-1724-moved-pane.png") })
})

test("browser per pane: two sessions show their views at once; one view per session; a click in a view focuses its pane", async ({
  page,
}) => {
  await open(page, "?pane")
  await openSession(page, "알파 작업")
  // Close the work panel for room: two chat + browser pairs stacked need 780 px.
  if ((await page.getByTestId("app").getAttribute("data-panel")) === "open")
    await page.keyboard.press("Control+Alt+KeyB")
  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Shift+KeyB")
  await expect(pane(page, "browser")).toBeVisible()
  // A row dropped below the chat pane: the chat + browser pair moves together, the new chat pane gets its own browser.
  await dropRow(page, "세션 검색 테스트", pane(page, "chat"), "bottom")
  await expect(page.locator('[data-testid="pane"][data-view="chat"]')).toHaveCount(2)
  await expect(page.getByTestId("panes")).toHaveAttribute("data-mode", "split")
  await page.locator("#own-composer-input").click()
  await page.keyboard.press("Control+Shift+KeyB")
  await expect(page.locator('[data-testid="pane"][data-view="browser"]')).toHaveCount(2)
  await expect
    .poll(async () => (await visibleViews(page)).map((view) => view.session).sort())
    .toEqual([state().sessions.alpha, state().sessions.search].sort())
  await page.screenshot({ path: path.join(shots, "after-1724-two-browsers.png") })

  // A click inside pane 1's native view (the DOM never sees it): the host reports it, pane 1's chat takes the URL.
  await page.evaluate(
    (session) =>
      (window as unknown as { __splitHarness: { focusView(id: string): void } }).__splitHarness.focusView(session),
    state().sessions.alpha,
  )
  await expect(page.getByTestId("header-title")).toHaveText("알파 작업")

  // Pin pane 2's browser to its session, then show that session in pane 1: one view per session.
  await pane(page, "browser", 1).getByTestId("pane-menu-button").click()
  await page.getByTestId("pane-menu").getByTestId("pane-pin").click()
  await pane(page, "chat", 1).locator("textarea").click()
  await row(page, "터미널 고치기").click()
  await pane(page, "chat", 0).locator("textarea").click()
  await row(page, "세션 검색 테스트").click()
  await expect(page.getByTestId("pane-browser-elsewhere")).toHaveCount(1)
  await expect
    .poll(async () => (await visibleViews(page)).filter((view) => view.session === state().sessions.search).length)
    .toBe(1)
  await page.getByTestId("pane-browser-elsewhere").getByRole("button", { name: "여기로 옮기기" }).click()
  await expect(page.getByTestId("pane-browser-elsewhere")).toHaveCount(1)
  await expect
    .poll(async () => (await visibleViews(page)).filter((view) => view.session === state().sessions.search).length)
    .toBe(1)
})
