export * as Events from "./events.js"

import type { Deps } from "./deps.js"
import { Location } from "./location.js"
import type { Module } from "./module.js"
import { Modules } from "./modules.js"
import { Resets } from "./resets.js"

/** An event handler of a part that is no module (`start`'s `extra`). */
export interface Handler {
  readonly name: string
  readonly onEvent: NonNullable<Module.Lifecycle["onEvent"]>
}

/** Delay before resubscribing after the volatile event stream failed (slow consumer, server restart). */
export const RETRY_MS = 1_000

/** Sessions whose Location this instance remembers (oldest forgotten first). */
export const MAX_SESSIONS = 20_000

/**
 * The event's session and the directory it names: the envelope `location`, else `session.created`'s own
 * `data.location`. Exported for tests.
 */
export function placeOf(event: Module.OpenCodeEvent) {
  const data: unknown = "data" in event ? event.data : undefined
  const sessionID =
    typeof data === "object" && data !== null && "sessionID" in data && typeof data.sessionID === "string"
      ? data.sessionID
      : undefined
  const envelope = "location" in event ? event.location?.directory : undefined
  const directory = envelope ?? (event.type === "session.created" ? event.data.location.directory : undefined)
  return { sessionID, directory }
}

/**
 * Session → "belongs to this Location", per instance. Learned from located events by the dispatcher and from session
 * lookups by modules (`ctx.session.get` names the Location, e.g. after a restart before any event). Events published
 * through the plugin host (`ctx.session.switchModel` → `session.model.selected`) carry no location envelope; they
 * inherit the session's known Location instead of counting as foreign, so every module sees its own plugin-applied
 * switches through `meta.local` alone.
 */
export class Places {
  readonly #local = new Map<string, boolean>()
  readonly #max: number

  constructor(max = MAX_SESSIONS) {
    this.#max = max
  }

  learn(sessionID: string, local: boolean) {
    this.#local.delete(sessionID)
    this.#local.set(sessionID, local)
    if (this.#local.size <= this.#max) return
    const oldest = this.#local.keys().next().value
    if (oldest !== undefined) this.#local.delete(oldest)
  }

  /** `true`/`false` once known, `undefined` for a session this instance never placed. */
  get(sessionID: string) {
    return this.#local.get(sessionID)
  }

  forget(sessionID: string) {
    this.#local.delete(sessionID)
  }

  /**
   * `meta.local` of one event, learning from it: a located event decides by its directory, a location-less one by
   * the session's known place.
   */
  observe(event: Module.OpenCodeEvent, directory: string) {
    const place = placeOf(event)
    const local =
      place.directory !== undefined
        ? Location.same(place.directory, directory)
        : place.sessionID !== undefined && this.#local.get(place.sessionID) === true
    if (place.sessionID !== undefined && place.directory !== undefined) this.learn(place.sessionID, local)
    return { sessionID: place.sessionID, local }
  }
}

/**
 * The single `ctx.event.subscribe` loop of this instance (02 §4.1). Events arrive from every Location; each goes to
 * the modules' `onEvent` in {@link Modules.EVENT_ORDER} with `local` telling whether it belongs to this Location
 * ({@link Places.observe}). A handler error is logged and skipped. Handlers must stay quick: the shared stream fails
 * a consumer that falls 4096 events behind, after which this loop resubscribes (events in between are lost); the
 * modules' `onResubscribe` runs before the first event of the new subscription. `extra` handlers of parts that are no
 * module (the GitHub connection) run after the modules'. Returns the stop function for plugin cleanup.
 */
export function start(deps: Deps, modules: Modules.All, extra: ReadonlyArray<Handler> = []) {
  const log = deps.log.child("events")
  const controller = new AbortController()
  const signal = controller.signal
  const handlers = [
    ...Modules.EVENT_ORDER.flatMap((name) => {
      const onEvent = modules[name].onEvent
      return onEvent ? [{ name, onEvent }] : []
    }),
    ...extra,
  ]
  const resubscribed = () =>
    Modules.EVENT_ORDER.forEach((name) => {
      const onResubscribe = modules[name].onResubscribe
      if (!onResubscribe) return
      try {
        onResubscribe()
      } catch (error) {
        log.error("resubscribe_handler_failed", { module: name, error })
      }
    })

  const resets = new Resets.Tracker(Resets.contextLookup((sessionID) => deps.ctx.session.context({ sessionID })))

  const dispatch = async (event: Module.OpenCodeEvent) => {
    const observed = deps.places.observe(event, deps.location.directory)
    const reset = observed.local ? await resets.observe(event) : undefined
    const meta = { local: observed.local, ...(reset === undefined ? {} : { reset }) }
    for (const handler of handlers)
      await Promise.resolve()
        .then(() => handler.onEvent(event, meta))
        .catch((error: unknown) => log.error("event_handler_failed", { module: handler.name, type: event.type, error }))
    if (event.type === "session.deleted" && observed.sessionID !== undefined) deps.places.forget(observed.sessionID)
  }

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const cancel = deps.clock.schedule(ms, resolve)
      signal.addEventListener(
        "abort",
        () => {
          cancel()
          resolve()
        },
        { once: true },
      )
    })

  const loop = async () => {
    for (let subscription = 0; !signal.aborted; subscription++) {
      // The first event shows the new subscription is live: what the modules read back from then on is not older.
      const first = { pending: subscription > 0 }
      await (async () => {
        for await (const event of deps.ctx.event.subscribe({ signal })) {
          if (first.pending) resubscribed()
          first.pending = false
          await dispatch(event)
        }
      })().catch((error: unknown) => {
        if (!signal.aborted) log.warn("event_stream_failed", { error })
      })
      if (!signal.aborted) await pause(RETRY_MS)
    }
  }
  const done = loop()

  return async () => {
    controller.abort()
    await done
  }
}
