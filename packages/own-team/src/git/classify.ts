export * as Classify from "./classify.js"

import { Identity } from "./identity.js"
import type { Inventory } from "./inventory.js"
import { Git } from "./run.js"

/**
 * The classification table of 06 §3.2, applied to the inventory's worktrees in table order:
 *
 *   home        the folder home picking chose (06 §3.2 홈 고르기): the main's folder, locked when linked
 *   primary     the first entry of `worktree list` when it is not the home: outside the team, never locked or removed
 *   other-tool  a path matching {@link DEFAULT_PATTERNS} or the team's own patterns, or locked for a reason that is not
 *               own's: outside the team, read only (TI-6)
 *   prunable    its folder is gone: outside the team, reported only
 *   hash-path   `#` in its path or real path: not an area candidate, and the reason is shown (FORK §11)
 *   candidate   any other linked worktree: shown to the judge
 *
 * `nested` (inside another worktree) is a flag on top of the class: a nested folder may be a candidate, and the
 * worktree around it is the one to lock (06 §8.6). A clone with the same project but another common dir is another
 * team ({@link clone}).
 *
 * Paths are compared as own-web's `worktree/model.ts` compares them (`groupSessions`, `placeOf`): `/` and `\` are the
 * same separator, a trailing separator is ignored, and a Windows path (drive, UNC or backslash) ignores case. These
 * comparisons are pure; {@link Identity.same} resolves real paths on disk instead.
 */

export type Class = "home" | "primary" | "other-tool" | "prunable" | "hash-path" | "candidate"

/**
 * Worktrees of other tools (06 §3.2): Claude Code, the codex multi-provider app, Codex, Cursor. Matched case-blind
 * anywhere in the path, written with `/`; `*` stays within one folder name and `**` spans folders.
 */
export const DEFAULT_PATTERNS = ["/.claude/worktrees/", "/codex-multi-provider/**/worktrees/", "/.codex/", "/.cursor/"]

export interface Classified {
  readonly path: string
  readonly class: Class
  /** Inside another worktree of the repository. */
  readonly nested: boolean
  /** The innermost worktree around it (the one to lock, 06 §8.6), or `null`. */
  readonly outer: string | null
}

export interface Options {
  /** The team home; `null` while it is being picked (then no entry is `home`). */
  readonly home: string | null
  /** The team's extra other-tool patterns (`team.patterns`, 설정 `팀`), added to {@link DEFAULT_PATTERNS}. */
  readonly patterns?: readonly string[]
}

/** The inventory fields classification reads. */
export type Item = Pick<Inventory.Worktree, "path" | "real" | "primary" | "locked" | "prunable">

/** One class per worktree, in input order. */
export function classify(worktrees: readonly Item[], options: Options): Classified[] {
  const paths = worktrees.map((item) => item.path)
  return worktrees.map((item) => {
    const outer = innermost(
      paths.filter((other) => !same(other, item.path)),
      item.path,
    )
    return {
      path: item.path,
      class: classOf(item, options.home, options.patterns ?? []),
      nested: outer !== null,
      outer,
    }
  })
}

/** A lock own wrote: `own.team …` (areas, home, verify, assets) or `own: …` (06 §3.8). */
export function ownLock(reason: string) {
  return reason.startsWith("own.team") || reason.startsWith("own:")
}

/**
 * Another tool's worktree: its path or real path matches {@link DEFAULT_PATTERNS} or `patterns`, or it is locked for
 * a reason that is not own's. Also used for the main worktree by home picking, where the class `primary` comes first.
 */
export function otherTool(item: Pick<Item, "path" | "real" | "locked">, patterns: readonly string[] = []) {
  const wrapped = [item.path, item.real].filter((value) => value !== null).map((value) => `/${key(value)}/`)
  if ([...DEFAULT_PATTERNS, ...patterns].some((pattern) => wrapped.some((value) => compile(pattern).test(value))))
    return true
  return item.locked !== null && !ownLock(item.locked)
}

/** `#` in the path or the real path (FORK §11: OpenTUI and Vite cut a path at `#`). */
export function hashPath(item: Pick<Item, "path" | "real">) {
  return item.path.includes("#") || (item.real?.includes("#") ?? false)
}

/**
 * Root sessions by worktree (06 §3.2 세션 ↔ 작업 폴더): the longest worktree path that contains the session's folder.
 * `placed` has an entry for every worktree (empty when none); `unplaced` are sessions inside no worktree.
 */
export function placeSessions<S extends { readonly directory: string }>(
  worktrees: readonly string[],
  sessions: readonly S[],
) {
  const groups = Map.groupBy(sessions, (session) => innermost(worktrees, session.directory))
  return {
    placed: new Map(worktrees.map((item) => [item, groups.get(item) ?? []])),
    unplaced: groups.get(null) ?? [],
  }
}

/**
 * Another clone (06 §3.2 다른 클론): the repository around `directory` has another common dir than `commonDir`, so it
 * belongs to another team even when core gives it the same project. `none` = not in a repository (or gone).
 */
export async function clone(commonDir: string, directory: string): Promise<"same" | "other" | "none"> {
  // No worktree ceiling: `directory` may be a subfolder of the checkout.
  const result = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: directory })
  if (!result.ok) return "none"
  return Identity.same(result.stdout.trim(), commonDir) ? "same" : "other"
}

/** Comparison key of a path: `/` separators, no trailing one (roots kept), lower case for a Windows path. */
export function key(value: string) {
  const fold = WINDOWS_SHAPE.test(value) || value.includes("\\")
  const slashed = value.replaceAll("\\", "/")
  const trimmed = /^[A-Za-z]:\/*$/.test(slashed)
    ? `${slashed.slice(0, 2)}/`
    : /^\/+$/.test(slashed)
      ? "/"
      : slashed.replace(/\/+$/, "")
  return fold ? trimmed.toLowerCase() : trimmed
}

export function same(a: string, b: string) {
  return key(a) === key(b)
}

/** `child` is `parent` or below it. */
export function inside(parent: string, child: string) {
  const top = key(parent)
  const item = key(child)
  return item === top || item.startsWith(top.endsWith("/") ? top : `${top}/`)
}

/** A drive letter or a UNC prefix (own-web `isInside`). */
const WINDOWS_SHAPE = /^[A-Za-z]:|^\\\\/

function classOf(item: Item, home: string | null, patterns: readonly string[]): Class {
  if (home !== null && same(item.path, home)) return "home"
  if (item.primary) return "primary"
  if (otherTool(item, patterns)) return "other-tool"
  if (item.prunable !== null) return "prunable"
  if (hashPath(item)) return "hash-path"
  return "candidate"
}

/** The longest of `parents` that contains `child`, or `null`. */
function innermost(parents: readonly string[], child: string) {
  return (
    parents
      .filter((item) => inside(item, child))
      .toSorted((a, b) => key(b).length - key(a).length)
      .at(0) ?? null
  )
}

/** A pattern as a case-blind regular expression over a `/`-wrapped, `/`-separated path. */
function compile(pattern: string) {
  const body = pattern
    .replaceAll("\\", "/")
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*")
  return new RegExp(body, "i")
}
