export * as McpStore from "./store.js"

import { createHmac, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { McpHost, OwnMcp } from "@own/protocol"
import { Store, type Credentials } from "@own/runtime"
import type { Deps } from "../deps.js"
import { Location } from "../location.js"

/**
 * The MCP servers own added (03 §18.14, SM 2026-10-24): `OWN_HOME\mcp.json` holds every server without its values
 * (names only) and the list's kept switches; each server's values are one vault item `mcp-<id>` (a JSON {@link Values}
 * text), so the file and every RPC answer are free of them. Only the control Location's instance writes (every
 * `mcp.*` method arrives there); every instance reads, for its fold.
 */

const Local = Schema.Struct({
  type: Schema.Literal("local"),
  /** The command and arguments may name a stored environment value as `${NAME}` (`McpRules.REFERENCE`). */
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: optional(Schema.String),
  /** Names of the stored environment values. */
  env: Schema.Array(Schema.String),
  codemode: optional(Schema.Boolean),
  /**
   * An SSH host's server only (04 §13 "MCP", MH): plain variables its translation set (`BUN_BE_BUN=1`) or the AI's
   * install gave, never a value of the PC (those come from the PC over the broker).
   */
  fixed: optional(Schema.Record(Schema.String, Schema.String)),
})

const Remote = Schema.Struct({
  type: Schema.Literal("remote"),
  /**
   * The address without its `?` part, which is in the vault when `query`. `hidden`: a part of it holds a value, so
   * the address is in the vault too (`Values.url`) and this is its shown form (`McpSecrets.address`).
   */
  url: Schema.String,
  query: Schema.Boolean,
  hidden: optional(Schema.Boolean),
  /** Names of the stored header values. */
  headers: Schema.Array(Schema.String),
  oauth: Schema.Boolean,
  codemode: optional(Schema.Boolean),
})

export const Entry = Schema.Struct({
  id: OwnMcp.ID,
  name: OwnMcp.Name,
  scope: OwnMcp.Scope,
  transport: Schema.Union([Local, Remote]),
  /** What a server was imported from: the file kind and the name it had there. */
  origin: optional(Schema.Struct({ source: OwnMcp.Source, name: Schema.String })),
  /** The MCP Registry entry the form took it from (`찾아서 설치`). */
  registry: optional(OwnMcp.RegistryRef),
  /** An SSH host's server installed from the PC (MH): the PC's key and definition hash then. */
  pc: optional(McpHost.Pc),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  check: optional(OwnMcp.Check),
})
export type Entry = typeof Entry.Type

/**
 * `version` 2 (SG 2026-10-26): a switch may have no `directory` (the global one), and a switch of own's server that
 * repeats what its folder inherits is never stored. A version 1 file (all its switches have a folder) is read as
 * version 2 ({@link upgrade}: its `enabled: true` switches of own's servers that changed nothing go), so every change
 * is computed on the upgraded switches; the file is rewritten as version 2 by the first change.
 */
export const File = Schema.Struct({
  version: Schema.Literals([1, 2]),
  servers: Schema.Array(Entry),
  overrides: Schema.Array(OwnMcp.Override),
})
export type File = typeof File.Type

export const EMPTY: File = { version: 2, servers: [], overrides: [] }

/**
 * A server's values: environment values and header values by name, the URL's `?` part (with the `?`), and the
 * address before it when that holds a value (`hidden`).
 */
export const Values = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  search: optional(Schema.String),
  url: optional(Schema.String),
})
export type Values = typeof Values.Type

export const NO_VALUES: Values = { env: {}, headers: {} }

const decodeValues = Schema.decodeUnknownOption(Schema.fromJsonString(Values))

/** The file of this instance's runtime home. Writes go through its mutex (one control instance writes). */
export function file(deps: Pick<Deps, "runtime">) {
  return new Store.JsonFile({
    file: deps.runtime.layout.mcp,
    schema: File,
    fallback: () => EMPTY,
    // Upgraded as read, before a change is decided on it (SG-17): the change of `mcp.enable{name, enabled: false}`
    // computed on a version 1 file would otherwise judge its no-op ons against the new global off and keep them.
    normalize: (value) => (value.version === 1 ? upgrade(value) : value),
  })
}

/**
 * A version 1 file as version 2: an `enabled: true` switch of own's server (one whose scope reaches its folder) that
 * no shallower switch of that name turned off was a no-op under version 1 (own's servers start on), but under the
 * global switch it would read as `이 프로젝트에서만 켬` and hold a later global off back there; it goes. A config
 * file's switches and every `off` stay. It folds the same as the version 1 file did.
 */
export function upgrade(value: File): File {
  const overrides = value.overrides.filter((item) => {
    const directory = item.directory
    if (!item.enabled || directory === undefined) return true
    const own = value.servers.some(
      (entry) =>
        entry.name === item.name &&
        (entry.scope.type === "global" || Location.within(directory, entry.scope.directory)),
    )
    if (!own) return true
    return inherited(value.overrides, item.name, directory) === false
  })
  return { ...value, version: 2, overrides }
}

/**
 * What a folder inherits for a server name without its own switch: the global switch, then the switches of the folders
 * that hold it (not the folder itself), shallowest first; on when none says otherwise. `undefined` folder: the global
 * switch's own place, which inherits on.
 */
export function inherited(
  overrides: ReadonlyArray<OwnMcp.Override>,
  name: string,
  directory: string | undefined,
): boolean {
  if (directory === undefined) return true
  return (
    overrides
      .filter(
        (item) =>
          item.name === name &&
          (item.directory === undefined ||
            (Location.within(directory, item.directory) && !Location.same(directory, item.directory))),
      )
      .toSorted((a, b) => depth(a) - depth(b))
      .at(-1)?.enabled ?? true
  )
}

/** The fold's order of switches: the global one first, then the shallower folders (a folder inside is longer). */
export function depth(override: Pick<OwnMcp.Override, "directory">) {
  return override.directory === undefined ? -1 : override.directory.length
}

export function vaultID(id: string): Credentials.McpSecretID {
  return `mcp-${id}`
}

/** Whether a server stores any value (else it has no vault item). */
export function holds(entry: Entry) {
  return entry.transport.type === "local"
    ? entry.transport.env.length > 0
    : entry.transport.headers.length > 0 || entry.transport.query || entry.transport.hidden === true
}

/**
 * A server's values: none for a server that stores none, `undefined` when the vault does not answer or its item is
 * not readable (the server then stays off, never half configured).
 */
export async function values(deps: Pick<Deps, "runtime">, entry: Entry): Promise<Values | undefined> {
  if (!holds(entry)) return NO_VALUES
  const stored = await deps.runtime.credentials.mcpSecrets(vaultID(entry.id))
  if (!stored.ok) return undefined
  return Option.getOrUndefined(decodeValues(stored.text))
}

/** Stores a server's values, or removes its item when it has none. `false` when the vault does not answer. */
export async function storeValues(deps: Pick<Deps, "runtime">, id: string, next: Values) {
  const empty =
    Object.keys(next.env).length === 0 && Object.keys(next.headers).length === 0 && !next.search && !next.url
  if (empty) return (await deps.runtime.credentials.removeFeatureKey(vaultID(id))).ok
  const text = JSON.stringify(Schema.encodeSync(Values)(next))
  return (await deps.runtime.credentials.storeFeatureKey(vaultID(id), text)).ok
}

/**
 * What a server is, values aside, to tell two apart: the command, its arguments (`${NAME}` as written) and the names
 * of its environment values, or the address, whether it has a `?` part and the names of its headers. A hidden
 * address is its real value's keyed hash ({@link keyed}), not its shown form: two addresses that both show
 * `https://host/••••/mcp` are different servers. Without the values (the vault did not answer) the shown form stands.
 */
export function definition(transport: Entry["transport"], values?: Values) {
  if (transport.type === "local")
    return JSON.stringify(["local", transport.command, transport.args, transport.env.toSorted()])
  const headers = transport.headers.map((name) => name.toLowerCase()).toSorted()
  const url = transport.hidden && values?.url !== undefined ? `hidden:${keyed(values.url)}` : transport.url
  return JSON.stringify(["remote", url, transport.query, headers])
}

/** Whether two servers of one definition hold the same values (header names compared without case). */
export function sameValues(a: Values, b: Values) {
  const headers = (values: Values) =>
    Object.entries(values.headers)
      .map(([name, value]) => [name.toLowerCase(), value])
      .toSorted((x, y) => (x[0]! < y[0]! ? -1 : 1))
  const env = (values: Values) => Object.entries(values.env).toSorted((x, y) => (x[0] < y[0] ? -1 : 1))
  return (
    JSON.stringify([env(a), headers(a), a.search ?? "", a.url ?? ""]) ===
    JSON.stringify([env(b), headers(b), b.search ?? "", b.url ?? ""])
  )
}

/** This process's key for {@link definition}'s hashes, so no hash of a value outlives it or can be guessed at. */
const KEY = randomBytes(32)

function keyed(value: string) {
  return createHmac("sha256", KEY).update(value).digest("hex")
}

/** Where a server came from, as answers name it. */
export function from(entry: Entry): OwnMcp.From | undefined {
  if (entry.registry) return "registry"
  if (entry.origin) return entry.origin.source === "codex" ? "codex" : "claude-code"
  return undefined
}

/** The answer's form of a server: names, and the last four characters of long values. */
export function view(entry: Entry, stored: Values | undefined): OwnMcp.Server {
  const source = from(entry)
  return {
    id: entry.id,
    name: entry.name,
    scope: entry.scope,
    transport: transportView(entry.transport, stored),
    ...(source ? { from: source } : {}),
    ...(entry.registry ? { registry: entry.registry } : {}),
    ...(stored === undefined ? { missing: true } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.check ? { check: entry.check } : {}),
  }
}

/** The answer's form of a definition (a server's, or a candidate's of the import): names and hints of its values. */
export function transportView(transport: Entry["transport"], stored: Values | undefined): OwnMcp.Transport {
  const secret = (name: string, value: string | undefined) => {
    const hint = value === undefined ? undefined : OwnMcp.hint(value)
    return hint === undefined ? { name } : { name, hint }
  }
  const codemode = transport.codemode === undefined ? {} : { codemode: transport.codemode }
  if (transport.type === "local")
    return {
      type: "local",
      command: transport.command,
      args: transport.args,
      ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      env: transport.env.map((name) => secret(name, stored?.env[name])),
      ...codemode,
    }
  return {
    type: "remote",
    url: transport.url,
    query: transport.query,
    ...(transport.hidden ? { hidden: true } : {}),
    headers: transport.headers.map((name) => secret(name, stored?.headers[name])),
    oauth: transport.oauth,
    ...codemode,
  }
}
