// `탐색기에서 열기` / `탐색기에서 보기` (05 §7.10): the rules main applies before it opens Explorer or starts the
// user's SSH file explorer program. Pure, so the tests cover them without Electron:
//  - a local path must be inside a folder the service has open (`insideRoots`);
//  - the program's arguments come from a template whose tokens each become exactly one argument, whatever the
//    remote name holds (`expandTemplate`): nothing here ever builds a command line or reaches a shell;
//  - the SSH target and the remote path are checked before they are put in (`sshHost`, `remotePath`).
import path from "node:path"

/** The contract of the user's own `ssh-explorer.exe`: a folder opens in its server pane, a file selected in its folder. */
export const DEFAULT_TEMPLATE = "--open {host} {path}"

export const TEMPLATE_MAX = 1024

/**
 * Why nothing was opened. `outside`: not inside an open folder. `missing`: the folder or file is gone.
 * `service`: this PC's service did not say which folders are open. `unconfigured`: no program chosen yet.
 * `program`: the chosen program is gone or is not an `.exe`. `blocked`: Windows refused to start it (Smart App
 * Control, permissions). `failed`: it did not start for another reason. `host`, `path`, `template`: a value the rules
 * here refuse. `unavailable` is the renderer's own: a shell without this Ipc.
 */
export type ExplorerFailure =
  | "outside"
  | "missing"
  | "service"
  | "unconfigured"
  | "program"
  | "blocked"
  | "failed"
  | "host"
  | "path"
  | "template"

export type ExplorerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExplorerFailure; readonly detail?: string }

/** What 설정 shows. `program` is absent until the user picked one. */
export interface ExplorerProgram {
  readonly program?: string
  readonly template: string
}

export type Expanded =
  | { readonly ok: true; readonly args: string[] }
  | { readonly ok: false; readonly reason: "host" | "path" | "template"; readonly detail: string }

/**
 * The template's tokens: whitespace separates them, double quotes keep whitespace inside one (`"--title=my host"`)
 * and `""` is an empty one. There is no escape character: a backslash is a Windows path character. `undefined` for a
 * quote that never closes.
 */
export function templateTokens(template: string): string[] | undefined {
  const state = { tokens: [] as string[], current: "", open: false, quoted: false }
  for (const char of template) {
    if (char === '"') {
      state.quoted = !state.quoted
      state.open = true
      continue
    }
    if (!state.quoted && /\s/.test(char)) {
      if (state.open) state.tokens.push(state.current)
      state.current = ""
      state.open = false
      continue
    }
    state.current += char
    state.open = true
  }
  if (state.quoted) return undefined
  if (state.open) state.tokens.push(state.current)
  return state.tokens
}

/** What a template may hold; `undefined` when it is usable. */
export function templateProblem(template: string): string | undefined {
  if (template.length > TEMPLATE_MAX) return `longer than ${TEMPLATE_MAX} characters`
  if (template.includes("\0")) return "a NUL character"
  const tokens = templateTokens(template)
  if (!tokens) return 'a " that never closes'
  const names = tokens.flatMap((token) => [...token.matchAll(PLACEHOLDER)].map((match) => match[1]!))
  const unknown = names.find((name) => name !== "host" && name !== "path")
  if (unknown) return `unknown placeholder {${unknown}}`
  if (!names.includes("path")) return "no {path}"
  return undefined
}

/**
 * The program's arguments for one host and remote path. Every template token becomes exactly one argument: a value is
 * put in as it is and never read again, so a remote name with spaces, quotes, `&`, `%VAR%` or `{host}` in it cannot add
 * an argument or name another placeholder. The values are checked first (`sshHost`, `remotePath`).
 */
export function expandTemplate(template: string, values: { readonly host: string; readonly path: string }): Expanded {
  const problem = templateProblem(template)
  if (problem) return { ok: false, reason: "template", detail: problem }
  if (!sshHost(values.host)) return { ok: false, reason: "host", detail: values.host }
  if (!remotePath(values.path)) return { ok: false, reason: "path", detail: values.path }
  return {
    ok: true,
    args: templateTokens(template)!.map((token) =>
      token.replace(PLACEHOLDER, (_match, name: string) => (name === "host" ? values.host : values.path)),
    ),
  }
}

const PLACEHOLDER = /\{([A-Za-z]+)\}/g

/**
 * An SSH destination as own-remote passes it to ssh (its `HOST` rule, own-remote src/vendor/ssh/command.ts): an ssh
 * config alias or `user@host`. Never one that starts with `-`: the program would read it as an option.
 */
export function sshHost(value: string) {
  return value.length <= 255 && !value.startsWith("-") && /^[A-Za-z0-9_@.:[\]%-]+$/.test(value)
}

/** An absolute path on the host. It starts with `/`, so it can never read as an option either. */
export function remotePath(value: string) {
  return value.startsWith("/") && value.length <= 4096 && !value.includes("\0")
}

/** The program is started as it is, never through cmd.exe: only an absolute path to an `.exe`. */
export function programFile(value: string, platform: NodeJS.Platform = process.platform) {
  const local = platform === "win32" ? path.win32 : path.posix
  if (value.includes("\0") || !local.isAbsolute(value)) return false
  if (platform === "win32") return DRIVE_OR_SHARE.test(value) && value.toLowerCase().endsWith(".exe")
  return true
}

/**
 * Whether `target` is one of `roots` or inside one, by its text alone (`..` resolved, Windows without case). A link
 * inside a root that points elsewhere still counts: Explorer only shows it. Device paths (`\\?\`, `\\.\`) and paths
 * without a drive or share never count.
 */
export function insideRoots(roots: readonly string[], target: string, platform: NodeJS.Platform = process.platform) {
  const windows = platform === "win32"
  const local = windows ? path.win32 : path.posix
  const absolute = (value: string) => (windows ? DRIVE_OR_SHARE.test(value) : value.startsWith("/"))
  const key = (value: string) => (windows ? local.resolve(value).toLowerCase() : local.resolve(value))
  if (target.includes("\0") || !absolute(target)) return false
  const wanted = key(target)
  return roots
    .filter((root) => absolute(root))
    .map(key)
    .some((root) => wanted === root || wanted.startsWith(root.endsWith(local.sep) ? root : root + local.sep))
}

/** `C:\…`, `C:/…` or `\\server\share`; not `\\?\…` or `\\.\…`. */
const DRIVE_OR_SHARE = /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+)/

/** The stored value (`ownExplorerProgram` in the shell's settings file), whatever an older or edited file holds. */
export function storedProgram(value: unknown, platform: NodeJS.Platform = process.platform): ExplorerProgram {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const template =
    typeof record.template === "string" && !templateProblem(record.template) ? record.template : DEFAULT_TEMPLATE
  if (typeof record.program !== "string" || !programFile(record.program, platform)) return { template }
  return { program: record.program, template }
}
