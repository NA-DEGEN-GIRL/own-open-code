// A manual clock for own.team unit tests (06 §11.2 "수동 시계"): time moves only with `advance`, which fires due
// timers in order (a timer scheduled by a firing timer fires in the same advance when it falls due before the target).

import type { Services } from "../../src/services.js"

export interface Manual extends Services.Clock {
  advance(ms: number): void
  /** Timers not fired or cancelled yet. */
  pending(): number
}

export function manual(start = Date.UTC(2026, 9, 2, 3, 0, 0)): Manual {
  const state = { now: start, next: 0 }
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()
  return {
    now: () => state.now,
    schedule: (ms, run) => {
      const id = state.next++
      timers.set(id, { at: state.now + Math.max(0, ms), run })
      return () => {
        timers.delete(id)
      }
    },
    advance: (ms) => {
      const target = state.now + ms
      const fire = (): void => {
        const next = [...timers.entries()]
          .filter((entry) => entry[1].at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) return
        timers.delete(next[0])
        state.now = next[1].at
        next[1].run()
        fire()
      }
      fire()
      state.now = target
    },
    pending: () => timers.size,
  }
}
