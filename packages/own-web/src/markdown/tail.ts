// Incremental block projection of a streaming answer (01 §6.6 PF4, 03 §20.2 R3), run in the markdown worker
// (./worker.ts). The blocks are upstream's: since v2.2 (f2735ef79b) session-ui `markdown-stream.ts` `project` runs
// @opencode/patchmark's incremental stream, which keeps its parser state per answer, settles finished blocks and
// hands back the same block objects for the ones that did not change. Upstream's worker still posts every block on
// each update and its component compares them all; here the main thread gets `{from, blocks}`: only the blocks from the
// first one that changed. A finished answer ends as upstream's settled projection, so it renders as upstream renders a
// streamed answer (reference definitions travel with each block's source).
import { project, type Block, type Projection } from "../../../session-ui/src/components/markdown-stream"

export type TailDelta = {
  /** Index of the first block that changed; the blocks before it are the ones the receiver already has. */
  readonly from: number
  /** Every block from `from` to the end. */
  readonly blocks: readonly Block[]
}

export function createTailProjector() {
  const projections = new Map<string, Projection>()
  return {
    project(key: string, text: string, live: boolean): TailDelta {
      const previous = projections.get(key)
      const next = project(previous, text, live)
      projections.set(key, next)
      const from = previous ? firstChange(previous.blocks, next.blocks) : 0
      return { from, blocks: next.blocks.slice(from) }
    },
    dispose(key: string) {
      projections.delete(key)
    },
  }
}

/** First index where the block lists differ; unchanged blocks are the same objects, so only the tail is compared. */
function firstChange(before: readonly Block[], after: readonly Block[]) {
  const length = Math.min(before.length, after.length)
  for (let index = 0; index < length; index++) {
    const a = before[index]!
    const b = after[index]!
    if (a === b) continue
    if (a.raw !== b.raw || a.src !== b.src || a.mode !== b.mode || a.complete !== b.complete || a.language !== b.language)
      return index
  }
  return length
}
