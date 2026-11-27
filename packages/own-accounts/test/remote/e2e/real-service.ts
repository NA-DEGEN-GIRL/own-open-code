#!/usr/bin/env bun
/**
 * The "remote own service" of the fake-SSH end-to-end test: a drop-in for own-remote's `fake-service.ts` (the fake
 * bundle's `opencode` launcher calls `"$OWN_FAKE_BUN" "$OWN_FAKE_SERVICE" <sub> …`; the test points
 * `OWN_FAKE_SERVICE` here through the fake host's env). Instead of a stub it boots a real OpenCode server from source
 * with own-accounts `mode:"remote"` and own-remote `mode:"agent"`, like the service ensure starts on a real host.
 *
 *   start --version V   like `opencode service start`: reads the service config, spawns `serve` detached and waits
 *                       for the registration file (0600 JSON {url,password,version,pid})
 *   serve               boots the real server (its own temp dirs under the fake host's HOME), and a small proxy on
 *                       the service port that translates the MSYS paths own-remote sends (`location[directory]`) to
 *                       Windows paths for the Windows server; `POST /fake/shutdown` ends both
 *   stop / status       like `opencode service stop|status`
 *
 * The managed config ensure wrote (`<configDir>/opencode.json`) decides the plugins and their options (`mode`,
 * `home`); only the package paths (the repository packages instead of the bundle) and test settings from
 * `OWN_E2E_CONFIG` (build id, fake provider endpoints, the placeholder socket dial, config providers) are added. Nothing here reads the
 * user's profile, `~/.ssh` or real credentials.
 */
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RELEASE_FLAGS } from "../../../../../own/scripts/test/release-flags.ts"

interface E2EConfig {
  readonly repo: string
  readonly buildId: string
  readonly endpoints: Record<string, string>
  readonly logs: string
  readonly transpilerCache: string
  readonly broker?: Record<string, unknown>
  /** Config providers of the remote server (a fake chat model of a test whose host runs turns on its own provider). */
  readonly providers?: Record<string, unknown>
  /** Folders put first on the remote server's PATH (Windows paths), e.g. git's for a host that runs git. */
  readonly pathPrepend?: ReadonlyArray<string>
  /**
   * More of the managed config's plugins to load after own-remote, in its order, from the repository packages with
   * the managed options (e.g. own-harness and own-creator for a test of extensions on a host, 17 §10). Default: none.
   */
  readonly plugins?: ReadonlyArray<string>
  /** Extra variables of the remote server (e.g. `OPENCODE_DISABLE_FILEWATCHER: ""` so config edits reload plugins). */
  readonly env?: Readonly<Record<string, string>>
}

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
    JSON.stringify({ at: Date.now(), source: "real-service", pid: process.pid, ...entry }) + "\n",
  )
const e2e = JSON.parse(fs.readFileSync(win(process.env.OWN_E2E_CONFIG)!, "utf8")) as E2EConfig

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const basic = (secret: string) => `Basic ${Buffer.from(`opencode:${secret}`).toString("base64")}`

if (sub === "status") {
  const reg = readJson(registration)
  process.stdout.write(`${reg && typeof reg.pid === "number" && alive(reg.pid) ? String(reg.url) : "stopped"}\n`)
  process.exit(0)
}

if (sub === "stop") {
  const reg = readJson(registration)
  if (reg && typeof reg.pid === "number" && alive(reg.pid)) {
    await fetch(new URL("/fake/shutdown", String(reg.url)), { method: "POST", headers: { authorization: basic(String(reg.password)) } }).catch(() => {})
    for (let i = 0; i < 400 && alive(reg.pid); i++) await sleep(50)
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
    process.stderr.write(`real service: refusing the blocked port ${port} (the installed own service may hold it)\n`)
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
  // A server booted from source takes 10–30 s (more on a cold transpiler cache).
  for (let i = 0; i < 3600; i++) {
    if (fs.existsSync(registration)) process.exit(0)
    await sleep(50)
  }
  process.stderr.write("real service did not register\n")
  process.exit(1)
}

if (sub !== "serve") {
  process.stderr.write(`real service: unknown command ${args.join(" ")}\n`)
  process.exit(2)
}

// ---------------------------------------------------------------------------------------------------------------
// serve

const password = process.env.OWN_FAKE_PASSWORD ?? ""
delete process.env.OWN_FAKE_PASSWORD
// `serve` runs detached without stdio: keep its own failures next to the server logs.
fs.mkdirSync(e2e.logs, { recursive: true })
const fail = (error: unknown) => {
  fs.appendFileSync(path.join(e2e.logs, `real-service-${process.pid}.err`), `${new Date().toISOString()} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`)
}
process.on("uncaughtException", (error) => {
  fail(error)
  process.exit(1)
})
process.on("unhandledRejection", (error) => fail(error))
const port = Number(flag("port") ?? "0")
const events = path.join(testRoot, "service-events.jsonl")
const record = (entry: Record<string, unknown>) =>
  fs.appendFileSync(events, JSON.stringify({ at: Date.now(), pid: process.pid, version, real: true, ...entry }) + "\n")

// The managed config ensure wrote (04 §5.6): plugins, their modes and the remote OWN_HOME.
const managedDir = win(process.env.OPENCODE_CONFIG_DIR) ?? path.join(home, ".config", "own-open-code")
const managed = JSON.parse(fs.readFileSync(path.join(managedDir, "opencode.json"), "utf8")) as {
  readonly plugins: ReadonlyArray<{ readonly package: string; readonly options?: Record<string, unknown> }>
}
const pluginOf = (name: string) => managed.plugins.find((plugin) => plugin.package.endsWith(`/${name}`))
const accounts = pluginOf("own-accounts")
const agent = pluginOf("own-remote")
if (!accounts || !agent) throw new Error("managed config without the own plugins")
const ownHome = win(String(accounts.options?.home))!

const root = path.join(home, ".e2e-server")
const dirs = {
  config: path.join(root, "config"),
  data: path.join(root, "xdg-data"),
  state: path.join(root, "xdg-state"),
  cache: path.join(root, "xdg-cache"),
  xdgConfig: path.join(root, "xdg-config"),
  local: path.join(root, "localappdata"),
  workspace: path.join(home, "work"),
}
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(
  path.join(dirs.config, "opencode.jsonc"),
  JSON.stringify(
    {
      update: "disable",
      share: "disabled",
      providers: e2e.providers ?? {},
      plugins: [
        {
          package: path.join(e2e.repo, "packages", "own-accounts"),
          options: {
            ...accounts.options,
            home: ownHome,
            buildId: e2e.buildId,
            endpoints: e2e.endpoints,
            broker: { dial: "placeholder", ...e2e.broker },
            logLevel: "debug",
          },
        },
        {
          package: path.join(e2e.repo, "packages", "own-remote"),
          options: { ...agent.options, home: ownHome, buildId: e2e.buildId },
        },
        ...managed.plugins.flatMap((plugin) => {
          const name = path.posix.basename(plugin.package)
          if (!(e2e.plugins ?? []).includes(name)) return []
          const options = plugin.options === undefined ? {} : { ...plugin.options }
          const homed = "home" in options ? { ...options, home: ownHome } : options
          return [
            {
              package: path.join(e2e.repo, "packages", name),
              // own.team reaches its service over self-HTTP (06 §2.6): on a real host through the channel's
              // registration file, here through this script's proxy on the service port.
              options: name === "own-team" ? { ...homed, service: { url: `http://127.0.0.1:${port}`, password } } : homed,
            },
          ]
        }),
      ],
    },
    null,
    2,
  ),
)

// A clean child environment: no inherited OpenCode settings or credentials, Windows paths only.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      !/^(OPENCODE_|XDG_|HOME$|MSYS|OWN_FAKE)/i.test(entry[0]) &&
      !/(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(entry[0]),
  ),
)
const pathKey = Object.keys(inherited).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
const childEnv: Record<string, string> = {
  ...inherited,
  ...(e2e.pathPrepend === undefined
    ? {}
    : { [pathKey]: [...e2e.pathPrepend, inherited[pathKey] ?? ""].filter(Boolean).join(path.delimiter) }),
  HOME: home,
  USERPROFILE: home,
  OPENCODE_TEST_HOME: home,
  OPENCODE_CONFIG_DIR: dirs.config,
  OPENCODE_DB: path.join(dirs.data, "opencode-own.db"),
  OPENCODE_PASSWORD: password,
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_FILEWATCHER: "true",
  // Project config never (the walk from a temp workspace would reach the developer's real folders). The host's
  // project state reaches the server the way own-remote's service env carries it (04 §5.6): `disabled` and
  // `instructions` set the first variable, `instructions` the second too.
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  ...Object.fromEntries(
    ["OPENCODE_CONFIG_PROJECT_DISABLE", "OPENCODE_CONFIG_PROJECT_INSTRUCTIONS"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  ),
  OPENCODE_PRINT_LOGS: "1",
  // Core's flags as a release has them, as the e2e kit's servers do: from source they are on (full Code Mode would put
  // the host's read, shell and edit tools behind `execute`). No CLAUDE.md, as own-remote's service env.
  OPENCODE_FLAGS: process.env.OPENCODE_FLAGS ?? RELEASE_FLAGS,
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ?? "1",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: e2e.transpilerCache,
  XDG_DATA_HOME: dirs.data,
  XDG_STATE_HOME: dirs.state,
  XDG_CACHE_HOME: dirs.cache,
  XDG_CONFIG_HOME: dirs.xdgConfig,
  LOCALAPPDATA: dirs.local,
  APPDATA: dirs.local,
  OWN_OPEN_CODE: "1",
  OWN_REMOTE: process.env.OWN_REMOTE ?? "",
  ...(process.env.TMPDIR ? { TMPDIR: win(process.env.TMPDIR)! } : {}),
  ...e2e.env,
}
const log = fs.openSync(path.join(e2e.logs, `remote-server-${process.pid}.log`), "a")
const server = spawn(
  process.execPath,
  [
    // The CLI's Solid JSX preload by its file: a bunfig's `preload` resolves from the workspace (opencode-server.ts
    // `CLI_PRELOAD`), where Bun auto-installed it from npm.
    `--preload=${Bun.resolveSync("@opentui/solid/preload", path.join(e2e.repo, "packages/cli"))}`,
    path.join(e2e.repo, "packages/cli/src/index.ts"),
    "serve",
    "--stdio",
    "--port",
    "0",
  ],
  { cwd: dirs.workspace, env: childEnv, stdio: ["pipe", "pipe", log], windowsHide: true },
)
const target = await new Promise<string>((resolve, reject) => {
  let buffer = ""
  server.stdout!.on("data", (chunk: Buffer) => {
    fs.writeSync(log, chunk)
    buffer += chunk.toString("utf8")
    for (const line of buffer.split(/\r?\n/)) {
      try {
        const value = JSON.parse(line) as { url?: string }
        if (typeof value.url === "string") resolve(value.url)
      } catch {
        // not the ready line
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
  })
  server.once("exit", (code) => reject(new Error(`remote server exited with ${code}`)))
})
record({ kind: "real_server", target, names: Object.keys(childEnv).sort() })

/** MSYS path → Windows path for the values own-remote sends (the Windows server resolves them as locations). */
function translate(value: string) {
  return /^\/([a-zA-Z]|tmp)\//.test(value) ? win(value)! : value
}

let stopping = false
const handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname === "/fake/shutdown" && request.method === "POST") {
    if (request.headers.get("authorization") !== basic(password)) return new Response(null, { status: 401 })
    setTimeout(shutdown, 10)
    return Response.json({ ok: true })
  }
  const forward = new URL(url.pathname + url.search, target)
  for (const [key, value] of [...forward.searchParams]) forward.searchParams.set(key, translate(value))
  const headers = new Headers(request.headers)
  headers.delete("host")
  // Bun's fetch decodes compressed bodies but keeps the header: ask for plain bodies so the bytes match the headers.
  headers.set("accept-encoding", "identity")
  const directory = headers.get("x-opencode-directory")
  if (directory) headers.set("x-opencode-directory", encodeURIComponent(translate(decodeURIComponent(directory))))
  const response = await fetch(forward, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  }).catch((error: unknown) => new Response(String(error), { status: 502 }))
  const out = new Headers(response.headers)
  out.delete("content-encoding")
  out.delete("content-length")
  return new Response(response.body, { status: response.status, headers: out })
}

/** The service port may still be held for a moment by a previous service of this host: retry the bind. */
async function listen() {
  for (let attempt = 0; ; attempt++) {
    try {
      return Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: handler })
    } catch (error) {
      fail(error)
      if (attempt >= 40) {
        // Still held after 10 s: another process owns the port; the harness reports it.
        collision({ port, detail: `cannot listen: ${String(error)}` })
        throw error
      }
      await sleep(250)
    }
  }
}
const proxy = await listen()

fs.mkdirSync(stateDir, { recursive: true })
const url = `http://127.0.0.1:${proxy.port}`
fs.writeFileSync(`${registration}.tmp`, JSON.stringify({ id: "real", url, password, version, pid: process.pid }), { mode: 0o600 })
fs.renameSync(`${registration}.tmp`, registration)
record({ kind: "started", url })

async function shutdown() {
  if (stopping) return
  stopping = true
  record({ kind: "stopped" })
  const reg = readJson(registration)
  if (reg?.pid === process.pid) fs.rmSync(registration, { force: true })
  server.stdin?.end()
  const exited = await Promise.race([new Promise((resolve) => server.once("exit", () => resolve(true))), sleep(10_000).then(() => false)])
  if (!exited) server.kill()
  fs.rmSync(path.join(testRoot, "proc", String(process.pid)), { recursive: true, force: true })
  proxy.stop(true)
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown())
server.once("exit", () => void shutdown())
