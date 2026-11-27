// Ports the tests of codex-rs/apply-patch/src/parser.rs and codex-rs/apply-patch/src/streaming_parser.rs.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { ApplyPatch } from "../../../src/codex/apply-patch/index.js"

type Chunk = ApplyPatch.UpdateFileChunk

function chunk(fields: Partial<Chunk>): Chunk {
  return { changeContext: undefined, oldLines: [], newLines: [], contextLineIndices: [], isEndOfFile: false, ...fields }
}

function add(file: string, contents: string): ApplyPatch.Hunk {
  return { type: "add", path: file, contents }
}

function del(file: string): ApplyPatch.Hunk {
  return { type: "delete", path: file }
}

function update(file: string, chunks: Array<Chunk>, movePath?: string): ApplyPatch.Hunk {
  return { type: "update", path: file, movePath, chunks }
}

function parseError(run: () => unknown) {
  try {
    run()
  } catch (error) {
    if (error instanceof ApplyPatch.PatchParseError)
      return { kind: error.kind, detail: error.detail, lineNumber: error.lineNumber, message: error.message }
    throw error
  }
  throw new Error("expected a PatchParseError")
}

function invalidPatch(detail: string) {
  return { kind: "invalid_patch" as const, detail, lineNumber: undefined, message: `invalid patch: ${detail}` }
}

function invalidHunk(detail: string, lineNumber: number) {
  return { kind: "invalid_hunk" as const, detail, lineNumber, message: `invalid hunk at line ${lineNumber}, ${detail}` }
}

const FIRST_LINE = "The first line of the patch must be '*** Begin Patch'"
const LAST_LINE = "The last line of the patch must be '*** End Patch'"

describe("parser.rs", () => {
  test("test_parse_patch", () => {
    expect(parseError(() => ApplyPatch.parsePatch("bad", "strict"))).toEqual(invalidPatch(FIRST_LINE))
    expect(parseError(() => ApplyPatch.parsePatch("*** Begin Patch\nbad", "strict"))).toEqual(invalidPatch(LAST_LINE))
    expect(ApplyPatch.parsePatch("*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch", "strict").hunks).toEqual([
      add("foo", "hi\n"),
    ])
    expect(
      parseError(() => ApplyPatch.parsePatch("*** Begin Patch\n*** Update File: test.py\n*** End Patch", "strict")),
    ).toEqual(invalidHunk("Update file hunk for path 'test.py' is empty", 2))
    expect(ApplyPatch.parsePatch("*** Begin Patch\n*** End Patch", "strict").hunks).toEqual([])
    expect(
      ApplyPatch.parsePatch(
        "*** Begin Patch\n*** Add File: path/add.py\n+abc\n+def\n*** Delete File: path/delete.py\n*** Update File: path/update.py\n*** Move to: path/update2.py\n@@ def f():\n-    pass\n+    return 123\n*** End Patch",
        "strict",
      ).hunks,
    ).toEqual([
      add("path/add.py", "abc\ndef\n"),
      del("path/delete.py"),
      update(
        "path/update.py",
        [chunk({ changeContext: "def f():", oldLines: ["    pass"], newLines: ["    return 123"] })],
        "path/update2.py",
      ),
    ])
    // Update hunk followed by another hunk (Add File).
    expect(
      ApplyPatch.parsePatch(
        "*** Begin Patch\n*** Update File: file.py\n@@\n+line\n*** Add File: other.py\n+content\n*** End Patch",
        "strict",
      ).hunks,
    ).toEqual([update("file.py", [chunk({ newLines: ["line"] })]), add("other.py", "content\n")])
    // Update hunk without an explicit @@ header for the first chunk should parse.
    expect(
      ApplyPatch.parsePatch("*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch", "strict")
        .hunks,
    ).toEqual([
      update("file2.py", [
        chunk({ oldLines: ["import foo"], newLines: ["import foo", "bar"], contextLineIndices: [[0, 0]] }),
      ]),
    ])
  })

  test("test_parse_patch_preserves_end_of_file_marker", () => {
    const patch = "*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch"
    expect(ApplyPatch.parsePatch(patch)).toEqual({
      hunks: [update("file.txt", [chunk({ newLines: ["quux"], isEndOfFile: true })])],
      patch,
      environmentId: undefined,
    })
  })

  test("test_parse_patch_accepts_relative_and_absolute_hunk_paths", () => {
    const absoluteDelete = path.join(os.tmpdir(), "absolute-delete.py")
    const absoluteUpdate = path.join(os.tmpdir(), "absolute-update.py")
    const patch = `*** Begin Patch
*** Add File: relative-add.py
+content
*** Delete File: ${absoluteDelete}
*** Update File: ${absoluteUpdate}
@@
-old
+new
*** End Patch`
    expect(ApplyPatch.parsePatch(patch, "strict").hunks).toEqual([
      add("relative-add.py", "content\n"),
      del(absoluteDelete),
      update(absoluteUpdate, [chunk({ oldLines: ["old"], newLines: ["new"] })]),
    ])
  })

  test("test_parse_patch_lenient", () => {
    const patchText = "*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch"
    const expected = {
      hunks: [
        update("file2.py", [
          chunk({ oldLines: ["import foo"], newLines: ["import foo", "bar"], contextLineIndices: [[0, 0]] }),
        ]),
      ],
      patch: patchText,
      environmentId: undefined,
    }
    for (const opener of ["<<EOF", "<<'EOF'", '<<"EOF"']) {
      const wrapped = `${opener}\n${patchText}\nEOF\n`
      expect(parseError(() => ApplyPatch.parsePatch(wrapped, "strict"))).toEqual(invalidPatch(FIRST_LINE))
      expect(ApplyPatch.parsePatch(wrapped, "lenient")).toEqual(expected)
    }
    const mismatched = `<<"EOF'\n${patchText}\nEOF\n`
    expect(parseError(() => ApplyPatch.parsePatch(mismatched, "strict"))).toEqual(invalidPatch(FIRST_LINE))
    expect(parseError(() => ApplyPatch.parsePatch(mismatched, "lenient"))).toEqual(invalidPatch(FIRST_LINE))
    const missingClose = "<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n"
    expect(parseError(() => ApplyPatch.parsePatch(missingClose, "strict"))).toEqual(invalidPatch(FIRST_LINE))
    expect(parseError(() => ApplyPatch.parsePatch(missingClose, "lenient"))).toEqual(invalidPatch(LAST_LINE))
  })

  test("test_parse_patch_environment_id_preamble", () => {
    const patch = "*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch"
    expect(ApplyPatch.parsePatch(patch, "strict")).toEqual({
      hunks: [add("hello.txt", "hello\n")],
      patch,
      environmentId: "remote",
    })
    expect(
      parseError(() =>
        ApplyPatch.parsePatch(
          "*** Begin Patch\n*** Environment ID:   \n*** Add File: hello.txt\n+hello\n*** End Patch",
          "strict",
        ),
      ),
    ).toEqual(invalidPatch("apply_patch environment_id cannot be empty"))
  })
})

describe("streaming_parser.rs", () => {
  test("test_streaming_patch_parser_streams_complete_lines_before_end_patch", () => {
    const first = new ApplyPatch.StreamingPatchParser()
    expect(first.pushDelta("*** Begin Patch\n*** Add File: src/hello.txt\n+hello\n+wor")).toEqual([
      add("src/hello.txt", "hello\n"),
    ])
    expect(first.pushDelta("ld\n")).toEqual([add("src/hello.txt", "hello\nworld\n")])

    const second = new ApplyPatch.StreamingPatchParser()
    expect(
      second.pushDelta("*** Begin Patch\n*** Update File: src/old.rs\n*** Move to: src/new.rs\n@@\n-old\n+new\n"),
    ).toEqual([update("src/old.rs", [chunk({ oldLines: ["old"], newLines: ["new"] })], "src/new.rs")])

    const third = new ApplyPatch.StreamingPatchParser()
    expect(third.pushDelta("*** Begin Patch\n*** Delete File: gone.txt")).toEqual([])
    expect(third.pushDelta("\n")).toEqual([del("gone.txt")])

    const fourth = new ApplyPatch.StreamingPatchParser()
    expect(
      fourth.pushDelta("*** Begin Patch\n*** Add File: src/one.txt\n+one\n*** Delete File: src/two.txt\n"),
    ).toEqual([add("src/one.txt", "one\n"), del("src/two.txt")])
  })

  test("test_streaming_patch_parser_environment_id_mode", () => {
    const parser = new ApplyPatch.StreamingPatchParser()
    expect(
      parser.pushDelta(
        "*** Begin Patch\n*** Environment ID: remote\n*** Add File: src/hello.txt\n+hello\n*** End Patch\n",
      ),
    ).toEqual([add("src/hello.txt", "hello\n")])
    expect(parser.environmentId()).toBe("remote")

    expect(
      parseError(() =>
        new ApplyPatch.StreamingPatchParser().pushDelta(
          "*** Begin Patch\n*** Environment ID: first\n*** Environment ID: second\n",
        ),
      ),
    ).toEqual(invalidPatch("apply_patch environment_id cannot be specified more than once"))
    expect(
      parseError(() => new ApplyPatch.StreamingPatchParser().pushDelta("*** Begin Patch\n*** Environment ID:   \n")),
    ).toEqual(invalidPatch("apply_patch environment_id cannot be empty"))
  })

  test("test_streaming_patch_parser_large_patch_split_by_character", () => {
    const patch = `*** Begin Patch
*** Add File: docs/release-notes.md
+# Release notes
+
+## CLI
+- Surface apply_patch progress while arguments stream.
+- Keep final patch application gated on the completed tool call.
+- Include file summaries in the progress event payload.
*** Update File: src/config.rs
@@ impl Config
-    pub apply_patch_progress: bool,
+    pub stream_apply_patch_progress: bool,
     pub include_diagnostics: bool,
@@ fn default_progress_interval()
-    Duration::from_millis(500)
+    Duration::from_millis(250)
*** Delete File: src/legacy_patch_progress.rs
*** Update File: crates/cli/src/main.rs
*** Move to: crates/cli/src/bin/codex.rs
@@ fn run()
-    let args = Args::parse();
-    dispatch(args)
+    let cli = Cli::parse();
+    dispatch(cli)
*** Add File: tests/fixtures/apply_patch_progress.json
+{
+  "type": "apply_patch_progress",
+  "hunks": [
+    { "operation": "add", "path": "docs/release-notes.md" },
+    { "operation": "update", "path": "src/config.rs" }
+  ]
+}
*** Update File: README.md
@@ Development workflow
 Build the Rust workspace before opening a pull request.
+When touching streamed tool calls, include parser coverage for partial input.
+Prefer tests that exercise the exact event payload shape.
*** Delete File: docs/old-apply-patch-progress.md
*** End Patch`
    const parser = new ApplyPatch.StreamingPatchParser()
    const state = { max: 0, seen: [] as Array<number>, hunks: [] as Array<ApplyPatch.Hunk> }
    for (const character of patch) {
      const hunks = parser.pushDelta(character)
      if (hunks.length === 0) continue
      expect(hunks.length).toBeGreaterThanOrEqual(state.max)
      if (hunks.length > state.max) {
        state.seen.push(hunks.length)
        state.max = hunks.length
      }
      state.hunks = hunks
    }
    expect(state.seen).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(state.hunks.length).toBe(7)
    expect(
      state.hunks.map((hunk) =>
        hunk.type === "update" ? (hunk.movePath === undefined ? "update" : "move-update") : hunk.type,
      ),
    ).toEqual(["add", "update", "delete", "move-update", "add", "update", "delete"])
  })

  test("test_streaming_patch_parser_keeps_indented_update_markers_as_context_lines", () => {
    const parser = new ApplyPatch.StreamingPatchParser()
    expect(
      parser.pushDelta(
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n *** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch\n",
      ),
    ).toEqual([
      update("a.txt", [
        chunk({
          oldLines: ["old a", "*** Update File: b.txt"],
          newLines: ["new a", "*** Update File: b.txt"],
          contextLineIndices: [[1, 1]],
        }),
        chunk({ oldLines: ["old b"], newLines: ["new b"] }),
      ]),
    ])
  })

  test("test_streaming_patch_parser_preserves_bare_empty_update_lines", () => {
    const parser = new ApplyPatch.StreamingPatchParser()
    expect(
      parser.pushDelta(
        "*** Begin Patch\n*** Update File: file.txt\n@@\n context before\n\n context after\n*** End Patch\n",
      ),
    ).toEqual([
      update("file.txt", [
        chunk({
          oldLines: ["context before", "", "context after"],
          newLines: ["context before", "", "context after"],
          contextLineIndices: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        }),
      ]),
    ])
  })

  test("test_streaming_patch_parser_ignores_empty_lines_after_end_of_file", () => {
    const parser = new ApplyPatch.StreamingPatchParser()
    expect(
      parser.pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch\n"),
    ).toEqual([update("file.txt", [chunk({ newLines: ["quux"], isEndOfFile: true })])])
  })

  test("test_streaming_patch_parser_matches_line_ending_behavior", () => {
    expect(
      new ApplyPatch.StreamingPatchParser().pushDelta(
        "*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n",
      ),
    ).toEqual([update("file.txt", [chunk({ oldLines: ["old"], newLines: ["new"] })])])
    expect(
      new ApplyPatch.StreamingPatchParser().pushDelta(
        "*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\r\n+new\r\n*** End Patch\r\n",
      ),
    ).toEqual([update("file.txt", [chunk({ oldLines: ["old\r"], newLines: ["new"] })])])
  })

  test("test_streaming_patch_parser_finish_processes_final_line_without_newline", () => {
    const first = new ApplyPatch.StreamingPatchParser()
    expect(first.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch")).toEqual([
      add("file.txt", "hello\n"),
    ])
    expect(first.finish()).toEqual([add("file.txt", "hello\n")])

    const second = new ApplyPatch.StreamingPatchParser()
    const expected = [update("file.txt", [chunk({ oldLines: ["old"], newLines: ["new"] })])]
    expect(second.pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n *** End Patch")).toEqual(
      expected,
    )
    expect(second.finish()).toEqual(expected)
  })

  test("test_streaming_patch_parser_finish_requires_end_patch", () => {
    const parser = new ApplyPatch.StreamingPatchParser()
    expect(parser.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hello\n")).toEqual([add("file.txt", "hello\n")])
    expect(parseError(() => parser.finish())).toEqual(invalidPatch(LAST_LINE))
  })

  test("test_streaming_patch_parser_rejects_content_after_end_patch", () => {
    expect(
      parseError(() =>
        new ApplyPatch.StreamingPatchParser().pushDelta(
          "*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch\nextra\n",
        ),
      ),
    ).toEqual(invalidPatch(LAST_LINE))
    expect(
      new ApplyPatch.StreamingPatchParser().pushDelta(
        "*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch\n \t\n",
      ),
    ).toEqual([add("file.txt", "hello\n")])
  })

  test("finish rejects an unterminated line after the end marker", () => {
    const parser = new ApplyPatch.StreamingPatchParser()
    parser.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch\nextra")
    expect(parseError(() => parser.finish())).toEqual(invalidPatch(LAST_LINE))
  })

  test("test_streaming_patch_parser_returns_errors", () => {
    const header = (line: string) =>
      `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`
    const fresh = () => new ApplyPatch.StreamingPatchParser()
    expect(parseError(() => fresh().pushDelta("bad\n"))).toEqual(invalidPatch(FIRST_LINE))

    const started = fresh()
    expect(started.pushDelta("*** Begin Patch\n")).toEqual([])
    expect(parseError(() => started.pushDelta("bad\n"))).toEqual(invalidHunk(header("bad"), 2))

    expect(parseError(() => fresh().pushDelta("*** Begin Patch\n*** Add File: file.txt\nbad\n"))).toEqual(
      invalidHunk(header("bad"), 3),
    )
    expect(parseError(() => fresh().pushDelta("*** Begin Patch\n*** Delete File: file.txt\nbad\n"))).toEqual(
      invalidHunk(header("bad"), 3),
    )
    expect(parseError(() => fresh().pushDelta("*** Begin Patch\n*** Update File: file.txt\n*** End Patch\n"))).toEqual(
      invalidHunk("Update file hunk for path 'file.txt' is empty", 2),
    )
    expect(
      parseError(() =>
        fresh().pushDelta(
          "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** Delete File: other.txt\n",
        ),
      ),
    ).toEqual(invalidHunk("Update file hunk for path 'old.txt' is empty", 2))
    expect(
      parseError(() => fresh().pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n*** End Patch\n")),
    ).toEqual(invalidHunk("Update hunk does not contain any lines", 4))
    expect(
      parseError(() => fresh().pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n*** End of File\n")),
    ).toEqual(invalidHunk("Update hunk does not contain any lines", 4))
    expect(parseError(() => fresh().pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n@@\n"))).toEqual(
      invalidHunk(
        "Unexpected line found in update hunk: '@@'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)",
        4,
      ),
    )
    expect(parseError(() => fresh().pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n-old\nbad\n"))).toEqual(
      invalidHunk("Expected update hunk to start with a @@ context marker, got: 'bad'", 5),
    )
    expect(
      parseError(() =>
        fresh().pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n*** Update File: other.txt\n"),
      ),
    ).toEqual(
      invalidHunk(
        "Unexpected line found in update hunk: '*** Update File: other.txt'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)",
        4,
      ),
    )
  })
})

describe("Rust string semantics", () => {
  test("markers are trimmed with Rust's whitespace set (U+0085 yes, U+FEFF no)", () => {
    expect(ApplyPatch.parsePatch("\u0085*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\u0085").hunks).toEqual([
      add("a", "x\n"),
    ])
    expect(parseError(() => ApplyPatch.parsePatch("﻿*** Begin Patch\n*** End Patch"))).toEqual(invalidPatch(FIRST_LINE))
  })
})
