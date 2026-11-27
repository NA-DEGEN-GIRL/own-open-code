// Recent projects (03 §18.3 "최근 폴더", new-session project selector, palette): folders of the newest sessions from
// the session index, merged with folders this browser opened through the picker but has no session in yet. The
// opened list is a per-viewer convenience in localStorage (never state that must survive: a failing store only
// shortens the list). Nothing here creates a Location.
import { createMemo } from "solid-js"
import type { ServerKey, ServerRuntime, SessionIndexState } from "@/data"
import { baseName, samePath } from "./path"

export interface RecentProject {
  readonly directory: string
  /** Known once a session exists there or the picker resolved it (`GET /api/location`). */
  readonly projectID?: string
  readonly name: string
  /** Newest session `updated`, or when the picker opened it. */
  readonly at: number
}

export interface OpenedFolder {
  readonly directory: string
  readonly projectID?: string
  readonly at: number
}

const LIMIT = 8
const STORED = 12
const KEY = (serverKey: ServerKey) => `own.web.projects.opened.${serverKey}`

/** Newest first, one row per folder. `order` is the index's newest-first root session list. */
export function mergeRecent(
  index: Pick<SessionIndexState, "order" | "sessions" | "projects">,
  opened: readonly OpenedFolder[],
  limit = LIMIT,
): RecentProject[] {
  const rows: RecentProject[] = []
  const seen = (directory: string) => rows.some((row) => samePath(row.directory, directory))
  for (const id of index.order) {
    if (rows.length >= limit) break
    const session = index.sessions[id]
    if (!session?.directory || seen(session.directory)) continue
    const project = index.projects[session.projectID]
    rows.push({
      directory: session.directory,
      projectID: session.projectID || undefined,
      name: project?.name || baseName(session.directory),
      at: session.updated,
    })
  }
  const extra = opened
    .filter((folder) => !seen(folder.directory))
    .map((folder) => ({
      directory: folder.directory,
      projectID: folder.projectID,
      name: baseName(folder.directory),
      at: folder.at,
    }))
  return [...rows, ...extra].toSorted((a, b) => b.at - a.at).slice(0, limit)
}

export function openedFolders(serverKey: ServerKey): OpenedFolder[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY(serverKey)) ?? "[]")
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (item): item is OpenedFolder =>
        typeof item === "object" && item !== null && typeof item.directory === "string" && typeof item.at === "number",
    )
  } catch {
    return []
  }
}

/** Remembers a folder the user chose (picker or native dialog) so it is offered before its first session exists. */
export function rememberFolder(serverKey: ServerKey, folder: Omit<OpenedFolder, "at">, at = Date.now()) {
  const next = [
    { directory: folder.directory, projectID: folder.projectID, at },
    ...openedFolders(serverKey).filter((item) => !samePath(item.directory, folder.directory)),
  ].slice(0, STORED)
  try {
    localStorage.setItem(KEY(serverKey), JSON.stringify(next))
  } catch {}
}

/**
 * Reactive recent list of one server. Reads the index only as far as it needs (newest sessions first), so a status
 * change of an old session does not recompute it. Mount it where the list is shown (picker, menu), not at startup.
 */
export function useRecentProjects(runtime: () => ServerRuntime | undefined, limit = LIMIT) {
  return createMemo(() => {
    const current = runtime()
    if (!current) return []
    return mergeRecent(current.sessions.state, openedFolders(current.key), limit)
  })
}
