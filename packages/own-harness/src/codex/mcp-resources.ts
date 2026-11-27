// Codex's MCP resource tools (codex-rs/core/src/tools/handlers/mcp_resource.rs, mcp_resource/*.rs and
// mcp_resource_spec.rs, rust-v0.162.1): list_mcp_resources, list_mcp_resource_templates and read_mcp_resource, with
// Codex's definitions, argument handling, error texts and JSON payloads. They read MCP through core's resource tools
// (core/src/tool/plugin/mcp-resource.ts, `opencode_list_mcp_resources` and `opencode_read_mcp_resource`), which ask
// own's permissions; the plugin API has no other MCP resource access. Codex sends them when MCP servers are configured,
// and nests them in Code Mode's `exec` always (spec_plan.rs `add_mcp_resource_tools`).
//
// What core's tools do not carry cannot be reproduced: a resource's or template's `title`, `size`, `icons`,
// `annotations` and `_meta`, a content's `_meta`, the server's order within one server (core sorts by name and URI) and
// pagination (core reads the first page and drops `nextCursor`, so own never answers one and refuses a `cursor`).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as McpResources from "./mcp-resources.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { Catalog } from "./catalog.js"
import { CoreTool } from "./core-tool.js"
import { Truncate } from "./truncate/index.js"

export const LIST_RESOURCES = "list_mcp_resources"
export const LIST_TEMPLATES = "list_mcp_resource_templates"
export const READ_RESOURCE = "read_mcp_resource"
export const NAMES = [LIST_RESOURCES, LIST_TEMPLATES, READ_RESOURCE]

/** Core's resource tools, by registry id (namespace `opencode`). */
export const CORE_LIST = "opencode_list_mcp_resources"
export const CORE_READ = "opencode_read_mcp_resource"

/** `create_*_tool` (mcp_resource_spec.rs): Codex's definitions, as its `JsonSchema` serializes them. */
export const DEFINITIONS: Readonly<Record<string, { readonly description: string; readonly parameters: object }>> = {
  [LIST_RESOURCES]: {
    description:
      "Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.",
    parameters: listParameters(
      "Opaque cursor from a previous list_mcp_resources call; omit for the first page.",
      "MCP server name. Omit to list resources from every configured server.",
    ),
  },
  [LIST_TEMPLATES]: {
    description:
      "Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.",
    parameters: listParameters(
      "Opaque cursor from a previous list_mcp_resource_templates call; omit for the first page.",
      "MCP server name. Omit to list resource templates from every configured server.",
    ),
  },
  [READ_RESOURCE]: {
    description: "Read a specific resource from an MCP server given the server name and resource URI.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description:
            "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources.",
        },
        uri: {
          type: "string",
          description: "Resource URI to read. Must be one of the URIs returned by list_mcp_resources.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
  },
}

function listParameters(cursor: string, server: string) {
  return {
    type: "object",
    properties: {
      cursor: { type: "string", description: cursor },
      server: { type: "string", description: server },
    },
    additionalProperties: false,
  }
}

/** Codex has servers when any configured server is enabled (`McpConnectionManager::has_servers`). */
export function hasServers(ctx: Pick<Context, "mcp">) {
  return ctx.mcp.list().pipe(
    Effect.map((list) => list.data.some((server) => server.status.status !== "disabled")),
    Effect.orElseSucceed(() => false),
  )
}

/** A call's outcome: the JSON text Codex answers, or the text of a `RespondToModel` error. */
export type Outcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string }

/** Runs one of the three tools on its raw arguments (`None` when the call carried none). */
export function run(ctx: Pick<Context, "tool" | "session">, name: string, raw: unknown, tool: Tool.Context) {
  return Effect.gen(function* () {
    const payload = yield* operation(ctx, name, raw, tool)
    const model = yield* ctx.session.get({ sessionID: tool.sessionID }).pipe(
      Effect.map((info) => Catalog.lookup(info.model?.id ?? "")),
      Effect.orElseSucceed(() => Catalog.lookup("")),
    )
    // `serialize_function_output`: bounded like a regular MCP tool output.
    const text = Truncate.truncateText(
      JSON.stringify(payload),
      Truncate.withSerializationAllowance(model.truncation_policy),
    )
    return { ok: true, text } satisfies Outcome
  }).pipe(Effect.catch((error: unknown) => Effect.succeed<Outcome>({ ok: false, text: message(error) })))
}

class RespondToModel extends Error {}

function operation(ctx: Pick<Context, "tool">, name: string, raw: unknown, tool: Tool.Context) {
  if (name === READ_RESOURCE) return read(ctx, raw, tool)
  return list(ctx, name === LIST_TEMPLATES ? "templates" : "resources", raw, tool)
}

/** `ListMcpResourcesHandler` / `ListMcpResourceTemplatesHandler`. */
function list(ctx: Pick<Context, "tool">, kind: "resources" | "templates", raw: unknown, tool: Tool.Context) {
  return Effect.gen(function* () {
    const args = yield* parse(() => listArgs(raw))
    if (args.server === undefined && args.cursor !== undefined)
      return yield* Effect.fail(new RespondToModel("cursor can only be used when a server is specified"))
    const failed = kind === "resources" ? "resources/list failed" : "resources/templates/list failed"
    if (args.cursor !== undefined)
      return yield* Effect.fail(new RespondToModel(`${failed}: own reads only the first page of an MCP list`))
    const input = args.server === undefined ? {} : { server: args.server }
    const catalog = yield* CoreTool.call(ctx, CORE_LIST, input, tool).pipe(
      Effect.mapError((error) => new RespondToModel(`${failed}: ${message(error)}`)),
    )
    const entries = (catalog.output as CoreCatalog)[kind === "resources" ? "resources" : "templates"]
    // `ResourceWithServer::from_all_servers`: servers in name order, each server's entries as listed.
    const ordered = args.server === undefined ? entries.toSorted((left, right) => byteOrder(left.server, right.server)) : entries
    const items = ordered.map((entry) =>
      "uriTemplate" in entry && entry.uriTemplate !== undefined
        ? withoutUndefined({
            server: entry.server,
            uriTemplate: entry.uriTemplate,
            name: entry.name,
            description: entry.description,
            mimeType: entry.mimeType,
          })
        : withoutUndefined({
            server: entry.server,
            uri: entry.uri,
            name: entry.name,
            description: entry.description,
            mimeType: entry.mimeType,
          }),
    )
    return withoutUndefined({
      server: args.server,
      [kind === "resources" ? "resources" : "resourceTemplates"]: items,
    })
  })
}

/** `ReadMcpResourceHandler`. */
function read(ctx: Pick<Context, "tool">, raw: unknown, tool: Tool.Context) {
  return Effect.gen(function* () {
    const args = yield* parse(() => readArgs(raw))
    const content = yield* CoreTool.call(ctx, CORE_READ, args, tool).pipe(
      Effect.mapError((error) => new RespondToModel(`resources/read failed: ${message(error)}`)),
    )
    return {
      server: args.server,
      uri: args.uri,
      contents: (content.output as CoreContent).contents.map((part) =>
        part.type === "text"
          ? withoutUndefined({ uri: part.uri, mimeType: part.mimeType, text: part.text })
          : withoutUndefined({ uri: part.uri, mimeType: part.mimeType, blob: part.blob }),
      ),
    }
  })
}

interface CoreCatalog {
  readonly resources: ReadonlyArray<CoreEntry>
  readonly templates: ReadonlyArray<CoreEntry>
}

interface CoreEntry {
  readonly server: string
  readonly name: string
  readonly uri?: string
  readonly uriTemplate?: string
  readonly description?: string
  readonly mimeType?: string
}

interface CoreContent {
  readonly contents: ReadonlyArray<
    | { readonly type: "text"; readonly uri: string; readonly text: string; readonly mimeType?: string }
    | { readonly type: "blob"; readonly uri: string; readonly blob: string; readonly mimeType?: string }
  >
}

/** Argument errors are thrown by the parsers below and answered to the model. */
const parse = <A>(parser: () => A) => Effect.try({ try: parser, catch: (error) => error })

/** `ListResourceArgs` (missing arguments are its default), normalized: blank strings are absent. */
function listArgs(raw: unknown) {
  if (raw === undefined || raw === null) return { server: undefined, cursor: undefined }
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new RespondToModel(`failed to parse function arguments: ${invalidType(raw, "struct ListResourceArgs")}`)
  const fields = raw as Record<string, unknown>
  return { server: optionalString(fields.server), cursor: optionalString(fields.cursor) }
}

/** `ReadResourceArgs`: both fields required, then normalized (`normalize_required_string`). */
function readArgs(raw: unknown) {
  if (raw === undefined || raw === null)
    throw new RespondToModel("failed to parse function arguments: expected value")
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new RespondToModel(`failed to parse function arguments: ${invalidType(raw, "struct ReadResourceArgs")}`)
  const fields = raw as Record<string, unknown>
  const server = requiredString(fields, "server")
  const uri = requiredString(fields, "uri")
  return { server: nonBlank("server", server), uri: nonBlank("uri", uri) }
}

function optionalString(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string")
    throw new RespondToModel(`failed to parse function arguments: ${invalidType(value, "a string")}`)
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function requiredString(fields: Record<string, unknown>, field: string) {
  if (!Object.hasOwn(fields, field))
    throw new RespondToModel(`failed to parse function arguments: missing field \`${field}\``)
  const value = fields[field]
  if (typeof value !== "string")
    throw new RespondToModel(`failed to parse function arguments: ${invalidType(value, "a string")}`)
  return value
}

function nonBlank(field: string, value: string) {
  const trimmed = value.trim()
  if (trimmed === "") throw new RespondToModel(`${field} must be provided`)
  return trimmed
}

/** serde's `invalid type: <unexpected>, expected <what>`. */
function invalidType(value: unknown, expected: string) {
  const unexpected =
    value === null
      ? "null"
      : typeof value === "boolean"
        ? `boolean \`${value}\``
        : typeof value === "number"
          ? Number.isInteger(value)
            ? `integer \`${value}\``
            : `floating point \`${value}\``
          : typeof value === "string"
            ? `string ${JSON.stringify(value)}`
            : Array.isArray(value)
              ? "sequence"
              : "map"
  return `invalid type: ${unexpected}, expected ${expected}`
}

function withoutUndefined<A extends Record<string, unknown>>(value: A) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function message(error: unknown) {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}

/** Rust's `String` order: by UTF-8 bytes. */
function byteOrder(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}
