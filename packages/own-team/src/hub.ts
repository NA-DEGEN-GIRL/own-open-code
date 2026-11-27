export * as Hub from "./hub.js"

import type { OpenCodeEvent } from "@opencode/client"
import type { Rpc } from "@opencode/schema/rpc"
import type { OwnTeam } from "@own/protocol"
import type { Log } from "./log.js"

/**
 * The controller's event hub, in both directions:
 * - **out**: own.team notifications (`rpc.own.team.<name>`, 06 §2.7). Every plugin instance listens; only the leader
 *   republishes them through its RPC registration, each with a fresh `eventId` and `origin: "global"` (06 §2.6).
 * - **in**: core events of every Location instance, forwarded by `intake.ts` once per event id. Feature services
 *   subscribe in their `create` (reports, Main 멈춤, the outbox) instead of each opening an event stream.
 */

type Definition = OwnTeam.Definition
export type EventName = OwnTeam.EventName

/** An event payload as the RPC registration emits it, with the `eventId`/`origin` envelope. */
export type Payload<N extends EventName> = Rpc.EventInputData<Definition["events"][N]["schema"]>
/** The payload without the envelope, which the emitting instance adds. */
export type Body<N extends EventName> = Omit<Payload<N>, "eventId" | "origin">

export type Outgoing = { readonly [N in EventName]: { readonly name: N; readonly data: Body<N> } }[EventName]

export type Incoming = OpenCodeEvent

export class Bus {
  readonly #log: Log.Logger
  readonly #out = new Set<(event: Outgoing) => void>()
  readonly #in = new Set<(event: Incoming) => void | Promise<void>>()

  constructor(log: Log.Logger) {
    this.#log = log
  }

  /** Publishes an own.team event to every instance listener (the leader emits it). */
  publish(event: Outgoing) {
    for (const listener of this.#out) listener(event)
  }

  /** An instance's listener for own.team events; returns the unsubscribe function. */
  subscribe(listener: (event: Outgoing) => void) {
    this.#out.add(listener)
    return () => {
      this.#out.delete(listener)
    }
  }

  /** A core event from `intake.ts` (already deduplicated). Listener failures are logged, never thrown. */
  receive(event: Incoming) {
    for (const listener of this.#in)
      void Promise.resolve()
        .then(() => listener(event))
        .catch((error: unknown) => this.#log.warn("event_listener_failed", { type: event.type, error }))
  }

  /** A feature's listener for core events; returns the unsubscribe function. */
  on(listener: (event: Incoming) => void | Promise<void>) {
    this.#in.add(listener)
    return () => {
      this.#in.delete(listener)
    }
  }

  clear() {
    this.#out.clear()
    this.#in.clear()
  }
}
