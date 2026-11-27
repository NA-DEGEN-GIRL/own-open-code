// Groups D and B: the desktop shell's own screens (PLAN.md §5.2), 모바일 미리보기 (24장) and the native browser pane
// (19장). The shell runs unpackaged (`electron-vite dev` in packages/own-desktop, like its scripts/dev.ts) with every
// state folder in a temp root (OPENCODE_DESKTOP_TEST_ROOT: userData and session; XDG_STATE_HOME: the registration it
// discovers) and a demo service's Vite dev server as its renderer:
//   - D: own-web's gateway e2e backend (the real service with own-remote's gateway and app connection on loopback, fake
//     provider, the account `Alpha`) for the preview device and its window;
//   - B: this manual's main demo world, whose scripted model drives the browser pane on a scoreboard page the demo
//     backend serves (open, click, wait, download).
// Pages are driven over the shell's CDP port. The pane's page is a native view, so those shots are window captures
// (PrintWindow, as own-desktop's capture-window.ps1 does), with the numbered boxes on the shell's own parts around it.
// The shell's windows stay off the screen and the taskbar (own-shell.ts `OWN_DESKTOP_TEST_RUN`, which also ends the
// shell when this run is gone), with Windows' occlusion tracking off so they still paint for PrintWindow, like
// own-desktop's scripts/split-panes.ts.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { electronExe } from "../../../../packages/own-desktop/scripts/electron-path"
import { privacyProblems, REPO, type Browser, type Locator, type Page } from "../lib/browser"
import type { Ctx, Shot } from "../lib/ctx"
import { initScript, type Mapping } from "../lib/privacy"
import { markPage } from "../lib/shoot"
import { checkoutTmp, start, type World } from "../lib/world"
import { gatewayPaths, type GatewayState } from "./gateway"
import { mainPaths, type MainState } from "./main"

const DESKTOP = path.join(REPO, "packages/own-desktop")
const CDP_PORT = 6352

export interface Shell {
  readonly cdp: string
  readonly shellPid: number
  readonly pairs: ReadonlyArray<Mapping>
  readonly root: string
}

export type DesktopState = GatewayState & Shell
export type PaneState = MainState & Shell

/** A demo service as the shell sees it: its URL and password, OWN_HOME and own-web's dev server. */
export interface Service {
  readonly url: string
  readonly password: string
  readonly ownHome: string
  readonly dev: string
}

/** Starts the shell against `service` (its registration in a temp state home); `stop` takes the process tree down. */
export async function launchShell(service: Service, port = CDP_PORT) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-manual-desktop-"))
  const stateHome = path.join(root, "state")
  // The registration the shell discovers (the CLI's shape: packages/client service.ts Info).
  const authorization = `Basic ${btoa(`opencode:${service.password}`)}`
  const info = (await (await fetch(new URL("/api/info", service.url), { headers: { authorization } })).json()) as {
    version: string
    pid: number
  }
  await fs.mkdir(path.join(stateHome, "opencode"), { recursive: true })
  await Bun.write(
    path.join(stateHome, "opencode", "service-local.json"),
    JSON.stringify({
      id: `own-manual-${process.pid}`,
      version: info.version,
      url: service.url,
      pid: info.pid,
      password: service.password,
    }),
  )
  await fs.mkdir(path.join(root, "desktop"), { recursive: true })
  const log = Bun.file(path.join(os.tmpdir(), "manual-desktop-shell.log")).writer()
  const shell = Bun.spawn(
    [process.execPath, "x", "electron-vite", "dev", "--", "--disable-features=CalculateNativeWinOcclusion"],
    {
      cwd: DESKTOP,
      env: {
        ...process.env,
        OWN_DESKTOP_CHANNEL: "local",
        ELECTRON_EXEC_PATH: electronExe(),
        ELECTRON_RENDERER_URL: service.dev,
        XDG_STATE_HOME: stateHome,
        OWN_HOME: service.ownHome,
        OPENCODE_DESKTOP_TEST_ROOT: path.join(root, "desktop"),
        OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(port),
        OWN_DESKTOP_TEST_RUN: String(process.pid),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) log.write(chunk)
  }
  void pump(shell.stdout)
  void pump(shell.stderr)
  return {
    cdp: `http://127.0.0.1:${port}`,
    shellPid: shell.pid,
    root,
    stop: async () => {
      await Bun.spawn(["taskkill", "/PID", String(shell.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
        .exited
      await log.end()
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
    },
  }
}

export async function bootDesktop(): Promise<World<DesktopState>> {
  const gateway = await start<GatewayState & { serverUrl: string; localPassword: string }>(
    "desktop-gateway",
    {
      script: "e2e/gateway/backend.ts",
      env: { OWN_WEB_E2E_GATEWAY_PORT: "6351", OWN_WEB_E2E_GATEWAY_REMOTE: "0" },
      ready: "OWN_WEB_E2E_GATEWAY_READY",
      file: path.join(checkoutTmp("own-web-e2e-gateway"), "backend.json"),
    },
    gatewayPaths,
  )
  const shell = await launchShell({
    url: gateway.state.serverUrl,
    password: gateway.state.localPassword,
    ownHome: gateway.state.ownHome,
    dev: gateway.state.dev,
  })
  return {
    state: { ...gateway.state, ...shell, pairs: gateway.pairs },
    pairs: gateway.pairs,
    stop: async () => {
      await shell.stop()
      await gateway.stop()
    },
  }
}

export async function bootPane(): Promise<World<PaneState>> {
  const main = await start<MainState & { server: { url: string; password: string }; ownHome: string }>(
    "pane",
    {
      script: "e2e/manual/backend.ts",
      env: { OWN_MANUAL_WORLD: "main", OWN_MANUAL_PORT: "6361" },
      ready: "OWN_MANUAL_READY",
    },
    mainPaths,
  )
  const shell = await launchShell({
    url: main.state.server.url,
    password: main.state.server.password,
    ownHome: main.state.ownHome,
    dev: main.state.dev,
  })
  return {
    state: { ...main.state, ...shell, pairs: main.pairs },
    pairs: main.pairs,
    stop: async () => {
      await shell.stop()
      await main.stop()
    },
  }
}

const playwright = createRequire(path.join(REPO, "packages/own-web/package.json"))("@playwright/test") as {
  readonly chromium: { connectOverCDP(url: string, options?: { timeout?: number }): Promise<Browser> }
}

/** The shell over CDP: its main window's renderer page (the one with the preload's `window.own`), privacy on. */
const story: { browser?: Browser; main?: Page; cdp?: string } = {}

async function shellPage(state: Shell) {
  if (story.main && story.cdp === state.cdp && !story.main.isClosed()) return story.main
  const deadline = Date.now() + 240_000
  for (;;) {
    const browser = await playwright.chromium.connectOverCDP(state.cdp, { timeout: 5_000 }).catch(() => undefined)
    const pages = browser?.contexts().flatMap((context) => context.pages()) ?? []
    for (const page of pages) {
      const own = await page.evaluate(() => typeof (window as { own?: unknown }).own === "object").catch(() => false)
      if (!own) continue
      Object.assign(story, { browser, main: page, cdp: state.cdp })
      await page.addInitScript(initScript(state.pairs))
      await page.evaluate(() => {
        try {
          localStorage.setItem("opencode-color-scheme", "dark")
        } catch {}
      })
      await page.reload()
      await page.locator('[data-testid="server-status"][data-status="connected"]').first().waitFor({ timeout: 120_000 })
      await page.waitForTimeout(1500)
      return page
    }
    await browser?.close().catch(() => undefined)
    if (Date.now() > deadline) throw new Error("the shell's window never came up (see manual-desktop-shell.log)")
    await Bun.sleep(1000)
  }
}

const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

/** The shell's top-level window as PNG (own-desktop's capture-window.ps1: PrintWindow with full content). */
async function windowCapture(shellPid: number, out: string) {
  // The Electron main process under the shell's process tree (electron-vite → electron.exe without `--type=`).
  const find = [
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine",
    `$set = @(${shellPid})`,
    "do { $added = @($all | Where-Object { $set -contains $_.ParentProcessId -and $set -notcontains $_.ProcessId }); $set += $added.ProcessId } while ($added.Count -gt 0)",
    "$all | Where-Object { $set -contains $_.ProcessId -and $_.Name -eq 'electron.exe' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -ExpandProperty ProcessId",
  ].join("; ")
  const listed = Bun.spawnSync(["powershell", "-NoProfile", "-Command", find], { stdout: "pipe", stderr: "pipe" })
  const electron = listed.stdout.toString().trim().split(/\s+/).filter(Boolean)[0]
  if (!electron) throw new Error(`no electron.exe under the shell: ${listed.stderr.toString().slice(0, 200)}`)
  const script = path.join(DESKTOP, "scripts/capture-window.ps1")
  const run = Bun.spawnSync(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProcessId", electron, "-Out", out],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (run.exitCode !== 0) throw new Error(`window capture: ${run.stderr.toString().slice(0, 300)}`)
  return Buffer.from(await Bun.file(out).arrayBuffer())
}

/** A window capture with numbered boxes on the shell's own parts, after the renderer's privacy check. */
async function capture(
  ctx: Ctx<PaneState>,
  page: Page,
  id: string,
  marks: ReadonlyArray<Locator | ReadonlyArray<Locator>>,
) {
  const problems = await privacyProblems(page)
  if (problems.length > 0) throw new Error(`${id}: personal data on screen: ${problems.join(" / ")}`)
  const remove = await markPage(page, marks)
  const png = await windowCapture(ctx.state.shellPid, path.join(ctx.state.root, `${id}.png`))
  await remove()
  await ctx.save(id, png)
}

/** A settings section of the shell, through its own navigation (the shell routes in the window, not by URL). */
async function settings(page: Page, section: string) {
  await page.locator('[aria-label="설정"], [title="설정"]').first().click()
  await page.waitForTimeout(1200)
  await page
    .getByRole("link", { name: section, exact: true })
    .or(page.getByRole("button", { name: section, exact: true }))
    .first()
    .click()
  await page.waitForTimeout(1500)
  if (await tid(page, "panel").isVisible().catch(() => false)) await tid(page, "panel-toggle").first().click()
}

/**
 * Sends a message in the open conversation from its 대화 tab, then shows its browser: under `나란히` (the default,
 * 19.2) the 브라우저 button opens it beside the conversation; under `탭으로 보기` it is a tab.
 */
async function ask(page: Page, text: string) {
  await page.getByRole("tab", { name: "대화" }).click()
  const box = page.locator("#own-composer-input")
  await box.fill(text)
  await box.press("Control+Enter")
  await page.waitForTimeout(1500)
  const toggle = tid(page, "workspace-browser-toggle")
  if (!(await toggle.isVisible())) return page.getByRole("tab", { name: "브라우저" }).click()
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
}

/** Until the agent's last browser call is a wait on the page (the pane's bar then holds still for a while). */
async function waiting(page: Page) {
  await tid(page, "browser-agent-action").filter({ hasText: "기다리는 중" }).waitFor({ timeout: 120_000 })
  await page.waitForTimeout(1500)
}

const desktopShot = (id: string, run: (ctx: Ctx<DesktopState>) => Promise<void>): Shot<DesktopState> => ({ id, run })
const paneShot = (id: string, run: (ctx: Ctx<PaneState>) => Promise<void>): Shot<PaneState> => ({ id, run })

export const DESKTOP_SHOTS: ReadonlyArray<Shot<DesktopState>> = [
  desktopShot("24-preview-section", async (ctx) => {
    const page = await shellPage(ctx.state)
    await settings(page, "휴대폰·다른 PC")
    const listening = page.locator('[data-testid="pairing-gateway-state"][data-state="listening"]')
    if (!(await listening.isVisible())) {
      await tid(page, "pairing-port").fill(String(ctx.state.gatewayPort))
      await tid(page, "pairing-enable").click()
      await tid(page, "pairing-plan").getByTestId("pairing-plan-confirm").click()
    }
    await listening.waitFor({ timeout: 60_000 })
    if (!(await page.locator('[data-testid="pairing-app"][data-state="listening"]').isVisible())) {
      await tid(page, "pairing-app").getByTestId("pairing-app-enable").click()
      await tid(page, "pairing-app-plan-confirm").click()
    }
    await page.locator('[data-testid="pairing-app"][data-state="listening"]').waitFor({ timeout: 60_000 })
    const section = tid(page, "pairing-preview")
    await section.scrollIntoViewIfNeeded()
    await tid(page, "pairing-preview-make").click()
    const dialog = tid(page, "pairing-approve")
    await dialog.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(600)
    await ctx.shoot(page, "24-preview-approve", {
      clip: dialog,
      marks: [tid(page, "pairing-sas").first(), tid(page, "pairing-allow")],
    })
    await tid(page, "pairing-allow").click()
    await tid(page, "pairing-preview-open").waitFor({ timeout: 60_000 })
    await section.scrollIntoViewIfNeeded()
    await page.waitForTimeout(800)
    await ctx.shoot(page, "24-preview-section", {
      clip: section,
      marks: [tid(page, "pairing-preview-open"), tid(page, "pairing-preview-remove")],
    })
  }),
  desktopShot("24-preview-window", async (ctx) => {
    const page = await shellPage(ctx.state)
    const before = new Set(story.browser!.contexts().flatMap((context) => context.pages()))
    await tid(page, "pairing-preview-open").click()
    const deadline = Date.now() + 120_000
    let preview: Page | undefined
    while (!preview && Date.now() < deadline) {
      await Bun.sleep(1000)
      preview = story
        .browser!.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => !before.has(candidate))
    }
    if (!preview) throw new Error("the preview window did not open")
    await preview.evaluate(initScript(ctx.state.pairs))
    await preview.locator('[data-testid="session-row"], [data-testid="sidebar"]').first().waitFor({ timeout: 90_000 })
    await preview.waitForTimeout(2500)
    await ctx.shoot(preview, "24-preview-window", { scale: "device" })
  }),
]

export const PANE_SHOTS: ReadonlyArray<Shot<PaneState>> = [
  paneShot("19-pane-agent", async (ctx) => {
    const page = await shellPage(ctx.state)
    // A conversation started in the desktop app has the browser tools (05 §8.7).
    await tid(page, "sidebar-new-session").click()
    await ask(page, "점수판 페이지를 열고 '새 게임'을 눌러 줘")
    // While the agent waits on the page (the game starts after a while), the pane says what it is doing.
    const agent = tid(page, "browser-agent")
    await waiting(page)
    await capture(ctx, page, "19-pane-agent", [[agent, tid(page, "browser-takeover")], tid(page, "browser-tab-agent")])
    await agent.waitFor({ state: "hidden", timeout: 120_000 })
  }),
  paneShot("19-pane-download", async (ctx) => {
    const page = await shellPage(ctx.state)
    await ask(page, "점수 파일을 내려받아 줘")
    const save = tid(page, "browser-download-save").first()
    await save.waitFor({ timeout: 120_000 })
    await tid(page, "browser-agent").waitFor({ state: "hidden", timeout: 120_000 }).catch(() => undefined)
    await page.waitForTimeout(1500)
    await capture(ctx, page, "19-pane-download", [tid(page, "browser-downloads"), save])
  }),
  paneShot("19-pane-takeover", async (ctx) => {
    const page = await shellPage(ctx.state)
    await ask(page, "결과 화면이 뜰 때까지 기다려 줘")
    await waiting(page)
    await tid(page, "browser-takeover").click()
    const state = tid(page, "browser-takeover-state")
    await state.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await capture(ctx, page, "19-pane-takeover", [state, tid(page, "browser-tab-user").first()])
  }),
]
