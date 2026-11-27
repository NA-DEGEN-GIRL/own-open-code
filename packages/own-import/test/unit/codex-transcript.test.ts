import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { CodexTranscript } from "../../src/transcript/codex.js"
import { Transcript } from "../../src/transcript/ir.js"
import {
  AGENTS_MD,
  ENVIRONMENT,
  PNG,
  T0,
  VERBATIM_CWD,
  compactionItem,
  localSummary,
  rollout,
  spawnSource,
  threadId,
  userItem,
} from "../fixtures/codex.js"

const PREFIX = CodexTranscript.SUMMARY_PREFIX
const START = {
  rootID: "codex-0123456789ab",
  path: "C:\\fixture\\rollout.jsonl",
  bytes: 1000,
  mtimeMs: T0,
  now: T0 + 3_600_000,
}
const at = (seconds: number) => T0 + seconds * 1000

function parse(lines: ReadonlyArray<string>, start: Partial<CodexTranscript.Start> = {}) {
  const info = CodexTranscript.parse(lines, { ...START, ...start })
  // Every transcript the parser builds is a valid IR value (09 §2.4).
  expect(Result.isSuccess(Transcript.decode(info))).toBe(true)
  return info
}

/** The PNG fixture as the parser keeps it. */
const PNG_IMAGE = { mime: "image/png", bytes: 70, data: PNG.slice("data:image/png;base64,".length) }

describe("IR snapshots per cli_version family (IG2)", () => {
  test("0.128 legacy: no ordinals, no content kinds, injected context by leading tags, legacy *_end events, a local compaction", () => {
    const lines = rollout({ ordinals: false })
      .meta({ id: threadId(128), cliVersion: "0.128.0", historyMode: "legacy", branch: "main" })
      .developer("<permissions instructions>sandbox</permissions instructions>")
      .user(ENVIRONMENT)
      .user(AGENTS_MD)
      .taskStarted("turn-1")
      .turnContext({ model: "gpt-5.1-codex", turnId: "turn-1" })
      .user("설치기 정리해 줘\n두 번째 줄")
      .userEvent("설치기 정리해 줘")
      .reasoning({ summary: "Looking at the installer" })
      .call("shell", { command: ["bun", "test"] }, "call_1")
      .execEnd("call_1", 0)
      .output("call_1", "12 pass")
      .custom("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch", "call_2")
      .patchApplyEnd("call_2", {
        "C:\\work\\proj\\a.ts": { update: { unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: null } },
      })
      .customOutput("call_2", "Success. Updated the following files:\nM a.ts")
      .assistant("정리했습니다.")
      .agentEvent("정리했습니다.")
      .taskComplete("turn-1")
      .compacted(localSummary("Installer cleanup done; tests pass.", PREFIX), [
        userItem(ENVIRONMENT),
        userItem("설치기 정리해 줘\n두 번째 줄"),
        userItem(localSummary("Installer cleanup done; tests pass.", PREFIX)),
      ])
      .taskStarted("turn-2")
      .user("이제 커밋해 줘")
      .assistant("커밋했습니다.")
      .taskComplete("turn-2")
      .lines()
    expect(parse(lines)).toEqual({
      source: {
        kind: "codex",
        id: threadId(128),
        rootID: START.rootID,
        path: START.path,
        versions: ["0.128.0"],
        app: "cli",
        cwds: [VERBATIM_CWD],
        branch: "main",
        title: "설치기 정리해 줘",
        firstPrompt: "설치기 정리해 줘",
        models: [{ provider: "openai", id: "gpt-5.1-codex" }],
        createdAt: T0,
        updatedAt: at(22),
        bytes: 1000,
        subagent: false,
        live: false,
      },
      turns: [
        {
          index: 0,
          time: at(6),
          user: { text: "설치기 정리해 줘\n두 번째 줄", images: [] },
          steps: [
            { type: "reasoning-summary", text: "Looking at the installer", time: at(8) },
            {
              type: "tool",
              name: "shell",
              input: { command: ["bun", "test"] },
              output: { text: "12 pass", error: false },
              exit: 0,
              time: at(9),
            },
            {
              type: "tool",
              name: "apply_patch",
              input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch",
              output: { text: "Success. Updated the following files:\nM a.ts", error: false },
              diff: [
                {
                  file: "C:\\work\\proj\\a.ts",
                  patch: "@@ -1 +1 @@\n-a\n+b\n",
                  additions: 1,
                  deletions: 1,
                  status: "modified",
                },
              ],
              time: at(12),
            },
            { type: "text", text: "정리했습니다.", model: "gpt-5.1-codex", time: at(15) },
          ],
          end: "completed",
        },
        {
          index: 1,
          time: at(20),
          user: { text: "이제 커밋해 줘", images: [] },
          steps: [{ type: "text", text: "커밋했습니다.", model: "gpt-5.1-codex", time: at(21) }],
          end: "completed",
        },
      ],
      checkpoints: [
        {
          // Line 18 (no ordinals): after the four steps of turn 0, before turn 1.
          at: { turn: 0, step: 4, source: { ordinal: 18 } },
          kind: "foreign",
          summary: "Installer cleanup done; tests pass.",
          recent: [{ role: "user", text: "설치기 정리해 줘\n두 번째 줄" }],
        },
      ],
      children: [],
      dropped: { developerMessage: 1, injectedContext: 2, encryptedReasoning: 1 },
    })
  })

  test("0.140 legacy with content kinds: a mixed text + image + injected message, a mid-turn remote compaction, an aborted turn", () => {
    const lines = rollout({ ordinals: false })
      .meta({
        id: threadId(140),
        cliVersion: "0.140.2",
        historyMode: "legacy",
        source: "vscode",
        originator: "Codex Desktop",
      })
      .taskStarted("t1")
      .turnContext({ model: "gpt-5.3-codex", turnId: "t1" })
      .developer("collaboration mode")
      .user(
        [
          { text: AGENTS_MD, kind: "agents_md.instructions" },
          { text: ENVIRONMENT, kind: "environments.environment_context" },
        ],
        { kinds: true },
      )
      .user(
        [
          { text: "이 스크린샷의 버그를 고쳐 줘" },
          { image: PNG },
          { text: "<recommended_plugins>x</recommended_plugins>", kind: "plugins.recommendations" },
        ],
        { kinds: true, turnId: "t1" },
      )
      .localShell("call_a", ["git", "status"])
      .output("call_a", "clean")
      .webSearch("zstd streaming node")
      .call("exec_command", { cmd: "bun test" }, "call_b")
      .output("call_b", "1 fail")
      .compacted("", [
        userItem([{ text: AGENTS_MD, kind: "agents_md.instructions" }], { kinds: true }),
        userItem("이 스크린샷의 버그를 고쳐 줘", { kinds: true }),
        compactionItem(),
      ])
      .contextCompacted()
      .assistant("테스트 하나가 실패합니다.", "commentary")
      .turnAborted("t1")
      .user("계속", { kinds: true })
      .lines()
    expect(parse(lines)).toEqual({
      source: {
        kind: "codex",
        id: threadId(140),
        rootID: START.rootID,
        path: START.path,
        versions: ["0.140.2"],
        app: "vscode",
        cwds: [VERBATIM_CWD],
        title: "이 스크린샷의 버그를 고쳐 줘",
        firstPrompt: "이 스크린샷의 버그를 고쳐 줘",
        models: [{ provider: "openai", id: "gpt-5.3-codex" }],
        createdAt: T0,
        updatedAt: at(15),
        bytes: 1000,
        subagent: false,
        live: false,
      },
      turns: [
        {
          index: 0,
          time: at(5),
          user: { text: "이 스크린샷의 버그를 고쳐 줘", images: [PNG_IMAGE] },
          steps: [
            {
              type: "tool",
              name: "local_shell",
              input: { type: "exec", command: ["git", "status"] },
              output: { text: "clean", error: false },
              time: at(6),
            },
            {
              type: "tool",
              name: "web_search",
              input: { type: "search", query: "zstd streaming node" },
              output: { text: "", error: false },
              time: at(8),
            },
            {
              type: "tool",
              name: "exec_command",
              input: { cmd: "bun test" },
              output: { text: "1 fail", error: false },
              time: at(9),
            },
            { type: "text", text: "테스트 하나가 실패합니다.", model: "gpt-5.3-codex", time: at(13) },
          ],
          end: "interrupted",
        },
        { index: 1, time: at(15), user: { text: "계속", images: [] }, steps: [], end: "open" },
      ],
      checkpoints: [
        {
          // Mid-turn: after the three tool steps, before the assistant's text of the same turn.
          at: { turn: 0, step: 3, source: { ordinal: 11 } },
          kind: "codex-remote",
          recent: [{ role: "user", text: "이 스크린샷의 버그를 고쳐 줘" }],
        },
      ],
      children: [],
      dropped: { developerMessage: 1, injectedContext: 3, remoteCompaction: 1 },
    })
  })

  test("0.153 paginated: ordinals, item_completed exit codes and diffs, tool search, a sub-agent, rollback, unknown records", () => {
    const lines = rollout()
      .meta({ id: threadId(153), cliVersion: "0.153.1", branch: "feature" })
      .worldState()
      .taskStarted("u1")
      .turnContext({ model: "gpt-5.5", turnId: "u1" })
      .developer("permissions")
      .user([{ text: ENVIRONMENT, kind: "environments.environment_context" }], { kinds: true })
      .user("빌드 스크립트를 고쳐 줘", { kinds: true, turnId: "u1" })
      .reasoning()
      .call("exec_command", { cmd: "bun run build" }, "c1")
      .output("c1", "error TS2339")
      .commandDone("c1", 2, "error TS2339")
      .custom("apply_patch", "*** Begin Patch\n*** Add File: b.ts\n+export {}\n*** End Patch", "c2")
      .customOutput("c2", "Success")
      .fileChangeDone("c2", {
        "C:\\work\\proj\\b.ts": { type: "add", content: "export {}\n", unified_diff: null, move_path: null },
      })
      .toolSearch("c3", "browser")
      .toolSearchOutput("c3", "playwright", ["browser_click", "browser_type"])
      .call("spawn_agent", { message: "check docs" }, "c4")
      .output("c4", "spawned")
      .subAgentDone(threadId(1531), "/root/docs")
      .subAgentEvent(threadId(1531), "/root/docs")
      .agentMessage("/root/docs", "/root", "Docs say use --minify", true)
      .tokenUsage("gpt-5.5-2026-09-01")
      .assistant("빌드를 고쳤습니다.")
      .tokenCount(1200, 300, 800)
      .taskComplete("u1")
      .taskStarted("u2")
      .user("상태를 봐 줘", { kinds: true, turnId: "u2" })
      .call("exec_command", { cmd: "git status" }, "c5")
      .taskComplete("u2")
      .taskStarted("u3")
      .user("다시 해 줘", { kinds: true, turnId: "u3" })
      .assistant("네")
      .taskComplete("u3")
      .rolledBack(1)
      .unknown("future_record")
      .item({ type: "future_item", x: 1 })
      .raw({
        timestamp: new Date(at(36)).toISOString(),
        type: "event_msg",
        payload: { type: "warning", message: "w" },
        ordinal: 36,
        extra_field: 1,
      })
      .lines()
    expect(parse(lines)).toEqual({
      source: {
        kind: "codex",
        id: threadId(153),
        rootID: START.rootID,
        path: START.path,
        versions: ["0.153.1"],
        app: "cli",
        cwds: [VERBATIM_CWD],
        branch: "feature",
        title: "빌드 스크립트를 고쳐 줘",
        firstPrompt: "빌드 스크립트를 고쳐 줘",
        models: [{ provider: "openai", id: "gpt-5.5" }],
        createdAt: T0,
        updatedAt: at(36),
        bytes: 1000,
        subagent: false,
        live: false,
      },
      turns: [
        {
          index: 0,
          time: at(6),
          user: { text: "빌드 스크립트를 고쳐 줘", images: [] },
          steps: [
            {
              type: "tool",
              name: "exec_command",
              input: { cmd: "bun run build" },
              output: { text: "error TS2339", error: false },
              exit: 2,
              time: at(8),
            },
            {
              type: "tool",
              name: "apply_patch",
              input: "*** Begin Patch\n*** Add File: b.ts\n+export {}\n*** End Patch",
              output: { text: "Success", error: false },
              diff: [
                {
                  file: "C:\\work\\proj\\b.ts",
                  patch: "@@ -0,0 +1,1 @@\n+export {}",
                  additions: 1,
                  deletions: 0,
                  status: "added",
                },
              ],
              time: at(11),
            },
            {
              type: "tool",
              name: "tool_search",
              input: { query: "browser", limit: 5 },
              output: { text: "playwright.browser_click, playwright.browser_type", error: false },
              time: at(14),
            },
            {
              type: "tool",
              name: "spawn_agent",
              input: { message: "check docs" },
              output: { text: "spawned", error: false },
              child: threadId(1531),
              time: at(16),
            },
            { type: "note", text: "/root/docs → /root: Docs say use --minify", time: at(20) },
            { type: "text", text: "빌드를 고쳤습니다.", model: "gpt-5.5", time: at(22) },
          ],
          end: "completed",
        },
        {
          index: 1,
          time: at(26),
          user: { text: "상태를 봐 줘", images: [] },
          steps: [
            {
              type: "tool",
              name: "exec_command",
              input: { cmd: "git status" },
              // An unpaired call: the record ends before its output (09 §2.5).
              output: { text: CodexTranscript.INTERRUPTED, error: true },
              time: at(27),
            },
          ],
          end: "completed",
        },
      ],
      checkpoints: [],
      children: [{ id: threadId(1531), agent: "/root/docs", at: { turn: 0, step: 4 } }],
      dropped: {
        developerMessage: 1,
        injectedContext: 1,
        encryptedReasoning: 2,
        rolledBack: 1,
        unknownRecord: 2,
        unknownField: 1,
      },
      usage: { input: 1200, output: 300, cached: 800 },
    })
  })
})

describe("injected context (09 §2.5)", () => {
  test("with kinds: user.* items stay per item, other kinds go, a message left empty is dropped", () => {
    const info = parse(
      rollout()
        .meta({ id: threadId(1) })
        .user([{ text: "<environment_context>…</environment_context>", kind: "environments.environment_context" }], {
          kinds: true,
        })
        .user([{ text: "first" }, { image: PNG }, { text: "AGENTS", kind: "agents_md.instructions" }], { kinds: true })
        .user([{ image: PNG }], { kinds: true })
        .lines(),
    )
    expect(info.turns.map((turn) => [turn.user.text, turn.user.images.length])).toEqual([
      ["first", 1],
      ["", 1],
    ])
    expect(info.dropped.injectedContext).toBe(2)
  })

  test("without kinds: the leading-tag deny list, per text item, after leading whitespace", () => {
    const denied = [
      ENVIRONMENT,
      AGENTS_MD,
      "<user_instructions>\nbe brief\n</user_instructions>",
      "<recommended_plugins>…</recommended_plugins>",
      "  <skill>\nname: x\n</skill>",
      "<turn_aborted>\nThe user interrupted.\n</turn_aborted>",
      localSummary("old summary", PREFIX),
    ]
    const builder = rollout({ ordinals: false }).meta({ id: threadId(2), historyMode: "legacy" })
    denied.forEach((text) => builder.user(text))
    builder.user([{ text: ENVIRONMENT }, { text: "real request" }])
    const info = parse(builder.lines())
    expect(info.turns.map((turn) => turn.user.text)).toEqual(["real request"])
    expect(info.dropped.injectedContext).toBe(denied.length + 1)
    expect(denied.every((text) => CodexTranscript.injected(text))).toBe(true)
    expect(CodexTranscript.injected("please read # AGENTS.md instructions")).toBe(false)
  })
})

describe("compaction (09 §2.5)", () => {
  test("a local summary loses SUMMARY_PREFIX; a remote one keeps the user requests minus summary and start context", () => {
    expect(CodexTranscript.stripSummaryPrefix(`${PREFIX}\nthe summary\n`)).toBe("the summary")
    expect(CodexTranscript.stripSummaryPrefix("no prefix here")).toBe("no prefix here")
    const info = parse(
      rollout()
        .meta({ id: threadId(3) })
        .user("one")
        .compacted("", [
          userItem([{ text: ENVIRONMENT, kind: "environments.environment_context" }], { kinds: true }),
          userItem("one", { kinds: true }),
          { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
          compactionItem(),
          compactionItem(),
        ])
        .user("two")
        .compacted(localSummary("S2", PREFIX), [userItem("one"), userItem("two"), userItem(localSummary("S2", PREFIX))])
        .lines(),
    )
    expect(info.checkpoints).toEqual([
      {
        at: { turn: 0, step: 0, source: { ordinal: 2 } },
        kind: "codex-remote",
        recent: [{ role: "user", text: "one" }],
      },
      {
        at: { turn: 1, step: 0, source: { ordinal: 4 } },
        kind: "foreign",
        summary: "S2",
        recent: [
          { role: "user", text: "one" },
          { role: "user", text: "two" },
        ],
      },
    ])
    expect(info.dropped.remoteCompaction).toBe(2)
  })

  test("a compaction before any turn sits at turn 0, step 0", () => {
    const info = parse(
      rollout()
        .meta({ id: threadId(4) })
        .compacted("", [compactionItem()])
        .user("x")
        .lines(),
    )
    expect(info.checkpoints[0].at).toEqual({ turn: 0, step: 0, source: { ordinal: 1 } })
    expect(info.turns).toHaveLength(1)
  })
})

describe("forks and sub-agents (09 §2.5)", () => {
  test("the second session_meta is the parent; records before subagent_history_start_ordinal are inherited", () => {
    const parent = threadId(10)
    const info = parse(
      rollout()
        .meta({
          id: threadId(11),
          source: spawnSource(parent, "/root/docs"),
          threadSource: "subagent",
          subagentStart: 4,
        })
        .meta({ id: parent })
        .compacted("", [userItem("부모의 요청"), compactionItem()])
        .user("부모의 요청")
        .user("문서를 확인해 줘")
        .assistant("확인했습니다")
        .lines(),
    )
    expect(info.source).toMatchObject({ id: threadId(11), subagent: true, parentID: parent, app: "subagent" })
    expect(info.turns.map((turn) => turn.user.text)).toEqual(["문서를 확인해 줘"])
    expect(info.checkpoints).toEqual([])
    expect(info.dropped).toEqual({ inheritedContext: 2 })
  })

  test("a fork without a start ordinal keeps its copied history and names its parent", () => {
    const info = parse(
      rollout()
        .meta({ id: threadId(12), forkedFrom: threadId(10) })
        .meta({ id: threadId(10) })
        .user("copied")
        .user("own")
        .lines(),
    )
    expect(info.source.parentID).toBe(threadId(10))
    expect(info.source.subagent).toBe(false)
    expect(info.turns.map((turn) => turn.user.text)).toEqual(["copied", "own"])
  })

  test("a history_base prefix: lines marked base are read first and stop at end_ordinal_exclusive", () => {
    const head: CodexTranscript.Head = {
      id: threadId(13),
      subagent: false,
      base: { rolloutID: threadId(13), endOrdinal: 3 },
    }
    const run = CodexTranscript.parser({ ...START, head })
    const base = rollout()
      .meta({ id: threadId(13) })
      .user("before")
      .assistant("a")
      .user("cut off")
      .lines()
    base.forEach((line, index) => run.push(line, { line: index, base: true }))
    const own = rollout({ firstOrdinal: 3 })
      .meta({ id: threadId(13), base: { rolloutId: threadId(13), endOrdinal: 3, endByteOffset: 10 } })
      .user("after")
      .lines()
    own.forEach((line, index) => run.push(line, { line: index }))
    expect(run.info().turns.map((turn) => turn.user.text)).toEqual(["before", "after"])
  })
})

describe("rollback, turn ends and pairing", () => {
  test("thread_rolled_back removes the newest N of Codex's turns (by turn id, else one per request) and their checkpoints", () => {
    const info = parse(
      rollout({ ordinals: false })
        .meta({ id: threadId(20), historyMode: "legacy" })
        .user("a")
        .user("b")
        .compacted("", [compactionItem()])
        .user("c")
        .rolledBack(2)
        .user("d")
        .lines(),
    )
    expect(info.turns.map((turn) => [turn.index, turn.user.text])).toEqual([
      [0, "a"],
      [1, "d"],
    ])
    expect(info.checkpoints).toEqual([])
    expect(info.dropped.rolledBack).toBe(2)
  })

  test("a steering message inside one Codex turn is rolled back with it", () => {
    const info = parse(
      rollout()
        .meta({ id: threadId(21) })
        .taskStarted("u1")
        .user("first", { turnId: "u1" })
        .taskStarted("u2")
        .user("second", { turnId: "u2" })
        .user("steer", { turnId: "u2" })
        .rolledBack(1)
        .lines(),
    )
    expect(info.turns.map((turn) => turn.user.text)).toEqual(["first"])
    expect(info.dropped.rolledBack).toBe(2)
  })

  test("an error stays the turn's end; output forms; namespaced and non-JSON calls; image generation", () => {
    const info = parse(
      rollout()
        .meta({ id: threadId(22) })
        .user("go")
        .call("search", { q: 1 }, "n1", "apps")
        .output("n1", [
          { type: "input_text", text: "found" },
          { type: "input_image", image_url: PNG },
        ])
        .item({ type: "function_call", name: "raw", arguments: "{not json", call_id: "n2" })
        .output("n2", { content: "denied", success: false })
        .imageGeneration("a cat")
        .error("stream failed")
        .taskComplete("x")
        .lines(),
    )
    expect(info.turns[0].steps).toEqual([
      {
        type: "tool",
        name: "apps.search",
        input: { q: 1 },
        output: { text: "found\n[image: image/png, 1 KB]", error: false },
        time: at(2),
      },
      { type: "tool", name: "raw", input: "{not json", output: { text: "denied", error: true }, time: at(4) },
      {
        type: "tool",
        name: "image_generation",
        input: { prompt: "a cat" },
        output: { text: "[image generated]", error: false },
        time: at(6),
      },
    ])
    expect(info.turns[0].end).toBe("error")
  })

  test("steps before the first request open a turn without one; missing times become monotonic", () => {
    const records = rollout()
      .meta({ id: threadId(23) })
      .assistant("hello")
      .user("x")
      .records()
    const lines = records.map((record, index) =>
      JSON.stringify(index === 2 ? { ...record, timestamp: undefined } : record),
    )
    const info = parse(lines)
    expect(info.turns.map((turn) => [turn.user.text, turn.time])).toEqual([
      ["", at(1)],
      ["x", at(1) + 1],
    ])
  })

  test("bad lines: not JSON is decodeFailed, a torn line tornLine, an unknown envelope field unknownField", () => {
    const run = CodexTranscript.parser(START)
    run.push(
      rollout()
        .meta({ id: threadId(24) })
        .lines()[0],
      { line: 0 },
    )
    run.push("{oops", { line: 1 })
    run.push('{"timestamp":"2026-10-08T09:00:00.000Z","type":"response_item","payload":{"type":"mess', {
      line: 2,
      torn: true,
    })
    run.push(JSON.stringify({ type: "world_state", payload: {}, extra: 1, more: 2 }), { line: 3 })
    run.drop("oversizedLine")
    expect(run.info().dropped).toEqual({ decodeFailed: 1, tornLine: 1, unknownField: 2, oversizedLine: 1 })
  })

  test("a known model provider pair moves to the end when it is used again; cwds compare without the \\\\?\\ prefix", () => {
    const info = parse(
      rollout()
        .meta({ id: threadId(25) })
        .turnContext({ model: "a", cwd: "C:\\work\\proj" })
        .turnContext({ model: "b", provider: "azure", cwd: "C:\\work\\other" })
        .turnContext({ model: "a" })
        .lines(),
    )
    expect(info.source.models).toEqual([
      { provider: "azure", id: "b" },
      { provider: "openai", id: "a" },
    ])
    expect(info.source.cwds).toEqual([VERBATIM_CWD, "C:\\work\\other"])
  })

  test("live: written in the last two minutes; the index title wins over the first request", () => {
    const lines = rollout()
      .meta({ id: threadId(26) })
      .user("first request")
      .lines()
    expect(parse(lines, { mtimeMs: START.now - 60_000 }).source.live).toBe(true)
    expect(parse(lines, { mtimeMs: START.now - 180_000 }).source.live).toBe(false)
    expect(parse(lines, { title: "named" }).source).toMatchObject({ title: "named", firstPrompt: "first request" })
  })
})

describe("head (09 §2.3)", () => {
  test("session_meta fields and the first real request, skipping injected and inherited records", () => {
    const lines = rollout()
      .meta({
        id: threadId(30),
        source: spawnSource(threadId(1)),
        subagentStart: 3,
        branch: "b",
        cliVersion: "0.153.0",
      })
      .user(ENVIRONMENT)
      .user("inherited request")
      .user("own request")
      .lines()
    expect(CodexTranscript.head({ lines })).toEqual({
      id: threadId(30),
      time: T0,
      cwd: VERBATIM_CWD,
      cliVersion: "0.153.0",
      originator: "codex-tui",
      app: "subagent",
      subagent: true,
      parentID: threadId(1),
      agent: "/root/worker",
      provider: "openai",
      historyMode: "paginated",
      subagentStart: 3,
      branch: "b",
      firstPrompt: "own request",
    })
  })

  test("a first line cut by the window still gives its leading fields; other first lines are not Codex", () => {
    const line = rollout()
      .meta({ id: threadId(31), source: "exec", instructions: 100_000 })
      .lines()[0]
    const partial = line.slice(0, 64 * 1024)
    expect(CodexTranscript.head({ lines: [], partial })).toMatchObject({
      id: threadId(31),
      cwd: VERBATIM_CWD,
      cliVersion: "0.153.0",
      app: "exec",
      subagent: false,
    })
    const sub = rollout()
      .meta({ id: threadId(32), source: spawnSource(threadId(1)), instructions: 100_000 })
      .lines()[0]
    expect(CodexTranscript.head({ lines: [], partial: sub.slice(0, 64 * 1024) })).toMatchObject({
      subagent: true,
      app: "subagent",
    })
    expect(CodexTranscript.head({ lines: [JSON.stringify({ type: "user", message: {} })] })).toBeUndefined()
    expect(CodexTranscript.head({ lines: ["not json"] })).toBeUndefined()
  })

  test("firstLine: the first non-empty line, 120 whole characters", () => {
    expect(CodexTranscript.firstLine("\n\n  hello  \nworld")).toBe("hello")
    const long = "가".repeat(130)
    expect(CodexTranscript.firstLine(long)).toBe("가".repeat(120))
    expect(CodexTranscript.firstLine("😀".repeat(121))).toBe("😀".repeat(120))
    expect(CodexTranscript.firstLine(" \n ")).toBeUndefined()
  })

  test("sourceKind reads the rollout object and the state DB text", () => {
    expect(CodexTranscript.sourceKind("cli")).toEqual({ app: "cli", subagent: false })
    expect(CodexTranscript.sourceKind("exec")).toEqual({ app: "exec", subagent: false })
    expect(CodexTranscript.sourceKind(JSON.stringify(spawnSource(threadId(1), "/root/a")))).toEqual({
      app: "subagent",
      subagent: true,
      parentID: threadId(1),
      agent: "/root/a",
    })
    expect(CodexTranscript.sourceKind({ subagent: { other: "guardian" } })).toEqual({ app: "subagent", subagent: true })
    expect(CodexTranscript.sourceKind({ internal: "memory_consolidation" })).toEqual({
      app: "internal",
      subagent: true,
    })
    expect(CodexTranscript.sourceKind({ custom: "my-ide" })).toEqual({ app: "my-ide", subagent: false })
    expect(CodexTranscript.sourceKind("cli", "subagent")).toEqual({ app: "cli", subagent: true })
    expect(CodexTranscript.sourceKind(undefined)).toEqual({ subagent: false })
  })
})
