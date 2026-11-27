// PF budgets (01 §6.6 is the source of the numbers; 03 §20.1 defines how own-web measures them) and their
// evaluation over benchmark records. Values are the p95 over all repetitions (the median is recorded too, 03 §20.1):
// per-event and per-frame series are pooled across runs, one-sample-per-run metrics use one value per run.
import { median, percentile, round, EVENT_TIMING_THRESHOLD } from "./metrics"

export interface BenchRecord {
  readonly name: string
  readonly status: string
  readonly repeatEachIndex?: number
  readonly context?: Record<string, unknown>
  readonly metrics: Record<string, unknown> | null
  readonly error?: string
  readonly skipReason?: string
  /** Wall-clock span of the test (epoch ms), for the machine load sampled meanwhile (run.ts). */
  readonly timing?: { readonly startedAt: number; readonly endedAt: number }
}

export type CheckStatus = "pass" | "fail" | "pending"

export interface CheckResult {
  readonly id: string
  readonly pf: string
  readonly label: string
  readonly source: string
  /** Gate checks decide the PF; tracked checks are recorded for review (03 §20.1 "추적 지표"). */
  readonly gate: boolean
  readonly unit: string
  readonly budget: number
  readonly value: number | null
  readonly median: number | null
  readonly aggregation: string
  readonly samples: number
  readonly runs: number
  readonly status: CheckStatus
  readonly reason?: string
}

interface Check {
  readonly id: string
  readonly pf: string
  readonly label: string
  readonly source: string
  readonly gate: boolean
  readonly unit: string
  readonly budget: number
  /** Benchmark name prefix of the records this check reads. */
  readonly bench: string
  readonly aggregation: "p95 pooled" | "p95 per run" | "sum" | "ratio" | "max" | "value"
  /** Values from one passed record (pooled or per run); `null` when the record lacks the metric (e.g. no transcript). */
  readonly read: (metrics: Record<string, unknown>) => number[] | null
  /** For "ratio": numerator and denominator per record. */
  readonly ratio?: (metrics: Record<string, unknown>) => [number, number] | null
}

const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined),
    value,
  )
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)
const list = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : null
const one = (value: unknown) => {
  const found = num(value)
  return found === null ? null : [found]
}

const PF2_INPUT = "PF2 composer input"
const PF4_STREAM = "PF4 streaming"
const PF3_SCROLL = "PF3 timeline scroll"

export const CHECKS: readonly Check[] = [
  {
    id: "PF1.web.cachedList",
    pf: "PF1",
    label: "warm reload: navigationStart → own:sessions-visible (IndexedDB list painted)",
    source: "01 §6.6 PF1 (web variant of 03 §20.1)",
    gate: true,
    unit: "ms",
    budget: 1_000,
    bench: "PF1 session list",
    aggregation: "p95 per run",
    read: (metrics) => one(at(metrics, "warm", "own:sessions-visible")),
  },
  {
    id: "PF1.web.fresh",
    pf: "PF1",
    label: "warm reload: own:sessions-fresh (server list replaced the cache)",
    source: "05 §9.1 shell budget p95 ≤ 2,000 ms (tracked)",
    gate: false,
    unit: "ms",
    budget: 2_000,
    bench: "PF1 session list",
    aggregation: "p95 per run",
    read: (metrics) => one(at(metrics, "warm", "own:sessions-fresh")),
  },
  {
    id: "PF1.web.cold",
    pf: "PF1",
    label: "cold load (no cache): own:sessions-visible",
    source: "tracked",
    gate: false,
    unit: "ms",
    budget: 1_000,
    bench: "PF1 session list",
    aggregation: "p95 per run",
    read: (metrics) => one(at(metrics, "cold", "own:sessions-visible")),
  },
  ...inputChecks("PF2", PF2_INPUT, "idle"),
  ...frameChecks("PF3", PF3_SCROLL, "scroll", (metrics) => metrics),
  ...inputChecks("PF4", PF4_STREAM, "while streaming"),
  ...frameChecks("PF4", PF4_STREAM, "scroll while streaming", (metrics) => at(metrics, "scroll")),
  {
    id: "PF4.anchorJump",
    pf: "PF4",
    label: "after scrolling up, the viewport does not move while deltas land",
    source: "03 §20.1 PF4 (아래 고정이 풀리고 점프하지 않음)",
    gate: true,
    unit: "px",
    budget: 1,
    bench: PF4_STREAM,
    aggregation: "max",
    read: (metrics) => one(at(metrics, "anchor", "jumpPx")),
  },
  {
    id: "PF4.anchorRelease",
    pf: "PF4",
    label: "scrolling up while streaming releases the bottom anchor (1 = pulled back to the tail)",
    source: "03 §20.1 PF4 (아래 고정이 풀리고)",
    gate: true,
    unit: "count",
    budget: 0,
    bench: PF4_STREAM,
    aggregation: "max",
    read: (metrics) => one(at(metrics, "anchor", "pulledBack")),
  },
  {
    id: "PF5.initialJs",
    pf: "PF5",
    label: "initial JS gzip (entry + static imports + modulepreloads)",
    source: "01 §6.6 PF5 (⚠ initial value)",
    gate: true,
    unit: "KB",
    budget: 400,
    bench: "PF5 bundle",
    aggregation: "value",
    read: (metrics) =>
      one(num(at(metrics, "initialJsGzip")) === null ? null : num(at(metrics, "initialJsGzip"))! / 1024),
  },
  {
    id: "PF5.desktopLeak",
    pf: "PF5",
    label: "desktop host code in the first chunk (0 = none)",
    source: "03 §16.1, §20.1 PF5",
    gate: true,
    unit: "count",
    budget: 0,
    bench: "PF5 bundle",
    aggregation: "value",
    read: (metrics) => (typeof at(metrics, "desktopLeak") === "boolean" ? [at(metrics, "desktopLeak") ? 1 : 0] : null),
  },
  {
    id: "PF5.css",
    pf: "PF5",
    label: "initial CSS gzip",
    source: "03 §20.1 PF5 (tracked, not a gate)",
    gate: false,
    unit: "KB",
    budget: 60,
    bench: "PF5 bundle",
    aggregation: "value",
    read: (metrics) => one(num(at(metrics, "cssGzip")) === null ? null : num(at(metrics, "cssGzip"))! / 1024),
  },
  {
    id: "PF7.warm",
    pf: "PF7",
    label: "cached session via sidebar row: mousedown → content (firstCorrectObservedMs)",
    source: "01 §6.6 PF7 (⚠), 03 §20.1",
    gate: true,
    unit: "ms",
    budget: 100,
    bench: "PF7 warm switch",
    aggregation: "p95 per run",
    read: (metrics) => one(at(metrics, "firstCorrectObservedMs")),
  },
  {
    id: "PF7.warm.stable",
    pf: "PF7",
    label: "cached switch: three consecutive correct frames (stableObservedMs)",
    source: "tracked (upstream bench:tabs)",
    gate: false,
    unit: "ms",
    budget: 100,
    bench: "PF7 warm switch",
    aggregation: "p95 per run",
    read: (metrics) => one(at(metrics, "stableObservedMs")),
  },
  {
    id: "PF7.cold",
    pf: "PF7",
    label: "unopened session via sidebar row: mousedown → content",
    source: "03 §20.1 PF7 (tracked, < 500 ms)",
    gate: false,
    unit: "ms",
    budget: 500,
    bench: "PF7 cold entry",
    aggregation: "p95 per run",
    read: (metrics) => one(at(metrics, "firstCorrectObservedMs")),
  },
]

function inputChecks(pf: string, bench: string, phase: string): Check[] {
  return [
    {
      id: `${pf}.processing`,
      pf,
      label: `composer input processing (processingEnd − startTime), Korean IME, ${phase}`,
      source: "01 §6.6 PF2 (p95 ≤ 16 ms, every counted event)",
      gate: true,
      unit: "ms",
      budget: 16,
      bench,
      aggregation: "p95 pooled",
      read: (metrics) => list(at(metrics, "input", "processingSamples")),
    },
    {
      id: `${pf}.eventToPaint`,
      pf,
      label: `composer event → next paint (Event Timing duration; unreported < 16 ms), ${phase}`,
      source: "01 §6.6 PF2 (p95 ≤ 33 ms)",
      gate: true,
      unit: "ms",
      budget: 33,
      bench,
      aggregation: "p95 pooled",
      read: (metrics) =>
        list(at(metrics, "input", "paintSamples"))?.map((value) => (value === 0 ? EVENT_TIMING_THRESHOLD : value)) ??
        null,
    },
  ]
}

function frameChecks(
  pf: string,
  bench: string,
  phase: string,
  pick: (metrics: Record<string, unknown>) => unknown,
): Check[] {
  return [
    {
      id: `${pf}.presentedFrames`,
      pf,
      label: `presented frame interval (CDP trace PipelineReporter), ${phase}`,
      source: "01 §6.6 PF3 (p95 ≤ 16.7 ms)",
      gate: true,
      unit: "ms",
      budget: 16.7,
      bench,
      aggregation: "p95 pooled",
      read: (metrics) => list(at(pick(metrics), "presentedIntervals")),
    },
    {
      id: `${pf}.longFrameRatio`,
      pf,
      label: `rAF intervals above 2F = 33.4 ms (F = 16.7 ms, not the display's refresh), ${phase}`,
      source: "03 §20.1 (≤ 1%, ⚠ initial value; 01 open question 51) with F = 01 §6.6's 16.7 ms budget",
      gate: true,
      unit: "ratio",
      budget: 0.01,
      bench,
      aggregation: "ratio",
      read: () => null,
      ratio: (metrics) => {
        const long = num(at(pick(metrics), "raf", "longFrames"))
        const frames = num(at(pick(metrics), "raf", "frames"))
        return long === null || frames === null ? null : [long, frames]
      },
    },
    {
      id: `${pf}.longTasks`,
      pf,
      label: `long tasks over 50 ms, ${phase}`,
      source: "01 §6.6 PF3 (0)",
      gate: true,
      unit: "count",
      budget: 0,
      bench,
      aggregation: "sum",
      read: (metrics) => one(at(pick(metrics), "longTasks", "over50")),
    },
  ]
}

/** Evaluates every check over the records; PF5 comes from the bundle-size script as a synthetic record. */
export function evaluate(records: readonly BenchRecord[]) {
  const checks = CHECKS.map((check): CheckResult => {
    const matching = records.filter((record) => record.name.startsWith(check.bench))
    const passed = matching.filter((record) => record.status === "passed" && record.metrics)
    const skipped = matching.filter((record) => record.status === "skipped")
    const failed = matching.filter((record) => record.status !== "passed" && record.status !== "skipped")
    const base = {
      id: check.id,
      pf: check.pf,
      label: check.label,
      source: check.source,
      gate: check.gate,
      unit: check.unit,
      budget: check.budget,
      aggregation: check.aggregation,
    }
    if (check.aggregation === "ratio") {
      const pairs = passed.map((record) => check.ratio!(record.metrics!)).filter((pair) => pair !== null)
      const total = pairs.reduce((sum, pair) => sum + pair[1], 0)
      const value = total ? round(pairs.reduce((sum, pair) => sum + pair[0], 0) / total, 4) : null
      return finish(base, value, null, total, pairs.length, failed, skipped, passed.length)
    }
    const perRun = passed.map((record) => check.read(record.metrics!)).filter((values) => values !== null)
    const values = perRun.flat()
    const value = !values.length
      ? null
      : check.aggregation === "sum"
        ? values.reduce((sum, item) => sum + item, 0)
        : check.aggregation === "max" || check.aggregation === "value"
          ? Math.max(...values)
          : percentile(values, 95)
    return finish(
      base,
      value === null ? null : round(value),
      median(values),
      values.length,
      perRun.length,
      failed,
      skipped,
      passed.length,
    )
  })
  const pfs = ["PF1", "PF2", "PF3", "PF4", "PF5", "PF7"].map((pf) => {
    const own = checks.filter((check) => check.pf === pf && check.gate)
    const status: CheckStatus = own.some((check) => check.status === "fail")
      ? "fail"
      : own.some((check) => check.status === "pending")
        ? "pending"
        : "pass"
    return { pf, status, reasons: [...new Set(own.flatMap((check) => (check.reason ? [check.reason] : [])))] }
  })
  return { checks, pfs }
}

function finish(
  base: Omit<CheckResult, "value" | "median" | "samples" | "runs" | "status" | "reason">,
  value: number | null,
  middle: number | null,
  samples: number,
  runs: number,
  failed: readonly BenchRecord[],
  skipped: readonly BenchRecord[],
  passedRecords: number,
): CheckResult {
  const common = { ...base, value, median: middle === null ? null : round(middle), samples, runs }
  // A failed repetition fails the check: the gate runs without retries (03 §20.4).
  if (failed.length)
    return {
      ...common,
      status: "fail",
      reason: `${failed.length} run(s) failed: ${failed[0]!.error ?? failed[0]!.status}`,
    }
  if (value === null) {
    const reason = skipped[0]?.skipReason
      ? `skipped: ${skipped[0].skipReason}`
      : passedRecords
        ? "metric not measured in passed runs (module not rendering the fixture yet)"
        : "no benchmark records"
    return { ...common, status: "pending", reason }
  }
  return { ...common, status: value <= base.budget ? "pass" : "fail" }
}
