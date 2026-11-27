// Ports the process side of codex-rs/core/src/unified_exec (process.rs output handles and
// process_manager.rs `collect_output_until_deadline`). Codex spawns into a PTY; here stdout and stderr are pipes merged
// into one stream, which is what Codex's non-TTY mode (`tty: false`, the default) gives the model too.
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as ExecProcess from "./process.js"

import { HeadTail } from "./buffer.js"

/** After the exit signal, wait at most this long for the pipes to close (`POST_EXIT_CLOSE_WAIT_CAP`). */
const POST_EXIT_CLOSE_WAIT_MS = 50

export interface Spawn {
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Keeps stdin open so `write_stdin` can write (Codex's `tty: true`). */
  readonly stdin: boolean
}

export class Process {
  private readonly proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">
  private pending = new HeadTail.Buffer()
  private waiters: Array<() => void> = []
  private open = 2
  private code: number | undefined
  readonly exited: Promise<void>
  readonly closed: Promise<void>
  lastUsed = Date.now()

  constructor(spawn: Spawn) {
    this.proc = Bun.spawn([...spawn.argv], {
      cwd: spawn.cwd,
      env: spawn.env,
      stdin: spawn.stdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      // Its own process group elsewhere, so `terminate` reaches the commands the shell started (Codex uses setsid).
      detached: process.platform !== "win32",
    })
    this.exited = this.proc.exited.then((code) => {
      this.code = code
      this.wake()
    })
    this.closed = Promise.all([this.read(this.proc.stdout), this.read(this.proc.stderr)]).then(() => undefined)
  }

  get pid() {
    return this.proc.pid
  }

  get hasExited() {
    return this.code !== undefined
  }

  get exitCode() {
    return this.code
  }

  get outputClosed() {
    return this.open === 0
  }

  /** Writes to stdin; false when the process does not take input. */
  write(text: string) {
    const stdin = this.proc.stdin
    if (stdin === undefined || typeof stdin === "number") return false
    stdin.write(text)
    stdin.flush()
    return true
  }

  /** Ends the process and its children (`taskkill /T /F` on Windows, the process group elsewhere). */
  terminate() {
    if (this.hasExited) return
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/pid", String(this.proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
      return
    }
    // The negative pid signals the whole group; the shell alone if the group is already gone.
    try {
      process.kill(-this.proc.pid, "SIGKILL")
    } catch {
      this.proc.kill("SIGKILL")
    }
  }

  /**
   * Drains output gathered since the last collection until the deadline or until the process exits and its pipes close.
   * `onOutput` sees each drained chunk as it arrives (the transcript's live view); the result is unaffected.
   */
  async collect(deadline: number, onOutput?: (chunk: Uint8Array) => void) {
    const collected = new HeadTail.Buffer()
    const state: { postExit?: number } = {}
    for (;;) {
      const drained = this.pending.take()
      if (drained.empty) {
        if (this.hasExited && this.outputClosed) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        if (this.hasExited) {
          state.postExit ??= Date.now() + Math.min(remaining, POST_EXIT_CLOSE_WAIT_MS)
          const wait = state.postExit - Date.now()
          if (wait <= 0) break
          await Promise.race([this.next(), this.closed, sleep(wait)])
          continue
        }
        await Promise.race([this.next(), this.exited, sleep(remaining)])
        continue
      }
      onOutput?.(drained.bytesWithOmissionMarker())
      collected.pushBuffer(drained)
      if (Date.now() >= deadline) break
    }
    this.lastUsed = Date.now()
    return collected
  }

  private next() {
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private wake() {
    const waiters = this.waiters
    this.waiters = []
    waiters.forEach((resolve) => resolve())
  }

  private async read(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      this.pending.push(next.value)
      this.wake()
    }
    this.open -= 1
    this.wake()
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
