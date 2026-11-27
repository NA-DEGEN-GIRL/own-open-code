export * as Inventory from "./inventory.js"

import fs from "node:fs"
import path from "node:path"
import { Classify } from "./classify.js"
import { Identity } from "./identity.js"
import { Porcelain } from "./porcelain.js"
import { Git } from "./run.js"

/**
 * The read-only inventory of one repository (06 §3.2): every worktree of the git common dir with its HEAD, branch or
 * detached state, lock reason, prunable state and identity, every local branch with the worktree that has it, its
 * upstream and how far it is ahead of and behind the target, `status --porcelain=v2` counts per worktree, commits
 * that only a detached HEAD holds, the shared stash stack with the folder each entry came from, and the git
 * operations in progress. Every command is a query, so `GIT_OPTIONAL_LOCKS=0` (06 §4.3): a `status` never rewrites
 * an index.
 *
 * Sessions are an input (self-HTTP `session.list{parentID: null}`, root sessions only): core can filter sessions by
 * exact folder only, so they are placed here by the longest worktree prefix ({@link Classify.placeSessions}). Facts
 * are read, never stored: the registry keeps bindings and intent (06 §2.4).
 */

/** A root session of the project. Callers may carry more fields (model, preset); they come back unchanged. */
export interface Session {
  readonly id: string
  /** The session's folder (its Location directory), a native path. */
  readonly directory: string
  /** `time.updated`, epoch milliseconds. */
  readonly updated: number
}

/** `status --porcelain=v2` counts. */
export interface Changes {
  /** Tracked entries with a staged change. */
  readonly staged: number
  /** Tracked entries with an unstaged change. */
  readonly unstaged: number
  readonly untracked: number
  readonly unmerged: number
  /** Ignored entries (`--ignored=matching`: an ignored folder is one entry). */
  readonly ignored: number
  /** Paths with work not in a commit: changed, renamed, unmerged and untracked entries; an `MM` file counts once. */
  readonly uncommitted: number
}

/** A git operation that stopped half way in a worktree (06 §3.2): steps that move HEAD or files skip that folder. */
export type Operation = "rebase" | "merge" | "cherry-pick" | "revert" | "bisect"

export interface Worktree<S extends Session = Session> {
  /** As git prints it (forward slashes on Windows). */
  readonly path: string
  /** Its real path when the folder exists (junctions resolved), else `null`. */
  readonly real: string | null
  /** The first entry of `worktree list`: the main worktree. */
  readonly primary: boolean
  readonly bare: boolean
  readonly head: string | null
  /** Short branch name; `null` when detached or bare. */
  readonly branch: string | null
  readonly detached: boolean
  /** The lock reason (`""` for a lock without one); `null` when not locked. */
  readonly locked: string | null
  /** Why `worktree prune` would drop it (the folder is gone); `null` otherwise. */
  readonly prunable: string | null
  /** `rev-parse --absolute-git-dir` and `--show-toplevel` under the worktree ceiling (06 §4.3); `null` when bare. */
  readonly identity: Identity.Observed | null
  /** Commits of HEAD not in the target / of the target not in HEAD; `null` without a target or HEAD. */
  readonly ahead: number | null
  readonly behind: number | null
  /** `null` when bare, gone, or not this worktree. */
  readonly changes: Changes | null
  /** Commits only this detached HEAD reaches (`--not --branches --remotes --tags`); `[]` on a branch. */
  readonly detachedOnly: readonly string[]
  readonly operations: readonly Operation[]
  /** Root sessions whose folder is in this worktree and in no worktree nested inside it. */
  readonly sessions: readonly S[]
}

export interface Upstream {
  readonly name: string
  readonly ahead: number
  readonly behind: number
  /** The upstream branch no longer exists. */
  readonly gone: boolean
}

export interface Branch {
  readonly name: string
  readonly oid: string
  /** The worktree that has it checked out (`%(worktreepath)`), or `null`. */
  readonly worktree: string | null
  readonly upstream: Upstream | null
  readonly ahead: number | null
  readonly behind: number | null
}

/** One entry of the stash stack, which every worktree shares. */
export interface Stash {
  /** `stash@{n}`. */
  readonly ref: string
  readonly oid: string
  readonly parents: readonly string[]
  readonly subject: string
  /** The worktree it was made in, by the branch in its subject or its first parent; `null` when unknown. */
  readonly worktree: string | null
}

export interface Result<S extends Session = Session> {
  readonly commonDir: string
  readonly target: { readonly name: string; readonly oid: string | null }
  /** In `worktree list` order: the main worktree first. */
  readonly worktrees: readonly Worktree<S>[]
  readonly branches: readonly Branch[]
  readonly stash: readonly Stash[]
  /** Sessions whose folder is gone (06 §3.2 고아). */
  readonly orphans: readonly S[]
  /** Sessions whose folder exists outside every worktree: another clone ({@link Classify.clone}) or another folder. */
  readonly outside: readonly S[]
  /** Per-worktree queries that failed; their fields are `null` or empty. */
  readonly errors: readonly { readonly directory: string | null; readonly message: string }[]
}

/** `git rev-parse --path-format=absolute --git-common-dir --show-toplevel` from any folder of a checkout (06 §3.2). */
export async function locate(
  directory: string,
): Promise<
  | { readonly ok: true; readonly commonDir: string; readonly toplevel: string }
  | { readonly ok: false; readonly message: string }
> {
  // No worktree ceiling: `directory` may be a subfolder, and git has to look above it.
  const result = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], {
    cwd: directory,
  })
  if (!result.ok) return { ok: false, message: `저장소를 찾지 못했어요: ${result.message}` }
  const [commonDir, toplevel] = result.stdout.split("\n").map((line) => line.trim())
  if (!commonDir || !toplevel) return { ok: false, message: "저장소의 Git 폴더를 읽지 못했어요" }
  return { ok: true, commonDir, toplevel }
}

/**
 * The git operations stopped half way in the worktree whose git dir is `gitDir` (06 §3.2): `name-detached`,
 * `session-move`, conversion and advancing the target skip such a folder (7.2). Reads the git dir only, no git process.
 */
export function operations(gitDir: string): Operation[] {
  return [...new Set(OPERATIONS.filter(([name]) => fs.existsSync(path.join(gitDir, name))).map(([, kind]) => kind))]
}

/** A worktree that holds a branch (06 §7.2 step 8). */
export interface Use {
  /** As git prints it (forward slashes on Windows). */
  readonly path: string
  /** The common dir for the main worktree, `<common dir>/worktrees/<name>` for a linked one; `null` when not found. */
  readonly gitDir: string | null
  readonly primary: boolean
  /**
   * `checkout`: HEAD is the branch (the folder W that advances with `merge --ff-only`); `rebase`, `bisect`: an
   * operation stopped half way that started from the branch (its HEAD is detached meanwhile).
   */
  readonly how: "checkout" | "rebase" | "bisect"
}

/**
 * The worktrees that hold `target`, by git's own rule (06 §7.2 step 8): HEAD is `refs/heads/<target>`, or the
 * `head-name` of `rebase-merge/` or `rebase-apply/` (not `git am`), or the start branch in `BISECT_START`, names it.
 * `branch -f` and `fetch . K:<target>` refuse such a branch; own advances it only inside a checkout W, never with
 * `update-ref` (a rebase would end with its commits on a detached HEAD, [R-review] e4). Every worktree is reported,
 * inside the team or outside it (TI-6): the caller waits and tells the user for a stopped operation or an outside W.
 * Worktrees whose folder is gone still count, as for git, until `worktree prune` drops them.
 */
export async function branchInUse(
  commonDir: string,
  target: string,
): Promise<{ readonly ok: true; readonly users: Use[] } | { readonly ok: false; readonly message: string }> {
  const listed = await Git.run(["worktree", "list", "--porcelain", "-z"], { cwd: commonDir, worktree: true })
  if (!listed.ok) return { ok: false, message: `작업 폴더 목록을 읽지 못했어요: ${listed.message}` }
  const linked = adminDirs(commonDir)
  const users = Porcelain.worktrees(listed.stdout).flatMap((entry, index): Use[] => {
    if (entry.bare) return []
    const gitDir = index === 0 ? commonDir : (linked.get(Identity.key(entry.path)) ?? null)
    const held: Use["how"][] = [
      ...(entry.branch === `refs/heads/${target}` ? (["checkout"] as const) : []),
      ...(gitDir !== null && rebasing(gitDir) === target ? (["rebase"] as const) : []),
      ...(gitDir !== null && branchFile(gitDir, "BISECT_START") === target ? (["bisect"] as const) : []),
    ]
    return held.map((how) => ({ path: entry.path, gitDir, primary: index === 0, how }))
  })
  return { ok: true, users }
}

/** The inventory of the repository whose common dir is `commonDir`, measured against the branch `target`. */
export async function collect<S extends Session>(
  commonDir: string,
  target: string,
  sessions: readonly S[],
): Promise<({ readonly ok: true } & Result<S>) | { readonly ok: false; readonly message: string }> {
  // Run inside the common dir: it is the git dir itself, so the ceiling only stops a walk above it.
  const options = { cwd: commonDir, worktree: true }
  const [listed, refs] = await Promise.all([
    Git.run(["worktree", "list", "--porcelain", "-z"], options),
    // `%(upstream:track)` is translated (`[ahead 1]`, `[gone]`); the C locale keeps it parseable.
    Git.run(["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/stash"], {
      ...options,
      env: { LC_ALL: "C" },
    }),
  ])
  if (!listed.ok) return { ok: false, message: `작업 폴더 목록을 읽지 못했어요: ${listed.message}` }
  if (!refs.ok) return { ok: false, message: `기록 이름 목록을 읽지 못했어요: ${refs.message}` }
  const lines = refs.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0"))
  const local = lines.filter((fields) => fields[0]?.startsWith("refs/heads/"))
  const targetOid = local.find((fields) => fields[0] === `refs/heads/${target}`)?.[1] ?? null
  const entries = Porcelain.worktrees(listed.stdout)
  const oids = [
    ...new Set([...local.map((fields) => fields[1] ?? ""), ...entries.map((entry) => entry.head ?? "")]),
  ].filter(Git.isOid)
  const errors: { directory: string | null; message: string }[] = []
  const counts = new Map(
    await parallel(oids, async (oid) => [oid, await count(commonDir, targetOid, oid, errors)] as const),
  )
  const [described, stash] = await Promise.all([
    parallel(entries, (entry, index) => describe(entry, index === 0, counts, errors)),
    stashes(
      commonDir,
      lines.some((fields) => fields[0] === "refs/stash"),
      errors,
    ),
  ])
  const placed = Classify.placeSessions(
    described.filter((item) => !item.bare && item.prunable === null).map((item) => item.path),
    sessions,
  )
  const unplaced = Map.groupBy(placed.unplaced, (session) => (fs.existsSync(session.directory) ? "outside" : "orphan"))
  const worktrees = described.map((item) => ({ ...item, sessions: placed.placed.get(item.path) ?? [] }))
  return {
    ok: true,
    commonDir,
    target: { name: target, oid: targetOid },
    worktrees,
    branches: local.map((fields) => branch(fields, counts)),
    stash: stash.map((item) => ({ ...item, worktree: origin(item, worktrees) })),
    orphans: unplaced.get("orphan") ?? [],
    outside: unplaced.get("outside") ?? [],
    errors,
  }
}

/** Refname, object, worktree path, upstream, upstream track (06 §3.2); the full refname keeps `heads/x` unambiguous. */
const REF_FORMAT = "%(refname)%00%(objectname)%00%(worktreepath)%00%(upstream:short)%00%(upstream:track)"

/** Git processes at a time (Windows process starts are the cost). */
const LIMIT = 8

/** The git dir entries of an operation in progress (06 §3.2). */
const OPERATIONS: ReadonlyArray<readonly [string, Operation]> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_START", "bisect"],
]

type Counts = ReadonlyMap<string, { readonly ahead: number; readonly behind: number } | null>

type Errors = { directory: string | null; message: string }[]

async function describe(
  entry: Porcelain.Worktree,
  primary: boolean,
  counts: Counts,
  errors: Errors,
): Promise<Omit<Worktree, "sessions">> {
  // A nested worktree that lost its `.git` file is `prunable` to git, yet its folder (and work) is still there.
  const exists = !entry.bare && fs.existsSync(entry.path)
  const counted = entry.head === undefined ? undefined : counts.get(entry.head)
  const base = {
    path: entry.path,
    real: exists ? fs.realpathSync.native(entry.path) : null,
    primary,
    bare: entry.bare,
    head: entry.head ?? null,
    branch: entry.branch?.replace(/^refs\/heads\//, "") ?? null,
    detached: entry.detached,
    locked: entry.locked ?? null,
    prunable: entry.prunable ?? null,
    ahead: counted?.ahead ?? null,
    behind: counted?.behind ?? null,
  }
  const blank = { changes: null, detachedOnly: [], operations: [] }
  if (entry.bare) return { ...base, identity: null, ...blank }
  const identity = await Identity.observe(entry.path)
  // A gone folder is reported by `prunable`; anything else that is not this worktree is an error worth showing.
  if (!identity.ok || !Identity.same(identity.toplevel, entry.path)) {
    if (exists)
      errors.push({
        directory: entry.path,
        message: identity.ok ? `맨 위 폴더가 이 폴더가 아니에요: ${identity.toplevel}` : identity.message,
      })
    return { ...base, identity, ...blank }
  }
  const options = { cwd: entry.path, worktree: true }
  const [status, only] = await Promise.all([
    Git.run(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignored=matching"], options),
    entry.detached
      ? Git.run(["rev-list", "HEAD", "--not", "--branches", "--remotes", "--tags"], options)
      : Promise.resolve(undefined),
  ])
  if (!status.ok) errors.push({ directory: entry.path, message: status.message })
  if (only !== undefined && !only.ok) errors.push({ directory: entry.path, message: only.message })
  return {
    ...base,
    identity,
    changes: status.ok ? changes(Porcelain.status(status.stdout)) : null,
    detachedOnly: only?.ok ? only.stdout.split("\n").filter(Git.isOid) : [],
    operations: operations(identity.gitDir),
  }
}

/**
 * Linked worktrees' git dirs by their folder: `<common dir>/worktrees/<name>/gitdir` holds `<folder>/.git`, absolute or
 * (Git 2.48 `worktree.useRelativePaths`) relative to that admin folder.
 */
function adminDirs(commonDir: string) {
  const root = path.join(commonDir, "worktrees")
  const names = fs.existsSync(root) ? fs.readdirSync(root) : []
  return new Map(
    names.flatMap((name) => {
      const admin = path.join(root, name)
      const file = path.join(admin, "gitdir")
      if (!fs.existsSync(file)) return []
      const pointer = fs.readFileSync(file, "utf8").trim()
      return pointer === "" ? [] : [[Identity.key(path.dirname(path.resolve(admin, pointer))), admin] as const]
    }),
  )
}

/** The branch a rebase stopped in `gitDir` started from; `undefined` for none, `git am` or a detached start. */
export function rebasing(gitDir: string) {
  if (fs.existsSync(path.join(gitDir, "rebase-apply")))
    return fs.existsSync(path.join(gitDir, "rebase-apply", "applying"))
      ? undefined
      : branchFile(gitDir, "rebase-apply/head-name")
  if (fs.existsSync(path.join(gitDir, "rebase-merge"))) return branchFile(gitDir, "rebase-merge/head-name")
  return undefined
}

/** A branch name file (`head-name`, `BISECT_START`) as git reads it: trailing newlines cut, `refs/heads/` dropped. */
function branchFile(gitDir: string, name: string) {
  const file = path.join(gitDir, ...name.split("/"))
  if (!fs.existsSync(file)) return undefined
  const text = fs.readFileSync(file, "utf8").replace(/\n+$/, "")
  if (text === "") return undefined
  return text.startsWith("refs/heads/") ? text.slice("refs/heads/".length) : text
}

function changes(status: Porcelain.Status): Changes {
  const count = (test: (entry: Porcelain.Entry) => boolean) => status.entries.filter(test).length
  return {
    staged: count((entry) => (entry.kind === "changed" || entry.kind === "renamed") && entry.xy[0] !== "."),
    unstaged: count((entry) => (entry.kind === "changed" || entry.kind === "renamed") && entry.xy[1] !== "."),
    untracked: count((entry) => entry.kind === "untracked"),
    unmerged: count((entry) => entry.kind === "unmerged"),
    ignored: count((entry) => entry.kind === "ignored"),
    uncommitted: count((entry) => entry.kind !== "ignored"),
  }
}

/** `rev-list --left-right --count <target>...<oid>`: left = behind, right = ahead. */
async function count(commonDir: string, target: string | null, oid: string, errors: Errors) {
  if (target === null) return null
  if (oid === target) return { ahead: 0, behind: 0 }
  const result = await Git.run(["rev-list", "--left-right", "--count", `${target}...${oid}`], {
    cwd: commonDir,
    worktree: true,
  })
  if (!result.ok) {
    errors.push({ directory: null, message: result.message })
    return null
  }
  const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number)
  return { ahead: ahead ?? 0, behind: behind ?? 0 }
}

function branch(fields: readonly string[], counts: Counts): Branch {
  const [ref = "", oid = "", worktree = "", upstream = "", track = ""] = fields
  return {
    name: ref.slice("refs/heads/".length),
    oid,
    worktree: worktree || null,
    upstream: upstream
      ? {
          name: upstream,
          ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
          behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
          gone: track.includes("gone"),
        }
      : null,
    ahead: counts.get(oid)?.ahead ?? null,
    behind: counts.get(oid)?.behind ?? null,
  }
}

/** `git log -g -z --format=%gd%x00%H%x00%P%x00%gs refs/stash` (06 §3.2); without `refs/stash` there is no stack. */
async function stashes(commonDir: string, exists: boolean, errors: Errors) {
  if (!exists) return []
  const result = await Git.run(["log", "-g", "-z", "--format=%gd%x00%H%x00%P%x00%gs", "refs/stash"], {
    cwd: commonDir,
    worktree: true,
  })
  if (!result.ok) {
    errors.push({ directory: null, message: result.message })
    return []
  }
  const fields = Porcelain.fields(result.stdout)
  return Array.from({ length: Math.floor(fields.length / 4) }, (_, index) =>
    fields.slice(index * 4, index * 4 + 4),
  ).map(([ref = "", oid = "", parents = "", subject = ""]) => ({
    ref,
    oid,
    parents: parents.split(" ").filter(Boolean),
    subject,
  }))
}

/** `WIP on <branch>: …` / `On <branch>: …` names the branch; `(no branch)` falls back to the first parent (HEAD then). */
function origin(item: Omit<Stash, "worktree">, worktrees: readonly Omit<Worktree, "sessions">[]) {
  const name = /^(?:WIP on|On) (.+?): /.exec(item.subject)?.[1]
  const byBranch = name === undefined ? undefined : worktrees.find((worktree) => worktree.branch === name)
  const byParent = worktrees.find((worktree) => worktree.head !== null && worktree.head === item.parents[0])
  return (byBranch ?? byParent)?.path ?? null
}

/** `fn` over `items` with at most {@link LIMIT} running at once, results in input order. */
async function parallel<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>) {
  const results: R[] = []
  const next = { index: 0 }
  const worker = async (): Promise<void> => {
    const index = next.index++
    if (index >= items.length) return
    results[index] = await fn(items[index], index)
    return worker()
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, items.length) }, worker))
  return results
}
