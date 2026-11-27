export * as GitHubStore from "./store.js"

import { createHash } from "node:crypto"
import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnGitHub } from "@own/protocol"
import { Lock, Store, type Credentials } from "@own/runtime"
import type { Deps } from "../deps.js"
import { Location } from "../location.js"
import { GitHubReads } from "./reads.js"

/**
 * GitHub accounts own connected (16 §3, GH 2026-10-31): `OWN_HOME\github.json` holds each account's name, site and
 * login, the choices per project folder and per conversation, the default and the settings; each account's token is
 * one vault item `github-<id>` (a JSON {@link Secret} text), so the file and every answer are free of it. Only the
 * control Location's instance writes (every `github.*` method arrives there); every instance reads, for its tools and
 * git's logins.
 */

const Entry = Schema.Struct({
  id: OwnGitHub.ID,
  label: Schema.String,
  site: OwnGitHub.Site,
  login: Schema.String,
  name: optional(Schema.String),
  source: OwnGitHub.Source,
  tokenKind: OwnGitHub.TokenKind,
  hint: Schema.String,
  write: Schema.Boolean,
  scopes: optional(Schema.Array(Schema.String)),
  expiresAt: optional(Schema.Finite),
  addedAt: Schema.Finite,
  checkedAt: optional(Schema.Finite),
  problem: optional(OwnGitHub.Problem),
})
export type Entry = typeof Entry.Type

/** The tools GitHub's MCP server listed last (16 §5.3): what every Location registers before it can ask the server. */
const CatalogTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** The tool's JSON Schema as the server gave it. */
  input: Schema.Unknown,
  /** It counts as a read (`GitHubReads.isRead`; a catalog read before GH-15 holds the server's hint alone). */
  read: Schema.Boolean,
  title: optional(Schema.String),
})
export type CatalogTool = typeof CatalogTool.Type

const Catalog = Schema.Struct({
  at: Schema.Finite,
  /** What the catalog was read from: the server and the toolsets asked for, so a changed setting reads it again. */
  key: Schema.String,
  server: optional(Schema.String),
  tools: Schema.Array(CatalogTool),
})
export type Catalog = typeof Catalog.Type

/**
 * A token that was replaced or removed (GH-30): it may still work at GitHub, so tool results keep it masked for
 * {@link RETIRED_MS}. Only its SHA-256 is kept, never the token; the masker hashes what looks like a GitHub token.
 */
const Retired = Schema.Struct({
  /** SHA-256 of the token, hex. */
  hash: Schema.String,
  until: Schema.Finite,
})
export type Retired = typeof Retired.Type

export const File = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(Entry),
  default: optional(OwnGitHub.ID),
  projects: Schema.Array(OwnGitHub.ProjectChoice),
  sessions: Schema.Array(OwnGitHub.SessionChoice),
  settings: OwnGitHub.Settings,
  catalog: optional(Catalog),
  retired: optional(Schema.Array(Retired)),
})
export type File = typeof File.Type

export const DEFAULT_SETTINGS: OwnGitHub.Settings = {
  server: { type: "remote", url: OwnGitHub.HOSTED },
  toolsets: OwnGitHub.DEFAULT_TOOLSETS,
  git: true,
}

export const EMPTY: File = { version: 1, accounts: [], projects: [], sessions: [], settings: DEFAULT_SETTINGS }

/** At most this many conversation choices are kept; the oldest go first (a conversation choice is rare). */
export const MAX_SESSIONS = 500

/** An account's token: the token, and for a device login of an app whose tokens expire, its refresh token. */
export const Secret = Schema.Struct({
  token: Schema.String,
  refresh: optional(Schema.String),
  expiresAt: optional(Schema.Finite),
  refreshExpiresAt: optional(Schema.Finite),
})
export type Secret = typeof Secret.Type

const decodeSecret = Schema.decodeUnknownOption(Schema.fromJsonString(Secret))

/** A replaced or removed token is masked this long. */
export const RETIRED_MS = 30 * 24 * 60 * 60_000
/** At most this many retired tokens are kept; the oldest go first. */
export const MAX_RETIRED = 500

/**
 * The file of this instance's runtime home. Every Location's instance may write (a refused token, a `항상 허용`), so
 * writes go through one mutex per file for the whole process (modules are imported per Location).
 */
export function file(deps: Pick<Deps, "runtime">) {
  return new Store.JsonFile({
    file: deps.runtime.layout.github,
    schema: File,
    fallback: () => EMPTY,
    mutex: mutexOf(deps.runtime.layout.github),
  })
}

const MUTEXES = Symbol.for("own-open-code.github-store-mutexes")

function mutexOf(file: string) {
  const holder = globalThis as unknown as Record<symbol, Map<string, Lock.Mutex> | undefined>
  const mutexes = holder[MUTEXES] ?? new Map<string, Lock.Mutex>()
  holder[MUTEXES] = mutexes
  const key = path.resolve(file).toLowerCase()
  const known = mutexes.get(key)
  if (known) return known
  const created = new Lock.Mutex()
  mutexes.set(key, created)
  return created
}

/** `retired` with the hashes of `secret`'s token and refresh token added until `now` + {@link RETIRED_MS}, the lapsed dropped. */
export function withRetired(retired: ReadonlyArray<Retired>, secret: Secret | undefined, now: number) {
  const hashes = secret === undefined ? [] : [secret.token, ...(secret.refresh === undefined ? [] : [secret.refresh])].map(hashOf)
  const rest = retired.filter((item) => item.until > now && !hashes.includes(item.hash))
  return [...rest, ...hashes.map((hash) => ({ hash, until: now + RETIRED_MS }))].slice(-MAX_RETIRED)
}

/** A token's SHA-256, hex: what `retired` keeps. */
export function hashOf(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function vaultID(id: string): Credentials.GitHubSecretID {
  return `github-${id}`
}

/** An account's token, or `undefined` when the vault does not answer or its item is not readable. */
export async function secret(deps: Pick<Deps, "runtime">, id: string): Promise<Secret | undefined> {
  const stored = await deps.runtime.credentials.githubSecret(vaultID(id))
  if (!stored.ok) return undefined
  return Option.getOrUndefined(decodeSecret(stored.text))
}

/** Stores an account's token. `false` when the vault does not answer. */
export async function storeSecret(deps: Pick<Deps, "runtime">, id: string, value: Secret) {
  const text = JSON.stringify(Schema.encodeSync(Secret)(value))
  return (await deps.runtime.credentials.storeFeatureKey(vaultID(id), text)).ok
}

export async function removeSecret(deps: Pick<Deps, "runtime">, id: string) {
  return (await deps.runtime.credentials.removeFeatureKey(vaultID(id))).ok
}

/** The answer's form of an account: never the token, its last four characters only. */
export function account(entry: Entry): OwnGitHub.Account {
  return {
    id: entry.id,
    label: entry.label,
    site: entry.site,
    login: entry.login,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    source: entry.source,
    tokenKind: entry.tokenKind,
    hint: entry.hint,
    write: entry.write,
    ...(entry.scopes === undefined ? {} : { scopes: entry.scopes }),
    ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
    addedAt: entry.addedAt,
    ...(entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt }),
    ...(entry.problem === undefined ? {} : { problem: entry.problem }),
  }
}

/** The page's form of the catalog: tool names by kind. */
export function catalogView(catalog: Catalog | undefined): OwnGitHub.Catalog | undefined {
  if (!catalog) return undefined
  const read = (tool: CatalogTool) => GitHubReads.isRead(tool.name, tool.read, catalog.server)
  return {
    at: catalog.at,
    read: catalog.tools.filter(read).map((tool) => tool.name),
    write: catalog.tools.filter((tool) => !read(tool)).map((tool) => tool.name),
    ...(catalog.server === undefined ? {} : { server: catalog.server }),
  }
}

/** What the catalog depends on: the server and the toolsets. */
export function catalogKey(settings: OwnGitHub.Settings) {
  const server =
    settings.server.type === "remote" ? settings.server.url : [settings.server.command, ...settings.server.args]
  return JSON.stringify([server, settings.toolsets.toSorted()])
}

/**
 * The deepest project choice that holds `directory`, if any: this PC's choices, or with `host` that SSH host's (16 §8),
 * whose folders are POSIX paths compared as they are.
 */
export function projectChoice(
  projects: ReadonlyArray<OwnGitHub.ProjectChoice>,
  directory: string,
  host?: string,
) {
  return projects
    .filter((item) => item.host === host && within(directory, item.directory, host))
    .toSorted((a, b) => a.directory.length - b.directory.length)
    .at(-1)
}

/** `projects` with the choice at exactly `directory` (of `host`, when given) set (`null` removes it). */
export function withProject(
  projects: ReadonlyArray<OwnGitHub.ProjectChoice>,
  directory: string,
  choice: OwnGitHub.Choice | null,
  host?: string,
) {
  const rest = projects.filter((item) => item.host !== host || !same(item.directory, directory, host))
  return choice === null ? rest : [...rest, { directory, account: choice, ...(host === undefined ? {} : { host }) }]
}

/** `sessions` with one conversation's choice set (`null` removes it), the oldest dropped past {@link MAX_SESSIONS}. */
export function withSession(
  sessions: ReadonlyArray<OwnGitHub.SessionChoice>,
  choice: { readonly sessionID: string; readonly directory?: string; readonly host?: string; readonly at: number },
  account: OwnGitHub.Choice | null,
) {
  const rest = sessions.filter((item) => item.sessionID !== choice.sessionID || item.host !== choice.host)
  if (account === null) return rest
  const next = [...rest, { ...choice, account }]
  return next.length > MAX_SESSIONS ? next.toSorted((a, b) => a.at - b.at).slice(-MAX_SESSIONS) : next
}

/** A conversation's choice: this PC's, or with `host` that SSH host's. */
export function sessionChoice(sessions: ReadonlyArray<OwnGitHub.SessionChoice>, sessionID: string, host?: string) {
  return sessions.find((item) => item.sessionID === sessionID && item.host === host)
}

/** {@link Location.same}, or for an SSH host's folders the same path there. */
export function same(a: string, b: string, host?: string) {
  if (host === undefined) return Location.same(a, b)
  return hostKey(a).key === hostKey(b).key
}

/** {@link Location.within}, or for an SSH host's folders a path at or below `root` there. */
export function within(directory: string, root: string, host?: string) {
  if (host === undefined) return Location.within(directory, root)
  const inner = hostKey(directory)
  const outer = hostKey(root)
  const separator = outer.windows ? "\\" : "/"
  return inner.key === outer.key || inner.key.startsWith(outer.key.endsWith(separator) ? outer.key : outer.key + separator)
}

/** Whether `value` is an absolute folder of an SSH host: a POSIX path, or a Windows one (a Windows host). */
export function hostAbsolute(value: string) {
  return value.startsWith("/") || WINDOWS_PATH.test(value)
}

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/

/**
 * A host folder as compared, independent of this PC's platform: a POSIX path normalized without a trailing `/` but the
 * root's; a Windows host's path (`C:\…`) as Windows compares it, case folded.
 */
function hostKey(value: string) {
  if (WINDOWS_PATH.test(value)) {
    const normalized = path.win32.normalize(value).toLowerCase()
    return { key: normalized.length > 3 ? normalized.replace(/\\+$/, "") : normalized, windows: true }
  }
  const normalized = path.posix.normalize(value)
  return { key: normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized, windows: false }
}

/** Choices that name an account no longer there go with it. */
export function withoutAccount(value: File, id: string): File {
  return {
    ...value,
    accounts: value.accounts.filter((item) => item.id !== id),
    default: value.default === id ? undefined : value.default,
    projects: value.projects.filter((item) => item.account !== id),
    sessions: value.sessions.filter((item) => item.account !== id),
  }
}
