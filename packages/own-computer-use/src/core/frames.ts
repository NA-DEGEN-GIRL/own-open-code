export * as Frames from "./frames.js"

import { randomBytes } from "node:crypto"
import type { Geometry } from "./geometry.js"

/** Frames remembered per session; older captureIds stop resolving. */
export const CAPACITY = 16

/**
 * Screenshots the model may still refer to, per session. The latest frame is the default coordinate space; an older
 * one is reachable by captureId. Frames of another display layout are stale: their image no longer maps onto the
 * physical desktop.
 */
export interface Store {
  /** Random per process, so a captureId from before a restart never resolves to a new frame. */
  readonly prefix: string
  seq: number
  /** Oldest first. */
  readonly sessions: Map<string, Array<Geometry.Frame>>
}

export type Lookup =
  | { readonly _tag: "Found"; readonly frame: Geometry.Frame }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Unknown"; readonly captureId: string }
  | { readonly _tag: "Stale"; readonly frame: Geometry.Frame }

export function make(prefix = randomBytes(3).toString("hex")): Store {
  return { prefix, seq: 0, sessions: new Map() }
}

export function nextId(store: Store) {
  store.seq += 1
  return `cap_${store.prefix}${store.seq.toString(36)}`
}

export function remember(store: Store, sessionID: string, frame: Geometry.Frame) {
  const frames = (store.sessions.get(sessionID) ?? []).filter((item) => item.captureId !== frame.captureId)
  store.sessions.set(sessionID, [...frames, frame].slice(-CAPACITY))
}

export function latest(store: Store, sessionID: string) {
  return store.sessions.get(sessionID)?.at(-1)
}

/** The frame `captureId` (default: the latest) of `sessionID`, checked against the current layout hash. */
export function lookup(
  store: Store,
  sessionID: string,
  input: { readonly captureId?: string; readonly layoutHash: string },
): Lookup {
  const frames = store.sessions.get(sessionID) ?? []
  const frame =
    input.captureId === undefined ? frames.at(-1) : frames.find((item) => item.captureId === input.captureId)
  if (frame === undefined)
    return input.captureId === undefined ? { _tag: "Missing" } : { _tag: "Unknown", captureId: input.captureId }
  if (frame.layoutHash !== input.layoutHash) return { _tag: "Stale", frame }
  return { _tag: "Found", frame }
}

export function forget(store: Store, sessionID: string) {
  store.sessions.delete(sessionID)
}
