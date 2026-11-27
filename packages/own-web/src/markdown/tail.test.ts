import { describe, expect, test } from "bun:test"
import { project, type Block, type Projection } from "../../../session-ui/src/components/markdown-stream"
import { BENCH, chunks, CORPUS } from "./corpus"
import { createTailProjector } from "./tail"

/** Streams `text` through a projector chunk by chunk, applying each delta like the main thread does. */
function replay(text: string, seed: number, max?: number) {
  const projector = createTailProjector()
  let blocks: Block[] = []
  let shown = ""
  const steps: { text: string; blocks: Block[]; from: number }[] = []
  for (const chunk of chunks(text, seed, max)) {
    shown += chunk
    const delta = projector.project("k", shown, true)
    blocks = [...blocks.slice(0, delta.from), ...delta.blocks]
    steps.push({ text: shown, blocks, from: delta.from })
  }
  const end = projector.project("k", shown, false)
  blocks = [...blocks.slice(0, end.from), ...end.blocks]
  return { steps, final: blocks, finalFrom: end.from }
}

/** Upstream's worker over the same chunks: every block of its projection at each step, then the settled end. */
function upstream(text: string, seed: number, max?: number) {
  let previous: Projection | undefined
  let shown = ""
  const steps: Block[][] = []
  for (const chunk of chunks(text, seed, max)) {
    shown += chunk
    previous = project(previous, shown, true)
    steps.push(previous.blocks)
  }
  return { steps, final: project(previous, shown, false).blocks }
}

describe("tail projector", () => {
  for (const [name, text] of Object.entries({ ...CORPUS, bench: BENCH })) {
    test(`${name}: every step equals upstream's patchmark projection, and the end its settled blocks`, () => {
      for (const seed of [1, 7, 42, 1234]) {
        const max = name === "bench" ? 40 : 12
        const run = replay(text, seed, max)
        const reference = upstream(text, seed, max)
        run.steps.forEach((step, index) => expect(step.blocks).toEqual(reference.steps[index]!))
        expect(run.final).toEqual(reference.final)
        // Settled: no block is still live and every fence is complete.
        expect(run.final.filter((block) => block.mode === "live")).toEqual([])
        expect(run.final.filter((block) => block.mode === "code" && !block.complete)).toEqual([])
      }
    })
  }

  test("only what changed is sent: settled blocks before the growing one are not sent again", () => {
    const projector = createTailProjector()
    const first = projector.project("k", "# a\n\nb para\n\nc", true)
    expect(first.from).toBe(0)
    const second = projector.project("k", "# a\n\nb para\n\nc more", true)
    expect(second.from).toBe(2)
    expect(second.blocks.map((block) => [block.raw, block.mode])).toEqual([["c more", "live"]])
    const third = projector.project("k", "# a\n\nb para\n\nc more\n\n- d", true)
    expect(third.from).toBe(2)
    expect(third.blocks.map((block) => block.mode)).toEqual(["full", "live"])
  })

  test("a still-open fence grows as one code block", () => {
    const projector = createTailProjector()
    projector.project("k", "x\n\n```ts\nconst", true)
    const grown = projector.project("k", "x\n\n```ts\nconst a = 1", true)
    expect(grown.from).toBe(1)
    expect(grown.blocks).toEqual([{ raw: "```ts\nconst a = 1", src: "const a = 1", mode: "code", language: "ts" }])
  })

  test("a reference definition reaches a block already settled: it is sent again with the definition", () => {
    const projector = createTailProjector()
    projector.project("k", "see [x][r]\n\nmore", true)
    const delta = projector.project("k", "see [x][r]\n\nmore\n\n[r]: https://e.com\n\nend", true)
    expect(delta.from).toBe(0)
    expect(delta.blocks[0]?.raw).toBe("see [x][r]\n\n")
    expect(delta.blocks[0]?.src).toContain("[r]: https://e.com")
  })

  test("a text that does not extend the previous one starts over", () => {
    const projector = createTailProjector()
    projector.project("k", "a\n\nb", true)
    expect(projector.project("k", "x\n\ny", true).from).toBe(0)
    projector.dispose("k")
    expect(projector.project("k", "x\n\ny z", true).from).toBe(0)
  })
})
