export * as Plugin from "./plugin.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { Account } from "./account.js"
import { IsoDateTime } from "./id.js"

/** Plugin id of the third-party Claude subscription slot (02 §8.4). */
export const CLAUDE_AUTH_ID = "heymaaz.claude-auth-v2"
export const CLAUDE_AUTH_PACKAGE = "opencode-claude-auth-v2"

/**
 * The patch of the claude-auth the app ships (02 §8.2, bundled since 2026-10-18): `patched` (the loaded plugin is the
 * app's bundle and every file has its recorded hash) runs several Claude accounts; `modified` (a file differs, or the
 * loaded claude-auth is not the app's bundle) is blocked like an integrity mismatch. `pristine`, `stale` and
 * `no_manifest` were states of the former in-app npm install and are no longer reported; `no_manifest` also stands for
 * "nothing loaded".
 */
export const ClaudePatchState = Schema.Literals(["patched", "pristine", "stale", "modified", "no_manifest"]).annotate({
  identifier: "Own.Plugin.ClaudePatchState",
})
export type ClaudePatchState = typeof ClaudePatchState.Type

/** `plugin.claudeAuth.status.patch`: the state, the patch manifest's hash, and whether the module carries it. */
export interface ClaudePatchStatus extends Schema.Schema.Type<typeof ClaudePatchStatus> {}
export const ClaudePatchStatus = Schema.Struct({
  state: ClaudePatchState,
  sha256: Schema.NullOr(Schema.String),
  /** The loaded module exports the multi-account marker and exports (another copy of the module would not). */
  loaded: Schema.Boolean,
}).annotate({ identifier: "Own.Plugin.ClaudePatchStatus" })

/**
 * `plugin.claudeAuth.status.bundle` (02 §8.2): the bundled plugin's pin, its patch manifest's hash and the release build
 * id it was built with (`own-bundle.json`; `null` from a source run's bundle).
 */
export interface ClaudeBundleStatus extends Schema.Schema.Type<typeof ClaudeBundleStatus> {}
export const ClaudeBundleStatus = Schema.Struct({
  version: Schema.String,
  integrity: Schema.String,
  patchSha256: Schema.String,
  buildId: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Own.Plugin.ClaudeBundleStatus" })

/**
 * Consent to use the slot from SSH remote hosts (04 §8.11.12), KV `ack:claudeRemote` on this PC only. Valid only while
 * the slot is the verified bundle here and all three values match the bundled pin and the remote notice hash.
 */
export interface ClaudeRemoteAck extends Schema.Schema.Type<typeof ClaudeRemoteAck> {}
export const ClaudeRemoteAck = Schema.Struct({
  acknowledgedAt: IsoDateTime,
  pluginVersion: Schema.String,
  integrity: Schema.String,
  noticeHash: Schema.String,
}).annotate({ identifier: "Own.Plugin.ClaudeRemoteAck" })

/**
 * The PC's verdict for the slot on one SSH host (04 §8.11.4.3), first match wins: `not_ready` (the slot is not
 * detected and verified here, or `anthropic` has no active connection), `billing` (that connection is an API key
 * or env), `off` (the host is not in `claudeSlot.remoteHosts`), `consent` (`ack:claudeRemote` is missing or stale),
 * `host_scope` (the host's account scope is `only` without `acc_claude_slot`), else `enabled`.
 */
export const ClaudeRemoteState = Schema.Literals([
  "not_ready",
  "billing",
  "off",
  "consent",
  "host_scope",
  "enabled",
]).annotate({ identifier: "Own.Plugin.ClaudeRemoteState" })
export type ClaudeRemoteState = typeof ClaudeRemoteState.Type

/** One host of `plugin.claudeAuth.status.remote` (04 §8.11.12): the switch and the verdict. */
export interface ClaudeRemoteHost extends Schema.Schema.Type<typeof ClaudeRemoteHost> {}
export const ClaudeRemoteHost = Schema.Struct({
  hostId: Schema.String,
  enabled: Schema.Boolean,
  state: ClaudeRemoteState,
}).annotate({ identifier: "Own.Plugin.ClaudeRemoteHost" })

/**
 * `plugin.claudeAuth.status.remote` (04 §8.11.12): the remote consent and the hosts this PC knows (the ones switched on
 * and the ones whose broker listener is open). `noticeHash` is the remote notice's hash the UI acknowledges with.
 */
export interface ClaudeRemoteStatus extends Schema.Schema.Type<typeof ClaudeRemoteStatus> {}
export const ClaudeRemoteStatus = Schema.Struct({
  acknowledged: Schema.NullOr(Schema.Struct({ at: IsoDateTime, valid: Schema.Boolean })),
  noticeHash: Schema.String,
  hosts: Schema.Array(ClaudeRemoteHost),
}).annotate({ identifier: "Own.Plugin.ClaudeRemoteStatus" })

/**
 * Position of claude-auth in the configured plugin order
 * `[own.accounts, own.remote, own.team, claude-auth, own.telemetry, own.computer-use, own.import, own.harness]`
 * (02 §8.2, 06 §2.6, 09 §5.1, 10 H0).
 */
export const ClaudeAuthOrder = Schema.Literals([
  "ok",
  "before_own_accounts",
  "before_own_team",
  "after_own_telemetry",
  "missing",
]).annotate({
  identifier: "Own.Plugin.ClaudeAuthOrder",
})
export type ClaudeAuthOrder = typeof ClaudeAuthOrder.Type

export const ClaudeAuthPhase = Schema.Literals([
  "absent",
  "installing",
  "installed",
  "uninstalling",
  "ready",
  "error",
]).annotate({ identifier: "Own.Plugin.ClaudeAuthPhase" })
export type ClaudeAuthPhase = typeof ClaudeAuthPhase.Type

/** `plugin.claudeAuth.status` result (02 §9.2). */
export interface ClaudeAuthStatus extends Schema.Schema.Type<typeof ClaudeAuthStatus> {}
export const ClaudeAuthStatus = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  integrityOk: Schema.NullOr(Schema.Boolean),
  order: ClaudeAuthOrder,
  phase: ClaudeAuthPhase,
  /**
   * The local consent of services before the bundled plugin (2026-10-18); always `null` now: the plugin ships with the
   * app and its risk notice is informational (02 §8.4).
   */
  acknowledged: Schema.NullOr(
    Schema.Struct({ at: IsoDateTime, version: Schema.String, integrity: Schema.String, valid: Schema.Boolean }),
  ),
  connection: Schema.NullOr(Account.Connection),
  warnings: Schema.Array(Schema.String),
  /** Use on SSH remote hosts (04 §8.11.12); absent from services older than the relay. */
  remote: optional(ClaudeRemoteStatus),
  /** The plugin's patch (02 §8.2); absent from services older than several Claude accounts. */
  patch: optional(ClaudePatchStatus),
  /** The bundled plugin (02 §8.2); absent from services before the bundle, `null` when the app carries none. */
  bundle: optional(Schema.NullOr(ClaudeBundleStatus)),
}).annotate({ identifier: "Own.Plugin.ClaudeAuthStatus" })

/**
 * One step of an install/uninstall job of services before the bundled plugin (2026-10-18): `download`, `verify`,
 * `patch`, `configure`, `reload` (02 §9.2). The methods remain for older clients and refuse (`built_in`).
 */
export interface Step extends Schema.Schema.Type<typeof Step> {}
export const Step = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
  error: optional(Schema.String),
}).annotate({ identifier: "Own.Plugin.Step" })

export interface JobResult extends Schema.Schema.Type<typeof JobResult> {}
export const JobResult = Schema.Struct({ ok: Schema.Boolean, steps: Schema.Array(Step) }).annotate({
  identifier: "Own.Plugin.JobResult",
})

/** Allowlist state of a Location (02 §4.2). */
export const TrustStatus = Schema.Literals(["ok", "blocked_by_plugin"]).annotate({
  identifier: "Own.Plugin.TrustStatus",
})
export type TrustStatus = typeof TrustStatus.Type

export interface TrustPlugin extends Schema.Schema.Type<typeof TrustPlugin> {}
export const TrustPlugin = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  sha256: Schema.String,
}).annotate({ identifier: "Own.Plugin.TrustPlugin" })

/** One `plugin.trust.list` location. `plugins` excludes the default allowlist entries (02 §9.2). */
export interface TrustLocation extends Schema.Schema.Type<typeof TrustLocation> {}
export const TrustLocation = Schema.Struct({
  directory: Schema.String,
  status: TrustStatus,
  plugins: Schema.Array(Schema.Struct({ ...TrustPlugin.fields, approved: Schema.Boolean })),
}).annotate({ identifier: "Own.Plugin.TrustLocation" })
