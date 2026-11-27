// The incremental streaming render against a one-shot render of the final text (01 §6.6 PF4): the real tail projector,
// the real DOM writes of own-web's session-ui `Markdown` (commitMarkdownBlocks) and upstream's markdown parser. The
// worker boundary is in-process here, with a fixed highlighter (shiki stays in the worker); copy buttons are plain
// hosts and HTML is not sanitized, since Solid components do not render under bun test and DOMPurify misreads
// happy-dom's parser (it drops paragraphs). The Edge e2e (e2e/transcript.spec.ts) runs the real pipeline.
// Every dependency here answers in promises, never a timer, so after one macrotask (`setImmediate`) all the renderer's
// work for a chunk is done: the test waits for that, not for the clock. It used to poll with `Bun.sleep(0)` until three
// sleeps in a row found no frame, about 480 sleeps per test; on a loaded PC each one waited 5-10 ms for the OS to run
// the process again, most of the test's time, and the longest tests passed 5 s.
import { describe, expect, test } from "bun:test"
import { createMarkdownParser } from "@opencode/ui/context/marked-parser"
import { checksum } from "@opencode/util/encode"
import { markdownBlockKey } from "../../../session-ui/src/components/markdown-worker-protocol"
import { commitMarkdownBlocks, createStreamView } from "@/vendor/session-ui/markdown"
import { BENCH, chunks, CORPUS } from "./corpus"
import { createStreamRenderer, type StreamDeps } from "./stream"
import { createTailProjector } from "./tail"

// Upstream highlights with @pierre/highlights inside the parser since v2.1 (c2736fc9fa); no highlighter is passed.
const parser = createMarkdownParser()
/**
 * The render context, with its own count of the copy buttons it made: each one inserted is an element with a
 * data-slot, which @opencode/ui's :has() rules restyle for. One per render, so no answer counts another's buttons.
 */
function renderContext() {
  const copyButtons = { made: 0 }
  return {
    copyButtons,
    labels: { copy: "복사", copied: "복사됨" },
    sessionLinks: true,
    copyButton: () => {
      copyButtons.made++
      const host = document.createElement("div")
      host.setAttribute("data-slot", "markdown-copy-button")
      return host
    },
  }
}

// Hashed by its source, as markdown-cache does: a later reference definition changes a settled block's source only.
async function parse(block: { raw: string; src: string }) {
  return { raw: block.raw, hash: checksum(block.src) ?? "", html: await parser.parse(block.src) }
}

let run = 0

/** Streams `text` into a container chunk by chunk; checks after every frame that unchanged blocks were not rewritten. */
async function streamInto(text: string, seed: number, max: number) {
  const id = `t${++run}`
  const context = renderContext()
  const container = document.createElement("div")
  document.body.append(container)
  const frames: (() => void)[] = []
  const projector = createTailProjector()
  const deps: StreamDeps = {
    project: async (key, value, live) => projector.project(key, value, live),
    markdown: (block) => parse(block),
    code: async (_key, value, language) => ({
      language: language ?? "text",
      generation: 1,
      stable: [],
      unstable: [[value, "color:#5a8"]],
    }),
    disposeCode: () => undefined,
    frame: (callback) => void frames.push(callback),
    blockKey: (index, mode) => markdownBlockKey(id, id, index, mode),
    cacheKey: (index, mode) => `${id}:${index}:${mode}`,
  }
  let ready = false
  let streaming = true
  // The component's view: blocks in one wrapper while streaming, moved out once the finished answer is ready.
  const view = createStreamView(container, { context: () => context, finished: () => !streaming })
  const stats = { frames: 0, maxWordSpans: 0, maxChanges: 0 }
  // The wrappers seen while streaming: one per answer (the blocks never move out and back in).
  const wrappers = new Set<Element>()
  const renderer = createStreamRenderer({
    key: id,
    deps,
    view: {
      commit: (changes, count) => {
        stats.maxChanges = Math.max(stats.maxChanges, changes.length)
        view.commit(changes, count)
      },
      ready: (value) => {
        ready = value
        view.ready(value)
      },
    },
  })
  // What each finished block looked like when first written, by its key and hash.
  const written = new Map<string, { element: HTMLElement; html: string }>()
  // Runs the frames the renderer asks for until its work is done and no frame is left; then it shows the latest text.
  const settle = async () => {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve))
      const due = frames.splice(0)
      if (!due.length) {
        expect(ready).toBe(true)
        return
      }
      due.forEach((frame) => frame())
      stats.frames += due.length
      // While streaming the container holds only the wrapper, whatever is added (the container's last child stays).
      if (streaming) {
        expect(Array.from(container.children).map((child) => child.hasAttribute("data-markdown-stream"))).toEqual([
          true,
        ])
        wrappers.add(container.firstElementChild!)
      }
      for (const element of Array.from(container.querySelectorAll<HTMLElement>("[data-markdown-block]"))) {
        if (!(element instanceof HTMLElement) || element.dataset.markdownMode !== "full") continue
        const id = `${element.dataset.markdownKey}#${element.dataset.markdownHash}`
        const seen = written.get(id)
        if (!seen) written.set(id, { element, html: element.innerHTML })
        else {
          expect(element).toBe(seen.element)
          expect(element.innerHTML).toBe(seen.html)
        }
      }
      stats.maxWordSpans = Math.max(stats.maxWordSpans, container.querySelectorAll("[data-markdown-word]").length)
    }
  }
  let shown = ""
  for (const chunk of chunks(text, seed, max)) {
    shown += chunk
    renderer.update(shown, true)
    await settle()
  }
  streaming = false
  renderer.update(shown, false)
  await settle()
  // Finished: no wrapper and no end marks are left.
  expect(
    container.querySelectorAll("[data-markdown-stream], [data-markdown-first], [data-markdown-last]"),
  ).toHaveLength(0)
  expect(wrappers.size).toBe(1)
  renderer.dispose()
  // Out of the shared document: the files that run after this one see none of it.
  container.remove()
  return { container, ready, stats, copyButtons: context.copyButtons.made }
}

/** The answer as one block, the way the component renders an answer that never streamed. */
async function once(text: string) {
  const container = document.createElement("div")
  const entry = await parse({ raw: text, src: text })
  commitMarkdownBlocks(container, [{ index: 0, block: { key: "once", mode: "full", ...entry } }], 1, renderContext())
  return container
}

/** The answer's content: block wrappers (display: contents bookkeeping) dropped, copy buttons' insides left out. */
function content(container: Element) {
  const copy = container.cloneNode(true) as Element
  copy.querySelectorAll('[data-slot="markdown-copy-button"]').forEach((button) => button.replaceChildren())
  return Array.from(copy.children)
    .map((block) => block.innerHTML)
    .join("")
}

describe("incremental streaming render", () => {
  for (const [name, text] of Object.entries({ ...CORPUS, bench: BENCH })) {
    test(`${name}: the streamed answer ends exactly as a one-shot render`, async () => {
      for (const seed of [3, 11]) {
        const streamed = await streamInto(text, seed, name === "bench" ? 60 : 9)
        // One copy button per fence: a streamed fence that finishes keeps the one it had.
        expect(streamed.copyButtons).toBe(
          streamed.container.querySelectorAll('[data-slot="markdown-copy-button"]').length,
        )
        expect(streamed.ready).toBe(true)
        expect(content(streamed.container)).toBe(content(await once(text)))
        // No word spans: only the newest text of the live block fades in, and nothing is left at the end.
        expect(streamed.container.querySelectorAll("[data-markdown-word]")).toHaveLength(0)
        expect(streamed.stats.maxWordSpans).toBeLessThan(40)
        // A frame writes the blocks that changed, not the answer: a chunk of at most 60 characters touches a few.
        expect(streamed.stats.maxChanges).toBeLessThanOrEqual(4)
      }
    })
  }

  test("code blocks, lists, tables and Korean text keep their structure", async () => {
    const text = [CORPUS.korean, CORPUS.lists, CORPUS.tables, CORPUS.code].join("\n\n")
    const streamed = await streamInto(text, 5, 15)
    const html = content(streamed.container)
    expect(html).toBe(content(await once(text)))
    expect(streamed.container.querySelectorAll('[data-component="markdown-code"]').length).toBe(6)
    expect(streamed.container.querySelectorAll("table")).toHaveLength(2)
    // Upstream's markdown.css scrolls a table inside its `markdown-table` frame (upstream v2.2).
    expect(streamed.container.querySelectorAll('[data-component="markdown-table"] > table')).toHaveLength(2)
    expect(streamed.container.querySelectorAll("ol > li, ul > li").length).toBeGreaterThan(8)
    expect(html).toContain("<strong>프레임마다 한 번만</strong>")
    expect(html).toContain('<code class="language-python">')
  })
})
