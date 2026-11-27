// RG2: own-remote's install flow (04 §5.5) against a real release bundle on the fake-SSH harness. Run by
// artifacts.pw.ts (or by hand): `bun e2e/linux-build/install-check.ts --remote <dir with manifest.json> --target <t>`.
// Prints one JSON report on stdout.
//
// The "host" is a Git Bash with a temp HOME (packages/own-remote/test/harness); its `uname -m` shim reports the
// target's machine so inspect picks that target's archive. The real archive is uploaded, unpacked and checked with
// `sha256sum -c` against the manifest; the install then runs the Linux binary's `--version`, which Windows cannot
// execute, so the expected end is `platform_mismatch` → `platform_unsupported` with nothing left behind. No real host,
// no ~/.ssh, no known_hosts; the temp root is removed on exit.
import fs from "node:fs"
import path from "node:path"
import { Controller } from "../../../own-remote/src/controller"
import { Operations } from "../../../own-remote/src/operations"
import { Bundle } from "../../../own-remote/src/remote/bundle"
import * as Harness from "../../../own-remote/test/harness/remote"

const MACHINES: Record<string, string> = { "linux-x64-baseline": "x86_64", "linux-arm64": "aarch64" }

function arg(name: string) {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const remote = arg("remote")
const target = arg("target")
if (!remote || !target || !MACHINES[target]) throw new Error("--remote <dir> --target linux-x64-baseline|linux-arm64")
if (!Harness.available) throw new Error("needs Windows with Git for Windows (its bash plays the remote host)")

const located = await Bundle.locate(remote, target)
if (!located.ok) throw new Error(`${located.reason}: ${located.path}`)
const version = located.bundle.manifest.version
const harness = Harness.create({ version, hosts: { buildbox: {} } })
fs.writeFileSync(
  path.join(harness.root, "shim", "uname"),
  ["#!/bin/sh", `case "\${1:-}" in -m) echo ${MACHINES[target]} ;; *) echo Linux ;; esac`, ""].join("\n"),
)
const controller = new Controller({
  buildId: "e2e-linux-build",
  version,
  ownHome: harness.localHome,
  options: {
    sshCommand: harness.sshCommand,
    askpassHelper: harness.askpassHelper,
    remoteBundles: remote,
    sshDir: harness.sshDir,
    keepIntervalSeconds: 1,
    readyTimeoutMs: 20_000,
    backoffMs: [60_000],
  },
})

try {
  await controller.start()
  const operations = new Operations(controller)
  const added = await controller.addHost({ alias: "buildbox" })
  if (!added.ok) throw new Error("addHost failed")
  const id = added.record.id
  await controller.connect(id, { clientId: "linux-build" })
  await controller.settled(id)
  const before = controller.view(id)!.stage
  const plan = await operations.preparePlan(id)
  if (!plan.ok) throw new Error(`prepare.plan: ${plan.error}`)
  const executed = await operations.prepareExecute(plan.output.nonce)
  const view = controller.view(id)!
  const app = path.join(harness.ownHome("buildbox"), "app")
  const report = {
    target,
    version,
    archive: { file: located.bundle.archive, bytes: located.bundle.bytes },
    stageBeforeInstall: before,
    plan: { target: plan.output.platform.target, bytes: plan.output.install.bytes, dir: plan.output.install.dir },
    steps: executed.ok ? executed.output.steps : [],
    executeOk: executed.ok && executed.output.ok,
    stage: view.stage,
    error: view.error,
    detail: view.detail,
    remoteApp: fs.existsSync(app) ? fs.readdirSync(app).sort() : [],
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
} finally {
  await controller.close()
  await harness.cleanup()
}
