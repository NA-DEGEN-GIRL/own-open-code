import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Snapshot } from "../../src/index/snapshot.js"
import { Paths } from "../../src/sources/paths.js"
import { fixture, stateDb, writeText, type Fixture, type StateDb, type ThreadRow } from "../fixtures/make.js"
import { start } from "../support/guard.js"

const fixtures: Fixture[] = []
const writers: StateDb[] = []

afterEach(async () => {
  writers.splice(0).forEach((db) => db.close())
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function make() {
  const item = await fixture({ under: "한글 #폴더" })
  fixtures.push(item)
  return { item, root: Paths.defaults({ options: { roots: { codex: [item.codex], claude: [] } } })[0] }
}

function db(root: string, input: Parameters<typeof stateDb>[1]) {
  const made = stateDb(root, input)
  if (input?.keepOpen !== false) writers.push(made)
  return made
}

function thread(id: string, extra: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    rollout_path: `C:\\fixture\\.codex\\sessions\\2026\\10\\08\\rollout-2026-10-08T09-00-00-${id}.jsonl`,
    cwd: "\\\\?\\C:\\work\\proj",
    title: `title ${id}`,
    ...extra,
  }
}

/** Opens like the default but records every file SQLite was asked to open. */
function spy() {
  const opened: string[] = []
  return {
    opened,
    open: (file: string) => {
      opened.push(file)
      return new Database(file, { readonly: true })
    },
  }
}

async function leftovers(tmp: string) {
  return fsp.readdir(tmp).catch(() => [])
}

function originals(root: string) {
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith("state_"))
    .sort()
}

describe("Codex state DB snapshot (09 §2.3, IG1)", () => {
  test("with an un-checkpointed -wal: reads threads that exist only in the WAL, from a copy, leaving the originals", async () => {
    const { item, root } = await make()
    db(item.codex, {
      threads: [thread("t1", { name: "named", model: "gpt-5.5", archived: 1 }), thread("t2")],
      edges: [["t1", "t2"]],
      walThreads: [thread("t3", { thread_source: "subagent" })],
    })
    expect(originals(item.codex)).toEqual(["state_5.sqlite", "state_5.sqlite-shm", "state_5.sqlite-wal"])
    const guard = await start([item.codex])
    const sqlite = spy()
    const taken = await Snapshot.read({ root, tmp: item.tmp, open: sqlite.open })
    expect(await guard.stop()).toEqual([])
    expect(taken?.version).toBe(5)
    expect(taken?.stamp.wal?.size).toBeGreaterThan(0)
    expect(taken?.threads.map((row) => row.id).sort()).toEqual(["t1", "t2", "t3"])
    expect(taken?.threads.find((row) => row.id === "t1")).toEqual({
      id: "t1",
      rolloutPath: thread("t1").rollout_path,
      cwd: "\\\\?\\C:\\work\\proj",
      source: "cli",
      threadSource: undefined,
      archived: true,
      title: "title t1",
      name: "named",
      model: "gpt-5.5",
      modelProvider: "openai",
      createdAt: Date.UTC(2026, 9, 8, 9),
      updatedAt: Date.UTC(2026, 9, 8, 9),
      cliVersion: "0.153.0",
      historyMode: "legacy",
    })
    expect(taken?.threads.find((row) => row.id === "t3")?.threadSource).toBe("subagent")
    expect(taken?.edges).toEqual([{ parent: "t1", child: "t2" }])
    // SQLite opened only the copy, never the original.
    expect(sqlite.opened).toHaveLength(1)
    expect(Paths.inside(sqlite.opened[0], item.tmp)).toBe(true)
    expect(Paths.key(sqlite.opened[0])).not.toBe(Paths.key(path.join(item.codex, "state_5.sqlite")))
    // The allowlist saw only copies of the DB and its -wal, never the -shm.
    const files = guard.reports.filter((report) => report.op === "open").map((report) => path.basename(report.path))
    expect([...new Set(files)].sort()).toEqual(["state_5.sqlite", "state_5.sqlite-wal"])
    expect(guard.reports.every((report) => report.op !== "open" || report.purpose === "copy")).toBe(true)
    expect(await leftovers(item.tmp)).toEqual([])
  })

  test("without a -wal: copies the DB alone and creates no -wal or -shm beside the original", async () => {
    const { item, root } = await make()
    db(item.codex, { threads: [thread("t1")], keepOpen: false })
    expect(originals(item.codex)).toEqual(["state_5.sqlite"])
    const guard = await start([item.codex])
    const taken = await Snapshot.read({ root, tmp: item.tmp })
    expect(await guard.stop()).toEqual([])
    expect(taken?.stamp.wal).toBeNull()
    expect(taken?.threads.map((row) => row.id)).toEqual(["t1"])
    expect(originals(item.codex)).toEqual(["state_5.sqlite"])
    expect(await leftovers(item.tmp)).toEqual([])
  })

  test("a change during the copy copies again", async () => {
    const { item, root } = await make()
    const state = db(item.codex, { threads: [thread("t1")] })
    const attempts: number[] = []
    const taken = await Snapshot.read({
      root,
      tmp: item.tmp,
      copied: (attempt) => {
        attempts.push(attempt)
        if (attempt === 1) state.insert([thread("t2")])
      },
    })
    expect(attempts).toEqual([1, 2])
    expect(taken?.threads.map((row) => row.id).sort()).toEqual(["t1", "t2"])
    expect(await leftovers(item.tmp)).toEqual([])
  })

  test("a DB that keeps changing gives up after 3 copies (file scan fallback)", async () => {
    const { item, root } = await make()
    const state = db(item.codex, { threads: [thread("t1")] })
    const attempts: number[] = []
    const taken = await Snapshot.read({
      root,
      tmp: item.tmp,
      copied: (attempt) => {
        attempts.push(attempt)
        state.insert([thread(`n${attempt}`)])
      },
    })
    expect(taken).toBeUndefined()
    expect(attempts).toEqual([1, 2, 3])
    expect(await leftovers(item.tmp)).toEqual([])
  })

  test("a -wal that disappears between tries leaves no stale copy", async () => {
    const { item, root } = await make()
    const state = db(item.codex, { threads: [thread("t1")], walThreads: [thread("t2")] })
    const taken = await Snapshot.read({
      root,
      tmp: item.tmp,
      copied: (attempt) => {
        // Codex checkpoints and closes: the WAL's rows move into the main file and the -wal goes away.
        if (attempt === 1) state.close()
      },
    })
    writers.splice(writers.indexOf(state), 1)
    expect(taken?.stamp.wal).toBeNull()
    expect(taken?.threads.map((row) => row.id).sort()).toEqual(["t1", "t2"])
  })

  test.each(["old-columns", "no-edges"] as const)("different columns (%s) fall back", async (schema) => {
    const { item, root } = await make()
    db(item.codex, { schema, threads: [thread("t1")] })
    const sqlite = spy()
    expect(await Snapshot.read({ root, tmp: item.tmp, open: sqlite.open })).toBeUndefined()
    expect(sqlite.opened.every((file) => Paths.inside(file, item.tmp))).toBe(true)
    expect(await leftovers(item.tmp)).toEqual([])
  })

  test("the highest-numbered state DB wins, by number", async () => {
    const { item, root } = await make()
    db(item.codex, { version: 5, threads: [thread("old")], keepOpen: false })
    db(item.codex, { version: 6, threads: [thread("new")], keepOpen: false })
    expect((await Snapshot.read({ root, tmp: item.tmp }))?.threads.map((row) => row.id)).toEqual(["new"])
    db(item.codex, { version: 10, threads: [thread("ten")], keepOpen: false })
    db(item.codex, { version: 9, threads: [thread("nine")], keepOpen: false })
    const taken = await Snapshot.read({ root, tmp: item.tmp })
    expect(taken?.version).toBe(10)
    expect(taken?.threads.map((row) => row.id)).toEqual(["ten"])
  })

  test("a damaged DB, no DB and a Claude root answer undefined; the temp folder is always removed", async () => {
    const { item, root } = await make()
    expect(await Snapshot.read({ root, tmp: item.tmp })).toBeUndefined()
    await writeText(path.join(item.codex, "state_7.sqlite"), "not a database, just text")
    expect(await Snapshot.read({ root, tmp: item.tmp })).toBeUndefined()
    expect(await leftovers(item.tmp)).toEqual([])
    const claude = Paths.defaults({ options: { roots: { codex: [], claude: [item.claude] } } })[0]
    expect(await Snapshot.read({ root: claude, tmp: item.tmp })).toBeUndefined()
  })

  test("sweep removes copies a run left behind, older than STALE_MS; a running copy and other folders stay", async () => {
    const { item } = await make()
    const old = path.join(item.tmp, "import-0123456789abcdef")
    await writeText(path.join(old, "state_5.sqlite"), "a copy a terminated Worker left")
    const running = path.join(item.tmp, "import-fedcba9876543210")
    const other = path.join(item.tmp, "other-thing")
    await fsp.mkdir(running, { recursive: true })
    await fsp.mkdir(other, { recursive: true })
    const now = Date.now()
    const past = new Date(now - Snapshot.STALE_MS - 60_000)
    await fsp.utimes(old, past, past)
    await fsp.utimes(other, past, past)
    await Snapshot.sweep(item.tmp, now)
    expect(fs.existsSync(old)).toBe(false)
    expect([fs.existsSync(running), fs.existsSync(other)]).toEqual([true, true])
    // No temp folder yet: nothing to do, and no failure.
    await Snapshot.sweep(path.join(item.dir, "no-tmp-here"), now)
  })

  test("locate only stats: the stamp the index compares, and no copy", async () => {
    const { item, root } = await make()
    db(item.codex, { threads: [thread("t1")], walThreads: [thread("t2")] })
    const located = await Snapshot.locate(root)
    expect(located?.file).toBe(path.join(Paths.norm(item.codex), "state_5.sqlite"))
    expect(located?.stamp.db.size).toBe(fs.statSync(path.join(item.codex, "state_5.sqlite")).size)
    expect(located?.stamp.wal?.size).toBe(fs.statSync(path.join(item.codex, "state_5.sqlite-wal")).size)
    expect(fs.existsSync(item.tmp)).toBe(false)
  })
})
