// Worktree flow, pure part (03 §19.3): the new-session choice (로컬 / 새 워크트리 / 기존 워크트리), `⑂` groups for the
// sidebar (4.3), move destinations, the cleanup guard (06 §10.4 #5) and the server's errors. Paths are server paths
// (Windows or POSIX whatever the browser runs on), compared with `samePath` (drive letter case and separators differ
// between sources, 16.3).
import type { OwnOutput } from "@/data/rpc"
import { baseName, samePath, trimSep } from "@/projects/path"

export type Mode = "local" | "new" | "existing"

export interface Choice {
  readonly mode: Mode
  /** New worktree: the ref it starts from (`worktree.create{branch}` → `git worktree add --detach <dir> <ref>`). */
  readonly base?: string
  /** Existing worktree: its directory. */
  readonly existing?: string
}

export const LOCAL_CHOICE: Choice = { mode: "local" }

/** `worktree.list` entry (`Worktree.Directory`): `strategy` is set for managed worktrees, absent for the root. */
export interface WorktreeEntry {
  readonly directory: string
  readonly strategy?: string
}

/** Display name: the branch checked out there when known, else the folder name (`git worktree add --detach`). */
export function worktreeName(directory: string, branch?: string) {
  return branch || baseName(directory)
}

/** `child` is `parent` or below it. */
export function isInside(parent: string, child: string) {
  if (samePath(parent, child)) return true
  const windows = /^[A-Za-z]:|^\\\\/.test(parent) || parent.includes("\\")
  const norm = (value: string) => {
    const trimmed = trimSep(value)
    return windows ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed
  }
  const base = norm(parent)
  const sep = windows ? "\\" : "/"
  return norm(child).startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Worktrees other than the project root, in list order. */
export function otherWorktrees(list: readonly WorktreeEntry[], root: string) {
  return list.filter((item) => !samePath(item.directory, root))
}

export interface SessionGroups<Row> {
  readonly local: Row[]
  readonly worktrees: { readonly directory: string; readonly rows: Row[] }[]
}

/**
 * Sessions of one project split into the project folder (subfolders included) and `⑂` worktree groups (03 §4.3).
 * With the project's worktree list, a session belongs to the worktree that contains its folder (longest match), so a
 * worktree configured inside the project (`.worktrees/x`) still groups; without it, folders outside the project root
 * are worktrees.
 */
export function groupSessions<Row extends { readonly directory: string }>(
  root: string,
  rows: readonly Row[],
  worktrees?: readonly string[],
): SessionGroups<Row> {
  const known = (worktrees ?? []).filter((item) => !samePath(item, root)).toSorted((a, b) => b.length - a.length)
  const groups = new Map<string, { directory: string; rows: Row[] }>()
  const local: Row[] = []
  for (const row of rows) {
    const owner = known.find((directory) => isInside(directory, row.directory))
    const directory = owner ?? (isInside(root, row.directory) ? undefined : row.directory)
    if (!directory) {
      local.push(row)
      continue
    }
    const key = trimSep(directory).replaceAll("\\", "/").toLowerCase()
    const group = groups.get(key) ?? { directory, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return { local, worktrees: [...groups.values()] }
}

export type Place = { readonly kind: "local" } | { readonly kind: "worktree"; readonly directory: string }

/** Where a session works (5.6 요약 "작업 위치"): the project folder or one of its worktrees. */
export function placeOf(root: string | undefined, directory: string, worktrees?: readonly string[]): Place {
  const known = (worktrees ?? []).filter((item) => !root || !samePath(item, root))
  const owner = known.toSorted((a, b) => b.length - a.length).find((item) => isInside(item, directory))
  if (owner) return { kind: "worktree", directory: owner }
  if (!root || isInside(root, directory)) return { kind: "local" }
  return { kind: "worktree", directory }
}

export interface MoveTarget {
  readonly directory: string
  readonly kind: "local" | "worktree"
}

/** Destinations of `다른 워크트리로 옮기기`: the project root and its worktrees, minus where the session is. */
export function moveTargets(root: string, worktrees: readonly WorktreeEntry[], current: string): MoveTarget[] {
  const here = placeOf(
    root,
    current,
    worktrees.map((item) => item.directory),
  )
  const at = (directory: string) =>
    here.kind === "local" ? samePath(directory, root) : samePath(directory, here.directory)
  return [
    ...(at(root) ? [] : [{ directory: root, kind: "local" as const }]),
    ...otherWorktrees(worktrees, root)
      .filter((item) => !at(item.directory))
      .map((item) => ({ directory: item.directory, kind: "worktree" as const })),
  ]
}

/** The saved choice when it still applies: an existing worktree that left the list falls back to local. */
export function effectiveChoice(choice: Choice | undefined, worktrees: readonly WorktreeEntry[] | undefined): Choice {
  if (!choice) return LOCAL_CHOICE
  if (choice.mode !== "existing") return choice
  const existing = choice.existing
  if (!existing) return LOCAL_CHOICE
  // Until the list loaded, keep the choice (a submit must not silently start in the project root instead).
  if (!worktrees) return choice
  return worktrees.some((item) => samePath(item.directory, existing)) ? choice : LOCAL_CHOICE
}

export interface WorktreeFailure {
  readonly message: string
  /** `git worktree remove` refused: uncommitted changes; `force: true` would discard them. */
  readonly forceRequired: boolean
}

/** Server errors: `WorktreeError{data:{message, forceRequired}}` (protocol groups/worktree.ts) or anything else. */
export function worktreeFailure(error: unknown): WorktreeFailure {
  if (error instanceof Error && error.name === "WorktreeError") {
    const data = (error as Error & { data?: { message?: unknown; forceRequired?: unknown } }).data
    return {
      message: typeof data?.message === "string" ? data.message : error.message,
      forceRequired: data?.forceRequired === true,
    }
  }
  return { message: error instanceof Error ? error.message : String(error), forceRequired: false }
}

/** `worktree.inspect`: what `git worktree remove` would take along (06 §8.6 step 1). */
export type WorktreeInspection = OwnOutput<"worktree.inspect">

/**
 * What the cleanup dialog allows (06 §10.4 #5, TG13), first match wins:
 * - `refuse-nested`: another repository or worktree inside; git would delete its uncommitted work too (TI-3 (b)).
 * - `own-lock`: team mode locked the folder (TI-12); only the team view cleans it up.
 * - `refuse-partial`: the walk stopped before it could rule out a repository inside, which TI-3 (b) requires; the
 *   dialog refuses and offers to look again.
 * - `confirm-ignored`: ignored files go with it (TI-2), so the confirmation names their size.
 * - `ok`: only the working copy goes.
 * - `unknown`: not inspected yet, or the inspection failed. The dialog fails closed.
 */
export type RemoveGuard = "refuse-nested" | "own-lock" | "refuse-partial" | "confirm-ignored" | "ok" | "unknown"

export function removeGuard(inspection: WorktreeInspection | undefined): RemoveGuard {
  if (!inspection) return "unknown"
  if (inspection.nested.length) return "refuse-nested"
  if (inspection.ownLock) return "own-lock"
  if (inspection.scan === "partial") return "refuse-partial"
  if (inspection.ignored.count) return "confirm-ignored"
  return "ok"
}

/**
 * Whether the inspection right before the removal still shows what the user confirmed (06 TI-3 (e), §8.6 step 3):
 * the same guard, nested folders, lock and number of ignored entries. Sizes may move (a log being written) without
 * asking again.
 */
export function sameInspection(confirmed: WorktreeInspection, current: WorktreeInspection) {
  return (
    removeGuard(confirmed) === removeGuard(current) &&
    confirmed.nested.length === current.nested.length &&
    confirmed.nested.every(
      (item, index) => item.kind === current.nested[index]?.kind && samePath(item.path, current.nested[index].path),
    ) &&
    confirmed.lock?.reason === current.lock?.reason &&
    confirmed.ignored.count === current.ignored.count
  )
}

/** `child` as the cleanup lists it: relative to the worktree when inside it (`.worktrees\inner`), else in full. */
export function shownPath(parent: string, child: string) {
  if (samePath(parent, child) || !isInside(parent, child)) return child
  return child.slice(trimSep(parent).length + 1)
}

/** What the cleanup runs, shown in its confirmation (19.2/19.3: say what changes before it happens). */
export function removeCommand(directory: string, force: boolean) {
  return `git worktree remove ${force ? "--force " : ""}"${directory}"`
}

/** Branch list for the base selector: the current branch first, then the rest without duplicates. */
export function baseOptions(branches: readonly string[], current: string | undefined, search: string) {
  const needle = search.trim().toLowerCase()
  const all = [...new Set([...(current ? [current] : []), ...branches])]
  return needle ? all.filter((name) => name.toLowerCase().includes(needle)) : all
}
