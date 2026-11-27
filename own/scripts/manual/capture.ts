// Screenshots for the user manual (own/docs/manual/PLAN.md §4–§7), reproducible from fake data only.
//
//   bun own/scripts/manual/capture.ts                       every group, every shot
//   bun own/scripts/manual/capture.ts --group M,T --only 11-cost-dialog,17-enable
//   bun own/scripts/manual/capture.ts --group M --attach <backend-main.json>   (a backend already running)
//   bun own/scripts/manual/capture.ts --list
//
// Each group boots its demo world (packages/own-web/e2e/manual/backend.ts, or the remote and gateway e2e backends):
// the real server from source, fake model providers and fake accounts, projects in temp folders under TEMP. Run it
// with TEMP and TMP pointing at a scratch folder (the worlds put everything there and remove it on exit), from a
// checkout path without '#'. Pages open in the installed Microsoft Edge (headless, ko-KR, dark unless a shot says
// otherwise); paths on screen are rewritten to the demo's (`D:\demo\space-game`, `C:\Users\demo`), and a shot that
// still shows this PC's user name, PC name, home folder or the temp folders fails instead of being saved.
// Images go to own/docs/manual/images/<id>.webp (PLAN.md §7: numbered orange boxes, WebP ≤ 150 KB where possible).
import path from "node:path"
import { parseArgs } from "node:util"
import { launch, REPO, type Page } from "./lib/browser"
import { makeCtx, type Endpoints, type Shot } from "./lib/ctx"
import { shooter, type Saved } from "./lib/shoot"
import { attach, type World } from "./lib/world"
import { GROUPS } from "./shots"

const args = parseArgs({
  options: {
    group: { type: "string" },
    only: { type: "string" },
    attach: { type: "string" },
    out: { type: "string" },
    list: { type: "boolean" },
  },
}).values

const OUT = path.resolve(args.out ?? path.join(REPO, "own/docs/manual/images"))
const only = new Set((args.only ?? "").split(",").filter((id) => id !== ""))
const groups = GROUPS.filter((group) => !args.group || args.group.split(",").includes(group.name))

if (args.list) {
  for (const group of GROUPS) console.log(`${group.name}: ${group.shots.map((shot) => shot.id).join(", ")}`)
  process.exit(0)
}

const saved: Saved[] = []
const failed: { id: string; error: string }[] = []
const log = (line: string) => console.log(line)

for (const group of groups) {
  const shots = group.shots.filter((shot) => only.size === 0 || only.has(shot.id))
  if (shots.length === 0) continue
  log(`[${group.name}] ${group.title}: ${shots.length} shot(s)`)
  const world: World<Endpoints> = args.attach ? await attach(args.attach, group.paths) : await group.boot()
  const browser = await launch()
  const kept: Page[] = []
  try {
    const shoot = await shooter(browser, OUT)
    for (const shot of shots as ReadonlyArray<Shot<Endpoints>>) {
      const ctx = makeCtx({ browser, state: world.state, pairs: world.pairs, shooter: shoot, saved, kept, log })
      const started = Date.now()
      await shot
        .run(ctx)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({ id: shot.id, error: message.split("\n").slice(0, 6).join("\n") })
          log(`  ✗ ${shot.id}: ${message.split("\n")[0]}`)
        })
        .finally(() => ctx.dispose())
      if (Date.now() - started > 60_000) log(`    (${Math.round((Date.now() - started) / 1000)} s)`)
    }
  } finally {
    await Promise.all(kept.map((page) => page.context().close().catch(() => undefined)))
    await browser.close().catch(() => undefined)
    await world.stop()
  }
}

log("")
log(`saved ${saved.length}, failed ${failed.length}`)
for (const item of failed) log(`FAILED ${item.id}\n  ${item.error.replaceAll("\n", "\n  ")}`)
process.exit(failed.length > 0 ? 1 : 0)
