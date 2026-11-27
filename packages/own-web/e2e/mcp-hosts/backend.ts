// Backend of the `SSH 호스트에서 쓰기` suite (04 §13 "MCP", MH 2026-11-26): run by Playwright's webServer or by hand
// (`bun e2e/mcp-hosts/backend.ts`).
//
//   Edge ── own-web (Vite dev 5431, /api → local server L with server-side Basic auth)
//   L (from source): own.accounts (local, memory vault, one fake API key account) + own.remote (local)
//     └─ own-remote's fake `ssh` (Git Bash plays the host)
//          ├─ buildbox: installed and connected here; its service is a real server from source (e2e/remote's
//          │  remote-service.ts) with `own-tiny-mcp` on its PATH (a wrapper of own-accounts' fake stdio MCP server
//          │  that exits unless API_KEY is set) and one conversation for the host line
//          └─ oldbox: installed at an older release (own-remote's stub service), never updated
//   L's own MCP servers: `tiny` (that program, value API_KEY), `ctx` (an address with a header), `winonly` (a Windows
//   program), `script` (a python script of this PC).
// Fake values only; every file lives under temp roots removed on exit; no real host, no ~/.ssh, no package download.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { Controller } from "../../../own-remote/src/controller"
import { Operations } from "../../../own-remote/src/operations"
import { Broker } from "../../../own-remote/src/protocol/broker"
import * as Harness from "../../../own-remote/test/harness/remote"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { startFakeOpenAIResponses } from "../../../own-accounts/test/e2e-kit/fakes/openai-responses"
import { FAKE_MCP_STDIO } from "../../../own-accounts/test/e2e-kit/fakes/mcp-stdio"
import { PROVIDER_LOG, SECRET, STATE_FILE } from "./support"

export const DEV_PORT = Number(process.env.OWN_WEB_E2E_MCP_HOSTS_PORT ?? 5431)
const VERSION = "2.0.18-own.9"
const OLD_VERSION = "2.0.18-own.8"
const MODEL = "gpt-5.5"
const KEY = "sk-proj-ownWebMcpHostsE2eKey00000000001"
const ACCOUNTS_PLUGIN = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE_PLUGIN = path.join(REPO_ROOT, "packages/own-remote")
const STUB_SERVICE = path.join(REMOTE_PLUGIN, "test/harness/fake-service.ts")
const REMOTE_SERVICE = path.join(import.meta.dir, "../remote/remote-service.ts")
const BUILD_ID = `own-web-e2e-mcp-hosts-${process.pid}`
const SCRIPT_TIMEOUT_MS = 300_000

if (!Harness.available) {
  console.error("own-web mcp-hosts e2e needs Windows with Git for Windows (bash plays the remote host)")
  process.exit(1)
}

const harness = Harness.create({
  version: VERSION,
  hosts: {
    buildbox: { known: true },
    oldbox: { known: true, env: { OWN_FAKE_SERVICE: Harness.toPosix(STUB_SERVICE) } },
  },
})
const sshState = JSON.parse(fs.readFileSync(harness.statePath, "utf8")) as Record<string, unknown>
sshState.service = REMOTE_SERVICE
fs.writeFileSync(harness.statePath, JSON.stringify(sshState, null, 2))

// The host's program `own-tiny-mcp`: the fake stdio server, which exits unless its value came.
const bin = path.join(harness.testRoot, "host-bin")
fs.mkdirSync(bin, { recursive: true })
fs.writeFileSync(
  path.join(bin, "own-tiny-mcp.cmd"),
  ["@echo off", "set FAKE_MCP_REQUIRE=API_KEY", `"${process.execPath}" "${FAKE_MCP_STDIO}" lookup summarize %*`, ""].join("\r\n"),
)

fs.mkdirSync(path.dirname(PROVIDER_LOG), { recursive: true })
fs.rmSync(PROVIDER_LOG, { force: true })
const responses = startFakeOpenAIResponses({
  models: [MODEL],
  responder: (request) => {
    fs.appendFileSync(
      PROVIDER_LOG,
      JSON.stringify({
        at: Date.now(),
        tool: request.body.includes("own_mcp_install"),
        brief: request.body.includes("[MCP 서버 설치]"),
        secret: request.body.includes(SECRET),
      }) + "\n",
    )
    return { type: "text", text: "결과: 못 함 — 이 시험의 모델은 명령을 실행하지 않아요" }
  },
})

const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "own-web-e2e-mcp-hosts-local-"))
const localOwnHome = path.join(localRoot, "own-home")
fs.mkdirSync(localOwnHome, { recursive: true })
const controllerOptions = {
  sshCommand: harness.sshCommand,
  askpassHelper: harness.askpassHelper,
  sshDir: harness.sshDir,
  keepIntervalSeconds: 1,
  scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
  readyTimeoutMs: 120_000,
  ownerTimeoutMs: 30_000,
}
{
  // oldbox: what an older release of this PC installed (as e2e/remote's backend does).
  const broker = Harness.fakeBroker()
  const unprovide = Broker.provideLocal(BUILD_ID, broker.broker)
  const controller = new Controller({
    buildId: BUILD_ID,
    version: OLD_VERSION,
    ownHome: localOwnHome,
    options: {
      ...controllerOptions,
      remoteBundles: Harness.buildBundle(path.join(harness.root, "old-release"), OLD_VERSION),
      backoffMs: [60_000],
    },
  })
  try {
    await controller.start()
    const added = await controller.addHost({ alias: "oldbox" })
    if (!added.ok) throw new Error("oldbox: hosts.add failed")
    const id = added.record.id
    const operations = new Operations(controller)
    await controller.connect(id, { clientId: "e2e-backend" })
    await controller.settled(id)
    if (controller.view(id)?.stage === "needs_install") {
      const plan = await operations.preparePlan(id)
      if (!plan.ok) throw new Error(`oldbox: prepare.plan ${plan.error}`)
      const executed = await operations.prepareExecute(plan.output.nonce)
      if (!executed.ok || !executed.output.ok) throw new Error("oldbox: prepare.execute failed")
      await controller.connect(id, { clientId: "e2e-backend" })
      await controller.settled(id)
    }
    if (controller.view(id)?.stage !== "ready") throw new Error(`oldbox: ${JSON.stringify(controller.view(id))}`)
    await controller.disconnect(id)
  } finally {
    await controller.close().catch(() => undefined)
    unprovide()
    broker.close()
  }
}

const server = await startOpencodeServer({
  root: localRoot,
  env: { OWN_OPEN_CODE: "1" },
  startupTimeoutMs: 180_000,
  config: (paths) =>
    opencodeConfig({
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
          },
        },
        {
          package: REMOTE_PLUGIN,
          options: {
            home: paths.ownHome,
            buildId: BUILD_ID,
            version: VERSION,
            remoteBundles: harness.bundles,
            backoffMs: [2_000, 5_000],
            lingerSeconds: 0,
            ...controllerOptions,
          },
        },
      ],
    }),
})
const control = path.join(server.paths.ownHome, "control")
fs.mkdirSync(control, { recursive: true })

async function rpc(id: string, method: string, input: unknown) {
  const response = await server.request("POST", `/api/rpc/${id}/${method}`, {
    body: { input },
    query: { "location[directory]": control },
    directory: control,
  })
  const body = (await response.json()) as { output?: Record<string, any> }
  if (!response.ok) throw new Error(`${id} ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(500)
  }
}

const added = await rpc("own.accounts", "accounts.add.key", { kind: "oai", label: "Alpha", key: KEY })
const account = added.account as { id: string; providerID: string }
await server.waitForModels([{ providerID: account.providerID, id: MODEL }])

// The PC's MCP servers.
const servers: Record<string, string> = {}
const save = async (name: string, transport: unknown) => {
  const view = await rpc("own.accounts", "mcp.save", { name, scope: { type: "global" }, transport })
  servers[name] = (view.servers as Array<{ id: string; name: string }>).find((item) => item.name === name)!.id
}
await save("tiny", { type: "local", command: "own-tiny-mcp", args: [], env: [{ name: "API_KEY", value: SECRET }] })
await save("ctx", {
  type: "remote",
  url: "https://mcp.example.invalid/mcp",
  headers: [{ name: "Authorization", value: `Bearer ${SECRET}` }],
  oauth: false,
})
await save("winonly", { type: "local", command: "C:\\Tools\\own-win-mcp.exe", args: ["--stdio"], env: [] })
await save("script", { type: "local", command: "python", args: ["C:\\mcp\\weather.py"], env: [] })

fs.writeFileSync(
  path.join(harness.testRoot, "e2e-remote.json"),
  JSON.stringify({
    accountsPlugin: ACCOUNTS_PLUGIN,
    remotePlugin: REMOTE_PLUGIN,
    buildId: BUILD_ID,
    endpoints: { openai: responses.baseURL },
    broker: { dial: "placeholder" },
    pathPrepend: [bin, path.dirname(Bun.which("git") ?? "C:\\Program Files\\Git\\cmd\\git.exe")],
    startWaitMs: SCRIPT_TIMEOUT_MS - 20_000,
  }),
)

// buildbox: added, installed and connected here (the add flow itself is e2e/remote's).
const host = (await rpc("own.remote", "hosts.add", { alias: "buildbox" })).host as { id: string }
const stage = async () =>
  ((await rpc("own.remote", "hosts.list", {})).hosts as Array<{ id: string; stage: string; broker: { state: string } }>).find(
    (item) => item.id === host.id,
  )!
const connect = async () => {
  await rpc("own.remote", "connect", { hostId: host.id, clientId: "e2e-backend" })
  return until(async () => {
    const view = await stage()
    return view.stage === "ready" || view.stage === "needs_install" ? view : undefined
  }, SCRIPT_TIMEOUT_MS * 2)
}
if ((await connect()).stage === "needs_install") {
  const plan = await rpc("own.remote", "prepare.plan", { hostId: host.id })
  await rpc("own.remote", "prepare.execute", { nonce: plan.nonce })
  await connect()
}
await until(async () => ((await stage()).broker.state === "connected" ? true : undefined), 180_000)
const oldbox = ((await rpc("own.remote", "hosts.list", {})).hosts as Array<{ id: string; alias: string }>).find(
  (item) => item.alias === "oldbox",
)!.id

// One conversation on buildbox, for the host line in a host conversation.
const resolved = await rpc("own.remote", "resolve", { hostId: host.id })
const workspace = path.join(harness.hostHome("buildbox"), "work")
fs.mkdirSync(workspace, { recursive: true })
const hostSession = await until(async () => {
  const response = await fetch(new URL("/api/session", resolved.url), {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`opencode:${resolved.token}`)}`,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(workspace),
    },
    body: JSON.stringify({ title: "호스트 대화", model: { providerID: account.providerID, id: MODEL }, location: { directory: workspace } }),
  })
  if (!response.ok) return undefined
  return ((await response.json()) as { data: { id: string } }).data.id
}, 180_000)

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, { OWN_WEB_API_URL: server.url, OWN_WEB_API_PASSWORD: password, OWN_WEB_CONTROL_DIR: control })
const dev = await startViteDev({ port: DEV_PORT, watch: null, hmr: false })

fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
fs.writeFileSync(
  STATE_FILE,
  JSON.stringify(
    {
      dev: `http://127.0.0.1:${DEV_PORT}`,
      control,
      hosts: { buildbox: host.id, oldbox },
      hostSession,
      servers,
      testRoot: harness.testRoot,
      buildboxHome: harness.hostHome("buildbox"),
      serverRoot: server.paths.root,
      localPassword: password,
      api: server.url,
    },
    null,
    2,
  ),
)
dev.ready()
console.log(`OWN_WEB_E2E_MCP_HOSTS_READY ${DEV_PORT}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await server.stop().catch(() => undefined)
  await responses.stop().catch(() => undefined)
  const proc = path.join(harness.testRoot, "proc")
  for (const entry of fs.existsSync(proc) ? fs.readdirSync(proc) : [])
    if (/^\d+$/.test(entry)) spawnSync("taskkill", ["/PID", entry, "/T", "/F"], { windowsHide: true, stdio: "ignore" })
  await harness.cleanup().catch(() => undefined)
  await removeTree(localRoot, 20, 250)
  fs.rmSync(STATE_FILE, { force: true })
  fs.rmSync(PROVIDER_LOG, { force: true })
  fs.rmSync(STOP_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()
const STOP_FILE = path.join(path.dirname(STATE_FILE), "stop")
fs.rmSync(STOP_FILE, { force: true })
setInterval(() => fs.existsSync(STOP_FILE) && void stop(), 1_000)
