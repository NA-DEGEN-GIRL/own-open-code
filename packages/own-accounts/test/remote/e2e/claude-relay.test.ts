// B11 (04 §8.11, T12): the Claude subscription slot on a host, end to end over the fake-SSH harness (no real host):
//
//   test → local OpenCode server L (own-accounts local with the broker and its egress relay, own-remote local, and a
//          fake claude-auth shim installed in L's OWN_HOME, holding a fake account)
//        → own.remote connect → fake ssh (Git bash plays the host; both -R forwards are local relays, the egress one a
//          placeholder socket)
//        → the remote service R: a real OpenCode server from source with own-accounts mode:"remote" (real-service.ts)
//
// The PC acknowledges the slot and the remote notice, has a (fake) Claude Code login as its `anthropic` connection and
// switches the host on; the host's mirror turns `anthropic` on; a turn on R reaches the fake Anthropic only through
// L's relay (signed with the fake account on L; R never learns the upstream); a conversation on R bound to L's second
// Claude account (02 §8.7, egress proof v2) is signed with that account only; a turn cancelled mid-stream closes the
// upstream request; switching the host off refuses the next turn at once; no fake token ever reaches the host.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account, Broker, OwnAccounts } from "@own/protocol"
import { Store } from "@own/runtime"
import * as Harness from "../../../../own-remote/test/harness/remote.js"
import { ClaudeBundle } from "../../../src/plugins/bundle.js"
import { Notice } from "../../../src/plugins/notice.js"
import {
  E2E_TRANSPILER_CACHE,
  REPO_ROOT,
  opencodeConfig,
  removeTree,
  startFakeAnthropic,
  startOpencodeServer,
  type FakeAnthropic,
  type OpencodeServer,
} from "../../e2e-kit"
import { writeFakeClaudeAuth } from "../../support/fake-claude-auth.js"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.0.18-own.9"
const MODEL = "claude-haiku-4-5"
const TOKEN = "sk-ant-oat01-ownE2eRelayFakeToken0000000001"
const TOKEN2 = "sk-ant-oat01-ownE2eRelayFakeToken0000000002"
const SECOND = Account.ID.make("acc_01J9E2ECLAUDESECOND0000000")
const PIN = { version: "0.4.0-fake.7", integrity: "sha512-b3duLWUyZS1yZWxheS1mYWtl" }
const BROKER_WAIT_MS = 1_500
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE = path.join(REPO_ROOT, "packages/own-remote")
const SLOW = "please answer slowly"

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

interface Seen {
  readonly path: string
  readonly authorization: string | null
  readonly os: string | null
  readonly agent: string | null
  readonly egress: string | null
  readonly apiKey: string | null
  readonly body: string
}

/**
 * The relay's upstream: the fake Anthropic behind a recording front. A request whose last message asks to answer
 * slowly gets an event stream that never ends, and the front records when that request is aborted.
 */
function upstream(fake: FakeAnthropic) {
  const seen: Seen[] = []
  const aborted: number[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const body = await request.text()
      const url = new URL(request.url)
      seen.push({
        path: url.pathname + url.search,
        authorization: request.headers.get("authorization"),
        os: request.headers.get("x-stainless-os"),
        agent: request.headers.get("user-agent"),
        egress: request.headers.get(Broker.EGRESS_HEADER),
        apiKey: request.headers.get("x-api-key"),
        body,
      })
      if (body.includes(SLOW))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'))
              request.signal.addEventListener("abort", () => aborted.push(Date.now()))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      const headers = new Headers(request.headers)
      headers.delete("host")
      return fetch(new URL(url.pathname + url.search, fake.url), { method: request.method, headers, body })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, aborted, stop: () => server.stop(true) }
}

run("the Claude slot on a host through the PC's egress relay (fake SSH)", () => {
  const state = {} as {
    harness: Harness.Harness
    fake: FakeAnthropic
    front: ReturnType<typeof upstream>
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    sessionID: string
    scratch: string
    outputs: string[]
    /** The fake patch manifest's hash, which the ack names. */
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
  const remoteClaude = async () => (await remoteRpc("health", {}, state.remote.controlDir)).body?.output?.claudeSlot

  beforeAll(async () => {
    state.fake = startFakeAnthropic({ models: [MODEL] })
    state.front = upstream(state.fake)
    const buildId = `e2e-claude-relay-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-relay-e2e-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        hc: {
          env: {
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(import.meta.dir, "real-service.ts")),
            OWN_E2E_CONFIG: Harness.toPosix(configFile),
          },
        },
      },
    })
    // The host knows no Anthropic endpoint at all: only the PC's relay can reach the upstream.
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
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) => {
        // The PC's Claude plugin: a fake of the bundle in the app version's plugin folder (02 §8.2, a source run's
        // `app/current`), the patched plugin's exports with two fake signed-in accounts (02 §8.7): account 1 in the
        // folder `claude-auth.json` names, a second added one.
        const shim = ClaudeBundle.dir(path.join(paths.ownHome, "app", "current"))
        const one = path.join(paths.ownHome, "claude-one")
        const two = path.join(paths.ownHome, "claude-accounts", SECOND)
        const key = (folder: string) => (process.platform === "win32" ? folder.toLowerCase() : folder)
        fs.writeFileSync(path.join(paths.ownHome, "claude-auth.json"), JSON.stringify({ configDir: one, setAt: "2026-10-10T00:00:00Z" }))
        fs.writeFileSync(
          path.join(paths.ownHome, "accounts.json"),
          JSON.stringify({
            ...Store.emptyRegistry(),
            claudeAccounts: [
              {
                accountID: SECOND,
                key: key(two),
                configDir: two,
                label: "둘째",
                shortLabel: "C2",
                color: "amber",
                managed: true,
                addedAt: "2026-10-10T00:00:00Z",
              },
            ],
          }),
        )
        // A patched fake with its bundle record: own signs several accounts only on a bundle it verifies as `patched`.
        writeFakeClaudeAuth(shim, {
          version: PIN.version,
          integrity: PIN.integrity,
          account: { source: "fake-e2e", token: TOKEN },
          multi: true,
          accounts: { [key(one)]: TOKEN, [key(two)]: TOKEN2 },
        })
        return opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: {
                home: paths.ownHome,
                buildId,
                vault: "memory",
                broker: { brokerWaitMs: BROKER_WAIT_MS, claudeUpstream: state.front.url },
              },
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
            shim,
          ],
        })
      },
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
    state.front?.stop()
    await state.fake?.stop()
    if (state.scratch) await removeTree(state.scratch)
  }, 120_000)

  test("the PC's slot is ready and switched on for the host; the host mirrors `enabled`", async () => {
    // The fake bundle is loaded and verified (no consent since 2026-10-18); the remote consent names its pin.
    await until(
      async () => ((await localOk(OwnAccounts.ID, "plugin.claudeAuth.status")).order === "ok" ? true : undefined),
      60_000,
      500,
    )
    // A Claude Code login as the PC's `anthropic` connection (fake values; the relay never reads it).
    const created = await state.local.request("POST", "/api/credential", {
      body: {
        integrationID: "anthropic",
        label: "Claude Max · e2e@example.test",
        value: { type: "oauth", methodID: "claude-code", refresh: "fake-refresh", access: "fake-access", expires: 0 },
      },
    })
    expect(created.status).toBe(200)
    await localOk(OwnAccounts.ID, "plugin.claudeAuth.remote.ack", { ...PIN, noticeHash: Notice.REMOTE_HASH })

    const added = await localOk("own.remote", "hosts.add", { alias: "hc" })
    state.hostId = added.host.id
    const status = await localOk(OwnAccounts.ID, "plugin.claudeAuth.status")
    expect(status.remote.acknowledged.valid).toBe(true)
    expect(await localOk(OwnAccounts.ID, "plugin.claudeAuth.remote.set", { hostId: state.hostId, enabled: true })).toEqual(
      { hostId: state.hostId, enabled: true, state: "enabled" },
    )

    const first = await connect()
    expect(first.stage).toBe("needs_install")
    const plan = await localOk("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await localOk("own.remote", "prepare.execute", { nonce: plan.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
    // The remote service serves on the harness's free port, never on the channel default the installed service holds.
    expect(state.harness.registeredPort("hc")).toBe(state.harness.servicePort("hc"))
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("hc"), "work")
    // Both forwards: the tunnel carries the egress socket next to the broker's.
    const tunnel = state.harness.sshLog().findLast((entry) => entry.locals.length > 0)!
    expect(tunnel.remotes).toHaveLength(2)
    expect(tunnel.remotes[0]).toMatch(/\/broker-\d+\.sock:127\.0\.0\.1:\d+$/)
    expect(tunnel.remotes[1]).toMatch(/\/egress-\d+\.sock:127\.0\.0\.1:\d+$/)

    const claude = await until(async () => {
      const value = await remoteClaude()
      return value?.state === "enabled" ? value : undefined
    }, 120_000, 500)
    expect(claude).toEqual({ state: "enabled", conflict: false })
    expect((await host()).broker.claude).toMatchObject({ state: "enabled" })
    // The model list of the host now has the PC's Claude slot.
    await until(async () => {
      const listed = await remote("GET", "/api/model")
      return ((listed.body?.data ?? []) as Json[]).some((model) => model.providerID === "anthropic" && model.id === MODEL)
    }, 60_000, 500)
  }, 600_000)

  test("a turn on the host reaches Anthropic only through the PC, signed with the PC's login", async () => {
    const created = await remote("POST", "/api/session", {
      body: { title: "claude via pc", model: { providerID: "anthropic", id: MODEL }, location: { directory: state.workspace } },
    })
    expect(created.status).toBe(200)
    state.sessionID = created.body.data.id
    state.fake.enqueue({ type: "text", text: "relayed answer" })
    const before = state.front.seen.length
    const admitted = await remote("POST", `/api/session/${state.sessionID}/prompt`, { body: { text: "hello from the host" } })
    expect(admitted.status).toBe(200)
    await remote("POST", `/api/experimental/session/${state.sessionID}/wait`)
    const messages = await remote("GET", `/api/session/${state.sessionID}/message`)
    expect(JSON.stringify(messages.body.data)).toContain("relayed answer")
    const seen = state.front.seen.slice(before)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    const call = seen.find((item) => item.body.includes("hello from the host"))!
    expect(call.path).toBe("/v1/messages?beta=true")
    expect(call.authorization).toBe(`Bearer ${TOKEN}`)
    expect(call.os).toBe(process.platform)
    expect(call.agent).toStartWith("claude-cli/")
    expect(call.egress).toBeNull()
    expect(call.apiKey).toBeNull()
    expect(call.body).toContain("You are Claude Code, Anthropic's official CLI for Claude.")
    // The host's usage line reaches this PC's ledger as the Claude slot's, server = hostId.
    const steps = await until(async () => {
      const result = await localOk(OwnAccounts.ID, "ledger.session", { sessionID: state.sessionID, server: state.hostId })
      const list = result.steps as Json[]
      return list.length > 0 ? list : undefined
    }, 60_000, 500)
    expect(steps[0]).toMatchObject({ accountID: "acc_claude_slot", server: state.hostId, providerID: "anthropic" })
  }, 240_000)

  test("a host conversation on the PC's second Claude account is signed with that account only (proof v2)", async () => {
    const view = await until(async () => {
      const value = await remoteClaude()
      return value?.state === "enabled" ? value : undefined
    }, 60_000, 500)
    expect(view).toMatchObject({ state: "enabled" })
    const created = await remote("POST", "/api/session", {
      body: { title: "second account", model: { providerID: "anthropic", id: MODEL }, location: { directory: state.workspace } },
    })
    expect(created.status).toBe(200)
    const sessionID = created.body.data.id as string
    const bound = await remoteRpc("plugin.claudeAuth.session.set", { sessionID, accountID: SECOND })
    expect(bound.status).toBe(200)
    expect(bound.body.output.accountID).toBe(SECOND)
    state.fake.enqueue({ type: "text", text: "second answer" })
    const before = state.front.seen.length
    await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text: "hello from the second account" } })
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    const call = state.front.seen.slice(before).find((item) => item.body.includes("hello from the second account"))!
    expect(call.authorization).toBe(`Bearer ${TOKEN2}`)
    expect(state.front.seen.slice(before).every((item) => item.authorization !== `Bearer ${TOKEN}`)).toBe(true)
    // The PC records the windows and the usage under the account that signed.
    const steps = await until(async () => {
      const result = await localOk(OwnAccounts.ID, "ledger.session", { sessionID, server: state.hostId })
      const list = result.steps as Json[]
      return list.length > 0 ? list : undefined
    }, 60_000, 500)
    expect(steps[0]).toMatchObject({ accountID: SECOND, server: state.hostId, providerID: "anthropic" })
  }, 240_000)

  // RS (2026-11-28, the user's build-host): the switcher of a new host conversation chose AC-01 with the host's
  // `plugin.claudeAuth.default.set`, which a host refuses (`remote_managed`: the Claude logins are this PC's), and the
  // popover jumped to the accounts page. The account new conversations start on is chosen on this PC and reaches the
  // host with the mirror; a new host conversation without a binding is then signed by it.
  test("a new host conversation starts on the Claude account chosen on the PC; the host refuses to choose it itself", async () => {
    const refused = await remoteRpc("plugin.claudeAuth.default.set", { accountID: SECOND })
    expect(refused.body).toMatchObject({ type: "remote_managed" })
    await localOk(OwnAccounts.ID, "plugin.claudeAuth.default.set", { accountID: SECOND })
    try {
      const created = await remote("POST", "/api/session", {
        body: {
          title: "chosen default",
          model: { providerID: "anthropic", id: MODEL },
          location: { directory: state.workspace },
        },
      })
      const sessionID = created.body.data.id as string
      const chosen = await until(
        async () => {
          const value = await remoteRpc("plugin.claudeAuth.session.get", { sessionID })
          return value.body?.output?.accountID === SECOND ? value.body.output : undefined
        },
        60_000,
        500,
      )
      expect(chosen).toMatchObject({ accountID: SECOND, bound: false })
      state.fake.enqueue({ type: "text", text: "default answer" })
      const before = state.front.seen.length
      await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text: "hello on the chosen default" } })
      await remote("POST", `/api/experimental/session/${sessionID}/wait`)
      const call = state.front.seen.slice(before).find((item) => item.body.includes("hello on the chosen default"))!
      expect(call.authorization).toBe(`Bearer ${TOKEN2}`)
    } finally {
      await localOk(OwnAccounts.ID, "plugin.claudeAuth.default.set", { accountID: "acc_claude_slot" })
    }
  }, 240_000)

  test("cancelling the turn mid-stream closes the upstream request", async () => {
    const before = state.front.aborted.length
    const admitted = await remote("POST", `/api/session/${state.sessionID}/prompt`, { body: { text: SLOW } })
    expect(admitted.status).toBe(200)
    await until(() => state.front.seen.some((item) => item.body.includes(SLOW)), 60_000, 250)
    await Bun.sleep(500)
    const interrupted = await remote("POST", `/api/session/${state.sessionID}/interrupt`, { body: {} })
    expect(interrupted.status).toBe(200)
    const closedAt = await until(() => state.front.aborted[before], 15_000, 100)
    expect(closedAt).toBeGreaterThan(0)
    expect((await host()).broker.claude.inflight).toBe(0)
  }, 120_000)

  test("switching the host off on the PC refuses its next turn at once", async () => {
    expect(await localOk(OwnAccounts.ID, "plugin.claudeAuth.remote.set", { hostId: state.hostId, enabled: false })).toEqual(
      { hostId: state.hostId, enabled: false, state: "off" },
    )
    await until(async () => (await remoteClaude())?.state === "off", 60_000, 500)
    const before = state.front.seen.length
    await remote("POST", `/api/session/${state.sessionID}/prompt`, { body: { text: "one more after the switch-off" } })
    await remote("POST", `/api/experimental/session/${state.sessionID}/wait`)
    expect(state.front.seen.length).toBe(before)
  }, 120_000)

  test("secret hygiene: the PC's Claude token is nowhere on the host", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile() && !file.endsWith(".db-shm")) {
          const bytes = fs.readFileSync(file)
          if (bytes.includes(TOKEN) || bytes.includes(TOKEN2)) hits.push(file)
        }
      }
    }
    walk(state.harness.hostHome("hc"))
    walk(path.join(state.harness.testRoot, "e2e-logs"))
    expect(hits).toEqual([])
    for (const output of state.outputs) for (const token of [TOKEN, TOKEN2]) expect(output).not.toContain(token)
    for (const token of [TOKEN, TOKEN2]) expect(state.local.logs()).not.toContain(token)
  }, 60_000)
})
