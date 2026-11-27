// The fixed git commands of the review tab's Git actions (03 §19.2, 01 §17.1 #18) as plain functions: quoting per
// shell, the command lines, `git status --porcelain=v2` parsing and hunk patches. Nothing here runs anything.
//
// The v2 VCS API is read-only, so writes run as one-line commands through `POST /api/shell` (`shell.create`) in the
// session's folder. That route runs the line with the server's configured shell (packages/core/src/shell/select.ts:
// pwsh / Windows PowerShell / Git Bash / cmd on Windows, the login shell elsewhere), so an argument is quoted for the
// shell that `shell.create` reported for the status read (`Shell.Info.shell`) and refused where that shell cannot
// carry it. Paths then go through a NUL-separated pathspec file instead (`--pathspec-from-file`), and text that
// never fits on a command line (a commit message, a patch) always goes through a file the server writes first.
//
// Paths are repository-root relative (core's vcs lists them that way, and so does porcelain), and every pathspec is
// `:(top,literal)<path>`: root-relative from any folder of the repository, no glob or magic in file names.

export type ShellKind = "posix" | "powershell" | "cmd" | "fish" | "other"

const POSIX = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash"])

/** The quoting family of a shell path (`Shell.Info.shell`). */
export function shellKind(shell: string): ShellKind {
  const name = (shell.replaceAll("\\", "/").split("/").at(-1) ?? "").toLowerCase().replace(/\.exe$/, "")
  if (name === "cmd") return "cmd"
  if (name === "pwsh" || name === "powershell") return "powershell"
  if (name === "fish") return "fish"
  if (POSIX.has(name)) return "posix"
  return "other"
}

/** Safe without quotes in every shell (no spaces, globs, variables, separators, `@`, `%`, `,`, parentheses). */
const BARE = /^[A-Za-z0-9_./=:+-]+$/
// Control characters never go on a command line (a newline would end it in cmd and read oddly everywhere).
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * One argument for the shell, or `undefined` when that shell cannot carry it on one line:
 * - POSIX shells: single quotes (`'` as `'\''`); fish: single quotes with `\\` and `\'`;
 * - PowerShell: single quotes (`'` and its typographic forms doubled). Values with a double quote are refused:
 *   Windows PowerShell passes them to native programs without escaping;
 * - cmd and unknown shells: bare values only (Node quotes a whole `/c` line and escapes `"` as `\"`, which cmd
 *   does not understand).
 */
export function quoteArg(kind: ShellKind, value: string): string | undefined {
  if (value === "" || CONTROL.test(value)) return undefined
  if (BARE.test(value)) return value
  if (kind === "posix") return `'${value.replaceAll("'", `'\\''`)}'`
  if (kind === "fish") return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
  if (kind === "powershell") {
    if (/["“”„]/.test(value) || value.endsWith("\\")) return undefined
    return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`
  }
  return undefined
}

/** `:(top,literal)<path>`: a root-relative literal pathspec. */
export function pathspec(path: string) {
  return `:(top,literal)${path}`
}

/** A file the server writes before the command runs (temp folder of the server). */
export interface TempWrite {
  readonly path: string
  readonly content: string
}

/** What one Git action runs: its commands in order (stop at the first failure) and the files they read. */
export interface CommandPlan {
  readonly commands: readonly string[]
  readonly writes: readonly TempWrite[]
}

export class UnsupportedPathError extends Error {
  override readonly name = "UnsupportedPathError"
}

/**
 * `git <verb…> -- <pathspecs>` with the paths inline when the shell can carry them, else through a NUL-separated
 * pathspec file (`--pathspec-from-file`, git ≥ 2.26) at `file`.
 */
export function withPaths(
  kind: ShellKind,
  verb: readonly string[],
  paths: readonly string[],
  file: () => string,
): CommandPlan {
  const inline = paths.map((path) => quoteArg(kind, pathspec(path)))
  if (inline.every((item): item is string => item !== undefined))
    return { commands: [["git", ...verb, "--", ...inline].join(" ")], writes: [] }
  const target = file()
  const quoted = quoteArg(kind, `--pathspec-from-file=${target}`)
  if (!quoted) throw new UnsupportedPathError(target)
  return {
    commands: [["git", ...verb, quoted, "--pathspec-file-nul"].join(" ")],
    writes: [{ path: target, content: paths.map(pathspec).join("\0") }],
  }
}

/** A path argument (a temp file) or the refusal the UI explains. */
export function pathArg(kind: ShellKind, path: string) {
  const quoted = quoteArg(kind, path)
  if (!quoted) throw new UnsupportedPathError(path)
  return quoted
}

/**
 * The status read: branch, upstream, ahead/behind and per-file index/worktree state. Paths repository-root relative
 * (porcelain v2 follows `status.relativePaths`, which is on by default) and ASCII only (quoted), so no shell's output
 * encoding can change them.
 */
export const STATUS_COMMAND =
  "git -c core.quotepath=true -c status.relativePaths=false status --porcelain=v2 --branch --untracked-files=all"
/** Whether `gh` is installed (03 §19.2 "PR 만들기(gh 있을 때)"). */
export const GH_COMMAND = "gh --version"

export const stage = (kind: ShellKind, paths: readonly string[], file: () => string) =>
  withPaths(kind, ["add", "-A"], paths, file)

/** Before the first commit there is no HEAD to restore from: the index entry is dropped instead. */
export const unstage = (kind: ShellKind, paths: readonly string[], initial: boolean, file: () => string) =>
  withPaths(kind, initial ? ["rm", "--cached", "-q"] : ["restore", "--staged"], paths, file)

/**
 * `파일 되돌리기`: tracked files (in HEAD or the index) go back to HEAD in the index and the working copy, which also
 * removes a staged new file; untracked files are deleted (`git clean`). Before the first commit tracked files are
 * removed (`git rm -f`).
 */
export function revert(
  kind: ShellKind,
  files: { readonly tracked: readonly string[]; readonly untracked: readonly string[]; readonly initial: boolean },
  file: (name: string) => string,
): CommandPlan {
  const parts = [
    ...(files.tracked.length
      ? [
          withPaths(
            kind,
            files.initial ? ["rm", "-f", "-q"] : ["restore", "--source=HEAD", "--staged", "--worktree"],
            files.tracked,
            () => file("tracked"),
          ),
        ]
      : []),
    ...(files.untracked.length
      ? [withPaths(kind, ["clean", "-f", "-q"], files.untracked, () => file("untracked"))]
      : []),
  ]
  return { commands: parts.flatMap((part) => part.commands), writes: parts.flatMap((part) => part.writes) }
}

export const STAGE_ALL = "git add -A"

export function commit(kind: ShellKind, messageFile: string): CommandPlan {
  return { commands: [`git commit -F ${pathArg(kind, messageFile)}`], writes: [] }
}

/** Without an upstream the branch goes to `origin` under its own name and becomes tracked (`-u origin HEAD`). */
export const push = (upstream: boolean) => (upstream ? "git push" : "git push -u origin HEAD")

/** `gh pr create --fill`: title and body from the commits, no prompts. */
export const PR_COMMAND = "gh pr create --fill"

/** Reverse-applies one hunk to the working copy (`git apply -R`, atomic: nothing changes when it does not apply). */
export function applyReverse(kind: ShellKind, patchFile: string) {
  return `git apply -R --whitespace=nowarn ${pathArg(kind, patchFile)}`
}

// ---------------------------------------------------------------------------------------------------------------
// git status --porcelain=v2 --branch

export interface FileState {
  /** Index (staged) state, `.` = unchanged. */
  readonly index: string
  /** Working-copy state, `.` = unchanged. */
  readonly worktree: string
  readonly untracked: boolean
  readonly conflicted: boolean
}

export interface GitStatus {
  /** Branch name; undefined when detached. */
  readonly head?: string
  /** No commit yet (`# branch.oid (initial)`). */
  readonly initial: boolean
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  /** By repository-root relative path. */
  readonly files: ReadonlyMap<string, FileState>
}

export function parseStatus(output: string): GitStatus {
  const files = new Map<string, FileState>()
  const branch = { initial: false, ahead: 0, behind: 0 } as {
    head?: string
    initial: boolean
    upstream?: string
    ahead: number
    behind: number
  }
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (line.startsWith("# branch.oid ")) branch.initial = line.slice(13) === "(initial)"
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14)
      branch.head = head === "(detached)" ? undefined : head
    }
    if (line.startsWith("# branch.upstream ")) branch.upstream = line.slice(18)
    if (line.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(line.slice(12))
      if (match) Object.assign(branch, { ahead: Number(match[1]), behind: Number(match[2]) })
    }
    if (line.startsWith("1 ")) addEntry(files, line, 8, false)
    if (line.startsWith("2 ")) addEntry(files, line, 9, false)
    if (line.startsWith("u ")) addEntry(files, line, 10, true)
    if (line.startsWith("? "))
      files.set(unquotePath(line.slice(2)), { index: ".", worktree: "?", untracked: true, conflicted: false })
  }
  return { ...branch, files }
}

function addEntry(files: Map<string, FileState>, line: string, fields: number, conflicted: boolean) {
  const parts = line.split(" ")
  const xy = parts[1] ?? ".."
  // A rename's path is followed by a tab and the original path.
  const rest = parts.slice(fields).join(" ").split("\t")[0] ?? ""
  if (!rest) return
  files.set(unquotePath(rest), { index: xy[0] ?? ".", worktree: xy[1] ?? ".", untracked: false, conflicted })
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }

/** git's C-style quoted path (`"src/\355\225\234.ts"`, core.quotepath) as text; unquoted paths pass through. */
export function unquotePath(value: string) {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value
  const body = value.slice(1, -1)
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!
    if (char !== "\\") {
      bytes.push(...encoder.encode(char))
      continue
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      index += 3
      continue
    }
    const next = body[index + 1] ?? ""
    bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
    index += 1
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Staged changes in the index (`X` ≠ `.`), untracked files excluded. */
export function isStaged(state: FileState | undefined) {
  return !!state && !state.untracked && state.index !== "."
}

/** Changes not staged yet: working-copy edits or an untracked file. */
export function hasUnstaged(state: FileState | undefined) {
  return !!state && (state.untracked || state.worktree !== ".")
}

// ---------------------------------------------------------------------------------------------------------------
// Hunks of a git patch (`diff --git …`, the vcs.diff patch of one file)

export interface Hunk {
  /** `@@ -10,6 +10,9 @@ …` */
  readonly header: string
  readonly lines: readonly string[]
  readonly additions: number
  readonly deletions: number
}

export function splitHunks(patch: string): { readonly head: readonly string[]; readonly hunks: readonly Hunk[] } {
  const lines = patch.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const first = lines.findIndex((line) => line.startsWith("@@"))
  if (first < 0) return { head: lines, hunks: [] }
  const hunks: Hunk[] = []
  const current = { header: "", lines: [] as string[] }
  const flush = () => {
    if (!current.header) return
    hunks.push({
      header: current.header,
      lines: current.lines,
      additions: current.lines.filter((line) => line.startsWith("+")).length,
      deletions: current.lines.filter((line) => line.startsWith("-")).length,
    })
  }
  for (const line of lines.slice(first)) {
    if (line.startsWith("@@")) {
      flush()
      Object.assign(current, { header: line, lines: [] })
      continue
    }
    current.lines.push(line)
  }
  flush()
  return { head: lines.slice(0, first), hunks }
}

/** A patch of one hunk: the file's header lines (`diff --git`, `index`, `---`, `+++`) and that hunk. */
export function hunkPatch(head: readonly string[], hunk: Hunk) {
  return `${[...head, hunk.header, ...hunk.lines].join("\n")}\n`
}

/** Hunk reverts need an ordinary modification: both sides exist and the header names the file. */
export function canRevertHunks(head: readonly string[]) {
  return (
    head.some((line) => line.startsWith("--- a/") || line.startsWith('--- "a/')) &&
    head.some((line) => line.startsWith("+++ b/") || line.startsWith('+++ "b/'))
  )
}

/** The pull request URL `gh pr create` prints on success. */
export function pullRequestUrl(output: string) {
  return /https?:\/\/\S+\/pull\/\d+/.exec(output)?.[0]
}

/** The last lines of a command's output for an error message (03 §8 "원인을 적는다"). */
export function tail(output: string, lines = 30) {
  return output.replace(/\s+$/, "").split(/\r?\n/).slice(-lines).join("\n")
}
