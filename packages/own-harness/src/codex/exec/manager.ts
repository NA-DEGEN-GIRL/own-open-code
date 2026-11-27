// Ports codex-rs/core/src/unified_exec/process_manager.rs (exec_command, write_stdin, process ids, pruning) and the
// shell invocation of codex-rs/core/src/shell.rs and shell-command (default shell, PowerShell UTF-8 prefix).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as ExecManager from "./manager.js"

import fs from "node:fs"
import path from "node:path"
import { GitHubBridge } from "@own/runtime"
import type { Truncate } from "../truncate/index.js"
import { ExecOutput } from "./output.js"
import { ExecProcess } from "./process.js"

const MIN_YIELD_TIME_MS = 250
const WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS = 10_000
const MIN_EMPTY_YIELD_TIME_MS = 5_000
const MAX_YIELD_TIME_MS = 30_000
const MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300_000
const MAX_PROCESSES = 64
/** The most recently used processes are never pruned. */
const PROTECTED_RECENT = 8
const INTERRUPT = "\u0003"

/** `UNIFIED_EXEC_ENV`: set for every command. */
const ENV = {
  NO_COLOR: "1",
  TERM: "dumb",
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
  CODEX_CI: "1",
}

/** `UTF8_OUTPUT_PREFIX`: Codex asks PowerShell for UTF-8 console output before every script. */
const POWERSHELL_UTF8 = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n"

export type ShellType = "zsh" | "bash" | "sh" | "powershell" | "cmd"

export interface Shell {
  readonly type: ShellType
  readonly path: string
}

export class ExecError extends Error {}

export interface ExecRequest {
  readonly command: string
  readonly cwd: string
  readonly shell: Shell
  readonly login: boolean
  readonly tty: boolean
  readonly yieldTimeMs: number
  readonly maxOutputTokens?: number
  readonly policy: Truncate.TruncationPolicy
  /** Sees the output as it arrives during this collection (display only). */
  readonly onOutput?: (chunk: Uint8Array) => void
  /**
   * Ends the process when it aborts before this first collection is over: the Code Mode cell that made the call was cut
   * off (terminated, interrupted or `exit()`ed), so nobody can learn the process id. Codex leaves such a process in its
   * unified exec store; own ends it (10 §6.11).
   */
  readonly signal?: AbortSignal
}

export interface WriteRequest {
  readonly id: number
  readonly chars: string
  readonly yieldTimeMs: number
  readonly maxOutputTokens?: number
  readonly policy: Truncate.TruncationPolicy
  readonly onOutput?: (chunk: Uint8Array) => void
}

interface Entry {
  readonly process: ExecProcess.Process
  readonly tty: boolean
  readonly command: string
}

/** Running exec sessions, per own session (Codex keeps one manager per thread). */
export class Manager {
  private readonly sessions = new Map<string, Map<number, Entry>>()

  /** exec_command's answer text. */
  async exec(sessionID: string, request: ExecRequest) {
    return ExecOutput.text(await this.execResult(sessionID, request))
  }

  /** write_stdin's answer text. */
  async write(sessionID: string, request: WriteRequest) {
    return ExecOutput.text(await this.writeResult(sessionID, request))
  }

  /** exec_command's result before formatting (Code Mode answers it as JSON). */
  async execResult(sessionID: string, request: ExecRequest): Promise<ExecOutput.Result> {
    // git's logins for the GitHub account the conversation uses (16 §6), when own has one for it; they end with the
    // process.
    const login = new AbortController()
    const spawned = Promise.withResolvers<number | undefined>()
    const github = await GitHubBridge.gitEnv(request.cwd, { sessionID, signal: login.signal, pid: spawned.promise })
    const store = this.store(sessionID)
    const id = allocate(store)
    const process = new ExecProcess.Process({
      argv: argv(request.shell, request.command, request.login),
      cwd: request.cwd,
      env: { ...globalThis.process.env, ...ENV, ...github },
      stdin: request.tty,
    })
    spawned.resolve(process.pid)
    void process.exited.finally(() => login.abort())
    const started = Date.now()
    prune(store)
    store.set(id, { process, tty: request.tty, command: request.command })
    const end = () => {
      process.terminate()
      store.delete(id)
    }
    request.signal?.addEventListener("abort", end, { once: true })
    if (request.signal?.aborted) end()
    const collected = await process
      .collect(started + clampYield(request.yieldTimeMs), request.onOutput)
      .finally(() => request.signal?.removeEventListener("abort", end))
    const wallTimeMs = Date.now() - started
    const alive = !process.hasExited
    if (!alive) store.delete(id)
    return {
      chunkID: ExecOutput.chunkID(),
      wallTimeMs,
      raw: new TextDecoder().decode(collected.bytesWithOmissionMarker()),
      omittedBytes: collected.omittedBytes,
      originalTokenCount: Math.ceil(collected.totalBytes / 4),
      sessionID: alive ? id : undefined,
      exitCode: alive ? undefined : process.exitCode,
      maxOutputTokens: request.maxOutputTokens,
      policy: request.policy,
    }
  }

  /** write_stdin's result before formatting. */
  async writeResult(sessionID: string, request: WriteRequest): Promise<ExecOutput.Result> {
    const store = this.store(sessionID)
    const entry = store.get(request.id)
    if (entry === undefined) throw new ExecError(`Unknown process id ${request.id}`)
    if (request.chars !== "") {
      if (!entry.tty && request.chars !== INTERRUPT)
        throw new ExecError("stdin is closed for this session; rerun exec_command with tty=true to keep stdin open")
      if (!entry.tty) entry.process.terminate()
      if (entry.tty && entry.process.write(request.chars)) await Bun.sleep(100)
    }
    const yieldTimeMs =
      request.chars === ""
        ? clamp(
            Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS),
            MIN_EMPTY_YIELD_TIME_MS,
            MAX_BACKGROUND_TERMINAL_TIMEOUT_MS,
          )
        : Math.min(Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS)
    const started = Date.now()
    const collected = await entry.process.collect(started + yieldTimeMs, request.onOutput)
    const wallTimeMs = Date.now() - started
    const alive = !entry.process.hasExited
    if (!alive) store.delete(request.id)
    return {
      chunkID: ExecOutput.chunkID(),
      wallTimeMs,
      raw: new TextDecoder().decode(collected.bytesWithOmissionMarker()),
      omittedBytes: collected.omittedBytes,
      originalTokenCount: Math.ceil(collected.totalBytes / 4),
      sessionID: alive ? request.id : undefined,
      exitCode: alive ? undefined : entry.process.exitCode,
      maxOutputTokens: request.maxOutputTokens,
      policy: request.policy,
    }
  }

  /** Ends every process of an own session (it was deleted) or of all sessions (the plugin stops). */
  terminate(sessionID?: string) {
    const stores =
      sessionID === undefined
        ? [...this.sessions.values()]
        : [this.sessions.get(sessionID)].filter((s) => s !== undefined)
    stores.forEach((store) => store.forEach((entry) => entry.process.terminate()))
    if (sessionID === undefined) this.sessions.clear()
    if (sessionID !== undefined) this.sessions.delete(sessionID)
  }

  private store(sessionID: string) {
    const existing = this.sessions.get(sessionID)
    if (existing !== undefined) return existing
    const created = new Map<number, Entry>()
    this.sessions.set(sessionID, created)
    return created
  }
}

/** `derive_exec_args`, with Codex's UTF-8 prefix for PowerShell scripts. */
export function argv(shell: Shell, command: string, login: boolean): ReadonlyArray<string> {
  if (shell.type === "powershell")
    return [shell.path, ...(login ? [] : ["-NoProfile"]), "-Command", `${POWERSHELL_UTF8}${command}`]
  if (shell.type === "cmd") return [shell.path, "/c", command]
  return [shell.path, login ? "-lc" : "-c", command]
}

/** The shell type of a path or name (`detect_shell_type`). */
export function shellType(shell: string): ShellType | undefined {
  const name = path
    .basename(shell)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "")
  if (name === "pwsh" || name === "powershell") return "powershell"
  if (name === "zsh" || name === "bash" || name === "sh" || name === "cmd") return name
  return undefined
}

/**
 * The user's default shell (`default_user_shell`): on Windows PowerShell 7 (`pwsh`) when found, else Windows
 * PowerShell; elsewhere `$SHELL` when it is zsh, bash or sh, else bash, zsh, sh.
 */
export function defaultShell(): Shell {
  if (process.platform === "win32") {
    const pwsh = Bun.which("pwsh") ?? existing("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
    if (pwsh !== undefined) return { type: "powershell", path: pwsh }
    const powershell =
      Bun.which("powershell") ?? existing("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    return { type: "powershell", path: powershell ?? "powershell.exe" }
  }
  const user = process.env.SHELL
  const userType = user === undefined ? undefined : shellType(user)
  if (user !== undefined && userType !== undefined && userType !== "powershell" && userType !== "cmd")
    return { type: userType, path: user }
  const preferred: ReadonlyArray<ShellType> = process.platform === "darwin" ? ["zsh", "bash"] : ["bash", "zsh"]
  const found = [...preferred, "sh" as const]
    .map((type) => ({ type, path: Bun.which(type) }))
    .find((shell) => shell.path !== null)
  return found?.path ? { type: found.type, path: found.path } : { type: "sh", path: "/bin/sh" }
}

/** A model-provided `shell` (`get_shell_by_model_provided_path`), else the default. */
export function resolveShell(requested: string | undefined): Shell {
  if (requested === undefined || requested === "") return defaultShell()
  const type = shellType(requested)
  if (type === undefined) return defaultShell()
  return { type, path: Bun.which(requested) ?? requested }
}

function existing(file: string) {
  return fs.existsSync(file) ? file : undefined
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/** `clamp_yield_time`: 250–30000 ms, at least 10000 ms on Windows. */
function clampYield(ms: number) {
  return clamp(
    process.platform === "win32" ? Math.max(ms, WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS) : ms,
    MIN_YIELD_TIME_MS,
    MAX_YIELD_TIME_MS,
  )
}

/** A random id in 1000..99999 not in use (`allocate_process_id`). */
function allocate(store: ReadonlyMap<number, Entry>): number {
  const id = 1_000 + Math.floor(Math.random() * 99_000)
  return store.has(id) ? allocate(store) : id
}

/** Keeps at most 64 processes: drops the least recently used exited one, else the least recently used, never the 8 newest. */
function prune(store: Map<number, Entry>) {
  if (store.size < MAX_PROCESSES) return
  const byUse = [...store.entries()].sort(([, a], [, b]) => a.process.lastUsed - b.process.lastUsed)
  const recent = new Set(byUse.slice(-PROTECTED_RECENT).map(([id]) => id))
  const candidates = byUse.filter(([id]) => !recent.has(id))
  const victim = candidates.find(([, entry]) => entry.process.hasExited) ?? candidates[0]
  if (victim === undefined) return
  victim[1].process.terminate()
  store.delete(victim[0])
}
