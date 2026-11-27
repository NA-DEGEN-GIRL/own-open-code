export * as ShellReference from "./shell.js"

import path from "node:path"

/**
 * Best effort (01 §13 "에이전트 접근", PP-3): whether a shell command names a protected path in its text. Core's shell
 * tool and every harness's shell (Codex exec_command, Pi bash, dsh bash and pwsh, Claude Agent's through core) ask
 * `shell` with each parsed command's text as a resource; own-accounts' `evaluate` hook turns the answer into `ask`
 * when one of them names a protected path, in every approval mode.
 *
 * Read in the text: `~`, `$HOME`, `${HOME}`, `$env:HOME`, `$env:USERPROFILE`, `%USERPROFILE%`, `$USERPROFILE`, the
 * same forms of `APPDATA` and `LOCALAPPDATA`, either slash, quoted or not, quoted parts joined as the shell joins them
 * (`"$HOME"/.ssh`, `~/".ssh"`), case-insensitive on Windows; Git Bash's `/c/...` and WSL's `/mnt/c/...` drive forms;
 * `--flag=path` and `-Path:path`; relative paths that start with `.` or hold a slash, from each folder in
 * {@link Places.directories}. Core moves a `cd`/`Set-Location` with a target and the working folder (`workdir`) out
 * of the command text into `external_directory` asks; the hook passes those folders here.
 *
 * Not read as a reference: the text a command only prints (`echo`, `printf`, `Write-Output`, `Write-Host` with no
 * redirection, pipe or substitution) and a commit or pull request message (`git … -m`, `gh … --title/--body`).
 *
 * Not seen (documented as such): a path built at run time (variables, string joins, `$(…)` output), a wildcard that
 * only expands to it (`~/.ss*`), a script or file that holds it, a search of a folder that only contains it
 * (`rg secret ~`).
 */

export interface Places {
  readonly platform: NodeJS.Platform
  readonly home: string
  /** Windows `%APPDATA%`. */
  readonly roaming?: string
  /** Windows `%LOCALAPPDATA%`. */
  readonly local?: string
  /** Folders relative paths are read from: the Location's first, then the command's working folder and `cd` targets. */
  readonly directories: ReadonlyArray<string>
}

/** The first absolute path the command names that `protects` holds, or undefined. */
export function find(
  command: string,
  places: Places,
  protects: (absolute: string) => string | undefined,
): { readonly path: string; readonly label: string } | undefined {
  if (printsOnly(command)) return undefined
  const windows = places.platform === "win32"
  const join = windows ? path.win32 : path.posix
  const words = candidates(expand(withoutMessages(command), places))
  return [...new Set(words)]
    .flatMap((word) => places.directories.flatMap((base) => locate(word, base, places, join) ?? []))
    .reduce<{ readonly path: string; readonly label: string } | undefined>((found, absolute) => {
      if (found) return found
      const label = protects(absolute)
      return label === undefined ? undefined : { path: windows ? absolute.replaceAll("/", "\\") : absolute, label }
    }, undefined)
}

/** A command that changes to the home folder: `cd`, `chdir`, `Set-Location`, `sl` with no target. */
export function homeChange(command: string) {
  return /^(?:cd|chdir|set-location|sl)$/i.test(command.trim())
}

const SINKS = new Set(["echo", "printf", "write-output", "write-host"])

/** A command that only prints its words: nothing it names is opened. */
function printsOnly(command: string) {
  const program = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  return SINKS.has(program) && !/[<>|`(;&\r\n]/.test(command)
}

/** The values of message options (`git commit -m "…"`, `gh pr create --title "…" --body "…"`) left out. */
function withoutMessages(command: string) {
  const flags = /^\s*git\s(?:.*\s)?(?:commit|tag|merge|notes|stash)(?:\s|$)/i.test(command)
    ? "-[a-zA-Z]*m|--message"
    : /^\s*gh\s/i.test(command)
      ? "-t|-b|--title|--body"
      : undefined
  if (flags === undefined) return command
  return command.replace(
    new RegExp(`(\\s)(?:${flags})(?:=|\\s+)(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s"']+)`, "g"),
    "$1",
  )
}

/** Variable forms that name the home and app data folders, replaced by their values. */
export function expand(command: string, places: Pick<Places, "platform" | "home" | "roaming" | "local">) {
  const windows = places.platform === "win32"
  const values: ReadonlyArray<readonly [ReadonlyArray<string>, string | undefined]> = [
    [["USERPROFILE", "HOME"], places.home],
    [["APPDATA"], places.roaming],
    [["LOCALAPPDATA"], places.local],
  ]
  const named = values.reduce((text, [names, value]) => {
    if (value === undefined) return text
    const alternatives = names.join("|")
    // `${env:NAME}`, `$env:NAME`, `%NAME%`, `${NAME}`, `$NAME`; Windows names are case-insensitive.
    const pattern = new RegExp(
      `\\$\\{env:(?:${alternatives})\\}|\\$env:(?:${alternatives})(?![\\w])|%(?:${alternatives})%|\\$\\{(?:${alternatives})\\}|\\$(?:${alternatives})(?![\\w])`,
      windows ? "gi" : "g",
    )
    return text.replace(pattern, () => value)
  }, command)
  const drive = windows ? named.replace(/%HOMEDRIVE%%HOMEPATH%/gi, () => places.home) : named
  // `~` where a word starts, alone or before a separator.
  return drive.replace(/(^|[\s"'=(,;|&<>:])~(?=$|[\\/\s"');|&,])/g, (_, lead: string) => `${lead}${places.home}`)
}

/**
 * The words of the command that may be paths: quoted strings whole and split, the text split at shell punctuation
 * with quotes read as breaks, and again with quotes dropped so quoted parts join their neighbours as in the shell.
 */
export function candidates(text: string): ReadonlyArray<string> {
  const quoted = [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? "")
  const words = (value: string) => value.split(/[\s|;&<>(){}[\],=]+/).map((word) => word.replace(/^-[\w-]+:(?=.)/, ""))
  return [
    ...quoted,
    ...quoted.flatMap(words),
    ...words(text.replace(/["'`]/g, " ")),
    ...words(text.replace(/["'`]/g, "")),
  ].filter((word) => word.trim() !== "")
}

/** A word as an absolute path read from `base` (with `/`), or undefined when it does not look like a path. */
function locate(word: string, base: string, places: Places, join: typeof path.posix) {
  const windows = places.platform === "win32"
  const slashed = word
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
  const drive = windows
    ? slashed.replace(/^\/mnt\/([a-z])(?=\/|$)/i, "$1:").replace(/^\/([a-z])(?=\/|$)/i, "$1:")
    : slashed
  if (windows ? /^[a-z]:(\/|$)/i.test(drive) || drive.startsWith("//") : drive.startsWith("/"))
    return join.resolve(drive).replaceAll("\\", "/")
  // A relative word is a path only when it starts with `.` or holds a slash (`.ssh`, `keys/id`), not `git` or `-la`.
  if (windows && /^[a-z]:/i.test(drive)) return undefined
  if (!drive.startsWith(".") && !drive.includes("/")) return undefined
  if (drive.startsWith("/")) return undefined
  return join.resolve(base, drive).replaceAll("\\", "/")
}
