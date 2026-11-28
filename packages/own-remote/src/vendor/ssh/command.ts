// Vendored from packages/gui-plugins/src/ssh/command.ts @ dae4077a96 (v2.0.28, MIT). See own/ledger/vendored.yaml
// own: local changes are marked "own:" (04 §4.3, §7.2, §14.1, §14.4):
// - `sshExecutable()` is the absolute inbox OpenSSH path on Windows; callers may pass a replacement argv prefix.
// - `runSsh` spawns with `extendEnv: false` and the minimal environment of `minimalEnv()`.
// - `parseTarget` drops `-F`, `-o proxycommand`, `-o identityagent`; `-i`/`-o identityfile` accept only local paths
//   under `%USERPROFILE%\.ssh\` (no UNC, device paths, `%` or `$`); `-J`/`-o proxyjump` accept `[user@]host[:port]`.
// - `sshArgs` adds `ForwardAgent=no` and `ForwardX11=no` (04 §7.2), so `shortArgs` and `tunnelArgs` carry them too.
//   The target line cannot turn them back on with `-o`, `-X` or `-Y`; upstream's `-A` stays accepted and, as OpenSSH
//   applies it over the `-o`, re-enables agent forwarding: the user's explicit choice for that host (04 §7.2).
// - `shortArgs` adds `ClearAllForwardings=yes` for short commands; `tunnelArgs` builds the -L/-R tunnel of 04 §7.1.
// - `tunnelArgs` asks ssh's keepalive every 4 s and gives up after 2 unanswered (upstream's 15 s and 3 stay for the short
//   commands, whose uploads must survive a slow link): a silent link ends the tunnel 12 s after its last received byte
//   instead of 60 s (04 §6.3, `src/ssh/liveness.ts`).
import { Effect, FileSystem, Path, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import nodePath from "node:path"
import { RemoteCli } from "../remote/cli.js"
import { Liveness } from "../../ssh/liveness.js"

export class SshFailure extends Schema.TaggedError<SshFailure>()("SshFailure", {
  code: Schema.Literals([
    "input",
    "connection",
    "platform",
    "version",
    "install",
    "service",
    "unpublished",
    "ssh-missing",
  ]),
  detail: Schema.String,
}) {
  constructor(code: SshFailure["code"], detail = "") {
    super({ code, detail })
  }

  override get message() {
    return this.detail
  }

  static from(this: void, error: unknown) {
    if (error instanceof RemoteCli.Failure) return new SshFailure(error.code, error.detail)
    if (
      error instanceof PlatformError.PlatformError &&
      error.reason._tag === "NotFound" &&
      error.reason.method === "spawn"
    )
      return new SshFailure("ssh-missing", error.message)
    return error instanceof SshFailure
      ? error
      : new SshFailure("connection", error instanceof Error ? error.message : String(error))
  }
}

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export type Target = { host: string; args: string[] }

// own: the host grammar of upstream (the final `host` check below), reused for every jump hop and `-o hostname`.
const HOST = /^[a-zA-Z0-9_@.:[\]%-]+$/
const HOP = /^(?:[a-zA-Z0-9_.-]+@)?(?:[a-zA-Z0-9_.-]+|\[[0-9a-fA-F:.%]+\])(?::\d{1,5})?$/

/**
 * own: the identity file rule of 04 §7.2. Only a local drive path under `%USERPROFILE%\.ssh\` (or `~/.ssh/...`)
 * is accepted: UNC and device paths would make Windows authenticate to an SMB server (NTLM hash leak), and `%`/`$`
 * are ssh token and environment expansions.
 */
export function identityFileAllowed(value: string, profile = homedir()) {
  if (/[%$\0]/.test(value)) return false
  if (/^[\\/]{2}/.test(value) || /^[\\/][\\/?.][\\/]/.test(value)) return false
  const expanded = /^~[\\/]/.test(value) ? nodePath.win32.join(profile, value.slice(2)) : value
  if (!/^[a-zA-Z]:[\\/]/.test(expanded)) return false
  const normalized = nodePath.win32.normalize(expanded)
  const root = nodePath.win32.join(nodePath.win32.normalize(profile), ".ssh") + "\\"
  return normalized.toLowerCase().startsWith(root.toLowerCase()) && !normalized.slice(root.length).includes("..")
}

function optionValueAllowed(name: string, value: string, profile?: string) {
  switch (name) {
    case "hostname":
      return HOST.test(value) && !value.startsWith("-")
    case "user":
      return /^[a-zA-Z0-9_.-]+$/.test(value)
    case "port":
    case "connecttimeout":
      return /^\d{1,5}$/.test(value)
    case "identityfile":
      return identityFileAllowed(value, profile)
    case "identitiesonly":
      return /^(yes|no)$/i.test(value)
    case "proxyjump":
      return value.toLowerCase() === "none" || value.split(",").every((hop) => HOP.test(hop))
    case "addressfamily":
      return /^(any|inet|inet6)$/i.test(value)
  }
  return false
}

export function parseTarget(input: string, options: { profile?: string } = {}): Target {
  const tokens: string[] = []
  const state = { word: "", quote: "", started: false }
  for (let i = 0; i < input.length; i++) {
    const c = input[i] ?? ""
    if (c === "\n" || c === "\r" || c === "\0") throw new SshFailure("input")
    if (c === "\\" && state.quote !== "'" && i + 1 < input.length && /[\s\\"']/.test(input[i + 1] ?? "")) {
      state.word += input[++i]
      state.started = true
      continue
    }
    if (state.quote) {
      if (c === state.quote) state.quote = ""
      else state.word += c
      continue
    }
    if (c === "'" || c === '"') {
      state.quote = c
      state.started = true
      continue
    }
    if (/\s/.test(c)) {
      if (state.started) tokens.push(state.word)
      state.word = ""
      state.started = false
      continue
    }
    state.word += c
    state.started = true
  }
  if (state.quote) throw new SshFailure("input")
  if (state.started) tokens.push(state.word)
  if (tokens[0] === "ssh") tokens.shift()
  const args: string[] = []
  // own: no "identityagent" and no "proxycommand" (a UI line must not run local commands, 04 §7.2).
  const options_ = new Set([
    "hostname",
    "user",
    "port",
    "identityfile",
    "identitiesonly",
    "proxyjump",
    "connecttimeout",
    "addressfamily",
  ])
  while (tokens[0]?.startsWith("-")) {
    const token = tokens.shift() ?? ""
    if (["-4", "-6", "-C", "-A", "-a"].includes(token)) {
      args.push(token)
      continue
    }
    const flag = token.slice(0, 2)
    // own: no "-F" (a chosen config file can run ProxyCommand, KnownHostsCommand or Match exec).
    if (!["-p", "-l", "-i", "-J", "-o"].includes(flag)) throw new SshFailure("input")
    const value = token.length > 2 ? token.slice(2) : tokens.shift()
    if (!value || value.startsWith("-")) throw new SshFailure("input")
    if (flag === "-p" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535))
      throw new SshFailure("input")
    if (flag === "-l" && !optionValueAllowed("user", value)) throw new SshFailure("input")
    if (flag === "-i" && !identityFileAllowed(value, options.profile)) throw new SshFailure("input")
    if (flag === "-J" && !optionValueAllowed("proxyjump", value)) throw new SshFailure("input")
    if (flag === "-o") {
      const match = /^([A-Za-z]+)\s*(?:=|\s)\s*(.*)$/.exec(value)
      const name = (match?.[1] ?? "").toLowerCase()
      if (!match || !options_.has(name) || !optionValueAllowed(name, match[2] ?? "", options.profile))
        throw new SshFailure("input")
    }
    args.push(flag, value)
  }
  const host = tokens[0]
  if (tokens.length !== 1 || !host || !HOST.test(host) || host.startsWith("-")) throw new SshFailure("input")
  if (host.includes("@") && host.slice(0, host.lastIndexOf("@")).includes(":")) throw new SshFailure("input")
  return { host, args }
}

// own: the inbox Win32-OpenSSH by absolute path (04 §14.1). Git Bash's MSYS ssh must never be picked from PATH.
export const WINDOWS_SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
export const sshExecutable = () => (process.platform === "win32" ? WINDOWS_SSH : "ssh")

export function sshArgs(target: Target) {
  return [
    "-T",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "RemoteCommand=none",
    "-o",
    "RequestTTY=no",
    "-o",
    "PermitLocalCommand=no",
    // own: no agent or X11 forwarding, whatever the user's config says (04 §7.2): the remote service started in the
    // tunnel session would inherit SSH_AUTH_SOCK, and its agent shell could sign with the user's keys. Only an `-A`
    // the user wrote on the target line (`target.args`) turns agent forwarding back on.
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    ...target.args,
  ]
}

// own: short commands (inspect, install, stop, prepare) never take the config's LocalForward/RemoteForward
// (04 §7.2). Not for the tunnel: ClearAllForwardings also clears the command line's -L/-R.
export function shortArgs(target: Target) {
  return [...sshArgs(target), "-o", "ClearAllForwardings=yes"]
}

// own: the long-lived tunnel of 04 §7.1. `-L` binds the host loopback address (127.0.<k>.2, 04 §7.3), `-R` is the
// broker forward (a stream socket path or a remote loopback TCP port, 04 §7.4), a second `-R` the Claude egress relay
// forward (04 §8.11.4.2, same form; ExitOnForwardFailure makes both succeed or fail together), and the remote command
// is `sh -s`: the ensure body and the keep part arrive on stdin, which stays open for the life of the session.
type Forward = { remote: { socket: string } | { tcpPort: number }; localPort: number }

function remoteForward(forward: Forward) {
  return [
    "-R",
    "socket" in forward.remote
      ? `${forward.remote.socket}:127.0.0.1:${forward.localPort}`
      : `127.0.0.1:${forward.remote.tcpPort}:127.0.0.1:${forward.localPort}`,
  ]
}

export function tunnelArgs(
  target: Target,
  local: { address: string; port: number },
  remote: { host: string; port: number },
  broker: Forward | undefined,
  egress?: Forward,
  // own: the remote command; the real-host gates' test root prefixes it with its XDG roots (decisions RL35).
  command = "sh -s",
) {
  return [
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPersist=no",
    // own: ahead of sshArgs' upstream values (ssh keeps the first value it obtains).
    "-o",
    `ServerAliveInterval=${Liveness.SERVER_ALIVE_INTERVAL}`,
    "-o",
    `ServerAliveCountMax=${Liveness.SERVER_ALIVE_COUNT_MAX}`,
    ...sshArgs(target),
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${local.address}:${local.port}:${remote.host}:${remote.port}`,
    ...(broker ? remoteForward(broker) : []),
    ...(broker && egress ? remoteForward(egress) : []),
    target.host,
    command,
  ]
}

/**
 * own: the ssh child environment (04 §14.4): no inherited `OPENCODE_*`, provider keys or service settings, so the
 * user's `SendEnv` has little to take. Askpass variables are added by the caller.
 *
 * `ProgramData` is required on Windows: Win32-OpenSSH resolves `__PROGRAMDATA__\ssh` (global ssh_config and
 * known_hosts) from it and, without it, exits 255 before printing anything, even for `ssh -G` (found on a real host,
 * OpenSSH_for_Windows_9.5p2).
 */
export function minimalEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys = process.platform === "win32" ? MINIMAL_ENV_WINDOWS : MINIMAL_ENV_POSIX
  const env: Record<string, string> = {}
  const names = Object.keys(source)
  for (const key of keys) {
    // Windows environment names are case-insensitive (`Path`, `SYSTEMROOT`); a plain object source is not.
    const name = names.find((item) => item.toUpperCase() === key.toUpperCase())
    const value = name === undefined ? undefined : source[name]
    if (value !== undefined) env[key] = value
  }
  return env
}

export const MINIMAL_ENV_WINDOWS = ["SystemRoot", "ProgramData", "PATH", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP"]
export const MINIMAL_ENV_POSIX = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "LANG"]

export const runSsh = Effect.fn("Ssh.run")(function* (input: {
  args: string[]
  env?: Record<string, string>
  stdin?: string | Uint8Array
  timeout?: number
  /** own: replacement argv prefix for the ssh executable (settings override, tests). */
  command?: readonly string[]
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [executable, ...prefix] = input.command && input.command.length > 0 ? input.command : [sshExecutable()]
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(executable ?? sshExecutable(), [...prefix, ...input.args], {
        env: input.env ?? minimalEnv(),
        extendEnv: false,
        windowsHide: true,
        killSignal: "SIGTERM",
        forceKillAfter: "2 seconds",
        stdin:
          input.stdin === undefined
            ? "ignore"
            : {
                stream: Stream.make(
                  typeof input.stdin === "string" ? new TextEncoder().encode(input.stdin) : input.stdin,
                ),
                endOnDone: true,
              },
      }),
    )
    const output = yield* Effect.all(
      {
        stdout: child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, text) => (tail + text).slice(-1_048_576),
          ),
        ),
        stderr: child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, text) => (tail + text).slice(-16_384),
          ),
        ),
        code: child.exitCode,
      },
      { concurrency: "unbounded" },
    )
    if (output.code !== 0)
      return yield* Effect.fail(new SshFailure("connection", commandFailureDetail(output.code, output)))
    return output.stdout
  }).pipe(Effect.scoped, Effect.timeout(input.timeout ?? 600_000), Effect.mapError(SshFailure.from))
})

export function commandFailureDetail(code: number | null, output: { stdout: string; stderr: string }) {
  // The CLI may report failures on stdout. Never include its private bootstrap
  // response in diagnostic text, even if shutdown fails after printing it.
  const stdout = output.stdout
    .replace(/OPENCODE_SSH_REGISTRATION_BEGIN[\s\S]*?(?:OPENCODE_SSH_REGISTRATION_END|$)/g, "")
    .trim()
  return [output.stderr.trim(), stdout].filter(Boolean).join("\n") || JSON.stringify({ exitCode: code })
}

export const sshHosts = Effect.fn("Ssh.hosts")(function* (
  filename?: string,
  seen = new Set<string>(),
): Effect.fn.Return<string[], never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = filename ?? path.join(homedir(), ".ssh", "config")
  if (seen.has(file) || seen.size >= 100) return []
  seen.add(file)
  const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  const lines = content.split(/\r?\n/).map((line) => line.trim().replace(/\s+#.*$/, ""))
  const hosts = lines.flatMap((line) =>
    /^host\s/i.test(line)
      ? line
          .split(/\s+/)
          .slice(1)
          .filter((host) => !/[!*?]/.test(host))
      : [],
  )
  const includes = lines.flatMap((line) => (/^include\s/i.test(line) ? line.split(/\s+/).slice(1) : []))
  for (const include of includes) {
    const pattern = include.startsWith("~/")
      ? path.join(homedir(), include.slice(2))
      : path.resolve(path.dirname(file), include)
    const dir = path.dirname(pattern)
    const match = new RegExp(
      "^" +
        path
          .basename(pattern)
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".") +
        "$",
    )
    const files = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    for (const name of files.filter((name) => match.test(name)))
      hosts.push(...(yield* sshHosts(path.join(dir, name), seen)))
  }
  return [...new Set(hosts)].sort()
})
