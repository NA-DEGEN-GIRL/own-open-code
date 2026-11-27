import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Controller } from "../../src/controller.js"
import { Operations } from "../../src/operations.js"

// A made-up control-center with the structure of the old app (04 §19.1): 3 profiles, bindings, auto-prepare lists,
// deferred policy hosts. Never the real one.
describe("legacy import (04 §19): aliases only, read only", () => {
  let root: string
  let controller: Controller
  let operations: Operations
  let snapshot: string

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "own-remote-legacy-"))
    const center = path.join(root, "control-center")
    const profile = (id: string, value: Record<string, unknown>) => {
      fs.mkdirSync(path.join(center, "profiles", id), { recursive: true })
      fs.writeFileSync(path.join(center, "profiles", id, "ssh-bindings.json"), JSON.stringify(value))
    }
    const bound = { bindings: ["lab", "work_linux", "build-host"].map((alias) => ({ alias, profile_id: "p", revision: "r" })) }
    profile("p1", { ...bound, auto_prepare_aliases: ["lab", "aws_02", "aws_03"], pending_policy_hosts: ["lab"], deferred_policy_hosts: ["lab"] })
    profile("p2", { ...bound, auto_prepare_aliases: ["aws_02"], pending_policy_hosts: [], deferred_policy_hosts: [] })
    profile("p3", { bindings: [], auto_prepare_aliases: [] })
    const ssh = path.join(root, "dot-ssh")
    fs.mkdirSync(ssh)
    fs.writeFileSync(
      path.join(ssh, "config"),
      [
        "Host work_linux",
        "  HostName a",
        "Host aws_02",
        "  HostName b",
        "Host aws_03",
        "  HostName c",
        "Host il_01",
        "  HostName d",
        "Host lab",
        "  HostName e",
        "Host lab-7676",
        "  LocalForward 7676 127.0.0.1:7676",
        "Host build-host dev-host",
        "  HostName f",
        "",
      ].join("\n"),
    )
    snapshot = JSON.stringify(
      fs.readdirSync(path.join(center, "profiles")).map((id) => fs.readFileSync(path.join(center, "profiles", id, "ssh-bindings.json"), "utf8")),
    )
    controller = new Controller({
      buildId: "legacy-test",
      version: "2.0.18-own.1",
      ownHome: path.join(root, "own"),
      options: { legacyRoot: center, sshDir: ssh, sshCommand: ["C:\\nowhere\\ssh.exe"] },
    })
    await controller.start()
    operations = new Operations(controller)
  })

  afterAll(async () => {
    await controller.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("plan: bound aliases selected, aws unselected, lab-7676 and dev-host excluded, deferred policy shown", async () => {
    const plan = await operations.legacyPlan()
    const byAlias = Object.fromEntries(plan.output.hosts.map((host) => [host.alias, host]))
    for (const alias of ["lab", "work_linux", "build-host"]) expect(byAlias[alias]).toMatchObject({ selected: true, autoConnect: true, profiles: 2 })
    for (const alias of ["aws_02", "aws_03", "il_01"]) expect(byAlias[alias]).toMatchObject({ selected: false, exclude: null })
    expect(byAlias["lab-7676"]!.exclude).toBe("forward_conflict")
    expect(byAlias["dev-host"]!.exclude).toBe("duplicate_host_line")
    expect(byAlias["lab"]!.deferredPolicy).toBe(true)
    expect(byAlias["work_linux"]!.deferredPolicy).toBe(false)
  })

  test("execute adds the chosen aliases only; the old app's files are unchanged; nothing ran", async () => {
    const plan = await operations.legacyPlan()
    const done = await operations.legacyExecute(plan.output.nonce, ["lab", "work_linux", "lab-7676"])
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.output.added.map((host) => host.alias).sort()).toEqual(["lab", "work_linux"])
    expect(done.output.added.every((host) => host.autoConnect && host.stage === "disconnected")).toBe(true)
    const center = path.join(root, "control-center")
    const after = JSON.stringify(
      fs.readdirSync(path.join(center, "profiles")).map((id) => fs.readFileSync(path.join(center, "profiles", id, "ssh-bindings.json"), "utf8")),
    )
    expect(after).toBe(snapshot)
    const again = await operations.legacyExecute(plan.output.nonce, ["lab"])
    expect(again.ok).toBe(false)
    const replan = await operations.legacyPlan()
    expect(replan.output.hosts.find((host) => host.alias === "lab")!.exclude).toBe("already_added")
  })
})
