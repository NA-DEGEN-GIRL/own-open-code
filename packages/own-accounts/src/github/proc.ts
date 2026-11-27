export * as GitHubProc from "./proc.js"

import fs from "node:fs"
import path from "node:path"
import { GitHubCaller } from "./caller.js"

/**
 * Who asks an SSH host's git relay stub (16 §8, GH-39), on Linux: the Linux counterpart of the Windows caller check
 * (`GitHubCaller`). The loopback connection's client end is found in `/proc/net/tcp` (and `tcp6`), which names its
 * owner's uid and socket inode; the process holding that inode is found among `/proc/<pid>/fd`; its parents are read
 * from `/proc/<pid>/stat` (parent id and start time), each with its program (`/proc/<pid>/exe`, the kernel's own link
 * to the running file) and words (`/proc/<pid>/cmdline`). A caller is trusted only when
 *
 * - the connection's owner is this service's user,
 * - the nearest git transport or git-lfs above it runs exactly one of this service's git's programs ({@link images}:
 *   `git --exec-path`'s `git-remote-http`, `git-remote-https` and `git-lfs`, and the git-lfs on the service's PATH,
 *   each by its real path; a deleted or replaced file shows as `(deleted)` and is not trusted), and
 * - this service's own process is among its parents (a git the service's shells started, not one of the user's own
 *   terminals or another service of the same user), or one of its parents is a command this service started and named
 *   for one of its tickets ({@link Judge.commands}). Since upstream v2.3 core runs shell commands under its process
 *   daemon (`opencode-pty`, started detached and adopted by init when the service that started it ends), so the service
 *   need not be among a shell command's parents at all (MR18).
 *
 * A parent id another process took over (it started after its "child") ends the walk. Anything that cannot be read
 * leaves the caller untrusted. A trusted verdict also names the command the caller runs under: the nearest named command
 * on the way up, else the chain's process whose parent is this service (a git own-team started), so the stub can hold a
 * ticket to the command it was made for ({@link holds}, GH-48). What it cannot tell is in 16 §8.6 and §8.8: anything inside that command (a hook,
 * a credential helper, a Git LFS custom transfer program) runs the real programs with the command's ticket, and a
 * process of the same user may attach to them (ptrace) where the system allows it.
 */

/** What is read of `/proc`: real files on Linux, a fake tree in tests. */
export interface Proc {
  /** A file's text, or `undefined`. */
  readonly read: (file: string) => string | undefined
  /** A symbolic link's target, or `undefined`. */
  readonly link: (file: string) => string | undefined
  /** A folder's entries, or none. */
  readonly list: (dir: string) => ReadonlyArray<string>
}

export const system: Proc = {
  read: (file) => {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  },
  link: (file) => {
    try {
      return fs.readlinkSync(file)
    } catch {
      return undefined
    }
  },
  list: (dir) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  },
}

/** The programs that may ask: git's HTTP transport and git-lfs. */
export const CALLERS = new Set(["git-remote-http", "git-remote-https", "git-lfs"])

/** How many parents are read at most. */
const DEPTH = 24

export interface Judge {
  readonly proc?: Proc
  /** This service's process id (its descendants may ask). */
  readonly service?: number
  /** This service's user id. */
  readonly uid?: number
  /**
   * Whether `<pid>:<start time>` is the command process this service named for one of its live tickets
   * (`GitHubCredential.named`): a shell command under core's process daemon has no other tie to this service.
   */
  readonly commands?: (holder: string) => boolean
}

/**
 * The verdict for the client at `clientPort` of a loopback connection to `serverPort` against the trusted program
 * paths `images` (real paths).
 */
export function judge(
  clientPort: number | undefined,
  serverPort: number | undefined,
  images: ReadonlyArray<string>,
  options: Judge = {},
): Verdict {
  const proc = options.proc ?? system
  const service = options.service ?? process.pid
  const uid = options.uid ?? process.getuid?.()
  if (clientPort === undefined || serverPort === undefined || uid === undefined)
    return { trusted: false, operation: "push", via: "unknown" }
  const socket = connection(proc, clientPort, serverPort)
  if (!socket) return { trusted: false, operation: "push", via: "unknown" }
  if (socket.uid !== uid) return { trusted: false, operation: "push", via: "other_user" }
  const pid = owner(proc, socket.inode)
  if (pid === undefined) return { trusted: false, operation: "push", via: "unknown" }
  return verdict(ancestry(proc, pid), images, service, options.commands)
}

export interface Process extends GitHubCaller.Process {
  readonly ppid: number
  readonly start: number
}

/** A verdict with, when trusted, the command the caller runs under: its process id and start time (GH-48). */
export interface Verdict extends GitHubCaller.Verdict {
  readonly command?: { readonly pid: number; readonly start: number }
}

/** The verdict of a process chain (nearest first): exported for tests. */
export function verdict(
  chain: ReadonlyArray<Process>,
  images: ReadonlyArray<string>,
  service: number,
  commands: (holder: string) => boolean = () => false,
): Verdict {
  const at = chain.findIndex((item) => CALLERS.has(item.name))
  const caller = at < 0 ? undefined : chain[at]
  const operation = chain.slice(Math.max(at, 0)).some(GitHubCaller.pushes) ? "push" : "fetch"
  if (!caller) return { trusted: false, operation, via: chain.map((item) => item.name).join("<") || "none" }
  const exact = caller.image !== undefined && images.includes(caller.image)
  // A command this service named on the way up (a shell under core's process daemon), else the service's own child
  // (the walk reached the service through it).
  const command =
    chain.slice(at).find((item) => commands(`${item.pid}:${item.start}`)) ??
    (chain.slice(at + 1).some((item) => item.pid === service)
      ? chain.slice(at).find((item) => item.ppid === service)
      : undefined)
  if (!command) return { trusted: false, operation, via: `${caller.name} outside this service` }
  if (!exact) return { trusted: false, operation, via: caller.name }
  return { trusted: true, operation, via: caller.name, command: { pid: command.pid, start: command.start } }
}

/**
 * The holder name (`<pid>:<start time>`) of the command process `pid` this service just spawned, for
 * `GitHubCredential.started` (GH-48); `undefined` when it cannot be read or is neither this service's child nor a child
 * of core's process daemon (`opencode-pty`, which starts shell commands since upstream v2.3; the pid is the one core's
 * `shell.created` named).
 */
export function holder(proc: Proc, pid: number | undefined, service = process.pid) {
  if (pid === undefined) return undefined
  const item = details(proc, pid)
  if (!item) return undefined
  if (item.ppid === service || details(proc, item.ppid)?.name === DAEMON) return `${pid}:${item.start}`
  return undefined
}

/** core's process daemon (`packages/core/src/persistent-pty`, installed as `opencode-pty`). */
const DAEMON = "opencode-pty"

/** The prefix of the ticket's `http.<stub>.extraHeader` value (`GitHubCredential.relayEnvironment`). */
export const TICKET_VALUE = "X-Own-GitHub-Ticket: "

/**
 * Whether the command process `pid` holds exactly `ticket` (GH-48): its environment (`/proc/<pid>/environ`) has the
 * ticket's git variable, and no other ticket. That file is what the process last started with: a process that read
 * another command's ticket can start itself again (`exec`) with it, so this check alone does not tie the ticket to its
 * command; the process named when the command started does (`GitHubCredential.started`, `bind`).
 */
export function holds(proc: Proc, pid: number, ticket: string) {
  const environ = proc.read(`/proc/${pid}/environ`)
  if (environ === undefined) return false
  const tickets = environ
    .split("\0")
    .flatMap((entry) => {
      const at = entry.indexOf("=")
      return at > 0 && /^GIT_CONFIG_VALUE_\d+$/.test(entry.slice(0, at)) ? [entry.slice(at + 1)] : []
    })
    .filter((value) => value.startsWith(TICKET_VALUE))
    .map((value) => value.slice(TICKET_VALUE.length))
  return tickets.length > 0 && tickets.every((value) => value === ticket)
}

/**
 * The real paths of this service's git's programs that may ask: `git --exec-path`'s `git-remote-http`,
 * `git-remote-https` and `git-lfs`, and the git-lfs on this service's PATH; only those that exist.
 */
export function images() {
  const git = Bun.which("git")
  const lfs = Bun.which("git-lfs")
  const exec = git === null ? undefined : execPath(git)
  const candidates = [
    ...(exec === undefined ? [] : ["git-remote-http", "git-remote-https", "git-lfs"].map((name) => path.join(exec, name))),
    ...(lfs === null ? [] : [lfs]),
  ]
  return [...new Set(candidates.flatMap(real))]
}

function real(file: string) {
  try {
    return [fs.realpathSync(file)]
  } catch {
    return []
  }
}

/** git's exec path, asked of git itself with an allow-list environment. */
function execPath(git: string) {
  const done = Bun.spawnSync([git, "--exec-path"], {
    env: { PATH: path.dirname(git) },
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  const text = done.success ? done.stdout.toString().trim() : ""
  return text === "" ? undefined : text
}

/** 127.0.0.1 in `/proc/net/tcp` (little-endian hex) and as an IPv4-mapped IPv6 address in `tcp6`. */
const LOOPBACK = new Set(["0100007F", "0000000000000000FFFF00000100007F"])
const ESTABLISHED = "01"

/** The client end of the connection: its owner's uid and socket inode, or `undefined`. */
export function connection(proc: Proc, clientPort: number, serverPort: number) {
  const rows = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) =>
    (proc.read(file) ?? "").split("\n").slice(1).flatMap(row),
  )
  const found = rows.find(
    (item) =>
      item.localPort === clientPort &&
      item.remotePort === serverPort &&
      item.state === ESTABLISHED &&
      LOOPBACK.has(item.local),
  )
  return found === undefined ? undefined : { uid: found.uid, inode: found.inode }
}

/** One line of `/proc/net/tcp`: `sl local rem st tx:rx tr:when retrnsmt uid timeout inode …`. */
function row(line: string) {
  const words = line.trim().split(/\s+/)
  if (words.length < 10) return []
  const [localAddress, localPort] = (words[1] ?? "").split(":")
  const [, remotePort] = (words[2] ?? "").split(":")
  const uid = Number(words[7])
  const inode = words[9] ?? ""
  if (!localAddress || !localPort || !remotePort || !Number.isInteger(uid) || !/^\d+$/.test(inode)) return []
  return [
    {
      local: localAddress.toUpperCase(),
      localPort: Number.parseInt(localPort, 16),
      remotePort: Number.parseInt(remotePort, 16),
      state: words[3] ?? "",
      uid,
      inode,
    },
  ]
}

/** The process holding socket `inode` (only this user's processes can be read). */
export function owner(proc: Proc, inode: string) {
  const target = `socket:[${inode}]`
  const pids = proc
    .list("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
  return pids.find((pid) => proc.list(`/proc/${pid}/fd`).some((fd) => proc.link(`/proc/${pid}/fd/${fd}`) === target))
}

/** `pid` and its parents, nearest first, each with its program, words, parent id and start time. */
export function ancestry(proc: Proc, pid: number): Process[] {
  const walk = (at: number, depth: number, born: number | undefined): Process[] => {
    if (depth >= DEPTH) return []
    const item = details(proc, at)
    if (!item) return []
    // A parent id may name a newer process that took over a dead parent's id: it started after its "child".
    if (born !== undefined && item.start > born) return []
    if (item.ppid <= 0 || item.ppid === at) return [item]
    return [item, ...walk(item.ppid, depth + 1, item.start)]
  }
  return walk(pid, 0, undefined)
}

/** `/proc/<pid>/stat`'s parent and start time (after the name in parentheses), its program and its words. */
function details(proc: Proc, pid: number): Process | undefined {
  const stat = proc.read(`/proc/${pid}/stat`)
  if (stat === undefined) return undefined
  const close = stat.lastIndexOf(")")
  if (close < 0) return undefined
  // After `pid (comm) `: state is field 3, the parent field 4, the start time field 22.
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  const ppid = Number(fields[1])
  const start = Number(fields[19])
  if (!Number.isInteger(ppid) || !Number.isFinite(start)) return undefined
  const exe = proc.link(`/proc/${pid}/exe`)
  const words = proc.read(`/proc/${pid}/cmdline`)
  const argv = words === undefined ? undefined : words.split("\0").filter((word, index, all) => word !== "" || index < all.length - 1)
  // A program replaced or deleted since it started reads `<path> (deleted)`: never one of the trusted paths.
  const name = path.posix.basename((exe ?? stat.slice(stat.indexOf("(") + 1, close)).replace(/ \(deleted\)$/, ""))
  return {
    pid,
    name,
    ppid,
    start,
    ...(exe === undefined ? {} : { image: exe }),
    ...(argv === undefined ? {} : { argv }),
  }
}
