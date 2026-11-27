// The browser pane on a device (05 §8.10, own-web src/browser/remote): the conversation `⋯` > 브라우저 on the user's
// Galaxy S23 Ultra and the Galaxy Z Fold8 folded and unfolded. The demo world runs own-remote's real gateway with the
// phone stand-in really paired (e2e/manual/backend.ts, OWN_MANUAL_BROWSER=1); the test plays the PC's two other parts
// itself, with `local` scope on the service: the settings page (`devices.update` grants and takes away `브라우저`) and
// the desktop shell (`browser.host.pull/frame/state/result`, with real JPEG frames: Playwright's screenshots of the
// world's sample page). What is checked is what the device shows and what the fake shell receives.
// Runs on the `s23`, `fold8-cover` and `fold8-main` projects. Screenshots go to the run's temp folder, and with
// OWN_WEB_MOBILE_SHOTS=1 to the report's own/reports/mobile-browser-2026-11-21/ (a release tier must not change the
// tree it builds from).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type Browser, type CDPSession, type Locator, type Page } from "@playwright/test"
import { centred } from "./ink"

interface World {
  readonly dev: string
  readonly device: string
  readonly control: string
  readonly sessions: Readonly<Record<string, string>>
  readonly browser?: { readonly deviceId: string; readonly origin: string }
}

interface View {
  readonly sessionID: string
  readonly mode: "pc" | "phone"
  readonly quality: "auto" | "low"
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number }
}

type InputEvent = { readonly k: string } & Readonly<Record<string, unknown>>
type Command =
  | { readonly type: "input"; readonly sessionID: string; readonly events: ReadonlyArray<InputEvent> }
  | { readonly type: "action"; readonly sessionID: string; readonly id: string; readonly action: Readonly<Record<string, unknown>> }

const PROJECTS = ["s23", "fold8-cover", "fold8-main"]
const SHOTS =
  process.env.OWN_WEB_MOBILE_SHOTS === "1"
    ? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../own/reports/mobile-browser-2026-11-21")
    : path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "shots")
const PHONE_SCOPES = ["read", "prompt", "switch"]
const SITE = "/manual/site/"

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as World
  if (!state.browser) throw new Error("the demo world runs without OWN_MANUAL_BROWSER=1 (e2e/mobile/playwright.config.ts)")
  return state
}

/** RPC `own.remote` with the service's own credential (`local` scope): what the PC's window and its shell may call. */
async function pc<T = Record<string, unknown>>(method: string, input: unknown) {
  const answer = await fetch(`${world().device}/manual/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "own.remote", method, input }),
  })
  const result = (await answer.json()) as { readonly status: number; readonly output?: T; readonly type?: string; readonly message?: string }
  if (result.status !== 200) throw new Error(`own.remote ${method}: ${result.status} ${result.type} ${result.message}`)
  return result.output as T
}

/** The PC's 설정 > 휴대폰·다른 PC: what this device may do. */
async function allow(scopes: readonly string[]) {
  await pc("devices.update", { deviceId: world().browser!.deviceId, scopes })
}

/** This device's `브라우저` on or off, beside a phone's default permissions. */
function grant(browser: boolean) {
  return allow(browser ? [...PHONE_SCOPES, "browser"] : PHONE_SCOPES)
}

/** The desktop shell's part, played by the test. */
function shell() {
  const host = `e2e-shell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const seen: Command[] = []
  const last: { views: ReadonlyArray<View> } = { views: [] }
  const pull = async (hosted: readonly string[], windows = 1) => {
    const answer = await pc<{ views: View[]; commands: Command[]; idle: boolean }>("browser.host.pull", {
      host,
      windows,
      hosted,
      waitMs: 0,
    })
    seen.push(...answer.commands)
    last.views = answer.views
    return answer
  }
  /** Pulls until `pick` finds what it waits for among everything received so far. */
  const until = async <T>(
    hosted: readonly string[],
    pick: (commands: ReadonlyArray<Command>, views: ReadonlyArray<View>) => T | undefined | false,
  ) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await pull(hosted)
      const found = pick(seen, last.views)
      if (found !== undefined && found !== false) return found
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`the shell never got it: ${JSON.stringify({ commands: seen, views: last.views }).slice(0, 2000)}`)
  }
  return {
    host,
    pull,
    views: () => last.views,
    until,
    /** Pulls until the viewer's next action arrives. */
    action: (hosted: readonly string[]) =>
      until(hosted, (commands) => commands.flatMap((command) => (command.type === "action" ? [command] : []))[0]),
    /** Everything received so far, and forgets it. */
    take: () => seen.splice(0),
    events: () => seen.flatMap((command) => (command.type === "input" ? command.events : [])),
    state: (sessionID: string, state: unknown) => pc("browser.host.state", { host, sessionID, state }),
    notice: (sessionID: string, notice: string) => pc("browser.host.state", { host, sessionID, notice }),
    frame: (sessionID: string, jpeg: Frame, sharp = false) =>
      pc<{ viewers: number; acked: boolean }>("browser.host.frame", {
        host,
        sessionID,
        width: jpeg.width,
        height: jpeg.height,
        sharp,
        data: jpeg.data,
      }),
    result: (id: string, ok: boolean, error?: string) => pc("browser.host.result", { host, id, ok, ...(error ? { error } : {}) }),
    /** The app closes: devices see `PC의 데스크톱 앱이 꺼져 있어요` again. */
    leave: () => pull([], 0),
  }
}

type Shell = ReturnType<typeof shell>

interface Frame {
  readonly width: number
  readonly height: number
  readonly data: string
}

/** A real JPEG of the world's sample page at a size, as the shell would capture a pane. */
async function capture(browser: Browser, size: { readonly width: number; readonly height: number }, scale = 1): Promise<Frame> {
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: scale,
    isMobile: false,
    hasTouch: false,
    baseURL: world().device,
  })
  const page = await context.newPage()
  await page.goto(SITE)
  const jpeg = await page.screenshot({ type: "jpeg", quality: 70 })
  await context.close()
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale), data: jpeg.toString("base64") }
}

const tab = (id: string, url: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  url,
  title,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over,
})

function pane(tabs: ReadonlyArray<ReturnType<typeof tab>>, over: Record<string, unknown> = {}) {
  return { tabs, focusedTabID: tabs[0]?.id ?? null, page: { mode: "pc", width: 800, height: 500 }, dialog: null, ...over }
}

const SCORES = () => tab("tab_scores", `${world().device}${SITE}`, "우주 게임 점수판", { canGoBack: true })
const DOCS = tab("tab_docs", "https://example.com/docs/start", "시작하기 · 문서")

async function openSession(page: Page, id: string) {
  await page.goto(`/srv/local/s/${id}`)
  await page.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
  await expect(page.getByTestId("running-on").first()).not.toContainText("own-codex", { timeout: 60_000 })
}

/** The conversation `⋯` > 브라우저 (the entry arrives with the menu's lazy items). */
async function openViewer(page: Page) {
  await page.getByTestId("session-menu").tap()
  const entry = page.locator("[popover][role=menu]:popover-open").getByTestId("session-menu-browser")
  await expect(entry).toHaveText("브라우저")
  // The menu rebuilds its items whenever the conversation's own state arrives (a title, its flags): an item scrolled
  // to may be one just replaced, so the tap is tried again on the item that is there.
  await expect(async () => {
    if (await page.getByTestId("remote-browser").count()) return
    await entry.scrollIntoViewIfNeeded({ timeout: 2000 })
    await entry.tap({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  const viewer = page.getByTestId("remote-browser")
  await viewer.waitFor()
  return viewer
}

const stage = (page: Page) => page.getByTestId("remote-browser-stage")

/** The viewer of a hosted session with the sample page's frame on screen. */
async function watching(page: Page, browser: Browser, pcShell: Shell, sessionID: string, tabs = [SCORES(), DOCS]) {
  await grant(true)
  await pcShell.pull([sessionID])
  await openSession(page, sessionID)
  const viewer = await openViewer(page)
  await pcShell.until([sessionID], (_commands, views) => views.some((view) => view.sessionID === sessionID))
  await pcShell.state(sessionID, pane(tabs))
  const frame = await capture(browser, { width: 800, height: 500 })
  expect(await pcShell.frame(sessionID, frame)).toEqual({ viewers: 1, acked: true })
  await expect(stage(page)).toHaveAttribute("data-screen", "frame")
  return viewer
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error("not laid out")
  return value
}

/** Where a fraction of the drawn frame is on the screen. */
async function at(page: Page, x: number, y: number) {
  const frame = await box(page.getByTestId("remote-browser-frame"))
  return { x: frame.x + frame.width * x, y: frame.y + frame.height * y }
}

function setVisibility(page: Page, state: "hidden" | "visible") {
  return page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value })
    document.dispatchEvent(new Event("visibilitychange"))
  }, state)
}

async function shot(page: Page, project: string, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${project}-${name}.png`) })
}

const touches = (events: ReadonlyArray<InputEvent>) =>
  events.flatMap((event) =>
    event.k === "touch"
      ? [event as unknown as { readonly phase: string; readonly points: ReadonlyArray<{ readonly id: number; readonly x: number; readonly y: number }> }]
      : [],
  )

test.describe.configure({ mode: "serial" })

test.beforeEach(async ({}, info) => {
  test.skip(!PROJECTS.includes(info.project.name), "the Galaxy S23 Ultra and the Galaxy Z Fold8 (cover and main)")
  // Every test starts as a phone is paired by default: `브라우저` off, and no desktop app on the PC.
  await grant(false)
  await shell().leave()
})

test.afterEach(async ({}, info) => {
  if (!PROJECTS.includes(info.project.name)) return
  await shell().leave()
  await grant(false)
})

test("without the permission the entry explains and opens no socket; granted, the view shows the PC's frame", async ({
  page,
  browser,
}, info) => {
  const sessionID = world().sessions.hud!
  const sockets: string[] = []
  page.on("websocket", (socket) => {
    if (socket.url().includes("/own/browser/")) sockets.push(socket.url())
  })
  await openSession(page, sessionID)
  await openViewer(page)
  await expect(stage(page)).toHaveAttribute("data-screen", "permission")
  await expect(page.getByTestId("remote-browser-message")).toContainText(
    "이 기기에서는 브라우저를 볼 수 없어요. DEMO-PC의 설정 > 휴대폰·다른 PC에서 이 기기의 ‘브라우저’를 켜 주세요.",
  )
  await expect(page.getByTestId("remote-browser-address")).toHaveAttribute("readonly", "")
  await page.waitForTimeout(1500)
  expect(sockets).toEqual([])
  if (info.project.name === "s23") await shot(page, "s23", "04-no-permission")

  // The PC turns `브라우저` on for this device: the view connects, and says the desktop app is not running.
  await grant(true)
  await page.getByTestId("remote-browser-recheck").tap()
  await expect(stage(page)).toHaveAttribute("data-screen", "absent")
  await expect(page.getByTestId("remote-browser-message")).toContainText("PC의 데스크톱 앱이 꺼져 있어요")
  expect(sockets).toEqual([`${world().device.replace("http", "ws")}/own/browser/local/${sessionID}`])

  // The desktop app starts (the fake shell's first pull): it is asked for this conversation's pane and attaches it.
  const pcShell = shell()
  await pcShell.pull([])
  await expect(stage(page)).toHaveAttribute("data-screen", "attaching")
  await expect(page.getByTestId("remote-browser-message")).toHaveText("브라우저 연결 중…")
  const view = await pcShell.until([sessionID], (_commands, views) => views.find((item) => item.sessionID === sessionID))
  expect(view.mode).toBe("pc")
  const area = await box(stage(page))
  expect(view.viewport.width).toBe(Math.round(area.width))
  expect(view.viewport.height).toBe(Math.round(area.height))
  await pcShell.state(sessionID, pane([]))
  await expect(stage(page)).toHaveAttribute("data-screen", "empty")
  await expect(page.getByTestId("remote-browser-message")).toContainText("열린 탭이 없어요.")

  // A tab and its first frame: drawn, then acknowledged to the shell.
  await pcShell.state(sessionID, pane([SCORES()]))
  const frame = await capture(browser, { width: 800, height: 500 })
  expect(await pcShell.frame(sessionID, frame)).toEqual({ viewers: 1, acked: true })
  await expect(stage(page)).toHaveAttribute("data-screen", "frame")
  const canvas = page.getByTestId("remote-browser-frame")
  await expect(canvas).toHaveAttribute("data-seq", /^\d+$/)
  const drawn = await canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data
    const colours = new Set<number>()
    for (let index = 0; index < pixels.length; index += 4 * 97)
      colours.add((pixels[index]! << 16) | (pixels[index + 1]! << 8) | pixels[index + 2]!)
    return { width: element.width, height: element.height, colours: colours.size }
  })
  expect(drawn).toMatchObject({ width: 800, height: 500 })
  expect(drawn.colours).toBeGreaterThan(8)
  // Fitted into the area with the page's shape (800×500), never wider than the screen, and right under the bars: the
  // room a wide PC page leaves on a tall screen is below it.
  const onScreen = await box(canvas)
  expect(onScreen.width / onScreen.height).toBeCloseTo(1.6, 1)
  expect(Math.abs(onScreen.y - area.y)).toBeLessThan(0.5)
  expect(onScreen.x).toBeGreaterThanOrEqual(area.x - 0.5)
  expect(onScreen.x + onScreen.width).toBeLessThanOrEqual(area.x + area.width + 0.5)
  // A sharper frame replaces it.
  const sharp = await capture(browser, { width: 800, height: 500 }, 2)
  expect(await pcShell.frame(sessionID, sharp, true)).toEqual({ viewers: 1, acked: true })
  await expect(canvas).toHaveAttribute("data-sharp", "")
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBe(1600)
  expect((await box(canvas)).width).toBeCloseTo(onScreen.width, 0)
  if (info.project.name === "s23") await shot(page, "s23", "01-frame")
})

test("tabs and the address come from the PC; a tap, a drag, 한글 and an address go back to it", async ({
  page,
  browser,
}, info) => {
  const sessionID = world().sessions.hud!
  const pcShell = shell()
  await watching(page, browser, pcShell, sessionID)

  // The header names the focused tab, the tab button counts them, the address row shows where it is.
  await expect(page.getByTestId("remote-browser-title")).toHaveText("우주 게임 점수판")
  await expect(page.getByTestId("remote-browser-tabs")).toHaveText("2")
  await expect(page.getByTestId("remote-browser-address")).toHaveValue(`${world().device}${SITE}`)
  await expect(page.getByTestId("remote-browser-back")).toBeEnabled()
  await expect(page.getByTestId("remote-browser-forward")).toBeDisabled()
  await page.getByTestId("remote-browser-tabs").tap()
  const sheet = page.getByTestId("remote-browser-tab-sheet")
  await expect(sheet.getByTestId("remote-browser-tab")).toHaveCount(2)
  await expect(sheet.getByTestId("remote-browser-tab").first()).toHaveAttribute("data-active", "")
  await expect(sheet.getByTestId("remote-browser-tab").nth(1)).toContainText("시작하기 · 문서")
  await expect(sheet.getByTestId("remote-browser-tab").nth(1)).toContainText("https://example.com/docs/start")
  if (info.project.name === "s23") await shot(page, "s23", "02-tabs")
  // Choosing the other tab asks the PC to focus it; the PC's state then moves the view.
  pcShell.take()
  await sheet.getByTestId("remote-browser-tab").nth(1).locator("button").first().tap()
  await expect(sheet).toHaveCount(0)
  const focus = await pcShell.action([sessionID])
  expect(focus).toMatchObject({ type: "action", sessionID, action: { type: "tabs.focus", tabID: "tab_docs" } })
  await pcShell.result(focus.id, true)
  await pcShell.state(sessionID, pane([SCORES(), DOCS], { focusedTabID: "tab_docs" }))
  await expect(page.getByTestId("remote-browser-title")).toHaveText("시작하기 · 문서")
  await expect(page.getByTestId("remote-browser-address")).toHaveValue("https://example.com/docs/start")

  // A tap in the middle of the frame: a touch that starts and ends there.
  pcShell.take()
  const middle = await at(page, 0.5, 0.5)
  await page.touchscreen.tap(middle.x, middle.y)
  const tapped = await pcShell.until([sessionID], () => {
    const seen = touches(pcShell.events())
    return seen.some((event) => event.phase === "end") ? seen : undefined
  })
  expect(tapped.map((event) => event.phase)).toEqual(["start", "end"])
  expect(tapped[0]!.points).toHaveLength(1)
  expect(tapped[0]!.points[0]!.x).toBeCloseTo(0.5, 1)
  expect(tapped[0]!.points[0]!.y).toBeCloseTo(0.5, 1)
  expect(tapped[1]!.points).toEqual([])

  // A drag from the lower right to the upper left of the frame: where it starts, where it ends, moves between.
  pcShell.take()
  const cdp = await page.context().newCDPSession(page)
  const from = await at(page, 0.8, 0.75)
  const to = await at(page, 0.2, 0.25)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] })
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + (to.x - from.x) * step, y: from.y + (to.y - from.y) * step, id: 1 }],
    })
    await page.waitForTimeout(40)
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  const dragged = await pcShell.until([sessionID], () => {
    const seen = touches(pcShell.events())
    return seen.some((event) => event.phase === "end") ? seen : undefined
  })
  expect(dragged[0]!.phase).toBe("start")
  expect(dragged[0]!.points[0]!.x).toBeCloseTo(0.8, 1)
  expect(dragged[0]!.points[0]!.y).toBeCloseTo(0.75, 1)
  const moves = dragged.filter((event) => event.phase === "move")
  expect(moves.length).toBeGreaterThanOrEqual(1)
  expect(moves.at(-1)!.points[0]!.x).toBeCloseTo(0.2, 1)
  expect(moves.at(-1)!.points[0]!.y).toBeCloseTo(0.25, 1)
  expect(dragged.at(-1)).toMatchObject({ phase: "end", points: [] })

  // 한글 through the keyboard button: the syllables being composed, then the committed text.
  pcShell.take()
  await page.getByTestId("remote-browser-keyboard").tap()
  await expect(page.getByTestId("remote-browser-keys")).toBeFocused()
  await cdp.send("Input.imeSetComposition", { text: "ㅎ", selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
  await cdp.send("Input.insertText", { text: "한" })
  await cdp.send("Input.imeSetComposition", { text: "그", selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
  await cdp.send("Input.imeSetComposition", { text: "글", selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
  await cdp.send("Input.insertText", { text: "글" })
  await page.keyboard.press("Enter")
  const typed = await pcShell.until([sessionID], () => {
    const seen = pcShell.events().filter((event) => event.k === "compose" || event.k === "text" || event.k === "key")
    return seen.some((event) => event.k === "key") ? seen : undefined
  })
  expect(typed).toEqual([
    { k: "compose", text: "ㅎ" },
    { k: "compose", text: "한" },
    { k: "text", text: "한" },
    { k: "compose", text: "그" },
    { k: "compose", text: "글" },
    { k: "text", text: "글" },
    { k: "key", key: "Enter" },
  ])
  // The field never shows a line break of its own for Enter, and a tap on the frame does not take the keyboard away.
  await page.touchscreen.tap(middle.x, middle.y)
  await expect(page.getByTestId("remote-browser-keys")).toBeFocused()

  // The clipboard is this device's: Ctrl+C sends nothing, Ctrl+A is the page's, and Ctrl+V pastes this device's text
  // into the field, which reaches the page as text, its line break kept (a pasted note must not press Enter).
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await page.evaluate(() => navigator.clipboard.writeText("서울시 중구\n세종대로 110"))
  pcShell.take()
  await page.keyboard.press("Control+C")
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Control+V")
  const pasted = await pcShell.until([sessionID], () => {
    const seen = pcShell.events().filter((event) => event.k === "text" || event.k === "key")
    return seen.some((event) => event.k === "text") ? seen : undefined
  })
  expect(pasted).toEqual([
    { k: "key", key: "a", ctrl: true },
    { k: "text", text: "서울시 중구\n세종대로 110" },
  ])

  // An address: the desktop pane's rule makes `example.com/docs` an https address, and the PC's refusal is shown.
  pcShell.take()
  const address = page.getByTestId("remote-browser-address")
  await address.tap()
  await address.fill("example.com/docs")
  await page.keyboard.press("Enter")
  const navigate = await pcShell.action([sessionID])
  expect(navigate.action).toEqual({ type: "navigate", url: "https://example.com/docs" })
  await pcShell.result(navigate.id, false, "browser.address.blocked")
  await expect(page.getByTestId("remote-browser-note")).toHaveText("이 주소는 열 수 없어요. http·https 주소나 검색어를 넣어 주세요.")
  // Search words go to the search engine; a file path never leaves the device.
  pcShell.take()
  await address.tap()
  await address.fill("우주 게임 공략")
  await page.keyboard.press("Enter")
  const search = await pcShell.action([sessionID])
  expect(search.action).toEqual({
    type: "navigate",
    url: `https://www.google.com/search?q=${encodeURIComponent("우주 게임 공략")}`,
  })
  await pcShell.result(search.id, true)
  await pcShell.state(sessionID, pane([SCORES(), tab("tab_docs", "https://example.com/docs", "문서")], { focusedTabID: "tab_docs" }))
  await expect(address).toHaveValue("https://example.com/docs")
  pcShell.take()
  await address.tap()
  await address.fill("C:\\Users\\demo\\secret.txt")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("remote-browser-note")).toHaveText("이 주소는 열 수 없어요. http·https 주소나 검색어를 넣어 주세요.")
  await page.waitForTimeout(500)
  await pcShell.pull([sessionID])
  expect(pcShell.take().filter((command) => command.type === "action")).toEqual([])

  // The PC's notices are toasts; a page's dialog is answered from here.
  await pcShell.notice(sessionID, "download")
  await expect(page.getByTestId("toast").filter({ hasText: "파일을 받았어요. PC의 데스크톱 앱에서 저장할 수 있어요." })).toBeVisible()
  await pcShell.state(
    sessionID,
    pane([SCORES()], { dialog: { type: "confirm", message: "점수를 지울까요?", defaultPrompt: "" } }),
  )
  const dialog = page.getByTestId("remote-browser-dialog")
  await expect(dialog).toContainText("점수를 지울까요?")
  await dialog.getByTestId("remote-browser-dialog-ok").tap()
  const answered = await pcShell.action([sessionID])
  expect(answered.action).toEqual({ type: "dialog", accept: true })
})

test("a view that is not on screen is not streamed: a hidden page, then the closed layer", async ({ page, browser }) => {
  const sessionID = world().sessions.hud!
  const pcShell = shell()
  await watching(page, browser, pcShell, sessionID)
  const frame = await capture(browser, { width: 800, height: 500 })
  const listed = () => pcShell.views().some((view) => view.sessionID === sessionID)

  await setVisibility(page, "hidden")
  await expect.poll(async () => (await pcShell.pull([sessionID])) && listed()).toBe(false)
  expect(await pcShell.frame(sessionID, frame)).toEqual({ viewers: 0, acked: false })

  await setVisibility(page, "visible")
  await expect.poll(async () => (await pcShell.pull([sessionID])) && listed()).toBe(true)
  expect(await pcShell.frame(sessionID, frame)).toEqual({ viewers: 1, acked: true })

  // Closing the view closes its socket.
  await page.getByTestId("remote-browser-close").tap()
  await expect(page.getByTestId("remote-browser")).toHaveCount(0)
  await expect.poll(async () => (await pcShell.pull([sessionID])) && listed()).toBe(false)
  expect(await pcShell.frame(sessionID, frame)).toEqual({ viewers: 0, acked: false })
})

test("휴대폰 크기로 보기 asks the PC for this screen's size, and gives it back when turned off", async ({
  page,
  browser,
}, info) => {
  const sessionID = world().sessions.hud!
  const pcShell = shell()
  await watching(page, browser, pcShell, sessionID)
  const area = await box(stage(page))

  await page.getByTestId("remote-browser-menu").tap()
  const menu = page.locator("[popover][role=menu]:popover-open")
  await expect(menu.getByTestId("remote-browser-phone")).toHaveText("휴대폰 크기로 보기")
  await expect(menu.getByTestId("remote-browser-saver")).toHaveText("데이터 절약")
  await menu.getByTestId("remote-browser-phone").tap()
  await expect(stage(page)).toHaveAttribute("data-mode", "phone")
  const phone = await pcShell.until([sessionID], (_commands, views) =>
    views.find((view) => view.sessionID === sessionID && view.mode === "phone"),
  )
  expect(phone.viewport).toEqual({
    width: Math.round(area.width),
    height: Math.round(area.height),
    dpr: await page.evaluate(() => window.devicePixelRatio),
  })
  // The shell emulates that size and sends the page at it: the frame fills the area.
  await pcShell.state(sessionID, pane([SCORES()], { page: { mode: "phone", ...phone.viewport } }))
  const frame = await capture(browser, { width: phone.viewport.width, height: phone.viewport.height }, 2)
  expect(await pcShell.frame(sessionID, frame)).toEqual({ viewers: 1, acked: true })
  const canvas = await box(page.getByTestId("remote-browser-frame"))
  expect(Math.abs(canvas.width - area.width)).toBeLessThan(1.5)
  expect(Math.abs(canvas.height - area.height)).toBeLessThan(1.5)
  if (info.project.name === "s23") await shot(page, "s23", "03-phone-size")

  // The choice is kept on this device, with the mark in the menu; 데이터 절약 asks for lighter frames.
  await page.getByTestId("remote-browser-menu").tap()
  await expect(menu.getByTestId("remote-browser-phone")).toHaveText("✓ 휴대폰 크기로 보기")
  await menu.getByTestId("remote-browser-saver").tap()
  await pcShell.until([sessionID], (_commands, views) => views.some((view) => view.quality === "low"))
  expect(await page.evaluate(() => [localStorage.getItem("own.web.remoteBrowser.phone"), localStorage.getItem("own.web.remoteBrowser.saver")])).toEqual(["1", "1"])

  await page.getByTestId("remote-browser-menu").tap()
  await menu.getByTestId("remote-browser-phone").tap()
  const back = await pcShell.until([sessionID], (_commands, views) =>
    views.find((view) => view.sessionID === sessionID && view.mode === "pc"),
  )
  expect(back.viewport.width).toBe(Math.round(area.width))
  await page.getByTestId("remote-browser-menu").tap()
  await menu.getByTestId("remote-browser-saver").tap()
  await pcShell.until([sessionID], (_commands, views) => views.some((view) => view.quality === "auto"))
})

test("taking the permission away on the PC while watching closes the view into the explanation", async ({
  page,
  browser,
}) => {
  const sessionID = world().sessions.hud!
  const pcShell = shell()
  await watching(page, browser, pcShell, sessionID)
  await grant(false)
  await expect(stage(page)).toHaveAttribute("data-screen", "permission")
  await expect(page.getByTestId("remote-browser-message")).toContainText("이 기기에서는 브라우저를 볼 수 없어요.")
  await pcShell.pull([sessionID])
  expect(pcShell.views()).toEqual([])
  // No device may watch any more: a frame finds no viewer (or the hub, idle again, no longer knows this shell).
  const frame = await capture(browser, { width: 800, height: 500 })
  expect(
    await pcShell.frame(sessionID, frame).then(
      (answer) => answer.viewers,
      () => 0,
    ),
  ).toBe(0)
})

test("layout: a layer on a phone and a folded Fold, beside the conversation on an unfolded one", async ({
  page,
  browser,
}, info) => {
  const sessionID = world().sessions.enemy!
  const pcShell = shell()
  const viewer = await watching(page, browser, pcShell, sessionID)
  const screen = page.viewportSize()!
  const frame = await box(viewer)
  const overflow = () =>
    page.evaluate(() => ({
      page: document.documentElement.scrollWidth - window.innerWidth,
      viewer: (() => {
        const root = document.querySelector<HTMLElement>('[data-testid="remote-browser"]')!
        return Math.max(...[...root.querySelectorAll<HTMLElement>("*")].map((element) => element.getBoundingClientRect().right)) - window.innerWidth
      })(),
    }))
  /** Visible buttons and fields of the viewer smaller than a thumb. */
  const small = () =>
    viewer.evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>("button, input, [role=menuitem]")]
        .filter((element) => element.checkVisibility())
        .map((element) => ({ name: element.dataset.testid ?? element.getAttribute("aria-label") ?? element.textContent, rect: element.getBoundingClientRect() }))
        .filter((item) => item.rect.width < 43.5 || item.rect.height < 43.5)
        .map((item) => `${item.name} ${Math.round(item.rect.width)}×${Math.round(item.rect.height)}`),
    )
  expect((await overflow()).page).toBeLessThanOrEqual(0)
  expect((await overflow()).viewer).toBeLessThanOrEqual(0.5)
  expect(await small()).toEqual([])
  // The sizes of this run, for the report (own/reports/mobile-browser-2026-11-21.md).
  const sizes = {
    screen,
    viewer: frame,
    bars: await box(page.getByTestId("remote-browser-bars")),
    stage: await box(stage(page)),
    frame: await box(page.getByTestId("remote-browser-frame")),
    conversation: await box(page.getByTestId("session-view").first()),
  }
  fs.writeFileSync(
    path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", `browser-layout-${info.project.name}.json`),
    JSON.stringify(sizes, null, 2),
  )

  if (info.project.name === "fold8-main") {
    // Beside the conversation, half each; the conversation list gave its column to it.
    await expect(viewer).toHaveAttribute("data-layout", "beside")
    const chat = await box(page.getByTestId("session-view").first())
    expect(frame.width).toBeGreaterThanOrEqual(360)
    expect(chat.width).toBeGreaterThanOrEqual(360)
    expect(Math.abs(frame.width - chat.width)).toBeLessThan(4)
    expect(chat.x + chat.width).toBeLessThanOrEqual(frame.x + 1)
    expect(frame.x + frame.width).toBeLessThanOrEqual(screen.width + 0.5)
    await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "closed")
    expect((await box(page.getByTestId("remote-browser-frame"))).y).toBeCloseTo((await box(stage(page))).y, 0)
    // Both stay usable: the conversation takes a draft while the browser shows its frame.
    const input = page.locator("#own-composer-input")
    await input.tap()
    await input.fill("옆에서 보면서 쓰기")
    await expect(input).toHaveValue("옆에서 보면서 쓰기")
    await expect(page.getByTestId("composer-send").first()).toBeVisible()
    await input.fill("")
    await shot(page, "fold8-main", "06-beside-conversation")
    // The tab list is a sheet inside the browser's column.
    await page.getByTestId("remote-browser-tabs").tap()
    const sheet = await box(page.getByTestId("remote-browser-tab-sheet"))
    expect(sheet.x).toBeGreaterThanOrEqual(frame.x - 0.5)
    expect(await small()).toEqual([])
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("remote-browser-tab-sheet")).toHaveCount(0)
    // While the browser has its column the list is a drawer: its button opens it over the conversation, the
    // browser stays where it is, and a tap beside it closes it.
    const app = page.getByTestId("app")
    await expect(app).toHaveAttribute("data-sidebar-mode", "drawer")
    await page.getByTestId("sidebar-toggle").tap()
    await expect(app).toHaveAttribute("data-sidebar", "open")
    const list = await box(page.getByTestId("sidebar"))
    expect(list.x).toBe(0)
    expect(list.width).toBeGreaterThanOrEqual(240)
    expect(list.x + list.width).toBeLessThanOrEqual(frame.x)
    await expect(page.getByTestId("session-row").first()).toBeVisible()
    expect(await box(viewer)).toEqual(frame)
    await page.getByTestId("scrim").tap({ position: { x: screen.width - 40, y: 300 } })
    await expect(app).toHaveAttribute("data-sidebar", "closed")
    await expect(viewer).toBeVisible()
    // Left open, it is closed again the next time the browser opens; closing the browser gives the list its column.
    await page.getByTestId("sidebar-toggle").tap()
    await expect(app).toHaveAttribute("data-sidebar", "open")
    await page.getByTestId("scrim").tap({ position: { x: screen.width - 40, y: 300 } })
    await page.getByTestId("remote-browser-close").tap()
    await expect(viewer).toHaveCount(0)
    await expect(app).toHaveAttribute("data-sidebar-mode", "column")
    await expect(app).toHaveAttribute("data-sidebar", "open")
    expect((await box(page.getByTestId("sidebar"))).width).toBe(240)
    return
  }

  // A layer over the whole screen; the conversation stays under it as it was.
  await expect(viewer).toHaveAttribute("data-layout", "layer")
  expect(frame).toEqual({ x: 0, y: 0, width: screen.width, height: screen.height })
  expect((await box(page.getByTestId("remote-browser-bars"))).height).toBeLessThanOrEqual(90)
  // The tab list's targets are thumb sized too.
  await page.getByTestId("remote-browser-tabs").tap()
  await expect(page.getByTestId("remote-browser-tab-sheet")).toBeVisible()
  expect(await small()).toEqual([])
  // The app's back button closes the sheet first, then the layer.
  expect(await page.evaluate(() => window.ownApp?.back())).toBe(true)
  await expect(page.getByTestId("remote-browser-tab-sheet")).toHaveCount(0)
  await expect(viewer).toBeVisible()
  expect(await page.evaluate(() => window.ownApp?.back())).toBe(true)
  await expect(viewer).toHaveCount(0)
  await expect(page.locator("#own-composer-input")).toBeVisible()
  // The conversation under the layer keeps its place: up in it, the layer opened and closed with `←`, same place.
  const scroller = page.locator('[data-testid="transcript-body"] .scroll-view__viewport')
  const bottom = () => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  const view = await box(scroller)
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  await page.mouse.wheel(0, -150)
  await expect.poll(bottom).toBeGreaterThan(100)
  const before = await bottom()
  await openViewer(page)
  await expect(stage(page)).toHaveAttribute("data-screen", "frame")
  await page.getByTestId("remote-browser-close").tap()
  await expect(page.getByTestId("remote-browser")).toHaveCount(0)
  expect(Math.abs((await bottom()) - before)).toBeLessThan(2)

  // With the keyboard up (the S23: 384×420) the bars are one row and the frame keeps the rest.
  await openViewer(page)
  await page.setViewportSize({ width: screen.width, height: info.project.name === "s23" ? 420 : 380 })
  expect((await box(page.getByTestId("remote-browser-bars"))).height).toBeLessThanOrEqual(46)
  await expect(page.getByTestId("remote-browser-address")).toBeVisible()
  await expect(page.getByTestId("remote-browser-close")).toBeVisible()
  expect((await overflow()).viewer).toBeLessThanOrEqual(0.5)
  await page.setViewportSize(screen)
})

test("while the agent operates the page nothing is sent, and 멈추고 직접 조작 takes over", async ({ page, browser }, info) => {
  const pcShell = shell()
  await grant(true)
  // Taken first: the demo turn below runs for about 20 s, and the takeover needs it running.
  const frame = await capture(browser, { width: 800, height: 500 })
  // The desktop app runs, so a conversation made on the phone keeps its browser tools (05 §8.10.5).
  await pcShell.pull([])
  await page.goto("/srv/local/new")
  const input = page.locator("#own-composer-input")
  await input.waitFor({ timeout: 60_000 })
  await input.tap()
  await input.fill("적 스폰 위치를 고쳐 줘")
  // The folder is known (the tool row has its place): a tap 0.1 s after the paint met the row still moving (2026-11-26).
  await expect(page.getByTestId("project-select").first().getByTestId("path-tail")).toContainText("Own OpenCode", {
    timeout: 60_000,
  })
  await page.getByTestId("composer-send").first().tap()
  await page.waitForURL(/\/srv\/local\/s\//, { timeout: 60_000 })
  const sessionID = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!)
  await expect(page.getByTestId("composer-hint")).toHaveText(/멈추려면 \[중단\]/, { timeout: 60_000 })
  await pcShell.pull([sessionID])

  // The agent starts a browser call in this conversation: the hint over the conversation opens the view.
  const agent = (status: string) =>
    fetch(`${world().device}/manual/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: {
          type: "session.tool.progress",
          data: {
            sessionID,
            assistantMessageID: "msg_e2e_browser",
            id: "prt_e2e_browser",
            metadata: { toolCalls: [{ tool: "browser.click", status, input: { tabID: "tab_scores", ref: "e12" } }] },
          },
        },
      }),
    })
  await agent("running")
  const hint = page.getByTestId("remote-browser-hint")
  await expect(hint).toHaveText(/브라우저 사용 중 · 보기/)
  await hint.tap()
  await expect(page.getByTestId("remote-browser")).toBeVisible()
  await pcShell.until([sessionID], (_commands, views) => views.some((view) => view.sessionID === sessionID))
  await pcShell.state(sessionID, pane([SCORES(), DOCS]))
  expect(await pcShell.frame(sessionID, frame)).toEqual({ viewers: 1, acked: true })
  await expect(stage(page)).toHaveAttribute("data-screen", "frame")

  // The agent's line takes the address row's place, with what it is doing and the way to take over.
  const row = page.getByTestId("remote-browser-agent")
  await expect(row).toContainText("에이전트가 조작 중")
  await expect(row).toContainText("클릭 · e12")
  await expect(page.getByTestId("remote-browser-address")).toHaveCount(0)
  await expect(page.getByTestId("remote-browser-row")).toHaveAttribute("data-gate", "agent")
  const takeover = page.getByTestId("remote-browser-takeover")
  await expect(takeover).toHaveText("멈추고 직접 조작")
  if (info.project.name === "s23") {
    // The new conversation's own toasts (a model notice) sit over the bars: closed for the picture.
    // One at a time from the top: a toast that leaves by itself meanwhile left a listed button detached (30 s tap).
    const closes = page.getByTestId("toast").locator("button:last-child")
    await expect(async () => {
      if ((await closes.count()) > 0) await closes.first().tap({ timeout: 2_000 })
      await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 500 })
    }).toPass({ timeout: 30_000 })
    await shot(page, "s23", "05-agent-operating")
  }

  // A finger on the page is not sent; it says how to take control.
  pcShell.take()
  const middle = await at(page, 0.5, 0.5)
  await page.touchscreen.tap(middle.x, middle.y)
  await expect(page.getByTestId("toast").filter({ hasText: "직접 조작하려면 ‘멈추고 직접 조작’을 누르세요" })).toBeVisible()
  // The agent's tab is marked in the tab list, and the list's actions are held back too.
  await page.getByTestId("remote-browser-tabs").tap()
  await expect(page.getByTestId("remote-browser-tab").first().getByRole("img", { name: "에이전트가 쓰는 탭" })).toBeVisible()
  await page.getByTestId("remote-browser-tab").nth(1).locator("button").first().tap()
  await page.waitForTimeout(300)
  await pcShell.pull([sessionID])
  expect(pcShell.take()).toEqual([])

  // 멈추고 직접 조작: the turn is interrupted, the address row is back, and the finger reaches the page.
  await takeover.tap()
  await expect(page.getByTestId("toast").filter({ hasText: "직접 조작 중 · 에이전트를 멈췄어요" })).toBeVisible()
  await expect(page.getByTestId("remote-browser-agent")).toHaveCount(0)
  await expect(page.getByTestId("remote-browser-address")).toBeVisible()
  await expect(page.getByTestId("remote-browser-row")).toHaveAttribute("data-gate", "control")
  await page.touchscreen.tap(middle.x, middle.y)
  const sent = await pcShell.until([sessionID], () => {
    const seen = touches(pcShell.events())
    return seen.some((event) => event.phase === "end") ? seen : undefined
  })
  expect(sent.map((event) => event.phase)).toEqual(["start", "end"])
  await page.getByTestId("remote-browser-close").tap()
  // The turn was interrupted: the composer no longer says how to stop it.
  await expect(page.getByText(/멈추려면 \[중단\]/)).toHaveCount(0, { timeout: 30_000 })
})

test("a conversation that started without the browser tools is turned on from the phone; a view-only device is sent to the PC", async ({
  page,
}, info) => {
  await grant(true)
  // No desktop app on the PC: a conversation made on the phone starts without the browser tools.
  await page.goto("/srv/local/new")
  const input = page.locator("#own-composer-input")
  await input.waitFor({ timeout: 60_000 })
  await input.tap()
  await input.fill("안녕")
  // Once the server made it, the phone writes the approval mode picked on this screen (the composer's
  // `session.approval.set` after the create): a reload before that leaves the conversation without one (`사용자 지정`).
  const approved = page.waitForResponse((answer) => answer.url().includes("/own.accounts/session.approval.set"))
  await page.getByTestId("composer-send").first().tap()
  await page.waitForURL(/\/srv\/local\/s\//, { timeout: 60_000 })
  const sessionID = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!)
  expect((await approved).status()).toBe(200)
  const sockets: string[] = []
  page.on("websocket", (socket) => {
    if (socket.url().includes("/own/browser/")) sockets.push(socket.url())
  })
  const reopen = async () => {
    await page.reload()
    await page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`).waitFor({ timeout: 60_000 })
    await openViewer(page)
    await expect(stage(page)).toHaveAttribute("data-screen", "removed")
    await expect(page.getByTestId("remote-browser-message")).toContainText("이 대화는 브라우저 도구 없이 시작했어요.")
  }

  // A device that may only look (no `prompt`): the switch is the PC's.
  await allow(["read", "browser"])
  await reopen()
  await expect(page.getByTestId("remote-browser-enable-pc")).toHaveText("PC의 데스크톱 앱에서 켜 주세요.")
  await expect(page.getByTestId("remote-browser-enable")).toHaveCount(0)
  expect(sockets).toEqual([])

  // A phone as it is paired by default (`prompt`): it turns the tools on itself, after the note about the cache.
  await grant(true)
  await reopen()
  const enable = page.getByTestId("remote-browser-enable")
  await expect(enable).toHaveText("이 대화에서 켜기")
  await expect(page.getByTestId("remote-browser-enable-pc")).toHaveCount(0)
  expect(sockets).toEqual([])
  if (info.project.name === "s23") await shot(page, "s23", "07-enable")
  await enable.tap()
  await expect(page.getByTestId("remote-browser-message")).toContainText(
    "이 대화의 다음 요청에 도구 목록 문구가 한 번 더해져요. 앞부분 캐시는 유지돼요.",
  )
  await page.getByTestId("remote-browser-enable-apply").tap()
  // The deny is gone from the conversation's rules: the view goes on to the PC, which runs no desktop app here.
  await expect(stage(page)).toHaveAttribute("data-screen", "absent", { timeout: 30_000 })
  expect(sockets).toEqual([`${world().device.replace("http", "ws")}/own/browser/local/${sessionID}`])
  await page.reload()
  await page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`).waitFor({ timeout: 60_000 })
  await openViewer(page)
  await expect(stage(page)).toHaveAttribute("data-screen", "absent")
})

/** A finger from `from` to `to` in `ms`, in even steps, then lifted (as e2e/mobile/swipe.spec.ts moves one). */
async function drag(page: Page, cdp: CDPSession, from: [number, number], to: [number, number], ms = 160) {
  const steps = 10
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] })
  for (let step = 1; step <= steps; step++) {
    const x = from[0] + ((to[0] - from[0]) * step) / steps
    const y = from[1] + ((to[1] - from[1]) * step) / steps
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] })
    await page.waitForTimeout(ms / steps)
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}

/** What a shell swipe would have changed. */
const swiped = (page: Page) =>
  page.getByTestId("app").evaluate((app) => ({
    view: app.dataset.phoneView,
    sidebar: app.dataset.sidebar,
    panel: app.dataset.panel,
    // A gesture in progress draws the list by an inline style and hands it back when it settles.
    drawn: !!(app.querySelector<HTMLElement>(":scope > .own-sidebar")!.getAttribute("style") ?? ""),
  }))

/** A point in the conversation on plain text, near its left edge (not a code block, a button or a field). */
function plainPoint(page: Page) {
  return page.evaluate(() => {
    const view = document
      .querySelector('[data-slot="session-timeline-scroll"] > .scroll-view__viewport')!
      .getBoundingClientRect()
    for (let y = view.top + 20; y < view.bottom - 20; y += 8) {
      const hit = document.elementFromPoint(view.left + 40, y)
      if (hit && !hit.closest("pre, button, textarea, input, a, [role=button]") && hit.closest(".scroll-view__viewport"))
        return [view.left + 40, y] as [number, number]
    }
    throw new Error("no plain point in the conversation")
  })
}

test("the shell's swipes leave the page's touches alone: a drag across the frame goes to the PC and moves nothing here", async ({
  page,
  browser,
}, info) => {
  const sessionID = world().sessions.enemy!
  const pcShell = shell()
  const viewer = await watching(page, browser, pcShell, sessionID)
  await expect(page.locator("html[data-swipe]")).toBeAttached()
  const cdp = await page.context().newCDPSession(page)
  const before = await swiped(page)
  const beside = info.project.name === "fold8-main"
  expect(before).toMatchObject(beside ? { sidebar: "closed", panel: "closed" } : { view: "session" })

  // Right across the frame, as the swipe that opens the conversation list (or its drawer) goes; then left.
  for (const [from, to] of [
    [0.1, 0.9],
    [0.9, 0.1],
  ] as const) {
    pcShell.take()
    const start = await at(page, from, 0.5)
    const end = await at(page, to, 0.52)
    await drag(page, cdp, [start.x, start.y], [end.x, end.y])
    const sent = await pcShell.until([sessionID], () => {
      const seen = touches(pcShell.events())
      return seen.some((event) => event.phase === "end") ? seen : undefined
    })
    expect(sent[0]!.phase).toBe("start")
    expect(sent[0]!.points[0]!.x).toBeCloseTo(from, 1)
    expect(sent.filter((event) => event.phase === "move").at(-1)!.points[0]!.x).toBeCloseTo(to, 1)
    expect(sent.at(-1)).toMatchObject({ phase: "end", points: [] })
    expect(await swiped(page)).toEqual({ ...before, drawn: false })
    await expect(viewer).toBeVisible()
    await expect(stage(page)).toHaveAttribute("data-screen", "frame")
  }
  // A drag that starts on the view's bars is the view's too. A slow one: unlike the frame the bars are not
  // `touch-action: none`, so a flick there leaves Chromium a fling, and a tap soon after only stops it (the `←` below
  // got its touches but no click on the Fold8's cover, 2 runs in 6; 8 in 8 passed with this drag).
  const bars = await box(page.getByTestId("remote-browser-title"))
  await drag(page, cdp, [bars.x + 10, bars.y + bars.height / 2], [bars.x + bars.width - 10, bars.y + bars.height / 2 + 2], 1000)
  expect(await swiped(page)).toEqual({ ...before, drawn: false })
  await expect(viewer).toBeVisible()

  if (beside) {
    // Beside the conversation: the same swipe on the conversation itself opens the list's drawer (the list gave its
    // column to the browser), and a swipe left on the drawer closes it. The work panel over the browser's column
    // closes by a swipe on the panel, never by one that starts in the column.
    const [x, y] = await plainPoint(page)
    await drag(page, cdp, [x, y], [x + 300, y + 4])
    await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "open")
    await drag(page, cdp, [200, y], [20, y + 4])
    await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "closed")
    await page.getByTestId("panel-toggle").tap()
    await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "open")
    const panel = await box(page.getByTestId("panel"))
    await drag(page, cdp, [panel.x + 60, panel.y + 200], [panel.x + panel.width - 20, panel.y + 204])
    await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "closed")
    await expect(viewer).toBeVisible()
    return
  }

  // With the view closed the conversation's own swipe works as before: right opens the conversation list.
  await page.getByTestId("remote-browser-close").tap()
  await expect(viewer).toHaveCount(0)
  const [x, y] = await plainPoint(page)
  await drag(page, cdp, [x, y], [x + page.viewportSize()!.width * 0.7, y + 4])
  await expect.poll(async () => (await swiped(page)).view).toBe("list")
})

test("the view's marks sit in the middle of their buttons", async ({ page, browser }) => {
  const sessionID = world().sessions.hud!
  const pcShell = shell()
  await watching(page, browser, pcShell, sessionID)
  // Toasts sit over the bars on a touch screen.
  await page.evaluate(() => document.querySelectorAll<HTMLElement>(".own-sw-toast-close").forEach((close) => close.click()))
  // Every navigation button enabled: a disabled one is drawn faint.
  await pcShell.state(sessionID, pane([{ ...SCORES(), canGoForward: true }, DOCS]))
  await expect(page.getByTestId("remote-browser-forward")).toBeEnabled()
  await centred(page, page.getByTestId("remote-browser-close"), "←")
  await centred(page, page.getByTestId("remote-browser-tabs"), "tabs")
  await centred(page, page.getByTestId("remote-browser-menu"), "⋯")
  await centred(page, page.getByTestId("remote-browser-back"), "back")
  await centred(page, page.getByTestId("remote-browser-forward"), "forward")
  await centred(page, page.getByTestId("remote-browser-reload"), "reload")
  await centred(page, page.getByTestId("remote-browser-keyboard"), "keyboard")
  // A page that is loading: the same button stops it.
  await pcShell.state(sessionID, pane([{ ...SCORES(), loading: true }, DOCS]))
  await expect(page.getByTestId("remote-browser-reload")).toHaveAccessibleName("멈춤")
  await centred(page, page.getByTestId("remote-browser-reload"), "stop")
  await page.getByTestId("remote-browser-tabs").tap()
  const sheet = page.getByTestId("remote-browser-tab-sheet")
  await centred(page, sheet.locator(".own-rb-sheet-head .own-icon-button"), "sheet ×")
  await centred(page, sheet.getByTestId("remote-browser-tab-close").nth(1), "tab ×")
})

test("the PC's side: 설정 > 휴대폰·다른 PC shows this device's 브라우저 permission", async ({ browser }, info) => {
  test.skip(info.project.name !== "s23", "one picture of the PC's page, for the report")
  await grant(true)
  const context = await browser.newContext({
    baseURL: world().dev,
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: "ko-KR",
    colorScheme: "dark",
  })
  const pcPage = await context.newPage()
  await pcPage.goto("/settings/devices")
  const row = pcPage.locator(`[data-testid="pairing-device"][data-device="${world().browser!.deviceId}"]`)
  await row.waitFor({ timeout: 60_000 })
  await expect(row).toContainText("브라우저")
  await row.getByTestId("pairing-edit").click()
  const toggle = row.getByTestId("pairing-edit-scope-browser")
  await expect(toggle.locator("input")).toBeChecked()
  await row.scrollIntoViewIfNeeded()
  // The demo world's own notices (a retired model of a demo account) would sit over the card in the picture.
  await pcPage.addStyleTag({ content: '[data-testid="toast"] { display: none !important; }' })
  fs.mkdirSync(SHOTS, { recursive: true })
  await pcPage.screenshot({ path: path.join(SHOTS, "pc-08-device-permission.png") })
  // The device's card alone, for the manual's picture (manual 24).
  await row.screenshot({ path: path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "pc-08-device-card.png") })
  await context.close()
})
