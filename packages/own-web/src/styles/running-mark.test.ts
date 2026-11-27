// The running mark (03 §7.6, styles/running-mark.css): every place that shows that a session or its work runs uses
// the one still mark, and no own-web style animates endlessly except the short-lived or attention signals listed
// below. An endless animation keeps the compositor drawing at the display rate for as long as it shows (one per
// running session before 2026-10: own/reports/ui-perf-many-sessions-2026-10.md). The e2e (e2e/running-mark.spec.ts)
// checks the drawn mark and the page's animations while a real turn runs.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

const SRC = path.join(import.meta.dir, "..")
// Every own-web style and component (about 300 files), read once and all at once when the file loads. The tests read
// them one after another before, each read waiting for the event loop to come round again: on a loaded PC that wait
// is a scheduler slice of about 10 ms, so one test took over 5 s.
const sources = new Map(
  await Promise.all(
    [...new Glob("**/*.{css,tsx}").scanSync(SRC)].map(
      async (file) => [file.replaceAll("\\", "/"), await Bun.file(path.join(SRC, file)).text()] as const,
    ),
  ),
)
const read = (file: string) => sources.get(file) ?? ""
const files = (extension: string) => [...sources.keys()].filter((file) => file.endsWith(extension))

/** Endless animations that show only while something short runs, or that must draw the eye, with the reason. */
const ENDLESS = new Map([
  ["own-spin", "limits/kit.css: the spinner of a request in flight"],
  ["own-files-spin", "files.css: a folder or file loading"],
  ["own-review-spin", "review.css: a diff loading"],
  ["own-fc-spin", "forking/compaction.css: a compaction or fork being made"],
  ["own-sm-spin", "shellmode.css: a shell command starting"],
  ["own-vc-pulse", "voice.css: the microphone while recording (the user holds it)"],
  ["own-vc-turn", "voice.css: a recording being transcribed"],
  ["own-browser-pulse", "browser.css: a page loading, and the agent driving the browser (an attention signal)"],
  ["tailwind:projects/open-button.tsx", "animate-spin: a folder being opened"],
  ["tailwind:computer/index.tsx", "motion-safe:animate-pulse: the computer-use chip while the agent acts (attention)"],
])

describe("running mark", () => {
  test("the running places draw the still mark", () => {
    const places = {
      // Drawn over the status glyph: the row's class, the pane title's data-running, the menu's sub-agent kind.
      "sidebar/rows.tsx": 'running: "own-run-glyph",',
      "shell/panes.tsx": 'data-running={running() ? "" : undefined}',
      "background/running-menu.tsx": 'class="own-run-kind-icon" data-kind={item.kind}',
      // An element of its own.
      "switcher/pill.tsx": '<span class="own-run-mark" role="img" aria-label={i18n.t("own.pill.running")} />',
      "background/index.tsx": '<span class="own-run-mark" aria-hidden="true" />',
    }
    for (const [file, markup] of Object.entries(places)) expect(read(file)).toContain(markup)
  })

  test("the mark is the accent text colour and still; the animated marks of before are gone", () => {
    const css = read("styles/running-mark.css")
    expect(css).toContain(".own-run-mark,\n.own-run-glyph::before,\n.own-pane-status[data-running]::before,")
    expect(css).toContain("border: 1.5px solid var(--own-accent-text)")
    expect(css).toContain("var(--own-accent-text) 0 52%")
    const rules = css.replace(/\/\*[^]*?\*\//g, "")
    expect(rules).not.toMatch(/animation|transition|#[0-9a-f]{3,8}\b|rgb\(/i)
    // Unlayered, so the component files' glyph colours (unlayered too) and the sidebar's utilities lose to it.
    expect(read("styles/index.css")).toContain('@import "./running-mark.css";\n')
    expect(
      [...sources.values()].filter((text) => /own-pulse|own-sw-spinner|own-run-pulse|own-bj-live/.test(text)),
    ).toEqual([])
  })

  test("no other style animates endlessly", () => {
    const found = new Set<string>()
    for (const file of files(".css"))
      for (const match of read(file).matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)) found.add(match[1]!)
    for (const file of files(".tsx"))
      if (/\banimate-(?:spin|pulse|ping|bounce)\b/.test(read(file))) found.add(`tailwind:${file}`)
    expect([...found].filter((name) => !ENDLESS.has(name))).toEqual([])
    // It reads every stylesheet and component one after another: under a full parallel run that can pass 5 s.
  }, 30_000)
})
