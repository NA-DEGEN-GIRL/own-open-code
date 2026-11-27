export * as Trust from "./trust.js"

import { statSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"
import type { Plugin, Registry } from "@own/protocol"
import { Hash } from "@own/runtime"
import { Location } from "../location.js"
import { Inventory } from "./inventory.js"

/**
 * Project plugin allowlist (01 §13.2 (a), 02 §4.2). Allowed by default: builtin and host (`sdk`) plugins, the own
 * plugins, and the Claude plugin's folders. Every other plugin of a Location needs a `trust.json` approval
 * `{location, source, sha256}`; while one is missing the Location is `blocked_by_plugin` and `model.request` injects
 * no auth there. Approvals are tied to the content hash, so an edited plugin is blocked again. A creator code plugin's
 * version folder (17 §12.4: an `extension.json` of `own.ext/1` beside its entry) is hashed as a whole folder, the way
 * own.creator records it, so a changed helper file blocks it too; every other plugin keeps its entry-file hash.
 */

/** A plugin outside the default allowlist, identified by its source string and content hash. */
export interface Candidate {
  readonly id: string
  /** `local:<entry file>` or `package:<target>` (the form `trust.json` stores). */
  readonly source: string
  /**
   * Hex SHA-256 of the entry file (local; of the whole folder for a creator version, {@link creatorFolder}) or of
   * `target@version` (package); `null` when unreadable.
   */
  readonly sha256: string | null
}

export interface Roots {
  /** Directories of the own plugin bundles ({@link Inventory.ownRoots}). */
  readonly own: ReadonlyArray<string>
  /**
   * The Claude plugin's folders outside {@link own} (02 §8.2): the bundle of a source run (`own/.out/claude-auth`) and
   * `<OWN_HOME>\thirdparty\claude-auth` (its state folder, once the npm install). The release bundle
   * `app\<version>\plugins\claude-auth` is inside {@link own}.
   */
  readonly claude: ReadonlyArray<string>
}

export const APPROVAL_WARNING =
  "승인한 플러그인은 서비스 프로세스 안에서 실행되며 인증 헤더를 볼 수 있습니다. 믿을 수 있는 코드만 승인하세요."

/** Whether an entry is on the default allowlist. Failed plugins count too: their code still runs on the next load. */
export function allowed(entry: Inventory.Entry, roots: Roots) {
  if (entry.source.type === "builtin" || entry.source.type === "sdk") return true
  if (entry.source.type === "package") return false
  const file = entry.source.path
  return [...roots.claude, ...roots.own].some((root) => Inventory.contains(root, file))
}

/** Every plugin of the list that needs an approval, with its current content hash. */
export function candidates(entries: ReadonlyArray<Inventory.Entry>, roots: Roots) {
  return Promise.all(
    entries
      .filter((entry) => !allowed(entry, roots))
      .map(async (entry): Promise<Candidate> => {
        const source = sourceOf(entry)
        return { id: entry.id ?? path.basename(source), source, sha256: await fingerprint(entry) }
      }),
  )
}

/** Re-hashes a candidate from disk (approve plan/execute compare against this). */
export async function rehash(candidate: Candidate) {
  if (!candidate.source.startsWith("local:")) return candidate.sha256
  return hashPath(candidate.source.slice("local:".length))
}

/** Approval state of a Location's candidates against `trust.json`. */
export function evaluate(directory: string, list: ReadonlyArray<Candidate>, file: Registry.TrustFile) {
  const plugins = list.map((candidate) => ({
    id: candidate.id,
    source: candidate.source,
    sha256: candidate.sha256 ?? "",
    approved: candidate.sha256 !== null && approvedBy(file, directory, candidate.source, candidate.sha256),
  }))
  const status: Plugin.TrustStatus = plugins.every((plugin) => plugin.approved) ? "ok" : "blocked_by_plugin"
  return { status, plugins, pending: plugins.filter((plugin) => !plugin.approved).length }
}

export function approvedBy(file: Registry.TrustFile, directory: string, source: string, sha256: string) {
  return file.some(
    (entry) => Location.same(entry.location, directory) && sameSource(entry.source, source) && entry.sha256 === sha256,
  )
}

/** `trust.json` with `source` of `directory` approved at `sha256` (a previous approval of that source is replaced). */
export function approve(
  file: Registry.TrustFile,
  input: { readonly directory: string; readonly source: string; readonly sha256: string; readonly approvedAt: string },
): Registry.TrustFile {
  return [
    ...revoke(file, input.directory, input.source),
    { location: input.directory, source: input.source, sha256: input.sha256, approvedAt: input.approvedAt },
  ]
}

export function revoke(file: Registry.TrustFile, directory: string, source: string): Registry.TrustFile {
  return file.filter((entry) => !(Location.same(entry.location, directory) && sameSource(entry.source, source)))
}

export function sameSource(a: string, b: string) {
  if (a.startsWith("local:") && b.startsWith("local:"))
    return Location.same(a.slice("local:".length), b.slice("local:".length))
  return a === b
}

function sourceOf(entry: Inventory.Entry) {
  if (entry.source.type === "local") return `local:${serverFile(entry.source.path)}`
  if (entry.source.type === "package") return `package:${entry.source.target}`
  return entry.source.type
}

function fingerprint(entry: Inventory.Entry) {
  if (entry.source.type === "local") return hashPath(serverFile(entry.source.path))
  if (entry.source.type === "package")
    return Promise.resolve(Hash.sha256(`${entry.source.target}@${entry.source.version ?? ""}`))
  return Promise.resolve(null)
}

/**
 * The file core imports for a local plugin. Since upstream v2.2 the host lists a configured local plugin by its
 * directory (`core/src/plugin/module.ts`), where it used to list the entry file it imported. The approval stays on that
 * entry file, resolved the way core resolves it (`Host.resolve`): approvals written before keep matching, and an edit
 * of the code core runs changes the hash, which a directory's entry names would not. A directory without a server
 * entry (a GUI-only or broken plugin) and a standalone file stay as listed.
 * The approval covers the code this service runs only. A plugin's `./gui-experimental` bundle runs in no own client:
 * own-desktop evaluates no bundle of the service (its plugin-module.ts substitute, 05 §8.1.1) and own-web loads none.
 * A client that ever runs one needs that bundle in the fingerprint first, or it could change without a new approval.
 */
function serverFile(listed: string) {
  if (!statSync(listed, { throwIfNoEntry: false })?.isDirectory()) return listed
  const server = resolveServer(listed)
  return server?.startsWith("file:") ? fileURLToPath(server) : listed
}

/** `Host.resolve`'s server entry, or `undefined` when resolving it fails (the plugin then fails to load in core too). */
function resolveServer(directory: string) {
  try {
    return Host.resolve({ directory }).server
  } catch {
    return undefined
  }
}

/**
 * SHA-256 of a plugin file. A directory without a server entry stands in by its sorted entry names (the same digest
 * upstream uses to notice a changed directory, `plugin/src/source.ts`). The entry of a creator version folder stands
 * in for the folder: its hash covers every file in it ({@link creatorFolder}).
 */
async function hashPath(file: string) {
  const info = await fs.stat(file).catch(() => undefined)
  if (!info) return null
  const folder = info.isFile() ? await creatorFolder(path.dirname(file)) : undefined
  if (folder !== undefined) return Hash.folder(folder).catch(() => null)
  if (info.isDirectory())
    return fs.readdir(file).then(
      (names) => Hash.sha256(JSON.stringify(names.sort())),
      () => null,
    )
  return fs.readFile(file).then(
    (bytes) => Hash.sha256(bytes),
    () => null,
  )
}

/**
 * `dir` when it is a version folder of an own creator code plugin (own.creator, 17 §12.4): its `extension.json` decodes
 * as an `own.ext/1` manifest of kind `plugin`. Such a folder is approved by the hash of all its files
 * (`Hash.folder`, the value own.creator records as the version's hash), never by its entry file alone.
 */
export async function creatorFolder(dir: string) {
  const text = await fs.readFile(path.join(dir, "extension.json"), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const manifest = parseManifest(text)
  return manifest !== undefined && manifest.format === "own.ext/1" && manifest.kind === "plugin" ? dir : undefined
}

function parseManifest(text: string): { readonly format?: unknown; readonly kind?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null ? value : undefined
  } catch {
    return undefined
  }
}
