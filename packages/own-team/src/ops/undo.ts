export * as Undo from "./undo.js"

import fs from "node:fs"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { Heavy } from "../assets/heavy.js"
import { Shared } from "../assets/shared.js"
import { Symlinks } from "../assets/symlinks.js"
import { Classify } from "../git/classify.js"
import { Home } from "../git/home.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import { Convert } from "../reorg/convert.js"
import { AreaMerge } from "../reorg/merge.js"
import { RemoteLfs } from "../remote/lfs.js"
import { Rehome } from "../reorg/rehome.js"
import { Retire } from "../reorg/retire.js"
import { AreaSplit } from "../reorg/split.js"
import { Keys } from "../registry/keys.js"
import { Services } from "../services.js"
import { OwnerSession } from "../sessions/owner.js"
import { Adopt } from "./adopt.js"
import { AreaCreate } from "./area-create.js"
import { Disable } from "./disable.js"
import { Enable } from "./enable.js"
import { TeamHome } from "./home.js"
import type { Steps } from "./steps.js"
import { Journal } from "./journal.js"

/**
 * `op.undo` (06 §3.8 되돌리기, §9.3): an `undo` op that reverses only what one op made. `enable`, `adopt` and `home` ops
 * are undoable; the undo of enable:
 *
 *   undo.area     each area the enable created: removed when untouched (no commit after its base, clean with ignored
 *                 files counted but own's clean folder copies not, every link copy as recorded (4.12), no message
 *                 in its owner conversation, nothing running), with `worktree remove` without `--force`, the owner
 *                 archived and its branch deleted while it is still at the base and no folder uses it (TI-4's one
 *                 exception), and its folder copies' `info/exclude` lines taken out when no other folder holds such a
 *                 copy (`Symlinks.unexclude`), and own's `.gitignore` of a root inside the main folder when nothing
 *                 else is left there (`Home.unignore`, 2026-10-27); a touched one is kept with its lock released and a
 *                 `touched` line on the card, its owner and peers detached as 빼기 does. 담당 대화 바꾸기: a
 *                 conversation that held the seat before counts for "no message" too, and one still listed in
 *                 `owner.release` is released first (`Seat.sweep`)
 *   adopt.detach  each adopted area's owner loses what its first main request attached (team allows, role entries, the
 *                 binding's team context); a conversation never attached is not written to (`ops/adopt.ts`)
 *   adopt.unname  a detached HEAD the enable named is detached again while nothing was committed on it
 *   undo.archive  the team main gets `own.archived: true` (metadata read-modify-write; sessions are never deleted, TI-5)
 *   team.restore  each lock the enable took is put back as it was (nested worktrees keep a lock): the home, the adopted
 *                 folders
 *   lfs-restore   on an SSH host whose enable made the bundled git-lfs the repository's filter (`lfs-remote`), the
 *                 filter values from before it (`remote/lfs.ts`, 06 §4.13)
 *   undo.mark     the enable op is marked undone (`undo.by`), so a later enable never reuses its main
 *   undo.registry the team's records go (a team the enable made), or it goes back `off` (다시 켜기 after 끄기)
 *
 * Adopted folders, their branches and their conversations stay as they are; keep refs stay (두기). The undo of
 * `adopt` (팀에 넣기) is 빼기 of that area (8.2 반대); the undo of `home` moves the main back and restores both
 * folders' locks (`ops/home.ts`).
 *
 * Shared folders (4.11): an area folder is removed only after own's links in it are deleted unfollowed
 * (`Shared.unlink`), and those links are own's, not the user's files, for the untouched check. The enable's undo
 * starts with `undo.shared` for every shared folder that enable protected: own's links in every area deleted, the
 * protection taken off (`Shared.unprotect`), its `info/exclude` line and its record removed.
 *
 * A reorganization (`reorg` op, 8.2 되돌리기) is undone action by action, last first: a moved conversation moved back
 * (`Rehome.undo`), a conversion converted back (`Convert.undo`), a merge undone while A is still at K
 * (`AreaMerge.undo`; after A moved on only 'B 다시 만들기' is left: `conflict`, and own-web offers a new area from B's
 * branch, `reorg.apply` `op:"new"` with `from: B`), a WIP commit taken back while B's
 * branch is still W (`AreaMerge.wipUndo`, 8.7), a split by 끝내기 of the new area (`AreaSplit.undone`, `Retire.plan`; the
 * user's waits for its safe point), a new area removed while untouched (`undo.area`), a folder put in the team taken out
 * (as 빼기), a rename named back (with the role and the user-made mark it set, 2026-11-17). 끝내기 has no undo (its
 * branch and conversations stay). Which reorganization shows 되돌리기 is the runner's: one with a done step of a kind marked `reverses` (`Steps.Kind.reverses`).
 *
 * The undo feature is created once per controller, so it also registers the step kinds of enable, adoption, disable
 * and `team.home`: they must exist before the runner resumes a running op (`Controller.resume`). The reorganization
 * kinds an undo plans come with `services.features().reorg.register()`.
 */
export function create(services: Services.Context): Services.Undo {
  Enable.register(services)
  Adopt.register(services)
  Disable.register(services)
  TeamHome.register(services)
  services.steps.register(areaKind())
  services.steps.register(archiveKind())
  services.steps.register(markKind())
  services.steps.register(registryKind())
  services.steps.register(sharedKind())
  return { start: (input) => start(services, input) }
}

async function start(
  services: Services.Context,
  input: { readonly opID: OwnTeam.OpID; readonly by: OwnTeam.Op["by"] },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const op = await services.journal.find(input.opID)
  if (!op) return Services.failure("not_found", "op not found", { what: "op", id: input.opID })
  const team = await services.registry.teams.get(op.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: op.teamID })
  // The enable that made the team can be undone while it is off too (it failed early, or the team was turned off).
  const maker = op.kind === "enable" && Enable.context(op).previous === "none"
  if (team.state !== "on" && !maker) return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const planned = await planOf(services, op, input.by)
  if (planned && !planned.ok) return planned
  const steps = planned?.steps
  if (!steps) return Services.failure("unsupported", "this op cannot be undone", { feature: "undo" })
  // The undo of 팀에 넣기 is 빼기 of that area (8.2 반대) and waits for the same safe point: it takes the team rules
  // and role entries off the owner conversation and removes the area record.
  const adopted = op.kind === "adopt" || op.kind === "reorg" ? Adopt.unregisters(op) : []
  const checks = await Promise.all(
    adopted
      .flatMap((spec) => Option.toArray(decodeAreaOption(spec.args)))
      .map(async (args) => ({
        areaID: args.areaID,
        safe: (await services.registry.areas.get(team.id, args.areaID))
          ? await services.features().safePoint.check({ teamID: team.id, areaID: args.areaID })
          : ({ ok: true } as const),
      })),
  )
  const working = checks.find((item) => !item.safe.ok)
  if (working && !working.safe.ok)
    return Services.failure("not_safe_point", "the area is working", {
      areaID: working.areaID,
      why: working.safe.why,
      sessionIDs: working.safe.sessionIDs,
    })
  const started = await services.runner.start({
    teamID: team.id,
    kind: "undo",
    by: input.by,
    undo: { available: false, of: op.id },
    steps,
  })
  if (!started.ok) return Services.failure("busy", "another team op is running", Journal.busy(started.op))
  return { ok: true, opID: started.op.id }
}

type Planned = Services.Result<{ readonly steps: ReadonlyArray<Steps.Spec> }> | undefined

/** The undo's steps: an enable, 팀에 넣기 or 메인 폴더 바꾸기 by its `undo.available`, a reorganization by what it did. */
async function planOf(services: Services.Context, op: OwnTeam.Op, by: OwnTeam.Op["by"]): Promise<Planned> {
  if (op.undo?.by !== undefined) return undefined
  if (op.kind === "reorg") return reorganized(services, op, by)
  // 06 §4.4: the list back (its folders kept out of later growths), converted areas back to full folders (with the
  // download confirm of 8.2), relabels undone.
  if (op.kind === "heavy") return op.undo?.available === true ? Heavy.undo(services, { op, by }) : undefined
  if (op.undo?.available !== true) return undefined
  const steps = stepsOf(op)
  return steps && { ok: true, steps }
}

/**
 * A reorganization undone action by action, last first (see the module comment). `undefined` when it did nothing an
 * undo reverses; a failure when one action cannot be reversed now (a merge whose A moved on, an area at work).
 */
async function reorganized(services: Services.Context, op: OwnTeam.Op, by: OwnTeam.Op["by"]): Promise<Planned> {
  services.features().reorg.register()
  const team = await services.registry.teams.get(op.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: op.teamID })
  const done = (kind: string) => op.steps.filter((step) => step.kind === kind && step.state === "done")
  const converted = await Convert.undo(services, { op, by })
  if (converted && !converted.ok) return converted
  const merged = done(AreaMerge.KIND.into).length > 0 ? await AreaMerge.undo(services, op) : undefined
  if (merged && !merged.ok) return merged
  const split = AreaSplit.undone(op)
  const retired = await Promise.all(
    split.map(async (item): Promise<Services.Result<{ readonly steps: ReadonlyArray<Steps.Spec> }>> => {
      const area = await services.registry.areas.get(team.id, item.areaID)
      if (!area || area.state === "retired") return { ok: true, steps: [] }
      return Retire.plan(services, { team, area, by })
    }),
  )
  const refused = retired.find((result) => !result.ok)
  if (refused && !refused.ok) return refused
  const splitOff = new Set<string>(split.map((item) => item.areaID))
  const made = done(AreaCreate.KIND.record)
    .flatMap((step) => Option.toArray(decodeAreaOption(step.args)))
    .filter((args) => !splitOff.has(args.areaID))
  const renamed = done(AreaCreate.KIND.rename).flatMap((step) => Option.toArray(decodeRename(step.args)))
  const adopted = Adopt.unregisters(op)
  const locked = op.steps.flatMap((step) =>
    step.kind === "team.lock" && step.state === "done" ? [decodeLock(step.args).directory] : [],
  )
  const steps: ReadonlyArray<Steps.Spec> = [
    ...(Rehome.undo(op) ?? []),
    ...(converted?.steps ?? []),
    ...(merged?.steps ?? []),
    // 8.7: a WIP commit back off B's branch while it is still W.
    ...AreaMerge.wipUndo(op),
    ...retired.flatMap((result) => (result.ok ? result.steps : [])),
    ...made
      .toReversed()
      .map((args) => ({ id: `area:${args.areaID}`, kind: "undo.area", args: { areaID: args.areaID } })),
    // 팀에 넣기 taken back as 빼기 (8.2): its waiting requests cancelled, what was attached taken off, locks back.
    ...adopted.flatMap((spec) =>
      Option.toArray(decodeAreaOption(spec.args)).map((args) => ({
        id: `outbox:${args.areaID}`,
        kind: Adopt.KIND.outbox,
        args: { areaID: args.areaID },
      })),
    ),
    ...Adopt.reverse(op),
    ...locked.map((directory, index) => ({
      id: `restore:${index + 1}`,
      kind: "team.restore",
      args: { directory, before: null },
    })),
    ...adopted,
    ...renamed.toReversed().map((args) => ({
      id: `rename:${args.areaID}`,
      kind: AreaCreate.KIND.rename,
      // A role and a mark the rename set go back too (2026-11-17); an older step named the area only.
      args: {
        areaID: args.areaID,
        name: args.previous.name,
        subtitle: args.previous.subtitle,
        ...(args.goal === undefined || args.previous.goal === undefined ? {} : { goal: args.previous.goal }),
        ...(args.userMade === undefined || args.previous.userMade === undefined
          ? {}
          : { userMade: args.previous.userMade }),
        previous: {
          name: args.name,
          subtitle: args.subtitle === undefined ? args.previous.subtitle : args.subtitle,
          ...(args.goal === undefined ? {} : { goal: args.goal }),
          ...(args.userMade === undefined ? {} : { userMade: args.userMade }),
        },
      },
    })),
  ]
  if (steps.length === 0) return undefined
  return {
    ok: true,
    steps: [
      ...steps.map((spec, index) => ({ ...spec, id: spec.id ?? `undo:${index + 1}` })),
      { id: "mark", kind: "undo.mark", args: { opID: op.id } },
    ],
  }
}

function stepsOf(op: OwnTeam.Op): ReadonlyArray<Steps.Spec> | undefined {
  const mark = { id: "mark", kind: "undo.mark", args: { opID: op.id } }
  if (op.kind === "home") {
    const steps = TeamHome.undo(op)
    return steps && [...steps, mark]
  }
  const locked = op.steps.flatMap((step) =>
    step.kind === "team.lock" && step.state === "done" ? [decodeLock(step.args).directory] : [],
  )
  if (op.kind === "adopt")
    // 팀에 넣기 takes only folders nothing else had locked (V3), so their locks go back to none.
    return [
      ...Adopt.reverse(op),
      ...locked.map((directory, index) => ({
        id: `restore:${index + 1}`,
        kind: "team.restore",
        args: { directory, before: null },
      })),
      ...Adopt.unregisters(op),
      mark,
    ]
  if (op.kind !== "enable") return undefined
  const ctx = Enable.context(op)
  const shared = op.steps.flatMap((step) =>
    step.kind === Shared.KIND.protect && step.state === "done"
      ? Option.toArray(decodeNameOption(step.args)).map((args) => args.name)
      : [],
  )
  return [
    ...(shared.length === 0 ? [] : [{ id: "shared", kind: "undo.shared", args: { names: shared } }]),
    ...Enable.created(op).map((areaID) => ({ id: `area:${areaID}`, kind: "undo.area", args: { areaID } })),
    ...Adopt.reverse(op),
    ...(ctx.previous === "none"
      ? [
          {
            id: "archive:main",
            kind: "undo.archive",
            args: { sessionID: ctx.mainSessionID, directory: ctx.home.directory },
          },
        ]
      : []),
    ...locked.map((directory, index) => ({
      id: `restore:${index + 1}`,
      kind: "team.restore",
      args: { directory, before: TeamHome.before(ctx.locks, directory) },
    })),
    // 4.13: the repository's own LFS filter back, once own's areas are gone.
    ...(op.steps.some((step) => step.kind === RemoteLfs.KIND && step.state === "done")
      ? [RemoteLfs.restoreSpec({ directory: ctx.home.directory })]
      : []),
    // Marked before the records go: a crash after this still resumes (the team record is there until the last step).
    mark,
    { id: "registry", kind: "undo.registry", args: { previous: ctx.previous } },
  ]
}

const decodeLock = Schema.decodeUnknownSync(Schema.Struct({ directory: Schema.String }))
const decodeArea = Schema.decodeUnknownSync(Schema.Struct({ areaID: OwnTeam.AreaID }))
const decodeAreaOption = Schema.decodeUnknownOption(Schema.Struct({ areaID: OwnTeam.AreaID }))
const decodeNameOption = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }))
const decodeShared = Schema.decodeUnknownSync(Schema.Struct({ names: Schema.Array(Schema.String) }))
/** `area-rename`'s arguments (`ops/area-create.ts`): absent `subtitle` = unchanged, `null` = removed. */
const decodeRename = Schema.decodeUnknownOption(
  Schema.Struct({
    areaID: OwnTeam.AreaID,
    name: Schema.String,
    subtitle: optional(Schema.NullOr(Schema.String)),
    goal: optional(Schema.String),
    userMade: optional(Schema.Boolean),
    previous: Schema.Struct({
      name: Schema.String,
      subtitle: Schema.NullOr(Schema.String),
      goal: optional(Schema.String),
      userMade: optional(Schema.Boolean),
    }),
  }),
)
const decodeArchive = Schema.decodeUnknownSync(Schema.Struct({ sessionID: Schema.String, directory: Schema.String }))
const decodeMark = Schema.decodeUnknownSync(Schema.Struct({ opID: OwnTeam.OpID }))
const decodeRegistry = Schema.decodeUnknownSync(Schema.Struct({ previous: Schema.Literals(["none", "off", "on"]) }))
const decodeMetadata = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

/** The key a session archive mark lives under (03 §19.11, 06 §6.2 step 4). */
export const ARCHIVED = "own.archived"

async function teamOf(services: Services.Context, teamID: string) {
  const team = await services.registry.teams.get(teamID)
  if (!team) throw new Error(`팀 기록이 없어요: ${teamID}`)
  return team
}

/**
 * Where a created area is: its record, or (when its creation stopped before the record was written) the folder and
 * branch 4.5 gives it, `<worktreeRoot>/<slug>` and `<slug>`.
 */
async function placeOf(services: Services.Context, teamID: string, areaID: OwnTeam.AreaID) {
  const team = await teamOf(services, teamID)
  const record = await services.registry.areas.get(teamID, areaID)
  const slug = areaID.slice("ar_".length)
  const directory = record?.directory ?? `${team.worktreeRoot.replace(/[\\/]+$/, "")}/${slug}`
  // A creation killed inside `worktree add` left a folder git cannot list; it holds no work, so it goes first.
  await Worktree.clear({ home: team.home.directory, directory, areaID })
  const listed = await Worktree.list(team.commonDir)
  if (!listed.ok) throw new Error(listed.message)
  const entry = listed.worktrees.find((item) => Classify.same(item.path, directory))
  return { team, record, directory, branch: record?.branch ?? slug, entry }
}

type Place = Awaited<ReturnType<typeof placeOf>>

/**
 * 06 §3.8: commits after the base, uncommitted work (link copies included, 4.12), a message in the owner conversation,
 * or a running session.
 */
async function touched(services: Services.Context, place: Place) {
  if (!place.entry) return false
  const owner = place.record?.owner.sessionID ?? null
  const copies = Object.keys(place.record?.linkCopies ?? {})
  const [tip, status, commits, messages, earlier, active, changed, shared] = await Promise.all([
    Refs.read(place.team.commonDir, `refs/heads/${place.branch}`),
    // Ignored files count: `worktree remove` deletes them (a `.env`, local config or install output), 06 §8.6.
    Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching"], {
      cwd: place.directory,
      worktree: true,
    }),
    committed(place.team.commonDir, place.branch),
    owner === null
      ? Promise.resolve(undefined)
      : services.http.session.messages({ sessionID: owner, directory: place.directory, limit: 1 }),
    // 담당 대화 바꾸기: the seat may have moved off the conversation the work was talked through in.
    Promise.all(
      (place.record?.owner.previous ?? []).map((item) =>
        services.http.session.messages({ sessionID: item.sessionID, directory: place.directory, limit: 1 }),
      ),
    ),
    services.http.session.active(),
    // The copies' flags hide an edit from `status`, and `worktree remove` would delete it: the record is compared.
    Symlinks.dirtyCopies({ directory: place.directory, linkCopies: place.record?.linkCopies }),
    Shared.inspect(place.directory, place.team.shared),
  ])
  const base = place.record?.base.sha
  const moved = base === undefined ? commits : place.entry.head !== base || (tip !== null && tip !== base)
  // A clean folder copy and a shared-folder link are ignored through `info/exclude` and show as `!`: they are own's,
  // not the user's files.
  const links = shared.flatMap((item) => (item.state === "linked" ? [item.name] : []))
  const own = (file: string) =>
    [...copies, ...links].some((copy) => file.replace(/\/$/, "") === copy || file.startsWith(`${copy}/`))
  const entries = status.ok
    ? Porcelain.status(status.stdout).entries.filter((entry) => entry.kind !== "ignored" || !own(entry.path))
    : []
  const dirty = !status.ok || entries.length > 0 || changed.length > 0
  // An unreadable conversation counts as touched: undo never removes what it cannot see.
  // A conversation that held the seat before and is gone (404) says nothing.
  const talked =
    (messages !== undefined && (!messages.ok || messages.value.data.length > 0)) ||
    earlier.some((read) => (read.ok ? read.value.data.length > 0 : read.status !== 404))
  const running = owner !== null && (!active.ok || active.value.has(owner))
  const kept = moved || dirty || talked || running
  if (kept)
    services.log.info("undo_area_touched", {
      areaID: place.record?.id,
      moved,
      dirty,
      talked,
      running,
      ...(changed.length === 0 ? {} : { copies: changed.map((copy) => copy.path) }),
      ...(status.ok ? {} : { status: status.message }),
      ...(messages === undefined || messages.ok ? {} : { messages: messages.type }),
    })
  return kept
}

/** The branch's reflog shows a commit made on it. */
async function committed(commonDir: string, branch: string) {
  const log = await Git.run(["log", "-g", "--format=%gs", `refs/heads/${branch}`], { cwd: commonDir, worktree: true })
  return log.ok && log.stdout.split("\n").some((line) => line.startsWith("commit"))
}

/** Sets the archive mark (`on: false` takes it back: the folder of a kept area stays the user's). */
async function archive(services: Services.Context, sessionID: string, directory: string, on = true) {
  const written = await services.http.session.metadata({
    sessionID,
    directory,
    change: (current) => {
      const metadata: Readonly<Record<string, Schema.Json>> = Option.getOrElse(decodeMetadata(current), () => ({}))
      return on
        ? { ...metadata, [ARCHIVED]: true }
        : Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== ARCHIVED))
    },
  })
  if (!written.ok)
    throw new Error(`대화를 ${on ? "보관하지" : "보관에서 꺼내지"} 못했어요(${sessionID}): ${written.message}`)
}

function areaKind(): Steps.Kind {
  return {
    kind: "undo.area",
    observe: async (input) => {
      const place = await placeOf(input.services, input.op.teamID, decodeArea(input.step.args).areaID)
      return place.record === undefined && place.entry === undefined ? { state: "satisfied" } : { state: "pending" }
    },
    act: async (input) => {
      const services = input.services
      const areaID = decodeArea(input.step.args).areaID
      const place = await placeOf(services, input.op.teamID, areaID)
      // 담당 대화 바꾸기: a conversation that left the seat and was not released yet (`owner.release`) loses the
      // owner's things here, while the record that lists it is still there.
      if (place.record) await services.features().seat.sweep({ teamID: input.op.teamID, areaID, inside: true })
      const kept = await touched(services, place)
      const owner = place.record?.owner.sessionID ?? null
      // The owner is archived while its folder is still there: a request about a session whose folder is gone and
      // whose Location is not loaded fails (the service cannot start a Location in a missing folder).
      if (!kept && owner !== null) await archive(services, owner, place.directory)
      const removed = !kept && place.entry !== undefined ? await remove(services, place) : { ok: true as const }
      if (kept || !removed.ok) {
        if (!removed.ok) {
          services.log.warn("undo_area_kept", { areaID, message: removed.message })
          if (owner !== null) await archive(services, owner, place.directory, false)
        }
        // The folder and its conversations stay the user's, so the team rules and role entries leave them before
        // the record does (as 빼기 does): nothing could take them off afterwards. A conversation that is gone has
        // nothing to lose.
        if (place.record) {
          const target = { teamID: input.op.teamID, areaID, signal: input.signal }
          const detached = await OwnerSession.detach(services, target)
          if (!detached.ok && detached.error !== "not_found") return { ok: false, note: detached.message }
          const peers = await services.features().peers.detach(target)
          if (!peers.ok) return { ok: false, note: peers.message }
        }
        if (place.entry?.locked === Worktree.lockReason(areaID))
          await TeamHome.release(input, place.team.commonDir, place.directory)
        // The folder leaves the team as the user's: own's shared-folder links in it go (4.11), the rest stays.
        const unlinked = await services
          .features()
          .shared.unlink({ directory: place.directory, shared: place.team.shared })
        if (!unlinked.ok) services.log.warn("undo_unlink_failed", { areaID, message: unlinked.message })
        input.summary({ kind: "area", areaID, change: "touched" })
      }
      if (!kept && removed.ok) {
        await branch(place)
        // Its folder copies' `info/exclude` lines go too, unless another folder still holds such a copy.
        const homes = (await services.registry.teams.list()).map((team) => team.home.directory)
        const pruned = await Symlinks.unexclude({
          commonDir: place.team.commonDir,
          copies: Object.keys(place.record?.linkCopies ?? {}),
          homes,
        })
        if (!pruned.ok) services.log.warn("undo_exclude_failed", { areaID, message: pruned.message })
        // 4.12: the last folder own made inside the main folder gone, own's `.gitignore` there goes too.
        await Home.unignore(place.team.worktreeRoot)
      }
      await services.write(input.op.teamID, () => services.registry.areas.remove(input.op.teamID, areaID))
      return { ok: true }
    },
    verify: async (input) => {
      const areaID = decodeArea(input.step.args).areaID
      return (await input.services.registry.areas.get(input.op.teamID, areaID)) === undefined
        ? { ok: true }
        : { ok: false, note: "영역 기록이 남아 있어요" }
    },
  }
}

/**
 * `worktree remove` without `--force` after the identity check (06 §4.5); git refuses a folder with changes. own's
 * shared-folder links go first, unfollowed (4.11).
 */
async function remove(services: Services.Context, place: Place) {
  const gitDir =
    place.record?.gitDir ??
    (await Identity.observe(place.directory).then((observed) => (observed.ok ? observed.gitDir : undefined)))
  if (gitDir === undefined) return { ok: false as const, message: `작업 폴더가 아니에요: ${place.directory}` }
  const unlinked = await services.features().shared.unlink({ directory: place.directory, shared: place.team.shared })
  if (!unlinked.ok) return { ok: false as const, message: unlinked.message }
  const undone = await Worktree.undo({ directory: place.directory, gitDir, home: place.team.commonDir })
  return undone.ok ? { ok: true as const } : { ok: false as const, message: undone.message }
}

/** TI-4's exception: the branch the enable made goes while it is at the base and no folder has it checked out. */
async function branch(place: Place) {
  const ref = `refs/heads/${place.branch}`
  const tip = await Refs.read(place.team.commonDir, ref)
  if (tip === null || tip === undefined) return
  const base = place.record?.base.sha
  if (base === undefined ? await committed(place.team.commonDir, place.branch) : tip !== base) return
  const listed = await Worktree.list(place.team.commonDir)
  if (!listed.ok || listed.worktrees.some((item) => item.branch === ref)) return
  await Refs.removeIf(place.team.commonDir, { ref, oid: tip }, "own.team undo")
}

function archiveKind(): Steps.Kind {
  const archived = async (input: Steps.Input) => {
    const args = decodeArchive(input.step.args)
    const found = await input.services.http.session.get(args)
    return { args, found }
  }
  return {
    kind: "undo.archive",
    observe: async (input) => {
      const read = await archived(input)
      // A main whose creation never got through has nothing to archive; an unreachable service is not that.
      if (!read.found.ok)
        return read.found.status === 404
          ? { state: "skip", note: "대화가 없어 건너뛰었어요" }
          : { state: "failed", note: read.found.message }
      return read.found.value.metadata?.[ARCHIVED] === true ? { state: "satisfied" } : { state: "pending" }
    },
    act: async (input) => {
      const args = decodeArchive(input.step.args)
      await archive(input.services, args.sessionID, args.directory)
      return { ok: true }
    },
    verify: async (input) => {
      const read = await archived(input)
      return read.found.ok && read.found.value.metadata?.[ARCHIVED] === true
        ? { ok: true }
        : { ok: false, note: "보관 표시를 확인하지 못했어요" }
    },
  }
}

function markKind(): Steps.Kind {
  const target = async (input: Steps.Input) => {
    const opID = decodeMark(input.step.args).opID
    const op = await input.services.journal.get(input.op.teamID, opID)
    if (!op) throw new Error(`작업 기록이 없어요: ${opID}`)
    return op
  }
  return {
    kind: "undo.mark",
    observe: async (input) =>
      (await target(input)).undo?.by === input.op.id ? { state: "satisfied" } : { state: "pending" },
    act: async (input) => {
      await input.services.write(input.op.teamID, async () => {
        const op = await target(input)
        await input.services.journal.put({ ...op, undo: { ...op.undo, available: false, by: input.op.id } })
      })
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

/**
 * The team record goes with everything of the team but the op records (the undo op still writes its result, and the
 * undone enable keeps its mark), or the team goes back `off`.
 */
function registryKind(): Steps.Kind {
  return {
    kind: "undo.registry",
    observe: async (input) => {
      const previous = decodeRegistry(input.step.args).previous
      const team = await input.services.registry.teams.get(input.op.teamID)
      if (previous === "none") return team === undefined ? { state: "satisfied" } : { state: "pending" }
      if (previous === "off") return team?.state === "off" ? { state: "satisfied" } : { state: "pending" }
      return { state: "satisfied" }
    },
    act: async (input) => {
      const services = input.services
      const teamID = input.op.teamID
      const previous = decodeRegistry(input.step.args).previous
      const rev = await services.write(teamID, async () => {
        const team = await teamOf(services, teamID)
        if (previous === "off") return (await services.registry.teams.put({ ...team, state: "off" })).rev
        const keys = await Promise.all(
          Keys.ofTeam(teamID)
            .filter((key) => key !== Keys.prefix.ops(teamID))
            .map(async (key) => (key.endsWith(":") ? (await services.kv.scan(key)).map((entry) => entry.key) : [key])),
        )
        await Promise.all(keys.flat().map((key) => services.kv.remove(key)))
        return team.rev + 1
      })
      services.hub.publish({ name: "team.changed", data: { teamID, rev } })
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

/**
 * The shared folders an undone enable protected (4.11): own's links to them in every area folder deleted unfollowed,
 * the protection taken off (`Shared.unprotect`), their `info/exclude` lines and records removed. Each part is a no-op
 * when it is done already, so the step just acts again on resume.
 */
function sharedKind(): Steps.Kind {
  return {
    kind: "undo.shared",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const services = input.services
      const names = new Set(decodeShared(input.step.args).names)
      const team = await teamOf(services, input.op.teamID)
      const records = team.shared.filter((record) => names.has(record.name))
      if (records.length === 0) return { ok: true }
      const areas = (await services.registry.areas.list(team.id)).filter((area) => fs.existsSync(area.directory))
      const unlinked = await Promise.all(
        areas.map((area) => services.features().shared.unlink({ directory: area.directory, shared: records })),
      )
      const unprotected = await Promise.all(
        records.map((record) =>
          Shared.unprotect(record.target, record.protect, input.signal, Shared.saved(team, record.name)),
        ),
      )
      const failed = [...unlinked, ...unprotected].flatMap((result) => (result.ok ? [] : [result.message]))
      if (failed.length > 0) return { ok: false, note: failed.join("; ") }
      await Shared.unexclude(
        team.commonDir,
        records.map((record) => record.name),
      )
      const written = await services.write(team.id, async () => {
        const current = await services.registry.teams.get(team.id)
        if (!current) return undefined
        return services.registry.teams.put({
          ...current,
          shared: current.shared.filter((record) => !names.has(record.name)),
        })
      })
      if (written) services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}
