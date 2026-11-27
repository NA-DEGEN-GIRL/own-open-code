// Harness self-test: runs every probe (marker visibility, history paging, frame trace + rAF + long tasks, switch
// sampling, IME input sampling) against a synthetic windowed list of 2,000 messages, so the measurement pipeline is
// known to work even while app modules are skeletons. Not a PF gate; run.ts records it under `harness`.
import { benchmark, expect } from "./benchmark"
import { classifySwitch, inputLatency } from "./metrics"
import { installInputProbe, installMarkerLocator, installSwitchProbe, readInputProbe, readSwitchProbe } from "./probes"
import { imeWorkload, loadHistory, measureFrames, scroller, scrollGesture, typeIme, waitForMarker } from "./support"

benchmark.use({ traceScope: "interaction" })

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
body{margin:0;font:14px/1.5 system-ui,sans-serif}
#t{height:720px;overflow:auto;position:relative}
.row{position:absolute;left:0;right:0;height:116px;padding:8px 16px;box-sizing:border-box;border-bottom:1px solid #ddd;contain:content}
</style></head><body>
<div data-testid="transcript"><div id="t"><div id="spacer"></div><div id="rows"></div></div></div>
<button id="switch">switch</button><textarea id="composer" rows="2"></textarea>
<script>
const N = 2000, H = 116, t = document.getElementById("t"), rows = document.getElementById("rows")
let tag = "A"
document.getElementById("spacer").style.height = N * H + "px"
const pad = (n) => String(n).padStart(4, "0")
function render() {
  const first = Math.max(0, Math.floor(t.scrollTop / H) - 3)
  const last = Math.min(N - 1, Math.ceil((t.scrollTop + t.clientHeight) / H) + 3)
  let html = ""
  for (let i = first; i <= last; i++) {
    const turn = Math.floor(i / 2), role = i % 2 ? "R" : "U"
    html += '<div class="row" style="top:' + i * H + 'px"><b>' + (role === "U" ? "요청" : "답변") + " " + turn +
      "</b><p>검토 결과와 표, 코드 블록이 섞인 행입니다. OWNB-" + tag + "-" + pad(turn) + "-" + role + "</p></div>"
  }
  rows.innerHTML = html
}
t.addEventListener("scroll", render)
document.getElementById("switch").addEventListener("mousedown", () =>
  setTimeout(() => { tag = tag === "A" ? "B" : "A"; t.scrollTop = t.scrollHeight; render() }, 30))
t.scrollTop = t.scrollHeight
render()
</script></body></html>`

benchmark("harness self-test: probes on a synthetic 2,000-message windowed list", async ({ page, report }) => {
  await page.setContent(PAGE)
  const geometry = await scroller(page)
  expect(geometry.scrollHeight).toBeGreaterThan(200_000)
  expect(await waitForMarker(page, "OWNB-A-0999-R", 5_000)).toBe(true)

  const history = await loadHistory(page, {
    tag: "A",
    first: "OWNB-A-0000-U",
    timeoutMs: 30_000,
    idleMs: 3_000,
    x: geometry.x,
    y: geometry.y,
  })
  expect(history.complete).toBe(true)
  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("[data-ownb-scroller]")!
    element.scrollTop = element.scrollHeight
  })

  const cdp = await page.context().newCDPSession(page)
  const scroll = await measureFrames(page, "harness self-test", async () => {
    await scrollGesture(cdp, { x: geometry.x, y: geometry.y, distance: 6_000, speed: 4_000 })
    await scrollGesture(cdp, { x: geometry.x, y: geometry.y, distance: -6_000, speed: 4_000 })
  })
  expect(scroll.trace.presented).toBeGreaterThan(10)
  expect(scroll.raf.frames).toBeGreaterThan(10)
  expect(scroll.refreshMs).toBeGreaterThan(2)

  await page.evaluate(installMarkerLocator)
  await page.evaluate(installSwitchProbe, {
    trigger: "#switch",
    destination: "B",
    source: "A",
    last: "OWNB-B-0999-R",
    limitMs: 1_000,
  })
  await page.locator("#switch").click()
  await page.waitForFunction(() => (window as Window & { __ownbSwitch?: { done: boolean } }).__ownbSwitch?.done)
  const switched = classifySwitch((await page.evaluate(readSwitchProbe)).samples)
  expect(switched.firstCorrectObservedMs).not.toBeNull()
  expect(switched.firstCorrectObservedMs!).toBeGreaterThanOrEqual(25)

  await page.locator("#composer").focus()
  await page.evaluate(installInputProbe, "#composer")
  await typeIme(cdp, imeWorkload(60), 10)
  const probe = await page.evaluate(readInputProbe)
  const input = inputLatency(probe.events, probe.timings)
  expect(input.byType.compositionupdate ?? 0).toBeGreaterThan(20)
  expect(await page.locator("#composer").inputValue()).toContain("안녕하세요")
  await cdp.detach()

  report(
    { history, scroll, switch: switched, input: { ...input, processingSamples: undefined, paintSamples: undefined } },
    { selfTest: true, rows: 2_000, windowed: true },
  )
})
