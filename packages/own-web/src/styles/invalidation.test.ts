// Style invalidation traps (SR 2026-10-20): Blink checks a `:has()` on the root element on every DOM insertion and then
// restyles every element that carries a feature of any `:has()` rule's subject, all rules merged, attributes matched by
// name. In the desktop shell titlebar.css's `:root[data-wco-visible]:has(dialog[open]) … [data-testid="sidebar-band"]`
// restyled every element with a data-testid (about 800, 13–30 ms) on each new block of a streaming answer, and with
// @opencode/ui's tabs.css loaded (`:has([data-slot=…]) [data-slot=…]`) every element with a data-slot (about 550,
// 35 ms). No own-web style anchors a `:has()` on the root; a mirrored attribute does the job (shell/titlebar-band.ts).
import { expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

const SRC = path.join(import.meta.dir, "..")

test("no :has() on the root element", async () => {
  // All sheets read at once: awaited one after another, each read waited for the event loop to come round again, and
  // on a loaded PC the 51 waits took over 5 s.
  const sheets = await Promise.all(
    [...new Glob("**/*.css").scanSync(SRC)].map(async (file) => ({
      file,
      text: await Bun.file(path.join(SRC, file)).text(),
    })),
  )
  const offenders: string[] = []
  for (const sheet of sheets) {
    const css = sheet.text.replace(/\/\*[^]*?\*\//g, "")
    for (const rule of css.split("}")) {
      const selector = rule.split("{")[0] ?? ""
      for (const part of selector.split(/,(?![^(]*\))/))
        if (/(?:^|\s)(?::root|html)(?:[[.:#][^\s]*)?:has\(/.test(part.trim()))
          offenders.push(`${sheet.file.replaceAll("\\", "/")}: ${part.trim().replace(/\s+/g, " ")}`)
    }
  }
  expect(offenders).toEqual([])
})
