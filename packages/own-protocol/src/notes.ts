export * as Notes from "./notes.js"

// Workspace notes (05 §8.8, the workspace `노트` tab): limits and the workspace key every client derives the same way.
// Plain functions without the schema graph, so own-web's notes chunk imports them without Effect.

/** Title length of one note in UTF-16 code units, like the browser's input field counts. */
export const TITLE_MAX = 200
/**
 * Text length of one note. A note of Hangul at this length is about 600 KB of JSON, which the gateway reads for
 * `notes.put` (its 1 MiB body limit, 05 §13.4); every other RPC body stays at 64 KiB.
 */
export const TEXT_MAX = 200_000
/** Notes one workspace holds. */
export const PER_WORKSPACE_MAX = 200
/** Longest workspace key. */
export const WORKSPACE_MAX = 4_096
/** Note ids: the browser's `crypto.randomUUID()` and the like. No separators, no control characters. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Where a workspace lives: `host` is an SSH host id (`OwnRemote.HostID`), absent for this PC's own projects. */
export interface Place {
  readonly host?: string
  readonly directory: string
}

const CONTROL = /[\u0000-\u001f\u007f]/
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/
const HOST = /^h-[a-z0-9]{6,8}$/
const SSH = /^ssh:(h-[a-z0-9]{6,8}):/

/**
 * The key of a workspace's notes: `local:<directory>` for a project on this PC, `ssh:<hostId>:<directory>` for one on
 * an SSH host (the remote directory; the notes still live on this PC). The desktop app, a phone through the gateway
 * and another PC's window all name a project by the same server key (`local` or the host id) and the directory the
 * service reports, so they all reach the same notes. `undefined` when the directory is not absolute, holds a control
 * character or the host is not a host id.
 */
export function workspaceKey(place: Place) {
  const directory = normalizeDirectory(place.directory)
  if (directory === undefined) return undefined
  if (place.host !== undefined && !HOST.test(place.host)) return undefined
  const key = place.host === undefined ? `local:${directory}` : `ssh:${place.host}:${directory}`
  return key.length <= WORKSPACE_MAX ? key : undefined
}

/** Whether `key` is exactly what {@link workspaceKey} writes (the RPC boundary's check). */
export function isWorkspaceKey(key: string) {
  const ssh = SSH.exec(key)
  const place = key.startsWith("local:")
    ? { directory: key.slice("local:".length) }
    : ssh
      ? { host: ssh[1], directory: key.slice(ssh[0].length) }
      : undefined
  return place !== undefined && workspaceKey(place) === key
}

/**
 * One spelling per server directory. Windows paths (a drive or `\\server\share`) use `\` and lower case: their file
 * systems ignore case, and the service, the picker and the old app spell drive letters differently. POSIX paths keep
 * their case. Repeated separators, `.` and `..` are resolved (never above the root) and only a root keeps its
 * trailing separator.
 */
export function normalizeDirectory(directory: string) {
  if (CONTROL.test(directory)) return undefined
  const unc = directory.startsWith("\\\\")
  if (unc || DRIVE.test(directory)) {
    const parts = directory.replaceAll("/", "\\").split("\\").filter(Boolean)
    const root = unc ? `\\\\${parts[0]}\\${parts[1]}` : `${parts[0]}\\`
    if (unc && parts.length < 2) return undefined
    const rest = resolve(parts.slice(unc ? 2 : 1))
    const path = unc ? [root, ...rest].join("\\") : root + rest.join("\\")
    return path.toLowerCase()
  }
  if (!directory.startsWith("/")) return undefined
  return `/${resolve(directory.split("/").filter(Boolean)).join("/")}`
}

function resolve(parts: readonly string[]) {
  return parts.reduce<string[]>((stack, part) => {
    if (part === ".") return stack
    if (part === "..") return stack.slice(0, -1)
    return [...stack, part]
  }, [])
}
