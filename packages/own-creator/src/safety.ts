export * as Safety from "./safety.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Creator } from "@own/protocol/creator"
import { Code } from "./code.js"
import type { CreatorStore } from "./store.js"

/**
 * What own.creator refuses beyond the format's schema (17 §9): an extension never reads credentials, never loosens
 * own's own gates, never claims a name another extension or the app uses, and is limited only to real project folders.
 * These checks are a wall in front of the shell approval, not a sandbox: an approved command runs with the user's
 * rights (17 §9.4).
 */

/** Places and variables that hold credentials; a command template that names one is refused. */
const CREDENTIALS = [
  /own-open-code[\\/]+vault/i,
  /own-vault/i,
  /\.credentials\.json/i,
  /(?:^|[\\/\s"'])auth\.json/i,
  /service-own\.json/i,
  /opencode-own\.db/i,
  /\bOWN_HOME\b/,
  /\bCLAUDE_CONFIG_DIR\b/,
  /\bCODEX_HOME\b/,
  /\$env:[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
  /%[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z_]*%/i,
  /\$\{?[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
  /printenv|Get-ChildItem\s+env:|\bgci\s+env:|\bdir\s+env:|\bls\s+env:/i,
]

/**
 * Permission actions an allow rule may never loosen: own's gates and the approvals of its own tools. GitHub writes keep
 * only a saved 항상 허용 of exactly that tool, repository and account (16 GH-26), and an image spends money or plan
 * usage (02 §9.6), so neither takes an extension's allow (merge round 11, MR14).
 */
const SEALED = /^(?:own_|creator|tool_rule|computer|browser|github\.|image_generate$)/

export function problems(extension: Creator.Extension): ReadonlyArray<Creator.Problem> {
  return extension.items.flatMap((item, index): Creator.Problem[] => {
    const at = `items[${index}]`
    if (item.type === "tool.command")
      return [item.command, item.cwd ?? ""].flatMap((text) =>
        CREDENTIALS.some((pattern) => pattern.test(text))
          ? [{ path: `${at}.command`, message: "commands may not name credential files or secret variables" }]
          : [],
      )
    if (item.type === "tool.rule")
      return item.rules.flatMap((rule, n): Creator.Problem[] => {
        if (rule.effect !== "allow") return []
        if (rule.tool !== undefined)
          return [{ path: `${at}.rules[${n}]`, message: "allow applies to permission rules only" }]
        if (rule.permission === undefined) return []
        if (rule.permission.includes("*") || SEALED.test(rule.permission))
          return [{ path: `${at}.rules[${n}]`, message: `allow cannot name '${rule.permission}'` }]
        return []
      })
    if (item.type === "mcp.server") return [...Code.problems(item, at), ...Code.dependencyProblems(item, at)]
    if (item.type === "plugin.code") return Code.problems(item, at)
    return []
  })
}

/**
 * Items own keeps one copy of for every project: a harness's 내 지시문, and a code plugin (core's plugin list is one for
 * every Location, 17 §12.2).
 */
export function globalOnly(item: Creator.Item) {
  return item.type === "harness.instructions" || item.type === "plugin.code"
}

/** The names an extension takes in a shared namespace. */
export function claims(extension: Creator.Extension) {
  return extension.items.flatMap((item) => {
    if (item.type === "tool.command") return [`tool:${Creator.toolName(item.name)}`]
    if (item.type === "agent") return [`agent:${item.name}`]
    if (item.type === "command") return [`command:${item.name}`]
    if (item.type === "skill") return [`skill:${item.name}`]
    if (item.type === "harness.instructions") return [`harness:${item.harness}`]
    if (item.type === "mcp.server") return [`server:${extension.id}-${item.name}`]
    return []
  })
}

/** Names `extension` takes that another extension in force (on, with a readable version) already took. */
export function conflicts(extension: Creator.Extension, others: ReadonlyArray<CreatorStore.Loaded>): Creator.Problem[] {
  const taken = new Map(
    others
      .filter((other) => other.entry.enabled && other.extension !== undefined && other.status !== "invalid")
      .flatMap((other) => claims(other.extension!).map((claim) => [claim, other.entry.id] as const)),
  )
  return claims(extension).flatMap((claim) => {
    const owner = taken.get(claim)
    return owner === undefined ? [] : [{ path: "items", message: `${claim} is taken by extension '${owner}'` }]
  })
}

/** Names the app or the config already uses (core's agents, config commands, other plugins' tools). */
export function reservedProblems(extension: Creator.Extension, reserved: CreatorStore.Reserved): Creator.Problem[] {
  return extension.items.flatMap((item): Creator.Problem[] => {
    if (item.type === "agent" && reserved.agents?.has(item.name))
      return [{ path: "items", message: `agent '${item.name}' already exists` }]
    if (item.type === "command" && reserved.commands?.has(item.name))
      return [{ path: "items", message: `command '${item.name}' already exists` }]
    if (item.type === "tool.command" && reserved.tools?.has(Creator.toolName(item.name)))
      return [{ path: "items", message: `tool '${Creator.toolName(item.name)}' already exists` }]
    return []
  })
}

/**
 * Normalized project folders, or why some cannot be used: each absolute, an existing folder, not a drive or file
 * system root, not inside own's home and not the config folder. Duplicates drop out (case-insensitively on Windows).
 */
export async function projects(
  input: ReadonlyArray<string>,
  places: { readonly home: string; readonly configDir?: string },
): Promise<{ folders: string[]; problems: Creator.Problem[] }> {
  if (input.length > Creator.LIMITS.projects)
    return { folders: [], problems: [{ path: "projects", message: `at most ${Creator.LIMITS.projects} folders` }] }
  const checked = await Promise.all(
    input.map(async (raw, index) => {
      const at = `projects[${index}]`
      if (!path.isAbsolute(raw)) return { problem: { path: at, message: `'${raw}' is not an absolute path` } }
      const folder = path.resolve(raw)
      if (path.parse(folder).root === folder) return { problem: { path: at, message: `'${folder}' is a root` } }
      if (inside(folder, places.home) || inside(places.home, folder))
        return { problem: { path: at, message: `'${folder}' holds own's home` } }
      if (places.configDir !== undefined && inside(folder, places.configDir))
        return { problem: { path: at, message: `'${folder}' is the config folder` } }
      const stat = await fs.stat(folder).catch(() => undefined)
      if (stat === undefined || !stat.isDirectory())
        return { problem: { path: at, message: `'${folder}' is not a folder` } }
      return { folder }
    }),
  )
  const problems = checked.flatMap((item) => ("problem" in item && item.problem !== undefined ? [item.problem] : []))
  const folders = checked.flatMap((item) => ("folder" in item && item.folder !== undefined ? [item.folder] : []))
  const unique = [...new Map(folders.map((folder) => [key(folder), folder])).values()]
  return { folders: unique, problems }
}

/**
 * Host folders of a scope (17 §10), checked on this PC: a host id and an absolute path that is not a root, at most
 * {@link Creator.LIMITS.projects}. This PC cannot see a host's disk; the host checks each again before it applies
 * ({@link hostFolders}).
 */
export function hostProjects(input: ReadonlyArray<Creator.HostFolder>): {
  folders: Creator.HostFolder[]
  problems: Creator.Problem[]
} {
  if (input.length > Creator.LIMITS.projects)
    return { folders: [], problems: [{ path: "hostProjects", message: `at most ${Creator.LIMITS.projects} host folders` }] }
  const checked = input.map((item, index) => {
    const at = `hostProjects[${index}]`
    const directory = normalizeHostPath(item.directory)
    if (directory === undefined) return { problem: { path: at, message: `'${item.directory}' is not an absolute path` } }
    if (isRoot(directory)) return { problem: { path: at, message: `'${directory}' is a root` } }
    return { folder: { host: item.host, directory } }
  })
  const problems = checked.flatMap((item) => ("problem" in item && item.problem !== undefined ? [item.problem] : []))
  const folders = checked.flatMap((item) => ("folder" in item && item.folder !== undefined ? [item.folder] : []))
  const unique = [...new Map(folders.map((folder) => [`${folder.host}\n${key(folder.directory)}`, folder])).values()]
  return { folders: unique, problems }
}

/**
 * The folders of a mirrored scope this host keeps (17 §10): absolute here, not a root, not own's home or inside it, not
 * the config folder. A folder dropped here never widens the scope: an extension scoped to folders with none left does
 * not apply (the caller reports it).
 */
export function hostFolders(input: ReadonlyArray<string>, places: { readonly home: string; readonly configDir?: string }) {
  return input.flatMap((raw) => {
    if (!path.isAbsolute(raw)) return []
    const folder = path.resolve(raw)
    if (path.parse(folder).root === folder) return []
    if (inside(folder, places.home) || inside(places.home, folder)) return []
    if (places.configDir !== undefined && inside(folder, places.configDir)) return []
    return [folder]
  })
}

function normalizeHostPath(raw: string) {
  const trimmed = raw.trim()
  if (trimmed.startsWith("/")) {
    const normal = path.posix.normalize(trimmed)
    return normal.length > 1 ? normal.replace(/\/+$/, "") : normal
  }
  if (path.win32.isAbsolute(trimmed) && /^[A-Za-z]:[\\/]/.test(trimmed)) return path.win32.normalize(trimmed).replace(/[\\/]+$/, "") || trimmed
  return undefined
}

function isRoot(directory: string) {
  return directory === "/" || /^[A-Za-z]:\\?$/.test(directory)
}

/** `directory` is `folder` or inside it. */
export function inside(directory: string, folder: string) {
  const a = key(path.resolve(directory))
  const b = key(path.resolve(folder))
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`)
}

/** Every project, or `directory` is inside one of `projects`. */
export function inScope(projects: ReadonlyArray<string>, directory: string) {
  return projects.length === 0 || projects.some((folder) => inside(directory, folder))
}

function key(folder: string) {
  const forward = folder.replaceAll("\\", "/")
  return process.platform === "win32" ? forward.toLowerCase() : forward
}

/** A skill item as the SKILL.md own writes into its version (core shows the path; the text is the item's). */
export function skillMarkdown(item: Creator.SkillItem) {
  return `---\nname: ${item.name}\ndescription: ${JSON.stringify(item.description)}\n---\n\n${item.content}\n`
}

/** Variables an extension's command never sees: anything that looks like a secret and own's service settings. */
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|SESSION)/i
const OWN_ENV = /^(?:OWN_|OPENCODE_|CLAUDE_|CODEX_|ANTHROPIC_|OPENAI_|DEEPSEEK_|GITHUB_|GH_|GIT_ASKPASS|SSH_AUTH_SOCK)/i

/** The environment of a command tool: the service's, without secrets and without own's and the providers' variables. */
export function commandEnv(source: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !SECRET_ENV.test(entry[0]) && !OWN_ENV.test(entry[0]),
    ),
  )
}

/** Allow-listed variables a C2 server, its install, typecheck and tests see (17 §11.2); everything else is left out. */
const SERVER_ENV = new Set(
  [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "NO_COLOR",
  ].map((name) => name.toUpperCase()),
)

/** Variables that name the Windows user or lead into the user's profile; set empty, so nothing inherits them. */
const IDENTITY_ENV = [
  "USERNAME",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "LOGONSERVER",
  "COMPUTERNAME",
  "ONEDRIVE",
  "ONEDRIVECONSUMER",
  "ONEDRIVECOMMERCIAL",
  "USER",
  "LOGNAME",
]

/**
 * The whole environment of a C2 server's sandbox process and of own's staging tools: the allow-listed variables of
 * `source`, `PATH` without the folders inside the user's profile, the identity variables empty, Bun's switch to run
 * the service's executable as Bun, Bun's transpiler cache off, and `extra`. No credentials, no own or provider
 * variables. `temp` gives `TEMP`/`TMP` only to own's staging tools (install, typecheck); the host and the sandbox get
 * none (17 §11.2).
 */
export function serverEnv(
  source: Readonly<Record<string, string | undefined>>,
  input: { readonly temp?: string; readonly extra?: Readonly<Record<string, string>> } = {},
): Record<string, string> {
  const profile = source.USERPROFILE ?? source.HOME
  const kept = Object.entries(source).flatMap((entry): Array<[string, string]> =>
    entry[1] !== undefined && SERVER_ENV.has(entry[0].toUpperCase()) ? [[entry[0], entry[1]]] : [],
  )
  const paths = kept.map((entry): [string, string] => {
    if (entry[0].toUpperCase() !== "PATH" || profile === undefined || profile === "") return entry
    const separator = process.platform === "win32" ? ";" : ":"
    return [entry[0], entry[1].split(separator).filter((folder) => folder !== "" && !inside(folder, profile)).join(separator)]
  })
  return {
    ...Object.fromEntries(paths),
    ...Object.fromEntries(IDENTITY_ENV.map((name) => [name, ""])),
    ...(input.temp === undefined ? {} : { TEMP: input.temp, TMP: input.temp, TMPDIR: input.temp }),
    BUN_BE_BUN: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    NO_COLOR: "1",
    ...input.extra,
  }
}

/**
 * Folders and files own's bridge refuses inside a project, at any depth, compared case-insensitively by name (17
 * §11.3): credentials of other tools, own's and the agents' homes, and `.git` (its config may hold tokens, and a hook
 * written there would run outside the sandbox at the next commit).
 */
export const DENIED_NAMES: ReadonlyArray<string> = [
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".codex",
  ".claude",
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  ".pgpass",
  ".credentials.json",
  "credentials.json",
  "auth.json",
]

/** Paths (`/`-separated, relative to any folder) the bridge refuses, besides {@link DENIED_NAMES}. */
export const DENIED_PATHS: ReadonlyArray<string> = [".config/gh", ".config/gcloud", ".config/op", ".local/share/opencode"]

/**
 * What own's bridge in a C2 sandbox allows (17 §11.3): files of `project` only, never own's home, the config folder or
 * Codex's and Claude Code's folders even inside it, never the names of {@link DENIED_NAMES} and {@link DENIED_PATHS}
 * at any depth (nor `.env` files), a call's time and output, the memory cap, and the hosts `fetch` may reach.
 */
export function fence(input: {
  readonly project: string
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly item: Pick<Creator.McpServer, "timeoutSeconds" | "memoryMb" | "hosts">
}) {
  const profile = input.env.USERPROFILE ?? input.env.HOME
  const deny = [
    input.home,
    input.env.OPENCODE_CONFIG_DIR,
    input.env.CODEX_HOME,
    input.env.CLAUDE_CONFIG_DIR,
    ...(profile === undefined || profile === "" ? [] : [path.join(profile, ".codex"), path.join(profile, ".claude")]),
  ].filter((folder): folder is string => folder !== undefined && folder !== "")
  return {
    project: input.project,
    deny,
    names: DENIED_NAMES,
    paths: DENIED_PATHS,
    hosts: input.item.hosts ?? [],
    callMs: (input.item.timeoutSeconds ?? 60) * 1000,
    outputChars: 100_000,
    memoryMb: input.item.memoryMb ?? 512,
  }
}

export type Fence = ReturnType<typeof fence>
