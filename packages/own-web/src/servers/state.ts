// Pure helpers for SSH host state (04 §12.2, §17.2, §17.7). No Solid, no I/O: unit-tested in state.test.ts.
import type { CachedSessionList, HostView, ProjectRow, RemoteCatalog, SessionRow } from "@/data"

/** Stream status of a server runtime (`@opencode/client` connection), `undefined` before the first attach. */
export type LiveStatus = "connected" | "connecting" | "reconnecting" | undefined

/** Sidebar/header status of a host (04 §17.9 `own.remote.state.*`). */
export type HostStatusKey =
  | "ready"
  | "connecting"
  | "authentication"
  | "hostKey"
  | "incompatible"
  | "needsInstall"
  | "updating"
  | "draining"
  | "otherOwner"
  | "failed"
  | "disconnected"

export type HostTone = "ok" | "warn" | "danger" | "muted"

export interface HostStatus {
  readonly key: HostStatusKey
  readonly tone: HostTone
  /** 03 §7.6 plus the host-only `⤓` (update needed) and `!` (authentication needed), 04 §17.2. */
  readonly symbol: "●" | "○" | "◐" | "⤓" | "!"
  /** The list on screen is a snapshot (catalog or cache), not live (04 §12.3 "흐리게"). */
  readonly stale: boolean
}

type StatusInput = Pick<HostView, "stage" | "paused" | "error">

export function hostStatus(view: StatusInput, live: LiveStatus): HostStatus {
  const status = (key: HostStatusKey, tone: HostTone, symbol: HostStatus["symbol"]): HostStatus => ({
    key,
    tone,
    symbol,
    stale: !(key === "ready" && live === "connected"),
  })
  if (view.error === "other_owner") return status("otherOwner", "warn", "!")
  if (view.error === "host_key") return status("hostKey", "danger", "!")
  switch (view.stage) {
    case "ready":
      return live === "connected" ? status("ready", "ok", "●") : status("connecting", "warn", "◐")
    case "connecting":
    case "checking":
    case "uploading":
    case "starting":
      return status("connecting", "warn", "◐")
    case "authentication":
      return status("authentication", "danger", "!")
    case "incompatible":
      return status("incompatible", "warn", "⤓")
    case "needs_install":
      return status("needsInstall", "warn", "⤓")
    case "updating":
      return status("updating", "warn", "◐")
    case "draining":
      return status("draining", "warn", "◐")
    case "failed":
      return view.paused ? status("failed", "danger", "!") : status("connecting", "warn", "◐")
    case "disconnected":
      return status("disconnected", "muted", "○")
  }
}

/** What the session view shows over a remote session (04 §17.7); `undefined` = nothing, the session is live. */
export type OverlayKind =
  | "reconnecting"
  | "paused"
  | "authentication"
  | "elsewhere"
  | "hostKey"
  | "incompatible"
  | "needsInstall"
  | "otherOwner"
  | "failed"

export function overlayKind(
  view: StatusInput & Pick<HostView, "owner">,
  live: LiveStatus,
  clientId: string,
): OverlayKind | undefined {
  if (view.stage === "ready" && live === "connected") return undefined
  if (view.error === "other_owner") return "otherOwner"
  if (view.error === "host_key") return "hostKey"
  if (view.stage === "authentication")
    return view.owner.clientId && view.owner.clientId !== clientId ? "elsewhere" : "authentication"
  if (view.stage === "incompatible" || view.error === "version_skew") return "incompatible"
  if (view.stage === "needs_install") return "needsInstall"
  if (view.paused) return view.error ? "failed" : "paused"
  return "reconnecting"
}

/**
 * The own-remote catalog (04 §12.3) as a session list snapshot: titles, times, model and project paths only. Sessions
 * whose folder is not a catalog project get a project keyed by the folder, so they still group by folder.
 */
export function catalogList(serverKey: string, catalog: RemoteCatalog): CachedSessionList | undefined {
  if (!catalog.sessions.length && !catalog.projects.length) return undefined
  const projects = new Map<string, ProjectRow>()
  for (const project of catalog.projects)
    projects.set(project.directory, { id: project.id, name: project.name ?? undefined, directory: project.directory })
  const sessions: SessionRow[] = catalog.sessions.map((session) => {
    const known = projects.get(session.directory)
    const project = known ?? { id: `dir:${session.directory}`, directory: session.directory }
    projects.set(session.directory, project)
    const updated = session.updatedAt ?? 0
    return {
      id: session.id,
      title: session.title,
      created: updated,
      updated,
      projectID: project.id,
      directory: session.directory,
      model: session.model ? { providerID: session.model.providerID, id: session.model.modelID } : undefined,
    }
  })
  return {
    serverKey,
    savedAt: catalog.fetchedAt ?? 0,
    sessions,
    projects: [...projects.values()],
  }
}

/** The newer of the browser's own snapshot and the catalog (both are "cache" rows until the live list lands). */
export function newerList(
  cached: CachedSessionList | undefined,
  catalog: CachedSessionList | undefined,
): CachedSessionList | undefined {
  if (!cached) return catalog
  if (!catalog) return cached
  return catalog.savedAt > cached.savedAt ? catalog : cached
}

/** `user@host:port` → `user@host` (the badge shows `user@host:path`, 04 §12.5). */
export function destinationHost(destination: string | null | undefined) {
  if (!destination) return undefined
  return destination.replace(/:\d+$/, "")
}

/** Accounts a host may use (04 §8.9 `accounts`): `all`, or the listed ids. */
export function accountAllowed(scope: HostView["accounts"], accountID: string) {
  return scope.mode === "all" || scope.ids.includes(accountID)
}
