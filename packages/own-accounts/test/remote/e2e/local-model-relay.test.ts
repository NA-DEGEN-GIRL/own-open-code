// SLM (04 §8.14): the PC's local models on a host, end to end over the fake-SSH harness, on the product path:
//
//   test → local OpenCode server L (own-accounts local with the broker and its relay, own-remote local)
//        → own.remote connect → fake ssh (Git bash plays the host; the broker and egress -R forwards only, no test
//          tunnel to the model server)
//        → the remote service R: a real OpenCode server from source with own-accounts mode:"remote" (real-service.ts)
//
// The PC adds two `로컬 모델` accounts the way the app's local model form does (`accounts.add.key` with
// `options.local`): one without a key, as the user's own server, and one with a key. Their server is a fake
// OpenAI-compatible one on this PC's 127.0.0.1 (a random test port). A conversation on R on each model gets its answer
// through L's relay only: L's relay counts it, the keyed account's key is added on L and is nowhere on the host, the
// same prefix is a cache hit on the second turn, a stream with pauses longer than the relay's idle timeout survives,
// and an interrupted turn closes the relayed request. In this harness the host shares this PC's loopback, so a
// request sent to the account's address directly would reach the fake too: the relay's counters and the keyed
// account's key show the path. Every credential is fake.
//
// `OWN_SLM_CODE_ROOT=<checkout>` runs the plugins and the remote service from another checkout (the reproduction of
// the user's error on code before this change: the first turn ends at once with the sink's `own_broker_unavailable`).
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
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../e2e-kit"

setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.2.6-own.17"
const MODEL = "tf-local-e2e"
const KEY = "sk-ownSlmE2eLocalModelFakeKey00000001"
const CODE_ROOT = process.env.OWN_SLM_CODE_ROOT ?? REPO_ROOT
const ACCOUNTS = path.join(CODE_ROOT, "packages/own-accounts")
const REMOTE = path.join(CODE_ROOT, "packages/own-remote")
/** Pauses longer than the relay listener's 30 s idle timeout (04 §8.11.7: the relay lifts it per request). */
const PAUSE_MS = 35_000

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

run("the PC's local models on a host through the PC's relay (fake SSH)", () => {
  const state = {} as {
    harness: Harness.Harness
    fake: FakeOpenAIChat
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    keyless: { providerID: string; accountID: string }
    keyed: { providerID: string; accountID: string }
    sessionID: string
    scratch: string
    outputs: string[]
  }
  state.outputs = []

  async function localOk(id: string, method: string, input: unknown = {}) {
    const response = await state.local.request("POST", `/api/rpc/${id}/${method}`, {
      body: { input },
      query: { "location[directory]": state.control },
      directory: state.control,
    })
    const text = await response.text()
    state.outputs.push(text)
    if (response.status !== 200) throw new Error(`${id}/${method}: ${response.status} ${text}`)
    return (JSON.parse(text) as Json).output as Json
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
  /** The app's local model form (`local-model-form.tsx`): a `compat` account with `options.local`, the key optional. */
  async function addLocal(label: string, key?: string) {
    const added = await localOk(OwnAccounts.ID, "accounts.add.key", {
      kind: "compat",
      label,
      ...(key === undefined ? {} : { key }),
      color: "teal",
      options: {
        baseURL: state.fake.baseURL,
        local: { format: "chat" },
        models: [{ id: MODEL, contextLimit: 131_072, outputLimit: 8_192 }],
      },
    })
    return { providerID: String(added.account.providerID), accountID: String(added.account.id) }
  }
  async function turn(sessionID: string, text: string) {
    const admitted = await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text } })
    expect(admitted.status).toBe(200)
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    const messages = await remote("GET", `/api/session/${sessionID}/message`)
    return messages.body.data as Json[]
  }
  async function session(providerID: string, title: string) {
    const created = await remote("POST", "/api/session", {
      body: { title, model: { providerID, id: MODEL }, location: { directory: state.workspace } },
    })
    expect(created.status).toBe(200)
    return String(created.body.data.id)
  }
  const relayed = async () => (await host()).broker.local as { inflight: number; lastError: string | null } | undefined

  beforeAll(async () => {
    // The user's server takes no key; a request with the keyed account's key is answered as its own domain.
    state.fake = startFakeOpenAIChat({ models: [MODEL], anonymous: true, credentials: { [KEY]: { domain: "keyed" } } })
    const buildId = `e2e-local-relay-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-local-relay-e2e-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        hl: {
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
        repo: CODE_ROOT,
        buildId,
        endpoints: {},
        logs: path.join(state.harness.testRoot, "e2e-logs"),
        transpilerCache: E2E_TRANSPILER_CACHE,
      }),
    )
    state.local = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            { package: ACCOUNTS, options: { home: paths.ownHome, buildId, vault: "memory", broker: { brokerWaitMs: 1_500 } } },
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
    await state.fake?.stop()
    if (state.scratch) await removeTree(state.scratch)
  }, 120_000)

  test("two local models as the app adds them; the host lists their models", async () => {
    state.keyless = await addLocal("내 로컬 모델")
    state.keyed = await addLocal("키 있는 로컬 모델", KEY)
    const listed = (await localOk(OwnAccounts.ID, "accounts.list")).accounts as Json[]
    expect(listed.find((item) => item.id === state.keyless.accountID)).toMatchObject({ billing: "local" })

    const added = await localOk("own.remote", "hosts.add", { alias: "hl" })
    state.hostId = added.host.id
    expect((await connect()).stage).toBe("needs_install")
    const plan = await localOk("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await localOk("own.remote", "prepare.execute", { nonce: plan.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("hl"), "work")
    fs.mkdirSync(state.workspace, { recursive: true })
    // Only the product's forwards: the broker's and the egress one, nothing to the model server.
    const tunnel = state.harness.sshLog().findLast((entry) => entry.locals.length > 0)!
    expect(tunnel.remotes).toHaveLength(2)
    await until(async () => {
      const models = ((await remote("GET", "/api/model")).body?.data ?? []) as Json[]
      return [state.keyless, state.keyed].every((item) =>
        models.some((model) => model.providerID === item.providerID && model.id === MODEL),
      )
    }, 60_000, 500)
  }, 600_000)

  test("a turn on the host's keyless local model is answered through the PC (the user's case: `git init`)", async () => {
    state.sessionID = await session(state.keyless.providerID, "local via pc")
    state.fake.enqueue({ type: "text", text: "answer from the PC's local model" })
    const before = state.fake.requests.length
    const started = Date.now()
    const messages = await turn(state.sessionID, "git init")
    const text = JSON.stringify(messages)
    expect(text).not.toContain("own_broker_unavailable")
    expect(text).toContain("answer from the PC's local model")
    const seen = state.fake.requests.slice(before).filter((item) => item.path === "/v1/chat/completions")
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.identity).toBe("anonymous")
    expect(Date.now() - started).toBeLessThan(60_000)
    // L's relay carried it (in this harness the host shares this PC's loopback, so its counters show the path).
    expect(await relayed()).toEqual({ inflight: 0, lastError: null })
  }, 240_000)

  test("the keyed account's key is added on the PC; the same prefix is a cache hit on the next turn", async () => {
    const sessionID = await session(state.keyed.providerID, "keyed local via pc")
    state.fake.enqueue({ type: "text", text: "first keyed answer" }, { type: "text", text: "second keyed answer" })
    const before = state.fake.requests.length
    await turn(sessionID, "first question on the keyed model")
    await turn(sessionID, "second question on the keyed model")
    const seen = state.fake.requests.slice(before).filter((item) => item.path === "/v1/chat/completions")
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every((item) => item.identity === "keyed")).toBe(true)
    expect(seen.at(-1)!.headers.authorization).toBe(hashSecret(`Bearer ${KEY}`))
    // The host built both requests; the relay changed no byte, so the second one reuses the first one's prefix.
    expect(seen.at(-1)!.cache?.cachedTokens ?? 0).toBeGreaterThan(0)
  }, 240_000)

  test("a stream with pauses longer than the relay's idle timeout reaches the host whole", async () => {
    state.fake.enqueue({ type: "text", text: "slow one two three", deltas: 3, eventDelayMs: PAUSE_MS })
    const started = Date.now()
    const messages = await turn(state.sessionID, "answer slowly with pauses")
    expect(Date.now() - started).toBeGreaterThan(2 * PAUSE_MS)
    expect(JSON.stringify(messages)).toContain("three")
    expect(await relayed()).toEqual({ inflight: 0, lastError: null })
  }, 300_000)

  test("interrupting the turn closes the relayed request", async () => {
    state.fake.enqueue({ type: "text", text: "never finished", deltas: 4, eventDelayMs: 60_000 })
    const admitted = await remote("POST", `/api/session/${state.sessionID}/prompt`, { body: { text: "a long answer" } })
    expect(admitted.status).toBe(200)
    await until(async () => (await relayed())?.inflight === 1, 60_000, 250)
    const interrupted = await remote("POST", `/api/session/${state.sessionID}/interrupt`, { body: {} })
    expect(interrupted.status).toBe(200)
    await until(async () => (await relayed())?.inflight === 0, 15_000, 100)
  }, 120_000)

  test("secret hygiene: the keyed account's key is nowhere on the host", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile() && !file.endsWith(".db-shm") && fs.readFileSync(file).includes(KEY)) hits.push(file)
      }
    }
    walk(state.harness.hostHome("hl"))
    walk(path.join(state.harness.testRoot, "e2e-logs"))
    expect(hits).toEqual([])
    for (const output of state.outputs) expect(output).not.toContain(KEY)
    expect(state.local.logs()).not.toContain(KEY)
  }, 60_000)
})
