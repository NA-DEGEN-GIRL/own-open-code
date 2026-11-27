// Integrated terminal (03 §18.6, §4.7, §4.7.3, §11, §12 checks 1·6·9 in the terminal) in Edge against the real
// server's PTYs through e2e/terminal/harness.html. Commands are shell-agnostic (`echo`, `exit`): the server starts
// pwsh, Git Bash or cmd on Windows. Screenshots go to $OWN_WEB_SHOTS when it is set.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Locator, type Page, type WebSocket, type WebSocketRoute } from "@playwright/test"
import { csp } from "../../vite/plugins"
import { backend, watchErrors } from "../support"

interface HarnessWindow {
  __terminalHarness: {
    log: string[]
    setVisible(value: boolean): void
    setWidth(value: number): void
    navigate(sessionID: string): void
    collapsed(): boolean
  }
  __raf: number
  __intervals: Set<number>
  __csp: string[]
  __connections: string[]
}

const SHOTS = process.env.OWN_WEB_SHOTS

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `terminal-${name}.png`) })
}

/** Sockets the page opened to PTYs, with every frame it sent (terminal input). */
function recordSockets(page: Page) {
  const sockets: { url: URL; sent: string[]; socket: WebSocket }[] = []
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/pty/")) return
    const entry = { url: new URL(socket.url()), sent: [] as string[], socket }
    socket.on("framesent", (frame) =>
      entry.sent.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8")),
    )
    sockets.push(entry)
  })
  return sockets
}

async function open(page: Page, query: string) {
  await page.goto(`/e2e/terminal/harness.html?${query}`)
  const view = visibleView(page)
  await expect(view).toHaveAttribute("data-connection", "ready")
  return view
}

const visibleView = (page: Page) => page.locator('[data-testid="terminal-view"]:visible')

/**
 * A new terminal for this test (`+`): the workspace's PTYs outlive a test, so typing into a shared shell would carry
 * its state (input line, last exit status) from one test into the next.
 */
async function fresh(page: Page) {
  const previous = await visibleView(page).getAttribute("data-pty")
  await page.getByTestId("terminal-new").click()
  const view = visibleView(page)
  await expect(view).not.toHaveAttribute("data-pty", previous ?? "")
  await expect(view).toHaveAttribute("data-connection", "ready")
  return view
}

/** `출력을 텍스트로 보기` (03 §11) is also how tests read the screen. */
async function screenText(page: Page) {
  const button = page.getByTestId("terminal-view-text")
  await button.click()
  const text = await page.getByTestId("terminal-text").locator("pre").innerText()
  await button.click()
  return text
}

const count = (text: string, needle: string) => text.split(needle).length - 1

async function focusTerminal(view: Locator) {
  await view.locator(".own-terminal-screen canvas").click()
  await expect(view.locator("textarea")).toBeFocused()
}

/**
 * The shell has printed its prompt and the screen stopped changing. A PTY resize right after connecting makes ConPTY
 * repaint, and keys typed during that repaint can be lost (Git Bash dropped the first letter), as they would be for a
 * person typing within milliseconds of opening the tab.
 */
async function settle(page: Page) {
  const last = { text: "" }
  await expect
    .poll(
      async () => {
        const text = await screenText(page)
        const stable = text.trim() !== "" && text === last.text
        last.text = text
        return stable
      },
      { intervals: [250], timeout: 20_000 },
    )
    .toBe(true)
}

async function run(page: Page, view: Locator, command: string) {
  await settle(page)
  await focusTerminal(view)
  await page.keyboard.type(command)
  await page.keyboard.press("Enter")
}

/** The command line and its output: `needle` appears at least `times` times. */
async function waitForOutput(page: Page, needle: string, times = 2) {
  await expect
    .poll(async () => count(await screenText(page), needle), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(times)
}

async function serverPtys(page: Page, directory: string) {
  return page.evaluate(async (dir) => {
    const response = await fetch(`/api/pty?location%5Bdirectory%5D=${encodeURIComponent(dir)}`)
    const body = (await response.json()) as { data: { id: string; status: string }[] }
    return body.data
  }, directory)
}

const harness = (page: Page) => ({
  log: () => page.evaluate(() => (window as unknown as HarnessWindow).__terminalHarness.log),
  setVisible: (value: boolean) =>
    page.evaluate((next) => (window as unknown as HarnessWindow).__terminalHarness.setVisible(next), value),
  setWidth: (value: number) =>
    page.evaluate((next) => (window as unknown as HarnessWindow).__terminalHarness.setWidth(next), value),
  navigate: (sessionID: string) =>
    page.evaluate((next) => (window as unknown as HarnessWindow).__terminalHarness.navigate(next), sessionID),
})

test.describe("integrated terminal (18.6)", () => {
  test("opens a PTY in the session's folder over a ticket WebSocket and runs a command", async ({ page }) => {
    const state = backend()
    const errors = watchErrors(page)
    const sockets = recordSockets(page)
    const tickets: Record<string, string>[] = []
    page.on("request", (request) => {
      if (request.url().includes("/connect-token")) tickets.push(request.headers())
    })
    const view = await open(page, `session=${state.sessions[0]!.id}`)

    // Tab label `셸 이름 · 폴더` (the backend's workspace folder).
    const tab = page.locator('[data-testid="terminal-tab"][aria-selected="true"]')
    await expect(tab).toHaveCount(1)
    await expect(tab).toContainText(` · ${path.basename(state.workspace)}`)
    await expect(tab).toHaveAttribute("id", `own-terminal-tab-${await view.getAttribute("data-pty")}`)

    // T2 (03 §20.1): panel mounted → first terminal painted (ghostty-web chunk + wasm + PTY). Dev-server numbers
    // are an upper bound; the gate is the production bench.
    const t2 = await page.evaluate(() => {
      const mark = (name: string) => performance.getEntriesByName(name, "mark")[0]?.startTime ?? Number.NaN
      return mark("own:panel-open:terminal-ready") - mark("own:panel-open:terminal")
    })
    console.log(`T2 terminal (dev server): ${Math.round(t2)} ms`)
    expect(t2).toBeGreaterThan(0)

    await run(page, view, "echo own-terminal-ok")
    await waitForOutput(page, "own-terminal-ok")
    await shot(page, "tab")

    // Ticket auth (01 §6.1): the socket URL carries a single-use ticket and the location, nothing else.
    expect(sockets).toHaveLength(1)
    const url = sockets[0]!.url
    expect([...url.searchParams.keys()].sort()).toEqual(["location[directory]", "ticket"])
    expect(url.searchParams.get("location[directory]")).toBe(state.workspace)
    expect(tickets[0]?.["x-opencode-ticket"]).toBe("1")
    expect(sockets[0]!.sent.join("")).toContain("echo own-terminal-ok\r")

    // The canvas is not readable, so the view says so and names the terminal (03 §11).
    await expect(view.locator(".own-terminal-screen")).toHaveAttribute("aria-label", /^터미널 /)
    await expect(view.locator(".own-sr-only")).toContainText("출력을 텍스트로 보기")
    expect(errors).toEqual([])
  })

  test("switching sessions in the same project keeps the same terminal and socket", async ({ page }) => {
    const state = backend()
    const sockets = recordSockets(page)
    const view = await open(page, `session=${state.sessions[0]!.id}`)
    const id = await view.getAttribute("data-pty")
    await harness(page).navigate(state.sessions[1]!.id)
    await expect(page.getByTestId("route")).toHaveText(state.sessions[1]!.id)
    await expect(visibleView(page)).toHaveAttribute("data-pty", id!)
    await page.waitForTimeout(300)
    expect(sockets.filter((entry) => !entry.socket.isClosed())).toHaveLength(1)
  })

  test("resizing the panel resizes the PTY with one request per change", async ({ page }) => {
    const state = backend()
    const sizes: { cols: number; rows: number }[] = []
    page.on("request", (request) => {
      if (request.method() !== "PUT" || !/\/api\/pty\/pty[^/?]*\?/.test(request.url())) return
      const body = request.postDataJSON() as { size?: { cols: number; rows: number } }
      if (body.size) sizes.push(body.size)
    })
    await open(page, `dir=${encodeURIComponent(state.workspace)}`)
    await expect.poll(() => sizes.length).toBeGreaterThan(0)
    const first = sizes.at(-1)!
    await harness(page).setWidth(900)
    await expect.poll(() => sizes.at(-1)?.cols ?? 0).toBeGreaterThan(first.cols)
    const settled = sizes.length
    await page.waitForTimeout(400)
    // Nothing more once the size is stable (the fit runs per frame; the request only when cols/rows change).
    expect(sizes.length).toBe(settled)
    const pairs = sizes.map((size) => `${size.cols}x${size.rows}`)
    expect(pairs.filter((pair, index) => pair === pairs[index - 1])).toEqual([])
  })

  test("a dropped socket shows the reconnect band and resumes from the cursor, keeping the scrollback", async ({
    page,
  }) => {
    const state = backend()
    const errors = watchErrors(page)
    const routes: { client: WebSocketRoute; server: WebSocketRoute }[] = []
    await page.routeWebSocket(/\/api\/pty\/[^/]+\/connect/, (client) => {
      routes.push({ client, server: client.connectToServer() })
    })
    await open(page, `session=${state.sessions[0]!.id}`)
    const view = await fresh(page)
    const opened = routes.length
    await run(page, view, "echo before-drop")
    await waitForOutput(page, "before-drop")
    const before = count(await screenText(page), "before-drop")
    await view.evaluate((element) => {
      const log: string[] = []
      ;(window as unknown as HarnessWindow).__connections = log
      new MutationObserver(() => log.push(element.getAttribute("data-connection") ?? "")).observe(element, {
        attributes: true,
        attributeFilter: ["data-connection"],
      })
      new MutationObserver(() => {
        const band = element.querySelector('[data-testid="terminal-band"]')
        if (band) log.push(`band:${band.textContent}`)
      }).observe(element, { childList: true, subtree: true, characterData: true })
    })

    // The band overlays the screen: a disconnect must not resize the PTY (ConPTY repaints and can drop keys).
    const resizes: string[] = []
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().includes("/api/pty/")) resizes.push(request.url())
    })
    const live = routes[opened - 1]!
    await live.client.close({ code: 4000, reason: "e2e drop" })
    await live.server.close()
    await expect.poll(() => routes.length).toBe(opened + 1)
    await expect(view).toHaveAttribute("data-connection", "ready")
    const log = await page.evaluate(() => (window as unknown as HarnessWindow).__connections)
    expect(log).toContain("reconnecting")
    expect(log).toContain("band:터미널 다시 연결 중…")
    expect(log.at(-1)).toBe("ready")
    await expect(page.getByTestId("terminal-band")).toHaveCount(0)
    expect(resizes).toEqual([])

    // Resumed after the output already shown: no replayed duplicates, and the scrollback is still there.
    expect(new URL(routes[opened]!.client.url()).searchParams.get("cursor")).toMatch(/^\d+$/)
    expect(count(await screenText(page), "before-drop")).toBe(before)
    await run(page, view, "echo after-drop")
    await waitForOutput(page, "after-drop")
    expect(count(await screenText(page), "before-drop")).toBe(before)
    expect(errors).toEqual([])
  })

  test("exit shows 종료됨 (exit 0); 다시 시작 opens a new shell in the same tab and removes the old PTY", async ({
    page,
  }) => {
    const state = backend()
    const errors = watchErrors(page)
    await open(page, `session=${state.sessions[0]!.id}`)
    const view = await fresh(page)
    const old = (await view.getAttribute("data-pty"))!
    const tab = page.locator('[data-testid="terminal-tab"][aria-selected="true"]')
    await run(page, view, "exit")
    const band = page.getByTestId("terminal-band")
    await expect(band).toContainText("종료됨 (exit 0)")
    await expect(tab).toHaveAttribute("data-status", "exited")
    await shot(page, "exited")

    const tabs = await page.getByTestId("terminal-tab").count()
    await band.getByRole("button", { name: "다시 시작" }).click()
    await expect(visibleView(page)).not.toHaveAttribute("data-pty", old)
    const restarted = visibleView(page)
    await expect(restarted).toHaveAttribute("data-connection", "ready")
    await expect(page.getByTestId("terminal-tab")).toHaveCount(tabs)
    await expect(tab).toHaveAttribute("data-status", "running")
    await run(page, restarted, "echo restarted-ok")
    await waitForOutput(page, "restarted-ok")
    expect((await serverPtys(page, state.workspace)).map((pty) => pty.id)).not.toContain(old)
    expect(errors).toEqual([])
  })

  test("a PTY ending with a Windows NTSTATUS code shows it in hex, and the folder still lists its PTYs", async ({
    page,
  }) => {
    test.skip(process.platform !== "win32", "Windows exit codes")
    const state = backend()
    const errors = watchErrors(page)
    await open(page, `session=${state.sessions[0]!.id}`)
    // Through the API, so the PTY's own process ends with 0xC0000005 (what a crashed program leaves), which bun-pty
    // reports as -1073741819. Core keeps the unsigned code (P-033); the negative one made `GET /api/pty` answer 400.
    const id = await page.evaluate(async (dir) => {
      const response = await fetch(`/api/pty?location%5Bdirectory%5D=${encodeURIComponent(dir)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "cmd.exe", args: ["/d", "/c", "exit -1073741819"] }),
      })
      return ((await response.json()) as { data: { id: string } }).data.id
    }, state.workspace)
    await expect
      .poll(async () => (await serverPtys(page, state.workspace)).find((pty) => pty.id === id)?.status)
      .toBe("exited")

    // A new page lists the folder's PTYs again and shows the exit in the Windows form.
    await page.reload()
    const tab = page.locator(`#own-terminal-tab-${id}`)
    await tab.click()
    await expect(tab).toHaveAttribute("data-status", "exited")
    await expect(
      page.locator(`[data-testid="terminal-view"][data-pty="${id}"]`).getByTestId("terminal-band"),
    ).toContainText("종료됨 (exit 0xC0000005)")
    await shot(page, "exited-ntstatus")
    const removed = await page.evaluate(
      async ({ id, dir }) =>
        (await fetch(`/api/pty/${id}?location%5Bdirectory%5D=${encodeURIComponent(dir)}`, { method: "DELETE" })).status,
      { id, dir: state.workspace },
    )
    expect(removed).toBe(204)
    expect(errors).toEqual([])
  })

  test("a PTY removed elsewhere (another window, the API) leaves the tabs through pty.deleted", async ({ page }) => {
    const state = backend()
    await open(page, `dir=${encodeURIComponent(state.workspace)}`)
    const tabs = page.getByTestId("terminal-tab")
    const previous = await visibleView(page).getAttribute("data-pty")
    const count = (await tabs.count()) + 1
    await page.getByTestId("terminal-new").click()
    await expect(tabs).toHaveCount(count)
    const view = visibleView(page)
    await expect(view).not.toHaveAttribute("data-pty", previous!)
    await expect(view).toHaveAttribute("data-connection", "ready")
    const id = (await view.getAttribute("data-pty"))!
    const status = await page.evaluate(
      async ({ id, dir }) =>
        (await fetch(`/api/pty/${id}?location%5Bdirectory%5D=${encodeURIComponent(dir)}`, { method: "DELETE" })).status,
      { id, dir: state.workspace },
    )
    expect(status).toBe(204)
    await expect(tabs).toHaveCount(count - 1)
    await expect(page.locator(`[data-testid="terminal-view"][data-pty="${id}"]`)).toHaveCount(0)
  })

  test("follows the theme: the canvas takes the own tokens of the light and dark schemes", async ({ page }) => {
    const state = backend()
    const view = await open(page, `session=${state.sessions[0]!.id}`)
    await settle(page)
    const sample = () =>
      view.evaluate((element) => {
        const canvas = element.querySelector("canvas")!
        const pixel = canvas.getContext("2d")!.getImageData(1, 1, 1, 1).data
        const screen = getComputedStyle(element.querySelector(".own-terminal-screen")!).backgroundColor
        return { pixel: `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`, screen }
      })
    const light = await sample()
    expect(light.pixel).toBe(light.screen)
    await page.evaluate(() => (document.documentElement.dataset.colorScheme = "dark"))
    await expect.poll(async () => (await sample()).pixel).not.toBe(light.pixel)
    const dark = await sample()
    expect(dark.pixel).toBe(dark.screen)
    await shot(page, "dark")
  })

  test("tabs: new terminal, shell choice (▾), keyboard switching and close", async ({ page }) => {
    const state = backend()
    await open(page, `dir=${encodeURIComponent(state.workspace)}`)
    const tabs = page.getByTestId("terminal-tab")
    const existing = await tabs.count()
    await page.getByTestId("terminal-new").click()
    await expect(tabs).toHaveCount(existing + 1)
    await expect(tabs.last()).toHaveAttribute("aria-selected", "true")
    await expect(visibleView(page)).toHaveAttribute("data-connection", "ready")

    // ▾ lists the shells the server found (GET /api/config/shell) for this one terminal.
    await page.getByTestId("terminal-shells").click()
    const options = page.getByTestId("terminal-shell-option")
    await expect(options.first()).toBeVisible()
    await expect(page.getByRole("menuitem").first()).toBeFocused()
    const name = (await options.first().locator("span").first().innerText()).trim()
    await shot(page, "shell-menu")
    await options.first().click()
    await expect(tabs).toHaveCount(existing + 2)
    await expect(tabs.last()).toContainText(name)
    await expect(visibleView(page)).toHaveAttribute("data-connection", "ready")

    // Arrow keys move between tabs (tablist).
    await tabs.last().focus()
    await page.keyboard.press("ArrowLeft")
    await expect(tabs.nth(existing)).toHaveAttribute("aria-selected", "true")
    await expect(tabs.nth(existing)).toBeFocused()

    // ✕ closes the tab and removes the PTY on the server.
    const closing = (await visibleView(page).getAttribute("data-pty"))!
    await page.getByTestId("terminal-close").nth(existing).click()
    await expect(tabs).toHaveCount(existing + 1)
    await expect.poll(async () => (await serverPtys(page, state.workspace)).map((pty) => pty.id)).not.toContain(closing)
  })

  test("own-web shortcuts that stay live in a terminal run there; the rest go to the shell (03 §10)", async ({
    page,
  }) => {
    const state = backend()
    const sockets = recordSockets(page)
    await open(page, `session=${state.sessions[0]!.id}`)
    const view = await fresh(page)
    await settle(page)
    await focusTerminal(view)
    const sent = () => sockets.flatMap((entry) => entry.sent).join("")
    const start = sent().length
    await page.keyboard.press("Control+KeyK")
    await page.keyboard.press("Control+KeyB")
    await expect.poll(() => sent().slice(start)).toContain("\x02")
    const log = await harness(page).log()
    expect(log).toContain("palette.open")
    expect(log).not.toContain("sidebar.toggle")
    expect(sent().slice(start)).not.toContain("\x0b")
  })

  test("a hidden terminal stops drawing and its cursor blinks only while focused (4.7, PF8)", async ({ page }) => {
    const state = backend()
    await page.addInitScript(() => {
      const target = window as unknown as HarnessWindow
      const raf = window.requestAnimationFrame.bind(window)
      target.__raf = 0
      window.requestAnimationFrame = (callback) =>
        raf((time) => {
          target.__raf += 1
          callback(time)
        })
      target.__intervals = new Set()
      const set = window.setInterval.bind(window)
      const clear = window.clearInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
        const id = set(handler, timeout, ...rest)
        target.__intervals.add(id)
        return id
      }) as typeof window.setInterval
      window.clearInterval = ((id?: number) => {
        if (id !== undefined) target.__intervals.delete(id)
        clear(id)
      }) as typeof window.clearInterval
    })
    const view = await open(page, `session=${state.sessions[0]!.id}`)
    const frames = async () => {
      const before = await page.evaluate(() => (window as unknown as HarnessWindow).__raf)
      await page.waitForTimeout(500)
      return (await page.evaluate(() => (window as unknown as HarnessWindow).__raf)) - before
    }
    const intervals = () => page.evaluate(() => (window as unknown as HarnessWindow).__intervals.size)

    expect(await frames()).toBeGreaterThan(10)
    await page.getByTestId("composer").focus()
    const idle = await intervals()
    await focusTerminal(view)
    await expect.poll(intervals).toBe(idle + 1)
    await page.getByTestId("composer").focus()
    await expect.poll(intervals).toBe(idle)

    await harness(page).setVisible(false)
    await page.waitForTimeout(100)
    expect(await frames()).toBeLessThanOrEqual(2)
    await harness(page).setVisible(true)
    expect(await frames()).toBeGreaterThan(10)
  })

  test("works under the production CSP: the wasm comes from a same-origin URL, never a data: fetch", async ({
    page,
  }) => {
    const state = backend()
    const errors = watchErrors(page)
    await page.addInitScript(() => {
      const target = window as unknown as HarnessWindow
      target.__csp = []
      document.addEventListener("securitypolicyviolation", (event) =>
        target.__csp.push(`${event.violatedDirective} ${event.blockedURI}`),
      )
    })
    const wasm: string[] = []
    page.on("request", (request) => {
      if (request.url().includes(".wasm")) wasm.push(request.url())
    })
    await page.goto(`/e2e/terminal/csp.html?session=${state.sessions[0]!.id}`)
    // csp.html carries a copy of the production policy; it must not drift from vite/plugins.ts.
    expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")).toBe(
      csp("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="),
    )
    await expect(visibleView(page)).toHaveAttribute("data-connection", "ready")
    const view = await fresh(page)
    await run(page, view, "echo csp-ok")
    await waitForOutput(page, "csp-ok")
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__csp)).toEqual([])
    expect(wasm.length).toBeGreaterThan(0)
    expect(wasm.every((url) => url.startsWith(state.dev))).toBe(true)
    expect(errors).toEqual([])
  })
})

test.describe("Korean IME in the terminal (03 §12 checks 1·6·9)", () => {
  async function composing(page: Page) {
    const state = backend()
    const sockets = recordSockets(page)
    await open(page, `session=${state.sessions[0]!.id}`)
    const view = await fresh(page)
    await settle(page)
    await focusTerminal(view)
    const cdp = await page.context().newCDPSession(page)
    const mark = { at: 0 }
    const sent = () => sockets.flatMap((entry) => entry.sent).join("")
    return {
      view,
      reset: () => (mark.at = sent().length),
      input: () => sent().slice(mark.at),
      compose: async (steps: string[]) => {
        for (const text of steps)
          await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length })
      },
      commit: (text: string) => cdp.send("Input.insertText", { text }),
      key: (type: "rawKeyDown" | "keyUp", code: number) =>
        cdp.send("Input.dispatchKeyEvent", {
          type,
          key: code === 229 ? "Process" : "Enter",
          code: "Enter",
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
        }),
    }
  }

  test("check 1: Enter during composition sends the syllables once, then one Enter (A1); A2 commits only", async ({
    page,
  }) => {
    const ime = await composing(page)
    // A1: keydown(229) → compositionend → keydown(13): text once, Enter once.
    ime.reset()
    await ime.compose(["ㅇ", "아", "안", "안ㄴ", "안녀", "안녕"])
    await ime.key("rawKeyDown", 229)
    await ime.commit("안녕")
    await ime.key("rawKeyDown", 13)
    await ime.key("keyUp", 13)
    await expect.poll(ime.input).toBe("안녕\r")
    await page.waitForTimeout(150)
    expect(ime.input()).toBe("안녕\r")

    // A2: the IME consumed the Enter (as when it picks a Hanja candidate): the text once, no Enter.
    ime.reset()
    await ime.compose(["ㅎ", "하", "한"])
    await ime.key("rawKeyDown", 229)
    await ime.commit("한")
    await ime.key("keyUp", 13)
    await expect.poll(ime.input).toBe("한")
    await page.waitForTimeout(150)
    expect(ime.input()).toBe("한")
  })

  test("check 6: Korean and ASCII mixed (`한글 abc`) reaches the shell and prints", async ({ page }) => {
    const ime = await composing(page)
    ime.reset()
    // Quoted: pwsh's echo prints each bare word on a line of its own.
    await page.keyboard.type('echo "')
    await ime.compose(["ㅎ", "하", "한"])
    await ime.commit("한")
    await ime.compose(["ㄱ", "그", "글"])
    await ime.commit("글")
    await page.keyboard.type(' abc"')
    await expect.poll(ime.input).toBe('echo "한글 abc"')
    await page.keyboard.press("Enter")
    // The printed line, not the count of both lines: pwsh's line editor redraws the typed line after the wide syllables
    // and, depending on the prompt's column, can leave `echo "한글abc"` on the screen (the shell still got `한글 abc`; the
    // run under a short temp path lost the space on 4 of 4 runs, a long one never). The input is checked above.
    await expect
      .poll(async () => (await screenText(page)).split(/\r?\n/).some((line) => line.trim() === "한글 abc"), {
        timeout: 20_000,
      })
      .toBe(true)
    await shot(page, "ime")
  })

  test("check 9: a Hanja conversion commits the converted character once", async ({ page }) => {
    const ime = await composing(page)
    ime.reset()
    await ime.compose(["ㅎ", "하", "한", "韓"])
    await ime.commit("韓")
    await expect.poll(ime.input).toBe("韓")
    await page.waitForTimeout(150)
    expect(ime.input()).toBe("韓")
  })
})

test.describe("bottom dock (4.7.3)", () => {
  test("sits under the composer at 30 %, resizes between 160 px and 70 % and collapses", async ({ page }) => {
    const state = backend()
    await page.goto("/e2e/terminal/harness.html")
    await page.evaluate(() => localStorage.removeItem("own.web.terminal.dockHeight"))
    await open(page, `session=${state.sessions[0]!.id}&placement=dock`)
    const dock = page.getByTestId("terminal-dock")
    const composer = page.getByTestId("composer")
    const box = async (locator: Locator) => (await locator.boundingBox())!
    const column = (await box(page.locator("main"))).height
    expect((await box(dock)).y).toBeGreaterThan((await box(composer)).y)
    expect(Math.abs((await box(dock)).height - column * 0.3)).toBeLessThan(24)

    // Keyboard: the separator moves by 24 px; the height is remembered for the window.
    const handle = dock.getByRole("separator")
    await handle.focus()
    const start = Math.round((await box(dock)).height)
    await page.keyboard.press("ArrowUp")
    await expect.poll(async () => Math.abs((await box(dock)).height - (start + 24))).toBeLessThanOrEqual(1)
    const saved = Number(await page.evaluate(() => localStorage.getItem("own.web.terminal.dockHeight")))
    expect(Math.abs(saved - (start + 24))).toBeLessThanOrEqual(1)

    // Mouse: dragging up stops at 70 % of the column.
    const grip = await box(handle)
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2, 5, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await box(dock)).height).toBeLessThanOrEqual(column * 0.7 + 1)
    expect((await box(dock)).height).toBeGreaterThan(column * 0.6)
    await expect(visibleView(page)).toHaveAttribute("data-connection", "ready")
    await shot(page, "dock")

    await page.getByTestId("terminal-dock-collapse").click()
    await expect(dock).toHaveCount(0)
  })
})
