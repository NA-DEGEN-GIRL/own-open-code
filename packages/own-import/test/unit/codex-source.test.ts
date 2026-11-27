import { afterEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import { Result } from "effect"
import { CodexStore } from "../../src/sources/codex.js"
import { Paths } from "../../src/sources/paths.js"
import { CodexTranscript } from "../../src/transcript/codex.js"
import { Transcript } from "../../src/transcript/ir.js"
import {
  byteLength,
  rollout,
  spawnSource,
  T0,
  threadId,
  VERBATIM_CWD,
  writeRollout,
  writeSessionIndex,
} from "../fixtures/codex.js"
import {
  codexRollout,
  fixture,
  sentinels,
  stateDb,
  writeText,
  type Fixture,
  type StateDb,
  type ThreadRow,
} from "../fixtures/make.js"
import { start } from "../support/guard.js"

const fixtures: Fixture[] = []
const writers: StateDb[] = []

afterEach(async () => {
  writers.splice(0).forEach((db) => db.close())
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function make(under = "한글 #폴더") {
  const item = await fixture({ under })
  fixtures.push(item)
  return { item, root: Paths.defaults({ options: { roots: { codex: [item.codex], claude: [] } } })[0] }
}

const NOW = T0 + 3_600_000
const DAY1 = Date.UTC(2026, 9, 7, 9)

/** A small conversation: request, a command, the answer. */
function conversation(
  id: string,
  input: { readonly prompt?: string; readonly meta?: Partial<Parameters<ReturnType<typeof rollout>["meta"]>[0]> } = {},
) {
  return rollout()
    .meta({ id, ...input.meta })
    .taskStarted("u1")
    .turnContext({ model: "gpt-5.5", turnId: "u1" })
    .user(input.prompt ?? `request of ${id}`, { kinds: true, turnId: "u1" })
    .call("exec_command", { cmd: "bun test" }, "c1")
    .output("c1", "ok")
    .commandDone("c1", 0)
    .assistant("done")
    .taskComplete("u1")
}

function db(root: string, input: Parameters<typeof stateDb>[1]) {
  const made = stateDb(root, input)
  if (input?.keepOpen !== false) writers.push(made)
  return made
}

function byId(threads: ReadonlyArray<CodexStore.Thread>) {
  return new Map(threads.map((thread) => [thread.source.id, thread]))
}

async function read(root: Paths.Root, file: CodexStore.RolloutFile, input: CodexStore.ReadInput = {}) {
  const result = await CodexStore.transcript(root, file, { now: NOW, ...input })
  if (!result.ok) throw new Error(`unreadable: ${result.reason}`)
  expect(Result.isSuccess(Transcript.decode(result.value.info))).toBe(true)
  return result.value
}

describe("listing (09 §2.3)", () => {
  test("rollouts in date folders and archived_sessions, by name; other names and folders are not listed; since", async () => {
    const { item, root } = await make()
    const a = await writeRollout(item.codex, {
      id: threadId(1),
      at: DAY1,
      records: conversation(threadId(1)).records(),
    })
    const b = await writeRollout(item.codex, {
      id: threadId(2),
      zst: true,
      records: conversation(threadId(2)).records(),
    })
    const c = await writeRollout(item.codex, {
      id: threadId(3),
      archived: true,
      records: conversation(threadId(3)).records(),
    })
    await writeText(path.join(path.dirname(b), "notes.txt"), "x")
    await writeText(`${b.slice(0, -4)}.manager-append.lock`, "")
    await fs.mkdir(path.join(path.dirname(b), "rollout-2026-10-08T09-00-00-folder.jsonl"))
    const files = await CodexStore.files(root)
    expect(files.map((file) => [path.basename(file.path), file.threadID, file.zst, file.archived]).sort()).toEqual(
      [
        [path.basename(a), threadId(1), false, false],
        [path.basename(b), threadId(2), true, false],
        [path.basename(c), threadId(3), false, true],
      ].sort(),
    )
    expect(files.find((file) => file.threadID === threadId(2))).toMatchObject({
      name: path.basename(b).slice(0, -4),
      rolloutID: threadId(2),
      date: "2026-10-08",
      time: T0,
    })
    const recent = await CodexStore.files(root, { since: "2026-10-08", archived: false })
    expect(recent.map((file) => file.threadID)).toEqual([threadId(2)])
  })

  test("parseName: the optional rollout id of a reverted thread; ids are path-free tokens", () => {
    expect(CodexStore.parseName(`rollout-2026-10-08T09-00-00-${threadId(1)}_${threadId(9)}.jsonl.zst`)).toEqual({
      name: `rollout-2026-10-08T09-00-00-${threadId(1)}_${threadId(9)}.jsonl`,
      threadID: threadId(1),
      rolloutID: threadId(9),
      date: "2026-10-08",
      time: T0,
      zst: true,
    })
    expect(CodexStore.parseName("rollout-2026-10-08T09-00-00-a b.jsonl")).toBeUndefined()
    expect(CodexStore.parseName("rollout-2026-10-08T09-00-00-x.jsonl.bak")).toBeUndefined()
  })

  test("resolve: .jsonl, then .jsonl.zst, then archived_sessions; the day folder from the recorded path", async () => {
    const { item, root } = await make()
    const id = threadId(4)
    const recorded = `C:\\Users\\someone\\.codex\\sessions\\2026\\10\\08\\rollout-2026-10-08T09-00-00-${id}.jsonl`
    expect(await CodexStore.resolve(root, recorded)).toBeUndefined()
    await writeRollout(item.codex, { id, archived: true, zst: true, records: conversation(id).records() })
    expect(await CodexStore.resolve(root, recorded)).toMatchObject({ archived: true, zst: true })
    await writeRollout(item.codex, { id, archived: true, records: conversation(id).records() })
    expect(await CodexStore.resolve(root, recorded)).toMatchObject({ archived: true, zst: false })
    await writeRollout(item.codex, { id, zst: true, records: conversation(id).records() })
    expect(await CodexStore.resolve(root, recorded)).toMatchObject({ archived: false, zst: true })
    const plain = await writeRollout(item.codex, { id, records: conversation(id).records() })
    expect((await CodexStore.resolve(root, recorded))?.path).toBe(plain)
    expect(await CodexStore.resolve(root, "C:\\elsewhere\\not-a-rollout.jsonl")).toBeUndefined()
  })

  test("session_index.jsonl: the last entry of an id wins, an empty name removes it, bad lines are skipped", async () => {
    const { item, root } = await make()
    expect(await CodexStore.names(root)).toEqual(new Map())
    await writeSessionIndex(item.codex, [
      { id: threadId(1), name: "first" },
      { id: threadId(2), name: "kept" },
      { id: threadId(1), name: "renamed" },
      { id: threadId(3), name: "gone" },
      { id: threadId(3), name: null },
    ])
    await fs.appendFile(path.join(item.codex, "session_index.jsonl"), "not json\n")
    expect(await CodexStore.names(root)).toEqual(
      new Map([
        [threadId(1), "renamed"],
        [threadId(2), "kept"],
      ]),
    )
  })
})

describe("discovery by file scan (09 §2.3, §2.5)", () => {
  test("titles, first prompts, sub-agents folded under their parent, exec runs and archived threads", async () => {
    const { item, root } = await make()
    const parent = threadId(10)
    await writeRollout(item.codex, {
      id: parent,
      records: conversation(parent, {
        prompt: "설치기를 정리해 줘",
        meta: { branch: "main", cliVersion: "0.153.0" },
      }).records(),
      mtime: new Date(NOW - 30_000),
    })
    await writeRollout(item.codex, {
      id: threadId(11),
      records: rollout()
        .meta({ id: threadId(11), source: spawnSource(parent), threadSource: "subagent", subagentStart: 3 })
        .meta({ id: parent })
        .user("inherited")
        .user("sub-agent task")
        .records(),
    })
    await writeRollout(item.codex, {
      id: threadId(12),
      records: conversation(threadId(12), { meta: { source: "exec" } }).records(),
      mtime: new Date(T0),
    })
    await writeRollout(item.codex, { id: threadId(13), archived: true, records: conversation(threadId(13)).records() })
    await writeSessionIndex(item.codex, [
      { id: parent, name: "old name" },
      { id: parent, name: "이름 붙인 대화" },
    ])
    const found = await CodexStore.discover(root, { tmp: item.tmp, now: NOW })
    expect(found.via).toBe("scan")
    const threads = byId(found.threads)
    expect(threads.get(parent)).toMatchObject({
      source: {
        kind: "codex",
        id: parent,
        rootID: root.rootID,
        title: "이름 붙인 대화",
        firstPrompt: "설치기를 정리해 줘",
        app: "cli",
        cwds: [VERBATIM_CWD],
        branch: "main",
        versions: ["0.153.0"],
        createdAt: T0,
        updatedAt: NOW - 30_000,
        subagent: false,
        live: true,
      },
      archived: false,
      exec: false,
      children: [threadId(11)],
    })
    expect(threads.get(threadId(11))).toMatchObject({
      source: {
        subagent: true,
        parentID: parent,
        app: "subagent",
        firstPrompt: "sub-agent task",
        title: "sub-agent task",
      },
      children: [],
    })
    expect(threads.get(threadId(12))).toMatchObject({ exec: true, source: { app: "exec", live: false } })
    expect(threads.get(threadId(13))).toMatchObject({ archived: true })
    expect(found.heads.map((entry) => entry.head.id).sort()).toEqual([parent, threadId(11), threadId(12), threadId(13)])
    // Every thread is a valid IR source.
    found.threads.forEach((thread) =>
      expect(
        Result.isSuccess(
          Transcript.decode({ source: thread.source, turns: [], checkpoints: [], children: [], dropped: {} }),
        ),
      ).toBe(true),
    )
  })

  test("a cached head is not read again", async () => {
    const { item, root } = await make()
    await writeRollout(item.codex, { id: threadId(14), records: conversation(threadId(14)).records() })
    const cached: CodexTranscript.Head = {
      id: threadId(14),
      subagent: false,
      cwd: "C:\\cached",
      firstPrompt: "cached prompt",
    }
    const found = await CodexStore.discover(root, { tmp: item.tmp, now: NOW, cached: () => cached })
    expect(found.heads).toEqual([])
    expect(found.threads[0].source).toMatchObject({ cwds: ["C:\\cached"], title: "cached prompt" })
  })

  test("a reverted thread with two files: the file no other file names as history_base is current, else the newest", async () => {
    const { item, root } = await make()
    const id = threadId(15)
    const second = threadId(16)
    const old = await writeRollout(item.codex, {
      id,
      records: conversation(id, { prompt: "old file" }).records(),
      mtime: new Date(NOW),
    })
    const current = await writeRollout(item.codex, {
      id,
      rolloutId: second,
      at: T0 + 60_000,
      records: conversation(id, {
        prompt: "current file",
        meta: { base: { rolloutId: id, endOrdinal: 3, endByteOffset: 100 } },
      }).records(),
      mtime: new Date(NOW - 60_000),
    })
    const found = await CodexStore.discover(root, { tmp: item.tmp, now: NOW })
    expect(found.threads).toHaveLength(1)
    expect(found.threads[0].file?.path).toBe(current)
    expect(found.threads[0].source).toMatchObject({ firstPrompt: "current file", base: { id, endByteOffset: 100 } })
    // Without a history_base link the newest file is current.
    await writeRollout(item.codex, {
      id,
      rolloutId: second,
      at: T0 + 60_000,
      records: conversation(id, { prompt: "current file" }).records(),
      mtime: new Date(NOW - 60_000),
    })
    const again = await CodexStore.discover(root, { tmp: item.tmp, now: NOW })
    expect(again.threads[0].file?.path).toBe(old)
  })

  test("an unreadable first line lists the thread with its problem; other threads are unaffected", async () => {
    const { item, root } = await make()
    await writeText(codexRollout(item.codex, { id: threadId(17), at: T0 }), "not a rollout\n")
    await writeRollout(item.codex, { id: threadId(18), records: conversation(threadId(18)).records() })
    const threads = byId((await CodexStore.discover(root, { tmp: item.tmp, now: NOW })).threads)
    expect(threads.get(threadId(17))).toMatchObject({
      problem: "decode_failed",
      source: { id: threadId(17), title: "" },
    })
    expect(threads.get(threadId(18))?.problem).toBeUndefined()
  })

  test("duplicates across roots: one thread per id, the latest activity wins, the roots' order is kept", async () => {
    const first = await make("first")
    const second = await make("second")
    await writeRollout(first.item.codex, {
      id: threadId(20),
      records: conversation(threadId(20)).records(),
      mtime: new Date(NOW - 600_000),
    })
    await writeRollout(first.item.codex, { id: threadId(21), records: conversation(threadId(21)).records() })
    await writeRollout(second.item.codex, {
      id: threadId(20),
      records: conversation(threadId(20)).records(),
      mtime: new Date(NOW - 60_000),
    })
    const lists = await Promise.all(
      [first, second].map(
        async (entry) => (await CodexStore.discover(entry.root, { tmp: entry.item.tmp, now: NOW })).threads,
      ),
    )
    const merged = CodexStore.dedupe(lists)
    expect(merged.map((thread) => [thread.source.id, thread.source.rootID])).toEqual([
      [threadId(21), first.root.rootID],
      [threadId(20), second.root.rootID],
    ])
  })
})

describe("discovery with the state DB copy (09 §2.3, IG1)", () => {
  function row(id: string, extra: Partial<ThreadRow> = {}): ThreadRow {
    return {
      id,
      rollout_path: `C:\\Users\\someone\\.codex\\sessions\\2026\\10\\08\\rollout-2026-10-08T09-00-00-${id}.jsonl`,
      cwd: VERBATIM_CWD,
      title: `title ${id}`,
      created_at_ms: T0,
      updated_at_ms: T0 + 5000,
      ...extra,
    }
  }

  test("rows name the threads; files are found by name (.jsonl, .zst, archived); a missing file is unavailable; the DB is only copied", async () => {
    const { item, root } = await make()
    const [zst, archived, missing, sub, named, wal, extra] = [30, 31, 32, 33, 34, 35, 36].map(threadId)
    await writeRollout(item.codex, { id: zst, zst: true, records: conversation(zst).records() })
    await writeRollout(item.codex, { id: archived, archived: true, records: conversation(archived).records() })
    await writeRollout(item.codex, {
      id: sub,
      records: conversation(sub, { meta: { source: spawnSource(zst) } }).records(),
    })
    await writeRollout(item.codex, { id: named, records: conversation(named).records() })
    await writeRollout(item.codex, { id: wal, records: conversation(wal, { prompt: "WAL에만 있는 대화" }).records() })
    await writeRollout(item.codex, {
      id: extra,
      records: conversation(extra, { prompt: "not in the DB yet" }).records(),
    })
    await writeSessionIndex(item.codex, [{ id: named, name: "index name" }])
    await sentinels(item.codex, "codex")
    db(item.codex, {
      threads: [
        row(zst, { model: "gpt-5.5", model_provider: "openai", cli_version: "0.153.0" }),
        row(archived, { archived: 1 }),
        row(missing),
        row(sub, { source: JSON.stringify(spawnSource(zst)), thread_source: "subagent" }),
        row(named, { name: "db name" }),
      ],
      edges: [[zst, sub]],
      walThreads: [row(wal, { title: "" })],
    })
    const guard = await start([item.codex])
    const found = await CodexStore.discover(root, { tmp: item.tmp, now: NOW })
    expect(await guard.stop()).toEqual([])
    expect(found.via).toBe("snapshot")
    expect(found.stamp?.wal?.size).toBeGreaterThan(0)
    const threads = byId(found.threads)
    expect(threads.get(zst)).toMatchObject({
      file: { zst: true, archived: false },
      source: {
        title: `title ${zst}`,
        firstPrompt: `request of ${zst}`,
        models: [{ provider: "openai", id: "gpt-5.5" }],
        versions: ["0.153.0"],
        createdAt: T0,
        updatedAt: T0 + 5000,
      },
      children: [sub],
    })
    expect(threads.get(archived)).toMatchObject({ archived: true, file: { archived: true } })
    expect(threads.get(missing)).toMatchObject({ problem: "missing", source: { bytes: 0, live: false } })
    expect(threads.get(missing)?.file).toBeUndefined()
    expect(threads.get(sub)).toMatchObject({ source: { subagent: true, parentID: zst, title: `title ${sub}` } })
    expect(threads.get(named)?.source.title).toBe("index name")
    expect(threads.get(wal)?.source).toMatchObject({ title: "WAL에만 있는 대화", firstPrompt: "WAL에만 있는 대화" })
    expect(threads.get(extra)?.source.title).toBe("not in the DB yet")
    // A sub-agent's head is not read; the copy left nothing behind; only allowed files were opened.
    expect(found.heads.some((entry) => entry.head.id === sub)).toBe(false)
    expect(await fs.readdir(item.tmp).catch(() => [])).toEqual([])
    const opened = guard.reports.filter((report) => report.op === "open").map((report) => path.basename(report.path))
    expect(
      opened.every((name) => /^rollout-.*\.jsonl(\.zst)?$|^session_index\.jsonl$|^state_5\.sqlite(-wal)?$/.test(name)),
    ).toBe(true)
  })

  test("a DB with other columns, or none, falls back to the file scan", async () => {
    const { item, root } = await make()
    await writeRollout(item.codex, { id: threadId(40), records: conversation(threadId(40)).records() })
    db(item.codex, { schema: "old-columns", threads: [row(threadId(40))], keepOpen: false })
    const found = await CodexStore.discover(root, { tmp: item.tmp, now: NOW })
    expect([found.via, found.threads.map((thread) => thread.source.id)]).toEqual(["scan", [threadId(40)]])
    const skipped = await CodexStore.discover(root, { tmp: item.tmp, now: NOW, snapshot: false })
    expect(skipped.via).toBe("scan")
  })
})

describe("reading a rollout (09 §2.5, §2.8, IG4)", () => {
  test(".jsonl and .jsonl.zst give the same transcript; a torn last line is ignored and counted; \\\\?\\ cwd kept as recorded", async () => {
    const { item, root } = await make()
    const records = conversation(threadId(50), { prompt: "같은 대화" }).unknown("future_record").records()
    await writeRollout(item.codex, { id: threadId(50), records, torn: true })
    await writeRollout(item.codex, { id: threadId(51), zst: true, records, torn: true })
    const files = await CodexStore.files(root)
    const [plain, zst] = await Promise.all(
      [threadId(50), threadId(51)].map(async (id) =>
        read(root, files.find((file) => file.threadID === id)!, { title: "t" }),
      ),
    )
    const strip = (info: Transcript.Info) => ({ ...info, source: { ...info.source, path: "", bytes: 0 } })
    expect(strip(zst.info)).toEqual(strip(plain.info))
    expect(plain.info.source).toMatchObject({ title: "t", cwds: [VERBATIM_CWD], firstPrompt: "같은 대화" })
    expect(plain.info.turns).toHaveLength(1)
    expect(plain.info.turns[0].steps.map((step) => step.type)).toEqual(["tool", "text"])
    expect(plain.info.dropped).toEqual({ tornLine: 1, unknownRecord: 1 })
  })

  test("a line over the cap is skipped and counted (cap lowered for the test; the default is 32 MiB)", async () => {
    expect(CodexStore.LINE_MAX).toBe(32 * 1024 * 1024)
    const { item, root } = await make()
    const records = conversation(threadId(52)).assistant("x".repeat(5000)).assistant("after").records()
    await writeRollout(item.codex, { id: threadId(52), records })
    await writeRollout(item.codex, { id: threadId(53), zst: true, records })
    const files = await CodexStore.files(root)
    for (const file of files) {
      const result = await read(root, file, { maxLine: 4096 })
      expect(result.info.dropped.oversizedLine).toBe(1)
      expect(result.info.turns[0].steps.at(-1)).toMatchObject({ type: "text", text: "after" })
    }
  })

  test("a file Codex compresses while own opens it is looked up once more", async () => {
    const { item, root } = await make()
    const records = conversation(threadId(54)).records()
    const plain = await writeRollout(item.codex, { id: threadId(54), records })
    const [file] = await CodexStore.files(root)
    // Codex's compression worker: writes the .zst, then removes the .jsonl.
    await writeRollout(item.codex, { id: threadId(54), zst: true, records })
    await fs.rm(plain)
    const result = await read(root, file)
    expect(result.file.zst).toBe(true)
    expect(result.info.source.path).toBe(`${plain}.zst`)
    expect(result.info.turns).toHaveLength(1)
  })

  test("a missing file is unavailable, not an error", async () => {
    const { item, root } = await make()
    const plain = await writeRollout(item.codex, { id: threadId(55), records: conversation(threadId(55)).records() })
    const [file] = await CodexStore.files(root)
    await fs.rm(plain)
    expect(await CodexStore.transcript(root, file)).toEqual({ ok: false, reason: "missing" })
  })

  test("a rollout past the parse limit is too_large, plain or zstd (09 §2.8, IG4)", async () => {
    const { item, root } = await make()
    await writeRollout(item.codex, { id: threadId(56), records: conversation(threadId(56)).records() })
    await writeRollout(item.codex, { id: threadId(57), zst: true, records: conversation(threadId(57)).records() })
    for (const file of await CodexStore.files(root)) {
      const whole = await read(root, file)
      expect(whole.info.turns).toHaveLength(1)
      expect(await CodexStore.transcript(root, file, { now: NOW, maxBytes: 200 })).toEqual({
        ok: false,
        reason: "too_large",
      })
    }
  })

  test("history_base (I2): the prefix is read first, never past end_byte_offset; partial and missing prefixes", async () => {
    const { item, root } = await make()
    const id = threadId(56)
    const reverted = threadId(57)
    const prefix = rollout().meta({ id }).user("앞부분").assistant("a")
    const end = byteLength(prefix.records())
    const base = prefix.user("잘린 뒤").assistant("b")
    await writeRollout(item.codex, { id, zst: true, records: base.records(), mtime: new Date(NOW - 600_000) })
    const main = (endByteOffset: number, rolloutId = id) =>
      rollout({ firstOrdinal: 3 })
        .meta({ id, base: { rolloutId, endOrdinal: 3, endByteOffset } })
        .user("이어서")
        .assistant("c")
        .records()
    await writeRollout(item.codex, { id, rolloutId: reverted, at: T0 + 60_000, records: main(end) })
    const files = await CodexStore.files(root)
    const current = files.find((file) => file.rolloutID === reverted)!
    const full = await read(root, current, { base: true, files })
    expect(full.base).toBe("complete")
    expect(full.info.turns.map((turn) => turn.user.text)).toEqual(["앞부분", "이어서"])
    const own = await read(root, current)
    expect(own.base).toBeUndefined()
    expect(own.info.turns.map((turn) => turn.user.text)).toEqual(["이어서"])
    expect(own.info.source.base).toEqual({ id, endByteOffset: end })

    await writeRollout(item.codex, { id, rolloutId: reverted, at: T0 + 60_000, records: main(end * 10) })
    const partial = await read(root, current, { base: true })
    expect(partial.base).toBe("partial")
    // Records at or past end_ordinal_exclusive are never taken, even when the byte bound is not reached.
    expect(partial.info.turns.map((turn) => turn.user.text)).toEqual(["앞부분", "이어서"])

    await writeRollout(item.codex, { id, rolloutId: reverted, at: T0 + 60_000, records: main(end, threadId(99)) })
    expect((await read(root, current, { base: true })).base).toBe("missing")
  })

  test("visit sees each line with its offset and can stop the read", async () => {
    const { item, root } = await make()
    const records = conversation(threadId(58)).user("second").assistant("b").records()
    await writeRollout(item.codex, { id: threadId(58), records })
    const [file] = await CodexStore.files(root)
    const offsets: number[] = []
    const result = await read(root, file, {
      visit: (parser, at) => {
        offsets.push(at.offset)
        return parser.turns() < 2
      },
    })
    expect(result.info.turns.map((turn) => turn.user.text)).toEqual([`request of ${threadId(58)}`, "second"])
    expect(result.info.turns[1].steps).toEqual([])
    expect(offsets).toEqual(records.slice(0, offsets.length).map((_, index) => byteLength(records.slice(0, index))))
  })

  test("head: a .zst is decoded only as far as the window; corrupt data later fails only the full read", async () => {
    const { item, root } = await make()
    const builder = rollout()
      .meta({ id: threadId(59) })
      .user("first request")
    // About 3 MiB of incompressible-ish text, so the compressed tail lies beyond the first read chunk.
    Array.from({ length: 1500 }, () =>
      builder.raw({ type: "world_state", payload: { r: randomBytes(1024).toString("hex") } }),
    )
    const file = codexRollout(item.codex, { id: threadId(59), at: T0, zst: true })
    await fs.mkdir(path.dirname(file), { recursive: true })
    const body = Buffer.from(
      builder
        .records()
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    )
    // Damaged bytes at 80% of a frame with a content checksum: zstd reports it only when it decodes that far.
    const compressed = zlib.zstdCompressSync(body, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
    const damaged = Math.floor(compressed.length * 0.8)
    compressed.fill(0xa5, damaged, damaged + 64)
    await fs.writeFile(file, compressed)
    const [listed] = await CodexStore.files(root)
    const head = await CodexStore.head(root, listed)
    expect(head).toMatchObject({ ok: true, value: { id: threadId(59), firstPrompt: "first request" } })
    expect(await CodexStore.transcript(root, listed)).toEqual({ ok: false, reason: "decode_failed" })
  })

  test("head: a first line longer than the window keeps its leading fields", async () => {
    const { item, root } = await make()
    await writeRollout(item.codex, {
      id: threadId(60),
      records: rollout()
        .meta({ id: threadId(60), instructions: 200_000, source: "vscode" })
        .user("x")
        .records(),
    })
    const [file] = await CodexStore.files(root)
    expect(await CodexStore.head(root, file)).toMatchObject({
      ok: true,
      value: { id: threadId(60), cwd: VERBATIM_CWD, app: "vscode", subagent: false },
    })
  })
})

describe("eachLine (09 §2.8)", () => {
  async function* pieces(...parts: ReadonlyArray<string | Uint8Array>) {
    for (const part of parts) yield typeof part === "string" ? Buffer.from(part) : part
  }

  test("lines across chunk boundaries (a split UTF-8 character too), CRLF, blank lines, offsets and the torn rest", async () => {
    const seen: CodexStore.Line[] = []
    const hangul = Buffer.from("한")
    const result = await CodexStore.eachLine(
      pieces("ab", "c\r\n\nd", hangul.subarray(0, 1), hangul.subarray(1), "\nlast"),
      100,
      (line) => {
        seen.push(line)
      },
    )
    expect(seen).toEqual([
      { text: "abc", line: 0, offset: 0, torn: undefined },
      { text: "d한", line: 2, offset: 6, torn: undefined },
      { text: "last", line: 3, offset: 11, torn: true },
    ])
    expect(result).toEqual({ oversized: 0, bytes: 15, stopped: false })
  })

  test("an oversized line is skipped whether it ends or not", async () => {
    const seen: string[] = []
    const result = await CodexStore.eachLine(
      pieces("ok\n", "x".repeat(8), "x".repeat(8), "\nfine\n", "y".repeat(20)),
      10,
      (line) => {
        seen.push(line.text)
      },
    )
    expect(seen).toEqual(["ok", "fine"])
    expect(result.oversized).toBe(2)
  })
})

describe("read only (IG1)", () => {
  test("discovery and reading every thread open only allowlisted files and change nothing", async () => {
    const { item, root } = await make()
    await writeRollout(item.codex, { id: threadId(70), records: conversation(threadId(70)).records() })
    await writeRollout(item.codex, { id: threadId(71), zst: true, records: conversation(threadId(71)).records() })
    await writeRollout(item.codex, { id: threadId(72), archived: true, records: conversation(threadId(72)).records() })
    await writeSessionIndex(item.codex, [{ id: threadId(70), name: "n" }])
    await sentinels(item.codex, "codex")
    db(item.codex, { threads: [], keepOpen: false })
    const guard = await start([item.codex])
    const found = await CodexStore.discover(root, { tmp: item.tmp, now: NOW })
    for (const thread of found.threads) await read(root, thread.file!, { base: true, files: found.files })
    expect(await guard.stop()).toEqual([])
    const opened = guard.reports.filter((report) => report.op === "open")
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every((report) => report.real !== undefined && Paths.inside(report.real, item.codex))).toBe(true)
    expect(
      opened.every((report) =>
        report.purpose === "copy"
          ? /^state_5\.sqlite(-wal)?$/.test(path.basename(report.path))
          : /^rollout-.*\.jsonl(\.zst)?$|^session_index\.jsonl$/.test(path.basename(report.path)),
      ),
    ).toBe(true)
  })
})
