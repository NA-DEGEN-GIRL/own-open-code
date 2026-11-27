export * as ProcessTree from "./process-tree.js"

import path from "node:path"

/**
 * Ends a child process together with everything it started (P1-14a). Bun's `signal` and `kill()` end only the direct
 * child: a `cmd.exe /d /s /c "bun run build"` that is stopped leaves the build running, holding files in the folder and
 * the log's handle. Children spawned with {@link SPAWN} and waited for with {@link exited} end as a whole instead:
 *
 *   Windows  `taskkill /pid <pid> /T /F` (hidden), while the root still runs: `/T` follows parent ids from the root, so
 *            descendants of a root that already ended are out of reach (a Job object would cover them, P1-14)
 *   POSIX    the child leads its own process group (`detached`), and `SIGKILL` goes to the whole group, which the
 *            descendants keep alive after the root is gone
 */

/** Spawn options of a child whose tree may be ended: its own process group on POSIX, no console window on Windows. */
export const SPAWN = { detached: process.platform !== "win32", windowsHide: true } as const

/** What ended the tree in {@link exited}: the caller's signal or the time limit. */
export type Stop = "signal" | "timeout"

/** The parts of a `Bun.Subprocess` this module uses, whatever its stdio. */
type Child = Pick<Bun.Subprocess, "pid" | "exitCode" | "signalCode" | "exited" | "kill">

/**
 * Waits for `child` to exit, ending its whole tree when `signal` aborts (also when it already has) or after
 * `timeoutMs`. Resolves after the tree was ended, with the exit code and the {@link Stop} that ended it, if any.
 */
export async function exited(
  child: Child,
  limits: { readonly signal?: AbortSignal | undefined; readonly timeoutMs: number },
) {
  const ended: { stop?: Stop; killed?: Promise<void> } = {}
  const end = (stop: Stop) => {
    if (ended.stop !== undefined) return
    ended.stop = stop
    ended.killed = kill(child)
  }
  const aborted = () => end("signal")
  const timer = setTimeout(() => end("timeout"), limits.timeoutMs)
  limits.signal?.addEventListener("abort", aborted, { once: true })
  if (limits.signal?.aborted) aborted()
  const code = await child.exited
  clearTimeout(timer)
  limits.signal?.removeEventListener("abort", aborted)
  await ended.killed
  return { code, stop: ended.stop }
}

/**
 * Ends `child` and its descendants (see the module comment). When the tree kill cannot run or fails, the direct child
 * is still killed. Never throws.
 */
export async function kill(child: Child) {
  if (process.platform !== "win32") {
    // The group outlives its leader while a member runs, and its id is not reused meanwhile. Without a group (not
    // spawned with `SPAWN`, or already empty) this throws ESRCH.
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
    return
  }
  // A pid of a root that already ended may belong to another process by now.
  if (child.exitCode !== null || child.signalCode !== null) return
  // The full path, so no other `taskkill` in the working folder or on PATH runs instead.
  const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")
  const code = await Promise.resolve()
    .then(
      () =>
        Bun.spawn([taskkill, "/pid", String(child.pid), "/T", "/F"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        }).exited,
    )
    .catch(() => null)
  if (code !== 0) child.kill()
}
