// Runs one fixed command through `POST /api/shell` (`shell.create`) in a folder and returns its exit and output
// (01 §17.1 #18). The command is the exact line the confirmation showed; nothing is added to it. Files the command
// reads (a commit message, a patch, a pathspec list) are written first into the server's temp folder
// (`POST /api/experimental/fs/write`, like attachment uploads, 18.10).
//
// Completion comes from the `shell.exited` event (no polling, R9); a reconnect re-checks with `shell.get`. The shell
// record and its captured output are removed afterwards. The metadata carries no `sessionID`, so the session's
// background list and its "끝났습니다" toast (19.7) never count these commands.
import type { ServerRuntime } from "@/data"
import type { TempWrite } from "./commands"

export interface RunResult {
  readonly status: "exited" | "timeout" | "killed"
  readonly exit?: number
  readonly output: string
  /** The shell the server used (`Shell.Info.shell`), for quoting later commands. */
  readonly shell: string
}

/** Output kept per command; git prints far less for these commands. */
const OUTPUT_LIMIT = 256 * 1024

export async function runCommand(
  runtime: ServerRuntime,
  input: { readonly directory: string; readonly command: string; readonly timeoutMs: number; readonly label: string },
): Promise<RunResult> {
  const client = runtime.client()
  const location = { directory: input.directory }
  // Registered before the create call: the exit event of a fast command may arrive before its response.
  const exits = new Map<string, { readonly status: string; readonly exit?: number }>()
  const waiters = new Map<string, () => void>()
  const offs = [
    runtime.bus.on("shell.exited", (event) => {
      exits.set(event.data.id, { status: event.data.status, exit: event.data.exit })
      waiters.get(event.data.id)?.()
    }),
  ]
  try {
    const created = await client.shell.create({
      location,
      command: input.command,
      timeout: input.timeoutMs,
      metadata: { "own.git": input.label },
    })
    const id = created.data.id
    const done = new Promise<void>((resolve) => {
      if (created.data.status !== "running" || exits.has(id)) return resolve()
      waiters.set(id, resolve)
      // After a reconnect the event may have been missed: ask once.
      offs.push(
        runtime.bus.on("server.connected", () => {
          void client.shell
            .get({ id, location })
            .then((info) => {
              if (info.data.status === "running") return
              exits.set(id, { status: info.data.status, exit: info.data.exit })
              resolve()
            })
            .catch(() => undefined)
        }),
      )
    })
    await done
    const final = exits.get(id) ?? { status: created.data.status, exit: created.data.exit }
    const output = await client.shell
      .output({ id, location, cursor: 0, limit: OUTPUT_LIMIT })
      .then((result) => result.data.output)
      .catch(() => "")
    void client.shell.remove({ id, location }).catch(() => undefined)
    return {
      status: final.status === "timeout" || final.status === "killed" ? final.status : "exited",
      exit: final.exit,
      output,
      shell: created.data.shell,
    }
  } finally {
    offs.forEach((off) => off())
  }
}

export function succeeded(result: RunResult) {
  return result.status === "exited" && result.exit === 0
}

const tmpByRuntime = new WeakMap<ServerRuntime, Promise<string>>()

/** `paths.tmp` of the server (`GET /api/info`), once per runtime; a failure is retried next time. */
export function serverTmp(runtime: ServerRuntime) {
  const cached = tmpByRuntime.get(runtime)
  if (cached) return cached
  const request = runtime
    .client()
    .server.info()
    .then((info) => info.paths.tmp.replaceAll("\\", "/").replace(/\/+$/, ""))
  tmpByRuntime.set(runtime, request)
  request.catch(() => tmpByRuntime.delete(runtime))
  return request
}

/** A fresh temp file path under `<tmp>/own-git/`, forward slashes (git and every shell accept them). */
export function tempPath(tmp: string, name: string) {
  return `${tmp}/own-git/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${name}`
}

export async function writeTemps(runtime: ServerRuntime, directory: string, writes: readonly TempWrite[]) {
  const encoder = new TextEncoder()
  for (const write of writes)
    await runtime.client().file.write({
      location: { directory },
      path: write.path,
      payload: encoder.encode(write.content),
    })
}
