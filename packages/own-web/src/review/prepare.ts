// Main-thread side of the review diff worker. Small patches go to the viewer as they are (synchronously, so the
// common case never waits a round trip); patches over LARGE_PATCH_CHARS are trimmed to hunks in the worker. The
// worker is a same-origin module file (CSP, ARCHITECTURE.md §7), created on the first large diff and kept for the
// page's lifetime. Without Worker support (tests) or after a worker error the same code runs inline.
import type { FileDiffInfo } from "@opencode/client"
import type { TrimRequest, TrimResponse } from "./diff.worker"
import { isLarge, TRIM_CONTEXT } from "./model"
import { trimPatch } from "./trim"

export interface PreparedDiff {
  readonly diff: FileDiffInfo
  /** Only hunks with TRIM_CONTEXT lines around each change are shown (no "show all lines"). */
  readonly trimmed: boolean
}

const cache = new WeakMap<FileDiffInfo, Promise<PreparedDiff>>()
const waiting = new Map<number, { readonly request: TrimRequest; readonly resolve: (value: TrimResponse) => void }>()
const pool = { next: 0, worker: undefined as Worker | undefined, broken: false }

export function prepareDiff(diff: FileDiffInfo): PreparedDiff | Promise<PreparedDiff> {
  if (!isLarge(diff)) return { diff, trimmed: false }
  const cached = cache.get(diff)
  if (cached) return cached
  const prepared = trim({ id: pool.next++, file: diff.file, patch: diff.patch, context: TRIM_CONTEXT }).then(
    (response) => ({ diff: response.trimmed ? { ...diff, patch: response.patch } : diff, trimmed: response.trimmed }),
  )
  cache.set(diff, prepared)
  return prepared
}

function trim(request: TrimRequest): Promise<TrimResponse> {
  const worker = ensureWorker()
  if (!worker) return Promise.resolve(inline(request))
  return new Promise((resolve) => {
    waiting.set(request.id, { request, resolve })
    worker.postMessage(request)
  })
}

function ensureWorker() {
  if (pool.worker || pool.broken || typeof Worker === "undefined") return pool.worker
  const worker = new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (event: MessageEvent<TrimResponse>) => {
    waiting.get(event.data.id)?.resolve(event.data)
    waiting.delete(event.data.id)
  }
  // A worker that cannot start (blocked script, old engine) must not leave diffs waiting: trim them inline.
  worker.onerror = () => {
    pool.broken = true
    pool.worker = undefined
    worker.terminate()
    waiting.forEach((entry) => entry.resolve(inline(entry.request)))
    waiting.clear()
  }
  pool.worker = worker
  return worker
}

function inline(request: TrimRequest): TrimResponse {
  const result = trimPatch(request.file, request.patch, request.context)
  return { id: request.id, patch: result.patch, trimmed: result.trimmed }
}
