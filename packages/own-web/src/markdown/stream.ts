// The streaming path of the transcript's markdown (session-ui `Markdown`, own-web's substitute in
// vendor/session-ui/markdown.tsx): 01 §6.6 PF2/PF4, 03 §20.2 R3. Upstream, every update of a streaming answer
// re-projected the whole text, mapped every block through an async render, walked every block's DOM and scanned the
// whole answer three times, so the cost of one update grew with the answer (own/reports/ui-perf-many-sessions-2026-10.md
// cause 4). Here an update costs what changed:
//  - the worker re-lexes only the tail and answers with the blocks from the first changed one (./tail.ts);
//  - only those blocks are rendered; a finished block is rendered once in its final form and then left alone
//    (its DOM keyed by index, mode and content hash);
//  - the DOM is written at most once per animation frame, in block order, and only where a block changed;
//  - at the end the answer equals a one-shot render of the final text (stream.test.tsx).
import { abort } from "@opencode/util/abort"
import type { Block } from "../../../session-ui/src/components/markdown-stream"
import type { MarkdownToken } from "../../../session-ui/src/components/markdown-worker-protocol"
import type { TailDelta } from "./tail"

export type MarkdownEntry = { readonly raw: string; readonly hash: string; readonly html: string }

export type CodeTokens = {
  readonly language: string
  readonly generation: number
  readonly stable: MarkdownToken[]
  readonly unstable: MarkdownToken[]
}

/** A block ready for the DOM, in the shape of session-ui markdown.tsx's `RenderedBlock`. */
export type RenderedStreamBlock =
  | (MarkdownEntry & { readonly key: string; readonly mode: "full" | "live" })
  | (CodeTokens & {
      readonly key: string
      readonly mode: "code"
      readonly raw: string
      readonly hash: string
      readonly complete: boolean
    })

export type StreamDeps = {
  /** The worker's tail projection (vendor/session-ui/markdown-worker.ts `projectMarkdownTail`). */
  readonly project: (key: string, text: string, live: boolean) => Promise<TailDelta>
  /** A markdown block's sanitized HTML: at once when cached or small, else from the worker (markdown-cache). */
  readonly markdown: (
    block: { readonly raw: string; readonly src: string },
    cacheKey: string | undefined,
    live: boolean,
    signal: AbortSignal,
  ) => MarkdownEntry | Promise<MarkdownEntry>
  /** Tokens of a still-open code block (the worker's streaming highlighter). */
  readonly code: (key: string, text: string, language: string | undefined) => Promise<CodeTokens>
  /** Drops a code block's streaming highlighter state. */
  readonly disposeCode: (key: string) => void
  readonly frame: (callback: () => void) => void
  /** The DOM key of the block at `index` (session-ui `markdownBlockKey`). */
  readonly blockKey: (index: number, mode: string) => string
  /** The markdown cache key of the block at `index` of `text`. */
  readonly cacheKey: (index: number, mode: string, text: string) => string | undefined
}

export type StreamView = {
  /**
   * Writes `changes` (ascending; an index is at most the number of blocks shown before it) and, with `count`,
   * removes the blocks from that index on.
   */
  readonly commit: (
    changes: ReadonlyArray<{ readonly index: number; readonly block: RenderedStreamBlock }>,
    count: number | undefined,
  ) => void
  /** Whether the DOM shows the latest text completely (`data-markdown-ready`). */
  readonly ready: (ready: boolean) => void
}

type Slot = {
  block: Block
  /** The newest render that finished, and the block it rendered (an older one while a newer render runs). */
  rendered?: RenderedStreamBlock
  renderedFor?: Block
  /** What `commit` last wrote at this index. */
  shown?: RenderedStreamBlock
  /** A render runs; `again` asks for one more with the newest block when it ends (one render per block at a time). */
  running?: boolean
  again?: boolean
}

export function createStreamRenderer(input: {
  readonly key: string
  readonly deps: StreamDeps
  readonly view: StreamView
}) {
  const deps = input.deps
  const lifetime = new AbortController()
  const slots: Slot[] = []
  const codeKeys = new Map<number, string>()
  let requested: { text: string; live: boolean } | undefined
  // The request the blocks are from: ready only once the latest one's answer is in (the final, not-live one too).
  let projected: { text: string; live: boolean } | undefined
  let shownCount = 0
  let scheduled = false
  let ready = false
  let disposed = false

  function update(text: string, live: boolean) {
    if (disposed || (requested?.text === text && requested.live === live)) return
    const request = { text, live }
    requested = request
    setReady(false)
    deps.project(input.key, text, live).then(
      (delta) => apply(request, delta),
      () => undefined,
    )
  }

  function apply(request: { text: string; live: boolean }, delta: TailDelta) {
    if (disposed) return
    projected = request
    const count = delta.from + delta.blocks.length
    delta.blocks.forEach((block, offset) => {
      const index = delta.from + offset
      const slot = slots[index]
      if (!slot) {
        slots[index] = { block }
        render(index, slots[index]!)
        return
      }
      if (sameBlock(slot.block, block)) return
      slot.block = block
      render(index, slot)
    })
    for (let index = count; index < slots.length; index++) releaseCode(index)
    slots.length = count
    schedule()
  }

  function render(index: number, slot: Slot) {
    if (slot.running) {
      slot.again = true
      return
    }
    const block = slot.block
    // A finished fence renders like the one-shot answer renders it (the worker's highlighted HTML), so the end of the
    // stream equals a render of the final text; only a fence that is still open streams as tokens.
    if (block.mode === "code" && !block.complete) {
      const key = deps.blockKey(index, "code")
      codeKeys.set(index, key)
      settle(
        index,
        slot,
        block,
        deps.code(key, block.src, block.language).then((tokens) => ({
          key,
          mode: "code" as const,
          raw: block.raw,
          hash: String(block.raw.length),
          complete: false,
          ...tokens,
        })),
      )
      return
    }
    releaseCode(index)
    const mode = block.mode === "live" ? "live" : "full"
    const source = block.mode === "code" ? { raw: block.raw, src: block.raw } : block
    const key = deps.blockKey(index, mode)
    const entry = deps.markdown(source, deps.cacheKey(index, mode, requested?.text ?? ""), mode === "live", lifetime.signal)
    const rendered = (value: MarkdownEntry): RenderedStreamBlock => ({ key, mode, ...value })
    if (!(entry instanceof Promise)) {
      slot.rendered = rendered(entry)
      slot.renderedFor = block
      return
    }
    settle(index, slot, block, entry.then(rendered))
  }

  function settle(index: number, slot: Slot, block: Block, result: Promise<RenderedStreamBlock>) {
    slot.running = true
    const done = () => {
      slot.running = false
      if (disposed || slots[index] !== slot) return false
      if (slot.again) {
        slot.again = false
        render(index, slot)
      }
      schedule()
      return true
    }
    result.then(
      (value) => {
        // Newer than what is shown even when the block moved on meanwhile, so a fast stream still paints.
        slot.rendered = value
        slot.renderedFor = block
        done()
      },
      done,
    )
  }

  function releaseCode(index: number) {
    const key = codeKeys.get(index)
    if (!key) return
    codeKeys.delete(index)
    deps.disposeCode(key)
  }

  function schedule() {
    if (scheduled || disposed) return
    scheduled = true
    deps.frame(commit)
  }

  // One DOM write per frame: the changed blocks in order, up to the first block that has never rendered, so an
  // index always matches the container's child at that place.
  function commit() {
    scheduled = false
    if (disposed) return
    const changes: { index: number; block: RenderedStreamBlock }[] = []
    let complete = true
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!
      const rendered = slot.rendered
      if (!rendered || index > shownCount) {
        complete = false
        if (index >= shownCount) break
        continue
      }
      if (slot.renderedFor !== slot.block || slot.running || slot.again) complete = false
      if (slot.shown === rendered) continue
      changes.push({ index, block: rendered })
      slot.shown = rendered
      shownCount = Math.max(shownCount, index + 1)
    }
    const trim = complete && shownCount > slots.length ? slots.length : undefined
    if (trim !== undefined) shownCount = trim
    if (changes.length || trim !== undefined) input.view.commit(changes, trim)
    setReady(complete && projected === requested)
  }

  function setReady(value: boolean) {
    if (ready === value) return
    ready = value
    input.view.ready(value)
  }

  return {
    update,
    dispose() {
      disposed = true
      abort(lifetime)
      codeKeys.forEach((key) => deps.disposeCode(key))
      codeKeys.clear()
    },
  }
}

// The source too: patchmark adds a later reference definition to the source of a block it already settled.
function sameBlock(a: Block, b: Block) {
  return (
    a.mode === b.mode && a.complete === b.complete && a.language === b.language && a.raw === b.raw && a.src === b.src
  )
}
