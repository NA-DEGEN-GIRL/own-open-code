// `세션 폴더 없음` (03 §8; upstream 4fb800734d with the server's 404 `LocationNotFoundError`, 3e1aa1e58c): a session
// whose folder was deleted or moved away (a removed worktree, a renamed project folder) cannot run, and every send
// fails. Above the composer of a top-level session: the folder, what happened, and the ways on — `다른 폴더 고르기…`
// (the folder picker of 18.3 worded for it, then `session.move`) and, in a Git project, `작업 위치 고르기…` (the
// worktree move dialog: the project folder, another worktree or a new one made from the project's root, since the
// missing folder cannot resolve itself). A paired device sees the note only (moving is a PC action).
//
// Detection: the session's folder is resolved once per view and connection (`GET /api/location` through createData,
// deduped), and a send that fails with the typed 404 marks it too (`noteLocationError`, the composer). Only the typed
// 404 counts: a generic failure proves nothing about the folder. A move gives the session a new folder, which the
// next check clears.
import { createEffect, createMemo, createRoot, createSignal, on, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { isLocationMissing, useData, type ServerKey, type ServerRuntime } from "@/data"
import { baseName, openProject } from "@/projects"
import { showToast } from "@/switcher/toast"
import { canMoveSession, moveSession } from "./api"
import { openWorktreeMove } from "./host"
import { useWorktreeText } from "./strings"

const state = createRoot(() => {
  const [missing, setMissing] = createStore<Record<string, true | undefined>>({})
  return { missing, setMissing }
})
const keyOf = (serverKey: ServerKey, directory: string) => `${serverKey}\u0000${directory}`

/** The folder of this server is known to be missing (reactive). */
export function locationMissing(serverKey: ServerKey, directory: string | undefined) {
  return directory !== undefined && state.missing[keyOf(serverKey, directory)] === true
}

/**
 * A failed request in a session's folder: marks the folder missing when the server said so (the typed 404), and
 * tells the caller, which then shows `own.worktree.missing.send` instead of its generic failure. The folder's
 * location read is dropped too, so the next check asks the server instead of an earlier success.
 */
export function noteLocationError(
  runtime: Pick<ServerRuntime, "key" | "data">,
  directory: string | undefined,
  error: unknown,
) {
  if (directory === undefined || !isLocationMissing(error)) return false
  state.setMissing(keyOf(runtime.key, directory), true)
  runtime.data.location.invalidate({ directory })
  return true
}

/**
 * What a missing folder's session can do in this connection: `folder` (the folder picker, this PC's or the local
 * service's folders with the `local` scope), `worktree` (only the worktree move of a Git project, `prompt`), or `none`
 * (a paired device: moving is a PC action). The notice and the composer's send failure word it the same way.
 */
export function missingChoice(runtime: ServerRuntime, sessionID: string) {
  if (canChoose(runtime)) return "folder" as const
  if (canMoveSession(runtime, sessionID)) return "worktree" as const
  return "none" as const
}

export const MISSING_BODY = {
  folder: "own.worktree.missing.body",
  worktree: "own.worktree.missing.bodyWorktree",
  none: "own.worktree.missing.readOnly",
} as const

export const MISSING_SEND = {
  folder: "own.worktree.missing.send",
  worktree: "own.worktree.missing.sendWorktree",
  none: "own.worktree.missing.sendReadOnly",
} as const

// The folder picker shows this PC's (or the local service's) folders; an SSH host has its own picker flow.
function canChoose(runtime: ServerRuntime) {
  return runtime.kind !== "ssh" && runtime.rpc.can("local")
}

export function LocationMissingNotice(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const text = useWorktreeText()
  const runtime = () => data.get(props.serverKey())
  const top = () => {
    const current = runtime()
    const id = props.sessionID()
    if (!current || !id) return undefined
    const info = current.data.session.get(id)
    const row = current.sessions.state.sessions[id]
    if (info?.parentID ?? row?.parentID) return undefined
    const directory = info?.location.directory ?? row?.directory
    return directory ? { runtime: current, sessionID: id, directory } : undefined
  }
  const target = createMemo(top, undefined, {
    equals: (a, b) => a?.runtime === b?.runtime && a?.sessionID === b?.sessionID && a?.directory === b?.directory,
  })

  // Resolve the folder once per view and connection; createData dedups the read and repeats it after a reconnect.
  createEffect(
    on(
      () => [target(), runtime()?.connection.status()] as const,
      ([current, status]) => {
        if (!current || status !== "connected") return
        const key = keyOf(current.runtime.key, current.directory)
        untrack(() =>
          current.runtime.data.location.syncInfo({ directory: current.directory }).then(
            () => state.setMissing(key, undefined),
            (error: unknown) => {
              if (isLocationMissing(error)) state.setMissing(key, true)
            },
          ),
        )
      },
    ),
  )

  const shown = () => {
    const current = target()
    return current && locationMissing(current.runtime.key, current.directory) ? current : undefined
  }
  const [moving, setMoving] = createSignal(false)

  async function moveTo(current: { readonly runtime: ServerRuntime; readonly sessionID: string }, directory: string) {
    setMoving(true)
    await moveSession(current.runtime, current.sessionID, directory)
      .then(() => showToast({ message: text("own.worktree.missing.moved", { name: baseName(directory) }) }))
      .catch((error: unknown) =>
        showToast({
          tone: "danger",
          message: text("own.worktree.missing.moveFailed", {
            reason: error instanceof Error ? error.message : String(error),
          }),
        }),
      )
    setMoving(false)
  }

  return (
    <Show when={shown()}>
      {(current) => (
        <section
          class="own-wt-missing"
          role="status"
          aria-label={text("own.worktree.missing.title")}
          data-testid="location-missing"
        >
          <div class="own-wt-missing-text">
            <p class="own-wt-missing-title">
              <span aria-hidden="true">⚠</span> {text("own.worktree.missing.title")}
            </p>
            <p class="own-wt-missing-path" data-testid="location-missing-path">
              {current().directory}
            </p>
            <p class="own-wt-missing-body">
              {text(MISSING_BODY[missingChoice(current().runtime, current().sessionID)])}
            </p>
          </div>
          <div class="own-wt-missing-actions">
            <Show when={canMoveSession(current().runtime, current().sessionID)}>
              <button
                type="button"
                class="own-wt-missing-btn own-target"
                data-testid="location-missing-worktree"
                disabled={moving()}
                onClick={() => openWorktreeMove({ serverKey: current().runtime.key, sessionID: current().sessionID })}
              >
                {text("own.worktree.missing.worktree")}
              </button>
            </Show>
            <Show when={canChoose(current().runtime)}>
              <button
                type="button"
                class="own-wt-missing-btn own-target"
                data-variant="primary"
                data-testid="location-missing-choose"
                disabled={moving()}
                aria-busy={moving()}
                onClick={() => {
                  // Read now: the picker answers later, when this notice may be gone.
                  const session = current()
                  openProject(session.runtime.key, {
                    purpose: "move",
                    onPick: (project) => void moveTo(session, project.directory),
                  })
                }}
              >
                {text(moving() ? "own.worktree.missing.moving" : "own.worktree.missing.choose")}
              </button>
            </Show>
          </div>
        </section>
      )}
    </Show>
  )
}
