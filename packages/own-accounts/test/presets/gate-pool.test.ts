// The subagent gate under a model pool preset (07 §5.4 2단계 모델 묶음, §3.3 U7a, U7b, T4) over the real slots,
// presets and telemetry modules on a temp OWN_HOME and the 2026-10-01 catalog fixture: ChatGPT 01 (main) and 02, an
// OpenAI key, a DeepSeek key with a $5 budget, the Claude slot and a discovered Ollama model. Sessions and agents are
// fakes; every account is fake and no money is spent (the ledger line is written by the test).

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Schema } from "effect"
import { Account, Kind, Kv, Ledger, OwnID, Preset, type Registry } from "@own/protocol"
import { Modules } from "../../src/modules.js"
import { Gate } from "../../src/presets/gate.js"
import { Presets } from "../../src/presets/presets.js"
import { Templates } from "../../src/slots/templates.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { fakeEditor, memoryStorage } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import {
  ANTHROPIC,
  CHATGPT_01,
  CHATGPT_02,
  CLAUDE,
  CLAUDE_ON,
  CODEX_A,
  DEEPSEEK,
  DEEPSEEK_KEY,
  DS,
  OAI,
  OLLAMA,
  OPENAI,
  OPENAI_KEY,
  SEATS,
  registry,
} from "./fixtures/catalog-2026-10-01.js"

setDefaultTimeout(30_000)

const ROOT = "ses_pool_root"
const CHILD = "ses_pool_child"
const MAIN = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const PARENT = `${CODEX_A}/gpt-6-sol#high`
const PRESET_ID = "pr_01JB0000000000000000000077"
const BUDGET_USD = 5

const decodePreset = Schema.decodeUnknownSync(Preset.Info)
const decodeLine = Schema.decodeUnknownSync(Ledger.Line)

interface Ref {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

const LUNA = { key: "gpt-6-luna", model: "gpt-6-luna" }
const LUNA_API = { key: "gpt-6-luna-api", model: "gpt-6-luna", account: OPENAI_KEY }
const OPUS = { key: "claude-opus-5-5", model: "claude-opus-5-5", account: CLAUDE }
const QWEN = { key: "qwen3-coder-30b", model: OLLAMA.id, account: "local:ollama" }
const DSPRO = { key: "deepseek-v4-pro", model: "deepseek-v4-pro", account: DEEPSEEK_KEY }

function pooled(
  group: Preset.Group,
  pool: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return decodePreset({
    ...Preset.builtin(group),
    id: PRESET_ID,
    name: "모델 묶음",
    workers: { mode: "same", roles: {}, pool },
    delegation: "when-useful",
    ...extra,
  })
}

async function setup(input: {
  readonly preset: Preset.Info
  readonly main?: Ref
  readonly verified?: boolean
  readonly team?: Preset.Team
  readonly lost?: boolean
  readonly registry?: Registry.File
}) {
  const sessions = new Map<string, { id: string; parentID?: string; agent?: string; model?: Ref }>()
  const agents = new Map<string, { readonly id: string; readonly model?: Ref }>()
  const logs: string[] = []
  const kv = memoryStorage()
  const verified = { value: input.verified ?? true }
  const t = await testDeps({
    logs,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [OLLAMA] }) },
      storage: kv.storage,
      session: {
        get: async (request: { readonly sessionID: string }) => {
          const found = sessions.get(request.sessionID)
          if (!found) throw new Error(`session not found: ${request.sessionID}`)
          return { ...found, location: { directory: "D:/work" } }
        },
      },
      agent: {
        get: async (request: { readonly agentID: string }) => {
          const found = agents.get(request.agentID)
          if (!found) throw new Error(`agent not found: ${request.agentID}`)
          return { location: { directory: "D:/work" }, data: found }
        },
      },
    },
  })
  const base = input.registry ?? (await registry())
  await t.deps.runtime.registry.write({
    ...base,
    accounts: base.accounts.map((account) =>
      account.id === DEEPSEEK_KEY ? { ...account, budget: { monthlyUSD: BUDGET_USD } } : account,
    ),
  })
  const stored = input.preset
  await t.deps.runtime.presets.write({ version: 1, groups: { [stored.group]: { presets: [stored] } } })
  const alerts: Telemetry.AlertInput[] = []
  const modules = t.modules({
    plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
    presets: (deps, peers) =>
      Presets.create(deps, peers, { resolver: { localVerified: () => verified.value, localWindow: () => 32_768 } }),
  })
  await modules.slots.start()
  await modules.telemetry.start()
  await modules.presets.start()
  modules.slots.transformProviders(
    fakeEditor({ openai: { models: OPENAI }, anthropic: { models: ANTHROPIC }, deepseek: { models: DEEPSEEK } }).editor,
  )
  if (!input.lost) sessions.set(ROOT, { id: ROOT, agent: "build", model: input.main ?? MAIN })
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
    verified,
    gate: async (call: Readonly<Record<string, unknown>>) => {
      const event = { tool: "subagent", sessionID: ROOT, id: `call_pool_${++calls.next}`, input: call as unknown }
      await modules.presets.onToolBefore(event)
      return event
    },
    /** Runs the gate and finishes the call at once, so many calls stay under the running cap. */
    run: async (call: Readonly<Record<string, unknown>>) => {
      const event = { tool: "subagent", sessionID: ROOT, id: `call_pool_${++calls.next}`, input: call as unknown }
      await modules.presets.onToolBefore(event)
      await Gate.after(t.deps)({
        tool: "subagent",
        sessionID: ROOT,
        id: event.id,
        status: "completed",
        result: { content: "" },
      })
      return event
    },
    /** Finishes a call as core would, and returns the result text the LLM reads. */
    finish: async (event: { readonly id: string }, content = "done") => {
      const done = {
        tool: "subagent",
        sessionID: ROOT,
        id: event.id,
        status: "completed" as const,
        result: { content },
      }
      await Gate.after(t.deps)(done)
      return done.result.content
    },
    /** Spends `amount` USD on the DeepSeek key this month (a ledger line, as telemetry writes it). */
    spend: async (amount: number) => {
      const eid = `evt_pool_spend_${amount}`
      const line = decodeLine({
        v: 1,
        ts: t.clock.now(),
        sessionID: "ses_spent",
        messageID: null,
        kind: "primary",
        accountID: DEEPSEEK_KEY,
        providerID: DS,
        modelID: "deepseek-flash",
        variant: null,
        credentialRef: null,
        transport: null,
        switchEpoch: 0,
        compactionEpoch: 0,
        tokens: null,
        P: null,
        hit: null,
        cost: { unit: "USD", amount, source: "ratecard" },
        costUSDOpenCode: null,
        coldExpected: null,
      })
      await t.deps.runtime.ledger.usage(eid, line)
      await t.deps.runtime.ledger.flush()
      t.deps.runtime.broadcast.emit("ledger.line", { eid, line })
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

// Many calls run in one user message here: the per-message cap is raised so it never decides a mapping test.
const CHATGPT_POOL = pooled("codex", [LUNA, OPUS, QWEN, DSPRO, LUNA_API], {
  caps: { concurrent: 3, perMessage: 50, perSession: 100 },
})
const ALLOWED = Preset.rejection({
  reason: "model",
  models: ["gpt-6-luna", "claude-opus-5-5", "qwen3-coder-30b", "deepseek-v4-pro", "gpt-6-luna-api"],
})

describe("a model the LLM wrote under a pool (07 §5.4 2단계 모델 묶음 1)", () => {
  test("a pool name, a role name, the main model, a bare or provider-prefixed id map to Refs", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    expect(modelOf(await s.run({ ...CALL, model: "claude-opus-5-5" }))).toBe("anthropic/claude-opus-5-5#high")
    expect(modelOf(await s.run({ ...CALL, model: "qwen3-coder-30b" }))).toBe(`ollama/${OLLAMA.id}`)
    // A role name: that role's default.
    expect(modelOf(await s.run({ ...CALL, model: "review" }))).toBe("anthropic/claude-opus-5-5#high")
    expect(modelOf(await s.run({ ...CALL, model: "explore" }))).toBe(`${CODEX_A}/gpt-6-luna#high`)
    // The main model itself: its slot, the canonical id, the bare id.
    expect(modelOf(await s.run({ ...CALL, model: `${CODEX_A}/gpt-6-sol` }))).toBe(`${CODEX_A}/gpt-6-sol`)
    expect(modelOf(await s.run({ ...CALL, model: "openai/gpt-6-sol#xhigh" }))).toBe(`${CODEX_A}/gpt-6-sol#xhigh`)
    const bare = await s.run({ ...CALL, model: "gpt-6-sol" })
    expect(agentOf(bare)).toBe("general")
    expect(modelOf(bare)).toBe(PARENT)
    // A model id one entry has, whatever provider is written; the free entry before the paid one.
    expect(modelOf(await s.run({ ...CALL, model: `ollama/${OLLAMA.id}` }))).toBe(`ollama/${OLLAMA.id}`)
    expect(modelOf(await s.run({ ...CALL, model: "openai/gpt-6-luna" }))).toBe(`${CODEX_A}/gpt-6-luna#high`)
    expect(modelOf(await s.run({ ...CALL, model: `${OAI}/gpt-6-luna` }))).toBe(`${CODEX_A}/gpt-6-luna#high`)
    expect(modelOf(await s.run({ ...CALL, model: "gpt-6-luna-api" }))).toBe(`${OAI}/gpt-6-luna#high`)
    expect(s.alerts).toEqual([])
  })

  test("a main-account model outside the pool or an unknown value is declined with the pool's names", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    for (const model of ["gpt-6-astra", "openai/gpt-6-astra", `${CODEX_A}/gpt-6-astra`, "made-up", "anthropic/x"])
      expect(agentOf(await s.run({ ...CALL, model }))).toBe(ALLOWED)
    expect(s.alerts.every((alert) => alert.code === "subagent_rejected")).toBe(true)
  })
})

describe("the default rule (07 §3.3 U7a)", () => {
  test("a ChatGPT main: explore and own-quick take the cheapest lighter free entry; review and deep Claude", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    for (const agent of ["explore", "own-quick"]) {
      const event = await s.gate({ ...CALL, agent })
      expect(modelOf(event)).toBe(`${CODEX_A}/gpt-6-luna#high`)
      expect(await s.finish(event)).toBe("done")
    }
    for (const agent of ["own-review", "own-deep"]) {
      const event = await s.gate({ ...CALL, agent })
      expect(modelOf(event)).toBe("anthropic/claude-opus-5-5#high")
      await s.finish(event)
    }
    // general: as without a pool (the agent's configured model, else the parent).
    const call = { ...CALL }
    s.agents.set("general", { id: "general" })
    expect((await s.gate(call)).input).toBe(call)
  })

  test("a metered DeepSeek main: explore takes the verified local first; deep never a stronger main-paid one", async () => {
    const main = { providerID: DS, id: "deepseek-flash", variant: "high" }
    const metered = pooled("ds", [
      { key: "deepseek-v4-pro", model: "deepseek-v4-pro" },
      { key: "deepseek-flash", model: "deepseek-flash" },
      QWEN,
      OPUS,
    ])
    {
      await using s = await setup({ preset: metered, main })
      expect(modelOf(await s.gate({ ...CALL, agent: "explore" }))).toBe(`ollama/${OLLAMA.id}`)
      expect(modelOf(await s.gate({ ...CALL, agent: "own-deep" }))).toBe("anthropic/claude-opus-5-5#high")
    }
    // Without Claude, the stronger metered model is never a default: deep runs like the main.
    await using s = await setup({ preset: pooled("ds", [{ key: "deepseek-v4-pro", model: "deepseek-v4-pro" }]), main })
    const call = { ...CALL, agent: "own-deep" }
    s.agents.set("own-deep", { id: "own-deep" })
    expect((await s.gate(call)).input).toBe(call)
  })

  test("a metered main's lighter model is the explore default only when no free lighter entry can run", async () => {
    const main = { providerID: DS, id: "deepseek-v4-pro", variant: "high" }
    // Frozen when it was added: the local window was not verified then either.
    const metered = pooled("ds", [
      { key: "deepseek-flash", model: "deepseek-flash" },
      { ...QWEN, card: { windowVerified: false } },
    ])
    await using s = await setup({ preset: metered, main, verified: false })
    // The local window is not verified: the guidance default already is the lighter metered model, no notice.
    const event = await s.gate({ ...CALL, agent: "explore" })
    expect(modelOf(event)).toBe(`${DS}/deepseek-flash#high`)
    expect(await s.finish(event)).toBe("done")
  })

  test("an unverified local model is never a default, but runs when named", async () => {
    await using s = await setup({
      preset: pooled("codex", [{ ...QWEN, card: { windowVerified: false } }]),
      verified: false,
    })
    const call = { ...CALL, agent: "explore" }
    s.agents.set("explore", { id: "explore" })
    expect((await s.gate(call)).input).toBe(call)
    expect(modelOf(await s.gate({ ...CALL, model: "qwen3-coder-30b" }))).toBe(`ollama/${OLLAMA.id}`)
  })
})

describe("money (07 §5.3, U7b)", () => {
  test("a paid entry is never a default; named, it runs within its budget with no consent asked", async () => {
    await using s = await setup({ preset: pooled("codex", [DSPRO]) })
    const call = { ...CALL, agent: "explore" }
    s.agents.set("explore", { id: "explore" })
    expect((await s.gate(call)).input).toBe(call)
    const named = await s.gate({ ...CALL, model: "deepseek-v4-pro" })
    expect(modelOf(named)).toBe(`${DS}/deepseek-v4-pro#high`)
    expect(s.alerts).toEqual([])
  })

  test("over its budget a paid or main-paid entry drops out: the call runs on the default with the budget notice", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    await s.spend(BUDGET_USD + 1)
    const event = await s.gate({ ...CALL, agent: "own-review", model: "deepseek-v4-pro" })
    expect(modelOf(event)).toBe("anthropic/claude-opus-5-5#high")
    expect(await s.finish(event, "reviewed")).toBe(
      "reviewed\n\nNote: model deepseek-v4-pro is not available now (its monthly budget is used up), so this subagent ran on model claude-opus-5-5.",
    )
    const general = await s.gate({ ...CALL, model: "deepseek-v4-pro" })
    expect(modelOf(general)).toBe(PARENT)
    expect(await s.finish(general)).toEndWith("so this subagent ran on your own model.")
    // No call went to the DeepSeek key after its budget.
    expect(s.alerts.filter((alert) => alert.code === "subagent_rejected")).toEqual([])
  })

  test("a metered group over budget: its main-account entries drop out, the main itself is not gated", async () => {
    const main = { providerID: DS, id: "deepseek-v4-pro", variant: "high" }
    await using s = await setup({ preset: pooled("ds", [{ key: "deepseek-flash", model: "deepseek-flash" }]), main })
    await s.spend(BUDGET_USD + 1)
    const named = await s.gate({ ...CALL, model: "deepseek-flash" })
    expect(modelOf(named)).toBe(`${DS}/deepseek-v4-pro#high`)
    expect(await s.finish(named)).toBe(
      "done\n\nNote: model deepseek-flash is not available now (its monthly budget is used up), so this subagent ran on your own model.",
    )
    const explore = await s.gate({ ...CALL, agent: "explore" })
    expect(modelOf(explore)).toBe(`${DS}/deepseek-v4-pro#high`)
    expect(await s.finish(explore)).toEndWith("so this subagent ran on your own model.")
  })
})

describe("an entry that cannot run now (07 §5.4 2단계 3, D4)", () => {
  test("a named entry waiting for a limit runs on the agent's default with a notice; so does a moved default", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    s.t.deps.runtime.limits.exhaust({
      accountID: CLAUDE,
      windowId: null,
      until: s.t.clock.now() + 60_000,
      class: "hard",
    })
    const named = await s.gate({ ...CALL, agent: "explore", model: "claude-opus-5-5" })
    expect(modelOf(named)).toBe(`${CODEX_A}/gpt-6-luna#high`)
    expect(await s.finish(named)).toEndWith(
      "Note: model claude-opus-5-5 is not available now, so this subagent ran on model gpt-6-luna.",
    )
    const review = await s.gate({ ...CALL, agent: "own-review" })
    expect(modelOf(review)).toBe(PARENT)
    expect(await s.finish(review)).toEndWith(
      "Note: model claude-opus-5-5 is not available now, so this subagent ran on your own model.",
    )
  })

  test("a gone model and a team-R4-broken pin run on the default; nothing reaches the other login", async () => {
    const main = { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }
    const team = { teamID: "tm_pool", role: "owner" as const, accounts: [CHATGPT_01], pinned: [] }
    const area = pooled("claude-sub", [
      { key: "gpt-6-sol", model: "gpt-6-sol", account: CHATGPT_02 },
      { key: "gone", model: "claude-none" },
    ])
    await using s = await setup({ preset: area, main, team })
    const broken = await s.gate({ ...CALL, model: "gpt-6-sol" })
    expect(modelOf(broken)).toBe("anthropic/claude-opus-5-5#high")
    expect(await s.finish(broken)).toEndWith("so this subagent ran on your own model.")
    const gone = await s.gate({ ...CALL, model: "gone" })
    expect(modelOf(gone)).toBe("anthropic/claude-opus-5-5#high")
  })
})

describe("continued children, undecided calls and caps", () => {
  test("a continued child on a pool pin's provider stays where it is", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    s.agents.set("general", { id: "general" })
    s.sessions.set(CHILD, { id: CHILD, parentID: ROOT, agent: "general", model: { providerID: "anthropic", id: "x" } })
    const call = { ...CALL, sessionID: CHILD }
    expect((await s.gate(call)).input).toBe(call)
  })

  test("without a main the gate cannot decide: a pool name is declined, nothing throws", async () => {
    await using s = await setup({ preset: CHATGPT_POOL, lost: true })
    s.agents.set("general", { id: "general" })
    const event = await s.gate({ ...CALL, model: "claude-opus-5-5" })
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "model", roles: [] }))
  })

  test("pool calls count against the caps", async () => {
    await using s = await setup({
      preset: pooled("codex", [LUNA, OPUS], { caps: { concurrent: 1, perMessage: 6, perSession: 100 } }),
    })
    expect(modelOf(await s.gate({ ...CALL, model: "gpt-6-luna" }))).toBe(`${CODEX_A}/gpt-6-luna#high`)
    const second = await s.gate({ ...CALL, model: "claude-opus-5-5" })
    expect(agentOf(second)).toBe(Preset.rejection({ reason: "caps", cap: "concurrent", max: 1 }))
  })
})

describe("per-call effort under a pool (07 §2.3 대화에서 정하는 강도)", () => {
  test("a pool name, a role name, a provider form or #<level> alone: the same entry at that level", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    s.agents.set("general", { id: "general" })
    expect(modelOf(await s.run({ ...CALL, model: "claude-opus-5-5#max" }))).toBe("anthropic/claude-opus-5-5#max")
    expect(modelOf(await s.run({ ...CALL, model: "review#low" }))).toBe("anthropic/claude-opus-5-5#low")
    expect(modelOf(await s.run({ ...CALL, agent: "explore", model: "#xhigh" }))).toBe(`${CODEX_A}/gpt-6-luna#xhigh`)
    expect(modelOf(await s.run({ ...CALL, model: "#low" }))).toBe(`${CODEX_A}/gpt-6-sol#low`)
    expect(s.alerts).toEqual([])
  })

  test("the old bug: provider/<entry-model>#variant ran at the entry's effort; the variant now counts", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    expect(modelOf(await s.run({ ...CALL, model: "openai/gpt-6-luna#low" }))).toBe(`${CODEX_A}/gpt-6-luna#low`)
    expect(modelOf(await s.run({ ...CALL, model: `${OAI}/gpt-6-luna#xhigh` }))).toBe(`${CODEX_A}/gpt-6-luna#xhigh`)
    expect(modelOf(await s.run({ ...CALL, model: "gpt-6-luna#medium" }))).toBe(`${CODEX_A}/gpt-6-luna#medium`)
  })

  test("a paid entry is never raised: lowering runs, a raise is declined with no allow-once", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    expect(modelOf(await s.run({ ...CALL, model: "deepseek-v4-pro#low" }))).toBe(`${DS}/deepseek-v4-pro#low`)
    expect(agentOf(await s.run({ ...CALL, model: "deepseek-v4-pro#max" }))).toBe(
      Preset.rejection({ reason: "effort-cap", max: "high", once: false }),
    )
  })

  test("a spent paid entry falls back; the effort is fitted to the fallback under its own ceiling", async () => {
    await using s = await setup({ preset: { ...CHATGPT_POOL, subagentEffortMax: "xhigh" } })
    await s.spend(BUDGET_USD + 1)
    // The paid entry could never be raised; its fallback, the Claude subscription, may go up to xhigh here.
    const event = await s.gate({ ...CALL, agent: "own-review", model: "deepseek-v4-pro#xhigh" })
    expect(modelOf(event)).toBe("anthropic/claude-opus-5-5#xhigh")
    expect(await s.finish(event, "reviewed")).toBe(
      "reviewed\n\nNote: model deepseek-v4-pro is not available now (its monthly budget is used up), so this subagent ran on model claude-opus-5-5.",
    )
    expect(agentOf(await s.gate({ ...CALL, agent: "own-review", model: "deepseek-v4-pro#max" }))).toBe(
      Preset.rejection({ reason: "effort-cap", max: "xhigh", once: true }),
    )
  })

  test("the fallback's notice and the effort's share the result: one sentence each", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    await s.spend(BUDGET_USD + 1)
    // GPT-6 Luna has no `none`: the next level up is sent, and the result says so after the fallback.
    const event = await s.gate({ ...CALL, agent: "explore", model: "deepseek-v4-pro#none" })
    expect(modelOf(event)).toBe(`${CODEX_A}/gpt-6-luna#low`)
    expect(await s.finish(event)).toBe(
      [
        "done",
        "",
        "Note: model deepseek-v4-pro is not available now (its monthly budget is used up), so this subagent ran on model gpt-6-luna.",
        "Note: this subagent's model has no reasoning effort none, so it runs at low.",
      ].join("\n"),
    )
  })

  test("a local entry has no levels: none is sent, with a notice, never a rejection", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    const event = await s.gate({ ...CALL, model: "qwen3-coder-30b#high" })
    expect(modelOf(event)).toBe(`ollama/${OLLAMA.id}`)
    expect(await s.finish(event)).toBe(
      "done\n\nNote: this subagent's model has no reasoning levels, so it runs without a reasoning effort.",
    )
  })
})

describe("opencode_models under a pool (07 §5.5, D5)", () => {
  test("pool pin providers are listed; a paid one over its budget is not; others stay out", async () => {
    await using s = await setup({ preset: CHATGPT_POOL })
    const listing = () => ({
      providers: [CODEX_A, "anthropic", "ollama", DS, OAI, "own-codex-bbbb"].map((id) => ({
        id,
        models: [{ id: "m" }],
      })),
      total: 6,
      next: null,
    })
    const listed = async () => {
      const event = {
        tool: "opencode_models",
        sessionID: ROOT,
        input: {},
        status: "completed" as const,
        result: { output: listing() as unknown, content: "" },
      }
      await s.modules.presets.onToolAfter(event)
      return (event.result.output as ReturnType<typeof listing>).providers.map((provider) => provider.id)
    }
    expect(await listed()).toEqual([CODEX_A, "anthropic", "ollama", DS, OAI])
    await s.spend(BUDGET_USD + 1)
    expect(await listed()).toEqual([CODEX_A, "anthropic", "ollama", OAI])
  })
})

// Merge round 11: local-model-type's 로컬 모델 account (02 §3.3a) as a subagent under preset-fixes' 강도 고정 (07 §2.3).
describe("a local model account as a subagent with a fixed effort (02 §3.3a, 07 §2.3 강도 고정)", () => {
  const LOCAL = Account.ID.make("acc_lcl1")
  const LOCAL_PROVIDER = Kind.ProviderID.from("compat", "lcl1")
  const CODER = { key: "local-coder", model: "local-coder", account: LOCAL }

  /** The fixture's accounts plus a keyless local Chat Completions server whose model takes low, medium and high. */
  async function localRegistry(): Promise<Registry.File> {
    const base = await registry([
      ...SEATS,
      { kind: "compat", label: "Local coder", slug: "lcl1", baseURL: "http://127.0.0.1:8088/v1" },
    ])
    const local = { format: "chat" as const }
    const built = Templates.fromCompat(
      [
        {
          id: "local-coder",
          contextLimit: 131_072,
          outputLimit: 32_000,
          reasoning: { style: "effort", levels: ["low", "medium", "high"], default: "medium" },
        },
      ],
      "2026-10-01T00:00:00Z",
      local,
    )
    if (!built.ok) throw new Error(built.reason)
    return {
      ...base,
      accounts: base.accounts.map((account) =>
        account.id === LOCAL ? { ...account, compat: { ...account.compat, local } } : account,
      ),
      slots: Object.fromEntries(
        Object.entries(base.slots).map(([id, slot]) =>
          id === LOCAL_PROVIDER ? [id, { ...slot, modelTemplate: OwnID.TemplateID.make("tpl_own_compat_lcl1") }] : [id, slot],
        ),
      ),
      modelTemplates: { ...base.modelTemplates, tpl_own_compat_lcl1: built.template },
    }
  }

  test("the preset's level runs on the local model and the asked level is not used", async () => {
    const preset = pooled("codex", [LUNA, CODER], { forcedEffort: "medium" })
    await using s = await setup({ preset, registry: await localRegistry() })
    const event = await s.gate({ ...CALL, model: "local-coder#low" })
    expect(modelOf(event)).toBe(`${LOCAL_PROVIDER}/local-coder#medium`)
    expect(await s.finish(event)).toContain("this preset fixes reasoning effort at medium, so the requested low was not used")
    expect(s.alerts).toEqual([])
  })

  test("an entry's level the model lacks is fitted to its highest, past a preset that raises nothing", async () => {
    const preset = pooled("codex", [LUNA, { ...CODER, forcedEffort: "max" }], { subagentEffortMax: "off" })
    await using s = await setup({ preset, registry: await localRegistry() })
    const event = await s.gate({ ...CALL, model: "local-coder" })
    expect(modelOf(event)).toBe(`${LOCAL_PROVIDER}/local-coder#high`)
    expect(await s.finish(event)).toContain("has no reasoning effort max, so it runs at high")
  })
})
