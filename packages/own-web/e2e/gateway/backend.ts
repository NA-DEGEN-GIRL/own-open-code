// M1 remote-access e2e backend (05 §15 M1, gates MG1–MG6, MG8): run by Playwright's webServer or by hand
// (`bun e2e/gateway/backend.ts`). Everything on loopback, fake credentials only, temp roots removed on exit.
//
//   PC tab (Edge, desktop) ── own-web Vite dev (5431, /api → L with server-side Basic) ── 설정 > 기기
//   phone tab (Edge, 375 px mobile emulation) ── http://127.0.0.1:<G>  own-remote's gateway (turned on in the test)
//        │  serves the own-web build of this checkout (with sw.js + manifest), pairing, /own/*, /srv/<serverKey>/*
//        ├─ /srv/local/api/* ──▶ recorder (logs method + path of what reached the service) ──▶ L
//        └─ /srv/<hostId>/api/* ──▶ own-remote's tunnel of the fake-SSH host `gwbox` ──▶ R (real server from source)
//
//   L: real opencode server from source: own.accounts (memory vault, fake OpenAI provider, accounts Alpha/Bravo made
//      through RPC) + own.remote (gateway options: the registration file below, the web build, no Tailscale probe).
//   gwbox: own-remote's fake SSH host (Git Bash, temp HOME) with e2e/remote/remote-service.ts as its "own service":
//      own-accounts mode:"remote" leasing Alpha/Bravo from L's broker + own-remote mode:"agent".
//   farbox: known to own-remote, never connected (503 through the gateway, list-only).
//
// Nothing touches ~/.ssh, known_hosts, the firewall, Tailscale or a real host; the gateway listens on 127.0.0.1 only.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { startViteDev } from "../vite-dev"
import * as Harness from "../../../own-remote/test/harness/remote"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { hashSecret } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { FAKE_KEYS, PROVIDER_LOG, remotePids, SERVICE_LOG, STATE_DIR, STATE_FILE, type GatewayBackendState } from "./support"

export const DEV_PORT = Number(process.env.OWN_WEB_E2E_GATEWAY_PORT ?? 5431)
const VERSION = "2.0.18-own.9"
const MODEL = "gpt-5.5"
const PACKAGE = path.join(REPO_ROOT, "packages/own-web")
const ACCOUNTS_PLUGIN = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE_PLUGIN = path.join(REPO_ROOT, "packages/own-remote")
const REMOTE_SERVICE = path.join(import.meta.dir, "..", "remote", "remote-service.ts")
const BUILD_ID = `own-web-e2e-gateway-${process.pid}`
/** `OWN_WEB_E2E_GATEWAY_REMOTE=0`: skip the SSH host (MG5), for a quick run of the rest. */
const WITH_REMOTE = process.env.OWN_WEB_E2E_GATEWAY_REMOTE !== "0" && Harness.available

fs.mkdirSync(STATE_DIR, { recursive: true })
for (const file of [STATE_FILE, PROVIDER_LOG, SERVICE_LOG]) fs.rmSync(file, { force: true })
const log = (message: string) => console.log(`[gateway-backend] ${message}`)

// ---- fake SSH hosts (04 §20.1 harness)
const harness = Harness.available
  ? Harness.create({ version: VERSION, hosts: { gwbox: { known: true }, farbox: { known: true } } })
  : undefined
if (harness) {
  const sshState = JSON.parse(fs.readFileSync(harness.statePath, "utf8")) as Record<string, unknown>
  sshState.service = REMOTE_SERVICE
  fs.writeFileSync(harness.statePath, JSON.stringify(sshState, null, 2))
  const project = path.join(harness.hostHome("gwbox"), "work", "phone-game")
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, "README.md"), "# phone-game\n\nremote project for the gateway e2e\n")
}

// ---- fake provider: answers with the name of the account whose key the request carried
const labels = new Map<string, string>(Object.entries(FAKE_KEYS).map(([label, key]) => [hashSecret(`Bearer ${key}`), label]))
/**
 * `OWN_WEB_E2E_GATEWAY_SLOW_STREAM=1` (own/scripts/test/win-arm64-device.ts): the same answer plus ten counted words
 * over ten deltas 400 ms apart, so a device across the tailnet can watch it arrive piece by piece.
 */
const SLOW_STREAM = process.env.OWN_WEB_E2E_GATEWAY_SLOW_STREAM === "1"
const SLOW_WORDS = ["하나", "둘", "셋", "넷", "다섯", "여섯", "일곱", "여덟", "아홉", "열"]
const responses = startFakeOpenAIResponses({
  models: [MODEL],
  responder: (request) => {
    const account = labels.get(request.headers.authorization ?? "") ?? "unknown"
    fs.appendFileSync(PROVIDER_LOG, JSON.stringify({ at: Date.now(), account }) + "\n")
    if (SLOW_STREAM)
      return { type: "text", text: `${account} 계정으로 온 답 · ${SLOW_WORDS.join(" ")}`, deltas: 10, eventDelayMs: 400 }
    return { type: "text", text: `${account} 계정으로 온 답` }
  },
})

const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "own-web-e2e-gateway-local-"))
const ownHome = path.join(localRoot, "own-home")
fs.mkdirSync(ownHome, { recursive: true })

// ---- the own-web build the gateway serves (this checkout, with the PWA files): test:e2e:all's dist/ under it
// (OWN_WEB_DIST_BUILT=1; the gateway only reads it), otherwise a build of its own in its own folder, never dist/, which
// other suites may be serving.
const given =
  process.env.OWN_WEB_GATEWAY_DIST ?? (process.env.OWN_WEB_DIST_BUILT === "1" ? path.join(PACKAGE, "dist") : undefined)
const webRoot = given ?? path.join(localRoot, "web")
if (given && !fs.existsSync(path.join(webRoot, "sw.js"))) throw new Error(`no own-web build with sw.js in ${webRoot}`)
if (!given) {
  log("building own-web …")
  const built = spawnSync(process.execPath, ["x", "vite", "build", "--outDir", webRoot, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: PACKAGE,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, BUN_BE_BUN: "1" },
  })
  if (built.status !== 0 || !fs.existsSync(path.join(webRoot, "sw.js"))) throw new Error("own-web build failed")
}

// ---- the service's side of the relay: a recorder in front of L (MG3 "서비스 로그에 해당 요청 0")
let serviceUrl = ""
type Relay = { target: string; headers: Record<string, string>; upstream?: WebSocket; queue: Array<string | ArrayBuffer | Uint8Array<ArrayBuffer>> }
const recorder = Bun.serve<Relay, never>({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    fs.appendFileSync(SERVICE_LOG, JSON.stringify({ at: Date.now(), method: request.method, path: url.pathname }) + "\n")
    const target = `${serviceUrl}${url.pathname}${url.search}`
    const headers = new Headers(request.headers)
    headers.delete("host")
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const plain: Record<string, string> = {}
      headers.forEach((value, key) => {
        if (!key.startsWith("sec-websocket") && key !== "upgrade" && key !== "connection") plain[key] = value
      })
      return server.upgrade(request, { data: { target: target.replace(/^http/, "ws"), headers: plain, queue: [] } })
        ? undefined
        : new Response("upgrade failed", { status: 400 })
    }
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      duplex: "half",
    } as RequestInit).catch(() => undefined)
    if (!response) return new Response("service unavailable", { status: 502 })
    if ((response.headers.get("content-type") ?? "").startsWith("text/event-stream")) server.timeout(request, 0)
    return new Response(response.body, { status: response.status, headers: response.headers })
  },
  websocket: {
    open(ws: ServerWebSocket<Relay>) {
      const upstream = new WebSocket(ws.data.target, { headers: ws.data.headers } as never)
      ws.data.upstream = upstream
      upstream.onopen = () => ws.data.queue.splice(0).forEach((message) => upstream.send(message))
      upstream.onmessage = (event) => ws.send(event.data as string)
      upstream.onclose = () => ws.close()
    },
    message(ws, message) {
      if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(message)
      else ws.data.queue.push(message)
    },
    close(ws) {
      ws.data.upstream?.close()
    },
  },
})

const registration = path.join(localRoot, "service-own.json")
const gatewayPort = await freePort()
// The app listener's default port (28540) belongs to this PC's own installed service once its app access is on, so the
// test's service starts with a free one in its gateway file (`OWN_HOME/gateway.json`, the gateway still off).
const appPort = await freePort()

log("starting the local server …")
const server = await startOpencodeServer({
  root: localRoot,
  env: { OWN_OPEN_CODE: "1" },
  startupTimeoutMs: 180_000,
  config: (paths) => {
    fs.mkdirSync(paths.ownHome, { recursive: true })
    fs.writeFileSync(
      path.join(paths.ownHome, "gateway.json"),
      JSON.stringify({
        version: 1,
        enabled: false,
        bind: "127.0.0.1",
        port: gatewayPort,
        publicOrigin: null,
        app: { enabled: false, port: appPort, directHost: null, directPort: null },
        updatedAt: Date.now(),
      }),
    )
    return opencodeConfig({
      providers: {},
      plugins: [
        {
          package: ACCOUNTS_PLUGIN,
          options: {
            home: paths.ownHome,
            buildId: BUILD_ID,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: responses.baseURL },
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        {
          package: REMOTE_PLUGIN,
          options: {
            home: paths.ownHome,
            buildId: BUILD_ID,
            version: VERSION,
            lingerSeconds: 0,
            // App connections (08): a memory vault for the TLS key, a loopback route for the simulated app.
            gateway: {
              registration,
              webRoot,
              tailscaleCommand: null,
              portproxyCommand: null,
              vault: "memory",
              appLoopbackRoute: true,
              auditIntervalMs: 5_000,
            },
            ...(harness
              ? {
                  remoteBundles: harness.bundles,
                  backoffMs: [2_000, 5_000],
                  sshCommand: harness.sshCommand,
                  askpassHelper: harness.askpassHelper,
                  sshDir: harness.sshDir,
                  keepIntervalSeconds: 1,
                  readyTimeoutMs: 120_000,
                  ownerTimeoutMs: 30_000,
                }
              : {}),
          },
        },
      ],
    })
  },
})
const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
serviceUrl = server.url
// What the service's registration file holds (05 §13.4: the gateway reads URL + password from it). The URL is the
// recorder's, so every request the gateway relays is logged before it reaches L.
fs.writeFileSync(
  registration,
  JSON.stringify({ id: "e2e", version: "local", url: `http://127.0.0.1:${recorder.port}`, pid: server.pid, password }),
)

const control = path.join(ownHome, "control")
fs.mkdirSync(control, { recursive: true })

async function rpc(id: string, method: string, input: unknown) {
  const response = await server.request("POST", `/api/rpc/${id}/${method}`, {
    body: { input },
    query: { "location[directory]": control },
    directory: control,
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`${id} ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

const accounts: Record<string, { id: string; providerID: string; label: string }> = {}
for (const [label, key] of Object.entries(FAKE_KEYS)) {
  const added = await rpc("own.accounts", "accounts.add.key", { kind: "oai", label, key })
  const account = added.account as { id: string; providerID: string }
  accounts[label] = { id: account.id, providerID: account.providerID, label }
}
const alpha = accounts.Alpha!
await server.waitForModels([{ providerID: alpha.providerID, id: MODEL }])
const localSession = await server.createSession({ title: "로컬 세션 하나", model: { providerID: alpha.providerID, id: MODEL } })
await server.prompt(localSession.id, "로컬에서 안녕")
await server.waitIdle(localSession.id)

// ---- gwbox: add, connect, install, ready; a remote session on it
let host: GatewayBackendState["host"] = null
let farHost = ""
if (harness) {
  fs.writeFileSync(
    path.join(harness.testRoot, "e2e-remote.json"),
    JSON.stringify({
      accountsPlugin: ACCOUNTS_PLUGIN,
      remotePlugin: REMOTE_PLUGIN,
      buildId: BUILD_ID,
      endpoints: { openai: responses.baseURL },
      broker: { dial: "placeholder" },
      pathPrepend: [path.dirname(Bun.which("git") ?? "C:\\Program Files\\Git\\cmd\\git.exe")],
    }),
  )
  const far = (await rpc("own.remote", "hosts.add", { alias: "farbox" })).host as { id: string }
  farHost = far.id
  if (WITH_REMOTE) {
    log("connecting gwbox (install, remote server boot) …")
    const added = (await rpc("own.remote", "hosts.add", { alias: "gwbox" })).host as { id: string; name: string }
    const hostId = added.id
    const stage = async () =>
      ((await rpc("own.remote", "hosts.list", {})).hosts as Array<{ id: string; stage: string; error: string | null; paused: boolean }>).find(
        (item) => item.id === hostId,
      )!
    const waitFor = async (want: (value: Awaited<ReturnType<typeof stage>>) => boolean, ms: number) => {
      const deadline = Date.now() + ms
      for (;;) {
        const current = await stage()
        if (want(current)) return current
        if (Date.now() > deadline) throw new Error(`gwbox stuck: ${JSON.stringify(current)}`)
        await Bun.sleep(500)
      }
    }
    await rpc("own.remote", "connect", { hostId, clientId: "e2e-backend" })
    const first = await waitFor((value) => value.stage === "needs_install" || value.stage === "ready" || value.paused, 120_000)
    if (first.stage === "needs_install") {
      const plan = await rpc("own.remote", "prepare.plan", { hostId })
      await rpc("own.remote", "prepare.execute", { nonce: plan.nonce })
    } else if (first.stage !== "ready") throw new Error(`gwbox: ${JSON.stringify(first)}`)
    await waitFor((value) => value.stage === "ready", 300_000)
    const resolved = (await rpc("own.remote", "resolve", { hostId })) as { url: string; token: string; controlDir: string }
    const posix = Harness.toPosix(path.join(harness.hostHome("gwbox"), "work", "phone-game"))
    const created = await fetch(`${resolved.url}/api/session`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`opencode:${resolved.token}`)}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "원격 세션 하나", model: { providerID: alpha.providerID, id: MODEL }, location: { directory: posix } }),
    })
    if (!created.ok) throw new Error(`remote session: ${created.status} ${await created.text()}`)
    const session = ((await created.json()) as { data: { id: string } }).data
    host = { id: hostId, name: added.name, session: { id: session.id, title: "원격 세션 하나" }, password: remotePassword(harness.hostHome("gwbox")) }
  }
}

// ---- own-web on the PC (the settings page that pairs devices)
Object.assign(process.env, { OWN_WEB_API_URL: server.url, OWN_WEB_API_PASSWORD: password, OWN_WEB_CONTROL_DIR: control })
const dev = await startViteDev({ port: DEV_PORT, watch: null, hmr: false })

const state: GatewayBackendState = {
  dev: `http://127.0.0.1:${DEV_PORT}`,
  gatewayPort,
  serverUrl: server.url,
  serverPid: server.pid,
  localPassword: password,
  control,
  ownHome,
  serverRoot: server.paths.root,
  testRoot: harness?.testRoot ?? "",
  model: MODEL,
  accounts,
  localSession: { id: localSession.id, title: "로컬 세션 하나" },
  host,
  farHost,
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_E2E_GATEWAY_READY ${DEV_PORT}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await server.stop().catch(() => undefined)
  recorder.stop(true)
  await responses.stop().catch(() => undefined)
  if (harness) {
    for (const pid of remotePids(harness.testRoot))
      spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    await harness.cleanup().catch(() => undefined)
  }
  await removeTree(localRoot, 20, 250)
  for (const file of [STATE_FILE, PROVIDER_LOG, SERVICE_LOG, STOP_FILE]) fs.rmSync(file, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()
const STOP_FILE = path.join(STATE_DIR, "stop")
fs.rmSync(STOP_FILE, { force: true })
setInterval(() => fs.existsSync(STOP_FILE) && void stop(), 1_000)

/** The fake host's own service password (its `service-own.json` config, wherever XDG put it). */
function remotePassword(home: string) {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === "service-own.json") {
        const value = JSON.parse(fs.readFileSync(full, "utf8")) as { password?: unknown }
        if (typeof value.password === "string") found.push(value.password)
      }
    }
  }
  walk(home, 0)
  if (found.length === 0) throw new Error("gwbox: no service password found")
  return found[0]!
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

