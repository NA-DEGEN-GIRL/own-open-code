export * as AssetsVerify from "./verify.js"

import path from "node:path"
import { Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { Hash } from "@own/runtime"
import { Hold } from "../dispatch/hold.js"
import { Cone } from "../git/cone.js"
import { Home } from "../git/home.js"
import { Identity } from "../git/identity.js"
import { Lfs } from "../git/lfs.js"
import { Measure } from "../git/measure.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import { Verify } from "../integrate/verify.js"
import { Teams } from "../registry/team.js"
import { BunCache } from "./bun-cache.js"
import { Symlinks } from "./symlinks.js"

/**
 * The asset check folder (06 §4.10, §7.2 step 7): `<worktreeRoot>/.assets`, the one full worktree own keeps for itself,
 * with a detached HEAD, locked `own.team assets`, no session and no user work. The home and the area folders are never
 * borrowed (12.2): the user's editor and engine work there. It is made when first needed, and that asks first (0.3)
 * when the heavy folders' bytes reach `askDiskBytes` or the LFS objects missing from the shared store reach
 * `askDownloadBytes`; before the answer nothing is added or fetched. Objects already in the shared LFS store
 * (`<common dir>/lfs`, used by every worktree) are never fetched again, so a run needs no network for them.
 *
 * A run holds the folder's lease (one run at a time in the controller, whichever integration asks) and moves the
 * folder to the candidate K:
 *
 *   identity  the recorded worktree, detached (4.3, TI-14); anything else is `broken` and left as it is
 *   keep      HEAD is not the K own last moved it to (someone opened it in the engine and committed): the commits only
 *             it holds go to `refs/own/keep/<HEAD>` before anything else (TI-8)
 *   hold      uncommitted changes (a `.meta` the last check wrote, a changed link copy) go to
 *             `refs/own/hold/assets/<id>` (8.7, TI-1)
 *   fetch     the LFS objects of the files that change from HEAD to K and are missing from the shared store, with
 *             `lfs fetch -I <paths>` (never without a list, 4.9)
 *   reset     reset --hard K, then clean -fd: ignored files stay (the engine cache, `Library/`, `DerivedDataCache/`),
 *             so only the changed files are written again and the engine imports only what changed
 *   links     the link copies, as in `.verify` (4.12)
 *   checks    `commands.assets` one after another until one fails, with own's Bun cache (`BunCache.env`); exit code,
 *             duration and the output's last 64 KB in `integrations/<igID>.assets.log` (6.6)
 *
 * The facts stay in git; the team records folder keeps `assets/folder.json` (the identity, the K own moves the folder
 * to and the K it was last prepared for, the link copies) and `assets/<K>.json` (each command's result as soon as it
 * ends, with the refs the run made). A restarted run continues (06 §2.6 (d)): a finished result for K answers without
 * running anything (a failed one only for the integration that ran it), and a folder still prepared for K runs only
 * the commands without a result.
 */

export const DIRECTORY = ".assets"

export const LOCK_REASON = "own.team assets"

/** The hold refs of the folder: `refs/own/hold/assets/<id>` (06 §2.4). */
export const SCOPE = "assets"

/** `<worktreeRoot>/.assets`. */
export function directory(team: Pick<OwnTeam.Team, "worktreeRoot">) {
  return path.join(team.worktreeRoot, DIRECTORY)
}

/** The record files in the team records folder (2.4). */
export function files(team: Pick<OwnTeam.Team, "id" | "commonDir">, integrationID: string, candidate: string) {
  const records = Teams.records(team)
  return {
    folder: path.join(records, "assets", "folder.json"),
    results: path.join(records, "assets", `${candidate}.json`),
    log: path.join(records, "integrations", `${integrationID}.assets.log`),
  }
}

export type Needed =
  | { readonly ok: true; readonly needed: false }
  | {
      readonly ok: true
      readonly needed: true
      /** Files of heavy folders that change from B to K. */
      readonly paths: ReadonlyArray<string>
      /** The owner reported this candidate with an engine run (`Area.candidate.assets`). */
      readonly requested: boolean
    }
  | { readonly ok: false; readonly message: string }

/**
 * Whether the check runs for an integration (4.10 "언제 필요한가"): the team has heavy folders and asset commands, and K
 * changes a file of a heavy folder (`diff --name-only B K`) or the owner reported the candidate C with an engine run.
 */
export async function needed(input: {
  readonly team: OwnTeam.Team
  readonly area: Pick<OwnTeam.Area, "candidate">
  /** C. */
  readonly source: string
  /** B. */
  readonly base: string
  /** K. */
  readonly candidate: string
  /** The heavy list as it is once K is the target (06 §4.4, the integration's step 5½); default the team's list. */
  readonly heavy?: ReadonlyArray<string>
  readonly signal?: AbortSignal
}): Promise<Needed> {
  const heavy = input.heavy ?? input.team.heavy.dirs
  if (heavy.length === 0 || input.team.commands.assets.length === 0) return { ok: true, needed: false }
  const diff = await Git.run(["diff", "--name-only", "-z", "--no-renames", input.base, input.candidate], {
    cwd: input.team.commonDir,
    worktree: true,
    signal: input.signal,
  })
  if (!diff.ok) return { ok: false, message: diff.message }
  const paths = Porcelain.fields(diff.stdout).filter((file) => Cone.covers(heavy, file))
  const requested = input.area.candidate?.assets === true && input.area.candidate.sha === input.source
  if (paths.length === 0 && !requested) return { ok: true, needed: false }
  return { ok: true, needed: true, paths, requested }
}

/** What making the folder at a commit takes (0.3, 4.10). */
export interface Creation {
  /** Bytes of the heavy folders the full folder writes (LFS files at their real size). */
  readonly disk: number
  /** Bytes of the LFS objects missing from the shared store. */
  readonly download: number
  /** `disk` reaches `askDiskBytes` or `download` reaches `askDownloadBytes`: the user answers first. */
  readonly confirm: boolean
}

/** {@link Creation} at `rev`, measured in the home without git-lfs (4.4). */
export async function creation(
  team: OwnTeam.Team,
  rev: string,
): Promise<({ readonly ok: true } & Creation) | { readonly ok: false; readonly message: string }> {
  const measured = await Measure.measure(team.home.directory, rev, { ignoredMs: 0 })
  if (!measured.ok) return measured
  const disk = Object.entries(measured.direct).reduce(
    (sum, [dir, item]) => (dir !== "" && Cone.covers(team.heavy.dirs, dir) ? sum + item.bytes : sum),
    0,
  )
  const download = measured.total.lfsMissing
  const policy = team.policy
  const confirm = (disk > 0 && disk >= policy.askDiskBytes) || (download > 0 && download >= policy.askDownloadBytes)
  return { ok: true, disk, download, confirm }
}

export interface Input {
  readonly team: OwnTeam.Team
  readonly integrationID: string
  /** K. */
  readonly candidate: string
  /** Names this run's hold ref, `refs/own/hold/assets/<hold>` (the op's id, 8.7). */
  readonly hold: string
  /** Author and commit date of the hold ref in epoch milliseconds (`Op.createdAt`, 8.7). */
  readonly at: number
  /** The user agreed to make the folder (a confirm step answered `do`). */
  readonly confirmed?: boolean
  readonly signal?: AbortSignal
  /** Before each check: `Integration.checks` (`검사 1/2`, 9.7). */
  readonly progress?: (checks: { readonly current: number; readonly total: number }) => Promise<void>
}

/** A keep ref of commits made in the folder (TI-8). `created`: made by this call, not by the run it continues. */
export interface Kept {
  readonly ref: string
  readonly sha: string
  readonly created: boolean
}

/** The hold ref of changes left in the folder (8.7), with the disk bytes of what it copied. */
export interface Held extends Kept {
  readonly bytes: number
}

export type Outcome =
  | {
      readonly state: "done"
      /** `Integration.verify.assets`; `ok` says whether the checks passed. */
      readonly result: OwnTeam.AssetsResult
      /** A finished result for K answered: nothing ran and the folder was not touched. */
      readonly reused: boolean
      readonly kept: ReadonlyArray<Kept>
      readonly held?: Held
    }
  /** The folder does not exist and making it waits for the user (0.3); nothing was added or fetched. */
  | ({ readonly state: "confirm" } & Creation)
  /** The folder is not the worktree own recorded (TI-14); nothing changed in it. */
  | { readonly state: "broken"; readonly message: string }
  | { readonly state: "failed"; readonly message: string }
  /** The signal stopped it; the command it stopped has no result and runs again. */
  | { readonly state: "stopped" }

/**
 * Moves `.assets` to K and runs the asset commands there, inside the folder's lease (see the module comment).
 * `holder`: what keeps the lease queue, the controller's services (one per process and build, 06 §2.6).
 */
export async function run(input: Input, holder: object): Promise<Outcome> {
  const release = await lease(holder, directory(input.team), input.signal)
  if (!release) return { state: "stopped" }
  return checked(input).finally(release)
}

async function checked(input: Input): Promise<Outcome> {
  const team = input.team
  const where = files(team, input.integrationID, input.candidate)
  const commands = Hash.sha256(JSON.stringify(team.commands.assets))
  const found = await Verify.read(where.results, decodeResults)
  const earlier = found?.commands === commands && found.candidate === input.candidate ? found : undefined
  const total = team.commands.assets.length
  if (earlier && Verify.finished(earlier, total)) {
    const own = earlier.integrationID === input.integrationID
    // Another integration's result tells nothing about refs: they belong to the run that made them.
    if (own || Verify.result(earlier).ok) return done(own ? earlier : { ...earlier, kept: [], held: undefined }, true)
  }

  const folder = await prepare(input, where.folder)
  if (folder.state === "failed" && input.signal?.aborted) return { state: "stopped" }
  if (folder.state !== "ready") return folder
  // A folder prepared again (reset, clean) lost what earlier commands left in it: they all run again. A resumed one
  // keeps the results that passed and runs a failed command again (a failed result of another integration).
  const start: Results =
    earlier && folder.resumed
      ? {
          ...earlier,
          integrationID: input.integrationID,
          log: where.log,
          runs: earlier.runs.filter((item) => item.code === 0),
        }
      : {
          candidate: input.candidate,
          integrationID: input.integrationID,
          commands,
          log: where.log,
          kept: folder.kept.map((item) => ({ ref: item.ref, sha: item.sha })),
          ...(folder.held === undefined
            ? {}
            : { held: { ref: folder.held.ref, sha: folder.held.sha, bytes: folder.held.bytes } }),
          runs: [],
        }
  await Verify.save(where.results, start)
  const next = async (current: Results): Promise<Results | undefined> => {
    if (Verify.finished(current, total)) return current
    const index = current.runs.length
    await input.progress?.({ current: index + 1, total })
    const ran = await Verify.execute(team.commands.assets[index], {
      cwd: folder.directory,
      log: where.log,
      env: BunCache.env(team),
      signal: input.signal,
    })
    if (!ran) return undefined
    const updated = { ...current, runs: [...current.runs, ran] }
    await Verify.save(where.results, updated)
    return next(updated)
  }
  const ended = await next(start)
  if (!ended) return { state: "stopped" }
  const refs = [...folder.kept, ...(folder.held ? [folder.held] : [])]
  return done(ended, false, new Set(refs.flatMap((item) => (item.created ? [item.ref] : []))))
}

// ---------------------------------------------------------------------------------------------------------------
// Records

const Ref = Schema.Struct({ ref: Schema.String, sha: OwnTeam.Sha })

/** `assets/folder.json`. */
const Folder = Schema.Struct({
  directory: Schema.String,
  /** The identity checked before anything changes the folder (4.3). */
  gitDir: Schema.String,
  /** The K own last moved the folder to: a HEAD anywhere else was moved by someone else (TI-8). */
  sha: optional(OwnTeam.Sha),
  /** The K a reset is about to move it to, written first: a run stopped half way knows that HEAD as its own. */
  moving: optional(OwnTeam.Sha),
  /** The K the folder was last fully prepared for (reset, clean, link copies). */
  prepared: optional(OwnTeam.Sha),
  linkCopies: optional(Schema.Record(Schema.String, OwnTeam.Sha)),
})
type Folder = typeof Folder.Type

/** `assets/<K>.json`. */
const Results = Schema.Struct({
  candidate: OwnTeam.Sha,
  /** The integration that ran them: a failed result answers only that integration again. */
  integrationID: Schema.String,
  /** The asset commands the results belong to: other commands run again. */
  commands: Schema.String,
  log: Schema.String,
  /** The refs the run made before moving the folder. */
  kept: Schema.Array(Ref),
  held: optional(Schema.Struct({ ...Ref.fields, bytes: NonNegativeInt })),
  runs: Schema.Array(Verify.Run),
})
type Results = typeof Results.Type

const decodeFolder = Schema.decodeUnknownOption(Schema.fromJsonString(Folder))
const decodeResults = Schema.decodeUnknownOption(Schema.fromJsonString(Results))

function done(results: Results, reused: boolean, created: ReadonlySet<string> = new Set()): Outcome {
  return {
    state: "done",
    reused,
    result: {
      ...Verify.result(results),
      sha: results.candidate,
      ...(results.held === undefined ? {} : { heldRef: results.held.ref }),
      ...(results.kept.length === 0 ? {} : { keptRefs: results.kept.map((item) => item.ref) }),
    },
    kept: results.kept.map((item) => ({ ...item, created: created.has(item.ref) })),
    ...(results.held === undefined ? {} : { held: { ...results.held, created: created.has(results.held.ref) } }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The folder

type Prepared =
  | {
      readonly state: "ready"
      readonly directory: string
      /** Still prepared for K by an earlier run: nothing was kept, held, reset or cleaned. */
      readonly resumed: boolean
      readonly kept: ReadonlyArray<Kept>
      readonly held?: Held
    }
  | Exclude<Outcome, { readonly state: "done" }>

/** Makes or finds the folder and moves it to K (see the module comment). */
async function prepare(input: Input, record: string): Promise<Prepared> {
  const team = input.team
  const candidate = input.candidate
  const dir = directory(team)
  // 4.12: inside the main folder, own's `.gitignore` keeps the folder out of listings.
  await Home.ignore(team.worktreeRoot)
  const recorded = await Verify.read(record, decodeFolder)
  const known = recorded && Identity.same(recorded.directory, dir) ? recorded : undefined
  const plan: Worktree.Detached = {
    detach: true,
    lockReason: LOCK_REASON,
    home: team.home.directory,
    directory: dir,
    base: candidate,
    shape: "plain",
    cone: [],
    heavy: team.heavy.dirs,
    ...(known === undefined ? {} : { gitDir: known.gitDir }),
  }
  const observed = await Worktree.observe(plan)
  if (!observed.ok) return Verify.refused(observed)
  if (observed.state === "absent" && input.confirmed !== true) {
    const sized = await creation(team, candidate)
    if (!sized.ok) return { state: "failed", message: sized.message }
    if (sized.confirm) return { state: "confirm", disk: sized.disk, download: sized.download, confirm: true }
  }
  // Past the answer above (or a folder made half way after it): Worktree.create does not ask again.
  const made =
    observed.state === "populated"
      ? observed
      : await Worktree.create(plan, {
          askDownloadBytes: team.policy.askDownloadBytes,
          confirmed: true,
          signal: input.signal,
        })
  if (!made.ok) return Verify.refused(made)
  if (made.state === "confirm") return { state: "failed", message: "큰 파일 검사 폴더가 확인을 기다려요" }
  const target = { directory: dir, gitDir: made.gitDir }
  const head = await Git.run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: dir, worktree: true })
  const at = head.ok ? head.stdout.trim() : ""
  if (!Git.isOid(at))
    return { state: "failed", message: `${dir}의 지금 위치를 읽지 못했어요: ${head.ok ? at : head.message}` }
  // A folder made now is own's at its HEAD and has no link copies, whatever an earlier folder recorded.
  const folder: Folder =
    observed.state === "populated"
      ? { ...known, directory: dir, gitDir: made.gitDir }
      : { directory: dir, gitDir: made.gitDir, sha: at }
  if (observed.state === "populated" && folder.prepared === candidate && at === candidate)
    return { state: "ready", directory: dir, resumed: true, kept: [] }

  const kept = folder.sha === at || folder.moving === at ? { ok: true as const, kept: [] } : await keep(team, at)
  if (!kept.ok) return { state: "failed", message: kept.message }
  const held = await hold(input, target, folder.linkCopies)
  if (held.state !== "ready") return held
  await Verify.save(record, { ...folder, moving: candidate })
  const fetched = await prefetch(dir, at, candidate, input.signal)
  if (!fetched.ok) return { state: "failed", message: fetched.message }
  const reset = await Verify.change(target, ["reset", "-q", "--hard", candidate], input.signal)
  if (reset.state !== "ready") return reset
  const clean = await Verify.change(target, ["clean", "-fd"], input.signal)
  if (clean.state !== "ready") return clean
  const links = await Symlinks.apply({
    area: { directory: dir, gitDir: made.gitDir, shape: "plain", linkCopies: folder.linkCopies },
    fix: team.env.symlinkFix,
    signal: input.signal,
  })
  if (!links.ok) return { state: links.error === "broken" ? "broken" : "failed", message: links.message }
  await Verify.save(record, {
    directory: dir,
    gitDir: made.gitDir,
    sha: candidate,
    prepared: candidate,
    linkCopies: links.linkCopies,
  })
  return {
    state: "ready",
    directory: dir,
    resumed: false,
    kept: kept.kept,
    ...(held.held === undefined ? {} : { held: held.held }),
  }
}

/**
 * TI-8: when HEAD holds commits no branch, remote or tag has (`rev-list HEAD --not --branches --remotes --tags`), they
 * go to `refs/own/keep/<HEAD>` (create-only in the common dir; one that holds it already counts as made).
 */
async function keep(
  team: OwnTeam.Team,
  head: string,
): Promise<
  { readonly ok: true; readonly kept: ReadonlyArray<Kept> } | { readonly ok: false; readonly message: string }
> {
  const unique = await Git.run(["rev-list", "-n", "1", head, "--not", "--branches", "--remotes", "--tags"], {
    cwd: team.commonDir,
    worktree: true,
  })
  if (!unique.ok) return { ok: false, message: unique.message }
  if (!unique.stdout.split("\n").some(Git.isOid)) return { ok: true, kept: [] }
  const ref = `refs/own/keep/${head}`
  const created = await Refs.create(team.commonDir, { ref, oid: head }, "own.team keep")
  if (!created.ok) return { ok: false, message: created.message }
  return { ok: true, kept: [{ ref, sha: head, created: created.created }] }
}

/** TI-1: uncommitted changes and changed link copies go to the run's hold ref before the reset (8.7). */
async function hold(
  input: Input,
  target: Identity.Record,
  linkCopies: Folder["linkCopies"],
): Promise<
  { readonly state: "ready"; readonly held?: Held } | { readonly state: "broken" | "failed"; readonly message: string }
> {
  const changes = await Hold.changes(target.directory, input.signal)
  if (!changes.ok) return { state: "failed", message: changes.message }
  const links = await Hold.dirtyLinks({ directory: target.directory, linkCopies })
  if (changes.paths.length === 0 && links.length === 0) return { state: "ready" }
  const held = await Hold.create({ target, scope: SCOPE, id: input.hold, at: input.at, links, signal: input.signal })
  if (!held.ok) return { state: held.error === "identity" ? "broken" : "failed", message: held.message }
  return { state: "ready", held: { ref: held.ref, sha: held.sha, bytes: held.bytes, created: held.created } }
}

/**
 * The LFS objects of the files that change from `head` to K and are missing from the shared store, fetched before the
 * reset smudges them (4.10 step 4). Nothing missing runs nothing, so objects in the store need no network.
 */
async function prefetch(directory: string, head: string, candidate: string, signal?: AbortSignal) {
  if (head === candidate) return { ok: true as const }
  const diff = await Git.run(["diff", "--name-only", "-z", "--no-renames", head, candidate], {
    cwd: directory,
    worktree: true,
    signal,
  })
  if (!diff.ok) return { ok: false as const, message: diff.message }
  const changed = new Set(Porcelain.fields(diff.stdout))
  if (changed.size === 0) return { ok: true as const }
  const missing = await Lfs.missing(directory, candidate, (file) => changed.has(file))
  if (!missing.ok) return missing
  if (missing.count === 0) return { ok: true as const }
  const fetched = await Lfs.fetch(directory, Lfs.includes([], missing.objects), signal)
  if (fetched.ok) return { ok: true as const }
  return { ok: false as const, message: `큰 파일을 내려받지 못했어요: ${fetched.message}` }
}

// ---------------------------------------------------------------------------------------------------------------
// The lease

/** The lease queues by holder (the controller's services): the controller is the process singleton (06 §2.6). */
const LEASES = new WeakMap<object, Map<string, Promise<void>>>()

/**
 * The folder's lease: one run at a time in this process, in the order they asked. The queue is the controller's (the
 * one process singleton of the build, `singleton.ts`): every run, an integration's or an owner's engine run, is an op
 * step on it, and an op resumed after a restart takes the lease again. Resolves to the release, or `undefined` when
 * the signal stopped the wait.
 */
async function lease(holder: object, folder: string, signal?: AbortSignal) {
  const queues = LEASES.get(holder) ?? new Map<string, Promise<void>>()
  LEASES.set(holder, queues)
  const key = Identity.key(folder)
  const previous = queues.get(key) ?? Promise.resolve()
  const turn = Promise.withResolvers<void>()
  const tail = previous.then(() => turn.promise)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  const ready = await Promise.race([previous.then(() => true), aborted(signal).then(() => false)])
  if (ready) return () => turn.resolve()
  turn.resolve()
  return undefined
}

/** Resolves when `signal` aborts (never without one). */
function aborted(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    signal?.addEventListener("abort", () => resolve(), { once: true })
  })
}
