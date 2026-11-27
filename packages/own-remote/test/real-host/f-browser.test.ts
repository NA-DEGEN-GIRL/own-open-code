// Real-host phase F (05 §8.6, decisions SB): the PC's browser pane for a conversation on the SSH host. This PC's
// release service (stack.ts) is connected to the phase A host as in phase C; the real desktop shell (own-desktop's
// `out/`, unpackaged, on the workspace's Electron, off screen, its own userData) shows a host conversation and its
// browser pane. Opt-in: OWN_REAL_HOST=build-host (or lab; nothing heavy here).
//
// On the host everything lives in one temp root /tmp/own-<uid>-rh-browser-<rand>: a page with a marker and a 5 MiB file
// served by a throwaway HTTP server bound to the host's 127.0.0.1 on a port free on both machines; afterAll stops the
// server and removes the root (z-cleanup would remove a leftover root too). Checks:
//  - open: `localhost:<port>` typed in the pane's address field loads the host's page (the port is free on this PC, so
//    nothing here could have answered), and a 5 MiB fetch in the page measures the tunnel;
//  - route: a page this PC serves on its own 127.0.0.1 is NOT what the pane shows for that address: loopback means the
//    host, and the pane says it could not connect there;
//  - agent: the conversation's model (the fake chat on this PC, through the broker) calls `tools.browser.tabs.open` and
//    `snapshot` on the host's address; the snapshot it gets back carries the marker;
//  - link: own-remote's `disconnect` shows the pane's Korean offline card, `connect` brings the tab back with its page.
// Model traffic only to the fakes on this PC; no credential is real.
//
// The shell and the UI: OWN_REAL_HOST_DESKTOP (default: this repository's packages/own-desktop, `bun run build` first)
// and OWN_REAL_HOST_WEB (default: the release's `app\web`; a development run may name an own-web `dist`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { afterToolResult, lastUserText, toolOutputs, type Responder } from "../../../own-accounts/test/e2e-kit"
import { cdpTargets, rawCdp, type RawCdp } from "../../../own-desktop/scripts/cdp-raw"
import { registerService } from "../../../own-desktop/scripts/dev-service"
import {
  cleanEnv,
  freePort,
  killTree,
  osArtifacts,
  removeNewOsArtifacts,
  xdgDirs,
} from "../../../own-desktop/scripts/run-kit"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { BrowserGateway } from "../harness/browser-gateway.js"
import { removeTree } from "../harness/remove.js"
import {
  ALIAS,
  APP,
  OWN_HOME,
  REPO,
  ROOT,
  SSH_CONFIG,
  VERSION,
  enabled,
  evidence,
  freeLocalPort,
  freeOnBoth,
  hostSh,
  kv,
} from "./env.js"
import { MODEL, ensureCompat, startStack, until, type Stack } from "./stack.js"
import { local, pairApp, remoteFetch, remoteSession, type Endpoint } from "./team-fixture.js"

const run = enabled ? describe : describe.skip
const CLIENT = "real-host-f"
const DESKTOP = process.env.OWN_REAL_HOST_DESKTOP ?? path.join(REPO, "packages", "own-desktop")
const WEB = process.env.OWN_REAL_HOST_WEB ?? path.join(APP, "web")
const MARK = `own-ssh-browser-${Math.random().toString(36).slice(2, 10)}`
const PC_MARK = `this-pc-${Math.random().toString(36).slice(2, 10)}`
const BIG_BYTES = 5 * 1024 * 1024
const AGENT_PROMPT = "[browse-host] 서버의 개발 서버 화면을 봐 줘"

run(`real host ${ALIAS}: the browser pane of an SSH conversation (phase F)`, () => {
  const state = {} as {
    stack: Stack
    hostId: string
    hostName: string
    endpoint: Endpoint
    /** The host's temp root, the server's pid and port. */
    root: string
    pid: string
    port: number
    /** This PC's own page on 127.0.0.1 (a port free on the host too). */
    pc: ReturnType<typeof Bun.serve>
    session: string
    shell: ReturnType<typeof Bun.spawn>
    ui: RawCdp
    cdp: number
    shellRoot: string
    artifacts: ReturnType<typeof osArtifacts>
    results: Record<string, unknown>
  }
  state.results = {}

  const host = async () => {
    const listed = await local(state.stack, "hosts.list", {})
    const found = listed.hosts.find((item) => item.id === state.hostId)
    if (!found) throw new Error(`host ${state.hostId} is not listed`)
    return found
  }
  const connect = async () => {
    await local(state.stack, "connect", { hostId: state.hostId, clientId: CLIENT })
    const ready = await until(
      async () => {
        const view = await host()
        return view.stage === "ready" || view.paused ? view : undefined
      },
      240_000,
      500,
    )
    const resolved = await local(state.stack, "resolve", { hostId: state.hostId })
    if (resolved.url === null) throw new Error(`host not ready: ${resolved.stage}`)
    state.endpoint = { url: resolved.url, token: resolved.token, controlDir: resolved.controlDir }
    return ready
  }

  /** The model's turn: open the host's address in the conversation's browser and read it (Code Mode). */
  const respond: Responder = (request) => {
    if (!lastUserText(request).includes("[browse-host]")) return undefined
    if (afterToolResult(request)) return { type: "text" as const, text: "봤어요." }
    const url = `http://localhost:${state.port}/`
    return {
      type: "tool-call" as const,
      name: "execute",
      input: {
        code: `const tab = await tools.browser.tabs.open({ url: ${JSON.stringify(url)} })
const page = await tools.browser.snapshot({ tabID: tab.id })
return JSON.stringify(page).slice(0, 4000)`,
      },
    }
  }

  /** The renderer's value of `expression`, once `done` takes it. */
  const ui = async <T>(expression: string, done: (value: T) => boolean, ms: number) => {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await state.ui.evaluate<T>(expression).catch(() => undefined as T)
      if (done(value) || Date.now() > deadline) return value
      await Bun.sleep(250)
    }
  }
  /** The text of the pane's tab page at `url` (its own CDP target), once it is loaded. */
  const tabText = async (url: string, ms: number) => {
    const deadline = Date.now() + ms
    for (;;) {
      const list = (await fetch(`http://127.0.0.1:${state.cdp}/json/list`)
        .then((response) => response.json())
        .catch(() => [])) as { type: string; url: string; webSocketDebuggerUrl: string }[]
      const target = list.find((item) => item.type === "page" && item.url === url)
      if (target) {
        const page = await rawCdp(target.webSocketDebuggerUrl).catch(() => undefined)
        const text = await page?.evaluate<string>(`document.body ? document.body.innerText : ""`).catch(() => "")
        page?.close()
        if (text) return text
      }
      if (Date.now() > deadline) return ""
      await Bun.sleep(500)
    }
  }
  /** Types an address into the pane's field and presses Enter (CDP input on the renderer only). */
  const go = async (address: string) => {
    await state.ui.evaluate(
      `(() => { const field = document.querySelector('[data-testid="browser-address"]'); field.focus(); field.select(); })()`,
    )
    await state.ui.send("Input.insertText", { text: address })
    for (const type of ["rawKeyDown", "keyUp"])
      await state.ui.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  }

  beforeAll(async () => {
    if (!fs.existsSync(path.join(DESKTOP, "out", "main", "index.js")))
      throw new Error(`no shell build in ${DESKTOP}\\out (bun run build in packages/own-desktop)`)
    if (!fs.existsSync(path.join(WEB, "index.html"))) throw new Error(`no own-web build at ${WEB}`)
    state.stack = await startStack({ responder: respond })
    state.hostId = state.stack.hostId
    const alpha = String((await ensureCompat(state.stack, "Alpha")).providerID)
    state.hostName = (await connect()).name
    expect((await host()).stage).toBe("ready")

    // The host side: a page, a 5 MiB file and the throwaway server, on a port nothing listens on here or there.
    const ports = await freeOnBoth()
    state.port = await ports()
    const made = await hostSh(String.raw`set -eu
umask 077
root=$(mktemp -d "/tmp/own-$(id -u)-rh-browser-XXXXXXXX")
mkdir -p "$root/site" "$root/app"
printf '<!doctype html><meta charset="utf-8"><title>own ssh browser</title><p id="mark">${MARK}</p><p>served-from-the-host</p>\n' > "$root/site/index.html"
head -c ${BIG_BYTES} /dev/zero > "$root/site/big.bin"
cd "$root/site"
setsid nohup python3 -m http.server ${state.port} --bind 127.0.0.1 < /dev/null > "$root/http.log" 2>&1 &
echo "ROOT=$root"
echo "PID=$!"
`)
    const facts = kv(made.stdout)
    state.root = facts.get("ROOT") ?? ""
    state.pid = facts.get("PID") ?? ""
    if (made.code !== 0 || !/^\/tmp\/own-\d+-rh-browser-[A-Za-z0-9]{8}$/.test(state.root) || !/^\d+$/.test(state.pid))
      throw new Error(`host server: ${made.stdout} ${made.stderr}`)
    await until(
      async () =>
        kv(
          (
            await hostSh(
              `python3 -c "import urllib.request as u; print('UP=' + str(u.urlopen('http://127.0.0.1:${state.port}/').status))" 2>/dev/null || echo UP=0`,
            )
          ).stdout,
        ).get("UP") === "200",
      30_000,
      500,
    )
    state.session = await remoteSession(state.endpoint, {
      directory: `${state.root}/app`,
      title: "SSH 브라우저 시험",
      model: { providerID: alpha, id: MODEL },
    })

    // This PC's own page on its 127.0.0.1, at a port the host does not have either.
    state.pc = Bun.serve({
      hostname: "127.0.0.1",
      port: await ports(),
      fetch: () => new Response(`<!doctype html><p>${PC_MARK}</p>`, { headers: { "content-type": "text/html" } }),
    })

    // The shell: its own userData, XDG and temp; the release UI next to the release plugins of phase A's OWN_HOME.
    state.shellRoot = path.join(ROOT, "f-browser-shell")
    fs.rmSync(state.shellRoot, { recursive: true, force: true })
    const xdg = xdgDirs(state.shellRoot)
    const temp = path.join(state.shellRoot, "tmp")
    fs.mkdirSync(temp, { recursive: true })
    fs.rmSync(path.join(OWN_HOME, "app", VERSION, "web"), { recursive: true, force: true })
    fs.cpSync(WEB, path.join(OWN_HOME, "app", VERSION, "web"), { recursive: true })
    const server = state.stack.server
    await registerService({
      url: server.url,
      authorization: server.authorization,
      password: atob(server.authorization.slice("Basic ".length)).slice("opencode:".length),
      stateHome: xdg.XDG_STATE_HOME,
      channel: "own",
    })
    state.artifacts = osArtifacts()
    state.cdp = await freePort()
    const electron = createRequire(path.join(DESKTOP, "package.json"))("electron") as unknown as string
    state.shell = Bun.spawn([electron, DESKTOP, "--disable-features=CalculateNativeWinOcclusion"], {
      env: {
        ...cleanEnv({ ...xdg, OWN_HOME, OWN_CONFIG_DIR: path.join(state.shellRoot, "config"), TEMP: temp, TMP: temp }),
        OPENCODE_DESKTOP_TEST_ROOT: path.join(state.shellRoot, "desktop"),
        OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(state.cdp),
        OWN_DESKTOP_TEST_RUN: String(process.pid),
      },
      stdout: "ignore",
      stderr: "ignore",
    })
    const deadline = Date.now() + 120_000
    for (;;) {
      const target = await cdpTargets(`http://127.0.0.1:${state.cdp}`).catch(() => undefined)
      if (target?.page) {
        state.ui = await rawCdp(target.page)
        break
      }
      if (Date.now() > deadline) throw new Error("no renderer page on the debugging port")
      await Bun.sleep(500)
    }
    await ui<boolean>(`!!document.querySelector('[data-testid="app"]')`, (value) => value, 60_000)
  }, 600_000)

  afterAll(async () => {
    evidence("f-browser.json", state.results)
    state.ui?.close()
    if (state.shell) killTree(state.shell.pid)
    if (state.artifacts) removeNewOsArtifacts(state.artifacts)
    state.pc?.stop(true)
    if (state.root)
      await hostSh(
        `kill ${state.pid} 2>/dev/null; sleep 1; kill -9 ${state.pid} 2>/dev/null; rm -rf '${state.root}'; echo DONE=1`,
      )
    await state.stack?.stop()
    if (state.shellRoot) await removeTree(state.shellRoot).catch(() => undefined)
  }, 120_000)

  test("open: the host's localhost loads in the PC's pane through the tunnel", async () => {
    // The conversation's row under the host once the shell sees the host connected; a click opens it, as the user does.
    const row = `[...document.querySelectorAll('[data-testid="session-row"]')].find((el) => el.textContent.includes("SSH 브라우저 시험"))`
    const group = `document.querySelector('[data-testid="host-group"][data-host="${state.hostId}"]')`
    const shown = await ui<string>(
      `(() => { const el = ${group}; return el && el.dataset.stage === "ready" && ${row} ? el.innerText : "" })()`,
      (value) => value.includes("SSH 브라우저 시험"),
      180_000,
    )
    state.results.sidebar = await state.ui.evaluate<string>(`${group}?.innerText ?? "no host group"`).catch(() => "")
    expect(shown).toContain("SSH 브라우저 시험")
    const opened = async () => {
      const box = await state.ui.evaluate<{ x: number; y: number } | null>(
        `(() => { const el = ${row}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`,
      )
      if (box)
        for (const type of ["mousePressed", "mouseReleased"])
          await state.ui.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 })
      return ui<string>(
        `document.querySelector('[data-testid="header-title"]')?.textContent ?? ""`,
        (value) => value.includes("SSH 브라우저 시험"),
        15_000,
      )
    }
    const title = (await opened()) || (await opened()) || (await opened())
    expect(title).toContain("SSH 브라우저 시험")
    await state.ui.evaluate(`document.querySelector("#own-composer-input")?.focus()`)
    const chord = { key: "B", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 10 }
    await state.ui.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...chord })
    await state.ui.send("Input.dispatchKeyEvent", { type: "keyUp", ...chord })
    const attachedAt = Date.now()
    const attached = await ui<boolean>(
      `!!document.querySelector('[data-testid="browser-pane"][data-attached]')`,
      (value) => value,
      60_000,
    )
    state.results.attachMs = Date.now() - attachedAt
    expect(attached).toBe(true)
    const started = Date.now()
    await go(`localhost:${state.port}`)
    const text = await tabText(`http://localhost:${state.port}/`, 60_000)
    state.results.openMs = Date.now() - started
    expect(text).toContain(MARK)
    expect(text).toContain("served-from-the-host")
    // The same port on this PC answers nothing: the page came from the host.
    expect(
      await fetch(`http://127.0.0.1:${state.port}/`).then(
        () => "answered",
        () => "refused",
      ),
    ).toBe("refused")
    // 5 MiB through the tunnel, timed in the page.
    const list = (await (await fetch(`http://127.0.0.1:${state.cdp}/json/list`)).json()) as {
      url: string
      webSocketDebuggerUrl: string
    }[]
    const page = await rawCdp(list.find((item) => item.url === `http://localhost:${state.port}/`)!.webSocketDebuggerUrl)
    const big = await page.evaluate<{ bytes: number; ms: number }>(
      `(async () => { const t = performance.now(); const b = await (await fetch("/big.bin", { cache: "no-store" })).arrayBuffer(); return { bytes: b.byteLength, ms: Math.round(performance.now() - t) } })()`,
    )
    page.close()
    state.results.big = { ...big, mbPerSecond: Math.round((big.bytes / 1048576 / (big.ms / 1000)) * 10) / 10 }
    expect(big.bytes).toBe(BIG_BYTES)
  }, 300_000)

  test("route: this PC's own 127.0.0.1 page is not what the pane opens; loopback is the host's, which has nothing there", async () => {
    const port = state.pc.port
    // This PC does answer there.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain(PC_MARK)
    await go(`127.0.0.1:${port}`)
    const failed = await ui<string>(
      `document.querySelector('[data-testid="browser-load-failed"]')?.textContent ?? ""`,
      (value) => value.length > 0,
      60_000,
    )
    state.results.routeFailure = failed
    expect(failed).toContain("페이지를 열 수 없어요")
    expect(failed).toContain(state.hostName)
    expect(await tabText(`http://127.0.0.1:${port}/`, 3_000)).not.toContain(PC_MARK)
  }, 120_000)

  test("agent: the host conversation's model opens and reads the host's page with the PC's browser tools", async () => {
    const before = state.stack.chat.requests.length
    await remoteFetch(state.endpoint, "POST", `/api/session/${state.session}/prompt`, {
      body: { text: AGENT_PROMPT },
      directory: `${state.root}/app`,
    })
    await remoteFetch(state.endpoint, "POST", `/api/experimental/session/${state.session}/wait`, {
      directory: `${state.root}/app`,
      timeoutMs: 240_000,
    })
    const turn = state.stack.chat.requests
      .slice(before)
      .filter((request) => lastUserText(request).includes("[browse-host]"))
    const outputs = turn.flatMap((request) => toolOutputs(request))
    state.results.agent = { requests: turn.length, output: outputs.join("\n").slice(0, 2000) }
    // The browser tools were in the conversation's catalog (the PC's pane is attached to the host's service).
    expect(
      turn.filter((request) => !afterToolResult(request)).some((request) => request.body.includes("tabs.open")),
    ).toBe(true)
    expect(outputs.join("\n")).toContain(MARK)
  }, 300_000)

  test("device: a phone with `browser` views the host conversation's pane through this PC's gateway", async () => {
    const port = await freeLocalPort(40_000, 49_999)
    const planned = await local(state.stack, "gateway.configure.plan", { port, bind: "127.0.0.1" })
    const gateway = await local(state.stack, "gateway.configure.execute", { nonce: planned.nonce })
    try {
      const device = await pairApp(state.stack, gateway.url!, {
        name: "SSH 브라우저 폰",
        scopes: ["read", "prompt", "browser"],
      })
      const view = BrowserGateway.viewer(
        gateway.url!,
        { auth: { authorization: `Bearer ${device.token}` } },
        state.session,
        {
          serverKey: state.hostId,
        },
      )
      view.socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") return
        const frame = RemoteBrowser.decodeFrame(new Uint8Array(event.data as ArrayBuffer))
        if (frame) view.send({ t: "ack", seq: frame.header.seq })
      })
      const started = Date.now()
      view.hello({ viewport: { width: 390, height: 800, dpr: 3 } })
      await view.ready()
      const ready = await view.until(() => {
        const last = view.messages.flatMap((message) => (message.t === "state" ? [message.state] : [])).at(-1)
        return last?.host === "ready" && last.tabs.length > 0 ? last : undefined
      }, 60_000)
      const frame = await view.frame(1).catch(() => undefined)
      state.results.device = {
        readyMs: Date.now() - started,
        tabs: ready.tabs.map((tab) => tab.url),
        frame: frame ? { width: frame.header.width, height: frame.header.height, bytes: frame.jpeg.byteLength } : null,
      }
      expect(ready.tabs.some((tab) => tab.url === `http://localhost:${state.port}/`)).toBe(true)
      expect(frame?.jpeg.byteLength ?? 0).toBeGreaterThan(0)
      view.close()
      await local(state.stack, "devices.revoke", { deviceId: device.deviceId })
    } finally {
      await local(state.stack, "gateway.disable", {})
    }
  }, 240_000)

  test("link: a dropped SSH link shows the offline card; reconnected, the tab's page is back", async () => {
    await local(state.stack, "disconnect", { hostId: state.hostId })
    const offline = await ui<string>(
      `document.querySelector('[data-testid="browser-offline"]')?.textContent ?? ""`,
      (value) => value.length > 0,
      60_000,
    )
    state.results.offline = offline
    expect(offline).toMatch(/SSH 연결이 끊겼어요|SSH 서버에 아직 연결되지 않았어요/)
    const started = Date.now()
    await connect()
    expect(
      await ui<boolean>(`!document.querySelector('[data-testid="browser-offline"]')`, (value) => value, 120_000),
    ).toBe(true)
    await go(`localhost:${state.port}`)
    expect(await tabText(`http://localhost:${state.port}/`, 90_000)).toContain(MARK)
    state.results.reconnectMs = Date.now() - started
  }, 400_000)

  test("link drop: the tunnel's ssh dies; the pane says so at once and comes back by itself with own-remote's reconnect", async () => {
    // Only this run's tunnel: its ssh runs with this run's temp config and holds the API forward. Never another ssh.
    const tunnels = Bun.spawnSync(
      [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${SSH_CONFIG}*' -and $_.CommandLine -like '*-L 127.0.*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
      .stdout.toString()
      .split(/\s+/)
      .filter((pid) => /^\d+$/.test(pid))
    state.results.killedTunnels = tunnels.length
    expect(tunnels.length).toBe(1)
    const dropped = Date.now()
    Bun.spawnSync(["taskkill", "/pid", tunnels[0]!, "/F"], { stdout: "ignore", stderr: "ignore" })
    const offline = await ui<string>(
      `document.querySelector('[data-testid="browser-offline"]')?.textContent ?? ""`,
      (value) => value.length > 0,
      60_000,
    )
    state.results.dropCardMs = Date.now() - dropped
    expect(offline).toContain("SSH 연결이 끊겼어요")
    // own-remote reconnects by itself (the host is not paused); the tab comes back with the host's page.
    expect(
      await ui<boolean>(`!document.querySelector('[data-testid="browser-offline"]')`, (value) => value, 180_000),
    ).toBe(true)
    expect(await tabText(`http://localhost:${state.port}/`, 90_000)).toContain(MARK)
    state.results.dropBackMs = Date.now() - dropped
  }, 400_000)
})
