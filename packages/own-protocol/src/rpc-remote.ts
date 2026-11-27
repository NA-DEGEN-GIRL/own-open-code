/**
 * RPC `own.remote` (04 §16): the only list of its methods, events, errors and device scopes. Exported as
 * `@own/protocol/rpc-remote` (04 §16.1, §21 R0); own-remote registers it and own-web calls it.
 */
export * as OwnRemote from "./rpc-remote.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { OwnID } from "./id.js"
import { Plugin } from "./plugin.js"

/** The RPC id; own-remote is its only registrant and event publisher (04 §16.1). */
export const ID = "own.remote"

const EventID = OwnID.EventID
const Nonce = OwnID.Nonce
const EpochMillis = OwnID.EpochMillis

const empty = Schema.Struct({})
const planned = { nonce: Nonce, expiresAt: EpochMillis }
const execute = Schema.Struct({ nonce: Nonce })

// ---------------------------------------------------------------------------------------------------------------
// Ids and enums

/** `h-<6–8 [a-z0-9]>`, fixed for the life of the host record (04 §2). Never the alias. */
export const HostID = Schema.String.check(Schema.isPattern(/^h-[a-z0-9]{6,8}$/)).annotate({
  identifier: "OwnRemote.HostID",
})
export type HostID = typeof HostID.Type

/** own-web tab or window owner of an interactive attempt (04 §6.3), kept in that tab's `sessionStorage`. */
export const ClientID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
  identifier: "OwnRemote.ClientID",
})

/** Connection stages (04 §6.3): upstream's `SshStage` without `downloading`, plus own stages. */
export const Stage = Schema.Literals([
  "disconnected",
  "connecting",
  "authentication",
  "checking",
  "needs_install",
  "uploading",
  "starting",
  "ready",
  "incompatible",
  "updating",
  "draining",
  "failed",
]).annotate({ identifier: "OwnRemote.Stage" })
export type Stage = typeof Stage.Type

/** Host error codes (04 §6.3). `host_key` carries `detail: "unknown" | "changed"`. */
export const HostError = Schema.Literals([
  "input",
  "ssh_missing",
  "connection",
  "auth",
  "host_key",
  "host_identity_changed",
  "forwarding_disabled",
  "forward_conflict",
  "loopback_unavailable",
  "platform_unsupported",
  "noexec",
  "disk_full",
  "install_failed",
  "service_failed",
  "service_not_loopback",
  "service_unresponsive",
  "version_skew",
  "other_owner",
  "ops_pending",
  "broker_failed",
]).annotate({ identifier: "OwnRemote.HostError" })
export type HostError = typeof HostError.Type

export const PromptKind = Schema.Literals(["password", "passphrase", "hostKey", "confirm", "other"]).annotate({
  identifier: "OwnRemote.PromptKind",
})
export type PromptKind = typeof PromptKind.Type

/**
 * What a host's service reads from the repository it works in (04 §5.6). `disabled`: nothing. `instructions`: the
 * repository's AGENTS.md files only (no plugin, MCP, command, agent, skill or project config file). `trusted`: all of
 * it.
 */
export const ProjectConfig = Schema.Literals(["disabled", "instructions", "trusted"]).annotate({
  identifier: "OwnRemote.ProjectConfig",
})
export type ProjectConfig = typeof ProjectConfig.Type
export const ShellEnv = Schema.Literals(["login", "login-interactive", "sh"]).annotate({
  identifier: "OwnRemote.ShellEnv",
})
export type ShellEnv = typeof ShellEnv.Type

/** Broker account scope of a host (04 §8.9). `{mode:"only", ids:[]}` allows no account. */
export const AccountScope = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("all") }),
  Schema.Struct({ mode: Schema.Literal("only"), ids: Schema.Array(Schema.String) }),
]).annotate({ identifier: "OwnRemote.AccountScope" })
export type AccountScope = typeof AccountScope.Type

export const Warning = Schema.Literals([
  "path_differs_interactive",
  "kill_user_processes",
  "loose_host_key",
  "clock_skew",
  "tmp_noexec",
  "upstream_opencode",
  "config_forward_localhost",
  "identity_unavailable",
  "loopback_fallback_port",
]).annotate({ identifier: "OwnRemote.Warning" })

// ---------------------------------------------------------------------------------------------------------------
// Read models

export const Platform = Schema.Struct({
  os: Schema.String,
  arch: Schema.String,
  target: Schema.NullOr(Schema.String),
  libc: Schema.NullOr(Schema.String),
}).annotate({ identifier: "OwnRemote.Platform" })

/** `local`, `remoteRunning` and `remoteStaged` are shown apart (04 §5.7): updating local is not updating remote. */
export const Versions = Schema.Struct({
  local: Schema.String,
  remoteRunning: Schema.NullOr(Schema.String),
  remoteStaged: Schema.Array(Schema.String),
  skew: Schema.Boolean,
}).annotate({ identifier: "OwnRemote.Versions" })

export const BrokerView = Schema.Struct({
  state: Schema.Literals(["unavailable", "unarmed", "disconnected", "connected", "auth_failed"]),
  mode: Schema.NullOr(Schema.Literals(["normal", "drain"])),
  proto: NonNegativeInt,
  leasesActive: NonNegativeInt,
  lastPushAt: Schema.NullOr(EpochMillis),
  spoolBacklog: NonNegativeInt,
  gaps: NonNegativeInt,
  clockSkewMs: Schema.NullOr(Schema.Finite),
  /** Linked Codex accounts blocked with `source_stale` on this host only (04 §8.5). */
  sourceStale: Schema.Array(Schema.String),
  /**
   * 04 §8.11: the Claude subscription relay of this host, judged on this PC: the verdict, relayed requests in flight,
   * the last refusal code (`x-own-egress-error`), and the end of a `needs_reauth` hold. Absent when this PC has no
   * slot or an older broker.
   */
  claude: optional(
    Schema.Struct({
      state: Plugin.ClaudeRemoteState,
      inflight: NonNegativeInt,
      lastError: Schema.NullOr(Schema.String),
      holdUntil: Schema.NullOr(EpochMillis),
    }),
  ),
  /**
   * 04 §8.14: this PC's relay of the host's local model requests: requests in flight and the last refusal code
   * (`x-own-local-error`). Absent from an older broker.
   */
  local: optional(Schema.Struct({ inflight: NonNegativeInt, lastError: Schema.NullOr(Schema.String) })),
}).annotate({ identifier: "OwnRemote.BrokerView" })

export const EventsView = Schema.Struct({
  state: Schema.Literals(["subscribed", "off", "reconnecting"]),
  catalogEpoch: NonNegativeInt,
  catalogFetchedAt: Schema.NullOr(EpochMillis),
}).annotate({ identifier: "OwnRemote.EventsView" })

/** One `hosts.list` row (04 §16.2). No destination (`user@host:port`), no secrets. */
export interface HostView extends Schema.Schema.Type<typeof HostView> {}
export const HostView = Schema.Struct({
  id: HostID,
  alias: Schema.NullOr(Schema.String),
  name: Schema.String,
  target: Schema.String,
  stage: Stage,
  paused: Schema.Boolean,
  error: Schema.NullOr(HostError),
  detail: Schema.String,
  platform: Schema.NullOr(Platform),
  hostIdentity: Schema.NullOr(Schema.String),
  identityChanged: Schema.Boolean,
  versions: Versions,
  autoConnect: Schema.Boolean,
  loopback: Schema.String,
  localPort: NonNegativeInt,
  epoch: NonNegativeInt,
  accounts: AccountScope,
  leaseSeconds: NonNegativeInt,
  failClosedGraceSeconds: NonNegativeInt,
  tokenTtlHours: NonNegativeInt,
  projectConfig: ProjectConfig,
  shellEnv: ShellEnv,
  warnings: Schema.Array(Schema.String),
  broker: BrokerView,
  sessions: Schema.Struct({ active: Schema.NullOr(NonNegativeInt) }),
  events: EventsView,
  pendingSettings: Schema.Boolean,
  /** Owner of the current interactive attempt; other clients show "다른 창에서 인증 중" (04 §6.3). */
  owner: Schema.Struct({ clientId: Schema.NullOr(Schema.String) }),
  upstreamOpencodeDetected: Schema.Boolean,
}).annotate({ identifier: "OwnRemote.HostView" })

export const DiscoveredAlias = Schema.Struct({
  alias: Schema.String,
  known: Schema.Boolean,
  forwards: Schema.Literals(["none", "maybe", "yes"]),
  wildcard: Schema.Boolean,
  /** The file parser saw `StrictHostKeyChecking no` or `UserKnownHostsFile /dev/null` (04 §7.2). */
  looseHostKey: Schema.Boolean,
  /** A `LocalForward` bound to 127.0.0.1/localhost or without bind address (04 §19.1 lab-7676 warning). */
  localhostForward: Schema.Boolean,
}).annotate({ identifier: "OwnRemote.DiscoveredAlias" })

export const CatalogProject = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  name: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(EpochMillis),
})
export const CatalogSession = Schema.Struct({
  id: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  updatedAt: Schema.NullOr(EpochMillis),
  model: Schema.NullOr(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
})
export const Catalog = Schema.Struct({
  epoch: NonNegativeInt,
  fetchedAt: Schema.NullOr(EpochMillis),
  projects: Schema.Array(CatalogProject),
  sessions: Schema.Array(CatalogSession),
}).annotate({ identifier: "OwnRemote.Catalog" })

export const Diagnostics = Schema.Struct({
  stage: Stage,
  lastError: Schema.NullOr(HostError),
  sshVersion: Schema.NullOr(Schema.String),
  sshPath: Schema.String,
  agentRunning: Schema.NullOr(Schema.Boolean),
  forwardsInConfig: Schema.Literals(["none", "maybe", "yes"]),
  brokerMode: Schema.Literals(["socket", "tcp"]),
  socketDir: Schema.NullOr(Schema.String),
  clockSkewMs: Schema.NullOr(Schema.Finite),
  shellEnv: Schema.Struct({
    mode: ShellEnv,
    pathLogin: Schema.NullOr(Schema.String),
    pathInteractive: Schema.NullOr(Schema.String),
    pathSh: Schema.NullOr(Schema.String),
  }),
  linger: Schema.NullOr(Schema.String),
  killUserProcesses: Schema.NullOr(Schema.String),
  tmpNoexec: Schema.NullOr(Schema.Boolean),
  probe: Schema.NullOr(Schema.Unknown),
  /** Last 2 KiB of ssh stderr with the registration block and secret patterns removed. */
  stderrTail: Schema.String,
}).annotate({ identifier: "OwnRemote.Diagnostics" })

export const Step = Schema.Struct({
  step: Schema.String,
  ok: Schema.Boolean,
  detail: optional(Schema.String),
}).annotate({ identifier: "OwnRemote.Step" })

const Resolved = Schema.Union([
  Schema.Struct({
    url: Schema.String,
    /** Server access token signed by own-remote (04 §12.1). Never logged, never stored by clients. */
    token: Schema.String,
    tokenExpiresAt: EpochMillis,
    epoch: NonNegativeInt,
    controlDir: Schema.String,
    home: Schema.String,
  }),
  Schema.Struct({ url: Schema.Null, stage: Stage }),
]).annotate({ identifier: "OwnRemote.Resolved" })

const HostUpdate = Schema.Struct({
  hostId: HostID,
  name: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))),
  autoConnect: optional(Schema.Boolean),
  accounts: optional(AccountScope),
  leaseSeconds: optional(Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 14_400 }))),
  failClosedGraceSeconds: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 }))),
  tokenTtlHours: optional(Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 24 }))),
  localPort: optional(Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65_535 }))),
  installRoot: optional(Schema.NullOr(Schema.String)),
  projectConfig: optional(ProjectConfig),
  shellEnv: optional(ShellEnv),
  env: optional(Schema.Record(Schema.String, Schema.String)),
  pathPrepend: optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "OwnRemote.HostUpdate" })

// ---------------------------------------------------------------------------------------------------------------
// Gateway, devices and the feed (M1: 05 §13.4–13.6, names and scopes 04 §16.8)

/**
 * Device scopes (05 §13.5). `read`, `switch` and `admin` stand for the `MethodScope` values `read`, `drive` and
 * `manage` (and the `own.accounts` scopes of the same names); `prompt`, `files` and `terminal` guard upstream HTTP;
 * `browser` guards the gateway's own viewer socket (`RemoteBrowser.SOCKET_PATH`, 05 §8.10). `local` is never a device
 * scope.
 */
export const DeviceScope = Schema.Literals([
  "read",
  "prompt",
  "switch",
  "files",
  "terminal",
  "browser",
  "admin",
]).annotate({
  identifier: "OwnRemote.DeviceScope",
})
export type DeviceScope = typeof DeviceScope.Type
export const DEVICE_SCOPES: ReadonlyArray<DeviceScope> = [
  "read",
  "prompt",
  "switch",
  "files",
  "terminal",
  "browser",
  "admin",
]
/**
 * A phone's default (03 §21.2, 05 §19 Q30 draft): read + prompt + switch; `terminal`, `browser` and `admin` stay off.
 * `browser` (05 §8.10, MBR) shows a session's browser pane on the device and, with `prompt`, lets it send input: page
 * content of whatever the pane is logged in to leaves the PC, so the user turns it on per device, on the PC.
 */
export const DEFAULT_DEVICE_SCOPES: ReadonlyArray<DeviceScope> = ["read", "prompt", "switch"]
/**
 * Scopes added after `devices.json` version 1 was first written (05 §13.5 "저장"). The file keeps them in
 * `extraScopes`, outside `scopes`: a build from before them reads the file as it always did and only loses the
 * extras (it fails closed), where an unknown literal in `scopes` would make it drop every paired device.
 */
export const EXTRA_DEVICE_SCOPES: ReadonlyArray<DeviceScope> = ["browser"]

/**
 * The prompt metadata key of the device stamp (05 §13.4, 06 §2.9): the gateway writes `{scopes}` of the sending device
 * on every `POST /api/session/:sessionID/prompt` it relays and replaces any value the client sent. The PC's own clients
 * never pass the gateway, so their prompts carry none. own.team reads it when a user reply approves a voice plan: a
 * device's answer counts only for an action whose button that device may press.
 */
export const DEVICE_META = "own.device"

/** The value under {@link DEVICE_META}: the sending device's scopes, sorted. */
export const DeviceStamp = Schema.Struct({ scopes: Schema.Array(DeviceScope) }).annotate({
  identifier: "OwnRemote.DeviceStamp",
})
export type DeviceStamp = typeof DeviceStamp.Type

export const DeviceKind = Schema.Literals(["pwa", "app", "browser"]).annotate({ identifier: "OwnRemote.DeviceKind" })
export type DeviceKind = typeof DeviceKind.Type

/** `dev_<ulid>` (05 §2). */
export const DeviceID = Schema.String.check(Schema.isPattern(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/)).annotate({
  identifier: "OwnRemote.DeviceID",
})
export type DeviceID = typeof DeviceID.Type

/** `pair_<ulid>`. Not the pairing code: the code is only in the link (one time, 5 minutes). */
export const PairingID = Schema.String.check(Schema.isPattern(/^pair_[0-9A-HJKMNP-TV-Z]{26}$/)).annotate({
  identifier: "OwnRemote.PairingID",
})
export type PairingID = typeof PairingID.Type

/** `local` or a host id: the server keys of 04 §12.1 (`/srv/<serverKey>`). */
export const ServerKey = Schema.String.check(Schema.isPattern(/^(local|h-[a-z0-9]{6,8})$/)).annotate({
  identifier: "OwnRemote.ServerKey",
})

/** Servers a device may reach (05 §13.5 `servers`, default all). */
export const ServerScope = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("all") }),
  Schema.Struct({ mode: Schema.Literal("only"), keys: Schema.Array(ServerKey) }),
]).annotate({ identifier: "OwnRemote.ServerScope" })
export type ServerScope = typeof ServerScope.Type

const DeviceName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65_535 }))

/** One `devices.list` row (05 §13.5 `devices.json` without `tokenHash`). */
export const DeviceView = Schema.Struct({
  deviceId: DeviceID,
  name: Schema.String,
  kind: DeviceKind,
  scopes: Schema.Array(DeviceScope),
  servers: ServerScope,
  createdAt: EpochMillis,
  lastSeenAt: Schema.NullOr(EpochMillis),
  /** Address the last request came from (the tailnet peer behind `tailscale serve`). */
  lastIp: Schema.NullOr(Schema.String),
  /** Short browser/OS summary from the pairing request (`Safari · iOS`), never the full header. */
  userAgent: Schema.NullOr(Schema.String),
  expiresAt: EpochMillis,
  idleTimeoutDays: NonNegativeInt,
  revokedAt: Schema.NullOr(EpochMillis),
  state: Schema.Literals(["active", "expired", "revoked"]),
}).annotate({ identifier: "OwnRemote.DeviceView" })
export type DeviceView = typeof DeviceView.Type

/**
 * A pairing in progress (05 §13.5 흐름): `waiting` (link shown, not opened; `expiresAt` = code expiry, 5 min),
 * `pending` (the device opened it; SAS shown on both sides; `expiresAt` = approval deadline, 2 min), `approved`
 * (the device is finishing; `expiresAt` = claim deadline).
 */
export const PairingView = Schema.Struct({
  pairingId: PairingID,
  name: Schema.String,
  scopes: Schema.Array(DeviceScope),
  servers: ServerScope,
  expiresDays: NonNegativeInt,
  state: Schema.Literals(["waiting", "pending", "approved"]),
  expiresAt: EpochMillis,
  sas: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  tailscaleUser: Schema.NullOr(Schema.String),
}).annotate({ identifier: "OwnRemote.PairingView" })
export type PairingView = typeof PairingView.Type

/** Detection only (05 §13.3 안 A): own-open-code never installs, logs in, or runs `tailscale serve` itself. */
export const TailscaleView = Schema.Struct({
  state: Schema.Literals(["missing", "stopped", "logged_out", "running", "unknown"]),
  version: Schema.NullOr(Schema.String),
  /** MagicDNS name of this PC (`pc.tailnet.ts.net`), when running. */
  dnsName: Schema.NullOr(Schema.String),
  /** Whether `tailscale serve status` already proxies to this gateway; `null` when it could not be read. */
  serving: Schema.NullOr(Schema.Boolean),
  /** The command the user runs (guidance text); `null` while the gateway has no port. */
  serveCommand: Schema.NullOr(Schema.String),
  /**
   * Tailnet Lock (08 §2): `on` when new nodes need a signature from a trusted node, so a compromised control plane
   * cannot add one; `null` when it could not be read (old client, not running).
   */
  lock: optional(Schema.NullOr(Schema.Literals(["on", "off"]))),
  /** Whether `tailscale serve` forwards raw TCP to the app listener (08 §1 tailnet route); `null` when unknown. */
  appServing: optional(Schema.NullOr(Schema.Boolean)),
}).annotate({ identifier: "OwnRemote.TailscaleView" })
export type TailscaleView = typeof TailscaleView.Type

export const GatewayState = Schema.Literals(["off", "listening", "error"]).annotate({
  identifier: "OwnRemote.GatewayState",
})
export type GatewayState = typeof GatewayState.Type

/** A TCP route to the app listener (08 §3.1): `host:port`, tailnet first. */
export const AppRoute = Schema.Struct({
  kind: Schema.Literals(["tailnet", "direct"]),
  address: Schema.String,
  /** Whether the forwarder for it (`tailscale serve --tcp`, the portproxy rule) was seen; `null` when unknown. */
  ready: Schema.NullOr(Schema.Boolean),
}).annotate({ identifier: "OwnRemote.AppRoute" })
export type AppRoute = typeof AppRoute.Type

/**
 * The pinned-TLS app listener (08): apps (the Android app, another PC's desktop app) trust only `pin`, never a CA or
 * Tailscale. Loopback only; the routes reach it through `tailscale serve --tcp` or a Windows portproxy (DDNS).
 */
export const AppAccessView = Schema.Struct({
  enabled: Schema.Boolean,
  state: GatewayState,
  /** Why `state` is `error`: `port_in_use`, `bind_failed`, `vault_unavailable`, `gateway_off`. */
  problem: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Port),
  pcKey: Schema.NullOr(Schema.String),
  /** base64url SHA-256 of the certificate's SubjectPublicKeyInfo. */
  pin: Schema.NullOr(Schema.String),
  routes: Schema.Array(AppRoute),
  /** `tailscale serve --bg --tcp=<port> tcp://localhost:<port>`; `null` while off. */
  tailnetCommand: Schema.NullOr(Schema.String),
  direct: Schema.Struct({
    /** DDNS name or address devices dial from outside. */
    host: Schema.NullOr(Schema.String),
    port: Schema.NullOr(Port),
    /** Whether `netsh interface portproxy` forwards `port` to the app listener; `null` when unknown. */
    portproxy: Schema.NullOr(Schema.Boolean),
    /** Admin PowerShell commands the user runs (portproxy, firewall); empty while no direct port is set. */
    setupCommands: Schema.Array(Schema.String),
    removeCommands: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: "OwnRemote.AppAccessView" })
export type AppAccessView = typeof AppAccessView.Type

export const GatewayView = Schema.Struct({
  enabled: Schema.Boolean,
  state: GatewayState,
  /** Why `state` is `error`: `port_in_use`, `bind_failed`, `registration_missing`, `web_missing`. */
  problem: Schema.NullOr(Schema.String),
  bind: Schema.String,
  port: Schema.NullOr(Port),
  /** The loopback listener (`http://127.0.0.1:<G>`); `null` while off. */
  url: Schema.NullOr(Schema.String),
  /** Where devices reach it: the tailnet name when Tailscale runs, else the configured origin, else `null`. */
  publicOrigin: Schema.NullOr(Schema.String),
  tailscale: TailscaleView,
  devices: Schema.Struct({ active: NonNegativeInt, pairing: NonNegativeInt }),
  /** The pinned-TLS app listener (08); absent from builds before it. */
  app: optional(AppAccessView),
}).annotate({ identifier: "OwnRemote.GatewayView" })
export type GatewayView = typeof GatewayView.Type

/** 03 §21.3 `FeedKind` (the service-side kinds; `local` items are own-web's own). */
export const FeedKind = Schema.Literals([
  "turn.completed",
  "permission.asked",
  "question.asked",
  "quota.exhausted",
  "quota.reset",
  "auth.expired",
  "switch.suggested",
  "claude_slot_billing",
  "host.disconnected",
  /** A team waits for a decision on the PC (a confirm step) or an integration failed (06 §9.8). */
  "team.decision",
]).annotate({ identifier: "OwnRemote.FeedKind" })
export type FeedKind = typeof FeedKind.Type

/** 03 §21.3 / 05 §13.6 `FeedItem`: no model output, prompt, path or secret; `body` is never filled service-side. */
export const FeedItem = Schema.Struct({
  /** Feed ULID; also the cursor. */
  id: Schema.String,
  at: EpochMillis,
  kind: FeedKind,
  serverKey: Schema.String,
  sessionID: optional(Schema.String),
  title: optional(Schema.String),
  severity: Schema.Literals(["info", "warn", "danger"]),
}).annotate({ identifier: "OwnRemote.FeedItem" })
export type FeedItem = typeof FeedItem.Type

// ---------------------------------------------------------------------------------------------------------------
// Errors (04 §16.4). Declared types become HTTP 400; a handler must not throw.

export const errors = portable({
  host_not_found: Schema.Struct({ hostId: Schema.String }),
  host_busy: Schema.Struct({ hostId: Schema.String, opId: Schema.String }),
  ssh_missing: Schema.Struct({ path: Schema.String }),
  platform_unsupported: Schema.Struct({ os: Schema.String, arch: Schema.String }),
  disk_full: Schema.Struct({ needBytes: Schema.Finite, freeBytes: Schema.Finite }),
  version_skew: Schema.Struct({ local: Schema.String, remote: Schema.String }),
  host_identity_changed: Schema.Struct({ previous: Schema.NullOr(Schema.String), current: Schema.String }),
  forward_conflict: Schema.Struct({ alias: Schema.String, kinds: Schema.Array(Schema.String) }),
  forwarding_disabled: Schema.Struct({}),
  loopback_unavailable: Schema.Struct({ address: Schema.String }),
  host_key: Schema.Struct({ reason: Schema.Literals(["unknown", "changed"]) }),
  service_not_loopback: Schema.Struct({ hostname: Schema.String }),
  service_unresponsive: Schema.Struct({ pid: Schema.NullOr(Schema.Int) }),
  other_owner: Schema.Struct({ label: optional(Schema.String) }),
  ops_pending: Schema.Struct({ opId: Schema.String, kind: Schema.String }),
  session_busy: Schema.Struct({ sessionIDs: Schema.Array(Schema.String) }),
  remote_unreachable: Schema.Struct({ stage: Schema.String }),
  nonce_invalid: Schema.Struct({}),
  internal_error: Schema.Struct({}),
  /** own addition: `hosts.add` target or `respond` value refused (04 §7.2, §14.2). */
  input_invalid: Schema.Struct({ field: Schema.String, reason: Schema.String }),
  /** own addition: a method of a later phase (R2/R3) that this build does not implement yet. */
  not_supported: Schema.Struct({ feature: Schema.String }),
  /** own addition: no local bundle for the remote platform in `app\<ver>\remote\` (04 §5.2). */
  bundle_missing: Schema.Struct({ target: Schema.String, path: Schema.String }),
  /**
   * own addition (06 §4.13): a bundled tool does not match the sha256 pinned in the release's `remote\manifest.json`,
   * so nothing was sent to the host.
   */
  tool_hash_mismatch: Schema.Struct({ tool: Schema.String, expected: Schema.String, actual: Schema.String }),
  /** own addition (06 §4.13): the host's `<OWN_HOME>` file system does not run the uploaded tool (`noexec`). */
  noexec: Schema.Struct({}),
  /** own addition (06 §4.13): the tool could not be put in place on the host (upload, checksum, version check). */
  install_failed: Schema.Struct({}),

  // M1 (04 §16.8, 05 §13.3–13.5)
  /** The gateway is off or cannot listen (`reason`: `off`, `port_in_use`, `bind_failed`, `registration_missing`). */
  gateway_unavailable: Schema.Struct({ reason: Schema.String }),
  tailscale_missing: Schema.Struct({}),
  /** A bind address other than loopback (LAN, link-local, `0.0.0.0`/`::`, a tunnel address): refused (05 §13.3, MG1). */
  bind_rejected_lan: Schema.Struct({ address: Schema.String }),
  pairing_expired: Schema.Struct({ pairingId: Schema.String }),
  /** `reason`: `sas_mismatch` (the pairing is cancelled), `not_pending` (the device has not opened the link yet). */
  pairing_rejected: Schema.Struct({ pairingId: Schema.String, reason: Schema.String }),
  /** Raised by the gateway, never by a handler (a handler does not know the calling device, 04 §16.4). */
  scope_denied: Schema.Struct({ scope: Schema.String }),
  device_revoked: Schema.Struct({ deviceId: Schema.String }),
  /** own addition: `devices.update`/`devices.revoke` of an id `devices.json` does not have. */
  device_not_found: Schema.Struct({ deviceId: Schema.String }),
})

export type ErrorName = keyof typeof errors

function portable<const Schemas extends Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>>(schemas: Schemas) {
  // Since effect 4.0.6 toStandardSchemaV1 returns a copy with `~standard` instead of changing the schema in place.
  // SAFETY: one converted entry per key of `schemas`, each the type toStandardSchemaV1 returns for it.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, Schema.toStandardSchemaV1(schema)]),
  ) as { readonly [K in keyof Schemas]: ReturnType<typeof Schema.toStandardSchemaV1<Schemas[K]>> }
}

function pick<const Names extends ReadonlyArray<ErrorName>>(...names: Names) {
  // SAFETY: the entries are exactly the requested names plus internal_error, taken from `errors`.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return Object.fromEntries(
    [...names, "internal_error" as const].map((name): [ErrorName, Schema.Top] => [name, errors[name]]),
  ) as { readonly [K in Names[number] | "internal_error"]: (typeof errors)[K] }
}

function method<
  const Input extends Schema.ConstraintDecoder<unknown>,
  const Output extends Schema.ConstraintDecoder<unknown>,
  const Errors extends Rpc.ErrorMap,
>(input: Input, output: Output, errors_: Errors) {
  return { input: Schema.toStandardSchemaV1(input), output: Schema.toStandardSchemaV1(output), errors: errors_ }
}

// ---------------------------------------------------------------------------------------------------------------
// The browser pane on a device (05 §8.10): the hub <-> desktop shell half of `RemoteBrowser` (remote-browser.ts), whose
// plain types these mirror. The viewer's own messages never pass the RPC: the gateway checks them
// (`RemoteBrowser.parseClientMessage`) and the hub hands them on as they are.

/** One running desktop shell (a random id per start), so a restarted shell does not answer the old one's commands. */
const BrowserHostID = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(64))
const BrowserMode = Schema.Literals(["pc", "phone"])
const BrowserViewport = Schema.Struct({ width: Schema.Finite, height: Schema.Finite, dpr: Schema.Finite })
/**
 * The SSH host a pane's session runs on (05 §8.10.8); absent for this PC's service, which is all a shell or hub before
 * SSH panes knew.
 */
const BrowserServerKey = optional(HostID)
const BrowserHostView = Schema.Struct({
  serverKey: BrowserServerKey,
  sessionID: Schema.String,
  mode: BrowserMode,
  quality: Schema.Literals(["auto", "low"]),
  viewport: BrowserViewport,
})
/** `RemoteBrowser.InputEvent` and `RemoteBrowser.Action`, checked where a device sent them (the gateway). */
const BrowserHostCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("input"),
    serverKey: BrowserServerKey,
    sessionID: Schema.String,
    events: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("action"),
    serverKey: BrowserServerKey,
    sessionID: Schema.String,
    id: Schema.String,
    action: Schema.Unknown,
  }),
])
const BrowserTab = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(128)),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(1024)),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  loadError: optional(Schema.String.check(Schema.isMaxLength(1024))),
})
const BrowserPaneState = Schema.Struct({
  tabs: Schema.Array(BrowserTab).check(Schema.isMaxLength(64)),
  focusedTabID: Schema.NullOr(Schema.String),
  page: Schema.NullOr(Schema.Struct({ mode: BrowserMode, width: Schema.Finite, height: Schema.Finite })),
  dialog: Schema.NullOr(
    Schema.Struct({
      type: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
      message: Schema.String.check(Schema.isMaxLength(4096)),
      defaultPrompt: Schema.String.check(Schema.isMaxLength(4096)),
    }),
  ),
})

// ---------------------------------------------------------------------------------------------------------------
// Events (04 §16.3). Only the local leader publishes; every event has `eventId`.

function event<const S extends Schema.ConstraintDecoder<Readonly<Record<string, unknown>>>>(schema: S) {
  return { schema: Schema.toStandardSchemaV1(schema) }
}

export const Events = {
  "hosts.changed": event(Schema.Struct({ eventId: EventID, revision: NonNegativeInt })),
  "host.state": event(
    Schema.Struct({
      eventId: EventID,
      hostId: HostID,
      stage: Stage,
      paused: Schema.Boolean,
      error: optional(Schema.NullOr(HostError)),
      detail: optional(Schema.String),
      epoch: optional(NonNegativeInt),
      versions: optional(Versions),
    }),
  ),
  "host.prompt": event(
    Schema.Struct({
      eventId: EventID,
      hostId: HostID,
      promptId: Schema.String,
      kind: PromptKind,
      text: Schema.String,
      fingerprint: optional(Schema.String),
      keyType: optional(Schema.String),
      ownerClientId: Schema.NullOr(Schema.String),
    }),
  ),
  "host.progress": event(
    Schema.Struct({
      eventId: EventID,
      hostId: HostID,
      opId: optional(Schema.String),
      op: Schema.Literals(["install", "update", "drain", "sync", "forget"]),
      step: Schema.String,
      ok: optional(Schema.Boolean),
      error: optional(Schema.String),
    }),
  ),
  "catalog.changed": event(Schema.Struct({ eventId: EventID, hostId: HostID, epoch: NonNegativeInt })),
  "broker.status": event(
    Schema.Struct({
      eventId: EventID,
      hostId: HostID,
      state: Schema.Literals(["connected", "disconnected", "auth_failed"]),
      leasesActive: NonNegativeInt,
      spoolBacklog: NonNegativeInt,
      /**
       * 04 §8.11: the host's Claude relay verdict, last refusal and `needs_reauth` hold, so clients follow a change
       * without polling `hosts.list` (requests in flight stay in `hosts.list`). Absent when this PC has no slot.
       */
      claude: optional(
        Schema.Struct({
          state: Plugin.ClaudeRemoteState,
          lastError: Schema.NullOr(Schema.String),
          holdUntil: Schema.NullOr(EpochMillis),
        }),
      ),
    }),
  ),

  // M1 (04 §16.8)
  "gateway.state": event(
    Schema.Struct({
      eventId: EventID,
      enabled: Schema.Boolean,
      state: GatewayState,
      problem: Schema.NullOr(Schema.String),
      port: Schema.NullOr(Port),
      url: Schema.NullOr(Schema.String),
    }),
  ),
  /** The device opened the link: the PC shows the SAS and asks (05 §13.5). `local`: never sent to a device. */
  "device.pairing.pending": event(
    Schema.Struct({
      eventId: EventID,
      pairingId: PairingID,
      name: Schema.String,
      sas: Schema.String,
      userAgent: Schema.NullOr(Schema.String),
      tailscaleUser: Schema.NullOr(Schema.String),
      expiresAt: EpochMillis,
    }),
  ),
  /** own addition: a pairing left the list (`claimed`, `cancelled`, `rejected`, `expired`), so other windows close it. */
  "device.pairing.ended": event(
    Schema.Struct({
      eventId: EventID,
      pairingId: PairingID,
      reason: Schema.Literals(["claimed", "cancelled", "rejected", "expired"]),
    }),
  ),
  "device.paired": event(Schema.Struct({ eventId: EventID, deviceId: DeviceID, name: Schema.String })),
  "device.revoked": event(Schema.Struct({ eventId: EventID, deviceId: DeviceID })),
  /** A new feed item (05 §13.6); the gateway drops it for devices whose `servers` do not include its server. */
  "feed.item": event(Schema.Struct({ eventId: EventID, item: FeedItem })),
  /**
   * A device looks at, or prompted, a session whose browser pane no desktop window holds (05 §8.10): the desktop
   * app's window attaches it. `local`: never sent to a device.
   */
  "browser.pane.wanted": event(
    Schema.Struct({ eventId: EventID, sessionID: Schema.String, serverKey: optional(HostID) }),
  ),
}

// ---------------------------------------------------------------------------------------------------------------
// Definition (04 §16.2)

const hostOnly = Schema.Struct({ hostId: HostID })
const opResult = Schema.Struct({ opId: Schema.String })

export const Definition = Rpc.define({
  id: ID,
  methods: {
    // Reads
    "hosts.list": method(empty, Schema.Struct({ revision: NonNegativeInt, hosts: Schema.Array(HostView) }), pick()),
    "hosts.discover": method(empty, Schema.Struct({ aliases: Schema.Array(DiscoveredAlias) }), pick()),
    "hosts.detail": method(
      hostOnly,
      Schema.Struct({
        destination: Schema.NullOr(Schema.String),
        source: Schema.Literals(["connect", "file"]),
        configKeys: Schema.Array(Schema.String),
        forwards: Schema.Array(Schema.String),
      }),
      pick("host_not_found"),
    ),
    resolve: method(hostOnly, Resolved, pick("host_not_found")),
    "catalog.get": method(hostOnly, Catalog, pick("host_not_found")),
    "portForward.list": method(
      Schema.Struct({ hostId: optional(HostID) }),
      Schema.Struct({
        forwards: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            hostId: HostID,
            remotePort: NonNegativeInt,
            localPort: NonNegativeInt,
            openedAt: EpochMillis,
          }),
        ),
      }),
      pick(),
    ),
    diagnostics: method(hostOnly, Diagnostics, pick("host_not_found")),

    // Connection
    "hosts.add": method(
      Schema.Union([
        Schema.Struct({ alias: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)) }),
        Schema.Struct({
          target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
          name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
        }),
      ]),
      Schema.Struct({ host: HostView }),
      pick("input_invalid", "loopback_unavailable"),
    ),
    "hosts.update": method(
      HostUpdate,
      Schema.Struct({ host: HostView, pendingSettings: Schema.Boolean }),
      pick("host_not_found", "input_invalid"),
    ),
    connect: method(
      Schema.Struct({ hostId: HostID, clientId: ClientID, hostKeyPrompt: optional(Schema.Boolean) }),
      Schema.Struct({ stage: Stage }),
      pick("host_not_found", "host_busy", "ssh_missing", "forward_conflict", "other_owner", "ops_pending"),
    ),
    respond: method(
      Schema.Struct({
        hostId: HostID,
        promptId: Schema.String,
        clientId: ClientID,
        value: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
      }),
      empty,
      pick("host_not_found", "input_invalid"),
    ),
    /**
     * `replay`: send `host.prompt` again for every prompt this client still owns. A tab calls it once after loading
     * (a reload keeps its `sessionStorage` client id), so the owner tab gets its pending prompt back (04 §6.3, RG5).
     */
    heartbeat: method(Schema.Struct({ clientId: ClientID, replay: optional(Schema.Boolean) }), empty, pick()),
    cancel: method(
      Schema.Struct({ hostId: HostID, clientId: ClientID }),
      Schema.Struct({ stage: Stage }),
      pick("host_not_found"),
    ),
    disconnect: method(hostOnly, Schema.Struct({ stage: Stage }), pick("host_not_found")),

    /**
     * own addition (06 §4.13): puts the release's pinned static git-lfs under `<OWN_HOME>/tools/git-lfs/<version>/` on
     * the host (upload only, no sudo, 04 decision 4) unless that version is already there. A remote own.team that
     * answers `lfs_missing` cannot reach SSH itself, so own-web calls this on the local own-remote and then retries.
     * `noexec`/`install_failed`: the host did not take the tool; `input_invalid`: the host's `pathPrepend` cannot take
     * the tool's folder (04 §16.2).
     */
    "hosts.tools.ensure": method(
      Schema.Struct({ hostId: HostID, tool: Schema.Literal("git-lfs") }),
      Schema.Struct({ state: Schema.Literals(["uploaded", "present"]), version: Schema.String }),
      pick(
        "host_not_found",
        "host_busy",
        "remote_unreachable",
        "bundle_missing",
        "disk_full",
        "not_supported",
        "tool_hash_mismatch",
        "noexec",
        "install_failed",
        "input_invalid",
      ),
    ),

    // Two-step operations (plan → nonce → execute, 02 §9.2)
    "prepare.plan": method(
      hostOnly,
      Schema.Struct({
        ...planned,
        platform: Schema.Struct({ target: Schema.String }),
        install: Schema.Struct({
          version: Schema.String,
          dir: Schema.String,
          bytes: NonNegativeInt,
          needBytes: NonNegativeInt,
          freeBytes: Schema.NullOr(NonNegativeInt),
        }),
        existing: Schema.Struct({
          running: Schema.NullOr(Schema.String),
          staged: Schema.Array(Schema.String),
          upstreamOpencode: Schema.Boolean,
        }),
        hostIdentity: Schema.NullOr(Schema.String),
        writes: Schema.Array(Schema.String),
        root: Schema.Literal(false),
      }),
      pick(
        "host_not_found",
        "host_busy",
        "ssh_missing",
        "platform_unsupported",
        "disk_full",
        "other_owner",
        "ops_pending",
        "remote_unreachable",
        "bundle_missing",
      ),
    ),
    "prepare.execute": method(
      execute,
      Schema.Struct({ ok: Schema.Boolean, steps: Schema.Array(Step) }),
      pick("nonce_invalid", "host_busy", "disk_full"),
    ),
    "update.plan": method(
      hostOnly,
      Schema.Struct({
        ...planned,
        from: Schema.NullOr(Schema.String),
        to: Schema.String,
        staged: Schema.Boolean,
        activeSessions: Schema.NullOr(Schema.Array(Schema.String)),
        backup: Schema.Struct({ bytes: Schema.NullOr(NonNegativeInt) }),
        needBytes: NonNegativeInt,
        freeBytes: Schema.NullOr(NonNegativeInt),
      }),
      pick("host_not_found", "host_busy", "other_owner", "ops_pending", "remote_unreachable", "bundle_missing"),
    ),
    "update.execute": method(
      Schema.Struct({ nonce: Nonce, drain: Schema.Literals(["wait", "now"]) }),
      opResult,
      pick("nonce_invalid", "host_busy", "disk_full"),
    ),
    "drain.plan": method(
      Schema.Struct({ hostId: HostID, action: Schema.Literal("stop") }),
      Schema.Struct({ ...planned, activeSessions: Schema.NullOr(Schema.Array(Schema.String)) }),
      pick("host_not_found", "host_busy", "other_owner", "ops_pending", "remote_unreachable"),
    ),
    "drain.execute": method(
      Schema.Struct({ nonce: Nonce, mode: Schema.Literals(["wait", "now"]) }),
      opResult,
      pick("nonce_invalid", "host_busy"),
    ),
    "forget.plan": method(
      Schema.Struct({ hostId: HostID, uninstall: Schema.Boolean }),
      Schema.Struct({
        ...planned,
        activeSessions: Schema.NullOr(Schema.Array(Schema.String)),
        removes: Schema.Array(Schema.String),
        keeps: Schema.Array(Schema.String),
        leasedAccounts: Schema.Array(Schema.String),
      }),
      pick("host_not_found", "host_busy"),
    ),
    "forget.execute": method(execute, Schema.Struct({ ok: Schema.Boolean }), pick("nonce_invalid", "session_busy")),
    "sync.plan": method(
      Schema.Struct({ hostId: HostID, skills: Schema.Array(Schema.String) }),
      Schema.Struct({
        ...planned,
        items: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            action: Schema.Literals(["add", "update", "same", "present", "conflict"]),
            root: optional(Schema.String),
            windowsOnly: Schema.Boolean,
            bytes: NonNegativeInt,
          }),
        ),
      }),
      pick("host_not_found", "not_supported"),
    ),
    "sync.execute": method(
      execute,
      Schema.Struct({ ok: Schema.Boolean, steps: Schema.Array(Step) }),
      pick("nonce_invalid", "not_supported"),
    ),
    "tokens.rotate.plan": method(
      hostOnly,
      Schema.Struct({ ...planned, activeSessions: Schema.NullOr(Schema.Array(Schema.String)) }),
      pick("host_not_found", "not_supported"),
    ),
    "tokens.rotate.execute": method(
      execute,
      Schema.Struct({ ok: Schema.Boolean }),
      pick("nonce_invalid", "session_busy", "not_supported"),
    ),
    "owner.takeover.plan": method(
      hostOnly,
      Schema.Struct({ ...planned, previous: Schema.NullOr(Schema.Struct({ label: optional(Schema.String) })) }),
      pick("host_not_found", "remote_unreachable"),
    ),
    "owner.takeover.execute": method(execute, Schema.Struct({ ok: Schema.Boolean }), pick("nonce_invalid")),
    "recover.plan": method(
      hostOnly,
      Schema.Struct({
        ...planned,
        pid: Schema.NullOr(Schema.Int),
        exe: Schema.NullOr(Schema.String),
        version: Schema.NullOr(Schema.String),
        reason: Schema.Literal("unresponsive"),
      }),
      pick("host_not_found", "not_supported"),
    ),
    "recover.execute": method(execute, opResult, pick("nonce_invalid", "not_supported")),
    "legacy.plan": method(
      empty,
      Schema.Struct({
        ...planned,
        hosts: Schema.Array(
          Schema.Struct({
            alias: Schema.String,
            selected: Schema.Boolean,
            autoConnect: Schema.Boolean,
            profiles: NonNegativeInt,
            deferredPolicy: Schema.Boolean,
            remoteFolders: Schema.Array(Schema.String),
            exclude: Schema.NullOr(Schema.Literals(["forward_conflict", "duplicate_host_line", "already_added"])),
          }),
        ),
        source: Schema.NullOr(Schema.String),
      }),
      pick(),
    ),
    "legacy.execute": method(
      Schema.Struct({ nonce: Nonce, aliases: Schema.Array(Schema.String) }),
      Schema.Struct({ added: Schema.Array(HostView) }),
      pick("nonce_invalid"),
    ),
    "portForward.open": method(
      Schema.Struct({
        hostId: HostID,
        remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      }),
      Schema.Struct({ id: Schema.String, url: Schema.String }),
      pick("host_not_found", "loopback_unavailable", "not_supported"),
    ),
    "portForward.close": method(Schema.Struct({ id: Schema.String }), empty, pick("not_supported")),

    // Gateway (M1, 05 §13.3–13.4). PC only: every one of these is `local`.
    "gateway.status": method(empty, GatewayView, pick()),
    "gateway.configure.plan": method(
      Schema.Struct({
        port: optional(Port),
        /** Loopback only; anything else is `bind_rejected_lan` (05 §13.3, MG1). Default `127.0.0.1`. */
        bind: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
        /** Origin devices use when Tailscale is not detected (`https://pc.tailnet.ts.net`); `null` clears it. */
        publicOrigin: optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
        /** The app listener (08 §3.7). `directHost`: a DNS name or address without scheme; `null` clears it. */
        app: optional(
          Schema.Struct({
            enabled: Schema.Boolean,
            port: optional(Port),
            directHost: optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(253)))),
            directPort: optional(Schema.NullOr(Port)),
          }),
        ),
      }),
      Schema.Struct({
        ...planned,
        bind: Schema.String,
        port: Port,
        url: Schema.String,
        publicOrigin: Schema.NullOr(Schema.String),
        tailscale: TailscaleView,
        warnings: Schema.Array(
          Schema.Literals(["tailscale_missing", "tailscale_stopped", "tailscale_logged_out", "tailscale_not_serving"]),
        ),
      }),
      pick("bind_rejected_lan", "input_invalid", "gateway_unavailable"),
    ),
    "gateway.configure.execute": method(execute, GatewayView, pick("nonce_invalid", "gateway_unavailable")),
    "gateway.disable": method(empty, GatewayView, pick()),

    // Devices (M1, 05 §13.5). PC only.
    "devices.pair.start": method(
      Schema.Struct({
        name: DeviceName,
        scopes: Schema.Array(DeviceScope).check(Schema.isMinLength(1)),
        servers: ServerScope,
        expiresDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
        /**
         * Routes of `appLink` (08 §3.3, §4.3). `configured` (default): the tailnet and direct routes. `loopback`: only
         * `<bind>:<app port>`, for this PC's own 모바일 미리보기; that route is never offered anywhere else (QR,
         * `/own/routes`, the gateway view).
         */
        appRoute: optional(Schema.Literals(["configured", "loopback"])),
      }),
      /** `url` = `<publicOrigin or loopback URL>/auth/connect/<code>`: the one-time code, shown as QR on the PC. */
      /**
       * `appLink` = `ownpc://pair?…` with the same code, the pin and the routes (08 §3.3); `null` while the app listener
       * is off or has no route.
       */
      Schema.Struct({
        pairingId: PairingID,
        url: Schema.String,
        appLink: optional(Schema.NullOr(Schema.String)),
        expiresAt: EpochMillis,
      }),
      pick("gateway_unavailable", "input_invalid"),
    ),
    "devices.pair.approve": method(
      Schema.Struct({ pairingId: PairingID, sas: Schema.String.check(Schema.isPattern(/^\d{4}$/)) }),
      Schema.Struct({ pairingId: PairingID, deviceId: DeviceID, expiresAt: EpochMillis }),
      pick("pairing_expired", "pairing_rejected"),
    ),
    "devices.pair.cancel": method(Schema.Struct({ pairingId: PairingID }), empty, pick()),
    "devices.list": method(
      empty,
      Schema.Struct({ devices: Schema.Array(DeviceView), pairings: Schema.Array(PairingView) }),
      pick(),
    ),
    "devices.update": method(
      Schema.Struct({
        deviceId: DeviceID,
        name: optional(DeviceName),
        scopes: optional(Schema.Array(DeviceScope).check(Schema.isMinLength(1))),
        servers: optional(ServerScope),
      }),
      Schema.Struct({ device: DeviceView }),
      pick("device_not_found", "device_revoked", "input_invalid"),
    ),
    "devices.revoke": method(Schema.Struct({ deviceId: DeviceID }), Schema.Struct({ device: DeviceView }), pick("device_not_found")),
    "devices.revokeAll": method(empty, Schema.Struct({ revoked: NonNegativeInt }), pick()),

    // Feed (05 §13.6). Bound to the calling device: the gateway overwrites `deviceId` with the caller's own.
    "feed.list": method(
      Schema.Struct({
        after: optional(Schema.String.check(Schema.isMaxLength(64))),
        limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
        deviceId: optional(DeviceID),
      }),
      /** `ack`: the device's cursor (`null` for the PC or a device that never acknowledged). */
      Schema.Struct({ items: Schema.Array(FeedItem), ack: Schema.NullOr(Schema.String) }),
      pick(),
    ),
    "feed.ack": method(
      Schema.Struct({ upTo: Schema.String.check(Schema.isMaxLength(64)), deviceId: optional(DeviceID) }),
      empty,
      pick("device_not_found"),
    ),
    // The browser pane on a device (05 §8.10, MBR). The viewer itself is the gateway's socket
    // (`RemoteBrowser.SOCKET_PATH`); these are what a device reads and what the desktop app's two processes call.
    /** `desktop`: a desktop app that can hold panes runs on the PC and polled the hub lately. */
    "browser.status": method(empty, Schema.Struct({ desktop: Schema.Boolean }), pick()),
    /**
     * The desktop window (`local`): the sessions devices want a pane for now, on start and after `browser.pane.wanted`.
     * `sessionIDs`: this PC's service; `hosts`: sessions of SSH hosts (05 §8.10.8), absent from a service before them.
     */
    "browser.pane.wanted": method(
      empty,
      Schema.Struct({
        sessionIDs: Schema.Array(Schema.String),
        hosts: optional(Schema.Array(Schema.Struct({ serverKey: HostID, sessionID: Schema.String }))),
      }),
      pick(),
    ),
    /**
     * The desktop shell's long poll (`local`): what it holds, and what the hub wants of it. `hosted`: the sessions
     * with a live pane attachment, as `RemoteBrowser.paneKey` names them (a local session by its id). Answers at once when something waits, else after `waitMs` at most.
     * `views`: everything to stream now (the shell stops what is not listed and clears its phone emulation);
     * `commands`: input and actions since the last pull, in order.
     */
    "browser.host.pull": method(
      Schema.Struct({
        host: BrowserHostID,
        windows: NonNegativeInt,
        hosted: Schema.Array(Schema.String).check(Schema.isMaxLength(512)),
        waitMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 })),
      }),
      Schema.Struct({
        views: Schema.Array(BrowserHostView),
        commands: Schema.Array(BrowserHostCommand),
        /** No paired device may open a viewer now (the gateway is off, or none holds `browser`): poll slowly. */
        idle: Schema.Boolean,
      }),
      pick(),
    ),
    /**
     * One JPEG frame of a session's focused tab (`local`). Answers at the first viewer's acknowledgement (the hub
     * brings slower viewers up to the newest frame), or after `RemoteBrowser.ACK_TIMEOUT_MS`; `viewers: 0` means
     * nobody watches any more.
     */
    "browser.host.frame": method(
      Schema.Struct({
        host: BrowserHostID,
        serverKey: BrowserServerKey,
        sessionID: Schema.String,
        width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
        height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
        sharp: Schema.Boolean,
        /** base64 JPEG, at most `RemoteBrowser.MAX_FRAME_BYTES` decoded. */
        data: Schema.String.check(Schema.isMaxLength(2_100_000)),
      }),
      Schema.Struct({ viewers: NonNegativeInt, acked: Schema.Boolean }),
      pick("input_invalid"),
    ),
    /** A session's pane as the shell has it now (`local`): tabs, the page's viewport, an open dialog; and notices. */
    "browser.host.state": method(
      Schema.Struct({
        host: BrowserHostID,
        serverKey: BrowserServerKey,
        sessionID: Schema.String,
        state: optional(BrowserPaneState),
        notice: optional(Schema.Literals(["download", "file_chooser"])),
      }),
      empty,
      pick(),
    ),
    /** The outcome of an `action` command (`local`). `error`: `RemoteBrowser.ACTION_ERROR` or the pane's refusal code. */
    "browser.host.result": method(
      Schema.Struct({
        host: BrowserHostID,
        id: Schema.String.check(Schema.isMaxLength(64)),
        ok: Schema.Boolean,
        error: optional(Schema.String.check(Schema.isMaxLength(200))),
      }),
      empty,
      pick(),
    ),

    /** Web Push (M2, 05 §13.6): not in this build. */
    "push.register": method(
      Schema.Struct({ endpoint: Schema.String.check(Schema.isMaxLength(2048)), deviceId: optional(DeviceID) }),
      empty,
      pick("not_supported"),
    ),
    "push.unregister": method(Schema.Struct({ deviceId: optional(DeviceID) }), empty, pick("not_supported")),

    // On the remote server (`mode:"agent"`)
    "agent.realpath": method(
      Schema.Struct({ path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)) }),
      Schema.Struct({ realpath: Schema.NullOr(Schema.String), isSymlink: Schema.Boolean, exists: Schema.Boolean }),
      pick("not_supported"),
    ),
    "agent.status": method(
      empty,
      Schema.Struct({
        version: Schema.String,
        buildId: Schema.String,
        proto: NonNegativeInt,
        mirror: Schema.Struct({ revision: Schema.NullOr(NonNegativeInt), fetchedAt: Schema.NullOr(EpochMillis) }),
        broker: Schema.Struct({
          state: Schema.Literals(["unarmed", "connecting", "connected", "drain", "skew", "unavailable"]),
          epoch: Schema.NullOr(NonNegativeInt),
          leases: Schema.Array(Schema.Struct({ providerID: Schema.String, deadlineInMs: Schema.Finite })),
        }),
        spool: Schema.Struct({ backlog: NonNegativeInt, bytes: NonNegativeInt, gaps: NonNegativeInt }),
        owner: Schema.Struct({ installId: Schema.NullOr(Schema.String) }),
      }),
      pick("not_supported"),
    ),
    "agent.broker.arm": method(
      Schema.Struct({
        hostId: HostID,
        epoch: NonNegativeInt,
        /** base64url of the 32-byte epoch key K (04 §8.3). Kept only in the broker client's closure. */
        key: Schema.String.check(Schema.isMinLength(43), Schema.isMaxLength(64)),
        endpoint: Schema.Union([
          Schema.Struct({ socket: Schema.String }),
          Schema.Struct({ tcpPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })) }),
        ]),
        /**
         * 04 §8.11.4.2: the second forward, to this PC's Claude egress relay (`egress-<epoch>.sock` or a remote TCP
         * port). Absent from older PCs and when the relay listener could not open; an older agent drops it.
         */
        egress: optional(
          Schema.Union([
            Schema.Struct({ socket: Schema.String }),
            Schema.Struct({ tcpPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })) }),
          ]),
        ),
        proto: NonNegativeInt,
      }),
      Schema.Struct({
        accepted: Schema.Boolean,
        reason: optional(Schema.Literals(["stale_epoch", "key_mismatch", "proto", "unavailable"])),
      }),
      pick("not_supported"),
    ),
    "agent.probe": method(
      Schema.Struct({ commands: optional(Schema.Array(Schema.String)) }),
      Schema.Struct({
        shell: Schema.String,
        path: Schema.String,
        found: Schema.Record(Schema.String, Schema.Boolean),
        tmpdir: Schema.NullOr(Schema.String),
        exitCode: Schema.NullOr(Schema.Int),
      }),
      pick("input_invalid", "not_supported"),
    ),
  },
  events: Events,
})
export type Definition = typeof Definition

/**
 * What the remote service registers (`mode:"agent"`): only `agent.*`. Local methods answer
 * `rpc.method_not_found` there, so no SSH controller surface exists on a remote host.
 */
export const AgentDefinition = Rpc.define({
  id: ID,
  methods: {
    "agent.realpath": Definition.methods["agent.realpath"],
    "agent.status": Definition.methods["agent.status"],
    "agent.broker.arm": Definition.methods["agent.broker.arm"],
    "agent.probe": Definition.methods["agent.probe"],
  },
  events: {},
})

export type MethodName = keyof Definition["methods"] & string
export type EventName = keyof Definition["events"] & string

// ---------------------------------------------------------------------------------------------------------------
// Device scopes (04 §16.7)

/**
 * `read | drive | manage | local` (same vocabulary as 02 §9.1). The gateway enforces it on
 * `/api/rpc/own.remote/<method>`; `connect` with `hostKeyPrompt:true` in its body is `local` (body check).
 * `remote` marks `agent.*`: only the local own-remote calls it, and the gateway's `/srv/<hostId>` relay always
 * blocks that path (04 §12.7).
 */
export const Scope = Schema.Literals(["read", "drive", "manage", "local", "remote"]).annotate({
  identifier: "OwnRemote.Scope",
})
export type Scope = typeof Scope.Type

/** Typed so that a new method cannot be added without a scope. */
export const MethodScope: { readonly [M in MethodName]: Scope } = {
  "hosts.list": "read",
  "catalog.get": "read",
  "portForward.list": "read",

  connect: "manage",
  disconnect: "manage",
  "drain.plan": "manage",
  "drain.execute": "manage",
  diagnostics: "manage",
  // Device admin, like own.team `enable` that it unblocks on a remote host (06 §4.13).
  "hosts.tools.ensure": "manage",

  "hosts.discover": "local",
  "hosts.detail": "local",
  "hosts.add": "local",
  "hosts.update": "local",
  resolve: "local",
  respond: "local",
  heartbeat: "local",
  cancel: "local",
  "prepare.plan": "local",
  "prepare.execute": "local",
  "update.plan": "local",
  "update.execute": "local",
  "forget.plan": "local",
  "forget.execute": "local",
  "sync.plan": "local",
  "sync.execute": "local",
  "tokens.rotate.plan": "local",
  "tokens.rotate.execute": "local",
  "owner.takeover.plan": "local",
  "owner.takeover.execute": "local",
  "recover.plan": "local",
  "recover.execute": "local",
  "legacy.plan": "local",
  "legacy.execute": "local",
  "portForward.open": "local",
  "portForward.close": "local",
  "gateway.status": "local",
  "gateway.configure.plan": "local",
  "gateway.configure.execute": "local",
  "gateway.disable": "local",
  "devices.pair.start": "local",
  "devices.pair.approve": "local",
  "devices.pair.cancel": "local",
  "devices.list": "local",
  "devices.update": "local",
  "devices.revoke": "local",
  "devices.revokeAll": "local",

  // Bound to the calling device by the gateway (05 §13.5 "기기에 묶인 메서드").
  "feed.list": "read",
  "feed.ack": "read",
  "push.register": "read",
  "push.unregister": "read",

  // 05 §8.10: a device reads whether the PC's desktop app is there; the rest is the desktop app's own.
  "browser.status": "read",
  "browser.pane.wanted": "local",
  "browser.host.pull": "local",
  "browser.host.frame": "local",
  "browser.host.state": "local",
  "browser.host.result": "local",

  "agent.realpath": "remote",
  "agent.status": "remote",
  "agent.broker.arm": "remote",
  "agent.probe": "remote",
}

/** Scope of a call, including the body rule for `connect{hostKeyPrompt:true}` (04 §16.7). */
export function scopeOf(method: MethodName, input: unknown): Scope {
  if (
    method === "connect" &&
    typeof input === "object" &&
    input !== null &&
    "hostKeyPrompt" in input &&
    input.hostKeyPrompt === true
  )
    return "local"
  return MethodScope[method]
}

/**
 * Events are `read` except `host.prompt` (prompt text and fingerprint stay on the PC, 04 §16.7) and the pairing
 * events (the SAS is shown on the PC only, 05 §13.5). The gateway drops `local` frames from a device's event stream.
 */
export const EventScope: { readonly [E in EventName]: Scope } = {
  "hosts.changed": "read",
  "host.state": "read",
  "host.prompt": "local",
  "host.progress": "read",
  "catalog.changed": "read",
  "broker.status": "read",
  "gateway.state": "read",
  "device.pairing.pending": "local",
  "device.pairing.ended": "local",
  "device.paired": "read",
  "device.revoked": "read",
  "feed.item": "read",
  "browser.pane.wanted": "local",
}

/** Methods whose input carries the calling device; the gateway overwrites `deviceId` (05 §13.5). */
export const DEVICE_BOUND: ReadonlySet<MethodName> = new Set<MethodName>([
  "feed.list",
  "feed.ack",
  "push.register",
  "push.unregister",
])

/**
 * Whether a device holding `scopes` may call a method of this definition with this input (05 §13.5, §16 표):
 * `read` ↔ `read`, `drive` ↔ `switch`, `manage` ↔ `admin`; `local` and `remote` never.
 */
export function deviceAllows(scopes: ReadonlySet<string>, method: MethodName, input: unknown) {
  switch (scopeOf(method, input)) {
    case "read":
      return scopes.has("read")
    case "drive":
      return scopes.has("switch")
    case "manage":
      return scopes.has("admin")
    case "local":
    case "remote":
      return false
  }
}

/** Where a call goes: `control` = the local control location; `agent` = the remote server's control location. */
export const MethodLocation = (method: MethodName): "control" | "agent" =>
  method.startsWith("agent.") ? "agent" : "control"
