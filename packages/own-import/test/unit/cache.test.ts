import { afterEach, describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import path from "node:path"
import { IndexCache } from "../../src/index/cache.js"
import { Scan } from "../../src/index/scan.js"
import { Paths } from "../../src/sources/paths.js"
import { session, text, write } from "../fixtures/claude.js"
import { rollout, T0, threadId, writeRollout } from "../fixtures/codex.js"
import { fixture, SENTINEL, type Fixture } from "../fixtures/make.js"

/**
 * The index caches (09 §2.3 캐시, IG10): values read from a file are kept in memory by `(path, size, mtimeMs)`;
 * `OWN_HOME/state/import-index.json` keeps only what is not conversation content, so the first list after a restart
 * reads the listed folder's files and not the others. Titles and first prompts never reach the disk.
 */

const NOW = T0 + 3_600_000
/** Conversation text that must stay in memory: prompts and titles carry it. */
const MARK = "ig10-conversation-content-7d3e"

const fixtures: Fixture[] = []
const services: Scan.Service[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

describe("the memory cache", () => {
  test("a value is valid while the file keeps its size and mtime", () => {
    const memory = IndexCache.memory<string>()
    memory.set("C:\\a.jsonl", { size: 10, mtimeMs: 5 }, "head")
    expect(memory.get("C:\\a.jsonl", { size: 10, mtimeMs: 5 })).toBe("head")
    expect(memory.get("C:\\a.jsonl", { size: 11, mtimeMs: 5 })).toBeUndefined()
    expect(memory.get("C:\\a.jsonl", { size: 10, mtimeMs: 6 })).toBeUndefined()
    expect(memory.get("C:\\b.jsonl", { size: 10, mtimeMs: 5 })).toBeUndefined()
    memory.delete("C:\\a.jsonl")
    expect(memory.size).toBe(0)
  })
})

describe("import-index.json", () => {
  const entry: IndexCache.Entry = {
    path: "C:\\codex\\sessions\\2026\\10\\08\\rollout-2026-10-08T09-00-00-t1.jsonl",
    size: 120,
    mtimeMs: 1_790_000_000_000,
    kind: "codex",
    rootID: "codex-0123456789ab",
    id: "t1",
    cwds: ["C:\\work\\proj"],
    subagent: false,
    exec: false,
    createdAt: 1,
    updatedAt: 2,
    versions: ["0.153.0"],
  }

  test("saved atomically with the declared fields only, and loaded back by path", async () => {
    const item = await fixture()
    fixtures.push(item)
    const richer = { ...entry, title: `${MARK} title`, firstPrompt: MARK } as IndexCache.Entry
    await IndexCache.save(item.home, [richer, { ...entry, path: "C:\\b.jsonl", kind: "claude-code", confirmed: true }])
    const text = await Bun.file(IndexCache.file(item.home)).text()
    expect(text).not.toContain(MARK)
    const loaded = await IndexCache.load(item.home)
    expect([...loaded.keys()]).toEqual([entry.path, "C:\\b.jsonl"])
    expect(loaded.get(entry.path)).toEqual(entry)
    expect(await fsp.readdir(path.dirname(IndexCache.file(item.home)))).toEqual(["import-index.json"])
  })

  test("a missing, damaged or foreign file gives an empty index", async () => {
    const item = await fixture()
    fixtures.push(item)
    expect((await IndexCache.load(item.home)).size).toBe(0)
    await fsp.mkdir(path.dirname(IndexCache.file(item.home)), { recursive: true })
    for (const content of [
      "{not json",
      JSON.stringify({ v: 2, entries: [] }),
      JSON.stringify({ v: 1, entries: [{}] }),
    ]) {
      await fsp.writeFile(IndexCache.file(item.home), content)
      expect((await IndexCache.load(item.home)).size).toBe(0)
    }
  })
})

describe("the index after a restart (IG10)", () => {
  async function world() {
    const item = await fixture({ under: "한글 #roots" })
    fixtures.push(item)
    const project = await item.folder("한글 #proj")
    const other = await item.folder("other")
    const reads = { opened: [] as string[] }
    const make = () => {
      const service = Scan.create({
        home: item.home,
        roots: () => Paths.roots({ options: item.options, file: Paths.sources(item.home) }),
        http: {
          project: {
            list: async () => ({ ok: true, value: [{ id: "prj_fixture", canonical: project, sandboxes: [] }] }),
          },
          session: {
            list: refuse,
            get: refuse,
            import: refuse,
            log: refuse,
            all: async () => ({ ok: true, value: [] }),
          },
        },
        worktrees: async () => [project],
        git: async () => [],
        emit: () => undefined,
        now: () => NOW,
        persistMs: 0,
      })
      services.push(service)
      return service
    }
    const codex = (n: number, cwd: string, prompt: string) =>
      writeRollout(item.codex, {
        id: threadId(n),
        records: rollout()
          .meta({ id: threadId(n), cwd })
          .taskStarted("u1")
          .user(prompt, { kinds: true, turnId: "u1" })
          .assistant(`answer ${MARK}`)
          .taskComplete("u1")
          .records(),
      })
    const claude = (n: number, cwd: string, prompt: string) => {
      const input = { cwd, id: `0b9e2a4c-6a7d-4c4e-9d1e-${String(n).padStart(12, "0")}`, version: "2.1.288" }
      const built = session(input)
      built.user(prompt)
      built.assistant([text(`answer ${MARK}`)], { id: `msg_FAKE${n}` })
      built.meta({ type: "ai-title", aiTitle: `title ${MARK} ${SENTINEL}` })
      return write(item.claude, input, built)
    }
    return { item, project, other, reads, make, codex, claude }
  }

  const refuse = async () => ({ ok: false as const, status: null, type: "unused", message: "not used here" })

  test("holds no conversation content, and lets a restarted index read only the listed folder's files", async () => {
    const made = await world()
    const member = await made.codex(1, made.project, `codex prompt ${MARK}`)
    const stranger = await made.codex(2, made.other, `codex prompt ${MARK}`)
    const memberChat = await made.claude(1, made.project, `claude prompt ${MARK}`)
    const strangerChat = await made.claude(2, made.other, `claude prompt ${MARK}`)

    const first = made.make()
    const page = await first.list({ directory: made.project })
    expect(page.ok && page.value.items.map((summary) => summary.title).toSorted()).toEqual(
      [`codex prompt ${MARK}`, `title ${MARK} ${SENTINEL}`].toSorted(),
    )
    await first.idle()
    const text = await Bun.file(IndexCache.file(made.item.home)).text()
    expect(text).not.toContain(MARK)
    expect(text).not.toContain(SENTINEL)
    const stored = await IndexCache.load(made.item.home)
    expect([...stored.keys()].map(Paths.key).toSorted()).toEqual(
      [member, stranger, memberChat, strangerChat].map(Paths.key).toSorted(),
    )
    const allowed = Object.keys(IndexCache.Entry.fields)
    for (const value of stored.values()) for (const key of Object.keys(value)) expect(allowed).toContain(key)
    expect(stored.get(memberChat)).toMatchObject({
      kind: "claude-code",
      cwds: [Paths.norm(made.project)],
      confirmed: true,
    })
    expect(stored.get(member)).toMatchObject({ kind: "codex", id: threadId(1), cwds: [Paths.norm(made.project)] })
    // Nothing else under OWN_HOME holds content: the DB copies are gone.
    const files = await fsp.readdir(made.item.home, { recursive: true })
    for (const file of files) {
      const full = path.join(made.item.home, file)
      if ((await fsp.stat(full)).isFile()) expect(await Bun.file(full).text()).not.toContain(MARK)
    }
    await first.close()

    const opened: string[] = []
    const unobserve = Paths.observe((report) => {
      if (report.op === "open") opened.push(Paths.key(report.path))
    })
    try {
      const second = made.make()
      const again = await second.list({ directory: made.project })
      await second.idle()
      expect(again.ok && again.value.items.map((summary) => summary.title).toSorted()).toEqual(
        [`codex prompt ${MARK}`, `title ${MARK} ${SENTINEL}`].toSorted(),
      )
      expect(again.ok && again.value.scanning).toBe(false)
      // The members were filled in from their files; the other folder's files were never opened.
      expect(opened).toContain(Paths.key(member))
      expect(opened).toContain(Paths.key(memberChat))
      expect(opened).not.toContain(Paths.key(stranger))
      expect(opened).not.toContain(Paths.key(strangerChat))
    } finally {
      unobserve()
    }
  })

  test("a file that changed since it was stored is read again", async () => {
    const made = await world()
    const chat = await made.claude(1, made.other, `claude prompt ${MARK}`)
    const first = made.make()
    await first.list({ directory: made.project })
    await first.idle()
    await first.close()
    // The conversation moved into the project: only reading the changed file again shows it.
    const moved = session({ cwd: made.project, id: "0b9e2a4c-6a7d-4c4e-9d1e-000000000001", version: "2.1.288" })
    moved.user("now in the project")
    await fsp.appendFile(
      chat,
      moved
        .records()
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    )
    const second = made.make()
    const page = await second.list({ directory: made.project })
    expect<unknown>(page.ok && page.value.items.map((summary) => summary.ref.id)).toEqual([
      "0b9e2a4c-6a7d-4c4e-9d1e-000000000001",
    ])
  })
})
