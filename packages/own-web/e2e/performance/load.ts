// Machine load during a benchmark run (03 §20.1 records the environment with the numbers): the whole machine's CPU
// busy share, sampled every second from `os.cpus()` time deltas by run.ts. The baseline is sampled before the
// fixture backend starts, so it is the load of other applications; samples during a benchmark include the bench's own
// processes (Edge, the server, vite preview). Process names are not recorded (perf.json can be committed).
import os from "node:os"
import { summarize, type Summary } from "./metrics"

export interface LoadSample {
  /** Epoch ms at the end of the sampled interval. */
  readonly at: number
  /** Busy share of all logical CPUs over the interval, 0–100. */
  readonly busy: number
}

type Times = { readonly busy: number; readonly total: number }

export function cpuTimes(cpus = os.cpus()): Times {
  return cpus.reduce(
    (sum, cpu) => {
      const { user, nice, sys, irq, idle } = cpu.times
      const busy = user + nice + sys + irq
      return { busy: sum.busy + busy, total: sum.total + busy + idle }
    },
    { busy: 0, total: 0 },
  )
}

/** Busy share (0–100) between two `cpuTimes` readings; `null` when no time passed. */
export function busyShare(before: Times, after: Times) {
  const total = after.total - before.total
  return total > 0 ? Math.round(((after.busy - before.busy) / total) * 1_000) / 10 : null
}

/** Samples the busy share every `intervalMs` until `stop()`; `samples` grows while it runs. */
export function startLoadSampler(intervalMs = 1_000) {
  const samples: LoadSample[] = []
  let previous = cpuTimes()
  const timer = setInterval(() => {
    const current = cpuTimes()
    const busy = busyShare(previous, current)
    previous = current
    if (busy !== null) samples.push({ at: Date.now(), busy })
  }, intervalMs)
  return {
    samples,
    stop: () => clearInterval(timer),
  }
}

/** Busy share summary of the samples whose interval ended within [from, to] (epoch ms). */
export function loadBetween(samples: readonly LoadSample[], from: number, to: number): Summary {
  return summarize(samples.filter((sample) => sample.at > from && sample.at <= to).map((sample) => sample.busy))
}
