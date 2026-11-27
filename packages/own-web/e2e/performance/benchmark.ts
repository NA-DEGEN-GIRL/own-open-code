// Vendored from packages/app/e2e/performance/benchmark.ts @ bd55d4895f (MIT). See own/ledger/vendored.yaml
// Local changes (marked OWN): records are also appended to $OWN_PERF_RESULTS (JSONL) for run.ts; skipped
// benchmarks (e.g. a module that does not render fixture content yet) emit a record instead of failing; records
// carry their wall-clock span (`timing`).
import { expect, test as base, type Browser, type Page, type TestInfo } from "@playwright/test"
import { appendFileSync } from "node:fs"
import { startChromeTrace } from "./chrome-trace"

type BenchmarkFixtures = {
  report: (metrics: Record<string, unknown>, context?: Record<string, unknown>) => void
  reportState: { payload?: { metrics: Record<string, unknown>; context: Record<string, unknown> } }
  benchmarkResult: void
  traceScope: "page" | "interaction"
}

export type PerformancePageDiagnostics = {
  navigations: string[]
  traceScope: "page" | "interaction"
  startTrace: () => Promise<void>
  stop: () => Promise<string | undefined>
}

const pages = new WeakMap<Page, PerformancePageDiagnostics>()

export const benchmark = base.extend<BenchmarkFixtures>({
  traceScope: ["page", { option: true }],
  reportState: async ({}, use) => use({}),
  report: async ({ reportState }, use) => {
    await use((metrics, context = {}) => {
      if (reportState.payload) throw new Error("Benchmark reported metrics more than once")
      reportState.payload = { metrics, context }
    })
  },
  benchmarkResult: [
    async ({ reportState }, use, testInfo) => {
      const startedAt = Date.now() // OWN
      await use()
      const missing = !reportState.payload
      // OWN: a skipped benchmark is a record with its reason, not a missing report.
      const skipped = testInfo.status === "skipped"
      const record = {
        schemaVersion: 2,
        runID: process.env.OPENCODE_PERFORMANCE_RUN_ID,
        name: benchmarkName(testInfo),
        status: missing && !skipped ? "failed" : testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        retry: testInfo.retry,
        repeatEachIndex: testInfo.repeatEachIndex,
        context: {
          project: testInfo.project.name,
          platform: process.platform,
          ...reportState.payload?.context,
        },
        metrics: reportState.payload?.metrics ?? null,
        error:
          missing && !skipped
            ? (testInfo.error?.message ?? "Benchmark did not report metrics")
            : testInfo.status === "failed"
              ? testInfo.error?.message
              : undefined,
        skipReason: skipped ? testInfo.annotations.find((item) => item.type === "skip")?.description : undefined,
        // OWN: wall-clock span of the test (epoch ms), so run.ts can attach the machine load sampled meanwhile.
        timing: { startedAt, endedAt: Date.now() },
      }
      // OWN: the console line abbreviates raw sample arrays; run.ts reads the full record from $OWN_PERF_RESULTS.
      console.log(`BENCHMARK ${JSON.stringify(record, abbreviateSamples)}`)
      if (process.env.OWN_PERF_RESULTS) appendFileSync(process.env.OWN_PERF_RESULTS, `${JSON.stringify(record)}\n`)
      if (missing && !skipped && testInfo.status === testInfo.expectedStatus)
        throw new Error(`Benchmark did not report metrics: ${benchmarkName(testInfo)}`)
    },
    { auto: true },
  ],
  page: async ({ page, traceScope }, use, testInfo) => {
    const name = benchmarkName(testInfo)
    const diagnostics = await observePerformancePage(page, name, traceScope)
    try {
      await use(page)
    } finally {
      try {
        await reportPerformancePage(name, diagnostics, testInfo)
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach("performance-navigations", {
            body: JSON.stringify(diagnostics.navigations, null, 2),
            contentType: "application/json",
          })
        }
      }
    }
  },
})

// OWN
function abbreviateSamples(_key: string, value: unknown) {
  return Array.isArray(value) && value.length > 32 && typeof value[0] === "number" ? `[${value.length} samples]` : value
}

function benchmarkName(testInfo: TestInfo) {
  return testInfo.titlePath.slice(1).join(" > ")
}

export { expect }

async function observePerformancePage(page: Page, name: string, traceScope: "page" | "interaction" = "page") {
  const navigations: string[] = []
  const onNavigation = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  }
  page.on("framenavigated", onNavigation)
  let stopTrace: Awaited<ReturnType<typeof startChromeTrace>>
  let stopping: Promise<string | undefined> | undefined
  const diagnostics: PerformancePageDiagnostics = {
    navigations,
    traceScope,
    async startTrace() {
      stopTrace ??= await startChromeTrace(page, name).catch((error) => {
        page.off("framenavigated", onNavigation)
        throw error
      })
    },
    stop() {
      page.off("framenavigated", onNavigation)
      return (stopping ??= stopTrace?.() ?? Promise.resolve(undefined))
    },
  }
  pages.set(page, diagnostics)
  if (traceScope === "page") await diagnostics.startTrace()
  return diagnostics
}

export async function withBenchmarkPage<T>(
  browser: Browser,
  name: string,
  run: (page: Page) => Promise<T>,
  testInfo?: TestInfo,
) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const diagnostics = await observePerformancePage(page, name)
    try {
      return await run(page)
    } finally {
      await reportPerformancePage(name, diagnostics, testInfo)
    }
  } finally {
    await context.close()
  }
}

async function reportPerformancePage(name: string, diagnostics: PerformancePageDiagnostics, testInfo?: TestInfo) {
  const trace = await diagnostics.stop()
  console.log(
    `BENCHMARK_PAGE ${JSON.stringify({
      schemaVersion: 2,
      runID: process.env.OPENCODE_PERFORMANCE_RUN_ID,
      name,
      test: testInfo ? benchmarkName(testInfo) : undefined,
      retry: testInfo?.retry,
      repeatEachIndex: testInfo?.repeatEachIndex,
      context: {
        platform: process.platform,
        trace,
        traceScope: diagnostics.traceScope,
        selectorTrace: process.env.OPENCODE_PERFORMANCE_SELECTOR_TRACE === "1",
      },
      navigations: diagnostics.navigations,
    })}`,
  )
}

export function benchmarkDiagnostics(page: Page) {
  const diagnostics = pages.get(page)
  if (!diagnostics) throw new Error("Performance diagnostics are not installed for this page")
  return diagnostics
}
