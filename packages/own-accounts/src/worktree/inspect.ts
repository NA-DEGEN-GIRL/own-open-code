export * as WorktreeInspect from "./inspect.js"

import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { RpcTypes } from "../rpc/types.js"

/**
 * What `git worktree remove <directory>` would take along (06 §8.6 step 1, TI-2, TI-3 (b), TG13), for the own-web
 * cleanup dialog. Read-only and bounded:
 * - `directory` must be a linked worktree that `git -C <root> worktree list` reports; the main worktree is refused.
 *   UNC and device paths are refused before any file system or Git call: opening one may reach another machine. The
 *   RPC handler first checks both folders against the project's worktree table (`rpc/worktree.ts`).
 * - nested: other listed worktrees inside it, plus a walk that never follows symlinks or junctions and reports every
 *   folder with a `.git` entry other than the top one (a nested worktree, a submodule, or an independent repository
 *   in an ignored folder, which `git status` shows only as `!! vendor/`). The walk stops at {@link Limits}.
 * - lock: the `locked` line; own's reasons start with `own.team` or `own:` (06 §3.8, TI-12).
 * - ignored: the `git status --ignored` entries, sized after the walk, the biggest first.
 * Git runs without a shell, its arguments as an array (06 §4.3).
 */
export async function inspect(
  input: Pick<RpcTypes.Input<"worktree.inspect">, "root" | "directory">,
  options: { readonly limits?: Partial<Limits>; readonly signal?: AbortSignal } = {},
): Promise<Result> {
  const limits = { ...LIMITS, ...options.limits }
  const network = [input.root, input.directory].find(isNetworkPath)
  if (network !== undefined)
    return { ok: false, error: "not_found", directory: network, message: "UNC and device paths are not inspected" }
  if (!path.isAbsolute(input.root))
    return { ok: false, error: "not_git", directory: input.root, message: "root must be absolute" }
  const listed = await git(input.root, ["worktree", "list", "--porcelain", "-z"], options.signal)
  if (!listed.ok) return { ok: false, error: "not_git", directory: input.root, message: listed.message }
  const worktrees = await Promise.all(
    parseList(listed.stdout).map(async (entry) => ({ ...entry, ...(await real(entry.path)) })),
  )
  const target = path.isAbsolute(input.directory) ? (await real(input.directory)).key : undefined
  const index = worktrees.findIndex((entry) => entry.key === target)
  const self = worktrees[index]
  if (index <= 0 || !self || target === (await real(input.root)).key)
    return { ok: false, error: "not_found", directory: input.directory, message: "not a linked worktree of root" }

  // GIT_CEILING_DIRECTORIES: without its `.git` file, `git -C <dir>` would quietly open the repository around it.
  const status = await git(self.real, ["status", "--porcelain=v1", "-z", "--ignored", "--no-renames"], options.signal, {
    GIT_CEILING_DIRECTORIES: path.dirname(self.real),
  })
  if (!status.ok) return { ok: false, error: "not_git", directory: input.directory, message: status.message }
  const ignored = status.stdout
    .split("\0")
    .filter((field) => field.startsWith("!! "))
    .map((field) => field.slice(3))
  const walked = await walk(self.real, ignored, limits, options.signal)

  const inside = worktrees.filter((entry) => entry !== self && !entry.prunable && isInside(self.key, entry.key))
  const listedKeys = new Set(inside.map((entry) => entry.key))
  const nested = [
    ...inside.map((entry) => ({ path: entry.real, kind: "worktree" as const })),
    ...walked.nested
      .map((relative) => path.join(self.real, ...relative.split("/")))
      .filter((found) => !listedKeys.has(key(found)))
      .map((found) => ({ path: found, kind: "repository" as const })),
  ].toSorted((a, b) => a.path.localeCompare(b.path))
  const sized = walked.ignored.toSorted((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
  const reason = self.locked
  return {
    ok: true,
    inspection: {
      nested,
      scan: walked.complete ? "complete" : "partial",
      lock: reason === undefined ? null : { reason },
      ownLock: reason !== undefined && (reason.startsWith("own.team") || reason.startsWith("own:")),
      ignored: {
        entries: sized.slice(0, limits.top).map((entry) => ({ path: entry.path, bytes: entry.bytes })),
        count: sized.length,
        bytes: sized.reduce((total, entry) => total + entry.bytes, 0),
        truncated: sized.length > limits.top,
      },
    },
  }
}

export interface Limits {
  /** Directory entries the walk reads before it stops (`scan: "partial"`). */
  readonly entries: number
  /** Time for each pass: the search for nested repositories, then the sizing of ignored files. */
  readonly ms: number
  /** Ignored entries listed with their size; the rest only count. */
  readonly top: number
}

/** A worktree with `node_modules` has about 200k entries, which the batched walk reads in one to three seconds. */
export const LIMITS: Limits = { entries: 500_000, ms: 20_000, top: 20 }

export type Result =
  | { readonly ok: true; readonly inspection: RpcTypes.Output<"worktree.inspect"> }
  | {
      readonly ok: false
      readonly error: "not_found" | "not_git"
      readonly directory: string
      readonly message: string
    }

export interface Listed {
  readonly path: string
  /** The lock reason, empty for a lock without one; absent when not locked. */
  readonly locked?: string
  /** Its folder is gone (`git worktree prune` would drop it). */
  readonly prunable: boolean
}

/** `git worktree list --porcelain -z`: NUL-terminated lines, an empty one after each worktree, the main one first. */
export function parseList(stdout: string): Listed[] {
  return stdout
    .split("\0\0")
    .map((record) => record.split("\0").filter(Boolean))
    .flatMap((lines) => {
      const head = lines[0]
      if (!head?.startsWith("worktree ")) return []
      const locked = lines.find((line) => line === "locked" || line.startsWith("locked "))
      return [
        {
          path: head.slice("worktree ".length),
          locked: locked?.slice("locked ".length),
          prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
        },
      ]
    })
}

/** 06 §4.3: queries time out after 30 seconds. */
const GIT_TIMEOUT_MS = 30_000
/** Folders read and files `lstat`ed at once: one call at a time is about ten times slower on Windows. */
const DIRECTORY_BATCH = 32
const STAT_BATCH = 256
const WINDOWS = process.platform === "win32"

async function git(directory: string, args: readonly string[], signal?: AbortSignal, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["git", "-C", directory, "-c", "core.quotepath=false", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0", ...env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code === 0) return { ok: true as const, stdout }
  return { ok: false as const, message: stderr.trim() || `git exited with ${code}` }
}

interface Bucket {
  readonly path: string
  bytes: number
}

interface Folder {
  readonly absolute: string
  readonly relative: string
  /** The ignored entry this folder belongs to: every file below it counts toward that entry. */
  readonly bucket?: Bucket
}

/** A file below an ignored entry, sized in the second pass. */
interface Sized {
  readonly absolute: string
  readonly bucket: Bucket
}

/** Ignored entries by comparison key: `!! build/` names a folder, `!! debug.log` a file. */
interface Owners {
  readonly folders: ReadonlyMap<string, Bucket>
  readonly files: ReadonlyMap<string, Bucket>
}

/**
 * Two passes, never through a link (`Dirent.isSymbolicLink` is also true for a junction). {@link search} reads every
 * folder breadth-first for `.git` entries before {@link size} spends anything on sizes, so an independent repository
 * in a shallow ignored folder (`vendor/lib`) is found before the budget goes into a deep `node_modules`. Either pass
 * running out of its budget makes the scan partial, and the cleanup then refuses (06 TI-3 (b)).
 */
async function walk(top: string, ignored: readonly string[], limits: Limits, signal?: AbortSignal) {
  const buckets = ignored.map((entry): Bucket => ({ path: entry, bytes: 0 }))
  const owners = {
    folders: new Map(
      buckets.filter((item) => item.path.endsWith("/")).map((item) => [key(item.path.slice(0, -1)), item]),
    ),
    files: new Map(buckets.filter((item) => !item.path.endsWith("/")).map((item) => [key(item.path), item])),
  }
  const searched = await search(top, owners, limits, signal)
  const sized = await size(searched.files, Date.now() + limits.ms, signal)
  return { nested: searched.nested, ignored: buckets, complete: searched.complete && sized }
}

/**
 * The first pass: folders in batches from the front of the queue (breadth-first). A folder with a `.git` entry is a
 * nested repository: reported and not entered. An unreadable folder, or the entry or time budget running out, makes
 * it incomplete.
 */
async function search(top: string, owners: Owners, limits: Limits, signal?: AbortSignal) {
  const deadline = Date.now() + limits.ms
  const queue: Folder[] = [{ absolute: top, relative: "" }]
  const found = { nested: [] as string[], files: [] as Sized[][], entries: 0, unreadable: false }
  const result = (complete: boolean) => ({ nested: found.nested, files: found.files.flat(), complete })
  while (queue.length) {
    if (found.entries > limits.entries || Date.now() > deadline || signal?.aborted) return result(false)
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
        queue.push(...finding.folders)
        found.files.push(finding.files)
      })
  }
  return result(!found.unreadable)
}

/** One folder's findings: itself as a nested repository, or its subfolders and the files of ignored entries in it. */
function classify(folder: Folder, entries: readonly Dirent[], owners: Owners) {
  if (folder.relative && entries.some((entry) => isGit(entry.name)))
    return { nested: folder.relative, folders: [], files: [] }
  // The top `.git` is this worktree's own; links are never followed (06 TI-3 (b)).
  const children = entries
    .filter((entry) => !isGit(entry.name) && !entry.isSymbolicLink())
    .map((entry) => ({
      entry,
      absolute: path.join(folder.absolute, entry.name),
      relative: folder.relative ? `${folder.relative}/${entry.name}` : entry.name,
    }))
  return {
    nested: undefined,
    folders: children
      .filter((child) => child.entry.isDirectory())
      .map(
        (child): Folder => ({
          absolute: child.absolute,
          relative: child.relative,
          bucket: folder.bucket ?? owners.folders.get(key(child.relative)),
        }),
      ),
    files: children.flatMap((child): Sized[] => {
      const bucket = folder.bucket ?? owners.files.get(key(child.relative))
      return bucket && child.entry.isFile() ? [{ absolute: child.absolute, bucket }] : []
    }),
  }
}

/** The second pass: `lstat` in batches of {@link STAT_BATCH}; `false` when the time ran out or the call was aborted. */
async function size(files: readonly Sized[], deadline: number, signal?: AbortSignal) {
  const batches = Array.from({ length: Math.ceil(files.length / STAT_BATCH) }, (_, index) =>
    files.slice(index * STAT_BATCH, (index + 1) * STAT_BATCH),
  )
  return batches.reduce(async (previous: Promise<boolean>, batch) => {
    if (!(await previous) || Date.now() > deadline || signal?.aborted) return false
    const stats = await Promise.all(batch.map((file) => fs.lstat(file.absolute).catch(() => undefined)))
    batch.forEach((file, index) => {
      file.bucket.bytes += stats[index]?.size ?? 0
    })
    return true
  }, Promise.resolve(true))
}

/** `\\host\share`, `//host/share`, `\\?\…` and `\\.\…`: another machine or a device namespace. */
function isNetworkPath(value: string) {
  return /^[\\/]{2}/.test(value)
}

function isGit(name: string) {
  return (WINDOWS ? name.toLowerCase() : name) === ".git"
}

/** Comparison key: Windows paths ignore case (`path.resolve` already turned `/` into `\`). */
function key(value: string) {
  return WINDOWS ? value.toLowerCase() : value
}

/** The real path (junctions resolved, so any spelling of a folder matches) and its key; a missing folder resolves. */
async function real(value: string) {
  const resolved = path.resolve(await fs.realpath(value).catch(() => value))
  return { real: resolved, key: key(resolved) }
}

function isInside(parent: string, child: string) {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}
