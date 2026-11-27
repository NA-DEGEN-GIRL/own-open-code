export * as OwnMcp from "./mcp.js"

import { Schema } from "effect"
import { optional, statics } from "@opencode/schema/schema"
import { EpochMillis, Nonce, ulid } from "./id.js"
import { ENV_NAME, HEADER_NAME, HINT_MIN, MAX_VALUE, NAME_PATTERN, hint } from "./mcp-rules.js"

export { ENV_NAME, HEADER_NAME, HINT_MIN, MAX_VALUE, NAME_PATTERN, hint }

/**
 * MCP servers own adds for the user (03 §18.14, SM 2026-10-24): 설정 > MCP 서버 `서버 추가…` and `다른 도구에서
 * 가져오기…`. own.accounts keeps them in `OWN_HOME\mcp.json` and hands them to core through its `mcp.transform`, so
 * they are never written into a config file: environment values, header values and the part of a URL after `?` are
 * one vault item per server (`mcp-<id>`, DPAPI, like the web search keys) and reach only that server's process or its
 * requests. Answers name a stored value by its name and, when it is long enough, its last four characters.
 *
 * The list's on/off switch is also kept here (`mcp.enable`, an override per project and server name, for servers of a
 * config file too): it survives a service restart, unlike core's runtime `connect`/`disconnect`. The plain rules (name
 * and value patterns, hints, free names, `${NAME}` references) are `McpRules`, which own-web reads without schemas.
 */

export const Name = Schema.String.check(Schema.isPattern(NAME_PATTERN)).annotate({ identifier: "Own.Mcp.Name" })
export type Name = typeof Name.Type

/** own's id of a server it added (`mcp_<ulid>`); its vault item is `mcp-<id>`. */
export const ID = Schema.String.check(Schema.isPattern(/^mcp_[0-9A-Z]{26}$/)).pipe(
  Schema.brand("Own.Mcp.ID"),
  Schema.annotate({ identifier: "Own.Mcp.ID" }),
  statics((schema) => ({ create: () => schema.make("mcp_" + ulid()) })),
)
export type ID = typeof ID.Type

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))

/** Every project (`global`, never the control folder) or one project folder and the folders inside it. */
export const Scope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("global") }),
  Schema.Struct({ type: Schema.Literal("project"), directory: Text }),
]).annotate({ identifier: "Own.Mcp.Scope" })
export type Scope = typeof Scope.Type

const Value = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_VALUE))

/** A stored value: its name and, for a value of {@link HINT_MIN} characters or more, its last four (`…a1B2`). */
export interface Secret extends Schema.Schema.Type<typeof Secret> {}
export const Secret = Schema.Struct({ name: Schema.String, hint: optional(Schema.String) }).annotate({
  identifier: "Own.Mcp.Secret",
})

/**
 * Whether core offers the server's tools through Code Mode (core's `codemode`). Left out: core's default, on, except
 * for the servers core knows to be Code Mode themselves (`McpCodeModeDefaultsPlugin`, applied by own's fold too).
 */
const CodeMode = optional(Schema.Boolean)

/**
 * A command this PC runs (stdio). `cwd` is relative to the project folder when not absolute. The command and an
 * argument may name a stored environment value as `${NAME}` (`McpRules.REFERENCE`): own puts the value in when the
 * server starts, so the file and every answer keep `${NAME}`. An imported or saved argument that holds a value (after
 * `--token`, `--api-key` …, or a key-like text) is stored that way.
 */
export interface Local extends Schema.Schema.Type<typeof Local> {}
export const Local = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: optional(Schema.String),
  env: Schema.Array(Secret),
  codemode: CodeMode,
}).annotate({ identifier: "Own.Mcp.Local" })

/**
 * A server at a URL (Streamable HTTP, the transport core speaks). `url` is the address without what follows `?`;
 * `query` says that part exists (it is in the vault). `hidden`: a part before `?` holds a value too (a key in the
 * path, user info, an imported `${VAR}`), so the address is in the vault as well and `url` shows those parts as
 * `••••` or as the `${VAR}` it was imported from. `oauth: false` turns core's OAuth sign-in off for it.
 */
export interface Remote extends Schema.Schema.Type<typeof Remote> {}
export const Remote = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.String,
  query: Schema.Boolean,
  hidden: optional(Schema.Boolean),
  headers: Schema.Array(Secret),
  oauth: Schema.Boolean,
  codemode: CodeMode,
}).annotate({ identifier: "Own.Mcp.Remote" })

export const Transport = Schema.Union([Local, Remote]).annotate({ identifier: "Own.Mcp.Transport" })
export type Transport = typeof Transport.Type

/** A tool the server listed in a connection test (at most {@link MAX_TOOLS}). */
export interface Tool extends Schema.Schema.Type<typeof Tool> {}
export const Tool = Schema.Struct({ name: Schema.String, description: optional(Schema.String) }).annotate({
  identifier: "Own.Mcp.Tool",
})

export const MAX_TOOLS = 200

/**
 * Why a connection test failed: the command could not start (`spawn`), the server ended or answered something that
 * is not MCP (`exited`, `protocol`), an HTTP error (`http`, `status`), a sign-in is needed (`auth`: core signs in once
 * the server is saved), nothing answered in time (`timeout`).
 */
export const Failure = Schema.Literals(["spawn", "exited", "protocol", "http", "auth", "timeout"]).annotate({
  identifier: "Own.Mcp.Failure",
})
export type Failure = typeof Failure.Type

/**
 * A connection test (`연결 시험`): own starts the server on its own for a moment (or calls its URL), asks for its
 * tools and stops it. `error` is the server's own words or the end of its error output, with every stored value
 * replaced by `••••`.
 */
export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  at: EpochMillis,
  ok: Schema.Boolean,
  /** The server's name and version as it gave them. */
  server: optional(Schema.String),
  tools: Schema.Array(Tool),
  /** More tools than {@link MAX_TOOLS}: only the first ones are listed. */
  more: optional(Schema.Boolean),
  failure: optional(Failure),
  status: optional(Schema.Int),
  error: optional(Schema.String),
}).annotate({ identifier: "Own.Mcp.Check" })

/** Where a server came from: imported from another tool, or found in the MCP Registry (`찾아서 설치`). */
export const From = Schema.Literals(["codex", "claude-code", "registry"]).annotate({ identifier: "Own.Mcp.From" })
export type From = typeof From.Type

/** The MCP Registry entry a server was set up from (its name there and the version shown, when it gave one). */
export interface RegistryRef extends Schema.Schema.Type<typeof RegistryRef> {}
export const RegistryRef = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  version: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
}).annotate({ identifier: "Own.Mcp.RegistryRef" })

/** One server own added. */
export interface Server extends Schema.Schema.Type<typeof Server> {}
export const Server = Schema.Struct({
  id: ID,
  name: Name,
  scope: Scope,
  transport: Transport,
  from: optional(From),
  registry: optional(RegistryRef),
  /**
   * Its stored values could not be read (the vault did not answer, or its item is not readable): it stays off in
   * every project whatever the list's switch says, until they can be read again.
   */
  missing: optional(Schema.Boolean),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  /** The last connection test of the saved server. */
  check: optional(Check),
}).annotate({ identifier: "Own.Mcp.Server" })

/**
 * The list's switch for one server name (own's or a config file's), kept across restarts: in every project (no
 * `directory`, the global switch of 설정 > MCP 서버, SG) or in one project folder and the folders inside it. The global
 * switch applies first, then the project switches from the shallowest folder to the deepest.
 */
export interface Override extends Schema.Schema.Type<typeof Override> {}
export const Override = Schema.Struct({ directory: optional(Text), name: Text, enabled: Schema.Boolean }).annotate({
  identifier: "Own.Mcp.Override",
})

/**
 * `mcp.list` (and every change's) answer. `vault: "unavailable"`: servers with stored values stay off for now.
 * `errors` (`mcp.list` with a project folder): core's error text of own's failed servers there, by name, with every
 * stored value cut out as in a connection test (`••••`); the page shows it in place of core's own text.
 */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  servers: Schema.Array(Server),
  overrides: Schema.Array(Override),
  vault: Schema.Literals(["ok", "unavailable"]),
  errors: optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "Own.Mcp.View" })

/** `mcp.list`: with `directory`, the answer carries `errors` of that project's Location. */
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
export const ListInput = Schema.Struct({ directory: optional(Text) }).annotate({ identifier: "Own.Mcp.ListInput" })

/**
 * `mcp.summary` (read): what any window may know of own's servers, for the list's source line on a phone or another
 * PC: names, where they are used, where they came from and whether their values are missing. Never a definition,
 * a value, a command or an address.
 */
export interface SummaryServer extends Schema.Schema.Type<typeof SummaryServer> {}
export const SummaryServer = Schema.Struct({
  name: Name,
  scope: Scope,
  from: optional(From),
  missing: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Mcp.SummaryServer" })

/** `overrides`: the list's kept switches (SG), so a phone's list tags the rows a switch decides as this PC's does. */
export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  servers: Schema.Array(SummaryServer),
  overrides: Schema.Array(Override),
}).annotate({
  identifier: "Own.Mcp.Summary",
})

// ---------------------------------------------------------------------------------------------------------------
// Inputs. A value left out keeps the stored value of that name (`mcp_secret_missing` when there is none), so a form
// never needs a stored value back.

const EnvInput = Schema.Struct({ name: Schema.String.check(Schema.isPattern(ENV_NAME)), value: optional(Value) })
const HeaderInput = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(HEADER_NAME)),
  value: optional(Value),
})

/**
 * `${NAME}` in the command or an argument must name one of `env` (`mcp_invalid{field: "args"}`); an argument that
 * holds a value is moved into `env` and replaced by its `${NAME}` (see {@link Local}).
 */
export interface LocalInput extends Schema.Schema.Type<typeof LocalInput> {}
export const LocalInput = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(64)),
  cwd: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  env: Schema.Array(EnvInput).check(Schema.isMaxLength(64)),
  codemode: CodeMode,
}).annotate({ identifier: "Own.Mcp.LocalInput" })

/** `url` left out keeps the stored address (with its stored `?` part); a new server needs one. */
export interface RemoteInput extends Schema.Schema.Type<typeof RemoteInput> {}
export const RemoteInput = Schema.Struct({
  type: Schema.Literal("remote"),
  url: optional(Text),
  headers: Schema.Array(HeaderInput).check(Schema.isMaxLength(32)),
  oauth: Schema.Boolean,
  codemode: CodeMode,
}).annotate({ identifier: "Own.Mcp.RemoteInput" })

export const TransportInput = Schema.Union([LocalInput, RemoteInput]).annotate({ identifier: "Own.Mcp.TransportInput" })
export type TransportInput = typeof TransportInput.Type

/**
 * Adds a server (no `id`) or changes one; its connection test is cleared. `registry`: a new server the form took from
 * the MCP Registry (kept on later changes).
 */
export interface SaveInput extends Schema.Schema.Type<typeof SaveInput> {}
export const SaveInput = Schema.Struct({
  id: optional(ID),
  name: Name,
  scope: Scope,
  transport: TransportInput,
  registry: optional(RegistryRef),
}).annotate({ identifier: "Own.Mcp.SaveInput" })

/**
 * A connection test of a saved server (`id`), of the form as it is (`transport`, with `id` for the values the form
 * keeps), in the project `directory` (the working folder of a command and of a relative `cwd`).
 */
export interface TestInput extends Schema.Schema.Type<typeof TestInput> {}
export const TestInput = Schema.Struct({
  id: optional(ID),
  transport: optional(TransportInput),
  directory: optional(Text),
}).annotate({ identifier: "Own.Mcp.TestInput" })

// ---------------------------------------------------------------------------------------------------------------
// 다른 도구에서 가져오기: Codex `config.toml` `[mcp_servers]`, Claude Code `.claude.json` (`mcpServers` and the project's
// entry) and the project's `.mcp.json`. Read only when the user asks (`mcp.import.scan`), never written. The answer
// shows values by name; `mcp.import.apply` takes the nonce, so values never travel through a client.

/** Where a candidate was found. */
export const Source = Schema.Literals(["codex", "claude-user", "claude-project", "project-file"]).annotate({
  identifier: "Own.Mcp.Source",
})
export type Source = typeof Source.Type

/** What the import changes or leaves out (shown under the row). */
export const Note = Schema.Literals([
  /** `${VAR}` (Claude Code) or `env_vars`/`bearer_token_env_var` (Codex) were read from this service's environment. */
  "env_read",
  /** A variable named there is not set in this service's environment: that value is left out. */
  "env_missing",
  /** Off in the other tool: imported unchecked. */
  "disabled",
  /** Codex `enabled_tools`/`disabled_tools`: every tool is offered here. */
  "tool_filter",
  /** Codex `http_headers_helper`: a command that prints headers, which this app does not run. */
  "headers_helper",
  /** Timeouts and other settings this app does not take. */
  "settings_dropped",
  /** An argument or a part of the address held a value: it goes into the vault, the row shows `${NAME}` or `••••`. */
  "values_moved",
]).annotate({ identifier: "Own.Mcp.Note" })
export type Note = typeof Note.Type

/** Why a candidate cannot be imported: the old SSE transport (core speaks Streamable HTTP), or not a server entry. */
export const Problem = Schema.Literals(["sse", "invalid"]).annotate({ identifier: "Own.Mcp.Problem" })
export type Problem = typeof Problem.Type

/** A key of the scan's answer (`c1`, `c2` …). */
export const CandidateKey = Schema.String.check(Schema.isPattern(/^c[0-9]{1,4}$/)).annotate({
  identifier: "Own.Mcp.CandidateKey",
})

/**
 * Another place a candidate's definition was found (the same command, arguments and value names, or address; a
 * hidden address compared by its real value). `differs`: its values are not the first place's (`값이 달라요`), and
 * `values` names them with their hints, so the user can pick which place's values to take ({@link Pick.place}).
 */
export interface Place extends Schema.Schema.Type<typeof Place> {}
export const Place = Schema.Struct({
  source: Source,
  name: Schema.String,
  differs: optional(Schema.Boolean),
  values: optional(Schema.Array(Secret)),
}).annotate({ identifier: "Own.Mcp.Place" })

/**
 * One server definition found: the same definition in several places (Codex and Claude Code, say) is one candidate,
 * its first place as `source` and `name`, the others in `also`; importing it takes the first place's values unless the
 * pick names another place.
 */
export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}
export const Candidate = Schema.Struct({
  key: CandidateKey,
  source: Source,
  /** The name in the other tool. */
  name: Schema.String,
  also: Schema.Array(Place),
  /** A name this app can use that no server own added has yet. */
  suggested: Name,
  /** Every project for a tool's user settings, the project for project entries. */
  scope: Scope,
  transport: optional(Transport),
  enabled: Schema.Boolean,
  notes: Schema.Array(Note),
  problem: optional(Problem),
  /** own already has a server with this definition (imported from any place, or added by hand): `이미 있음`. */
  imported: Schema.Boolean,
}).annotate({ identifier: "Own.Mcp.Candidate" })

/** A file the scan looked at, with what it found there. */
export interface SourceFile extends Schema.Schema.Type<typeof SourceFile> {}
export const SourceFile = Schema.Struct({
  source: Source,
  path: Schema.String,
  state: Schema.Literals(["found", "missing", "unreadable", "invalid"]),
  count: Schema.Int,
}).annotate({ identifier: "Own.Mcp.SourceFile" })

export const SCAN_TTL_MS = 10 * 60 * 1000

export interface Scan extends Schema.Schema.Type<typeof Scan> {}
export const Scan = Schema.Struct({
  /** Single use, {@link SCAN_TTL_MS}; `mcp.import.apply` imports from this scan's reading. */
  nonce: Nonce,
  expiresAt: EpochMillis,
  files: Schema.Array(SourceFile),
  candidates: Schema.Array(Candidate),
}).annotate({ identifier: "Own.Mcp.Scan" })

/** `place`: whose values to take, `0` (or left out) the candidate's first place, `n` its `also[n - 1]`. */
export interface Pick extends Schema.Schema.Type<typeof Pick> {}
export const Pick = Schema.Struct({
  key: CandidateKey,
  name: Name,
  scope: Scope,
  place: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 63 }))),
}).annotate({
  identifier: "Own.Mcp.Pick",
})

export interface Applied extends Schema.Schema.Type<typeof Applied> {}
export const Applied = Schema.Struct({
  imported: Schema.Array(Schema.Struct({ key: CandidateKey, id: ID, name: Name })),
  view: View,
}).annotate({ identifier: "Own.Mcp.Applied" })

// ---------------------------------------------------------------------------------------------------------------
// 찾아서 설치: the official MCP Registry (`registry.modelcontextprotocol.io`, API `v0.1`), asked from this PC only
// (`mcp.registry.search`, `local`). own.accounts reads its `server.json` entries and answers what the form needs: the
// publisher, the version, each package (npm, PyPI, OCI …) with the exact command this PC would run, and each remote
// address, with the environment values and headers they ask for. Nothing is saved, installed or run: the user fills
// the add form from an entry and saves it there. Every entry is someone else's code.

/** An environment value, a header or a `{variable}` an entry asks for, as the registry describes it. */
export interface RegistryValue extends Schema.Schema.Type<typeof RegistryValue> {}
export const RegistryValue = Schema.Struct({
  name: Schema.String,
  description: optional(Schema.String),
  required: Schema.Boolean,
  secret: Schema.Boolean,
  /** The value the registry gives (fixed or default) when it is not secret and has no `{variable}` part. */
  value: optional(Schema.String),
  /** The value's form with parts to fill, e.g. `Bearer {api_key}`. */
  template: optional(Schema.String),
}).annotate({ identifier: "Own.Mcp.RegistryValue" })

/**
 * Why own cannot set an entry's option up as it is: a package needs a runtime own does not start (`runtime`, e.g.
 * `cargo`, `mcpb`) or speaks a transport the add form has no field for (`transport`), a remote is the old SSE (`sse`).
 */
export const RegistryProblem = Schema.Literals(["runtime", "transport", "sse"]).annotate({
  identifier: "Own.Mcp.RegistryProblem",
})
export type RegistryProblem = typeof RegistryProblem.Type

/**
 * A package this PC would run: `command` and `args` are exactly what starts (`npx -y <id>@<version>`, `uvx
 * <id>==<version>`, `docker run -i --rm … <image>` …); `fill` names the `{parts}` of the arguments still to fill.
 */
export interface RegistryPackage extends Schema.Schema.Type<typeof RegistryPackage> {}
export const RegistryPackage = Schema.Struct({
  type: Schema.Literal("package"),
  registryType: Schema.String,
  identifier: Schema.String,
  version: optional(Schema.String),
  command: optional(Schema.String),
  args: Schema.Array(Schema.String),
  env: Schema.Array(RegistryValue),
  fill: Schema.Array(Schema.String),
  problem: optional(RegistryProblem),
}).annotate({ identifier: "Own.Mcp.RegistryPackage" })

/** A remote address (its `{variables}` named in `fill`, described in `variables`) and its headers. */
export interface RegistryRemote extends Schema.Schema.Type<typeof RegistryRemote> {}
export const RegistryRemote = Schema.Struct({
  type: Schema.Literal("remote"),
  transport: Schema.String,
  url: Schema.String,
  headers: Schema.Array(RegistryValue),
  variables: Schema.Array(RegistryValue),
  fill: Schema.Array(Schema.String),
  problem: optional(RegistryProblem),
}).annotate({ identifier: "Own.Mcp.RegistryRemote" })

export const RegistryOption = Schema.Union([RegistryPackage, RegistryRemote]).annotate({
  identifier: "Own.Mcp.RegistryOption",
})
export type RegistryOption = typeof RegistryOption.Type

/** One server of the registry, latest version. `publisher` is its name's namespace (`io.github.user`). */
export interface RegistryEntry extends Schema.Schema.Type<typeof RegistryEntry> {}
export const RegistryEntry = Schema.Struct({
  name: Schema.String,
  title: optional(Schema.String),
  description: optional(Schema.String),
  version: Schema.String,
  publisher: Schema.String,
  repository: optional(Schema.String),
  website: optional(Schema.String),
  status: Schema.Literals(["active", "deprecated"]),
  /** A free name for it here (`McpRules.suggestName` of its name's last part). */
  suggested: Name,
  options: Schema.Array(RegistryOption),
}).annotate({ identifier: "Own.Mcp.RegistryEntry" })

/** How many servers one search asks for. */
export const REGISTRY_PAGE = 20

export interface RegistrySearch extends Schema.Schema.Type<typeof RegistrySearch> {}
export const RegistrySearch = Schema.Struct({
  /** The registry's search: part of a server's name, any case. Left out: the first servers. */
  query: optional(Schema.String.check(Schema.isMaxLength(200))),
  /** The page after the one that gave this `nextCursor`. */
  cursor: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
}).annotate({ identifier: "Own.Mcp.RegistrySearch" })

export interface RegistryPage extends Schema.Schema.Type<typeof RegistryPage> {}
export const RegistryPage = Schema.Struct({
  /** The registry asked (its origin), for the dialog's source line. */
  registry: Schema.String,
  entries: Schema.Array(RegistryEntry),
  nextCursor: optional(Schema.String),
}).annotate({ identifier: "Own.Mcp.RegistryPage" })
