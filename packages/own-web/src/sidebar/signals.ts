// Per-session activity the sidebar needs beyond the session index (03 §7.6): retry waits (`◐`), failed turns (`!`),
// the last activity time, and "a turn just finished" for the unread mark. Fed by the server's event bus (already
// frame-batched, 20.2 R3); these events arrive per turn or step, never per streamed delta.
import type { EventBus } from "@/data/events"
import { createStore, produce } from "solid-js/store"

export interface SessionSignalState {
  retry: Record<string, true>
  failed: Record<string, true>
  /** Last execution start or end (epoch ms), for the relative time before the index catches up. */
  activity: Record<string, number>
}

export type FinishListener = (sessionID: string, at: number) => void

export function createSessionSignals(bus: EventBus) {
  const [state, setState] = createStore<SessionSignalState>({ retry: {}, failed: {}, activity: {} })
  const finished = new Set<FinishListener>()

  const clear = (field: "retry" | "failed", sessionID: string) => {
    if (state[field][sessionID])
      setState(
        field,
        produce((map) => void delete map[sessionID]),
      )
  }
  const touch = (sessionID: string, at: number) => {
    if ((state.activity[sessionID] ?? 0) < at) setState("activity", sessionID, at)
  }
  const done = (sessionID: string, at: number) => {
    clear("retry", sessionID)
    touch(sessionID, at)
    finished.forEach((listener) => listener(sessionID, at))
  }

  const stops = [
    bus.on("session.execution.started", (event) => {
      clear("retry", event.data.sessionID)
      clear("failed", event.data.sessionID)
      touch(event.data.sessionID, event.created)
    }),
    bus.on("session.retry.scheduled", (event) => {
      if (!state.retry[event.data.sessionID]) setState("retry", event.data.sessionID, true)
    }),
    bus.on("session.step.started", (event) => clear("retry", event.data.sessionID)),
    bus.on("session.execution.succeeded", (event) => done(event.data.sessionID, event.created)),
    bus.on("session.execution.interrupted", (event) => done(event.data.sessionID, event.created)),
    bus.on("session.execution.failed", (event) => {
      if (!state.failed[event.data.sessionID]) setState("failed", event.data.sessionID, true)
      done(event.data.sessionID, event.created)
    }),
    bus.on("session.deleted", (event) =>
      setState(
        produce((draft) => {
          delete draft.retry[event.data.sessionID]
          delete draft.failed[event.data.sessionID]
          delete draft.activity[event.data.sessionID]
        }),
      ),
    ),
  ]

  return {
    state,
    /** A turn of `sessionID` ended (succeeded, failed or interrupted). */
    onFinished(listener: FinishListener) {
      finished.add(listener)
      return () => finished.delete(listener)
    },
    dispose() {
      stops.forEach((stop) => stop())
      finished.clear()
    },
  }
}

export type SessionSignals = ReturnType<typeof createSessionSignals>
