import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Controller } from "../../src/controller.js"
import { Operations } from "../../src/operations.js"
import { RemoteModel } from "../../src/remote/model.js"
import { quote } from "../../src/vendor/ssh/command.js"
import { available, buildBundle, create, GIT_BASH, toPosix, type Harness } from "../harness/remote.js"

/**
 * `hosts.tools.ensure` (06 §4.13, TG17 fake-SSH part): the release's pinned git-lfs reaches a host by upload only,
 * under `<OWN_HOME>/tools/git-lfs/<version>/`, and its `current` folder joins the host's `pathPrepend`. An update to a
 * release with a newer pin moves a host that has the tool to it, and gives a host without it nothing (LFS-3).
 */

const V = "2.0.18-own.1"
const V2 = "2.0.18-own.2"
const LFS = "3.8.0"
const LFS2 = "3.8.1"
const TARGET = "linux-x64-baseline"
const fakeLfs = (version: string) =>
  `#!/bin/sh\ncase "\${1:-}" in\n  version) echo "git-lfs/${version} (GitHub; linux amd64; go 1.24.4)"; exit 0 ;;\nesac\nexit 2\n`
const BINARY = fakeLfs(LFS)
const LICENSE = "MIT License\n\nCopyright (c) 2014- GitHub, Inc. and Git LFS contributors (test copy)\n"
const run = available ? describe : describe.skip

function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

/** The release layout of bundle.ts `packageLfs`: the tool and its license beside the archives, listed in `tools`. */
function addLfs(bundles: string, version: string) {
  const binary = fakeLfs(version)
  const folder = path.join(bundles, "tools", "git-lfs", version, TARGET)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, "git-lfs"), binary)
  fs.writeFileSync(path.join(folder, "LICENSE.md"), LICENSE)
  const manifestFile = path.join(bundles, "manifest.json")
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  manifest.tools = {
    "git-lfs": {
      version,
      targets: {
        [TARGET]: {
          file: `tools/git-lfs/${version}/${TARGET}/git-lfs`,
          sha256: sha256(binary),
          bytes: Buffer.byteLength(binary),
          files: { "git-lfs": `sha256:${sha256(binary)}`, "LICENSE.md": `sha256:${sha256(LICENSE)}` },
        },
      },
    },
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  return folder
}

function start(harness: Harness, version: string, bundles: string) {
  return new Controller({
    buildId: "e2e-tools",
    version,
    ownHome: harness.localHome,
    options: {
      sshCommand: harness.sshCommand,
      askpassHelper: harness.askpassHelper,
      remoteBundles: bundles,
      sshDir: harness.sshDir,
      keepIntervalSeconds: 1,
      readyTimeoutMs: 20_000,
      backoffMs: [60_000],
      drainCapMs: 60_000,
    },
  })
}

/** Every file and folder under `dir`, relative, with `/` separators. Links are listed, never followed. */
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = entry.name
    if (!entry.isDirectory() || entry.isSymbolicLink()) return [rel]
    return [rel, ...tree(path.join(dir, entry.name)).map((child) => `${rel}/${child}`)]
  })
}

run("hosts.tools.ensure over the fake-SSH harness (06 §4.13)", () => {
  let harness: Harness
  let controller: Controller
  let operations: Operations
  let id = ""
  let plainId = ""
  let folder = ""

  /** Adds the host, installs the running release and connects again: the host ends `ready`. */
  const install = async (alias: string) => {
    const added = await controller.addHost({ alias })
    if (!added.ok) throw new Error("add")
    const host = added.record.id
    await controller.connect(host, { clientId: "tab-1" })
    await controller.settled(host)
    const plan = await operations.preparePlan(host)
    if (!plan.ok) throw new Error(`prepare.plan ${plan.error}`)
    const executed = await operations.prepareExecute(plan.output.nonce)
    if (!executed.ok || !executed.output.ok) throw new Error("prepare.execute failed")
    await controller.connect(host, { clientId: "tab-1" })
    await controller.settled(host)
    if (controller.view(host)!.stage !== "ready") throw new Error(`stage ${controller.view(host)!.stage}`)
    return host
  }

  beforeAll(async () => {
    // plainbox never gets the tool, so an update leaves it without one (LFS-3).
    harness = create({ version: V, hosts: { lfsbox: {}, plainbox: {} } })
    folder = addLfs(harness.bundles, LFS)
    controller = start(harness, V, harness.bundles)
    await controller.start()
    operations = new Operations(controller)
    id = await install("lfsbox")
    plainId = await install("plainbox")
  }, 300_000)

  afterAll(async () => {
    await controller?.close().catch(() => {})
    await harness?.cleanup()
  }, 60_000)

  const remoteTools = () => path.join(harness.ownHome("lfsbox"), "tools")
  const toolDir = () => RemoteModel.toolDir(controller.record(id)!.remote!.ownHome, "git-lfs")

  test("a local file that does not match the manifest: tool_hash_mismatch, nothing reaches the host", async () => {
    const calls = harness.sshLog().length
    fs.appendFileSync(path.join(folder, "git-lfs"), "# changed\n")
    const result = await operations.toolsEnsure(id, "git-lfs")
    fs.writeFileSync(path.join(folder, "git-lfs"), BINARY)
    expect(result).toEqual({
      ok: false,
      error: "tool_hash_mismatch",
      data: { tool: "git-lfs", expected: sha256(BINARY), actual: sha256(`${BINARY}# changed\n`) },
    })
    expect(harness.sshLog()).toHaveLength(calls)
    expect(fs.existsSync(remoteTools())).toBe(false)
    expect(controller.record(id)!.pathPrepend).toEqual([])
  }, 60_000)

  test("the first ensure uploads under OWN_HOME only; pathPrepend gains the current folder and settings wait", async () => {
    const home = harness.hostHome("lfsbox")
    const before = new Set(tree(home))
    const calls = harness.sshLog().length
    const result = await operations.toolsEnsure(id, "git-lfs")
    expect(result).toMatchObject({ ok: true, output: { state: "uploaded", version: LFS } })
    expect(result.ok && result.sent).toBe(Buffer.byteLength(LICENSE) + Buffer.byteLength(BINARY))
    // One look and one upload, both plain `sh -c` sessions of the user (no sudo).
    const sessions = harness.sshLog().slice(calls)
    expect(sessions).toHaveLength(2)
    for (const entry of sessions) {
      expect(String(entry.command)).toStartWith("sh -c '")
      expect(String(entry.command)).not.toContain("sudo")
    }
    const dest = path.join(remoteTools(), "git-lfs", LFS)
    expect(fs.readFileSync(path.join(dest, "git-lfs"), "utf8")).toBe(BINARY)
    expect(fs.readFileSync(path.join(dest, "LICENSE.md"), "utf8")).toBe(LICENSE)
    const current = `${toolDir()}/git-lfs`
    expect(
      spawnSync(GIT_BASH, ["-c", `${quote(current)} version`], { encoding: "utf8", windowsHide: true }).stdout,
    ).toContain(`git-lfs/${LFS} `)
    // Nothing outside <OWN_HOME>/tools changed on the host, and ~/.gitconfig was never written.
    const own = path
      .relative(home, path.join(harness.ownHome("lfsbox"), "tools"))
      .split(path.sep)
      .join("/")
    expect(tree(home).filter((entry) => !before.has(entry) && entry !== own && !entry.startsWith(`${own}/`))).toEqual(
      [],
    )
    expect(fs.existsSync(path.join(home, ".gitconfig"))).toBe(false)
    expect(controller.record(id)!.pathPrepend).toEqual([toolDir()])
    expect(controller.view(id)!.pendingSettings).toBe(true)
  }, 120_000)

  test("the second ensure finds it present: one look, 0 bytes, pathPrepend unchanged", async () => {
    const calls = harness.sshLog().length
    const result = await operations.toolsEnsure(id, "git-lfs")
    expect(result).toEqual({ ok: true, output: { state: "present", version: LFS }, sent: 0 })
    expect(harness.sshLog().slice(calls)).toHaveLength(1)
    expect(controller.record(id)!.pathPrepend).toEqual([toolDir()])
  }, 60_000)

  test("it runs under the host operation lock", async () => {
    if (!controller.begin(id, { opId: "op_other", kind: "update" })) throw new Error("begin")
    const calls = harness.sshLog().length
    const result = await operations.toolsEnsure(id, "git-lfs")
    controller.end(id)
    expect(result).toEqual({ ok: false, error: "host_busy", data: { hostId: id, opId: "op_other" } })
    expect(harness.sshLog()).toHaveLength(calls)
  }, 60_000)

  test("after a restart the service PATH starts with the tool folder (04 §6.4 pending settings applied)", async () => {
    const plan = await operations.drainPlan(id)
    if (!plan.ok) throw new Error("drain plan")
    const started = operations.drainExecute(plan.output.nonce, "now")
    if (!started.ok) throw new Error("drain execute")
    await operations.wait(started.output.opId)
    await controller.connect(id, { clientId: "tab-1" })
    await controller.settled(id)
    expect(controller.view(id)).toMatchObject({ stage: "ready", pendingSettings: false })
    const probe = controller.host(id)?.probe as { path?: string } | undefined
    // In the harness the PATH passes through Windows (the fake service is a Windows process), which resolves the
    // `current` link and maps the temp folder to /tmp; on Linux the entry is `toolDir()` itself.
    expect(String(probe?.path).split(":")[0]).toMatch(
      /\/\.local\/share\/own-open-code\/tools\/git-lfs\/(current|3\.8\.0)$/,
    )
  }, 120_000)

  test("an update to a release with a newer git-lfs moves current to it; a host without one gets none (LFS-3)", async () => {
    const bundles = buildBundle(path.join(harness.root, "v2"), V2)
    addLfs(bundles, LFS2)
    await controller.close()
    controller = start(harness, V2, bundles)
    await controller.start()
    operations = new Operations(controller)
    for (const host of [id, plainId]) {
      await controller.connect(host, { clientId: "tab-1" })
      await controller.settled(host)
      expect(controller.view(host)).toMatchObject({ stage: "incompatible", error: "version_skew" })
      const plan = await operations.updatePlan(host)
      if (!plan.ok) throw new Error(`update.plan ${plan.error}`)
      const started = operations.updateExecute(plan.output.nonce, "now")
      if (!started.ok) throw new Error("update.execute")
      await operations.wait(started.output.opId)
      expect(controller.view(host)).toMatchObject({ stage: "ready", error: null })
      expect(controller.view(host)!.versions.remoteRunning).toBe(V2)
    }
    // lfsbox runs the new pin through `current` and keeps the previous folder; its PATH entry stays the same.
    const root = path.join(remoteTools(), "git-lfs")
    const linked = spawnSync(GIT_BASH, ["-c", `readlink ${quote(toPosix(path.join(root, "current")))}`], {
      encoding: "utf8",
      env: { MSYS: "winsymlinks:native", PATH: "/usr/bin:/bin" },
      windowsHide: true,
    })
    expect(linked.stdout.trim().replace(/\/+$/, "")).toBe(LFS2)
    const current = `${toolDir()}/git-lfs`
    expect(
      spawnSync(GIT_BASH, ["-c", `${quote(current)} version`], { encoding: "utf8", windowsHide: true }).stdout,
    ).toContain(`git-lfs/${LFS2} `)
    expect(fs.readFileSync(path.join(root, LFS2, "git-lfs"), "utf8")).toBe(fakeLfs(LFS2))
    expect(fs.existsSync(path.join(root, LFS, ".verified"))).toBe(true)
    expect(controller.record(id)!.pathPrepend).toEqual([toolDir()])
    const tools = (host: string) =>
      fs
        .readFileSync(path.join(harness.localHome, "remote", host, "ops.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.kind === "tools")
    expect(tools(id).at(-1)).toMatchObject({ version: LFS2, outcome: "uploaded", refresh: true, from: LFS })
    // plainbox never had the tool: nothing went up and its journal has no tool line.
    expect(fs.existsSync(path.join(harness.ownHome("plainbox"), "tools"))).toBe(false)
    expect(tools(plainId)).toEqual([])
    expect(controller.record(plainId)!.pathPrepend).toEqual([])
  }, 300_000)

  test("forget with uninstall removes tools/ with the install", async () => {
    const plan = await operations.forgetPlan(id, true)
    if (!plan.ok) throw new Error("forget plan")
    expect(plan.output.removes).toContain(`${controller.record(id)!.remote!.ownHome}/tools`)
    const done = await operations.forgetExecute(plan.output.nonce)
    expect(done).toEqual({ ok: true, output: { ok: true } })
    expect(fs.existsSync(remoteTools())).toBe(false)
    expect(fs.existsSync(path.join(harness.ownHome("lfsbox"), "app"))).toBe(false)
    expect(controller.record(id)).toBeUndefined()
  }, 120_000)
})
