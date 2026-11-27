// Pictures for README.md (English) and README.ko.md (Korean), reproducible from fake data only.
//
//   bun own/scripts/readme/capture.ts                              both languages, every picture
//   bun own/scripts/readme/capture.ts --lang en --only hero,team
//   bun own/scripts/readme/capture.ts --lang en --group main --attach <backend-main.json>   (a demo world already up)
//   bun own/scripts/readme/capture.ts --list
//
// It runs on the user manual's demo worlds (own/scripts/manual, packages/own-web/e2e/manual/backend.ts and e2e/remote):
// the real server from source, fake model providers, made-up accounts and projects in temp folders. Each language boots
// its own world (OWN_MANUAL_LANG: the demo texts, and the app's own language setting), so nothing on a picture is drawn
// afterwards. Run it with TEMP and TMP pointing at a scratch folder, from a checkout path without '#'. Pages open in the
// installed Microsoft Edge, headless; the desktop shell's window (the `browser` picture) stays off the screen. Paths are
// rewritten to the demo's, and a picture that still shows this PC's user name, PC name, home or temp folder fails.
// Output: own/readme/<lang>/<id>.webp (canvas-encoded: no metadata), at most 150 KB where the quality allows it.
import path from "node:path"
import { parseArgs } from "node:util"
import { launch, REPO } from "../manual/lib/browser"
import { shooter, type Saved } from "../manual/lib/shoot"
import { attach } from "../manual/lib/world"
import { HALVINGS, makeCtx, type Endpoints, type Shot } from "./lib"
import { GROUPS } from "./shots"

const args = parseArgs({
  options: {
    lang: { type: "string" },
    group: { type: "string" },
    only: { type: "string" },
    attach: { type: "string" },
    out: { type: "string" },
    list: { type: "boolean" },
  },
}).values

const names = (value: string | undefined) => new Set((value ?? "").split(",").filter((item) => item !== ""))
const languages = (["en", "ko"] as const).filter((lang) => !args.lang || names(args.lang).has(lang))
const only = names(args.only)
const groups = GROUPS.filter((group) => !args.group || names(args.group).has(group.name))

if (args.list) {
  for (const group of GROUPS) console.log(`${group.name}: ${group.shots.map((shot) => shot.id).join(", ")}`)
  process.exit(0)
}

const saved: Saved[] = []
const failed: { readonly id: string; readonly error: string }[] = []

for (const lang of languages)
  for (const group of groups) {
    const shots = (group.shots as ReadonlyArray<Shot<Endpoints>>).filter((shot) => only.size === 0 || only.has(shot.id))
    if (shots.length === 0) continue
    console.log(`[${lang}/${group.name}] ${shots.length} picture(s)`)
    const started = new Date()
    const world = args.attach ? await attach<Endpoints>(args.attach, group.paths as never) : await group.boot(lang)
    const browser = await launch()
    try {
      const shoot = await shooter(browser, path.resolve(args.out ?? path.join(REPO, "own/readme"), lang), HALVINGS)
      for (const shot of shots) {
        const ctx = makeCtx({ browser, lang, state: world.state, pairs: world.pairs, shooter: shoot, saved })
        await shot
          .run(ctx)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            failed.push({ id: `${lang}/${shot.id}`, error: message.split("\n").slice(0, 6).join("\n") })
            console.log(`  ✗ ${shot.id}: ${message.split("\n")[0]}`)
          })
          .finally(() => ctx.dispose())
      }
    } finally {
      await browser.close().catch(() => undefined)
      await world.stop()
      await sweep(started)
    }
  }

/**
 * The remote world's fake hosts start their services detached, as a real host would. A service that a shot's last
 * `ensure` was still starting outlived the world's own stop (2026-11-26: two left after each remote group), so this
 * checkout's fake services started since the group began are ended here.
 */
async function sweep(since: Date) {
  if (process.platform !== "win32") return
  const script = [
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and",
    `$_.CreationDate -ge [datetime]::Parse('${since.toISOString()}').ToLocalTime() -and`,
    `$_.CommandLine -like '*${REPO.replaceAll("/", "\\").replaceAll("'", "''")}*' -and`,
    "$_.CommandLine -match 'fake-service[.]ts|remote-service[.]ts' } | ForEach-Object { $_.ProcessId }",
  ].join(" ")
  const found = await new Response(
    Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe" }).stdout,
  ).text()
  for (const pid of found.split(/\s+/).filter((item) => /^\d+$/.test(item)))
    await Bun.spawn(["taskkill", "/PID", pid, "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
}

const total = saved.reduce((sum, item) => sum + item.bytes, 0)
console.log(`\nsaved ${saved.length} (${(total / 1024).toFixed(0)} KB), failed ${failed.length}`)
for (const item of failed) console.log(`FAILED ${item.id}\n  ${item.error.replaceAll("\n", "\n  ")}`)
process.exit(failed.length > 0 ? 1 : 0)
