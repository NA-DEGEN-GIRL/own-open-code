export * as Clock from "./clock.js"

/** Time source and timers for modules, so state-machine timers can be driven by tests. */
export interface Clock {
  now(): number
  /** Runs `run` once after `ms`; returns a cancel function. Timers never keep the process alive. */
  schedule(ms: number, run: () => void): () => void
}

export const system: Clock = {
  now: () => Date.now(),
  schedule: (ms, run) => {
    const timer = setTimeout(run, Math.max(0, ms))
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

/** A clock that only moves with `advance`, firing due timers in order. For unit tests. */
export function manual(start = Date.UTC(2026, 8, 27, 3, 0, 0)) {
  const state = { now: start, next: 0 }
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()
  const clock: Clock & { advance(ms: number): void; pending(): number } = {
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
      // Timers scheduled by a firing timer run in the same advance when they fall due before `target`.
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
  return clock
}
