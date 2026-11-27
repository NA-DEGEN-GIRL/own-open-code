// Input latency sampling (03 §20.1 "입력 지연의 뜻과 재는 법", §20.2 R11). Handlers call `record(event)` at their
// end; the processing cost is `performance.now() - event.timeStamp` (same clock as Event Timing `startTime`).
// Runtime keeps at most 256 samples per 30 s and stores no keys, text, DOM or URLs. Benchmarks read `samples()`.

export interface InputSample {
  /** Event type only (`keydown`, `compositionupdate`, `input`, …). */
  readonly type: string
  readonly processing: number
  readonly at: number
}

const WINDOW_MS = 30_000
const WINDOW_LIMIT = 256

export function createInputSampler(options?: { readonly full?: boolean }) {
  const samples: InputSample[] = []
  let windowStart = 0
  let inWindow = 0
  return {
    record(event: Event) {
      const now = performance.now()
      if (!options?.full) {
        if (now - windowStart > WINDOW_MS) {
          windowStart = now
          inWindow = 0
        }
        if (inWindow >= WINDOW_LIMIT) return
        inWindow++
      }
      samples.push({ type: event.type, processing: now - event.timeStamp, at: now })
      if (!options?.full && samples.length > WINDOW_LIMIT * 4) samples.splice(0, samples.length - WINDOW_LIMIT * 4)
    },
    samples: () => samples.slice(),
    /** p-th percentile of processing cost (0–100). */
    percentile(p: number) {
      if (!samples.length) return undefined
      const sorted = samples.map((sample) => sample.processing).toSorted((a, b) => a - b)
      return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
    },
  }
}

export type InputSampler = ReturnType<typeof createInputSampler>

/** Shared runtime sampler; full sampling is for benches and the first 90 s (PF6), switched on by the bench. */
export const inputSampler = createInputSampler({
  full: typeof location === "object" && new URLSearchParams(location.search).has("own-bench"),
})
