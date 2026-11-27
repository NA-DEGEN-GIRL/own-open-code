export * as Intake from "./intake.js"

import type { Plugin } from "@opencode/plugin"
import type { Hub } from "./hub.js"
import type { Log } from "./log.js"

/**
 * Core events reach own.team through each Location instance's own `ctx.event.subscribe` (an instance only sees its
 * Location, 06 §5.5). Every instance forwards what the team features use to the controller's hub; an event several
 * instances see (global events) is forwarded once, by its id. Streaming deltas and UI events are dropped here.
 *
 * RH-20: a stream that ends or throws (a closed connection, an event the adapter could not encode) is read again after
 * {@link RETRY_MS}, doubling up to {@link RETRY_MAX_MS}, for as long as the instance lives; a normal end counts as one
 * too, since nothing else would read that Location's events. After each new subscription `restarted` runs (the
 * controller's resume: catch-up of reports and the outboxes' drain cover what the gap missed), and `status` follows
 * it for `health`.
 */

/** Event type prefixes own.team never needs (token streams, tool progress, UI). */
const IGNORED = [
  "session.text.",
  "session.reasoning.",
  "session.tool.",
  "session.step.",
  "session.usage.",
  "session.compaction.",
  "session.message.content.",
  "session.viewed",
  "tui.",
  "filesystem.changed",
  "server.connected",
  "models-dev.",
  "installation.",
]

/** The first wait before a stream that ended is read again; it doubles up to {@link RETRY_MAX_MS}. */
export const RETRY_MS = 1_000
export const RETRY_MAX_MS = 30_000
/** A stream that read this long before it ended starts the waits over. */
const HEALTHY_MS = 60_000

export function relevant(type: string) {
  return !IGNORED.some((prefix) => type.startsWith(prefix))
}

/** The ids of recently forwarded events (bounded): an event seen by several instances is forwarded once. */
export class Dedup {
  readonly #size: number
  readonly #seen = new Set<string>()

  constructor(size = 4_096) {
    this.#size = size
  }

  /** `true` the first time `id` is seen. */
  first(id: string) {
    if (this.#seen.has(id)) return false
    this.#seen.add(id)
    if (this.#seen.size > this.#size) {
      const oldest = this.#seen.values().next().value
      if (oldest !== undefined) this.#seen.delete(oldest)
    }
    return true
  }
}

export interface Status {
  readonly state: "reading" | "restarting"
  readonly restarts: number
}

/**
 * Reads this instance's event stream until the returned stop function runs. `local` sees every relevant event of the
 * instance before the deduplication (an instance's own bookkeeping, such as moving its late agent transform after
 * `plugin.updated`).
 */
export function start(input: {
  readonly ctx: Pick<Plugin.Context, "event">
  readonly hub: Hub.Bus
  readonly dedup: Dedup
  readonly log: Log.Logger
  readonly local?: (event: Hub.Incoming) => void
  /** After a stream was subscribed again (not the first time). */
  readonly restarted?: () => void
  readonly status?: (status: Status) => void
}) {
  const controller = new AbortController()
  const signal = controller.signal
  const read = async () => {
    for await (const event of input.ctx.event.subscribe({ signal })) {
      if (signal.aborted) return
      if (!relevant(event.type)) continue
      input.local?.(event)
      if (input.dedup.first(event.id)) input.hub.receive(event)
    }
  }
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  const loop = async (restarts: number, delay: number): Promise<void> => {
    if (signal.aborted) return
    input.status?.({ state: "reading", restarts })
    if (restarts > 0) {
      input.log.info("event_stream_restarted", { restarts })
      input.restarted?.()
    }
    const began = Date.now()
    const ended = await read().then(
      () => undefined,
      (error: unknown) => error,
    )
    if (signal.aborted) return
    input.log.warn(ended === undefined ? "event_stream_ended" : "event_stream_failed", {
      restarts,
      ...(ended === undefined ? {} : { error: ended }),
    })
    input.status?.({ state: "restarting", restarts })
    const next = Date.now() - began >= HEALTHY_MS ? RETRY_MS : delay
    await wait(next)
    return loop(restarts + 1, Math.min(next * 2, RETRY_MAX_MS))
  }
  void loop(0, RETRY_MS).catch((error: unknown) => input.log.warn("event_stream_loop_failed", { error }))
  return () => controller.abort()
}
