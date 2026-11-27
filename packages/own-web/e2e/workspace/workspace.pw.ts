// Workspace suite: project open (03 §18.3, 01 §17.1 #3), MCP management and the OAuth exception (03 §18.14, §16.3,
// 01 §17.1 #14) and the web-mode browser tool policy (01 §10.1, 05 §8.7 plan D) against the real server
// (e2e/workspace/backend.ts). Serial: MCP sign-in changes server state the later tests see.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page, type Request } from "@playwright/test"

interface WorkspaceState {
  readonly dev: string
  readonly control: string
  readonly projects: string
  readonly folders: { readonly alpha: string; readonly hash: string; readonly many: string; readonly empty: string }
  readonly mcp: string
  readonly model: { readonly providerID: string; readonly id: string }
  readonly sessions: { readonly alpha: string; readonly hash: string }
}

const MCP_ID = /^mcp_[0-9a-f]{16}$/

function backend(): WorkspaceState {
  const tmp = process.env.OWN_WEB_WORKSPACE_E2E_TMP!
  return JSON.parse(fs.readFileSync(path.join(tmp, "own-web-workspace-e2e", "backend.json"), "utf8")) as WorkspaceState
}

function harness(query: Record<string, string> = {}) {
  const state = backend()
  const params = new URLSearchParams({ model: `${state.model.providerID}/${state.model.id}`, ...query })
  return `/e2e/workspace/harness.html?${params}`
}

function watch(page: Page, match: (url: URL) => boolean) {
  const seen: Request[] = []
  page.on("request", (request) => {
    if (match(new URL(request.url()))) seen.push(request)
  })
  return seen
}

const at = (directory: string) => ({ "location[directory]": directory })

/** A listing of the folder picker: own.accounts `folderPicker.list` since 2.2.6-own.16, core `fs.list` before. */
const isListing = (url: URL) =>
  url.pathname === "/api/fs/list" || url.pathname === "/api/rpc/own.accounts/folderPicker.list"

/** The folder a listing asked for: the query's `path` (core) or the RPC body's `input.path` (own.accounts). */
function listedPath(request: Request) {
  const url = new URL(request.url())
  if (url.pathname === "/api/fs/list") return url.searchParams.get("path") ?? ""
  return (request.postDataJSON() as { input: { path: string } }).input.path
}

/** The harness's fake folder dialog (harness.tsx): how many it opened, and answering the held ones. */
type FakeDialog = { readonly picks: () => number; readonly answer: () => void }
const picks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __workspaceHarness: FakeDialog }).__workspaceHarness.picks())
const answer = (page: Page) =>
  page.evaluate(() => (window as unknown as { __workspaceHarness: FakeDialog }).__workspaceHarness.answer())

test.describe.configure({ mode: "serial" })

test("folder picker: control-location listing with absolute encoded paths, windowed list, confirm card → new session", async ({
  page,
}, testInfo) => {
  const state = backend()
  const browsing = watch(page, (url) => isListing(url) || url.pathname === "/api/location")
  await page.goto(harness())
  await page.getByTestId("open-folder").click()
  const picker = page.getByTestId("project-picker")
  const input = picker.getByTestId("project-path")
  // Starts in the parent of the newest project, the folder that holds the projects.
  await expect(input).toHaveValue(state.projects)
  for (const name of ["#1 한글 프로젝트 100%", "alpha app", "empty", "many"])
    await expect(picker.locator(`[data-testid=project-entry][data-name="${name}"]`)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("picker.png") })

  // 500 subfolders: only the visible rows are in the DOM (R2), the last one is reachable by scrolling.
  await picker.locator('[data-testid=project-entry][data-name="many"]').click()
  await expect(picker.getByTestId("project-status")).toHaveText("폴더 500개")
  expect(await picker.getByTestId("project-entry").count()).toBeLessThan(40)
  await picker.getByTestId("project-list").evaluate((element) => (element.scrollTop = element.scrollHeight))
  await expect(picker.locator('[data-testid=project-entry][data-name="d0500"]')).toBeVisible()

  // Typing under the current folder filters and highlights the first match; ↓ moves; Enter opens; Alt+↑ goes up.
  await input.click()
  await input.press("End")
  await input.pressSequentially("\\d049")
  await expect(picker.getByTestId("project-status")).toHaveText("폴더 10개")
  await expect(picker.locator("[role=option][aria-selected=true]")).toHaveAttribute("data-name", "d0490")
  await input.press("ArrowDown")
  await expect(picker.locator("[role=option][aria-selected=true]")).toHaveAttribute("data-name", "d0491")
  await input.press("Enter")
  await expect(input).toHaveValue(path.join(state.folders.many, "d0491"))
  await expect(picker.getByTestId("project-status")).toHaveText("하위 폴더가 없어요")
  await input.press("Alt+ArrowUp")
  await expect(input).toHaveValue(state.folders.many)

  // A pasted path with Explorer's quotes; `#`, `%`, spaces and Hangul.
  await input.fill(`"${state.folders.hash}"`)
  await input.press("Enter")
  await expect(input).toHaveValue(state.folders.hash)
  await expect(picker.getByTestId("project-crumbs")).toContainText("#1 한글 프로젝트 100%")
  await picker.getByTestId("project-choose").click()
  const confirm = picker.getByTestId("project-confirm")
  await expect(confirm.getByTestId("project-confirm-path")).toHaveText(state.folders.hash)
  await expect(confirm.getByTestId("project-confirm-git")).toHaveText(/Git 저장소가 아니에요/)
  await page.screenshot({ path: testInfo.outputPath("picker-confirm.png") })
  await confirm.getByTestId("project-start").click()
  await expect(picker).toBeHidden()
  await expect(page.getByTestId("route")).toHaveText(/^\/srv\/local\/p\/[^/#]+$/)
  await expect(page.getByTestId("target")).toHaveText(state.folders.hash)

  const lists = browsing.filter((request) => isListing(new URL(request.url())))
  expect(lists.length).toBeGreaterThanOrEqual(5)
  for (const request of lists) {
    const url = new URL(request.url())
    // Browsing never uses the browsed folder as a location (01 G15), and paths are absolute query parameters.
    expect(url.searchParams.get("location[directory]")).toBe(state.control)
    expect(path.win32.isAbsolute(listedPath(request))).toBe(true)
    expect(request.url()).not.toContain("#")
  }
  expect(lists.some((request) => listedPath(request) === state.folders.hash)).toBe(true)
  // Only the chosen folder became a Location.
  const located = browsing
    .filter((request) => new URL(request.url()).pathname === "/api/location")
    .map((request) => new URL(request.url()).searchParams.get("location[directory]"))
  expect(located.filter((directory) => directory?.startsWith(state.projects))).toEqual([state.folders.hash])
})

test("folder picker: Ctrl+O, recent folders with Git state, drive roots refused before any Location, Esc", async ({
  page,
}) => {
  const state = backend()
  const locations = watch(page, (url) => url.pathname === "/api/location")
  await page.goto(harness())
  await page.getByTestId("go-home").focus()
  await page.keyboard.press("Control+KeyO")
  const picker = page.getByTestId("project-picker")
  await expect(picker).toBeVisible()
  await picker.locator("[data-testid=project-recent]", { hasText: "alpha app" }).click()
  await expect(picker.getByTestId("project-confirm-git")).toHaveText("Git 저장소 · main")
  await picker.getByTestId("project-back").click()
  await expect(picker.getByTestId("project-path")).toBeFocused()

  const root = path.win32.parse(state.projects).root
  await picker.getByTestId("project-path").fill(root)
  await picker.getByTestId("project-path").press("Enter")
  await expect(picker.getByTestId("project-path")).toHaveValue(root)
  await picker.getByTestId("project-choose").click()
  await expect(picker.getByTestId("project-too-broad")).toContainText("드라이브 전체")
  await expect(picker.getByTestId("project-start")).toBeDisabled()
  expect(locations.map((request) => new URL(request.url()).searchParams.get("location[directory]"))).not.toContain(root)

  await page.keyboard.press("Escape")
  await expect(picker).toBeHidden()
  await expect(page.getByTestId("go-home")).toBeFocused()
})

test("folder picker path box follows the IME rules: Enter during a Hangul composition opens the match once (03 §12)", async ({
  page,
}) => {
  const state = backend()
  const lists = watch(page, isListing)
  await page.goto(harness())
  await page.getByTestId("open-folder").click()
  const picker = page.getByTestId("project-picker")
  const input = picker.getByTestId("project-path")
  await expect(input).toHaveValue(state.projects)
  await input.click()
  await input.press("End")
  await input.pressSequentially("\\#1 ")
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.imeSetComposition", { text: "하", selectionStart: 1, selectionEnd: 1 })
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 })
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text: "한" })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await expect(input).toHaveValue(state.folders.hash)
  await expect(picker.getByTestId("project-status")).toHaveText("하위 폴더가 없어요")
  const opened = lists.filter((request) => listedPath(request) === state.folders.hash)
  expect(opened).toHaveLength(1)
})

test("folder picker: a path typed before the first listing answers stays, and Enter opens it (03 §18.3)", async ({
  page,
}) => {
  const state = backend()
  // A slow service: the start folder's listing answers only after the path is typed.
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let first = true
  await page.route(isListing, async (route) => {
    if (!first) return route.continue()
    first = false
    await held
    await route.continue()
  })
  await page.goto(harness())
  await page.getByTestId("open-folder").click()
  const picker = page.getByTestId("project-picker")
  const input = picker.getByTestId("project-path")
  await expect.poll(() => first).toBe(false)
  await input.fill(state.folders.alpha)
  release()
  // The start folder is listed (its rows come with the answer), the typed path stays and narrows it.
  await expect(picker.locator('[data-testid=project-entry][data-name="alpha app"]')).toBeVisible()
  await expect(input).toHaveValue(state.folders.alpha)
  await expect(picker.locator("[role=option][aria-selected=true]")).toHaveAttribute("data-name", "alpha app")
  await input.press("Enter")
  await expect(picker.getByTestId("project-crumbs")).toContainText("alpha app")
  await picker.getByTestId("project-choose").click()
  await expect(picker.getByTestId("project-confirm-path")).toHaveText(state.folders.alpha)
  await page.keyboard.press("Escape")
})

test("phone width: picker and 설정 > MCP fit without horizontal scrolling (03 §4.2)", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await page.goto(harness())
  await page.getByTestId("open-folder").click()
  const picker = page.getByTestId("project-picker")
  await expect(picker.getByTestId("project-entry").first()).toBeVisible()
  const overflow = (selector: string) =>
    page.locator(selector).evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(await overflow("[data-testid=project-picker]")).toBeLessThanOrEqual(1)
  await page.keyboard.press("Escape")
  await page.getByTestId("go-mcp").click()
  await expect(page.getByTestId("mcp-row").first()).toBeVisible()
  expect(await overflow("[data-testid=settings-mcp]")).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test("desktop: the native folder dialog goes straight to the new-session screen; a drive root gets the card", async ({
  page,
}) => {
  const state = backend()
  await page.goto(harness({ native: state.folders.alpha }))
  await page.getByTestId("open-folder").click()
  await expect(page.getByTestId("target")).toHaveText(state.folders.alpha)
  await expect(page.getByTestId("route")).toHaveText(/^\/srv\/local\/p\/[^/]+$/)
  await expect(page.getByTestId("project-picker")).toHaveCount(0)

  const root = path.win32.parse(state.projects).root
  await page.goto(harness({ native: root }))
  await page.getByTestId("open-folder").click()
  await expect(page.getByTestId("project-too-broad")).toBeVisible()
  await expect(page.getByTestId("project-start")).toBeDisabled()
})

test("desktop: 폴더 열기 is one flow per window — pending from the press on, repeats start nothing, cancel resets", async ({
  page,
}) => {
  const state = backend()
  const locations = watch(page, (url) => url.pathname === "/api/location")
  // Windows' folder dialog takes seconds to appear; the harness dialog stays open until the test answers it.
  await page.goto(harness({ native: state.folders.empty, nativeDelay: "hold" }))
  const button = page.getByTestId("sidebar-open-folder")
  await expect(button).toHaveText(/폴더 열기/)
  await button.click()
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute("aria-busy", "true")
  await expect(button).toContainText("여는 중…")
  await expect(page.getByTestId("sidebar-open-folder-spinner")).toBeVisible()
  // Key repeat of Ctrl+O and the other entry points while the dialog is still coming up.
  for (let index = 0; index < 5; index++) await page.keyboard.press("Control+o")
  await page.getByTestId("open-folder").click()
  expect(await picks(page)).toBe(1)
  await answer(page)
  await expect(page.getByTestId("target")).toHaveText(state.folders.empty)
  await expect(page.getByTestId("route")).toHaveText(/^\/srv\/local\/p\/[^/]+$/)
  await expect(button).toBeEnabled()
  await expect(button).toContainText("폴더 열기")
  await expect(page.getByTestId("sidebar-open-folder-spinner")).toHaveCount(0)
  expect(await picks(page)).toBe(1)
  expect(
    locations.filter(
      (request) => new URL(request.url()).searchParams.get("location[directory]") === state.folders.empty,
    ),
  ).toHaveLength(1)

  // Cancelled dialog: the button comes back and nothing opens.
  await page.goto(harness({ native: "", nativeDelay: "hold" }))
  await button.click()
  await expect(button).toBeDisabled()
  // The opener calls pickDirectory before its first await (src/projects/opener.ts), so once the button is disabled
  // the dialog is held and answer() reaches it; no poll is needed.
  await answer(page)
  await expect(button).toBeEnabled()
  await expect(button).toContainText("폴더 열기")
  await expect(page.getByTestId("project-picker")).toHaveCount(0)
})

test("new-session project selector: recent projects, switching the folder, 폴더 열기…", async ({ page }) => {
  const state = backend()
  await page.goto(harness())
  const select = page.getByTestId("project-select")
  await expect(select).toContainText("#1 한글 프로젝트 100%")
  await select.click()
  const menu = page.getByTestId("project-select-menu")
  await expect(menu.getByTestId("project-select-item")).toHaveCount(2)
  await expect(menu.getByTestId("project-select-item").first()).toHaveAttribute("aria-checked", "true")
  await menu.getByTestId("project-select-item").filter({ hasText: "alpha app" }).click()
  await expect(page.getByTestId("new-directory")).toHaveText(state.folders.alpha)
  await expect(page.getByTestId("route")).toHaveText(/^\/srv\/local\/p\/[^/]+$/)
  await select.click()
  await menu.getByTestId("project-select-open").click()
  await expect(page.getByTestId("project-picker")).toBeVisible()
})

test("설정 > MCP: status, on/off, folded errors, cache notes per server kind", async ({ page, request }, testInfo) => {
  const state = backend()
  await page.goto(harness())
  await page.getByTestId("go-mcp").click()
  const settings = page.getByTestId("settings-mcp")
  // The options are numbered (no path in the DOM's attributes): the chosen one names the folder.
  await expect(settings.getByTestId("mcp-project").locator("option:checked")).toContainText(state.folders.hash)
  const row = (name: string) => settings.locator(`[data-testid=mcp-row][data-name="${name}"]`)
  await expect(settings.getByTestId("mcp-row")).toHaveCount(5)
  await expect(row("docs")).toHaveAttribute("data-status", "connected")
  await expect(row("direct")).toHaveAttribute("data-status", "connected")
  await expect(row("secure")).toHaveAttribute("data-status", "needs_auth")
  await expect(row("broken")).toHaveAttribute("data-status", "failed")
  await expect(row("off")).toHaveAttribute("data-status", "disabled")
  await expect(row("secure").getByTestId("mcp-login")).toBeVisible()
  await expect(row("off").getByTestId("mcp-toggle")).toHaveAttribute("aria-checked", "false")
  await expect(row("direct").getByTestId("mcp-direct")).toBeVisible()
  await expect(row("direct")).toContainText("모든 대화의 캐시를 처음부터 다시 써요")
  await expect(row("docs").getByTestId("mcp-direct")).toHaveCount(0)
  await expect(settings).toContainText("다음 요청에 도구 카탈로그 갱신이 한 번 붙어요")
  await row("broken").getByTestId("mcp-error").locator("summary").click()
  await expect(row("broken").getByTestId("mcp-error").locator("pre")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("settings-mcp.png"), fullPage: true })

  // Off and on again: the switch goes through mcp.disconnect / mcp.connect at this Location.
  await row("docs").getByTestId("mcp-toggle").click()
  await expect(row("docs")).toHaveAttribute("data-status", "disabled")
  await expect(row("docs").getByTestId("mcp-toggle")).toHaveAttribute("aria-checked", "false")
  // Rows are updated in place: the switch keeps keyboard focus across the refresh.
  await expect(row("docs").getByTestId("mcp-toggle")).toBeFocused()
  const listed = await request.get(`${state.dev}/api/mcp`, { params: at(state.folders.hash) })
  const docs = ((await listed.json()) as { data: { name: string; status: { status: string } }[] }).data.find(
    (item) => item.name === "docs",
  )
  expect(docs?.status.status).toBe("disabled")
  await row("docs").getByTestId("mcp-toggle").click()
  await expect(row("docs")).toHaveAttribute("data-status", "connected")

  // Another project: its own Location's servers.
  const alpha = settings.getByTestId("mcp-project").locator("option").filter({ hasText: state.folders.alpha })
  await settings.getByTestId("mcp-project").selectOption((await alpha.first().getAttribute("value"))!)
  await expect(row("docs")).toHaveAttribute("data-status", "connected")
})

test("server panel and Ctrl+;: version, guard, browser rule, MCP summary", async ({ page }, testInfo) => {
  await page.goto(harness())
  await page.getByTestId("server-status").click()
  const panel = page.getByTestId("server-panel")
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId("server-panel-guard")).toHaveText("예")
  await expect(panel.getByTestId("server-panel-browser")).toHaveText("이 창에서 만드는 대화: 브라우저 도구 없음")
  await expect(panel.getByTestId("server-panel-mcp")).toContainText("MCP 5")
  await expect(panel.getByTestId("server-panel-mcp-auth")).toHaveText("로그인 필요 1")
  await expect(panel.getByTestId("server-panel-mcp")).toContainText("실패 1")
  await expect(panel.getByTestId("server-panel-restart")).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("server-panel.png") })
  const listed = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/mcp.list"))
  await panel.getByTestId("server-panel-mcp").click()
  const dialog = page.getByTestId("mcp-dialog")
  await listed
  await expect(dialog.getByTestId("mcp-row")).toHaveCount(5)
  // The rows' tags wait for `mcp.list` without suspending the dialog: it stays modal, so Esc closes it (merge round 7:
  // a tag that read the list before its answer took the open dialog out of the page and back, no longer modal).
  expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)

  await page.getByTestId("go-home").focus()
  await page.keyboard.press("Control+Semicolon")
  await expect(dialog).toBeVisible()
  await dialog.getByTestId("mcp-manage").click()
  await expect(page.getByTestId("route")).toHaveText("/settings/mcp")

  // 03 §8 "MCP 인증 필요": the banner of a session whose tool calls used `secure`, with 로그인… → the MCP list.
  await page.goto(harness({ session: backend().sessions.hash, mcp: "secure,docs" }))
  const banner = page.getByTestId("mcp-auth-banner")
  await expect(banner).toHaveCount(1)
  await expect(banner).toHaveText(/MCP 서버 "secure"에 로그인이 필요해요\./)
  await banner.getByRole("button").click()
  await expect(dialog.locator('[data-testid=mcp-row][data-name="secure"]')).toHaveAttribute("data-status", "needs_auth")
})

test("confirm card: unapproved project plugins are named before the first session (5.7.1, mocked plugin.trust.list)", async ({
  page,
}) => {
  const state = backend()
  await page.route("**/api/rpc/own.accounts/plugin.trust.list**", (route) =>
    route.fulfill({
      json: {
        output: {
          locations: [
            {
              directory: state.folders.alpha,
              status: "blocked_by_plugin",
              plugins: [
                { id: "a", source: ".opencode/plugin/a.ts", sha256: "0".repeat(64), approved: false },
                { id: "b", source: ".opencode/plugin/b.ts", sha256: "1".repeat(64), approved: false },
                { id: "c", source: ".opencode/plugin/c.ts", sha256: "2".repeat(64), approved: true },
              ],
            },
          ],
        },
      },
    }),
  )
  await page.goto(harness())
  await page.getByTestId("open-folder").click()
  const picker = page.getByTestId("project-picker")
  await picker.locator("[data-testid=project-recent]", { hasText: "alpha app" }).click()
  const trust = picker.getByTestId("project-trust")
  await expect(trust).toContainText("승인되지 않은 프로젝트 플러그인 2개")
  await trust.getByRole("button").click()
  await expect(picker).toHaveCount(0)
  await expect(page.getByTestId("route")).toHaveText("/settings/plugins")
})

test("MCP sign-in: one integration.oauth.connect for the needs_auth mcp_<16hex> server, then connected", async ({
  page,
  request,
}, testInfo) => {
  const state = backend()
  const connects = watch(
    page,
    (url) => url.pathname.startsWith("/api/integration/") && url.pathname.includes("/connect"),
  )
  await page.goto(harness())
  await page.getByTestId("go-mcp").click()
  const secure = page.locator('[data-testid=mcp-row][data-name="secure"]')
  await expect(secure).toHaveAttribute("data-status", "needs_auth")
  const popup = page.context().waitForEvent("page")
  await secure.getByTestId("mcp-login").click()
  const signIn = page.getByTestId("mcp-signin")
  await expect(signIn).toBeVisible()
  // The web host opens the authorization page in a new tab; the fake server approves and redirects to the
  // server's loopback callback.
  const authorization = await popup
  await authorization.waitForURL(/\/callback\?/)
  await expect(authorization.locator("body")).not.toBeEmpty()
  await expect(page.getByTestId("mcp-signin-body")).toHaveAttribute("data-phase", "done")
  await expect(page.getByTestId("mcp-signin-done")).toContainText("secure")
  await page.screenshot({ path: testInfo.outputPath("mcp-signin.png") })
  await signIn.getByRole("button", { name: "닫기" }).last().click()
  await expect(secure).toHaveAttribute("data-status", "connected")
  await expect(secure.getByTestId("mcp-login")).toHaveCount(0)

  const posted = connects.filter((item) => item.method() === "POST").map((item) => new URL(item.url()).pathname)
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatch(/^\/api\/integration\/mcp_[0-9a-f]{16}\/connect\/oauth$/)
  expect(connects.some((item) => /\/connect\/(key|command)/.test(item.url()))).toBe(false)

  // 16.3 check: MCP integration ids never collide with provider integrations.
  const listed = await request.get(`${state.dev}/api/integration`, { params: at(state.folders.hash) })
  const integrations = ((await listed.json()) as { data: { id: string; metadata?: { source?: string } }[] }).data
  const mcp = integrations.filter((item) => MCP_ID.test(item.id))
  expect(mcp.length).toBeGreaterThan(0)
  expect(mcp.every((item) => item.metadata?.source === "mcp")).toBe(true)
  expect(integrations.filter((item) => item.metadata?.source !== "mcp").some((item) => MCP_ID.test(item.id))).toBe(
    false,
  )
  expect(integrations.some((item) => item.id === "openai")).toBe(true)
})

test("browser tool policy: web sessions start without it, desktop sessions get it attached, nothing flips later", async ({
  page,
  request,
}, testInfo) => {
  const state = backend()
  const marker = (kind: string) => `policy-${kind}-${Date.now()}`

  async function create(query: Record<string, string>) {
    await page.goto(harness(query))
    // The button does nothing until the new session's folder is known (the project list loads after the page).
    await expect(page.getByTestId("new-directory")).not.toHaveText("")
    await page.getByTestId("create-session").click()
    await expect(page.getByTestId("route")).toHaveText(/^\/srv\/local\/s\//)
    return (await page.getByTestId("route").textContent())!.split("/").at(-1)!
  }
  async function run(sessionID: string, text: string) {
    const prompted = await request.post(`${state.dev}/api/session/${sessionID}/prompt`, { data: { text } })
    expect(prompted.ok()).toBe(true)
    const waited = await request.post(`${state.dev}/api/experimental/session/${sessionID}/wait`, { timeout: 60_000 })
    expect(waited.ok()).toBe(true)
  }
  async function permissions(sessionID: string) {
    const response = await request.get(`${state.dev}/api/session/${sessionID}`)
    return ((await response.json()) as { data: { permissions?: unknown[] } }).data.permissions ?? []
  }
  async function setPermissions(sessionID: string, rules: unknown[]) {
    const patched = await request.patch(`${state.dev}/api/session/${sessionID}`, { data: { permissions: rules } })
    expect(patched.ok()).toBe(true)
  }
  async function sentWith(text: string) {
    const sent = (await (await request.get(`${state.mcp}/__e2e/model-requests`)).json()) as { body: string }[]
    const found = sent.find((item) => item.body.includes(text))
    expect(found).toBeTruthy()
    return found!.body
  }

  // Web window: rule 1 at creation, explained on the new-session screen.
  await page.goto(harness())
  await expect(page.getByTestId("browser-tool-notice")).toHaveAttribute("data-kind", "own.policy.browser.newWeb")
  await page.screenshot({ path: testInfo.outputPath("policy-new-web.png") })
  const webSession = await create({})
  await expect(page.getByTestId("session-permissions")).toContainText(
    '{"action":"browser","resource":"*","effect":"deny"}',
  )
  await expect(page.getByTestId("browser-tool-notice")).toHaveCount(0)

  // Desktop window (browserPane): nothing is added.
  await page.goto(harness({ pane: "1" }))
  await expect(page.getByTestId("new-session")).toBeVisible()
  await expect(page.getByTestId("browser-tool-notice")).toHaveCount(0)
  const desktopSession = await create({ pane: "1" })
  expect(await permissions(desktopSession)).toEqual([])
  expect(await permissions(webSession)).toEqual([{ action: "browser", resource: "*", effect: "deny" }])

  // The browser namespace's description (plugin-browser tools.ts; "Desktop browser tools…" before upstream v2.4.0).
  const BROWSER_NAMESPACE = "Browse the web and show workspace files to the person"
  // What the model sees. Since upstream 82bb5ff88a the browser plugin hides its tools from every agent and only a
  // live desktop attachment lists them (05 §8.7 rule 2): with nothing attached neither catalog has the namespace.
  const webText = marker("web")
  const desktopText = marker("desktop")
  await run(webSession, webText)
  await run(desktopSession, desktopText)
  expect(await sentWith(webText)).not.toContain(BROWSER_NAMESPACE)
  expect(await sentWith(desktopText)).not.toContain(BROWSER_NAMESPACE)

  // An attachment's grant (plugin-browser `connection.ts`: its allow appended to the session's rules while it lasts)
  // lists them in the desktop session, which has no deny of its own; the release takes the allow away again.
  const attach = { action: "browser", resource: "*", effect: "allow" }
  await setPermissions(desktopSession, [attach])
  const attachedText = marker("attached")
  await run(desktopSession, attachedText)
  expect(await sentWith(attachedText)).toContain(BROWSER_NAMESPACE)
  await setPermissions(desktopSession, [])

  // The same sessions seen from the other kind of window: explained, never rewritten.
  await page.goto(harness({ pane: "1", session: webSession }))
  await expect(page.getByTestId("browser-tool-notice")).toHaveAttribute(
    "data-kind",
    "own.policy.browser.startedWithout",
  )
  await page.getByTestId("server-status").click()
  await expect(page.getByTestId("server-panel-browser")).toHaveText("이 대화: 브라우저 도구 없음(만들 때 꺼짐)")
  await page.goto(harness({ session: desktopSession }))
  await expect(page.getByTestId("browser-tool-notice")).toHaveAttribute("data-kind", "own.policy.browser.openInDesktop")
  await page.screenshot({ path: testInfo.outputPath("policy-open-in-desktop.png") })
  expect(await permissions(desktopSession)).toEqual([])
  expect(await permissions(webSession)).toEqual([{ action: "browser", resource: "*", effect: "deny" }])
})
