// Ports the read, write, edit and bash cases of packages/coding-agent/test/tools.test.ts,
// edit-tool-legacy-input.test.ts, edit-tool-diff-before-write.test.ts and
// suite/regressions/11613-bash-timeout-after-shell-exit.test.ts against the pi harness's tool engines. Pi's tools
// resolve their path and then act; here the path resolves first (own asks its permissions in between,
// src/pi/tools.ts), then the engine runs. Cases for Pi's pluggable operations run a Bun script as the shell instead.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyPatch } from "diff"
import { PiBash } from "../../../src/pi/bash.js"
import { PiEdit } from "../../../src/pi/edit.js"
import { PiEditDiff } from "../../../src/pi/edit-diff.js"
import { PiPaths } from "../../../src/pi/paths.js"
import { PiRead } from "../../../src/pi/read.js"
import type { PiShell } from "../../../src/pi/shell.js"
import { PiWrite } from "../../../src/pi/write.js"

/** A "shell" that runs its command as a Bun script, for Pi's cases with custom operations. */
const SCRIPT: PiShell.Config = { shell: process.execPath, args: ["-e"], stdin: false }

const state = { dir: "" }

beforeEach(() => {
  state.dir = join(tmpdir(), `own-pi-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(state.dir, { recursive: true })
})

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true })
})

async function read(input: PiRead.Input, vision = true) {
  return PiRead.execute(input, await PiPaths.resolveReadPath(input.path, state.dir), { vision })
}

function textOf(result: { content: ReadonlyArray<PiRead.Content> }) {
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
}

async function edit(input: unknown) {
  const prepared = PiEdit.prepareArguments(input) as PiEdit.Input
  const absolute = PiPaths.resolveToCwd(prepared.path, state.dir)
  return PiEdit.commit(prepared, absolute, await PiEdit.plan(prepared, absolute))
}

async function write(input: PiWrite.Input) {
  return PiWrite.execute(input, PiPaths.resolveToCwd(input.path, state.dir))
}

function bash(input: PiBash.Input, shell?: PiShell.Config) {
  return PiBash.execute(input, { cwd: state.dir, shell })
}

describe("read tool", () => {
  test("should read file contents that fit within limits", async () => {
    const file = join(state.dir, "test.txt")
    writeFileSync(file, "Hello, world!\nLine 2\nLine 3")
    const result = await read({ path: file })
    expect(textOf(result)).toBe("Hello, world!\nLine 2\nLine 3")
    expect(result.details).toBeUndefined()
  })

  test("should handle non-existent files", async () => {
    await expect(read({ path: join(state.dir, "nonexistent.txt") })).rejects.toThrow(/ENOENT|not found/i)
  })

  test("should truncate files exceeding line limit", async () => {
    const file = join(state.dir, "large.txt")
    writeFileSync(file, Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`).join("\n"))
    const output = textOf(await read({ path: file }))
    expect(output).toContain("Line 1")
    expect(output).toContain("Line 2000")
    expect(output).not.toContain("Line 2001")
    expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]")
  })

  test("should truncate when byte limit exceeded", async () => {
    const file = join(state.dir, "large-bytes.txt")
    writeFileSync(file, Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`).join("\n"))
    const output = textOf(await read({ path: file }))
    expect(output).toContain("Line 1:")
    expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(50\.0KB limit\)\. Use offset=\d+ to continue\.\]/)
  })

  test("should handle offset parameter", async () => {
    const file = join(state.dir, "offset-test.txt")
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n"))
    const output = textOf(await read({ path: file, offset: 51 }))
    expect(output).not.toContain("Line 50")
    expect(output).toContain("Line 51")
    expect(output).toContain("Line 100")
    expect(output).not.toContain("Use offset=")
  })

  test("should handle limit parameter", async () => {
    const file = join(state.dir, "limit-test.txt")
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n"))
    const output = textOf(await read({ path: file, limit: 10 }))
    expect(output).toContain("Line 10")
    expect(output).not.toContain("Line 11")
    expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]")
  })

  test("should handle offset + limit together", async () => {
    const file = join(state.dir, "offset-limit-test.txt")
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n"))
    const output = textOf(await read({ path: file, offset: 41, limit: 20 }))
    expect(output).not.toContain("Line 40")
    expect(output).toContain("Line 41")
    expect(output).toContain("Line 60")
    expect(output).not.toContain("Line 61")
    expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]")
  })

  test("should show error when offset is beyond file length", async () => {
    const file = join(state.dir, "short.txt")
    writeFileSync(file, "Line 1\nLine 2\nLine 3")
    await expect(read({ path: file, offset: 100 })).rejects.toThrow(
      /Offset 100 is beyond end of file \(3 lines total\)/,
    )
  })

  test("should include truncation details when truncated", async () => {
    const file = join(state.dir, "large-file.txt")
    writeFileSync(file, Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`).join("\n"))
    const result = await read({ path: file })
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 2500,
      outputLines: 2000,
    })
  })

  test("a first line over the byte limit points at bash", async () => {
    const file = join(state.dir, "wide.txt")
    writeFileSync(file, `${"x".repeat(60 * 1024)}\nnext`)
    expect(textOf(await read({ path: "wide.txt" }))).toBe(
      "[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' wide.txt | head -c 51200]",
    )
  })

  test("should detect image MIME type from file magic (not extension)", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
      "base64",
    )
    writeFileSync(join(state.dir, "image.txt"), png)
    const result = await read({ path: join(state.dir, "image.txt") })
    expect(result.content[0]).toEqual({ type: "text", text: "Read image file [image/png]" })
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") })
  })

  test("a model without image input gets Pi's note with the image", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
      "base64",
    )
    writeFileSync(join(state.dir, "a.png"), png)
    expect(textOf(await read({ path: "a.png" }, false))).toBe(
      "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]",
    )
  })

  test("a BMP answers Pi's conversion notice (own has no image converter)", async () => {
    const bmp = Buffer.alloc(58)
    bmp.write("BM", 0, "ascii")
    bmp.writeUInt32LE(bmp.length, 2)
    bmp.writeUInt32LE(54, 10)
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(1, 18)
    bmp.writeInt32LE(1, 22)
    bmp.writeUInt16LE(1, 26)
    bmp.writeUInt16LE(24, 28)
    writeFileSync(join(state.dir, "image.bmp"), bmp)
    const result = await read({ path: "image.bmp" })
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Read image file [image/bmp]\n[Image omitted: could not be converted to a supported inline image format.]",
      },
    ])
  })

  test("should treat files with image extension but non-image content as text", async () => {
    writeFileSync(join(state.dir, "not-an-image.png"), "definitely not a png")
    const result = await read({ path: "not-an-image.png" })
    expect(textOf(result)).toContain("definitely not a png")
    expect(result.content.some((item) => item.type === "image")).toBe(false)
  })
})

describe("write tool", () => {
  test("should write file contents", async () => {
    const file = join(state.dir, "write-test.txt")
    expect(await write({ path: file, content: "Test content" })).toBe(`Successfully wrote to ${file}`)
    expect(readFileSync(file, "utf-8")).toBe("Test content")
  })

  test("should create parent directories", async () => {
    expect(await write({ path: "nested/dir/test.txt", content: "Nested content" })).toBe(
      "Successfully wrote to nested/dir/test.txt",
    )
    expect(readFileSync(join(state.dir, "nested", "dir", "test.txt"), "utf-8")).toBe("Nested content")
  })
})

describe("edit tool", () => {
  test("should replace text in file", async () => {
    const file = join(state.dir, "edit-test.txt")
    writeFileSync(file, "Hello, world!")
    const result = await edit({ path: file, edits: [{ oldText: "world", newText: "testing" }] })
    expect(result.text).toBe(`Successfully replaced 1 block(s) in ${file}.`)
    expect(result.details.diff).toContain("testing")
    expect(result.details.patch).toContain("--- ")
    expect(result.details.patch).toContain("+++ ")
    expect(result.details.patch).toContain("@@")
    expect(result.details.patch).toContain("-Hello, world!")
    expect(result.details.patch).toContain("+Hello, testing!")
    expect(applyPatch("Hello, world!", result.details.patch)).toBe("Hello, testing!")
  })

  test("should fail if text not found", async () => {
    writeFileSync(join(state.dir, "edit-test.txt"), "Hello, world!")
    await expect(
      edit({ path: "edit-test.txt", edits: [{ oldText: "nonexistent", newText: "testing" }] }),
    ).rejects.toThrow(
      "Could not find the exact text in edit-test.txt. The old text must match exactly including all whitespace and newlines.",
    )
  })

  test("should include ENOENT when the edit target does not exist", async () => {
    const missing = join(state.dir, "missing.txt")
    await expect(edit({ path: missing, edits: [{ oldText: "hello", newText: "world" }] })).rejects.toThrow(
      `Could not edit file: ${missing}. Error code: ENOENT.`,
    )
  })

  test("should fail if text appears multiple times", async () => {
    writeFileSync(join(state.dir, "edit-test.txt"), "foo foo foo")
    await expect(edit({ path: "edit-test.txt", edits: [{ oldText: "foo", newText: "bar" }] })).rejects.toThrow(
      "Found 3 occurrences of the text in edit-test.txt. The text must be unique. Please provide more context to make it unique.",
    )
  })

  test("should replace multiple disjoint regions in one call", async () => {
    const file = join(state.dir, "edit-multi.txt")
    writeFileSync(file, "alpha\nbeta\ngamma\ndelta\n")
    const result = await edit({
      path: file,
      edits: [
        { oldText: "alpha\n", newText: "ALPHA\n" },
        { oldText: "gamma\n", newText: "GAMMA\n" },
      ],
    })
    expect(result.text).toContain("Successfully replaced 2 block(s)")
    expect(readFileSync(file, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n")
    expect(result.details.diff).toContain("ALPHA")
    expect(result.details.diff).toContain("GAMMA")
  })

  test("should collapse large unchanged gaps in multi-edit diffs", async () => {
    const file = join(state.dir, "edit-multi-large-gap.txt")
    writeFileSync(
      file,
      `${Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`).join("\n")}\n`,
    )
    const result = await edit({
      path: file,
      edits: [
        { oldText: "line 100\n", newText: "LINE 100\n" },
        { oldText: "line 300\n", newText: "LINE 300\n" },
        { oldText: "line 500\n", newText: "LINE 500\n" },
      ],
    })
    const diff = result.details.diff
    expect(diff).toContain("LINE 100")
    expect(diff).toContain("LINE 300")
    expect(diff).toContain("LINE 500")
    expect(diff).toContain("...")
    expect(diff).not.toContain("line 250")
    expect(diff.split("\n").length).toBeLessThan(50)
  })

  test("the display diff numbers lines and shows four lines of context", async () => {
    const file = join(state.dir, "numbers.txt")
    writeFileSync(file, `${Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n")}\n`)
    const result = await edit({ path: file, edits: [{ oldText: "l6\n", newText: "L6\n" }] })
    expect(result.details.diff).toBe(
      [
        "    ...",
        "  2 l2",
        "  3 l3",
        "  4 l4",
        "  5 l5",
        "- 6 l6",
        "+ 6 L6",
        "  7 l7",
        "  8 l8",
        "  9 l9",
        " 10 l10",
        "    ...",
      ].join("\n"),
    )
    expect(result.details.firstChangedLine).toBe(6)
  })

  test("should match edits against the original file, not incrementally", async () => {
    const file = join(state.dir, "edit-multi-original.txt")
    writeFileSync(file, "foo\nbar\nbaz\n")
    await edit({
      path: file,
      edits: [
        { oldText: "foo\n", newText: "foo bar\n" },
        { oldText: "bar\n", newText: "BAR\n" },
      ],
    })
    expect(readFileSync(file, "utf-8")).toBe("foo bar\nBAR\nbaz\n")
  })

  test("should fail when edits is empty", async () => {
    writeFileSync(join(state.dir, "edit-empty-edits.txt"), "hello\nworld\n")
    await expect(edit({ path: "edit-empty-edits.txt", edits: [] })).rejects.toThrow(
      "Edit tool input is invalid. edits must contain at least one replacement.",
    )
  })

  test("should fail when multi-edit regions overlap", async () => {
    writeFileSync(join(state.dir, "edit-overlap.txt"), "one\ntwo\nthree\n")
    await expect(
      edit({
        path: "edit-overlap.txt",
        edits: [
          { oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
          { oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
        ],
      }),
    ).rejects.toThrow(
      "edits[0] and edits[1] overlap in edit-overlap.txt. Merge them into one edit or target disjoint regions.",
    )
  })

  test("should not partially apply edits when one edit fails", async () => {
    const file = join(state.dir, "edit-no-partial.txt")
    writeFileSync(file, "alpha\nbeta\ngamma\n")
    await expect(
      edit({
        path: file,
        edits: [
          { oldText: "alpha\n", newText: "ALPHA\n" },
          { oldText: "missing\n", newText: "MISSING\n" },
        ],
      }),
    ).rejects.toThrow(/Could not find edits\[1\]/)
    expect(readFileSync(file, "utf-8")).toBe("alpha\nbeta\ngamma\n")
  })

  test.skipIf(process.platform === "win32")("should include EACCES for read-only files", async () => {
    const file = join(state.dir, "edit-readonly.txt")
    writeFileSync(file, "hello\n")
    chmodSync(file, 0o444)
    await expect(edit({ path: file, edits: [{ oldText: "hello", newText: "world" }] })).rejects.toThrow(
      `Could not edit file: ${file}. Error code: EACCES.`,
    )
  })
})

describe("edit tool prepareArguments", () => {
  test("folds top-level oldText/newText into edits", () => {
    expect(PiEdit.prepareArguments({ path: "file.txt", oldText: "before", newText: "after" })).toEqual({
      path: "file.txt",
      edits: [{ oldText: "before", newText: "after" }],
    })
  })

  test("appends legacy replacement to existing edits", () => {
    expect(
      PiEdit.prepareArguments({
        path: "file.txt",
        edits: [{ oldText: "a", newText: "b" }],
        oldText: "c",
        newText: "d",
      }),
    ).toEqual({
      path: "file.txt",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    })
  })

  test("passes through valid input unchanged", () => {
    const input = { path: "file.txt", edits: [{ oldText: "a", newText: "b" }] }
    expect(PiEdit.prepareArguments(input)).toBe(input)
  })

  test("passes through non-object input unchanged", () => {
    expect(PiEdit.prepareArguments(null)).toBe(null)
    expect(PiEdit.prepareArguments(undefined)).toBe(undefined)
    expect(PiEdit.prepareArguments("garbage")).toBe("garbage")
  })

  test("prepared args execute correctly", async () => {
    writeFileSync(join(state.dir, "legacy.txt"), "before\n", "utf8")
    const result = await edit({ path: "legacy.txt", oldText: "before", newText: "after" })
    expect(result.text).toBe("Successfully replaced 1 block(s) in legacy.txt.")
    expect(readFileSync(join(state.dir, "legacy.txt"), "utf8")).toBe("after\n")
  })

  test("parses edits from a JSON string, or one edit object", () => {
    expect(PiEdit.prepareArguments({ path: "f", edits: JSON.stringify([{ oldText: "a", newText: "b" }]) })).toEqual({
      path: "f",
      edits: [{ oldText: "a", newText: "b" }],
    })
    expect(PiEdit.prepareArguments({ path: "f", edits: { oldText: "a", newText: "b" } })).toEqual({
      path: "f",
      edits: [{ oldText: "a", newText: "b" }],
    })
  })

  test("leaves edits alone when the string is not valid JSON", () => {
    expect(PiEdit.prepareArguments({ path: "file.txt", edits: "not json" })).toEqual({
      path: "file.txt",
      edits: "not json",
    })
  })
})

describe("edit tool fuzzy matching", () => {
  test("should match text with trailing whitespace stripped", async () => {
    const file = join(state.dir, "trailing-ws.txt")
    writeFileSync(file, "line one   \nline two  \nline three\n")
    await edit({ path: file, edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }] })
    expect(readFileSync(file, "utf-8")).toBe("replaced\nline three\n")
  })

  test("should match fullwidth punctuation in Chinese text", async () => {
    const file = join(state.dir, "chinese-punctuation.txt")
    writeFileSync(file, "你好，世界\n你好（世界）\n")
    await edit({ path: file, edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }] })
    expect(readFileSync(file, "utf-8")).toBe("你好，pi\n你好(pi)\n")
  })

  test("should match compatibility-equivalent Unicode forms", async () => {
    const file = join(state.dir, "unicode-compatibility.txt")
    writeFileSync(file, "ＡＢＣ１２３\ncafé\n")
    await edit({ path: file, edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }] })
    expect(readFileSync(file, "utf-8")).toBe("XYZ789\ncoffee\n")
  })

  test("should match smart quotes, dashes and non-breaking spaces", async () => {
    const file = join(state.dir, "smart.txt")
    writeFileSync(file, "console.log(‘hello’);\nconst msg = “Hello”;\nrange: 1–5\nhello world\n")
    await edit({
      path: file,
      edits: [
        { oldText: "console.log('hello');", newText: "console.log('world');" },
        { oldText: 'const msg = "Hello";', newText: 'const msg = "Goodbye";' },
        { oldText: "range: 1-5", newText: "range: 10-50" },
        { oldText: "hello world", newText: "hello universe" },
      ],
    })
    expect(readFileSync(file, "utf-8")).toBe(
      "console.log('world');\nconst msg = \"Goodbye\";\nrange: 10-50\nhello universe\n",
    )
  })

  test("should prefer exact match over fuzzy match", async () => {
    const file = join(state.dir, "exact-preferred.txt")
    writeFileSync(file, "const x = 'exact';\nconst y = 'other';\n")
    await edit({ path: file, edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }] })
    expect(readFileSync(file, "utf-8")).toBe("const x = 'changed';\nconst y = 'other';\n")
  })

  test("should detect duplicates after fuzzy normalization", async () => {
    writeFileSync(join(state.dir, "fuzzy-dups.txt"), "hello world   \nhello world\n")
    await expect(
      edit({ path: "fuzzy-dups.txt", edits: [{ oldText: "hello world", newText: "replaced" }] }),
    ).rejects.toThrow(/Found 2 occurrences/)
  })

  test("should preserve the correct occurrence when fuzzy replacement equals a nearby line", async () => {
    const file = join(state.dir, "fuzzy-preserve-duplicate-line.txt")
    const original = ["replace me   ", "after   ", ""].join("\n")
    writeFileSync(file, original)
    const result = await edit({ path: file, edits: [{ oldText: "replace me\n", newText: "after\n" }] })
    const expected = ["after", "after   ", ""].join("\n")
    expect(readFileSync(file, "utf-8")).toBe(expected)
    expect(applyPatch(original, result.details.patch)).toBe(expected)
  })

  test("should preserve untouched lines and produce an applicable patch for fuzzy multi-edits", async () => {
    const file = join(state.dir, "fuzzy-preserve-multi.txt")
    const original = [
      "keep before  ",
      "first target  ",
      "first after",
      "keep middle   ",
      "second target  ",
      "second after",
      "keep after  ",
      "",
    ].join("\n")
    writeFileSync(file, original)
    const result = await edit({
      path: file,
      edits: [
        { oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
        { oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
      ],
    })
    const expected = [
      "keep before  ",
      "FIRST",
      "FIRST2",
      "keep middle   ",
      "SECOND",
      "SECOND2",
      "keep after  ",
      "",
    ].join("\n")
    expect(readFileSync(file, "utf-8")).toBe(expected)
    expect(applyPatch(original, result.details.patch)).toBe(expected)
  })
})

describe("edit tool CRLF handling", () => {
  test("should preserve CRLF line endings after edit", async () => {
    const file = join(state.dir, "crlf-preserve.txt")
    writeFileSync(file, "first\r\nsecond\r\nthird\r\n")
    await edit({ path: file, edits: [{ oldText: "second\n", newText: "REPLACED\n" }] })
    expect(readFileSync(file, "utf-8")).toBe("first\r\nREPLACED\r\nthird\r\n")
  })

  test("should preserve LF line endings for LF files", async () => {
    const file = join(state.dir, "lf-preserve.txt")
    writeFileSync(file, "first\nsecond\nthird\n")
    await edit({ path: file, edits: [{ oldText: "second\n", newText: "REPLACED\n" }] })
    expect(readFileSync(file, "utf-8")).toBe("first\nREPLACED\nthird\n")
  })

  test("should detect duplicates across CRLF/LF variants", async () => {
    writeFileSync(join(state.dir, "mixed-endings.txt"), "hello\r\nworld\r\n---\r\nhello\nworld\n")
    await expect(
      edit({ path: "mixed-endings.txt", edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }] }),
    ).rejects.toThrow(/Found 2 occurrences/)
  })

  test("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
    const file = join(state.dir, "bom-crlf-multi.txt")
    writeFileSync(file, "﻿first\r\nsecond\r\nthird\r\nfourth\r\n")
    await edit({
      path: file,
      edits: [
        { oldText: "second\n", newText: "SECOND\n" },
        { oldText: "fourth\n", newText: "FOURTH\n" },
      ],
    })
    expect(readFileSync(file, "utf-8")).toBe("﻿first\r\nSECOND\r\nthird\r\nFOURTH\r\n")
  })

  test("should write CRLF for inserted lines in CRLF files", async () => {
    const file = join(state.dir, "crlf-bytes.txt")
    writeFileSync(file, "first\r\nsecond\r\nthird")
    await edit({ path: file, edits: [{ oldText: "second\nthird", newText: "2a\r\n2b\nthird!" }] })
    expect(readFileSync(file).equals(Buffer.from("first\r\n2a\r\n2b\r\nthird!"))).toBe(true)
  })

  test("should write LF for inserted lines in LF files", async () => {
    const file = join(state.dir, "lf-bytes.txt")
    writeFileSync(file, "first\nsecond\nthird")
    await edit({ path: file, edits: [{ oldText: "second\nthird", newText: "2a\r\n2b\nthird!" }] })
    expect(readFileSync(file).equals(Buffer.from("first\n2a\n2b\nthird!"))).toBe(true)
  })

  // #8544
  test("should keep CRLF lines when the first line ends with LF", async () => {
    const file = join(state.dir, "mixed-lf-first.txt")
    writeFileSync(file, "a\nb\r\nX = 1\r\n")
    await edit({ path: file, edits: [{ oldText: "X = 1", newText: "X = 2" }] })
    expect(readFileSync(file).equals(Buffer.from("a\nb\r\nX = 2\r\n"))).toBe(true)
  })

  // #8544
  test("should keep LF lines when the first line ends with CRLF", async () => {
    const file = join(state.dir, "mixed-crlf-first.txt")
    writeFileSync(file, "a\r\nb\nc")
    await edit({ path: file, edits: [{ oldText: "c", newText: "C" }] })
    expect(readFileSync(file).equals(Buffer.from("a\r\nb\nC"))).toBe(true)
  })

  // #8544
  test("should keep a lone CR in an untouched line", async () => {
    const file = join(state.dir, "lone-cr.txt")
    writeFileSync(file, "a\rb\nX = 1\n")
    await edit({ path: file, edits: [{ oldText: "X = 1", newText: "X = 2" }] })
    expect(readFileSync(file).equals(Buffer.from("a\rb\nX = 2\n"))).toBe(true)
  })

  // #8544
  test("should give inserted lines the line ending of the line they replace in multi-edit mode", async () => {
    const file = join(state.dir, "mixed-multi.txt")
    writeFileSync(file, "lf1\nlf2\ncr1\r\ncr2\r\n")
    await edit({
      path: file,
      edits: [
        { oldText: "lf1\n", newText: "A\nB\n" },
        { oldText: "cr1\n", newText: "C\nD\n" },
      ],
    })
    expect(readFileSync(file).equals(Buffer.from("A\nB\nlf2\nC\r\nD\r\ncr2\r\n"))).toBe(true)
  })

  // #8544
  test("should keep untouched line endings when fuzzy matching widens the edit to whole lines", async () => {
    const file = join(state.dir, "mixed-fuzzy.txt")
    writeFileSync(file, "a\r\nfoo   \r\nb\n")
    await edit({ path: file, edits: [{ oldText: "foo\n", newText: "FOO\n" }] })
    expect(readFileSync(file).equals(Buffer.from("a\r\nFOO\r\nb\n"))).toBe(true)
  })

  // A kept CR and an LF meeting at a splice seam must not merge into one CRLF line break.
  test("should not merge a kept lone CR with a line feed after it", async () => {
    const cases = [
      // Inserted text starting with LF after a kept lone CR.
      { edit: { oldText: "b", newText: "\nB" }, written: "a\r\n\nB\nc", diffed: "a\n\nB\nc" },
      // Deleted text between a kept lone CR and a kept LF.
      { edit: { oldText: "b", newText: "" }, written: "a\r\n\nc", diffed: "a\n\nc" },
    ]
    for (const [index, item] of cases.entries()) {
      const file = join(state.dir, `cr-seam-${index}.txt`)
      writeFileSync(file, "a\rb\nc")
      const result = await edit({ path: file, edits: [item.edit] })
      expect(readFileSync(file).equals(Buffer.from(item.written))).toBe(true)
      expect(applyPatch("a\nb\nc", result.details.patch)).toBe(item.diffed)
    }
  })

  test("should not merge an inserted CR line ending with a kept line feed after it", () => {
    // Only files without LF give inserted text CR line endings, so check the seam directly.
    const written = PiEditDiff.applyReplacementsToOriginal("a\rb\nc", [
      { matchIndex: 2, matchLength: 1, newText: "\r" },
    ])
    expect(PiEditDiff.normalizeToLF(written)).toBe("a\n\n\nc")
  })

  test("should write content that normalizes to the diffed content for random mixed line endings", () => {
    const seed = { value: 1 }
    const random = (n: number) => {
      seed.value = (seed.value * 1103515245 + 12345) & 0x7fffffff
      // The high bits: the low bits of this generator repeat with a short period.
      return Math.floor((seed.value / 0x80000000) * n)
    }
    const endings = ["\n", "\r\n", "\r", ""]
    Array.from({ length: 3000 }).forEach(() => {
      const original = Array.from(
        { length: random(12) + 1 },
        () => `w${random(100)}${random(5) === 0 ? "  " : ""}${endings[random(4)]}`,
      ).join("")
      const normalized = PiEditDiff.normalizeToLF(original)
      const start = random(normalized.length)
      const oldText = normalized.slice(start, start + 1 + random(12))
      const newText = ["", "\n", "X\n", "\nY", "\r", "Z"][random(6)]!
      const applied = (() => {
        try {
          return PiEditDiff.applyEditsToNormalizedContent(normalized, [{ oldText, newText }], "f.txt")
        } catch {
          return undefined // duplicate, not found or no change
        }
      })()
      if (applied === undefined) return
      expect(PiEditDiff.normalizeToLF(PiEditDiff.applyReplacementsToOriginal(original, applied.replacements))).toBe(
        applied.newContent,
      )
    })
  })

  test("a Windows file with mixed line endings and a lone CR keeps every untouched byte", async () => {
    // A .gitattributes-less repository edited by CRLF and LF tools: before Pi 1.5.1 the first line ending won.
    const file = join(state.dir, "mixed-windows.ts")
    const lines = ["import a\r\n", "import b\n", "// ^M kept\r", "const x = 1\r\n", "const y = 2\n", "export {}"]
    writeFileSync(file, lines.join(""))
    await edit({
      path: file,
      edits: [
        { oldText: "const x = 1\n", newText: "const x = 10\nconst z = 3\n" },
        { oldText: "export {}", newText: "export { x, y }" },
      ],
    })
    expect(readFileSync(file, "utf-8")).toBe(
      [
        "import a\r\n",
        "import b\n",
        "// ^M kept\r",
        "const x = 10\r\nconst z = 3\r\n",
        "const y = 2\n",
        "export { x, y }",
      ].join(""),
    )
  })
})

describe("edit tool diff before write", () => {
  test("should compute the diff before writing, so a diff failure leaves the file unchanged", async () => {
    // own has no module mocks: a plan whose diff input is not text makes the diff throw.
    const file = join(state.dir, "diff-before-write.txt")
    writeFileSync(file, "a\nb\n")
    const input: PiEdit.Input = { path: file, edits: [{ oldText: "b", newText: "B" }] }
    const planned = await PiEdit.plan(input, file)
    expect(planned.after).toBe("a\nB\n")
    await expect(
      PiEdit.commit(input, file, { ...planned, baseContent: undefined as unknown as string }),
    ).rejects.toThrow()
    expect(readFileSync(file, "utf-8")).toBe("a\nb\n")
  })
})

describe("bash tool", () => {
  test("should execute simple commands", async () => {
    const result = await bash({ command: "echo 'test output'" })
    expect(result).toMatchObject({ text: "test output\n", isError: false, exitCode: 0 })
  })

  test("should report non-zero exit codes as error results", async () => {
    expect(await bash({ command: "echo out; exit 3" })).toMatchObject({
      text: "out\n\n\nCommand exited with code 3",
      isError: true,
      exitCode: 3,
    })
    expect((await bash({ command: "true" })).text).toBe("(no output)")
  })

  test("should persist full output when truncation happens by line count only", async () => {
    const result = await bash({ command: "seq 3000" })
    expect(result.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 3000,
      outputLines: 2000,
    })
    expect(result.text).toMatch(
      /\n\n\[Showing lines 1001-3000 of 3000\. Full output: [^\]]+pi-bash-[0-9a-f]{16}\.log\]$/,
    )
    expect(result.text).not.toContain("\n1000\n")
    const full = readFileSync(result.fullOutputPath!, "utf-8")
    expect(full).toContain("1\n2\n3")
    expect(full).toContain("2998\n2999\n3000")
  })

  test("should respect timeout", async () => {
    await expect(bash({ command: "setInterval(() => {}, 1000)", timeout: 0.2 }, SCRIPT)).rejects.toThrow(
      /^Command timed out after 0\.2 seconds$/,
    )
  })

  // #11613: the shell exited, but a background process it started kept the pipes open and writing until the timeout.
  // Pi's test runs `(while …) &` in bash and is Unix only, since on Windows the deadline cannot kill a background
  // process once the shell pid is gone. Here the background process writes for a bounded 8 s, so the case runs on
  // Windows too, where the wait lasts until its output stops. `detached` keeps it alive after the shell exits, as
  // Git Bash's `&` does (libuv otherwise ends a Windows child with the job of the process that started it). The 6 s
  // timeout leaves room for a slow start on a loaded PC: only a shell that exited before the deadline is reported.
  test("reports the shell's exit code when background processes kept writing until the timeout", async () => {
    // The background process marks that it is writing before the shell exits: after the exit, a 100 ms pause in the
    // output ends the wait (Pi's EXIT_STDIO_GRACE_MS), and a background process still starting would be one. It runs
    // outside the test folder, which Windows cannot remove while a process has it as its working directory.
    const flag = join(state.dir, "writing")
    const background = [
      'const t = setInterval(() => process.stdout.write("tick" + String.fromCharCode(10)), 2)',
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(flag)}, ""), 20)`,
      "setTimeout(() => clearInterval(t), 8000)",
    ].join("; ")
    // The shell exits 4 s after the call (later if the background process starts later), so only the last 2 s before
    // the deadline depend on the output never pausing for 100 ms.
    const command = (exitAt: number) =>
      [
        'const { spawn } = require("node:child_process")',
        'const { existsSync } = require("node:fs")',
        `const options = { stdio: "inherit", detached: true, cwd: ${JSON.stringify(tmpdir())} }`,
        `spawn(process.execPath, ["-e", ${JSON.stringify(background)}], options).unref()`,
        'const exit = () => { process.stderr.write("boom" + String.fromCharCode(10)); process.exit(3) }',
        `const wait = () => (existsSync(${JSON.stringify(flag)}) ? setTimeout(exit, ${exitAt} - Date.now()) : setTimeout(wait, 10))`,
        "wait()",
      ].join("; ")
    const expected =
      /Command timed out after 6 seconds\. The shell exited with code 3 after \d+(?:\.\d)? seconds, but background processes it started kept writing output until the timeout\.$/
    // A starved process can still pause the output for 100 ms after the shell's exit, which ends the wait with the
    // shell's own result (Pi's behaviour too), or delay the shell's exit past the deadline (the plain timeout). Neither
    // is the case under test, so such a run is tried again, at most six times; the last outcome is checked.
    const attempt = async (left: number): Promise<unknown> => {
      const outcome = await bash({ command: command(Date.now() + 4000), timeout: 6 }, SCRIPT)
        .finally(() => rmSync(flag, { force: true }))
        .then(
          (result) => result,
          (failure: unknown) => failure,
        )
      if (left > 1 && !(outcome instanceof Error && expected.test(outcome.message))) return attempt(left - 1)
      return outcome
    }
    const error = await attempt(6)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain("boom")
    expect(message).toMatch(expected)
  }, 150_000)

  test("keeps the plain timeout message when the shell was still running at the deadline", async () => {
    await expect(
      bash({ command: 'console.log("started"); setInterval(() => {}, 1000)', timeout: 0.3 }, SCRIPT),
    ).rejects.toThrow(/started\s+Command timed out after 0\.3 seconds$/)
  })

  test("an invalid timeout fails before running", async () => {
    await expect(bash({ command: "echo x", timeout: -1 })).rejects.toThrow(
      "Invalid timeout: must be a finite number of seconds",
    )
  })

  test("should throw error when cwd does not exist", async () => {
    const missing = join(state.dir, "does-not-exist")
    await expect(PiBash.execute({ command: "echo test" }, { cwd: missing })).rejects.toThrow(
      `Working directory does not exist: ${missing}\nCannot execute bash commands.`,
    )
  })

  test("should handle process spawn errors", async () => {
    await expect(
      bash({ command: "echo test" }, { shell: join(state.dir, "nonexistent-shell"), args: ["-c"], stdin: false }),
    ).rejects.toThrow(
      // Node says `spawn … ENOENT`; Bun says the executable was not found.
      /ENOENT|not found/,
    )
  })

  test("should not count a trailing newline as an extra truncated bash output line", async () => {
    const result = await bash(
      { command: 'for (let i = 1; i <= 4000; i++) process.stdout.write(`line-${String(i).padStart(4, "0")}\\n`)' },
      SCRIPT,
    )
    expect(result.truncation).toMatchObject({ totalLines: 4000, outputLines: 2000 })
    expect(result.text).toContain("line-2001")
    expect(result.text).toContain("line-4000")
    expect(result.text).toMatch(/\[Showing lines 2001-4000 of 4000\. Full output: /)
    expect(result.text).not.toContain("4001")
    expect(existsSync(result.fullOutputPath!)).toBe(true)
  })

  test("byte truncation keeps the tail and names the limit", async () => {
    const result = await bash({ command: 'for (let i = 0; i < 100; i++) console.log("y".repeat(1000))' }, SCRIPT)
    expect(result.truncation).toMatchObject({ truncated: true, truncatedBy: "bytes", totalLines: 100 })
    expect(result.text).toMatch(/\n\n\[Showing lines 50-100 of 100 \(50\.0KB limit\)\. Full output: /)
  })

  test("a last line over the byte limit shows its end", async () => {
    const result = await bash({ command: 'process.stdout.write("z".repeat(60 * 1024))' }, SCRIPT)
    expect(result.truncation).toMatchObject({ lastLinePartial: true, outputBytes: 50 * 1024 })
    expect(result.text).toMatch(/\n\n\[Showing last 50\.0KB of line 1 \(line is 60\.0KB\)\. Full output: /)
  })

  test("should decode UTF-8 characters split across output chunks", async () => {
    const result = await bash(
      {
        command:
          'const b = Buffer.from("€\\n"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 20)',
      },
      SCRIPT,
    )
    expect(result.text.trim()).toBe("€")
  })

  test("PI_* variables reach the command", async () => {
    const result = await PiBash.execute(
      { command: "process.stdout.write(String(process.env.PI_MODEL))" },
      { cwd: state.dir, shell: SCRIPT, env: { ...process.env, PI_MODEL: "m-1" } },
    )
    expect(result.text).toBe("m-1")
  })
})

describe("a bash command own answered itself (read-only, ask and explore reads)", () => {
  test("the output as a finished command: text, (no output), and Pi's status line for a non-zero exit", async () => {
    expect(await PiBash.answered("a.txt\nsrc/\n", 0)).toEqual({ text: "a.txt\nsrc/\n", isError: false, exitCode: 0 })
    expect(await PiBash.answered("", 0)).toEqual({ text: "(no output)", isError: false, exitCode: 0 })
    expect(await PiBash.answered("ls: cannot access 'x': No such file or directory\n", 2)).toEqual({
      text: "ls: cannot access 'x': No such file or directory\n\n\nCommand exited with code 2",
      isError: true,
      exitCode: 2,
    })
  })

  test("a long answer is cut to Pi's last lines with the full output in a temp file, as a command's", async () => {
    const lines = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n")
    const result = await PiBash.answered(lines, 0)
    expect(result.truncation?.truncated).toBe(true)
    expect(result.text).toContain("line 2500")
    expect(result.text).not.toContain("line 1\n")
    expect(result.text).toContain(`[Showing lines 501-2500 of 2500. Full output: ${result.fullOutputPath}]`)
    expect(readFileSync(result.fullOutputPath!, "utf-8")).toBe(lines)
    rmSync(result.fullOutputPath!, { force: true })
  })
})
