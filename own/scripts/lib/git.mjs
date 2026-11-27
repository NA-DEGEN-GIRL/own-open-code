// Thin synchronous git helpers for the own/scripts checks (Node 22, no dependencies).
import { execFileSync, spawnSync } from "node:child_process"

export class GitError extends Error {
  constructor(args, stderr) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`)
    this.name = "GitError"
  }
}

export function git(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) throw new GitError(args, result.stderr ?? "")
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

export function gitText(repo, args) {
  return git(repo, args).stdout.trim()
}

// NUL-separated path lists (`-z`) avoid quoting of non-ASCII and special characters.
export function gitPaths(repo, args) {
  return git(repo, [...args, "-z"])
    .stdout.split("\0")
    .filter((item) => item !== "")
}

export function repoRoot(start) {
  return execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).trim()
}

// 0 = ancestor, 1 = not an ancestor, anything else = unknown commit (e.g. upstream not fetched).
export function isAncestor(repo, commit, of) {
  const status = git(repo, ["merge-base", "--is-ancestor", commit, of], { allowFailure: true }).status
  if (status === 0) return true
  if (status === 1) return false
  return undefined
}

// File contents at a revision, or undefined when the path does not exist there.
export function showFile(repo, rev, file) {
  const result = git(repo, ["show", `${rev}:${file}`], { allowFailure: true })
  return result.status === 0 ? result.stdout : undefined
}
