// Pure metric helpers shared by the benchmarks and run.ts (unit-tested in metrics.test.ts). Definitions follow
// 01 §6.6 (PF budgets) and 03 §20.1 ("입력 지연의 뜻과 재는 법", "스크롤을 재는 법").

export interface Summary {
  readonly count: number
  readonly min: number | null
  readonly median: number | null
  readonly p95: number | null
  readonly max: number | null
  readonly mean: number | null
}

/** Nearest-rank percentile (p in 0–100); `null` without samples. */
export function percentile(values: readonly number[], p: number) {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

/** Median; the mean of the two middle values for an even count (upstream bench:tabs convention). */
export function median(values: readonly number[]) {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function summarize(values: readonly number[]): Summary {
  if (!values.length) return { count: 0, min: null, median: null, p95: null, max: null, mean: null }
  return {
    count: values.length,
    min: round(Math.min(...values)),
    median: round(median(values)!),
    p95: round(percentile(values, 95)!),
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  }
}

export function round(value: number, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ---------------------------------------------------------------------------------------------------------------
// Input latency (PF2, PF4)

/** One composer event seen by the probe's window listener, which runs after every app handler of that event. */
export interface InputEventSample {
  readonly type: string
  /** `event.timeStamp` (same clock and value as Event Timing `startTime`). */
  readonly start: number
  /** `performance.now()` at the end of dispatch. */
  readonly end: number
}

/** A PerformanceEventTiming entry (only events whose duration reached the 16 ms threshold are reported). */
export interface EventTimingSample {
  readonly name: string
  readonly startTime: number
  readonly processingStart: number
  readonly processingEnd: number
  readonly duration: number
}

/** Event Timing reports nothing below this duration (`durationThreshold` minimum, rounded to 8 ms). */
export const EVENT_TIMING_THRESHOLD = 16

const timingKey = (name: string, start: number) => `${name}:${Math.round(start * 10)}`

/**
 * PF2 per 01 §6.6: the denominator is every event the probe counted. Processing = `processingEnd − startTime`
 * (Event Timing when it reported the event, otherwise the probe's end-of-dispatch time). Event → paint is the Event
 * Timing `duration`; an event it did not report finished below 16 ms, so it counts as "< 16" (`EVENT_TIMING_THRESHOLD`
 * is used as its upper bound, which keeps the p95 conservative).
 */
export function inputLatency(events: readonly InputEventSample[], timings: readonly EventTimingSample[]) {
  const reported = new Map(timings.map((entry) => [timingKey(entry.name, entry.startTime), entry]))
  const processing = events.map((event) => {
    const entry = reported.get(timingKey(event.type, event.start))
    return Math.max(event.end - event.start, entry ? entry.processingEnd - entry.startTime : 0)
  })
  const paint = events.map((event) => reported.get(timingKey(event.type, event.start))?.duration ?? 0)
  const paintP95 = percentile(paint, 95)
  const byType = Object.fromEntries(
    [...new Set(events.map((event) => event.type))].map((type) => [
      type,
      events.filter((event) => event.type === type).length,
    ]),
  )
  return {
    events: events.length,
    byType,
    processing: summarize(processing),
    over16: processing.filter((value) => value > 16).length,
    over50: processing.filter((value) => value > 50).length,
    eventTimingReported: events.filter((event) => reported.has(timingKey(event.type, event.start))).length,
    /** p95 of event → next paint; `EVENT_TIMING_THRESHOLD` means "below the threshold" (an upper bound). */
    eventToPaintP95: paintP95 === 0 ? EVENT_TIMING_THRESHOLD : paintP95,
    eventToPaintMax: paint.length ? Math.max(...paint) : null,
    units: summarize(inputUnits(events)),
    processingSamples: processing.map((value) => round(value, 1)),
    /** Event → paint per event; 0 = not reported by Event Timing (below 16 ms). */
    paintSamples: paint.map((value) => round(value, 1)),
  }
}

/**
 * 03 §20.1: composition events and `input` of one keystroke form one input unit; its latency runs from the first
 * event's timestamp to the end of the last handler. Events chain into a unit while each starts before the previous
 * one's dispatch ended (+1 ms), i.e. they were queued or dispatched back to back in one task.
 */
export function inputUnits(events: readonly InputEventSample[]) {
  const sorted = events.toSorted((a, b) => a.start - b.start)
  const units: { start: number; end: number }[] = []
  for (const event of sorted) {
    const last = units.at(-1)
    if (last && event.start <= last.end + 1) last.end = Math.max(last.end, event.end)
    else units.push({ start: event.start, end: event.end })
  }
  return units.map((unit) => unit.end - unit.start)
}

// ---------------------------------------------------------------------------------------------------------------
// Frames (PF3, PF4)

/** The 60 fps frame budget of 01 §6.6 PF3 ("스크롤 60fps", presented frame interval ≤ 16.7 ms). */
export const FRAME_BUDGET_MS = 16.7

/** Frames per second of a frame interval (ms); `null` for no interval. */
export const hz = (intervalMs: number | null | undefined) => (intervalMs ? round(1_000 / intervalMs, 1) : null)

/**
 * Long-frame ratio of 03 §20.1 "스크롤을 재는 법" with `F` fixed at the 01 §6.6 budget: a long frame is a rAF
 * interval above 2F = 33.4 ms, i.e. at least one missed frame at 60 fps. The display's refresh interval is recorded
 * (`refresh`) but does not set the threshold: Chromium moves its frame clock between the display rate and fractions
 * of it (240 → 120 Hz on this PC), and with F measured idle at 240 Hz every 120 Hz frame (8.33 ms, right at
 * 2 × 4.17 ms) counted as long whenever the clock jittered. Diagnostics: `overBudget` (intervals above F itself, below 60 fps for that frame; it sits on the
 * 16.67 ms vsync multiple at 60/120 Hz, so it is not a gate) and `displayNormalized` (the old > 2 × idle-F count).
 */
export function rafFrames(timestamps: readonly number[], idleRefreshMs: number, budgetMs = FRAME_BUDGET_MS) {
  const intervals = timestamps.slice(1).map((value, index) => value - timestamps[index]!)
  const ratio = (count: number) => (intervals.length ? round(count / intervals.length, 4) : null)
  const long = intervals.filter((value) => value > 2 * budgetMs).length
  const overBudget = intervals.filter((value) => value > budgetMs).length
  const displayLong = intervals.filter((value) => value > 2 * idleRefreshMs).length
  const active = median(intervals)
  return {
    frames: intervals.length,
    intervals: summarize(intervals),
    budgetMs,
    thresholdMs: round(2 * budgetMs),
    longFrames: long,
    longFrameRatio: ratio(long),
    overBudget,
    overBudgetRatio: ratio(overBudget),
    /** Observed frame clock: idle (before the run) and active (median rAF interval during the run). */
    refresh: {
      idleMs: round(idleRefreshMs),
      idleHz: hz(idleRefreshMs),
      activeMs: active === null ? null : round(active),
      activeHz: hz(active),
    },
    displayNormalized: { thresholdMs: round(2 * idleRefreshMs), longFrames: displayLong, ratio: ratio(displayLong) },
  }
}

/** Minimal Chrome trace event shape used by `traceFrames`. */
export interface TraceEvent {
  readonly name: string
  readonly ph: string
  readonly pid: number
  readonly tid?: number
  readonly ts: number
  /** Wall and thread (CPU) duration of a complete (`X`) event, µs. */
  readonly dur?: number
  readonly tdur?: number
  readonly id?: string
  readonly id2?: { readonly local?: string; readonly global?: string }
  readonly args?: Record<string, unknown>
}

interface FrameReporter {
  readonly state?: string
  readonly frame_sequence?: number
  readonly frame_source?: number
  readonly affects_smoothness?: boolean
  readonly has_missing_content?: boolean
  readonly checkerboarded_needs_raster?: boolean
  readonly checkerboarded_needs_record?: boolean
}

const STATE_RANK: Record<string, number> = {
  STATE_PRESENTED_ALL: 3,
  STATE_PRESENTED_PARTIAL: 2,
  STATE_DROPPED: 1,
  STATE_NO_UPDATE_DESIRED: 0,
}

/**
 * Frames from the compositor's `PipelineReporter` events (category `disabled-by-default-devtools.timeline.frame`,
 * the source of the DevTools frames track) of the page's renderer process. A frame (one BeginFrame sequence) can
 * have several reporters (compositor-only and main-thread updates); they merge into one frame whose state is the
 * best one reported (presented all > presented partial > dropped > no update) and whose presentation time is the
 * earliest presented end. `window` limits frames to [start, end] in trace microseconds.
 */
export function traceFrames(events: readonly TraceEvent[], window?: { readonly start: number; readonly end: number }) {
  const renderers = new Set(
    events
      .filter((event) => event.ph === "M" && event.name === "process_name" && event.args?.name === "Renderer")
      .map((event) => event.pid),
  )
  const reporters = events
    .filter((event) => event.name === "PipelineReporter" && renderers.has(event.pid))
    // A reporter id is reused: at equal timestamps the previous frame's end comes before the next begin.
    .toSorted((a, b) => a.ts - b.ts || (a.ph === "e" ? 0 : 1) - (b.ph === "e" ? 0 : 1))
  const counts = new Map<number, number>()
  reporters.forEach((event) => counts.set(event.pid, (counts.get(event.pid) ?? 0) + 1))
  // The page's renderer has by far the most frames; other renderers (none in a single-page context) are ignored.
  const pid = [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0]
  const begins = new Map<string, TraceEvent>()
  const merged = new Map<string, { end: number; state: string; missing: boolean; checkerboard: boolean }>()
  for (const event of reporters) {
    if (event.pid !== pid) continue
    const key = event.id2?.local ?? event.id2?.global ?? event.id ?? ""
    if (event.ph === "b") begins.set(key, event)
    if (event.ph !== "e") continue
    const begin = begins.get(key)
    if (!begin) continue
    begins.delete(key)
    if (window && (event.ts < window.start || event.ts > window.end)) continue
    const reporter = (begin.args?.frame_reporter ?? begin.args?.chrome_frame_reporter ?? {}) as FrameReporter
    const frame = `${reporter.frame_source ?? 0}:${reporter.frame_sequence ?? begin.ts}`
    const state = reporter.state ?? "STATE_NO_UPDATE_DESIRED"
    const previous = merged.get(frame)
    const presented = state.startsWith("STATE_PRESENTED")
    const wasPresented = previous?.state.startsWith("STATE_PRESENTED") ?? false
    const better = !previous || (STATE_RANK[state] ?? 0) > (STATE_RANK[previous.state] ?? 0)
    merged.set(frame, {
      // Presentation time: the earliest presented end; without a presented reporter, the earliest end.
      end:
        !previous || (presented && !wasPresented)
          ? event.ts
          : presented === wasPresented
            ? Math.min(previous.end, event.ts)
            : previous.end,
      state: better ? state : previous.state,
      missing: (previous?.missing ?? false) || reporter.has_missing_content === true,
      checkerboard:
        (previous?.checkerboard ?? false) ||
        reporter.checkerboarded_needs_raster === true ||
        reporter.checkerboarded_needs_record === true,
    })
  }
  const frames = [...merged.values()].toSorted((a, b) => a.end - b.end)
  const count = (value: string) => frames.filter((frame) => frame.state === value).length
  const presented = frames.filter((frame) => frame.state.startsWith("STATE_PRESENTED"))
  // Intervals between presented frames while the page kept asking for updates: a frame with nothing to update
  // (idle, e.g. a stream landing off screen) ends the run, a dropped frame extends it (that is the jank). Two
  // sources presenting at the same instant are one frame on screen, so zero-length intervals are dropped.
  const intervals: number[] = []
  let lastPresented: number | undefined
  for (const frame of frames) {
    if (frame.state === "STATE_NO_UPDATE_DESIRED") lastPresented = undefined
    if (!frame.state.startsWith("STATE_PRESENTED")) continue
    if (lastPresented !== undefined && frame.end - lastPresented > 50)
      intervals.push((frame.end - lastPresented) / 1000)
    lastPresented = frame.end
  }
  const expected = frames.filter((frame) => frame.state !== "STATE_NO_UPDATE_DESIRED").length
  const dropped = count("STATE_DROPPED")
  return {
    frames: frames.length,
    presented: presented.length,
    presentedAll: count("STATE_PRESENTED_ALL"),
    presentedPartial: count("STATE_PRESENTED_PARTIAL"),
    dropped,
    noUpdate: count("STATE_NO_UPDATE_DESIRED"),
    droppedRatio: expected ? round(dropped / expected, 4) : null,
    missingContent: frames.filter((frame) => frame.missing).length,
    checkerboarded: frames.filter((frame) => frame.checkerboard).length,
    intervals: summarize(intervals),
    intervalSamples: intervals.map((value) => round(value)),
    spanMs: frames.length ? round((frames.at(-1)!.end - frames[0]!.end) / 1000) : 0,
  }
}

/**
 * Main-thread tasks longer than `minMs` in a profile trace (`OWN_PERF_PROFILE`: `toplevel` task events carry wall and
 * thread time, `disabled-by-default-v8.gc` the collector's phases), classified by what made them long:
 * `gc` (garbage collection is at least half the wall time), `descheduled` (the thread was on a CPU for less than
 * half of it: the machine was busy, not the page) or `work` (script, style, layout, paint of the page). The main
 * thread is the `CrRendererMain` of the process that carries the probe's `ownb:measure:start` mark.
 */
export function traceTasks(
  events: readonly TraceEvent[],
  window: { readonly start: number; readonly end: number },
  minMs = 50,
) {
  const pid = events.find((event) => event.name === "ownb:measure:start")?.pid
  const tid = events.find(
    (event) =>
      event.ph === "M" && event.name === "thread_name" && event.pid === pid && event.args?.name === "CrRendererMain",
  )?.tid
  if (pid === undefined || tid === undefined) return null
  const main = events.filter((event) => event.pid === pid && event.tid === tid && event.ph === "X" && event.dur)
  const gc = main.filter((event) => /^(MajorGC|MinorGC|V8\.GC_)/.test(event.name))
  const tasks = main.filter(
    (event) =>
      event.name === "ThreadControllerImpl::RunTask" &&
      event.ts >= window.start &&
      event.ts <= window.end &&
      event.dur! > minMs * 1_000,
  )
  return tasks.map((task) => {
    const inside = gc
      .filter((event) => event.ts >= task.ts && event.ts < task.ts + task.dur!)
      .map((event) => [event.ts, Math.min(event.ts + event.dur!, task.ts + task.dur!)] as const)
      .toSorted((a, b) => a[0] - b[0])
    // Union of the (nested) GC phase intervals.
    let gcUs = 0
    let reach = -Infinity
    for (const [from, to] of inside) {
      if (to <= reach) continue
      gcUs += to - Math.max(from, reach)
      reach = to
    }
    const wall = task.dur! / 1_000
    const thread = task.tdur === undefined ? null : task.tdur / 1_000
    const gcMs = gcUs / 1_000
    return {
      atMs: round((task.ts - window.start) / 1_000),
      wallMs: round(wall),
      threadMs: thread === null ? null : round(thread),
      gcMs: round(gcMs),
      kind: gcMs >= wall / 2 ? "gc" : thread !== null && thread < wall / 2 ? "descheduled" : "work",
    }
  })
}

/** Long tasks from a `longtask` PerformanceObserver: count above 50 ms and the longest (PF3 "50 ms 넘는 long task 0"). */
export function longTasks(durations: readonly number[]) {
  return {
    count: durations.length,
    over50: durations.filter((value) => value > 50).length,
    max: durations.length ? round(Math.max(...durations)) : 0,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Session switch (PF7)

export interface SwitchSample {
  readonly at: number
  /** The destination's final answer marker is visible in the transcript viewport. */
  readonly last: boolean
  /** Visible markers of the destination and of the source session. */
  readonly destination: number
  readonly source: number
}

/**
 * Upstream `classifySessionSwitch` semantics on marker samples: first correct = destination's last answer visible
 * and nothing of the source visible; stable = three consecutive correct samples (time of the third).
 */
export function classifySwitch(samples: readonly SwitchSample[]) {
  const correct = (sample: SwitchSample) => sample.last && sample.source === 0
  const first = samples.findIndex(correct)
  const stable = samples.findIndex((_, index) => {
    const window = samples.slice(index, index + 3)
    return window.length === 3 && window.every(correct)
  })
  return {
    samples: samples.length,
    firstDestinationObservedMs: samples.find((sample) => sample.destination > 0)?.at ?? null,
    firstCorrectObservedMs: first < 0 ? null : round(samples[first]!.at),
    stableObservedMs: stable < 0 ? null : round(samples[stable + 2]!.at),
    blankSamples: samples.filter((sample) => sample.destination === 0 && sample.source === 0).length,
    sourceSamples: samples.filter((sample) => sample.source > 0).length,
  }
}
