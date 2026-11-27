import { afterEach, describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { SelfHttp } from "../../src/http.js"
import { Scan } from "../../src/index/scan.js"
import { CodexStore } from "../../src/sources/codex.js"
import { Paths } from "../../src/sources/paths.js"
import { Transcript } from "../../src/transcript/ir.js"
import { relocated, session, text, write } from "../fixtures/claude.js"
import { rollout, spawnSource, T0, threadId, writeRollout } from "../fixtures/codex.js"
import {
  codexRollout,
  FAKE,
  fixture,
  sentinels,
  stateDb,
  writeJsonl,
  type Fixture,
  type StateDb,
} from "../fixtures/make.js"
import { start } from "../support/guard.js"

/**
 * The index and `sessions.list` (09 §2.2, §2.3, §2.8, §4.7, §5.2) over synthetic roots: folder membership, order and
 * paging, the include switches, scope `all`, imported marks with `원본에 새 턴 N개`, the 2 s budget with a partial
 * answer and `index.changed`, the Claude Code confirm pass, and the incremental refreshes (the Codex DB copied again
 * only when it changed, else the recent date folders; Claude Code by folder and file mtime).
 */

const NOW = T0 + 3_600_000
const OLD = new Date(NOW - 3_600_000)

const fixtures: Fixture[] = []
const services: Scan.Service[] = []
const writers: StateDb[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  writers.splice(0).forEach((db) => db.close())
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

function uuid(n: number) {
  return `0b9e2a4c-6a7d-4c4e-9d1e-${n.toString(16).padStart(12, "0")}`
}

const decodeSession = Schema.decodeUnknownSync(SelfHttp.SessionView)

interface WorldInput {
  readonly sessions?: () => ReadonlyArray<SelfHttp.SessionView>
  /** How long the root session list (the imported marks) takes to answer. */
  readonly sessionsMs?: number
  readonly options?: Partial<Scan.Input>
}

async function world(input: WorldInput = {}) {
  const item = await fixture({ under: "한글 #roots" })
  fixtures.push(item)
  const project = await item.folder("한글 #proj")
  const other = await item.folder("other")
  const emitted: string[][] = []
  const refuse = async () => ({ ok: false as const, status: null, type: "unused", message: "not used here" })
  const http: Scan.Input["http"] = {
    project: {
      list: async () => ({ ok: true, value: [{ id: "prj_fixture", canonical: project, sandboxes: [] }] }),
    },
    session: {
      list: refuse,
      get: refuse,
      import: refuse,
      log: refuse,
      all: async () => {
        await Bun.sleep(input.sessionsMs ?? 0)
        return { ok: true, value: [...(input.sessions?.() ?? [])] }
      },
    },
  }
  const service = Scan.create({
    home: item.home,
    roots: () => Paths.roots({ options: item.options, file: Paths.sources(item.home) }),
    http,
    worktrees: async () => [project],
    git: async () => [],
    emit: (directories) => emitted.push([...directories]),
    now: () => NOW,
    persistMs: 0,
    ...input.options,
  })
  services.push(service)
  return { item, project, other, emitted, service }
}

/**
 * A Codex rollout of `turns` turns in `cwd`, written where Codex keeps it, with `mtime` as its last activity. Without
 * `mtime` the file keeps the times of its writing: setting them also sets the access time, and NTFS then updates it on
 * the first read, which the read-only guard's watcher reports as a change.
 */
function codexThread(
  root: string,
  input: {
    readonly n: number
    readonly cwd: string
    readonly prompt: string
    readonly mtime?: Date
    readonly at?: number
    readonly source?: Parameters<ReturnType<typeof rollout>["meta"]>[0]["source"]
    readonly archived?: boolean
    readonly turns?: number
  },
) {
  const records = Array.from({ length: input.turns ?? 1 }).reduce(
    (built: ReturnType<typeof rollout>, _, index) =>
      built
        .taskStarted(`u${index}`)
        .turnContext({ model: "gpt-fixture", turnId: `u${index}` })
        .user(index === 0 ? input.prompt : `${input.prompt} ${index}`, { kinds: true, turnId: `u${index}` })
        .assistant("done")
        .taskComplete(`u${index}`),
    rollout({ start: input.at ?? T0 }).meta({ id: threadId(input.n), cwd: input.cwd, source: input.source }),
  )
  return writeRollout(root, {
    id: threadId(input.n),
    at: input.at ?? T0,
    archived: input.archived,
    records: records.records(),
    ...(input.mtime === undefined ? {} : { mtime: input.mtime }),
  })
}

/** A Claude Code conversation of one exchange in `cwd`, its records starting at `start`; `mtime: null` keeps the times. */
function claudeConversation(
  root: string,
  input: {
    readonly n: number
    readonly cwd: string
    readonly prompt: string
    readonly start: number
    readonly mtime?: Date | null
  },
) {
  const conversation = { cwd: input.cwd, id: uuid(input.n), version: "2.1.288", start: input.start }
  const built = session(conversation)
  built.user(input.prompt)
  built.assistant([text("ok")], { id: `msg_FAKE${input.n}` })
  return write(root, conversation, built, input.mtime === null ? {} : { mtime: input.mtime ?? OLD })
}

async function listed(service: Scan.Service, request: Scan.ListInput) {
  const result = await service.list(request)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

describe("the project's list", () => {
  async function populated() {
    const made = await world()
    const { item, project, other } = made
    await codexThread(item.codex, {
      n: 1,
      cwd: project,
      prompt: "codex in the project",
      mtime: new Date(NOW - 50_000_000),
    })
    await codexThread(item.codex, {
      n: 2,
      cwd: `\\\\?\\${path.join(project, "packages", "core")}`,
      prompt: "codex in a subfolder",
      mtime: new Date(NOW - 40_000_000),
    })
    await codexThread(item.codex, { n: 3, cwd: other, prompt: "codex elsewhere", mtime: new Date(NOW - 30_000_000) })
    await codexThread(item.codex, {
      n: 4,
      cwd: project,
      prompt: "codex exec run",
      source: "exec",
      mtime: new Date(NOW - 20_000_000),
    })
    await codexThread(item.codex, {
      n: 5,
      cwd: project,
      prompt: "codex sub-agent",
      source: spawnSource(threadId(1)),
      mtime: new Date(NOW - 10_000_000),
    })
    await codexThread(item.codex, {
      n: 6,
      cwd: project,
      prompt: "codex archived",
      archived: true,
      mtime: new Date(NOW - 5_000_000),
    })
    // Written within the last two minutes: 진행 중일 수 있음.
    await codexThread(item.codex, { n: 7, cwd: project, prompt: "codex live", mtime: new Date(NOW - 30_000) })
    await claudeConversation(item.claude, {
      n: 1,
      cwd: project,
      prompt: "claude in the project",
      start: NOW - 45_000_000,
    })
    await claudeConversation(item.claude, { n: 2, cwd: other, prompt: "claude elsewhere", start: NOW - 35_000_000 })
    const ssh = session({ cwd: "/home/fixture/proj", id: uuid(3), version: "2.1.288", start: NOW - 25_000_000 })
    ssh.user("claude over ssh")
    ssh.assistant([text("ok")], { id: "msg_FAKE3" })
    await writeJsonl(path.join(item.claude, "projects", "ssh-0b9e2a4c", `${uuid(3)}.jsonl`), ssh.records())
    return made
  }

  test("members newest first with their list fields; other folders, exec, sub-agents and archived are left out", async () => {
    const { project, service } = await populated()
    const page = await listed(service, { directory: project })
    expect(page.items.map((summary) => summary.title)).toEqual([
      "codex live",
      "codex in a subfolder",
      "claude in the project",
      "codex in the project",
    ])
    expect(page).toMatchObject({ total: 4, fresh: 4, cursor: null, scanning: false })
    const live = page.items[0]
    expect(live).toMatchObject({
      ref: { kind: "codex", id: threadId(7) },
      firstPrompt: "codex live",
      app: "cli",
      cwd: project,
      folderExists: true,
      versions: ["0.153.0"],
      live: true,
      imported: [],
      readable: true,
      archived: false,
      otherComputer: false,
      subagents: 0,
    })
    const subfolder = page.items[1]
    expect(subfolder).toMatchObject({ folderExists: false, live: false })
    expect(page.items[2]).toMatchObject({
      ref: { kind: "claude-code", id: uuid(1) },
      app: null,
      models: [{ id: "claude-fixture-opus" }],
    })
    expect(page.items[3]).toMatchObject({ subagents: 1 })
  })

  test("include switches; a sub-agent follows its parent; scope all adds every folder and the other computer", async () => {
    const { project, service } = await populated()
    const included = await listed(service, {
      directory: project,
      include: { subagents: true, exec: true, archived: true },
    })
    expect(included.items.map((summary) => summary.title)).toEqual([
      "codex live",
      "codex archived",
      "codex exec run",
      "codex in a subfolder",
      "claude in the project",
      "codex in the project",
      "codex sub-agent",
    ])
    expect<unknown>(included.items.at(-1)?.parent).toEqual({
      kind: "codex",
      rootID: included.items[0]!.ref.rootID,
      id: threadId(1),
    })
    expect(included.items[1]).toMatchObject({ archived: true })
    expect(included.items[2]).toMatchObject({ app: "exec" })
    // The sidebar's 새 N개 counts what a default list shows.
    expect(included.fresh).toBe(4)

    const all = await listed(service, { directory: project, scope: "all" })
    // Grouped by the last folder, the group with the newest conversation first.
    expect(all.items.map((summary) => [summary.title, summary.otherComputer])).toEqual([
      ["codex live", false],
      ["claude in the project", false],
      ["codex in the project", false],
      ["claude over ssh", true],
      ["codex elsewhere", false],
      ["claude elsewhere", false],
      ["codex in a subfolder", false],
    ])
    expect(all.fresh).toBe(4)
  })

  test("title search, pages of a cursor, counts only, and an unknown folder", async () => {
    const { project, other, service } = await populated()
    expect((await listed(service, { directory: project, query: "CODEX IN" })).items.map((s) => s.title)).toEqual([
      "codex in a subfolder",
      "codex in the project",
    ])
    const titles: string[] = []
    const walk = async (cursor?: string): Promise<void> => {
      const page = await listed(service, { directory: project, limit: 3, ...(cursor === undefined ? {} : { cursor }) })
      titles.push(...page.items.map((summary) => summary.title))
      expect(page.total).toBe(4)
      if (page.cursor !== null) return walk(page.cursor)
    }
    await walk()
    expect(titles).toEqual(["codex live", "codex in a subfolder", "claude in the project", "codex in the project"])
    expect(await listed(service, { directory: project, limit: 0 })).toEqual({
      items: [],
      total: 4,
      fresh: 4,
      cursor: null,
      scanning: false,
    })
    expect(await service.list({ directory: path.join(other, "..", "nowhere") })).toEqual({
      ok: false,
      error: "directory_unknown",
    })
    // The rows lead to their files; the folder search reads the members.
    const first = (await listed(service, { directory: project })).items[0]!
    const located = service.locate(first.ref)
    expect(located?.target?.kind === "codex" && located.target.file.threadID).toBe(threadId(7))
    expect(located?.row.title).toBe("codex live")
    const resolved = await service.project(project)
    if (!resolved.ok) throw new Error(resolved.reason)
    expect<unknown>(
      service
        .members(resolved.project)
        .map((row) => row.ref.id)
        .toSorted(),
    ).toEqual([threadId(1), threadId(2), threadId(4), threadId(6), threadId(7), uuid(1)].toSorted())
    // What a read without `scope: "all"` reaches (09 §5.5): the project's rows, a sub-agent through its parent.
    const reach = (n: number) => {
      const row = service.locate({ ...first.ref, id: threadId(n) as typeof first.ref.id })?.row
      return row !== undefined && service.member(row, resolved.project)
    }
    expect([1, 2, 3, 5].map(reach)).toEqual([true, true, false, true])
    // Per root: every top-level conversation found, whatever its folder; unknown before a scan.
    expect(service.sessions(first.ref.rootID)).toBe(6)
    expect(service.sessions("codex-000000000000")).toBeUndefined()
  })

  test("a secret in a title or a first prompt shows by its name only (09 §5.5)", async () => {
    const { item, project, service } = await world()
    await codexThread(item.codex, { n: 1, cwd: project, prompt: `키는 OPENAI_API_KEY=${FAKE.apiKey}`, mtime: OLD })
    await claudeConversation(item.claude, {
      n: 1,
      cwd: project,
      prompt: `토큰 ${FAKE.github} 지워 줘`,
      start: NOW - 1_000_000,
    })
    const page = await listed(service, { directory: project })
    expect(page.items).toHaveLength(2)
    const shown = JSON.stringify(page.items)
    expect([shown.includes(FAKE.apiKey), shown.includes(FAKE.github)]).toEqual([false, false])
    expect([shown.includes("[redacted:API key]"), shown.includes("[redacted:GitHub token]")]).toEqual([true, true])
    expect(page.items.every((summary) => summary.title.includes("[redacted:"))).toBe(true)
    expect(page.items.every((summary) => summary.firstPrompt?.includes("[redacted:"))).toBe(true)
    // The title search sees the title as shown: a query that only matched inside a secret finds nothing.
    for (const query of [FAKE.apiKey.slice(6, 24), FAKE.github.slice(4, 20)])
      expect(await listed(service, { directory: project, query })).toMatchObject({ items: [], total: 0 })
    expect((await listed(service, { directory: project, query: "OPENAI_API_KEY" })).total).toBe(1)
  })

  test("a root on a network share is listed as path_denied and never read (09 §2.1)", async () => {
    const made = await world()
    await codexThread(made.item.codex, { n: 1, cwd: made.project, prompt: "local", mtime: OLD })
    const share = Paths.defaults({ options: {}, env: { CODEX_HOME: "\\\\fixture-server\\share\\codex" } })
    const unc = share.find((root) => root.kind === "codex")
    if (unc === undefined) throw new Error("no root")
    expect(Paths.denied(unc)).toBe(true)
    const seen: Paths.Report[] = []
    const stop = Paths.observe((report) => seen.push(report))
    const service = Scan.create({
      home: made.item.home,
      roots: async () => [...(await Paths.roots({ options: made.item.options, file: Paths.sources(made.item.home) })), unc],
      http: {
        project: { list: async () => ({ ok: true, value: [{ id: "prj_fixture", canonical: made.project, sandboxes: [] }] }) },
        session: noSessions(),
      },
      worktrees: async () => [made.project],
      git: async () => [],
      emit: () => undefined,
      now: () => NOW,
      persistMs: 0,
    })
    services.push(service)
    try {
      expect((await listed(service, { directory: made.project })).items.map((item) => item.title)).toEqual(["local"])
      await service.idle()
    } finally {
      stop()
    }
    expect(service.sessions(unc.rootID)).toBeUndefined()
    expect(seen.filter((report) => report.path.toLowerCase().includes("fixture-server"))).toEqual([])
  })

  test("reading the roots is read only (IG1)", async () => {
    const made = await world()
    const file = await codexThread(made.item.codex, { n: 1, cwd: made.project, prompt: "x" })
    await claudeConversation(made.item.claude, {
      n: 1,
      cwd: made.project,
      prompt: "y",
      start: NOW - 1_000_000,
      mtime: null,
    })
    // The DB is read only as a copy: opening it in place would leave -wal and -shm beside it.
    stateDb(made.item.codex, {
      threads: [{ id: threadId(1), rollout_path: file, cwd: made.project, title: "db" }],
      keepOpen: false,
    })
    await sentinels(made.item.codex, "codex")
    await sentinels(made.item.claude, "claude-code")
    const guard = await start([made.item.codex, made.item.claude])
    await listed(made.service, { directory: made.project })
    await made.service.idle()
    expect(await guard.stop()).toEqual([])
  })
})

describe("imported marks (09 §4.7)", () => {
  function meta(input: {
    readonly sourceID: string
    readonly importedAt: number
    readonly turns: number
    readonly hash: string
  }) {
    return {
      "own.import": {
        v: 1,
        kind: "codex",
        sourceID: input.sourceID,
        root: "codex-000000000000",
        path: "C:\\fixture\\rollout.jsonl",
        title: "t",
        cwd: "C:\\fixture",
        models: [],
        versions: [],
        sourceUpdatedAt: 1,
        sourceBytes: 1,
        turns: input.turns,
        contentHash: input.hash,
        mode: "full",
        checkpoint: null,
        storedFull: true,
        redactions: 0,
        dropped: {},
        importedAt: input.importedAt,
      },
    }
  }

  function view(id: string, created: number, metadata: Record<string, unknown>) {
    return decodeSession({
      id,
      projectID: "prj_fixture",
      location: { directory: "C:\\fixture" },
      metadata,
      time: { created, updated: created },
    })
  }

  test("imports per source (a fork counts once, helpers never); newTurns once a full parse still hashes the prefix", async () => {
    const state = { sessions: [] as SelfHttp.SessionView[] }
    const made = await world({ sessions: () => state.sessions })
    const file = await codexThread(made.item.codex, { n: 1, cwd: made.project, prompt: "grown", mtime: OLD, turns: 3 })
    await codexThread(made.item.codex, { n: 2, cwd: made.project, prompt: "untouched", mtime: OLD })
    const first = await listed(made.service, { directory: made.project })
    const ref = first.items.find((summary) => summary.title === "grown")!.ref
    const target = made.service.locate(ref)?.target
    if (target?.kind !== "codex") throw new Error("no rollout")
    const read = await CodexStore.transcript(target.root, target.file, { now: NOW })
    if (!read.ok) throw new Error(read.reason)
    const prefix = Transcript.contentHash(read.value.info.turns.slice(0, 2))
    state.sessions = [
      view("ses_import_a", 100, meta({ sourceID: threadId(1), importedAt: 50, turns: 2, hash: prefix })),
      // A fork of it: core copied the metadata.
      view("ses_fork_of_a", 200, meta({ sourceID: threadId(1), importedAt: 50, turns: 2, hash: prefix })),
      view("ses_import_b", 300, meta({ sourceID: threadId(1), importedAt: 60, turns: 1, hash: "0".repeat(64) })),
      view("ses_helper", 400, { "own.import": { v: 1, helper: true, jobID: "job_01FIXTURE" } }),
      view("ses_plain", 500, {}),
    ]
    const marked = await listed(made.service, { directory: made.project })
    expect(marked.fresh).toBe(1)
    const grown = () => marked.items.find((summary) => summary.title === "grown")?.imported
    expect<unknown>(grown()).toEqual([
      { sessionID: "ses_import_b", mode: "full", importedAt: 60 },
      { sessionID: "ses_import_a", mode: "full", importedAt: 50 },
    ])
    made.service.parsed(ref, read.value.info)
    const after = await listed(made.service, { directory: made.project })
    expect<unknown>(after.items.find((summary) => summary.title === "grown")?.imported).toEqual([
      { sessionID: "ses_import_b", mode: "full", importedAt: 60 },
      { sessionID: "ses_import_a", mode: "full", importedAt: 50, newTurns: 1 },
    ])
    // A full parse makes the compaction count exact while the file keeps its stamp.
    expect(after.items.find((summary) => summary.title === "grown")?.compactions).toBe(
      read.value.info.checkpoints.length,
    )
    expect(file).toBe(target.file.path)
  })

  test("marks past the budget: the last ones of the list stand in, and new ones are announced once", async () => {
    const state = { sessions: [] as SelfHttp.SessionView[] }
    const made = await world({ sessions: () => state.sessions, sessionsMs: 1_200, options: { budgetMs: 400 } })
    await codexThread(made.item.codex, { n: 1, cwd: made.project, prompt: "moved", mtime: OLD })
    await made.service.refresh()
    state.sessions = [view("ses_import_a", 100, meta({ sourceID: threadId(1), importedAt: 50, turns: 1, hash: "0".repeat(64) }))]
    const started = Date.now()
    const early = await listed(made.service, { directory: made.project })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(early.items[0]?.imported).toEqual([])
    expect(early.fresh).toBe(1)
    await until(() => made.emitted.flat().includes(made.project))
    made.emitted.splice(0)
    // The next list, slow again, shows the marks that came; the same ones landing again announce nothing.
    const next = await listed(made.service, { directory: made.project })
    expect<unknown>(next.items[0]?.imported).toEqual([{ sessionID: "ses_import_a", mode: "full", importedAt: 50 }])
    expect(next.fresh).toBe(0)
    await Bun.sleep(1_500)
    expect(made.emitted).toEqual([])
  })

  test("the service not answering is unavailable", async () => {
    const made = await world()
    const failing = Scan.create({
      home: made.item.home,
      roots: async () => [],
      http: {
        project: { list: async () => ({ ok: false, status: null, type: "unreachable", message: "x" }) },
        session: {
          list: async () => ({ ok: false, status: null, type: "unreachable", message: "x" }),
          all: async () => ({ ok: false, status: null, type: "unreachable", message: "x" }),
          get: async () => ({ ok: false, status: null, type: "unreachable", message: "x" }),
          import: async () => ({ ok: false, status: null, type: "unreachable", message: "x" }),
          log: async () => ({ ok: false, status: null, type: "unreachable", message: "x" }),
        },
      },
      worktrees: async () => [],
      emit: () => undefined,
    })
    services.push(failing)
    expect(await failing.list({ directory: made.project })).toEqual({ ok: false, error: "unavailable" })
  })
})

describe("the 2 s budget (09 §2.8, IG5) and index.changed", () => {
  test("a scan that takes longer answers in time with what it has, scanning, and announces the end", async () => {
    const gate = Promise.withResolvers<void>()
    const made = await world({
      options: {
        before: async (root) => {
          if (root.kind === "codex") await gate.promise
        },
      },
    })
    await codexThread(made.item.codex, { n: 1, cwd: made.project, prompt: "slow codex", mtime: OLD })
    await claudeConversation(made.item.claude, { n: 1, cwd: made.project, prompt: "quick claude", start: NOW - 1_000 })
    const started = Date.now()
    const partial = await listed(made.service, { directory: made.project })
    expect(Date.now() - started).toBeLessThan(Scan.BUDGET_MS + 500)
    expect(partial).toMatchObject({ scanning: true, total: 1 })
    expect(partial.items.map((summary) => summary.title)).toEqual(["quick claude"])
    expect(made.emitted).toEqual([])
    gate.resolve()
    await until(() => made.emitted.length > 0)
    expect(made.emitted.flat()).toEqual([made.project])
    // A warm list answers from the index without waiting for the budget.
    const warm = Date.now()
    const full = await listed(made.service, { directory: made.project })
    expect(full).toMatchObject({ scanning: false, total: 2 })
    expect(Date.now() - warm).toBeLessThan(Scan.BUDGET_MS / 2)
  })

  test("a membership the confirm pass finds in the middle of a Claude Code file is announced", async () => {
    const worktree = "C:\\work\\proj\\.worktrees\\feature"
    const made = await world()
    const fixtureSession = relocated("2.1.288", worktree)
    await write(made.item.claude, fixtureSession.input, fixtureSession.session, { mtime: OLD })
    const finder: Scan.Input["http"]["project"] = {
      list: async () => ({ ok: true, value: [{ id: "prj_feature", canonical: worktree, sandboxes: [] }] }),
    }
    const service = Scan.create({
      home: made.item.home,
      roots: () => Paths.roots({ options: made.item.options, file: Paths.sources(made.item.home) }),
      http: { project: finder, session: noSessions() },
      worktrees: async () => [],
      git: async () => [],
      emit: (directories) => made.emitted.push([...directories]),
      now: () => NOW,
      persistMs: 0,
    })
    services.push(service)
    // Provisional: the first and last 64 KiB only name C:\work\proj.
    expect(await listed(service, { directory: worktree })).toMatchObject({ items: [], scanning: false })
    await service.idle()
    await until(() => made.emitted.length > 0)
    expect(made.emitted.flat()).toEqual([worktree])
    const confirmed = await listed(service, { directory: worktree })
    expect<unknown>(confirmed.items.map((summary) => summary.ref.id)).toEqual([fixtureSession.input.id])
  })
})

/** A session client that answers no sessions. */
function noSessions(): Scan.Input["http"]["session"] {
  const refuse = async () => ({ ok: false as const, status: null, type: "unused", message: "not used here" })
  return { list: refuse, get: refuse, import: refuse, log: refuse, all: async () => ({ ok: true, value: [] }) }
}

describe("incremental refreshes (09 §2.3 증분)", () => {
  test("Codex: the state DB is copied again only when it or its -wal changed; else only recent date folders", async () => {
    const made = await world({ options: { refreshMs: 0 } })
    const recorded = await codexThread(made.item.codex, { n: 1, cwd: made.project, prompt: "in the db", mtime: OLD })
    const old = await codexThread(made.item.codex, {
      n: 2,
      cwd: made.project,
      prompt: "a month ago",
      at: Date.UTC(2026, 8, 1, 9),
      mtime: new Date(Date.UTC(2026, 8, 1, 10)),
    })
    const db = stateDb(made.item.codex, {
      threads: [{ id: threadId(1), rollout_path: recorded, cwd: made.project, title: "db title" }],
    })
    writers.push(db)
    const reports: Paths.Report[] = []
    const unobserve = Paths.observe((report) => reports.push(report))
    try {
      const first = await listed(made.service, { directory: made.project })
      expect(first.items.map((summary) => summary.title).toSorted()).toEqual(["a month ago", "db title"])
      expect(reports.filter((report) => report.op === "open" && report.purpose === "copy").length).toBeGreaterThan(0)

      reports.splice(0)
      await codexThread(made.item.codex, {
        n: 3,
        cwd: made.project,
        prompt: "new today",
        mtime: new Date(NOW - 60_000),
      })
      const quick = await listed(made.service, { directory: made.project })
      expect(quick.items.map((summary) => summary.title)).toEqual(["new today", "db title", "a month ago"])
      // The DB and its -wal are stat'ed (the stamp), never opened.
      expect(reports.filter((report) => report.purpose === "copy").map((report) => report.op)).toEqual(["stat", "stat"])
      const listedFolders = reports.filter((report) => report.op === "list").map((report) => Paths.key(report.path))
      expect(listedFolders).toContain(Paths.key(path.dirname(codexRollout(made.item.codex, { id: "x", at: T0 }))))
      expect(listedFolders).not.toContain(Paths.key(path.dirname(old)))

      reports.splice(0)
      db.insert([
        {
          id: threadId(4),
          rollout_path: codexRollout(made.item.codex, { id: threadId(4), at: T0 }),
          cwd: made.item.dir,
          title: "later",
        },
      ])
      await listed(made.service, { directory: made.project })
      expect(reports.filter((report) => report.op === "open" && report.purpose === "copy").length).toBeGreaterThan(0)
    } finally {
      unobserve()
    }
  })

  test("Claude Code: unchanged folders are not listed again and unchanged files not read again", async () => {
    const made = await world({ options: { refreshMs: 0 } })
    const changed = await claudeConversation(made.item.claude, {
      n: 1,
      cwd: made.project,
      prompt: "grows",
      start: NOW - 9_000,
    })
    const kept = await claudeConversation(made.item.claude, {
      n: 2,
      cwd: made.project,
      prompt: "stays",
      start: NOW - 8_000,
    })
    await claudeConversation(made.item.claude, { n: 3, cwd: made.other, prompt: "other folder", start: NOW - 7_000 })
    await listed(made.service, { directory: made.project })
    await made.service.idle()
    const reports: Paths.Report[] = []
    const unobserve = Paths.observe((report) => reports.push(report))
    try {
      await fsp.appendFile(
        changed,
        `${JSON.stringify({ type: "custom-title", customTitle: "renamed", sessionId: uuid(1) })}\n`,
      )
      await claudeConversation(made.item.claude, { n: 4, cwd: made.other, prompt: "new in other", start: NOW - 6_000 })
      await made.service.refresh()
      const opened = reports.filter((report) => report.op === "open").map((report) => Paths.key(report.path))
      expect(opened).toContain(Paths.key(changed))
      expect(opened).not.toContain(Paths.key(kept))
      const folders = reports.filter((report) => report.op === "list").map((report) => Paths.key(report.path))
      expect(folders).toContain(Paths.key(path.join(made.item.claude, "projects")))
      expect(folders).not.toContain(Paths.key(path.dirname(kept)))
      expect(folders.some((folder) => folder.endsWith("other"))).toBe(true)
    } finally {
      unobserve()
    }
    const page = await listed(made.service, { directory: made.project })
    expect(page.items.map((summary) => summary.title)).toEqual(["stays", "renamed"])
  })

  test("a full refresh scans a root added inside the warm window (sources.configure) and announces it", async () => {
    const made = await world()
    await codexThread(made.item.codex, { n: 1, cwd: made.project, prompt: "in the default root" })
    expect((await listed(made.service, { directory: made.project })).total).toBe(1)
    await made.service.idle()
    made.emitted.splice(0)

    const extra = await made.item.folder("added codex")
    await codexThread(extra, { n: 2, cwd: made.project, prompt: "in the added root" })
    const file = Paths.sources(made.item.home)
    await Paths.configure(file, [{ kind: "codex", directory: extra }])
    const added = (await Paths.roots({ options: made.item.options, file })).find((root) => root.added)
    if (added === undefined) throw new Error("the added root is missing")
    // Inside the warm window an ordinary refresh re-reads the known rows only.
    await made.service.refresh()
    expect(made.service.sessions(added.rootID)).toBeUndefined()

    await made.service.refresh({ full: true })
    expect(made.service.sessions(added.rootID)).toBe(1)
    await until(() => made.emitted.some((directories) => directories.includes(made.project)))
    const page = await listed(made.service, { directory: made.project })
    expect(page.items.map((summary) => summary.title).toSorted()).toEqual(["in the added root", "in the default root"])
  })
})
