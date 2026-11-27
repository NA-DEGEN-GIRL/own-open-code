// GitHub connection (16, GH 2026-10-31): accounts by token and by browser login against a fake GitHub (tokens only in
// the vault, never in github.json, a log line or an answer), which account a conversation, a project, a team area's
// worktree or the default gives, the `github_*` tools (each call as the conversation's account, read-only accounts
// refused writes, writes asking first, the token cut out of what comes back) and git's logins through own's
// credential helper with a real git against a fake smart-HTTP remote. git runs with a scrubbed environment: a scratch
// HOME and global config, no system config, only git's own folders and System32 on PATH. Fake tokens only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Tool } from "@opencode/schema/tool"
import { OwnGitHub } from "@own/protocol"
import { GitHubBridge } from "@own/runtime"
import { GitHubCaller } from "../../src/github/caller.js"
import { GitHubCommands } from "../../src/github/commands.js"
import { GitHubCredential } from "../../src/github/credential.js"
import { GitHubMask } from "../../src/github/mask.js"
import { GitHubMcp } from "../../src/github/mcp.js"
import { GitHubReads } from "../../src/github/reads.js"
import { GitHubConnection } from "../../src/github/register.js"
import { GitHubResolve } from "../../src/github/resolve.js"
import { GitHubService } from "../../src/github/service.js"
import { GitHubStore } from "../../src/github/store.js"
import { GitHubTools } from "../../src/github/tools.js"
import { ReadOnly } from "../../src/presets/readonly.js"
import { GitHubRpc } from "../../src/rpc/github.js"
import { Register } from "../../src/rpc/register.js"
import { startFakeGitHub, type FakeGitHub } from "../e2e-kit/fakes/github.js"
import { removeTree } from "../e2e-kit/harness/remove.js"
// Core's own matcher, which `GitHubTools.wildcard` must equal (surface `permission-wildcard-match`).
import { Wildcard } from "../../../core/src/util/wildcard.js"
// own.team's permission hook, for the order in which the plugins' hooks compose (MR9-2).
import { PermissionHook } from "../../../own-team/src/hooks/permission.js"
import { call, ok, recordEvents } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"
import { lfsRepo, scrubbedGit, sshRecorder } from "./git.js"

// Real git and Bun servers on a busy PC.
setDefaultTimeout(60_000)

const WORK = "ghp_fakeWorkToken000000000000000000Ab12"
const HOME_TOKEN = "github_pat_11FAKEHOME0000_fakeHomeToken000000000000000000000Cd34"
const OTHER = "ghp_fakeOtherUser0000000000000000000Ef56"

const fixture: { github?: FakeGitHub; root?: string } = {}

beforeAll(async () => {
  fixture.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-github-test-")))
  fixture.github = startFakeGitHub({
    accounts: {
      [WORK]: { login: "octo-work", name: "Octo Work", scopes: "repo, read:org" },
      [HOME_TOKEN]: { login: "octo-home", expiration: "2027-01-31 09:00:00 +0900" },
      [OTHER]: { login: "someone-else" },
    },
  })
})

afterAll(async () => {
  await GitHubMcp.dropAll()
  fixture.github?.stop()
  if (fixture.root) await removeTree(fixture.root)
})

function github() {
  if (!fixture.github) throw new Error("fake GitHub not started")
  return fixture.github
}

/** A fake of the plugin context parts the connection uses: transforms, the shell, permission and tool hooks, asks. */
function fakeContext() {
  const transforms: Array<(editor: Editor) => void> = []
  const agentTransforms: Array<{ callback: (editor: never) => void; disposed: boolean }> = []
  const shellHooks: Array<(event: ShellEvent) => unknown> = []
  const evaluateHooks: Array<(event: Evaluation) => unknown> = []
  const afterHooks: Array<(event: AfterEvent) => unknown> = []
  const requestHooks: Array<{ name: string; callback: (event: { messages: unknown[] }) => unknown }> = []
  const asks: Array<Record<string, unknown>> = []
  const state = { refuse: false, reloads: 0 }
  const ctx = {
    location: { project: { id: "prj_github_test" } },
    agent: {
      transform: async (callback: (editor: never) => void) => {
        const registration = { callback, disposed: false }
        agentTransforms.push(registration)
        return {
          dispose: async () => {
            registration.disposed = true
          },
        }
      },
    },
    tool: {
      transform: async (callback: (editor: Editor) => void) => {
        transforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {
        state.reloads += 1
      },
      hook: async (_name: string, callback: (event: AfterEvent) => unknown) => {
        afterHooks.push(callback)
        return { dispose: async () => {} }
      },
    },
    shell: {
      hook: async (_name: string, callback: (event: ShellEvent) => unknown) => {
        shellHooks.push(callback)
        return { dispose: async () => {} }
      },
    },
    permission: {
      assert: async (input: Record<string, unknown>) => {
        asks.push(input)
        if (state.refuse) throw new Tool.Error({ message: "the user declined" })
      },
      hook: async (_name: string, callback: (event: Evaluation) => unknown) => {
        evaluateHooks.push(callback)
        return { dispose: async () => {} }
      },
    },
    session: {
      get: async (input: { sessionID: string }) => sessions.get(input.sessionID),
      hook: async (name: string, callback: (event: { messages: unknown[] }) => unknown) => {
        requestHooks.push({ name, callback })
        return { dispose: async () => {} }
      },
    },
  }
  /** Core's sessions the fake's `session.get` finds (none unless a test adds them). */
  const sessions = new Map<string, { location: { directory: string }; time: { updated: number } }>()
  /** The tools the transforms add now. */
  const tools = () => {
    const added: Added[] = []
    const editor: Editor = {
      namespace: () => undefined,
      add: (tool) => void added.push(tool as Added),
    }
    for (const transform of transforms) transform(editor)
    return added
  }
  /** A command core starts in `cwd` (as its shell tool: a timeout, and with P-046 the command's id): its env. */
  const shell = async (cwd: string, sessionID?: string, options: { timeout?: number; id?: string } = {}) => {
    const event: ShellEvent = {
      cwd,
      env: {},
      timeout: options.timeout ?? 120_000,
      ...(sessionID === undefined ? {} : { sessionID }),
      ...(options.id === undefined ? {} : { id: options.id }),
    }
    for (const hook of shellHooks) await hook(event)
    return event.env
  }
  /**
   * The effect core's permission hooks leave for a `github.write` (or another action) core judged `effect`, with the
   * project's saved approvals of the action core names (P-047).
   */
  const evaluate = async (input: {
    action?: string
    resources: string[]
    effect: Evaluation["effect"]
    saved?: string[]
    agent?: string
    sessionID?: string
  }) => {
    const event: Evaluation = { sessionID: "ses_eval", action: input.action ?? "github.write", saved: [], ...input }
    for (const hook of evaluateHooks) await hook(event)
    return event.effect
  }
  /** The messages a model request of `kind` sends after the session hooks of that name (`context`: the agent loop). */
  const request = async (messages: unknown[], kind: "context" | "compaction" | "generate" | "title" = "context") => {
    const event = { messages }
    for (const hook of requestHooks.filter((item) => item.name === kind)) await hook.callback(event)
    return event.messages
  }
  /** A tool's result after the `execute.after` hooks. */
  const after = async (event: AfterEvent) => {
    for (const hook of afterHooks) await hook(event)
    return event
  }
  return { ctx, tools, shell, evaluate, after, request, asks, state, agentTransforms, sessions }
}

interface ShellEvent {
  cwd: string
  env: Record<string, string | undefined>
  timeout: number
  sessionID?: string
  id?: string
}

interface Evaluation {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly saved?: ReadonlyArray<string>
  effect: "allow" | "ask" | "deny"
}

type AfterEvent =
  | { readonly status: "completed"; result: Tool.Result }
  | { readonly status: "error"; error: Tool.Error }

interface Editor {
  namespace(namespace: { name: string; description: string }): void
  add(tool: unknown): void
}

/** The OpenCode events a test hands the connection (as `Events.start` does), this Location's. */
const local = { local: true }

/** Registers the connection; the result stops it. */
async function connect(deps: unknown) {
  const connection = await GitHubConnection.register(deps as never)
  return Object.assign(() => void connection.stop(), { connection })
}

interface Added {
  readonly name: string
  readonly description: string
  readonly options?: { readonly namespace?: string }
  readonly execute: (input: unknown, context: GitHubTools.Call) => Promise<Tool.Result>
}

/** A control instance (the RPC methods) and a project instance (tools, shell hook) over one OWN_HOME. */
async function rig(input: { readonly logs?: string[]; readonly endpoints?: FakeGitHub["endpoints"] } = {}) {
  const project = path.join(fixture.root!, `project-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(project, { recursive: true })
  const endpoints = input.endpoints ?? github().endpoints
  const control = await testDeps({
    control: true,
    // No conversation in these tests has a parent: core's session lookup finds none.
    ctx: { session: { get: async () => undefined } },
    options: { endpoints } as never,
    ...(input.logs ? { logs: input.logs } : {}),
  })
  const fake = fakeContext()
  const deps = {
    ...control.deps,
    ctx: fake.ctx as never,
    location: { directory: project, control: false },
  }
  const events = recordEvents(control.deps)
  const rpc = GitHubRpc.handlers(control.deps)
  return {
    control,
    deps,
    project,
    fake,
    events,
    rpc,
    file: () => GitHubStore.file(control.deps).read(),
    fileText: () => Bun.file(control.deps.runtime.layout.github).text(),
    [Symbol.asyncDispose]: () => control[Symbol.asyncDispose](),
  }
}

const context = (sessionID: string, signal = new AbortController().signal) =>
  ({
    sessionID,
    agent: "build",
    messageID: "msg_test",
    id: `call_${Math.random().toString(36).slice(2, 8)}`,
    signal,
  }) as unknown as GitHubTools.Call

describe("accounts", () => {
  test("a token is asked about, kept in the vault only, and shown by its last four characters", async () => {
    const logs: string[] = []
    await using t = await rig({ logs })
    const view = await ok(t.rpc["github.add.token"], { token: WORK, label: "회사" })
    expect(view.accounts).toHaveLength(1)
    const account = view.accounts[0]!
    expect(account).toMatchObject({
      label: "회사",
      login: "octo-work",
      name: "Octo Work",
      site: "https://github.com",
      source: "token",
      tokenKind: "classic",
      hint: "…Ab12",
      write: false,
      scopes: ["repo", "read:org"],
    })
    // The first account is the default, so it works everywhere at once.
    expect(view.default).toBe(account.id)
    const stored = await t.control.deps.runtime.credentials.githubSecret(GitHubStore.vaultID(account.id))
    expect(stored.ok && JSON.parse(stored.text).token).toBe(WORK)
    expect(await t.fileText()).not.toContain(WORK)
    expect(JSON.stringify(view)).not.toContain(WORK)
    expect(logs.join("\n")).not.toContain(WORK)
    expect(t.events.map((event) => event.name)).toContain("github.changed")
  })

  test("a fine-grained token's expiry comes from GitHub's header", async () => {
    await using t = await rig()
    const view = await ok(t.rpc["github.add.token"], { token: HOME_TOKEN })
    expect(view.accounts[0]).toMatchObject({ label: "octo-home", tokenKind: "fine-grained", hint: "…Cd34" })
    expect(view.accounts[0]!.expiresAt).toBe(Date.parse("2027-01-31T00:00:00Z"))
  })

  test("a refused token stores nothing", async () => {
    await using t = await rig()
    const refused = await call(t.rpc["github.add.token"], { token: "ghp_notKnownToTheFake0000000000000000Zz" })
    expect(refused).toMatchObject({ ok: false, type: "github_token_invalid", data: { status: 401 } })
    expect((await t.file()).accounts).toHaveLength(0)
  })

  test("names are unique; a replaced token must be the same user's; removal takes the token and the choices", async () => {
    await using t = await rig()
    const first = await ok(t.rpc["github.add.token"], { token: WORK, label: "회사" })
    const id = first.accounts[0]!.id
    expect(await call(t.rpc["github.add.token"], { token: HOME_TOKEN, label: "회사" })).toMatchObject({
      ok: false,
      type: "github_invalid",
      data: { field: "label" },
    })
    expect(await call(t.rpc["github.update"], { id, token: OTHER })).toMatchObject({
      ok: false,
      type: "github_token_invalid",
      data: { mismatch: true },
    })
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: id })
    const removed = await ok(t.rpc["github.remove"], { id })
    expect(removed.accounts).toHaveLength(0)
    expect(removed.projects).toHaveLength(0)
    expect(removed.default).toBeUndefined()
    const stored = await t.control.deps.runtime.credentials.githubSecret(GitHubStore.vaultID(id))
    expect(stored.ok).toBe(false)
  })

  test("the GitHub methods are this PC's: a remote service refuses them", () => {
    for (const method of [
      "github.view",
      "github.add.token",
      "github.device.start",
      "github.device.status",
      "github.device.cancel",
      "github.update",
      "github.remove",
      "github.bind",
      "github.settings.set",
      "github.test",
    ])
      expect(Register.REMOTE_MANAGED).toContain(method as never)
  })
})

describe("which account applies", () => {
  const entry = (id: string, write = false): GitHubStore.Entry => ({
    id: id as OwnGitHub.ID,
    label: id,
    site: OwnGitHub.GITHUB_COM,
    login: id,
    source: "token",
    tokenKind: "classic",
    hint: "",
    write,
    addedAt: 0,
  })
  const A = "gh_00000000000000000000000AAA" as OwnGitHub.ID
  const B = "gh_00000000000000000000000BBB" as OwnGitHub.ID
  const C = "gh_00000000000000000000000CCC" as OwnGitHub.ID

  test("the conversation's choice, then the deepest project folder, then the default; off stops the search", async () => {
    const root = path.resolve(fixture.root!, "resolve")
    const file: GitHubStore.File = {
      ...GitHubStore.EMPTY,
      accounts: [entry(A), entry(B), entry(C)],
      default: A,
      projects: [
        { directory: path.join(root, "work"), account: B },
        { directory: path.join(root, "work", "oss"), account: C },
        { directory: path.join(root, "secret"), account: "off" },
      ],
      sessions: [{ sessionID: "ses_chosen", account: C, at: 0 }],
    }
    const of = async (directory: string, root?: string) =>
      (await GitHubResolve.resolve(file, { directory, ...(root ? { root } : {}) })).inUse
    expect(await of(path.join(root, "elsewhere"))).toEqual({ account: A, source: "default" })
    expect(await of(path.join(root, "work", "app"))).toMatchObject({ account: B, source: "project" })
    expect(await of(path.join(root, "work", "oss", "lib"))).toMatchObject({ account: C, source: "project" })
    expect(await of(path.join(root, "secret", "x"))).toMatchObject({ source: "off" })
    expect((await GitHubResolve.resolve(file, { directory: path.join(root, "secret") })).entry).toBeUndefined()
    expect(await of(path.join(root, "work"), "ses_chosen")).toMatchObject({ account: C, source: "session" })
    // A choice that names an account no longer connected counts as none.
    const gone = { ...file, accounts: [entry(A)] }
    expect((await GitHubResolve.resolve(gone, { directory: path.join(root, "work") })).inUse).toEqual({
      account: A,
      source: "default",
    })
  })

  test("a team area's linked worktree uses its project's choice until it has its own", async () => {
    const root = path.join(fixture.root!, "areas")
    const main = path.join(root, "game")
    const area = path.join(root, ".worktrees", "game", "ui")
    // The files git writes for `git worktree add` (checked with real git in "git's logins" below).
    await fs.mkdir(path.join(main, ".git", "worktrees", "ui"), { recursive: true })
    await fs.writeFile(path.join(main, ".git", "worktrees", "ui", "commondir"), "../..\n")
    await fs.mkdir(area, { recursive: true })
    await fs.writeFile(path.join(area, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "ui")}\n`)
    expect(await GitHubResolve.mainCheckout(path.join(area, "src"))).toBe(main)
    expect(await GitHubResolve.mainCheckout(main)).toBeUndefined()
    const file: GitHubStore.File = {
      ...GitHubStore.EMPTY,
      accounts: [entry(A), entry(B)],
      default: A,
      projects: [{ directory: main, account: B }],
    }
    expect((await GitHubResolve.resolve(file, { directory: area })).inUse).toEqual({
      account: B,
      source: "worktree",
      directory: main,
    })
    const own = { ...file, projects: [...file.projects, { directory: area, account: A }] }
    expect((await GitHubResolve.resolve(own, { directory: area })).inUse).toMatchObject({
      account: A,
      source: "project",
    })
  })

  test("github.view names the account in use for a folder and a conversation", async () => {
    await using t = await rig()
    const work = await ok(t.rpc["github.add.token"], { token: WORK, label: "회사" })
    const home = await ok(t.rpc["github.add.token"], { token: HOME_TOKEN, label: "개인" })
    const workID = work.accounts[0]!.id
    const homeID = home.accounts.find((item) => item.label === "개인")!.id
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: homeID })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_override", directory: t.project },
      account: workID,
    })
    expect((await ok(t.rpc["github.view"], { directory: t.project })).inUse).toEqual({
      account: homeID,
      source: "project",
      directory: t.project,
    })
    expect((await ok(t.rpc["github.view"], { directory: t.project, sessionID: "ses_override" })).inUse).toEqual({
      account: workID,
      source: "session",
      directory: t.project,
    })
    expect(
      await call(t.rpc["github.bind"], { target: { type: "project", directory: "relative" }, account: homeID }),
    ).toMatchObject({
      ok: false,
      type: "github_invalid",
      data: { field: "directory" },
    })
  })
})

describe("tools", () => {
  async function connected(t: Awaited<ReturnType<typeof rig>>) {
    const work = await ok(t.rpc["github.add.token"], { token: WORK, label: "회사" })
    const home = await ok(t.rpc["github.add.token"], { token: HOME_TOKEN, label: "개인" })
    // Reading the tool list follows the first add; wait for it.
    await untilAsync(async () => (await t.file()).catalog !== undefined)
    return {
      work: work.accounts[0]!.id,
      home: home.accounts.find((item) => item.label === "개인")!.id,
    }
  }

  test("the tool list comes from GitHub's MCP server with the toolsets asked; a read-only place offers reads only", async () => {
    await using t = await rig()
    await connected(t)
    const file = await t.file()
    expect(GitHubStore.catalogView(file.catalog)).toMatchObject({
      read: ["get_me", "get_file_contents", "list_pull_requests"],
      write: ["create_pull_request", "add_issue_comment"],
      server: "fake-github-mcp-server 2.0.3",
    })
    expect(
      github().mcp.some(
        (item) => item.method === "tools/list" && item.toolsets === "context,repos,issues,pull_requests,actions",
      ),
    ).toBe(true)
    const offered = await GitHubTools.offer(file, { directory: t.project, control: false })
    expect(offered.tools.map((tool) => tool.name)).toEqual(["get_me", "get_file_contents", "list_pull_requests"])
    expect((await GitHubTools.offer(file, { directory: t.project, control: true })).tools).toHaveLength(0)
    const off = { ...file, default: undefined }
    expect((await GitHubTools.offer(off, { directory: t.project, control: false })).tools).toHaveLength(0)
  })

  test("each call runs as the conversation's account; the project's choice otherwise", async () => {
    await using t = await rig()
    const ids = await connected(t)
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: ids.work })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_personal", directory: t.project },
      account: ids.home,
    })
    const dispose = await connect(t.deps)
    try {
      const tools = t.fake.tools()
      const getMe = tools.find((tool) => tool.name === "get_me")!
      expect(getMe.options?.namespace).toBe("github")
      const before = github().mcp.length
      const asWork = await getMe.execute({}, context("ses_work"))
      const asHome = await getMe.execute({}, context("ses_personal"))
      expect(String(asWork.content)).toStartWith("GitHub account: octo-work (회사)")
      expect(String(asHome.content)).toStartWith("GitHub account: octo-home (개인)")
      const calls = github()
        .mcp.slice(before)
        .filter((item) => item.method === "tools/call")
      expect(calls.map((item) => [item.login, item.tool, item.readOnly])).toEqual([
        ["octo-work", "get_me", true],
        ["octo-home", "get_me", true],
      ])
    } finally {
      dispose()
    }
  })

  test("a write needs an account that allows writing, then asks; a declined ask sends nothing", async () => {
    await using t = await rig()
    const ids = await connected(t)
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: ids.work })
    const dispose = await connect(t.deps)
    try {
      // Read-only: no write tool is offered here.
      expect(t.fake.tools().some((tool) => tool.name === "create_pull_request")).toBe(false)
      await ok(t.rpc["github.update"], { id: ids.work, write: true })
      await untilAsync(async () => t.fake.tools().some((tool) => tool.name === "create_pull_request"))
      expect(t.fake.state.reloads).toBeGreaterThan(0)
      const create = t.fake.tools().find((tool) => tool.name === "create_pull_request")!
      const before = github().mcp.length
      const done = await create.execute({ owner: "octo", repo: "hello", title: "Fix" }, context("ses_write"))
      expect(String(done.content)).toContain('"tool":"create_pull_request"')
      const resource = `create_pull_request octo/hello as octo-work (${ids.work})`
      expect(t.fake.asks.at(-1)).toMatchObject({
        action: "github.write",
        resources: [resource],
        save: [resource],
        metadata: { tool: "create_pull_request", account: "회사", login: "octo-work" },
      })
      const sent = github()
        .mcp.slice(before)
        .filter((item) => item.method === "tools/call")
      expect(sent.map((item) => [item.login, item.tool, item.readOnly])).toEqual([
        ["octo-work", "create_pull_request", false],
      ])
      t.fake.state.refuse = true
      const quiet = github().mcp.length
      await expect(
        create.execute({ owner: "octo", repo: "hello", title: "Again" }, context("ses_write")),
      ).rejects.toThrow("declined")
      await Bun.sleep(50)
      expect(
        github()
          .mcp.slice(quiet)
          .filter((item) => item.method === "tools/call"),
      ).toHaveLength(0)
      // A conversation on the read-only personal account is refused before any ask.
      t.fake.state.refuse = false
      await ok(t.rpc["github.bind"], {
        target: { type: "session", sessionID: "ses_readonly", directory: t.project },
        account: ids.home,
      })
      const asks = t.fake.asks.length
      await expect(create.execute({ owner: "octo", repo: "hello" }, context("ses_readonly"))).rejects.toThrow(
        "allows reading only",
      )
      await Bun.sleep(50)
      expect(t.fake.asks).toHaveLength(asks)
    } finally {
      dispose()
    }
  })

  test("the token is cut out of anything a tool gives back, and a refused token marks the account", async () => {
    await using t = await rig()
    const ids = await connected(t)
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: ids.work })
    const dispose = await connect(t.deps)
    try {
      const read = t.fake.tools().find((tool) => tool.name === "get_file_contents")!
      // The fake echoes the arguments: a token put in them comes back masked.
      const echoed = await read.execute({ owner: "octo", repo: "hello", title: WORK }, context("ses_mask"))
      expect(String(echoed.content)).not.toContain(WORK)
      expect(String(echoed.content)).toContain("••••")
      github().removeAccount(WORK)
      await GitHubMcp.dropAll()
      await expect(read.execute({ owner: "octo", repo: "hello" }, context("ses_mask"))).rejects.toThrow("refused")
      await untilAsync(
        async () => (await t.file()).accounts.find((item) => item.id === ids.work)?.problem === "token_invalid",
      )
    } finally {
      github().addAccount(WORK, { login: "octo-work", name: "Octo Work", scopes: "repo, read:org" })
      dispose()
    }
  })

  test("no account here: the call says how to choose one", async () => {
    await using t = await rig()
    const ids = await connected(t)
    await ok(t.rpc["github.bind"], { target: { type: "default" }, account: null })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_only", directory: t.project },
      account: ids.work,
    })
    const dispose = await connect(t.deps)
    try {
      // Offered because a conversation here chose an account; another conversation has none.
      const getMe = t.fake.tools().find((tool) => tool.name === "get_me")!
      await expect(getMe.execute({}, context("ses_other"))).rejects.toThrow("No GitHub account is chosen")
      expect(String((await getMe.execute({}, context("ses_only"))).content)).toContain("octo-work")
    } finally {
      dispose()
    }
  })
})

describe("writes ask", () => {
  test("every agent that would allow a GitHub write asks instead; a deny stays; running it again adds nothing", () => {
    const agents = new Map<
      string,
      { id: string; permissions: Array<{ action: string; resource: string; effect: string }> }
    >([
      ["build", { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }],
      [
        "explore",
        {
          id: "explore",
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
          ],
        },
      ],
    ])
    const editor = {
      list: () => [...agents.values()],
      get: (id: string) => agents.get(id),
      default: () => undefined,
      update: (
        id: string,
        update: (info: { permissions: Array<{ action: string; resource: string; effect: string }> }) => void,
      ) => {
        const agent = agents.get(id)
        if (agent) update(agent)
      },
      remove: () => undefined,
    }
    GitHubTools.askWrites(editor as never)
    GitHubTools.askWrites(editor as never)
    expect(agents.get("build")!.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "github.write", resource: "*", effect: "ask" },
    ])
    expect(GitHubTools.effectOf(agents.get("build")!.permissions, "github.write")).toBe("ask")
    expect(GitHubTools.effectOf(agents.get("explore")!.permissions, "github.write")).toBe("deny")
    expect(agents.get("explore")!.permissions).toHaveLength(2)
  })
})

describe("git's logins", () => {
  test("the helper's ticket gets the folder's account's token for its site only", async () => {
    await using t = await rig()
    const view = await ok(t.rpc["github.add.token"], { token: WORK, label: "회사", site: github().url })
    expect(view.accounts[0]!.site).toBe(github().url)
    const dispose = await connect(t.deps)
    try {
      const env = await t.fake.shell(t.project)
      // The account allows reading only: its site takes no push (GH-17); every request names its repository.
      expect(env).toMatchObject({
        GIT_CONFIG_COUNT: "4",
        GIT_CONFIG_KEY_0: `credential.${github().url}.helper`,
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: `credential.${github().url}.helper`,
        GIT_CONFIG_VALUE_1: GitHubCredential.HELPER,
        GIT_CONFIG_KEY_2: `credential.${github().url}.useHttpPath`,
        GIT_CONFIG_VALUE_2: "true",
        GIT_CONFIG_KEY_3: `url.${GitHubCredential.READ_ONLY_PUSH_URL}.pushInsteadOf`,
        GIT_CONFIG_VALUE_3: `${github().url}/`,
      })
      expect(JSON.stringify(env)).not.toContain(WORK)
      const url = env.OWN_GITHUB_CREDENTIAL!
      const host = new URL(github().url).host
      // This test process is no git: on Windows it gets nothing (GH-19), elsewhere the folder's account answers.
      const asked = await fetch(url, { method: "POST", body: `protocol=http\nhost=${host}\npath=octo/hello.git\n\n` })
      if (process.platform === "win32") expect(asked.status).toBe(404)
      else expect(await asked.text()).toBe(`protocol=http\nhost=${host}\nusername=octo-work\npassword=${WORK}\n`)
      const other = await fetch(url, { method: "POST", body: "protocol=https\nhost=gitlab.example\n\n" })
      expect(other.status).toBe(404)
      const forged = await fetch(url.replace(/\.[^.]+$/, ".AAAA"), {
        method: "POST",
        body: `protocol=http\nhost=${host}\n`,
      })
      expect(forged.status).toBe(403)
      const page = await fetch(url, { method: "POST", headers: { origin: "https://evil.example" }, body: "" })
      expect(page.status).toBe(404)
      await ok(t.rpc["github.settings.set"], { git: false })
      expect(await t.fake.shell(t.project)).toEqual({})
      expect((await fetch(url, { method: "POST", body: `protocol=http\nhost=${host}\n\n` })).status).toBe(404)
    } finally {
      dispose()
    }
  })

  test("real git logs in to a fake remote as the folder's account, past the user's own helper", async () => {
    await using t = await rig()
    await ok(t.rpc["github.add.token"], { token: WORK, label: "회사", site: github().url })
    const home = await ok(t.rpc["github.add.token"], { token: HOME_TOKEN, label: "개인", site: github().url })
    const homeID = home.accounts.find((item) => item.label === "개인")!.id
    const git = await scrubbedGit(path.join(fixture.root!, "git-home-1"))
    // The user's global config names another helper with a wrong password: own's empty helper clears it.
    await Bun.write(
      path.join(git.home, ".gitconfig"),
      '[credential]\n\thelper = "!f() { echo username=user; echo password=wrong-user-password; }; f"\n',
    )
    const dispose = await connect(t.deps)
    try {
      const remote = `${github().url}/octo/hello.git`
      const bare = await git.run(["ls-remote", remote], t.project, {})
      expect(bare.code).not.toBe(0)
      expect(github().git.at(-1)?.login).toBeUndefined()
      const env = await t.fake.shell(t.project)
      const asWork = await git.run(["ls-remote", remote], t.project, env)
      expect(asWork).toMatchObject({ code: 0 })
      expect(github().git.at(-1)).toMatchObject({ login: "octo-work", username: "octo-work" })
      // The project chooses the personal account: the same git now logs in as it.
      await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: homeID })
      const asHome = await git.run(["ls-remote", remote], t.project, await t.fake.shell(t.project))
      expect(asHome).toMatchObject({ code: 0 })
      expect(github().git.at(-1)).toMatchObject({ login: "octo-home" })
    } finally {
      dispose()
    }
  })

  test("a team area's worktree pushes as its own choice, else its project's (own-team asks the bridge)", async () => {
    await using t = await rig()
    await ok(t.rpc["github.add.token"], { token: WORK, label: "회사", site: github().url })
    const home = await ok(t.rpc["github.add.token"], { token: HOME_TOKEN, label: "개인", site: github().url })
    const homeID = home.accounts.find((item) => item.label === "개인")!.id
    const git = await scrubbedGit(path.join(fixture.root!, "git-home-2"))
    const main = path.join(t.project, "game")
    const area = path.join(t.project, ".worktrees", "game", "ui")
    await fs.mkdir(main, { recursive: true })
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "first"],
      ["worktree", "add", "-b", "ui", area],
    ]) {
      const done = await git.run(args, main, {})
      expect(done.stderr.includes("fatal")).toBe(false)
    }
    expect(await GitHubResolve.mainCheckout(area)).toBe(path.resolve(main))
    const dispose = await connect(t.deps)
    try {
      await ok(t.rpc["github.bind"], { target: { type: "project", directory: main }, account: homeID })
      const remote = `${github().url}/octo/game.git`
      // The process-wide bridge own-team's push asks (`GitHubBridge.gitEnv`), with the area's folder.
      const viaProject = await git.run(["ls-remote", remote], area, (await GitHubBridge.gitEnv(area)) ?? {})
      expect(viaProject).toMatchObject({ code: 0 })
      expect(github().git.at(-1)).toMatchObject({ login: "octo-home" })
      const work = (await t.file()).accounts.find((item) => item.label === "회사")!.id
      await ok(t.rpc["github.bind"], { target: { type: "project", directory: area }, account: work })
      const viaArea = await git.run(["ls-remote", remote], area, (await GitHubBridge.gitEnv(area)) ?? {})
      expect(viaArea).toMatchObject({ code: 0 })
      expect(github().git.at(-1)).toMatchObject({ login: "octo-work" })
      // With gh, own's own `gh pr create` also gets the account's token; an agent's shell never does.
      const forGh = await GitHubBridge.gitEnv(area, { gh: true })
      expect(forGh?.GH_ENTERPRISE_TOKEN).toBe(WORK)
      expect(forGh?.GH_HOST).toBe(new URL(github().url).host)
      expect(JSON.stringify(await t.fake.shell(area))).not.toContain(WORK)
    } finally {
      dispose()
    }
  })
})

/** An agent editor over `agents` (the parts `askWrites` uses). */
function agentEditor(agents: Map<string, { id: string; permissions: Array<Rule> }>) {
  return {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default: () => undefined,
    update: (id: string, update: (info: { permissions: Array<Rule> }) => void) => {
      const agent = agents.get(id)
      if (agent) update(agent)
    },
    remove: () => undefined,
  }
}

interface Rule {
  action: string
  resource: string
  effect: string
}

const ALL: Rule = { action: "*", resource: "*", effect: "allow" }

describe("every GitHub write asks unless the user said 항상 허용 for it (GH-13)", () => {
  test("the ask rule is registered again after each plugin.updated here, so it stays after core's config agents", async () => {
    await using t = await rig()
    const dispose = await connect(t.deps)
    try {
      const registrations = t.fake.agentTransforms
      // Core's config agents (a `post` builtin plugin) register after own's setup: `mine` with the default `*` allow.
      registrations.push({
        callback: (editor: never) => {
          const agents = (editor as { list(): Array<{ id: string; permissions: Rule[] }> }).list()
          for (const agent of agents) agent.permissions.push({ ...ALL })
        },
        disposed: false,
      })
      const fold = () => {
        const agents = new Map([["mine", { id: "mine", permissions: [] as Rule[] }]])
        for (const registration of registrations.filter((item) => !item.disposed))
          registration.callback(agentEditor(agents) as never)
        return GitHubTools.effectOf(agents.get("mine")!.permissions, GitHubTools.WRITE_ACTION)
      }
      expect(fold()).toBe("allow")
      // Another Location's activation moves nothing here.
      await dispose.connection.onEvent({ type: "plugin.updated", data: {} } as never, { local: false })
      expect(registrations).toHaveLength(2)
      await dispose.connection.onEvent({ type: "plugin.updated", data: {} } as never, local)
      await untilAsync(async () => registrations.length === 3 && registrations[0]!.disposed)
      expect(fold()).toBe("ask")
    } finally {
      dispose()
    }
  })

  test("the permission hook keeps a write's allow only while core holds a saved 항상 허용 of exactly it (GH-26, GH-31, GH-32)", async () => {
    await using t = await rig()
    const dispose = await connect(t.deps)
    try {
      const pr = "create_pull_request octo/hello as octo-work (gh_01WORK)"
      // An agent or conversation that allows everything (omo's children carry v1's `*` allow as session rules).
      expect(await t.fake.evaluate({ resources: [pr], effect: "allow" })).toBe("ask")
      expect(await t.fake.evaluate({ action: "edit", resources: ["a.ts"], effect: "allow" })).toBe("allow")
      expect(await t.fake.evaluate({ resources: [pr], effect: "deny" })).toBe("deny")
      // Core holds the user's `항상 허용` of exactly this write (P-047 names it): the allow stays.
      expect(await t.fake.evaluate({ resources: [pr], effect: "allow", saved: [pr] })).toBe("allow")
      const windows = process.platform === "win32"
      expect(await t.fake.evaluate({ resources: [pr], effect: "allow", saved: [pr.toUpperCase()] })).toBe(
        windows ? "allow" : "ask",
      )
      // The user removed it in 설정 > 승인·권한: an allow-all conversation asks again at once, nothing to forget.
      expect(await t.fake.evaluate({ resources: [pr], effect: "allow", saved: [] })).toBe("ask")
      // Another repository, another account (GH-32), a pattern of core's rules or a made-up name never counts (GH-31).
      for (const saved of [
        "create_pull_request octo/other as octo-work (gh_01WORK)",
        "create_pull_request octo/hello as octo-home (gh_01HOME)",
        "create_pull_request octo/hello as octo-work (gh_01WORK) *",
        "create_pull_request octo/* as octo-work (gh_01WORK)",
        "*",
      ])
        expect(await t.fake.evaluate({ resources: [pr], effect: "allow", saved: [saved] })).toBe("ask")
      const pattern = "create_pull_request */* as octo-work (gh_01WORK)"
      expect(await t.fake.evaluate({ resources: [pattern], effect: "allow", saved: [pattern] })).toBe("ask")
    } finally {
      dispose()
    }
  })

  test("the read-only roles', own-team's and the GitHub hook compose in any order: tighten only, neither lost (MR9)", async () => {
    // own.accounts registers the read-only roles' hook in Hooks.register and the GitHub one after it; own.team's
    // (another plugin) may come before or after both. The Claude Agent route's tool calls come back to core as ordinary
    // tool calls, so all three judge them too.
    const pr = "create_pull_request octo/hello as octo-work (gh_01WORK)"
    const main = "ses_team_main"
    const typecheck = "bun run typecheck"
    for (const order of permutations(["readonly", "github", "team"] as const)) {
      await using t = await rig()
      const readonly = ReadOnly.create(t.deps as never)
      // own.team's hook with a team that is on, `main` its registered main and the team's commands allowed unasked:
      // it raises a shell `ask` of `bun run typecheck` to `allow` there (06 §10.1).
      const team = {
        id: "tm_compose",
        state: "on",
        policy: { autoAllow: true },
        home: { directory: t.project },
        main: { sessionID: main },
        commands: { setup: null, code: [{ argv: ["bun", "run", "typecheck"] }], assets: [] },
      }
      const services = {
        registry: { teams: { list: async () => [team] } },
        locate: {
          session: async (sessionID: string) => (sessionID === main ? { role: "main", team } : undefined),
          directory: async () => undefined,
        },
        instance: () => undefined,
      }
      const teamHook = PermissionHook.create(services as never)
      const add = {
        readonly: () => t.fake.ctx.permission.hook("evaluate", (event) => readonly(event as never)),
        team: () => t.fake.ctx.permission.hook("evaluate", (event) => teamHook(event as never)),
        github: () => connect(t.deps),
      }
      const added = []
      for (const name of order) added.push(await add[name]())
      const dispose = added.find((item) => typeof item === "function")!
      try {
        const judge = async (input: Parameters<typeof t.fake.evaluate>[0]) =>
          `${order.join(">")} ${input.agent} ${input.action ?? "github.write"} ${input.effect}: ${await t.fake.evaluate(input)}`
        const cases = [
          [{ resources: [pr], effect: "allow", agent: "build", sessionID: main }, "ask"],
          [{ resources: [pr], effect: "allow", agent: "build", sessionID: main, saved: [pr] }, "allow"],
          // The role's deny holds against a saved approval of the write and against own.team's raise of the shell.
          [{ resources: [pr], effect: "allow", agent: "explore", sessionID: main, saved: [pr] }, "deny"],
          [{ resources: [pr], effect: "ask", agent: "own-review" }, "deny"],
          [{ action: "shell", resources: [typecheck], effect: "ask", agent: "build", sessionID: main }, "allow"],
          [{ action: "shell", resources: [typecheck], effect: "ask", agent: "explore", sessionID: main }, "deny"],
          [{ action: "shell", resources: [typecheck], effect: "ask", agent: "build" }, "ask"],
          [{ action: "shell", resources: ["ls"], effect: "allow", agent: "explore" }, "deny"],
          [{ action: "edit", resources: ["a.ts"], effect: "ask", agent: "own-review" }, "deny"],
          [{ action: "shell", resources: ["ls"], effect: "allow", agent: "build" }, "allow"],
          [{ resources: [pr], effect: "deny", agent: "explore" }, "deny"],
        ] as const
        for (const [input, expected] of cases) {
          const said = await judge({ ...input, resources: [...input.resources] } as never)
          expect(said).toBe(said.replace(/: \w+$/, `: ${expected}`))
        }
      } finally {
        dispose()
      }
    }
  })

  test("an action rule matches as core's does: without regard to case on Windows", () => {
    const agents = new Map([
      [
        "mine",
        {
          id: "mine",
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            { action: "GitHub.Write", resource: "*", effect: "allow" },
          ],
        },
      ],
    ])
    GitHubTools.askWrites(agentEditor(agents) as never)
    const windows = process.platform === "win32"
    // Core reads `GitHub.Write` as `github.write` on Windows: the write would run unasked without the ask rule.
    expect(agents.get("mine")!.permissions.at(-1)).toEqual(
      windows
        ? { action: "github.write", resource: "*", effect: "ask" }
        : { action: "GitHub.Write", resource: "*", effect: "allow" },
    )
    for (const [input, pattern] of [
      ["github.write", "GITHUB.WRITE"],
      ["create_pull_request octo/hello", "create_pull_request octo/*"],
      ["create_pull_request octo/hello", "create_pull_request oct?/hello"],
      ["git push origin", "git push *"],
      ["git push", "git push *"],
      ["a.b", "a?b"],
      ["a+b", "a+b"],
    ] as const)
      expect(`${input} ~ ${pattern}: ${GitHubTools.wildcard(input, pattern)}`).toBe(
        `${input} ~ ${pattern}: ${Wildcard.match(input, pattern)}`,
      )
  })

  test("항상 허용 saves a repository GitHub could name; a made-up name or no repository may be allowed once only", async () => {
    await using t = await rig()
    const ids = await connectedAccounts(t)
    await ok(t.rpc["github.update"], { id: ids.work, write: true })
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: ids.work })
    const dispose = await connect(t.deps)
    try {
      await untilAsync(async () => t.fake.tools().some((tool) => tool.name === "create_pull_request"))
      const create = t.fake.tools().find((tool) => tool.name === "create_pull_request")!
      const asked = async (input: Record<string, unknown>) => {
        await create.execute(input, context("ses_save"))
        return t.fake.asks.at(-1)
      }
      const as = `as octo-work (${ids.work})`
      expect(await asked({ owner: "octo", repo: "hello.js" })).toMatchObject({
        resources: [`create_pull_request octo/hello.js ${as}`],
        save: [`create_pull_request octo/hello.js ${as}`],
      })
      // As core's pattern, `*/*` would allow every repository later (gv1 wildcard.ts).
      for (const input of [
        { owner: "*", repo: "*" },
        { owner: "octo", repo: "*" },
        { owner: "oct?", repo: "hell?" },
        { owner: "-octo", repo: "hello" },
        { owner: "octo", repo: ".." },
      ])
        expect(await asked(input)).toMatchObject({
          resources: [`create_pull_request ${input.owner}/${input.repo} ${as}`],
          save: [],
        })
      expect(await asked({ title: "no repository" })).toMatchObject({
        resources: [`create_pull_request ${as}`],
        save: [],
      })
    } finally {
      dispose()
    }
  })
})

describe("a conversation's choice in the shells core starts (GH-14, P-046)", () => {
  test("the command's conversation chooses, off too; a command without one never overrules a conversation here", async () => {
    await using t = await rig()
    const ids = await connectedAccounts(t, { site: github().url })
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: ids.work })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_home", directory: t.project },
      account: ids.home,
    })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_off", directory: t.project },
      account: "off",
    })
    const git = await scrubbedGit(path.join(fixture.root!, "git-home-shell"))
    const dispose = await connect(t.deps)
    try {
      const remote = `${github().url}/octo/hello.git`
      const asHome = await git.run(["ls-remote", remote], t.project, await t.fake.shell(t.project, "ses_home"))
      expect(asHome.code).toBe(0)
      expect(github().git.at(-1)).toMatchObject({ login: "octo-home" })
      expect(await t.fake.shell(t.project, "ses_off")).toEqual({})
      // A conversation here chose otherwise: a command that names none gets nothing (fail closed).
      expect(await t.fake.shell(t.project)).toEqual({})
      const asWork = await git.run(["ls-remote", remote], t.project, await t.fake.shell(t.project, "ses_plain"))
      expect(asWork.code).toBe(0)
      expect(github().git.at(-1)).toMatchObject({ login: "octo-work" })
      await ok(t.rpc["github.bind"], { target: { type: "session", sessionID: "ses_home" }, account: null })
      await ok(t.rpc["github.bind"], { target: { type: "session", sessionID: "ses_off" }, account: null })
      expect((await t.fake.shell(t.project)).OWN_GITHUB_CREDENTIAL).toBeDefined()
    } finally {
      dispose()
    }
  })
})

describe("an account that allows no writes never pushes (GH-17)", () => {
  test("real git: git push goes nowhere, a push URL of the user's own gets no login, fetches still log in", async () => {
    await using t = await rig()
    const ids = await connectedAccounts(t, { site: github().url })
    const git = await scrubbedGit(path.join(fixture.root!, "git-home-push"))
    const repo = path.join(t.project, "repo")
    const ssh = sshRecorder(path.join(t.project, "ssh-started"))
    const remote = `${github().url}/octo/hello.git`
    await fs.mkdir(repo, { recursive: true })
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "first"],
      ["remote", "add", "origin", remote],
    ])
      expect((await git.run(args, repo, {})).code).toBe(0)
    const dispose = await connect(t.deps)
    try {
      const before = github().git.length
      const pushes = () =>
        github()
          .git.slice(before)
          .filter((item) => item.service === "git-receive-pack")
      const pushed = await git.run(["push", "origin", "main"], repo, { ...(await t.fake.shell(repo)), ...ssh.env })
      expect(pushed.code).not.toBe(0)
      expect(pushed.stderr).toContain(GitHubCredential.READ_ONLY_SCHEME)
      expect(pushes()).toEqual([])
      expect(await ssh.started()).toBe(false)
      const fetched = await git.run(["ls-remote", "origin"], repo, await t.fake.shell(repo))
      expect(fetched.code).toBe(0)
      expect(github().git.at(-1)).toMatchObject({ login: "octo-work", service: "git-upload-pack" })
      if (process.platform === "win32") {
        // An explicit push URL skips `pushInsteadOf`; git's own transport asks, and own sees a push above it.
        expect((await git.run(["config", "remote.origin.pushurl", remote], repo, {})).code).toBe(0)
        const direct = await git.run(["push", "origin", "main"], repo, await t.fake.shell(repo))
        expect(direct.code).not.toBe(0)
        expect(pushes()).toEqual([])
        // An option own did not read before the subcommand (`--attr-source <tree>`) still counts as a push (GH-28).
        const valued = await git.run(
          ["--attr-source", "HEAD", "push", "origin", "main"],
          repo,
          await t.fake.shell(repo),
        )
        expect(valued.code).not.toBe(0)
        expect(pushes()).toEqual([])
      }
      await ok(t.rpc["github.update"], { id: ids.work, write: true })
      const allowed = await git.run(["push", "origin", "main"], repo, await t.fake.shell(repo))
      expect(allowed.stderr).not.toContain(GitHubCredential.READ_ONLY_SCHEME)
      expect(pushes().map((item) => item.login)).toEqual(["octo-work"])
    } finally {
      dispose()
    }
  })

  // The read-only push URL is git's remote-helper form: git-lfs stops before any network and never starts ssh (with
  // `github-account-is-read-only://` it read the name as an SSH host and ran ssh a dozen times, about 25 s: GH-36).
  // Three git-lfs runs of a dozen git processes each: 180 s, not the file's 60 s (LFS-T in `lfsRepo`).
  test("Git LFS logs in through git-lfs; a read-only account's LFS push gets nothing and starts no ssh", async () => {
    const git = await scrubbedGit(path.join(fixture.root!, "git-home-lfs"))
    if (!git.which("git-lfs")) return
    await using t = await rig()
    const ids = await connectedAccounts(t, { site: github().url })
    await ok(t.rpc["github.update"], { id: ids.work, write: true })
    const repo = path.join(t.project, "lfs-repo")
    const ssh = sshRecorder(path.join(t.project, "lfs-ssh-started"))
    await lfsRepo(git, repo, `${github().url}/octo/hello.git`)
    const dispose = await connect(t.deps)
    try {
      const before = github().git.length
      const uploads = () =>
        github()
          .git.slice(before)
          .filter((item) => item.service === "lfs-upload")
      const pushStarted = performance.now()
      const pushed = await git.run(["lfs", "push", "origin", "main"], repo, await t.fake.shell(repo))
      const pushMs = performance.now() - pushStarted
      expect(`${pushed.code} ${pushed.stderr}`).toStartWith("0 ")
      expect(uploads().map((item) => item.login)).toEqual(["octo-work"])
      await ok(t.rpc["github.update"], { id: ids.work, write: false })
      const started = performance.now()
      const refused = await git.run(["lfs", "push", "origin", "main"], repo, {
        ...(await t.fake.shell(repo)),
        ...ssh.env,
      })
      expect(refused.code).not.toBe(0)
      expect(refused.stderr).toContain(GitHubCredential.READ_ONLY_SCHEME)
      expect(uploads()).toHaveLength(1)
      expect(await ssh.started()).toBe(false)
      // No retries: one git-lfs start, never the dozen ssh attempts' half minute. A process start takes seconds on a loaded
      // PC, so the bound grows with the allowed push's time, which started more processes than a refusal (LFS-T).
      expect(performance.now() - started).toBeLessThan(Math.max(20_000, 2 * pushMs))
    } finally {
      dispose()
    }
  }, 180_000)
})

describe("the accounts' tokens kept from agents (GH-18, GH-19)", () => {
  test("every tool's result in every harness has the tokens cut out, git's Basic login too", async () => {
    await using t = await rig()
    await connectedAccounts(t)
    const dispose = await connect(t.deps)
    try {
      const basic = Buffer.from(`octo-work:${WORK}`).toString("base64")
      const done = await t.fake.after({
        status: "completed",
        result: {
          content: [
            { type: "text", text: `export GH=${WORK}` },
            { type: "file", uri: "file:///a.png", mime: "image/png" },
          ],
          output: { stdout: `Authorization: Basic ${basic}`, lines: [HOME_TOKEN] },
          metadata: { output: `token ${WORK} and ${HOME_TOKEN}` },
        },
      })
      const text = JSON.stringify(done)
      for (const secret of [WORK, HOME_TOKEN, basic]) expect(text).not.toContain(secret)
      expect(text).toContain("export GH=••••")
      expect(text).toContain("file:///a.png")
      const plain = await t.fake.after({ status: "completed", result: { content: `printed ${WORK}` } })
      expect(plain).toMatchObject({ result: { content: "printed ••••" } })
      const failed = await t.fake.after({ status: "error", error: new Tool.Error({ message: `bad ${HOME_TOKEN}` }) })
      expect(failed).toMatchObject({ error: { message: "bad ••••" } })
      const untouched = new Tool.Error({ message: "nothing secret" })
      expect((await t.fake.after({ status: "error", error: untouched })).status === "error" && untouched).toBe(
        untouched,
      )
    } finally {
      dispose()
    }
  })

  test("a ticket ends with its command or its time; each login names its repository and is logged", async () => {
    const logs: string[] = []
    await using t = await rig({ logs })
    await connectedAccounts(t, { site: github().url })
    const git = await scrubbedGit(path.join(fixture.root!, "git-home-ticket"))
    const dispose = await connect(t.deps)
    try {
      const remote = `${github().url}/octo/hello.git`
      const command = new AbortController()
      const env = (await GitHubBridge.gitEnv(t.project, { signal: command.signal }))!
      expect((await git.run(["ls-remote", remote], t.project, env)).code).toBe(0)
      command.abort()
      // The command exited: its ticket is worth nothing now.
      const after = await fetch(env.OWN_GITHUB_CREDENTIAL!, { method: "POST", body: "protocol=http\nhost=x\n\n" })
      expect(after.status).toBe(403)
      expect((await git.run(["ls-remote", remote], t.project, env)).code).not.toBe(0)
      // Its time counts from its first use (GH-27): unused past it, it still answers; used, it ends after it.
      const short = await GitHubCredential.ticketURL({ directory: t.project }, { ms: 300 })
      await Bun.sleep(400)
      expect((await fetch(short, { method: "POST", body: "protocol=http\nhost=x\n\n" })).status).not.toBe(403)
      await Bun.sleep(400)
      expect((await fetch(short, { method: "POST", body: "protocol=http\nhost=x\n\n" })).status).toBe(403)
      const lines = logs.filter((line) => line.includes('"msg":"github_git_login"'))
      expect(lines.some((line) => line.includes('"repository":"octo/hello"'))).toBe(true)
      for (const secret of [WORK, HOME_TOKEN]) expect(logs.join("\n")).not.toContain(secret)
      // A request that names no repository gets nothing.
      const bare = (await GitHubBridge.gitEnv(t.project))!
      const host = new URL(github().url).host
      await fetch(bare.OWN_GITHUB_CREDENTIAL!, { method: "POST", body: `protocol=http\nhost=${host}\n\n` })
      expect(
        logs.some((line) => line.includes('"msg":"github_git_login_refused"') && line.includes('"no_repository"')),
      ).toBe(true)
    } finally {
      dispose()
    }
  })

  test.skipIf(process.platform !== "win32")(
    "on Windows only git's transport and git-lfs get a login: curl with the ticket and git credential fill do not",
    async () => {
      const logs: string[] = []
      await using t = await rig({ logs })
      await connectedAccounts(t, { site: github().url })
      const git = await scrubbedGit(path.join(fixture.root!, "git-home-caller"))
      const dispose = await connect(t.deps)
      try {
        const env = await t.fake.shell(t.project)
        const host = new URL(github().url).host
        const ask = `protocol=http\nhost=${host}\npath=octo/hello.git\n\n`
        const curl = await git.exec(
          ["sh", "-c", 'curl -s --noproxy "*" --data-binary @- "$OWN_GITHUB_CREDENTIAL"'],
          t.project,
          env,
          ask,
        )
        expect(curl.stdout).not.toContain(WORK)
        const fill = await git.run(["credential", "fill"], t.project, env, ask)
        expect(fill.stdout).not.toContain("password=")
        expect(fill.code).not.toBe(0)
        const refusals = logs.filter(
          (line) => line.includes('"msg":"github_git_login_refused"') && line.includes('"reason":"caller"'),
        )
        expect(refusals.length).toBeGreaterThanOrEqual(2)
        expect(logs.join("\n")).not.toContain(WORK)
        // git's own transport still logs in.
        expect((await git.run(["ls-remote", `${github().url}/octo/hello.git`], t.project, env)).code).toBe(0)
        expect(logs.some((line) => line.includes('"msg":"github_git_login"'))).toBe(true)
      } finally {
        dispose()
      }
    },
  )
})

describe("ticket clock: a git login starts counting at its first use and ends with its command (GH-27)", () => {
  test("a command approved late, and one moved to the background, still log in; its exit ends the login", async () => {
    await using t = await rig()
    await connectedAccounts(t, { site: github().url })
    const git = await scrubbedGit(path.join(fixture.root!, "git-home-clock"))
    const dispose = await connect(t.deps)
    const remote = `${github().url}/octo/hello.git`
    const start = Date.now()
    try {
      // Core's shell tool runs create.before (the ticket) before it asks the user about the command; the user
      // approves ten minutes later. A command without an id (an older core) keeps timeout + a minute from first use.
      const late = await t.fake.shell(t.project, "ses_late", { timeout: 1_000 })
      setSystemTime(new Date(start + 10 * 60_000))
      expect((await git.run(["ls-remote", remote], t.project, late)).code).toBe(0)
      // A command core names (P-046) logs in until it exits: moved to the background after its 1 s timeout, its git
      // still logs in two hours on.
      const moved = await t.fake.shell(t.project, "ses_bg", { timeout: 1_000, id: "shl_moved" })
      expect((await git.run(["ls-remote", remote], t.project, moved)).code).toBe(0)
      setSystemTime(new Date(start + 2 * 60 * 60_000))
      expect((await git.run(["ls-remote", remote], t.project, moved)).code).toBe(0)
      await dispose.connection.onEvent({ type: "shell.exited", data: { id: "shl_moved", status: "exited" } } as never, {
        local: false,
      })
      expect((await git.run(["ls-remote", remote], t.project, moved)).code).not.toBe(0)
      // Nothing outlives six hours from the ticket's making, however late its first use.
      const long = await t.fake.shell(t.project, "ses_long", { id: "shl_long" })
      setSystemTime(new Date(start + 7 * 60 * 60_000))
      expect((await git.run(["ls-remote", remote], t.project, long)).code).toBe(0)
      setSystemTime(new Date(start + 2 * 60 * 60_000 + GitHubCredential.MAX_TICKET_MS + 1_000))
      expect((await git.run(["ls-remote", remote], t.project, long)).code).not.toBe(0)
    } finally {
      setSystemTime()
      dispose()
    }
  })
})

describe("commands whose permission was refused (RL2-L4)", () => {
  test("past a thousand commands only refused ones are let go, their logins ended; a running command keeps its own", async () => {
    await using t = await rig()
    await connectedAccounts(t, { site: github().url })
    const dispose = await connect(t.deps)
    const ticketOf = (env: Readonly<Record<string, string | undefined>>) => env.OWN_GITHUB_CREDENTIAL!.split("/git/")[1]
    try {
      // The oldest command runs (core's `shell.created` named it); the next one's permission was refused, so it never
      // started or exits.
      const running = ticketOf(await t.fake.shell(t.project, "ses_many", { id: "shl_running" }))
      await dispose.connection.onEvent(
        { type: "shell.created", data: { info: { id: "shl_running", pid: 4242 } } } as never,
        { local: false },
      )
      const refused = ticketOf(await t.fake.shell(t.project, "ses_many", { id: "shl_refused" }))
      t.control.clock.advance(GitHubCommands.START_GRACE_MS)
      // A thousand younger commands, none started yet (their `shell.created` may still be on its way).
      const young: Array<string | undefined> = []
      for (let index = 0; index < GitHubCommands.MAX; index++)
        young.push(ticketOf(await t.fake.shell(t.project, "ses_many", { id: `shl_young_${index}` })))
      expect(GitHubCredential.redeem(running)).toBeDefined()
      // Before, the refused command's login lived on for six hours once it was let go.
      expect(GitHubCredential.redeem(refused)).toBeUndefined()
      expect(young.every((ticket) => GitHubCredential.redeem(ticket) !== undefined)).toBe(true)
    } finally {
      dispose()
    }
  }, 120_000)
})

describe("the review tab's git after old conversation choices (GH-33)", () => {
  test("only a conversation chosen or active in the last week keeps a command without one from the folder's account", async () => {
    await using t = await rig()
    const ids = await connectedAccounts(t, { site: github().url })
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: ids.work })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_old", directory: t.project },
      account: ids.home,
    })
    const dispose = await connect(t.deps)
    try {
      const login = async () => (await t.fake.shell(t.project)).OWN_GITHUB_CREDENTIAL !== undefined
      expect(await login()).toBe(false)
      // Eight days on, the conversation is gone or idle: the folder's account is the review tab's again.
      t.control.clock.advance(8 * 24 * 60 * 60_000)
      expect(await login()).toBe(true)
      // Still active (core's session was updated lately): it keeps the folder's command from logging in.
      t.fake.sessions.set("ses_old", { location: { directory: t.project }, time: { updated: t.control.clock.now() } })
      expect(await login()).toBe(false)
      t.fake.sessions.delete("ses_old")
      // A conversation's choice made without its folder counts where core's session is, and when that is unknown.
      await ok(t.rpc["github.bind"], { target: { type: "session", sessionID: "ses_nofolder" }, account: "off" })
      expect(await login()).toBe(false)
      t.fake.sessions.set("ses_nofolder", {
        location: { directory: fixture.root! + "-elsewhere" },
        time: { updated: 0 },
      })
      expect(await login()).toBe(true)
      t.fake.sessions.set("ses_nofolder", { location: { directory: t.project }, time: { updated: 0 } })
      expect(await login()).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("who asks for a git login (GH-28, GH-34)", () => {
  const images = ["C:\\Git\\mingw64\\libexec\\git-core\\git-remote-https.exe", "C:\\Git\\mingw64\\bin\\git-lfs.exe"]
  const https = { pid: 3, name: "git-remote-https.exe", image: images[0] }
  const gitOf = (command: string) => ({ pid: 4, name: "git.exe", command })
  const chain = (command: string) => [{ pid: 1, name: "curl.exe" }, { pid: 2, name: "sh.exe" }, https, gitOf(command)]

  test("a push is any git command line own cannot read to its subcommand, or one with a push word", () => {
    for (const [command, operation] of [
      ["git fetch origin", "fetch"],
      ["git -C . -c a.b=c fetch", "fetch"],
      ["git --no-pager --git-dir=.git fetch", "fetch"],
      ["git push origin main", "push"],
      ["git --attr-source HEAD push origin main", "push"],
      ["git --shallow-file x fetch-pack", "fetch"],
      ["git --attr-source=HEAD push", "push"],
      ["git --some-new-option x fetch", "push"],
      ["git -c alias.up=push up origin main", "push"],
      ['git -c "alias.publish=push --force" publish origin main', "push"],
      ["git send-pack origin", "push"],
    ] as const)
      expect(`${command}: ${GitHubCaller.verdict(chain(command), images).operation}`).toBe(`${command}: ${operation}`)
  })

  test("only the exact programs of this service's git are trusted; a caller not read is not", () => {
    expect(GitHubCaller.verdict(chain("git fetch"), images).trusted).toBe(true)
    // The same program name copied anywhere else, inside git's folder or under the project, gets nothing.
    for (const image of ["C:\\Git\\mingw64\\libexec\\git-core\\x\\git-remote-https.exe", "C:\\p\\git-remote-https.exe"])
      expect(GitHubCaller.verdict([{ ...https, image }, gitOf("git fetch")], images).trusted).toBe(false)
    expect(GitHubCaller.verdict([{ pid: 3, name: "git-remote-https.exe" }], images).trusted).toBe(false)
    // No client address (a requestIP that cannot be read) or a system where callers are not read: never trusted.
    expect(GitHubCaller.judge(undefined, undefined, images)).toMatchObject({ trusted: false })
    if (process.platform === "win32") {
      const found = GitHubCaller.images().map((item) => path.basename(item).toLowerCase())
      expect(found).toContain("git-remote-https.exe")
    }
  })

  // Git for Windows 2.56 moved git and git-lfs from `mingw64` to `ucrt64`; `cmd` keeps launchers (`cmd\git-lfs.exe`),
  // and the git-lfs that git starts and that asks is the real program in `ucrt64\bin`. Each Git here is installed under
  // a folder named `ucrt64` that holds a `bin\git-lfs.exe` of its own: that folder is not Git's (review guf).
  test("Git for Windows' own git-lfs is trusted in `mingw64\\bin` (up to 2.55) and `ucrt64\\bin` (2.56)", async () => {
    await Bun.write(path.join(fixture.root!, "ucrt64", "bin", "git-lfs.exe"), "")
    for (const prefix of ["mingw64", "ucrt64"]) {
      const root = path.join(fixture.root!, "ucrt64", `git-layout-${prefix}`)
      const exec = path.join(root, prefix, "libexec", "git-core")
      const lfs = path.join(root, prefix, "bin", "git-lfs.exe")
      const launcher = path.join(root, "cmd", "git-lfs.exe")
      const transports = ["git-remote-http.exe", "git-remote-https.exe"].map((name) => path.join(exec, name))
      // Wherever this service finds git: the Git folder's launcher, its `bin`, or the program itself.
      const gits = ["cmd", "bin", path.join(prefix, "bin")].map((folder) => path.join(root, folder, "git.exe"))
      for (const file of [...gits, launcher, lfs, ...transports]) await Bun.write(file, "")
      const expected = [...transports, lfs, launcher].map((file) => path.resolve(file))
      for (const git of gits) {
        const found = GitHubCaller.programs(git, exec, launcher)
        expect(`${git}: ${found.join(", ")}`).toBe(`${git}: ${expected.join(", ")}`)
        const asks = [{ pid: 5, name: "git-lfs.exe", image: lfs }, gitOf("git lfs push origin main")]
        expect(GitHubCaller.verdict(asks, found)).toEqual({ trusted: true, operation: "push", via: "git-lfs.exe" })
      }
    }
  })

  // The list is read at the first login and kept. Updating Git for Windows from 2.55 to 2.56 while own runs removes the
  // `mingw64` programs (the installer uninstalls the previous version first) and puts them in `ucrt64`, and the kept list
  // then refused every git login until own restarted (GU-2). While every listed program still exists nothing reads it
  // again: a git-lfs put into a PATH folder ahead of Git's after the first read, which a read now would find, stays
  // refused, and another install's git starts no `git --exec-path` (review guf, GU-10).
  test("a git program not on the list reads it again once a listed program is gone; nothing else does", async () => {
    const root = path.join(fixture.root!, "git-update")
    const layout = (prefix: string) =>
      [path.join(prefix, "libexec", "git-core", "git-remote-https.exe"), path.join(prefix, "bin", "git-lfs.exe")].map(
        (file) => path.join(root, file),
      )
    const launcher = path.join(root, "cmd", "git-lfs.exe")
    const before = [...layout("mingw64"), launcher]
    const after = layout("ucrt64")
    const planted = path.join(fixture.root!, "userbin", "git-lfs.exe")
    const foreign = path.join(fixture.root!, "other-git", "mingw64", "libexec", "git-core", "git-remote-https.exe")
    for (const file of [...before, ...after, planted, foreign]) await Bun.write(file, "")
    // As the listener keeps it: the list read at the first login, replaced when it is read again. A read now finds the
    // new transport and git-lfs, `cmd`'s launcher and, PATH's git-lfs being the planted copy, that copy.
    const state = { images: before, reads: 0 }
    const reread = () => {
      state.reads += 1
      state.images = [...after, launcher, planted]
      return state.images
    }
    const ask = (image: string) =>
      GitHubCaller.verdict([{ pid: 3, name: path.basename(image), image }, gitOf("git fetch")], state.images, reread)
        .trusted
    // 2.55 still installed: the copy on PATH and another install's transport are refused without a read.
    expect(ask(planted)).toBe(false)
    expect(ask(foreign)).toBe(false)
    expect(state.reads).toBe(0)
    // The update removes `mingw64`'s programs: the first git program not on the list reads it again, and is trusted.
    for (const file of before.slice(0, 2)) await fs.rm(file)
    expect(ask(after[1]!)).toBe(true)
    expect(ask(after[0]!)).toBe(true)
    expect(state.reads).toBe(1)
    // On a list that went stale, a trusted caller, a caller that is no git program, or one whose program could not be
    // read: no read.
    const curl = chain("git fetch").slice(0, 2)
    const unread = { pid: 3, name: "git-remote-https.exe" }
    const lfs = { pid: 3, name: "git-lfs.exe", image: launcher }
    expect(GitHubCaller.verdict([lfs, gitOf("git lfs push origin main")], before, reread).trusted).toBe(true)
    expect(GitHubCaller.verdict(curl, before, reread).trusted).toBe(false)
    expect(GitHubCaller.verdict([unread], before, reread).trusted).toBe(false)
    expect(state.reads).toBe(1)
    // A list read when no git was found (Git installed while own runs) is read again too.
    expect(GitHubCaller.verdict([{ pid: 3, name: "git-lfs.exe", image: after[1] }], [], reread).trusted).toBe(true)
    expect(state.reads).toBe(2)
    // Without a way to read again (the list as it was), the moved program is refused.
    expect(GitHubCaller.verdict([{ pid: 3, name: "git-lfs.exe", image: after[1] }], before).trusted).toBe(false)
  })
})

describe("masking: a lost file, base64, data: URIs, retired tokens and the model's context (GH-30)", () => {
  test("the last mask stays when github.json cannot be read; base64 forms and data: URIs are cut", async () => {
    await using t = await rig()
    await connectedAccounts(t, { site: github().url })
    // A token without long runs, so its base64 shares nothing with the other values' by chance, and a login that puts
    // it at another byte alignment inside git's Basic value (`octo-vary:` is 10 bytes).
    const varied = "ghp_q8Zr3Lm7Xv2Nc5Tb9Wk4Hy6Jd1Fs0Ga8Pe3U"
    github().addAccount(varied, { login: "octo-vary" })
    await ok(t.rpc["github.add.token"], { token: varied, label: "변화", site: github().url })
    const dispose = await connect(t.deps)
    try {
      const b64 = Buffer.from(varied).toString("base64")
      const inner = Buffer.from(`x-access-token:${varied}`).toString("base64url")
      const done = await t.fake.after({
        status: "completed",
        result: {
          content: [
            { type: "text", text: `b64 ${b64} inner ${inner}` },
            { type: "file", uri: `data:text/plain;base64,${b64}`, mime: "text/plain" },
          ],
        },
      })
      const text = JSON.stringify(done)
      for (const form of [varied, b64.slice(4, 16), b64.slice(-16, -4), inner.slice(24, 36)])
        expect(text).not.toContain(form)
      expect(GitHubMask.base64Forms(varied).length).toBe(6)
      // The file is broken by hand and the masker reads again: the last mask stays.
      await Bun.write(t.control.deps.runtime.layout.github, "{ corrupt")
      t.control.deps.runtime.broadcast.emit("github.changed", {})
      const after = await t.fake.after({ status: "completed", result: { content: `printed ${WORK}` } })
      expect(after).toMatchObject({ result: { content: "printed ••••" } })
    } finally {
      dispose()
    }
  })

  test("a removed account's token stays masked by its hash; github.json holds no token", async () => {
    await using t = await rig()
    const ids = await connectedAccounts(t, { site: github().url })
    const dispose = await connect(t.deps)
    try {
      await ok(t.rpc["github.remove"], { id: ids.home })
      expect(await t.fileText()).not.toContain(HOME_TOKEN)
      expect((await t.file()).retired).toHaveLength(1)
      const after = await t.fake.after({ status: "completed", result: { content: `old ${HOME_TOKEN} now ${WORK}` } })
      expect(after).toMatchObject({ result: { content: "old •••• now ••••" } })
      // Thirty days on it is no longer masked.
      t.control.clock.advance(31 * 24 * 60 * 60_000)
      t.control.deps.runtime.broadcast.emit("github.changed", {})
      const later = await t.fake.after({ status: "completed", result: { content: `old ${HOME_TOKEN}` } })
      // (Only the run it shares with the live work token is cut.)
      expect(JSON.stringify(later)).toContain("old github_pat_11FAKEHOME0000_fakeHome")
    } finally {
      dispose()
    }
  })

  test("what a model request sends is masked too: a background command's notice and the user's ! output", async () => {
    await using t = await rig()
    await connectedAccounts(t, { site: github().url })
    const dispose = await connect(t.deps)
    try {
      const assistant = { role: "assistant", content: [{ type: "text", text: "nothing secret" }] }
      const messages = await t.fake.request([
        { role: "user", content: [{ type: "text", text: `<background> printed ${WORK}` }] },
        assistant,
        { role: "user", content: [{ type: "text", text: `! env\nGH=${HOME_TOKEN}` }] },
        {
          role: "tool",
          content: [{ type: "tool-result", id: "c1", name: "bash", result: { type: "text", value: `x ${WORK}` } }],
        },
      ])
      const text = JSON.stringify(messages)
      for (const secret of [WORK, HOME_TOKEN]) expect(text).not.toContain(secret)
      expect(text).toContain("printed ••••")
      expect(messages[1]).toBe(assistant)
    } finally {
      dispose()
    }
  })

  test("every kind of model request is masked: compaction, a one-off generate and the title too (MR9 review)", async () => {
    await using t = await rig()
    await connectedAccounts(t, { site: github().url })
    const dispose = await connect(t.deps)
    try {
      // A generate (the goal reviewer, warming, own-team's judge, `POST /api/session/:id/generate`) carries the whole
      // history; on the Claude Agent route it is written as a forked transcript into the shared projects folder.
      for (const kind of ["context", "compaction", "generate", "title"] as const) {
        const messages = await t.fake.request(
          [
            { role: "user", content: [{ type: "text", text: `토큰은 ${WORK} 이에요` }] },
            {
              role: "tool",
              content: [{ type: "tool-result", id: "c1", name: "bash", result: { type: "text", value: HOME_TOKEN } }],
            },
          ],
          kind,
        )
        const text = JSON.stringify(messages)
        for (const secret of [WORK, HOME_TOKEN]) expect(`${kind}: ${text.includes(secret)}`).toBe(`${kind}: false`)
        expect(text).toContain("토큰은 •••• 이에요")
      }
    } finally {
      dispose()
    }
  })
})

describe("GitHub's MCP sessions and the tool list (GH-15, GH-20 to GH-23)", () => {
  test("a tool counts as a read only when its name reads as one or it is on the reviewed list", async () => {
    expect(GitHubReads.isRead("get_me", true, undefined)).toBe(true)
    expect(GitHubReads.isRead("delete_file", true, undefined)).toBe(false)
    expect(GitHubReads.isRead("mark_all_notifications_read", true, undefined)).toBe(false)
    expect(GitHubReads.isRead("list_issues", false, undefined)).toBe(false)
    expect(GitHubReads.isRead("ui_get", false, "github-mcp-server 2.0.3")).toBe(true)
    expect(GitHubReads.isRead("ui_get", false, "github-mcp-server 2.0.4")).toBe(false)
    expect(GitHubReads.REVIEWED["github-mcp-server 2.0.3"]).toHaveLength(57)
    const liar = startFakeGitHub({
      accounts: { [WORK]: { login: "octo-work" } },
      tools: [{ name: "delete_everything", description: "Says it only reads", read: true }],
    })
    try {
      await using t = await rig({ endpoints: liar.endpoints })
      await ok(t.rpc["github.add.token"], { token: WORK, label: "회사" })
      await untilAsync(async () => (await t.file()).catalog !== undefined)
      const file = await t.file()
      expect(GitHubStore.catalogView(file.catalog)!.write).toContain("delete_everything")
      // A read-only place offers reads only; a catalog stored with the server's mark alone is judged again.
      const hinted = {
        ...file,
        catalog: { ...file.catalog!, tools: file.catalog!.tools.map((tool) => ({ ...tool, read: true })) },
      }
      for (const stored of [file, hinted])
        expect(
          (await GitHubTools.offer(stored, { directory: t.project, control: false })).tools.map((tool) => tool.name),
        ).not.toContain("delete_everything")
    } finally {
      liar.stop()
    }
  })

  test("a program on this PC gets an allow-list environment, without the service's other variables", async () => {
    process.env.OWN_GITHUB_TEST_CANARY = "service-only"
    const target: GitHubMcp.Target = {
      account: "gh_00000000000000000000ENVSRV",
      server: {
        type: "local",
        command: process.execPath,
        args: [path.join(import.meta.dir, "fixtures", "env-server.ts")],
      },
      site: OwnGitHub.GITHUB_COM,
      token: WORK,
      toolsets: ["context"],
      readOnly: true,
    }
    try {
      const result = await GitHubMcp.call(target, "get_env", {})
      const env = JSON.parse(result.text) as Record<string, string>
      expect(env.OWN_GITHUB_TEST_CANARY).toBeUndefined()
      expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(WORK)
      expect(env.GITHUB_READ_ONLY).toBe("1")
      expect(Object.keys(env).some((name) => name.toUpperCase() === "PATH")).toBe(true)
      if (process.platform === "win32")
        expect([env.USERNAME, env.USERDOMAIN, env.LOGONSERVER, env.COMPUTERNAME]).toEqual(["", "", "", ""])
    } finally {
      delete process.env.OWN_GITHUB_TEST_CANARY
      await GitHubMcp.dropAll(GitHubMcp.ofAccount(target.account))
    }
  })

  test("a changed account closes its own sessions only; a 403 marks the token only when GitHub refuses it", async () => {
    await using t = await rig()
    const from = github().mcp.length
    const ids = await connectedAccounts(t)
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: t.project }, account: ids.work })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_home_mcp", directory: t.project },
      account: ids.home,
    })
    const dispose = await connect(t.deps)
    try {
      const getMe = t.fake.tools().find((tool) => tool.name === "get_me")!
      await getMe.execute({}, context("ses_work_mcp"))
      await getMe.execute({}, context("ses_home_mcp"))
      // Each account's sessions: the tool list's and the calls'.
      const sessionsOf = (login: string) => [
        ...new Set(
          github()
            .mcp.slice(from)
            .flatMap((item) => (item.login === login && item.session !== undefined ? [item.session] : [])),
        ),
      ]
      const work = sessionsOf("octo-work")
      const home = sessionsOf("octo-home")
      expect(home.length).toBeGreaterThan(0)
      const closed = github().closed.length
      await ok(t.rpc["github.update"], { id: ids.work, label: "회사 계정" })
      expect(github().closed.slice(closed).toSorted()).toEqual(work.toSorted())
      for (const session of home) expect(github().closed).not.toContain(session)
      // GitHub's MCP server answers 403 (a toolset this token may not reach) while /user takes the token.
      github().forbidden.add(HOME_TOKEN)
      await GitHubMcp.dropAll(GitHubMcp.ofAccount(ids.home))
      await expect(getMe.execute({}, context("ses_home_mcp"))).rejects.toThrow("refused")
      expect((await t.file()).accounts.find((item) => item.id === ids.home)?.problem).toBeUndefined()
    } finally {
      github().forbidden.delete(HOME_TOKEN)
      dispose()
    }
  })

  test("a site or server address over plain http is refused, but for this PC", async () => {
    await using t = await rig()
    expect(await call(t.rpc["github.add.token"], { token: WORK, site: "http://github.example.com" })).toMatchObject({
      ok: false,
      type: "github_invalid",
      data: { field: "site" },
    })
    expect(
      await call(t.rpc["github.settings.set"], { server: { type: "remote", url: "http://mcp.example.com/mcp" } }),
    ).toMatchObject({ ok: false, type: "github_invalid", data: { field: "server" } })
    await ok(t.rpc["github.settings.set"], { server: { type: "remote", url: "http://127.0.0.1:9/mcp" } })
    await ok(t.rpc["github.settings.set"], { server: { type: "remote", url: OwnGitHub.HOSTED } })
  })

  test("renewals are one per account for the whole process, whichever module copy asks", async () => {
    await using t = await rig()
    await ok(t.rpc["github.settings.set"], { clientID: "Iv1.fakeRenewOnce1" })
    const id = OwnGitHub.ID.create()
    const refresh = "ghr_fakeRenewOnce00000000000000000000Qr12"
    await GitHubStore.storeSecret(t.control.deps, id, {
      token: "ghu_fakeExpiredToken0000000000000000St34",
      refresh,
      expiresAt: t.control.clock.now() - 1,
    })
    github().refreshTo(refresh, { token: "ghu_fakeRenewedOnce0000000000000000Uv56", expiresIn: 8 * 3600 })
    const entry: GitHubStore.Entry = {
      id,
      label: "앱",
      site: OwnGitHub.GITHUB_COM,
      login: "octo-app",
      source: "device",
      tokenKind: "app-user",
      hint: "…Uv56",
      write: false,
      addedAt: 0,
    }
    const settings = (await t.file()).settings
    // Plugin modules are imported again per Location (bun test shares one copy): another copy's renewal under way is
    // in the process-wide map, and this one joins it instead of spending the refresh token a second time.
    const holder = globalThis as unknown as Record<symbol, Map<string, Promise<GitHubService.Token>> | undefined>
    const renewing =
      holder[Symbol.for("own-open-code.github-renewing")] ?? new Map<string, Promise<GitHubService.Token>>()
    holder[Symbol.for("own-open-code.github-renewing")] = renewing
    const elsewhere = Promise.withResolvers<GitHubService.Token>()
    renewing.set(id, elsewhere.promise)
    const before = github().refreshes.length
    const joined = GitHubService.tokenFor(t.control.deps, entry, settings)
    elsewhere.resolve({ ok: true, token: "ghu_fakeRenewedElsewhere00000000000Wx78" })
    expect(await joined).toEqual({ ok: true, token: "ghu_fakeRenewedElsewhere00000000000Wx78" })
    expect(github().refreshes.length - before).toBe(0)
    // Once it ended, the next expired read renews once.
    renewing.delete(id)
    const answers = await Promise.all([
      GitHubService.tokenFor(t.control.deps, entry, settings),
      GitHubService.tokenFor(t.control.deps, entry, settings),
    ])
    expect(answers.map((answer) => answer.ok && answer.token)).toEqual([
      "ghu_fakeRenewedOnce0000000000000000Uv56",
      "ghu_fakeRenewedOnce0000000000000000Uv56",
    ])
    expect(github().refreshes.length - before).toBe(1)
  })
})

/**
 * WORK (`회사`, the default) and HOME_TOKEN (`개인`) connected, both read-only; on github.com the tool list read (a
 * site of its own, the fake's address, has no hosted tool server).
 */
async function connectedAccounts(t: Awaited<ReturnType<typeof rig>>, options: { readonly site?: string } = {}) {
  const work = await ok(t.rpc["github.add.token"], { token: WORK, label: "회사", ...options })
  const home = await ok(t.rpc["github.add.token"], { token: HOME_TOKEN, label: "개인", ...options })
  if (options.site === undefined) await untilAsync(async () => (await t.file()).catalog !== undefined)
  return { work: work.accounts[0]!.id, home: home.accounts.find((item) => item.label === "개인")!.id }
}

describe("browser login (device flow)", () => {
  test("needs the user's own client ID; connects after GitHub's waits; renews an expiring token", async () => {
    await using t = await rig()
    expect(await call(t.rpc["github.device.start"], {})).toMatchObject({
      ok: false,
      type: "github_invalid",
      data: { field: "client_id" },
    })
    await ok(t.rpc["github.settings.set"], { clientID: "Iv1.fakeClient123" })
    github().device({
      clientID: "Iv1.fakeClient123",
      userCode: "ABCD-1234",
      pending: 1,
      token: "ghu_fakeDeviceToken0000000000000000Gh78",
      refresh: "ghr_fakeRefresh0000000000000000000000Ij90",
      expiresIn: 8 * 3600,
    })
    github().addAccount("ghu_fakeDeviceToken0000000000000000Gh78", { login: "octo-app" })
    const started = await ok(t.rpc["github.device.start"], { label: "앱 로그인" })
    expect(started.userCode).toBe("ABCD-1234")
    t.control.clock.advance(started.intervalMs)
    expect((await ok(t.rpc["github.device.status"], { nonce: started.nonce })).state).toBe("waiting")
    t.control.clock.advance(started.intervalMs)
    const done = await ok(t.rpc["github.device.status"], { nonce: started.nonce })
    expect(done.state).toBe("done")
    const account = done.view!.accounts.find((item) => item.id === done.account)!
    expect(account).toMatchObject({ label: "앱 로그인", login: "octo-app", source: "device", tokenKind: "app-user" })
    // Eight hours later the token is renewed with the refresh token and the client ID (no secret).
    github().refreshTo("ghr_fakeRefresh0000000000000000000000Ij90", {
      token: "ghu_fakeRenewedToken000000000000000Kl12",
      refresh: "ghr_fakeRefresh2000000000000000000000Mn34",
      expiresIn: 8 * 3600,
    })
    t.control.clock.advance(8 * 3600 * 1000)
    const file = await t.file()
    const entry = file.accounts.find((item) => item.id === account.id)!
    const renewed = await GitHubService.tokenFor(t.control.deps, entry, file.settings)
    expect(renewed).toEqual({ ok: true, token: "ghu_fakeRenewedToken000000000000000Kl12" })
    expect(github().refreshes.at(-1)?.clientID).toBe("Iv1.fakeClient123")
    expect(await t.fileText()).not.toContain("ghu_fake")
    expect(await t.fileText()).not.toContain("ghr_fake")
  })
})

/** Polls an async probe (the catalog read and the reread after a change run in the background). */
async function untilAsync(probe: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs
  while (!(await probe())) {
    if (performance.now() > deadline) throw new Error("untilAsync: timed out")
    await Bun.sleep(20)
  }
}

/**
 * git with an allow-list environment under the test's scratch folder: its own HOME and global config, no system
 * config, PATH limited to git's folders (its shell and curl) and System32. Never the developer's environment.
 */
/**
 * An ssh that git and git-lfs would start (`GIT_SSH_COMMAND` runs through Git's sh): it only notes that it started in
 * `marker` and fails, so a test sees whether any ssh ran.
 */
function permutations<T>(items: ReadonlyArray<T>): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, at) =>
    permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [item, ...rest]),
  )
}
