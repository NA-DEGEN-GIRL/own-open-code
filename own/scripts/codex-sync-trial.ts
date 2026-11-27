// One command for the next Codex sync (10 §6.14 "자동으로 되는 것과 업데이트가 필요한 것"): makes a throwaway worktree
// on a new branch, moves the Codex pin there (codex-sync.ts --apply), recaptures the goldens when the matching Codex
// CLI is already installed, runs the checks that judge a sync, scans the new release for what own's runtime acceptance
// cannot follow without code, commits what it generated on the branch and writes a report for review. It never
// merges, pushes, installs a Codex CLI or touches the user's service: a run is for a developer or an agent to review.
// New Codex models need none of this: own runs them from the account's served rows at once (CodexModels.decode).
//
//   bun own/scripts/codex-sync-trial.ts [--to <rust-vX.Y.Z>] [--base <ref>] [--ref <codex clone>] [--skip-tests]
//   bun own/scripts/codex-sync-trial.ts --scan-only [--to <tag>] [--ref <codex clone>]   # the scan, in this checkout
//
// Defaults: the newest stable release tag of the reference clone, base `main`, the clone `--ref`, else
// `OWN_CODEX_REF`, else refs/codex beside the main checkout (on this PC the clone is the one under
// `D:/#Projects/own-open-code/refs`, so pass it). The worktree is `<main checkout>/.worktrees/codex-sync-<version>`
// on branch `codex-sync-<version>` (refused if either exists). The report goes to
// `<worktree>/own/.out/codex-sync/<version>/report.md` (ignored by git).
// Heavy suites (the golden e2e) run under own/scripts/test/heavy.ts. Exit: 0 every check passed and nothing needs code,
// 1 something to review, 2 usage or setup error.
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

const args = parseArgs({
  options: {
    to: { type: "string" },
    base: { type: "string", default: "main" },
    ref: { type: "string" },
    "skip-tests": { type: "boolean", default: false },
    "scan-only": { type: "boolean", default: false },
  },
}).values

const here = path.resolve(import.meta.dir, "..", "..")
const main = path.dirname(git(here, "rev-parse", "--path-format=absolute", "--git-common-dir"))
const clone = args.ref ?? process.env.OWN_CODEX_REF ?? path.join(main, "refs", "codex")
if (!fs.existsSync(clone)) fail(`no Codex reference clone at ${clone}; pass --ref`)
git(clone, "fetch", "--quiet", "--tags", "origin")
const tag = args.to ?? latestRelease(clone)
if (args["scan-only"]) {
  const scanned = await scanRelease(clone, git(clone, "rev-parse", `${tag}^{commit}`), here)
  console.log(JSON.stringify(scanned, null, 2))
  process.exit(scanned.values.length + scanned.tools.length === 0 ? 0 : 1)
}
const version = tag.replace(/^rust-v/, "")
const branch = `codex-sync-${version}`
const tree = path.join(main, ".worktrees", branch)
if (fs.existsSync(tree)) fail(`${tree} exists; remove it or review it first`)
if (run(main, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0)
  fail(`branch ${branch} exists; delete it or review it first`)

const steps: Array<{ readonly name: string; readonly ok: boolean; readonly detail: string }> = []
const step = (name: string, cwd: string, command: ReadonlyArray<string>) => {
  console.log(`codex-sync-trial: ${name}`)
  const result = run(cwd, command)
  steps.push({ name, ok: result.code === 0, detail: tail(result.out) })
  return result
}

git(main, "worktree", "add", "-b", branch, tree, args.base)
step("bun install", tree, ["bun", "install", "--frozen-lockfile"])
const cli = path.join(path.dirname(clone), "codex-cli", version)
const installed = fs.existsSync(path.join(cli, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex"))
// The CLI download needs the user's OK: an installed one is used, else the pin moves without it.
const sync = step("codex-sync --apply", tree, [
  "bun",
  "own/scripts/codex-sync.ts",
  "--ref",
  clone,
  "--to",
  tag,
  "--apply",
  ...(installed ? ["--cli-prefix", cli] : ["--no-cli"]),
])
if (installed) step("codex-golden", path.join(tree, "packages", "own-harness"), ["bun", "script/codex-golden.ts"])

const pin: { commit: string } = JSON.parse(fs.readFileSync(path.join(tree, "own", "ledger", "codex-pin.json"), "utf8"))
const scan = await scanRelease(clone, pin.commit, tree)

if (!args["skip-tests"]) {
  for (const pkg of ["own-protocol", "own-harness", "own-accounts"])
    step(`${pkg} typecheck`, path.join(tree, "packages", pkg), ["bun", "typecheck"])
  step("own-protocol unit", path.join(tree, "packages", "own-protocol"), ["bun", "test"])
  step("own-harness unit", path.join(tree, "packages", "own-harness"), ["bun", "run", "test"])
  step("own-accounts codex-meta", path.join(tree, "packages", "own-accounts"), [
    "bun",
    "test",
    "test/slots/codex-meta.test.ts",
  ])
  step("own-harness goldens (e2e)", path.join(tree, "packages", "own-harness"), [
    "bun",
    "../../own/scripts/test/heavy.ts",
    "bun",
    "test",
    "--timeout=200000",
    "test/e2e/golden.test.ts",
    "test/e2e/golden-gpt6.test.ts",
    "test/e2e/golden-unknown.test.ts",
    "test/e2e/runtime-row.test.ts",
  ])
}

const changed = git(tree, "status", "--porcelain")
if (changed !== "") {
  git(tree, "add", "-A")
  git(
    tree,
    "commit",
    "-q",
    "-m",
    `chore(own-harness): move the Codex pin to ${tag} (codex-sync-trial)\n\nGenerated by own/scripts/codex-sync-trial.ts for review; not merged.`,
  )
}

const failed = steps.filter((item) => !item.ok)
const needsCode = scan.values.length + scan.tools.length > 0
const report = [
  `# codex-sync trial: ${tag}`,
  "",
  `Worktree \`${tree}\`, branch \`${branch}\` (from \`${args.base}\`). ${installed ? `Codex CLI ${version} found: goldens recaptured.` : `Codex CLI ${version} is not installed (the download needs the user's OK): goldens not recaptured.`}`,
  "",
  "## What the sync reported",
  "",
  "```",
  sync.out.trim(),
  "```",
  "",
  "## Checks",
  "",
  ...steps.map((item) => `- ${item.ok ? "ok" : "FAILED"}: ${item.name}${item.ok ? "" : `\n\n  \`\`\`\n${item.detail}\n  \`\`\``}`),
  "",
  "## Needs code (runtime acceptance cannot follow these)",
  "",
  ...(needsCode
    ? [
        ...scan.values.map((item) => `- \`${item.field}\` value \`${item.value}\` (Codex enum ${item.enum}) is not one own runs`),
        ...scan.tools.map((name) => `- \`experimental_supported_tools\` name \`${name}\` is read by Codex ${tag} and not by own`),
      ]
    : ["- nothing new: models with these rows run from their served rows without an own update"]),
  "",
  "## Default-on feature changes since the old pin",
  "",
  ...(scan.features.length === 0 ? ["- none"] : scan.features.map((line) => `- ${line}`)),
  "",
  "Review the area diffs above against own-harness (10 §5), port what is model-visible, update 10 §6.x, the decisions",
  "log and the ledger, then merge the branch `--no-ff` as usual.",
  "",
].join("\n")
const out = path.join(tree, "own", ".out", "codex-sync", version)
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, "report.md"), report)
console.log(`codex-sync-trial: report ${path.join(out, "report.md")}`)
console.log(
  failed.length === 0 && !needsCode
    ? "codex-sync-trial: every check passed and nothing needs code; review and merge the branch"
    : `codex-sync-trial: ${failed.length} check(s) failed, ${scan.values.length + scan.tools.length} item(s) need code`,
)
process.exit(failed.length === 0 && !needsCode ? 0 : 1)

/**
 * What the new release reads that own cannot run from a served row: enum values of the judged `ModelInfo` fields
 * outside own-protocol's `HARNESS_VALUES` (minus the ones own leaves out by design, listed below), and
 * `experimental_supported_tools` names outside own-harness's `EXPERIMENTAL_TOOLS`; with the default-on feature flags
 * that changed since the old pin.
 */
async function scanRelease(codex: string, commit: string, worktree: string) {
  const { CodexModels } = await import(path.join(worktree, "packages", "own-protocol", "src", "codex-models.ts"))
  const { Catalog } = await import(path.join(worktree, "packages", "own-harness", "src", "codex", "catalog.ts"))
  const handled = new Map<string, ReadonlyArray<string>>(CodexModels.HARNESS_VALUES)
  const known: ReadonlyArray<string> = Catalog.EXPERIMENTAL_TOOLS
  // Values Codex knows that own leaves out on purpose (a row with one is left out and named on the card).
  const byDesign = new Set(["shell_type:disabled", "tool_mode:code_mode", "multi_agent_version:disabled"])
  const enums: ReadonlyArray<readonly [string, string, string]> = [
    ["shell_type", "ConfigShellToolType", "codex-rs/protocol/src/openai_models.rs"],
    ["apply_patch_tool_type", "ApplyPatchToolType", "codex-rs/protocol/src/openai_models.rs"],
    ["tool_mode", "ToolMode", "codex-rs/protocol/src/openai_models.rs"],
    ["truncation_policy.mode", "TruncationMode", "codex-rs/protocol/src/openai_models.rs"],
    ["web_search_tool_type", "WebSearchToolType", "codex-rs/protocol/src/openai_models.rs"],
    ["multi_agent_version", "MultiAgentVersion", "codex-rs/protocol/src/protocol.rs"],
    ["default_reasoning_summary", "ReasoningSummary", "codex-rs/protocol/src/config_types.rs"],
    ["default_verbosity", "Verbosity", "codex-rs/protocol/src/config_types.rs"],
  ]
  const values = enums.flatMap(([field, name, file]) =>
    variants(git(codex, "show", `${commit}:${file}`), name)
      .filter((value) => !(handled.get(field) ?? []).includes(value) && !byDesign.has(`${field}:${value}`))
      .map((value) => ({ field, enum: name, value })),
  )
  // The names Codex compares a model's `experimental_supported_tools` with: `tool == "name"`, `"a" | "b"` arms and
  // `tool == NAME` constants, in the lines after each read of the field (tests left out).
  const read = git(
    codex,
    "grep",
    "-h",
    "-A12",
    "experimental_supported_tools",
    commit,
    "--",
    "codex-rs/core/src",
    "codex-rs/ext",
    ":(exclude)*tests*",
    ":(exclude)*_tests.rs",
  )
  const constants = [...read.matchAll(/==\s*([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]!)
  const resolved = constants.flatMap((name) => {
    const found = run(codex, ["git", "grep", "-h", `const ${name}: &str = "`, commit, "--", "codex-rs"]).out
    return [...found.matchAll(/=\s*"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]!)
  })
  const names = [
    ...new Set([
      ...[...read.matchAll(/==\s*"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]!),
      ...[...read.matchAll(/"([a-z][a-z0-9_]*)"\s*\|\s*"([a-z][a-z0-9_]*)"/g)].flatMap((match) => [match[1]!, match[2]!]),
      ...resolved,
    ]),
  ]
  const tools = names.filter((name) => name !== "test_sync_tool" && !known.includes(name))
  const old: { commit: string } = JSON.parse(git(main, "show", `${args.base}:own/ledger/codex-pin.json`))
  const features = defaultsChanged(codex, old.commit, commit)
  return { values, tools, features }
}

/** The serde names of a Rust enum's variants (snake_case), with its aliases. */
function variants(source: string, name: string) {
  const body = new RegExp(`pub enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? ""
  const named = [...body.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*[,({]/gm)].map((match) =>
    match[1]!.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase(),
  )
  const aliases = [...body.matchAll(/alias\s*=\s*"([^"]+)"/g)].map((match) => match[1]!)
  const renamed = [...body.matchAll(/rename\s*=\s*"([^"]+)"/g)].map((match) => match[1]!)
  return [...new Set([...named, ...aliases, ...renamed])]
}

/** Feature flags whose default changed between the two commits (`codex-rs/features/src/lib.rs`). */
function defaultsChanged(codex: string, from: string, to: string) {
  const specs = (commit: string) => {
    const source = git(codex, "show", `${commit}:codex-rs/features/src/lib.rs`)
    return new Map(
      [...source.matchAll(/key:\s*"([^"]+)",[\s\S]*?default_enabled:\s*(true|false)/g)].map(
        (match) => [match[1]!, match[2] === "true"] as const,
      ),
    )
  }
  const [before, after] = [specs(from), specs(to)]
  return [...after]
    .filter(([key, on]) => before.get(key) !== on)
    .map(([key, on]) => `\`${key}\`: ${before.has(key) ? (before.get(key) ? "on" : "off") : "new"} → ${on ? "on" : "off"}`)
}

/** The newest stable `rust-vX.Y.Z` tag of the clone. */
function latestRelease(codex: string) {
  const tags = git(codex, "tag", "-l", "rust-v*")
    .split("\n")
    .filter((name) => /^rust-v\d+\.\d+\.\d+$/.test(name))
  const key = (name: string) => name.slice("rust-v".length).split(".").map(Number)
  return tags.toSorted((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!
  }).at(-1)!
}

function tail(text: string) {
  return text.trim().split("\n").slice(-30).join("\n")
}

function run(cwd: string, command: ReadonlyArray<string>) {
  const result = Bun.spawnSync([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` }
}

function git(cwd: string, ...rest: Array<string>) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...rest])
  if (result.exitCode !== 0) throw new Error(`git ${rest.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function fail(message: string): never {
  console.error(`codex-sync-trial: ${message}`)
  process.exit(2)
}
