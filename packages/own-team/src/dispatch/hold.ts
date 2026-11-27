export * as Hold from "./hold.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Symlinks } from "../assets/symlinks.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"

/**
 * Hold refs (06 §8.7): a git copy of a folder's uncommitted work (modified, staged and untracked files; ignored files
 * are never in it) that touches neither the working files nor the real index. Made through a temporary index:
 *
 * ```text
 * tmp = <git-dir>/own-hold-index-<id>                 a copy of the folder's index
 * GIT_INDEX_FILE=tmp git add -A --sparse              a non-zero exit fails the hold
 * changed link copies (4.12): hash-object -w, update-index --index-info (100644; a folder copy's files replace it)
 * T = GIT_INDEX_FILE=tmp git write-tree
 * H = git commit-tree T -p HEAD -m "own hold <scope> <id>"   author and commit date = `at`
 * verify: every non-ignored path of `status --porcelain=v2 -z --untracked-files=all` is in T with its disk hash
 * git update-ref refs/own/hold/<scope>/<id> H 0000…  (create-only)
 * ```
 * `--sparse` is required: in a sparse folder `add -A` exits 1 and leaves out untracked files outside the cone while
 * `write-tree` still succeeds ([R-review] e2), so the exit code fails the hold and the paths are checked at the end.
 * The check runs before the ref is written, so an existing hold ref is always a complete one, and it counts as done
 * whatever its value (06 §8.5). A main request names its hold by its dispatch id (06 §5.1 step 3).
 */

export interface Input {
  /** The folder and its recorded git dir: the identity check (4.3, TI-14) runs first. */
  readonly target: Identity.Record
  /** `ar_<slug>` or `assets` (06 §2.4). */
  readonly scope: string
  /** The work that needs the copy: an op id, or a main request's dispatch id. Names the ref and the temp index. */
  readonly id: string
  /** Author and commit date in epoch milliseconds (`Op.createdAt`, or the request's `createdAt`). */
  readonly at: number
  /** Link copies whose disk content differs from the record ({@link dirtyLinks}); a folder copy brings its files. */
  readonly links?: ReadonlyArray<string>
  readonly signal?: AbortSignal
}

export type Result =
  | {
      readonly ok: true
      readonly ref: string
      readonly sha: string
      /** `false`: the ref already existed (a resumed step). */
      readonly created: boolean
      /** Disk bytes of the copied paths (0 for an existing ref); shown on the card (8.7). */
      readonly bytes: number
    }
  | {
      readonly ok: false
      /** `identity`: the folder is not the recorded worktree; `verify`: a path is missing from the copy. */
      readonly error: "identity" | "git" | "verify"
      readonly message: string
    }

export function ref(scope: string, id: string) {
  return `refs/own/hold/${scope}/${id}`
}

/** Paths with uncommitted work (ignored files excluded), as `status --porcelain=v2 -z --untracked-files=all` lists them. */
export async function changes(directory: string, signal?: AbortSignal) {
  const status = await Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
    cwd: directory,
    worktree: true,
    signal,
  })
  if (!status.ok) return { ok: false as const, message: `변경 목록을 읽지 못했어요: ${status.message}` }
  return {
    ok: true as const,
    paths: Porcelain.status(status.stdout).entries.flatMap((entry) =>
      entry.kind === "renamed" ? [entry.path, entry.from] : entry.kind === "ignored" ? [] : [entry.path],
    ),
  }
}

/**
 * Link copies to add by hand (4.12): the copies {@link Symlinks.dirtyCopies} finds changed. Such a copy is invisible
 * to `status` (its skip-worktree or assume-unchanged flag) and a folder copy is excluded, so `add -A` never takes it.
 * A removed copy has nothing to save; the copy in the tree keeps its recorded content.
 */
export async function dirtyLinks(input: Symlinks.Copies) {
  return (await Symlinks.dirtyCopies(input)).flatMap((copy) => (copy.why === "changed" ? [copy.path] : []))
}

export async function create(input: Input): Promise<Result> {
  const name = ref(input.scope, input.id)
  if (!Refs.valid(name)) return { ok: false, error: "git", message: `쓸 수 없는 이름이에요: ${name}` }
  const checked = await Identity.check(input.target)
  if (!checked.ok) return { ok: false, error: "identity", message: checked.message }
  const directory = input.target.directory
  const existing = await Refs.read(directory, name)
  if (existing === undefined) return { ok: false, error: "git", message: `변경 사본을 읽지 못했어요: ${name}` }
  if (existing !== null) return { ok: true, ref: name, sha: existing, created: false, bytes: 0 }
  const index = path.join(checked.gitDir, `own-hold-index-${input.id}`)
  const built = await build({ ...input, name, gitDir: checked.gitDir, index }).catch(
    (error: unknown): Result => ({
      ok: false,
      error: "git",
      message: `변경 사본을 만들지 못했어요: ${error instanceof Error ? error.message : String(error)}`,
    }),
  )
  await Promise.all([fs.rm(index, { force: true }), fs.rm(`${index}.lock`, { force: true })])
  return built
}

async function build(input: Input & { readonly name: string; readonly gitDir: string; readonly index: string }) {
  const directory = input.target.directory
  const write = {
    cwd: directory,
    worktree: true,
    write: true,
    env: { GIT_INDEX_FILE: input.index },
    signal: input.signal,
  }
  const real = Bun.file(path.join(input.gitDir, "index"))
  if (await real.exists()) await Bun.write(input.index, real)
  const added = await Git.run(["add", "-A", "--sparse"], write)
  if (!added.ok) return failed("git", `변경 사본을 만들지 못했어요(add -A --sparse): ${added.message}`)
  const links = await Symlinks.files(directory, input.links ?? [])
  if (links.length > 0) {
    const stored = await Git.run(["hash-object", "-w", "--stdin-paths"], { ...write, stdin: Git.lines(links) })
    if (!stored.ok) return failed("git", `변경 사본을 만들지 못했어요(hash-object): ${stored.message}`)
    const oids = stored.stdout.split("\n").filter(Git.isOid)
    if (oids.length !== links.length)
      return failed("git", "변경 사본을 만들지 못했어요: hash-object가 낸 id 수가 맞지 않아요")
    const info = await Git.run(["update-index", "--index-info"], {
      ...write,
      stdin: Git.lines(links.map((file, at) => `100644 ${oids[at]}\t${file}`)),
    })
    if (!info.ok) return failed("git", `변경 사본을 만들지 못했어요(update-index): ${info.message}`)
  }
  const tree = await Git.run(["write-tree"], write)
  if (!tree.ok) return failed("git", `변경 사본을 만들지 못했어요(write-tree): ${tree.message}`)
  const treeOid = tree.stdout.trim()
  const head = await Git.run(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: directory, worktree: true })
  const parent = head.ok ? head.stdout.trim() : ""
  const date = `@${Math.floor(input.at / 1000)} +0000`
  const commit = await Git.run(
    [
      "commit-tree",
      "--no-gpg-sign",
      treeOid,
      ...(Git.isOid(parent) ? ["-p", parent] : []),
      "-m",
      `own hold ${input.scope} ${input.id}`,
    ],
    {
      cwd: directory,
      worktree: true,
      write: true,
      signal: input.signal,
      env: {
        GIT_AUTHOR_NAME: "own.team",
        GIT_AUTHOR_EMAIL: "own.team@localhost",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "own.team",
        GIT_COMMITTER_EMAIL: "own.team@localhost",
        GIT_COMMITTER_DATE: date,
      },
    },
  )
  const sha = commit.ok ? commit.stdout.trim() : ""
  if (!commit.ok || !Git.isOid(sha))
    return failed("git", `변경 사본을 만들지 못했어요(commit-tree): ${commit.ok ? sha : commit.message}`)
  const verified = await verify(directory, treeOid, links, input.signal)
  if (!verified.ok) return verified
  const created = await Refs.create(directory, { ref: input.name, oid: sha }, "own.team hold")
  if (!created.ok) return failed("git", `변경 사본을 보관하지 못했어요: ${created.message}`)
  return { ok: true as const, ref: input.name, sha: created.oid, created: created.created, bytes: verified.bytes }
}

/** Every non-ignored status path is in `tree` with its disk hash; a path gone from disk is not in it. */
async function verify(directory: string, tree: string, links: ReadonlyArray<string>, signal?: AbortSignal) {
  const listed = await changes(directory, signal)
  if (!listed.ok) return failed("git", listed.message)
  const paths = [...new Set([...listed.paths, ...links])].filter((file) => !file.includes("\n"))
  const stats = await Promise.all(
    paths.map((file) => fs.lstat(path.join(directory, ...file.split("/"))).catch(() => undefined)),
  )
  const files = paths.filter((_, index) => stats[index]?.isFile())
  const [disk, stored] = await Promise.all([hashes(directory, files), lookup(directory, tree, paths)])
  if (!disk.ok) return failed("git", `변경 사본을 확인하지 못했어요(hash-object): ${disk.message}`)
  if (!stored.ok) return failed("git", `변경 사본을 확인하지 못했어요(cat-file): ${stored.message}`)
  const expected = new Map(files.map((file, index) => [file, disk.oids[index]]))
  const wrong = paths.find((file, index) => {
    const inTree = stored.oids[index]
    if (stats[index] === undefined) return inTree !== null
    if (inTree === null) return true
    const want = expected.get(file)
    return want !== undefined && want !== inTree
  })
  if (wrong !== undefined) return failed("verify", `변경 사본이 디스크의 파일과 달라요: ${wrong}`)
  return {
    ok: true as const,
    bytes: stats.reduce((sum, stat) => sum + (stat?.isFile() ? stat.size : 0), 0),
  }
}

/** `hash-object --stdin-paths` (with the same filters `add` applies), one oid per path. */
async function hashes(directory: string, files: ReadonlyArray<string>) {
  if (files.length === 0) return { ok: true as const, oids: [] as string[] }
  const result = await Git.run(["hash-object", "--stdin-paths"], {
    cwd: directory,
    worktree: true,
    stdin: Git.lines(files),
  })
  if (!result.ok) return { ok: false as const, message: result.message }
  return { ok: true as const, oids: result.stdout.split("\n").filter(Git.isOid) }
}

/** The blob of each path in `tree`, `null` when it is not there (`cat-file --batch-check`). */
async function lookup(directory: string, tree: string, files: ReadonlyArray<string>) {
  if (files.length === 0) return { ok: true as const, oids: [] as Array<string | null> }
  const result = await Git.run(["cat-file", "--batch-check=%(objectname)"], {
    cwd: directory,
    worktree: true,
    stdin: Git.lines(files.map((file) => `${tree}:${file}`)),
  })
  if (!result.ok) return { ok: false as const, message: result.message }
  const lines = result.stdout.split("\n").slice(0, files.length)
  return { ok: true as const, oids: lines.map((line) => (Git.isOid(line.trim()) ? line.trim() : null)) }
}

function failed(error: "git" | "verify", message: string) {
  return { ok: false as const, error, message }
}
