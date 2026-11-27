// Palette (03 §3, §10 Ctrl+K, §12 test 11), shortcut settings with the conflict audit (03 §10, [gap] 32) and the
// shell setting (03 §19.8, [gap] 24) in Edge against the real server (e2e/palette-shell/backend.ts). Serial: the shell
// test changes the server's (temp) global config.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

interface State {
  readonly dev: string
  readonly helper: string
  readonly control: string
  readonly configDir: string
  readonly folders: { readonly alpha: string; readonly beta: string }
  readonly accounts: { readonly alpha: { readonly label: string }; readonly bravo: { readonly label: string } }
  readonly sessions: { readonly fix: string; readonly search: string; readonly alpha: string }
}

const state = (): State =>
  JSON.parse(fs.readFileSync(path.join(process.env.OWN_WEB_PALETTE_E2E_TMP!, "backend.json"), "utf8")) as State
const shots = process.env.OWN_WEB_PALETTE_SHOTS!

test.describe.configure({ mode: "serial" })

async function open(page: Page, query = "") {
  await page.goto(`/e2e/palette-shell/harness.html${query}`)
  await expect(page.getByTestId("sidebar")).toContainText("알파 작업")
}

const palette = (page: Page) => page.getByTestId("palette")
const input = (page: Page) => page.getByTestId("palette-input")
const items = (page: Page) => page.getByTestId("palette-item")
const route = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __paletteHarness: { router: { route(): unknown } } }).__paletteHarness.router.route(),
  )

async function openPalette(page: Page) {
  await page.keyboard.press("Control+k")
  await expect(palette(page)).toBeVisible()
  await expect(input(page)).toBeFocused()
}

async function search(page: Page, text: string) {
  await input(page).fill(text)
  await expect(items(page).first()).toBeVisible()
}

test("Ctrl+K opens the palette over the app; Esc closes it and focus goes back; it is modal", async ({ page }) => {
  await open(page)
  const opener = page.getByTestId("theme-toggle")
  await opener.focus()
  await openPalette(page)
  // Nothing typed: groups with headers; the newest sessions (not all 120 fillers) and the built-in commands.
  const list = page.getByTestId("palette-list")
  await expect(list).toContainText("대화")
  await expect(list).toContainText("모델 @ 계정 전환…")
  await expect(list).toContainText("새 대화")
  await expect(page.locator('[data-testid="palette-item"][data-group="session"]')).toHaveCount(8)
  await page.screenshot({ path: path.join(shots, "palette-dark.png") })
  // Modal: Ctrl+B (sidebar) does not reach the shell under the palette.
  await page.keyboard.press("Control+b")
  await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "open")
  await page.keyboard.press("Escape")
  await expect(palette(page)).toBeHidden()
  await expect(opener).toBeFocused()
  // Ctrl+K toggles.
  await openPalette(page)
  await page.keyboard.press("Control+k")
  await expect(palette(page)).toBeHidden()
})

test("search runs the chosen item: a session, initials, English keywords, a pasted id", async ({ page }) => {
  const backend = state()
  await open(page)
  await openPalette(page)
  await search(page, "알파")
  await expect(items(page).first()).toHaveAttribute("data-id", `session:local/${backend.sessions.alpha}`)
  await page.keyboard.press("Enter")
  await expect(palette(page)).toBeHidden()
  await expect.poll(() => route(page)).toMatchObject({ name: "session", sessionID: backend.sessions.alpha })

  // On a session: its own commands (compaction, fork, restore, agents of its folder — the reverse agent cycle).
  await openPalette(page)
  await search(page, "지금 압축")
  await expect(items(page).first()).toHaveAttribute("data-id", "session.compact")
  await search(page, "에이전트")
  await expect(
    page.locator('[data-testid="palette-item"][data-group="agent"][data-id^="agent:"]').first(),
  ).toBeVisible()
  await page.keyboard.press("Escape")

  // Korean initials (ㅅㄷ → 새 대화) and English keywords for Korean titles.
  await openPalette(page)
  await search(page, "ㅅㄷ")
  await expect(page.locator('[data-testid="palette-item"][data-id="session.new"]')).toBeVisible()
  await search(page, "work panel review")
  await expect(items(page).first()).toHaveAttribute("data-id", "panel.review")
  await expect(items(page).first().locator(".own-pal-kbd")).toHaveText("Ctrl+Shift+R")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "open")

  // A session id that the loaded list does not have yet.
  await openPalette(page)
  await search(page, "ses_0123456789abcdef")
  await expect(items(page).first()).toContainText("대화 ses_0123456789abcdef")
  await page.keyboard.press("Escape")
})

test("Korean IME: results follow the composition; the committing Enter only commits (03 §12 test 11)", async ({
  page,
}) => {
  const backend = state()
  await open(page)
  await openPalette(page)
  const cdp = await page.context().newCDPSession(page)
  for (const text of ["ㅇ", "아", "알", "알ㅍ", "알파"]) {
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length })
    // The list follows every step, and the input element is the same one (never re-rendered).
    await expect(input(page)).toHaveValue(text)
  }
  await expect(items(page).first()).toHaveAttribute("data-id", `session:local/${backend.sessions.alpha}`)
  const marker = await input(page).evaluate((element) => {
    ;(element as HTMLInputElement & { marker?: number }).marker = 1
    return 1
  })
  // Chromium order: keydown(Enter, 229) during the composition, then the commit.
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text: "알파" })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await page.waitForTimeout(200)
  await expect(palette(page)).toBeVisible()
  expect(await input(page).evaluate((element) => (element as HTMLInputElement & { marker?: number }).marker)).toBe(
    marker,
  )
  await page.keyboard.press("Enter")
  await expect(palette(page)).toBeHidden()
  await expect.poll(() => route(page)).toMatchObject({ name: "session", sessionID: backend.sessions.alpha })
})

test("model @ account opens the switcher; commands of other modules and registered shortcuts are listed", async ({
  page,
}) => {
  const backend = state()
  await open(page, "?source")
  await openPalette(page)
  await search(page, "bravo")
  await expect(items(page).first()).toHaveAttribute("data-id", /^account\.switch:/)
  await expect(items(page).first()).toContainText(`${backend.accounts.bravo.label} 계정으로 전환…`)
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("switcher")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("switcher")).toBeHidden()

  // A feature module's source (git actions): grouped, searchable in English, runs after the palette closed.
  await openPalette(page)
  await search(page, "git commit")
  await expect(items(page).first()).toHaveAttribute("data-id", "git.commit")
  await expect(items(page).first()).toContainText("Git")
  await page.keyboard.press("Enter")
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __paletteHarness: { ran: string[] } }).__paletteHarness.ran),
    )
    .toEqual(["git.commit"])

  // MCP list (a module's own dialog) and settings pages.
  await openPalette(page)
  await search(page, "MCP 목록")
  await expect(items(page).first()).toHaveAttribute("data-id", "mcp.list")
  await search(page, "셸")
  await expect(page.locator('[data-testid="palette-item"][data-id="settings:shell"]')).toBeVisible()
  await page.keyboard.press("Escape")
})

test("long lists stay windowed; arrows wrap and keep the active row in view", async ({ page }) => {
  await open(page)
  await openPalette(page)
  await search(page, "더미")
  const count = Number(await page.getByTestId("palette-list").getAttribute("data-count"))
  expect(count).toBeGreaterThanOrEqual(40)
  expect(await items(page).count()).toBeLessThan(count)
  const first = await items(page).first().getAttribute("data-id")
  const active = page.locator('[data-testid="palette-item"][aria-selected="true"]')
  await expect(active).toHaveAttribute("data-id", first!)
  // Up from the first row wraps to the last one, which is scrolled into view (still only a window of rows).
  await page.keyboard.press("ArrowUp")
  await expect(active).toBeInViewport()
  await expect(active).not.toHaveAttribute("data-id", first!)
  expect(await items(page).count()).toBeLessThan(count)
  await page.keyboard.press("ArrowDown")
  await expect(active).toHaveAttribute("data-id", first!)
  await expect(active).toBeInViewport()
  await page.keyboard.press("Escape")
})

test("theme from the palette; the palette in the light theme", async ({ page }) => {
  await open(page)
  await openPalette(page)
  await search(page, "테마 밝게")
  await expect(items(page).first()).toHaveAttribute("data-id", "theme:light")
  await page.keyboard.press("Enter")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await openPalette(page)
  await search(page, "대화")
  await page.screenshot({ path: path.join(shots, "palette-light.png") })
  await search(page, "theme dark")
  await page.keyboard.press("Enter")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
})

test("shortcut settings: audit, rebinding that applies at once, conflicts in red, IME-safe capture", async ({
  page,
}) => {
  await open(page, "?page=shortcuts")
  const settings = page.getByTestId("settings-shortcuts")
  await expect(settings).toContainText("충돌 없음")
  await expect(settings).toContainText("모델 @ 계정 전환기")
  await expect(page.locator("[data-decision][data-kept]")).toHaveCount(6)
  await page.screenshot({ path: path.join(shots, "shortcuts-dark.png"), fullPage: true })

  // Rebind the palette to Ctrl+Alt+K.
  const button = page.locator('[data-keys-button="palette.open"]')
  await button.click()
  await expect(button).toHaveAttribute("data-capturing", "")
  // Keys an IME owns are never recorded.
  await page.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyA", key: "Process", keyCode: 229, isComposing: true, bubbles: true }),
    ),
  )
  await expect(button).toHaveAttribute("data-capturing", "")
  await page.keyboard.press("Control+Alt+k")
  await expect(button).toHaveText("Ctrl+Alt+K")
  await expect(page.locator('tr[data-shortcut="palette.open"]')).toContainText("바꿈")
  expect(await page.evaluate(() => localStorage.getItem("own.web.keymap.v1"))).toContain("Mod+Alt+KeyK")
  // The registry follows without a reload.
  await page.keyboard.press("Control+k")
  await page.waitForTimeout(250)
  await expect(palette(page)).toBeHidden()
  await page.keyboard.press("Control+Alt+k")
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press("Escape")

  // A chord another action uses is refused with its name; the row turns red until the capture ends.
  const panel = page.locator('[data-keys-button="panel.toggle"]')
  await panel.click()
  await page.keyboard.press("Control+Alt+k")
  await expect(page.getByTestId("shortcut-error")).toHaveText("Ctrl+Alt+K는 이미 '명령 팔레트'에 쓰이고 있어요.")
  await expect(page.locator('tr[data-shortcut="panel.toggle"]')).toHaveAttribute("data-problem", "")
  await page.keyboard.press("Control+c")
  await expect(page.getByTestId("shortcut-error")).toContainText("텍스트 편집 키")
  await page.keyboard.press("a")
  await expect(page.getByTestId("shortcut-error")).toContainText("Ctrl, Alt")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("shortcut-error")).toHaveCount(0)
  await expect(panel).toHaveText("Ctrl+Alt+B")

  // Backspace clears; reset all puts the defaults back.
  await panel.click()
  await page.keyboard.press("Backspace")
  await expect(panel).toHaveText("지정 안 함")
  await page.getByTestId("shortcut-reset-all").click()
  await expect(button).toHaveText("Ctrl+K")
  await expect(panel).toHaveText("Ctrl+Alt+B")
  expect(await page.evaluate(() => localStorage.getItem("own.web.keymap.v1"))).toBeNull()
  await page.locator("body").click({ position: { x: 5, y: 5 } })
  await openPalette(page)
  await page.keyboard.press("Escape")
})

test("shell setting: confirm what changes, PATCH the config, terminals and the agent's shell tool follow", async ({
  page,
}) => {
  const backend = state()
  await open(page, "?page=shell")
  const options = page.getByTestId("shell-option")
  const option = (value: string) =>
    page.locator(`[data-testid="shell-option"][data-value="${value.replaceAll("\\", "\\\\")}"]`)
  await expect(options.first()).toBeVisible()
  const values = await options.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-value")))
  const cmd = values.find((value) => value && /\\cmd\.exe$/i.test(value))
  test.skip(!cmd, "Windows shells only")
  // Nothing set: automatic is current.
  await expect(option("auto")).toHaveAttribute("data-current", "")
  await page.screenshot({ path: path.join(shots, "shell-dark.png"), fullPage: true })

  await option(cmd!).click()
  const confirm = page.getByTestId("shell-confirm")
  await expect(confirm).toContainText("명령 프롬프트 (cmd)로 바꿀까요?")
  await expect(confirm).toContainText("새로 여는 터미널이")
  await expect(page.getByTestId("shell-confirm-cache")).toHaveText(
    "셸 도구 설명이 바뀌어 다음 요청에서 캐시를 새로 쓸 수 있어요.",
  )
  await page.getByTestId("shell-apply").click()
  await expect(page.getByTestId("shell-status")).toContainText("적용했어요")
  await expect(option(cmd!)).toHaveAttribute("data-current", "")
  // The global config in the temp root now names cmd.
  const written = fs.readFileSync(path.join(backend.configDir, "opencode.jsonc"), "utf8")
  expect(written).toContain('"shell"')
  expect(written.toLowerCase()).toContain("cmd.exe")

  // New terminals use it (PTY without a command, in the project the page acted on).
  const directory = backend.folders.alpha
  const created = await page.evaluate(async (folder) => {
    const response = await fetch(`/api/pty?location[directory]=${encodeURIComponent(folder)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: folder } }),
    })
    return (await response.json()) as { data?: { id: string; command: string } }
  }, directory)
  expect(created.data?.command.toLowerCase()).toMatch(/cmd(\.exe)?$/)
  await page.evaluate(
    async ({ id, folder }) =>
      void (await fetch(`/api/pty/${id}?location[directory]=${encodeURIComponent(folder)}`, { method: "DELETE" })),
    { id: created.data!.id, folder: directory },
  )

  // The agent's shell tool says so in its description (03 open question 39): "… using cmd."
  await page.evaluate(
    async (sessionID) =>
      void (await fetch(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "셸 확인" }),
      })),
    backend.sessions.alpha,
  )
  await expect
    .poll(
      async () => {
        const requests = (await (await fetch(`${backend.helper}/__e2e/model-requests`)).json()) as { json: unknown }[]
        return JSON.stringify(requests.map((request) => request.json))
      },
      { timeout: 30_000 },
    )
    .toContain("using cmd.")

  // Another listed shell: the confirmation names the exact change of the description.
  const other = values.find((value) => value && value !== "auto" && value !== cmd && !/\\bash\.exe$/i.test(value))
  if (other) {
    await option(other).click()
    await expect(page.getByTestId("shell-confirm")).toHaveAttribute("data-cache", "changes")
    await expect(page.getByTestId("shell-confirm-cache")).toContainText("“using cmd”가")
    await page.getByTestId("shell-cancel").click()
    await expect(page.getByTestId("shell-confirm")).toBeHidden()
  }

  // Back to automatic: the value leaves the config file.
  await option("auto").click()
  await expect(page.getByTestId("shell-confirm")).toContainText("서버의 전역 설정 파일에서 shell 값을 지워요.")
  await page.getByTestId("shell-apply").click()
  await expect(option("auto")).toHaveAttribute("data-current", "")
  expect(fs.readFileSync(path.join(backend.configDir, "opencode.jsonc"), "utf8")).not.toContain('"shell"')
  await page.evaluate(() => localStorage.setItem("opencode-color-scheme", "light"))
  await page.reload()
  await expect(options.first()).toBeVisible()
  await page.screenshot({ path: path.join(shots, "shell-light.png"), fullPage: true })
})
