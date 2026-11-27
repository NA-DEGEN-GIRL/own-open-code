export * as McpRegistry from "./registry.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { McpRules, OwnMcp } from "@own/protocol"

/**
 * 찾아서 설치 (03 §18.14, SM): one page of the official MCP Registry (`GET <registry>/v0.1/servers?version=latest`,
 * `search` a part of a server's name), read on this PC and turned into what the add form takes: for each package the
 * exact command this PC would run (`npx -y <id>@<version>`, `uvx <id>==<version>`, `docker run -i --rm … <image>`,
 * `dnx <id>@<version> --yes`), for each remote its address, and the environment values, headers and `{parts}` they
 * ask for. A secret argument becomes `${NAME}` with NAME an environment value to fill, so a key never goes into the
 * arguments. Entries are read one by one: a malformed one is left out, not the page. Nothing is installed or run.
 *
 * The registry is someone else's data (SM-22): the body is read in chunks and dropped past {@link MAX_BODY}; at most
 * one page of entries, 8 packages and 8 remotes each, 32 arguments of each kind, 32 headers and variables and 64
 * values are read. What the page only shows (title, description, publisher, a value's description, its form) is
 * clipped; what the form takes as it is (the identifier, the version, an argument's name or value, a `{part}`, an
 * address, a value's name) is never clipped, since a cut command runs something else: an option with one too long is
 * left out. A link that long is left out, a default value that long left to fill.
 */

export const TIMEOUT_MS = 15_000
/** A registry page is a few hundred KB; anything much larger is not one. */
export const MAX_BODY = 4 * 1024 * 1024
const MAX_TEXT = 500
/** The longest exact parts an option may have (see above). */
const MAX_IDENTIFIER = 300
const MAX_VERSION = 100
const MAX_WORD = 1_000
const MAX_LABEL = 100
const MAX_NAME = 128
const MAX_URL = 2_000
/** The add form's limits (`OwnMcp.LocalInput`): more arguments or values than these cannot be saved. */
const MAX_ARGS = 64
const MAX_VALUES = 64

export type Failure = { readonly reason: "offline" | "status" | "invalid"; readonly status?: number }
export type Result = { readonly ok: true; readonly value: OwnMcp.RegistryPage } | { readonly ok: false; readonly error: Failure }

export async function search(input: {
  /** The registry's root, e.g. `https://registry.modelcontextprotocol.io`. */
  readonly base: string
  readonly query?: string
  readonly cursor?: string
  /** Names own already uses, so `suggested` is free. */
  readonly taken: Iterable<string>
  readonly timeoutMs?: number
}): Promise<Result> {
  const url = new URL("v0.1/servers", input.base.endsWith("/") ? input.base : `${input.base}/`)
  url.searchParams.set("limit", String(OwnMcp.REGISTRY_PAGE))
  url.searchParams.set("version", "latest")
  if (input.query?.trim()) url.searchParams.set("search", input.query.trim())
  if (input.cursor) url.searchParams.set("cursor", input.cursor)
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? TIMEOUT_MS),
  }).catch(() => undefined)
  if (response === undefined) return { ok: false, error: { reason: "offline" } }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, error: { reason: "status", status: response.status } }
  }
  const text = await bodyText(response)
  if (text === undefined) return { ok: false, error: { reason: "offline" } }
  const list = text === false ? undefined : Option.getOrUndefined(decodeList(text))
  if (list === undefined) return { ok: false, error: { reason: "invalid" } }
  const taken = new Set([...input.taken].map((name) => name.toLowerCase()))
  const entries = list.servers.slice(0, OwnMcp.REGISTRY_PAGE).flatMap((item) => {
    const decoded = Option.getOrUndefined(decodeItem(item))
    const entry = decoded === undefined ? undefined : entryOf(decoded, taken)
    if (entry === undefined) return []
    taken.add(entry.suggested.toLowerCase())
    return [entry]
  })
  // `mcp.registry.search` takes a cursor of 500 characters at most: a longer one ends the list here.
  const next = list.metadata?.nextCursor
  const more = next !== undefined && next !== "" && next.length <= 500 && entries.length > 0
  return { ok: true, value: { registry: url.origin, entries, ...(more ? { nextCursor: next } : {}) } }
}

/**
 * The body as text, read chunk by chunk: `false` once it passes {@link MAX_BODY} (or says it will), which stops the
 * reading there; `undefined` when it broke off.
 */
async function bodyText(response: Response) {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined)
    return false
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ""
  const chunks: Uint8Array[] = []
  const state = { size: 0 }
  while (true) {
    const next = await reader.read().catch(() => undefined)
    if (next === undefined) return undefined
    if (next.done) return new TextDecoder().decode(Bun.concatArrayBuffers(chunks))
    state.size += next.value.byteLength
    if (state.size > MAX_BODY) {
      await reader.cancel().catch(() => undefined)
      return false
    }
    chunks.push(next.value)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// server.json (registry schema 2025-09 … 2025-12), only the fields own reads; unknown fields are ignored.

const Text = Schema.String
const Input = {
  description: optional(Text),
  isRequired: optional(Schema.Boolean),
  isSecret: optional(Schema.Boolean),
  format: optional(Text),
  value: optional(Text),
  default: optional(Text),
  placeholder: optional(Text),
}
const Variable = Schema.Struct(Input)
const Variables = optional(Schema.Record(Schema.String, Variable))
const Argument = Schema.Struct({
  ...Input,
  type: optional(Text),
  name: optional(Text),
  valueHint: optional(Text),
  variables: Variables,
})
const KeyValue = Schema.Struct({ ...Input, name: Text, variables: Variables })
const Package = Schema.Struct({
  registryType: Text,
  identifier: Text,
  version: optional(Text),
  runtimeHint: optional(Text),
  transport: optional(Schema.Struct({ type: Text })),
  runtimeArguments: optional(Schema.Array(Argument)),
  packageArguments: optional(Schema.Array(Argument)),
  environmentVariables: optional(Schema.Array(KeyValue)),
})
const Remote = Schema.Struct({
  type: Text,
  url: Text,
  headers: optional(Schema.Array(KeyValue)),
  variables: Variables,
})
const Server = Schema.Struct({
  name: Text,
  title: optional(Text),
  description: optional(Text),
  version: Text,
  websiteUrl: optional(Text),
  repository: optional(Schema.Struct({ url: optional(Text) })),
  packages: optional(Schema.Array(Package)),
  remotes: optional(Schema.Array(Remote)),
})
const Official = Schema.Struct({ status: optional(Text), isLatest: optional(Schema.Boolean) })
const Item = Schema.Struct({
  server: Server,
  _meta: optional(Schema.Struct({ "io.modelcontextprotocol.registry/official": optional(Official) })),
})
const List = Schema.Struct({
  servers: Schema.Array(Schema.Unknown),
  metadata: optional(Schema.Struct({ nextCursor: optional(Text) })),
})

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(List))
const decodeItem = Schema.decodeUnknownOption(Item)

type Item = typeof Item.Type
type Package = typeof Package.Type
type Argument = typeof Argument.Type
type KeyValue = typeof KeyValue.Type
type Variable = typeof Variable.Type

function entryOf(item: Item, taken: ReadonlySet<string>): OwnMcp.RegistryEntry | undefined {
  const server = item.server
  const status = item._meta?.["io.modelcontextprotocol.registry/official"]?.status ?? "active"
  if (status !== "active" && status !== "deprecated") return undefined
  const options = [
    ...(server.packages ?? []).slice(0, 8).map(packageOption),
    ...(server.remotes ?? []).slice(0, 8).map(remoteOption),
  ].filter((option) => option !== undefined)
  if (options.length === 0 || !server.name.includes("/")) return undefined
  const repository = server.repository?.url
  const version = server.version.trim()
  return {
    name: clip(server.name, 200),
    ...(server.title ? { title: clip(server.title, 200) } : {}),
    ...(server.description ? { description: clip(server.description, MAX_TEXT) } : {}),
    version: clip(version, MAX_VERSION),
    publisher: clip(server.name.slice(0, server.name.indexOf("/")), 200),
    ...(repository && web(repository) ? { repository } : {}),
    ...(server.websiteUrl && web(server.websiteUrl) ? { website: server.websiteUrl } : {}),
    status,
    suggested: McpRules.suggestName(server.name.slice(server.name.lastIndexOf("/") + 1), taken),
    options,
  }
}

/** The runtimes own starts a package with, by `runtimeHint` or else by registry. */
const RUNTIMES: Readonly<Record<string, string>> = { npm: "npx", pypi: "uvx", oci: "docker", nuget: "dnx" }
const KNOWN = new Set(["npx", "uvx", "docker", "dnx"])

function packageOption(pkg: Package): OwnMcp.RegistryPackage | undefined {
  if (pkg.identifier.length > MAX_IDENTIFIER || (pkg.version?.length ?? 0) > MAX_VERSION) return undefined
  const registryType = clip(pkg.registryType.toLowerCase(), 32)
  const runtime = pkg.runtimeHint ?? RUNTIMES[registryType]
  const transport = pkg.transport?.type ?? "stdio"
  const fill = new Set<string>()
  const secrets: OwnMcp.RegistryValue[] = []
  const env = (pkg.environmentVariables ?? []).slice(0, MAX_VALUES).map((item) => valueOf(item.name, item))
  const base = {
    type: "package" as const,
    registryType,
    identifier: pkg.identifier,
    ...(pkg.version ? { version: pkg.version } : {}),
  }
  const problem = transport !== "stdio" ? "transport" : runtime === undefined || !KNOWN.has(runtime) ? "runtime" : undefined
  if (problem !== undefined || runtime === undefined) {
    const option = { ...base, args: [], env, fill: [], problem: problem ?? "runtime" } as const
    return exact(option) ? option : undefined
  }
  const taken = new Set(env.map((item) => item.name))
  const words = (list: ReadonlyArray<Argument> | undefined) =>
    (list ?? []).slice(0, 32).flatMap((arg) => argument(arg, fill, secrets, taken))
  const runtimeArgs = words(pkg.runtimeArguments)
  const packageArgs = words(pkg.packageArguments)
  const spec = (separator: string) => (pkg.version ? `${pkg.identifier}${separator}${pkg.version}` : pkg.identifier)
  const all = [...env, ...secrets]
  const args =
    runtime === "npx"
      ? [...(runtimeArgs.some((arg) => arg === "-y" || arg === "--yes") ? [] : ["-y"]), ...runtimeArgs, spec("@"), ...packageArgs]
      : runtime === "uvx"
        ? [...runtimeArgs, spec("=="), ...packageArgs]
        : runtime === "dnx"
          ? [...runtimeArgs, spec("@"), "--yes", ...packageArgs]
          : ["run", "-i", "--rm", ...all.flatMap((item) => ["-e", item.name]), ...runtimeArgs, image(pkg), ...packageArgs]
  const option = { ...base, command: runtime, args, env: all, fill: [...fill] }
  return exact(option) ? option : undefined
}

function remoteOption(remote: typeof Remote.Type): OwnMcp.RegistryRemote | undefined {
  const fill = new Set<string>()
  const variables = Object.entries(remote.variables ?? {})
    .slice(0, 32)
    .map(([name, item]) => valueOf(name, item))
  const url = substitute(remote.url, remote.variables, fill)
  const option = {
    type: "remote" as const,
    transport: clip(remote.type, 32),
    url,
    headers: (remote.headers ?? []).slice(0, 32).map((item) => valueOf(item.name, item)),
    variables,
    fill: [...fill],
    ...(remote.type === "sse" ? { problem: "sse" as const } : remote.type !== "streamable-http" ? { problem: "transport" as const } : {}),
  }
  return option.url.length <= MAX_URL && exact(option) ? option : undefined
}

/**
 * Whether an option's exact parts fit (see the module comment): the arguments and values the form takes, their
 * names and the `{parts}` to fill. Its display parts are clipped already.
 */
function exact(option: OwnMcp.RegistryOption) {
  const values = option.type === "package" ? option.env : [...option.headers, ...option.variables]
  return (
    (option.type === "remote" || (option.args.length <= MAX_ARGS && option.args.every((arg) => arg.length <= MAX_WORD))) &&
    values.length <= MAX_VALUES &&
    values.every((value) => value.name.length <= MAX_NAME) &&
    option.fill.length <= 32 &&
    option.fill.every((label) => label.length <= MAX_LABEL)
  )
}

/**
 * One argument as words: a named one `--name value`, a positional one its value. A value to fill becomes `{hint}`
 * (named in `fill`), a secret one `${NAME}` with NAME a value to fill (`secrets`); an optional argument without a
 * value is left out.
 */
function argument(arg: Argument, fill: Set<string>, secrets: OwnMcp.RegistryValue[], taken: Set<string>): string[] {
  const given = arg.value ?? arg.default
  const named = arg.type === "named"
  if (named && !arg.name) return []
  const label = (named ? arg.name!.replace(/^-+/, "") : arg.valueHint) || "value"
  const value = (() => {
    if (arg.isSecret) {
      const name = envName(label, taken)
      taken.add(name)
      secrets.push({
        name,
        ...(arg.description ? { description: clip(arg.description, MAX_TEXT) } : {}),
        required: arg.isRequired === true,
        secret: true,
      })
      return "${" + name + "}"
    }
    if (given !== undefined) return substitute(given, arg.variables, fill)
    if (!arg.isRequired) return undefined
    fill.add(label)
    return `{${label}}`
  })()
  if (named) return value === undefined ? (arg.isRequired && arg.format === "boolean" ? [arg.name!] : []) : [arg.name!, value]
  return value === undefined ? [] : [value]
}

/** `{name}` parts with a non-secret default or value put in; the others are kept and named in `fill`. */
function substitute(text: string, variables: Readonly<Record<string, Variable>> | undefined, fill: Set<string>) {
  return text.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, name: string) => {
    const variable = variables?.[name]
    const given = variable?.isSecret ? undefined : (variable?.value ?? variable?.default)
    if (given !== undefined) return given
    fill.add(name)
    return whole
  })
}

function valueOf(name: string, item: KeyValue | Variable): OwnMcp.RegistryValue {
  const given = item.value ?? item.default
  const template = given !== undefined && /\{[A-Za-z0-9_.-]+\}/.test(given)
  return {
    name,
    ...(item.description ? { description: clip(item.description, MAX_TEXT) } : {}),
    required: item.isRequired === true,
    secret: item.isSecret === true,
    ...(given !== undefined && !template && item.isSecret !== true && given.length <= OwnMcp.MAX_VALUE
      ? { value: given }
      : {}),
    ...(template ? { template: clip(given!, 500) } : {}),
  }
}

/** An OCI image with its version as the tag, unless the identifier names a tag or a digest already. */
function image(pkg: Package) {
  const last = pkg.identifier.slice(pkg.identifier.lastIndexOf("/") + 1)
  if (!pkg.version || last.includes(":") || last.includes("@")) return pkg.identifier
  return `${pkg.identifier}:${pkg.version}`
}

function envName(label: string, taken: ReadonlySet<string>) {
  const cleaned = label.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
  const base = McpRules.ENV_NAME.test(cleaned) ? cleaned : `ARG_${cleaned || "VALUE"}`
  const pick = (index: number): string => {
    const name = index === 1 ? base : `${base}_${index}`
    return taken.has(name) ? pick(index + 1) : name
  }
  return pick(1)
}

function web(value: string) {
  if (value.length > MAX_URL || !URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === "https:" || protocol === "http:"
}

function clip(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}
