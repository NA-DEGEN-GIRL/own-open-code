// Ports packages/coding-agent/test/read-streaming.test.ts: the streamed text read of src/pi/read.ts against the read
// tool's whole-file text path from before it streamed (Pi #9654), kept here as the reference the new path must match.
// Pi swaps `util`'s TextDecoder to append to a file mid-read and runs the 200 MB case in Node with a 64 MB heap; own
// wraps the stream instead of mocking a module, and has the child report its peak memory (Bun has no heap limit flag).
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf.
import { afterAll, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PiRead } from "../../../src/pi/read.js"
import { PiTruncate } from "../../../src/pi/truncate.js"

const dir = mkdtempSync(path.join(tmpdir(), "own-pi-read-streaming-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The read tool's text path before it streamed, as the reference. */
function referenceRead(text: string, file: string, offset: number | undefined, limit: number | undefined) {
  const allLines = text.split("\n")
  const startLine = offset ? Math.max(0, offset - 1) : 0
  const startLineDisplay = startLine + 1
  if (startLine >= allLines.length)
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`)
  const endLine = limit === undefined ? allLines.length : Math.min(startLine + limit, allLines.length)
  const truncation = PiTruncate.truncateHead(allLines.slice(startLine, endLine).join("\n"))
  const limitText = PiTruncate.formatSize(PiTruncate.DEFAULT_MAX_BYTES)
  if (truncation.firstLineExceedsLimit) {
    const size = PiTruncate.formatSize(Buffer.byteLength(allLines[startLine]!, "utf-8"))
    return {
      text: `[Line ${startLineDisplay} is ${size}, exceeds ${limitText} limit. Use bash: sed -n '${startLineDisplay}p' ${file} | head -c ${PiTruncate.DEFAULT_MAX_BYTES}]`,
      details: { truncation },
    }
  }
  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1
    const by = truncation.truncatedBy === "lines" ? "" : ` (${limitText} limit)`
    return {
      text: `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}${by}. Use offset=${endLineDisplay + 1} to continue.]`,
      details: { truncation },
    }
  }
  if (limit !== undefined && endLine < allLines.length)
    return {
      text: `${truncation.content}\n\n[${allLines.length - endLine} more lines in file. Use offset=${endLine + 1} to continue.]`,
      details: undefined,
    }
  return { text: truncation.content, details: undefined }
}

type Outcome = { text: string; details: unknown } | { error: string }

const FILE = "file.txt"

function referenceOutcome(text: string, offset: number | undefined, limit: number | undefined): Outcome {
  try {
    return referenceRead(text, FILE, offset, limit)
  } catch (error) {
    return { error: (error as Error).message }
  }
}

async function outcome(run: () => ReturnType<typeof PiRead.execute>): Promise<Outcome> {
  try {
    const result = await run()
    const first = result.content[0]!
    return { text: first.type === "text" ? first.text : "", details: result.details }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

/** Splits bytes into chunks of `size`, so characters and lines split at chunk ends. */
async function* chunked(bytes: Buffer, size: number): AsyncIterable<Uint8Array> {
  for (const position of Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => index * size))
    yield bytes.subarray(position, position + size)
}

/** `bytes` on disk (the read checks and sniffs the real file) and read through `stream`. */
function readWith(
  file: string,
  stream: Parameters<typeof PiRead.execute>[2]["stream"],
  offset: number | undefined,
  limit: number | undefined,
) {
  return outcome(() => PiRead.execute({ path: FILE, offset, limit }, file, { vision: true, stream }))
}

function lines(count: number, make: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => make(index)).join("\n")
}

const FIFTY_KB_OF_LINES = `${lines(512, () => "y".repeat(99))}y`

// Inputs around the boundaries the notices and truncation depend on.
const TEXT_CASES: Record<string, string> = {
  empty: "",
  "no trailing newline": "alpha\nbeta\ngamma",
  "trailing newline": "alpha\nbeta\n",
  CRLF: "alpha\r\nbeta\r\n\r\ngamma\r\n",
  "multi-byte characters and UTF-8 byte order mark": "﻿é€😀\nñ\u{10348}字\n😀😀😀",
  "2001 lines": lines(2001, (index) => `line ${index}`),
  // truncateHead drops a trailing empty line: the empty line at the line cap must not end the stored lines.
  "2001 lines, an empty line and more": `${lines(2001, (index) => `line ${index}`)}\n\nmore`,
  "first line over 50KB": `${"é".repeat(PiTruncate.DEFAULT_MAX_BYTES / 2 + 1)}\nsecond`,
  "line over 50KB after short lines": `a\nb\n${"z".repeat(60 * 1024)}\nc`,
  // 50KB + 1 byte: truncated, yet every line fits, so truncateHead reports truncatedBy "lines".
  "exactly 50KB and a trailing newline": `${FIFTY_KB_OF_LINES}\n`,
  "exactly 50KB, an empty line and more": `${FIFTY_KB_OF_LINES}\n\nmore`,
  "multi-byte characters over 50KB": lines(700, (index) => `${index} ${"€😀".repeat(13)}`),
}

describe("read tool streaming", () => {
  test("gives the same output as the whole-file algorithm", async () => {
    for (const [name, text] of Object.entries(TEXT_CASES)) {
      const bytes = Buffer.from(text, "utf-8")
      const file = path.join(dir, `case-${Object.keys(TEXT_CASES).indexOf(name)}.txt`)
      writeFileSync(file, bytes)
      const total = text.split("\n").length
      for (const offset of [undefined, 2, 3, total, total + 1])
        for (const limit of [undefined, 0, 1, total]) {
          const expected = referenceOutcome(text, offset, limit)
          for (const size of [1, 4096]) {
            const label = `${name}, offset ${offset}, limit ${limit}, chunks of ${size}`
            expect(await readWith(file, () => chunked(bytes, size), offset, limit), label).toEqual(expected)
          }
        }
    }
  }, 120_000)

  test("keeps details key order, which session files serialize", async () => {
    const text = TEXT_CASES["2001 lines"]!
    const file = path.join(dir, "order.txt")
    writeFileSync(file, text)
    const streamed = (await readWith(file, () => chunked(Buffer.from(text), 4096), 1, undefined)) as {
      details: unknown
    }
    const expected = referenceOutcome(text, 1, undefined) as { details: unknown }
    expect(JSON.stringify(streamed.details)).toBe(JSON.stringify(expected.details))
  })

  test("decodes multi-byte characters split across chunks and invalid UTF-8 like Buffer.toString", async () => {
    const bytes = Buffer.concat([
      Buffer.from("aé€😀\n😀b\u{10348}\n", "utf-8"),
      Buffer.from([0x61, 0xc3, 0x0a, 0xe2, 0x82, 0x0a, 0xff, 0xfe, 0x80, 0xf0, 0x9f, 0x98, 0x0a, 0xed, 0xa0, 0x80]),
    ])
    const file = path.join(dir, "invalid.txt")
    writeFileSync(file, bytes)
    for (const size of [1, 2, 3])
      expect(await readWith(file, () => chunked(bytes, size), undefined, undefined)).toEqual(
        referenceOutcome(bytes.toString("utf-8"), undefined, undefined),
      )
  })

  test("reads the whole file for fractional or negative ranges", async () => {
    const text = "one\ntwo\nthree\nfour"
    const file = path.join(dir, "ranges.txt")
    writeFileSync(file, text)
    const unused = () => {
      throw new Error("the stream must not be used for this range")
    }
    // Array slicing defines these: limit -1 selects all lines but the last.
    for (const [offset, limit] of [
      [2.5, 1],
      [undefined, -1],
      [1, 1.5],
    ] as const)
      expect(await readWith(file, unused, offset, limit)).toEqual(referenceOutcome(text, offset, limit))
  })

  test("reads local files through the default stream", async () => {
    const file = path.join(dir, "local.txt")
    const text = lines(3000, (index) => `${index} ${"w".repeat(index % 40)}`)
    writeFileSync(file, text)
    for (const [offset, limit] of [
      [undefined, undefined],
      [1500, 10],
    ] as const)
      expect(await readWith(file, undefined, offset, limit)).toEqual(referenceOutcome(text, offset, limit))
    await expect(PiRead.execute({ path: dir }, dir, { vision: true })).rejects.toThrow("EISDIR")
  })

  test("reads a local file up to its size when opened, like fs.readFile", async () => {
    const file = path.join(dir, "growing.txt")
    // Larger than one 1 MiB stream chunk, so the append lands before the stream reaches the end.
    writeFileSync(file, `head\n${"x".repeat(2_000_000)}`)
    async function* appendingAfterFirstChunk(chunks: AsyncIterable<Uint8Array>) {
      const state = { first: true }
      for await (const chunk of chunks) {
        yield chunk
        if (state.first) appendFileSync(file, "\nadded")
        state.first = false
      }
    }
    const result = await PiRead.execute({ path: "growing.txt", limit: 1 }, file, {
      vision: true,
      stream: (target, signal) => appendingAfterFirstChunk(PiRead.readLocalFileChunks(target, signal)),
    })
    expect(result.content[0]).toEqual({
      type: "text",
      text: "head\n\n[1 more lines in file. Use offset=2 to continue.]",
    })
  })

  test("reads a 200 MB line in bounded memory", async () => {
    // A child process, so a regression that stores the whole line shows in its peak memory: storing it costs at
    // least 400 MB (the pieces and their join); the stream peaks near 60 MB on this PC.
    const script = path.join(dir, "big.ts")
    const log = path.join(dir, "big.log")
    writeFileSync(log, "x")
    writeFileSync(
      script,
      [
        `import { PiRead } from ${JSON.stringify(path.join(import.meta.dir, "../../../src/pi/read.ts"))}`,
        // 64 KB chunks, as Pi's test streams them.
        'const chunk = Buffer.alloc(64 * 1024, "x")',
        "async function* stream() { for (let i = 0; i < 3200; i++) yield chunk }",
        `const result = await PiRead.execute({ path: "big.log" }, ${JSON.stringify(log)}, { vision: true, stream })`,
        "process.stdout.write(JSON.stringify({ text: result.content[0].text, maxRSS: process.resourceUsage().maxRSS }))",
      ].join("\n"),
    )
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const report = JSON.parse(stdout) as { text: string; maxRSS: number }
    expect(report.text).toBe(
      `[Line 1 is 200.0MB, exceeds 50.0KB limit. Use bash: sed -n '1p' big.log | head -c ${PiTruncate.DEFAULT_MAX_BYTES}]`,
    )
    // maxRSS is in kilobytes.
    expect(report.maxRSS).toBeLessThan(200 * 1024)
  }, 60_000)

  test("stops consuming the stream when aborted", async () => {
    const controller = new AbortController()
    const file = path.join(dir, "abort.txt")
    writeFileSync(file, "line\n")
    const state = { chunksRead: 0, closed: false }
    async function* stream(_file: string, signal: AbortSignal | undefined) {
      expect(signal).toBe(controller.signal)
      try {
        while (true) {
          state.chunksRead++
          if (state.chunksRead === 3) controller.abort()
          await Bun.sleep(1)
          yield Buffer.from("line\n")
        }
      } finally {
        state.closed = true
      }
    }
    await expect(
      PiRead.execute({ path: FILE }, file, { vision: true, signal: controller.signal, stream }),
    ).rejects.toThrow("Operation aborted")
    await Bun.sleep(20)
    expect(state).toEqual({ chunksRead: 3, closed: true })
  })
})
