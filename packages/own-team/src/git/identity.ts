export * as Identity from "./identity.js"

import fs from "node:fs"
import path from "node:path"
import { Git } from "./run.js"

/**
 * Worktree identity (06 §4.3, TI-14). The registry keeps an area's folder and its absolute git dir
 * (`<common dir>/worktrees/<name>`). Before any git command that changes the folder's files or cone, the folder must
 * still be that worktree: `rev-parse --absolute-git-dir` equals the recorded git dir and `--show-toplevel` equals the
 * folder. The query runs with the ceiling of {@link Git.Options.worktree}, so a nested area whose `.git` file is gone
 * fails here instead of resolving to the home around it. A mismatch is reported, never repaired: the caller marks the
 * area `broken` (`identity`) and stops every step.
 */

export interface Record {
  /** The worktree folder (native path). */
  readonly directory: string
  /** `rev-parse --absolute-git-dir` recorded when the worktree was made (06 §4.5 step 6). */
  readonly gitDir: string
}

export type Observed =
  | { readonly ok: true; readonly gitDir: string; readonly toplevel: string }
  | { readonly ok: false; readonly why: "missing" | "identity"; readonly message: string }

export type Check =
  | { readonly ok: true; readonly gitDir: string; readonly toplevel: string }
  | {
      readonly ok: false
      /** `missing`: the folder is gone (06 §8.8); `identity`: it is not the recorded worktree. */
      readonly broken: "missing" | "identity"
      readonly message: string
    }

/** What git says the folder is, without looking above it. */
export async function observe(directory: string): Promise<Observed> {
  if (!fs.existsSync(directory)) return { ok: false, why: "missing", message: `폴더가 없어요: ${directory}` }
  const result = await Git.run(["rev-parse", "--absolute-git-dir", "--show-toplevel"], {
    cwd: directory,
    worktree: true,
  })
  if (!result.ok) return { ok: false, why: "identity", message: `작업 폴더를 읽지 못했어요: ${result.message}` }
  const [gitDir, toplevel] = result.stdout.split("\n").map((line) => line.trim())
  if (!gitDir || !toplevel) return { ok: false, why: "identity", message: "작업 폴더의 Git 폴더를 읽지 못했어요" }
  return { ok: true, gitDir, toplevel }
}

/** {@link observe} compared with the record: both paths must match (06 §4.3). */
export async function check(record: Record): Promise<Check> {
  const observed = await observe(record.directory)
  if (!observed.ok) return { ok: false, broken: observed.why, message: observed.message }
  if (!same(observed.gitDir, record.gitDir))
    return {
      ok: false,
      broken: "identity",
      message: `Git 폴더가 기록과 달라요: ${observed.gitDir}(기록 ${record.gitDir})`,
    }
  if (!same(observed.toplevel, record.directory))
    return {
      ok: false,
      broken: "identity",
      message: `맨 위 폴더가 기록과 달라요: ${observed.toplevel}(기록 ${record.directory})`,
    }
  return observed
}

/**
 * Comparison key of a path: real path when it exists (junctions resolved, so any spelling matches), separators
 * normalized, and case folded on Windows. Git prints `C:/x/y`; the registry may hold `C:\x\y`.
 */
export function key(value: string) {
  const resolved = path.resolve(real(value))
  return WINDOWS ? resolved.toLowerCase() : resolved
}

export function same(a: string, b: string) {
  return key(a) === key(b)
}

/** `child` is `parent` or inside it. */
export function inside(parent: string, child: string) {
  const top = key(parent)
  const item = key(child)
  return item === top || item.startsWith(top.endsWith(path.sep) ? top : top + path.sep)
}

const WINDOWS = process.platform === "win32"

function real(value: string) {
  return fs.existsSync(value) ? fs.realpathSync.native(value) : value
}
