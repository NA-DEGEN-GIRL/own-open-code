// G-D5 run of the packaged shell (win-unpacked, never installed): the agent drives the native browser pane through a
// fake provider's scripted tool calls, and the pane UX around it is checked and photographed. Fake credentials only;
// everything lives in one temp root (OWN_HOME, OWN_CONFIG_DIR, XDG_*, TEMP of the shell) that is removed afterwards,
// and every process started here is stopped.
//
//   bun scripts/browser-agent.ts --web <own-web build dir> [--exe <win-unpacked\own-desktop.exe>] [--shots <dir>]
//        [--label browser-agent] [--keep]
//
// Service: the upstream server from source with own.accounts (one fake OpenAI key account) + own.telemetry and a fake
// OpenAI Responses provider whose replies are decided per request (a marker in the user's prompt picks a script, the
// number of tool results since it picks the step), so title requests or retries never consume a scripted step.
// Registered as service-own.json in the temp XDG_STATE_HOME, so the shell discovers it (no launcher).
//
// Scenarios (05 §14.1 G-D5, §8):
//  (a) agent: `execute{ tools.browser.tabs.open → snapshot → screenshot }`, then `find → click → wait → find` on a
//      local page (served here, reached through the plugin-browser tunnel). The pane shows "● 에이전트가 조작 중 ·
//      <action>" and the tab badge during the calls. The page's click endpoint must have been hit, the tool result
//      must contain the page's new text, and the screenshot comes back as an image file. A pending "browser" permission would be answered "always" (none is expected at
//      this upstream base: plugin-browser registers `permission: "browser"` for catalog filtering but never asks).
//  web permissions: the page's own requests (notifications, geolocation, camera) are denied without a prompt.
//  takeover: the agent waits on a page for text that never comes. First the window is asked to close (WM_CLOSE, as
//      the WCO X / Alt+F4): main's 05 §7.2 confirmation appears and cancelling it keeps the window and the turn
//      (G-D3 b).
//      Then "멈추고 직접 조작" interrupts the turn, the pane shows the takeover state, and a user navigation marks the
//      tab as the user's.
//  (e) downloads: the agent clicks a download link; `browser.files.list` reports it, the file sits in the shell's
//      TEMP (`opencode-browser-client-*`) and the pane lists it. `PC에 저장` opens the Save As dialog (answered by
//      file-dialog.ps1) and copies the file; a second, unsaved download makes the tab's × ask first ("저장하지 않은
//      파일 1개가 지워집니다"); closing it anyway removes the temp files and the pane marks them deleted.
//  (f) tool list: a session created with rule 1's browser deny (as a pane-less window creates it) shows the removed
//      state in the pane, and its requests never list the browser tools, even after being opened in the desktop
//      app; the desktop-created session's requests do.
//  bounds: the native view has the surface's size, follows the window zoom (Ctrl+-), and is off screen while the
//      workspace shows 채팅 instead (checked on window captures: the page's background colour at the surface).
//  (d) reload: after a renderer reload the attachment registers again and the tabs come back.
//  G-D3 (with the close action 앱 종료 for the run, 05 §7.3): during another browser turn, the close confirmation's
//      [창 닫기] closes the window (the shell exits with its last window) and the turn keeps running in the service to
//      its end.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import type { Page } from "@playwright/test"
import { startFakeOpenAIResponses } from "../../own-accounts/test/e2e-kit/fakes/openai-responses"
import type { RecordedRequest, Reply } from "../../own-accounts/test/e2e-kit/fakes/shared"
import { opencodeConfig } from "../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { registerService } from "./dev-service"
import { connect, marks, shot, waitForMarks } from "./probe"
import {
  alive,
  appDataDir,
  cleanEnv,
  collectLogs,
  freePort,
  installUi,
  killTree,
  removeNewOsArtifacts,
  packagedExe,
  pixelAt,
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
    label: { type: "string", default: "browser-agent" },
    keep: { type: "boolean", default: false },
  },
}).values

const exe = packagedExe(args.exe)
if (!args.web || !existsSync(path.join(args.web, "index.html")))
  throw new Error("--web <own-web build dir> is required")
const label = args.label!
const shots = args.shots
const version = shellVersion()
const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownDesktopBrowserE2eFakeKey00000001"

const root = path.join(os.tmpdir(), `own-desktop-browser-${randomBytes(4).toString("hex")}`)
const xdg = xdgDirs(root)
const configDir = path.join(root, "config")
const shellTemp = path.join(root, "tmp")
mkdirSync(configDir, { recursive: true })
mkdirSync(shellTemp, { recursive: true })

const machine = snapshotMachine()
const report: Record<string, unknown> = { label, exe, root, rpcHash: RPC_HASH, before: machine }
const checks: Record<string, boolean> = {}
const shotsTaken: string[] = []
const check = (name: string, value: boolean) => {
  checks[name] = value
  console.error(`[browser-agent] ${value ? "PASS" : "FAIL"} ${name}`)
}
const log = (message: string) => console.error(`[browser-agent] ${message}`)

// ---------------------------------------------------------------- local site (the service machine's localhost)

const site = { clicks: 0, downloads: 0 }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/clicked" && request.method === "POST") {
      site.clicks++
      return new Response("ok")
    }
    if (url.pathname === "/report.txt") {
      site.downloads++
      return new Response("own-desktop browser pane download\n", {
        headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="report.txt"' },
      })
    }
    if (url.pathname === "/slow")
      return html("기다리는 페이지", "<h1>느린 페이지</h1><p>이 페이지는 끝나지 않습니다.</p>")
    return html(
      "own 브라우저 시험",
      `<h1>own-desktop 브라우저 패인</h1>
       <p>서비스가 도는 기계의 localhost에서 plugin-browser 터널로 받은 페이지입니다.</p>
       <button id="save" style="font-size:20px;padding:8px 18px">저장하기</button>
       <p id="status" style="font-size:22px;font-weight:700">아직 저장하지 않음</p>
       <p><a href="/report.txt">보고서 받기</a></p>
       <script>
         document.getElementById("save").addEventListener("click", () => {
           document.getElementById("status").textContent = "저장 중…"
           fetch("/clicked", { method: "POST" })
           setTimeout(() => { document.getElementById("status").textContent = "저장됨" }, 4000)
         })
       </script>`,
    )
  },
})
const siteUrl = `http://127.0.0.1:${server.port}`
/** The test page's background (moccasin): no part of own-web uses it. */
const PAGE_BG = "#ffe4b5"
const PAGE_RGB = [255, 228, 181] as const

function html(title: string, body: string) {
  return new Response(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font:18px system-ui;padding:28px;background:${PAGE_BG};color:#1b2440">${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )
}

// ---------------------------------------------------------------- scripted model

const MARK = {
  agent: "[browser-e2e:agent]",
  takeover: "[browser-e2e:takeover]",
  download: "[browser-e2e:download]",
  catalogDesktop: "[browser-e2e:catalog-desktop]",
  catalogWeb: "[browser-e2e:catalog-web]",
  closeWait: "[browser-e2e:close-wait]",
} as const

const execute = (code: string, eventDelayMs = 5): Reply => ({
  type: "tool-call",
  name: "execute",
  input: { code: code.trim() },
  eventDelayMs,
})
const findTab = `
const { tabs } = await tools.browser.tabs.list({})
const tab = tabs.find((item) => item.url.startsWith(${JSON.stringify(siteUrl)}))
if (!tab) throw new Error("test tab missing: " + JSON.stringify(tabs))
`
const SCRIPTS: Record<string, { steps: Reply[]; done: string }> = {
  [MARK.agent]: {
    steps: [
      execute(`
const tab = await tools.browser.tabs.open({ url: ${JSON.stringify(`${siteUrl}/`)} })
const page = await tools.browser.snapshot({ tabID: tab.id })
const shot = await tools.browser.screenshot({ tabID: tab.id })
return { tabID: tab.id, title: page.tab.title, snapshot: page.content, screenshot: shot.files }
`),
      execute(`${findTab}
const found = await tools.browser.find({ tabID: tab.id, text: "저장하기" })
const ref = /@(e\\d+) \\[button\\]/.exec(found.content)?.[1]
if (!ref) throw new Error("no button ref in: " + found.content)
await tools.browser.click({ tabID: tab.id, ref })
await tools.browser.wait({ tabID: tab.id, condition: "text", text: "저장됨", timeoutMs: 20000 })
const after = await tools.browser.find({ tabID: tab.id, text: "저장됨" })
return { ref, after: after.content }
`),
    ],
    done: "저장하기 버튼을 눌렀고 페이지에 '저장됨'이 표시되었습니다.",
  },
  [MARK.takeover]: {
    steps: [
      execute(`${findTab}
await tools.browser.navigate({ tabID: tab.id, url: ${JSON.stringify(`${siteUrl}/slow`)} })
await tools.browser.wait({ tabID: tab.id, condition: "text", text: "끝났습니다", timeoutMs: 30000 })
return "done"
`),
    ],
    done: "기다리던 글자가 나타나지 않았습니다.",
  },
  [MARK.closeWait]: {
    steps: [
      execute(`
const tab = await tools.browser.tabs.open({ url: ${JSON.stringify(`${siteUrl}/slow`)} })
await tools.browser.wait({ tabID: tab.id, condition: "text", text: "끝났습니다", timeoutMs: 10000 })
return "done"
`),
    ],
    done: "창이 닫혀도 턴은 끝까지 돌았습니다.",
  },
  [MARK.download]: {
    steps: [
      execute(`${findTab}
await tools.browser.navigate({ tabID: tab.id, url: ${JSON.stringify(`${siteUrl}/`)} })
const found = await tools.browser.find({ tabID: tab.id, text: "보고서 받기" })
const ref = /@(e\\d+) \\[link\\]/.exec(found.content)?.[1]
if (!ref) throw new Error("no link ref in: " + found.content)
await tools.browser.click({ tabID: tab.id, ref })
let files = []
for (let attempt = 0; attempt < 60; attempt++) {
  files = (await tools.browser.files.list({ tabID: tab.id })).files
  if (files.some((file) => file.name === "report.txt" && file.state === "completed")) break
}
return { tabID: tab.id, files }
`),
    ],
    done: "보고서를 받았습니다.",
  },
}

function respond(request: RecordedRequest): Reply | undefined {
  if (request.body.includes("You name conversations so the user can find them later"))
    return { type: "text", text: "브라우저 시험" }
  const input = (request.json as { input?: unknown })?.input
  if (!Array.isArray(input)) return undefined
  let at = -1
  let marker: string | undefined
  input.forEach((item, index) => {
    if (!item || typeof item !== "object" || (item as { role?: unknown }).role !== "user") return
    const text = JSON.stringify(item)
    const found = Object.values(MARK).findLast((value) => text.includes(value))
    if (found) {
      at = index
      marker = found
    }
  })
  if (!marker) return { type: "text", text: "확인했습니다." }
  const script = SCRIPTS[marker]
  if (!script) return { type: "text", text: `확인했습니다 ${marker}` }
  const step = input
    .slice(at + 1)
    .filter((item) => (item as { type?: unknown } | null)?.type === "function_call_output").length
  return script.steps[step] ?? { type: "text", text: script.done }
}

// ---------------------------------------------------------------- service

const fake = startFakeOpenAIResponses({ models: [MODEL], responder: respond })
const service = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-desktop-browser-${process.pid}`,
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
// 05 §7.3: the last window's X goes to the tray by default and asks nothing. This run checks 7.2's close confirmation,
// so the shell closes for real while it runs (window.own.app), and the user's own choice is put back afterwards.
const settingsFile = path.join(appData, "opencode.settings")
const closeActionBefore = readSetting("ownCloseAction")
// Last resort when a step hangs (a native dialog nobody answers): stop everything started here and leave nothing.
const watchdog = setTimeout(async () => {
  log("watchdog: the run took too long; stopping everything")
  if (shell) killTree(shell.pid)
  killTree(service.pid)
  server.stop(true)
  if (!appDataExisted) await removeTree(appData)
  await removeTree(root)
  await removeTree(service.paths.root)
  process.exit(2)
}, 8 * 60_000)
try {
  const rpc = async (method: string, input: unknown) => {
    const response = await service.request("POST", `/api/rpc/own.accounts/${method}`, {
      body: { input },
      query: { "location[directory]": control },
      directory: control,
    })
    const body = (await response.json()) as { output?: Record<string, unknown> }
    if (!response.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
    return body.output ?? {}
  }
  const added = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY })
  const account = added.account as { providerID: string }
  const model = { providerID: account.providerID, id: MODEL }
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
  // Desktop-created session: no browser rule (rule 1 adds nothing when the window has the pane).
  const desktopSession = await createSession("브라우저 에이전트 시험")
  // What a pane-less window (web fallback, phone) creates: rule 1's deny (packages/own-web/src/policy/browser.ts).
  const webSession = await createSession("웹에서 만든 세션", [{ action: "browser", resource: "*", effect: "deny" }])
  const registered = await registerService({
    url: service.url,
    authorization: service.authorization,
    password,
    stateHome: xdg.XDG_STATE_HOME,
    channel: "own",
  })
  report.service = { url: service.url, version: registered.version, site: siteUrl, desktopSession, webSession }
  installUi(ownHome, { version, web: args.web, hash: RPC_HASH })

  // -------------------------------------------------------------- shell

  const cdp = await freePort()
  const env = cleanEnv({ ...xdg, OWN_HOME: ownHome, OWN_CONFIG_DIR: configDir, TEMP: shellTemp, TMP: shellTemp })
  shell = Bun.spawn([exe, `--remote-debugging-port=${cdp}`], { env, stdout: "ignore", stderr: "ignore" })
  const pid = shell.pid
  report.shell = { pid, cdp }
  const cdpUrl = `http://127.0.0.1:${cdp}`
  // `let`: the close-confirmation step disconnects and reconnects (a CDP client answers unload dialogs itself).
  let { browser, page } = await connect(cdpUrl, 120_000)
  await page.evaluate(() =>
    (
      window as unknown as { own: { app?: { setCloseAction(action: string): Promise<string> } } }
    ).own.app?.setCloseAction("quit"),
  )
  const winShot = (name: string) => {
    if (!shots) return
    const out = windowShot(pid, path.join(shots, `${label}-${name}-window.png`))
    shotsTaken.push(out)
    return out
  }
  const domShot = (target: Page, name: string) => shot(target, shots, `${label}-${name}`, shotsTaken)
  const viewPage = () =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(siteUrl))
  const sessionCall = (sessionID: string, method: string, route: string, body?: unknown) =>
    service.call(method, `/api/session/${sessionID}${route}`, body === undefined ? undefined : { body })
  const turn = async (sessionID: string, text: string) => {
    await sessionCall(sessionID, "POST", "/prompt", { text })
  }
  const waitIdle = (sessionID: string) => service.call("POST", `/api/experimental/session/${sessionID}/wait`)
  const toolResults = async (sessionID: string) => JSON.stringify(await service.messages(sessionID))

  // The "browser" permission (plugin-browser tools.ts) is answered like a user's "항상 허용", once it is pending.
  const permissions: unknown[] = []
  let permissionShot = false
  let answering = true
  const answer = (async () => {
    while (answering) {
      const listed = (await sessionCall(desktopSession, "GET", "/permission").catch(() => ({ data: [] }))) as {
        data?: { id: string; action?: string; permission?: string }[]
      }
      for (const request of listed.data ?? []) {
        permissions.push(request)
        if (!permissionShot) {
          permissionShot = true
          await Bun.sleep(300)
          winShot("permission-pending")
        }
        await sessionCall(desktopSession, "POST", `/permission/${request.id}/reply`, { decision: "always" }).catch(
          () => undefined,
        )
      }
      await Bun.sleep(200)
    }
  })()
  try {
    await page.waitForSelector('[data-testid="app"]', { timeout: 60_000 })
    await waitForMarks(page, ["own:t0:connect", "own:t0:ready"])
    report.marks = await marks(page)

    // ------------------------------------------------------------ open the desktop session and its browser tab
    const openSession = async (title: string) => {
      // The list first paints the shell's cached rows (userData is the packaged app's own), then the service's: a
      // click that lands while they are swapped routes nowhere, so the row must become the current one.
      const row = page.locator('[data-testid="session-row"]', { hasText: title }).first()
      const current = page.locator('[data-testid="session-row"][aria-current="page"]', { hasText: title })
      for (let attempt = 0; attempt < 3; attempt++) {
        await row.click()
        if (
          await current.waitFor({ timeout: 5_000 }).then(
            () => true,
            () => false,
          )
        )
          break
      }
      await Bun.sleep(300)
      // These checks are written for the 채팅 | 브라우저 tabs (03 §4.1.1 `탭으로 보기`; split-panes.ts covers 나란히).
      const mode = page.getByTestId("workspace-mode")
      if ((await mode.getAttribute("data-mode").catch(() => null)) === "split") await mode.click()
      const tab = page.locator("#own-tab-browser")
      if (!(await tab.isVisible())) await page.keyboard.press("Control+Shift+KeyB")
      await tab.waitFor({ timeout: 10_000 })
      if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click()
    }
    const registerStart = Date.now()
    await openSession("브라우저 에이전트 시험")
    await page
      .waitForSelector('[data-testid="browser-pane"][data-attached]', { timeout: 30_000 })
      .catch(async (error) => {
        // What the browser tab showed instead, and the session's rules (05 §8.7: no attachment for a removed session).
        winShot("attach-missing")
        report.attachMissing = {
          pane: await page.evaluate(() =>
            document.querySelector('[data-testid="tab-browser"]')?.outerHTML.slice(0, 1500),
          ),
          session: await sessionCall(desktopSession, "GET", "").catch((cause: unknown) => String(cause)),
        }
        throw error
      })
    const attachMs = Date.now() - registerStart
    report.attachMs = attachMs
    check("a.attached-within-15s", attachMs < 15_000)

    // ------------------------------------------------------------ (a) agent: open, snapshot, find, click, wait
    await turn(desktopSession, `${MARK.agent} 로컬 페이지를 열고 저장하기 버튼을 눌러 줘.`)
    await page.waitForSelector('[data-testid="browser-agent"][data-phase="operating"]', { timeout: 60_000 })
    const waiting = await page
      .waitForFunction(
        () => document.querySelector('[data-testid="browser-agent-action"]')?.textContent?.includes("기다리는 중"),
        undefined,
        { timeout: 60_000, polling: 100 },
      )
      .then(() => true)
      .catch(() => false)
    const operating = {
      text: await page.locator('[data-testid="browser-agent"]').textContent(),
      action: await page.locator('[data-testid="browser-agent-action"]').textContent(),
      tabMark: await page.locator('[data-testid="browser-tab-agent"]').count(),
      badge: await page.locator('[data-testid="browser-tab-badge"]').count(),
    }
    report.operating = operating
    await Bun.sleep(400)
    winShot("operating")
    await domShot(page, "operating-pane")
    const view = viewPage()
    if (view) await domShot(view, "operating-view")
    check("a.indicator-shows-agent-action", waiting && !!operating.text?.includes("에이전트가 조작 중"))
    check("a.agent-tab-marked", operating.tabMark === 1)
    check("a.browser-tab-badge", operating.badge === 1)
    await waitIdle(desktopSession)
    const resultA = await toolResults(desktopSession)
    report.permissionRequests = permissions.length
    check("a.page-click-reached-site", site.clicks === 1)
    check("a.tool-result-has-new-text", resultA.includes("저장됨") && resultA.includes("[button]"))
    // The agent's screenshot: captured by the pane's page in main and handed to the service as a file.
    check("a.agent-screenshot-file", /screenshot\.png.{0,200}?image\/png/s.test(resultA))
    await Bun.sleep(800)
    winShot("done")
    const pageText = await viewPage()?.evaluate(() => document.getElementById("status")?.textContent)
    check("a.native-view-shows-result", pageText === "저장됨")

    // ------------------------------------------------------------ web permissions of the page: denied, never asked
    const pagePermissions = await viewPage()?.evaluate(async () => {
      const notification = await Notification.requestPermission()
      const geolocation = await new Promise<string>((resolve) =>
        navigator.geolocation.getCurrentPosition(
          () => resolve("granted"),
          (error) => resolve(`error:${error.code}`),
          { timeout: 5_000 },
        ),
      )
      const camera = await navigator.mediaDevices
        .getUserMedia({ video: true })
        .then(() => "granted")
        .catch((error: Error) => `error:${error.name}`)
      return { notification, geolocation, camera }
    })
    report.webPermissions = pagePermissions
    check(
      "permissions.page-requests-denied",
      pagePermissions?.notification === "denied" &&
        pagePermissions.geolocation === "error:1" &&
        pagePermissions.camera !== "granted",
    )

    // ------------------------------------------------------------ bounds, zoom and visibility of the native view
    const measure = async () => {
      const surface = await page.evaluate(() => {
        const rect = document.querySelector('[data-testid="browser-surface"]')!.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, dpr: devicePixelRatio }
      })
      const view = await viewPage()?.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      return { surface, view }
    }
    const near = (a: number, b: number) => Math.abs(a - b) <= 2
    const size = await measure()
    report.bounds = size
    check(
      "bounds.view-matches-surface",
      !!size.view && near(size.view.width, size.surface.width) && near(size.view.height, size.surface.height),
    )
    // A point of the surface where the page shows its background (left margin, near the bottom), in window pixels.
    const probePoint = (surface: typeof size.surface) => ({
      x: Math.round((surface.left + 12) * surface.dpr),
      y: Math.round((surface.top + surface.height - 40) * surface.dpr),
    })
    const pageOnScreen = (file: string | undefined, surface: typeof size.surface) => {
      if (!file || file.startsWith("failed")) return undefined
      const point = probePoint(surface)
      const rgb = pixelAt(file, point.x, point.y)
      return rgb ? rgb.every((value, index) => Math.abs(value - PAGE_RGB[index]!) <= 6) : undefined
    }
    const visibleShot = winShot("view-visible")
    // The browser is a workspace tab next to 채팅 (ab31dc31dd): showing the chat must take the native view off screen.
    await page.locator('.own-workspace-tabs [role="tab"]', { hasText: "채팅" }).click()
    await Bun.sleep(600)
    const hiddenShot = winShot("hidden-other-tab")
    await page.locator("#own-tab-browser").click()
    await Bun.sleep(600)
    const backShot = winShot("view-back")
    const visibility = {
      browserTab: pageOnScreen(visibleShot, size.surface),
      otherTab: pageOnScreen(hiddenShot, size.surface),
      browserTabAgain: pageOnScreen(backShot, size.surface),
    }
    report.visibility = visibility
    check(
      "bounds.hidden-when-tab-hidden",
      visibility.browserTab === true && visibility.otherTab === false && visibility.browserTabAgain === true,
    )
    // Window zoom (own-web's Ctrl+- → own:zoom.step, 05 §7.9): main takes bounds in DIPs, so the view follows the
    // factor.
    // Zooming out keeps the window in the same layout range (zooming in can cross into the drawer range, 03 §4.2).
    await page.keyboard.press("Control+Minus")
    await Bun.sleep(1_200)
    const zoomed = await measure()
    const zoomState = await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="browser-surface"]') as HTMLElement | null
      return { zoom: surface?.dataset.zoom, covered: surface?.dataset.covered !== undefined }
    })
    winShot("zoomed-out")
    const factor = zoomed.surface.dpr / size.surface.dpr
    await page.keyboard.press("Control+Digit0")
    await Bun.sleep(900)
    const reset = await measure()
    report.zoom = { factor, zoomed, reset, zoomState }
    check(
      "bounds.follow-window-zoom",
      factor < 0.95 &&
        !!zoomed.view &&
        near(zoomed.view.width, zoomed.surface.width * factor) &&
        near(zoomed.view.height, zoomed.surface.height * factor) &&
        !!reset.view &&
        near(reset.view.width, reset.surface.width),
    )

    // ------------------------------------------------------------ takeover
    await turn(desktopSession, `${MARK.takeover} 느린 페이지에서 끝날 때까지 기다려 줘.`)
    await page.waitForFunction(
      () => document.querySelector('[data-testid="browser-agent-action"]')?.textContent?.includes("기다리는 중"),
      undefined,
      { timeout: 60_000, polling: 100 },
    )
    await Bun.sleep(500)
    winShot("before-takeover")
    // 05 §7.2 (G-D3 b): the window's close (WM_CLOSE, as the WCO X and Alt+F4 send it) while a running session holds
    // browser tabs is confirmed by main; its cancel keeps the window and the turn. With a CDP client attached, Chromium
    // reports the beforeunload to it as well and the automation answers it, so the run disconnects Playwright first
    // (the app keeps running) and reconnects after the dialog was answered like Esc (file-dialog.ps1 -Dismiss).
    await browser.close()
    const closeAsked = await powershell("window-close.ps1", ["-ProcessId", String(pid)])
    const dialogShot = shots ? path.join(shots, `${label}-close-confirm-dialog.png`) : undefined
    const closeAnswer = await powershell("file-dialog.ps1", [
      "-ProcessId",
      String(pid),
      "-Dismiss",
      ...(dialogShot ? ["-Shot", dialogShot] : []),
      "-TimeoutSeconds",
      "10",
    ])
    if (dialogShot && existsSync(dialogShot)) shotsTaken.push(dialogShot)
    // Regression: one close asks once, and no "not responding" dialog follows (a close that reached the page's
    // beforeunload used to start Electron's 5 s unresponsive timer, windows-own.ts).
    await Bun.sleep(5_500)
    const second = await powershell("file-dialog.ps1", ["-ProcessId", String(pid), "-Dismiss", "-TimeoutSeconds", "2"])
    ;({ browser, page } = await connect(cdpUrl, 30_000))
    report.closeRepeat = second.out
    check("g-d3.single-confirmation-no-unresponsive", second.out === "no dialog")
    const windowAlive = await page
      .evaluate(() => document.readyState)
      .then(() => true)
      .catch(() => false)
    const outcome = (
      (await sessionCall(desktopSession, "GET", "").catch(() => ({}))) as { data?: { outcome?: string } }
    ).data?.outcome
    const stillRunning = await page
      .locator('[data-testid="browser-agent"][data-phase="operating"]')
      .count()
      .catch(() => 0)
    report.closeConfirm = { close: closeAsked.out, dialog: closeAnswer.out, windowAlive, outcome, stillRunning }
    check(
      "g-d3.close-confirm-cancel-keeps-window",
      closeAnswer.out.startsWith("dismissed by") && closeAnswer.out.includes("Own OpenCode") && windowAlive,
    )
    check("g-d3.turn-continues-after-cancel", outcome !== "interrupted" && stillRunning === 1)
    const stopAt = Date.now()
    await page.locator('[data-testid="browser-takeover"]').click()
    await page.waitForSelector('[data-testid="browser-takeover-state"]', { timeout: 15_000 })
    await waitIdle(desktopSession)
    const stoppedMs = Date.now() - stopAt
    const info = (await sessionCall(desktopSession, "GET", "")) as { data?: { outcome?: string } }
    report.takeover = { stoppedMs, outcome: info.data?.outcome }
    check("takeover.turn-interrupted", stoppedMs < 20_000 && info.data?.outcome === "interrupted")
    await Bun.sleep(400)
    winShot("takeover")
    const address = page.locator('[data-testid="browser-address"]')
    await address.fill(`${siteUrl}/?by=user`)
    await address.press("Enter")
    await page.waitForFunction(
      (url) => (document.querySelector('[data-testid="browser-address"]') as HTMLInputElement | null)?.value === url,
      `${siteUrl}/?by=user`,
      { timeout: 20_000 },
    )
    check("takeover.user-tab-marked", (await page.locator('[data-testid="browser-tab-user"]').count()) === 1)
    await Bun.sleep(600)
    winShot("user-drives")

    // ------------------------------------------------------------ (e) downloads land in the shell's TEMP, die with the tab
    await turn(desktopSession, `${MARK.download} 보고서를 받아 줘.`)
    await waitIdle(desktopSession)
    const resultC = await toolResults(desktopSession)
    const downloaded = findFiles(shellTemp, "report.txt")
    if (shots) writeFileSync(path.join(shots, `${label}-download-messages.json`), resultC)
    const at = resultC.lastIndexOf("report.txt")
    report.download = {
      files: downloaded,
      site: site.downloads,
      // The agent's last word on the file (files.list), for a failing check.
      result: at < 0 ? resultC.slice(-600) : resultC.slice(Math.max(0, at - 300), at + 300),
    }
    check("e.agent-download-listed", /report\.txt.{0,300}?completed/s.test(resultC))
    check("e.download-in-shell-temp", downloaded.length === 1 && downloaded[0]!.includes("opencode-browser-client-"))
    check(
      "takeover.cleared-by-next-agent-call",
      (await page.locator('[data-testid="browser-takeover-state"]').count()) === 0,
    )
    // The pane lists it for the user (window.own.browser downloads, 8.4).
    const listed = await page
      .waitForSelector('[data-testid="browser-download"][data-state="completed"]', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    check("e.pane-lists-download", listed)
    await Bun.sleep(400)
    winShot("download")
    // `PC에 저장`: the shell's Save As dialog, answered with a path in the temp root (file-dialog.ps1).
    const savedTo = path.join(root, "saved", "report.txt")
    mkdirSync(path.dirname(savedTo), { recursive: true })
    await page.locator('[data-testid="browser-download-save"]').first().click()
    const dialog = await powershell("file-dialog.ps1", ["-ProcessId", String(pid), "-Path", savedTo])
    const dialogCode = dialog.code
    const dialogOut = dialog.out
    // The row says 저장함 once main's copy finished (own-browser.ts publishes `saved` after copyFile).
    const savedRow = await page
      .waitForFunction(
        () => document.querySelector('[data-testid="browser-download"]')?.textContent?.includes("저장함"),
        undefined,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false)
    const savedText = await readWhenFree(savedTo)
    check("e.pane-marks-saved", savedRow)
    report.saveToPc = { dialog: dialogOut, code: dialogCode, savedTo, saved: savedText !== undefined }
    check("e.save-to-pc-copies-file", savedText === "own-desktop browser pane download\n")
    // A second download from the page itself, never saved: closing its tab is named first.
    await viewPage()?.evaluate(() => (document.querySelector('a[href="/report.txt"]') as HTMLAnchorElement).click())
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="browser-download"][data-state="completed"]').length >= 2,
      undefined,
      { timeout: 15_000 },
    )
    const tabsBefore = await page.locator(".own-browser-tab").count()
    await page.locator(".own-browser-tab-close").first().click()
    const warned = await page
      .waitForSelector('[data-testid="browser-close-unsaved"]', { timeout: 5_000 })
      .then(async (element) => (await element.textContent()) ?? "")
      .catch(() => "")
    report.closeWarning = warned
    check("e.close-warns-unsaved-download", warned.includes("저장하지 않은 파일 1개"))
    await Bun.sleep(300)
    winShot("close-unsaved")
    await page.locator('[data-testid="browser-close-anyway"]').click()
    await page.waitForFunction((count) => document.querySelectorAll(".own-browser-tab").length < count, tabsBefore)
    await Bun.sleep(800)
    const leftover = findFiles(shellTemp, "report.txt")
    report.downloadAfterClose = leftover
    check("e.temp-file-removed-with-tab", leftover.length === 0)
    check(
      "e.pane-marks-deleted-files",
      (await page.locator('[data-testid="browser-download"][data-state="removed"]').count()) === 2,
    )
    winShot("after-close")

    // ------------------------------------------------------------ (f) tool list decided at creation
    await openSession("웹에서 만든 세션")
    await page.waitForSelector('[data-testid="browser-removed"]', { timeout: 20_000 }).catch(async (error) => {
      // What the pane showed instead, for the report.
      winShot("removed-missing")
      report.removedMissing = {
        pane: await page.evaluate(() =>
          document.querySelector('[data-testid="tab-browser"]')?.outerHTML.slice(0, 1500),
        ),
        permissions: await sessionCall(webSession, "GET", "").catch((cause: unknown) => String(cause)),
      }
      throw error
    })
    await Bun.sleep(400)
    winShot("removed")
    await domShot(page, "removed-pane")
    await turn(webSession, `${MARK.catalogWeb} 도구 목록 확인`)
    await waitIdle(webSession)
    await turn(desktopSession, `${MARK.catalogDesktop} 도구 목록 확인`)
    await waitIdle(desktopSession)
    const lastWith = (marker: string) => fake.requests.findLast((request) => request.body.includes(marker))
    const catalog = (request: RecordedRequest | undefined) => ({
      namespace: !!request?.body.includes("Desktop browser tools"),
      tabsOpen: !!request?.body.includes("tabs.open"),
    })
    const web = catalog(lastWith(MARK.catalogWeb))
    const desktop = catalog(lastWith(MARK.catalogDesktop))
    report.catalog = { web, desktop }
    check("f.web-created-session-has-no-browser-tools", !web.namespace && !web.tabsOpen)
    check("f.desktop-created-session-lists-browser-tools", desktop.namespace)

    // ------------------------------------------------------------ (d) reload: register again, tabs restored
    await openSession("브라우저 에이전트 시험")
    await page.waitForSelector('[data-testid="browser-pane"][data-attached]', { timeout: 30_000 })
    const tabsBeforeReload = await page.locator(".own-browser-tab").count()
    await page.reload()
    await page.waitForSelector('[data-testid="app"]', { timeout: 60_000 })
    await openSession("브라우저 에이전트 시험")
    await page.waitForSelector('[data-testid="browser-pane"][data-attached]', { timeout: 30_000 })
    await page.waitForFunction(
      (count) => document.querySelectorAll(".own-browser-tab").length >= count,
      tabsBeforeReload,
      {
        timeout: 20_000,
      },
    )
    await Bun.sleep(1_000)
    winShot("after-reload")
    check("d.reattached-with-tabs", (await page.locator(".own-browser-tab").count()) >= tabsBeforeReload)
    report.finalMarks = await marks(page)

    // ------------------------------------------------------------ G-D3: [창 닫기] closes the window, the turn goes on
    await turn(desktopSession, `${MARK.closeWait} 느린 페이지를 다시 기다려 줘.`)
    await page.waitForSelector('[data-testid="browser-agent"][data-phase="operating"]', { timeout: 60_000 })
    await Bun.sleep(500)
    await browser.close()
    await powershell("window-close.ps1", ["-ProcessId", String(pid)])
    const closeShot = shots ? path.join(shots, `${label}-close-confirm-accept.png`) : undefined
    const accepted = await powershell("file-dialog.ps1", [
      "-ProcessId",
      String(pid),
      "-ButtonId",
      "100",
      ...(closeShot ? ["-Shot", closeShot] : []),
      "-TimeoutSeconds",
      "10",
    ])
    if (closeShot && existsSync(closeShot)) shotsTaken.push(closeShot)
    const closedAt = Date.now()
    const shellExited = await Promise.race([shell!.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
    const runningAfterClose = (await service.call("GET", "/api/session/active").catch(() => undefined)) as
      | { data?: unknown }
      | undefined
    await waitIdle(desktopSession)
    const finalInfo = (await sessionCall(desktopSession, "GET", "")) as { data?: { outcome?: string } }
    report.closeAccept = {
      dialog: accepted.out,
      shellExited,
      exitMs: Date.now() - closedAt,
      activeAfterClose: JSON.stringify(runningAfterClose?.data ?? null).includes(desktopSession),
      outcome: finalInfo.data?.outcome,
    }
    check("g-d3.close-confirm-accept-closes-window", accepted.out.includes("closed") && shellExited)
    check("g-d3.turn-survives-window-close", finalInfo.data?.outcome !== "interrupted")
  } finally {
    answering = false
    await answer.catch(() => undefined)
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
  const logs = collectLogs(shots ? path.join(shots, `${label}-logs`) : undefined)
  if (logs) {
    const { text, ...counts } = logs
    report.logs = counts
    // G14/MG8: the service password and its Basic value never reach the shell's logs.
    const basic = Buffer.from(`opencode:${password}`).toString("base64")
    check("secrets.not-in-shell-logs", !text.includes(password) && !text.includes(basic))
  }
  await service.stop().catch(() => undefined)
  await fake.stop().catch(() => undefined)
  server.stop(true)
  if (!appDataExisted) await removeTree(appData)
  else restoreSetting("ownCloseAction", closeActionBefore)
  report.osArtifactsCreated = removeNewOsArtifacts(machine.os)
  report.after = snapshotMachine()
  report.unchanged = sameMachine(machine, report.after as ReturnType<typeof snapshotMachine>)
  check("machine.unchanged", report.unchanged === true)
  report.checks = checks
  report.shots = shotsTaken
  report.passed = Object.values(checks).every(Boolean) && !report.error
  if (!args.keep) await removeTree(root)
  clearTimeout(watchdog)
  if (shots) writeFileSync(path.join(shots, `${label}-report.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
}

/** The file's text once no other process holds it (a copy may still be closing it), or undefined after 10 s. */
async function readWhenFree(file: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return readFileSync(file, "utf8")
    } catch {
      if (Date.now() > deadline) return undefined
      await Bun.sleep(200)
    }
  }
}

/** Runs one of this folder's PowerShell helpers (window-close.ps1, file-dialog.ps1). */
async function powershell(script: string, extra: string[]) {
  const child = Bun.spawn(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, script),
      ...extra,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const code = await child.exited
  return { code, out: (await new Response(child.stdout).text()).trim() }
}

function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) found.push(path.join(entry.parentPath, entry.name))
  }
  return found
}

/** One key of the packaged shell's settings store (userData\opencode.settings); undefined when it has none. */
function readSetting(key: string): unknown {
  if (!existsSync(settingsFile)) return undefined
  return (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>)[key]
}

/** Puts a key the run changed back as it was (removed when it had none), the store's tab-indented JSON. */
function restoreSetting(key: string, value: unknown) {
  if (!existsSync(settingsFile)) return
  const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>
  if (value === undefined) delete settings[key]
  else settings[key] = value
  writeFileSync(settingsFile, JSON.stringify(settings, null, "\t"))
}
