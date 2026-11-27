// GitHub on an SSH host through this PC (16 §8, GH-37..GH-44): the accounts and choices of a host's folders and
// conversations (its team areas through the main checkout the host read), the PC's side of the broker methods
// (`GitHubRelay.offer`, `account`, `call`) and of the git relay (`GitHubRelay.gate`), the host's module
// (`GitHubRemote`: its tools, the write ask in the host's conversation, the git variables of its shells), real git
// through the host's stub and the PC's egress relay to a fake GitHub (the token only between the PC and the fake), and
// the Linux caller check on a fake `/proc`; the review fixes GH-45..GH-51: what GitHub's answers may carry back, the LFS
// batch as read, the one `service`, tickets held to their command, the per-host write allowance, the full mask of
// relayed results. No SSH: both sides run in this process; the fake-SSH end to end is
// `test/remote/e2e/github-relay.test.ts`. Fake tokens only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHmac } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Tool } from "@opencode/schema/tool"
import { Broker } from "@own/protocol"
import { GitHubBridge } from "@own/runtime"
import { Egress } from "../../src/broker/egress.js"
import { GitHubCommands } from "../../src/github/commands.js"
import { GitHubCredential } from "../../src/github/credential.js"
import { GitHubMask } from "../../src/github/mask.js"
import { GitHubMcp } from "../../src/github/mcp.js"
import { GitHubProc } from "../../src/github/proc.js"
import { GitHubRelay } from "../../src/github/relay.js"
import { GitHubRelayStub } from "../../src/github/relay-stub.js"
import { GitHubRemote } from "../../src/github/remote.js"
import { GitHubStore } from "../../src/github/store.js"
import type { GitHubTools } from "../../src/github/tools.js"
import { Logger } from "../../src/logger.js"
import type { RemoteHost } from "../../src/remote/host.js"
import { GitHubRpc } from "../../src/rpc/github.js"
import { startFakeGitHub, type Echo as FakeGitHubEcho, type FakeGitHub } from "../e2e-kit/fakes/github.js"
import { removeTree } from "../e2e-kit/harness/remove.js"
import { call, ok } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"
import { lfsRepo, scrubbedGit, sshRecorder } from "./git.js"

// Real git and Bun servers on a busy PC.
setDefaultTimeout(60_000)

const WORK = "ghp_fakeRemoteWork00000000000000000000Gh11"
const HOME_TOKEN = "github_pat_11FAKEREMOTE0_fakeRemoteHome000000000000000000000Gh22"
const HOST = "h-ab12cd"
const OTHER_HOST = "h-ef34gh"
const DAY = 24 * 60 * 60_000

const fixture: { github?: FakeGitHub; root?: string } = {}

beforeAll(async () => {
  fixture.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-github-remote-")))
  fixture.github = startFakeGitHub({
    accounts: {
      [WORK]: { login: "octo-work", scopes: "repo" },
      [HOME_TOKEN]: { login: "octo-home" },
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

/** This PC's control instance with the two accounts (회사 = work, the default; 개인 = home), the tool list read. */
async function pc() {
  const control = await testDeps({
    control: true,
    ctx: { session: { get: async () => undefined } },
    options: { endpoints: github().endpoints } as never,
  })
  const rpc = GitHubRpc.handlers(control.deps)
  const work = (await ok(rpc["github.add.token"], { token: WORK, label: "회사" })).accounts[0]!.id
  const view = await ok(rpc["github.add.token"], { token: HOME_TOKEN, label: "개인" })
  const home = view.accounts.find((item) => item.label === "개인")!.id
  await until(async () => (await GitHubStore.file(control.deps).read()).catalog !== undefined)
  return {
    control,
    deps: control.deps,
    rpc,
    ids: { work, home },
    [Symbol.asyncDispose]: () => control[Symbol.asyncDispose](),
  }
}

describe("the choices of an SSH host's folders and conversations (16 §8)", () => {
  test("a host's project choice covers that host's folders only; this PC's choices and other hosts' stay apart", async () => {
    await using t = await pc()
    await ok(t.rpc["github.bind"], {
      target: { type: "project", directory: "/home/u/work", host: HOST },
      account: t.ids.home,
    })
    const inside = await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/work/app" })
    expect(inside).toMatchObject({ account: { id: t.ids.home, login: "octo-home", write: false }, source: "project", git: true })
    // A folder beside it (`/home/u/workshop`) is not inside it, another host's same folder is not this host's.
    expect((await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/workshop" })).source).toBe("default")
    expect((await GitHubRelay.account(t.deps, OTHER_HOST, { directory: "/home/u/work" })).account?.id).toBe(t.ids.work)
    // `off` for the host's whole tree keeps GitHub off there, whatever the default.
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/", host: OTHER_HOST }, account: "off" })
    expect(await GitHubRelay.account(t.deps, OTHER_HOST, { directory: "/srv/x" })).toMatchObject({ source: "off", git: true })
    expect((await GitHubRelay.account(t.deps, OTHER_HOST, { directory: "/srv/x" })).account).toBeUndefined()
    const view = await ok(t.rpc["github.view"], { directory: "/home/u/work/app", host: HOST })
    expect(view.inUse).toMatchObject({ account: t.ids.home, source: "project", directory: "/home/u/work" })
    // A host's folder is a path there, never a relative one.
    expect(
      await call(t.rpc["github.bind"], { target: { type: "project", directory: "work", host: HOST }, account: t.ids.home }),
    ).toMatchObject({ ok: false, type: "github_invalid", data: { field: "directory" } })
    // Unbinding the host's folder leaves another host's same folder alone.
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/home/u/work", host: OTHER_HOST }, account: t.ids.home })
    const removed = await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/home/u/work/", host: HOST }, account: null })
    expect(removed.projects.map((item) => [item.host, item.directory])).toEqual([
      [OTHER_HOST, "/"],
      [OTHER_HOST, "/home/u/work"],
    ])
  })

  test("a team area of a host follows its project through the main checkout the host read", async () => {
    await using t = await pc()
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/home/u/game", host: HOST }, account: t.ids.home })
    const area = await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/.worktrees/ui", main: "/home/u/game" })
    expect(area).toMatchObject({ account: { id: t.ids.home }, source: "worktree", git: true })
    // The area's own choice wins over its project's.
    await ok(t.rpc["github.bind"], {
      target: { type: "project", directory: "/home/u/.worktrees/ui", host: HOST },
      account: t.ids.work,
    })
    expect(
      (await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/.worktrees/ui", main: "/home/u/game" })).source,
    ).toBe("project")
  })

  test("a host conversation's choice wins; for a week it keeps that folder's commands without a conversation off the folder's account", async () => {
    await using t = await pc()
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/home/u/work", host: HOST }, account: t.ids.home })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_hostconversation01", directory: "/home/u/work", host: HOST },
      account: t.ids.work,
    })
    const chosen = await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/work", root: "ses_hostconversation01" })
    expect(chosen).toMatchObject({ account: { id: t.ids.work }, source: "session", git: true })
    // The same conversation id on this PC or another host is another conversation.
    expect((await GitHubRelay.account(t.deps, OTHER_HOST, { directory: "/home/u/work", root: "ses_hostconversation01" })).source).toBe("default")
    const view = await ok(t.rpc["github.view"], { directory: "/home/u/work", sessionID: "ses_hostconversation01", host: HOST })
    expect(view.inUse).toMatchObject({ account: t.ids.work, source: "session" })
    // A command without a conversation (the review tab's git) gets no login while the choice is recent (GH-14, GH-33).
    expect(await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/work/app" })).toMatchObject({
      account: { id: t.ids.home },
      git: false,
    })
    t.control.clock.advance(8 * DAY)
    expect((await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/work/app" })).git).toBe(true)
    // Git logins off: never.
    await ok(t.rpc["github.settings.set"], { git: false })
    expect((await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/work/app", root: "ses_x" })).git).toBe(false)
  })
})

describe("the host's tools run on this PC (github.offer, github.call)", () => {
  test("the offer of a host folder: reads always, writes only where an account here allows writing and the PC lets the host write", async () => {
    await using t = await pc()
    const before = await GitHubRelay.offer(t.deps, HOST, { directory: "/home/u/work" })
    expect(before.git).toBe(true)
    expect(before.tools.map((tool) => [tool.name, tool.read])).toEqual([
      ["get_me", true],
      ["get_file_contents", true],
      ["list_pull_requests", true],
    ])
    await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
    // The account allows writing, but a host only reads until the PC lets it write (GH-49).
    expect((await GitHubRelay.offer(t.deps, HOST, { directory: "/home/u/work" })).tools.every((tool) => tool.read)).toBe(true)
    expect((await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/work" })).hostWrite).toBe(false)
    expect((await ok(t.rpc["github.settings.set"], { writeHosts: [HOST, HOST] })).settings.writeHosts).toEqual([HOST])
    const after = await GitHubRelay.offer(t.deps, HOST, { directory: "/home/u/work" })
    expect(after.tools.filter((tool) => !tool.read).map((tool) => tool.name)).toEqual([
      "create_pull_request",
      "add_issue_comment",
    ])
    expect((await GitHubRelay.account(t.deps, HOST, { directory: "/home/u/work" })).hostWrite).toBe(true)
    // Another host still reads only.
    expect((await GitHubRelay.offer(t.deps, OTHER_HOST, { directory: "/home/u/work" })).tools.every((tool) => tool.read)).toBe(
      true,
    )
    // A host folder whose choice is a read-only account offers reads only.
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/home/u/play", host: HOST }, account: t.ids.home })
    expect((await GitHubRelay.offer(t.deps, HOST, { directory: "/home/u/play" })).tools.every((tool) => tool.read)).toBe(true)
    await ok(t.rpc["github.settings.set"], { git: false })
    expect((await GitHubRelay.offer(t.deps, HOST, { directory: "/home/u/work" })).git).toBe(false)
  })

  test("a call runs as the place's account, the token cut out; another account, an unoffered tool or a read-only write never run", async () => {
    await using t = await pc()
    const place = { directory: "/home/u/work", root: "ses_hostcall0000000000001" }
    const from = github().mcp.length
    const read = await GitHubRelay.call(t.deps, HOST, { ...place, tool: "get_me", input: {}, account: t.ids.work })
    expect(read).toMatchObject({ isError: false, account: { id: t.ids.work, login: "octo-work", label: "회사" } })
    expect("text" in read && read.text).toContain('"as":"octo-work"')
    // The account the host asked about is no longer the place's: nothing runs (an approval never covers another).
    await ok(t.rpc["github.bind"], { target: { type: "session", sessionID: place.root, host: HOST }, account: t.ids.home })
    expect(await GitHubRelay.call(t.deps, HOST, { ...place, tool: "get_me", input: {}, account: t.ids.work })).toMatchObject({
      error: "account_changed",
    })
    // A write no account here allows is not offered; one the place's account may not do is refused.
    expect(
      await GitHubRelay.call(t.deps, HOST, {
        ...place,
        tool: "create_pull_request",
        input: { owner: "octo", repo: "hello" },
        account: t.ids.home,
      }),
    ).toMatchObject({ error: "unknown_tool" })
    await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
    await ok(t.rpc["github.bind"], {
      target: { type: "session", sessionID: "ses_writer000000000000001", directory: "/home/u/work", host: HOST },
      account: t.ids.work,
    })
    expect(
      await GitHubRelay.call(t.deps, HOST, {
        ...place,
        tool: "create_pull_request",
        input: { owner: "octo", repo: "hello" },
        account: t.ids.home,
      }),
    ).toMatchObject({ error: "read_only" })
    // A writing account on a host the PC lets read only (GH-49): nothing runs until the PC lets that host write.
    const write = {
      directory: "/home/u/work",
      root: "ses_writer000000000000001",
      tool: "create_pull_request",
      input: { owner: "octo", repo: "hello" },
      account: t.ids.work,
    }
    expect(await GitHubRelay.call(t.deps, HOST, write)).toMatchObject({ error: "host_read_only" })
    await ok(t.rpc["github.settings.set"], { writeHosts: [HOST] })
    expect(await GitHubRelay.call(t.deps, HOST, write)).toMatchObject({ isError: false })
    expect(await GitHubRelay.call(t.deps, OTHER_HOST, write)).toMatchObject({ error: "host_read_only" })
    const calls = github().mcp.slice(from).filter((item) => item.method === "tools/call")
    expect(calls.map((item) => [item.login, item.tool])).toEqual([
      ["octo-work", "get_me"],
      ["octo-work", "create_pull_request"],
    ])
    for (const token of [WORK, HOME_TOKEN]) expect(JSON.stringify(read)).not.toContain(token)
  })

  test("a result goes back with every connected account's tokens cut out, not only its own account's (GH-50)", async () => {
    await using t = await pc()
    const basic = Buffer.from(`octo-home:${HOME_TOKEN}`).toString("base64")
    // GitHub's answer quotes the input: another account's token and its git login, and the caller's own token.
    const result = await GitHubRelay.call(t.deps, HOST, {
      directory: "/home/u/work",
      tool: "get_me",
      input: { other: HOME_TOKEN, login: basic, own: WORK },
      account: t.ids.work,
    })
    expect(result).toMatchObject({ isError: false, account: { id: t.ids.work } })
    const text = "text" in result ? result.text : ""
    expect(text).toContain('"as":"octo-work"')
    for (const secret of [WORK, HOME_TOKEN, basic]) expect(text).not.toContain(secret)
  })

  test("a long result is cut before it goes back (frames are 1 MiB)", () => {
    const long = "가".repeat(400_000)
    const cut = GitHubRelay.cut(long)
    expect(Buffer.byteLength(cut)).toBeLessThan(Broker.GITHUB_RESULT_MAX_BYTES + 200)
    expect(cut).toEndWith("on its way to this host]")
    expect(cut).not.toContain("�")
    expect(GitHubRelay.cut("short")).toBe("short")
  })
})

describe("what the git relay takes (GitHubRelay.parse, gate)", () => {
  const parse = (method: string, at: string, lfs?: string) => {
    const url = new URL(at, "http://relay")
    return GitHubRelay.parse({ method, path: url.pathname, search: url.search, ...(lfs === undefined ? {} : { lfs }) })
  }

  test("git's smart HTTP and Git LFS's API of one repository, pushes told apart; anything else refused", () => {
    expect(parse("GET", "/github.com/octo/hello.git/info/refs?service=git-upload-pack")).toEqual({
      site: "github.com",
      repository: "octo/hello",
      rest: "/octo/hello.git/info/refs",
      query: "?service=git-upload-pack",
      operation: "fetch",
    })
    // `info/refs` goes upstream with the one service judged, nothing else (GH-47); the locks list keeps its filters.
    expect(parse("GET", "/github.com/octo/hello.git/info/refs?service=git-upload-pack&x=1")?.query).toBe(
      "?service=git-upload-pack",
    )
    expect(parse("GET", "/github.com/octo/hello.git/info/lfs/locks?path=a.bin")?.query).toBe("?path=a.bin")
    expect(parse("POST", "/github.com/octo/hello/git-upload-pack")?.operation).toBe("fetch")
    expect(parse("GET", "/github.com/octo/hello.git/info/refs?service=git-receive-pack")?.operation).toBe("push")
    expect(parse("POST", "/github.com/octo/hello.git/git-receive-pack")?.operation).toBe("push")
    expect(parse("POST", "/github.com/octo/hello.git/info/lfs/objects/batch", "download")?.operation).toBe("fetch")
    expect(parse("POST", "/github.com/octo/hello.git/info/lfs/objects/batch", "upload")?.operation).toBe("push")
    // A batch whose operation could not be read counts as an upload.
    expect(parse("POST", "/github.com/octo/hello.git/info/lfs/objects/batch")?.operation).toBe("push")
    expect(parse("GET", "/github.com/octo/hello.git/info/lfs/locks")?.operation).toBe("fetch")
    expect(parse("POST", "/github.com/octo/hello.git/info/lfs/locks/verify")?.operation).toBe("push")
    expect(parse("POST", "/github.com/octo/hello.git/info/lfs/locks/123/unlock")?.operation).toBe("push")
    expect(parse("GET", "/ghe.example.com:8443/octo/hello.git/info/refs?service=git-upload-pack")?.site).toBe(
      "ghe.example.com:8443",
    )
    for (const [method, at] of [
      ["GET", "/github.com/octo/hello.git/HEAD"],
      ["GET", "/github.com/octo/hello.git/info/refs"],
      ["GET", "/github.com/octo/hello.git/info/refs?service=git-upload-archive"],
      // Two services: GitHub might read the other one (GH-47).
      ["GET", "/github.com/octo/hello.git/info/refs?service=git-upload-pack&service=git-receive-pack"],
      ["GET", "/github.com/octo/hello.git/git-upload-pack"],
      ["POST", "/github.com/octo/hello.git/info/refs?service=git-upload-pack"],
      ["GET", "/github.com/octo/hello.git/info/lfs/objects/batch"],
      ["GET", "/github.com/octo/../hello.git/info/refs?service=git-upload-pack"],
      ["GET", "/github.com/oc*to/hello.git/info/refs?service=git-upload-pack"],
      ["GET", "/github.com/octo/hello.git/../../user/info/refs?service=git-upload-pack"],
      ["GET", "/github.com/repos/octo/hello/contents/x"],
      ["GET", "/github.com/octo/hello.git/info/refs/x?service=git-upload-pack"],
    ])
      expect(`${method} ${at}: ${JSON.stringify(parse(method!, at!))}`).toBe(`${method} ${at}: undefined`)
  })

  test("the gate: the place's account on its site, its login added here; a read-only push, another site or git off never", async () => {
    await using t = await pc()
    const place = { directory: "/home/u/work", root: "ses_gate0000000000000001" }
    const ask = (method: string, at: string, lfs?: string) => {
      const url = new URL(at, "http://relay")
      return GitHubRelay.gate(t.deps, HOST, {
        method,
        path: url.pathname,
        search: url.search,
        place,
        ...(lfs === undefined ? {} : { lfs }),
      })
    }
    const fetch = await ask("GET", "/github.com/octo/hello.git/info/refs?service=git-upload-pack&evil=1")
    const authorization = `Basic ${Buffer.from(`octo-work:${WORK}`).toString("base64")}`
    expect(fetch).toEqual({
      ok: true,
      upstream: `${github().url}/octo/hello.git/info/refs?service=git-upload-pack`,
      authorization,
      secrets: [...GitHubMask.loginForms("octo-work", WORK), authorization],
      operation: "fetch",
    })
    expect(await ask("GET", "/github.com/octo/hello.git/info/refs?service=git-receive-pack")).toEqual({
      ok: false,
      status: 403,
      code: "read_only",
    })
    expect(await ask("POST", "/github.com/octo/hello.git/info/lfs/objects/batch", "upload")).toMatchObject({ code: "read_only" })
    expect(await ask("GET", "/gitlab.com/octo/hello.git/info/refs?service=git-upload-pack")).toMatchObject({ code: "site" })
    expect(await ask("GET", "/github.com/octo/hello.git/HEAD")).toMatchObject({ status: 404, code: "bad_request" })
    await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
    // A writing account, but the PC has not let this host write (GH-49).
    expect(await ask("POST", "/github.com/octo/hello.git/git-receive-pack")).toEqual({
      ok: false,
      status: 403,
      code: "host_read_only",
    })
    await ok(t.rpc["github.settings.set"], { writeHosts: [HOST] })
    expect(await ask("POST", "/github.com/octo/hello.git/git-receive-pack")).toMatchObject({ ok: true, operation: "push" })
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/home/u", host: HOST }, account: "off" })
    expect(await ask("POST", "/github.com/octo/hello.git/git-upload-pack")).toMatchObject({ code: "off" })
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: "/home/u", host: HOST }, account: null })
    await ok(t.rpc["github.settings.set"], { git: false })
    expect(await ask("POST", "/github.com/octo/hello.git/git-upload-pack")).toMatchObject({ code: "off" })
  })
})

/** A plugin context of a host Location with the parts the host's module uses. */
function hostContext() {
  const transforms: Array<(editor: Editor) => void> = []
  const shellHooks: Array<(event: ShellEvent) => unknown> = []
  const evaluateHooks: Array<(event: Evaluation) => unknown> = []
  const asks: Array<Record<string, unknown>> = []
  const state = { refuse: false, reloads: 0 }
  const ctx = {
    agent: { transform: async () => ({ dispose: async () => {} }) },
    tool: {
      transform: async (callback: (editor: Editor) => void) => {
        transforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {
        state.reloads += 1
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
    session: { get: async () => undefined },
  }
  const tools = () => {
    const added: Added[] = []
    for (const transform of transforms) transform({ namespace: () => undefined, add: (tool) => void added.push(tool as Added) })
    return added
  }
  const shell = async (cwd: string, sessionID?: string, id?: string) => {
    const event: ShellEvent = { cwd, env: {}, timeout: 120_000, ...(sessionID === undefined ? {} : { sessionID }), ...(id === undefined ? {} : { id }) }
    for (const hook of shellHooks) await hook(event)
    return event.env
  }
  const evaluate = async (input: { resources: string[]; saved?: string[] }) => {
    const event: Evaluation = { sessionID: "ses_eval", action: "github.write", effect: "allow", saved: [], ...input }
    for (const hook of evaluateHooks) await hook(event)
    return event.effect
  }
  return { ctx, tools, shell, evaluate, asks, state }
}

interface Editor {
  namespace(namespace: { name: string; description: string }): void
  add(tool: unknown): void
}

interface Added {
  readonly name: string
  readonly description: string
  readonly execute: (input: unknown, context: GitHubTools.Call) => Promise<Tool.Result>
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
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly saved?: ReadonlyArray<string>
  effect: "allow" | "ask" | "deny"
}

/**
 * The host's broker side, in this process: each `github.*` ask answered by this PC's `GitHubRelay` for `HOST`, its
 * result through JSON as a frame would carry it; `reachable: false` answers as a lost link does.
 */
function brokerOf(deps: Awaited<ReturnType<typeof pc>>["deps"], stub: () => string | undefined) {
  const listeners = new Set<() => void>()
  const state = { reachable: true, asked: [] as string[] }
  const api: RemoteHost.GitHub = {
    ask: async (method, params) => {
      state.asked.push(method)
      if (!state.reachable) return { ok: false, error: "unavailable" }
      const result =
        method === "github.offer"
          ? await GitHubRelay.offer(deps, HOST, params as Broker.GitHubOfferGet)
          : method === "github.account"
            ? await GitHubRelay.account(deps, HOST, params as Broker.GitHubPlace)
            : await GitHubRelay.call(deps, HOST, params as Broker.GitHubCall)
      return { ok: true, result: JSON.parse(JSON.stringify(result)) }
    },
    on: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    stub,
  }
  return { api, state, changed: () => listeners.forEach((listener) => listener()) }
}

const context = (sessionID: string) =>
  ({ sessionID, agent: "build", messageID: "msg_test", id: "call_test", signal: new AbortController().signal }) as unknown as GitHubTools.Call

describe("the host's GitHub module (GitHubRemote)", () => {
  test("its tools are the PC's offer; a read runs as the folder's account; a write asks the host's conversation first", async () => {
    await using t = await pc()
    const folder = path.join(fixture.root!, "host-tools")
    await fs.mkdir(folder, { recursive: true })
    const fake = hostContext()
    await using host = await testDeps({ directory: folder, ctx: fake.ctx })
    const broker = brokerOf(t.deps, () => undefined)
    const connection = await GitHubRemote.register(host.deps, broker.api)
    try {
      expect(fake.tools().map((tool) => tool.name)).toEqual(["get_me", "get_file_contents", "list_pull_requests"])
      const from = github().mcp.length
      const read = await fake.tools().find((tool) => tool.name === "get_me")!.execute({}, context("ses_hostread0000000000001"))
      expect(String(read.content)).toStartWith("GitHub account: octo-work (회사)")
      // Writing allowed on the PC, for the account and this host (GH-49): the host offers the write tools once the PC
      // says its GitHub changed.
      await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
      await ok(t.rpc["github.settings.set"], { writeHosts: [HOST] })
      broker.changed()
      await until(async () => fake.tools().some((tool) => tool.name === "create_pull_request"))
      expect(fake.state.reloads).toBeGreaterThan(0)
      const write = fake.tools().find((tool) => tool.name === "create_pull_request")!
      fake.state.refuse = true
      await expect(write.execute({ owner: "octo", repo: "hello", title: "x" }, context("ses_hostwrite000000000001"))).rejects.toThrow(
        "the user declined",
      )
      expect(fake.asks.at(-1)).toMatchObject({
        action: "github.write",
        resources: [`create_pull_request octo/hello as octo-work (${t.ids.work})`],
        save: [`create_pull_request octo/hello as octo-work (${t.ids.work})`],
      })
      fake.state.refuse = false
      const written = await write.execute({ owner: "octo", repo: "hello", title: "x" }, context("ses_hostwrite000000000001"))
      expect(written.metadata).toMatchObject({ github: { login: "octo-work", write: true } })
      const calls = github().mcp.slice(from).filter((item) => item.method === "tools/call")
      expect(calls.map((item) => [item.login, item.tool, item.readOnly])).toEqual([
        ["octo-work", "get_me", true],
        ["octo-work", "create_pull_request", false],
      ])
      // The `evaluate` hook works here as on the PC: an allow without core's saved approval asks.
      expect(await fake.evaluate({ resources: [`create_pull_request octo/hello as octo-work (${t.ids.work})`] })).toBe("ask")
      // A read-only account's write is refused before anything is asked.
      await ok(t.rpc["github.bind"], { target: { type: "session", sessionID: "ses_hostro00000000000001", host: HOST }, account: t.ids.home })
      const asked = fake.asks.length
      await expect(write.execute({ owner: "octo", repo: "hello" }, context("ses_hostro00000000000001"))).rejects.toThrow(
        "allows reading only",
      )
      expect(fake.asks.length).toBe(asked)
      // The PC no longer lets this host write (GH-49): a write still on the list is refused before anything is asked.
      await ok(t.rpc["github.settings.set"], { writeHosts: [] })
      await expect(write.execute({ owner: "octo", repo: "hello" }, context("ses_hostwrite000000000001"))).rejects.toThrow(
        "only read on GitHub",
      )
      expect(fake.asks.length).toBe(asked)
      // The link to the PC is down: the call says so, nothing runs.
      broker.state.reachable = false
      await expect(
        fake.tools().find((tool) => tool.name === "get_me")!.execute({}, context("ses_hostread0000000000001")),
      ).rejects.toThrow("could not reach the PC's GitHub connection")
    } finally {
      await connection.stop()
    }
  })

  test("a command's ticket belongs to the process its start named: one that exec's into a stolen ticket is refused, even first (GH-48)", async () => {
    await using t = await pc()
    const folder = path.join(fixture.root!, "host-bound")
    await fs.mkdir(folder, { recursive: true })
    const fake = hostContext()
    await using host = await testDeps({ directory: folder, ctx: fake.ctx })
    const broker = brokerOf(t.deps, () => "http://127.0.0.1:1")
    // A fake /proc: each process's parent, start time and environment (`exec` rewrites the environment, not the rest).
    const processes = new Map<number, { readonly ppid: number; readonly start: number; readonly environ: string }>()
    const proc: GitHubProc.Proc = {
      read: (file) => {
        const match = /^\/proc\/(\d+)\/(stat|environ)$/.exec(file)
        const item = match ? processes.get(Number(match[1])) : undefined
        if (!item) return undefined
        if (match![2] === "environ") return item.environ
        return `${match![1]} (bash) S ${item.ppid} ${Array.from({ length: 17 }, () => "0").join(" ")} ${item.start} 0 0`
      },
      link: () => undefined,
      list: () => [],
    }
    const environ = (env: Readonly<Record<string, string | undefined>>) =>
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join("\0") + "\0"
    const ticketOf = (env: Readonly<Record<string, string | undefined>>) =>
      Object.values(env)
        .find((value) => value?.startsWith(GitHubProc.TICKET_VALUE))!
        .slice(GitHubProc.TICKET_VALUE.length)
    const connection = await GitHubRemote.register(host.deps, broker.api, proc)
    const verdict = { pid: 0, start: 0 }
    const stub = GitHubRelayStub.start({
      proof: () => undefined,
      egress: () => undefined,
      log: Logger.silent,
      judge: () => ({ trusted: true, operation: "fetch", via: "git-remote-http", command: { ...verdict } }),
      proc,
      holderWaitMs: 300,
    })
    const ask = async (ticket: string, pid: number, start: number) => {
      verdict.pid = pid
      verdict.start = start
      const answer = await fetch(`${stub.url}/github.com/octo/hello.git/info/refs?service=git-upload-pack`, {
        headers: { [Broker.GITHUB_TICKET_HEADER]: ticket },
      })
      return [answer.status, answer.headers.get(Broker.GITHUB_ERROR_HEADER)]
    }
    const created = (id: string, pid: number) =>
      connection.onEvent({ type: "shell.created", data: { info: { id, pid } } } as never, { local: true } as never)
    try {
      // Command A (pid 500, the service's child) gets its ticket; core's `shell.created` names its process.
      const env = await fake.shell(folder, "ses_hostbound00000000001", "shl_bound_a")
      const ticket = ticketOf(env)
      processes.set(500, { ppid: process.pid, start: 200, environ: environ(env) })
      created("shl_bound_a", 500)
      // Command B (pid 510) read A's environment and started itself again with it: its environment holds A's ticket,
      // and it asks before A ever did. Refused.
      processes.set(510, { ppid: process.pid, start: 300, environ: environ(env) })
      expect(await ask(ticket, 510, 300)).toEqual([403, "ticket"])
      // A itself: past the ticket checks (no link to the PC in this test: 503).
      expect(await ask(ticket, 500, 200)).toEqual([503, "unavailable"])
      // A command whose first git asks before its `shell.created` arrives: the stub waits for it.
      const early = await fake.shell(folder, "ses_hostbound00000000001", "shl_bound_c")
      processes.set(520, { ppid: process.pid, start: 400, environ: environ(early) })
      const asked = ask(ticketOf(early), 520, 400)
      created("shl_bound_c", 520)
      expect(await asked).toEqual([503, "unavailable"])
      // A command whose process is never named (or is not this service's child): its ticket works for no one.
      const unnamed = await fake.shell(folder, "ses_hostbound00000000001", "shl_bound_d")
      processes.set(530, { ppid: 1, start: 500, environ: environ(unnamed) })
      expect(await ask(ticketOf(unnamed), 530, 500)).toEqual([403, "ticket"])
      created("shl_bound_d", 530)
      expect(await ask(ticketOf(unnamed), 530, 500)).toEqual([403, "ticket"])
      // A process another own plugin starts through the bridge names its id the same way.
      const spawned = Promise.withResolvers<number | undefined>()
      const bridged = (await GitHubBridge.gitEnv(folder, { sessionID: "ses_hostbound00000000001", pid: spawned.promise }))!
      processes.set(540, { ppid: process.pid, start: 600, environ: environ(bridged) })
      processes.set(541, { ppid: process.pid, start: 610, environ: environ(bridged) })
      spawned.resolve(540)
      expect(await ask(ticketOf(bridged), 541, 610)).toEqual([403, "ticket"])
      expect(await ask(ticketOf(bridged), 540, 600)).toEqual([503, "unavailable"])
    } finally {
      await stub.close()
      await connection.stop()
    }
  })

  test("past a thousand commands only refused ones are let go, their tickets ended; a running command keeps its own (RL2-L4)", async () => {
    await using t = await pc()
    const folder = path.join(fixture.root!, "host-many")
    await fs.mkdir(folder, { recursive: true })
    const fake = hostContext()
    await using host = await testDeps({ directory: folder, ctx: fake.ctx })
    const broker = brokerOf(t.deps, () => "http://127.0.0.1:1")
    const connection = await GitHubRemote.register(host.deps, broker.api)
    const ticketOf = (env: Readonly<Record<string, string | undefined>>) =>
      Object.values(env)
        .find((value) => value?.startsWith("X-Own-GitHub-Ticket: "))!
        .replace(/^X-Own-GitHub-Ticket: /, "")
    try {
      // The oldest command runs (core's `shell.created` named it); the next one's permission was refused, so it never
      // started or exits.
      const running = ticketOf(await fake.shell(folder, "ses_hostmany000000000001", "shl_running"))
      connection.onEvent(
        { type: "shell.created", data: { info: { id: "shl_running", pid: 4242 } } } as never,
        { local: true } as never,
      )
      const refused = ticketOf(await fake.shell(folder, "ses_hostmany000000000001", "shl_refused"))
      host.clock.advance(GitHubCommands.START_GRACE_MS)
      // A thousand younger commands, none started yet (their `shell.created` may still be on its way).
      const young: Array<string> = []
      for (let index = 0; index < GitHubCommands.MAX; index++)
        young.push(ticketOf(await fake.shell(folder, "ses_hostmany000000000001", `shl_young_${index}`)))
      expect(GitHubCredential.redeem(running)).toBeDefined()
      expect(GitHubCredential.redeem(refused)).toBeUndefined()
      expect(young.every((ticket) => GitHubCredential.redeem(ticket) !== undefined)).toBe(true)
    } finally {
      await connection.stop()
    }
  }, 120_000)

  test("its shells' git goes to the stub with a ticket that ends with the command; read-only pushes stop at once", async () => {
    await using t = await pc()
    const folder = path.join(fixture.root!, "host-shell")
    await fs.mkdir(folder, { recursive: true })
    const fake = hostContext()
    await using host = await testDeps({ directory: folder, ctx: fake.ctx })
    const broker = brokerOf(t.deps, () => "http://127.0.0.1:1")
    const connection = await GitHubRemote.register(host.deps, broker.api)
    try {
      const env = await fake.shell(folder, "ses_hostshell00000000001", "shl_one")
      const values = Object.entries(env)
      const value = (key: string) => {
        const at = values.find((entry) => entry[1] === key)?.[0]
        return at === undefined ? undefined : env[at.replace("KEY", "VALUE")]
      }
      expect(env.GIT_CONFIG_COUNT).toBe("4")
      expect(value("url.http://127.0.0.1:1/github.com/.insteadOf")).toBe("https://github.com/")
      expect(value("credential.http://127.0.0.1:1/.helper")).toBe("")
      expect(value(`url.${GitHubCredential.READ_ONLY_PUSH_URL}.pushInsteadOf`)).toBe("https://github.com/")
      const header = value("http.http://127.0.0.1:1/.extraHeader")!
      const ticket = header.replace(/^X-Own-GitHub-Ticket: /, "")
      expect(JSON.stringify(env)).not.toContain(WORK)
      expect(GitHubCredential.redeem(ticket)).toEqual({ directory: folder, root: "ses_hostshell00000000001" })
      // The command exited: its ticket ends.
      connection.onEvent({ type: "shell.exited", data: { id: "shl_one" } } as never, { local: true } as never)
      expect(GitHubCredential.redeem(ticket)).toBeUndefined()
      // A writing account on a host the PC lets read only (GH-49): its pushes still stop at once.
      await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
      broker.changed()
      expect((await fake.shell(folder, "ses_hostshell00000000001")).GIT_CONFIG_COUNT).toBe("4")
      // The host may write: no pushInsteadOf.
      await ok(t.rpc["github.settings.set"], { writeHosts: [HOST] })
      expect((await fake.shell(folder, "ses_hostshell00000000001")).GIT_CONFIG_COUNT).toBe("3")
      // No account, git logins off, or no link: nothing added (the host's git keeps its own login).
      await ok(t.rpc["github.bind"], { target: { type: "project", directory: folder, host: HOST }, account: "off" })
      expect(await fake.shell(folder, "ses_hostshell00000000002")).toEqual({})
      await ok(t.rpc["github.bind"], { target: { type: "project", directory: folder, host: HOST }, account: null })
      broker.state.reachable = false
      expect(await fake.shell(folder, "ses_hostshell00000000002")).toEqual({})
      broker.state.reachable = true
      const reloads = fake.state.reloads
      await ok(t.rpc["github.settings.set"], { git: false })
      broker.changed()
      // Wait for the host to read the PC's new offer (`git: false`, its tools registered again): until then a shell
      // still asks `github.account`, which already says no.
      await until(async () => fake.state.reloads > reloads)
      expect(await fake.shell(folder, "ses_hostshell00000000002")).toEqual({})
      // With git logins off the PC's offer says so: a shell does not even ask.
      const asked = broker.state.asked.filter((method) => method === "github.account").length
      await fake.shell(folder, "ses_hostshell00000000002")
      expect(broker.state.asked.filter((method) => method === "github.account").length).toBe(asked)
    } finally {
      await connection.stop()
    }
  })
})

const KEY = Buffer.alloc(32, 7)
const EPOCH = 3

/**
 * Both ends of the git relay in this process: this PC's egress relay listener (its GitHub route asking
 * `GitHubRelay.gate` for `HOST`) and the host's stub, whose proofs use the epoch key as the host's broker client
 * would; the host module of a folder on top.
 */
async function relayRig(t: Awaited<ReturnType<typeof pc>>, name: string) {
  const relay = new Egress.Relay({
    now: () => Date.now(),
    log: Logger.silent,
    upstream: "http://127.0.0.1:9",
    wire: async () => ({ ok: false, detail: "wire" }) as never,
    limits: () => undefined,
    audit: async () => undefined,
    changed: () => undefined,
    github: (hostId, ask) => GitHubRelay.gate(t.deps, hostId, ask),
  })
  const port = await relay.listen(HOST, {
    local: async () => ({ ok: false, status: 404, code: "not_found" }),
    key: () => ({ epoch: EPOCH, key: KEY }),
    state: () => "off",
    account: () => undefined,
  })
  const counter = { n: 0, last: "" }
  const stub = GitHubRelayStub.start({
    proof: (request) => {
      counter.n += 1
      const mac = createHmac("sha256", KEY)
        .update(Broker.githubMacInput({ hostId: HOST, epoch: EPOCH, n: counter.n, ...request }))
        .digest("hex")
      counter.last = Broker.githubHeader({ epoch: EPOCH, n: counter.n, mac })
      return counter.last
    },
    egress: () => `http://127.0.0.1:${port}`,
    log: Logger.silent,
  })
  const folder = path.join(fixture.root!, name)
  await fs.mkdir(folder, { recursive: true })
  const fake = hostContext()
  const host = await testDeps({ directory: folder, ctx: fake.ctx })
  const broker = brokerOf(t.deps, () => stub.url)
  const connection = await GitHubRemote.register(host.deps, broker.api)
  return {
    relay: `http://127.0.0.1:${port}`,
    stub,
    folder,
    fake,
    broker,
    counter,
    [Symbol.asyncDispose]: async () => {
      await connection.stop()
      await stub.close()
      await relay.shutdown()
      await host[Symbol.asyncDispose]()
    },
  }
}

describe("real git through the host's stub and this PC's relay", () => {
  test("git logs in as the folder's account; the login is added on the PC, never seen on the host", async () => {
    await using t = await pc()
    await using r = await relayRig(t, "relay-fetch")
    const git = await scrubbedGit(path.join(fixture.root!, "git-relay-fetch"))
    const before = github().git.length
    const env = await r.fake.shell(r.folder, "ses_relayfetch0000000001")
    const listed = await git.run(["ls-remote", "https://github.com/octo/hello.git"], r.folder, env)
    expect(`${listed.code} ${listed.stderr}`).toBe("0 ")
    expect(github().git.slice(before)).toMatchObject([{ login: "octo-work", username: "octo-work", service: "git-upload-pack" }])
    // The host's side never held the token: not in its environment, not in what git printed.
    for (const text of [JSON.stringify(env), listed.stdout, listed.stderr]) expect(text).not.toContain(WORK)
    // The project's choice on the PC moves the host's git to another account.
    await ok(t.rpc["github.bind"], { target: { type: "project", directory: r.folder, host: HOST }, account: t.ids.home })
    const asHome = await git.run(["ls-remote", "https://github.com/octo/hello.git"], r.folder, await r.fake.shell(r.folder, "ses_relayfetch0000000002"))
    expect(asHome.code).toBe(0)
    expect(github().git.at(-1)).toMatchObject({ login: "octo-home" })
  })

  test("a read-only account: git push stops at once, a push URL of the user's own is refused by the PC, no ssh", async () => {
    await using t = await pc()
    await using r = await relayRig(t, "relay-push")
    const git = await scrubbedGit(path.join(fixture.root!, "git-relay-push"))
    const repo = path.join(r.folder, "repo")
    const ssh = sshRecorder(path.join(r.folder, "ssh-started"))
    const remote = "https://github.com/octo/hello.git"
    await fs.mkdir(repo, { recursive: true })
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "first"],
      ["remote", "add", "origin", remote],
    ])
      expect((await git.run(args, repo, {})).code).toBe(0)
    const before = github().git.length
    const pushes = () => github().git.slice(before).filter((item) => item.service === "git-receive-pack")
    const env = await r.fake.shell(repo, "ses_relaypush00000000001")
    const pushed = await git.run(["push", "origin", "main"], repo, { ...env, ...ssh.env })
    expect(pushed.code).not.toBe(0)
    expect(pushed.stderr).toContain(GitHubCredential.READ_ONLY_SCHEME)
    // An explicit push URL skips `pushInsteadOf`: the stub relays it and the PC refuses the push (403, no prompt).
    expect((await git.run(["config", "remote.origin.pushurl", remote], repo, {})).code).toBe(0)
    const direct = await git.run(["push", "origin", "main"], repo, { ...(await r.fake.shell(repo, "ses_relaypush00000000001")), ...ssh.env })
    expect(direct.code).not.toBe(0)
    expect(direct.stderr).toContain("403")
    expect(pushes()).toEqual([])
    expect(await ssh.started()).toBe(false)
    // Fetches still log in.
    expect((await git.run(["ls-remote", "origin"], repo, await r.fake.shell(repo, "ses_relaypush00000000001"))).code).toBe(0)
    expect(github().git.at(-1)).toMatchObject({ login: "octo-work", service: "git-upload-pack" })
    // Writing allowed for the account, not for this host (GH-49): the PC refuses the push.
    await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
    r.broker.changed()
    const hostReadOnly = await git.run(["push", "origin", "main"], repo, await r.fake.shell(repo, "ses_relaypush00000000001"))
    expect(hostReadOnly.code).not.toBe(0)
    expect(hostReadOnly.stderr).toContain("403")
    expect(pushes()).toEqual([])
    // The host may write too: the push reaches GitHub with the account's login.
    await ok(t.rpc["github.settings.set"], { writeHosts: [HOST] })
    await git.run(["push", "origin", "main"], repo, await r.fake.shell(repo, "ses_relaypush00000000001"))
    expect(pushes().map((item) => item.login)).toEqual(["octo-work"])
  })

  // Four git-lfs runs of a dozen git processes each: 180 s, not the file's 60 s (LFS-T in `lfsRepo`).
  test("Git LFS through the relay: a writing account uploads, a read-only one's upload is refused on the PC", async () => {
    const git = await scrubbedGit(path.join(fixture.root!, "git-relay-lfs"))
    if (!git.which("git-lfs")) return
    await using t = await pc()
    await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
    await ok(t.rpc["github.settings.set"], { writeHosts: [HOST] })
    await using r = await relayRig(t, "relay-lfs")
    const repo = path.join(r.folder, "lfs-repo")
    const ssh = sshRecorder(path.join(r.folder, "lfs-ssh-started"))
    await lfsRepo(git, repo, "https://github.com/octo/hello.git")
    const before = github().git.length
    const uploads = () => github().git.slice(before).filter((item) => item.service === "lfs-upload")
    const pushStarted = performance.now()
    const pushed = await git.run(["lfs", "push", "origin", "main"], repo, await r.fake.shell(repo, "ses_relaylfs000000000001"))
    // A process start takes seconds on a loaded PC: the bounds below grow with this allowed push's time (LFS-T).
    const pushMs = performance.now() - pushStarted
    expect(`${pushed.code} ${pushed.stderr}`).toStartWith("0 ")
    expect(uploads().map((item) => item.login)).toEqual(["octo-work"])
    // The object went to the storage with the short credential GitHub's batch answer gave for it, not the login.
    expect(github().storage.filter((item) => item.method === "PUT").map((item) => item.derived)).toContain(true)
    await ok(t.rpc["github.update"], { id: t.ids.work, write: false })
    r.broker.changed()
    // Read-only: git-lfs stops at the host's `pushInsteadOf` before any network (git-lfs applies it to a push URL too).
    const started = performance.now()
    const env = await r.fake.shell(repo, "ses_relaylfs000000000001")
    const stopped = await git.run(["lfs", "push", "origin", "main"], repo, { ...env, ...ssh.env })
    expect(stopped.code).not.toBe(0)
    expect(stopped.stderr).toContain(GitHubCredential.READ_ONLY_SCHEME)
    expect(performance.now() - started).toBeLessThan(Math.max(20_000, 2 * pushMs))
    // Without that entry (an agent that changed its environment), the upload batch reaches the PC, which refuses it
    // (403: no retries, no prompt).
    const bypassed = { ...env, GIT_CONFIG_COUNT: String(Number(env.GIT_CONFIG_COUNT) - 1) }
    expect(env[`GIT_CONFIG_KEY_${bypassed.GIT_CONFIG_COUNT}`]).toBe(`url.${GitHubCredential.READ_ONLY_PUSH_URL}.pushInsteadOf`)
    const refused = await git.run(["lfs", "push", "origin", "main"], repo, { ...bypassed, ...ssh.env })
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain("Authorization error")
    expect(uploads()).toHaveLength(1)
    expect(await ssh.started()).toBe(false)
    expect(performance.now() - started).toBeLessThan(Math.max(40_000, 4 * pushMs))
  }, 180_000)

  test("the stub answers only this service's git with a live ticket; the relay only a fresh proof", async () => {
    await using t = await pc()
    await using r = await relayRig(t, "relay-refuse")
    const env = await r.fake.shell(r.folder, "ses_relayrefuse000000001")
    const header = Object.entries(env).find((entry) => entry[1]?.startsWith("X-Own-GitHub-Ticket: "))![1]!
    const ticket = header.slice("X-Own-GitHub-Ticket: ".length)
    const at = "/github.com/octo/hello.git/info/refs?service=git-upload-pack"
    const before = github().git.length
    // No ticket, or a forged one.
    for (const value of [undefined, `${ticket.split(".")[0]}.forged`]) {
      const answer = await fetch(`${r.stub.url}${at}`, value === undefined ? {} : { headers: { "x-own-github-ticket": value } })
      expect([answer.status, answer.headers.get(Broker.GITHUB_ERROR_HEADER)]).toEqual([403, "ticket"])
    }
    if (process.platform === "win32") {
      // This test process with the live ticket is not git's transport: refused (GH-39).
      const answer = await fetch(`${r.stub.url}${at}`, { headers: { "x-own-github-ticket": ticket } })
      expect([answer.status, answer.headers.get(Broker.GITHUB_ERROR_HEADER)]).toEqual([403, "caller"])
    }
    // The relay: no proof, a wrong one, a replayed one (the stub's last), another epoch.
    const place = Buffer.from(JSON.stringify({ directory: r.folder })).toString("base64url")
    const proof = (n: number, epoch = EPOCH, key = KEY) =>
      Broker.githubHeader({
        epoch,
        n,
        mac: createHmac("sha256", key)
          .update(Broker.githubMacInput({ hostId: HOST, epoch, n, method: "GET", path: at, place }))
          .digest("hex"),
      })
    const relay = (headers: Record<string, string>) =>
      fetch(`${r.relay}/github${at}`, { headers: { [Broker.GITHUB_PLACE_HEADER]: place, ...headers } })
    const fresh = await relay({ [Broker.GITHUB_HEADER]: proof(500) })
    expect(fresh.status).toBe(200)
    const refused: ReadonlyArray<Record<string, string>> = [
      {},
      { [Broker.GITHUB_HEADER]: proof(501, EPOCH, Buffer.alloc(32, 8)) },
      { [Broker.GITHUB_HEADER]: proof(500) },
      { [Broker.GITHUB_HEADER]: proof(502, EPOCH + 1) },
      // The proof covers the place: the same proof with another folder is refused.
      { [Broker.GITHUB_HEADER]: proof(503), [Broker.GITHUB_PLACE_HEADER]: Buffer.from(JSON.stringify({ directory: "/x" })).toString("base64url") },
    ]
    for (const headers of refused) {
      const answer = await relay(headers)
      expect([answer.status, answer.headers.get(Broker.GITHUB_ERROR_HEADER)]).toEqual([401, "mac"])
    }
    // Only the one fresh proof reached GitHub.
    expect(github().git.slice(before)).toHaveLength(1)
    // GitHub refusing the account's login (a revoked token): 403 without a challenge, so the host's git never prompts.
    github().removeAccount(WORK)
    try {
      const revoked = await relay({ [Broker.GITHUB_HEADER]: proof(504) })
      expect([revoked.status, revoked.headers.get(Broker.GITHUB_ERROR_HEADER)]).toEqual([403, "problem"])
      expect(revoked.headers.get("www-authenticate")).toBeNull()
    } finally {
      github().addAccount(WORK, { login: "octo-work", scopes: "repo" })
    }
  })
})

/** One request straight to this PC's relay with a fresh proof, as the host's stub sends it. */
function relayAsk(r: Rig, method: string, at: string, body?: string) {
  const place = Buffer.from(JSON.stringify({ directory: r.folder })).toString("base64url")
  r.counter.n += 1
  const n = r.counter.n
  const mac = createHmac("sha256", KEY)
    .update(Broker.githubMacInput({ hostId: HOST, epoch: EPOCH, n, method, path: at, place }))
    .digest("hex")
  return fetch(`${r.relay}/github${at}`, {
    method,
    headers: {
      [Broker.GITHUB_HEADER]: Broker.githubHeader({ epoch: EPOCH, n, mac }),
      [Broker.GITHUB_PLACE_HEADER]: place,
      ...(body === undefined ? {} : { "content-type": "application/vnd.git-lfs+json" }),
    },
    ...(body === undefined ? {} : { body }),
  })
}

type Rig = Awaited<ReturnType<typeof relayRig>>

describe("what GitHub's answers may carry back to the host (GH-45, GH-46)", () => {
  const BATCH = "/github.com/octo/hello.git/info/lfs/objects/batch"
  const REFS = "/github.com/octo/hello.git/info/refs?service=git-upload-pack"
  const authorization = `Basic ${Buffer.from(`octo-work:${WORK}`).toString("base64")}`
  const secrets = [...GitHubMask.loginForms("octo-work", WORK), authorization]

  test("an LFS action's Authorization that is the login itself is dropped; a storage step's own credential stays", async () => {
    await using t = await pc()
    await ok(t.rpc["github.update"], { id: t.ids.work, write: true })
    await ok(t.rpc["github.settings.set"], { writeHosts: [HOST] })
    await using r = await relayRig(t, "answer-actions")
    const oid = "a".repeat(64)
    const batch = JSON.stringify({ operation: "upload", transfers: ["basic"], objects: [{ oid, size: 3 }] })
    const plain = await relayAsk(r, "POST", BATCH, batch)
    expect(plain.status).toBe(200)
    const kept = (await plain.json()) as { objects: Array<{ actions: { upload: { header: Record<string, string> } } }> }
    expect(kept.objects[0]!.actions.upload.header.Authorization).toStartWith("RemoteAuth lfs-")
    github().echo.add("actions")
    try {
      const echoed = await relayAsk(r, "POST", BATCH, batch)
      const text = await echoed.text()
      expect(echoed.status).toBe(200)
      const answer = JSON.parse(text) as { objects: Array<{ actions: { upload: Record<string, unknown> } }> }
      expect(answer.objects[0]!.actions.upload).toEqual({ href: `${github().url}/_lfs/${oid}`, header: {}, expires_in: 3600 })
      for (const secret of secrets) expect(text).not.toContain(secret)
    } finally {
      github().echo.clear()
    }
  })

  test("the login in a header, a redirect's Location or a 401 body never goes back: 502 leak", async () => {
    await using t = await pc()
    await using r = await relayRig(t, "answer-echo")
    const download = JSON.stringify({ operation: "download", objects: [] })
    const cases: ReadonlyArray<readonly [FakeGitHubEcho, string, string, string | undefined]> = [
      ["header", "GET", REFS, undefined],
      ["header", "POST", BATCH, download],
      ["location", "GET", REFS, undefined],
      ["body401", "GET", REFS, undefined],
      ["body401", "POST", BATCH, download],
    ]
    for (const [echo, method, at, body] of cases) {
      github().echo.add(echo)
      try {
        const answer = await relayAsk(r, method, at, body)
        const text = await answer.text()
        const headers = JSON.stringify([...answer.headers.entries()])
        expect(`${echo} ${at}: ${answer.status} ${answer.headers.get(Broker.GITHUB_ERROR_HEADER)}`).toBe(`${echo} ${at}: 502 leak`)
        for (const secret of secrets) expect(text + headers).not.toContain(secret)
      } finally {
        github().echo.clear()
      }
    }
    // Without the echo the same requests pass.
    expect((await relayAsk(r, "GET", REFS)).status).toBe(200)
    expect((await relayAsk(r, "POST", BATCH, download)).status).toBe(200)
  })

  test("an LFS batch goes upstream as it was read; two keys named operation in any letter case are refused", async () => {
    await using t = await pc()
    await using r = await relayRig(t, "answer-batch")
    const from = github().batches.length
    // The last `operation` is the one JSON readers here take: what goes upstream names that one only.
    const twice = '{"operation":"upload","operation":"download","objects":[]}'
    expect((await relayAsk(r, "POST", BATCH, twice)).status).toBe(200)
    expect(github().batches.slice(from)).toEqual(['{"operation":"download","objects":[]}'])
    // A parser that matches names without case could read `Operation`: refused before anything goes upstream.
    for (const body of [
      '{"operation":"download","Operation":"upload","objects":[]}',
      '{"OPERATION":"upload","operation":"download","objects":[]}',
      "[]",
    ]) {
      const answer = await relayAsk(r, "POST", BATCH, body)
      expect([body, answer.status, answer.headers.get(Broker.GITHUB_ERROR_HEADER)]).toEqual([body, 400, "bad_request"])
    }
    expect(github().batches.slice(from)).toHaveLength(1)
  })
})

describe("the Linux caller check (GitHubProc, a fake /proc)", () => {
  const SERVICE = 400
  const UID = 1000
  const IMAGES = ["/usr/lib/git-core/git-remote-http", "/usr/lib/git-core/git-remote-https", "/usr/local/bin/git-lfs"]
  /** 127.0.0.1:41000 (git) → 127.0.0.1:42000 (the stub), both ends as `/proc/net/tcp` lists them. */
  const TCP = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:A028 0100007F:A410 01 00000000:00000000 00:00000000 00000000  1000        0 7777 1 0000000000000000 20 4 30 10 -1",
    "   1: 0100007F:A410 0100007F:A028 01 00000000:00000000 00:00000000 00000000  1000        0 8888 1 0000000000000000 20 4 30 10 -1",
  ].join("\n")

  interface FakeProcess {
    readonly pid: number
    readonly ppid: number
    readonly start: number
    readonly comm: string
    readonly exe?: string
    readonly argv: ReadonlyArray<string>
    readonly fds?: ReadonlyArray<string>
  }

  function proc(processes: ReadonlyArray<FakeProcess>, tcp = TCP): GitHubProc.Proc {
    const byPid = new Map(processes.map((item) => [item.pid, item]))
    return {
      read: (file) => {
        if (file === "/proc/net/tcp") return tcp
        if (file === "/proc/net/tcp6") return undefined
        const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(file)
        const item = match ? byPid.get(Number(match[1])) : undefined
        if (!item) return undefined
        if (match![2] === "cmdline") return `${item.argv.join("\0")}\0`
        // Fields 3.. after `(comm)`: state, ppid, then 16 more before the start time (field 22).
        return `${item.pid} (${item.comm}) S ${item.ppid} ${Array.from({ length: 17 }, () => "0").join(" ")} ${item.start} 0 0`
      },
      link: (file) => {
        const exe = /^\/proc\/(\d+)\/exe$/.exec(file)
        if (exe) return byPid.get(Number(exe[1]))?.exe
        const fd = /^\/proc\/(\d+)\/fd\/(.+)$/.exec(file)
        return fd ? byPid.get(Number(fd[1]))?.fds?.[Number(fd[2])] : undefined
      },
      list: (dir) => {
        if (dir === "/proc") return [...byPid.keys()].map(String).concat(["self", "net"])
        const fd = /^\/proc\/(\d+)\/fd$/.exec(dir)
        const item = fd ? byPid.get(Number(fd[1])) : undefined
        return item?.fds ? item.fds.map((_, index) => String(index)) : []
      },
    }
  }

  /** The service, its shell, `git fetch`, and the transport holding the client socket. */
  const chain = (transport: Partial<FakeProcess> = {}, git: Partial<FakeProcess> = {}): FakeProcess[] => [
    { pid: SERVICE, ppid: 1, start: 100, comm: "bun", exe: "/usr/bin/bun", argv: ["bun", "serve"] },
    { pid: 500, ppid: SERVICE, start: 200, comm: "bash", exe: "/usr/bin/bash", argv: ["bash", "-c", "git fetch"] },
    { pid: 600, ppid: 500, start: 300, comm: "git", exe: "/usr/bin/git", argv: ["git", "fetch", "origin"], ...git },
    {
      pid: 700,
      ppid: 600,
      start: 400,
      comm: "git-remote-http",
      exe: "/usr/lib/git-core/git-remote-http",
      argv: ["git-remote-https", "origin", "https://github.com/octo/hello.git"],
      fds: ["/dev/null", "pipe:[1]", "socket:[7777]"],
      ...transport,
    },
  ]
  const judge = (processes: ReadonlyArray<FakeProcess>, options: { tcp?: string; uid?: number; service?: number } = {}) =>
    GitHubProc.judge(41000, 42000, IMAGES, {
      proc: proc(processes, options.tcp),
      service: options.service ?? SERVICE,
      uid: options.uid ?? UID,
    })

  test("this service's git transport (by its real path) is trusted; a push is told from a fetch", () => {
    // The command is the service's own child (its shell).
    expect(judge(chain())).toEqual({
      trusted: true,
      operation: "fetch",
      via: "git-remote-http",
      command: { pid: 500, start: 200 },
    })
    expect(judge(chain({}, { argv: ["git", "push", "origin", "main"] }))).toMatchObject({ trusted: true, operation: "push" })
    // git-lfs under git's pre-push hook.
    expect(
      judge(
        chain(
          { comm: "git-lfs", exe: "/usr/local/bin/git-lfs", argv: ["git-lfs", "pre-push", "origin"] },
          { argv: ["git", "push"] },
        ),
      ),
    ).toMatchObject({ trusted: true, operation: "push", via: "git-lfs" })
    // The IPv4-mapped form in `tcp6` is found too.
    const tcp6 = TCP.replace("0100007F:A028 0100007F:A410", "0000000000000000FFFF00000100007F:A028 0000000000000000FFFF00000100007F:A410")
    expect(judge(chain(), { tcp: tcp6 }).trusted).toBe(true)
  })

  test("curl with the ticket, a copied or replaced program, another user, a git outside this service: never", () => {
    expect(judge(chain({ comm: "curl", exe: "/usr/bin/curl", argv: ["curl", "http://127.0.0.1:42000/"] }))).toMatchObject({
      trusted: false,
      via: "curl<git<bash<bun",
    })
    expect(judge(chain({ exe: "/home/u/work/git-remote-http" }))).toMatchObject({ trusted: false, via: "git-remote-http" })
    expect(judge(chain({ exe: "/usr/lib/git-core/git-remote-http (deleted)" })).trusted).toBe(false)
    expect(judge(chain(), { uid: 1001 })).toMatchObject({ trusted: false, via: "other_user" })
    expect(judge(chain(), { service: 999 })).toMatchObject({ trusted: false, via: "git-remote-http outside this service" })
    // The shell's id was taken over by a newer process (started after git): the walk stops, the service is not reached.
    const reused = chain().map((item) => (item.pid === 500 ? { ...item, start: 350 } : item))
    expect(judge(reused).trusted).toBe(false)
    // The connection is not in the table (or not established), or no process holds its socket.
    expect(judge(chain(), { tcp: TCP.replace(" 01 00000000", " 06 00000000") }).via).toBe("unknown")
    expect(judge(chain({ fds: ["/dev/null"] })).via).toBe("unknown")
    expect(GitHubProc.judge(undefined, 42000, IMAGES, { proc: proc(chain()), service: SERVICE, uid: UID }).trusted).toBe(false)
  })

  /** The same command as a shell core's process daemon started (upstream v2.3); `ppid` 1: adopted by init. */
  const daemon = (ppid = SERVICE): FakeProcess[] =>
    chain().flatMap((item) =>
      item.pid === 500
        ? [
            {
              pid: 450,
              ppid,
              start: 150,
              comm: "opencode-pty",
              exe: "/home/u/.local/share/opencode/bin/opencode-pty/1.0.0-0123456789abcdef/opencode-pty",
              argv: ["opencode-pty", "daemon", "--runtime-dir", "/run/user/1000/opencode-pty", "--name", "a"],
            },
            { ...item, ppid: 450 },
          ]
        : [item],
    )

  test("a shell under core's process daemon is the command once this service named it, even after the daemon was adopted (MR18)", () => {
    const judged = (processes: ReadonlyArray<FakeProcess>, commands?: (holder: string) => boolean) =>
      GitHubProc.judge(41000, 42000, IMAGES, { proc: proc(processes), service: SERVICE, uid: UID, commands })
    const shell = (holder: string) => holder === "500:200"
    // Named: the shell is the command (its environment holds the ticket), not the daemon.
    expect(judged(daemon(), shell)).toEqual({
      trusted: true,
      operation: "fetch",
      via: "git-remote-http",
      command: { pid: 500, start: 200 },
    })
    expect(judged(daemon(1), shell)).toMatchObject({ trusted: true, command: { pid: 500, start: 200 } })
    // Not named: the daemon is only the service's child (its environment holds no ticket), and once adopted, nothing.
    expect(judged(daemon()).command).toEqual({ pid: 450, start: 150 })
    expect(judged(daemon(1))).toMatchObject({ trusted: false, via: "git-remote-http outside this service" })
    // A process under the same id that is not the named one (another start), or a copied program: never.
    expect(judged(daemon(1), (holder) => holder === "500:199").trusted).toBe(false)
    const copied = daemon(1).map((item) => (item.pid === 700 ? { ...item, exe: "/home/u/work/git-remote-http" } : item))
    expect(judged(copied, shell)).toMatchObject({ trusted: false, via: "git-remote-http" })
    // The holder of a command core reports: the service's child, or the process daemon's; nothing deeper.
    expect(GitHubProc.holder(proc(chain()), 500, SERVICE)).toBe("500:200")
    expect(GitHubProc.holder(proc(daemon()), 500, SERVICE)).toBe("500:200")
    expect(GitHubProc.holder(proc(daemon(1)), 500, SERVICE)).toBe("500:200")
    expect(GitHubProc.holder(proc(daemon()), 600, SERVICE)).toBeUndefined()
    expect(GitHubProc.holder(proc(daemon()), 999, SERVICE)).toBeUndefined()
  })

  test("the stub waits for a daemon's shell to be named, and a named command keeps only its own ticket (MR18, GH-48)", async () => {
    const bound = { ms: 60_000, bound: true }
    const ticket = GitHubCredential.issueTicket({ directory: "/home/u/work" }, bound)
    const other = GitHubCredential.issueTicket({ directory: "/home/u/work" }, bound)
    const never = GitHubCredential.issueTicket({ directory: "/home/u/work" }, bound)
    const processes = proc(daemon(1))
    const environ = [
      "GIT_CONFIG_KEY_0=http.http://127.0.0.1:42000/.extraHeader",
      `GIT_CONFIG_VALUE_0=${GitHubProc.TICKET_VALUE}${ticket}`,
    ].join("\0")
    const stub = GitHubRelayStub.start({
      proof: () => undefined,
      egress: () => undefined,
      log: Logger.silent,
      judge: () =>
        GitHubProc.judge(41000, 42000, IMAGES, {
          proc: processes,
          service: SERVICE,
          uid: UID,
          commands: GitHubCredential.named,
        }),
      proc: { ...processes, read: (file) => (file === "/proc/500/environ" ? `${environ}\0` : processes.read(file)) },
      holderWaitMs: 2_000,
    })
    try {
      const ask = async (value: string) => {
        const answer = await fetch(`${stub.url}/github.com/octo/hello.git/info/refs?service=git-upload-pack`, {
          headers: { [Broker.GITHUB_TICKET_HEADER]: value },
        })
        return [answer.status, answer.headers.get(Broker.GITHUB_ERROR_HEADER)]
      }
      // No command named yet, and the walk ends at init: not this service's.
      expect(await ask(never)).toEqual([403, "caller"])
      // The first request comes before `shell.created`: it waits for the name, then passes the ticket checks (503: no
      // link to the PC in this test).
      const first = ask(ticket)
      await Bun.sleep(100)
      GitHubCredential.started(ticket, GitHubProc.holder(processes, 500, SERVICE))
      expect(await first).toEqual([503, "unavailable"])
      expect(GitHubCredential.named("500:200")).toBe(true)
      // Another command's ticket (named for another process) in this command's hands: refused.
      GitHubCredential.started(other, "800:250")
      expect(await ask(other)).toEqual([403, "ticket"])
    } finally {
      await stub.close()
    }
  })

  test("a ticket works only for the command it was made for: its environment holds it, and the first one keeps it (GH-48)", async () => {
    const ticket = GitHubCredential.issueTicket({ directory: "/home/u/work" }, { ms: 60_000 })
    const other = GitHubCredential.issueTicket({ directory: "/home/u/work" }, { ms: 60_000 })
    const environ = (...tickets: string[]) =>
      [
        "PATH=/usr/bin",
        "GIT_CONFIG_KEY_0=url.http://127.0.0.1:42000/github.com/.insteadOf",
        "GIT_CONFIG_VALUE_0=https://github.com/",
        ...tickets.flatMap((value, index) => [
          `GIT_CONFIG_KEY_${index + 1}=http.http://127.0.0.1:42000/.extraHeader`,
          `GIT_CONFIG_VALUE_${index + 1}=${GitHubProc.TICKET_VALUE}${value}`,
        ]),
      ].join("\0") + "\0"
    const of = (text: string | undefined): GitHubProc.Proc => ({
      read: (file) => (file === "/proc/500/environ" ? text : undefined),
      link: () => undefined,
      list: () => [],
    })
    expect(GitHubProc.holds(of(environ(ticket)), 500, ticket)).toBe(true)
    expect(GitHubProc.holds(of(environ(ticket)), 500, other)).toBe(false)
    expect(GitHubProc.holds(of(environ(ticket, other)), 500, ticket)).toBe(false)
    expect(GitHubProc.holds(of(environ()), 500, ticket)).toBe(false)
    expect(GitHubProc.holds(of(undefined), 500, ticket)).toBe(false)
    // The stub: the caller check names the command; its environment holds `ticket`.
    const verdict = {
      current: { trusted: true, operation: "fetch", via: "git-remote-http", command: { pid: 500, start: 200 } } as GitHubProc.Verdict,
    }
    const stub = GitHubRelayStub.start({
      proof: () => undefined,
      egress: () => undefined,
      log: Logger.silent,
      judge: () => verdict.current,
      proc: of(environ(ticket)),
    })
    try {
      const ask = async (value: string) => {
        const answer = await fetch(`${stub.url}/github.com/octo/hello.git/info/refs?service=git-upload-pack`, {
          headers: { [Broker.GITHUB_TICKET_HEADER]: value },
        })
        return [answer.status, answer.headers.get(Broker.GITHUB_ERROR_HEADER)]
      }
      // Its own command: past the ticket checks (no link to the PC in this test: 503).
      expect(await ask(ticket)).toEqual([503, "unavailable"])
      // Another live ticket, read out of another command's environment: refused.
      expect(await ask(other)).toEqual([403, "ticket"])
      // Another process under the same id later (a new command): the ticket stays with its first holder.
      verdict.current = { ...verdict.current, command: { pid: 500, start: 900 } }
      expect(await ask(ticket)).toEqual([403, "ticket"])
    } finally {
      await stub.close()
    }
  })
})

async function until(probe: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe()) return
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(50)
  }
}
