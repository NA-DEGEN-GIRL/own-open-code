export * as Lfs from "./lfs.js"

import fs from "node:fs"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { Cone } from "./cone.js"
import { Porcelain } from "./porcelain.js"
import { Git } from "./run.js"
import { GitVersion } from "./version.js"

/**
 * LFS objects a worktree needs and `lfs fetch -I` (06 §4.4 steps 1-4, §4.5 step 3, §4.6 step 3).
 *
 * Counting uses plain git, no git-lfs: `ls-tree` sizes (a pointer is about 130 bytes), `check-attr --source` for
 * `filter=lfs`, `cat-file --batch` for the pointer's `oid sha256:` and `size`, then the shared store
 * `<lfs.storage or common dir/lfs>/objects/<oid[0:2]>/<oid[2:4]>/<oid>` that every worktree of the repository uses.
 *
 * The only LFS command own runs is `git lfs fetch -I <list>` (06 §4.9 item 4); never without a list, never
 * `lfs pull`, `lfs checkout` or `lfs.fetchexclude`.
 *
 * Which git-lfs a repository's checkouts use is `Team.env.lfs` ({@link env}). On an SSH host it is the bundled one
 * (06 §4.13): {@link configure} writes its {@link filter} to the repository's local config (`remote/lfs.ts`).
 */

export interface Pointer {
  /** sha256 hex. */
  readonly oid: string
  readonly size: number
}

export interface Item extends Pointer {
  /** Paths at the revision that hold this object. */
  readonly paths: readonly string[]
}

export interface Missing {
  /** Distinct objects not in the local store. */
  readonly objects: readonly Item[]
  readonly count: number
  readonly bytes: number
}

/** The spec's upper bound for a pointer file; larger blobs are never pointers. */
export const POINTER_MAX_BYTES = 1024

/** `version https://git-lfs.github.com/spec/v1` / `oid sha256:<64 hex>` / `size <n>`. */
export function parsePointer(text: string): Pointer | undefined {
  const lines = text.split("\n").map((line) => line.trim())
  if (!lines[0]?.startsWith("version https://git-lfs.github.com/spec/")) return undefined
  const oid = lines.find((line) => line.startsWith("oid sha256:"))?.slice("oid sha256:".length)
  const size = lines.find((line) => line.startsWith("size "))?.slice("size ".length)
  if (!oid || !/^[0-9a-f]{64}$/.test(oid) || !size || !/^\d+$/.test(size)) return undefined
  return { oid, size: Number(size) }
}

/** The local LFS store of the repository at `directory`: `lfs.storage` (relative = inside the common dir) or `<common dir>/lfs`. */
export async function storage(
  directory: string,
): Promise<{ readonly ok: true; readonly dir: string } | { readonly ok: false; readonly message: string }> {
  const [common, configured] = await Promise.all([
    Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: directory, worktree: true }),
    Git.run(["config", "--get", "lfs.storage"], { cwd: directory, worktree: true }),
  ])
  if (!common.ok) return { ok: false, message: common.message }
  const root = common.stdout.trim()
  const value = configured.ok ? configured.stdout.trim() : ""
  return { ok: true, dir: value ? path.resolve(root, value) : path.join(root, "lfs") }
}

/** `<store>/objects/<oid[0:2]>/<oid[2:4]>/<oid>`. */
export function objectPath(store: string, oid: string) {
  return path.join(store, "objects", oid.slice(0, 2), oid.slice(2, 4), oid)
}

/**
 * LFS objects of the files at `rev` selected by `within` (for a new worktree: {@link Cone.matcher} of its cone)
 * that the shared store does not have (06 §4.5 step 3).
 */
export async function missing(
  directory: string,
  rev: string,
  within: (file: string) => boolean,
): Promise<({ readonly ok: true } & Missing) | { readonly ok: false; readonly message: string }> {
  const tree = await Git.run(
    ["ls-tree", "-r", "-z", "--format=%(objectmode) %(objectname) %(objectsize)%x09%(path)", rev],
    {
      cwd: directory,
      worktree: true,
    },
  )
  if (!tree.ok) return { ok: false, message: tree.message }
  const small = Porcelain.fields(tree.stdout).flatMap((line) => {
    const tab = line.indexOf("\t")
    const [mode, blob, size] = line.slice(0, tab).split(" ")
    const file = line.slice(tab + 1)
    if ((mode !== "100644" && mode !== "100755") || Number(size) > POINTER_MAX_BYTES || !within(file)) return []
    return [{ file, blob: blob ?? "" }]
  })
  if (small.length === 0) return empty()
  const attrs = await Git.run(["check-attr", `--source=${rev}`, "-z", "--stdin", "filter"], {
    cwd: directory,
    worktree: true,
    stdin: Git.nul(small.map((item) => item.file)),
  })
  if (!attrs.ok) return { ok: false, message: attrs.message }
  const lfs = new Set(lfsPaths(Porcelain.fields(attrs.stdout)))
  const candidates = small.filter((item) => lfs.has(item.file))
  if (candidates.length === 0) return empty()
  const blobs = [...new Set(candidates.map((item) => item.blob))]
  const contents = await Git.bytes(["cat-file", "--batch"], { cwd: directory, worktree: true, stdin: Git.lines(blobs) })
  if (!contents.ok) return { ok: false, message: contents.message }
  const pointers = batch(contents.stdout)
  const store = await storage(directory)
  if (!store.ok) return store
  const absent = Map.groupBy(
    candidates.flatMap((item) => {
      const pointer = pointers.get(item.blob)
      if (!pointer || fs.existsSync(objectPath(store.dir, pointer.oid))) return []
      return [{ ...pointer, file: item.file }]
    }),
    (item) => item.oid,
  )
  const objects = [...absent.values()].map((items) => ({
    oid: items[0].oid,
    size: items[0].size,
    paths: items.map((item) => item.file),
  }))
  return { ok: true, objects, count: objects.length, bytes: objects.reduce((total, item) => total + item.size, 0) }
}

/**
 * The `-I` list that fetches `objects` (06 §4.5 step 3): `<cone folder>/**` for each path inside a cone folder, the
 * exact path for a file outside them (forced files inside an ancestor), `<top-level folder>/**` without a cone (a full
 * worktree). git-lfs matches a pattern without `/` at any depth (`src` would also take `Content/src/…`), while one
 * with `/` is anchored at the root, hence `/**`. Root files cannot be anchored and are left to the smudge of
 * `read-tree` (step 4), and so are names a comma-separated pattern cannot carry (`,` or glob characters).
 */
export function includes(cone: readonly string[] | null, objects: readonly Item[]) {
  const dirs = cone?.map(Cone.normalize).filter(Boolean) ?? []
  const patterns = objects.flatMap((item) =>
    item.paths.flatMap((file) => {
      if (!file.includes("/") || /[,*?[\\]/.test(file)) return []
      const folder = cone === null ? file.slice(0, file.indexOf("/")) : dirs.find((dir) => file.startsWith(`${dir}/`))
      return [folder === undefined ? file : `${folder}/**`]
    }),
  )
  return [...new Set(patterns)].toSorted()
}

/**
 * `git lfs fetch --include=<a,b,…>` in `directory`, in groups that keep the command line short. Nothing to fetch
 * runs nothing: an `lfs fetch` without a list would fetch every object of the ref (06 §4.9).
 */
export async function fetch(
  directory: string,
  patterns: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly runs: number } | { readonly ok: false; readonly message: string }> {
  const groups = chunk(patterns, INCLUDE_CHARS)
  const failed = await groups.reduce<Promise<string | undefined>>(async (previous, group) => {
    const message = await previous
    if (message !== undefined) return message
    const result = await Git.run(["lfs", "fetch", `--include=${group.join(",")}`], {
      cwd: directory,
      write: true,
      worktree: true,
      signal,
    })
    return result.ok ? undefined : result.message
  }, Promise.resolve(undefined))
  if (failed !== undefined) return { ok: false, message: failed }
  return { ok: true, runs: groups.length }
}

/** `Team.env.lfs` (06 §2.4). */
export type Env = OwnTeam.Team["env"]["lfs"]

/**
 * The filter settings that run the git-lfs in `tools` by its absolute path (06 §4.13): what `git lfs install --local`
 * writes, with `<tools>/git-lfs` for `git-lfs`. git runs a filter command with a space through the shell, so the path
 * is quoted for `sh`.
 */
export function filter(tools: string) {
  const exe = `'${path.join(tools, "git-lfs").replaceAll("'", `'\\''`)}'`
  return {
    "filter.lfs.process": `${exe} filter-process`,
    "filter.lfs.smudge": `${exe} smudge -- %f`,
    "filter.lfs.clean": `${exe} clean -- %f`,
    "filter.lfs.required": "true",
  }
}

/** The local config of the repository at `directory` (`<common dir>/config`) holds every setting of {@link filter}. */
export async function configured(
  directory: string,
  tools: string,
): Promise<{ readonly ok: true; readonly configured: boolean } | { readonly ok: false; readonly message: string }> {
  const local = await settings(directory)
  if (!local.ok) return local
  return { ok: true, configured: ours(local.values, tools) }
}

/**
 * The section of the repository's local config that keeps its own `filter.lfs.*` values from before own's filter
 * (06 §4.13): `<section>.<key>` per value that was there, and `<section>.saved` once they were read. own-remote's
 * uninstall reads the same names to put them back before it removes the tools folder.
 */
export const SAVED = "own-team-lfs"

/**
 * Writes {@link filter} with `git config --local`, one setting at a time (each takes the config lock): one file for
 * every worktree and every shell of the repository, and never the user's `~/.gitconfig` (06 §4.13). The values it
 * replaces are kept first in {@link SAVED} (once: a second call keeps the first record), so {@link restore} can put
 * them back. Returns why it failed, or `undefined`.
 */
export async function configure(directory: string, tools: string, signal?: AbortSignal) {
  const local = await settings(directory)
  if (!local.ok) return local.message
  const keep = local.values.has(`${SAVED}.saved`)
    ? []
    : [
        ...KEYS.flatMap((key) => {
          const value = local.values.get(`filter.lfs.${key}`)
          return value === undefined ? [] : [[`${SAVED}.${key}`, value] as const]
        }),
        [`${SAVED}.saved`, "true"] as const,
      ]
  return write(directory, [...keep, ...Object.entries(filter(tools))], signal)
}

/**
 * Undoes {@link configure} (06 §4.13: enable's undo, disable): while the local filter is still own's, each
 * `filter.lfs.*` value goes back to the saved one, or is unset when there was none; a filter someone changed since is
 * left as it is. The saved section goes either way. Returns why it failed, or `undefined`.
 */
export async function restore(directory: string, tools: string, signal?: AbortSignal) {
  const local = await settings(directory)
  if (!local.ok) return local.message
  if (ours(local.values, tools)) {
    const back = await KEYS.reduce<Promise<string | undefined>>(async (previous, key) => {
      const failed = await previous
      if (failed !== undefined) return failed
      const saved = local.values.get(`${SAVED}.${key}`)
      const args =
        saved === undefined
          ? ["config", "--local", "--unset-all", `filter.lfs.${key}`]
          : ["config", "--local", `filter.lfs.${key}`, saved]
      const result = await Git.run(args, { cwd: directory, write: true, worktree: true, signal })
      // Exit 5: nothing to unset.
      return result.ok || (result.reason === "exit" && result.code === 5) ? undefined : result.message
    }, Promise.resolve(undefined))
    if (back !== undefined) return back
  }
  if (![...local.values.keys()].some((key) => key.startsWith(`${SAVED}.`))) return undefined
  const removed = await Git.run(["config", "--local", "--remove-section", SAVED], {
    cwd: directory,
    write: true,
    worktree: true,
    signal,
  })
  return removed.ok ? undefined : removed.message
}

/** Whether the repository's local config still holds own's filter for `tools` (every setting of {@link filter}). */
export async function restorable(directory: string, tools: string) {
  const local = await settings(directory)
  if (!local.ok) return local
  return {
    ok: true as const,
    restorable: ours(local.values, tools) || [...local.values.keys()].some((key) => key.startsWith(`${SAVED}.`)),
  }
}

const KEYS = ["process", "smudge", "clean", "required"] as const

function ours(values: ReadonlyMap<string, string>, tools: string) {
  return Object.entries(filter(tools)).every(([key, value]) => values.get(key) === value)
}

/** The repository's local `filter.lfs.*` and {@link SAVED} settings by name. */
async function settings(
  directory: string,
): Promise<
  { readonly ok: true; readonly values: ReadonlyMap<string, string> } | { readonly ok: false; readonly message: string }
> {
  const local = await Git.run(["config", "--local", "-z", "--get-regexp", `^(filter\\.lfs|${SAVED})\\.`], {
    cwd: directory,
    worktree: true,
  })
  // Exit 1: no such setting.
  if (!local.ok && !(local.reason === "exit" && local.code === 1)) return { ok: false, message: local.message }
  // `-z`: `<key>\n<value>` NUL per setting.
  const values = new Map(
    (local.ok ? Porcelain.fields(local.stdout) : []).map((entry) => {
      const newline = entry.indexOf("\n")
      return newline < 0 ? [entry, ""] : [entry.slice(0, newline), entry.slice(newline + 1)]
    }),
  )
  return { ok: true, values }
}

/** `git config --local <key> <value>` one at a time; why one failed, or `undefined`. */
function write(directory: string, entries: ReadonlyArray<readonly [string, string]>, signal?: AbortSignal) {
  return entries.reduce<Promise<string | undefined>>(async (previous, [key, value]) => {
    const failed = await previous
    if (failed !== undefined) return failed
    const result = await Git.run(["config", "--local", key, value], {
      cwd: directory,
      write: true,
      worktree: true,
      signal,
    })
    return result.ok ? undefined : result.message
  }, Promise.resolve(undefined))
}

/**
 * `Team.env.lfs` of the repository at `directory`: `unused` without LFS files; `own` when its local config runs the
 * bundled git-lfs in `tools` (a remote service passes `Git.tools()`, 06 §4.13); `system` when another filter is
 * configured or, on this PC, `git lfs version` answers; else `missing`.
 */
export async function env(
  directory: string,
  tools?: string,
): Promise<{ readonly ok: true; readonly lfs: Env } | { readonly ok: false; readonly message: string }> {
  const used = await GitVersion.usesLfs(directory)
  if (!used.ok) return used
  if (!used.used) return { ok: true, lfs: "unused" }
  const ours = tools === undefined ? undefined : await configured(directory, tools)
  if (ours && !ours.ok) return ours
  if (ours?.configured) return { ok: true, lfs: "own" }
  const other = await Git.run(["config", "--get", "filter.lfs.process"], { cwd: directory, worktree: true })
  if (other.ok && other.stdout.trim() !== "") return { ok: true, lfs: "system" }
  if (tools !== undefined) return { ok: true, lfs: "missing" }
  return { ok: true, lfs: (await Git.run(["lfs", "version"])).ok ? "system" : "missing" }
}

/** Characters of one `--include` value (Windows command lines end at 32k). */
const INCLUDE_CHARS = 8_000

function empty() {
  return { ok: true as const, objects: [], count: 0, bytes: 0 }
}

/** `check-attr -z` output: `<path> NUL <attr> NUL <value> NUL` triplets. */
function lfsPaths(fields: readonly string[]) {
  return Array.from({ length: Math.floor(fields.length / 3) }, (_, index) => fields.slice(index * 3, index * 3 + 3))
    .filter((triplet) => triplet[2] === "lfs")
    .map((triplet) => triplet[0])
}

/** `cat-file --batch` output, read by byte counts: `<oid> blob <size>\n<content>\n`, or `<oid> missing\n`. */
function batch(output: Uint8Array) {
  const decoder = new TextDecoder()
  const pointers = new Map<string, Pointer>()
  for (let offset = 0; offset < output.length; ) {
    const end = output.indexOf(0x0a, offset)
    if (end < 0) break
    const [oid, type, size] = decoder.decode(output.subarray(offset, end)).split(" ")
    if (type !== "blob") {
      offset = end + 1
      continue
    }
    const content = output.subarray(end + 1, end + 1 + Number(size))
    const pointer = parsePointer(decoder.decode(content))
    if (pointer && oid) pointers.set(oid, pointer)
    offset = end + 1 + Number(size) + 1
  }
  return pointers
}

function chunk(items: readonly string[], limit: number) {
  return items.reduce<string[][]>((groups, item) => {
    const last = groups.at(-1)
    if (last && last.join(",").length + item.length + 1 <= limit) return [...groups.slice(0, -1), [...last, item]]
    return [...groups, [item]]
  }, [])
}
