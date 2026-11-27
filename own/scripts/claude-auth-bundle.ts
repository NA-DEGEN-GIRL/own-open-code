// Builds the Claude subscription plugin that ships inside the app (02 §8.2, user decision CB 2026-10-18 "넣고 항상
// 켜기"): the pinned opencode-claude-auth-v2 of own/vendor/claude-auth, installed from the committed lock, verified,
// patched with patches/<version>.json and bundled into one file, laid out as app\<ver>\plugins\claude-auth:
//
//   server.js                               export { default } from "opencode-claude-auth-v2"
//   package.json                            {"private": true, "type": "module"}
//   own-bundle.json                         {schema, package, version, integrity, patchSha256, buildId, files}
//   node_modules\opencode-claude-auth-v2\   the package's package.json, index.js and LICENSE as published, and
//     dist\index.js                         its patched dist as one ESM file
//
//   bun own/scripts/claude-auth-bundle.ts --out <dir> [--build-id <id>] [--keep]
//
// install  `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` in a temp copy of the template's
//          package.json and lock: only what the lock pins (from the npm cache when it holds it), every tarball checked
//          by npm against the lock's integrity
// verify   the installed package and npm's hidden lockfile name the template's version and integrity
// patch    every file of the manifest has its preSha256, every find occurs exactly once in what the edits before it
//          left, every result has its postSha256; any difference fails the build before anything is written to --out
// bundle   Bun.build of the patched package (target bun, ESM, not minified: the shipped file stays readable). The host's
//          `@opencode/plugin` and `effect` stay external (the service hands its own modules to plugins). Every module of
//          the package may import only its own files, `node:` built-ins and those host modules, so no other package's
//          code is in the file and the package's MIT LICENSE covers it.
// check    the bundle loads (with a stub host module in the work folder) and carries the plugin id, the patch's marker
//          and the multi-account exports own-accounts calls
// write    the layout above; own-bundle.json lists the sha256 of every other file, which own-accounts checks before it
//          lets the plugin sign for several accounts (`ClaudeBundle.read`)
//
// Why under node_modules: the upstream plugin loader evaluates a local plugin's own files again on every load (one copy
// per Location) but leaves files under node_modules in the module cache. The plugin keeps its accounts in module state
// that every Location and own's egress relay share, so the bundle sits where the npm install had it.
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

export const PACKAGE = "opencode-claude-auth-v2"
export const PLUGIN_ID = "heymaaz.claude-auth-v2"
export const MARKER = "OWN_MULTI_ACCOUNT"
export const RECORD_FILE = "own-bundle.json"
export const TEMPLATE = path.resolve(import.meta.dir, "..", "vendor", "claude-auth")
/** The exports own-accounts calls on the loaded module (`ClaudeWire`). */
export const EXPORTS = [
  "injectClaudeIdentity",
  "prepareClaudeRequest",
  "finishClaudeResponse",
  "getActiveAccount",
  "bindSession",
  "unbindSession",
  "accountOf",
  "ownAccounts",
  "ownUseStateDir",
  "ownOnRefresh",
] as const
/** Module specifiers the service provides to plugins (`plugin/src/runtime-modules.ts`). */
const HOST_MODULES = ["@opencode/plugin", "effect"]
const NPM_ARGS = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"]

export interface Pin {
  readonly version: string
  readonly integrity: string
}

export interface Manifest extends Pin {
  readonly schema: 1
  readonly package: string
  readonly marker: string
  readonly files: ReadonlyArray<{
    readonly file: string
    readonly preSha256: string
    readonly postSha256: string
    readonly edits: ReadonlyArray<{ readonly find: string; readonly replace: string }>
  }>
}

export interface BundleRecord extends Pin {
  readonly schema: 1
  readonly package: string
  readonly patchSha256: string
  readonly buildId: string | null
  /** Every file of the folder but this record, by forward-slash path: its sha256. */
  readonly files: { readonly [file: string]: string }
}

async function main() {
  const args = parseArgs({
    options: { out: { type: "string" }, "build-id": { type: "string" }, keep: { type: "boolean", default: false } },
  }).values
  if (!args.out) {
    console.error("usage: bun own/scripts/claude-auth-bundle.ts --out <dir> [--build-id <id>] [--keep]")
    process.exit(2)
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-auth-bundle-"))
  try {
    const record = await build({ out: path.resolve(args.out), work, buildId: args["build-id"] ?? null })
    const bytes = Object.keys(record.files).reduce((sum, file) => sum + fs.statSync(path.join(args.out!, file)).size, 0)
    console.log(
      JSON.stringify({ out: path.resolve(args.out), version: record.version, patchSha256: record.patchSha256, bytes }),
    )
  } finally {
    if (args.keep) console.error(`work folder kept: ${work}`)
    else fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** install → verify → patch → bundle → check → write, in `work`; `out` is replaced only after every check passed. */
export async function build(input: {
  readonly out: string
  readonly work: string
  readonly buildId: string | null
  readonly template?: string
  /** Runs `npm ci` in a folder; tests pass a fake. */
  readonly install?: (dir: string) => Promise<void>
}) {
  const template = input.template ?? TEMPLATE
  const pin = readPin(template)
  const manifestBytes = readManifest(template, pin.version)
  const manifest = parseManifest(manifestBytes, pin)
  const shim = path.join(input.work, "install")
  fs.mkdirSync(shim, { recursive: true })
  for (const name of ["package.json", "package-lock.json"])
    fs.copyFileSync(path.join(template, name), path.join(shim, name))
  await (input.install ?? npmCi)(shim)
  const pkg = path.join(shim, "node_modules", PACKAGE)
  verifyInstall(shim, pin)
  applyManifest(pkg, manifest)
  checkImports(pkg)
  const text = await bundle(pkg, input.work)
  const stage = path.join(input.work, "stage")
  const record = writeLayout(stage, pkg, text, {
    schema: 1,
    package: PACKAGE,
    version: pin.version,
    integrity: pin.integrity,
    patchSha256: sha256(manifestBytes),
    buildId: input.buildId,
  })
  await checkLoad(stage, input.work)
  fs.rmSync(input.out, { recursive: true, force: true, maxRetries: 3 })
  fs.mkdirSync(path.dirname(input.out), { recursive: true })
  fs.cpSync(stage, input.out, { recursive: true })
  return record
}

/** `packages["node_modules/opencode-claude-auth-v2"]` of the template's lock. */
export function readPin(template: string): Pin {
  const lock = JSON.parse(fs.readFileSync(path.join(template, "package-lock.json"), "utf8")) as {
    packages: { [key: string]: { version?: string; integrity?: string } }
  }
  const entry = lock.packages[`node_modules/${PACKAGE}`]
  if (!entry?.version || !entry.integrity) throw new Error(`${template}: the lock pins no ${PACKAGE}`)
  return { version: entry.version, integrity: entry.integrity }
}

function readManifest(template: string, version: string) {
  const file = path.join(template, "patches", `${version}.json`)
  if (!fs.existsSync(file)) throw new Error(`no patch manifest for the pinned version ${version} (${file})`)
  return fs.readFileSync(file)
}

/** The manifest, refused unless it names exactly the pinned package, version and integrity. */
export function parseManifest(bytes: Uint8Array, pin: Pin): Manifest {
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest
  if (
    manifest.schema !== 1 ||
    manifest.package !== PACKAGE ||
    manifest.version !== pin.version ||
    manifest.integrity !== pin.integrity ||
    manifest.marker !== MARKER ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  )
    throw new Error(`the patch manifest does not describe ${PACKAGE}@${pin.version} (${pin.integrity})`)
  return manifest
}

/** The installed package and npm's hidden lockfile must name the pinned version and integrity. */
export function verifyInstall(shim: string, pin: Pin) {
  const installed = JSON.parse(fs.readFileSync(path.join(shim, "node_modules", PACKAGE, "package.json"), "utf8")) as {
    version?: string
  }
  const hidden = JSON.parse(fs.readFileSync(path.join(shim, "node_modules", ".package-lock.json"), "utf8")) as {
    packages?: { [key: string]: { version?: string; integrity?: string } }
  }
  const recorded = hidden.packages?.[`node_modules/${PACKAGE}`]
  if (installed.version !== pin.version || recorded?.version !== pin.version || recorded.integrity !== pin.integrity)
    throw new Error(
      `integrity_mismatch: installed ${PACKAGE} ${installed.version} / ${recorded?.integrity} is not ${pin.version} / ${pin.integrity}`,
    )
}

/** Applies every file's edits in place; throws on a pre-hash, a find that is not unique, or a post-hash. */
export function applyManifest(pkg: string, manifest: Manifest) {
  const patched = manifest.files.map((entry) => {
    if (!/^dist\/[A-Za-z0-9._-]+\.js$/.test(entry.file)) throw new Error(`patch: unexpected file ${entry.file}`)
    const file = path.join(pkg, ...entry.file.split("/"))
    const text = fs.readFileSync(file, "utf8")
    if (sha256(text) !== entry.preSha256) throw new Error(`patch_pre_hash:${entry.file}`)
    const next = entry.edits.reduce((current, edit) => {
      const at = current.indexOf(edit.find)
      if (at < 0 || current.indexOf(edit.find, at + 1) >= 0) throw new Error(`patch_find:${entry.file}`)
      return current.slice(0, at) + edit.replace + current.slice(at + edit.find.length)
    }, text)
    if (sha256(next) !== entry.postSha256) throw new Error(`patch_post_hash:${entry.file}`)
    return { file, next }
  })
  for (const item of patched) fs.writeFileSync(item.file, item.next)
}

/**
 * Every module reachable from the package's entry imports only its own files, `node:` built-ins and the host modules,
 * so the bundle holds nothing but this package's code.
 */
export function checkImports(pkg: string) {
  const transpiler = new Bun.Transpiler({ loader: "js", target: "bun" })
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const item of transpiler.scanImports(fs.readFileSync(file, "utf8"))) {
      if (item.path.startsWith("./") || item.path.startsWith("../")) {
        const target = path.resolve(path.dirname(file), item.path)
        if (path.relative(pkg, target).startsWith(".."))
          throw new Error(`${file}: imports outside the package: ${item.path}`)
        visit(target)
        continue
      }
      if (
        item.path.startsWith("node:") ||
        HOST_MODULES.some((name) => item.path === name || item.path.startsWith(`${name}/`))
      )
        continue
      throw new Error(`${path.relative(pkg, file)}: imports ${item.path}, which would be bundled`)
    }
  }
  visit(path.join(pkg, "index.js"))
  return [...seen].map((file) => path.relative(pkg, file).split(path.sep).join("/")).sort()
}

/**
 * The patched package as one ESM file with the host modules left external. `bun build` runs in the package folder:
 * its module comments name paths relative to the working directory (`// dist/keychain.js`), so the file never depends
 * on where it was built.
 */
export async function bundle(pkg: string, work: string) {
  const outfile = path.join(work, "bundle.js")
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      path.join("dist", "index.js"),
      "--target=bun",
      "--format=esm",
      ...HOST_MODULES.flatMap((name) => [`--external=${name}`, `--external=${name}/*`]),
      `--outfile=${outfile}`,
    ],
    { cwd: pkg, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0 || !fs.existsSync(outfile))
    throw new Error(`bun build failed (${code}): ${`${stdout}\n${stderr}`.trim()}`)
  const text = fs.readFileSync(outfile, "utf8")
  if (!text.includes(`${MARKER} = 1`)) throw new Error(`the bundle has no ${MARKER} marker`)
  return text
}

/** Writes the layout into `dir` and its record; answers the record. */
export function writeLayout(dir: string, pkg: string, text: string, header: Omit<BundleRecord, "files">): BundleRecord {
  fs.rmSync(dir, { recursive: true, force: true })
  const target = path.join(dir, "node_modules", PACKAGE)
  fs.mkdirSync(path.join(target, "dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, "server.js"), `export { default } from "${PACKAGE}"\n`)
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`)
  for (const name of ["package.json", "index.js", "LICENSE"])
    fs.copyFileSync(path.join(pkg, name), path.join(target, name))
  fs.writeFileSync(path.join(target, "dist", "index.js"), text)
  const files = Object.fromEntries(
    walk(dir)
      .sort()
      .map((rel) => [rel, sha256(fs.readFileSync(path.join(dir, ...rel.split("/"))))]),
  )
  const record: BundleRecord = { ...header, files }
  fs.writeFileSync(path.join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/**
 * Imports a copy of the staged plugin next to a stub `@opencode/plugin` (only the constructors the plugin calls at
 * load) and checks the plugin id, the marker and the exports own calls. Nothing is set up and no account is read.
 */
export async function checkLoad(stage: string, work: string) {
  const dir = path.join(work, "load")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.cpSync(stage, dir, { recursive: true })
  const stub = path.join(dir, "node_modules", "@opencode", "plugin")
  fs.mkdirSync(stub, { recursive: true })
  fs.writeFileSync(
    path.join(stub, "package.json"),
    `${JSON.stringify({ name: "@opencode/plugin", type: "module", exports: { ".": "./index.js" } })}\n`,
  )
  fs.writeFileSync(path.join(stub, "index.js"), STUB)
  const module = (await import(path.join(dir, "node_modules", PACKAGE, "index.js"))) as { [name: string]: unknown }
  const plugin = module.default as { id?: unknown; setup?: unknown } | undefined
  const missing = EXPORTS.filter((name) => typeof module[name] !== "function")
  if (plugin?.id !== PLUGIN_ID || typeof plugin.setup !== "function" || module[MARKER] !== 1 || missing.length > 0)
    throw new Error(`the bundle does not load as ${PLUGIN_ID} with ${MARKER} (missing: ${missing.join(", ") || "-"})`)
  const server = (await import(path.join(dir, "server.js"))) as { default?: unknown }
  if (server.default !== module.default) throw new Error("server.js does not re-export the bundled plugin")
}

/** Files under `dir` by forward-slash path, the record left out. */
function walk(dir: string, prefix = ""): string[] {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return walk(dir, rel)
    return rel === RECORD_FILE ? [] : [rel]
  })
}

/** `npm ci` through `node npm-cli.js` (no shell), else `npm.cmd` through cmd.exe on Windows. */
async function npmCi(dir: string) {
  const node = Bun.which("node")
  const cli = node ? path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js") : undefined
  const command =
    node && cli && fs.existsSync(cli)
      ? [node, cli, ...NPM_ARGS]
      : process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `npm.cmd ${NPM_ARGS.join(" ")}`]
        : ["npm", ...NPM_ARGS]
  const proc = Bun.spawn(command, { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`npm ci failed (${code}): ${stderr.trim().slice(-600)}`)
}

export function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

const STUB = `// Stub of @opencode/plugin for the load check: only what claude-auth calls when it is imported or set up.
export const Plugin = { define: (definition) => definition }
export const Provider = { ID: { make: (value) => value } }
export const Integration = { ID: { make: (value) => value }, MethodID: { make: (value) => value } }
export const Credential = { OAuth: { make: (value) => value } }
`

// Last, so every constant above is initialized when the script runs.
if (import.meta.main) await main()
