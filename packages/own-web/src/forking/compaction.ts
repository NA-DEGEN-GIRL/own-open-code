// Manual `/compact` and the compaction progress of a session (03 §19.12 "진행 칩 `압축 중…`, 실패 배너", 02 §4.7).
// `POST /api/session/:id/compact` only admits a compaction item (it steers: it runs at the next step boundary, or now
// when the session is idle); the work is reported by the durable `session.compaction.started/ended/failed` events.
// One tracker per server runtime follows those events for every session (also automatic compactions and ones another
// window asked for); the phase of a session is derived from them, the inbox and the in-flight request.
//
// Compacting commits a staged revert (core `Session.compact`), so callers confirm first (`own.compact.impactRevert`).
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { compactionPhase, errorText, type CompactionPhase } from "./model"

export interface CompactionView {
  readonly phase: CompactionPhase
  readonly reason?: "auto" | "manual"
  /** The server's or the request's error text (failed phase). */
  readonly error?: string
  /** The failure was the request itself (not the compaction run). */
  readonly requestFailed?: boolean
}

interface SessionState {
  requesting?: boolean
  running?: { reason: "auto" | "manual" }
  failed?: { reason?: "auto" | "manual"; error?: string; request: boolean }
}

export interface CompactionTracker {
  /** Reactive phase of one session. */
  view(sessionID: string): CompactionView
  /** Admits a manual compaction. Resolves to false when the request failed (the view shows it). */
  request(sessionID: string): Promise<boolean>
  /** Hides a failure. */
  dismiss(sessionID: string): void
  dispose(): void
}

const trackers = new WeakMap<ServerRuntime, CompactionTracker>()

/** One tracker per server runtime (event subscriptions live as long as the runtime). */
export function compactionTracker(runtime: ServerRuntime): CompactionTracker {
  const known = trackers.get(runtime)
  if (known) return known
  const created = createCompactionTracker(runtime)
  trackers.set(runtime, created)
  return created
}

export function createCompactionTracker(runtime: Pick<ServerRuntime, "bus" | "data">): CompactionTracker {
  return createRoot((dispose) => {
    const [state, setState] = createStore<{ sessions: Record<string, SessionState | undefined> }>({ sessions: {} })
    const patch = (sessionID: string, next: SessionState) =>
      setState("sessions", sessionID, (current) => ({ ...current, ...next }))

    const offs = [
      runtime.bus.on("session.compaction.started", (event) =>
        patch(event.data.sessionID, { running: { reason: event.data.reason }, failed: undefined }),
      ),
      runtime.bus.on("session.compaction.ended", (event) =>
        patch(event.data.sessionID, { running: undefined, failed: undefined }),
      ),
      runtime.bus.on("session.compaction.failed", (event) =>
        patch(event.data.sessionID, {
          running: undefined,
          failed: { reason: event.data.reason, error: event.data.error?.message, request: false },
        }),
      ),
    ]

    const queued = (sessionID: string) =>
      runtime.data.session.pending.list(sessionID).some((item) => item.type === "compaction")
    /** A session opened while its compaction runs: the newest message is the running compaction row. */
    const runningRow = (sessionID: string) => {
      const last = runtime.data.session.message.list(sessionID).at(-1)
      return last?.type === "compaction" && last.status === "running" ? last : undefined
    }

    return {
      view(sessionID) {
        const current = state.sessions[sessionID]
        const row = current?.running ? undefined : runningRow(sessionID)
        const phase = compactionPhase({
          requesting: !!current?.requesting,
          queued: queued(sessionID),
          running: !!current?.running || !!row,
          failed: !!current?.failed,
        })
        if (phase === "running") return { phase, reason: current?.running?.reason ?? row?.reason }
        if (phase === "failed")
          return {
            phase,
            reason: current?.failed?.reason,
            error: current?.failed?.error,
            requestFailed: current?.failed?.request,
          }
        return { phase }
      },
      async request(sessionID) {
        if (state.sessions[sessionID]?.requesting) return true
        patch(sessionID, { requesting: true, failed: undefined })
        try {
          await runtime.data.session.compact({ sessionID })
          patch(sessionID, { requesting: false })
          return true
        } catch (error) {
          console.error("[own-web] compact request failed", error)
          patch(sessionID, { requesting: false, failed: { reason: "manual", error: errorText(error), request: true } })
          return false
        }
      },
      dismiss(sessionID) {
        patch(sessionID, { failed: undefined })
      },
      dispose() {
        offs.forEach((off) => off())
        dispose()
      },
    }
  })
}
