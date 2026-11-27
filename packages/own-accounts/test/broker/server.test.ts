// B3 (04 §8.11, T6): the local broker with its Claude egress relay, as BrokerHost runs it (real slots and telemetry
// modules on a temp OWN_HOME, the plugins module's Claude facts stubbed, the fake claude-auth shim, a fake upstream on
// loopback, a hand-rolled host). `listen` opens both listeners; a new epoch refuses older proofs; a verdict change
// aborts the host's relayed requests and announces the view; drain mode does not change what the relay does; the
// relay's failed proofs never touch the broker's handshake bucket; nothing calls `connection.resolve`. Fake tokens.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { Broker, type Registry } from "@own/protocol"
import { CreatorBridge } from "@own/runtime"
import { BrokerHost } from "../../src/broker/host.js"
import { Server } from "../../src/broker/server.js"
import { Wire } from "../../src/broker/wire.js"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { memoryStorage, registryWith } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { writeFakeClaudeAuth, type FakeState } from "../support/fake-claude-auth.js"

const HOST = "h-server1"
const TOKEN = "sk-ant-oat01-ownServerFakeToken000000001"
const decodeView = Schema.decodeUnknownSync(Broker.MirrorView)

const state = {} as {
  root: string
  t: Awaited<ReturnType<typeof testDeps>>
  modules: Modules.All
  detach: () => Promise<void>
  server: Server.LocalBroker
  ports: { readonly port: number; readonly egressPort?: number }
  key: { epoch: number; key: Uint8Array }
  fake: FakeState
  facts: Plugins.ClaudeRemote
  slot: Plugins.ClaudeSlot
  resolved: number
  logs: string[]
  upstream: { url: string; aborted: number; seen: number; stop(): void }
  counter: number
}

function proof(n = ++state.counter, key = state.key) {
  const mac = createHmac("sha256", key.key)
    .update(Broker.egressMacInput({ hostId: HOST, epoch: key.epoch, n, accountID: "acc_claude_slot" }))
    .digest("hex")
  return Broker.egressHeader({ epoch: key.epoch, n, accountID: "acc_claude_slot", mac })
}

function relay(init: { readonly proof?: string; readonly signal?: AbortSignal } = {}) {
  return fetch(`http://127.0.0.1:${state.ports.egressPort}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", [Broker.EGRESS_HEADER]: init.proof ?? proof() },
    body: JSON.stringify({ model: "claude-fake", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
    signal: init.signal,
  })
}

/** A streaming upstream: one event, then holds the stream open until the request ends. */
function startUpstream() {
  const counts = { aborted: 0, seen: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (request) => {
      counts.seen++
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\n'))
            request.signal.addEventListener("abort", () => {
              counts.aborted++
            })
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    get aborted() {
      return counts.aborted
    },
    get seen() {
      return counts.seen
    },
    stop: () => void server.stop(true),
  }
}

async function switchHosts(remoteHosts: ReadonlyArray<string>) {
  const runtime = state.t.deps.runtime
  const current = await runtime.registry.read()
  const written = await runtime.registry.write({
    ...current,
    claudeSlot: { accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "orange", remoteHosts: [...remoteHosts] },
  })
  runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local", revision: written.revision })
}

beforeAll(async () => {
  state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-broker-claude-")))
  const shim = writeFakeClaudeAuth(path.join(state.root, "claude-auth"))
  await import(shim.entry)
  state.fake = ((await import(shim.module)) as { fake: FakeState }).fake
  state.fake.account = { source: "fake", token: TOKEN }
  state.fake.stored = TOKEN
  state.upstream = startUpstream()
  state.counter = 0
  state.resolved = 0
  state.logs = []
  state.facts = { ready: true, billing: false, acknowledged: true, fast: false, entry: shim.entry }
  state.slot = { detected: true, verified: true, version: "0.0.0-fake.1", integrity: "sha512-ZmFrZQ==" }
  state.t = await testDeps({
    logs: state.logs,
    ctx: {
      app: { version: "local" },
      provider: { reload: async () => {}, list: async () => [] },
      storage: memoryStorage().storage,
      integration: {
        connection: {
          active: async () => undefined,
          resolve: async () => {
            state.resolved++
            return undefined
          },
        },
      },
    },
    options: { broker: { claudeUpstream: state.upstream.url } },
  })
  const runtime = state.t.deps.runtime
  await runtime.registry.write({
    ...(await registryWith([{ kind: "oai", label: "Key", slug: "keya" }])),
    claudeSlot: { accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "orange", remoteHosts: [HOST] },
  } satisfies Registry.File)
  state.modules = state.t.modules({
    plugins: (deps, peers) => ({
      ...Modules.FACTORIES.plugins(deps, peers),
      claudeSlot: () => state.slot,
      claudeRemote: () => state.facts,
      refreshed: async () => {},
    }),
  })
  await state.modules.slots.start()
  state.detach = BrokerHost.attach(state.t.deps, state.modules)
  state.server = BrokerHost.peek(runtime.buildId)!
  state.ports = await state.server.listen(HOST)
  state.key = { epoch: 1, key: randomBytes(32) }
  state.server.setKey(HOST, state.key)
  state.server.configure(HOST, { accounts: { mode: "all" }, leaseSeconds: 900, failClosedGraceSeconds: 2 })
}, 30_000)

afterAll(async () => {
  await state.detach?.()
  await state.modules?.slots.stop()
  state.upstream?.stop()
  await state.t?.[Symbol.asyncDispose]()
  fs.rmSync(state.root, { recursive: true, force: true })
  // Nothing the broker or the relay did resolved a credential, and no fake token reached a log line.
  expect(state.resolved).toBe(0)
  expect(state.logs.join("\n")).not.toContain(TOKEN)
}, 30_000)

describe("the broker's Claude egress relay (04 §8.11)", () => {
  test("listen opens the broker and the relay listeners; the status carries the relay", async () => {
    expect(state.ports.egressPort).toBeNumber()
    expect(state.ports.egressPort).not.toBe(state.ports.port)
    // Idempotent: the same two ports.
    expect(await state.server.listen(HOST)).toEqual(state.ports)
    expect(state.server.status(HOST).claude).toEqual({ state: "enabled", inflight: 0, lastError: null, holdUntil: null })
    const response = await relay()
    expect(response.status).toBe(200)
    expect(response.headers.get(Broker.EGRESS_HEADER)).toBe("1")
    await response.body?.cancel()
  })

  test("a new epoch key refuses the older epoch's proofs", async () => {
    const old = state.key
    state.key = { epoch: 2, key: randomBytes(32) }
    state.server.setKey(HOST, state.key)
    const refused = await relay({ proof: proof(++state.counter, old) })
    expect(refused.status).toBe(401)
    expect(refused.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("mac")
    const fresh = await relay()
    expect(fresh.status).toBe(200)
    await fresh.body?.cancel()
  })

  test("failed relay proofs leave the broker's handshake bucket alone", async () => {
    for (let index = 0; index < Broker.EGRESS_MAC_FAILURES_PER_MINUTE + 3; index++)
      expect((await relay({ proof: "v1.2.1.00" })).status).toBe(401)
    const channel = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId)
    expect(state.server.status(HOST).state).toBe("connected")
    channel.close()
  })

  test("switching the host off aborts its relayed stream and announces the view; on again, it relays", async () => {
    // The relay's failure bucket of the test above is for this minute.
    state.t.clock.advance(61_000)
    const channel = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId)
    const frames: unknown[] = []
    channel.onFrame((frame) => void frames.push(frame))
    const before = state.upstream.aborted
    const streaming = await relay()
    expect(streaming.status).toBe(200)
    const reader = streaming.body!.getReader()
    await reader.read()
    expect(state.server.status(HOST).claude?.inflight).toBe(1)
    await switchHosts([])
    await until(() => state.upstream.aborted > before)
    await until(() => frames.some((frame) => isPush(frame, "mirror.changed")))
    expect(state.server.status(HOST).claude).toMatchObject({ state: "off", inflight: 0 })
    const off = await relay()
    expect(off.status).toBe(403)
    expect(off.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("off")
    const view = await registryGet(channel)
    expect(view.claude).toMatchObject({ state: "off", fast: false })
    expect(JSON.stringify(view)).not.toContain("remoteHosts")
    await switchHosts([HOST])
    await until(() => state.server.status(HOST).claude?.state === "enabled")
    const on = await relay()
    expect(on.status).toBe(200)
    await on.body?.cancel()
    channel.close()
  })

  test("a consent or Fast change is judged again and announced (claudeSlot.changed)", async () => {
    const channel = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId)
    const frames: unknown[] = []
    channel.onFrame((frame) => void frames.push(frame))
    state.facts = { ...state.facts, acknowledged: false }
    state.t.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "remote" })
    await until(() => frames.some((frame) => isPush(frame, "mirror.changed")))
    expect(state.server.status(HOST).claude?.state).toBe("consent")
    expect((await relay()).headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("consent")
    frames.length = 0
    state.facts = { ...state.facts, acknowledged: true, fast: true }
    state.t.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "fast" })
    await until(() => frames.some((frame) => isPush(frame, "mirror.changed")))
    expect((await registryGet(channel)).claude).toMatchObject({ state: "enabled", fast: true })
    // The host's account scope without the slot: host_scope.
    state.server.configure(HOST, { accounts: { mode: "only", ids: ["acc_keya"] }, leaseSeconds: 900, failClosedGraceSeconds: 2 })
    expect(state.server.status(HOST).claude?.state).toBe("host_scope")
    state.server.configure(HOST, { accounts: { mode: "all" }, leaseSeconds: 900, failClosedGraceSeconds: 2 })
    // Without the slot on this PC the view and the status have no `claude` at all.
    state.slot = { ...state.slot, detected: false }
    expect(state.server.status(HOST).claude).toBeUndefined()
    expect((await registryGet(channel)).claude).toBeUndefined()
    state.slot = { ...state.slot, detected: true }
    channel.close()
  })

  test("drain mode does not change what the relay does: it follows the verdict", async () => {
    const channel = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId, "older-build")
    expect(state.server.status(HOST).mode).toBe("drain")
    const allowed = await relay()
    expect(allowed.status).toBe(200)
    await allowed.body?.cancel()
    state.facts = { ...state.facts, billing: true }
    state.t.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "connection" })
    await until(() => state.server.status(HOST).claude?.state === "billing")
    expect((await relay()).headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("billing")
    state.facts = { ...state.facts, billing: false }
    state.t.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "connection" })
    channel.close()
  })
})

describe("own.creator's store on the hosts, read only (17 §10)", () => {
  const view = {
    revision: "rev-1",
    plugins: false,
    extensions: [
      {
        id: "house",
        kind: "declarative" as const,
        version: { n: 1, hash: "a".repeat(64), createdAt: 1, by: "user" as const },
        files: [{ path: "extension.json", size: 5 }],
        projects: [],
        loosen: false,
        hostTrusted: false,
      },
    ],
  }
  const seen: string[] = []

  test("creator.get and creator.file answer from the PC's source; a report stays in memory; changes are pushed", async () => {
    const undo = CreatorBridge.provideSource({
      view: async (hostId) => {
        seen.push(`view:${hostId}`)
        return view
      },
      file: async (hostId, request) => {
        seen.push(`file:${hostId}:${request.path}:${request.offset}`)
        return request.path === "extension.json" ? { data: Buffer.from("hello").toString("base64"), size: 5, end: true } : undefined
      },
    })
    try {
      const channel = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId)
      const frames: unknown[] = []
      channel.onFrame((frame) => void frames.push(frame))
      const got = await request(channel, frames, "creator.get", {})
      expect(got).toEqual({ ok: true, result: { view } })
      const chunk = await request(channel, frames, "creator.file", { id: "house", n: 1, path: "extension.json", offset: 0 })
      expect(chunk).toEqual({ ok: true, result: { data: Buffer.from("hello").toString("base64"), size: 5, end: true } })
      // Not a file of the view: refused.
      expect(await request(channel, frames, "creator.file", { id: "house", n: 1, path: "store.json", offset: 0 })).toEqual({
        ok: false,
        error: "invalid",
      })
      expect(seen).toEqual([`view:${HOST}`, `file:${HOST}:extension.json:0`, `file:${HOST}:store.json:0`])
      const report = { revision: "rev-1", at: 5, extensions: [{ id: "house", n: 1, status: "active" as const, problems: [] }] }
      expect(await request(channel, frames, "creator.report", report)).toEqual({ ok: true, result: { ok: true } })
      // Kept with this PC's time of arrival (the broker's clock), not the host's claim.
      expect(CreatorBridge.reports().get(HOST)).toEqual({ ...report, at: expect.any(Number) })
      expect(CreatorBridge.reports().get(HOST)!.at).not.toBe(5)
      // The broker's hosts reach Settings through the bridge.
      expect(CreatorBridge.hosts()).toContainEqual({ id: HOST, connected: true })
      // A store change reaches the host as `creator.changed` (coalesced). Counted from here: providing the source
      // above announced a change too, which reached this session only if it connected within the coalescing window.
      const pushes = () => frames.filter((frame) => isPush(frame, "creator.changed")).length
      await Bun.sleep(200)
      const before = pushes()
      CreatorBridge.changed()
      CreatorBridge.changed()
      await until(() => pushes() > before)
      await Bun.sleep(200)
      expect(pushes()).toBe(before + 1)
      // There is no way to write: an unknown method is no request at all, and the session ends.
      const closed = new Promise<void>((resolve) => channel.onClose(() => resolve()))
      channel.send({ type: "req", id: 99, method: "creator.put", params: { id: "house" } })
      await closed
    } finally {
      undo()
    }
  })

  test("a host cannot make this PC buffer file chunks without bound: a few in flight, the rest refused", async () => {
    const gate = Promise.withResolvers<void>()
    let started = 0
    const undo = CreatorBridge.provideSource({
      view: async () => view,
      file: async () => {
        started++
        await gate.promise
        return { data: Buffer.from("hello").toString("base64"), size: 5, end: true }
      },
    })
    try {
      const channel = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId)
      const frames: unknown[] = []
      channel.onFrame((frame) => void frames.push(frame))
      const replies = Array.from({ length: 20 }, () =>
        request(channel, frames, "creator.file", { id: "house", n: 1, path: "extension.json", offset: 0 }),
      )
      const refused = () =>
        frames.filter((frame) => typeof frame === "object" && frame !== null && "error" in frame && frame.error === "invalid")
      await until(() => refused().length >= 20 - Server.CREATOR_FILES_IN_FLIGHT)
      expect(started).toBe(Server.CREATOR_FILES_IN_FLIGHT)
      gate.resolve()
      const answered = await Promise.all(replies)
      expect(answered.filter((reply) => reply.ok === true)).toHaveLength(Server.CREATOR_FILES_IN_FLIGHT)
      expect(answered.filter((reply) => reply.ok === false && reply.error === "invalid")).toHaveLength(20 - Server.CREATOR_FILES_IN_FLIGHT)
      // Once those are answered, the next request is served again.
      expect(await request(channel, frames, "creator.file", { id: "house", n: 1, path: "extension.json", offset: 0 })).toMatchObject({
        ok: true,
      })
      channel.close()
    } finally {
      undo()
    }
  })

  test("a drain-mode host (another build) gets none of it; without own.creator here the view is absent", async () => {
    const channel = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId, "older-build")
    const frames: unknown[] = []
    channel.onFrame((frame) => void frames.push(frame))
    expect(await request(channel, frames, "creator.get", {})).toEqual({ ok: false, error: "skew_drain" })
    channel.close()
    const normal = await connect(state.ports.port, state.key, state.t.deps.runtime.buildId)
    const more: unknown[] = []
    normal.onFrame((frame) => void more.push(frame))
    expect(await request(normal, more, "creator.get", {})).toEqual({ ok: true, result: {} })
    normal.close()
  })
})

async function request(channel: Wire.Channel, frames: unknown[], method: string, params: unknown) {
  const id = Math.floor(Math.random() * 1_000_000) + 1
  channel.send({ type: "req", id, method, params })
  const reply = await until(() =>
    frames.find((frame) => typeof frame === "object" && frame !== null && "id" in frame && frame.id === id),
  )
  const { type: _, id: __, ...rest } = reply as Record<string, unknown>
  return rest
}

async function registryGet(channel: Wire.Channel) {
  const id = Math.floor(Math.random() * 1_000_000) + 1
  const frames: unknown[] = []
  const off = channel.onFrame((frame) => void frames.push(frame))
  channel.send({ type: "req", id, method: "registry.get", params: { since: null } })
  const reply = await until(() =>
    frames.find((frame) => typeof frame === "object" && frame !== null && "id" in frame && frame.id === id),
  )
  off()
  return decodeView((reply as { readonly result: unknown }).result)
}

/** A hand-rolled host: hello, auth, `ready` (normal mode for this build, drain for `version`). */
async function connect(port: number, key: { epoch: number; key: Uint8Array }, buildId: string, version = "local") {
  const socket = net.connect({ host: "127.0.0.1", port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  const channel = new Wire.Channel(socket)
  const nonceR = Wire.nonce()
  channel.send({
    type: "hello",
    proto: Broker.PROTO,
    hostId: HOST,
    epoch: key.epoch,
    nonceR,
    version,
    buildId,
    mirrorSchemaVersion: Broker.MIRROR_SCHEMA_VERSION,
    streamId: "0123456789abcdef",
  })
  const challenge = (await channel.next(5_000)) as Broker.Challenge
  channel.send({ type: "auth", mac: Wire.mac(key.key, "R", { hostId: HOST, epoch: key.epoch, nonceR, nonceL: challenge.nonceL }) })
  expect(await channel.next(5_000)).toMatchObject({ type: "ready", mode: version === "local" ? "normal" : "drain" })
  return channel
}

function isPush(frame: unknown, event: string) {
  return typeof frame === "object" && frame !== null && "type" in frame && frame.type === "push" && "event" in frame && frame.event === event
}

async function until<T>(read: () => T | undefined | false, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error("timeout")
    await Bun.sleep(20)
  }
}
