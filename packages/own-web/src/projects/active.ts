// The project folder "on screen" (MCP status, the server panel, settings that act per Location): the open session's
// folder, else the project route's folder, else the newest session's folder. Pages (/settings, /limits, …) render over
// the session view, so on a page the last session or project route still decides. Never the control location.
import { createEffect, createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import type { Router } from "@/routing/router"
import { isPage, routeServer, type Route } from "@/routing/routes"
import { targetFor } from "@/sidebar/target"

const [workspace, setWorkspace] = createSignal<Route>()

/** Remembers the last non-page route; called by the always-mounted layers (projects, mcp). */
export function followWorkspaceRoute(router: Router) {
  createEffect(() => {
    const route = router.route()
    if (!isPage(route)) setWorkspace(route)
  })
}

/** The server on screen (Ctrl+O opens its folders): the open conversation's or project's, else this PC. */
export function activeServer(data: { get(key: string): unknown }, route: Route) {
  const key = routeServer(isPage(route) ? (workspace() ?? route) : route)
  return data.get(key) ? key : undefined
}

export function activeDirectory(runtime: ServerRuntime, route: Route) {
  const effective = isPage(route) ? (workspace() ?? route) : route
  const index = runtime.sessions.state
  if (effective.name === "session" && effective.serverKey === runtime.key)
    return (
      runtime.data.session.get(effective.sessionID)?.location.directory ??
      index.sessions[effective.sessionID]?.directory
    )
  if (effective.name === "project" && effective.serverKey === runtime.key)
    return (
      targetFor(effective.serverKey, effective.projectID)?.directory ?? index.projects[effective.projectID]?.directory
    )
  const first = index.order[0]
  return first ? index.sessions[first]?.directory : undefined
}

/**
 * The server and folder on screen for a page that keeps this PC's settings about either (설정 > GitHub, 16 §8): an SSH
 * host's runtime and folder when the last session or project route is that host's (`host` is its key, the host id),
 * else this PC's.
 */
export function activePlace(
  data: { local(): ServerRuntime; get(key: string): ServerRuntime | undefined },
  route: Route,
): { readonly runtime: ServerRuntime; readonly directory: string | undefined; readonly host?: string } {
  const effective = isPage(route) ? (workspace() ?? route) : route
  const key = effective.name === "session" || effective.name === "project" ? effective.serverKey : undefined
  const remote = key === undefined || key === data.local().key ? undefined : data.get(key)
  if (remote && key) return { runtime: remote, directory: activeDirectory(remote, route), host: key }
  return { runtime: data.local(), directory: activeDirectory(data.local(), route) }
}

/**
 * Whether {@link activeDirectory} has its answer: a folder, or the server's session list is in (or failed) and gives
 * none. Before that a page that just opened does not know its session's folder yet, so "no project is open" would be
 * too early (the Ctrl+; dialog waits, SM-26).
 */
export function activeDirectoryKnown(runtime: ServerRuntime, route: Route) {
  const index = runtime.sessions.state
  return activeDirectory(runtime, route) !== undefined || index.source === "server" || index.error !== undefined
}
