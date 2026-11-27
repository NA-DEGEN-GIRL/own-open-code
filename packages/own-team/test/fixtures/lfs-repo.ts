/**
 * F2 (06 §11.2): an LFS repository with a bare `file://` remote. git-lfs moves objects to and from a `file://` remote
 * with its standalone transfer agent, so nothing listens on a port. The URL is built from the native path (a Git Bash
 * `/d/…` URL breaks the standalone transfer, 06 §4.3). "Offline" renames the remote folder.
 *
 * The home is cloned with `GIT_LFS_SKIP_SMUDGE=1`: its working files are pointers and the shared store
 * `<home>/.git/lfs/objects` starts empty, so every object a new worktree needs is missing until fetched.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { configure, git, head, init, template, write } from "./repo.js"

/** git-lfs is installed (Git for Windows ships it; dev-host has none, 06 §4.13). */
export const lfsAvailable = Bun.spawnSync(["git", "lfs", "version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0

export const F2_HEAVY = ["Assets/Textures", "Assets/Audio", "Content"] as const

/** LFS files and their sizes. In the cone: `src/icons/logo.png`, `-dash/icon.png` and the forced `Assets/banner.png`. */
export const F2_LFS = {
  "src/icons/logo.png": 3_000,
  "-dash/icon.png": 1_500,
  "Assets/banner.png": 2_000,
  "Assets/Textures/rock.png": 50_000,
  "Assets/Textures/tree.png": 60_000,
  "Assets/Audio/music.wav": 40_000,
  "Content/map.bin": 30_000,
  // A heavy folder named like a cone folder: an unanchored `-I src` would fetch it too.
  "Content/src/deep.bin": 10_000,
} as const

export const F2_IN_CONE = ["src/icons/logo.png", "-dash/icon.png", "Assets/banner.png"] as const

export interface F2 {
  readonly origin: string
  readonly url: string
  readonly home: string
  readonly head: string
  /** Files in the home's shared LFS store. */
  readonly objects: () => number
  readonly offline: () => void
  readonly online: () => void
  /** Empties the home's shared store, so every object is missing again. */
  readonly clear: () => void
}

/** Built once and copied (repo.ts `template`): the build costs about 40 git process starts. */
export function f2(root: string): F2 {
  const origin = path.join(root, "origin.git")
  const home = path.join(root, "home")
  const built = template("f2", root, buildF2)
  const store = path.join(home, ".git", "lfs", "objects")
  const offlinePath = `${origin}.offline`
  return {
    origin,
    url: pathToFileURL(origin).href,
    home,
    head: built,
    objects: () =>
      fs.existsSync(store)
        ? fs.readdirSync(store, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length
        : 0,
    offline: () => fs.renameSync(origin, offlinePath),
    online: () => fs.renameSync(offlinePath, origin),
    clear: () => fs.rmSync(store, { recursive: true, force: true }),
  }
}

function buildF2(root: string) {
  const seed = init(path.join(root, "seed"))
  git(seed, ["lfs", "install", "--local", "--skip-repo"])
  write(seed, {
    ".gitattributes": ["*.png", "*.wav", "*.bin"]
      .map((glob) => `${glob} filter=lfs diff=lfs merge=lfs -text\n`)
      .join(""),
    "README.md": "# F2\n",
    "src/app/main.ts": "export const main = 1\n",
    "docs/guide.md": "guide\n",
    "Assets/Scripts/player.cs": "class Player {}\n",
    "Assets/Textures.meta": "meta\n",
    ...Object.fromEntries(Object.entries(F2_LFS).map(([file, size]) => [file, crypto.randomBytes(size)])),
  })
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-q", "-m", "F2"])
  const origin = init(path.join(root, "origin.git"), { bare: true })
  const url = pathToFileURL(origin).href
  git(seed, ["remote", "add", "origin", url])
  git(seed, ["lfs", "push", "--all", "origin", "main"])
  git(seed, ["push", "-q", "origin", "main"])

  const home = path.join(root, "home")
  git(root, ["clone", "-q", "-c", "core.autocrlf=false", url, home], { env: { GIT_LFS_SKIP_SMUDGE: "1" } })
  configure(home)
  git(home, ["lfs", "install", "--local", "--skip-repo"])
  return head(home)
}
