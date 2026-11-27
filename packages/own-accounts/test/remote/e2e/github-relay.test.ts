// GitHub on an SSH host through the PC (16 §8, GH-37..GH-44), end to end over the fake-SSH harness (no real host, no
// real GitHub):
//
//   test → local OpenCode server L (own-accounts local with the broker, its egress relay and two GitHub accounts of a
//          fake GitHub; own-remote local)
//        → own.remote connect → fake ssh (Git bash plays the host; both -R forwards are local relays)
//        → the remote service R: a real OpenCode server from source with own-accounts mode:"remote", a fake chat model
//          of its own, and no GitHub endpoint at all
//
// The PC chooses an account for the host's project folder; a turn on R calls `github_get_me` and the PC runs it as that
// account; R writes only once L allows that host to write (GH-49), and a write asks in R's conversation before anything
// reaches GitHub; git in R's shells reaches GitHub through R's relay stub and L's egress relay, which adds the login; a
// read-only account's push stops at once and an explicit push URL is refused on the PC; R learns no token (its files,
// logs and every answer), and L's logs hold none.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import * as Harness from "../../../../own-remote/test/harness/remote.js"
import {
  afterToolResult,
  deepseekProvider,
  E2E_TRANSPILER_CACHE,
  lastUserText,
  REPO_ROOT,
  opencodeConfig,
  removeTree,
  startFakeOpenAIChat,
  startOpencodeServer,
  toolOutputs,
  type FakeOpenAIChat,
  type OpencodeServer,
  type RecordedRequest,
  type Reply,
} from "../../e2e-kit"
import { startFakeGitHub, type FakeGitHub } from "../../e2e-kit/fakes/github"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.0.18-own.9"
const WORK = "ghp_fakeE2eRelayWork000000000000000000Rw01"
const HOME_TOKEN = "github_pat_11E2ERELAY000_fakeE2eRelayHome00000000000000000Rw02"
const CHAT_KEY = "fake-github-relay-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const BROKER_WAIT_MS = 1_500
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

/** The host's chat model: `[github]` runs Code Mode with a read tool, `[github-write]` with a write tool. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "확인했어요." }
  const text = lastUserText(request)
  if (text.includes("[github-write]"))
    return {
      type: "tool-call",
      name: "execute",
      input: { code: 'return await tools.github.create_pull_request({ owner: "octo", repo: "hello", title: "Fix" })' },
    }
  if (text.includes("[github]"))
    return { type: "tool-call", name: "execute", input: { code: "return await tools.github.get_me({})" } }
  return { type: "text", text: "답변" }
}

run("GitHub on a host through the PC (fake SSH, 16 §8)", () => {
  const state = {} as {
    harness: Harness.Harness
    github: FakeGitHub
    chat: FakeOpenAIChat
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    workspace: string
    scratch: string
    ids: { work: string; home: string }
    outputs: string[]
    repos: string
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
  const github = (method: string, input: unknown = {}) => localOk(OwnAccounts.ID, method, input)
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
  /** The host's own-accounts log lines (its OWN_HOME is under the fake host's home). */
  function hostLog() {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.name === "own-accounts.log") found.push(fs.readFileSync(file, "utf8"))
      }
    }
    walk(state.harness.hostHome("hg"))
    return found.join("\n")
  }
  /** Whether the host's workspace Location offers these GitHub tools now (its `github_tools_offered` lines). */
  function offered(counts: { readonly read: number; readonly write: number }) {
    const last = hostLog()
      .split(/\r?\n/)
      .filter((line) => line.includes("github_tools_offered"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Json]
        } catch {
          return []
        }
      })
      .filter((line) => typeof line.location === "string" && path.resolve(line.location) === path.resolve(state.workspace))
      .at(-1)
    return last?.read === counts.read && last?.write === counts.write
  }
  /** Boots the host's workspace Location (a session alone does not), so its tools are registered. */
  async function boot() {
    expect((await remote("GET", "/api/shell")).status).toBe(200)
  }
  /** A turn on the host: its session's messages after it. */
  async function turn(sessionID: string, text: string) {
    expect((await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text } })).status).toBe(200)
  }
  /** One shell command on the host in `cwd` for the conversation (core's `!` path): its exit code and output. */
  async function shell(command: string, sessionID: string, cwd = state.workspace) {
    const created = await remote("POST", "/api/shell", { body: { command, cwd, timeout: 120_000, metadata: { sessionID } } })
    expect(created.status).toBe(200)
    const info = (created.body.data ?? created.body) as Json
    const id = String(info.id)
    const done = await until(async () => {
      const current = await remote("GET", `/api/shell/${id}`)
      const value = (current.body.data ?? current.body) as Json
      return value.status !== undefined && value.status !== "running" ? value : undefined
    }, 120_000, 250)
    const output = await remote("GET", `/api/shell/${id}/output`)
    return { code: done.exit as number | undefined, output: String((output.body.data ?? output.body).output ?? "") }
  }

  beforeAll(async () => {
    // A real bare repository for pushes (`octo/pushed.git`); `octo/hello.git` keeps the fake's empty advertisement.
    state.repos = fs.mkdtempSync(path.join(os.tmpdir(), "own-github-relay-repos-"))
    fs.mkdirSync(path.join(state.repos, "octo"))
    expect(Bun.spawnSync(["git", "init", "-q", "--bare", path.join(state.repos, "octo", "pushed.git")]).exitCode).toBe(0)
    state.github = startFakeGitHub({
      accounts: { [WORK]: { login: "octo-work", scopes: "repo" }, [HOME_TOKEN]: { login: "octo-home" } },
      repos: state.repos,
    })
    state.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
    const buildId = `e2e-github-relay-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-github-relay-e2e-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        hg: {
          env: {
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(import.meta.dir, "real-service.ts")),
            OWN_E2E_CONFIG: Harness.toPosix(configFile),
          },
        },
      },
    })
    // The host knows no GitHub endpoint at all: only the PC reaches the fake GitHub. Its chat model is its own.
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        repo: REPO_ROOT,
        buildId,
        endpoints: {},
        logs: path.join(state.harness.testRoot, "e2e-logs"),
        transpilerCache: E2E_TRANSPILER_CACHE,
        providers: { [CHAT.providerID]: deepseekProvider(state.chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) },
        // The host's shells run git as a Linux host's would find it on PATH.
        pathPrepend: [path.dirname(Bun.which("git") ?? "git")],
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
                endpoints: { ...state.github.endpoints },
                broker: { brokerWaitMs: BROKER_WAIT_MS },
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
    state.github?.stop()
    await state.chat?.stop()
    if (state.scratch) await removeTree(state.scratch)
    if (state.repos) await removeTree(state.repos)
  }, 120_000)

  test("the host is ready; the PC's accounts and the host folder's choice are the PC's", async () => {
    const work = await github("github.add.token", { token: WORK, label: "회사" })
    const home = await github("github.add.token", { token: HOME_TOKEN, label: "개인" })
    state.ids = {
      work: (work.accounts as Json[])[0]!.id,
      home: (home.accounts as Json[]).find((item) => item.label === "개인")!.id,
    }
    await until(async () => ((await github("github.view")).catalog ? true : undefined), 60_000, 500)

    const added = await localOk("own.remote", "hosts.add", { alias: "hg" })
    state.hostId = added.host.id
    const first = await connect()
    expect(first.stage).toBe("needs_install")
    const plan = await localOk("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await localOk("own.remote", "prepare.execute", { nonce: plan.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await localOk("own.remote", "resolve", { hostId: state.hostId })
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.workspace = path.join(state.harness.hostHome("hg"), "work")
    // Both forwards: git goes over the egress one, next to the broker's.
    const tunnel = state.harness.sshLog().findLast((entry) => entry.locals.length > 0)!
    expect(tunnel.remotes).toHaveLength(2)
    await until(async () => ((await host()).broker?.state === "connected" ? true : undefined), 120_000, 500)

    // The host's project folder uses the work account (the PC keeps the choice; the host has none of its own).
    const bound = await github("github.bind", {
      target: { type: "project", directory: state.workspace, host: state.hostId },
      account: state.ids.work,
    })
    expect(bound.projects).toEqual([{ directory: state.workspace, account: state.ids.work, host: state.hostId }])
    const view = await github("github.view", { directory: state.workspace, host: state.hostId })
    expect(view.inUse).toMatchObject({ account: state.ids.work, source: "project" })
    // The host's own `github.*` methods stay the PC's.
    const refused = await remote("POST", `/api/rpc/${OwnAccounts.ID}/github.view`, {
      body: { input: {} },
      directory: state.remote.controlDir,
    })
    expect(JSON.stringify(refused.body)).toContain("remote_managed")
  }, 600_000)

  test("a turn on the host calls GitHub's tools as the PC's account; the PC runs it", async () => {
    const created = await remote("POST", "/api/session", {
      body: { title: "github on the host", model: CHAT, location: { directory: state.workspace } },
    })
    expect(created.status).toBe(200)
    const sessionID = created.body.data.id as string
    await boot()
    await until(() => offered({ read: 3, write: 0 }), 120_000, 500)
    const from = { mcp: state.github.mcp.length, chat: state.chat.requests.length }
    await turn(sessionID, "[github] get_me")
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    const calls = state.github.mcp.slice(from.mcp).filter((item) => item.method === "tools/call")
    expect(calls.map((item) => [item.login, item.tool, item.readOnly])).toEqual([["octo-work", "get_me", true]])
    const requests = state.chat.requests.slice(from.chat)
    expect(toolOutputs(requests.at(-1)!).join("\n")).toContain("GitHub account: octo-work (회사)")
    expect(requests.map((request) => request.body).join("\n")).not.toContain("create_pull_request")
  }, 240_000)

  test("a host writes only once the PC allows it; a write then asks in the host's conversation first", async () => {
    await github("github.update", { id: state.ids.work, write: true })
    // The account allows writing, but a new host only reads (GH-49): the host was told, and still offers reads only.
    const view = await github("github.view", { directory: state.workspace, host: state.hostId })
    expect(view.settings.writeHosts ?? []).toEqual([])
    await Bun.sleep(3_000)
    expect(offered({ read: 3, write: 0 })).toBe(true)
    await github("github.settings.set", { writeHosts: [state.hostId] })
    await until(() => offered({ read: 3, write: 2 }), 120_000, 500)
    const created = await remote("POST", "/api/session", {
      body: { title: "github write on the host", model: CHAT, location: { directory: state.workspace } },
    })
    const sessionID = created.body.data.id as string
    const from = state.github.mcp.length
    await turn(sessionID, "[github-write] create_pull_request")
    const asked = await until(async () => {
      const listed = await remote("GET", `/api/session/${sessionID}/permission`)
      return ((listed.body?.data ?? []) as Json[]).find((item) => item.action === "github.write")
    }, 120_000, 250)
    expect(asked.resources).toEqual([`create_pull_request octo/hello as octo-work (${state.ids.work})`])
    expect(state.github.mcp.slice(from).filter((item) => item.method === "tools/call")).toEqual([])
    await remote("POST", `/api/session/${sessionID}/permission/${String(asked.id)}/reply`, { body: { decision: "once" } })
    await remote("POST", `/api/experimental/session/${sessionID}/wait`)
    const calls = state.github.mcp.slice(from).filter((item) => item.method === "tools/call")
    expect(calls.map((item) => [item.login, item.tool, item.readOnly])).toEqual([["octo-work", "create_pull_request", false]])
  }, 240_000)

  test("git in a writing host's shells pushes as the account, LFS objects included, and a clone brings them back", async () => {
    const created = await remote("POST", "/api/session", {
      body: { title: "git push on the host", model: CHAT, location: { directory: state.workspace } },
    })
    const sessionID = created.body.data.id as string
    const before = { git: state.github.git.length, storage: state.github.storage.length }
    const origin = "https://github.com/octo/pushed.git"
    const identity = "-c user.name=t -c user.email=t@example.invalid"
    const smudge = "-c filter.lfs.process='git-lfs filter-process' -c filter.lfs.smudge='git-lfs smudge -- %f'"
    // One plain command per shell: the fake host's shell is not the point here.
    const run = async (step: string) => {
      const done = await shell(step, sessionID)
      expect(`${done.code} ${step}: ${done.output}`).toStartWith("0")
    }
    await run("git init -q pushed")
    await run("git -C pushed lfs install --local")
    await run("git -C pushed lfs track *.bin")
    fs.writeFileSync(path.join(state.workspace, "pushed", "data.bin"), `binary ${"0".repeat(300)}`)
    await run("git -C pushed add .gitattributes data.bin")
    await run(`git -C pushed ${identity} commit -q -m first`)
    await run(`git -C pushed remote add origin ${origin}`)
    await run("git -C pushed push -q origin HEAD:refs/heads/main")
    await run(`git ${smudge} -c filter.lfs.required=true clone -q -b main ${origin} back`)
    const bare = path.join(state.repos, "octo", "pushed.git")
    const head = Bun.spawnSync(["git", "--git-dir", bare, "rev-parse", "main"]).stdout.toString().trim()
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.readFileSync(path.join(state.workspace, "back", "data.bin"), "utf8")).toStartWith("binary 0")
    const services = state.github.git.slice(before.git).map((item) => [item.login, item.service])
    expect(services).toContainEqual(["octo-work", "git-receive-pack"])
    expect(services).toContainEqual(["octo-work", "lfs-upload"])
    expect(services).toContainEqual(["octo-work", "lfs-download"])
    const storage = state.github.storage.slice(before.storage)
    expect(storage.map((item) => [item.method, item.derived])).toEqual([
      ["PUT", true],
      ["GET", true],
    ])
  }, 300_000)

  test("git in the host's shells logs in through the PC; a read-only account's push stops, a push URL is refused on the PC", async () => {
    const created = await remote("POST", "/api/session", {
      body: { title: "git on the host", model: CHAT, location: { directory: state.workspace } },
    })
    const sessionID = created.body.data.id as string
    const before = state.github.git.length
    const listed = await shell("git ls-remote https://github.com/octo/hello.git", sessionID)
    expect(`${listed.code} ${listed.output}`).toStartWith("0")
    expect(state.github.git.slice(before)).toMatchObject([{ login: "octo-work", username: "octo-work", service: "git-upload-pack" }])
    expect(listed.output).not.toContain(WORK)

    // The conversation's own choice (made on the PC for the host's conversation): the read-only personal account.
    await github("github.bind", {
      target: { type: "session", sessionID, directory: state.workspace, host: state.hostId },
      account: state.ids.home,
    })
    const pushes = () => state.github.git.slice(before).filter((item) => item.service === "git-receive-pack")
    expect((await shell("git init -q repo", sessionID)).code).toBe(0)
    expect(
      (await shell("git -C repo -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m first", sessionID)).code,
    ).toBe(0)
    const pushed = await shell("git -C repo push https://github.com/octo/hello.git HEAD:refs/heads/main", sessionID)
    expect(pushed.code).not.toBe(0)
    expect(pushed.output).toContain("github-account-is-read-only")
    // An explicit push URL skips `pushInsteadOf`: the host's stub relays it and the PC refuses the push.
    expect((await shell("git -C repo remote add origin https://github.com/octo/hello.git", sessionID)).code).toBe(0)
    expect((await shell("git -C repo config remote.origin.pushurl https://github.com/octo/hello.git", sessionID)).code).toBe(0)
    const direct = await shell("git -C repo push origin HEAD:refs/heads/main", sessionID)
    expect(direct.code).not.toBe(0)
    expect(direct.output).toContain("403")
    expect(pushes()).toEqual([])
    const fetched = await shell("git -C repo ls-remote origin", sessionID)
    expect(fetched.code).toBe(0)
    expect(state.github.git.at(-1)).toMatchObject({ login: "octo-home", service: "git-upload-pack" })
  }, 300_000)

  test("secret hygiene: no token on the host, in any answer or in the PC's logs", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        // process-daemon's `service.lock` (the host's PTY daemon, since v2.4) stays locked while the daemon runs.
        else if (entry.isFile() && !file.endsWith(".db-shm") && entry.name !== "service.lock") {
          const bytes = fs.readFileSync(file)
          if (bytes.includes(WORK) || bytes.includes(HOME_TOKEN)) hits.push(file)
        }
      }
    }
    walk(state.harness.hostHome("hg"))
    walk(path.join(state.harness.testRoot, "e2e-logs"))
    expect(hits).toEqual([])
    for (const output of state.outputs) for (const token of [WORK, HOME_TOKEN]) expect(output).not.toContain(token)
    for (const token of [WORK, HOME_TOKEN]) expect(state.local.logs()).not.toContain(token)
    for (const request of state.chat.requests) for (const token of [WORK, HOME_TOKEN]) expect(request.body).not.toContain(token)
  }, 60_000)
})
