// One event bus per server. `createClientConnection` already groups SSE frames (flushInterval 16); the bus then
// aligns delivery to animation frames so every store write of a frame happens in one Solid batch right before paint
// (03 §20.2 R3). Consumers: createData (session-ui data), OwnStore, SessionIndex.
import type { OpenCodeEvent } from "@opencode/client"
import { batch } from "solid-js"
import { createFrameBatcher } from "./frame"

export type EventType = OpenCodeEvent["type"]
/** Same shape as createData's event map, so `bus.on` plugs into it directly. */
type EventMap = { [Type in EventType]: Extract<OpenCodeEvent, { type: Type }> }
export type EventOf<Type extends EventType> = EventMap[Type]
type Handler = (event: OpenCodeEvent) => void

export interface EventBus {
  on<Type extends EventType>(type: Type, handler: (event: EventOf<Type>) => void): () => void
  listen(handler: (event: OpenCodeEvent) => void): () => void
  /** Queues events for the next frame. */
  publish(event: OpenCodeEvent): void
  /** Delivers queued events now (tests, teardown). */
  flush(): void
  dispose(): void
}

export function createEventBus(): EventBus {
  const typed = new Map<string, Set<Handler>>()
  const all = new Set<Handler>()
  const deliver = (events: OpenCodeEvent[]) =>
    batch(() => {
      for (const event of events) {
        typed.get(event.type)?.forEach((handler) => call(handler, event))
        all.forEach((handler) => call(handler, event))
      }
    })
  const frames = createFrameBatcher(deliver)
  return {
    on(type, handler) {
      const set = typed.get(type) ?? new Set<Handler>()
      typed.set(type, set)
      // SAFETY: handlers in `set` are only invoked with events whose `type` is `type`.
      const erased = handler as Handler
      set.add(erased)
      return () => set.delete(erased)
    },
    listen(handler) {
      all.add(handler)
      return () => all.delete(handler)
    },
    publish: (event) => frames.push(event),
    flush: () => frames.flush(),
    dispose() {
      frames.dispose()
      typed.clear()
      all.clear()
    },
  }
}

/** A throwing consumer must not starve the others or drop the rest of the frame. */
function call(handler: Handler, event: OpenCodeEvent) {
  try {
    handler(event)
  } catch (error) {
    console.error("[own-web] event handler failed", event.type, error)
  }
}
