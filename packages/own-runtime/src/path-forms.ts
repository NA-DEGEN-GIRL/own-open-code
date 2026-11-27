export * as PathForms from "./path-forms.js"

import fs from "node:fs"
import path from "node:path"

/**
 * The spellings one absolute path goes by, for matching it against protected patterns (01 §13 "에이전트 접근", PP-V).
 * Windows opens the same file under many names, and core's file tools resolve paths lexically, so a pattern written
 * for `C:\Users\me\.ssh` must also see `\\?\C:\Users\me\.ssh`, `\\localhost\C$\Users\me\.ssh`, `.ssh::$DATA`,
 * the 8.3 name `SSH~1` and a link or junction that points into it.
 *
 * Returned with `/`: the path as given; on Windows the same path without a `\\?\` or `\\.\` prefix, with an admin
 * share (`\\host\C$\…`) read as its drive and every NTFS stream suffix (`:name`, `::$DATA`) cut; and its real path
 * (short names, links and junctions resolved), or the real path of its nearest existing folder followed by the rest
 * when it does not exist yet (a file about to be written). The real path is read only on the platform the process runs
 * on, and not for a network path (`\\server\share`) other than an admin share.
 */
export function of(absolute: string, platform: NodeJS.Platform = process.platform): ReadonlyArray<string> {
  const windows = platform === "win32"
  const join = windows ? path.win32 : path.posix
  const lexical = absolute.replaceAll("\\", "/")
  const plain = windows ? plainWindows(lexical) : lexical
  const native = windows ? plain.replaceAll("/", "\\") : plain
  // A network path is not resolved: an unreachable host would hold the caller (a permission check) for seconds.
  const actual = platform === process.platform && !plain.startsWith("//") ? real(native, join) : undefined
  const forms = [lexical, plain, ...(actual === undefined ? [] : [actual.replaceAll("\\", "/")])]
  return [...new Set(windows ? [...forms, ...forms.map(plainWindows)] : forms)]
}

/** A Windows path (with `/`) without a device prefix, an admin share or stream suffixes. */
function plainWindows(slashed: string) {
  const unprefixed = slashed.replace(/^\/\/[?.]\/UNC\//i, "//").replace(/^\/\/[?.]\/(?=[a-z]:)/i, "")
  // `\\localhost\C$\…`, `\\127.0.0.1\c$\…`, `\\[::1]\C$\…`, this PC's name: any host's admin share is its drive.
  const drive = unprefixed.replace(/^\/\/[^/]+\/([a-z])\$(?=\/|$)/i, "$1:")
  // A ':' after the drive (or after a UNC host and share) starts a stream name; no Windows file name holds one.
  const kept = drive.startsWith("//") ? 4 : 1
  return drive
    .split("/")
    .map((part, index) => (index < kept ? part : part.split(":")[0]))
    .join("/")
}

/** The real path of `native`, or of its nearest existing folder joined with the rest; undefined at a missing root. */
function real(native: string, join: typeof path.posix): string | undefined {
  // realpathSync.native has no non-throwing form; a missing path is the common case for a file about to be written.
  try {
    return fs.realpathSync.native(native)
  } catch {
    const parent = join.dirname(native)
    if (parent === native) return undefined
    const above = real(parent, join)
    return above === undefined ? undefined : join.join(above, join.basename(native))
  }
}
