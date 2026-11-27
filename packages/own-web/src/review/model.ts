// Review tab rules (03 §18.5, §4.7) as plain functions: which modes exist, the default mode, summaries, the split
// width rule and the size thresholds that decide between drawing, trimming in the worker, and asking first.
import type { FileDiffInfo, VcsBase } from "@opencode/client"

/**
 * `working` HEAD ↔ working copy, `branch` base merge-base ↔ working copy (vcs.diff), `lastTurn` the files the
 * newest turn changed, `session` first turn … last turn (session.diff), `reverted` the files a staged revert put back
 * (`Session.revert.files`, the "변경 보기" target of 18.7).
 */
export type ReviewMode = "working" | "branch" | "lastTurn" | "session" | "reverted"
export type DiffStyle = "unified" | "split"
export type ExpandMode = "expand" | "collapse"

/** 4.7: side-by-side needs 560 px; a narrower tab shows the unified view. */
export const SPLIT_MIN_WIDTH = 560
/** Patches longer than this (characters) are trimmed to hunks in the worker before they reach the viewer. */
export const LARGE_PATCH_CHARS = 150_000
/** More changed lines than this are drawn only on request. */
export const MAX_CHANGED_LINES = 10_000
/** A turn that ended this recently makes `마지막 턴` the default mode (18.5 "턴이 끝난 직후"). */
export const RECENT_TURN_MS = 5 * 60_000
/** Unchanged lines kept around each change when a large patch is trimmed. */
export const TRIM_CONTEXT = 3

export interface ModeContext {
  /** The session's folder is a Git repository (vcs.get reports a provider). */
  readonly vcs: boolean
  readonly branch: boolean
  readonly reverted: boolean
}

export function availableModes(context: ModeContext): ReviewMode[] {
  return [
    ...(context.vcs ? (["working"] as const) : []),
    ...(context.vcs && context.branch ? (["branch"] as const) : []),
    "lastTurn",
    "session",
    ...(context.reverted ? (["reverted"] as const) : []),
  ]
}

/**
 * `브랜치 대 base` is hidden only on the default branch itself, where it equals `커밋 안 된 변경`. An unknown or
 * ambiguous base keeps the mode and asks for a base (18.5 "모호하면 base를 고르세요").
 */
export function branchModeAvailable(current: string | undefined, base: VcsBase | null | undefined) {
  return !(base && base.source === "default" && base.name === current)
}

export function defaultMode(input: {
  readonly vcs: boolean
  readonly running: boolean
  readonly idleAt: number | undefined
  readonly now: number
}): ReviewMode {
  if (!input.vcs) return "lastTurn"
  if (!input.running && input.idleAt !== undefined && input.now - input.idleAt <= RECENT_TURN_MS) return "lastTurn"
  return "working"
}

export function summarize(diffs: readonly FileDiffInfo[]) {
  return diffs.reduce(
    (total, diff) => ({
      count: total.count + 1,
      additions: total.additions + diff.additions,
      deletions: total.deletions + diff.deletions,
    }),
    { count: 0, additions: 0, deletions: 0 },
  )
}

export function sortDiffs(diffs: readonly FileDiffInfo[]) {
  return diffs.toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

export function statusCode(status: FileDiffInfo["status"]) {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

export function splitPath(file: string) {
  const index = file.lastIndexOf("/")
  return { name: file.slice(index + 1), directory: index < 0 ? "" : file.slice(0, index) }
}

/** The server replaces patches over its byte budget with an empty patch; the counts still say lines changed. */
export function needsLoad(diff: FileDiffInfo) {
  if (diff.additions === 0 && diff.deletions === 0) return false
  return !/^@@ /m.test(diff.patch)
}

export function isLarge(diff: FileDiffInfo) {
  return diff.patch.length > LARGE_PATCH_CHARS
}

export function tooLarge(diff: FileDiffInfo) {
  return diff.additions + diff.deletions > MAX_CHANGED_LINES
}

export function effectiveStyle(preferred: DiffStyle, width: number | undefined): DiffStyle {
  if (preferred === "split" && width !== undefined && width < SPLIT_MIN_WIDTH) return "unified"
  return preferred
}

/** The active file: the remembered one while it is still in the list, else the first file. */
export function activeFile(files: readonly string[], remembered: string | undefined) {
  if (remembered && files.includes(remembered)) return remembered
  return files[0]
}

/** Keyboard move inside the file list (↑/↓/Home/End), clamped to the list. */
export function moveFile(files: readonly string[], current: string | undefined, key: string) {
  if (files.length === 0) return undefined
  const index = current ? files.indexOf(current) : -1
  if (key === "Home") return files[0]
  if (key === "End") return files.at(-1)
  if (key === "ArrowDown") return files[Math.min(files.length - 1, index + 1)]
  if (key === "ArrowUp") return files[Math.max(0, index - 1)]
  return undefined
}
