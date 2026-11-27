#!/usr/bin/env bun
/**
 * Release tooling for own-remote (04 §5.2, FORK §8.2 steps 1b, 3, 6). Called by own/scripts/build-remote.ps1; runs
 * with Bun so `define` values are passed as real string literals (PowerShell 5.1 strips quotes from native command
 * arguments, FORK §8.2 "Windows PowerShell 5.1 주의").
 *
 *   bun script/bundle.ts build-id --version <v>
 *   bun script/bundle.ts plugins  --out <dir> --version <v> --build-id <id> [--packages a,b,c]  (default DESKTOP_PLUGINS)
 *   bun script/bundle.ts package  --out <dir> --version <v> --build-id <id> --plugins <dir>
 *                                  --binary <target>=<path> [--binary …] [--tools <dir>] [--no-elf-check]
 *   bun script/bundle.ts verify-binary --version <v> --target <target> --binary <path> [--native-dir <dir>]
 *
 * `package` writes `<out>/remote/<target>.tar.gz`, `<out>/remote/manifest.json` (read by own-remote, `Bundle`) and
 * `<out>/remote/remote_artifacts.json` (the FORK §8.3 release-manifest entry); with `--tools <dir>` (script/native.ts
 * `lfs`) also each target's git-lfs as its own file `<out>/remote/tools/git-lfs/<ver>/<target>/` (06 §4.13), listed
 * under `tools` in both JSON files. `verify-binary` prints the RG2 report of a compiled Linux CLI (`inspectBinary`);
 * with `--native-dir` (script/native.ts) it also requires the target's native files.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { Broker } from "../src/protocol/broker.js"
import { Bundle } from "../src/remote/bundle.js"
import { Scripts } from "../src/remote/scripts.js"
import { RemoteCli } from "../src/vendor/remote/cli.js"
import { checkLfsBinary, ELF_MACHINES, GIT_LFS, NATIVE_PACKAGES } from "./native.js"

const REPO = path.resolve(import.meta.dir, "../../..")
/** The packages whose sources make the build id (FORK §8.2 1b). */
export const OWN_PACKAGES = [
  "own-protocol",
  "own-runtime",
  "own-accounts",
  "own-telemetry",
  "own-remote",
  "own-team",
  "own-computer-use",
  "own-import",
  "own-harness",
  "own-omo",
  "own-creator",
] as const
/**
 * The desktop release's plugin bundles in activation order (06 §2.6, `plugins` default; build-desktop.ps1
 * `$pluginNames`): the bundled claude-auth (02 §8.2, built apart by own/scripts/claude-auth-bundle.ts) goes after
 * own-team, own-computer-use after own-telemetry, own-import after it (09 §5.1: no hooks, so adding or reloading it
 * reloads no other plugin), own-harness after it (10 H0: no hooks yet, so adding it reloads no other plugin; its later
 * request hooks must transform the request after every other own plugin's), and own-omo last (15, 2026-10-28): its
 * request hooks run after own-harness's history translation, on omo sessions only. own-omo's folder also gets the omo
 * runtime ({@link OMO_RUNTIME}). own-creator after it (17, 2026-11-04): its compaction and retry hooks add to what
 * own-harness decided, and it is PC-only for now (17 §10).
 */
export const DESKTOP_PLUGINS = [
  "own-accounts",
  "own-remote",
  "own-team",
  "own-telemetry",
  "own-computer-use",
  "own-import",
  "own-harness",
  "own-omo",
  "own-creator",
] as const
/**
 * What a remote (SSH host) install carries, in the remote managed config's order: own-team runs remote teams
 * (06 §4.13, T3), own-telemetry fourth for the Claude subscription slot this PC relays (04 §8.11.14: the long-stall
 * cut and the extra-usage alert run in the host's sessions). own-computer-use never runs on a remote host, own-import
 * reads this PC's Codex and Claude Code stores only (PC-only in v1, 09 §7.1 I3), and claude-auth never goes to a host.
 * own-harness goes after them, as on this PC (10 §6.1): its request hooks must transform the request after every other
 * own plugin's, and a host's sessions run the harness their metadata names. own-omo goes last, as on this PC
 * (15 §1, 2026-10-29): a host's `omo` sessions run omo there, with its runtime and notices beside its index.js
 * ({@link OMO_RUNTIME}). own-creator goes last, as on this PC (17 §10, 2026-11-06): a host keeps a read-only mirror of
 * this PC's extensions, and its C2 servers run in the host's sandbox, so own's WebAssembly engine goes with it
 * ({@link CREATOR_QUICKJS}: one `.wasm` for x64 and arm64 alike). Its type declarations stay PC-only: a host never stages
 * a version from source (it checks the PC's hash and runs the tests and the smoke in its sandbox).
 */
export const REMOTE_PLUGINS = [
  "own-accounts",
  "own-remote",
  "own-team",
  "own-telemetry",
  "own-harness",
  "own-omo",
  "own-creator",
] as const
/**
 * Strings only the third-party claude-auth plugin carries (its billing header name and salt): no remote archive may
 * hold them (04 §8.11.14). The plugin id is no marker: own-accounts names it as a constant.
 */
export const THIRD_PARTY_MARKERS = ["x-anthropic-billing-header", "59cf53e54c78"] as const
/**
 * own-import's scan Worker (09 §2.3): a desktop bundle is one index.js, so the Worker entry is bundled first and its
 * text becomes this define of the index build, which `rpc.ts` `spawnWorker` runs from a Blob URL.
 */
export const IMPORT_WORKER = {
  package: "own-import",
  entry: "src/worker.ts",
  define: "OWN_IMPORT_WORKER_SOURCE",
} as const
/**
 * own-omo's second file (15 §2): the vendored oh-my-opencode, patched and bundled by the package's own script into
 * `omo-runtime.js` with its license, notices and MODIFICATIONS.md (`files`) and omo's skills folder (`skills`) next to
 * own-omo's `index.js`. A remote archive carries them all (15 §1): the license and notices go wherever omo goes.
 */
export const OMO_RUNTIME = {
  package: "own-omo",
  script: "script/bundle.ts",
  files: ["omo-runtime.js", "LICENSE.md", "THIRD-PARTY-NOTICES.md", "MODIFICATIONS.md"],
  skills: "skills",
} as const
/**
 * own-accounts' `imagegen` skill is adapted from OpenAI Codex's (Apache License 2.0, own-accounts 02 §9.6): its text is
 * inlined in `index.js`, so the license and the list of changes go next to it, wherever own-accounts goes.
 */
export const IMAGEGEN_NOTICE = {
  package: "own-accounts",
  files: { "imagegen-LICENSE.txt": "src/image/skill/LICENSE.txt", "imagegen-MODIFICATIONS.md": "src/image/skill/MODIFICATIONS.md" },
} as const
/**
 * own-creator's type declarations (17 §11.4): staging typechecks a generated MCP server with `bun check` against Bun's
 * and Node's types, which an installed app has nowhere else. They are copied, links resolved, into
 * `own-creator\types\node_modules\` beside its index.js (`Runtime.typesRoot`).
 */
export const CREATOR_TYPES = {
  package: "own-creator",
  /** Each resolved from the one before it, as their `/// <reference types>` chain resolves. */
  packages: ["@types/bun", "bun-types", "@types/node", "undici-types"],
  folder: "types",
} as const

/** The real folders of {@link CREATOR_TYPES}' packages, resolved from own-creator's dependencies. */
export function creatorTypes(repo = REPO) {
  const found: Array<{ name: string; dir: string }> = []
  for (const name of CREATOR_TYPES.packages) {
    const from = found.at(-1)?.dir ?? path.join(repo, "packages", CREATOR_TYPES.package)
    const dir = fs.realpathSync(path.dirname(Bun.resolveSync(`${name}/package.json`, from)))
    found.push({ name, dir })
  }
  return found
}

/**
 * own-creator's WebAssembly JavaScript engine (17 §11.2): QuickJS runs a generated MCP server inside a sandbox, so its
 * `dist` folders (the engine and a release variant with its `.wasm`) are copied beside own-creator's index.js, into
 * `own-creator\quickjs\core\` and `...\variant\` (`Runtime.quickjs`).
 *
 * Both import `@jitl/quickjs-ffi-types` by name, and the variant imports its own `/emscripten-module` by name. A release
 * has no node_modules, so those names resolved only through Bun's auto-install (a download from npm at run time): a C2
 * version's staging passed, while its server, which core starts in the project folder, could not load the engine on an
 * SSH host (RL4-P1). The release carries the types package in `quickjs\node_modules` and the variant names its module
 * by path ({@link VARIANT_SELF_IMPORT}), so every import resolves inside the folder.
 */
export const CREATOR_QUICKJS = {
  package: "own-creator",
  folder: "quickjs",
  modules: [
    { as: "core", name: "quickjs-emscripten-core" },
    { as: "variant", name: "@jitl/quickjs-wasmfile-release-sync" },
  ],
  /** Packages the modules import by name, copied into `quickjs\node_modules` (package.json, dist and license). */
  dependencies: ["@jitl/quickjs-ffi-types"],
} as const

/** The variant's import of its own Emscripten module by package name, and the relative path the release writes. */
export const VARIANT_SELF_IMPORT = {
  from: '"@jitl/quickjs-wasmfile-release-sync/emscripten-module"',
  to: '"./emscripten-module.mjs"',
} as const

/** Files of {@link CREATOR_QUICKJS} a host's sandbox needs, relative to own-creator's folder (remote archives check them). */
export const CREATOR_QUICKJS_FILES = [
  "quickjs/core/index.mjs",
  "quickjs/variant/index.mjs",
  "quickjs/variant/emscripten-module.wasm",
  "quickjs/node_modules/@jitl/quickjs-ffi-types/package.json",
  "quickjs/node_modules/@jitl/quickjs-ffi-types/dist/index.mjs",
] as const

/** The `dist` folder of each {@link CREATOR_QUICKJS} module, resolved from own-creator's dependencies. */
export function creatorQuickjs(repo = REPO) {
  const from = path.join(repo, "packages", CREATOR_QUICKJS.package)
  return CREATOR_QUICKJS.modules.map((module) => ({
    as: module.as,
    dir: fs.realpathSync(path.dirname(Bun.resolveSync(module.name, from))),
  }))
}

/**
 * Writes {@link CREATOR_QUICKJS} into `<pluginOut>\quickjs`: the modules' dist folders, the packages they import by name
 * under `quickjs\node_modules` (resolved where the core resolves them), and the variant's self-import made relative.
 */
export function writeCreatorQuickjs(pluginOut: string, repo = REPO) {
  const folder = path.join(pluginOut, CREATOR_QUICKJS.folder)
  const modules = creatorQuickjs(repo)
  for (const module of modules) fs.cpSync(module.dir, path.join(folder, module.as), { recursive: true, dereference: true })
  const core = modules.find((module) => module.as === "core")!.dir
  for (const name of CREATOR_QUICKJS.dependencies) {
    const root = fs.realpathSync(path.dirname(path.dirname(Bun.resolveSync(name, core))))
    const target = path.join(folder, "node_modules", ...name.split("/"))
    fs.mkdirSync(target, { recursive: true })
    for (const file of ["package.json", "LICENSE"].filter((item) => fs.existsSync(path.join(root, item))))
      fs.copyFileSync(path.join(root, file), path.join(target, file))
    fs.cpSync(path.join(root, "dist"), path.join(target, "dist"), { recursive: true, dereference: true })
  }
  const variant = path.join(folder, "variant", "index.mjs")
  const text = fs.readFileSync(variant, "utf8")
  if (!text.includes(VARIANT_SELF_IMPORT.from)) throw new Error(`${variant}: the variant's self-import changed`)
  fs.writeFileSync(variant, text.replaceAll(VARIANT_SELF_IMPORT.from, VARIANT_SELF_IMPORT.to))
}

/** The R1 Linux targets and their ELF machines. */
export const TARGETS = ELF_MACHINES

function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

function lf(text: string) {
  return text.replace(/\r\n?/g, "\n")
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(file)
    return entry.isFile() && !/\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : []
  })
}

/**
 * FORK §8.2 1b "build_id는 입력의 해시": version line, then `<repo path>\n<sha256>\n` for the LF-normalized bun.lock and
 * each own package's package.json, tsconfig.json and src/** (tests excluded), sorted by path; first 12 hex.
 * Meant to move to own/scripts/lib/release-ids.mjs (the single implementation FORK names) once that exists.
 */
export function buildId(version: string, repo = REPO) {
  const files = [
    path.join(repo, "bun.lock"),
    ...OWN_PACKAGES.flatMap((name) => {
      const dir = path.join(repo, "packages", name)
      if (!fs.existsSync(dir)) return []
      return [path.join(dir, "package.json"), path.join(dir, "tsconfig.json"), ...walk(path.join(dir, "src"))].filter((file) =>
        fs.existsSync(file),
      )
    }),
  ]
  const entries = files
    .map((file) => ({ rel: path.relative(repo, file).split(path.sep).join("/"), file }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const text =
    `${version}\n` + entries.map(({ rel, file }) => `${rel}\n${sha256(lf(fs.readFileSync(file, "utf8")))}\n`).join("")
  return sha256(text).slice(0, 12)
}

/**
 * Single-file ESM plugin bundles with the three release defines (FORK §8.2 step 3); own-import's also with its Worker's
 * source ({@link IMPORT_WORKER}).
 */
export async function plugins(input: {
  readonly out: string
  readonly version: string
  readonly buildId: string
  readonly packages: ReadonlyArray<string>
}) {
  const release = {
    OWN_BUILD_ID: JSON.stringify(input.buildId),
    OWN_EXPECTED_APP_VERSION: JSON.stringify(input.version),
    OWN_PLUGIN_VERSION: JSON.stringify(input.version),
  }
  const result: Record<string, string> = {}
  for (const name of input.packages) {
    const dir = path.join(REPO, "packages", name)
    const outdir = path.join(input.out, name)
    fs.rmSync(outdir, { recursive: true, force: true })
    const define: Record<string, string> =
      name === IMPORT_WORKER.package
        ? {
            ...release,
            [IMPORT_WORKER.define]: JSON.stringify(await workerSource(path.join(dir, IMPORT_WORKER.entry), release)),
          }
        : release
    const built = await Bun.build({
      entrypoints: [path.join(dir, "src", "index.ts")],
      outdir,
      naming: "index.js",
      ...RELEASE_BUILD,
      define,
    })
    if (!built.success) {
      for (const log of built.logs) console.error(log)
      throw new Error(`bundle failed: ${name}`)
    }
    if (name === CREATOR_TYPES.package) {
      for (const item of creatorTypes())
        fs.cpSync(item.dir, path.join(outdir, CREATOR_TYPES.folder, "node_modules", ...item.name.split("/")), {
          recursive: true,
          dereference: true,
        })
      writeCreatorQuickjs(outdir)
    }
    if (name === OMO_RUNTIME.package) {
      const runtime = Bun.spawnSync([process.execPath, path.join(dir, OMO_RUNTIME.script), "--out", outdir], {
        stdout: "pipe",
        stderr: "pipe",
      })
      if (runtime.exitCode !== 0) throw new Error(`omo runtime bundle failed: ${runtime.stderr.toString()}`)
    }
    if (name === IMAGEGEN_NOTICE.package)
      for (const [target, source] of Object.entries(IMAGEGEN_NOTICE.files))
        fs.copyFileSync(path.join(dir, source), path.join(outdir, target))
    const file = path.join(outdir, "index.js")
    const text = fs.readFileSync(file, "utf8")
    // The defines must be string literals in the output (a lost quote makes Bun fall back to "dev" silently). The
    // embedded Worker source is part of `text`, so a define it lost, or a Worker that would start itself, fails too.
    if (LOST_DEFINE.test(text) || !text.includes(JSON.stringify(input.buildId)))
      throw new Error(`define missing in ${file}`)
    result[name] = file
  }
  return result
}

const RELEASE_BUILD = {
  target: "bun",
  format: "esm",
  // Every Location evaluates the bundles again (the upstream loader drops local plugins from the module cache);
  // minified they are half the size and evaluate faster.
  minify: true,
  sourcemap: "none",
} as const

/** A define the bundler left as an identifier: a lost quote, or a source the build did not pass. */
const LOST_DEFINE = /typeof OWN_(BUILD_ID|EXPECTED_APP_VERSION|PLUGIN_VERSION|IMPORT_WORKER_SOURCE)\b/

/** A Worker entry as one minified ESM text with the release defines, built in memory (it is embedded, never written). */
async function workerSource(entry: string, define: Readonly<Record<string, string>>) {
  const built = await Bun.build({ entrypoints: [entry], ...RELEASE_BUILD, define })
  const output = built.outputs[0]
  if (!built.success || output === undefined || built.outputs.length !== 1) {
    for (const log of built.logs) console.error(log)
    throw new Error(`worker bundle failed: ${entry} (one file without chunks or assets expected)`)
  }
  return output.text()
}

/** An own-channel Linux binary: ELF64 for the target machine, carrying the release version string. */
export function checkElf(file: string, target: keyof typeof TARGETS, version: string) {
  const data = fs.readFileSync(file)
  if (data.length < 64 || data.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file}: not an ELF binary`)
  if (data[4] !== 2) throw new Error(`${file}: not ELF64`)
  const machine = data.readUInt16LE(18)
  if (machine !== TARGETS[target]) throw new Error(`${file}: ELF machine 0x${machine.toString(16)} is not ${target}`)
  if (!data.includes(Buffer.from(version))) throw new Error(`${file}: version ${version} not found in the binary`)
}

/** glibc program interpreters (PT_INTERP) of upstream's glibc Linux targets. */
export const INTERPRETERS = {
  "linux-x64-baseline": "/lib64/ld-linux-x86-64.so.2",
  "linux-arm64": "/lib/ld-linux-aarch64.so.1",
} as const satisfies Record<keyof typeof TARGETS, string>

function elfFiles(dir: string): string[] {
  return walk(dir).filter((file) => {
    const fd = fs.openSync(file, "r")
    const head = Buffer.alloc(4)
    const read = fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    return read === 4 && head.readUInt32BE(0) === 0x7f454c46
  })
}

/**
 * RG2 check of a compiled own-channel Linux CLI, beyond `checkElf`: little-endian executable with the glibc
 * interpreter of its target, built for channel `own` (upstream's `--user-agent=opencode/<channel>/<version>/cli`
 * exec argument), every embedded ELF object for the same machine and no embedded Windows PE image, and each native
 * file of `nativeDirs` (the packages build.ts embeds, script/native.ts) present byte for byte.
 */
export function inspectBinary(input: {
  readonly file: string
  readonly target: keyof typeof TARGETS
  readonly version: string
  readonly nativeDirs?: ReadonlyArray<string>
}) {
  checkElf(input.file, input.target, input.version)
  const data = fs.readFileSync(input.file)
  if (data[5] !== 1) throw new Error(`${input.file}: not little-endian`)
  const type = data.readUInt16LE(16)
  if (type !== 2 && type !== 3) throw new Error(`${input.file}: ELF type ${type} is not an executable`)
  const phoff = Number(data.readBigUInt64LE(32))
  const phentsize = data.readUInt16LE(54)
  const interp = Array.from({ length: data.readUInt16LE(56) }, (_, index) => phoff + index * phentsize)
    .filter((at) => data.readUInt32LE(at) === 3)
    .map((at) => {
      const offset = Number(data.readBigUInt64LE(at + 8))
      return data.subarray(offset, offset + Number(data.readBigUInt64LE(at + 32))).toString("latin1").replace(/\0+$/, "")
    })[0]
  if (interp !== INTERPRETERS[input.target]) throw new Error(`${input.file}: interpreter ${interp} is not ${INTERPRETERS[input.target]}`)
  const userAgent = `opencode/own/${input.version}/cli`
  if (!data.includes(Buffer.from(userAgent))) throw new Error(`${input.file}: ${userAgent} not found (not an own-channel build)`)
  // Embedded ELF objects: magic, ELFCLASS64, little-endian, EI_VERSION 1 and e_version 1 (skips stray magic bytes).
  const embedded: Array<{ offset: number; machine: number }> = []
  const magic = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  for (let at = data.indexOf(magic, 1); at >= 0; at = data.indexOf(magic, at + 4)) {
    if (at + 64 > data.length || data.readUInt32LE(at + 20) !== 1) continue
    embedded.push({ offset: at, machine: data.readUInt16LE(at + 18) })
  }
  const foreign = embedded.filter((item) => item.machine !== TARGETS[input.target])
  if (foreign.length > 0)
    throw new Error(`${input.file}: embedded ELF for machine ${foreign.map((item) => `0x${item.machine.toString(16)}@${item.offset}`).join(", ")}`)
  for (let at = data.indexOf("MZ"); at >= 0; at = data.indexOf("MZ", at + 2)) {
    if (at + 64 > data.length) break
    const pe = at + data.readUInt32LE(at + 60)
    if (pe > at && pe + 4 <= data.length && pe - at < 4096 && data.readUInt32BE(pe) === 0x50450000)
      throw new Error(`${input.file}: embedded Windows PE image at ${at}`)
  }
  const natives = Object.fromEntries(
    (input.nativeDirs ?? []).flatMap((dir) =>
      elfFiles(dir).map((file) => {
        const offset = data.indexOf(fs.readFileSync(file))
        const name = path.relative(path.dirname(path.dirname(dir)), file).split(path.sep).join("/")
        if (offset < 0) throw new Error(`${input.file}: native file ${name} is not embedded`)
        return [name, offset] as const
      }),
    ),
  )
  return {
    file: input.file,
    target: input.target,
    bytes: data.length,
    sha256: sha256(data),
    elf: { machine: `0x${TARGETS[input.target].toString(16)}`, type: type === 3 ? "DYN" : "EXEC", interpreter: interp },
    userAgent,
    embeddedElf: embedded.length,
    natives,
  }
}

const TAR = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar"

export function packageTargets(input: {
  readonly out: string
  readonly version: string
  readonly buildId: string
  readonly plugins: string
  readonly binaries: Readonly<Record<string, string>>
  readonly elfCheck: boolean
  /** script/native.ts `lfs` output dir: ships `<tools>/git-lfs/<GIT_LFS.version>/<target>/` per target. */
  readonly tools?: string
}) {
  RemoteCli.requireVersion(input.version)
  const remote = path.join(input.out, "remote")
  fs.mkdirSync(remote, { recursive: true })
  const targets = Object.keys(input.binaries).map((target) => {
    if (!(target in TARGETS)) throw new Error(`unsupported target ${target} (R1: ${Object.keys(TARGETS).join(", ")})`)
    return target as keyof typeof TARGETS
  })
  const tools = input.tools === undefined ? undefined : { "git-lfs": packageLfs(input.tools, remote, targets) }
  const manifest = {
    schemaVersion: 1 as const,
    version: input.version,
    build_id: input.buildId,
    proto: Broker.PROTO,
    channel: "own" as const,
    targets: {} as Record<string, { file: string; sha256: string; bytes: number; files: Record<string, string> }>,
    ...(tools ? { tools } : {}),
  }
  const artifacts: Record<string, { sha256: string; bytes: number; files: Record<string, string> }> = {}
  for (const target of targets) {
    const binary = input.binaries[target]!
    if (input.elfCheck) checkElf(binary, target, input.version)
    const stage = path.join(input.out, "remote-stage", target)
    fs.rmSync(stage, { recursive: true, force: true })
    const layout: Record<string, Buffer> = {
      opencode: fs.readFileSync(binary),
      "libexec/start.sh": Buffer.from(Scripts.startScript),
    }
    for (const name of REMOTE_PLUGINS)
      for (const [rel, file] of pluginFiles(input.plugins, name)) layout[`plugins/${name}/${rel}`] = fs.readFileSync(file)
    const files = Object.fromEntries(Object.entries(layout).map(([rel, data]) => [rel, `sha256:${sha256(data)}`]))
    layout["manifest.json"] = Buffer.from(
      JSON.stringify({ version: input.version, build_id: input.buildId, proto: Broker.PROTO, target, files }, null, 2) + "\n",
    )
    for (const [rel, data] of Object.entries(layout)) {
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true })
      fs.writeFileSync(path.join(stage, rel), data)
    }
    const archive = path.join(remote, `${target}.tar.gz`)
    fs.rmSync(archive, { force: true })
    execFileSync(TAR, ["-czf", archive, "-C", stage, ...Object.keys(layout).sort()], { windowsHide: true })
    const data = fs.readFileSync(archive)
    // The install script checks every file except manifest.json itself (it is informational on the remote).
    manifest.targets[target] = { file: `${target}.tar.gz`, sha256: sha256(data), bytes: data.length, files }
    artifacts[target] = { sha256: sha256(data), bytes: data.length, files }
  }
  fs.writeFileSync(path.join(remote, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  const release = tools ? { ...artifacts, tools } : artifacts
  fs.writeFileSync(path.join(remote, "remote_artifacts.json"), JSON.stringify(release, null, 2) + "\n")
  return { manifest, artifacts: release }
}

/**
 * The files of plugin `name` in a remote archive, as `[path in its folder, file]`: its `index.js`, and own-omo's runtime,
 * license, notices and skills ({@link OMO_RUNTIME}). A missing one fails the packaging.
 */
function pluginFiles(dir: string, name: string) {
  const folder = path.join(dir, name)
  const omo = name === OMO_RUNTIME.package
  const required = [
    "index.js",
    ...(omo ? OMO_RUNTIME.files : []),
    ...(name === IMAGEGEN_NOTICE.package ? Object.keys(IMAGEGEN_NOTICE.files) : []),
  ]
  for (const file of required)
    if (!fs.existsSync(path.join(folder, file))) throw new Error(`missing plugin bundle ${path.join(folder, file)}`)
  const skills = omo ? walk(path.join(folder, OMO_RUNTIME.skills)) : []
  if (omo && skills.length === 0) throw new Error(`missing omo skills in ${path.join(folder, OMO_RUNTIME.skills)}`)
  // own-creator's WebAssembly engine (17 §10): the host's C2 servers run in its sandbox. Only the ES modules and the
  // `.wasm` the sandbox loads go (no source maps, declarations or CommonJS copies): every file is a line of the install
  // script's checksum list, which travels in the ssh command line. The package.json of `quickjs/node_modules` packages
  // goes too: Bun resolves `@jitl/quickjs-ffi-types` through its `exports` (RL4-P1).
  const quickjs =
    name === CREATOR_QUICKJS.package
      ? walk(path.join(folder, CREATOR_QUICKJS.folder)).filter(
          (file) => /\.(?:mjs|wasm)$/.test(file) || path.basename(file) === "package.json",
        )
      : []
  if (name === CREATOR_QUICKJS.package && !CREATOR_QUICKJS_FILES.every((file) => fs.existsSync(path.join(folder, file))))
    throw new Error(`missing own-creator's QuickJS engine in ${path.join(folder, CREATOR_QUICKJS.folder)}`)
  return [...required.map((file) => path.join(folder, file)), ...skills, ...quickjs].map(
    (file) => [path.relative(folder, file).split(path.sep).join("/"), file] as const,
  )
}

/**
 * Copies each target's git-lfs and its license from `<tools>/git-lfs/<ver>/<target>/` to
 * `<remote>/tools/git-lfs/<ver>/<target>/`, a file of its own next to the target archives (a host gets it only when a
 * repository needs it, 06 §4.13). `files` are the `sha256sum -c` entries of that folder.
 */
function packageLfs(tools: string, remote: string, targets: ReadonlyArray<keyof typeof TARGETS>) {
  const root = path.join(remote, "tools", "git-lfs")
  fs.rmSync(root, { recursive: true, force: true })
  const entries = targets.map((target) => {
    const source = path.join(tools, "git-lfs", GIT_LFS.version, target)
    const names = (fs.existsSync(source) ? fs.readdirSync(source) : []).filter(
      (name) => name === "git-lfs" || name.startsWith("LICENSE"),
    )
    if (!names.includes("git-lfs") || names.length < 2)
      throw new Error(
        `no git-lfs ${GIT_LFS.version} with its license for ${target} in ${source} (script/native.ts lfs)`,
      )
    const binary = fs.readFileSync(path.join(source, "git-lfs"))
    checkLfsBinary(binary, target, path.join(source, "git-lfs"))
    const dest = path.join(root, GIT_LFS.version, target)
    fs.mkdirSync(dest, { recursive: true })
    const files = Object.fromEntries(
      names.sort().map((name) => {
        const data = fs.readFileSync(path.join(source, name))
        fs.writeFileSync(path.join(dest, name), data)
        return [name, `sha256:${sha256(data)}`] as const
      }),
    )
    const file = `tools/git-lfs/${GIT_LFS.version}/${target}/git-lfs`
    return [target, { file, sha256: sha256(binary), bytes: binary.length, files }] as const
  })
  return { version: GIT_LFS.version, targets: Object.fromEntries(entries) }
}

type LfsEntry = typeof Bundle.Target.Type

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Bundle.Manifest))

/**
 * A release's `remote\` as release-smoke checks it (FORK §8.2 step 7): per target of manifest.json, the archive
 * matches its hash and holds exactly the REMOTE_PLUGINS (so own-team, own-harness and own-omo, never own-computer-use),
 * own-omo with its runtime, license and notices ({@link OMO_RUNTIME}), and none of the {@link THIRD_PARTY_MARKERS} in
 * any file, and the manifest's git-lfs for that target lies beside the archives, not inside, with its hash, size and
 * license.
 */
export function inspectRemote(dir: string) {
  const manifestFile = path.join(dir, "manifest.json")
  if (!fs.existsSync(manifestFile)) {
    const missing = [`no ${manifestFile} (build-desktop.ps1 -Remote)`]
    return { plugins: {}, lfs: undefined, problems: { plugins: missing, lfs: missing, markers: missing } }
  }
  // Written by packageTargets; decoded with the schema own-remote reads it with (`Bundle.Manifest`).
  const manifest = Option.getOrUndefined(decodeManifest(fs.readFileSync(manifestFile, "utf8")))
  if (manifest === undefined) {
    const invalid = [`${manifestFile} does not match the remote manifest schema`]
    return { plugins: {}, lfs: undefined, problems: { plugins: invalid, lfs: invalid, markers: invalid } }
  }
  const lfs = manifest.tools?.["git-lfs"]
  const targets = Object.entries(manifest.targets).map(([target, entry]) => {
    const archive = path.join(dir, entry.file)
    const present = fs.existsSync(archive)
    const listed = present
      ? execFileSync(TAR, ["-tzf", archive], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean)
      : []
    const plugins = listed.flatMap((name) => /^plugins\/([^/]+)\/index\.js$/.exec(name)?.[1] ?? []).sort()
    // Every file's bytes, the CLI included (`tar -O` writes them back to back).
    const contents = present
      ? execFileSync(TAR, ["-xzOf", archive], { maxBuffer: 2 ** 31 - 1, windowsHide: true })
      : Buffer.alloc(0)
    const markers = THIRD_PARTY_MARKERS.filter((marker) => contents.includes(marker))
    const markerProblems = markers.length > 0 ? [`${target}: third-party claude-auth code in ${entry.file}`] : []
    const pluginProblems = [
      ...(present ? [] : [`${target}: ${entry.file} missing`]),
      ...(present && sha256(fs.readFileSync(archive)) !== entry.sha256 ? [`${target}: ${entry.file} hash`] : []),
      ...(plugins.join(",") === [...REMOTE_PLUGINS].sort().join(",")
        ? []
        : [`${target}: plugins [${plugins.join(", ")}]`]),
      ...(plugins.includes(OMO_RUNTIME.package)
        ? OMO_RUNTIME.files
            .filter((file) => !listed.includes(`plugins/${OMO_RUNTIME.package}/${file}`))
            .map((file) => `${target}: ${OMO_RUNTIME.package} without ${file}`)
        : []),
      ...(plugins.includes(CREATOR_QUICKJS.package)
        ? CREATOR_QUICKJS_FILES.filter((file) => !listed.includes(`plugins/${CREATOR_QUICKJS.package}/${file}`)).map(
            (file) => `${target}: ${CREATOR_QUICKJS.package} without ${file}`,
          )
        : []),
    ]
    const tool = lfs?.targets[target]
    const lfsProblems = tool
      ? [
          ...(listed.some((name) => path.posix.basename(name) === "git-lfs")
            ? [`${target}: git-lfs inside ${entry.file}`]
            : []),
          ...lfsFileProblems(dir, target, tool),
        ]
      : [`${target}: no tools git-lfs entry`]
    return { target, plugins, file: tool?.file, pluginProblems, lfsProblems, markerProblems }
  })
  return {
    plugins: Object.fromEntries(targets.map((item) => [item.target, item.plugins])),
    lfs: lfs && { version: lfs.version, files: Object.fromEntries(targets.map((item) => [item.target, item.file])) },
    problems: {
      plugins: targets.flatMap((item) => item.pluginProblems),
      lfs: targets.flatMap((item) => item.lfsProblems),
      markers: targets.flatMap((item) => item.markerProblems),
    },
  }
}

/** The binary (`file`, hash, size) and every `files` entry of its folder, at least one of them a license. */
function lfsFileProblems(dir: string, target: string, tool: LfsEntry) {
  const binary = path.join(dir, ...tool.file.split("/"))
  const folder = path.dirname(binary)
  const data = fs.existsSync(binary) ? fs.readFileSync(binary) : undefined
  return [
    ...(data === undefined ? [`${target}: ${tool.file} missing`] : []),
    ...(data !== undefined && (sha256(data) !== tool.sha256 || data.length !== tool.bytes)
      ? [`${target}: ${tool.file} hash or size`]
      : []),
    ...(Object.keys(tool.files).some((name) => name.startsWith("LICENSE")) ? [] : [`${target}: no git-lfs license`]),
    ...Object.entries(tool.files).flatMap(([name, hash]) => {
      const file = path.join(folder, name)
      return fs.existsSync(file) && `sha256:${sha256(fs.readFileSync(file))}` === hash
        ? []
        : [`${target}: ${name} missing or changed`]
    }),
  ]
}

function arg(args: string[], name: string) {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const version = arg(args, "version")
  if (!version) throw new Error("--version required")
  RemoteCli.requireVersion(version)
  if (command === "build-id") {
    process.stdout.write(buildId(version) + "\n")
  } else if (command === "plugins") {
    const out = arg(args, "out")
    const id = arg(args, "build-id")
    if (!out || !id) throw new Error("--out and --build-id required")
    const list = (arg(args, "packages") ?? DESKTOP_PLUGINS.join(",")).split(",").filter(Boolean)
    const result = await plugins({ out, version, buildId: id, packages: list })
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  } else if (command === "package") {
    const out = arg(args, "out")
    const id = arg(args, "build-id")
    const pluginDir = arg(args, "plugins")
    if (!out || !id || !pluginDir) throw new Error("--out, --build-id and --plugins required")
    const binaries: Record<string, string> = {}
    args.forEach((value, index) => {
      if (value !== "--binary") return
      const [target, file] = (args[index + 1] ?? "").split(/=(.*)/s)
      if (!target || !file) throw new Error("--binary <target>=<path>")
      binaries[target] = file
    })
    if (Object.keys(binaries).length === 0) throw new Error("at least one --binary")
    const toolsDir = arg(args, "tools")
    const result = packageTargets({
      out,
      version,
      buildId: id,
      plugins: pluginDir,
      binaries,
      elfCheck: !args.includes("--no-elf-check"),
      tools: toolsDir ? path.resolve(toolsDir) : undefined,
    })
    process.stdout.write(JSON.stringify(result.artifacts, null, 2) + "\n")
  } else if (command === "verify-binary") {
    const target = arg(args, "target")
    const file = arg(args, "binary")
    if (!target || !file) throw new Error("--target and --binary required")
    if (!(target in TARGETS)) throw new Error(`unsupported target ${target}`)
    const nativeDir = arg(args, "native-dir")
    const nativeDirs = nativeDir
      ? NATIVE_PACKAGES[target as keyof typeof NATIVE_PACKAGES].map((name) => path.join(nativeDir, "node_modules", ...name.split("/")))
      : []
    const result = inspectBinary({ file, target: target as keyof typeof TARGETS, version, nativeDirs })
    process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  } else {
    throw new Error(`unknown command ${command}`)
  }
}
