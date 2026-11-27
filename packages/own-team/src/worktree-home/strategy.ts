export * as WorktreeHome from "./strategy.js"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Git } from "../git/run.js"
import { Home } from "../git/home.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { TeamHome } from "../ops/home.js"

/**
 * Where a worktree made outside team mode goes (06 §4.12a, 2026-11-24): the same place team mode puts new areas,
 * `<project>/.worktrees/<name>` with own's `.gitignore` there and `/.worktrees/` in `info/exclude`, instead of core's
 * app-data default (`packages/core/src/worktree/strategies.ts`, `<data>/worktree/<project id 6>`).
 *
 * own registers core's `git` strategy again under the same id (core's plugin API: "Strategies may return a different
 * directory", `packages/plugin/src/worktree.ts`), so every caller of core's `worktree.create` gets it: the sidebar's
 * `새 워크트리`, core's `worktree_create` tool, own's `worktree_start`. Removal and listing do what core's do; a
 * strategy failure keeps Git's `forceRequired` through core P-062. Without own (a failed plugin) core's own strategy
 * of the same id takes over again, so rows stay removable.
 *
 * Only core's default moves: when the suggested parent is not core's default folder, a project config
 * `worktree.directory` or an explicit `directory` chose it, and it stays. The project folder is the repository's main
 * worktree (git never removes it; a folder nested in a linked worktree would go with it); its `.worktrees` comes from
 * {@link Home.worktreeRoot} (`inside`): a `#` path gives `<drive>:/own-team/<repository>`, and a refused or bare one
 * keeps core's suggestion. Existing worktrees elsewhere stay where they are.
 */

export const STRATEGY_ID = "git"

/** core's default parent (`strategies.ts`: `path.join(global.data, "worktree", project.id.slice(0, 6))`). */
export function coreDefault(projectID: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  // `@opencode/util/global-roots`: XDG_DATA_HOME, else `~/.local/share`, then the app name.
  const data = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "worktree", projectID.slice(0, 6))
}

export interface Placed {
  /** The folder the worktree goes in. */
  readonly directory: string
  /** `.worktrees` of the project, when own placed it there; absent when core's suggestion stays. */
  readonly root?: string
}

/**
 * The folder for a worktree core suggested at `suggested` (its default parent plus a free name), made from
 * `sourceDirectory`: `<main worktree>/.worktrees/<name>` (a free name: `-2` … `-10` after it) when the parent is
 * core's default, else `suggested` as it is.
 */
export async function place(input: {
  readonly projectID: string
  readonly sourceDirectory: string
  readonly suggested: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): Promise<Placed> {
  if (!Identity.same(path.dirname(input.suggested), coreDefault(input.projectID, input.env)))
    return { directory: input.suggested }
  const root = await rootOf(input.sourceDirectory)
  if (root === undefined) return { directory: input.suggested }
  const name = path.basename(input.suggested)
  const free = [name, ...Array.from({ length: 9 }, (_, index) => `${name}-${index + 2}`)]
    .map((item) => path.join(root.directory, item))
    .find((item) => !fs.existsSync(item))
  return free === undefined ? { directory: input.suggested } : { directory: free, root: root.directory }
}

/**
 * `<main worktree>/.worktrees` of the repository at `directory`, with its common Git folder; `undefined` when git
 * cannot tell, the repository is bare, or {@link Home.worktreeRoot} refuses the place.
 */
export async function rootOf(directory: string) {
  const common = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: directory })
  const listed = await Git.run(["worktree", "list", "--porcelain", "-z"], { cwd: directory })
  if (!common.ok || !listed.ok) return undefined
  const worktrees = Porcelain.worktrees(listed.stdout)
  const main = worktrees[0]
  if (!main || main.bare) return undefined
  const root = Home.worktreeRoot(
    main.path,
    common.stdout.trim(),
    worktrees.map((item) => item.path),
    "inside",
  )
  if (!root.ok) return undefined
  return { directory: path.normalize(root.directory), commonDir: common.stdout.trim() }
}

/**
 * Makes the folder ready before git adds a worktree there: own's `.gitignore` (`Home.ignore`) and the
 * `info/exclude` line (`TeamHome.exclude`), as team mode does for a new area.
 */
export async function prepare(root: string, commonDir: string) {
  await fs.promises.mkdir(root, { recursive: true })
  await Home.ignore(root)
  await TeamHome.exclude({ commonDir, worktreeRoot: root })
}

/** Registers the strategy in this Location (core reads the project's canonical Location's registry). */
export function register(ctx: Pick<Plugin.Context, "worktree" | "location">) {
  return ctx.worktree.transform((editor) =>
    editor.add({
      id: STRATEGY_ID,
      create: async (input, context) => {
        const placed = await place({
          projectID: ctx.location.project.id,
          sourceDirectory: input.sourceDirectory,
          suggested: input.directory,
        })
        if (placed.root !== undefined) {
          const common = await rootOf(input.sourceDirectory)
          if (common) await prepare(placed.root, common.commonDir)
        }
        const added = await Git.run(["worktree", "add", "--detach", "--", placed.directory, input.branch ?? "HEAD"], {
          cwd: input.sourceDirectory,
          write: true,
          signal: context.signal,
        })
        if (!added.ok) throw failure("create", added)
        return { directory: placed.directory }
      },
      remove: async (input, context) => {
        const common = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          cwd: input.directory,
          worktree: true,
        })
        if (!common.ok) throw failure("remove", common)
        const removed = await Git.run(
          ["worktree", "remove", ...(input.force ? ["--force"] : []), input.directory],
          { cwd: common.stdout.trim(), write: true, signal: context.signal },
        )
        if (!removed.ok) throw failure("remove", removed)
      },
      list: async (directory, context) => {
        const listed = await Git.run(["worktree", "list", "--porcelain", "-z"], { cwd: directory, signal: context.signal })
        if (!listed.ok) throw failure("list", listed)
        // core's `Git.worktree.list`: the first entry is the main worktree (`root`), the others linked ones.
        return Porcelain.worktrees(listed.stdout).map((item, index) => ({
          directory: path.resolve(directory, item.path),
          type: index === 0 ? ("root" as const) : ("worktree" as const),
        }))
      },
    }),
  )
}

/** Git's refusal, with core's `forceRequired` test (`packages/core/src/git.ts` `worktreeRun`). */
function failure(operation: "create" | "remove" | "list", result: Extract<Git.Result, { ok: false }>) {
  const message = result.stderr.trim() || result.stdout.trim() || result.message
  return Object.assign(new Error(message), {
    forceRequired: operation === "remove" && /contains modified or untracked files|is dirty/i.test(message),
  })
}
