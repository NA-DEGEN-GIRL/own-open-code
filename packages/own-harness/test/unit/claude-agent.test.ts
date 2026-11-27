// own's harnesses on upstream's Claude Agent provider (own/reports/claude-agent-provider-2026-10-31.md §4.3, 2026-10-31
// decisions): `claude-code` is the opencode path with Claude Code's prompt in front and the default for new sessions on
// the provider; codex, pi and dsh hand their whole system to the provider's options (the only place its model reads the
// system from) in every request kind, and Codex offers a JSON apply_patch there. Other providers and the other
// harnesses are left exactly as before. The request hooks run over an in-memory fake of the plugin context; the
// provider's own hooks are stood in for by the options they leave behind.
import { describe, expect, test } from "bun:test"
import { Message, SystemPart } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionCompaction, SessionContext } from "@opencode/plugin/effect/session"
import { SessionID } from "@opencode/schema/session-id"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnHarnessRouting } from "@own/protocol/rpc-harness-routing"
import { Effect, Scope } from "effect"
import { Catalog } from "../../src/codex/catalog.js"
import type { Collab } from "../../src/codex/collab.js"
import type { CollabV1 } from "../../src/codex/collab-v1.js"
import { CodexVariant } from "../../src/codex/variant.js"
import { DshPrompt } from "../../src/dsh/prompt.js"
import { Gate } from "../../src/gate.js"
import { Hooks } from "../../src/hooks.js"
import { Notice } from "../../src/notice.js"
import { PiPrompt } from "../../src/pi/prompt.js"
import { Prompts } from "../../src/prompts.js"
import { Registry } from "../../src/registry.js"
import { Sessions } from "../../src/sessions.js"

const SESSION = SessionID.make("ses_claude_agent_aaaaaaaaaaaa")
const CHILD = SessionID.make("ses_claude_agent_child_aaaaaa")
const CWD = "C:\\work\\app"
const ROLE = OwnHarness.CLAUDE_AGENT_ROLE
const INSTRUCTIONS = OwnHarness.CLAUDE_AGENT_INSTRUCTIONS
const CLAUDE = { providerID: OwnHarness.CLAUDE_AGENT, id: "opus" }
const ANTHROPIC = { providerID: "anthropic", id: "claude-opus-5-5" }

/** Core's instruction baseline: AGENTS.md, the date, the environment and one of own's entries (a team role). */
const BASELINE = [
  `Instructions from: ${CWD}\\AGENTS.md`,
  "AGENTS-MD-TEXT",
  "",
  "Today's date: Sat Oct 31 2026",
  "",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  `  Working directory: ${CWD}`,
  "</env>",
  "",
  '<context key="own.team.role">',
  "TEAM-ROLE-TEXT",
  "</context>",
].join("\n")

const KINDS = ["context", "compaction", "generate"] as const

/** The provider's hooks ran first: core's role and instructions, as it copies them. */
const PROVIDER = { [ROLE]: "PROVIDER-ROLE", [INSTRUCTIONS]: "PROVIDER-INSTRUCTIONS" }

function event(model: { providerID: string; id: string }, options: Record<string, unknown> = {}) {
  const input = { type: "object", properties: { path: { type: "string" } } }
  const tool = (description: string) => ({ description, input: { ...input } })
  // SAFETY: the request shape core hands the hooks, with only the fields the transform reads.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    sessionID: SESSION,
    agent: "build",
    model,
    system: [
      SystemPart.make("CORE-AGENT-PROMPT"),
      SystemPart.make(`# Your Model\n- Name: Opus\n- Provider ID: ${model.providerID}\n- Model ID: ${model.id}`),
      SystemPart.make(BASELINE),
      SystemPart.make("OWN-PLUGIN-PART"),
    ],
    messages: [Message.make({ id: "msg_user_1", role: "user", content: "Fix the parser." })],
    options: { ...options },
    tools: {
      shell: tool("core shell"),
      read: tool("core read"),
      edit: tool("core edit"),
      write: tool("core write"),
      exec_command: tool("Runs a command."),
      write_stdin: tool("Writes to a session."),
      apply_patch: {
        description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool.",
        input: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
      },
      pi_read: tool("Pi read"),
      pi_bash: tool("Pi bash"),
      dsh_read: tool("dsh read"),
      dsh_pwsh: tool("dsh pwsh"),
      dsh_bash: tool("dsh bash"),
      subagent: tool("Runs a subagent."),
    },
  } as unknown as SessionCompaction
}

function fake(harness: OwnHarness.HarnessID) {
  const hooks = new Map<string, (event: SessionContext) => Effect.Effect<unknown>>()
  const stored = new Map<string, unknown>()
  // SAFETY: the fake implements what the request hooks call: session hooks, the session and its history, the model
  // list (no package is OpenAI Responses or DeepSeek), skills, agents (none with its own prompt) and plugin storage.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const ctx = {
    session: {
      hook: (kind: string, run: (event: SessionContext) => Effect.Effect<unknown>) =>
        Effect.sync(() => void hooks.set(kind, run)),
      get: (input: { sessionID: string }) =>
        Effect.succeed({
          id: input.sessionID,
          metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness, "own") },
          permissions: [],
        }),
      context: () => Effect.succeed([]),
    },
    model: {
      list: () =>
        Effect.succeed({
          data: [
            { ...CLAUDE, package: "@opencode/claude-agent", enabled: true },
            { ...ANTHROPIC, package: "@opencode/ai/providers/anthropic", enabled: true },
          ],
        }),
    },
    skill: { list: () => Effect.succeed({ data: [] }) },
    agent: { get: () => Effect.fail(new Error("no agent")) },
    location: { directory: CWD },
    storage: {
      get: (key: string) => Effect.sync(() => stored.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => void stored.set(key, value)),
      remove: (key: string) => Effect.sync(() => void stored.delete(key)),
    },
  } as unknown as Parameters<typeof Hooks.register>[0]
  // SAFETY: the request hooks read a codex session's agent path and fork, and remember its history.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const tree = {
    path: () => "/root",
    forked: () => Effect.succeed(undefined),
    remember: () => {},
  } as unknown as Collab.Tree
  Effect.runSync(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Hooks.register(ctx, tree, {} as CollabV1.Tree, []).pipe(Scope.provide(scope))
    }),
  )
  return (kind: (typeof KINDS)[number], request: SessionCompaction) =>
    Effect.runPromise(hooks.get(kind)!(request)).then(() => request)
}

const joined = (request: SessionContext) => request.system.map((part) => part.text).join("\n\n")
const count = (text: string, part: string) => text.split(part).length - 1

describe("the claude-code harness", () => {
  test("is opencode's request under its own id: core's tools, no gate of its own, offered after the others", () => {
    expect(Registry.get("claude-code")).toBe(Registry.claudeCode)
    expect(Registry.claudeCode.tools).toBe(Registry.opencode.tools)
    expect(Registry.ALL.map((harness) => harness.id)).toEqual(["opencode", "codex", "pi", "dsh", "omo", "claude-code"])
    expect(OwnHarnessRouting.IDS.at(-1)).toBe("claude-code")
    expect(OwnHarness.harnessOf({ [OwnHarness.META_KEY]: { id: "claude-code", v: 1 } })).toBe("claude-code")
    // Moving to it drops the previous harness's allow rule and adds none.
    const rules = [{ action: "read", resource: "*", effect: "allow" as const }, { ...Gate.ALLOW }]
    expect(Gate.rules(rules, "claude-code")).toEqual([rules[0]!])
  })

  test("the switch notice renames Codex's calls to core's tools", () => {
    expect(Notice.text("codex", "claude-code")).toBe(
      [
        "<harness_switch>",
        "This session now runs the claude-code harness (before: codex).",
        "Earlier exec_command and apply_patch calls are shown as shell and patch.",
        "Use only the tools offered in this request; earlier calls to other tools are history.",
        "</harness_switch>",
      ].join("\n"),
    )
  })
})

describe("Sessions.stamp on the Claude Agent provider", () => {
  function sessions(initial: Record<string, Record<string, unknown>>) {
    const metadata = new Map(Object.entries(initial))
    // SAFETY: stamp reads and updates the session's metadata and rules only.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const ctx = {
      session: {
        get: (input: { sessionID: string }) =>
          Effect.succeed({ id: input.sessionID, metadata: metadata.get(input.sessionID) }),
        update: (input: { sessionID: string; metadata: Record<string, unknown> }) =>
          Effect.sync(() => void metadata.set(input.sessionID, input.metadata)),
      },
    } as unknown as Pick<Context, "session">
    return { ctx, metadata }
  }

  test("a new top-level session on claude-agent that names no harness gets claude-code, other providers the default", async () => {
    const env = sessions({ [SESSION]: {}, [CHILD]: {} })
    await Effect.runPromise(
      Sessions.stamp(env.ctx, { sessionID: SESSION, metadata: {}, model: CLAUDE }, "codex", "own"),
    )
    expect(env.metadata.get(SESSION)).toEqual({ "own.harness": { id: "claude-code", v: 1, prompt: "own" } })
    await Effect.runPromise(
      Sessions.stamp(env.ctx, { sessionID: CHILD, metadata: {}, model: ANTHROPIC }, "codex", "own"),
    )
    expect(env.metadata.get(CHILD)).toEqual({ "own.harness": { id: "codex", v: 1, prompt: "own" } })
  })

  test("children inherit their parent's harness, and a named harness stays", async () => {
    const env = sessions({ [SESSION]: { "own.harness": { id: "pi", v: 1 } }, [CHILD]: {} })
    const child = { sessionID: CHILD, parentID: SESSION, metadata: {}, model: CLAUDE }
    await Effect.runPromise(Sessions.stamp(env.ctx, child, "codex", "own"))
    expect(env.metadata.get(CHILD)).toEqual({ "own.harness": { id: "pi", v: 1 } })
    const named = sessions({ [SESSION]: { "own.harness": { id: "dsh", v: 1 } } })
    const created = { sessionID: SESSION, metadata: { "own.harness": { id: "dsh", v: 1 } }, model: CLAUDE }
    await Effect.runPromise(Sessions.stamp(named.ctx, created, "codex", "own"))
    expect(named.metadata.get(SESSION)).toEqual({ "own.harness": { id: "dsh", v: 1 } })
  })
})

describe("delivery: codex, pi and dsh hand their system to the Claude Agent provider", () => {
  const MARKS = {
    codex: CodexVariant.PATCH_TOOL,
    pi: PiPrompt.PREAMBLE,
    dsh: DshPrompt.IDENTITY,
  } as const

  for (const harness of ["codex", "pi", "dsh"] as const)
    for (const kind of KINDS)
      test(`${harness}, ${kind}: the role is the harness's whole system, the instructions are empty`, async () => {
        const request = await fake(harness)(kind, event(CLAUDE, PROVIDER))
        const role = String(request.options[ROLE])
        expect(role).toBe(joined(request))
        expect(request.options[INSTRUCTIONS]).toBe("")
        expect(role).toContain(MARKS[harness])
        // Core's agent prompt gave way to the harness's; what core put after it is there once.
        expect(role).not.toContain("CORE-AGENT-PROMPT")
        expect(count(role, "OWN-PLUGIN-PART")).toBe(1)
        expect(count(role, "TEAM-ROLE-TEXT")).toBe(1)
        // AGENTS.md: in Pi's prompt; Codex and dsh send it as a user message, which reaches Claude as it is.
        const messages = JSON.stringify(request.messages)
        expect(count(role, "AGENTS-MD-TEXT") + count(messages, "AGENTS-MD-TEXT")).toBe(1)
        expect(count(role, "AGENTS-MD-TEXT")).toBe(harness === "pi" ? 1 : 0)
      })

  for (const harness of ["opencode", "claude-code", "omo"] as const)
    test(`${harness} leaves the provider's role and instructions as they are`, async () => {
      for (const kind of KINDS) {
        const request = await fake(harness)(kind, event(CLAUDE, PROVIDER))
        expect([request.options[ROLE], request.options[INSTRUCTIONS]]).toEqual([
          "PROVIDER-ROLE",
          "PROVIDER-INSTRUCTIONS",
        ])
        expect(joined(request)).toContain("CORE-AGENT-PROMPT")
      }
    })

  for (const harness of ["codex", "pi", "dsh", "claude-code"] as const)
    test(`${harness} on another provider writes neither option`, async () => {
      for (const kind of KINDS) {
        const request = await fake(harness)(kind, event(ANTHROPIC))
        expect(ROLE in request.options).toBe(false)
        expect(INSTRUCTIONS in request.options).toBe(false)
      }
    })
})

describe("Codex's apply_patch on the Claude Agent provider", () => {
  test("goes as a JSON {input} tool, and the base instructions point at it", async () => {
    const request = await fake("codex")("context", event(CLAUDE, PROVIDER))
    const patch = request.tools.apply_patch!
    expect(Object.keys(request.tools).slice(0, 3)).toEqual(["exec_command", "write_stdin", "apply_patch"])
    expect(patch.input).toEqual({ type: "object", properties: { input: { type: "string" } }, required: ["input"] })
    expect(patch.description).toBe(CodexVariant.PATCH_TOOL_DESCRIPTION)
    const base = request.system[0]!.text
    expect(base).toBe(CodexVariant.instructions(Catalog.lookup("opus"), "own", undefined, true))
    expect(base).toContain(CodexVariant.PATCH_TOOL)
    expect(base).not.toContain(CodexVariant.PATCH)
    expect(base).not.toContain("There is no `apply_patch` tool")
  })

  test("elsewhere off Responses it stays out, and the text keeps exec_command's heredoc", async () => {
    const request = await fake("codex")("context", event(ANTHROPIC))
    expect(request.tools.apply_patch).toBeUndefined()
    expect(request.system[0]!.text).toBe(CodexVariant.instructions(Catalog.lookup("claude-opus-5-5"), "own"))
    expect(request.system[0]!.text).toContain(CodexVariant.PATCH)
  })

  test("every tier's text swaps own's exec_command section for the tool's", () => {
    const lean = Catalog.lookup("claude-opus-5-5")
    expect(CodexVariant.instructions(lean, "own", undefined, true)).toBe(
      CodexVariant.LEAN.replace(CodexVariant.PATCH, CodexVariant.PATCH_TOOL),
    )
    const custom = `Mine.\n\n${CodexVariant.PATCH_SLOT}`
    expect(CodexVariant.instructions(lean, "custom", custom, true)).toBe(`Mine.\n\n${CodexVariant.PATCH_TOOL}`)
    // Codex's own text (원본) names the apply_patch tool already.
    expect(CodexVariant.instructions(lean, "reference", undefined, true)).toBe(Catalog.instructions(lean))
    expect(CodexVariant.instructions(lean, "own")).toBe(CodexVariant.LEAN)
  })
})

describe("prompt.preview on the Claude Agent provider", () => {
  // SAFETY: the preview reads the model list, the tool registry, plugin storage and the Location only.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const ctx = {
    model: {
      list: () =>
        Effect.succeed({
          data: [
            { ...CLAUDE, name: "Opus", enabled: true, package: "@opencode/claude-agent" },
            { ...ANTHROPIC, name: "Claude Opus 5.5", enabled: true },
          ],
        }),
    },
    tool: {
      list: () =>
        Effect.succeed([
          { id: "exec_command", description: "Runs a command.", options: { permission: Gate.ACTION } },
          { id: "apply_patch", description: "Freeform apply_patch.", options: { permission: Gate.ACTION } },
          { id: "websearch", description: "Core's search.", options: {} },
        ]),
    },
    storage: { get: () => Effect.succeed(undefined) },
    location: { directory: CWD },
  } as unknown as Parameters<typeof Prompts.preview>[0]
  const claude = { providerID: CLAUDE.providerID, modelID: CLAUDE.id }
  const preview = (input: Prompts.Input) => Effect.runPromise(Prompts.preview(ctx, input))

  test("claude-code: Claude Code's own prompt, then OpenCode's agent role and instructions; nothing to edit", async () => {
    const view = await preview({ harness: "claude-code", prompt: "custom", model: claude })
    expect(view).toMatchObject({ harness: "claude-code", applied: "reference", tools: [], changes: [] })
    expect(view.tier).toBeUndefined()
    expect(view.parts.map((part) => [part.kind, part.role, part.editable])).toEqual([
      ["base", "system", false],
      ["context", "system", false],
      ["context", "system", false],
    ])
    expect(view.parts[0]!.text).toContain("Claude Code's own system prompt")
    expect(view.parts[1]!.text).toStartWith("# Agent role (from OpenCode)\n")
    // Elsewhere it is opencode: core's prompt.
    const other = await preview({
      harness: "claude-code",
      prompt: "own",
      model: { providerID: "anthropic", modelID: "claude-opus-5-5" },
    })
    expect(other.parts.map((part) => part.text)).toEqual([
      "(OpenCode's own prompt: off the Claude Agent provider, claude-code runs as opencode)",
    ])
  })

  test("codex shows the JSON apply_patch and own's text for it", async () => {
    const view = await preview({ harness: "codex", prompt: "own", model: claude })
    expect(view.parts[0]!.text).toContain(CodexVariant.PATCH_TOOL)
    expect(view.tools.map((tool) => [tool.name, tool.description])).toEqual([
      ["exec_command", "Runs a command."],
      ["apply_patch", CodexVariant.PATCH_TOOL_DESCRIPTION],
    ])
    const other = await preview({
      harness: "codex",
      prompt: "own",
      model: { providerID: "anthropic", modelID: "claude-opus-5-5" },
    })
    expect(other.tools.map((tool) => tool.name)).toEqual(["exec_command"])
    expect(other.parts[0]!.text).toBe(CodexVariant.LEAN)
  })
})

describe("side questions (곁질문, 02 §9.7)", () => {
  // A side question is a `generate` request with `side: true` (core P-061): it takes the next sampling request's shape,
  // so its prefix reads the conversation's cache, and leaves nothing behind (no dsh snapshot, no remembered history).
  for (const harness of ["codex", "pi", "dsh", "opencode", "claude-code"] as const)
    test(`${harness}: a side generate request is shaped like the context request`, async () => {
      const run = fake(harness)
      const context = await run("context", event(ANTHROPIC))
      const side = Object.assign(event(ANTHROPIC), { side: true as const })
      await run("generate", side)
      expect(joined(side)).toBe(joined(context))
      expect(JSON.stringify(side.messages)).toBe(JSON.stringify(context.messages))
      expect(Object.keys(side.tools)).toEqual(Object.keys(context.tools))
    })
})