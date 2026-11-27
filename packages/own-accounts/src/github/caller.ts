export * as GitHubCaller from "./caller.js"

import { existsSync } from "node:fs"
import path from "node:path"
import { dlopen, ptr } from "bun:ffi"

/**
 * Who asks own's git login listener (16 §6.3, GH-19), on Windows: the process at the other end of the loopback
 * connection (the TCP table, `GetExtendedTcpTable`) and its parents (a process snapshot), each with its program's path
 * and command line. git's own HTTP transport (`git-remote-http(s)`) and git-lfs, exactly the programs of the git this
 * service runs ({@link images}, GH-34), are the only callers that get a login: an agent that reads the ticket from its
 * environment and asks with curl, runs `git credential fill` itself, or copies a program into the folder gets nothing.
 * A push (`git push`, `git send-pack`, git-lfs's `push` and `pre-push`) is told apart from a fetch by the command lines
 * above the caller, and a git command line own cannot read to its subcommand counts as a push (GH-28). Elsewhere no
 * caller is trusted here ({@link CHECKED}): this PC's credential listener answers on Windows only. An SSH host's git goes
 * through the host's relay stub instead (16 §8), whose caller check is this one on a Windows host and `GitHubProc`'s
 * `/proc` check on Linux (`GitHubRelayStub.judge`).
 */

/** Whether callers are read here: on Windows only. Off Windows git gets no login through own. */
export const CHECKED = process.platform === "win32"

export interface Process {
  readonly pid: number
  /** The program's file name (`git-remote-https.exe`), lower case. */
  readonly name: string
  /** The program's full path, when the process could be opened. */
  readonly image?: string
  readonly command?: string
  /** The process's words as the system gave them (Linux `/proc/<pid>/cmdline`); else read from {@link command}. */
  readonly argv?: ReadonlyArray<string>
}

export type Operation = "push" | "fetch"

export interface Verdict {
  /** A trusted caller (git's HTTP transport or git-lfs of this service's git) asks. */
  readonly trusted: boolean
  readonly operation: Operation
  /** The caller's program name, or what was found instead. */
  readonly via: string
}

/** Programs that may get a login: git's HTTP transport and git-lfs. */
export const CALLERS = new Set(["git-remote-http.exe", "git-remote-https.exe", "git-lfs.exe"])

/** How many parents are read at most (curl, sh and its fork, the caller, git, a hook's sh, git-lfs, git, a shell…). */
const DEPTH = 16

/**
 * The verdict for the client at `clientPort` of a loopback connection to `serverPort`. A caller that cannot be found
 * (no client address, the table or the snapshot fails) is not trusted, nor is any caller off Windows (GH-34).
 * `reread` reads the trusted programs again, see {@link verdict}.
 */
export function judge(
  clientPort: number | undefined,
  serverPort: number | undefined,
  images: ReadonlyArray<string>,
  reread?: () => ReadonlyArray<string>,
): Verdict {
  if (!CHECKED) return { trusted: false, operation: "push", via: "unchecked" }
  const chain = clientPort === undefined || serverPort === undefined ? undefined : ancestry(clientPort, serverPort)
  if (!chain) return { trusted: false, operation: "push", via: "unknown" }
  return verdict(chain, images, reread)
}

/**
 * The verdict of a process chain (nearest first) against the trusted program paths: exported for tests. A caller
 * program that was read but is not among `images` asks `reread` for them once more before it is refused, only when
 * `images` went stale ({@link stale}): a Git updated while the service runs moves them (Git for Windows 2.56 moved
 * `mingw64` to `ucrt64`), and the list read before would refuse every git login until own restarted.
 */
export function verdict(
  chain: ReadonlyArray<Process>,
  images: ReadonlyArray<string>,
  reread?: () => ReadonlyArray<string>,
): Verdict {
  const at = chain.findIndex((item) => CALLERS.has(item.name))
  const caller = at < 0 ? undefined : chain[at]
  const operation = chain.slice(Math.max(at, 0)).some(pushes) ? "push" : "fetch"
  if (!caller) return { trusted: false, operation, via: chain.map((item) => item.name).join("<") || "none" }
  const image = caller.image === undefined ? undefined : path.resolve(caller.image).toLowerCase()
  const listed = (list: ReadonlyArray<string>) => list.some((item) => path.resolve(item).toLowerCase() === image)
  const trusted =
    image !== undefined && (listed(images) || (reread !== undefined && stale(images) && listed(reread())))
  return { trusted, operation, via: caller.name }
}

/**
 * Whether the trusted programs read before no longer describe an installed git, so a refused git program reads them
 * again: none was found, or one of them is gone. Git for Windows' installer runs the previous version's uninstaller
 * before it installs (`CleanupWhenUpgrading` in build-extra's `install.iss`), so an update from 2.55 to 2.56 removes the
 * `mingw64` programs on the list. While every listed program still exists the list is kept until own restarts, as
 * before GU-2: a git-lfs put into a PATH folder ahead of Git's, or another install's git, reads nothing and is refused,
 * and starts no `git --exec-path` in the listener's request (GU-10).
 */
function stale(images: ReadonlyArray<string>) {
  return images.length === 0 || images.some((file) => !existsSync(file))
}

/**
 * The exact programs of this service's git that may ask (GH-34): `git-remote-http.exe` and `git-remote-https.exe` in
 * git's exec path (`git --exec-path`), and git-lfs where git finds it (its exec path, Git for Windows' `mingw64\bin`
 * or, from 2.56, `ucrt64\bin`) or on this service's PATH. Only those that exist.
 */
export function images() {
  const git = Bun.which("git") ?? undefined
  return programs(git, git === undefined ? undefined : execPath(git), Bun.which("git-lfs") ?? undefined)
}

/** {@link images} of a git at `git` with the exec path `exec` and a git-lfs on PATH at `lfs`: exported for tests. */
export function programs(git: string | undefined, exec: string | undefined, lfs: string | undefined) {
  const root = git === undefined ? undefined : gitRoot(git)
  const candidates = [
    ...(exec === undefined
      ? []
      : ["git-remote-http.exe", "git-remote-https.exe", "git-lfs.exe"].map((name) => path.join(exec, name))),
    ...(root === undefined ? [] : PREFIXES.map((prefix) => path.join(root, prefix, "bin", "git-lfs.exe"))),
    ...(lfs === undefined ? [] : [lfs]),
  ]
  return [...new Set(candidates.filter((file) => existsSync(file)).map((file) => path.resolve(file)))]
}

/**
 * Git for Windows' folder of its own programs under its root: `mingw64` up to 2.55, `ucrt64` from 2.56, which moved git
 * and git-lfs there (`cmd` and `bin` keep launchers that start them as one more process).
 */
const PREFIXES = ["mingw64", "ucrt64"]

/** git's exec path, asked of git itself with an allow-list environment. */
function execPath(git: string) {
  const done = Bun.spawnSync([git, "--exec-path"], {
    env: {
      PATH: path.dirname(git),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    },
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  })
  const text = done.success ? done.stdout.toString().trim() : ""
  return text === "" ? undefined : path.resolve(text)
}

/**
 * Git for Windows' folder of `git.exe` (`<root>\cmd`, `<root>\bin`, `<root>\mingw64\bin`, `<root>\ucrt64\bin`): the
 * folder above git's, or above that when it is `mingw64` or `ucrt64`, as tool-updates' `gitInstall` reads it. A folder
 * of that name higher up (a Git installed under `D:\ucrt64\tools\Git`) is not Git's.
 */
function gitRoot(git: string) {
  const up = path.dirname(path.dirname(path.resolve(git)))
  return PREFIXES.includes(path.basename(up).toLowerCase()) ? path.dirname(up) : up
}

/**
 * Whether a process is a push: `git [options] push|send-pack`, `git-lfs push|pre-push`. For git, a command line whose
 * options before the subcommand own cannot read, or that holds a word `push` or `send-pack` anywhere (an alias's value
 * such as `alias.up=push` too), counts as a push (GH-28): only read-only accounts are refused for it. Names with or
 * without `.exe` (an SSH host's Linux processes, 16 §8).
 */
export function pushes(item: Process) {
  const all = item.argv ?? (item.command === undefined ? undefined : argv(item.command))
  if (all === undefined) return false
  const words = all.slice(1)
  const name = item.name.replace(/\.exe$/, "")
  if (name === "git") {
    if (words.some((word) => /(?:^|[=\s])(?:push|send-pack)(?:\s|$)/i.test(word))) return true
    const found = subcommand(words)
    return found === undefined || found === "push" || found === "send-pack"
  }
  if (name === "git-lfs") return ["push", "pre-push"].includes(subcommand(words) ?? "")
  return false
}

/** git's options before the subcommand that take the next word as their value. */
const VALUED = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--attr-source",
  "--shallow-file",
  "--list-cmds",
])

/** git's options before the subcommand that take no value (or carry it after `=`, `--exec-path[=<path>]`). */
const FLAGS = new Set([
  "-p",
  "-P",
  "--paginate",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
])

/**
 * The subcommand after git's own options, or `undefined` when an option before it is not one own knows: a git option
 * own does not know may take a value own would read as the subcommand (`--attr-source HEAD push` read `HEAD`, GH-28).
 */
function subcommand(words: ReadonlyArray<string>): string | undefined {
  const [first, ...rest] = words
  if (first === undefined) return undefined
  if (VALUED.has(first)) return subcommand(rest.slice(1))
  const name = first.includes("=") ? first.slice(0, first.indexOf("=")) : first
  if (first.startsWith("--") && first.includes("=") && (VALUED.has(name) || FLAGS.has(name))) return subcommand(rest)
  if (FLAGS.has(first)) return subcommand(rest)
  if (first.startsWith("-")) return undefined
  return first.toLowerCase()
}

/** A Windows command line's words (the C runtime's quoting, enough for git's own command lines). */
export function argv(command: string) {
  const words: string[] = []
  const state = { word: "", open: false, quoted: false }
  for (const char of command) {
    if (char === '"') {
      state.quoted = !state.quoted
      state.open = true
      continue
    }
    if (!state.quoted && (char === " " || char === "\t")) {
      if (state.open) words.push(state.word)
      state.word = ""
      state.open = false
      continue
    }
    state.word += char
    state.open = true
  }
  if (state.open) words.push(state.word)
  return words
}

// ---------------------------------------------------------------------------------------------------------------
// Windows: the TCP table, the process snapshot, a process's path and command line (bun:ffi)

interface Native {
  readonly owner: (local: number, remote: number) => number | undefined
  readonly parents: () => Map<number, { readonly parent: number; readonly name: string }>
  readonly details: (pid: number) => { readonly image?: string; readonly command?: string; readonly created?: bigint }
}

const NATIVE = Symbol.for("own-open-code.github-caller-native")

function ancestry(clientPort: number, serverPort: number): Process[] | undefined {
  const native = load()
  if (!native) return undefined
  const pid = native.owner(clientPort, serverPort)
  if (pid === undefined) return undefined
  const table = native.parents()
  const walk = (at: number, depth: number, born: bigint | undefined): Process[] => {
    const known = table.get(at)
    if (!known || depth >= DEPTH) return []
    const details = native.details(at)
    // A parent id may name a newer process that took over a dead parent's id: it was started after its "child".
    if (born !== undefined && details.created !== undefined && details.created > born) return []
    const item = { pid: at, name: known.name.toLowerCase(), ...details }
    if (known.parent === 0 || known.parent === at) return [item]
    return [item, ...walk(known.parent, depth + 1, details.created)]
  }
  return walk(pid, 0, undefined)
}

function load(): Native | undefined {
  const holder = globalThis as unknown as Record<symbol, Native | null | undefined>
  const known = holder[NATIVE]
  if (known !== undefined) return known ?? undefined
  const created = open()
  holder[NATIVE] = created ?? null
  return created
}

function open(): Native | undefined {
  // A failed load leaves every caller untrusted (fail closed), never trusted.
  const libraries = (() => {
    try {
      return {
        kernel: dlopen("kernel32.dll", {
          CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
          Process32FirstW: { args: ["u64", "ptr"], returns: "i32" },
          Process32NextW: { args: ["u64", "ptr"], returns: "i32" },
          CloseHandle: { args: ["u64"], returns: "i32" },
          OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
          QueryFullProcessImageNameW: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
          GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
        }),
        ip: dlopen("iphlpapi.dll", {
          GetExtendedTcpTable: { args: ["ptr", "ptr", "i32", "u32", "u32", "u32"], returns: "u32" },
        }),
        nt: dlopen("ntdll.dll", {
          NtQueryInformationProcess: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
        }),
      }
    } catch {
      return undefined
    }
  })()
  if (!libraries) return undefined
  const kernel = libraries.kernel.symbols
  const AF_INET = 2
  const TCP_TABLE_OWNER_PID_CONNECTIONS = 4
  const TH32CS_SNAPPROCESS = 2
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  const PROCESS_COMMAND_LINE_INFORMATION = 60
  const ENTRY_SIZE = 568
  const INVALID = 0xffffffffffffffffn

  const owner = (local: number, remote: number) => {
    const size = new Uint32Array(1)
    libraries.ip.symbols.GetExtendedTcpTable(null, size, 0, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0)
    // Connections come and go between the two calls: room for more.
    const buffer = new Uint8Array(size[0]! + 64 * 24)
    size[0] = buffer.length
    const status = libraries.ip.symbols.GetExtendedTcpTable(buffer, size, 0, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0)
    if (status !== 0) return undefined
    const view = new DataView(buffer.buffer)
    const rows = view.getUint32(0, true)
    // MIB_TCPROW_OWNER_PID: state, local address, local port, remote address, remote port, pid (ports big-endian).
    const row = Array.from({ length: rows }, (_, index) => 4 + index * 24).find(
      (at) =>
        view.getUint16(at + 8, false) === local &&
        view.getUint16(at + 16, false) === remote &&
        view.getUint32(at + 4, true) === LOOPBACK,
    )
    return row === undefined ? undefined : view.getUint32(row + 20, true)
  }

  const parents = () => {
    const found = new Map<number, { readonly parent: number; readonly name: string }>()
    const snapshot = kernel.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if (snapshot === INVALID || snapshot === 0n) return found
    const entry = new Uint8Array(ENTRY_SIZE)
    const view = new DataView(entry.buffer)
    view.setUint32(0, ENTRY_SIZE, true)
    // PROCESSENTRY32W (x64): pid at 8, parent pid at 32, the file name (260 UTF-16 units) at 44.
    for (let more = kernel.Process32FirstW(snapshot, entry); more; more = kernel.Process32NextW(snapshot, entry)) {
      const units = new Uint16Array(entry.buffer, 44, 260)
      const end = units.indexOf(0)
      found.set(view.getUint32(8, true), {
        parent: view.getUint32(32, true),
        name: String.fromCharCode(...units.subarray(0, end < 0 ? 260 : end)),
      })
    }
    kernel.CloseHandle(snapshot)
    return found
  }

  const details = (pid: number) => {
    const handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (handle === 0n) return {}
    const image = new Uint16Array(1024)
    const length = new Uint32Array([image.length])
    const named = kernel.QueryFullProcessImageNameW(handle, 0, image, length) !== 0
    const times = new BigUint64Array(4)
    const timed =
      kernel.GetProcessTimes(handle, times.subarray(0, 1), times.subarray(1, 2), times.subarray(2, 3), times.subarray(3)) !==
      0
    const line = new Uint8Array(32 * 1024)
    const written = new Uint32Array(1)
    const status = libraries.nt.symbols.NtQueryInformationProcess(
      handle,
      PROCESS_COMMAND_LINE_INFORMATION,
      line,
      line.length,
      written,
    )
    kernel.CloseHandle(handle)
    const command = status === 0 ? commandLine(line, ptr(line)) : undefined
    return {
      ...(named ? { image: String.fromCharCode(...image.subarray(0, length[0])) } : {}),
      ...(timed ? { created: times[0]! } : {}),
      ...(command === undefined ? {} : { command }),
    }
  }

  return { owner, parents, details }
}

/** 127.0.0.1 as the TCP table stores it (network order read as a little-endian number). */
const LOOPBACK = 0x0100007f

/** The UNICODE_STRING NtQueryInformationProcess wrote at the start of `buffer` (its text follows it there). */
function commandLine(buffer: Uint8Array, address: number) {
  const view = new DataView(buffer.buffer)
  const bytes = view.getUint16(0, true)
  const offset = Number(view.getBigUint64(8, true) - BigInt(address))
  if (offset < 0 || offset + bytes > buffer.length) return undefined
  return new TextDecoder("utf-16le").decode(buffer.subarray(offset, offset + bytes))
}
