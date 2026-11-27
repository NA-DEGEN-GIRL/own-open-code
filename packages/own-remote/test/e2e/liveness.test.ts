// A half-dead link (04 §6.3 "죽은 링크", own.15): the fake ssh's link goes silent like a pulled cable (no FIN, no
// RST) and emulates OpenSSH's keepalive with the options own-remote passes. The tunnel must end within ssh's bound,
// the remote service must keep running, the host must come back by itself when the link does, and a wake must probe
// at once without touching a healthy link.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Controller } from "../../src/controller.js"
import { Log } from "../../src/log.js"
import { Operations } from "../../src/operations.js"
import { Broker } from "../../src/protocol/broker.js"
import { RemoteClient } from "../../src/remote/client.js"
import { Liveness } from "../../src/ssh/liveness.js"
import * as Harness from "../harness/remote.js"

const VERSION = "2.0.18-own.9"
const BUILD = "e2e-liveness"
const run = Harness.available ? describe : describe.skip
/** The fake checks its link every 50 ms; the controller sees the exit on its next turn. Room for a loaded PC. */
const SLACK_MS = 3000

async function until<T>(read: () => T | undefined | false, timeoutMs = 30_000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

run("own-remote notices a silent link (04 §6.3)", () => {
  let harness: Harness.Harness
  let broker: ReturnType<typeof Harness.fakeBroker>
  let unprovide: () => void
  let controller: Controller
  let hostId: string
  let operations: Operations
  const lines: Array<Record<string, unknown>> = []

  const view = () => controller.view(hostId)!
  const servicePid = () =>
    Number(
      JSON.parse(
        fs.readFileSync(path.join(harness.hostHome("devbox"), ".local", "state", "opencode", "service-own.json"), "utf8"),
      ).pid,
    )
  const ready = (after: number) => until(() => view().stage === "ready" && view().epoch > after && view(), 120_000)

  beforeAll(async () => {
    harness = Harness.create({ version: VERSION, hosts: { devbox: {} } })
    broker = Harness.fakeBroker()
    unprovide = Broker.provideLocal(BUILD, broker.broker)
    controller = new Controller({
      buildId: BUILD,
      version: VERSION,
      ownHome: harness.localHome,
      log: Log.create({ scope: "liveness", sink: (line) => lines.push(JSON.parse(line)) }),
      options: {
        sshCommand: harness.sshCommand,
        askpassHelper: harness.askpassHelper,
        remoteBundles: harness.bundles,
        sshDir: harness.sshDir,
        keepIntervalSeconds: 1,
        readyTimeoutMs: 20_000,
        backoffMs: [300, 600, 900],
      },
    })
    await controller.start()
    const added = await controller.addHost({ alias: "devbox" })
    if (!added.ok) throw new Error("add")
    hostId = added.record.id
    operations = new Operations(controller)
    await controller.connect(hostId, { clientId: "tab-1" })
    await controller.settled(hostId)
    const plan = await operations.preparePlan(hostId)
    if (!plan.ok) throw new Error(`prepare.plan ${plan.error}`)
    const executed = await operations.prepareExecute(plan.output.nonce)
    if (!executed.ok || !executed.output.ok) throw new Error("prepare.execute failed")
    await controller.connect(hostId, { clientId: "tab-1" })
    await controller.settled(hostId)
    expect(view().stage).toBe("ready")
  }, 240_000)

  afterAll(async () => {
    harness?.setLink("devbox", "up")
    await controller?.close()
    unprovide?.()
    broker?.close()
    await harness?.cleanup()
  }, 60_000)

  test("the tunnel's ssh asks every 4 s and gives up after 2 unanswered checks", () => {
    const tunnel = harness.sshLog().findLast((entry) => entry.command === "sh -s" && entry.locals.length > 0)!
    expect(tunnel.options.serveraliveinterval).toBe(String(Liveness.SERVER_ALIVE_INTERVAL))
    expect(tunnel.options.serveralivecountmax).toBe(String(Liveness.SERVER_ALIVE_COUNT_MAX))
  })

  test("a silent link ends the tunnel within ssh's bound; the host retries past five failures and comes back to the same service", async () => {
    const before = view()
    const pid = servicePid()
    harness.setLink("devbox", "silent")
    const silentAt = Date.now()
    await until(() => view().stage !== "ready", Liveness.SILENT_LIMIT_MS + SLACK_MS + 5000)
    const detectedMs = Date.now() - silentAt
    console.log(`[liveness] silent link noticed after ${detectedMs} ms`)
    // Between the second and the third unanswered check after the last answered one (fake-ssh.ts, measured on the
    // real client: 11.5-11.7 s).
    expect(detectedMs).toBeGreaterThanOrEqual(Liveness.SERVER_ALIVE_COUNT_MAX * Liveness.SERVER_ALIVE_INTERVAL * 1000 - 200)
    expect(detectedMs).toBeLessThanOrEqual(Liveness.SILENT_LIMIT_MS + SLACK_MS)
    expect(lines.some((line) => line.msg === "tunnel_ended" && line.cause === "silent")).toBe(true)
    // The link stays down: every reconnect times out, and the drop window keeps the host retrying past five failures.
    await until(() => harness.sshLog().filter((entry) => entry.command === "sh -s" && entry.locals.length > 0 && entry.at > silentAt).length >= 7, 60_000)
    expect(view().paused).toBe(false)
    harness.setLink("devbox", "up")
    const back = await ready(before.epoch)
    expect(back.paused).toBe(false)
    // Disconnect is not stop (04 §6.2): the same remote service answers through the new tunnel.
    expect(servicePid()).toBe(pid)
    const info = await RemoteClient.info({ url: controller.endpoint(hostId)!.url, secret: controller.endpoint(hostId)!.secret })
    expect(info).toBeDefined()
  }, 180_000)

  test("a short silence that ends before ssh's bound keeps the tunnel; a request sent in it is answered afterwards", async () => {
    const before = view()
    harness.setLink("devbox", "silent")
    const pending = RemoteClient.info(
      { url: controller.endpoint(hostId)!.url, secret: controller.endpoint(hostId)!.secret },
      20_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))
    harness.setLink("devbox", "up")
    expect(await pending).toBeDefined()
    expect(view()).toMatchObject({ stage: "ready", epoch: before.epoch })
  }, 60_000)

  test("after a wake, a healthy link is probed and kept", async () => {
    const before = view()
    const started = Date.now()
    await controller.recheck(hostId)
    expect(Date.now() - started).toBeLessThan(Liveness.PROBE_MS)
    expect(view()).toMatchObject({ stage: "ready", epoch: before.epoch })
  }, 30_000)

  test("after a wake, a silent link ends at once instead of after ssh's bound, and the host comes back", async () => {
    const before = view()
    harness.setLink("devbox", "silent")
    const silentAt = Date.now()
    // The fake reads its link every 50 ms: a probe sent before it saw the change would still cross.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await controller.recheck(hostId)
    await until(() => view().stage !== "ready", 10_000)
    const detectedMs = Date.now() - silentAt
    console.log(`[liveness] wake probe noticed the silent link after ${detectedMs} ms`)
    expect(detectedMs).toBeLessThan(Liveness.PROBE_MS + SLACK_MS)
    expect(lines.some((line) => line.msg === "link_silent")).toBe(true)
    harness.setLink("devbox", "up")
    await ready(before.epoch)
  }, 180_000)

  test("after a silent link and its return, a drain stops the service and a reconnect starts it again", async () => {
    const plan = await operations.drainPlan(hostId)
    if (!plan.ok) throw new Error("drain plan")
    const started = operations.drainExecute(plan.output.nonce, "wait")
    if (!started.ok) throw new Error("drain execute")
    await operations.wait(started.output.opId)
    expect(view()).toMatchObject({ stage: "disconnected", paused: true })
    const before = view().epoch
    await controller.connect(hostId, { clientId: "tab-1" })
    await controller.settled(hostId)
    expect(view().stage).toBe("ready")
    expect(view().epoch).toBeGreaterThanOrEqual(before)
  }, 180_000)
})
