// Import screens (09 §3, §6) over the real typed own.import client (`createImportRpc`) with a fake transport: the
// sidebar's `새 N개` (counted only after the list paint, refreshed by `index.changed` and a succeeded import, hidden at
// 0, with 사이드바에 보이기 off, without own.import and on a connection that may not list), the scope gates, the list's
// filters and rows, the tags with the Q3 rule, the viewer's pages and compaction markers, the outline while it streams,
// search hits and the text copy. Fixtures go through the protocol's schemas; no real tool data is read.
import { afterEach, describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { createRoot, createSignal } from "solid-js"
import { createEventBus } from "@/data/events"
import { createImportRpc, IMPORT_EVENT_PREFIX, type ImportMethod } from "@/data/import-rpc"
import { ALL_SCOPES, type OwnScope } from "@/data/rpc"
import { ko } from "@/i18n/ko"
import {
  appendPage,
  CLAUDE_CLEANUP_DAYS,
  compactionKinds,
  DEFAULT_FILTERS,
  expiry,
  EXPIRY_TAG_DAYS,
  followOutline,
  hitGroups,
  listInput,
  listRows,
  mergeHits,
  outlineEntries,
  pageWindow,
  prependPage,
  previousPage,
  requestsBefore,
  rowTags,
  transcriptText,
  placeOf,
  turnAnchor,
  turnIndex,
  versionRange,
  VIEW_KEY,
  windowEnd,
  type Hit,
  type Outline,
} from "./model"
import { createImportStore, importGates, importSidebarShown, refKey, setImportSidebarShown } from "./store"
import { importEn, importKo } from "./strings"

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const decodeSummary = Schema.decodeUnknownSync(OwnImport.Summary)
const decodeOutline = Schema.decodeUnknownSync(OwnImport.Outline)
const decodeHit = Schema.decodeUnknownSync(OwnImport.Hit)
const decodeHealth = Schema.decodeUnknownSync(OwnImport.Health)

afterEach(() => setImportSidebarShown(true))

// ---------------------------------------------------------------------------------------------------------------
// Fake own.import

type Answer = unknown | ((input: Record<string, unknown>) => unknown)

function fakeImport(answers: Partial<Record<ImportMethod, Answer>>, scopes: ReadonlySet<OwnScope> = ALL_SCOPES) {
  const calls: { readonly method: string; readonly input: Record<string, unknown> }[] = []
  const client = {
    rpc: {
      call: async (request: { method: ImportMethod; input: Record<string, unknown> }) => {
        calls.push({ method: request.method, input: request.input })
        const entry = answers[request.method]
        const answer = typeof entry === "function" ? await entry(request.input) : entry
        if (answer instanceof Error) throw answer
        return { output: answer }
      },
    },
  }
  // SAFETY: the client under test only calls `rpc.call`.
  const rpc = createImportRpc({
    client: () => client as unknown as OpenCodeClient,
    control: async () => "C:\\ctl",
    scopes: () => scopes,
  })
  return { calls, rpc }
}

const HEALTH = { version: "0.0.0-test", features: ["view", "search"], workerReady: false }
const counts = (fresh: Record<string, number>) => (input: Record<string, unknown>) => ({
  items: [],
  total: fresh[String(input.directory)] ?? 0,
  fresh: fresh[String(input.directory)] ?? 0,
  cursor: null,
  scanning: false,
})

function setup(
  options: {
    answers?: Partial<Record<ImportMethod, Answer>>
    scopes?: ReadonlySet<OwnScope>
    connected?: boolean
  } = {},
) {
  const fake = fakeImport(
    { health: HEALTH, "sessions.list": counts({ "D:\\work\\a": 3, "D:\\work\\b": 0 }), ...options.answers },
    options.scopes,
  )
  const bus = createEventBus()
  const [connected, setConnected] = createSignal(options.connected ?? true)
  const queued: (() => void)[] = []
  const store = createRoot(() =>
    createImportStore({ rpc: fake.rpc, bus, connected, later: (run) => void queued.push(run) }),
  )
  /** The list was painted and the page is idle: runs what waited, then lets the calls settle. */
  const idle = async () => {
    queued.splice(0).forEach((run) => run())
    for (let turn = 0; turn < 10; turn++) await Bun.sleep(0)
  }
  const publish = (name: string, data: Record<string, unknown>) => {
    bus.publish(
      // SAFETY: shaped like the `V2EventRpc` frame the server sends for plugin RPC events.
      {
        id: "evt_1",
        type: `${IMPORT_EVENT_PREFIX}${name}`,
        created: NOW,
        data: { eventId: "01J0000000000000000000000A", origin: "global", ...data },
      } as unknown as OpenCodeEvent,
    )
    bus.flush()
  }
  return { ...fake, store, idle, publish, setConnected, queued }
}

const methods = (calls: readonly { readonly method: string }[]) => calls.map((call) => call.method)

describe("sidebar `새 N개` (09 §6 entry 1)", () => {
  test("nothing is asked before the list paint; then health once and one count per open project", async () => {
    const { calls, store, idle } = setup()
    store.watch("prj_a", "D:\\work\\a")
    store.watch("prj_b", "D:\\work\\b")
    store.watch("prj_a", "D:\\work\\a")
    expect(calls).toEqual([])
    expect(store.entry("prj_a")).toBe(0)
    await idle()
    expect(methods(calls)).toEqual(["health", "sessions.list", "sessions.list"])
    expect(calls.slice(1).map((call) => call.input)).toEqual([
      { directory: "D:\\work\\a", limit: 0 },
      { directory: "D:\\work\\b", limit: 0 },
    ])
    expect(store.available()).toBe(true)
    expect(store.entry("prj_a")).toBe(3)
    // Nothing new: no row.
    expect(store.entry("prj_b")).toBe(0)
  })

  test("index.changed recounts the folders it names, every watched one when it names none of them", async () => {
    const fresh = { "D:\\work\\a": 3, "D:\\work\\b": 0 }
    const { calls, store, idle, publish } = setup({ answers: { "sessions.list": counts(fresh) } })
    store.watch("prj_a", "D:\\work\\a")
    store.watch("prj_b", "D:\\work\\b")
    await idle()
    calls.length = 0
    fresh["D:\\work\\b"] = 2
    publish("index.changed", { directories: ["d:/work/b/"] })
    await idle()
    expect(calls.map((call) => call.input.directory)).toEqual(["D:\\work\\b"])
    expect(store.entry("prj_b")).toBe(2)
    calls.length = 0
    publish("index.changed", {})
    await idle()
    expect(calls.map((call) => call.input.directory).sort()).toEqual(["D:\\work\\a", "D:\\work\\b"])
    calls.length = 0
    publish("index.changed", { directories: ["E:\\elsewhere"] })
    await idle()
    expect(calls).toHaveLength(2)
    // A job event is not a list change.
    calls.length = 0
    publish("job.progress", { jobID: "job_01J0000000000000000000000A", step: "reading" })
    await idle()
    expect(calls).toEqual([])
  })

  test("a succeeded import recounts every watched project; a failed or cancelled one recounts nothing", async () => {
    const fresh = { "D:\\work\\a": 3, "D:\\work\\b": 0 }
    const { calls, store, idle, publish } = setup({ answers: { "sessions.list": counts(fresh) } })
    store.watch("prj_a", "D:\\work\\a")
    store.watch("prj_b", "D:\\work\\b")
    await idle()
    calls.length = 0
    const job = { jobID: "job_01J0000000000000000000000A" }
    publish("job.finished", { ...job, outcome: "failed", error: { type: "summary_failed", message: "x" } })
    publish("job.finished", { ...job, outcome: "cancelled" })
    await idle()
    expect(calls).toEqual([])
    fresh["D:\\work\\a"] = 2
    publish("job.finished", { ...job, outcome: "succeeded", sessionID: "ses_imported" })
    await idle()
    expect(calls.map((call) => call.input.directory).sort()).toEqual(["D:\\work\\a", "D:\\work\\b"])
    expect(store.entry("prj_a")).toBe(2)
  })

  test("everything imported (fresh 0) hides the row; a full list read keeps the count in step", async () => {
    const { store, idle } = setup()
    store.watch("prj_a", "D:\\work\\a")
    await idle()
    expect(store.entry("prj_a")).toBe(3)
    store.setFresh("prj_a", 0)
    expect(store.entry("prj_a")).toBe(0)
    // A project nobody watches is not tracked by a list read.
    store.setFresh("prj_z", 5)
    expect(store.entry("prj_z")).toBe(0)
  })

  test("설정 > 다른 도구 > 사이드바에 보이기 (on by default, per viewer) hides the row", async () => {
    expect(importSidebarShown()).toBe(true)
    const { store, idle } = setup()
    store.watch("prj_a", "D:\\work\\a")
    await idle()
    setImportSidebarShown(false)
    expect(store.entry("prj_a")).toBe(0)
    expect(localStorage.getItem("own.web.import.sidebar")).toBe("off")
    setImportSidebarShown(true)
    expect(store.entry("prj_a")).toBe(3)
    expect(localStorage.getItem("own.web.import.sidebar")).toBeNull()
  })

  test("without own.import (health fails) nothing is counted and no entry shows", async () => {
    const gone = Object.assign(new Error("unknown rpc"), { _tag: "RpcError", type: "not_found" })
    const { calls, store, idle } = setup({ answers: { health: gone } })
    store.watch("prj_a", "D:\\work\\a")
    store.prepare()
    await idle()
    expect(methods(calls)).toEqual(["health"])
    expect(store.health()).toBeNull()
    expect(store.available()).toBe(false)
    expect(store.entry("prj_a")).toBe(0)
  })

  test("a gateway device (`read`, no `local`) counts like this PC's windows (I2 scopes, 09 §5.5 Q2)", async () => {
    const { calls, store, idle } = setup({ scopes: new Set<OwnScope>(["read", "prompt"]) })
    store.watch("prj_a", "D:\\work\\a")
    await idle()
    expect(methods(calls)).toEqual(["health", "sessions.list"])
    expect(store.available()).toBe(true)
    expect(store.entry("prj_a")).toBe(3)
  })

  test("rows that asked before the connection was up are counted once it is; a reconnect asks health again", async () => {
    const { calls, store, idle, setConnected } = setup({ connected: false })
    store.watch("prj_a", "D:\\work\\a")
    await idle()
    expect(calls).toEqual([])
    setConnected(true)
    await idle()
    expect(methods(calls)).toEqual(["health", "sessions.list"])
    expect(store.entry("prj_a")).toBe(3)
    setConnected(false)
    setConnected(true)
    await idle()
    expect(methods(calls)).toEqual(["health", "sessions.list", "health", "sessions.list"])
  })
})

describe("scope gates (09 §5.5)", () => {
  const health = decodeHealth(HEALTH)
  test("this PC's windows: every view and `찾을 곳`; `이어서 하기` only with a build that lists `migrate`", () => {
    const { rpc } = fakeImport({})
    expect(importGates(health, rpc.allowed)).toEqual({
      list: true,
      view: true,
      search: true,
      roots: true,
      configure: true,
      allFolders: true,
      migrate: false,
    })
    expect(importGates(decodeHealth({ ...HEALTH, features: ["view", "search", "migrate"] }), rpc.allowed).migrate).toBe(
      true,
    )
    expect(importGates(decodeHealth({ ...HEALTH, features: ["view"] }), rpc.allowed).search).toBe(false)
  })

  test("a device: `read` views, `prompt` also moves, `찾을 곳` and `모든 폴더` stay this PC's; no own.import: none", () => {
    const migrating = decodeHealth({ ...HEALTH, features: ["view", "search", "migrate"] })
    const device = fakeImport({}, new Set<OwnScope>(["read", "prompt"]))
    expect(importGates(migrating, device.rpc.allowed)).toEqual({
      list: true,
      view: true,
      search: true,
      roots: true,
      configure: false,
      allFolders: false,
      migrate: true,
    })
    const reader = fakeImport({}, new Set<OwnScope>(["read"]))
    expect(importGates(migrating, reader.rpc.allowed)).toMatchObject({ list: true, view: true, migrate: false })
    const { rpc } = fakeImport({})
    expect(Object.values(importGates(null, rpc.allowed)).some(Boolean)).toBe(false)
    expect(Object.values(importGates(undefined, rpc.allowed)).some(Boolean)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// List

function summary(fields: Record<string, unknown> = {}) {
  return decodeSummary({
    ref: { kind: "codex", rootID: "codex-0a1b2c3d4e5f", id: "t1" },
    title: "리뷰 지적 고치기",
    firstPrompt: "리뷰에서 나온 지적을 고쳐 줘",
    app: "cli",
    cwd: "D:\\work\\a",
    folderExists: true,
    models: [{ provider: "openai", id: "gpt-5.5-codex" }],
    versions: ["0.150.0", "0.153.2"],
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - DAY,
    compactions: 0,
    subagents: 0,
    live: false,
    imported: [],
    readable: true,
    archived: false,
    otherComputer: false,
    ...fields,
  })
}

describe("list (09 §6 목록)", () => {
  test("the filters become the sessions.list input; the kind is filtered on the rows", () => {
    expect(listInput("D:\\work\\a", DEFAULT_FILTERS, "  ")).toEqual({
      directory: "D:\\work\\a",
      scope: "folder",
      include: { subagents: false, exec: false, archived: false },
    })
    expect(
      listInput("D:\\work\\a", { ...DEFAULT_FILTERS, scope: "all", exec: true }, ` ${"가".repeat(250)} `, "c2"),
    ).toEqual({
      directory: "D:\\work\\a",
      scope: "all",
      include: { subagents: false, exec: true, archived: false },
      query: "가".repeat(200),
      cursor: "c2",
    })
    const items = [summary(), summary({ ref: { kind: "claude-code", rootID: "claude-0a1b2c3d4e5f", id: "s1" } })]
    expect(listRows(items, { ...DEFAULT_FILTERS, kind: "claude-code" }, new Set()).map((row) => row.key)).toEqual([
      "claude-code/claude-0a1b2c3d4e5f/s1",
    ])
    expect(listRows(items, DEFAULT_FILTERS, new Set())).toHaveLength(2)
  })

  test("sub-agent conversations fold under a loaded parent; an orphan stays a row", () => {
    const parent = summary({ subagents: 2 })
    const child = (id: string, parentID = "t1") =>
      summary({
        ref: { kind: "codex", rootID: "codex-0a1b2c3d4e5f", id },
        parent: { kind: "codex", rootID: "codex-0a1b2c3d4e5f", id: parentID },
      })
    const items = [parent, child("t1-a"), child("t1-b"), child("t9-a", "t9")]
    const folded = listRows(items, DEFAULT_FILTERS, new Set())
    expect(folded.map((row) => (row.type === "item" ? [row.key, row.child, row.children, row.open] : row.key))).toEqual(
      [
        ["codex/codex-0a1b2c3d4e5f/t1", false, 2, false],
        ["codex/codex-0a1b2c3d4e5f/t9-a", false, 0, false],
      ],
    )
    const open = listRows(items, DEFAULT_FILTERS, new Set([refKey(parent.ref)]))
    expect(open.map((row) => (row.type === "item" ? `${row.child ? "  " : ""}${row.summary.ref.id}` : ""))).toEqual([
      "t1",
      "  t1-a",
      "  t1-b",
      "t9-a",
    ])
  })

  test("모든 폴더 groups by cwd (Windows paths compare without case or separators), newest group first", () => {
    const items = [
      summary({ ref: { kind: "codex", rootID: "r", id: "a1" }, cwd: "D:\\work\\a" }),
      summary({ ref: { kind: "codex", rootID: "r", id: "b1" }, cwd: "D:\\Work\\B", folderExists: false }),
      summary({ ref: { kind: "codex", rootID: "r", id: "a2" }, cwd: "d:/work/a/" }),
      summary({ ref: { kind: "claude-code", rootID: "c", id: "x" }, cwd: "/home/me/x", otherComputer: true }),
    ]
    const rows = listRows(items, { ...DEFAULT_FILTERS, scope: "all" }, new Set())
    expect(
      rows.map((row) =>
        row.type === "folder"
          ? `[${row.cwd} ${row.count}${row.exists ? "" : " gone"}${row.otherComputer ? " other" : ""}]`
          : row.summary.ref.id,
      ),
    ).toEqual(["[D:\\work\\a 2]", "a1", "a2", "[D:\\Work\\B 1 gone]", "b1", "[/home/me/x 1 other]", "x"])
  })
})

describe("tags (09 §6) and the Q3 rule (§8.2)", () => {
  test("가져옴, 원본에 새 턴 N개 (of the newest import), 진행 중일 수 있음, 폴더 없음, 읽을 수 없음 and the rest, in order", () => {
    const tagged = summary({
      imported: [
        { sessionID: "ses_old", mode: "full", importedAt: NOW - 3 * DAY, newTurns: 9 },
        { sessionID: "ses_new", mode: "summary", importedAt: NOW - DAY, newTurns: 4 },
      ],
      live: true,
      folderExists: false,
      readable: false,
      problem: "too_large",
      archived: true,
      app: "exec",
      otherComputer: true,
    })
    expect(rowTags(tagged, NOW)).toEqual([
      { kind: "imported" },
      { kind: "newTurns", n: 4 },
      { kind: "live" },
      { kind: "folderMissing" },
      { kind: "unreadable", problem: "too_large" },
      { kind: "archived" },
      { kind: "exec" },
      { kind: "otherComputer" },
    ])
    expect(rowTags(summary(), NOW)).toEqual([])
    expect(rowTags(summary({ imported: [{ sessionID: "ses_a", mode: "full", importedAt: NOW }] }), NOW)).toEqual([
      { kind: "imported" },
    ])
  })

  test("Claude Code rows not imported yet: N = 30 − age in days; the tag from 7 days left, the tooltip before", () => {
    const claude = (age: number, fields: Record<string, unknown> = {}) =>
      summary({ ref: { kind: "claude-code", rootID: "claude-1", id: "s1" }, updatedAt: NOW - age, ...fields })
    expect(CLAUDE_CLEANUP_DAYS).toBe(30)
    expect(EXPIRY_TAG_DAYS).toBe(7)
    expect(expiry(claude(DAY / 2), NOW)).toEqual({ days: 30, tag: false })
    expect(expiry(claude(22 * DAY + 1), NOW)).toEqual({ days: 8, tag: false })
    expect(expiry(claude(23 * DAY), NOW)).toEqual({ days: 7, tag: true })
    expect(rowTags(claude(23 * DAY), NOW)).toEqual([{ kind: "expires", days: 7 }])
    expect(rowTags(claude(29 * DAY + 5), NOW)).toEqual([{ kind: "expires", days: 1 }])
    // Past the period: it may go at Claude Code's next start.
    expect(expiry(claude(45 * DAY), NOW)).toEqual({ days: 0, tag: true })
    expect(rowTags(claude(10 * DAY), NOW)).toEqual([])
    // Imported ones are kept in own; Codex keeps its rollouts.
    expect(
      expiry(claude(29 * DAY, { imported: [{ sessionID: "ses_a", mode: "full", importedAt: NOW }] }), NOW),
    ).toBeUndefined()
    expect(expiry(summary({ updatedAt: NOW - 29 * DAY }), NOW)).toBeUndefined()
  })

  test("versions read as a range", () => {
    expect(versionRange(["0.150.0", "0.153.2"])).toBe("0.150.0–0.153.2")
    expect(versionRange(["2.1.281"])).toBe("2.1.281")
    expect(versionRange([])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Viewer

function message(type: "user" | "assistant" | "compaction", id: string, fields: Record<string, unknown> = {}) {
  const base = { id, time: { created: 1 }, metadata: {} }
  const value =
    type === "user"
      ? { ...base, type, text: `요청 ${id}` }
      : type === "assistant"
        ? {
            ...base,
            type,
            agent: "build",
            model: { providerID: "openai", id: "gpt" },
            content: [],
            time: { created: 1, completed: 2 },
          }
        : { ...base, type, status: "completed", reason: "auto", summary: "", recent: "" }
  // SAFETY: test fixtures shaped like the JSON view messages `sessions.read` sends.
  return { ...value, ...fields } as unknown as SessionMessageInfo
}

/** The place own.import's view writes on every message (`{turn, step?, kind?, requests?}`). */
const at = (turn: number, extra: Record<string, unknown> = {}) => ({ metadata: { [VIEW_KEY]: { turn, ...extra } } })

describe("viewer pages (09 §3)", () => {
  test("a window grows at either end; the view's place says each message's turn, a turn may lack user text", () => {
    const first = {
      messages: [
        message("user", "u4", at(4)),
        message("assistant", "a4", at(4)),
        message("assistant", "a5", at(5)),
        message("user", "u6", at(6)),
      ],
      next: 7,
    }
    const window = pageWindow(4, first)
    expect(windowEnd(window)).toBe(7)
    expect(previousPage(window, 20)).toEqual({ from: 0, count: 4 })
    expect(previousPage(pageWindow(30, first), 20)).toEqual({ from: 10, count: 20 })
    expect(previousPage(pageWindow(0, first), 20)).toBeUndefined()
    const before = prependPage(window, 3, { messages: [message("user", "u3", at(3))] })
    expect(before.start).toBe(3)
    expect(before.next).toBe(7)
    const after = appendPage(window, { messages: [message("user", "u7", at(7)), message("assistant", "a7", at(7))] })
    expect(after.next).toBeUndefined()
    expect(windowEnd(after)).toBe(8)
    const index = turnIndex(after)
    expect([...index.users]).toEqual([
      [4, "u4"],
      [6, "u6"],
      [7, "u7"],
    ])
    expect(index.turns.get("a5")).toBe(5)
    // Turn 5 has no user text: its rows draw under turn 4, so a jump there scrolls to turn 4's message.
    expect(turnAnchor(after, 5)).toBe("u4")
    expect(turnAnchor(after, 6)).toBe("u6")
    expect(turnAnchor(after, 3)).toBeUndefined()
    // Without places (odd input) each user message opens the next turn.
    const bare = turnIndex(
      pageWindow(2, { messages: [message("user", "x"), message("assistant", "y"), message("user", "z")] }),
    )
    expect([...bare.turns]).toEqual([
      ["x", 2],
      ["y", 2],
      ["z", 3],
    ])
    expect(placeOf(message("user", "w", { metadata: { [VIEW_KEY]: { turn: "1" } } }))).toBeUndefined()
  })

  test("a compaction marker takes its kind and kept requests from its place, else from the outline", () => {
    const placed = pageWindow(0, {
      messages: [
        message("user", "u0", at(0)),
        message("compaction", "c0", at(0, { step: 0, kind: "codex-remote", requests: 3 })),
        message("compaction", "c1", at(0, { step: 2, kind: "foreign", requests: 1 })),
      ],
    })
    expect([...compactionKinds(placed, { checkpoints: [] })]).toEqual([
      ["c0", { kind: "codex-remote", requests: 3 }],
      ["c1", { kind: "foreign", requests: 1 }],
    ])
    const window = pageWindow(0, {
      messages: [
        message("user", "u0"),
        message("compaction", "c0"),
        message("assistant", "a0"),
        message("user", "u1"),
        message("compaction", "c1"),
        message("assistant", "a1"),
        message("compaction", "c2"),
      ],
    })
    const outline = decodeOutline({
      turns: [],
      checkpoints: [
        { turn: 1, step: 3, kind: "foreign" },
        { turn: 0, step: 0, kind: "codex-remote" },
        { turn: 1, step: 1, kind: "codex-remote" },
      ],
      children: [],
      rolledBack: 0,
      branches: 0,
      tokens: 0,
      unknownRecords: 0,
    })
    // Without places: the k-th compaction of a turn is that turn's k-th checkpoint; its own turn's request counts.
    expect([...compactionKinds(window, outline)]).toEqual([
      ["c0", { kind: "codex-remote", requests: 1 }],
      ["c1", { kind: "codex-remote", requests: 2 }],
      ["c2", { kind: "foreign", requests: 2 }],
    ])
    expect(requestsBefore(5)).toBe(6)
  })
})

function outline(turns: number, fields: Record<string, unknown> = {}): Outline {
  return decodeOutline({
    turns: Array.from({ length: turns }, (_, index) => ({ index, firstLine: `줄 ${index}`, time: NOW + index })),
    checkpoints: [],
    children: [],
    rolledBack: 0,
    branches: 0,
    tokens: turns * 1_000,
    unknownRecords: 0,
    ...fields,
  })
}

describe("outline while it streams (09 §2.8)", () => {
  test("re-read with growing waits until outlineComplete, each answer applied", async () => {
    const answers = [
      { outline: outline(2), outlineComplete: false },
      { outline: outline(5), outlineComplete: false },
      { outline: outline(7), outlineComplete: true },
    ]
    const waits: number[] = []
    const applied: number[] = []
    const result = await followOutline({
      read: async () => answers.shift()!,
      apply: (value) => applied.push(value.outline.turns.length),
      wait: async (ms) => void waits.push(ms),
      stopped: () => false,
    })
    expect(result).toBe("complete")
    expect(applied).toEqual([2, 5, 7])
    expect(waits).toEqual([750, 1_500, 3_000])
  })

  test("the waits stop growing at the cap; a closed viewer and a failed read end it", async () => {
    const waits: number[] = []
    let reads = 0
    const capped = await followOutline({
      read: async () => ({ outline: outline(1), outlineComplete: ++reads === 6 }),
      apply: () => {},
      wait: async (ms) => void waits.push(ms),
      stopped: () => false,
      first: 1_000,
      max: 4_000,
    })
    expect(capped).toBe("complete")
    expect(waits).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000])
    let open = true
    const stopped = await followOutline({
      read: async () => {
        open = false
        return { outline: outline(1), outlineComplete: false }
      },
      apply: () => {
        throw new Error("applied after the viewer closed")
      },
      wait: async () => {},
      stopped: () => !open,
    })
    expect(stopped).toBe("stopped")
    const failed = await followOutline({
      read: async () => Promise.reject(new Error("gone")),
      apply: () => {},
      wait: async () => {},
      stopped: () => false,
    })
    expect(failed).toBe("failed")
  })

  test("the panel shows 읽는 중 until complete, sub-agents after the turn that started them, compactions per turn", () => {
    const value = outline(3, {
      checkpoints: [
        { turn: 1, step: 2, kind: "foreign" },
        { turn: 1, step: 5, kind: "foreign" },
      ],
      children: [
        { ref: { kind: "claude-code", rootID: "claude-1", id: "s1:agent-a" }, title: "탐색", turn: 0 },
        { ref: { kind: "claude-code", rootID: "claude-1", id: "s1:agent-b" } },
      ],
    })
    const rows = (complete: boolean, failed = false) =>
      outlineEntries(value, complete, failed).map((entry) =>
        entry.type === "turn"
          ? `${entry.index}:${entry.compactions}`
          : entry.type === "child"
            ? `child ${entry.ref.id}`
            : entry.type,
      )
    expect(rows(false)).toEqual(["0:0", "child s1:agent-a", "1:2", "2:0", "child s1:agent-b", "reading"])
    expect(rows(true)).toEqual(["0:0", "child s1:agent-a", "1:2", "2:0", "child s1:agent-b"])
    expect(rows(false, true).at(-1)).toBe("failed")
  })
})

describe("search and copy (09 §3)", () => {
  const hit = (id: string, turn: number): Hit =>
    decodeHit({ ref: { kind: "codex", rootID: "codex-1", id }, turn, snippet: `… ${id} ${turn} …` })

  test("계속 찾기 adds new hits only; hits group by conversation in the order found", () => {
    const merged = mergeHits([hit("t1", 0), hit("t2", 4)], [hit("t2", 4), hit("t1", 7), hit("t3", 1)])
    expect(merged.map((item) => `${item.ref.id}#${item.turn}`)).toEqual(["t1#0", "t2#4", "t1#7", "t3#1"])
    expect(
      hitGroups(merged).map((group) => `${group.ref.id}:${group.hits.map((item) => item.turn).join(",")}`),
    ).toEqual(["t1:0,7", "t2:4", "t3:1"])
  })

  test("텍스트로 복사: user and model text, tool calls on one line with a short result, compactions, resets", () => {
    const tool = {
      type: "tool",
      id: "call_1",
      name: "shell",
      state: { status: "completed", input: { command: "bun test" }, content: [{ type: "text", text: "12 pass" }] },
      time: { created: 1 },
    }
    const copied = transcriptText({
      title: "설치기 정리",
      header: "Codex 대화의 읽기 전용 사본",
      messages: [
        message("user", "u0", { text: "테스트 돌려 줘" }),
        message("assistant", "a0", { content: [{ type: "text", text: "돌립니다" }, tool] }),
        message("compaction", "c0", { summary: "앞부분 요약" }),
        message("compaction", "r0", { reason: "reset" }),
        message("compaction", "r1", { reason: "reset", undone: 5 }),
      ],
      labels: {
        user: "사용자",
        assistant: "모델",
        tool: "도구",
        compaction: "압축",
        reset: "문맥 비우기",
        resetUndone: "문맥 비우기 · 되돌림",
      },
    })
    expect(copied).toBe(
      [
        "# 설치기 정리",
        "Codex 대화의 읽기 전용 사본",
        "## 사용자\n\n테스트 돌려 줘",
        '## 모델\n\n돌립니다\n\n[도구: shell] {"command":"bun test"}\n12 pass',
        "--- 압축 ---\n\n앞부분 요약",
        "--- 문맥 비우기 ---",
        "--- 문맥 비우기 · 되돌림 ---",
      ].join("\n\n") + "\n",
    )
  })
})

describe("strings (03 §14, 03 §20.2 R5)", () => {
  test("English only has Korean keys; the lazy catalog does not repeat first-chunk keys", () => {
    for (const key of Object.keys(importEn)) expect(Object.hasOwn(importKo, key)).toBe(true)
    for (const key of Object.keys(importKo)) expect(Object.hasOwn(ko, key)).toBe(false)
    // The first-chunk labels: sidebar row, project menu item, palette command, settings section, page title.
    for (const key of [
      "own.otherTools.entry",
      "own.otherTools.menu",
      "own.otherTools.palette",
      "own.settings.import",
      "own.otherTools.title",
    ])
      expect(Object.hasOwn(ko, key)).toBe(true)
  })
})
