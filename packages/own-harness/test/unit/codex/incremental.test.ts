// Codex's incremental tools windows (rust-v0.165.0, incremental.ts): a window a Responses Lite model opened keeps its
// prefix across a change of model, and the step on the new model gets `<model_instructions>` and the new
// `<collaboration_mode>` (Codex's scenario snapshots all__suite__scenarios__incremental_tools__incremental_tools.snap and
// all__suite__scenarios__model_instructions__incremental_model_instructions.snap); other windows keep `<model_switch>`.
import { describe, expect, test } from "bun:test"
import { Message, SystemPart } from "@opencode/ai/effect"
import { Checkpoint } from "../../../src/checkpoint.js"
import { Catalog } from "../../../src/codex/catalog.js"
import { CodexEffort } from "../../../src/codex/effort.js"
import { Fragments } from "../../../src/codex/fragments.js"
import { CodexIncremental } from "../../../src/codex/incremental.js"
import { CodexRequest } from "../../../src/codex/request.js"

const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"
const ASTRA = "gpt-6-astra"
const DIRECT = "gpt-5.5"

const SESSION: CodexRequest.Session = {
  model: SOL,
  sessionID: "ses_incremental",
  responses: true,
  cwd: "C:\\work\\app",
  mode: "full",
  reads: false,
  shell: "powershell",
  timezone: "Asia/Seoul",
  plan: false,
  skills: [],
  freeform: true,
}

const user = (id: string) => Message.make({ id, role: "user", content: `question ${id}` })
const assistant = (id: string) => Message.make({ id, role: "assistant", content: `answer ${id}` })
const checkpoint = (id: string) =>
  Message.make({ id, role: "user", content: Checkpoint.render("## Objective\n- Keep going.", []) })

function build(messages: Array<Message>, session: Partial<CodexRequest.Session>) {
  const draft: CodexRequest.Draft = {
    system: [
      SystemPart.make("You are an AI agent running in OpenCode, a coding agent harness."),
      SystemPart.make("Today's date: Sun Oct 11 2026"),
    ],
    messages,
    options: {},
    tools: {
      exec: { description: "exec", input: { type: "object" } },
      wait: { description: "wait", input: {} },
      request_user_input: { description: "ask", input: {} },
    },
  }
  CodexRequest.build(draft, { ...SESSION, ...session })
  return draft
}

const text = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : part.type))
const base = (model: string) => Catalog.instructions(Catalog.lookup(model))
const collaboration = (model: string) => Fragments.collaboration(false, Catalog.lookup(model))
/** The developer texts right before a message, back to the previous message of the conversation. */
const before = (draft: CodexRequest.Draft, id: string) => {
  const at = draft.messages.findIndex((message) => message.id === id)
  const start = draft.messages.slice(0, at).findLastIndex((message) => message.role !== "system")
  return draft.messages
    .slice(start + 1, at)
    .filter((message) => !CodexEffort.isUpdate(message))
    .flatMap(text)
}
const all = (draft: CodexRequest.Draft) => draft.messages.flatMap(text).join("\n")

describe("Responses Lite windows (incremental tools)", () => {
  test("a change of model keeps the window's prefix and appends <model_instructions> and the new collaboration text", () => {
    const first = build([user("u1")], {})
    const switched = build([user("u1"), assistant("a1"), user("u2")], {
      model: TERRA,
      steps: new Map([["a1", { model: SOL }]]),
      switches: new Map([["u2", TERRA]]),
    })
    // The prefix is the request Sol's window opened with, byte for byte: Sol's base and collaboration text.
    const prefix = first.messages.findIndex((message) => message.id === "u1")
    expect(JSON.stringify(switched.messages.slice(0, prefix))).toBe(JSON.stringify(first.messages.slice(0, prefix)))
    expect(text(switched.messages[0]!)).toEqual([base(SOL)])
    expect(text(switched.messages[1]!).at(-1)).toBe(collaboration(SOL))
    expect(base(TERRA)).not.toBe(base(SOL))
    expect(collaboration(TERRA)).not.toBe(collaboration(SOL))
    expect(before(switched, "u2")).toEqual([
      `<model_instructions>\nThe current model is ${TERRA}.\nThe following instructions replace the previous base instructions:\n\n${base(TERRA)}\n</model_instructions>`,
      collaboration(TERRA),
    ])
    expect(all(switched)).not.toContain("<model_switch>")
  })

  test("the same base names the model only; a Direct step gets <model_switch>, and the next Lite model its base again", () => {
    const draft = build(
      [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3"), assistant("a3"), user("u4")],
      {
        model: SOL,
        steps: new Map([
          ["a1", { model: TERRA }],
          ["a2", { model: ASTRA }],
          ["a3", { model: DIRECT }],
        ]),
        switches: new Map([
          ["u2", ASTRA],
          ["u3", DIRECT],
          ["u4", SOL],
        ]),
      },
    )
    expect(text(draft.messages[0]!)).toEqual([base(TERRA)])
    // Terra and Astra render the same base instructions.
    expect(base(ASTRA)).toBe(base(TERRA))
    expect(before(draft, "u2")).toEqual([
      `<model_instructions>\nThe current model is ${ASTRA}.\n</model_instructions>`,
      collaboration(ASTRA),
    ])
    expect(before(draft, "u3")).toEqual([
      `<model_switch>\nThe user was previously using a different model. Please continue the conversation according to the following instructions:\n\n${base(DIRECT)}\n</model_switch>`,
      collaboration(DIRECT),
    ])
    // A step outside Responses Lite recorded only its model, so the next Lite model sends its base again.
    expect(before(draft, "u4")).toEqual([CodexIncremental.instructions(SOL, base(SOL)), collaboration(SOL)])
  })

  test("a window that opened outside Responses Lite stays ordinary, on a Lite model too", () => {
    const draft = build([user("u1"), assistant("a1"), user("u2")], {
      model: SOL,
      steps: new Map([["a1", { model: DIRECT }]]),
      switches: new Map([["u2", SOL]]),
    })
    expect(text(draft.messages[0]!)).toEqual([base(SOL)])
    expect(text(draft.messages[1]!).at(-1)).toBe(collaboration(SOL))
    expect(before(draft, "u2")).toEqual([
      `<model_switch>\nThe user was previously using a different model. Please continue the conversation according to the following instructions:\n\n${base(SOL)}\n</model_switch>`,
    ])
    expect(all(draft)).not.toContain("<model_instructions>")
  })

  test("a completed compaction opens a new window on the model its first step ran on", () => {
    const draft = build([checkpoint("k1"), user("u2"), assistant("a2"), user("u3")], {
      model: TERRA,
      steps: new Map([["a2", { model: TERRA }]]),
      switches: new Map([["u2", TERRA]]),
    })
    expect(text(draft.messages[0]!)).toEqual([base(TERRA)])
    expect(all(draft)).not.toContain("<model_instructions>")
    expect(all(draft)).not.toContain("<model_switch>")
  })

  test("a route without Responses keeps <model_switch> as user text", () => {
    const draft = build([user("u1"), assistant("a1"), user("u2")], {
      model: TERRA,
      responses: false,
      freeform: false,
      steps: new Map([["a1", { model: SOL }]]),
      switches: new Map([["u2", TERRA]]),
    })
    expect(before(draft, "u2")).toEqual([])
    const at = draft.messages.findIndex((message) => message.id === "u2")
    expect(text(draft.messages[at - 1]!)[0]).toStartWith("<model_switch>\n")
    expect(all(draft)).not.toContain("<model_instructions>")
  })

  test("<model_instructions> as Codex renders it: the model, the replacement, or the removal of the base", () => {
    expect(CodexIncremental.instructions(undefined, "Check your work before responding.")).toBe(
      "<model_instructions>\nThe following instructions replace the previous base instructions:\n\nCheck your work before responding.\n</model_instructions>",
    )
    expect(CodexIncremental.instructions("updated-tools-model", "Review results before responding.")).toBe(
      "<model_instructions>\nThe current model is updated-tools-model.\nThe following instructions replace the previous base instructions:\n\nReview results before responding.\n</model_instructions>",
    )
    expect(CodexIncremental.instructions("m", "")).toBe(
      "<model_instructions>\nThe current model is m.\nThe previous base instructions no longer apply. No replacement base instructions are active.\n</model_instructions>",
    )
  })
})
