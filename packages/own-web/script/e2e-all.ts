// Every own-web Playwright suite (the `test:e2e:*` scripts and `test:integration`), two at a time, under the machine-wide
// heavy-test lock (own/scripts/test/heavy.ts). Each config has its own port pair and backend world, so two run side by
// side; more is not used: `ERR_NO_BUFFER_SPACE` and worker timeouts showed up under load. A full pass ran one config
// after another before 2026-10-29 (test-speed).
//
//   bun run test:e2e:all                      every suite, 2 at a time
//   bun run test:e2e:all -- --jobs 1          one at a time
//   bun run test:e2e:all -- team presets      only those (script names without `test:e2e:`)
//   bun run test:e2e:all -- --ui-audit        ui-audit even when no css or tsx of src changed since its last pass
//
// ui-audit (16-17 min) runs only when a `.css` or `.tsx` file under `src/` changed since the commit of its last pass
// (recorded in own/.out/test/ui-audit.pass) or the working tree has such a change. Logs go to
// own/.out/test/e2e-all/<suite>.log.
//
// `vite build` runs once before the suites start, and every suite reads that dist/: the main config runs as
// `test:e2e:main` (`test:e2e` is the build and then it), and the suites get OWN_WEB_DIST_BUILT=1, under which nothing
// builds dist/ again: the PF5 checks of presets and import read it as it is, e2e/backend.ts (main, requests, terminal,
// sidebar) fails without it instead of skipping its preview, and the gateway backend serves it instead of building its
// own copy. Run alone, each still builds as before. Before, `test:e2e` and presets' PF5 rebuilt beside the other
// worker's suite, and vite empties dist/ first: sidebar's PF1 then skipped (`no dist/ build`), and the other PF5 check
// and e2e/backend.ts's preview could read a half-written dist/.
import fs from "node:fs"
import path from "node:path"

const PACKAGE = path.resolve(import.meta.dir, "..")
const REPO = path.resolve(PACKAGE, "../..")
const OUT = path.join(REPO, "own", ".out", "test")
const PASS = path.join(OUT, "ui-audit.pass")
const LOGS = path.join(OUT, "e2e-all")

const args = process.argv.slice(2)
const jobsAt = args.indexOf("--jobs")
const jobs = jobsAt < 0 ? 2 : Number(args[jobsAt + 1])
const forceAudit = args.includes("--ui-audit")
const named = args.filter((arg, at) => !arg.startsWith("--") && args[at - 1] !== "--jobs")

const scripts = (await Bun.file(path.join(PACKAGE, "package.json")).json()).scripts as Record<string, string>
const suites = Object.keys(scripts)
  .filter((name) => (name.startsWith("test:e2e:") && name !== "test:e2e:all") || name === "test:integration")
  .map((name) => ({ name, short: name.replace(/^test:(e2e:)?/, "") }))
  .filter((suite) => named.length === 0 || named.includes(suite.short))
  .filter((suite) => suite.short !== "ui-audit" || forceAudit || named.includes("ui-audit") || auditNeeded())

fs.mkdirSync(LOGS, { recursive: true })
const started = Date.now()
const built = build()
if (built !== 0) {
  console.log(`e2e-all: vite build failed (${built}), no suite ran (log in ${path.join(LOGS, "build.log")})`)
  process.exit(1)
}
console.log(`e2e-all: built dist/ in ${Math.round((Date.now() - started) / 1000)} s`)
const queue = [...suites]
const results: Array<{ short: string; code: number; seconds: number }> = []
console.log(`e2e-all: ${suites.length} suites, ${jobs} at a time: ${suites.map((suite) => suite.short).join(", ")}`)
await Promise.all(Array.from({ length: jobs }, () => worker()))
results.sort((a, b) => b.seconds - a.seconds)
console.table(results)
const failed = results.filter((result) => result.code !== 0)
console.log(
  `e2e-all: ${results.length - failed.length}/${results.length} passed in ${Math.round((Date.now() - started) / 1000)} s` +
    (failed.length ? `; failed: ${failed.map((result) => result.short).join(", ")} (logs in ${LOGS})` : ""),
)
process.exit(failed.length ? 1 : 0)

async function worker(): Promise<void> {
  const suite = queue.shift()
  if (!suite) return
  const at = Date.now()
  const log = path.join(LOGS, `${suite.short}.log`)
  console.log(`e2e-all: start ${suite.short}`)
  // A BunFile as stdout writes from the start without truncating: a shorter run kept the last run's tail.
  fs.rmSync(log, { force: true })
  // This process's bun, not `bun` from PATH: on this PC that is a `bun.cmd`, which cmd.exe runs.
  const child = Bun.spawn([process.execPath, "run", suite.name], {
    cwd: PACKAGE,
    stdout: Bun.file(log),
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", OWN_WEB_DIST_BUILT: "1" },
  })
  const errors = await new Response(child.stderr).text()
  const code = await child.exited
  fs.appendFileSync(log, errors)
  const seconds = Math.round((Date.now() - at) / 1000)
  results.push({ short: suite.short, code, seconds })
  console.log(`e2e-all: ${code === 0 ? "pass" : `FAIL (${code})`} ${suite.short} in ${seconds} s`)
  if (code === 0 && suite.short === "ui-audit") recordAudit()
  return worker()
}

/** `vite build` into dist/, once for every suite; its exit code. */
function build() {
  const log = path.join(LOGS, "build.log")
  fs.rmSync(log, { force: true })
  const result = Bun.spawnSync([process.execPath, "run", "build"], {
    cwd: PACKAGE,
    stdout: Bun.file(log),
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  fs.appendFileSync(log, result.stderr)
  return result.exitCode
}

/** Whether a css or tsx file under src changed since ui-audit's last pass (or there is no pass on record). */
function auditNeeded() {
  const since = fs.existsSync(PASS) ? fs.readFileSync(PASS, "utf8").trim() : ""
  if (!since) return true
  const changed = [
    git(["diff", "--name-only", `${since}..HEAD`, "--", "src"]),
    git(["diff", "--name-only", "HEAD", "--", "src"]),
    git(["ls-files", "--others", "--exclude-standard", "--", "src"]),
  ]
    .join("\n")
    .split("\n")
    .filter((file) => /\.(css|tsx)$/.test(file))
  if (changed.length === 0) console.log(`e2e-all: ui-audit skipped, no css or tsx under src changed since ${since}`)
  return changed.length > 0
}

function recordAudit() {
  // Only a clean tree's pass is a pass of that commit.
  if (git(["status", "--porcelain", "--", "src"]).trim() !== "") return
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(PASS, git(["rev-parse", "HEAD"]).trim() + "\n")
}

function git(argv: string[]) {
  const result = Bun.spawnSync(["git", ...argv], { cwd: PACKAGE, stdout: "pipe", stderr: "pipe" })
  // An unknown recorded commit (another branch's pass) reads as "changed".
  return result.exitCode === 0 ? result.stdout.toString() : "src/unknown.tsx"
}
