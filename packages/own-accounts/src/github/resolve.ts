export * as GitHubResolve from "./resolve.js"

import fs from "node:fs/promises"
import path from "node:path"
import type { OwnGitHub } from "@own/protocol"
import { GitHubStore } from "./store.js"

/**
 * Which account a conversation or a folder uses (16 §3.2), in this order:
 * 1. the conversation's own choice (its root conversation's: a subagent uses its parent's);
 * 2. the deepest project folder with a choice that holds the folder;
 * 3. for a linked git worktree (a team area, 06 §3), the same for its repository's main checkout;
 * 4. the default account.
 * A choice of `off` ends the search: no GitHub there. A choice that names an account no longer connected is skipped.
 */
export interface Resolved {
  readonly entry?: GitHubStore.Entry
  readonly inUse: OwnGitHub.InUse
}

export async function resolve(
  file: GitHubStore.File,
  input: {
    readonly directory: string
    readonly root?: string
    /**
     * An SSH host's place (16 §8): only that host's choices count, and its folder's main checkout is `main` as the
     * host read it (this PC cannot read the host's files).
     */
    readonly host?: string
    readonly main?: string
  },
): Promise<Resolved> {
  const find = (id: OwnGitHub.Choice) => (id === "off" ? undefined : file.accounts.find((item) => item.id === id))
  const session =
    input.root === undefined ? undefined : GitHubStore.sessionChoice(file.sessions, input.root, input.host)
  if (session && (session.account === "off" || find(session.account)))
    return chosen(find(session.account), {
      source: "session",
      ...(session.directory === undefined ? {} : { directory: session.directory }),
    })
  const project = usable(file, GitHubStore.projectChoice(file.projects, input.directory, input.host))
  if (project) return chosen(find(project.account), { source: "project", directory: project.directory })
  const main = input.host === undefined ? await mainCheckout(input.directory) : input.main
  const linked =
    main === undefined ? undefined : usable(file, GitHubStore.projectChoice(file.projects, main, input.host))
  if (linked) return chosen(find(linked.account), { source: "worktree", directory: linked.directory })
  const fallback = file.default === undefined ? undefined : find(file.default)
  if (fallback) return { entry: fallback, inUse: { account: fallback.id, source: "default" } }
  return { inUse: { source: "none" } }
}

function chosen(entry: GitHubStore.Entry | undefined, place: Omit<OwnGitHub.InUse, "account">): Resolved {
  if (!entry)
    return { inUse: { source: "off", ...(place.directory === undefined ? {} : { directory: place.directory }) } }
  return { entry, inUse: { ...place, account: entry.id } }
}

/** A choice that is `off` or names a connected account; a choice of a removed account counts as none. */
function usable(file: GitHubStore.File, choice: OwnGitHub.ProjectChoice | undefined) {
  if (!choice) return undefined
  if (choice.account === "off") return choice
  return file.accounts.some((item) => item.id === choice.account) ? choice : undefined
}

/** Linked worktrees' main checkouts by folder, for this process: a folder's repository does not move under it. */
const MAINS = new Map<string, string | null>()
const MAX_MAINS = 512

/**
 * The main checkout of the repository a linked worktree in `directory` belongs to: the nearest `.git` above it is a
 * file (`gitdir: <common>/worktrees/<name>`), and that folder's `commondir` names the common `.git` folder, whose
 * parent is the main checkout. `undefined` in a main checkout, a bare repository's worktree, or outside git. Read from
 * the files, without running git.
 */
export async function mainCheckout(directory: string): Promise<string | undefined> {
  const key = path.resolve(directory)
  const known = MAINS.get(key)
  if (known !== undefined) return known ?? undefined
  const found = await findMain(key).catch(() => undefined)
  if (MAINS.size >= MAX_MAINS) MAINS.clear()
  MAINS.set(key, found ?? null)
  return found
}

async function findMain(start: string): Promise<string | undefined> {
  const dotGit = await nearestGit(start)
  if (!dotGit || dotGit.kind === "dir") return undefined
  const text = await fs.readFile(dotGit.path, "utf8")
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1]
  if (!pointer) return undefined
  const gitdir = path.resolve(path.dirname(dotGit.path), pointer)
  const commondir = (await fs.readFile(path.join(gitdir, "commondir"), "utf8").catch(() => undefined))?.trim()
  if (!commondir) return undefined
  const common = path.resolve(gitdir, commondir)
  if (path.basename(common) !== ".git") return undefined
  const main = path.dirname(common)
  return path.resolve(main) === path.resolve(path.dirname(dotGit.path)) ? undefined : main
}

async function nearestGit(
  start: string,
): Promise<{ readonly path: string; readonly kind: "dir" | "file" } | undefined> {
  const candidate = path.join(start, ".git")
  const stat = await fs.stat(candidate).catch(() => undefined)
  if (stat) return { path: candidate, kind: stat.isDirectory() ? "dir" : "file" }
  const parent = path.dirname(start)
  if (parent === start) return undefined
  return nearestGit(parent)
}
