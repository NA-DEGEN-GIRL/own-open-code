export * as Home from "./home.js"

import fs from "node:fs"
import path from "node:path"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { Classify } from "./classify.js"
import type { Inventory } from "./inventory.js"

/**
 * Home picking and the folder new areas go in (06 §3.2 홈 고르기, §4.12, §12.2).
 *
 * The home is where the main works. It is not `project.canonical`: canonical is the main worktree, which for this
 * user is a `#` path (`D:\#Projects\own-open-code`) while the work happens in `D:\own-open-code`, and a project
 * row's directory is canonical. So the pick is deterministic, in this order:
 *
 *   1 session          the worktree of the conversation the user was viewing, when it belongs to this repository
 *   2 target-checkout  the checkout of the target branch that is neither a `#` path nor another tool's
 *   3 recent           the checkout with the most recently updated root session (same conditions)
 *   4 canonical        the main worktree (with a bare main worktree, the first checkout that exists)
 *
 * Step 1 accepts a `#` path (the area root then moves to the drive, below) but never another tool's worktree or a
 * gone one: a linked home is locked, and own never locks what another tool owns (TI-6).
 */

export type Worktree = Pick<
  Inventory.Worktree,
  "path" | "real" | "primary" | "bare" | "branch" | "locked" | "prunable" | "sessions"
>

export interface Input {
  readonly worktrees: readonly Worktree[]
  /** The target branch (`team.target`). */
  readonly target: string
  /** The folder of the conversation the user was viewing (`enable{sessionID}`), if any. */
  readonly session?: string
  /** The team's extra other-tool patterns. */
  readonly patterns?: readonly string[]
}

export function pick(input: Input): OwnTeam.Home | undefined {
  const checkouts = input.worktrees.filter((item) => !item.bare)
  // Another tool's worktree or a gone one is never the home; steps 2 and 3 also pass over `#` paths.
  const outside = (item: Worktree) => Classify.otherTool(item, input.patterns) || item.prunable !== null
  const usable = checkouts.filter((item) => !outside(item) && !Classify.hashPath(item))
  const placed =
    input.session === undefined
      ? undefined
      : Classify.placeSessions(
          checkouts.map((item) => item.path),
          [{ directory: input.session }],
        ).placed
  const viewed = checkouts.find((item) => (placed?.get(item.path)?.length ?? 0) > 0)
  if (viewed && !outside(viewed)) return home(viewed, "session")
  const target = usable.find((item) => item.branch === input.target)
  if (target) return home(target, "target-checkout")
  const recent = usable
    .filter((item) => item.sessions.length > 0)
    .toSorted((a, b) => latest(b) - latest(a))
    .at(0)
  if (recent) return home(recent, "recent")
  const canonical = checkouts.find((item) => item.primary) ?? checkouts.find((item) => item.prunable === null)
  return canonical && home(canonical, "canonical")
}

export type Root =
  | { readonly ok: true; readonly directory: string }
  | {
      readonly ok: false
      readonly error: "path_forbidden"
      readonly path: string
      /** `invalid`: the home is a root without a drive, so there is no parent to put the folder in. */
      readonly why: "hash" | "nested" | "invalid"
    }

/** The folder of the home a `inside` root is (06 §4.12 프로젝트 안, 2026-10-27). */
export const INSIDE = ".worktrees"

/**
 * The parent of new areas, `.verify` and `.assets` (06 §4.12), by `layout`:
 *   inside   `<home>/.worktrees` (프로젝트 안, the default since 2026-10-27): inside the home, which the team never
 *            removes; a linked home stays locked while worktrees are nested in it (TI-12, 3.8), and the folder is
 *            ignored through the repository's `info/exclude` ({@link exclude})
 *   beside   `<home's parent>/<home name>-team` (`D:/own-open-code` → `D:/own-open-code-team`, 프로젝트 옆 폴더, every
 *            team before 2026-10-27), on the home's volume and outside every worktree
 * When the home path has a `#`, `<drive>:/own-team/<repository name>` instead either way (also for a `beside` home at a
 * drive root); a `#` path without a drive (POSIX) has no defined place and is refused. The result is refused
 * (`path_forbidden`) when it has a `#` or lies inside a worktree of `worktrees` other than the home it is inside of,
 * where removing the outer folder would take it along (06 §8.6). Written with `/`, as git prints paths.
 */
export function worktreeRoot(
  home: string,
  commonDir: string,
  worktrees: readonly string[],
  layout: OwnTeam.AreaRoot,
): Root {
  const slashed = home.replaceAll("\\", "/").replace(/\/+$/, "")
  const drive = /^([A-Za-z]):/.exec(slashed)?.[1]
  const hash = slashed.includes("#")
  const sideways = !hash && path.posix.basename(slashed) !== "" && !/^[A-Za-z]:$/.test(slashed)
  const inside = !hash && layout === "inside"
  const directory = inside
    ? `${slashed}/${INSIDE}`
    : sideways
      ? path.posix.join(path.posix.dirname(slashed), `${path.posix.basename(slashed)}-team`)
      : drive && `${drive}:/own-team/${repository(commonDir)}`
  if (!directory) return { ok: false, error: "path_forbidden", path: home, why: hash ? "hash" : "invalid" }
  if (directory.includes("#")) return { ok: false, error: "path_forbidden", path: directory, why: "hash" }
  const outer = worktrees.filter((item) => !(inside && Classify.same(item, home)))
  if (outer.some((item) => Classify.inside(item, directory)))
    return { ok: false, error: "path_forbidden", path: directory, why: "nested" }
  return { ok: true, directory }
}

/**
 * The worktree an `inside` root sits in (`<it>/.worktrees`), new areas may be nested in that one (06 §4.12); `undefined`
 * for a root beside the project.
 */
export function holder(worktreeRoot: string) {
  const slashed = worktreeRoot.replaceAll("\\", "/").replace(/\/+$/, "")
  return path.posix.basename(slashed) === INSIDE ? path.posix.dirname(slashed) : undefined
}

/** Marks own's line in `info/exclude` (link copies and shared folders have their own). */
export const EXCLUDE_HEADER = "# own.team area folders (06 §4.12)"

/** The `info/exclude` pattern of an `inside` root: the `.worktrees` folder at a worktree's top. */
export const EXCLUDE_LINE = `/${INSIDE}/`

/**
 * `info/exclude` with {@link EXCLUDE_LINE} under {@link EXCLUDE_HEADER}; `undefined` when a line already ignores the
 * folder (the user's own `.worktrees/` included).
 */
export function excluded(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  if (lines.some((line) => line === EXCLUDE_LINE || line === `${INSIDE}/` || line === `/${INSIDE}`)) return undefined
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${EXCLUDE_HEADER}\n${EXCLUDE_LINE}\n`
}

/**
 * The `.gitignore` own keeps in an `inside` root (`<home>/.worktrees/.gitignore`, 2026-10-27): everything there, itself
 * included. `info/exclude` is the repository's, so a listing through another Git folder does not read it: core's
 * snapshots list a session's untracked files with their own Git folder and `--exclude-standard`, which reads the
 * `.gitignore` files of the work tree, and without this file every step of a main in the main folder walked the Bun
 * cache in there (`.own-bun-cache`, about 1.2 s per snapshot at 20,000 files). Git reads a `.gitignore` only inside the
 * work tree it lists, so the worktrees in the folder (the areas, the user's own) never read it.
 */
export const IGNORE_ALL = "# own.team area folders (06 §4.12): nothing here belongs to the project\n*\n"

/**
 * {@link IGNORE_ALL} as the `.gitignore` of an `inside` root, before own makes something there (an area folder, whose
 * setup command fills `.own-bun-cache`, `.verify`, `.assets`); a `.gitignore` already there (the user's own
 * `.worktrees`) is left as it is. Nothing for a root beside the project.
 */
export async function ignore(worktreeRoot: string) {
  if (holder(worktreeRoot) === undefined) return
  const file = path.join(worktreeRoot, ".gitignore")
  if (!(await Bun.file(file).exists())) await Bun.write(file, IGNORE_ALL)
}

/**
 * After own removed what it made there (an undone new area): own's {@link ignore} file goes when it is all the folder
 * holds, so an undone enable leaves the main folder's files as they were. A file of other content is the user's.
 */
export async function unignore(worktreeRoot: string) {
  if (holder(worktreeRoot) === undefined || !fs.existsSync(worktreeRoot)) return
  const file = path.join(worktreeRoot, ".gitignore")
  const left = fs.readdirSync(worktreeRoot)
  if (left.length !== 1 || left[0] !== ".gitignore" || (await Bun.file(file).text()) !== IGNORE_ALL) return
  fs.rmSync(file)
}

function home(item: Worktree, chosenBy: OwnTeam.Home["chosenBy"]): OwnTeam.Home {
  return { directory: item.path, linked: !item.primary, chosenBy }
}

function latest(item: Worktree) {
  return Math.max(...item.sessions.map((session) => session.updated))
}

/** The repository's name: the folder around a `.git` common dir, or a bare `name.git` without `.git`. */
function repository(commonDir: string) {
  const slashed = commonDir.replaceAll("\\", "/").replace(/\/+$/, "")
  const name = path.posix.basename(slashed)
  const folder = name === ".git" ? path.posix.basename(path.posix.dirname(slashed)) : name.replace(/\.git$/, "")
  // A repository at a drive root (`F:/.git`) is named after the drive.
  return folder.replace(/^([A-Za-z]):$/, "$1")
}
