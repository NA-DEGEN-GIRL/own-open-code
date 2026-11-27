export * as Enable from "./enable.js"

import fs from "node:fs"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { type Account, OwnTeam, type Policy, type Preset } from "@own/protocol"
import { BunCache } from "../assets/bun-cache.js"
import { Shared } from "../assets/shared.js"
import { Symlinks } from "../assets/symlinks.js"
import { Decisions } from "../docs/decisions.js"
import { Activity } from "../git/activity.js"
import { Classify } from "../git/classify.js"
import { Home } from "../git/home.js"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import { Lfs } from "../git/lfs.js"
import { Measure } from "../git/measure.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { GitVersion } from "../git/version.js"
import { Worktree } from "../git/worktree.js"
import { JudgeFallback } from "../judge/fallback.js"
import { JudgePrompt } from "../judge/prompt.js"
import { JudgeSchema } from "../judge/schema.js"
import { JudgeValidate } from "../judge/validate.js"
import { Teams } from "../registry/team.js"
import { RemoteLfs } from "../remote/lfs.js"
import { Services } from "../services.js"
import { Adopt } from "./adopt.js"
import { TeamHome } from "./home.js"
import type { Steps } from "./steps.js"
import { Journal } from "./journal.js"

/**
 * `enable{directory, sessionID?, hint?}` (06 §3.1, §3.6, §3.7 새 프로젝트, §3.8 다시 켜기) as one `enable` op.
 *
 * The RPC handler checks Git (not_git, git_too_old, lfs_missing) and, for a repository without a team, reads the
 * inventory and the root sessions, picks the home (3.2) and the folder new areas go in (`path_forbidden`). It chooses
 * the main session id ahead, so a retried create adopts the session instead of making a second one. Everything that
 * writes runs as op steps (observe → act → verify, TI-11), and each planning step appends the steps it decided:
 *
 *   enable.observe   weighs the target (4.4) and picks the main's model: the enabling conversation's Ref, else the
 *                    07 §2.2 new-session value (that folder's last model, else the most recent session's account or
 *                    the first serving one, with its group's default model); never its preset or ultra
 *     enable.main      the team main FIRST: `services.main.create` (role, team tool allows, ★ preset, approval)
 *     enable.registry  the team record, `on`
 *     enable.judge     the judge: one-off `session.generate` on the main (≤ 20k tokens), one retry with the errors,
 *                      then the rule-based proposal; never `ctx.generate.text`. V2–V13, then the team's heavy
 *                      folders, commands and outside folders are recorded and these steps appended:
 *       enable.keep      `refs/own/keep/<sha>` for commits only a detached HEAD has (TI-8)
 *       lfs-remote       on an SSH host, the bundled git-lfs as the repository's LFS filter (4.13, `remote/lfs.ts`):
 *                        before anything makes an area or an owner there (3.6 켜기의 순서 (5))
 *       team.lock        the home, when it is a linked worktree, then every adopted folder (3.6 켜기의 순서 (6))
 *       adopt.*          each adopted folder: its detached HEAD named, its most recent root session registered as the
 *                        owner without touching it (`ops/adopt.ts`, 3.7; R4 decided with the team, 10.1)
 *       …                each new area's steps from `services.areas.plan` (branch, worktree, owner, setup)
 *       protect-shared   each shared folder the judge picked (V8): a confirm that makes it read-only, records it and
 *                        links it into every area (4.11, `assets/shared.ts`; 두기 leaves it unshared) (3.6 (9))
 *       enable.refresh   `worktree.refresh`
 *       enable.finish    the summary card's lines (06 §9.3): heavy folders, active folders left out (`팀에 넣기`, V13),
 *                        keep refs, the judge's notes and suggestions
 *
 * A remote service (`Git.tools()`, 4.13) refuses an enable whose repository uses LFS while the bundled git-lfs is not
 * on the host (`lfs_missing`: own-web uploads it through own-remote `hosts.tools.ensure` and asks again).
 * `Team.env.lfs` comes from `Lfs.env` (`own` once the bundled filter is set).
 *
 * A team that exists already converges instead (3.8 다시 켜기): the same ids, locks taken again (adopted areas too),
 * `on`, no second judge. An enable op that failed and was not undone is retried with its own steps (and ids), so a
 * second enable converges on the same result.
 */

export interface Input {
  readonly directory: string
  /** The conversation being viewed: its folder becomes the home and its model the main's (3.2, 10.1). */
  readonly sessionID?: SessionID
  readonly hint?: string
  /** Where a new team keeps its area folders (4.12, 2026-10-27); absent = `inside`. A team on again keeps its own. */
  readonly areaRoot?: OwnTeam.AreaRoot
}

export async function start(
  services: Services.Context,
  input: Input,
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  if (!Git.isNative(input.directory))
    return Services.failure("path_forbidden", "not a native absolute path", { path: input.directory, why: "invalid" })
  const located = await Inventory.locate(input.directory)
  if (!located.ok) return Services.failure("not_git", located.message, { directory: input.directory })
  const version = await GitVersion.check(located.toplevel)
  if (!version.ok) return versionFailure(version, input.directory)
  // 4.13: on an SSH host nothing is made before the bundled git-lfs can be the repository's filter.
  if (Git.tools() !== undefined) {
    const lfs = await RemoteLfs.plan({ directory: located.toplevel, home: services.home })
    if (!lfs.ok) return lfs
  }
  const teamID = Teams.id(located.commonDir)
  const [team, ops, active] = await Promise.all([
    services.registry.teams.get(teamID),
    services.journal.list(teamID),
    services.journal.active(teamID),
  ])
  if (active) return busy(teamID, active)
  // The latest enable decides: a failed one that was not undone runs again with its own steps and ids; an undone one
  // never lends its (archived) main to the next.
  const last = ops.findLast((op) => op.kind === "enable")
  const retry =
    last !== undefined && last.undo?.by === undefined && (last.state === "failed" || last.state === "cancelled")
  const planned = retry
    ? {
        ok: true as const,
        steps: last.steps.map((step) => ({ id: step.id, kind: step.kind, args: step.args, mode: step.mode })),
      }
    : team
      ? await converge(services, team, input)
      : await fresh(services, {
          ...input,
          teamID,
          commonDir: located.commonDir,
          mainSessionID: SessionID.create(),
          version,
        })
  if (!planned.ok) return planned
  // A new team is written `off` first: the controller resumes running ops of the teams it has records of, so a crash
  // before `enable.registry` still resumes (TI-11). `enable.registry` writes it whole and turns it on.
  const early = planned.team
  if (early) await services.write(teamID, () => services.registry.teams.put(early))
  const started = await services.runner.start({
    teamID,
    kind: "enable",
    by: "user",
    undo: { available: true },
    steps: planned.steps,
  })
  if (!started.ok) return busy(teamID, started.op)
  return { ok: true, opID: started.op.id }
}

/** What every step of an enable op shares: the arguments of its first step (`enable.observe`), written ahead. */
export const Context = Schema.Struct({
  teamID: OwnTeam.TeamID,
  commonDir: Schema.String,
  directory: Schema.String,
  hint: optional(Schema.String),
  /** The team before this op: `none` (this op makes it), or its state (다시 켜기). Undo reverses by it. */
  previous: Schema.Literals(["none", "off", "on"]),
  mainSessionID: SessionID,
  /** Lock reasons before the op, by worktree path (undo puts them back). */
  locks: Schema.Record(Schema.String, Schema.String),
  home: OwnTeam.Home,
  worktreeRoot: Schema.String,
  target: Schema.String,
  projectID: optional(Schema.String),
  /** The enabling conversation's Ref, when it belongs to this repository. */
  model: optional(Model.Ref),
})
export type Context = typeof Context.Type

const decodeContext = Schema.decodeUnknownSync(Context)

export function context(op: OwnTeam.Op): Context {
  const step = op.steps.find((item) => item.kind === "enable.observe")
  if (!step) throw new Error(`팀 모드 켜기 작업이 아니에요: ${op.id}`)
  return decodeContext(step.args)
}

const Finish = Schema.Struct({ lines: Schema.Array(OwnTeam.SummaryLine), created: Schema.Array(OwnTeam.AreaID) })
const decodeFinish = Schema.decodeUnknownSync(Finish)

/** The areas an enable op planned to create (its `enable.finish` step, appended with them). */
export function created(op: OwnTeam.Op): ReadonlyArray<OwnTeam.AreaID> {
  const step = op.steps.find((item) => item.kind === "enable.finish")
  return step ? decodeFinish(step.args).created : []
}

/** Registers the enable op's kinds (from `ops/undo.ts`, once per controller). */
export function register(services: Services.Context) {
  // Weighing in `enable.observe` is reused by `enable.judge` of the same op in this process (else it is redone).
  const cache = new Map<string, Observation>()
  services.steps.register(observeKind(cache))
  services.steps.register(mainKind())
  services.steps.register(registryKind())
  services.steps.register(judgeKind(cache))
  services.steps.register(keepKind())
  services.steps.register(refreshKind())
  services.steps.register(finishKind())
  // The kinds an enable plans from other modules (each registers once per controller).
  RemoteLfs.register(services)
  Shared.register(services)
}

// ---------------------------------------------------------------------------------------------------------------
// Preflight (the RPC handler)

type Planned = Services.Result<{ readonly steps: ReadonlyArray<Steps.Spec>; readonly team?: OwnTeam.Team }>

/** `Team.projectID` until `enable.registry` reads the main session's project (no session told it before). */
export const UNKNOWN_PROJECT = "own.team:unknown-project"

async function fresh(
  services: Services.Context,
  input: Input & {
    readonly teamID: OwnTeam.TeamID
    readonly commonDir: string
    readonly mainSessionID: SessionID
    readonly version: Extract<GitVersion.Check, { ok: true }>
  },
): Promise<Planned> {
  const version = input.version
  const listed = await Worktree.list(input.commonDir)
  if (!listed.ok) return Services.failure("not_git", listed.message, { directory: input.directory })
  const paths = listed.worktrees.filter((item) => !item.bare).map((item) => item.path)
  const viewed = input.sessionID === undefined ? undefined : await view(services, input.sessionID, input.directory)
  // 3.2 홈 고르기 (1): only a conversation of this repository counts.
  const ours =
    viewed !== undefined &&
    Classify.placeSessions(paths, [{ directory: viewed.location.directory }]).unplaced.length === 0
      ? viewed
      : undefined
  const projectID = ours?.projectID ?? live(services, paths) ?? (await projectOf(services, [input.directory, ...paths]))
  const sessions = projectID === undefined ? [] : await Adopt.roots(services, projectID)
  const target = await defaultTarget(input.commonDir, listed.worktrees)
  // A repository without a commit (3.0): own-web offers its first commit (Git 저장소로 만들기).
  if (target === undefined)
    return Services.failure("not_git", "the repository has no branch yet", {
      directory: input.directory,
      // `worktree list` prints an all-zero HEAD for a branch without a commit.
      ...(listed.worktrees.every((item) => !item.head || /^0+$/.test(item.head)) ? { unborn: true } : {}),
    })
  const inventory = await Inventory.collect(input.commonDir, target, sessions)
  if (!inventory.ok) return Services.failure("not_git", inventory.message, { directory: input.directory })
  const home = Home.pick({
    worktrees: inventory.worktrees,
    target,
    ...(ours === undefined ? {} : { session: ours.location.directory }),
  })
  if (!home) return Services.failure("not_git", "the repository has no checkout", { directory: input.directory })
  const root = Home.worktreeRoot(
    home.directory,
    input.commonDir,
    inventory.worktrees.map((item) => item.path),
    input.areaRoot ?? "inside",
  )
  if (!root.ok) return Services.failure("path_forbidden", "no place for new areas", { path: root.path, why: root.why })
  const args: Context = {
    teamID: input.teamID,
    commonDir: input.commonDir,
    directory: input.directory,
    ...(input.hint === undefined ? {} : { hint: input.hint }),
    previous: "none",
    mainSessionID: input.mainSessionID,
    locks: Object.fromEntries(
      inventory.worktrees.flatMap((item) => (item.locked === null ? [] : [[item.path, item.locked] as const])),
    ),
    home,
    worktreeRoot: root.directory,
    target,
    ...(projectID === undefined ? {} : { projectID }),
    ...(ours?.model === undefined ? {} : { model: ours.model }),
  }
  return {
    ok: true,
    steps: [{ id: "observe", kind: "enable.observe", args }],
    team: {
      ...record(args, projectID ?? UNKNOWN_PROJECT, await lfsOf(home.directory, version.lfs.used)),
      state: "off",
    },
  }
}

/**
 * `Team.env.lfs` (06 §2.4, §4.13): `Lfs.env` with the bundled tool on a remote service (`own` once its filter is set,
 * `missing` before); when git cannot tell, what the version check saw (`system` for a repository that uses LFS).
 */
async function lfsOf(directory: string, used: boolean): Promise<Lfs.Env> {
  const found = await Lfs.env(directory, Git.tools())
  if (found.ok) return found.lfs
  return used ? "system" : "unused"
}

/** 3.8 다시 켜기: the registry's ids, home and areas; nothing is judged or made again. */
async function converge(services: Services.Context, team: OwnTeam.Team, input: Input): Promise<Planned> {
  const locks = await TeamHome.snapshot(team.commonDir)
  if (!locks) return Services.failure("not_git", "the worktrees cannot be listed", { directory: input.directory })
  const args: Context = {
    teamID: team.id,
    commonDir: team.commonDir,
    directory: input.directory,
    previous: team.state,
    mainSessionID: team.main.sessionID,
    locks,
    home: team.home,
    worktreeRoot: team.worktreeRoot,
    target: team.target,
    projectID: team.projectID,
  }
  return { ok: true, steps: [{ id: "observe", kind: "enable.observe", args }] }
}

async function view(services: Services.Context, sessionID: string, directory: string) {
  const found = await services.http.session.get({ sessionID, directory })
  if (found.ok) return found.value
  services.log.warn("enable_session_unreadable", { sessionID, type: found.type })
  return undefined
}

/** The project of a live own.team instance (a Location) in one of the repository's worktrees. */
function live(services: Services.Context, paths: ReadonlyArray<string>) {
  return paths
    .map((item) => services.instance(item))
    .find((instance) => instance !== undefined && paths.some((item) => Identity.same(item, instance.directory)))?.ctx
    .location.project.id
}

/** The project of the repository: a session in the given folder, else in one of its worktrees (exact folder only). */
async function projectOf(services: Services.Context, directories: ReadonlyArray<string>): Promise<string | undefined> {
  const [first, ...rest] = directories
  if (first === undefined) return undefined
  const listed = await services.http.session.list({ directory: first, limit: 1 })
  const found = listed.ok ? listed.value.data[0]?.projectID : undefined
  return found ?? projectOf(services, rest)
}

/**
 * The branch areas integrate into: `origin/HEAD`'s branch, else `main`, else `master`, else the main worktree's
 * branch, else the first branch. `undefined` in a repository without branches.
 */
async function defaultTarget(commonDir: string, worktrees: ReadonlyArray<Porcelain.Worktree>) {
  const query = { cwd: commonDir, worktree: true }
  const [heads, origin] = await Promise.all([
    Git.run(["for-each-ref", "--format=%(refname)", "refs/heads"], query),
    Git.run(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], query),
  ])
  const names = heads.ok
    ? heads.stdout
        .split("\n")
        .filter((line) => line.startsWith("refs/heads/"))
        .map((line) => line.slice("refs/heads/".length))
    : []
  const remote = origin.ok ? origin.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : undefined
  const primary = worktrees[0]?.branch?.replace(/^refs\/heads\//, "")
  return [remote, "main", "master", primary].find((name) => name !== undefined && names.includes(name)) ?? names[0]
}

function versionFailure(check: Extract<GitVersion.Check, { ok: false }>, directory: string): Services.Failure {
  if (check.error === "git_too_old")
    return Services.failure("git_too_old", check.message, {
      version: /Git (\S+)/.exec(check.message)?.[1] ?? "",
      minimum: `${GitVersion.MINIMUM.major}.${GitVersion.MINIMUM.minor}`,
    })
  if (check.error === "lfs_missing")
    return Services.failure("lfs_missing", check.message, { tool: "git-lfs", version: null })
  return Services.failure("not_git", check.message, { directory })
}

/** {@link versionFailure}'s reason in screen words, for a step's note (`check.message` of `git_too_old` stays parseable). */
function versionNote(check: Extract<GitVersion.Check, { ok: false }>) {
  if (check.error !== "git_too_old") return check.message
  const minimum = `${GitVersion.MINIMUM.major}.${GitVersion.MINIMUM.minor}`
  return `Git이 너무 오래됐어요(지금 ${/Git (S+)/.exec(check.message)?.[1] ?? "?"}, ${minimum} 이상 필요)`
}

function busy(teamID: OwnTeam.TeamID, op: OwnTeam.Op) {
  return Services.failure("busy", "another team op is running", Journal.busy(op))
}

// ---------------------------------------------------------------------------------------------------------------
// The team main's model (10.1, 07 §2.2)

/**
 * The main's model when the team is enabled without a conversation (07 §2.2 rules 2–3): the last model used in the
 * home, else the default account of the most recent session's kind (`policy.defaults.byKind`), that session's
 * account, or the first serving account (each when it can serve now), with its group's new-session default model.
 */
export function initialModel(input: {
  readonly sessions: ReadonlyArray<{ readonly directory: string; readonly updated: number; readonly model?: Model.Ref }>
  readonly home: string
  readonly accounts: ReadonlyArray<Account.View>
  readonly groups: ReadonlyArray<Preset.GroupView>
  readonly byKind?: Policy.ByKind
}): Model.Ref | undefined {
  const accountOf = (providerID: string) => input.accounts.find((item) => item.providerID === providerID)
  const usable = (providerID: string) => {
    const found = accountOf(providerID)
    return found === undefined || (found.status !== "retired" && found.status !== "disabled")
  }
  const ordered = input.sessions.toSorted((a, b) => b.updated - a.updated)
  const here = ordered.find(
    (item) => item.model !== undefined && usable(item.model.providerID) && Classify.same(item.directory, input.home),
  )
  if (here?.model) return here.model
  const latest = ordered.find((item) => item.model !== undefined)?.model
  const recent = latest === undefined ? undefined : accountOf(latest.providerID)
  // The Claude slot and the Claude Agent route have no per-kind new-session account (Policy.ByKind is own kinds').
  const named =
    recent && recent.kind !== "claude-sub" && recent.kind !== "claude-agent" ? input.byKind?.[recent.kind] : undefined
  const account =
    serving(named === undefined ? undefined : input.accounts.find((item) => item.id === named)) ??
    serving(recent) ??
    input.accounts.find((item) => serving(item) !== undefined)
  if (!account) return undefined
  const preferred = input.groups.find((group) => group.group === account.kind)?.defaultModel
  if (!preferred || preferred.missing === true) return undefined
  return {
    providerID: account.providerID,
    id: preferred.id,
    ...(preferred.variant === undefined ? {} : { variant: preferred.variant }),
  }
}

/** Whether an account can serve now (own-web `serving`): ready, or an own account still unverified. */
function serving(account: Account.View | undefined) {
  if (!account) return undefined
  return account.status === "ready" || (account.status === "unverified" && account.kind !== "claude-sub")
    ? account
    : undefined
}

async function mainModel(services: Services.Context, ctx: Context) {
  if (ctx.model) return ctx.model
  const where = { directory: ctx.home.directory }
  const [sessions, accounts, presets, policy] = await Promise.all([
    ctx.projectID === undefined ? Promise.resolve([]) : Adopt.roots(services, ctx.projectID),
    services.accounts.accountsList(where),
    services.accounts.presetsList({}, where),
    services.accounts.policyGet(where),
  ])
  if (!accounts.ok) services.log.warn("enable_accounts_unreadable", { type: accounts.type })
  if (!presets.ok) services.log.warn("enable_presets_unreadable", { type: presets.type })
  return initialModel({
    sessions,
    home: ctx.home.directory,
    accounts: accounts.ok ? accounts.value.accounts : [],
    groups: presets.ok ? presets.value.groups : [],
    ...(policy.ok ? { byKind: policy.value.policy.defaults.byKind } : {}),
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

interface Observation {
  readonly inventory: Inventory.Result<Adopt.Root>
  readonly measure: Measure.Result
  readonly version: Extract<GitVersion.Check, { ok: true }>
}

/** Inventory and weight of the target, read again right before a step uses them (TI-11). */
async function observe(services: Services.Context, ctx: Context, projectID: string | undefined): Promise<Observation> {
  const sessions = projectID === undefined ? [] : await Adopt.roots(services, projectID)
  const [inventory, measure, version] = await Promise.all([
    Inventory.collect(ctx.commonDir, ctx.target, sessions),
    Measure.measure(ctx.home.directory, ctx.target),
    GitVersion.check(ctx.home.directory),
  ])
  if (!inventory.ok) throw new Error(inventory.message)
  if (!measure.ok) throw new Error(`프로젝트 크기를 재지 못했어요: ${measure.message}`)
  if (!version.ok) throw new Error(versionNote(version))
  return { inventory, measure, version }
}

/** Appends steps right after the planning step's place (the end of the op), each id once. */
async function append(services: Services.Context, op: OwnTeam.Op, specs: ReadonlyArray<Steps.Spec & { id: string }>) {
  await services.write(op.teamID, async () => {
    const current = await services.journal.get(op.teamID, op.id)
    if (!current) throw new Error(`작업 기록이 없어요: ${op.id}`)
    const known = new Set(current.steps.map((step) => step.id))
    await services.journal.put({
      ...current,
      steps: [
        ...current.steps,
        ...specs
          .filter((spec) => !known.has(spec.id))
          .map((spec) => ({
            id: spec.id,
            kind: spec.kind,
            args: { ...spec.args },
            mode: spec.mode ?? ("auto" as const),
            state: "pending" as const,
          })),
      ],
    })
  })
}

function teamOf(services: Services.Context, teamID: string) {
  return services.registry.teams.get(teamID).then((team) => {
    if (!team) throw new Error(`팀 기록이 없어요: ${teamID}`)
    return team
  })
}

function observeKind(cache: Map<string, Observation>): Steps.Kind {
  return {
    kind: "enable.observe",
    // It is the op's only step until it acts: anything after it was appended by it.
    observe: async (input) => (input.op.steps.length > 1 ? { state: "satisfied" } : { state: "pending" }),
    act: async (input) => {
      const ctx = context(input.op)
      if (ctx.previous !== "none") {
        await append(input.services, input.op, await relock(input.services, ctx))
        return { ok: true }
      }
      const observed = await observe(input.services, ctx, ctx.projectID)
      // Without the project the sessions are unknown here; the judge then reads them again once the main tells it.
      if (ctx.projectID !== undefined) cache.set(input.op.id, observed)
      for (const key of [...cache.keys()].slice(0, -4)) cache.delete(key)
      const model = await mainModel(input.services, ctx)
      if (!model) return { ok: false, note: "팀 메인의 모델을 정하지 못했어요(새 대화 기본 모델이 없음)" }
      await append(input.services, input.op, [
        { id: "main", kind: "enable.main", args: { model } },
        { id: "registry", kind: "enable.registry" },
        { id: "judge", kind: "enable.judge" },
      ])
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

/** 3.8 다시 켜기: the locks again (home and areas), `on`, refresh. */
async function relock(services: Services.Context, ctx: Context) {
  const areas = (await services.registry.areas.list(ctx.teamID)).filter((area) => area.state !== "retired")
  return [
    ...(ctx.home.linked
      ? [
          {
            id: "lock:home",
            kind: "team.lock",
            args: { directory: ctx.home.directory, reason: TeamHome.reason(ctx.teamID) },
          },
        ]
      : []),
    ...areas.map((area) => ({
      id: `lock:${area.id}`,
      kind: "team.lock",
      args: { directory: area.directory, reason: Worktree.lockReason(area.id) },
    })),
    { id: "registry", kind: "enable.registry" },
    { id: "refresh", kind: "enable.refresh" },
    { id: "finish", kind: "enable.finish", args: { lines: [], created: [] } },
  ]
}

const MainArgs = Schema.Struct({ model: Model.Ref })
const decodeMain = Schema.decodeUnknownSync(MainArgs)

/** The team main first (3.6 step 2): the judge runs on it. `main.create` adopts an existing id, so it always acts. */
function mainKind(): Steps.Kind {
  return {
    kind: "enable.main",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const ctx = context(input.op)
      const created = await input.services.features().main.create({
        teamID: ctx.teamID,
        directory: ctx.home.directory,
        sessionID: ctx.mainSessionID,
        model: decodeMain(input.step.args).model,
        signal: input.signal,
      })
      return created.ok ? { ok: true } : { ok: false, note: created.message }
    },
    verify: async (input) => {
      const ctx = context(input.op)
      const found = await input.services.http.session.get({
        sessionID: ctx.mainSessionID,
        directory: ctx.home.directory,
      })
      return found.ok ? { ok: true } : { ok: false, note: `팀 메인 대화를 찾지 못했어요: ${found.message}` }
    },
  }
}

function registryKind(): Steps.Kind {
  return {
    kind: "enable.registry",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const ctx = context(input.op)
      const services = input.services
      const existing = await services.registry.teams.get(ctx.teamID)
      // A new team gets this op's ids, home and folder (its early record may come from another enable that lost the
      // race) over what the record holds, so a retried op keeps what its judge wrote; 다시 켜기 keeps the record.
      const fields = ctx.previous === "none" || !existing ? await identity(services, ctx, existing) : existing
      // 4.12: area folders inside the main folder are ignored through `info/exclude` before any is made.
      await TeamHome.exclude(fields)
      const written = await services.write(ctx.teamID, () => services.registry.teams.put({ ...fields, state: "on" }))
      services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
      // `enable.main` bound the main's preset while the team was not on yet, so without its team context; the owners of
      // a team turned on again keep theirs from before. Nothing else binds them now (no area Location boots here).
      await services
        .features()
        .teamContext.push(written.id)
        .catch((error: unknown) => services.log.warn("team_context_push_failed", { teamID: written.id, error }))
      return { ok: true }
    },
    verify: async (input) =>
      (await teamOf(input.services, input.op.teamID)).state === "on"
        ? { ok: true }
        : { ok: false, note: "팀 기록을 쓰지 못했어요" },
  }
}

/** A new team's record (06 §2.4): the project comes from the main session once it exists. */
async function identity(services: Services.Context, ctx: Context, existing: OwnTeam.Team | undefined) {
  const [session, lfs] = await Promise.all([
    services.http.session.get({ sessionID: ctx.mainSessionID, directory: ctx.home.directory }),
    existing === undefined
      ? GitVersion.check(ctx.home.directory).then((version) =>
          lfsOf(ctx.home.directory, version.ok && version.lfs.used),
        )
      : existing.env.lfs,
  ])
  const projectID = session.ok ? session.value.projectID : ctx.projectID
  if (projectID === undefined) throw new Error("팀 메인 대화의 프로젝트를 알 수 없어요")
  const base = existing ?? record(ctx, projectID, lfs)
  return {
    ...base,
    projectID,
    commonDir: ctx.commonDir,
    target: ctx.target,
    home: ctx.home,
    main: { sessionID: ctx.mainSessionID, previous: base.main.previous },
    worktreeRoot: ctx.worktreeRoot,
  }
}

/** The team record of an enable before the judge: heavy folders and commands come from `enable.judge`. */
function record(ctx: Context, projectID: string, lfs: Lfs.Env): OwnTeam.Team {
  return {
    id: ctx.teamID,
    projectID,
    commonDir: ctx.commonDir,
    target: ctx.target,
    state: "on",
    rev: 0,
    home: ctx.home,
    main: { sessionID: ctx.mainSessionID, previous: [] },
    worktreeRoot: ctx.worktreeRoot,
    heavy: { dirs: [], measuredAt: null, forcedBytes: 0 },
    shared: [],
    commands: { setup: null, code: [], assets: [] },
    env: { symlinkFix: "none", bunCache: "unused", lfs },
    external: [],
    policy: OwnTeam.POLICY,
    patterns: [],
  }
}

function judgeKind(cache: Map<string, Observation>): Steps.Kind {
  return {
    kind: "enable.judge",
    // Done once its steps are appended (the finish step comes last in the same write).
    observe: async (input) =>
      input.op.steps.some((step) => step.kind === "enable.finish") ? { state: "satisfied" } : { state: "pending" },
    act: async (input) => {
      const services = input.services
      const ctx = context(input.op)
      // 4.13 (3.6 (5)): on an SSH host the bundled git-lfs becomes the filter before any area or owner is made there.
      const remote =
        Git.tools() === undefined
          ? { ok: true as const, steps: [] }
          : await RemoteLfs.plan({ directory: ctx.home.directory, home: services.home })
      if (!remote.ok) return { ok: false, note: remote.message }
      const team = await teamOf(services, ctx.teamID)
      const observed = cache.get(input.op.id) ?? (await observe(services, ctx, team.projectID))
      cache.delete(input.op.id)
      const facts = await factsOf(services, ctx, team, observed)
      const judged = await judge(services, ctx, facts, observed, input.signal)
      const validated = judged.validated
      if (validated.rejected.length > 0 || validated.warnings.length > 0)
        services.log.info("judge_validated", {
          teamID: ctx.teamID,
          source: judged.source,
          rejected: validated.rejected,
          warnings: validated.warnings,
        })
      const inventory = observed.inventory
      const classified = Classify.classify(inventory.worktrees, { home: ctx.home.directory, patterns: team.patterns })
      // Adoptions are decided before the record: the folders they take are no longer outside the team.
      const adoption = await Adopt.plan(services, {
        team,
        candidates: validated.adopt.flatMap((item): Adopt.Candidate[] => {
          const index = inventory.worktrees.findIndex((entry) => Classify.same(entry.path, item.worktree))
          const worktree = inventory.worktrees[index]
          if (!worktree) return []
          const outer = classified[index]?.outer ?? null
          const around = outer === null ? undefined : classified.find((entry) => entry.path === outer)
          return [
            {
              item: item.item,
              slug: item.slug,
              name: item.name,
              // The rule-based proposal names an area after its folder: no subtitle then.
              ...(item.subtitle === "" || item.subtitle === item.name ? {} : { subtitle: item.subtitle }),
              goal: item.goal,
              shape: item.shape,
              worktree,
              ...(around === undefined ? {} : { outer: { path: around.path, class: around.class } }),
              owner: item.owner,
            },
          ]
        }),
        branches: inventory.branches.map((branch) => branch.name),
      })
      const adopted = (item: JudgeValidate.Worktree) =>
        item.class === "candidate" && adoption.folders.has(Classify.key(item.path))
      const dirs = validated.heavy.map((item) => item.dir)
      // 3.2 환경: how the home keeps its links (4.12) and where own's Bun installs keep their cache (4.12).
      const links = await Symlinks.detect(ctx.home.directory, input.signal)
      if (!links.ok) services.log.warn("symlinks_detect_failed", { teamID: ctx.teamID, message: links.message })
      const lfs = await lfsOf(ctx.home.directory, observed.version.lfs.used)
      const updated = await services.write(ctx.teamID, async () =>
        services.registry.teams.put({
          ...(await teamOf(services, ctx.teamID)),
          heavy: {
            dirs,
            measuredAt: observed.inventory.target.oid,
            forcedBytes: Measure.forced(observed.measure, dirs).bytes,
          },
          commands: validated.commands,
          external: facts.worktrees.flatMap((item): OwnTeam.External[] => {
            const why = adopted(item) ? undefined : EXTERNAL[item.class]
            return why === undefined ? [] : [{ directory: item.path, why }]
          }),
          env: {
            lfs,
            symlinkFix: links.ok ? links.fix : team.env.symlinkFix,
            bunCache: BunCache.detect({ home: ctx.home.directory, worktreeRoot: ctx.worktreeRoot }),
          },
        }),
      )
      services.hub.publish({ name: "team.changed", data: { teamID: updated.id, rev: updated.rev } })
      const planned = await plan(services, updated, validated.create)
      const keeps = [
        ...new Set(
          observed.inventory.worktrees.flatMap((entry, index) => {
            const kept = facts.worktrees[index]?.class
            return (kept === "home" || kept === "candidate") && entry.detachedOnly.length > 0 && entry.head !== null
              ? [entry.head]
              : []
          }),
        ),
      ]
      const createdIDs = planned.flatMap((item) => (item.result.ok ? [item.result.areaID] : []))
      const areaSteps = planned.flatMap((item) =>
        item.result.ok
          ? item.result.steps.map((spec, index) => ({ ...spec, id: `area:${item.area.slug}:${spec.id ?? index + 1}` }))
          : [],
      )
      const homeChanges = facts.worktrees.find((item) => item.class === "home")?.changes ?? 0
      const lines: OwnTeam.SummaryLine[] = [
        ...(observed.version.reason ? [{ kind: "old-git" as const, version: observed.version.version.text }] : []),
        ...(dirs.length === 0 ? [] : [{ kind: "heavy" as const, dirs, bytes: heavyBytes(observed.measure, dirs) }]),
        ...(validated.notes === "" ? [] : [{ kind: "notes" as const, text: validated.notes }]),
        ...validated.suggest.map((suggestion) => ({ kind: "suggest" as const, suggestion })),
        ...adoption.lines,
        ...planned.flatMap((item) =>
          item.result.ok
            ? []
            : [
                {
                  kind: "skipped" as const,
                  item: item.area.item,
                  areaID: OwnTeam.AreaID.make(`ar_${item.area.slug}`),
                  why: item.result.error === "unsupported" ? ("unsupported" as const) : ("invalid" as const),
                },
              ],
        ),
        // V13: every active folder the team did not take is on the card with `팀에 넣기`.
        ...facts.worktrees
          .filter((item) => item.class === "candidate" && item.active && !adopted(item))
          .map((item) => ({
            kind: "unadopted" as const,
            directory: item.path,
            changes: item.changes,
            ahead: item.ahead,
          })),
        ...(createdIDs.length > 0 && homeChanges > 0 ? [{ kind: "home-changes" as const, count: homeChanges }] : []),
        ...keeps.map((sha) => ({ kind: "ref" as const, ref: `refs/own/keep/${sha}`, sha })),
      ]
      await append(services, input.op, [
        ...keeps.map((sha) => ({
          id: `keep:${sha}`,
          kind: "enable.keep",
          args: { ref: `refs/own/keep/${sha}`, oid: sha },
        })),
        ...remote.steps.map((spec) => ({ ...spec, id: "lfs-remote" })),
        ...(ctx.home.linked
          ? [
              {
                id: "lock:home",
                kind: "team.lock",
                args: { directory: ctx.home.directory, reason: TeamHome.reason(ctx.teamID) },
              },
            ]
          : []),
        ...adoption.locks,
        ...adoption.steps,
        // `lfs-remote` above is for the whole repository: a new area's own copy of it is left out.
        ...areaSteps.filter((spec) => spec.kind !== SETUP && spec.kind !== RemoteLfs.KIND),
        // 3.6 (9): each shared folder asks first (it becomes read-only); the confirmed step links every area.
        ...validated.shared.map((item) => ({ ...Shared.protectSpec({ name: item.dir }), id: `shared:${item.dir}` })),
        { id: "refresh", kind: "enable.refresh" },
        { id: "finish", kind: "enable.finish", args: { lines, created: createdIDs } },
        ...areaSteps.filter((spec) => spec.kind === SETUP),
      ])
      return judged.source === "fallback" ? { ok: true, note: JudgeFallback.NOTES } : { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

/**
 * The 3.6 kind of a setup command: every area's setup runs after all folders, owners and the summary, so one
 * install never holds back the next area.
 */
const SETUP = "setup-run"

const EXTERNAL: Readonly<Partial<Record<Classify.Class, OwnTeam.External["why"]>>> = {
  primary: "primary",
  "other-tool": "other-tool",
  "hash-path": "hash-path",
  prunable: "prunable",
  // A candidate the team did not adopt.
  candidate: "left",
}

/**
 * The bytes a full checkout writes in the heavy folders (the `heavy` card line, 0.4 `큰 파일 폴더 3개(14.7 GB)`): a
 * folder's table row, else the files directly in it and in every folder below it.
 */
function heavyBytes(measure: Measure.Result, dirs: ReadonlyArray<string>) {
  const inside = (dir: string) =>
    Object.entries(measure.direct)
      .filter(([folder]) => JudgeValidate.within(dir, folder))
      .reduce((sum, [, entry]) => sum + entry.bytes, 0)
  return dirs.reduce((sum, dir) => sum + (measure.rows.find((row) => row.dir === dir)?.bytes ?? inside(dir)), 0)
}

/** One judge call on the team main (3.4), one retry with the errors, then the rule-based proposal. */
async function judge(
  services: Services.Context,
  ctx: Context,
  facts: JudgeValidate.Facts,
  observed: Observation,
  signal: AbortSignal,
) {
  const prompt = JudgePrompt.render({
    facts,
    home: ctx.home.directory,
    measure: observed.measure,
    decisions: await Decisions.titles(services, ctx.teamID),
    ...(ctx.hint === undefined ? {} : { hint: ctx.hint }),
  })
  const ask = async (text: string): Promise<JudgeSchema.Parsed> => {
    const answer = await services.http.session.generate(
      { sessionID: ctx.mainSessionID, directory: ctx.home.directory, prompt: text },
      { signal },
    )
    if (answer.ok) return JudgeSchema.parse(answer.value)
    services.log.warn("judge_call_failed", { teamID: ctx.teamID, status: answer.status, type: answer.type })
    return { ok: false, errors: [`판단 호출이 실패했습니다 (${answer.type})`] }
  }
  const first = await ask(prompt)
  const second = first.ok ? first : await ask(JudgePrompt.retry(prompt, first.errors))
  if (second.ok) return { source: "judge" as const, validated: JudgeValidate.validate(second.proposal, facts) }
  services.log.warn("judge_fallback", { teamID: ctx.teamID, errors: second.errors })
  return {
    source: "fallback" as const,
    validated: JudgeValidate.validate(JudgeFallback.propose({ facts, rows: observed.measure.rows }), facts),
  }
}

/** The new areas' steps from `services.areas.plan`, one area after the other. */
async function plan(services: Services.Context, team: OwnTeam.Team, areas: ReadonlyArray<JudgeValidate.Create>) {
  const planned: Array<{
    readonly area: JudgeValidate.Create
    readonly result: Awaited<ReturnType<Services.AreaCreate["plan"]>>
  }> = []
  const starts = new Map<string, string>()
  for (const area of areas) {
    // V2 lets `from` name an area made earlier in this proposal. It has no branch yet, so start where it starts.
    const from = area.from === "main" ? area.from : (starts.get(area.from) ?? area.from)
    const result = await services.features().areas.plan({
      team,
      slug: area.slug,
      name: area.name,
      goal: area.goal,
      needs: area.needs,
      from,
      by: "user",
    })
    if (!result.ok) services.log.warn("area_plan_failed", { teamID: team.id, slug: area.slug, error: result.error })
    if (result.ok) starts.set(area.slug, from)
    planned.push({ area, result })
  }
  return planned
}

/** What V2–V13 need, read now (06 §2.3: the judge sees facts, never acts). */
async function factsOf(
  services: Services.Context,
  ctx: Context,
  team: OwnTeam.Team,
  observed: Observation,
): Promise<JudgeValidate.Facts> {
  const inventory = observed.inventory
  const classified = Classify.classify(inventory.worktrees, { home: ctx.home.directory, patterns: team.patterns })
  const now = services.clock.now()
  const worktrees = await Promise.all(
    inventory.worktrees.map(async (item, index): Promise<JudgeValidate.Worktree> => {
      const found = classified[index]
      const sessions = item.sessions.toSorted((a, b) => b.updated - a.updated)
      return {
        path: item.path,
        class: found?.class ?? "candidate",
        nested: found?.nested ?? false,
        branch: item.branch,
        head: item.head,
        active: Activity.isActive(item, now),
        changes: item.changes?.uncommitted ?? 0,
        ahead: item.ahead ?? 0,
        sessions: sessions.map((session) => session.id),
        updated: sessions[0]?.updated ?? null,
        sparse: found?.class === "candidate" ? await Adopt.sparse(item.path) : false,
      }
    }),
  )
  const [trees, retirable, commands, areas] = await Promise.all([
    treesOf(ctx.commonDir, inventory.target.oid ?? ctx.target),
    retirableOf(ctx.commonDir, inventory.target, worktrees),
    JudgePrompt.candidates(ctx.home.directory),
    services.registry.areas.list(ctx.teamID),
  ])
  return {
    target: ctx.target,
    worktrees,
    branches: inventory.branches.map((branch) => branch.name),
    trees,
    direct: observed.measure.direct,
    ignored: observed.measure.ignored.map((item) => item.dir),
    commands,
    retirable,
    areas: areas
      .filter((area) => area.state !== "retired")
      .map((area) => ({
        slug: area.id.slice("ar_".length),
        directory: area.directory,
        branch: area.branch,
        owner: area.owner.sessionID,
      })),
    taken: fs.existsSync(ctx.worktreeRoot) ? fs.readdirSync(ctx.worktreeRoot) : [],
    mainSessionID: ctx.mainSessionID,
  }
}

/** V7: every folder of the target's tree. */
async function treesOf(commonDir: string, rev: string) {
  const result = await Git.run(["ls-tree", "-r", "-d", "-z", "--name-only", rev], { cwd: commonDir, worktree: true })
  return new Set(result.ok ? Porcelain.fields(result.stdout) : [])
}

/**
 * V13: a folder whose retirement the program can vouch for: on its own branch, with no commit outside the target, no
 * uncommitted work, a tip other than the target's, and a reflog that shows commits made on the branch (it had unique
 * commits, all in the target now).
 */
async function retirableOf(
  commonDir: string,
  target: { readonly name: string; readonly oid: string | null },
  worktrees: ReadonlyArray<JudgeValidate.Worktree>,
) {
  const checked = await Promise.all(
    worktrees
      .filter(
        (item) =>
          item.class === "candidate" &&
          item.branch !== null &&
          item.branch !== target.name &&
          item.ahead === 0 &&
          item.changes === 0 &&
          item.head !== target.oid,
      )
      .map(async (item) => {
        const log = await Git.run(["log", "-g", "--format=%gs", `refs/heads/${item.branch}`], {
          cwd: commonDir,
          worktree: true,
        })
        const committed = log.ok && log.stdout.split("\n").some((line) => line.startsWith("commit"))
        return committed ? [Classify.key(item.path)] : []
      }),
  )
  return new Set(checked.flat())
}

const KeepArgs = Schema.Struct({ ref: Schema.String, oid: Schema.String })
const decodeKeep = Schema.decodeUnknownSync(KeepArgs)

/** TI-8: commits only a detached HEAD holds get a create-only `refs/own/keep/<sha>`; undo keeps it (두기). */
function keepKind(): Steps.Kind {
  return {
    kind: "enable.keep",
    observe: async (input) => {
      const args = decodeKeep(input.step.args)
      const value = await Refs.read(context(input.op).commonDir, args.ref)
      if (value === undefined) return { state: "failed", note: `보관 표시를 읽지 못했어요: ${args.ref}` }
      return value === args.oid ? { state: "satisfied" } : { state: "pending" }
    },
    act: async (input) => {
      const args = decodeKeep(input.step.args)
      const created = await Refs.create(context(input.op).commonDir, args, "own.team keep")
      if (!created.ok) return { ok: false, note: created.message }
      input.services.notices.publish({
        teamID: input.op.teamID,
        kind: "detached.kept",
        text: "이름 없는 작업 상태를 보관해 뒀어요",
        data: { ref: args.ref },
      })
      return { ok: true }
    },
    verify: async (input) => {
      const args = decodeKeep(input.step.args)
      return (await Refs.read(context(input.op).commonDir, args.ref)) === args.oid
        ? { ok: true }
        : { ok: false, note: `보관 표시가 ${args.oid}에 있지 않아요: ${args.ref}` }
    },
  }
}

/** `worktree.refresh{projectID}`: core lists the new folders. A failure only leaves core's list stale. */
function refreshKind(): Steps.Kind {
  return {
    kind: "enable.refresh",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const team = await teamOf(input.services, input.op.teamID)
      const refreshed = await input.services.http.worktree.refresh({
        projectID: team.projectID,
        directory: team.home.directory,
      })
      if (refreshed.ok) return { ok: true }
      input.services.log.warn("worktree_refresh_failed", { teamID: team.id, type: refreshed.type })
      return { ok: true, note: "작업 폴더 목록을 새로 읽지 못했어요" }
    },
    verify: async () => ({ ok: true }),
  }
}

/**
 * The summary card (06 §9.3): created areas first, then what the judge step recorded. An area's `area-record` step
 * already put its line on the card when it made the record; only one whose record a resumed op found made (TI-11:
 * observed, not acted) gets it here, so no area is listed twice.
 */
function finishKind(): Steps.Kind {
  return {
    kind: "enable.finish",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const args = decodeFinish(input.step.args)
      const areas = await input.services.registry.areas.list(input.op.teamID)
      const listed = new Set(
        (input.op.summary?.lines ?? []).flatMap((line) =>
          line.kind === "area" && line.change === "created" ? [line.areaID] : [],
        ),
      )
      for (const areaID of args.created)
        if (!listed.has(areaID) && areas.some((area) => area.id === areaID))
          input.summary({ kind: "area", areaID, change: "created" })
      for (const line of args.lines) input.summary(line)
      const team = await teamOf(input.services, input.op.teamID)
      input.services.hub.publish({ name: "team.changed", data: { teamID: team.id, rev: team.rev } })
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}
