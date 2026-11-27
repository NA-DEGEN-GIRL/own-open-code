// Main-thread side of the find index (03 §19.13): sends only changed texts to the worker, asks queries, and resolves
// each answer by sequence number. The worker is a same-origin module file (CSP, ARCHITECTURE.md §7) that lives while
// the find bar is open. Without Worker support (unit tests) or after a worker error the same search runs inline.
import {
  prepareText,
  searchPrepared,
  type FindDoc,
  type FindRequest,
  type FindResponse,
  type FindResult,
} from "./model"

export interface FindIndex {
  /** Sends the texts that changed since the last sync; false when nothing changed. */
  sync(docs: readonly FindDoc[]): boolean
  query(needle: string): Promise<FindResult>
  dispose(): void
}

export function createFindIndex(): FindIndex {
  const sent = new Map<string, string>()
  let order: readonly string[] = []
  let seq = 0
  let worker: Worker | undefined
  let broken = typeof Worker === "undefined"
  const waiting = new Map<number, { readonly needle: string; readonly resolve: (result: FindResult) => void }>()
  // Inline fallback state (prepared texts), filled only when the worker is not used.
  const inline = new Map<string, string>()

  function post(request: FindRequest) {
    const current = ensure()
    if (current) return current.postMessage(request)
    if (request.type !== "docs") return
    for (const [id, text] of request.upsert) inline.set(id, prepareText(text))
  }

  function ensure() {
    if (worker || broken) return worker
    try {
      const created = new Worker(new URL("./find.worker.ts", import.meta.url), { type: "module" })
      created.onmessage = (event: MessageEvent<FindResponse>) => {
        waiting.get(event.data.seq)?.resolve(event.data)
        waiting.delete(event.data.seq)
      }
      // A worker that cannot start must not leave queries waiting: fall back to searching inline.
      created.onerror = () => {
        broken = true
        worker = undefined
        created.terminate()
        for (const [id, text] of sent) inline.set(id, prepareText(text))
        waiting.forEach((entry) => entry.resolve(searchInline(entry.needle)))
        waiting.clear()
      }
      worker = created
    } catch {
      broken = true
    }
    return worker
  }

  function searchInline(needle: string) {
    return searchPrepared(
      order.map((id) => inline.get(id) ?? ""),
      needle,
    )
  }

  return {
    sync(docs) {
      const upsert: [string, string][] = []
      for (const doc of docs) {
        if (sent.get(doc.id) === doc.text) continue
        sent.set(doc.id, doc.text)
        upsert.push([doc.id, doc.text])
      }
      const next = docs.map((doc) => doc.id)
      const moved = next.length !== order.length || next.some((id, index) => id !== order[index])
      if (!upsert.length && !moved) return false
      order = next
      if (sent.size > next.length) {
        const keep = new Set(next)
        for (const id of sent.keys()) if (!keep.has(id)) sent.delete(id)
      }
      post({ type: "docs", upsert, order: next })
      return true
    },
    query(needle) {
      const id = ++seq
      const current = ensure()
      if (!current) return Promise.resolve(searchInline(needle))
      return new Promise((resolve) => {
        waiting.set(id, { needle, resolve })
        current.postMessage({ type: "query", seq: id, needle } satisfies FindRequest)
      })
    },
    dispose() {
      worker?.terminate()
      worker = undefined
      waiting.clear()
      sent.clear()
      inline.clear()
    },
  }
}
