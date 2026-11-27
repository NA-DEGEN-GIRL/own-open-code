export * as TeamHome from "./home.js"

import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Symlinks } from "../assets/symlinks.js"
import { Classify } from "../git/classify.js"
import { Home } from "../git/home.js"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import type { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import { Services } from "../services.js"
import type { Steps } from "./steps.js"
import { Journal } from "./journal.js"

/**
 * The main folder and own's worktree locks (06 §3.2, §3.8, §8.6, TI-12).
 *
 * `team.home{teamID, directory}` moves the main folder (메인은 … 폴더에서 일합니다 [바꾸기]) as an undoable `home` op:
 * lock the new folder when it is a linked worktree, move the team main there (`session.move`, delivered when the main
 * is idle), record it, and release the old folder's lock. The step kinds that lock, release and restore locks are
 * shared by enable (home lock, re-locking on 다시 켜기), disable and undo:
 *
 *   team.lock     lock with own's reason (an own lock with another reason is replaced; another tool's is left alone)
 *   team.release  unlock own's lock, except a folder with worktrees nested inside: that one keeps a lock with the
 *                 reason `own: nested worktrees inside`, because removing the outer folder would take the nested
 *                 worktrees' uncommitted work along (3.8, 8.6)
 *   team.restore  put back the lock a folder had before an op (undo), with the same nested rule
 */

/** The lock own leaves on a folder that holds nested worktrees when the team lets it go (06 §3.8). */
export const NESTED = "own: nested worktrees inside"

/** The step kind that locks a folder (`{directory, reason}`). */
export const LOCK = "team.lock"

/** The lock reason of a linked home (an area's is `Worktree.lockReason`). */
export function reason(teamID: string) {
  return `own.team home:${teamID}`
}

/**
 * Lock reasons by worktree path as git prints them: what an op saw before it locked anything (undo restores it).
 * `undefined` when git cannot list the worktrees.
 */
export async function snapshot(commonDir: string): Promise<Record<string, string> | undefined> {
  const listed = await Worktree.list(commonDir)
  if (!listed.ok) return undefined
  return Object.fromEntries(
    listed.worktrees.flatMap((entry) => (entry.locked === undefined ? [] : [[entry.path, entry.locked] as const])),
  )
}

/**
 * 06 §4.12 (2026-10-27): a team whose area folders are inside its home (`<home>/.worktrees`, `Home.holder`) has
 * `/.worktrees/` in the repository's `info/exclude` (never `.gitignore`: nothing of the project changes), so the home's
 * status shows neither the areas nor `.verify` and `.assets`. Written once, by enable's registry step and before a new
 * area's folder; a line the user wrote for it counts, and the line stays when the team goes off (it hides nothing else).
 */
export function exclude(team: Pick<OwnTeam.Team, "commonDir" | "worktreeRoot">) {
  if (Home.holder(team.worktreeRoot) === undefined) return Promise.resolve()
  return Symlinks.rewrite(team.commonDir, Home.excluded)
}

/** The lock a folder had in a {@link snapshot}, matched by path. */
export function before(locks: Readonly<Record<string, string>>, directory: string) {
  return Object.entries(locks).find(([key]) => Classify.same(key, directory))?.[1] ?? null
}

export async function start(
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
  if (!Identity.same(located.commonDir, team.commonDir))
    return Services.failure("path_forbidden", "another repository", { path: input.directory, why: "invalid" })
  const listed = await Worktree.list(team.commonDir)
  if (!listed.ok) return Services.failure("not_git", listed.message, { directory: input.directory })
  const entry = listed.worktrees.find((item) => Identity.same(item.path, located.toplevel))
  const why = entry === undefined ? "invalid" : await refusal(services, team, entry)
  if (entry === undefined || why !== undefined)
    return Services.failure("path_forbidden", "this folder cannot be the main folder", {
      path: located.toplevel,
      why: why ?? "invalid",
    })
  const to: OwnTeam.Home = { directory: entry.path, linked: listed.worktrees[0] !== entry, chosenBy: "user" }
  const from = team.home
  const locks = await snapshot(team.commonDir)
  if (!locks) return Services.failure("not_git", "the worktrees cannot be listed", { directory: input.directory })
  const started = await services.runner.start({
    teamID: team.id,
    kind: "home",
    by: "user",
    undo: { available: true },
    steps: [
      ...(to.linked
        ? [{ id: "lock", kind: "team.lock", args: { directory: to.directory, reason: reason(team.id) } }]
        : []),
      { id: "move", kind: "home.move", args: { directory: to.directory } },
      { id: "registry", kind: "home.registry", args: { home: to, from, locks } },
      ...(from.linked && !Identity.same(from.directory, to.directory)
        ? [{ id: "release", kind: "team.release", args: { directory: from.directory, reason: reason(team.id) } }]
        : []),
    ],
  })
  if (!started.ok) return Services.failure("busy", "another team op is running", Journal.busy(started.op))
  return { ok: true, opID: started.op.id }
}

/** The steps that undo a `home` op: the old folder locked again, the main moved back, recorded, the new one restored. */
export function undo(op: OwnTeam.Op): ReadonlyArray<Steps.Spec> | undefined {
  const step = op.steps.find((item) => item.kind === "home.registry")
  if (!step) return undefined
  const args = decodeRegistry(step.args)
  const locked = op.steps.some((item) => item.kind === "team.lock" && item.state === "done")
  return [
    ...(args.from.linked
      ? [{ id: "lock", kind: "team.lock", args: { directory: args.from.directory, reason: reason(op.teamID) } }]
      : []),
    { id: "move", kind: "home.move", args: { directory: args.from.directory } },
    { id: "registry", kind: "home.registry", args: { home: args.from, from: args.home, locks: args.locks } },
    ...(locked
      ? [
          {
            id: "restore",
            kind: "team.restore",
            args: { directory: args.home.directory, before: before(args.locks, args.home.directory) },
          },
        ]
      : []),
  ]
}

/** Registers the lock kinds and the `home` op's kinds (from `ops/undo.ts`, once per controller). */
export function register(services: Services.Context) {
  services.steps.register(lockKind())
  services.steps.register(releaseKind())
  services.steps.register(restoreKind())
  services.steps.register(moveKind())
  services.steps.register(registryKind())
}

const LockArgs = Schema.Struct({ directory: Schema.String, reason: Schema.String })
const RestoreArgs = Schema.Struct({ directory: Schema.String, before: Schema.NullOr(Schema.String) })
const MoveArgs = Schema.Struct({ directory: Schema.String })
const RegistryArgs = Schema.Struct({
  home: OwnTeam.Home,
  from: OwnTeam.Home,
  locks: Schema.Record(Schema.String, Schema.String),
})

const decodeLock = Schema.decodeUnknownSync(LockArgs)
const decodeRestore = Schema.decodeUnknownSync(RestoreArgs)
const decodeMove = Schema.decodeUnknownSync(MoveArgs)
const decodeRegistry = Schema.decodeUnknownSync(RegistryArgs)

const GONE = "폴더가 없어 건너뛰었어요"
const FOREIGN = "다른 이유로 잠겨 있어 그대로 뒀어요"

/** Why a worktree cannot be the main folder (`path_forbidden.why`), or `undefined`. */
async function refusal(services: Services.Context, team: OwnTeam.Team, entry: Porcelain.Worktree) {
  const item = { path: entry.path, real: null, locked: entry.locked ?? null }
  if (Classify.hashPath(item)) return "hash" as const
  if (entry.prunable !== undefined) return "prunable" as const
  const areas = await services.registry.areas.list(team.id)
  if (areas.some((area) => area.state !== "retired" && Identity.same(area.directory, entry.path)))
    return "invalid" as const
  if (entry.locked !== undefined && entry.locked !== reason(team.id) && entry.locked !== NESTED)
    return "other-tool" as const
  if (Classify.otherTool({ ...item, locked: null }, team.patterns)) return "other-tool" as const
  // The folder that holds the team's `.worktrees` (06 §4.12 프로젝트 안) may be the main folder again.
  const holder = Home.holder(team.worktreeRoot)
  if (Classify.inside(entry.path, team.worktreeRoot) && !(holder !== undefined && Classify.same(entry.path, holder)))
    return "nested" as const
  return undefined
}

async function entryOf(commonDir: string, directory: string) {
  const listed = await Worktree.list(commonDir)
  if (!listed.ok) throw new Error(listed.message)
  return { entry: listed.worktrees.find((item) => Classify.same(item.path, directory)), all: listed.worktrees }
}

function nests(all: ReadonlyArray<Porcelain.Worktree>, directory: string) {
  return all.some((item) => !Classify.same(item.path, directory) && Classify.inside(directory, item.path))
}

async function git(commonDir: string, args: ReadonlyArray<string>) {
  const result = await Git.run(["worktree", ...args], { cwd: commonDir, write: true, worktree: true })
  if (!result.ok) throw new Error(result.message)
}

async function commonDir(services: Services.Context, teamID: string) {
  const team = await services.registry.teams.get(teamID)
  if (!team) throw new Error(`팀 기록이 없어요: ${teamID}`)
  return team.commonDir
}

function lockKind(): Steps.Kind {
  return {
    kind: "team.lock",
    observe: async (input) => {
      const args = decodeLock(input.step.args)
      const found = await entryOf(await commonDir(input.services, input.op.teamID), args.directory)
      if (!found.entry || found.entry.prunable !== undefined) return { state: "skip", note: GONE }
      if (found.entry.locked === args.reason) return { state: "satisfied" }
      if (found.entry.locked !== undefined && !Classify.ownLock(found.entry.locked))
        return { state: "skip", note: FOREIGN }
      return { state: "pending" }
    },
    act: async (input) => {
      const args = decodeLock(input.step.args)
      const dir = await commonDir(input.services, input.op.teamID)
      const found = await entryOf(dir, args.directory)
      if (found.entry?.locked !== undefined) await git(dir, ["unlock", args.directory])
      await git(dir, ["lock", "--reason", args.reason, args.directory])
      return { ok: true }
    },
    verify: async (input) => {
      const args = decodeLock(input.step.args)
      const found = await entryOf(await commonDir(input.services, input.op.teamID), args.directory)
      return found.entry?.locked === args.reason ? { ok: true } : { ok: false, note: "잠금을 확인하지 못했어요" }
    },
  }
}

/**
 * Unlocks `directory`, or keeps a lock with {@link NESTED} when worktrees are nested inside it (a `lock-kept` line):
 * `team.release`, `team.restore` with nothing before, and undo of a kept area.
 */
export async function release(input: Pick<Steps.Input, "summary">, dir: string, directory: string) {
  const found = await entryOf(dir, directory)
  if (found.entry?.locked !== undefined) await git(dir, ["unlock", directory])
  if (!nests(found.all, directory)) return { ok: true as const }
  await git(dir, ["lock", "--reason", NESTED, directory])
  input.summary({ kind: "lock-kept", directory })
  return { ok: true as const }
}

function released(locked: string | undefined) {
  return locked === undefined || locked === NESTED
}

function releaseKind(): Steps.Kind {
  return {
    kind: "team.release",
    observe: async (input) => {
      const args = decodeLock(input.step.args)
      const found = await entryOf(await commonDir(input.services, input.op.teamID), args.directory)
      if (!found.entry) return { state: "skip", note: GONE }
      if (found.entry.locked === NESTED) input.summary({ kind: "lock-kept", directory: args.directory })
      if (released(found.entry.locked)) return { state: "satisfied" }
      if (found.entry.locked !== args.reason) return { state: "skip", note: FOREIGN }
      return { state: "pending" }
    },
    act: async (input) => {
      const args = decodeLock(input.step.args)
      return release(input, await commonDir(input.services, input.op.teamID), args.directory)
    },
    verify: async (input) => {
      const args = decodeLock(input.step.args)
      const found = await entryOf(await commonDir(input.services, input.op.teamID), args.directory)
      return released(found.entry?.locked) ? { ok: true } : { ok: false, note: "잠금이 그대로예요" }
    },
  }
}

function restoreKind(): Steps.Kind {
  return {
    kind: "team.restore",
    observe: async (input) => {
      const args = decodeRestore(input.step.args)
      const found = await entryOf(await commonDir(input.services, input.op.teamID), args.directory)
      if (!found.entry) return { state: "skip", note: GONE }
      const locked = found.entry.locked ?? null
      if (locked === args.before) return { state: "satisfied" }
      if (args.before === null && locked === NESTED) {
        input.summary({ kind: "lock-kept", directory: args.directory })
        return { state: "satisfied" }
      }
      if (locked !== null && !Classify.ownLock(locked)) return { state: "skip", note: FOREIGN }
      return { state: "pending" }
    },
    act: async (input) => {
      const args = decodeRestore(input.step.args)
      const dir = await commonDir(input.services, input.op.teamID)
      if (args.before === null) return release(input, dir, args.directory)
      const found = await entryOf(dir, args.directory)
      if (found.entry?.locked !== undefined) await git(dir, ["unlock", args.directory])
      await git(dir, ["lock", "--reason", args.before, args.directory])
      return { ok: true }
    },
    verify: async (input) => {
      const args = decodeRestore(input.step.args)
      const found = await entryOf(await commonDir(input.services, input.op.teamID), args.directory)
      const locked = found.entry?.locked ?? null
      const ok = args.before === null ? released(locked ?? undefined) : locked === args.before
      return ok ? { ok: true } : { ok: false, note: "잠금을 되돌리지 못했어요" }
    },
  }
}

/** The team main session is where `directory` is, or a move there waits in its inbox (core delivers it when idle). */
async function moved(services: Services.Context, teamID: string, directory: string) {
  const team = await services.registry.teams.get(teamID)
  if (!team) throw new Error(`팀 기록이 없어요: ${teamID}`)
  const ref = { sessionID: team.main.sessionID, directory }
  const session = await services.http.session.get(ref)
  if (!session.ok) throw new Error(`팀 메인 대화를 읽지 못했어요: ${session.message}`)
  if (Identity.same(session.value.location.directory, directory)) return { team, done: true }
  const inbox = await services.http.inbox.list(ref)
  return { team, done: inbox.ok && inbox.value.some((item) => item.type === "move") }
}

function moveKind(): Steps.Kind {
  return {
    kind: "home.move",
    observe: async (input) => {
      const args = decodeMove(input.step.args)
      const found = await moved(input.services, input.op.teamID, args.directory)
      return found.done ? { state: "satisfied" } : { state: "pending" }
    },
    act: async (input) => {
      const args = decodeMove(input.step.args)
      const found = await moved(input.services, input.op.teamID, args.directory)
      const instance = input.services.instance(args.directory)
      if (!instance) return { ok: false, note: "이 폴더의 팀 서비스가 아직 준비되지 않았어요" }
      // `queue`: the move waits for the main's next idle boundary instead of cutting into a running turn.
      await instance.ctx.session.move({
        sessionID: found.team.main.sessionID,
        directory: args.directory,
        delivery: "queue",
      })
      return { ok: true }
    },
    verify: async (input) => {
      const args = decodeMove(input.step.args)
      const found = await moved(input.services, input.op.teamID, args.directory)
      return found.done ? { ok: true } : { ok: false, note: "팀 메인 대화를 옮기지 못했어요" }
    },
  }
}

function registryKind(): Steps.Kind {
  return {
    kind: "home.registry",
    observe: async (input) => {
      const args = decodeRegistry(input.step.args)
      const team = await input.services.registry.teams.get(input.op.teamID)
      if (!team) return { state: "failed", note: "팀을 찾을 수 없어요" }
      return Identity.same(team.home.directory, args.home.directory) && team.home.chosenBy === args.home.chosenBy
        ? { state: "satisfied" }
        : { state: "pending" }
    },
    act: async (input) => {
      const args = decodeRegistry(input.step.args)
      const written = await input.services.write(input.op.teamID, async () => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        return team ? input.services.registry.teams.put({ ...team, home: args.home }) : undefined
      })
      if (!written) return { ok: false, note: "팀을 찾을 수 없어요" }
      input.services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
      return { ok: true }
    },
    verify: async (input) => {
      const args = decodeRegistry(input.step.args)
      const team = await input.services.registry.teams.get(input.op.teamID)
      return team && Identity.same(team.home.directory, args.home.directory)
        ? { ok: true }
        : { ok: false, note: "메인 폴더를 기록하지 못했어요" }
    },
  }
}
