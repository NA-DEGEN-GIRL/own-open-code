#!/usr/bin/env bun
/**
 * The "remote own service" of the own-web SSH e2e (04 §20.1 fake-SSH harness). own-remote's fake-SSH harness plays the
 * Linux host with Git for Windows' shell (MSYS paths such as `/c/Users/...`), and its fake bundle's `opencode` launcher
 * runs `$OWN_FAKE_SERVICE start|serve|stop|status`. This file is that service for own-web's tests: a real opencode
 * server booted from source (own-accounts' e2e kit) with the managed config's plugins (own-accounts mode:"remote", its
 * broker client dialing the PC through the fake -R socket; own-remote mode:"agent"), behind a small proxy on the
 * registered port that
 *   - authenticates like the real service (Basic password, or a session token signed with it: upstream `verifySession`),
 *     lets CORS preflights and ticket-authenticated PTY upgrades through to the server, which checks them itself;
 *   - maps the MSYS paths the remote side reports (`controlDir`, `home`, realpath input) to Windows paths for the
 *     Windows server, in query parameters, the location header and JSON bodies;
 *   - relays SSE streams and PTY WebSockets unchanged;
 *   - records what it saw (method, path, auth kind, cookie present, origin; never a value) for the tests.
 * The server runs with `serve --stdio`: it ends when this process ends. Nothing here touches a real host, ~/.ssh or
 * known_hosts; every path is under the harness temp root.
 */
import { spawn } from "node:child_process"
import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { startOpencodeServer, type OpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"

function win(value: string | undefined) {
  if (!value) return value
  if (value === "/tmp" || value.startsWith("/tmp/"))
    return path.join(os.tmpdir(), ...value.slice(5).split("/").filter(Boolean))
  const match = /^\/([a-zA-Z])(\/.*)?$/.exec(value)
  return match ? `${match[1]!.toUpperCase()}:\\${(match[2] ?? "").slice(1).replaceAll("/", "\\")}` : value
}

/** A value that is an absolute MSYS path (`/c/...`, `/tmp/...`) becomes the Windows path of the same file. */
function translate(value: string) {
  return /^\/([a-zA-Z])(\/|$)/.test(value) || value === "/tmp" || value.startsWith("/tmp/") ? win(value)! : value
}

/** `C:\Users\x` → `/c/Users/x` (the fake host's view of the same file). */
function msys(value: string) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value)
  return match ? `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}` : value
}

function translateJson(value: unknown): unknown {
  if (typeof value === "string") return translate(value)
  if (Array.isArray(value)) return value.map(translateJson)
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translateJson(item)]))
  return value
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
const events = path.join(testRoot, "service-events.jsonl")

interface E2eConfig {
  readonly accountsPlugin: string
  readonly remotePlugin: string
  readonly buildId: string
  /** own-accounts `endpoints` (the fake provider). */
  readonly endpoints: Record<string, string>
  /** own-accounts `broker` test options (`dial: "placeholder"` for the fake -R socket). */
  readonly broker: Record<string, unknown>
  readonly pathPrepend: readonly string[]
  /** How long `start` waits for the server to register (backend.ts, inside ensure's `scriptTimeoutMs`). */
  readonly startWaitMs: number
}

interface ManagedConfig {
  readonly plugins: ReadonlyArray<{ readonly package: string; readonly options: Record<string, unknown> }>
}

function readJson<T = Record<string, unknown>>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
      headers: { authorization: `Basic ${btoa(`opencode:${String(reg.password)}`)}` },
    }).catch(() => {})
    for (let i = 0; i < 200 && alive(reg.pid); i++) await sleep(50)
    if (alive(reg.pid)) process.kill(reg.pid)
  }
  fs.rmSync(registration, { force: true })
  process.exit(0)
}

if (sub === "start") {
  const config = readJson(serviceConfig) ?? {}
  const existing = readJson(registration)
  if (existing && typeof existing.pid === "number" && alive(existing.pid) && existing.version === version)
    process.exit(0)
  let password = typeof config.password === "string" ? config.password : undefined
  if (!password) {
    password = randomBytes(24).toString("base64url")
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(serviceConfig, JSON.stringify({ ...config, password }, null, 2), { mode: 0o600 })
  }
  const port = typeof config.port === "number" ? config.port : 0
  const env = { ...process.env, ...((config.env as Record<string, string>) ?? {}) }
  fs.rmSync(registration, { force: true })
  const child = spawn(process.execPath, [import.meta.path, "serve", "--version", version, "--port", String(port)], {
    env: { ...env, OWN_FAKE_PASSWORD: password },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
  // The server boots from source, which this PC under load stretches past 2 minutes: allow it most of ensure's window.
  const until = Date.now() + (readJson<E2eConfig>(path.join(testRoot, "e2e-remote.json"))?.startWaitMs ?? 100_000)
  while (Date.now() < until) {
    if (fs.existsSync(registration)) process.exit(0)
    if (child.exitCode !== null) break
    await sleep(50)
  }
  process.stderr.write("e2e remote service did not register\n")
  process.exit(1)
}

if (sub !== "serve") {
  process.stderr.write(`e2e remote service: unknown command ${args.join(" ")}\n`)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------------------------
// serve

const password = process.env.OWN_FAKE_PASSWORD ?? ""
delete process.env.OWN_FAKE_PASSWORD
const e2e = readJson<E2eConfig>(path.join(testRoot, "e2e-remote.json"))
if (!e2e) {
  process.stderr.write("e2e-remote.json is missing\n")
  process.exit(1)
}
const record = (entry: Record<string, unknown>) =>
  fs.appendFileSync(events, JSON.stringify({ at: Date.now(), pid: process.pid, home, version, ...entry }) + "\n")

function authorized(request: Request): "password" | "token" | undefined {
  const header = request.headers.get("authorization") ?? ""
  if (!header.startsWith("Basic ")) return undefined
  const [user, secret] = Buffer.from(header.slice(6), "base64").toString().split(/:(.*)/s)
  if (user !== "opencode" || secret === undefined) return undefined
  if (secret === password) return "password"
  // upstream `verifySession` (packages/server/src/auth.ts:47-56)
  const parts = secret.split(".")
  const expires = Number(parts[0])
  if (parts.length !== 2 || !Number.isSafeInteger(expires) || expires * 1000 <= Date.now()) return undefined
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  return createHmac("sha256", key).update(parts[0]!).digest("base64url") === parts[1] ? "token" : undefined
}

// The managed config ensure wrote (04 §5.6) decides the plugins, their modes and the remote OWN_HOME. Only the package
// paths (the repository packages instead of the bundle) and the test settings of e2e-remote.json are ours.
const managedDir = win(process.env.OPENCODE_CONFIG_DIR) ?? path.join(home, ".config", "own-open-code")
const managed = readJson<ManagedConfig>(path.join(managedDir, "opencode.json"))
const pluginOf = (name: string) => managed?.plugins.find((plugin) => plugin.package.endsWith(`/${name}`))
const accountsPlugin = pluginOf("own-accounts")
const agentPlugin = pluginOf("own-remote")
if (!accountsPlugin || !agentPlugin) {
  process.stderr.write("managed config without the own plugins\n")
  process.exit(1)
}
const ownHome = win(String(accountsPlugin.options.home))!
// The real server: its own temp tree next to the fake remote home, kept across restarts (the remote DB is the source).
const serverRoot = path.join(path.dirname(home), "server")
fs.mkdirSync(serverRoot, { recursive: true })
const inner: OpencodeServer = await startOpencodeServer({
  root: serverRoot,
  // Within `start`'s wait: a boot from source on this PC under load took past 110 s (2026-11-12).
  startupTimeoutMs: e2e.startWaitMs,
  config: {
    update: "disable",
    share: "disabled",
    providers: {},
    // own-accounts mode:"remote" (slots from the mirror, credentials leased from the PC per request, 04 §8–9) and
    // own-remote mode:"agent" (`agent.realpath` for the folder picker, `agent.status`, `agent.broker.arm`).
    plugins: [
      {
        package: e2e.accountsPlugin,
        options: {
          ...accountsPlugin.options,
          home: ownHome,
          buildId: e2e.buildId,
          endpoints: e2e.endpoints,
          broker: e2e.broker,
        },
      },
      { package: e2e.remotePlugin, options: { ...agentPlugin.options, home: ownHome, buildId: e2e.buildId } },
    ],
  },
  env: {
    // The service env ensure sets (04 §5.6): own markers; guard 1 of both plugins needs them.
    OWN_OPEN_CODE: "1",
    OWN_REMOTE: "1",
    ...(process.env.TMPDIR ? { TMPDIR: win(process.env.TMPDIR) } : {}),
    // The fake host's login env has MSYS values a Windows server cannot use.
    SHELL: undefined,
    PATH: [...e2e.pathPrepend, process.env.PATH, path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32")]
      .filter(Boolean)
      .join(";"),
    ComSpec: path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe"),
  },
})
// `OWN_E2E_DEBUG_DIR=<dir>` (inherited from the backend): keep the remote server's log there, outside the temp roots
// that are removed on exit.
const debugDir = process.env.OWN_E2E_DEBUG_DIR
if (debugDir) {
  fs.mkdirSync(debugDir, { recursive: true })
  const file = path.join(debugDir, `remote-server-${path.basename(path.dirname(home))}-${process.pid}.log`)
  setInterval(() => fs.writeFileSync(file, inner.logs()), 2_000).unref()
}
const upstream = new URL(inner.url)
record({ kind: "started", upstream: upstream.origin })

function forwardHeaders(request: Request) {
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    if (name === "host" || name === "authorization" || name === "content-length" || name === "connection") return
    if (name === "x-opencode-directory")
      return headers.set(key, encodeURIComponent(translate(decodeURIComponent(value))))
    headers.set(key, value)
  })
  headers.set("authorization", inner.authorization)
  return headers
}

function target(url: URL, protocol: "http:" | "ws:" = "http:") {
  const next = new URL(url.pathname, upstream)
  url.searchParams.forEach((value, key) => next.searchParams.append(key, translate(value)))
  next.protocol = protocol
  return next
}

type Socket = ServerWebSocket<{
  target: string
  upstream?: WebSocket
  queue: Array<string | ArrayBuffer | Uint8Array<ArrayBuffer>>
}>

let servedPort = 0
const server = Bun.serve<
  { target: string; upstream?: WebSocket; queue: Array<string | ArrayBuffer | Uint8Array<ArrayBuffer>> },
  never
>({
  hostname: "127.0.0.1",
  port: Number(flag("port") ?? "0"),
  idleTimeout: 0,
  async fetch(request, bun) {
    const url = new URL(request.url)
    const auth = authorized(request)
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
    const ticket = upgrade && /^\/api\/pty\/[^/]+\/connect$/.test(url.pathname) && url.searchParams.has("ticket")
    record({
      kind: "request",
      method: request.method,
      path: url.pathname,
      auth: auth ?? (ticket ? "ticket" : "none"),
      cookie: request.headers.has("cookie"),
      origin: request.headers.get("origin"),
    })
    if (url.pathname === "/fake/shutdown" && auth === "password") {
      setTimeout(shutdown, 10)
      return Response.json({ ok: true })
    }
    // Preflights carry no credentials; the server answers them (CORS for oc://renderer and http://127.0.0.1:*).
    if (request.method !== "OPTIONS" && !auth && !ticket) return new Response(null, { status: 401 })
    if (upgrade) {
      if (bun.upgrade(request, { data: { target: target(url, "ws:").toString(), queue: [] } })) return undefined
      return new Response("upgrade failed", { status: 400 })
    }
    let body: BodyInit | undefined
    if (request.method !== "GET" && request.method !== "HEAD") {
      const type = request.headers.get("content-type") ?? ""
      // The arm's socket path stays the host's own path (the placeholder dial maps it); every other JSON body gets
      // Windows paths for the Windows server.
      const arm = url.pathname === "/api/rpc/own.remote/agent.broker.arm"
      if (type.includes("application/json") && !arm) {
        const text = await request.text()
        try {
          body = JSON.stringify(translateJson(JSON.parse(text)))
        } catch {
          body = text
        }
      } else body = await request.arrayBuffer()
    }
    const response = await fetch(target(url), {
      method: request.method,
      headers: forwardHeaders(request),
      body,
      redirect: "manual",
      // SSE and long polls stay open as long as the browser wants.
      signal: request.signal,
    }).catch(() => undefined)
    if (!response) return new Response(null, { status: 502 })
    const headers = new Headers(response.headers)
    // fetch already decoded the body.
    headers.delete("content-encoding")
    headers.delete("content-length")
    // A Linux host answers realpath in the paths it was asked in: map the Windows answer back to MSYS.
    if (url.pathname === "/api/rpc/own.remote/agent.realpath" && request.method === "POST" && response.ok) {
      const body = (await response.json()) as { output?: { realpath?: string | null } }
      if (typeof body.output?.realpath === "string") body.output.realpath = msys(body.output.realpath)
      // A new body: its framing is ours (the upstream's chunked encoding and type do not apply).
      headers.delete("transfer-encoding")
      headers.delete("content-type")
      return Response.json(body, { status: response.status, headers })
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
  websocket: {
    open(ws: Socket) {
      const socket = new WebSocket(ws.data.target)
      socket.binaryType = "arraybuffer"
      ws.data.upstream = socket
      socket.addEventListener("open", () => {
        for (const message of ws.data.queue.splice(0)) socket.send(message)
      })
      socket.addEventListener("message", (event) => ws.send(event.data as string | ArrayBuffer))
      socket.addEventListener("close", (event) => ws.close(event.code === 1005 ? 1000 : event.code, event.reason))
      socket.addEventListener("error", () => ws.close(1011, "upstream error"))
    },
    message(ws: Socket, message) {
      const socket = ws.data.upstream
      if (socket?.readyState === WebSocket.OPEN) socket.send(message)
      else ws.data.queue.push(message)
    },
    close(ws: Socket) {
      ws.data.upstream?.close()
    },
  },
})

servedPort = server.port ?? 0
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(
  `${registration}.tmp`,
  JSON.stringify({ id: "own-web-e2e", url: `http://127.0.0.1:${servedPort}`, password, version, pid: process.pid }),
  { mode: 0o600 },
)
fs.renameSync(`${registration}.tmp`, registration)
record({ kind: "registered", port: servedPort })

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  record({ kind: "stopped" })
  const reg = readJson(registration)
  if (reg?.pid === process.pid) fs.rmSync(registration, { force: true })
  fs.rmSync(path.join(testRoot, "proc", String(process.pid)), { recursive: true, force: true })
  server.stop(true)
  await inner.stop().catch(() => undefined)
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
