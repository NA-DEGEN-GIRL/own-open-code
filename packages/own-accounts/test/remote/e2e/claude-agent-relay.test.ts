// CAG-R (02 §8.10.13, 04 §8.13): the Claude Agent route in a host conversation, end to end over the fake-SSH harness
// (no real host):
//
//   test → local OpenCode server L (own-accounts local with the broker, own-remote local, core's Claude Agent provider
//          with the fake `claude` CLI as its binary and two Claude Agent accounts whose folders hold fake logins)
//        → own.remote connect → fake ssh (Git bash plays the host)
//        → the remote service R: a real OpenCode server from source with own-accounts mode:"remote" (real-service.ts)
//
// R lists the PC's Claude Agent models once its mirror offers the accounts; a conversation on R runs its claude on L
// (in L's account folder and a working folder of L's for the host folder), and its tools on R; after a disconnect and
// a reconnect the next turn resumes the same Claude conversation; a switch to the second account on R resumes it there
// (the shared transcript folder); a compaction runs through the PC too; the PC's limits get the host turns' windows,
// and no login (token, e-mail) ever reaches the host.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import * as Harness from "../../../../own-remote/test/harness/remote.js"
import { E2E_TRANSPILER_CACHE, REPO_ROOT, opencodeConfig, removeTree, startOpencodeServer, type OpencodeServer } from "../../e2e-kit"

setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.0.18-own.9"
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE = path.join(REPO_ROOT, "packages/own-remote")
const FAKE_CLAUDE = path.join(REPO_ROOT, "packages/core/test/plugin/provider/claude-agent/lib/fake-claude-cli.ts")
const TOKEN = "sk-ant-oat01-ownE2eAgentRelayFakeToken00000000001"
const TOKEN2 = "sk-ant-oat01-ownE2eAgentRelayFakeToken00000000002"
const EMAIL = "fake-owner@example.invalid"
const MODEL = { providerID: "claude-agent", id: "sonnet" }

type Json = Record<string, any>

async function until<T>(read: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs: number, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`timeout${last ? `: ${String(last)}` : ""}`)
    await Bun.sleep(stepMs)
  }
}

interface Run {
  readonly args: string[]
  readonly cwd: string
  readonly env: string[]
  readonly anthropicConfigDir: string | null
}

function runs(folder: string): Run[] {
  const file = path.join(folder, "fake-claude-runs.jsonl")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Run)
}

const flag = (item: Run, name: string) => item.args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)

run("the Claude Agent route in a host conversation, claude on the PC (fake SSH)", () => {
  const state = {} as {
    harness: Harness.Harness
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    scratch: string
    accounts: Array<{ accountID: string; folder: string }>
    sessionID: string
    claudeSession: string
    outputs: string[]
  }
  state.outputs = []

  async function local(id: string, method: string, input: unknown = {}) {
    const response = await state.local.request("POST", `/api/rpc/${id}/${method}`, {
      body: { input },
      query: { "location[directory]": state.control },
      directory: state.control,
    })
    const text = await response.text()
    state.outputs.push(text)
    return { status: response.status, body: JSON.parse(text) as Json }
  }
  async function localOk(id: string, method: string, input: unknown = {}) {
    const result = await local(id, method, input)
    if (result.status !== 200) throw new Error(`${id}/${method}: ${result.status} ${JSON.stringify(result.body)}`)
    return result.body.output as Json
  }
  // Plugins load in the background since upstream v2.4.0 (#63814), in every Location of the host's service too: an RPC
  // into a Location that just booted answers `rpc.unavailable` until the plugin registered there (asked again, 60 s).
  async function remote(method: string, route: string, options: Parameters<typeof remoteOnce>[2] = {}) {
    const deadline = Date.now() + 60_000
    while (true) {
      const result = await remoteOnce(method, route, options)
      const body: unknown = result.body
      const unavailable =
        typeof body === "object" && body !== null && "type" in body && body.type === "rpc.unavailable"
      if (!route.startsWith("/api/rpc/") || !unavailable || Date.now() > deadline) return result
      await Bun.sleep(200)
    }
  }
  async function remoteOnce(method: string, route: string, options: { body?: unknown; directory?: string } = {}) {
    const url = new URL(route, state.remote.url)
    const directory = options.directory ?? state.workspace
    if (route.startsWith("/api/rpc/")) url.searchParams.set("location[directory]", directory)
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Basic ${btoa(`opencode:${state.remote.token}`)}`,
        "x-opencode-directory": encodeURIComponent(directory),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    state.outputs.push(text)
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  const remoteRpc = (method: string, input: unknown, directory?: string) =>
    remote("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, { body: { input }, directory })
  async function host() {
    const listed = await localOk("own.remote", "hosts.list")
    return (listed.hosts as Json[]).find((item) => item.id === state.hostId)!
  }
  async function connect() {
    await localOk("own.remote", "connect", { hostId: state.hostId, clientId: "e2e-tab" })
    return until(async () => {
      const view = await host()
      if (view.stage === "ready" || view.stage === "needs_install" || view.paused) return view
      return undefined
    }, 240_000, 500)
  }
  async function turn(sessionID: string, text: string) {
    const admitted = await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text } })
    expect(admitted.status).toBe(200)
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    return JSON.stringify((await remote("GET", `/api/session/${sessionID}/message`)).body.data)
  }
  const hostServes = () =>
    until(async () => {
      const listed = await remote("GET", "/api/model")
      return ((listed.body?.data ?? []) as Json[]).some(
        (model) => model.providerID === MODEL.providerID && model.id === MODEL.id && model.enabled !== false,
      )
    }, 120_000, 500)

  beforeAll(async () => {
    const buildId = `e2e-claude-agent-relay-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-ca-relay-e2e-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        ha: {
          env: {
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(import.meta.dir, "real-service.ts")),
            OWN_E2E_CONFIG: Harness.toPosix(configFile),
          },
        },
      },
    })
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        repo: REPO_ROOT,
        buildId,
        endpoints: {},
        logs: path.join(state.harness.testRoot, "e2e-logs"),
        transpilerCache: E2E_TRANSPILER_CACHE,
      }),
    )
    state.local = await startOpencodeServer({
      // The PC's provider runs the fake CLI as `claude` (P-051 reads the binary from here first).
      env: { OWN_OPEN_CODE: "1", OPENCODE_CLAUDE_PATH: FAKE_CLAUDE },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: { home: paths.ownHome, buildId, vault: "memory", broker: { brokerWaitMs: 1_500 } },
            },
            {
              package: REMOTE,
              options: {
                home: paths.ownHome,
                buildId,
                version: VERSION,
                sshCommand: state.harness.sshCommand,
                askpassHelper: state.harness.askpassHelper,
                remoteBundles: state.harness.bundles,
                sshDir: state.harness.sshDir,
                keepIntervalSeconds: 1,
                readyTimeoutMs: 120_000,
                backoffMs: [60_000],
                lingerSeconds: 0,
              },
            },
          ],
        }),
    })
    state.control = path.join(state.local.paths.ownHome, "control")
    fs.mkdirSync(state.control, { recursive: true })
  }, 240_000)

  afterAll(async () => {
    const debug = process.env.OWN_E2E_DEBUG_DIR
    if (debug && state.harness) {
      fs.mkdirSync(debug, { recursive: true })
      fs.writeFileSync(path.join(debug, "local-server.log"), state.local?.logs() ?? "")
      const logs = path.join(state.harness.testRoot, "e2e-logs")
      if (fs.existsSync(logs)) fs.cpSync(logs, path.join(debug, "remote"), { recursive: true })
    }
    await state.local?.stop()
    await state.harness?.cleanup()
    if (state.scratch) await removeTree(state.scratch)
  }, 120_000)

  test("two Claude Agent accounts on the PC; the host mirrors them and lists the PC's Claude Agent models", async () => {
    const first = await localOk(OwnAccounts.ID, "claudeAgent.setup", {})
    const second = await localOk(OwnAccounts.ID, "claudeAgent.setup", { add: true })
    expect(second.created).toBeDefined()
    state.accounts = (second.accounts as Json[]).map((item) => ({ accountID: item.accountID, folder: item.folder }))
    expect(state.accounts).toHaveLength(2)
    expect(state.accounts[0]!.accountID).toBe(first.accounts[0].accountID)
    // Fake Claude Code logins on the PC (the fake CLI only checks that the folder is set).
    for (const [index, account] of state.accounts.entries())
      fs.writeFileSync(
        path.join(account.folder, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: index === 0 ? TOKEN : TOKEN2, refreshToken: "fake-refresh" } }),
      )

    const added = await localOk("own.remote", "hosts.add", { alias: "ha" })
    state.hostId = added.host.id
    expect((await connect()).stage).toBe("needs_install")
    const plan = await localOk("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await localOk("own.remote", "prepare.execute", { nonce: plan.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("ha"), "work")
    fs.mkdirSync(state.workspace, { recursive: true })
    fs.writeFileSync(path.join(state.workspace, "host-only.txt"), "MARKER-ON-THE-HOST-7731\n")
    // The host's provider checks the PC's claude (a side call through the relay) and lists its models.
    await hostServes()
  }, 600_000)

  test("a host conversation: claude runs on the PC in the PC's folders, its tool runs on the host", async () => {
    const created = await remote("POST", "/api/session", {
      body: { title: "claude agent via pc", model: MODEL, location: { directory: state.workspace } },
    })
    expect(created.status).toBe(200)
    state.sessionID = created.body.data.id
    const file = path.join(state.workspace, "host-only.txt")
    const before = runs(state.accounts[0]!.folder).length
    const text = await turn(state.sessionID, `TOOL read ${JSON.stringify({ path: file })}`)
    // The host's read tool read the host's file; the PC's claude got its result over MCP and answered.
    expect(text).toContain("DONE")
    expect(text).toContain("MARKER-ON-THE-HOST-7731")
    const started = runs(state.accounts[0]!.folder).slice(before).filter((item) => item.args.includes("--include-partial-messages"))
    expect(started.length).toBeGreaterThanOrEqual(1)
    const chat = started.at(-1)!
    state.claudeSession = flag(chat, "--session-id") ?? flag(chat, "--resume")!
    expect(state.claudeSession).toMatch(/^[0-9a-f-]{36}$/)
    // claude ran in the PC's working folder for this host, with built-in tools off and the PC's allow-list environment.
    const hostsRoot = path.join(state.local.paths.ownHome, "claude-agent", "hosts")
    expect(path.resolve(chat.cwd).toLowerCase().startsWith(path.resolve(hostsRoot).toLowerCase())).toBe(true)
    expect(chat.args).toContain("--tools=")
    expect(
      chat.env.some((name) => /^(OPENCODE_|ANTHROPIC_)/i.test(name) && name.toUpperCase() !== "ANTHROPIC_CONFIG_DIR"),
    ).toBe(false)
    // Core P-045: the PC names the account folder's own Anthropic profile directory, never the PC's %APPDATA%\Anthropic.
    expect(chat.anthropicConfigDir).toBe(path.join(state.accounts[0]!.folder, "anthropic"))
    // The host's binding names the PC's default account.
    const bound = await remoteRpc("claudeAgent.session.get", { sessionID: state.sessionID })
    expect(bound.body.output).toEqual({ accountID: state.accounts[0]!.accountID, bound: true })
  }, 240_000)

  test("after a disconnect and a reconnect the next turn resumes the same Claude conversation", async () => {
    await localOk("own.remote", "disconnect", { hostId: state.hostId })
    await until(async () => ((await host()).stage === "disconnected" ? true : undefined), 60_000, 500)
    expect((await connect()).stage).toBe("ready")
    const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
    state.remote = { ...state.remote, url: resolved.url, token: resolved.token }
    await hostServes()
    const before = runs(state.accounts[0]!.folder).length
    const text = await turn(state.sessionID, "after the reconnect")
    expect(text).toContain("ECHO after the reconnect")
    const resumed = runs(state.accounts[0]!.folder).slice(before).find((item) => item.args.includes("--include-partial-messages"))!
    expect(flag(resumed, "--resume")).toBe(state.claudeSession)
  }, 360_000)

  test("switching the host conversation to the PC's second account resumes it there (shared transcripts)", async () => {
    const moved = await remoteRpc("claudeAgent.session.set", { sessionID: state.sessionID, accountID: state.accounts[1]!.accountID })
    expect(moved.status).toBe(200)
    expect(moved.body.output.accountID).toBe(state.accounts[1]!.accountID)
    const before = runs(state.accounts[1]!.folder).length
    const text = await turn(state.sessionID, "on the second account")
    expect(text).toContain("ECHO on the second account")
    const there = runs(state.accounts[1]!.folder).slice(before).find((item) => item.args.includes("--include-partial-messages"))!
    expect(flag(there, "--resume")).toBe(state.claudeSession)
    // A new conversation on the host starts on the host's own default, which the switcher may set.
    expect((await remoteRpc("claudeAgent.default.set", { accountID: state.accounts[1]!.accountID })).status).toBe(200)
  }, 240_000)

  test("a compaction of the host conversation runs through the PC; the next turn is a new Claude conversation", async () => {
    const compacted = await remote("POST", `/api/session/${state.sessionID}/compact`, { body: {} })
    expect(compacted.status).toBe(200)
    await remote("POST", `/api/experimental/session/${state.sessionID}/wait`)
    const before = runs(state.accounts[1]!.folder).length
    const text = await turn(state.sessionID, "after the compaction")
    expect(text).toContain("fake summary of the conversation")
    expect(text).toContain("ECHO after the compaction")
    const next = runs(state.accounts[1]!.folder).slice(before).find((item) => item.args.includes("--include-partial-messages"))
    expect(next).toBeDefined()
    expect(flag(next!, "--resume") ?? flag(next!, "--session-id")).not.toBe(state.claudeSession)
  }, 300_000)

  test("the PC's limits get the host turns' windows, and the PC's pool counted them", async () => {
    const snapshot = await localOk(OwnAccounts.ID, "quota.snapshot")
    const windows = JSON.stringify(snapshot)
    expect(windows).toContain(state.accounts[0]!.accountID)
    expect(windows).toContain("claude.5h")
    const status = await localOk(OwnAccounts.ID, "claudeAgent.status")
    expect(status.pool.cap).toBeGreaterThan(0)
  }, 60_000)

  test("hygiene: no Claude login, token or e-mail on the host; the host has no Claude Agent folder of its own", () => {
    const hits: string[] = []
    const credentials: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile() && !file.endsWith(".db-shm")) {
          if (entry.name === ".credentials.json") credentials.push(file)
          const bytes = fs.readFileSync(file)
          if (bytes.includes(TOKEN) || bytes.includes(TOKEN2) || bytes.includes(EMAIL)) hits.push(file)
        }
      }
    }
    walk(state.harness.hostHome("ha"))
    walk(path.join(state.harness.testRoot, "e2e-logs"))
    expect(hits).toEqual([])
    expect(credentials).toEqual([])
    for (const output of state.outputs) for (const secret of [TOKEN, TOKEN2, EMAIL]) expect(output).not.toContain(secret)
    expect(fs.existsSync(path.join(state.harness.ownHome("ha"), "claude-agent"))).toBe(false)
  }, 60_000)
})
