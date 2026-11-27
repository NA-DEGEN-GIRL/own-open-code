// Transcript bench on the fixture harness (no server): builds e2e/transcript-harness.html in production mode, serves
// it with `vite preview`, and measures in the installed Edge (03 §20.1 methods):
//   PF3  wheel scroll through the 2,000-message session (40 % tool steps) for 10 s: rAF intervals > 2F (F = idle
//        median), intervals > 33.4 ms, long tasks > 50 ms;
//   PF4  200 deltas/s streaming while (a) following the tail and (b) scrolled up with typing: anchor movement and
//        keydown processing (`performance.now() − event.timeStamp`);
//   PF7  switching between two already opened sessions: route change → first frame with the destination's rows.
// The full-app gate (real server, sidebar clicks, CDP frame traces) is e2e/performance; this bench isolates the
// transcript so a regression points at it. Usage: `bun e2e/transcript-bench.ts [--headed] [--repeat 3]`.
import { chromium, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { build, preview } from "vite"

const PACKAGE = path.join(import.meta.dir, "..")
const OUT = path.join(os.tmpdir(), "own-web-transcript-bench")
const PORT = Number(process.env.OWN_TRANSCRIPT_BENCH_PORT ?? 5194)
// The harness needs no API; keep vite.config.ts from resolving a local service registration.
process.env.OWN_WEB_API_URL ??= "http://127.0.0.1:9"
const args = process.argv.slice(2)
const repeat = Number(args[args.indexOf("--repeat") + 1] || 1)

await build({
  configFile: path.join(PACKAGE, "vite.config.ts"),
  root: PACKAGE,
  logLevel: "warn",
  build: {
    outDir: OUT,
    emptyOutDir: true,
    rollupOptions: { input: path.join(PACKAGE, "e2e/transcript-harness.html") },
  },
})
const server = await preview({
  configFile: path.join(PACKAGE, "vite.config.ts"),
  root: PACKAGE,
  build: { outDir: OUT },
  preview: { port: PORT, strictPort: true, host: "127.0.0.1" },
  logLevel: "warn",
})
const url = `http://127.0.0.1:${PORT}/e2e/transcript-harness.html`
const browser = await chromium.launch({ channel: "msedge", headless: !args.includes("--headed") })

try {
  for (let run = 0; run < repeat; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(url)
    await page.waitForFunction(() => "__transcript" in window)
    report("PF3 transcript scroll (fixture, 2,000 messages)", await scroll(page))
    report("PF4 transcript streaming (fixture, 200 deltas/s)", await streaming(page))
    report("PF7 transcript session switch (fixture, warm)", await switching(page))
    if (errors.length) console.log(`errors: ${errors.join(" | ")}`)
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
  await fs.rm(OUT, { recursive: true, force: true })
}

function report(name: string, metrics: Record<string, unknown>) {
  console.log(
    `BENCHMARK ${JSON.stringify({ name, context: { browser: browser.version(), build: "production" }, metrics })}`,
  )
}

async function open(page: Page, sessionID: string) {
  await page.evaluate((id) => (window as unknown as Harness).__transcript.open(id), sessionID)
  await page.waitForSelector(
    `[data-testid="transcript-body"][data-session-id="${sessionID}"] [data-testid="turn-footer"]`,
  )
}

async function startProbe(page: Page) {
  await page.evaluate(() => {
    const probe = { gaps: [] as number[], long: [] as number[], frames: [] as unknown[], stop: false }
    Object.assign(window, { __probe: probe })
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => probe.long.push(entry.duration))).observe({
      type: "longtask",
    })
    // Long animation frames (> 30 ms) with their script attribution, to tell script from style/layout work.
    new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => {
        const frame = entry as PerformanceEntry & {
          renderStart: number
          styleAndLayoutStart: number
          blockingDuration: number
          scripts: { sourceFunctionName: string; sourceURL: string; duration: number; invoker: string }[]
        }
        if (frame.duration < 30) return
        probe.frames.push({
          duration: Math.round(frame.duration),
          script: Math.round(frame.renderStart ? frame.renderStart - frame.startTime : frame.duration),
          layout: Math.round(
            frame.styleAndLayoutStart ? frame.startTime + frame.duration - frame.styleAndLayoutStart : 0,
          ),
          scripts: frame.scripts
            .filter((item) => item.duration > 5)
            .map(
              (item) =>
                `${item.invoker} ${item.sourceFunctionName}@${item.sourceURL.split("/").at(-1)} ${Math.round(item.duration)}ms`,
            ),
        })
      }),
    ).observe({ type: "long-animation-frame" })
    let last = performance.now()
    const loop = (time: number) => {
      probe.gaps.push(time - last)
      last = time
      if (!probe.stop) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
}

async function stopProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (
      window as unknown as { __probe: { gaps: number[]; long: number[]; frames: unknown[]; stop: boolean } }
    ).__probe
    probe.stop = true
    return { gaps: probe.gaps.slice(), long: probe.long.slice(), frames: probe.frames.slice() }
  })
}

function frameStats(gaps: number[], F: number) {
  const sorted = gaps.toSorted((a, b) => a - b)
  const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0)
  return {
    frames: gaps.length,
    refreshMs: round(F),
    over2F: gaps.filter((gap) => gap > 2 * F).length,
    over2FRatio: round(gaps.filter((gap) => gap > 2 * F).length / Math.max(1, gaps.length), 4),
    over33ms: gaps.filter((gap) => gap > 33.4).length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: round(sorted.at(-1) ?? 0),
  }
}

async function idleRefresh(page: Page) {
  await startProbe(page)
  await page.waitForTimeout(1_000)
  const idle = await stopProbe(page)
  return idle.gaps.toSorted((a, b) => a - b)[Math.floor(idle.gaps.length / 2)] ?? 16.7
}

async function scrollGeometry(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('[data-testid="transcript-body"] [data-timeline-virtual-content]')
    const scroller = content?.parentElement as HTMLElement | undefined
    return { top: scroller?.scrollTop ?? 0, max: scroller ? scroller.scrollHeight - scroller.clientHeight : 0 }
  })
}

async function scroll(page: Page) {
  const opened = performance.now()
  await open(page, "ses_perf")
  const entryMs = performance.now() - opened
  await page.waitForTimeout(1_000)
  const F = await idleRefresh(page)
  const box = (await page.getByTestId("transcript-body").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const before = await scrollGeometry(page)
  await startProbe(page)
  const started = Date.now()
  let direction = -1
  let highest = before.top
  while (Date.now() - started < 10_000) {
    await page.mouse.wheel(0, direction * 240)
    await page.waitForTimeout(16)
    if (Date.now() - started > 5_000) direction = 1
    else highest = Math.min(highest, (await scrollGeometry(page)).top)
  }
  const probe = await stopProbe(page)
  const after = await scrollGeometry(page)
  const mounted = await page.evaluate(() => document.querySelectorAll("[data-timeline-key]").length)
  return {
    entryMs: Math.round(entryMs),
    ...frameStats(probe.gaps, F),
    longTasks: probe.long.filter((duration) => duration > 50).map(round),
    scrolledPx: Math.round(before.top - highest),
    endOffBottomPx: Math.round(after.max - after.top),
    longFrames: probe.frames,
    scrollHeight: Math.round(before.max),
    mountedRows: mounted,
  }
}

async function streaming(page: Page) {
  await open(page, "ses_small")
  const F = await idleRefresh(page)
  // (a) following: the viewport stays at the bottom while the answer grows.
  const follow = page.evaluate(() =>
    (window as unknown as Harness).__transcript.stream({ sessionID: "ses_small", deltas: 600, perSecond: 200 }),
  )
  let offBottom = 0
  for (let index = 0; index < 20; index++) {
    await page.waitForTimeout(100)
    const geometry = await scrollGeometry(page)
    offBottom = Math.max(offBottom, geometry.max - geometry.top)
  }
  await follow
  // (b) scrolled up + typing: the anchor must not move; keydown processing stays under one frame.
  const box = (await page.getByTestId("transcript-body").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let index = 0; index < 6; index++) {
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(300)
  const anchor = (await scrollGeometry(page)).top
  await page.evaluate(() => (window as unknown as Harness).__transcript.inputLatencies())
  await startProbe(page)
  const stream = page.evaluate(() =>
    (window as unknown as Harness).__transcript.stream({ sessionID: "ses_small", deltas: 2_000, perSecond: 200 }),
  )
  await page.getByTestId("harness-input").focus()
  let moved = 0
  for (let index = 0; index < 40; index++) {
    await page.keyboard.type("abcd", { delay: 25 })
    moved = Math.max(moved, Math.abs((await scrollGeometry(page)).top - anchor))
  }
  await stream
  const probe = await stopProbe(page)
  const inputs = await page.evaluate(() => (window as unknown as Harness).__transcript.inputLatencies())
  const sorted = inputs.toSorted((a, b) => a - b)
  return {
    followMaxOffBottomPx: Math.round(offBottom),
    anchorMovedPx: Math.round(moved),
    keydowns: inputs.length,
    keydownP95Ms: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    keydownMaxMs: round(sorted.at(-1) ?? 0),
    ...frameStats(probe.gaps, F),
    longTasks: probe.long.filter((duration) => duration > 50).map(round),
    longFrames: probe.frames,
  }
}

async function switching(page: Page) {
  // Both sessions were opened above (warm: messages in memory, measurements cached).
  const samples: number[] = []
  for (let index = 0; index < 10; index++) {
    const target = index % 2 === 0 ? "ses_perf" : "ses_small"
    const ms = await page.evaluate(
      (id) =>
        new Promise<number>((resolve) => {
          const started = performance.now()
          ;(window as unknown as Harness).__transcript.open(id)
          const check = () => {
            const body = document.querySelector(`[data-testid="transcript-body"][data-session-id="${id}"]`)
            const row = body?.querySelector('[data-testid="turn-footer"]')
            if (row && row.getBoundingClientRect().height > 0) return resolve(performance.now() - started)
            requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
      target,
    )
    samples.push(ms)
    await page.waitForTimeout(300)
  }
  const sorted = samples.toSorted((a, b) => a - b)
  return {
    samples: samples.map(round),
    median: round(sorted[Math.floor(sorted.length / 2)]!),
    p95: round(sorted[Math.floor(sorted.length * 0.95)] ?? sorted.at(-1)!),
  }
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

type Harness = {
  __transcript: {
    open(id: string): void
    stream(input: { sessionID: string; deltas: number; perSecond: number }): Promise<{ durationMs: number }>
    inputLatencies(): number[]
  }
}
