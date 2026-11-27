export * as Release from "./release.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Direct } from "../dispatch/direct.js"
import { Cone } from "../git/cone.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import type { Steps } from "../ops/steps.js"
import type { Services } from "../services.js"
import { NeedPaths } from "./need-paths.js"
import { Symlinks } from "./symlinks.js"

/**
 * Releasing large-file folders (06 §4.7). Entry points:
 * - {@link user}: `area.paths{release}` (the `paths-release` step), the folders the user named. A user action, so
 *   Main 멈춤 does not skip it (TI-13); away from the extended safe point the folders are kept as `busy`.
 * - {@link onDone}, {@link afterIntegrate}, {@link afterRotate}: automatic (by:auto), after a `done` report, an
 *   integration's area sync and a rotation. The folders `need_paths` fetched (`cone.extra` without `auto`) go at the
 *   area's next extended safe point, as a `paths` op of its own with a `release` step, so the outbox waits meanwhile
 *   (`maintaining`) and the op runs after any other op of the team. An area under Main 멈춤 is skipped (TI-13); one
 *   that is not at its extended safe point waits for it: the release is tried again whenever a run ends or an op of
 *   the team ends (one that ends while a try is reading the folder asks for one more try after it: what that try
 *   read may be older than the end, and no other event may follow). The wait is kept in memory only; after a
 *   restart the next trigger releases the folders (until then they cost disk only).
 * - {@link afterHeavy}: automatic too, after the heavy list grew over folders a code-only area held (06 §4.4,
 *   `assets/heavy.ts`); only those folders (`cone.extra` `grown`) go, the same way and under the same rules.
 *
 * Both need the extended safe point (8.4: nobody works in the folder, no pty either), checked before any git command
 * and again right before `sparse-checkout set`. The leaving folders are all of `sparse-checkout list` that the new
 * cone (complement of the heavy folders at HEAD + the remaining `cone.extra`) no longer covers, not only the requested
 * ones. A leaving folder goes only when `status --porcelain=v2 -z --untracked-files=all --ignored=matching -- <dir>/`
 * prints nothing (modified, staged, untracked and ignored files all show, and the sparse index is not expanded) and
 * its link copies still hash as recorded (4.12). The check runs again right before `set`; a change in between stops
 * the release. Folders that cannot go stay, without asking (the cost is disk only): `cone.kept` records why and a
 * one-shot `paths.kept` notice goes out. Ignored files are never removed by a release: they make a folder stay.
 * `set` also deletes any other collapsed folder that holds only ignored files (`Cone.endangered`, an after-tool fix
 * still waiting for its confirm): then nothing is released ({@link KEPT}). `set` only takes folders away: a folder of
 * the complement the cone does not hold yet is left to the cone drift (4.8), which weighs it first.
 *
 * Only an active area that passes the identity check is touched (TI-14): a broken one gets no git command at all.
 */

/** The step kind of the user's release. */
export const STEP = "paths-release"
/** The step kind of an automatic release. */
export const AUTO_STEP = "release"

/** Why a release did not run: `sparse-checkout set` would delete ignored files in these folders. */
export const KEPT = "받지 않은 폴더에 남은 파일이 지워질 수 있어 지금은 폴더를 내려놓지 않았어요"

/** Why a folder stayed (`cone.kept`). */
export type KeptReason =
  /** Files changed, staged, untracked or ignored inside it. */
  | "dirty"
  /** A link copy differs from what own wrote (4.12). */
  | "link-copy"
  /** Something changed between the check and the release. */
  | "changed"
  /** Someone works in the area folder (not at the extended safe point). */
  | "busy"

export type Released =
  | {
      readonly ok: true
      readonly released: ReadonlyArray<string>
      readonly kept: Readonly<Record<string, KeptReason>>
      /** An automatic release that did not run: Main 멈춤 (TI-13), or not at the extended safe point. */
      readonly skipped?: "paused" | "busy"
    }
  | {
      readonly ok: false
      /** `broken`: not an active area that passes the identity check; `kept`: {@link KEPT}; `git`: git failed. */
      readonly error: "broken" | "git" | "kept"
      readonly message: string
    }

/**
 * What started an automatic release (06 §4.7 "언제"). `heavy`: the heavy list grew over folders the area held
 * (06 §4.4); only those (`cone.extra` `grown`) go, never what `need_paths` fetched.
 */
export type Trigger = "done" | "integrate" | "rotate" | "heavy"

/** An automatic release asked for an area. */
export type Attempt =
  /** The `paths` op with the `release` step started. */
  | { readonly state: "started"; readonly opID: OwnTeam.OpID }
  /** Kept until the area is at its extended safe point (`busy`) or the team's running op ends (`op`). */
  | { readonly state: "waiting"; readonly why: "busy" | "op" }
  /** Dropped: Main 멈춤 (TI-13), the area is not an active code-only area of a team that is on, or nothing to release. */
  | { readonly state: "skipped"; readonly why: "paused" | "inactive" | "nothing" }

export interface Target {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
}

/** The user's release of `dirs` (folders of `cone.extra`) from a code-only area (06 §4.7, `area.paths{release}`). */
export function user(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly area: OwnTeam.Area
    readonly dirs: ReadonlyArray<string>
    readonly signal?: AbortSignal
  },
) {
  return run(services, { ...input, by: "user" })
}

/** 06 §4.7: after a `done` report the fetched folders go at the area's next extended safe point. */
export function onDone(services: Services.Context, target: Target) {
  return due(services, target, "done")
}

/** 06 §4.7, §7.2 step 9: after an integration's area sync (and its cone drift, 4.8). */
export function afterIntegrate(services: Services.Context, target: Target) {
  return due(services, target, "integrate")
}

/** 06 §4.7: after an owner rotation swapped the conversation. */
export function afterRotate(services: Services.Context, target: Target) {
  return due(services, target, "rotate")
}

/** 06 §4.4: the heavy list grew over folders the area held (`cone.extra` `grown`); they go once clean. */
export function afterHeavy(services: Services.Context, target: Target) {
  return due(services, target, "heavy")
}

/** The `paths-release` step of a `paths` op (a user action, so never skipped for Main 멈춤, TI-13). */
export function spec(input: { readonly areaID: OwnTeam.AreaID; readonly dirs: ReadonlyArray<string> }): Steps.Spec {
  return { kind: STEP, mode: "auto", args: { areaID: input.areaID, dirs: [...input.dirs] } }
}

/** The `release` step of an automatic release (skipped under Main 멈춤, TI-13). */
export function auto(input: { readonly areaID: OwnTeam.AreaID; readonly trigger: Trigger }): Steps.Spec {
  return { kind: AUTO_STEP, mode: "auto", args: { areaID: input.areaID, trigger: input.trigger } }
}

/** Registers the `paths-release` and `release` step kinds once per controller (see {@link NeedPaths.register}). */
export function register(services: Services.Context) {
  if (!services.steps.get(STEP)) services.steps.register(KIND)
  if (!services.steps.get(AUTO_STEP)) services.steps.register(AUTO_KIND)
}

/** The folders an automatic release takes away: what `need_paths` fetched, never what was added automatically. */
export function fetched(area: OwnTeam.Area) {
  return Object.entries(area.cone.extra)
    .filter(([, entry]) => entry.reason !== NeedPaths.AUTO)
    .map(([dir]) => dir)
}

/** The folders a trigger's release takes away: after a growth only the grown ones (06 §4.4), else {@link fetched}. */
function dirsOf(area: OwnTeam.Area, trigger: Trigger) {
  if (trigger !== "heavy") return fetched(area)
  return Object.entries(area.cone.extra)
    .filter(([, entry]) => entry.reason === NeedPaths.GROWN)
    .map(([dir]) => dir)
}

// ---------------------------------------------------------------------------------------------------------------
// The release

async function run(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly area: OwnTeam.Area
    readonly dirs: ReadonlyArray<string>
    readonly by: "user" | "auto"
    readonly signal?: AbortSignal
  },
): Promise<Released> {
  const area = input.area
  if (area.state !== "active")
    return {
      ok: false,
      error: "broken",
      message: area.state === "broken" ? "영역이 멈춰 있어요" : "영역을 끝내는 중이거나 끝냈어요",
    }
  if (input.by === "auto" && Direct.kept(area)) return { ok: true, released: [], kept: {}, skipped: "paused" }
  const requested = input.dirs.map(Cone.normalize)
  const safe = async () =>
    (
      await services
        .features()
        .safePoint.check({ teamID: input.team.id, areaID: area.id, extended: true, signal: input.signal })
    ).ok
  const busy = () =>
    input.by === "auto"
      ? { ok: true as const, released: [], kept: {}, skipped: "busy" as const }
      : keep(services, area, Object.fromEntries(requested.map((dir) => [dir, "busy" as const])))
  // Before any git command: `status` writes the refreshed index, which would race a command of someone at work.
  if (!(await safe())) return busy()
  const identity = await Identity.check(area)
  if (!identity.ok) return { ok: false, error: "broken", message: identity.message }

  const plan = await leaving(input.team, area, requested)
  if (!plan.ok) return { ok: false, error: "git", message: plan.message }
  if (plan.leaving.length === 0) return finish(services, area, requested, plan.current, {})

  const first = await dirty(area, plan.leaving)
  if (!first.ok) return { ok: false, error: "git", message: first.message }
  const going = plan.leaving.filter((dir) => !first.dirty.has(dir))
  if (going.length === 0) return keep(services, area, Object.fromEntries(first.dirty))
  // 4.7, 8.4: checked again right before `set`; anyone at work or anything new in between stops the release.
  if (!(await safe())) return busy()
  const second = await dirty(area, going)
  if (!second.ok) return { ok: false, error: "git", message: second.message }
  if (second.dirty.size > 0)
    return keep(
      services,
      area,
      Object.fromEntries([...first.dirty, ...going.map((dir) => [dir, "changed" as const] as const)]),
    )

  // The folders that stay, and the parts of the new cone inside a going folder (a heavy folder that grew inside a
  // cone folder takes only itself away). Folders of the new cone outside the current one are not added here.
  const cone = [
    ...new Set([
      ...plan.current.filter((dir) => !going.includes(dir)),
      ...plan.next.filter((dir) => going.some((gone) => Cone.covers([gone], dir))),
    ]),
  ].toSorted()
  const risky = await Cone.endangered(area.directory, cone)
  if (!risky.ok) return { ok: false, error: "git", message: risky.message }
  if (risky.dirs.length > 0) return { ok: false, error: "kept", message: `${KEPT}: ${risky.dirs.join(", ")}` }
  const set = await Cone.set({ directory: area.directory, gitDir: area.gitDir }, cone)
  if (!set.ok) return { ok: false, error: set.error === "broken" ? "broken" : "git", message: set.message }
  return finish(services, area, requested, cone, Object.fromEntries(first.dirty))
}

/** The current cone, the new one and the folders of the current one it no longer covers (4.7 "떠나는 폴더 전체를 본다"). */
async function leaving(team: OwnTeam.Team, area: OwnTeam.Area, requested: ReadonlyArray<string>) {
  const listed = await Cone.list(area.directory)
  if (!listed.ok) return listed
  const extra = Object.keys(area.cone.extra).filter((dir) => !requested.includes(Cone.normalize(dir)))
  const next = await Cone.compute(area.directory, "HEAD", team.heavy.dirs, extra)
  if (!next.ok) return next
  const current = listed.dirs.map(Cone.normalize)
  return {
    ok: true as const,
    current,
    next: next.dirs,
    leaving: current.filter((dir) => !Cone.covers(next.dirs, dir)),
  }
}

/** Leaving folders that may not go, with the reason. */
async function dirty(
  area: OwnTeam.Area,
  dirs: ReadonlyArray<string>,
): Promise<
  { readonly ok: true; readonly dirty: Map<string, KeptReason> } | { readonly ok: false; readonly message: string }
> {
  const status = await Git.run(
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--",
      ...dirs.map((dir) => `${dir}/`),
    ],
    // Not a query: the refreshed index is written, so `set` sees untouched files as clean and folds them.
    { cwd: area.directory, worktree: true, write: true, env: { GIT_LITERAL_PATHSPECS: "1" } },
  )
  if (!status.ok) return { ok: false, message: status.message }
  const paths = Porcelain.status(status.stdout).entries.map((entry) => entry.path)
  const links = (await Symlinks.dirtyCopies(area, dirs)).map((copy) => copy.path)
  const reason = (dir: string): KeptReason | undefined => {
    if (paths.some((file) => file === dir || file.startsWith(`${dir}/`))) return "dirty"
    if (links.some((file) => file.startsWith(`${dir}/`))) return "link-copy"
    return undefined
  }
  return {
    ok: true,
    dirty: new Map(
      dirs.flatMap((dir) => {
        const why = reason(dir)
        return why === undefined ? [] : [[dir, why] as const]
      }),
    ),
  }
}

/** Records the outcome: released folders leave `cone.extra` and `cone.kept`, kept ones are written with the reason. */
async function finish(
  services: Services.Context,
  area: OwnTeam.Area,
  requested: ReadonlyArray<string>,
  cone: ReadonlyArray<string>,
  kept: Readonly<Record<string, KeptReason>>,
): Promise<Released> {
  // Only folders of `cone.extra` can be released; one inside another kept folder leaves the record only.
  const released = requested.filter(
    (dir) => area.cone.extra[dir] !== undefined && kept[dir] === undefined && !Cone.covers(cone, dir),
  )
  const unchanged =
    released.length === 0 &&
    Object.keys(kept).length === 0 &&
    requested.every((dir) => area.cone.extra[dir] === undefined)
  if (!unchanged)
    await NeedPaths.update(services, area.teamID, area.id, (current) => ({
      ...current,
      cone: {
        extra: Object.fromEntries(
          Object.entries(current.cone.extra).filter(([dir]) => !requested.includes(dir) || kept[dir] !== undefined),
        ),
        kept: {
          ...Object.fromEntries(Object.entries(current.cone.kept).filter(([dir]) => !released.includes(dir))),
          ...kept,
        },
      },
    }))
  notice(services, area, kept)
  return { ok: true, released, kept }
}

/** Nothing is released: every folder of `kept` stays, with its reason. */
async function keep(
  services: Services.Context,
  area: OwnTeam.Area,
  kept: Readonly<Record<string, KeptReason>>,
): Promise<Released> {
  await NeedPaths.update(services, area.teamID, area.id, (current) => ({
    ...current,
    cone: { extra: current.cone.extra, kept: { ...current.cone.kept, ...kept } },
  }))
  notice(services, area, kept)
  return { ok: true, released: [], kept }
}

/** The one-shot `paths.kept` notice (the kept state itself stays in `cone.kept`). */
function notice(services: Services.Context, area: OwnTeam.Area, kept: Readonly<Record<string, KeptReason>>) {
  const dirs = Object.keys(kept)
  if (dirs.length === 0) return
  const busy = dirs.every((dir) => kept[dir] === "busy")
  services.notices.publish({
    teamID: area.teamID,
    areaID: area.id,
    kind: "paths.kept",
    text: busy
      ? `${area.name}: 영역 폴더에서 일하는 중이라 큰 파일 폴더 ${dirs.length}개를 그대로 뒀어요`
      : `${area.name}: 큰 파일 폴더 ${dirs.length}개에 아직 작업 중인 파일이 있어 그대로 뒀어요`,
    data: { count: dirs.length, dirs: dirs.join(", ") },
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Automatic releases waiting for their extended safe point

/** Events after which a folder may be at its safe point again (a run ended, or a queued prompt went away). */
const WAKES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.cancelled",
])

/** Automatic releases not started yet, per controller, by `teamID:areaID`. */
interface Waiting {
  readonly due: Map<string, Target & { readonly trigger: Trigger }>
  /** Areas whose attempt runs now (one at a time per area). */
  readonly running: Set<string>
  /** Areas a trigger or a wake came in for while their attempt ran. */
  readonly again: Set<string>
  /** Stops the listeners; set while any release waits. */
  stop?: () => void
}

const WAITING = new WeakMap<Services.Context, Waiting>()

/** Remembers the release and tries it now; it waits while the area is busy or the team runs another op. */
function due(services: Services.Context, target: Target, trigger: Trigger) {
  const waiting: Waiting = WAITING.get(services) ?? { due: new Map(), running: new Set(), again: new Set() }
  WAITING.set(services, waiting)
  const key = `${target.teamID}:${target.areaID}`
  // A growth's release is the narrower one: a release of every fetched folder that waits already covers it.
  const earlier = waiting.due.get(key)?.trigger
  const kept = trigger === "heavy" && earlier !== undefined ? earlier : trigger
  waiting.due.set(key, { teamID: target.teamID, areaID: target.areaID, trigger: kept })
  if (!waiting.stop) {
    const retry = () =>
      void Promise.all([...waiting.due.keys()].map((item) => attempt(services, waiting, item))).catch(
        (error: unknown) => services.log.warn("release_retry_failed", { error }),
      )
    const stopEvents = services.hub.on((event) => {
      if (WAKES.has(event.type)) retry()
    })
    const stopOps = services.hub.subscribe((event) => {
      if (event.name === "op.done") retry()
    })
    waiting.stop = () => {
      stopEvents()
      stopOps()
      waiting.stop = undefined
    }
  }
  return attempt(services, waiting, key)
}

async function attempt(services: Services.Context, waiting: Waiting, key: string): Promise<Attempt> {
  const entry = waiting.due.get(key)
  if (!entry) return { state: "skipped", why: "nothing" }
  if (waiting.running.has(key)) {
    waiting.again.add(key)
    return { state: "waiting", why: "op" }
  }
  waiting.running.add(key)
  waiting.again.delete(key)
  const result = await start(services, entry).finally(() => waiting.running.delete(key))
  // A trigger that came in meanwhile is covered by the op that just started (it reads the area when it runs).
  if (result.state !== "waiting") waiting.due.delete(key)
  if (waiting.due.size === 0) waiting.stop?.()
  // A run that ended while this attempt was reading the folder: the attempt may have seen the folder as it was
  // before that end, and nothing else may wake the release (2026-11-14: on a loaded PC the release after a rotation
  // never started, the new owner's run ended during the safe-point check that had seen its queued request).
  if (result.state === "waiting" && waiting.again.delete(key)) return attempt(services, waiting, key)
  return result
}

async function start(services: Services.Context, entry: Target & { readonly trigger: Trigger }): Promise<Attempt> {
  const [team, area] = await Promise.all([
    services.registry.teams.get(entry.teamID),
    services.registry.areas.get(entry.teamID, entry.areaID),
  ])
  if (!team || team.state !== "on" || !area || area.state !== "active" || area.shape !== "code")
    return { state: "skipped", why: "inactive" }
  if (Direct.kept(area)) return { state: "skipped", why: "paused" }
  if (dirsOf(area, entry.trigger).length === 0) return { state: "skipped", why: "nothing" }
  const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id, extended: true })
  if (!safe.ok) return { state: "waiting", why: "busy" }
  register(services)
  const started = await services.runner.start({
    teamID: team.id,
    kind: "paths",
    by: "auto",
    areaID: area.id,
    steps: [auto({ areaID: area.id, trigger: entry.trigger })],
  })
  if (!started.ok) return { state: "waiting", why: "op" }
  return { state: "started", opID: started.op.id }
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const Args = Schema.Struct({ areaID: OwnTeam.AreaID, dirs: Schema.Array(Schema.String) })
const decodeArgs = Schema.decodeUnknownOption(Args)
const AutoArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  trigger: Schema.Literals(["done", "integrate", "rotate", "heavy"]),
})
const decodeAutoArgs = Schema.decodeUnknownOption(AutoArgs)

/** `paths-release`: the user's release (a broken area fails the step without a git command). */
const KIND: Steps.Kind = {
  kind: STEP,
  observe: async (input) => {
    const found = await load(input, decodeArgs)
    if (!found.ok) return found.observed
    if (found.area.state === "broken") return { state: "failed", note: "영역이 멈춰 있어요" }
    if (found.area.shape !== "code") return { state: "satisfied", note: "내려놓을 큰 파일 폴더가 없어요" }
    return { state: "pending" }
  },
  act: async (input) => {
    const found = await load(input, decodeArgs)
    if (!found.ok) return { ok: false, note: "영역이나 팀을 찾을 수 없어요" }
    const released = await user(input.services, {
      team: found.team,
      area: found.area,
      dirs: found.args.dirs,
      signal: input.signal,
    })
    return outcome(input, found.area, released)
  },
  verify: async () => ({ ok: true }),
}

/**
 * `release`: an automatic release (by:auto). Main 멈춤 skips it (TI-13); a broken area is skipped without a git
 * command; away from the extended safe point it waits for the next one again.
 */
const AUTO_KIND: Steps.Kind = {
  kind: AUTO_STEP,
  observe: async (input) => {
    const found = await load(input, decodeAutoArgs)
    if (!found.ok) return found.observed
    if (found.area.state !== "active") return { state: "skip", note: "쓰는 중인 영역이 아니에요" }
    if (Direct.kept(found.area)) return { state: "skip", note: keptNote(found.area) }
    if (found.area.shape !== "code" || dirsOf(found.area, found.args.trigger).length === 0)
      return { state: "satisfied", note: "가져온 폴더가 없어 내려놓을 것이 없어요" }
    return { state: "pending" }
  },
  act: async (input) => {
    const found = await load(input, decodeAutoArgs)
    if (!found.ok) return { ok: true, note: "영역이나 팀을 찾을 수 없어요" }
    const released = await run(input.services, {
      team: found.team,
      area: found.area,
      dirs: dirsOf(found.area, found.args.trigger),
      by: "auto",
      signal: input.signal,
    })
    if (released.ok && released.skipped === "busy") {
      void due(input.services, { teamID: found.team.id, areaID: found.area.id }, found.args.trigger).catch(
        (error: unknown) => input.services.log.warn("release_wait_failed", { areaID: found.area.id, error }),
      )
      return { ok: true, note: "영역이 쉴 때까지 기다려요" }
    }
    if (released.ok && released.skipped === "paused") return { ok: true, note: keptNote(found.area) }
    // Ignored files git would delete keep everything as it is; the card says nothing was released.
    if (!released.ok && released.error === "kept") return { ok: true, note: released.message }
    return outcome(input, found.area, released)
  },
  verify: async () => ({ ok: true }),
}

/** A release's step outcome and its card lines. */
function outcome(input: Steps.Input, area: OwnTeam.Area, released: Released): Steps.Outcome {
  if (!released.ok) return { ok: false, note: released.message }
  const kept = Object.keys(released.kept)
  if (released.released.length > 0)
    input.summary({
      kind: "paths",
      areaID: area.id,
      change: "released",
      dirs: [...released.released],
      bytes: released.released.reduce((sum, dir) => sum + (area.cone.extra[dir]?.bytes ?? 0), 0),
    })
  if (kept.length > 0) input.summary({ kind: "paths", areaID: area.id, change: "kept", dirs: kept, bytes: 0 })
  return { ok: true, note: `내려놓은 폴더 ${released.released.length}개 · 남긴 폴더 ${kept.length}개` }
}

async function load<A extends { readonly areaID: OwnTeam.AreaID }>(
  input: Steps.Input,
  decode: (value: unknown) => Option.Option<A>,
) {
  const args = Option.getOrUndefined(decode(input.step.args))
  if (!args) return { ok: false as const, observed: { state: "failed" as const, note: "단계 정보가 맞지 않아요" } }
  const [team, area] = await Promise.all([
    input.services.registry.teams.get(input.op.teamID),
    input.services.registry.areas.get(input.op.teamID, args.areaID),
  ])
  if (!team || !area || area.state === "retired")
    return { ok: false as const, observed: { state: "skip" as const, note: "영역을 찾을 수 없어요" } }
  return { ok: true as const, args, team, area }
}

/** Why an automatic release skipped a kept area (TI-13), on the step card. */
function keptNote(area: OwnTeam.Area) {
  return area.paused === false ? "직접 작업 중이라 건너뛰었어요" : "메인 멈춤 중이라 건너뛰었어요"
}
