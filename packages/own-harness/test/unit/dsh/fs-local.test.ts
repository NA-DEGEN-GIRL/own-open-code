// dsh's home prefix (src/dsh/fs.ts `resolve`): a leading `~` names the home folder, not a folder of the workspace.
// Cases follow upstream f3803c9697 packages/fs/fs-local/tests/filesystem.spec.ts "home prefix" (ae0dfd1003,
// 32004176bf); own has no directory listing, so the literal `~` entry is reached as `./~` instead.
// The write failures (src/dsh/fs.ts `writeAtomic`) follow upstream 66491b05e3 packages/fs/fs-local/tests/fsio.spec.ts
// "atomic write failures" (9b154c04a6, 8f798da97d, 7fab3cf976), plus a read-only file, which Windows refuses to
// replace; upstream's injected staging defects need test hooks own's port does not have.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ f3803c9697 and 66491b05e3; see
// dsh-data/NOTICE.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DshFs } from "../../../src/dsh/fs.js"
import { DshObserve } from "../../../src/dsh/observe.js"

const state = { home: "", dir: "", saved: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE } }

beforeEach(() => {
  state.home = mkdtempSync(path.join(tmpdir(), "own-dsh-home-"))
  state.dir = mkdtempSync(path.join(tmpdir(), "own-dsh-ws-"))
  state.saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  // os.homedir() reads HOME on Unix and USERPROFILE on Windows when it is called.
  process.env.HOME = state.home
  process.env.USERPROFILE = state.home
  writeFileSync(path.join(state.home, "note.txt"), "home note")
})

afterEach(() => {
  restore("HOME", state.saved.HOME)
  restore("USERPROFILE", state.saved.USERPROFILE)
  rmSync(state.home, { recursive: true, force: true })
  rmSync(state.dir, { recursive: true, force: true })
})

const resolved = async (file: string) => (await DshFs.resolve(file, state.dir)).displayPath

describe("home prefix", () => {
  test("a leading ~ resolves against the home folder", async () => {
    expect(await resolved("~")).toBe(state.home)
    const note = await DshFs.resolve("~/note.txt", state.dir)
    expect(note.displayPath).toBe(path.join(state.home, "note.txt"))
    const read = await DshFs.read(note, { offset: 1, limit: DshFs.READ_LIMIT })
    expect(read.text).toContain("1: home note")
    expect(await resolved("~/missing.txt")).toBe(path.join(state.home, "missing.txt"))
  })

  test("~user and a later ~ segment stay relative to the workspace", async () => {
    expect(await resolved("~user/x.txt")).toBe(path.join(state.dir, "~user", "x.txt"))
    expect(await resolved("a/~/b.txt")).toBe(path.join(state.dir, "a", "~", "b.txt"))
  })

  test(".. after ~/ resolves from the home folder", async () => {
    mkdirSync(path.join(state.home, "sub"))
    const target = await DshFs.resolve("~/sub/../note.txt", state.dir)
    expect(target.displayPath).toBe(path.join(state.home, "note.txt"))
    expect((await DshFs.read(target, { offset: 1, limit: DshFs.READ_LIMIT })).text).toContain("1: home note")
  })

  test.skipIf(process.platform === "win32")("~\\ stays literal outside Windows", async () => {
    expect(await resolved("~\\note.txt")).toBe(path.join(state.dir, "~\\note.txt"))
  })

  test.skipIf(process.platform !== "win32")("~\\ is the home prefix on Windows", async () => {
    expect(await resolved("~\\note.txt")).toBe(path.join(state.home, "note.txt"))
  })

  test("a workspace folder literally named ~ is still reached as ./~", async () => {
    mkdirSync(path.join(state.dir, "~"))
    writeFileSync(path.join(state.dir, "~", "x.txt"), "inside")
    const target = await DshFs.resolve("./~/x.txt", state.dir)
    expect(target.displayPath).toBe(path.join(state.dir, "~", "x.txt"))
    expect(readFileSync(target.key, "utf8")).toBe("inside")
  })
})

describe("atomic write failures (upstream 66491b05e3)", () => {
  const created = { existed: false, version: undefined }

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a denied parent and staging creation are typed permission failures",
    async () => {
      const locked = path.join(state.dir, "locked")
      mkdirSync(locked, { mode: 0o555 })
      try {
        for (const file of [path.join(locked, "file"), path.join(locked, "missing", "file")]) {
          const failure = await failed(DshFs.write(await DshFs.resolve(file, state.dir), "content", created))
          expect(failure.code).toBe("FS_PERMISSION_DENIED")
          expect(failure.message).toBe(`cannot write "${file}": permission denied`)
        }
        expect(readdirSync(locked)).toEqual([])
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )

  test("a parent path blocked by a regular file is FS_IO_ERROR with the OS's message, on every platform", async () => {
    writeFileSync(path.join(state.dir, "blocker"), "file")
    const target = await DshFs.resolve("blocker/child", state.dir)
    const failure = await failed(DshFs.write(target, "content", created))
    expect(failure.code).toBe("FS_IO_ERROR")
    expect(failure.cause).toBeInstanceOf(Error)
    expect(failure.cause).toMatchObject({ code: expect.any(String) })
    expect(failure.message).toBe(`cannot write "${target.displayPath}": ${(failure.cause as Error).message}`)
    expect(readFileSync(path.join(state.dir, "blocker"), "utf8")).toBe("file")
  })

  // POSIX replaces a read-only file in a writable folder (a rename needs only the folder's permission), as upstream does.
  test.skipIf(process.platform !== "win32")(
    "Windows refuses to replace a read-only file: permission denied, the file kept, no staging folder left",
    async () => {
      const file = path.join(state.dir, "readonly.txt")
      writeFileSync(file, "keep\n")
      chmodSync(file, 0o444)
      try {
        const target = await DshFs.resolve(file, state.dir)
        const version = (await DshObserve.probe(target.key))!.version
        const planned = await DshFs.planWrite(target, { kind: "replaceIfVersion", version })
        const failure = await failed(DshFs.write(target, "new\n", planned))
        expect(failure.code).toBe("FS_PERMISSION_DENIED")
        expect(failure.message).toBe(`cannot write "${file}": permission denied`)
        expect(failure.cause).toMatchObject({ code: "EPERM" })
        expect(readFileSync(file, "utf8")).toBe("keep\n")
        expect(readdirSync(state.dir)).toEqual(["readonly.txt"])
      } finally {
        chmodSync(file, 0o644)
      }
    },
  )
})

/** The typed failure a write rejects with. */
async function failed(write: Promise<unknown>) {
  const error = await write.then(
    () => undefined,
    (error: unknown) => error,
  )
  if (error instanceof DshObserve.FsError) return error
  throw new Error(`expected a typed write failure, got ${String(error)}`)
}

function restore(name: "HOME" | "USERPROFILE", value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
