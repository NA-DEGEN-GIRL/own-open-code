// The browser pane on a paired device against the built shell (05 §8.10, §8.10.7): a real pane in a real window, the
// real hub in a test service, the test gateway opened by RPC on a free loopback port, a device paired with
// `read prompt browser`, and this script as that device's viewer (the socket own-web's view opens). Fake credentials
// only; one temp root (OWN_HOME, OWN_CONFIG_DIR, XDG_*, TEMP and the shell's userData) removed afterwards; every
// process started here is stopped. It runs `out/` (`bun run build`) unpackaged on the workspace's Electron with
// OPENCODE_DESKTOP_TEST_ROOT, off the screen (own-shell.ts OWN_DESKTOP_TEST_RUN).
//
//   bun scripts/remote-browser.ts --web <own-web build dir> [--shots <dir>] [--label remote-browser] [--keep]
//
// Only the renderer page is driven, through a bare CDP client (cdp-raw.ts): Playwright would attach to the pane's tab
// pages too and turn focus emulation on in them, which is one of the things measured here. The tab pages tell this
// script about themselves (clicks, scroll, the input's text, their viewport, user agent and visibility) by posting to
// the test site they were loaded from.
//
// Checks, each recorded with its numbers in the report:
//  - frames.*: frames reach the viewer while the page changes, with the pane on screen, after the window switched to
//    another session, with the window minimized, and with it hidden to the tray; frame rate, sizes and the shell's
//    CPU while streaming are recorded;
//  - input.*: a touch tap clicks, a drag scrolls, a tap focuses an input, compose/text put 한글 in it, Enter
//    submits, Ctrl+A and Backspace clear it, mouse and wheel work;
//  - action.*: navigate, back, reload, tabs.open, tabs.focus, tabs.close answer and show in the state; an address the
//    pane refuses answers its code;
//  - frames.started-in-hidden-window, surface.*: a tab made while the window sits in the tray (it never was on
//    screen) still streams, through the capture window, and its view is back when the window is opened again;
//  - caret.*, input.clipboard-*: a focused field rests (its caret does not blink while streamed) and gets its sharp
//    frame; a chord that would use the PC's clipboard is not typed;
//  - wanted.*, never-shown.*, capture-path.*: a session the window never showed is attached when a device with
//    `prompt` opens its browser (attaching → ready) without the window changing route or focus, its first tab streams
//    with the window shown, minimized and in the tray, and the way the frames came is recorded; a restore reaches the
//    app window, not the capture window, and takes the lent view back (window.restored-while-lent);
//  - prompt.*, deny.*, watch-only.*: a device's prompt finds the pane attached (the browser tools are in its first
//    step); a session whose rules take the browser away is left alone and its prompt does not wait; a device without
//    `prompt` sees `detached` and nothing is attached;
//  - phone.*: 휴대폰 크기로 보기 changes the page's viewport, pixel ratio, touch points and user agent, and they are
//    the PC's again after the view turns hidden, after the viewer closes, and after the device loses `browser`;
//  - dialog.*, chooser.*, download.*: a confirm() shows in the state and is answered; a file input opens no native
//    dialog and sends the notice; a download sends its notice.
import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { startFakeOpenAIResponses } from "../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { opencodeConfig } from "../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { RemoteBrowser } from "../../own-protocol/src/remote-browser"
import { BrowserGateway } from "../../own-remote/test/harness/browser-gateway"
import { RPC_HASH } from "../src/shared/rpc-hash"
import { cdpTargets, rawCdp, type RawCdp } from "./cdp-raw"
import { registerService } from "./dev-service"
import {
  alive,
  appDataDir,
  cleanEnv,
  freePort,
  installUi,
  killTree,
  osArtifacts,
  PACKAGE,
  removeNewOsArtifacts,
  shellVersion,
  xdgDirs,
} from "./run-kit"

const args = parseArgs({
  options: {
    web: { type: "string" },
    shots: { type: "string" },
    label: { type: "string", default: "remote-browser" },
    keep: { type: "boolean", default: false },
  },
}).values

if (!existsSync(path.join(PACKAGE, "out", "main", "index.js"))) throw new Error("run `bun run build` first")
if (!args.web || !existsSync(path.join(args.web, "index.html")))
  throw new Error("--web <own-web build dir> is required")
const label = args.label!
const version = shellVersion()
const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownDesktopRemoteBrowserFakeKey00001"
const PHONE = { width: 390, height: 800, dpr: 3 }

const root = path.join(os.tmpdir(), `own-desktop-remote-browser-${randomBytes(4).toString("hex")}`)
const xdg = xdgDirs(root)
const configDir = path.join(root, "config")
const shellTemp = path.join(root, "tmp")
mkdirSync(configDir, { recursive: true })
mkdirSync(shellTemp, { recursive: true })

const artifacts = osArtifacts()
const report: Record<string, unknown> = { label, root, rpcHash: RPC_HASH }
const checks: Record<string, boolean> = {}
const startedAt = Date.now()
/** Seconds since the run started, on every line: where a slow or stuck step is. */
const elapsed = () => `+${Math.round((Date.now() - startedAt) / 1000)}s`
const check = (name: string, value: boolean, detail?: unknown) => {
  checks[name] = value
  if (detail !== undefined) report[name] = detail
  console.error(
    `[remote-browser] ${elapsed()} ${value ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  )
}
const log = (message: string) => console.error(`[remote-browser] ${elapsed()} ${message}`)

// ---------------------------------------------------------------------------------------------------------------
// The test site: one page per name. It lays its controls out in viewport units, so a position is the same fraction of
// the frame at any size, and posts what happened in it to `/report/<name>`.

interface PageReport {
  readonly at: number
  readonly loads: number
  readonly clicks: number
  readonly scrollY: number
  readonly value: string
  readonly active: string
  readonly submitted: string | null
  readonly confirmed: boolean | null
  readonly fileClicks: number
  readonly touches: number
  readonly width: number
  readonly height: number
  readonly dpr: number
  readonly maxTouch: number
  readonly ua: string
  readonly visibility: string
  readonly focused: boolean
  readonly ticks: number
  readonly frames: number
}

const reports = new Map<string, PageReport>()
const loads = new Map<string, number>()
const PAGE = (name: string, tick: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title>
<style>
  body { margin: 0; font: 16px sans-serif; background: #f4f4f4; }
  .at { position: absolute; box-sizing: border-box; }
  #btn { left: 10vw; top: 10vh; width: 30vw; height: 10vh; }
  #dl { left: 50vw; top: 10vh; width: 40vw; height: 10vh; background: #cde; display: block; }
  #in { left: 10vw; top: 25vh; width: 60vw; height: 8vh; font-size: 16px; }
  #ask { left: 10vw; top: 40vh; width: 30vw; height: 8vh; }
  #file { left: 50vw; top: 40vh; width: 40vw; height: 8vh; }
  #tick { left: 10vw; top: 55vh; width: 80vw; height: 30vh; font-size: 40px; }
  #tall { position: absolute; top: 100vh; height: 3000px; width: 10px; }
</style></head><body>
<button id="btn" class="at">누르기</button>
<a id="dl" class="at" href="/download/${name}.txt" download>받기</a>
<form id="form"><input id="in" class="at" name="q" autocomplete="off"></form>
<button id="ask" class="at">확인창</button>
<input id="file" class="at" type="file">
<div id="tick" class="at">0</div>
<div id="tall"></div>
<script>
  const state = { clicks: 0, submitted: null, confirmed: null, fileClicks: 0, touches: 0, ticks: 0, frames: 0 }
  const field = document.getElementById("in")
  const send = () => fetch("/report/${name}", { method: "POST", keepalive: true, body: JSON.stringify({
    ...state, scrollY: Math.round(scrollY), value: field.value, active: document.activeElement?.id ?? "",
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio, maxTouch: navigator.maxTouchPoints,
    ua: navigator.userAgent, visibility: document.visibilityState, focused: document.hasFocus() }) }).catch(() => {})
  document.getElementById("btn").addEventListener("click", () => { state.clicks++; send() })
  document.getElementById("form").addEventListener("submit", (event) => { event.preventDefault(); state.submitted = field.value; send() })
  document.getElementById("ask").addEventListener("click", () => { state.confirmed = confirm("정말 할까요?"); send() })
  document.getElementById("file").addEventListener("click", () => { state.fileClicks++; send() })
  addEventListener("touchstart", () => { state.touches++ }, { passive: true })
  for (const name of ["input", "compositionupdate", "compositionend", "focusin"]) field.addEventListener(name, send)
  addEventListener("scroll", send, { passive: true })
  ${tick ? `setInterval(() => { state.ticks++; const box = document.getElementById("tick"); box.textContent = state.ticks; box.style.background = "hsl(" + (state.ticks * 11 % 360) + ",70%,60%)" }, 33);` : ""}
  ;(function frame() { state.frames++; requestAnimationFrame(frame) })()
  setInterval(send, 250)
  send()
</script></body></html>`

const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const [, kind, name = ""] = url.pathname.split("/")
    if (kind === "report" && request.method === "POST") {
      reports.set(name, { ...((await request.json()) as PageReport), at: Date.now(), loads: loads.get(name) ?? 0 })
      return new Response("ok")
    }
    if (kind === "download")
      return new Response("own-desktop remote-browser download\n", {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name}"`,
        },
      })
    if (kind !== "page" && kind !== "tick") return new Response("not found", { status: 404 })
    loads.set(name, (loads.get(name) ?? 0) + 1)
    return new Response(PAGE(name, kind === "tick"), { headers: { "content-type": "text/html; charset=utf-8" } })
  },
})
const siteUrl = `http://127.0.0.1:${site.port}`

/** The newest report of a page that came after `since`, once `done` accepts it. */
async function page(name: string, done: (value: PageReport) => boolean, ms = 8_000, since = 0) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = reports.get(name)
    if (value && value.at >= since && done(value)) return value
    if (Date.now() > deadline) return value
    await Bun.sleep(50)
  }
}

// ---------------------------------------------------------------------------------------------------------------

const fake = startFakeOpenAIResponses({ models: [MODEL] })
const service = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  // A source boot is CPU-bound; with other builds and tests on the PC it can take minutes (as split-panes.ts).
  startupTimeoutMs: 600_000,
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-desktop-remote-browser-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: fake.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
        {
          package: path.join(REPO_ROOT, "packages/own-remote"),
          options: {
            home: paths.ownHome,
            buildId: `own-desktop-remote-browser-${process.pid}`,
            sshDir: path.join(paths.root, "dot-ssh"),
            sshCommand: ["C:\\definitely\\not\\ssh.exe"],
            lingerSeconds: 0,
            // Off until this run opens it by RPC; it reaches this server through the registration written below.
            gateway: {
              registration: path.join(paths.root, "service-registration.json"),
              tailscaleCommand: null,
              portproxyCommand: null,
              vault: "memory",
            },
          },
        },
      ],
    }),
})
const password = atob(service.authorization.slice("Basic ".length)).slice("opencode:".length)
const ownHome = service.paths.ownHome
const control = path.join(ownHome, "control")
mkdirSync(control, { recursive: true })
mkdirSync(path.join(service.paths.root, "dot-ssh"), { recursive: true })

const remote = async <T = Record<string, unknown>>(method: string, input: unknown = {}) => {
  const response = await service.request("POST", `/api/rpc/own.remote/${method}`, {
    body: { input },
    query: { "location[directory]": control },
    directory: control,
  })
  const body = (await response.json().catch(() => ({}))) as { output?: T }
  if (!response.ok) throw new Error(`own.remote ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output as T
}

let shell: ReturnType<typeof Bun.spawn> | undefined
let renderer: RawCdp | undefined
const views: BrowserGateway.ViewerClient[] = []
const appData = appDataDir()
const appDataExisted = existsSync(appData)
const watchdog = setTimeout(async () => {
  log("watchdog: the run took too long; stopping everything")
  if (shell) killTree(shell.pid)
  killTree(service.pid)
  site.stop(true)
  if (!appDataExisted) await removeTree(appData)
  await removeTree(root)
  await removeTree(service.paths.root)
  process.exit(2)
}, 20 * 60_000)

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
  const sessions = { a: await createSession("원격 브라우저 A"), b: await createSession("원격 브라우저 B") }
  // Sessions the window never shows (made through the service, as a phone's would be): their panes are attached only
  // because a device asks (05 §8.10.4, own-web wanted.ts).
  const never = {
    shown: await createSession("안 본 대화 1"),
    minimized: await createSession("안 본 대화 2"),
    hidden: await createSession("안 본 대화 3"),
    prompt: await createSession("안 본 대화 4"),
    deny: await createSession("안 본 대화 5", [{ action: "browser", resource: "*", effect: "deny" }]),
    watchOnly: await createSession("안 본 대화 6"),
  }
  const rulesOf = async (sessionID: string) =>
    (
      (await service.call("GET", `/api/session/${sessionID}`)) as {
        data: { permissions?: { action?: string; effect?: string }[] }
      }
    ).data.permissions ?? []
  const allowsBrowser = async (sessionID: string) =>
    (await rulesOf(sessionID)).some((rule) => rule.action === "browser" && rule.effect === "allow")
  await registerService({
    url: service.url,
    authorization: service.authorization,
    password,
    stateHome: xdg.XDG_STATE_HOME,
    channel: "own",
  })
  installUi(ownHome, { version, web: args.web, hash: RPC_HASH })

  // The test gateway on a free loopback port, and a device paired as the app pairs (Bearer), `browser` granted.
  writeFileSync(
    path.join(service.paths.root, "service-registration.json"),
    JSON.stringify({ url: service.url, password }),
  )
  const plan = await remote<{ nonce: string }>("gateway.configure.plan", { port: await freeTcpPort() })
  const opened = await remote<{ state: string; url: string }>("gateway.configure.execute", { nonce: plan.nonce })
  if (opened.state !== "listening") throw new Error(`gateway: ${JSON.stringify(opened)}`)
  const base = opened.url
  const pair = async (name: string, scopes: string[]) => {
    const started = await remote<{ url: string; pairingId: string }>("devices.pair.start", {
      name,
      scopes,
      servers: { mode: "all" },
      expiresDays: 30,
    })
    const link = (await (await fetch(started.url, { headers: { accept: "application/json" } })).json()) as {
      claim: string
      sas: string
    }
    await remote("devices.pair.approve", { pairingId: started.pairingId, sas: link.sas })
    const got = (await (
      await fetch(`${base}/own/pairing/claim`, {
        method: "POST",
        headers: { "x-own-pairing": link.claim, "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { deviceId: string; token: string }
    return { ...got, auth: { authorization: `Bearer ${got.token}` } }
  }
  const claimed = await pair("시험 휴대폰", ["read", "prompt", "browser"])
  const device = claimed
  // A device that may look and not touch: `browser` without `prompt`.
  const watcher = await pair("보기만 하는 기기", ["read", "browser"])
  report.gateway = base

  const cdp = await freePort()
  const env = cleanEnv({ ...xdg, OWN_HOME: ownHome, OWN_CONFIG_DIR: configDir, TEMP: shellTemp, TMP: shellTemp })
  const electron = createRequire(import.meta.url)("electron") as unknown as string
  // Off the screen and the taskbar, with Windows' occlusion tracking off so the off-screen window and its native
  // views paint (split-panes.ts). The shell ends when this run is gone.
  shell = Bun.spawn([electron, PACKAGE, "--disable-features=CalculateNativeWinOcclusion"], {
    env: {
      ...env,
      OPENCODE_DESKTOP_TEST_ROOT: path.join(root, "desktop"),
      OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdp),
      OWN_DESKTOP_TEST_RUN: String(process.pid),
    },
    stdout: "ignore",
    stderr: "ignore",
  })
  const pid = shell.pid
  renderer = await connectRenderer(`http://127.0.0.1:${cdp}`, 120_000)
  const ui = renderer
  await until(() => ui.evaluate<boolean>(`!!document.querySelector('[data-testid="app"]')`), 60_000)
  await until(
    () =>
      ui.evaluate<boolean>(
        `["own:t0:connect","own:t0:ready"].every((name) => performance.getEntriesByName(name, "mark").length > 0)`,
      ),
    60_000,
  )

  /** A real click on the element (CDP input on the renderer page only). */
  const click = async (selector: string, text?: string) => {
    const box = await ui.evaluate<{ x: number; y: number } | null>(
      `(() => { const item = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${
        text === undefined ? "true" : `el.textContent.includes(${JSON.stringify(text)})`
      }); if (!item) return null; item.scrollIntoView({ block: "center" }); const r = item.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
    )
    if (!box) return false
    for (const type of ["mousePressed", "mouseReleased"])
      await ui.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 })
    return true
  }
  const openSession = async (title: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await click('[data-testid="session-row"]', title)
      const ok = await until(
        () =>
          ui.evaluate<boolean>(
            `[...document.querySelectorAll('[data-testid="session-row"][aria-current="page"]')].some((el) => el.textContent.includes(${JSON.stringify(title)}))`,
          ),
        5_000,
      )
      if (ok) return
    }
    throw new Error(`could not open ${title}`)
  }
  /** The app's own chord for the browser pane, typed in the focused pane's composer. */
  const openBrowser = async () => {
    await ui.evaluate(`document.querySelector("#own-composer-input")?.focus()`)
    const key = { key: "B", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 10 }
    await ui.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key })
    await ui.send("Input.dispatchKeyEvent", { type: "keyUp", ...key })
    const attached = await until(
      () => ui.evaluate<boolean>(`!!document.querySelector('[data-testid="browser-pane"][data-attached]')`),
      30_000,
    )
    if (!attached) throw new Error("the browser pane did not attach")
  }

  await openSession("원격 브라우저 A")
  await openBrowser()

  // ---- the device's viewer
  const watch = async (
    sessionID: string,
    hello: Parameters<BrowserGateway.ViewerClient["hello"]>[0] = {},
    from: { readonly auth: Readonly<Record<string, string>> } = device,
  ) => {
    const view = BrowserGateway.viewer(base, from, sessionID)
    views.push(view)
    // What own-web's view does: every drawn frame is acknowledged.
    view.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") return
      const frame = RemoteBrowser.decodeFrame(new Uint8Array(event.data as ArrayBuffer))
      if (frame) view.send({ t: "ack", seq: frame.header.seq })
    })
    view.hello({ viewport: PHONE, ...hello })
    await view.ready()
    return view
  }
  const states = (view: BrowserGateway.ViewerClient) =>
    view.messages.flatMap((message) => (message.t === "state" ? [message.state] : []))
  const counter = { action: 0 }
  const act = async (view: BrowserGateway.ViewerClient, action: RemoteBrowser.Action) => {
    const id = ++counter.action
    view.send({ t: "action", id, action })
    return view.until(
      () => view.messages.flatMap((message) => (message.t === "result" && message.id === id ? [message] : []))[0],
      20_000,
    )
  }
  const input = (view: BrowserGateway.ViewerClient, ...events: RemoteBrowser.InputEvent[]) =>
    view.send({ t: "input", events })
  const tap = (view: BrowserGateway.ViewerClient, x: number, y: number) =>
    input(view, { k: "touch", phase: "start", points: [{ id: 0, x, y }] }, { k: "touch", phase: "end", points: [] })
  const notices = (view: BrowserGateway.ViewerClient, kind: RemoteBrowser.Notice) =>
    view.messages.filter((message) => message.t === "notice" && message.kind === kind).length

  const view = await watch(sessions.a)
  const ready = await view.state("ready").then(
    () => true,
    () => false,
  )
  check("view.ready", ready, { state: states(view).at(-1) })

  // ---- actions: navigate (opens the first tab), and what the state says
  const opened1 = await act(view, { type: "navigate", url: `${siteUrl}/page/a` })
  const first = await page("a", (value) => value.loads >= 1)
  check("action.navigate", opened1.ok && !!first, {
    result: opened1,
    page: first && { width: first.width, height: first.height, dpr: first.dpr },
  })
  const pc = first!
  report.pc = {
    width: pc.width,
    height: pc.height,
    dpr: pc.dpr,
    maxTouch: pc.maxTouch,
    ua: pc.ua,
    focused: pc.focused,
    visibility: pc.visibility,
  }
  // The pane is laid out a moment after its first load: the state follows the page's own size, scrollbar included.
  const shown = await view
    .until(() => {
      const now = reports.get("a")
      return states(view).findLast(
        (item) => !!now && item.page?.mode === "pc" && item.page.width === now.width && item.page.height === now.height,
      )
    }, 10_000)
    .catch(() => undefined)
  check("state.page", !!shown && shown.tabs.some((tab) => tab.url === `${siteUrl}/page/a`), {
    state: states(view).at(-1)?.page,
    page: reports.get("a") && { width: reports.get("a")!.width, height: reports.get("a")!.height },
  })
  const still = await view
    .until(() => view.frames.findLast((frame) => frame.header.sharp), 10_000)
    .catch(() => undefined)
  const quick = view.frames.findLast((frame) => !frame.header.sharp)
  const ratio = (frame: { readonly header: RemoteBrowser.FrameHeader } | undefined) =>
    frame ? frame.header.width / frame.header.height : 0
  // A screencast frame and the sharp screenshot show the same viewport.
  check("frames.sharp-at-rest", !!still && !!quick && Math.abs(ratio(still) - ratio(quick)) < 0.01, {
    sharp: still && { width: still.header.width, height: still.header.height, bytes: still.jpeg.byteLength },
    quick: quick && { width: quick.header.width, height: quick.header.height, bytes: quick.jpeg.byteLength },
  })

  // A page that rests sends nothing more (the sharp screenshot makes Chromium draw again; that frame is no change).
  await Bun.sleep(600)
  const resting = view.frames.length
  await Bun.sleep(2_500)
  check("frames.none-while-resting", view.frames.length === resting, { more: view.frames.length - resting })

  // ---- input on the page at its PC size (no touch emulation)
  const before = reports.get("a")!
  tap(view, 0.25, 0.15)
  const tapped = await page("a", (value) => value.clicks === before.clicks + 1)
  check("input.touch-tap-clicks", tapped?.clicks === before.clicks + 1, {
    clicks: tapped?.clicks,
    touchEvents: tapped?.touches,
    maxTouch: tapped?.maxTouch,
  })
  input(
    view,
    { k: "touch", phase: "start", points: [{ id: 0, x: 0.8, y: 0.9 }] },
    ...[0.8, 0.7, 0.6, 0.5, 0.4, 0.3].map(
      (y): RemoteBrowser.InputEvent => ({ k: "touch", phase: "move", points: [{ id: 0, x: 0.8, y }] }),
    ),
  )
  await Bun.sleep(150)
  // Sent apart from the start, so the moves are not folded into one.
  for (const y of [0.25, 0.2, 0.15, 0.1]) {
    input(view, { k: "touch", phase: "move", points: [{ id: 0, x: 0.8, y }] })
    await Bun.sleep(40)
  }
  input(view, { k: "touch", phase: "end", points: [] })
  const scrolled = await page("a", (value) => value.scrollY > 50)
  check("input.touch-drag-scrolls", (scrolled?.scrollY ?? 0) > 50, { scrollY: scrolled?.scrollY })
  input(view, { k: "wheel", x: 0.5, y: 0.5, dx: 0, dy: -5000 })
  const top = await page("a", (value) => value.scrollY === 0)
  check("input.wheel-scrolls", top?.scrollY === 0, { scrollY: top?.scrollY })
  tap(view, 0.4, 0.29)
  const focused = await page("a", (value) => value.active === "in")
  check("input.touch-focuses-input", focused?.active === "in", {
    active: focused?.active,
    documentHasFocus: focused?.focused,
  })
  // 한 (ㅎ → 하 → 한), committed, then ㄱ composing: exactly 한 + ㄱ.
  input(view, { k: "compose", text: "ㅎ" }, { k: "compose", text: "하" }, { k: "compose", text: "한" })
  const composing = await page("a", (value) => value.value === "한")
  input(view, { k: "text", text: "한" })
  await Bun.sleep(300)
  const committed = await page("a", (value) => value.value === "한", 3_000, Date.now())
  input(view, { k: "compose", text: "ㄱ" })
  const next = await page("a", (value) => value.value === "한ㄱ")
  check("input.korean-compose", composing?.value === "한" && committed?.value === "한" && next?.value === "한ㄱ", {
    composing: composing?.value,
    committed: committed?.value,
    next: next?.value,
  })
  input(view, { k: "compose", text: "그" }, { k: "compose", text: "글" }, { k: "text", text: "글" })
  const word = await page("a", (value) => value.value === "한글")
  check("input.korean-text", word?.value === "한글", { value: word?.value })
  input(view, { k: "key", key: "Enter" })
  const submitted = await page("a", (value) => value.submitted === "한글")
  check("input.enter-submits", submitted?.submitted === "한글", { submitted: submitted?.submitted })
  input(view, { k: "key", key: "a", ctrl: true }, { k: "key", key: "Backspace" })
  const emptied = await page("a", (value) => value.value === "")
  check("input.chord-select-all", emptied?.value === "", { value: emptied?.value })
  input(
    view,
    { k: "key", key: "a" },
    { k: "key", key: "B", shift: true },
    { k: "key", key: "ArrowLeft" },
    { k: "key", key: "7" },
  )
  const typed = await page("a", (value) => value.value === "a7B")
  check("input.keys-type", typed?.value === "a7B", { value: typed?.value })
  // A focused text field rests: the caret of a streamed page does not blink (remote-caret.ts), so the sharp frame
  // arrives and stays. Before that a blinking caret sent 6 quick frames (36 KB) in 3 s and never a sharp one.
  await Bun.sleep(1_500)
  const caretFrom = view.frames.length
  await Bun.sleep(3_000)
  const caret = {
    focused: reports.get("a")?.active,
    in3s: view.frames.length - caretFrom,
    bytes: view.frames.slice(caretFrom).reduce((sum, frame) => sum + frame.jpeg.byteLength, 0),
    lastIsSharp: view.frames.at(-1)?.header.sharp === true,
  }
  check("caret.field-rests-with-sharp-frame", caret.focused === "in" && caret.in3s === 0 && caret.lastIsSharp, caret)
  // Chords that would use the PC's clipboard are not typed: a cut would have emptied the selected field.
  input(
    view,
    { k: "key", key: "a", ctrl: true },
    { k: "key", key: "x", ctrl: true },
    { k: "key", key: "Delete", shift: true },
  )
  await Bun.sleep(700)
  const kept = await page("a", (value) => value.value === "a7B", 2_000, Date.now())
  check("input.clipboard-chords-dropped", kept?.value === "a7B", { value: kept?.value })
  const clicksBefore = reports.get("a")!.clicks
  input(
    view,
    { k: "mouse", phase: "move", x: 0.25, y: 0.15, button: "none" },
    { k: "mouse", phase: "down", x: 0.25, y: 0.15, button: "left", clicks: 1 },
    { k: "mouse", phase: "up", x: 0.25, y: 0.15, button: "left", clicks: 1 },
  )
  const clicked = await page("a", (value) => value.clicks === clicksBefore + 1)
  check("input.mouse-clicks", clicked?.clicks === clicksBefore + 1, { clicks: clicked?.clicks })
  report.focusAfterInput = {
    documentHasFocus: reports.get("a")?.focused,
    windowFocused: await ui.evaluate<boolean>("document.hasFocus()"),
  }

  // ---- dialog, file chooser, download
  tap(view, 0.25, 0.44)
  const asked = await view.until(() => states(view).find((item) => item.dialog !== null), 8_000).catch(() => undefined)
  check("dialog.in-state", asked?.dialog?.type === "confirm" && asked.dialog.message === "정말 할까요?", asked?.dialog)
  const answered = await act(view, { type: "dialog", accept: true })
  const confirmed = await page("a", (value) => value.confirmed === true)
  const closed = await view
    .until(() => (states(view).at(-1)!.dialog === null ? true : undefined), 5_000)
    .catch(() => false)
  check("dialog.answered", answered.ok && confirmed?.confirmed === true && closed === true, {
    result: answered,
    confirmed: confirmed?.confirmed,
  })
  const windowsBefore = topWindows(pid)
  tap(view, 0.55, 0.44)
  const chooser = await view
    .until(() => (notices(view, "file_chooser") > 0 ? true : undefined), 8_000)
    .catch(() => false)
  await Bun.sleep(700)
  const windowsAfter = topWindows(pid)
  check(
    "chooser.notice-and-no-dialog",
    chooser === true && windowsAfter.dialogs === windowsBefore.dialogs && windowsAfter.count === windowsBefore.count,
    {
      notice: chooser,
      fileClicks: reports.get("a")?.fileClicks,
      before: windowsBefore,
      after: windowsAfter,
    },
  )
  tap(view, 0.7, 0.15)
  const download = await view.until(() => (notices(view, "download") > 0 ? true : undefined), 8_000).catch(() => false)
  check("download.notice", download === true)

  // ---- more actions
  const second = await act(view, { type: "navigate", url: `${siteUrl}/page/a2` })
  const onSecond = await page("a2", (value) => value.loads >= 1)
  const back = await act(view, { type: "back" })
  const loadsBack = loads.get("a") ?? 0
  const wentBack = await view
    .until(
      () =>
        states(view)
          .at(-1)!
          .tabs.some((tab) => tab.url === `${siteUrl}/page/a` && tab.canGoForward)
          ? true
          : undefined,
      8_000,
    )
    .catch(() => false)
  check("action.back", second.ok && !!onSecond && back.ok && wentBack === true, { second, back })
  const reload = await act(view, { type: "reload" })
  const reloaded = await until(async () => (loads.get("a") ?? 0) > loadsBack, 8_000)
  check("action.reload", reload.ok && reloaded, { result: reload, loads: loads.get("a") })
  const opened2 = await act(view, { type: "tabs.open", url: `${siteUrl}/page/two` })
  const two = await view
    .until(
      () =>
        states(view).find(
          (item) =>
            item.tabs.length === 2 &&
            item.tabs.find((tab) => tab.id === item.focusedTabID)?.url === `${siteUrl}/page/two`,
        ),
      10_000,
    )
    .catch(() => undefined)
  check("action.tabs-open", opened2.ok && !!two, { result: opened2, tabs: two?.tabs.map((tab) => tab.url) })
  const firstTab = two?.tabs.find((tab) => tab.url === `${siteUrl}/page/a`)?.id ?? ""
  const secondTab = two?.focusedTabID ?? ""
  const refocus = await act(view, { type: "tabs.focus", tabID: firstTab })
  const refocused = await view
    .until(() => (states(view).at(-1)!.focusedTabID === firstTab ? true : undefined), 8_000)
    .catch(() => false)
  check("action.tabs-focus", refocus.ok && refocused === true, { result: refocus })
  const close = await act(view, { type: "tabs.close", tabID: secondTab })
  const one = await view
    .until(() => (states(view).at(-1)!.tabs.length === 1 ? true : undefined), 8_000)
    .catch(() => false)
  check("action.tabs-close", close.ok && one === true, { result: close })
  const refused = await act(view, { type: "navigate", url: `http://user:secret@127.0.0.1:${site.port}/page/a` })
  check("action.refused-address", !refused.ok && refused.error === "browser.address.credentials", refused)

  // ---- 휴대폰 크기로 보기
  const isPhone = (value: PageReport) =>
    value.width === PHONE.width && value.dpr === PHONE.dpr && value.maxTouch > 0 && value.ua.includes("Android")
  // The PC's own values now: the pane was laid out since the first report.
  const own = reports.get("a")!
  const isPc = (value: PageReport) =>
    value.width === own.width &&
    value.height === own.height &&
    value.dpr === own.dpr &&
    value.maxTouch === own.maxTouch &&
    value.ua === own.ua
  const numbers = (value: PageReport | undefined) =>
    value && { width: value.width, height: value.height, dpr: value.dpr, maxTouch: value.maxTouch, ua: value.ua }
  view.send({ t: "view", mode: "phone" })
  const phone = await page("a", isPhone)
  const phoneState = await view
    .until(() => states(view).find((item) => item.page?.mode === "phone"), 8_000)
    .catch(() => undefined)
  check("phone.emulated", !!phone && isPhone(phone) && phoneState?.page?.width === PHONE.width, {
    page: numbers(phone),
    state: phoneState?.page,
  })
  const phoneFrame = await view
    .until(() => view.frames.findLast((frame) => frame.header.height > frame.header.width), 8_000)
    .catch(() => undefined)
  check(
    "phone.frame-is-portrait",
    !!phoneFrame,
    phoneFrame && { width: phoneFrame.header.width, height: phoneFrame.header.height, sharp: phoneFrame.header.sharp },
  )
  const phoneClicks = reports.get("a")!.clicks
  tap(view, 0.25, 0.15)
  const phoneTap = await page("a", (value) => value.clicks === phoneClicks + 1)
  check("phone.touch-tap-clicks", phoneTap?.clicks === phoneClicks + 1, {
    clicks: phoneTap?.clicks,
    touchEvents: phoneTap?.touches,
  })
  view.send({ t: "view", visible: false })
  const afterHidden = await page("a", isPc)
  check("phone.cleared-when-hidden", !!afterHidden && isPc(afterHidden), numbers(afterHidden))
  view.send({ t: "view", visible: true })
  await page("a", isPhone)
  view.close()
  const afterClose = await page("a", isPc)
  check("phone.cleared-when-closed", !!afterClose && isPc(afterClose), numbers(afterClose))

  // ---- frames while the page changes: on screen, behind another session, minimized, hidden to the tray
  const tick = await watch(sessions.a, { quality: "auto" })
  await tick.state("ready")
  const ticking = await act(tick, { type: "navigate", url: `${siteUrl}/tick/t` })
  await page("t", (value) => value.ticks > 10)
  const measure = async (name: string, seconds = 6, from = tick, site = "t") => {
    await Bun.sleep(1_200)
    const start = { frames: from.frames.length, at: Date.now(), cpu: cpuTimes(pid), page: reports.get(site)! }
    await Bun.sleep(seconds * 1000)
    const frames = from.frames.slice(start.frames)
    const elapsed = (Date.now() - start.at) / 1000
    const cpu = cpuTimes(pid)
    const end = reports.get(site)!
    const result = {
      frames: frames.length,
      fps: Math.round((frames.length / elapsed) * 10) / 10,
      sharp: frames.filter((frame) => frame.header.sharp).length,
      size: frames[0] ? `${frames[0].header.width}x${frames[0].header.height}` : "",
      avgBytes: frames.length
        ? Math.round(frames.reduce((sum, frame) => sum + frame.jpeg.byteLength, 0) / frames.length)
        : 0,
      // Percent of one core: the shell's main process, and its whole tree (renderer, GPU, the tab).
      cpuMain: Math.round(((cpu.main - start.cpu.main) / (elapsed * 1000)) * 1000) / 10,
      cpuTree: Math.round(((cpu.tree - start.cpu.tree) / (elapsed * 1000)) * 1000) / 10,
      pageVisibility: end.visibility,
      pageTicksPerSecond: Math.round((end.ticks - start.page.ticks) / elapsed),
      pageFramesPerSecond: Math.round((end.frames - start.page.frames) / elapsed),
    }
    check(`frames.${name}`, frames.length >= seconds, result)
    return result
  }
  check("action.navigate-ticking", ticking.ok)
  await measure("on-screen")
  // The same changing page with nobody watching: what the shell costs without the stream.
  tick.send({ t: "view", visible: false })
  await Bun.sleep(1_500)
  const idleStart = { at: Date.now(), cpu: cpuTimes(pid) }
  await Bun.sleep(5_000)
  const idleCpu = cpuTimes(pid)
  const idleElapsed = Date.now() - idleStart.at
  report["cpu.not-watched"] = {
    cpuMain: Math.round(((idleCpu.main - idleStart.cpu.main) / idleElapsed) * 1000) / 10,
    cpuTree: Math.round(((idleCpu.tree - idleStart.cpu.tree) / idleElapsed) * 1000) / 10,
  }
  log(`cpu.not-watched ${JSON.stringify(report["cpu.not-watched"])}`)
  tick.send({ t: "view", visible: true })
  await Bun.sleep(500)
  await openSession("원격 브라우저 B")
  await measure("window-shows-another-session")
  windowInput(pid, "minimize")
  await measure("window-minimized")
  windowInput(pid, "restore")
  await Bun.sleep(500)
  // The caption's X on the last window hides it to the tray (05 §7.3).
  const title = await ui.evaluate<string>("document.title")
  powershell("", path.join(import.meta.dir, "tray-input.ps1"), [
    "-ProcessId",
    String(pid),
    "-Action",
    "close",
    "-Title",
    title,
  ])
  await Bun.sleep(1_500)
  report.hiddenWindows = topWindows(pid)
  check("window.hidden-to-tray", alive(pid) && topWindows(pid).shown < windowsBefore.shown, report.hiddenWindows)
  await measure("window-hidden-to-tray")
  // Input still reaches the page of a hidden window, without showing or focusing it.
  await act(tick, { type: "navigate", url: `${siteUrl}/page/h` })
  const hiddenPage = await page("h", (value) => value.loads >= 1)
  tap(tick, 0.25, 0.15)
  const hiddenTap = await page("h", (value) => value.clicks === 1)
  tap(tick, 0.4, 0.29)
  await page("h", (value) => value.active === "in")
  input(tick, { k: "compose", text: "하" }, { k: "text", text: "한글" })
  const hiddenText = await page("h", (value) => value.value === "한글")
  check("input.hidden-window", !!hiddenPage && hiddenTap?.clicks === 1 && hiddenText?.value === "한글", {
    clicks: hiddenTap?.clicks,
    value: hiddenText?.value,
    visibility: hiddenText?.visibility,
    windows: topWindows(pid),
  })

  // What a phone does while the PC's app sits in the tray: it opens the browser of a session whose tab never was on
  // screen. The tab is made in the hidden window, so its screencast starts on a page Chromium counts as hidden.
  const late = await watch(sessions.b)
  await late.state("ready")
  const lateOpen = await act(late, { type: "navigate", url: `${siteUrl}/tick/late` })
  await page("late", (value) => value.ticks > 10)
  check("action.navigate-in-hidden-window", lateOpen.ok)
  await measure("started-in-hidden-window", 8, late, "late")
  // The PC user opens the window from the tray: the tab's view is back in it by then, and the stream goes on.
  powershell("", path.join(import.meta.dir, "tray-input.ps1"), [
    "-ProcessId",
    String(pid),
    "-Action",
    "tray",
    "-Mouse",
    "click",
  ])
  await Bun.sleep(1_500)
  check("window.reopened-from-tray", alive(pid) && topWindows(pid).shown > 0, topWindows(pid))
  await measure("after-window-reopened", 5, late, "late")
  const surface = shellLog(path.join(root, "desktop")).filter((line) => line.includes("capture window"))
  check(
    "surface.lent-then-returned",
    surface.some((line) => line.includes("lent to")) && surface.at(-1)?.includes("returned from") === true,
    surface.map((line) => line.replace(/^.*remote browser: /, "")),
  )
  late.close()

  // ---- sessions the window has never shown: the pane is attached because the device asks (05 §8.10.4)
  const windowState = () =>
    ui.evaluate<{ href: string; current: string; active: string }>(
      `({ href: location.href, current: document.querySelector('[data-testid="session-row"][aria-current="page"]')?.getAttribute("data-session-id") ?? "", active: document.activeElement?.id || document.activeElement?.tagName || "" })`,
    )
  const wanted = async (label: keyof typeof never, site: string) => {
    const sessionID = never[label]
    const logFrom = shellLog(path.join(root, "desktop")).length
    const before = await windowState()
    const asked = Date.now()
    const fresh = await watch(sessionID)
    const ready = await fresh
      .until(() => states(fresh).find((item) => item.host === "ready"), 20_000)
      .catch(() => undefined)
    const attachMs = Date.now() - asked
    const hosts = [...new Set(states(fresh).map((item) => item.host))]
    check(
      `wanted.${label}.attaching-then-ready`,
      !!ready && hosts[0] === "attaching" && (await allowsBrowser(sessionID)),
      {
        hosts,
        attachMs,
      },
    )
    const tab = await act(fresh, { type: "tabs.open", url: `${siteUrl}/tick/${site}` })
    const loaded = await page(site, (value) => value.ticks > 10, 15_000)
    if (!loaded)
      check(`frames.never-shown.${label}`, false, {
        tab,
        reason: "the page never loaded",
        served: loads.get(site) ?? 0,
        tabs: states(fresh).at(-1)?.tabs,
      })
    const result = loaded ? await measure(`never-shown.${label}`, 6, fresh, site) : { fps: 0 }
    const windows = topWindows(pid)
    const after = await windowState()
    // The window still shows 원격 브라우저 B, with the same focus.
    check(
      `wanted.${label}.window-untouched`,
      before.current === sessions.b && JSON.stringify(after) === JSON.stringify(before),
      { before, after },
    )
    // Which way the frames came: a screenshot woke the screencast, or the tab's view was lent to the capture window.
    const lines = shellLog(path.join(root, "desktop"))
      .slice(logFrom)
      .filter((line) => line.includes("tab view") || line.includes("capture window"))
      .map((line) => line.replace(/^.*remote browser: /, "").replace(/sessionID: '[^']*', /, ""))
    report[`capture-path.${label}`] = { tabOpen: tab.ok, lines, fps: result.fps, windows }
    log(`capture-path.${label} ${JSON.stringify({ lines, windows })}`)
    return fresh
  }
  const freshShown = await wanted("shown", "n1")
  freshShown.close()
  windowInput(pid, "minimize")
  await Bun.sleep(800)
  const freshMinimized = await wanted("minimized", "n2")
  const returnedFrom = shellLog(path.join(root, "desktop")).length
  // The capture window is shown (off the screen) while the app window is minimized: the restore is the app window's.
  const restored = windowInput(pid, "restore")
  await Bun.sleep(800)
  const returned = shellLog(path.join(root, "desktop"))
    .slice(returnedFrom)
    .some((line) => line.includes("returned from the capture window"))
  check("window.restored-while-lent", restored.iconic === false && returned && topWindows(pid).capture === 0, {
    restored,
    returned,
    windows: topWindows(pid),
  })
  await measure("never-shown.minimized-then-restored", 4, freshMinimized, "n2")
  freshMinimized.close()
  powershell("", path.join(import.meta.dir, "tray-input.ps1"), [
    "-ProcessId",
    String(pid),
    "-Action",
    "close",
    "-Title",
    await ui.evaluate<string>("document.title"),
  ])
  await Bun.sleep(1_500)
  check("window.hidden-to-tray-again", alive(pid) && topWindows(pid).shown === 0, topWindows(pid))
  const freshHidden = await wanted("hidden", "n3")
  powershell("", path.join(import.meta.dir, "tray-input.ps1"), [
    "-ProcessId",
    String(pid),
    "-Action",
    "tray",
    "-Mouse",
    "click",
  ])
  await Bun.sleep(1_500)
  await measure("never-shown.hidden-then-reopened", 4, freshHidden, "n3")
  freshHidden.close()

  // ---- a device's prompt (05 §8.10.5 rule 2): the gateway has the pane attached before it relays the prompt
  const promptVia = async (sessionID: string, text: string) => {
    const at = Date.now()
    const response = await fetch(`${base}/srv/local/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { ...device.auth, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
    return { status: response.status, ms: Date.now() - at }
  }
  /** The model requests of a prompt (its step, and the title's), and whether the browser tools were offered. */
  const firstStep = async (marker: string) => {
    await fake.waitForRequests(1, { timeoutMs: 20_000, filter: (item) => item.body.includes(marker) }).catch(() => [])
    await Bun.sleep(2_000)
    const sent = fake.requests.filter((item) => item.body.includes(marker))
    return sent.length
      ? {
          requests: sent.length,
          browserTools: sent.some((item) => item.body.includes("Desktop browser tools")),
          mentions: Math.max(...sent.map((item) => item.body.split("browser").length - 1)),
        }
      : undefined
  }
  const hostedPrompt = await promptVia(sessions.a, "기준 프롬프트 mbrw-base")
  const baseStep = await firstStep("mbrw-base")
  const hadRule = await allowsBrowser(never.prompt)
  const freshPrompt = await promptVia(never.prompt, "새 대화 프롬프트 mbrw-fresh")
  const freshStep = await firstStep("mbrw-fresh")
  check(
    "prompt.pane-attached-first",
    freshPrompt.status === 200 && !hadRule && (await allowsBrowser(never.prompt)) && freshStep?.browserTools === true,
    {
      hosted: hostedPrompt,
      hostedStep: baseStep?.browserTools,
      fresh: freshPrompt,
      freshStep: freshStep?.browserTools,
      addedMs: freshPrompt.ms - hostedPrompt.ms,
    },
  )
  // A session whose rules take the browser away is never attached: the viewer waits, the prompt does not.
  const denied = await watch(never.deny)
  await Bun.sleep(6_000)
  const deniedHosts = [...new Set(states(denied).map((item) => item.host))]
  const deniedPrompt = await promptVia(never.deny, "막힌 대화 프롬프트 mbrw-deny")
  const deniedStep = await firstStep("mbrw-deny")
  check(
    "deny.not-attached",
    deniedHosts.join() === "attaching" &&
      deniedPrompt.status === 200 &&
      deniedPrompt.ms < 1_500 &&
      !(await allowsBrowser(never.deny)) &&
      deniedStep?.browserTools === false,
    { hosts: deniedHosts, prompt: deniedPrompt, step: deniedStep?.browserTools },
  )
  denied.close()
  // A device without `prompt` may not ask for a pane: it sees that there is none.
  const looking = await watch(never.watchOnly, {}, watcher)
  await Bun.sleep(4_000)
  const lookingHosts = [...new Set(states(looking).map((item) => item.host))]
  const stillWanted = await remote<{ sessionIDs: string[] }>("browser.pane.wanted")
  check(
    "watch-only.detached",
    lookingHosts.join() === "detached" &&
      !stillWanted.sessionIDs.includes(never.watchOnly) &&
      !(await allowsBrowser(never.watchOnly)),
    { hosts: lookingHosts, wanted: stillWanted.sessionIDs.length },
  )
  looking.close()

  // ---- the PC takes `browser` away while the device holds the page phone-sized: within one pull it is the PC's again
  tick.send({ t: "view", mode: "phone" })
  const heldPhone = await page("h", isPhone)
  const revokedAt = Date.now()
  await remote("devices.update", { deviceId: claimed.deviceId, scopes: ["read", "prompt"] })
  const end = await Promise.race([tick.closed, Bun.sleep(5_000).then(() => undefined)])
  const afterRevoke = await page("h", isPc, 8_000, revokedAt)
  check(
    "revoke.stops-and-clears",
    !!heldPhone && isPhone(heldPhone) && end?.code === RemoteBrowser.CLOSE.scope && !!afterRevoke && isPc(afterRevoke),
    {
      held: numbers(heldPhone),
      heldMode: states(tick).at(-1)?.page,
      tabs: states(tick).at(-1)?.tabs.map((item) => item.url),
      served: loads.get("h") ?? 0,
      closeCode: end?.code,
      clearedAfterMs: afterRevoke ? afterRevoke.at - revokedAt : null,
      page: numbers(afterRevoke),
    },
  )
  report.shellLog = shellLog(path.join(root, "desktop")).slice(-80)
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  log(`error: ${String(report.error).slice(0, 2_000)}`)
} finally {
  for (const view of views) view.close()
  // The app's own quit (05 §7.3 앱 종료); the page goes with the shell, so nothing is awaited from it.
  await Promise.race([renderer?.evaluate(`void window.own?.app?.quit("app")`).catch(() => undefined), Bun.sleep(3_000)])
  renderer?.close()
  if (shell) {
    const exited = await Promise.race([shell.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
    if (!exited) killTree(shell.pid)
    report.shellExit = exited ? "quit" : "killed"
    report.shellAlive = alive(shell.pid)
  }
  await remote("gateway.disable").catch(() => undefined)
  await service.stop().catch(() => undefined)
  await fake.stop().catch(() => undefined)
  site.stop(true)
  if (!appDataExisted) await removeTree(appData)
  report.osArtifactsCreated = removeNewOsArtifacts(artifacts).created
  report.checks = checks
  report.passed = Object.values(checks).every(Boolean) && !report.error
  if (!args.keep) await removeTree(root)
  clearTimeout(watchdog)
  if (args.shots) {
    mkdirSync(args.shots, { recursive: true })
    writeFileSync(path.join(args.shots, `${label}-report.json`), JSON.stringify(report, null, 2))
  }
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
}

async function until(read: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await read().catch(() => false)) return true
    if (Date.now() > deadline) return false
    await Bun.sleep(200)
  }
}

/** The renderer page's own CDP socket, once the shell's debugging port answers. */
async function connectRenderer(base: string, ms: number) {
  const deadline = Date.now() + ms
  for (;;) {
    const target = await cdpTargets(base).catch(() => undefined)
    if (target?.page) return rawCdp(target.page)
    if (Date.now() > deadline) throw new Error("no renderer page on the debugging port")
    await Bun.sleep(500)
  }
}

/** A free TCP port the gateway can listen on (run-kit's `freePort` binds the same way; this one is node's). */
function freeTcpPort() {
  return new Promise<number>((resolve) => {
    const probe = net.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

function powershell(script: string, file?: string, more: string[] = []) {
  const run = Bun.spawnSync(
    file
      ? ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...more]
      : ["powershell.exe", "-NoLogo", "-NoProfile", "-Command", script],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  return run.stdout.toString().trim()
}

/** Minimizes or restores the shell's app window; `iconic` is whether it is minimized afterwards. */
function windowInput(pid: number, action: "minimize" | "restore") {
  const out = powershell("", path.join(import.meta.dir, "window-input.ps1"), [
    "-ProcessId",
    String(pid),
    "-Action",
    action,
  ])
  try {
    return JSON.parse(out) as { ok?: boolean; iconic?: boolean; error?: string }
  } catch {
    return { ok: false, error: out.slice(0, 300) }
  }
}

/**
 * The shell's top-level windows: how many there are, how many app windows are shown, how many dialogs (class #32770:
 * a file chooser is one), and whether the capture window (remote-surface.ts: shown off the screen, never activated)
 * is up. It is not counted as shown: the PC user cannot see it.
 */
function topWindows(pid: number) {
  const out = powershell("", path.join(import.meta.dir, "tray-input.ps1"), [
    "-ProcessId",
    String(pid),
    "-Action",
    "windows",
  ])
  try {
    const parsed = JSON.parse(out) as { windows?: { class?: string; visible?: boolean; noActivate?: boolean }[] }
    const windows = parsed.windows ?? []
    return {
      count: windows.length,
      shown: windows.filter((item) => item.visible && !item.noActivate).length,
      dialogs: windows.filter((item) => item.class === "#32770").length,
      capture: windows.filter((item) => item.visible && item.noActivate).length,
    }
  } catch {
    return { count: -1, shown: -1, dialogs: -1, capture: -1, raw: out.slice(0, 300) }
  }
}

/** CPU time in ms so far: the shell's main process, and it with every process under it. */
function cpuTimes(pid: number) {
  const out = powershell(
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, KernelModeTime, UserModeTime; ` +
      `$ids = @(${pid}); $grew = $true; while ($grew) { $grew = $false; ` +
      `foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $grew = $true } } }; ` +
      `$main = $all | Where-Object { $_.ProcessId -eq ${pid} }; ` +
      `$tree = ($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $_.KernelModeTime + $_.UserModeTime } | Measure-Object -Sum).Sum; ` +
      `Write-Output "$([math]::Round(($main.KernelModeTime + $main.UserModeTime) / 10000)) $([math]::Round($tree / 10000))"`,
  )
  const [main = 0, tree = 0] = out.split(/\s+/).map(Number)
  return { main, tree }
}

/** The bridge's own lines in the shell's log: which sessions it streamed and when a tab's view was not shown. */
function shellLog(dir: string) {
  const files = existsSync(dir)
    ? (readdirSync(dir, { recursive: true }) as string[]).filter((file) => file.endsWith(".log"))
    : []
  return files
    .flatMap((file) => readFileSync(path.join(dir, file), "utf8").split(/\r?\n/))
    .filter((line) => line.includes("remote browser:"))
    .map((line) => line.slice(0, 240))
}
