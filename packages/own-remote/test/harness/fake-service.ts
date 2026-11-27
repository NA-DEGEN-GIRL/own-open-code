#!/usr/bin/env bun
/**
 * Fake remote own-channel `opencode` for the fake-SSH harness. The bundle's `opencode` is a small sh launcher
 * (see {@link launcher}) that delegates here. Subcommands:
 *   start --version V        like `opencode service start`: reads the service config, spawns `serve` detached,
 *                            waits for the registration file (0600 JSON {url,password,version,pid})
 *   serve …                  the "service": /api/info, /api/session/active, own.remote agent.* RPC, /fake/shutdown
 *   stop / status            like `opencode service stop|status`
 *
 * Agent RPC goes through the real `Handlers.agent` of own-remote with a fake remote broker client that performs the
 * broker handshake of 04 §8.3 over the armed endpoint, so a test proves the key armed remotely is the key the local
 * broker holds, through the tunnel's -R forward. The client never writes the key anywhere.
 */
import { spawn } from "node:child_process"
import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { ServiceTarget } from "@own/runtime"
import { Broker } from "../../src/protocol/broker.js"
import { Handlers } from "../../src/rpc/handlers.js"

function win(value: string | undefined) {
  if (!value) return value
  if (value === "/tmp" || value.startsWith("/tmp/")) return path.join(os.tmpdir(), ...value.slice(5).split("/").filter(Boolean))
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(value)
  return match ? `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll("/", "\\")}` : value
}

const args = process.argv.slice(2)
const sub = args[0]
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const version = flag("version") ?? "0.0.0"
const home = win(process.env.HOME) ?? ""
const stateDir = path.join(win(process.env.XDG_STATE_HOME) ?? path.join(home, ".local", "state"), "opencode")
const configDir = path.join(win(process.env.XDG_CONFIG_HOME) ?? path.join(home, ".config"), "opencode")
const registration = path.join(stateDir, "service-own.json")
const serviceConfig = path.join(configDir, "service-own.json")
const testRoot = win(process.env.OWN_REMOTE_TEST_ROOT) ?? ""
const blockedPorts = (process.env.OWN_FAKE_BLOCKED_PORTS ?? "").split(",").filter(Boolean).map(Number)
/** A blocked port or one another process holds: recorded for `Harness.cleanup()`, which fails the run on any. */
const collision = (entry: Record<string, unknown>) =>
  fs.appendFileSync(
    path.join(testRoot, "collisions.jsonl"),
    JSON.stringify({ at: Date.now(), source: "fake-service", pid: process.pid, ...entry }) + "\n",
  )

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

if (sub === "status") {
  const reg = readJson(registration)
  process.stdout.write(`${reg && typeof reg.pid === "number" && alive(reg.pid) ? String(reg.url) : "stopped"}\n`)
  process.exit(0)
}

if (sub === "stop") {
  const reg = readJson(registration)
  if (reg && typeof reg.pid === "number" && alive(reg.pid)) {
    await fetch(new URL("/fake/shutdown", String(reg.url)), {
      method: "POST",
      headers: { authorization: ServiceTarget.basic(String(reg.password)) },
    }).catch(() => {})
    for (let i = 0; i < 100 && alive(reg.pid); i++) await sleep(50)
    if (alive(reg.pid)) process.kill(reg.pid)
  }
  fs.rmSync(registration, { force: true })
  process.exit(0)
}

if (sub === "start") {
  const config = readJson(serviceConfig) ?? {}
  const existing = readJson(registration)
  if (existing && typeof existing.pid === "number" && alive(existing.pid) && existing.version === version) process.exit(0)
  let password = typeof config.password === "string" ? config.password : undefined
  if (!password) {
    password = randomBytes(24).toString("base64url")
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(serviceConfig, JSON.stringify({ ...config, password }, null, 2), { mode: 0o600 })
  }
  const port = typeof config.port === "number" ? config.port : 0
  // The harness seeds a free port; the blocked one is the developer's installed own service's.
  if (blockedPorts.includes(port)) {
    collision({ port, detail: "the service config names the blocked port" })
    process.stderr.write(`fake service: refusing the blocked port ${port} (the installed own service may hold it)\n`)
    process.exit(1)
  }
  // upstream: the service is spawned detached with {...process.env, ...config.env} (service-contender.ts).
  const env = { ...process.env, ...((config.env as Record<string, string>) ?? {}) }
  fs.rmSync(registration, { force: true })
  const child = spawn(process.execPath, [import.meta.path, "serve", "--version", version, "--port", String(port)], {
    env: { ...env, OWN_FAKE_PASSWORD: password },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(registration)) process.exit(0)
    await sleep(50)
  }
  process.stderr.write("fake service did not register\n")
  process.exit(1)
}

if (sub !== "serve") {
  process.stderr.write(`fake opencode: unknown command ${args.join(" ")}\n`)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------------------------
// serve

const password = process.env.OWN_FAKE_PASSWORD ?? ""
delete process.env.OWN_FAKE_PASSWORD
const port = Number(flag("port") ?? "0")
const events = path.join(testRoot, "service-events.jsonl")
const record = (entry: Record<string, unknown>) =>
  fs.appendFileSync(events, JSON.stringify({ at: Date.now(), pid: process.pid, home, version, ...entry }) + "\n")

function authorized(request: Request) {
  const header = request.headers.get("authorization") ?? ""
  if (!header.startsWith("Basic ")) return false
  const [user, secret] = Buffer.from(header.slice(6), "base64").toString().split(/:(.*)/s)
  if (user !== "opencode" || secret === undefined) return false
  if (secret === password) return true
  // upstream `verifySession` (packages/server/src/auth.ts:47-56)
  const parts = secret.split(".")
  const expires = Number(parts[0])
  if (parts.length !== 2 || !Number.isSafeInteger(expires) || expires * 1000 <= Date.now()) return false
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  return createHmac("sha256", key).update(parts[0]!).digest("base64url") === parts[1]
}

// Environment the service sees (04 §5.6 env hygiene checks): names and a few managed values, never values of others.
record({
  kind: "env",
  names: Object.keys(process.env).sort(),
  managed: {
    OWN_REMOTE: process.env.OWN_REMOTE ?? null,
    OWN_OPEN_CODE: process.env.OWN_OPEN_CODE ?? null,
    OPENCODE_CONFIG_PROJECT_DISABLE: process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? null,
    OPENCODE_CONFIG_PROJECT_INSTRUCTIONS: process.env.OPENCODE_CONFIG_PROJECT_INSTRUCTIONS ?? null,
    TMPDIR: process.env.TMPDIR ?? null,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR ?? null,
  },
})

// Fake remote broker client: the handshake of 04 §8.3 over the armed endpoint. Keeps K in this closure only.
const client = (() => {
  const state: { epoch: number | null; state: "unarmed" | "connecting" | "connected" } = { epoch: null, state: "unarmed" }
  let current: { epoch: number; key: Uint8Array } | undefined
  const connect = (endpoint: Broker.Endpoint, hostId: string, epoch: number, key: Uint8Array) => {
    const target =
      "socket" in endpoint
        ? (JSON.parse(fs.readFileSync(win(endpoint.socket)!, "utf8")) as { tcp: number }).tcp
        : endpoint.tcpPort
    state.state = "connecting"
    const socket = net.connect({ host: "127.0.0.1", port: target })
    const nonceR = randomBytes(16).toString("hex")
    let buffer = Buffer.alloc(0)
    const send = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value))
      const head = Buffer.alloc(4)
      head.writeUInt32BE(body.length)
      socket.write(Buffer.concat([head, body]))
    }
    socket.on("connect", () => send({ type: "hello", proto: Broker.PROTO, hostId, epoch, nonceR, version, buildId: "fake" }))
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const frame = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString()) as Record<string, string>
        buffer = buffer.subarray(4 + buffer.readUInt32BE(0))
        if (frame.type === "challenge") {
          const expected = createHmac("sha256", key).update(`${Broker.MAC_LOCAL}${hostId}|${epoch}|${nonceR}|${frame.nonceL}`).digest("hex")
          if (expected !== frame.mac) {
            record({ kind: "broker", result: "local_mac_mismatch", epoch })
            socket.destroy()
            return
          }
          send({ type: "auth", mac: createHmac("sha256", key).update(`${Broker.MAC_REMOTE}${hostId}|${epoch}|${frame.nonceL}|${nonceR}`).digest("hex") })
        } else if (frame.type === "ready") {
          state.state = "connected"
          record({ kind: "broker", result: "connected", epoch, via: "socket" in endpoint ? "socket" : "tcp" })
        }
      }
    })
    socket.on("error", () => record({ kind: "broker", result: "connect_error", epoch }))
    socket.on("close", () => {
      if (state.state !== "connected") state.state = "unarmed"
    })
  }
  const remote: Broker.RemoteBrokerClient = {
    arm: (input) => {
      if (input.proto !== Broker.PROTO) return { accepted: false, reason: "proto" }
      if (current && input.epoch < current.epoch) return { accepted: false, reason: "stale_epoch" }
      if (current && input.epoch === current.epoch && Buffer.compare(Buffer.from(current.key), Buffer.from(input.key)) !== 0)
        return { accepted: false, reason: "key_mismatch" }
      current = { epoch: input.epoch, key: new Uint8Array(input.key) }
      state.epoch = input.epoch
      record({ kind: "arm", epoch: input.epoch, endpoint: "socket" in input.endpoint ? "socket" : "tcp", keyBytes: input.key.length })
      connect(input.endpoint, input.hostId, input.epoch, current.key)
      return { accepted: true }
    },
    status: () => ({
      state: state.state,
      epoch: state.epoch,
      leases: [],
      mirror: { revision: null, fetchedAt: null },
      spool: { backlog: 0, bytes: 0, gaps: 0 },
    }),
  }
  return remote
})()
Broker.provideRemote("fake", client)
const ownHome = process.env.TMPDIR ? path.dirname(win(process.env.TMPDIR)!) : home
const agent = Handlers.agent({ buildId: "fake", version, home: ownHome })

let servedPort = 0
const fetchHandler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  if (!authorized(request)) return new Response(null, { status: 401 })
  if (url.pathname === "/api/info") return Response.json({ version, pid: process.pid })
  if (url.pathname === "/api/session/active") {
    const active: Record<string, unknown> = readJson(path.join(testRoot, `active-${servedPort}.json`)) ?? {}
    return Response.json({ data: active })
  }
  if (url.pathname === "/fake/shutdown") {
    setTimeout(shutdown, 10)
    return Response.json({ ok: true })
  }
  const rpc = /^\/api\/rpc\/own\.remote\/(agent\.[a-z.]+)$/.exec(url.pathname)
  if (rpc && request.method === "POST") {
    const method = rpc[1] as keyof typeof agent
    const body = (await request.json()) as { input?: unknown }
    record({ kind: "rpc", method, location: url.searchParams.get("location[directory]") })
    const handler = agent[method] as ((input: unknown, context: unknown) => Promise<unknown>) | undefined
    if (!handler) return Response.json({ _tag: "RpcError", type: "rpc.method_not_found", message: method }, { status: 404 })
    const errors: Array<Record<string, unknown>> = []
    const output = await handler(body.input ?? {}, {
      signal: request.signal,
      error: (type: string, message: string, data: unknown) => {
        errors.push({ _tag: "RpcError", type, message, data })
        return errors.at(-1)
      },
    })
    if (errors.length > 0) return Response.json(errors[0], { status: 400 })
    return Response.json({ output })
  }
  return new Response(null, { status: 404 })
}
const server = listen()

/** A port held by another process ends this service; record it so the harness reports the collision. */
function listen() {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port, fetch: fetchHandler })
  } catch (error) {
    collision({ port, detail: `cannot listen: ${String(error)}` })
    throw error
  }
}

servedPort = server.port ?? 0
fs.mkdirSync(stateDir, { recursive: true })
const url = `http://127.0.0.1:${server.port}`
fs.writeFileSync(`${registration}.tmp`, JSON.stringify({ id: "fake", url, password, version, pid: process.pid }), { mode: 0o600 })
fs.renameSync(`${registration}.tmp`, registration)
record({ kind: "started", url })

function shutdown() {
  record({ kind: "stopped" })
  const reg = readJson(registration)
  if (reg?.pid === process.pid) fs.rmSync(registration, { force: true })
  fs.rmSync(path.join(testRoot, "proc", String(process.pid)), { recursive: true, force: true })
  server.stop(true)
  process.exit(0)
}
process.on("SIGTERM", shutdown)

