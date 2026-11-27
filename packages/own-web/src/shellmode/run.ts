// Running `!` commands (03 §19.9, `POST /api/session/:id/shell`). The server runs the command in the session's folder,
// records it and its output in the session (a shell message, then a notice the model reads on its next step) and does
// not wake the agent (core `Session.shell`: `resume: false`). The request returns when the command ends, so the UI
// shows what is running from the durable `session.shell.started/ended` events — also commands another window started —
// plus the local request until its `started` event arrives.
import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerRuntime } from "@/data"

export interface ShellRun {
  /** `sh_…` once the server started it; a local id before. */
  readonly id: string
  readonly command: string
  readonly startedAt: number
}

export type ShellRunResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown }

export interface ShellRuns {
  /** Commands running in a session, oldest first. */
  list(sessionID: string): readonly ShellRun[]
  /** Runs one command; resolves when the server answered (the command ended or failed to start). */
  run(sessionID: string, command: string): Promise<ShellRunResult>
  dispose(): void
}

const trackers = new WeakMap<ServerRuntime, ShellRuns>()

/** One tracker per server runtime (event subscriptions live as long as the runtime). */
export function shellRuns(runtime: ServerRuntime): ShellRuns {
  const known = trackers.get(runtime)
  if (known) return known
  const created = createShellRuns(runtime)
  trackers.set(runtime, created)
  return created
}

export function createShellRuns(
  runtime: Pick<ServerRuntime, "bus" | "client">,
  now: () => number = Date.now,
): ShellRuns {
  return createRoot((dispose) => {
    const [state, setState] = createStore<{ runs: Record<string, ShellRun[] | undefined> }>({ runs: {} })
    let sequence = 0

    const add = (sessionID: string, run: ShellRun) => setState("runs", sessionID, (list) => [...(list ?? []), run])
    const drop = (sessionID: string, match: (run: ShellRun) => boolean) =>
      setState(
        "runs",
        sessionID,
        produce((list) => {
          const index = list?.findIndex(match) ?? -1
          if (list && index >= 0) list.splice(index, 1)
        }),
      )

    const offStarted = runtime.bus.on("session.shell.started", (event) => {
      const sessionID = event.data.sessionID
      const info = event.data.shell
      if (state.runs[sessionID]?.some((run) => run.id === info.id)) return
      // The local placeholder of the same command becomes the server's run.
      drop(sessionID, (run) => run.id.startsWith("local:") && run.command === info.command)
      add(sessionID, { id: info.id, command: info.command, startedAt: info.time.started })
    })
    const offEnded = runtime.bus.on("session.shell.ended", (event) =>
      drop(event.data.sessionID, (run) => run.id === event.data.shell.id),
    )

    return {
      list: (sessionID) => state.runs[sessionID] ?? [],
      async run(sessionID, command) {
        const id = `local:${++sequence}`
        add(sessionID, { id, command, startedAt: now() })
        try {
          await runtime.client().session.shell({ sessionID, command })
          return { ok: true }
        } catch (error) {
          return { ok: false, error }
        } finally {
          // The ended event normally removed the server's run already; the placeholder may still be here when the
          // `started` event never came (a failure to start, or events lagging behind the response).
          drop(sessionID, (run) => run.id === id)
        }
      },
      dispose() {
        offStarted()
        offEnded()
        dispose()
      },
    }
  })
}
