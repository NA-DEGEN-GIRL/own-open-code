// Ports Pi's shell resolution (packages/coding-agent/src/utils/shell.ts `getShellConfig`, `killProcessTree`) and its
// local command execution (core/tools/bash.ts `createLocalShellOperations`, utils/child-process.ts
// `waitForChildProcess`). On Windows Pi's `bash` tool runs Git Bash (Program Files, then bash.exe on PATH); PowerShell
// is a separate tool Pi leaves off by default, so the pi harness does the same. Node's child_process is kept (not
// Bun.spawn) because the port relies on its exit/close events and signal codes exactly as Pi does. Pi 1.4.0's fixes are
// in: shells are checked with access(F_OK) so Windows Store aliases pass (28bea006b), the legacy WSL launcher is found
// under %SystemRoot% (61060ddf8) and macOS stops the process group before killing it (27cc6bfc0, #11252). Pi's lookup
// of PowerShell in its installation folders is left out together with the PowerShell tool. Pi 1.5.1's timeout tells
// when the shell had already exited and only background processes kept the pipes open (06aa6563e, #11613).
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiShell from "./shell.js"

import { spawn, type ChildProcess } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { access } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import path from "node:path"

export interface Config {
  readonly shell: string
  readonly args: ReadonlyArray<string>
  /** The legacy WSL `bash.exe` takes the command on stdin. */
  readonly stdin: boolean
}

const MAX_TIMEOUT_MS = 2_147_483_647
/** After exit, wait this long for the pipes to fall idle (re-armed on every chunk). */
const EXIT_STDIO_GRACE_MS = 100

/** `getShellConfig()`: Git Bash on Windows, `/bin/bash`, bash on PATH, else `sh`. */
export function bashConfig(): Config {
  if (process.platform === "win32") {
    const candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].flatMap((root) =>
      root === undefined ? [] : [`${root}\\Git\\bin\\bash.exe`],
    )
    const known = candidates.find((candidate) => pathExists(candidate))
    if (known !== undefined) return config(known)
    const onPath = findOnPath("bash.exe")
    if (onPath !== undefined) return config(onPath)
    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n\n` +
        `Searched Git Bash in:\n${candidates.map((candidate) => `  ${candidate}`).join("\n")}`,
    )
  }
  if (pathExists("/bin/bash")) return config("/bin/bash")
  const onPath = findOnPath("bash")
  if (onPath !== undefined) return config(onPath)
  return { shell: "sh", args: ["-c"], stdin: false }
}

/**
 * own's guideline for Pi's prompt on Windows (not Pi's text; 12 §3.6, decisions SA-3): which shell `bash` runs.
 * Pi's prompt never names it, while AGENTS.md files and the user often speak of PowerShell, the shell of core's other
 * harnesses there; a model then sends PowerShell cmdlets to Git Bash. Empty elsewhere, and when no bash is found (the
 * tool then fails with Pi's own error).
 */
export function windowsGuidelines(platform: NodeJS.Platform = process.platform, find: () => Config = bashConfig) {
  if (platform !== "win32") return []
  const found = attempt(find)
  if (found === undefined) return []
  const name = /[\\/]git[\\/]/i.test(found.shell) ? "Git Bash" : found.stdin ? "WSL's bash" : `bash (${found.shell})`
  return [
    `On Windows the bash tool runs ${name}, not PowerShell: use bash syntax and POSIX commands (ls, cat, rg); PowerShell cmdlets such as Get-ChildItem do not work in it`,
  ]
}

function attempt<A>(run: () => A) {
  try {
    return run()
  } catch {
    return undefined
  }
}

/** `resolveTimeoutMs`: seconds to milliseconds; a bad timeout fails the call. */
export function timeoutMs(timeout: number | undefined) {
  if (timeout === undefined) return undefined
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds")
  const ms = timeout * 1000
  if (ms > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`)
  return ms
}

/**
 * `ShellTimeoutError`: the timeout of a command, its message in the `timeout:<seconds>` form. `shellExit` is set when the
 * shell itself exited before the deadline, so the command was only still waiting because background processes kept
 * writing to the inherited stdout and stderr pipes (#11613).
 */
export class TimeoutError extends Error {
  constructor(
    timeout: number | undefined,
    readonly shellExit: { readonly exitCode: number; readonly afterSeconds: number } | undefined,
  ) {
    super(`timeout:${timeout}`)
  }
}

/**
 * Runs `command` in `cwd` and streams its output. Fails with `aborted` when `signal` aborts and a {@link TimeoutError}
 * when the timeout ends it (both kill the whole process tree). A signal-killed shell answers 128 + the signal number.
 */
export async function run(
  command: string,
  cwd: string,
  options: {
    readonly onData: (data: Buffer) => void
    readonly signal?: AbortSignal
    readonly timeout?: number
    readonly env?: NodeJS.ProcessEnv
    readonly shell?: Config
    /** The shell's process id, once spawned (the GitHub login's holder, 16 §8.6). */
    readonly onSpawn?: (pid: number | undefined) => void
  },
) {
  const ms = timeoutMs(options.timeout)
  if (options.signal?.aborted) throw new Error("aborted")
  const shell = options.shell ?? bashConfig()
  const reachable = await access(cwd, constants.F_OK).then(
    () => true,
    () => false,
  )
  if (!reachable) throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
  const child = spawn(shell.shell, shell.stdin ? [...shell.args] : [...shell.args, command], {
    cwd,
    detached: process.platform !== "win32",
    env: options.env ?? process.env,
    stdio: [shell.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  options.onSpawn?.(child.pid)
  if (shell.stdin) {
    child.stdin?.on("error", () => {})
    child.stdin?.end(command)
  }
  const startedAt = performance.now()
  const state = {
    timedOut: false,
    shellExitedAfterMs: undefined as number | undefined,
    exitedBeforeDeadlineAfterMs: undefined as number | undefined,
  }
  child.once("exit", () => {
    state.shellExitedAfterMs = performance.now() - startedAt
  })
  const kill = () => {
    if (child.pid !== undefined) killProcessTree(child.pid)
  }
  const timer =
    ms === undefined
      ? undefined
      : setTimeout(() => {
          state.timedOut = true
          // Only an exit before the deadline: a starved event loop can run this callback after an exit that came
          // later, which Pi reports as "exited after 3.2 seconds" for a 3 second timeout (seen live on this PC, where
          // Git Bash took 2–3 s to start under load).
          state.exitedBeforeDeadlineAfterMs =
            state.shellExitedAfterMs !== undefined && state.shellExitedAfterMs < ms
              ? state.shellExitedAfterMs
              : undefined
          // Also when the shell already exited: on Unix the group kill still reaches background processes holding the
          // pipes. Windows cannot find them once the shell pid is gone, so the wait lasts until their output pauses.
          kill()
        }, ms)
  child.stdout?.on("data", options.onData)
  child.stderr?.on("data", options.onData)
  if (options.signal?.aborted) kill()
  options.signal?.addEventListener("abort", kill, { once: true })
  const exitCode = await waitForChildProcess(child).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener("abort", kill)
  })
  if (options.signal?.aborted) throw new Error("aborted")
  const signalCode = child.signalCode
  const resolved =
    exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode as keyof typeof osConstants.signals] ?? 0) : 1)
  if (state.timedOut)
    throw new TimeoutError(
      options.timeout,
      state.exitedBeforeDeadlineAfterMs === undefined
        ? undefined
        : { exitCode: resolved, afterSeconds: Math.round(state.exitedBeforeDeadlineAfterMs / 100) / 10 },
    )
  return { exitCode: resolved }
}

/** Kills a process and its children: `taskkill /F /T` on Windows, the process group elsewhere. */
export function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    const child = spawn(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/F", "/T", "/PID", String(pid)],
      {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      },
    )
    child.once("error", () => {})
    return
  }
  // macOS signals a group's members one by one, so a killed child can wake its waiting shell before the shell is
  // signalled and `a; b` would start b (#11252): stop the group first. Best effort; SIGKILL also kills stopped processes.
  if (process.platform === "darwin") signal(-pid, "SIGSTOP")
  // The group first; the process alone when the group is already gone.
  if (!signal(-pid, "SIGKILL")) signal(pid, "SIGKILL")
}

/**
 * `shellPathExists`: access(F_OK) rather than `existsSync`, whose extra stat on Windows can reject a runnable Store
 * alias in Node (nodejs/node#36790). On Unix both are the same call.
 */
export function pathExists(file: string) {
  try {
    accessSync(file, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** `getBashShellConfig`: the legacy WSL launcher reads the command from stdin (`-s`). */
export function config(shell: string): Config {
  return legacyWsl(shell) ? { shell, args: ["-s"], stdin: true } : { shell, args: ["-c"], stdin: false }
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

/**
 * `isLegacyWslBashPath`: `bash.exe` in System32 or Sysnative under %SystemRoot% (a relative one matches nothing), or
 * under a conventional `X:\Windows` only when %SystemRoot% is unset.
 */
function legacyWsl(shell: string) {
  const normalized = path.win32.normalize(shell).toLowerCase()
  const root = process.env.SystemRoot
  if (!root) return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
  if (!/^[a-z]:[\\/]/i.test(root)) return false
  return ["System32", "Sysnative"].some(
    (folder) => normalized === path.win32.join(root, folder, "bash.exe").toLowerCase(),
  )
}

/** The first existing match of `where`/`which`, on the PATH as it is now (Bun's default is the PATH at start-up). */
function findOnPath(executable: string) {
  const found = Bun.spawnSync(process.platform === "win32" ? ["where", executable] : ["which", executable], {
    env: process.env,
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  if (found.exitCode !== 0) return undefined
  const first = found.stdout.toString().trim().split(/\r?\n/)[0]
  if (!first) return undefined
  return process.platform !== "win32" || pathExists(first) ? first : undefined
}

/**
 * `waitForChildProcess`: resolves with the exit code once both pipes end after exit, or once they fall idle for
 * {@link EXIT_STDIO_GRACE_MS} (a daemonized descendant can hold them open), so trailing output is never cut.
 */
function waitForChildProcess(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    const state = {
      settled: false,
      exited: false,
      exitCode: null as number | null,
      stdoutEnded: child.stdout === null,
      stderrEnded: child.stderr === null,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    const finalize = (code: number | null) => {
      if (state.settled) return
      state.settled = true
      if (state.timer !== undefined) clearTimeout(state.timer)
      child.stdout?.removeListener("data", onData)
      child.stderr?.removeListener("data", onData)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(code)
    }
    const arm = () => {
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = setTimeout(() => finalize(state.exitCode), EXIT_STDIO_GRACE_MS)
    }
    const afterExit = () => {
      if (state.exited && !state.settled && state.stdoutEnded && state.stderrEnded) finalize(state.exitCode)
    }
    const onData = () => {
      if (state.exited && !state.settled) arm()
    }
    child.stdout?.once("end", () => {
      state.stdoutEnded = true
      afterExit()
    })
    child.stderr?.once("end", () => {
      state.stderrEnded = true
      afterExit()
    })
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("error", (error) => {
      if (state.settled) return
      state.settled = true
      reject(error)
    })
    child.once("exit", (code) => {
      state.exited = true
      state.exitCode = code
      afterExit()
      if (!state.settled) arm()
    })
    child.once("close", (code) => finalize(code))
  })
}
