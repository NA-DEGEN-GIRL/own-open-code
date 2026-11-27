// v2.2's activity spinner held still (styles/activity-spinner.css): session-ui's SessionProgressIndicatorV2 draws the
// Soft Radar dots with an endless inline animation each, and own draws running work still (styles/running-mark.css,
// 03 §7.6). The e2e (e2e/running-mark.spec.ts) checks that no endless animation runs while a real turn runs.
import { describe, expect, test } from "bun:test"
import path from "node:path"

const read = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()

describe("activity spinner", () => {
  test("it shows the frozen pose and nothing in the sheet animates", async () => {
    const rules = (await read("activity-spinner.css")).replace(/\/\*[^]*?\*\//g, "").trim()
    expect(rules).toBe(
      '[data-component="session-progress-indicator-v2"]::before {\n  mask-image: var(--spinner-still);\n  mask-size: 100% 100%;\n}',
    )
    expect(rules).not.toMatch(/animation|transition|@keyframes|--spinner-frames/i)
    expect(await read("index.css")).toContain('@import "./activity-spinner.css";\n')
  })

  test("the selector reaches upstream's spinner and its still frame", async () => {
    // SessionProgressIndicatorV2 names its Spinner, and the Spinner (since v2.4.0, #65634) is one element whose
    // `::before` carries the animated APNG mask (`--spinner-frames`); the reduced-motion rule swaps it for
    // `--spinner-still`, the frame own shows always.
    expect(await read("../../../session-ui/src/v2/components/session-progress-indicator-v2.tsx")).toContain(
      'data-component="session-progress-indicator-v2"',
    )
    const spinner = await read("../../../ui/src/components/spinner.tsx")
    expect(spinner).toContain('data-component={local["data-component"] ?? "spinner"}')
    expect(spinner).toContain('data-slot="spinner-dots"')
    const sheet = await read("../../../ui/src/components/spinner.css")
    expect(sheet).toContain('[data-slot="spinner-dots"]::before {')
    expect(sheet).toContain("mask-image: var(--spinner-frames);")
    expect(sheet).toContain("mask-image: var(--spinner-still);")
    expect(await read("../../../ui/src/components/spinner-frames.css")).toContain("--spinner-still: url(")
  })
})
