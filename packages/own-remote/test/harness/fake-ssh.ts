#!/usr/bin/env bun
/**
 * Fake `ssh` for the own-remote tests (04 §20.1 "가짜 ssh"). Never opens a network connection to another machine:
 * the "remote host" is a POSIX shell (Git for Windows `bash`/`sh`) running locally with a temp HOME, and forwards
 * are local TCP relays. Invoked as `[bun, fake-ssh.ts, --state, <state.json>, ...ssh args]`.
 *
 * Emulated: `-G`, host key checking (`StrictHostKeyChecking`, a temp known-hosts JSON, never the user's), password
 * prompts through `SSH_ASKPASS` exactly like OpenSSH (helper run with the prompt as its only argument), `-L`, `-R`
 * (TCP, and stream sockets as placeholder files that name a TCP relay), `ExitOnForwardFailure`,
 * `ClearAllForwardings`, and the remote command through `$SHELL -c`. Every invocation is appended to the log.
 *
 * A silent link (`<testRoot>/links/<alias>` holding `silent`, harness `setLink`): a pulled cable without FIN or RST.
 * A new connection times out; a running one forwards nothing in either direction (the bytes wait, as in the kernel's
 * buffers, and flow again when the link comes back in time) and ends like OpenSSH's keepalive does: with
 * `ServerAliveInterval=<i>` and `ServerAliveCountMax=<n>` the last received byte is the last answered check (every
 * `<i>` seconds while the link is up), and ssh exits 255 with `Timeout, server … not responding.` at the `n + 1`-th
 * unanswered check (measured with the real Win32-OpenSSH 9.5 client, 04 §6.3).
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

interface FakeHost {
  readonly home: string
  readonly fingerprint: string
  readonly password?: string | null
  readonly forwards?: ReadonlyArray<string>
  readonly denyStreamLocal?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly offline?: boolean
}

interface State {
  readonly sh: string
  readonly bash: string
  readonly bun: string
  readonly log: string
  readonly knownHosts: string
  readonly testRoot: string
  readonly shimDir: string
  readonly service: string
  /** Ports no forward may reach and no fake service may use (the developer's installed own service, see remote.ts). */
  readonly blockedPorts: ReadonlyArray<number>
  readonly hosts: Readonly<Record<string, FakeHost>>
}

const argv = process.argv.slice(2)
if (argv[0] !== "--state" || !argv[1]) {
  process.stderr.write("fake-ssh: --state <file> required\n")
  process.exit(255)
}
const state = JSON.parse(fs.readFileSync(argv[1], "utf8")) as State
const args = argv.slice(2)

// ---------------------------------------------------------------------------------------------------------------
// ssh argument parsing (the subset own-remote produces)

const options = new Map<string, string>()
const locals: string[] = []
const remotes: string[] = []
let resolveOnly = false
let index = 0
const valueFlags = new Set(["-p", "-l", "-i", "-J", "-o", "-L", "-R", "-F"])
for (; index < args.length; index++) {
  const arg = args[index]!
  if (!arg.startsWith("-")) break
  if (arg === "-G") {
    resolveOnly = true
    continue
  }
  const flag = arg.slice(0, 2)
  if (!valueFlags.has(flag)) continue
  const value = arg.length > 2 ? arg.slice(2) : args[++index]!
  if (flag === "-o") {
    const match = /^([A-Za-z]+)\s*[=\s]\s*(.*)$/.exec(value)
    const key = match?.[1]?.toLowerCase()
    // ssh: the first obtained value wins.
    if (key && !options.has(key)) options.set(key, match?.[2] ?? "")
  } else if (flag === "-L") locals.push(value)
  else if (flag === "-R") remotes.push(value)
}
const alias = args[index] ?? ""
const command = args.slice(index + 1).join(" ")

fs.appendFileSync(
  state.log,
  JSON.stringify({ at: Date.now(), alias, command, options: Object.fromEntries(options), locals, remotes, resolveOnly, argv: args }) +
    "\n",
)

const host = state.hosts[alias.includes("@") ? alias.slice(alias.lastIndexOf("@") + 1) : alias]
if (!host) {
  process.stderr.write(`ssh: Could not resolve hostname ${alias}: No such host is known.\r\n`)
  process.exit(255)
}

if (resolveOnly) {
  const lines = [
    `user tester`,
    `hostname ${alias}`,
    `port 22`,
    `stricthostkeychecking ${options.get("stricthostkeychecking") ?? "ask"}`,
    `userknownhostsfile ~/.ssh/known_hosts`,
    ...(host.forwards ?? []).map((forward) => `localforward ${forward}`),
  ]
  process.stdout.write(lines.join("\n") + "\n")
  process.exit(0)
}

const linkFile = path.join(state.testRoot, "links", alias.includes("@") ? alias.slice(alias.lastIndexOf("@") + 1) : alias)
const linkSilent = () => {
  try {
    return fs.readFileSync(linkFile, "utf8").trim() === "silent"
  } catch {
    return false
  }
}

if (host.offline || linkSilent()) {
  if (!host.offline) await new Promise((resolve) => setTimeout(resolve, 1000))
  process.stderr.write(`ssh: connect to host ${alias} port 22: Connection timed out\r\n`)
  process.exit(255)
}

// The link: while silent nothing crosses it; the bytes wait and cross in order when it comes back.
const link = { silent: false, waiting: [] as Array<() => void> }
const cross = (send: () => void) => {
  if (link.silent) link.waiting.push(send)
  else send()
}

// ---------------------------------------------------------------------------------------------------------------
// Authentication (askpass like OpenSSH with SSH_ASKPASS_REQUIRE=force)

function askpass(prompt: string, confirm = false): string | null {
  const helper = process.env.SSH_ASKPASS
  if (!helper || process.env.SSH_ASKPASS_REQUIRE !== "force") return null
  // The helper may be a real opencode.exe: keep its XDG roots inside the test root (never the user profile).
  const xdg = path.join(state.testRoot, "askpass-xdg")
  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(xdg, "data"),
    XDG_STATE_HOME: path.join(xdg, "state"),
    XDG_CONFIG_HOME: path.join(xdg, "config"),
    XDG_CACHE_HOME: path.join(xdg, "cache"),
    OPENCODE_TEST_HOME: xdg,
    ...(confirm ? { SSH_ASKPASS_PROMPT: "confirm" } : {}),
  }
  const isScript = /\.(ts|js|mjs)$/.test(helper)
  const result = spawnSync(isScript ? state.bun : helper, isScript ? [helper, prompt] : [prompt], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 6 * 60_000,
  })
  if (result.status !== 0) return null
  return (result.stdout ?? "").replace(/\r?\n$/, "")
}

const known = (() => {
  try {
    return JSON.parse(fs.readFileSync(state.knownHosts, "utf8")) as Record<string, string>
  } catch {
    return {} as Record<string, string>
  }
})()
const recorded = known[alias]
if (recorded && recorded !== host.fingerprint) {
  process.stderr.write(
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n" +
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n" +
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n" +
      `Host key for ${alias} has changed and you have requested strict checking.\r\nHost key verification failed.\r\n`,
  )
  process.exit(255)
}
if (!recorded) {
  const strict = (options.get("stricthostkeychecking") ?? "ask").toLowerCase()
  if (strict === "yes") {
    process.stderr.write(
      `No ED25519 host key is known for ${alias} and you have requested strict checking.\r\nHost key verification failed.\r\n`,
    )
    process.exit(255)
  }
  const answer = askpass(
    `The authenticity of host '${alias} (127.0.0.1)' can't be established.\n` +
      `ED25519 key fingerprint is ${host.fingerprint}.\n` +
      `This key is not known by any other names.\n` +
      `Are you sure you want to continue connecting (yes/no/[fingerprint])? `,
  )
  if (answer !== "yes" && answer !== host.fingerprint) {
    process.stderr.write("Host key verification failed.\r\n")
    process.exit(255)
  }
  fs.writeFileSync(state.knownHosts, JSON.stringify({ ...known, [alias]: host.fingerprint }))
  process.stderr.write(`Warning: Permanently added '${alias}' (ED25519) to the list of known hosts.\r\n`)
}
if (host.password) {
  const answer = askpass(`tester@${alias}'s password: `)
  if (answer !== host.password) {
    process.stderr.write(`tester@${alias}: Permission denied (publickey,password).\r\n`)
    process.exit(255)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Forwards

/** Git Bash's `/tmp`: the user's temp folder whatever this process's TEMP says (remote.ts `MSYS_TMP`). */
const msysTmp = (() => {
  const done = spawnSync(path.join(path.dirname(state.bash), "cygpath.exe"), ["-w", "/tmp"], {
    encoding: "utf8",
    windowsHide: true,
  })
  const found = done.status === 0 ? done.stdout.trim() : ""
  return found || os.tmpdir()
})()

function toWindows(posix: string) {
  // MSYS mounts /tmp on the user's temp directory.
  if (posix === "/tmp" || posix.startsWith("/tmp/")) return path.join(msysTmp, ...posix.slice(5).split("/").filter(Boolean))
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(posix)
  return match ? `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll("/", "\\")}` : posix
}

function toPosix(windows: string) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(windows)
  return match ? `/${match[1]!.toLowerCase()}/${match[2]!.replaceAll("\\", "/")}` : windows.replaceAll("\\", "/")
}

function relay(listenHost: string, listenPort: number, targetHost: string, targetPort: number) {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((socket) => {
      // A forward to a blocked port would reach this PC's real service: refuse it and record the attempt.
      if (state.blockedPorts.includes(targetPort)) {
        fs.appendFileSync(
          path.join(state.testRoot, "collisions.jsonl"),
          JSON.stringify({ at: Date.now(), source: "fake-ssh", alias, port: targetPort }) + "\n",
        )
        process.stderr.write(`fake-ssh: refused a forward to the blocked port ${targetPort}\r\n`)
        return socket.destroy()
      }
      // The channel open crosses the link too: the far end sees the connection only once the link carries it.
      const queued: Buffer[] = []
      let upstream: net.Socket | undefined
      socket.on("data", (chunk: Buffer) => cross(() => (upstream ? upstream.write(chunk) : queued.push(chunk))))
      socket.on("end", () => cross(() => upstream?.end()))
      socket.on("error", () => upstream?.destroy())
      cross(() => {
        upstream = net.connect({ host: targetHost, port: targetPort })
        for (const chunk of queued.splice(0)) upstream.write(chunk)
        upstream.on("data", (chunk: Buffer) => cross(() => socket.write(chunk)))
        upstream.on("end", () => cross(() => socket.end()))
        upstream.on("error", () => socket.destroy())
      })
    })
    server.once("error", reject)
    server.listen({ host: listenHost, port: listenPort, exclusive: true }, () => resolve(server))
  })
}

const exitOnFailure = (options.get("exitonforwardfailure") ?? "no").toLowerCase() === "yes"
const clearAll = (options.get("clearallforwardings") ?? "no").toLowerCase() === "yes"
const servers: net.Server[] = []

async function forwards() {
  if (clearAll) return true
  for (const spec of locals) {
    const parts = spec.split(":")
    const [address, port, target, targetPort] = parts.length === 4 ? parts : ["127.0.0.1", ...parts]
    try {
      servers.push(await relay(address!, Number(port), target!, Number(targetPort)))
    } catch {
      process.stderr.write(
        `bind [${address}]:${port}: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ${port}\r\nCould not request local forwarding.\r\n`,
      )
      if (exitOnFailure) return false
    }
  }
  for (const spec of remotes) {
    const socket = /^(\/.+):(127\.0\.0\.1):(\d+)$/.exec(spec)
    if (socket) {
      const file = toWindows(socket[1]!)
      const parentOk = fs.existsSync(path.dirname(file))
      if (host!.denyStreamLocal || !parentOk || fs.existsSync(file)) {
        process.stderr.write(`Error: remote port forwarding failed for listen path ${socket[1]}\r\n`)
        if (exitOnFailure) return false
        continue
      }
      const server = await relay("127.0.0.1", 0, socket[2]!, Number(socket[3]))
      servers.push(server)
      const info = server.address() as net.AddressInfo
      // Placeholder of the unix socket sshd would create (0600): names the relay port.
      fs.writeFileSync(file, JSON.stringify({ fakeSocket: true, tcp: info.port }), { mode: 0o600 })
      continue
    }
    const tcp = /^(127\.0\.0\.1):(\d+):(127\.0\.0\.1):(\d+)$/.exec(spec)
    if (tcp) {
      try {
        servers.push(await relay("127.0.0.1", Number(tcp[2]), "127.0.0.1", Number(tcp[4])))
      } catch {
        process.stderr.write(`Error: remote port forwarding failed for listen port ${tcp[2]}\r\n`)
        if (exitOnFailure) return false
      }
    }
  }
  return true
}

if (!(await forwards())) {
  for (const server of servers) server.close()
  process.exit(255)
}

// ---------------------------------------------------------------------------------------------------------------
// Remote command: sshd runs `$SHELL -c "<command>"` as the user.

const bunDir = toPosix(path.dirname(state.bun))
const remoteEnv: Record<string, string> = {
  HOME: toPosix(host.home),
  USER: "tester",
  LOGNAME: "tester",
  SHELL: "/usr/bin/bash",
  PATH: `${toPosix(state.shimDir)}:/usr/bin:/bin:${bunDir}`,
  LANG: "C.UTF-8",
  MSYS: "winsymlinks:native",
  OWN_REMOTE_TEST_ROOT: toPosix(state.testRoot),
  OWN_FAKE_BUN: toPosix(state.bun),
  OWN_FAKE_SERVICE: toPosix(state.service),
  OWN_FAKE_BLOCKED_PORTS: state.blockedPorts.join(","),
  SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows",
  WINDIR: process.env.WINDIR ?? "C:\\Windows",
  // The host's programs see the same temp folder as its shells' /tmp (a Bun service maps /tmp paths through TEMP).
  TEMP: msysTmp,
  TMP: msysTmp,
  ...host.env,
}
if (!command) {
  process.stderr.write("fake-ssh: no remote command\n")
  process.exit(255)
}
const child = spawn(state.bash, ["-c", command], {
  env: remoteEnv,
  cwd: host.home,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
})
process.stdin.on("data", (chunk: Buffer) => cross(() => child.stdin!.write(chunk)))
process.stdin.on("end", () => cross(() => child.stdin!.end()))
child.stdin!.on("error", () => {})
child.stdout!.on("data", (chunk: Buffer) => cross(() => process.stdout.write(chunk)))
child.stderr!.on("data", (chunk: Buffer) => cross(() => process.stderr.write(chunk)))

// ssh's keepalive (OpenSSH `server_alive_check`): a check every interval, answered while the link is up.
const aliveInterval = Number(options.get("serveraliveinterval") ?? "0") * 1000
const aliveMax = Number(options.get("serveralivecountmax") ?? "3")
let answeredAt = Date.now()
setInterval(() => {
  const silent = linkSilent()
  if (!silent && link.silent) {
    link.silent = false
    for (const send of link.waiting.splice(0)) send()
  }
  if (silent) link.silent = true
  const now = Date.now()
  if (!link.silent) {
    if (aliveInterval > 0 && now - answeredAt >= aliveInterval) answeredAt = now
    return
  }
  if (aliveInterval > 0 && now - answeredAt >= (aliveMax + 1) * aliveInterval) {
    for (const server of servers) server.close()
    child.kill()
    process.stderr.write(`Timeout, server ${alias} not responding.\r\n`, () => process.exit(255))
  }
}, 50).unref()
child.on("exit", (code) => {
  for (const server of servers) server.close()
  // Let stdout drain before exiting.
  setTimeout(() => process.exit(code ?? 255), 50)
})
