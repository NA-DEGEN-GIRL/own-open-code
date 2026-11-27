// 기본 대화 폴더 (03 §5.1) and 폴더 열기 시작 위치 (03 §18.3) against the real server with own.accounts, in the real app.
// A conversation started without choosing a folder lands in the service's default folder (the backend's temp home, never
// the real Documents) and is listed under `폴더 없는 대화`; 설정 > 일반 changes the folder (a path box in the browser), the
// next conversation uses it, and `기본값으로` goes back; the in-app folder picker starts where 폴더 열기 시작 위치 says.
// Every setting is put back and every conversation made here is deleted at the end.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()
/** Inside the backend's temp root, next to its workspace. */
const CHOSEN = path.join(path.dirname(state.workspace), "chats-e2e")
const made: string[] = []

interface FolderView {
  readonly path: string
  readonly defaultPath: string
  readonly custom: boolean
  readonly exists: boolean
}

async function rpc<T>(request: APIRequestContext, method: string, input: unknown = {}) {
  const response = await request.post(`/api/rpc/own.accounts/${method}`, {
    data: { input },
    params: { "location[directory]": state.control },
  })
  const body = (await response.json()) as { output?: T }
  if (!response.ok()) throw new Error(`${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output as T
}

async function directoryOf(request: APIRequestContext, sessionID: string) {
  const response = await request.get(`/api/session/${sessionID}`)
  const body = (await response.json()) as {
    data?: { location: { directory: string } }
    location?: { directory: string }
  }
  return (body.data ?? body).location?.directory ?? ""
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Sends `text` from the new-conversation screen and answers the new conversation's id. */
async function startConversation(page: Page, text: string) {
  await page.goto("/")
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Alpha")
  const select = page.getByTestId("project-select")
  await expect(select).toHaveAttribute("data-folderless", "")
  await expect(select).toContainText("기본 대화 폴더")
  // The new-conversation screen's centred column (03 §4.3.1) until the first message brings the session layout.
  const view = page.getByTestId("session-view")
  await expect(view).toHaveAttribute("data-home", "")
  await page.locator("#own-composer-input").fill(text)
  await page.locator("#own-composer-input").press("Control+Enter")
  await page.waitForURL(/\/srv\/local\/s\//)
  await expect(view).not.toHaveAttribute("data-home")
  await expect(page.getByTestId("transcript")).not.toContainText("대화를 고르거나 새 대화를 시작하세요.")
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "")
  made.push(id)
  return id
}

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  // Earlier specs may have changed nothing here; start from the defaults.
  await rpc(request, "conversationFolder.set", { path: null })
  await rpc(request, "folderPicker.set", { start: null })
})

test.afterAll(async ({ request }) => {
  await rpc(request, "conversationFolder.set", { path: null }).catch(() => undefined)
  await rpc(request, "folderPicker.set", { start: null }).catch(() => undefined)
  for (const id of made) await request.delete(`/api/session/${id}`).catch(() => undefined)
  fs.rmSync(CHOSEN, { recursive: true, force: true })
})

test("a conversation started without a folder lands in the default folder and its own sidebar group", async ({
  page,
  request,
}) => {
  const errors = watchErrors(page)
  const folder = await rpc<FolderView>(request, "conversationFolder.get")
  expect(folder.custom).toBe(false)
  expect(path.basename(folder.path)).toBe("Own OpenCode")
  expect(folder.path.toLowerCase()).toContain(path.dirname(state.workspace).toLowerCase())

  // The selector offers it first, above the recent projects.
  await page.goto("/")
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  await page.getByTestId("project-select").click()
  const option = page.getByTestId("project-select-no-folder")
  await expect(option).toHaveAttribute("aria-checked", "true")
  await expect(option).toContainText("폴더 없이 대화")
  // The folder itself, on the entry and on the button: whole where there is room, else its end.
  await expect(option.getByTestId("path-tail")).toHaveText(folder.path)
  await expect(option).toHaveAttribute("title", folder.path)
  await page.keyboard.press("Escape")
  const select = page.getByTestId("project-select")
  await expect(select.getByTestId("path-tail")).toHaveText(folder.path)
  await expect(select).toHaveAttribute("title", folder.path)
  for (const width of [1440, 900, 720]) {
    await page.setViewportSize({ width, height: 800 })
    const bar = (await page.locator(".own-cp-bar").first().boundingBox())!
    const button = (await select.boundingBox())!
    const path = (await select.getByTestId("path-tail").boundingBox())!
    expect(button.height).toBe(28)
    expect(button.x + button.width).toBeLessThanOrEqual(bar.x + bar.width)
    expect(path.x + path.width).toBeLessThanOrEqual(button.x + button.width)
    expect(path.width).toBeGreaterThan(60)
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  const id = await startConversation(page, "폴더 없이 그냥 물어볼게요")
  await expect.poll(() => directoryOf(request, id)).not.toBe("")
  expect(same(await directoryOf(request, id), folder.path)).toBe(true)
  expect(fs.statSync(folder.path).isDirectory()).toBe(true)
  expect((await rpc<FolderView>(request, "conversationFolder.get")).exists).toBe(true)

  const group = page.locator("[data-testid=project-row][data-default-folder]")
  await expect(group).toContainText("폴더 없는 대화")
  await expect(group).toHaveAttribute("title", folder.path)
  await expect(page.getByTestId("project-row").first()).toHaveAttribute("data-default-folder", "")
  // It stays a plain folder (03 §4.3.1, GI): the conversation `⋯` says why, with a project folder as the way out.
  await page.getByTestId("session-menu").click()
  await expect(page.getByTestId("session-menu-not-git")).toHaveText(
    "기본 대화 폴더는 폴더 없는 대화가 함께 쓰는 곳이라 Git 저장소로 만들지 않아요. 작업 폴더는 프로젝트 폴더를 열어 거기서 만드세요.",
  )
  await expect(page.getByTestId("session-menu-git-init")).toHaveCount(0)
  await page.getByTestId("session-menu-open-folder").click()
  await expect(page.getByTestId("project-picker")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("project-picker")).toHaveCount(0)
  // Other own plugins this backend does not load answer 400, a new conversation's first reads may 404: resources only.
  expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
})

test("changing the default folder makes the next conversation use it; 기본값으로 goes back", async ({
  page,
  request,
}) => {
  const before = await rpc<FolderView>(request, "conversationFolder.get")
  await page.goto("/settings/general")
  const row = page.getByTestId("settings-default-folder")
  await expect(row.getByTestId("settings-default-folder-path")).toHaveText(before.path)
  await expect(row.getByTestId("settings-default-folder-default")).toBeVisible()
  // The browser has no native folder dialog: a path box with the folder in it.
  await row.getByTestId("settings-folder-change").click()
  const input = row.getByTestId("settings-folder-input")
  await expect(input).toHaveValue(before.path)
  await input.fill(CHOSEN)
  await row.getByTestId("settings-folder-save").click()
  await expect(row.getByTestId("settings-folder-status")).toContainText("기본 대화 폴더를 바꿨어요")
  await expect(row.getByTestId("settings-default-folder-path")).toHaveText(CHOSEN)
  await expect(row.getByTestId("settings-default-folder-default")).toHaveCount(0)
  expect(await rpc<FolderView>(request, "conversationFolder.get")).toMatchObject({ path: CHOSEN, custom: true })
  expect(fs.statSync(CHOSEN).isDirectory()).toBe(true)

  const id = await startConversation(page, "새 기본 폴더에서 물어볼게요")
  await expect.poll(() => directoryOf(request, id)).not.toBe("")
  expect(same(await directoryOf(request, id), CHOSEN)).toBe(true)
  await expect(page.locator("[data-testid=project-row][data-default-folder]")).toHaveAttribute("title", CHOSEN)
  await page.goto("/")
  await expect(page.getByTestId("project-select").getByTestId("path-tail")).toHaveText(CHOSEN)
  await page.goto("/settings/general")

  await page.goto("/settings/general")
  await row.getByTestId("settings-folder-reset").click()
  await expect(row.getByTestId("settings-folder-status")).toContainText("기본값으로 되돌렸어요")
  await expect(row.getByTestId("settings-default-folder-path")).toHaveText(before.defaultPath)
  await expect(row.getByTestId("settings-default-folder-default")).toBeVisible()
  expect(await rpc<FolderView>(request, "conversationFolder.get")).toMatchObject({ custom: false })

  // A folder the service refuses is not stored, and the row says why.
  await row.getByTestId("settings-folder-change").click()
  await row.getByTestId("settings-folder-input").fill("chats")
  await row.getByTestId("settings-folder-save").click()
  await expect(row.getByTestId("settings-folder-status")).toContainText("절대 경로를 입력하세요")
  expect(await rpc<FolderView>(request, "conversationFolder.get")).toMatchObject({ custom: false })
})

test("the folder picker starts where 폴더 열기 시작 위치 says", async ({ page, request }) => {
  await page.goto("/settings/general")
  const row = page.getByTestId("settings-picker-start")
  await row.getByTestId("settings-picker-mode").getByRole("radio", { name: "직접 지정" }).click()
  await row.getByTestId("settings-start-input").fill(state.workspace)
  await row.getByTestId("settings-start-save").click()
  await expect(row.getByTestId("settings-start-status")).toContainText("시작 위치를 바꿨어요")
  await expect(row.getByTestId("settings-picker-now")).toContainText(state.workspace)
  expect((await rpc<{ start: string | null }>(request, "folderPicker.get")).start).toBe(state.workspace)

  await page.goto("/")
  await page.getByTestId("sidebar-open-folder").click()
  const picker = page.getByTestId("project-picker")
  await expect(picker.getByTestId("project-path")).toHaveValue(state.workspace)
  await page.keyboard.press("Escape")

  await page.goto("/settings/general")
  await row.getByTestId("settings-picker-mode").getByRole("radio", { name: "마지막으로 연 폴더의 상위 폴더" }).click()
  await expect(row.getByTestId("settings-start-status")).toContainText("기본값으로 되돌렸어요")
  expect((await rpc<{ start: string | null }>(request, "folderPicker.get")).start).toBeNull()
})

// 03 §18.3 (2.2.6-own.16): the in-app picker (a browser here, like a phone) lists through own.accounts: `새 폴더` makes
// a folder on this PC's service and opens it; an existing name is refused with the way to it; a drive root leaves out
// Windows' system folders and says how many.
test("the folder picker's 새 폴더 makes and opens a folder; a drive root hides Windows' system folders", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByTestId("sidebar-open-folder").click()
  const picker = page.getByTestId("project-picker")
  await picker.getByTestId("project-path").fill(state.workspace)
  await picker.getByTestId("project-path").press("Enter")
  await expect(picker.getByTestId("project-crumbs")).toContainText(path.basename(state.workspace))
  await picker.getByTestId("project-new-folder").click()
  await picker.getByTestId("project-new-folder-name").fill("새 폴더 e2e")
  await picker.getByTestId("project-new-folder-make").click()
  await expect(picker.getByTestId("project-confirm-path")).toContainText("새 폴더 e2e", { timeout: 30_000 })
  const madeFolder = path.join(state.workspace, "새 폴더 e2e")
  expect(fs.statSync(madeFolder).isDirectory()).toBe(true)
  await picker.getByTestId("project-back").click()
  await picker.getByTestId("project-path").fill(state.workspace)
  await picker.getByTestId("project-path").press("Enter")
  await picker.getByTestId("project-new-folder").click()
  await picker.getByTestId("project-new-folder-name").fill("새 폴더 e2e")
  await picker.getByTestId("project-new-folder-name").press("Enter")
  await expect(picker.getByTestId("project-new-folder-error")).toContainText("같은 이름이 이미 있어요")
  await picker.getByTestId("project-new-folder-open-existing").click()
  await expect(picker.getByTestId("project-crumbs")).toContainText("새 폴더 e2e")

  const drive = path.parse(state.workspace).root
  const system = fs
    .readdirSync(drive)
    .filter((name) => ["system volume information", "$recycle.bin"].includes(name.toLowerCase()))
  await picker.getByTestId("project-path").fill(drive)
  await picker.getByTestId("project-path").press("Enter")
  await expect(picker.getByTestId("project-status")).toContainText("폴더")
  for (const name of system) await expect(picker.locator(`[data-name="${name}"]`)).toHaveCount(0)
  if (system.length) await expect(picker.getByTestId("project-status")).toContainText("시스템 폴더")
  await page.keyboard.press("Escape")
  fs.rmSync(madeFolder, { recursive: true, force: true })
})

test("the switcher lists every account's models before the default folder exists (ML)", async ({ page }) => {
  const errors = watchErrors(page)
  // A first start: the default conversation folder is created only on the first send. Earlier specs created this
  // backend's, so its view says it is not there yet; that folder's Location really answers 404.
  const missing = path.join(path.dirname(state.workspace), "not-created-yet", "Own OpenCode")
  await page.route("**/api/rpc/own.accounts/conversationFolder.get**", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { output: FolderView }
    await route.fulfill({ response, json: { ...body, output: { ...body.output, path: missing, exists: false } } })
  })
  // In service mode an empty `location[directory]` is the service's cwd, the home directory (01 §5.3, G15): a heavy
  // Location whose model list answers 503 while its plugins start (`awaitPlugins`), as on the user's PC.
  const unfolded = (url: URL) => url.pathname === "/api/model" && !url.searchParams.get("location[directory]")
  await page.route(unfolded, (route) =>
    route.fulfill({
      status: 503,
      json: {
        _tag: "ServiceUnavailableError",
        message: "Location plugins did not finish activating",
        service: "plugin",
      },
    }),
  )
  const asked: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/api/model") asked.push(url.searchParams.get("location[directory]") ?? "")
  })

  await page.goto("/")
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  await expect(page.getByTestId("project-select")).toHaveAttribute("data-folderless", "")
  await page.getByTestId("composer-switcher").click()
  await expect(page.getByTestId("switcher-cost")).toHaveText("새 대화 — 전환 비용 없음")
  const accounts = page.getByTestId("switcher-account")
  await expect(accounts.first()).toBeVisible()
  for (const account of await accounts.all()) {
    await account.click()
    await expect(page.getByTestId("switcher-model").first()).toBeVisible()
    await expect(page.locator("#own-sw-models")).not.toContainText("불러오는 중")
  }
  await page.keyboard.press("Escape")
  // The composer names the new conversation's model too (its group default needs the same catalog).
  await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Alpha")
  // The models came from the control location: never the folder not created yet, nor the home directory.
  expect(asked.length).toBeGreaterThan(0)
  expect(asked.filter((directory) => !directory || same(directory, missing))).toEqual([])
  expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
})

test("a send before the accounts and defaults answered says it is loading, then goes once they did (RL5-1)", async ({
  page,
}) => {
  // Hold `presets.list` (the group defaults) and the conversation list (the folder's last model): the screen has no
  // "모델 @ 계정" until they answer. RL4 found a tap in that window named an account the user already has as missing
  // (`첫 계정을 추가하세요`).
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const loads = [/\/api\/rpc\/own\.accounts\/presets\.list(\?|$)/, /\/api\/session\?/]
  for (const pattern of loads)
    await page.route(pattern, async (route) => {
      await held
      await route.continue()
    })
  await page.goto("/")
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  const input = page.locator("#own-composer-input")
  await input.fill("불러오는 중에 보내기")
  await input.press("Control+Enter")
  await expect(page.getByTestId("toast").filter({ hasText: "계정과 모델을 불러오는 중이에요" })).toBeVisible()
  await expect(page.getByTestId("toast").filter({ hasText: "첫 계정을 추가하세요" })).toHaveCount(0)
  await expect(input).toHaveValue("불러오는 중에 보내기")
  await expect(page).not.toHaveURL(/\/srv\/local\/s\//)
  release()
  await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Alpha")
  for (const pattern of loads) await page.unroute(pattern)
  await input.fill("")
})

test("a send before the service named the default folder goes out once it did", async ({ page }) => {
  // 0.1 s after the first paint the folder's path is still on its way; here it takes 1.5 s.
  await page.route(/conversationFolder\.get/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await route.continue()
  })
  await page.goto("/")
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  await expect(page.getByTestId("composer-switcher-label")).toContainText("@ Alpha")
  const select = page.getByTestId("project-select")
  await page.locator("#own-composer-input").fill("폴더보다 먼저 보낸 말")
  await page.getByTestId("composer-send").click()
  await expect(select.getByTestId("path-tail")).toHaveCount(0)
  await page.waitForURL(/\/srv\/local\/s\//, { timeout: 20_000 })
  made.push(decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? ""))
  await expect(page.getByTestId("transcript")).toContainText("폴더보다 먼저 보낸 말")
})
