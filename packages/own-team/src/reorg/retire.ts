export * as Retire from "./retire.js"

import fs from "node:fs/promises"
import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../assets/need-paths.js"
import { Symlinks } from "../assets/symlinks.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import { Steps } from "../ops/steps.js"
import { Undo } from "../ops/undo.js"
import { Services } from "../services.js"
import { Direct } from "../dispatch/direct.js"
import { Remove } from "./remove.js"
import { Settle } from "./settle.js"
import { Journal } from "../ops/journal.js"

/**
 * 끝내기 (06 §8.2): an area leaves the team; its branch and conversations stay (TI-4, TI-5), its folder goes after a
 * confirm (8.6, `reorg/remove.ts`). One `retire` op per call, every area's steps in order:
 *
 *   retire.begin     the user's 끝내기 only: the area's safe point (8.4); it waits and says why on the card (TI-9,
 *                    `op.progress`). Nobody works in a folder that is gone, so a missing folder does not wait
 *   retire.keep      commits only a detached HEAD holds get `refs/own/keep/<HEAD>` before anything else (TI-8); an
 *                    adopted area whose name is deferred (`Area.deferredName`) has no branch yet, so its HEAD counts
 *   retire.check     the merged check: how many of its commits the target lacks (`반영하지 않은 저장 지점 n개는 기록에
 *                    남습니다`, also in the removal dialog); the branch keeps them either way
 *   retire.outbox    its waiting main requests cancelled (`admit.cancelAll`, outside the write section) and listed on the
 *                    card, and the main told in the next team update
 *   retire.archive   the owner gets the archive mark `own.archived` (never deleted, TI-5); an attached owner's preset
 *                    binding also leaves the team context, while an owner the team never attached (`owner.attached:
 *                    false`) gets only the mark (3.7)
 *   retire.mark      the area is `retired`
 *   retire-remove    the folder removal (confirm, 8.6); `auto` only for a half removal the user already confirmed, or
 *                    to record why a folder the planning scan refused stays; a missing folder (`broken` `missing`)
 *                    has none. Its args carry the planning count of save points the target lacks (`unapplied`), the
 *                    removal dialog's `남는 것` line
 *
 * Main 멈춤 skips the steps of `main` and `auto` (TI-13, `reorg.skipped`); an area that is not at its safe point is
 * skipped for them, while the user's 끝내기 waits for it (TI-9, `retire.begin`). 끝내기 on an area already retired whose
 * folder is still there plans only its removal (after a `두기`, or to finish a half removal).
 *
 * The program only shows a signal ({@link retirable}, `AreaView.retirable` in `team.get`, wired in T3.15): it never
 * retires an area by itself (8.1). The step kinds come with {@link register}; `Services.Features`, the RPC groups and
 * the tools are wired in T3.15.
 */

export const KIND = {
  begin: "retire.begin",
  keep: "retire.keep",
  check: "retire.check",
  outbox: "retire.outbox",
  archive: "retire.archive",
  mark: "retire.mark",
} as const

/** Registers the retire kinds and `retire-remove` once per controller (06 §8.5: before the runner resumes). */
export function register(services: Services.Context, options: Remove.Options = {}) {
  for (const kind of kinds()) if (!services.steps.get(kind.kind)) services.steps.register(kind)
  Remove.register(services, options)
}

// ---------------------------------------------------------------------------------------------------------------
// The signal (8.1)

/** 8.1: seven days without a change. */
export const QUIET_MS = 7 * 24 * 60 * 60 * 1000

/** What git says about an area for {@link retirable}. */
export interface Facts {
  /** Commits made on the area's branch (its reflog; the worktree's HEAD reflog while its name is deferred). */
  readonly commits: number
  /** Commits of the area the target lacks. */
  readonly unapplied: number
  /** Tracked status clean and every link copy as recorded (`Symlinks.dirtyCopies`). */
  readonly clean: boolean
  /** The newest change of the branch (reflog or commit time), in milliseconds. */
  readonly changedAt: number
  readonly now: number
}

/**
 * `끝낼 수 있음` (8.1): the area had commits of its own, all of them are in the target, it is clean and nothing changed
 * for {@link QUIET_MS} (its branch, its conversation's status, a direct user input in the owner's or a peer's
 * conversation). A signal only. An area the user set up or works in directly is a standing one and never gets it
 * (2026-11-14, AL-5); the user can still end it.
 */
export function retirable(area: OwnTeam.Area, facts: Facts) {
  if (area.state !== "active") return false
  if (area.userMade !== undefined || area.directWork !== undefined) return false
  const last = Math.max(facts.changedAt, area.status.at, Direct.touched(area))
  return facts.commits > 0 && facts.unapplied === 0 && facts.clean && facts.now - last >= QUIET_MS
}

/** The {@link Facts} of an area from git; `undefined` when git cannot tell (then the area is not retirable). */
export async function facts(input: {
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly now: number
}): Promise<Facts | undefined> {
  const team = input.team
  const area = input.area
  const listed = await Worktree.list(team.commonDir)
  const entry = listed.ok ? listed.worktrees.find((item) => Identity.same(item.path, area.directory)) : undefined
  if (entry?.head === undefined || entry.prunable !== undefined) return undefined
  const named = area.deferredName === true ? null : await Refs.read(team.commonDir, `refs/heads/${area.branch}`)
  const format = ["log", "-g", "--date=unix", "--format=%gd%x00%gs%x00%ct"]
  const [history, unapplied, status, copies] = await Promise.all([
    named
      ? Git.run([...format, `refs/heads/${area.branch}`], { cwd: team.commonDir, worktree: true })
      : Git.run([...format, "HEAD"], { cwd: area.directory, worktree: true }),
    Remove.unapplied(team, area, entry.head),
    Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: area.directory, worktree: true }),
    Symlinks.dirtyCopies(area),
  ])
  if (!history.ok || unapplied === undefined || !status.ok) return undefined
  const lines = history.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0"))
  // The newest entry (first): when the branch last moved, and the time of the commit it moved to.
  const newest = lines[0] ?? []
  const times = [Number(/@\{(\d+)\}$/.exec(newest[0] ?? "")?.[1]), Number(newest[2])].filter(Number.isFinite)
  return {
    commits: lines.filter((parts) => (parts[1] ?? "").startsWith("commit")).length,
    unapplied,
    clean: Porcelain.status(status.stdout).entries.length === 0 && copies.length === 0,
    changedAt: Math.max(0, ...times) * 1000,
    now: input.now,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Planning

type By = OwnTeam.Op["by"]

export interface Planned {
  readonly steps: ReadonlyArray<Steps.Spec & { readonly id: string }>
  /** Areas not retired now and why (`skipped`: Main 멈춤, not at the safe point, broken). */
  readonly lines: ReadonlyArray<OwnTeam.SummaryLine>
}

/**
 * The steps that retire one area (see the module comment), for {@link start} and a reorganization op. Reads git (a
 * scan of the folder decides whether its removal is asked) and, for the main and the judge, the safe point; writes
 * nothing.
 */
export async function plan(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly area: OwnTeam.Area
    readonly by: By
    /** Pointer into a proposal for a `skipped` line; the area id by default. */
    readonly item?: string
    readonly options?: Remove.Options
  },
): Promise<Services.Result<Planned>> {
  const team = input.team
  const area = input.area
  const item = input.item ?? area.id
  const skipped = (why: OwnTeam.SkipReason): Services.Result<Planned> => ({
    ok: true,
    steps: [],
    lines: [{ kind: "skipped", item, areaID: area.id, why }],
  })
  if (area.state !== "retired" && input.by !== "user" && Direct.kept(area)) return skipped("paused")
  // TI-14: a broken area's steps stop; only the user retires it (a missing folder: `찾을 수 없음 [끝내기]`, 8.8).
  if (area.state === "broken" && input.by !== "user") return skipped("broken")
  const scanned = await Remove.scan({ team, area, options: input.options })
  const count =
    scanned.kind === "gone"
      ? undefined
      : await Remove.unapplied(team, area, scanned.kind === "ready" ? scanned.entry.head : undefined)
  if (area.state === "retired") {
    if (scanned.kind === "gone")
      return Services.failure("not_found", "the area is retired", { what: "area", id: area.id })
    return { ok: true, steps: removal(area.id, scanned, count), lines: [] }
  }
  // Nobody can work in a folder that is gone; asking would fail on its missing Location. The user's 끝내기 waits for
  // the safe point in its first step instead (TI-9).
  if (scanned.kind !== "gone" && input.by !== "user") {
    const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id })
    if (!safe.ok) return skipped("busy")
  }
  const id = (phase: string) => `retire:${area.id}:${phase}`
  const args = { areaID: area.id }
  const owner = area.owner.sessionID
  return {
    ok: true,
    steps: [
      ...(scanned.kind !== "gone" && input.by === "user" ? [{ id: id("begin"), kind: KIND.begin, args }] : []),
      { id: id("keep"), kind: KIND.keep, args },
      { id: id("check"), kind: KIND.check, args },
      { id: id("outbox"), kind: KIND.outbox, args },
      ...(owner === null
        ? []
        : [
            {
              id: id("archive"),
              kind: KIND.archive,
              args: { areaID: area.id, sessionID: owner, attached: area.owner.attached },
            },
          ]),
      { id: id("mark"), kind: KIND.mark, args },
      ...removal(area.id, scanned, count),
    ],
    lines: [],
  }
}

/**
 * 끝내기 (`reorg.apply{op: "retire"}`, and the bundle of 끝난 영역 정리, 3.8) as one `retire` op: one area's refusal
 * answers the call when it is the only one; in a bundle it becomes a `skipped` line. Every confirm of the op is asked
 * together (own-web shows them in one dialog, each bound to its own list).
 */
export async function start(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaIDs: ReadonlyArray<OwnTeam.AreaID>
    readonly by: By
    readonly options?: Remove.Options
  },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const areas = await Promise.all(input.areaIDs.map((areaID) => services.registry.areas.get(team.id, areaID)))
  const unknown = input.areaIDs.find((_, index) => areas[index] === undefined)
  if (unknown !== undefined || areas.length === 0)
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: unknown ?? "" })
  // Planning scans folders; a team that runs another op answers at once (the runner checks again when it starts).
  const active = await services.journal.active(team.id)
  if (active) return busy(team.id, active)
  const planned = await Promise.all(
    areas.flatMap((area) => (area ? [plan(services, { team, area, by: input.by, options: input.options })] : [])),
  )
  const single = planned.length === 1 ? planned[0] : undefined
  if (single && !single.ok) return single
  const steps = planned.flatMap((result) => (result.ok ? result.steps : []))
  const lines = planned.flatMap((result, index): OwnTeam.SummaryLine[] => {
    if (result.ok) return [...result.lines]
    const areaID = input.areaIDs[index]
    return areaID === undefined
      ? []
      : [
          {
            kind: "skipped",
            item: areaID,
            areaID,
            why: result.error === "not_safe_point" ? "busy" : result.error === "not_found" ? "invalid" : "broken",
          },
        ]
  })
  const started = await services.runner.start({
    teamID: team.id,
    kind: "retire",
    by: input.by,
    ...(input.areaIDs.length === 1 ? { areaID: input.areaIDs[0] } : {}),
    undo: { available: false },
    steps,
    summary: { lines },
  })
  if (!started.ok) return busy(team.id, started.op)
  // TI-13: what Main 멈춤 held back is told where the area is shown.
  lines.forEach((line) => {
    if (line.kind !== "skipped" || line.why !== "paused" || line.areaID === undefined) return
    const area = areas.find((item) => item?.id === line.areaID)
    services.notices.publish({
      teamID: team.id,
      areaID: line.areaID,
      kind: "reorg.skipped",
      text: `'${area?.name ?? line.areaID}' 영역은 메인 멈춤이라 이번 정리에서 건너뛰었어요`,
    })
  })
  return { ok: true, opID: started.op.id }
}

/**
 * The removal step of a planning scan: none for a missing folder (8.8 `missing` retires without removal). `unapplied`:
 * the save points the target lacks, for the removal dialog's `남는 것` line (8.2).
 */
function removal(areaID: OwnTeam.AreaID, scanned: Remove.Scan, unapplied: number | undefined) {
  if (scanned.kind === "gone") return []
  // A refused folder stays: the `auto` step records why when it runs (the card's `touched` line, its notice).
  if (scanned.kind === "refused") return [Remove.spec(areaID, "auto")]
  if (scanned.kind === "leftover") return [Remove.spec(areaID, scanned.within ? "auto" : "confirm", unapplied)]
  return [Remove.spec(areaID, "confirm", unapplied)]
}

function busy(teamID: OwnTeam.TeamID, op: OwnTeam.Op) {
  return Services.failure("busy", "another team op is running", Journal.busy(op))
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const AreaArgs = Schema.Struct({ areaID: OwnTeam.AreaID })
const ArchiveArgs = Schema.Struct({ areaID: OwnTeam.AreaID, sessionID: SessionID, attached: Schema.Boolean })

const DONE: Steps.Outcome = { ok: true }
const GONE: Steps.Observed = { state: "skip", note: "영역이 없어 건너뛰었어요" }

const decodeMetadata = (value: unknown) =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(value), () => ({}))

async function load(input: Steps.Input, areaID: OwnTeam.AreaID) {
  const [team, area] = await Promise.all([
    input.services.registry.teams.get(input.op.teamID),
    input.services.registry.areas.get(input.op.teamID, areaID),
  ])
  return team && area ? { team, area } : undefined
}

/** The area's worktree entry (also for a folder that is gone: git still lists it, prunable). */
async function entryOf(team: OwnTeam.Team, area: OwnTeam.Area) {
  const listed = await Worktree.list(team.commonDir)
  if (!listed.ok) return { ok: false as const, message: listed.message }
  return { ok: true as const, entry: listed.worktrees.find((item) => Identity.same(item.path, area.directory)) }
}

/** Where a request about the owner goes: its folder while it is there, else the home (a gone folder has no Location). */
async function where(found: { readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }) {
  const present = await fs.lstat(found.area.directory).then(
    () => true,
    () => false,
  )
  return present ? found.area.directory : found.team.home.directory
}

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    // TI-9: the user's 끝내기 waits for the area's safe point and says why (planned for `by: user` only).
    Steps.define(KIND.begin, AreaArgs, {
      observe: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return GONE
        if (found.area.state === "retired" || (await where(found)) !== found.area.directory)
          return { state: "satisfied" }
        const name = found.area.name
        const safe = await Settle.until(
          input,
          async (report) => {
            const checked = await input.services.features().safePoint.check({
              teamID: input.op.teamID,
              areaID: args.areaID,
              signal: input.signal,
            })
            if (checked.ok || input.op.by !== "user") return checked
            report(Settle.reason(`${name}: `, checked))
            return undefined
          },
          { force: async (): Promise<Services.Safe> => ({ ok: true }) },
        )
        if (safe === undefined) return { state: "failed", note: "서비스가 닫혀 멈췄어요" }
        return safe.ok ? { state: "satisfied" } : { state: "failed", note: `'${name}' 영역에서 일하는 중이에요` }
      },
      act: async () => DONE,
      verify: async () => DONE,
    }),

    Steps.define(KIND.keep, AreaArgs, {
      observe: async (args, input) => ((await load(input, args.areaID)) ? { state: "pending" } : GONE),
      act: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return DONE
        const listed = await entryOf(found.team, found.area)
        if (!listed.ok) return { ok: false, note: listed.message }
        const held = await Remove.keep(found.team, found.area, listed.entry)
        if (!held.ok) return { ok: false, note: held.message }
        if (!held.kept) return DONE
        if (held.kept.created) {
          input.summary({ kind: "ref", ref: held.kept.ref, sha: held.kept.sha })
          input.services.notices.publish({
            teamID: found.team.id,
            areaID: found.area.id,
            kind: "detached.kept",
            text: "이름 없는 작업 상태를 보관해 뒀어요",
            data: { ref: held.kept.ref },
          })
        }
        return { ok: true, note: held.kept.ref }
      },
      verify: async () => DONE,
    }),

    Steps.define(KIND.check, AreaArgs, {
      // Observing is all it does: the count is the step's note and the removal dialog's line.
      observe: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return GONE
        const listed = await entryOf(found.team, found.area)
        const count = await Remove.unapplied(found.team, found.area, listed.ok ? listed.entry?.head : undefined)
        if (count === undefined) return { state: "satisfied", note: "반영했는지 확인하지 못했어요" }
        return {
          state: "satisfied",
          note: count === 0 ? "모두 반영했어요" : `반영하지 않은 저장 지점 ${count}개는 기록에 남아요`,
        }
      },
      act: async () => DONE,
      verify: async () => DONE,
    }),

    Steps.define(KIND.outbox, AreaArgs, {
      observe: async (args, input) => ((await load(input, args.areaID)) ? { state: "pending" } : GONE),
      act: async (args, input) => {
        const services = input.services
        const area = await services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area) return DONE
        // Outside the team's write section: the outbox serializes per area and writes through the mutex itself.
        const cancelled = await services.features().admit.cancelAll({ teamID: area.teamID, areaID: area.id })
        cancelled.forEach((item) =>
          input.summary({ kind: "cancelled", areaID: item.areaID, dispatchID: item.dispatchID }),
        )
        const count = cancelled.length
        await services.features().digest.add(area.teamID, {
          at: services.clock.now(),
          areaID: area.id,
          reason: "retired",
          text: `${area.name}: 영역을 끝냈습니다${count === 0 ? "" : ` · 기다리던 메인 요청 ${count}개를 보내지 않았습니다`}`,
          wake: false,
        })
        return DONE
      },
      verify: async () => DONE,
    }),

    Steps.define(KIND.archive, ArchiveArgs, {
      observe: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return GONE
        const read = await input.services.http.session.get(
          { sessionID: args.sessionID, directory: await where(found) },
          { signal: input.signal },
        )
        if (!read.ok)
          return read.status === 404
            ? { state: "skip", note: "대화가 없어 건너뛰었어요" }
            : { state: "failed", note: read.message }
        return read.value.metadata?.[Undo.ARCHIVED] === true ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const found = await load(input, args.areaID)
        if (!found) return DONE
        const directory = await where(found)
        // 담당 대화 바꾸기: whoever is still listed in `owner.release` is stripped while the folder is there.
        await services.features().seat.sweep({ teamID: input.op.teamID, areaID: args.areaID, inside: true })
        // An owner the team never attached is still the user's conversation: the mark is all it gets (3.7).
        if (args.attached) await leave(services, { sessionID: args.sessionID, directory })
        const written = await services.http.session.metadata(
          {
            sessionID: args.sessionID,
            directory,
            change: (current) => ({ ...decodeMetadata(current), [Undo.ARCHIVED]: true }),
          },
          { signal: input.signal },
        )
        return written.ok
          ? DONE
          : { ok: false, note: `대화 ${args.sessionID}에 보관 표시를 하지 못했어요: ${written.message}` }
      },
      verify: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return DONE
        const read = await input.services.http.session.get(
          { sessionID: args.sessionID, directory: await where(found) },
          { signal: input.signal },
        )
        return read.ok && read.value.metadata?.[Undo.ARCHIVED] === true
          ? DONE
          : { ok: false, note: `대화 ${args.sessionID}에 보관 표시가 없어요` }
      },
    }),

    Steps.define(KIND.mark, AreaArgs, {
      observe: async (args, input) => {
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area) return GONE
        if (area.state !== "retired") return { state: "pending" }
        // Marked by an act whose result was not written (a restart): its card line comes with this result.
        input.summary({ kind: "area", areaID: area.id, change: "retired" })
        return { state: "satisfied" }
      },
      act: async (args, input) => {
        const services = input.services
        await NeedPaths.update(services, input.op.teamID, args.areaID, (current) =>
          Remove.retired(current, services.clock.now()),
        )
        input.summary({ kind: "area", areaID: args.areaID, change: "retired" })
        return DONE
      },
      verify: async (args, input) =>
        (await input.services.registry.areas.get(input.op.teamID, args.areaID))?.state === "retired"
          ? DONE
          : { ok: false, note: "영역이 끝난 것으로 적히지 않았어요" },
    }),
  ]
}

/** The owner's preset binding leaves the team context (as a rotation's old owner, 6.2 step 4); a failure is logged. */
async function leave(services: Services.Context, ref: { readonly sessionID: SessionID; readonly directory: string }) {
  const where = { directory: ref.directory }
  const view = await services.accounts.presetGet({ sessionID: ref.sessionID }, where)
  const binding = view.ok ? view.value.binding : null
  if (!binding?.team) return
  const cleared = await services.accounts.presetApply(
    { sessionID: ref.sessionID, presetID: binding.presetID, team: null },
    where,
  )
  if (!cleared.ok) services.log.warn("retire_team_not_cleared", { sessionID: ref.sessionID, type: cleared.type })
}
