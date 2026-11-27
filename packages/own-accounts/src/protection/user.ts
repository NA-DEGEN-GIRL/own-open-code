export * as ProtectedUser from "./user.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { ProtectedPaths } from "@own/protocol"

/**
 * The user's protected paths (설정 > 승인·권한 `에이전트가 못 여는 파일·폴더`, PP-2): kept as the user typed or picked
 * them (`~` kept, so the list reads as written), each resolved on the service's machine. A path covers a folder and
 * everything in it, or one file.
 */

const Stored = Schema.Struct({ paths: Schema.Array(Schema.String) })
const decode = Schema.decodeUnknownOption(Stored)

/** The stored list; anything unreadable reads as empty. */
export function read(value: unknown): ReadonlyArray<string> {
  const stored = decode(value)
  return Option.isSome(stored) ? stored.value.paths : []
}

export type Resolved =
  | { readonly ok: true; readonly path: string; readonly resolved: string }
  | { readonly ok: false; readonly reason: ProtectedPaths.Problem }

/**
 * `input` as a list entry: trimmed (and unquoted), `~` for the home folder, absolute after that. Refused: relative
 * paths, wildcards, a drive or filesystem root, the home folder itself.
 */
export function resolve(input: string, home: string, platform: NodeJS.Platform = process.platform): Resolved {
  const join = platform === "win32" ? path.win32 : path.posix
  const trimmed = input
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim()
  if (/[*?]/.test(trimmed.replace(/^\\\\\?\\/, ""))) return { ok: false, reason: "wildcard" }
  const expanded = trimmed === "~" ? home : /^~[\\/]/.test(trimmed) ? join.join(home, trimmed.slice(2)) : trimmed
  if (!join.isAbsolute(expanded) || (platform === "win32" && !/^([a-z]:|\\\\|\/\/)/i.test(expanded)))
    return { ok: false, reason: "relative" }
  const resolved = join.resolve(expanded)
  if (join.parse(resolved).root === resolved) return { ok: false, reason: "root" }
  if (same(resolved, join.resolve(home), platform)) return { ok: false, reason: "home" }
  return { ok: true, path: trimmed, resolved }
}

export function same(left: string, right: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Names in the home folder that look sensitive (PP-2 suggestions): wallets and their backups, seeds and recovery
 * phrases, key stores, password databases and key files. Offered with `추가`, never added by themselves.
 */
const SENSITIVE =
  /wallet|backup|seed|mnemonic|recovery|keystore|keychain|secret|private|passw|credential|vault|token|(^|[^a-z])(?:2fa|otp|keys?)([^a-z]|$)|\.(kdbx|kdb|keyx|pem|key|p12|pfx|gpg|asc|ppk|ovpn)$|^id_(rsa|ed25519|ecdsa|dsa)/i

/** Sensitive-looking names in `home`, those `covered` already says are protected left out, by name. */
export async function suggest(
  home: string,
  covered: (absolute: string) => boolean,
): Promise<ReadonlyArray<ProtectedPaths.Suggestion>> {
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => SENSITIVE.test(entry.name) && (entry.isDirectory() || entry.isFile()))
    .map((entry) => ({ name: entry.name, path: path.join(home, entry.name), folder: entry.isDirectory() }))
    .filter((item) => !covered(item.path))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50)
}
