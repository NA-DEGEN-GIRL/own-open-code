import { createSignal, onCleanup } from "solid-js"
import { isPage, type Route } from "@/routing/routes"

export type WorkspaceTab = "chat" | "browser" | "notes"
export type NotesPlacement = "left" | "right" | "main"
export interface WorkspaceLayout {
  sidebarWidth?: number
  panelWidth?: number
  panelOpen?: boolean
  sidebarCollapsed?: boolean
  notesWidth: number
  notesOpen: boolean
  notesPlacement: NotesPlacement
  tab: WorkspaceTab
}

export const WORKSPACE_DEFAULTS: WorkspaceLayout = {
  notesWidth: 340,
  notesOpen: false,
  notesPlacement: "right",
  tab: "chat",
}

/** Pages retain the actual conversation underneath, including remote server identity and drafts. */
export function rememberWorkspace(route: () => Route) {
  let previous: Route = { name: "home" }
  return () => {
    const current = route()
    if (!isPage(current)) previous = current
    return previous
  }
}

/** Layout writes are coalesced while dragging; pagehide flushes the last position. */
export function createWorkspaceLayout(key: () => string, windowKey: string) {
  const [revision, setRevision] = createSignal(0)
  const values = new Map<string, WorkspaceLayout>()
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  // What changed under the key written last, so `adopt` can move it when that key turns out to be provisional.
  let last: { workspace: string; value: Partial<WorkspaceLayout> } | undefined
  const storageKey = (workspace: string) => `own.web.workspace.${windowKey}.${workspace}`
  const read = () => {
    revision()
    const workspace = key()
    const cached = values.get(workspace)
    if (cached) return cached
    const value = load(storageKey(workspace))
    values.set(workspace, value)
    return value
  }
  const flush = () => {
    clearTimeout(timer)
    pending.forEach((workspace) => {
      try {
        localStorage.setItem(storageKey(workspace), JSON.stringify(values.get(workspace)))
        pending.delete(workspace)
      } catch {}
    })
  }
  window.addEventListener("pagehide", flush)
  onCleanup(() => {
    flush()
    window.removeEventListener("pagehide", flush)
  })
  const update = (value: Partial<WorkspaceLayout>) => {
    const workspace = key()
    values.set(workspace, { ...read(), ...value })
    last = { workspace, value: last?.workspace === workspace ? { ...last.value, ...value } : value }
    pending.add(workspace)
    setRevision((value) => value + 1)
    clearTimeout(timer)
    timer = setTimeout(flush, 300)
  }
  return {
    read,
    update,
    /** Applies what changed under `from`, the key just left, to the current key (once). */
    adopt(from: string) {
      if (last?.workspace !== from) return
      const value = last.value
      last = undefined
      update(value)
    },
    flush,
  }
}

export function snapNotesWidth(width: number, available: number) {
  const max = Math.max(220, Math.min(600, available - 320))
  const clamped = Math.max(220, Math.min(max, width))
  const snap = [280, 340, 420, Math.round(available / 2)].find((size) => size <= max && Math.abs(size - clamped) <= 12)
  return snap ?? Math.round(clamped)
}

function load(key: string): WorkspaceLayout {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (!value || typeof value !== "object") return { ...WORKSPACE_DEFAULTS }
    const data = value as Partial<WorkspaceLayout>
    return {
      sidebarWidth: typeof data.sidebarWidth === "number" ? Math.max(220, Math.min(400, data.sidebarWidth)) : undefined,
      panelWidth: typeof data.panelWidth === "number" ? Math.max(320, Math.min(960, data.panelWidth)) : undefined,
      panelOpen: typeof data.panelOpen === "boolean" ? data.panelOpen : undefined,
      sidebarCollapsed: typeof data.sidebarCollapsed === "boolean" ? data.sidebarCollapsed : undefined,
      notesWidth: typeof data.notesWidth === "number" ? Math.max(220, Math.min(600, data.notesWidth)) : 340,
      notesOpen: data.notesOpen === true,
      notesPlacement: data.notesPlacement === "left" || data.notesPlacement === "main" ? data.notesPlacement : "right",
      tab: data.tab === "browser" || data.tab === "notes" ? data.tab : "chat",
    }
  } catch {
    return { ...WORKSPACE_DEFAULTS }
  }
}
