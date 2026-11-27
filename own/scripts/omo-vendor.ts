// Vendors the oh-my-opencode (omo, SUL-1.0) sources own-omo's runtime bundle needs, at one tag (own/docs/15 §7):
// `bun own/scripts/omo-vendor.ts --from <omo clone> --tag v5.1.50 [--out own/vendor/oh-my-opencode] [--work <empty dir>]
//  [--accept-license-change]`.
//
// The clone is only read, with git plumbing (`rev-parse`, `ls-tree`, `cat-file --batch`): nothing is checked out or
// built there. The tagged tree's packages are written to a work folder (a new folder under the system temp folder
// unless `--work` names one), and the static import closure of packages/own-omo/src/runtime-entry.ts is computed with
// the bundle's own resolver (packages/own-omo/script/resolve.ts, bare npm imports left out). That closure, each of its
// packages' package.json and the root package.json are copied byte for byte to `<out>/src/` (the old `src/` is
// replaced), LICENSE.md and THIRD-PARTY-NOTICES.md to `<out>/`, every copied file's sha256 to `<out>/source.json`, and
// the pin (tag, tag object, commit, versions, license hash) to `<out>/pin.json` and own/ledger/omo-pin.json. A license
// text that differs from the previous pin's fails the run before anything is written (no work folder, no `<out>` or
// ledger change) unless `--accept-license-change` is given: a new license needs a decision before it is vendored.
// README.md, MODIFICATIONS.md and the patches are written by hand.
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { plugin } from "../../packages/own-omo/script/resolve"

const REPO = path.resolve(import.meta.dir, "..", "..")
const ENTRY = "packages/own-omo/src/runtime-entry.ts"
const LEDGER = path.join(REPO, "own", "ledger", "omo-pin.json")
/** Packages never vendored: prebuilt platform binaries and launchers (MIT), the LSP daemon and tools (MIT), the web site. */
const SKIPPED = [/^oh-my-opencode-/, /^lsp-daemon$/, /^lsp-tools-mcp$/, /^web$/, /^omo-native$/]
const COPIED = ["LICENSE.md", "THIRD-PARTY-NOTICES.md"]

const args = parseArgs(process.argv.slice(2))
const clone = path.resolve(required(args, "from"))
const tag = required(args, "tag")
const out = path.resolve(REPO, args.out ?? "own/vendor/oh-my-opencode")

const tagObject = git(["rev-parse", "--verify", `refs/tags/${tag}`]).trim()
const commit = git(["rev-parse", "--verify", `${tag}^{commit}`]).trim()
const date = git(["log", "-1", "--format=%cI", commit]).trim()
const previous = fs.existsSync(LEDGER) ? (JSON.parse(fs.readFileSync(LEDGER, "utf8")) as { licenseSha256?: string }) : {}
const license = sha256(blob(`${commit}:LICENSE.md`))
if (previous.licenseSha256 !== undefined && previous.licenseSha256 !== license && args["accept-license-change"] !== "")
  throw new Error(`LICENSE.md changed (${previous.licenseSha256} → ${license}): read it, decide, then pass --accept-license-change`)
const work = args.work === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), "omo-vendor-")) : path.resolve(args.work)
if (fs.existsSync(work) && fs.readdirSync(work).length > 0) throw new Error(`--work must be empty: ${work}`)
const tree = path.join(work, "tree")

const entries = git(["ls-tree", "-r", "-z", "--full-tree", commit])
  .split("\0")
  .filter((line) => line !== "")
  .map((line) => {
    const [meta, file] = line.split("\t") as [string, string]
    const [mode, type, sha] = meta.split(" ") as [string, string, string]
    return { mode, type, sha, file }
  })
  .filter((entry) => entry.type === "blob" && entry.mode !== "120000" && wanted(entry.file))
materialize(entries)
console.log(`${tree}: ${entries.length} files of ${tag} (${commit.slice(0, 10)})`)

const seen = new Set<string>()
const loaded = new Set<string>()
const result = await Bun.build({
  entrypoints: [path.join(REPO, ENTRY)],
  target: "bun",
  format: "esm",
  loader: { ".md": "text" },
  plugins: [plugin(tree, { external: true, seen, loaded })],
})
if (!result.success) throw new AggregateError(result.logs, "the closure build failed")
const treePrefix = `${tree.replaceAll("\\", "/")}/`.toLowerCase()
const inputs = [...loaded]
  .map((input) => path.resolve(input).replaceAll("\\", "/"))
  .filter((input) => input.toLowerCase().startsWith(treePrefix))
  .map((input) => input.slice(treePrefix.length))
// omo's built-in skills read their SKILL.md from the shared skills folder when their module loads (skills-loader-core
// `loadSharedSkillTemplate`); the bundle ships those files in `skills/` next to the runtime (script/bundle.ts).
const templates = inputs
  .filter((input) => input.endsWith(".ts"))
  .flatMap((input) =>
    [...fs.readFileSync(path.join(tree, input), "utf8").matchAll(/loadSharedSkillTemplate\("([a-z0-9-]+)"\)/g)].map(
      (match) => `packages/shared-skills/skills/${match[1]}/SKILL.md`,
    ),
  )
const packages = [...new Set(inputs.flatMap((input) => input.match(/^packages\/[^/]+\//)?.[0] ?? []))]
const vendored = [
  ...new Set([...inputs, ...templates, ...packages.map((dir) => `${dir}package.json`), "package.json"]),
].sort()

fs.rmSync(path.join(out, "src"), { recursive: true, force: true })
const source = Object.fromEntries(
  vendored.map((file) => {
    const bytes = fs.readFileSync(path.join(tree, file))
    const target = path.join(out, "src", file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
    return [file, sha256(bytes)]
  }),
)
fs.writeFileSync(path.join(out, "source.json"), `${JSON.stringify(source, null, 2)}\n`)

COPIED.forEach((file) => fs.copyFileSync(path.join(tree, file), path.join(out, file)))

const root = JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8")) as {
  version: string
  repository?: { url?: string }
}
const adapter = JSON.parse(fs.readFileSync(path.join(tree, "packages/omo-opencode/package.json"), "utf8")) as {
  dependencies?: Record<string, string>
}
const pin = {
  repository: (root.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, ""),
  tag,
  tagObject,
  commit,
  date,
  version: root.version,
  v1Api: adapter.dependencies?.["@opencode-ai/plugin"],
  entry: ENTRY,
  files: vendored.length,
  licenseSha256: license,
  noticesSha256: sha256(fs.readFileSync(path.join(tree, "THIRD-PARTY-NOTICES.md"))),
  externals: [...seen].sort(),
}
const text = `${JSON.stringify(pin, null, 2)}\n`
fs.writeFileSync(path.join(out, "pin.json"), text)
fs.writeFileSync(LEDGER, text)
if (args.work === undefined) fs.rmSync(work, { recursive: true, force: true })
console.log(`${out}: ${vendored.length} files from ${packages.length} packages; npm imports: ${pin.externals.join(", ")}`)

function wanted(file: string) {
  if (COPIED.includes(file) || file === "package.json") return true
  const match = file.match(/^packages\/([^/]+)\/(.+)$/)
  if (match === null || SKIPPED.some((pattern) => pattern.test(match[1]!))) return false
  const rest = match[2]!
  if (/(^|\/)(node_modules|dist|__tests__|test|tests)\//.test(rest) || /\.test\.tsx?$/.test(rest)) return false
  return rest === "package.json" || /\.(ts|tsx|js|mjs|json|md)$/.test(rest)
}

/** Writes the blobs with one `git cat-file --batch`: `<sha> blob <size>\n<bytes>\n` per object, in request order. */
function materialize(list: ReadonlyArray<{ readonly sha: string; readonly file: string }>) {
  const run = Bun.spawnSync(["git", "-C", clone, "cat-file", "--batch"], {
    stdin: Buffer.from(list.map((entry) => `${entry.sha}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (run.exitCode !== 0) throw new Error(`git cat-file failed: ${run.stderr.toString()}`)
  const data = run.stdout
  let offset = 0
  for (const entry of list) {
    const newline = data.indexOf(10, offset)
    const header = data.subarray(offset, newline).toString()
    const size = Number(header.split(" ")[2])
    if (!header.startsWith(entry.sha) || !Number.isFinite(size)) throw new Error(`unexpected cat-file header: ${header}`)
    const target = path.join(tree, entry.file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data.subarray(newline + 1, newline + 1 + size))
    offset = newline + 1 + size + 1
  }
}

function git(argv: ReadonlyArray<string>) {
  const run = Bun.spawnSync(["git", "-C", clone, ...argv], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${argv.join(" ")} failed: ${run.stderr.toString()}`)
  return run.stdout.toString()
}

/** A blob's bytes (`<commit>:<path>`). */
function blob(spec: string) {
  const run = Bun.spawnSync(["git", "-C", clone, "cat-file", "blob", spec], { stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git cat-file blob ${spec} failed: ${run.stderr.toString()}`)
  return run.stdout
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function parseArgs(argv: ReadonlyArray<string>) {
  const parsed: Record<string, string | undefined> = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) parsed[flag.slice(2)] = ""
    else {
      parsed[flag.slice(2)] = next
      index++
    }
  }
  return parsed
}

function required(parsed: Record<string, string | undefined>, name: string) {
  const value = parsed[name]
  if (value === undefined || value === "") {
    console.error(
      "usage: bun own/scripts/omo-vendor.ts --from <omo clone> --tag <tag> [--out <dir>] [--work <empty dir>] [--accept-license-change]",
    )
    process.exit(2)
  }
  return value
}
