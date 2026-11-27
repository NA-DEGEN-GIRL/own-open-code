export * as AreaMerge from "./merge.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Drift } from "../assets/drift.js"
import { Symlinks } from "../assets/symlinks.js"
import { Direct } from "../dispatch/direct.js"
import { Outbox } from "../dispatch/dispatch.js"
import { Hold } from "../dispatch/hold.js"
import { Handoff } from "../docs/handoff.js"
import { Identity } from "../git/identity.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { Wip } from "../git/wip.js"
import { Advance } from "../integrate/advance.js"
import { Merge } from "../integrate/merge.js"
import { AreaCreate } from "../ops/area-create.js"
import { Steps } from "../ops/steps.js"
import { Undo } from "../ops/undo.js"
import { Fold } from "../report/fold.js"
import { RoleInstructions } from "../sessions/instructions.js"
import { Services } from "../services.js"
import { Remove } from "./remove.js"
import { Settle } from "./settle.js"
import { AreaSplit } from "./split.js"

/**
 * 영역 묶기 A + B → A (06 §8.2): B's work goes into A's branch, B's handoff to A's owner, B's waiting main requests to
 * A's outbox; B's owner conversation is archived, B's branch stays, and B's folder goes behind a confirm. The steps,
 * each observe → act → verify (TI-11):
 *
 *   merge-begin      both areas active and at their safe point (8.4; a user's merge waits and says why, one of the main
 *                    or the judge stops with the reason when either is busy or under Main 멈춤: TI-9, TI-13). B must
 *                    be clean (tracked status + `Symlinks.dirtyCopies`, 4.12): B's owner gets the request `변경을
 *                    커밋해 주세요` as one turn of its own and the merge waits for that turn (8.7, the card says so);
 *                    clean after it, the merge goes on, still dirty, it stops with the reason. An owner that cannot take
 *                    the turn now (not attached to the team, out of its limit, under Main 멈춤) gets the request
 *                    through its outbox (5.1 path: it waits there until this op ended) and the merge stops until it
 *                    is applied again; an adopted folder without an owner conversation is planned as a `wip-commit`
 *                    confirm instead ({@link plan}, 8.7)
 *   merge-into       7.2 steps 1-5 with A's branch as the target, through `integrate/merge.ts`: C = B's tip (its HEAD
 *                    when B has no branch yet, `deferredName`, kept first in `refs/own/keep/<C>`, TI-8), A_old = A's
 *                    tip, K = C (ff) or `merge-tree` + `commit-tree` dated at the op (so a retry makes the same K), a
 *                    conflict stops the merge and sends A's owner a `from="team"` conflict request (7.3). The commits
 *                    are recorded as `refs/own/integrate/<op>-<B>/{base A_old, source C, candidate K}` (create-only;
 *                    the undo reads them, so they stay until it ran). Then A's safe point once more right before
 *                    `git -C <A> merge --ff-only K` (a resumed op skips merge-begin's wait), after the overlap check
 *                    (7.2: in a code-only folder git would overwrite an untracked file) and a hold ref of A's
 *                    uncommitted work (TI-1); a failure removes the markers again
 *   drift, link-fix  A's cone follows K (4.8, code-only A) and its link copies are applied again (4.12)
 *   merge-handoff    B's handoff document: a warm turn of B's owner (`team_handoff`), else a program handoff (6.2 step 2;
 *                    always for an adopted owner the team is not attached to: no LLM turn on its account, 3.7)
 *   merge-attach     the document as A's owner instruction entry `own.team.handoff.merged.<B slug>`
 *   outbox-migrate   B's waiting main requests to A, in order, `movedFrom: B`; none is sent (`dispatch/dispatch.ts`)
 *   merge-archive    B's owner leaves the team: binding team context cleared, `own.archived: true` (TI-5: never deleted)
 *   merge-retire     B `retired`; the card line `merged`; a team update line for the main (no wake, 5.6)
 *   retire-remove    B's folder (8.6), a confirm (V11): `reorg/remove.ts`, registered with the retire kinds
 *
 * Nothing here uses `git add -A && git commit`, `--force` or a branch deletion. Undo ({@link undo}, 8.2): only while
 * A's tip is still K, `reset --keep A_old` at A's safe point with the 7.4 `ORIG_HEAD` check (a commit made meanwhile
 * goes to `refs/own/keep/<sha>`), B registered again while its folder is there (its owner un-archived), the moved
 * requests back to B, the attached entry and the markers removed. After A moved on only 'B 다시 만들기' is left: a new
 * area from B's branch (`reorg.apply` `op:"new"` with `from: B`, which may name a finished area; own-web offers it).
 * The WIP commit's undo is `wip-undo`: the branch back to W's parent while it is still W (`Wip.revert`, CAS).
 */

export const KIND = {
  begin: "merge-begin",
  into: "merge-into",
  handoff: "merge-handoff",
  attach: "merge-attach",
  migrate: "outbox-migrate",
  archive: "merge-archive",
  retire: "merge-retire",
  wip: "wip-commit",
  wipUndo: "wip-undo",
  undo: "merge-undo",
  undoArea: "merge-undo-area",
} as const

/** The WIP commit's undo step (8.7) of the `wip-commit` op `origin` for area B. */
export function wipUndo(op: OwnTeam.Op): ReadonlyArray<Steps.Spec> {
  return op.steps.flatMap((step) =>
    step.kind === KIND.wip && step.state === "done"
      ? Option.toArray(decodePair(step.args)).map((pair) => ({
          kind: KIND.wipUndo,
          args: { areaID: pair.from, origin: op.id },
        }))
      : [],
  )
}

/** The team request a dirty B's owner gets; also how a retry finds the one this op sent. */
export const COMMIT_TASK = "영역 묶기 전에 저장 지점 만들기"

/** The instruction entry on A's owner that holds B's handoff. */
export function entryKey(from: OwnTeam.AreaID) {
  return `${RoleInstructions.HANDOFF}.merged.${from.slice("ar_".length)}`
}

/** The id of one merge's markers, `refs/own/integrate/<id>/{base,source,candidate}` (06 §2.4). */
export function markerID(opID: string, from: OwnTeam.AreaID) {
  return `${opID}-${from.slice("ar_".length)}`
}

export type Planned = {
  readonly areaID: OwnTeam.AreaID
  readonly steps: ReadonlyArray<Steps.Spec>
  readonly wip: boolean
}

/**
 * The steps of merging `from` (B) into `into` (A); the op's `by` decides TI-9 and TI-13 when it starts.
 * `wip: true`: B is an adopted folder without an owner conversation and has uncommitted work, so the op only asks to
 * put that work on B's branch (`wip-commit`, 8.7); the merge is applied again after it. Work a WIP commit cannot take
 * (a changed link copy, a folder without a branch yet) answers `dirty`.
 */
export async function plan(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly into: OwnTeam.AreaID
    readonly from: OwnTeam.AreaID
  },
): Promise<Services.Result<Planned>> {
  if (input.into === input.from)
    return Services.failure("invalid_proposal", "an area cannot be merged into itself", {
      rejected: [{ item: input.from, why: "같은 영역끼리는 묶을 수 없어요" }],
    })
  const [into, from] = await Promise.all([
    services.registry.areas.get(input.team.id, input.into),
    services.registry.areas.get(input.team.id, input.from),
  ])
  const unusable = usable(into, input.into) ?? usable(from, input.from)
  if (unusable) return unusable
  if (!into || !from) return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.into })
  if (into.deferredName)
    return Services.failure("invalid_proposal", "the area has no branch yet", {
      rejected: [{ item: into.id, why: "아직 기록 이름이 없는 영역에는 묶을 수 없어요" }],
    })
  const [listed, copies] = await Promise.all([Hold.changes(from.directory), Symlinks.dirtyCopies(from)])
  if (!listed.ok) return Services.failure("internal_error", listed.message, {})
  // Without an owner conversation nobody can be asked to commit: a WIP commit after the user's confirm, which takes
  // neither a changed link copy (4.12) nor work in a folder without a branch.
  if (from.owner.sessionID === null && (listed.paths.length > 0 || copies.length > 0)) {
    const paths = [...listed.paths, ...copies.map((copy) => copy.path)]
    if (from.deferredName || copies.length > 0)
      return Services.failure("dirty", "uncommitted work a WIP commit cannot take", {
        directory: from.directory,
        count: paths.length,
        paths: paths.slice(0, 20),
      })
    return {
      ok: true,
      areaID: from.id,
      wip: true,
      steps: [{ kind: KIND.wip, mode: "confirm", args: { into: into.id, from: from.id } }],
    }
  }
  const pair = { into: into.id, from: from.id }
  return {
    ok: true,
    areaID: into.id,
    wip: false,
    steps: [
      { kind: KIND.begin, args: pair },
      { kind: KIND.into, args: pair },
      ...(into.shape === "code" ? [Drift.spec({ areaID: into.id })] : []),
      ...(Symlinks.flag(into.shape, input.team.env.symlinkFix) === undefined
        ? []
        : [Symlinks.spec({ areaID: into.id })]),
      { kind: KIND.handoff, args: { areaID: from.id, into: into.id } },
      { kind: KIND.attach, args: { areaID: into.id, from: from.id } },
      { kind: KIND.migrate, args: { areaID: from.id, to: into.id } },
      { kind: KIND.archive, args: { areaID: from.id } },
      { kind: KIND.retire, args: { areaID: from.id, into: into.id } },
      Remove.spec(from.id),
    ],
  }
}

/** Registers the merge step kinds (`outbox-migrate` among them) once per controller. */
export function register(services: Services.Context) {
  kinds()
    .filter((kind) => !services.steps.get(kind.kind))
    .forEach((kind) => services.steps.register(kind))
}

/**
 * The undo of every merge of `op` (8.2 묶기 되돌리기), last first; only while A's tip is still K. A tip that moved on
 * answers `conflict`: then only 'B 다시 만들기' is left, which own-web offers on the merge's card as a new area from
 * B's branch (`reorg.apply` `op:"new"`, `from: B`, 8.2).
 */
export async function undo(
  services: Services.Context,
  op: OwnTeam.Op,
): Promise<Services.Result<{ readonly steps: ReadonlyArray<Steps.Spec> }>> {
  const team = await services.registry.teams.get(op.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: op.teamID })
  const merges = op.steps.flatMap((step) =>
    step.kind === KIND.into && step.state === "done" ? Option.toArray(decodePair(step.args)) : [],
  )
  if (merges.length === 0) return Services.unsupported("merge undo")
  const found = await Promise.all(
    merges.map(async (pair) => {
      const into = await services.registry.areas.get(team.id, pair.into)
      const [marked, tip] = await Promise.all([
        marks(team.commonDir, markerID(op.id, pair.from)),
        into ? Refs.read(team.commonDir, `refs/heads/${into.branch}`) : Promise.resolve(undefined),
      ])
      return { pair, into, marked, tip }
    }),
  )
  const stopped = found.find((item) => !item.into || item.marked === undefined || item.tip === undefined)
  if (stopped) return Services.failure("internal_error", `cannot read the merge of ${stopped.pair.from}`, {})
  if (found.some((item) => item.marked === null)) return Services.unsupported("merge undo")
  const moved = found.find((item) => item.marked && item.tip !== item.marked.candidate)
  if (moved?.marked && moved.into)
    return Services.failure("conflict", `'${moved.into.name}' moved on after the merge: only 'B 다시 만들기' is left`, {
      ref: `refs/heads/${moved.into.branch}`,
      expected: moved.marked.candidate,
      actual: moved.tip ?? null,
    })
  return {
    ok: true,
    steps: merges.toReversed().flatMap((pair) => [
      { kind: KIND.undo, args: { ...pair, origin: op.id } },
      { kind: KIND.undoArea, args: { ...pair, origin: op.id } },
      { kind: KIND.migrate, args: { areaID: pair.into, to: pair.from, movedFrom: pair.from } },
    ]),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Facts

interface Marks {
  /** A_old. */
  readonly base: string
  /** C. */
  readonly source: string
  /** K. */
  readonly candidate: string
}

/** A merge's recorded commits; `null` when there are none, `undefined` when git could not answer. */
async function marks(repo: string, id: string): Promise<Marks | null | undefined> {
  const names = Merge.refs(id)
  const [base, source, candidate] = await Promise.all([
    Refs.read(repo, names.base),
    Refs.read(repo, names.source),
    Refs.read(repo, names.candidate),
  ])
  if (base === undefined || source === undefined || candidate === undefined) return undefined
  // One transaction makes all three; a partial set is the rest of an interrupted removal.
  if (base === null || source === null || candidate === null) return null
  return { base, source, candidate }
}

/** Uncommitted work of an area folder: tracked status and changed link copies (the one clean check, 4.12). */
async function changes(area: OwnTeam.Area, signal?: AbortSignal) {
  const [listed, copies] = await Promise.all([Hold.changes(area.directory, signal), Symlinks.dirtyCopies(area)])
  if (!listed.ok) return listed
  return { ok: true as const, paths: [...new Set([...listed.paths, ...copies.map((copy) => copy.path)])] }
}

function usable(area: OwnTeam.Area | undefined, id: OwnTeam.AreaID): Services.Failure | undefined {
  if (area?.state === "broken")
    return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  if (!area || area.state !== "active")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id })
  return undefined
}

/** A's branch has K: at it, or K is an ancestor of its tip. `undefined` when git could not answer. */
async function holds(repo: string, area: OwnTeam.Area, candidate: string) {
  const tip = await Refs.read(repo, `refs/heads/${area.branch}`)
  if (tip === undefined) return undefined
  if (tip === null) return false
  return tip === candidate || (await Advance.ancestor(repo, candidate, tip))
}

/** The first five paths, then how many more. */
function shown(paths: ReadonlyArray<string>) {
  const more = paths.length > 5 ? ` 외 ${paths.length - 5}개` : ""
  return `${paths.slice(0, 5).join(", ")}${more}`
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const PairArgs = Schema.Struct({ into: OwnTeam.AreaID, from: OwnTeam.AreaID })
const decodePair = Schema.decodeUnknownOption(PairArgs)
const UndoArgs = Schema.Struct({ ...PairArgs.fields, origin: OwnTeam.OpID })
const IntoArgs = Schema.Struct({ areaID: OwnTeam.AreaID, into: OwnTeam.AreaID })
const AttachArgs = Schema.Struct({ areaID: OwnTeam.AreaID, from: OwnTeam.AreaID })
const AreaArgs = Schema.Struct({ areaID: OwnTeam.AreaID })
const WipUndoArgs = Schema.Struct({ areaID: OwnTeam.AreaID, origin: OwnTeam.OpID })
const MigrateArgs = Schema.Struct({
  /** The area whose waiting requests go. */
  areaID: OwnTeam.AreaID,
  /** Where they go. */
  to: OwnTeam.AreaID,
  /** Only the requests that came from this area (the undo of a merge moves those back). */
  movedFrom: optional(OwnTeam.AreaID),
})

const DONE: Steps.Outcome = { ok: true }
const GONE = "묶는 동안 영역이 바뀌었어요"
const STOPPED = "서비스가 닫혀 멈췄어요"

async function teamOf(input: Steps.Input) {
  const team = await input.services.registry.teams.get(input.op.teamID)
  if (!team) throw new Error(`팀 기록이 없어요: ${input.op.teamID}`)
  return team
}

function areaOf(input: Steps.Input, areaID: OwnTeam.AreaID) {
  return input.services.registry.areas.get(input.op.teamID, areaID)
}

/** What finds the WIP commit the op `origin` made on B's branch (its hold ref names it, 8.7). */
function wipOf(from: OwnTeam.Area, origin: OwnTeam.OpID) {
  return { target: from, branch: from.branch, scope: from.id, id: origin }
}

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.begin, PairArgs, {
      observe: async (args, input) => {
        // Markers of this op: the merge went past its start already (a resume).
        if (await marks((await teamOf(input)).commonDir, markerID(input.op.id, args.from)))
          return { state: "satisfied" }
        const ready = await AreaSplit.ready(input, [args.into, args.from])
        if (!ready) return { state: "failed", note: STOPPED }
        if (ready.state !== "satisfied") return ready
        const from = await areaOf(input, args.from)
        if (!from) return { state: "failed", note: GONE }
        const dirty = await changes(from, input.signal)
        if (!dirty.ok) return { state: "failed", note: dirty.message }
        if (dirty.paths.length === 0) return { state: "satisfied" }
        if (from.owner.sessionID !== null) return { state: "pending" }
        return {
          state: "failed",
          note: `'${from.name}' 폴더에 아직 저장 지점에 넣지 않은 변경 ${dirty.paths.length}개가 있어요`,
        }
      },
      // B has uncommitted work and an owner: one turn of it to commit, and the merge waits for that turn (8.7). An
      // owner that cannot take one now gets the request through its outbox, and the merge stops until it is applied
      // again.
      act: async (args, input) => {
        const [into, from] = await Promise.all([areaOf(input, args.into), areaOf(input, args.from)])
        if (!into || !from) return { ok: false, note: GONE }
        const dirty = await changes(from, input.signal)
        if (!dirty.ok) return { ok: false, note: dirty.message }
        if (dirty.paths.length === 0) return DONE
        if (await committing(input.services, from)) {
          const turn = await AreaSplit.requestTurn(input, from, {
            kind: "commit",
            text: commitRequest(into, from, dirty.paths),
            label: `'${from.name}' 담당이 변경 ${dirty.paths.length}개를 저장 지점에 넣는 중이에요`,
          })
          if (turn === "stopped") return { ok: false, note: STOPPED }
          if (turn === "over") {
            const after = await changes(from, input.signal)
            if (!after.ok) return { ok: false, note: after.message }
            if (after.paths.length === 0) return { ok: true, note: "담당이 변경을 저장 지점에 넣었어요" }
            return {
              ok: false,
              note: `'${from.name}' 담당이 변경을 저장 지점에 넣지 않았어요(남은 변경 ${after.paths.length}개: ${shown(after.paths)}). 저장 지점에 넣은 뒤 다시 묶으세요`,
            }
          }
        }
        const asked = await askCommit(input, into, from, dirty.paths)
        return {
          ok: false,
          note: `'${from.name}' 폴더에 아직 저장 지점에 넣지 않은 변경 ${dirty.paths.length}개가 있어 담당에게 저장 지점에 넣어 달라고 했어요. 넣은 뒤 다시 묶으세요${asked}`,
        }
      },
      verify: async () => DONE,
    }),

    {
      ...Steps.define(KIND.into, PairArgs, {
        observe: async (args, input) => {
          const team = await teamOf(input)
          const marked = await marks(team.commonDir, markerID(input.op.id, args.from))
          if (marked === undefined) return { state: "failed", note: "묶기 표시를 읽지 못했어요" }
          if (marked === null) return { state: "pending" }
          const into = await areaOf(input, args.into)
          if (!into) return { state: "failed", note: GONE }
          return (await holds(team.commonDir, into, marked.candidate)) ? { state: "satisfied" } : { state: "pending" }
        },
        act: (args, input) => merge(input, args),
        verify: async (args, input) => {
          const team = await teamOf(input)
          const [marked, into] = await Promise.all([
            marks(team.commonDir, markerID(input.op.id, args.from)),
            areaOf(input, args.into),
          ])
          return marked && into && (await holds(team.commonDir, into, marked.candidate))
            ? DONE
            : { ok: false, note: "영역의 기록에 묶은 결과가 없어요" }
        },
      }),
      reverses: true,
    },

    Steps.define(KIND.handoff, IntoArgs, {
      observe: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        if (!area) return { state: "failed", note: GONE }
        return AreaSplit.written(area, input.op) ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const [area, into] = await Promise.all([areaOf(input, args.areaID), areaOf(input, args.into)])
        if (!area || !into) return { ok: false, note: GONE }
        if (await AreaSplit.warm(services, area, input.op.id)) {
          const turn = await AreaSplit.handoffTurn(
            input,
            area,
            `이 영역을 '${into.name}' 영역에 묶습니다. 이 영역의 기록은 '${into.name}' 줄기에 합쳐졌고, 그 영역의 담당이 이 인계 문서를 받아 이어 갑니다.`,
          )
          if (turn === "stopped") return { ok: false, note: STOPPED }
          if (turn === "written") return { ok: true, note: "담당이 인계 메모를 썼어요" }
        }
        const target = { teamID: input.op.teamID, areaID: area.id }
        const made = await services.features().handoff.program(target)
        if (!made.ok) return { ok: false, note: made.message }
        const saved = await services.features().handoff.write({ ...target, text: made.text, by: "program" })
        return saved.ok ? { ok: true, note: "이 앱이 인계 메모를 썼어요" } : { ok: false, note: saved.message }
      },
      verify: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        return area && AreaSplit.written(area, input.op) ? DONE : { ok: false, note: "인계 메모가 써지지 않았어요" }
      },
    }),

    Steps.define(KIND.attach, AttachArgs, {
      observe: async (args, input) => {
        const into = await areaOf(input, args.areaID)
        if (!into) return { state: "failed", note: GONE }
        const owner = into.owner.sessionID
        // An adopted conversation the team is not attached to gets nothing of the team (3.7); B's document stays in
        // the team records folder.
        if (owner === null || !into.owner.attached)
          return { state: "skip", note: "담당 대화가 아직 팀에 붙지 않아 인계 메모를 붙이지 않았어요" }
        const value = await attached(input, args.from)
        if (!value.ok) return { state: "failed", note: value.message }
        const listed = await input.services.http.instructions.list({ sessionID: owner, directory: into.directory })
        if (!listed.ok) return { state: "failed", note: listed.message }
        const same = listed.value.some(
          (entry) => entry.key === entryKey(args.from) && JSON.stringify(entry.value) === JSON.stringify(value.text),
        )
        return same ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const into = await areaOf(input, args.areaID)
        const owner = into?.owner.sessionID
        if (!into || !owner) return { ok: false, note: GONE }
        const value = await attached(input, args.from)
        if (!value.ok) return { ok: false, note: value.message }
        const put = await RoleInstructions.put(input.services, {
          sessionID: owner,
          directory: into.directory,
          key: entryKey(args.from),
          value: value.text,
          signal: input.signal,
        })
        return put.ok ? DONE : { ok: false, note: put.message }
      },
      verify: async () => DONE,
    }),

    Steps.define(KIND.migrate, MigrateArgs, {
      observe: async (args, input) => {
        if ((await waiting(input, args)).length === 0) return { state: "satisfied" }
        const target = await areaOf(input, args.to)
        if (target?.state !== "active")
          return { state: "skip", note: "옮길 영역이 없어 기다리는 메인 요청을 그대로 뒀어요" }
        return { state: "pending" }
      },
      act: (args, input) => migrate(input, args),
      verify: async (args, input) =>
        (await waiting(input, args)).length === 0 ? DONE : { ok: false, note: "기다리는 메인 요청이 남아 있어요" },
    }),

    Steps.define(KIND.archive, AreaArgs, {
      observe: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        if (!area) return { state: "failed", note: GONE }
        const owner = area.owner.sessionID
        if (owner === null) return { state: "skip", note: "담당 대화가 없어요" }
        const found = await input.services.http.session.get(
          { sessionID: owner, directory: area.directory },
          { signal: input.signal },
        )
        if (!found.ok)
          return found.status === 404
            ? { state: "skip", note: "담당 대화를 찾을 수 없어요" }
            : { state: "failed", note: found.message }
        return found.value.metadata?.[Undo.ARCHIVED] === true ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        const owner = area?.owner.sessionID
        if (!area || !owner) return { ok: false, note: GONE }
        const ref = { sessionID: owner, directory: area.directory }
        // 담당 대화 바꾸기: whoever is still listed in `owner.release` is stripped while the folder is there.
        await input.services.features().seat.sweep({ teamID: input.op.teamID, areaID: args.areaID, inside: true })
        await leave(input.services, ref)
        return mark(input.services, ref, true)
      },
      verify: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        const owner = area?.owner.sessionID
        if (!area || !owner) return { ok: false, note: GONE }
        const found = await input.services.http.session.get({ sessionID: owner, directory: area.directory })
        return found.ok && found.value.metadata?.[Undo.ARCHIVED] === true
          ? DONE
          : { ok: false, note: `대화 ${owner}에 보관 표시가 없어요` }
      },
    }),

    Steps.define(KIND.retire, IntoArgs, {
      observe: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        if (!area) return { state: "failed", note: GONE }
        return area.state === "retired" ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const teamID = input.op.teamID
        const into = await areaOf(input, args.into)
        const name = into?.name ?? args.into
        const now = services.clock.now()
        const retired = await services.write(teamID, async () => {
          const current = await services.registry.areas.get(teamID, args.areaID)
          if (!current) return undefined
          await AreaCreate.save(services, {
            ...current,
            state: "retired",
            status: { kind: "retired", at: now, text: `${name}에 묶음` },
            candidate: undefined,
            // B's peers (동료) are dropped with it (their conversations stay the user's), and so is direct work.
            peers: undefined,
            directWork: undefined,
          })
          return current
        })
        if (!retired) return { ok: false, note: GONE }
        input.summary({ kind: "area", areaID: args.into, change: "merged", from: args.areaID })
        await services.features().digest.add(
          teamID,
          Fold.entry({
            at: now,
            reason: "reorganized",
            areaID: args.into,
            text: `'${retired.name}' 영역을 '${name}'에 묶었습니다. '${retired.name}'의 기록은 남겨 두었습니다`,
          }),
        )
        return DONE
      },
      verify: async (args, input) =>
        (await areaOf(input, args.areaID))?.state === "retired"
          ? DONE
          : { ok: false, note: "영역이 끝난 것으로 적히지 않았어요" },
    }),

    {
      ...Steps.define(KIND.wip, PairArgs, {
        observe: async (args, input) => {
          const from = await areaOf(input, args.from)
          if (!from || from.state !== "active") return { state: "failed", note: GONE }
          const dirty = await Hold.changes(from.directory, input.signal)
          if (!dirty.ok) return { state: "failed", note: dirty.message }
          return dirty.paths.length === 0 ? { state: "satisfied" } : { state: "pending" }
        },
        act: (args, input) => wip(input, args),
        verify: async (args, input) => {
          const from = await areaOf(input, args.from)
          const dirty = from ? await Hold.changes(from.directory, input.signal) : undefined
          return dirty?.ok && dirty.paths.length === 0
            ? DONE
            : { ok: false, note: "아직 저장 지점에 넣지 않은 변경이 남아 있어요. 확인한 뒤 다시 묶으세요" }
        },
      }),
      prepare: async (input) => {
        const args = Option.getOrUndefined(decodePair(input.step.args))
        const [into, from] = args
          ? await Promise.all([areaOf(input, args.into), areaOf(input, args.from)])
          : [undefined, undefined]
        if (!into || !from) throw new Error(GONE)
        const dirty = await Hold.changes(from.directory, input.signal)
        if (!dirty.ok) throw new Error(dirty.message)
        return {
          text: `'${from.name}' 폴더에 아직 저장 지점에 넣지 않은 변경 ${dirty.paths.length}개가 있어요(${shown(dirty.paths)}). '${into.name}'에 묶으려면 이 변경을 '${from.name}'의 저장 지점에 넣어야 해요. 파일은 그대로 두고 저장 지점만 만들며, 사본도 따로 남겨요. 넣은 뒤 다시 묶으세요.`,
        }
      },
      reverses: true,
    },

    // 8.7: the WIP commit taken back while B's branch is still W (compare-and-swap); the files stay as they are.
    Steps.define(KIND.wipUndo, WipUndoArgs, {
      observe: async (args, input) => {
        const from = await areaOf(input, args.areaID)
        if (!from) return { state: "skip", note: GONE }
        const found = await Wip.find({ ...wipOf(from, args.origin), signal: input.signal })
        if (!found.ok) return { state: "failed", note: found.message }
        return found.state === "made" ? { state: "pending" } : { state: "satisfied" }
      },
      act: async (args, input) => {
        const from = await areaOf(input, args.areaID)
        if (!from) return { ok: false, note: GONE }
        const ready = await AreaSplit.ready(input, [from.id])
        if (!ready) return { ok: false, note: STOPPED }
        if (ready.state !== "satisfied") return { ok: false, note: "note" in ready ? ready.note : GONE }
        const found = await Wip.find({ ...wipOf(from, args.origin), signal: input.signal })
        if (!found.ok) return { ok: false, note: found.message }
        if (found.state !== "made") return DONE
        const undone = await Wip.undo({
          target: from,
          branch: from.branch,
          sha: found.sha,
          parent: found.parent,
          signal: input.signal,
        })
        if (!undone.ok)
          return {
            ok: false,
            note:
              undone.error === "moved"
                ? `'${from.name}'의 기록이 그 뒤로 바뀌어 저장 지점을 되돌리지 않았어요`
                : `저장 지점을 되돌리지 못했어요: ${undone.message}`,
          }
        return DONE
      },
      verify: async (args, input) => {
        const from = await areaOf(input, args.areaID)
        if (!from) return DONE
        const found = await Wip.find({ ...wipOf(from, args.origin), signal: input.signal })
        return found.ok && found.state !== "made"
          ? DONE
          : { ok: false, note: "넣은 저장 지점이 아직 기록에 남아 있어요" }
      },
    }),

    Steps.define(KIND.undo, UndoArgs, {
      observe: async (args, input) => {
        const team = await teamOf(input)
        const marked = await marks(team.commonDir, markerID(args.origin, args.from))
        if (marked === undefined) return { state: "failed", note: "묶기 표시를 읽지 못했어요" }
        if (marked === null) return { state: "satisfied" }
        const into = await areaOf(input, args.into)
        if (!into) return { state: "failed", note: GONE }
        const tip = await Refs.read(team.commonDir, `refs/heads/${into.branch}`)
        return tip === marked.base ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const team = await teamOf(input)
        const [marked, into, from] = await Promise.all([
          marks(team.commonDir, markerID(args.origin, args.from)),
          areaOf(input, args.into),
          areaOf(input, args.from),
        ])
        if (!marked || !into) return { ok: false, note: GONE }
        const ready = await AreaSplit.ready(input, [into.id])
        if (!ready) return { ok: false, note: STOPPED }
        if (ready.state !== "satisfied") return { ok: false, note: "note" in ready ? ready.note : GONE }
        return reset(input, team, into, marked, from?.name ?? args.from)
      },
      verify: async (args, input) => {
        const team = await teamOf(input)
        const [marked, into] = await Promise.all([
          marks(team.commonDir, markerID(args.origin, args.from)),
          areaOf(input, args.into),
        ])
        if (marked === null) return DONE
        const tip = into ? await Refs.read(team.commonDir, `refs/heads/${into.branch}`) : undefined
        return marked && tip === marked.base ? DONE : { ok: false, note: "영역이 묶기 전 자리로 돌아오지 않았어요" }
      },
    }),

    Steps.define(KIND.undoArea, UndoArgs, {
      observe: async (args, input) => {
        const marked = await marks((await teamOf(input)).commonDir, markerID(args.origin, args.from))
        if (marked === undefined) return { state: "failed", note: "묶기 표시를 읽지 못했어요" }
        return marked === null ? { state: "satisfied" } : { state: "pending" }
      },
      act: (args, input) => restore(input, args),
      verify: async (args, input) =>
        (await marks((await teamOf(input)).commonDir, markerID(args.origin, args.from))) === null
          ? DONE
          : { ok: false, note: "묶기 표시가 아직 남아 있어요" },
    }),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// merge-begin: the commit request

/**
 * B's owner takes the commit request as a turn of its own now: it is attached to the team (3.7: an adopted
 * conversation may run on another subscription of the team main's company, U5), not under Main 멈춤 (5.3) and not out
 * of its limit.
 */
async function committing(services: Services.Context, area: OwnTeam.Area) {
  const owner = area.owner.sessionID
  if (owner === null || !area.owner.attached || Direct.kept(area)) return false
  const state = await services.accounts.switchState({ sessionID: owner }, { directory: area.directory })
  return !(state.ok && state.value.state === "BLOCKED")
}

/** The commit request of a turn (8.7); the model never sees metadata, so the text says it all. */
function commitRequest(into: OwnTeam.Area, from: OwnTeam.Area, paths: ReadonlyArray<string>) {
  const body = [
    `'${into.name}' 영역에 이 영역을 묶으려는데 이 폴더에 커밋 안 된 변경이 있습니다: ${shown(paths)}`,
    `이번 일에서 만든 변경이면 변경을 커밋해 주세요(${from.deferredName ? "지금 꺼낸 기록에" : `이 줄기 ${from.branch}에만`}). 새 일은 시작하지 말고, 커밋한 뒤 짧게 답하고 끝내세요.`,
    "이번 일에서 만든 것이 아니면 커밋·되돌리기·stash·덮어쓰기를 하지 말고 그 이유를 짧게 답하고 끝내세요.",
  ]
    .join("\n")
    .replace(/<\/team-request/gi, (match) => `<\\${match.slice(1)}`)
  return `<team-request kind="commit" area="${OwnTeamText.attribute(from.name)}">\n${body}\n</team-request>`
}

/** B's owner is asked to commit (5.1 path; it waits in B's outbox while this op runs); once per op. */
async function askCommit(input: Steps.Input, into: OwnTeam.Area, from: OwnTeam.Area, paths: ReadonlyArray<string>) {
  const services = input.services
  const earlier = (await services.registry.dispatches.list(input.op.teamID, from.id)).some(
    (dispatch) =>
      dispatch.from === "team" &&
      dispatch.task === COMMIT_TASK &&
      dispatch.createdAt >= input.op.createdAt &&
      dispatch.state !== "cancelled",
  )
  if (earlier) return ""
  const sent = await services.features().admit.dispatch({
    teamID: input.op.teamID,
    areaID: from.id,
    from: "team",
    kind: "task",
    task: COMMIT_TASK,
    origin: input.op.createdAt,
    text: [
      `'${into.name}' 영역에 묶기 전에 이 폴더의 커밋 안 된 변경을 정리해야 합니다: ${shown(paths)}`,
      `이번 일에서 만든 변경이면 변경을 커밋해 주세요(${from.deferredName ? "지금 꺼낸 기록에" : `이 줄기 ${from.branch}에만`}). 커밋한 뒤 team_report(kind:"done")로 알려 주세요.`,
      `이번 일에서 만든 것이 아니면 커밋·되돌리기·stash·덮어쓰기를 하지 말고 team_report(kind:"blocked")로 알리세요.`,
    ].join("\n"),
  })
  return sent.ok ? "" : ` · 담당에게 알리지 못함: ${sent.message}`
}

// ---------------------------------------------------------------------------------------------------------------
// merge-into

async function merge(input: Steps.Input, args: typeof PairArgs.Type): Promise<Steps.Outcome> {
  const team = await teamOf(input)
  const [into, from] = await Promise.all([areaOf(input, args.into), areaOf(input, args.from)])
  if (!into || !from || into.state !== "active" || from.state !== "active") return { ok: false, note: GONE }
  // TI-14: git touches A's files and reads B's HEAD only in the folders on record.
  const checked = await Promise.all([Identity.check(into), Identity.check(from)])
  const wrong = checked.find((check) => !check.ok)
  if (wrong && !wrong.ok) return { ok: false, note: `작업 폴더를 확인하지 못했어요: ${wrong.message}` }
  const id = markerID(input.op.id, from.id)
  const earlier = await marks(team.commonDir, id)
  if (earlier === undefined) return { ok: false, note: "묶기 표시를 읽지 못했어요" }
  const made = earlier === null ? await make(input, team, into, from, id) : { ok: true as const, marks: earlier }
  if (!made.ok) return { ok: false, note: made.note }
  return forward(input, team, into, id, made.marks)
}

/** 7.2 steps 1-5 with A's branch as the target: C, A_old, K and the markers. */
async function make(
  input: Steps.Input,
  team: OwnTeam.Team,
  into: OwnTeam.Area,
  from: OwnTeam.Area,
  id: string,
): Promise<{ readonly ok: true; readonly marks: Marks } | { readonly ok: false; readonly note: string }> {
  const repo = team.commonDir
  const signal = input.signal
  const source = from.deferredName
    ? (await Advance.head(from.directory, signal))?.oid
    : await Refs.read(repo, `refs/heads/${from.branch}`)
  if (!source) return { ok: false, note: `'${from.name}'의 기록 끝을 읽지 못했어요` }
  if (from.deferredName) {
    const kept = await keepDetached(input, repo, from, source)
    if (!kept.ok) return kept
  }
  const base = await Refs.read(repo, `refs/heads/${into.branch}`)
  if (!base) return { ok: false, note: `'${into.name}'의 기록 끝을 읽지 못했어요` }
  const outcome = await Merge.compute({
    repo,
    base,
    source,
    message: `팀: '${oneLine(from.name)}' 영역을 '${oneLine(into.name)}'에 묶기 (${input.op.id})`,
    at: input.op.createdAt,
    signal,
  })
  if (!outcome.ok) return { ok: false, note: outcome.message }
  if (outcome.how === "conflict") return conflict(input, into, from, source, outcome.paths)
  const candidate = outcome.how === "merged" ? base : outcome.candidate
  const marked = await Merge.mark({ repo, integrationID: id, base, source, candidate })
  if (!marked.ok) return { ok: false, note: marked.message }
  return { ok: true, marks: { base, source, candidate } }
}

/**
 * TI-8: B without a branch keeps its HEAD commits in `refs/own/keep/<C>` before anything else, so an undo after its
 * folder went never leaves them unreachable.
 */
async function keepDetached(input: Steps.Input, repo: string, from: OwnTeam.Area, source: string) {
  const only = await Git.run(["rev-list", "--max-count=1", source, "--not", "--branches", "--remotes", "--tags"], {
    cwd: repo,
    worktree: true,
    signal: input.signal,
  })
  if (!only.ok) return { ok: false as const, note: only.message }
  if (only.stdout.trim() === "") return { ok: true as const }
  const ref = `refs/own/keep/${source}`
  const created = await Refs.create(repo, { ref, oid: source }, "own.team keep")
  if (!created.ok) return { ok: false as const, note: created.message }
  input.summary({ kind: "ref", ref, sha: source })
  input.services.notices.publish({
    teamID: input.op.teamID,
    areaID: from.id,
    kind: "detached.kept",
    text: "이름 없는 작업 상태를 보관해 뒀어요",
    data: { ref },
  })
  return { ok: true as const }
}

/** 7.3 for a merge: A's owner gets a `from="team"` conflict request (it waits in A's outbox while this op runs). */
async function conflict(
  input: Steps.Input,
  into: OwnTeam.Area,
  from: OwnTeam.Area,
  source: string,
  paths: ReadonlyArray<string>,
) {
  const rev = from.deferredName ? source : from.branch
  const sent = await input.services.features().admit.dispatch({
    teamID: input.op.teamID,
    areaID: into.id,
    from: "team",
    kind: "conflict",
    origin: input.op.createdAt,
    text: [
      `'${from.name}' 영역을 이 영역에 묶으려는데 겹치는 변경이 있습니다: ${shown(paths)}`,
      `이 영역에서 ${rev}를 합쳐 정리하고 커밋한 뒤 team_report(kind:"ready")로 알려 주세요. 정리되면 다시 묶습니다.`,
    ].join("\n"),
  })
  const asked = sent.ok ? "" : ` · 담당에게 알리지 못함: ${sent.message}`
  return {
    ok: false as const,
    note: `겹친 변경 ${paths.length}개가 있어 담당에게 정리를 부탁했어요: ${shown(paths)}${asked}`,
  }
}

/**
 * A's folder fast-forwards to K at its safe point, looked at again right here (TI-9, 8.4: the begin step's wait is
 * skipped when an op resumes with its markers made): its HEAD must be its branch at A_old, no uncommitted file may
 * overlap B's changes (7.2: in a code-only folder git would overwrite an untracked one), and A's uncommitted work gets a
 * hold ref first (TI-1). A failure takes the markers away again.
 */
async function forward(
  input: Steps.Input,
  team: OwnTeam.Team,
  into: OwnTeam.Area,
  id: string,
  marked: Marks,
): Promise<Steps.Outcome> {
  const signal = input.signal
  const abandon = async (note: string): Promise<Steps.Outcome> => {
    await Advance.clearMarkers(team.commonDir, id)
    return { ok: false, note }
  }
  const note = `${marked.candidate.slice(0, 7)} (이전 끝 ${marked.base.slice(0, 7)})`
  const first = await Advance.head(into.directory, signal)
  if (first?.oid === marked.candidate && first.branch === `refs/heads/${into.branch}`) return { ok: true, note }
  const ready = await AreaSplit.ready(input, [into.id])
  if (!ready) return { ok: false, note: STOPPED }
  if (ready.state !== "satisfied") return abandon("note" in ready ? ready.note : GONE)
  const head = await Advance.head(into.directory, signal)
  if (!head || head.branch !== `refs/heads/${into.branch}`)
    return abandon(`'${into.name}' 폴더가 영역의 기록을 꺼내 두고 있지 않아요`)
  if (head.oid === marked.candidate) return { ok: true, note }
  if (head.oid !== marked.base) return abandon(`'${into.name}'의 기록이 그사이 바뀌었어요. 다시 묶으세요`)
  const overlap = await Advance.overlap(into.directory, marked.base, marked.candidate, signal)
  if (overlap === undefined) return abandon("겹치는 변경이 있는지 확인하지 못했어요")
  if (overlap.length > 0)
    return abandon(`'${into.name}'의 아직 저장 지점에 넣지 않은 변경 ${overlap.length}개가 겹쳐요: ${shown(overlap)}`)
  const held = await hold(input, into)
  if (!held.ok) return abandon(held.note)
  await Git.run(["merge", "--ff-only", "--no-autostash", "--no-stat", marked.candidate], {
    cwd: into.directory,
    write: true,
    worktree: true,
    signal,
  })
  const after = await Advance.head(into.directory, signal)
  if (after?.oid !== marked.candidate) return abandon(`'${into.name}' 폴더를 앞으로 감지 못했어요`)
  return { ok: true, note }
}

/** TI-1: A's uncommitted work (link copies included, 4.12) copied to `refs/own/hold/<A>/<op>` before A moves. */
async function hold(input: Steps.Input, area: OwnTeam.Area) {
  const [listed, links] = await Promise.all([Hold.changes(area.directory, input.signal), Hold.dirtyLinks(area)])
  if (!listed.ok) return { ok: false as const, note: listed.message }
  if (listed.paths.length === 0 && links.length === 0) return { ok: true as const }
  const held = await Hold.create({
    target: area,
    scope: area.id,
    id: input.op.id,
    at: input.op.createdAt,
    links,
    signal: input.signal,
  })
  if (!held.ok) return { ok: false as const, note: held.message }
  input.summary({ kind: "ref", ref: held.ref, sha: held.sha, bytes: held.bytes })
  return { ok: true as const }
}

// ---------------------------------------------------------------------------------------------------------------
// merge-attach, merge-archive

/** B's handoff as A's owner gets it (6.4: cut at 64 KB). */
async function attached(
  input: Steps.Input,
  fromID: OwnTeam.AreaID,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }> {
  const from = await areaOf(input, fromID)
  if (!from) return { ok: false, message: GONE }
  const text = await input.services.features().handoff.read({ teamID: input.op.teamID, areaID: from.id })
  if (text === undefined) return { ok: false, message: `'${from.name}'의 인계 메모가 없어요` }
  return {
    ok: true,
    text: Handoff.cap(
      [
        `# 묶은 영역의 인계: ${from.name}`,
        "",
        `'${from.name}' 영역을 이 영역에 묶었습니다. 그 영역의 기록은 이 줄기에 합쳐졌고 그 담당 대화는 지난 대화가 되었습니다. 아래는 그 영역의 인계 문서입니다.`,
        "",
        text,
      ].join("\n"),
    ),
  }
}

/** 6.2 step 4: the conversation leaves the team, its binding's `team` cleared (the gate then sees no team). */
async function leave(services: Services.Context, ref: { readonly sessionID: string; readonly directory: string }) {
  const where = { directory: ref.directory }
  const view = await services.accounts.presetGet({ sessionID: ref.sessionID }, where)
  const binding = view.ok ? view.value.binding : null
  if (!binding?.team) return
  const cleared = await services.accounts.presetApply(
    { sessionID: ref.sessionID, presetID: binding.presetID, team: null },
    where,
  )
  if (!cleared.ok) services.log.warn("merge_team_not_cleared", { sessionID: ref.sessionID, type: cleared.type })
}

const decodeMetadata = (value: unknown) =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(value), () => ({}))

/** Sets (`on`) or takes back the archive mark (metadata read-modify-write, TI-5). */
async function mark(
  services: Services.Context,
  ref: { readonly sessionID: string; readonly directory: string },
  on: boolean,
): Promise<Steps.Outcome> {
  const written = await services.http.session.metadata({
    ...ref,
    change: (current) => {
      const metadata = decodeMetadata(current)
      return on
        ? { ...metadata, [Undo.ARCHIVED]: true }
        : Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== Undo.ARCHIVED))
    },
  })
  return written.ok
    ? DONE
    : { ok: false, note: `대화 ${ref.sessionID}의 보관 표시를 ${on ? "하지" : "풀지"} 못했어요: ${written.message}` }
}

// ---------------------------------------------------------------------------------------------------------------
// wip-commit (8.7)

async function wip(input: Steps.Input, args: typeof PairArgs.Type): Promise<Steps.Outcome> {
  const services = input.services
  const [into, from] = await Promise.all([areaOf(input, args.into), areaOf(input, args.from)])
  if (!into || !from || from.state !== "active") return { ok: false, note: GONE }
  const safe = await services
    .features()
    .safePoint.check({ teamID: input.op.teamID, areaID: from.id, signal: input.signal })
  if (!safe.ok) return { ok: false, note: `'${from.name}' 폴더에서 누군가 일하는 중이라 넣지 않았어요` }
  const made = await Wip.commit({
    target: from,
    branch: from.branch,
    scope: from.id,
    id: input.op.id,
    at: input.op.createdAt,
    message: `팀: '${oneLine(from.name)}'의 커밋 안 된 변경 저장 (${input.op.id})`,
    signal: input.signal,
  })
  if (!made.ok) return { ok: false, note: `'${from.name}'의 변경을 저장 지점에 넣지 못했어요: ${made.message}` }
  if (made.state === "clean") return { ok: true, note: "저장 지점에 넣을 변경이 없어요" }
  input.summary({ kind: "ref", ref: made.hold.ref, sha: made.hold.sha, bytes: made.hold.bytes })
  await services.features().digest.add(
    input.op.teamID,
    Fold.entry({
      at: services.clock.now(),
      reason: "reorganized",
      areaID: from.id,
      text: `'${from.name}'의 커밋 안 된 변경을 그 영역의 저장 지점에 넣었습니다. 이제 '${into.name}'에 묶을 수 있습니다`,
    }),
  )
  return { ok: true, note: made.sha.slice(0, 7) }
}

// ---------------------------------------------------------------------------------------------------------------
// Undo

/**
 * 7.4 for A: `reset --keep A_old` in A's folder after the identity check (TI-14). A commit made on A since the merge
 * (the tip past K) and one that lands between the look and the reset (`ORIG_HEAD` is not K) go to
 * `refs/own/keep/<sha>` with an `undo.kept` notice; overlapping local changes stop git before it touches anything.
 * A tip that left K's line leaves only 다시 만들기 of B (`name`).
 */
async function reset(
  input: Steps.Input,
  team: OwnTeam.Team,
  into: OwnTeam.Area,
  marked: Marks,
  name: string,
): Promise<Steps.Outcome> {
  const signal = input.signal
  const identity = await Identity.check(into)
  if (!identity.ok) return { ok: false, note: `작업 폴더를 확인하지 못했어요: ${identity.message}` }
  const head = await Advance.head(into.directory, signal)
  if (!head || head.branch !== `refs/heads/${into.branch}`)
    return { ok: false, note: `'${into.name}' 폴더가 영역의 기록을 꺼내 두고 있지 않아요` }
  if (head.oid === marked.base) return DONE
  const contains =
    head.oid === marked.candidate || (await Advance.ancestor(into.directory, marked.candidate, head.oid, signal))
  if (!contains)
    return {
      ok: false,
      note: `'${into.name}'의 기록이 다른 곳으로 바뀌어 되돌릴 수 없어요. '${name}' 영역은 다시 만들기만 할 수 있어요`,
    }
  const early = head.oid === marked.candidate ? undefined : head.oid
  const first = early === undefined ? DONE : await keep(input, team, into, early)
  if (!first.ok) return first
  await Git.run(["reset", "--keep", marked.base], { cwd: into.directory, write: true, worktree: true, signal })
  const after = await Advance.head(into.directory, signal)
  if (after?.oid !== marked.base) {
    const overlap = await Advance.overlap(into.directory, head.oid, marked.base, signal)
    return { ok: false, note: `아직 저장 지점에 넣지 않은 변경이 겹쳐 되돌리지 못했어요: ${shown(overlap ?? [])}` }
  }
  const orig = await Git.run(["rev-parse", "--verify", "--quiet", "ORIG_HEAD^{commit}"], {
    cwd: into.directory,
    worktree: true,
    signal,
  })
  const previous = orig.ok ? orig.stdout.trim() : head.oid
  if (previous === marked.candidate || previous === early) return DONE
  const late = await keep(input, team, into, previous)
  return late.ok
    ? DONE
    : { ok: false, note: `되돌렸지만 그 사이 생긴 저장 지점(${previous})을 보관하지 못했어요: ${late.note}` }
}

/** `refs/own/keep/<sha>` (create-only) with the card line and an `undo.kept` notice. */
async function keep(input: Steps.Input, team: OwnTeam.Team, area: OwnTeam.Area, sha: string): Promise<Steps.Outcome> {
  const ref = `refs/own/keep/${sha}`
  const created = await Refs.create(team.commonDir, { ref, oid: sha }, "own.team keep")
  if (!created.ok) return { ok: false, note: created.message }
  input.summary({ kind: "ref", ref, sha })
  input.services.notices.publish({
    teamID: team.id,
    areaID: area.id,
    kind: "undo.kept",
    text: "묶기를 되돌리면서 그사이 만든 저장 지점을 따로 보관해 뒀어요",
    data: { ref, sha },
  })
  return DONE
}

/**
 * B back in the team while its folder is still the one on record: `active` again, its owner un-archived and given
 * the team context again (`TeamContext.push`). B's document leaves A's owner, and the markers go last (the step's
 * fact). A folder that was removed is not registered again: only 'B 다시 만들기' is left for it (a new area from B's
 * branch, which stays).
 */
async function restore(input: Steps.Input, args: typeof UndoArgs.Type): Promise<Steps.Outcome> {
  const services = input.services
  const team = await teamOf(input)
  const teamID = team.id
  const [into, from] = await Promise.all([areaOf(input, args.into), areaOf(input, args.from)])
  const there = from ? (await Identity.check(from)).ok : false
  if (from && there) {
    await services.write(teamID, async () => {
      const current = await services.registry.areas.get(teamID, from.id)
      if (!current || current.state !== "retired") return
      await AreaCreate.save(services, {
        ...current,
        state: "active",
        status: { kind: "idle", at: services.clock.now(), text: "" },
      })
    })
    const owner = from.owner.sessionID
    if (owner !== null) {
      const ref = { sessionID: owner, directory: from.directory }
      const found = await services.http.session.get(ref)
      if (found.ok && found.value.metadata?.[Undo.ARCHIVED] === true) {
        const unarchived = await mark(services, ref, false)
        if (!unarchived.ok) return unarchived
      }
    }
    await services.features().teamContext.push(teamID)
  }
  const owner = into?.owner.sessionID
  if (into && owner) {
    const where = { sessionID: owner, directory: into.directory }
    const listed = await services.http.instructions.list(where)
    if (listed.ok && listed.value.some((entry) => entry.key === entryKey(args.from))) {
      const removed = await services.http.instructions.remove({ ...where, key: entryKey(args.from) })
      if (!removed.ok)
        return { ok: false, note: `'${from?.name ?? args.from}'의 인계 메모를 떼지 못했어요: ${removed.message}` }
    }
  }
  await Advance.clearMarkers(team.commonDir, markerID(args.origin, args.from))
  const name = from?.name ?? args.from
  await services.features().digest.add(
    teamID,
    Fold.entry({
      at: services.clock.now(),
      reason: "reorganized",
      areaID: args.into,
      text: `'${name}' 영역을 '${into?.name ?? args.into}'에 묶은 것을 되돌렸습니다`,
    }),
  )
  return there
    ? DONE
    : { ok: true, note: `'${name}' 폴더가 없어 다시 등록하지 않았어요. '${name}' 영역은 다시 만들기만 할 수 있어요` }
}

// ---------------------------------------------------------------------------------------------------------------
// The outbox step (06 §8.2)

/** The requests `outbox-migrate` still has to move. */
async function waiting(input: Steps.Input, args: typeof MigrateArgs.Type) {
  return (await input.services.registry.dispatches.waiting(input.op.teamID, args.areaID)).filter(
    (dispatch) => args.movedFrom === undefined || dispatch.movedFrom === args.movedFrom,
  )
}

/**
 * `outbox-migrate`: an area's waiting main requests move to `to` (`Outbox.migrate`; 영역 묶기 B → A, and back on its
 * undo with `movedFrom`). A merge also cancels the area's waiting program requests, notices and area messages
 * (`from="team"`, `from="area"`: they are about its folder and its conversations, 5.8) and lists them on the op's card.
 * Nothing is sent; the main hears of the move at its next team update (`reorganized` does not wake it, 5.6). An area to
 * move to that is gone or no longer active leaves them where they are.
 */
async function migrate(input: Steps.Input, args: typeof MigrateArgs.Type): Promise<Steps.Outcome> {
  const services = input.services
  const teamID = input.op.teamID
  const moved = await Outbox.migrate(services, {
    teamID,
    from: args.areaID,
    to: args.to,
    ...(args.movedFrom === undefined ? {} : { movedFrom: args.movedFrom }),
  })
  if (moved.length > 0) {
    const [from, to] = await Promise.all([areaOf(input, args.areaID), areaOf(input, args.to)])
    await services.features().digest.add(
      teamID,
      Fold.entry({
        at: services.clock.now(),
        reason: "reorganized",
        areaID: args.to,
        text: `${from?.name ?? args.areaID}에서 기다리던 메인 요청 ${moved.length}개를 ${to?.name ?? args.to} 영역으로 옮겼습니다`,
      }),
    )
  }
  // A merge takes the whole outbox: the program's requests and notices about this folder, and the area messages to its
  // conversations (5.8), are cancelled, not moved (an asker hears of it, `Talk.cancelled`).
  const program =
    args.movedFrom === undefined
      ? (await services.registry.dispatches.waiting(teamID, args.areaID)).filter((dispatch) => dispatch.from !== "main")
      : []
  // Outside the team's write section: the outbox serializes per area and writes through the mutex itself.
  await Promise.all(
    program.map((dispatch) =>
      services.features().admit.cancel({ teamID, areaID: args.areaID, dispatchID: dispatch.id }),
    ),
  )
  program.forEach((dispatch) => input.summary({ kind: "cancelled", areaID: args.areaID, dispatchID: dispatch.id }))
  return { ok: true, note: `${moved.length}` }
}
