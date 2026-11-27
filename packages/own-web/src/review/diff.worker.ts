// Review diff worker (03 §20.2 R4): trims large full-context patches to hunks off the main thread. It receives
// patch text only and never calls the API (16.2: authentication lives on the top frame).
import { trimPatch } from "./trim"

export interface TrimRequest {
  readonly id: number
  readonly file: string
  readonly patch: string
  readonly context: number
}

export interface TrimResponse {
  readonly id: number
  readonly patch: string
  readonly trimmed: boolean
}

self.onmessage = (event: MessageEvent<TrimRequest>) => {
  const result = trimPatch(event.data.file, event.data.patch, event.data.context)
  self.postMessage({ id: event.data.id, patch: result.patch, trimmed: result.trimmed } satisfies TrimResponse)
}
