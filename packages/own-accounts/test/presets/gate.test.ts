// The subagent gate (07 §5.4, T0: every group has only its `평소대로`) over the real slots, presets and telemetry
// modules on a temp OWN_HOME: ChatGPT accounts 01 and 02, one metered DeepSeek account with a $5 budget, the Claude
// slot. The main is ChatGPT 01 unless a test says otherwise. Sessions and agents are fakes; every account is fake.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Kv, Ledger, OwnID, Preset } from "@own/protocol"
import { Hooks } from "../../src/hooks.js"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps } from "../support/deps.js"
import { memoryStorage, registryWith } from "../slots/support.js"

const CX01 = "own-codex-cx01"
const CX02 = "own-codex-cx02"
const DS = "own-ds-ds01"
const ROOT = "ses_gate_root"
const CHILD = "ses_gate_child"
const MAIN = { providerID: CX01, id: "gpt-6-sol", variant: "high" }
const PARENT = `${CX01}/gpt-6-sol#high`
const BUDGET_USD = 5

const CLAUDE_ON: Plugins.ClaudeSlot = { detected: true, version: "1.0.0", integrity: "sha512-x", verified: true }

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

const decodeLine = Schema.decodeUnknownSync(Ledger.Line)

async function setup(
  input: {
    readonly main?: Ref
    readonly preset?: Partial<Preset.Info>
    readonly session?: () => never
    readonly telemetry?: Partial<Telemetry.Api>
  } = {},
) {
  const sessions = new Map<string, SessionRecord>()
  const agents = new Map<string, { readonly id: string; readonly model?: Ref }>()
  const logs: string[] = []
  const memory = memoryStorage()
  const t = await testDeps({
    logs,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      storage: memory.storage,
      session: {
        get:
          input.session ??
          (async (request: { readonly sessionID: string }) => {
            const found = sessions.get(request.sessionID)
            if (!found) throw new Error(`session not found: ${request.sessionID}`)
            return { ...found, location: { directory: "D:/work" } }
          }),
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
  const registry = await registryWith([
    { kind: "codex", label: "ChatGPT 01", slug: "cx01" },
    { kind: "codex", label: "ChatGPT 02", slug: "cx02" },
    { kind: "ds", label: "DeepSeek", slug: "ds01" },
  ])
  await t.deps.runtime.registry.write({
    ...registry,
    accounts: registry.accounts.map((account) =>
      account.kind === "ds" ? { ...account, budget: { monthlyUSD: BUDGET_USD } } : account,
    ),
  })
  const alerts: Telemetry.AlertInput[] = []
  const preset = input.preset
  const modules = t.modules({
    plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (deps, peers) => ({
      ...Modules.FACTORIES.telemetry(deps, peers),
      alert: (alert) => alerts.push(alert),
      ...input.telemetry,
    }),
    // A stored preset (T1) stands in for the root's binding: the store answers it for any id.
    ...(preset
      ? {
          presets: (deps, peers) => ({
            ...Modules.FACTORIES.presets(deps, peers),
            preset: (_id, group) => ({ ...Preset.builtin(group), ...preset }),
          }),
        }
      : {}),
  })
  await modules.slots.start()
  // Telemetry keeps its ledger book current from the `ledger.line` broadcast (a budget is read through it).
  await modules.telemetry.start()
  sessions.set(ROOT, { id: ROOT, agent: "build", model: input.main ?? MAIN })
  return {
    t,
    modules,
    sessions,
    agents,
    alerts,
    logs,
    storage: memory.values,
    /** Runs the gate on one tool call and returns the event as the next hook (and core) sees it. */
    gate: async (call: Readonly<Record<string, unknown>>, options: { readonly tool?: string } = {}) => {
      const event = { tool: options.tool ?? "subagent", sessionID: ROOT, input: call as unknown }
      await modules.presets.onToolBefore(event)
      return event
    },
    /** Spends `amount` USD on the DeepSeek account this month (a ledger line, as telemetry writes it). */
    spend: async (amount: number) => {
      const accountID = registry.accounts.find((account) => account.kind === "ds")?.id
      const eid = `evt_spend_${amount}`
      const line = decodeLine({
        v: 1,
        ts: t.clock.now(),
        sessionID: "ses_spent",
        messageID: null,
        kind: "primary",
        accountID,
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

describe("a model the LLM wrote (07 §5.4 steps 2–3, PG2 (가))", () => {
  test("another ChatGPT account is rejected through `agent`, so core answers `Unknown agent: own-preset: …`", async () => {
    await using s = await setup()
    const event = await s.gate({ ...CALL, model: `${CX02}/gpt-6-sol` })
    expect(agentOf(event).startsWith(Preset.REJECT_PREFIX)).toBe(true)
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "model", roles: [] }))
    // The rest of the call is passed on as it came.
    expect(event.input).toMatchObject({
      description: CALL.description,
      prompt: CALL.prompt,
      model: `${CX02}/gpt-6-sol`,
    })
    expect(s.alerts.map((alert) => [alert.code, alert.severity, alert.sessionID])).toEqual([
      ["subagent_rejected", "info", ROOT],
    ])
    expect(s.alerts[0]?.message).toContain(`${CX02}/gpt-6-sol`)
  })

  test("the canonical id the identity shows maps onto the main slot, variant kept (02 §4.3 D9)", async () => {
    await using s = await setup()
    const event = await s.gate({ ...CALL, model: "openai/gpt-6-sol#xhigh" })
    expect(modelOf(event)).toBe(`${CX01}/gpt-6-sol#xhigh`)
    expect(agentOf(event)).toBe("general")
    expect(s.alerts).toEqual([])
  })

  test("a canonical id of a model the main slot does not have is rejected", async () => {
    await using s = await setup()
    const event = await s.gate({ ...CALL, model: "openai/gpt-4o" })
    expect(agentOf(event).startsWith(Preset.REJECT_PREFIX)).toBe(true)
  })

  test("a model of the main account is kept", async () => {
    await using s = await setup()
    const event = await s.gate({ ...CALL, model: `${CX01}/gpt-6-luna` })
    expect(modelOf(event)).toBe(`${CX01}/gpt-6-luna`)
    expect(agentOf(event)).toBe("general")
  })

  test("a role name runs on the parent's Ref (07 §3.2)", async () => {
    await using s = await setup()
    expect(modelOf(await s.gate({ ...CALL, model: "review" }))).toBe(PARENT)
    expect(modelOf(await s.gate({ ...CALL, model: "own-quick" }))).toBe(PARENT)
  })

  test("a local or metered provider the LLM picks is rejected: only the user's configuration may name one", async () => {
    await using s = await setup()
    expect(agentOf(await s.gate({ ...CALL, model: "ollama/qwen3" })).startsWith(Preset.REJECT_PREFIX)).toBe(true)
    expect(agentOf(await s.gate({ ...CALL, model: `${DS}/deepseek-flash` })).startsWith(Preset.REJECT_PREFIX)).toBe(
      true,
    )
  })
})

describe("the agent's configured model (07 §5.4 steps 3–4)", () => {
  test("no model and an agent without one: the call is untouched", async () => {
    await using s = await setup()
    s.agents.set("general", { id: "general" })
    const call = { ...CALL }
    const event = await s.gate(call)
    expect(event.input).toBe(call)
    expect(s.alerts).toEqual([])
  })

  test("a subscription slot is replaced by the parent's Ref and reported (PG2 (가))", async () => {
    await using s = await setup()
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: CX02, id: "gpt-6-luna" } })
    const event = await s.gate({ ...CALL, agent: "reviewer" })
    expect(modelOf(event)).toBe(PARENT)
    expect(agentOf(event)).toBe("reviewer")
    expect(s.alerts.map((alert) => [alert.code, alert.sessionID])).toEqual([["subagent_model_overridden", ROOT]])
    expect(s.alerts[0]?.message).toContain(`${CX02}/gpt-6-luna`)
    expect(s.alerts[0]?.message).toContain(PARENT)
  })

  test("the Claude slot is a subscription too", async () => {
    await using s = await setup()
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: "anthropic", id: "claude-opus-5-5" } })
    expect(modelOf(await s.gate({ ...CALL, agent: "reviewer" }))).toBe(PARENT)
    expect(s.alerts.map((alert) => alert.code)).toEqual(["subagent_model_overridden"])
  })

  test("a ready metered account within its budget is allowed for that agent, written explicitly", async () => {
    await using s = await setup()
    await s.spend(1)
    s.agents.set("cheap", { id: "cheap", model: { providerID: DS, id: "deepseek-flash" } })
    const event = await s.gate({ ...CALL, agent: "cheap" })
    expect(modelOf(event)).toBe(`${DS}/deepseek-flash`)
    expect(agentOf(event)).toBe("cheap")
    expect(s.alerts).toEqual([])
  })

  test("a metered account whose monthly budget is used up is rejected (budget)", async () => {
    await using s = await setup()
    await s.spend(BUDGET_USD + 1)
    s.agents.set("cheap", { id: "cheap", model: { providerID: DS, id: "deepseek-flash" } })
    const event = await s.gate({ ...CALL, agent: "cheap" })
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "budget", roles: [] }))
    expect(s.alerts.map((alert) => alert.code)).toEqual(["subagent_rejected"])
    expect(s.alerts[0]?.message).toContain("budget")
  })

  test("a metered account that cannot serve now (exhausted) is rejected", async () => {
    await using s = await setup()
    const account = s.modules.slots.slot(DS)?.account
    if (!account) throw new Error("no DeepSeek account")
    s.t.deps.runtime.limits.exhaust({
      accountID: account.id,
      windowId: null,
      until: s.t.clock.now() + 60_000,
      class: "hard",
    })
    s.agents.set("cheap", { id: "cheap", model: { providerID: DS, id: "deepseek-flash" } })
    expect(agentOf(await s.gate({ ...CALL, agent: "cheap" }))).toBe(Preset.rejection({ reason: "model", roles: [] }))
  })

  test("a local provider is allowed for that agent", async () => {
    await using s = await setup()
    s.agents.set("local", { id: "local", model: { providerID: "ollama", id: "qwen3" } })
    const event = await s.gate({ ...CALL, agent: "local" })
    expect(modelOf(event)).toBe("ollama/qwen3")
    expect(s.alerts).toEqual([])
  })

  test("a model of the main account stays with core (it runs there anyway)", async () => {
    await using s = await setup()
    const call = { ...CALL, agent: "light" }
    s.agents.set("light", { id: "light", model: { providerID: CX01, id: "gpt-6-luna" } })
    expect((await s.gate(call)).input).toBe(call)
  })

  test("any other provider is rejected", async () => {
    await using s = await setup()
    s.agents.set("builtin", { id: "builtin", model: { providerID: "openai", id: "gpt-6-sol" } })
    expect(agentOf(await s.gate({ ...CALL, agent: "builtin" })).startsWith(Preset.REJECT_PREFIX)).toBe(true)
  })
})

describe("continued children (07 §5.5)", () => {
  test("a child on another ChatGPT account moves to the parent's Ref", async () => {
    await using s = await setup()
    s.agents.set("general", { id: "general" })
    s.sessions.set(CHILD, { id: CHILD, parentID: ROOT, agent: "general", model: { providerID: CX02, id: "gpt-6-sol" } })
    expect(modelOf(await s.gate({ ...CALL, sessionID: CHILD }))).toBe(PARENT)
  })

  test("a child on the main account keeps its model and its cache", async () => {
    await using s = await setup()
    s.agents.set("general", { id: "general" })
    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "general",
      model: { providerID: CX01, id: "gpt-6-luna" },
    })
    const call = { ...CALL, sessionID: CHILD }
    expect((await s.gate(call)).input).toBe(call)
  })

  test("a child on its agent's admitted metered model stays; once over budget it moves to the parent", async () => {
    await using s = await setup()
    s.agents.set("cheap", { id: "cheap", model: { providerID: DS, id: "deepseek-flash" } })
    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "cheap",
      model: { providerID: DS, id: "deepseek-flash" },
    })
    const call = { ...CALL, agent: "cheap", sessionID: CHILD }
    expect((await s.gate(call)).input).toBe(call)
    await s.spend(BUDGET_USD)
    expect(modelOf(await s.gate(call))).toBe(PARENT)
  })

  test("switching a child to an agent with a subscription model is overridden like a new child", async () => {
    await using s = await setup()
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: CX02, id: "gpt-6-luna" } })
    s.sessions.set(CHILD, { id: CHILD, parentID: ROOT, agent: "general", model: { providerID: CX01, id: "gpt-6-sol" } })
    expect(modelOf(await s.gate({ ...CALL, agent: "reviewer", sessionID: CHILD }))).toBe(PARENT)
    expect(s.alerts.map((alert) => alert.code)).toEqual(["subagent_model_overridden"])
  })
})

describe("a parent stored without a variant (core reads it back as `default`)", () => {
  const main = { providerID: CX01, id: "gpt-6-sol", variant: "default" }
  const parent = `${CX01}/gpt-6-sol`

  test("a role name is written without `#default`, which core would refuse", async () => {
    await using s = await setup({ main })
    expect(modelOf(await s.gate({ ...CALL, model: "review" }))).toBe(parent)
  })

  test("a configured subscription slot is replaced by the parent's model without `#default`", async () => {
    await using s = await setup({ main })
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: CX02, id: "gpt-6-luna" } })
    expect(modelOf(await s.gate({ ...CALL, agent: "reviewer" }))).toBe(parent)
    expect(s.alerts[0]?.message).not.toContain("#default")
  })

  test("a continued child on another ChatGPT account moves to the parent's model without `#default`", async () => {
    await using s = await setup({ main })
    s.agents.set("general", { id: "general" })
    s.sessions.set(CHILD, { id: CHILD, parentID: ROOT, agent: "general", model: { providerID: CX02, id: "gpt-6-sol" } })
    expect(modelOf(await s.gate({ ...CALL, sessionID: CHILD }))).toBe(parent)
  })
})

describe("the main and the preset", () => {
  test("a binding to a preset this build cannot read runs like 평소대로; the gate writes nothing", async () => {
    await using s = await setup()
    const binding = {
      presetID: `pr_${OwnID.ulid(s.t.clock.now())}`,
      group: "codex",
      revision: 3,
      appliedAt: s.t.clock.now(),
      entryHash: null,
    }
    await s.t.deps.ctx.storage.set(Kv.preset(ROOT), binding)
    expect(agentOf(await s.gate({ ...CALL, model: `${CX02}/gpt-6-sol` })).startsWith(Preset.REJECT_PREFIX)).toBe(true)
    expect(modelOf(await s.gate({ ...CALL, model: "openai/gpt-6-luna" }))).toBe(`${CX01}/gpt-6-luna`)
    // No permission, instruction entry or switch: the only key is the binding, unchanged.
    expect([...s.storage]).toEqual([[Kv.preset(ROOT), binding]])
  })

  test("delegation `off` rejects every call (07 §2.5)", async () => {
    await using s = await setup({ preset: { delegation: "off" } })
    const event = await s.gate({ ...CALL })
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "off" }))
    expect(s.alerts.map((alert) => alert.code)).toEqual(["subagent_rejected"])
  })

  test("ultra on a preset with delegation `off` delegates actively: the gate runs the call (07 §2.9)", async () => {
    await using s = await setup({ preset: { delegation: "off" } })
    s.agents.set("general", { id: "general" })
    await s.t.deps.ctx.storage.set(Kv.preset(ROOT), {
      presetID: Preset.builtinID("codex"),
      group: "codex",
      revision: 0,
      appliedAt: s.t.clock.now(),
      entryHash: null,
      ultra: {},
    })
    const event = await s.gate({ ...CALL })
    expect(agentOf(event)).toBe("general")
    expect(s.alerts.map((alert) => alert.code)).not.toContain("subagent_rejected")
  })

  test("main on the Claude slot: ChatGPT models are rejected, its own models kept", async () => {
    await using s = await setup({ main: { providerID: "anthropic", id: "claude-opus-5-5" } })
    expect(agentOf(await s.gate({ ...CALL, model: `${CX01}/gpt-6-sol` })).startsWith(Preset.REJECT_PREFIX)).toBe(true)
    expect(agentOf(await s.gate({ ...CALL, model: "openai/gpt-6-sol" })).startsWith(Preset.REJECT_PREFIX)).toBe(true)
    expect(modelOf(await s.gate({ ...CALL, model: "anthropic/claude-haiku-4-5" }))).toBe("anthropic/claude-haiku-4-5")
  })

  test("main on a provider without an own account: only that provider", async () => {
    await using s = await setup({ main: { providerID: "fake-a", id: "m" } })
    expect(agentOf(await s.gate({ ...CALL, model: `${CX01}/gpt-6-sol` })).startsWith(Preset.REJECT_PREFIX)).toBe(true)
    expect(modelOf(await s.gate({ ...CALL, model: "fake-a/n" }))).toBe("fake-a/n")
  })

  test("other tools are untouched", async () => {
    await using s = await setup()
    const call = { model: `${CX02}/gpt-6-sol`, agent: "general" }
    expect((await s.gate(call, { tool: "read" })).input).toBe(call)
  })
})

describe("when the gate cannot decide only a plain inherit passes (07 §5.4, decision 2026-10-02)", () => {
  const REJECTED = Preset.rejection({ reason: "model", roles: [] })
  const exploded = () => {
    throw new Error("session lookup exploded")
  }
  const undecided = (logs: ReadonlyArray<string>, text: string) =>
    logs.some((line) => line.includes("subagent_gate_undecided") && line.includes(text))

  test("a throw: an explicit model is rejected, even a canonical id or one on the main slot", async () => {
    await using s = await setup({ session: exploded })
    s.agents.set("general", { id: "general" })
    const models = [`${CX02}/gpt-6-sol`, "openai/gpt-6-sol", `${CX01}/gpt-6-luna`, "ollama/qwen3"]
    for (const model of models) expect(agentOf(await s.gate({ ...CALL, model }))).toBe(REJECTED)
    expect(s.alerts.map((alert) => [alert.code, alert.subject])).toEqual(
      models.map((model) => ["subagent_rejected", `model:${model}`]),
    )
    expect(undecided(s.logs, "session lookup exploded")).toBe(true)
  })

  test("a throw: no model and an agent without one inherit untouched; a role name becomes that inherit", async () => {
    await using s = await setup({ session: exploded })
    s.agents.set("general", { id: "general" })
    const call = { ...CALL }
    expect((await s.gate(call)).input).toBe(call)
    expect((await s.gate({ ...CALL, model: "review" })).input).toEqual(CALL)
    expect(s.alerts).toEqual([])
  })

  test("a throw: an agent with a configured model is rejected, even a local one", async () => {
    await using s = await setup({ session: exploded })
    s.agents.set("local", { id: "local", model: { providerID: "ollama", id: "qwen3" } })
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: CX02, id: "gpt-6-luna" } })
    expect(agentOf(await s.gate({ ...CALL, agent: "local" }))).toBe(REJECTED)
    expect(agentOf(await s.gate({ ...CALL, agent: "reviewer", model: "review" }))).toBe(REJECTED)
    expect(s.alerts.map((alert) => alert.subject)).toEqual(["model:ollama/qwen3", `model:${CX02}/gpt-6-luna`])
  })

  test("a throw after the main is known (the budget lookup) rejects the configured metered model", async () => {
    await using s = await setup({
      telemetry: {
        quotaSnapshot: async () => {
          throw new Error("ledger exploded")
        },
      },
    })
    s.agents.set("cheap", { id: "cheap", model: { providerID: DS, id: "deepseek-flash" } })
    expect(agentOf(await s.gate({ ...CALL, agent: "cheap" }))).toBe(REJECTED)
    expect(undecided(s.logs, "ledger exploded")).toBe(true)
  })

  test("no main (the root has no stored model): explicit and configured models are rejected", async () => {
    await using s = await setup()
    s.sessions.set(ROOT, { id: ROOT, agent: "build" })
    s.agents.set("cheap", { id: "cheap", model: { providerID: DS, id: "deepseek-flash" } })
    expect(agentOf(await s.gate({ ...CALL, model: "openai/gpt-6-sol" }))).toBe(REJECTED)
    expect(agentOf(await s.gate({ ...CALL, model: `${CX01}/gpt-6-sol` }))).toBe(REJECTED)
    expect(agentOf(await s.gate({ ...CALL, agent: "cheap" }))).toBe(REJECTED)
    expect(s.alerts.map((alert) => alert.code)).toEqual(["subagent_rejected", "subagent_rejected", "subagent_rejected"])
    expect(undecided(s.logs, `"cause":"main"`)).toBe(true)
  })

  test("no main (the session lookup fails): an explicit model is rejected", async () => {
    await using s = await setup()
    s.sessions.delete(ROOT)
    expect(agentOf(await s.gate({ ...CALL, model: `${CX02}/gpt-6-sol` }))).toBe(REJECTED)
    expect(agentOf(await s.gate({ ...CALL, model: "openai/gpt-6-luna" }))).toBe(REJECTED)
  })

  test("no main, no model and an agent without one: the call is untouched and nothing is reported", async () => {
    await using s = await setup()
    s.sessions.delete(ROOT)
    s.agents.set("general", { id: "general" })
    const call = { ...CALL }
    expect((await s.gate(call)).input).toBe(call)
    expect((await s.gate({ ...CALL, model: "own-quick" })).input).toEqual(CALL)
    expect(s.alerts).toEqual([])
  })

  test("a failed agent lookup rejects a call without a model: a configured model cannot be ruled out", async () => {
    await using s = await setup()
    // No agent is registered, so every agent lookup fails; the main is known.
    expect(agentOf(await s.gate({ ...CALL }))).toBe(REJECTED)
    expect(s.alerts.map((alert) => alert.subject)).toEqual(["model:general"])
    s.sessions.set(CHILD, { id: CHILD, parentID: ROOT, agent: "general", model: { providerID: CX01, id: "gpt-6-sol" } })
    expect(agentOf(await s.gate({ ...CALL, sessionID: CHILD }))).toBe(REJECTED)
    // Without a main a role name needs the lookup too.
    s.sessions.set(ROOT, { id: ROOT, agent: "build" })
    expect(agentOf(await s.gate({ ...CALL, model: "review" }))).toBe(REJECTED)
  })

  test("a continued child the gate cannot look up passes only without a configured model", async () => {
    await using s = await setup()
    s.agents.set("general", { id: "general" })
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: CX02, id: "gpt-6-luna" } })
    const call = { ...CALL, sessionID: "ses_gate_missing" }
    expect((await s.gate(call)).input).toBe(call)
    expect(agentOf(await s.gate({ ...call, agent: "reviewer" }))).toBe(REJECTED)
  })

  test("a continued child stored without a model: a switch to a configured agent is still decided", async () => {
    await using s = await setup()
    s.agents.set("general", { id: "general" })
    s.agents.set("light", { id: "light", model: { providerID: CX01, id: "gpt-6-luna" } })
    s.agents.set("reviewer", { id: "reviewer", model: { providerID: CX02, id: "gpt-6-luna" } })
    s.sessions.set(CHILD, { id: CHILD, parentID: ROOT, agent: "general" })
    // Core moves a switched child to the agent's model, which the gate judges like a new child's.
    const light = { ...CALL, agent: "light", sessionID: CHILD }
    expect((await s.gate(light)).input).toBe(light)
    expect(modelOf(await s.gate({ ...CALL, agent: "reviewer", sessionID: CHILD }))).toBe(PARENT)
    expect(s.alerts.map((alert) => alert.code)).toEqual(["subagent_model_overridden"])
    // Staying with its agent, the child runs on no known model: only an agent without a configured model passes.
    const stay = { ...CALL, sessionID: CHILD }
    expect((await s.gate(stay)).input).toBe(stay)
    s.sessions.set(CHILD, { id: CHILD, parentID: ROOT, agent: "light" })
    expect(agentOf(await s.gate({ ...CALL, agent: "light", sessionID: CHILD }))).toBe(REJECTED)
    expect(undecided(s.logs, `"cause":"child"`)).toBe(true)
  })
})

describe("registration (hooks.ts)", () => {
  test("a throw inside the gate rejects an explicit model there and never reaches core", async () => {
    await using s = await setup({
      session: () => {
        throw new Error("session lookup exploded")
      },
    })
    const before = await registerBefore(s)
    const event = { tool: "subagent", sessionID: ROOT, input: { ...CALL, model: `${CX02}/gpt-6-sol` } as unknown }
    await before(event)
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "model", roles: [] }))
    expect(s.logs.some((line) => line.includes("subagent_gate_undecided"))).toBe(true)
    // The gate decided on its own: the guard had nothing to catch.
    expect(s.logs.some((line) => line.includes("hook_failed"))).toBe(false)
  })

  test("a throw past the decision is logged as hook_failed and never reaches core; the rejection stands", async () => {
    await using s = await setup({
      telemetry: {
        alert: () => {
          throw new Error("alert exploded")
        },
      },
    })
    const before = await registerBefore(s)
    const event = { tool: "subagent", sessionID: ROOT, input: { ...CALL, model: `${CX02}/gpt-6-sol` } as unknown }
    await before(event)
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "model", roles: [] }))
    expect(s.logs.some((line) => line.includes("hook_failed") && line.includes("tool.execute.before"))).toBe(true)
  })
})

/** Registers the hooks on a context that captures `execute.before`; every other registration is a no-op. */
async function registerBefore(s: Awaited<ReturnType<typeof setup>>) {
  const before: Array<(event: unknown) => Promise<void> | void> = []
  const registration = { dispose: async () => {} }
  const registered = async () => registration
  const ctx = {
    provider: { transform: registered },
    model: { transform: registered },
    agent: { transform: registered },
    skill: { transform: registered },
    session: { hook: registered },
    tool: {
      hook: async (name: string, callback: (event: unknown) => Promise<void> | void) => {
        if (name === "execute.before") before.push(callback)
        return registration
      },
    },
  }
  // SAFETY: the context parts `Hooks.register` touches: tool hooks are captured, every other registration is a no-op.
  await Hooks.register({ ...s.t.deps, ctx: ctx as unknown as typeof s.t.deps.ctx }, s.modules)
  expect(before).toHaveLength(1)
  const hook = before[0]
  if (!hook) throw new Error("execute.before was not registered")
  return hook
}
