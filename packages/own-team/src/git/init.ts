export * as GitInit from "./init.js"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { Fsx } from "@own/runtime"
import { Services } from "../services.js"
import { Identity } from "./identity.js"
import { Git } from "./run.js"
import { GitVersion } from "./version.js"

/**
 * Git 저장소로 만들기 (06 §3.0): a project that is not a Git repository becomes one, so team mode and worktrees can
 * start. Team mode needs a branch, so a first commit (`enable` answers `not_git{unborn}` without one), and core's
 * `worktree.create` needs a commit to branch from.
 *
 * {@link plan} reads only: the folder's state, git's identity, the proposed `.gitignore` and what a first commit would
 * take (files git sees as new, listed through a throwaway git dir in the OS temp folder, so nothing is written next to
 * the user's files), with the large and binary files a first commit leaves out unless the user picks them.
 *
 * {@link run} is `git init -b main` (only `.git` appears) and, when asked, the first commit: the identity typed in the
 * dialog into this repository's own settings, the proposed `.gitignore` (never over an existing one), then exactly the
 * listed files again, the flagged ones only when picked, never a repository inside, with `user.useConfigOnly` so git
 * never makes an identity up. A failed step takes back what this call made (the new `.git`, the written
 * `.gitignore`); the user's files are never touched. The user's other git settings (line endings, hooks, signing)
 * apply as they are.
 *
 * Refused: a native-path folder that is missing, a system or home folder, OWN_HOME, a folder inside another repository
 * (`parent`: use that one), a repository with commits, and a second call for the same folder while one runs.
 */

export const BRANCH = "main"
export const LARGE_BYTES = 10 * 1024 * 1024
export const BINARY_BYTES = 1024 * 1024
/** More new files than this: the user commits them himself (a first commit here stays a few minutes at most). */
export const FILE_LIMIT = 20_000
export const MESSAGE = "Initial commit"

const FLAGGED_SHOWN = 200
const LARGEST_SHOWN = 10
/** git's own binary test reads this much (`buffer_is_binary`). */
const SNIFF_BYTES = 8_000

/** Common build output, caches, logs, local secrets and OS files; shown in full before it is written. */
export const PROPOSAL = [
  "# Dependencies",
  "node_modules/",
  ".venv/",
  "venv/",
  "",
  "# Build output",
  "dist/",
  "build/",
  "target/",
  "",
  "# Caches",
  ".cache/",
  ".gradle/",
  ".next/",
  ".turbo/",
  "__pycache__/",
  "*.pyc",
  "",
  "# Logs",
  "*.log",
  "",
  "# Local secrets",
  ".env",
  ".env.local",
  ".env.*.local",
  "",
  "# OS",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "",
].join("\n")

export interface Input {
  readonly directory: string
  /** OWN_HOME: never made a repository. */
  readonly home: string
}

export async function plan(input: Input): Promise<Services.Result<{ readonly plan: OwnTeam.GitInitPlan }>> {
  const checked = await inspect(input)
  if (!checked.ok) return checked
  const gitignore = fs.existsSync(path.join(input.directory, ".gitignore"))
  const [identity, files] = await Promise.all([
    readIdentity(input.directory),
    preview(input.directory, checked.state, gitignore),
  ])
  if (!files.ok) return files
  return {
    ok: true,
    plan: {
      directory: input.directory,
      state: checked.state,
      branch: checked.branch,
      identity,
      gitignore: { exists: gitignore, proposal: PROPOSAL },
      files: files.files,
      limits: { largeBytes: LARGE_BYTES, binaryBytes: BINARY_BYTES },
    },
  }
}

export interface RunInput extends Input {
  readonly firstCommit?: OwnTeam.GitInitCommit
  /**
   * Reads the folder's project before `git init` (the service's markerless id), once the checks passed. Written to
   * `.git/opencode`, the id cache core's `Project.resolve` reads, so the project keeps its id, sessions and row once it
   * is a repository (without it the id would be `global` until the first commit, then the root commit's).
   */
  readonly project?: () => Promise<string | undefined>
}

export type Ran = Omit<OwnTeam.GitInitResult, "projectID">

export async function run(input: RunInput): Promise<Services.Result<{ readonly result: Ran }>> {
  const key = Identity.key(input.directory)
  if (RUNNING.has(key)) return refused("busy")
  RUNNING.add(key)
  return execute(input).finally(() => RUNNING.delete(key))
}

const RUNNING = new Set<string>()

async function execute(input: RunInput): Promise<Services.Result<{ readonly result: Ran }>> {
  const checked = await inspect(input)
  if (!checked.ok) return checked
  const commit = input.firstCommit
  if (checked.state === "unborn" && !commit) return refused("exists")
  if (commit && !commit.identity) {
    const identity = await readIdentity(input.directory)
    if (identity.name === null || identity.email === null)
      return Services.failure("identity_missing", "git has no user.name or user.email for this folder", {})
  }
  const created = checked.state === "none"
  if (created) {
    const projectID = await input.project?.()
    const init = await Git.run(["init", "-q", "-b", BRANCH], { cwd: input.directory, worktree: true, write: true })
    if (!init.ok) return gitFailed("init", init.message)
    if (projectID && projectID !== "global") fs.writeFileSync(path.join(input.directory, ".git", "opencode"), projectID)
  }
  const base = { directory: input.directory, branch: checked.branch }
  if (!commit) return { ok: true, result: { ...base, commit: null, committed: null, excluded: 0, gitignore: "none" } }
  const made = await firstCommit(input.directory, commit)
  if (made.ok) return { ok: true, result: { ...base, ...made.value } }
  // Take back what this call made; the user's files were never written.
  if (made.wrote) fs.rmSync(path.join(input.directory, ".gitignore"), { force: true })
  if (created) await Fsx.removeTree(path.join(input.directory, ".git"))
  return made.failure
}

type Made =
  | {
      readonly ok: true
      readonly value: Pick<Ran, "commit" | "committed" | "excluded" | "gitignore">
    }
  | { readonly ok: false; readonly failure: Services.Failure; readonly wrote: boolean }

async function firstCommit(directory: string, input: OwnTeam.GitInitCommit): Promise<Made> {
  const write = { cwd: directory, worktree: true, write: true }
  const identity = input.identity
  if (identity) {
    for (const [name, value] of [
      ["user.name", identity.name],
      ["user.email", identity.email],
    ] as const) {
      const set = await Git.run(["config", "--local", name, value], write)
      if (!set.ok) return { ok: false, failure: gitFailed("identity", set.message), wrote: false }
    }
  }
  const file = path.join(directory, ".gitignore")
  const wrote = input.gitignore && !fs.existsSync(file)
  if (wrote) fs.writeFileSync(file, PROPOSAL)
  const fail = (step: "gitignore" | "add" | "commit", message: string): Made => ({
    ok: false,
    failure: gitFailed(step, message),
    wrote,
  })
  const listed = await untracked(directory, {})
  if (!listed.ok) return fail("add", listed.message)
  const nested = listed.paths.filter((item) => item.endsWith("/"))
  const plain = listed.paths.filter((item) => !item.endsWith("/"))
  if (plain.length > FILE_LIMIT) return { ok: false, failure: refused("too_many"), wrote }
  const files = weigh(directory, plain, new Set())
  const include = new Set(input.include)
  const chosen = files.filter((item) => !flagged(item) || include.has(item.path))
  if (chosen.length > 0) {
    const add = await Git.run(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      ...write,
      stdin: Git.nul(chosen.map((item) => `:(literal)${item.path}`)),
    })
    if (!add.ok) return fail("add", add.message)
  }
  const committed = await Git.run(
    ["-c", "user.useConfigOnly=true", "commit", "-q", "--allow-empty", "-m", MESSAGE],
    write,
  )
  if (!committed.ok) return fail("commit", committed.message)
  const head = await Git.run(["rev-parse", "HEAD"], { cwd: directory, worktree: true })
  if (!head.ok) return fail("commit", head.message)
  return {
    ok: true,
    value: {
      commit: head.stdout.trim(),
      committed: count(chosen),
      excluded: files.length - chosen.length + nested.length,
      gitignore: wrote ? "written" : input.gitignore ? "kept" : "none",
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

type Inspected = { readonly ok: true; readonly state: "none" | "unborn"; readonly branch: string } | Services.Failure

async function inspect(input: Input): Promise<Inspected> {
  const directory = input.directory
  if (!Git.isNative(directory) || !fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    return Services.failure("not_found", `${directory} is not a folder`, { what: "directory", id: directory })
  if (system(directory) || Identity.inside(input.home, directory) || Identity.inside(directory, input.home))
    return refused("system")
  const version = await Git.run(["version"])
  const parsed = version.ok ? GitVersion.parse(version.stdout) : undefined
  if (!parsed || !GitVersion.atLeast(parsed, GitVersion.MINIMUM))
    return Services.failure("git_too_old", parsed ? `Git ${parsed.text} is older than 2.40` : "git is not installed", {
      version: parsed?.text ?? "",
      minimum: `${GitVersion.MINIMUM.major}.${GitVersion.MINIMUM.minor}`,
    })
  if (fs.existsSync(path.join(directory, ".git"))) return own(directory)
  const hg = mercurial(directory)
  if (hg) return refused("inside", hg)
  // Without the ceiling: a repository anywhere above is the one this folder already belongs to.
  const above = await Git.run(["rev-parse", "--show-toplevel"], { cwd: directory })
  if (above.ok) return refused("inside", above.stdout.trim())
  return { ok: true, state: "none", branch: BRANCH }
}

/** A folder with its own `.git`: a repository without a commit can still get its first one. */
async function own(directory: string): Promise<Inspected> {
  const query = { cwd: directory, worktree: true }
  const top = await Git.run(["rev-parse", "--show-toplevel"], query)
  if (!top.ok || !Identity.same(top.stdout.trim(), directory)) return refused("exists")
  const head = await Git.run(["rev-parse", "--verify", "-q", "HEAD"], query)
  if (head.ok) return refused("exists")
  const branch = await Git.run(["symbolic-ref", "--short", "-q", "HEAD"], query)
  return { ok: true, state: "unborn", branch: (branch.ok && branch.stdout.trim()) || BRANCH }
}

/**
 * A drive or file system root, the home folder or one above it, a folder the system keeps its own files in (anything
 * in it), and the shared folders users keep other folders in (only the folder itself: the temp folder, `AppData`,
 * `/var`, `/opt`; projects inside them stay allowed, `/var/www/site` for one).
 */
export function system(directory: string) {
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root) return true
  const home = os.homedir()
  if (Identity.inside(resolved, home)) return true
  const env = process.env
  const windows = process.platform === "win32"
  const trees = windows
    ? [env.SystemRoot ?? "C:\\Windows", env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData]
    : ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/run", "/sbin", "/sys", "/System"].concat(
        ["/usr/bin", "/usr/lib", "/usr/sbin"],
      )
  const folders = windows
    ? [path.join(home, "AppData"), env.LOCALAPPDATA, env.APPDATA, os.tmpdir()]
    : ["/usr", "/var", "/opt", "/tmp", "/home", "/Users", "/Library", "/Applications", os.tmpdir()]
  return (
    trees.some((root) => root !== undefined && Identity.inside(root, resolved)) ||
    folders.some((folder) => folder !== undefined && Identity.same(folder, resolved))
  )
}

/** The nearest `.hg` above: core counts a Mercurial checkout as the project's VCS too. */
function mercurial(directory: string): string | undefined {
  const parent = path.dirname(directory)
  if (parent === directory) return undefined
  if (fs.existsSync(path.join(parent, ".hg"))) return parent
  return mercurial(parent)
}

async function readIdentity(directory: string) {
  const query = { cwd: directory, worktree: true }
  const [name, email] = await Promise.all([
    Git.run(["config", "--get", "user.name"], query),
    Git.run(["config", "--get", "user.email"], query),
  ])
  return { name: (name.ok && name.stdout.trim()) || null, email: (email.ok && email.stdout.trim()) || null }
}

// ---------------------------------------------------------------------------------------------------------------
// What a first commit would take

interface Weighed {
  readonly path: string
  readonly bytes: number
  readonly binary: boolean
  readonly ignored: boolean
}

type Preview = { readonly ok: true; readonly files: OwnTeam.GitInitPlan["files"] } | Services.Failure

/**
 * Lists the new files twice, with the proposal and without it (once when the folder has a `.gitignore`), through a
 * throwaway git dir when there is no repository yet, so `.gitignore` files, `core.excludesFile` and repositories
 * inside count exactly as they will.
 */
async function preview(directory: string, state: "none" | "unborn", gitignore: boolean): Promise<Preview> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "own-git-init-"))
  try {
    const gitDir = state === "none" ? path.join(scratch, "git") : undefined
    if (gitDir) {
      const made = await Git.run(["init", "-q", "--bare", gitDir], { write: true })
      if (!made.ok) return gitFailed("init", made.message)
    }
    const exclude = path.join(scratch, "proposal")
    fs.writeFileSync(exclude, PROPOSAL)
    const [all, proposed] = await Promise.all([
      untracked(directory, { gitDir }),
      gitignore ? undefined : untracked(directory, { gitDir, exclude }),
    ])
    if (!all.ok) return gitFailed("add", all.message)
    if (proposed && !proposed.ok) return gitFailed("add", proposed.message)
    const kept = proposed?.paths ?? all.paths
    const nested = kept.filter((item) => item.endsWith("/"))
    const files = kept.filter((item) => !item.endsWith("/"))
    if (files.length > FILE_LIMIT)
      return { ok: true, files: { kind: "too_many", count: files.length, limit: FILE_LIMIT } }
    const keptSet = new Set(kept)
    const left = all.paths.filter((item) => !keptSet.has(item) && !item.endsWith("/"))
    // Without the proposal the folder may hold far more (node_modules): its files are weighed only when that stays
    // within the limit too; otherwise the dialog keeps the proposal on.
    const weighLeft = files.length + left.length <= FILE_LIMIT
    const weighed = [...weigh(directory, files, new Set()), ...(weighLeft ? weigh(directory, left, new Set(left)) : [])]
    const shown = weighed.filter(flagged)
    const biggest = (items: readonly Weighed[]) => items.toSorted((a, b) => b.bytes - a.bytes).slice(0, LARGEST_SHOWN)
    const largest = [...new Set([...biggest(weighed.filter((item) => !item.ignored)), ...biggest(weighed)])].toSorted(
      (a, b) => b.bytes - a.bytes,
    )
    return {
      ok: true,
      files: {
        kind: "listed",
        total: count(weighed.filter((item) => !item.ignored)),
        proposal: weighLeft ? count(weighed.filter((item) => item.ignored)) : { count: left.length, bytes: 0 },
        proposalRequired: !weighLeft,
        largest,
        flagged: shown.slice(0, FLAGGED_SHOWN),
        flaggedMore: Math.max(0, shown.length - FLAGGED_SHOWN),
        nested,
      },
    }
  } finally {
    await Fsx.removeTree(scratch)
  }
}

/** `ls-files -o --exclude-standard`: new files (a repository inside ends with `/`), `/`-separated. */
async function untracked(directory: string, options: { readonly gitDir?: string; readonly exclude?: string }) {
  const result = await Git.run(
    [
      ...(options.gitDir ? [`--git-dir=${options.gitDir}`, `--work-tree=${directory}`] : []),
      "ls-files",
      "-z",
      "-o",
      "--exclude-standard",
      ...(options.exclude ? [`--exclude-from=${options.exclude}`] : []),
    ],
    { cwd: directory, worktree: true },
  )
  if (!result.ok) return result
  return { ok: true as const, paths: result.stdout.split("\0").filter(Boolean) }
}

/** Sizes (links not followed) and git's binary test for files of at least {@link BINARY_BYTES}. */
function weigh(directory: string, paths: readonly string[], ignored: ReadonlySet<string>): Weighed[] {
  return paths.map((item) => {
    const file = path.join(directory, item)
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    const bytes = stat?.isFile() ? stat.size : 0
    return { path: item, bytes, binary: bytes >= BINARY_BYTES && sniff(file), ignored: ignored.has(item) }
  })
}

function sniff(file: string) {
  const handle = fs.openSync(file, "r")
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const read = fs.readSync(handle, buffer, 0, SNIFF_BYTES, 0)
    return buffer.subarray(0, read).includes(0)
  } finally {
    fs.closeSync(handle)
  }
}

/** Left out of a first commit unless the user picks it. */
export function flagged(item: { readonly bytes: number; readonly binary: boolean }) {
  return item.bytes >= LARGE_BYTES || item.binary
}

function count(items: readonly Weighed[]) {
  return { count: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0) }
}

function refused(why: OwnTeam.GitInitRefusal, parent: string | null = null) {
  return Services.failure("git_init_refused", `cannot make this folder a Git repository: ${why}`, { why, parent })
}

function gitFailed(step: "init" | "identity" | "gitignore" | "add" | "commit", message: string) {
  return Services.failure("git_failed", message, { step, message })
}
