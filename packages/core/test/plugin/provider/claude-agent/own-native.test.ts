// OWN-PATCH(P-043) begin
// own's native transcripts (P-043, 02 §8.10.11) and process pool (P-044, 02 §8.10.12) on upstream's fake `claude`, which
// here also writes its conversations as Claude Code does (`files`), with the real transcript helpers over a temporary
// account folder: what own writes, what claude resumes and what it is sent.
import fs from "node:fs"
import path from "node:path"
import { describe, expect } from "bun:test"
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { Options, SDKUserMessage, SpareProcess } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Fiber, SubscriptionRef } from "effect"
import { ClaudeSDK } from "@opencode/core/plugin/provider/claude-agent/claude/sdk"
import { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { ClaudeObserver } from "@opencode/core/plugin/provider/claude-agent/claude/observer"
import { ClaudePool } from "@opencode/core/plugin/provider/claude-agent/claude/pool"
import { ClaudeQueryOptions } from "@opencode/core/plugin/provider/claude-agent/claude/query-options"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { ClaudeStatus } from "@opencode/core/plugin/provider/claude-agent/claude/status"
import { ClaudeTranscripts } from "@opencode/core/plugin/provider/claude-agent/claude/transcripts"
import { FolderStore } from "@opencode/core/plugin/provider/claude-agent/claude/folder-store"
import { ClaudeAgentLanguageModel } from "@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind"
import { SessionRecord } from "@opencode/core/plugin/provider/claude-agent/sync/record"
import { it } from "../../../lib/effect"
import { tmpdirScoped } from "../../../fixture/tmpdir"
import { FakeClaude } from "./lib/fake-claude"
import { FakeIO } from "./lib/fake-io"
import { TestSessions } from "./lib/sessions"

const LOOKUP: LanguageModelV3FunctionTool = {
  type: "function",
  name: "lookup",
  description: "Look up a fixture marker by key.",
  inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
}
const QUESTION = "What was the marker? Reply only with it."
// A ChatGPT turn's tool call id (Codex joins the call and item ids with `|`), which Claude's API does not take.
const GPT_CALL = "call_gpt1|fc_0001"

// The real transcript helpers and allow-list over upstream's fake `claude`.
function nativeIO(claude: FakeClaude.Fake): ClaudeIO.Interface {
  return {
    ...FakeIO.make({ claude }),
    env: () => ClaudeIO.allowed({}),
    requiresFolder: true,
    sessionExists: ClaudeIO.real.sessionExists,
    fork: ClaudeIO.real.fork,
    remove: ClaudeIO.real.remove,
    transcripts: ClaudeIO.real.transcripts,
  }
}

function storage() {
  const data = new Map<string, unknown>()
  return {
    data,
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: SessionRecord.Record) =>
      Effect.sync(() => {
        data.set(key, structuredClone(value))
      }),
    remove: (key: string) =>
      Effect.sync(() => {
        data.delete(key)
      }),
    scan: (options: { readonly prefix: string }) =>
      Effect.sync(() => ({
        entries: [...data.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value })),
      })),
  }
}

const setup = Effect.fn(function* (claude: FakeClaude.Fake, saved = storage()) {
  const root = (yield* tmpdirScoped("own-native-")).path
  const configDir = path.join(root, "config")
  const directory = path.join(root, "work")
  fs.mkdirSync(directory, { recursive: true })
  yield* shareProjects(configDir)
  return { root, configDir, directory, saved, ...(yield* open(claude, configDir, directory, saved)) }
})

// own-accounts names the shared transcript folder (CAG-34); here the account folder's own `projects` stands in for it.
const shareProjects = Effect.fn(function* (configDir: string) {
  fs.mkdirSync(path.join(configDir, "projects"), { recursive: true })
  ClaudeObserver.share(path.join(configDir, "projects"))
  yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.share(undefined)))
})

const open = Effect.fn(function* (
  claude: FakeClaude.Fake,
  configDir: string,
  directory: string,
  saved: ReturnType<typeof storage>,
) {
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const io = nativeIO(claude)
  const status = yield* ClaudeStatus.make(io, () => Effect.succeed({ CLAUDE_CONFIG_DIR: configDir }))
  const sessions = yield* registry.attach({ io, status, storage: saved, directory })
  const context = yield* Effect.context<never>()
  const model = new ClaudeAgentLanguageModel.Model(
    "haiku",
    { run: (request, signal) => Effect.runPromiseWith(context)(sessions.run(request), { signal }) },
    ClaudeQueryOptions.connectionEnv({ settings: { configDir } }),
  )
  return { registry, sessions, model }
})

const ask = (
  model: ClaudeAgentLanguageModel.Model,
  prompt: LanguageModelV3Prompt,
  sessionID = "session-a",
  extra: Record<string, string> = {},
) =>
  Effect.promise(async () => {
    const result = await model.doStream({
      prompt,
      tools: [LOOKUP],
      headers: { [RequestKind.HEADER]: "primary", [RequestKind.SESSION_HEADER]: sessionID, ...extra },
    })
    return TestSessions.collect(result.stream)
  })

const recordOf = (saved: ReturnType<typeof storage>, sessionID = "session-a") =>
  SessionRecord.make(saved).get(sessionID)

const chainOf = (configDir: string, directory: string, sessionID: string) =>
  Effect.promise(() => FolderStore.transcripts.chain(sessionID, { configDir, directory }))

const fileOf = (configDir: string, directory: string, sessionID: string) =>
  path.join(configDir, "projects", FolderStore.projectKey(directory), `${sessionID}.jsonl`)

// The texts of the user messages the SDK sent to one `claude`.
function sent(run: FakeClaude.Run) {
  return run.received
    .filter((message) => message.type === "user")
    .map((message) =>
      (Array.isArray(message.message.content) ? message.message.content : [{ text: message.message.content }])
        .map((block: { text?: string }) => block.text ?? `[${JSON.stringify(block)}]`)
        .join("\n"),
    )
}

// History another provider wrote: a question, a ChatGPT reply with its reasoning summary and a tool call, the result,
// and its answer.
function gptHistory(question = "Look up key a and tell me its value."): LanguageModelV3Prompt {
  return [
    { role: "user", content: [{ type: "text", text: question }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "The user wants the value of key a; the lookup tool has it." },
        { type: "text", text: "Looking it up." },
        { type: "tool-call", toolCallId: GPT_CALL, toolName: "lookup", input: { key: "a" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: GPT_CALL, toolName: "lookup", output: { type: "text", value: "LILAC-HERON" } },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "The value of key a is LILAC-HERON." }] },
  ]
}

const system: LanguageModelV3Prompt[number] = { role: "system", content: "You are a concise test assistant." }
const user = (text: string): LanguageModelV3Prompt[number] => ({ role: "user", content: [{ type: "text", text }] })
const claudeReply = (text = "COPPER-OTTER"): LanguageModelV3Prompt[number] => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

describe("own's native transcripts (P-043)", () => {
  it.live("a ChatGPT turn with a tool call, then a move to Claude Agent: structured blocks, no flattened text", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { files: true },
      )
      const test = yield* setup(claude)
      const prompt = [system, ...gptHistory(), user(QUESTION)]
      expect(TestSessions.text(yield* ask(test.model, prompt))).toBe("COPPER-OTTER")
      const record = (yield* recordOf(test.saved))!
      // claude resumed the transcript own wrote and was sent only the new question.
      expect(claude.runs[0]!.args).toContain(`--resume=${record.claudeSessionID}`)
      expect(sent(claude.runs[0]!)).toEqual([QUESTION])
      const chain = (yield* chainOf(test.configDir, test.directory, record.claudeSessionID))!
      const messages = chain.messages.map((message) => message.message as { role: string; content: any[] })
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"])
      const call = messages[1]!.content.find((block) => block.type === "tool_use")
      expect(call).toMatchObject({ type: "tool_use", name: "mcp__opencode__lookup", input: { key: "a" } })
      expect(call.id).toMatch(/^toolu_oc_[0-9a-f]{32}$/)
      expect(messages[2]!.content).toEqual([
        { type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: "LILAC-HERON" }] },
      ])
      // ChatGPT's reasoning goes on as its readable text, never as a thinking block or with a signature.
      expect(messages[1]!.content[0]).toEqual({
        type: "text",
        text: "The user wants the value of key a; the lookup tool has it.",
      })
      const file = fs.readFileSync(fileOf(test.configDir, test.directory, record.claudeSessionID), "utf8")
      expect(file).not.toContain("signature")
      expect(file).not.toContain('"thinking"')
      expect(file).not.toContain("conversation-checkpoint")
      // The record maps each group to its entry and seals what own wrote.
      expect(record.history).toHaveLength(6)
      expect(record.seal?.count).toBe(4)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("a catch-up after alternating providers writes the missed turns into the same conversation", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const first = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      yield* ask(test.model, first)
      const conversation = (yield* recordOf(test.saved))!.claudeSessionID
      expect(claude.runs[0]!.args).toContain(`--session-id=${conversation}`)
      // Then ChatGPT answered two turns; back on Claude Agent the missed turns are written on, in place.
      const second = [...first, claudeReply(), ...gptHistory(), user(QUESTION)]
      yield* ask(test.model, second)
      expect((yield* recordOf(test.saved))!.claudeSessionID).toBe(conversation)
      expect(claude.runs[1]!.args).toContain(`--resume=${conversation}`)
      expect(sent(claude.runs[1]!)).toEqual([QUESTION])
      const third = [...second, claudeReply(), ...gptHistory("Look up key a once more."), user("And now?")]
      yield* ask(test.model, third)
      expect(claude.runs[2]!.args).toContain(`--resume=${conversation}`)
      expect(sent(claude.runs[2]!)).toEqual(["And now?"])
      const chain = (yield* chainOf(test.configDir, test.directory, conversation))!
      const roles = chain.messages.map((message) => (message.message as { role: string }).role)
      // Claude's own turn, ChatGPT's turn as entries, Claude's turn, ChatGPT's again, Claude's.
      expect(roles).toEqual([
        ...["user", "assistant"],
        ...["user", "assistant", "user", "assistant", "user", "assistant"],
        ...["user", "assistant", "user", "assistant", "user", "assistant"],
      ])
      const text = JSON.stringify(chain.messages)
      expect(text).not.toContain("conversation-checkpoint")
      expect(text.match(/mcp__opencode__lookup/g)).toHaveLength(2)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("an undo of a context reset resumes the conversation from before the reset", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const before = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      yield* ask(test.model, before)
      const old = (yield* recordOf(test.saved))!.claudeSessionID
      // The reset: only what comes after it is history now.
      yield* ask(test.model, [system, user("After the reset.")])
      const reset = (yield* recordOf(test.saved))!
      expect(reset.claudeSessionID).not.toBe(old)
      expect(reset.previous?.map((epoch) => epoch.claudeSessionID)).toEqual([old])
      expect(sent(claude.runs[1]!)).toEqual(["After the reset."])
      // Its undo brings the earlier history back: the old conversation is resumed, the turns since written on.
      yield* ask(test.model, [...before, claudeReply(), user("After the reset."), claudeReply(), user("Undone.")])
      const undone = (yield* recordOf(test.saved))!
      expect(undone.claudeSessionID).toBe(old)
      expect(undone.previous?.map((epoch) => epoch.claudeSessionID)).toEqual([reset.claudeSessionID])
      expect(claude.runs[2]!.args).toContain(`--resume=${old}`)
      expect(sent(claude.runs[2]!)).toEqual(["Undone."])
      const chain = (yield* chainOf(test.configDir, test.directory, old))!
      expect(JSON.stringify(chain.messages.slice(2, 4))).toContain("After the reset.")
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("an undo whose old transcript is gone rebuilds it from the history", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const before = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      yield* ask(test.model, before)
      const old = (yield* recordOf(test.saved))!.claudeSessionID
      yield* ask(test.model, [system, user("After the reset.")])
      fs.rmSync(fileOf(test.configDir, test.directory, old))
      yield* ask(test.model, [...before, claudeReply(), user("After the reset."), claudeReply(), user("Undone.")])
      const rebuilt = (yield* recordOf(test.saved))!
      expect(rebuilt.claudeSessionID).not.toBe(old)
      expect(claude.runs[2]!.args).toContain(`--resume=${rebuilt.claudeSessionID}`)
      expect(sent(claude.runs[2]!)).toEqual(["Undone."])
      const chain = (yield* chainOf(test.configDir, test.directory, rebuilt.claudeSessionID))!
      expect(chain.messages.map((message) => (message.message as { role: string }).role).slice(0, 4)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("after a compaction the summary goes in once, as the first entry, with no second checkpoint tag", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { files: true },
      )
      const test = yield* setup(claude)
      const summary = [
        "<conversation-checkpoint>",
        "The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.",
        "",
        "<summary>\n## Objective\n- Find the marker.\n</summary>",
        "</conversation-checkpoint>",
      ].join("\n")
      const prompt = [system, user(summary), ...gptHistory().slice(1), user(QUESTION)]
      yield* ask(test.model, prompt)
      const record = (yield* recordOf(test.saved))!
      expect(sent(claude.runs[0]!)).toEqual([QUESTION])
      const chain = (yield* chainOf(test.configDir, test.directory, record.claudeSessionID))!
      expect(chain.messages[0]!.message).toEqual({ role: "user", content: [{ type: "text", text: summary }] })
      const file = fs.readFileSync(fileOf(test.configDir, test.directory, record.claudeSessionID), "utf8")
      expect(file.match(/<conversation-checkpoint>/g)).toHaveLength(1)
      expect(file).not.toContain("The following is conversation history from OpenCode")
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("a hand-edited transcript is found before the resume and rebuilt from the history", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const prompt = [system, ...gptHistory(), user(QUESTION)]
      yield* ask(test.model, prompt)
      const before = (yield* recordOf(test.saved))!
      yield* test.registry.close()
      // Someone edits the transcript by hand while the conversation is idle.
      const file = fileOf(test.configDir, test.directory, before.claudeSessionID)
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("LILAC-HERON", "EDITED-BY-HAND"))
      const next = yield* open(claude, test.configDir, test.directory, test.saved)
      yield* ask(next.model, [...prompt, claudeReply(), user("Once more.")])
      const after = (yield* recordOf(test.saved))!
      expect(after.claudeSessionID).not.toBe(before.claudeSessionID)
      expect(claude.runs[1]!.args).toContain(`--resume=${after.claudeSessionID}`)
      expect(sent(claude.runs[1]!)).toEqual(["Once more."])
      const rebuilt = fs.readFileSync(fileOf(test.configDir, test.directory, after.claudeSessionID), "utf8")
      expect(rebuilt).toContain("LILAC-HERON")
      expect(rebuilt).not.toContain("EDITED-BY-HAND")
      // The changed transcript was removed, not kept for an undo.
      expect(fs.existsSync(file)).toBe(false)
      expect(after.previous ?? []).toEqual([])
      yield* next.registry.close()
      claude.check()
    }),
  )

  it.live("an edited history whose transcript was also changed by hand is rebuilt, never forked from it", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const prompt = [system, ...gptHistory(), user(QUESTION)]
      yield* ask(test.model, prompt)
      const before = (yield* recordOf(test.saved))!
      yield* test.registry.close()
      const file = fileOf(test.configDir, test.directory, before.claudeSessionID)
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("LILAC-HERON", "EDITED-BY-HAND"))
      // The user edits the last answer in OpenCode: the history changed, so the transcript would be forked.
      const next = yield* open(claude, test.configDir, test.directory, test.saved)
      const edited = [...prompt.slice(0, -2), claudeReply("An edited answer."), user("After the edit.")]
      yield* ask(next.model, edited)
      const after = (yield* recordOf(test.saved))!
      expect(after.claudeSessionID).not.toBe(before.claudeSessionID)
      const rebuilt = fs.readFileSync(fileOf(test.configDir, test.directory, after.claudeSessionID), "utf8")
      expect(rebuilt).toContain("LILAC-HERON")
      expect(rebuilt).not.toContain("EDITED-BY-HAND")
      expect(fs.existsSync(file)).toBe(false)
      yield* next.registry.close()
      claude.check()
    }),
  )

  it.live("transcripts no record points to are removed once they are old; referenced and recent ones stay", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([])
      const test = yield* setup(claude)
      const project = path.join(test.configDir, "projects", FolderStore.projectKey(test.directory))
      fs.mkdirSync(project, { recursive: true })
      const ids = { kept: crypto.randomUUID(), undo: crypto.randomUUID(), old: crypto.randomUUID(), recent: crypto.randomUUID() }
      for (const id of Object.values(ids)) fs.writeFileSync(path.join(project, `${id}.jsonl`), "{}\n")
      fs.mkdirSync(path.join(project, ids.old, "subagents"), { recursive: true })
      const hours = (count: number) => new Date(Date.now() - count * 3_600_000)
      for (const id of [ids.kept, ids.undo, ids.old])
        fs.utimesSync(path.join(project, `${id}.jsonl`), hours(3), hours(3))
      test.saved.data.set("sessions/session-a", { claudeSessionID: ids.kept, previous: [{ claudeSessionID: ids.undo }] })
      yield* test.sessions.sweep(test.configDir)
      const left = fs.readdirSync(project).sort()
      expect(left).toEqual([`${ids.kept}.jsonl`, `${ids.recent}.jsonl`, `${ids.undo}.jsonl`].sort())
    }),
  )

  it.live("a projects that is not the shared folder is never swept, written or removed through (CAG-34)", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped("own-native-")).path
      const shared = path.join(root, "own", "claude-agent", "projects")
      const configDir = path.join(root, "own", "claude-agent", "accounts", "a1")
      // Outside OWN_HOME, e.g. the user's ~/.claude/projects: what must never change.
      const outside = path.join(root, "outside")
      const id = crypto.randomUUID()
      const old = new Date(Date.now() - 3 * 3_600_000)
      fs.mkdirSync(path.join(outside, "P", id), { recursive: true })
      fs.writeFileSync(path.join(outside, "P", `${id}.jsonl`), "{}\n")
      fs.utimesSync(path.join(outside, "P", `${id}.jsonl`), old, old)
      fs.mkdirSync(shared, { recursive: true })
      fs.mkdirSync(configDir, { recursive: true })
      fs.symlinkSync(outside, path.join(configDir, "projects"), "junction")
      ClaudeObserver.share(shared)
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.share(undefined)))
      const outsideNow = () => fs.readdirSync(path.join(outside, "P")).sort()
      const before = outsideNow()
      const outcome = (run: () => Promise<unknown>) =>
        Effect.promise(() =>
          run().then(
            () => "done",
            (error: Error) => error.message,
          ),
        )
      const sweeper = ClaudeTranscripts.make({
        io: {} as ClaudeIO.Interface,
        transcripts: FolderStore.transcripts,
        directory: root,
        version: () => Effect.succeed("x"),
      })

      // The account folder's projects points outside, unrepaired: the provider's sweep skips it with a warning, writes
      // and removals are refused, and the outside folder is untouched.
      const claude = FakeClaude.make([])
      const registry = ClaudeSessions.registry()
      yield* Effect.addFinalizer(() => registry.close())
      const io = nativeIO(claude)
      const status = yield* ClaudeStatus.make(io, () => Effect.succeed({ CLAUDE_CONFIG_DIR: configDir }))
      const sessions = yield* registry.attach({ io, status, storage: storage(), directory: root })
      yield* sessions.sweep(configDir)
      expect(outsideNow()).toEqual(before)
      expect(yield* outcome(() => FolderStore.transcripts.list(configDir))).toContain("함께 쓰는 대화 기록 폴더")
      const folder = { configDir, directory: path.join(outside, "P") }
      expect(yield* outcome(() => FolderStore.transcripts.write(id, folder, [{ type: "user" }], true))).toContain(
        "바꾸지 않았어요",
      )
      expect(yield* outcome(() => FolderStore.transcripts.discard(configDir, "P", id))).toContain("바꾸지 않았어요")
      expect(yield* outcome(() => ClaudeIO.real.remove(id, folder))).toContain("바꾸지 않았어요")
      expect(outsideNow()).toEqual(before)

      // The shared folder itself a junction to the outside (a hostile entry in OWN_HOME): refused although the
      // account's link and the shared folder lead to the same place.
      fs.rmSync(shared, { recursive: true })
      fs.symlinkSync(outside, shared, "junction")
      fs.unlinkSync(path.join(configDir, "projects"))
      fs.symlinkSync(shared, path.join(configDir, "projects"), "junction")
      expect(yield* outcome(() => FolderStore.transcripts.list(configDir))).toContain("진짜 폴더가 아니에요")
      expect(yield* sweeper.sweep(configDir, new Set()).pipe(Effect.catch(() => Effect.succeed("skipped")))).toBe(
        "skipped",
      )
      expect(outsideNow()).toEqual(before)

      // Without a shared folder named by own nothing is written or removed.
      fs.unlinkSync(shared)
      fs.mkdirSync(shared)
      ClaudeObserver.share(undefined)
      expect(yield* outcome(() => FolderStore.transcripts.list(configDir))).toContain("알려 주지 않았어요")

      // The link to the real shared folder: the sweep works there.
      ClaudeObserver.share(shared)
      fs.mkdirSync(path.join(shared, "P"))
      fs.writeFileSync(path.join(shared, "P", `${id}.jsonl`), "{}\n")
      fs.utimesSync(path.join(shared, "P", `${id}.jsonl`), old, old)
      expect(yield* sweeper.sweep(configDir, new Set())).toEqual([id])
      expect(fs.readdirSync(path.join(shared, "P"))).toEqual([])
      expect(outsideNow()).toEqual(before)
    }),
  )

  it.live("a junction above the shared folder is never followed, and a linked OWN_HOME still works (CAG-42)", () =>
    Effect.gen(function* () {
      const root = fs.realpathSync((yield* tmpdirScoped("own-native-")).path)
      const id = crypto.randomUUID()
      const old = new Date(Date.now() - 3 * 3_600_000)
      // `<OWN_HOME>\claude-agent` is a junction to a folder elsewhere that holds transcripts own must not touch, and
      // the account folder's `projects` is the junction own made to the shared path (through it).
      const home = path.join(root, "own")
      const elsewhere = path.join(root, "elsewhere")
      const shared = path.join(home, "claude-agent", "projects")
      const configDir = path.join(home, "claude-agent", "accounts", "a1")
      fs.mkdirSync(path.join(elsewhere, "projects", "P", id, "subagents"), { recursive: true })
      fs.writeFileSync(path.join(elsewhere, "projects", "P", `${id}.jsonl`), "{}\n")
      fs.utimesSync(path.join(elsewhere, "projects", "P", `${id}.jsonl`), old, old)
      fs.mkdirSync(path.join(elsewhere, "accounts", "a1"), { recursive: true })
      fs.mkdirSync(home)
      fs.symlinkSync(elsewhere, path.join(home, "claude-agent"), "junction")
      fs.symlinkSync(shared, path.join(configDir, "projects"), "junction")
      const elsewhereNow = () =>
        fs.readdirSync(path.join(elsewhere, "projects"), { recursive: true }).map(String).sort()
      const before = elsewhereNow()
      const outcome = (run: () => Promise<unknown>) =>
        Effect.promise(() =>
          run().then(
            () => "done",
            (error: Error) => error.message,
          ),
        )
      const sweeper = ClaudeTranscripts.make({
        io: {} as ClaudeIO.Interface,
        transcripts: FolderStore.transcripts,
        directory: root,
        version: () => Effect.succeed("x"),
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.share(undefined)))

      // Named by the path through the junction (own-accounts before CAG-42 did so although its check refused): its
      // real path is elsewhere, so the sweep, writes and removals are all refused.
      ClaudeObserver.share(shared)
      expect(yield* outcome(() => FolderStore.transcripts.list(configDir))).toContain("진짜 폴더가 아니에요")
      expect(yield* sweeper.sweep(configDir, new Set()).pipe(Effect.catch(() => Effect.succeed("skipped")))).toBe(
        "skipped",
      )
      const folder = { configDir, directory: root }
      expect(yield* outcome(() => FolderStore.transcripts.write(id, folder, [{ type: "user" }], true))).toContain(
        "바꾸지 않았어요",
      )
      expect(yield* outcome(() => FolderStore.transcripts.discard(configDir, "P", id))).toContain("바꾸지 않았어요")
      expect(elsewhereNow()).toEqual(before)

      // OWN_HOME itself a link is allowed: own-accounts names the shared folder by its real path, and own works there.
      fs.unlinkSync(path.join(configDir, "projects"))
      fs.unlinkSync(path.join(home, "claude-agent"))
      fs.renameSync(home, path.join(root, "real-own"))
      fs.symlinkSync(path.join(root, "real-own"), home, "junction")
      const real = path.join(root, "real-own", "claude-agent", "projects")
      const linkedDir = path.join(home, "claude-agent", "accounts", "a1")
      fs.mkdirSync(real, { recursive: true })
      fs.mkdirSync(linkedDir, { recursive: true })
      fs.symlinkSync(shared, path.join(linkedDir, "projects"), "junction")
      ClaudeObserver.share(real)
      expect(
        yield* outcome(() =>
          FolderStore.transcripts.write(id, { configDir: linkedDir, directory: root }, [{ type: "user" }], true),
        ),
      ).toBe("done")
      expect(fs.readdirSync(real, { recursive: true }).map(String)).toContain(
        path.join(FolderStore.projectKey(root), `${id}.jsonl`),
      )
      expect(elsewhereNow()).toEqual(before)
    }),
  )

  it.live("a transcript that is a link or hard link, or in a linked session folder, is never appended (CAG-44)", () =>
    Effect.gen(function* () {
      const root = fs.realpathSync((yield* tmpdirScoped("own-native-")).path)
      const shared = path.join(root, "own", "claude-agent", "projects")
      const configDir = path.join(root, "own", "claude-agent", "accounts", "a1")
      const outside = path.join(root, "outside")
      const id = crypto.randomUUID()
      fs.mkdirSync(path.join(shared, "P"), { recursive: true })
      fs.mkdirSync(path.join(outside, "S"), { recursive: true })
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(path.join(outside, "target.jsonl"), "{}\n")
      fs.symlinkSync(shared, path.join(configDir, "projects"), "junction")
      ClaudeObserver.share(shared)
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.share(undefined)))
      const store = FolderStore.make(configDir)
      const append = (key: { projectKey: string; sessionId: string; subpath?: string }) =>
        Effect.promise(() =>
          store.append(key, [{ type: "user", uuid: "x" } as never]).then(
            () => "done",
            (error: Error) => error.message,
          ),
        )
      const target = () => fs.readFileSync(path.join(outside, "target.jsonl"), "utf8")

      fs.linkSync(path.join(outside, "target.jsonl"), path.join(shared, "P", `${id}.jsonl`))
      expect(yield* append({ projectKey: "P", sessionId: id })).toContain("하드 링크")
      expect(target()).toBe("{}\n")

      // A session folder (`<project>\<session>`, where subagent transcripts go) that is a junction to elsewhere.
      fs.symlinkSync(path.join(outside, "S"), path.join(shared, "P", id), "junction")
      expect(yield* append({ projectKey: "P", sessionId: id, subpath: "subagents/agent-1" })).toContain(
        "진짜 폴더가 아니에요",
      )
      expect(fs.readdirSync(path.join(outside, "S"))).toEqual([])

      // A plain file appends as before.
      const fresh = crypto.randomUUID()
      expect(yield* append({ projectKey: "P", sessionId: fresh })).toBe("done")
      expect(fs.readFileSync(path.join(shared, "P", `${fresh}.jsonl`), "utf8")).toContain('"uuid":"x"')
    }),
  )

  it.live("file names that are not a session id never make the sweep remove a project folder or the link (CAG-34)", () =>
    Effect.gen(function* () {
      const old = new Date(Date.now() - 3 * 3_600_000)
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.share(undefined)))
      for (const name of [".jsonl", "..jsonl", "...jsonl", "not-a-uuid.jsonl"]) {
        const root = (yield* tmpdirScoped("own-native-")).path
        const shared = path.join(root, "own", "claude-agent", "projects")
        const configDir = path.join(root, "own", "claude-agent", "accounts", "a1")
        fs.mkdirSync(path.join(shared, "P"), { recursive: true })
        fs.mkdirSync(path.join(shared, "Q"), { recursive: true })
        fs.mkdirSync(configDir, { recursive: true })
        fs.symlinkSync(shared, path.join(configDir, "projects"), "junction")
        ClaudeObserver.share(shared)
        const inUse = crypto.randomUUID()
        fs.writeFileSync(path.join(shared, "P", `${inUse}.jsonl`), "{}\n")
        fs.writeFileSync(path.join(shared, "Q", `${inUse}.jsonl`), "{}\n")
        fs.writeFileSync(path.join(shared, "P", name), "{}\n")
        fs.utimesSync(path.join(shared, "P", name), old, old)
        const removed = yield* ClaudeTranscripts.make({
          io: {} as ClaudeIO.Interface,
          transcripts: FolderStore.transcripts,
          directory: root,
          version: () => Effect.succeed("x"),
        }).sweep(configDir, new Set([inUse]))
        expect(removed).toEqual([])
        expect(fs.existsSync(path.join(shared, "P", `${inUse}.jsonl`))).toBe(true)
        expect(fs.existsSync(path.join(shared, "Q", `${inUse}.jsonl`))).toBe(true)
        expect(fs.lstatSync(path.join(configDir, "projects")).isSymbolicLink()).toBe(true)
        // A removal by such a name is refused outright.
        const refused = yield* Effect.promise(() =>
          FolderStore.transcripts.discard(configDir, "P", name.slice(0, -".jsonl".length)).then(
            () => "removed",
            (error: Error) => error.message,
          ),
        )
        expect(refused).toContain("by session id only")
        expect(fs.existsSync(path.join(shared, "P", `${inUse}.jsonl`))).toBe(true)
      }
    }),
  )

  it.effect("the kept list holds the newest four replaced conversations and names the rest for removal", () =>
    Effect.sync(() => {
      const epoch = (claudeSessionID: string) => ({ claudeSessionID })
      const listed = ClaudeTranscripts.keep(["b", "c", "d", "e"].map(epoch), epoch("a"), "z")
      expect(listed.kept.map((item) => item.claudeSessionID)).toEqual(["a", "b", "c", "d"])
      expect(listed.dropped.map((item) => item.claudeSessionID)).toEqual(["e"])
      // The conversation made current again is not kept beside itself.
      expect(ClaudeTranscripts.keep(["b", "c"].map(epoch), epoch("a"), "b").kept.map((item) => item.claudeSessionID))
        .toEqual(["a", "c"])
    }),
  )
})

// Waits (real time) until `check` holds: a closed process hands its slot back after it exits.
const settled = (check: () => boolean) =>
  Effect.promise(async () => {
    const end = Date.now() + 10_000
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out")
      await Bun.sleep(10)
    }
  })

// A pool member for the unit tests: its state is set by hand.
interface TestMember extends ClaudePool.Member {
  busy: boolean
  // Parked on a tool, since when: an ordinary one (`tool`), a subagent (`child`) or a question (`reply`).
  parked?: { readonly kind: "tool" | "child" | "reply"; readonly since: number }
  parent?: TestMember
}

// The pool tests' settle time (the provider's is ClaudePool.SETTLE_MS).
const SETTLE = 30

const member = (sessionID: string, side = false): TestMember => ({ sessionID, side, busy: false })

// A subagent's member: its parent is a member of the pool, or only an id (a conversation on another provider).
const subagent = (sessionID: string, parent: TestMember | string): TestMember => ({
  ...member(sessionID),
  busy: true,
  ...(typeof parent === "string" ? { parentID: parent } : { parent, parentID: parent.sessionID }),
})

// The member's turn ends on a tool call: it waits for the result.
const park = (item: TestMember, kind: "tool" | "child" | "reply" = "child") => {
  item.busy = false
  item.parked = { kind, since: Date.now() }
}

function testPool(cap: number | { cap: number }) {
  const evicted: string[] = []
  const reports: Array<{ status: ClaudePool.Status; queued?: string }> = []
  let peak = 0
  const pool: ReturnType<typeof ClaudePool.make<TestMember>> = ClaudePool.make<TestMember>({
    cap: () => (typeof cap === "number" ? cap : cap.cap),
    busy: (item) => item.busy || item.parked !== undefined,
    stuck: (item) => (item.parked && item.parked.kind !== "tool" ? item.parked.since : undefined),
    parentWaits: (item) => item.parent?.parked?.kind === "child",
    evict: (item) =>
      Effect.sync(() => {
        evicted.push(item.sessionID!)
      }),
    report: (status, queued) => {
      peak = Math.max(peak, status.live)
      reports.push({ status, queued: queued?.sessionID })
    },
    settle: SETTLE,
  })
  return { pool, evicted, reports, peak: () => peak }
}

const waitingOf = (pool: ReturnType<typeof testPool>["pool"]) =>
  pool.status().waiting.map((item) => item.sessionID)

describe("own's process pool (P-044)", () => {
  it.live("the cap holds: a new process closes the least recently used idle one first", () =>
    Effect.gen(function* () {
      const test = testPool(2)
      const [a, b, c] = [member("a"), member("b"), member("c")]
      yield* test.pool.acquire(a)
      yield* test.pool.acquire(b)
      yield* Effect.sleep("5 millis")
      test.pool.touch(a)
      yield* test.pool.acquire(c)
      expect(test.evicted).toEqual(["b"])
      expect(test.pool.live()).toBe(2)
      const d = member("d")
      yield* test.pool.acquire(d)
      expect(test.evicted).toEqual(["b", "a"])
    }),
  )

  it.live("processes mid-turn or waiting for tool results are never closed; a start waits and is reported", () =>
    Effect.gen(function* () {
      const test = testPool(2)
      const [a, b, c] = [member("a"), member("b"), member("c")]
      yield* test.pool.acquire(a)
      yield* test.pool.acquire(b)
      park(a, "tool")
      b.busy = true
      const waiting = yield* test.pool.acquire(c).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      expect(test.evicted).toEqual([])
      expect(waitingOf(test.pool)).toEqual(["c"])
      expect(test.reports.some((report) => report.queued === "c")).toBe(true)
      // b's turn ends: it may be closed now, and c takes its slot.
      b.busy = false
      test.pool.changed()
      yield* Fiber.join(waiting)
      expect(test.evicted).toEqual(["b"])
      expect(test.pool.status().waiting).toEqual([])
    }),
  )

  it.live("side calls have a bound of their own and never make the pool look stuck (CAG-46)", () =>
    Effect.gen(function* () {
      const test = testPool(1)
      const parent = member("parent")
      yield* test.pool.acquire(parent)
      park(parent, "tool")
      // A side call takes no conversation slot; a second one waits for the first, not for the conversations.
      const [title, usage] = [member("title", true), member("usage", true)]
      yield* test.pool.acquire(title)
      expect(test.pool.live()).toBe(2)
      const second = yield* test.pool.acquire(usage).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      expect(test.pool.live()).toBe(2)
      expect(test.pool.status().waiting).toEqual([])
      test.pool.release(title)
      yield* Fiber.join(second)
      expect(test.pool.live()).toBe(2)
      // The parent waits on an ordinary tool, the side call on nothing: a subagent does not go over the cap.
      const child = subagent("child", parent)
      const start = yield* test.pool.acquire(child).pipe(Effect.forkChild)
      yield* Effect.sleep(`${SETTLE * 3} millis`)
      expect(waitingOf(test.pool)).toEqual(["child"])
      // Once the parent waits for its subagent, it goes.
      park(parent, "child")
      test.pool.changed()
      yield* Fiber.join(start)
      expect(test.pool.status()).toMatchObject({ live: 3, over: 1, waiting: [] })
    }),
  )

  it.live("a subagent behind another provider's conversation goes over the cap once the pool stays stuck (CAG-43)", () =>
    Effect.gen(function* () {
      // P (Claude Agent) waits on its subagent tool for C1, a GPT subagent, which waits for C2 on Claude Agent: P's
      // process is the only one, and nothing but C2 can free it.
      const test = testPool(1)
      const parent = member("P")
      yield* test.pool.acquire(parent)
      park(parent, "child")
      const t0 = Date.now()
      yield* test.pool.acquire(subagent("C2", "C1"))
      // Not at once: only once every process waited on another conversation for the settle time.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(SETTLE - 2)
      expect(test.pool.status()).toMatchObject({ live: 2, over: 1 })
      // A conversation of its own still waits: nothing it waits for is in the pool.
      const root = yield* test.pool.acquire({ ...member("R"), busy: true }).pipe(Effect.forkChild)
      yield* Effect.sleep(`${SETTLE * 3} millis`)
      expect(waitingOf(test.pool)).toEqual(["R"])
      yield* Fiber.interrupt(root)
    }),
  )

  it.live("ordinary tool calls never take subagents over the cap; questions take them to twice the cap (CAG-43)", () =>
    Effect.gen(function* () {
      const test = testPool(2)
      const parents = [member("P0"), member("P1")]
      for (const parent of parents) yield* test.pool.acquire(parent)
      for (const parent of parents) park(parent, "child")
      // Each subagent runs, parks on an ordinary tool (Read, Bash), runs again, and ends: one at a time over the cap.
      const life = (item: TestMember) =>
        Effect.gen(function* () {
          yield* test.pool.acquire(item)
          for (const _ of [1, 2]) {
            yield* Effect.sleep("2 millis")
            park(item, "tool")
            test.pool.changed()
            yield* Effect.sleep("5 millis")
            item.parked = undefined
            item.busy = true
          }
          item.busy = false
          test.pool.release(item)
        })
      const kids = parents.flatMap((parent) =>
        [0, 1, 2].map((index) => subagent(`${parent.sessionID}.${index}`, parent)),
      )
      yield* Effect.forEach(kids, life, { concurrency: "unbounded" })
      expect(test.peak()).toBe(3)

      // Subagents that each ask a question and wait: twice the cap at most, the rest wait.
      const asking = parents.flatMap((parent) =>
        [0, 1, 2].map((index) => subagent(`${parent.sessionID}.q${index}`, parent)),
      )
      const starts = yield* Effect.forEach(asking, (item) =>
        test.pool.acquire(item).pipe(
          Effect.tap(() => Effect.sync(() => park(item, "reply"))),
          Effect.tap(() => Effect.sync(() => test.pool.changed())),
          Effect.forkChild,
        ),
      )
      yield* Effect.sleep(`${SETTLE * 8} millis`)
      expect(test.pool.status()).toMatchObject({ live: 4, over: 2 })
      expect(waitingOf(test.pool)).toHaveLength(4)
      for (const start of starts) yield* Fiber.interrupt(start)
    }),
  )

  it.live("beyond twice the cap only a chain's next step goes: one live subagent per waiting parent (CAG-43)", () =>
    Effect.gen(function* () {
      // P (Claude) -> C1 (GPT) -> C2 (Claude) -> C3 (Claude) -> C4 (Claude) at a cap of one.
      const test = testPool(1)
      const parent = member("P")
      yield* test.pool.acquire(parent)
      park(parent, "child")
      const c2 = subagent("C2", "C1")
      yield* test.pool.acquire(c2)
      park(c2, "child")
      test.pool.changed()
      const c3 = subagent("C3", c2)
      yield* test.pool.acquire(c3)
      expect(test.pool.status()).toMatchObject({ live: 3, over: 2 })
      // A sibling of C3 waits: its parent already has a live subagent.
      const sibling = yield* test.pool.acquire(subagent("C3b", c2)).pipe(Effect.forkChild)
      park(c3, "child")
      test.pool.changed()
      yield* test.pool.acquire(subagent("C4", c3))
      yield* Effect.sleep(`${SETTLE * 3} millis`)
      expect(waitingOf(test.pool)).toEqual(["C3b"])
      expect(test.pool.status()).toMatchObject({ live: 4, over: 3 })
      yield* Fiber.interrupt(sibling)
    }),
  )

  it.live("a freed slot goes in order of arrival; a start unblocking its waiting parent goes first once (CAG-45)", () =>
    Effect.gen(function* () {
      const test = testPool(2)
      const [a, b] = [member("A"), member("B")]
      yield* test.pool.acquire(a)
      yield* test.pool.acquire(b)
      park(a, "child")
      b.busy = true
      const x = { ...member("X"), busy: true }
      const startX = yield* test.pool.acquire(x).pipe(Effect.forkChild)
      yield* Effect.sleep("2 millis")
      const [a0, a1] = [subagent("A.0", a), subagent("A.1", a)]
      const startA0 = yield* test.pool.acquire(a0).pipe(Effect.forkChild)
      yield* Effect.sleep("2 millis")
      const startA1 = yield* test.pool.acquire(a1).pipe(Effect.forkChild)
      yield* Effect.sleep("2 millis")
      expect(waitingOf(test.pool)).toEqual(["X", "A.0", "A.1"])
      // B's turn ends: A.0 unblocks A and goes ahead of X.
      b.busy = false
      test.pool.changed()
      yield* Fiber.join(startA0)
      expect(waitingOf(test.pool)).toEqual(["X", "A.1"])
      // A.0 ends: X was passed once, so it goes before A.1.
      a0.busy = false
      test.pool.changed()
      yield* Fiber.join(startX)
      expect(waitingOf(test.pool)).toEqual(["A.1"])
      yield* Fiber.interrupt(startA1)
    }),
  )

  it.live("two teams with nested subagents on a cap of two: every start is granted, none waits for good", () =>
    Effect.gen(function* () {
      const test = testPool(2)
      // Two mains, each with a chain of three nested subagents: each level starts, runs, waits for the next, which
      // ends first; the area (parentless) waits and runs once a slot is free.
      const chain = (root: TestMember, depth: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* test.pool.acquire(root)
          yield* Effect.sleep("2 millis")
          if (depth > 0) {
            park(root, "child")
            test.pool.changed()
            yield* chain(subagent(`${root.sessionID}.${depth}`, root), depth - 1)
            root.parked = undefined
            root.busy = true
            yield* Effect.sleep("2 millis")
          }
          root.busy = false
          test.pool.changed()
        })
      const area = Effect.sleep("5 millis").pipe(Effect.andThen(chain({ ...member("area"), busy: true }, 0)))
      const teams = [chain({ ...member("T1"), busy: true }, 3), chain({ ...member("T2"), busy: true }, 3)]
      const done = yield* Effect.all([...teams, area], { concurrency: "unbounded" }).pipe(
        Effect.timeoutOption("10 seconds"),
      )
      expect(done._tag).toBe("Some")
      expect(test.pool.status().waiting).toEqual([])
      expect(test.peak()).toBeLessThanOrEqual(8)
    }),
  )

  it.live("the over count follows the live processes down (CAG-36)", () =>
    Effect.gen(function* () {
      const test = testPool(1)
      const parent = member("P")
      yield* test.pool.acquire(parent)
      park(parent, "child")
      const first = subagent("C1", parent)
      const second = subagent("C2", first)
      yield* test.pool.acquire(first)
      park(first, "child")
      test.pool.changed()
      yield* test.pool.acquire(second)
      expect(test.pool.status()).toMatchObject({ live: 3, over: 2 })
      test.pool.release(second)
      expect(test.pool.status()).toMatchObject({ live: 2, over: 1 })
      test.pool.release(parent)
      expect(test.pool.status()).toMatchObject({ live: 1, over: 0 })
    }),
  )

  it.live("a new cap applies at once: a higher one grants waiting starts, a lower one closes idle ones (CAG-36)", () =>
    Effect.gen(function* () {
      const setting = { cap: 1 }
      const test = testPool(setting)
      const a = member("a")
      yield* test.pool.acquire(a)
      park(a, "tool")
      const b = { ...member("b"), busy: true }
      const start = yield* test.pool.acquire(b).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      expect(waitingOf(test.pool)).toEqual(["b"])
      setting.cap = 2
      test.pool.recheck()
      yield* Fiber.join(start)
      expect(test.pool.status()).toMatchObject({ live: 2, cap: 2, waiting: [] })

      // Four processes, two of them protected; the cap goes to one: the idle ones close now, the busy one once it is
      // idle, the parked one never while it waits.
      setting.cap = 4
      const [c, d] = [member("c"), member("d")]
      yield* test.pool.acquire(c)
      yield* test.pool.acquire(d)
      setting.cap = 1
      test.pool.recheck()
      expect(test.evicted.toSorted()).toEqual(["c", "d"])
      expect(test.pool.live()).toBe(2)
      b.busy = false
      test.pool.changed()
      expect(test.evicted.toSorted()).toEqual(["b", "c", "d"])
      expect(test.pool.live()).toBe(1)
    }),
  )

  it.live("a team with more conversations than the cap runs them all, never more than the cap at once", () =>
    Effect.gen(function* () {
      const test = testPool(2)
      let peak = 0
      const work = (sessionID: string) =>
        Effect.gen(function* () {
          const item = member(sessionID)
          item.busy = true
          yield* test.pool.acquire(item)
          peak = Math.max(peak, test.pool.live())
          yield* Effect.sleep("5 millis")
          item.busy = false
          test.pool.changed()
        })
      yield* Effect.forEach(["area-1", "area-2", "area-3", "area-4", "area-5"], work, { concurrency: "unbounded" })
      expect(peak).toBe(2)
      expect(test.evicted).toHaveLength(3)
    }),
  )

  it.live("with a cap of one, a second conversation closes the first, which resumes its transcript after", () =>
    Effect.gen(function* () {
      ClaudeObserver.configure({ processes: 1 })
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.configure({})))
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn({ recording: "text-resume" }),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const first = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      yield* ask(test.model, first, "session-a")
      yield* ask(test.model, first, "session-b")
      // a was closed before b started.
      yield* Effect.promise(() => claude.runs[0]!.closed)
      expect(claude.runs).toHaveLength(2)
      yield* ask(test.model, [...first, claudeReply(), user(QUESTION)], "session-a")
      const a = (yield* recordOf(test.saved, "session-a"))!
      expect(claude.runs[2]!.args).toContain(`--resume=${a.claudeSessionID}`)
      yield* Effect.promise(() => claude.runs[1]!.closed)
      expect(ClaudeObserver.pool()?.live).toBe(1)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("a lower cap set while three conversations sit idle closes two of them at once, without a new start", () =>
    Effect.gen(function* () {
      ClaudeObserver.configure({ processes: 3 })
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.configure({})))
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const first = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      for (const sessionID of ["session-a", "session-b", "session-c"]) yield* ask(test.model, first, sessionID)
      expect(ClaudeObserver.pool()?.live).toBe(3)
      // own-accounts' setting (CAG-36): the stored cap and the pool's re-check, with no conversation starting.
      ClaudeObserver.configure({ processes: 1 })
      yield* Effect.promise(() => Promise.all([claude.runs[0]!.closed, claude.runs[1]!.closed]))
      yield* settled(() => ClaudeObserver.pool()?.live === 1)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("a higher cap lets a waiting conversation start at once", () =>
    Effect.gen(function* () {
      ClaudeObserver.configure({ processes: 1 })
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.configure({})))
      const hold = Promise.withResolvers<void>()
      const held = FakeClaude.expectTurn({ hold: hold.promise })
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          held,
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const first = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      const a = yield* ask(test.model, first, "session-a").pipe(Effect.forkChild)
      yield* Effect.promise(() => claude.started(held))
      const b = yield* ask(test.model, first, "session-b").pipe(Effect.forkChild)
      yield* Effect.sleep("50 millis")
      expect(ClaudeObserver.pool()?.waiting.map((item) => item.sessionID)).toEqual(["session-b"])
      ClaudeObserver.configure({ processes: 2 })
      yield* Fiber.join(b)
      expect(ClaudeObserver.pool()).toMatchObject({ live: 2, waiting: [] })
      hold.resolve()
      yield* Fiber.join(a)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("the login check counts against the cap while it runs and never waits for a slot (CAG-38)", () =>
    Effect.gen(function* () {
      ClaudeObserver.configure({ processes: 1 })
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.configure({})))
      const turn = Promise.withResolvers<void>()
      const check = Promise.withResolvers<void>()
      const probe = FakeClaude.expectStartup({ hold: check.promise })
      const held = FakeClaude.expectTurn({ hold: turn.promise })
      const claude = FakeClaude.make([FakeClaude.expectStartup(), held, probe, FakeClaude.expectInterrupt()], {
        files: true,
      })
      const test = yield* setup(claude)
      const first = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      const a = yield* ask(test.model, first, "session-a").pipe(Effect.forkChild)
      yield* Effect.promise(() => claude.started(held))
      // The provider's login check, as index.ts makes it: the registry's side start around the probe.
      const status = yield* ClaudeStatus.make(
        nativeIO(claude),
        () => Effect.succeed({ CLAUDE_CONFIG_DIR: test.configDir }),
        () => Effect.succeed([]),
        test.registry.side,
      )
      const refresh = yield* status.refresh().pipe(Effect.forkChild)
      yield* Effect.promise(() => claude.started(probe))
      expect(ClaudeObserver.pool()).toMatchObject({ live: 2, cap: 1, waiting: [] })
      check.resolve()
      yield* Fiber.join(refresh)
      expect((yield* SubscriptionRef.get(status.state)).type).toBe("ready")
      expect(ClaudeObserver.pool()).toMatchObject({ live: 1, waiting: [] })
      turn.resolve()
      yield* Fiber.join(a)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("before a folder moves, its idle processes close and its busy conversations are named (CAG-37)", () =>
    Effect.gen(function* () {
      const hold = Promise.withResolvers<void>()
      const held = FakeClaude.expectTurn({ hold: hold.promise })
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectStartup(),
          held,
          FakeClaude.expectInterrupt(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      const test = yield* setup(claude)
      const first = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      yield* ask(test.model, first, "session-a")
      const b = yield* ask(test.model, first, "session-b").pipe(Effect.forkChild)
      yield* Effect.promise(() => claude.started(held))
      // Asking only: nothing closes.
      expect(yield* test.registry.busy(test.configDir, false)).toEqual(["session-b"])
      expect(yield* test.registry.busy(path.join(test.root, "elsewhere"), true)).toEqual([])
      expect(ClaudeObserver.pool()?.live).toBe(2)
      // Before the move: a's idle process closes, b's turn goes on and is named.
      expect(yield* test.registry.busy(test.configDir, true)).toEqual(["session-b"])
      yield* Effect.promise(() => claude.runs[0]!.closed)
      expect(ClaudeObserver.pool()?.live).toBe(1)
      hold.resolve()
      yield* Fiber.join(b)
      yield* test.registry.close()
      claude.check()
    }),
  )

  it.live("with spares on, the next new conversation takes the process prewarmed after the last one", () =>
    Effect.gen(function* () {
      ClaudeObserver.configure({ spares: 1 })
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.configure({})))
      const spare = FakeClaude.expectStartup()
      const root = (yield* tmpdirScoped("own-native-")).path
      const configDir = path.join(root, "config")
      const directory = path.join(root, "work")
      fs.mkdirSync(directory, { recursive: true })
      yield* shareProjects(configDir)
      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          spare,
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectInterrupt(),
        ],
        { files: true },
      )
      // The SDK's prewarm stands in as a query started now whose first input waits for the claim; each waits for its
      // gate, so the script's order holds.
      const gates: Array<PromiseWithResolvers<void>> = []
      const claims: string[] = []
      const prewarm = async (host: Options): Promise<SpareProcess> => {
        const gate = Promise.withResolvers<void>()
        gates.push(gate)
        await gate.promise
        const { query } = await ClaudeSDK.load()
        const input = Promise.withResolvers<AsyncIterable<SDKUserMessage>>()
        const claimed = Promise.withResolvers<{ cwd: string; sessionId: string; sdkMcpSettled: boolean }>()
        const sessionId = crypto.randomUUID()
        const forward = async function* () {
          yield* await input.promise
        }
        // Started now, in the session's folder (the real spare parks elsewhere and moves at the claim).
        const started = query({ prompt: forward(), options: { ...host, cwd: directory, sessionId } })
        return {
          claim: (params) => {
            claims.push(sessionId)
            input.resolve(params.prompt as AsyncIterable<SDKUserMessage>)
            claimed.resolve({ cwd: params.options.cwd, sessionId, sdkMcpSettled: true })
            return started
          },
          claimed: claimed.promise,
          exited: new Promise<void>(() => {}),
          close: () => started.close(),
          [Symbol.asyncDispose]: async () => started.close(),
        } as SpareProcess
      }
      const saved = storage()
      const registry = ClaudeSessions.registry()
      yield* Effect.addFinalizer(() => registry.close())
      const io = { ...nativeIO(claude), prewarm }
      const status = yield* ClaudeStatus.make(io, () => Effect.succeed({ CLAUDE_CONFIG_DIR: configDir }))
      const sessions = yield* registry.attach({ io, status, storage: saved, directory })
      const context = yield* Effect.context<never>()
      const model = new ClaudeAgentLanguageModel.Model(
        "haiku",
        { run: (request, signal) => Effect.runPromiseWith(context)(sessions.run(request), { signal }) },
        ClaudeQueryOptions.connectionEnv({ settings: { configDir } }),
      )
      const first = [system, user("Remember the marker COPPER-OTTER. Reply only with that marker.")]
      yield* ask(model, first, "session-a")
      // After a's turn the spare starts (its gate opens), before any new conversation asks for it.
      gates[0]!.resolve()
      yield* Effect.promise(() => claude.reached(spare))
      expect(claude.runs).toHaveLength(2)
      expect(claude.runs[1]!.args.some((arg) => arg.startsWith("--session-id=") || arg.startsWith("--resume="))).toBe(
        true,
      )
      yield* ask(model, first, "session-b")
      // b ran on the spare: no claude was started for it, and its conversation is the spare's.
      expect(claude.runs).toHaveLength(2)
      expect(claims).toHaveLength(1)
      expect((yield* recordOf(saved, "session-b"))!.claudeSessionID).toBe(claims[0]!)
      expect(sent(claude.runs[1]!)).toEqual(["Remember the marker COPPER-OTTER. Reply only with that marker."])
      // b's start asked for the next spare, which waits at its gate.
      expect(gates).toHaveLength(2)
      yield* registry.close()
      claude.check()
    }),
  )
})
// OWN-PATCH(P-043) end
