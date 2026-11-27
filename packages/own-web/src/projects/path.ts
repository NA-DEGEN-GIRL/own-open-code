// Server paths for the project picker (03 §18.3, 04 §17.4). The server may be Windows or POSIX whatever the browser
// runs on, so nothing here uses the browser's platform. Paths never go into route URLs (only project ids do); they
// travel as query parameters that the client encodes (`#`, `%`, spaces, Hangul — own/FORK.md "Windows # path").
// Pure functions, unit-tested in path.test.ts.

const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/
const UNC = /^\\\\[^\\/]+[\\/][^\\/]+/

export function isWindowsPath(path: string) {
  return DRIVE.test(path) || path.startsWith("\\\\")
}

export function pathSep(path: string): "\\" | "/" {
  return isWindowsPath(path) || (path.includes("\\") && !path.includes("/")) ? "\\" : "/"
}

export function isAbsolutePath(path: string) {
  return DRIVE.test(path) || path.startsWith("/") || path.startsWith("\\\\")
}

/**
 * What the user typed or pasted, cleaned: surrounding quotes (Explorer's "Copy as path"), whitespace, a bare drive
 * (`D:` → `D:\`), repeated separators and a trailing separator. Relative input stays relative.
 */
export function normalizeInput(value: string) {
  const unquoted = value
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim()
  if (!unquoted) return ""
  if (/^[A-Za-z]:$/.test(unquoted)) return `${unquoted[0]!.toUpperCase()}:\\`
  if (isWindowsPath(unquoted)) {
    const unc = unquoted.startsWith("\\\\")
    const body = unquoted.replaceAll("/", "\\").replace(/\\{2,}/g, "\\")
    const joined = unc ? `\\${body}` : body
    const drive = DRIVE.exec(joined)
    return trimSep(drive ? `${drive[1]!.toUpperCase()}${joined.slice(1)}` : joined)
  }
  return trimSep(unquoted.replace(/\/{2,}/g, "/"))
}

/** Removes trailing separators, keeping roots (`C:\`, `/`, `\\server\share`). */
export function trimSep(path: string) {
  if (/^[A-Za-z]:[\\/]*$/.test(path)) return `${path.slice(0, 2)}\\`
  if (/^\/+$/.test(path)) return "/"
  return path.replace(/[\\/]+$/, "")
}

/** `C:\`, `/` or `\\server\share`; `undefined` for relative paths. */
export function rootOf(path: string) {
  const drive = DRIVE.exec(path)?.[1]
  if (drive) return `${drive.toUpperCase()}:\\`
  const unc = UNC.exec(path)?.[0]
  if (unc) return unc.replaceAll("/", "\\")
  return path.startsWith("/") ? "/" : undefined
}

export function isRoot(path: string) {
  const root = rootOf(path)
  return root !== undefined && samePath(root, path)
}

/** Last segment; entries from `fs.list` end with a separator (`src\`), which is ignored. Roots return themselves. */
export function baseName(path: string) {
  if (isRoot(path)) return trimSep(path)
  const trimmed = path.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

export function parentPath(path: string): string | undefined {
  const trimmed = trimSep(path)
  if (isRoot(trimmed)) return undefined
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  if (index < 0) return undefined
  const parent = trimmed.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent || "/"
}

export function joinPath(directory: string, name: string) {
  const sep = pathSep(directory)
  const base = trimSep(directory)
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`
}

/** Breadcrumb of an absolute path: the root first, then each folder with the absolute path it opens. */
export function crumbs(path: string): { readonly label: string; readonly path: string }[] {
  const root = rootOf(path)
  if (!root) return []
  const rest = trimSep(path).slice(root.length).split(/[\\/]/).filter(Boolean)
  const items = [{ label: root, path: root }]
  rest.reduce((current, name) => {
    const next = joinPath(current, name)
    items.push({ label: name, path: next })
    return next
  }, root)
  return items
}

/** Roots of the given absolute paths, in first-seen order (the "드라이브" row: no API lists drives). */
export function rootsOf(paths: readonly string[]) {
  return [...new Set(paths.flatMap((path) => rootOf(path) ?? []))]
}

/** Case-insensitive and separator-insensitive on Windows paths (drive letter case differs between sources, 16.3). */
export function samePath(a: string, b: string) {
  const left = trimSep(a)
  const right = trimSep(b)
  if (pathSep(left) !== "\\" && pathSep(right) !== "\\") return left === right
  return left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase()
}

/**
 * Folders that must not become a project Location: a drive root, a user's home (01 G15: the service's cwd is the
 * home directory and its watcher would cover everything under it) and own's control location.
 */
export function tooBroad(path: string, control?: string): "root" | "home" | "control" | undefined {
  const trimmed = trimSep(path)
  if (isRoot(trimmed)) return "root"
  if (/^[A-Za-z]:\\Users\\[^\\]+$/i.test(trimmed.replaceAll("/", "\\"))) return "home"
  if (/^\/(home|Users)\/[^/]+$/.test(trimmed) || trimmed === "/root") return "home"
  if (control && samePath(trimmed, control)) return "control"
  return undefined
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Folder names from `fs.list` entries (paths relative to the control location, directories end with a separator). */
export function folderNames(entries: readonly { readonly path: string; readonly type: string }[]) {
  return entries
    .filter((entry) => entry.type === "directory")
    .map((entry) => baseName(entry.path))
    .filter((name) => name && name !== "." && name !== "..")
    .sort(collator.compare)
}

/** Prefix matches first, then other matches; case-insensitive. */
export function filterNames(names: readonly string[], query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return names
  const prefix = names.filter((name) => name.toLowerCase().startsWith(needle))
  const inner = names.filter((name) => !name.toLowerCase().startsWith(needle) && name.toLowerCase().includes(needle))
  return [...prefix, ...inner]
}
