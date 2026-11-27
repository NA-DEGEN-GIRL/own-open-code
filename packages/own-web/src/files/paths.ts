// Paths of the files tab (03 §19.4). Tree rows, tabs, links and quick open results share one form: `/` separators,
// relative to the session's location when the file is inside it ("src/router.ts"), absolute otherwise
// ("C:/other/notes.md"). `fs.list`/`fs.find` answer location-relative paths with the platform separator and a
// trailing one for folders (`src\`), `fs.read` only reads inside the location (core `filesystem.ts` resolve), and the
// agent writes links as relative or absolute paths with `:line` or `#L` suffixes.
import { resolveArtifactPath } from "./upstream/artifact"
import { resolveOpenInAppPath } from "./upstream/open-in-app-path"

export interface FileTarget {
  readonly path: string
  readonly line?: number
}

/** `src\lib\a.ts\` → `src/lib/a.ts`; `./a.ts` → `a.ts`; roots (`/`, `C:/`) keep their slash. */
export function normalizePath(value: string) {
  const unified = value.replaceAll("\\", "/")
  const unc = unified.startsWith("//")
  const collapsed = unified.replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "")
  const trimmed = /^([A-Za-z]:)?\/$/.test(collapsed) ? collapsed : collapsed.replace(/\/+$/, "")
  return unc ? `/${trimmed}` : trimmed
}

export function isAbsolute(path: string) {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path)
}

export function basename(path: string) {
  return normalizePath(path).split("/").at(-1) ?? path
}

/** Parent of a normalized path; "" for a top-level entry. */
export function dirname(path: string) {
  const index = path.lastIndexOf("/")
  if (index < 0) return ""
  if (index === 0) return "/"
  return path.slice(0, index)
}

/** Folders to expand to show `path` in the tree: `a/b/c.ts` → [`a`, `a/b`]. */
export function ancestors(path: string) {
  const parts = path.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

/**
 * A link or typed query → the file and line it names: `src/a.ts:12`, `src/a.ts:12:3`, `src/a.ts#L12` (`#L12-20`),
 * `file:///C:/x/a.ts`, `<C:\x\a.ts>`, `` `a.ts` ``. `undefined` for URLs of other schemes and empty text.
 */
export function parseLink(raw: string): FileTarget | undefined {
  const text = raw.trim().replace(/^[`'"<(]+|[`'">)]+$/g, "")
  if (!text) return
  const file = /^file:/i.test(text) ? fileUrlPath(text) : text
  if (file === undefined) return
  // A scheme (`https:`, `mailto:`), not a drive letter (`C:/`) and not `name.ts:12`.
  if (/^[a-z][a-z\d+.-]*:(?!\d+(?::\d+)?$)/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return
  const hash = /#L(\d+)(?:-L?\d+)?$/i.exec(file)
  const colon = hash ? undefined : /:(\d+)(?::\d+)?$/.exec(file)
  const match = hash ?? colon
  const path = normalizePath(decode(match ? file.slice(0, match.index) : file))
  if (!path) return
  const line = match ? Number(match[1]) : undefined
  return line && line > 0 ? { path, line } : { path }
}

/**
 * The tab form of `path` for a location: absolute paths inside `root` become relative (drive letters and Windows
 * paths compare case-insensitively), relative ones resolve `.`/`..` against the root; `base` is the folder of the
 * file a link came from (markdown links). `inside: false` means `fs.read` cannot serve it.
 */
export function locate(root: string, path: string, base = ""): { readonly path: string; readonly inside: boolean } {
  const home = normalizePath(root)
  const value = normalizePath(path)
  if (isAbsolute(value)) return inside(home, value)
  const relative = resolveArtifactPath(base, value)
  if (relative !== undefined) return { path: relative, inside: true }
  // Climbs past the root: resolve from the referencing folder's absolute location.
  return inside(home, normalizePath(resolveArtifactPath(base ? `${home}/${base}` : home, value) ?? value))
}

/** Native absolute path for editors and Explorer (`C:\repo\src\a.ts`, `/home/u/repo/src/a.ts`). */
export function absolutePath(root: string, path: string) {
  if (isAbsolute(path)) return windowsRoot(root) ? path.replaceAll("/", "\\") : path
  return resolveOpenInAppPath(root, path)
}

function inside(root: string, path: string) {
  const windows = windowsRoot(root)
  const compare = (value: string) => (windows ? value.toLowerCase() : value)
  const prefix = root.endsWith("/") ? root : `${root}/`
  if (compare(path) === compare(root)) return { path: "", inside: true }
  if (compare(path).startsWith(compare(prefix))) return { path: path.slice(prefix.length), inside: true }
  return { path, inside: false }
}

function windowsRoot(root: string) {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\")
}

function fileUrlPath(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.hostname && url.hostname !== "localhost") return
  return decode(url.pathname.replace(/^\/([a-z]:\/)/i, "$1")) + url.hash
}

function decode(value: string) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
