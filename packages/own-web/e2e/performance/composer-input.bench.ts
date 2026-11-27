// PF2 (01 §6.6, 03 §20.1): composer input latency with Korean IME composition, idle, in the 2,000-message session.
// Every keydown/beforeinput/composition*/input on the composer is counted by a window listener registered after the
// app (end of dispatch), and Event Timing supplies event → paint. Input arrives through CDP like a Windows IME
// (keydown 229 → Input.imeSetComposition / Input.insertText). Ported from upstream composer-history/*.bench.ts and
// timeline/composer-write-batch-benchmark.spec.ts (own composer, own sampler, IME orders of 03 §12).
import { benchmark, expect } from "./benchmark"
import { inputLatency } from "./metrics"
import { installInputProbe, readInputProbe } from "./probes"
import {
  benchContext,
  clearComposer,
  COMPOSER,
  imeWorkload,
  openApp,
  perfState,
  sessionRoute,
  typeIme,
} from "./support"

const state = perfState()
const KEYSTROKES = Number(process.env.OWN_PERF_KEYSTROKES ?? 200)
const PACE_MS = Number(process.env.OWN_PERF_KEY_PACE_MS ?? 35)
benchmark.use({ traceScope: "interaction" })

benchmark("PF2 composer input: Korean IME composition, idle session view", async ({ page, report }) => {
  await openApp(page, state, sessionRoute(state.sessions.a.id))
  const composer = page.locator(COMPOSER).first()
  await composer.focus()
  await expect(composer).toBeFocused()
  const cdp = await page.context().newCDPSession(page)
  await page.evaluate(installInputProbe, COMPOSER)
  const steps = imeWorkload(KEYSTROKES)
  const started = performance.now()
  const sent = await typeIme(cdp, steps, PACE_MS)
  const typingMs = performance.now() - started
  const probe = await page.evaluate(readInputProbe)
  await cdp.detach()
  const typed = await composer.evaluate((element) =>
    element instanceof HTMLTextAreaElement ? element.value.length : (element.textContent ?? "").length,
  )
  await clearComposer(page)
  const input = inputLatency(probe.events, probe.timings)
  // The IME path must have been exercised, or the numbers describe plain typing.
  expect(input.byType.compositionupdate ?? 0).toBeGreaterThan(sent / 3)
  expect(typed).toBeGreaterThan(0)
  report(
    { input, keystrokes: sent, typingMs: Math.round(typingMs), typedChars: typed },
    {
      ...benchContext(page, state),
      phase: "idle",
      paceMs: PACE_MS,
      composer: COMPOSER,
      session: "2,000 messages",
      source: "CDP Input.imeSetComposition",
    },
  )
})
