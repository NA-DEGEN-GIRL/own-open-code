// Unit tests for the harness math (run: `bun test e2e/performance` from packages/own-web).
import { describe, expect, test } from "bun:test"
import { evaluate, type BenchRecord } from "./budgets"
import { buildHistory, lastMarker, marker } from "./fixture/history"
import {
  classifySwitch,
  inputLatency,
  inputUnits,
  median,
  percentile,
  rafFrames,
  traceFrames,
  traceTasks,
  type TraceEvent,
} from "./metrics"
import { busyShare, loadBetween } from "./load"
import { imeSteps } from "./support"

describe("percentiles", () => {
  test("nearest rank and even-count median", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile([3, 1, 2], 50)).toBe(2)
    expect(percentile([], 95)).toBeNull()
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe("input latency (PF2 definition)", () => {
  const events = [
    { type: "keydown", start: 100, end: 100.4 },
    { type: "compositionupdate", start: 100.5, end: 100.9 },
    { type: "input", start: 100.9, end: 101.2 },
    { type: "keydown", start: 200, end: 230 },
  ]
  const timings = [{ name: "keydown", startTime: 200, processingStart: 201, processingEnd: 232, duration: 48 }]

  test("every event counts; Event Timing overrides processing and supplies event → paint", () => {
    const result = inputLatency(events, timings)
    expect(result.events).toBe(4)
    expect(result.eventTimingReported).toBe(1)
    expect(result.processing.max).toBe(32)
    expect(result.over16).toBe(1)
    expect(result.paintSamples).toEqual([0, 0, 0, 48])
    expect(result.eventToPaintP95).toBe(48)
  })

  test("unreported events are below the 16 ms threshold (upper bound)", () => {
    expect(inputLatency(events.slice(0, 3), []).eventToPaintP95).toBe(16)
  })

  test("events dispatched back to back form one input unit", () => {
    expect(inputUnits(events).map((value) => Math.round(value * 10) / 10)).toEqual([1.2, 30])
  })
})

describe("frames", () => {
  test("rAF long-frame ratio uses 2F with F fixed at 16.7 ms, not the display's refresh", () => {
    // A 240 Hz display (idle F 4.16 ms) whose frame clock runs at 120 Hz, with one 20.8 ms and one 50 ms gap.
    const gaps = [8.33, 8.33, 8.33, 20.8, 8.33, 50, 8.33, 8.34]
    const times = gaps.reduce((list, gap) => [...list, list.at(-1)! + gap], [0])
    const result = rafFrames(times, 4.16)
    expect(result.frames).toBe(8)
    expect(result.thresholdMs).toBe(33.4)
    expect(result.longFrames).toBe(1)
    expect(result.longFrameRatio).toBe(0.125)
    expect(result.overBudget).toBe(2)
    expect(result.refresh).toEqual({ idleMs: 4.16, idleHz: 240.4, activeMs: 8.33, activeHz: 120 })
    // The display-normalized count (the old definition, 2F = 8.32 ms) calls every 120 Hz frame long.
    expect(result.displayNormalized.longFrames).toBe(8)
  })

  test("on a 60 Hz display the fixed threshold matches 03's display-normalized one", () => {
    const result = rafFrames([0, 16.67, 33.33, 66.8, 83.47], 16.67)
    expect(result.longFrames).toBe(1)
    expect(result.displayNormalized.longFrames).toBe(1)
  })

  const meta: TraceEvent[] = [
    { name: "process_name", ph: "M", pid: 1, ts: 0, args: { name: "Browser" } },
    { name: "process_name", ph: "M", pid: 2, ts: 0, args: { name: "Renderer" } },
  ]
  const reporter = (pid: number, id: string, sequence: number, state: string, begin: number, end: number) => [
    {
      name: "PipelineReporter",
      ph: "b",
      pid,
      ts: begin,
      id2: { local: id },
      args: { frame_reporter: { state, frame_sequence: sequence, frame_source: 1 } },
    },
    { name: "PipelineReporter", ph: "e", pid, ts: end, id2: { local: id } },
  ]

  test("PipelineReporter: merges reporters of one frame, ignores the browser, windows by time", () => {
    const events: TraceEvent[] = [
      ...meta,
      // Browser-process frames are not the page's.
      ...reporter(1, "0x1", 1, "STATE_PRESENTED_ALL", 0, 4_000),
      // Frame 1: main-thread reporter (no update) + compositor reporter (presented).
      ...reporter(2, "0x2", 1, "STATE_NO_UPDATE_DESIRED", 0, 3_000),
      ...reporter(2, "0x3", 1, "STATE_PRESENTED_ALL", 0, 4_167),
      // Frame 2 presented one vsync later; frame 3 dropped; frame 4 presented two vsyncs after frame 2.
      ...reporter(2, "0x3", 2, "STATE_PRESENTED_ALL", 4_167, 8_333),
      ...reporter(2, "0x3", 3, "STATE_DROPPED", 8_333, 12_500),
      ...reporter(2, "0x3", 4, "STATE_PRESENTED_PARTIAL", 12_500, 16_667),
      // Idle frame (nothing to update), then a presented frame: an idle gap is not an interval.
      ...reporter(2, "0x3", 5, "STATE_NO_UPDATE_DESIRED", 16_667, 18_000),
      ...reporter(2, "0x3", 6, "STATE_PRESENTED_ALL", 18_000, 19_000),
      // Outside the window.
      ...reporter(2, "0x3", 7, "STATE_PRESENTED_ALL", 19_000, 90_000),
    ]
    const result = traceFrames(events, { start: 0, end: 20_000 })
    expect(result.frames).toBe(6)
    expect(result.presented).toBe(4)
    expect(result.presentedPartial).toBe(1)
    expect(result.dropped).toBe(1)
    expect(result.droppedRatio).toBe(0.2)
    expect(result.intervalSamples).toEqual([4.17, 8.33])
  })
})

describe("machine load", () => {
  test("busy share from CPU time deltas, summarized per time span", () => {
    expect(busyShare({ busy: 100, total: 1_000 }, { busy: 400, total: 2_000 })).toBe(30)
    expect(busyShare({ busy: 1, total: 1 }, { busy: 1, total: 1 })).toBeNull()
    const samples = [10, 20, 30, 40].map((busy, index) => ({ at: 1_000 * (index + 1), busy }))
    expect(loadBetween(samples, 1_000, 3_000)).toMatchObject({ count: 2, mean: 25, max: 30 })
  })
})

describe("profile trace tasks", () => {
  test("long main-thread tasks are classified as gc, descheduled or work", () => {
    const task = (ts: number, dur: number, tdur: number, tid = 7): TraceEvent => ({
      name: "ThreadControllerImpl::RunTask",
      ph: "X",
      pid: 2,
      tid,
      ts,
      dur,
      tdur,
    })
    const events: TraceEvent[] = [
      { name: "thread_name", ph: "M", pid: 2, tid: 7, ts: 0, args: { name: "CrRendererMain" } },
      { name: "ownb:measure:start", ph: "R", pid: 2, tid: 7, ts: 1_000 },
      // GC: nested phases count once (70 ms of 80).
      task(2_000, 80_000, 75_000),
      { name: "MajorGC", ph: "X", pid: 2, tid: 7, ts: 5_000, dur: 70_000 },
      { name: "V8.GC_MC_MARK", ph: "X", pid: 2, tid: 7, ts: 6_000, dur: 40_000 },
      // Descheduled: 60 ms on the wall, 9 ms on a CPU.
      task(100_000, 60_000, 9_000),
      // Work, a short task, and another thread's long task.
      task(200_000, 55_000, 50_000),
      task(300_000, 20_000, 20_000),
      task(300_000, 90_000, 90_000, 8),
    ]
    expect(traceTasks(events, { start: 1_000, end: 1_000_000 })).toEqual([
      { atMs: 1, wallMs: 80, threadMs: 75, gcMs: 70, kind: "gc" },
      { atMs: 99, wallMs: 60, threadMs: 9, gcMs: 0, kind: "descheduled" },
      { atMs: 199, wallMs: 55, threadMs: 50, gcMs: 0, kind: "work" },
    ])
  })
})

describe("session switch", () => {
  test("first correct needs the destination's last answer and no source; stable needs three in a row", () => {
    const samples = [
      { at: 5, last: false, destination: 0, source: 3 },
      { at: 10, last: false, destination: 0, source: 0 },
      { at: 20, last: true, destination: 4, source: 1 },
      { at: 30, last: true, destination: 4, source: 0 },
      { at: 40, last: true, destination: 4, source: 0 },
      { at: 50, last: true, destination: 4, source: 0 },
    ]
    const result = classifySwitch(samples)
    expect(result.firstCorrectObservedMs).toBe(30)
    expect(result.stableObservedMs).toBe(50)
    expect(result.blankSamples).toBe(1)
    expect(result.sourceSamples).toBe(2)
  })
})

describe("Korean IME steps", () => {
  test("2-beolsik composition states, commit on the next syllable, final commit", () => {
    const steps = imeSteps("안녕")
    expect(steps.map((step) => step.compose ?? step.insert)).toEqual(["ㅇ", "아", "안", "ㄴ", "녀", "녕", " "])
    expect(steps[3]!.commit).toBe("안")
    expect(steps.at(-1)!.commit).toBe("녕")
    expect(steps[0]!.key).toBe("D")
  })
})

describe("fixture", () => {
  test("2,000 messages with 40% carrying tool cards, markers in order", () => {
    const history = buildHistory({ tag: "A", turns: 1_000, model: { id: "m", providerID: "p" } })
    expect(history.stats.messages).toBe(2_000)
    expect(history.stats.messagesWithTools / history.stats.messages).toBeCloseTo(0.4, 2)
    const text = JSON.stringify(history.messages.at(-1))
    expect(text).toContain(lastMarker("A", 1_000))
    expect(JSON.stringify(history.messages[0])).toContain(marker("A", 0, "U"))
    const ids = history.messages.map((message) => message.id)
    expect(ids).toEqual(ids.toSorted())
  })
})

describe("budget evaluation", () => {
  const record = (name: string, metrics: Record<string, unknown> | null, status = "passed"): BenchRecord => ({
    name,
    status,
    metrics,
    skipReason: status === "skipped" ? "transcript skeleton" : undefined,
  })
  const input = (processing: number, paint: number) => ({
    input: { processingSamples: Array(100).fill(processing), paintSamples: Array(100).fill(paint) },
  })

  test("pass, fail and pending per PF", () => {
    const result = evaluate([
      record("PF1 session list", { warm: { "own:sessions-visible": 80, "own:sessions-fresh": 120 }, cold: {} }),
      record("PF2 composer input", input(0.4, 0)),
      record("PF3 timeline scroll", null, "skipped"),
      record("PF4 streaming", { ...input(30, 0), scroll: null, anchor: null }),
      record("PF5 bundle size", { initialJsGzip: 120_000, cssGzip: 8_000, desktopLeak: false }),
      record("PF7 warm switch", null, "skipped"),
    ])
    const status = Object.fromEntries(result.pfs.map((item) => [item.pf, item.status]))
    expect(status).toEqual({ PF1: "pass", PF2: "pass", PF3: "pending", PF4: "fail", PF5: "pass", PF7: "pending" })
    const paint = result.checks.find((check) => check.id === "PF2.eventToPaint")!
    expect(paint.value).toBe(16)
    expect(result.checks.find((check) => check.id === "PF4.processing")!.status).toBe("fail")
    expect(result.checks.find((check) => check.id === "PF4.presentedFrames")!.status).toBe("pending")
  })

  test("a failed repetition fails the check", () => {
    const result = evaluate([
      record("PF2 composer input", input(1, 0)),
      { ...record("PF2 composer input", null, "failed"), error: "boom" },
    ])
    expect(result.checks.find((check) => check.id === "PF2.processing")!.status).toBe("fail")
  })
})
