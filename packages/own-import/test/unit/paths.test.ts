import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { Options } from "../../src/options.js"
import { Paths } from "../../src/sources/paths.js"
import {
  claudeFolder,
  codexRollout,
  fixture,
  sentinels,
  stateDb,
  TORN,
  writeJsonl,
  writeText,
  type Fixture,
} from "../fixtures/make.js"
import { start } from "../support/guard.js"

const windows = process.platform === "win32"
const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function make(input?: { readonly under?: string }) {
  const item = await fixture(input)
  fixtures.push(item)
  return item
}

function codexRoot(item: Fixture) {
  return Paths.defaults({ options: { roots: { codex: [item.codex], claude: [] } } })[0]
}

function claudeRoot(item: Fixture) {
  return Paths.defaults({ options: { roots: { codex: [], claude: [item.claude] } } })[0]
}

/** A realpath that knows only the paths in `table` (by key), standing in for drives and links this PC lacks. */
function fakeRealpath(table: Record<string, string>): Paths.Realpath {
  return (input) => table[Paths.key(input)]
}

describe("norm (09 §2.2, IG3 strings)", () => {
  test.each([
    ["extended-length prefix", "\\\\?\\C:\\Users\\a\\proj", "C:\\Users\\a\\proj"],
    ["extended-length UNC", "\\\\?\\UNC\\server\\share\\proj", "\\\\server\\share\\proj"],
    ["extended-length UNC, lower case", "\\\\?\\unc\\server\\share", "\\\\server\\share"],
    ["device prefix", "\\\\.\\C:\\proj", "C:\\proj"],
    ["plain UNC", "\\\\server\\share\\proj\\", "\\\\server\\share\\proj"],
    ["forward slashes", "C:/Users/a/proj", "C:\\Users\\a\\proj"],
    ["repeated separators", "C:\\\\Users\\\\\\a//proj", "C:\\Users\\a\\proj"],
    ["trailing separator", "C:\\Users\\a\\proj\\", "C:\\Users\\a\\proj"],
    ["drive root keeps its separator", "C:\\", "C:\\"],
    ["bare drive", "C:", "C:\\"],
    ["dot segments", "C:\\a\\.\\proj\\..\\other", "C:\\a\\other"],
    ["never above the drive root", "C:\\..\\..\\a", "C:\\a"],
    ["never above the UNC share", "\\\\server\\share\\..\\x", "\\\\server\\share\\x"],
    ["file URI", "file:///C:/Users/a/my%20proj/", "C:\\Users\\a\\my proj"],
    ["file URI with an encoded hash", "file:///D:/%23Projects/own-open-code", "D:\\#Projects\\own-open-code"],
    ["file URI with UTF-8", "file:///C:/%EC%9E%91%EC%97%85", "C:\\작업"],
    ["file URI of a share", "file://server/share/proj", "\\\\server\\share\\proj"],
    ["file URI with localhost", "file://localhost/C:/Users/a", "C:\\Users\\a"],
    ["a relative path stays relative", "relative/../codex/./x", "codex\\x"],
    ["a relative path keeps its leading '..'", "../a/b/..", "..\\a"],
    ["rooted without a drive", "/home/u/proj/", "\\home\\u\\proj"],
    ["case is kept", "D:\\#Projects\\Own-Open-Code", "D:\\#Projects\\Own-Open-Code"],
  ])("%s", (_name, input, expected) => {
    expect(Paths.norm(input)).toBe(expected)
  })

  test("Hangul is compared in NFC", () => {
    const nfd = "C:\\작업\\프로젝트".normalize("NFD")
    expect(nfd).not.toBe("C:\\작업\\프로젝트")
    expect(Paths.norm(nfd)).toBe("C:\\작업\\프로젝트")
  })

  test("key lower-cases for comparison only", () => {
    expect(Paths.key("D:\\#Projects\\Own")).toBe("d:\\#projects\\own")
  })
})

describe("same and inside", () => {
  const missing = "Z:\\own-import-test-missing"

  test.each([
    ["extended-length and plain", "\\\\?\\Z:\\own-import-test-missing\\proj", `${missing}\\proj`, true],
    ["case", `${missing}\\PROJ`, `${missing}\\proj`, true],
    ["separators and a trailing one", "Z:/own-import-test-missing/proj/", `${missing}\\proj`, true],
    ["Hangul NFD and NFC", `${missing}\\한글`.normalize("NFD"), `${missing}\\한글`, true],
    ["'#' in the path", "z:/#Projects/own-open-code", "Z:\\#Projects\\own-open-code\\", true],
    ["different folders", `${missing}\\proj`, `${missing}\\proj2`, false],
  ])("same: %s (missing folders compare as strings)", (_name, a, b, expected) => {
    expect(Paths.same(a, b)).toBe(expected)
  })

  test.each([
    ["the folder itself", `${missing}\\proj`, `${missing}\\proj`, true],
    ["a subfolder", `${missing}\\proj\\src\\deep`, `${missing}\\proj`, true],
    ["a subfolder in another form", "\\\\?\\z:\\own-import-test-missing\\PROJ\\src", `${missing}\\proj\\`, true],
    ["a sibling sharing the prefix", `${missing}\\project2`, `${missing}\\proj`, false],
    ["the parent", missing, `${missing}\\proj`, false],
    ["a '..' escape", `${missing}\\proj\\..\\other`, `${missing}\\proj`, false],
    ["below a drive root", "Z:\\anything", "Z:\\", true],
  ])("inside: %s", (_name, child, parent, expected) => {
    expect(Paths.inside(child, parent)).toBe(expected)
  })

  test("existing paths compare by real path: a folder seen through a junction", async () => {
    if (!windows) return
    const item = await make({ under: "한글 #폴더" })
    const real = await item.folder("real", "proj")
    await item.folder("real", "proj", "src")
    const link = path.join(item.dir, "link")
    fs.symlinkSync(real, link, "junction")
    expect(Paths.key(link)).not.toBe(Paths.key(real))
    expect(Paths.same(link, real)).toBe(true)
    expect(Paths.inside(path.join(link, "src"), real)).toBe(true)
    expect(Paths.inside(path.join(real, "src"), link)).toBe(true)
  })

  test("a subst drive matches its folder through the injected realpath", () => {
    const resolve = fakeRealpath({
      "s:\\proj": "C:\\work\\proj",
      "c:\\work\\proj": "C:\\work\\proj",
      "s:\\proj\\src": "C:\\work\\proj\\src",
    })
    expect(Paths.same("S:\\proj", "C:\\work\\proj", resolve)).toBe(true)
    expect(Paths.inside("S:\\proj\\src", "C:\\work\\proj", resolve)).toBe(true)
    // Without the realpath the two forms are different strings.
    expect(Paths.same("S:\\proj", "C:\\work\\proj", () => undefined)).toBe(false)
  })

  test("one missing side falls back to the strings", () => {
    const resolve = fakeRealpath({ "c:\\work\\proj": "C:\\elsewhere\\proj" })
    expect(Paths.inside("C:\\work\\proj\\gone", "C:\\work\\proj", resolve)).toBe(true)
  })
})

describe("Claude Code folder names only pick candidates", () => {
  test.each([
    ["D:\\#Projects\\own-open-code"],
    ["C:\\Users\\a\\작업 폴더"],
    [`C:\\${"long-folder-name\\".repeat(16)}end`],
  ])("%s", (cwd) => {
    expect(Paths.claudeCandidate(claudeFolder(cwd), cwd)).toBe(true)
    expect(Paths.claudeCandidate(claudeFolder(cwd).toUpperCase(), cwd)).toBe(true)
  })

  test("the folder of '#' and of '-' collide, so the cwd in the file decides", () => {
    expect(claudeFolder("D:\\#Projects\\own-open-code")).toBe("D---Projects-own-open-code")
    expect(Paths.claudeCandidate("D---Projects-own-open-code", "D:\\-Projects\\own-open-code")).toBe(true)
    expect(Paths.claudeCandidate("D---Projects-own-open-code", "D:\\Programming\\own-open-code")).toBe(false)
  })

  test("over 200 characters only the prefix is compared (the hash suffix differs between runtimes)", () => {
    const cwd = `C:\\${"x".repeat(220)}`
    const prefix = claudeFolder(cwd).slice(0, 200)
    expect(Paths.claudeCandidate(`${prefix}-otherhash`, cwd)).toBe(true)
    expect(Paths.claudeCandidate(`${prefix}`, cwd)).toBe(false)
  })
})

describe("roots (09 §1.1 IM-D1, §2.1)", () => {
  const profile = "C:\\Users\\fixture"

  test("the option wins, then the environment, then the profile folder", () => {
    const option = Paths.defaults({
      options: { roots: { codex: ["C:\\a\\codex"], claude: ["C:\\a\\claude", "C:\\b\\claude"] } },
      env: { CODEX_HOME: "C:\\env\\codex", CLAUDE_CONFIG_DIR: "C:\\env\\claude" },
      homedir: profile,
    })
    expect(option.map((item) => [item.kind, item.directory, item.origin])).toEqual([
      ["codex", "C:\\a\\codex", "option"],
      ["claude-code", "C:\\a\\claude", "option"],
      ["claude-code", "C:\\b\\claude", "option"],
    ])
    const env = Paths.defaults({
      options: {},
      env: { CODEX_HOME: "C:\\env\\codex", CLAUDE_CONFIG_DIR: "C:\\env\\claude\\" },
      homedir: profile,
    })
    expect(env.map((item) => [item.directory, item.origin, item.label])).toEqual([
      ["C:\\env\\codex", "env", "Codex"],
      ["C:\\env\\claude", "env", "Claude Code"],
    ])
    const fallback = Paths.defaults({ options: {}, env: { CODEX_HOME: "" }, homedir: profile })
    expect(fallback.map((item) => [item.directory, item.origin])).toEqual([
      [path.join(profile, ".codex"), "default"],
      [path.join(profile, ".claude"), "default"],
    ])
  })

  test("an empty option list disables that kind's default", () => {
    const list = Paths.defaults({ options: { roots: { codex: [] } }, env: {}, homedir: profile })
    expect(list.map((item) => item.kind)).toEqual(["claude-code"])
  })

  test("the test preload points the defaults at an empty temp folder", async () => {
    const list = Paths.defaults({ options: {} })
    expect(list.map((item) => [item.kind, item.origin])).toEqual([
      ["codex", "env"],
      ["claude-code", "env"],
    ])
    for (const item of list) {
      expect(Paths.inside(item.directory, os.tmpdir())).toBe(true)
      expect(await fsp.readdir(item.directory)).toEqual([])
    }
  })

  test("rootIDs are stable tokens that do not depend on the path's spelling", () => {
    const a = Paths.rootID("codex", "C:\\Users\\a\\.codex")
    expect(a).toMatch(/^codex-[0-9a-f]{12}$/)
    expect(Paths.rootID("codex", "\\\\?\\c:/users/A/.codex/")).toBe(a)
    expect(Paths.rootID("claude-code", "C:\\Users\\a\\.codex")).not.toBe(a)
    expect(Paths.rootID("claude-code", "C:\\Users\\a\\.claude")).toMatch(/^claude-[0-9a-f]{12}$/)
  })

  test("added roots come from import-sources.json, normalized, without repeating a default", async () => {
    const item = await make()
    const file = Paths.sources(item.home)
    const stored = await Paths.configure(file, [
      { kind: "codex", directory: `${item.dir}/profiles/p1/codex/` },
      { kind: "codex", directory: path.join(item.dir, "profiles", "p1", "codex") },
      { kind: "codex", directory: item.codex },
    ])
    expect(stored).toEqual([
      { kind: "codex", directory: Paths.norm(path.join(item.dir, "profiles", "p1", "codex")) },
      { kind: "codex", directory: Paths.norm(item.codex) },
    ])
    const text = await fsp.readFile(path.join(item.home, "state", "import-sources.json"), "utf8")
    expect(JSON.parse(text)).toEqual({ schemaVersion: 1, extraRoots: stored })
    const list = await Paths.roots({ options: Options.decode(item.options), file })
    expect(list.map((root) => [root.directory, root.added])).toEqual([
      [Paths.norm(item.codex), false],
      [Paths.norm(item.claude), false],
      [Paths.norm(path.join(item.dir, "profiles", "p1", "codex")), true],
    ])
  })

  test("an unusable import-sources.json adds nothing and is left alone", async () => {
    const item = await make()
    const file = path.join(item.home, "state", "import-sources.json")
    await writeText(file, "{ not json")
    const list = await Paths.roots({ options: Options.decode(item.options), file: Paths.sources(item.home) })
    expect(list).toHaveLength(2)
    expect(await fsp.readFile(file, "utf8")).toBe("{ not json")
  })

  test("problem: missing, a file, a never-read folder, a relative path", async () => {
    const item = await make()
    expect(await Paths.problem({ kind: "codex", directory: item.codex })).toBeUndefined()
    expect(await Paths.problem({ kind: "codex", directory: path.join(item.dir, "gone") })).toBe("missing")
    const file = await writeText(path.join(item.dir, "file.txt"), "x")
    expect(await Paths.problem({ kind: "codex", directory: file })).toBe("missing")
    expect(await Paths.problem({ kind: "claude-code", directory: await item.folder("x", "file-history") })).toBe(
      "path_denied",
    )
    expect(await Paths.problem({ kind: "codex", directory: "relative\\codex" })).toBe("path_denied")
  })

  test("a root on a network share is denied without I/O, also from the environment; its files are refused", async () => {
    const share = Paths.defaults({
      options: {},
      env: {
        CODEX_HOME: "\\\\fixture-server\\share\\codex",
        CLAUDE_CONFIG_DIR: "\\\\?\\UNC\\fixture-server\\c",
      },
    })
    expect(share.map((root) => [root.origin, Paths.denied(root)])).toEqual([
      ["env", true],
      ["env", true],
    ])
    const codex = share[0]!
    expect(await Paths.problem(codex)).toBe("path_denied")
    const file = `${codex.directory}\\sessions\\2026\\10\\08\\rollout-2026-10-08T09-00-00-t1.jsonl`
    expect(Paths.check(codex, file, "read", () => undefined)).toEqual({ ok: false, reason: "path_denied" })
    expect(Paths.denied({ kind: "codex", directory: "C:\\Users\\fixture\\.codex" })).toBe(false)
  })
})

describe("the allowlist (09 §2.1)", () => {
  async function codexFiles(item: Fixture) {
    const rollout = await writeJsonl(codexRollout(item.codex, { id: "t1", at: "2026-10-08T09:00:00Z" }), [{ a: 1 }])
    const zst = await writeJsonl(codexRollout(item.codex, { id: "t2", at: "2026-10-08T09:00:00Z", zst: true }), [
      { a: 2 },
    ])
    const archived = await writeJsonl(
      codexRollout(item.codex, { id: "t3", at: "2026-10-01T09:00:00Z", archived: true }),
      [{ a: 3 }],
    )
    const index = await writeText(path.join(item.codex, "session_index.jsonl"), "{}\n")
    return { rollout, zst, archived, index }
  }

  test("Codex: rollouts, archived rollouts and session_index.jsonl are read; the DB only copied", async () => {
    const item = await make()
    const root = codexRoot(item)
    const files = await codexFiles(item)
    const db = stateDb(item.codex, { keepOpen: false })
    for (const file of Object.values(files)) expect(Paths.check(root, file, "read").ok).toBe(true)
    expect(Paths.check(root, db.file, "read")).toEqual({ ok: false, reason: "path_denied" })
    expect(Paths.check(root, db.file, "copy").ok).toBe(true)
    expect(Paths.check(root, files.rollout, "copy")).toEqual({ ok: false, reason: "path_denied" })
    expect(Paths.check(root, path.join(item.codex, "sessions", "2026", "10", "08"), "list").ok).toBe(true)
    expect(Paths.check(root, item.codex, "list").ok).toBe(true)
    expect(Paths.check(root, path.join(item.codex, "sessions", "2026", "10", "08", "x"), "list")).toEqual({
      ok: false,
      reason: "path_denied",
    })
  })

  test("Codex never-open files are refused whatever the purpose", async () => {
    const item = await make()
    const root = codexRoot(item)
    const written = await sentinels(item.codex, "codex")
    const extra = [
      await writeText(path.join(item.codex, "state_5.sqlite-shm"), "x"),
      await writeText(path.join(item.codex, "thread_history_1.sqlite-wal"), "x"),
      await writeText(path.join(item.codex, "sessions", "2026", "10", "08", "rollout-x.jsonl.lock"), "x"),
      await writeText(path.join(item.codex, "sessions", "2026", "10", "08", "auth.json"), "x"),
    ]
    for (const file of [...written, ...extra])
      for (const purpose of ["read", "copy"] as const)
        expect([file, Paths.check(root, file, purpose)]).toEqual([file, { ok: false, reason: "path_denied" }])
    expect(Paths.check(root, path.join(item.codex, "thread-writer-locks"), "list").ok).toBe(false)
  })

  test("Claude Code: conversations, sub-agents, titles and tool results; never-open files refused", async () => {
    const item = await make()
    const root = claudeRoot(item)
    const project = path.join(item.claude, "projects", claudeFolder("C:\\work\\proj"))
    const session = "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d5e"
    const allowed = [
      await writeJsonl(path.join(project, `${session}.jsonl`), [{ a: 1 }]),
      await writeText(path.join(project, session, "custom-title.json"), "{}"),
      await writeText(path.join(project, session, "tool-results", "toolu_x.txt"), "out"),
      await writeJsonl(path.join(project, session, "subagents", "agent-a1.jsonl"), [{ a: 1 }]),
      await writeText(path.join(project, session, "subagents", "agent-a1.meta.json"), "{}"),
      await writeJsonl(path.join(project, session, "subagents", "workflows", "wf_1", "agent-b2.jsonl"), [{ a: 1 }]),
    ]
    for (const file of allowed) expect([file, Paths.check(root, file, "read").ok]).toEqual([file, true])
    const refused = [
      ...(await sentinels(item.claude, "claude-code", path.basename(project))),
      await writeText(path.join(project, session, "subagents", "workflows", "wf_1", "journal.jsonl"), "{}"),
      await writeText(path.join(item.claude, "settings.json"), "{}"),
    ]
    for (const file of refused)
      expect([file, Paths.check(root, file, "read")]).toEqual([file, { ok: false, reason: "path_denied" }])
    expect(Paths.check(root, path.join(project, `${session}.jsonl`), "copy").ok).toBe(false)
    expect(Paths.check(root, path.join(project, "memory"), "list").ok).toBe(false)
    expect(Paths.check(root, path.join(item.claude, "sessions"), "list").ok).toBe(false)
  })

  test("outside the root, '..' escapes and missing files", async () => {
    const item = await make()
    const root = codexRoot(item)
    const outside = await writeJsonl(path.join(item.dir, "sessions", "2026", "10", "08", "rollout-x.jsonl"), [{}])
    expect(Paths.check(root, outside, "read")).toEqual({ ok: false, reason: "path_denied" })
    const escape = path.join(item.codex, "sessions", "2026", "10", "08", "..", "..", "..", "..", "..", "x.jsonl")
    expect(Paths.check(root, escape, "read")).toEqual({ ok: false, reason: "path_denied" })
    const gone = codexRollout(item.codex, { id: "gone", at: "2026-10-08T09:00:00Z" })
    expect(Paths.check(root, gone, "read")).toEqual({ ok: false, reason: "missing" })
  })

  test("the real path decides: a junction out of the root is path_denied, one inside the root is read", async () => {
    if (!windows) return
    const item = await make({ under: "한글 #폴더" })
    const root = codexRoot(item)
    const outside = await item.folder("outside", "day")
    await writeJsonl(path.join(outside, "rollout-2026-10-08T09-00-00-t9.jsonl"), [{ a: 1 }])
    await fsp.mkdir(path.join(item.codex, "sessions", "2026", "10"), { recursive: true })
    fs.symlinkSync(outside, path.join(item.codex, "sessions", "2026", "10", "08"), "junction")
    const through = path.join(item.codex, "sessions", "2026", "10", "08", "rollout-2026-10-08T09-00-00-t9.jsonl")
    expect(fs.existsSync(through)).toBe(true)
    expect(Paths.check(root, through, "read")).toEqual({ ok: false, reason: "path_denied" })
    const listing = await Paths.list(root, path.join(item.codex, "sessions", "2026", "10"))
    expect(listing.ok && listing.value.map((entry) => [entry.name, entry.kind])).toEqual([["08", "link"]])
    expect((await Paths.read(root, through)).ok).toBe(false)

    // A day folder that is a junction to the root's own archived_sessions stays inside the root.
    const inner = path.join(item.codex, "archived_sessions")
    const target = await writeJsonl(path.join(inner, "rollout-2026-10-01T09-00-00-t8.jsonl"), [{ a: 1 }])
    fs.symlinkSync(inner, path.join(item.codex, "sessions", "2026", "10", "01"), "junction")
    const aliased = path.join(item.codex, "sessions", "2026", "10", "01", "rollout-2026-10-01T09-00-00-t8.jsonl")
    expect(Paths.check(root, aliased, "read")).toEqual({
      ok: true,
      path: Paths.norm(aliased),
      real: fs.realpathSync.native(target),
    })
  })

  test("a link inside the root cannot reach a never-open file under an allowed name", async () => {
    if (!windows) return
    const item = await make()
    const root = claudeRoot(item)
    await sentinels(item.claude, "claude-code")
    await writeText(path.join(item.claude, "file-history", "custom-title.json"), "{}")
    const project = path.join(item.claude, "projects", "C--work-proj")
    await fsp.mkdir(project, { recursive: true })
    // A junction named like a conversation folder, pointing at file-history.
    fs.symlinkSync(path.join(item.claude, "file-history"), path.join(project, "s1"), "junction")
    expect(Paths.check(root, path.join(project, "s1"), "list")).toEqual({ ok: false, reason: "path_denied" })
    expect(Paths.check(root, path.join(project, "s1", "custom-title.json"), "read")).toEqual({
      ok: false,
      reason: "path_denied",
    })
  })

  test("a subst-like root resolves through the injected realpath", () => {
    const root = Paths.defaults({ options: { roots: { codex: ["S:\\codex"], claude: [] } } })[0]
    const file = "S:\\codex\\sessions\\2026\\10\\08\\rollout-x.jsonl"
    const resolve = fakeRealpath({
      "s:\\codex": "C:\\data\\codex",
      [Paths.key(file)]: "C:\\data\\codex\\sessions\\2026\\10\\08\\rollout-x.jsonl",
    })
    expect(Paths.check(root, file, "read", resolve)).toEqual({
      ok: true,
      path: file,
      real: "C:\\data\\codex\\sessions\\2026\\10\\08\\rollout-x.jsonl",
    })
    const escaping = fakeRealpath({ "s:\\codex": "C:\\data\\codex", [Paths.key(file)]: "C:\\other\\rollout-x.jsonl" })
    expect(Paths.check(root, file, "read", escaping)).toEqual({ ok: false, reason: "path_denied" })
  })
})

describe("file operations", () => {
  test("read, stat, list and chunks go through the allowlist and report to the guard", async () => {
    const item = await make()
    const root = codexRoot(item)
    const rollout = await writeJsonl(codexRollout(item.codex, { id: "t1", at: "2026-10-08T09:00:00Z" }), [
      { line: 1 },
      { line: 2 },
    ])
    await sentinels(item.codex, "codex")
    const guard = await start([item.codex])
    const read = await Paths.read(root, rollout)
    expect(read.ok && read.value.toString()).toBe('{"line":1}\n{"line":2}\n')
    const part = await Paths.read(root, rollout, { start: 1, length: 6 })
    expect(part.ok && part.value.toString()).toBe('"line"')
    const stat = await Paths.stat(root, rollout)
    expect(stat.ok && stat.value.size).toBe(22)
    const streamed = await Paths.withFile(root, rollout, "read", async (handle) => {
      const parts: string[] = []
      for await (const chunk of Paths.chunks(handle, { size: 5, start: 2, end: 12 }))
        parts.push(Buffer.from(chunk).toString())
      return parts
    })
    expect(streamed).toEqual({ ok: true, value: ['line"', ":1}\n{"] })
    const denied = await Paths.read(root, path.join(item.codex, "auth.json"))
    expect(denied).toEqual({ ok: false, reason: "path_denied" })
    expect(await guard.stop()).toEqual([])
    expect(
      guard.reports.filter((report) => report.reason === "path_denied").map((report) => path.basename(report.path)),
    ).toEqual(["auth.json"])
  })

  test("a file the reader holds open can still be deleted, and is gone once the reader closes it", async () => {
    if (!windows) return
    const item = await make()
    const root = codexRoot(item)
    const rollout = await writeJsonl(codexRollout(item.codex, { id: "t1", at: "2026-10-08T09:00:00Z" }), [{ a: 1 }])
    const result = await Paths.withFile(root, rollout, "read", async (handle) => {
      const first = await handle.read(Buffer.alloc(4), 0, 4, 0)
      // Codex's "compress, then delete the .jsonl" while own still reads it.
      fs.unlinkSync(rollout)
      const after = await handle.read(Buffer.alloc(4), 0, 4, 4)
      return [first.bytesRead, after.bytesRead]
    })
    expect(result).toEqual({ ok: true, value: [4, 4] })
    expect(fs.existsSync(rollout)).toBe(false)
    await writeJsonl(rollout, [{ a: 2 }])
    expect(fs.existsSync(rollout)).toBe(true)
  })

  test("folderExists only stats", async () => {
    const item = await make()
    expect(await Paths.folderExists(item.codex)).toBe(true)
    expect(await Paths.folderExists(path.join(item.dir, "gone"))).toBe(false)
  })

  test("a .jsonl.zst fixture streams through the allowlist and zstd, torn last line included", async () => {
    const item = await make()
    const root = codexRoot(item)
    const records = Array.from({ length: 200 }, (_, index) => ({ index, text: "한글 #".repeat(50) }))
    const file = await writeJsonl(
      codexRollout(item.codex, { id: "z1", at: "2026-10-08T09:00:00Z", zst: true }),
      records,
      {
        torn: true,
      },
    )
    const guard = await start([item.codex])
    const text = await Paths.withFile(root, file, "read", async (handle) => {
      const decompress = zlib.createZstdDecompress()
      const parts: Buffer[] = []
      decompress.on("data", (part: Buffer) => parts.push(part))
      const done = new Promise((resolve, reject) => decompress.on("end", resolve).on("error", reject))
      for await (const chunk of Paths.chunks(handle, { size: 4096 })) decompress.write(chunk)
      decompress.end()
      await done
      return Buffer.concat(parts).toString()
    })
    expect(await guard.stop()).toEqual([])
    const lines = text.ok ? text.value.split("\n") : []
    expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual(records)
    expect(lines.at(-1)).toBe(TORN)
  })
})
