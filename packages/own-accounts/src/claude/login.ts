export * as ClaudeLogin from "./login.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { ProcessTree } from "@own/runtime"

/**
 * `Claude 계정 추가` (02 §8.7, user decision 2026-10-10 "쉬운 로그인"): Claude Code's own login, never own's. own finds
 * the installed Claude Code, opens `claude auth login --claudeai` in a visible console window on this PC with a new,
 * empty login folder as `CLAUDE_CONFIG_DIR`, and waits. The user signs in in the browser Claude Code opens; own never
 * sees a password or a token and never downloads or installs Claude Code.
 *
 * While waiting own looks at two things only: the window's exit code, and whether `<folder>\.credentials.json`
 * exists and when it was written (never its contents). Afterwards it reads `oauthAccount.emailAddress` and
 * `oauthAccount.accountUuid` of `<folder>\.claude.json` and nothing else of it.
 */

/** How long a login window may stay open (10 minutes), and how often the folder is looked at (1 s). */
export const TIMEOUT_MS = 10 * 60_000
export const POLL_MS = 1_000
/** After the credentials file appeared, how long to wait for the window to close on its own. */
export const EXIT_GRACE_MS = 30_000

/** A started login window. */
export interface Window {
  /** Resolves with the exit code once the window closed. */
  readonly exited: Promise<number>
  readonly kill: () => void
}

/** Starts `command` with `env`; production opens a console window (`cmd /c start /wait`), tests run a Bun script. */
export type Spawn = (command: ReadonlyArray<string>, env: Readonly<Record<string, string>>) => Window

export interface Config {
  /** `%USERPROFILE%`. */
  readonly userHome: string
  /** The Claude Code to start; `undefined` = {@link find}. Tests give a fake CLI (`[bun, script]`). */
  readonly cli?: ReadonlyArray<string>
  readonly spawn: Spawn
  readonly pollMs: number
  readonly timeoutMs: number
  readonly exitGraceMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export function defaults(userHome: string): Config {
  return {
    userHome,
    spawn: consoleWindow,
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    exitGraceMs: EXIT_GRACE_MS,
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
  }
}

/** Claude Code's native install (`%USERPROFILE%\.local\bin\claude.exe`), else `claude` on PATH, else `undefined`. */
export async function find(config: Pick<Config, "userHome" | "cli">): Promise<ReadonlyArray<string> | undefined> {
  if (config.cli) return config.cli
  const native = path.join(config.userHome, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude")
  const found = await fs.stat(native).then(
    (info) => info.isFile(),
    () => false,
  )
  if (found) return [native]
  const onPath = Bun.which("claude")
  return onPath ? [onPath] : undefined
}

/**
 * The environment of the login window: a short allowlist of the system variables a Windows program needs, plus
 * `CLAUDE_CONFIG_DIR`. Everything else of the service's environment stays out (`ANTHROPIC_*`, `CLAUDE_*`, own's and
 * OpenCode's variables, the service password).
 */
export function environment(folder: string, source: Readonly<Record<string, string | undefined>> = process.env) {
  const keep = new Set(ENV_ALLOW.map((name) => name.toUpperCase()))
  const picked = Object.entries(source).flatMap(([name, value]) =>
    value !== undefined && keep.has(name.toUpperCase()) ? [[name, value] as const] : [],
  )
  return { ...Object.fromEntries(picked), CLAUDE_CONFIG_DIR: folder }
}

const ENV_ALLOW = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "LC_ALL",
]

export type Outcome =
  | { readonly type: "logged_in" }
  | { readonly type: "failed"; readonly exitCode: number | null }
  | { readonly type: "timeout" }
  /** The service stopped while the window was open: the window is closed and nothing is added. */
  | { readonly type: "cancelled" }

/**
 * Opens the login window for `folder` and waits until it closed with a login in the folder (`logged_in`), closed
 * without one (`failed`), or {@link Config.timeoutMs} passed (the window is closed, `timeout`). `signal` aborts it (the
 * service stops): the window is closed (`cancelled`).
 */
export async function run(
  config: Config,
  cli: ReadonlyArray<string>,
  folder: string,
  signal?: AbortSignal,
  /** The window's environment; the Claude Agent route passes its own allow-list (02 §8.10.3). */
  env: Readonly<Record<string, string>> = environment(folder),
): Promise<Outcome> {
  const started = config.now()
  const window = config.spawn([...cli, "auth", "login", "--claudeai"], env)
  const exit = { code: undefined as number | undefined }
  void window.exited.then(
    (code) => {
      exit.code = code
    },
    () => {
      exit.code = -1
    },
  )
  const credentials = path.join(folder, CREDENTIALS_FILE)
  const seen = { at: undefined as number | undefined }
  for (;;) {
    const written = await writtenAt(credentials)
    // A file from before this window (another login reused the folder) is not this login.
    if (written !== undefined && written >= started - 2_000) seen.at ??= config.now()
    if (exit.code !== undefined) {
      // Looked at again: the window may have written the file and closed since the look above.
      const last = seen.at === undefined ? await writtenAt(credentials) : undefined
      const fresh = seen.at !== undefined || (last !== undefined && last >= started - 2_000)
      return fresh ? { type: "logged_in" } : { type: "failed", exitCode: exit.code }
    }
    if (seen.at !== undefined && config.now() - seen.at >= config.exitGraceMs) {
      window.kill()
      return { type: "logged_in" }
    }
    if (config.now() - started >= config.timeoutMs) {
      window.kill()
      return { type: "timeout" }
    }
    if (signal?.aborted) {
      window.kill()
      return { type: "cancelled" }
    }
    await config.sleep(config.pollMs)
  }
}

/** The credentials file Claude Code writes in its config folder. own only ever stats it. */
export const CREDENTIALS_FILE = ".credentials.json"

/** When the file was last written, or `undefined` when it does not exist. Never opens it. */
export async function writtenAt(file: string) {
  return fs.stat(file).then(
    (info) => (info.isFile() ? info.mtimeMs : undefined),
    () => undefined,
  )
}

/** Whether Claude Code is signed in in `folder` (its credentials file exists). Never opens it. */
export async function signedIn(folder: string) {
  return (await writtenAt(path.join(folder, CREDENTIALS_FILE))) !== undefined
}

const Profile = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      emailAddress: Schema.optional(Schema.String),
      accountUuid: Schema.optional(Schema.String),
    }),
  ),
})
const decodeProfile = Schema.decodeUnknownOption(Schema.fromJsonString(Profile))

/**
 * `oauthAccount.emailAddress` and `oauthAccount.accountUuid` of Claude Code's `.claude.json` for `folder`: inside the
 * folder, and for the default `%USERPROFILE%\.claude` also `%USERPROFILE%\.claude.json` (where Claude Code keeps it
 * without `CLAUDE_CONFIG_DIR`). Nothing else of the file is kept.
 */
export async function profile(folder: string, userHome: string) {
  const candidates = [
    path.join(folder, ".claude.json"),
    ...(same(folder, path.join(userHome, ".claude")) ? [path.join(userHome, ".claude.json")] : []),
  ]
  for (const file of candidates) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    const account = text === undefined ? undefined : Option.getOrUndefined(decodeProfile(text))?.oauthAccount
    if (account?.emailAddress || account?.accountUuid)
      return { email: account.emailAddress, accountUuid: account.accountUuid }
  }
  return undefined
}

/** The account key of a folder, as the patched plugin names it: resolved, lower-cased on Windows. */
export function key(folder: string) {
  const resolved = path.resolve(folder)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function same(a: string, b: string) {
  return key(a) === key(b)
}

/**
 * The production window: `cmd /d /c start "<title>" /wait <cli…>` opens Claude Code in a console window of its own on
 * this PC's desktop, and `start /wait` hands back its exit code. Closing the window cancels the login.
 */
const consoleWindow: Spawn = (command, env) => {
  // `cmd` itself stays hidden; `start` gives Claude Code a new console window, as cmd's child (so the tree kill of a
  // timeout reaches it).
  const child = Bun.spawn(["cmd.exe", "/d", "/c", "start", "Claude Code 로그인", "/wait", ...command], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  return { exited: child.exited, kill: () => void ProcessTree.kill(child) }
}
