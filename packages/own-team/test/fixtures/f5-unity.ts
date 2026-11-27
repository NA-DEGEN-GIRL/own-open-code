/**
 * F5 (06 §11.2): a Unity-shaped LFS repository with a bare `file://` remote, built like F2 (`lfs-repo.ts`): textures,
 * models and audio as LFS files in heavy folders, each asset and folder with its `.meta`, `ProjectSettings/` and
 * `Packages/`, and the editor's caches ignored (`Library/`, `Temp/`, `Logs/`, `UserSettings/`). The home is cloned with
 * `GIT_LFS_SKIP_SMUDGE=1`, so its working files are pointers and the shared store starts empty. "Offline" renames the
 * remote folder. Local settings only, fake content only.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { configure, git, head, init, template, write } from "./repo.js"

export const F5_HEAVY = ["Assets/Textures", "Assets/Models", "Assets/Audio"] as const

/** LFS files and their sizes, all in heavy folders. */
export const F5_LFS = {
  "Assets/Textures/rock.png": 40_000,
  "Assets/Textures/tree.png": 30_000,
  "Assets/Models/tree.fbx": 20_000,
  "Assets/Audio/music.wav": 10_000,
} as const

/** The `.meta` of an asset or folder, as Unity writes it. */
export function meta(guid: string) {
  return `fileFormatVersion: 2\nguid: ${guid.padEnd(32, "0")}\n`
}

/** The editor's ignore rules (Unity's template, shortened). */
export const F5_IGNORE = ["/[Ll]ibrary/", "/[Tt]emp/", "/[Ll]ogs/", "/[Uu]ser[Ss]ettings/", "/[Bb]uild/", ""].join("\n")

export interface F5 {
  /** The repository the remote was pushed from: commits made here and pushed bring objects the home lacks. */
  readonly seed: string
  readonly origin: string
  readonly url: string
  readonly home: string
  readonly head: string
  /** Files in the home's shared LFS store. */
  readonly objects: () => number
  readonly offline: () => void
  readonly online: () => void
}

/** Built once and copied (repo.ts `template`): the build costs about 40 git process starts. */
export function f5(root: string): F5 {
  const origin = path.join(root, "origin.git")
  const home = path.join(root, "home")
  const built = template("f5", root, buildF5)
  const store = path.join(home, ".git", "lfs", "objects")
  const offlinePath = `${origin}.offline`
  return {
    seed: path.join(root, "seed"),
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
  }
}

function buildF5(root: string) {
  const seed = init(path.join(root, "seed"))
  git(seed, ["lfs", "install", "--local", "--skip-repo"])
  write(seed, {
    ".gitattributes": ["*.png", "*.fbx", "*.wav"]
      .map((glob) => `${glob} filter=lfs diff=lfs merge=lfs -text\n`)
      .join(""),
    ".gitignore": F5_IGNORE,
    "Assets/Scripts.meta": meta("a1"),
    "Assets/Scripts/Player.cs": "public class Player {}\n",
    "Assets/Scripts/Player.cs.meta": meta("a2"),
    "Assets/Textures.meta": meta("b1"),
    "Assets/Textures/rock.png.meta": meta("b2"),
    "Assets/Textures/tree.png.meta": meta("b3"),
    "Assets/Models.meta": meta("c1"),
    "Assets/Models/tree.fbx.meta": meta("c2"),
    "Assets/Audio.meta": meta("d1"),
    "Assets/Audio/music.wav.meta": meta("d2"),
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
    "ProjectSettings/ProjectSettings.asset": "PlayerSettings:\n  productName: f5\n",
    "Packages/manifest.json": '{ "dependencies": {} }\n',
    ...Object.fromEntries(Object.entries(F5_LFS).map(([file, size]) => [file, crypto.randomBytes(size)])),
  })
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-q", "-m", "F5"])
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
