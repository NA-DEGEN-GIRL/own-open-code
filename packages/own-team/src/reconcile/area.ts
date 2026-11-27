export * as Reconcile from "./area.js"

import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import type { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Classify } from "../git/classify.js"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import type { Notices } from "../notices.js"
import type { Steps } from "../ops/steps.js"
import type { Services } from "../services.js"

/**
 * Area reconcile (06 §8.8): follows what users and agents change outside own. The registry keeps only an area's branch,
 * folder and git dir (`area.branch`, `area.directory`, `area.gitDir`), so this observes the repository when the team is
 * enabled, at safe points and when the controller starts, and brings those (and the `broken` state) in line:
 *
 *   HEAD on another branch no other area uses     `area.branch` follows it and the `candidate` goes (`branch.followed`)
 *   HEAD on another area's branch                  both areas are `broken` (`shared-branch`); on the team's target (the
 *                                                  home's), the area alone
 *   HEAD detached with commits nothing else has    `refs/own/keep/<HEAD>` (TI-8, the `enable.keep` rule, `detached.kept`)
 *   the folder gone and its git dir elsewhere      `area.directory` follows (`folder.followed`); the owner conversation
 *                                                  moves there at the area's next safe point
 *   the folder gone, not the worktree, no branch   `broken` (`missing`, `identity`, `branch-gone`); `identity` and
 *                                                  `branch-gone` also go to the main as team news
 *   a linked worktree the team does not know       recorded in `team.external`; one the team could take in is listed as
 *                                                  unadopted (`팀에 넣기`) and announced once (`external.found`)
 *
 * "Elsewhere" is what git lists: a `git worktree move`, or a folder moved by hand and then `git worktree repair`ed. A
 * folder moved by hand alone is still listed at its old path, so it is `missing`.
 *
 * Observe → act, and the act never touches files, branches or cones: its git writes are a create-only keep ref and, for
 * an adopted area whose detached HEAD 팀에 넣기 could not name while a git operation was stopped there (3.7 미룬다), that
 * name given once the operation ended (`switch -c` at the same commit, as `adopt.name`; without it the area would read
 * as `branch-gone`). A folder with a git operation stopped half way (rebase, merge, …) is observed only: its branch is
 * not followed, no keep ref is made and its conversation is not moved. Main 멈춤 holds none of it (TI-13 leaves
 * following a moved folder outside its rule, and the rest only records). A broken state ends by itself once the
 * observation no longer finds it; while it lasts `team.get` shows an open `area.broken` notice (`Notices.keep`), and
 * the area's waiting main requests stay waiting (`dispatch/dispatch.ts` holds the requests of a broken area). Registry
 * writes go through `Services.Base.write`, so {@link Service.run} must not be called inside a write section.
 *
 * A conversation is moved only after its folder (4.14: own never moves conversations by itself): the owner's location
 * is gone and is not inside the area's folder. It moves once, at the area's extended safe point while the owner runs
 * nowhere, through a live instance's `ctx.session.move` (as `ops/home.ts` does), and gets the
 * {@link OwnTeam.MOVED_META} mark for own-web's banner (`이 대화는 옮기기 전 지점으로 되돌릴 수 없습니다`). Not at a
 * safe point, the next run tries again.
 */

/** When reconcile runs (06 §8.8); for the log only. */
export type Trigger = "enable" | "safe-point" | "start"

/** The step kind that moves an owner conversation after its folder (8.8), registered by {@link create}. */
export const MOVE = "reconcile-move"

/** What one run changed. */
export type Change =
  | { readonly kind: "directory"; readonly areaID: OwnTeam.AreaID; readonly from: string; readonly to: string }
  | { readonly kind: "branch"; readonly areaID: OwnTeam.AreaID; readonly from: string; readonly to: string }
  /** The area became broken, or broken for another reason. */
  | { readonly kind: "broken"; readonly areaID: OwnTeam.AreaID; readonly why: OwnTeam.BrokenReason }
  /** The broken state ended. */
  | { readonly kind: "repaired"; readonly areaID: OwnTeam.AreaID }
  | { readonly kind: "kept"; readonly areaID: OwnTeam.AreaID; readonly ref: string; readonly sha: string }
  | {
      readonly kind: "moved"
      readonly areaID: OwnTeam.AreaID
      readonly sessionID: SessionID
      readonly from: string
      readonly to: string
    }
  /** `team.external` gained or lost folders (by directory). */
  | {
      readonly kind: "external"
      readonly added: ReadonlyArray<OwnTeam.External>
      readonly removed: ReadonlyArray<string>
    }

export type Unadopted = Extract<OwnTeam.SummaryLine, { readonly kind: "unadopted" }>

export interface Outcome {
  readonly changes: ReadonlyArray<Change>
  /** The notices this run published. */
  readonly notices: ReadonlyArray<Notices.Notice>
  /** Every linked worktree outside the team that it could take in (`팀에 넣기`), not only the new ones. */
  readonly unadopted: ReadonlyArray<Unadopted>
}

export interface Service {
  run(
    team: Pick<OwnTeam.Team, "id">,
    input: { readonly trigger: Trigger; readonly signal?: AbortSignal },
  ): Promise<Outcome>
}

export function create(services: Services.Context): Service {
  services.steps.register(moveKind())
  // One run per team at a time: triggers that overlap (a safe point, the controller's start) wait for each other, so
  // an owner is never moved twice (core's move is a new inbox item each time, not idempotent, 06 §8.2).
  const runs = new Map<string, Promise<unknown>>()
  return {
    run: (team, input) => {
      const next = (runs.get(team.id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => run(services, team, input))
      runs.set(team.id, next)
      return next
    },
  }
}

const NOTHING: Outcome = { changes: [], notices: [], unadopted: [] }

/** The areas reconcile looks after; a retiring area belongs to its op. */
const LIVE: ReadonlySet<OwnTeam.Area["state"]> = new Set(["active", "broken"])

/** The `team.external` reason of each class (06 §3.2); the home is the team's. */
const EXTERNAL: Readonly<Partial<Record<Classify.Class, OwnTeam.External["why"]>>> = {
  primary: "primary",
  "other-tool": "other-tool",
  "hash-path": "hash-path",
  prunable: "prunable",
  candidate: "left",
}

/** The default text of `area.broken` by reason (own-web words it from `data.why`). */
const BROKEN: Readonly<Record<OwnTeam.BrokenReason, (area: string) => string>> = {
  identity: (area) => `'${area}' 폴더의 정보가 맞지 않아 멈췄어요`,
  missing: (area) => `'${area}' 폴더를 찾을 수 없어요`,
  "branch-gone": (area) => `'${area}'의 기록이 지워졌어요`,
  "shared-branch": () => "두 영역이 같은 기록을 써요",
}

/** Broken states the main hears about (8.8 `메인에 팀 소식`). */
const NEWS: ReadonlySet<OwnTeam.BrokenReason> = new Set(["identity", "branch-gone"])

/** The team news line of such an area, after its status word (`멈춤(기록이 지워짐)`). */
const WAITS = "고칠 때까지 이 영역에 보내는 메인 요청은 기다립니다"

const encode = Schema.encodeSync(OwnTeam.Area)
const decodeMetadata = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

/** What one area looks like now. */
interface Seen {
  /** The record as it was when observed. */
  readonly area: OwnTeam.Area
  readonly directory: string
  readonly branch: string
  /** `null`: not broken. */
  readonly broken: OwnTeam.BrokenReason | null
  /** HEAD of a detached worktree whose commits no branch, remote or tag holds (TI-8). */
  readonly keep?: string
  /** A git operation stopped half way in the folder: observed only. */
  readonly stopped: boolean
  /**
   * An adopted area whose detached HEAD 팀에 넣기 was to name while a git operation was stopped there (3.7 미룬다,
   * `area.deferredName`): the name it was registered with does not exist yet, HEAD is still detached and the operation
   * has ended. {@link name} gives it now. A branch the user deleted later is never made again (no mark).
   */
  readonly unnamed?: boolean
}

type Folder =
  | { readonly ok: true; readonly directory: string; readonly entry: Inventory.Worktree }
  | { readonly ok: false; readonly why: "missing" | "identity" }

async function run(
  services: Services.Context,
  input: Pick<OwnTeam.Team, "id">,
  options: { readonly trigger: Trigger; readonly signal?: AbortSignal },
): Promise<Outcome> {
  const team = await services.registry.teams.get(input.id)
  if (!team || team.state !== "on") return NOTHING
  const inventory = await Inventory.collect(team.commonDir, team.target, [])
  if (!inventory.ok) {
    services.log.warn("reconcile_inventory_failed", { teamID: team.id, message: inventory.message })
    return NOTHING
  }
  const seen = await name(services, team, await observe(team, await services.registry.areas.list(team.id), inventory))
  // TI-8: unnamed work is kept before anything else happens.
  const kept = await keep(services, team, seen)
  const written = await record(services, team.id, seen, inventory)
  written.areas.forEach((item) => {
    if (item.rev === undefined) return
    services.hub.publish({
      name: "area.changed",
      data: {
        teamID: team.id,
        areaID: item.after.id,
        rev: item.rev,
        status: item.after.status,
        paused: item.after.paused,
      },
    })
  })
  if (written.team) services.hub.publish({ name: "team.changed", data: { teamID: team.id, rev: written.team.rev } })

  const areas = await services.registry.areas.list(team.id)
  const named = (areaID: OwnTeam.AreaID) => areas.find((area) => area.id === areaID)?.name ?? areaID
  const changes: ReadonlyArray<Change> = [
    ...kept,
    ...written.areas.flatMap((item) => changesOf(item.before, item.after)),
    ...(written.external ? [written.external] : []),
  ]
  const notices = changes.flatMap((change) => noticeOf(team.id, change, named))
  notices.forEach((notice) => services.notices.publish(notice))
  // Open while it lasts (`team.get` `notices`): a window opened later, or after a restart, still shows it.
  await services.notices.keep(
    team.id,
    "area.broken",
    areas.flatMap((area) =>
      area.state === "broken" && area.broken
        ? [
            {
              id: `area.broken:${area.id}:${area.broken.why}`,
              at: area.broken.at,
              areaID: area.id,
              kind: "area.broken" as const,
              text: BROKEN[area.broken.why](area.name),
              data: { why: area.broken.why },
            },
          ]
        : [],
    ),
  )
  const now = services.clock.now()
  await Promise.all(
    changes.flatMap((change) =>
      change.kind === "broken" && NEWS.has(change.why)
        ? [
            services
              .features()
              .digest.add(team.id, { at: now, areaID: change.areaID, reason: "broken", text: WAITS, wake: true }),
          ]
        : [],
    ),
  )

  const moved = await Promise.all(
    seen.map(async (item) => {
      const area = areas.find((candidate) => candidate.id === item.area.id)
      if (!area || area.state !== "active" || item.stopped || item.broken !== null) return []
      const previous = item.directory === item.area.directory ? undefined : item.area.directory
      return follow(services, team, area, previous, options.signal)
    }),
  )
  const all = [...changes, ...moved.flat()]
  if (all.length > 0)
    services.log.info("reconcile", {
      teamID: team.id,
      trigger: options.trigger,
      changes: all.map((change) => change.kind),
    })
  return { changes: all, notices, unadopted: written.unadopted }
}

// ---------------------------------------------------------------------------------------------------------------
// Observing

async function observe(
  team: OwnTeam.Team,
  areas: ReadonlyArray<OwnTeam.Area>,
  inventory: Inventory.Result,
): Promise<ReadonlyArray<Seen>> {
  const live = areas.filter((area) => LIVE.has(area.state))
  const folders = await Promise.all(live.map((area) => folderOf(area, inventory)))
  const stopped = live.map((area, index) => folders[index]?.ok === true && Inventory.operations(area.gitDir).length > 0)
  const heads = live.map((area, index) => {
    const folder = folders[index]
    return folder?.ok && !stopped[index] ? (folder.entry.branch ?? area.branch) : area.branch
  })
  // Who uses a branch: each live area by its HEAD (by its record when HEAD tells nothing), the areas being retired,
  // and the home by the team's target.
  const claims = [
    team.target,
    ...heads,
    ...areas.filter((area) => area.state === "retiring").map((area) => area.branch),
  ]
  const shared = (branch: string) => claims.filter((item) => item === branch).length > 1
  const exists = (branch: string) => inventory.branches.some((item) => item.name === branch)
  return live.flatMap((area, index): Seen[] => {
    const folder = folders[index]
    if (folder === undefined) return []
    if (!folder.ok)
      return [{ area, directory: area.directory, branch: area.branch, broken: folder.why, stopped: false }]
    const base = { area, directory: folder.directory }
    if (stopped[index]) {
      // The folder is fine; branch facts wait until the operation ends.
      const why = area.state === "broken" ? area.broken?.why : undefined
      const branchy = why === "shared-branch" || why === "branch-gone" ? why : null
      return [{ ...base, branch: area.branch, broken: branchy, stopped: true }]
    }
    const entry = folder.entry
    const keep = entry.detached && entry.head !== null && entry.detachedOnly.length > 0 ? { keep: entry.head } : {}
    const head = heads[index]
    if (shared(head)) return [{ ...base, ...keep, branch: area.branch, broken: "shared-branch", stopped: false }]
    if (area.deferredName === true && entry.detached && !exists(head))
      return [{ ...base, ...keep, branch: area.branch, broken: null, stopped: false, unnamed: true }]
    if (!exists(head)) return [{ ...base, ...keep, branch: area.branch, broken: "branch-gone", stopped: false }]
    return [{ ...base, ...keep, branch: head, broken: null, stopped: false }]
  })
}

/**
 * The area's worktree: at its recorded folder when the identity check passes (06 §4.3, run under the worktree ceiling,
 * so a nested area without its `.git` never resolves to the home around it), else the same git dir at another path (a
 * `git worktree move`, or a moved folder that `git worktree repair` registered). `undefined`: git listed no such folder.
 */
async function folderOf(area: OwnTeam.Area, inventory: Inventory.Result): Promise<Folder | undefined> {
  const checked = await Identity.check({ directory: area.directory, gitDir: area.gitDir })
  if (checked.ok) {
    const entry = inventory.worktrees.find((item) => Identity.same(item.path, area.directory))
    return entry === undefined ? undefined : { ok: true, directory: area.directory, entry }
  }
  const moved = inventory.worktrees.find(
    (item) =>
      item.identity?.ok === true &&
      Identity.same(item.identity.gitDir, area.gitDir) &&
      Identity.same(item.identity.toplevel, item.path),
  )
  if (moved) return { ok: true, directory: path.resolve(moved.path), entry: moved }
  return { ok: false, why: checked.broken }
}

/**
 * 3.7's deferred name-detached for an adopted area (see {@link Seen.unnamed}): `switch -c <name>` at the same commit,
 * no file changes, after the identity check (TI-14) and only while the name is still free. A name it cannot give
 * leaves the area `broken` (`branch-gone`) as before.
 */
async function name(
  services: Services.Context,
  team: OwnTeam.Team,
  seen: ReadonlyArray<Seen>,
): Promise<ReadonlyArray<Seen>> {
  return Promise.all(
    seen.map(async (item): Promise<Seen> => {
      if (!item.unnamed) return item
      const named = await nameDetached(team.commonDir, item)
      if (!named.ok) {
        services.log.warn("reconcile_name_failed", { areaID: item.area.id, message: named.message })
        return { ...item, unnamed: false, broken: "branch-gone" }
      }
      services.log.info("reconcile_named", { areaID: item.area.id, branch: item.branch })
      // The branch holds the commits now: no keep ref is needed for them.
      const { keep: _keep, ...rest } = item
      return { ...rest, unnamed: false }
    }),
  )
}

async function nameDetached(commonDir: string, item: Seen) {
  const checked = await Identity.check({ directory: item.directory, gitDir: item.area.gitDir })
  if (!checked.ok) return { ok: false as const, message: checked.message }
  if (Inventory.operations(item.area.gitDir).length > 0)
    return { ok: false as const, message: "진행 중인 Git 작업이 있어요" }
  const existing = await Refs.read(commonDir, `refs/heads/${item.branch}`)
  if (existing !== null) return { ok: false as const, message: `기록 이름이 이미 있거나 읽지 못했어요: ${item.branch}` }
  const switched = await Git.run(["switch", "-c", item.branch], { cwd: item.directory, write: true, worktree: true })
  return switched.ok ? { ok: true as const } : { ok: false as const, message: switched.message }
}

/** `refs/own/keep/<sha>` for each detached HEAD with unique commits (TI-8); a ref that exists already is no change. */
async function keep(
  services: Services.Context,
  team: OwnTeam.Team,
  seen: ReadonlyArray<Seen>,
): Promise<ReadonlyArray<Change>> {
  const wanted = seen.flatMap((item) => (item.keep === undefined ? [] : [{ areaID: item.area.id, sha: item.keep }]))
  const unique = wanted.filter((item, index) => wanted.findIndex((other) => other.sha === item.sha) === index)
  const created = await Promise.all(
    unique.map(async (item): Promise<Change[]> => {
      const ref = `refs/own/keep/${item.sha}`
      const result = await Refs.create(team.commonDir, { ref, oid: item.sha }, "own.team keep")
      if (!result.ok) {
        services.log.warn("reconcile_keep_failed", { teamID: team.id, areaID: item.areaID, message: result.message })
        return []
      }
      return result.created ? [{ kind: "kept", areaID: item.areaID, ref, sha: item.sha }] : []
    }),
  )
  return created.flat()
}

// ---------------------------------------------------------------------------------------------------------------
// Recording

interface Written {
  readonly areas: ReadonlyArray<{
    readonly before: OwnTeam.Area
    readonly after: OwnTeam.Area
    readonly rev: number | undefined
  }>
  readonly team?: OwnTeam.Team
  readonly external?: Extract<Change, { readonly kind: "external" }>
  readonly unadopted: ReadonlyArray<Unadopted>
}

/** The registry writes, in the team's write section: area records first, then `team.external` over the new folders. */
function record(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
  seen: ReadonlyArray<Seen>,
  inventory: Inventory.Result,
): Promise<Written> {
  const now = services.clock.now()
  return services.write(teamID, async () => {
    const fresh = await services.registry.areas.list(teamID)
    const updates = seen.flatMap((item) => {
      const area = fresh.find((candidate) => candidate.id === item.area.id)
      // Changed since it was observed (an op, another run): the next run observes it again.
      const bound =
        area?.directory === item.area.directory && area.branch === item.area.branch && area.gitDir === item.area.gitDir
      if (!area || !LIVE.has(area.state) || !bound) return []
      const after = settle(area, item, now)
      return JSON.stringify(encode(after)) === JSON.stringify(encode(area)) ? [] : [{ before: area, after }]
    })
    // One after another: each write raises the team's `rev` (a read-modify-write of the team record).
    const areas = await updates.reduce<Promise<Written["areas"]>>(
      async (previous, update) => [
        ...(await previous),
        { ...update, rev: await services.registry.areas.put(update.after) },
      ],
      Promise.resolve([]),
    )
    const team = await services.registry.teams.get(teamID)
    if (!team) return { areas, unadopted: [] }
    const current = fresh.map((area) => updates.find((update) => update.after.id === area.id)?.after ?? area)
    const listed = outside(team, current, inventory)
    const known = (directory: string) => team.external.find((item) => Classify.same(item.directory, directory))
    const external = listed.map((item) => ({
      directory: known(item.entry.path)?.directory ?? item.entry.path,
      why: item.why,
    }))
    const added = external.filter((item) => known(item.directory) === undefined)
    const removed = team.external.filter(
      (item) => !external.some((next) => Classify.same(next.directory, item.directory)),
    )
    const unadopted = listed.flatMap((item): Unadopted[] =>
      item.why === "left"
        ? [
            {
              kind: "unadopted",
              directory: item.entry.path,
              changes: item.entry.changes?.uncommitted ?? 0,
              ahead: item.entry.ahead ?? 0,
            },
          ]
        : [],
    )
    const same =
      added.length === 0 && removed.length === 0 && external.every((item) => known(item.directory)?.why === item.why)
    if (same) return { areas, unadopted }
    return {
      areas,
      team: await services.registry.teams.put({ ...team, external }),
      external: { kind: "external", added, removed: removed.map((item) => item.directory) },
      unadopted,
    }
  })
}

/** The area record after the observation. */
function settle(area: OwnTeam.Area, seen: Seen, now: number): OwnTeam.Area {
  const { broken, candidate, deferredName, ...rest } = area
  const followed = seen.branch !== area.branch
  const next = {
    ...rest,
    directory: seen.directory,
    branch: seen.branch,
    // The candidate was a commit of the branch the area left (8.8).
    ...(candidate === undefined || followed ? {} : { candidate }),
    // A deferred name waits while the git operation is stopped; once observed after it, it was given or not (3.7).
    ...(deferredName && seen.stopped ? { deferredName } : {}),
  }
  const why = seen.broken
  if (why === null)
    return {
      ...next,
      state: "active",
      status: area.status.kind === "broken" ? { kind: "idle", at: now, text: "" } : area.status,
    }
  const at = area.state === "broken" && broken?.why === why ? broken.at : now
  return { ...next, state: "broken", broken: { why, at }, status: { kind: "broken", at, text: BROKEN[why](area.name) } }
}

/**
 * Linked worktrees outside the team (TI-6) with their `team.external` reason: not the home, an area or one of own's own
 * folders (an area being made, `.verify`, `.assets`), which carry own's lock.
 */
function outside(team: OwnTeam.Team, areas: ReadonlyArray<OwnTeam.Area>, inventory: Inventory.Result) {
  const classes = Classify.classify(inventory.worktrees, { home: team.home.directory, patterns: team.patterns })
  return inventory.worktrees.flatMap((entry, index) => {
    const why = EXTERNAL[classes[index].class]
    if (why === undefined || entry.bare) return []
    if (entry.locked !== null && Classify.ownLock(entry.locked)) return []
    if (areas.some((area) => area.state !== "retired" && ofArea(area, entry))) return []
    return [{ entry, why }]
  })
}

function ofArea(area: OwnTeam.Area, entry: Inventory.Worktree) {
  if (Identity.same(entry.path, area.directory)) return true
  return entry.identity?.ok === true && Identity.same(entry.identity.gitDir, area.gitDir)
}

function changesOf(before: OwnTeam.Area, after: OwnTeam.Area): ReadonlyArray<Change> {
  const areaID = after.id
  const was = before.state === "broken" ? before.broken?.why : undefined
  const why = after.state === "broken" ? after.broken?.why : undefined
  return [
    ...(before.directory === after.directory
      ? []
      : [{ kind: "directory" as const, areaID, from: before.directory, to: after.directory }]),
    ...(before.branch === after.branch
      ? []
      : [{ kind: "branch" as const, areaID, from: before.branch, to: after.branch }]),
    ...(why !== undefined && why !== was ? [{ kind: "broken" as const, areaID, why }] : []),
    ...(why === undefined && before.state === "broken" ? [{ kind: "repaired" as const, areaID }] : []),
  ]
}

/** The one-shot notice of a change (8.8); `area.broken` also stays open while it lasts (see {@link run}). */
function noticeOf(
  teamID: OwnTeam.TeamID,
  change: Change,
  named: (areaID: OwnTeam.AreaID) => string,
): ReadonlyArray<Notices.Notice> {
  switch (change.kind) {
    case "directory":
      return [
        {
          teamID,
          areaID: change.areaID,
          kind: "folder.followed",
          text: `'${named(change.areaID)}' 폴더가 옮겨져 따라갔어요`,
          data: { from: change.from, directory: change.to },
        },
      ]
    case "branch":
      return [
        {
          teamID,
          areaID: change.areaID,
          kind: "branch.followed",
          text: `'${named(change.areaID)}' 영역이 다른 기록으로 바뀌어 따라갔어요`,
          data: { from: change.from, branch: change.to },
        },
      ]
    case "broken":
      return [
        {
          teamID,
          areaID: change.areaID,
          kind: "area.broken",
          text: BROKEN[change.why](named(change.areaID)),
          data: { why: change.why },
        },
      ]
    case "kept":
      return [
        {
          teamID,
          areaID: change.areaID,
          kind: "detached.kept",
          text: "이름 없는 작업 상태를 보관해 뒀어요",
          data: { ref: change.ref, sha: change.sha },
        },
      ]
    case "external": {
      const found = change.added.filter((item) => item.why === "left").length
      if (found === 0) return []
      return [
        { teamID, kind: "external.found", text: `팀 밖의 작업 폴더 ${found}개를 찾았어요`, data: { count: found } },
      ]
    }
    case "repaired":
    case "moved":
      return []
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Moving the owner after its folder

interface Stranded {
  readonly sessionID: SessionID
  /** The owner's location, a folder that is gone. */
  readonly from: string
}

/**
 * Moves the owner of a followed folder, and its attached area peers (동료) with the same move, when the area is at its
 * safe point (one call; the next run tries again).
 */
async function follow(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  previous: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadonlyArray<Change>> {
  const sessions = [
    area.owner.sessionID,
    ...(area.peers ?? []).filter((peer) => peer.attached).map((peer) => peer.sessionID),
  ].filter((sessionID) => sessionID !== null)
  const found = await Promise.all(sessions.map((sessionID) => stranded(services, team, area, sessionID, signal)))
  const left = found.filter((item) => item !== undefined)
  const waits = await Promise.all(left.map((item) => queued(services, team, item.sessionID, signal)))
  const ready = left.filter((_, index) => waits[index] === false)
  if (ready.length === 0) return []
  if (!(await idle(services, team, area, ready, signal))) return []
  const moved = await Promise.all(ready.map((item) => move(services, area, item, previous)))
  return moved.filter((change) => change !== undefined)
}

/**
 * A `move` already waits in the owner's inbox (a run right before this one queued it), or the inbox cannot be read:
 * core's move is not idempotent, so no second one is queued (the next run looks again). Read with the home as the
 * location, as {@link stranded} reads.
 */
async function queued(services: Services.Context, team: OwnTeam.Team, sessionID: SessionID, signal?: AbortSignal) {
  const inbox = await services.http.inbox.list(
    { sessionID, directory: team.home.directory },
    signal ? { signal } : undefined,
  )
  return !inbox.ok || inbox.value.some((item) => item.type === "move")
}

/**
 * The owner conversation left behind by a folder that moved: its location is not inside the area's folder and no
 * longer exists. A location that still exists was chosen on purpose (own never moves conversations by itself, 4.14).
 * Read with the home as the location, so no idle area Location is woken.
 */
async function stranded(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  sessionID: SessionID | null,
  signal?: AbortSignal,
): Promise<Stranded | undefined> {
  if (sessionID === null) return undefined
  const session = await services.http.session.get(
    { sessionID, directory: team.home.directory },
    signal ? { signal } : undefined,
  )
  if (!session.ok) return undefined
  const from = session.value.location.directory
  if (Identity.inside(area.directory, from) || fs.existsSync(from)) return undefined
  return { sessionID, from }
}

/**
 * The area is at its extended safe point (8.4: the move is one of its steps) and the conversations to move run
 * nowhere: placed by their old location, they do not count for the area's own safe point any more.
 */
async function idle(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  moving: ReadonlyArray<Stranded>,
  signal?: AbortSignal,
) {
  const active = await services.http.session.active(signal ? { signal } : undefined)
  if (!active.ok || moving.some((item) => active.value.has(item.sessionID))) return false
  const safe = await services
    .features()
    .safePoint.check({ teamID: team.id, areaID: area.id, extended: true, ...(signal ? { signal } : {}) })
  return safe.ok
}

/**
 * `session.move` through a live instance (`queue`: never into a running turn), then the {@link OwnTeam.MOVED_META}
 * mark.
 */
async function move(
  services: Services.Context,
  area: OwnTeam.Area,
  owner: Stranded,
  previous: string | undefined,
): Promise<Change | undefined> {
  const instance = services.instance(area.directory)
  if (!instance) return undefined
  const to = destination(area.directory, owner.from, previous)
  const moved = await instance.ctx.session.move({ sessionID: owner.sessionID, directory: to, delivery: "queue" }).then(
    () => true,
    (error: unknown) => {
      services.log.warn("reconcile_move_failed", { areaID: area.id, sessionID: owner.sessionID, error })
      return false
    },
  )
  if (!moved) return undefined
  const at = services.clock.now()
  const marked = await services.http.session.metadata({
    sessionID: owner.sessionID,
    directory: to,
    change: (current) => ({
      ...Option.getOrElse(decodeMetadata(current), () => ({})),
      [OwnTeam.MOVED_META]: { at, from: owner.from, to },
    }),
  })
  if (!marked.ok) services.log.warn("reconcile_move_mark_failed", { areaID: area.id, message: marked.message })
  return { kind: "moved", areaID: area.id, sessionID: owner.sessionID, from: owner.from, to }
}

/** The owner's subfolder in the moved folder when this run saw the move and it is there, else the folder itself. */
function destination(directory: string, from: string, previous: string | undefined) {
  if (previous === undefined || !Identity.inside(previous, from)) return directory
  const inner = path.join(directory, path.relative(previous, from))
  return fs.existsSync(inner) ? inner : directory
}

const MoveArgs = Schema.Struct({ areaID: OwnTeam.AreaID })
const decodeMove = Schema.decodeUnknownSync(MoveArgs)

/**
 * {@link MOVE} for ops: the owner of the area `args.areaID` follows its moved folder. An automatic step skips an area
 * that is not at its safe point (TI-9); reconcile moves it at a later safe point.
 */
function moveKind(): Steps.Kind {
  const place = async (input: Steps.Input) => {
    const areaID = decodeMove(input.step.args).areaID
    const team = await input.services.registry.teams.get(input.op.teamID)
    const area = team ? await input.services.registry.areas.get(team.id, areaID) : undefined
    return team && area ? { team, area } : undefined
  }
  return {
    kind: MOVE,
    observe: async (input) => {
      const found = await place(input)
      if (!found || found.area.state !== "active") return { state: "skip", note: "쓰는 중인 영역이 아니에요" }
      const owner = await stranded(input.services, found.team, found.area, found.area.owner.sessionID, input.signal)
      if (!owner) return { state: "satisfied" }
      return (await idle(input.services, found.team, found.area, [owner], input.signal))
        ? { state: "pending" }
        : { state: "skip", note: "영역이 아직 쉬는 중이 아니에요" }
    },
    act: async (input) => {
      const found = await place(input)
      const owner = found
        ? await stranded(input.services, found.team, found.area, found.area.owner.sessionID, input.signal)
        : undefined
      if (!found || !owner) return { ok: true }
      return (await move(input.services, found.area, owner, undefined))
        ? { ok: true }
        : { ok: false, note: "담당 대화를 옮기지 못했어요" }
    },
    verify: async (input) => {
      const found = await place(input)
      if (!found) return { ok: false, note: "영역을 찾을 수 없어요" }
      const owner = await stranded(input.services, found.team, found.area, found.area.owner.sessionID, input.signal)
      if (!owner) return { ok: true }
      // Delivered at the owner's next idle boundary (`team-session-move-inbox`).
      const inbox = await input.services.http.inbox.list({
        sessionID: owner.sessionID,
        directory: found.area.directory,
      })
      return inbox.ok && inbox.value.some((item) => item.type === "move")
        ? { ok: true }
        : { ok: false, note: "담당 대화를 옮기지 못했어요" }
    },
  }
}
