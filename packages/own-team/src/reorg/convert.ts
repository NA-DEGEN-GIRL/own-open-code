export * as Convert from "./convert.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../assets/need-paths.js"
import { Symlinks } from "../assets/symlinks.js"
import { Cone } from "../git/cone.js"
import { Identity } from "../git/identity.js"
import { Lfs } from "../git/lfs.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { GitVersion } from "../git/version.js"
import { Confirm } from "../ops/confirm.js"
import { Steps } from "../ops/steps.js"
import { Services } from "../services.js"
import { Rotation } from "../sessions/rotate.js"
import { Direct } from "../dispatch/direct.js"
import { Settle } from "./settle.js"
import { Journal } from "../ops/journal.js"

/**
 * Converting an area folder (06 §8.2 전체 → 코드 전용 / 코드 전용 → 전체, §4.7, §4.12, §4.14). One `reorg` op:
 *
 *   ask           a conversion that deletes ignored files (TI-2) or downloads (code → full) asks first:
 *                 `convert-confirm`, a confirm that holds back the steps after it (`Steps.Kind.holds`). Only `do` lets
 *                 the rotation and the conversion run (in the background, so `op.confirm` answers at once); `두기`
 *                 skips them, so declining never replaces the owner conversation. The conversion then deletes exactly
 *                 the list that confirm showed (its manifest, kept on the done step)
 *   full → code   the owner conversation is replaced first (`rotate.*`, reason `worktree`; a program handoff for an
 *                 owner that never got the team, T2.15; none for a folder without an owner), so no conversation's
 *                 snapshot history spans the conversion (4.14), then `convert-to-code`. A `plain` folder converts the
 *                 same way once the heavy list grew (06 §4.4); when no folder leaves (`Checked.quiet`: its HEAD has
 *                 none of the heavy folders) no file changes, so the owner conversation stays:
 *                   1  the extended safe point (8.4: no pty either); by:user waits and shows why on the card, by:main
 *                      and by:auto skip the area (TI-9); Main 멈춤 skips by:main and by:auto (TI-13), as does a skipped
 *                      rotation
 *                   2  the identity check (TI-14): a mismatch marks the area `broken` (`identity`) with no git write
 *                   3  TI-8: commits only a detached HEAD holds get `refs/own/keep/<HEAD>` before anything else
 *                   4  every leaving folder (the folders the new cone collapses) checked whole: `status --porcelain=v2
 *                      -z --untracked-files=all --ignored=matching -- <dir>/` plus the link-copy check
 *                      (`Symlinks.dirtyCopies`); modified, staged or untracked files, a changed link copy, or a flagged
 *                      link copy own never recorded refuse the conversion (TI-1). Ignored files are deleted by the
 *                      conversion (4.7), so they make the conversion ask first with their list and bytes (TI-2); own's
 *                      clean folder copies are not the user's files and are not listed
 *                   5  the link copies re-flagged for the new shape (`Symlinks.flag`: code = assume-unchanged); a
 *                      copy left with a hand-set skip-worktree bit would be cleared by `set` and committed by `add -A`
 *                      as a 120000 → 100644 type change (4.12)
 *                   6  right before `set` everything again: the extended safe point, the leaving folders (anything new,
 *                      an ignored file included, aborts: the confirm covered exactly the list it showed) and
 *                      `Cone.endangered` (the T1 review rule); an abort puts the flags back
 *                   7  own's clean copies inside the leaving folders removed (`set` keeps a file whose content is not
 *                      its blob, flags or not), then `sparse-checkout set --cone --sparse-index --stdin` with the
 *                      complement of the heavy folders plus `cone.extra` (4.5), recorded as `shape: "code"`
 *                   8  `ls-files --sparse -t`: every leaving folder is one `S <dir>/` entry, `index.sparse` is true,
 *                      tracked status shows no type change and nothing in a folded folder (the user's changes in the
 *                      cone stay as they were); the copies applied again and recorded (`Symlinks.refresh`)
 *   code → full   `convert-to-full` after the ask with the bytes the heavy folders take and the download it needs
 *                 (4.9: `sparse-checkout disable` writes every heavy folder): the missing LFS objects fetched first, the
 *                 extended safe point, the identity check, `sparse-checkout disable` (after `Cone.endangered`, which
 *                 finds nothing to collapse), no type change in tracked status, the links outside the old cone turned
 *                 into copies with the home's flag (`Symlinks.flag`: full = the home's flag)
 *
 * The undo of one is the other ({@link undo}). own-web labels the kinds `own.team.step.kind.convertToCode`,
 * (T3.13) `convertToFull` and `convertConfirm`. Steps are observe → act → verify: observing a folder whose shape and
 * sparse state already match the target is `done` (TI-11). Nothing here deletes a file the user made without a
 * confirm, and nothing writes to a folder that failed the identity check.
 */

/** The step kinds by target shape. */
export const STEP = { code: "convert-to-code", full: "convert-to-full" } as const

/** The confirm that a conversion asks first and that holds back its rotation and its conversion step. */
export const ASK = "convert-confirm"

export type Shape = keyof typeof STEP

/**
 * The shapes a conversion to `shape` starts from. A `plain` folder (no sparse checkout because the team had no heavy
 * folders) converts to code-only once the heavy list grew (06 §4.4, `assets/heavy.ts`).
 */
const FROM: Readonly<Record<Shape, ReadonlyArray<OwnTeam.Area["shape"]>>> = { code: ["full", "plain"], full: ["code"] }

/** Why a conversion stopped right before `set` (aborted, nothing changed). */
export const CHANGED = "확인한 뒤 큰 파일 폴더의 파일이 바뀌어 폴더를 바꾸지 않았어요. 다시 시도하세요"
export const BUSY = "영역 폴더에서 일이 시작되어 폴더를 바꾸지 않았어요. 다시 시도하세요"
export const KEPT = "큰 파일 폴더에 확인하지 않은 무시된 파일이 있어 폴더를 바꾸지 않았어요"
export const NETWORK = "필요한 파일을 내려받지 못해 전체 폴더로 바꾸지 못했어요(네트워크)"
/** The rotation before the conversion was skipped (Main 멈춤): the conversion goes with it. */
const ABANDONED = "담당 대화를 바꾸지 않아 폴더도 바꾸지 않았어요(메인 멈춤)"
const PAUSED = "메인 멈춤이 켜져 있어 폴더를 바꾸지 않고 건너뛰었어요"
const SKIPPED = "영역 폴더에서 일하는 중이라 폴더를 바꾸지 않고 건너뛰었어요"
const STOPPED = "서비스가 닫혀 멈췄어요"
const GONE = "영역이나 팀을 찾을 수 없어요"

/** A file or folder a conversion to code deletes (4.7: ignored files in a leaving folder). */
export interface Removed {
  /** Repository-relative; a folder ends with `/`. */
  readonly path: string
  readonly bytes: number
  readonly mtime: number
}

export interface Checked {
  /** `confirm` when the conversion deletes ignored files (TI-2) or downloads (code → full). */
  readonly mode: OwnTeam.StepMode
  /** What a conversion to code deletes, largest first. */
  readonly removed: ReadonlyArray<Removed>
  /**
   * A conversion to code where no folder leaves (none of the heavy folders is in the folder's HEAD): no file changes,
   * so the owner conversation is not replaced either (4.14 is about files that change under a conversation).
   */
  readonly quiet: boolean
}

/**
 * The read-only check a conversion starts with (no index write, so it may run away from a safe point): the shapes, Git
 * 2.42 for a code-only folder (4.2), the identity, and for a conversion to code the leaving folders (`dirty` refuses
 * it, ignored files make it a confirm).
 */
export async function check(
  input: { readonly team: OwnTeam.Team; readonly area: OwnTeam.Area; readonly shape: Shape },
  item = "convert",
): Promise<Services.Result<Checked>> {
  const area = input.area
  if (area.state === "broken")
    return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  if (area.state !== "active")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: area.id })
  if (!FROM[input.shape].includes(area.shape)) return invalid(item, refusal(area, input.shape))
  if (input.shape === "code" && input.team.heavy.dirs.length === 0)
    return invalid(item, "이 팀에는 큰 파일 폴더가 없어 가벼운 폴더로 바꿀 것이 없어요")
  const version = await GitVersion.check(area.directory)
  if (!version.ok) return versionFailure(version, area.directory)
  if (input.shape === "code" && version.shape !== "code") return invalid(item, GitVersion.OLD_GIT_TEXT)
  const identity = await Identity.check(area)
  if (!identity.ok) return Services.failure("broken", identity.message, { areaID: area.id, why: identity.broken })
  if (input.shape === "full") return { ok: true, mode: "confirm", removed: [], quiet: false }
  const planned = await target(input.team, area)
  if (!planned.ok) return Services.failure("not_git", planned.message, { directory: area.directory })
  const seen = await inspect(area, planned.leaving, false)
  if (!seen.ok) return Services.failure("not_git", seen.message, { directory: area.directory })
  if (seen.dirty.length > 0)
    return Services.failure("dirty", "leaving folders hold work that is not committed", {
      directory: area.directory,
      count: seen.dirty.length,
      paths: seen.dirty.slice(0, 20),
    })
  return {
    ok: true,
    mode: seen.removed.length > 0 ? "confirm" : "auto",
    removed: seen.removed,
    quiet: planned.leaving.length === 0,
  }
}

/**
 * The steps of one conversion, for a `reorg` op of its own ({@link start}) or for a reorganization's op: the ask
 * when {@link check} found a confirm ({@link ASK}, holding back the rest), the rotation first for a conversion to code
 * (4.14), then the conversion step.
 */
export function steps(input: {
  readonly area: OwnTeam.Area
  readonly shape: Shape
  readonly mode: OwnTeam.StepMode
  readonly by: OwnTeam.Op["by"]
  /** The proposal item (`ops/2`) for the card's `skipped` line. */
  readonly item?: string
  /** Nothing leaves the folder ({@link Checked.quiet}): the owner conversation stays. */
  readonly quiet?: boolean
}): ReadonlyArray<Steps.Spec> {
  const area = input.area
  const from = area.owner.sessionID
  const rotation =
    input.shape === "code" && from !== null && input.quiet !== true
      ? Rotation.steps({
          areaID: area.id,
          from,
          directory: area.directory,
          reason: "worktree",
          // An owner that never got the team is replaced only with a program handoff (T2.15).
          handoff: area.owner.attached ? "warm" : "program",
          by: input.by,
        })
      : { prepare: [], replace: [] }
  const args = { areaID: area.id, ...(input.item === undefined ? {} : { item: input.item }) }
  return [
    ...(input.mode === "confirm"
      ? [{ kind: ASK, mode: "confirm" as const, args: { ...args, shape: input.shape } }]
      : []),
    ...rotation.prepare,
    ...rotation.replace,
    { kind: STEP[input.shape], mode: "auto", args },
  ]
}

/** `area.convert` as an op of its own (06 §8.2): {@link check}, then a `reorg` op of {@link steps} (undoable). */
export async function start(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly shape: Shape
    readonly by: OwnTeam.Op["by"]
  },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  const active = await services.journal.active(team.id)
  if (active) return busy(active)
  const checked = await check({ team, area, shape: input.shape })
  if (!checked.ok) return checked
  register(services)
  const started = await services.runner.start({
    teamID: team.id,
    kind: "reorg",
    by: input.by,
    areaID: area.id,
    steps: steps({ area, shape: input.shape, mode: checked.mode, by: input.by, quiet: checked.quiet }),
    undo: { available: true },
  })
  if (!started.ok) return busy(started.op)
  return { ok: true, opID: started.op.id }
}

/**
 * The steps that undo a conversion op (8.2 되돌리기): a conversion to code is undone by `sparse-checkout disable`
 * (a confirm), a conversion to full by converting back (with its rotation). `undefined` when the op converted nothing;
 * a failure when the area cannot be converted back now (it has work in a leaving folder, it is broken, …).
 */
export async function undo(
  services: Services.Context,
  input: { readonly op: OwnTeam.Op; readonly by: OwnTeam.Op["by"] },
): Promise<Services.Result<{ readonly steps: ReadonlyArray<Steps.Spec> }> | undefined> {
  const done = input.op.steps.findLast(
    (step) => (step.kind === STEP.code || step.kind === STEP.full) && step.state === "done",
  )
  const args = done === undefined ? undefined : Option.getOrUndefined(decodeArgs(done.args))
  if (!done || !args) return undefined
  const shape: Shape = done.kind === STEP.code ? "full" : "code"
  const [team, area] = await Promise.all([
    services.registry.teams.get(input.op.teamID),
    services.registry.areas.get(input.op.teamID, args.areaID),
  ])
  if (!team || !area) return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: args.areaID })
  const checked = await check({ team, area, shape })
  if (!checked.ok) return checked
  return { ok: true, steps: steps({ area, shape, mode: checked.mode, by: input.by, quiet: checked.quiet }) }
}

/** Registers `convert-confirm`, `convert-to-code` and `convert-to-full` once per controller (before any op runs). */
export function register(services: Services.Context) {
  if (!services.steps.get(ASK)) services.steps.register(ask())
  if (!services.steps.get(STEP.code)) services.steps.register(kind("code"))
  if (!services.steps.get(STEP.full)) services.steps.register(kind("full"))
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const Args = Schema.Struct({ areaID: OwnTeam.AreaID, item: optional(Schema.String) })
type Args = typeof Args.Type
const decodeArgs = Schema.decodeUnknownOption(Args)
const AskArgs = Schema.Struct({ ...Args.fields, shape: Schema.Literals(["code", "full"]) })
const decodeAsk = Schema.decodeUnknownOption(AskArgs)

/**
 * {@link ASK}: the dialog of the conversion (the files it deletes, or the download); answering `do` records it (the
 * runner keeps the confirm on the done step, whose manifest bounds what `convert-to-code` deletes) and lets the held
 * steps run.
 */
function ask(): Steps.Kind {
  return {
    ...Steps.define(ASK, AskArgs, {
      observe: async () => ({ state: "pending" }),
      act: async (_, input) =>
        input.confirmed ? { ok: true } : { ok: false, note: "폴더 바꾸기는 사용자가 확인한 뒤에만 해요" },
      verify: async () => ({ ok: true }),
    }),
    prepare: async (input) => {
      const args = Option.getOrUndefined(decodeAsk(input.step.args))
      const found = args === undefined ? undefined : await load(input, args.areaID)
      if (!args || !found?.ok) return { text: args?.shape === "full" ? "전체 폴더로 바꾸기" : "가벼운 폴더로 바꾸기" }
      return args.shape === "code" ? prepareCode(found.team, found.area) : prepareFull(found.area)
    },
    holds: true,
  }
}

function kind(shape: Shape): Steps.Kind {
  const defined = Steps.define(STEP[shape], Args, {
    observe: (args, input) => observe(shape, args, input),
    act: (args, input) => (shape === "code" ? toCode(args, input) : toFull(args, input)),
    verify: async (args, input) => {
      const found = await load(input, args.areaID)
      if (!found.ok) return { ok: true }
      const sparse = await sparseOn(found.area.directory)
      return found.area.shape === shape && sparse === (shape === "code")
        ? { ok: true }
        : { ok: false, note: `폴더가 기록과 달리 ${shape === "code" ? "가벼운 폴더" : "전체 폴더"}가 아니에요` }
    },
  })
  return {
    ...defined,
    // An op made before the ask existed has the conversion itself as the confirm step.
    prepare: async (input) => {
      const args = Option.getOrUndefined(decodeArgs(input.step.args))
      const found = args === undefined ? undefined : await load(input, args.areaID)
      if (!found?.ok) return { text: shape === "code" ? "가벼운 폴더로 바꾸기" : "전체 폴더로 바꾸기" }
      return shape === "code" ? prepareCode(found.team, found.area) : prepareFull(found.area)
    },
    reverses: true,
  }
}

/**
 * What the user agreed to for this conversion: the confirm of this step (an op of an older build, where the
 * conversion itself was the confirm step), or of the done {@link ASK} of the area in the op; `undefined` when nothing
 * was confirmed.
 */
function agreed(input: Steps.Input, areaID: OwnTeam.AreaID) {
  if (input.confirmed) return input.step.confirm
  return input.op.steps.find((step) => step.kind === ASK && step.state === "done" && step.args.areaID === areaID)
    ?.confirm
}

async function observe(shape: Shape, args: Args, input: Steps.Input): Promise<Steps.Observed> {
  const found = await load(input, args.areaID)
  if (!found.ok) return found.observed
  const area = found.area
  if (area.shape === shape && (await sparseOn(area.directory)) === (shape === "code")) return { state: "satisfied" }
  if (abandoned(input, area.id)) return skip(input, area, args, shape, "paused", ABANDONED)
  if (area.state === "broken") return { state: "failed", note: `'${area.name}' 영역이 멈춰 있어요` }
  if (!FROM[shape].includes(area.shape)) return { state: "failed", note: refusal(area, shape) }
  if (Direct.kept(area) && input.op.by !== "user") return skip(input, area, args, shape, "paused", PAUSED)
  // 4.9: a full folder is a download; it never runs without the user's confirm (the ask, or this step's own).
  if (shape === "full" && agreed(input, area.id) === undefined)
    return { state: "failed", note: "전체 폴더로 바꾸려면 확인이 필요해요" }
  const safe = await settle(input, area)
  if (safe === undefined) return { state: "failed", note: STOPPED }
  if (!safe.ok) return skip(input, area, args, shape, "busy", SKIPPED)
  return { state: "pending" }
}

/** full → code, steps 2-8 (see the module comment). */
async function toCode(args: Args, input: Steps.Input): Promise<Steps.Outcome> {
  const services = input.services
  const found = await load(input, args.areaID)
  if (!found.ok) return { ok: false, note: GONE }
  const team = found.team
  const area = found.area
  const identity = await Identity.check(area)
  if (!identity.ok) return broke(services, area, identity)
  const kept = await keep(input, team, area)
  if (kept !== undefined) return { ok: false, note: kept }
  const planned = await target(team, area)
  if (!planned.ok) return { ok: false, note: planned.message }

  // The confirm covered exactly the list it showed (8.6 step 3); without one, nothing may be deleted.
  const allowed = agreed(input, area.id)?.manifest ?? Confirm.manifest([])
  const first = await inspect(area, planned.leaving, true)
  if (!first.ok) return { ok: false, note: first.message }
  if (first.dirty.length > 0) return { ok: false, note: dirtyNote(first.dirty) }
  if (Confirm.manifest(first.removed) !== allowed) return { ok: false, note: CHANGED }

  // Step 5: the flag of the new shape (`Symlinks.flag`: code = assume-unchanged); none when the home keeps git's links.
  const wanted = Symlinks.flag("code", team.env.symlinkFix)
  const links = wanted === undefined ? [] : await flagged(area.directory, input.signal)
  const marked =
    wanted === undefined
      ? { ok: true as const }
      : await mark(
          area.directory,
          links.map((link) => link.path),
          wanted,
        )
  if (!marked.ok) return { ok: false, note: marked.message }
  const abort = async (note: string): Promise<Steps.Outcome> => {
    const restored = await restore(area.directory, links)
    if (!restored.ok) services.log.warn("convert_flags_not_restored", { areaID: area.id, message: restored.message })
    return { ok: false, note }
  }

  // 4.7, 8.4: everything again right before `set`.
  const safe = await services.features().safePoint.check({
    teamID: team.id,
    areaID: area.id,
    extended: true,
    signal: input.signal,
  })
  if (!safe.ok) return abort(BUSY)
  const second = await inspect(area, planned.leaving, true)
  if (!second.ok) return abort(second.message)
  if (second.dirty.length > 0 || Confirm.manifest(second.removed) !== allowed) return abort(CHANGED)
  const risky = await Cone.endangered(area.directory, planned.cone)
  if (!risky.ok) return abort(risky.message)
  const unexpected = risky.dirs.filter(
    (dir) => !ownCopy(area, dir) && !second.removed.some((entry) => overlaps(dir, entry.path)),
  )
  if (unexpected.length > 0) return abort(`${KEPT}: ${unexpected.join(", ")}`)

  const unlinked = await unlink(area, planned.leaving)
  const set = await Cone.set(area, planned.cone)
  if (!set.ok && set.error === "broken") return broke(services, area, set)
  if (!set.ok) {
    // The copies that went are written again with the home's flag (the area is still a full folder).
    if (unlinked.length > 0) await Symlinks.refresh(services, { teamID: team.id, areaID: area.id })
    return abort(set.message)
  }
  await record(services, area, "code")
  const folded = await folds(area.directory, planned.leaving)
  if (folded !== undefined) return { ok: false, note: folded }
  const relinked = await Symlinks.refresh(services, { teamID: team.id, areaID: area.id, signal: input.signal })
  if (!relinked.ok) services.log.warn("convert_relink_failed", { areaID: area.id, message: relinked.message })
  input.summary({ kind: "area", areaID: area.id, change: "converted" })
  const bytes = second.removed.reduce((sum, entry) => sum + entry.bytes, 0)
  return second.removed.length === 0
    ? { ok: true }
    : { ok: true, note: `무시된 파일 ${second.removed.length}개(${NeedPaths.size(bytes)})를 지웠어요` }
}

/** code → full (a confirm step): fetch, the safe point again, identity, `sparse-checkout disable`, link copies. */
async function toFull(args: Args, input: Steps.Input): Promise<Steps.Outcome> {
  const services = input.services
  const found = await load(input, args.areaID)
  if (!found.ok) return { ok: false, note: GONE }
  const team = found.team
  const area = found.area
  const identity = await Identity.check(area)
  if (!identity.ok) return broke(services, area, identity)
  const kept = await keep(input, team, area)
  if (kept !== undefined) return { ok: false, note: kept }
  const counted = await weigh(area)
  if (!counted.ok) return { ok: false, note: counted.message }
  // 4.9: `disable` would smudge every missing object one by one; they are fetched in one go first.
  if (counted.missing.count > 0) {
    const fetched = await Lfs.fetch(area.directory, Lfs.includes(counted.dirs, counted.missing.objects), input.signal)
    if (!fetched.ok) return { ok: false, note: NETWORK }
  }
  const safe = await services.features().safePoint.check({
    teamID: team.id,
    areaID: area.id,
    extended: true,
    signal: input.signal,
  })
  if (!safe.ok) return { ok: false, note: BUSY }
  // The T1 review rule holds for `disable` too; with every folder in, it collapses (and so deletes) nothing.
  const trees = await Git.run(["ls-tree", "-d", "-z", "--name-only", "HEAD"], {
    cwd: area.directory,
    worktree: true,
  })
  if (!trees.ok) return { ok: false, note: trees.message }
  const risky = await Cone.endangered(area.directory, Porcelain.fields(trees.stdout))
  if (!risky.ok) return { ok: false, note: risky.message }
  if (risky.dirs.length > 0) return { ok: false, note: `${KEPT}: ${risky.dirs.join(", ")}` }
  const again = await Identity.check(area)
  if (!again.ok) return broke(services, area, again)
  const disabled = await Git.run(["sparse-checkout", "disable"], {
    cwd: area.directory,
    write: true,
    worktree: true,
    signal: input.signal,
  })
  if (!disabled.ok) return { ok: false, note: disabled.message }
  await record(services, area, "full")
  const opened = await opens(area.directory)
  if (opened !== undefined) return { ok: false, note: opened }
  // The links outside the old cone are git's link files now: copies with the home's flag (4.12).
  const relinked = await Symlinks.refresh(services, { teamID: team.id, areaID: area.id, signal: input.signal })
  if (!relinked.ok) services.log.warn("convert_relink_failed", { areaID: area.id, message: relinked.message })
  input.summary({ kind: "area", areaID: area.id, change: "converted" })
  return {
    ok: true,
    note: `큰 파일 폴더 ${counted.dirs.length}개(${NeedPaths.size(counted.bytes)})를 받았어요`,
  }
}

async function prepareCode(team: OwnTeam.Team, area: OwnTeam.Area): Promise<Steps.Prepared> {
  const planned = await target(team, area)
  const seen = planned.ok ? await inspect(area, planned.leaving, false) : planned
  if (!seen.ok) return { text: `'${area.name}' 영역을 가벼운 폴더로 바꿀까요?` }
  const bytes = seen.removed.reduce((sum, entry) => sum + entry.bytes, 0)
  return {
    text:
      seen.removed.length === 0
        ? `'${area.name}' 영역을 가벼운 폴더로 바꿀까요?`
        : `'${area.name}' 영역을 가벼운 폴더로 바꾸면 큰 파일 폴더에 남은 무시된 파일 ${seen.removed.length}개(${NeedPaths.size(bytes)})가 지워져요. 바꿀까요?`,
    bytes,
    files: seen.removed.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    manifest: Confirm.manifest(seen.removed),
  }
}

async function prepareFull(area: OwnTeam.Area): Promise<Steps.Prepared> {
  const counted = await weigh(area)
  if (!counted.ok) return { text: `'${area.name}' 영역을 전체 폴더로 바꿀까요?` }
  return {
    text: `'${area.name}' 영역을 전체 폴더로 바꿀까요? 큰 파일 폴더 ${counted.dirs.length}개를 모두 받아요: 내려받기 ${NeedPaths.size(counted.missing.bytes)}, 디스크 ${NeedPaths.size(counted.bytes)}.`,
    bytes: counted.missing.bytes,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

async function load(input: Steps.Input, areaID: OwnTeam.AreaID) {
  const [team, area] = await Promise.all([
    input.services.registry.teams.get(input.op.teamID),
    input.services.registry.areas.get(input.op.teamID, areaID),
  ])
  if (!team || !area || area.state === "retired" || area.state === "retiring")
    return { ok: false as const, observed: { state: "skip" as const, note: "영역을 찾을 수 없어요" } }
  return { ok: true as const, team, area }
}

/** The rotation of this area in this op was skipped at its start (Main 멈춤): the conversion goes with it. */
function abandoned(input: Steps.Input, areaID: OwnTeam.AreaID) {
  return input.op.steps.some(
    (step) => step.kind === Rotation.KIND.begin && step.state === "skipped" && step.args.areaID === areaID,
  )
}

/** A skipped conversion: a `skipped` card line and the `reorg.skipped` notice (8.1). */
function skip(
  input: Steps.Input,
  area: OwnTeam.Area,
  args: Args,
  shape: Shape,
  why: OwnTeam.SkipReason,
  note: string,
): Steps.Observed {
  const item = args.item ?? STEP[shape]
  input.summary({ kind: "skipped", item, areaID: area.id, why })
  input.services.notices.publish({
    teamID: area.teamID,
    areaID: area.id,
    kind: "reorg.skipped",
    text: `${area.name}: ${note}`,
    data: { item, why },
  })
  return { state: "skip", note }
}

/**
 * The extended safe point (8.4). by:user waits for it (TI-9) and says why on the card (`op.progress`), looking again
 * after every folder event and every {@link Settle.RECHECK_MS}; by:main and by:auto get the answer at once.
 * `undefined` when the controller closes meanwhile.
 */
function settle(input: Steps.Input, area: OwnTeam.Area): Promise<Services.Safe | undefined> {
  return Settle.until(
    input,
    async (report) => {
      const safe = await input.services.features().safePoint.check({
        teamID: area.teamID,
        areaID: area.id,
        extended: true,
        signal: input.signal,
      })
      if (safe.ok || input.op.by !== "user") return safe
      report(Settle.reason("", safe))
      return undefined
    },
    // 바로 진행 (RH-20): the user goes on past the commands left running in the folder.
    { force: async () => ({ ok: true }) },
  )
}

/** TI-14: the folder is not the recorded worktree; the area is `broken` and nothing is written to the folder. */
async function broke(
  services: Services.Context,
  area: OwnTeam.Area,
  failed: { readonly broken: "missing" | "identity"; readonly message: string },
): Promise<Steps.Outcome> {
  const why = failed.broken
  const at = services.clock.now()
  const text =
    why === "missing" ? `'${area.name}' 폴더를 찾을 수 없어요` : `'${area.name}' 폴더의 정보가 맞지 않아 멈췄어요`
  await NeedPaths.update(services, area.teamID, area.id, (current) => ({
    ...current,
    state: "broken",
    broken: { why, at },
    status: { kind: "broken", at, text },
  }))
  services.notices.publish({ teamID: area.teamID, areaID: area.id, kind: "area.broken", text, data: { why } })
  // Kept open like the area reconcile keeps it (same id), so a window opened later still shows it.
  const others = (await services.notices.open(area.teamID)).filter(
    (item) => item.kind === "area.broken" && item.areaID !== area.id,
  )
  await services.notices.keep(area.teamID, "area.broken", [
    ...others,
    { id: `area.broken:${area.id}:${why}`, at, areaID: area.id, kind: "area.broken", text, data: { why } },
  ])
  return { ok: false, note: failed.message }
}

/**
 * TI-8: when HEAD is not the area's branch, the commits only it reaches (`rev-list HEAD --not --branches --remotes
 * --tags`) get a create-only `refs/own/keep/<HEAD>` (a `ref` card line, `detached.kept`). Returns why it failed.
 */
async function keep(input: Steps.Input, team: OwnTeam.Team, area: OwnTeam.Area) {
  const query = { cwd: area.directory, worktree: true }
  const symbolic = await Git.run(["symbolic-ref", "-q", "HEAD"], query)
  if (symbolic.ok && symbolic.stdout.trim() === `refs/heads/${area.branch}`) return undefined
  const [head, only] = await Promise.all([
    Git.run(["rev-parse", "--verify", "HEAD"], query),
    Git.run(["rev-list", "HEAD", "--not", "--branches", "--remotes", "--tags"], query),
  ])
  if (!head.ok) return head.message
  if (!only.ok) return only.message
  const sha = head.stdout.trim()
  if (!Git.isOid(sha) || only.stdout.split("\n").filter(Git.isOid).length === 0) return undefined
  const ref = `refs/own/keep/${sha}`
  const created = await Refs.create(team.commonDir, { ref, oid: sha }, "own.team keep")
  if (!created.ok) return created.message
  input.summary({ kind: "ref", ref, sha })
  if (created.created)
    input.services.notices.publish({
      teamID: team.id,
      areaID: area.id,
      kind: "detached.kept",
      text: "이름 없는 작업 상태를 보관해 뒀어요",
      data: { ref },
    })
  return undefined
}

/**
 * The cone a code-only area gets (4.5: the complement of the heavy folders plus `cone.extra`, over HEAD's folders and
 * the target's, so a heavy folder the target has stays out after the next merge, 4.4) and its leaving folders.
 */
async function target(team: OwnTeam.Team, area: OwnTeam.Area) {
  const query = { cwd: area.directory, worktree: true }
  const [cone, trees] = await Promise.all([
    Cone.compute(area.directory, "HEAD", team.heavy.dirs, Object.keys(area.cone.extra), `refs/heads/${team.target}`),
    Git.run(["ls-tree", "-r", "-d", "-z", "--name-only", "HEAD"], query),
  ])
  if (!cone.ok) return cone
  if (!trees.ok) return { ok: false as const, message: trees.message }
  return { ok: true as const, cone: cone.dirs, leaving: collapsed(Porcelain.fields(trees.stdout), cone.dirs) }
}

/** The folders of the tree that `cone` collapses: neither in it nor around it, inside a folder that stays open. */
function collapsed(trees: ReadonlyArray<string>, cone: ReadonlyArray<string>) {
  const parents = new Set(["", ...cone.flatMap(ancestors)])
  return trees
    .map(Cone.normalize)
    .filter((dir) => dir !== "" && !Cone.covers(cone, dir) && !parents.has(dir) && parents.has(parent(dir)))
    .toSorted()
}

type Inspected =
  | {
      readonly ok: true
      /** Work the conversion may not touch (TI-1): changed, staged and untracked paths, unclean link copies. */
      readonly dirty: ReadonlyArray<string>
      /** Ignored files and folders it deletes (TI-2), largest first. */
      readonly removed: ReadonlyArray<Removed>
    }
  | { readonly ok: false; readonly message: string }

/**
 * Step 4: the leaving folders checked whole (4.7). `write` refreshes the index (at the safe point only), so `set`
 * sees untouched files as clean and folds them. A flagged link copy inside a leaving folder that own never recorded
 * cannot be checked against a record, so it counts as dirty (fail closed); own's clean folder copies show as ignored
 * and are own's, not the user's.
 */
async function inspect(area: OwnTeam.Area, leaving: ReadonlyArray<string>, write: boolean): Promise<Inspected> {
  if (leaving.length === 0) return { ok: true, dirty: [], removed: [] }
  const status = await Git.run(
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--",
      ...leaving.map((dir) => `${dir}/`),
    ],
    { cwd: area.directory, worktree: true, write, env: { GIT_LITERAL_PATHSPECS: "1" } },
  )
  if (!status.ok) return { ok: false, message: status.message }
  const [changed, links] = await Promise.all([Symlinks.dirtyCopies(area, leaving), flagged(area.directory)])
  const recorded = Object.keys(area.linkCopies ?? {})
  const inside = (file: string) => leaving.some((dir) => file.startsWith(`${dir}/`))
  const unverified = links.filter((link) => inside(link.path) && !recorded.includes(link.path))
  const entries = Porcelain.status(status.stdout).entries
  const clean = (file: string) => !changed.some((copy) => copy.path === file)
  const ignored = entries.filter(
    (entry) => entry.kind === "ignored" && !(ownCopy(area, entry.path) && clean(strip(entry.path))),
  )
  const removed = await Promise.all(ignored.map((entry) => measure(area.directory, entry.path)))
  return {
    ok: true,
    dirty: [
      ...new Set([
        ...entries.filter((entry) => entry.kind !== "ignored").map((entry) => entry.path),
        ...changed.map((copy) => copy.path),
        ...unverified.map((link) => link.path),
      ]),
    ],
    removed: removed.toSorted((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)),
  }
}

/**
 * Own's copies inside the leaving folders go right before `set` (they were just checked clean against their record, so
 * nothing but a copy of a tracked file is lost): `set` keeps a file whose content is not its blob ("not up to date …
 * left despite sparse patterns", Git 2.55) whatever its flag, and a copy left in a folded folder would expand the
 * sparse index at the next status (4.9). Links are not followed.
 */
async function unlink(area: OwnTeam.Area, leaving: ReadonlyArray<string>) {
  const copies = Object.keys(area.linkCopies ?? {}).filter((copy) => leaving.some((dir) => copy.startsWith(`${dir}/`)))
  await Promise.all(
    copies.map((copy) => fs.rm(path.join(area.directory, ...copy.split("/")), { recursive: true, force: true })),
  )
  return copies
}

/** A recorded folder copy (or a path inside one): own's copy, ignored through `info/exclude` (4.12). */
function ownCopy(area: OwnTeam.Area, file: string) {
  const item = strip(file)
  return Object.keys(area.linkCopies ?? {}).some((copy) => item === copy || item.startsWith(`${copy}/`))
}

/** What a path takes on disk: a file's size, a folder's files (links not followed); the newest mtime. */
async function measure(directory: string, file: string): Promise<Removed> {
  const at = path.join(directory, ...strip(file).split("/"))
  const stat = await fs.lstat(at).catch(() => undefined)
  if (!stat?.isDirectory()) return { path: file, bytes: stat?.size ?? 0, mtime: stat?.mtimeMs ?? 0 }
  const entries = await fs.readdir(at, { recursive: true, withFileTypes: true }).catch(() => [])
  const stats = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => fs.lstat(path.join(entry.parentPath, entry.name)).catch(() => undefined)),
  )
  return {
    path: file,
    bytes: stats.reduce((sum, item) => sum + (item?.size ?? 0), 0),
    mtime: stats.reduce((latest, item) => Math.max(latest, item?.mtimeMs ?? 0), stat.mtimeMs),
  }
}

/** A mode-120000 entry with its `ls-files -v` tag. */
interface Link {
  readonly path: string
  readonly tag: string
}

/**
 * The link entries that carry an index flag (`S`/`s` skip-worktree, lower case assume-unchanged): the copies own or
 * the user flagged. In a full area every skip-worktree bit is a hand-set one (no sparse checkout).
 */
async function flagged(directory: string, signal?: AbortSignal): Promise<Link[]> {
  const listed = await Git.run(["ls-files", "-s", "-v", "-z"], { cwd: directory, worktree: true, signal })
  if (!listed.ok) return []
  return Porcelain.fields(listed.stdout).flatMap((line) => {
    const match = /^(\S) 120000 [0-9a-f]{40,64} 0\t(.+)$/s.exec(line)
    if (!match) return []
    const tag = match[1]
    return skipWorktree(tag) || assumeUnchanged(tag) ? [{ tag, path: match[2] }] : []
  })
}

/** Step 5: `wanted` set on `paths` and the other flag cleared (`update-index -z --stdin`). */
async function mark(
  directory: string,
  paths: ReadonlyArray<string>,
  wanted: Symlinks.Flag,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const other: Symlinks.Flag = wanted === "skip-worktree" ? "assume-unchanged" : "skip-worktree"
  return flags(directory, [
    { flag: `--${wanted}`, paths },
    { flag: `--no-${other}`, paths },
  ])
}

/** The flags `links` had before {@link mark} (an abort puts them back). */
function restore(directory: string, links: ReadonlyArray<Link>) {
  const split = (test: (tag: string) => boolean) => ({
    on: links.filter((link) => test(link.tag)).map((link) => link.path),
    off: links.filter((link) => !test(link.tag)).map((link) => link.path),
  })
  const skip = split(skipWorktree)
  const assume = split(assumeUnchanged)
  return flags(directory, [
    { flag: "--skip-worktree", paths: skip.on },
    { flag: "--no-skip-worktree", paths: skip.off },
    { flag: "--assume-unchanged", paths: assume.on },
    { flag: "--no-assume-unchanged", paths: assume.off },
  ])
}

async function flags(
  directory: string,
  changes: ReadonlyArray<{ readonly flag: string; readonly paths: ReadonlyArray<string> }>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const failure = await changes
    .filter((change) => change.paths.length > 0)
    .reduce<Promise<string | undefined>>(async (before, change) => {
      const earlier = await before
      if (earlier !== undefined) return earlier
      const result = await Git.run(["update-index", change.flag, "-z", "--stdin"], {
        cwd: directory,
        worktree: true,
        write: true,
        stdin: Git.nul(change.paths),
      })
      return result.ok ? undefined : `update-index ${change.flag}: ${result.message}`
    }, Promise.resolve(undefined))
  return failure === undefined ? { ok: true } : { ok: false, message: failure }
}

/** The area record after a conversion: its new shape; nothing is kept back any more (`cone.extra` stays for later). */
function record(services: Services.Context, area: OwnTeam.Area, shape: Shape) {
  return NeedPaths.update(services, area.teamID, area.id, (current) => ({
    ...current,
    shape,
    cone: { extra: current.cone.extra, kept: {} },
  }))
}

/** Step 8: why the folder is not code-only as planned, or `undefined` (`ls-files --sparse -t`, index.sparse, status). */
async function folds(directory: string, leaving: ReadonlyArray<string>) {
  const query = { cwd: directory, worktree: true }
  const [sparse, listed, status] = await Promise.all([
    Git.run(["config", "--worktree", "--get", "index.sparse"], query),
    Git.run(["ls-files", "--sparse", "-t", "-z"], query),
    Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=no"], query),
  ])
  if (!sparse.ok || sparse.stdout.trim() !== "true") return "작업 폴더에 index.sparse가 켜져 있지 않아요"
  if (!listed.ok) return listed.message
  if (!status.ok) return status.message
  const folded = new Set(
    Porcelain.fields(listed.stdout)
      .filter((entry) => entry.startsWith("S ") && entry.endsWith("/"))
      .map((entry) => entry.slice(2, -1)),
  )
  const open = leaving.filter((dir) => !folded.has(dir))
  if (open.length > 0) return `큰 파일 폴더가 접혀 있지 않아요: ${open.join(", ")}`
  return changes(status.stdout, leaving)
}

/**
 * Why tracked status says the conversion went wrong, or `undefined`: a type change (a link copy git now sees as a
 * 120000 → 100644 change, 4.12) or a change inside a folded folder. Changes the user made in the cone stay as they were.
 */
function changes(stdout: string, folded: ReadonlyArray<string>) {
  const wrong = Porcelain.status(stdout).entries.filter(
    (entry) => ("xy" in entry && entry.xy.includes("T")) || folded.some((dir) => entry.path.startsWith(`${dir}/`)),
  )
  return wrong.length === 0
    ? undefined
    : `파일 종류가 바뀌었거나 접힌 폴더의 파일이 바뀌었어요: ${wrong
        .slice(0, 5)
        .map((entry) => entry.path)
        .join(", ")}`
}

/** Why the folder is not a full folder after `disable`, or `undefined`. */
async function opens(directory: string) {
  const query = { cwd: directory, worktree: true }
  const [listed, status] = await Promise.all([
    Git.run(["ls-files", "--sparse", "-z"], query),
    Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=no"], query),
  ])
  if (await sparseOn(directory)) return "아직 가벼운 폴더예요(sparse-checkout)"
  if (!listed.ok) return listed.message
  if (!status.ok) return status.message
  const folded = Porcelain.sparseDirectories(listed.stdout)
  if (folded.length > 0) return `아직 접힌 폴더가 있어요: ${folded.join(", ")}`
  return changes(status.stdout, [])
}

/** The folded folders of a code-only area and what checking them out writes and downloads (4.4, 4.6). */
async function weigh(area: OwnTeam.Area) {
  const [listed, cone] = await Promise.all([
    Git.run(["ls-files", "--sparse", "-z"], { cwd: area.directory, worktree: true }),
    Cone.list(area.directory),
  ])
  if (!listed.ok) return { ok: false as const, message: listed.message }
  if (!cone.ok) return cone
  const dirs = Porcelain.sparseDirectories(listed.stdout)
  const counted = await NeedPaths.count(area.directory, dirs, cone.dirs)
  if (!counted.ok) return counted
  return { ...counted, dirs }
}

/** `core.sparseCheckout` is on for the worktree (its own config, else the repository's). */
async function sparseOn(directory: string) {
  const result = await Git.run(["config", "--type=bool", "--get", "core.sparseCheckout"], {
    cwd: directory,
    worktree: true,
  })
  return result.ok && result.stdout.trim() === "true"
}

function refusal(area: OwnTeam.Area, shape: Shape) {
  if (area.shape === shape) return `'${area.name}' 영역은 이미 ${shape === "code" ? "가벼운 폴더" : "전체 폴더"}예요`
  if (area.shape === "plain" && shape === "full")
    return `'${area.name}' 영역은 큰 파일 폴더를 나누지 않는 폴더라 바꿀 수 없어요`
  return `'${area.name}' 영역은 ${shape === "code" ? "전체 폴더" : "가벼운 폴더"}가 아니에요`
}

/** A Git that cannot do it, as the error enable answers (06 §4.2). */
function versionFailure(check: Extract<GitVersion.Check, { ok: false }>, directory: string): Services.Failure {
  if (check.error === "git_too_old")
    return Services.failure("git_too_old", check.message, {
      version: /Git (\S+)/.exec(check.message)?.[1] ?? "unknown",
      minimum: `${GitVersion.MINIMUM.major}.${GitVersion.MINIMUM.minor}`,
    })
  if (check.error === "lfs_missing")
    return Services.failure("lfs_missing", check.message, { tool: "git-lfs", version: null })
  return Services.failure("not_git", check.message, { directory })
}

function invalid(item: string, why: string) {
  return Services.failure("invalid_proposal", why, { rejected: [{ item, why }] })
}

function busy(op: OwnTeam.Op) {
  return Services.failure("busy", "another team op is running", Journal.busy(op))
}

function dirtyNote(paths: ReadonlyArray<string>) {
  const shown = paths.slice(0, 5).join(", ")
  return `큰 파일 폴더에 아직 저장 지점에 넣지 않은 작업이 있어 폴더를 바꾸지 않았어요: ${shown}${paths.length > 5 ? ` 외 ${paths.length - 5}개` : ""}`
}

/** `a` is `b`, or one holds the other (paths with `/`; a folder may end with `/`). */
function overlaps(a: string, b: string) {
  const x = strip(a)
  const y = strip(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

function strip(file: string) {
  return file.endsWith("/") ? file.slice(0, -1) : file
}

function skipWorktree(tag: string) {
  return tag === "S" || tag === "s"
}

/** `ls-files -v` prints lower case tags for assume-unchanged entries. */
function assumeUnchanged(tag: string) {
  return tag !== tag.toUpperCase()
}

/** `a/b/c` → `a/b`; a top-level entry → `""`. */
function parent(item: string) {
  const slash = item.lastIndexOf("/")
  return slash < 0 ? "" : item.slice(0, slash)
}

/** `a/b/c` → `[a, a/b]` (proper ancestors, root excluded). */
function ancestors(item: string) {
  const parts = item.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}
