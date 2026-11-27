import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SessionMessage } from "@opencode/schema/session-message"
import { OwnImport } from "@own/protocol/rpc-import"
import { Token } from "@own/protocol/token"
import { Result, Schema } from "effect"
import { View } from "../../src/render/view.js"
import { ClaudeSource } from "../../src/sources/claude.js"
import { CodexStore } from "../../src/sources/codex.js"
import { Paths } from "../../src/sources/paths.js"
import { CodexTranscript } from "../../src/transcript/codex.js"
import type { Transcript } from "../../src/transcript/ir.js"
import {
  CWD,
  IDS,
  MODEL,
  SUMMARY_BODY,
  abandoned,
  afterTool,
  agents,
  basic,
  notices,
  sessionFolder,
  write,
} from "../fixtures/claude.js"
import {
  PNG,
  T0,
  compactionItem,
  localSummary,
  rollout,
  spawnSource,
  threadId,
  userItem,
  writeRollout,
  type RolloutRecord,
} from "../fixtures/codex.js"
import { claudeFolder, codexRollout, fixture, writeJsonl, writeText, type Fixture } from "../fixtures/make.js"
import { start } from "../support/guard.js"

const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function make() {
  const item = await fixture({ under: "한글 #폴더" })
  fixtures.push(item)
  const roots = Paths.defaults({ options: { roots: { codex: [item.codex], claude: [item.claude] } } })
  return { item, codex: roots[0], claude: roots[1] }
}

const decodeRef = Schema.decodeUnknownSync(OwnImport.SourceRef)
const decodeMessage = Schema.decodeUnknownResult(SessionMessage.Info)
const at = (seconds: number) => T0 + seconds * 1000
const VIEW = View.VIEW_KEY
const place = (turn: number) => ({ [VIEW]: { turn } })
const range = (count: number) => Array.from({ length: count }, (_, index) => index)

async function codexTarget(
  root: Paths.Root,
  id: string,
  records: ReadonlyArray<unknown>,
  input: { readonly zst?: boolean } = {},
): Promise<View.CodexTarget> {
  const written = await writeRollout(root.directory, { id, records, zst: input.zst })
  const file = await CodexStore.resolve(root, written)
  if (file === undefined) throw new Error(`no rollout ${written}`)
  return { kind: "codex", ref: decodeRef({ kind: "codex", rootID: root.rootID, id }), root, file }
}

async function claudeTarget(root: Paths.Root, id: string): Promise<View.ClaudeTarget> {
  const listed = await ClaudeSource.conversations(root, claudeFolder(CWD))
  if (!listed.ok) throw new Error(listed.reason)
  const conversation = listed.value.find((item) => item.id === id)
  if (conversation === undefined) throw new Error(`no conversation ${id}`)
  return { kind: "claude-code", ref: decodeRef({ kind: "claude-code", rootID: root.rootID, id }), root, conversation }
}

/** A page; every message must decode as `SessionMessage.Info` (what `sessions.read` returns). */
async function page(viewer: View.Viewer, target: View.Target, input: View.ReadInput = {}) {
  const result = await viewer.read(target, input)
  if (!result.ok) throw new Error(`unreadable: ${result.reason}`)
  const failures = result.value.messages.flatMap((message) => {
    const decoded = decodeMessage(message)
    return Result.isFailure(decoded) ? [String(decoded.failure)] : []
  })
  expect(failures).toEqual([])
  return result.value
}

/** Every turn of a conversation, page by page. */
async function all(viewer: View.Viewer, target: View.Target, count = 100) {
  const pages: View.Page[] = []
  const next = async (from: number): Promise<View.Page[]> => {
    const value = await page(viewer, target, { from, count })
    pages.push(value)
    return value.next === undefined ? pages : next(value.next)
  }
  return (await next(0)).flatMap((value) => value.messages)
}

/** The same conversation parsed whole by the source reader and rendered turn by turn. */
async function whole(target: View.CodexTarget) {
  const read = await CodexStore.transcript(target.root, target.file)
  if (!read.ok) throw new Error(read.reason)
  return read.value.info
}

function rendered(target: View.Target, info: Transcript.Info, model?: string) {
  return info.turns.flatMap((turn) =>
    View.render(
      { ref: target.ref, ...(model === undefined ? {} : { model }) },
      turn,
      info.checkpoints.filter((checkpoint) => checkpoint.at.turn === turn.index),
    ),
  )
}

/** Messages without their ids (they hash the fixture's temp root). */
function strip(messages: ReadonlyArray<View.Message>) {
  const omit = (value: object) => Object.fromEntries(Object.entries(value).filter((entry) => entry[0] !== "id"))
  return messages.map((message) =>
    message.type === "assistant" ? { ...omit(message), content: message.content.map(omit) } : omit(message),
  )
}

const PATCH = "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch"

/**
 * Two turns with every view element: a user image, a reasoning summary, `exec_command` with its exit code, a mid-turn
 * remote compaction, `apply_patch` with a FileChange diff, a web search, an MCP tool with no v2 renderer, another
 * agent's hand-off, the answer; then a failed `shell` call in an interrupted turn and an unknown record.
 */
function main(id: string) {
  return rollout()
    .meta({ id, cliVersion: "0.153.0", branch: "main" })
    .taskStarted("u1")
    .turnContext({ model: "gpt-5.5", turnId: "u1" })
    .user([{ text: "설치기 정리해 줘" }, { image: PNG }], { kinds: true, turnId: "u1" })
    .reasoning({ summary: "Looking at the installer" })
    .call("exec_command", { cmd: "bun test", workdir: "C:\\work\\proj" }, "c1")
    .output("c1", "12 pass")
    .commandDone("c1", 0)
    .compacted("", [userItem("설치기 정리해 줘"), compactionItem()])
    .custom("apply_patch", PATCH, "c2")
    .customOutput("c2", "Success. Updated the following files:\nM a.ts")
    .fileChangeDone("c2", {
      "C:\\work\\proj\\a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: null },
    })
    .webSearch("bun zstd")
    .call("lookup", { q: "docs" }, "c3", "mcp__docs")
    .output("c3", "doc text")
    .agentMessage("/root/docs", "/root", "Docs say use --minify")
    .assistant("정리했습니다.")
    .taskComplete("u1")
    .taskStarted("u2")
    .turnContext({ model: "gpt-5.5", turnId: "u2" })
    .user("이제 커밋해 줘", { kinds: true, turnId: "u2" })
    .call("shell", { command: ["bash", "-lc", "git commit -m fix"] }, "c4")
    .output("c4", { content: "nothing to commit", success: false })
    .assistant("커밋할 것이 없습니다.")
    .turnAborted("u2")
    .unknown("future_record")
    .records()
}

const MAIN_MODEL = { id: "gpt-5.5", providerID: "codex-cli" }

const MAIN_VIEW = [
  {
    type: "user",
    text: "설치기 정리해 줘",
    files: [{ data: PNG.slice("data:image/png;base64,".length), mime: "image/png", source: { type: "inline" } }],
    time: { created: at(3) },
    metadata: place(0),
  },
  {
    type: "assistant",
    agent: "build",
    model: MAIN_MODEL,
    content: [
      { type: "reasoning", text: "Looking at the installer", time: { created: at(4) } },
      {
        type: "tool",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "bun test", workdir: "C:\\work\\proj" },
          content: [{ type: "text", text: "12 pass" }],
          metadata: { original: "exec_command", exit: 0 },
        },
        time: { created: at(5), completed: at(5) },
      },
    ],
    finish: "tool-calls",
    time: { created: at(4), completed: at(5) },
    metadata: place(0),
  },
  {
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "",
    time: { created: at(5) },
    metadata: { recent: "[User]: 설치기 정리해 줘", [VIEW]: { turn: 0, step: 2, kind: "codex-remote", requests: 1 } },
  },
  {
    type: "assistant",
    agent: "build",
    model: MAIN_MODEL,
    content: [
      {
        type: "tool",
        name: "patch",
        state: {
          status: "completed",
          input: { patchText: PATCH },
          content: [{ type: "text", text: "Success. Updated the following files:\nM a.ts" }],
          metadata: {
            original: "apply_patch",
            files: [
              {
                file: "C:\\work\\proj\\a.ts",
                patch: "@@ -1 +1 @@\n-a\n+b\n",
                additions: 1,
                deletions: 1,
                status: "modified",
              },
            ],
          },
        },
        time: { created: at(9), completed: at(9) },
      },
      {
        type: "tool",
        name: "websearch",
        state: {
          status: "completed",
          input: { query: "bun zstd" },
          content: [{ type: "text", text: "" }],
          metadata: { original: "web_search" },
        },
        time: { created: at(12), completed: at(12) },
      },
      {
        type: "tool",
        name: "mcp__docs.lookup",
        state: { status: "completed", input: { q: "docs" }, content: [{ type: "text", text: "doc text" }] },
        time: { created: at(13), completed: at(13) },
      },
    ],
    finish: "tool-calls",
    time: { created: at(9), completed: at(13) },
    metadata: place(0),
  },
  {
    type: "synthetic",
    text: "/root/docs → /root: Docs say use --minify",
    description: "/root/docs → /root: Docs say use --minify",
    time: { created: at(15) },
    metadata: place(0),
  },
  {
    type: "assistant",
    agent: "build",
    model: MAIN_MODEL,
    content: [{ type: "text", text: "정리했습니다." }],
    finish: "stop",
    time: { created: at(16), completed: at(16) },
    metadata: place(0),
  },
  { type: "idle", outcome: "succeeded", time: { created: at(16) }, metadata: place(0) },
  { type: "user", text: "이제 커밋해 줘", time: { created: at(20) }, metadata: place(1) },
  {
    type: "assistant",
    agent: "build",
    model: MAIN_MODEL,
    content: [
      {
        type: "tool",
        name: "shell",
        state: {
          status: "error",
          input: { command: "git commit -m fix" },
          error: { type: "tool", message: "nothing to commit" },
        },
        time: { created: at(21), completed: at(21) },
      },
      { type: "text", text: "커밋할 것이 없습니다." },
    ],
    finish: "stop",
    time: { created: at(21), completed: at(23) },
    metadata: place(1),
  },
  { type: "idle", outcome: "interrupted", time: { created: at(23) }, metadata: place(1) },
]

/** The tokens of the main fixture: what the model saw, by the P-016 rule. */
const MAIN_TOKENS = [
  "설치기 정리해 줘",
  JSON.stringify({ cmd: "bun test", workdir: "C:\\work\\proj" }),
  "12 pass",
  PATCH,
  "Success. Updated the following files:\nM a.ts",
  JSON.stringify({ type: "search", query: "bun zstd" }),
  "",
  JSON.stringify({ q: "docs" }),
  "doc text",
  "/root/docs → /root: Docs say use --minify",
  "정리했습니다.",
  "이제 커밋해 줘",
  JSON.stringify({ command: ["bash", "-lc", "git commit -m fix"] }),
  "nothing to commit",
  "커밋할 것이 없습니다.",
].reduce((sum, text) => sum + Token.estimate(text), 0)

describe("view pages (09 §3, IG2)", () => {
  test("Codex: renderer names, the original name for GenericTool, diffs, reasoning, notes, a mid-turn marker, ends", async () => {
    const { item, codex } = await make()
    const target = await codexTarget(codex, threadId(1), main(threadId(1)))
    const guard = await start([item.codex])
    const value = await page(View.viewer(), target)
    expect(await guard.stop()).toEqual([])
    expect(strip(value.messages)).toEqual(MAIN_VIEW)
    expect(value.outlineComplete).toBe(true)
    expect(value.next).toBeUndefined()
    expect(value.outline).toEqual({
      turns: [
        { index: 0, firstLine: "설치기 정리해 줘", time: at(3) },
        { index: 1, firstLine: "이제 커밋해 줘", time: at(20) },
      ],
      checkpoints: [{ turn: 0, step: 2, kind: "codex-remote" }],
      children: [],
      rolledBack: 0,
      branches: 0,
      tokens: MAIN_TOKENS,
      unknownRecords: 1,
    })
    // Every assistant message is complete; ids are deterministic and unique.
    expect(
      value.messages.filter((message) => message.type === "assistant").map((message) => message.time.completed),
    ).not.toContain(undefined)
    const ids = value.messages.map((message) => message.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^msg_[0-9a-f]{12}_\d+_\d+$/.test(id))).toBe(true)
    expect((await page(View.viewer(), target)).messages.map((message) => message.id)).toEqual(ids)
  })

  test("Claude Code: Bash, Edit with its structuredPatch diff, a user image, readable thinking, merged split answers", async () => {
    const { item, claude } = await make()
    const fixture = basic("2.1.288")
    await write(item.claude, fixture.input, fixture.session)
    const value = await page(View.viewer(), await claudeTarget(claude, IDS.basic))
    const model = { id: MODEL, providerID: "claude-code" }
    expect(strip(value.messages)).toMatchObject([
      {
        type: "user",
        text: "설치기를 고쳐 줘",
        files: [{ data: "AAECAwQF", mime: "image/png", source: { type: "inline" } }],
      },
      {
        type: "assistant",
        model,
        finish: "stop",
        content: [
          { type: "reasoning", text: "Look at the installer first." },
          { type: "text", text: "Let me look." },
          {
            type: "tool",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "bun test" },
              content: [{ type: "text", text: "3 pass" }],
              metadata: { original: "Bash", exit: 0 },
            },
          },
          {
            type: "tool",
            name: "edit",
            state: {
              status: "completed",
              input: { path: "C:\\work\\proj\\a.ts", oldString: "a", newString: "b" },
              metadata: {
                original: "Edit",
                files: [
                  {
                    file: "C:\\work\\proj\\a.ts",
                    patch: "@@ -1,1 +1,1 @@\n-a\n+b\n",
                    additions: 1,
                    deletions: 1,
                    status: "modified",
                  },
                ],
              },
            },
          },
          { type: "text", text: "Fixed.\n\nThe tests pass." },
        ],
      },
      { type: "idle", outcome: "succeeded" },
    ])
    expect(value.outline.turns.map((turn) => turn.firstLine)).toEqual(["설치기를 고쳐 줘"])
  })

  test("Claude Code: a compaction after a tool result sits between the steps of its turn, with the cleaned summary", async () => {
    const { item, claude } = await make()
    const fixture = afterTool("2.1.288")
    await write(item.claude, fixture.input, fixture.session)
    const value = await page(View.viewer(), await claudeTarget(claude, IDS.afterTool))
    const turn = strip(value.messages).filter((message) => message.metadata?.[VIEW]?.turn === 1)
    expect(turn.map((message) => message.type)).toEqual(["user", "assistant", "compaction", "assistant", "idle"])
    expect(turn[2]).toMatchObject({
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: SUMMARY_BODY,
      metadata: {
        recent: '[Assistant tool call]: Bash({"command":"bun test"})\n[Tool result]: 2 pass',
        [VIEW]: { turn: 1, step: 1, kind: "foreign", requests: 0 },
      },
    })
    expect(value.outline.checkpoints).toEqual([{ turn: 1, step: 1, kind: "foreign" }])
  })

  test("Claude Code: sub-agents as subagent parts linking their conversation; children in the outline", async () => {
    const { item, claude } = await make()
    await agents(item.claude, "2.1.288")
    const target = await claudeTarget(claude, IDS.agents)
    const value = await page(View.viewer(), target)
    const child = (agent: string) =>
      decodeRef({ kind: "claude-code", rootID: claude.rootID, id: `${IDS.agents}:${agent}` })
    expect(strip(value.messages)[1]).toMatchObject({
      type: "assistant",
      content: [
        {
          name: "subagent",
          state: {
            input: { agent: "Explore", description: "explore", prompt: "map it" },
            metadata: { original: "Agent", child: child("a1b2") },
          },
        },
        {
          name: "subagent",
          state: {
            input: { agent: "Plan", description: "plan", prompt: "plan it" },
            metadata: { original: "Agent", child: child("c3d4") },
          },
        },
        { type: "text", text: "Explored and planned." },
      ],
    })
    // The agent file whose id is no token is not linked.
    expect(value.outline.children).toEqual([
      { ref: child("a1b2"), title: "explore", turn: 0 },
      { ref: child("c3d4"), title: "plan", turn: 0 },
    ])
  })

  test("Claude Code: a <persisted-output> preview shows its tool-results file; Grep is grep; a denied call is an error", async () => {
    const { item, claude } = await make()
    const saved = "C:\\Users\\fixture\\.claude\\projects\\C--work-proj\\tool-results\\toolu_FAKE71.txt"
    const fixture = notices("2.1.288", saved)
    await write(item.claude, fixture.input, fixture.session)
    await writeText(
      path.join(sessionFolder(item.claude, CWD, IDS.notices), "tool-results", "toolu_FAKE71.txt"),
      "full grep output\nline 2",
    )
    const guard = await start([item.claude])
    const value = await page(View.viewer(), await claudeTarget(claude, IDS.notices))
    expect(await guard.stop()).toEqual([])
    expect(strip(value.messages)[1]).toMatchObject({
      content: [
        {
          name: "grep",
          state: {
            status: "completed",
            input: { pattern: "error" },
            content: [{ type: "text", text: "full grep output\nline 2" }],
            metadata: { original: "Grep", persisted: "toolu_FAKE71.txt" },
          },
        },
        { name: "shell", state: { status: "error", input: { command: "rm -rf build" } } },
        { name: "ToolSearch", state: { content: [{ type: "text", text: "[tool reference: WebFetch]" }] } },
      ],
    })
    expect(value.messages.at(-1)).toMatchObject({ type: "idle", outcome: "failed" })
  })

  test("Claude Code: abandoned branches are counted in the outline", async () => {
    const { item, claude } = await make()
    const fixture = abandoned("2.1.288")
    await write(item.claude, fixture.input, fixture.session)
    const value = await page(View.viewer(), await claudeTarget(claude, IDS.abandoned))
    expect(value.outline.branches).toBe(1)
    expect(value.outline.turns.map((turn) => turn.firstLine)).toEqual(["first request", "second request, new wording"])
  })
})

describe("renderer mapping (09 §3: the v2 name when the input shape matches)", () => {
  const ref = decodeRef({ kind: "codex", rootID: "codex-0123456789ab", id: threadId(9) })
  const tool = (name: string, input: unknown, extra: Partial<Transcript.ToolStep> = {}) => {
    const turn: Transcript.Turn = {
      index: 0,
      time: T0,
      user: { text: "go", images: [] },
      steps: [{ type: "tool", name, input, output: { text: "ok", error: false }, time: T0, ...extra }],
      end: "completed",
    }
    const message = View.render({ ref }, turn, [])[1]
    if (message?.type !== "assistant" || message.content[0]?.type !== "tool") throw new Error("no tool part")
    const part = message.content[0]
    return { name: part.name, input: part.state.status === "streaming" ? {} : part.state.input }
  }

  test("each original tool and input shape", () => {
    expect(tool("exec_command", { cmd: ["bun", "test"] })).toEqual({ name: "shell", input: { command: "bun test" } })
    expect(tool("shell", { command: ["powershell.exe", "-NoProfile", "-Command", "Get-ChildItem"] })).toEqual({
      name: "shell",
      input: { command: "Get-ChildItem" },
    })
    expect(tool("shell_command", { command: "ls -la", workdir: null })).toEqual({
      name: "shell",
      input: { command: "ls -la" },
    })
    expect(tool("local_shell", { type: "exec", command: ["git", "log", "a b"] })).toEqual({
      name: "shell",
      input: { command: 'git log "a b"' },
    })
    expect(tool("apply_patch", { input: PATCH })).toEqual({ name: "patch", input: { patchText: PATCH } })
    expect(tool("read_file", { file_path: "a.ts", offset: 2, limit: 5 })).toEqual({
      name: "read",
      input: { path: "a.ts", offset: 2, limit: 5 },
    })
    expect(tool("Read", { file_path: "shot.png" })).toEqual({ name: "Read", input: { file_path: "shot.png" } })
    expect(tool("grep_files", { pattern: "x", include: "*.ts" })).toEqual({
      name: "grep",
      input: { pattern: "x", include: "*.ts" },
    })
    expect(tool("Grep", { pattern: "x", path: "src", glob: "*.ts", output_mode: "content" })).toEqual({
      name: "grep",
      input: { pattern: "x", path: "src", include: "*.ts" },
    })
    expect(tool("Glob", { pattern: "**/*.ts" })).toEqual({ name: "glob", input: { pattern: "**/*.ts" } })
    expect(tool("LS", { path: "src" })).toEqual({ name: "list", input: { path: "src" } })
    expect(tool("list_dir", { dir_path: "src" })).toEqual({ name: "list", input: { path: "src" } })
    expect(tool("Write", { file_path: "a.ts", content: "x" })).toEqual({
      name: "write",
      input: { path: "a.ts", content: "x" },
    })
    expect(tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true })).toEqual({
      name: "edit",
      input: { path: "a.ts", oldString: "a", newString: "b", replaceAll: true },
    })
    expect(tool("WebFetch", { url: "https://example.invalid", prompt: "p" })).toEqual({
      name: "webfetch",
      input: { url: "https://example.invalid" },
    })
    expect(tool("web_search", { type: "open_page", url: "https://example.invalid" })).toEqual({
      name: "webfetch",
      input: { url: "https://example.invalid" },
    })
    expect(tool("WebSearch", { query: "q" })).toEqual({ name: "websearch", input: { query: "q" } })
    expect(tool("Task", { description: "d", prompt: "p" })).toEqual({
      name: "subagent",
      input: { agent: "general", description: "d", prompt: "p" },
    })
    // A diff makes MultiEdit a patch; without one it stays generic.
    expect(tool("MultiEdit", { file_path: "a.ts", edits: [] }, { diff: [] })).toEqual({ name: "patch", input: {} })
    expect(tool("MultiEdit", { file_path: "a.ts", edits: [] })).toEqual({
      name: "MultiEdit",
      input: { file_path: "a.ts", edits: [] },
    })
  })

  test("an input that does not fit keeps the original name; free text and lists go under input", () => {
    expect(tool("Bash", { cmd: "ls" })).toEqual({ name: "Bash", input: { cmd: "ls" } })
    expect(tool("Edit", { file_path: "a.ts" })).toEqual({ name: "Edit", input: { file_path: "a.ts" } })
    expect(tool("custom", "free text")).toEqual({ name: "custom", input: { input: "free text" } })
    expect(tool("custom", ["a", 1])).toEqual({ name: "custom", input: { input: ["a", 1] } })
    expect(tool("toString", {})).toEqual({ name: "toString", input: {} })
  })

  test("a call without a result is an interrupted error; a truncated output and a child link are in metadata", () => {
    const turn: Transcript.Turn = {
      index: 3,
      time: T0,
      user: { text: "", images: [{ mime: "image/png", bytes: 2048 }], queued: true },
      steps: [
        { type: "tool", name: "spawn_agent", input: { message: "m" }, child: threadId(4), time: T0 },
        {
          type: "tool",
          name: "lookup",
          input: {},
          output: { text: "cut", error: false, truncatedFrom: 9000 },
          time: T0 + 1,
        },
      ],
      end: "open",
    }
    const messages = View.render({ ref }, turn, [])
    expect(strip(messages)).toEqual([
      {
        type: "user",
        text: "[image: image/png, 2 KB]",
        time: { created: T0 },
        metadata: { [VIEW]: { turn: 3, queued: true } },
      },
      {
        type: "assistant",
        agent: "build",
        model: { id: "unknown", providerID: "codex-cli" },
        content: [
          {
            type: "tool",
            name: "spawn_agent",
            state: {
              status: "error",
              input: { message: "m" },
              error: { type: "tool", message: CodexTranscript.INTERRUPTED },
              metadata: { child: { kind: "codex", rootID: "codex-0123456789ab", id: threadId(4) } },
            },
            time: { created: T0, completed: T0 },
          },
          {
            type: "tool",
            name: "lookup",
            state: {
              status: "completed",
              input: {},
              content: [{ type: "text", text: "cut" }],
              metadata: { truncatedFrom: 9000 },
            },
            time: { created: T0 + 1, completed: T0 + 1 },
          },
        ],
        finish: "tool-calls",
        time: { created: T0, completed: T0 + 1 },
        metadata: place(3),
      },
    ])
  })
})

describe("the turn stream equals the whole parse (IG2, 09 §2.8)", () => {
  const cases: ReadonlyArray<readonly [string, () => ReadonlyArray<RolloutRecord>]> = [
    ["the main fixture", () => main(threadId(30))],
    [
      "a legacy rollback that also removes a compaction",
      () =>
        rollout({ ordinals: false })
          .meta({ id: threadId(31), historyMode: "legacy" })
          .user("a")
          .assistant("A")
          .user("b")
          .compacted("", [compactionItem()])
          .user("c")
          .rolledBack(2)
          .user("d")
          .assistant("D")
          .records(),
    ],
    [
      "a steered turn rolled back by its turn id, a model change, a sub-agent, a local compaction, an open last turn",
      () =>
        rollout()
          .meta({ id: threadId(32) })
          .taskStarted("u1")
          .turnContext({ model: "gpt-5.5", turnId: "u1" })
          .user("first", { turnId: "u1" })
          .assistant("one")
          .taskComplete("u1")
          .taskStarted("u2")
          .user("second", { turnId: "u2" })
          .assistant("two")
          .user("steer", { turnId: "u2" })
          .assistant("three")
          .taskComplete("u2")
          .rolledBack(1)
          .taskStarted("u3")
          .turnContext({ model: "gpt-5.6", turnId: "u3" })
          .user("again", { turnId: "u3" })
          .call("spawn_agent", { message: "check docs" }, "s1")
          .output("s1", "spawned")
          .subAgentDone(threadId(91), "/root/docs")
          .compacted(localSummary("Docs checked.", CodexTranscript.SUMMARY_PREFIX), [userItem("again")])
          .assistant("four")
          .taskComplete("u3")
          .taskStarted("u4")
          .user("fifth", { turnId: "u4" })
          .assistant("five")
          .records(),
    ],
    [
      "a sub-agent fork: inherited context skipped, steps before its first request open a turn",
      () =>
        rollout()
          .meta({ id: threadId(33), subagentStart: 3, source: spawnSource(threadId(34)) })
          .meta({ id: threadId(34) })
          .user("parent request")
          .assistant("continuing the task")
          .user("child follow-up")
          .assistant("done")
          .records(),
    ],
  ]

  for (const [name, records] of cases)
    test(name, async () => {
      const { codex } = await make()
      const id = /([0-9a-f-]{36})/.exec(JSON.stringify(records()[0]))?.[1] ?? ""
      for (const zst of [false, true]) {
        const target = await codexTarget(codex, id, records(), { zst })
        const info = await whole(target)
        const expected = rendered(target, info)
        const viewer = View.viewer()
        expect(await all(viewer, target)).toEqual(expected)
        const outline = (await page(viewer, target)).outline
        expect(outline.turns).toEqual(
          info.turns.map((turn) => ({
            index: turn.index,
            firstLine: CodexTranscript.firstLine(turn.user.text) ?? "",
            time: turn.time,
          })),
        )
        expect(outline.checkpoints).toEqual(
          info.checkpoints.map((checkpoint) => ({
            turn: checkpoint.at.turn,
            step: checkpoint.at.step,
            kind: checkpoint.kind,
          })),
        )
        expect(outline.children.map((child) => [String(child.ref.id), child.turn])).toEqual(
          info.children.map((child) => [child.id, child.at?.turn]),
        )
        expect(outline.rolledBack).toBe(info.dropped.rolledBack ?? 0)
        expect(outline.unknownRecords).toBe(info.dropped.unknownRecord ?? 0)
        expect(outline.tokens).toBe(info.turns.reduce((sum, turn) => sum + View.tokens(turn), 0))
        // Pages of one turn read again from their offsets, nothing cached, give the same messages.
        const cold = View.viewer({ budget: 0 })
        await page(cold, target)
        expect(await all(cold, target, 1)).toEqual(expected)
      }
    })

  test("the rollback cases match the parser's own counts", async () => {
    const { codex } = await make()
    const steered = cases[2][1]()
    const target = await codexTarget(codex, threadId(32), steered)
    const value = await page(View.viewer(), target)
    expect(value.outline.turns.map((turn) => turn.firstLine)).toEqual(["first", "again", "fifth"])
    expect(value.outline.rolledBack).toBe(2)
    expect(value.outline.children).toEqual([
      { ref: decodeRef({ kind: "codex", rootID: codex.rootID, id: threadId(91) }), title: "/root/docs", turn: 1 },
    ])
    // The model changed with the turn; the open last turn has no idle.
    const models = value.messages.flatMap((message) => (message.type === "assistant" ? [message.model.id] : []))
    expect(models).toEqual(["gpt-5.5", "gpt-5.6", "gpt-5.6", "gpt-5.6"])
    expect(value.messages.at(-1)).toMatchObject({ type: "assistant", metadata: place(2) })
  })
})

describe("paging and offsets (09 §2.8)", () => {
  /** `turns` turns, each a request, a command with an `output`-byte result and the answer. */
  function long(id: string, turns: number, output: number) {
    return range(turns)
      .reduce(
        (builder, index) =>
          builder
            .taskStarted(`u${index}`)
            .turnContext({ model: "gpt-5.5", turnId: `u${index}` })
            .user(`request ${index}`, { kinds: true, turnId: `u${index}` })
            .call("exec_command", { cmd: `step ${index}` }, `c${index}`)
            .output(`c${index}`, `${index}:`.padEnd(output, "x"))
            .assistant(`answer ${index}`)
            .taskComplete(`u${index}`),
        rollout().meta({ id }),
      )
      .records()
  }
  const first = (value: View.Page) =>
    value.messages.flatMap((message) => (message.type === "user" ? [message.text] : []))

  test("pages of `count` turns with `next`; a .jsonl page jumps to its offset and parses only its own lines", async () => {
    const { codex } = await make()
    const target = await codexTarget(codex, threadId(40), long(threadId(40), 45, 64))
    const viewer = View.viewer({ budget: 0 })
    const one = await page(viewer, target, { count: 20 })
    expect(first(one)).toEqual(range(20).map((index) => `request ${index}`))
    expect(one.next).toBe(20)
    const last = await page(viewer, target, { from: 40, count: 20 })
    expect(first(last)).toEqual(range(5).map((index) => `request ${40 + index}`))
    expect(last.next).toBeUndefined()
    expect(last.outline.turns).toHaveLength(45)
    expect((await page(viewer, target, { from: 45 })).messages).toEqual([])
    // A page in the middle is read from its offset: its 5 turns of 7 lines (and the line opening the next one).
    const before = viewer.stats().lines
    const middle = await page(viewer, target, { from: 30, count: 5 })
    expect(first(middle)).toEqual(range(5).map((index) => `request ${30 + index}`))
    expect(middle.next).toBe(35)
    expect(viewer.stats().lines - before).toBe(5 * 7 + 1)
  })

  test(".zst: the first page comes before the outline is complete, the outline streams, other pages re-stream, the LRU stays within its budget", async () => {
    const { item, codex } = await make()
    const turns = 1000
    const target = await codexTarget(codex, threadId(41), long(threadId(41), turns, 20 * 1024), { zst: true })
    const budget = 2 * 1024 * 1024
    const viewer = View.viewer({ budget })
    const guard = await start([item.codex])
    const head = await page(viewer, target)
    expect(first(head)).toEqual(range(20).map((index) => `request ${index}`))
    expect(head.outlineComplete).toBe(false)
    expect(head.outline.turns.length).toBeLessThan(turns)
    expect(head.next).toBe(20)
    const complete = async (): Promise<View.Page> => {
      const value = await page(viewer, target)
      if (value.outlineComplete) return value
      await Bun.sleep(20)
      return complete()
    }
    const done = await complete()
    expect(done.outline.turns).toHaveLength(turns)
    expect(viewer.stats().bytes).toBeLessThanOrEqual(budget)
    expect(viewer.stats().hot).toBeGreaterThanOrEqual(20)
    // The newest turns stayed (cold): the last page costs no decoding.
    const lines = viewer.stats().lines
    expect(first(await page(viewer, target, { from: turns - 20 }))).toEqual(
      range(20).map((index) => `request ${turns - 20 + index}`),
    )
    expect(viewer.stats().lines).toBe(lines)
    // A page in the middle is decoded from the start again; the lines before it are skipped unparsed.
    const middle = await page(viewer, target, { from: 500, count: 5 })
    expect(first(middle)).toEqual(range(5).map((index) => `request ${500 + index}`))
    expect(viewer.stats().lines - lines).toBe(5 * 7 + 1)
    expect(viewer.stats().bytes).toBeLessThanOrEqual(budget)
    expect(await guard.stop()).toEqual([])
    expect(View.LRU_BYTES).toBe(64 * 1024 * 1024)
  })

  test("cancelling: a read that is aborted answers cancelled and stops the pass it started; cancel(ref) stops the outline, a later read resumes it", async () => {
    const { codex } = await make()
    const turns = 600
    const target = await codexTarget(codex, threadId(42), long(threadId(42), turns, 20 * 1024), { zst: true })
    const viewer = View.viewer()
    const streaming = async (count: number): Promise<void> => {
      if (viewer.stats().lines >= count) return
      await Bun.sleep(5)
      return streaming(count)
    }
    const settled = async (subject: View.Viewer): Promise<View.Page> => {
      const value = await page(subject, target)
      if (value.outlineComplete) return value
      await Bun.sleep(20)
      return settled(subject)
    }
    const controller = new AbortController()
    const pending = viewer.read(target, { from: 500 }, controller.signal)
    await streaming(100)
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: "cancelled" })
    const stopped = viewer.stats().lines
    expect(stopped).toBeLessThan(500 * 7)
    await Bun.sleep(100)
    expect(viewer.stats().lines).toBe(stopped)
    // A new read resumes the pass where it stopped and gets its page; cancel(ref) pauses the outline.
    const resumed = await page(viewer, target, { from: 0 })
    expect(first(resumed)).toEqual(range(20).map((index) => `request ${index}`))
    viewer.cancel(target.ref)
    await Bun.sleep(100)
    const paused = await page(viewer, target, { from: 0 })
    expect(paused.outlineComplete).toBe(false)
    const lines = viewer.stats().lines
    await Bun.sleep(100)
    expect(viewer.stats().lines).toBe(lines)
    const last = await page(viewer, target, { from: turns - 5 })
    expect(first(last)).toEqual(range(5).map((index) => `request ${turns - 5 + index}`))
    // One pass over the file in three parts: only a stopped turn's lines are parsed again.
    expect(viewer.stats().lines).toBeLessThan(turns * 7 + 20)
    expect((await settled(viewer)).outline).toEqual((await settled(View.viewer())).outline)
  })

  test("a changed file is read again; a rollout Codex compressed meanwhile is found under its other name", async () => {
    const { item, codex } = await make()
    const id = threadId(43)
    const records = long(id, 3, 16)
    const target = await codexTarget(codex, id, records)
    const viewer = View.viewer()
    expect((await page(viewer, target)).outline.turns).toHaveLength(3)
    await writeRollout(item.codex, { id, records: long(id, 4, 16) })
    expect((await page(viewer, target)).outline.turns).toHaveLength(4)
    const plain = codexRollout(item.codex, { id, at: T0 })
    await fs.rm(plain)
    await writeJsonl(`${plain}.zst`, long(id, 5, 16))
    const moved = await page(viewer, target)
    expect(moved.outline.turns).toHaveLength(5)
    await fs.rm(`${plain}.zst`)
    expect(await viewer.read(target)).toEqual({ ok: false, reason: "missing" })
  })

  test("a Claude Code read can be cancelled; the viewer keeps a bounded number of conversations", async () => {
    const { item, claude, codex } = await make()
    const fixture = basic("2.1.288")
    await write(item.claude, fixture.input, fixture.session)
    const target = await claudeTarget(claude, IDS.basic)
    const viewer = View.viewer({ entries: 1 })
    const controller = new AbortController()
    controller.abort()
    expect(await viewer.read(target, {}, controller.signal)).toEqual({ ok: false, reason: "cancelled" })
    expect((await page(viewer, target)).outline.turns).toHaveLength(1)
    await page(viewer, await codexTarget(codex, threadId(44), main(threadId(44))))
    expect(viewer.stats().entries).toBe(1)
  })
})
