import { describe, expect, test } from "bun:test"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { OwnImport } from "@own/protocol/rpc-import"
import { Token } from "@own/protocol/token"
import { Schema } from "effect"
import { Fill } from "../../src/migrate/fill.js"
import { Notice } from "../../src/render/notice.js"
import { Store } from "../../src/render/store.js"
import { Brief } from "../../src/transcript/brief.js"
import { ClaudeTranscript } from "../../src/transcript/claude.js"
import { Transcript } from "../../src/transcript/ir.js"
import { VERSIONS, afterTool } from "../fixtures/claude.js"
import { FAKE } from "../fixtures/make.js"

const T0 = Date.UTC(2026, 9, 8, 9)
const TARGET = { providerID: "own-codex-1", id: "gpt-6" }
const SESSION = "ses_fixture0000000000000001"
const BASE = {
  target: TARGET,
  images: true,
  sessionID: SESSION,
  projectID: "prj_fixture",
  location: { directory: "C:\\work\\proj" },
  importedAt: T0 + 3_600_000,
} as const

const decode = Schema.decodeUnknownSync(SessionTransfer.Data)
const INTRO = Store.ACTIVITY_INTRO

type Message = Store.Built["data"]["messages"][number]

const text = (value: string, time: number, model?: string): Transcript.Step => ({
  type: "text",
  text: value,
  time,
  ...(model === undefined ? {} : { model }),
})
const note = (value: string, time: number): Transcript.Step => ({ type: "note", text: value, time })
function tool(name: string, time: number, more: Partial<Transcript.ToolStep> = {}): Transcript.Step {
  return {
    type: "tool",
    name,
    input: { cmd: "bun test" },
    output: { text: "3 pass", error: false },
    exit: 0,
    time,
    ...more,
  }
}

function turn(
  index: number,
  steps: ReadonlyArray<Transcript.Step>,
  user: Partial<Transcript.User> = {},
  end: Transcript.End = "completed",
): Transcript.Turn {
  return {
    index,
    time: T0 + index * 100,
    user: { text: `request ${index}`, images: [], ...user },
    steps: [...steps],
    end,
  }
}

/** Turn `index` with the usual three steps at `index·100 + 1..3`. */
function plain(index: number, extra: ReadonlyArray<Transcript.Step> = []) {
  const at = T0 + index * 100
  return turn(index, [tool("exec_command", at + 1), text(`answer ${index}`, at + 2, "gpt-5.5"), ...extra])
}

function transcript(
  turns: ReadonlyArray<Transcript.Turn>,
  checkpoints: ReadonlyArray<Transcript.Checkpoint> = [],
  kind: Transcript.Kind = "codex",
): Transcript.Info {
  return {
    source: {
      kind,
      id: "019a0000-0000-7000-8000-000000000001",
      rootID: kind === "codex" ? "codex-0123456789ab" : "claude-0123456789ab",
      path: "C:\\fixture\\codex\\sessions\\2026\\10\\08\\rollout-x.jsonl",
      versions: ["0.153.0"],
      cwds: ["\\\\?\\C:\\work\\proj", "C:\\work\\proj\\sub"],
      title: "설치기 정리",
      models: [{ provider: "openai", id: "gpt-5.5" }],
      createdAt: T0,
      updatedAt: T0 + 99_000,
      bytes: 4096,
      subagent: false,
      live: false,
    },
    turns: [...turns],
    checkpoints: [...checkpoints],
    children: [],
    dropped: { thinking: 2, encryptedReasoning: 1 },
  }
}

function foreign(turnIndex: number, step: number, more: Partial<Transcript.Checkpoint> = {}): Transcript.Checkpoint {
  return {
    at: { turn: turnIndex, step, source: { uuid: `uuid-${turnIndex}-${step}` } },
    kind: "foreign",
    summary: `The tool's summary up to ${turnIndex}.${step}.`,
    recent: [
      { role: "tool-call", text: 'Bash({"command":"bun test"})' },
      { role: "tool-result", text: "2 pass" },
    ],
    ...more,
  }
}

const textOf = (message: Message) => ("text" in message ? message.text : "")
const types = (built: Store.Built) => built.data.messages.map((message) => message.type)
const compactions = (built: Store.Built) =>
  built.data.messages.flatMap((message) => (message.type === "compaction" ? [message] : []))

describe("the stored shape (09 §4.2, IG7)", () => {
  const info = transcript([
    turn(0, [
      { type: "reasoning-summary", text: "thinking it over", time: T0 + 1 },
      tool("exec_command", T0 + 2),
      note("Background command finished", T0 + 3),
      text("Fixed.", T0 + 4, "gpt-5.5"),
    ]),
    turn(
      1,
      [tool("Bash", T0 + 101, { exit: undefined, output: { text: "boom", error: true } }), text("Retrying.", T0 + 102)],
      {},
      "interrupted",
    ),
  ])
  const built = Store.build({ ...BASE, transcript: info, boundary: { type: "none" } })

  test("decodes with core's SessionTransfer.Data", () => {
    expect(() => decode(built.data)).not.toThrow()
  })

  test("info: the given id, build agent, the target model, no permissions, zero usage, times from the messages", () => {
    const messages = built.data.messages
    const end = messages[messages.length - 1].time.created
    expect(built.data.info).toEqual({
      id: SESSION,
      projectID: "prj_fixture",
      agent: "build",
      model: TARGET,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      outcome: "succeeded",
      time: { created: messages[0].time.created, updated: end, idle: end, viewed: end },
      title: "설치기 정리",
      location: { directory: "C:\\work\\proj" },
      metadata: built.data.info.metadata,
    })
    expect(messages[0].time.created).toBe(T0)
    expect(end).toBe(T0 + 102)
  })

  test("metadata own.import decodes with the protocol schema and records the source", () => {
    const value: unknown = OwnImport.decodeMetadata(built.data.info.metadata)
    expect(value).toEqual({
      v: 1,
      kind: "codex",
      sourceID: "019a0000-0000-7000-8000-000000000001",
      root: "codex-0123456789ab",
      path: "C:\\fixture\\codex\\sessions\\2026\\10\\08\\rollout-x.jsonl",
      title: "설치기 정리",
      cwd: "C:\\work\\proj\\sub",
      models: [{ provider: "openai", id: "gpt-5.5" }],
      versions: ["0.153.0"],
      sourceUpdatedAt: T0 + 99_000,
      sourceBytes: 4096,
      turns: 2,
      contentHash: Transcript.contentHash(info.turns),
      mode: "full",
      checkpoint: null,
      storedFull: true,
      redactions: 0,
      dropped: { thinking: 2, encryptedReasoning: 1 },
      importedAt: T0 + 3_600_000,
    })
    expect(
      Store.build({ ...BASE, transcript: info, boundary: { type: "none" }, upToTurn: 0 }).data.info.metadata,
    ).toMatchObject({ "own.import": { turns: 1, contentHash: Transcript.contentHash(info.turns.slice(0, 1)) } })
  })

  test("per turn: the user message, a record per tool step and note, the model's text, idle; reasoning is never stored", () => {
    expect(types(built)).toEqual([
      "user",
      "synthetic",
      "synthetic",
      "assistant",
      "idle",
      "user",
      "synthetic",
      "assistant",
      "idle",
      "system",
    ])
    const assistants = built.data.messages.flatMap((message) => (message.type === "assistant" ? [message] : []))
    expect(assistants).toEqual([
      {
        type: "assistant",
        id: assistants[0].id,
        agent: "build",
        model: { providerID: "codex-cli", id: "gpt-5.5" },
        content: [{ type: "text", text: "Fixed." }],
        finish: "stop",
        time: { created: T0 + 4, completed: T0 + 4 },
      },
      {
        type: "assistant",
        id: assistants[1].id,
        agent: "build",
        model: { providerID: "codex-cli", id: "unknown" },
        content: [{ type: "text", text: "Retrying." }],
        finish: "stop",
        time: { created: T0 + 102, completed: T0 + 102 },
      },
    ])
    expect(built.data.messages.flatMap((message) => (message.type === "idle" ? [message.outcome] : []))).toEqual([
      "succeeded",
      "interrupted",
    ])
    // Never usage, provider state or reasoning in a message (IM-D5, IG7).
    const body = JSON.stringify(built.data.messages)
    for (const key of ['"tokens"', '"cost"', '"providerState"', '"reasoning"', "thinking it over"])
      expect(body).not.toContain(key)
    // Claude Code conversations show their own display provider; no own slot is called either.
    const claude = Store.build({
      ...BASE,
      transcript: transcript(info.turns, [], "claude-code"),
      boundary: { type: "none" },
    })
    expect(claude.data.messages.find((message) => message.type === "assistant")).toMatchObject({
      model: { providerID: "claude-code" },
    })
  })

  test("tool records are user-role synthetic messages in the fixed English format", () => {
    const records = built.data.messages.flatMap((message) => (message.type === "synthetic" ? [message] : []))
    expect(records.map((message) => message.description)).toEqual([
      Store.ACTIVITY_DESCRIPTION,
      Store.ACTIVITY_DESCRIPTION,
      Store.ACTIVITY_DESCRIPTION,
    ])
    expect(records.map((message) => message.text)).toEqual([
      [
        "<imported-tool-activity>",
        INTRO,
        "[call] exec_command",
        "bun test",
        "[result] exit 0",
        "```",
        "3 pass",
        "```",
        "</imported-tool-activity>",
      ].join("\n"),
      ["<imported-tool-activity>", INTRO, "[note] Background command finished", "</imported-tool-activity>"].join("\n"),
      [
        "<imported-tool-activity>",
        INTRO,
        "[call] Bash",
        "bun test",
        "[result] error",
        "```",
        "boom",
        "```",
        "</imported-tool-activity>",
      ].join("\n"),
    ])
  })

  test("result lines: no result, an empty output, a fence longer than the output's backticks, a free-text input", () => {
    const one = Store.build({
      ...BASE,
      transcript: transcript([
        turn(0, [
          tool("exec_command", T0 + 1, { output: undefined, exit: undefined }),
          tool("exec_command", T0 + 2, { output: { text: "", error: false } }),
          tool("apply_patch", T0 + 3, {
            input: "*** Begin Patch\n*** End Patch",
            exit: undefined,
            output: { text: "x ```` y", error: false },
          }),
          tool("shell", T0 + 4, { input: { command: ["bash", "-lc", "git status"], workdir: "C:\\w" } }),
        ]),
      ]),
      boundary: { type: "none" },
    })
    const lines = one.data.messages
      .filter((message) => message.type === "synthetic")
      .map((message) => textOf(message).split("\n").slice(2, -1))
    expect(lines).toEqual([
      ["[call] exec_command", "bun test", "[result] none recorded"],
      ["[call] exec_command", "bun test", "[result] exit 0 (no output)"],
      ["[call] apply_patch", "*** Begin Patch", "*** End Patch", "[result]", "`````", "x ```` y", "`````"],
      ["[call] shell", "git status", '{"workdir":"C:\\\\w"}', "[result] exit 0", "```", "3 pass", "```"],
    ])
  })

  test("caps: tool input 16 KiB and each result 64 KiB, cut before a character, with the bytes not imported", () => {
    const big = Store.build({
      ...BASE,
      transcript: transcript([
        turn(0, [
          tool("apply_patch", T0 + 1, {
            input: "a".repeat(20_000),
            output: { text: "b".repeat(70_000), error: false },
          }),
          tool("exec_command", T0 + 2, { output: { text: "가".repeat(30_000), error: false } }),
        ]),
      ]),
      boundary: { type: "none" },
    })
    const [first, second] = big.data.messages.filter((message) => message.type === "synthetic").map(textOf)
    expect(first).toContain(`\n${"a".repeat(16_384)}\n[… 3616 bytes not imported]\n[result] exit 0\n`)
    expect(first).toContain(`\n${"b".repeat(65_536)}\n[… 4464 bytes not imported]\n`)
    // 65,536 bytes hold 21,845 three-byte characters (65,535 bytes); 24,465 bytes are left out.
    expect(second).toContain(`\n${"가".repeat(21_845)}\n[… 24465 bytes not imported]\n`)
  })

  test("the notice is the last message, a system message naming the model-visible tools only", () => {
    const last = built.data.messages.at(-1)
    expect(last).toEqual({
      type: "system",
      id: last?.id ?? "",
      text: Notice.text("codex", ["Bash", "exec_command"]),
      description: Notice.DESCRIPTION,
      time: { created: T0 + 102 },
    })
    expect(built.tools).toEqual(["Bash", "exec_command"])
    expect(built.notice).toBe(Token.estimate(Notice.text("codex", ["Bash", "exec_command"])))
  })

  test("the visible size is what the model reads: the stored turns as measured, plus the notice", () => {
    const measure = Store.measure("codex", { images: true })
    expect(built.visible).toBe(Fill.tokens(info.turns, measure) + built.notice)
    expect(built.visible).toBe(built.data.messages.reduce((total, message) => total + Store.estimate(message), 0))
  })
})

describe("message ids and determinism (09 §4.2, IG7, 01 R8)", () => {
  const info = transcript([plain(0), plain(1), plain(2)], [foreign(1, 1)])
  const options = { ...BASE, transcript: info, boundary: { type: "source", checkpoint: info.checkpoints[0] } } as const

  test("msg_ + 12 hex of the message time + 14 base62 of sha256(sessionID:seq), all distinct", () => {
    const built = Store.build(options)
    const ids = built.data.messages.map((message) => message.id)
    expect(new Set(ids).size).toBe(ids.length)
    built.data.messages.forEach((message, seq) => {
      expect(message.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      expect(message.id).toBe(Store.messageID(SESSION, seq, message.time.created))
      expect(message.id.slice(4, 16)).toBe(
        ((BigInt(message.time.created) * 0x1000n) & 0xffff_ffff_ffffn).toString(16).padStart(12, "0"),
      )
    })
  })

  test("the same transcript and options give byte-identical messages; another session only changes the ids", () => {
    const one = Store.build(options)
    const two = Store.build({ ...options, transcript: structuredClone(info) })
    expect(JSON.stringify(two.data)).toBe(JSON.stringify(one.data))
    const other = Store.build({ ...options, sessionID: "ses_fixture0000000000000002" })
    const strip = (built: Store.Built) => built.data.messages.map((message) => ({ ...message, id: "" }))
    expect(strip(other)).toEqual(strip(one))
    expect(other.data.messages[0].id).not.toBe(one.data.messages[0].id)
    // A generated session id when none is given.
    expect(Store.build({ ...options, sessionID: undefined }).data.info.id).toMatch(/^ses_/)
  })
})

describe("boundaries (09 §4.2 원본 checkpoint, §4.4 최종 가져오기 모양)", () => {
  test("a source checkpoint mid-turn: [P short][compaction][the turn's later steps][V][notice]", () => {
    const checkpoint = foreign(1, 1, { trigger: "manual" })
    const info = transcript([plain(0), plain(1), plain(2)], [checkpoint])
    const built = Store.build({ ...BASE, transcript: info, boundary: { type: "source", checkpoint } })
    expect(() => decode(built.data)).not.toThrow()
    expect(types(built)).toEqual([
      // P: turn 0, then turn 1's user message and its first step (the tool) in the short shape.
      "user",
      "synthetic",
      "assistant",
      "idle",
      "user",
      "synthetic",
      // The source checkpoint right after its record, then turn 1's later step and its end.
      "compaction",
      "assistant",
      "idle",
      "user",
      "synthetic",
      "assistant",
      "idle",
      "system",
    ])
    const compaction = compactions(built)[0]
    expect(compaction).toEqual({
      type: "compaction",
      id: compaction.id,
      status: "completed",
      reason: "manual",
      summary: "The tool's summary up to 1.1.",
      metadata: { recent: '[Assistant tool call]: Bash({"command":"bun test"})\n[Tool result]: 2 pass' },
      time: { created: T0 + 102 },
    })
    expect(textOf(built.data.messages[5])).toBe(
      [
        "<imported-tool-activity>",
        INTRO,
        "[call] exec_command · exit 0 · output 6 B not imported",
        "</imported-tool-activity>",
      ].join("\n"),
    )
    expect(OwnImport.decodeMetadata(built.data.info.metadata)).toMatchObject({ checkpoint: "foreign", mode: "full" })
    // The visible part starts at the checkpoint: its later steps, not its user message.
    const measure = Store.measure("codex", { images: true })
    expect(built.visible).toBe(
      Fill.tokens(info.turns, measure, Fill.at(checkpoint)) + Store.estimate(compaction) + built.notice,
    )
    // Without a trigger the reason is auto.
    const auto = foreign(1, 1)
    expect(
      compactions(
        Store.build({
          ...BASE,
          transcript: transcript(info.turns, [auto]),
          boundary: { type: "source", checkpoint: auto },
        }),
      )[0],
    ).toMatchObject({ reason: "auto" })
  })

  test("the short shape keeps the model's text and one line per tool step; tool outputs are not stored", () => {
    const at = T0
    const info = transcript(
      [
        turn(0, [
          tool("exec_command", at + 1, { output: { text: `${"q".repeat(70_000)}SECRET-OUTPUT`, error: false } }),
          tool("Bash", at + 2, { exit: 1, output: { text: "failed", error: true } }),
          note("Queued message (peer): hand-off", at + 3),
          tool("web_search", at + 4, { exit: undefined, output: { text: "", error: false } }),
          tool("spawn_agent", at + 5, { exit: undefined, output: undefined }),
          text("Unseen answer.", at + 6),
          tool("exec_command", at + 7),
        ]),
        plain(1),
      ],
      [foreign(1, 0)],
    )
    const built = Store.build({
      ...BASE,
      transcript: info,
      boundary: { type: "source", checkpoint: info.checkpoints[0] },
    })
    expect(types(built).slice(0, 6)).toEqual(["user", "synthetic", "assistant", "synthetic", "idle", "user"])
    expect(textOf(built.data.messages[1])).toBe(
      [
        "<imported-tool-activity>",
        INTRO,
        "[call] exec_command · exit 0 · output 68 KB not imported",
        "[call] Bash · exit 1 · error · output 6 B not imported",
        "[note] Queued message (peer): hand-off",
        "[call] web_search",
        "[call] spawn_agent · no result recorded",
        "</imported-tool-activity>",
      ].join("\n"),
    )
    expect(built.data.messages[2]).toMatchObject({
      type: "assistant",
      content: [{ type: "text", text: "Unseen answer." }],
    })
    expect(JSON.stringify(built.data)).not.toContain("SECRET-OUTPUT")
    // `원래 대화 전체도 own에 저장` off: only what the model sees.
    const lean = Store.build({
      ...BASE,
      transcript: info,
      boundary: { type: "source", checkpoint: info.checkpoints[0] },
      full: false,
    })
    expect(types(lean)[0]).toBe("compaction")
    expect(OwnImport.decodeMetadata(lean.data.info.metadata)).toMatchObject({ storedFull: false })
    expect(lean.visible).toBe(built.visible)
  })

  test("codex-remote: briefAt(x) is the checkpoint; the last foreign checkpoint before x stays at its place", () => {
    const local = foreign(0, 2)
    const remote: Transcript.Checkpoint = {
      at: { turn: 2, step: 1, source: { ordinal: 40 } },
      kind: "codex-remote",
      recent: [{ role: "user", text: "request 2" }],
    }
    const info = transcript([plain(0), plain(1), plain(2), plain(3)], [local, remote])
    const x = { turn: 2 }
    const built = Store.build({ ...BASE, transcript: info, boundary: { type: "remote", at: x } })
    expect(() => decode(built.data)).not.toThrow()
    expect(types(built)).toEqual([
      "user",
      "synthetic",
      "assistant", // turn 0 before the local summary
      "compaction", // the local summary at its place
      "idle", // turn 0 ends after it
      "user",
      "synthetic",
      "assistant",
      "idle", // turn 1, short
      "compaction", // briefAt(x)
      "user",
      "synthetic",
      "assistant",
      "idle", // turn 2
      "user",
      "synthetic",
      "assistant",
      "idle", // turn 3
      "system",
    ])
    const zones = Fill.zones(info)
    const brief = Brief.briefAt(zones, x)
    expect(compactions(built)[1]).toMatchObject({
      reason: "auto",
      summary: brief.summary,
      metadata: { recent: brief.recent },
    })
    expect(
      brief.summary.startsWith("The tool's summary up to 0.2.\n\n## Facts extracted from the original record"),
    ).toBe(true)
    expect(brief.recent).toBe("[User]: request 0\n\n[User]: request 1")
    expect(compactions(built)[1]).not.toHaveProperty("model")
    expect(OwnImport.decodeMetadata(built.data.info.metadata)).toMatchObject({
      checkpoint: "codex-remote",
      mode: "full",
      tailFromTurn: 2,
    })
    // Off: no source checkpoint and no short turns.
    expect(
      types(Store.build({ ...BASE, transcript: info, boundary: { type: "remote", at: x }, full: false })).slice(0, 2),
    ).toEqual(["compaction", "user"])
    // x exactly at the remote boundary: recent is what Codex kept.
    const at = Store.build({ ...BASE, transcript: info, boundary: { type: "remote", at: { turn: 2, step: 1 } } })
    expect(compactions(at)[1]).toMatchObject({ metadata: { recent: "[User]: request 2" } })
  })

  test("LLM summary: S + the brief of the turns before the tail, R, the summarizer, its usage copied, reason manual", () => {
    const info = transcript([plain(0), plain(1), plain(2), plain(3)], [foreign(1, 0)])
    const summary = {
      text: "LLM summary of the old part.",
      recent: "[User]: request 2",
      model: { providerID: "own-codex-1", id: "gpt-6" },
      cost: 0.0123,
      tokens: { input: 40_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const built = Store.build({ ...BASE, transcript: info, boundary: { type: "llm", at: { turn: 3 }, summary } })
    expect(() => decode(built.data)).not.toThrow()
    const last = compactions(built).at(-1)
    expect(last).toEqual({
      type: "compaction",
      id: last?.id ?? "",
      status: "completed",
      reason: "manual",
      summary: `LLM summary of the old part.\n\n${Brief.brief(Fill.pieces(info.turns, Fill.START, { turn: 3 }))}`,
      metadata: { recent: "[User]: request 2" },
      model: summary.model,
      cost: 0.0123,
      tokens: summary.tokens,
      time: { created: T0 + 300 },
    })
    // [P short][source checkpoint][old short][compaction][tail][notice]; the source checkpoint follows turn 1's request.
    expect(types(built)).toEqual([
      "user",
      "synthetic",
      "assistant",
      "idle",
      "user",
      "compaction",
      "synthetic",
      "assistant",
      "idle",
      "user",
      "synthetic",
      "assistant",
      "idle",
      "compaction",
      "user",
      "synthetic",
      "assistant",
      "idle",
      "system",
    ])
    expect(OwnImport.decodeMetadata(built.data.info.metadata)).toMatchObject({
      checkpoint: "llm",
      mode: "summary",
      summarizer: summary.model,
      tailFromTurn: 3,
    })
  })

  test("LLM-free summary: briefAt(tail start), reason manual, mode summary", () => {
    const info = transcript([plain(0), plain(1), plain(2)])
    const built = Store.build({ ...BASE, transcript: info, boundary: { type: "brief", at: { turn: 2, step: 1 } } })
    const brief = Brief.briefAt(Fill.zones(info), { turn: 2, step: 1 })
    expect(compactions(built)).toEqual([
      expect.objectContaining({ reason: "manual", summary: brief.summary, metadata: { recent: brief.recent } }),
    ])
    expect(brief.recent).toBe("[User]: request 0\n\n[User]: request 1\n\n[User]: request 2")
    expect(types(built).slice(-4)).toEqual(["compaction", "assistant", "idle", "system"])
    expect(OwnImport.decodeMetadata(built.data.info.metadata)).toMatchObject({
      checkpoint: "brief",
      mode: "summary",
      tailFromTurn: 2,
    })
  })

  test("a Claude Code fixture with a mid-turn compact_boundary imports as it was seen", () => {
    for (const version of VERSIONS) {
      const fixture = afterTool(version)
      const info = ClaudeTranscript.parse(
        fixture.session.records().map((record) => JSON.stringify(record)),
        {
          id: fixture.input.id,
          rootID: "claude-0123456789ab",
          path: "C:\\fixture\\c.jsonl",
          bytes: 1,
          mtimeMs: T0,
          now: T0 + 3_600_000_000,
          children: [],
        },
      )
      const zones = Fill.zones(info)
      const chosen = Fill.full({
        zones,
        budget: { ceiling: 1, Z: 0, notice: 0, exchange: 0 },
        measure: Store.measure("claude-code", { images: false }),
        brief: () => 0,
      })
      expect(chosen.boundary.type).toBe("source")
      const built = Store.build({ ...BASE, transcript: info, boundary: chosen.boundary })
      expect(() => decode(built.data)).not.toThrow()
      const at = built.data.messages.findIndex((message) => message.type === "compaction")
      // Before it: turn 1's request and its tool step; after it: the same turn continues with the model's text.
      expect(
        built.data.messages.slice(at - 2, at + 3).map((message) => [message.type, textOf(message).split("\n")[0]]),
      ).toEqual([
        ["user", "also update the docs"],
        ["synthetic", "<imported-tool-activity>"],
        ["compaction", ""],
        ["assistant", ""],
        ["idle", ""],
      ])
      expect(built.data.messages[at + 1]).toMatchObject({
        content: [{ type: "text", text: "Continuing after the compaction." }],
        model: { providerID: "claude-code" },
      })
      expect(built.data.messages.slice(at).map((message) => message.type)).not.toContain("reasoning")
    }
  })
})

describe("images (09 §4.2)", () => {
  const png = (bytes = 3, data = "AAEC") => ({ mime: "image/png", bytes, data })

  test("inline in the model-visible part when the target takes images; otherwise [image: <type>, <size>]", () => {
    const info = transcript([
      turn(0, [text("seen 0", T0 + 1)], { text: "look", images: [png()] }),
      turn(1, [text("seen 1", T0 + 101)], {
        text: "",
        images: [png(), { mime: "image/heic", bytes: 2048, data: "AAAA" }, { mime: "image/png", bytes: 5 }],
      }),
    ])
    const users = (built: Store.Built) =>
      built.data.messages.flatMap((message) => (message.type === "user" ? [message] : []))
    const taking = users(Store.build({ ...BASE, transcript: info, boundary: { type: "none" } }))
    expect(taking[0]).toMatchObject({
      text: "look",
      files: [{ data: "AAEC", mime: "image/png", source: { type: "inline" } }],
    })
    expect(taking[1]).toMatchObject({
      text: "[image: image/heic, 2 KB]\n[image: image/png, 5 B]",
      files: [{ data: "AAEC" }],
    })
    const blind = users(Store.build({ ...BASE, images: false, transcript: info, boundary: { type: "none" } }))
    expect(blind[0]).toEqual({
      type: "user",
      id: blind[0].id,
      text: "look\n[image: image/png, 3 B]",
      time: { created: T0 },
    })
    // A turn the model does not see keeps a placeholder even when the target takes images.
    const checkpoint = foreign(1, 0)
    const unseen = users(
      Store.build({
        ...BASE,
        transcript: transcript(info.turns, [checkpoint]),
        boundary: { type: "source", checkpoint },
      }),
    )
    expect(unseen[0]).toEqual({
      type: "user",
      id: unseen[0].id,
      text: "look\n[image: image/png, 3 B]",
      time: { created: T0 },
    })
  })

  test("core's bound: past 25 MiB of images the oldest become placeholders until 15 MiB are left", () => {
    const mib = 1024 * 1024
    const info = transcript(
      [0, 1, 2].map((index) => turn(index, [text("ok", T0 + index * 100 + 1)], { images: [png(10 * mib)] })),
    )
    const built = Store.build({ ...BASE, transcript: info, boundary: { type: "none" } })
    const users = built.data.messages.flatMap((message) => (message.type === "user" ? [message] : []))
    expect(users.map((message) => message.files?.length ?? 0)).toEqual([0, 0, 1])
    expect(users[0].text).toBe("request 0\n[image: image/png, 10.0 MB]")
  })
})

describe("the body budget (09 §2.8)", () => {
  const long = (index: number) => turn(index, [text(`${"long answer ".repeat(200)}${index}`, T0 + index * 100 + 1)])
  // The source checkpoint closes turn 7 (after its only step), so turns 0–7 are unseen.
  const info = transcript(
    [...Array.from({ length: 8 }, (_, index) => long(index)), plain(8), plain(9)],
    [foreign(7, 1)],
  )
  const boundary = { type: "source", checkpoint: info.checkpoints[0] } as const

  test("past the budget the oldest unseen turns are left out; the model-visible part always stays", () => {
    const whole = Store.build({ ...BASE, transcript: info, boundary })
    expect(whole).toMatchObject({ trimmedTurns: 0, budget: Store.BUDGET })
    expect(whole.bytes).toBe(Buffer.byteLength(JSON.stringify(whole.data)))
    const one = Store.build({ ...BASE, transcript: info, boundary, budget: whole.bytes - 1 })
    expect(one.trimmedTurns).toBe(1)
    expect(one.bytes).toBeLessThanOrEqual(whole.bytes - 1)
    expect(one.data.messages[0]).toMatchObject({ type: "user", text: "request 1" })
    expect(one.data.info.time.created).toBe(T0 + 100)
    expect(() => decode(one.data)).not.toThrow()
    const none = Store.build({ ...BASE, transcript: info, boundary, budget: 1_000 })
    expect(none.trimmedTurns).toBe(8)
    expect(types(none).slice(0, 3)).toEqual(["compaction", "idle", "user"])
    expect(none.data.messages[2]).toMatchObject({ text: "request 8" })
    expect(none.visible).toBe(whole.visible)
    expect(none.bytes).toBeGreaterThan(1_000)
  })
})

describe("named redaction (09 §4.2 비밀 가리기, IG10)", () => {
  const info = transcript(
    [
      turn(0, [
        tool("exec_command", T0 + 1, { output: { text: `unseen ${FAKE.github}`, error: false } }),
        text(`old ${FAKE.jwt}`, T0 + 2),
      ]),
      turn(
        1,
        [
          tool("exec_command", T0 + 101, {
            input: { cmd: `curl -H "x-api-key: ${FAKE.apiKey}"` },
            output: { text: `${FAKE.aws} ${FAKE.privateKey}`, error: false },
          }),
          text(`Use ${FAKE.anthropic} carefully`, T0 + 102),
        ],
        { text: `my key is ${FAKE.apiKey}` },
      ),
    ],
    [foreign(1, 0, { summary: `summary with ${FAKE.github}` })],
  )
  const titled = { ...info, source: { ...info.source, title: `title ${FAKE.apiKey}` } }
  const boundary = { type: "source", checkpoint: info.checkpoints[0] } as const

  test("every stored text is redacted with the pattern's label, counted per label; unstored text is not counted", () => {
    const built = Store.build({ ...BASE, transcript: titled, boundary })
    expect(built.redactions).toEqual({
      count: 8,
      labels: {
        "API key": 3,
        JWT: 1,
        "GitHub token": 1,
        "AWS access key": 1,
        "private key": 1,
        "Anthropic API key": 1,
      },
    })
    expect(OwnImport.decodeMetadata(built.data.info.metadata)).toMatchObject({ redactions: 8 })
    const body = JSON.stringify(built.data)
    for (const secret of Object.values(FAKE)) expect(body).not.toContain(secret.slice(0, 16))
    expect(body).toContain("[redacted:API key]")
    expect(built.data.info.title).toBe("title [redacted:API key]")
    // Labels only: never a hash fragment in what the model reads (IG7).
    expect(body).not.toMatch(/\[redacted:[0-9a-f]{8}\]/)
  })

  test("off: nothing is replaced or counted", () => {
    const built = Store.build({ ...BASE, transcript: titled, boundary, redact: false })
    expect(built.redactions).toEqual({ count: 0, labels: {} })
    expect(JSON.stringify(built.data)).toContain(FAKE.apiKey)
  })
})

describe("the helper session (09 §4.4 보조 세션)", () => {
  const checkpoint = foreign(1, 1)
  const info = transcript(
    [
      plain(0),
      plain(1),
      turn(
        2,
        [
          tool("exec_command", T0 + 201, {
            input: { cmd: "x".repeat(2_000) },
            output: { text: "o".repeat(5_000), error: false },
          }),
          text("answer 2", T0 + 202),
        ],
        { images: [{ mime: "image/png", bytes: 3, data: "AAEC" }] },
      ),
      plain(3),
    ],
    [checkpoint],
  )
  const input = {
    transcript: info,
    tail: { turn: 3 },
    model: TARGET,
    jobID: "job_0123456789",
    sessionID: "ses_helper000000000000000001",
    projectID: "prj_fixture",
    location: { directory: "C:\\work\\proj" },
    archivedAt: T0 + 7_200_000,
  }

  test("the last foreign checkpoint before the tail and the turns up to it, tool records cut to 1,250 characters", () => {
    const made = Store.helper(input)
    expect(() => decode(made.data)).not.toThrow()
    expect(made.data.messages.map((message) => message.type)).toEqual([
      "compaction",
      "assistant",
      "idle",
      "user",
      "synthetic",
      "assistant",
      "idle",
    ])
    const record = textOf(made.data.messages[4])
    expect(record).toContain(
      `[call] exec_command\n${"x".repeat(1_250)}\n[truncated]\n[result] exit 0\n\`\`\`\n${"o".repeat(1_250)}\n[truncated]\n\`\`\``,
    )
    expect(textOf(made.data.messages[3])).toBe("request 2\n[image: image/png, 3 B]")
    expect(made.tokens).toBe(made.data.messages.reduce((total, message) => total + Store.estimate(message), 0))
    expect(made.bytes).toBe(Buffer.byteLength(JSON.stringify(made.data)))
  })

  test("info: archived, the summarizing model, helper metadata {v: 1, helper: true, jobID}", () => {
    const made = Store.helper(input)
    expect(made.data.info).toMatchObject({
      id: "ses_helper000000000000000001",
      model: TARGET,
      agent: "build",
      title: Store.HELPER_TITLE,
      time: { archived: T0 + 7_200_000 },
    })
    expect(made.data.info.metadata).toEqual({ "own.import": { v: 1, helper: true, jobID: "job_0123456789" } })
    const value = OwnImport.decodeMetadata(made.data.info.metadata)
    expect(value !== undefined && OwnImport.isHelper(value)).toBe(true)
    // An imported session is never archived.
    expect(Store.build({ ...BASE, transcript: info, boundary: { type: "none" } }).data.info.time).not.toHaveProperty(
      "archived",
    )
  })

  test("without a foreign checkpoint before the tail it starts at the first turn", () => {
    const made = Store.helper({ ...input, transcript: transcript(info.turns), tail: { turn: 1, step: 1 } })
    expect(made.data.messages.map((message) => message.type)).toEqual([
      "user",
      "synthetic",
      "assistant",
      "idle",
      "user",
      "synthetic",
    ])
  })
})
