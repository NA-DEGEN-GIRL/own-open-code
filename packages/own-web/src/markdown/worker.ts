/// <reference lib="webworker" />
// own-web's tail worker (vendor/session-ui/markdown-worker.ts `projectMarkdownTail`): the incremental block projection
// of ./tail.ts, keyed per answer. Since v2.2.6 upstream's markdown worker (parse, highlight, project) runs alone under
// session-ui's worker state machine, which owns its lifecycle and every response, so `tail` has a worker of its own.
import { createTailProjector, type TailDelta } from "./tail"

export type TailRequest = { type: "tail"; id: number; key: string; text: string; live: boolean }
export type TailResponse =
  | { type: "tail"; id: number; key: string; delta: TailDelta }
  | { type: "tail-error"; id: number; key: string; message: string }

const tails = createTailProjector()

self.onmessage = (event: MessageEvent<TailRequest | { type: "dispose"; key: string }>) => {
  const data = event.data
  if (data.type === "dispose") {
    tails.dispose(data.key)
    return
  }
  try {
    self.postMessage({
      type: "tail",
      id: data.id,
      key: data.key,
      delta: tails.project(data.key, data.text, data.live),
    } satisfies TailResponse)
  } catch (error) {
    tails.dispose(data.key)
    self.postMessage({
      type: "tail-error",
      id: data.id,
      key: data.key,
      message: error instanceof Error ? error.message : String(error),
    } satisfies TailResponse)
  }
}
