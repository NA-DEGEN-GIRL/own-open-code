export * as Worktree from "./worktree.js"

import fs from "node:fs"
import path from "node:path"
import { Cone } from "./cone.js"
import { Identity } from "./identity.js"
import { Lfs } from "./lfs.js"
import { Porcelain } from "./porcelain.js"
import { Refs } from "./refs.js"
import { Git } from "./run.js"

/**
 * A new area worktree (06 §4.5):
 *
 *   1  git -C <home> worktree add --no-checkout --lock --reason "own.team area:<id>" -b <slug> <dir> <base>
 *   2  (code)  git -C <dir> sparse-checkout set --cone --sparse-index --stdin
 *   3  LFS objects inside the cone missing from the shared store: at or above `askDownloadBytes` stop for a
 *      confirmation; otherwise git -C <dir> lfs fetch -I <list>
 *   4  git -C <dir> read-tree -mu HEAD          (not checkout: no post-checkout hook)
 *   5  status --porcelain=v2 -z is empty; (code) every heavy folder is one `dir/` line of ls-files --sparse and
 *      index.sparse is true for the worktree
 *   6  worktree list shows `locked own.team area:<id>`; the absolute git dir is the identity to record
 *
 * Step 1 locks in the same command: right after `--no-checkout` the index is empty and status shows every file as a
 * staged deletion (`D.`), so a commit at that moment would delete the whole repository ([R-review] e7). {@link create}
 * observes first and resumes: an empty index or one with only `D.` entries runs steps 2-4 again (a failed step 4
 * leaves an empty index and some files, [R-lazy] C/wt-f). `plain` skips step 2.
 *
 * The verify folder `.verify` (06 §7.2 step 6) is made the same way from a {@link Detached} plan: step 1 is
 * `worktree add --no-checkout --lock --reason "own.team verify" --detach <dir> <base>`, with no branch.
 */

export interface Plan {
  /** The checkout `worktree add` runs in (the team home). */
  readonly home: string
  /** The new folder: a native absolute path without `#` (06 §4.12). */
  readonly directory: string
  /** The new branch (the area slug, 06 §4.5 "이름과 위치"). */
  readonly branch: string
  /** The commit the branch starts at (full object name). */
  readonly base: string
  readonly areaID: string
  /** `code`: sparse with {@link cone}; `plain`: no sparse-checkout (no heavy folders, or Git 2.40-2.41). */
  readonly shape: "code" | "plain"
  /** The cone folders ({@link Cone.compute}); ignored for `plain`. */
  readonly cone: readonly string[]
  /** The team's heavy folders: step 5 checks they stay collapsed. */
  readonly heavy: readonly string[]
  /** The git dir an earlier call returned, when the caller recorded it: a resume then checks it (06 §4.3). */
  readonly gitDir?: string
}

/**
 * A worktree own keeps for itself (the verify folder `.verify`, 06 §7.2 step 6): a detached HEAD at `base` instead of
 * a branch, locked with `lockReason`. When observed, a detached HEAD at any commit is this worktree (its owner moves
 * it to the next candidate); one with a branch checked out is not.
 */
export interface Detached extends Omit<Plan, "branch" | "areaID"> {
  readonly detach: true
  readonly lockReason: string
}

export interface Options {
  /** Missing LFS bytes at or above this stop at step 3 for a confirmation (`policy.askDownloadBytes`, 06 §2.4). */
  readonly askDownloadBytes: number
  /** The user confirmed the download (the confirm step answered `do`). */
  readonly confirmed?: boolean
  readonly signal?: AbortSignal
}

export type Step = 1 | 2 | 3 | 4 | 5 | 6

export type Failure =
  /** Not a path own creates in: not native absolute, a `#`, or a folder that is something else already. */
  | "path_forbidden"
  /** The branch exists at another commit. */
  | "branch_exists"
  /** The folder is not the worktree it should be (06 §4.3); `broken` says how. */
  | "broken"
  /** A git command failed; `message` has its stderr. */
  | "git"
  /** Steps 5-6 found something else than a clean, collapsed, locked worktree. */
  | "verify"

export type Created =
  | {
      readonly ok: true
      readonly state: "ready"
      /** `rev-parse --absolute-git-dir`: the identity to record as `area.gitDir` (step 6). */
      readonly gitDir: string
      /** The worktree existed already (a resumed step). */
      readonly resumed: boolean
      /** LFS objects the cone needed from outside the shared store. */
      readonly fetched: { readonly count: number; readonly bytes: number }
    }
  /** Stopped at step 3: the caller turns this into a confirm step and calls again with `confirmed`. */
  | { readonly ok: true; readonly state: "confirm"; readonly gitDir: string; readonly missing: Lfs.Missing }
  | {
      readonly ok: false
      readonly step: Step
      readonly error: Failure
      readonly broken?: "missing" | "identity"
      readonly message: string
    }

/** The lock reason of an area worktree (06 §4.5 step 1). */
export function lockReason(areaID: string) {
  return `own.team area:${areaID}`
}

/** Steps 1-6, resumable: call again after a failure, a restart or a confirmation. */
export async function create(plan: Plan | Detached, options: Options): Promise<Created> {
  const refused = refusal(plan)
  if (refused !== undefined) return fail(1, "path_forbidden", refused)
  const found = await observe(plan)
  if (!found.ok) return found
  const added = found.state === "absent" ? await add(plan) : found
  if (!added.ok) return added
  const target = { directory: plan.directory, gitDir: added.gitDir }
  if (found.state === "populated") return verify(plan, target, { resumed: true, count: 0, bytes: 0 })

  if (plan.shape === "code") {
    const sparse = await Cone.set(target, plan.cone)
    if (!sparse.ok)
      return sparse.error === "broken"
        ? fail(2, "broken", sparse.message, { broken: sparse.broken })
        : fail(2, "git", sparse.message)
  }
  const cone = plan.shape === "code" ? plan.cone : null
  const missing = await Lfs.missing(plan.directory, "HEAD", cone === null ? () => true : Cone.matcher(cone))
  if (!missing.ok) return fail(3, "git", missing.message)
  if (missing.count > 0 && missing.bytes >= options.askDownloadBytes && !options.confirmed)
    return {
      ok: true,
      state: "confirm",
      gitDir: added.gitDir,
      missing: { objects: missing.objects, count: missing.count, bytes: missing.bytes },
    }
  const fetched = await Lfs.fetch(plan.directory, Lfs.includes(cone, missing.objects), options.signal)
  if (!fetched.ok) return fail(3, "git", fetched.message)

  const populated = await populate(target)
  if (!populated.ok) return populated
  return verify(plan, target, { resumed: found.state !== "absent", count: missing.count, bytes: missing.bytes })
}

export type Observed =
  | { readonly ok: true; readonly state: "absent" }
  /** Registered and locked; `unpopulated` = empty index or only `D.` entries (steps 2-4 still to do). */
  | { readonly ok: true; readonly state: "unpopulated" | "populated"; readonly gitDir: string }
  | Extract<Created, { ok: false }>

/**
 * What exists of `plan` now (06 TI-11: observe before acting). Re-locks a registered worktree that lost its lock, and
 * clears a half-made one ({@link halfMade}) so step 1 runs again.
 */
export async function observe(plan: Plan | Detached): Promise<Observed> {
  await clear(plan)
  const listed = await list(plan.home)
  if (!listed.ok) return fail(1, "git", listed.message)
  const entry = listed.worktrees.find((item) => Identity.same(item.path, plan.directory))
  if (!entry) {
    if (fs.existsSync(plan.directory) && fs.readdirSync(plan.directory).length > 0)
      return fail(1, "path_forbidden", `이 저장소의 작업 폴더가 아닌 폴더가 이미 있어요: ${plan.directory}`)
    return { ok: true, state: "absent" }
  }
  const planned = "detach" in plan ? entry.detached : entry.branch === `refs/heads/${plan.branch}`
  if (!planned)
    return fail(
      1,
      "path_forbidden",
      `다른 기록(${entry.branch ?? "이름 없는 작업 상태"})의 작업 폴더가 이미 있어요: ${plan.directory}`,
    )
  const identity = await identify(plan)
  if (!identity.ok) return identity
  const reason = reasonOf(plan)
  if (entry.locked !== reason) {
    if (entry.locked !== undefined)
      return fail(1, "path_forbidden", `작업 폴더가 잠겨 있어요(${entry.locked}): ${plan.directory}`)
    const locked = await Git.run(["worktree", "lock", "--reason", reason, plan.directory], {
      cwd: plan.home,
      write: true,
      worktree: true,
    })
    if (!locked.ok) return fail(1, "git", locked.message)
  }
  const index = await Git.run(["ls-files", "--sparse", "-z"], { cwd: plan.directory, worktree: true })
  if (!index.ok) return fail(1, "git", index.message)
  if (index.stdout.length === 0) return { ok: true, state: "unpopulated", gitDir: identity.gitDir }
  const status = await Git.run(["status", "--porcelain=v2", "-z"], { cwd: plan.directory, worktree: true })
  if (!status.ok) return fail(1, "git", status.message)
  const populated = !Porcelain.onlyStagedDeletions(Porcelain.status(status.stdout))
  return { ok: true, state: populated ? "populated" : "unpopulated", gitDir: identity.gitDir }
}

/**
 * Clears a step 1 that was killed between its writes (see {@link halfMade}): its admin folder, the new folder's `.git`
 * file and the then empty folder. Returns whether it found one. Undo calls it too: `worktree list` fails while it is there.
 */
export async function clear(target: Owned) {
  const half = await halfMade(target)
  if (half === undefined) return false
  fs.rmSync(half, { recursive: true, force: true })
  fs.rmSync(path.join(target.directory, ".git"), { force: true })
  if (fs.existsSync(target.directory) && fs.readdirSync(target.directory).length === 0) fs.rmdirSync(target.directory)
  return true
}

/**
 * The admin folder (`<common dir>/worktrees/<name>`) of a step 1 that was killed between its writes, or `undefined`.
 * `worktree add` writes `locked`, then `gitdir` and the new folder's `.git` file, then `commondir` and `HEAD`; a kill in
 * between leaves a worktree git cannot open, and an empty `commondir` even makes `worktree list` fail for the whole
 * repository. `worktree prune` keeps it (it is locked). It is ours to clear only when the new folder holds nothing but
 * its `.git` file, that file names an admin folder of this repository locked with this area's reason, and that folder
 * lacks a non-empty `commondir` or `HEAD` (a finished step 1 always has both; `--no-checkout` wrote no file yet).
 */
async function halfMade(plan: Owned) {
  const dotGit = path.join(plan.directory, ".git")
  if (!fs.existsSync(dotGit) || fs.readdirSync(plan.directory).length !== 1 || !fs.statSync(dotGit).isFile())
    return undefined
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]
  if (pointer === undefined) return undefined
  const admin = path.resolve(plan.directory, pointer)
  const common = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: plan.home,
    worktree: true,
  })
  if (!common.ok || !Identity.inside(path.join(common.stdout.trim(), "worktrees"), admin)) return undefined
  const read = (name: string) => {
    const file = path.join(admin, name)
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : ""
  }
  if (read("locked") !== reasonOf(plan)) return undefined
  return read("commondir") === "" || read("HEAD") === "" ? admin : undefined
}

/** A worktree own made, known by its area (the lock reason {@link lockReason}) or by its own lock reason. */
export type Owned = { readonly home: string; readonly directory: string } & (
  | { readonly areaID: string }
  | { readonly lockReason: string }
)

/** The lock reason the worktree carries: its own for a {@link Detached} plan, else its area's. */
function reasonOf(plan: Owned) {
  return "lockReason" in plan ? plan.lockReason : lockReason(plan.areaID)
}

/** The registered worktree is the planned one: the recorded git dir when there is one, else its own top level. */
async function identify(plan: Plan | Detached) {
  if (plan.gitDir !== undefined) {
    const checked = await Identity.check({ directory: plan.directory, gitDir: plan.gitDir })
    if (!checked.ok) return fail(1, "broken", checked.message, { broken: checked.broken })
    return checked
  }
  const identity = await Identity.observe(plan.directory)
  if (!identity.ok) return fail(1, "broken", identity.message, { broken: identity.why })
  if (!Identity.same(identity.toplevel, plan.directory))
    return fail(1, "broken", `맨 위 폴더가 이 폴더가 아니에요: ${identity.toplevel}`, { broken: "identity" })
  return identity
}

/**
 * Step 1: the branch (none for a {@link Detached} plan) and the locked, empty worktree in one command; returns the new
 * worktree's git dir.
 */
export async function add(
  plan: Plan | Detached,
): Promise<{ readonly ok: true; readonly gitDir: string } | Extract<Created, { ok: false }>> {
  const args = await addArgs(plan)
  if (!args.ok) return args
  const result = await Git.run(args.args, { cwd: plan.home, write: true, worktree: true })
  if (!result.ok) return fail(1, "git", result.message)
  const identity = await Identity.observe(plan.directory)
  if (!identity.ok) return fail(1, "broken", identity.message, { broken: identity.why })
  if (!Identity.same(identity.toplevel, plan.directory))
    return fail(1, "broken", `맨 위 폴더가 이 폴더가 아니에요: ${identity.toplevel}`, { broken: "identity" })
  return { ok: true, gitDir: identity.gitDir }
}

/** The `worktree add` arguments of step 1: `--detach <dir> <base>`, `-b <branch> <dir> <base>` or `<dir> <branch>`. */
async function addArgs(
  plan: Plan | Detached,
): Promise<{ readonly ok: true; readonly args: string[] } | Extract<Created, { ok: false }>> {
  const add = ["worktree", "add", "--no-checkout", "--lock", "--reason", reasonOf(plan)]
  if ("detach" in plan) return { ok: true, args: [...add, "--detach", plan.directory, plan.base] }
  const existing = await Refs.read(plan.home, `refs/heads/${plan.branch}`)
  if (existing === undefined) return fail(1, "git", `기록 이름을 읽지 못했어요: ${plan.branch}`)
  // A branch left by an add that failed after creating it is ours when it is still at the base.
  if (existing !== null && existing !== plan.base)
    return fail(1, "branch_exists", `기록 이름이 이미 다른 저장 지점(${existing})에 있어요: ${plan.branch}`)
  if (existing === null) return { ok: true, args: [...add, "-b", plan.branch, plan.directory, plan.base] }
  return { ok: true, args: [...add, plan.directory, plan.branch] }
}

/** Step 4: `read-tree -mu HEAD` after the identity check. In-cone LFS files are smudged from the shared store here. */
export async function populate(target: Identity.Record) {
  const identity = await Identity.check(target)
  if (!identity.ok) return fail(4, "broken", identity.message, { broken: identity.broken })
  const result = await Git.run(["read-tree", "-mu", "HEAD"], { cwd: target.directory, write: true, worktree: true })
  if (!result.ok) return fail(4, "git", result.message)
  return { ok: true as const }
}

export type Undone =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly error: "broken" | "git"
      readonly broken?: "missing" | "identity"
      readonly message: string
    }

/**
 * Removes a worktree own made and nobody touched (enable undo, 06 §3.8, §4.5): identity check, `worktree unlock`,
 * `read-tree -mu HEAD` only for a half-made worktree (its empty index shows every file of HEAD as a staged deletion and
 * would otherwise count as changes; on anything else it would drop staged work), `worktree remove` without `--force`,
 * so git still refuses a folder with changes or untracked files. When removing fails the lock is put back. Whether the
 * worktree is untouched (no commits after the base, no messages in its owner session) is the caller's check; the
 * branch stays (06 TI-4). A removal another program held up on Windows is finished ({@link finishHeldRemoval}).
 */
export async function undo(target: Identity.Record & { readonly home: string }): Promise<Undone> {
  const identity = await Identity.check(target)
  if (!identity.ok) return { ok: false, error: "broken", broken: identity.broken, message: identity.message }
  const listed = await list(target.home)
  if (!listed.ok) return { ok: false, error: "git", message: listed.message }
  const reason = listed.worktrees.find((item) => Identity.same(item.path, target.directory))?.locked
  const options = { cwd: target.home, write: true, worktree: true }
  if (reason !== undefined) {
    const unlocked = await Git.run(["worktree", "unlock", target.directory], options)
    if (!unlocked.ok) return { ok: false, error: "git", message: unlocked.message }
  }
  const reset = await resetHalfMade(target.directory)
  const removed = reset.ok ? await Git.run(["worktree", "remove", target.directory], options) : reset
  if (removed.ok || (reset.ok && (await finishHeldRemoval(target)))) return { ok: true }
  if (reason !== undefined) await Git.run(["worktree", "lock", "--reason", reason, target.directory], options)
  return { ok: false, error: "git", message: removed.message }
}

/** How long {@link finishHeldRemoval} waits for the program in the folder to let go. */
const HELD_MS = 10_000

/**
 * Windows: while another program works in the folder (core's git calls right after a Location boots there, which the
 * undo's archive mark starts), `worktree remove` deletes the files and the registration and then fails on the folder
 * itself ("Permission denied"). When git dropped the registration and only empty folders are left, they go as soon as
 * that program lets go; anything else left (a file still open) keeps the folder.
 */
async function finishHeldRemoval(target: { readonly home: string; readonly directory: string }) {
  const listed = await list(target.home)
  if (!listed.ok || listed.worktrees.some((item) => Identity.same(item.path, target.directory))) return false
  const deadline = Date.now() + HELD_MS
  while (true) {
    const left = emptyFolders(target.directory)
    if (left === undefined) return false
    for (const folder of left) await fs.promises.rmdir(folder).catch(() => undefined)
    if (!fs.existsSync(target.directory)) return true
    if (Date.now() > deadline) return false
    await Bun.sleep(250)
  }
}

/** The folder and the folders in it, deepest first; `undefined` when anything else is inside; `[]` when it is gone. */
function emptyFolders(directory: string) {
  if (!fs.existsSync(directory)) return []
  const entries = fs.readdirSync(directory, { recursive: true, withFileTypes: true })
  if (entries.some((entry) => !entry.isDirectory())) return undefined
  const inside = entries.map((entry) => path.join(entry.parentPath, entry.name))
  return [...inside.toSorted((a, b) => b.length - a.length), directory]
}

/** `read-tree -mu HEAD` when the index is empty (every file of HEAD a staged deletion); otherwise nothing. */
async function resetHalfMade(directory: string) {
  const status = await Git.run(["status", "--porcelain=v2", "-z"], { cwd: directory, worktree: true })
  if (!status.ok || !Porcelain.onlyStagedDeletions(Porcelain.status(status.stdout))) return status
  return Git.run(["read-tree", "-mu", "HEAD"], { cwd: directory, write: true, worktree: true })
}

/** `worktree list --porcelain -z` of the repository at `home`. */
export async function list(home: string) {
  const result = await Git.run(["worktree", "list", "--porcelain", "-z"], { cwd: home, worktree: true })
  if (!result.ok) return { ok: false as const, message: `작업 폴더 목록을 읽지 못했어요: ${result.message}` }
  return { ok: true as const, worktrees: Porcelain.worktrees(result.stdout) }
}

/** Steps 5 and 6. */
async function verify(
  plan: Plan | Detached,
  target: Identity.Record,
  outcome: { readonly resumed: boolean; readonly count: number; readonly bytes: number },
): Promise<Created> {
  const status = await Git.run(["status", "--porcelain=v2", "-z"], { cwd: plan.directory, worktree: true })
  if (!status.ok) return fail(5, "git", status.message)
  const entries = Porcelain.status(status.stdout).entries
  const shown = entries.slice(0, 5).map((entry) => entry.path)
  if (entries.length > 0) return fail(5, "verify", `새 작업 폴더에 변경이 있어요: ${shown.join(", ")}`)
  if (plan.shape === "code") {
    const collapsed = await collapsedCheck(plan)
    if (collapsed !== undefined) return fail(5, "verify", collapsed)
  }
  const listed = await list(plan.home)
  if (!listed.ok) return fail(6, "git", listed.message)
  const entry = listed.worktrees.find((item) => Identity.same(item.path, plan.directory))
  if (entry?.locked !== reasonOf(plan))
    return fail(6, "verify", `작업 폴더의 잠금 이유가 달라요(기대: ${reasonOf(plan)})`)
  const identity = await Identity.check(target)
  if (!identity.ok) return fail(6, "broken", identity.message, { broken: identity.broken })
  return {
    ok: true,
    state: "ready",
    gitDir: identity.gitDir,
    resumed: outcome.resumed,
    fetched: { count: outcome.count, bytes: outcome.bytes },
  }
}

/** Why the worktree is not collapsed as planned, or `undefined` (06 §4.5 step 5). */
async function collapsedCheck(plan: Plan | Detached) {
  const sparse = await Git.run(["config", "--worktree", "--get", "index.sparse"], {
    cwd: plan.directory,
    worktree: true,
  })
  if (!sparse.ok || sparse.stdout.trim() !== "true") return "작업 폴더에 index.sparse가 켜져 있지 않아요"
  // A heavy folder with a cone folder inside it (a fetched subfolder) or around it is not one collapsed entry.
  const cone = plan.cone.map(Cone.normalize)
  const overlaps = (dir: string) =>
    cone.some((item) => item === dir || item.startsWith(`${dir}/`) || dir.startsWith(`${item}/`))
  const expected = plan.heavy.map(Cone.normalize).filter((dir) => dir && !overlaps(dir))
  if (expected.length === 0) return undefined
  const [present, files] = await Promise.all([
    Git.run(["ls-tree", "-d", "-z", "--name-only", "HEAD", "--", ...expected], { cwd: plan.directory, worktree: true }),
    Git.run(["ls-files", "--sparse", "-z"], { cwd: plan.directory, worktree: true }),
  ])
  if (!present.ok) return present.message
  if (!files.ok) return files.message
  const collapsed = new Set(Porcelain.sparseDirectories(files.stdout))
  const open = Porcelain.fields(present.stdout).filter((dir) => !collapsed.has(dir))
  return open.length === 0 ? undefined : `큰 파일 폴더가 접혀 있지 않아요: ${open.join(", ")}`
}

function refusal(plan: Plan | Detached) {
  if (!Git.isNative(plan.directory) || !Git.isNative(plan.home)) return "이 PC의 절대 경로가 아니에요"
  if (plan.directory.includes("#")) return `폴더 경로에 '#'이 있어요: ${plan.directory}`
  if (!Git.isOid(plan.base)) return `저장 지점의 전체 이름이 아니에요: ${plan.base}`
  if ("detach" in plan)
    return !plan.lockReason || /[\r\n]/.test(plan.lockReason)
      ? `잠금 이유로 쓸 수 없어요: ${plan.lockReason}`
      : undefined
  if (plan.branch.startsWith("-") || !Refs.valid(`refs/heads/${plan.branch}`))
    return `기록 이름으로 쓸 수 없어요: ${plan.branch}`
  if (!plan.areaID || /[\r\n]/.test(plan.areaID)) return `영역 ID로 쓸 수 없어요: ${plan.areaID}`
  return undefined
}

function fail(
  step: Step,
  error: Failure,
  message: string,
  extra: { readonly broken?: "missing" | "identity" } = {},
): Extract<Created, { ok: false }> {
  return { ok: false, step, error, message, ...(extra.broken === undefined ? {} : { broken: extra.broken }) }
}
