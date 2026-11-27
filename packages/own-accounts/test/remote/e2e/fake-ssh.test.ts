// End to end over the fake-SSH harness (04 §20.1 "가짜 ssh", RG6/RG8/RG10 parts, no real host):
//
//   test → local OpenCode server L (own-accounts local + the credential broker, own-remote local)
//        → own.remote connect → fake ssh (own-remote's harness: Git bash plays the host, -L/-R are local relays)
//        → ensure in the tunnel session starts the "remote service": a real OpenCode server R booted from source with
//          own-accounts mode:"remote" + own-remote mode:"agent" (real-service.ts)
//        → arm through -L, R's broker client dials back through -R to L's broker.
//
// Scenario: accounts exist only on L (memory vault); a session on R uses them through leases (per-request
// credential on the fake provider), switches account with own.accounts on R, R's usage lands in L's ledger with
// `server = hostId`; after a disconnect and the lease's end R fails closed (no request reaches the provider, the turn
// stops after the grace); a turn that is retrying resumes when the tunnel comes back. The API keys never reach the
// remote disk. Every credential is fake; nothing touches ~/.ssh, known_hosts, the firewall or a real host.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import * as Harness from "../../../../own-remote/test/harness/remote.js"
import {
  E2E_TRANSPILER_CACHE,
  REPO_ROOT,
  hashSecret,
  opencodeConfig,
  removeTree,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
  type RecordedRequest,
} from "../../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.0.18-own.9"
const MODEL = "gpt-5.5"
const KEY_A = "sk-proj-e2eRemoteAlpha0000000000000000001"
const KEY_B = "sk-proj-e2eRemoteBravo0000000000000000002"
const LEASE_MS = 4_000
const BROKER_WAIT_MS = 1_500
const GRACE_SECONDS = 20
/**
 * The grace of the resume test: its reconnect has to land inside it. Over the fake SSH host a reconnect (tunnel to
 * arm) takes about 8 s on a quiet PC and took about 20 s under other suites' load, which lost the turn against the
 * 20 s the fail-closed test waits out.
 */
const RESUME_GRACE_SECONDS = 120
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE = path.join(REPO_ROOT, "packages/own-remote")

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

function isModelCall(request: RecordedRequest) {
  return request.path.startsWith("/v1/responses")
}

run("own-accounts remote mode end to end over fake SSH", () => {
  const state = {} as {
    harness: Harness.Harness
    fake: FakeOpenAIResponses
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    alpha: { id: string; providerID: string }
    bravo: { id: string; providerID: string }
    sessionID: string
    outputs: string[]
    scratch: string
  }
  state.outputs = []

  /** own.accounts / own.remote on L at its control location. */
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

  /**
   * A request to R. `tunnel` (default): through the resolved endpoint (the -L forward) with own-remote's short server
   * token, like own-web. `direct`: to the service port with its password, like a client on the host itself (a TUI),
   * which still works while the PC's tunnel is down.
   */
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
  async function remoteOnce(
    method: string,
    route: string,
    options: { body?: unknown; directory?: string; via?: "tunnel" | "direct" } = {},
  ) {
    const direct = options.via === "direct" ? registration() : undefined
    const url = new URL(route, direct?.url ?? state.remote.url)
    const directory = options.directory ?? state.workspace
    if (route.startsWith("/api/rpc/")) url.searchParams.set("location[directory]", directory)
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Basic ${btoa(`opencode:${direct?.password ?? state.remote.token}`)}`,
        "x-opencode-directory": encodeURIComponent(directory),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    state.outputs.push(text)
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  /** The remote service's registration (`service-own.json`: url + password) on the fake host. */
  function registration() {
    const file = path.join(state.harness.hostHome("lab"), ".local", "state", "opencode", "service-own.json")
    return JSON.parse(fs.readFileSync(file, "utf8")) as { readonly url: string; readonly password: string }
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

  async function prompt(sessionID: string, text: string, via: "tunnel" | "direct" = "tunnel") {
    const admitted = await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text }, via })
    if (admitted.status !== 200) throw new Error(`prompt: ${admitted.status} ${JSON.stringify(admitted.body)}`)
  }
  const waitIdle = (sessionID: string, via: "tunnel" | "direct" = "tunnel") =>
    remote("POST", `/api/experimental/session/${sessionID}/wait`, { via })

  beforeAll(async () => {
    const fake = startFakeOpenAIResponses({ models: [MODEL] })
    state.fake = fake
    const buildId = `e2e-remote-broker-${process.pid}`
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-accounts-remote-e2e-"))
    state.scratch = scratch
    const configFile = path.join(scratch, "e2e-config.json")
    const harness = Harness.create({
      version: VERSION,
      hosts: {
        lab: {
          env: {
            // The remote service of this test is a real server (see real-service.ts), not own-remote's stub.
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(import.meta.dir, "real-service.ts")),
            OWN_E2E_CONFIG: Harness.toPosix(configFile),
          },
        },
      },
    })
    state.harness = harness
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        repo: REPO_ROOT,
        buildId,
        endpoints: { openai: fake.baseURL },
        logs: path.join(harness.testRoot, "e2e-logs"),
        transpilerCache: E2E_TRANSPILER_CACHE,
      }),
    )
    state.local = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: {
                home: paths.ownHome,
                buildId,
                vault: "memory",
                endpoints: { openai: fake.baseURL },
                broker: { leaseMs: LEASE_MS, brokerWaitMs: BROKER_WAIT_MS },
              },
            },
            {
              package: REMOTE,
              options: {
                home: paths.ownHome,
                buildId,
                version: VERSION,
                sshCommand: harness.sshCommand,
                askpassHelper: harness.askpassHelper,
                remoteBundles: harness.bundles,
                sshDir: harness.sshDir,
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
    // `OWN_E2E_DEBUG_DIR=<dir>`: keep the server logs of both sides for a failed run.
    const debug = process.env.OWN_E2E_DEBUG_DIR
    if (debug && state.harness) {
      fs.mkdirSync(debug, { recursive: true })
      fs.writeFileSync(path.join(debug, "local-server.log"), state.local?.logs() ?? "")
      const logs = path.join(state.harness.testRoot, "e2e-logs")
      if (fs.existsSync(logs)) fs.cpSync(logs, path.join(debug, "remote"), { recursive: true })
      fs.writeFileSync(path.join(debug, "ssh.log.json"), JSON.stringify(state.harness.sshLog(), null, 1))
      fs.writeFileSync(path.join(debug, "service-events.json"), JSON.stringify(state.harness.serviceEvents(), null, 1))
    }
    await state.local?.stop()
    await state.harness?.cleanup()
    await state.fake?.stop()
    if (state.scratch) await removeTree(state.scratch)
  }, 120_000)

  test("accounts live on this PC only; the host is added, installed and connected; the remote mirrors them", async () => {
    const health = await localOk(OwnAccounts.ID, "health")
    expect(health).toMatchObject({ guard: "ok", mode: "local" })
    const alpha = await localOk(OwnAccounts.ID, "accounts.add.key", { kind: "oai", label: "Alpha", key: KEY_A })
    const bravo = await localOk(OwnAccounts.ID, "accounts.add.key", { kind: "oai", label: "Bravo", key: KEY_B })
    state.alpha = { id: alpha.account.id, providerID: alpha.account.providerID }
    state.bravo = { id: bravo.account.id, providerID: bravo.account.providerID }

    const added = await localOk("own.remote", "hosts.add", { alias: "lab" })
    state.hostId = added.host.id
    // A grace short enough to wait out (the fail-closed test below); the resume test sets its own.
    await localOk("own.remote", "hosts.update", { hostId: state.hostId, failClosedGraceSeconds: GRACE_SECONDS })
    const first = await connect()
    expect(first.stage).toBe("needs_install")
    const plan = await localOk("own.remote", "prepare.plan", { hostId: state.hostId })
    const executed = await localOk("own.remote", "prepare.execute", { nonce: plan.nonce })
    expect(executed.ok).toBe(true)
    const ready = await connect()
    expect(ready.stage).toBe("ready")
    const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
    expect(resolved.url).toMatch(/^http:\/\/127\.0\.\d+\.2:\d+$/)
    // The remote service serves on the harness's free port, never on the channel default the installed service holds.
    expect(state.harness.registeredPort("lab")).toBe(state.harness.servicePort("lab"))
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("lab"), "work")
    const view0 = await host()

    // R: own-accounts in remote mode, armed, connected to L's broker, with the mirror in place.
    let lastHealth: unknown
    const remoteHealth = await until(async () => {
      const result = await remoteRpc("health", {}, state.remote.controlDir)
      lastHealth = result
      const output = result.body?.output as Json | undefined
      return output?.broker?.state === "connected" && output.mirror?.revision !== null ? output : undefined
    }, 120_000, 500).catch((error: unknown) => {
      throw new Error(`${String(error)}; last remote health: ${JSON.stringify(lastHealth)}; host: ${JSON.stringify(view0)}`)
    })
    expect(remoteHealth).toMatchObject({ guard: "ok", mode: "remote" })
    expect(remoteHealth).not.toHaveProperty("vault")
    const view = await host()
    expect(view.broker).toMatchObject({ state: "connected", mode: "normal" })

    const models = await until(async () => {
      const listed = await remote("GET", "/api/model")
      const data = (listed.body?.data ?? []) as Json[]
      const own = data.filter((model) => String(model.providerID).startsWith("own-") && model.id === MODEL)
      return own.length >= 2 ? own : undefined
    }, 60_000, 500)
    expect(models.map((model) => model.providerID).toSorted()).toEqual([state.alpha.providerID, state.bravo.providerID].toSorted())

    // Account changes are refused on the remote: they are made on this PC (04 §16.5).
    const refused = await remoteRpc("accounts.add.key", { kind: "oai", label: "X", key: "sk-proj-never-stored-remotely-000000" }, state.remote.controlDir)
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ type: "remote_managed", data: { method: "accounts.add.key" } })
    // The mirror carries no identifiers: `accounts.list` on the remote has no key hints.
    const remoteList = await remoteRpc("accounts.list", {}, state.remote.controlDir)
    expect(JSON.stringify(remoteList.body)).not.toContain("…")
  }, 480_000)

  test("a remote session uses the local accounts through leases, and switches account with own.accounts", async () => {
    const fake = state.fake
    fake.reset()
    const created = await remote("POST", "/api/session", {
      body: { title: "remote e2e", model: { providerID: state.alpha.providerID, id: MODEL }, location: { directory: state.workspace } },
    })
    expect(created.status).toBe(200)
    state.sessionID = created.body.data.id
    fake.enqueue({ type: "text", text: "remote answer one" })
    await prompt(state.sessionID, "first question on the host")
    await waitIdle(state.sessionID)
    let calls = await fake.waitForRequests(1, { filter: isModelCall })
    expect(calls[0]!.status).toBe(200)
    expect(calls[0]!.headers.authorization).toBe(hashSecret(`Bearer ${KEY_A}`))

    const target = { providerID: state.bravo.providerID, id: MODEL }
    const estimate = await remoteRpc("switch.estimate", { sessionID: state.sessionID, target })
    expect(estimate.status).toBe(200)
    const applied = await remoteRpc("switch.apply", {
      sessionID: state.sessionID,
      estimateID: estimate.body.output.estimateID,
      target,
      strategy: "now",
      reason: "manual",
    })
    expect(applied.status).toBe(200)
    fake.enqueue({ type: "text", text: "remote answer two" })
    await prompt(state.sessionID, "second question, now on bravo")
    await waitIdle(state.sessionID)
    calls = await fake.waitForRequests(2, { filter: isModelCall })
    expect(calls.map((call) => call.headers.authorization)).toEqual([hashSecret(`Bearer ${KEY_A}`), hashSecret(`Bearer ${KEY_B}`)])
    const binding = await remoteRpc("session.binding", { sessionIDs: [state.sessionID] })
    expect(binding.body.output.bindings[0]).toMatchObject({ accountID: state.bravo.id })
  }, 180_000)

  test("the remote's usage lands in the local ledger with server = hostId (local answers for every server)", async () => {
    const steps = await until(async () => {
      const result = await localOk(OwnAccounts.ID, "ledger.session", { sessionID: state.sessionID, server: state.hostId })
      const list = result.steps as Json[]
      return list.filter((line) => line.kind === "primary").length >= 2 ? list : undefined
    }, 60_000, 500)
    const primary = steps.filter((line) => line.kind === "primary")
    expect(primary.map((line) => line.accountID)).toEqual([state.alpha.id, state.bravo.id])
    expect(primary.every((line) => line.server === state.hostId && typeof line.remoteAt === "number")).toBe(true)
    // Nothing for this session on the local server key.
    const none = await localOk(OwnAccounts.ID, "ledger.session", { sessionID: state.sessionID, server: "local" })
    expect(none.steps).toEqual([])
    const usage = await localOk(OwnAccounts.ID, "accounts.usage", { from: Date.now() - 3_600_000, to: Date.now() + 60_000, groupBy: "server" })
    expect((usage.rows as Json[]).map((row) => row.key)).toContain(state.hostId)
    const view = await host()
    expect(view.broker.lastPushAt).not.toBeNull()
  }, 90_000)

  // RG17's sibling for the default state of a new host (04 §5.6 `instructions`): the repository's AGENTS.md is read,
  // its code is not. A plugin that never loads sees no request, so no header and no leased credential.
  test("a new host reads a repository's AGENTS.md only: the leased request carries it, the repository's plugin never loads", async () => {
    const fake = state.fake
    expect((await host()).projectConfig).toBe("instructions")
    const repo = path.join(state.harness.hostHome("lab"), "repo-states")
    const probeLog = path.join(repo, "probe.log")
    fs.mkdirSync(path.join(repo, ".opencode", "plugins"), { recursive: true })
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "OWN-E2E-AGENTS-MARKER: follow the project rules.\n")
    fs.writeFileSync(
      path.join(repo, ".opencode", "plugins", "probe.ts"),
      [
        'import fs from "node:fs"',
        `const log = (entry: unknown) => fs.appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify(entry) + "\\n")`,
        "export default {",
        '  id: "e2e-states-probe",',
        "  setup: async (ctx: any) => {",
        '    log({ event: "loaded" })',
        '    await ctx.session.hook("http.request", async (event: any) => {',
        '      log({ event: "http.request", headers: [...event.request.headers.keys()], auth: event.request.headers.has("authorization") })',
        "    })",
        "  },",
        "}",
        "",
      ].join("\n"),
    )
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo }).exitCode).toBe(0)
    const created = await remote("POST", "/api/session", {
      body: { title: "project states", model: { providerID: state.alpha.providerID, id: MODEL }, location: { directory: repo } },
      directory: repo,
    })
    expect(created.status).toBe(200)
    const before = fake.requests.filter(isModelCall).length
    fake.enqueue({ type: "text", text: "read the rules" })
    const admitted = await remote("POST", `/api/session/${created.body.data.id}/prompt`, { body: { text: "what are the rules here" }, directory: repo })
    expect(admitted.status).toBe(200)
    await remote("POST", `/api/experimental/session/${created.body.data.id}/wait`, { directory: repo })
    const calls = (await fake.waitForRequests(before + 1, { filter: isModelCall })).slice(before)
    // The request went out on the leased key of the PC's account, with the repository's instructions in it.
    expect(calls.map((call) => [call.status, call.headers.authorization])).toEqual([[200, hashSecret(`Bearer ${KEY_A}`)]])
    expect(calls[0]!.body).toContain("OWN-E2E-AGENTS-MARKER")
    // The repository's plugin was never loaded: it saw neither the request nor its credential.
    expect(fs.existsSync(probeLog)).toBe(false)
    const health = (await remoteRpc("health", {}, repo)).body?.output as Json | undefined
    expect(((health?.warnings ?? []) as string[]).filter((warning) => warning.startsWith("untrusted_plugin"))).toEqual([])
  }, 180_000)

  // 03 §5.1 and §18.3 (2.2.6-own.16): a folderless conversation on the host and the host's folder picker, both answered
  // by the host's own service through the tunnel, in the host's home.
  test("the host keeps its own default conversation folder; ~/… is the host's home; the picker lists and makes folders there", async () => {
    const control = state.remote.controlDir
    const home = state.harness.hostHome("lab")
    const output = async (method: string, input: unknown) => {
      const answer = await remoteRpc(method, input, control)
      if (answer.status !== 200) throw new Error(`${method}: ${answer.status} ${JSON.stringify(answer.body)}`)
      return answer.body.output as Json
    }
    const builtin = await output("conversationFolder.get", {})
    expect(builtin).toMatchObject({ custom: false, exists: false })
    expect(String(builtin.path).toLowerCase().startsWith(home.toLowerCase())).toBe(true)

    const chosen = path.join(home, "projects", "own-chats")
    expect(await output("conversationFolder.set", { path: "~/projects/own-chats" })).toEqual({
      path: chosen,
      defaultPath: builtin.path,
      custom: true,
      exists: true,
    })
    expect(await output("conversationFolder.ensure", {})).toMatchObject({ path: chosen, exists: true })
    expect(fs.existsSync(String(builtin.path))).toBe(false)
    const created = await remote("POST", "/api/session", {
      body: {
        title: "폴더 없이",
        model: { providerID: state.alpha.providerID, id: MODEL },
        location: { directory: chosen },
      },
      directory: chosen,
    })
    expect(created.status).toBe(200)

    const listed = await output("folderPicker.list", { path: "~/projects" })
    expect(listed).toEqual({
      path: path.join(home, "projects"),
      entries: [{ name: "own-chats", locked: false }],
      hidden: 0,
    })
    const made = await output("folderPicker.create", { parent: "~/projects", name: " 새 프로젝트 " })
    expect(made).toEqual({ path: path.join(home, "projects", "새 프로젝트") })
    expect(fs.statSync(String(made.path)).isDirectory()).toBe(true)
    const again = await remoteRpc("folderPicker.create", { parent: "~/projects", name: "새 프로젝트" }, control)
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(again.body)).toContain("folder_create_unavailable")
    expect(JSON.stringify(again.body)).toContain('"exists"')
    const missing = await remoteRpc("folderPicker.list", { path: "~/nowhere" }, control)
    expect(JSON.stringify(missing.body)).toContain('"missing"')

    expect(await output("conversationFolder.set", { path: null })).toMatchObject({ path: builtin.path, custom: false })
    // Nothing moved: the chosen folder and its conversation stay where they are.
    expect(fs.existsSync(chosen)).toBe(true)
  }, 120_000)

  test("disconnect → the lease runs out → fail closed: nothing reaches the provider and the turn stops after the grace", async () => {
    const fake = state.fake
    await localOk("own.remote", "disconnect", { hostId: state.hostId })
    await until(async () => (await host()).broker.state !== "connected", 30_000, 250)
    await Bun.sleep(LEASE_MS + 500)
    const before = fake.requests.filter(isModelCall).length
    const started = Date.now()
    await prompt(state.sessionID, "a question while the PC is unreachable", "direct")
    await waitIdle(state.sessionID, "direct")
    const took = Date.now() - started
    // Bounded by the grace plus the first attempt's broker wait (04 §8.7), with room for the retry schedule's jitter.
    expect(took).toBeLessThan((GRACE_SECONDS + 20) * 1000)
    expect(took).toBeGreaterThanOrEqual((GRACE_SECONDS - 5) * 1000)
    expect(fake.requests.filter(isModelCall).length).toBe(before)
    // The turn ended as failed (core logs the sink's 401 as the provider failure).
    const messages = await remote("GET", `/api/session/${state.sessionID}/message`, { via: "direct" })
    expect(messages.body.data[0]).toMatchObject({ type: "idle", outcome: "failed" })
  }, 120_000)

  test("reconnect → a turn waiting within the grace resumes and its request carries the leased key", async () => {
    const fake = state.fake
    // The remote learns the grace from the broker's `ready`, so one connection delivers the longer one; then the PC
    // is unreachable again and the lease runs out, as after the test above.
    await localOk("own.remote", "hosts.update", { hostId: state.hostId, failClosedGraceSeconds: RESUME_GRACE_SECONDS })
    expect((await connect()).stage).toBe("ready")
    await until(async () => (await host()).broker.state === "connected", 60_000, 250)
    await localOk("own.remote", "disconnect", { hostId: state.hostId })
    await until(async () => (await host()).broker.state !== "connected", 30_000, 250)
    await Bun.sleep(LEASE_MS + 500)
    const before = fake.requests.filter(isModelCall).length
    fake.enqueue({ type: "text", text: "resumed after the reconnect" })
    await prompt(state.sessionID, "continue once the PC is back", "direct")
    // Let the turn hit the sink at least once, then bring the tunnel back (a new epoch, re-armed).
    await Bun.sleep(BROKER_WAIT_MS + 1_000)
    expect(fake.requests.filter(isModelCall)).toHaveLength(before)
    const ready = await connect()
    expect(ready.stage).toBe("ready")
    await waitIdle(state.sessionID, "direct")
    const calls = await fake.waitForRequests(before + 1, { filter: isModelCall })
    expect(calls.at(-1)!.status).toBe(200)
    expect(calls.at(-1)!.headers.authorization).toBe(hashSecret(`Bearer ${KEY_B}`))
    const messages = await remote("GET", `/api/session/${state.sessionID}/message`, { via: "direct" })
    expect(JSON.stringify(messages.body.data)).toContain("resumed after the reconnect")
    expect((await host()).broker.state).toBe("connected")
  }, 480_000)

  test("secret hygiene: no API key on the remote disk or in the remote server logs; no key in RPC outputs", async () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile() && !file.endsWith(".db-shm")) {
          const data = fs.readFileSync(file)
          if (data.includes(KEY_A) || data.includes(KEY_B)) hits.push(file)
        }
      }
    }
    walk(state.harness.hostHome("lab"))
    walk(path.join(state.harness.testRoot, "e2e-logs"))
    expect(hits).toEqual([])
    for (const output of state.outputs) {
      expect(output).not.toContain(KEY_A)
      expect(output).not.toContain(KEY_B)
    }
    expect(state.local.logs()).not.toContain(KEY_A)
  })
})
