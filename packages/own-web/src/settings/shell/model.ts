// 설정 > 셸·터미널 (03 §19.8, [gap] 24, 01 §17.1 #24): pure helpers for the default shell setting.
// Backend facts (read from source, 2026-09):
//   - one `shell` field in the global config serves both the agent's shell tool and new terminals
//     (`packages/schema/src/config.ts` Info.shell "Default shell to use for terminal and shell tool execution");
//     `PATCH /api/experimental/config {shell}` writes it into the highest-precedence global config document and
//     `null` removes it (`packages/core/src/config.ts` Config.update);
//   - `GET /api/config/shell` lists the shells found: on Windows pwsh, Windows PowerShell, Git Bash, cmd
//     (`packages/core/src/shell/select.ts` win()), elsewhere /etc/shells; `acceptable: false` marks shells the agent
//     tool refuses (fish, nu) and replaces with the default;
//   - the shell tool's description names the shell: "Commands run on <OS> using <name>." where name is the file name
//     without extension, lower case (`packages/core/src/tool/plugin/shell.ts:35-38,280`, `ShellSelect.name`). So a
//     change of that name changes the tool definition, which is part of every request's cached prefix: the next
//     request of each session writes its cache again (03 open question 39, now confirmed from source).
import type { ConfigEntry, ConfigShellOption } from "@opencode/client"

export type ShellOption = ConfigShellOption

export type ShellKind = "pwsh" | "powershell" | "gitbash" | "bash" | "cmd" | "other"

/** Like core `ShellSelect.name`: Windows paths lose their extension, the rest keep the base name; lower case. */
export function shellName(file: string) {
  const base = file.split(/[\\/]/).filter(Boolean).at(-1) ?? file
  return (windowsPath(file) ? base.replace(/\.[^.]*$/, "") : base).toLowerCase()
}

export function shellKind(option: Pick<ShellOption, "path">): ShellKind {
  const name = shellName(option.path)
  if (name === "pwsh") return "pwsh"
  if (name === "powershell") return "powershell"
  if (name === "cmd") return "cmd"
  // Git for Windows ships bash under <git>\bin (select.ts gitbash()); other bash builds are plain "bash".
  if (name === "bash") return windowsPath(option.path) && /[\\/]git[\\/]/i.test(option.path) ? "gitbash" : "bash"
  return "other"
}

/** The server runs on Windows when its shells have Windows paths (the page never asks the host for the OS). */
export function windowsServer(options: readonly Pick<ShellOption, "path">[]) {
  return options.some((option) => windowsPath(option.path))
}

export interface ConfiguredShell {
  /** The `shell` value as written (a path or a bare name). */
  readonly value: string
  /** The config document that sets it (highest priority wins). */
  readonly source?: string
}

/** The effective `shell` of a location: the last document (highest priority) that sets it. */
export function configuredShell(entries: readonly ConfigEntry[]): ConfiguredShell | undefined {
  const document = entries.findLast(
    (entry): entry is Extract<ConfigEntry, { type: "document" }> => entry.type === "document" && !!entry.info.shell,
  )
  return document?.info.shell ? { value: document.info.shell, source: document.path } : undefined
}

/**
 * The listed shell a configured value means: the same path, or a bare name (`pwsh`) that core resolves on PATH to
 * the listed shell of that name. `undefined` when it names a shell the server did not find.
 */
export function selectedOption(options: readonly ShellOption[], configured: ConfiguredShell | undefined) {
  if (!configured) return undefined
  const value = configured.value
  const exact = options.find((option) => samePath(option.path, value))
  if (exact) return exact
  if (/[\\/]/.test(value)) return undefined
  return options.find((option) => shellName(option.path) === shellName(value))
}

/** A project's own config (`<project>/.opencode/…`) outranks the global document the setting writes. */
export function projectOverride(configured: ConfiguredShell | undefined, directory: string | undefined) {
  if (!configured?.source || !directory) return false
  return inside(configured.source, directory)
}

/**
 * Whether the shell tool's description changes (so the next request of each session rewrites its cache):
 * `same` when the name in "using <name>" stays, `changes` when it differs, `unknown` when the server picks (automatic,
 * or a shell the agent tool refuses and replaces).
 */
export function cacheEffect(
  from: { readonly path?: string; readonly acceptable?: boolean } | undefined,
  to: { readonly path?: string; readonly acceptable?: boolean } | undefined,
): "same" | "changes" | "unknown" {
  if (!from?.path || !to?.path || from.acceptable === false || to.acceptable === false) return "unknown"
  return shellName(from.path) === shellName(to.path) ? "same" : "changes"
}

export function samePath(a: string, b: string) {
  if (!windowsPath(a) && !windowsPath(b)) return trimEnd(a) === trimEnd(b)
  return normalizeWindows(a) === normalizeWindows(b)
}

function inside(file: string, directory: string) {
  const windows = windowsPath(file) || windowsPath(directory)
  const child = windows ? normalizeWindows(file) : trimEnd(file)
  const parent = windows ? normalizeWindows(directory) : trimEnd(directory)
  const separator = windows ? "\\" : "/"
  return child.startsWith(parent + separator)
}

function windowsPath(file: string) {
  return /^[a-zA-Z]:[\\/]/.test(file) || file.includes("\\")
}

function normalizeWindows(file: string) {
  return trimEnd(file.replaceAll("/", "\\")).toLowerCase()
}

function trimEnd(file: string) {
  return file.length > 1 ? file.replace(/[\\/]+$/, "") : file
}
