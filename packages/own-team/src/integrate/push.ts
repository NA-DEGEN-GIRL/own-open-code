export * as Push from "./push.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { GitHubBridge } from "@own/runtime"
import { Git } from "../git/run.js"
import { Confirm } from "../ops/confirm.js"
import type { Steps } from "../ops/steps.js"
import { Services } from "../services.js"
import { Advance } from "./advance.js"
import { Journal } from "../ops/journal.js"

/**
 * 원격에 올리기와 검토 요청 (06 §7.5). Never automatic: `integration.push.plan` shows the remote, the ref and the
 * commands and returns a 10-minute nonce (`ops/confirm.ts`); only `integration.push.execute{nonce}` with that nonce
 * starts the push (both `local` scope: the PC only, never a gateway device, 2.7). A nonce is used once; a wrong or
 * expired one is `nonce_invalid` and the client asks for a new plan.
 *
 * The push op (kind `integrate`, by the user) runs:
 *   push-lfs  in an LFS repository (`git ls-files ':(attr:filter=lfs)'` prints a line, 4.2): `git lfs push <remote>
 *             <ref>` first; a failure stops the op, so no pointer commit goes up without its objects (4.13)
 *   push      `git push <remote> <ref>`: the target, or the area's branch for a review request
 *   push-pr   `gh pr create --base <target> --head <area branch> --fill` when `gh` is there, else the compare page's
 *             URL for the client to open (⚠ GitHub-style hosts only)
 *
 * Every remote command runs without any prompt: `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` (`git/run.ts`),
 * and no askpass program. A remote that wants a login fails with `remote_rejected` and `터미널에서 한 번 로그인해
 * 주세요`. Where own has a GitHub account for the area's folder (16 §6), git logs in to its site with it, and
 * `gh pr create` runs as it (`GitHubBridge`); elsewhere the user's own git and gh logins apply. Plans live in the
 * controller's memory: after a restart the user asks for a new plan.
 */

export const KIND = { lfs: "push-lfs", push: "push", pr: "push-pr" } as const

/** Shown with a push that needs a login (7.5). */
export const LOGIN = "원격 저장소에 로그인이 필요해요. 터미널에서 한 번 로그인해 주세요"

export interface Deps {
  /** The `gh` command (argv prefix), or `null` when it is not installed. {@link defaults}: `gh` on `PATH`. */
  readonly gh: () => ReadonlyArray<string> | null
}

export function defaults(): Deps {
  return {
    gh: () => {
      const found = Bun.which("gh")
      return found ? [found] : null
    },
  }
}

/** Registers the three push step kinds once per controller. */
export function register(services: Services.Context, deps: Deps) {
  if (!services.steps.get(KIND.lfs)) services.steps.register(lfsKind())
  if (!services.steps.get(KIND.push)) services.steps.register(pushKind())
  if (!services.steps.get(KIND.pr)) services.steps.register(prKind(deps))
}

/** What a confirmed plan pushes. */
export interface Planned {
  readonly confirm: OwnTeam.StepConfirm
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  readonly integrationID: OwnTeam.IntegrationID
  readonly remote: string
  /** The target, or the area's branch for a review request. */
  readonly ref: string
  readonly lfs: boolean
  readonly pr?: { readonly base: string; readonly head: string; readonly gh: boolean; readonly url?: string }
  readonly commands: ReadonlyArray<string>
}

/** Plans by nonce, per controller (`Services.Base`). */
const plans = new WeakMap<object, Map<string, Planned>>()

/** `integration.push.plan`: what would run, and the nonce that runs it. */
export async function plan(
  services: Services.Base,
  deps: Deps,
  input: { readonly integrationID: string; readonly pr?: boolean },
): Promise<
  Services.Result<{
    readonly nonce: string
    readonly expiresAt: number
    readonly remote: string
    readonly ref: string
    readonly commands: ReadonlyArray<string>
  }>
> {
  const integration = await Advance.find(services, input.integrationID)
  if (!integration)
    return Services.failure("not_found", "integration not found", { what: "integration", id: input.integrationID })
  const team = await services.registry.teams.get(integration.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: integration.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  if (integration.state !== "done" || !integration.advanced) return Services.unsupported("integration.push")
  const area = await services.registry.areas.get(team.id, integration.areaID)
  if (input.pr && !area)
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: integration.areaID })
  const home = team.home.directory
  const remote = await remoteOf(home, integration.target)
  if (remote === undefined) return Services.failure("not_found", "no remote to push to", { what: "remote", id: "" })
  const lfs = await usesLfs(home)
  if (lfs && !(await lfsInstalled(home)))
    return Services.failure("lfs_missing", "git-lfs is needed to push this repository", {
      tool: "git-lfs",
      version: null,
    })

  const target = integration.target
  const ref = input.pr && area ? area.branch : target
  const gh = input.pr ? deps.gh() !== null : false
  const url = input.pr && area && !gh ? compareUrl(await fetchUrl(home, remote), target, area.branch) : undefined
  const pr =
    input.pr && area ? { base: target, head: area.branch, gh, ...(url === undefined ? {} : { url }) } : undefined
  const commands = [
    ...(lfs ? [`git lfs push ${remote} ${ref}`] : []),
    `git push ${remote} ${ref}`,
    ...(pr?.gh ? [`gh pr create --base ${pr.base} --head ${pr.head} --fill`] : []),
    ...(pr?.url === undefined ? [] : [pr.url]),
  ]
  const now = services.clock.now()
  const confirm = Confirm.issue({ text: input.pr ? "검토 요청을 올릴까요?" : "원격 저장소에 올릴까요?" }, now)
  const stored = plans.get(services) ?? new Map<string, Planned>()
  plans.set(services, stored)
  // Expired plans go whenever a new one is made.
  stored.forEach((item, nonce) => {
    if (item.confirm.expiresAt <= now) stored.delete(nonce)
  })
  stored.set(confirm.nonce, {
    confirm,
    teamID: team.id,
    areaID: integration.areaID,
    integrationID: integration.id,
    remote,
    ref,
    lfs,
    ...(pr === undefined ? {} : { pr }),
    commands,
  })
  return { ok: true, nonce: confirm.nonce, expiresAt: confirm.expiresAt, remote, ref, commands }
}

/** `integration.push.execute{nonce}`: the planned push as an op, only with the plan's unexpired nonce (used once). */
export async function execute(
  services: Services.Context,
  input: { readonly nonce: string },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const stored = plans.get(services)
  const planned = stored?.get(input.nonce)
  const checked = Confirm.check(planned?.confirm, input.nonce, services.clock.now())
  if (checked === "expired") stored?.delete(input.nonce)
  if (checked !== "ok" || !planned) return Services.failure("nonce_invalid", "the push plan is unknown or expired", {})
  const args = { integrationID: planned.integrationID, remote: planned.remote, ref: planned.ref }
  const started = await services.runner.start({
    teamID: planned.teamID,
    kind: "integrate",
    by: "user",
    areaID: planned.areaID,
    undo: { available: false },
    steps: [
      ...(planned.lfs ? [{ id: "lfs", kind: KIND.lfs, args }] : []),
      { id: "push", kind: KIND.push, args: { ...args, pr: planned.pr !== undefined } },
      ...(planned.pr
        ? [
            {
              id: "pr",
              kind: KIND.pr,
              args: { integrationID: planned.integrationID, remote: planned.remote, ...planned.pr },
            },
          ]
        : []),
    ],
  })
  if (!started.ok) return Services.failure("busy", "another team op is running", Journal.busy(started.op))
  stored?.delete(input.nonce)
  return { ok: true, opID: started.op.id }
}

// ---------------------------------------------------------------------------------------------------------------
// git

/** No askpass program: a remote that needs a login fails instead of opening a window (7.5). */
const PROMPTLESS = { GIT_ASKPASS: "", SSH_ASKPASS: "" }

/** `git lfs push <remote> <ref>` (4.13): every LFS object the ref needs, before the commits go up. */
export async function lfsPush(directory: string, remote: string, ref: string, signal?: AbortSignal) {
  // The GitHub login (16 §6) ends with the command.
  const login = new AbortController()
  const spawned = Promise.withResolvers<number | undefined>()
  const github = await GitHubBridge.gitEnv(directory, { signal: login.signal, pid: spawned.promise })
  const result = await Git.run(["-c", "core.askPass=", "lfs", "push", remote, ref], {
    cwd: directory,
    write: true,
    worktree: true,
    env: { ...PROMPTLESS, ...github },
    signal,
    onSpawn: spawned.resolve,
  }).finally(() => {
    spawned.resolve(undefined)
    login.abort()
  })
  return result.ok ? ({ ok: true } as const) : rejected(remote, result)
}

/** `git push <remote> <ref>`. */
export async function gitPush(directory: string, remote: string, ref: string, signal?: AbortSignal) {
  // The GitHub login (16 §6) ends with the command.
  const login = new AbortController()
  const spawned = Promise.withResolvers<number | undefined>()
  const github = await GitHubBridge.gitEnv(directory, { signal: login.signal, pid: spawned.promise })
  const result = await Git.run(["-c", "core.askPass=", "push", remote, ref], {
    cwd: directory,
    write: true,
    worktree: true,
    env: { ...PROMPTLESS, ...github },
    signal,
    onSpawn: spawned.resolve,
  }).finally(() => {
    spawned.resolve(undefined)
    login.abort()
  })
  return result.ok ? ({ ok: true } as const) : rejected(remote, result)
}

/** A refused push in front of git's message (kept for 자세히); one that wanted a login says so (7.5). */
function rejected(remote: string, result: { readonly stderr: string; readonly message: string }): Services.Failure {
  const message = `${LOGIN_NEEDED.test(result.stderr) ? LOGIN : "원격 저장소가 받지 않았어요"}: ${result.message}`
  return Services.failure("remote_rejected", message, { remote, message })
}

/** What git, git-lfs and Git Credential Manager print when a remote wanted a login that could not be asked for. */
const LOGIN_NEEDED =
  /terminal prompts disabled|could not read (?:username|password)|authentication failed|invalid username or password|permission denied \(publickey|\b40[13]\b/i

/** `branch.<target>.remote`, else `origin`, else the only remote; `undefined` without one. */
export async function remoteOf(directory: string, target: string) {
  const options = { cwd: directory, worktree: true }
  const [configured, listed] = await Promise.all([
    Git.run(["config", "--get", `branch.${target}.remote`], options),
    Git.run(["remote"], options),
  ])
  const names = listed.ok
    ? listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : []
  const chosen = configured.ok ? configured.stdout.trim() : ""
  if (names.includes(chosen)) return chosen
  if (names.includes("origin")) return "origin"
  return names.length === 1 ? names[0] : undefined
}

/** The remote's fetch URL (`remote get-url`), `""` when unknown. */
async function fetchUrl(directory: string, remote: string) {
  const result = await Git.run(["remote", "get-url", remote], { cwd: directory, worktree: true })
  return result.ok ? result.stdout.trim() : ""
}

/** The repository uses LFS: a tracked file has `filter=lfs` (4.2). */
export async function usesLfs(directory: string) {
  const result = await Git.run(["ls-files", "-z", "--", ":(attr:filter=lfs)"], { cwd: directory, worktree: true })
  return result.ok && result.stdout.length > 0
}

async function lfsInstalled(directory: string) {
  return (await Git.run(["lfs", "version"], { cwd: directory, worktree: true })).ok
}

/**
 * The compare page of a GitHub-style host (`https://host/owner/repo/compare/<base>...<head>?expand=1`) from an
 * `https://`, `ssh://` or `user@host:path` remote URL; `undefined` for local paths and `file://`.
 */
export function compareUrl(remoteUrl: string, base: string, head: string) {
  const site = web(remoteUrl)
  return site === undefined ? undefined : `${site}/compare/${base}...${head}?expand=1`
}

function web(url: string) {
  const match =
    /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url) ??
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ??
    // `git@host:owner/repo`; a host of one letter is a Windows drive (`C:/…`).
    /^(?:[^@/\\]+@)?([^:/\\]{2,}):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(url)
  return match ? `https://${match[1]}/${match[2]}` : undefined
}

/** `gh pr create`, without prompts; the review request's URL, or `undefined` when it failed. */
async function ghCreate(
  gh: ReadonlyArray<string>,
  input: { readonly directory: string; readonly base: string; readonly head: string; readonly signal?: AbortSignal },
) {
  const timer = AbortSignal.timeout(Git.WRITE_TIMEOUT_MS)
  const login = new AbortController()
  const spawned = Promise.withResolvers<number | undefined>()
  const github = await GitHubBridge.gitEnv(input.directory, { gh: true, signal: login.signal, pid: spawned.promise })
  const proc = Bun.spawn([...gh, "pr", "create", "--base", input.base, "--head", input.head, "--fill"], {
    cwd: input.directory,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    signal: input.signal ? AbortSignal.any([input.signal, timer]) : timer,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      ...PROMPTLESS,
      ...github,
    },
  })
  spawned.resolve(proc.pid)
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).finally(() =>
    login.abort(),
  )
  if (code !== 0) return undefined
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => /^https?:\/\//.test(line))
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const PushArgs = Schema.Struct({ integrationID: OwnTeam.IntegrationID, remote: Schema.String, ref: Schema.String })
const decodePush = Schema.decodeUnknownOption(
  Schema.Struct({ ...PushArgs.fields, pr: Schema.optional(Schema.Boolean) }),
)
const decodePr = Schema.decodeUnknownOption(
  Schema.Struct({
    integrationID: OwnTeam.IntegrationID,
    remote: Schema.String,
    base: Schema.String,
    head: Schema.String,
    gh: Schema.Boolean,
    url: Schema.optional(Schema.String),
  }),
)

const INVALID = { state: "failed" as const, note: "단계 정보가 맞지 않아요" }

function lfsKind(): Steps.Kind {
  return {
    kind: KIND.lfs,
    // `git lfs push` sends only what the remote lacks, so running it again after a restart is the resume.
    observe: async (input) => (Option.isSome(decodePush(input.step.args)) ? { state: "pending" } : INVALID),
    act: async (input) => {
      const args = Option.getOrThrow(decodePush(input.step.args))
      const team = await input.services.registry.teams.get(input.op.teamID)
      if (!team) return { ok: false, note: "팀을 찾을 수 없어요" }
      const pushed = await lfsPush(team.home.directory, args.remote, args.ref, input.signal)
      return pushed.ok ? { ok: true } : { ok: false, note: pushed.message }
    },
    verify: async () => ({ ok: true }),
  }
}

function pushKind(): Steps.Kind {
  return {
    kind: KIND.push,
    observe: async (input) => (Option.isSome(decodePush(input.step.args)) ? { state: "pending" } : INVALID),
    act: async (input) => {
      const args = Option.getOrThrow(decodePush(input.step.args))
      const services = input.services
      const team = await services.registry.teams.get(input.op.teamID)
      if (!team) return { ok: false, note: "팀을 찾을 수 없어요" }
      const pushed = await gitPush(team.home.directory, args.remote, args.ref, input.signal)
      if (!pushed.ok) return { ok: false, note: pushed.message }
      // A review request is recorded by `push-pr`, with its page.
      if (args.pr) return { ok: true }
      await recordPushed(input, { integrationID: args.integrationID, remote: args.remote, ref: args.ref })
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

function prKind(deps: Deps): Steps.Kind {
  return {
    kind: KIND.pr,
    observe: async (input) => (Option.isSome(decodePr(input.step.args)) ? { state: "pending" } : INVALID),
    act: async (input) => {
      const args = Option.getOrThrow(decodePr(input.step.args))
      const team = await input.services.registry.teams.get(input.op.teamID)
      if (!team) return { ok: false, note: "팀을 찾을 수 없어요" }
      const gh = deps.gh()
      const created =
        gh === null
          ? undefined
          : await ghCreate(gh, {
              directory: team.home.directory,
              base: args.base,
              head: args.head,
              signal: input.signal,
            })
      const page =
        created ?? args.url ?? compareUrl(await fetchUrl(team.home.directory, args.remote), args.base, args.head)
      await recordPushed(input, {
        integrationID: args.integrationID,
        remote: args.remote,
        ref: args.head,
        ...(page === undefined ? {} : { pr: page }),
      })
      return { ok: true, note: created ? "gh pr create" : "비교 페이지" }
    },
    verify: async () => ({ ok: true }),
  }
}

/** `Integration.pushed` and the card's `pushed` line. */
async function recordPushed(
  input: Steps.Input,
  pushed: {
    readonly integrationID: OwnTeam.IntegrationID
    readonly remote: string
    readonly ref: string
    readonly pr?: string
  },
) {
  const services = input.services
  const updated = await Advance.update(services, input.op.teamID, pushed.integrationID, (current) => ({
    ...current,
    pushed: {
      at: services.clock.now(),
      remote: pushed.remote,
      ref: pushed.ref,
      ...(pushed.pr === undefined ? {} : { pr: pushed.pr }),
    },
  }))
  if (!updated) return
  input.summary({
    kind: "pushed",
    areaID: updated.areaID,
    integrationID: updated.id,
    remote: pushed.remote,
    ref: pushed.ref,
    ...(pushed.pr === undefined ? {} : { pr: pushed.pr }),
  })
}
