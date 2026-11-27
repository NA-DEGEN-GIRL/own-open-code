// 설정 > 에이전트 방식 `하위 에이전트` (10 §3.11): the words the part shows for each 에이전트 방식, rendered from views
// shaped like the service's (`prompt.preview`'s `subagent`, `prompt.subagent`), in Korean as the page shows them. The
// part's frame is drawn in prompt-page.tsx; Playwright (e2e/prompts) sees it in the browser.
import { describe, expect, test } from "bun:test"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { omoText } from "./omo-strings"
import { promptsText } from "./prompt-strings"
import { subagentView } from "./subagent-view"

const ko = (key: Parameters<typeof promptsText.text>[1], params?: Parameters<typeof promptsText.text>[2]) =>
  promptsText.text("ko", key, params)
const en = (key: Parameters<typeof promptsText.text>[1], params?: Parameters<typeof promptsText.text>[2]) =>
  promptsText.text("en", key, params)

const DESCRIPTION = "Spawns an agent in a child session.\n\nAvailable subagents:\n- explore: Read-only search."
const CORE: OwnHarness.PromptSubagent = {
  kind: "core",
  tool: { name: "subagent", description: DESCRIPTION },
  agent: "build",
  opening: "You are a subagent spawned by another session.\n",
  guidance: "",
  cut: { lines: 2000, bytes: 51200 },
}
const V1: OwnHarness.PromptSubagent = {
  kind: "codex-v1",
  tool: { name: "multi_agent_v1__spawn_agent", description: "Start a sub-agent on a well-scoped task." },
  opening: "",
  guidance: "",
}
const V2: OwnHarness.PromptSubagent = {
  kind: "codex-v2",
  tool: { name: "collaboration__spawn_agent", description: "Spawns an agent to work on the specified task." },
  opening: "Message Type: NEW_TASK\nTask name: /root/<task_name>\nSender: /root\nPayload:\n",
  guidance: "<multi_agent_role>You are an agent in a team of agents</multi_agent_role>",
}
/** The sentence the A3 fix keeps away from the lean tier: Codex's ask for the changed file paths. */
const CHANGED_PATHS = "고친 파일 경로를 마지막 답에 적게"

describe("하위 에이전트", () => {
  test("core's subagent (Pi): the tool as sent, the child's first line, nothing else added, what comes back", () => {
    const view = subagentView({ harness: "pi", subagent: CORE }, ko)
    expect(view.tool).toEqual({
      name: "subagent",
      description: DESCRIPTION,
      notes: [
        "설명에 붙은 Available subagents 목록은 새 대화의 기본 에이전트(build)가 맡길 수 있는 역할이에요. 대화의 에이전트에 따라 달라져요.",
      ],
    })
    expect(view.first.text).toBe("You are a subagent spawned by another session.\n(메인 모델이 prompt에 쓴 글 그대로)")
    expect(view.first.note).toBe("같은 하위 에이전트에게 이어서 맡기면(sessionID) 메인 모델이 쓴 글만 가요.")
    expect(view.sends).toEqual([
      ko("own.prompts.subagent.extra.none"),
      "explore처럼 자기 지시문이 있는 역할로 맡기면, Pi 지시문의 첫 문단과 도구 목록·규칙 대신 그 역할의 지시문을 받아요.",
      ko("own.prompts.subagent.preset"),
    ])
    expect(view.role).toBeUndefined()
    expect(view.returns).toEqual([
      "메인 모델에게는 하위 에이전트가 마지막 단계에 쓴 글만 <subagent sessionID=… state=completed> 안에 담겨 가요. 중간 단계의 글과 도구 결과는 가지 않아요.",
      "기다려서 받는 결과(포그라운드)가 2,000줄이나 50 KiB를 넘으면 앞부분만 남기고 잘라요. 전체는 파일로 남고 그 경로가 함께 가요.",
      "백그라운드로 맡긴 하위 에이전트는 끝나면 같은 모양의 알림으로 돌아와요. 이 알림은 자르지 않아요.",
      ko("own.prompts.subagent.notice"),
    ])
  })

  test("where a role's own instructions go differs per 에이전트 방식; OpenCode 기본 and DeepSeek say theirs", () => {
    const role = (harness: "opencode" | "dsh" | "claude-code") => subagentView({ harness, subagent: CORE }, ko).sends[1]
    expect(role("opencode")).toContain("모델별 기본 지시문 대신")
    expect(role("dsh")).toContain("모델 소개 줄 대신")
    expect(role("claude-code")).toContain("Claude Code 지시문 뒤의 에이전트 역할 자리에")
  })

  test("Claude Agent: the MCP name is explained; no list, no list note; an unregistered tool shows none", () => {
    const mcp = { ...CORE, tool: { name: "mcp__opencode__subagent", description: DESCRIPTION } }
    expect(subagentView({ harness: "claude-code", subagent: mcp }, ko).tool?.notes.at(-1)).toBe(
      "Claude Agent 계정의 모델에는 MCP 도구 mcp__opencode__subagent로 가요. Claude Code는 설명을 2,048자에서 자르기 때문에, 설명이 길면 하위 에이전트 목록을 앞으로 옮겨서 보내요.",
    )
    const bare = { ...CORE, tool: { name: "subagent", description: "Spawns an agent in a child session." } }
    expect(subagentView({ harness: "opencode", subagent: bare }, ko).tool?.notes).toEqual([])
    const { tool: _tool, ...none } = CORE
    expect(subagentView({ harness: "opencode", subagent: none }, ko).tool).toBeUndefined()
  })

  test("Codex v1 per tier: Codex's own ask for changed paths, the fallback tier's, and the lean tier asks for none", () => {
    const ask = (codex: { readonly tier?: "catalog" | "lean" | "fallback"; readonly applied: "reference" | "own" }) =>
      subagentView({ harness: "codex", subagent: V1, codex }, ko).tool?.notes[0]
    expect(ask({ tier: "catalog", applied: "own" })).toBe(ko("own.prompts.subagent.ask.original"))
    expect(ask({ tier: "lean", applied: "reference" })).toBe(ko("own.prompts.subagent.ask.original"))
    expect(ask({ tier: "fallback", applied: "own" })).toBe(ko("own.prompts.subagent.ask.fallback"))
    expect(ask({ tier: "lean", applied: "own" })).toBe(ko("own.prompts.subagent.ask.lean"))
    expect(ko("own.prompts.subagent.ask.original")).toContain(CHANGED_PATHS)
    expect(ko("own.prompts.subagent.ask.fallback")).toContain(CHANGED_PATHS)
    expect(ko("own.prompts.subagent.ask.lean")).not.toContain(CHANGED_PATHS)
    expect(ko("own.prompts.subagent.ask.lean")).toContain("고친 파일 목록이나 검토는 따로 묻지 않고")
    const view = subagentView({ harness: "codex", subagent: V1, codex: { tier: "lean", applied: "own" } }, ko)
    // The parent's text alone: no line in front, no cut, no preset notice on results.
    expect(view.first.text).toBe("(메인 모델이 message에 쓴 글 그대로)")
    expect(view.sends).toEqual([ko("own.prompts.subagent.extra.none"), ko("own.prompts.subagent.preset")])
    expect(view.returns).toEqual([ko("own.prompts.subagent.return.codex-v1")])
  })

  test("Codex in Code Mode on a v1 model: core's subagent, why it is not spawn_agent, and Codex's place for a role", () => {
    const view = subagentView({ harness: "codex", subagent: CORE, codex: { tier: "catalog", applied: "own" } }, ko)
    expect(view.tool?.notes).toEqual([
      "이 모델은 Code Mode로 돌아서 Codex의 에이전트 도구(spawn_agent)를 받지 않아요. 그래서 OpenCode의 subagent 도구로 맡겨요.",
      ko("own.prompts.subagent.agents", { agent: "build" }),
    ])
    expect(view.first.text).toBe("You are a subagent spawned by another session.\n(메인 모델이 prompt에 쓴 글 그대로)")
    expect(view.sends[1]).toBe(
      "explore처럼 자기 지시문이 있는 역할로 맡기면, Codex 지시문은 그대로 두고 그 역할의 지시문을 developer 메시지 맨 앞에 더해요.",
    )
    expect(view.returns).toContain(ko("own.prompts.subagent.notice"))
  })

  test("Codex v2: a NEW_TASK message, Codex's role text for a child, FINAL_ANSWER back and wait_agent without it", () => {
    const view = subagentView({ harness: "codex", subagent: V2, codex: { tier: "catalog", applied: "own" } }, ko)
    expect(view.tool?.notes).toEqual([ko("own.prompts.subagent.ask.v2")])
    expect(view.first.text).toBe(
      "Message Type: NEW_TASK\nTask name: /root/<task_name>\nSender: /root\nPayload:\n(메인 모델이 message에 쓴 글 그대로)",
    )
    expect(view.sends[0]).toBe(ko("own.prompts.subagent.extra.codex-v2"))
    expect(view.role).toBe(V2.guidance)
    expect(view.returns).toEqual([
      "하위 에이전트가 끝나면 마지막 답이 FINAL_ANSWER 메시지로 메인에게 가요. wait_agent는 기다리기만 하고 내용을 돌려주지 않아요. 중간 단계의 글과 도구 결과는 가지 않아요.",
    ])
  })

  test("omo's one line, and every line in English too", () => {
    expect(omoText.text("ko", "own.omo.subagent")).toBe(
      "omo는 task 도구로 맡겨요. 돌아오는 글은 omo가 만들어요(걸린 시간, 에이전트, 하위 에이전트의 답, 이어서 맡길 때 쓸 task_id). 이 앱은 아무것도 더하지 않아요.",
    )
    for (const subagent of [CORE, V1, V2]) {
      const view = subagentView({ harness: "pi", subagent, codex: { tier: "lean", applied: "own" } }, en)
      const words = [view.first.note, ...view.sends, ...view.returns, ...(view.tool?.notes ?? [])].join(" ")
      expect(words).not.toMatch(/[가-힣]/)
    }
  })
})
