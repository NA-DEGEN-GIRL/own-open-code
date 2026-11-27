// Find-in-session search index (03 §19.13, §20.2 R4): the session's texts, prepared once (NFC, lower case), searched
// off the main thread on every query so typing in the find bar stays within PF2 on long transcripts. It receives text
// only and never calls the API.
import { prepareText, searchPrepared, type FindRequest, type FindResponse } from "./model"

const prepared = new Map<string, string>()
let order: readonly string[] = []

self.onmessage = (event: MessageEvent<FindRequest>) => {
  const request = event.data
  if (request.type === "docs") {
    for (const [id, text] of request.upsert) prepared.set(id, prepareText(text))
    order = request.order
    if (prepared.size > order.length) {
      const keep = new Set(order)
      for (const id of prepared.keys()) if (!keep.has(id)) prepared.delete(id)
    }
    return
  }
  const result = searchPrepared(
    order.map((id) => prepared.get(id) ?? ""),
    request.needle,
  )
  self.postMessage({ type: "result", seq: request.seq, ...result } satisfies FindResponse)
}
