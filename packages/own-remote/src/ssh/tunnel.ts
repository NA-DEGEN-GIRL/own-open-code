export * as Tunnel from "./tunnel.js"

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Fsx, Lock } from "@own/runtime"

/**
 * The long-lived tunnel process of a host (04 §7.1): one `ssh.exe` with `-L` (API) and `-R` (broker), whose remote
 * command `sh -s` receives ensure + keep on stdin. stdin stays open for the life of the tunnel; closing it (or this
 * process dying, which closes the pipe) ends the remote keep part, which ends the session.
 *
 * Spawned with node:child_process in the process-lifetime controller, never in a Location scope (04 §4.1).
 */
export interface StartInput {
  readonly command: readonly string[]
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** ensure + keep text (LF). */
  readonly script: string
  /** How long to wait for the `OWN_ENSURE=` line while no prompt is open. */
  readonly timeoutMs: number
  readonly authenticating: () => boolean
  readonly signal?: AbortSignal
  /** `OWN_HOME\remote\<hostId>\tunnel.pid` (04 §4.1 orphan cleanup). */
  readonly pidFile?: string
}

export type StartResult =
  | { readonly ok: true; readonly tunnel: Handle; readonly output: string }
  | { readonly ok: false; readonly reason: "exited" | "timeout" | "aborted" | "spawn"; readonly stderr: string; readonly code: number | null }

export interface Handle {
  readonly pid: number | undefined
  /** Resolves when the ssh process ends. */
  readonly exited: Promise<{ readonly code: number | null; readonly stderr: string }>
  /** Lines the remote printed after the ensure result (e.g. `OWN_KEEP=superseded`). */
  readonly after: () => string
  stderr(): string
  /** Ends stdin (keep sees EOF), then kills after `graceMs`. */
  close(graceMs?: number): Promise<void>
}

const STDERR_MAX = 16_384
const STDOUT_MAX = 1_048_576

export function start(input: StartInput): Promise<StartResult> {
  const [executable, ...prefix] = input.command
  if (!executable) return Promise.resolve({ ok: false, reason: "spawn", stderr: "no ssh command", code: null })
  let child: ChildProcess
  try {
    child = spawn(executable, [...prefix, ...input.args], {
      env: { ...input.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (error) {
    return Promise.resolve({ ok: false, reason: "spawn", stderr: String(error), code: null })
  }
  const startedAt = Date.now()
  const state = { stdout: "", stderr: "", after: "", resolved: false }
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    // ssh's last words (`Timeout, server … not responding.`, an auth refusal) can still be in the pipe when the exit
    // event comes: wait for the streams to close, at most half a second (a ProxyCommand child may hold them longer).
    child.once("exit", (code) => {
      const done = () => resolve({ code, stderr: state.stderr })
      const timer = setTimeout(done, 500)
      child.once("close", () => {
        clearTimeout(timer)
        done()
      })
    })
    child.once("error", (error) => {
      state.stderr = (state.stderr + String(error)).slice(-STDERR_MAX)
      resolve({ code: null, stderr: state.stderr })
    })
  })
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (text: string) => {
    state.stderr = (state.stderr + text).slice(-STDERR_MAX)
  })
  child.stdin?.on("error", () => {})
  child.stdin?.write(input.script)

  if (input.pidFile && child.pid !== undefined)
    void Fsx.writeAtomic(input.pidFile, JSON.stringify({ pid: child.pid, startedAt, exe: executable }) + "\n").catch(
      () => {},
    )

  const handle: Handle = {
    pid: child.pid,
    exited,
    after: () => state.after,
    stderr: () => state.stderr,
    close: async (graceMs = 3000) => {
      child.stdin?.end()
      const timer = setTimeout(() => child.kill(), graceMs)
      await exited
      clearTimeout(timer)
      if (input.pidFile) await Fsx.remove(input.pidFile).catch(() => {})
    },
  }

  return new Promise<StartResult>((resolve) => {
    const finish = (result: StartResult) => {
      if (state.resolved) return
      state.resolved = true
      clearInterval(timer)
      input.signal?.removeEventListener("abort", abort)
      resolve(result)
    }
    let deadline = Date.now() + input.timeoutMs
    const timer = setInterval(() => {
      if (input.authenticating()) deadline = Date.now() + input.timeoutMs
      if (Date.now() < deadline) return
      void handle.close(0)
      finish({ ok: false, reason: "timeout", stderr: state.stderr, code: null })
    }, 200)
    const abort = () => {
      void handle.close(500)
      finish({ ok: false, reason: "aborted", stderr: state.stderr, code: null })
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted) abort()
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (text: string) => {
      if (state.resolved) {
        state.after = (state.after + text).slice(-65_536)
        return
      }
      state.stdout = (state.stdout + text).slice(-STDOUT_MAX)
      const lines = state.stdout.split(/\r?\n/)
      if (lines.slice(0, -1).some((line) => line.startsWith("OWN_ENSURE="))) {
        const end = state.stdout.lastIndexOf("OWN_ENSURE=")
        const newline = state.stdout.indexOf("\n", end)
        state.after = newline >= 0 ? state.stdout.slice(newline + 1) : ""
        finish({ ok: true, tunnel: handle, output: state.stdout.slice(0, newline >= 0 ? newline + 1 : undefined) })
      }
    })
    void exited.then(({ code }) =>
      finish({ ok: false, reason: "exited", stderr: state.stderr, code }),
    )
  })
}

/**
 * Leftover tunnel of a previous service instance (04 §4.1): killed only when the recorded pid is alive AND is the same
 * executable AND started at the recorded time (±5 s), so a reused pid is never touched. Windows only; elsewhere the
 * remote keep part ends the session on stdin EOF anyway.
 */
export async function cleanupOrphan(pidFile: string) {
  const text = await Fsx.readText(pidFile).catch(() => undefined)
  if (!text) return "none" as const
  const record = safeParse(text)
  await Fsx.remove(pidFile).catch(() => {})
  if (!record || !Lock.isAlive(record.pid)) return "gone" as const
  if (process.platform !== "win32") return "kept" as const
  const info = await processInfo(record.pid)
  if (!info) return "kept" as const
  const sameExe = path.resolve(info.path).toLowerCase() === path.resolve(record.exe).toLowerCase()
  if (!sameExe || Math.abs(info.startedAt - record.startedAt) > 5000) return "kept" as const
  try {
    process.kill(record.pid)
    return "killed" as const
  } catch {
    return "kept" as const
  }
}

function safeParse(text: string): { pid: number; startedAt: number; exe: string } | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (typeof value.pid !== "number" || typeof value.startedAt !== "number" || typeof value.exe !== "string")
      return undefined
    return { pid: value.pid, startedAt: value.startedAt, exe: value.exe }
  } catch {
    return undefined
  }
}

function processInfo(pid: number): Promise<{ path: string; startedAt: number } | undefined> {
  return new Promise((resolve) => {
    const script = `$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue; if ($p) { '{0}|{1}' -f $p.Path, ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    let out = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (text: string) => (out += text))
    const timer = setTimeout(() => child.kill(), 5000)
    child.once("error", () => resolve(undefined))
    child.once("exit", () => {
      clearTimeout(timer)
      const [exe, started] = out.trim().split("|")
      const startedAt = Number(started)
      resolve(exe && Number.isFinite(startedAt) ? { path: exe, startedAt } : undefined)
    })
  })
}

export async function removePidFile(pidFile: string) {
  await fs.rm(pidFile, { force: true }).catch(() => {})
}
