export * as Measure from "./measure.js"

import fs from "node:fs"
import path from "node:path"
import { Cone } from "./cone.js"
import { Lfs } from "./lfs.js"
import { Porcelain } from "./porcelain.js"
import { Git } from "./run.js"

/**
 * Weighing a revision without checking it out (06 §4.4, the table of §3.3), with plain git and no git-lfs, so the same
 * code runs over SSH:
 *
 *   1  ls-tree -r -z --format="%(objectmode) %(objectname) %(objectsize)%x09%(path)" <rev>   blob sizes
 *   2  check-attr --source=<rev> -z --stdin filter       which small blobs are LFS pointers
 *   3  cat-file --batch                                  each pointer's `oid sha256:` and `size`
 *   4  <LFS store>/objects/<oid[0:2]>/<oid[2:4]>/<oid>   which LFS objects are local
 *   5  ls-files -o -i --exclude-standard --directory     ignored folders, sized on disk within {@link IGNORED_MS}
 *   6  diff --numstat <empty tree> <rev> -- <folders>    binary blobs, only in top-level folders of at least
 *                                                        {@link HEAVY_BYTES} (or `expandBytes`) that hold non-LFS
 *                                                        blobs
 *
 * Step 6 runs with `core.bigFileThreshold` at {@link BIG_FILE_BYTES}: git treats larger blobs as binary without
 * reading them, so the step reads small blobs only. LFS files count as binary.
 *
 * The table lists folders two levels deep, the children of a deeper folder that holds more than {@link DEEPER_SHARE}
 * of all bytes, and the children of any folder of at least `expandBytes` ({@link HEAVY_BYTES}) down to
 * {@link DEEP_DEPTH} levels (2026-10-09: an asset folder three levels down was invisible in a large repository, so the
 * heavy list could not follow it, 06 §4.4). Each row also says how binary the files directly inside it are
 * (`Row.direct`), so {@link ruleBasedHeavy} never takes a folder whole whose own files are code. `direct` keeps the
 * files directly inside every folder, so the bytes the cone cannot leave out ("강제 포함": root files and the files
 * directly inside the folders around cone folders) are known for any choice of heavy folders ({@link forced}).
 */

const MiB = 1024 ** 2

/** A file of at least this size is "big" (the table's `1 MB 이상` column). */
export const BIG_FILE_BYTES = MiB
/** The rule-based fallback's size floor (06 §3.4). */
export const HEAVY_BYTES = 50 * MiB
export const BINARY_RATIO = 0.8
export const DEEPER_SHARE = 0.05
export const TABLE_DEPTH = 2
/** Children of a folder of at least `expandBytes` are listed down to this depth (06 §4.4, 2026-10-09). */
export const DEEP_DEPTH = 4
/** Sizing ignored folders stops after this; unfinished rows are lower bounds ("≥ X"). */
export const IGNORED_MS = 5_000

export interface Row {
  /** Repository-relative folder with `/`; `""` is the whole revision. */
  readonly dir: string
  readonly depth: number
  readonly files: number
  /** Blob bytes as stored (an LFS file counts its pointer). */
  readonly gitBytes: number
  /** Real bytes of LFS files. */
  readonly lfsBytes: number
  /** Real bytes of LFS files whose object is not in the local store. */
  readonly lfsMissing: number
  /** Bytes a full checkout writes: non-LFS blobs plus the real size of LFS files. */
  readonly bytes: number
  /** Files of at least {@link BIG_FILE_BYTES}. */
  readonly bigFiles: number
  /** Share of {@link bytes} in binary files; `null` when some non-LFS bytes were not checked (step 6 skipped them). */
  readonly binaryRatio: number | null
  /** Up to three extensions holding the most bytes. */
  readonly extensions: readonly string[]
  /**
   * The files directly inside the folder (not below its subfolders): their bytes, LFS bytes and binary share (`null`
   * when step 6 did not check them). Absent in rows made by hand.
   */
  readonly direct?: {
    readonly files: number
    readonly bytes: number
    readonly lfsBytes: number
    readonly binaryRatio: number | null
  }
}

/** An ignored folder of the checkout (shared-folder or tool-cache candidate). */
export interface Ignored {
  readonly dir: string
  readonly files: number
  readonly bytes: number
  /** `false`: sizing stopped at the time limit or a folder could not be read, so the counts are lower bounds. */
  readonly complete: boolean
  /** Checkouts or repositories inside it (a `.git` entry), not weighed: nested worktrees, vendored clones. */
  readonly repos: number
}

export interface Result {
  readonly rev: string
  readonly total: Row
  /** The table, most bytes first. */
  readonly rows: readonly Row[]
  /** Files directly inside each folder of the revision (`""` = the root files). */
  readonly direct: Readonly<Record<string, { readonly files: number; readonly bytes: number }>>
  readonly ignored: readonly Ignored[]
  /** Step 6: ran, was not needed, or failed (then ratios with non-LFS bytes are `null`). */
  readonly binary: "measured" | "not-needed" | "failed"
}

/**
 * Weighs `rev` in the checkout `directory` (the team home: step 5 reads its ignored folders). `expandBytes`: from
 * which size a folder's children are listed down to {@link DEEP_DEPTH} levels and its binary blobs are checked
 * (default and at most {@link HEAVY_BYTES}; the heavy-list growth passes a lower team threshold, `assets/heavy.ts`).
 */
export async function measure(
  directory: string,
  rev: string,
  options: { readonly ignoredMs?: number; readonly expandBytes?: number } = {},
): Promise<({ readonly ok: true } & Result) | { readonly ok: false; readonly message: string }> {
  const expandBytes = Math.min(HEAVY_BYTES, options.expandBytes ?? HEAVY_BYTES)
  const query = { cwd: directory, worktree: true }
  const tree = await Git.run(["ls-tree", "-r", "-z", `--format=${TREE_FORMAT}`, rev], query)
  if (!tree.ok) return { ok: false, message: tree.message }
  const blobs = Porcelain.fields(tree.stdout).flatMap((line) => {
    const tab = line.indexOf("\t")
    const [mode = "", oid = "", size = ""] = line.slice(0, tab).split(" ")
    // A submodule (gitlink) has no blob and no size.
    if (mode === "160000") return []
    return [{ mode, oid, size: Number(size), path: line.slice(tab + 1) }]
  })
  const pointers = await lfs(directory, rev, blobs)
  if (!pointers.ok) return pointers
  const files = blobs.map((blob) => {
    const pointer = pointers.found.get(blob.path)
    return {
      path: blob.path,
      gitBytes: blob.size,
      bytes: pointer?.size ?? blob.size,
      lfs: pointer !== undefined,
      missing: pointer?.missing ?? false,
    }
  })
  const [binary, ignored] = await Promise.all([
    binaries(directory, rev, files, blobs[0]?.oid.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1, expandBytes),
    weighIgnored(directory, options.ignoredMs ?? IGNORED_MS),
  ])
  if (!ignored.ok) return ignored
  const sums = new Map<string, Sum>([["", empty()]])
  /** The files directly inside each folder, summed like a row. */
  const own = new Map<string, Sum>([["", empty()]])
  const direct: Record<string, { files: number; bytes: number }> = { "": { files: 0, bytes: 0 } }
  for (const file of files) {
    const folders = parents(file.path)
    const known = file.lfs || binary.measured.has(folders[1] ?? "")
    const binaryFile = known ? file.lfs || binary.set.has(file.path) : null
    const extension = /[^/]\.([^./]+)$/.exec(file.path)?.[1]?.toLowerCase()
    for (const dir of folders) {
      add(sums, dir, file, binaryFile, extension)
      direct[dir] ??= { files: 0, bytes: 0 }
    }
    const parent = folders.at(-1) ?? ""
    add(own, parent, file, binaryFile, extension)
    direct[parent] = { files: direct[parent].files + 1, bytes: direct[parent].bytes + file.bytes }
  }
  const total = sums.get("") ?? empty()
  const listed = [...sums.keys()]
    .filter((dir) => dir !== "")
    .toSorted((a, b) => depth(a) - depth(b))
    .reduce((set, dir) => {
      const up = parents(dir).at(-1) ?? ""
      const bytes = sums.get(up)?.bytes ?? 0
      const expand =
        set.has(up) && (bytes > total.bytes * DEEPER_SHARE || (bytes >= expandBytes && depth(dir) <= DEEP_DEPTH))
      return depth(dir) <= TABLE_DEPTH || expand ? set.add(dir) : set
    }, new Set<string>())
  return {
    ok: true,
    rev,
    total: toRow("", total),
    rows: [...listed]
      .map((dir) => ({ ...toRow(dir, sums.get(dir) ?? empty()), direct: directOf(own.get(dir)) }))
      .toSorted((a, b) => b.bytes - a.bytes || a.dir.localeCompare(b.dir)),
    direct,
    ignored: ignored.rows,
    binary: binary.status,
  }
}

/** The fallback rule of 06 §3.4 for one folder: at least {@link HEAVY_BYTES}, and mostly binary or mostly LFS. */
export function qualifies(row: Row) {
  return row.bytes >= HEAVY_BYTES && binaryish(row)
}

/**
 * The heavy folders of the rule-based proposal (06 §3.4): folders that {@link qualifies}, chosen top-down so the
 * list is small and leaves code in: a qualifying folder is taken whole when every listed subfolder is binary as well
 * and so are the files directly inside it (`Content`), otherwise the walk goes into it (`Assets` with
 * `Assets/Scripts` gives `Assets/Textures`, `Assets/Audio`, …; a folder with code files of its own is never taken
 * whole, 2026-10-09). Never the root (V7).
 */
export function ruleBasedHeavy(rows: readonly Row[]) {
  const children = Map.groupBy(
    rows.filter((row) => row.dir !== ""),
    (row) => parents(row.dir).at(-1) ?? "",
  )
  const walk = (dir: string): string[] =>
    (children.get(dir) ?? []).flatMap((row) => {
      if (row.bytes < HEAVY_BYTES) return []
      const whole =
        (children.get(row.dir) ?? []).every((child) => binaryish(child) || child.bytes === 0) && binaryFiles(row)
      return qualifies(row) && whole ? [row.dir] : walk(row.dir)
    })
  return walk("").toSorted()
}

/** Whether a row is mostly binary or mostly LFS (the share part of {@link qualifies}). */
export function binaryish(row: Pick<Row, "binaryRatio" | "bytes" | "lfsBytes">) {
  return (
    (row.binaryRatio !== null && row.binaryRatio >= BINARY_RATIO) || (row.bytes > 0 && row.lfsBytes * 2 >= row.bytes)
  )
}

/** The files directly inside the row's folder are binary (or there are none, or the row was made by hand). */
function binaryFiles(row: Row) {
  return row.direct === undefined || row.direct.bytes === 0 || binaryish(row.direct)
}

/**
 * The bytes a code-only worktree checks out although no cone folder holds them (06 §4.4 "강제 포함",
 * `team.heavy.forcedBytes`): the root files and the files directly inside every folder around a folder of the
 * complement cone ({@link Cone.complement}) of `heavy`.
 */
export function forced(result: Pick<Result, "direct">, heavy: readonly string[]) {
  const cone = Cone.complement(
    Object.keys(result.direct).filter((dir) => dir !== ""),
    heavy,
  )
  return [...new Set(["", ...cone.flatMap(parents)])].reduce(
    (sum, dir) => ({
      files: sum.files + (result.direct[dir]?.files ?? 0),
      bytes: sum.bytes + (result.direct[dir]?.bytes ?? 0),
    }),
    { files: 0, bytes: 0 },
  )
}

const TREE_FORMAT = "%(objectmode) %(objectname) %(objectsize)%x09%(path)"
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
/** Ignored folders read at a time. */
const BATCH = 32

interface Sum {
  files: number
  gitBytes: number
  lfsBytes: number
  lfsMissing: number
  bytes: number
  bigFiles: number
  binaryBytes: number
  /** Non-LFS bytes step 6 did not check. */
  unknownBytes: number
  extensions: Map<string, number>
}

interface File {
  readonly path: string
  readonly gitBytes: number
  readonly bytes: number
  readonly lfs: boolean
  readonly missing: boolean
}

function empty(): Sum {
  return {
    files: 0,
    gitBytes: 0,
    lfsBytes: 0,
    lfsMissing: 0,
    bytes: 0,
    bigFiles: 0,
    binaryBytes: 0,
    unknownBytes: 0,
    extensions: new Map(),
  }
}

function add(sums: Map<string, Sum>, dir: string, file: File, binary: boolean | null, extension: string | undefined) {
  const sum = sums.get(dir) ?? empty()
  sum.files += 1
  sum.gitBytes += file.gitBytes
  sum.bytes += file.bytes
  if (file.lfs) sum.lfsBytes += file.bytes
  if (file.missing) sum.lfsMissing += file.bytes
  if (file.bytes >= BIG_FILE_BYTES) sum.bigFiles += 1
  if (binary === true) sum.binaryBytes += file.bytes
  if (binary === null) sum.unknownBytes += file.bytes
  if (extension) sum.extensions.set(extension, (sum.extensions.get(extension) ?? 0) + file.bytes)
  sums.set(dir, sum)
}

function toRow(dir: string, sum: Sum): Row {
  return {
    dir,
    depth: depth(dir),
    files: sum.files,
    gitBytes: sum.gitBytes,
    lfsBytes: sum.lfsBytes,
    lfsMissing: sum.lfsMissing,
    bytes: sum.bytes,
    bigFiles: sum.bigFiles,
    binaryRatio: sum.unknownBytes > 0 ? null : sum.bytes === 0 ? 0 : sum.binaryBytes / sum.bytes,
    extensions: [...sum.extensions]
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([extension]) => extension),
  }
}

function directOf(sum: Sum | undefined): NonNullable<Row["direct"]> {
  const row = toRow("", sum ?? empty())
  return { files: row.files, bytes: row.bytes, lfsBytes: row.lfsBytes, binaryRatio: row.binaryRatio }
}

/** `a/b/c` → `["", "a", "a/b"]`: the folders around a file or folder. */
function parents(item: string) {
  const parts = item.split("/").slice(0, -1)
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))]
}

function depth(dir: string) {
  return dir === "" ? 0 : dir.split("/").length
}

/** Steps 2-4: the real size of each LFS file and whether its object is local, by path. */
async function lfs(
  directory: string,
  rev: string,
  blobs: ReadonlyArray<{ readonly mode: string; readonly oid: string; readonly size: number; readonly path: string }>,
): Promise<
  | { readonly ok: true; readonly found: ReadonlyMap<string, { readonly size: number; readonly missing: boolean }> }
  | { readonly ok: false; readonly message: string }
> {
  const query = { cwd: directory, worktree: true }
  const small = blobs.filter((blob) => blob.mode !== "120000" && blob.size <= Lfs.POINTER_MAX_BYTES)
  if (small.length === 0) return { ok: true, found: new Map() }
  const attrs = await Git.run(["check-attr", `--source=${rev}`, "-z", "--stdin", "filter"], {
    ...query,
    stdin: Git.nul(small.map((blob) => blob.path)),
  })
  if (!attrs.ok) return { ok: false, message: attrs.message }
  // `<path> NUL <attribute> NUL <value> NUL` triplets.
  const fields = Porcelain.fields(attrs.stdout)
  const tracked = new Set(
    Array.from({ length: Math.floor(fields.length / 3) }, (_, index) => fields.slice(index * 3, index * 3 + 3))
      .filter((triplet) => triplet[2] === "lfs")
      .map((triplet) => triplet[0]),
  )
  const candidates = small.filter((blob) => tracked.has(blob.path))
  if (candidates.length === 0) return { ok: true, found: new Map() }
  const contents = await Git.bytes(["cat-file", "--batch"], {
    ...query,
    stdin: Git.lines([...new Set(candidates.map((blob) => blob.oid))]),
  })
  if (!contents.ok) return { ok: false, message: contents.message }
  const pointers = batch(contents.stdout)
  const store = await Lfs.storage(directory)
  if (!store.ok) return store
  const objects = [...new Set([...pointers.values()].map((pointer) => pointer.oid))]
  const local = new Set(
    (
      await Promise.all(
        objects.map(async (oid) => ((await Bun.file(Lfs.objectPath(store.dir, oid)).exists()) ? oid : undefined)),
      )
    ).filter((oid) => oid !== undefined),
  )
  return {
    ok: true,
    found: new Map(
      candidates.flatMap((blob) => {
        const pointer = pointers.get(blob.oid)
        // An LFS path committed without LFS is an ordinary blob.
        if (!pointer) return []
        return [[blob.path, { size: pointer.size, missing: !local.has(pointer.oid) }] as const]
      }),
    ),
  }
}

/** `cat-file --batch` output read by byte counts: `<oid> blob <size>\n<content>\n`, or `<oid> missing\n`. */
function batch(output: Uint8Array) {
  const decoder = new TextDecoder()
  const pointers = new Map<string, Lfs.Pointer>()
  for (let offset = 0; offset < output.length; ) {
    const end = output.indexOf(0x0a, offset)
    if (end < 0) break
    const [oid = "", type, size] = decoder.decode(output.subarray(offset, end)).split(" ")
    if (type !== "blob") {
      offset = end + 1
      continue
    }
    const pointer = Lfs.parsePointer(decoder.decode(output.subarray(end + 1, end + 1 + Number(size))))
    if (pointer) pointers.set(oid, pointer)
    offset = end + 1 + Number(size) + 1
  }
  return pointers
}

/** Step 6. `measured` = the top-level folders whose non-LFS blobs were checked; `set` = binary paths among them. */
async function binaries(directory: string, rev: string, files: readonly File[], emptyTree: string, floor: number) {
  const tops = Map.groupBy(
    files.filter((file) => file.path.includes("/")),
    (file) => file.path.slice(0, file.path.indexOf("/")),
  )
  const wanted = [...tops]
    .filter(([, items]) => items.reduce((sum, item) => sum + item.bytes, 0) >= floor && items.some((item) => !item.lfs))
    .map(([dir]) => dir)
  const none = { set: new Set<string>(), measured: new Set<string>() }
  if (wanted.length === 0) return { status: "not-needed" as const, ...none }
  const result = await Git.run(
    [
      "-c",
      `core.bigFileThreshold=${BIG_FILE_BYTES}`,
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-textconv",
      "--no-ext-diff",
      emptyTree,
      rev,
      "--",
      ...wanted,
    ],
    { cwd: directory, worktree: true, env: { GIT_LITERAL_PATHSPECS: "1" } },
  )
  if (!result.ok) return { status: "failed" as const, ...none }
  // `<added> TAB <deleted> TAB <path> NUL`; a binary file has `-` for both counts.
  const set = new Set(
    Porcelain.fields(result.stdout)
      .filter((line) => line.startsWith("-\t-\t"))
      .map((line) => line.slice(4)),
  )
  return { status: "measured" as const, set, measured: new Set(wanted) }
}

/** Step 5 alone, for any checkout (an area folder's large ignored folders, 06 §4.11 `disk.ignored`). */
export function ignored(directory: string, ms = IGNORED_MS) {
  return weighIgnored(directory, ms)
}

/** Step 5: ignored folders of the checkout and their size on disk, within `ms` for all of them together. */
async function weighIgnored(
  directory: string,
  ms: number,
): Promise<{ readonly ok: true; readonly rows: Ignored[] } | { readonly ok: false; readonly message: string }> {
  const listed = await Git.run(["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], {
    cwd: directory,
    worktree: true,
  })
  if (!listed.ok) return { ok: false, message: listed.message }
  const deadline = Date.now() + ms
  const totals = Porcelain.fields(listed.stdout)
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => ({ dir: entry.slice(0, -1), files: 0, bytes: 0, complete: true, repos: 0 }))
  const queue: Visit[] = totals.map((total) => ({ total, folder: path.join(directory, ...total.dir.split("/")) }))
  // Breadth first in batches; the queue grows while it is read.
  for (let start = 0; start < queue.length; ) {
    if (Date.now() >= deadline) {
      for (const item of queue.slice(start)) item.total.complete = false
      break
    }
    const batch = queue.slice(start, start + BATCH)
    start += batch.length
    const found = await Promise.all(batch.map(visit))
    queue.push(...found.flat())
  }
  return { ok: true, rows: totals.toSorted((a, b) => b.bytes - a.bytes || a.dir.localeCompare(b.dir)) }
}

type Visit = {
  readonly total: { files: number; bytes: number; complete: boolean; repos: number }
  readonly folder: string
}

/** One folder: its files' sizes and its subfolders. Links and junctions are not followed. */
async function visit(item: Visit): Promise<Visit[]> {
  const entries = await fs.promises.readdir(item.folder, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) {
    item.total.complete = false
    return []
  }
  if (entries.some((entry) => entry.name === ".git")) {
    item.total.repos += 1
    return []
  }
  const files = entries.filter((entry) => entry.isFile())
  const sizes = await Promise.all(
    files.map((entry) =>
      fs.promises.lstat(path.join(item.folder, entry.name)).then(
        (stat) => stat.size,
        () => 0,
      ),
    ),
  )
  item.total.files += files.length
  item.total.bytes += sizes.reduce((sum, size) => sum + size, 0)
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({ total: item.total, folder: path.join(item.folder, entry.name) }))
}
