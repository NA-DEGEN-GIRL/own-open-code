// Extensions on an SSH host (own/docs/17 §10), end to end over own-remote's fake-SSH harness (no real host, no real
// SSH):
//
//   test → local OpenCode server L (own-accounts local with the broker, own-remote local, own-creator: this PC's store)
//        → own.remote connect → fake ssh (Git bash plays the host)
//        → the remote service R: a real OpenCode server from source with own-accounts mode:"remote", own-remote agent and
//          own-creator mode:"remote" from the managed config, and a fake chat model of its own
//
// The PC's store gets its extensions as creator mode would write them (the store and the staging, in this process).
// A fragment, a rule and a command tool apply in a host conversation within the host folder of the scope; the tool
// runs on the host's shell under the host's approval. A C2 server's version is mirrored, its hash checked, its staging
// run again in the host's sandbox, and a host conversation calls it, asked there; the confirmation stays on the host.
// A C3 version without the host's allowance never reaches it. The host cannot change the PC's store (no own.creator
// writes there, a changed copy is only its own and is fetched again), and a rollback on the PC follows on the host.
// Every credential is fake; nothing touches ~/.ssh, known_hosts, the firewall or a real host.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as Harness from "../../../own-remote/test/harness/remote.js"
import {
  afterToolResult,
  deepseekProvider,
  E2E_TRANSPILER_CACHE,
  lastUserText,
  opencodeConfig,
  REPO_ROOT,
  removeTree,
  startFakeOpenAIChat,
  startOpencodeServer,
  toolOutputs,
  type FakeOpenAIChat,
  type OpencodeServer,
  type RecordedRequest,
  type Reply,
} from "../../../own-accounts/test/e2e-kit"
import { Staging } from "../../src/staging.js"
import { CreatorStore } from "../../src/store.js"
import { mcpManifest, pluginManifest } from "../unit/fixtures.js"

setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.0.18-own.9"
const CHAT_KEY = "fake-creator-remote-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const REMOTE = path.join(REPO_ROOT, "packages/own-remote")
const CREATOR = path.join(REPO_ROOT, "packages/own-creator")
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

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

/** The house extension: a fragment, a direct command tool and a rule that blocks a word in a shell command. */
function house(rule: string) {
  return {
    format: "own.ext/1",
    id: "house",
    title: "House rules",
    items: [
      { type: "prompt.fragment", id: "style", text: rule },
      {
        type: "tool.command",
        name: "say",
        description: "Says a word on the host's shell",
        command: "echo said-{{word}}",
        params: { word: { type: "string", description: "The word" } },
        direct: true,
      },
      {
        type: "tool.rule",
        rules: [{ permission: "shell", pattern: "*forbidden*", effect: "deny", reason: "no forbidden words" }],
      },
    ],
  }
}

/** The host's chat model: `[say <word>]` calls the command tool, `[words]` the C2 server through Code Mode. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "끝났어요." }
  const text = lastUserText(request)
  const say = /\[say (\w+)\]/.exec(text)
  if (say) return { type: "tool-call", name: "ext_say", input: { word: say[1] } }
  if (text.includes("[words]"))
    return {
      type: "tool-call",
      name: "execute",
      input: { code: 'return await tools["creator-words-words"].count_words({ text: "a b c" })' },
    }
  return { type: "text", text: "답변" }
}

run("own-creator extensions on an SSH host (fake SSH, 17 §10)", () => {
  const state = {} as {
    harness: Harness.Harness
    chat: FakeOpenAIChat
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    scratch: string
    store: CreatorStore.Store
  }

  // Plugins load in the background in every Location since upstream v2.4.0 (#63814): a call that finds its plugin not
  // registered yet (`rpc.unavailable`) is asked again for up to 60 s, here and on the host.
  async function local(id: string, method: string, input: unknown = {}) {
    const deadline = Date.now() + 60_000
    while (true) {
      const response = await state.local.request("POST", `/api/rpc/${id}/${method}`, {
        body: { input },
        query: { "location[directory]": state.control },
        directory: state.control,
      })
      const text = await response.text()
      if (response.status === 200) return (JSON.parse(text) as Json).output as Json
      if (!text.includes("rpc.unavailable") || Date.now() > deadline)
        throw new Error(`${id}/${method}: ${response.status} ${text}`)
      await Bun.sleep(200)
    }
  }
  async function remote(method: string, route: string, options: { body?: unknown; directory?: string } = {}) {
    const deadline = Date.now() + 60_000
    while (true) {
      const result = await remoteOnce(method, route, options)
      if (result.body?.type !== "rpc.unavailable" || Date.now() > deadline) return result
      await Bun.sleep(200)
    }
  }
  async function remoteOnce(method: string, route: string, options: { body?: unknown; directory?: string }) {
    const url = new URL(route, state.remote.url)
    const directory = options.directory ?? state.workspace
    if (route.startsWith("/api/rpc/") || route.startsWith("/api/shell")) url.searchParams.set("location[directory]", directory)
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
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Json }
  }
  async function host() {
    const listed = await local("own.remote", "hosts.list")
    return (listed.hosts as Json[]).find((item) => item.id === state.hostId)!
  }
  async function connect() {
    await local("own.remote", "connect", { hostId: state.hostId, clientId: "e2e-tab" })
    return until(async () => {
      const view = await host()
      if (view.stage === "ready" || view.stage === "needs_install" || view.paused) return view
      return undefined
    }, 240_000, 500)
  }
  /** The host's line of an extension on the PC's card, once it says `status` for version `n`. */
  function applied(id: string, n: number, status = "active") {
    return until(async () => {
      const listed = await local("own.creator", "list")
      const line = ((listed.extensions as Json[]).find((item) => item.id === id)?.remote as Json[] | undefined)?.find(
        (item) => item.host === state.hostId,
      )
      return line?.state?.n === n && line.state.status === status ? line : undefined
    }, 180_000, 500)
  }
  /** A host conversation in the workspace, under 전체 허용 (the host's own approvals). */
  async function session(title: string) {
    const created = await remote("POST", "/api/session", {
      body: { title, model: CHAT, location: { directory: state.workspace }, permissions: FULL },
    })
    expect(created.status).toBe(200)
    return created.body.data.id as string
  }
  /** One turn on the host, answering its permission requests with `once`; the requests the turn sent. */
  async function turn(sessionID: string, text: string) {
    const from = state.chat.requests.length
    const asked: Json[] = []
    const done = { value: false }
    const answering = (async () => {
      while (!done.value) {
        const listed = await remote("GET", `/api/session/${sessionID}/permission`)
        for (const request of (listed.body?.data ?? []) as Json[]) {
          asked.push(request)
          await remote("POST", `/api/session/${sessionID}/permission/${String(request.id)}/reply`, {
            body: { decision: "once" },
          })
        }
        await Bun.sleep(150)
      }
    })()
    expect((await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text } })).status).toBe(200)
    await remote("POST", `/api/experimental/session/${sessionID}/wait`).finally(() => {
      done.value = true
    })
    await answering
    return { requests: state.chat.requests.slice(from).filter((request) => request.method === "POST"), asked }
  }
  const hostStore = () => new CreatorStore.Store(state.harness.ownHome("hc"), { app: "local", mirror: true })

  beforeAll(async () => {
    state.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
    const buildId = `e2e-creator-remote-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-creator-remote-e2e-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        hc: {
          env: {
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(REPO_ROOT, "packages/own-accounts/test/remote/e2e/real-service.ts")),
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
        providers: { [CHAT.providerID]: deepseekProvider(state.chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) },
        // own-creator from the managed config (mode "remote", the host's OWN_HOME), as the host's service loads it.
        plugins: ["own-creator"],
      }),
    )
    state.local = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            { package: ACCOUNTS, options: { home: paths.ownHome, buildId, vault: "memory", endpoints: {} } },
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
            { package: CREATOR, options: { home: paths.ownHome } },
          ],
        }),
    })
    state.control = path.join(state.local.paths.ownHome, "control")
    fs.mkdirSync(state.control, { recursive: true })
    state.store = new CreatorStore.Store(state.local.paths.ownHome, { app: "local" })
  }, 300_000)

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
    await state.chat?.stop()
    if (state.scratch) await removeTree(state.scratch)
  }, 120_000)

  test("the host is ready and its own.creator keeps a mirror; the PC's store gets the house extension for its folder", async () => {
    // own.creator on the PC runs (its Location offers the store to the hosts).
    expect((await local("own.creator", "list")).extensions).toEqual([])
    const added = await local("own.remote", "hosts.add", { alias: "hc" })
    state.hostId = added.host.id
    expect((await connect()).stage).toBe("needs_install")
    const plan = await local("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await local("own.remote", "prepare.execute", { nonce: plan.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await local("own.remote", "resolve", { hostId: state.hostId })
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("hc"), "work")
    await until(async () => ((await host()).broker?.state === "connected" ? true : undefined), 120_000, 500)
    // The managed config names own-creator last, in remote mode.
    const managed = JSON.parse(
      fs.readFileSync(path.join(state.harness.hostHome("hc"), ".config", "own-open-code", "opencode.json"), "utf8"),
    ) as { plugins: Array<{ package: string; options?: Json }> }
    expect(managed.plugins.at(-1)).toMatchObject({ options: { mode: "remote" } })
    expect(managed.plugins.at(-1)!.package).toEndWith("/own-creator")

    // Creator mode's write on the PC, for the host's folder only (a scope entry tagged with the host).
    const created = await state.store.create(house("HOUSE-RULE-ONE: answer like a pirate."), "model")
    expect(created.ok).toBe(true)
    const scoped = await state.store.scope("house", [], "user", undefined, [
      { host: state.hostId, directory: state.workspace },
    ])
    expect(scoped.ok).toBe(true)
    await applied("house", 1)
    const mirrored = await hostStore().read()
    expect(mirrored.loaded.map((loaded) => [loaded.entry.id, loaded.status, loaded.entry.projects])).toEqual([
      ["house", "active", [path.resolve(state.workspace)]],
    ])
    expect(mirrored.file.extensions[0]!.versions[0]!.hash).toBe(
      (await state.store.read()).file.extensions[0]!.versions[0]!.hash,
    )
  }, 900_000)

  test("in a host conversation the fragment and the command tool apply; the tool runs on the host's shell; the rule blocks", async () => {
    const sessionID = await session("house on the host")
    const said = await turn(sessionID, "[say hello]")
    const first = said.requests[0]!
    expect(first.body).toContain("HOUSE-RULE-ONE: answer like a pirate.")
    expect(((first.json as Json).tools as Json[]).map((tool) => tool.function.name)).toContain("ext_say")
    const output = toolOutputs(said.requests.at(-1)!).join("\n")
    expect(output).toContain("exit 0")
    expect(output).toContain("said-hello")
    // The extension's deny rule joins the host's shell approval.
    const blocked = await turn(sessionID, "[say forbidden]")
    const refused = toolOutputs(blocked.requests.at(-1)!).join("\n")
    expect(refused).toContain("Blocked by extension 'house'")
    expect(refused).not.toContain("said-forbidden")
  }, 300_000)

  test("C2: the version reaches the host, its staging runs in the host's sandbox, and a host call is asked there", async () => {
    const checked = CreatorStore.checkManifest(mcpManifest())
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems))
    const staged = await Staging.run(state.store, checked.extension, { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    expect((await state.store.create(mcpManifest(), "model", {}, undefined, staged.staged)).ok).toBe(true)
    await applied("words", 1)
    const log = fs.readFileSync(path.join(state.harness.ownHome("hc"), "creator", "logs", "words.log"), "utf8")
    expect(log).toContain("host staging words: host smoke ok")
    const sessionID = await session("words on the host")
    const called = await turn(sessionID, "[words]")
    const output = toolOutputs(called.requests.at(-1)!).join("\n")
    // 전체 허용 still asks a version's first call, in the host's conversation.
    expect(called.asked.map((item) => item.action), output).toEqual(["creator-words-words_count_words"])
    expect(output).toContain("words: 3")
    // The approval is the host's: its mirror records it, the PC's store does not.
    await until(async () => ((await hostStore().read()).file.extensions.find((item) => item.id === "words")?.confirmed ?? []).includes(1), 30_000)
    expect((await state.store.read()).file.extensions.find((item) => item.id === "words")!.confirmed).toEqual([])
  }, 600_000)

  test("C3 without this host's allowance stays PC-only: the host never gets it", async () => {
    expect((await state.store.settings({ plugins: true })).ok).toBe(true)
    const checked = CreatorStore.checkManifest(pluginManifest())
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems))
    const staged = await Staging.run(state.store, checked.extension, { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    expect((await state.store.create(pluginManifest(), "model", {}, undefined, staged.staged)).ok).toBe(true)
    const line = await until(async () => {
      const listed = await local("own.creator", "list")
      return ((listed.extensions as Json[]).find((item) => item.id === "brief")?.remote as Json[] | undefined)?.find(
        (item) => item.host === state.hostId,
      )
    }, 60_000)
    expect(line).toEqual({ host: state.hostId, reach: "pc_only" })
    // Another change on the PC syncs the host again: still no code plugin there, no config entry, no trust.
    expect((await state.store.hosts("house", { mode: "only", ids: [state.hostId] })).ok).toBe(true)
    await until(async () => {
      const listed = await local("own.creator", "list")
      const reported = (listed.hosts as Json[]).find((item) => item.id === state.hostId)?.reportedAt
      return typeof reported === "number" && reported > Date.now() - 60_000
    }, 60_000)
    await Bun.sleep(1_000)
    expect((await hostStore().read()).file.extensions.map((item) => item.id).toSorted()).toEqual(["house", "words"])
    expect(fs.existsSync(path.join(state.harness.ownHome("hc"), "creator", "ext", "brief"))).toBe(false)
    const hostConfig = path.join(state.harness.hostHome("hc"), ".e2e-server", "config", "opencode.jsonc")
    expect(fs.readFileSync(hostConfig, "utf8")).not.toContain("/creator/ext/")
    const trust = path.join(state.harness.ownHome("hc"), "trust.json")
    expect(fs.existsSync(trust) ? fs.readFileSync(trust, "utf8") : "").not.toContain("brief")
  }, 600_000)

  test("the host cannot change the PC's store: no own.creator writes there, and a changed copy is fetched again", async () => {
    const before = fs.readFileSync(state.store.file, "utf8")
    // The host's service has no own.creator RPC (Settings is this PC's): a write is not even a method there.
    const write = await remote("POST", "/api/rpc/own.creator/enabled.set", {
      body: { input: { id: "house", enabled: false } },
      directory: state.remote.controlDir,
    })
    expect(write.status).not.toBe(200)
    // The host's own store refuses every write but the mirror's.
    const refused = await hostStore().enable("house", false, "user")
    expect(refused.ok === false && refused.reason).toBe("read_only")
    // A copy changed on the host stops applying there and never reaches the PC.
    const copy = path.join(state.harness.ownHome("hc"), "creator", "ext", "house", "v1", "extension.json")
    fs.writeFileSync(copy, fs.readFileSync(copy, "utf8").replace("HOUSE-RULE-ONE", "HOUSE-RULE-EVIL"))
    expect((await hostStore().read()).loaded.find((item) => item.entry.id === "house")!.status).toBe("tampered")
    const sessionID = await session("tampered copy")
    const tampered = await turn(sessionID, "hello")
    expect(tampered.requests[0]!.body).not.toContain("HOUSE-RULE-EVIL")
    expect(fs.readFileSync(state.store.file, "utf8")).toBe(before)
    expect(fs.readFileSync(path.join(state.store.versionDir("house", 1), "extension.json"), "utf8")).toContain(
      "HOUSE-RULE-ONE",
    )
    // The next change on the PC syncs the host, which fetches the PC's version again.
    expect((await state.store.hosts("house", { mode: "all", ids: [] })).ok).toBe(true)
    await until(async () => (await hostStore().read()).loaded.find((item) => item.entry.id === "house")?.status === "active", 60_000)
    expect(fs.readFileSync(copy, "utf8")).toContain("HOUSE-RULE-ONE")
  }, 300_000)

  test("an update and a rollback on the PC follow in the host's conversations", async () => {
    expect((await state.store.update(house("HOUSE-RULE-TWO: answer in Korean."), "model")).ok).toBe(true)
    await applied("house", 2)
    const second = await session("house v2")
    const v2 = await turn(second, "hello")
    expect(v2.requests[0]!.body).toContain("HOUSE-RULE-TWO")
    expect(v2.requests[0]!.body).not.toContain("HOUSE-RULE-ONE")
    expect((await state.store.rollback("house", 1, "user")).ok).toBe(true)
    await applied("house", 1)
    const back = await session("house rolled back")
    const v1 = await turn(back, "hello")
    expect(v1.requests[0]!.body).toContain("HOUSE-RULE-ONE")
    expect(v1.requests[0]!.body).not.toContain("HOUSE-RULE-TWO")
    expect(fs.existsSync(path.join(state.harness.ownHome("hc"), "creator", "ext", "house", "v2"))).toBe(false)
  }, 300_000)
})
