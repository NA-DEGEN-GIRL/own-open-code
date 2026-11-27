export * as GitVersion from "./version.js"

import { Git } from "./run.js"

/**
 * Version and tool gates (06 §4.2). Code-only worktrees need Git 2.42 (`sparse-checkout check-rules`); 2.40-2.41 turn
 * team mode on with full worktrees (`plain`) and say why; below 2.40 there is no `merge-tree --write-tree` /
 * `check-attr --source`, so it is refused (`git_too_old`). Installing Git is a system change and own never does it.
 * git-lfs is needed only when the repository uses LFS.
 */

export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** As printed, e.g. `2.55.0.windows.3`. */
  readonly text: string
}

export const CODE_ONLY = { major: 2, minor: 42 } as const
export const MINIMUM = { major: 2, minor: 40 } as const

/** 06 §4.2: the card line for 2.40-2.41. */
export const OLD_GIT_TEXT = "오래된 Git이라 큰 파일까지 모두 받는 방식으로 켜요(Git 2.42 이상이면 가벼운 폴더를 써요)"

export type Shape =
  | { readonly ok: true; readonly shape: "code" }
  /** Full worktrees only; `text` is the summary-card line. */
  | { readonly ok: true; readonly shape: "plain"; readonly reason: "old_git"; readonly text: string }
  | { readonly ok: false; readonly error: "git_too_old"; readonly message: string }

/** `git version 2.55.0.windows.3` → 2.55.0. */
export function parse(output: string): Version | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?(\S*)/.exec(output)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    text: `${match[1]}.${match[2]}${match[3] === undefined ? "" : `.${match[3]}`}${match[4]}`,
  }
}

/** `git-lfs/3.7.1 (GitHub; windows amd64; go 1.25.1; git b84b3384)` → `3.7.1`. */
export function parseLfs(output: string) {
  return /git-lfs\/(\d+\.\d+\.\d+\S*)/.exec(output)?.[1]
}

export function atLeast(version: Pick<Version, "major" | "minor">, minimum: Pick<Version, "major" | "minor">) {
  return version.major > minimum.major || (version.major === minimum.major && version.minor >= minimum.minor)
}

/** Which worktrees this Git can make. */
export function shape(version: Version): Shape {
  if (atLeast(version, CODE_ONLY)) return { ok: true, shape: "code" }
  if (atLeast(version, MINIMUM)) return { ok: true, shape: "plain", reason: "old_git", text: OLD_GIT_TEXT }
  return { ok: false, error: "git_too_old", message: `Git ${version.text} is older than 2.40` }
}

export interface Probe {
  readonly git: { readonly path: string | null; readonly version: string | null; readonly ok: boolean }
  readonly lfs: { readonly version: string } | null
}

/** Installed tools, for `health` (06 §2.7). `git.ok` = at least 2.40. */
export async function probe(): Promise<Probe> {
  const found = await installed()
  return {
    git: {
      path: Bun.which("git"),
      version: found.version?.text ?? null,
      ok: found.version !== undefined && atLeast(found.version, MINIMUM),
    },
    lfs: found.lfs === undefined ? null : { version: found.lfs },
  }
}

/** The repository uses LFS: `git ls-files ':(attr:filter=lfs)'` prints at least one path (06 §4.2). */
export async function usesLfs(
  directory: string,
): Promise<{ readonly ok: true; readonly used: boolean } | { readonly ok: false; readonly message: string }> {
  const result = await Git.run(["ls-files", "-z", "--", ":(attr:filter=lfs)"], { cwd: directory, worktree: true })
  if (!result.ok) return { ok: false, message: `저장소의 큰 파일을 확인하지 못했어요: ${result.message}` }
  return { ok: true, used: result.stdout.length > 0 }
}

export type Check =
  | {
      readonly ok: true
      readonly version: Version
      readonly shape: "code" | "plain"
      /** Set when `plain` only because Git is older than 2.42. */
      readonly reason?: { readonly code: "old_git"; readonly text: string }
      readonly lfs: { readonly used: boolean; readonly version: string | null }
    }
  | { readonly ok: false; readonly error: "not_git" | "git_too_old" | "lfs_missing"; readonly message: string }

/** Everything enable needs before it plans worktrees for the repository at `directory`. */
export async function check(directory: string): Promise<Check> {
  const [found, used] = await Promise.all([installed(), usesLfs(directory)])
  if (!found.version) return { ok: false, error: "not_git", message: "Git이 설치되어 있지 않아요" }
  const allowed = shape(found.version)
  if (!allowed.ok) return allowed
  if (!used.ok) return { ok: false, error: "not_git", message: used.message }
  if (used.used && found.lfs === undefined)
    return {
      ok: false,
      error: "lfs_missing",
      message: "저장소가 큰 파일 도구(git-lfs)를 쓰는데 이 PC에 설치되어 있지 않아요",
    }
  return {
    ok: true,
    version: found.version,
    shape: allowed.shape,
    ...(allowed.shape === "plain" ? { reason: { code: allowed.reason, text: allowed.text } } : {}),
    lfs: { used: used.used, version: found.lfs ?? null },
  }
}

async function installed() {
  const [git, lfs] = await Promise.all([Git.run(["version"]), Git.run(["lfs", "version"])])
  return { version: git.ok ? parse(git.stdout) : undefined, lfs: lfs.ok ? parseLfs(lfs.stdout) : undefined }
}
