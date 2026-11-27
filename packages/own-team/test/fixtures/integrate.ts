/**
 * Integration fixtures (06 §7, TG11 parts on Windows): a home on `main` and one plain area worktree on its own branch,
 * with the team and area records over them. Commits are made in a checkout (`add -A`) or by plumbing on a branch no
 * folder has checked out (a temporary index, so no working tree, filter or hook takes part), and LFS pointers are
 * written as plain blobs, so nothing needs git-lfs or a network. Local settings only (`repo.ts`), fake values only.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { area, team } from "../support/context.js"
import { commit, git, init, write } from "./repo.js"

/** The area's slug, branch and folder name. */
export const AREA = "ui"

/** The files of the first commit: code folders, a heavy-candidate `assets/` and ignored build output patterns. */
export const FILES = {
  "README.md": "# integrate\n",
  ".gitignore": "dist/\n*.tsbuildinfo\n",
  "src/app.ts": "export const app = 1\n",
  "src/util.ts": "export const util = 1\n",
  "docs/guide.md": "guide\n",
  "assets/readme.md": "assets\n",
  "assets/textures/rock.bin": "rock\n",
  "assets/audio/music.bin": "music\n",
} as const

export interface Fixture {
  readonly home: string
  /** The first commit: `main` and the area branch start here. */
  readonly base: string
  /** `team()` of the plugin test support over `home` (target `main`, worktree root `<home>-team`). */
  readonly team: OwnTeam.Team
  /** A plain area at `<worktreeRoot>/ui` on branch `ui`, with its real git dir. */
  readonly area: OwnTeam.Area
}

/** The home with {@link FILES} committed and the area worktree next to it. */
export function integrate(root: string): Fixture {
  const home = init(path.join(root, "home"))
  write(home, FILES)
  const base = commit(home, "base")
  const record = team({ home })
  const directory = path.join(record.worktreeRoot, AREA)
  git(home, ["worktree", "add", "-q", "-b", AREA, directory, base])
  const gitDir = git(directory, ["rev-parse", "--absolute-git-dir"]).trim()
  return {
    home,
    base,
    team: record,
    area: { ...area({ slug: AREA, directory }), gitDir, branch: AREA, base: { sha: base, at: 0 } },
  }
}

const counter = { next: 0 }

/**
 * A commit of `files` (`null` removes one) on `refs/heads/<branch>` (created at `from` when given), made through a
 * temporary index: no folder changes, no filter or hook runs. Returns the commit.
 */
export function plumb(
  repo: string,
  branch: string,
  files: Readonly<Record<string, string | null>>,
  options: { readonly from?: string; readonly message?: string } = {},
) {
  const parent = options.from ?? git(repo, ["rev-parse", `refs/heads/${branch}`]).trim()
  const index = path.join(os.tmpdir(), `own-team-index-${process.pid}-${counter.next++}`)
  const env = { GIT_INDEX_FILE: index }
  git(repo, ["read-tree", parent], { env })
  Object.entries(files).forEach(([file, content]) => {
    if (content === null) return git(repo, ["update-index", "--force-remove", "--", file], { env })
    const oid = git(repo, ["hash-object", "-w", "--stdin"], { stdin: content }).trim()
    return git(repo, ["update-index", "--add", "--cacheinfo", `100644,${oid},${file}`], { env })
  })
  const tree = git(repo, ["write-tree"], { env }).trim()
  fs.rmSync(index, { force: true })
  const made = git(repo, ["commit-tree", tree, "-p", parent, "-m", options.message ?? "change"]).trim()
  git(repo, ["update-ref", `refs/heads/${branch}`, made])
  return made
}

/** The text of a Git LFS pointer to an object that exists nowhere (`digit` fills its 64-digit id). */
export function pointer(digit: string, size: number) {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${digit.repeat(64)}\nsize ${size}\n`
}

/**
 * Local LFS filters that fail: any smudge or clean in `repo` would stop git with an error, so a step that finishes
 * proves it ran none (06 §7.2 "merge-tree는 … smudge하지 않는다").
 */
export function failingLfsFilters(repo: string) {
  ;["process", "smudge", "clean"].forEach((key) => git(repo, ["config", `filter.lfs.${key}`, "false"]))
  git(repo, ["config", "filter.lfs.required", "true"])
}

/** Commits `files` in the checkout `dir` and returns the new HEAD. */
export function save(dir: string, files: Readonly<Record<string, string>>, message = "change") {
  write(dir, files)
  return commit(dir, message)
}
