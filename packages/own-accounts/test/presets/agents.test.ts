// Hidden agents' configured models (07 §5.4 "내장 에이전트의 모델", PG2 (마) unit part) over the real slots and presets
// modules on a temp OWN_HOME. The agent editor is a fake with core's editor semantics; every account is fake.

import { describe, expect, test } from "bun:test"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { sessionEvent, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"
import { memoryStorage, registryWith } from "../slots/support.js"

const CX02 = "own-codex-cx02"
const DS = "own-ds-ds01"
const DIRECTORY = "D:/work"

const CLAUDE_ON: Plugins.ClaudeSlot = { detected: true, version: "1.0.0", integrity: "sha512-x", verified: true }
const CLAUDE_OFF: Plugins.ClaudeSlot = { detected: false, version: null, integrity: null, verified: false }

interface AgentRecord {
  id: string
  hidden: boolean
  mode: "primary" | "subagent" | "all"
  model?: { providerID: string; id: string; variant?: string }
  permissions?: Array<{ action: string; resource: string; effect: string }>
}

/** Core's agents before own-accounts' transform, with configured models (fake values). */
function agents(): AgentRecord[] {
  return [
    { id: "build", hidden: false, mode: "primary", model: { providerID: CX02, id: "gpt-6-sol" } },
    { id: "title", hidden: true, mode: "primary", model: { providerID: CX02, id: "gpt-6-luna" } },
    { id: "summary", hidden: true, mode: "primary", model: { providerID: DS, id: "deepseek-flash" } },
    { id: "compaction", hidden: true, mode: "primary", model: { providerID: "ollama", id: "qwen3" } },
    { id: "own-review", hidden: true, mode: "subagent", model: { providerID: CX02, id: "gpt-6-sol" } },
  ]
}

/** An agent editor over plain records, like core's (`update` edits the stored record). */
function editor(records: AgentRecord[]) {
  const value = {
    list: () => records,
    get: (id: string) => records.find((record) => record.id === id),
    default: () => {},
    update: (id: string, update: (agent: AgentRecord) => void) => {
      const found = records.find((record) => record.id === id)
      if (found) update(found)
    },
    remove: () => {},
  }
  // SAFETY: the transform uses `list` and `update`; the records carry the fields it reads.
  return value as unknown as AgentEditor
}

async function setup(input: { readonly claude?: Plugins.ClaudeSlot } = {}) {
  const transforms: Array<(editor: AgentEditor) => void> = []
  const disposed: number[] = []
  const claude = { slot: input.claude ?? CLAUDE_ON }
  const reloads = { agents: 0 }
  // Only what the late registration and the re-fold use: any other context access (I/O) throws.
  const t = await testDeps({
    directory: DIRECTORY,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      storage: memoryStorage().storage,
      agent: {
        transform: async (callback: (editor: AgentEditor) => void) => {
          const index = transforms.push(callback) - 1
          return { dispose: async () => void disposed.push(index) }
        },
        reload: async () => {
          reloads.agents++
        },
      },
    },
  })
  await t.deps.runtime.registry.write(
    await registryWith([
      { kind: "codex", label: "ChatGPT 01", slug: "cx01" },
      { kind: "codex", label: "ChatGPT 02", slug: "cx02" },
      { kind: "ds", label: "DeepSeek", slug: "ds01" },
    ]),
  )
  const alerts: Telemetry.AlertInput[] = []
  const factories: Partial<Modules.Factories> = {
    plugins: (deps, peers) => ({
      ...Modules.FACTORIES.plugins(deps, peers),
      claudeSlot: () => claude.slot,
    }),
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
  }
  const modules = t.modules(factories)
  await modules.slots.start()
  return {
    t,
    presets: modules.presets,
    /** Another own-accounts instance of the same process (another Location's), on the same runtime. */
    instance: () => t.modules(factories),
    claude,
    reloads,
    alerts,
    transforms,
    disposed,
    /** Runs the setup registration's fold over fresh agent records. */
    fold: (records = agents()) => {
      modules.presets.transformAgents(editor(records))
      return records
    },
    pluginsUpdated: (directory = DIRECTORY) =>
      modules.presets.onEvent?.(sessionEvent("plugin.updated", {}, directory), { local: directory === DIRECTORY }),
    providersUpdated: () =>
      modules.presets.onEvent?.(sessionEvent("provider.updated", {}, DIRECTORY), { local: true }),
    async [Symbol.asyncDispose]() {
      await modules.presets.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

const byId = (records: AgentRecord[]) => Object.fromEntries(records.map((record) => [record.id, record.model]))

describe("ctx.agent.transform", () => {
  test("a hidden agent on an own subscription slot loses its model; one alert, raised after the fold", async () => {
    await using s = await setup()
    const records = s.fold()
    expect(byId(records).title).toBeUndefined()
    // No I/O inside the fold: the alert (ledger write, RPC event) is queued, not raised.
    expect(s.alerts).toEqual([])
    s.t.clock.advance(0)
    expect(s.alerts.map((alert) => [alert.code, alert.severity, alert.sessionID])).toEqual([
      ["internal_agent_model_removed", "warning", undefined],
    ])
    expect(s.alerts[0]?.message).toContain("title")
    expect(s.alerts[0]?.message).toContain(`${CX02}/gpt-6-luna`)
    // Every rebuild folds again; the same agent and model is not raised again.
    s.fold()
    s.t.clock.advance(0)
    expect(s.alerts).toHaveLength(1)
    expect<unknown>(s.presets.removedAgentModels()).toEqual([
      { agent: "title", model: { providerID: CX02, id: "gpt-6-luna" } },
    ])
  })

  test("metered and local models stay; visible primaries and subagents are not this check's", async () => {
    await using s = await setup()
    expect(byId(s.fold())).toEqual({
      build: { providerID: CX02, id: "gpt-6-sol" },
      title: undefined,
      summary: { providerID: DS, id: "deepseek-flash" },
      compaction: { providerID: "ollama", id: "qwen3" },
      "own-review": { providerID: CX02, id: "gpt-6-sol" },
    })
  })

  test("the Claude slot's models count as a subscription only while the slot is installed", async () => {
    const claude = (): AgentRecord[] => [
      { id: "title", hidden: true, mode: "primary", model: { providerID: "anthropic", id: "claude-haiku-4-5" } },
    ]
    {
      await using s = await setup({ claude: CLAUDE_ON })
      expect(byId(s.fold(claude())).title).toBeUndefined()
    }
    await using s = await setup({ claude: CLAUDE_OFF })
    expect(byId(s.fold(claude())).title).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5" })
    expect(s.presets.removedAgentModels()).toEqual([])
  })

  test("explore loses its shell again and asks before a web request or search, last (07 §2.4, MR10-3, MR11)", async () => {
    await using s = await setup()
    // Core's explore rules since upstream 7725ac81eb (`packages/core/src/plugin/agent.ts`).
    const explore: AgentRecord = {
      id: "explore",
      hidden: false,
      mode: "subagent",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "webfetch", resource: "*", effect: "allow" },
        { action: "websearch", resource: "*", effect: "allow" },
      ],
    }
    const records = s.fold([...agents(), explore])
    expect(records.find((record) => record.id === "explore")?.permissions?.slice(-3)).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "websearch", resource: "*", effect: "ask" },
    ])
    // No other agent gets a rule, and a fold without explore adds none.
    expect(records.filter((record) => record.permissions !== undefined).map((record) => record.id)).toEqual(["explore"])
    expect(s.fold().some((record) => record.permissions !== undefined)).toBe(false)
  })

  test("a fixed configuration clears the selfTest record at the next fold", async () => {
    await using s = await setup()
    s.fold()
    expect(s.presets.removedAgentModels()).toHaveLength(1)
    s.fold(agents().map((record) => (record.id === "title" ? { ...record, model: undefined } : record)))
    expect(s.presets.removedAgentModels()).toEqual([])
  })

  test("selfTest sees the removals of every live instance: a project config is folded only in its Location", async () => {
    await using s = await setup()
    await s.presets.start()
    const project = s.instance()
    await project.slots.start()
    await project.presets.start()
    // Only the project's Location has `agents.title.model` on ChatGPT 02; the control instance folded nothing.
    project.presets.transformAgents(editor(agents()))
    const expected = [{ agent: "title", model: { providerID: CX02, id: "gpt-6-luna" } }]
    expect<unknown>(s.presets.removedAgentModels()).toEqual(expected)
    expect<unknown>(project.presets.removedAgentModels()).toEqual(expected)
    // A closed Location no longer answers.
    await project.presets.stop()
    await project.slots.stop()
    expect(s.presets.removedAgentModels()).toEqual([])
  })
})

describe("re-folding when the check's inputs change", () => {
  /** Waits for the queued agent reload, if any (`stop` awaits the module's registration queue). */
  const queued = (s: { readonly presets: { stop(): Promise<void> } }) => s.presets.stop()
  const claudeTitle = (): AgentRecord[] => [
    { id: "title", hidden: true, mode: "primary", model: { providerID: "anthropic", id: "claude-haiku-4-5" } },
  ]

  test("claude-auth installed while running: the agents fold again and the Claude slot model goes", async () => {
    await using s = await setup({ claude: CLAUDE_OFF })
    expect(byId(s.fold(claudeTitle())).title).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5" })
    // Nothing changed: no reload.
    s.presets.recheckAgents()
    await s.providersUpdated()
    await queued(s)
    expect(s.reloads.agents).toBe(0)

    s.claude.slot = CLAUDE_ON
    s.presets.recheckAgents()
    // A provider reload of the same change does not ask twice.
    await s.providersUpdated()
    await queued(s)
    expect(s.reloads.agents).toBe(1)
    // The reload's fold now removes it.
    expect(byId(s.fold(claudeTitle())).title).toBeUndefined()
    s.claude.slot = CLAUDE_OFF
    await s.providersUpdated()
    await queued(s)
    expect(s.reloads.agents).toBe(2)
  })

  test("a provider reload that changes no judgement leaves the agents alone", async () => {
    await using s = await setup()
    s.fold()
    await s.providersUpdated()
    await queued(s)
    expect(s.reloads.agents).toBe(0)
  })
})

describe("the late registration (after the config's agents)", () => {
  test("plugins of this Location activated: registered again and the previous one dropped", async () => {
    await using s = await setup()
    await s.pluginsUpdated()
    await until(() => s.transforms.length === 1)
    const records = agents()
    s.transforms[0]?.(editor(records))
    expect(byId(records).title).toBeUndefined()
    expect(s.presets.removedAgentModels().map((removal) => removal.agent)).toEqual(["title"])

    await s.pluginsUpdated()
    await until(() => s.disposed.includes(0))
    expect(s.transforms).toHaveLength(2)
    // Another Location's activation is not this one's.
    await s.pluginsUpdated("D:/elsewhere")
    await s.presets.stop()
    expect(s.transforms).toHaveLength(2)
    // Plugin cleanup drops the current one.
    expect(s.disposed).toEqual([0, 1])
  })
})
