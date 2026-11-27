// Records the server's public event stream (`GET /api/event`, SSE) for assertions on `rpc.own.accounts.*` events.
// The stream is volatile by contract: subscribe before the actions whose events a test wants to see.

import type { OpencodeServer } from "./opencode-server"

export interface ServerEvent {
  readonly id?: string
  readonly type: string
  readonly location?: { readonly directory?: string }
  readonly data: Record<string, unknown>
}

export interface EventRecorder {
  /** Every event received so far, oldest first. */
  readonly events: readonly ServerEvent[]
  /** `rpc.own.accounts.<name>` events so far, oldest first. */
  own(name: string): readonly ServerEvent[]
  /** Resolves with the first recorded event (past or future) that matches. */
  waitFor(match: (event: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>
  /** Every raw SSE `data:` payload received, for secret scans. */
  text(): string
  close(): Promise<void>
}

/** Subscribes to `/api/event` and resolves once `server.connected` arrived, so later events are not missed. */
export async function recordServerEvents(server: OpencodeServer, timeoutMs = 30_000): Promise<EventRecorder> {
  const controller = new AbortController()
  const response = await fetch(new URL("/api/event", server.url), {
    headers: { authorization: server.authorization, accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`GET /api/event failed with ${response.status}`)
  const events: ServerEvent[] = []
  const raw: string[] = []
  const waiters = new Set<{
    readonly match: (event: ServerEvent) => boolean
    readonly resolve: (e: ServerEvent) => void
  }>()

  const accept = (payload: string) => {
    raw.push(payload)
    const parsed: unknown = JSON.parse(payload)
    if (!isRecord(parsed) || typeof parsed.type !== "string") return
    const event: ServerEvent = {
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      type: parsed.type,
      ...(isRecord(parsed.location) ? { location: parsed.location } : {}),
      data: isRecord(parsed.data) ? parsed.data : {},
    }
    events.push(event)
    for (const waiter of [...waiters])
      if (waiter.match(event)) {
        waiters.delete(waiter)
        waiter.resolve(event)
      }
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const pump = (async () => {
    const buffer = { text: "" }
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer.text += chunk.value.replaceAll("\r\n", "\n")
      const blocks = buffer.text.split("\n\n")
      buffer.text = blocks.pop() ?? ""
      for (const block of blocks) {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data !== "") accept(data)
      }
    }
  })().catch(() => undefined)

  const waitFor = (match: (event: ServerEvent) => boolean, waitMs = 30_000) => {
    const found = events.find(match)
    if (found) return Promise.resolve(found)
    return new Promise<ServerEvent>((resolve, reject) => {
      const waiter = { match, resolve }
      waiters.add(waiter)
      setTimeout(() => {
        if (!waiters.delete(waiter)) return
        reject(new Error(`event not received within ${waitMs} ms (${events.length} events recorded)`))
      }, waitMs)
    })
  }

  await waitFor((event) => event.type === "server.connected", timeoutMs)
  return {
    events,
    own: (name) => events.filter((event) => event.type === `rpc.own.accounts.${name}`),
    waitFor,
    text: () => raw.join("\n"),
    close: async () => {
      controller.abort()
      await reader.cancel().catch(() => undefined)
      await pump
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
