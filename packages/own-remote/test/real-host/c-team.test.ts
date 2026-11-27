// Real-host phase C (06 §11.3 TG17 and the remote parts of TG2/TG3/TG4/TG11, 07 §8.4 PG2 on the remote, 06 §11.2
// 실제 호스트): own.team inside the phase A host's own service, driven from this PC's release service (stack.ts: own-accounts
// and own-remote, fake providers, the egress sink) through own-remote's tunnel. Opt-in: OWN_REAL_HOST=dev-host.
//
// Everything the phase makes on the host lives in one temp root /tmp/own-<uid>-team-<rand> (team-fixture.ts: an F1-like
// code repository and an F2-like LFS repository, bare `file://` origins, the teams' worktree roots next to them) or in
// the 04 §5.3 install paths (the uploaded git-lfs under <OWN_HOME>/tools); afterAll removes the temp root and z-cleanup
// the install. Model traffic only to the fakes on this PC (the judge's `[propose-…]` directives, own-team e2e
// `directives.ts`); `~/.gitconfig` is hashed before and after and must not change.
//
// The LFS items need the release's pinned git-lfs (`build-remote.ps1`, remote\manifest.json `tools.git-lfs`). A release
// without it fails the first test; OWN_REAL_HOST_TEAM_NO_LFS=1 runs the other items only (a development check).
//
// GitHub on the host (16 §8, GH-44, GH-52, MR10-4): the last items. A fake GitHub on this PC (its API, MCP server,
// git's smart HTTP over a real bare repository through `git http-backend`, Git LFS's batch API and object storage) is
// the only GitHub; the host reaches the PC's egress relay through own-remote's tunnel, and the LFS storage the fake's
// actions name through a helper `ssh -R` of the same port. A conversation's Code Mode calls a GitHub tool, git in its
// shells pushes once the PC lets the host write, a read-only host's push is refused, LFS objects go up and come back,
// a ticket read out of another command's `/proc/<pid>/environ` is refused, as is a git outside the service, and no
// token is anywhere on the host. Every token is fake.
//
// Claude Agent on the host (02 §8.10.13, CAG-R, core P-052): the very last items. This PC's service runs the fake
// `claude` CLI of core's tests (OPENCODE_CLAUDE_PATH, a Bun script: the release's opencode.exe runs it as Bun with
// BUN_BE_BUN) for two Claude Agent accounts whose folders hold fake logins. A host conversation on `claude-agent/sonnet`
// runs its claude on this PC and its read tool on the host; after a reconnect it resumes the same Claude conversation;
// a switch to the second account resumes it there; no Claude login, token or e-mail is anywhere on the host. Every
// token is fake; no model call leaves this PC.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { Option, Schema } from "effect"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnAccounts, OwnTeam, Preset } from "@own/protocol"
import {
  chatGPTAccount,
  mintChatGPTTokens,
  replaceFile,
  writeCodexMultiProviderProfiles,
} from "../../../own-accounts/test/e2e-kit"
import { startFakeGitHub, type FakeGitHub } from "../../../own-accounts/test/e2e-kit/fakes/github"
import { GitHubMask } from "../../../own-accounts/src/github/mask.js"
import { afterToolResult, lastUserText } from "../../../own-accounts/test/e2e-kit"
import { TITLE_PROMPT, proposal, responder } from "../../../own-team/test/e2e/directives.js"
import {
  ALIAS,
  APP,
  OWN_HOME,
  ROOT,
  enabled,
  evidence,
  freeLocalPort,
  freeOnBoth,
  hostSh,
  kv,
  ports,
  releaseLfs,
  section,
} from "./env.js"
import { LINKED, MODEL, ensureCompat, startStack, until, type Stack } from "./stack.js"
import {
  HEAVY,
  IN_CONE,
  LFS_FILES,
  POINTER,
  accountsOutput,
  errorOf,
  gitconfig,
  hostGit,
  local,
  lfsFacts,
  makeFixtures,
  makeRoot,
  originMissing,
  pairApp,
  remoteAccounts,
  remoteFetch,
  remoteSession,
  remoteTeam,
  removeRoot,
  steps,
  type Endpoint,
  type Fixtures,
} from "./team-fixture.js"

const run = enabled ? describe : describe.skip
const CLIENT = "real-host-c"
const LFS = releaseLfs()
const NO_LFS = process.env.OWN_REAL_HOST_TEAM_NO_LFS === "1"
/** The LFS items: skipped only when the release has no git-lfs and the run asked for the other items only. */
const lfsTest = test.skipIf(LFS === undefined && NO_LFS)
/** The second ChatGPT login of 07 PG2 (fake tokens, never refreshed: linked). */
const LINKED_2 = chatGPTAccount({ accountID: "acct-own-real-host-linked-2" })
/** Waits of the remote team ops: git and git-lfs on the host, a judge call through the broker. */
const OP_MS = 240_000
/** The fake GitHub account's token (never a real one). The host must never see it. */
const GH_TOKEN = "ghp_ownRealHostGitHubWorkFake00000000Gh01"
/** The fake account's login and this phase's label for it on this PC. */
const GH_LOGIN = "octo-work"
const GH_LABEL = "실호스트"
/** The repository the host's git reaches as `https://github.com/octo/hello.git`. */
const GH_REPO = "https://github.com/octo/hello.git"
const GH_IDENTITY = "-c user.name=own-real-host -c user.email=own-real-host@example.invalid"
/** core's fake `claude` CLI (02 §8.10.13 items): this PC's provider runs it instead of Claude Code. */
const FAKE_CLAUDE = path.join(import.meta.dir, "..", "..", "..", "core", "test", "plugin", "provider", "claude-agent", "lib", "fake-claude-cli.ts")
/** The fake logins of the two Claude Agent accounts (never real ones) and the fake CLI's account e-mail. */
const CA_TOKENS = ["sk-ant-oat01-ownRealHostAgentFake000000000000001", "sk-ant-oat01-ownRealHostAgentFake000000000000002"]
const CA_EMAIL = "fake-owner@example.invalid"

const decodeOffered = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ location: Schema.String, read: Schema.Number, write: Schema.Number })),
)

/** The chat model's GitHub turn (`[gh-get-me]`): Code Mode calls GitHub's `get_me`, then a short answer. */
function githubReply(request: Parameters<ReturnType<typeof responder>>[0]) {
  if (request.body.includes(TITLE_PROMPT) || !lastUserText(request).includes("[gh-get-me]")) return undefined
  if (afterToolResult(request)) return { type: "text" as const, text: "확인했어요." }
  return { type: "tool-call" as const, name: "execute", input: { code: "return await tools.github.get_me({})" } }
}

type Area = OwnTeam.AreaView

run(`real host ${ALIAS}: team (phase C)`, () => {
  const state = {} as {
    /** The Claude Agent items' accounts on this PC. */
    agents?: Array<{ readonly accountID: string; readonly folder: string }>
    agentSession?: string
    agentClaude?: string
  /** `<path> <mtime>` of every Claude login file on the host before the Claude Agent items (the host user's own). */
  agentCredentials?: ReadonlyArray<string>
    stack: Stack
    hostId: string
    endpoint: Endpoint
    /** The remote OWN_HOME (04 §5.3). */
    ownHome: string
    fixtures: Fixtures
    alpha: { readonly providerID: string }
    gitconfig: string
    teams: Map<string, OwnTeam.TeamID>
    github: FakeGitHub
    /** This PC's bare repositories the fake serves (`<ROOT>\github-repos`). */
    githubRepos: string
    githubPort: number
    /** The host folder bound to the GitHub account, and the account's id on this PC. */
    gh: { dir: string; account: string }
  }
  state.teams = new Map()
  const team = remoteTeam(() => state.endpoint)

  const host = async () => {
    const listed = await local(state.stack, "hosts.list", {})
    const found = listed.hosts.find((item) => item.id === state.hostId)
    if (!found) throw new Error(`host ${state.hostId} is not listed`)
    return found
  }
  const connect = async () => {
    await local(state.stack, "connect", { hostId: state.hostId, clientId: CLIENT })
    return until(
      async () => {
        const view = await host()
        return view.stage === "ready" || view.paused ? view : undefined
      },
      240_000,
      500,
    )
  }
  const resolve = async () => {
    const resolved = await local(state.stack, "resolve", { hostId: state.hostId })
    if (resolved.url === null) throw new Error(`host not ready: ${resolved.stage}`)
    state.endpoint = { url: resolved.url, token: resolved.token, controlDir: resolved.controlDir }
    state.ownHome = `${resolved.home}/.local/share/own-open-code`
    return state.endpoint
  }
  /** drain now (stop), then wait until the service is gone on the host (b-stack's drain). */
  const drain = async () => {
    const plan = await local(state.stack, "drain.plan", { hostId: state.hostId, action: "stop" })
    await local(state.stack, "drain.execute", { nonce: plan.nonce, mode: "now" })
    await until(
      async () => {
        const view = await host()
        return view.stage === "disconnected" && view.paused ? view : undefined
      },
      120_000,
      1_000,
    )
    await until(
      async () =>
        (await state.stack.localRaw("own.remote", "drain.plan", { hostId: state.hostId, action: "stop" })).status ===
        200,
      120_000,
      1_000,
    )
    expect(await alive(await servicePid())).toBe(false)
  }
  const servicePid = async () =>
    kv(
      (
        await hostSh(
          String.raw`echo "PID=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" 2>/dev/null | head -n 1)"`,
        )
      ).stdout,
    ).get("PID") || undefined
  const alive = async (pid: string | undefined) =>
    pid !== undefined &&
    kv((await hostSh(`[ -d /proc/${pid} ] && echo ALIVE=1 || echo ALIVE=0`)).stdout).get("ALIVE") === "1"
  /** `team.get` of a repository's main folder, with its team remembered for afterAll. */
  const view = async (directory: string) => {
    const got = await team.call("team.get", { directory })
    if (got.team) state.teams.set(directory, got.team.id)
    return got
  }
  /** Commits a change in `directory` on the host (the area's own branch), with the fixture identity. */
  const commitIn = async (directory: string, file: string, text: string) => {
    const made = await hostGit(
      `cd '${directory}' && mkdir -p "$(dirname -- '${file}')" && printf '%s\\n' '${text}' > '${file}' && git add -A && git commit -q -m '${text}' && echo "HEAD=$(git rev-parse HEAD)"`,
    )
    const head = kv(made.stdout).get("HEAD")
    if (!head) throw new Error(`commit in ${directory} failed: ${made.stderr}`)
    return head
  }
  const revParse = async (directory: string, rev: string) =>
    kv((await hostGit(`echo "REV=$(git -C '${directory}' rev-parse '${rev}' 2>/dev/null)"`)).stdout).get("REV") ?? ""
  /** The enabling conversation (its folder becomes the home, its model the main's: compat Alpha, 3.2). */
  const enableSession = (directory: string) =>
    remoteSession(state.endpoint, {
      directory,
      title: "real host team",
      model: { providerID: state.alpha.providerID, id: MODEL },
    })

  beforeAll(async () => {
    state.githubRepos = path.join(ROOT, "github-repos")
    fs.rmSync(state.githubRepos, { recursive: true, force: true })
    fs.mkdirSync(path.join(state.githubRepos, "octo"), { recursive: true })
    const bare = spawnSync("git", ["init", "-q", "--bare", path.join(state.githubRepos, "octo", "hello.git")], {
      encoding: "utf8",
      windowsHide: true,
    })
    if (bare.status !== 0) throw new Error(`bare repository: ${bare.stderr}`)
    state.githubPort = await (await freeOnBoth())()
    state.github = startFakeGitHub({
      accounts: { [GH_TOKEN]: { login: GH_LOGIN, scopes: "repo" } },
      port: state.githubPort,
      repos: state.githubRepos,
    })
    state.stack = await startStack({
      responder: responder({ before: githubReply }),
      endpoints: state.github.endpoints,
      forward: [state.githubPort],
      env: { OPENCODE_CLAUDE_PATH: FAKE_CLAUDE },
    })
    state.hostId = state.stack.hostId
    state.alpha = { providerID: String((await ensureCompat(state.stack, "Alpha")).providerID) }
    const ready = await connect()
    expect(ready.stage).toBe("ready")
    await resolve()
    // The helper -R forwards (fake provider, sink, the fake GitHub's storage) come up within a few seconds.
    const forwarded = await ports()
    await until(
      async () => {
        const check = await hostSh(
          `ss -Htln | awk '{print $4}' | grep -cE '^127.0.0.1:(${forwarded.provider}|${forwarded.sink}|${state.githubPort})$'`,
        )
        return check.stdout.trim() === "3"
      },
      60_000,
      1_000,
    )
    state.gitconfig = await gitconfig()
    evidence("c-gitconfig.json", { before: state.gitconfig })
    state.fixtures = await makeFixtures(await makeRoot())
    evidence("c-fixtures.json", state.fixtures)
  }, 600_000)

  afterAll(async () => {
    if (!state.stack) return
    // Teams off (owners stop, locks go), then the temp root; the install itself is z-cleanup's.
    for (const teamID of state.teams.values()) {
      const answer = await team.raw("disable", { teamID }).catch(() => undefined)
      const opID = answer?.status === 200 ? (answer.body as { output?: { opID?: string } }).output?.opID : undefined
      if (opID) await team.opEnd(opID, { timeoutMs: 60_000, waiting: true }).catch(() => undefined)
    }
    const removed = state.fixtures ? await removeRoot(state.fixtures.root).catch(() => false) : true
    const after = await gitconfig().catch(() => "unreadable")
    evidence("c-gitconfig.json", { before: state.gitconfig, after })
    evidence("c-cleanup.json", { rootRemoved: removed, teams: [...state.teams.values()] })
    evidence("c-sink.txt", state.stack.sink.lines.join("\n"))
    evidence(
      "c-provider-requests.json",
      state.stack.chat.requests.map((request) => ({
        at: request.at,
        path: request.path,
        status: request.status,
        identity: request.identity,
      })),
    )
    // This PC's GitHub state is shared with phases D and E (OWN_HOME): the account (with its bindings and the default it
    // became), the host's write permission and the catalog read from the fake go.
    const forgotten = await forgetGitHub().catch((error: unknown) => String(error))
    // The Claude Agent items' accounts and their folders go too (OWN_HOME is shared with phases D and E).
    for (const account of state.agents ?? [])
      await state.stack
        .local(OwnAccounts.ID, "claudeAgent.remove", { accountID: account.accountID, deleteFolder: true })
        .catch(() => undefined)
    await local(state.stack, "disconnect", { hostId: state.hostId }).catch(() => undefined)
    evidence("c-local-server.log", state.stack.server.logs())
    evidence("c-github-fake.json", {
      mcp: state.github?.mcp,
      git: state.github?.git,
      storage: state.github?.storage,
    })
    await state.stack.stop()
    state.github?.stop()
    fs.rmSync(state.githubRepos, { recursive: true, force: true })
    // No method drops the catalog; the service is stopped, so the file is edited here.
    const file = path.join(OWN_HOME, "github.json")
    const left = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {}
    if ("catalog" in left) fs.writeFileSync(file, JSON.stringify({ ...left, catalog: undefined }, null, 2))
    evidence("c-github-cleanup.json", { forgotten, file: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null })
    expect(removed).toBe(true)
    expect(after).toBe(state.gitconfig)
    expect(forgotten).toBe(true)
  }, 300_000)

  test("the release carries own-team and the pinned git-lfs; own.team runs in the remote service in remote mode", async () => {
    evidence("c-release.json", { lfs: LFS ?? null, noLfs: NO_LFS })
    if (LFS === undefined && !NO_LFS)
      throw new Error(
        `${APP}\\remote has no tools.git-lfs: build the release with own/scripts/build-remote.ps1 (06 §4.13), or set OWN_REAL_HOST_TEAM_NO_LFS=1 to run the other items only`,
      )
    const health = await team.call("health", {})
    const manifest = JSON.parse(fs.readFileSync(path.join(APP, "remote", "manifest.json"), "utf8")) as {
      build_id: string
    }
    expect(health).toMatchObject({ guard: "ok", mode: "remote", buildId: manifest.build_id })
    // The managed config (04 §5.6): own-team third, in remote mode, then own-telemetry (04 §8.11.14, the relayed Claude
    // slot), own-harness (10 §6.1), own-omo (15 §1) and own-creator last (17 §10); the service env carries OWN_REMOTE=1.
    const config = await hostSh(String.raw`cat "$HOME/.config/own-open-code/opencode.json"
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
echo; echo "OWN_REMOTE=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^OWN_REMOTE=//p')"`)
    const managed = JSON.parse(config.stdout.slice(0, config.stdout.lastIndexOf("}") + 1)) as {
      plugins: Array<{ package: string; options: { mode: string } }>
    }
    evidence("c-health.json", { health, plugins: managed.plugins })
    expect(managed.plugins.map((plugin) => path.posix.basename(plugin.package))).toEqual([
      "own-accounts",
      "own-remote",
      "own-team",
      "own-telemetry",
      "own-harness",
      "own-omo",
      "own-creator",
    ])
    expect(managed.plugins[2]!.options.mode).toBe("remote")
    expect(managed.plugins[6]!.options.mode).toBe("remote")
    expect(kv(config.stdout).get("OWN_REMOTE")).toBe("1")
  }, 120_000)

  test("TG17 order: before lfs-remote the LFS repository gets no area (enable answers lfs_missing)", async () => {
    // A rerun after an aborted run may have left the tool behind: the order needs a host without it.
    await hostSh(`rm -rf -- '${state.ownHome}/tools'`)
    const lfs = state.fixtures.lfs
    const refused = await team.raw("enable", {
      directory: lfs.home,
      sessionID: SessionID.make(await enableSession(lfs.home)),
      hint: `[propose-areas 2 lfs-a lfs-b +heavy=${HEAVY.join(",")}]`,
    })
    const facts = kv(
      (
        await hostGit(`echo "WORKTREES=$(git -C '${lfs.home}' worktree list --porcelain | grep -c '^worktree ')"
echo "TEAM_ROOT=$([ -e '${lfs.home}-team' ] && echo present || echo absent)"
echo "FILTER=$(git -C '${lfs.home}' config --local --get filter.lfs.process || echo none)"`)
      ).stdout,
    )
    evidence("c-lfs-missing.json", { answer: refused, facts: Object.fromEntries(facts) })
    expect(refused.status).not.toBe(200)
    expect(errorOf(refused)?.type).toBe("lfs_missing")
    expect(facts.get("WORKTREES")).toBe("1")
    expect(facts.get("TEAM_ROOT")).toBe("absent")
    expect(facts.get("FILTER")).toBe("none")
  }, 120_000)

  lfsTest(
    "TG17: hosts.tools.ensure uploads the pinned static git-lfs (sha256 checked); it runs; after a restart the service PATH starts with its folder",
    async () => {
      const pinned = LFS!
      const first = await local(state.stack, "hosts.tools.ensure", { hostId: state.hostId, tool: "git-lfs" })
      expect(first).toEqual({ state: "uploaded", version: pinned.version })
      const tools = `${state.ownHome}/tools/git-lfs`
      const facts = kv(
        (
          await hostSh(`tools='${tools}'
echo "CURRENT=$(readlink "$tools/current")"
echo "SHA=$(sha256sum < "$tools/current/git-lfs" | cut -d ' ' -f 1)"
echo "VERSION=$("$tools/current/git-lfs" version 2>&1 | head -n 1)"
echo "STATIC=$(ldd "$tools/current/git-lfs" 2>&1 | grep -c 'not a dynamic executable')"
echo "MODES=$(stat -c '%a' "$tools" "$tools/current/git-lfs" | tr '\\n' ' ')"`)
        ).stdout,
      )
      const again = await local(state.stack, "hosts.tools.ensure", { hostId: state.hostId, tool: "git-lfs" })
      const record = (
        JSON.parse(fs.readFileSync(path.join(OWN_HOME, "remote", "hosts.json"), "utf8")) as {
          hosts: Array<{ id: string; pathPrepend: string[] }>
        }
      ).hosts.find((item) => item.id === state.hostId)!
      const pending = (await host()).pendingSettings
      evidence("c-tools.json", {
        first,
        again,
        facts: Object.fromEntries(facts),
        pathPrepend: record.pathPrepend,
        pending,
      })
      expect(facts.get("CURRENT")).toBe(pinned.version)
      expect(facts.get("SHA")).toBe(pinned.sha256)
      expect(facts.get("VERSION")).toStartWith(`git-lfs/${pinned.version} `)
      expect(facts.get("STATIC")).toBe("1")
      expect(facts.get("MODES")?.split(" ")[0]).toBe("700")
      expect(again).toEqual({ state: "present", version: pinned.version })
      expect(record.pathPrepend).toContain(`${tools}/current`)
      expect(pending).toBe(true)

      // 04 §6.4 설정 대기: the shells of the service get the folder after a restart.
      await drain()
      expect((await connect()).stage).toBe("ready")
      await resolve()
      const environ = kv(
        (
          await hostSh(
            String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
echo "PATH=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^PATH=//p')"`,
          )
        ).stdout,
      )
      evidence("c-tools-path.json", { path: environ.get("PATH") })
      expect(environ.get("PATH")?.startsWith(`${tools}/current:`)).toBe(true)
      expect((await host()).pendingSettings).toBe(false)
    },
    600_000,
  )

  lfsTest(
    "TG17/TG2/TG3 remote: enabling the LFS repository runs lfs-remote first; the local filter is the bundled git-lfs; code-only areas",
    async () => {
      const lfs = state.fixtures.lfs
      const tools = `${state.ownHome}/tools/git-lfs/current`
      const started = await team.call("enable", {
        directory: lfs.home,
        sessionID: SessionID.make(await enableSession(lfs.home)),
        hint: `[propose-areas 2 lfs-a lfs-b +heavy=${HEAVY.join(",")}]`,
      })
      const op = await team.opEnd(started.opID, { timeoutMs: OP_MS })
      evidence("c-lfs-enable.json", op)
      expect(op.state, steps(op)).toBe("done")
      const kinds = op.steps.map((step) => step.kind)
      const configured = kinds.indexOf("lfs-remote")
      expect(configured).toBeGreaterThanOrEqual(0)
      expect(op.steps[configured]!.state).toBe("done")
      expect(configured).toBeLessThan(kinds.indexOf("worktree-create"))

      const got = await view(lfs.home)
      expect(got.team?.env.lfs).toBe("own")
      expect(got.areas.map((area) => area.shape)).toEqual(["code", "code"])
      const facts = await lfsFacts(lfs.home, got.areas)
      evidence("c-lfs-areas.json", facts)
      expect(facts.filter).toBe(`'${tools}/git-lfs' filter-process`)
      expect(facts.smudge).toBe(`'${tools}/git-lfs' smudge -- %f`)
      expect(facts.required).toBe("true")
      // The shared store holds the cone's objects only: nothing of the heavy folders was downloaded (TG3).
      expect(facts.objects.toSorted()).toEqual(IN_CONE.map((file) => lfs.objects[file]).toSorted())
      expect(facts.locked).toBe(2)
      for (const area of facts.areas) {
        expect(area.status).toBe("")
        expect(area.heavy).toEqual([])
        for (const file of IN_CONE) expect(area.sizes[file]).toBe(LFS_FILES[file])
        expect(area.pointers).toBe(0)
      }

      // Enabling again converges: the same areas, no second worktree (TG2).
      const again = await team.call("enable", {
        directory: lfs.home,
        sessionID: SessionID.make(await enableSession(lfs.home)),
        hint: `[propose-areas 2 lfs-a lfs-b +heavy=${HEAVY.join(",")}]`,
      })
      const converged = await team.opEnd(again.opID, { timeoutMs: OP_MS })
      expect(converged.state, steps(converged)).toBe("done")
      const after = await view(lfs.home)
      expect(after.areas.map((area) => area.id).toSorted()).toEqual(got.areas.map((area) => area.id).toSorted())
      expect((await lfsFacts(lfs.home, after.areas)).worktrees).toBe(3)
      expect(await gitconfig()).toBe(state.gitconfig)
    },
    OP_MS * 3,
  )

  lfsTest(
    "TG17: an owner shell's `git add -A && git commit` in an LFS area stores a pointer blob",
    async () => {
      const lfs = state.fixtures.lfs
      const area = (await view(lfs.home)).areas[0]!
      // A shell without own's tools on PATH: the repository's local filter names the bundled git-lfs by its path.
      const made =
        await hostSh(`cd '${area.directory}' && env -i HOME="$HOME" PATH=/usr/bin:/bin sh -c 'head -c 4096 /dev/urandom > src/icons/new.png && git add -A && git commit -q -m "an icon from the owner shell" && echo COMMITTED=1'
echo "== blob"; git -C '${area.directory}' cat-file -p HEAD:src/icons/new.png | head -n 3
echo "== disk"; stat -c '%s' '${area.directory}/src/icons/new.png'`)
      const blob = section(made.stdout, "== blob")
      const oid = blob.find((line) => line.startsWith("oid sha256:"))?.slice("oid sha256:".length) ?? ""
      const stored = await hostSh(
        `f="$(git -C '${lfs.home}' rev-parse --path-format=absolute --git-common-dir)/lfs/objects/$(printf %s '${oid}' | cut -c1-2)/$(printf %s '${oid}' | cut -c3-4)/${oid}"; [ -f "$f" ] && echo STORED=$(stat -c %s "$f") || echo STORED=0`,
      )
      evidence("c-owner-commit.json", { stdout: made.stdout, stderr: made.stderr, stored: stored.stdout })
      expect(made.stdout).toContain("COMMITTED=1")
      expect(blob[0]).toBe(POINTER)
      expect(blob).toContain("size 4096")
      expect(section(made.stdout, "== disk")).toEqual(["4096"])
      expect(kv(stored.stdout).get("STORED")).toBe("4096")
    },
    120_000,
  )

  lfsTest(
    "TG4 remote: fetching more (area.paths): absent → fetched; present while the origin is offline → no download; over the threshold → confirm first; a failure leaves the cone as it was",
    async () => {
      const lfs = state.fixtures.lfs
      const got = await view(lfs.home)
      const [a, b] = got.areas as [Area, Area]
      const teamID = got.team!.id
      const objects = async () => (await lfsFacts(lfs.home, [])).objects.length
      const offline = (on: boolean) =>
        hostSh(on ? `mv '${lfs.origin}' '${lfs.origin}.offline'` : `mv '${lfs.origin}.offline' '${lfs.origin}'`)
      const paths = async (area: Area, dir: string) => {
        const started = await team.call("area.paths", { teamID, areaID: area.id, add: [dir] })
        return team.opEnd(started.opID, { timeoutMs: OP_MS, waiting: true })
      }

      // Absent: the two texture objects come from the origin; the files are real.
      const before = await objects()
      const fetched = await paths(a, "Assets/Textures")
      expect(fetched.state, steps(fetched)).toBe("done")
      expect(await objects()).toBe(before + 2)
      expect((await lfsFacts(lfs.home, [a])).areas[0]!.sizes["Assets/Textures/rock.png"]).toBe(
        LFS_FILES["Assets/Textures/rock.png"],
      )

      // Present: the other area takes the same folder with the origin gone.
      await offline(true)
      try {
        const present = await paths(b, "Assets/Textures")
        expect(present.state, steps(present)).toBe("done")
        expect((await lfsFacts(lfs.home, [b])).areas[0]!.sizes["Assets/Textures/tree.png"]).toBe(
          LFS_FILES["Assets/Textures/tree.png"],
        )
      } finally {
        await offline(false)
      }

      // Over the threshold: the op waits with a confirm and downloads nothing before it.
      const settings = await team.call("settings.get", { teamID })
      await team.call("settings.set", { teamID, patch: { policy: { askDownloadBytes: 1_000 } } })
      try {
        const waiting = await paths(a, "Assets/Audio")
        expect(waiting.state, steps(waiting)).toBe("waiting")
        const pending = waiting.steps.find((step) => step.confirm !== undefined)
        expect(pending?.confirm?.bytes).toBe(LFS_FILES["Assets/Audio/music.wav"])
        expect(await objects()).toBe(before + 2)
        await team.call("op.confirm", {
          opID: waiting.id,
          stepID: pending!.id,
          choice: "do",
          nonce: pending!.confirm!.nonce,
        })
        const confirmed = await team.opEnd(waiting.id, { timeoutMs: OP_MS })
        expect(confirmed.state, steps(confirmed)).toBe("done")
        expect(await objects()).toBe(before + 3)
      } finally {
        await team.call("settings.set", {
          teamID,
          patch: { policy: { askDownloadBytes: settings.policy.askDownloadBytes } },
        })
      }

      // A failure (offline, objects absent): the cone and the files are as before.
      const cone = (await lfsFacts(lfs.home, [a])).areas[0]!
      await offline(true)
      try {
        const failed = await paths(a, "Content")
        evidence("c-tg4-failed.json", failed)
        expect(failed.state, steps(failed)).toBe("failed")
        const now = (await lfsFacts(lfs.home, [a])).areas[0]!
        expect(now.cone).toEqual(cone.cone)
        expect(now.status).toBe("")
        expect(now.heavy).not.toContain("Content")
        expect(await objects()).toBe(before + 3)
      } finally {
        await offline(false)
      }
    },
    OP_MS * 6,
  )

  lfsTest(
    "TG11/TG17 remote: an LFS integration and its push run `git lfs push` before `git push`; an unreachable LFS endpoint pushes nothing",
    async () => {
      const lfs = state.fixtures.lfs
      const got = await view(lfs.home)
      const area = got.areas[0]!
      const teamID = got.team!.id
      const tip = await revParse(area.directory, "HEAD")
      const started = await team.call("area.integrate", { teamID, areaID: area.id })
      const op = await team.opEnd(started.opID, { timeoutMs: OP_MS })
      const integration = (await team.call("integration.get", { integrationID: started.integrationID })).integration
      evidence("c-lfs-integrate.json", { op, integration })
      expect(op.state, steps(op)).toBe("done")
      expect(integration).toMatchObject({ state: "done", how: "ff", candidate: tip })
      expect(await revParse(lfs.home, "refs/heads/main")).toBe(tip)

      const origin = () => revParse(lfs.origin, "refs/heads/main")
      const push = async () => {
        const plan = await team.call("integration.push.plan", { integrationID: started.integrationID })
        const executed = await team.raw("integration.push.execute", { nonce: plan.nonce })
        const opID = executed.status === 200 ? (executed.body as { output: { opID: string } }).output.opID : undefined
        return { plan, executed, op: opID === undefined ? undefined : await team.opEnd(opID, { timeoutMs: OP_MS }) }
      }
      // The LFS endpoint unreachable (a closed loopback port, one try): the objects step fails and the refs stay.
      const config = `git -C '${lfs.home}' config --local`
      await hostGit(
        `${config} lfs.url http://127.0.0.1:9/own-real-host-unreachable && ${config} lfs.transfer.maxretries 1 && ${config} lfs.transfer.maxretrydelay 1`,
      )
      const blocked = await push().finally(() =>
        hostGit(
          `${config} --unset lfs.url; ${config} --unset lfs.transfer.maxretries; ${config} --unset lfs.transfer.maxretrydelay`,
        ),
      )
      evidence("c-lfs-push-blocked.json", blocked)
      const commands = blocked.plan.commands
      expect(commands.findIndex((command) => command.includes("lfs push"))).toBeGreaterThanOrEqual(0)
      expect(commands.findIndex((command) => command.includes("lfs push"))).toBeLessThan(
        commands.findIndex((command) => /git push /.test(command)),
      )
      if (blocked.op) {
        expect(blocked.op.state).toBe("failed")
        expect(blocked.op.steps.find((step) => step.kind === "push")?.state).not.toBe("done")
      } else expect(errorOf(blocked.executed)?.type).toBe("remote_rejected")
      expect(await origin()).toBe(lfs.head)

      // Reachable again: objects first, then the ref; the origin has every object the new commit names.
      const pushed = await push()
      evidence("c-lfs-push.json", pushed)
      expect(pushed.op?.state, pushed.op ? steps(pushed.op) : JSON.stringify(pushed.executed)).toBe("done")
      expect(pushed.op!.steps.map((step) => step.kind)).toEqual(["push-lfs", "push"])
      expect(await origin()).toBe(tip)
      expect(await originMissing(lfs.home, lfs.origin, "main")).toEqual([])
    },
    OP_MS * 3,
  )

  test(
    "TG2/TG11 remote (code repository): enable with the Makefile check, a fast-forward integration and its push",
    async () => {
      const code = state.fixtures.code
      // The judge's answer as JSON (`[propose-reorg …]`): one area and the Makefile target as the team's code check (V10).
      const answer = { ...proposal(1, ["code-a"]), commands: { code: ["make typecheck"] } }
      const started = await team.call("enable", {
        directory: code.home,
        sessionID: SessionID.make(await enableSession(code.home)),
        hint: `[propose-reorg ${JSON.stringify(answer)}]`,
      })
      const op = await team.opEnd(started.opID, { timeoutMs: OP_MS })
      evidence("c-code-enable.json", op)
      expect(op.state, steps(op)).toBe("done")
      const got = await view(code.home)
      expect(got.team?.commands.code).toEqual([{ argv: ["make", "typecheck"] }])
      expect(got.team?.env.lfs).toBe("unused")
      const area = got.areas[0]!
      expect(got.areas).toHaveLength(1)

      const tip = await commitIn(area.directory, "docs/remote.md", "a change made in the area")
      const integrated = await team.call("area.integrate", { teamID: got.team!.id, areaID: area.id })
      const done = await team.opEnd(integrated.opID, { timeoutMs: OP_MS })
      const integration = (await team.call("integration.get", { integrationID: integrated.integrationID })).integration
      evidence("c-code-integrate.json", { op: done, integration })
      expect(done.state, steps(done)).toBe("done")
      expect(integration).toMatchObject({ state: "done", how: "ff", candidate: tip })
      expect(await revParse(code.home, "refs/heads/main")).toBe(tip)

      const plan = await team.call("integration.push.plan", { integrationID: integrated.integrationID })
      expect(plan.commands.some((command) => command.includes("lfs push"))).toBe(false)
      expect(await revParse(code.origin, "refs/heads/main")).toBe(code.head)
      const executed = await team.call("integration.push.execute", { nonce: plan.nonce })
      const pushed = await team.opEnd(executed.opID, { timeoutMs: OP_MS })
      expect(pushed.state, steps(pushed)).toBe("done")
      expect(await revParse(code.origin, "refs/heads/main")).toBe(tip)
    },
    OP_MS * 3,
  )

  test(
    "TG17: the SSH tunnel killed mid-integration: the op runs on in the host and is seen after the reconnect",
    async () => {
      const code = state.fixtures.code
      const got = await view(code.home)
      const area = got.areas[0]!
      const SECONDS = 45
      await hostSh(`echo ${SECONDS} > '${state.fixtures.slow}'`)
      try {
        const tip = await commitIn(area.directory, "docs/tunnel.md", "a change integrated across a tunnel drop")
        const started = await team.call("area.integrate", { teamID: got.team!.id, areaID: area.id })
        // The code check runs: the op is at integrate-verify and the Makefile sleep is a process of the host.
        await until(
          async () => {
            const op = (await team.call("op.get", { opID: started.opID })).op
            if (
              op.state !== "running" ||
              op.steps.find((step) => step.kind === "integrate-verify")?.state !== "pending"
            )
              return false
            const sleeping = await hostSh(`ps -u "$(id -u)" -o args= | grep -c '^sleep ${SECONDS}$' || true`)
            return Number(sleeping.stdout.trim()) >= 1
          },
          120_000,
          500,
        )
        const before = await host()
        const pidFile = path.join(OWN_HOME, "remote", state.hostId, "tunnel.pid")
        const tunnel = (JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid: number }).pid
        const killed = spawnSync("taskkill", ["/PID", String(tunnel), "/F"], { encoding: "utf8", windowsHide: true })
        expect(killed.status).toBe(0)
        // Without the tunnel the check still runs in the host's service (a separate helper ssh looks).
        const during = await hostSh(`ps -u "$(id -u)" -o args= | grep -c '^sleep ${SECONDS}$' || true`)
        const dropped = await until(
          async () => {
            const current = await host()
            return current.epoch !== before.epoch || current.stage !== "ready" ? current : undefined
          },
          60_000,
          250,
        )
        const back = await until(
          async () => {
            const current = await host()
            return current.stage === "ready" && current.epoch > before.epoch ? current : undefined
          },
          180_000,
          1_000,
        )
        await resolve()
        const op = await team.opEnd(started.opID, { timeoutMs: OP_MS })
        const integration = (await team.call("integration.get", { integrationID: started.integrationID })).integration
        evidence("c-tunnel-drop.json", {
          killed: tunnel,
          sleepingDuringDrop: during.stdout.trim(),
          dropped: { stage: dropped.stage, epoch: dropped.epoch },
          back: { stage: back.stage, epoch: back.epoch },
          op,
          integration,
        })
        expect(Number(during.stdout.trim())).toBeGreaterThanOrEqual(1)
        expect(op.state, steps(op)).toBe("done")
        expect(integration).toMatchObject({ state: "done", candidate: tip })
        expect(await revParse(code.home, "refs/heads/main")).toBe(tip)
      } finally {
        await hostSh(`echo 0 > '${state.fixtures.slow}'`)
      }
    },
    OP_MS * 3,
  )

  test("TG17 gateway /srv/<hostId>: a read device gets team.get; op.confirm, push and settings.set are refused as `local`", async () => {
    const code = state.fixtures.code
    const teamID = (await view(code.home)).team!.id
    const port = await freeLocalPort(40_000, 49_999)
    const planned = await local(state.stack, "gateway.configure.plan", { port, bind: "127.0.0.1" })
    const gateway = await local(state.stack, "gateway.configure.execute", { nonce: planned.nonce })
    try {
      expect(gateway.url).toBe(`http://127.0.0.1:${port}`)
      const device = await pairApp(state.stack, gateway.url!, { name: "원격 팀 읽기 폰", scopes: ["read"] })
      const route = (method: string) =>
        `/srv/${state.hostId}/api/rpc/${OwnTeam.ID}/${method}?location%5Bdirectory%5D=${encodeURIComponent(state.endpoint.controlDir)}`
      const read = await device.post(route("team.get"), { input: { directory: code.home } })
      const body = (await read.json()) as { output?: { team?: { id: string } } }
      const refused = await Promise.all(
        ["op.confirm", "integration.push.plan", "integration.push.execute", "settings.set"].map(async (method) => {
          const response = await device.post(route(method), { input: { teamID } })
          return {
            method,
            status: response.status,
            scope: ((await response.json()) as { data?: { scope?: string } }).data?.scope,
          }
        }),
      )
      evidence("c-gateway.json", { read: { status: read.status, team: body.output?.team?.id }, refused })
      expect(read.status).toBe(200)
      expect(body.output?.team?.id).toBe(teamID)
      for (const item of refused) expect(item).toEqual({ method: item.method, status: 403, scope: "local" })
      await local(state.stack, "devices.revoke", { deviceId: device.deviceId })
    } finally {
      await local(state.stack, "gateway.disable", {})
    }
  }, 180_000)

  test("07 PG2 on the remote: the mirrored presets drive the remote gate; nothing reaches a second ChatGPT subscription", async () => {
    // Two linked ChatGPT logins on this PC (fake tokens, 6 minutes left: never refreshed, never leased).
    const legacy = path.join(ROOT, "legacy-control-center")
    await writeCodexMultiProviderProfiles(legacy, [
      { id: "07", alias: "real-host-linked", tokens: mintChatGPTTokens(LINKED, Date.now(), 6 * 60_000) },
      { id: "08", alias: "real-host-linked-2", tokens: mintChatGPTTokens(LINKED_2, Date.now(), 6 * 60_000) },
    ])
    const linked = await Promise.all(
      (["07", "08"] as const).map(async (profileID) => {
        const plan = await accountsOutput(
          "accounts.import.codex.plan",
          await state.stack.localRaw("own.accounts", "accounts.import.codex.plan", { profileID, mode: "linked" }),
        )
        return (
          await accountsOutput(
            "accounts.import.codex.execute",
            await state.stack.localRaw("own.accounts", "accounts.import.codex.execute", {
              nonce: plan.nonce,
              label: `PG2 ${profileID}`,
            }),
          )
        ).account
      }),
    )
    const [first, second] = linked as [(typeof linked)[number], (typeof linked)[number]]
    expect(first.id).not.toBe(second.id)

    // (라) on this PC: a review preset of the ChatGPT group; a hand edit renames it and adds ChatGPT 02 before the main
    // (the new name tells when the remote has the edited file).
    const preset = {
      name: "PG2 원격 리뷰",
      group: "codex",
      workers: { mode: "by-role", roles: { "own-review": { targets: [{ rel: "main" }], effort: "inherit" } } },
      delegation: "when-useful",
      caps: Preset.CAPS,
      ultraCaps: null,
    }
    const saved = await accountsOutput(
      "presets.set",
      await state.stack.localRaw("own.accounts", "presets.set", { preset }),
    )
    const file = path.join(OWN_HOME, "presets.json")
    const renamed = "PG2 원격 리뷰 손으로 고침"
    // A hand edit of the parsed file (its layout is the service's): the new name and the 02 target first.
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      groups: Record<
        string,
        { presets?: Array<{ id: string; name: string; workers: { roles: Record<string, { targets: unknown[] }> } }> }
      >
    }
    const entry = stored.groups.codex?.presets?.find((item) => item.id === saved.preset.id)
    expect(entry).toBeDefined()
    entry!.name = renamed
    entry!.workers.roles["own-review"]!.targets = [{ pin: { account: second.id, model: "gpt-5.5" } }, { rel: "main" }]
    await replaceFile(file, JSON.stringify(stored, null, 2) + "\n")

    // The remote lists the mirrored, edited preset without the 02 target. The linked account reaches the remote's
    // model list through the broker a moment after the import (RL7): wait for it like the preset below.
    const main = await until(
      async () => {
        const remoteModels = (
          await remoteFetch(state.endpoint, "GET", "/api/model", { directory: state.fixtures.code.home })
        ).body as { data: Array<{ providerID: string; id: string }> }
        return remoteModels.data.find((model) => model.providerID === first.providerID)
      },
      120_000,
      1_000,
    )
    expect(main).toBeDefined()
    const listed = await until(
      async () => {
        const presets = await accountsOutput(
          "presets.list",
          await remoteAccounts(state.endpoint, "presets.list", { group: "codex" }),
        )
        const found = presets.groups.flatMap((group) => group.presets ?? []).find((item) => item.id === saved.preset.id)
        return found?.name === renamed ? found : undefined
      },
      120_000,
      1_000,
    )
    expect(JSON.stringify(listed)).not.toContain(second.id)

    // The remote gate: the review resolves on the main (01); a team with 01 and 02 is two subscriptions (R4).
    const sessionID = await remoteSession(state.endpoint, {
      directory: state.fixtures.code.home,
      title: "PG2 remote",
      model: { providerID: main!.providerID, id: main!.id },
    })
    const dryRun = await accountsOutput(
      "session.preset.apply",
      await remoteAccounts(state.endpoint, "session.preset.apply", {
        sessionID,
        presetID: saved.preset.id,
        dryRun: true,
      }),
    )
    const team2 = await remoteAccounts(state.endpoint, "session.preset.apply", {
      sessionID,
      presetID: Preset.builtinID("codex"),
      team: { teamID: "tm_pg2remote", role: "owner", accounts: [first.id, second.id], pinned: [] },
    })
    const save = await remoteAccounts(state.endpoint, "presets.set", { preset: { ...preset, name: "원격에서 저장" } })
    // This PC reads every ready ChatGPT account's Codex model list with its own token (02 §4.8: speed tiers follow
    // the plan), so a link reads 02's list once; that is no use of the subscription and the waits above leave it time
    // to happen (RL9). Every other request counts.
    const modelList = (request: { readonly method: string; readonly path: string }) =>
      request.method === "GET" && request.path.startsWith("/backend-api/codex/models")
    const toSecond = state.stack.codex.requests.filter(
      (request) =>
        !modelList(request) &&
        (request.identity === `codex:${LINKED_2.accountID}` ||
          request.headers["chatgpt-account-id"] === LINKED_2.accountID),
    )
    evidence("c-pg2-remote.json", {
      preset: listed,
      resolution: dryRun.resolution,
      team: { status: team2.status, error: errorOf(team2) },
      save: { status: save.status, error: errorOf(save) },
      requestsToSecond: toSecond.length,
      sink: state.stack.sink.lines.filter((line) => /chatgpt|openai/i.test(line)),
    })
    expect(dryRun.resolution?.roles["own-review"]?.use.providerID).toBe(first.providerID)
    expect(JSON.stringify(dryRun.resolution)).not.toContain(second.providerID)
    expect(errorOf(team2)).toMatchObject({ type: "same_company_subscription", data: { accountID: second.id } })
    expect(errorOf(save)?.type).toBe("remote_managed")
    expect(toSecond).toEqual([])
    expect(state.stack.sink.lines.filter((line) => /chatgpt|openai/i.test(line))).toEqual([])
  }, 300_000)

  // GitHub on the host (16 §8, GH-44, GH-52, MR10-4) ------------------------------------------------------------------

  /** own.accounts of this PC (the GitHub methods are the PC's: a host's own answer `remote_managed`). */
  const github = (method: string, input: unknown = {}) => state.stack.local(OwnAccounts.ID, method, input)
  /** Removes this phase's GitHub accounts (by label; their bindings and the default go with them) and host writes. */
  async function forgetGitHub() {
    const view = await github("github.view")
    const ours = (view.accounts as Array<{ id: string; label: string }>).filter((item) => item.label === GH_LABEL)
    for (const item of ours) await github("github.remove", { id: item.id })
    await github("github.settings.set", { writeHosts: [] })
    return true
  }
  /** The host's own-accounts log. */
  const hostAccountsLog = async () =>
    (await hostSh(`cat '${state.ownHome}/logs/own-accounts.log' 2>/dev/null || true`)).stdout
  /** Whether the host's Location of the GitHub folder offers these GitHub tools now (its last `github_tools_offered`). */
  const offered = async (counts: { readonly read: number; readonly write: number }) => {
    const last = (await hostAccountsLog())
      .split("\n")
      .filter((line) => line.includes("github_tools_offered"))
      .flatMap((line) => Option.toArray(decodeOffered(line)))
      .filter((line) => line.location === state.gh.dir)
      .at(-1)
    return last?.read === counts.read && last.write === counts.write
  }
  /** The Location query of the GitHub folder (core's shell routes take it like the RPC routes). */
  const ghQuery = () => `location%5Bdirectory%5D=${encodeURIComponent(state.gh.dir)}`
  /** A shell of the host's conversation in the GitHub folder (core's `!` path, so the service starts it). */
  const startShell = async (sessionID: string, command: string) => {
    const created = await remoteFetch(state.endpoint, "POST", `/api/shell?${ghQuery()}`, {
      body: { command, cwd: state.gh.dir, timeout: 180_000, metadata: { sessionID } },
      directory: state.gh.dir,
    })
    if (created.status !== 200) throw new Error(`shell: HTTP ${created.status} ${JSON.stringify(created.body)}`)
    const info = created.body as { data?: { id: string }; id?: string }
    return String(info.data?.id ?? info.id)
  }
  /** One shell command to its end: its exit code and output. */
  const hostShell = async (sessionID: string, command: string) => {
    const id = await startShell(sessionID, command)
    const read = async (route: string) => {
      const body = (await remoteFetch(state.endpoint, "GET", `${route}?${ghQuery()}`, { directory: state.gh.dir }))
        .body as { data?: Record<string, unknown> } & Record<string, unknown>
      return body.data ?? body
    }
    const done = await until(
      async () => {
        const value = await read(`/api/shell/${id}`)
        return value.status !== undefined && value.status !== "running" ? value : undefined
      },
      240_000,
      500,
    )
    const output = await read(`/api/shell/${id}/output`)
    return { code: done.exit as number | undefined, output: String(output.output ?? "") }
  }
  const githubSession = (title: string) =>
    remoteSession(state.endpoint, {
      directory: state.gh.dir,
      title,
      model: { providerID: state.alpha.providerID, id: MODEL },
    })
  /** A ref of the fake's bare repository on this PC (empty when missing). */
  const bareRef = (ref: string) =>
    spawnSync(
      "git",
      ["--git-dir", path.join(state.githubRepos, "octo", "hello.git"), "rev-parse", "--verify", "-q", ref],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim()

  test("GitHub on the host: the PC's account answers a Code Mode tool call of the host's conversation", async () => {
    // An account a stopped run left behind (the first one added becomes the default) goes first.
    await forgetGitHub()
    const added = await github("github.add.token", { token: GH_TOKEN, label: GH_LABEL })
    const account = String((added.accounts as Array<{ id: string; label: string }>).find((item) => item.label === GH_LABEL)!.id)
    await until(async () => ((await github("github.view")).catalog ? true : undefined), 60_000, 500)
    const dir = `${state.fixtures.root}/gh`
    expect((await hostSh(`mkdir -p '${dir}' && echo MADE=1`)).stdout).toContain("MADE=1")
    state.gh = { dir, account }
    const bound = await github("github.bind", {
      target: { type: "project", directory: dir, host: state.hostId },
      account,
    })
    expect(bound.projects).toContainEqual({ directory: dir, account, host: state.hostId })
    // The host's own `github.*` methods stay the PC's.
    const refused = await remoteFetch(state.endpoint, "POST", `/api/rpc/${OwnAccounts.ID}/github.view`, {
      body: { input: {} },
      directory: state.endpoint.controlDir,
    })
    expect(JSON.stringify(refused.body)).toContain("remote_managed")

    const sessionID = await githubSession("github on the host")
    // A session alone does not boot its Location; a shell does, and its GitHub tools register then.
    await hostShell(sessionID, "true")
    await until(() => offered({ read: 3, write: 0 }), 120_000, 1_000)
    const from = state.github.mcp.length
    await remoteFetch(state.endpoint, "POST", `/api/session/${sessionID}/prompt`, {
      body: { text: "[gh-get-me] who am I" },
      directory: dir,
    })
    await remoteFetch(state.endpoint, "POST", `/api/experimental/session/${sessionID}/wait`, { directory: dir })
    const calls = state.github.mcp.slice(from).filter((item) => item.method === "tools/call")
    evidence("c-github-tool.json", calls)
    expect(calls.map((item) => [item.login, item.tool, item.readOnly])).toEqual([["octo-work", "get_me", true]])
  }, 300_000)

  test("GitHub on the host: once the PC lets the host write, git in its shells pushes as the account", async () => {
    await github("github.update", { id: state.gh.account, write: true })
    await github("github.settings.set", { writeHosts: [state.hostId] })
    await until(() => offered({ read: 3, write: 2 }), 120_000, 1_000)
    const sessionID = await githubSession("git push on the host")
    const pushed = await hostShell(
      sessionID,
      [
        "set -e; rm -rf push; git init -q push; cd push",
        `git ${GH_IDENTITY} commit -q --allow-empty -m 'real host push'`,
        `git remote add origin '${GH_REPO}'; git push -q origin HEAD:refs/heads/main 2>&1`,
        'echo "HEAD=$(git rev-parse HEAD)"',
      ].join("\n"),
    )
    evidence("c-github-push.json", pushed)
    expect(`${pushed.code} ${pushed.output}`).toStartWith("0")
    expect(bareRef("refs/heads/main")).toBe(kv(pushed.output).get("HEAD")!)
    const pushers = state.github.git.filter((item) => item.service === "git-receive-pack").map((item) => item.login)
    expect(pushers).toContain("octo-work")
  }, 300_000)

  lfsTest(
    "GitHub on the host: LFS objects go up through the PC's relay to the storage and come back in a clone",
    async () => {
      const sessionID = await githubSession("git lfs on the host")
      const before = { storage: state.github.storage.length, git: state.github.git.length }
      const smudge = "-c filter.lfs.process='git-lfs filter-process' -c filter.lfs.smudge='git-lfs smudge -- %f'"
      const lfs = await hostShell(
        sessionID,
        [
          "set -e; rm -rf lfs back; git init -q lfs; cd lfs; git lfs install --local >/dev/null",
          "git lfs track '*.bin' >/dev/null; head -c 300000 /dev/urandom > data.bin; git add .gitattributes data.bin",
          `git ${GH_IDENTITY} commit -q -m 'real host lfs'; git remote add origin '${GH_REPO}'`,
          "git push -q origin HEAD:refs/heads/lfs 2>&1; cd ..",
          `git ${smudge} -c filter.lfs.required=true clone -q -b lfs '${GH_REPO}' back 2>&1`,
          "cmp lfs/data.bin back/data.bin && echo SAME=1",
        ].join("\n"),
      )
      const storage = state.github.storage.slice(before.storage)
      const batches = state.github.git.slice(before.git).filter((item) => item.service.startsWith("lfs-"))
      evidence("c-github-lfs.json", { shell: lfs, storage, batches })
      expect(`${lfs.code} ${lfs.output}`).toStartWith("0")
      expect(kv(lfs.output).get("SAME")).toBe("1")
      expect(storage.filter((item) => item.method === "PUT" && item.derived)).toHaveLength(1)
      expect(storage.filter((item) => item.method === "GET" && item.derived)).toHaveLength(1)
      expect(batches.map((item) => [item.login, item.service])).toEqual(
        expect.arrayContaining([
          ["octo-work", "lfs-upload"],
          ["octo-work", "lfs-download"],
        ]),
      )
    },
    300_000,
  )

  test("GitHub on the host: a ticket read out of another command's environment and a git outside the service are refused", async () => {
    const sessionID = await githubSession("tickets on the host")
    const holder = `${state.gh.dir}/holder.pid`
    await hostSh(`rm -f '${holder}'`)
    // The holder keeps its command (and so its ticket) alive while the next commands read it from /proc; it never uses
    // its ticket, so a thief that asks first would have kept it before the start binding (MR12-3).
    const holding = await startShell(sessionID, `echo $$ > '${holder}'; sleep 300`)
    try {
      await ticketsOnTheHost(sessionID, holder)
    } finally {
      // core's route that ends a command (`shell.remove`), then the process itself in case the route did not.
      const ended = await remoteFetch(state.endpoint, "DELETE", `/api/shell/${holding}?${ghQuery()}`, {
        directory: state.gh.dir,
      }).catch((error: unknown) => ({ status: 0, body: String(error) }))
      await Bun.sleep(300)
      const killed = await hostSh(`pid=$(cat '${holder}' 2>/dev/null); [ -n "$pid" ] && kill "$pid" 2>/dev/null; echo KILLED=$?`)
      evidence("c-github-holder.json", { ended, killed: killed.stdout })
      expect([200, 204]).toContain(ended.status)
    }
  }, 300_000)

  /** The GH-48 checks while the holder runs. */
  async function ticketsOnTheHost(sessionID: string, holder: string) {
    await until(
      async () => kv((await hostSh(`[ -s '${holder}' ] && echo HELD=1`)).stdout).get("HELD") === "1",
      60_000,
      500,
    )
    const steal = [
      `pid=$(cat '${holder}')`,
      String.raw`t1=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^GIT_CONFIG_VALUE_[0-9]*=X-Own-GitHub-Ticket: //p' | head -n 1)`,
      String.raw`stub=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^GIT_CONFIG_KEY_[0-9]*=http\.\(.*\)\.extraHeader$/\1/p' | head -n 1)`,
      '[ -n "$t1" ] && [ -n "$stub" ] && echo READ=1',
      String.raw`own=$(env | sed -n 's/^GIT_CONFIG_VALUE_[0-9]*=X-Own-GitHub-Ticket: //p' | head -n 1)`,
      '[ -n "$own" ] && [ "$own" != "$t1" ] && echo OWN_DIFFERS=1',
      'env -u GIT_CONFIG_COUNT GIT_TERMINAL_PROMPT=0 git -c "http.extraHeader=X-Own-GitHub-Ticket: $t1" ls-remote "${stub}github.com/octo/hello.git" 2>&1',
      'echo "STOLEN_EXIT=$?"',
    ].join("\n")
    // The command's own ticket works; another command's does not (GH-48: bound to the command that holds it).
    const before = state.github.git.length
    const own = await hostShell(sessionID, `git ls-remote '${GH_REPO}' 2>&1; echo "OWN_EXIT=$?"`)
    const reached = state.github.git.length - before
    const inside = await hostShell(sessionID, steal)
    // The command's top process starts itself again with the stolen ticket alone (`exec` rewrites its
    // /proc/<pid>/environ) and asks before the holder ever did: refused, since the ticket was bound to the holder's
    // process when it started (MR12-3).
    const execd = await hostShell(
      sessionID,
      [
        ...steal.split("\n").slice(0, 4),
        'exec env -i PATH="$PATH" HOME="$HOME" GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \\',
        '  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.${stub}.extraHeader" GIT_CONFIG_VALUE_0="X-Own-GitHub-Ticket: $t1" \\',
        `  sh -c 'git ls-remote "$0github.com/octo/hello.git" 2>&1; echo "EXEC_EXIT=$?"' "$stub"`,
      ].join("\n"),
    )
    // Outside the service (a plain ssh shell of the same user): no command of the service at all.
    const outside = await hostSh(`export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\n${steal}`)
    const refusals = (await hostAccountsLog()).split("\n").filter((line) => line.includes("github_git_relay_refused"))
    evidence("c-github-tickets.json", { own, inside, execd, outside, reached, refusals: refusals.slice(-6) })
    expect(kv(execd.output).get("READ")).toBe("1")
    expect(kv(execd.output).get("EXEC_EXIT")).not.toBe("0")
    expect(execd.output).toContain("403")
    const facts = kv(inside.output)
    expect(kv(own.output).get("OWN_EXIT")).toBe("0")
    expect(reached).toBeGreaterThan(0)
    expect(facts.get("READ")).toBe("1")
    expect(facts.get("OWN_DIFFERS")).toBe("1")
    expect(facts.get("STOLEN_EXIT")).not.toBe("0")
    expect(inside.output).toContain("403")
    expect(kv(outside.stdout).get("READ")).toBe("1")
    expect(kv(outside.stdout).get("STOLEN_EXIT")).not.toBe("0")
    expect(refusals.some((line) => line.includes('"reason":"command"'))).toBe(true)
    expect(refusals.some((line) => line.includes('"reason":"caller"'))).toBe(true)
    // Only the command's own ls-remote reached GitHub.
    expect(state.github.git.length - before).toBe(reached)
  }

  test("GitHub on the host: a host the PC lets read only cannot push, with or without an explicit push URL", async () => {
    await github("github.settings.set", { writeHosts: [] })
    await until(() => offered({ read: 3, write: 0 }), 120_000, 1_000)
    const sessionID = await githubSession("read-only host")
    const receives = () => state.github.git.filter((item) => item.service === "git-receive-pack").length
    const before = receives()
    const refused = await hostShell(
      sessionID,
      [
        "rm -rf ro; git init -q ro; cd ro",
        `git ${GH_IDENTITY} commit -q --allow-empty -m 'read only'; git remote add origin '${GH_REPO}'`,
        'git push origin HEAD:refs/heads/ro 2>&1; echo "INSTEADOF_EXIT=$?"',
        `git -c remote.origin.pushurl='${GH_REPO}' push origin HEAD:refs/heads/ro 2>&1; echo "PUSHURL_EXIT=$?"`,
      ].join("\n"),
    )
    evidence("c-github-read-only.json", refused)
    const facts = kv(refused.output)
    expect(facts.get("INSTEADOF_EXIT")).not.toBe("0")
    expect(refused.output).toContain("github-account-is-read-only")
    expect(facts.get("PUSHURL_EXIT")).not.toBe("0")
    expect(refused.output).toContain("403")
    expect(receives()).toBe(before)
    expect(bareRef("refs/heads/ro")).toBe("")
  }, 300_000)

  test("GitHub on the host: no token anywhere on the host (files, logs, git's and gh's stores, history, processes)", async () => {
    // Every form own masks (GH-30): the token, git's Basic login, their base64 at each alignment and alphabet. They go
    // to grep through a file in a fresh temp folder (not scanned, removed at exit), never on a command line.
    const forms = GitHubMask.loginForms(GH_LOGIN, GH_TOKEN)
    const found = await hostSh(
      [
        'dir=$(mktemp -d) || { echo SCAN_FAILED=mktemp; exit 1; }',
        `trap 'rm -rf "$dir"' EXIT`,
        `cat > "$dir/forms" <<'OWN_FORMS'`,
        ...forms,
        "OWN_FORMS",
        String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)`,
        'uid=$(id -u)',
        'for d in "$HOME/.local/share/own-open-code" "$HOME/.local/state/own-open-code" "$HOME/.config/own-open-code" \\',
        '         "$HOME/.local/share/opencode" "$HOME/.local/state/opencode" "$HOME/.config/opencode" "$HOME/.cache/opencode" \\',
        '         /tmp/own-"$uid" /tmp/own-"$uid"-* "$HOME/.git-credentials" "$HOME/.netrc" "$HOME/.config/gh" \\',
        '         "$HOME/.config/git" "$HOME/.bash_history" "$HOME/.zsh_history" "$HOME/.sh_history" "$HOME/.ash_history" \\',
        '         "$HOME/.local/share/fish" /dev/shm; do',
        `  [ -e "$d" ] && grep -rlaF -f "$dir/forms" "$d" 2>/dev/null | sed 's/^/HIT /'`,
        "done",
        // The service's environment must be read: an unreadable one is no proof (it would count 0).
        String.raw`if [ -n "$pid" ] && tr '\0' '\n' < "/proc/$pid/environ" > "$dir/service" 2>/dev/null; then`,
        `  echo "ENVIRON=$(grep -caF -f "$dir/forms" "$dir/service")"`,
        "else",
        '  echo "ENVIRON=unreadable:$pid"',
        "fi",
        // Every other process of this user: its environment and its words.
        "for p in /proc/[0-9]*; do",
        '  n=${p#/proc/}',
        '  [ "$n" = "$$" ] && continue',
        '  [ "$(stat -c %u "$p" 2>/dev/null)" = "$uid" ] || continue',
        "  for k in environ cmdline; do",
        String.raw`    if tr '\0' '\n' < "$p/$k" > "$dir/one" 2>/dev/null; then`,
        `      grep -qaF -f "$dir/forms" "$dir/one" && echo "PROC_HIT $n $k"`,
        '    elif [ -e "$p" ]; then',
        '      echo "PROC_UNREADABLE $n $k"',
        "    fi",
        "  done",
        "done",
        "echo SCANNED=1",
      ].join("\n"),
    )
    evidence("c-github-token-scan.txt", `${found.stdout}\n--- stderr\n${found.stderr}`)
    expect(kv(found.stdout).get("SCANNED")).toBe("1")
    expect(found.stdout.split("\n").filter((line) => line.startsWith("HIT ") || line.startsWith("PROC_HIT "))).toEqual([])
    expect(kv(found.stdout).get("ENVIRON")).toBe("0")
    // Nor did a model request of the host's conversations carry it.
    for (const request of state.stack.chat.requests) expect(request.body).not.toContain(GH_TOKEN)
  }, 120_000)

  // ---------------------------------------------------------------------------------------------------------------
  // Claude Agent on the host (02 §8.10.13, CAG-R): claude on this PC, the tools on the host

  // Every Claude login file under the places a host service or Claude Code would keep one, with its time.
  const AGENT_CREDENTIALS = [
    'for d in "$HOME/.local/share/own-open-code" "$HOME/.local/state/own-open-code" "$HOME/.config/own-open-code" \\',
    '         "$HOME/.local/share/opencode" "$HOME/.local/state/opencode" "$HOME/.config/opencode" "$HOME/.cache/opencode" \\',
    '         /tmp/own-"$(id -u)" /tmp/own-"$(id -u)"-* "$HOME/.claude" /dev/shm; do',
    `  [ -e "$d" ] && find "$d" -name .credentials.json -printf 'CREDENTIALS %p %T@\\n' 2>/dev/null`,
    "done",
    "true",
  ].join("\n")

  const agentRuns = (folder: string) => {
    const file = path.join(folder, "fake-claude-runs.jsonl")
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; env: string[] })
      .filter((item) => item.args.includes("--include-partial-messages"))
  }
  const agentFlag = (item: { args: string[] }, name: string) =>
    item.args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  const agentTurn = async (sessionID: string, directory: string, text: string) => {
    await remoteFetch(state.endpoint, "POST", `/api/session/${sessionID}/prompt`, { body: { text }, directory })
    await remoteFetch(state.endpoint, "POST", `/api/experimental/session/${sessionID}/wait`, { directory })
    return JSON.stringify((await remoteFetch(state.endpoint, "GET", `/api/session/${sessionID}/message`, { directory })).body)
  }
  const agentServed = (directory: string) =>
    until(
      async () => {
        const listed = await remoteFetch(state.endpoint, "GET", "/api/model", { directory })
        const models = ((listed.body as { data?: Array<{ providerID: string; id: string }> }).data ?? [])
        return models.some((model) => model.providerID === "claude-agent" && model.id === "sonnet") ? true : undefined
      },
      120_000,
      1_000,
    )

  test("Claude Agent on the host: a host conversation's claude runs on this PC, its read tool on the host", async () => {
    // The host user may have a Claude Code login of their own (build-host has `~/.claude/.credentials.json` from
    // before these items, RL3-C1): the scan below counts only login files that appear or change from here on.
    state.agentCredentials = (await hostSh(AGENT_CREDENTIALS)).stdout
      .split("\n")
      .filter((line) => line.startsWith("CREDENTIALS "))
    evidence("c-agent-credentials-before.txt", state.agentCredentials.join("\n"))
    await state.stack.local(OwnAccounts.ID, "claudeAgent.setup", {})
    const made = await state.stack.local(OwnAccounts.ID, "claudeAgent.setup", { add: true })
    state.agents = (made.accounts as Array<{ accountID: string; folder: string }>).slice(-2)
    state.agents.forEach((account, index) =>
      fs.writeFileSync(
        path.join(account.folder, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: CA_TOKENS[index], refreshToken: "fake-refresh" } }),
      ),
    )
    const dir = `${state.fixtures.root}/agent`
    expect((await hostSh(`mkdir -p '${dir}' && printf 'MARKER-ON-THE-REAL-HOST-4471\\n' > '${dir}/host-only.txt' && echo MADE=1`)).stdout).toContain("MADE=1")
    await agentServed(dir)
    state.agentSession = await remoteSession(state.endpoint, {
      directory: dir,
      title: "claude agent on the host",
      model: { providerID: "claude-agent", id: "sonnet" },
    })
    const before = agentRuns(state.agents[0]!.folder).length
    const text = await agentTurn(state.agentSession, dir, `TOOL read ${JSON.stringify({ path: `${dir}/host-only.txt` })}`)
    evidence("c-agent-turn.json", text)
    expect(text).toContain("MARKER-ON-THE-REAL-HOST-4471")
    const chat = agentRuns(state.agents[0]!.folder).slice(before).at(-1)!
    evidence("c-agent-run.json", chat)
    state.agentClaude = agentFlag(chat, "--session-id") ?? agentFlag(chat, "--resume")
    expect(path.resolve(chat.cwd).toLowerCase()).toStartWith(path.join(OWN_HOME, "claude-agent", "hosts").toLowerCase())
    expect(chat.args).toContain("--tools=")
  }, 300_000)

  test("Claude Agent on the host: after a reconnect, then on the second account, the same Claude conversation resumes", async () => {
    const dir = `${state.fixtures.root}/agent`
    await local(state.stack, "disconnect", { hostId: state.hostId })
    await until(async () => ((await host()).stage === "disconnected" ? true : undefined), 60_000, 1_000)
    expect((await connect()).stage).toBe("ready")
    await resolve()
    await agentServed(dir)
    const first = agentRuns(state.agents![0]!.folder).length
    expect(await agentTurn(state.agentSession!, dir, "after the reconnect")).toContain("ECHO after the reconnect")
    expect(agentFlag(agentRuns(state.agents![0]!.folder).slice(first).at(-1)!, "--resume")).toBe(state.agentClaude)
    const moved = await remoteFetch(state.endpoint, "POST", `/api/rpc/${OwnAccounts.ID}/claudeAgent.session.set`, {
      body: { input: { sessionID: state.agentSession, accountID: state.agents![1]!.accountID } },
      directory: dir,
    })
    expect(moved.status).toBe(200)
    const second = agentRuns(state.agents![1]!.folder).length
    expect(await agentTurn(state.agentSession!, dir, "on the second account")).toContain("ECHO on the second account")
    expect(agentFlag(agentRuns(state.agents![1]!.folder).slice(second).at(-1)!, "--resume")).toBe(state.agentClaude)
  }, 420_000)

  test("Claude Agent on the host: no Claude login, token or e-mail anywhere on the host (files, processes)", async () => {
    const found = await hostSh(
      [
        'dir=$(mktemp -d) || { echo SCAN_FAILED=mktemp; exit 1; }',
        `trap 'rm -rf "$dir"' EXIT`,
        `cat > "$dir/forms" <<'OWN_FORMS'`,
        ...CA_TOKENS,
        CA_EMAIL,
        "OWN_FORMS",
        'uid=$(id -u)',
        'for d in "$HOME/.local/share/own-open-code" "$HOME/.local/state/own-open-code" "$HOME/.config/own-open-code" \\',
        '         "$HOME/.local/share/opencode" "$HOME/.local/state/opencode" "$HOME/.config/opencode" "$HOME/.cache/opencode" \\',
        '         /tmp/own-"$uid" /tmp/own-"$uid"-* "$HOME/.claude" /dev/shm; do',
        `  [ -e "$d" ] && grep -rlaF -f "$dir/forms" "$d" 2>/dev/null | sed 's/^/HIT /'`,
        "done",
        AGENT_CREDENTIALS,
        "for p in /proc/[0-9]*; do",
        '  [ "$(stat -c %u "$p" 2>/dev/null)" = "$uid" ] || continue',
        "  tr '\\0' '\\n' < \"$p/environ\" 2>/dev/null | grep -qaF -f \"$dir/forms\" && echo \"PROC_HIT ${p#/proc/}\"",
        "done",
        "echo SCANNED=1",
      ].join("\n"),
    )
    evidence("c-agent-scan.txt", `${found.stdout}\n--- stderr\n${found.stderr}`)
    expect(kv(found.stdout).get("SCANNED")).toBe("1")
    expect(found.stdout.split("\n").filter((line) => /^(HIT|PROC_HIT) /.test(line))).toEqual([])
    // A login file that was there before with the same time is the host user's own; a new or changed one is a leak.
    const before = new Set(state.agentCredentials ?? [])
    expect(found.stdout.split("\n").filter((line) => line.startsWith("CREDENTIALS ") && !before.has(line))).toEqual([])
  }, 120_000)
})
