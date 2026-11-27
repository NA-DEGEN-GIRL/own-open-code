// The subagent gate's T1 role mapping (07 §3.2, §5.4 steps 1–3, §5.5, §1.2) and the role agents (07 §2.4) over the
// real slots, presets and telemetry modules on a temp OWN_HOME and the 2026-10-01 catalog fixture: two ChatGPT logins
// (01 with its Sign in with ChatGPT sibling), an OpenAI key, DeepSeek and the Claude slot. The main is ChatGPT 01
// unless a test says otherwise. Sessions, agents and the agent editor are fakes; every account is fake.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { Agent } from "@opencode/schema/agent"
import { Kv, OwnAccounts, Preset } from "@own/protocol"
import { Modules } from "../../src/modules.js"
import { Agents } from "../../src/presets/agents.js"
import { Gate } from "../../src/presets/gate.js"
import type { ModelsFilter } from "../../src/presets/models-filter.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { sessionEvent, until } from "../plugins/support.js"
import { fakeEditor, memoryStorage, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { messagesOver } from "../support/session-messages.js"
import {
  ANTHROPIC,
  CHATGPT_01,
  CLAUDE,
  CLAUDE_ON,
  CODEX_A,
  CODEX_B,
  DEEPSEEK,
  DEEPSEEK_KEY,
  DS,
  OPENAI,
  SIWC_01,
  SIWC_A,
  SIWC_UNKNOWN,
  registry,
} from "./fixtures/catalog-2026-10-01.js"

const ROOT = "ses_roles_root"
const CHILD = "ses_roles_child"
const DIRECTORY = "D:/work"
const MAIN = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const PARENT = `${CODEX_A}/gpt-6-sol#high`
const CLAUDE_REVIEW = "anthropic/claude-opus-5-5#high"
const LIGHTER_EXPLORE = `${CODEX_A}/gpt-6-luna#high`
const PRESET_ID = "pr_01JB0000000000000000000011"

const decodePreset = Schema.decodeUnknownSync(Preset.Info)

interface Ref {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

interface SessionRecord {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly model?: Ref
}

const pin = (account: string, model: string) => ({ pin: { account, model } })
const LIGHTER = { rel: "lighter" } as const

/** A stored preset of `group`: `by-role` rows, or `single` when `single` is given. */
function preset(
  group: Preset.Group,
  roles: Partial<Record<Preset.Role, ReadonlyArray<unknown>>>,
  single?: unknown,
): Preset.Info {
  return decodePreset({
    ...Preset.builtin(group),
    id: PRESET_ID,
    name: "Claude 리뷰",
    workers: {
      mode: single === undefined ? "by-role" : "single",
      ...(single === undefined ? {} : { single }),
      roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
    },
    delegation: "when-useful",
  })
}

/** `ChatGPT 01` main with review on the Claude slot and explore on the main account's lighter model. */
const REVIEW = preset("codex", { "own-review": [pin(CLAUDE, "claude-opus-5-5")], explore: [LIGHTER] })

async function setup(input: { readonly main?: Ref; readonly preset?: Preset.Info; readonly team?: Preset.Team } = {}) {
  const sessions = new Map<string, SessionRecord>()
  const agents = new Map<string, { readonly id: string; readonly model?: Ref }>()
  const transforms: Array<(editor: AgentEditor) => void> = []
  const logs: string[] = []
  const kv = memoryStorage()
  const t = await testDeps({
    logs,
    directory: DIRECTORY,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }) },
      storage: kv.storage,
      session: {
        get: async (request: { readonly sessionID: string }) => {
          const found = sessions.get(request.sessionID)
          if (!found) throw new Error(`session not found: ${request.sessionID}`)
          return { ...found, location: { directory: DIRECTORY } }
        },
        context: async () => [{ id: "msg_roles_user", type: "user" }],
        messages: messagesOver(() => [{ id: "msg_roles_user", type: "user" }]),
      },
      agent: {
        get: async (request: { readonly agentID: string }) => {
          const found = agents.get(request.agentID)
          if (!found) throw new Error(`agent not found: ${request.agentID}`)
          return { location: { directory: DIRECTORY }, data: found }
        },
        transform: async (callback: (editor: AgentEditor) => void) => {
          transforms.push(callback)
          return { dispose: async () => {} }
        },
      },
    },
  })
  await t.deps.runtime.registry.write(await registry())
  const stored = input.preset
  if (stored) await t.deps.runtime.presets.write({ version: 1, groups: { [stored.group]: { presets: [stored] } } })
  const alerts: Telemetry.AlertInput[] = []
  const modules = t.modules({
    plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
  })
  await modules.slots.start()
  await modules.telemetry.start()
  await modules.presets.start()
  modules.slots.transformProviders(
    fakeEditor({ openai: { models: OPENAI }, anthropic: { models: ANTHROPIC }, deepseek: { models: DEEPSEEK } }).editor,
  )
  sessions.set(ROOT, { id: ROOT, agent: "build", model: input.main ?? MAIN })
  if (stored)
    await kv.storage.set(Kv.preset(ROOT), {
      presetID: stored.id,
      group: stored.group,
      revision: stored.revision,
      appliedAt: t.clock.now(),
      entryHash: null,
      ...(input.team ? { team: input.team } : {}),
    })
  const calls = { next: 0 }
  return {
    t,
    modules,
    sessions,
    agents,
    alerts,
    logs,
    kv,
    transforms,
    /** Runs the gate on one subagent call of `sessionID` and returns the event as core then sees it. */
    gate: async (call: Readonly<Record<string, unknown>>, sessionID = ROOT) => {
      const event = { tool: "subagent", sessionID, id: `call_roles_${++calls.next}`, input: call as unknown }
      await modules.presets.onToolBefore(event)
      return event
    },
    async [Symbol.asyncDispose]() {
      await modules.presets.stop()
      await modules.telemetry.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

const CALL = { agent: "general", description: "Look around", prompt: "Find the entry point" }

const agentOf = (event: { readonly input: unknown }) => (event.input as { readonly agent: string }).agent
const modelOf = (event: { readonly input: unknown }) => (event.input as { readonly model?: string }).model

describe("role mapping (07 §3.2, §5.4 step 2)", () => {
  test("a role row's first usable target is written explicitly as provider/model#variant", async () => {
    await using s = await setup({ preset: REVIEW })
    const review = await s.gate({ ...CALL, agent: "own-review" })
    expect(modelOf(review)).toBe(CLAUDE_REVIEW)
    expect(agentOf(review)).toBe("own-review")
    // `메인 계정의 더 가벼운 모델`: the main account's pair, decided now and stored (07 §4.2).
    expect(modelOf(await s.gate({ ...CALL, agent: "explore" }))).toBe(LIGHTER_EXPLORE)
    expect<unknown>((await s.t.deps.runtime.presets.read()).groups.codex?.lighter).toEqual({
      "gpt-6-sol": { model: "gpt-6-luna", source: "auto" },
    })
    expect(s.alerts).toEqual([])
  })

  test("a role without a row runs like the main: core inherits the parent, nothing is written", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("general", { id: "general" })
    const call = { ...CALL }
    expect((await s.gate(call)).input).toBe(call)
  })

  test("a row wins over the agent's configured model, so the configuration cannot leave the preset", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("own-review", { id: "own-review", model: { providerID: CODEX_B, id: "gpt-6-sol" } })
    expect(modelOf(await s.gate({ ...CALL, agent: "own-review" }))).toBe(CLAUDE_REVIEW)
    expect(s.alerts).toEqual([])
  })

  test("a role name the LLM wrote as `model` takes that role's target; the agent is left as it came", async () => {
    await using s = await setup({ preset: REVIEW })
    const event = await s.gate({ ...CALL, model: "review" })
    expect(modelOf(event)).toBe(CLAUDE_REVIEW)
    expect(agentOf(event)).toBe("general")
    // A role without a row runs like the main.
    expect(modelOf(await s.gate({ ...CALL, model: "deep" }))).toBe(PARENT)
  })

  test("the main's canonical id moves onto the main slot; a pinned target's own id is not the LLM's to write", async () => {
    await using s = await setup({ preset: REVIEW })
    expect(modelOf(await s.gate({ ...CALL, model: "openai/gpt-6-luna" }))).toBe(`${CODEX_A}/gpt-6-luna`)
    const written = await s.gate({ ...CALL, model: "anthropic/claude-opus-5-5" })
    expect(agentOf(written)).toBe(Preset.rejection({ reason: "model", roles: ["explore", "own-review"] }))
    expect(agentOf(written)).toEndWith("Ask the user if another model is needed.")
    expect(s.alerts.map((alert) => [alert.code, alert.subject])).toEqual([
      ["subagent_rejected", "model:anthropic/claude-opus-5-5"],
    ])
  })

  test("`single`: every call goes to workers.single, any agent, its configured model included", async () => {
    await using s = await setup({ preset: preset("codex", {}, pin(CLAUDE, "claude-opus-5-5")) })
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: CODEX_B, id: "gpt-6-sol" } })
    for (const agent of ["general", "explore", "own-quick", "reviewer"]) {
      const event = await s.gate({ ...CALL, agent })
      expect(modelOf(event)).toBe(CLAUDE_REVIEW)
      // Each call finishes before the next (the running cap is 3).
      await Gate.after(s.t.deps)({ ...event, status: "completed", result: { content: "done" } })
    }
    expect(s.alerts).toEqual([])
  })
})

describe("the allowed set and R4 (07 §5.4 step 3, PG2 (가))", () => {
  test("another ChatGPT subscription, the same login's siwc sibling too, is never a subagent target", async () => {
    await using s = await setup({ preset: REVIEW })
    for (const model of [`${CODEX_B}/gpt-6-sol`, `${SIWC_A}/gpt-5.6-sol`])
      expect(agentOf(await s.gate({ ...CALL, model }))).toBe(
        Preset.rejection({ reason: "model", roles: ["explore", "own-review"] }),
      )
    // Configured: replaced by the role's target (the main for a role without a row) and reported.
    s.agents.set("sibling", { id: "sibling", model: { providerID: SIWC_A, id: "gpt-5.6-sol" } })
    expect(modelOf(await s.gate({ ...CALL, agent: "sibling" }))).toBe(PARENT)
    expect(s.alerts.map((alert) => alert.code)).toEqual([
      "subagent_rejected",
      "subagent_rejected",
      "subagent_model_overridden",
    ])
  })

  test("binding.team joins R4 on every call: a team-broken pinned target is skipped like an unusable one", async () => {
    const main = { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }
    const crossReview = preset("claude-sub", { "own-review": [pin(SIWC_UNKNOWN, "gpt-5.6-sol")] })
    const team = { teamID: "tm_roles", role: "owner" as const, accounts: [CHATGPT_01], pinned: [] }
    {
      // No team: the unknown login is the only OpenAI subscription.
      await using s = await setup({ main, preset: crossReview })
      expect(modelOf(await s.gate({ ...CALL, agent: "own-review" }))).toStartWith(`own-siwc-uuuu/gpt-5.6-sol`)
    }
    // The team runs on ChatGPT 01: an unknown login is another OpenAI subscription, so the role runs like the main.
    await using s = await setup({ main, preset: crossReview, team })
    const event = await s.gate({ ...CALL, agent: "own-review" })
    expect(modelOf(event)).toBe("anthropic/claude-opus-5-5#high")
    expect(s.alerts).toEqual([])
  })

  test("with the team on ChatGPT 01, a pin on the same login's siwc account is the team's subscription", async () => {
    const main = { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }
    const team = { teamID: "tm_roles", role: "owner" as const, accounts: [CHATGPT_01], pinned: [] }
    await using s = await setup({
      main,
      preset: preset("claude-sub", { "own-review": [pin(SIWC_01, "gpt-5.6-sol")] }),
      team,
    })
    expect(modelOf(await s.gate({ ...CALL, agent: "own-review" }))).toStartWith(`${SIWC_A}/gpt-5.6-sol`)
  })
})

describe("fallback order (07 §1.2)", () => {
  test("an unusable first target hands over to the next; at the end of the list the role runs like the main", async () => {
    const twoTargets = preset("codex", { "own-review": [pin(CLAUDE, "claude-opus-5-5"), LIGHTER] })
    await using s = await setup({ preset: twoTargets })
    s.t.deps.runtime.limits.exhaust({
      accountID: CLAUDE,
      windowId: null,
      until: s.t.clock.now() + 60_000,
      class: "hard",
    })
    const event = await s.gate({ ...CALL, agent: "own-review" })
    expect(modelOf(event)).toBe(LIGHTER_EXPLORE)

    // The notice reaches the LLM with the call's result (`execute.after`), not the guidance cards.
    const after = Gate.after(s.t.deps)
    const done = {
      tool: "subagent",
      sessionID: ROOT,
      id: event.id,
      status: "completed" as const,
      result: { output: { sessionID: CHILD, status: "completed", output: "ok" }, content: "review done" },
    }
    await after(done)
    expect(done.result.content).toBe(
      "review done\n\nNote: the own-review role's first target is not available now, so this subagent ran on the role's next target.",
    )
  })

  test("nothing usable: the parent's Ref with a notice; never another provider or model outside the list", async () => {
    await using s = await setup({ preset: preset("codex", { "own-review": [pin(CLAUDE, "claude-opus-5-5")] }) })
    s.t.deps.runtime.limits.exhaust({
      accountID: CLAUDE,
      windowId: null,
      until: s.t.clock.now() + 60_000,
      class: "hard",
    })
    const event = await s.gate({ ...CALL, agent: "own-review" })
    expect(modelOf(event)).toBe(PARENT)
    const done = {
      tool: "subagent",
      sessionID: ROOT,
      id: event.id,
      status: "completed" as const,
      result: { content: "review done" },
    }
    await Gate.after(s.t.deps)(done)
    expect(done.result.content).toEndWith("so this subagent ran on your own model.")
  })
})

describe("continued children (07 §5.5)", () => {
  test("a child whose slot is in A stays where it is (cache kept)", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("own-review", { id: "own-review" })
    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "own-review",
      model: { providerID: "anthropic", id: "claude-opus-5-5" },
    })
    const call = { ...CALL, agent: "own-review", sessionID: CHILD }
    expect((await s.gate(call)).input).toBe(call)
  })

  test("a child outside A moves to its role's target; without a row to the parent", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("own-review", { id: "own-review" })
    s.agents.set("general", { id: "general" })
    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "own-review",
      model: { providerID: CODEX_B, id: "gpt-6-sol" },
    })
    expect(modelOf(await s.gate({ ...CALL, agent: "own-review", sessionID: CHILD }))).toBe(CLAUDE_REVIEW)
    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "general",
      model: { providerID: DS, id: "deepseek-flash" },
    })
    expect(modelOf(await s.gate({ ...CALL, sessionID: CHILD }))).toBe(PARENT)
  })
})

describe("per-call effort (07 §2.3 대화에서 정하는 강도)", () => {
  /** The REVIEW preset whose conversation may raise efforts up to `high` only. */
  const UP_TO_HIGH: Preset.Info = { ...REVIEW, subagentEffortMax: "high" }
  /** own-deep on the DeepSeek key (metered, no budget set here): a paid target. */
  const PAID = preset("codex", { "own-deep": [pin(DEEPSEEK_KEY, "deepseek-v4-pro")] })

  test("a per-call effort beats the role row's; the call runs where it would without one", async () => {
    await using s = await setup({ preset: REVIEW })
    const review = await s.gate({ ...CALL, agent: "own-review", model: "#low" })
    expect(modelOf(review)).toBe("anthropic/claude-opus-5-5#low")
    expect(agentOf(review)).toBe("own-review")
    expect(modelOf(await s.gate({ ...CALL, model: "review#max" }))).toBe("anthropic/claude-opus-5-5#max")
    expect(modelOf(await s.gate({ ...CALL, agent: "explore", model: "#low" }))).toBe(`${CODEX_A}/gpt-6-luna#low`)
    expect(s.alerts).toEqual([])
  })

  test("#<level> without a row: the parent's model, or the agent's configured one, at that level", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("general", { id: "general" })
    s.agents.set("helper", { id: "helper", model: { providerID: CODEX_A, id: "gpt-6-luna", variant: "low" } })
    expect(modelOf(await s.gate({ ...CALL, model: "#xhigh" }))).toBe(`${CODEX_A}/gpt-6-sol#xhigh`)
    expect(modelOf(await s.gate({ ...CALL, model: "#inherit" }))).toBe(PARENT)
    expect(modelOf(await s.gate({ ...CALL, agent: "helper", model: "#high" }))).toBe(`${CODEX_A}/gpt-6-luna#high`)
  })

  test("over the ceiling: declined naming the allowed level; 이번 메시지만 허용 lifts it for this message", async () => {
    await using s = await setup({ preset: UP_TO_HIGH })
    s.agents.set("general", { id: "general" })
    const over = await s.gate({ ...CALL, agent: "own-review", model: "#max" })
    expect(agentOf(over)).toBe(Preset.rejection({ reason: "effort-cap", max: "high", once: true }))
    expect(s.alerts.map((alert) => [alert.code, alert.subject])).toEqual([["subagent_rejected", "effort-cap:max"]])
    // The existing raw form gets the same ceiling, so it cannot go around it.
    expect(agentOf(await s.gate({ ...CALL, model: "openai/gpt-6-sol#xhigh" }))).toBe(
      Preset.rejection({ reason: "effort-cap", max: "high", once: true }),
    )
    expect(modelOf(await s.gate({ ...CALL, model: "openai/gpt-6-luna#low" }))).toBe(`${CODEX_A}/gpt-6-luna#low`)
    const raised = await s.modules.presets.raiseOnce(
      Schema.decodeUnknownSync(OwnAccounts.Definition.methods["session.preset.raiseOnce"].input)({
        sessionID: ROOT,
        effort: true,
      }),
      rpcContext<"session.preset.raiseOnce">(),
    )
    expect(raised).toMatchObject({ effort: true })
    expect(modelOf(await s.gate({ ...CALL, agent: "own-review", model: "#max" }))).toBe("anthropic/claude-opus-5-5#max")
  })

  test("a paid target is never raised above its row, allowed once or not; lowering runs", async () => {
    await using s = await setup({ preset: PAID })
    expect(modelOf(await s.gate({ ...CALL, agent: "own-deep" }))).toBe(`${DS}/deepseek-v4-pro#high`)
    expect(modelOf(await s.gate({ ...CALL, agent: "own-deep", model: "#low" }))).toBe(`${DS}/deepseek-v4-pro#low`)
    await s.kv.storage.set(Kv.presetUsage(ROOT), { perSession: 0, effort: { messageID: "msg_roles_user" } })
    expect(agentOf(await s.gate({ ...CALL, agent: "own-deep", model: "#max" }))).toBe(
      Preset.rejection({ reason: "effort-cap", max: "high", once: false }),
    )
  })

  test("an effort it cannot read is declined with the valid levels; two # stay a model rejection", async () => {
    await using s = await setup({ preset: REVIEW })
    for (const model of ["#ultra", "review#", "review#turbo", "#persistent"])
      expect(agentOf(await s.gate({ ...CALL, agent: "own-review", model }))).toBe(
        Preset.rejection({ reason: "effort" }),
      )
    expect(agentOf(await s.gate({ ...CALL, model: "review#high#max" }))).toBe(
      Preset.rejection({ reason: "model", roles: ["explore", "own-review"] }),
    )
  })

  test("undecidable: an effort is declined, never dropped into a plain inherit", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("general", { id: "general" })
    s.sessions.set(ROOT, { id: ROOT, agent: "build" })
    for (const model of ["#high", "review#high"])
      expect(agentOf(await s.gate({ ...CALL, model }))).toBe(Preset.rejection({ reason: "model", roles: [] }))
  })

  test("the result says what was sent when it differs, and records metadata.own.effort", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("general", { id: "general" })
    const event = await s.gate({ ...CALL, model: "#none" })
    expect(modelOf(event)).toBe(`${CODEX_A}/gpt-6-sol#low`)
    const done = {
      tool: "subagent",
      sessionID: ROOT,
      id: event.id,
      status: "completed" as const,
      result: { content: "done", metadata: { sessionID: CHILD, status: "completed" } },
    }
    await Gate.after(s.t.deps)(done)
    expect<unknown>(done.result).toEqual({
      content: "done\n\nNote: this subagent's model has no reasoning effort none, so it runs at low.",
      metadata: { sessionID: CHILD, status: "completed", own: { effort: { requested: "none", used: "low" } } },
    })
  })

  test("a continued child keeps its model when the effort switch would rewrite its cache", async () => {
    await using s = await setup({ preset: REVIEW })
    s.agents.set("general", { id: "general" })
    s.agents.set("own-review", { id: "own-review" })
    // GPT-5.6 has no per-message effort updates: the child stays at high and says how to get low.
    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "general",
      model: { providerID: CODEX_A, id: "gpt-5.6-sol", variant: "high" },
    })
    const kept = await s.gate({ ...CALL, sessionID: CHILD, model: "#low" })
    expect(modelOf(kept)).toBe(`${CODEX_A}/gpt-5.6-sol#high`)
    const done = {
      tool: "subagent",
      sessionID: ROOT,
      id: kept.id,
      status: "completed" as const,
      result: { content: "ok" },
    }
    await Gate.after(s.t.deps)(done)
    expect(done.result.content).toBe(
      "ok\n\nNote: this continued subagent keeps reasoning effort high so its cached context is kept; start a new subagent (no sessionID) to run at low.",
    )
    // Claude Opus 5.5 updates its effort per message: the child switches and keeps its cache.
    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "own-review",
      model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
    })
    const switched = await s.gate({ ...CALL, agent: "own-review", sessionID: CHILD, model: "#low" })
    expect(modelOf(switched)).toBe("anthropic/claude-opus-5-5#low")
  })
})

describe("opencode_models keeps A's providers (07 §5.4)", () => {
  const entry = (providerID: string, id: string) => ({ id: `${providerID}/${id}`, name: id })
  const listing = (
    providers: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
    page: { readonly total: number; readonly next: number | null },
  ) => ({
    providers: providers.map(([id, models]) => ({ id, name: id, models: models.map((model) => entry(id, model)) })),
    ...page,
  })
  const completed = (output: unknown, input: unknown = {}): ModelsFilter.After => ({
    tool: "opencode_models",
    sessionID: ROOT,
    input,
    status: "completed",
    result: { output, content: JSON.stringify(output) },
  })
  const outputOf = (event: ModelsFilter.After) => (event.status === "completed" ? event.result.output : undefined)
  const withDeepSeek = preset("codex", {
    "own-review": [pin(CLAUDE, "claude-opus-5-5")],
    explore: [pin(DEEPSEEK_KEY, "deepseek-flash")],
  })

  test("the main slot and the pinned targets' providers stay; other accounts go", async () => {
    await using s = await setup({ preset: withDeepSeek })
    const event = completed(
      listing(
        [
          [CODEX_A, ["gpt-6-sol"]],
          ["anthropic", ["claude-opus-5-5"]],
          [CODEX_B, ["gpt-6-sol"]],
          [DS, ["deepseek-flash"]],
          ["own-oai-kkkk", ["gpt-6-sol"]],
        ],
        { total: 5, next: null },
      ),
    )
    await s.modules.presets.onToolAfter(event)
    expect<unknown>(outputOf(event)).toMatchObject({
      providers: [{ id: CODEX_A }, { id: "anthropic" }, { id: DS }],
      total: 3,
      next: null,
    })
    expect(JSON.stringify(outputOf(event))).not.toContain(CODEX_B)
  })

  test("paging goes on while a kept provider can still come; it ends past the last one", async () => {
    await using s = await setup({ preset: withDeepSeek })
    // Core's order: the caller's own provider first, then by id; `own-ds-dddd` sorts after `own-codex-bbbb`.
    const middle = completed(
      listing(
        [
          ["anthropic", ["a"]],
          [CODEX_B, ["b"]],
        ],
        { total: 9, next: 4 },
      ),
      { offset: 2 },
    )
    await s.modules.presets.onToolAfter(middle)
    expect<unknown>(outputOf(middle)).toMatchObject({ providers: [{ id: "anthropic" }], total: 3, next: 4 })
    const past = completed(
      listing(
        [
          [DS, ["c"]],
          ["own-oai-kkkk", ["d"]],
        ],
        { total: 9, next: 6 },
      ),
      { offset: 4 },
    )
    await s.modules.presets.onToolAfter(past)
    expect<unknown>(outputOf(past)).toMatchObject({ providers: [{ id: DS }], total: 5, next: null })
  })
})

describe("role agents (07 §2.4)", () => {
  /** Core's agents before own-accounts' transform; `update` creates an agent from core's defaults like core does. */
  function coreAgents() {
    const records: Array<Record<string, unknown> & { id: string }> = [
      { ...Agent.Info.default(Agent.ID.make("build")), description: "The default agent." },
      {
        ...Agent.Info.default(Agent.ID.make("general")),
        mode: "subagent",
        description: "General-purpose agent.",
      },
      { ...Agent.Info.default(Agent.ID.make("explore")), mode: "subagent", description: "Fast agent for exploring." },
      { ...Agent.Info.default(Agent.ID.make("title")), mode: "primary", hidden: true },
    ].map((record) => structuredClone(record))
    const editor = {
      list: () => records,
      get: (id: string) => records.find((record) => record.id === id),
      default: () => {},
      update: (id: string, update: (agent: Record<string, unknown>) => void) => {
        const found = records.find((record) => record.id === id)
        const record = found ?? structuredClone({ ...Agent.Info.default(Agent.ID.make(id)) })
        if (!found) records.push(record)
        update(record)
      },
      remove: () => {},
    }
    // SAFETY: the transform uses `list`, `get` and `update` on records shaped like core's.
    return { records, editor: editor as unknown as AgentEditor }
  }

  /** What the subagent tool lists under `Available subagents`: visible agents that are not primary. */
  const listed = (records: ReadonlyArray<Record<string, unknown>>) =>
    records.flatMap((record) =>
      record.mode !== "primary" && record.hidden !== true ? [[record.id, record.description]] : [],
    )

  test("the setup fold defines own-review, own-quick and own-deep as hidden subagents; the listing is unchanged", async () => {
    await using s = await setup()
    const core = coreAgents()
    const before = listed(core.records)
    s.modules.presets.transformAgents(core.editor)
    expect(listed(core.records)).toEqual(before)
    for (const id of ["own-review", "own-quick", "own-deep"] as const) {
      const record = core.records.find((item) => item.id === id)
      expect(record).toMatchObject({
        mode: "subagent",
        hidden: true,
        description: Agents.ROLE_AGENTS[id].description,
        name: Agents.ROLE_AGENTS[id].name,
      })
      expect(record?.system).toBeUndefined()
      expect(record?.model).toBeUndefined()
      expect(record?.permissions).toEqual(
        expect.arrayContaining([
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "question", resource: "*", effect: "deny" },
        ]),
      )
    }
    expect(core.records.find((item) => item.id === "own-review")?.permissions).toContainEqual({
      action: "edit",
      resource: "*",
      effect: "deny",
    })
    // The read-only roles ask before a web request or search (MR10-3, MR11); own-quick and own-deep keep general's
    // rights.
    const webAsk = { action: "webfetch", resource: "*", effect: "ask" }
    const searchAsk = { action: "websearch", resource: "*", effect: "ask" }
    expect((core.records.find((item) => item.id === "own-review")?.permissions as unknown[]).slice(-2)).toEqual([
      webAsk,
      searchAsk,
    ])
    expect(core.records.find((item) => item.id === "own-quick")?.permissions).not.toContainEqual(webAsk)
    expect(core.records.find((item) => item.id === "own-quick")?.permissions).not.toContainEqual(searchAsk)
    // Core's own agents are untouched, but for the shell deny and the web asks explore gets last (07 §2.4, upstream
    // 7725ac81eb, MR10-3, MR11).
    const shellDeny = { action: "shell", resource: "*", effect: "deny" }
    expect(core.records.filter((item) => !String(item.id).startsWith("own-"))).toEqual(
      coreAgents().records.map((item) =>
        item.id === "explore"
          ? { ...item, permissions: [...(item.permissions as unknown[]), shellDeny, webAsk, searchAsk] }
          : item,
      ),
    )
  })

  test("defined in setup, so a later plugin's setup transform (own.computer-use's deny) reaches them", async () => {
    await using s = await setup()
    const core = coreAgents()
    s.modules.presets.transformAgents(core.editor)
    // The next plugin's setup transform in configured order, appending its agent-wide rule.
    for (const record of [...core.records])
      core.editor.update(record.id, (agent) =>
        agent.permissions.push({ action: "computer", resource: "*", effect: "deny" }),
      )
    expect(core.records.find((item) => item.id === "own-review")?.permissions).toContainEqual({
      action: "computer",
      resource: "*",
      effect: "deny",
    })
  })

  test("the late registration never defines them, and an agent already defined under a role id is left alone", async () => {
    await using s = await setup()
    s.modules.presets.onEvent?.(sessionEvent("plugin.updated", {}, DIRECTORY), { local: true })
    await until(() => s.transforms.length === 1)
    const late = coreAgents()
    s.transforms[0]?.(late.editor)
    expect(late.records.some((item) => String(item.id).startsWith("own-"))).toBe(false)

    const configured = coreAgents()
    configured.records.push({ id: "own-quick", mode: "primary", hidden: false, description: "mine" })
    s.modules.presets.transformAgents(configured.editor)
    expect(configured.records.find((item) => item.id === "own-quick")).toEqual({
      id: "own-quick",
      mode: "primary",
      hidden: false,
      description: "mine",
    })
  })
})
