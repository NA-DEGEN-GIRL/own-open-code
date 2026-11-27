export * as Deps from "./deps.js"

import type { Plugin } from "@opencode/plugin"
import type { Runtime } from "@own/runtime"
import type { Clock } from "./clock.js"
import type { Emitter } from "./emitter.js"
import type { Endpoints } from "./endpoints.js"
import type { Events } from "./events.js"
import type { Logger } from "./logger.js"
import type { Options } from "./options.js"
import type { RemoteHost } from "./remote/host.js"

/**
 * Shared context passed to every module's `create`. Everything here is per plugin instance (one per Location)
 * except `runtime`, the process singleton reached through `Runtime.acquire` (01 §4).
 */
export interface Deps {
  /** This Location's plugin context: `ctx.session`, `ctx.provider`, `ctx.storage` (own-accounts KV), … */
  readonly ctx: Plugin.Context
  /** Stores, credentials (headers only, no raw getter), limits, ledger writer, lastResponse, broadcast. */
  readonly runtime: Runtime.Handle
  /** Decoded plugin options. */
  readonly options: Options.Info
  /** Provider, OAuth and poller URLs; test overrides included. */
  readonly endpoints: Endpoints.Endpoints
  /** Redacting logger; use `log.child("<module>")`. */
  readonly log: Logger.Logger
  readonly clock: Clock.Clock
  /** `rpc.own.accounts.*` events with envelope and leader rule. */
  readonly emitter: Emitter.Publisher
  /**
   * Which sessions belong to this Location (`meta.local`): the event dispatcher learns from located events, modules
   * from session lookups, so location-less events of a known session count as local.
   */
  readonly places: Events.Places
  /**
   * `OPENCODE_CONFIG_DIR` as the plugin read it at setup: this service's own global config directory (on this PC
   * `%OPENCODE_CONFIG_DIR%`, set by the launcher's env bridge, 01 §5.2). Absent when unset.
   */
  readonly configDir?: string
  readonly location: {
    readonly directory: string
    /** This is the control location: global RPCs arrive here and it leads the runtime (02 §9.1). */
    readonly control: boolean
  }
  /**
   * `mode:"remote"` only (04 §9): the remote service's broker client, leases, fail-closed sink and spool. Absent on
   * this PC (`mode:"local"`), where credentials come from the vault and the linked reader.
   */
  readonly remote?: RemoteHost.Api
}
