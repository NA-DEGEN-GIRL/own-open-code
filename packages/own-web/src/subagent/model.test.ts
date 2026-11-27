// Subagent model (03 §18.11): agent names from the session or core's title suffix, the ancestor chain for nested
// subagents, child state, which children the parent strip lists first, and the preset gate's refusals (07 §5.4).
import type { SessionMessageInfo } from "@opencode/client"
import type { JsonValue, SessionMessageAssistantTool } from "@opencode/client/promise"
// Test-only import: `model.ts` keeps its own copy of the prefix; this checks it against the gate's constant and sentences.
import { Preset } from "@own/protocol/preset"
import { describe, expect, test } from "bun:test"
import {
  agentOf,
  ancestry,
  childRows,
  childState,
  effortOf,
  presetRejection,
  PRESET_REJECTION_PREFIX,
  requestedEffort,
  requestedRef,
  roleEffort,
  taskTitle,
  type SessionFacts,
} from "./model"
import { subagentText } from "./strings"

test("agentOf and taskTitle read core's `<task> (@<agent> subagent)` title", () => {
  expect(agentOf({ title: "라우터 조사 (@explore subagent)" })).toBe("explore")
  expect(agentOf({ agent: "general", title: "x (@explore subagent)" })).toBe("general")
  expect(agentOf({ title: "보통 세션" })).toBeUndefined()
  expect(taskTitle("라우터 조사 (@explore subagent)")).toBe("라우터 조사")
  expect(taskTitle(undefined)).toBeUndefined()
})

describe("ancestry", () => {
  const sessions: Record<string, SessionFacts> = {
    root: { id: "root", title: "계정 라우터 RPC 설계" },
    child: { id: "child", parentID: "root", title: "조사 (@explore subagent)" },
    grand: { id: "grand", parentID: "child", title: "세부 (@general subagent)" },
    loop: { id: "loop", parentID: "loop" },
  }
  const get = (id: string) => sessions[id]
  test("root → child → grandchild", () => {
    expect(ancestry(get, "grand").map((item) => item.id)).toEqual(["root", "child", "grand"])
  })
  test("an unknown parent ends the chain with its id (it is loaded next); cycles stop", () => {
    expect(ancestry((id) => (id === "orphan" ? { id, parentID: "missing" } : undefined), "orphan")).toEqual([
      { id: "missing" },
      { id: "orphan", parentID: "missing" },
    ])
    expect(ancestry(get, "loop").map((item) => item.id)).toEqual(["loop"])
  })
})

test("childState", () => {
  expect(childState({ outcome: "succeeded" }, true)).toBe("running")
  expect(childState({ outcome: "failed" }, false)).toBe("failed")
  expect(childState(undefined, false)).toBe("idle")
})

test("childRows: waiting on the user first, then running, then the rest; active only if one needs attention", () => {
  const row = (id: string, state: "running" | "succeeded", requests: number, created: number) => ({
    id,
    state,
    requests,
    created,
  })
  const view = childRows([
    row("a", "succeeded", 0, 3),
    row("b", "running", 0, 1),
    row("c", "succeeded", 2, 0),
    row("d", "running", 0, 2),
  ])
  expect(view.rows.map((item) => item.id)).toEqual(["c", "d", "b", "a"])
  expect(view.active).toBe(true)
  expect(childRows([row("a", "succeeded", 0, 1)]).active).toBe(false)
})

describe("presetRejection (07 §5.4 거절 경로)", () => {
  const sentence =
    "own-preset: model not in this preset. Allowed roles: explore, own-review. Ask the user if another model is needed."
  const llmInput = { agent: "explore", description: "리뷰", prompt: "변경을 검토", model: "own-codex-02/gpt-6-sol" }
  const failed = (message: string, input: Record<string, JsonValue> = llmInput, name = "subagent") =>
    ({
      type: "tool",
      id: "call_1",
      name,
      state: { status: "error", input, error: { type: "ToolFailure", message } },
      time: { created: 1 },
    }) satisfies SessionMessageAssistantTool

  test("the gate's refusal: the model from the LLM's own input, the gate's sentence after the prefix", () => {
    expect(presetRejection(failed(`Unknown agent: ${sentence}`))).toEqual({
      requestedModel: "own-codex-02/gpt-6-sol",
      agent: "explore",
      reason: "model not in this preset. Allowed roles: explore, own-review. Ask the user if another model is needed.",
    })
    expect(PRESET_REJECTION_PREFIX).toBe("Unknown agent: own-preset:")
  })

  test("the prefix is core's `Unknown agent: ` plus the gate's Preset.REJECT_PREFIX; every gate sentence is a refusal", () => {
    expect(PRESET_REJECTION_PREFIX).toBe(`Unknown agent: ${Preset.REJECT_PREFIX}`)
    const sentences = [
      Preset.rejection({ reason: "model", roles: [] }),
      Preset.rejection({ reason: "model", roles: ["explore", "own-review"] }),
      Preset.rejection({ reason: "budget", roles: ["explore"] }),
      Preset.rejection({ reason: "off" }),
    ]
    for (const sentence of sentences)
      expect(presetRejection(failed(`Unknown agent: ${sentence}`))).toEqual({
        requestedModel: "own-codex-02/gpt-6-sol",
        agent: "explore",
        reason: sentence.slice(Preset.REJECT_PREFIX.length).trim(),
      })
  })

  test("no requested model when the LLM wrote none (or a blank one)", () => {
    const withoutModel = { agent: "explore", description: "리뷰", prompt: "변경을 검토" }
    expect(presetRejection(failed(`Unknown agent: ${sentence}`, withoutModel))).toEqual({
      agent: "explore",
      reason: "model not in this preset. Allowed roles: explore, own-review. Ask the user if another model is needed.",
    })
    expect(presetRejection(failed(`Unknown agent: ${sentence}`, { ...llmInput, model: " " }))?.requestedModel).toBe(
      undefined,
    )
    expect(presetRejection(failed(`Unknown agent: ${sentence}`, { ...llmInput, model: 5 }))?.requestedModel).toBe(
      undefined,
    )
  })

  test("the prefix counts only at the start of the failure text", () => {
    expect(presetRejection(failed(`Error: Unknown agent: ${sentence}`))).toBeUndefined()
    expect(presetRejection(failed(` Unknown agent: ${sentence}`))).toBeUndefined()
    expect(presetRejection(failed(`unknown agent: ${sentence}`))).toBeUndefined()
    expect(presetRejection(failed("Unknown agent: own-preset"))).toBeUndefined()
  })

  test("other subagent failures keep the failure card", () => {
    expect(presetRejection(failed("Unknown agent: reviewer"))).toBeUndefined()
    expect(
      presetRejection(
        failed('Subagent depth limit reached (1). Increase "experimental.subagent_depth" to allow nested subagents.'),
      ),
    ).toBeUndefined()
    expect(presetRejection(failed("Agent build cannot run as a subagent"))).toBeUndefined()
  })

  test("other tools, other states and non-tool content are never a refusal", () => {
    expect(presetRejection(failed(`Unknown agent: ${sentence}`, llmInput, "shell"))).toBeUndefined()
    expect(presetRejection(failed(`Unknown agent: ${sentence}`, llmInput, "task"))).toBeUndefined()
    expect(
      presetRejection({
        type: "tool",
        id: "call_2",
        name: "subagent",
        state: {
          status: "completed",
          input: llmInput,
          content: [{ type: "text", text: `Unknown agent: ${sentence}` }],
        },
        time: { created: 1 },
      }),
    ).toBeUndefined()
    expect(presetRejection({ type: "text", text: `Unknown agent: ${sentence}` })).toBeUndefined()
    expect(presetRejection(undefined)).toBeUndefined()
  })

  test("chip wording (07 §7.3): the model with its particle, or the plain line without a model", () => {
    expect(subagentText.text("ko", "own.subagent.rejected.model", { model: "own-codex-02/gpt-6-sol" })).toBe(
      "하위 에이전트 요청을 막았어요: own-codex-02/gpt-6-sol은 이 대화에서 쓸 수 없어요",
    )
    expect(subagentText.text("ko", "own.subagent.rejected.model", { model: "deepseek/deepseek-v4-pro" })).toBe(
      "하위 에이전트 요청을 막았어요: deepseek/deepseek-v4-pro는 이 대화에서 쓸 수 없어요",
    )
    expect(subagentText.text("ko", "own.subagent.rejected.plain")).toBe("하위 에이전트 요청을 막았어요")
    expect(subagentText.text("en", "own.subagent.rejected.model", { model: "openai/gpt-6-sol" })).toBe(
      "Subagent request blocked: openai/gpt-6-sol can't be used in this conversation",
    )
    expect(subagentText.text("en", "own.subagent.rejected.plain")).toBe("Subagent request blocked")
  })
})

describe("requestedRef (the chip names the account, not the slot id)", () => {
  test("provider/model with or without a variant splits; anything else is shown as written", () => {
    expect(requestedRef("own-codex-02/gpt-6-sol")).toEqual({ providerID: "own-codex-02", modelID: "gpt-6-sol" })
    expect(requestedRef("own-codex-02/gpt-6-sol#high")).toEqual({ providerID: "own-codex-02", modelID: "gpt-6-sol" })
    expect(requestedRef("openrouter/deepseek/v4-pro")).toEqual({ providerID: "openrouter", modelID: "deepseek/v4-pro" })
    for (const value of ["review", "gpt-6-sol", "/gpt-6-sol", "own-codex-02/", "#high/x"])
      expect({ value, ref: requestedRef(value) }).toEqual({ value, ref: undefined })
  })
})

describe("per-call effort (07 §2.3 대화에서 정하는 강도)", () => {
  type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
  type Part = Assistant["content"][number]
  const call = (id: string, state: Extract<Part, { type: "tool" }>["state"]): Part => ({
    type: "tool",
    id,
    name: "subagent",
    state,
    time: { created: 1 },
  })
  const assistant = (content: Part[]): SessionMessageInfo => ({
    id: "msg_parent",
    type: "assistant",
    agent: "build",
    model: { providerID: "openai", id: "gpt-6-sol" },
    time: { created: 1 },
    content,
  })

  test("effortOf splits a model value where the gate does; a value it declines is still named", () => {
    for (const value of [
      "#high",
      "review#low",
      "own-codex-aaaa/gpt-6-sol#max",
      "gpt-6-luna#xhigh",
      "review#high#max",
    ]) {
      const gate = Preset.effortRequest(value)
      expect({ value, effort: effortOf(value) }).toEqual({
        value,
        effort: gate.type === "effort" ? gate.intent : undefined,
      })
    }
    expect(["#ultra", "review", "#", "review#", undefined, 3].map(effortOf)).toEqual([
      "ultra",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test("requestedEffort: the gate's record once finished, else the LLM's own `#…`; matched by the child's id", () => {
    const messages = [
      assistant([
        call("call_1", {
          status: "completed",
          input: { agent: "general", model: "#max" },
          content: [{ type: "text", text: "done" }],
          metadata: { sessionID: "ses_one", status: "completed", own: { effort: { requested: "max", used: "high" } } },
        }),
        call("call_2", {
          status: "running",
          input: { agent: "own-review", model: "review#low" },
          metadata: { sessionID: "ses_two", status: "running" },
        }),
        call("call_3", {
          status: "running",
          input: { agent: "general" },
          metadata: { sessionID: "ses_three", status: "running" },
        }),
      ]),
    ]
    expect(requestedEffort(messages, "ses_one")).toBe("max")
    expect(requestedEffort(messages, "ses_two")).toBe("low")
    expect(requestedEffort(messages, "ses_three")).toBeUndefined()
    expect(requestedEffort(messages, "ses_other")).toBeUndefined()
    // A later call that continues the child without an effort is the one that counts.
    const continued = [
      ...messages,
      assistant([
        call("call_4", {
          status: "running",
          input: { agent: "general", sessionID: "ses_one" },
          metadata: { sessionID: "ses_one", status: "running" },
        }),
      ]),
    ]
    expect(requestedEffort(continued, "ses_one")).toBeUndefined()
  })

  test("roleEffort: the child's actual variant, `(요청)` when asked; no variant says nothing unless asked", () => {
    expect(roleEffort({ variant: "high", levels: 5 })).toEqual({ variant: "high", asked: false })
    expect(roleEffort({ variant: "high", asked: "xhigh", levels: 5 })).toEqual({ variant: "high", asked: true })
    expect(roleEffort({ variant: "default", levels: 5 })).toBeUndefined()
    expect(roleEffort({ levels: 5 })).toBeUndefined()
    expect(roleEffort({ asked: "default", levels: 5 })).toEqual({ asked: true })
    // A model without levels (a local one): the gate sent none, and the chip says the model has none.
    expect(roleEffort({ asked: "high", levels: 0 })).toEqual({ none: true, asked: true })
  })

  test("the role chip in both languages", () => {
    const line = { role: "리뷰", account: "Claude 구독", model: "Opus 5.5" }
    expect(
      subagentText.text("ko", "own.subagent.roleEffort", {
        ...line,
        effort: subagentText.text("ko", "own.subagent.effortRequested", { effort: "low" }),
      }),
    ).toBe("리뷰 · Claude 구독 · Opus 5.5 · low (요청)")
    expect(subagentText.text("en", "own.subagent.effortRequested", { effort: "Low" })).toBe("Low (asked)")
    expect(subagentText.text("ko", "own.subagent.effortNone")).toBe("강도 단계 없음")
  })
})
