// Hand-off from the sidebar to the new-session screen (03 §5.1, §18.3). The sidebar's project `+`, "폴더 열기…" and
// Ctrl+O pick a folder, set this target and navigate to the project route `/srv/:serverKey/p/:projectID`. The
// new-session screen (composer owner) reads it to create the session with `location.directory` = `directory`.
// The target is valid only while the route is that project: routes carry the project id, never a path (18.3).
import { createSignal } from "solid-js"
import type { ServerKey } from "@/data"

export interface NewSessionTarget {
  readonly serverKey: ServerKey
  readonly projectID: string
  /** Normalized by the server (`GET /api/location`), or the project's canonical directory. */
  readonly directory: string
  readonly name?: string
  readonly at: number
}

const [target, setTarget] = createSignal<NewSessionTarget>()

/** The folder the next session should start in, or `undefined` (the new-session screen picks its default). */
export const newSessionTarget = target

export function setNewSessionTarget(next: Omit<NewSessionTarget, "at"> | undefined) {
  setTarget(next ? { ...next, at: Date.now() } : undefined)
}

/** The target for a project route, if it still matches. */
export function targetFor(serverKey: ServerKey, projectID: string) {
  const current = target()
  return current && current.serverKey === serverKey && current.projectID === projectID ? current : undefined
}
