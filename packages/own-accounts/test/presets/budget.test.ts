// Money on subagent targets (07 §5.4 step 4, §1.2, PG11 own-accounts part): a paid target whose monthly budget is used
// up declines the call (`budget`, `preset_budget_exhausted`), a fallback from a blocked subscription onto a paid target
// waits for the user's consent for this conversation (0 paid requests before it), and A loses a paid provider over
// budget. Real slots, presets and telemetry modules on a temp OWN_HOME over the 2026-10-01 catalog fixture; the
// DeepSeek key has a $5 budget; sessions and agents are fakes and every account is fake.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Kv, Ledger, Preset } from "@own/protocol"
import { Modules } from "../../src/modules.js"
import { Gate } from "../../src/presets/gate.js"
import type { ModelsFilter } from "../../src/presets/models-filter.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { fakeEditor, memoryStorage } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { messagesOver } from "../support/session-messages.js"
import {
  ANTHROPIC,
  CLAUDE,
  CLAUDE_ON,
  CODEX_A,
  DEEPSEEK,
  DEEPSEEK_KEY,
  DS,
  OPENAI,
  registry,
} from "./fixtures/catalog-2026-10-01.js"

const ROOT = "ses_budget_root"
const CHILD = "ses_budget_child"
const DIRECTORY = "D:/work"
const MAIN = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const PARENT = `${CODEX_A}/gpt-6-sol#high`
const DS_FLASH = `${DS}/deepseek-flash#high`
const BUDGET_USD = 5
const PRESET_ID = "pr_01JB0000000000000000000031"

const decodePreset = Schema.decodeUnknownSync(Preset.Info)
const decodeLine = Schema.decodeUnknownSync(Ledger.Line)

const pin = (account: string, model: string) => ({ pin: { account, model } })

function preset(review: ReadonlyArray<unknown>): Preset.Info {
  return decodePreset({
    ...Preset.builtin("codex"),
    id: PRESET_ID,
    name: "리뷰",
    workers: { mode: "by-role", roles: { "own-review": { targets: review, effort: "inherit" } } },
  })
}

/** Review on the Claude slot, DeepSeek (paid) second. */
const CLAUDE_THEN_DS = preset([pin(CLAUDE, "claude-opus-5-5"), pin(DEEPSEEK_KEY, "deepseek-flash")])
/** Review on DeepSeek, chosen first by the user. */
const DS_FIRST = preset([pin(DEEPSEEK_KEY, "deepseek-flash")])

async function setup(stored: Preset.Info) {
  const sessions = new Map<string, Readonly<Record<string, unknown>>>()
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
        context: async () => [{ id: "msg_budget_1", type: "user" }],
        messages: messagesOver(() => [{ id: "msg_budget_1", type: "user" }]),
      },
      agent: {
        get: async (request: { readonly agentID: string }) => ({
          location: { directory: DIRECTORY },
          data: { id: request.agentID },
        }),
      },
    },
  })
  const base = await registry()
  await t.deps.runtime.registry.write({
    ...base,
    accounts: base.accounts.map((account) =>
      account.id === DEEPSEEK_KEY ? { ...account, budget: { monthlyUSD: BUDGET_USD } } : account,
    ),
  })
  await t.deps.runtime.presets.write({ version: 1, groups: { codex: { presets: [stored] } } })
  const alerts: Telemetry.AlertInput[] = []
  const modules = t.modules({
    plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
  })
  await modules.slots.start()
  // Telemetry keeps its ledger book current from the `ledger.line` broadcast (a budget is read through it).
  await modules.telemetry.start()
  await modules.presets.start()
  modules.slots.transformProviders(
    fakeEditor({ openai: { models: OPENAI }, anthropic: { models: ANTHROPIC }, deepseek: { models: DEEPSEEK } }).editor,
  )
  sessions.set(ROOT, { id: ROOT, agent: "build", model: MAIN })
  await kv.storage.set(Kv.preset(ROOT), {
    presetID: stored.id,
    group: "codex",
    revision: 0,
    appliedAt: t.clock.now(),
    entryHash: null,
  })
  const calls = { next: 0 }
  return {
    t,
    modules,
    kv,
    alerts,
    logs,
    sessions,
    gate: async (call: Readonly<Record<string, unknown>> = {}) => {
      const event = {
        tool: "subagent",
        sessionID: ROOT,
        id: `call_budget_${++calls.next}`,
        input: { agent: "own-review", description: "Review", prompt: "Review it", ...call } as unknown,
      }
      await modules.presets.onToolBefore(event)
      return event
    },
    /** The Claude slot waits for its limit to reset (02 §5.7). */
    blockClaude: () =>
      t.deps.runtime.limits.exhaust({
        accountID: CLAUDE,
        windowId: null,
        until: t.clock.now() + 60_000,
        class: "hard",
      }),
    /** The user's answer for this conversation (`session.preset.consent`, KV presetConsent). */
    consent: (allow: boolean) =>
      kv.storage.set(Kv.presetConsent(ROOT), { accounts: { [DEEPSEEK_KEY]: { allow, at: t.clock.now() } } }),
    /** Spends `amount` USD on the DeepSeek key this month (a ledger line, as telemetry writes it). */
    spend: async (amount: number) => {
      const eid = `evt_budget_${amount}`
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

const agentOf = (event: { readonly input: unknown }) => (event.input as { readonly agent: string }).agent
const modelOf = (event: { readonly input: unknown }) => (event.input as { readonly model?: string }).model

describe("budget (07 §5.4 step 4, PG11)", () => {
  test("a paid target within its budget runs where the user pinned it, no consent needed for a first target", async () => {
    await using s = await setup(DS_FIRST)
    await s.spend(1)
    expect(modelOf(await s.gate())).toBe(DS_FLASH)
    expect(s.alerts).toEqual([])
  })

  test("over budget: `budget`, with the account for the UI, and preset_budget_exhausted in the log", async () => {
    await using s = await setup(DS_FIRST)
    await s.spend(BUDGET_USD + 1)
    const event = await s.gate()
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "budget", roles: ["own-review"] }))
    expect(modelOf(event)).toBeUndefined()
    expect(s.alerts.map((alert) => [alert.code, alert.accountID, alert.subject])).toEqual([
      ["subagent_rejected", DEEPSEEK_KEY, "budget:own-review"],
    ])
    expect(s.logs.some((line) => line.includes("preset_budget_exhausted") && line.includes(DEEPSEEK_KEY))).toBe(true)
  })

  test("a per-call effort never moves a call around its budget (07 §2.3): still `budget`, at any level", async () => {
    await using s = await setup(DS_FIRST)
    await s.spend(BUDGET_USD + 1)
    for (const model of ["#low", "review#max"])
      expect(agentOf(await s.gate({ model }))).toBe(Preset.rejection({ reason: "budget", roles: ["own-review"] }))
  })

  test("over budget the paid provider leaves A: listing and continued children", async () => {
    await using s = await setup(DS_FIRST)
    const listing = (): ModelsFilter.After => ({
      tool: "opencode_models",
      sessionID: ROOT,
      input: {},
      status: "completed",
      result: {
        output: {
          providers: [
            { id: CODEX_A, models: [{}] },
            { id: DS, models: [{}] },
          ],
          total: 2,
          next: null,
        },
      },
    })
    const providers = (event: ModelsFilter.After) =>
      event.status === "completed" ? (event.result.output as { providers: Array<{ id: string }> }).providers : []
    const within = listing()
    await s.modules.presets.onToolAfter(within)
    expect(providers(within).map((provider) => provider.id)).toEqual([CODEX_A, DS])

    s.sessions.set(CHILD, {
      id: CHILD,
      parentID: ROOT,
      agent: "general",
      model: { providerID: DS, id: "deepseek-flash" },
    })
    const continued = { agent: "general", sessionID: CHILD }
    expect(modelOf(await s.gate(continued))).toBeUndefined()

    await s.spend(BUDGET_USD)
    const over = listing()
    await s.modules.presets.onToolAfter(over)
    expect(providers(over).map((provider) => provider.id)).toEqual([CODEX_A])
    expect(modelOf(await s.gate(continued))).toBe(PARENT)
  })
})

describe("consent for a paid fallback (07 §1.2, §5.4 step 4)", () => {
  test("a blocked subscription with a paid next target: `consent`, and no paid request is made", async () => {
    await using s = await setup(CLAUDE_THEN_DS)
    expect(modelOf(await s.gate())).toBe("anthropic/claude-opus-5-5#high")
    s.blockClaude()
    const event = await s.gate()
    expect(agentOf(event)).toBe(Preset.rejection({ reason: "consent", roles: ["own-review"] }))
    expect(modelOf(event)).toBeUndefined()
    expect(s.alerts.map((alert) => [alert.code, alert.accountID, alert.subject])).toEqual([
      ["subagent_rejected", DEEPSEEK_KEY, "consent:own-review"],
    ])
    // A declined call holds nothing.
    expect(s.t.deps.runtime.reservations.counts(ROOT)).toMatchObject({ message: 1, session: 1 })
  })

  test("[이 대화에서만]: the paid target runs, and the LLM is told the role fell back", async () => {
    await using s = await setup(CLAUDE_THEN_DS)
    s.blockClaude()
    await s.consent(true)
    const event = await s.gate()
    expect(modelOf(event)).toBe(DS_FLASH)
    const done = {
      tool: "subagent",
      sessionID: ROOT,
      id: event.id,
      status: "completed" as const,
      result: { content: "reviewed" },
    }
    await Gate.after(s.t.deps)(done)
    expect(done.result.content).toEndWith("so this subagent ran on the role's next target.")
  })

  test("[아니오]: the role goes on past the paid target, to the main at the end of the list", async () => {
    await using s = await setup(CLAUDE_THEN_DS)
    s.blockClaude()
    await s.consent(false)
    expect(modelOf(await s.gate())).toBe(PARENT)
    expect(s.alerts).toEqual([])
  })

  test("consent never lifts the budget", async () => {
    await using s = await setup(CLAUDE_THEN_DS)
    s.blockClaude()
    await s.consent(true)
    await s.spend(BUDGET_USD)
    expect(agentOf(await s.gate())).toBe(Preset.rejection({ reason: "budget", roles: ["own-review"] }))
  })

  test("a ledger that cannot be read fails closed: the role runs as a plain inherit, never on the paid target", async () => {
    await using s = await setup(DS_FIRST)
    s.modules.telemetry.quotaSnapshot = async () => {
      throw new Error("ledger exploded")
    }
    const call = { agent: "own-review", description: "Review", prompt: "Review it" }
    expect((await s.gate()).input).toEqual(call)
    // A role name written as `model` drops to that inherit; an explicit paid model is declined.
    expect((await s.gate({ model: "review" })).input).toEqual(call)
    expect(agentOf(await s.gate({ model: DS_FLASH }))).toBe(Preset.rejection({ reason: "model", roles: [] }))
    expect(s.logs.some((line) => line.includes("subagent_gate_undecided") && line.includes("ledger exploded"))).toBe(
      true,
    )
    expect(s.t.deps.runtime.reservations.counts(ROOT)).toMatchObject({ running: 0, session: 0 })
  })
})
