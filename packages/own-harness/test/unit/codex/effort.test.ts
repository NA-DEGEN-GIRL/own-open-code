// Codex's reasoning-effort updates (codex-rs/core/src/session/reasoning_effort.rs, rust-v0.165.0, and its suites
// core/tests/suite/reasoning_effort_override.rs and compact.rs
// `reasoning_effort_override_remote_v2_compaction_resets_pinned_effort`), replayed from own's stored history: where
// the updates go, and the request effort they leave.
import { describe, expect, test } from "bun:test"
import { Message, SystemPart, ToolCallPart } from "@opencode/ai/effect"
import { Checkpoint } from "../../../src/checkpoint.js"
import { CodexEffort } from "../../../src/codex/effort.js"
import { CodexRequest } from "../../../src/codex/request.js"

const user = (id: string, text = id) => Message.make({ id, role: "user", content: text })
const assistant = (id: string, text = `answer ${id}`) => Message.make({ id, role: "assistant", content: text })
const call = (id: string, callID: string) =>
  Message.make({ id, role: "assistant", content: [ToolCallPart.make({ id: callID, name: "exec", input: {} })] })
const result = (callID: string) => Message.tool({ id: callID, name: "exec", result: "done", resultType: "text" })
const checkpoint = (id: string) =>
  Message.make({ id, role: "user", content: Checkpoint.render("## Objective\n- Keep going.", []) })

/** Each entry as a short label: the message id, or `effort:<effort>` for an update. */
const shape = (history: ReadonlyArray<Message>) =>
  history.map((entry) => {
    const part = entry.content[0]
    if (entry.role === "system" && part?.type === "effort") return `effort:${part.effort}`
    return entry.id ?? `${entry.role}`
  })

const previous = (history: ReadonlyArray<Message>) =>
  history.flatMap((entry) => (entry.content[0]?.type === "effort" ? [entry.content[0].previous] : []))

const SOL = "gpt-6.1-sol"
const steps = (entries: ReadonlyArray<readonly [string, string, string?]>) =>
  new Map(entries.map(([id, variant, model]) => [id, { model: model ?? SOL, variant }]))

function apply(history: ReadonlyArray<Message>, input: Partial<CodexEffort.Input> = {}) {
  return CodexEffort.apply({
    history,
    steps: new Map(),
    model: SOL,
    effort: "high",
    enabled: (model) => CodexEffort.enabled(model, true),
    sampling: true,
    ...input,
  })
}

describe("CodexEffort.enabled", () => {
  test("catalog models that take updates, on a route that takes them", () => {
    expect(
      ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.1-terra-fast"].map((id) => CodexEffort.enabled(id, true)),
    ).toEqual([true, true, true, true])
    // Codex's catalog says no (or nothing) for these; a model outside it gets Codex's fallback metadata.
    expect(
      ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5", "own-unknown-model"].map((id) =>
        CodexEffort.enabled(id, true),
      ),
    ).toEqual([false, false, false, false, false])
    expect(CodexEffort.enabled(SOL, false)).toBe(false)
  })
})

describe("CodexEffort.apply", () => {
  test("the first request: one update after the first user message, the request at that effort", () => {
    const placed = apply([user("u1")])
    expect(shape(placed.history)).toEqual(["u1", "effort:high"])
    expect(placed.effort).toBe("high")
    expect(previous(placed.history)).toEqual(["high"])
  })

  test("later steps and turns at the same effort add none; the update stays where it was recorded", () => {
    const history = [user("u1"), call("a1", "c1"), result("c1"), assistant("a2"), user("u2")]
    const placed = apply(history, {
      steps: steps([
        ["a1", "high"],
        ["a2", "high"],
      ]),
    })
    expect(shape(placed.history)).toEqual(["u1", "effort:high", "a1", "tool", "a2", "u2"])
    expect(placed.effort).toBe("high")
  })

  test("an effort change adds exactly one update after that turn's input; the request keeps the window's effort", () => {
    // Turn 1 at high, turn 2 changed to low (now), as Codex's
    // reasoning_effort_override_preserves_prefix_and_only_appends_on_change.
    const history = [user("u1"), assistant("a1"), user("u2")]
    const placed = apply(history, { steps: steps([["a1", "high"]]), effort: "low" })
    expect(shape(placed.history)).toEqual(["u1", "effort:high", "a1", "u2", "effort:low"])
    // core sends `previous` of the first update as `reasoning.effort`, and the newest update's effort is the request's.
    expect(previous(placed.history)).toEqual(["high", "high"])
    expect(placed.effort).toBe("low")
    // The next turn at low: nothing new. Back to high: one more (compared with the newest update, not the pin).
    const third = apply([...history, assistant("a2"), user("u3")], {
      steps: steps([
        ["a1", "high"],
        ["a2", "low"],
      ]),
      effort: "low",
    })
    expect(shape(third.history)).toEqual(["u1", "effort:high", "a1", "u2", "effort:low", "a2", "u3"])
    const back = apply([...history, assistant("a2"), user("u3")], {
      steps: steps([
        ["a1", "high"],
        ["a2", "low"],
      ]),
    })
    expect(shape(back.history)).toEqual(["u1", "effort:high", "a1", "u2", "effort:low", "a2", "u3", "effort:high"])
    expect(previous(back.history)).toEqual(["high", "high", "high"])
  })

  test("the default variant is the catalog's default effort; a variant that names no effort changes nothing", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]
    const placed = apply(history, {
      steps: steps([
        ["a1", "default"],
        ["a2", "turbo"],
      ]),
      effort: "low",
    })
    // gpt-6.1-sol's catalog default is `low`.
    expect(shape(placed.history)).toEqual(["u1", "effort:low", "a1", "u2", "a2", "u3"])
    expect(placed.effort).toBe("low")
  })

  test("after a completed compaction: no update, the first effort becomes the pin; a change then adds one", () => {
    // Codex: compaction drops the updates and lets the next sampling pin its effort without one.
    const same = apply([checkpoint("k1"), user("u3")], { effort: "high" })
    expect(shape(same.history)).toEqual(["k1", "u3"])
    expect(same.effort).toBe("high")
    const history = [checkpoint("k1"), user("u3"), assistant("a3"), user("u4")]
    const changed = apply(history, { steps: steps([["a3", "high"]]), effort: "low" })
    expect(shape(changed.history)).toEqual(["k1", "u3", "a3", "u4", "effort:low"])
    expect(previous(changed.history)).toEqual(["high"])
  })

  test("a compaction request records no update and keeps the pinned effort", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2")]
    const placed = apply(history, {
      steps: steps([
        ["a1", "medium"],
        ["a2", "high"],
      ]),
      effort: "low",
      sampling: false,
    })
    expect(shape(placed.history)).toEqual(["u1", "effort:medium", "a1", "u2", "effort:high", "a2"])
    expect(previous(placed.history)).toEqual(["medium", "medium"])
    // The request's own effort is the newest update's, so core keeps the updates and sends `medium` at the top.
    expect(placed.effort).toBe("high")
  })

  test("a switch to another model that takes updates sets its own baseline; one that takes none unsets the pin", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]
    const astra = apply(history, {
      steps: steps([
        ["a1", "high"],
        ["a2", "high"],
      ]),
      model: "gpt-6-astra",
      effort: "high",
    })
    // reasoning_effort_override_model_switch_reestablishes_selected_effort: the same effort is recorded again.
    expect(shape(astra.history)).toEqual(["u1", "effort:high", "a1", "u2", "a2", "u3", "effort:high"])
    const viaOlder = apply(history, {
      steps: steps([
        ["a1", "high"],
        ["a2", "high", "gpt-5.5"],
      ]),
      effort: "high",
    })
    expect(shape(viaOlder.history)).toEqual(["u1", "effort:high", "a1", "u2", "a2", "u3", "effort:high"])
  })

  test("a fork's inherited updates count: a matching one at the tail is reused, the parent's pin carries over", () => {
    const parent = [user("u1"), Message.effort({ effort: "low", previous: "medium" })]
    const placed = apply(parent, { effort: "low" })
    expect(shape(placed.history)).toEqual(["u1", "effort:low"])
    expect(previous(placed.history)).toEqual(["medium"])
  })
})

describe("CodexRequest.build with effort updates", () => {
  const SESSION: CodexRequest.Session = {
    model: SOL,
    sessionID: "ses_effort",
    responses: true,
    cwd: "C:\\work\\app",
    mode: "full",
    reads: false,
    shell: "powershell",
    plan: false,
    skills: [],
    freeform: true,
  }
  const draft = (messages: Array<Message>, options: Record<string, unknown> = {}) => ({
    system: [SystemPart.make("You are an AI agent running in OpenCode, a coding agent harness.")],
    messages,
    options,
    tools: { exec: { description: "exec", input: { type: "object" } } },
  })
  const conversation = (request: { messages: Array<Message> }) => shape(request.messages.slice(-5))

  test("core's marker at the variant switch gives way to Codex's after the turn's input; options carry the effort", () => {
    // Core's marker where the user switched from high to low, before the second prompt.
    const messages = [user("u1"), assistant("a1"), Message.effort({ effort: "low", previous: "high" }), user("u2")]
    const request = draft(messages, { reasoningEffort: "low" })
    CodexRequest.build(request, { ...SESSION, steps: steps([["a1", "high"]]) })
    expect(conversation(request)).toEqual(["u1", "effort:high", "a1", "u2", "effort:low"])
    expect(previous(request.messages)).toEqual(["high", "high"])
    expect(request.options.reasoningEffort).toBe("low")
  })

  test("the default variant sends the catalog's effort with its update", () => {
    const request = draft([user("u1")])
    CodexRequest.build(request, SESSION)
    expect(shape(request.messages.slice(-2))).toEqual(["u1", "effort:low"])
    expect(request.options.reasoningEffort).toBe("low")
  })

  test("an effort variant is the user's choice: the catalog's default never replaces it", () => {
    // Core puts the variant's effort on the model, under the request's options, so the options name none here.
    for (const session of [
      SESSION,
      { ...SESSION, model: "gpt-5.5" },
      { ...SESSION, responses: false, freeform: false },
    ]) {
      const request = draft([user("u1")])
      CodexRequest.build(request, { ...session, variant: "high" })
      expect(request.options.reasoningEffort).toBe(session.model === SOL && session.responses ? "high" : undefined)
    }
    const request = draft([user("u1")])
    CodexRequest.build(request, { ...SESSION, variant: "high" })
    expect(shape(request.messages.slice(-2))).toEqual(["u1", "effort:high"])
    expect(previous(request.messages)).toEqual(["high"])
  })

  test("Sign in with ChatGPT, generate calls and models without updates get none; their markers stay core's", () => {
    const core = Message.effort({ effort: "low", previous: "high" })
    for (const session of [
      { ...SESSION, effortUpdates: false },
      { ...SESSION, kind: "generate" as const },
      { ...SESSION, model: "gpt-6-sol" },
      { ...SESSION, responses: false, freeform: false },
    ]) {
      const request = draft([user("u1"), assistant("a1"), core, user("u2")], { reasoningEffort: "low" })
      CodexRequest.build(request, { ...session, steps: steps([["a1", "high"]]) })
      expect(shape(request.messages.slice(-4))).toEqual(["u1", "a1", "effort:low", "u2"])
      expect(request.options.reasoningEffort).toBe("low")
    }
  })

  test("a compaction request keeps the history's updates and adds none", () => {
    const request = draft([user("u1"), assistant("a1"), user("u2")], { reasoningEffort: "low" })
    CodexRequest.build(request, { ...SESSION, kind: "compaction", steps: steps([["a1", "low"]]) })
    expect(shape(request.messages.slice(-4))).toEqual(["u1", "effort:low", "a1", "u2"])
  })
})
