// The release plugin lists (06 §2.6: own-team in the third slot, own-computer-use after own-telemetry; 09 §5.1:
// own-import after it; 10 H0: own-harness then own-omo last; 06 §4.13, 04 §8.11.14, 10 §6.1, 15 §1: remote installs
// carry own-team, own-telemetry, own-harness and own-omo (last, with its runtime, license, notices and skills), never
// own-computer-use, own-import or third-party claude-auth code), the build id
// inputs (own-team and own-import sources count), the own-team bundle with the three release defines, the own-import
// bundle as one loadable index.js with every package it runs and its Worker's source embedded, inspectBinary (the RG2
// check of a compiled Linux CLI) on synthetic ELF files: interpreter, channel, embedded objects of another machine,
// embedded Windows images, and native files that must be embedded byte for byte; and `package --tools` with git-lfs
// per target beside the archives, read back by inspectRemote (release-smoke).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { isBuiltin } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Bundle } from "../src/remote/bundle.js"
import {
  buildId,
  DESKTOP_PLUGINS,
  IMPORT_WORKER,
  inspectBinary,
  inspectRemote,
  IMAGEGEN_NOTICE,
  OMO_RUNTIME,
  CREATOR_QUICKJS,
  CREATOR_QUICKJS_FILES,
  CREATOR_TYPES,
  OWN_PACKAGES,
  packageTargets,
  plugins,
  REMOTE_PLUGINS,
  THIRD_PARTY_MARKERS,
  TARGETS,
} from "./bundle.js"
import { GIT_LFS } from "./native.js"

const VERSION = "2.0.18-own.7"
const TAR = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar"
const SCRIPTS = path.resolve(import.meta.dir, "../../../own/scripts")
let root: string

/** ELF64 little-endian header with one PT_INTERP program header, then `tail`. */
function elf(machine: number, interpreter: string, tail: Buffer = Buffer.alloc(0)) {
  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0)
  header[4] = 2
  header[5] = 1
  header[6] = 1
  header.writeUInt16LE(3, 16)
  header.writeUInt16LE(machine, 18)
  header.writeUInt32LE(1, 20)
  header.writeBigUInt64LE(64n, 32)
  header.writeUInt16LE(56, 54)
  header.writeUInt16LE(1, 56)
  const text = Buffer.from(`${interpreter}\0`)
  const program = Buffer.alloc(56)
  program.writeUInt32LE(3, 0)
  program.writeBigUInt64LE(BigInt(64 + 56), 8)
  program.writeBigUInt64LE(BigInt(text.length), 32)
  return Buffer.concat([header, program, text, tail])
}

function stamp(version = VERSION, channel = "own") {
  return Buffer.from(`\0v${version}\0--user-agent=opencode/${channel}/${version}/cli\0`)
}

function write(name: string, data: Buffer) {
  const file = path.join(root, name)
  fs.writeFileSync(file, data)
  return file
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "own-inspect-test-"))
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe("plugin lists and build id", () => {
  test("desktop plugins in activation order: own-team third, own-harness, own-omo, then own-creator last; remote installs leave the PC-only ones out", () => {
    expect([...DESKTOP_PLUGINS]).toEqual([
      "own-accounts",
      "own-remote",
      "own-team",
      "own-telemetry",
      "own-computer-use",
      "own-import",
      "own-harness",
      "own-omo",
      "own-creator",
    ])
    expect([...OWN_PACKAGES]).toEqual([
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
    ])
    // The remote managed config's order; own-telemetry fourth for the relayed Claude slot (04 §8.11.14), own-harness,
    // own-omo and own-creator last as on this PC (10 §6.1, 15 §1, 17 §10); own-computer-use never runs on a remote host,
    // own-import is PC-only.
    expect([...REMOTE_PLUGINS]).toEqual([
      "own-accounts",
      "own-remote",
      "own-team",
      "own-telemetry",
      "own-harness",
      "own-omo",
      "own-creator",
    ])
    expect(DESKTOP_PLUGINS.filter((name) => (REMOTE_PLUGINS as ReadonlyArray<string>).includes(name))).toEqual([
      ...REMOTE_PLUGINS,
    ])
    expect(OWN_PACKAGES.indexOf("own-team")).toBe(OWN_PACKAGES.indexOf("own-remote") + 1)
    expect(DESKTOP_PLUGINS.filter((name) => !(OWN_PACKAGES as ReadonlyArray<string>).includes(name))).toEqual([])
    // build-desktop.ps1 passes the same list (it is the release's `$pluginNames`).
    const script = fs.readFileSync(path.join(SCRIPTS, "build-desktop.ps1"), "utf8")
    expect(/\$pluginNames = @\(([^)]*)\)/.exec(script)?.[1]).toBe(DESKTOP_PLUGINS.map((name) => `'${name}'`).join(", "))
    // build-remote.ps1 bundles REMOTE_PLUGINS and packages the git-lfs it fetched (step 2b) with --tools.
    const remote = fs.readFileSync(path.join(SCRIPTS, "build-remote.ps1"), "utf8")
    expect(/plugins --out \$pluginDir [^\n]*--packages '([^']*)'/.exec(remote)?.[1]).toBe(REMOTE_PLUGINS.join(","))
    expect(remote).toContain("'--tools', $NativeDir")
    expect(remote).toContain("@($native, 'lfs', '--dir', $NativeDir")
  })

  test("own-team and own-import sources are build id inputs; their tests are not", () => {
    const repo = path.join(root, "repo")
    const team = path.join(repo, "packages", "own-team")
    const importer = path.join(repo, "packages", "own-import")
    fs.mkdirSync(path.join(team, "src"), { recursive: true })
    fs.mkdirSync(path.join(team, "test"), { recursive: true })
    fs.mkdirSync(path.join(importer, "src"), { recursive: true })
    fs.mkdirSync(path.join(importer, "test", "fixtures"), { recursive: true })
    fs.writeFileSync(path.join(repo, "bun.lock"), "{}\n")
    fs.writeFileSync(path.join(team, "package.json"), "{}\n")
    fs.writeFileSync(path.join(team, "src", "index.ts"), "export {}\n")
    fs.writeFileSync(path.join(importer, "package.json"), "{}\n")
    fs.writeFileSync(path.join(importer, "src", "worker.ts"), "export {}\n")
    const first = buildId(VERSION, repo)
    expect(first).toMatch(/^[0-9a-f]{12}$/)
    // Line endings do not count (LF-normalized), test files and fixtures neither.
    fs.writeFileSync(path.join(team, "src", "index.ts"), "export {}\r\n")
    fs.writeFileSync(path.join(team, "src", "index.test.ts"), "test\n")
    fs.writeFileSync(path.join(team, "test", "a.test.ts"), "test\n")
    fs.writeFileSync(path.join(importer, "test", "fixtures", "make.ts"), "export {}\n")
    expect(buildId(VERSION, repo)).toBe(first)
    fs.writeFileSync(path.join(team, "src", "controller.ts"), "export const x = 1\n")
    const second = buildId(VERSION, repo)
    expect(second).not.toBe(first)
    // The Worker's source is embedded in the own-import bundle, so it changes the id like any other source.
    fs.writeFileSync(path.join(importer, "src", "worker.ts"), "export const y = 1\n")
    expect(buildId(VERSION, repo)).not.toBe(second)
  })

  test("the own-team bundle carries the three release defines as string literals", async () => {
    const id = "0123456789ab"
    const result = await plugins({
      out: path.join(root, "plugins"),
      version: VERSION,
      buildId: id,
      packages: ["own-team"],
    })
    const text = fs.readFileSync(result["own-team"]!, "utf8")
    expect(text).toContain(JSON.stringify(id))
    expect(text).toContain(JSON.stringify(VERSION))
    expect(text).not.toMatch(/typeof OWN_(BUILD_ID|EXPECTED_APP_VERSION|PLUGIN_VERSION)\b/)
    expect(text).toContain('"own.team"')
  }, 120_000)

  test("the own-omo bundle carries the release defines, with omo's runtime, license, notices and skills beside it", async () => {
    const id = "0123456789ab"
    const result = await plugins({ out: path.join(root, "plugins-omo"), version: VERSION, buildId: id, packages: ["own-omo"] })
    const text = fs.readFileSync(result["own-omo"]!, "utf8")
    expect(text).toContain(JSON.stringify(id))
    expect(text).toContain(JSON.stringify(VERSION))
    expect(text).not.toMatch(/typeof OWN_(BUILD_ID|EXPECTED_APP_VERSION|PLUGIN_VERSION)\b/)
    const folder = path.dirname(result["own-omo"]!)
    for (const file of OMO_RUNTIME.files) expect(fs.existsSync(path.join(folder, file))).toBe(true)
    expect(fs.readdirSync(path.join(folder, OMO_RUNTIME.skills)).length).toBeGreaterThan(0)
  }, 300_000)

  test("the own-creator bundle carries Bun's and Node's types beside it for staging's typecheck, and its runtime files as text", async () => {
    const id = "0123456789ab"
    const result = await plugins({ out: path.join(root, "plugins-creator"), version: VERSION, buildId: id, packages: ["own-creator"] })
    const file = result["own-creator"]!
    const types = path.join(path.dirname(file), CREATOR_TYPES.folder, "node_modules")
    for (const name of CREATOR_TYPES.packages) expect(fs.existsSync(path.join(types, ...name.split("/"), "package.json"))).toBe(true)
    expect(fs.existsSync(path.join(types, "@types", "bun", "index.d.ts"))).toBe(true)
    // own's WebAssembly JavaScript engine for the C2 sandbox: the engine and the variant's .wasm beside own-creator.
    const quickjs = path.join(path.dirname(file), "quickjs")
    expect(fs.existsSync(path.join(quickjs, "core", "index.mjs"))).toBe(true)
    expect(fs.existsSync(path.join(quickjs, "variant", "index.mjs"))).toBe(true)
    expect(fs.readdirSync(path.join(quickjs, "variant")).some((entry) => entry.endsWith(".wasm"))).toBe(true)
    for (const item of CREATOR_QUICKJS_FILES) expect(fs.existsSync(path.join(path.dirname(file), ...item.split("/")))).toBe(true)
    // RL4-P1: the engine loads from that folder alone, with Bun's auto-install off, in a folder with no node_modules
    // above it (a release, a host): its imports by package name resolve inside quickjs\.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "own-quickjs-"))
    try {
      fs.cpSync(path.dirname(file), copy, { recursive: true })
      const probe = path.join(copy, "probe.mjs")
      fs.writeFileSync(
        probe,
        [
          'const core = await import("./quickjs/core/index.mjs")',
          'const variant = (await import("./quickjs/variant/index.mjs")).default',
          "const vm = (await core.newQuickJSWASMModuleFromVariant(variant)).newContext()",
          'const result = vm.unwrapResult(vm.evalCode("1 + 2"))',
          'console.log("quickjs", vm.getNumber(result))',
          "result.dispose()",
          "vm.dispose()",
        ].join("\n"),
      )
      const ran = Bun.spawnSync([process.execPath, "--no-install", probe], { cwd: copy, stdout: "pipe", stderr: "pipe" })
      expect(ran.stdout.toString() + ran.stderr.toString()).toContain("quickjs 3")
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
    const text = fs.readFileSync(file, "utf8")
    expect(text).not.toMatch(/typeof OWN_(BUILD_ID|EXPECTED_APP_VERSION|PLUGIN_VERSION)\b/)
    // own's helpers and child-process scripts are inlined as text (runtime.ts), never left as imports.
    expect(text).toContain("export function serve(definition: ServerDefinition)")
    expect(text).toContain("export function definePlugin(definition: PluginDefinition)")
  }, 300_000)

  test("the own-import bundle is one index.js that carries its Worker's source as a define", async () => {
    const id = "0123456789ab"
    const result = await plugins({
      out: path.join(root, "plugins-import"),
      version: VERSION,
      buildId: id,
      packages: ["own-import"],
    })
    const file = result["own-import"]!
    // One file, so the launcher's bundle path, the manifest's artifact list and release-smoke's layout stay as they are.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["index.js"])
    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain(JSON.stringify(id))
    expect(text).toContain(JSON.stringify(VERSION))
    expect(text).toContain('"own.import"')
    // Every define is a literal, the Worker's own included (it is part of the text), and none is left for the Worker.
    expect(text).not.toMatch(/typeof OWN_[A-Z_]+\b/)
    expect(text).not.toContain(IMPORT_WORKER.define)
    // The source-run Worker file next to index.ts is dead code once the source is embedded.
    expect(text).not.toContain("worker.ts")
    // Bun marks each bundle it writes: the plugin's and the embedded Worker's, each exactly once.
    expect(text.split("// @bun").length - 1).toBe(2)
    // An installed plugin folder has no node_modules: every package the importer runs (gray-matter for a skill's
    // format, 09 §9.3) is in the file, and only Bun's built-in modules stay imports. A statement starts a line or
    // follows `;` or `}`, so generated code text inside a string literal (effect's `toCode`) is not one.
    const imports = [
      ...text.matchAll(
        /(?:^|[;}])import\s*(?:[\w$*{}\s,]+from\s*)?"([^"]+)"|\b(?:import|require)\(\s*"([^"]+)"\s*\)/gm,
      ),
    ].map((match) => match[1] ?? match[2] ?? "")
    expect(imports).toContain("bun:sqlite")
    expect(imports.filter((name) => !name.startsWith("bun:") && !isBuiltin(name))).toEqual([])
    // And it evaluates: the default export is the definition core's loader reads.
    expect((await import(pathToFileURL(file).href)).default.id).toBe("own.import")
  }, 120_000)
})

describe("inspectBinary", () => {
  test("an own-channel glibc x64 executable with its native file embedded", () => {
    const native = path.join(root, "node_modules", "@x", "lib-linux-x64")
    fs.mkdirSync(native, { recursive: true })
    const lib = elf(0x3e, "", Buffer.from("x64 library body"))
    fs.writeFileSync(path.join(native, "lib.so"), lib)
    fs.writeFileSync(path.join(native, "package.json"), "{}")
    const file = write("ok", Buffer.concat([elf(0x3e, "/lib64/ld-linux-x86-64.so.2"), stamp(), lib]))
    const report = inspectBinary({ file, target: "linux-x64-baseline", version: VERSION, nativeDirs: [native] })
    expect(report).toMatchObject({
      target: "linux-x64-baseline",
      elf: { machine: "0x3e", type: "DYN", interpreter: "/lib64/ld-linux-x86-64.so.2" },
      userAgent: `opencode/own/${VERSION}/cli`,
      embeddedElf: 1,
    })
    expect(Object.keys(report.natives)).toEqual(["@x/lib-linux-x64/lib.so"])

    const missing = write("missing", Buffer.concat([elf(0x3e, "/lib64/ld-linux-x86-64.so.2"), stamp()]))
    expect(() => inspectBinary({ file: missing, target: "linux-x64-baseline", version: VERSION, nativeDirs: [native] })).toThrow(
      "native file @x/lib-linux-x64/lib.so is not embedded",
    )
  })

  test("wrong interpreter, channel or machine", () => {
    const musl = write("musl", Buffer.concat([elf(0x3e, "/lib/ld-musl-x86_64.so.1"), stamp()]))
    expect(() => inspectBinary({ file: musl, target: "linux-x64-baseline", version: VERSION })).toThrow("interpreter")
    const latest = write("latest", Buffer.concat([elf(0xb7, "/lib/ld-linux-aarch64.so.1"), stamp(VERSION, "latest")]))
    expect(() => inspectBinary({ file: latest, target: "linux-arm64", version: VERSION })).toThrow("not an own-channel build")
    const arm = write("arm", Buffer.concat([elf(0xb7, "/lib/ld-linux-aarch64.so.1"), stamp()]))
    expect(() => inspectBinary({ file: arm, target: "linux-x64-baseline", version: VERSION })).toThrow("ELF machine")
    expect(inspectBinary({ file: arm, target: "linux-arm64", version: VERSION }).elf.interpreter).toBe("/lib/ld-linux-aarch64.so.1")
  })

  test("an embedded object for another machine or a Windows image fails the check", () => {
    const mixed = write("mixed", Buffer.concat([elf(0x3e, "/lib64/ld-linux-x86-64.so.2"), stamp(), elf(0xb7, "")]))
    expect(() => inspectBinary({ file: mixed, target: "linux-x64-baseline", version: VERSION })).toThrow("embedded ELF for machine 0xb7")
    const dos = Buffer.alloc(128)
    dos.write("MZ", 0, "latin1")
    dos.writeUInt32LE(64, 60)
    dos.write("PE\0\0", 64, "latin1")
    const pe = write("pe", Buffer.concat([elf(0x3e, "/lib64/ld-linux-x86-64.so.2"), stamp(), dos, Buffer.alloc(64)]))
    expect(() => inspectBinary({ file: pe, target: "linux-x64-baseline", version: VERSION })).toThrow("embedded Windows PE image")
    // "MZ" without a PE header is ordinary data.
    const text = write("text", Buffer.concat([elf(0x3e, "/lib64/ld-linux-x86-64.so.2"), stamp(), Buffer.from("MZ".padEnd(200, "z"))]))
    expect(() => inspectBinary({ file: text, target: "linux-x64-baseline", version: VERSION })).not.toThrow()
  })
})

function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

/** A static git-lfs stand-in: ELF64 executable whose one program header is PT_LOAD (no interpreter). */
function staticElf(machine: number) {
  const data = elf(machine, "", Buffer.from("fake git-lfs"))
  data.writeUInt32LE(1, 64)
  return data
}

/** REMOTE_PLUGINS stand-in bundles, a stand-in CLI and a git-lfs tools dir (script/native.ts `lfs` layout). */
function inputs(name: string, lfs: Partial<Record<keyof typeof TARGETS, Buffer>> = {}) {
  const dir = path.join(root, name)
  const pluginDir = path.join(dir, "plugins")
  for (const plugin of REMOTE_PLUGINS) {
    fs.mkdirSync(path.join(pluginDir, plugin), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, plugin, "index.js"), `export const name = ${JSON.stringify(plugin)}\n`)
  }
  // own-accounts' imagegen license and changes beside its index.js (own-accounts 02 §9.6).
  for (const file of Object.keys(IMAGEGEN_NOTICE.files))
    fs.writeFileSync(path.join(pluginDir, IMAGEGEN_NOTICE.package, file), `${file}
`)
  // own-omo's runtime, license, notices and one skill beside its index.js (15 §1).
  const omo = path.join(pluginDir, OMO_RUNTIME.package)
  for (const file of OMO_RUNTIME.files) fs.writeFileSync(path.join(omo, file), `${file}\n`)
  fs.mkdirSync(path.join(omo, OMO_RUNTIME.skills, "debugging"), { recursive: true })
  fs.writeFileSync(path.join(omo, OMO_RUNTIME.skills, "debugging", "SKILL.md"), "# debugging\n")
  // own-creator's WebAssembly engine beside its index.js (17 §10: a host's C2 servers run in its sandbox).
  for (const file of CREATOR_QUICKJS_FILES) {
    const target = path.join(pluginDir, CREATOR_QUICKJS.package, ...file.split("/"))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${file}\n`)
  }
  const binary = path.join(dir, "opencode-stand-in")
  fs.writeFileSync(binary, "#!/bin/sh\necho stand-in\n")
  const tools = path.join(dir, "tools")
  for (const [target, data] of Object.entries(lfs)) {
    const folder = path.join(tools, "git-lfs", GIT_LFS.version, target)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, "git-lfs"), data)
    fs.writeFileSync(path.join(folder, "LICENSE.md"), "MIT License\n")
  }
  return { pluginDir, binary, tools, out: path.join(dir, "out") }
}

const LAYOUT = [
  "libexec/start.sh",
  "manifest.json",
  "opencode",
  "plugins/own-accounts/imagegen-LICENSE.txt",
  "plugins/own-accounts/imagegen-MODIFICATIONS.md",
  "plugins/own-accounts/index.js",
  "plugins/own-creator/index.js",
  "plugins/own-creator/quickjs/core/index.mjs",
  "plugins/own-creator/quickjs/node_modules/@jitl/quickjs-ffi-types/dist/index.mjs",
  "plugins/own-creator/quickjs/node_modules/@jitl/quickjs-ffi-types/package.json",
  "plugins/own-creator/quickjs/variant/emscripten-module.wasm",
  "plugins/own-creator/quickjs/variant/index.mjs",
  "plugins/own-harness/index.js",
  "plugins/own-omo/LICENSE.md",
  "plugins/own-omo/MODIFICATIONS.md",
  "plugins/own-omo/THIRD-PARTY-NOTICES.md",
  "plugins/own-omo/index.js",
  "plugins/own-omo/omo-runtime.js",
  "plugins/own-omo/skills/debugging/SKILL.md",
  "plugins/own-remote/index.js",
  "plugins/own-team/index.js",
  "plugins/own-telemetry/index.js",
]

describe("remote packaging with git-lfs", () => {
  test("package --tools ships git-lfs and its license per target beside the archives, listed in both JSON files", async () => {
    const lfs = { "linux-x64-baseline": staticElf(0x3e), "linux-arm64": staticElf(0xb7) }
    const given = inputs("tools-ok", lfs)
    const run = Bun.spawnSync(
      [
        "bun",
        path.join(import.meta.dir, "bundle.ts"),
        "package",
        "--out",
        given.out,
        "--version",
        VERSION,
        "--build-id",
        "0123456789ab",
        "--plugins",
        given.pluginDir,
        "--binary",
        `linux-x64-baseline=${given.binary}`,
        "--binary",
        `linux-arm64=${given.binary}`,
        "--tools",
        given.tools,
        "--no-elf-check",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(run.exitCode).toBe(0)
    const remote = path.join(given.out, "remote")
    const manifest = JSON.parse(fs.readFileSync(path.join(remote, "manifest.json"), "utf8"))
    const artifacts = JSON.parse(fs.readFileSync(path.join(remote, "remote_artifacts.json"), "utf8"))
    const entries = Object.entries(lfs).map(
      ([target, data]) =>
        [
          target,
          {
            file: `tools/git-lfs/${GIT_LFS.version}/${target}/git-lfs`,
            sha256: sha256(data),
            bytes: data.length,
            files: { "LICENSE.md": `sha256:${sha256("MIT License\n")}`, "git-lfs": `sha256:${sha256(data)}` },
          },
        ] as const,
    )
    const tools = { "git-lfs": { version: GIT_LFS.version, targets: Object.fromEntries(entries) } }
    expect(manifest.tools).toEqual(tools)
    expect(artifacts.tools).toEqual(tools)
    for (const [target, data] of Object.entries(lfs)) {
      const folder = path.join(remote, "tools", "git-lfs", GIT_LFS.version, target)
      expect(fs.readdirSync(folder).sort()).toEqual(["LICENSE.md", "git-lfs"])
      expect(fs.readFileSync(path.join(folder, "git-lfs"))).toEqual(data)
      const entry = manifest.targets[target]
      expect(artifacts[target]).toEqual({ sha256: entry.sha256, bytes: entry.bytes, files: entry.files })
      // git-lfs is its own file: the archive holds the CLI, start.sh and REMOTE_PLUGINS (own-team, own-harness and
      // own-omo with its runtime, license, notices and skills; no own-computer-use).
      const listed = execFileSync(TAR, ["-tzf", path.join(remote, entry.file)], { encoding: "utf8", windowsHide: true })
      expect(listed.split(/\r?\n/).filter(Boolean).sort()).toEqual(LAYOUT)
      expect(Object.keys(entry.files).sort()).toEqual(LAYOUT.filter((file) => file !== "manifest.json"))
    }
    // own-remote still reads the manifest (the tools entry is additive), and release-smoke's reading finds no problem.
    expect((await Bundle.locate(remote, "linux-arm64")).ok).toBe(true)
    expect(inspectRemote(remote)).toEqual({
      plugins: { "linux-x64-baseline": [...REMOTE_PLUGINS].sort(), "linux-arm64": [...REMOTE_PLUGINS].sort() },
      lfs: {
        version: GIT_LFS.version,
        files: Object.fromEntries(entries.map(([target, entry]) => [target, entry.file])),
      },
      problems: { plugins: [], lfs: [], markers: [] },
    })
  }, 60_000)

  test("package refuses a target without git-lfs and its license, or a git-lfs for another machine or a dynamic one", () => {
    const given = inputs("tools-bad", { "linux-x64-baseline": staticElf(0x3e) })
    const run = () =>
      packageTargets({
        out: given.out,
        version: VERSION,
        buildId: "0123456789ab",
        plugins: given.pluginDir,
        binaries: { "linux-x64-baseline": given.binary, "linux-arm64": given.binary },
        elfCheck: false,
        tools: given.tools,
      })
    expect(run).toThrow(`no git-lfs ${GIT_LFS.version} with its license for linux-arm64`)
    const arm = path.join(given.tools, "git-lfs", GIT_LFS.version, "linux-arm64")
    fs.mkdirSync(arm, { recursive: true })
    fs.writeFileSync(path.join(arm, "git-lfs"), staticElf(0x3e))
    fs.writeFileSync(path.join(arm, "LICENSE.md"), "MIT License\n")
    expect(run).toThrow("ELF machine 0x3e is not linux-arm64")
    fs.writeFileSync(path.join(arm, "git-lfs"), elf(0xb7, "/lib/ld-linux-aarch64.so.1"))
    expect(run).toThrow("dynamically linked")
    fs.writeFileSync(path.join(arm, "git-lfs"), staticElf(0xb7))
    fs.rmSync(path.join(arm, "LICENSE.md"))
    expect(run).toThrow(`no git-lfs ${GIT_LFS.version} with its license for linux-arm64`)
    expect(fs.existsSync(path.join(given.out, "remote", "linux-x64-baseline.tar.gz"))).toBe(false)
  }, 30_000)

  test("inspectRemote names a missing remote, a missing git-lfs, and archives without own-team or with own-computer-use", () => {
    expect(inspectRemote(path.join(root, "nowhere")).problems.plugins[0]).toContain("manifest.json")
    const given = inputs("tools-none")
    packageTargets({
      out: given.out,
      version: VERSION,
      buildId: "0123456789ab",
      plugins: given.pluginDir,
      binaries: { "linux-x64-baseline": given.binary },
      elfCheck: false,
    })
    expect(inspectRemote(path.join(given.out, "remote")).problems).toEqual({
      plugins: [],
      lfs: ["linux-x64-baseline: no tools git-lfs entry"],
      markers: [],
    })
    // A hand-made remote: own-computer-use instead of own-team, git-lfs inside the archive, no tools files.
    const remote = path.join(root, "bad-remote")
    const stage = path.join(remote, "stage")
    const names = ["own-accounts", "own-remote", "own-computer-use"].map((name) => `plugins/${name}/index.js`)
    for (const file of ["opencode", "git-lfs", ...names]) {
      fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true })
      fs.writeFileSync(path.join(stage, file), "x\n")
    }
    const archive = path.join(remote, "linux-x64-baseline.tar.gz")
    execFileSync(TAR, ["-czf", archive, "-C", stage, "opencode", "git-lfs", "plugins"], { windowsHide: true })
    const file = `tools/git-lfs/${GIT_LFS.version}/linux-x64-baseline/git-lfs`
    const entry = { file, sha256: "0".repeat(64), bytes: 1, files: {} }
    // The packaged manifest's header (the schema own-remote reads it with), with this remote's targets and tools.
    const packaged = JSON.parse(fs.readFileSync(path.join(given.out, "remote", "manifest.json"), "utf8"))
    const bytes = fs.readFileSync(archive)
    fs.writeFileSync(
      path.join(remote, "manifest.json"),
      JSON.stringify({
        ...packaged,
        targets: {
          "linux-x64-baseline": {
            file: "linux-x64-baseline.tar.gz",
            sha256: sha256(bytes),
            bytes: bytes.length,
            files: {},
          },
        },
        tools: { "git-lfs": { version: GIT_LFS.version, targets: { "linux-x64-baseline": entry } } },
      }),
    )
    expect(inspectRemote(remote).problems).toEqual({
      plugins: ["linux-x64-baseline: plugins [own-accounts, own-computer-use, own-remote]"],
      lfs: [
        "linux-x64-baseline: git-lfs inside linux-x64-baseline.tar.gz",
        `linux-x64-baseline: ${file} missing`,
        "linux-x64-baseline: no git-lfs license",
      ],
      markers: [],
    })
    // A manifest own-remote could not read is named as such, not read through.
    const invalid = path.join(root, "invalid-remote")
    fs.mkdirSync(invalid, { recursive: true })
    fs.writeFileSync(path.join(invalid, "manifest.json"), JSON.stringify({ targets: {} }))
    expect(inspectRemote(invalid).problems.plugins[0]).toContain("does not match the remote manifest schema")
  }, 30_000)

  test("15 §1: own-omo goes with its runtime, license and notices; packaging refuses it without them, inspectRemote names an archive without them", () => {
    const missing = inputs("omo-missing")
    fs.rmSync(path.join(missing.pluginDir, OMO_RUNTIME.package, "omo-runtime.js"))
    expect(() =>
      packageTargets({
        out: missing.out,
        version: VERSION,
        buildId: "0123456789ab",
        plugins: missing.pluginDir,
        binaries: { "linux-x64-baseline": missing.binary },
        elfCheck: false,
      }),
    ).toThrow(`missing plugin bundle ${path.join(missing.pluginDir, OMO_RUNTIME.package, "omo-runtime.js")}`)
    const given = inputs("omo-index-only")
    packageTargets({
      out: given.out,
      version: VERSION,
      buildId: "0123456789ab",
      plugins: given.pluginDir,
      binaries: { "linux-x64-baseline": given.binary },
      elfCheck: false,
    })
    // A hand-made archive: every plugin's index.js, own-omo's without the files beside it.
    const remote = path.join(root, "omo-remote")
    const stage = path.join(remote, "stage")
    for (const file of ["opencode", ...REMOTE_PLUGINS.map((name) => `plugins/${name}/index.js`)]) {
      fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true })
      fs.writeFileSync(path.join(stage, file), "x\n")
    }
    const archive = path.join(remote, "linux-x64-baseline.tar.gz")
    execFileSync(TAR, ["-czf", archive, "-C", stage, "opencode", "plugins"], { windowsHide: true })
    const packaged = JSON.parse(fs.readFileSync(path.join(given.out, "remote", "manifest.json"), "utf8"))
    const bytes = fs.readFileSync(archive)
    fs.writeFileSync(
      path.join(remote, "manifest.json"),
      JSON.stringify({
        ...packaged,
        targets: {
          "linux-x64-baseline": { file: "linux-x64-baseline.tar.gz", sha256: sha256(bytes), bytes: bytes.length, files: {} },
        },
      }),
    )
    // own-creator's index.js alone is a problem too: a host's C2 sandbox needs its engine (17 §10).
    expect(inspectRemote(remote).problems.plugins).toEqual([
      ...OMO_RUNTIME.files.map((file) => `linux-x64-baseline: own-omo without ${file}`),
      ...CREATOR_QUICKJS_FILES.map((file) => `linux-x64-baseline: own-creator without ${file}`),
    ])
  }, 30_000)

  test("04 §8.11.14: an archive carrying third-party claude-auth code is a problem, whatever file it is in", () => {
    const given = inputs("markers")
    // A plugin bundle that pulled the third-party plugin in (its billing header name inside).
    fs.writeFileSync(
      path.join(given.pluginDir, "own-telemetry", "index.js"),
      `export const leaked = ${JSON.stringify(THIRD_PARTY_MARKERS[0])}\n`,
    )
    packageTargets({
      out: given.out,
      version: VERSION,
      buildId: "0123456789ab",
      plugins: given.pluginDir,
      binaries: { "linux-x64-baseline": given.binary },
      elfCheck: false,
    })
    expect(inspectRemote(path.join(given.out, "remote")).problems.markers).toEqual([
      "linux-x64-baseline: third-party claude-auth code in linux-x64-baseline.tar.gz",
    ])
    // The salt alone, in the CLI: still found.
    const salted = inputs("markers-cli")
    fs.writeFileSync(salted.binary, `#!/bin/sh\n# ${THIRD_PARTY_MARKERS[1]}\n`)
    packageTargets({
      out: salted.out,
      version: VERSION,
      buildId: "0123456789ab",
      plugins: salted.pluginDir,
      binaries: { "linux-x64-baseline": salted.binary },
      elfCheck: false,
    })
    expect(inspectRemote(path.join(salted.out, "remote")).problems.markers).toHaveLength(1)
  }, 30_000)
})
