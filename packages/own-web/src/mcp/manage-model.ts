// Pure view logic of 설정 > MCP 서버's management (03 §18.14, SM 2026-10-24): where each listed server comes from
// (own's own list or a config file), what a row shows of its definition (names of values, never values), the add and
// edit form and its checks, `JSON 붙여넣기` (a README's `mcpServers` snippet) and the form of an MCP Registry entry
// (`찾아서 설치`). No Solid, no DOM; unit-tested in manage.test.ts. The name and value rules and free names are
// own-protocol's `McpRules`, and the values a definition hides own-protocol's `McpSecrets`, the modules own.accounts
// uses.
import type { ConfigEntry } from "@opencode/client"
import type { OwnMcp } from "@own/protocol"
import { ENV_NAME, HEADER_NAME, MAX_VALUE, NAME_PATTERN, references, suggestName } from "@own/protocol/mcp-rules"
import { maskAddress, maskArgs } from "@own/protocol/mcp-secrets"
import type { McpRow } from "./model"
import { samePath } from "@/projects/path"
import { switchAt, switchEffective, switchesDiffering, switchesReaching } from "@/projects/switches"
import { isInside } from "@/worktree/model"

export { ENV_NAME, HEADER_NAME, MAX_VALUE, NAME_PATTERN, suggestName }

export type View = OwnMcp.View
export type Server = OwnMcp.Server
export type Check = OwnMcp.Check
/** What a window without `mcp.list` (a phone, another PC) knows of own's servers (`mcp.summary`). */
export type Summary = OwnMcp.SummaryServer

/** A server of a config file, as `GET /api/config` gives it: names of its values only. */
export interface FileServer {
  readonly name: string
  /** The config file, when core names it. */
  readonly path?: string
  readonly type: "local" | "remote"
  /** The command line or the address, every value own would keep in the vault as `••••` (`McpSecrets`). */
  readonly summary: string
  readonly env: ReadonlyArray<string>
  readonly headers: ReadonlyArray<string>
}

type ServerConfig = NonNullable<
  NonNullable<Extract<ConfigEntry, { type: "document" }>["info"]["mcp"]>["servers"]
>[string]

/** The servers of the config documents (lowest priority first, so a later file's server of the same name wins). */
export function fileServers(entries: ReadonlyArray<ConfigEntry>): FileServer[] {
  const found = new Map<string, FileServer>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [name, server] of Object.entries(entry.info.mcp?.servers ?? {}))
      found.set(name, { name, ...(entry.path ? { path: entry.path } : {}), ...describe(server) })
  }
  return [...found.values()]
}

function describe(server: ServerConfig) {
  if (server.type === "local") {
    const command = server.command[0] ?? ""
    return {
      type: "local" as const,
      summary: commandLine(command, maskArgs(command, server.command.slice(1))),
      env: Object.keys(server.environment ?? {}),
      headers: [],
    }
  }
  return {
    type: "remote" as const,
    summary: maskAddress(server.url),
    env: [],
    headers: Object.keys(server.headers ?? {}),
  }
}

/** The config document's definition of one server with its values, for a connection test of that server. */
export function fileTransport(entries: ReadonlyArray<ConfigEntry>, name: string): OwnMcp.TransportInput | undefined {
  const server = entries
    .flatMap((entry) => (entry.type === "document" ? [entry.info.mcp?.servers?.[name]] : []))
    .filter((item) => item !== undefined)
    .at(-1)
  if (server === undefined) return undefined
  if (server.type === "local")
    return {
      type: "local",
      command: server.command[0] ?? "",
      args: server.command.slice(1),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      env: Object.entries(server.environment ?? {}).map(([key, value]) => ({ name: key, value })),
    }
  return {
    type: "remote",
    url: server.url,
    headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
    oauth: server.oauth !== false,
  }
}

/**
 * Where a listed server comes from in this project. own's server comes with its definition on this PC (`Server`),
 * by name only elsewhere (`Summary`): then the row shows no definition, since the one that runs is not known there.
 */
export type Source =
  | { readonly type: "own"; readonly server: Server | Summary }
  | { readonly type: "file"; readonly server: FileServer }
  | { readonly type: "other" }

/** own's server wins over a config file's of the same name (own's fold runs after core's config fold). */
export function sourceOf(
  name: string,
  own: ReadonlyArray<Server | Summary>,
  files: ReadonlyArray<FileServer>,
  directory: string | undefined,
): Source {
  const mine = own.find((server) => server.name === name && reaches(server.scope, directory))
  if (mine) return { type: "own", server: mine }
  const file = files.find((server) => server.name === name)
  if (file) return { type: "file", server: file }
  return { type: "other" }
}

/** own's server with its definition (this PC's `mcp.list`), not a summary. */
export function defined(server: Server | Summary): server is Server {
  return "transport" in server
}

/** Whether a scope reaches the project folder (the folder itself or a folder inside it). */
export function reaches(scope: OwnMcp.Scope, directory: string | undefined) {
  if (scope.type === "global") return true
  if (directory === undefined) return false
  return isInside(scope.directory, directory)
}

/** The servers own added that this project does not run (another project's), so they can still be changed. */
export function elsewhere(own: ReadonlyArray<Server>, directory: string | undefined) {
  return own.filter((server) => !reaches(server.scope, directory))
}

// ---------------------------------------------------------------------------------------------------------------
// The list's kept switches, global first (SG 2026-10-26): no folder is every project; the global switch applies first,
// then the project folders from the shallowest to the deepest (own.accounts `McpFold`).

export type Override = OwnMcp.Override

/** What a project's row says of its switches: off here, on only here, or off in every project (and where). */
export interface McpTag {
  readonly kind: "offHere" | "onlyHere" | "offAll"
  /** The folder of the switch that decides it here (`되돌리기` deletes it); none for the global one. */
  readonly directory?: string
}

/**
 * The tag of server `name` in `directory`: the deepest project switch that differs from what its place inherits and
 * gives the server its state here (`이 프로젝트에서 끔`, `이 프로젝트에서만 켬`), else the global switch when it keeps
 * the server off (`모든 프로젝트에서 꺼 둠`). A switch that only repeats what it inherits tags nothing.
 */
export function exceptionTag(
  overrides: ReadonlyArray<Override>,
  name: string,
  directory: string | undefined,
): McpTag | undefined {
  const mine = overrides.filter((item) => item.name === name)
  const on = switchEffective(mine, directory)
  const decided = switchesReaching(switchesDiffering(mine), directory).at(-1)
  if (decided && decided.enabled === on) return { kind: on ? "onlyHere" : "offHere", directory: decided.directory }
  if (!on && switchAt(mine, undefined)?.enabled === false) return { kind: "offAll" }
  return undefined
}

/** A `모든 프로젝트` row: own's server used everywhere, its global switch and the projects that differ. */
export interface GlobalRow {
  readonly server: Server | Summary
  readonly off: boolean
  readonly exceptions: { readonly off: ReadonlyArray<string>; readonly only: ReadonlyArray<string> }
}

/** own's servers used in every project (`모든 프로젝트` of 설정 > MCP 서버), with their switches. */
export function globalRows(own: ReadonlyArray<Server | Summary>, overrides: ReadonlyArray<Override>): GlobalRow[] {
  return own
    .filter((server) => server.scope.type === "global")
    .map((server) => {
      const mine = overrides.filter((item) => item.name === server.name)
      const differ = switchesDiffering(mine)
      return {
        server,
        off: switchAt(mine, undefined)?.enabled === false,
        exceptions: {
          off: differ.filter((item) => !item.enabled).map((item) => item.directory),
          only: differ.filter((item) => item.enabled).map((item) => item.directory),
        },
      }
    })
}

/** The global switch of `name` as `되돌리기` puts it back (`null`: none). */
export function globalSwitch(overrides: ReadonlyArray<Override>, name: string) {
  return (
    switchAt(
      overrides.filter((item) => item.name === name),
      undefined,
    )?.enabled ?? null
  )
}

/** Each own server's `codemode` when it is set (the list's `직접 도구` tag, beside the config files' own). */
export function codeModes(own: ReadonlyArray<Server | Summary>, directory: string | undefined) {
  return Object.fromEntries(
    own.flatMap((server) =>
      defined(server) && server.transport.codemode !== undefined && reaches(server.scope, directory)
        ? [[server.name, server.transport.codemode]]
        : [],
    ),
  )
}

/**
 * What a row shows of own's server: the command line (`${NAME}` for a stored value) or the address, its value parts
 * as `••••` or `${VAR}` and `?…` when its query is in the vault.
 */
export function summaryOf(server: Server) {
  return transportLine(server.transport)
}

export function transportLine(transport: OwnMcp.Transport) {
  if (transport.type === "local") return commandLine(transport.command, transport.args)
  return transport.query ? `${transport.url}?…` : transport.url
}

/** A command line as a person would type it: arguments with spaces in quotes. */
export function commandLine(command: string, args: ReadonlyArray<string>) {
  // Quotes only, never JSON escapes: a Windows path keeps its single backslashes.
  return [command, ...args]
    .map((part) => (/[\s"]/.test(part) || part === "" ? `"${part.replaceAll('"', '\\"')}"` : part))
    .join(" ")
}

/** own's servers of a project and their masked error text; `all` while it is not known which servers are own's. */
export interface OwnErrors {
  readonly names: ReadonlyArray<string> | "all"
  readonly errors?: Readonly<Record<string, string>>
}

/**
 * The rows with core's error text of own's servers replaced by own.accounts' (`mcp.list` with the project's folder),
 * which has their stored values cut out; an own server's text not given (another device, not read yet) is not shown.
 */
export function withOwnErrors(rows: ReadonlyArray<McpRow>, own: OwnErrors): McpRow[] {
  return rows.map((row) => {
    if (own.names !== "all" && !own.names.includes(row.name)) return row
    const error = own.errors?.[row.name]
    return error === undefined ? { ...row, error: undefined } : { ...row, error }
  })
}

/** Names of a server's stored values, e.g. `GITHUB_TOKEN …9fQ2`. */
export function secretsOf(secrets: ReadonlyArray<OwnMcp.Secret>) {
  return secrets.map((secret) => (secret.hint ? `${secret.name} ${secret.hint}` : secret.name))
}

// ---------------------------------------------------------------------------------------------------------------
// The add and edit form

export interface ValueRow {
  readonly key: number
  readonly name: string
  /** What the user typed; empty keeps a stored value. */
  readonly value: string
  /** The stored value's hint, when the server has one under this name. */
  readonly stored?: { readonly hint?: string }
  /** From the MCP Registry: what the value is for. */
  readonly note?: string
  /** From the MCP Registry: not needed, so an empty field leaves it out. */
  readonly optional?: boolean
  /** From the MCP Registry: not a secret, so its field shows what it holds. */
  readonly plain?: boolean
  /** From the MCP Registry: the value's form, e.g. `Bearer {api_key}`. */
  readonly template?: string
}

/** `기본`: core's default (on, off for servers that are Code Mode themselves); `on`/`off`: set for this server. */
export type CodeMode = "default" | "on" | "off"

export interface Form {
  readonly id?: OwnMcp.ID
  readonly name: string
  /** Where it is used: kept as it is on an edit, changed only by the form's scope picker. */
  readonly scope: OwnMcp.Scope
  readonly type: "local" | "remote"
  readonly command: string
  /** One argument per line. */
  readonly args: string
  readonly cwd: string
  readonly env: ReadonlyArray<ValueRow>
  /** Empty keeps the stored address (with its stored `?` part). */
  readonly url: string
  /** The stored address, shown while `url` is empty. */
  readonly storedURL?: string
  readonly headers: ReadonlyArray<ValueRow>
  readonly oauth: boolean
  readonly codemode: CodeMode
  /** `{parts}` an MCP Registry entry left to fill in the arguments or the address. */
  readonly fill: ReadonlyArray<string>
  /** The MCP Registry entry a new server is taken from. */
  readonly registry?: OwnMcp.RegistryRef
}

export function emptyForm(): Form {
  return {
    name: "",
    scope: { type: "global" },
    type: "local",
    command: "",
    args: "",
    cwd: "",
    env: [],
    url: "",
    headers: [],
    oauth: true,
    codemode: "default",
    fill: [],
  }
}

/**
 * The scope picker's choices: every project, the server's own project (an edit keeps it unless the user picks
 * another), and the page's project when that is another one.
 */
export function scopeChoices(
  form: Pick<Form, "scope">,
  original: OwnMcp.Scope | undefined,
  directory: string | undefined,
) {
  const folders = [
    ...(original?.type === "project" ? [original.directory] : []),
    ...(form.scope.type === "project" ? [form.scope.directory] : []),
    ...(directory === undefined ? [] : [directory]),
  ].filter((folder, index, all) => all.findIndex((other) => samePath(other, folder)) === index)
  return [
    { type: "global" } as const,
    ...folders.map((folder) => ({ type: "project" as const, directory: folder })),
  ] satisfies OwnMcp.Scope[]
}

export function sameScope(a: OwnMcp.Scope, b: OwnMcp.Scope) {
  if (a.type === "global" || b.type === "global") return a.type === b.type
  return samePath(a.directory, b.directory)
}

const rows = (secrets: ReadonlyArray<OwnMcp.Secret>, start: number) =>
  secrets.map((secret, index) => ({
    key: start + index,
    name: secret.name,
    value: "",
    stored: secret.hint ? { hint: secret.hint } : {},
  }))

/** The form of a saved server: its own scope, names of its values with their hints, never the values. */
export function formOf(server: Server): Form {
  const transport = server.transport
  const codemode: CodeMode = transport.codemode === undefined ? "default" : transport.codemode ? "on" : "off"
  const base = { ...emptyForm(), id: server.id, name: server.name, scope: server.scope, codemode }
  if (transport.type === "local")
    return {
      ...base,
      type: "local",
      command: transport.command,
      args: transport.args.join("\n"),
      cwd: transport.cwd ?? "",
      env: rows(transport.env, 0),
    }
  // An address with a value in it (`?` part, a hidden part) is kept unless a new one is typed.
  const kept = transport.query || transport.hidden === true
  return {
    ...base,
    type: "remote",
    url: kept ? "" : transport.url,
    ...(kept ? { storedURL: transportLine(transport) } : {}),
    headers: rows(transport.headers, 0),
    oauth: transport.oauth,
  }
}

/**
 * The add form of one option of an MCP Registry entry: the command and arguments (or the address) as the registry
 * gives them, its values as fields (a value the registry gives filled in, an optional one left out when empty),
 * `{parts}` to fill. Nothing is saved until the form is.
 */
export function registryForm(entry: OwnMcp.RegistryEntry, option: OwnMcp.RegistryOption): Form {
  const base = {
    ...emptyForm(),
    name: entry.suggested,
    fill: option.fill,
    // An entry may give no version; the server is still taken from it.
    registry: { name: entry.name, ...(entry.version ? { version: entry.version } : {}) },
  }
  const row = (value: OwnMcp.RegistryValue, key: number): ValueRow => ({
    key,
    name: value.name,
    value: value.value ?? "",
    ...(value.description ? { note: value.description } : {}),
    ...(value.required ? {} : { optional: true }),
    ...(value.secret ? {} : { plain: true }),
    ...(value.template ? { template: value.template } : {}),
  })
  if (option.type === "package")
    return {
      ...base,
      type: "local",
      command: option.command ?? "",
      args: option.args.join("\n"),
      env: option.env.map(row),
    }
  return { ...base, type: "remote", url: option.url, headers: option.headers.map(row) }
}

export type Problem =
  | "name"
  | "command"
  | "url"
  | "fill"
  | "reference"
  | "envName"
  | "envDuplicate"
  | "envValue"
  | "headerName"
  | "headerDuplicate"
  | "headerValue"
  | "tooLong"

/** What keeps the form from being saved, in the order the form shows its fields. */
export function problems(form: Form): Problem[] {
  const found: Problem[] = []
  if (!NAME_PATTERN.test(form.name.trim())) found.push("name")
  const values = form.type === "local" ? form.env : form.headers
  // An optional registry value left empty is left out, not missing.
  const named = values.filter((row) => row.name.trim() !== "" || row.value !== "").filter((row) => !dropped(row))
  const names = named.map((row) => row.name.trim())
  const pattern = form.type === "local" ? ENV_NAME : HEADER_NAME
  const prefix = form.type === "local" ? "env" : "header"
  if (form.type === "local" && !form.command.trim()) found.push("command")
  if (form.type === "remote" && !(form.url.trim() ? httpURL(form.url.trim()) : form.storedURL !== undefined))
    found.push("url")
  const parts = form.type === "local" ? [form.command, form.args] : [form.url]
  if (form.fill.some((name) => parts.some((part) => part.includes(`{${name}}`)))) found.push("fill")
  if (form.type === "local" && parts.flatMap(references).some((name) => !names.includes(name))) found.push("reference")
  if (names.some((name) => !pattern.test(name))) found.push(`${prefix}Name` as Problem)
  const folded = names.map((name) => (form.type === "local" ? name : name.toLowerCase()))
  if (folded.some((name, index) => folded.indexOf(name) !== index)) found.push(`${prefix}Duplicate` as Problem)
  if (named.some((row) => row.value === "" && row.stored === undefined)) found.push(`${prefix}Value` as Problem)
  if (named.some((row) => row.value.length > MAX_VALUE)) found.push("tooLong")
  return found
}

/** An optional registry value nobody filled in: not sent. */
function dropped(row: ValueRow) {
  return row.optional === true && row.value === "" && row.stored === undefined
}

export function httpURL(value: string) {
  if (value.length > 4096 || !URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === "http:" || protocol === "https:"
}

/** `mcp.save`'s input: the form's own scope, and an empty value keeps the stored one (it is left out). */
export function saveInput(form: Form): OwnMcp.SaveInput {
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    scope: form.scope,
    transport: transportInput(form),
    ...(form.registry && !form.id ? { registry: form.registry } : {}),
  }
}

/** The transport part alone, for a connection test of the form as it is. */
export function transportInput(form: Form): OwnMcp.TransportInput {
  const values = (list: ReadonlyArray<ValueRow>) =>
    list
      .filter((row) => row.name.trim() !== "" && !dropped(row))
      .map((row) => ({ name: row.name.trim(), ...(row.value === "" ? {} : { value: row.value }) }))
  const codemode = form.codemode === "default" ? {} : { codemode: form.codemode === "on" }
  if (form.type === "local")
    return {
      type: "local",
      command: form.command.trim(),
      args: form.args.split(/\r?\n/).filter((line) => line.trim() !== ""),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      env: values(form.env),
      ...codemode,
    }
  return {
    type: "remote",
    ...(form.url.trim() ? { url: form.url.trim() } : {}),
    headers: values(form.headers),
    oauth: form.oauth,
    ...codemode,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// JSON 붙여넣기

export interface Pasted {
  /** The name the snippet gives, if any. */
  readonly name?: string
  readonly form: Pick<Form, "type" | "command" | "args" | "cwd" | "url" | "oauth"> & {
    readonly env: ReadonlyArray<readonly [string, string]>
    readonly headers: ReadonlyArray<readonly [string, string]>
  }
}

export type PasteResult =
  | { readonly ok: true; readonly servers: ReadonlyArray<Pasted> }
  | { readonly ok: false; readonly reason: "json" | "empty" | "sse" }

/**
 * A server definition as READMEs give it: Claude Code's and Cursor's `{"mcpServers": {"name": {...}}}`, the inner
 * `{"name": {...}}`, one entry (`{"command": …}` / `{"url": …}`), or OpenCode's `{"mcp": {"servers": …}}` with
 * `{"type": "local", "command": [...]}`. The values go into the form only.
 */
export function parseServerJson(text: string): PasteResult {
  const value = json(text.trim())
  if (value === undefined) return { ok: false, reason: "json" }
  const table = isRecord(value.mcpServers)
    ? value.mcpServers
    : isRecord(value.mcp) && isRecord(value.mcp.servers)
      ? value.mcp.servers
      : isRecord(value.servers)
        ? value.servers
        : undefined
  const entries: [string | undefined, unknown][] =
    table !== undefined
      ? Object.entries(table)
      : entry(value)
        ? [[undefined, value]]
        : Object.entries(value).filter(([, item]) => entry(item))
  const parsed = entries.flatMap(([name, item]): (Pasted | "sse")[] => {
    const form = pastedForm(item)
    if (form === undefined) return []
    if (form === "sse") return ["sse"]
    return [{ ...(name ? { name } : {}), form }]
  })
  const servers = parsed.filter((item): item is Pasted => item !== "sse")
  if (servers.length > 0) return { ok: true, servers }
  return { ok: false, reason: parsed.includes("sse") ? "sse" : "empty" }
}

function entry(value: unknown) {
  return (
    isRecord(value) &&
    (typeof value.command === "string" || Array.isArray(value.command) || typeof value.url === "string")
  )
}

function pastedForm(item: unknown): Pasted["form"] | "sse" | undefined {
  if (!isRecord(item)) return undefined
  if (item.type === "sse") return "sse"
  const strings = (value: unknown) =>
    isRecord(value)
      ? Object.entries(value).flatMap(([key, entry]) => (typeof entry === "string" ? [[key, entry] as const] : []))
      : []
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((part) => typeof part === "string") : [])
  const command = Array.isArray(item.command)
    ? list(item.command)
    : typeof item.command === "string"
      ? [item.command]
      : []
  const base = { command: "", args: "", cwd: "", url: "", oauth: item.oauth !== false, env: [], headers: [] }
  if (command.length > 0)
    return {
      ...base,
      type: "local",
      command: command[0]!,
      args: [...command.slice(1), ...list(item.args)].join("\n"),
      cwd: typeof item.cwd === "string" ? item.cwd : "",
      env: [...strings(item.env), ...strings(item.environment)],
    }
  if (typeof item.url === "string") return { ...base, type: "remote", url: item.url, headers: strings(item.headers) }
  return undefined
}

function json(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined
  const attempt = (candidate: string) => {
    try {
      const value: unknown = JSON.parse(candidate)
      return isRecord(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  // A README often shows the inner part alone: `"name": { … }` without the outer braces.
  return attempt(text) ?? (text.startsWith('"') ? attempt(`{${text.replace(/,\s*$/, "")}}`) : undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The list's tool line of own's last test: its names, the first few of them. */
export function toolNames(check: Check, limit = 6) {
  const names = check.tools.map((tool) => tool.name)
  return { shown: names.slice(0, limit), more: names.length - Math.min(limit, names.length) + (check.more ? 1 : 0) }
}
