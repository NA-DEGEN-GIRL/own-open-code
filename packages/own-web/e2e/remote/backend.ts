// SSH remote e2e backend (04 §20.1 fake-SSH, RG13 in the web fallback's dev path): run by Playwright's webServer or
// by hand (`bun e2e/remote/backend.ts`). The whole R1 chain, integrated: own-web, own-remote, the credential broker and
// own-accounts remote mode.
//
//   Edge ── own-web (Vite dev 5421, /api → local server with server-side Basic auth)
//     │        └─ http://127.0.<k>.2:<LP>  (Basic session token from own.remote.resolve, tab memory only)
//     ▼
//   local opencode server L (from source): own.accounts (local mode, memory vault, the accounts and the broker)
//                                        + own.remote (local mode), one build id as in production
//        └─ own-remote's fake `ssh` (packages/own-remote/test/harness/fake-ssh.ts): the "host" is a Git Bash with a temp
//           HOME; -L is a local TCP relay on 127.0.<k>.2, -R a placeholder "socket" naming a relay to L's broker;
//           askpass through own-remote's real askpass server
//              └─ ensure → the fake bundle's `opencode service start` → e2e/remote/remote-service.ts
//                   └─ proxy on the registered port → a real opencode server R from source with the managed config's
//                      plugins: own.accounts mode:"remote" (credentials leased from L's broker per request) and
//                      own.remote mode:"agent"
//
// Hosts: `devbox` (host key unknown: the add flow shows the fingerprint and needs "신뢰하고 연결"), `pwbox` (known host
// key, password prompt), `farbox` (never connected, list only), `oldbox` (own-remote's stub service, installed at an
// older release before L starts: the version skew → update with drain flow). The accounts exist on L only; the fake
// provider answers with the name of the account whose key a request carried. Fake credentials only; every file lives
// under temp roots removed on exit; no real host, no ~/.ssh, no known_hosts, no firewall or service change.
import { execFileSync, spawnSync } from "node:child_process"
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
import { hashSecret } from "../../../own-accounts/test/e2e-kit/fakes/shared"
import { TITLE_PROMPT } from "../../../own-team/test/e2e/directives"
import { FAKE_KEYS, PROVIDER_LOG, SLOW_MARK, STATE_FILE } from "./support"

export const DEV_PORT = Number(process.env.OWN_WEB_E2E_REMOTE_PORT ?? 5421)
export { STATE_FILE } from "./support"

const VERSION = "2.0.18-own.9"
/** oldbox runs this older release (04 §5.7: the PC was updated, the host was not). */
const OLD_VERSION = "2.0.18-own.8"
const MODEL = "gpt-5.5"
/** `ko` or `en`: the texts of the README's picture (own/scripts/readme) in place of the tests' own. */
const DEMO = process.env.OWN_WEB_E2E_REMOTE_DEMO
const DEMO_ANSWER =
  DEMO === "en"
    ? [
        "This is `example-game` on the server.",
        "",
        "- `README.md` describes the project and has one change that is not committed.",
        "- It is a Git repository with a single commit.",
        "",
        "I read it on the host itself; the model request went out with an account of your PC.",
      ]
    : [
        "서버에 있는 `example-game`이에요.",
        "",
        "- `README.md`에 프로젝트 설명이 있고, 커밋하지 않은 변경이 하나 있어요.",
        "- 커밋이 하나 있는 Git 저장소예요.",
        "",
        "파일은 서버에서 바로 읽었고, 모델 요청은 PC에 등록한 계정으로 보냈어요.",
      ]
const KEYS = FAKE_KEYS
const PASSWORD = "pw-e2e-remote-0000"
/** R's first mirror sync waits this long (own-accounts `broker.mirrorDelayMs`). */
const MIRROR_DELAY_MS = 20_000
const ACCOUNTS_PLUGIN = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE_PLUGIN = path.join(REPO_ROOT, "packages/own-remote")
const STUB_SERVICE = path.join(REMOTE_PLUGIN, "test/harness/fake-service.ts")
/** One build id for both plugins on L, as in production: own-remote finds the local broker under it (04 §4.2). */
const BUILD_ID = `own-web-e2e-remote-${process.pid}`

if (!Harness.available) {
  console.error("own-web remote e2e needs Windows with Git for Windows (bash plays the remote host)")
  process.exit(1)
}

/** `OWN_E2E_DEBUG_DIR=<dir>`: keep the local and remote server logs there (outside the temp roots removed on exit). */
const DEBUG_DIR = process.env.OWN_E2E_DEBUG_DIR
const debugEnv: Record<string, string> = DEBUG_DIR ? { OWN_E2E_DEBUG_DIR: DEBUG_DIR } : {}

const harness = Harness.create({
  version: VERSION,
  hosts: {
    devbox: { known: false, env: debugEnv },
    pwbox: { known: true, password: PASSWORD, env: debugEnv },
    farbox: { known: true },
    oldbox: { known: true, env: { OWN_FAKE_SERVICE: Harness.toPosix(STUB_SERVICE) } },
  },
})
// The fake bundle's launcher runs $OWN_FAKE_SERVICE: point it at this suite's service (real server + proxy).
const sshState = JSON.parse(fs.readFileSync(harness.statePath, "utf8")) as Record<string, unknown> & {
  hosts: Record<string, { fingerprint: string; home: string }>
}
sshState.service = path.join(import.meta.dir, "remote-service.ts")
fs.writeFileSync(harness.statePath, JSON.stringify(sshState, null, 2))

// Remote projects: a Git repository with a change (review tab), another folder, and a junction to the first one
// (agent.realpath → "심볼릭 링크 대신 실제 경로로 열어요").
for (const alias of ["devbox", "pwbox"]) {
  const home = harness.hostHome(alias)
  const game = path.join(home, "work", "example-game")
  fs.mkdirSync(game, { recursive: true })
  fs.mkdirSync(path.join(home, "work", "notes"), { recursive: true })
  fs.writeFileSync(path.join(game, "README.md"), "# example-game\n\nremote project for own-web e2e\n")
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=own-web e2e", ...args], {
      cwd: game,
      windowsHide: true,
      stdio: "ignore",
    })
  git("init", "-q")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  fs.appendFileSync(path.join(game, "README.md"), "changed on the remote host\n")
  fs.symlinkSync(game, path.join(home, "link-game"), "junction")
}

// One fake provider for L and R. It sees only hashed credentials; the answer names the account whose key the request
// carried, and every model request is logged (account label and time, never a key) for the tests.
const labels = new Map<string, string>(Object.entries(KEYS).map(([label, key]) => [hashSecret(`Bearer ${key}`), label]))
fs.mkdirSync(path.dirname(PROVIDER_LOG), { recursive: true })
fs.rmSync(PROVIDER_LOG, { force: true })
const responses = startFakeOpenAIResponses({
  models: [MODEL],
  responder: (request) => {
    const account = labels.get(request.headers.authorization ?? "") ?? "unknown"
    fs.appendFileSync(PROVIDER_LOG, JSON.stringify({ at: Date.now(), account }) + "\n")
    // The silent-link test (remote.pw.ts) needs an answer the host writes while its link is down: the newest user
    // message asks for it (the history repeats older ones).
    if (request.body.lastIndexOf(SLOW_MARK) > request.body.lastIndexOf('"role":"user"'))
      return { type: "text", text: `${account} 계정으로 늦게 온 답`, delayMs: 8_000 }
    if (DEMO && request.body.includes(TITLE_PROMPT))
      return { type: "text", text: DEMO === "en" ? "Server project tour" : "서버 프로젝트 살펴보기" }
    return { type: "text", text: DEMO ? DEMO_ANSWER.join("\n") : `${account} 계정으로 온 답` }
  },
})

// L's temp tree, created before L so oldbox can be installed at the older release first (same OWN_HOME, so the same
// install id: L sees its own install, not another PC's).
const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "own-web-e2e-remote-local-"))
const localOwnHome = path.join(localRoot, "own-home")
fs.mkdirSync(localOwnHome, { recursive: true })
/**
 * own-remote's limit for a short remote script (`scriptTimeoutMs`, default 120 s): inspect, an operation's plan, and
 * ensure until the remote service registered. On this PC under the user's load (2026-11-12, decisions US6-21) a Git
 * Bash process of the fake host took up to 6 s to start, the inspect script with its three login shells 64-91 s and
 * once past 120 s, and the remote server's boot from source 52-135 s (13-16 s on its own), so 120 s failed the add
 * step (`연결하지 못했어요 · connection`) and oldbox's setup here. remote-service.ts waits a little less.
 */
const SCRIPT_TIMEOUT_MS = 300_000
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
  // What an older release of this PC did: add oldbox, install, connect (own-remote's broker test double), disconnect.
  // Its stub service keeps running on the host (04 §6.2).
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
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
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
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`${id} ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

const accounts: Record<string, { id: string; providerID: string; label: string }> = {}
for (const [label, key] of Object.entries(KEYS)) {
  const added = await rpc("own.accounts", "accounts.add.key", { kind: "oai", label, key })
  const account = added.account as { id: string; providerID: string }
  accounts[label] = { id: account.id, providerID: account.providerID, label }
}
const alpha = accounts.Alpha!
await server.waitForModels([{ providerID: alpha.providerID, id: MODEL }])
// A local session with one answered turn: the usage table then has a local row next to the remote one.
const localSession = await server.createSession({
  title: DEMO === "en" ? "Notes on this PC" : DEMO ? "이 PC의 메모" : "로컬 세션 하나",
  model: { providerID: alpha.providerID, id: MODEL },
})
await server.prompt(localSession.id, "로컬에서 안녕")
await server.waitIdle(localSession.id)

// R's settings: the repository packages instead of the bundle's, the build id, the fake provider and the placeholder
// dial of the fake -R socket. Plugins, modes and OWN_HOME come from the managed config ensure writes (04 §5.6).
fs.writeFileSync(
  path.join(harness.testRoot, "e2e-remote.json"),
  JSON.stringify({
    accountsPlugin: ACCOUNTS_PLUGIN,
    remotePlugin: REMOTE_PLUGIN,
    buildId: BUILD_ID,
    endpoints: { openai: responses.baseURL },
    // The first mirror of this PC's accounts lands 20 s after the broker connected, as a slow broker does under load:
    // the first remote prompt must wait for it (MR11-1).
    broker: { dial: "placeholder", mirrorDelayMs: MIRROR_DELAY_MS },
    // The fake host's PATH is MSYS's /usr/bin (no git); the Windows server needs Git for Windows' git.exe.
    pathPrepend: [path.dirname(Bun.which("git") ?? "C:\\Program Files\\Git\\cmd\\git.exe")],
    // `opencode service start` waits this long for the server to register, inside ensure's window.
    startWaitMs: SCRIPT_TIMEOUT_MS - 20_000,
  }),
)
// farbox: known to own-remote but never connected (a sidebar group from the list alone).
await rpc("own.remote", "hosts.add", { alias: "farbox" })

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: control,
})
// No watcher and no HMR: edits elsewhere in the tree during a run must not reload the page mid-flow.
const dev = await startViteDev({ port: DEV_PORT, watch: null, hmr: false })

const state = {
  dev: `http://127.0.0.1:${DEV_PORT}`,
  control,
  localPassword: password,
  account: alpha,
  accounts,
  model: MODEL,
  version: VERSION,
  oldVersion: OLD_VERSION,
  localSession: { id: localSession.id, title: "로컬 세션 하나" },
  hosts: Object.fromEntries(
    Object.entries(sshState.hosts).map(([alias, host]) => [
      alias,
      { fingerprint: host.fingerprint, home: host.home, posixHome: Harness.toPosix(host.home) },
    ]),
  ),
  password: PASSWORD,
  testRoot: harness.testRoot,
  ownHome: server.paths.ownHome,
  serverRoot: server.paths.root,
}
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_E2E_REMOTE_READY ${DEV_PORT}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  if (DEBUG_DIR) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true })
    fs.writeFileSync(path.join(DEBUG_DIR, "local-server.log"), server.logs())
  }
  await dev.close().catch(() => undefined)
  await server.stop().catch(() => undefined)
  await responses.stop().catch(() => undefined)
  // Remote services (proxy + its server) registered their pids under the fake /proc; kill the trees, then the root.
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
// By hand without a terminal: create `<state dir>/stop` to shut everything down cleanly.
const STOP_FILE = path.join(path.dirname(STATE_FILE), "stop")
fs.rmSync(STOP_FILE, { force: true })
setInterval(() => fs.existsSync(STOP_FILE) && void stop(), 1_000)
