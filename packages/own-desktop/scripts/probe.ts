// CDP probe of a running shell (dev or packaged, started with a remote-debugging port): checks the desktop contract
// from inside the renderer and saves screenshots. Used by smoke.ts; also runnable against `bun run dev`:
//
//   bun scripts/probe.ts --cdp http://127.0.0.1:9333 [--service http://127.0.0.1:<port>] [--shots <dir>] [--label dev]
//
// Checks (05 §6.3, §6.4):
//  - own-web mounted in the top frame; window.own.shell.rpcHash is this build's (T0-0);
//  - T0 marks from the desktop host: own:t0:connect (AppAwaitInitialization), own:t0:ready (WindowThemeReady),
//    own:shell-start (T0-6) and own-web's own:first-paint;
//  - an API call from the page carries no Authorization header, yet reaches the service authenticated: CDP shows the
//    page's request headers without it and the wire headers (requestWillBeSentExtraInfo) with the Basic main added.
import { mkdirSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { chromium, type Browser, type Page } from "@playwright/test"
import { RPC_HASH } from "../src/shared/rpc-hash"

export interface ProbeReport {
  readonly url: string
  readonly title: string
  readonly rpcHash: { readonly shell?: string; readonly expected: string; readonly ok: boolean }
  readonly shellVersion?: string
  readonly renderer?: unknown
  readonly marks: Record<string, number>
  readonly app: boolean
  readonly auth?: {
    readonly url: string
    readonly status: number
    readonly pageAuthorization: boolean
    readonly wireAuthorization?: string
    readonly version?: string
  }
  readonly serviceStatus?: unknown
  readonly shots: string[]
}

export async function connect(cdp: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const browser = await chromium.connectOverCDP(cdp, { timeout: 5_000 })
      const page = await rendererPage(browser, deadline)
      return { browser, page }
    } catch (error) {
      if (Date.now() > deadline) throw error
      await Bun.sleep(500)
    }
  }
}

/** The shell's renderer: the page with the preload's `window.own` (browser-pane tabs are pages too, without it). */
async function rendererPage(browser: Browser, deadline: number): Promise<Page> {
  for (;;) {
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      const own = await candidate.evaluate(() => typeof (window as { own?: unknown }).own === "object").catch(() => false)
      if (own) return candidate
    }
    if (Date.now() > deadline) throw new Error("no renderer page")
    await Bun.sleep(250)
  }
}

export async function waitForMarks(page: Page, names: readonly string[], timeoutMs = 30_000) {
  await page.waitForFunction(
    (wanted) => wanted.every((name) => performance.getEntriesByName(name, "mark").length > 0),
    names,
    { timeout: timeoutMs, polling: 250 },
  )
}

/**
 * own:* marks in ms from the renderer's time origin, plus `shellToOrigin`: how long before that origin the shell's
 * main process started (own:shell-start detail.offsetMs, T0-6), so PF1 from process start = sessions-visible + it.
 */
export async function marks(page: Page) {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith("own:"))
    const result: Record<string, number> = Object.fromEntries(
      entries.map((entry) => [entry.name, Math.round(entry.startTime)]),
    )
    const start = entries.find((entry) => entry.name === "own:shell-start") as PerformanceMark | undefined
    const offset = (start?.detail as { offsetMs?: number } | undefined)?.offsetMs
    if (typeof offset === "number") result.shellToOrigin = Math.round(offset)
    return result
  })
}

/** One page-level fetch of /api/info with network capture: page headers vs wire headers. */
export async function authProbe(page: Page, baseUrl: string) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Network.enable")
  const target = new URL("/api/info", baseUrl).toString()
  const seen: { id?: string; pageAuthorization?: boolean; wire?: string; status?: number } = {}
  cdp.on("Network.requestWillBeSent", (event: { requestId: string; request: { url: string; headers: Record<string, string> } }) => {
    if (event.request.url !== target || seen.id) return
    seen.id = event.requestId
    seen.pageAuthorization = Object.keys(event.request.headers).some((key) => key.toLowerCase() === "authorization")
  })
  cdp.on("Network.requestWillBeSentExtraInfo", (event: { requestId: string; headers: Record<string, string> }) => {
    if (event.requestId !== seen.id) return
    const value = Object.entries(event.headers).find(([key]) => key.toLowerCase() === "authorization")?.[1]
    // Scheme and length only: the credential itself is never printed.
    if (value) seen.wire = `${value.split(" ")[0]} (${value.length} chars)`
  })
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "omit" })
    const body = (await response.json().catch(() => ({}))) as { version?: string }
    return { status: response.status, version: body.version }
  }, target)
  await Bun.sleep(300)
  await cdp.detach().catch(() => undefined)
  return {
    url: target,
    status: result.status,
    pageAuthorization: !!seen.pageAuthorization,
    wireAuthorization: seen.wire,
    version: result.version,
  }
}

export async function shot(page: Page, dir: string | undefined, name: string, shots: string[]) {
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
}

export async function probe(
  page: Page,
  options: { readonly shots?: string; readonly label: string; readonly serviceUrl?: string },
): Promise<ProbeReport> {
  const shots: string[] = []
  await page.waitForSelector('[data-testid="app"]', { timeout: 60_000 })
  await waitForMarks(page, ["own:t0:connect", "own:t0:ready", "own:first-paint"])
  const own = await page.evaluate(async () => {
    const value = (window as { own?: { shell: { rpcHash: string; version: string; renderer: Promise<unknown> } } }).own
    return value ? { rpcHash: value.shell.rpcHash, version: value.shell.version, renderer: await value.shell.renderer } : undefined
  })
  const auth = options.serviceUrl ? await authProbe(page, options.serviceUrl) : undefined
  const serviceStatus = await page
    .evaluate(() => (window as { own?: { service: { status(): Promise<unknown> } } }).own?.service.status())
    .catch((error: unknown) => ({ error: String(error) }))
  await Bun.sleep(1_000)
  await shot(page, options.shots, `${options.label}-app`, shots)
  return {
    url: page.url(),
    title: await page.title(),
    rpcHash: { shell: own?.rpcHash, expected: RPC_HASH, ok: own?.rpcHash === RPC_HASH },
    shellVersion: own?.version,
    renderer: own?.renderer,
    marks: await marks(page),
    app: true,
    auth,
    serviceStatus,
    shots,
  }
}

export interface BrowserPaneReport {
  readonly attached: boolean
  readonly tabs: number
  readonly title?: string
  readonly paneTarget?: string
  readonly shots: string[]
}

/**
 * G-D5 (a) smoke: open a session, the 브라우저 tab, a new tab, then navigate it to a page served here (the pane's
 * traffic goes through the service's plugin-browser tunnel, so localhost is the service machine's). The native view is
 * not part of the renderer's screenshot, so its own CDP target is captured too.
 */
export async function browserPaneProbe(page: Page, options: { readonly shots?: string; readonly label: string }) {
  const shots: string[] = []
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        "<!doctype html><title>own smoke page</title><body style='font:24px system-ui;padding:40px;background:#f3f7ff'>" +
          "<h1>own-desktop browser pane</h1><p>Served on the service machine, reached through the plugin-browser tunnel.</p>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
  })
  try {
    await page.locator('[data-testid="session-row"]').first().click()
    const pane = page.locator('[data-testid="browser-pane"]')
    // Ctrl+Shift+B toggles: press it only when the 브라우저 tab is not already showing (layout state persists).
    await Bun.sleep(300)
    if (!(await pane.isVisible())) await page.keyboard.press("Control+Shift+KeyB")
    await pane.waitFor({ timeout: 20_000 })
    // Restored tabs of earlier runs may be there; wait until the new tab exists and is the focused one.
    const before = await page.locator(".own-browser-tab").count()
    await page.locator('[data-testid="browser-new-tab"]').click()
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".own-browser-tab").length > count &&
        (document.querySelector('[data-testid="browser-address"]') as HTMLInputElement | null)?.value === "",
      before,
      { timeout: 20_000, polling: 100 },
    )
    const address = page.locator('[data-testid="browser-address"]')
    await address.fill(`http://127.0.0.1:${site.port}/`)
    await address.press("Enter")
    await page.waitForFunction(
      () => [...document.querySelectorAll(".own-browser-tab-title")].some((node) => node.textContent === "own smoke page"),
      undefined,
      { timeout: 30_000, polling: 250 },
    )
    const attached = (await pane.getAttribute("data-attached")) !== null
    const tabs = await page.locator(".own-browser-tab").count()
    await Bun.sleep(800)
    await shot(page, options.shots, `${options.label}-browser-pane`, shots)
    const view = page
      .context()
      .browser()
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(`http://127.0.0.1:${site.port}`))
    if (view) await shot(view, options.shots, `${options.label}-browser-view`, shots)
    return { attached, tabs, title: "own smoke page", paneTarget: view?.url(), shots } satisfies BrowserPaneReport
  } finally {
    site.stop(true)
  }
}

/** Capability sweep (05 §6.2, 03 §16.7): what the window's host reports and what the UI gates on it. */
export interface CapabilityReport {
  readonly host: unknown
  readonly band: Record<string, unknown>
  readonly dragRegions: Record<string, unknown>
  readonly panelTabs?: unknown
  readonly folderPicker?: unknown
  readonly settings: Record<string, unknown>
  readonly shots: string[]
}

export interface CapabilityProbeOptions {
  readonly shots?: string
  readonly label: string
  /** Whole-window capture (WCO buttons and native views), from smoke.ts. */
  readonly windowShot?: (name: string) => string | undefined
  /** Capture and close the shell's native dialog (#32770), from smoke.ts. */
  readonly nativeDialog?: (name: string) => Promise<unknown>
}

/**
 * - host: a second desktop host over the page's IPC client (the lazily loaded `desktop-*.js` chunk, same module
 *   instances), so adapters can be exercised without UI: capabilities, members, and calls that change nothing on
 *   the machine (open/reveal a missing path, an editor that does not exist, keep-awake state, zoom factor);
 * - band: the title bar band at zoom 100 %, 80 % and 125 % set through own-web's own shortcuts (Ctrl+-/=/0), which
 *   must keep the header on the band's height and out of the window buttons' area;
 * - dragRegions: drag/no-drag of the band's parts and of layers over it (dialog, scrim, modal <dialog>);
 * - panelTabs: the work panel's tabs in the band (ellipsis instead of hidden overflow);
 * - folderPicker: Ctrl+O opens the native folder dialog (nativeDirectoryPicker), captured and cancelled;
 * - settings: the desktop section and the server section's restart button (serviceControl).
 */
export async function capabilityProbe(page: Page, options: CapabilityProbeOptions): Promise<CapabilityReport> {
  const shots: string[] = []
  await page.waitForSelector('[data-testid="app"]', { timeout: 60_000 })
  await waitForMarks(page, ["own:t0:connect", "own:t0:ready"])

  const host = await page.evaluate(async () => {
    const urls = [
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
      ...[...document.querySelectorAll<HTMLLinkElement>("link[rel=modulepreload]")].map((link) => link.href),
    ].filter((url) => /\/desktop-[\w-]+\.js$/.test(url))
    type Files = Record<string, (...args: unknown[]) => unknown>
    type Host = {
      capabilities: unknown
      files?: Files
      service?: unknown
      notify?: unknown
      browser?: unknown
      window?: { zoom?: { get(): Promise<number> }; keepScreenAwake?: { get(): Promise<boolean> } }
    }
    let create: (() => Promise<Host>) | undefined
    for (const url of new Set(urls)) {
      const module = (await import(url)) as { createDesktopHost?: () => Promise<Host> }
      if (typeof module.createDesktopHost === "function") {
        create = module.createDesktopHost
        break
      }
    }
    if (!create) return { error: "desktop host chunk not found", urls }
    const host = await create()
    const attempt = async (run: () => unknown) => {
      try {
        await run()
        return "ok"
      } catch (error) {
        return `rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const missing = `C:\\own-smoke-missing-${Date.now()}\\nothing.txt`
    const files = host.files!
    return {
      capabilities: host.capabilities,
      members: {
        files: Object.keys(files),
        service: !!host.service,
        notify: typeof host.notify,
        browser: !!host.browser,
        zoom: !!host.window?.zoom,
        keepScreenAwake: !!host.window?.keepScreenAwake,
      },
      notificationPermission: typeof Notification === "function" ? Notification.permission : "absent",
      overlayApi: "windowControlsOverlay" in navigator,
      pathForMemoryFile: files.pathForFile!(new File(["x"], "x.txt")),
      openPathMissing: await attempt(() => files.openPath!(missing)),
      openInMissingEditor: await attempt(() => files.openPath!(missing, "own-smoke-no-such-editor")),
      revealPathMissing: await attempt(() => files.revealPath!(missing)),
      keepScreenAwake: await host.window?.keepScreenAwake?.get(),
      zoom: await host.window?.zoom?.get(),
    }
  })

  const band = async () => {
    await Bun.sleep(600)
    return page.evaluate(() => {
      const overlay = (
        navigator as Navigator & { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }
      ).windowControlsOverlay
      const rect = overlay?.getTitlebarAreaRect()
      const header = document.querySelector<HTMLElement>(".own-header")
      const root = document.documentElement
      const headerStyle = header ? getComputedStyle(header) : undefined
      return {
        overlayVisible: overlay?.visible,
        titlebarArea: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        innerWidth,
        devicePixelRatio,
        appWco: !!document.querySelector(".own-app[data-wco]"),
        htmlVisible: root.hasAttribute("data-wco-visible"),
        bandRight: root.style.getPropertyValue("--own-wco-band-right"),
        bandHeight: root.style.getPropertyValue("--own-wco-band-height"),
        headerHeight: header?.getBoundingClientRect().height,
        headerPaddingRight: headerStyle?.paddingRight,
        headerRight: header ? Math.round(header.getBoundingClientRect().right) : undefined,
        layout: (() => {
          const app = document.querySelector<HTMLElement>(".own-app")
          const width = (selector: string) => {
            const element = document.querySelector(selector)
            return element ? Math.round(element.getBoundingClientRect().width) : undefined
          }
          return {
            panelMode: app?.dataset.panelMode,
            panel: app?.dataset.panel,
            sidebarMode: app?.dataset.sidebarMode,
            sidebar: app?.dataset.sidebar,
            columns: app ? getComputedStyle(app).gridTemplateColumns : undefined,
            main: width(".own-main"),
            panelWidth: width(".own-panel"),
            sidebarWidth: width(".own-sidebar"),
          }
        })(),
      }
    })
  }
  const bandReport: Record<string, unknown> = {}
  await page.keyboard.press("Control+Digit0")
  bandReport.zoom100 = await band()
  await page.keyboard.press("Control+Minus")
  await page.keyboard.press("Control+Minus")
  bandReport.zoom80 = await band()
  if (options.windowShot) bandReport.zoom80Window = options.windowShot(`${options.label}-zoom80-window`)
  await page.keyboard.press("Control+Digit0")
  await page.keyboard.press("Control+Equal")
  await page.keyboard.press("Control+Equal")
  bandReport.zoom125 = await band()
  if (options.windowShot) bandReport.zoom125Window = options.windowShot(`${options.label}-zoom125-window`)
  await page.keyboard.press("Control+Digit0")
  bandReport.zoomReset = await band()

  const dragRegions = await page.evaluate(async () => {
    const region = (element: Element | null | undefined) =>
      element ? getComputedStyle(element).getPropertyValue("-webkit-app-region") : undefined
    const header = document.querySelector(".own-header")
    const result: Record<string, unknown> = {
      header: region(header),
      headerButton: region(header?.querySelector("button")),
      sidebarBand: region(document.querySelector('[data-testid="sidebar-band"]')),
      sidebarBandButton: region(document.querySelector('[data-testid="sidebar-band"] button')),
    }
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    const scrim = document.createElement("div")
    scrim.className = "fixed inset-0"
    document.body.append(dialog, scrim)
    result.roleDialog = region(dialog)
    result.scrim = region(scrim)
    dialog.remove()
    scrim.remove()
    const modal = document.createElement("dialog")
    document.body.append(modal)
    modal.showModal()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    result.headerWhileModal = region(header)
    modal.close()
    modal.remove()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    result.headerAfterModal = region(header)
    return result
  })

  // The work panel in the band, on the 브라우저 tab (Ctrl+Shift+B, as browserPaneProbe).
  let panelTabs: unknown
  const tabs = page.locator(".own-panel-head .own-tab")
  if (!(await tabs.first().isVisible().catch(() => false))) await page.keyboard.press("Control+Shift+KeyB")
  if (await tabs
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false)) {
    await Bun.sleep(500)
    panelTabs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".own-panel-head .own-tab")].map((tab) => ({
        label: tab.textContent,
        selected: tab.getAttribute("aria-selected") === "true",
        width: Math.round(tab.getBoundingClientRect().width),
        truncated: tab.scrollWidth > tab.clientWidth,
        textOverflow: getComputedStyle(tab).textOverflow,
        region: getComputedStyle(tab).getPropertyValue("-webkit-app-region"),
      })),
    )
    await shot(page, options.shots, `${options.label}-panel-band`, shots)
    if (options.windowShot) options.windowShot(`${options.label}-panel-band-window`)
  }

  // Ctrl+O: 폴더 열기 → the native picker on a desktop host (the web host opens the in-app folder picker instead).
  let folderPicker: unknown
  if (options.nativeDialog) {
    await page.keyboard.press("Control+KeyO")
    const dialog = await options.nativeDialog(`${options.label}-folder-dialog`)
    await Bun.sleep(500)
    folderPicker = {
      nativeDialog: dialog,
      inAppPicker: await page.locator('[data-testid="folder-picker-layer"]').count(),
    }
  }

  // Settings: 데스크톱 and 서버 연결 (Ctrl+, opens settings).
  const settings: Record<string, unknown> = {}
  await page.keyboard.press("Control+Comma")
  const pageSettings = page.locator('[data-testid="page-settings"]')
  if (await pageSettings.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
    const nav = pageSettings.locator("nav a")
    settings.sections = await nav.allTextContents()
    const desktop = nav.filter({ hasText: "데스크톱" })
    if (await desktop.count()) {
      await desktop.first().click()
      await page.locator('[data-testid="settings-desktop"]').waitFor({ timeout: 10_000 }).catch(() => undefined)
      settings.desktop = await page.locator('[data-testid="settings-desktop"]').innerText().catch(() => undefined)
      await shot(page, options.shots, `${options.label}-settings-desktop`, shots)
    }
    const server = nav.filter({ hasText: "서버 연결" })
    if (await server.count()) {
      await server.first().click()
      await Bun.sleep(800)
      settings.restartButton = await page.getByRole("button", { name: "서비스 다시 시작" }).count()
      settings.copyCommandFallback = await page.getByRole("button", { name: /own restart/ }).count()
      await shot(page, options.shots, `${options.label}-settings-server`, shots)
    }
  }
  return { host, band: bandReport, dragRegions, panelTabs, folderPicker, settings, shots }
}

if (import.meta.main) {
  const args = parseArgs({
    options: {
      cdp: { type: "string" },
      shots: { type: "string" },
      label: { type: "string", default: "probe" },
      service: { type: "string" },
      browser: { type: "boolean", default: false },
    },
  }).values
  if (!args.cdp) throw new Error("--cdp <http://127.0.0.1:port> is required")
  const { browser, page } = await connect(args.cdp)
  try {
    const report = await probe(page, { shots: args.shots, label: args.label!, serviceUrl: args.service })
    const browserPane = args.browser ? await browserPaneProbe(page, { shots: args.shots, label: args.label! }) : undefined
    console.log(JSON.stringify({ ...report, browserPane }, null, 2))
  } finally {
    // Disconnects only: the shell keeps running (connectOverCDP's close does not quit the app).
    await browser.close().catch(() => undefined)
  }
}
