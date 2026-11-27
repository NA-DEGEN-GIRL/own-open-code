// Ports packages/coding-agent/src/core/tools/path-utils.ts and the path helpers of utils/paths.ts: how Pi's file tools
// read a path the model wrote. Unicode space variants become spaces, a leading `@` goes, Git Bash/MSYS/Cygwin/WSL drive
// paths (`/c/work`) become Windows paths on Windows, `~` expands, `file://` URLs convert, and relative paths resolve
// against the working directory. `read` also tries the macOS screenshot-name variants when the path does not exist.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiPaths from "./paths.js"

import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const NARROW_NO_BREAK_SPACE = "\u202F"

/** `normalizeWindowsShellPath`: `/c/x`, `/mnt/c/x`, `/cygdrive/c/x` → `C:\x`. */
export function normalizeWindowsShellPath(file: string) {
  if (!file.startsWith("/") || file.startsWith("//") || file.includes("\\")) return file
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(file)
  if (match === null) return file
  return `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`
}

/** `normalizePath` with the file tools' options (unicode spaces, `@` prefix, `~`). */
export function expandPath(file: string, options: { readonly tool?: boolean } = { tool: true }) {
  const spaced = options.tool ? file.replace(UNICODE_SPACES, " ") : file
  const stripped = options.tool && spaced.startsWith("@") ? spaced.slice(1) : spaced
  const native = process.platform === "win32" ? normalizeWindowsShellPath(stripped) : stripped
  const home = homedir()
  if (native === "~") return home
  if (native.startsWith("~/") || (process.platform === "win32" && native.startsWith("~\\")))
    return path.join(home, native.slice(2))
  if (/^file:\/\//.test(native)) return fileURLToPath(native)
  return native
}

/** `resolveToCwd`: an absolute path as it is (normalized), a relative one under `cwd`. */
export function resolveToCwd(file: string, cwd: string) {
  const normalized = expandPath(file)
  const base = expandPath(cwd, { tool: false })
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(base, normalized)
}

/** `resolveReadPathAsync`: the resolved path, or the first macOS screenshot-name variant that exists. */
export async function resolveReadPath(file: string, cwd: string) {
  const resolved = resolveToCwd(file, cwd)
  if (await exists(resolved)) return resolved
  const nfd = resolved.normalize("NFD")
  const candidates = [
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    nfd,
    resolved.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ]
  const found = await candidates.reduce<Promise<string | undefined>>(
    async (previous, candidate) =>
      (await previous) ?? (candidate !== resolved && (await exists(candidate)) ? candidate : undefined),
    Promise.resolve(undefined),
  )
  return found ?? resolved
}

function exists(file: string) {
  return access(file, constants.F_OK).then(
    () => true,
    () => false,
  )
}
