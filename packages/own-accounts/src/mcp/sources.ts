export * as McpSources from "./sources.js"

import fsp from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { McpRules, McpSecrets, OwnMcp } from "@own/protocol"
import { Location } from "../location.js"

/**
 * `다른 도구에서 가져오기` (03 §18.14, SM): the MCP servers other tools configured, read only when the user asks and
 * never written. Exactly these files are opened, and only their MCP entries are kept:
 * - Codex: `<codexHome>\config.toml`, the `[mcp_servers.<name>]` tables (`command`/`args`/`env`/`cwd`, or `url` with
 *   `http_headers`, `env_http_headers`, `bearer_token_env_var`);
 * - Claude Code: `<home>\.claude.json` (and `%CLAUDE_CONFIG_DIR%\.claude.json` when the service has one): the user's
 *   `mcpServers` and the project's entry `projects["<folder>"].mcpServers`;
 * - the project's `.mcp.json` (`mcpServers`, Claude Code's shared project file).
 * `${VAR}` and `${VAR:-default}` (Claude Code) and Codex's variable names are read from this service's environment.
 * A value read so, and an argument that holds a value (`McpSecrets.lift`), is never put into a command, an argument or
 * an address as plain text: the command and arguments keep `${NAME}` with NAME a stored environment value, an address
 * keeps the `${VAR}` it was written with and is stored whole in the vault (`written`).
 */

export type Draft =
  | {
      readonly type: "local"
      readonly command: string
      readonly args: ReadonlyArray<string>
      readonly cwd?: string
      readonly env: Readonly<Record<string, string>>
    }
  | {
      readonly type: "remote"
      /** The whole address, `?` part included. */
      readonly url: string
      /** The address as the other tool wrote it, `${VAR}` parts kept (Claude Code), when it named variables. */
      readonly written?: string
      readonly headers: Readonly<Record<string, string>>
      readonly oauth: boolean
    }

export interface Found {
  readonly source: OwnMcp.Source
  readonly name: string
  readonly enabled: boolean
  readonly draft?: Draft
  readonly notes: ReadonlyArray<OwnMcp.Note>
  readonly problem?: OwnMcp.Problem
}

export interface Paths {
  readonly codexHome: string
  /** Folders whose `.claude.json` is read (the user's home, then `CLAUDE_CONFIG_DIR`); duplicates are read once. */
  readonly claudeHomes: ReadonlyArray<string>
  /** The project of the settings page (its `.mcp.json` and its `.claude.json` entry). */
  readonly directory?: string
}

type Env = Readonly<Record<string, string | undefined>>

/** `.claude.json` keeps Claude Code's project history too, so it can be large; larger files are not read. */
const MAX_FILE = 32 * 1024 * 1024

export async function read(paths: Paths, env: Env) {
  const files: OwnMcp.SourceFile[] = []
  const found: Found[] = []
  const add = (source: OwnMcp.Source, file: string, state: OwnMcp.SourceFile["state"], items: Found[] = []) => {
    files.push({ source, path: file, state, count: items.length })
    found.push(...items)
  }

  const codex = path.join(paths.codexHome, "config.toml")
  const codexText = await text(codex)
  if (!codexText.ok) add("codex", codex, codexText.state)
  if (codexText.ok) {
    const items = codexServers(codexText.content, env)
    add("codex", codex, items === undefined ? "invalid" : "found", items)
  }

  const claudeFiles = [...new Set(paths.claudeHomes.map((home) => path.resolve(home, ".claude.json")))]
  for (const file of claudeFiles) {
    const content = await text(file)
    const root = content.ok ? json(content.content) : undefined
    if (!content.ok || root === undefined) {
      add("claude-user", file, content.ok ? "invalid" : content.state)
      continue
    }
    add("claude-user", file, "found", servers(root.mcpServers, "claude-user", env))
    const directory = paths.directory
    if (directory === undefined) continue
    const project = projectEntry(root.projects, directory)
    if (project !== undefined) add("claude-project", file, "found", servers(project.mcpServers, "claude-project", env))
  }

  if (paths.directory !== undefined) {
    const file = path.join(paths.directory, ".mcp.json")
    const content = await text(file)
    const root = content.ok ? json(content.content) : undefined
    if (!content.ok) add("project-file", file, content.state)
    if (content.ok)
      add(
        "project-file",
        file,
        root === undefined ? "invalid" : "found",
        root === undefined ? [] : servers(root.mcpServers, "project-file", env),
      )
  }
  return { files, found }
}

async function text(
  file: string,
): Promise<
  { readonly ok: true; readonly content: string } | { readonly ok: false; readonly state: "missing" | "unreadable" }
> {
  const stat = await fsp.stat(file).catch(() => undefined)
  if (stat === undefined) return { ok: false, state: "missing" }
  if (!stat.isFile() || stat.size > MAX_FILE) return { ok: false, state: "unreadable" }
  return fsp.readFile(file, "utf8").then(
    (content) => ({ ok: true as const, content }),
    () => ({ ok: false as const, state: "unreadable" as const }),
  )
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function json(content: string) {
  const value = Option.getOrUndefined(decodeJson(content.replace(/^﻿/, "")))
  return isRecord(value) ? value : undefined
}

/** Claude Code keys its project entries by folder, with `/` or `\`; Windows folders compare without case. */
function projectEntry(projects: unknown, directory: string) {
  if (!isRecord(projects)) return undefined
  const entry = Object.entries(projects).find(([folder]) => Location.same(folder, directory))?.[1]
  return isRecord(entry) ? entry : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code (`mcpServers`: `{type?: "stdio" | "http" | "sse", command, args, env, url, headers}`)

const CLAUDE_KEYS = new Set(["type", "command", "args", "env", "url", "headers"])

export function servers(value: unknown, source: OwnMcp.Source, env: Env): Found[] {
  if (!isRecord(value)) return []
  return Object.entries(value).map(([name, raw]) => claudeEntry(name, raw, source, env))
}

function claudeEntry(name: string, raw: unknown, source: OwnMcp.Source, env: Env): Found {
  const notes = new Set<OwnMcp.Note>()
  const invalid: Found = { source, name, enabled: true, notes: [], problem: "invalid" }
  if (!isRecord(raw)) return invalid
  if (Object.keys(raw).some((key) => !CLAUDE_KEYS.has(key))) notes.add("settings_dropped")
  const type = typeof raw.type === "string" ? raw.type : typeof raw.url === "string" ? "http" : "stdio"
  if (type === "sse") return { source, name, enabled: true, notes: [], problem: "sse" }
  if (type === "stdio") {
    const args = strings(raw.args)
    const values = record(raw.env)
    if (typeof raw.command !== "string" || !raw.command || args === undefined || values === undefined) return invalid
    const environment: Record<string, string> = Object.fromEntries(
      Object.entries(values).flatMap(([key, item]) => {
        const expanded = expandValue(item, env, notes)
        return expanded === undefined ? [] : [[key, expanded]]
      }),
    )
    // `${VAR}` in the command and the arguments stays a reference: its value becomes a stored environment value.
    const keep = (value: string) => keepVars(value, env, environment, notes)
    const command = keep(raw.command)
    if (!command) return invalid
    return finish({ source, name, enabled: true, draft: local(command, args.map(keep), undefined, environment), notes })
  }
  if (type !== "http" || typeof raw.url !== "string") return invalid
  const headers = record(raw.headers)
  if (headers === undefined) return invalid
  const values = Object.fromEntries(
    Object.entries(headers).flatMap(([key, item]) => {
      const expanded = expandValue(item, env, notes)
      return expanded === undefined ? [] : [[key, expanded]]
    }),
  )
  const written = raw.url.includes("${") ? raw.url : undefined
  return finish({ source, name, enabled: true, draft: remote(expandVars(raw.url, env, notes), values, written), notes })
}

// ---------------------------------------------------------------------------------------------------------------
// Codex (`[mcp_servers.<name>]`)

const CODEX_KEYS = new Set([
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
  "url",
  "http_headers",
  "env_http_headers",
  "bearer_token",
  "bearer_token_env_var",
  "http_headers_helper",
  "enabled",
  "enabled_tools",
  "disabled_tools",
])

/** The servers of a Codex `config.toml`; `undefined` when it is not TOML. */
export function codexServers(content: string, env: Env): Found[] | undefined {
  const root = Option.getOrUndefined(parseToml(content))
  if (!isRecord(root)) return undefined
  const table = root.mcp_servers
  if (!isRecord(table)) return []
  return Object.entries(table).map(([name, raw]) => codexEntry(name, raw, env))
}

function codexEntry(name: string, raw: unknown, env: Env): Found {
  const invalid: Found = { source: "codex", name, enabled: true, notes: [], problem: "invalid" }
  if (!isRecord(raw)) return invalid
  const notes = new Set<OwnMcp.Note>()
  const enabled = raw.enabled !== false
  if (!enabled) notes.add("disabled")
  if (raw.enabled_tools !== undefined || raw.disabled_tools !== undefined) notes.add("tool_filter")
  if (Object.keys(raw).some((key) => !CODEX_KEYS.has(key))) notes.add("settings_dropped")
  if (typeof raw.command === "string" && raw.command) {
    const args = strings(raw.args)
    const values = record(raw.env)
    if (args === undefined || values === undefined) return invalid
    // Codex passes these from its own environment; core passes this service's environment to every server anyway.
    const passed = Array.isArray(raw.env_vars)
      ? raw.env_vars.flatMap((item) =>
          typeof item === "string" ? [item] : isRecord(item) && typeof item.name === "string" ? [item.name] : [],
        )
      : []
    if (passed.some((variable) => env[variable] === undefined)) notes.add("env_missing")
    const cwd = typeof raw.cwd === "string" && raw.cwd ? raw.cwd : undefined
    return finish({ source: "codex", name, enabled, draft: local(raw.command, args, cwd, values), notes })
  }
  if (typeof raw.url !== "string") return invalid
  const fixed = record(raw.http_headers) ?? {}
  const fromEnv = Object.fromEntries(
    Object.entries(record(raw.env_http_headers) ?? {}).flatMap(([header, variable]) => {
      const value = env[variable]
      notes.add(value === undefined ? "env_missing" : "env_read")
      return value === undefined ? [] : [[header, value]]
    }),
  )
  const bearer = (() => {
    if (typeof raw.bearer_token === "string" && raw.bearer_token) return raw.bearer_token
    if (typeof raw.bearer_token_env_var !== "string") return undefined
    const value = env[raw.bearer_token_env_var]
    notes.add(value === undefined ? "env_missing" : "env_read")
    return value
  })()
  if (typeof raw.http_headers_helper === "string") notes.add("headers_helper")
  const headers = { ...fixed, ...fromEnv, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
  return finish({ source: "codex", name, enabled, draft: remote(raw.url, headers), notes })
}

// ---------------------------------------------------------------------------------------------------------------

function local(command: string, args: ReadonlyArray<string>, cwd: string | undefined, env: Record<string, string>) {
  return { type: "local" as const, command, args, ...(cwd === undefined ? {} : { cwd }), env }
}

function remote(url: string, headers: Record<string, string>, written?: string) {
  return { type: "remote" as const, url, ...(written === undefined ? {} : { written }), headers, oauth: true }
}

/** Checks the limits own's own form has (OwnMcp inputs); anything else cannot be imported as it is. */
function finish(input: {
  readonly source: OwnMcp.Source
  readonly name: string
  readonly enabled: boolean
  readonly draft: Draft
  readonly notes: Set<OwnMcp.Note>
}): Found {
  const draft = secure(input.draft, input.notes)
  const notes = [...input.notes]
  const base = { source: input.source, name: input.name, enabled: input.enabled, notes }
  return valid(draft) ? { ...base, draft } : { ...base, problem: "invalid" }
}

/** Values in the arguments move into the environment values; an address with a value in it is noted. */
function secure(draft: Draft, notes: Set<OwnMcp.Note>): Draft {
  if (draft.type === "remote") {
    if (httpURL(draft.url) && McpSecrets.address(draft.url, draft.written).hidden) notes.add("values_moved")
    return draft
  }
  const lifted = McpSecrets.lift(draft.command, draft.args, draft.env)
  const referred = [draft.command, ...draft.args].some((part) => McpRules.references(part).length > 0)
  if (lifted.moved || referred) notes.add("values_moved")
  return { ...draft, args: lifted.args, env: { ...lifted.env } }
}

export function valid(draft: Draft) {
  const values = Object.values(draft.type === "local" ? draft.env : draft.headers)
  if (values.some((value) => value.length === 0 || value.length > OwnMcp.MAX_VALUE)) return false
  if (draft.type === "local")
    return (
      draft.command.length > 0 &&
      draft.command.length <= 1024 &&
      draft.args.length <= 64 &&
      draft.args.every((arg) => arg.length <= 4096) &&
      Object.keys(draft.env).length <= 64 &&
      Object.keys(draft.env).every((key) => OwnMcp.ENV_NAME.test(key))
    )
  return (
    httpURL(draft.url) &&
    Object.keys(draft.headers).length <= 32 &&
    Object.keys(draft.headers).every((key) => OwnMcp.HEADER_NAME.test(key))
  )
}

export function httpURL(value: string) {
  if (value.length > 4096 || !URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === "http:" || protocol === "https:"
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * `${VAR}` in a command or an argument: a set VAR stays a reference `${NAME}` with its value stored as the environment
 * value NAME (VAR, or another name when the server's own environment gives VAR a different value); an unset one
 * becomes its default, or empty (as Claude Code does).
 */
function keepVars(value: string, env: Env, environment: Record<string, string>, notes: Set<OwnMcp.Note>) {
  return value.replace(VARIABLE, (_, name: string, fallback: string | undefined) => {
    const found = env[name]
    if (found === undefined) {
      if (fallback !== undefined) return fallback
      notes.add("env_missing")
      return ""
    }
    notes.add("env_read")
    const same = Object.entries(environment).find((entry) => entry[1] === found)?.[0]
    const stored = same ?? freeName(name, environment)
    environment[stored] = found
    return "${" + stored + "}"
  })
}

function freeName(base: string, taken: Readonly<Record<string, string>>) {
  const pick = (index: number): string => {
    const name = index === 1 ? base : `${base}_${index}`
    return Object.hasOwn(taken, name) ? pick(index + 1) : name
  }
  return pick(1)
}

/** `${VAR}` and `${VAR:-default}` from the environment; an unset one without a default becomes empty. */
function expandVars(value: string, env: Env, notes: Set<OwnMcp.Note>) {
  return value.replace(VARIABLE, (_, name: string, fallback: string | undefined) => {
    const found = env[name]
    if (found !== undefined) {
      notes.add("env_read")
      return found
    }
    if (fallback !== undefined) return fallback
    notes.add("env_missing")
    return ""
  })
}

/** A value of `env` or `headers`: left out when it is not text or a variable it names is unset (no default). */
function expandValue(value: unknown, env: Env, notes: Set<OwnMcp.Note>) {
  if (typeof value !== "string") return undefined
  const missing = [...value.matchAll(VARIABLE)].some((match) => env[match[1]!] === undefined && match[2] === undefined)
  const expanded = expandVars(value, env, notes)
  return missing || expanded === "" ? undefined : expanded
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined
  return value
}

function record(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" ? [[key, item] as const] : [],
  )
  return entries.length === Object.keys(value).length ? Object.fromEntries(entries) : undefined
}

const parseToml = Option.liftThrowable((content: string): unknown => Bun.TOML.parse(content))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

