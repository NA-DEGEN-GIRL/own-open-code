export * as McpHost from "./mcp-host.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { EpochMillis } from "./id.js"
import { OwnMcp } from "./mcp.js"
import { McpHostRules } from "./mcp-host-rules.js"
import { ENV_NAME, HEADER_NAME } from "./mcp-rules.js"

/**
 * MCP servers of this PC on an SSH host (04 §13 "MCP", 03 §18.14 "SSH 호스트에 설치", MH 2026-11-26).
 *
 * - **On the host** (`mcp.host.*`, a remote service's own.accounts): the host's own list of servers installed from the
 *   PC (`<OWN_HOME>/mcp.json` there, the same file shape as this PC's), folded into every Location of the host like
 *   this PC's servers; the probe of what the host has (read only, in the service's environment); save, remove, the
 *   connection test and a pre-fetch in user space. No value is ever stored on the host: a server's values come from
 *   the PC over the broker (`mcp.values`), into the host service's memory only, after the user sent them.
 * - **On the PC** (`mcp.hosts.*`): the user's explicit `이 키를 <host>에 보내기`, one record per host and server with a
 *   copy of the values in this PC's vault (`mcp-send-<id>`); the broker answers a host's `mcp.values` from it, and a
 *   withdrawal (`mcp.hosts.unsend`) tells the host to drop them (`mcp.changed` push).
 *
 * The analysis (`McpHostRules`) is plain and shared with own-web.
 */

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))

const Found = Schema.Struct({ version: optional(Schema.String), command: optional(Schema.String) })

/** `mcp.host.probe`'s answer (`McpHostRules.Probe`). */
export interface Probe extends Schema.Schema.Type<typeof Probe> {}
export const Probe = Schema.Struct({
  at: EpochMillis,
  os: Schema.String,
  arch: Schema.String,
  home: Schema.String,
  runtimes: Schema.Record(Schema.String, Found),
  containers: optional(
    Schema.Struct({
      docker: optional(Schema.Literals(["ok", "denied"])),
      podman: optional(Schema.Literals(["ok", "denied"])),
    }),
  ),
  binaries: Schema.Record(Schema.String, Schema.Boolean),
  ownBun: optional(Schema.Struct({ command: Schema.String, version: optional(Schema.String) })),
}).annotate({ identifier: "Own.McpHost.Probe" })

/** A program name the probe looks up on the host's PATH (`command -v`), never a path or a shell word. */
export const ProgramName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/))

export interface ProbeInput extends Schema.Schema.Type<typeof ProbeInput> {}
export const ProbeInput = Schema.Struct({
  binaries: optional(Schema.Array(ProgramName).check(Schema.isMaxLength(64))),
}).annotate({ identifier: "Own.McpHost.ProbeInput" })

/** Where a host's server came from on the PC: its key (`own:<id>`, `file:<name>`) and definition hash then. */
export interface Pc extends Schema.Schema.Type<typeof Pc> {}
export const Pc = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
  at: EpochMillis,
}).annotate({ identifier: "Own.McpHost.Pc" })

const Fixed = Schema.Record(
  Schema.String.check(Schema.isPattern(ENV_NAME)),
  Schema.String.check(Schema.isMaxLength(4096)),
)

/** A host's command server: names of its values only; `fixed` plain variables the translation set (no PC value). */
export interface Local extends Schema.Schema.Type<typeof Local> {}
export const Local = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(64)),
  cwd: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  env: Schema.Array(Schema.String.check(Schema.isPattern(ENV_NAME))).check(Schema.isMaxLength(64)),
  codemode: optional(Schema.Boolean),
  fixed: optional(Fixed),
}).annotate({ identifier: "Own.McpHost.Local" })

/** A host's address server: the address before `?` (shown form when `hidden`), header names only. */
export interface Remote extends Schema.Schema.Type<typeof Remote> {}
export const Remote = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Text,
  query: Schema.Boolean,
  hidden: optional(Schema.Boolean),
  headers: Schema.Array(Schema.String.check(Schema.isPattern(HEADER_NAME))).check(Schema.isMaxLength(32)),
  oauth: Schema.Boolean,
  codemode: optional(Schema.Boolean),
}).annotate({ identifier: "Own.McpHost.Remote" })

export const Transport = Schema.Union([Local, Remote]).annotate({ identifier: "Own.McpHost.Transport" })
export type Transport = typeof Transport.Type

/**
 * Whether a host's server has its values: `none` (it stores none), `ready` (the PC sent them and the host holds them
 * in memory), `missing` (not sent, or the PC was not reached): the server stays off until they come.
 */
export const ValuesState = Schema.Literals(["none", "ready", "missing"]).annotate({
  identifier: "Own.McpHost.ValuesState",
})
export type ValuesState = typeof ValuesState.Type

export interface Server extends Schema.Schema.Type<typeof Server> {}
export const Server = Schema.Struct({
  id: OwnMcp.ID,
  name: OwnMcp.Name,
  transport: Transport,
  pc: optional(Pc),
  values: ValuesState,
  check: optional(OwnMcp.Check),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
}).annotate({ identifier: "Own.McpHost.Server" })

/** `mcp.host.view`: the host's installed servers and its home folder (where a mapped `~/…` points). */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  servers: Schema.Array(Server),
  home: Schema.String,
}).annotate({ identifier: "Own.McpHost.View" })

/** Installs (no `id`) or updates a server on the host; `~/…` in the command, arguments and folder become absolute. */
export interface SaveInput extends Schema.Schema.Type<typeof SaveInput> {}
export const SaveInput = Schema.Struct({
  id: optional(OwnMcp.ID),
  name: OwnMcp.Name,
  transport: Transport,
  pc: optional(Pc),
}).annotate({ identifier: "Own.McpHost.SaveInput" })

export interface IdInput extends Schema.Schema.Type<typeof IdInput> {}
export const IdInput = Schema.Struct({ id: OwnMcp.ID }).annotate({ identifier: "Own.McpHost.IdInput" })

/**
 * `mcp.host.prefetch`: fetches a server's package into the host user's caches before its first start (`npm exec
 * --yes --package=<pkg> -- true` for npx, `uv tool install <pkg>` for uvx; nothing else): `none` for a server whose
 * command fetches nothing. `output` is the end of what it printed, values cut out.
 */
export interface Prefetch extends Schema.Schema.Type<typeof Prefetch> {}
export const Prefetch = Schema.Struct({
  ok: Schema.Boolean,
  kind: Schema.Literals(["npm", "uv", "none"]),
  output: optional(Schema.String),
}).annotate({ identifier: "Own.McpHost.Prefetch" })

/** How long a pre-fetch may take on the host before it is stopped. */
export const PREFETCH_TIMEOUT_MS = 5 * 60_000

// ---------------------------------------------------------------------------------------------------------------
// The PC's records of values sent to hosts (`mcp.hosts.*`).

/** The name of a server's whole address value in a send (its `?` part and hidden address), beside env/header names. */
export const ADDRESS = "URL"

/**
 * Where the values come from: own's server (its vault item), or a config file's server, whose values the page read
 * from that file and passes once (the PC keeps its copy).
 */
export const SendSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("own"), id: OwnMcp.ID }),
  Schema.Struct({
    type: Schema.Literal("file"),
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    transport: OwnMcp.TransportInput,
  }),
]).annotate({ identifier: "Own.McpHost.SendSource" })
export type SendSource = typeof SendSource.Type

const HostID = Schema.String.check(Schema.isPattern(/^h-[a-z0-9]{6,8}$/))
const ValueName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))

/** `이 키를 <host>에 보내기`: these values of the source go to that host's server (`server`, the host's id). */
export interface SendInput extends Schema.Schema.Type<typeof SendInput> {}
export const SendInput = Schema.Struct({
  hostId: HostID,
  server: OwnMcp.ID,
  source: SendSource,
  names: Schema.Array(ValueName).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}).annotate({ identifier: "Own.McpHost.SendInput" })

export interface UnsendInput extends Schema.Schema.Type<typeof UnsendInput> {}
export const UnsendInput = Schema.Struct({ hostId: HostID, server: OwnMcp.ID }).annotate({
  identifier: "Own.McpHost.UnsendInput",
})

export interface SendsInput extends Schema.Schema.Type<typeof SendsInput> {}
export const SendsInput = Schema.Struct({ hostId: optional(HostID) }).annotate({ identifier: "Own.McpHost.SendsInput" })

/**
 * One record: what was sent to which host's server. `differs`: own's server holds other values now than the copy the
 * host gets (the user may send again; the host never changes on its own).
 */
export interface Send extends Schema.Schema.Type<typeof Send> {}
export const Send = Schema.Struct({
  hostId: Schema.String,
  server: OwnMcp.ID,
  names: Schema.Array(Schema.String),
  source: Schema.Union([
    Schema.Struct({ type: Schema.Literal("own"), id: OwnMcp.ID }),
    Schema.Struct({ type: Schema.Literal("file"), name: Schema.String }),
  ]),
  at: EpochMillis,
  differs: optional(Schema.Boolean),
}).annotate({ identifier: "Own.McpHost.Send" })

export interface Sends extends Schema.Schema.Type<typeof Sends> {}
export const Sends = Schema.Struct({ sends: Schema.Array(Send) }).annotate({ identifier: "Own.McpHost.Sends" })

/** `OWN_HOME\mcp-hosts.json` on the PC: the records, values in the vault (`mcp-send-<id>`). */
export const SendRecord = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9A-Z]{26}$/)),
  hostId: Schema.String,
  server: OwnMcp.ID,
  names: Schema.Array(Schema.String),
  source: Schema.Union([
    Schema.Struct({ type: Schema.Literal("own"), id: OwnMcp.ID }),
    Schema.Struct({ type: Schema.Literal("file"), name: Schema.String }),
  ]),
  at: EpochMillis,
}).annotate({ identifier: "Own.McpHost.SendRecord" })
export type SendRecord = typeof SendRecord.Type

export const SendsFile = Schema.Struct({
  version: Schema.Literal(1),
  sends: Schema.Array(SendRecord),
}).annotate({ identifier: "Own.McpHost.SendsFile" })
export type SendsFile = typeof SendsFile.Type

// ---------------------------------------------------------------------------------------------------------------
// The AI-assisted install (`AI에게 설치 맡기기`): a new conversation on the host whose metadata names the job, with
// the host's tool `own_mcp_install` allowed in that conversation only.

/** The tool's name and permission (every agent on a host denies it; the job's conversation allows it). */
export const TOOL = McpHostRules.TOOL

/** `metadata.own.mcpInstall` of the job's conversation: which PC server, its definition hash and value names. */
export interface Job extends Schema.Schema.Type<typeof Job> {}
export const Job = Schema.Struct({
  key: Pc.fields.key,
  hash: Pc.fields.hash,
  name: OwnMcp.Name,
  env: Schema.Array(Schema.String.check(Schema.isPattern(ENV_NAME))).check(Schema.isMaxLength(64)),
  codemode: optional(Schema.Boolean),
}).annotate({ identifier: "Own.McpHost.Job" })

/** The tool's input: the command that works on the host now, and plain variables it needs (never a secret). */
export const ToolInput = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(64)),
  cwd: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  fixed: optional(Fixed),
}).annotate({ identifier: "Own.McpHost.ToolInput" })
export type ToolInput = typeof ToolInput.Type
