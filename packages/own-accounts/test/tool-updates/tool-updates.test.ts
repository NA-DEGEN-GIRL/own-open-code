// 설정 > 업데이트 (05 §20, UPD): finding this PC's programs, their statuses and update methods, the daily release reads
// against fake listings (never npm or GitHub), the switch, the plan → confirm → run flow with a fake updater (never a
// real update), the streamed output, the version read again after it, a refused start (Smart App Control) and the
// environment the programs get, the time and the download size while it runs (UCP), and own's stop after an hour. Two
// tests start real child processes: a Bun one-liner that only prints, and fake-claude.ts, which acts like Claude Code's
// native updater in a temporary home (never the real one).
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolUpdates } from "@own/protocol"
import { ClaudeQuiet } from "../../src/claude-agent/quiet.js"
import { Register } from "../../src/rpc/register.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { ToolUpdatesRpc } from "../../src/rpc/tool-updates.js"
import { ToolUpdatesModule } from "../../src/tool-updates/tool-updates.js"
import { failure, registryWith, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const HOME = "C:\\Users\\me"
const CLAUDE = "C:\\Users\\me\\.local\\bin\\claude.exe"
const GIT = "C:\\Program Files\\Git\\cmd\\git.exe"
const LFS = "C:\\Program Files\\Git\\mingw64\\bin\\git-lfs.exe"
const GH = "C:\\Program Files\\GitHub CLI\\gh.exe"
const NPM = "http://npm.fake"
const GITHUB = "http://api.github.fake"

const ENV = {
  USERPROFILE: HOME,
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  SystemRoot: "C:\\Windows",
  PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
  TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
  ANTHROPIC_API_KEY: "sk-ant-fake-0000",
  CLAUDE_CONFIG_DIR: "C:\\somewhere",
  OPENCODE_SERVER_PASSWORD: "fake-password",
  OWN_HOME: "C:\\Users\\me\\AppData\\Local\\own-open-code",
  USERNAME: "me",
  COMPUTERNAME: "MY-PC",
}

/** The listings' answers (as on 2026-11-04 with made-up newer versions). */
const LISTINGS: Record<string, unknown> = {
  [`${NPM}/-/package/@anthropic-ai/claude-code/dist-tags`]: { latest: "2.1.320", stable: "2.1.301" },
  [`${GITHUB}/repos/git-for-windows/git/releases/latest`]: { tag_name: "v2.56.0.windows.1" },
  [`${GITHUB}/repos/git-lfs/git-lfs/releases/latest`]: { tag_name: "v3.8.1" },
  [`${GITHUB}/repos/cli/cli/releases/latest`]: { tag_name: "v2.101.0" },
  [`${GITHUB}/repos/BurntSushi/ripgrep/releases/latest`]: { tag_name: "15.1.0" },
  [`${GITHUB}/repos/github/github-mcp-server/releases/latest`]: { tag_name: "v2.1.0" },
}

interface FakeOptions {
  readonly which?: Record<string, string>
  readonly files?: ReadonlyArray<string>
  readonly versions?: Record<string, string>
  readonly env?: Record<string, string>
  /** The fake updater: what it prints, its exit code, and the Claude Code version it leaves behind. */
  readonly update?: { readonly chunks: ReadonlyArray<string>; readonly code: number; readonly leaves?: string }
  /** `start` throws this, as Bun.spawn does for a program Windows refuses. */
  readonly refuse?: string
  /** What `list` finds in a folder; the test changes it while the update runs. */
  readonly folders?: Record<string, Array<{ readonly name: string; readonly size: number }>>
  readonly listings?: Record<string, unknown>
}

function fakeSystem(options: FakeOptions = {}) {
  const versions: Record<string, string> = {
    [`${CLAUDE} --version`]: "2.1.282 (Claude Code)",
    [`${GIT} --version`]: "git version 2.55.0.windows.3",
    [`${GIT} lfs version`]: "git-lfs/3.7.1 (GitHub; windows amd64; go 1.25.1; git b84b3384)",
    [`${GH} --version`]: "gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0",
    ...options.versions,
  }
  const which: Record<string, string> = options.which ?? { claude: CLAUDE, git: GIT, gh: GH }
  const files = new Set(options.files ?? [CLAUDE, LFS])
  const listings = options.listings ?? LISTINGS
  const calls = {
    fetched: [] as string[],
    headers: [] as Record<string, string>[],
    reads: [] as { argv: ReadonlyArray<string>; env: Readonly<Record<string, string>> }[],
    started: [] as { argv: ReadonlyArray<string>; env: Readonly<Record<string, string>> }[],
    killed: 0,
  }
  const release = { done: undefined as (() => void) | undefined, kill: undefined as (() => void) | undefined }
  const folders = options.folders ?? {}
  const system: ToolUpdatesModule.System = {
    platform: "win32",
    env: { ...ENV, ...options.env },
    which: (name) => which[name] ?? null,
    exists: async (file) => files.has(file),
    read: async (argv, env) => {
      calls.reads.push({ argv, env })
      return versions[argv.join(" ")]
    },
    start: (argv, env, output) => {
      calls.started.push({ argv, env })
      if (options.refuse) throw new Error(options.refuse)
      const update = options.update ?? { chunks: ["Checking for updates...\n", "Updated to 2.1.320\n"], code: 0, leaves: "2.1.320" }
      const [first, ...rest] = update.chunks
      const exited = new Promise<number>((resolve) => {
        // `finish()`: the rest of the output, then the exit.
        release.done = () => {
          rest.forEach(output)
          if (update.leaves) versions[`${CLAUDE} --version`] = `${update.leaves} (Claude Code)`
          resolve(update.code)
        }
        release.kill = () => resolve(1)
      })
      if (first) output(first)
      return {
        exited,
        kill: () => {
          calls.killed += 1
          release.kill?.()
        },
      }
    },
    fetch: async (url, init) => {
      calls.fetched.push(url)
      calls.headers.push((init.headers ?? {}) as Record<string, string>)
      const body = listings[url]
      return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body)
    },
    list: async (folder) => [...(folders[folder] ?? [])],
  }
  return { system, calls, folders, finish: () => release.done?.() }
}

async function setup(
  options: FakeOptions & { readonly endpoints?: Record<string, string>; readonly system?: ToolUpdatesModule.System } = {},
) {
  const t = await testDeps({
    control: true,
    options: { endpoints: options.endpoints ?? { npmRegistry: NPM, githubApi: GITHUB } },
  })
  await t.deps.runtime.registry.write(await registryWith([]))
  const fake = fakeSystem(options)
  const handlers = ToolUpdatesRpc.handlers(t.deps, options.system ?? fake.system)
  const ok = <N extends RpcTypes.MethodName>(value: unknown) => {
    if (failure(value)) throw new Error(`expected an answer, got ${JSON.stringify(value)}`)
    return value as RpcTypes.Output<N>
  }
  return {
    t,
    fake,
    view: async (refresh = false) =>
      ok<"tools.view">(await handlers["tools.view"](refresh ? { refresh } : {}, rpcContext<"tools.view">())),
    settings: async (checkLatest: boolean) =>
      ok<"tools.settings.set">(await handlers["tools.settings.set"]({ checkLatest }, rpcContext<"tools.settings.set">())),
    plan: (component: ToolUpdates.Component) =>
      handlers["tools.update.plan"]({ component }, rpcContext<"tools.update.plan">()),
    execute: (nonce: string) =>
      handlers["tools.update.execute"]({ nonce: nonce as never }, rpcContext<"tools.update.execute">()),
    status: (id: string, from?: number) =>
      handlers["tools.update.status"]({ id, ...(from === undefined ? {} : { from }) }, rpcContext<"tools.update.status">()),
    ok,
    /** The job once it ended (its version is read again first), from `from`. */
    /** The job once `until` holds (a measurement is asynchronous after a clock advance). */
    async when(id: string, until: (job: ToolUpdates.Job) => boolean) {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const job = ok<"tools.update.status">(
          await handlers["tools.update.status"]({ id, from: 0 }, rpcContext<"tools.update.status">()),
        )
        if (until(job)) return job
        await Bun.sleep(10)
      }
      throw new Error("the job never matched")
    },
    async ended(id: string, from?: number) {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const job = ok<"tools.update.status">(
          await handlers["tools.update.status"]({ id, ...(from === undefined ? {} : { from }) }, rpcContext<"tools.update.status">()),
        )
        if (job.state !== "running") return job
        await Bun.sleep(10)
      }
      throw new Error("the update did not end")
    },
    async [Symbol.asyncDispose]() {
      await t[Symbol.asyncDispose]()
    },
  }
}

const item = (view: ToolUpdates.View, id: ToolUpdates.Component) => view.items.find((entry) => entry.id === id)!

describe("tools.view", () => {
  test("this PC as on 2026-11-04: Claude Code is recommended for the SDK's version and updates itself; Git, git-lfs and gh are manual", async () => {
    await using s = await setup()
    const view = await s.view()
    expect(view.checkLatest).toBe(true)
    expect(view.failed).toEqual([])
    expect(view.hostGitLfs).toBe(ToolUpdates.HOST_GIT_LFS)
    expect(view.items.map((entry) => entry.id)).toEqual(["claude-code", "git", "git-lfs", "gh", "ripgrep"])
    expect(item(view, "claude-code")).toEqual({
      id: "claude-code",
      path: CLAUDE,
      installed: "2.1.282",
      latest: "2.1.320",
      minimum: "2.1.248",
      recommended: "2.1.301",
      status: "recommended",
      why: "claude_sdk",
      threshold: "2.1.301",
      update: { type: "run", argv: [CLAUDE, "update"], command: "claude update", source: ToolUpdatesModule.SOURCES.claudeCode },
    })
    expect(item(view, "git")).toMatchObject({
      installed: "2.55.0.windows.3",
      latest: "2.56.0.windows.1",
      status: "recommended",
      why: "newer",
      update: { type: "manual", why: "elevation", command: "git update-git-for-windows" },
    })
    // Git for Windows' own git-lfs changes with Git; 3.7.1 misses the CVE fixes of the hosts' 3.8.1.
    expect(item(view, "git-lfs")).toMatchObject({
      path: LFS,
      installed: "3.7.1",
      status: "recommended",
      why: "lfs_security",
      update: { type: "manual", why: "bundled", command: "git update-git-for-windows" },
    })
    expect(item(view, "gh")).toMatchObject({
      installed: "2.101.0",
      status: "current",
      update: { type: "manual", why: "elevation", command: "winget upgrade --id GitHub.cli -e" },
    })
    // No ripgrep on PATH: core's pinned download runs, nothing to update here and no release read.
    expect(item(view, "ripgrep")).toMatchObject({ path: null, installed: null, status: "current", why: "own_copy" })
    expect(s.fake.calls.fetched.some((url) => url.includes("ripgrep"))).toBe(false)
    expect(view.servers).toEqual([])
  })

  test("versions and listings are read without credentials and with only the system variables", async () => {
    await using s = await setup()
    await s.view()
    expect(s.fake.calls.fetched.every((url) => url.startsWith(NPM) || url.startsWith(GITHUB))).toBe(true)
    for (const headers of s.fake.calls.headers)
      expect(Object.keys(headers).map((name) => name.toLowerCase()).filter((name) => name === "authorization")).toEqual([])
    // The system variables, plus Claude Code's telemetry switches and the emptied user and PC names (decisions TLM).
    const added = ["COMPUTERNAME", "LOGONSERVER", "USERDOMAIN", "USERNAME", ...Object.keys(ClaudeQuiet.FLAGS)]
    for (const read of s.fake.calls.reads) {
      expect(Object.keys(read.env).filter((name) => !added.includes(name)).sort()).toEqual([
        "PATH",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "SystemRoot",
        "TEMP",
        "USERPROFILE",
      ])
      expect(read.env).toMatchObject({ ...ClaudeQuiet.FLAGS, USERNAME: "", COMPUTERNAME: "" })
    }
  })

  test("the releases are read once a day; 지금 확인 after five minutes; never with the switch off", async () => {
    await using s = await setup()
    await s.view()
    const first = s.fake.calls.fetched.length
    expect(first).toBe(4)
    await s.view()
    await s.view(true)
    expect(s.fake.calls.fetched).toHaveLength(first)
    s.t.clock.advance(ToolUpdates.REFRESH_MS)
    await s.view(true)
    expect(s.fake.calls.fetched).toHaveLength(first * 2)
    s.t.clock.advance(ToolUpdates.CHECK_EVERY_MS - ToolUpdates.REFRESH_MS)
    await s.view()
    expect(s.fake.calls.fetched).toHaveLength(first * 2)
    s.t.clock.advance(ToolUpdates.REFRESH_MS)
    await s.view()
    expect(s.fake.calls.fetched).toHaveLength(first * 3)

    const off = await s.settings(false)
    expect(off.checkLatest).toBe(false)
    expect(off.items.every((entry) => entry.latest === null)).toBe(true)
    expect(item(off, "claude-code")).toMatchObject({ status: "recommended", why: "claude_sdk" })
    s.t.clock.advance(ToolUpdates.CHECK_EVERY_MS * 2)
    await s.view(true)
    expect(s.fake.calls.fetched).toHaveLength(first * 3)
    const file = await Bun.file(s.t.deps.runtime.layout.toolUpdates).json()
    expect(file.checkLatest).toBe(false)
  })

  test("a listing that fails keeps the last answer and names the component", async () => {
    await using s = await setup()
    await s.view()
    const listings = { ...LISTINGS }
    delete listings[`${NPM}/-/package/@anthropic-ai/claude-code/dist-tags`]
    await using broken = await setup({ listings })
    const view = await broken.view()
    expect(view.failed).toEqual(["claude-code"])
    expect(item(view, "claude-code").latest).toBeNull()
  })

  test("test endpoints without listing overrides never reach npm or GitHub", async () => {
    await using s = await setup({ endpoints: { codex: "http://127.0.0.1:9/codex" } })
    const view = await s.view()
    expect(s.fake.calls.fetched).toEqual([])
    expect(view.items.every((entry) => entry.latest === null)).toBe(true)
  })

  test("Claude Code: not installed, too old, a .cmd launcher, installed for all users", async () => {
    {
      await using s = await setup({ which: { git: GIT }, files: [] })
      expect(item(await s.view(), "claude-code")).toMatchObject({
        path: null,
        status: "missing",
        why: "not_installed",
        update: { type: "manual", why: "not_installed" },
      })
      const refused = failure(await s.plan("claude-code"))
      expect(refused?.type).toBe("tool_not_updatable")
      expect(refused?.data).toEqual({ component: "claude-code", reason: "missing" })
    }
    {
      await using s = await setup({ versions: { [`${CLAUDE} --version`]: "2.1.200 (Claude Code)" } })
      expect(item(await s.view(), "claude-code")).toMatchObject({ status: "required", why: "claude_verbatim" })
    }
    {
      const npm = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"
      await using s = await setup({ which: { claude: npm, git: GIT }, versions: { [`${npm} --version`]: "2.1.301 (Claude Code)" } })
      expect(item(await s.view(), "claude-code").update).toEqual({
        type: "manual",
        why: "script",
        command: "claude update",
        source: ToolUpdatesModule.SOURCES.claudeCode,
      })
    }
    {
      const shared = "C:\\Program Files\\Claude\\claude.exe"
      await using s = await setup({ which: { claude: shared }, versions: { [`${shared} --version`]: "2.1.301 (Claude Code)" } })
      expect(item(await s.view(), "claude-code").update).toMatchObject({ type: "manual", why: "elevation" })
      expect(failure(await s.plan("claude-code"))?.data).toEqual({ component: "claude-code", reason: "manual" })
    }
  })

  test("OPENCODE_CLAUDE_PATH wins like in core's provider; without PATH the native install is found", async () => {
    {
      const custom = "D:\\tools\\claude.exe"
      await using s = await setup({ env: { OPENCODE_CLAUDE_PATH: custom }, versions: { [`${custom} --version`]: "2.1.301 (Claude Code)" } })
      expect(item(await s.view(), "claude-code")).toMatchObject({ path: custom, installed: "2.1.301" })
    }
    {
      await using s = await setup({ which: { git: GIT } })
      expect(item(await s.view(), "claude-code")).toMatchObject({ path: CLAUDE, installed: "2.1.282" })
    }
  })

  test("a git-lfs of its own, a ripgrep on PATH, Git for one user, and a local github-mcp-server", async () => {
    const userGit = "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe"
    const lfs = "C:\\Program Files\\Git LFS\\git-lfs.exe"
    const rg = "C:\\Users\\me\\scoop\\shims\\rg.exe"
    await using s = await setup({
      which: { git: userGit, "git-lfs": lfs, rg },
      files: [lfs],
      versions: {
        [`${userGit} --version`]: "git version 2.41.0.windows.1",
        [`${userGit} lfs version`]: "git-lfs/3.8.1 (GitHub; windows amd64; go 1.25.1)",
        [`${rg} --version`]: "ripgrep 14.1.1 (rev 4649aa9700)",
      },
    })
    await s.t.deps.runtime.registry.write(await registryWith([]))
    const view = await s.view()
    expect(item(view, "git")).toMatchObject({ status: "recommended", why: "git_sparse", update: { why: "interactive" } })
    expect(item(view, "git-lfs")).toMatchObject({ path: lfs, installed: "3.8.1", status: "current", update: { why: "elevation" } })
    expect(item(view, "ripgrep")).toMatchObject({ path: rg, installed: "14.1.1", status: "recommended", why: "rg_pinned" })
    expect(view.items.some((entry) => entry.id === "github-mcp-server")).toBe(false)
  })

  // Git for Windows 2.56 moved git and git-lfs from `mingw64\bin` to `ucrt64\bin`; `cmd` keeps launchers.
  test("Git for Windows' git-lfs follows Git in `mingw64` (up to 2.55) and `ucrt64` (2.56), from any git", async () => {
    const root = "C:\\Program Files\\Git"
    const bundled = { type: "manual", why: "bundled", command: "git update-git-for-windows" }
    for (const prefix of ["mingw64", "ucrt64"]) {
      const lfs = `${root}\\${prefix}\\bin\\git-lfs.exe`
      {
        // `cmd` on PATH and no git-lfs there: the real program inside the Git folder.
        await using s = await setup({ files: [CLAUDE, lfs] })
        expect(item(await s.view(), "git-lfs")).toMatchObject({ path: lfs, installed: "3.7.1", update: bundled })
      }
      {
        // git found as the program itself, git-lfs on PATH as `cmd`'s launcher: the same Git folder.
        const git = `${root}\\${prefix}\\bin\\git.exe`
        const launcher = `${root}\\cmd\\git-lfs.exe`
        await using s = await setup({
          which: { claude: CLAUDE, git, "git-lfs": launcher, gh: GH },
          files: [CLAUDE, launcher, lfs],
          versions: {
            [`${git} --version`]: "git version 2.56.0.windows.4",
            [`${git} lfs version`]: "git-lfs/3.8.1 (GitHub; windows amd64; go 1.25.3)",
          },
        })
        const view = await s.view()
        expect(item(view, "git")).toMatchObject({ path: git, installed: "2.56.0.windows.4" })
        expect(item(view, "git-lfs")).toMatchObject({ path: launcher, installed: "3.8.1", update: bundled })
      }
    }
  })

  test("github-mcp-server shows up only when 설정 > GitHub runs a local one, with the version its tools came from", async () => {
    await using s = await setup()
    const server = "D:\\tools\\github-mcp-server.exe"
    await Bun.write(
      s.t.deps.runtime.layout.github,
      JSON.stringify({
        version: 1,
        accounts: [],
        projects: [],
        sessions: [],
        settings: { server: { type: "local", command: server, args: ["stdio"] }, toolsets: ["repos"], git: true },
        catalog: { at: 1, key: "k", server: "github-mcp-server 2.0.3", tools: [] },
      }),
    )
    const view = await s.view()
    expect(item(view, "github-mcp-server")).toMatchObject({
      path: server,
      installed: "2.0.3",
      latest: "2.1.0",
      reviewed: "2.0.3",
      status: "recommended",
      why: "newer",
      update: { type: "manual", why: "no_updater", source: ToolUpdatesModule.SOURCES.githubMcp },
    })
  })

  test("local model servers on this PC show their version; a server elsewhere is not asked", async () => {
    await using s = await setup({
      listings: { ...LISTINGS, "http://127.0.0.1:11434/api/version": { version: "0.12.6" } },
    })
    await s.t.deps.runtime.registry.write(
      await registryWith([
        { kind: "compat", label: "Ollama", slug: "olla", baseURL: "http://127.0.0.1:11434/v1" },
        { kind: "compat", label: "LM Studio", slug: "lmst", baseURL: "http://localhost:1234/v1" },
        { kind: "compat", label: "Remote", slug: "rmte", baseURL: "https://models.example.com/v1" },
      ]),
    )
    const view = await s.view()
    expect(view.servers).toEqual([
      { label: "Ollama", url: "http://127.0.0.1:11434", version: "0.12.6" },
      { label: "LM Studio", url: "http://localhost:1234", version: null },
    ])
    expect(s.fake.calls.fetched.some((url) => url.includes("example.com"))).toBe(false)
  })
})

describe("tools.update", () => {
  test("plan shows the exact command; execute runs it once, streams its output and reads the version again", async () => {
    await using s = await setup()
    await s.view()
    const plan = s.ok<"tools.update.plan">(await s.plan("claude-code"))
    expect(plan).toMatchObject({
      component: "claude-code",
      command: "claude update",
      argv: [CLAUDE, "update"],
      source: ToolUpdatesModule.SOURCES.claudeCode,
      installed: "2.1.282",
      latest: "2.1.320",
    })
    // Planning runs nothing.
    expect(s.fake.calls.started).toEqual([])
    const job = s.ok<"tools.update.execute">(await s.execute(plan.nonce))
    expect(job).toMatchObject({ component: "claude-code", command: "claude update", state: "running", before: "2.1.282" })
    expect(s.fake.calls.started.map((call) => call.argv)).toEqual([[CLAUDE, "update"]])
    expect(Object.keys(s.fake.calls.started[0]!.env)).not.toContain("ANTHROPIC_API_KEY")
    expect(Object.keys(s.fake.calls.started[0]!.env)).not.toContain("CLAUDE_CONFIG_DIR")
    expect(Object.keys(s.fake.calls.started[0]!.env)).not.toContain("OPENCODE_SERVER_PASSWORD")
    expect(job.output).toBe("Checking for updates...\n")

    // A second plan or execute while it runs is refused; the nonce is spent.
    expect(failure(await s.plan("claude-code"))?.type).toBe("tool_busy")
    expect(failure(await s.execute(plan.nonce))?.type).toBe("tool_busy")

    const early = s.ok<"tools.update.status">(await s.status(job.id, job.length))
    expect(early).toMatchObject({ state: "running", output: "", from: job.length })
    s.fake.finish()
    const done = await s.ended(job.id, job.length)
    expect(done).toMatchObject({ state: "done", exitCode: 0, before: "2.1.282", after: "2.1.320", output: "Updated to 2.1.320\n" })
    expect(s.ok<"tools.update.status">(await s.status(job.id)).output).toBe("Checking for updates...\nUpdated to 2.1.320\n")
    expect(failure(await s.execute(plan.nonce))?.type).toBe("nonce_invalid")

    const after = await s.view()
    expect(item(after, "claude-code")).toMatchObject({ installed: "2.1.320", status: "current" })
    expect(after.job).toMatchObject({ id: job.id, state: "done" })
    expect(failure(await s.status("other"))?.type).toBe("tool_job_not_found")
  })

  test("a failing updater ends failed with its exit code; the version stays", async () => {
    await using s = await setup({ update: { chunks: ["error: network\n"], code: 1 } })
    const plan = s.ok<"tools.update.plan">(await s.plan("claude-code"))
    const job = s.ok<"tools.update.execute">(await s.execute(plan.nonce))
    s.fake.finish()
    expect(await s.ended(job.id)).toMatchObject({ state: "failed", exitCode: 1, after: "2.1.282", output: "error: network\n" })
  })

  test("a program Windows refuses to start ends blocked; nothing is retried or worked around", async () => {
    await using s = await setup({ refuse: "spawn EUNKNOWN: unknown error, uv_spawn" })
    const plan = s.ok<"tools.update.plan">(await s.plan("claude-code"))
    const job = s.ok<"tools.update.execute">(await s.execute(plan.nonce))
    expect(job).toMatchObject({ state: "blocked", exitCode: null, after: "2.1.282" })
    expect(job.output).toContain("EUNKNOWN")
    expect(s.fake.calls.started).toHaveLength(1)
  })

  test("the time and the native updater's download size while it runs; a leftover temporary file is not this download", async () => {
    const versions = ToolUpdatesModule.claudeVersions(ENV)!
    expect(versions).toBe(path.join(HOME, ".local", "share", "claude", "versions"))
    const folders = { [versions]: [{ name: "2.1.282", size: 344_000_000 }, { name: "2.1.300.tmp.11.1700000000000.0", size: 5_000 }] }
    await using s = await setup({ folders, update: { chunks: ["Updating to 2.1.319...\n"], code: 0, leaves: "2.1.319" } })
    const plan = s.ok<"tools.update.plan">(await s.plan("claude-code"))
    const job = s.ok<"tools.update.execute">(await s.execute(plan.nonce))
    expect(job).toMatchObject({ state: "running", elapsed: 0 })
    expect(job.download).toBeUndefined()

    // Before the download starts only the time moves; the earlier run's temporary file is ignored.
    s.t.clock.advance(1_000)
    expect(await s.when(job.id, (current) => current.elapsed === 1_000)).not.toHaveProperty("download")

    folders[versions].push({ name: "2.1.319", size: 0 }, { name: "2.1.319.tmp.4242.1762560000000.0", size: 128_000_000 })
    s.t.clock.advance(1_000)
    expect(await s.when(job.id, (current) => current.download !== undefined)).toMatchObject({
      elapsed: 2_000,
      download: { version: "2.1.319", bytes: 128_000_000 },
    })
    folders[versions][3] = { name: "2.1.319.tmp.4242.1762560000000.0", size: 300_000_000 }
    s.t.clock.advance(1_000)
    expect(await s.when(job.id, (current) => current.download?.bytes === 300_000_000)).toMatchObject({ elapsed: 3_000 })
    // A card opened again (the dialog closed meanwhile) follows the same job from its start.
    expect(failure(await s.plan("claude-code"))?.data).toEqual({ id: job.id })
    expect((await s.view()).job).toMatchObject({ id: job.id, state: "running", download: { bytes: 300_000_000 } })

    // Renamed when it is complete: the last measurement reads the finished file.
    folders[versions].splice(1, 3, { name: "2.1.319", size: 344_807_072 })
    s.t.clock.advance(2_000)
    s.fake.finish()
    expect(await s.ended(job.id)).toMatchObject({
      state: "done",
      exitCode: 0,
      after: "2.1.319",
      elapsed: 5_000,
      download: { version: "2.1.319", bytes: 344_807_072 },
    })
    // Measuring and the hour's stop ended with the job.
    expect(s.t.clock.pending()).toBe(0)
  })

  test("without the native versions folder (an npm install) the job carries the time only", async () => {
    await using s = await setup({ env: { USERPROFILE: "C:\\Users\\npm" } })
    const plan = s.ok<"tools.update.plan">(await s.plan("claude-code"))
    const job = s.ok<"tools.update.execute">(await s.execute(plan.nonce))
    s.t.clock.advance(65_000)
    expect(await s.when(job.id, (current) => current.elapsed === 65_000)).not.toHaveProperty("download")
    s.fake.finish()
    const done = await s.ended(job.id)
    expect(done).toMatchObject({ state: "done", elapsed: 65_000 })
    expect(done.download).toBeUndefined()
  })

  test("an update still running after an hour is stopped and says so; never sooner", async () => {
    await using s = await setup({ update: { chunks: ["Updating to 2.1.319...\n"], code: 0 } })
    const plan = s.ok<"tools.update.plan">(await s.plan("claude-code"))
    const job = s.ok<"tools.update.execute">(await s.execute(plan.nonce))
    s.t.clock.advance(ToolUpdates.SLOW_MS)
    s.t.clock.advance(ToolUpdates.TIMEOUT_MS - ToolUpdates.SLOW_MS - 1)
    expect(s.fake.calls.killed).toBe(0)
    expect(s.ok<"tools.update.status">(await s.status(job.id))).toMatchObject({ state: "running" })
    s.t.clock.advance(1)
    expect(s.fake.calls.killed).toBe(1)
    expect(await s.ended(job.id)).toMatchObject({
      state: "failed",
      timedOut: true,
      exitCode: 1,
      after: "2.1.282",
      elapsed: ToolUpdates.TIMEOUT_MS,
    })
  })

  test("a fake claude acting like the native updater: the growing temporary file, then the new version", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-fake-claude-")))
    const home = path.join(root, "home")
    // Never started: the system below runs fake-claude.ts with Bun in its place.
    const claude = path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude")
    const real = ToolUpdatesModule.production()
    const swap = (argv: ReadonlyArray<string>) =>
      argv[0] === claude ? [process.execPath, path.join(import.meta.dir, "fake-claude.ts"), ...argv.slice(1)] : argv
    const system: ToolUpdatesModule.System = {
      ...real,
      env: { ...ToolUpdatesModule.environment(process.env), USERPROFILE: home, HOME: home },
      which: (name) => (name === "claude" ? claude : null),
      exists: async () => false,
      read: async (argv, env) => (argv[0] === claude ? real.read(swap(argv), env) : undefined),
      start: (argv, env, output) => real.start(swap(argv), env, output),
      fetch: async () => new Response("not found", { status: 404 }),
    }
    try {
      await using s = await setup({ system })
      expect(item(await s.view(), "claude-code")).toMatchObject({ path: claude, installed: "2.1.282" })
      const plan = s.ok<"tools.update.plan">(await s.plan("claude-code"))
      const job = s.ok<"tools.update.execute">(await s.execute(plan.nonce))
      const versions = path.join(home, ".local", "share", "claude", "versions")
      const deadline = Date.now() + 20_000
      const written = async (): Promise<void> => {
        const files = await fs.readdir(versions).catch(() => [] as string[])
        const temporary = files.find((name) => name.startsWith("2.1.319.tmp."))
        if (temporary && (await fs.stat(path.join(versions, temporary))).size === 1024 * 1024) return
        if (Date.now() > deadline) throw new Error("the fake updater wrote nothing")
        await Bun.sleep(20)
        return written()
      }
      await written()
      s.t.clock.advance(1_000)
      expect(await s.when(job.id, (current) => current.download !== undefined)).toMatchObject({
        state: "running",
        elapsed: 1_000,
        download: { version: "2.1.319", bytes: 1024 * 1024 },
      })
      await Bun.write(path.join(home, "fake-claude-continue"), "")
      const done = await s.ended(job.id)
      expect(done).toMatchObject({
        state: "done",
        exitCode: 0,
        before: "2.1.282",
        after: "2.1.319",
        download: { version: "2.1.319", bytes: 3 * 1024 * 1024 },
      })
      expect(done.output).toContain("Updating to 2.1.319...")
      expect(done.output).toContain("Successfully updated from 2.1.282 to version 2.1.319")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("manual components have no plan", async () => {
    await using s = await setup()
    for (const component of ["git", "git-lfs", "gh", "ripgrep"] as const)
      expect(failure(await s.plan(component))?.data).toEqual({ component, reason: "manual" })
  })

  test("a remote service refuses every tools.* method", () => {
    for (const method of ["tools.view", "tools.settings.set", "tools.update.plan", "tools.update.execute", "tools.update.status"])
      expect(Register.REMOTE_MANAGED as ReadonlyArray<string>).toContain(method)
  })
})

describe("ToolUpdatesModule helpers", () => {
  test("Program Files and Windows count as installed for all users", () => {
    expect(ToolUpdatesModule.protectedPath(GIT, ENV)).toBe(true)
    expect(ToolUpdatesModule.protectedPath("c:\\program files (x86)\\x\\y.exe", ENV)).toBe(true)
    expect(ToolUpdatesModule.protectedPath(CLAUDE, ENV)).toBe(false)
    expect(ToolUpdatesModule.protectedPath("C:\\Program Files Extra\\x.exe", ENV)).toBe(false)
  })

  test("the environment keeps system variables only, with Claude Code's telemetry off and no user or PC name", () => {
    expect(
      ToolUpdatesModule.environment({ ...ENV, USERNAME: "someone", COMPUTERNAME: "PC", CLAUDE_CODE_ENABLE_TELEMETRY: "1" }),
    ).toEqual({
      USERPROFILE: HOME,
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      SystemRoot: "C:\\Windows",
      PATH: ENV.PATH,
      TEMP: ENV.TEMP,
      USERNAME: "",
      USERDOMAIN: "",
      LOGONSERVER: "",
      COMPUTERNAME: "",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DO_NOT_TRACK: "1",
      DISABLE_GROWTHBOOK: "1",
      DISABLE_BUG_COMMAND: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    })
  })

  test("the real starter streams a child's stdout and stderr and its exit code (a Bun one-liner, no update)", async () => {
    const chunks: string[] = []
    const script = "console.log('one'); console.error('two'); process.exit(3)"
    const started = ToolUpdatesModule.production().start(
      [process.execPath, "-e", script],
      ToolUpdatesModule.environment(process.env),
      (text) => chunks.push(text),
    )
    expect(await started.exited).toBe(3)
    expect(chunks.join("")).toContain("one")
    expect(chunks.join("")).toContain("two")
    const read = await ToolUpdatesModule.production().read(
      [process.execPath, "--version"],
      ToolUpdatesModule.environment(process.env),
    )
    expect(ToolUpdates.parse(read ?? "")?.text).toBe(Bun.version)
    expect(path.isAbsolute(process.execPath)).toBe(true)
  })
})
