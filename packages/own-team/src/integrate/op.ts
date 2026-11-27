export * as IntegrateOp from "./op.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { NeedPaths } from "../assets/need-paths.js"
import { Symlinks } from "../assets/symlinks.js"
import { AssetsVerify } from "../assets/verify.js"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import { AreaCreate } from "../ops/area-create.js"
import { Steps } from "../ops/steps.js"
import { Keys } from "../registry/keys.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import { Merge } from "./merge.js"
import { Verify } from "./verify.js"
import { Journal } from "../ops/journal.js"

/**
 * Integrating an area, part 1 (06 §7.1-§7.3, steps 0-7). {@link plan} checks the start conditions and returns the
 * steps an integrate op begins with; the step kinds here run them ({@link register}; the integrate feature appends the
 * advance and post-processing steps of 7.2 steps 8-9). The facts stay in git and in the Integration record (KV
 * `ig:<teamID>:<igID>`, 06 §2.4): every step observes the record and git first and acts only when its effect is
 * missing (TI-11). Nothing here writes the target branch, the home or an area folder.
 *
 *   integrate-start   0  the Integration record (C = the candidate)   1  B, and the candidate rules of 7.1
 *   integrate-merge   2-4  already merged / ff / merge-tree + commit-tree; 7.3 conflicts; 4.10 heavy-folder check
 *   integrate-refs    5  refs/own/integrate/<ig>/{base,source,candidate} in one transaction
 *   integrate-heavy   5½ K measured for the heavy list (06 §4.4, `assets/heavy.ts`, cached per commit): `.verify`
 *                        and the asset check read the list as it will be once K is the target; the `heavy` op after
 *                        the advance writes it and lets the areas follow
 *   integrate-verify  6  the code checks in `.verify` (`verify.ts`)
 *   integrate-assets  7  the asset checks in `.assets` (`assets/verify.ts`) when K changes a heavy folder or the owner
 *                        asked for an engine run, else `skipped`
 *
 * {@link restart} runs steps 1-7 again in place when the advance step finds the target moved (7.2 step 8 "1부터 다시").
 * An integration that ends early (already merged, a conflict, a failure) is final in its record and the later steps
 * skip. A failure also fails the op; an already merged candidate and a conflict the owner sorts out (7.3) end it done.
 * Each ending adds the shared integration line (`OwnTeamText.integrationLine`) to the main's next team update; a
 * second conflict and a failed check wake the main (5.6). One integration per team: an active op, an undo that waits
 * ({@link undoWaits}) or a waiting integration answers `busy`.
 */

export const KIND = {
  start: "integrate-start",
  merge: "integrate-merge",
  refs: "integrate-refs",
  heavy: "integrate-heavy",
  verify: "integrate-verify",
  assets: "integrate-assets",
} as const

export interface PlanInput {
  readonly teamID: OwnTeam.TeamID
  readonly areaID: OwnTeam.AreaID
  /** The user's 이 영역 반영하기 (7.1): without a candidate the branch tip goes in, with its commits' subjects. */
  readonly tip?: boolean
  /**
   * C as the user was shown it (a voice plan, 06 §2.9): a different C now (the tip moved, a candidate came) is
   * `conflict{ref: the area's branch, expected, actual}` and nothing starts.
   */
  readonly source?: string
}

export interface Planned {
  readonly integrationID: OwnTeam.IntegrationID
  /** C. */
  readonly source: string
  /** When the tip stands in for a missing candidate: the subjects of the commits going in (newest first). */
  readonly subjects: ReadonlyArray<string>
  /** Steps 0-7 in order, for `Runner.start({kind: "integrate", …})`. */
  readonly steps: ReadonlyArray<Steps.Spec>
}

/** The start conditions of 7.1 and the steps 0-7; nothing is written until the op runs. */
export async function plan(services: Services.Context, input: PlanInput): Promise<Services.Result<Planned>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾지 못했습니다", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있습니다", { teamID: team.id })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", "영역을 찾지 못했습니다", { what: "area", id: input.areaID })
  if (area.state === "broken")
    return Services.failure("broken", `${area.name} 영역이 멈춰 있습니다`, {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  const busy = await busyWith(services, team.id, team.target)
  if (busy) return busy
  const clean = await startCheck(area)
  if (!clean.ok) return clean
  const source = await sourceOf(team, area, input.tip === true)
  if (!source.ok) return source
  if (input.source !== undefined && source.sha !== input.source)
    return Services.failure("conflict", `${area.name}: 보여 준 뒤 저장 지점이 바뀌었습니다`, {
      ref: area.branch,
      expected: input.source,
      actual: source.sha,
    })
  const integrationID = OwnTeam.IntegrationID.create()
  const args = { integrationID, areaID: area.id }
  return {
    ok: true,
    integrationID,
    source: source.sha,
    subjects: source.subjects,
    steps: [
      {
        kind: KIND.start,
        args: {
          ...args,
          source: source.sha,
          from: source.from,
          ...(source.subjects.length > 0 ? { subjects: [...source.subjects] } : {}),
        },
      },
      { kind: KIND.merge, args },
      { kind: KIND.refs, args },
      { kind: KIND.heavy, args },
      { kind: KIND.verify, args },
      { kind: KIND.assets, args },
    ],
  }
}

/** Registers the step kinds once per controller. */
export function register(services: Services.Context) {
  kinds()
    .filter((kind) => !services.steps.get(kind.kind))
    .forEach((kind) => services.steps.register(kind))
}

// ---------------------------------------------------------------------------------------------------------------
// Integration records (KV `ig:<teamID>:<igID>`)

/** States after which nothing of steps 1-7 runs. */
const ENDED: ReadonlySet<OwnTeam.IntegrationState> = new Set(["done", "conflict", "failed", "undone"])

const decodeRecord = Schema.decodeUnknownOption(OwnTeam.Integration)
const encodeRecord = Schema.encodeSync(OwnTeam.Integration)

export async function get(services: Services.Base, teamID: string, integrationID: string) {
  return Option.getOrUndefined(decodeRecord(await services.kv.get(Keys.integration(teamID, integrationID))))
}

/** The team's integrations, oldest first (their ids are ULIDs). */
export async function list(services: Services.Base, teamID: string) {
  return (await services.kv.scan(Keys.prefix.integrations(teamID))).flatMap((entry) =>
    Option.toArray(decodeRecord(entry.value)),
  )
}

/**
 * Read-modify-write of one record in the team's mutex, announced with `integration.changed`; `change` returns
 * `undefined` to leave it as it is. Returns the record as stored afterwards.
 */
export async function update(
  services: Services.Base,
  teamID: string,
  integrationID: string,
  change: (current: OwnTeam.Integration) => OwnTeam.Integration | undefined,
) {
  const written = await services.write(teamID, async () => {
    const current = await get(services, teamID, integrationID)
    const next = current && change(current)
    if (!next) return { record: current, changed: false }
    await services.kv.set(Keys.integration(teamID, integrationID), Keys.toJson(encodeRecord(next)))
    return { record: next, changed: true }
  })
  if (written.changed && written.record) announce(services, written.record)
  return written.record
}

function announce(services: Services.Base, record: OwnTeam.Integration) {
  services.hub.publish({
    name: "integration.changed",
    data: { teamID: record.teamID, areaID: record.areaID, integrationID: record.id, state: record.state },
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Start conditions (7.1)

/**
 * Another op of the team runs, an undo waits (7.4) or an integration waits (7.2 step 8): one integration at a time.
 * `target`: the branch the new integration would move.
 */
async function busyWith(services: Services.Context, teamID: OwnTeam.TeamID, target: string) {
  const active = await services.journal.active(teamID)
  if (active) return busy(active, "이 팀에서 다른 작업이 진행 중입니다")
  const undo = await undoWaits(services, teamID, target)
  if (undo) return undo
  const waiting = (await list(services, teamID)).find((record) => record.state === "waiting")
  if (!waiting) return undefined
  const op = (await services.journal.list(teamID)).findLast(
    (item) => item.kind === "integrate" && item.steps.some((step) => step.args.integrationID === waiting.id),
  )
  // The waiting one's `반영함` wakes the main while this area's candidate waits (controller.ts `advanced`).
  return op
    ? busy(op, "다른 반영이 기다리는 중입니다. 그 반영이 들어가면 팀 소식이 오니 그때 다시 부르세요.")
    : undefined
}

/**
 * RH-31: the user's undo of an integration into `target` that waits outside its op (`Integration.undoing`, 7.4) holds
 * the target as a waiting integration does: once its folder frees, its `reset --keep B` would also take out whatever
 * another integration moved the target to meanwhile (kept only as `refs/own/keep/<sha>`, that integration's record
 * still `done`). Before RH-20 the waiting undo op held the team's op slot, so nothing could start. Every start of a
 * step that moves the target asks this first: {@link plan} and the controller's retry and onward ops.
 */
export async function undoWaits(services: Services.Context, teamID: OwnTeam.TeamID, target: string) {
  const undoing = (await list(services, teamID)).find(
    (record) => record.state === "done" && record.undoing !== undefined && record.target === target,
  )
  if (!undoing) return undefined
  const op = (await services.journal.list(teamID)).findLast(
    (item) => item.kind === "undo" && item.steps.some((step) => step.args.integrationID === undoing.id),
  )
  return op
    ? busy(op, "반영 되돌리기가 프로젝트 본 코드 폴더를 기다리는 중입니다. 되돌린 뒤 다시 부르세요.")
    : undefined
}

function busy(op: OwnTeam.Op, text: string) {
  return Services.failure("busy", text, Journal.busy(op))
}

/**
 * The area folder is the recorded worktree (TI-14), no git operation stopped half way in it (3.2, `Inventory`), and
 * its tracked files are clean, link copies included (4.12: their index flags hide edits from `status`).
 */
async function startCheck(area: OwnTeam.Area): Promise<Services.Result> {
  const identity = await Identity.check(area)
  if (!identity.ok)
    return Services.failure("broken", `${area.name} 영역 폴더의 정보가 맞지 않습니다: ${identity.message}`, {
      areaID: area.id,
      why: identity.broken,
    })
  const stopped = Inventory.operations(identity.gitDir)
  if (stopped.length > 0)
    return Services.failure(
      "not_safe_point",
      `${area.name} 영역 폴더에서 git 작업(${stopped.join(", ")})이 진행 중입니다`,
      {
        areaID: area.id,
        why: "git",
        sessionIDs: [],
      },
    )
  const status = await Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=no"], {
    cwd: area.directory,
    worktree: true,
  })
  if (!status.ok) return Services.failure("internal_error", `영역 폴더 상태를 읽지 못했습니다: ${status.message}`, {})
  const changed = Porcelain.status(status.stdout).entries.flatMap((entry) =>
    entry.kind === "untracked" || entry.kind === "ignored" ? [] : [entry.path],
  )
  const dirty = [...changed, ...(await Symlinks.dirtyCopies(area)).map((copy) => copy.path)]
  if (dirty.length === 0) return { ok: true }
  return Services.failure(
    "dirty",
    `${area.name} 영역 폴더에 아직 저장 지점에 넣지 않은 변경이 있습니다(바뀐 파일 ${dirty.length}개: ${shown(dirty)})`,
    { directory: area.directory, count: dirty.length, paths: dirty.slice(0, 20) },
  )
}

/** C: the candidate, else (the user's menu only) the branch tip with the subjects of what it brings (7.1). */
async function sourceOf(
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  tip: boolean,
): Promise<
  Services.Result<{
    readonly sha: string
    readonly from: "candidate" | "tip"
    readonly subjects: ReadonlyArray<string>
  }>
> {
  if (area.candidate) return { ok: true, sha: area.candidate.sha, from: "candidate", subjects: [] }
  if (!tip)
    return Services.failure(
      "not_found",
      `${area.name}: 반영 준비된 저장 지점이 없습니다(담당이 team_report(kind:"ready")로 먼저 알려야 합니다. 사용자가 지금 상태로 반영하라고 하면 team_integrate{area, tip: true}로 계획을 보이세요)`,
      { what: "integration", id: area.id },
    )
  const [head, base] = await Promise.all([
    Merge.tip(team.commonDir, area.branch),
    Merge.tip(team.commonDir, team.target),
  ])
  if (!head.ok || head.sha === null)
    return Services.failure("not_found", `${area.name} 영역의 기록을 찾지 못했습니다`, { what: "area", id: area.id })
  if (!base.ok || base.sha === null)
    return Services.failure("internal_error", `${team.target} 기록을 찾지 못했습니다`, {})
  const listed = await Merge.subjects({ repo: team.commonDir, base: base.sha, head: head.sha })
  return { ok: true, sha: head.sha, from: "tip", subjects: listed.ok ? listed.subjects : [] }
}

// ---------------------------------------------------------------------------------------------------------------
// Steps 1-7 (the step kinds below and `restart` share them)

/** What one of steps 1-7 works on: the record as stored when it starts. */
interface Context {
  readonly services: Services.Context
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly record: OwnTeam.Integration
  readonly signal: AbortSignal
  /** The op step running it; absent when the advance step runs steps 1-7 again ({@link restart}). */
  readonly step?: {
    readonly op: Pick<OwnTeam.Op, "id" | "createdAt">
    /** A confirm step the user answered `do` (step 7 makes `.assets` then, 0.3). */
    readonly confirmed: boolean
    readonly summary: (line: OwnTeam.SummaryLine) => void
  }
}

/**
 * 7.2 step 8 "1부터 다시" (the advance step's `restart`): steps 1-7 again for an integration whose target moved
 * from B. The record keeps its id, C and creation time and gets the new B, K, how and checks, or the state it stops
 * in. The caller removed the old `refs/own/integrate/<ig>/*` first, so step 5 writes them again.
 */
export async function restart(
  services: Services.Context,
  input: { readonly team: OwnTeam.Team; readonly integration: OwnTeam.Integration; readonly signal: AbortSignal },
) {
  const teamID = input.team.id
  const reset = await update(services, teamID, input.integration.id, (current) => ({
    id: current.id,
    teamID: current.teamID,
    areaID: current.areaID,
    state: "running",
    target: current.target,
    source: current.source,
    verify: {},
    createdAt: current.createdAt,
  }))
  if (!reset) return
  const area = await services.registry.areas.get(teamID, input.integration.areaID)
  if (!area) {
    await update(services, teamID, reset.id, (current) => ({ ...current, state: "failed", failure: "error" }))
    return
  }
  const from = area.candidate?.sha === reset.source ? "candidate" : "tip"
  const phases: ReadonlyArray<(context: Context) => Promise<Steps.Outcome>> = [
    (context) => target(context, from),
    merge,
    mark,
    grow,
    check,
    assets,
  ]
  await phases.reduce(async (previous, phase) => {
    if (!(await previous)) return false
    const record = await get(services, teamID, reset.id)
    if (!record || ENDED.has(record.state)) return false
    return (await phase({ services, team: input.team, area, record, signal: input.signal })).ok
  }, Promise.resolve(true))
}

/** Step 1: B, and the candidate rules of 7.1 (C left the branch; the commits after it stay out). */
async function target(context: Context, from: "candidate" | "tip"): Promise<Steps.Outcome> {
  const team = context.team
  const base = await Merge.tip(team.commonDir, team.target, context.signal)
  if (!base.ok) return end(context, { state: "failed", failure: "error", detail: base.message })
  if (base.sha === null)
    return end(context, { state: "failed", failure: "error", detail: `${team.target} 기록을 찾지 못했어요` })
  const placed = await Merge.placed({
    repo: team.commonDir,
    branch: context.area.branch,
    source: context.record.source,
    signal: context.signal,
  })
  if (!placed.ok) return end(context, { state: "failed", failure: "error", detail: placed.message })
  if (placed.state === "rewritten") return rewritten(context, from)
  const sha = base.sha
  await update(context.services, team.id, context.record.id, (current) => ({
    ...current,
    base: sha,
    ...(placed.newerSkipped > 0 ? { newerSkipped: placed.newerSkipped } : {}),
  }))
  if (placed.newerSkipped === 0) return DONE
  return { ok: true, note: `그 뒤 저장 지점 ${placed.newerSkipped}개는 넣지 않았어요` }
}

/** Steps 2-4: already merged, ff, or the merge commit K; 7.3 conflicts; then the 4.10 heavy-folder check. */
async function merge(context: Context): Promise<Steps.Outcome> {
  const record = context.record
  if (record.base === undefined) return { ok: false, note: "프로젝트 본 코드의 저장 지점이 기록되지 않았어요" }
  const base = record.base
  const outcome = await Merge.compute({
    repo: context.team.commonDir,
    base,
    source: record.source,
    message: Merge.message(context.area.name, record.id),
    at: record.createdAt,
    signal: context.signal,
  })
  if (!outcome.ok) return end(context, { state: "failed", failure: "error", detail: outcome.message })
  if (outcome.how === "merged") return end(context, { state: "done", detail: "이미 합쳐져 있어요" })
  if (outcome.how === "conflict") return conflict(context, outcome.paths)
  const blocked = await heavy(context, base, outcome.candidate)
  if (blocked) return blocked
  await update(context.services, context.team.id, record.id, (current) => ({
    ...current,
    candidate: outcome.candidate,
    how: outcome.how,
  }))
  return { ok: true, note: outcome.how === "ff" ? "앞으로 감기" : `합친 결과 ${outcome.candidate.slice(0, 7)}` }
}

/** Step 5: the integrate refs in one create-only transaction. */
async function mark(context: Context): Promise<Steps.Outcome> {
  const marks = marksOf(context)
  if (!marks) return { ok: false, note: "합친 결과가 없어요" }
  const created = await Merge.mark(marks)
  if (created.ok) return DONE
  return end(context, { state: "failed", failure: "error", detail: created.message })
}

/**
 * Step 5½ (06 §4.4): K measured for the heavy list, once per commit (the result is cached in the team records folder,
 * so the checks after it and the `heavy` op after the advance read the same list). The team's list is not written
 * here. A measurement that fails never stops the integration: the checks then use the team's list.
 */
async function grow(context: Context): Promise<Steps.Outcome> {
  const candidate = context.record.candidate
  if (candidate === undefined) return { ok: false, note: "합친 결과가 없어요" }
  const grown = await context.services
    .features()
    .heavy.growth({ team: context.team, rev: candidate, signal: context.signal })
  if (!grown.ok) return { ok: true, note: `큰 파일 폴더를 재지 못했어요: ${grown.message}` }
  if (grown.added.length === 0) return { ok: true, note: "늘어난 큰 파일 폴더 없음" }
  return { ok: true, note: `늘어날 큰 파일 폴더 ${grown.added.length}개: ${shown(grown.added)}` }
}

/** The heavy list as it is once K is the target (step 5½'s measurement); the team's list when it cannot be read. */
async function heavyAt(context: Context, candidate: string) {
  const grown = await context.services
    .features()
    .heavy.growth({ team: context.team, rev: candidate, signal: context.signal })
  return grown.ok ? grown.dirs : context.team.heavy.dirs
}

/** Step 6: the code checks in `.verify`; a failed check fails the integration and wakes the main. */
async function check(context: Context): Promise<Steps.Outcome> {
  const record = context.record
  if (context.team.commands.code.length === 0) return { ok: true, note: NO_CHECKS }
  if (record.candidate === undefined) return { ok: false, note: "합친 결과가 없어요" }
  const services = context.services
  const teamID = context.team.id
  const outcome = await Verify.run({
    team: context.team,
    integrationID: record.id,
    candidate: record.candidate,
    heavy: await heavyAt(context, record.candidate),
    signal: context.signal,
    progress: async (checks) => {
      await update(services, teamID, record.id, (current) => ({ ...current, checks }))
    },
  })
  if (outcome.state === "stopped") return { ok: false, note: "검사가 멈췄어요" }
  if (outcome.state === "broken")
    return end(context, {
      state: "failed",
      failure: "broken",
      detail: `검증 폴더의 정보가 맞지 않아 멈췄어요: ${outcome.message}`,
    })
  if (outcome.state === "failed") return end(context, { state: "failed", failure: "error", detail: outcome.message })
  const verified = { ...record.verify, cone: outcome.cone }
  if (outcome.state === "cone")
    return end(context, {
      state: "failed",
      failure: "cone",
      detail: `검증 폴더에 코드가 모두 들어오지 않았어요: ${outcome.message}`,
      change: { verify: verified },
    })
  if (!outcome.code.ok)
    return end(context, {
      state: "failed",
      failure: "verify",
      detail: `코드 검사 실패(${outcome.code.failed ?? "검사"})`,
      change: { verify: { ...verified, code: outcome.code } },
    })
  await update(services, teamID, record.id, (current) => ({
    ...current,
    verify: { ...current.verify, cone: outcome.cone, code: outcome.code },
    checks: undefined,
  }))
  const seconds = Math.round(outcome.code.ms / 1000)
  return { ok: true, note: `코드 검사 통과 ${seconds}초${outcome.reused ? "(이전 결과)" : ""}` }
}

/**
 * Step 7 (4.10): the asset checks in `.assets` when K changes a file of a heavy folder or the owner reported the
 * candidate with an engine run, and the team has asset commands; otherwise `skipped`. Making the folder the first time
 * asks (0.3): a confirm step answered `do` makes it, while an auto step stops the integration (failure `assets`) with
 * nothing fetched or written. A failed check fails the integration and wakes the main, like a failed code check.
 */
async function assets(context: Context): Promise<Steps.Outcome> {
  const record = context.record
  if (record.base === undefined || record.candidate === undefined) return { ok: false, note: "합친 결과가 없어요" }
  const services = context.services
  const team = context.team
  const candidate = record.candidate
  const needed = await AssetsVerify.needed({
    team,
    area: context.area,
    source: record.source,
    base: record.base,
    candidate,
    heavy: await heavyAt(context, candidate),
    signal: context.signal,
  })
  if (!needed.ok) return end(context, { state: "failed", failure: "error", detail: needed.message })
  if (!needed.needed) {
    await update(services, team.id, record.id, (current) => ({
      ...current,
      verify: { ...current.verify, assets: "skipped" },
    }))
    return { ok: true, note: ASSETS_SKIPPED }
  }
  const outcome = await AssetsVerify.run(
    {
      team,
      integrationID: record.id,
      candidate,
      // The advance step's restart has no op of its own: its hold ref is named by the integration and K.
      hold: context.step?.op.id ?? `${record.id}-${candidate.slice(0, 12)}`,
      at: context.step?.op.createdAt ?? record.createdAt,
      confirmed: context.step?.confirmed === true,
      signal: context.signal,
      progress: async (checks) => {
        await update(services, team.id, record.id, (current) => ({ ...current, checks }))
      },
    },
    // The lease queue is the controller's (one per process and build).
    services,
  )
  if (outcome.state === "stopped") return { ok: false, note: "검사가 멈췄어요" }
  if (outcome.state === "confirm")
    return end(context, {
      state: "failed",
      failure: "assets",
      detail: `큰 파일 검사 폴더를 처음 만들려면 확인이 필요해요(${creationText(outcome)})`,
    })
  if (outcome.state === "broken")
    return end(context, {
      state: "failed",
      failure: "broken",
      detail: `큰 파일 검사 폴더의 정보가 맞지 않아 멈췄어요: ${outcome.message}`,
    })
  if (outcome.state === "failed") return end(context, { state: "failed", failure: "error", detail: outcome.message })
  kept(context, outcome)
  if (!outcome.result.ok)
    return end(context, {
      state: "failed",
      failure: "assets",
      detail: `큰 파일 검사 실패(${outcome.result.failed ?? "검사"})`,
      change: { verify: { ...record.verify, assets: outcome.result } },
    })
  await update(services, team.id, record.id, (current) => ({
    ...current,
    verify: { ...current.verify, assets: outcome.result },
    checks: undefined,
  }))
  const seconds = Math.round(outcome.result.ms / 1000)
  return { ok: true, note: `큰 파일 검사 통과 ${seconds}초${outcome.reused ? "(이전 결과)" : ""}` }
}

const ASSETS_SKIPPED = "큰 파일 검사는 건너뜀"

/** `디스크 약 2.5 GB, 내려받기 약 800 MB`. */
function creationText(creation: Pick<AssetsVerify.Creation, "disk" | "download">) {
  return `디스크 약 ${NeedPaths.size(creation.disk)}, 내려받기 약 ${NeedPaths.size(creation.download)}`
}

/**
 * The refs step 7 made before moving `.assets` go on the result card (06 §9.3); a new keep ref also gets the
 * `detached.kept` notice (TI-8 `이름 없는 작업 상태를 보관해 두었습니다`).
 */
function kept(context: Context, outcome: Extract<AssetsVerify.Outcome, { readonly state: "done" }>) {
  outcome.kept.forEach((item) => {
    context.step?.summary({ kind: "ref", ref: item.ref, sha: item.sha })
    if (!item.created) return
    context.services.notices.publish({
      teamID: context.team.id,
      kind: "detached.kept",
      text: "큰 파일 검사 폴더의 이름 없는 작업 상태를 보관해 뒀어요",
      data: { ref: item.ref },
    })
  })
  if (outcome.held)
    context.step?.summary({ kind: "ref", ref: outcome.held.ref, sha: outcome.held.sha, bytes: outcome.held.bytes })
}

/** Step 5's refs; `undefined` before steps 1-4 recorded B and K. */
function marksOf(context: Pick<Context, "team" | "record">): Merge.Marks | undefined {
  const record = context.record
  if (record.base === undefined || record.candidate === undefined) return undefined
  return {
    repo: context.team.commonDir,
    integrationID: record.id,
    base: record.base,
    source: record.source,
    candidate: record.candidate,
  }
}

const NO_CHECKS = "검사 명령이 없어요"

/**
 * Ends the integration: `failed` (with its `failure`) fails the step and the op, `conflict` and `done` end it well.
 * The main's next team update gets the integration line; a second conflict and a failed check wake it (5.6), the
 * stops the owner sorts out do not (the owner is asked instead, and its `ready` wakes the main later).
 */
async function end(
  context: Context,
  ending: {
    readonly state: "failed" | "conflict" | "done"
    readonly failure?: OwnTeam.IntegrationFailure
    readonly detail: string
    /** Wake the main (default: a failure that is not the owner's to fix wakes it). */
    readonly wake?: boolean
    readonly change?: Partial<OwnTeam.Integration>
  },
): Promise<Steps.Outcome> {
  const services = context.services
  await update(services, context.team.id, context.record.id, (current) => ({
    ...current,
    ...ending.change,
    state: ending.state,
    ...(ending.failure === undefined ? {} : { failure: ending.failure }),
    checks: undefined,
  }))
  const wake = ending.wake ?? ending.state === "failed"
  const reason: Fold.Reason = ending.state === "done" ? "integrated" : wake ? "integration-failed" : "conflict"
  const line = OwnTeamText.integrationLine({ area: context.area.name, state: ending.state, detail: ending.detail })
  // A team note is written `- <text>`: the shared integration line, which own-web counts (`OwnTeamText.countOf`).
  await services
    .features()
    .digest.add(context.team.id, Fold.entry({ at: services.clock.now(), reason, text: line.replace(/^- /, "") }))
  return ending.state === "failed" ? { ok: false, note: ending.detail } : { ok: true, note: ending.detail }
}

/** 7.3: the first conflict goes to the owner (5.1 path, waits under Main 멈춤); a repeated one wakes the main. */
async function conflict(context: Context, paths: ReadonlyArray<string>): Promise<Steps.Outcome> {
  const earlier = (await list(context.services, context.team.id))
    .filter((item) => item.areaID === context.area.id && item.id !== context.record.id)
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .at(-1)
  const change = { conflicts: [...paths] }
  if (earlier?.state === "conflict" || earlier?.failure === "conflict")
    return end(context, {
      state: "failed",
      failure: "conflict",
      detail: `겹친 변경이 다시 생겼어요: ${shown(paths)}`,
      wake: true,
      change,
    })
  const branch = context.team.target
  const sent = await request(context, {
    kind: "conflict",
    text: [
      `${branch} 줄기의 새 변경과 겹칩니다: ${shown(paths)}`,
      `이 영역에서 ${branch} 줄기를 합쳐 정리하고 커밋한 뒤 team_report(kind:"ready")로 알려 주세요.`,
    ].join("\n"),
  })
  return end(context, { state: "conflict", detail: `겹친 변경 ${paths.length}개: ${shown(paths)}${sent}`, change })
}

/** 7.1: C left the area's branch. The owner is asked to report `ready` again and the stale candidate goes. */
async function rewritten(context: Context, from: "candidate" | "tip"): Promise<Steps.Outcome> {
  const source = context.record.source
  const sent =
    from === "candidate"
      ? await request(context, {
          kind: "task",
          text: [
            `반영하려던 저장 지점(${source.slice(0, 7)})이 이 영역의 기록에 더 이상 없습니다(기록이 다시 쓰였습니다).`,
            `지금 상태를 확인해 커밋한 뒤 team_report(kind:"ready")로 다시 알려 주세요.`,
          ].join("\n"),
        })
      : ""
  if (from === "candidate") {
    const services = context.services
    await services.write(context.team.id, async () => {
      const current = await services.registry.areas.get(context.team.id, context.area.id)
      if (current?.candidate?.sha === source) await AreaCreate.save(services, { ...current, candidate: undefined })
    })
  }
  const asked = from === "candidate" ? "(담당에게 다시 알려 달라고 요청함)" : ""
  return end(context, {
    state: "failed",
    failure: "rewritten",
    detail: `반영하려던 저장 지점이 기록에 더 이상 없어요${asked}${sent}`,
    wake: false,
  })
}

/**
 * 4.10 "코드 전용 영역의 후보 점검": in a code-only area, K must not delete files of heavy folders and may change them
 * only inside the folders the area fetched. Checked before the refs and the checks, so nothing is spent on a candidate
 * that cannot go in; the owner is told what to undo.
 */
async function heavy(context: Context, base: string, candidate: string) {
  if (context.area.shape !== "code" || context.team.heavy.dirs.length === 0) return undefined
  const changes = await Merge.heavy({
    repo: context.team.commonDir,
    base,
    candidate,
    heavy: context.team.heavy.dirs,
    extra: Object.keys(context.area.cone.extra),
    signal: context.signal,
  })
  if (!changes.ok) return end(context, { state: "failed", failure: "error", detail: changes.message })
  const blocked = [...changes.deleted, ...changes.outside]
  if (blocked.length === 0) return undefined
  const sent = await request(context, {
    kind: "task",
    text: [
      `반영을 멈췄습니다. 이 영역의 변경이 받지 않은 큰 파일 폴더의 파일을 지우거나 바꿉니다: ${shown(blocked)}`,
      `그 변경을 되돌려 커밋한 뒤 team_report(kind:"ready")로 다시 알려 주세요. 큰 파일 폴더가 필요하면 먼저 team_need_paths를 부르세요.`,
    ].join("\n"),
  })
  return end(context, {
    state: "failed",
    failure: "heavy",
    detail: `큰 파일 폴더의 파일을 지우거나 바꿈: ${shown(blocked)}${sent}`,
    wake: false,
  })
}

/**
 * A `from="team"` request to the area's owner (5.1 path: it waits under Main 멈춤 or while the folder works), with the
 * integration's start as its origin (a held area lets it in only when that is inside the stretch). Answers `""`, or a
 * note for the integration line when it could not be sent.
 */
async function request(context: Context, body: { readonly kind: "conflict" | "task"; readonly text: string }) {
  const sent = await context.services.features().admit.dispatch({
    teamID: context.team.id,
    areaID: context.area.id,
    from: "team",
    kind: body.kind,
    text: body.text,
    origin: context.record.createdAt,
  })
  return sent.ok ? "" : ` · 담당에게 알리지 못함: ${sent.message}`
}

function endedNote(record: OwnTeam.Integration) {
  return `반영이 이미 끝났어요(${OwnTeamText.INTEGRATION[record.state]})`
}

/** The first five paths, then how many more. */
function shown(paths: ReadonlyArray<string>) {
  const more = paths.length > 5 ? ` 외 ${paths.length - 5}개` : ""
  return `${paths.slice(0, 5).join(", ")}${more}`
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const StartArgs = Schema.Struct({
  integrationID: OwnTeam.IntegrationID,
  areaID: OwnTeam.AreaID,
  source: OwnTeam.Sha,
  /** `tip`: the user integrates the branch tip without a candidate (7.1). */
  from: Schema.Literals(["candidate", "tip"]),
  /** With `tip`: the subjects of the commits going in, kept on the record for the card (7.1). */
  subjects: Schema.optional(Schema.Array(Schema.String)),
})

const Args = Schema.Struct({ integrationID: OwnTeam.IntegrationID, areaID: OwnTeam.AreaID })
type Args = typeof Args.Type
const decodeArgs = Schema.decodeUnknownOption(Args)

const DONE: Steps.Outcome = { ok: true }

/**
 * A step of 2-7: skipped once the integration ended, `satisfied` once `done` holds for the record, else acted on with
 * `phase` (which observes git itself where that matters).
 */
function phaseKind(
  kind: string,
  phase: (context: Context) => Promise<Steps.Outcome>,
  done: (record: OwnTeam.Integration, team: OwnTeam.Team) => Promise<boolean | Steps.Observed>,
) {
  return Steps.define(kind, Args, {
    observe: async (args, input) => {
      const context = await load(input, args)
      if (!context) return { state: "failed", note: "반영 기록이나 영역을 찾을 수 없어요" }
      if (ENDED.has(context.record.state)) return { state: "skip", note: endedNote(context.record) }
      const observed = await done(context.record, context.team)
      if (typeof observed !== "boolean") return observed
      return observed ? { state: "satisfied" } : { state: "pending" }
    },
    act: async (args, input) => {
      const context = await load(input, args)
      if (!context) return { ok: false, note: "반영 기록이나 영역을 찾을 수 없어요" }
      return phase(context)
    },
    verify: async (args, input) => {
      const context = await load(input, args)
      if (!context) return { ok: false, note: "반영 기록이나 영역을 찾을 수 없어요" }
      if (ENDED.has(context.record.state)) return DONE
      const observed = await done(context.record, context.team)
      return observed === true ? DONE : { ok: false, note: `${kind}: 기록된 것이 없어요` }
    },
  })
}

/** The steps 0-7 kinds; {@link register} adds them to a controller. */
export function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.start, StartArgs, {
      observe: async (args, input) => {
        const record = await get(input.services, input.op.teamID, args.integrationID)
        if (record && ENDED.has(record.state)) return { state: "skip", note: endedNote(record) }
        return record?.base === undefined ? { state: "pending" } : { state: "satisfied" }
      },
      act: async (args, input) => {
        const services = input.services
        const [team, area] = await Promise.all([
          services.registry.teams.get(input.op.teamID),
          services.registry.areas.get(input.op.teamID, args.areaID),
        ])
        if (!team || !area) return { ok: false, note: "팀이나 영역을 찾을 수 없어요" }
        const record = await begin(services, {
          id: args.integrationID,
          teamID: team.id,
          areaID: area.id,
          state: "running",
          target: team.target,
          source: args.source,
          ...(args.subjects === undefined ? {} : { subjects: args.subjects }),
          verify: {},
          createdAt: services.clock.now(),
        })
        return target({ services, team, area, record, signal: input.signal }, args.from)
      },
      verify: async (args, input) => {
        const record = await get(input.services, input.op.teamID, args.integrationID)
        if (record && (record.base !== undefined || ENDED.has(record.state))) return DONE
        return { ok: false, note: "프로젝트 본 코드의 저장 지점이 기록되지 않았어요" }
      },
    }),
    phaseKind(KIND.merge, merge, async (record) => {
      if (record.base === undefined)
        return { state: "failed", note: "프로젝트 본 코드의 저장 지점이 기록되지 않았어요" }
      return record.candidate !== undefined && record.how !== undefined
    }),
    phaseKind(KIND.refs, mark, async (record, team) => {
      const marks = marksOf({ team, record })
      if (!marks) return { state: "failed", note: "합친 결과가 없어요" }
      const marked = await Merge.marked(marks)
      if (marked === undefined) return { state: "failed", note: "반영 표시를 읽지 못했어요" }
      return marked
    }),
    // Measures again on resume (the cache answers at once); never fails the integration (see `grow`).
    Steps.define(KIND.heavy, Args, {
      observe: async (args, input) => {
        const context = await load(input, args)
        if (!context) return { state: "failed", note: "반영 기록이나 영역을 찾을 수 없어요" }
        if (ENDED.has(context.record.state)) return { state: "skip", note: endedNote(context.record) }
        if (context.record.candidate === undefined) return { state: "failed", note: "합친 결과가 없어요" }
        return { state: "pending" }
      },
      act: async (args, input) => {
        const context = await load(input, args)
        if (!context) return { ok: false, note: "반영 기록이나 영역을 찾을 수 없어요" }
        return grow(context)
      },
      verify: async () => DONE,
    }),
    phaseKind(KIND.verify, check, async (record, team) => {
      if (record.verify.code !== undefined) return true
      if (team.commands.code.length === 0) return { state: "skip", note: NO_CHECKS }
      if (record.candidate === undefined) return { state: "failed", note: "합친 결과가 없어요" }
      return false
    }),
    {
      ...phaseKind(KIND.assets, assets, async (record) => record.verify.assets !== undefined),
      prepare: prepareAssets,
    },
  ]
}

/**
 * The dialog of step 7 as a confirm step (making `.assets` the first time, 0.3): what the folder writes and fetches
 * at K (or C before K is known).
 */
async function prepareAssets(input: Steps.Input): Promise<Steps.Prepared> {
  const args = Option.getOrUndefined(decodeArgs(input.step.args))
  const context = args && (await load(input, args))
  const sized =
    context && (await AssetsVerify.creation(context.team, context.record.candidate ?? context.record.source))
  if (!sized?.ok) return { text: "큰 파일 검사 폴더(.assets)를 처음 만들까요?" }
  return {
    text: `큰 파일 검사 폴더(.assets)를 처음 만들까요? ${creationText(sized)}`,
    bytes: sized.disk + sized.download,
  }
}

/** The step's context: the team, the area and the integration record as stored now. */
async function load(input: Steps.Input, args: Args): Promise<Context | undefined> {
  const services = input.services
  const [team, area, record] = await Promise.all([
    services.registry.teams.get(input.op.teamID),
    services.registry.areas.get(input.op.teamID, args.areaID),
    get(services, input.op.teamID, args.integrationID),
  ])
  if (!team || !area || !record) return undefined
  return {
    services,
    team,
    area,
    record,
    signal: input.signal,
    step: { op: input.op, confirmed: input.confirmed, summary: input.summary },
  }
}

/** Step 0: writes the record unless it exists; returns the stored one. */
async function begin(services: Services.Context, record: OwnTeam.Integration) {
  const stored = await services.write(record.teamID, async () => {
    const current = await get(services, record.teamID, record.id)
    if (current) return { record: current, created: false }
    await services.kv.set(Keys.integration(record.teamID, record.id), Keys.toJson(encodeRecord(record)))
    return { record, created: true }
  })
  if (stored.created) announce(services, stored.record)
  return stored.record
}
