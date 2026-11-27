import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { ClaudeSource } from "../../src/sources/claude.js"
import { Paths } from "../../src/sources/paths.js"
import {
  afterTool,
  agents,
  basic,
  CWD,
  IDS,
  MODEL,
  relocated,
  session,
  sessionFolder,
  START,
  text,
  toolUse,
  write,
} from "../fixtures/claude.js"
import { claudeFolder, fixture, sentinels, writeJsonl, writeText, type Fixture } from "../fixtures/make.js"
import { isNeverOpen, start } from "../support/guard.js"

const MTIME = new Date(START + 3_600_000)
const NOW = MTIME.getTime() + 600_000
const WORKTREE = "C:\\work\\proj\\.worktrees\\feature"
const SIDE = "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4e01"
const EMPTY = "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4e02"
const REMOTE = "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4e03"
const TITLED = ["0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4e11", "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4e12"] as const
const MORE = ["0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4e13", "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4e14"] as const

const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function make(under?: string) {
  const item = await fixture({ under })
  fixtures.push(item)
  return { item, root: Paths.defaults({ options: { roots: { codex: [], claude: [item.claude] } } })[0] }
}

async function only<T>(
  result: Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }>,
) {
  const value = await result
  if (!value.ok) throw new Error(value.reason)
  return value.value
}

async function conversation(root: Paths.Root, cwd: string, id: string) {
  const found = (await only(ClaudeSource.conversations(root, claudeFolder(cwd)))).find((item) => item.id === id)
  if (found === undefined) throw new Error(`no conversation ${id}`)
  return found
}

describe("the scan (09 §2.3 Claude 스캔)", () => {
  test("only top-level <uuid>.jsonl files; sidechain-only and metadata-only files are skipped; SSH folders are another computer", async () => {
    const { item, root } = await make()
    const folder = path.join(item.claude, "projects", claudeFolder(CWD))
    await sentinels(item.claude, "claude-code", claudeFolder(CWD))
    const main = basic("2.1.288")
    // No old mtime here: make.ts sets atime with it, and NTFS then updates the last-access time on the first read,
    // which the guard's watcher reports as a change.
    await write(item.claude, main.input, main.session)
    const copy = main.session.records()
    await writeJsonl(path.join(folder, "agent-a9f0.jsonl"), copy)
    await writeJsonl(path.join(folder, `${IDS.basic}.jsonl.superseded-1790000000`), copy)
    await writeJsonl(path.join(folder, `${IDS.parallel}.orphaned-1790000000-ab12.jsonl`), copy)
    await writeJsonl(path.join(folder, `${IDS.basic}`, "subagents", "agent-a1.jsonl"), copy)
    const side = session({ cwd: CWD, id: SIDE, version: "2.1.288" })
    side.user("sub-agent prompt", { extra: { isSidechain: true } })
    side.assistant([text("sub-agent answer")], { id: "msg_FAKED1", extra: { isSidechain: true } })
    await write(item.claude, { cwd: CWD, id: SIDE, version: "2.1.288" }, side)
    await writeJsonl(path.join(folder, `${EMPTY}.jsonl`), [
      { type: "permission-mode", permissionMode: "default" },
      { type: "file-history-snapshot", messageId: "m", snapshot: { trackedFileBackups: {} } },
    ])
    const remote = session({ cwd: "/home/remote/proj", id: REMOTE, version: "2.1.288" })
    remote.user("on the remote host")
    remote.assistant([text("remote answer")], { id: "msg_FAKED2" })
    await writeJsonl(path.join(item.claude, "projects", "ssh-1f2e3d4c", `${REMOTE}.jsonl`), remote.records())
    await writeText(path.join(item.claude, "projects", "stray.jsonl"), "{}\n")

    const guard = await start([item.claude])
    const listed = await only(ClaudeSource.scan(root, NOW))
    expect(await guard.stop()).toEqual([])
    expect(guard.reports.filter((report) => report.real !== undefined && isNeverOpen(report.real))).toEqual([])

    expect(listed.map((entry) => [entry.id, entry.folder, entry.otherComputer]).sort()).toEqual(
      [
        [IDS.basic, claudeFolder(CWD), false],
        [REMOTE, "ssh-1f2e3d4c", true],
      ].sort(),
    )
    const opened = guard.reports.filter((report) => report.op === "open").map((report) => path.basename(report.path))
    expect(opened).not.toContain("agent-a9f0.jsonl")
    expect(opened.filter((name) => name.includes("superseded") || name.includes("orphaned"))).toEqual([])
  })

  test("the lite fields of a small file", async () => {
    const { item, root } = await make()
    const main = basic("2.1.288")
    await write(item.claude, main.input, main.session, { mtime: MTIME })
    const found = await conversation(root, CWD, IDS.basic)
    const listed = await only(ClaudeSource.lite(root, found, NOW))
    expect(listed).toEqual({
      ...found,
      cwds: [CWD],
      title: "설치기 정리",
      firstPrompt: "설치기를 고쳐 줘",
      branch: "fix-installer",
      createdAt: START + 1000,
      updatedAt: START + 11_000,
      versions: ["2.1.288"],
      model: MODEL,
      compactions: 0,
      otherComputer: false,
      live: false,
    })
    expect((await only(ClaudeSource.lite(root, found, MTIME.getTime() + 60_000)))?.live).toBe(true)
  })

  test("a file over 128 KiB: head and tail windows only; the confirm pass finds the folder in between", async () => {
    const { item, root } = await make()
    const scenario = relocated("2.1.281", WORKTREE)
    await write(item.claude, scenario.input, scenario.session, { mtime: MTIME })
    const found = await conversation(root, CWD, IDS.relocated)
    expect(found.size).toBeGreaterThan(2 * ClaudeSource.LITE_BYTES)
    const listed = await only(ClaudeSource.lite(root, found, NOW))
    expect(listed?.cwds).toEqual([CWD])
    expect([listed?.createdAt, listed?.updatedAt, listed?.model, listed?.firstPrompt]).toEqual([
      START + 1000,
      START + 7000,
      MODEL,
      "start in the main checkout",
    ])
    expect(await only(ClaudeSource.confirm(root, found))).toEqual({ cwds: [CWD, WORKTREE], compactions: 0 })
  })

  test("the confirm pass counts every compaction", async () => {
    const { item, root } = await make()
    const scenario = afterTool("2.1.288")
    await write(item.claude, scenario.input, scenario.session)
    const found = await conversation(root, CWD, IDS.afterTool)
    expect(await only(ClaudeSource.confirm(root, found))).toEqual({ cwds: [CWD], compactions: 1 })
    expect((await only(ClaudeSource.lite(root, found)))?.compactions).toBe(1)
  })

  test("the last model in the tail that is not a synthetic notice", async () => {
    const { item, root } = await make()
    const id = MORE[0]
    const s = session({ cwd: CWD, id, version: "2.1.288" })
    s.user("first")
    s.assistant([toolUse("toolu_FAKEE1", "Read", { file_path: "a" })], { id: "msg_FAKEE1", model: "claude-early" })
    s.result("toolu_FAKEE1", "y".repeat(140 * 1024))
    s.assistant([text("late")], { id: "msg_FAKEE2", model: "claude-late" })
    s.assistant([text("API Error")], { id: "msg_FAKEE3", model: "<synthetic>", extra: { isApiErrorMessage: true } })
    await write(item.claude, { cwd: CWD, id, version: "2.1.288" }, s)
    expect((await only(ClaudeSource.lite(root, await conversation(root, CWD, id))))?.model).toBe("claude-late")
  })
})

describe("titles and the first request (09 §2.3 제목 순서, SDK skip rules)", () => {
  test("the first meaningful human line skips harness, meta, tool results and notifications and is cut to 120", async () => {
    const { item, root } = await make()
    const id = MORE[1]
    const s = session({ cwd: CWD, id, version: "2.1.281" })
    s.user("meta prompt", { extra: { isMeta: true } })
    s.user("<command-name>/init</command-name>\n<command-args>repo</command-args>")
    s.user("<local-command-stdout>initialized</local-command-stdout>")
    s.user("<ide_opened_file>a.ts</ide_opened_file>")
    s.user("<tick>12:00</tick>")
    s.user("<task-notification><summary>done</summary></task-notification>", {
      extra: { origin: { kind: "task_notification" } },
    })
    s.user("a peer said hi", { extra: { origin: { kind: "peer" } } })
    s.user("[Request interrupted by user]")
    s.assistant([toolUse("toolu_FAKEF1", "Bash", { command: "ls" })], { id: "msg_FAKEF1" })
    s.result("toolu_FAKEF1", "a.ts")
    s.user(`the real request ${"z".repeat(200)}`)
    await write(item.claude, { cwd: CWD, id, version: "2.1.281" }, s)
    const listed = await only(ClaudeSource.lite(root, await conversation(root, CWD, id)))
    expect(listed?.firstPrompt).toBe(`the real request ${"z".repeat(120 - "the real request ".length)}…`)
    expect(listed?.title).toBe(listed?.firstPrompt)
  })

  test("a slash command is the first request only when nothing else is", async () => {
    const { item, root } = await make()
    const id = MORE[1]
    const s = session({ cwd: CWD, id, version: "2.1.281" })
    s.user("<command-name>/init</command-name>\n<command-args>repo</command-args>")
    s.assistant([text("Initialized.")], { id: "msg_FAKEF2" })
    await write(item.claude, { cwd: CWD, id, version: "2.1.281" }, s)
    expect((await only(ClaudeSource.lite(root, await conversation(root, CWD, id))))?.firstPrompt).toBe("/init repo")
  })

  test.each([
    [
      "ai-title before last-prompt",
      [
        { type: "ai-title", aiTitle: "AI title" },
        { type: "last-prompt", lastPrompt: "last" },
      ],
      "AI title",
    ],
    [
      "last-prompt, wrappers removed",
      [{ type: "last-prompt", lastPrompt: "<system-reminder>x</system-reminder>last one" }],
      "last one",
    ],
    ["the legacy summary", [{ type: "summary", summary: "Legacy summary", leafUuid: "x" }], "Legacy summary"],
    ["the first line", [], "hello there"],
  ])("%s", async (_name, records, expected) => {
    const { item, root } = await make()
    const id = TITLED[0]
    const s = session({ cwd: CWD, id, version: "2.1.288" })
    s.user("hello there")
    s.assistant([text("hi")], { id: "msg_FAKEF3" })
    records.forEach((record) => s.meta(record))
    await write(item.claude, { cwd: CWD, id, version: "2.1.288" }, s)
    const found = await conversation(root, CWD, id)
    expect((await only(ClaudeSource.lite(root, found)))?.title).toBe(expected)
    expect((await only(ClaudeSource.transcript(root, found)))?.source.title).toBe(expected)
  })

  test("custom-title.json names a conversation without a custom-title record; the record wins over it", async () => {
    const { item, root } = await make()
    const [plain, named] = TITLED
    for (const id of TITLED) {
      const s = session({ cwd: CWD, id, version: "2.1.288" })
      s.user("hello")
      s.meta({ type: "ai-title", aiTitle: "AI title" })
      if (id === named) s.meta({ type: "custom-title", customTitle: "Record title" })
      await write(item.claude, { cwd: CWD, id, version: "2.1.288" }, s)
      await writeText(
        path.join(sessionFolder(item.claude, CWD, id), "custom-title.json"),
        '{"customTitle":"File title"}',
      )
    }
    expect((await only(ClaudeSource.lite(root, await conversation(root, CWD, plain))))?.title).toBe("File title")
    expect((await only(ClaudeSource.lite(root, await conversation(root, CWD, named))))?.title).toBe("Record title")
    expect(await ClaudeSource.customTitle(root, await conversation(root, CWD, plain))).toBe("File title")
  })
})

describe("folders (09 §2.2)", () => {
  test("a cwd whose folder name is over 200 characters, Hangul and '#' paths below a Hangul '#' root", async () => {
    const { item, root } = await make("한글 #폴더")
    const long = `C:\\${"아주 긴 폴더 이름 #".repeat(25)}\\proj`
    const hash = "D:\\#Projects\\한글 프로젝트"
    for (const [cwd, id] of [
      [long, MORE[0]],
      [hash, MORE[1]],
    ] as const) {
      const s = session({ cwd, id, version: "2.1.288" })
      s.user(`work in ${cwd}`)
      s.assistant([text("ok")], { id: "msg_FAKEG1" })
      await write(item.claude, { cwd, id, version: "2.1.288" }, s)
    }
    expect(claudeFolder(long).length).toBeGreaterThan(200)
    expect(claudeFolder(hash)).toBe("D---Projects--------")
    const listed = await only(ClaudeSource.scan(root, NOW))
    expect(listed.map((entry) => [entry.id, entry.cwds]).sort()).toEqual(
      [
        [MORE[0], [long]],
        [MORE[1], [hash]],
      ].sort(),
    )
    listed.forEach((entry) => expect(Paths.claudeCandidate(entry.folder, entry.cwds[0])).toBe(true))
    const confirmed = await only(ClaudeSource.confirm(root, await conversation(root, hash, MORE[1])))
    expect(confirmed.cwds).toEqual([hash])
  })
})

describe("files beside a conversation (09 §2.1)", () => {
  test("sub-agent files with their meta; an id that is not a SourceID is left out", async () => {
    const { item, root } = await make()
    await agents(item.claude, "2.1.288")
    const found = await conversation(root, CWD, IDS.agents)
    const children = await ClaudeSource.children(root, found)
    expect(
      children.map((child) => ({
        ...child,
        path: path.relative(sessionFolder(item.claude, CWD, IDS.agents), child.path),
      })),
    ).toEqual([
      {
        id: `${IDS.agents}:a1b2`,
        agentId: "a1b2",
        path: path.join("subagents", "agent-a1b2.jsonl"),
        folder: claudeFolder(CWD),
        size: children[0].size,
        mtimeMs: children[0].mtimeMs,
        parentID: IDS.agents,
        title: "explore",
        agent: "Explore",
        toolUseId: "toolu_FAKEB1",
      },
      {
        id: `${IDS.agents}:c3d4`,
        agentId: "c3d4",
        path: path.join("subagents", "workflows", "wf_fixture", "agent-c3d4.jsonl"),
        folder: claudeFolder(CWD),
        size: children[1].size,
        mtimeMs: children[1].mtimeMs,
        parentID: IDS.agents,
        title: "plan",
        agent: "Plan",
        toolUseId: "toolu_FAKEB2",
      },
    ])
    expect(
      await ClaudeSource.children(
        root,
        await conversation(root, CWD, IDS.agents).then((value) => ({ ...value, id: IDS.basic })),
      ),
    ).toEqual([])
  })

  test("a file over the parse limit is too_large, not parsed (09 §2.8, IG4)", async () => {
    const { item, root } = await make()
    const main = basic("2.1.288")
    await write(item.claude, main.input, main.session)
    const found = await conversation(root, CWD, IDS.basic)
    expect(Paths.PARSE_BYTES).toBe(512 * 1024 * 1024)
    expect(await ClaudeSource.transcript(root, found, Date.now(), found.size - 1)).toEqual({
      ok: false,
      reason: "too_large",
    })
    expect((await ClaudeSource.transcript(root, found, Date.now(), found.size)).ok).toBe(true)
  })

  test("a tool-results file is opened only on demand, by name, up to a limit", async () => {
    const { item, root } = await make()
    const main = basic("2.1.288")
    await write(item.claude, main.input, main.session)
    const results = path.join(sessionFolder(item.claude, CWD, IDS.basic), "tool-results")
    await writeText(path.join(results, "br7fixture.txt"), "0123456789".repeat(100))
    const found = await conversation(root, CWD, IDS.basic)

    const guard = await start([item.claude])
    await only(ClaudeSource.transcript(root, found))
    const parsing = guard.reports.filter((report) => report.path.includes("tool-results"))
    expect(await ClaudeSource.toolResult(root, found, "br7fixture.txt")).toEqual({
      ok: true,
      value: { text: "0123456789".repeat(100), bytes: 1000 },
    })
    expect(await ClaudeSource.toolResult(root, found, "br7fixture.txt", 12)).toEqual({
      ok: true,
      value: { text: "012345678901", bytes: 1000 },
    })
    const refused = guard.reports.length
    for (const name of ["..\\x.txt", "a/b.txt", ".hidden", ""])
      expect(await ClaudeSource.toolResult(root, found, name)).toEqual({ ok: false, reason: "path_denied" })
    expect(guard.reports.length).toBe(refused)
    expect(await ClaudeSource.toolResult(root, found, "gone.txt")).toEqual({ ok: false, reason: "missing" })
    expect(await guard.stop()).toEqual([])
    expect(parsing).toEqual([])
  })
})

describe("the read-only guard over every Claude read (IG1)", () => {
  test("scan, lite, confirm, full parse, children and titles write nothing and open only allowlisted files", async () => {
    const { item, root } = await make()
    await sentinels(item.claude, "claude-code", claudeFolder(CWD))
    await agents(item.claude, "2.1.281")
    const scenario = relocated("2.1.281", WORKTREE)
    await write(item.claude, scenario.input, scenario.session)
    const guard = await start([item.claude])
    const listed = await only(ClaudeSource.scan(root))
    for (const entry of listed) {
      await only(ClaudeSource.confirm(root, entry))
      await only(ClaudeSource.transcript(root, entry))
      for (const child of await ClaudeSource.children(root, entry)) await only(ClaudeSource.transcript(root, child))
    }
    expect(await guard.stop()).toEqual([])
    const opened = guard.reports.filter((report) => report.op === "open")
    expect(opened.length).toBeGreaterThan(0)
    expect(
      opened.filter((report) => !/(\.jsonl|custom-title\.json|\.meta\.json)$/.test(report.real ?? report.path)),
    ).toEqual([])
    expect(guard.reports.filter((report) => report.reason === "path_denied")).toEqual([])
  })
})

describe("lines (09 §2.8)", () => {
  async function* chunks(...parts: ReadonlyArray<string | Uint8Array>) {
    for (const part of parts) yield typeof part === "string" ? new TextEncoder().encode(part) : part
  }
  const read = (...parts: ReadonlyArray<string | Uint8Array>) => Array.fromAsync(ClaudeSource.lines(chunks(...parts)))

  test("lines across chunk boundaries, a character split between chunks", async () => {
    const bytes = new TextEncoder().encode('{"a":"가"}\n')
    expect(await read(bytes.subarray(0, 7), bytes.subarray(7), '{"b":1}\n')).toEqual([
      { type: "line", text: '{"a":"가"}' },
      { type: "line", text: '{"b":1}' },
    ])
  })

  test("CRLF is left for the reader's trim; an empty input has no lines", async () => {
    expect(await read("a\r\nb\n")).toEqual([
      { type: "line", text: "a\r" },
      { type: "line", text: "b" },
    ])
    expect(await read()).toEqual([])
  })

  test("a torn last line is reported, not read", async () => {
    expect(await read('{"a":1}\n{"b":')).toEqual([{ type: "line", text: '{"a":1}' }, { type: "torn" }])
  })

  test("a line over the cap is skipped whole, and a character it cut never reaches the next line", async () => {
    const lines = await Array.fromAsync(ClaudeSource.lines(chunks("short\n", "xxxxxxxxxx가", "가\nok\n"), 10))
    expect(lines).toEqual([{ type: "line", text: "short" }, { type: "oversized" }, { type: "line", text: "ok" }])
  })
})
