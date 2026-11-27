// Node-side helpers for the performance benchmarks: fixture state, app navigation, CDP input and scroll drivers,
// and the frame trace. In-page code lives in probes.ts.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test, type CDPSession, type Page } from "@playwright/test"
import type { HistoryStats } from "./fixture/history"
import { hz, longTasks, rafFrames, round, traceFrames, traceTasks, type TraceEvent } from "./metrics"
import { findScroller, idleRefresh, installMarkerLocator, markerState, startFrameProbe, stopFrameProbe } from "./probes"

export interface PerfSession {
  readonly id: string
  readonly title: string
  readonly tag: string
  readonly turns: number
  readonly lastMarker: string
  readonly stats: HistoryStats
}

export interface PerfState {
  readonly root: string
  readonly preview: string
  readonly control: string
  readonly workspace: string
  readonly account: { readonly id: string; readonly providerID: string; readonly label: string }
  readonly model: string
  readonly provider: { readonly url: string }
  readonly sessions: {
    readonly a: PerfSession
    readonly b: PerfSession
    readonly s: PerfSession
    /** The split-panes bench's streaming pair: A and B never get a new turn (PF7, PF3), S only PF4's. */
    readonly t: PerfSession
    readonly u: PerfSession
  }
  readonly fillers: readonly { readonly id: string; readonly title: string }[]
  readonly setup: Record<string, unknown>
}

export const STATE_FILE = path.join(os.tmpdir(), "own-web-perf", "backend.json")

/** Written by e2e/performance/backend.ts once the server, fixtures and `vite preview` are up. */
export function perfState(): PerfState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PerfState
}

/**
 * The composer's text element. The skeleton uses `#own-composer-input`; the list also covers a textarea or
 * contenteditable inside `[data-testid="composer"]` so the bench keeps working when the composer module lands.
 */
export const COMPOSER =
  process.env.OWN_PERF_COMPOSER ??
  '#own-composer-input, [data-testid="composer"] textarea, [data-testid="composer"] [contenteditable="true"]'

export const TRANSCRIPT_PENDING =
  "the transcript shows no fixture message within 30 s (module not rendering messages yet); PF3, PF4 scroll and PF7 need it"

/**
 * Opens a route of the production build with full input sampling (`?own-bench`, 03 §20.1) and the launcher's
 * control location fragment (02 §9.1), then waits for the event stream.
 */
export async function openApp(page: Page, state: PerfState, route = "/") {
  await page.goto(`${state.preview}${route}?own-bench#control=${encodeURIComponent(state.control)}`)
  await page.getByTestId("server-status").and(page.locator('[data-status="connected"]')).waitFor({ timeout: 30_000 })
}

export const sessionRoute = (id: string) => `/srv/local/s/${encodeURIComponent(id)}`

/**
 * Waits until `target` is visible in the transcript viewport: one exact marker, or any marker of the given tags.
 * `false` after the timeout.
 */
export async function waitForMarker(page: Page, target: string | readonly string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await page.evaluate(installMarkerLocator)
    await page.evaluate(findScroller)
    const state = await page.evaluate(markerState, typeof target === "string" ? [target] : [])
    if (typeof target === "string" ? state.wanted[target] : target.some((tag) => (state.visible[tag] ?? 0) > 0))
      return true
    await page.waitForTimeout(100)
  }
  return false
}

/** Scrolls the transcript to its end until the height stops changing (virtualized rows re-measure on the way). */
export async function scrollToBottom(page: Page) {
  await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>("[data-ownb-scroller]")
    for (let round = 0; scroller && round < 20; round++) {
      const height = scroller.scrollHeight
      scroller.scrollTop = scroller.scrollHeight
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (scroller.scrollHeight === height && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1)
        return
    }
  })
}

/** Resolves once the transcript's scroll height and position stayed the same for two frames at the bottom. */
export async function waitForStableBottom(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const scroller = document.querySelector<HTMLElement>("[data-ownb-scroller]")
        if (!scroller) return resolve(true)
        const height = scroller.scrollHeight
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve(
              scroller.scrollHeight === height &&
                scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1,
            ),
          ),
        )
      }),
    undefined,
    { timeout: 20_000 },
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Korean IME typing through CDP (03 §12, PF2): `Input.imeSetComposition` for each jamo state, `Input.insertText`
// to commit, and a keydown 229 ("Process") before each like a Windows IME.

const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
const MEDIALS = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
const FINALS = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"
/** 2-beolsik key positions (first component for compound jamo). */
const KEYS: Record<string, string> = Object.fromEntries(
  [..."ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔㅁㄴㅇㄹㅎㅗㅓㅏㅣㅋㅌㅊㅍㅠㅜㅡ"].map((jamo, index) => [
    jamo,
    "QWERTYUIOPASDFGHJKLZXCVBNM"[index]!,
  ]),
)
const COMPOUND: Record<string, string> = {
  ㄲ: "ㄱ",
  ㄸ: "ㄷ",
  ㅃ: "ㅂ",
  ㅆ: "ㅅ",
  ㅉ: "ㅈ",
  ㅒ: "ㅑ",
  ㅖ: "ㅕ",
  ㅘ: "ㅗ",
  ㅙ: "ㅗ",
  ㅚ: "ㅗ",
  ㅝ: "ㅜ",
  ㅞ: "ㅜ",
  ㅟ: "ㅜ",
  ㅢ: "ㅡ",
  ㄳ: "ㄱ",
  ㄵ: "ㄴ",
  ㄶ: "ㄴ",
  ㄺ: "ㄹ",
  ㄻ: "ㄹ",
  ㄼ: "ㄹ",
  ㄽ: "ㄹ",
  ㄾ: "ㄹ",
  ㄿ: "ㄹ",
  ㅀ: "ㄹ",
  ㅄ: "ㅂ",
}

export interface ImeStep {
  /** Physical key letter (`D` → `KeyD`), or "Space"/"Backspace". */
  readonly key: string
  /** Text committed before this keystroke's composition (the previous syllable). */
  readonly commit?: string
  /** Composition text after this keystroke; absent for a plain (committed) character. */
  readonly compose?: string
  /** A committed character typed without composition (space). */
  readonly insert?: string
}

/** Keystrokes of 2-beolsik typing for `text` (Hangul syllables and spaces), with a correction every 12 syllables. */
export function imeSteps(text: string) {
  const steps: ImeStep[] = []
  let pending: string | undefined
  let syllables = 0
  for (const char of text) {
    const code = char.charCodeAt(0) - 0xac00
    if (code < 0 || code > 11171) {
      steps.push({ key: "Space", commit: pending, insert: char })
      pending = undefined
      continue
    }
    const initial = INITIALS[Math.floor(code / 588)]!
    const medial = MEDIALS[Math.floor((code % 588) / 28)]!
    const final = FINALS[code % 28]!.trim()
    const open = String.fromCharCode(0xac00 + code - (code % 28))
    const key = (jamo: string) => KEYS[COMPOUND[jamo] ?? jamo] ?? "A"
    steps.push({ key: key(initial), commit: pending, compose: initial })
    steps.push({ key: key(medial), compose: open })
    if (++syllables % 12 === 0) {
      // Backspace inside the composition, then the vowel again (03 §12: editing while composing).
      steps.push({ key: "Backspace", compose: initial })
      steps.push({ key: key(medial), compose: open })
    }
    if (final) steps.push({ key: key(final), compose: char })
    pending = char
  }
  if (pending) steps.push({ key: "Space", commit: pending, insert: " " })
  return steps
}

export const IME_TEXT = "안녕하세요 오늘은 스트리밍 성능을 측정합니다 입력 지연이 한 프레임을 넘지 않아야 합니다 "

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Plays the steps against the focused element, one keystroke every `paceMs`. Returns how many were sent. */
export async function typeIme(cdp: CDPSession, steps: readonly ImeStep[], paceMs: number, until?: () => boolean) {
  let sent = 0
  for (const step of steps) {
    if (until?.()) break
    const code = step.key.length === 1 ? `Key${step.key}` : step.key
    const keyUp = step.key.length === 1 ? step.key.toLowerCase() : step.key === "Space" ? " " : step.key
    const vk = step.key.length === 1 ? step.key.charCodeAt(0) : step.key === "Space" ? 32 : 8
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Process",
      code,
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    if (step.commit) await cdp.send("Input.insertText", { text: step.commit })
    if (step.compose !== undefined)
      await cdp.send("Input.imeSetComposition", {
        text: step.compose,
        selectionStart: step.compose.length,
        selectionEnd: step.compose.length,
      })
    if (step.insert) await cdp.send("Input.insertText", { text: step.insert })
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyUp, code, windowsVirtualKeyCode: vk })
    sent++
    await sleep(paceMs)
  }
  return sent
}

/** Repeats the Korean sentence until `count` keystrokes. */
export function imeWorkload(count: number) {
  const one = imeSteps(IME_TEXT)
  return Array.from({ length: Math.ceil(count / one.length) }, () => one)
    .flat()
    .slice(0, count)
}

/** Clears the composer outside the measured window (never Enter: the real composer would send). */
export async function clearComposer(page: Page) {
  const composer = page.locator(COMPOSER).first()
  await composer.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) element.value = ""
    else element.textContent = ""
    element.dispatchEvent(new InputEvent("input", { bubbles: true }))
  })
}

/** A mouse-wheel scroll gesture synthesized by the browser (compositor path, like a real wheel). */
export async function scrollGesture(
  cdp: CDPSession,
  input: { readonly x: number; readonly y: number; readonly distance: number; readonly speed: number },
) {
  await cdp.send("Input.synthesizeScrollGesture", {
    x: Math.round(input.x),
    y: Math.round(input.y),
    yDistance: input.distance,
    speed: input.speed,
    gestureSourceType: "mouse",
    preventFling: true,
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Frame trace (PF3/PF4): compositor `PipelineReporter` events between the probe's user-timing marks.

/**
 * Profile traces (off by default; the gate numbers come from runs without them):
 * - `OWN_PERF_PROFILE=tasks`: task wall and thread time (`toplevel`) and the collector's phases (`v8.gc`); cheap. Each
 *   frame measurement then reports its main-thread tasks over 50 ms with a cause (`traceTasks`: gc, descheduled, work).
 * - `OWN_PERF_PROFILE=1`: the DevTools performance-panel categories too (script, style, layout, paint, CPU samples),
 *   for `bun e2e/performance/trace-tasks.ts <trace>`. Costs main-thread time: it finds causes, not gate numbers.
 * - `OWN_PERF_PROFILE=invalidation`: those and Blink's style invalidation tracking (which node's change made a style
 *   recalculation, and why); `selectors`: those and Blink's selector statistics per style recalculation (which rules
 *   were matched how often, at what cost); both heavier still.
 * The traces are kept with `OPENCODE_PERFORMANCE_TRACE_DIR`.
 */
const PROFILE = process.env.OWN_PERF_PROFILE
const PROFILE_CATEGORIES = !PROFILE
  ? []
  : [
      "toplevel",
      "disabled-by-default-v8.gc",
      ...(PROFILE === "tasks"
        ? []
        : [
            "devtools.timeline",
            "disabled-by-default-devtools.timeline",
            "v8.execute",
            "disabled-by-default-v8.cpu_profiler",
            ...(PROFILE === "invalidation" ? ["disabled-by-default-devtools.timeline.invalidationTracking"] : []),
            ...(PROFILE === "selectors" ? ["disabled-by-default-blink.debug"] : []),
          ]),
    ]

export async function startFrameTrace(page: Page, name: string) {
  const cdp = await page.context().newCDPSession(page)
  const events: TraceEvent[] = []
  cdp.on("Tracing.dataCollected", (payload) => events.push(...(payload.value as unknown as TraceEvent[])))
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: ["disabled-by-default-devtools.timeline.frame", "blink.user_timing", ...PROFILE_CATEGORIES],
    },
  })
  return async () => {
    const complete = new Promise<{ dataLossOccurred: boolean }>((resolve) =>
      cdp.once("Tracing.tracingComplete", resolve),
    )
    await cdp.send("Tracing.end")
    const result = await complete
    await cdp.detach().catch(() => undefined)
    if (result.dataLossOccurred) throw new Error("frame trace lost data")
    const mark = (label: string) => events.find((event) => event.name === label)?.ts
    const window = { start: mark("ownb:measure:start") ?? 0, end: mark("ownb:measure:end") ?? Number.MAX_SAFE_INTEGER }
    const directory = process.env.OPENCODE_PERFORMANCE_TRACE_DIR
    if (directory) {
      // One file per repetition (the index is unknown outside a Playwright test).
      const repetition = (() => {
        try {
          return `-r${test.info().repeatEachIndex}`
        } catch {
          return ""
        }
      })()
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(
        path.join(
          directory,
          `${process.env.OPENCODE_PERFORMANCE_RUN_ID ?? "manual"}-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}${repetition}-frames.json`,
        ),
        JSON.stringify({ traceEvents: events }),
      )
    }
    return { events, window }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scroll measurement (PF3, PF4) and history paging.

export interface ScrollMeasurement {
  /** Idle rAF interval before the run (the display's refresh as Chromium drives it); recorded, not a threshold. */
  readonly refreshMs: number
  readonly refreshHz: number | null
  readonly trace: Omit<ReturnType<typeof traceFrames>, "intervalSamples">
  readonly raf: ReturnType<typeof rafFrames>
  readonly longTasks: ReturnType<typeof longTasks>
  readonly longAnimationFrames: { readonly count: number; readonly maxBlocking: number }
  /** Raw series for pooled percentiles across repetitions (run.ts). */
  readonly presentedIntervals: number[]
  readonly rafIntervals: number[]
  readonly longTaskDurations: number[]
  /** Long task starts, ms after the measurement began (match them with `traceTasks`). */
  readonly longTaskStartsMs: number[]
  /** Profile runs only (`OWN_PERF_PROFILE`): main-thread tasks over 50 ms in the trace, with their cause. */
  readonly traceTasks?: ReturnType<typeof traceTasks>
}

/**
 * Idle refresh (recorded), then a frame trace + rAF/long-task probe around `drive()` (03 §20.1 "스크롤을 재는 법";
 * the long-frame threshold is 2 × `FRAME_BUDGET_MS`, see `rafFrames`). The trace window is bounded by the probe's
 * `ownb:measure:*` user-timing marks.
 */
export async function measureFrames(
  page: Page,
  name: string,
  drive: () => Promise<void>,
  /** Idle refresh measured beforehand; pass it when the page is busy now (streaming), since it must be idle frames. */
  idle?: number,
): Promise<ScrollMeasurement> {
  const refreshMs = idle ?? (await page.evaluate(idleRefresh, 120))
  const stopTrace = await startFrameTrace(page, name)
  await page.evaluate(startFrameProbe)
  const failed = await drive().then(
    () => undefined,
    (error: unknown) => error,
  )
  const probe = await page.evaluate(stopFrameProbe)
  const trace = await stopTrace()
  if (failed) throw failed
  const { intervalSamples, ...frames } = traceFrames(trace.events, trace.window)
  return {
    refreshMs: round(refreshMs),
    refreshHz: hz(refreshMs),
    trace: frames,
    raf: rafFrames(probe.raf, refreshMs),
    longTasks: longTasks(probe.longTasks),
    longAnimationFrames: {
      count: probe.longAnimationFrames.length,
      maxBlocking: round(Math.max(0, ...probe.longAnimationFrames.map((item) => item.blocking))),
    },
    presentedIntervals: intervalSamples,
    rafIntervals: probe.raf.slice(1).map((value, index) => round(value - probe.raf[index]!, 2)),
    longTaskDurations: probe.longTasks.map((value) => round(value)),
    longTaskStartsMs: probe.longTaskStarts.map((value) => round(value)),
    ...(PROFILE ? { traceTasks: traceTasks(trace.events, trace.window) } : {}),
  }
}

/**
 * Pages the whole history in by scrolling to the top until the first prompt's marker is visible, no older
 * message arrives for `idleMs`, or `timeoutMs` passes. Returns how far it got.
 */
export async function loadHistory(
  page: Page,
  input: {
    readonly tag: string
    readonly first: string
    readonly timeoutMs: number
    readonly idleMs: number
    /** Transcript center: paging is driven by wheel input, which also releases follow-the-tail (03 §4.5). */
    readonly x: number
    readonly y: number
  },
) {
  const started = Date.now()
  let earliest = Infinity
  let progressAt = Date.now()
  let rounds = 0
  await page.mouse.move(input.x, input.y)
  while (Date.now() - started < input.timeoutMs && Date.now() - progressAt < input.idleMs) {
    rounds++
    await page.mouse.wheel(0, -8_000)
    await page.waitForTimeout(120)
    const state = await page.evaluate(markerState, [input.first])
    const current = state.earliest[input.tag] ?? Infinity
    if (current < earliest) {
      earliest = current
      progressAt = Date.now()
    }
    if (state.wanted[input.first]) return { complete: true, earliestTurn: 0, rounds, ms: Date.now() - started }
  }
  return {
    complete: false,
    earliestTurn: Number.isFinite(earliest) ? earliest : null,
    rounds,
    ms: Date.now() - started,
  }
}

/** Scroller geometry (tags it with `data-ownb-scroller`); throws when the transcript has no scroll container. */
export async function scroller(page: Page) {
  const geometry = await page.evaluate(findScroller)
  if (!geometry) throw new Error("no transcript scroll container")
  return geometry
}

let transcriptRenders: boolean | undefined

/**
 * Whether the transcript shows the session's last answer. After the first miss in this worker the wait is short, so
 * a skeleton transcript costs seconds per benchmark instead of the full timeout on every repetition.
 */
export async function transcriptReady(page: Page, target: string | readonly string[]) {
  const ready = await waitForMarker(page, target, transcriptRenders === false ? 3_000 : 30_000)
  if (ready) transcriptRenders = true
  else transcriptRenders ??= false
  return ready
}

/** Context shared by every record: browser build and fixture setup (03 §20.1: record fixture size). */
export function benchContext(page: Page, state: PerfState) {
  return { browser: page.context().browser()?.version() ?? null, setup: state.setup }
}
