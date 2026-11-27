/**
 * Fake-SSH harness (04 §20.1): temp "remote hosts" run by a local POSIX shell, a fake own-channel bundle, and helpers
 * to read what happened. Nothing here touches the user's ~/.ssh, known_hosts, firewall or real hosts, and every
 * process it starts is killed by `cleanup()`.
 */
import { createHash, createHmac, randomBytes } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Broker } from "../../src/protocol/broker.js"
import { RemoteModel } from "../../src/remote/model.js"
import { Scripts } from "../../src/remote/scripts.js"
import { removeTree } from "./remove.js"

export const GIT_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
export const GIT_SH = "C:\\Program Files\\Git\\usr\\bin\\sh.exe"
export const WINDOWS_TAR = "C:\\Windows\\System32\\tar.exe"

/** The harness needs Windows with Git for Windows (its bash plays the remote host). */
export const available = process.platform === "win32" && fs.existsSync(GIT_BASH) && fs.existsSync(WINDOWS_TAR)

/**
 * Where Git Bash mounts `/tmp`: the user's temp folder, which MSYS takes from the user's profile, so a run under
 * another TEMP (a fresh fake profile) does not move it. The fake host gets it as its TEMP too (fake-ssh.ts). With the
 * test's TEMP instead, a short socket directory the host's script made was not where fake ssh bound its socket, and
 * the broker fell back to TCP (HANDOFF §5's fake-profile failures, MR10-5).
 */
export const MSYS_TMP = msysTmp(GIT_BASH)

export function msysTmp(bash: string) {
  if (process.platform !== "win32") return os.tmpdir()
  const done = spawnSync(path.join(path.dirname(bash), "cygpath.exe"), ["-w", "/tmp"], {
    encoding: "utf8",
    windowsHide: true,
  })
  const found = done.status === 0 ? done.stdout.trim() : ""
  return found || os.tmpdir()
}

const REPO = path.resolve(import.meta.dir, "../../../..")

/**
 * The own channel's default service port. It is the same for every run on this PC and the installed own service of
 * the developer listens on it, so no fake host may serve on it and no fake forward may reach it.
 */
export const BLOCKED_PORT = RemoteModel.defaultPort()

/** A built own-channel opencode.exe, used as the real askpass helper when present (04 §14.2). */
export function builtAskpass() {
  const root = path.join(REPO, "own", ".out", "build")
  const versions = fs.existsSync(root) ? fs.readdirSync(root) : []
  for (const version of versions.sort().reverse()) {
    const exe = path.join(root, version, "cli-windows-x64", "bin", "opencode.exe")
    if (fs.existsSync(exe)) return exe
  }
  return undefined
}

export function toPosix(windows: string) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(windows)
  return match ? `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}` : windows.replaceAll("\\", "/")
}

export function toWindows(posix: string) {
  // MSYS mounts /tmp on the user's temp directory (MSYS_TMP).
  if (posix === "/tmp" || posix.startsWith("/tmp/")) return path.join(MSYS_TMP, ...posix.slice(5).split("/").filter(Boolean))
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(posix)
  return match ? `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll("/", "\\")}` : posix
}

export interface HostSpec {
  readonly fingerprint?: string
  readonly known?: boolean
  readonly password?: string | null
  readonly forwards?: ReadonlyArray<string>
  readonly denyStreamLocal?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly machineId?: string
}

/** The launcher placed as `opencode` in the fake bundle (records its exe under the fake /proc). */
export function launcher(version: string) {
  return [
    "#!/bin/sh",
    'own_self="$(cd "$(dirname "$0")" && pwd -P)/opencode"',
    'case "${1:-}" in',
    `  --version) echo "opencode ${version}"; exit 0 ;;`,
    "esac",
    'if [ "${1:-}" = service ] && [ "${2:-}" = start ]; then',
    `  "$OWN_FAKE_BUN" "$OWN_FAKE_SERVICE" start --version "${version}" || exit 1`,
    '  own_reg="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service-own.json"',
    `  own_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$own_reg")`,
    '  mkdir -p "$OWN_REMOTE_TEST_ROOT/proc/$own_pid" && printf \'%s\' "$own_self" > "$OWN_REMOTE_TEST_ROOT/proc/$own_pid/exe"',
    "  exit 0",
    "fi",
    `if [ "\${1:-}" = service ]; then shift; exec "$OWN_FAKE_BUN" "$OWN_FAKE_SERVICE" "$@" --version "${version}"; fi`,
    'echo "fake opencode: $*" >&2',
    "exit 2",
    "",
  ].join("\n")
}

function sha256(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex")
}

/** Builds `<dir>/remote/{linux-x64-baseline.tar.gz, manifest.json}` with the fake opencode for `version`. */
export function buildBundle(dir: string, version: string) {
  const stage = path.join(dir, `bundle-${version}`)
  fs.mkdirSync(path.join(stage, "plugins", "own-accounts"), { recursive: true })
  fs.mkdirSync(path.join(stage, "plugins", "own-remote"), { recursive: true })
  fs.mkdirSync(path.join(stage, "libexec"), { recursive: true })
  const files: Record<string, string> = {
    opencode: launcher(version),
    "plugins/own-accounts/index.js": "// fake own-accounts bundle\nexport default { id: 'own.accounts', setup() {} }\n",
    "plugins/own-remote/index.js": "// fake own-remote bundle\nexport default { id: 'own.remote', setup() {} }\n",
    "libexec/start.sh": Scripts.startScript,
    "manifest.json": JSON.stringify({ version, build_id: "fake", proto: Broker.PROTO }) + "\n",
  }
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(stage, file), text)
  const out = path.join(dir, "remote")
  fs.mkdirSync(out, { recursive: true })
  const archive = path.join(out, "linux-x64-baseline.tar.gz")
  execFileSync(WINDOWS_TAR, ["-czf", archive, "-C", stage, ...Object.keys(files)], { windowsHide: true })
  const data = fs.readFileSync(archive)
  const manifest = {
    schemaVersion: 1,
    version,
    build_id: "fake",
    proto: Broker.PROTO,
    channel: "own",
    targets: {
      "linux-x64-baseline": {
        file: "linux-x64-baseline.tar.gz",
        sha256: sha256(data),
        bytes: data.length,
        files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, `sha256:${sha256(text)}`])),
      },
    },
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2))
  return out
}

export interface Harness {
  readonly root: string
  readonly localHome: string
  readonly sshDir: string
  readonly statePath: string
  readonly sshCommand: string[]
  readonly askpassHelper: string
  readonly bundles: string
  readonly testRoot: string
  hostHome(alias: string): string
  /** The free port written into the host's service config at create (ensure keeps it, 04 §5.6). */
  servicePort(alias: string): number
  /** The port of the host's current service registration (its `url`), if one is registered. */
  registeredPort(alias: string): number | undefined
  ownHome(alias: string): string
  sshLog(): Array<Record<string, any>>
  serviceEvents(): Array<Record<string, any>>
  /** Attempts to use {@link BLOCKED_PORT} or a port held by another process; `cleanup()` fails when there are any. */
  collisions(): Array<Record<string, any>>
  setActive(port: number, sessions: Record<string, unknown>): void
  setHost(alias: string, patch: Partial<HostSpec>): void
  /** A pulled cable (`silent`: no FIN, no RST; fake-ssh.ts) or the link back (`up`). */
  setLink(alias: string, state: "up" | "silent"): void
  forgetKnownHost(alias: string): void
  cleanup(): Promise<void>
}

export function create(input: {
  readonly version: string
  readonly hosts: Readonly<Record<string, HostSpec>>
  /**
   * A host HOME long enough that `$HOME/.own-r/<hash8>/broker-<epoch>.sock` passes 100 bytes whatever TEMP is, so the
   * broker socket falls back to `/tmp/own-<uid>` (04 §7.4). Under a short TEMP such as `C:\t\x` the HOME fit `~/.own-r`.
   */
  readonly deepHome?: boolean
}): Harness {
  const pad = input.deepHome ? "d".repeat(Math.max(0, 30 - os.tmpdir().length)) : ""
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `own-remote-e2e-${pad}`))
  const testRoot = path.join(root, "remote-root")
  const shimDir = path.join(root, "shim")
  const localHome = path.join(root, "local-own-home")
  const sshDir = path.join(root, "dot-ssh")
  for (const dir of [testRoot, path.join(testRoot, "proc"), path.join(testRoot, "etc"), shimDir, localHome, sshDir])
    fs.mkdirSync(dir, { recursive: true })
  // uname reports Linux x86_64 (the probe target is linux-x64-baseline); no other shims.
  fs.writeFileSync(
    path.join(shimDir, "uname"),
    ['#!/bin/sh', 'case "${1:-}" in -m) echo x86_64 ;; *) echo Linux ;; esac', ""].join("\n"),
  )
  fs.writeFileSync(path.join(testRoot, "etc", "machine-id"), `${randomBytes(16).toString("hex")}\n`)
  fs.writeFileSync(
    path.join(sshDir, "config"),
    Object.keys(input.hosts)
      .map((alias) => `Host ${alias}\n  HostName ${alias}.test\n  User tester\n`)
      .join(""),
  )
  const hosts: Record<string, Record<string, unknown>> = {}
  const known: Record<string, string> = {}
  // Each host's service config names its own free port, which ensure keeps instead of the channel default
  // (BLOCKED_PORT). All probes stay open until every port is taken, so the hosts of one run never share a port.
  const probes = Object.keys(input.hosts).map(() =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
  )
  const servicePorts = probes.map((probe) => probe.port)
  for (const probe of probes) probe.stop(true)
  if (servicePorts.includes(BLOCKED_PORT))
    throw new Error(`fake-SSH harness: a probe returned the blocked port ${BLOCKED_PORT}`)
  for (const [index, [alias, spec]] of Object.entries(input.hosts).entries()) {
    const home = path.join(root, "hosts", alias, "home")
    const servicePort = servicePorts[index]!
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
    fs.writeFileSync(
      path.join(home, ".config", "opencode", "service-own.json"),
      JSON.stringify({ hostname: "127.0.0.1", port: servicePort }),
      { mode: 0o600 },
    )
    const fingerprint = spec.fingerprint ?? `SHA256:${randomBytes(32).toString("base64").replace(/=+$/, "")}`
    hosts[alias] = {
      home,
      servicePort,
      fingerprint,
      password: spec.password ?? null,
      forwards: spec.forwards ?? [],
      denyStreamLocal: spec.denyStreamLocal ?? false,
      env: spec.env ?? {},
    }
    if (spec.known !== false) known[alias] = fingerprint
  }
  const knownHosts = path.join(root, "known_hosts.json")
  fs.writeFileSync(knownHosts, JSON.stringify(known))
  const statePath = path.join(root, "fake-ssh-state.json")
  const state = {
    sh: GIT_SH,
    bash: GIT_BASH,
    bun: process.execPath,
    log: path.join(root, "ssh.log.jsonl"),
    knownHosts,
    testRoot,
    shimDir,
    service: path.join(import.meta.dir, "fake-service.ts"),
    blockedPorts: [BLOCKED_PORT],
    hosts,
  }
  const writeState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
  writeState()
  const bundles = buildBundle(root, input.version)
  const readLines = (file: string) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, any>)
      : []
  return {
    root,
    localHome,
    sshDir,
    statePath,
    sshCommand: [process.execPath, path.join(import.meta.dir, "fake-ssh.ts"), "--state", statePath],
    askpassHelper: builtAskpass() ?? path.join(import.meta.dir, "askpass-client.ts"),
    bundles,
    testRoot,
    hostHome: (alias) => String(hosts[alias]!.home),
    servicePort: (alias) => Number(hosts[alias]!.servicePort),
    registeredPort: (alias) => {
      const file = path.join(String(hosts[alias]!.home), ".local", "state", "opencode", "service-own.json")
      if (!fs.existsSync(file)) return undefined
      return Number(new URL(String(JSON.parse(fs.readFileSync(file, "utf8")).url)).port)
    },
    ownHome: (alias) => path.join(String(hosts[alias]!.home), ".local", "share", "own-open-code"),
    sshLog: () => readLines(state.log),
    serviceEvents: () => readLines(path.join(testRoot, "service-events.jsonl")),
    collisions: () => readLines(path.join(testRoot, "collisions.jsonl")),
    setActive: (port, sessions) => fs.writeFileSync(path.join(testRoot, `active-${port}.json`), JSON.stringify(sessions)),
    setHost: (alias, patch) => {
      hosts[alias] = { ...hosts[alias], ...patch }
      writeState()
    },
    setLink: (alias, link) => setLink(testRoot, alias, link),
    forgetKnownHost: (alias) => {
      const current = JSON.parse(fs.readFileSync(knownHosts, "utf8")) as Record<string, string>
      delete current[alias]
      fs.writeFileSync(knownHosts, JSON.stringify(current))
    },
    cleanup: async () => {
      const collisions = readLines(path.join(testRoot, "collisions.jsonl"))
      // Every fake service registered a pid under the fake /proc; stop them, then remove the temp root.
      const procDir = path.join(testRoot, "proc")
      for (const entry of fs.existsSync(procDir) ? fs.readdirSync(procDir) : []) {
        const pid = Number(entry)
        if (!Number.isInteger(pid)) continue
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
      }
      // fake-ssh processes and remote shells are children of the test process; they end when their pipes close.
      await new Promise((resolve) => setTimeout(resolve, 300))
      // Short socket directories (04 §7.4) live under MSYS /tmp = the Windows temp dir: /tmp/own-<uid>/<hash8>.
      for (const alias of Object.keys(hosts)) {
        const hash = createHash("sha256")
          .update(toPosix(path.join(String(hosts[alias]!.home), ".local", "share", "own-open-code")))
          .digest("hex")
          .slice(0, 8)
        for (const entry of fs.readdirSync(MSYS_TMP).filter((name) => /^own-\d+$/.test(name))) {
          const dir = path.join(MSYS_TMP, entry)
          fs.rmSync(path.join(dir, hash), { recursive: true, force: true })
          if (fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true })
        }
      }
      await removeTree(root)
      if (collisions.length > 0)
        throw new Error(
          [
            `fake-SSH harness: port collisions (blocked port ${BLOCKED_PORT} or a port held by another process):`,
            ...collisions.map((entry) => JSON.stringify(entry)),
          ].join("\n"),
        )
    },
  }
}

/**
 * A test double of the local broker server (own-runtime's part, 04 §8.2–8.3): one loopback listener per host, the
 * `hello → challenge → auth → ready` handshake with the epoch key own-remote registered. Records what happened.
 */
/** The fake host's link (fake-ssh.ts reads it every 50 ms); also for the own-web remote e2e, which has only the root. */
export function setLink(testRoot: string, alias: string, link: "up" | "silent") {
  fs.mkdirSync(path.join(testRoot, "links"), { recursive: true })
  fs.writeFileSync(path.join(testRoot, "links", alias), link)
}

export function fakeBroker() {
  const listeners = new Map<string, net.Server>()
  const keys = new Map<string, { epoch: number; key: Buffer }>()
  const connected = new Map<string, number>()
  const log: Array<Record<string, unknown>> = []
  const subscribers = new Set<(hostId: string, status: Broker.LocalStatus) => void>()
  const status = (hostId: string): Broker.LocalStatus => ({
    state: connected.has(hostId) ? "connected" : "disconnected",
    mode: connected.has(hostId) ? "normal" : null,
    proto: Broker.PROTO,
    leasesActive: 0,
    lastPushAt: null,
    spoolBacklog: 0,
    gaps: 0,
    clockSkewMs: null,
    sourceStale: [],
    lastConnectedAt: connected.get(hostId) ?? null,
  })
  const frame = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value))
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    return Buffer.concat([head, body])
  }
  const broker: Broker.LocalBroker = {
    listen: async (hostId) => {
      const existing = listeners.get(hostId)
      if (existing) return { port: (existing.address() as net.AddressInfo).port }
      const server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0)
        let nonceL = ""
        let hello: Record<string, any> | undefined
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk])
          while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
            const length = buffer.readUInt32BE(0)
            if (length > Broker.MAX_FRAME_BYTES) return socket.destroy()
            const message = JSON.parse(buffer.subarray(4, 4 + length).toString()) as Record<string, any>
            buffer = buffer.subarray(4 + length)
            const current = keys.get(hostId)
            if (!hello) {
              if (message.type !== "hello" || !current || message.epoch !== current.epoch || message.hostId !== hostId) {
                log.push({ hostId, event: "rejected_hello", epoch: message.epoch })
                return socket.destroy()
              }
              hello = message
              nonceL = randomBytes(16).toString("hex")
              const mac = createHmac("sha256", current.key).update(`${Broker.MAC_LOCAL}${hostId}|${current.epoch}|${message.nonceR}|${nonceL}`).digest("hex")
              socket.write(frame({ type: "challenge", nonceL, mac }))
              continue
            }
            if (message.type === "auth" && current) {
              const expected = createHmac("sha256", current.key).update(`${Broker.MAC_REMOTE}${hostId}|${current.epoch}|${nonceL}|${hello.nonceR}`).digest("hex")
              if (expected !== message.mac) {
                log.push({ hostId, event: "auth_failed", epoch: current.epoch })
                return socket.destroy()
              }
              connected.set(hostId, Date.now())
              log.push({ hostId, event: "connected", epoch: current.epoch })
              socket.write(frame({ type: "ready" }))
              for (const subscriber of subscribers) subscriber(hostId, status(hostId))
            }
          }
        })
        socket.on("close", () => {
          if (hello) connected.delete(hostId)
        })
        socket.on("error", () => {})
      })
      await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()))
      listeners.set(hostId, server)
      return { port: (server.address() as net.AddressInfo).port }
    },
    setKey: (hostId, input) => {
      const current = keys.get(hostId)
      if (current && input.epoch < current.epoch) return
      keys.set(hostId, { epoch: input.epoch, key: Buffer.from(input.key) })
      log.push({ hostId, event: "key", epoch: input.epoch })
    },
    configure: (hostId, settings) => void log.push({ hostId, event: "configure", accounts: settings.accounts }),
    close: async (hostId) => {
      listeners.get(hostId)?.close()
      listeners.delete(hostId)
      keys.delete(hostId)
    },
    status,
    subscribe: (listener) => {
      subscribers.add(listener)
      return () => void subscribers.delete(listener)
    },
  }
  return {
    broker,
    log,
    keys,
    close: () => {
      for (const server of listeners.values()) server.close()
      listeners.clear()
    },
  }
}

export { toPosix as posix, toWindows as windows }
