// A second subscriber on the service's public event feed (`GET /api/event`, the same SSE stream the UI reads; the
// feed sends every event to every subscriber): counts frames and bytes per event type, so the bench can report the
// event volume per streaming session. Bytes are the UTF-8 size of the SSE frame on the wire.

export interface EventCounts {
  readonly frames: number
  readonly bytes: number
  readonly byType: Record<string, { frames: number; bytes: number }>
}

export function startEventCounter(input: { readonly url: string; readonly authorization: string }) {
  const controller = new AbortController()
  const state = { frames: 0, bytes: 0, byType: {} as Record<string, { frames: number; bytes: number }> }
  const encoder = new TextEncoder()
  const done = (async () => {
    const response = await fetch(new URL("/api/event", input.url), {
      headers: { authorization: input.authorization, accept: "text/event-stream" },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`event feed: ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      pending += decoder.decode(chunk.value, { stream: true })
      const frames = pending.split("\n\n")
      pending = frames.pop() ?? ""
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        const bytes = encoder.encode(frame).length + 2
        const type = (() => {
          try {
            return String((JSON.parse(data) as { type?: unknown }).type ?? "unknown")
          } catch {
            return "unparsed"
          }
        })()
        state.frames++
        state.bytes += bytes
        const entry = (state.byType[type] ??= { frames: 0, bytes: 0 })
        entry.frames++
        entry.bytes += bytes
      }
    }
  })().catch((error: unknown) => {
    if (!controller.signal.aborted) throw error
  })
  return {
    /** A copy of the counts so far. */
    snapshot(): EventCounts {
      return {
        frames: state.frames,
        bytes: state.bytes,
        byType: Object.fromEntries(Object.entries(state.byType).map(([key, value]) => [key, { ...value }])),
      }
    },
    stop: async () => {
      controller.abort()
      await done.catch(() => undefined)
    },
  }
}

/** Counts between two snapshots, per second over `seconds`, sorted by bytes. */
export function eventRate(before: EventCounts, after: EventCounts, seconds: number) {
  const types = Object.entries(after.byType)
    .map(([type, value]) => {
      const old = before.byType[type] ?? { frames: 0, bytes: 0 }
      return {
        type,
        frames: value.frames - old.frames,
        bytes: value.bytes - old.bytes,
      }
    })
    .filter((item) => item.frames > 0)
    .toSorted((a, b) => b.bytes - a.bytes)
  const frames = after.frames - before.frames
  const bytes = after.bytes - before.bytes
  return {
    seconds: Math.round(seconds * 10) / 10,
    frames,
    bytes,
    framesPerSecond: seconds > 0 ? Math.round((frames / seconds) * 10) / 10 : null,
    kbPerSecond: seconds > 0 ? Math.round((bytes / 1024 / seconds) * 10) / 10 : null,
    meanFrameBytes: frames > 0 ? Math.round(bytes / frames) : null,
    types: types.slice(0, 15),
  }
}
