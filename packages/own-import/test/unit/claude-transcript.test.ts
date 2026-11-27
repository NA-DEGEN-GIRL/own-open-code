import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Result } from "effect"
import { ClaudeSource } from "../../src/sources/claude.js"
import { Paths } from "../../src/sources/paths.js"
import { ClaudeTranscript } from "../../src/transcript/claude.js"
import { Transcript } from "../../src/transcript/ir.js"
import {
  abandoned,
  afterTool,
  afterUser,
  agents,
  basic,
  CWD,
  harness,
  IDS,
  MODEL,
  notices,
  oldBoundary,
  parallel,
  queued,
  relocated,
  session,
  sidechain,
  START,
  text,
  toolUse,
  VERSIONS,
  write,
  type Version,
} from "../fixtures/claude.js"
import { fixture, type Fixture } from "../fixtures/make.js"

/** The files' mtime and "now": an hour after the conversations, so none of them is live. */
const MTIME = START + 3_600_000
const NOW = MTIME + 600_000
const WORKTREE = "C:\\work\\proj\\.worktrees\\feature"
/** Where Claude Code says it saved a large output: text to own, which only ever takes the file name from it. */
const SAVED = `C:\\Users\\fixture\\.claude\\projects\\C--work-proj\\${IDS.notices}\\tool-results\\br7fixture.txt`

/**
 * The IR snapshot of a transcript (IG2): one line per turn (index, end, queued, the human's words, images), one per
 * step, and each checkpoint at its place between the steps. Times are checked separately.
 */
function render(info: Transcript.Info) {
  const at = (turn: number, step: number) =>
    info.checkpoints.filter((item) => item.at.turn === turn && item.at.step === step).map(checkpoint)
  return info.turns.flatMap((turn) => [
    `${turn.index} ${turn.end}${turn.user.queued ? " queued" : ""} ${JSON.stringify(turn.user.text)}${turn.user.images
      .map((item) => ` [${item.mime} ${item.bytes}]`)
      .join("")}`,
    ...turn.steps.flatMap((item, index) => [...at(turn.index, index), `  ${step(item)}`]),
    ...at(turn.index, turn.steps.length),
  ])
}

function step(item: Transcript.Step) {
  if (item.type === "text")
    return `text ${JSON.stringify(item.text)}${item.model === MODEL ? "" : ` model=${item.model}`}`
  if (item.type === "reasoning-summary") return `reasoning ${JSON.stringify(item.text)}`
  if (item.type === "note") return `note ${JSON.stringify(item.text)}`
  const output = item.output?.text ?? ""
  return [
    `tool ${item.name} ${JSON.stringify(item.input)} ->`,
    item.output?.error ? "error" : "ok",
    JSON.stringify(output.length > 100 ? `${output.slice(0, 20)}…(${output.length})` : output),
    ...(item.exit === undefined ? [] : [`exit=${item.exit}`]),
    ...(item.diff ?? []).map((diff) => `diff=${diff.status}:${diff.file}:+${diff.additions}-${diff.deletions}`),
    ...(item.child === undefined ? [] : [`child=${item.child.split(":")[1]}`]),
  ].join(" ")
}

function checkpoint(item: Transcript.Checkpoint) {
  const source = "uuid" in item.at.source ? Number(item.at.source.uuid.slice(-12)) : -1
  return [
    `  ## ${item.kind} #${source}`,
    item.trigger ?? "-",
    `${item.preTokens ?? "-"}/${item.postTokens ?? "-"}`,
    `summary=${item.summary === undefined ? "-" : item.summary === SUMMARY ? "SUMMARY" : JSON.stringify(item.summary)}`,
    `recent=${JSON.stringify(item.recent.map((line) => `${line.role}:${line.text}`))}`,
  ].join(" ")
}

const SUMMARY =
  "Summary:\n1. Primary Request and Intent:\n   Fix the installer.\n2. Current Work:\n   Running the tests."

/** Per fixture: its IR snapshot and the drop counts (the same for both versions). */
const EXPECTED: Record<
  keyof typeof IDS | "reworded",
  { readonly turns: ReadonlyArray<string>; readonly dropped: Transcript.Dropped }
> = {
  basic: {
    turns: [
      '0 completed "설치기를 고쳐 줘" [image/png 6]',
      '  reasoning "Look at the installer first."',
      '  text "Let me look."',
      '  tool Bash {"command":"bun test"} -> ok "3 pass" exit=0',
      '  tool Edit {"file_path":"C:\\\\work\\\\proj\\\\a.ts","old_string":"a","new_string":"b"} -> ok "The file C:\\\\work\\\\proj\\\\a.ts has been updated." diff=modified:C:\\work\\proj\\a.ts:+1-1',
      '  text "Fixed.\\n\\nThe tests pass."',
    ],
    dropped: { thinking: 3 },
  },
  parallel: {
    turns: [
      '0 interrupted "Read both files"',
      '  tool Read {"file_path":"a.ts"} -> ok "content of a"',
      '  tool Read {"file_path":"b.ts"} -> ok "content of b"',
      '  text "Both read."',
      '  tool Bash {"command":"ls"} -> error "interrupted before result was recorded"',
    ],
    dropped: {},
  },
  abandoned: {
    turns: [
      '0 completed "first request"',
      '  text "first answer"',
      '1 completed "second request, new wording"',
      '  text "answer to the new wording"',
    ],
    dropped: { abandonedBranch: 1 },
  },
  afterTool: {
    turns: [
      '0 completed "refactor the installer"',
      '  text "Starting."',
      '1 completed "also update the docs"',
      '  tool Bash {"command":"bun test"} -> ok "2 pass" exit=0',
      '  ## foreign #6 auto 180000/12000 summary=SUMMARY recent=["tool-call:Bash({\\"command\\":\\"bun test\\"})","tool-result:2 pass"]',
      '  text "Continuing after the compaction."',
      '2 completed "thanks"',
      '  text "You are welcome."',
    ],
    dropped: { attachment: 1 },
  },
  reworded: {
    turns: [
      '0 completed "refactor the installer"',
      '  text "Starting."',
      '1 completed "also update the docs"',
      '  tool Bash {"command":"bun test"} -> ok "2 pass" exit=0',
      '  ## foreign #6 auto 180000/12000 summary=SUMMARY recent=["tool-call:Bash({\\"command\\":\\"bun test\\"})","tool-result:2 pass"]',
      '  text "Continuing after the compaction."',
      '2 completed "thanks"',
      '  text "You are welcome."',
    ],
    dropped: { attachment: 1 },
  },
  afterUser: {
    turns: [
      '0 completed "first"',
      '  text "one"',
      '1 completed "second, a long one"',
      '  ## foreign #4 auto 150000/9000 summary=SUMMARY recent=["user:second, a long one"]',
      '  text "two"',
    ],
    dropped: {},
  },
  oldBoundary: {
    turns: [
      '0 completed "first"',
      '  text "one"',
      "  ## foreign #3 manual 180000/12000 summary=SUMMARY recent=[]",
      '1 completed "next"',
      '  text "two"',
    ],
    // The summary lacks the transcript line; `/compact` and its output are harness.
    dropped: { boilerplateUnmatched: 1, harnessWrapper: 2 },
  },
  queued: {
    turns: [
      '0 completed "run the suite"',
      '  tool Bash {"command":"bun test"} -> ok "ok"',
      '1 completed queued "also check the lint"',
      '  text "Checking the lint too."',
      '  note "Queued message (peer): handoff from the reviewer agent"',
      '  note "Background command \\"bun build\\" completed"',
      '  text "Lint is clean."',
      '2 completed "same prompt twice, as sent"',
      '  text "Sent."',
      '3 completed "same text twice"',
      '  text "Done."',
    ],
    dropped: { queuedDuplicate: 2 },
  },
  notices: {
    turns: [
      '0 completed "search the logs"',
      '  tool Grep {"pattern":"error"} -> ok "<persisted-output>\\nO…(236)"',
      '  tool Bash {"command":"rm -rf build"} -> error "The user doesn\'t want to proceed with this tool use. The tool use was rejected."',
      '  tool ToolSearch {"query":"web"} -> ok "[tool reference: WebFetch]"',
      '1 error "try again"',
    ],
    dropped: { apiError: 2, syntheticRecord: 1, usageLimit: 1 },
  },
  harness: {
    turns: [
      '0 completed "fix this function"',
      '  text "On it."',
      '1 interrupted "/review the parser"',
      '  text "Reviewing the parser."',
      '  note "Background command \\"bun test\\" completed (exit code 0)"',
      '  tool Bash {"command":"sleep 100"} -> error "[Request interrupted by user for tool use]"',
      '2 completed "never mind"',
      '  text "Stopped."',
    ],
    // `prompt_snapshot`; the IDE-only message, `/model` nobody answered and its output; two meta records; a server
    // tool block; an unknown record type; the torn last line.
    dropped: { attachment: 1, harnessWrapper: 3, metaRecord: 2, unknownField: 1, unknownRecord: 1, tornLine: 1 },
  },
  sidechain: {
    turns: [
      '0 completed "explore the repo"',
      '  tool Task {"description":"explore","prompt":"map the repo"} -> ok "The repo has two packages."',
      '  text "Two packages."',
    ],
    // Two sub-agent records in the main file and one team message.
    dropped: { sidechain: 3 },
  },
  relocated: {
    turns: [
      '0 completed "start in the main checkout"',
      '  tool Read {"file_path":"big.txt"} -> ok "xxxxxxxxxxxxxxxxxxxx…(81920)"',
      '1 completed "continue in the worktree"',
      '  tool Read {"file_path":"big.txt"} -> ok "xxxxxxxxxxxxxxxxxxxx…(81920)"',
      '  text "Back in the main checkout."',
    ],
    dropped: {},
  },
  agents: {
    turns: [
      '0 completed "explore and plan"',
      '  tool Agent {"description":"explore","subagent_type":"Explore","prompt":"map it"} -> ok "Mapped: two packages." child=a1b2',
      '  tool Agent {"description":"plan","subagent_type":"Plan","prompt":"plan it"} -> ok "Plan: three steps." child=c3d4',
      '  text "Explored and planned."',
    ],
    dropped: {},
  },
}

interface Parsed {
  readonly root: Paths.Root
  readonly item: Fixture
  readonly infos: Map<keyof typeof EXPECTED, Transcript.Info>
}

/** Writes every scenario of `version` into a fresh root and parses each through the source (the real reading path). */
async function parseAll(version: Version): Promise<Parsed> {
  const item = await fixture()
  const root = Paths.defaults({ options: { roots: { codex: [], claude: [item.claude] } } })[0]
  const options = { mtime: new Date(MTIME) }
  const scenarios = {
    basic: basic(version),
    parallel: parallel(version),
    abandoned: abandoned(version),
    afterTool: afterTool(version),
    afterUser: afterUser(version),
    oldBoundary: oldBoundary(version),
    queued: queued(version),
    notices: notices(version, SAVED),
    harness: harness(version),
    sidechain: sidechain(version),
    relocated: relocated(version, WORKTREE),
  }
  await Promise.all(
    Object.entries(scenarios).map((entry) =>
      write(item.claude, entry[1].input, entry[1].session, { ...options, torn: entry[0] === "harness" }),
    ),
  )
  await agents(item.claude, version)
  const folders = await ClaudeSource.folders(root)
  if (!folders.ok) throw new Error(folders.reason)
  const files = await ClaudeSource.conversations(root, folders.value[0].name)
  if (!files.ok) throw new Error(files.reason)
  const byId = new Map(files.value.map((conversation) => [conversation.id, conversation]))
  const infos = new Map<keyof typeof EXPECTED, Transcript.Info>()
  for (const name of Object.keys(IDS) as Array<keyof typeof IDS>) {
    const conversation = byId.get(IDS[name])
    if (conversation === undefined) throw new Error(`missing ${name}`)
    const parsed = await ClaudeSource.transcript(root, conversation, NOW)
    if (!parsed.ok) throw new Error(parsed.reason)
    infos.set(name, parsed.value)
  }
  // The reworded summary replaces the same session's file.
  const reworded = afterTool(version, true)
  await write(item.claude, reworded.input, reworded.session, options)
  const parsed = await ClaudeSource.transcript(root, byId.get(IDS.afterTool) as ClaudeSource.Conversation, NOW)
  if (!parsed.ok) throw new Error(parsed.reason)
  infos.set("reworded", parsed.value)
  return { root, item, infos }
}

const runs = new Map<Version, Parsed>()

beforeAll(async () => {
  for (const version of VERSIONS) runs.set(version, await parseAll(version))
})

afterAll(async () => {
  await Promise.all([...runs.values()].map((run) => run.item.cleanup()))
})

function info(version: Version, name: keyof typeof EXPECTED) {
  const found = runs.get(version)?.infos.get(name)
  if (found === undefined) throw new Error(`not parsed: ${version} ${name}`)
  return found
}

describe.each([...VERSIONS])("Claude Code %s fixtures (IG2)", (version) => {
  test.each(Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>)("%s: IR snapshot and drops", (name) => {
    const parsed = info(version, name)
    expect(render(parsed)).toEqual([...EXPECTED[name].turns])
    expect(parsed.dropped).toEqual(EXPECTED[name].dropped)
  })

  test.each(Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>)("%s: decodes as Transcript.Info", (name) => {
    const parsed = info(version, name)
    expect(Result.isSuccess(Transcript.decode(parsed))).toBe(true)
    expect(JSON.stringify(parsed)).not.toMatch(/toolu_FAKE|msg_FAKE|req_FAKE|RkFLRS1zaWduYXR1cmU|FIXTURE SYSTEM PROMPT/)
  })

  test("source fields of the basic conversation", () => {
    const parsed = info(version, "basic")
    const run = runs.get(version)
    expect({ ...parsed.source, path: path.basename(parsed.source.path) }).toEqual({
      kind: "claude-code",
      id: IDS.basic,
      rootID: run?.root.rootID ?? "",
      path: `${IDS.basic}.jsonl`,
      versions: [version],
      app: version === "2.1.288" ? "claude-desktop" : "cli",
      cwds: [CWD],
      branch: "fix-installer",
      title: "설치기 정리",
      firstPrompt: "설치기를 고쳐 줘",
      models: [{ id: MODEL }],
      createdAt: START + 1000,
      updatedAt: START + 11_000,
      bytes: parsed.source.bytes,
      subagent: false,
      live: false,
    })
    expect(parsed.source.bytes).toBeGreaterThan(0)
  })

  test("usage counts each response once, however many records it was split into", () => {
    // Three responses of eight records, each carrying the same full usage (input 100, cache write 20, read 300).
    expect(info(version, "basic").usage).toEqual({ input: 3 * 420, output: 3 * 40, cached: 3 * 300 })
  })

  test("times are monotonic and the first is the first record's", () => {
    const times = info(version, "harness").turns.flatMap((turn) => [turn.time, ...turn.steps.map((item) => item.time)])
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times.every(Number.isFinite)).toBe(true)
  })

  test("titles: custom-title.json when no record names it; last-prompt before the first line, its leafUuid ignored", () => {
    expect(info(version, "agents").source.title).toBe("탐색과 계획")
    expect(info(version, "abandoned").source.title).toBe("second request, old wording")
    expect(info(version, "parallel").source.title).toBe("Read both files")
  })

  test("several cwds: every recorded folder, the relocated one included", () => {
    expect(info(version, "relocated").source.cwds).toEqual([CWD, WORKTREE])
  })

  test("sub-agent links by toolUseId and agentId; an id that is not a SourceID is left out", () => {
    expect(info(version, "agents").children).toEqual([
      { id: `${IDS.agents}:a1b2`, title: "explore", agent: "Explore", at: { turn: 0, step: 0 } },
      { id: `${IDS.agents}:c3d4`, title: "plan", agent: "Plan", at: { turn: 0, step: 1 } },
    ])
  })

  test("a persisted-output preview stays as the model saw it and names its tool-results file", () => {
    const grep = info(version, "notices").turns[0].steps[0]
    expect(grep.type === "tool" ? grep.output?.text : "").toContain("Preview (first 2KB):\nline 1\nline 2")
    expect(ClaudeTranscript.persisted(grep.type === "tool" ? (grep.output?.text ?? "") : "")).toBe("br7fixture.txt")
  })

  test("the IR is the same for both releases", () => {
    const other = VERSIONS.find((item) => item !== version) ?? version
    expect(Transcript.contentHash(info(version, "basic").turns)).toBe(
      Transcript.contentHash(info(other, "basic").turns),
    )
    expect(info(version, "afterTool").checkpoints).toEqual(info(other, "afterTool").checkpoints)
  })
})

describe("the parser beyond the fixtures", () => {
  const context: ClaudeTranscript.Context = {
    id: IDS.basic,
    rootID: "claude-000000000000",
    path: "C:\\fixture\\x.jsonl",
    bytes: 1,
    mtimeMs: MTIME,
    now: NOW,
    children: [],
  }
  const lines = (records: ReadonlyArray<unknown>) => records.map((record) => JSON.stringify(record))

  test("the last turn is open while the file is live and its last step is not an answer", () => {
    const s = session({ cwd: CWD, id: IDS.basic, version: "2.1.288" })
    s.user("long job")
    s.assistant([toolUse("toolu_FAKEC1", "Bash", { command: "sleep 1" })], { id: "msg_FAKEC1" })
    s.result("toolu_FAKEC1", "done")
    const live = ClaudeTranscript.parse(lines(s.records()), { ...context, now: MTIME + 30_000 })
    expect(live.source.live).toBe(true)
    expect(live.turns.map((turn) => turn.end)).toEqual(["open"])
    expect(ClaudeTranscript.parse(lines(s.records()), context).turns.map((turn) => turn.end)).toEqual(["interrupted"])
  })

  test("a compact summary without a boundary record (older releases) is a checkpoint at its place", () => {
    const s = session({ cwd: CWD, id: IDS.basic, version: "2.0.10" })
    s.summary("This session is being continued from a previous conversation that ran out of context.\nSummary: x")
    s.user("go on")
    s.assistant([text("going")], { id: "msg_FAKEC2" })
    const parsed = ClaudeTranscript.parse(lines(s.records()), context)
    expect(parsed.checkpoints).toEqual([
      {
        at: { turn: 0, step: 0, source: { uuid: s.records()[0].uuid as string } },
        kind: "foreign",
        summary: "Summary: x",
        recent: [],
      },
    ])
    expect(parsed.dropped).toEqual({ boilerplateUnmatched: 2 })
  })

  test("broken lines are counted, the rest is read", () => {
    const s = session({ cwd: CWD, id: IDS.basic, version: "2.1.288" })
    s.user("hello")
    s.assistant([text("hi")], { id: "msg_FAKEC3" })
    const parsed = ClaudeTranscript.parse(
      ["not json", '{"no":"type"}', '{"type":"user","uuid":"u-1","message":{"content":42}}', ...lines(s.records()), ""],
      context,
    )
    expect(render(parsed)).toEqual(['0 completed "hello"', '  text "hi"'])
    expect(parsed.dropped).toEqual({ decodeFailed: 3 })
  })

  test("null and missing envelope fields never cost a record (the format is not documented)", () => {
    const records = [
      {
        type: "user",
        uuid: "n-1",
        parentUuid: null,
        cwd: null,
        gitBranch: null,
        version: null,
        timestamp: null,
        isSidechain: null,
        isMeta: null,
        message: { content: "hello" },
      },
      {
        type: "assistant",
        uuid: "n-2",
        parentUuid: "n-1",
        message: { id: null, model: null, content: [{ type: "text", text: "hi" }], usage: null },
      },
    ]
    const parsed = ClaudeTranscript.parse(lines(records), context)
    expect(render(parsed)).toEqual(['0 completed "hello"', '  text "hi" model=undefined'])
    expect([parsed.source.cwds, parsed.source.versions, parsed.source.models, parsed.dropped]).toEqual([[], [], [], {}])
    expect(parsed.turns[0].time).toBe(MTIME)
  })

  test("a response without a human message before it gets an empty first turn", () => {
    const s = session({ cwd: CWD, id: IDS.basic, version: "2.1.288" })
    s.assistant([text("resumed")], { id: "msg_FAKEC4" })
    expect(render(ClaudeTranscript.parse(lines(s.records()), context))).toEqual(['0 completed ""', '  text "resumed"'])
  })

  test("a sub-agent file reads its sidechain records as its own conversation", async () => {
    const item = await fixture()
    try {
      const root = Paths.defaults({ options: { roots: { codex: [], claude: [item.claude] } } })[0]
      const created = await agents(item.claude, "2.1.288")
      const main = await ClaudeSource.conversations(root, path.basename(path.dirname(created.file)))
      const conversation = main.ok ? main.value[0] : undefined
      if (conversation === undefined) throw new Error("no conversation")
      const child = (await ClaudeSource.children(root, conversation))[0]
      const parsed = await ClaudeSource.transcript(root, child, NOW)
      if (!parsed.ok) throw new Error(parsed.reason)
      expect(render(parsed.value)).toEqual(['0 completed "map it"', '  text "Mapped: two packages."'])
      expect([parsed.value.source.id, parsed.value.source.parentID, parsed.value.source.subagent]).toEqual([
        `${IDS.agents}:a1b2`,
        IDS.agents,
        true,
      ])
      expect(parsed.value.source.title).toBe("explore")
      expect(parsed.value.dropped).toEqual({})
    } finally {
      await item.cleanup()
    }
  })

  test("values() reads JSON string fields without parsing, escapes included", () => {
    const line = JSON.stringify({ cwd: "C:\\작업\\#1", nested: { cwd: 'D:\\b "q"' }, other: 'say "cwd":"x"' })
    expect(ClaudeTranscript.values(line, "cwd")).toEqual(["C:\\작업\\#1", 'D:\\b "q"'])
    expect(ClaudeTranscript.values('{"cwd": "spaced"}', "cwd")).toEqual(["spaced"])
    expect(ClaudeTranscript.values('{"cwd":"unterminated', "cwd")).toEqual([])
  })

  test("persisted() takes only a file name", () => {
    expect(
      ClaudeTranscript.persisted("<persisted-output>\nFull output saved to: /a/b/x1.txt\n</persisted-output>"),
    ).toBe("x1.txt")
    expect(ClaudeTranscript.persisted("<persisted-output>\nsaved to: C:\\a\\..\n</persisted-output>")).toBeUndefined()
    expect(ClaudeTranscript.persisted("Full output saved to: x1.txt")).toBeUndefined()
  })

  test("title order", () => {
    const all = { custom: "c", file: "f", ai: "a", prompt: "p", summary: "s", first: "first" }
    expect(ClaudeTranscript.title(all)).toBe("c")
    expect(ClaudeTranscript.title({ ...all, custom: undefined })).toBe("f")
    expect(ClaudeTranscript.title({ ...all, custom: " ", file: undefined })).toBe("a")
    expect(ClaudeTranscript.title({ prompt: "<command-name>/x</command-name>", summary: "s", first: "first" })).toBe(
      "s",
    )
    expect(ClaudeTranscript.title({ first: "first" })).toBe("first")
    expect(ClaudeTranscript.title({})).toBe("")
    expect(ClaudeTranscript.title({ ai: "a\nb   c" })).toBe("a b c")
  })
})
