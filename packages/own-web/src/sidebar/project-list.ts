// A server's project order and pins (03 §4.3 "순서와 고정"): own.accounts `projectList.*` of the service that has the
// projects (this PC's, an SSH host's own), so the PC's windows and a phone agree. Read when the connection comes up and
// when `projectList.changed` says another window or device changed it (an SSH host sends no such event: its other
// windows read it on their next connect). The last list is kept in this browser, so the order paints before the
// service answers. An older service has neither method: the list then lives in this browser only, and goes to the
// service once it has them. Changes are the lazy ./reorder.ts's.
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { OwnRpcError, type ServerKey, type ServerRuntime } from "@/data"
import type { ProjectListView } from "./arrange"

const EMPTY: ProjectListView = { pinned: [], order: null, orderedAt: null }

export type ProjectListRuntime = Pick<ServerRuntime, "rpc" | "connection"> & {
  readonly own: Pick<ServerRuntime["own"], "on">
}

export function createProjectList(serverKey: ServerKey, runtime: ProjectListRuntime) {
  const key = `own.web.sidebar.projects.${serverKey}`
  const saved = load(key)
  const [view, setView] = createSignal<ProjectListView>(saved ?? EMPTY)
  /** The service has no `projectList.*` (an older build). */
  const [unsupported, setUnsupported] = createSignal(false)
  /** Kept in this browser only: what an older service could not take. */
  let local = saved?.local === true
  /** Changes of this window on their way: what it shows is newer than what the service says meanwhile. */
  let sending = 0

  function apply(next: ProjectListView, unsent = false) {
    local = unsent
    setView(next)
    try {
      localStorage.setItem(key, JSON.stringify({ ...next, ...(unsent ? { local: true } : {}) }))
    } catch {}
  }

  async function read() {
    if (!runtime.rpc.allowed("projectList.get")) return
    const list = await runtime.rpc.call("projectList.get", {}).catch((error: unknown) => {
      if (error instanceof OwnRpcError && error.type === "rpc.method_not_found") setUnsupported(true)
    })
    if (!list) return
    setUnsupported(false)
    if (!local || list.pinned.length || list.order || !runtime.rpc.allowed("projectList.set")) return apply(list)
    const { pinned, order } = view()
    await runtime.rpc.call("projectList.set", { pinned, order }).then(apply, () => undefined)
  }

  createEffect(
    on(
      () => runtime.connection.status(),
      (status) => {
        if (status === "connected") void read()
      },
    ),
  )
  onCleanup(
    runtime.own.on("projectList.changed", (event) => {
      if (!sending) apply(event.data.list)
    }),
  )

  return {
    view,
    unsupported,
    apply,
    /** Counts this window's changes in flight (`1`, then `-1`); answers how many there are now. */
    hold: (change: 1 | -1) => (sending += change),
    /** This connection may arrange the list now (`prompt`, like pinning a conversation). */
    can: () => runtime.connection.status() === "connected" && runtime.rpc.allowed("projectList.set"),
  }
}

export type ProjectList = ReturnType<typeof createProjectList>

function load(key: string): (ProjectListView & { readonly local?: boolean }) | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (typeof value !== "object" || value === null || !("pinned" in value) || !Array.isArray(value.pinned)) return
    // SAFETY: written by `apply` only, from an answer of the service or from ./reorder.ts.
    return value as unknown as ProjectListView
  } catch {
    return undefined
  }
}
