// Pi's truncation, path handling and argument check (src/pi/truncate.ts, paths.ts, args.ts). The path cases port
// packages/coding-agent/test/path-utils.test.ts, the argument cases follow packages/ai/test/validation.test.ts for the
// types Pi's tools use.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PiArgs } from "../../../src/pi/args.js"
import { PiBash } from "../../../src/pi/bash.js"
import { PiEdit } from "../../../src/pi/edit.js"
import { PiPaths } from "../../../src/pi/paths.js"
import { PiRead } from "../../../src/pi/read.js"
import { PiTruncate } from "../../../src/pi/truncate.js"
import { PiWrite } from "../../../src/pi/write.js"

describe("PiTruncate", () => {
  test("formatSize", () => {
    expect(PiTruncate.formatSize(512)).toBe("512B")
    expect(PiTruncate.formatSize(50 * 1024)).toBe("50.0KB")
    expect(PiTruncate.formatSize(3 * 1024 * 1024)).toBe("3.0MB")
  })

  test("content within both limits comes back whole; a trailing newline is no extra line", () => {
    expect(PiTruncate.truncateHead("a\nb\n", { maxLines: 2 })).toMatchObject({
      content: "a\nb\n",
      truncated: false,
      totalLines: 2,
    })
  })

  test("head truncation keeps whole lines from the start", () => {
    const head = PiTruncate.truncateHead("one\ntwo\nthree\nfour", { maxLines: 10, maxBytes: 9 })
    expect(head).toMatchObject({ content: "one\ntwo", truncatedBy: "bytes", outputLines: 2, outputBytes: 7 })
    expect(PiTruncate.truncateHead("1\n2\n3", { maxLines: 2 })).toMatchObject({ content: "1\n2", truncatedBy: "lines" })
    expect(PiTruncate.truncateHead("toolong\nx", { maxBytes: 3 })).toMatchObject({
      content: "",
      firstLineExceedsLimit: true,
    })
  })

  test("tail truncation keeps whole lines from the end, or the end of an oversized last line", () => {
    expect(PiTruncate.truncateTail("one\ntwo\nthree\nfour", { maxBytes: 10 })).toMatchObject({
      content: "three\nfour",
      truncatedBy: "bytes",
      outputLines: 2,
    })
    expect(PiTruncate.truncateTail("1\n2\n3", { maxLines: 2 })).toMatchObject({ content: "2\n3", truncatedBy: "lines" })
    expect(PiTruncate.truncateTail("a\n€€€", { maxBytes: 4 })).toMatchObject({
      content: "€",
      lastLinePartial: true,
      outputBytes: 3,
    })
  })
})

describe("PiPaths (Pi's path-utils tests)", () => {
  test("should expand ~ and ~/path to the home directory", () => {
    expect(PiPaths.expandPath("~")).not.toContain("~")
    expect(PiPaths.expandPath("~/Documents/file.txt")).not.toContain("~/")
  })

  test("should keep tilde-prefixed filenames literal", () => {
    expect(PiPaths.expandPath("~draft.md")).toBe("~draft.md")
    expect(PiPaths.expandPath("@~draft.md")).toBe("~draft.md")
  })

  test("should normalize Unicode spaces", () => {
    expect(PiPaths.expandPath("file\u00A0name.txt")).toBe("file name.txt")
  })

  test("should resolve absolute paths as-is and relative ones against cwd", () => {
    const absolute = resolve(tmpdir(), "absolute", "path", "file.txt")
    expect(PiPaths.resolveToCwd(absolute, resolve(tmpdir(), "some", "cwd"))).toBe(absolute)
    expect(PiPaths.resolveToCwd("relative/file.txt", "/some/cwd")).toBe(resolve("/some/cwd", "relative/file.txt"))
    const cwd = join(tmpdir(), "pi-path-utils-cwd")
    expect(PiPaths.resolveToCwd("~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"))
    expect(PiPaths.resolveToCwd("@~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"))
  })

  test.skipIf(process.platform !== "win32")("Git Bash drive paths read as Windows paths", () => {
    expect(PiPaths.normalizeWindowsShellPath("/c/work/a.txt")).toBe("C:\\work\\a.txt")
    expect(PiPaths.normalizeWindowsShellPath("/mnt/d/x")).toBe("D:\\x")
    expect(PiPaths.normalizeWindowsShellPath("/cygdrive/e")).toBe("E:\\")
    expect(PiPaths.normalizeWindowsShellPath("/usr/bin")).toBe("/usr/bin")
    expect(PiPaths.resolveToCwd("/c/work/a.txt", "C:\\other")).toBe("C:\\work\\a.txt")
  })

  describe("resolveReadPath", () => {
    const state = { dir: "" }
    beforeEach(() => {
      state.dir = mkdtempSync(join(tmpdir(), "own-pi-paths-"))
    })
    afterEach(() => {
      rmSync(state.dir, { recursive: true, force: true })
    })

    test("should resolve existing file path", async () => {
      writeFileSync(join(state.dir, "test-file.txt"), "content")
      expect(await PiPaths.resolveReadPath("test-file.txt", state.dir)).toBe(join(state.dir, "test-file.txt"))
    })

    test("should handle curly quotes vs straight quotes (macOS filenames)", async () => {
      writeFileSync(join(state.dir, "Capture d\u2019cran.txt"), "content")
      expect(await PiPaths.resolveReadPath("Capture d'cran.txt", state.dir)).toBe(
        join(state.dir, "Capture d\u2019cran.txt"),
      )
    })

    test("should handle macOS screenshot AM/PM variants with a narrow no-break space", async () => {
      writeFileSync(join(state.dir, "Screenshot 2024-01-01 at 10.00.00\u202FAM.png"), "content")
      writeFileSync(join(state.dir, "Screenshot 2024-01-01 at 10.00.00\u202Fam.png"), "content")
      expect(await PiPaths.resolveReadPath("Screenshot 2024-01-01 at 10.00.00 AM.png", state.dir)).toBe(
        join(state.dir, "Screenshot 2024-01-01 at 10.00.00\u202FAM.png"),
      )
      expect(await PiPaths.resolveReadPath("Screenshot 2024-01-01 at 10.00.00 am.png", state.dir)).toBe(
        join(state.dir, "Screenshot 2024-01-01 at 10.00.00\u202Fam.png"),
      )
    })

    test("a path that matches nothing resolves as written", async () => {
      expect(await PiPaths.resolveReadPath("missing.txt", state.dir)).toBe(join(state.dir, "missing.txt"))
    })
  })
})

describe("PiArgs", () => {
  test("Pi's schemas: required fields, optional numbers, the edit array", () => {
    expect(PiRead.SCHEMA.required).toEqual(["path"])
    expect(PiBash.SCHEMA.required).toEqual(["command"])
    expect(PiEdit.SCHEMA.properties.edits!.items!.required).toEqual(["oldText", "newText"])
    const standard = PiArgs.standard(PiRead.SCHEMA)["~standard"]
    expect(standard.jsonSchema.input()).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    })
    expect(standard.validate({ anything: 1 })).toEqual({ value: { anything: 1 } })
  })

  test("drops optional nulls and converts primitives as TypeBox does", () => {
    expect(PiArgs.check("read", PiRead.SCHEMA, { path: 12, offset: "5", limit: null })).toEqual({
      ok: true,
      value: { path: "12", offset: 5 },
    })
  })

  /** A tool whose one required argument `value` has `property`'s type, as Pi's validation tests build it. */
  const echo = (property: PiArgs.Property): PiArgs.ObjectSchema => ({
    type: "object",
    properties: { value: property },
    required: ["value"],
  })

  test("pi-schema's conversions: TypeBox's rules first, so null is \"null\" for a required string", () => {
    const cases: ReadonlyArray<readonly [PiArgs.Property, unknown, unknown]> = [
      [{ type: "number" }, "42", 42],
      [{ type: "number" }, true, 1],
      [{ type: "number" }, null, 0],
      [{ type: "number" }, "true", 1],
      [{ type: "number" }, "12n", 12],
      [{ type: "string" }, null, "null"],
      [{ type: "string" }, true, "true"],
      [{ type: "string" }, 7, "7"],
    ]
    cases.forEach(([property, input, expected]) =>
      expect(PiArgs.check("echo", echo(property), { value: input })).toEqual({ ok: true, value: { value: expected } }),
    )
  })

  test("a single value becomes a one-item array", () => {
    expect(PiArgs.check("edit", PiEdit.SCHEMA, { path: "f", edits: { oldText: "a", newText: 1 } })).toEqual({
      ok: true,
      value: { path: "f", edits: [{ oldText: "a", newText: "1" }] },
    })
    expect(PiArgs.check("edit", PiEdit.SCHEMA, { path: "f", edits: "a -> b" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("  - edits.0: expected object, got string\n"),
    })
  })

  test("values that do not convert are reported", () => {
    const cases: ReadonlyArray<readonly [PiArgs.Property, unknown, string]> = [
      [{ type: "number" }, "abc", "expected number, got string"],
      [{ type: "number" }, [1], "expected number, got array"],
      [{ type: "string" }, { a: 1 }, "expected string, got object"],
      [{ type: "string" }, ["ls"], "expected string, got array"],
    ]
    cases.forEach(([property, input, message]) =>
      expect(PiArgs.check("echo", echo(property), { value: input })).toMatchObject({
        ok: false,
        message: expect.stringContaining(`  - value: ${message}\n`),
      }),
    )
  })

  test("lists pi-schema's errors, then the arguments it received", () => {
    expect(PiArgs.check("echo", echo({ type: "number" }), { value: "many" })).toEqual({
      ok: false,
      message:
        'Validation failed for tool "echo":\n  - value: expected number, got string\n\nReceived arguments:\n{\n  "value": "many"\n}',
    })
  })

  test("a failure reads as Pi's, naming the tool the model called: each missing property on its own line", () => {
    const failed = PiArgs.check("edit", PiEdit.SCHEMA, { edits: [{ oldText: 1 }] })
    expect(failed).toEqual({
      ok: false,
      message: [
        'Validation failed for tool "edit":',
        "  - path: missing",
        "  - edits.0.newText: missing",
        "",
        "Received arguments:",
        JSON.stringify({ edits: [{ oldText: 1 }] }, null, 2),
      ].join("\n"),
    })
    expect(PiArgs.check("write", PiWrite.SCHEMA, {})).toMatchObject({
      ok: false,
      message: expect.stringContaining("  - path: missing\n  - content: missing\n"),
    })
    expect(PiArgs.check("bash", PiBash.SCHEMA, { command: ["ls"] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("  - command: expected string, got array"),
    })
  })

  test("a whole number is named an integer, a value that is no object is reported at the root", () => {
    expect(PiArgs.check("edit", PiEdit.SCHEMA, { path: "f", edits: [5] })).toMatchObject({
      ok: false,
      message: expect.stringContaining("  - edits.0: expected object, got integer\n"),
    })
    expect(PiArgs.check("read", PiRead.SCHEMA, "f.txt")).toMatchObject({
      ok: false,
      message: expect.stringContaining("  - root: expected object, got string\n"),
    })
  })
})
