export * as Module from "./module.js"

import type { Plugin } from "@opencode/plugin"
import type { Modules } from "./modules.js"
import type { Resets } from "./resets.js"

/** Every OpenCode event as the promise plugin API delivers it (`ctx.event.subscribe`, all Locations). */
export type OpenCodeEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event> ? Event : never

export interface EventMeta {
  /**
   * The event's Location is this instance's Location. Every instance receives every event (02 §4.1
   * "Location마다 중복 수신"), so session work (state machine, ledger lines, `ledger.step`) runs only where `local`.
   */
  readonly local: boolean
  /**
   * The context reset or undo a local event is (core P-035, `Resets.Tracker`): one tracker in the dispatcher, which
   * looks a delivery it did not see admitted up in the session's context, so a restart in between still counts.
   */
  readonly reset?: Resets.ColdPoint
}

/** Lifecycle every module implements; `Modules.start`/`stop` and the event dispatcher call it. */
export interface Lifecycle {
  /**
   * Runs once after every module exists and before transforms, hooks and RPC are registered: load state (the
   * registry must be in memory before the provider fold runs, 02 §3.8), subscribe to `runtime.broadcast`, re-arm
   * KV timers. Throwing aborts plugin setup.
   */
  readonly start: () => Promise<void>
  /** Plugin cleanup, in reverse start order: cancel timers, unsubscribe. Must not throw. */
  readonly stop: () => Promise<void>
  /** Receives every OpenCode event in stream order. Keep it quick (queue slow work); a throw is logged and ignored. */
  readonly onEvent?: (event: OpenCodeEvent, meta: EventMeta) => Promise<void> | void
  /**
   * The event stream was subscribed again after it failed (a consumer 4096 events behind, a server restart): the
   * events in between are lost. Called before the first event of the new subscription, which is live by then; mark
   * what such events would have changed as unverified and read it back where it matters. Keep it quick.
   */
  readonly onResubscribe?: () => void
}

/** Late-bound access to the other modules. Call it from methods, `start` or later, never inside a `create`. */
export type Peers = () => Modules.All
