import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { OwnImport } from "@own/protocol/rpc-import"
import { ImportRpc } from "../../src/rpc.js"
import { Paths } from "../../src/sources/paths.js"
import { threadId, T0 } from "../fixtures/codex.js"
import { FAKE, SENTINEL, fixture, sentinels, stateDb, type Fixture } from "../fixtures/make.js"
import { start, type Guard } from "../support/guard.js"
import {
  CONTENT_MARK,
  bigCodex,
  call,
  containing,
  decoded,
  inProcess,
  record,
  settled,
  startImportServer,
  until,
  writeClaude,
  writeCodex,
  type ImportServer,
} from "./support.js"

/**
 * own.import I1 against the real server (09 §7.1 I1, §7.4): own-accounts and own-import loaded from their package
 * folders by own-team's harness (own-team off), synthetic Codex and Claude Code roots under a Hangul and `#` folder,
 * and a real git project: one repository under a Hangul folder with a linked worktree, a second clone of its root
 * commit under a `#` folder with its own worktree, a junction into the first clone, a subfolder and a folder that is
 * gone (IG3). The read-only guard watches every root for the whole suite (IG1); the never-open files hold
 * {@link SENTINEL} and fake keys, and every conversation holds {@link CONTENT_MARK}, none of which may reach OWN_HOME,
 * `import-index.json` or the server logs (IG10). The allowlist's own reports exist only in-process, so the last part
 * runs the same methods in this process under the guard. Run from `packages/own-import`: `bun run test:e2e`.
 */

const BOOT = 300_000
const LONG = 120_000

const CLAUDE = {
  second: "0b9e2a4c-6a7d-4c4e-9d1e-5e0000000001",
  missing: "0b9e2a4c-6a7d-4c4e-9d1e-5e0000000002",
  link: "0b9e2a4c-6a7d-4c4e-9d1e-5e0000000003",
  elsewhere: "0b9e2a4c-6a7d-4c4e-9d1e-5e0000000004",
  subst: "0b9e2a4c-6a7d-4c4e-9d1e-5e0000000005",
} as const

/** A `subst` drive: no drive is mapped on this PC, the in-process run injects the real path (09 §2.2, IG3). */
const SUBST = "S:\\own-open-code\\packages\\core"

const state = {} as {
  fixture: Fixture
  extra: string
  run: ImportServer
  guard: Guard
}

beforeAll(async () => {
  state.fixture = await fixture({ under: "한글 #roots" })
  state.extra = await state.fixture.folder("extra-codex")
  const item = state.fixture
  state.run = await startImportServer({
    name: "import-i1",
    roots: { codex: [item.codex], claude: [item.claude] },
  })
  const p = state.run.projects
  await sentinels(item.codex, "codex")
  await sentinels(item.claude, "claude-code")
  const first = await writeCodex(item.codex, 1, `\\\\?\\${p.first}`, "설치기를 고쳐 줘")
  await writeCodex(item.codex, 2, p.sub, "core 패키지를 정리해 줘")
  await writeCodex(item.codex, 3, p.firstWorktree, "설치기 성능을 재 줘", { zst: true })
  await writeCodex(item.codex, 4, p.secondWorktree, "두 번째 clone의 worktree에서")
  await writeCodex(item.codex, 5, p.elsewhere, "다른 프로젝트")
  // The state DB names thread 1 (its title holds the content mark: the copy must never outlive the read).
  stateDb(item.codex, {
    keepOpen: false,
    threads: [
      {
        id: threadId(1),
        rollout_path: first,
        cwd: `\\\\?\\${p.first}`,
        title: `설치기 정리 ${CONTENT_MARK}`,
        model: "gpt-5.5",
        created_at_ms: T0 + 60_000,
        updated_at_ms: T0 + 120_000,
      },
    ],
  })
  await writeClaude(item.claude, CLAUDE.second, p.second, "두 번째 clone의 설치기")
  await writeClaude(item.claude, CLAUDE.missing, p.missing, "지워진 폴더에서")
  await writeClaude(item.claude, CLAUDE.link, path.join(p.link, "packages", "core"), "junction으로 연 폴더")
  await writeClaude(item.claude, CLAUDE.elsewhere, p.elsewhere, "다른 곳")
  await writeClaude(item.claude, CLAUDE.subst, SUBST, "subst 드라이브에서")
  await writeCodex(state.extra, 6, p.first, "더한 뿌리의 대화")
  // Core records a folder for its project once a Location there resolved it: both clones.
  await record(state.run.server, p.first)
  await record(state.run.server, p.second)
  state.guard = await start([item.codex, item.claude, state.extra])
}, BOOT)

afterAll(async () => {
  await state.run?.server.stop()
  await state.fixture?.cleanup()
}, LONG)

const decodeSources = Schema.decodeUnknownSync(Schema.Struct({ extraRoots: Schema.Array(Schema.Unknown) }))
const decodeIndex = Schema.decodeUnknownSync(Schema.Struct({ v: Schema.Number }))

const refsOf = (items: ReadonlyArray<OwnImport.Summary>) =>
  items.map((item) => `${item.ref.kind}/${item.ref.id}`).toSorted()

const EXPECTED = [
  `codex/${threadId(1)}`,
  `codex/${threadId(2)}`,
  `codex/${threadId(3)}`,
  `codex/${threadId(4)}`,
  `claude-code/${CLAUDE.second}`,
  `claude-code/${CLAUDE.missing}`,
  `claude-code/${CLAUDE.link}`,
].toSorted()

describe("own.import I1 through the server", () => {
  test("loading reads nothing: health answers without starting the Worker", async () => {
    const health = await call(state.run.server, "health", {})
    expect(health).toEqual({
      version: expect.any(String),
      features: ["view", "search", "migrate", "skills"],
      workerReady: false,
    })
    const home = state.run.server.ownHome
    expect(await Bun.file(path.join(home, "state", "import-index.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(home, "state", "import-sources.json")).exists()).toBe(false)
  })

  test("the job methods answer from memory without starting the Worker", async () => {
    expect(await call(state.run.server, "jobs.list", {})).toEqual({ jobs: [] })
    const cancelled = await state.run.server.rpc(OwnImport.ID, "migrate.cancel", { jobID: "job_0000000000" })
    expect([cancelled.status, cancelled.type]).toEqual([400, "job_not_found"])
    const unknown = await state.run.server.rpc(OwnImport.ID, "migrate.execute", { nonce: "0000000000000000" })
    expect([unknown.status, unknown.type]).toEqual([400, "nonce_invalid"])
    expect((await call(state.run.server, "health", {})).workerReady).toBe(false)
  })

  test("sources.list gives the roots and starts the Worker", async () => {
    const listed = await call(state.run.server, "sources.list", {})
    expect(listed.roots.map((root) => [root.kind, root.available, root.added])).toEqual([
      ["codex", true, false],
      ["claude-code", true, false],
    ])
    expect((await call(state.run.server, "health", {})).workerReady).toBe(true)
  })

  test(
    "IG3: one project across both clones, their worktrees, a subfolder, a junction and a missing folder",
    async () => {
      const p = state.run.projects
      const listed = await settled(state.run.server, { directory: p.first })
      expect(refsOf(listed.items)).toEqual(EXPECTED)
      expect(listed.total).toBe(EXPECTED.length)
      expect(listed.fresh).toBe(EXPECTED.length)
      const byID = new Map(listed.items.map((item) => [String(item.ref.id), item]))
      expect(byID.get(CLAUDE.missing)?.folderExists).toBe(false)
      expect(byID.get(threadId(1))?.folderExists).toBe(true)
      expect(byID.get(threadId(1))?.title).toContain("설치기 정리")
      expect(byID.get(threadId(2))?.firstPrompt).toContain("core 패키지")
      for (const directory of [p.second, p.secondWorktree, p.firstWorktree, p.sub, p.link]) {
        const other = await settled(state.run.server, { directory })
        expect([directory, refsOf(other.items)]).toEqual([directory, EXPECTED])
      }
      const unknown = await state.run.server.rpc(OwnImport.ID, "sessions.list", { directory: p.elsewhere })
      expect([unknown.status, unknown.type]).toEqual([400, "directory_unknown"])
      const counted = await call(state.run.server, "sessions.list", { directory: p.first, limit: 0 })
      expect([counted.items.length, counted.fresh]).toEqual([0, EXPECTED.length])
    },
    LONG,
  )

  test(
    "sessions.read pages a Codex rollout, a .zst rollout and a Claude Code conversation",
    async () => {
      const listed = await settled(state.run.server, { directory: state.run.projects.first })
      const refOf = (id: string) => {
        const found = listed.items.find((item) => item.ref.id === id)
        if (found === undefined) throw new Error(`${id} is not listed`)
        return found.ref
      }
      for (const [id, prompt] of [
        [threadId(1), "설치기를 고쳐 줘"],
        [threadId(3), "설치기 성능을 재 줘"],
        [CLAUDE.second, "두 번째 clone의 설치기"],
      ] as const) {
        const read = await call(state.run.server, "sessions.read", {
          ref: refOf(id),
          directory: state.run.projects.first,
        })
        expect([id, read.summary.ref.id, read.outlineComplete, read.outline.turns.length]).toEqual([id, id, true, 1])
        expect(read.outline.turns[0]?.firstLine).toContain(prompt)
        expect(read.messages.some((message) => message.type === "user")).toBe(true)
        expect(read.next).toBeUndefined()
      }
      const missing = await state.run.server.rpc(OwnImport.ID, "sessions.read", {
        ref: { kind: "codex", rootID: refOf(threadId(1)).rootID, id: threadId(99) },
        directory: state.run.projects.first,
      })
      expect([missing.status, missing.type]).toEqual([400, "source_not_found"])
      // A conversation outside the folder's project is unknown to a plain read or search (a `read` device learns
      // nothing of other folders) and read with `scope: "all"` (this PC's windows only, 09 §5.5).
      const all = await settled(state.run.server, { directory: state.run.projects.first, scope: "all" })
      const elsewhere = all.items.find((item) => item.ref.id === threadId(5))?.ref
      if (elsewhere === undefined) throw new Error("thread 5 is not listed in scope all")
      const folder = { ref: elsewhere, directory: state.run.projects.first }
      for (const method of ["sessions.read", "sessions.search"] as const) {
        const hidden = await state.run.server.rpc(OwnImport.ID, method, { ...folder, query: "프로젝트" })
        expect([method, hidden.status, hidden.type]).toEqual([method, 400, "source_not_found"])
      }
      const shown = await call(state.run.server, "sessions.read", { ...folder, scope: "all" })
      expect(String(shown.summary.ref.id)).toBe(threadId(5))
    },
    LONG,
  )

  test(
    "sessions.search: one conversation with its tool output, and the folder's text",
    async () => {
      const listed = await settled(state.run.server, { directory: state.run.projects.first })
      const ref = listed.items.find((item) => item.ref.id === threadId(2))?.ref
      if (ref === undefined) throw new Error("thread 2 is not listed")
      const one = await call(state.run.server, "sessions.search", {
        directory: state.run.projects.first,
        ref,
        query: "2 pass",
      })
      expect(one).toEqual({ hits: [{ ref, turn: 0, snippet: expect.stringContaining("2 pass") }], complete: true })
      const folder = await call(state.run.server, "sessions.search", {
        directory: state.run.projects.first,
        query: "설치기",
      })
      expect(folder.complete).toBe(true)
      expect(folder.hits.map((hit) => String(hit.ref.id)).toSorted()).toEqual(
        [threadId(1), threadId(3), CLAUDE.second].toSorted(),
      )
      // Tool output is not searched across the folder.
      expect(
        (await call(state.run.server, "sessions.search", { directory: state.run.projects.first, query: "2 pass" }))
          .hits,
      ).toEqual([])
    },
    LONG,
  )

  test(
    "sources.configure stores a usable root only, and the control Location alone publishes index.changed",
    async () => {
      const server = state.run.server
      // Past the warm-list window, so the configure's refresh scans every root again.
      await Bun.sleep(5_500)
      const configured = await call(server, "sources.configure", {
        extraRoots: [
          { kind: "codex", directory: state.extra },
          { kind: "claude-code", directory: path.join(state.fixture.claude, "file-history") },
          { kind: "codex", directory: "relative\\folder" },
        ],
      })
      const added = configured.roots.filter((root) => root.added)
      expect(added.map((root) => [root.kind, root.available])).toEqual([["codex", true]])
      const stored = decodeSources(await Bun.file(path.join(server.ownHome, "state", "import-sources.json")).json())
      expect(stored.extraRoots).toHaveLength(1)
      const changed = await server.events.waitFor((event) => event.type === "rpc.own.import.index.changed", 30_000)
      const listed = await settled(server, { directory: state.run.projects.first })
      expect(listed.items.map((item) => String(item.ref.id))).toContain(threadId(6))
      const published = server.events.events.filter((event) => event.type.startsWith("rpc.own.import."))
      expect(published.length).toBeGreaterThan(0)
      expect(published.map((event) => event.location?.directory?.toLowerCase())).toEqual(
        published.map(() => server.control.toLowerCase()),
      )
      expect(changed.data.origin).toBe("global")
    },
    LONG,
  )

  test(
    "IG10: no sentinel, fake key or conversation text in OWN_HOME, import-index.json or the logs; no DB copy left",
    async () => {
      const home = state.run.server.ownHome
      const index = path.join(home, "state", "import-index.json")
      await until(() => Bun.file(index).exists(), "import-index.json was never written")
      const needles = [SENTINEL, FAKE.apiKey, CONTENT_MARK, "설치기", "core 패키지"]
      expect(await containing(home, needles)).toEqual([])
      const logs = state.run.server.server.logs()
      expect(needles.filter((needle) => logs.includes(needle))).toEqual([])
      const tmp = await fsp.readdir(path.join(home, "tmp")).catch(() => [])
      expect(tmp.filter((name) => name.startsWith("import-"))).toEqual([])
      expect(decodeIndex(await Bun.file(index).json()).v).toBe(1)
    },
    LONG,
  )

  test("IG1: the roots were only read for the whole run", async () => {
    expect(await state.guard.stop()).toEqual([])
  })
})

describe("the same methods in this process, where the allowlist reports every open (IG1)", () => {
  test(
    "never a never-open file, never a write; the DB only through its copy",
    async () => {
      const item = state.fixture
      const guard = await start([item.codex, item.claude])
      const home = await item.folder("in-process-home")
      // S:\ stands for the folder above the first clone, as `subst S: <that folder>` would make it.
      const drive = path.dirname(state.run.projects.first)
      const local = inProcess(state.run.server, {
        home,
        roots: { codex: [item.codex], claude: [item.claude] },
        resolve: (input) =>
          Paths.key(input).startsWith("s:\\")
            ? Paths.realpath(path.join(drive, Paths.norm(input).slice(3)))
            : Paths.realpath(input),
      })
      const listed = await local.call("sessions.list", { directory: state.run.projects.first })
      if (!listed.ok) throw new Error(JSON.stringify(listed.error))
      await local.service.idle()
      const done = await decoded(
        "sessions.list",
        await local.call("sessions.list", { directory: state.run.projects.first }),
      )
      expect(refsOf(done.items)).toEqual([...EXPECTED, `claude-code/${CLAUDE.subst}`].toSorted())
      for (const summary of done.items) {
        const read = await local.call("sessions.read", { ref: summary.ref, directory: state.run.projects.first })
        expect([summary.ref.id, read.ok]).toEqual([summary.ref.id, true])
      }
      const searched = await local.call("sessions.search", { directory: state.run.projects.first, query: "설치기" })
      expect(searched.ok).toBe(true)
      await local.service.close()
      expect(await guard.stop()).toEqual([])
      expect(guard.reports.filter((report) => report.op === "open").length).toBeGreaterThan(0)
      expect(guard.reports.some((report) => report.purpose === "copy")).toBe(true)
      expect(await fsp.readdir(path.join(home, "tmp")).catch(() => [])).toEqual([])
    },
    LONG,
  )
})

describe("the Worker", () => {
  test(
    "a crashed Worker fails its pending calls, restarts once, and stays down after a second crash",
    async () => {
      const item = state.fixture
      const root = await item.folder("crash-codex")
      await bigCodex(root, 7, state.run.projects.first, 400, 100_000)
      const ports: ImportRpc.Port[] = []
      const home = await item.folder("crash-home")
      const worker = ImportRpc.client({
        home,
        worktrees: async () => [],
        publish: () => {},
        spawn: (handlers) => {
          const port = ImportRpc.spawnWorker(handlers)
          ports.push(port)
          return port
        },
      })
      const settings = {
        options: { home, roots: { codex: [root], claude: [] }, service: state.run.server.service.importOption },
        channel: "local",
      }
      expect(worker.ready).toBe(false)
      const sources = await worker.call("sources.list", {}, settings)
      expect(sources.ok).toBe(true)
      expect(worker.ready).toBe(true)
      const ref = { kind: "codex", rootID: (await decoded("sources.list", sources)).roots[0]?.rootID, id: threadId(7) }
      const directory = state.run.projects.first
      const first = await worker.call("sessions.read", { ref, directory, count: 1 }, settings)
      expect(first.ok).toBe(true)
      // A search that walks every turn for a word that is not there, cut short by the Worker's end.
      const pending = worker.call("sessions.search", { directory, ref, query: "never-there-qq" }, settings)
      await Bun.sleep(50)
      ports.at(-1)?.terminate()
      expect(await pending).toEqual({
        ok: false,
        error: { type: "internal_error", message: "the import worker stopped", data: {} },
      })
      await until(() => worker.ready, "the Worker did not start again")
      expect(ports).toHaveLength(2)
      expect((await worker.call("sources.list", {}, settings)).ok).toBe(true)
      ports.at(-1)?.terminate()
      await Bun.sleep(200)
      expect(worker.ready).toBe(false)
      expect(await worker.call("sources.list", {}, settings)).toMatchObject({
        ok: false,
        error: { type: "internal_error" },
      })
      expect(ports).toHaveLength(2)
      await worker.close()
    },
    LONG,
  )
})
