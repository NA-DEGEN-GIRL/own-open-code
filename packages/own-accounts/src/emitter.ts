export * as Emitter from "./emitter.js"

import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { Rpc } from "@opencode/schema/rpc"
import { OwnID } from "@own/protocol"
import type { Logger } from "./logger.js"
import type { RpcTypes } from "./rpc/types.js"

/** Events only the process leader emits; UIs de-duplicate by `eventId` (02 §9.1). */
export const GLOBAL = [
  "accounts.changed",
  "quota.updated",
  "account.status",
  "plugin.status",
  "plugin.trust.changed",
  "presets.changed",
  "notes.changed",
  "ideas.changed",
  "conversationFolder.changed",
  "folderPicker.changed",
  "projectList.changed",
  "protectedPaths.changed",
  "codexModels.changed",
  "mcp.changed",
  "skillset.changed",
  "claudeAgent.pool",
  "github.changed",
] as const
export type GlobalEvent = (typeof GLOBAL)[number]
/** Emitted by the instance of the session's Location. `alert` may be either (a session alert or a global one). */
export type SessionEvent = Exclude<RpcTypes.EventName, GlobalEvent>

/**
 * The only way modules publish `rpc.own.accounts.*` events. It adds the `eventId` + `origin` envelope, applies the
 * leader rule, and never throws. Before the RPC registration exists (early setup) and after cleanup, events are
 * dropped with a debug log: they are notifications, and clients resync on `server.connected` (02 §9.1).
 */
export class Publisher {
  readonly #isLeader: () => boolean
  readonly #log: Logger.Logger
  readonly #remote: boolean
  #registration: RpcRegistration<RpcTypes.Definition> | undefined

  /**
   * `remote`: a remote service (04 §9.1) never sends global events; own-web gets them from the local service. Its
   * session events (`binding.changed`, `cache.state`, `switch.*`, session `alert`, …) go out as usual.
   */
  constructor(options: { readonly isLeader: () => boolean; readonly log: Logger.Logger; readonly remote?: boolean }) {
    this.#isLeader = options.isLeader
    this.#log = options.log
    this.#remote = options.remote ?? false
  }

  bind(registration: RpcRegistration<RpcTypes.Definition>) {
    this.#registration = registration
  }

  unbind() {
    this.#registration = undefined
  }

  /** A process-wide event; only the leader instance sends it. Resolves `false` when skipped or dropped. */
  global<N extends GlobalEvent | "alert">(name: N, body: RpcTypes.EventBody<N>) {
    if (!this.#isLeader() || this.#remote) return Promise.resolve(false)
    return this.#emit(name, body, "global")
  }

  /** A session event, sent by the instance that owns the session's Location. */
  session<N extends SessionEvent>(name: N, body: RpcTypes.EventBody<N>) {
    return this.#emit(name, body, "session")
  }

  async #emit<N extends RpcTypes.EventName>(name: N, body: RpcTypes.EventBody<N>, origin: "global" | "session") {
    const registration = this.#registration
    if (!registration) {
      this.#log.debug("event_dropped_unbound", { event: name })
      return false
    }
    const payload = { ...body, eventId: OwnID.EventID.create(), origin }
    // SAFETY: `payload` is `EventBody<N>` plus the envelope, i.e. `EventPayload<N>`. TypeScript cannot correlate the
    // generic name with the `[name, data]` union of `Rpc.EventInput`.
    const args = [name, payload] as unknown as Rpc.EventInput<RpcTypes.Definition>
    return registration.events.emit(...args).then(
      () => true,
      (error: unknown) => {
        this.#log.warn("event_emit_failed", { event: name, error })
        return false
      },
    )
  }
}
