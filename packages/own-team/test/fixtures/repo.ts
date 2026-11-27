/**
 * Git fixtures in temp folders (06 §11.2). Repositories get local settings only (user, `core.autocrlf=false`,
 * `commit.gpgsign=false`, an empty `core.hooksPath`), so the user's global configuration changes nothing and nothing
 * outside the temp folder is written. Setup runs git synchronously and throws on failure; the code under test runs
 * through `src/git/run.ts`.
 *
 * F1 (this file): a code repository without heavy folders, with three mode-120000 links built through
 * `update-index --cacheinfo 120000,…` under `core.symlinks=false`, so no real symlink (and no Developer Mode) is needed.
 *
 * F1, F2 and F5 are built once and copied ({@link template}).
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { removeTreeSync } from "../support/remove.js"

export interface Temp {
  readonly root: string
  readonly dispose: () => void
}

/** A new folder under the OS temp folder (no `#`); `dispose` removes it and everything in it. */
export function temp(prefix = "own-team-"): Temp {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  return { root, dispose: () => removeTreeSync(root) }
}

/** Runs git for fixture setup; returns stdout, throws with stderr on failure. */
export function git(
  cwd: string,
  args: readonly string[],
  options: { readonly stdin?: string | Uint8Array; readonly env?: Record<string, string> } = {},
) {
  const result = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-C", cwd, ...args], {
    stdin:
      options.stdin === undefined
        ? "ignore"
        : typeof options.stdin === "string"
          ? Buffer.from(options.stdin)
          : options.stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** `git init -b main` with the fixture's local settings. */
export function init(dir: string, options: { readonly bare?: boolean } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ["init", "-q", "-b", "main", ...(options.bare ? ["--bare"] : [])])
  configure(dir)
  return dir
}

/** The local settings every fixture repository gets (also after a clone). */
export function configure(dir: string) {
  const hooks = path.join(path.dirname(dir), ".no-hooks")
  fs.mkdirSync(hooks, { recursive: true })
  const config = fs.existsSync(path.join(dir, ".git")) ? path.join(dir, ".git", "config") : path.join(dir, "config")
  // Appended in one write: a `git config` call per key costs a process start each (slow on Windows).
  fs.appendFileSync(
    config,
    [
      "[user]",
      "\tname = own-team test",
      "\temail = own-team@example.invalid",
      "[core]",
      "\tautocrlf = false",
      "\tsymlinks = false",
      `\thooksPath = ${hooks.replaceAll("\\", "/")}`,
      "[commit]",
      "\tgpgsign = false",
      "[tag]",
      "\tgpgsign = false",
      "[gc]",
      "\tauto = 0",
      "",
    ].join("\n"),
  )
}

/** Writes files (relative paths with `/`), creating folders. */
export function write(dir: string, files: Record<string, string | Uint8Array>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

/** `add -A` and commit; returns the new HEAD. */
export function commit(dir: string, message = "change") {
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", message])
  return head(dir)
}

export function head(dir: string) {
  return git(dir, ["rev-parse", "HEAD"]).trim()
}

/** Files on disk below `dir`, relative with `/`, without `.git`. */
export function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => file !== ".git" && !file.startsWith(".git/"))
    .toSorted()
}

/** `status --porcelain` of a fixture folder (empty = clean). */
export function status(dir: string) {
  return git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
}

export const F1_LINKS = {
  "docs/guide-link.md": "guide.md",
  "src/app/lib": "../lib",
  "README-link.md": "README.md",
} as const

export interface F1 {
  readonly home: string
  readonly head: string
}

/**
 * F1: `src/`, `docs/`, `tools/`, `-dash/` (a folder whose name starts with `-`), root files, and the three
 * {@link F1_LINKS} as mode-120000 entries. Checked out with `core.symlinks=false`, so each link is a small file holding
 * its target, as on this user's Windows checkout.
 */
export function f1(root: string): F1 {
  return { home: path.join(root, "home"), head: template("f1", root, buildF1) }
}

function buildF1(root: string) {
  const home = init(path.join(root, "home"))
  write(home, {
    "README.md": "# F1\n",
    "package.json": '{ "name": "f1" }\n',
    "src/app/main.ts": "export const main = 1\n",
    "src/lib/util.ts": "export const util = 2\n",
    "docs/guide.md": "guide\n",
    "tools/build.ts": "export {}\n",
    "-dash/notes.md": "dash\n",
  })
  git(home, ["add", "-A"])
  for (const [link, target] of Object.entries(F1_LINKS)) {
    const oid = git(home, ["hash-object", "-w", "--stdin"], { stdin: target }).trim()
    git(home, ["update-index", "--add", "--cacheinfo", `120000,${oid},${link}`])
  }
  git(home, ["commit", "-q", "-m", "F1"])
  // Writes the link entries as plain files (core.symlinks=false).
  git(home, ["reset", "-q", "--hard"])
  return head(home)
}

/** git-lfs off for one call: no clean, smudge or process filter, and not required. */
const NO_LFS = ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.lfs.${setting}`])

/** Where built fixtures are kept, by name and a hash of the fixture sources (a changed builder makes a new one). */
const TEMPLATES = path.join(fs.realpathSync.native(os.tmpdir()), "own-team-fixtures")
const SOURCES = ["repo.ts", "lfs-repo.ts", "f5-unity.ts"]
  .reduce((hash, name) => hash.update(fs.readFileSync(path.join(import.meta.dir, name))), crypto.createHash("sha256"))
  .digest("hex")
  .slice(0, 12)

/**
 * The fixture `build` makes under a root, copied into `root`; returns the copy's `home` HEAD. F1 costs 11 git process
 * starts and F2 about 40 (2.3 s and 25 s on this PC, 2026-10-29), so each is built once per source hash into
 * %TEMP%/own-team-fixtures and renamed into place (parallel workers share it; nothing writes to it after) and each test
 * gets a copy. The copy's absolute paths (`core.hooksPath`, the `file://` remote) are moved to its own root, its
 * indexes refreshed, and its HEAD must be the template's. Only fixtures without worktrees: a worktree's `.git` file
 * names its main folder.
 */
export function template(name: string, root: string, build: (root: string) => string) {
  const dir = path.join(TEMPLATES, `${name}-${SOURCES}`)
  const record = path.join(dir, ".template.json")
  if (fs.existsSync(record) && !fs.existsSync(path.join(dir, "home", ".git", "HEAD"))) discard(dir)
  if (!fs.existsSync(record)) make(dir, record, build)
  const built = (JSON.parse(fs.readFileSync(record, "utf8")) as { head: string }).head
  fs.cpSync(dir, root, { recursive: true, filter: (source) => source !== record })
  relocate(root, dir)
  // A copied file has new times, so its index entry no longer matches: `sparse-checkout set` then kept the files
  // outside the cone as if changed (dispatch/hold.test.ts, 2026-10-29). The refresh skips git-lfs (14-17 s a
  // repository on this PC): a home's LFS files are pointers, equal to their blobs as they are; a seed's real LFS files
  // stay stat-dirty and are hashed again on its next `add`.
  for (const entry of fs.readdirSync(dir).filter((item) => fs.existsSync(path.join(dir, item, ".git"))))
    git(path.join(root, entry), [...NO_LFS, "update-index", "-q", "--refresh"])
  const copied = head(path.join(root, "home"))
  if (copied !== built) throw new Error(`fixture ${name}: the copy's HEAD ${copied} is not the template's ${built}`)
  return copied
}

/**
 * A template whose `home` lost its repository while its record stayed is moved aside and built again: F1 of
 * 2026-11-07 kept its folders (`home/.git/objects/..`, `src`, `docs`) and its object files but lost the rest,
 * `.git/HEAD` included, and every copy then failed with "not a git repository". Moved, not removed in place: another
 * worker may have renamed a fresh build into place meanwhile, and only one worker moves the broken one.
 */
function discard(dir: string) {
  const broken = `${dir}.broken-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  const moved = (() => {
    try {
      fs.renameSync(dir, broken)
      return true
    } catch {
      return false
    }
  })()
  if (moved) removeTreeSync(broken)
}

function make(dir: string, record: string, build: (root: string) => string) {
  const staging = `${dir}.${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  fs.mkdirSync(staging, { recursive: true })
  const built = build(staging)
  relocate(staging, staging, dir)
  fs.writeFileSync(path.join(staging, ".template.json"), JSON.stringify({ head: built }))
  // Another worker may have renamed its own build into place first: then that one is used and this one goes.
  const moved = (() => {
    try {
      fs.renameSync(staging, dir)
      return true
    } catch (error) {
      if (!fs.existsSync(record)) throw error
      return false
    }
  })()
  if (!moved) removeTreeSync(staging)
}

/** Rewrites `from` to `to` (default `root`) in the git configs of the repositories directly below `root`. */
function relocate(root: string, from: string, to = root) {
  const pairs = [
    [pathToFileURL(from).href, pathToFileURL(to).href],
    [from.replaceAll("\\", "/"), to.replaceAll("\\", "/")],
    [from, to],
  ] as const
  for (const entry of fs.readdirSync(root))
    for (const config of [path.join(root, entry, ".git", "config"), path.join(root, entry, "config")]) {
      if (!fs.existsSync(config) || !fs.statSync(config).isFile()) continue
      const text = fs.readFileSync(config, "utf8")
      const moved = pairs.reduce((value, [a, b]) => value.replaceAll(a, b), text)
      if (moved !== text) fs.writeFileSync(config, moved)
    }
}
