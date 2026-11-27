// Follows Codex CLI releases for the `codex` harness (10 §5). Finds the newest stable release tag (`rust-vX.Y.Z`) of
// the Codex reference clone, reports what changed since own/ledger/codex-pin.json in each tracked area and per catalog
// model, and with --apply moves the pin to that release: it fetches the tag, regenerates
// packages/own-harness/codex-data (and own-protocol's catalog slugs) from it and installs the same CLI version for
// golden captures (`bun script/codex-golden.ts`). Run the own-harness tests after --apply.
//
//   bun own/scripts/codex-sync.ts [--ref <codex checkout>] [--to <tag or revision>] [--apply]
//                                 [--cli-prefix <dir> | --no-cli]
//
// The default clone is refs/codex next to the main checkout (`git rev-parse --git-common-dir`), shared by worktrees.
// The CLI goes to `--cli-prefix`, else to codex-cli/<version> beside the clone (refs/codex-cli/<version>), where
// codex-golden.ts looks for it. `--no-cli` moves the pin without installing (the CLI download needs the user's OK).
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const args = parseArgs({
  options: {
    ref: { type: "string" },
    to: { type: "string" },
    apply: { type: "boolean", default: false },
    "cli-prefix": { type: "string" },
    "no-cli": { type: "boolean", default: false },
  },
}).values
const repo = path.resolve(import.meta.dir, "..", "..")
const pinFile = path.join(repo, "own", "ledger", "codex-pin.json")
const pin: { commit: string; date: string; release?: string; cli?: string; tracked: Record<string, Array<string>> } =
  await Bun.file(pinFile).json()
const refs = path.join(path.dirname(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")), "refs")
const ref = args.ref ?? path.join(refs, "codex")

const release = args.to ?? latestRelease()
git(ref, "fetch", "--quiet", "--no-tags", "origin", `refs/tags/${release}:refs/tags/${release}`)
const target = git(ref, "rev-parse", `${release}^{commit}`)
if (target === pin.commit) {
  console.log(`codex-sync: pin ${pin.release ?? pin.commit.slice(0, 10)} is current`)
  process.exit(0)
}

console.log(`codex-sync: ${pin.release ?? pin.commit.slice(0, 10)} (${pin.date}) → ${release} (${date(target)})\n`)
// Release tags sit on release branches, so compare trees (diff) rather than walking a commit range.
for (const [area, paths] of Object.entries(pin.tracked)) {
  const stat = git(ref, "diff", "--stat=120", pin.commit, target, "--", ...paths)
  console.log(`## ${area}: ${stat === "" ? "no change" : `\n${stat}\n`}`)
}

const before = models(pin.commit)
const after = models(target)
const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap((slug) => {
  const a = before.get(slug)
  const b = after.get(slug)
  if (a === undefined) return [`+ ${slug}`]
  if (b === undefined) return [`- ${slug}`]
  const fields = Object.keys({ ...a, ...b }).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
  return fields.length === 0 ? [] : [`~ ${slug}: ${fields.join(", ")}`]
})
console.log(`## models: ${changes.length === 0 ? "no change" : `\n${changes.join("\n")}`}`)

if (!args.apply) {
  console.log("\nRe-run with --apply to move the pin, regenerate codex-data and install the CLI.")
  process.exit(0)
}
if (args["no-cli"] && args["cli-prefix"] !== undefined) {
  console.error("codex-sync: --cli-prefix and --no-cli exclude each other")
  process.exit(2)
}
const generated = Bun.spawnSync(["bun", "script/codex-data.ts", ref, target], {
  cwd: path.join(repo, "packages", "own-harness"),
  stdout: "inherit",
  stderr: "inherit",
})
if (generated.exitCode !== 0) process.exit(generated.exitCode)
const cli = release.replace(/^rust-v/, "")
// Beside the clone, not beside the main checkout: a main checkout elsewhere has no refs/ (A6).
const prefix = path.resolve(args["cli-prefix"] ?? path.join(path.dirname(path.resolve(ref)), "codex-cli", cli))
if (!args["no-cli"]) {
  fs.mkdirSync(prefix, { recursive: true })
  const installed = Bun.spawnSync(
    ["npm", "install", "--no-audit", "--no-fund", "--prefix", prefix, `@openai/codex@${cli}`],
    { stdout: "inherit", stderr: "inherit" },
  )
  if (installed.exitCode !== 0) process.exit(installed.exitCode)
}
// The installed packages' npm integrity, so the ledger names exactly what was downloaded (CX171-2); none without a CLI.
const { cliIntegrity: _old, ...kept } = pin as typeof pin & { cliIntegrity?: unknown }
const integrity = args["no-cli"] ? undefined : installedIntegrity(prefix)
await Bun.write(
  pinFile,
  `${JSON.stringify({ ...kept, commit: target, date: date(target), release, cli, ...(integrity ? { cliIntegrity: integrity } : {}) }, null, 2)}\n`,
)
console.log(
  args["no-cli"]
    ? `codex-sync: pin moved to ${release}; Codex CLI ${cli} is not installed, so the goldens wait for a capture with it.`
    : `codex-sync: pin moved to ${release}. Now: cd packages/own-harness && ` +
        `OWN_CODEX_BIN=${path.join(prefix, "node_modules", ".bin", "codex")} bun script/codex-golden.ts && bun typecheck && bun test`,
)

/** `@openai/codex*` packages of the install's package-lock with their npm integrity; `undefined` without a lock. */
function installedIntegrity(prefix: string) {
  const lock = path.join(prefix, "package-lock.json")
  if (!fs.existsSync(lock)) return undefined
  const packages: Record<string, { integrity?: string }> = JSON.parse(fs.readFileSync(lock, "utf8")).packages ?? {}
  return Object.fromEntries(
    Object.entries(packages)
      .filter(([name, entry]) => name.startsWith("node_modules/@openai/codex") && entry.integrity !== undefined)
      .map(([name, entry]) => [name.slice("node_modules/".length), entry.integrity!]),
  )
}

/** The newest stable `rust-vX.Y.Z` tag on the Codex remote (alphas and betas excluded). */
function latestRelease() {
  const tags = git(ref, "ls-remote", "--tags", "--refs", "origin", "rust-v*")
    .split("\n")
    .map((line) => line.split("refs/tags/")[1] ?? "")
    .filter((tag) => /^rust-v\d+\.\d+\.\d+$/.test(tag))
  const key = (tag: string) => tag.slice("rust-v".length).split(".").map(Number)
  return tags.toSorted((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!
  }).at(-1)!
}

/** Per model: the catalog fields the harness uses, with each prompt fragment as a hash so a change names its field. */
function models(revision: string) {
  const catalog: { models: Array<Record<string, unknown>> } = JSON.parse(
    git(ref, "show", `${revision}:codex-rs/models-manager/models.json`),
  )
  return new Map(
    catalog.models.map((model) => {
      const messages = (model.model_messages ?? {}) as Record<string, unknown>
      const { model_messages: _, ...rest } = model
      const hashed = Object.fromEntries(
        Object.entries(messages).map(([key, value]) => [
          `model_messages.${key}`,
          new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex"),
        ]),
      )
      return [String(model.slug), { ...rest, ...hashed }]
    }),
  )
}

function date(revision: string) {
  return git(ref, "log", "-1", "--format=%cI", revision)
}

function git(cwd: string, ...rest: Array<string>) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...rest])
  if (result.exitCode !== 0) throw new Error(`git ${rest.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}
