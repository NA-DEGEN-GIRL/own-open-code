export * as Cone from "./cone.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Identity } from "./identity.js"
import { Porcelain } from "./porcelain.js"
import { Git } from "./run.js"

/**
 * The code-only cone (06 §4.5) and the sparse-checkout commands around it (06 §4.6-§4.7).
 *
 * Cone mode can only list folders, and the files at the root and directly inside every ancestor of a listed folder
 * are always checked out. So the cone is the complement of the heavy folders: walk the tree from the root, leave a
 * heavy folder out, take a folder with no heavy folder below it whole, and step into a folder that has one. With
 * heavy `Assets/Textures`, `Assets/Audio`, `Assets/Models` and `Content` the cone is `[Assets/Scripts, docs, src,
 * tools]`, and `Assets/Textures.meta` is checked out anyway ("forced").
 *
 * Commands that change the cone (`set`, `add`, `reapply`) run only after the worktree identity check (06 §4.3,
 * TI-14). Folder lists go through `--stdin`, so a folder named `-x` is a folder, not an option.
 */

/** A folder as the cone lists it: `/` separators, no leading `./` or `/`, no trailing `/`. */
export function normalize(dir: string) {
  return dir
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")
}

/**
 * The complement cone of `heavy` within `trees`, every folder of the tree (`ls-tree -r -d --name-only`). Sorted;
 * heavy folders missing from the tree change nothing.
 */
export function complement(trees: readonly string[], heavy: readonly string[]) {
  const excluded = new Set(heavy.map(normalize).filter(Boolean))
  const descend = new Set([...excluded].flatMap(ancestors))
  const children = Map.groupBy(trees.map(normalize).filter(Boolean), parent)
  const walk = (dir: string): string[] =>
    (children.get(dir) ?? []).flatMap((child) => {
      if (excluded.has(child)) return []
      if (descend.has(child)) return walk(child)
      return [child]
    })
  return walk("").toSorted()
}

/**
 * Whether a file path is checked out under `cone`: at the root, directly inside an ancestor of a cone folder, or
 * anywhere below a cone folder. Built once for many paths.
 */
export function matcher(cone: readonly string[]) {
  const recursive = new Set(cone.map(normalize).filter(Boolean))
  const parents = new Set(["", ...[...recursive].flatMap(ancestors)])
  return (file: string) => {
    const dir = parent(normalize(file))
    return parents.has(dir) || selfAndAncestors(dir).some((item) => recursive.has(item))
  }
}

export function contains(cone: readonly string[], file: string) {
  return matcher(cone)(file)
}

/** `dir` is entirely in the cone (it or an ancestor is a cone folder). */
export function covers(cone: readonly string[], dir: string) {
  const recursive = new Set(cone.map(normalize))
  return selfAndAncestors(normalize(dir)).some((item) => recursive.has(item))
}

/**
 * The complement cone at `rev` plus the area's extra folders (`cone.extra`, 06 §2.4), without redundant entries.
 * `also`: another revision whose folders join the tree (the target's tip, 06 §4.4): a heavy folder the target has and
 * `rev` not yet stays out of the cone even where `rev` has its parent (`Assets` with only `Assets/Scripts` at `rev`
 * would otherwise be taken whole, and the textures would come in with the next merge). Folders only `also` has are
 * harmless cone entries; an `also` that does not resolve is left out.
 */
export async function compute(
  directory: string,
  rev: string,
  heavy: readonly string[],
  extra: readonly string[] = [],
  also?: string,
): Promise<{ readonly ok: true; readonly dirs: string[] } | { readonly ok: false; readonly message: string }> {
  const query = { cwd: directory, worktree: true }
  const [result, other] = await Promise.all([
    Git.run(["ls-tree", "-r", "-d", "-z", "--name-only", rev], query),
    also === undefined ? undefined : Git.run(["ls-tree", "-r", "-d", "-z", "--name-only", also], query),
  ])
  if (!result.ok) return { ok: false, message: result.message }
  const joined = other?.ok ? Porcelain.fields(other.stdout) : []
  const base = complement([...new Set([...Porcelain.fields(result.stdout), ...joined])], heavy)
  const added = [...new Set(extra.map(normalize).filter(Boolean))].filter((dir) => !covers(base, dir))
  return { ok: true, dirs: [...base, ...added].toSorted() }
}

export type Changed =
  | { readonly ok: true }
  /** The identity check failed: the caller marks the area `broken` and stops (TI-14). */
  | { readonly ok: false; readonly error: "broken"; readonly broken: "missing" | "identity"; readonly message: string }
  | { readonly ok: false; readonly error: "invalid" | "git"; readonly message: string }

/** `sparse-checkout set --cone --sparse-index --stdin` (06 §4.5 step 2, §4.7). */
export function set(target: Identity.Record, dirs: readonly string[]) {
  return change(target, ["sparse-checkout", "set", "--cone", "--sparse-index", "--stdin"], dirs)
}

/** `sparse-checkout add --stdin` (06 §4.6 step 3, §4.8). */
export function add(target: Identity.Record, dirs: readonly string[]) {
  return change(target, ["sparse-checkout", "add", "--stdin"], dirs)
}

/** `sparse-checkout reapply`: puts files outside the cone back after a failed add or a tool's write (06 §4.6, §4.9). */
export function reapply(target: Identity.Record) {
  return change(target, ["sparse-checkout", "reapply"], undefined)
}

/** `sparse-checkout list`: the cone folders of a cone-mode worktree. */
export async function list(
  directory: string,
): Promise<{ readonly ok: true; readonly dirs: string[] } | { readonly ok: false; readonly message: string }> {
  const result = await Git.run(["sparse-checkout", "list"], { cwd: directory, worktree: true })
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, dirs: result.stdout.split("\n").filter(Boolean) }
}

/**
 * `sparse-checkout check-rules -z` (Git 2.42): the subset of `paths` (files, relative to the worktree root) that the
 * worktree's cone checks out (06 §4.9 step 1).
 */
export async function check(
  directory: string,
  paths: readonly string[],
): Promise<{ readonly ok: true; readonly inside: Set<string> } | { readonly ok: false; readonly message: string }> {
  if (paths.length === 0) return { ok: true, inside: new Set() }
  const result = await Git.run(["sparse-checkout", "check-rules", "-z"], {
    cwd: directory,
    worktree: true,
    stdin: Git.nul(paths),
  })
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, inside: new Set(Porcelain.fields(result.stdout)) }
}

/**
 * The folders of `dirs` that are entirely in the cone, by `check-rules` (06 §4.6 step 1). A folder path alone matches
 * as soon as its parent is an ancestor of the cone, so each folder is asked as a file two levels below it: that file
 * is in the cone only when the folder or one of its ancestors is a cone folder.
 */
export async function inside(directory: string, dirs: readonly string[]) {
  const probes = dirs.map((dir) => ({ dir, probe: `${normalize(dir)}/${PROBE}/f` }))
  const checked = await check(
    directory,
    probes.map((item) => item.probe),
  )
  if (!checked.ok) return checked
  return { ok: true as const, dirs: probes.filter((item) => checked.inside.has(item.probe)).map((item) => item.dir) }
}

/** A folder name no cone lists. */
const PROBE = ".own-team-probe"

/**
 * Folders a cone change would delete (06 §4.9; checked with Git 2.55). After `sparse-checkout set`, `add` and
 * `reapply`, git removes every tracked folder that the new cone collapses and that is on disk holding only ignored
 * files (git's `clean_tracked_sparse_directories`; a folder with an untracked file stays, with a warning). Answers, for
 * `cone` (the cone after the change), the narrowest folders of such ignored files, so the caller can leave the cone as
 * it is (or bring them in) instead of losing the agent's or the user's output. Read only.
 */
export async function endangered(
  directory: string,
  cone: readonly string[],
): Promise<{ readonly ok: true; readonly dirs: string[] } | { readonly ok: false; readonly message: string }> {
  const query = { cwd: directory, worktree: true }
  const trees = await Git.run(["ls-tree", "-r", "-d", "-z", "--name-only", "HEAD"], query)
  if (!trees.ok) return { ok: false, message: trees.message }
  const recursive = cone.map(normalize).filter(Boolean)
  const parents = new Set(["", ...recursive.flatMap(ancestors)])
  const collapsed = Porcelain.fields(trees.stdout)
    .map(normalize)
    .filter((dir) => dir !== "" && !covers(recursive, dir) && !parents.has(dir) && parents.has(parent(dir)))
  const present = (
    await Promise.all(
      collapsed.map(async (dir) =>
        (await fs.stat(path.join(directory, ...dir.split("/"))).catch(() => undefined))?.isDirectory() ? [dir] : [],
      ),
    )
  ).flat()
  if (present.length === 0) return { ok: true, dirs: [] }
  const status = await Git.run(
    [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--",
      ...present.map((dir) => `${dir}/`),
    ],
    { ...query, env: { GIT_LITERAL_PATHSPECS: "1" } },
  )
  if (!status.ok) return { ok: false, message: status.message }
  const entries = Porcelain.status(status.stdout).entries
  const files = present.flatMap((dir) => {
    const inside = entries.filter((entry) => entry.path.startsWith(`${dir}/`))
    if (inside.some((entry) => entry.kind !== "ignored")) return []
    return inside.map((entry) => (entry.path.endsWith("/") ? entry.path.slice(0, -1) : parent(entry.path)))
  })
  const unique = [...new Set(files)]
  return {
    ok: true,
    dirs: unique.filter((dir) => !unique.some((other) => other !== dir && covers([other], dir))).toSorted(),
  }
}

async function change(
  target: Identity.Record,
  args: readonly string[],
  dirs: readonly string[] | undefined,
): Promise<Changed> {
  const entries = dirs?.map(normalize)
  // `--stdin` is line-based: a name with a line break would become two cone folders.
  const bad = entries?.find((dir) => dir === "" || /[\0\r\n]/.test(dir) || dir.split("/").includes(".."))
  if (bad !== undefined)
    return {
      ok: false,
      error: "invalid",
      message: `가벼운 폴더 범위에 넣을 수 없는 폴더 이름이에요: ${JSON.stringify(bad)}`,
    }
  const identity = await Identity.check(target)
  if (!identity.ok) return { ok: false, error: "broken", broken: identity.broken, message: identity.message }
  const result = await Git.run(args, {
    cwd: target.directory,
    write: true,
    worktree: true,
    stdin: entries === undefined ? undefined : Git.lines(entries),
  })
  if (!result.ok) return { ok: false, error: "git", message: `가벼운 폴더 범위를 바꾸지 못했어요: ${result.message}` }
  return { ok: true }
}

/** `a/b/c` → `a/b`; a top-level entry → `""`. */
function parent(item: string) {
  const slash = item.lastIndexOf("/")
  return slash < 0 ? "" : item.slice(0, slash)
}

/** `a/b/c` → `[a, a/b]` (proper ancestors, root excluded). */
function ancestors(item: string) {
  const parts = item.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

/** `a/b` → `[a/b, a]`; `""` → `[]`. */
function selfAndAncestors(item: string) {
  return item === "" ? [] : [item, ...ancestors(item)]
}
