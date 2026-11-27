// Chromium's own memory breakdown of every shell process (memory-infra, what chrome://tracing's "Memory" view shows):
// one explicit detailed dump through the browser's CDP `Tracing` domain, summarized per process into its allocators
// (v8, blink_gc, partition_alloc, malloc, cc, gpu, skia, font_caches, …) and its private footprint. This splits a
// renderer's memory into our JS heap, DOM/layout and Chromium's own caches.

/** The part of a browser-level CDP session the dump uses: Playwright's CDPSession or big-session/raw-cdp.ts. */
export interface TracingSession {
  send(method: string, params?: object): Promise<unknown>
  on(event: string, listener: (payload: { value: unknown[] }) => void): unknown
  off(event: string, listener: (payload: { value: unknown[] }) => void): unknown
  once(event: string, listener: () => void): unknown
}

interface DumpEvent {
  readonly ph: string
  readonly pid: number
  readonly name?: string
  readonly args?: {
    readonly dumps?: {
      readonly allocators?: Record<
        string,
        { readonly attrs?: Record<string, { readonly value?: string; readonly units?: string }> }
      >
      readonly process_totals?: Record<string, string>
    }
  }
}

const MB = 1024 * 1024
const hex = (value: string | undefined) => (value ? Number.parseInt(value, 16) : 0)
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10

/**
 * Detailed memory dump of every process the browser knows (needs a browser-level CDP session). `all` adds every node of
 * at least 0.1 MB per process, for attributing a growth below the summary's levels.
 */
export async function memoryDump(browser: TracingSession, options: { all?: boolean; save?: string } = {}) {
  const events: DumpEvent[] = []
  const collect = (payload: { value: unknown[] }) => events.push(...(payload.value as DumpEvent[]))
  browser.on("Tracing.dataCollected", collect)
  await browser.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: ["disabled-by-default-memory-infra"],
      memoryDumpConfig: { triggers: [] },
    },
  })
  const result = (await browser
    .send("Tracing.requestMemoryDump", { deterministic: true, levelOfDetail: "detailed" })
    .catch((error: unknown) => ({ success: false, error: String(error) }))) as { success?: boolean; error?: string }
  const complete = new Promise<void>((resolve) => browser.once("Tracing.tracingComplete", () => resolve()))
  await browser.send("Tracing.end")
  await complete
  browser.off("Tracing.dataCollected", collect)
  if (options.save) await Bun.write(options.save, JSON.stringify(events))
  // Per process: every allocator node's size. A process may send its dump in more than one event, and not every
  // process emits the root nodes ("v8", "partition_alloc"), so each root's size is the sum of its shallowest nodes.
  const byPid = new Map<number, { totals: Record<string, number>; nodes: Map<string, number> }>()
  for (const event of events.filter((item) => item.ph === "v" && item.args?.dumps)) {
    const dumps = event.args!.dumps!
    const entry = byPid.get(event.pid) ?? { totals: {}, nodes: new Map<string, number>() }
    for (const [key, value] of Object.entries(dumps.process_totals ?? {})) entry.totals[key] = mb(hex(value))
    for (const [name, node] of Object.entries(dumps.allocators ?? {})) {
      const size = hex(node.attrs?.effective_size?.value ?? node.attrs?.size?.value)
      if (size) entry.nodes.set(name, size)
    }
    byPid.set(event.pid, entry)
  }
  return {
    success: result.success ?? false,
    ...(result.error ? { error: result.error } : {}),
    processes: [...byPid.entries()].map(([pid, entry]) => {
      const named = [...entry.nodes.entries()].map(([name, size]) => ({ parts: name.split("/"), name, size }))
      const roots = [...new Set(named.map((item) => item.parts[0]!))]
      const allocators: Record<string, number> = {}
      const detail: Record<string, number> = {}
      for (const root of roots) {
        const under = named.filter((item) => item.parts[0] === root)
        const depth = Math.min(...under.map((item) => item.parts.length))
        allocators[root] = mb(
          under.filter((item) => item.parts.length === depth).reduce((sum, item) => sum + item.size, 0),
        )
        // One level below the shallowest nodes, for the allocators that matter here.
        if (!["v8", "partition_alloc", "blink_gc", "malloc", "cc", "gpu", "skia", "font_caches"].includes(root))
          continue
        for (const item of under.filter(
          (node) => node.parts.length === depth + 1 || (root === "partition_alloc" && node.parts.length === depth + 2),
        ))
          if (item.size >= MB) detail[item.name] = mb(item.size)
      }
      return {
        pid,
        totals: entry.totals,
        allocators: Object.fromEntries(Object.entries(allocators).toSorted((a, b) => b[1] - a[1])),
        detail: Object.fromEntries(Object.entries(detail).toSorted((a, b) => b[1] - a[1])),
        ...(options.all
          ? {
              nodes: Object.fromEntries(
                named.filter((item) => item.size >= MB / 10).map((item) => [item.name, mb(item.size)]),
              ),
            }
          : {}),
      }
    }),
  }
}
