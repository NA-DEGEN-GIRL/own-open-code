// The shell's only way to start, restart or stop the service: `own.ps1` (01 §5.3, 05 §5.3 step 4, §5.6, §7.3). The
// launcher does env hygiene, the env bridge and `service start` / `service stop`; the shell hands it the untouched env
// snapshot (05 §5.2).
//
// powershell.exe is spawned directly with the flags own.cmd uses (own/launcher/own.cmd:4), not own.cmd: Node refuses
// to spawn .cmd/.bat without shell:true since the batch-argument fix, and a cmd.exe command line brings quoting back.
// stdin is a closed pipe, so the launcher is non-interactive and fails closed where it would ask (own.ps1 Confirm-Stop).
// The one variable added to the snapshot, OWN_LAUNCHER_CLIENT=desktop, tells the launcher not to wake the remote
// access gateway: this shell waits for the run, and its first control RPC sets up own.remote, which starts the gateway.
import { spawn } from "node:child_process"
import path from "node:path"
import type { OwnOpenInBrowserResult, OwnServiceRestartInput, OwnServiceRestartResult } from "../../preload/own-api"
import { envSnapshot, type OwnPaths } from "../own-env"

export const START_TIMEOUT_MS = 60_000
export const RESTART_TIMEOUT_MS = 90_000
/** `own stop --force` (05 §7.3 완전 종료): `opencode service stop` waits up to about 10 s for the process to end. */
export const STOP_TIMEOUT_MS = 60_000
/** 05 §5.7: launcher exit code for "sessions are running and --force was not given". */
export const EXIT_SESSION_RUNNING = 4
const TAIL_BYTES = 4096

export interface LauncherResult {
  readonly code: number | null
  readonly timedOut: boolean
  /** Last 4 KiB of stderr. The launcher prints variable names, never values (own.ps1 Set-OwnEnvironment). */
  readonly stderr: string
  readonly stdout: string
}

export interface LauncherCommand {
  readonly file: string
  readonly args: readonly string[]
}

let queue: Promise<unknown> = Promise.resolve()
let held = false

/**
 * 완전 종료 (05 §7.3) stops the service on the shell's way out. Its windows see the connection drop and reconnect, and a
 * reconnect that finds no service would start it again (5.3 step 4); while held, BackgroundServiceOwn starts nothing.
 */
export function holdStarts(on: boolean) {
  held = on
}

export function startsHeld() {
  return held
}

/**
 * One launcher run at a time in this shell: a reconnect that finds no service while `own:service.restart` is still
 * bringing it back waits for that run and then looks again, instead of starting a second launcher (G-D1: one start).
 */
export function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

export function powershellPath(env: Readonly<Record<string, string | undefined>> = envSnapshot) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows"
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

export function launcherCommand(
  paths: Pick<OwnPaths, "launcher">,
  command: "start" | "restart" | "open" | "stop",
  args: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = envSnapshot,
): LauncherCommand {
  return {
    file: powershellPath(env),
    args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", paths.launcher, command, ...args],
  }
}

export function runLauncher(
  command: LauncherCommand,
  options: { readonly timeoutMs: number; readonly env?: Readonly<Record<string, string>> },
): Promise<LauncherResult> {
  return new Promise((resolve) => {
    const child = spawn(command.file, [...command.args], {
      shell: false,
      windowsHide: true,
      env: { ...(options.env ?? envSnapshot), OWN_LAUNCHER_CLIENT: "desktop" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdin?.end()
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk
    })
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-TAIL_BYTES)
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs)
    const finish = (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, timedOut, stderr: stderr.trim(), stdout: stdout.trim() })
    }
    child.once("error", (error) => {
      stderr = `${stderr}\n${error.message}`.slice(-TAIL_BYTES)
      finish(null)
    })
    child.once("close", (code) => finish(code))
  })
}

export type RestartArgs = { readonly ok: true; readonly args: string[] } | { readonly ok: false; readonly detail: string }

/**
 * `own restart [--force] [--claude-config-dir <dir>]` arguments (05 §5.6). The directory is re-checked here: absolute,
 * no control characters, at most 1,024 characters, an existing directory. Arguments stay an array (no shell string).
 */
export function restartArgs(
  input: OwnServiceRestartInput,
  isDirectory: (value: string) => boolean,
): RestartArgs {
  const args: string[] = []
  if (input.force) args.push("--force")
  const dir = input.claudeConfigDir
  if (dir !== undefined) {
    if (typeof dir !== "string" || dir.length === 0 || dir.length > 1024 || /[\u0000-\u001f\u007f]/.test(dir))
      return { ok: false, detail: "claudeConfigDir is not a valid path" }
    if (!path.win32.isAbsolute(dir) && !path.isAbsolute(dir))
      return { ok: false, detail: "claudeConfigDir must be absolute" }
    if (!isDirectory(dir)) return { ok: false, detail: "claudeConfigDir is not an existing directory" }
    args.push("--claude-config-dir", dir)
  }
  return { ok: true, args }
}

/** Launcher exit → restart result. Exit 4 is the 05 §5.7 refusal (launchers before it exited 1 with the message). */
export function restartResult(result: LauncherResult): OwnServiceRestartResult {
  if (result.code === 0 && !result.timedOut) return { ok: true }
  if (sessionRunning(result)) return { ok: false, refused: "session_running" }
  return { ok: false, refused: "launcher_failed", detail: failureDetail(result) }
}

/** `own stop --force` exit → 완전 종료's answer (05 §7.3). The user already agreed, so exit 4 does not come back. */
export function stopResult(result: LauncherResult): OwnOpenInBrowserResult {
  if (result.code === 0 && !result.timedOut) return { ok: true }
  return { ok: false, detail: failureDetail(result) }
}

/** `own open --browser` exit → the mismatch screen's answer (05 §5.5). */
export function openInBrowserResult(result: LauncherResult): OwnOpenInBrowserResult {
  if (result.code === 0 && !result.timedOut) return { ok: true }
  if (sessionRunning(result))
    return {
      ok: false,
      detail: "다른 버전의 서비스가 대화를 실행 중이에요. 턴이 끝난 뒤 own restart를 실행하세요",
    }
  return { ok: false, detail: failureDetail(result) }
}

function sessionRunning(result: LauncherResult) {
  return !result.timedOut && (result.code === EXIT_SESSION_RUNNING || /session\(s\) are running/.test(result.stderr))
}

function failureDetail(result: LauncherResult) {
  const reason = result.timedOut
    ? "런처가 시간 안에 끝나지 않았어요"
    : `런처가 오류로 끝났어요(종료 코드 ${result.code ?? "?"})`
  return result.stderr ? `${reason}\n${result.stderr}` : reason
}
