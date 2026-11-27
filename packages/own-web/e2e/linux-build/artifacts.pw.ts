// RG2: the real own-channel Linux release bundles (04 §5.2) as own-remote will upload them. Independent of the
// build tooling's own checks: the archive hashes and the layout are read back with tar, every file is hashed against
// both manifests, each `opencode` is parsed as ELF (machine, glibc interpreter, version, own-channel user agent), and
// own-remote's real install flow runs against each archive on the fake-SSH harness (install-check.ts). Skipped when
// no bundles were built.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "../../../..")
const TAR = "C:\\Windows\\System32\\tar.exe"
const TARGETS = {
  "linux-x64-baseline": { machine: 0x3e, interpreter: "/lib64/ld-linux-x86-64.so.2" },
  "linux-arm64": { machine: 0xb7, interpreter: "/lib/ld-linux-aarch64.so.1" },
} as const
/**
 * 04 §5.2: only these; own-vault and the bundled claude-auth stay on the PC. own-telemetry runs on hosts for the
 * Claude slot the PC relays (04 §8.11.14), own-harness carries own.harness to hosts (10 §6.1), and own-omo carries omo
 * with its runtime, license and notices (15 §1), plus omo's skills ({@link SKILL}); own-accounts carries the imagegen
 * skill's license and changes (02 §9.6); own-creator runs creator extensions on hosts (17 §10) with its QuickJS engine
 * ({@link QUICKJS}).
 */
const LAYOUT = [
  "libexec/start.sh",
  "manifest.json",
  "opencode",
  "plugins/own-accounts/imagegen-LICENSE.txt",
  "plugins/own-accounts/imagegen-MODIFICATIONS.md",
  "plugins/own-accounts/index.js",
  "plugins/own-creator/index.js",
  "plugins/own-harness/index.js",
  "plugins/own-omo/LICENSE.md",
  "plugins/own-omo/MODIFICATIONS.md",
  "plugins/own-omo/THIRD-PARTY-NOTICES.md",
  "plugins/own-omo/index.js",
  "plugins/own-omo/omo-runtime.js",
  "plugins/own-remote/index.js",
  "plugins/own-team/index.js",
  "plugins/own-telemetry/index.js",
]
/** omo's built-in skills beside its runtime (packages/own-omo/script/bundle.ts), one folder each. */
const SKILL = /^plugins\/own-omo\/skills\/[^/]+\/SKILL\.md$/
/**
 * own-creator's bundled QuickJS engine (packages/own-remote/script/bundle.ts, RL4-P1): the core and variant chunks (their
 * names carry content hashes), the variant's .wasm and the types package both import by name.
 */
const QUICKJS = /^plugins\/own-creator\/quickjs\//

type Manifest = {
  schemaVersion: number
  version: string
  build_id: string
  proto: number
  channel: string
  targets: Record<string, { file: string; sha256: string; bytes: number; files: Record<string, string> }>
  /** The pinned static git-lfs, beside the archives (06 §4.13). */
  tools?: { "git-lfs"?: { version: string; targets: Record<string, { file: string; sha256: string; bytes: number }> } }
}

function newestBundles() {
  if (process.env.OWN_REMOTE_ARTIFACTS) return process.env.OWN_REMOTE_ARTIFACTS
  const candidates = ["remote", "build"].flatMap((group) => {
    const root = path.join(REPO, "own", ".out", group)
    if (!fs.existsSync(root)) return []
    return fs
      .readdirSync(root)
      .map((version) => path.join(root, version, "remote"))
      .filter((dir) => fs.existsSync(path.join(dir, "manifest.json")))
  })
  return candidates.sort(
    (a, b) => fs.statSync(path.join(b, "manifest.json")).mtimeMs - fs.statSync(path.join(a, "manifest.json")).mtimeMs,
  )[0]
}

function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

function interpreter(elf: Buffer) {
  const phoff = Number(elf.readBigUInt64LE(32))
  const size = elf.readUInt16LE(54)
  for (let index = 0; index < elf.readUInt16LE(56); index++) {
    const at = phoff + index * size
    if (elf.readUInt32LE(at) !== 3) continue
    const offset = Number(elf.readBigUInt64LE(at + 8))
    return elf
      .subarray(offset, offset + Number(elf.readBigUInt64LE(at + 32)))
      .toString("latin1")
      .replace(/\0+$/, "")
  }
  return undefined
}

const dir = newestBundles()
const manifest: Manifest | undefined = dir
  ? JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
  : undefined
/** Created in the worker only (Playwright also loads this file in the runner process to list the tests). */
let unpacked = ""

test.describe.configure({ mode: "serial" })
test.skip(!dir || !manifest, "no remote bundles (run own/scripts/build-remote.ps1 first)")
test.beforeAll(() => {
  unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "own-linux-build-"))
})
test.afterAll(() => {
  if (unpacked) fs.rmSync(unpacked, { recursive: true, force: true })
})

test("the release manifest covers both R1 targets for the own channel", () => {
  expect(manifest).toMatchObject({ schemaVersion: 1, channel: "own", proto: 1 })
  expect(manifest!.version).toMatch(/^\d+\.\d+\.\d+-own\.\d+$/)
  expect(manifest!.build_id).toMatch(/^[0-9a-f]{12}$/)
  expect(Object.keys(manifest!.targets).sort()).toEqual(Object.keys(TARGETS).sort())
  const artifacts = JSON.parse(fs.readFileSync(path.join(dir!, "remote_artifacts.json"), "utf8"))
  for (const [target, entry] of Object.entries(manifest!.targets))
    expect(artifacts[target]).toEqual({ sha256: entry.sha256, bytes: entry.bytes, files: entry.files })
})

for (const [target, spec] of Object.entries(TARGETS)) {
  test(`${target}: archive hash, layout and file hashes`, () => {
    const entry = manifest!.targets[target]!
    const archive = path.join(dir!, entry.file)
    const data = fs.readFileSync(archive)
    expect(data.length).toBe(entry.bytes)
    expect(sha256(data)).toBe(entry.sha256)
    const listed = spawnSync(TAR, ["-tzf", archive], { encoding: "utf8", windowsHide: true })
    expect(listed.status).toBe(0)
    const names = listed.stdout.split(/\r?\n/).filter(Boolean).sort()
    const skills = names.filter((name) => SKILL.test(name))
    expect(skills.length).toBeGreaterThan(0)
    const engine = names.filter((name) => QUICKJS.test(name))
    expect(engine).toEqual(
      expect.arrayContaining([
        "plugins/own-creator/quickjs/core/index.mjs",
        "plugins/own-creator/quickjs/variant/index.mjs",
        "plugins/own-creator/quickjs/variant/emscripten-module.wasm",
        "plugins/own-creator/quickjs/node_modules/@jitl/quickjs-ffi-types/package.json",
      ]),
    )
    expect(names.filter((name) => !SKILL.test(name) && !QUICKJS.test(name))).toEqual(LAYOUT)
    const out = path.join(unpacked, target)
    fs.mkdirSync(out, { recursive: true })
    expect(spawnSync(TAR, ["-xzf", archive, "-C", out], { windowsHide: true }).status).toBe(0)
    expect(Object.keys(entry.files).sort()).toEqual(
      [...LAYOUT.filter((file) => file !== "manifest.json"), ...skills, ...engine].sort(),
    )
    for (const [file, hash] of Object.entries(entry.files))
      expect(`sha256:${sha256(fs.readFileSync(path.join(out, file)))}`).toBe(hash)
    const inner = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"))
    expect(inner).toEqual({
      version: manifest!.version,
      build_id: manifest!.build_id,
      proto: manifest!.proto,
      target,
      files: entry.files,
    })
    // The plugins carry the release defines (FORK §8.2 step 3), never the "dev"/"local" fallbacks.
    for (const name of ["own-accounts", "own-remote", "own-team"]) {
      const text = fs.readFileSync(path.join(out, "plugins", name, "index.js"), "utf8")
      expect(text).toContain(JSON.stringify(manifest!.build_id))
      expect(text).toContain(JSON.stringify(manifest!.version))
      expect(text).not.toMatch(/typeof OWN_(BUILD_ID|EXPECTED_APP_VERSION|PLUGIN_VERSION)\b/)
    }
    expect(fs.readFileSync(path.join(out, "libexec", "start.sh"), "utf8")).toMatch(/^#!\/bin\/sh\n/)
  })

  test(`${target}: the pinned git-lfs sits beside the archive with its hash and size`, () => {
    const tool = manifest!.tools?.["git-lfs"]?.targets[target]
    expect(tool).toBeDefined()
    const data = fs.readFileSync(path.join(dir!, tool!.file))
    expect(data.length).toBe(tool!.bytes)
    expect(sha256(data)).toBe(tool!.sha256)
  })

  test(`${target}: opencode is an own-channel glibc ELF64 for the target machine`, () => {
    const elf = fs.readFileSync(path.join(unpacked, target, "opencode"))
    expect(elf.readUInt32BE(0)).toBe(0x7f454c46)
    expect(elf[4]).toBe(2) // ELFCLASS64
    expect(elf[5]).toBe(1) // little-endian
    expect(elf.readUInt16LE(18)).toBe(spec.machine)
    expect([2, 3]).toContain(elf.readUInt16LE(16)) // EXEC or DYN
    expect(interpreter(elf)).toBe(spec.interpreter)
    expect(elf.includes(Buffer.from(manifest!.version))).toBe(true)
    expect(elf.includes(Buffer.from(`opencode/own/${manifest!.version}/cli`))).toBe(true)
    test.info().annotations.push({
      type: "size",
      description: `${target}: opencode ${elf.length} bytes, archive ${manifest!.targets[target]!.bytes} bytes`,
    })
  })

  test(`${target}: own-remote installs the real archive on a fake host up to the exec check`, () => {
    // Through the shell: `bun` is often a .cmd shim on Windows, which spawn without a shell cannot start.
    const args = [path.join(HERE, "install-check.ts"), "--remote", dir!, "--target", target].map(
      (value) => `"${value}"`,
    )
    const run = spawnSync("bun", args, {
      cwd: path.join(REPO, "packages", "own-web"),
      encoding: "utf8",
      shell: true,
      windowsHide: true,
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    expect(run.status, `${run.error ?? ""}\n${run.stderr}`).toBe(0)
    const report = JSON.parse(run.stdout)
    expect(report.stageBeforeInstall).toBe("needs_install")
    expect(report.plan).toMatchObject({ target, bytes: manifest!.targets[target]!.bytes })
    // Upload, `tar -xzf` and `sha256sum -c` passed (a checksum failure ends as install_failed before this); the
    // Linux binary cannot run on the Windows "host", which the install reports as a platform mismatch.
    expect(report.steps).toEqual([
      { step: "upload", ok: true },
      { step: "verify", ok: false, detail: "platform_mismatch: version" },
    ])
    expect(report.executeOk).toBe(false)
    expect(report).toMatchObject({ stage: "failed", error: "platform_unsupported" })
    // Nothing is left: no version directory, no staging directory, no `current` link.
    expect(report.remoteApp).toEqual([])
  })
}
