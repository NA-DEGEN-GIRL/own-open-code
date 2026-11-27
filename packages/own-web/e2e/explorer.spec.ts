// `탐색기에서 열기` / `탐색기에서 보기` (03 §19.5, 05 §7.10) in the real shell.
//  - On a host that can open Explorer (e2e/explorer/harness.tsx: the app with a stand-in `host.explorer` that only
//    writes down what it was asked) the items are in the conversation `⋯`, the project `⋯`, the command palette and
//    the files tab's file and folder menus, a failure is a Korean toast, and 설정 > SSH 원격 호스트 has the program.
//  - In a plain browser window (`/`, the web host) none of them exists.
// No Explorer window and no program is ever started: the desktop app's side is covered in own-desktop's tests.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { backend } from "./support"

const state = backend()
const [first] = state.sessions
const FOLDER = "oie docs"
const FILE = "read me.md"

type Calls = unknown[][]
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __explorer: { calls: unknown[][] } }).__explorer.calls) as Promise<Calls>
/** Paths compare without case and with one kind of separator: the server keeps `/`, Windows shows `\`. */
const same = (value: unknown) => String(value).replaceAll("\\", "/").toLowerCase()
const workspace = same(state.workspace)

async function openHarness(page: Page, query = "") {
  await page.goto(`/e2e/explorer/harness.html${query}`)
  await page.getByTestId("session-list").getByText(first!.title, { exact: true }).click()
  await expect(page.getByTestId("header-title")).toHaveText(first!.title)
}

async function openSessionMenu(page: Page) {
  await page.getByTestId("session-menu").click()
  // The menu's lazy entries rebuild every item when they arrive: wait for them before reading it.
  await expect(page.locator('[data-testid^="session-menu-reset"]').first()).toBeAttached()
}

/** The work panel is open or closed as the window's last use left it. */
async function openFilesTab(page: Page) {
  const toggle = page.getByTestId("panel-toggle")
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await page.getByRole("tab", { name: "파일" }).click()
}

test.beforeAll(() => {
  fs.mkdirSync(path.join(state.workspace, FOLDER), { recursive: true })
  fs.writeFileSync(path.join(state.workspace, FOLDER, FILE), "# explorer\n")
})

test.afterAll(() => {
  fs.rmSync(path.join(state.workspace, FOLDER), { recursive: true, force: true })
})

test.describe("where the host can open Explorer (the desktop app)", () => {
  test("conversation ⋯: 탐색기에서 열기 asks the host for the conversation's folder", async ({ page }) => {
    await openHarness(page)
    await openSessionMenu(page)
    const item = page.getByTestId("session-menu-explorer")
    await expect(item).toHaveText("탐색기에서 열기")
    await item.click()
    await expect.poll(async () => (await calls(page)).map((call) => [call[0], same(call[1])])).toEqual([
      ["reveal", workspace],
    ])
    await expect(page.getByTestId("toast")).toHaveCount(0)
  })

  test("command palette: 탐색기에서 열기 with the folder beside it, found in both languages", async ({ page }) => {
    await openHarness(page)
    await page.keyboard.press("Control+KeyK")
    await page.getByTestId("palette-input").fill("탐색기")
    const command = page.locator('[data-testid="palette-item"][data-id="explorer.open"]')
    await expect(command).toContainText("탐색기에서 열기")
    expect(same(await command.textContent())).toContain(workspace)
    await page.getByTestId("palette-input").fill("open in explorer")
    await expect(command).toBeVisible()
    await command.click()
    await expect.poll(async () => (await calls(page)).map((call) => [call[0], same(call[1])])).toEqual([
      ["reveal", workspace],
    ])
  })

  test("project ⋯ in the sidebar: 탐색기에서 열기 for the project's folder", async ({ page }) => {
    await openHarness(page)
    const row = page.getByTestId("project-row").first()
    await row.hover()
    await row.getByTestId("project-menu").click()
    const item = page.getByTestId("project-menu-explorer")
    await expect(item).toHaveText("탐색기에서 열기")
    await item.click()
    await expect.poll(async () => (await calls(page)).map((call) => [call[0], same(call[1])])).toEqual([
      ["reveal", workspace],
    ])
  })

  test("files tab: a folder row opens, a file row is shown; each with its absolute path", async ({ page }) => {
    await openHarness(page)
    await openFilesTab(page)
    const tree = page.getByTestId("files-tree")
    const folder = tree.locator(`[data-path="${FOLDER}"]`)
    await expect(folder).toBeVisible({ timeout: 30_000 })
    await folder.click({ button: "right" })
    const menu = page.getByTestId("files-menu")
    await expect(menu.getByRole("menuitem")).toHaveText(["탐색기에서 열기", "경로 복사"])
    await menu.getByRole("menuitem", { name: "탐색기에서 열기" }).click()
    await expect.poll(async () => (await calls(page)).map((call) => [call[0], same(call[1])])).toEqual([
      ["reveal", `${workspace}/${FOLDER}`],
    ])
    // The right click selected nothing; a click opens the folder in the tree.
    await folder.click()
    const file = tree.locator(`[data-path="${FOLDER}/${FILE}"]`)
    await expect(file).toBeVisible()
    await file.click({ button: "right" })
    await expect(menu.getByRole("menuitem")).toHaveText(["에디터에서 열기", "탐색기에서 보기", "트리에서 보기", "경로 복사"])
    await menu.getByRole("menuitem", { name: "탐색기에서 보기" }).click()
    await expect.poll(async () => (await calls(page)).map((call) => [call[0], same(call[1])])).toEqual([
      ["reveal", `${workspace}/${FOLDER}`],
      ["reveal", `${workspace}/${FOLDER}/${FILE}`],
    ])
    // The keyboard reaches the folder's menu too.
    await folder.click()
    await page.keyboard.press("Shift+F10")
    await expect(menu.getByRole("menuitem")).toHaveText(["탐색기에서 열기", "경로 복사"])
    await page.keyboard.press("Escape")
  })

  test("a refused start is a Korean toast with the reason; nothing is tried again", async ({ page }) => {
    await openHarness(page, "?fail=blocked&detail=UNKNOWN%3A%20spawn%20UNKNOWN")
    await openSessionMenu(page)
    await page.getByTestId("session-menu-explorer").click()
    const toast = page.getByTestId("toast").last()
    await expect(toast).toContainText("Windows가 프로그램 실행을 막았어요 (UNKNOWN: spawn UNKNOWN)")
    await expect(toast).toContainText("스마트 앱 컨트롤")
    await expect(toast).toHaveAttribute("data-tone", "danger")
    expect(await calls(page)).toHaveLength(1)
  })

  test("a folder outside the open folders says so", async ({ page }) => {
    await openHarness(page, "?fail=outside")
    await openSessionMenu(page)
    await page.getByTestId("session-menu-explorer").click()
    await expect(page.getByTestId("toast").last()).toContainText("앱에서 열어 둔 폴더 밖이라 열지 않았어요")
  })

  test("설정 > SSH 원격 호스트: the program comes from the desktop app's dialog, the arguments are kept only when usable", async ({
    page,
  }) => {
    await page.goto("/e2e/explorer/harness.html?route=/settings/remote")
    const section = page.getByTestId("explorer-settings")
    await expect(section).toBeVisible({ timeout: 60_000 })
    await expect(section.getByRole("heading")).toHaveText("SSH 파일 탐색기")
    await expect(section.getByTestId("explorer-settings-program")).toHaveText("고르지 않았어요")
    await expect(section.getByTestId("explorer-settings-clear")).toHaveCount(0)
    const template = section.getByTestId("explorer-settings-template")
    await expect(template).toHaveValue("--open {host} {path}")
    await expect(section.getByTestId("explorer-settings-help")).toContainText("ssh config 별칭")
    // No text field for the program: only the button, which asks the desktop app.
    await section.getByTestId("explorer-settings-pick").click()
    await expect(section.getByTestId("explorer-settings-program")).toHaveText("D:\\tools\\ssh-explorer.exe")
    await template.fill("sftp://{host}{path}")
    await template.press("Enter")
    await expect.poll(async () => (await calls(page)).at(-1)).toEqual(["template", "sftp://{host}{path}"])
    await expect(section.getByTestId("explorer-settings-reset")).toBeVisible()
    // Without {path} the old value stays and a toast says why.
    await template.fill("--open {host}")
    await template.press("Enter")
    await expect(page.getByTestId("toast").last()).toContainText("실행 인자에는 `{path}`가 있어야 하고")
    await expect(template).toHaveValue("sftp://{host}{path}")
    await section.getByTestId("explorer-settings-reset").click()
    await expect(template).toHaveValue("--open {host} {path}")
    await expect(section.getByTestId("explorer-settings-reset")).toHaveCount(0)
    await section.getByTestId("explorer-settings-clear").click()
    await expect(section.getByTestId("explorer-settings-program")).toHaveText("고르지 않았어요")
    expect((await calls(page)).filter((call) => call[0] === "reveal" || call[0] === "launch")).toEqual([])
  })
})

test.describe("in a browser window (the web host)", () => {
  test("no 탐색기에서 열기 anywhere: conversation ⋯, project ⋯, palette, files tab, settings", async ({ page }) => {
    await page.goto(`/s/${first!.id}`)
    await expect(page.getByTestId("header-title")).toHaveText(first!.title)
    await openSessionMenu(page)
    await expect(page.getByTestId("session-menu-explorer")).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "탐색기에서 열기" })).toHaveCount(0)
    await page.keyboard.press("Escape")

    await page.keyboard.press("Control+KeyK")
    await page.getByTestId("palette-input").fill("탐색기")
    await expect(page.locator('[data-testid="palette-item"][data-id="explorer.open"]')).toHaveCount(0)
    await page.keyboard.press("Escape")

    const row = page.getByTestId("project-row").first()
    await row.hover()
    await row.getByTestId("project-menu").click()
    await expect(page.getByTestId("menu-not-git")).toBeVisible()
    await expect(page.getByTestId("project-menu-explorer")).toHaveCount(0)
    await page.keyboard.press("Escape")

    await openFilesTab(page)
    const folder = page.getByTestId("files-tree").locator(`[data-path="${FOLDER}"]`)
    await expect(folder).toBeVisible({ timeout: 30_000 })
    // A folder row has no menu here: the right click is the browser's own.
    await folder.click({ button: "right" })
    await expect(page.getByTestId("files-menu")).toHaveCount(0)

    await page.goto("/settings/remote")
    await expect(page.getByTestId("remote-settings")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("explorer-settings")).toHaveCount(0)
  })
})
