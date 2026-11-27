// Files tab (03 §19.4, §19.5) in Edge against the real server (e2e/files/backend.ts). The harness mounts the tab
// module through the adapter composition (kit.tsx) exactly like the work panel: lazy chunk, `visible()`.
import { expect, test, type Page } from "@playwright/test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

interface FilesBackend {
  readonly dev: string
  readonly workspace: string
  readonly outside: string
  readonly session: string
  readonly many: number
}

const backend = (): FilesBackend =>
  JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "own-web-files-e2e", "backend.json"), "utf8")) as FilesBackend

async function open(page: Page, query: Record<string, string> = {}) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  // A clean slate: tabs are remembered per session in localStorage.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("own-files-e2e")) {
      localStorage.removeItem("own.web.files.tabs")
      sessionStorage.setItem("own-files-e2e", "1")
    }
  })
  await page.goto(`/e2e/files/harness.html?${new URLSearchParams({ session: backend().session, ...query })}`)
  return errors
}

const tree = (page: Page) => page.getByTestId("files-tree")
const row = (page: Page, file: string) => tree(page).locator(`[role=treeitem][data-path="${file}"]`)
const tabs = (page: Page) => page.getByTestId("files-tabs").getByRole("tab")
const viewer = (page: Page) => page.getByTestId("files-viewer")

/** Text of the pierre viewer (it renders into shadow roots). */
function codeText(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=files-viewer] *")]
      .flatMap((element) => (element.shadowRoot ? [element.shadowRoot.textContent ?? ""] : []))
      .join("\n"),
  )
}

async function prompt(text: string) {
  const state = backend()
  const response = await fetch(`${state.dev}/api/session/${state.session}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(state.workspace) },
    body: JSON.stringify({ text }),
  })
  expect(response.ok, await response.clone().text()).toBe(true)
}

test("tree: folders first, .git hidden, virtualized 3,000-file folder; code opens highlighted in the pierre worker", async ({
  page,
}) => {
  const workers: string[] = []
  page.on("worker", (worker) => workers.push(worker.url()))
  const errors = await open(page)

  await expect(row(page, "src")).toBeVisible()
  const top = await tree(page)
    .locator("[role=treeitem][aria-level='1']")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-path")))
  // Folders first, in the server's order (core sorts by localeCompare; the tree never re-sorts); no `.git`.
  expect(top.slice(0, 5).toSorted()).toEqual(["assets", "docs", "many", "src", "문서"])
  expect(top.slice(5).toSorted()).toEqual(["README.md", "big.log", "data.bin"])

  await row(page, "src").click()
  await expect(row(page, "src")).toHaveAttribute("aria-expanded", "true")
  await row(page, "src/router.ts").click()
  await expect(tabs(page)).toHaveText(["router.ts"])
  await expect(row(page, "src/router.ts")).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => codeText(page)).toContain("export const route59 = 59")
  expect(workers.some((url) => url.includes("@pierre/diffs"))).toBe(true)

  await row(page, "many").click()
  await expect(row(page, "many/file-0000.txt")).toBeVisible()
  const rendered = await tree(page).locator("[role=treeitem]").count()
  expect(rendered).toBeLessThan(80)
  await tree(page).evaluate((element) => (element.scrollTop = element.scrollHeight))
  await expect(row(page, `many/file-${String(backend().many - 1).padStart(4, "0")}.txt`)).toBeVisible()
  expect(errors).toEqual([])
})

test("viewers: markdown with a relative image and link, mermaid, PNG, PDF, binary, large text", async ({ page }) => {
  const errors = await open(page)
  const violations: string[] = []
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text())
  })

  await row(page, "README.md").click()
  const markdown = page.getByTestId("files-markdown")
  await expect(markdown.locator("h1")).toHaveText("파일 e2e")
  // The relative image resolves against the document's folder and comes through fs.read (MarkdownProvider readImage).
  await expect.poll(() => markdown.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(40)
  await page.getByTestId("files-mode").getByRole("radio", { name: "원본" }).click()
  await expect.poll(() => codeText(page)).toContain("# 파일 e2e")
  await page.getByTestId("files-mode").getByRole("radio", { name: "미리보기" }).click()
  await markdown.getByRole("link", { name: "라우터" }).click()
  await expect(tabs(page)).toHaveText(["README.md", "router.ts"])
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true")

  await page.evaluate(() => window.__files.openFile("docs/diagram.mmd"))
  await expect(page.getByTestId("files-markdown").locator("[data-component=markdown-mermaid] svg")).toBeVisible()
  await expect(page.getByTestId("files-markdown")).toContainText("뷰어")

  await page.evaluate(() => window.__files.openFile("assets/logo.png"))
  await expect
    .poll(() => page.getByTestId("files-image").evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(40)
  await expect(page.getByTestId("files-title")).toContainText("40 × 30")

  await page.evaluate(() => window.__files.openFile("docs/manual.pdf"))
  // Read into a blob: fs.read answers as a sandboxed download since upstream v2.2.6, which a frame would save.
  const frame = page.getByTestId("files-pdf")
  await expect(frame).toHaveAttribute("src", /^blob:.*#navpanes=0/)
  await expect.poll(() => page.frames().some((item) => item.url().startsWith("blob:"))).toBe(true)

  await page.evaluate(() => window.__files.openFile("data.bin"))
  await expect(page.getByTestId("files-binary")).toBeVisible()

  await page.evaluate(() => window.__files.openFile("big.log"))
  await expect(page.getByTestId("files-large")).toContainText("6.")
  await page.getByTestId("files-large").getByRole("button", { name: "그래도 보기" }).click()
  await expect.poll(() => codeText(page), { timeout: 60_000 }).toContain("log line with some text")

  expect(violations).toEqual([])
  expect(errors).toEqual([])
})

test("quick open: Ctrl+P, server-ranked fs.find results, pinned open tabs, name:line, Korean IME", async ({ page }) => {
  const errors = await open(page)
  const finds: { readonly query: string; readonly type: string | null; readonly limit: string | null }[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/api/fs/find")
      finds.push({
        query: url.searchParams.get("query") ?? "",
        type: url.searchParams.get("type"),
        limit: url.searchParams.get("limit"),
      })
  })
  await expect(row(page, "src")).toBeVisible()
  const dialog = page.getByTestId("files-quick-open")
  const input = page.getByTestId("files-quick-input")
  const options = dialog.getByRole("option")

  await page.keyboard.press("Control+KeyP")
  await expect(input).toBeFocused()
  await input.pressSequentially("rout")
  await expect(options.first()).toHaveAttribute("data-path", "src/router.ts")
  await input.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(tabs(page)).toHaveText(["router.ts"])
  // The server ranks (03 §18.12); every search names its limit and asks for files only.
  expect(finds.filter((find) => find.query)).toContainEqual({ query: "rout", type: "file", limit: "50" })

  // Open tabs are pinned on top of an empty query.
  await page.keyboard.press("Control+KeyP")
  await expect(options.first()).toHaveAttribute("data-path", "src/router.ts")
  await expect(options.first()).toContainText("열림")
  await input.pressSequentially("util.ts:3")
  await expect(options.first()).toHaveAttribute("data-path", "src/util.ts")
  await input.press("Enter")
  await expect(tabs(page)).toHaveText(["router.ts", "util.ts"])
  await expect(page.getByTestId("files-title")).toContainText("3번째 줄")

  // Korean: no request while composing; the committing Enter only commits, the next Enter opens.
  await page.keyboard.press("Control+KeyP")
  await expect(input).toBeFocused()
  const before = finds.length
  const cdp = await page.context().newCDPSession(page)
  for (const text of ["ㅎ", "하", "한", "한ㄱ", "한그", "한글"])
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length })
  await page.waitForTimeout(300)
  expect(finds.length).toBe(before)
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text: "한글" })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await expect(options.first()).toHaveAttribute("data-path", "문서/한글 메모.md")
  expect(finds.at(-1)?.query).toBe("한글")
  await expect(dialog).toBeVisible()
  await input.press("Enter")
  await expect(tabs(page)).toHaveText(["router.ts", "util.ts", "한글 메모.md"])

  // Esc closes and gives the focus back.
  await page.keyboard.press("Control+KeyP")
  await expect(input).toBeFocused()
  await input.press("Escape")
  await expect(dialog).toBeHidden()
  expect(errors).toEqual([])
})

test("watcher: files the agent writes show up in the tree and the open tab without a manual refresh; hidden tabs wait", async ({
  page,
}) => {
  const errors = await open(page)
  await row(page, "src").click()
  await row(page, "src/util.ts").click()
  await expect.poll(() => codeText(page)).toContain("export const twice")

  await prompt("FILES_WRITE:src/created.ts 파일을 만들어 주세요")
  await expect(row(page, "src/created.ts")).toBeVisible()

  await prompt("FILES_WRITE:src/util.ts 를 다시 써 주세요")
  await expect.poll(() => codeText(page)).toContain("written by the files e2e turn")

  // Hidden: events only mark the tab dirty (no fs requests); showing it refreshes once.
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/fs/")) requests.push(request.url())
  })
  await page.evaluate(() => window.__files.setVisible(false))
  await prompt("FILES_WRITE:src/hidden.ts 도 만들어 주세요")
  await expect.poll(() => fs.existsSync(path.join(backend().workspace, "src", "hidden.ts"))).toBe(true)
  await page.waitForTimeout(1_500)
  expect(requests).toEqual([])
  await page.evaluate(() => window.__files.setVisible(true))
  await expect(row(page, "src/hidden.ts")).toBeVisible()
  expect(errors).toEqual([])
})

test("conversation links: path:line, absolute paths, folders, missing and outside files", async ({ page }) => {
  const state = backend()
  const errors = await open(page, { open: "0" })
  // The request waits until the lazy tab has loaded (the shell opens the tab on the intent).
  await page.evaluate(() => window.__files.openFile("src/router.ts:20"))
  await expect(tabs(page)).toHaveText(["router.ts"])
  await expect(page.getByTestId("files-title")).toContainText("20번째 줄")
  await expect(row(page, "src/router.ts")).toHaveAttribute("aria-selected", "true")
  expect(await page.evaluate(() => window.__files.intents)).toEqual(["own:open-file"])

  await page.evaluate((file) => window.__files.openFile(file), path.join(state.workspace, "src", "util.ts"))
  await expect(tabs(page)).toHaveText(["router.ts", "util.ts"])
  await expect(page.getByTestId("files-title")).toContainText("src/util.ts")

  await page.evaluate(() => window.__files.openFile("docs"))
  await expect(row(page, "docs")).toHaveAttribute("aria-expanded", "true")
  await expect(tabs(page)).toHaveCount(2)

  await page.evaluate(() => window.__files.openFile("src/nope.ts"))
  await expect(page.getByTestId("files-missing")).toContainText("src/nope.ts")

  await page.evaluate((file) => window.__files.openFile(file), state.outside)
  await expect(page.getByTestId("files-outside")).toContainText("outside.txt")

  // A markdown file's relative link resolves against its folder.
  await page.evaluate(() => window.__files.openFile("docs/guide.md"))
  await page.getByTestId("files-markdown").getByRole("link", { name: "위로" }).click()
  await expect(page.getByTestId("files-title")).toContainText("README.md")
  expect(errors).toEqual([])
})

test("editor and Explorer: vscode:// link on the web, host openPath/revealPath on the desktop", async ({ page }) => {
  const state = backend()
  const errors = await open(page)
  await page.evaluate(() => window.__files.openFile("src/router.ts:12"))
  await expect(tabs(page)).toHaveText(["router.ts"])
  const segments = path.join(state.workspace, "src", "router.ts").replaceAll("\\", "/").split("/")
  const encoded = segments.map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
  const href = `vscode://file${encoded[0] ? "/" : ""}${encoded.join("/")}:12`
  await expect(page.getByTestId("files-editor")).toHaveAttribute("href", href)
  await page.getByTestId("files-more").click()
  const menu = page.getByTestId("files-menu")
  await expect(menu.getByRole("menuitem")).toHaveText(["에디터에서 열기", "트리에서 보기", "경로 복사"])
  await expect(menu.getByRole("menuitem", { name: "에디터에서 열기" })).toHaveAttribute("href", href)
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  expect(errors).toEqual([])

  const desktop = await page.context().newPage()
  const desktopErrors: string[] = []
  desktop.on("pageerror", (error) => desktopErrors.push(error.message))
  await desktop.goto(`/e2e/files/harness.html?${new URLSearchParams({ session: state.session, host: "desktop" })}`)
  await desktop.evaluate(() => window.__files.openFile("src/router.ts"))
  await desktop.getByTestId("files-editor").click()
  await desktop.getByTestId("files-more").click()
  await expect(desktop.getByTestId("files-menu").getByRole("menuitem")).toHaveText([
    "에디터에서 열기",
    "탐색기에서 보기",
    "트리에서 보기",
    "경로 복사",
  ])
  await desktop.getByTestId("files-menu").getByRole("menuitem", { name: "탐색기에서 보기" }).click()
  const native = path.join(state.workspace, "src", "router.ts")
  await expect
    .poll(() => desktop.evaluate(() => window.__files.calls))
    .toEqual([
      { method: "openPath", args: [native, "code"] },
      { method: "revealPath", args: [native] },
    ])
  // Tree rows open the same menu from the keyboard (Shift+F10).
  await desktop.getByTestId("files-tree").focus()
  await desktop.keyboard.press("Shift+F10")
  await expect(desktop.getByTestId("files-menu")).toBeVisible()
  expect(desktopErrors).toEqual([])
})

test("keyboard: tree arrows open folders and files, tabs switch with arrows and close with Delete", async ({
  page,
}) => {
  const errors = await open(page)
  await expect(row(page, "src")).toBeVisible()
  await tree(page).focus()
  await page.keyboard.press("Home")
  // Walk to src (folders come first, in the server's order), open it, step into it and open its first file.
  for (let step = 0; step < 10; step++) {
    if ((await tree(page).locator("[data-focused]").getAttribute("data-path")) === "src") break
    await page.keyboard.press("ArrowDown")
  }
  await page.keyboard.press("ArrowRight")
  await expect(row(page, "src")).toHaveAttribute("aria-expanded", "true")
  await expect(row(page, "src/router.ts")).toBeVisible()
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Enter")
  await expect(tabs(page)).toHaveCount(1)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(tabs(page)).toHaveCount(2)
  await page.keyboard.press("ArrowLeft")
  await page.keyboard.press("ArrowLeft")
  await expect(row(page, "src")).toHaveAttribute("aria-expanded", "false")

  await tabs(page).nth(1).focus()
  await page.keyboard.press("ArrowLeft")
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true")
  await expect(tabs(page).nth(0)).toBeFocused()
  await page.keyboard.press("Delete")
  await expect(tabs(page)).toHaveCount(1)
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true")

  // Ctrl+F inside the code view opens the file's find bar (session-ui FileSearchBar), not the session find.
  await expect.poll(() => codeText(page)).not.toBe("")
  await page.getByTestId("files-code").click()
  await page.keyboard.press("Control+KeyF")
  await expect(page.locator("input:focus")).toHaveAttribute("placeholder", /.+/)
  expect(errors).toEqual([])
})
