export * as Board from "./board.js"

import type { Broadcast } from "@own/runtime"

/**
 * Process-wide view of every Location's allowlist state (02 §4.2, §9.2 `plugin.trust.list`, `health.locations`).
 * Each own-accounts instance computes only its own Location (`ctx.plugin.list()` is Location-scoped), and plugin
 * modules are imported again per Location, so the instances meet only through the runtime's broadcast hub:
 * - `location.state`: an instance announces a changed state; the leader turns it into `plugin.trust.changed`.
 * - `location.query`: a synchronous query; every live instance replies with its current state. Stopped instances
 *   have unsubscribed, so the answer never lists a closed Location.
 */

export type LocationState = Broadcast.LocationState

export function announce(hub: Broadcast.Hub, state: LocationState) {
  hub.emit("location.state", state)
}

export function onAnnounce(hub: Broadcast.Hub, listener: (state: LocationState) => void) {
  return hub.on("location.state", listener)
}

/** Answers queries with this instance's state (`undefined` = not known yet, no answer). */
export function serve(hub: Broadcast.Hub, current: () => LocationState | undefined) {
  return hub.on("location.query", (query) => {
    const state = current()
    if (state) query.reply(state)
  })
}

/** Every live instance's state, one per directory (a reloading Location may briefly answer twice; last wins). */
export function collect(hub: Broadcast.Hub) {
  const states = new Map<string, LocationState>()
  hub.emit("location.query", { reply: (state) => states.set(key(state.directory), state) })
  return [...states.values()].sort((a, b) => (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0))
}

function key(directory: string) {
  return process.platform === "win32" ? directory.toLowerCase() : directory
}
