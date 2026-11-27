import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Controller } from "../../src/controller.js"
import { Operations } from "../../src/operations.js"
import { Broker } from "../../src/protocol/broker.js"
import { OwnRemote } from "../../src/protocol/rpc-remote.js"
import * as Harness from "../harness/remote.js"

const V1 = "2.0.18-own.1"
const V2 = "2.0.18-own.2"
const BUILD = "e2e-lifecycle"
const run = Harness.available ? describe : describe.skip

async function until<T>(read: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

run("own-remote lifecycle over the fake-SSH harness", () => {
  let harness: Harness.Harness
  let broker: ReturnType<typeof Harness.fakeBroker>
  let unprovide: () => void
  let bundlesV2: string
  const controllers: Controller[] = []

  const make = async (version: string, bundles: string) => {
    const controller = new Controller({
      buildId: BUILD,
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
    controllers.push(controller)
    await controller.start()
    return { controller, operations: new Operations(controller) }
  }

  const install = async (controller: Controller, operations: Operations, id: string, clientId = "tab-1") => {
    await controller.connect(id, { clientId })
    await controller.settled(id)
    if (controller.view(id)!.stage === "needs_install") {
      const plan = await operations.preparePlan(id)
      if (!plan.ok) throw new Error(`prepare.plan ${plan.error}`)
      const executed = await operations.prepareExecute(plan.output.nonce)
      if (!executed.ok || !executed.output.ok) throw new Error("prepare.execute failed")
      await controller.connect(id, { clientId })
      await controller.settled(id)
    }
  }

  beforeAll(() => {
    harness = Harness.create({
      version: V1,
      hosts: {
        devbox: {},
        pwbox: { password: "correct horse" },
        fwdbox: { forwards: ["7676 127.0.0.1:7676"] },
      },
    })
    bundlesV2 = Harness.buildBundle(path.join(harness.root, "v2"), V2)
    broker = Harness.fakeBroker()
    unprovide = Broker.provideLocal(BUILD, broker.broker)
  })

  afterAll(async () => {
    for (const controller of controllers) await controller.close().catch(() => {})
    unprovide?.()
    broker?.close()
    await harness?.cleanup()
  }, 60_000)

  test("password prompts go to the owning client; a background attempt pauses instead of prompting", async () => {
    const { controller } = await make(V1, harness.bundles)
    const added = await controller.addHost({ alias: "pwbox" })
    if (!added.ok) throw new Error("add")
    const id = added.record.id
    await controller.connect(id, { background: true })
    await controller.settled(id)
    expect(controller.view(id)).toMatchObject({ stage: "authentication", paused: true })
    const prompts: Array<Record<string, any>> = []
    const unsubscribe = controller.hub.subscribe((event) => {
      if (event.name === "host.prompt") prompts.push(event.data)
    })
    await controller.connect(id, { clientId: "window-A" })
    const prompt = await until(() => prompts[0])
    expect(prompt).toMatchObject({ kind: "password", ownerClientId: "window-A" })
    expect(controller.view(id)!.owner.clientId).toBe("window-A")
    // A second window does not replace the attempt and cannot answer.
    expect(await controller.connect(id, { clientId: "window-B" })).toBe("authentication")
    expect((await controller.respond(id, prompt.promptId, "window-B", "correct horse")).ok).toBe(false)
    expect((await controller.respond(id, prompt.promptId, "window-A", "correct horse")).ok).toBe(true)
    await controller.settled(id)
    unsubscribe()
    expect(controller.view(id)!.stage).toBe("needs_install")
    await controller.close()
  }, 120_000)

  test("a config forward on the alias stops the tunnel with forward_conflict (04 §7.5)", async () => {
    const { controller } = await make(V1, harness.bundles)
    const added = await controller.addHost({ alias: "fwdbox" })
    if (!added.ok) throw new Error("add")
    await controller.connect(added.record.id, { clientId: "tab-1" })
    await controller.settled(added.record.id)
    expect(controller.view(added.record.id)).toMatchObject({ stage: "failed", error: "forward_conflict", paused: true })
    // Only `ssh -G` ran: no connection was made.
    const calls = harness.sshLog().filter((entry) => entry.alias === "fwdbox")
    expect(calls.every((entry) => entry.resolveOnly)).toBe(true)
    await controller.close()
  }, 60_000)

  let devboxId = ""

  test("hosts.list rows decode with the protocol schema", async () => {
    const { controller, operations } = await make(V1, harness.bundles)
    const added = await controller.addHost({ alias: "devbox" })
    if (!added.ok) throw new Error("add")
    devboxId = added.record.id
    await install(controller, operations, devboxId)
    expect(controller.view(devboxId)!.stage).toBe("ready")
    const list = controller.list()
    for (const row of list.hosts) Schema.decodeUnknownSync(OwnRemote.HostView)(row)
    // Remote DB present so the update's backup step has something to copy.
    const data = path.join(harness.hostHome("devbox"), ".local", "share", "opencode")
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, "opencode-own.db"), "sqlite-fake")
    await controller.close()
  }, 120_000)

  test("local update: the remote still runs the old version → incompatible, no service start (04 §5.7)", async () => {
    const { controller, operations } = await make(V2, bundlesV2)
    await controller.connect(devboxId, { clientId: "tab-1" })
    await controller.settled(devboxId)
    const view = controller.view(devboxId)!
    expect(view).toMatchObject({ stage: "incompatible", error: "version_skew", paused: true })
    expect(view.versions).toMatchObject({ local: V2, remoteRunning: V1, skew: true })
    expect(harness.serviceEvents().filter((entry) => entry.kind === "started").map((entry) => entry.version)).toEqual([V1])
    // No live endpoint for clients while incompatible.
    expect(await controller.resolve(devboxId)).toMatchObject({ url: null, stage: "incompatible" })

    // update.plan sees the running session; execute waits for it (drain), then stops, backs up, switches, starts.
    const port = Number(new URL(String(JSON.parse(fs.readFileSync(path.join(harness.hostHome("devbox"), ".local", "state", "opencode", "service-own.json"), "utf8")).url)).port)
    harness.setActive(port, { ses_busy: { type: "busy" } })
    const plan = await operations.updatePlan(devboxId)
    if (!plan.ok) throw new Error(`update.plan ${plan.error}`)
    expect(plan.output).toMatchObject({ from: V1, to: V2, staged: false, activeSessions: ["ses_busy"] })
    const progress: string[] = []
    const unsubscribe = controller.hub.subscribe((event) => {
      if (event.name === "host.progress") progress.push(`${event.data.op}:${event.data.step}`)
    })
    const started = operations.updateExecute(plan.output.nonce, "wait")
    if (!started.ok) throw new Error("update.execute")
    await until(() => progress.includes("update:draining"), 60_000)
    // Still draining: nothing stopped yet.
    expect(harness.serviceEvents().filter((entry) => entry.kind === "stopped")).toHaveLength(0)
    harness.setActive(port, {})
    await operations.wait(started.output.opId)
    unsubscribe()
    const after = controller.view(devboxId)!
    expect(after).toMatchObject({ stage: "ready", error: null })
    expect(after.versions.remoteRunning).toBe(V2)
    expect(progress).toEqual(expect.arrayContaining(["install:done", "update:stop", "update:start", "update:done"]))
    const own = harness.ownHome("devbox")
    // Read the link the way the remote shell sees it (MSYS junction in the harness, a symlink on Linux).
    const link = spawnSync(Harness.GIT_BASH, ["-c", `readlink '${Harness.toPosix(path.join(own, "app", "current"))}'`], {
      encoding: "utf8",
      env: { MSYS: "winsymlinks:native", PATH: "/usr/bin:/bin" },
      windowsHide: true,
    })
    expect(link.stdout.trim().replace(/\/+$/, "")).toBe(V2)
    const journal = JSON.parse(fs.readFileSync(path.join(own, "ops", `${started.output.opId}.json`), "utf8"))
    expect(journal).toMatchObject({ kind: "update", from: V1, to: V2, state: "done" })
    expect(fs.readdirSync(path.join(own, "backup")).some((name) => name.startsWith(`opencode-own.db.${V1}.`))).toBe(true)
    // The old version stays for rollback (GC keeps current and previous).
    expect(fs.existsSync(path.join(own, "app", V1, ".verified"))).toBe(true)
    const events = harness.serviceEvents()
    expect(events.filter((entry) => entry.kind === "started").map((entry) => entry.version)).toEqual([V1, V2])
    const local = fs.readFileSync(path.join(harness.localHome, "remote", devboxId, "ops.jsonl"), "utf8")
    expect(local).toContain(started.output.opId)
    await controller.close()
  }, 180_000)

  test("the alias now points at another machine → host_identity_changed, nothing written (04 §6.1 step 1)", async () => {
    const { controller } = await make(V2, bundlesV2)
    fs.writeFileSync(path.join(harness.testRoot, "etc", "machine-id"), "fedcba9876543210fedcba9876543210\n")
    const owner = path.join(harness.ownHome("devbox"), "run", "owner.json")
    const before = fs.readFileSync(owner, "utf8")
    await controller.connect(devboxId, { clientId: "tab-1" })
    await controller.settled(devboxId)
    expect(controller.view(devboxId)).toMatchObject({ error: "host_identity_changed", identityChanged: true, paused: true })
    expect(fs.readFileSync(owner, "utf8")).toBe(before)
    await controller.close()
  }, 60_000)

  test("another PC's install → other_owner; owner.takeover makes this PC the owner (04 §6.8)", async () => {
    const { controller, operations } = await make(V2, bundlesV2)
    // Accept the new machine identity (the UI's re-onboarding): the next connect inspects and records it.
    await controller.registry.patchHost(devboxId, { hostIdentity: null })
    const owner = path.join(harness.ownHome("devbox"), "run", "owner.json")
    fs.writeFileSync(owner, JSON.stringify({ installId: "someone-else", hostId: "h-other1", label: "other-pc" }))
    await controller.connect(devboxId, { clientId: "tab-1" })
    await controller.settled(devboxId)
    expect(controller.view(devboxId)).toMatchObject({ error: "other_owner", paused: true, detail: "other-pc" })
    const plan = await operations.ownerPlan(devboxId)
    if (!plan.ok) throw new Error("owner plan")
    expect(plan.output.previous).toEqual({ label: "other-pc" })
    const done = await operations.ownerExecute(plan.output.nonce)
    expect(done.ok && done.output.ok).toBe(true)
    await controller.connect(devboxId, { clientId: "tab-1" })
    await controller.settled(devboxId)
    expect(controller.view(devboxId)!.stage).toBe("ready")
    expect(JSON.parse(fs.readFileSync(owner, "utf8")).installId).toBe(controller.registry.snapshot().installId)
    await controller.close()
    // Two connects, each with the inspect script's login shells over the fake host's Git Bash (64-91 s each on a loaded
    // PC, US6-21): the 2.2.6-own.16 tier passed its 120 s cap; alone the file passed in 418 s, this test well inside.
  }, 240_000)

  test("a service config bound to the LAN stops ensure with service_not_loopback (04 §5.6)", async () => {
    const { controller } = await make(V2, bundlesV2)
    const config = path.join(harness.hostHome("devbox"), ".config", "opencode", "service-own.json")
    const original = fs.readFileSync(config, "utf8")
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(original), hostname: "0.0.0.0" }))
    await controller.connect(devboxId, { clientId: "tab-1" })
    await controller.settled(devboxId)
    expect(controller.view(devboxId)).toMatchObject({ error: "service_not_loopback", paused: true })
    fs.writeFileSync(config, original)
    await controller.close()
  }, 60_000)

  test("drain.plan → execute stops the remote service after its turns end", async () => {
    const { controller, operations } = await make(V2, bundlesV2)
    await controller.connect(devboxId, { clientId: "tab-1" })
    await controller.settled(devboxId)
    expect(controller.view(devboxId)!.stage).toBe("ready")
    const plan = await operations.drainPlan(devboxId)
    if (!plan.ok) throw new Error("drain plan")
    expect(plan.output.activeSessions).toEqual([])
    const started = operations.drainExecute(plan.output.nonce, "wait")
    if (!started.ok) throw new Error("drain execute")
    await operations.wait(started.output.opId)
    expect(controller.view(devboxId)).toMatchObject({ stage: "disconnected", paused: true })
    const stops = harness.serviceEvents().filter((entry) => entry.kind === "stopped")
    expect(stops.at(-1)?.version).toBe(V2)
    await controller.close()
  }, 120_000)

  test("settings that need a restart stay pending until a start applies them (04 §6.4 '설정 대기')", async () => {
    const { controller } = await make(V2, bundlesV2)
    const updated = await controller.updateHost(devboxId, { env: { OWN_TEST_SETTING: "on" }, pathPrepend: ["/opt/own-test/bin"] })
    expect(updated?.pendingSettings).toBe(true)
    // The service was drained above, so this connect's ensure starts it with the new environment.
    await controller.connect(devboxId, { clientId: "tab-1" })
    await controller.settled(devboxId)
    expect(controller.view(devboxId)).toMatchObject({ stage: "ready", pendingSettings: false })
    const env = harness.serviceEvents().filter((entry) => entry.kind === "env").at(-1)!
    expect(env.names).toContain("OWN_TEST_SETTING")
    // The probe ran again because the settings changed (04 §6.1 step 9).
    expect(String((controller.host(devboxId)?.probe as { path?: string } | undefined)?.path)).toContain("/opt/own-test/bin")
    await controller.close()
  }, 120_000)

  test("the three project states: a new host reads instruction files only; each change waits for a restart (04 §5.6)", async () => {
    const { controller, operations } = await make(V2, bundlesV2)
    const projectEnv = () => {
      const env = harness.serviceEvents().filter((entry) => entry.kind === "env").at(-1)!
      return [env.managed.OPENCODE_CONFIG_PROJECT_DISABLE, env.managed.OPENCODE_CONFIG_PROJECT_INSTRUCTIONS]
    }
    const restart = async () => {
      await controller.connect(devboxId, { clientId: "tab-1" })
      await controller.settled(devboxId)
      const plan = await operations.drainPlan(devboxId)
      if (!plan.ok) throw new Error("drain plan")
      const started = operations.drainExecute(plan.output.nonce, "wait")
      if (!started.ok) throw new Error("drain execute")
      await operations.wait(started.output.opId)
      await controller.connect(devboxId, { clientId: "tab-1" })
      await controller.settled(devboxId)
      expect(controller.view(devboxId)).toMatchObject({ stage: "ready", pendingSettings: false })
    }
    // The host was added with the default and its service started with it.
    expect(controller.view(devboxId)!.projectConfig).toBe("instructions")
    expect(projectEnv()).toEqual(["1", "1"])
    for (const [projectConfig, expected] of [
      ["disabled", ["1", null]],
      ["trusted", [null, null]],
      ["instructions", ["1", "1"]],
    ] as const) {
      const updated = await controller.updateHost(devboxId, { projectConfig })
      // Stored at once, applied by the next start: the running service keeps its environment until then.
      expect(updated).toMatchObject({ projectConfig, pendingSettings: true })
      await restart()
      expect(projectEnv()).toEqual([...expected])
    }
    // Setting the applied value again is not a pending change.
    expect((await controller.updateHost(devboxId, { projectConfig: "instructions" }))?.pendingSettings).toBe(false)
    await controller.close()
  }, 240_000)
})
