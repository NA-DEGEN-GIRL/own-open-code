export * as Hash from "./hash.js"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

/** Headers in any of the shapes hooks see them: a `Headers` object, a plain record, or name/value pairs. */
export type HeadersLike = Headers | Readonly<Record<string, string | undefined>> | Iterable<readonly [string, string]>

/** Hex SHA-256 of a UTF-8 string or of bytes. */
export function sha256(input: string | Uint8Array) {
  return createHash("sha256").update(input).digest("hex")
}

/** The first `length` hex characters of SHA-256. This is the only form a secret may take in logs (02 §2.4.5). */
export function short(input: string | Uint8Array, length = 8) {
  return sha256(input).slice(0, length)
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, `undefined` members dropped, arrays kept in order (with
 * `undefined` items written as `null`, like `JSON.stringify`). Values that are equal as JSON always give the same
 * string, whatever order their keys were built in (02 §4.3 D1). Keys are written by hand because JavaScript orders
 * integer-like keys numerically inside objects, which a sorted `Object.fromEntries` could not undo.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function")
    return canonical(value.toJSON())
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`
  if (typeof value === "object")
    return `{${Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort((a, b) => compare(a[0], b[0]))
      .map((entry) => `${JSON.stringify(entry[0])}:${canonical(entry[1])}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

/** SHA-256 of {@link canonical}; stable across key order and runs. */
export function stable(value: unknown) {
  return sha256(canonical(value))
}

/**
 * ChatGPT account guard fingerprint `sha256(id + ":" + sub)` in registry form (02 §3.1 C5). `id` is the ChatGPT
 * account id for a Codex-style login and the issued client id for Sign in with ChatGPT (02 §3.2c).
 */
export function fingerprint(id: string, sub: string) {
  return `sha256:${sha256(`${id}:${sub}`)}`
}

/** Header entries with lower-cased names, in input order. Skips `undefined` record values. */
export function entries(headers: HeadersLike): Array<[string, string]> {
  if (headers instanceof Headers) return Array.from(headers.entries(), (entry) => [entry[0].toLowerCase(), entry[1]])
  if (isIterable(headers)) return Array.from(headers, (entry): [string, string] => [entry[0].toLowerCase(), entry[1]])
  return Object.entries(headers).flatMap(
    (entry): Array<[string, string]> => (entry[1] === undefined ? [] : [[entry[0].toLowerCase(), entry[1]]]),
  )
}

/**
 * SHA-256 of the sorted header set. Header values of one slot must only change when a token is refreshed, because
 * the WebSocket affinity key hashes the sorted headers (02 §4.3 D3); compare this value to check that rule.
 */
export function headers(input: HeadersLike) {
  return stable(entries(input).sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1])))
}

/** Header names that carry a provider credential. */
export const AUTH_HEADERS = ["authorization", "x-api-key"] as const

/**
 * `hash8` of every credential-carrying header, used for the auth swap check (02 §4.1, §4.2): the value
 * `model.request` injected is compared with what `http.response` observed on the request.
 */
export function auth(input: HeadersLike) {
  return entries(input).flatMap((entry) =>
    AUTH_HEADERS.some((name) => name === entry[0]) ? [{ name: entry[0], hash: short(entry[1]) }] : [],
  )
}

const KEY_PREFIXES = ["sk-ant-", "sk-or-v1-", "sk-proj-", "sk-", "xai-"]

/**
 * Display hint of an API key: the known prefix, an ellipsis and the last four characters, e.g. `sk-ant-…9fQ2`
 * (02 §3.3 step 4). Keys shorter than 12 characters show no characters at all.
 */
export function keyHint(key: string) {
  const prefix = KEY_PREFIXES.find((candidate) => key.startsWith(candidate)) ?? ""
  if (key.length < 12) return `${prefix}…`
  return `${prefix}…${key.slice(-4)}`
}

/** Why {@link folder} refused a folder: it holds a link (a symbolic link, a junction or another reparse point). */
export class FolderLinkError extends Error {
  readonly code = "ELINK"
  readonly file: string
  constructor(file: string) {
    super(`'${file}' is a link`)
    this.file = file
  }
}

/**
 * SHA-256 of every file under `dir`: for each file in sorted relative-path order (`/`-separated), the path, a NUL, its
 * bytes and a NUL. own.creator records it for every version folder (17 §4.2) and own-accounts' trust approvals hash a
 * creator version folder the same way (17 §12.4), so one value names one version everywhere.
 *
 * The walk uses `lstat` and never follows anything: a folder that holds a symbolic link, a junction or any other entry
 * that is neither a plain file nor a plain folder rejects with {@link FolderLinkError} (`readdir`'s recursive walk would
 * follow a junction on Windows). Nothing is cached: every call reads every byte, because trust and tamper decisions
 * rest on it (a file rewritten with the same size and time must not keep an old hash).
 */
export async function folder(dir: string) {
  const files = (await walk(dir, "")).toSorted()
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(`${file}\0`)
    hash.update(await fs.readFile(path.join(dir, ...file.split("/"))))
    hash.update("\0")
  }
  return hash.digest("hex")
}

/** The plain files under `dir` (relative, `/`-separated); rejects at the first entry that is not a file or folder. */
async function walk(dir: string, prefix: string): Promise<string[]> {
  const names = await fs.readdir(path.join(dir, ...prefix.split("/").filter(Boolean)))
  const nested = await Promise.all(
    names.map(async (name) => {
      const relative = prefix === "" ? name : `${prefix}/${name}`
      const stat = await fs.lstat(path.join(dir, ...relative.split("/")))
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new FolderLinkError(relative)
      return stat.isDirectory() ? walk(dir, relative) : [relative]
    }),
  )
  return nested.flat()
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function isIterable(value: object): value is Iterable<readonly [string, string]> {
  return Symbol.iterator in value
}
