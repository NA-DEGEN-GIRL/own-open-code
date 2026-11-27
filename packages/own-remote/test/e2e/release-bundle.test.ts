// The release packaging contract end to end: script/bundle.ts builds the real plugin bundles (with the build id
// defines, own-omo with its omo runtime) and packages them with start.sh into <target>.tar.gz + remote/manifest.json;
// own-remote then installs that archive on a fake-SSH host and starts it. Only the binary is a stand-in (the harness
// launcher), since a Linux executable cannot run here; the ELF check is covered separately.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  buildId,
  checkElf,
  CREATOR_QUICKJS,
  CREATOR_QUICKJS_FILES,
  IMAGEGEN_NOTICE,
  OMO_RUNTIME,
  packageTargets,
  plugins,
  REMOTE_PLUGINS,
} from "../../script/bundle.js"
import { Controller } from "../../src/controller.js"
import { Operations } from "../../src/operations.js"
import { Bundle } from "../../src/remote/bundle.js"
import * as Harness from "../harness/remote.js"

const VERSION = "2.0.18-own.42"
const run = Harness.available ? describe : describe.skip

run("release bundle → fake host", () => {
  let harness: Harness.Harness
  let controller: Controller
  let out: string

  beforeAll(async () => {
    harness = Harness.create({ version: VERSION, hosts: { buildbox: {} } })
    out = path.join(harness.root, "release")
    const id = buildId(VERSION)
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    const pluginDir = path.join(out, "plugins")
    // own-omo's bundle step also builds the omo runtime (packages/own-omo/script/bundle.ts), hence the longer timeout.
    await plugins({ out: pluginDir, version: VERSION, buildId: id, packages: [...REMOTE_PLUGINS] })
    const launcher = path.join(harness.root, "launcher")
    fs.writeFileSync(launcher, Harness.launcher(VERSION))
    packageTargets({ out, version: VERSION, buildId: id, plugins: pluginDir, binaries: { "linux-x64-baseline": launcher }, elfCheck: false })
    controller = new Controller({
      buildId: "e2e-release",
      version: VERSION,
      ownHome: harness.localHome,
      options: {
        sshCommand: harness.sshCommand,
        askpassHelper: harness.askpassHelper,
        remoteBundles: path.join(out, "remote"),
        sshDir: harness.sshDir,
        keepIntervalSeconds: 1,
        readyTimeoutMs: 20_000,
        backoffMs: [60_000],
      },
    })
    await controller.start()
  }, 300_000)

  afterAll(async () => {
    await controller?.close()
    await harness?.cleanup()
  }, 60_000)

  test("the manifest names every file with its sha256 and the archive hash", async () => {
    const located = await Bundle.locate(path.join(out, "remote"), "linux-x64-baseline")
    expect(located.ok).toBe(true)
    if (!located.ok) return
    expect(located.bundle.manifest).toMatchObject({ version: VERSION, channel: "own", proto: 1 })
    // own-omo goes with its runtime, license, notices and omo's skills (15 §1).
    const skills = fs
      .readdirSync(path.join(out, "plugins", OMO_RUNTIME.package, OMO_RUNTIME.skills), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith("SKILL.md"))
      .map((file) => `plugins/own-omo/skills/${file.split(path.sep).join("/")}`)
    expect(skills.length).toBeGreaterThan(0)
    const engine = path.join(out, "plugins", CREATOR_QUICKJS.package, CREATOR_QUICKJS.folder)
    const quickjs = fs
      .readdirSync(engine, { recursive: true, encoding: "utf8" })
      .filter((file) => fs.statSync(path.join(engine, file)).isFile())
      .filter((file) => /\.(?:mjs|wasm)$/.test(file) || path.basename(file) === "package.json")
      .map((file) => `plugins/own-creator/quickjs/${file.split(path.sep).join("/")}`)
    expect(quickjs).toEqual(expect.arrayContaining(CREATOR_QUICKJS_FILES.map((file) => `plugins/own-creator/${file}`)))
    expect(Object.keys(located.bundle.manifest.targets["linux-x64-baseline"]!.files).sort()).toEqual(
      [
        "libexec/start.sh",
        "opencode",
        "plugins/own-accounts/index.js",
        // own-accounts goes with the imagegen skill's license and changes (02 §9.6).
        ...Object.keys(IMAGEGEN_NOTICE.files).map((file) => `plugins/own-accounts/${file}`),
        // own-creator goes with own's WebAssembly engine for a host's C2 sandbox (17 §10).
        "plugins/own-creator/index.js",
        ...quickjs,
        "plugins/own-harness/index.js",
        "plugins/own-omo/index.js",
        ...OMO_RUNTIME.files.map((file) => `plugins/own-omo/${file}`),
        ...skills,
        "plugins/own-remote/index.js",
        "plugins/own-team/index.js",
        "plugins/own-telemetry/index.js",
      ].sort(),
    )
    expect(await Bundle.read(located.bundle)).toBeInstanceOf(Uint8Array)
    const artifacts = JSON.parse(fs.readFileSync(path.join(out, "remote", "remote_artifacts.json"), "utf8"))
    expect(artifacts["linux-x64-baseline"].sha256).toBe(located.bundle.manifest.targets["linux-x64-baseline"]!.sha256)
  })

  test("install + connect with the packaged bundle; the remote gets the same plugin files", async () => {
    const operations = new Operations(controller)
    const added = await controller.addHost({ alias: "buildbox" })
    if (!added.ok) throw new Error("add")
    const id = added.record.id
    await controller.connect(id, { clientId: "tab" })
    await controller.settled(id)
    expect(controller.view(id)!.stage).toBe("needs_install")
    const plan = await operations.preparePlan(id)
    if (!plan.ok) throw new Error(`plan ${plan.error}`)
    const executed = await operations.prepareExecute(plan.output.nonce)
    expect(executed.ok && executed.output.ok, JSON.stringify(executed)).toBe(true)
    await controller.connect(id, { clientId: "tab" })
    await controller.settled(id)
    expect(controller.view(id)!.stage).toBe("ready")
    const app = path.join(harness.ownHome("buildbox"), "app", VERSION)
    for (const name of REMOTE_PLUGINS)
      expect(fs.readFileSync(path.join(app, "plugins", name, "index.js"))).toEqual(
        fs.readFileSync(path.join(out, "plugins", name, "index.js")),
      )
    for (const file of OMO_RUNTIME.files)
      expect(fs.readFileSync(path.join(app, "plugins", OMO_RUNTIME.package, file))).toEqual(
        fs.readFileSync(path.join(out, "plugins", OMO_RUNTIME.package, file)),
      )
    // .verified lists the sizes and the manifest sums (04 §5.3).
    expect(fs.readFileSync(path.join(app, ".verified"), "utf8")).toContain("plugins/own-remote/index.js")
  }, 120_000)

  test("a tampered archive is refused before upload", async () => {
    const archive = path.join(out, "remote", "linux-x64-baseline.tar.gz")
    const data = fs.readFileSync(archive)
    data[data.length - 1] = data[data.length - 1]! ^ 0xff
    fs.writeFileSync(archive, data)
    const located = await Bundle.locate(path.join(out, "remote"), "linux-x64-baseline")
    if (!located.ok) throw new Error("locate")
    await expect(Bundle.read(located.bundle)).rejects.toThrow("hash mismatch")
  })

  test("ELF check: machine type and version string", () => {
    const file = path.join(harness.root, "elf")
    const header = Buffer.alloc(64)
    header.writeUInt32BE(0x7f454c46, 0)
    header[4] = 2
    header.writeUInt16LE(0xb7, 18)
    fs.writeFileSync(file, Buffer.concat([header, Buffer.from(`v${VERSION}`)]))
    expect(() => checkElf(file, "linux-arm64", VERSION)).not.toThrow()
    expect(() => checkElf(file, "linux-x64-baseline", VERSION)).toThrow("ELF machine")
    expect(() => checkElf(file, "linux-arm64", "2.0.18-own.43")).toThrow("version")
    fs.writeFileSync(file, "#!/bin/sh\n")
    expect(() => checkElf(file, "linux-arm64", VERSION)).toThrow("not an ELF")
  })
})
