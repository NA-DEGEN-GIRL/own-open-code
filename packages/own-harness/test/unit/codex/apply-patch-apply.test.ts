// Ports the tests of codex-rs/apply-patch/src/lib.rs, codex-rs/apply-patch/src/file_update_tests.rs, and the
// verification tests of codex-rs/apply-patch/src/invocation.rs, plus Codex's error texts.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ApplyPatch } from "../../../src/codex/apply-patch/index.js"
import { PatchIo } from "../../../src/codex/apply-patch/io.js"

const state = { dir: "" }

beforeEach(async () => {
  state.dir = await mkdtemp(path.join(os.tmpdir(), "codex-apply-patch-"))
})

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true })
})

function wrapPatch(body: string) {
  return `*** Begin Patch\n${body}\n*** End Patch`
}

function file(name: string) {
  return path.join(state.dir, name)
}

async function read(name: string) {
  return readFile(file(name), "utf8")
}

async function failure(run: () => Promise<unknown>) {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  if (error instanceof ApplyPatch.ApplyPatchError) return error
  throw new Error(`expected an ApplyPatchError, got ${String(error)}`)
}

describe("lib.rs", () => {
  test("test_add_file_hunk_creates_file_with_contents", async () => {
    const target = file("add.txt")
    const result = await ApplyPatch.applyPatch(wrapPatch(`*** Add File: ${target}\n+ab\n+cd`), state.dir)
    expect(result.text).toBe(`Success. Updated the following files:\nA ${target}\n`)
    expect(await read("add.txt")).toBe("ab\ncd\n")
  })

  test("test_apply_patch_hunks_accept_relative_and_absolute_paths", async () => {
    await writeFile(file("relative-delete.txt"), "delete relative\n")
    await writeFile(file("absolute-delete.txt"), "delete absolute\n")
    await writeFile(file("relative-update.txt"), "relative old\n")
    await writeFile(file("absolute-update.txt"), "absolute old\n")
    const patch = wrapPatch(`*** Add File: relative-add.txt
+relative add
*** Add File: ${file("absolute-add.txt")}
+absolute add
*** Delete File: relative-delete.txt
*** Delete File: ${file("absolute-delete.txt")}
*** Update File: relative-update.txt
@@
-relative old
+relative new
*** Update File: ${file("absolute-update.txt")}
@@
-absolute old
+absolute new`)
    const result = await ApplyPatch.applyPatch(patch, state.dir)
    expect(await read("relative-add.txt")).toBe("relative add\n")
    expect(await read("absolute-add.txt")).toBe("absolute add\n")
    expect(existsSync(file("relative-delete.txt"))).toBe(false)
    expect(existsSync(file("absolute-delete.txt"))).toBe(false)
    expect(await read("relative-update.txt")).toBe("relative new\n")
    expect(await read("absolute-update.txt")).toBe("absolute new\n")
    expect(result.text).toBe(
      `Success. Updated the following files:\nA relative-add.txt\nA ${file("absolute-add.txt")}\nM relative-update.txt\nM ${file("absolute-update.txt")}\nD relative-delete.txt\nD ${file("absolute-delete.txt")}\n`,
    )
    expect(result.summary).toEqual({
      added: ["relative-add.txt", file("absolute-add.txt")],
      modified: ["relative-update.txt", file("absolute-update.txt")],
      deleted: ["relative-delete.txt", file("absolute-delete.txt")],
    })
  })

  test("test_delete_file_hunk_removes_file", async () => {
    await writeFile(file("del.txt"), "x")
    const result = await ApplyPatch.applyPatch(wrapPatch(`*** Delete File: ${file("del.txt")}`), state.dir)
    expect(result.text).toBe(`Success. Updated the following files:\nD ${file("del.txt")}\n`)
    expect(existsSync(file("del.txt"))).toBe(false)
  })

  test("test_update_file_hunk_modifies_content", async () => {
    await writeFile(file("update.txt"), "foo\nbar\n")
    const result = await ApplyPatch.applyPatch(
      wrapPatch(`*** Update File: ${file("update.txt")}\n@@\n foo\n-bar\n+baz`),
      state.dir,
    )
    expect(result.text).toBe(`Success. Updated the following files:\nM ${file("update.txt")}\n`)
    expect(await read("update.txt")).toBe("foo\nbaz\n")
  })

  test("test_update_file_hunk_can_move_file", async () => {
    await writeFile(file("src.txt"), "line\n")
    const result = await ApplyPatch.applyPatch(
      wrapPatch(`*** Update File: ${file("src.txt")}\n*** Move to: ${file("dst.txt")}\n@@\n-line\n+line2`),
      state.dir,
    )
    expect(result.text).toBe(`Success. Updated the following files:\nM ${file("dst.txt")}\n`)
    expect(existsSync(file("src.txt"))).toBe(false)
    expect(await read("dst.txt")).toBe("line2\n")
  })

  // Codex locks the source directory with chmod 0555 (Unix only); a filesystem whose unlink fails stands in for it.
  test("test_failed_move_returns_committed_destination_delta", async () => {
    await mkdir(file("locked"))
    await mkdir(file("out"))
    await writeFile(file("locked/src.txt"), "line\n")
    const fs: ApplyPatch.PatchFs = {
      ...ApplyPatch.nodeFs,
      unlink: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
    }
    const error = await failure(() =>
      ApplyPatch.applyPatch(
        wrapPatch("*** Update File: locked/src.txt\n*** Move to: out/dst.txt\n@@\n-line\n+line2"),
        state.dir,
        fs,
      ),
    )
    expect(error.kind).toBe("apply")
    expect(error.message).toBe(`Failed to remove original ${file("locked/src.txt")}`)
    expect(await read("locked/src.txt")).toBe("line\n")
    expect(await read("out/dst.txt")).toBe("line2\n")
  })

  test("test_multiple_update_chunks_apply_to_single_file", async () => {
    await writeFile(file("multi.txt"), "foo\nbar\nbaz\nqux\n")
    const result = await ApplyPatch.applyPatch(
      wrapPatch(`*** Update File: ${file("multi.txt")}\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX`),
      state.dir,
    )
    expect(result.text).toBe(`Success. Updated the following files:\nM ${file("multi.txt")}\n`)
    expect(await read("multi.txt")).toBe("foo\nBAR\nbaz\nQUX\n")
  })

  test("test_update_file_hunk_interleaved_changes", async () => {
    await writeFile(file("interleaved.txt"), "a\nb\nc\nd\ne\nf\n")
    const result = await ApplyPatch.applyPatch(
      wrapPatch(
        `*** Update File: ${file("interleaved.txt")}\n@@\n a\n-b\n+B\n@@\n c\n d\n-e\n+E\n@@\n f\n+g\n*** End of File`,
      ),
      state.dir,
    )
    expect(result.text).toBe(`Success. Updated the following files:\nM ${file("interleaved.txt")}\n`)
    expect(await read("interleaved.txt")).toBe("a\nB\nc\nd\nE\nf\ng\n")
  })

  test("test_pure_addition_chunk_followed_by_removal", async () => {
    await writeFile(file("panic.txt"), "line1\nline2\nline3\n")
    await ApplyPatch.applyPatch(
      wrapPatch(
        `*** Update File: ${file("panic.txt")}\n@@\n+after-context\n+second-line\n@@\n line1\n-line2\n-line3\n+line2-replacement`,
      ),
      state.dir,
    )
    expect(await read("panic.txt")).toBe("line1\nline2-replacement\nafter-context\nsecond-line\n")
  })

  test("test_update_line_with_unicode_dash", async () => {
    await writeFile(file("unicode.py"), "import asyncio  # local import – avoids top‑level dep\n")
    const result = await ApplyPatch.applyPatch(
      wrapPatch(
        `*** Update File: ${file("unicode.py")}\n@@\n-import asyncio  # local import - avoids top-level dep\n+import asyncio  # HELLO`,
      ),
      state.dir,
    )
    expect(await read("unicode.py")).toBe("import asyncio  # HELLO\n")
    expect(result.text).toBe(`Success. Updated the following files:\nM ${file("unicode.py")}\n`)
  })

  // Codex makes the directory read-only with chmod (Unix only); a filesystem whose writes fail stands in for it.
  test("test_apply_patch_fails_on_write_error", async () => {
    await mkdir(file("locked"))
    const fs: ApplyPatch.PatchFs = {
      ...ApplyPatch.nodeFs,
      writeFile: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
    }
    const error = await failure(() =>
      ApplyPatch.applyPatch(wrapPatch("*** Add File: locked/new.txt\n+after"), state.dir, fs),
    )
    expect(error.kind).toBe("apply")
    expect(error.message).toBe(`Failed to write file ${file("locked/new.txt")}`)
    expect(existsSync(file("locked/new.txt"))).toBe(false)
  })

  test("test_unreadable_destinations_return_inexact_delta (the patches still apply)", async () => {
    await writeFile(file("source.txt"), "before\n")
    for (const patch of [
      wrapPatch("*** Add File: binary.dat\n+text"),
      wrapPatch("*** Update File: source.txt\n*** Move to: binary.dat\n@@\n-before\n+after"),
    ]) {
      await writeFile(file("binary.dat"), new Uint8Array([0xff, 0xfe, 0xfd]))
      await ApplyPatch.applyPatch(patch, state.dir)
    }
    expect(await read("binary.dat")).toBe("after\n")
  })

  test.skipIf(process.platform === "win32")(
    "test_delete_symlink_returns_inexact_delta (the link is deleted)",
    async () => {
      await writeFile(file("target.txt"), "target\n")
      await symlink(file("target.txt"), file("link.txt"))
      await ApplyPatch.applyPatch(wrapPatch("*** Delete File: link.txt"), state.dir)
      expect(existsSync(file("link.txt"))).toBe(false)
      expect(await read("target.txt")).toBe("target\n")
    },
  )
})

describe("file_update_tests.rs (contents; Codex's unified diff text is not ported)", () => {
  async function update(name: string, original: string, body: string) {
    await writeFile(file(name), original)
    const changes = await ApplyPatch.derivePatch(wrapPatch(`*** Update File: ${file(name)}\n${body}`), state.dir)
    expect(changes.length).toBe(1)
    return changes[0]!
  }

  test("test_unified_diff", async () => {
    expect(await update("multi.txt", "foo\nbar\nbaz\nqux\n", "@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX")).toEqual({
      path: file("multi.txt"),
      kind: "update",
      oldContent: "foo\nbar\nbaz\nqux\n",
      newContent: "foo\nBAR\nbaz\nQUX\n",
    })
  })

  test("test_unified_diff_first_line_replacement", async () => {
    expect(await update("first.txt", "foo\nbar\nbaz\n", "@@\n-foo\n+FOO\n bar\n")).toMatchObject({
      oldContent: "foo\nbar\nbaz\n",
      newContent: "FOO\nbar\nbaz\n",
    })
  })

  test("test_unified_diff_last_line_replacement", async () => {
    expect(await update("last.txt", "foo\nbar\nbaz\n", "@@\n foo\n bar\n-baz\n+BAZ\n")).toMatchObject({
      oldContent: "foo\nbar\nbaz\n",
      newContent: "foo\nbar\nBAZ\n",
    })
  })

  test("test_unified_diff_insert_at_eof", async () => {
    expect(await update("insert.txt", "foo\nbar\nbaz\n", "@@\n+quux\n*** End of File\n")).toMatchObject({
      oldContent: "foo\nbar\nbaz\n",
      newContent: "foo\nbar\nbaz\nquux\n",
    })
  })

  test("test_unified_diff_interleaved_changes", async () => {
    const body = "@@\n a\n-b\n+B\n@@\n d\n-e\n+E\n@@\n f\n+g\n*** End of File"
    expect(await update("interleaved.txt", "a\nb\nc\nd\ne\nf\n", body)).toMatchObject({
      oldContent: "a\nb\nc\nd\ne\nf\n",
      newContent: "a\nB\nc\nd\nE\nf\ng\n",
    })
    await ApplyPatch.applyPatch(wrapPatch(`*** Update File: ${file("interleaved.txt")}\n${body}`), state.dir)
    expect(await read("interleaved.txt")).toBe("a\nB\nc\nd\nE\nf\ng\n")
  })

  test("derivePatch writes nothing", async () => {
    await writeFile(file("keep.txt"), "old\n")
    const changes = await ApplyPatch.derivePatch(
      wrapPatch("*** Add File: new.txt\n+x\n*** Update File: keep.txt\n*** Move to: moved.txt\n@@\n-old\n+new"),
      state.dir,
    )
    expect(changes).toEqual([
      { path: file("new.txt"), kind: "add", newContent: "x\n" },
      { path: file("keep.txt"), kind: "update", movePath: file("moved.txt"), oldContent: "old\n", newContent: "new\n" },
    ])
    expect(existsSync(file("new.txt"))).toBe(false)
    expect(existsSync(file("moved.txt"))).toBe(false)
    expect(await read("keep.txt")).toBe("old\n")
  })
})

describe("invocation.rs verification", () => {
  test("test_apply_patch_should_resolve_absolute_paths_in_cwd", async () => {
    await writeFile(file("source.txt"), "session directory content\n")
    const changes = await ApplyPatch.derivePatch(
      "*** Begin Patch\n*** Update File: source.txt\n@@\n-session directory content\n+updated session directory content\n*** End Patch",
      state.dir,
    )
    expect(changes).toEqual([
      {
        path: file("source.txt"),
        kind: "update",
        oldContent: "session directory content\n",
        newContent: "updated session directory content\n",
      },
    ])
  })

  test("test_apply_patch_resolves_move_path_with_effective_cwd", async () => {
    await mkdir(file("alt"))
    await writeFile(file("alt/old.txt"), "before\n")
    const script = `cd alt && apply_patch <<'PATCH'\n${wrapPatch("*** Update File: old.txt\n*** Move to: renamed.txt\n@@\n-before\n+after")}\nPATCH`
    const invocation = ApplyPatch.extractHeredocPatch(script)
    expect(invocation?.workdir).toBe("alt")
    const cwd = path.resolve(state.dir, invocation!.workdir!)
    expect(await ApplyPatch.derivePatch(invocation!.patch, cwd)).toEqual([
      {
        path: file("alt/old.txt"),
        kind: "update",
        movePath: file("alt/renamed.txt"),
        oldContent: "before\n",
        newContent: "after\n",
      },
    ])
  })

  test("test_unreadable_destinations_still_verify", async () => {
    await writeFile(file("binary.dat"), new Uint8Array([0xff, 0xfe, 0xfd]))
    await writeFile(file("source.txt"), "before\n")
    for (const patch of [
      "*** Begin Patch\n*** Add File: binary.dat\n+text\n*** End Patch",
      "*** Begin Patch\n*** Update File: source.txt\n*** Move to: binary.dat\n@@\n-before\n+after\n*** End Patch",
    ])
      expect((await ApplyPatch.derivePatch(patch, state.dir)).length).toBe(1)
  })

  test.skipIf(process.platform === "win32")("test_delete_symlink_still_verifies", async () => {
    await writeFile(file("target.txt"), "target\n")
    await symlink(file("target.txt"), file("link.txt"))
    expect(
      await ApplyPatch.derivePatch("*** Begin Patch\n*** Delete File: link.txt\n*** End Patch", state.dir),
    ).toEqual([{ path: file("link.txt"), kind: "delete", oldContent: "target\n" }])
  })
})

describe("error texts", () => {
  test("verification failures are reported before anything is written", async () => {
    await writeFile(file("modify.txt"), "line1\nline2\n")
    await mkdir(file("dir"))
    await writeFile(file("binary.dat"), new Uint8Array([0x61, 0xff]))
    const cases: Array<[string, string]> = [
      [
        "*** Update File: missing.txt\n@@\n-old\n+new",
        `Failed to read file to update ${file("missing.txt")}: No such file or directory (os error 2)`,
      ],
      ["*** Delete File: missing.txt", `Failed to read ${file("missing.txt")}: No such file or directory (os error 2)`],
      ["*** Delete File: dir", `Failed to read ${file("dir")}: path \`${file("dir")}\` is not a file`],
      [
        "*** Update File: modify.txt\n@@ nowhere\n-line2\n+x",
        `Failed to find context 'nowhere' in ${file("modify.txt")}`,
      ],
      [
        "*** Update File: modify.txt\n@@\n-missing\n-lines\n+x",
        `Failed to find expected lines in ${file("modify.txt")}:\nmissing\nlines`,
      ],
      [
        "*** Update File: binary.dat\n@@\n-a\n+b",
        `Failed to read file to update ${file("binary.dat")}: invalid utf-8 sequence of 1 bytes from index 1`,
      ],
      [
        "*** Add File: modify.txt\n+x\n*** Delete File: ./modify.txt",
        `invalid patch: multiple operations target ${file("modify.txt")}`,
      ],
      [
        "*** Frobnicate File: foo",
        "invalid hunk at line 4, '*** Frobnicate File: foo' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
      ],
    ]
    for (const [body, message] of cases) {
      const error = await failure(() =>
        ApplyPatch.applyPatch(wrapPatch(`*** Add File: created.txt\n+x\n${body}`), state.dir),
      )
      expect({ kind: error.kind, message: error.message }).toEqual({ kind: "verification", message })
      expect(existsSync(file("created.txt"))).toBe(false)
    }
    expect(await read("modify.txt")).toBe("line1\nline2\n")
  })

  test("an empty patch fails when applied", async () => {
    const error = await failure(() => ApplyPatch.applyPatch("*** Begin Patch\n*** End Patch", state.dir))
    expect({ kind: error.kind, message: error.message }).toEqual({ kind: "apply", message: "No files were modified." })
  })

  test("without verification earlier hunks stay applied (standalone apply_patch)", async () => {
    const error = await failure(() =>
      ApplyPatch.applyPatch(
        wrapPatch("*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new"),
        state.dir,
        ApplyPatch.nodeFs,
        { verify: false },
      ),
    )
    expect(error.kind).toBe("apply")
    expect(error.message).toBe(
      `Failed to read file to update ${file("missing.txt")}: No such file or directory (os error 2)`,
    )
    expect(error.partial).toEqual({ added: ["created.txt"], modified: [], deleted: [] })
    expect(await read("created.txt")).toBe("hello\n")
  })

  test("deleting a directory without verification", async () => {
    await mkdir(file("dir"))
    const error = await failure(() =>
      ApplyPatch.applyPatch(wrapPatch("*** Delete File: dir"), state.dir, ApplyPatch.nodeFs, { verify: false }),
    )
    expect(error.message).toBe(`Failed to delete file ${file("dir")}`)
  })

  test("Node error codes map to Rust's Unix io::Error texts", () => {
    const osError = (code: string) => Object.assign(new Error(code), { code })
    expect(ApplyPatch.describeIoError(osError("ENOENT"))).toBe("No such file or directory (os error 2)")
    expect(ApplyPatch.describeIoError(osError("EACCES"))).toBe("Permission denied (os error 13)")
    expect(ApplyPatch.describeIoError(osError("EISDIR"))).toBe("Is a directory (os error 21)")
    expect(ApplyPatch.describeIoError(osError("ENOTDIR"))).toBe("Not a directory (os error 20)")
    expect(ApplyPatch.describeIoError(osError("EPERM"))).toBe("Operation not permitted (os error 1)")
    expect(ApplyPatch.describeIoError(osError("ENOSPC"))).toBe("No space left on device (os error 28)")
  })

  test("UTF-8 errors use Rust's Utf8Error display", () => {
    const message = (bytes: Array<number>) => PatchIo.utf8ErrorMessage(new Uint8Array(bytes))
    expect(message([0xff, 0xfe, 0xfd])).toBe("invalid utf-8 sequence of 1 bytes from index 0")
    expect(message([0x61, 0xe2, 0x82])).toBe("incomplete utf-8 byte sequence from index 1")
    expect(message([0xe2, 0x28, 0xa1])).toBe("invalid utf-8 sequence of 1 bytes from index 0")
    expect(message([0xe2, 0x82, 0x28])).toBe("invalid utf-8 sequence of 2 bytes from index 0")
    expect(message([0xf0, 0x90, 0x80, 0x41])).toBe("invalid utf-8 sequence of 3 bytes from index 0")
    expect(message([0xed, 0xa0, 0x80])).toBe("invalid utf-8 sequence of 1 bytes from index 0")
    expect(message([0xc3])).toBe("incomplete utf-8 byte sequence from index 0")
  })

  test("a byte order mark is kept", async () => {
    await writeFile(file("bom.txt"), "﻿a\nb\n")
    await ApplyPatch.applyPatch(wrapPatch("*** Update File: bom.txt\n@@\n-b\n+c"), state.dir)
    expect(await readFile(file("bom.txt"))).toEqual(Buffer.from("﻿a\nc\n"))
  })
})
