// Worktrees and worktree conversations on an SSH host (06 §4.12a, §13.8, 04 §8.15, 2026-11-24), end to end over the
// fake-SSH harness: this PC's server L (own-accounts, own-remote) connects to a fake host whose service R is a real
// OpenCode server from source with own-accounts `remote`, own-remote `agent` and own-team `remote` from the managed
// config (own-accounts' `real-service.ts`). On R, core's `POST /api/worktree` puts a worktree in
// `<host project>/.worktrees/<name>` with own's `.gitignore`, own.team reports the `worktree-chat` feature, and a host
// conversation's scripted model starts a worktree conversation (`tools.worktree.start` through `execute`) that runs in
// the host's `.worktrees` and wakes its parent. Every credential is fake; nothing touches ~/.ssh or a real host.

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
  type FakeOpenAIChat,
  type OpencodeServer,
  type RecordedRequest,
  type Reply,
} from "../../../own-accounts/test/e2e-kit"
import { git, init } from "../fixtures/repo.js"

setDefaultTimeout(60_000)

const run = Harness.available ? describe : describe.skip
const VERSION = "2.2.6-own.18"
const CHAT_KEY = "fake-worktree-remote-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
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

/** The host's chat model: `[start]` starts one worktree conversation through Code Mode; anything else ends the turn. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "시작했어요." }
  if (lastUserText(request).includes("[start]"))
    return {
      type: "tool-call",
      name: "execute",
      input: {
        code: 'return await tools.worktree.start({ tasks: [{ name: "host-side", task: "확인만 하고 끝내 주세요." }] })',
      },
    }
  return { type: "text", text: "끝났어요." }
}

run("worktrees on an SSH host (fake SSH, 06 §13.8)", () => {
  const state = {} as {
    harness: Harness.Harness
    chat: FakeOpenAIChat
    local: OpencodeServer
    control: string
    hostId: string
    remote: { url: string; token: string; controlDir: string }
    project: string
    scratch: string
  }

  async function local(id: string, method: string, input: unknown = {}) {
    const response = await state.local.request("POST", `/api/rpc/${id}/${method}`, {
      body: { input },
      query: { "location[directory]": state.control },
      directory: state.control,
    })
    const text = await response.text()
    if (response.status !== 200) throw new Error(`${id}/${method}: ${response.status} ${text}`)
    return (JSON.parse(text) as Json).output as Json
  }
  async function remote(method: string, route: string, options: { body?: unknown; directory?: string } = {}) {
    const url = new URL(route, state.remote.url)
    const directory = options.directory ?? state.project
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

  beforeAll(async () => {
    state.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
    const buildId = `e2e-worktree-remote-${process.pid}`
    state.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-worktree-remote-e2e-"))
    const configFile = path.join(state.scratch, "e2e-config.json")
    state.harness = Harness.create({
      version: VERSION,
      hosts: {
        hw: {
          env: {
            OWN_FAKE_SERVICE: Harness.toPosix(path.join(ACCOUNTS, "test/remote/e2e/real-service.ts")),
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
        // own-team from the managed config (mode "remote", the host's OWN_HOME), as the host's service loads it.
        plugins: ["own-team"],
        // The host runs git (own.team, core's worktrees): the real service's clean env keeps only what is named here.
        pathPrepend: [path.dirname(Bun.which("git") ?? "git")],
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
          ],
        }),
    })
    state.control = path.join(state.local.paths.ownHome, "control")
    fs.mkdirSync(state.control, { recursive: true })
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

  test("the host is ready with own.team; core's worktree.create goes to the host project's .worktrees", async () => {
    const added = await local("own.remote", "hosts.add", { alias: "hw" })
    state.hostId = added.host.id
    expect((await connect()).stage).toBe("needs_install")
    const plan = await local("own.remote", "prepare.plan", { hostId: state.hostId })
    expect((await local("own.remote", "prepare.execute", { nonce: plan.nonce })).ok).toBe(true)
    expect((await connect()).stage).toBe("ready")
    const resolved = await local("own.remote", "resolve", { hostId: state.hostId })
    state.remote = { url: resolved.url, token: resolved.token, controlDir: Harness.toWindows(resolved.controlDir) }
    state.project = init(path.join(state.harness.hostHome("hw"), "work", "app"))
    fs.writeFileSync(path.join(state.project, "README.md"), "# app\n")
    git(state.project, ["add", "-A"])
    git(state.project, ["commit", "-q", "-m", "first"])
    // own.team on the host answers and names the feature.
    const seen: { last?: unknown } = {}
    const health = await until(async () => {
      const answer = await remote("POST", "/api/rpc/own.team/health", { body: { input: {} }, directory: state.remote.controlDir })
      seen.last = answer
      return answer.status === 200 ? answer.body.output : undefined
    }, 120_000, 500).catch((error: unknown) => {
      throw new Error(`${String(error)}: ${JSON.stringify(seen.last).slice(0, 2000)}`)
    })
    expect(health.features).toContain("worktree-chat")
    const created = await remote("POST", "/api/session", {
      body: { title: "host parent", model: CHAT, location: { directory: state.project } },
    })
    expect(created.status).toBe(200)
    const projectID = String(created.body.data.projectID)
    const worktree = await remote("POST", "/api/worktree", { body: { projectID, name: "side" } })
    expect(worktree.status).toBe(200)
    expect(same(String(worktree.body.directory), path.join(state.project, ".worktrees", "side"))).toBe(true)
    expect(fs.readFileSync(path.join(state.project, ".worktrees", ".gitignore"), "utf8")).toContain("*")
    expect(git(state.project, ["status", "--porcelain"]).trim()).toBe("")
  }, 600_000)

  test("a host conversation starts a worktree conversation in the host's .worktrees and is told when it ends", async () => {
    const created = await remote("POST", "/api/session", {
      body: { title: "host parent 2", model: CHAT, location: { directory: state.project } },
    })
    const parent = String(created.body.data.id)
    expect((await remote("POST", `/api/session/${parent}/prompt`, { body: { text: "[start]" } })).status).toBe(200)
    await remote("POST", `/api/experimental/session/${parent}/wait`)
    const listed = await until(async () => {
      const answer = await remote("POST", "/api/rpc/own.team/worktreeChat.list", {
        body: { input: { sessionID: parent } },
        directory: state.remote.controlDir,
      })
      const items = (answer.body?.output?.items ?? []) as Json[]
      return items.length === 1 && items[0]!.state === "done" ? items : undefined
    }, 240_000, 500)
    expect(same(String(listed[0]!.directory), path.join(state.project, ".worktrees", "host-side"))).toBe(true)
    expect(git(String(listed[0]!.directory), ["branch", "--show-current"]).trim()).toBe("host-side")
    await until(async () => {
      const messages = (await remote("GET", `/api/session/${parent}/message`)).body?.data as Json[] | undefined
      return JSON.stringify(messages ?? []).includes('name=\\"host-side\\"')
    }, 240_000, 500)
  }, 600_000)
})

function same(a: string, b: string) {
  const norm = (value: string) => path.resolve(value).replaceAll("\\", "/").toLowerCase()
  return norm(fs.existsSync(a) ? fs.realpathSync(a) : a) === norm(fs.existsSync(b) ? fs.realpathSync(b) : b)
}
