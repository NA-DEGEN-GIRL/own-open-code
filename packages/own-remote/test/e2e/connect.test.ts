import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ServiceTarget } from "@own/runtime"
import { Controller } from "../../src/controller.js"
import { Operations } from "../../src/operations.js"
import { Broker } from "../../src/protocol/broker.js"
import * as Harness from "../harness/remote.js"

const VERSION = "2.0.18-own.9"
const BUILD = "e2e-connect"
const run = Harness.available ? describe : describe.skip

async function until<T>(read: () => T | undefined | false, timeoutMs = 30_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

run("own-remote over the fake-SSH harness: first connection, install, ensure, tunnel, arm", () => {
  let harness: Harness.Harness
  let broker: ReturnType<typeof Harness.fakeBroker>
  let unprovide: () => void
  let controller: Controller
  let operations: Operations
  let hostId: string

  beforeAll(async () => {
    harness = Harness.create({
      version: VERSION,
      hosts: { devbox: { known: false, env: { OPENAI_API_KEY: "sk-test-must-not-reach-the-service" } } },
      deepHome: true,
    })
    broker = Harness.fakeBroker()
    unprovide = Broker.provideLocal(BUILD, broker.broker)
    controller = new Controller({
      buildId: BUILD,
      version: VERSION,
      ownHome: harness.localHome,
      options: {
        sshCommand: harness.sshCommand,
        askpassHelper: harness.askpassHelper,
        remoteBundles: harness.bundles,
        sshDir: harness.sshDir,
        keepIntervalSeconds: 1,
        readyTimeoutMs: 20_000,
        backoffMs: [60_000],
      },
    })
    operations = new Operations(controller)
    await controller.start()
  }, 60_000)

  afterAll(async () => {
    await controller?.close()
    unprovide?.()
    broker?.close()
    await harness?.cleanup()
  }, 60_000)

  test("hosts.add picks a host loopback address and port, remote untouched", async () => {
    const added = await controller.addHost({ alias: "devbox" })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    hostId = added.record.id
    expect(hostId).toMatch(/^h-[a-z0-9]{6,8}$/)
    expect(added.record.loopback).toBeGreaterThanOrEqual(1)
    expect(added.record.localPort).toBeGreaterThanOrEqual(20_000)
    expect(harness.sshLog()).toHaveLength(0)
    const view = controller.view(hostId)!
    expect(view.loopback).toBe(`127.0.${added.record.loopback}.2`)
    expect(view.stage).toBe("disconnected")
  })

  test("an unknown host key in a background attempt pauses without prompting", async () => {
    await controller.connect(hostId, { background: true })
    await controller.settled(hostId)
    const view = controller.view(hostId)!
    expect(view.paused).toBe(true)
    expect(view.error).toBe("host_key")
    expect(view.detail).toBe("unknown")
    const calls = harness.sshLog().filter((entry) => !entry.resolveOnly)
    expect(calls.every((entry) => entry.options.stricthostkeychecking === "yes")).toBe(true)
  }, 60_000)

  test("the host-key flow shows a classified hostKey prompt; only 'trust' answers it", async () => {
    const prompts: Array<Record<string, any>> = []
    const unsubscribe = controller.hub.subscribe((event) => {
      if (event.name === "host.prompt") prompts.push(event.data)
    })
    await controller.connect(hostId, { clientId: "tab-1", hostKeyPrompt: true })
    const prompt = await until(() => prompts[0])
    expect(prompt.kind).toBe("hostKey")
    expect(prompt.fingerprint).toMatch(/^SHA256:/)
    expect(prompt.keyType).toBe("ED25519")
    expect(prompt.ownerClientId).toBe("tab-1")
    // A reloaded owner tab asks for its pending prompt again (heartbeat{replay}); other clients get nothing (RG5).
    expect(controller.heartbeat("tab-2", true)).toBe(0)
    expect(controller.heartbeat("tab-1", true)).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toEqual(prompt)
    // Another tab cannot answer, and a typed "yes" is refused (04 §14.2).
    expect((await controller.respond(hostId, prompt.promptId, "tab-2", "trust")).ok).toBe(false)
    expect((await controller.respond(hostId, prompt.promptId, "tab-1", "yes")).ok).toBe(false)
    expect((await controller.respond(hostId, prompt.promptId, "tab-1", "trust")).ok).toBe(true)
    await controller.settled(hostId)
    unsubscribe()
    const view = controller.view(hostId)!
    // First contact: inspect ran, nothing installed yet.
    expect(view.stage).toBe("needs_install")
    expect(view.platform?.target).toBe("linux-x64-baseline")
    expect(view.hostIdentity).toMatch(/^sha256:[0-9a-f]{64}$/)
    const inspect = harness.sshLog().find((entry) => entry.command === "sh -s" && entry.options.clearallforwardings === "yes")
    expect(inspect).toBeDefined()
  }, 90_000)

  test("prepare.plan → execute uploads the bundle and verifies it without root", async () => {
    const plan = await operations.preparePlan(hostId)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.output.install.version).toBe(VERSION)
    expect(plan.output.root).toBe(false)
    expect(plan.output.install.dir.endsWith(`/own-open-code/app/${VERSION}`)).toBe(true)
    const executed = await operations.prepareExecute(plan.output.nonce)
    expect(executed.ok).toBe(true)
    if (!executed.ok) return
    expect(executed.output.ok).toBe(true)
    const app = path.join(harness.ownHome("devbox"), "app", VERSION)
    expect(fs.existsSync(path.join(app, ".verified"))).toBe(true)
    expect(fs.existsSync(path.join(app, "libexec", "start.sh"))).toBe(true)
    // A nonce is single use.
    const again = await operations.prepareExecute(plan.output.nonce)
    expect(again.ok).toBe(false)
  }, 90_000)

  test("connect: tunnel + ensure start the service; -L on 127.0.k.2; -R stream socket; arm reaches the broker", async () => {
    await controller.connect(hostId, { clientId: "tab-1" })
    await controller.settled(hostId)
    const view = controller.view(hostId)!
    expect(view.stage).toBe("ready")
    expect(view.versions.remoteRunning).toBe(VERSION)
    const tunnel = harness.sshLog().findLast((entry) => entry.locals.length > 0)!
    expect(tunnel.command).toBe("sh -s")
    expect(tunnel.options.exitonforwardfailure).toBe("yes")
    expect(tunnel.options.stricthostkeychecking).toBe("yes")
    expect(tunnel.options.clearallforwardings).toBeUndefined()
    expect(tunnel.locals[0]).toMatch(/^127\.0\.\d+\.2:\d+:127\.0\.0\.1:\d+$/)
    expect(tunnel.locals[0].startsWith("127.0.0.1:")).toBe(false)
    // The temp HOME is deep, so a socket path under run/ would pass 100 bytes: the short /tmp directory is used
    // (04 §7.4), created by a one-off `mkdir -m 700` after the first -R bind failed.
    const socketDir = controller.record(hostId)!.remote!.socketDir
    expect(socketDir).toMatch(/^\/tmp\/own-\d+\/[0-9a-f]{8}$/)
    expect(tunnel.remotes[0].startsWith(`${socketDir}/broker-`)).toBe(true)
    expect(tunnel.remotes[0]).toMatch(/\/broker-\d+\.sock:127\.0\.0\.1:\d+$/)
    expect(controller.record(hostId)!.broker.mode).toBe("socket")
    // The remote broker client connected back through -R with the armed key (hello/challenge/auth).
    await until(() => broker.log.find((entry) => entry.event === "connected" && entry.hostId === hostId))
    const epoch = Number(fs.readFileSync(path.join(harness.ownHome("devbox"), "run", "broker.current"), "utf8"))
    expect(epoch).toBe(view.epoch)
    // env hygiene: the provider key exported by the login environment never reaches the service (04 §5.6).
    const env = harness.serviceEvents().find((entry) => entry.kind === "env")!
    expect(env.names).not.toContain("OPENAI_API_KEY")
    expect(env.managed.OWN_REMOTE).toBe("1")
    // A new host reads the repository's instruction files only (04 §5.6): project config off, instructions on.
    expect(env.managed.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1")
    expect(env.managed.OPENCODE_CONFIG_PROJECT_INSTRUCTIONS).toBe("1")
    expect(String(env.managed.TMPDIR)).toContain("own-open-code")
    // Managed config and service settings (04 §5.6), 0600-style temp → rename writes.
    const managed = JSON.parse(
      fs.readFileSync(path.join(harness.hostHome("devbox"), ".config", "own-open-code", "opencode.json"), "utf8"),
    )
    expect(managed.plugins[0].options).toEqual({ mode: "remote", home: expect.stringContaining("own-open-code") })
    expect(managed.plugins[1].options.mode).toBe("agent")
    expect(managed.share).toBe("disabled")
    const service = JSON.parse(
      fs.readFileSync(path.join(harness.hostHome("devbox"), ".config", "opencode", "service-own.json"), "utf8"),
    )
    expect(service.hostname).toBe("127.0.0.1")
    expect(service.password).toMatch(/^[A-Za-z0-9_-]+$/)
    // ensure keeps the harness's free port, never the channel default the installed own service holds.
    expect(service.port).toBe(harness.servicePort("devbox"))
    expect(harness.registeredPort("devbox")).toBe(harness.servicePort("devbox"))
  }, 120_000)

  test("resolve returns a short token the remote server accepts; the password is never returned", async () => {
    const resolved = await controller.resolve(hostId)
    expect(resolved && resolved.url !== null).toBe(true)
    if (!resolved || resolved.url === null) return
    expect(resolved.url).toMatch(/^http:\/\/127\.0\.\d+\.2:\d+$/)
    expect(resolved.controlDir.endsWith("/own-open-code/control")).toBe(true)
    expect(JSON.stringify(resolved)).not.toContain(
      JSON.parse(fs.readFileSync(path.join(harness.hostHome("devbox"), ".config", "opencode", "service-own.json"), "utf8"))
        .password,
    )
    const ttl = resolved.tokenExpiresAt - Date.now()
    expect(ttl).toBeGreaterThan(11 * 3600_000)
    expect(ttl).toBeLessThanOrEqual(12 * 3600_000)
    const response = await fetch(new URL("/api/info", resolved.url), {
      headers: { authorization: ServiceTarget.basic(resolved.token) },
    })
    expect(response.status).toBe(200)
    const forged = await fetch(new URL("/api/info", resolved.url), {
      headers: { authorization: ServiceTarget.basic(`${Math.floor(Date.now() / 1000) + 60}.forged`) },
    })
    expect(forged.status).toBe(401)
  }, 30_000)

  test("agent RPC goes to the remote control location; the probe ran once", async () => {
    const rpc = harness.serviceEvents().filter((entry) => entry.kind === "rpc")
    expect(rpc.map((entry) => entry.method)).toEqual(expect.arrayContaining(["agent.broker.arm", "agent.probe"]))
    expect(rpc.every((entry) => String(entry.location).endsWith("/own-open-code/control"))).toBe(true)
    expect(controller.host(hostId)?.probe).toMatchObject({ found: expect.any(Object) })
    const arms = harness.serviceEvents().filter((entry) => entry.kind === "arm")
    expect(arms.at(-1)?.keyBytes).toBe(32)
    // The key is never written on the remote: nothing under the remote home contains it.
    const key = broker.keys.get(hostId)!.key.toString("base64url")
    const hits: string[] = []
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) scan(file)
        else if (entry.isFile() && fs.readFileSync(file).includes(key)) hits.push(file)
      }
    }
    scan(harness.hostHome("devbox"))
    scan(harness.testRoot)
    expect(hits).toEqual([])
  })

  test("a dropped tunnel reconnects with one ssh, a new epoch, and inspect skipped", async () => {
    const before = controller.view(hostId)!
    const calls = harness.sshLog().length
    // Kill the ssh process (like a network drop): the keep part ends on EOF, the service keeps running (04 §6.2).
    const pid = controller.host(hostId)!.live!.tunnel.pid!
    process.kill(pid)
    await until(() => controller.view(hostId)?.stage !== "ready" && true, 10_000)
    await controller.connect(hostId, { clientId: "tab-1" })
    await controller.settled(hostId)
    const after = controller.view(hostId)!
    expect(after.stage).toBe("ready")
    expect(after.epoch).toBeGreaterThan(before.epoch)
    const newCalls = harness.sshLog().slice(calls).filter((entry) => !entry.resolveOnly)
    expect(newCalls).toHaveLength(1)
    expect(newCalls[0]!.locals).toHaveLength(1)
    // Same service (no restart): only one "started" event so far.
    expect(harness.serviceEvents().filter((entry) => entry.kind === "started")).toHaveLength(1)
    await until(() => broker.log.filter((entry) => entry.event === "connected" && entry.epoch === after.epoch).length > 0)
  }, 90_000)

  test("the old session ends by itself once broker.current moves on, and removes only its own socket", async () => {
    const run = path.join(harness.ownHome("devbox"), "run")
    const epoch = controller.view(hostId)!.epoch
    const own = path.join(Harness.toWindows(controller.record(hostId)!.remote!.socketDir), `broker-${epoch}.sock`)
    expect(fs.existsSync(own)).toBe(true)
    // Bump broker.current as a newer session would; the keep part (1 s interval here) exits and removes its socket.
    fs.writeFileSync(path.join(run, "broker.current"), `${epoch + 1000}\n`)
    await until(() => !fs.existsSync(own) && controller.view(hostId)?.stage !== "ready" && true, 20_000)
    expect(controller.view(hostId)!.detail).toBe("superseded")
    expect(controller.view(hostId)!.paused).toBe(true)
  }, 60_000)

  test("a stale epoch on the remote is answered with a higher epoch; disconnect leaves the service running", async () => {
    // broker.current is 1000 above our last epoch (previous test): ensure reports stale_epoch, own-remote retries above it.
    await controller.connect(hostId, { clientId: "tab-1" })
    await controller.settled(hostId)
    expect(controller.view(hostId)!.stage).toBe("ready")
    const port = Number(new URL(controller.host(hostId)!.live!.url).port)
    await controller.disconnect(hostId)
    expect(controller.view(hostId)!.stage).toBe("disconnected")
    // The service still answers on its remote port (the harness runs it locally).
    const reg = JSON.parse(fs.readFileSync(path.join(harness.hostHome("devbox"), ".local", "state", "opencode", "service-own.json"), "utf8"))
    const response = await fetch(new URL("/api/info", reg.url), { headers: { authorization: ServiceTarget.basic(reg.password) } })
    expect(response.status).toBe(200)
    expect(port).toBeGreaterThan(0)
  }, 90_000)
})
