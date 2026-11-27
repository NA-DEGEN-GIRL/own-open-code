// Demo worlds (PLAN.md §4.2): each boots a backend from packages/own-web (fake providers, fake accounts, temp folders
// under TEMP), waits for its ready line, and stops it again (stdin closed: the graceful stop; then the process tree).
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { REPO } from "./browser"
import { mappings, type Mapping, type WorldPaths } from "./privacy"

const WEB = path.join(REPO, "packages/own-web")

export interface World<State> {
  readonly state: State
  readonly pairs: ReadonlyArray<Mapping>
  stop(): Promise<void>
}

export interface Boot {
  /** The script, relative to packages/own-web. */
  readonly script: string
  readonly env: Readonly<Record<string, string>>
  /** The ready line's prefix; the JSON after it is the state (or `file` is read once it shows). */
  readonly ready: string
  readonly file?: string
  readonly timeoutMs?: number
}

/** Starts `boot.script` and resolves with its state once the ready line shows. */
export async function start<State>(name: string, boot: Boot, paths: (state: State) => WorldPaths): Promise<World<State>> {
  const log = path.join(os.tmpdir(), `manual-${name}.log`)
  const sink = Bun.file(log).writer()
  const child = Bun.spawn(["bun", boot.script], {
    cwd: WEB,
    env: { ...process.env, ...boot.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const lines: string[] = []
  const found = Promise.withResolvers<string>()
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    let rest = ""
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      sink.write(text)
      rest += text
      const parts = rest.split(/\r?\n/)
      rest = parts.pop() ?? ""
      for (const line of parts) {
        lines.push(line)
        if (line.startsWith(boot.ready)) found.resolve(line.slice(boot.ready.length).trim())
      }
    }
  }
  void pump(child.stdout)
  void pump(child.stderr)
  void child.exited.then((code) => found.reject(new Error(`${name}: backend exited (${code}) before it was ready; see ${log}`)))
  const timer = setTimeout(
    () => found.reject(new Error(`${name}: not ready after ${(boot.timeoutMs ?? 600_000) / 1000} s; see ${log}`)),
    boot.timeoutMs ?? 600_000,
  )
  const stop = async () => {
    await Promise.resolve(child.stdin.end()).catch(() => undefined)
    // The remote world's fake hosts run detached services that only its own stop ends: on a busy PC that takes minutes.
    const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(300_000).then(() => false)])
    if (!ended) await kill(child.pid)
    await sink.end()
  }
  const line = await found.promise.catch(async (error: unknown) => {
    clearTimeout(timer)
    await kill(child.pid)
    throw error
  })
  clearTimeout(timer)
  const state = (boot.file ? await Bun.file(boot.file).json() : JSON.parse(line)) as State
  return { state, pairs: mappings(paths(state)), stop }
}

async function kill(pid: number) {
  if (process.platform !== "win32") return void process.kill(pid, "SIGKILL")
  await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
}

/** Reads a running world's state file (`--attach`), for iterating on shots without a new boot. */
export async function attach<State>(file: string, paths: (state: State) => WorldPaths): Promise<World<State>> {
  const state = (await Bun.file(file).json()) as State
  return { state, pairs: mappings(paths(state)), stop: async () => undefined }
}

/**
 * The temp folder own-web's remote and gateway e2e backends keep their state in: `<tmp>/<name>-<short hash of this
 * checkout's real path>` (packages/own-web/e2e/gateway/support.ts `checkoutTmp`, which Bun spells the same way).
 */
export function checkoutTmp(name: string) {
  const root = fs.realpathSync.native(REPO)
  return path.join(os.tmpdir(), `${name}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`)
}
