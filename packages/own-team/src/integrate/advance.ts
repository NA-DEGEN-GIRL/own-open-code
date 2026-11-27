export * as Advance from "./advance.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Direct } from "../dispatch/direct.js"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import type { Steps } from "../ops/steps.js"
import { Fold } from "../report/fold.js"
import type { Services } from "../services.js"
import { IntegrateOp } from "./op.js"

/**
 * Integrate part 2 (06 §7.2 steps 8–9, TI-10): moving the target branch to the verified candidate K, then the area
 * sync and the cleanup.
 *
 *   integrate-advance  T0 = the target's tip. T0 ≠ B: steps 1–7 again against the new tip (`Deps.restart`), at most
 *                      {@link MAX_RESTARTS} times, then `failed` (`moved`; any other look-again path is bounded the
 *                      same way, `error`), and every `failed` adds the integration line to the main's team update and
 *                      wakes it ("그다음 실패 보고"). The folders that hold the target come from
 *                      `Inventory.branchInUse` (git's own rule): a rebase or bisect started from it, or a stopped git
 *                      operation in the folder W that has it checked out (`Inventory.operations`), waits
 *                      (`in-progress`); a W outside the team waits (`outside`, TI-6); a home or area W is advanced only
 *                      at its safe point (`Deps.safePoint`; `in-use` while someone works there), after the identity
 *                      check (TI-14) and `HEAD == B` right before, with `merge --ff-only --no-autostash K`: local
 *                      changes that do not overlap stay, overlapping ones make it wait (`dirty`, with the paths; checked
 *                      before the merge, which in a sparse folder overwrites an untracked file; a check git cannot
 *                      answer waits as `in-use`, never as "nothing overlaps"). Only when no folder has the target:
 *                      `update-ref refs/heads/<target> K B`, a real compare-and-swap.
 *                      A checked-out branch is never moved with `update-ref` (its index would stay behind and the next
 *                      commit there would undo the integration, [R-adopt]). With `mergeLocal: "ask"` this is the
 *                      confirm step (`ops/confirm.ts`, 10-minute nonce) and it does `integrate-after` itself, because
 *                      the runner goes on with the later auto steps while a confirm waits.
 *   integrate-after    the area sync (how `merge`, skipped under Main 멈춤, TI-13): the area's HEAD still at C is moved
 *                      to K at its safe point with `merge --ff-only` when no local file overlaps (checked, with an
 *                      answer); otherwise the owner gets a `from="team"` `kind="sync"` request (5.1, it waits in
 *                      the outbox until the folder is idle). Then the `refs/own/integrate/<ig>/*` refs go (2.4), the
 *                      integration is `done`, the card gets its `integrated` line, and `Deps.onAdvanced` runs (cone
 *                      drift 4.8, release 4.7, the team update).
 *
 * A waiting integration ends its op (the team's one op slot is not held): `area.integrate`, the main's wake-up and the
 * end of the stopped git operation retry it with {@link steps} (wired by the controller). Every fact is observed again
 * on each run (TI-11): a target already at K (a restart after the move) is recorded, not moved again.
 */

export const STEP = "integrate-advance"
export const AFTER = "integrate-after"

/** 7.2 step 8: "1부터 다시(최대 3회, 그다음 실패 보고)". */
export const MAX_RESTARTS = 3

/** Why an integration waits (`Integration.waiting`, 7.2). */
export type Waiting = NonNullable<OwnTeam.Integration["waiting"]>

/** What the controller wires in (06 §2.6): the features this module calls back without importing them. */
export interface Deps {
  /**
   * 8.4 at the folder W that has the target checked out, or at the area being synced: the home's (`areaID` absent) is
   * the main idle with no pty (extended), an area's is its owner's. {@link safePoint} is the default.
   */
  readonly safePoint: (input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID?: OwnTeam.AreaID
    readonly directory: string
    readonly signal?: AbortSignal
  }) => Promise<Services.Safe>
  /**
   * 7.2 step 8 "1부터 다시": the target moved from B. Runs steps 1–7 again against its new tip and records the new
   * `base`, `candidate`, `how` and `verify` on the integration, or the state it stops in (already merged, conflict,
   * failed). The old `refs/own/integrate/<ig>/*` are removed before the call, so step 5 writes them again.
   */
  readonly restart: (input: {
    readonly team: OwnTeam.Team
    readonly integration: OwnTeam.Integration
    readonly signal: AbortSignal
  }) => Promise<void>
  /** After the target advanced and the area sync ran: cone drift (4.8), release (4.7), the team update (5.6). */
  readonly onAdvanced: (input: {
    readonly team: OwnTeam.Team
    readonly area: OwnTeam.Area | undefined
    readonly integration: OwnTeam.Integration
  }) => Promise<void>
}

/** The default {@link Deps.safePoint}: the safe-point feature (06 §8.4). */
export function safePoint(services: Services.Context): Deps["safePoint"] {
  return (input) =>
    services.features().safePoint.check({
      teamID: input.teamID,
      ...(input.areaID === undefined ? { extended: true } : { areaID: input.areaID }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
}

/**
 * The steps that move the target for an integration whose steps 0–7 ran (and for a retry of a waiting one): `ask` puts
 * the confirm on the advance, which then also does the sync (a later auto step would run before the confirm).
 */
export function steps(input: {
  readonly integrationID: OwnTeam.IntegrationID
  readonly mergeLocal: OwnTeam.Policy["mergeLocal"]
}): ReadonlyArray<Steps.Spec> {
  const args = { integrationID: input.integrationID }
  if (input.mergeLocal === "ask") return [{ id: "advance", kind: STEP, mode: "confirm", args }]
  return [
    { id: "advance", kind: STEP, mode: "auto", args },
    { id: "after", kind: AFTER, mode: "auto", args },
  ]
}

/** Registers `integrate-advance` and `integrate-after` once per controller. */
export function register(services: Services.Context, deps: Deps) {
  if (!services.steps.get(STEP)) services.steps.register(advanceKind(deps))
  if (!services.steps.get(AFTER)) services.steps.register(afterKind(deps))
}

// ---------------------------------------------------------------------------------------------------------------
// The integration record (KV `ig:<teamID>:<igID>`, 06 §2.4)

/** The integration record; {@link IntegrateOp.get} reads it. */
export const get = IntegrateOp.get

/** An integration by id alone (`integration.undo`, `integration.push.plan`), looked up in every team. */
export async function find(services: Services.Base, integrationID: string) {
  const teams = await services.registry.teams.list()
  const found = await Promise.all(teams.map((team) => get(services, team.id, integrationID)))
  return found.find((item) => item !== undefined)
}

/** Read-modify-write in the team's mutex, then `integration.changed` ({@link IntegrateOp.update}). */
export const update = IntegrateOp.update

/** The record without `waiting` (it advanced, failed or runs again). */
export function withoutWaiting(integration: OwnTeam.Integration): OwnTeam.Integration {
  const { waiting: _waiting, ...rest } = integration
  return rest
}

// ---------------------------------------------------------------------------------------------------------------
// git

/** The target's tip; `null` when the branch does not exist, `undefined` when git could not answer. */
export async function tip(directory: string, target: string, signal?: AbortSignal) {
  const result = await Git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${target}^{commit}`], {
    cwd: directory,
    worktree: true,
    signal,
  })
  if (result.ok) return result.stdout.trim()
  return result.reason === "exit" && result.code === 1 ? null : undefined
}

/** `merge-base --is-ancestor a b`; `undefined` when git could not answer. */
export async function ancestor(directory: string, a: string, b: string, signal?: AbortSignal) {
  const result = await Git.run(["merge-base", "--is-ancestor", a, b], { cwd: directory, worktree: true, signal })
  if (result.ok) return true
  return result.reason === "exit" && result.code === 1 ? false : undefined
}

/** A worktree's HEAD commit and the branch it names (`null` when detached); `undefined` when git could not answer. */
export async function head(directory: string, signal?: AbortSignal) {
  const options = { cwd: directory, worktree: true, signal }
  const [commit, symbolic] = await Promise.all([
    Git.run(["rev-parse", "--verify", "HEAD^{commit}"], options),
    Git.run(["symbolic-ref", "-q", "HEAD"], options),
  ])
  if (!commit.ok) return undefined
  return { oid: commit.stdout.trim(), branch: symbolic.ok ? symbolic.stdout.trim() : null }
}

/** `update-ref -m "own team: integrate <ig>" refs/heads/<target> K B` (TI-10: the old value makes it a real CAS). */
export function swap(input: {
  readonly directory: string
  readonly target: string
  readonly to: string
  readonly from: string
  readonly integrationID: string
  readonly signal?: AbortSignal
}) {
  return Git.run(
    [
      "update-ref",
      "-m",
      `own team: integrate ${input.integrationID}`,
      `refs/heads/${input.target}`,
      input.to,
      input.from,
    ],
    { cwd: input.directory, write: true, worktree: true, signal: input.signal },
  )
}

/** `refs/own/integrate/<ig>/{base,source,candidate}` (2.4). */
export function markers(integrationID: string) {
  return ["base", "source", "candidate"].map((name) => `refs/own/integrate/${integrationID}/${name}`)
}

/**
 * Removes the integration's markers (after the advance, when it is abandoned, before a restart), each only while it
 * holds the value just read: they are own's create-only refs, kept in KV as SHAs (2.4).
 */
export async function clearMarkers(directory: string, integrationID: string) {
  await Promise.all(
    markers(integrationID).map(async (ref) => {
      const oid = await Refs.read(directory, ref)
      if (typeof oid === "string") await Refs.removeIf(directory, { ref, oid }, "own.team integrate done")
    }),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Step 8: advance

export type Advanced =
  /** The target is at K (or past it); `observed`: it already was (a resume), nothing was moved by this call. */
  | {
      readonly state: "advanced"
      readonly how: "ff-in-worktree" | "update-ref"
      readonly directory?: string
      readonly observed: boolean
    }
  /** Recorded on the integration and announced (`integration.waiting`); retried later. */
  | { readonly state: "waiting"; readonly waiting: Waiting }
  /** A restart ended the integration (already merged, conflict, a failed check); the restart recorded it. */
  | { readonly state: "stopped"; readonly integration: OwnTeam.IntegrationState }
  | { readonly state: "failed"; readonly failure: OwnTeam.IntegrationFailure; readonly message: string }

/** Step 8 for one integration: observe, move the target or wait, and record the outcome on the integration. */
export async function run(
  services: Services.Context,
  deps: Deps,
  input: { readonly teamID: OwnTeam.TeamID; readonly integrationID: string; readonly signal: AbortSignal },
): Promise<Advanced> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return { state: "failed", failure: "error", message: "팀을 찾을 수 없어요" }
  const outcome = await attempt(services, deps, { team, ...input }, 0)
  // Stopped by the controller closing: nothing is recorded, the op resumes and observes again (TI-11).
  if (input.signal.aborted) return outcome
  await record(services, team, input.integrationID, outcome)
  return outcome
}

interface Attempt {
  readonly team: OwnTeam.Team
  readonly integrationID: string
  readonly signal: AbortSignal
}

const OPEN: ReadonlySet<OwnTeam.IntegrationState> = new Set(["running", "waiting"])

async function attempt(services: Services.Context, deps: Deps, input: Attempt, tries: number): Promise<Advanced> {
  // Every path that looks again counts against the bound, so a condition that persists while the target is still at
  // B (HEAD unreadable, W on another branch) ends the step instead of holding the team's op slot.
  if (tries > MAX_RESTARTS)
    return { state: "failed", failure: "error", message: `프로젝트 본 코드가 ${tries}번 시도하는 동안 계속 바뀌었어요` }
  const integration = await get(services, input.team.id, input.integrationID)
  if (!integration) return { state: "failed", failure: "error", message: "반영 기록을 찾을 수 없어요" }
  if (!OPEN.has(integration.state)) return { state: "stopped", integration: integration.state }
  const base = integration.base
  const candidate = integration.candidate
  if (base === undefined || candidate === undefined)
    return { state: "failed", failure: "error", message: "검사를 통과한 반영 후보가 없어요" }
  const commonDir = input.team.commonDir
  const target = integration.target
  const signal = input.signal
  const now = await tip(commonDir, target, signal)
  if (now === undefined)
    return { state: "failed", failure: "error", message: `프로젝트 본 코드(${target})를 읽지 못했어요` }
  if (now !== null && (now === candidate || (await ancestor(commonDir, candidate, now, signal)) === true))
    return observed(commonDir, target)
  if (now !== base) {
    if (tries >= MAX_RESTARTS)
      return { state: "failed", failure: "moved", message: `프로젝트 본 코드(${target})가 ${tries + 1}번 바뀌었어요` }
    await clearMarkers(commonDir, integration.id)
    await deps.restart({ team: input.team, integration, signal })
    return attempt(services, deps, input, tries + 1)
  }

  const used = await Inventory.branchInUse(commonDir, target)
  if (!used.ok) return { state: "failed", failure: "error", message: used.message }
  // A rebase or bisect that started from the target: its HEAD is detached meanwhile, so `update-ref` would succeed
  // and strand the user's rebased commits ([R-review] e4). Git's own `branch -f` refuses too.
  const held = used.users.find((use) => use.how !== "checkout")
  if (held) return wait("in-progress", held.path)
  const checkout = used.users.find((use) => use.how === "checkout")
  if (!checkout) {
    const swapped = await swap({
      directory: commonDir,
      target,
      to: candidate,
      from: base,
      integrationID: integration.id,
      signal,
    })
    if (swapped.ok) return { state: "advanced", how: "update-ref", observed: false }
    const after = await tip(commonDir, target, signal)
    // Neither moved nor taken: not a CAS failure, so another try would fail the same way.
    if (after === base) return { state: "failed", failure: "error", message: swapped.message }
    return attempt(services, deps, input, tries + 1)
  }

  if (checkout.gitDir !== null && Inventory.operations(checkout.gitDir).length > 0)
    return wait("in-progress", checkout.path)
  const member = await placeOf(services, input.team, checkout.path)
  if (!member) return wait("outside", checkout.path)
  const safe = await deps.safePoint({
    teamID: input.team.id,
    ...(member.area === undefined ? {} : { areaID: member.area.id }),
    directory: checkout.path,
    signal,
  })
  if (!safe.ok) {
    // Which check holds the folder (the safe point's `why` and its sessions): a wait that never ends names it.
    services.log.info("integrate_in_use", {
      integrationID: integration.id,
      directory: checkout.path,
      why: safe.why,
      sessionIDs: safe.sessionIDs,
    })
    return wait("in-use", checkout.path)
  }
  const gitDir = member.area?.gitDir ?? checkout.gitDir
  if (gitDir === null) return { state: "failed", failure: "broken", message: `${checkout.path}: Git 폴더가 없어요` }
  const identity = await Identity.check({ directory: checkout.path, gitDir })
  if (!identity.ok) return { state: "failed", failure: "broken", message: identity.message }
  const before = await head(checkout.path, signal)
  // Checked right before the merge: anything else means the target moved meanwhile (or W left it); look again.
  if (!before || before.oid !== base || before.branch !== `refs/heads/${target}`)
    return attempt(services, deps, input, tries + 1)
  // In a sparse folder git's fast-forward writes over an untracked file at a path K brings, with exit 0 (Git 2.55);
  // a full folder refuses. So the overlap is checked first, the same for both, and an unanswered check waits.
  const overlapping = await overlap(checkout.path, base, candidate, signal)
  if (overlapping === undefined) return wait("in-use", checkout.path)
  if (overlapping.length > 0) return wait("dirty", checkout.path, overlapping)

  const merged = await Git.run(["merge", "--ff-only", "--no-autostash", "--no-stat", candidate], {
    cwd: checkout.path,
    write: true,
    worktree: true,
    signal,
  })
  const after = await head(checkout.path, signal)
  if (after?.oid === candidate)
    return { state: "advanced", how: "ff-in-worktree", directory: checkout.path, observed: false }
  if (merged.ok || after?.oid !== base) return attempt(services, deps, input, tries + 1)
  // Git stopped before touching anything: local changes overlap K's (or an untracked file would be overwritten).
  const paths = await overlap(checkout.path, base, candidate, signal)
  return wait("dirty", checkout.path, paths)
}

/** A target already at K (or past it): recorded with the folder that holds it now, if any. */
async function observed(commonDir: string, target: string): Promise<Advanced> {
  const used = await Inventory.branchInUse(commonDir, target)
  const checkout = used.ok ? used.users.find((use) => use.how === "checkout") : undefined
  if (checkout) return { state: "advanced", how: "ff-in-worktree", directory: checkout.path, observed: true }
  return { state: "advanced", how: "update-ref", observed: true }
}

function wait(why: Waiting["why"], directory: string, paths?: ReadonlyArray<string>): Advanced {
  return { state: "waiting", waiting: { why, directory, ...(paths === undefined ? {} : { paths: [...paths] }) } }
}

/** The home (`area` undefined) or an area at `directory`; `undefined` for a folder outside the team (TI-6). */
export async function placeOf(services: Services.Base, team: OwnTeam.Team, directory: string) {
  if (Identity.same(team.home.directory, directory)) return { area: undefined }
  const areas = await services.registry.areas.list(team.id)
  const area = areas.find((item) => item.state !== "retired" && Identity.same(item.directory, directory))
  return area ? { area } : undefined
}

/**
 * Paths that differ between `from` and `to` and have local work in `directory` (modified, staged, untracked, either
 * side of a rename): what made git refuse a fast-forward or `reset --keep`. `undefined` when git could not answer
 * (a timeout, an unreadable status): never "nothing overlaps", since a sparse folder's fast-forward relies on it.
 */
export async function overlap(directory: string, from: string, to: string, signal?: AbortSignal) {
  const options = { cwd: directory, worktree: true, signal }
  const [diff, status] = await Promise.all([
    Git.run(["diff", "--name-only", "-z", "--no-renames", from, to], options),
    Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], options),
  ])
  if (!diff.ok || !status.ok) return undefined
  const changed = new Set(Porcelain.fields(diff.stdout))
  const local = Porcelain.status(status.stdout).entries.flatMap((entry) =>
    entry.kind === "renamed" ? [entry.path, entry.from] : entry.kind === "ignored" ? [] : [entry.path],
  )
  return [...new Set(local.filter((file) => changed.has(file)))].toSorted()
}

/** Writes the outcome on the integration and keeps the `integration.waiting` notice in step with it. */
async function record(services: Services.Context, team: OwnTeam.Team, integrationID: string, outcome: Advanced) {
  if (outcome.state === "stopped") {
    // The restart recorded how it ended; a notice from an earlier wait closes.
    const ended = await get(services, team.id, integrationID)
    if (ended) await announce(services, team, ended, undefined)
    return
  }
  const now = services.clock.now()
  const updated = await update(services, team.id, integrationID, (current) => {
    if (outcome.state === "waiting") return { ...current, state: "waiting", waiting: outcome.waiting }
    if (outcome.state === "failed") return { ...withoutWaiting(current), state: "failed", failure: outcome.failure }
    return {
      ...withoutWaiting(current),
      state: "running",
      advanced: current.advanced ?? {
        how: outcome.how,
        at: now,
        ...(outcome.directory === undefined ? {} : { directory: outcome.directory }),
      },
    }
  })
  if (!updated) return
  if (outcome.state === "failed") await clearMarkers(team.commonDir, integrationID)
  await announce(services, team, updated, outcome.state === "waiting" ? outcome.waiting : undefined)
  if (outcome.state === "failed") await reportFailure(services, team, updated, outcome.message)
}

/**
 * 7.2 step 8 "그다음 실패 보고": the shared integration line goes to the main's next team update and wakes it, as a
 * failure of steps 1–7 does (`IntegrateOp.end`).
 */
async function reportFailure(
  services: Services.Context,
  team: OwnTeam.Team,
  integration: OwnTeam.Integration,
  detail: string,
) {
  const area = await services.registry.areas.get(team.id, integration.areaID)
  const line = OwnTeamText.integrationLine({ area: area?.name ?? integration.areaID, state: "failed", detail })
  // A team note is written `- <text>`: the shared integration line, which own-web counts (`OwnTeamText.countOf`).
  await services.features().digest.add(
    team.id,
    Fold.entry({
      at: services.clock.now(),
      reason: "integration-failed",
      text: line.replace(/^- /, ""),
      areaID: integration.areaID,
    }),
  )
}

/** Keeps the team's open `integration.waiting` notice of this integration (`team.get` shows it after a reload). */
export async function announce(
  services: Services.Base,
  team: OwnTeam.Team,
  integration: OwnTeam.Integration,
  waiting: Waiting | undefined,
  action: "advance" | "undo" = "advance",
) {
  const others = (await services.notices.open(team.id)).filter(
    (notice) => notice.kind === "integration.waiting" && notice.id !== integration.id,
  )
  const area = await services.registry.areas.get(team.id, integration.areaID)
  const notice =
    waiting === undefined
      ? undefined
      : {
          kind: "integration.waiting" as const,
          text: waitingText(team, waiting, action),
          data: {
            folder: waiting.directory,
            why: waiting.why,
            action,
            count: waiting.paths?.length ?? 0,
            ...(area ? { area: area.name } : {}),
          },
        }
  await services.notices.keep(team.id, "integration.waiting", [
    ...others,
    ...(notice ? [{ id: integration.id, at: services.clock.now(), areaID: integration.areaID, ...notice }] : []),
  ])
  if (notice) services.notices.publish({ teamID: team.id, areaID: integration.areaID, ...notice })
}

/** 9.7 기다림, in the words own-web uses when it has none of its own. */
function waitingText(team: OwnTeam.Team, waiting: Waiting, action: "advance" | "undo") {
  const folder = Identity.same(team.home.directory, waiting.directory)
    ? `메인 폴더(${path.basename(team.home.directory)})`
    : path.basename(waiting.directory)
  const verb = action === "undo" ? "되돌려요" : "반영해요"
  if (waiting.why === "dirty")
    return action === "undo"
      ? `${folder}에서 아직 저장 지점에 넣지 않은 파일 ${waiting.paths?.length ?? 0}개와 겹쳐 되돌리기를 기다려요`
      : `${folder}에서 아직 저장 지점에 넣지 않은 파일 ${waiting.paths?.length ?? 0}개와 겹쳐요. 그 변경을 저장 지점에 넣거나 되돌린 뒤 '다시 반영'을 누르세요`
  if (waiting.why === "in-progress") return `${folder}에서 하던 기록 정리가 끝나면 ${verb}`
  if (waiting.why === "outside") return `팀 밖의 ${folder} 폴더가 프로젝트 본 코드를 쓰고 있어 기다려요`
  return `${folder}에서 하던 일이 끝나면 ${verb}`
}

// ---------------------------------------------------------------------------------------------------------------
// Step 9: after

export type Synced =
  /** The area's HEAD was C and moved to K at its safe point. */
  | "ff"
  /** The owner got a `from="team"` `kind="sync"` request. */
  | "request"
  /** Nothing to do: an ff integration, the area already has K, or it is gone. */
  | "none"
  /** Main 멈춤 (TI-13): the area is left as it is. */
  | "paused"
  /** The area failed the identity check (TI-14) or git could not read it: left for the area reconcile (8.8). */
  | "broken"

/**
 * Step 9 for an advanced integration: the area sync, the markers, `done`, the card line, then `Deps.onAdvanced`.
 * Idempotent: a resume observes the area again and finds the markers gone.
 */
export async function after(
  services: Services.Context,
  deps: Deps,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly integrationID: string
    readonly signal: AbortSignal
    readonly summary: (line: OwnTeam.SummaryLine) => void
  },
): Promise<{ readonly ok: true; readonly synced: Synced } | { readonly ok: false; readonly message: string }> {
  const [team, integration] = await Promise.all([
    services.registry.teams.get(input.teamID),
    get(services, input.teamID, input.integrationID),
  ])
  if (!team || !integration) return { ok: false, message: "팀이나 반영 기록을 찾을 수 없어요" }
  if (!integration.advanced) return { ok: false, message: "프로젝트 본 코드가 앞으로 가지 않았어요" }
  const area = await services.registry.areas.get(team.id, integration.areaID)
  const synced = await sync(services, deps, { team, area, integration, signal: input.signal })
  await clearMarkers(team.commonDir, integration.id)
  const done = await update(services, team.id, integration.id, (current) => ({
    ...withoutWaiting(current),
    state: "done",
  }))
  if (!done) return { ok: false, message: "반영 기록을 찾을 수 없어요" }
  input.summary({
    kind: "integrated",
    areaID: done.areaID,
    integrationID: done.id,
    newerSkipped: done.newerSkipped ?? 0,
  })
  await announce(services, team, done, undefined)
  // The integration is done whatever the follow-ups (release, drift, the team update) answer.
  await deps
    .onAdvanced({ team, area, integration: done })
    .catch((error: unknown) => services.log.warn("integrate_after_failed", { integrationID: done.id, error }))
  return { ok: true, synced }
}

async function sync(
  services: Services.Context,
  deps: Deps,
  input: {
    readonly team: OwnTeam.Team
    readonly area: OwnTeam.Area | undefined
    readonly integration: OwnTeam.Integration
    readonly signal: AbortSignal
  },
): Promise<Synced> {
  const area = input.area
  const integration = input.integration
  const candidate = integration.candidate
  if (integration.how !== "merge" || candidate === undefined || !area || area.state !== "active") return "none"
  if (area.paused !== false) return "paused"
  const current = await head(area.directory, input.signal)
  if (!current) return "broken"
  const has = current.oid === candidate || (await ancestor(area.directory, candidate, current.oid, input.signal))
  if (has === undefined) return "broken"
  if (has) return "none"
  const branch = current.branch === `refs/heads/${area.branch}`
  // An area the user works with directly is not moved under them: its owner gets the sync request, which waits for
  // the hand-back (`Direct.pass` lets no `sync` in).
  if (branch && current.oid === integration.source && !Direct.live(area)) {
    const safe = await deps.safePoint({
      teamID: input.team.id,
      areaID: area.id,
      directory: area.directory,
      signal: input.signal,
    })
    if (safe.ok) {
      const identity = await Identity.check({ directory: area.directory, gitDir: area.gitDir })
      if (!identity.ok) return "broken"
      // A code-only folder's fast-forward would write over an untracked file at a path K brings (see `attempt`):
      // then, or when the check gets no answer, the owner sorts it out through the request below.
      if ((await overlap(area.directory, current.oid, candidate, input.signal))?.length === 0) {
        await Git.run(["merge", "--ff-only", "--no-autostash", "--no-stat", candidate], {
          cwd: area.directory,
          write: true,
          worktree: true,
          signal: input.signal,
        })
        if ((await head(area.directory, input.signal))?.oid === candidate) return "ff"
      }
    }
  }
  const sent = await services.features().admit.dispatch({
    teamID: input.team.id,
    areaID: area.id,
    from: "team",
    kind: "sync",
    text: syncText(integration.target),
  })
  if (!sent.ok) services.log.warn("integrate_sync_request_failed", { areaID: area.id, error: sent.error })
  return "request"
}

/** The owner's sync request (7.2 step 9; the envelope names the program as the sender, 5.1). */
export function syncText(target: string) {
  return `이 영역의 작업이 ${target}에 반영됐습니다. 이 영역에서 ${target}을 합쳐(git merge ${target}) 맞춘 뒤 커밋해 주세요. 겹치는 곳이 있으면 정리해서 커밋해 주세요.`
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const Args = Schema.Struct({ integrationID: OwnTeam.IntegrationID })
const decodeArgs = Schema.decodeUnknownOption(Args)

function advanceKind(deps: Deps): Steps.Kind {
  return {
    kind: STEP,
    observe: async (input) => {
      const found = await load(input)
      if (!found.ok) return found.observed
      if (found.integration.state === "done") return { state: "satisfied" }
      // A confirm step does the sync too, so it acts until the integration is done.
      if (found.integration.advanced && input.step.mode === "auto") return { state: "satisfied" }
      if (!OPEN.has(found.integration.state))
        return { state: "skip", note: `반영이 이미 끝났어요(${OwnTeamText.INTEGRATION[found.integration.state]})` }
      return { state: "pending" }
    },
    act: async (input) => {
      const found = await load(input)
      if (!found.ok) return { ok: false, note: "반영 기록을 찾을 수 없어요" }
      const advanced = await run(input.services, deps, {
        teamID: input.op.teamID,
        integrationID: found.integrationID,
        signal: input.signal,
      })
      if (advanced.state === "failed") return { ok: false, note: advanced.message }
      if (advanced.state === "waiting") {
        const team = await input.services.registry.teams.get(input.op.teamID)
        return { ok: true, note: team ? waitingText(team, advanced.waiting, "advance") : "기다려요" }
      }
      if (advanced.state === "stopped")
        return { ok: true, note: `반영이 이미 끝났어요(${OwnTeamText.INTEGRATION[advanced.integration]})` }
      if (input.step.mode !== "confirm") return { ok: true, note: advanced.how }
      const done = await after(input.services, deps, {
        teamID: input.op.teamID,
        integrationID: found.integrationID,
        signal: input.signal,
        summary: input.summary,
      })
      return done.ok ? { ok: true, note: `${advanced.how} · 영역 ${done.synced}` } : { ok: false, note: done.message }
    },
    verify: async () => ({ ok: true }),
    prepare: async (input) => {
      const found = await load(input)
      const area = found.ok
        ? await input.services.registry.areas.get(input.op.teamID, found.integration.areaID)
        : undefined
      return { text: `'${area?.name ?? "영역"}' 작업을 프로젝트 본 코드에 반영할까요? 검사를 통과했어요` }
    },
  }
}

function afterKind(deps: Deps): Steps.Kind {
  return {
    kind: AFTER,
    observe: async (input) => {
      const found = await load(input)
      if (!found.ok) return found.observed
      if (found.integration.state === "done") return { state: "satisfied" }
      if (!found.integration.advanced) return { state: "skip", note: "프로젝트 본 코드가 앞으로 가지 않았어요" }
      return { state: "pending" }
    },
    act: async (input) => {
      const found = await load(input)
      if (!found.ok) return { ok: false, note: "반영 기록을 찾을 수 없어요" }
      const done = await after(input.services, deps, {
        teamID: input.op.teamID,
        integrationID: found.integrationID,
        signal: input.signal,
        summary: input.summary,
      })
      return done.ok ? { ok: true, note: `영역 ${done.synced}` } : { ok: false, note: done.message }
    },
    verify: async () => ({ ok: true }),
  }
}

async function load(input: Steps.Input) {
  const args = Option.getOrUndefined(decodeArgs(input.step.args))
  if (!args) return { ok: false as const, observed: { state: "failed" as const, note: "단계 정보가 맞지 않아요" } }
  const integration = await get(input.services, input.op.teamID, args.integrationID)
  if (!integration)
    return { ok: false as const, observed: { state: "skip" as const, note: "반영 기록을 찾을 수 없어요" } }
  return { ok: true as const, integrationID: args.integrationID, integration }
}
