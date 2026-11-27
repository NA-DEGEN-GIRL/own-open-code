export * as Adopt from "./adopt.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { Classify } from "../git/classify.js"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import { JudgeValidate } from "../judge/validate.js"
import { Areas } from "../registry/area.js"
import { Cursor } from "../report/cursor.js"
import { OwnerSession } from "../sessions/owner.js"
import { TeamContext } from "../sessions/team-context.js"
import { Services } from "../services.js"
import { AreaCreate } from "./area-create.js"
import { TeamHome } from "./home.js"
import { Steps } from "./steps.js"
import { Journal } from "./journal.js"

/**
 * Adopting folders that are already there (06 §3.6, §3.7 진행 중 프로젝트, §8.2 팀에 넣기 / 빼기, §10.1) and taking them
 * out again. Adoption changes no file and no branch of the folder: it locks it, names a detached HEAD, and registers
 * the folder's most recent root session as the owner without touching that conversation (`owner.attached: false`; the
 * role, the team tool allows and the area preset come with the first main request, `sessions/owner.ts` `attach`).
 *
 *   team.lock         the folder, `own.team area:<id>` (TI-12); a nested folder's outer worktree, when it is a candidate
 *                     outside the team, `own: nested worktrees inside` (8.6: removing it would take the nested one along)
 *   adopt.keep        `refs/own/keep/<sha>` for commits only a detached HEAD holds (TI-8; enable has `enable.keep`)
 *   adopt.name        name-detached: `switch -c <name>` in a detached folder (same commit, no file change), after the
 *                     identity check (TI-14); skipped while a git operation is stopped half way there (3.2, 3.7), and
 *                     the area reconcile gives the name once it ended (`reconcile/area.ts`). A rebase stopped there is
 *                     planned with the branch it started from, which comes back when it ends: no new name
 *   adopt.register    the registry record: name = folder name, the judge's name as subtitle (the user's own row of 영역
 *                     만들기: the name the user typed, no subtitle, 06 §8.2), branch, git dir (identity),
 *                     base = the merge base with the target; `cursor:<owner>` at the owner's current log seq first, so
 *                     its old history is never folded into the team update (5.5); the folder leaves `team.external`
 *
 * The area main and preset are the conversation's (`main.chosenBy: "adopted"`, its preset in force), decided when
 * planning with the team-wide R4 (10.1): a conversation whose account would break R4 (another subscription of the team
 * main's company; one ChatGPT login's `codex` and `siwc` accounts are one subscription) is registered `팀과 같게` with
 * the ★ of the team main's group and an `r4` line, and continues on the team account in a new conversation at its
 * first main request (6.2, `dispatch/dispatch.ts`). A preset whose pinned targets break R4 becomes its group's ★,
 * then `평소대로`. When R4 cannot be judged (own.accounts or the sessions cannot be read) the folder is not adopted. A
 * conversation without a model (core's default would answer) or on a provider own.accounts does not know (no account,
 * no discovered local provider) fails closed the same way as another subscription: `팀과 같게`, and a new owner on the
 * team's model at the first main request.
 *
 * 팀에서 빼기 (`area.unadopt`, 8.2): `adopt.outbox` (waiting main requests cancelled and told to the main) →
 * `adopt.detach` (the team allows, the role entries and the binding's team context removed again) → `team.release`
 * (the nested rule keeps a lock) → `adopt.unregister` (only the registry record; folder, branch and conversations stay,
 * and the folder is listed in `team.external` as `left` again unless own still locks it). Undoing an enable or a
 * 팀에 넣기 detaches the same way and gives back the name of a detached HEAD while nothing was committed on it
 * (`adopt.unname`, 3.6).
 *
 * The kinds are registered with the enable kinds (`ops/undo.ts`), before the runner resumes a running op.
 */

export const KIND = {
  keep: "adopt.keep",
  name: "adopt.name",
  register: "adopt.register",
  outbox: "adopt.outbox",
  detach: "adopt.detach",
  unname: "adopt.unname",
  unregister: "adopt.unregister",
} as const

/** The 3.6 lock step kind (`ops/home.ts`). */
const LOCK = "team.lock"

export function register(services: Services.Context) {
  // 팀에 넣기 in a reorganization is undone as 빼기 (06 §8.2, `Steps.Kind.reverses`).
  for (const kind of kinds()) services.steps.register(kind.kind === KIND.register ? { ...kind, reverses: true } : kind)
}

// ---------------------------------------------------------------------------------------------------------------
// Planning

/** A folder to adopt: the judge's validated item, or the folder of 팀에 넣기, with what the inventory read of it. */
export interface Candidate {
  /** Pointer into the proposal (`areas/0`), or `adopt` for 팀에 넣기. */
  readonly item: string
  readonly slug: string
  /** The folder name (3.7). */
  readonly name: string
  /** The judge's name of the area, shown after the folder name (3.7). */
  readonly subtitle?: string
  readonly goal: string
  readonly shape: "plain" | "code" | "full"
  readonly worktree: Inventory.Worktree
  /** The innermost worktree around it and its class (8.6). */
  readonly outer?: { readonly path: string; readonly class: Classify.Class }
  /** The folder's most recent root session; `null` when it has none (the first main request makes one). */
  readonly owner: string | null
  /** The user chose the folder as an area of their own (영역 만들기 · 있는 작업 폴더, 2026-10-26): `Area.userMade`. */
  readonly userMade?: boolean
}

export type Spec = Steps.Spec & { readonly id: string }

export interface Planned {
  /** `team.lock` steps (3.6 켜기의 순서 (6): every lock before any registration). */
  readonly locks: ReadonlyArray<Spec>
  /** Per area: `adopt.name` for a detached HEAD, then `adopt.register`. */
  readonly steps: ReadonlyArray<Spec>
  readonly areas: ReadonlyArray<OwnTeam.AreaID>
  /** `Classify.key` of the folders planned for adoption. */
  readonly folders: ReadonlySet<string>
  /** Candidates left out (`skipped`: a folder that failed its identity check, or R4 could not be judged). */
  readonly lines: ReadonlyArray<OwnTeam.SummaryLine>
}

/**
 * The steps that adopt `candidates`, one after the other: each decision sees the team's R4 with the areas planned
 * before it. Reads only (sessions, own.accounts, git); nothing is written.
 */
export async function plan(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly candidates: ReadonlyArray<Candidate>
    /** Local branch names: a detached HEAD gets a name none of them has (V6). */
    readonly branches: ReadonlyArray<string>
  },
): Promise<Planned> {
  const team = input.team
  const snapshot = input.candidates.length === 0 ? undefined : await TeamContext.load(services, team.id)
  const adopting = new Set(input.candidates.map((candidate) => Classify.key(candidate.worktree.path)))
  const areas = snapshot?.areas ?? []
  const taken = new Set(input.branches)
  const result = {
    locks: [] as Spec[],
    steps: [] as Spec[],
    areas: [] as OwnTeam.AreaID[],
    folders: new Set<string>(),
    lines: [] as OwnTeam.SummaryLine[],
  }
  const state = { current: snapshot?.state }
  for (const candidate of input.candidates) {
    const current = state.current
    const areaID = Areas.id(candidate.slug)
    const directory = candidate.worktree.path
    const skip = (why: OwnTeam.SkipReason) => result.lines.push({ kind: "skipped", item: candidate.item, areaID, why })
    const identity = await identityOf(team.commonDir, directory)
    if (!identity.ok) {
      services.log.warn("adopt_identity_failed", { teamID: team.id, directory, message: identity.message })
      skip("broken")
      continue
    }
    const decided =
      snapshot && current ? await decide(services, snapshot, current, { areaID, directory, candidate }) : undefined
    if (!current || !decided) {
      services.log.warn("adopt_undecided", { teamID: team.id, directory })
      skip("invalid")
      continue
    }
    state.current = { ...current, holders: [...current.holders, decided.holder] }
    const worktree = candidate.worktree
    // A rebase stopped there shows a detached HEAD, but its branch comes back when it ends: no new name (3.7).
    const rebased = worktree.branch === null ? Inventory.rebasing(identity.gitDir) : undefined
    const branch = worktree.branch ?? rebased ?? JudgeValidate.unique(candidate.slug, (name) => taken.has(name))
    taken.add(branch)
    const outer = candidate.outer
    const protects =
      outer !== undefined &&
      outer.class === "candidate" &&
      !adopting.has(Classify.key(outer.path)) &&
      !areas.some((area) => Classify.same(area.directory, outer.path))
    result.locks.push(
      { id: `lock:${areaID}`, kind: LOCK, args: { directory, reason: Worktree.lockReason(areaID) } },
      ...(protects
        ? [{ id: `lock:outer:${areaID}`, kind: LOCK, args: { directory: outer.path, reason: TeamHome.NESTED } }]
        : []),
    )
    const naming = worktree.branch === null && rebased === undefined && worktree.head !== null
    if (naming)
      result.steps.push({
        id: `adopt:${candidate.slug}:name`,
        kind: KIND.name,
        args: { areaID, directory, branch, head: worktree.head },
      })
    result.steps.push({
      id: `adopt:${candidate.slug}:register`,
      kind: KIND.register,
      args: {
        areaID,
        item: candidate.item,
        name: candidate.name,
        ...(candidate.subtitle ? { subtitle: candidate.subtitle } : {}),
        goal: candidate.goal,
        directory,
        branch,
        shape: candidate.shape,
        owner: candidate.owner,
        ...(decided.main === undefined ? {} : { main: decided.main }),
        preset: decided.preset,
        ...(decided.r4 === undefined ? {} : { r4: decided.r4 }),
        ...(naming ? { naming: true } : {}),
        ...(candidate.userMade ? { userMade: true } : {}),
      },
    })
    result.areas.push(areaID)
    result.folders.add(Classify.key(directory))
  }
  return result
}

interface Decision {
  readonly main?: { readonly model: Model.Ref; readonly chosenBy: "adopted" }
  readonly preset: Preset.ID
  /** 10.1: the conversation's account would break the team's R4. */
  readonly r4?: Account.ID
  /** The area's side of R4 once adopted. */
  readonly holder: TeamContext.Holder
}

/**
 * The adopted area's main and preset (06 §3.7, §10.1): the conversation's Ref and its preset in force, unless its
 * account breaks the team's R4 (`팀과 같게`, the team main group's ★, `r4`) or its preset's pinned targets do (that
 * group's ★, then `평소대로`). A folder without a conversation, or a conversation without a model yet, is `팀과 같게`.
 * `undefined` when it cannot be judged: the team main's model or group, or the conversation, is unknown.
 */
async function decide(
  services: Services.Context,
  snapshot: TeamContext.Snapshot,
  state: TeamContext.State,
  input: { readonly areaID: OwnTeam.AreaID; readonly directory: string; readonly candidate: Candidate },
): Promise<Decision | undefined> {
  const main = state.holders[0]
  const teamGroup = main && TeamContext.groupOf(main)
  if (!main?.ref || !teamGroup) return undefined
  const star = (group: Preset.Group) => snapshot.group(group).star ?? Preset.builtinID(group)
  const breaks = (holder: TeamContext.Holder) =>
    TeamContext.breaks(state, { ...state, holders: [...state.holders, holder] })
  const same: Decision = {
    preset: star(teamGroup),
    holder: { areaID: input.areaID, ref: main.ref, account: main.account, preset: snapshot.preset(star(teamGroup)) },
  }
  const owner = input.candidate.owner
  if (owner === null) return same
  const session = await services.http.session.get({ sessionID: owner, directory: input.directory })
  if (!session.ok) return undefined
  const ref = session.value.model
  if (!ref) return same
  const bare: TeamContext.Holder = {
    areaID: input.areaID,
    ref,
    account: snapshot.account(ref.providerID),
    preset: undefined,
  }
  if (bare.account && breaks(bare) !== undefined) return { ...same, r4: bare.account.id }
  const kept = { model: ref, chosenBy: "adopted" as const }
  const group = TeamContext.groupOf(bare)
  // A provider own.accounts does not know (neither an account nor a discovered local provider) cannot be judged for
  // R4 and may be another subscription of the team's company (U5): 팀과 같게, as for a conversation without a model.
  // Its first main request then goes to a new owner on the team's model (`dispatch/dispatch.ts` `rival`).
  if (!group) return same
  const view = await services.accounts.presetGet({ sessionID: owner }, { directory: input.directory })
  const used = view.ok && view.value.preset?.group === group ? view.value.preset : undefined
  const chosen =
    [used, snapshot.preset(star(group))]
      .filter((preset) => preset !== undefined)
      .find((preset) => breaks({ ...bare, preset }) === undefined) ?? Preset.builtin(group)
  return { main: kept, preset: chosen.id, holder: { ...bare, preset: chosen } }
}

// ---------------------------------------------------------------------------------------------------------------
// 팀에 넣기 / 빼기 (8.2)

/**
 * `area.adopt{teamID, directory}`: an `adopt` op for one linked worktree of the team's repository that is neither the
 * home, the main worktree, another tool's, a `#` path nor gone (V3), and not an area already. Undoable (`op.undo`).
 */
export async function adoptOp(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly directory: string },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  if (!Git.isNative(input.directory))
    return Services.failure("path_forbidden", "not a native absolute path", { path: input.directory, why: "invalid" })
  const located = await Inventory.locate(input.directory)
  if (!located.ok) return Services.failure("not_git", located.message, { directory: input.directory })
  const refuse = (why: PathWhy) =>
    Services.failure("path_forbidden", "this folder cannot be adopted", { path: located.toplevel, why })
  if (!Identity.same(located.commonDir, team.commonDir)) return refuse("invalid")
  const sessions = await roots(services, team.projectID)
  const inventory = await Inventory.collect(team.commonDir, team.target, sessions)
  if (!inventory.ok) return Services.failure("not_git", inventory.message, { directory: input.directory })
  const index = inventory.worktrees.findIndex((item) => Identity.same(item.path, located.toplevel))
  const worktree = inventory.worktrees[index]
  if (!worktree) return refuse("invalid")
  const classified = Classify.classify(inventory.worktrees, { home: team.home.directory, patterns: team.patterns })
  const found = classified[index]
  const outside = found === undefined ? "invalid" : REFUSED[found.class]
  if (outside !== undefined) return refuse(outside)
  const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state !== "retired")
  if (
    areas.some(
      (area) =>
        Identity.same(area.directory, worktree.path) || (worktree.branch !== null && area.branch === worktree.branch),
    )
  )
    return refuse("invalid")
  const name = path.posix.basename(worktree.path.replaceAll("\\", "/"))
  const slug = JudgeValidate.unique(JudgeValidate.slugify(name), (value) =>
    areas.some((area) => area.id === Areas.id(value)),
  )
  const areaID = Areas.id(slug)
  const identity = await identityOf(team.commonDir, worktree.path)
  if (!identity.ok) return Services.failure("broken", identity.message, { areaID, why: identity.why })
  const outer = found?.outer ?? null
  const planned = await plan(services, {
    team,
    candidates: [
      {
        item: "adopt",
        slug,
        name: JudgeValidate.clean(name, JudgeValidate.LIMITS.name) || slug,
        goal: "",
        shape: team.heavy.dirs.length === 0 ? "plain" : (await sparse(worktree.path)) ? "code" : "full",
        worktree,
        ...(outer === null
          ? {}
          : { outer: { path: outer, class: classified.find((item) => item.path === outer)?.class ?? "candidate" } }),
        owner: worktree.sessions.toSorted((a, b) => b.updated - a.updated)[0]?.id ?? null,
      },
    ],
    branches: inventory.branches.map((branch) => branch.name),
  })
  if (planned.areas.length === 0)
    return Services.failure("internal_error", "the folder's conversation or the team's accounts could not be read", {})
  const keeps =
    worktree.detachedOnly.length > 0 && worktree.head !== null
      ? [
          {
            id: `keep:${worktree.head}`,
            kind: KIND.keep,
            args: { ref: `refs/own/keep/${worktree.head}`, oid: worktree.head },
          },
        ]
      : []
  const started = await services.runner.start({
    teamID: team.id,
    kind: "adopt",
    by: "user",
    areaID,
    undo: { available: true },
    steps: [...keeps, ...planned.locks, ...planned.steps],
  })
  if (!started.ok) return busy(team.id, started.op)
  return { ok: true, opID: started.op.id }
}

/**
 * `area.unadopt{teamID, areaID}` (8.2 빼기) for an adopted area at its safe point (8.4): an `unadopt` op that cancels
 * its waiting main requests, detaches its owner, releases the lock and removes the registry record.
 */
export async function unadoptOp(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  if (area.origin !== "adopted")
    return Services.failure("unsupported", "only an adopted area can be taken out of the team", { feature: "adopt" })
  const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id })
  if (!safe.ok)
    return Services.failure("not_safe_point", "the area is working", {
      areaID: area.id,
      why: safe.why,
      sessionIDs: safe.sessionIDs,
    })
  const started = await services.runner.start({
    teamID: team.id,
    kind: "unadopt",
    by: "user",
    areaID: area.id,
    undo: { available: false },
    steps: [
      { id: "outbox", kind: KIND.outbox, args: { areaID: area.id } },
      { id: "detach", kind: KIND.detach, args: { areaID: area.id } },
      {
        id: "release",
        kind: "team.release",
        args: { directory: area.directory, reason: Worktree.lockReason(area.id) },
      },
      { id: "unregister", kind: KIND.unregister, args: { areaID: area.id } },
    ],
  })
  if (!started.ok) return busy(team.id, started.op)
  return { ok: true, opID: started.op.id }
}

/**
 * The steps that undo the adoptions of an `enable` or `adopt` op (3.8 되돌리기, 8.2 반대): each registered owner is
 * detached and a HEAD it named gets its detached state back; the locks are the undo's `team.restore` steps. An `adopt`
 * op also cancels the area's waiting requests and removes its record (an enable's undo removes every record).
 */
export function reverse(op: OwnTeam.Op): ReadonlyArray<Spec> {
  const named = op.steps.flatMap((step) =>
    step.kind === KIND.name && step.state === "done" ? [decodeName(step.args)] : [],
  )
  return op.steps.flatMap((step) => {
    if (step.kind !== KIND.register) return []
    const args = decodeRegister(step.args)
    const name = named.find((item) => item.areaID === args.areaID)
    const own = op.kind === "adopt"
    return [
      ...(own ? [{ id: `outbox:${args.areaID}`, kind: KIND.outbox, args: { areaID: args.areaID } }] : []),
      { id: `detach:${args.areaID}`, kind: KIND.detach, args: { areaID: args.areaID } },
      ...(name === undefined ? [] : [{ id: `unname:${args.areaID}`, kind: KIND.unname, args: name }]),
    ]
  })
}

/** The record removals that end the undo of an `adopt` op (after its locks are restored). */
export function unregisters(op: OwnTeam.Op): ReadonlyArray<Spec> {
  return op.steps.flatMap((step) => {
    if (step.kind !== KIND.register) return []
    const areaID = decodeRegister(step.args).areaID
    return [{ id: `unregister:${areaID}`, kind: KIND.unregister, args: { areaID } }]
  })
}

/** Why 팀에 넣기 refuses a folder of each outside class (V3). */
const REFUSED: Readonly<Partial<Record<Classify.Class, PathWhy>>> = {
  home: "invalid",
  primary: "primary",
  "other-tool": "other-tool",
  prunable: "prunable",
  "hash-path": "hash",
}

type PathWhy = Extract<Services.Failure, { readonly error: "path_forbidden" }>["data"]["why"]

function busy(teamID: OwnTeam.TeamID, op: OwnTeam.Op) {
  return Services.failure("busy", "another team op is running", Journal.busy(op))
}

// ---------------------------------------------------------------------------------------------------------------
// Inventory reads shared with enable

/** A root session as enable and 팀에 넣기 read it (its model decides the team main's, 07 §2.2). */
export interface Root extends Inventory.Session {
  readonly model?: Model.Ref
}

/** Session list pages read for the inventory (100 root sessions each). */
const PAGES = 10

/** The project's root sessions (`session.list{project, parentID: null}`), at most {@link PAGES} pages. */
export async function roots(services: Services.Context, project: string): Promise<Root[]> {
  const page = async (cursor: string | undefined, count: number): Promise<Root[]> => {
    const listed = await services.http.session.list({ project, parentID: null, limit: 100, cursor })
    if (!listed.ok) {
      services.log.warn("inventory_sessions_unreadable", { type: listed.type })
      return []
    }
    const items = listed.value.data.flatMap((session): Root[] =>
      session.parentID === undefined
        ? [
            {
              id: session.id,
              directory: session.location.directory,
              updated: session.time.updated,
              ...(session.model === undefined ? {} : { model: session.model }),
            },
          ]
        : [],
    )
    // The service names a next page even after the last one, so a short page ends the list too.
    const next = listed.value.cursor.next ?? undefined
    return next === undefined || listed.value.data.length < 100 || count >= PAGES
      ? items
      : [...items, ...(await page(next, count + 1))]
  }
  return page(undefined, 1)
}

/** A sparse (code-only) checkout: an adopted one keeps its shape (3.7: enabling converts nothing). */
export async function sparse(directory: string) {
  const result = await Git.run(["config", "--get", "core.sparseCheckout"], { cwd: directory, worktree: true })
  return result.ok && result.stdout.trim() === "true"
}

// ---------------------------------------------------------------------------------------------------------------
// Git reads

/**
 * A folder to adopt has no recorded git dir yet, so its identity (06 §4.3) is its own `rev-parse`: the folder is its
 * top level, and its git dir is one of `<common dir>/worktrees/*`.
 */
async function identityOf(
  commonDir: string,
  directory: string,
): Promise<
  | { readonly ok: true; readonly gitDir: string }
  | { readonly ok: false; readonly why: "missing" | "identity"; readonly message: string }
> {
  const observed = await Identity.observe(directory)
  if (!observed.ok) return { ok: false, why: observed.why, message: observed.message }
  if (!Identity.same(observed.toplevel, directory))
    return { ok: false, why: "identity", message: `맨 위 폴더가 이 폴더가 아니에요: ${observed.toplevel}` }
  if (!Identity.inside(path.join(commonDir, "worktrees"), observed.gitDir))
    return {
      ok: false,
      why: "identity",
      message: `Git 폴더가 이 저장소(${commonDir})의 작업 폴더가 아니에요: ${observed.gitDir}`,
    }
  return { ok: true, gitDir: observed.gitDir }
}

/** The branch HEAD names; `null` for a detached HEAD; `undefined` when git cannot answer. */
async function headBranch(directory: string) {
  const result = await Git.run(["symbolic-ref", "-q", "HEAD"], { cwd: directory, worktree: true })
  if (result.ok) {
    const ref = result.stdout.trim()
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null
  }
  // `-q`: exit 1 without a message for a detached HEAD.
  return result.reason === "exit" && result.code === 1 ? null : undefined
}

async function headOid(directory: string) {
  const result = await Git.run(["rev-parse", "--verify", "-q", "HEAD"], { cwd: directory, worktree: true })
  const oid = result.ok ? result.stdout.trim() : ""
  return Git.isOid(oid) ? oid : undefined
}

/** Where the folder's work left the target: their merge base, else HEAD itself (no common history). */
async function baseOf(directory: string, target: string, head: string) {
  const result = await Git.run(["merge-base", `refs/heads/${target}`, head], { cwd: directory, worktree: true })
  const oid = result.ok ? result.stdout.trim() : ""
  return Git.isOid(oid) ? oid : head
}

const decodeSynced = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("log.synced"), seq: NonNegativeInt }),
)

/**
 * The newest seq of a session's log (its `log.synced` mark, or the last durable item): the adopted owner's cursor, so
 * nothing it said before adoption is folded into the team update. `undefined` for an empty log.
 */
/** The last durable seq of a conversation's log: a registered conversation's cursor starts after its old history. */
export async function watermark(
  services: Services.Context,
  ref: { readonly sessionID: string; readonly directory: string },
) {
  const log = await services.http.session.log(ref)
  if (!log.ok) return { ok: false as const, message: log.message }
  const seqs = log.value.flatMap((item) => {
    const synced = Option.getOrUndefined(decodeSynced(item))
    if (synced) return [synced.seq]
    const durable = Cursor.item(item)
    return durable ? [durable.seq] : []
  })
  return { ok: true as const, seq: seqs.length === 0 ? undefined : Math.max(...seqs) }
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const KeepArgs = Schema.Struct({ ref: Schema.String, oid: OwnTeam.Sha })

const NameArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  directory: Schema.String,
  branch: Schema.String,
  /** The detached HEAD the name points at. */
  head: OwnTeam.Sha,
})
const decodeName = Schema.decodeUnknownSync(NameArgs)

const RegisterArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  /** Pointer into the proposal, for a `skipped` line. */
  item: Schema.String,
  name: Schema.String,
  subtitle: optional(Schema.String),
  goal: Schema.String,
  directory: Schema.String,
  /** The folder's branch, or the name `adopt.name` gives its detached HEAD. */
  branch: Schema.String,
  shape: Schema.Literals(["plain", "code", "full"]),
  owner: Schema.NullOr(SessionID),
  main: optional(Schema.Struct({ model: Model.Ref, chosenBy: Schema.Literal("adopted") })),
  preset: Preset.ID,
  r4: optional(Account.ID),
  /** An `adopt.name` step comes first: a HEAD still detached at registration had its naming deferred (3.7). */
  naming: optional(Schema.Literal(true)),
  /** The user's own adopt row (2026-10-26): the record carries `userMade`. */
  userMade: optional(Schema.Literal(true)),
})
const decodeRegister = Schema.decodeUnknownSync(RegisterArgs)

const AreaArgs = Schema.Struct({ areaID: OwnTeam.AreaID })

const DONE: Steps.Outcome = { ok: true }

async function teamOf(services: Services.Context, teamID: string) {
  const team = await services.registry.teams.get(teamID)
  if (!team) throw new Error(`팀 기록이 없어요: ${teamID}`)
  return team
}

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.keep, KeepArgs, {
      observe: async (args, input) => {
        const value = await Refs.read((await teamOf(input.services, input.op.teamID)).commonDir, args.ref)
        if (value === undefined) return { state: "failed", note: `보관 표시를 읽지 못했어요: ${args.ref}` }
        return value === args.oid ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const created = await Refs.create(
          (await teamOf(input.services, input.op.teamID)).commonDir,
          args,
          "own.team keep",
        )
        if (!created.ok) return { ok: false, note: created.message }
        input.services.notices.publish({
          teamID: input.op.teamID,
          kind: "detached.kept",
          text: "이름 없는 작업 상태를 보관해 뒀어요",
          data: { ref: args.ref },
        })
        input.summary({ kind: "ref", ref: args.ref, sha: args.oid })
        return DONE
      },
      verify: async (args, input) =>
        (await Refs.read((await teamOf(input.services, input.op.teamID)).commonDir, args.ref)) === args.oid
          ? DONE
          : { ok: false, note: `보관 표시가 ${args.oid}에 있지 않아요: ${args.ref}` },
    }),

    Steps.define(KIND.name, NameArgs, {
      observe: async (args, input) => {
        const team = await teamOf(input.services, input.op.teamID)
        const identity = await identityOf(team.commonDir, args.directory)
        if (!identity.ok) return { state: "skip", note: `작업 폴더를 확인하지 못해 건너뛰었어요: ${identity.message}` }
        const branch = await headBranch(args.directory)
        if (branch === undefined) return { state: "failed", note: `${args.directory}의 지금 위치를 읽지 못했어요` }
        if (branch === args.branch) return { state: "satisfied" }
        if (branch !== null) return { state: "skip", note: `이미 기록 이름 ${branch}에 있어요` }
        if (Inventory.operations(identity.gitDir).length > 0)
          return { state: "skip", note: "진행 중인 Git 작업이 끝날 때까지 이름 붙이기를 미뤄요" }
        const existing = await Refs.read(team.commonDir, `refs/heads/${args.branch}`)
        if (existing === undefined) return { state: "failed", note: `기록 이름을 읽지 못했어요: ${args.branch}` }
        if (existing !== null && existing !== (await headOid(args.directory)))
          return { state: "failed", note: `기록 이름이 이미 다른 저장 지점(${existing})에 있어요: ${args.branch}` }
        return { state: "pending" }
      },
      act: async (args, input) => {
        const team = await teamOf(input.services, input.op.teamID)
        // TI-14: the folder is checked again right before its HEAD changes.
        const identity = await identityOf(team.commonDir, args.directory)
        if (!identity.ok) return { ok: false, note: identity.message }
        const existing = await Refs.read(team.commonDir, `refs/heads/${args.branch}`)
        // Same commit: the files stay as they are (uncommitted work included).
        const switched = await Git.run(existing === null ? ["switch", "-c", args.branch] : ["switch", args.branch], {
          cwd: args.directory,
          write: true,
          worktree: true,
        })
        return switched.ok ? DONE : { ok: false, note: switched.message }
      },
      verify: async (args) =>
        (await headBranch(args.directory)) === args.branch
          ? DONE
          : { ok: false, note: `폴더가 기록 이름 ${args.branch}에 있지 않아요: ${args.directory}` },
    }),

    Steps.define(KIND.register, RegisterArgs, {
      observe: async (args, input) => {
        const services = input.services
        const record = await services.registry.areas.get(input.op.teamID, args.areaID)
        if (record) {
          if (!Identity.same(record.directory, args.directory))
            return { state: "failed", note: `${args.areaID} 영역은 다른 폴더에 있어요` }
          // Registered by an act whose result was not written (a restart): its card lines come with this result.
          registered(input, args)
          return { state: "satisfied" }
        }
        const skip = (why: OwnTeam.SkipReason, note: string): Steps.Observed => {
          input.summary({ kind: "skipped", item: args.item, areaID: args.areaID, why })
          return { state: "skip", note }
        }
        const team = await teamOf(services, input.op.teamID)
        const identity = await identityOf(team.commonDir, args.directory)
        if (!identity.ok) return skip("broken", `작업 폴더를 확인하지 못해 건너뛰었어요: ${identity.message}`)
        const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state !== "retired")
        const branch = (await headBranch(args.directory)) ?? args.branch
        if (
          areas.some(
            (area) =>
              Identity.same(area.directory, args.directory) ||
              area.branch === branch ||
              (args.owner !== null && area.owner.sessionID === args.owner),
          ) ||
          args.owner === team.main.sessionID
        )
          return skip("invalid", "이미 다른 영역에 있어요")
        return { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const team = await teamOf(services, input.op.teamID)
        const identity = await identityOf(team.commonDir, args.directory)
        if (!identity.ok) return { ok: false, note: identity.message }
        const [branch, head] = await Promise.all([headBranch(args.directory), headOid(args.directory)])
        if (branch === undefined || head === undefined)
          return { ok: false, note: `${args.directory}의 지금 위치를 읽지 못했어요` }
        const [base, mark] = await Promise.all([
          baseOf(args.directory, team.target, head),
          args.owner === null
            ? Promise.resolve({ ok: true as const, seq: undefined })
            : watermark(services, { sessionID: args.owner, directory: args.directory }),
        ])
        if (!mark.ok) return { ok: false, note: `대화 기록을 읽지 못했어요: ${mark.message}` }
        const now = services.clock.now()
        const area: OwnTeam.Area = {
          id: args.areaID,
          teamID: team.id,
          name: args.name,
          ...(args.subtitle === undefined ? {} : { subtitle: args.subtitle }),
          goal: args.goal,
          origin: "adopted",
          state: "active",
          branch: branch ?? args.branch,
          // `adopt.name` waited for a stopped git operation: the area reconcile names it once that ended (8.8).
          ...(branch === null && args.naming === true ? { deferredName: true as const } : {}),
          gitDir: identity.gitDir,
          base: { sha: base, at: now },
          directory: args.directory,
          shape: args.shape,
          cone: { extra: {}, kept: {} },
          owner: { sessionID: args.owner, previous: [], attached: false },
          ...(args.main === undefined ? {} : { main: args.main }),
          preset: args.preset,
          paused: false,
          status: { kind: "idle", at: now, text: "" },
          handoff: null,
          ...(args.userMade ? { userMade: { at: now } } : {}),
        }
        const owner = args.owner
        const seq = mark.seq
        const rev = await services.write(team.id, async () => {
          // The cursor first: a catch-up that runs between the two writes already starts after the old history.
          if (owner !== null && seq !== undefined) await Cursor.set(services.kv, owner, seq)
          await AreaCreate.save(services, area)
          return outside(services, team.id, args.directory, false)
        })
        if (rev !== undefined) services.hub.publish({ name: "team.changed", data: { teamID: team.id, rev } })
        registered(input, args)
        return DONE
      },
      verify: async (args, input) =>
        (await input.services.registry.areas.get(input.op.teamID, args.areaID))
          ? DONE
          : { ok: false, note: `${args.areaID} 영역이 기록되지 않았어요` },
    }),

    Steps.define(KIND.outbox, AreaArgs, {
      observe: async (args, input) =>
        (await input.services.registry.areas.get(input.op.teamID, args.areaID))
          ? { state: "pending" }
          : { state: "skip", note: "영역이 없어 건너뛰었어요" },
      act: async (args, input) => {
        const services = input.services
        const area = await services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area) return DONE
        // Outside the team's write section: the outbox serializes per area and writes through the mutex itself.
        const cancelled = await services.features().admit.cancelAll({ teamID: area.teamID, areaID: area.id })
        for (const item of cancelled)
          input.summary({ kind: "cancelled", areaID: item.areaID, dispatchID: item.dispatchID })
        const count = cancelled.length
        await services.features().digest.add(area.teamID, {
          at: services.clock.now(),
          reason: "unadopted",
          text: `${area.name}: 팀에서 뺐습니다${count === 0 ? "" : ` · 기다리던 메인 요청 ${count}개를 보내지 않았습니다`}`,
          wake: false,
        })
        return DONE
      },
      verify: async () => DONE,
    }),

    Steps.define(KIND.detach, AreaArgs, {
      observe: async (args, input) => {
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area) return { state: "skip", note: "영역이 없어 건너뛰었어요" }
        // An attached area peer (동료) loses its team allows and role too.
        const peers = (area.peers ?? []).some((peer) => peer.attached)
        // 담당 대화 바꾸기: a conversation still listed in `owner.release` holds owner things, and the list goes with
        // the record.
        const listed = (area.owner.release ?? []).length > 0
        return area.owner.sessionID === null && !peers && !listed ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const target = { teamID: input.op.teamID, areaID: args.areaID, signal: input.signal }
        await input.services.features().seat.sweep({ teamID: input.op.teamID, areaID: args.areaID, inside: true })
        const detached = await OwnerSession.detach(input.services, target)
        if (!detached.ok) return { ok: false, note: detached.message }
        const peers = await input.services.features().peers.detach(target)
        return peers.ok ? DONE : { ok: false, note: peers.message }
      },
      verify: async () => DONE,
    }),

    Steps.define(KIND.unname, NameArgs, {
      observe: async (args, input) => {
        const team = await teamOf(input.services, input.op.teamID)
        const identity = await identityOf(team.commonDir, args.directory)
        if (!identity.ok) return { state: "skip", note: `작업 폴더를 확인하지 못해 건너뛰었어요: ${identity.message}` }
        const [branch, tip] = await Promise.all([
          headBranch(args.directory),
          Refs.read(team.commonDir, `refs/heads/${args.branch}`),
        ])
        // Work went on there (a commit, another branch): the name stays the user's.
        if (branch !== args.branch || tip !== args.head) return { state: "satisfied", note: "그대로 뒀어요" }
        if (Inventory.operations(identity.gitDir).length > 0)
          return { state: "skip", note: "진행 중인 Git 작업이 있어 그대로 뒀어요" }
        return { state: "pending" }
      },
      act: async (args, input) => {
        const team = await teamOf(input.services, input.op.teamID)
        const identity = await identityOf(team.commonDir, args.directory)
        if (!identity.ok) return { ok: false, note: identity.message }
        const switched = await Git.run(["switch", "--detach"], { cwd: args.directory, write: true, worktree: true })
        if (!switched.ok) return { ok: false, note: switched.message }
        const ref = `refs/heads/${args.branch}`
        const listed = await Worktree.list(team.commonDir)
        // TI-4's exception: a name this op gave, still at that commit and checked out nowhere.
        if (listed.ok && !listed.worktrees.some((item) => item.branch === ref))
          await Refs.removeIf(team.commonDir, { ref, oid: args.head }, "own.team undo")
        return DONE
      },
      verify: async (args) =>
        (await headBranch(args.directory)) === null
          ? DONE
          : { ok: false, note: `${args.directory}에 아직 기록 이름이 있어요` },
    }),

    Steps.define(KIND.unregister, AreaArgs, {
      observe: async (args, input) =>
        (await input.services.registry.areas.get(input.op.teamID, args.areaID))
          ? { state: "pending" }
          : { state: "satisfied" },
      act: async (args, input) => {
        const services = input.services
        const teamID = input.op.teamID
        const [area, team] = await Promise.all([
          services.registry.areas.get(teamID, args.areaID),
          services.registry.teams.get(teamID),
        ])
        // The folder is outside again, unless own still locks it (a nested area inside, 8.6): reconcile leaves those
        // out as well.
        const locks = area && team ? await TeamHome.snapshot(team.commonDir) : undefined
        const lock = area ? TeamHome.before(locks ?? {}, area.directory) : null
        const rev = await services.write(teamID, async () => {
          const removed = await services.registry.areas.remove(teamID, args.areaID)
          if (!area || (lock !== null && Classify.ownLock(lock))) return removed
          return (await outside(services, teamID, area.directory, true)) ?? removed
        })
        if (rev !== undefined) services.hub.publish({ name: "team.changed", data: { teamID, rev } })
        input.summary({ kind: "area", areaID: args.areaID, change: "unadopted" })
        return DONE
      },
      verify: async (args, input) =>
        (await input.services.registry.areas.get(input.op.teamID, args.areaID)) === undefined
          ? DONE
          : { ok: false, note: "영역 기록이 남아 있어요" },
    }),
  ]
}

/**
 * `team.external` follows 팀에 넣기 and 빼기 at once (8.2): an adopted folder leaves the outside list (9.4 never offers an
 * area), a folder taken out comes back as `left` without waiting for the next reconcile (8.8), which still owns the
 * list afterwards and announces nothing for a folder already listed. Inside the team's write section; the team's new
 * `rev` when the list changed.
 */
async function outside(services: Services.Context, teamID: OwnTeam.TeamID, directory: string, left: boolean) {
  const team = await services.registry.teams.get(teamID)
  if (!team) return undefined
  const rest = team.external.filter((item) => !Classify.same(item.directory, directory))
  if (!left && rest.length === team.external.length) return undefined
  if (left && team.external.some((item) => Classify.same(item.directory, directory) && item.why === "left"))
    return undefined
  const external: OwnTeam.External[] = left ? [...rest, { directory, why: "left" }] : rest
  return (await services.registry.teams.put({ ...team, external })).rev
}

/** The card lines of a registration (06 §9.3): the adopted area, and the R4 line when it continues on the team account. */
function registered(input: Steps.Input, args: typeof RegisterArgs.Type) {
  input.summary({ kind: "area", areaID: args.areaID, change: "adopted" })
  if (args.r4 !== undefined) input.summary({ kind: "r4", areaID: args.areaID, accountID: args.r4 })
}
