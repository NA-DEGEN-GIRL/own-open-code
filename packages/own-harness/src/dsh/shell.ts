// Ports dsh's local shell executors: packages/shell/pwsh-local/src/{index,resolve}.ts (Windows: `pwsh -NoLogo -NoProfile
// -NonInteractive -Command <UTF-8 preamble><command>`, PowerShell 7 first, then pwsh on PATH, then Windows PowerShell
// 5.1) and packages/shell/bash-local/src/index.ts (`bash -c <command>`), with their model-friendly environment
// (`NO_COLOR`, `PAGER`, `GIT_PAGER`, and `TERM=dumb` for bash), the default 120 s timeout capped at 600 s
// (packages/util/timeout `clampTimeout`), 64,000-byte stdout and stderr tails with spill files (output.ts), and the
// child environment of packages/subprocess/subprocess/src/index.ts `scrubbedParentEnv`: the service's environment
// without credential-shaped names and without `DSH_*`, then the overrides, then the managed `DSH_*` facts
// (packages/shell/shell-env). dsh's job registry (background runs, promotion on timeout) and its sandbox are not
// ported: a command runs in the foreground and the deadline kills it, as dsh's tools do without a job registry.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshShell from "./shell.js"

import { spawn, type ChildProcess } from "node:child_process"
import { lstatSync } from "node:fs"
import path from "node:path"
import { DshOutput } from "./output.js"

export type Kind = "pwsh" | "bash"

/** pwsh-local `ENV_OVERRIDES`; bash-local adds `TERM=dumb` (a POSIX concept pwsh-local leaves out). */
export const PWSH_ENV = { NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" } as const
export const BASH_ENV = { NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" } as const

/** pwsh-local `ENCODING_PREAMBLE`: UTF-8 output on line 1, so PowerShell's error line numbers stay right. */
export const ENCODING_PREAMBLE =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); "

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
export const MAX_OUTPUT_BYTES = 64_000
export const MAX_SPILL_BYTES = 64 * 1024 * 1024
/** `DEFAULT_GRACE_MS`: SIGTERM to SIGKILL. */
export const GRACE_MS = 3_000
/** After exit, wait this long for the pipes to fall idle (a daemonized descendant can hold them open). */
const EXIT_STDIO_GRACE_MS = 100

/** `SENSITIVE_ENV_PATTERN`: names a shell child never inherits. */
export const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i
/**
 * git's environment config (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`) names a config key, not a
 * secret. Dropping only the key leaves the count and value behind, and git then refuses every command (missing config
 * key) — the GitHub login hands its credential helper to shells this way (own-accounts github/credential.ts).
 */
const GIT_CONFIG_KEY = /^GIT_CONFIG_KEY_\d+$/i

export interface Result {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly timeoutMs: number
  readonly stdout: DshOutput.Collected
  readonly stderr: DshOutput.Collected
}

/** dsh's shell for this platform: pwsh on Windows, bash elsewhere (base bundle: `tool-bash` off on win32). */
export function kind(): Kind {
  return process.platform === "win32" ? "pwsh" : "bash"
}

/** `clampTimeout`: the default when none is given, never above the cap. */
export function timeout(requested: number | undefined) {
  return Math.min(requested ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/** `candidatePwshPaths`: PowerShell 7's install, every PATH entry, then Windows PowerShell 5.1. */
export function candidatePwshPaths(env: NodeJS.ProcessEnv = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files"
  const systemRoot = env.SystemRoot ?? "C:\\Windows"
  return [
    path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    ...(env.PATH ?? "")
      .split(";")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter((entry) => entry.length > 0)
      .map((entry) => path.win32.join(entry, "pwsh.exe")),
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]
}

/** `resolvePwshPath`: the first candidate that exists (lstat sees the Store alias), else `pwsh` from PATH. */
export function resolvePwshPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return "pwsh"
  return candidatePwshPaths(env).find(exists) ?? "pwsh"
}

/** The argv a command runs as. */
export function argv(shell: Kind, command: string, pwsh = resolvePwshPath()) {
  return shell === "pwsh"
    ? [pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${ENCODING_PREAMBLE}${command}`]
    : ["bash", "-c", command]
}

/** The child's environment: the scrubbed parent, the shell's overrides, then the managed `DSH_*` facts. */
export function environment(shell: Kind, managed: Readonly<Record<string, string>>, parent: NodeJS.ProcessEnv) {
  const scrubbed = Object.fromEntries(
    Object.entries(parent).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (!SENSITIVE_ENV.test(entry[0]) || GIT_CONFIG_KEY.test(entry[0])) &&
        !entry[0].toUpperCase().startsWith("DSH_"),
    ),
  )
  return { ...scrubbed, ...(shell === "pwsh" ? PWSH_ENV : BASH_ENV), ...managed }
}

/**
 * Runs `command` in `cwd` and settles when the process and its pipes are done. The deadline (`timeoutMs`) and `signal`
 * kill the whole process tree; on Windows a killed process settles as exit code 1.
 */
export async function run(input: {
  readonly shell: Kind
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  /** The shell's process id, once spawned (the GitHub login's holder, 16 §8.6). */
  readonly onSpawn?: (pid: number | undefined) => void
}): Promise<Result> {
  const [file, ...args] = argv(input.shell, input.command)
  const stdout = new DshOutput.Collector(MAX_OUTPUT_BYTES, "stdout", { maxBytes: MAX_SPILL_BYTES })
  const stderr = new DshOutput.Collector(MAX_OUTPUT_BYTES, "stderr", { maxBytes: MAX_SPILL_BYTES })
  const child = spawn(file!, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  })
  input.onSpawn?.(child.pid)
  const state = { timedOut: false, aborted: false, escalation: undefined as ReturnType<typeof setTimeout> | undefined }
  // dsh's managed range: SIGTERM, then SIGKILL after the grace period (`graceMs`); Windows has no SIGTERM to send.
  const kill = () => {
    if (child.pid === undefined || state.escalation !== undefined) return
    const pid = child.pid
    if (process.platform === "win32") return killTree(pid)
    if (!signal(-pid, "SIGTERM")) signal(pid, "SIGTERM")
    state.escalation = setTimeout(() => killTree(pid), GRACE_MS)
  }
  const timer = setTimeout(() => {
    state.timedOut = true
    kill()
  }, input.timeoutMs)
  const abort = () => {
    state.aborted = true
    kill()
  }
  if (input.signal?.aborted) abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
  const exit = await settle(child).finally(() => {
    clearTimeout(timer)
    if (state.escalation !== undefined) clearTimeout(state.escalation)
    input.signal?.removeEventListener("abort", abort)
  })
  return {
    exitCode: exit.signal === null ? exit.code : null,
    signal: exit.signal,
    timedOut: state.timedOut,
    aborted: state.aborted && !state.timedOut,
    timeoutMs: input.timeoutMs,
    stdout: stdout.finalize(),
    stderr: stderr.finalize(),
  }
}

/** Kills a process and its children: `taskkill /F /T` on Windows, the process group elsewhere. */
export function killTree(pid: number) {
  if (process.platform === "win32") {
    const killer = spawn(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/F", "/T", "/PID", String(pid)],
      { stdio: "ignore", windowsHide: true },
    )
    killer.once("error", () => {})
    return
  }
  // The group first; the process alone when the group is already gone.
  if (!signal(-pid, "SIGKILL")) signal(pid, "SIGKILL")
}

/** `process.kill` throws for a process that no longer exists. */
function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
    return true
  } catch {
    return false
  }
}

function exists(candidate: string) {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Resolves once both pipes end after exit, or once they fall idle for a moment (a daemon can hold them open). */
function settle(child: ChildProcess) {
  return new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve, reject) => {
    const state = {
      settled: false,
      exited: false,
      code: null as number | null,
      signal: null as string | null,
      stdoutEnded: child.stdout === null,
      stderrEnded: child.stderr === null,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    const finish = () => {
      if (state.settled) return
      state.settled = true
      if (state.timer !== undefined) clearTimeout(state.timer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code: state.code, signal: state.signal })
    }
    const arm = () => {
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = setTimeout(finish, EXIT_STDIO_GRACE_MS)
    }
    const ended = () => {
      if (state.exited && state.stdoutEnded && state.stderrEnded) finish()
    }
    child.stdout?.once("end", () => {
      state.stdoutEnded = true
      ended()
    })
    child.stderr?.once("end", () => {
      state.stderrEnded = true
      ended()
    })
    const onData = () => {
      if (state.exited && !state.settled) arm()
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", (error) => {
      if (state.settled) return
      state.settled = true
      reject(error)
    })
    child.once("exit", (code, signal) => {
      state.exited = true
      state.code = code
      state.signal = signal
      ended()
      if (!state.settled) arm()
    })
    child.once("close", (code, signal) => {
      state.code = state.exited ? state.code : code
      state.signal = state.exited ? state.signal : signal
      finish()
    })
  })
}
