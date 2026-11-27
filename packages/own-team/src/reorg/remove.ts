export * as Remove from "./remove.js"

import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../assets/need-paths.js"
import { Symlinks } from "../assets/symlinks.js"
import { Classify } from "../git/classify.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import { Confirm } from "../ops/confirm.js"
import { Steps } from "../ops/steps.js"
import { Teams } from "../registry/team.js"
import type { Services } from "../services.js"

/**
 * Removing an area's work folder (06 §8.6, TI-1–TI-3, TI-8, TI-12, TI-14). `git worktree remove` alone is not safe: it
 * deletes ignored files without a word, takes a nested worktree's uncommitted work along when it sits in an ignored
 * folder (exit 0), and on Windows a process whose current folder is inside makes it delete most of the folder, drop the
 * registration and exit 255. So the `retire-remove` confirm step goes:
 *
 *   1 scan     the folder is the recorded worktree (TI-14); tracked status is clean and every link copy is as recorded
 *              (`Symlinks.dirtyCopies`, the one link-copy check; own's clean folder copies show as `!` and are not the
 *              user's files, as in undo); no other `.git` below its own, found by a walk that never follows a link
 *              (a nested worktree, an independent repository in an ignored `vendor/lib`); the walk stays within its
 *              budget (a partial walk refuses, as the T0 cleanup's `refuse-partial`); own's lock or none
 *   2 list     ignored entries that can be made again (tool caches, dependencies, build output) and irreplaceable ones
 *              too large to keep are the dialog's list with their sizes; its hash (paths, sizes, mtimes, file counts)
 *              is `StepConfirm.manifest`, which the nonce is bound to. Small irreplaceable files (`.env*`, `*.local`,
 *              editor settings; at most {@link LIMITS} `keepBytes` together) are not asked about: right before the
 *              removal they go to `<records>/retired/<slug>/` (copied there, then deleted with the folder), so `두기`
 *              leaves the folder whole
 *   3 again    right before deleting, the folder is scanned again; another list fails the step and deletes nothing
 *              (the runner already asks again with the new list when it differs at the answer, 8.6 step 3)
 *   4 remove   detached commits keep-ref'd (TI-8, `refs/own/keep/<HEAD>`); the removal record written ahead
 *              (`<records>/retired/<slug>.removal.json`); own's links deleted first without following them (every
 *              link inside an ignored entry or a copy, the link copies, the shared-folder links through
 *              {@link Options.unlink}); the identity checked again; `git worktree unlock` (TI-12: only now); `git
 *              worktree remove` without `--force`
 *   5 leftover a folder left half removed (Windows) is cleared only when every item left was on the confirmed list
 *              (ignored entries, own copies and HEAD's files, none changed after the list was taken); otherwise the
 *              step fails ({@link IN_USE} while something holds it) and a later run asks again or clears it
 *   6 after    `worktree.refresh{projectID}`, the area recorded `retired`, `Symlinks.unexclude` for its folder copies,
 *              the area's `link.copy.dirty` notice closed, the removal record deleted
 *
 * The branch and the conversations stay (TI-4, TI-5). Every phase observes first, so a restart resumes where the folder
 * is (TI-11). A refused folder is kept: the step is skipped with the reason, an `area touched` card line and, for an
 * edited link copy, the lasting `link.copy.dirty` notice (`Notices.keep`).
 */

/** The confirm step kind (own-web labels it and treats it as a removal, `team/confirm.tsx`). */
export const KIND = "retire-remove"

export const IN_USE = "다른 프로그램이 폴더를 쓰고 있어요. 그 프로그램을 닫은 뒤 다시 시도하세요"
export const NESTED = "다른 저장소가 들어 있어요(저장하지 않은 작업이 있을 수 있음)"

export interface Limits {
  /** Directory entries the walk reads; past it the scan is partial and the removal refused (TI-3 (b)). */
  readonly entries: number
  /** Time for the walk and the sizing, in milliseconds. */
  readonly ms: number
  /** Small irreplaceable ignored files kept in the team records, at most this many bytes together (8.6 step 2). */
  readonly keepBytes: number
}

/** A worktree with `node_modules` has about 200k entries, which the batched walk reads in one to three seconds. */
export const LIMITS: Limits = { entries: 500_000, ms: 20_000, keepBytes: 50 * 1024 * 1024 }

/** Runs one git command; a test passes a spy around `Git.run` that records the argument lists. */
export type Runner = (args: readonly string[], options: Git.Options) => Promise<Git.Result>

/**
 * Removes the shared-folder link `name` (a repository path) inside `directory` without following it (06 §4.11). T3.15
 * passes `Shared.unlink`; the default removes it only when `lstat` finds a link.
 */
export type Unlink = (link: { readonly directory: string; readonly name: string }) => Promise<void>

export interface Options {
  readonly unlink?: Unlink
  readonly git?: Runner
  readonly limits?: Partial<Limits>
}

/** An ignored entry (`node_modules/`, `.env`) or a leftover file, repository-relative with `/`. */
export interface Item {
  readonly path: string
  readonly bytes: number
  /** The newest modification time inside, in milliseconds. */
  readonly mtime: number
  readonly files: number
}

export type Refusal = "identity" | "nested" | "dirty" | "partial" | "locked" | "git"

export type Scan =
  /** No folder (removed already, or a `missing` area). */
  | { readonly kind: "gone"; readonly entry: Porcelain.Worktree | undefined }
  | {
      readonly kind: "refused"
      readonly why: Refusal
      readonly message: string
      /** Edited link copies (the `link.copy.dirty` notice). */
      readonly copies: ReadonlyArray<Symlinks.Dirty>
    }
  | {
      readonly kind: "ready"
      readonly entry: Porcelain.Worktree
      /** What the dialog lists and the removal deletes, largest first. */
      readonly remove: ReadonlyArray<Item>
      /**
       * The part of {@link remove} that cannot be made again (not a tool cache, dependency or build output) and is too
       * large to keep in the team records: the dialog names it apart (8.6 step 2).
       */
      readonly lost: ReadonlyArray<Item>
      /** Small irreplaceable entries copied to the team records first. */
      readonly keep: ReadonlyArray<Item>
      /** Links inside ignored entries and own's copies, deleted first without following them. */
      readonly links: ReadonlyArray<string>
      /** Own's link copies on disk (`area.linkCopies`, all as recorded), deleted right after those links. */
      readonly copies: ReadonlyArray<string>
      /** Shared-folder links (`team.shared` names), deleted through {@link Options.unlink}. */
      readonly shared: ReadonlyArray<string>
      /** Every ignored entry the list covers (removed, kept, own copies, links), for a half removal (step 5). */
      readonly covered: ReadonlyArray<string>
      readonly manifest: string
      readonly bytes: number
    }
  /** Half removed: no `.git`, no registration (or a prunable one), items left. */
  | {
      readonly kind: "leftover"
      readonly items: ReadonlyArray<Item>
      readonly dirs: ReadonlyArray<string>
      /** Every item was on the confirmed list (the removal record) and none changed since. */
      readonly within: boolean
      readonly manifest: string
      readonly bytes: number
    }

/**
 * The `retire-remove` step of an area: `confirm` (the default), or `auto` to clear a half removal already confirmed.
 * `unapplied`: the save points of the area the target lacks when it was planned, the dialog's `남는 것` line (8.2).
 */
export function spec(
  areaID: OwnTeam.AreaID,
  mode: OwnTeam.StepMode = "confirm",
  unapplied?: number,
): Steps.Spec & { readonly id: string } {
  return {
    id: `retire:${areaID}:remove`,
    kind: KIND,
    mode,
    args: { areaID, ...(unapplied === undefined || unapplied === 0 ? {} : { unapplied }) },
  }
}

/** Registers `retire-remove` once per controller (retire and merge both plan it). */
export function register(services: Services.Context, options: Options = {}) {
  if (!services.steps.get(KIND)) services.steps.register(kind(options))
}

/** `<records>/retired/<slug>/`: the small files a removal keeps (06 §8.6 step 2). */
export function retiredFolder(team: Pick<OwnTeam.Team, "id" | "commonDir">, areaID: OwnTeam.AreaID) {
  return path.join(Teams.records(team), "retired", slugOf(areaID))
}

/**
 * The area as `retired` (8.2 끝내기): out of the team view, its branch and conversations kept. Its peers (동료) are
 * dropped; their conversations stay the user's and the registry refuses their team tools. Direct work ends with it.
 */
export function retired(area: OwnTeam.Area, at: number): OwnTeam.Area {
  const { broken: _broken, peers: _peers, directWork: _directWork, ...rest } = area
  return { ...rest, state: "retired", status: { kind: "retired", at, text: "" } }
}

/**
 * TI-8: when HEAD is not the area's branch (a detached HEAD, or an adopted area whose name is deferred), the commits only
 * it holds are kept by `refs/own/keep/<HEAD>` (create-only, in the common dir, as `enable.keep` and the reconcile do).
 * `ref` is set when such commits exist; `created` when this call made the ref.
 */
export async function keep(
  team: Pick<OwnTeam.Team, "commonDir">,
  area: Pick<OwnTeam.Area, "branch" | "deferredName">,
  entry: Porcelain.Worktree | undefined,
): Promise<
  | { readonly ok: true; readonly kept?: { readonly ref: string; readonly sha: string; readonly created: boolean } }
  | { readonly ok: false; readonly message: string }
> {
  const head = entry?.head
  if (head === undefined || !Git.isOid(head)) return { ok: true }
  if (entry?.branch === `refs/heads/${area.branch}` && area.deferredName !== true) return { ok: true }
  const unique = await Git.run(["rev-list", head, "--not", "--branches", "--remotes", "--tags"], {
    cwd: team.commonDir,
    worktree: true,
  })
  if (!unique.ok) return { ok: false, message: unique.message }
  if (!unique.stdout.split("\n").some(Git.isOid)) return { ok: true }
  const ref = `refs/own/keep/${head}`
  const created = await Refs.create(team.commonDir, { ref, oid: head }, "own.team keep")
  if (!created.ok) return { ok: false, message: created.message }
  return { ok: true, kept: { ref, sha: head, created: created.created } }
}

/**
 * Commits of the area not in the team's target (`반영하지 않은 저장 지점 n개`): its branch, or HEAD when the branch is
 * missing or its name deferred. `undefined` when git cannot tell.
 */
export async function unapplied(
  team: Pick<OwnTeam.Team, "commonDir" | "target">,
  area: Pick<OwnTeam.Area, "branch" | "deferredName" | "base">,
  head: string | undefined,
) {
  const branch = area.deferredName === true ? null : await Refs.read(team.commonDir, `refs/heads/${area.branch}`)
  const tip = branch ?? head
  if (tip === undefined || !Git.isOid(tip)) return undefined
  const target = await Refs.read(team.commonDir, `refs/heads/${team.target}`)
  const counted = await Git.run(["rev-list", "--count", tip, "--not", target ?? area.base.sha], {
    cwd: team.commonDir,
    worktree: true,
  })
  const count = counted.ok ? Number(counted.stdout.trim()) : Number.NaN
  return Number.isInteger(count) ? count : undefined
}

/** Steps 1-2 and the half-removal check of step 5: what the folder holds now. Reads only. */
export async function scan(input: {
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly options?: Options
}): Promise<Scan> {
  const team = input.team
  const area = input.area
  const limits = { ...LIMITS, ...input.options?.limits }
  const run = input.options?.git ?? Git.run
  const listed = await Worktree.list(team.commonDir)
  if (!listed.ok) return refused("git", listed.message)
  const entry = listed.worktrees.find((item) => Identity.same(item.path, area.directory))
  if (!(await present(area.directory))) return { kind: "gone", entry }
  if (!(await present(path.join(area.directory, ".git"))) && (entry === undefined || entry.prunable !== undefined))
    return leftover(team, area, limits)
  if (entry === undefined) return refused("identity", `이 저장소의 작업 폴더가 아니에요: ${area.directory}`)
  if (entry.locked !== undefined && !Classify.ownLock(entry.locked))
    return refused("locked", `다른 이유로 잠긴 폴더라 지우지 않았어요: ${entry.locked}`)
  const identity = await identify(run, area)
  if (!identity.ok) return refused("identity", `이 폴더의 정보가 맞지 않아 멈췄어요: ${identity.message}`)
  const [status, copies] = await Promise.all([
    run(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching"], {
      cwd: area.directory,
      worktree: true,
    }),
    Symlinks.dirtyCopies(area),
  ])
  if (!status.ok) return refused("git", status.message)
  const entries = Porcelain.status(status.stdout).entries
  const ignored = entries.flatMap((item) => (item.kind === "ignored" ? [item.path] : []))
  const work = entries.filter((item) => item.kind !== "ignored")
  // A clean folder copy is excluded through `info/exclude` (it shows as `!` when git lists it at all): own's copy, not
  // the user's file. The walk notes the links inside the copies too.
  const owned = Object.keys(area.linkCopies ?? {})
  const walked = await walk(area.directory, [...ignored, ...owned], limits)
  const nested = [
    ...listed.worktrees
      .filter((item) => item !== entry && item.prunable === undefined && Identity.inside(area.directory, item.path))
      .map((item) => item.path),
    ...walked.nested.map((relative) => native(area.directory, relative)),
  ]
  if (nested.length > 0) return refused("nested", `${NESTED}: ${nested.slice(0, 3).join(", ")}`)
  if (!walked.complete) return refused("partial", "폴더를 다 살펴보지 못해 지우지 않았어요")
  if (work.length > 0)
    return refused(
      "dirty",
      `아직 저장 지점에 넣지 않은 변경 ${work.length}개가 있어 폴더를 지우지 않았어요: ${work
        .slice(0, 3)
        .map((item) => item.path)
        .join(", ")}`,
    )
  if (copies.length > 0)
    return refused("dirty", `바로 가기 파일 사본 ${copies.length}개가 원래 내용과 달라 폴더를 지우지 않았어요`, copies)

  const own = (file: string) => owned.some((copy) => covers(copy, file))
  const names = new Set(team.shared.map((item) => key(trim(item.name))))
  const shared = walked.links.filter(
    (link) => link.entry !== undefined && names.has(key(trim(link.path))) && covers(link.entry, link.path),
  )
  const sharedKeys = new Set(shared.map((link) => key(trim(link.path))))
  const items = ignored
    .filter((item) => !own(item) && !sharedKeys.has(key(trim(item))))
    .map((item): Item => ({ path: item, ...(walked.sizes.get(item) ?? { bytes: 0, mtime: 0, files: 0 }) }))
  const others = items.filter((item) => !regenerable(item.path)).toSorted((a, b) => a.bytes - b.bytes)
  const kept = others.reduce<{ readonly total: number; readonly items: ReadonlyArray<Item> }>(
    (state, item) =>
      state.total + item.bytes <= limits.keepBytes
        ? { total: state.total + item.bytes, items: [...state.items, item] }
        : state,
    { total: 0, items: [] },
  ).items
  const remove = items.filter((item) => !kept.includes(item)).toSorted((a, b) => b.bytes - a.bytes)
  return {
    kind: "ready",
    entry,
    remove,
    lost: others.filter((item) => !kept.includes(item)).toSorted((a, b) => b.bytes - a.bytes),
    keep: kept,
    links: walked.links.flatMap((link) =>
      link.entry !== undefined && !sharedKeys.has(key(trim(link.path))) ? [link.path] : [],
    ),
    // Every recorded copy is on disk as recorded: `dirtyCopies` found none changed or gone.
    copies: owned,
    shared: shared.map((link) => trim(link.path)),
    // A folder copy over a link entry may not show in `status` at all; its files are own's all the same.
    covered: [...ignored, ...owned],
    manifest: Confirm.manifest(remove),
    bytes: remove.reduce((sum, item) => sum + item.bytes, 0),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The step kind

const Args = Schema.Struct({ areaID: OwnTeam.AreaID, unapplied: optional(NonNegativeInt) })
const decodeArgs = Schema.decodeUnknownOption(Args)

const NOTICE = "link.copy.dirty" as const
const UNCONFIRMED = "확인하지 않은 항목이 남아 있어 지우지 않았어요. 끝내기를 다시 하면 그 목록을 물어요"
const CHANGED = "확인한 뒤 목록이 바뀌어 지우지 않았어요. 새 목록을 확인하세요"
const WORKING = "이 폴더에서 일하는 대화나 터미널이 있어 지우지 않았어요"

function kind(options: Options): Steps.Kind {
  const defined = Steps.define(KIND, Args, {
    observe: async (args, input) => {
      const found = await load(input.services, input.op.teamID, args.areaID)
      if (!found) return { state: "skip", note: "영역이 없어 건너뛰었어요" }
      const scanned = await scan({ ...found, options })
      if (scanned.kind === "gone")
        return found.area.state === "retired" && !(await present(recordFile(found.team, found.area.id)))
          ? { state: "satisfied", note: "폴더가 이미 없어요" }
          : { state: "pending" }
      if (scanned.kind === "refused") {
        await keptFolder(input, found.area, scanned)
        return { state: "skip", note: scanned.message }
      }
      if (scanned.kind === "leftover")
        return scanned.within || input.confirmed ? { state: "pending" } : { state: "skip", note: UNCONFIRMED }
      return input.confirmed ? { state: "pending" } : { state: "skip", note: "지우려면 확인이 필요해요" }
    },
    act: async (args, input) => {
      const services = input.services
      const found = await load(services, input.op.teamID, args.areaID)
      if (!found) return DONE
      const team = found.team
      const area = found.area
      const scanned = await scan({ ...found, options })
      if (scanned.kind === "gone") return finish(input, team, area)
      if (scanned.kind === "refused") return { ok: false, note: scanned.message }
      if (!(await quiet(services, team, area))) return { ok: false, note: WORKING }
      if (scanned.kind === "leftover") {
        const confirmed = input.confirmed && scanned.manifest === input.step.confirm?.manifest
        if (!scanned.within && !confirmed) return { ok: false, note: UNCONFIRMED }
        return (await clear(area.directory, scanned)) ? finish(input, team, area) : { ok: false, note: IN_USE }
      }
      if (!input.confirmed || scanned.manifest !== input.step.confirm?.manifest) return { ok: false, note: CHANGED }
      return remove(input, options, team, area, scanned)
    },
    verify: async (args, input) => {
      const found = await load(input.services, input.op.teamID, args.areaID)
      if (!found) return DONE
      const listed = await Worktree.list(found.team.commonDir)
      // A registration whose folder is gone (prunable) is git's to drop; own never prunes other entries (TI-6).
      const registered =
        !listed.ok ||
        listed.worktrees.some((item) => item.prunable === undefined && Identity.same(item.path, found.area.directory))
      if ((await present(found.area.directory)) || registered) return { ok: false, note: "폴더가 남아 있어요" }
      return found.area.state === "retired" ? DONE : { ok: false, note: "영역이 끝난 것으로 적히지 않았어요" }
    },
  })
  return {
    ...defined,
    prepare: async (input) => {
      const args = Option.getOrUndefined(decodeArgs(input.step.args))
      if (!args) throw new Error(`단계의 값이 맞지 않아요: ${KIND}`)
      const found = await load(input.services, input.op.teamID, args.areaID)
      if (!found) throw new Error(`영역이 아니에요: ${args.areaID}`)
      const scanned = await scan({ ...found, options })
      // A folder that cannot be removed (the planning scan did not see why, or a merge's B, which is planned without
      // one) has nothing to ask: the step runs unconfirmed and its observe records why the folder stays.
      if (scanned.kind === "refused") return { text: scanned.message, auto: true }
      const area = found.area
      if (scanned.kind === "gone")
        return { text: `'${area.name}' 폴더는 이미 없어요`, files: [], manifest: Confirm.manifest([]) }
      if (scanned.kind === "leftover")
        return {
          text: `'${area.name}' 폴더에 남은 항목 ${scanned.items.length}개를 지울까요?`,
          bytes: scanned.bytes,
          files: scanned.items.map((item) => ({ path: native(area.directory, trim(item.path)), bytes: item.bytes })),
          manifest: scanned.manifest,
        }
      const files = scanned.remove.map((item) => ({
        path: native(area.directory, trim(item.path)),
        bytes: item.bytes,
        ...(scanned.lost.includes(item) ? { irreplaceable: true } : {}),
      }))
      return { text: question(area, scanned), bytes: scanned.bytes, files, manifest: scanned.manifest }
    },
  }
}

const DONE: Steps.Outcome = { ok: true }

async function load(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID) {
  const [team, area] = await Promise.all([
    services.registry.teams.get(teamID),
    services.registry.areas.get(teamID, areaID),
  ])
  return team && area ? { team, area } : undefined
}

/**
 * The dialog's sentence (06 §8.6 step 2): what is kept, what can be made again, and apart from it what cannot (an
 * ignored dataset or secrets folder too large to keep in the team records). The save points the target lacks are the
 * dialog's `남는 것` line, from the step's `unapplied` (8.2).
 */
function question(area: OwnTeam.Area, scanned: Extract<Scan, { kind: "ready" }>) {
  const lostBytes = scanned.lost.reduce((sum, item) => sum + item.bytes, 0)
  const regenerable = scanned.bytes - lostBytes
  return [
    `'${area.name}' 폴더를 지울까요?`,
    ...(scanned.keep.length === 0 ? [] : [`설정 파일 ${scanned.keep.length}개는 팀 기록에 옮겨 둬요.`]),
    ...(regenerable > 0 ? [`다시 만들 수 있는 파일 ${NeedPaths.size(regenerable)}를 지워요.`] : []),
    ...(scanned.lost.length === 0
      ? []
      : [
          `다시 만들 수 없는 파일 ${scanned.lost.length}개(${NeedPaths.size(lostBytes)})도 지워요: ${scanned.lost
            .slice(0, 3)
            .map((item) => trim(item.path))
            .join(", ")}${scanned.lost.length > 3 ? ` 외 ${scanned.lost.length - 3}개` : ""}.`,
        ]),
    ...(scanned.bytes > 0 ? [] : ["저장 지점에 남아 있는 파일만 지워요."]),
  ].join(" ")
}

/** A folder kept: the `touched` card line, and the lasting notice for edited link copies. */
async function keptFolder(input: Steps.Input, area: OwnTeam.Area, scanned: Extract<Scan, { kind: "refused" }>) {
  input.summary({ kind: "area", areaID: area.id, change: "touched" })
  input.services.log.warn("retire_folder_kept", { areaID: area.id, why: scanned.why, message: scanned.message })
  if (scanned.copies.length === 0) return
  const services = input.services
  const text = `${area.name}: 바로 가기 파일 사본 ${scanned.copies.length}개가 원래 내용과 달라 폴더를 지우지 않았어요`
  const data = { count: scanned.copies.length, paths: scanned.copies.map((copy) => copy.path).join(", ") }
  const others = (await services.notices.open(area.teamID)).filter(
    (item) => item.kind === NOTICE && item.areaID !== area.id,
  )
  await services.notices.keep(area.teamID, NOTICE, [
    ...others,
    { id: `${NOTICE}:${area.id}`, at: services.clock.now(), areaID: area.id, kind: NOTICE, text, data },
  ])
  services.notices.publish({ teamID: area.teamID, areaID: area.id, kind: NOTICE, text, data })
}

/**
 * TI-3 (c): no session runs in the folder and no shell or pty is open there. The extended safe point, and the active
 * sessions placed by their folder: a retired area no longer owns its folder in `Locate`, so the safe point alone
 * would not see a conversation running there.
 */
async function quiet(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area) {
  const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id, extended: true })
  if (!safe.ok) return false
  const active = await services.http.session.active()
  if (!active.ok) return false
  const sessions = await Promise.all(
    [...active.value].map((sessionID) => services.http.session.get({ sessionID, directory: team.home.directory })),
  )
  return sessions.every((found) =>
    found.ok ? !Identity.inside(area.directory, found.value.location.directory) : found.status === 404,
  )
}

/** Steps 4-6 for a folder whose list the user confirmed. */
async function remove(
  input: Steps.Input,
  options: Options,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  scanned: Extract<Scan, { kind: "ready" }>,
): Promise<Steps.Outcome> {
  const services = input.services
  const run = options.git ?? Git.run
  const held = await keep(team, area, scanned.entry)
  if (!held.ok) return { ok: false, note: `이름 없는 작업 상태를 보관하지 못했어요: ${held.message}` }
  if (held.kept?.created) {
    input.summary({ kind: "ref", ref: held.kept.ref, sha: held.kept.sha })
    services.notices.publish({
      teamID: team.id,
      areaID: area.id,
      kind: "detached.kept",
      text: "이름 없는 작업 상태를 보관해 뒀어요",
      data: { ref: held.kept.ref },
    })
  }
  const stashed = await stash(team, area, scanned.keep)
  if (stashed !== undefined) return { ok: false, note: `설정 파일을 팀 기록에 옮기지 못했어요: ${stashed}` }
  await write(team, area, {
    directory: area.directory,
    head: scanned.entry.head ?? null,
    manifest: scanned.manifest,
    entries: scanned.covered,
    at: Date.now(),
  })
  // Own's links first, never followed (06 §4.11): a removal must not reach through a link into its target. The links
  // inside ignored entries and copies, then the link copies (clean, so nothing is lost; their flags keep `status` and
  // git's own check quiet), then the shared-folder links.
  await Promise.all(scanned.links.map((link) => fs.rm(native(area.directory, link)).catch(() => undefined)))
  await Promise.all(
    scanned.copies.map((copy) =>
      fs.rm(native(area.directory, copy), { recursive: true, force: true }).catch(() => undefined),
    ),
  )
  const unlink = options.unlink ?? unlinkShared
  await Promise.all(scanned.shared.map((name) => unlink({ directory: area.directory, name })))
  const left = await Promise.all(
    [...scanned.links, ...scanned.copies, ...scanned.shared].map(async (link) =>
      (await present(native(area.directory, link))) ? [link] : [],
    ),
  )
  if (left.flat().length > 0) return { ok: false, note: `바로 가기를 지우지 못했어요: ${left.flat().join(", ")}` }

  const detached = await detach(run, team, area, scanned.entry)
  if (detached.state === "removed") return finish(input, team, area)
  if (detached.state === "kept") return { ok: false, note: `폴더를 지우지 못했어요: ${detached.message}` }
  // Windows: git deleted what it could and dropped the registration; what is left goes when it is on the list.
  const rest = await leftover(team, area, { ...LIMITS, ...options.limits })
  if (rest.kind === "gone") return finish(input, team, area)
  if (rest.kind !== "leftover" || !rest.within) return { ok: false, note: IN_USE }
  return (await clear(area.directory, rest)) ? finish(input, team, area) : { ok: false, note: IN_USE }
}

/**
 * The identity check right before the folder changes (TI-14), `git worktree unlock` (TI-12) and `git worktree remove`
 * without `--force`. `half`: git failed after it started deleting; `kept`: nothing was deleted and the lock is back.
 */
async function detach(
  run: Runner,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  entry: Porcelain.Worktree,
): Promise<
  { readonly state: "removed" } | { readonly state: "half" } | { readonly state: "kept"; readonly message: string }
> {
  const identity = await identify(run, area)
  if (!identity.ok) return { state: "kept", message: identity.message }
  const options = { cwd: team.commonDir, write: true, worktree: true }
  if (entry.locked !== undefined) {
    const unlocked = await run(["worktree", "unlock", area.directory], options)
    if (!unlocked.ok) return { state: "kept", message: unlocked.message }
  }
  const removed = await run(["worktree", "remove", area.directory], options)
  if (removed.ok) return { state: "removed" }
  const listed = await Worktree.list(team.commonDir)
  const still = listed.ok ? listed.worktrees.find((item) => Identity.same(item.path, area.directory)) : undefined
  if (still === undefined || !(await present(path.join(area.directory, ".git")))) return { state: "half" }
  if (entry.locked !== undefined) await run(["worktree", "lock", "--reason", entry.locked, area.directory], options)
  return { state: "kept", message: removed.message }
}

/** Step 6: core's list, the registry, the shared `info/exclude` lines, the notice and the removal record. */
async function finish(input: Steps.Input, team: OwnTeam.Team, area: OwnTeam.Area): Promise<Steps.Outcome> {
  const services = input.services
  const refreshed = await services.http.worktree.refresh({
    projectID: team.projectID,
    directory: team.home.directory,
  })
  if (!refreshed.ok) services.log.warn("retire_refresh_failed", { areaID: area.id, type: refreshed.type })
  if (area.state !== "retired")
    await NeedPaths.update(services, team.id, area.id, (current) => retired(current, services.clock.now()))
  // Its folder copies' `info/exclude` lines go too, unless another folder still holds such a copy.
  const homes = (await services.registry.teams.list()).map((item) => item.home.directory)
  const pruned = await Symlinks.unexclude({
    commonDir: team.commonDir,
    copies: Object.keys(area.linkCopies ?? {}),
    homes,
  })
  if (!pruned.ok) services.log.warn("retire_exclude_failed", { areaID: area.id, message: pruned.message })
  const open = await services.notices.open(team.id)
  if (open.some((item) => item.kind === NOTICE && item.areaID === area.id))
    await services.notices.keep(
      team.id,
      NOTICE,
      open.filter((item) => item.kind === NOTICE && item.areaID !== area.id),
    )
  await fs.rm(recordFile(team, area.id), { force: true })
  return { ok: true, note: "폴더를 지웠어요" }
}

// ---------------------------------------------------------------------------------------------------------------
// The removal record (step 4, written ahead): what a half removal may clear without asking again

const Removal = Schema.Struct({
  directory: Schema.String,
  /** The worktree's HEAD: its files may be what a half removal leaves. */
  head: Schema.NullOr(Schema.String),
  /** The confirmed list (`StepConfirm.manifest`). */
  manifest: Schema.String,
  /** The ignored entries the removal covers (listed, kept, own copies, links). */
  entries: Schema.Array(Schema.String),
  /** Wall-clock time of the list: an item changed later is not on it. */
  at: Schema.Finite,
})
type Removal = typeof Removal.Type

const decodeRemoval = Schema.decodeUnknownOption(Schema.fromJsonString(Removal))

function recordFile(team: Pick<OwnTeam.Team, "id" | "commonDir">, areaID: OwnTeam.AreaID) {
  return path.join(Teams.records(team), "retired", `${slugOf(areaID)}.removal.json`)
}

async function write(team: OwnTeam.Team, area: OwnTeam.Area, record: Removal) {
  const file = recordFile(team, area.id)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(record))
}

async function read(team: OwnTeam.Team, area: OwnTeam.Area) {
  const text = await Bun.file(recordFile(team, area.id))
    .text()
    .catch(() => undefined)
  return text === undefined ? undefined : Option.getOrUndefined(decodeRemoval(text))
}

/** Step 5's view of a half-removed folder: its items, and whether the removal record covers every one. */
async function leftover(team: OwnTeam.Team, area: OwnTeam.Area, limits: Limits): Promise<Scan> {
  const record = await read(team, area)
  // Without a removal of this area under way, a folder without `.git` is a broken one: its files may be anyone's work.
  if (!record || !Identity.same(record.directory, area.directory) || record.at < area.base.at)
    return refused("identity", `이 폴더의 정보가 맞지 않아 멈췄어요: 작업 폴더가 아니에요(${area.directory})`)
  const listed = await contents(area.directory, limits)
  if (!listed) return refused("partial", "남은 폴더를 다 살펴보지 못해 지우지 않았어요")
  const bytes = listed.items.reduce((sum, item) => sum + item.bytes, 0)
  const asked = { kind: "leftover" as const, ...listed, bytes }
  const tracked = record.head === null ? new Set<string>() : await files(team.commonDir, record.head)
  if (!tracked) return { ...asked, within: false, manifest: Confirm.manifest(listed.items) }
  const allowed = (item: Item) =>
    item.mtime <= record.at && (tracked.has(key(item.path)) || record.entries.some((entry) => covers(entry, item.path)))
  const within = listed.items.every(allowed)
  return { ...asked, within, manifest: within ? record.manifest : Confirm.manifest(listed.items) }
}

/** The files of `head` (`ls-tree -r`), by comparison key; `undefined` when git cannot list them. */
async function files(commonDir: string, head: string) {
  const listed = await Git.run(["ls-tree", "-r", "-z", "--name-only", head], { cwd: commonDir, worktree: true })
  return listed.ok ? new Set(Porcelain.fields(listed.stdout).map(key)) : undefined
}

/** Everything left in a half-removed folder (links not followed); `undefined` past the budget. */
async function contents(top: string, limits: Limits) {
  const found = await fs.readdir(top, { recursive: true, withFileTypes: true }).catch(() => undefined)
  if (!found || found.length > limits.entries) return undefined
  const absolute = (entry: (typeof found)[number]) => path.join(entry.parentPath, entry.name)
  const items = await Promise.all(
    found
      .filter((entry) => !entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry): Promise<Item> => {
        const stat = await fs.lstat(absolute(entry)).catch(() => undefined)
        return {
          path: relative(top, absolute(entry)),
          bytes: stat?.size ?? 0,
          mtime: stat?.mtimeMs ?? Number.POSITIVE_INFINITY,
          files: 1,
        }
      }),
  )
  const dirs = found.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(absolute)
  return { items, dirs }
}

/** Deletes a half-removed folder's items (links themselves, never their targets), then its folders, deepest first. */
async function clear(top: string, left: Extract<Scan, { kind: "leftover" }>) {
  await Promise.all(left.items.map((item) => fs.rm(native(top, item.path)).catch(() => undefined)))
  const folders = [...left.dirs].toSorted((a, b) => b.length - a.length)
  await folders.reduce(
    (previous, folder) => previous.then(() => fs.rmdir(folder).catch(() => undefined)),
    Promise.resolve<void>(undefined),
  )
  await fs.rmdir(top).catch(() => undefined)
  return !(await present(top))
}

// ---------------------------------------------------------------------------------------------------------------
// Small irreplaceable files (step 2)

/**
 * Copies the files of `items` to `<records>/retired/<slug>/` with their times; the folder removal then deletes the
 * originals. A file already there with the same bytes is not copied again; another one keeps a numbered name. Links are
 * not followed. Returns the first error, or `undefined`.
 */
async function stash(team: OwnTeam.Team, area: OwnTeam.Area, items: ReadonlyArray<Item>) {
  const root = retiredFolder(team, area.id)
  const listed = await Promise.all(items.map((item) => filesOf(area.directory, item.path)))
  const failures = await Promise.all(
    listed.flat().map((file) =>
      copy(native(area.directory, file), native(root, file)).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    ),
  )
  return failures.find((failure) => failure !== undefined)
}

async function copy(from: string, to: string, attempt = 0): Promise<void> {
  const target = attempt === 0 ? to : `${to}.${attempt}`
  const existing = Bun.file(target)
  if (await existing.exists()) {
    const [a, b] = await Promise.all([Bun.file(from).bytes(), existing.bytes()])
    if (Buffer.compare(a, b) === 0) return
    return copy(from, to, attempt + 1)
  }
  const stat = await fs.stat(from)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(from, target)
  await fs.utimes(target, stat.atime, stat.mtime)
}

/** The files of an ignored entry, repository-relative (a folder's, recursively; links are not followed). */
async function filesOf(directory: string, entry: string) {
  const at = native(directory, trim(entry))
  const stat = await fs.lstat(at).catch(() => undefined)
  if (stat === undefined || stat.isSymbolicLink()) return []
  if (stat.isFile()) return [trim(entry)]
  if (!stat.isDirectory()) return []
  const found = await fs.readdir(at, { recursive: true, withFileTypes: true })
  return found.filter((item) => item.isFile()).map((item) => relative(directory, path.join(item.parentPath, item.name)))
}

// ---------------------------------------------------------------------------------------------------------------
// The walk (step 1)

/** Folders read and files `lstat`ed at once: one call at a time is about ten times slower on Windows. */
const DIRECTORY_BATCH = 32
const STAT_BATCH = 256

interface Folder {
  readonly absolute: string
  readonly relative: string
  /** The ignored entry this folder belongs to. */
  readonly entry?: string
}

interface Walked {
  readonly complete: boolean
  /** Folders below the top that hold a `.git` (not entered). */
  readonly nested: ReadonlyArray<string>
  /** Links met (never followed) and the ignored entry they are in. */
  readonly links: ReadonlyArray<{ readonly path: string; readonly entry?: string }>
  readonly sizes: ReadonlyMap<string, Omit<Item, "path">>
}

/**
 * Breadth-first, never through a link (`Dirent.isSymbolicLink` is also true for a junction), folders in batches, so an
 * independent repository in a shallow ignored folder is found before the budget goes into a deep `node_modules`; then
 * the files of the ignored entries are sized. Running out of entries or time makes it incomplete.
 */
async function walk(top: string, ignored: ReadonlyArray<string>, limits: Limits): Promise<Walked> {
  const deadline = Date.now() + limits.ms
  const owners = new Map(ignored.map((entry) => [key(trim(entry)), entry]))
  const queue: Folder[] = [{ absolute: top, relative: "" }]
  const found = {
    nested: [] as string[],
    links: [] as Array<{ readonly path: string; readonly entry?: string }>,
    files: [] as Array<{ readonly absolute: string; readonly entry: string }>,
    entries: 0,
    unreadable: false,
  }
  const result = (complete: boolean): Walked => ({
    complete,
    nested: found.nested,
    links: found.links,
    sizes: new Map(),
  })
  while (queue.length > 0) {
    if (found.entries > limits.entries || Date.now() > deadline) return result(false)
    const read = await Promise.all(
      queue.splice(0, DIRECTORY_BATCH).map(async (folder) => ({
        folder,
        entries: await fs.readdir(folder.absolute, { withFileTypes: true }).catch(() => undefined),
      })),
    )
    found.entries += read.reduce((total, item) => total + (item.entries?.length ?? 0), 0)
    found.unreadable ||= read.some((item) => !item.entries)
    read
      .flatMap((item) => (item.entries ? [classify(item.folder, item.entries, owners)] : []))
      .forEach((finding) => {
        if (finding.nested !== undefined) found.nested.push(finding.nested)
        found.links.push(...finding.links)
        found.files.push(...finding.files)
        queue.push(...finding.folders)
      })
  }
  const sizes = await size(found.files, deadline)
  if (!sizes) return result(false)
  return { ...result(!found.unreadable), sizes }
}

/** One folder's findings: itself as a nested repository, or its links, subfolders and the files of ignored entries. */
function classify(folder: Folder, entries: ReadonlyArray<Dirent>, owners: ReadonlyMap<string, string>) {
  // The top `.git` is this worktree's own; any other `.git` is another repository or worktree (TI-3 (b)).
  if (folder.relative && entries.some((entry) => isGit(entry.name)))
    return { nested: folder.relative, links: [], files: [], folders: [] }
  const children = entries
    .filter((entry) => !isGit(entry.name))
    .map((entry) => {
      const relativePath = folder.relative ? `${folder.relative}/${entry.name}` : entry.name
      const owner = folder.entry ?? owners.get(key(relativePath))
      return { entry, relative: relativePath, absolute: path.join(folder.absolute, entry.name), owner }
    })
  return {
    nested: undefined,
    links: children
      .filter((child) => child.entry.isSymbolicLink())
      .map((child) => ({ path: child.relative, ...(child.owner === undefined ? {} : { entry: child.owner }) })),
    files: children.flatMap((child) =>
      child.owner !== undefined && child.entry.isFile() ? [{ absolute: child.absolute, entry: child.owner }] : [],
    ),
    folders: children
      .filter((child) => child.entry.isDirectory() && !child.entry.isSymbolicLink())
      .map(
        (child): Folder => ({
          absolute: child.absolute,
          relative: child.relative,
          ...(child.owner === undefined ? {} : { entry: child.owner }),
        }),
      ),
  }
}

/** Bytes, newest mtime and file count per ignored entry; `undefined` when the time ran out. */
async function size(files: ReadonlyArray<{ readonly absolute: string; readonly entry: string }>, deadline: number) {
  const sizes = new Map<string, { bytes: number; mtime: number; files: number }>()
  const batches = Array.from({ length: Math.ceil(files.length / STAT_BATCH) }, (_, index) =>
    files.slice(index * STAT_BATCH, (index + 1) * STAT_BATCH),
  )
  const finished = await batches.reduce(async (previous: Promise<boolean>, batch) => {
    if (!(await previous) || Date.now() > deadline) return false
    const stats = await Promise.all(batch.map((file) => fs.lstat(file.absolute).catch(() => undefined)))
    batch.forEach((file, index) => {
      const stat = stats[index]
      const current = sizes.get(file.entry) ?? { bytes: 0, mtime: 0, files: 0 }
      sizes.set(file.entry, {
        bytes: current.bytes + (stat?.size ?? 0),
        mtime: Math.max(current.mtime, stat?.mtimeMs ?? Number.POSITIVE_INFINITY),
        files: current.files + 1,
      })
    })
    return true
  }, Promise.resolve(true))
  return finished ? sizes : undefined
}

// ---------------------------------------------------------------------------------------------------------------

/** Ignored folders that tools make again (dependencies, caches, build output); a removal lists them. */
const REGENERABLE = new Set([
  "node_modules",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".astro",
  ".angular",
  ".expo",
  ".vercel",
  ".wrangler",
  ".parcel-cache",
  ".vite",
  ".cache",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  ".tox",
  ".gradle",
  "storybook-static",
  "playwright-report",
  "test-results",
  ".own-bun-cache",
])
const REGENERABLE_FILE = /(?:\.tsbuildinfo|\.pyc|\.pyo)$|^(?:\.ds_store|thumbs\.db|desktop\.ini)$/i

function regenerable(entry: string) {
  const parts = trim(entry).split("/")
  return parts.some((part) => REGENERABLE.has(part.toLowerCase())) || REGENERABLE_FILE.test(parts.at(-1) ?? "")
}

/** The default {@link Unlink}: `lstat`, and only a link is removed (a real folder at that path stays). */
async function unlinkShared(link: { readonly directory: string; readonly name: string }) {
  const at = native(link.directory, link.name)
  const stat = await fs.lstat(at).catch(() => undefined)
  if (stat?.isSymbolicLink()) await fs.rm(at)
}

/** The rev-parse of TI-14 through the runner, compared with the record (`Identity.check`'s rule). */
async function identify(run: Runner, area: Pick<OwnTeam.Area, "directory" | "gitDir">) {
  const result = await run(["rev-parse", "--absolute-git-dir", "--show-toplevel"], {
    cwd: area.directory,
    worktree: true,
  })
  if (!result.ok) return { ok: false as const, message: result.message }
  const [gitDir, toplevel] = result.stdout.split("\n").map((line) => line.trim())
  if (!gitDir || !Identity.same(gitDir, area.gitDir))
    return { ok: false as const, message: `Git 폴더가 기록과 달라요: ${gitDir}(기록 ${area.gitDir})` }
  if (!toplevel || !Identity.same(toplevel, area.directory))
    return { ok: false as const, message: `맨 위 폴더가 기록과 달라요: ${toplevel}(기록 ${area.directory})` }
  return { ok: true as const }
}

function refused(why: Refusal, message: string, copies: ReadonlyArray<Symlinks.Dirty> = []): Scan {
  return { kind: "refused", why, message, copies }
}

async function present(at: string) {
  return (await fs.lstat(at).catch(() => undefined)) !== undefined
}

/** `entry` (an ignored entry or a copy, `dir/` or `file`) is `file` or holds it. */
function covers(entry: string, file: string) {
  const top = key(trim(entry))
  const item = key(trim(file))
  return item === top || item.startsWith(`${top}/`)
}

function trim(value: string) {
  return value.replace(/\/+$/, "")
}

const WINDOWS = process.platform === "win32"

/** Comparison key of a repository path: Windows paths ignore case. */
function key(value: string) {
  return WINDOWS ? value.toLowerCase() : value
}

function isGit(name: string) {
  return key(name) === ".git"
}

function native(directory: string, file: string) {
  return path.join(directory, ...file.split("/"))
}

function relative(top: string, absolute: string) {
  return path.relative(top, absolute).split(path.sep).join("/")
}

function slugOf(areaID: OwnTeam.AreaID) {
  return areaID.slice("ar_".length)
}
