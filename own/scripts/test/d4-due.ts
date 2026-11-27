// Whether the release chain's real-host D4 runs its full 20-minute stream (`OWN_REAL_HOST_D4_LONG_MS=1200000`) instead
// of the default 6 minutes (packages/own-remote/test/real-host/d-claude.test.ts). It is due when relay, egress or broker
// code of own-remote or own-accounts, or a source file of core patch P-018 (from the ledger), changed since the last full
// pass, and at least once a week; with no full pass on record it is due. The record is `own/.out/test/d4-full.pass` of
// the checkout it runs in (the release worktree): `<commit> <ISO time>`. The release checklist: own/handoff/RELEASE.md.
//
//   bun own/scripts/test/d4-due.ts            whether it is due, and why
//   bun own/scripts/test/d4-due.ts --ms       only the value for OWN_REAL_HOST_D4_LONG_MS (1200000 or 360000)
//   bun own/scripts/test/d4-due.ts --record   after a full D4 passed: records HEAD and now
import fs from "node:fs"
import path from "node:path"
import { git, gitText } from "../lib/git.mjs"
import { parseYaml } from "../lib/yaml-lite.mjs"

const FULL_MS = 1_200_000
const SHORT_MS = 360_000
const DAY_MS = 24 * 60 * 60_000
const RECORD = "own/.out/test/d4-full.pass"
/** D4's stream path besides P-018: this PC's egress relay and broker, the host's egress stub, the SSH tunnel. */
const PATHS = [
  "packages/own-accounts/src/broker",
  "packages/own-accounts/src/remote",
  "packages/own-remote/src/ssh",
  "packages/own-remote/src/protocol/broker.ts",
]

const root = gitText(process.cwd(), ["rev-parse", "--show-toplevel"])
const file = path.join(root, RECORD)
const watched = [...PATHS, ...p018()]
const args = process.argv.slice(2)

if (args.includes("--record")) {
  const dirty = changed(["status", "--porcelain", "--", ...watched])
  if (dirty.length > 0) {
    console.error(`d4-due: not recorded, the working tree changes ${dirty.join(", ")}: only a commit's pass counts`)
    process.exit(1)
  }
  const head = gitText(root, ["rev-parse", "HEAD"])
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${head} ${new Date().toISOString()}\n`)
  console.log(`d4-due: recorded a full D4 pass at ${head}`)
  process.exit(0)
}

const last = read()
const days = last ? Math.floor((Date.now() - last.at) / DAY_MS) : 0
const reasons = due()
if (args.includes("--ms")) {
  console.log(reasons.length > 0 ? FULL_MS : SHORT_MS)
  process.exit(0)
}
console.log(
  reasons.length > 0
    ? `d4-due: due (${reasons.join("; ")}): run phase D with OWN_REAL_HOST_D4_LONG_MS=${FULL_MS}, then --record`
    : `d4-due: not due (the last full pass at ${last?.commit.slice(0, 10)} is ${days} days old, and no relay, egress, ` +
        `broker or P-018 file changed since): phase D's default ${SHORT_MS / 60_000} min`,
)

/** Why the full run is due; empty when it is not. */
function due() {
  if (!last) return [`no full pass on record in ${RECORD}`]
  const old = days >= 7 ? [`the last full pass is ${days} days old`] : []
  if (git(root, ["cat-file", "-e", `${last.commit}^{commit}`], { allowFailure: true }).status !== 0)
    return [...old, `the recorded commit ${last.commit} is not in this repository`]
  const files = new Set([
    ...changed(["diff", "--name-only", `${last.commit}..HEAD`, "--", ...watched]),
    ...changed(["status", "--porcelain", "--", ...watched]),
  ])
  if (files.size === 0) return old
  return [...old, `changed since ${last.commit.slice(0, 10)}: ${[...files].join(", ")}`]
}

function read() {
  if (!fs.existsSync(file)) return undefined
  const [commit, at] = fs.readFileSync(file, "utf8").trim().split(/\s+/)
  const time = Date.parse(at ?? "")
  if (!commit || Number.isNaN(time)) return undefined
  return { commit, at: time }
}

/** The paths a git listing names (a `status --porcelain` line loses its two status columns). */
function changed(argv: string[]): string[] {
  return git(root, argv)
    .stdout.split("\n")
    .filter(Boolean)
    .map((line: string) => (argv[0] === "status" ? line.slice(3) : line))
}

/** P-018's files outside tests, from the ledger. */
function p018(): string[] {
  const ledger = parseYaml(fs.readFileSync(path.join(root, "own", "ledger", "core-patches.yaml"), "utf8")) as Array<{
    id: string
    files?: Array<{ path: string }>
  }>
  const patch = ledger.find((entry) => entry.id === "P-018")
  return (patch?.files ?? []).map((entry) => entry.path).filter((item) => !item.includes("/test/"))
}
