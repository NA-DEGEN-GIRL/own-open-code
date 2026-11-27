// Split panes on the built shell (never installed): two sessions side by side, each with its own browser pane, and
// both native views on screen at once (03 §4.1.1, 05 §7.2, §8.2). Fake credentials only; one temp root (OWN_HOME,
// OWN_CONFIG_DIR, XDG_*, TEMP and the shell's userData) removed afterwards; every process started here is stopped.
// By default it runs `out/` (`bun run build`) unpackaged on the workspace's Electron with OPENCODE_DESKTOP_TEST_ROOT,
// so the shell's userData (window state, localStorage with the pane tree) is the temp root's, never the installed
// app's `%APPDATA%\dev.own.opencode.desktop`. `--exe <win-unpacked\own-desktop.exe>` runs a packaged shell instead,
// which always uses that real userData (like browser-agent.ts).
//
//   bun scripts/split-panes.ts --web <own-web build dir> [--exe <win-unpacked\own-desktop.exe>] [--shots <dir>]
//        [--label split-panes] [--keep]
//
// Checks (window captures: the page colour at each browser surface; the pages' own visibility and size):
//  - views.both-on-screen: session A's red page and session B's blue page show at once, each at its pane's surface;
//  - views.size-matches-surface: each view's page is its surface's size;
//  - views.visible: both pages report `visibilityState === "visible"`;
//  - tabs.one-view: `탭으로 보기` shows the focused pane's view across the tab, and A's view is off screen;
//  - memory: working set of the shell's process tree with one and with two views on screen (recorded, 05 DP4).
//  - removed.*: a session created as a pane-less window creates it (the browser deny) with an approval mode. Its
//    browser pane takes an address only to ask "켜고 열기" (03 §18.15 rule 3); after it the deny is gone, the pane
//    attaches and the typed address opens in a new tab (the green page on screen).
//  - focus.view-click (recorded): a click inside view A through CDP input, which may or may not move the native focus;
//    when it does, main's `own:browser.view-focus` focuses pane A (header shows A's title).
import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Page } from "@playwright/test"
import { startFakeOpenAIResponses } from "../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { opencodeConfig } from "../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { registerService } from "./dev-service"
import { connect, waitForMarks } from "./probe"
import {
  alive,
  appDataDir,
  PACKAGE,
  cleanEnv,
  freePort,
  installUi,
  killTree,
  packagedExe,
  pixelAt,
  removeNewOsArtifacts,
  sameMachine,
  shellVersion,
  snapshotMachine,
  windowShot,
  xdgDirs,
  quitShell,
} from "./run-kit"

const args = parseArgs({
  options: {
    exe: { type: "string" },
    web: { type: "string" },
    shots: { type: "string" },
    label: { type: "string", default: "split-panes" },
    keep: { type: "boolean", default: false },
  },
}).values

const exe = args.exe ? packagedExe(args.exe) : undefined
if (!exe && !existsSync(path.join(PACKAGE, "out", "main", "index.js"))) throw new Error("run `bun run build` first")
if (!args.web || !existsSync(path.join(args.web, "index.html")))
  throw new Error("--web <own-web build dir> is required")
const label = args.label!
const shots = args.shots
const version = shellVersion()
const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownDesktopSplitE2eFakeKey000000001"
const COLORS = { red: [214, 40, 40], blue: [36, 90, 214], green: [40, 160, 80] } as const
const BROWSER_DENY = { action: "browser", resource: "*", effect: "deny" }

const root = path.join(os.tmpdir(), `own-desktop-split-${randomBytes(4).toString("hex")}`)
const xdg = xdgDirs(root)
const configDir = path.join(root, "config")
const shellTemp = path.join(root, "tmp")
mkdirSync(configDir, { recursive: true })
mkdirSync(shellTemp, { recursive: true })

const machine = snapshotMachine()
const report: Record<string, unknown> = { label, exe, root, rpcHash: RPC_HASH }
const checks: Record<string, boolean> = {}
const shotsTaken: string[] = []
const check = (name: string, value: boolean) => {
  checks[name] = value
  console.error(`[split-panes] ${value ? "PASS" : "FAIL"} ${name}`)
}
const log = (message: string) => console.error(`[split-panes] ${message}`)

// A page per colour on the service machine's localhost, reached through the plugin-browser tunnel.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const name = new URL(request.url).pathname.slice(1) as keyof typeof COLORS
    const rgb = COLORS[name] ?? [128, 128, 128]
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>` +
        `<body style="margin:0;height:100vh;background:rgb(${rgb.join(",")})"></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    )
  },
})
const siteUrl = `http://127.0.0.1:${server.port}`

const fake = startFakeOpenAIResponses({ models: [MODEL] })
const service = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  // A source boot is CPU-bound; with other builds and tests on the PC it can take minutes (as zoom-level.ts).
  startupTimeoutMs: 600_000,
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-desktop-split-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: fake.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
    }),
})
const password = atob(service.authorization.slice("Basic ".length)).slice("opencode:".length)
const ownHome = service.paths.ownHome
const control = path.join(ownHome, "control")
mkdirSync(control, { recursive: true })

let shell: ReturnType<typeof Bun.spawn> | undefined
const appData = appDataDir()
const appDataExisted = existsSync(appData)
const watchdog = setTimeout(async () => {
  log("watchdog: the run took too long; stopping everything")
  if (shell) killTree(shell.pid)
  killTree(service.pid)
  server.stop(true)
  if (!appDataExisted) await removeTree(appData)
  await removeTree(root)
  await removeTree(service.paths.root)
  process.exit(2)
}, 6 * 60_000)

try {
  const added = (await service
    .request("POST", "/api/rpc/own.accounts/accounts.add.key", {
      body: { input: { kind: "oai", label: "Alpha", key: FAKE_KEY } },
      query: { "location[directory]": control },
      directory: control,
    })
    .then((response) => response.json())) as { output: { account: { providerID: string } } }
  const model = { providerID: added.output.account.providerID, id: MODEL }
  await service.waitForModels([model])
  const createSession = async (title: string, permissions?: unknown[]) =>
    (
      (await service.call("POST", "/api/session", {
        body: {
          title,
          model,
          location: { directory: service.paths.workspace },
          ...(permissions ? { permissions } : {}),
        },
      })) as { data: { id: string } }
    ).data.id
  const sessions = {
    a: await createSession("분할 시험 A"),
    b: await createSession("분할 시험 B"),
    web: await createSession("분할 시험 웹", [BROWSER_DENY]),
  }
  // The approval bundle a new conversation gets, so the router can switch the browser tools on (mode not `custom`).
  const approval = await service.request("POST", "/api/rpc/own.accounts/session.approval.set", {
    body: { input: { sessionID: sessions.web, mode: "ask" } },
    query: { "location[directory]": service.paths.workspace },
    directory: service.paths.workspace,
  })
  if (!approval.ok) throw new Error(`session.approval.set: ${approval.status} ${await approval.text()}`)
  const rulesOf = async (sessionID: string) =>
    ((await service.call("GET", `/api/session/${sessionID}`)) as { data: { permissions?: unknown[] } }).data
      .permissions ?? []
  await registerService({
    url: service.url,
    authorization: service.authorization,
    password,
    stateHome: xdg.XDG_STATE_HOME,
    channel: "own",
  })
  installUi(ownHome, { version, web: args.web, hash: RPC_HASH })

  const cdp = await freePort()
  const env = cleanEnv({ ...xdg, OWN_HOME: ownHome, OWN_CONFIG_DIR: configDir, TEMP: shellTemp, TMP: shellTemp })
  // Unpackaged: the shell opens CDP on OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT and keeps userData in the test root.
  const electron = createRequire(import.meta.url)("electron") as unknown as string
  // Unpackaged runs keep their windows off the screen and the taskbar (own-shell.ts OWN_DESKTOP_TEST_RUN; the shell
  // also ends when this run is gone), with Windows' occlusion tracking off so the off-screen window and its native
  // views paint, like perf-many-sessions.ts. PrintWindow still captures them. A packaged shell shows its window.
  const command = exe
    ? [exe, `--remote-debugging-port=${cdp}`]
    : [electron, PACKAGE, "--disable-features=CalculateNativeWinOcclusion"]
  const isolated = exe
    ? env
    : {
        ...env,
        OPENCODE_DESKTOP_TEST_ROOT: path.join(root, "desktop"),
        OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdp),
        OWN_DESKTOP_TEST_RUN: String(process.pid),
      }
  report.launch = exe ? "packaged" : "unpackaged out/ (isolated userData, off-screen)"
  shell = Bun.spawn(command, { env: isolated, stdout: "ignore", stderr: "ignore" })
  const pid = shell.pid
  const { browser, page } = await connect(`http://127.0.0.1:${cdp}`, 120_000)
  const winShot = (name: string) => {
    if (!shots) return undefined
    const out = windowShot(pid, path.join(shots, `${label}-${name}-window.png`))
    shotsTaken.push(out)
    return out
  }
  const viewPage = (name: keyof typeof COLORS) =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === `${siteUrl}/${name}`)
  const waitView = async (name: keyof typeof COLORS) => {
    const deadline = Date.now() + 30_000
    while (!viewPage(name) && Date.now() < deadline) await Bun.sleep(200)
    return viewPage(name)
  }

  try {
    await page.waitForSelector('[data-testid="app"]', { timeout: 60_000 })
    await waitForMarks(page, ["own:t0:connect", "own:t0:ready"])
    // Room for two chat + browser pairs stacked (780 px): no work panel.
    if ((await page.getByTestId("app").getAttribute("data-panel")) === "open")
      await page.keyboard.press("Control+Alt+KeyB")
    report.window = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      tier: document.querySelector('[data-testid="app"]')?.getAttribute("data-tier"),
    }))
    await openSession(page, "분할 시험 A")
    const mode = page.getByTestId("panes")
    report.defaultMode = await mode.getAttribute("data-mode")
    check("mode.default-split", report.defaultMode === "split")

    // Pane A: its browser beside it, a red page.
    await page.locator("#own-composer-input").click()
    await page.keyboard.press("Control+Shift+KeyB")
    await openPage(page, 0, `${siteUrl}/red`)
    const red = await waitView("red")

    // Session B dropped below pane A (the pair moves together), then its own browser with a blue page.
    await dropBelow(page, "분할 시험 B")
    await page.locator('[data-testid="pane"][data-view="chat"]').nth(1).locator("textarea").click()
    await page.keyboard.press("Control+Shift+KeyB")
    await openPage(page, 1, `${siteUrl}/blue`)
    const blue = await waitView("blue")
    await Bun.sleep(1_200)

    const surfaces = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="pane"][data-view="browser"]')].map((pane) => {
        const rect = pane.querySelector('[data-testid="browser-surface"]')!.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, dpr: devicePixelRatio }
      }),
    )
    report.surfaces = surfaces
    const both = winShot("two-views")
    const colorAt = (file: string | undefined, surface: (typeof surfaces)[number]) =>
      file && !file.startsWith("failed")
        ? pixelAt(
            file,
            Math.round((surface.left + surface.width / 2) * surface.dpr),
            Math.round((surface.top + surface.height / 2) * surface.dpr),
          )
        : undefined
    const close = (rgb: readonly number[] | undefined, want: readonly number[]) =>
      !!rgb && rgb.every((value, index) => Math.abs(value - want[index]!) <= 8)
    const pixels = surfaces.map((surface) => colorAt(both, surface))
    report.pixels = pixels
    check("views.both-on-screen", close(pixels[0], COLORS.red) && close(pixels[1], COLORS.blue))
    const sizes = await Promise.all(
      [red, blue].map((view) =>
        view?.evaluate(() => ({ width: innerWidth, height: innerHeight, visibility: document.visibilityState })),
      ),
    )
    report.viewSizes = sizes
    check(
      "views.size-matches-surface",
      sizes.every(
        (size, index) =>
          !!size &&
          Math.abs(size.width - surfaces[index]!.width) <= 2 &&
          Math.abs(size.height - surfaces[index]!.height) <= 2,
      ),
    )
    check(
      "views.visible",
      sizes.every((size) => size?.visibility === "visible"),
    )
    report.memoryTwoViews = memory(pid)

    // A click inside view A through CDP (no OS input on the user's desktop): recorded, not gated.
    await red?.mouse.click(40, 40).catch(() => undefined)
    await Bun.sleep(800)
    report.focusAfterViewClick = await page.getByTestId("header-title").textContent()
    report.focusViewClickMoved = report.focusAfterViewClick === "분할 시험 A"

    // Tabs: the focused pane only; the other session's view leaves the screen.
    await page.getByTestId("workspace-mode").click()
    await page.getByRole("tab", { name: /브라우저/ }).click()
    await Bun.sleep(1_000)
    const tabsShot = winShot("tabs-one-view")
    const tabsSurface = await page.evaluate(() => {
      const rect = document
        .querySelector('[data-testid="pane"]:not([hidden]) [data-testid="browser-surface"]')!
        .getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, dpr: devicePixelRatio }
    })
    // The focused pane (B) fills the tab; where A's view was, A's red page must be gone.
    const tabsPixels = { surface: colorAt(tabsShot, tabsSurface), formerA: colorAt(tabsShot, surfaces[0]!) }
    report.tabs = tabsPixels
    check("tabs.one-view", close(tabsPixels.surface, COLORS.blue) && !close(tabsPixels.formerA, COLORS.red))
    report.memoryOneView = memory(pid)
    await page.getByTestId("workspace-mode").click()

    // A session without the browser tools: the address asks to turn them on, then opens.
    await openSession(page, "분할 시험 웹")
    const removed = page.locator('[data-testid="pane"][data-view="browser"]:has([data-testid="browser-removed"])')
    await removed.locator('[data-testid="browser-removed"][data-state="offer"]').waitFor({ timeout: 30_000 })
    const removedPane = await removed.getAttribute("data-pane-id")
    const removedAddress = removed.getByTestId("browser-address")
    check("removed.address-live", await removedAddress.isEditable())
    await removedAddress.fill(`${siteUrl}/green`)
    await removedAddress.press("Enter")
    const apply = removed.getByTestId("browser-enable-apply")
    await apply.waitFor({ timeout: 10_000 })
    report.removedApplyLabel = await apply.textContent()
    check("removed.confirm-names-address", report.removedApplyLabel === "켜고 열기")
    winShot("removed-confirm")
    await apply.click()
    const green = await waitView("green")
    check("removed.opened-after-enable", !!green)
    report.removedRules = await rulesOf(sessions.web)
    check(
      "removed.deny-gone",
      !(report.removedRules as { action?: string; effect?: string; resource?: string }[]).some(
        (rule) => rule.action === "browser" && rule.resource === "*" && rule.effect === "deny",
      ),
    )
    await Bun.sleep(1_200)
    const opened = winShot("removed-opened")
    const greenSurface = await page.evaluate((id) => {
      const rect = document
        .querySelector(`[data-pane-id="${id}"] [data-testid="browser-surface"]`)!
        .getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, dpr: devicePixelRatio }
    }, removedPane)
    const greenPixel = colorAt(opened, greenSurface)
    report.removedPixel = greenPixel
    check("removed.page-on-screen", close(greenPixel, COLORS.green))
  } finally {
    await quitShell(page)
    await browser.close().catch(() => undefined)
  }
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  log(`error: ${String(report.error).slice(0, 2_000)}`)
} finally {
  if (shell) {
    const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
    if (!exited) killTree(shell.pid)
    report.shellExit = exited ? "window closed" : "killed"
    report.shellAlive = alive(shell.pid)
  }
  await service.stop().catch(() => undefined)
  await fake.stop().catch(() => undefined)
  server.stop(true)
  if (!appDataExisted) await removeTree(appData)
  report.osArtifactsCreated = removeNewOsArtifacts(machine.os)
  const after = snapshotMachine()
  check("machine.unchanged", sameMachine(machine, after))
  report.checks = checks
  report.shots = shotsTaken
  report.passed = Object.values(checks).every(Boolean) && !report.error
  if (!args.keep) await removeTree(root)
  clearTimeout(watchdog)
  if (shots) writeFileSync(path.join(shots, `${label}-report.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
}

/** Clicks the session's row until it is the current one (the cached list may be swapped under the first click). */
async function openSession(page: Page, title: string) {
  const row = page.locator('[data-testid="session-row"]', { hasText: title }).first()
  const current = page.locator('[data-testid="session-row"][aria-current="page"]', { hasText: title })
  for (let attempt = 0; attempt < 3; attempt++) {
    await row.click()
    const ok = await current.waitFor({ timeout: 5_000 }).then(
      () => true,
      () => false,
    )
    if (ok) return
  }
  throw new Error(`could not open ${title}`)
}

/** Types a URL into the n-th browser pane's address bar once its attachment is up. */
async function openPage(page: Page, index: number, url: string) {
  const pane = page.locator('[data-testid="pane"][data-view="browser"]').nth(index)
  await pane
    .locator('[data-testid="browser-pane"][data-attached]')
    .waitFor({ timeout: 30_000 })
    .catch(async (error) => {
      // What the pane showed instead (connecting, removed, a banner).
      report.attachMissing = await page
        .evaluate(() => {
          const panes = document.querySelector('[data-testid="panes"]')
          return {
            mode: panes?.getAttribute("data-mode"),
            panes: [...document.querySelectorAll('[data-testid="pane"]')].map(
              (item) => `${item.getAttribute("data-view")}:${item.hasAttribute("hidden")}`,
            ),
            browser: document.querySelector('[data-testid="tab-browser"]')?.outerHTML.slice(0, 1_500),
            route: location.href,
          }
        })
        .catch((cause: unknown) => String(cause))
      await page
        .screenshot({ path: path.join(shots ?? os.tmpdir(), `${label}-attach-missing.png`) })
        .catch(() => undefined)
      throw error
    })
  const address = pane.getByTestId("browser-address")
  await address.fill(url)
  await address.press("Enter")
}

/** Drops a session row below the first chat pane (the drag the sidebar starts, with synthetic events). */
async function dropBelow(page: Page, title: string) {
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((item) =>
      item.textContent?.includes(name),
    )!
    const target = document
      .querySelector<HTMLElement>('[data-testid="pane"][data-view="chat"]')!
      .getBoundingClientRect()
    const panes = document.querySelector<HTMLElement>('[data-testid="panes"]')!
    const data = new DataTransfer()
    const at = {
      clientX: target.left + target.width / 2,
      clientY: target.bottom - 20,
      bubbles: true,
      dataTransfer: data,
    }
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }))
    panes.dispatchEvent(new DragEvent("dragover", { ...at, cancelable: true }))
    panes.dispatchEvent(new DragEvent("drop", { ...at, cancelable: true }))
  }, title)
  await page.locator('[data-testid="pane"][data-view="chat"]').nth(1).waitFor({ timeout: 10_000 })
}

/** Working set (MB) of the shell and every process under it. */
function memory(pid: number) {
  const script =
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize; ` +
    `$ids = @(${pid}); $grew = $true; while ($grew) { $grew = $false; ` +
    `foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $grew = $true } } }; ` +
    `$sum = ($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object -Property WorkingSetSize -Sum).Sum; ` +
    `Write-Output "$($ids.Count) $([math]::Round($sum / 1MB))"`
  const run = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [processes, mb] = run.stdout.toString().trim().split(/\s+/).map(Number)
  return { processes, workingSetMB: mb }
}
