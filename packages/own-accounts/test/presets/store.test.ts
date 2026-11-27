// Group new-session defaults (07 §2.2, §8.1 T0 part) over the real slots module, a fake fold and fixture Codex files.
// The Codex home is a temp folder: no test reads this PC's `.codex`. Every account is fake.

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { Model } from "@opencode/schema/model"
import { Account, Kind, OwnID, type Registry } from "@own/protocol"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { PresetStore } from "../../src/presets/store.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { Templates } from "../../src/slots/templates.js"
import { sessionEvent, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"
import { catalogModel, failure, fakeEditor, memoryStorage, price, registryWith, rpcContext } from "../slots/support.js"

const CLAUDE_OFF: Plugins.ClaudeSlot = { detected: false, version: null, integrity: null, verified: false }
const CLAUDE_ON: Plugins.ClaudeSlot = { detected: true, version: "1.0.0", integrity: "sha512-x", verified: true }
const SEP_04 = Date.UTC(2026, 8, 4)
const SEP_22 = Date.UTC(2026, 8, 22)

/** The `openai` catalog the fold sees (fake prices modelled on 07 Appendix A): Sol and Luna share a release day. */
const OPENAI = [
  catalogModel("openai", "gpt-6-astra", { time: { released: SEP_04 }, cost: [price(10, 50)] }),
  catalogModel("openai", "gpt-6-sol", { time: { released: SEP_22 }, cost: [price(2, 10)] }),
  catalogModel("openai", "gpt-6-luna", { time: { released: SEP_22 }, cost: [price(0.1, 0.5)] }),
]

const CONFIG = ['model = "gpt-6-astra"', 'model_reasoning_effort = "high"', ""].join("\n")
const CACHE = JSON.stringify({
  models: [
    { slug: "gpt-6-sol", priority: 1, default_reasoning_level: "medium" },
    { slug: "gpt-6-astra", priority: 2, default_reasoning_level: "low" },
  ],
})

const CODEX_A = "own-codex-aaaa"
const CODEX_B = "own-codex-bbbb"

async function setup(input: {
  readonly registry: Registry.File
  readonly codex?: Readonly<Record<string, string>>
  readonly catalog?: Readonly<Record<string, ReadonlyArray<Model.Info>>>
  readonly claude?: Plugins.ClaudeSlot
}) {
  const t = await testDeps({
    ctx: { provider: { reload: async () => {}, list: async () => [] }, storage: memoryStorage().storage },
  })
  const codexHome = path.join(t.home, "codex-fixture")
  await fs.mkdir(codexHome)
  await Promise.all(
    Object.entries(input.codex ?? {}).map(([name, text]) => fs.writeFile(path.join(codexHome, name), text)),
  )
  const deps = { ...t.deps, options: { ...t.deps.options, codexHome } }
  await deps.runtime.registry.write(input.registry)
  const claude = { value: input.claude ?? CLAUDE_OFF }
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => claude.value }),
  })
  await modules.slots.start()
  await modules.presets.start()
  const fold = fakeEditor(
    Object.fromEntries(Object.entries(input.catalog ?? { openai: OPENAI }).map(([id, models]) => [id, { models }])),
  )
  modules.slots.transformProviders(fold.editor)
  const events: string[] = []
  // SAFETY: the fake implements the only member the emitter uses, `events.emit`.
  const registration = { events: { emit: async (name: string) => void events.push(name) } }
  deps.emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
  const presets = modules.presets
  return {
    t,
    deps,
    presets,
    codexHome,
    events,
    file: () => deps.runtime.presets.read(),
    slots: modules.slots,
    /** Provider reloads settled on the leader (the T0 migration and a group's first account). */
    settle: async (groups: ReadonlyArray<string> = []) => {
      presets.onEvent?.(sessionEvent("provider.updated", {}), { local: true })
      t.clock.advance(PresetStore.SETTLE_MS)
      const decided = () => deps.runtime.presets.cached()?.groups ?? {}
      await until(() => groups.every((group) => group in decided()))
    },
    async [Symbol.asyncDispose]() {
      await presets.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

const seats = (extra: Parameters<typeof registryWith>[0] = []) =>
  registryWith([
    { kind: "codex", label: "ChatGPT 01", slug: "aaaa" },
    { kind: "codex", label: "ChatGPT 02", slug: "bbbb" },
    ...extra,
  ])

describe("auto defaults (07 §2.2)", () => {
  test("the T0 migration decides each group once: ChatGPT from this PC's Codex config, DeepSeek its newest", async () => {
    await using s = await setup({
      registry: await seats([{ kind: "ds", label: "DS", slug: "dddd" }]),
      codex: { "config.toml": CONFIG, "models_cache.json": CACHE },
    })
    await s.settle(["codex", "ds"])
    await until(() => s.events.includes("presets.changed"))
    const groups = (await s.file()).groups
    expect<unknown>(groups.codex?.defaultModel).toEqual({
      id: "gpt-6-astra",
      variant: "high",
      source: "auto",
      basis: "codex-config",
    })
    expect<unknown>(groups.ds?.defaultModel).toEqual({ id: "deepseek-flash", source: "auto", basis: "newest" })
    // Every account of the group starts the same way.
    expect(await s.presets.defaultFor({ kind: "codex", providerID: CODEX_B })).toEqual({
      providerID: CODEX_B,
      id: "gpt-6-astra",
      variant: "high",
    })
  })

  test("decided once: a later Codex config or a cheaper same-day model changes nothing (U3)", async () => {
    await using s = await setup({ registry: await seats(), codex: { "config.toml": CONFIG } })
    expect(await s.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toMatchObject({ id: "gpt-6-astra" })
    await fs.writeFile(path.join(s.codexHome, "config.toml"), 'model = "gpt-6-luna"\n')
    await s.settle()
    const listed = await s.presets.list({}, rpcContext())
    expect<unknown>(listed).toMatchObject({
      groups: [
        { group: "codex", defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" } },
      ],
    })
  })

  test("without a config: the first Codex metadata priority with its default effort", async () => {
    await using s = await setup({ registry: await seats(), codex: { "models_cache.json": CACHE } })
    expect(await s.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-sol",
      variant: "medium",
    })
  })

  test("without Codex files: the most expensive family's newest model, priced from the openai catalog", async () => {
    await using s = await setup({ registry: await seats() })
    expect(await s.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-astra",
    })
    // A new session decides in memory; the leader writes the same value once reloads settle.
    expect((await s.file()).groups).toEqual({})
    await s.settle(["codex"])
    expect<unknown>((await s.file()).groups.codex?.defaultModel).toEqual({
      id: "gpt-6-astra",
      source: "auto",
      basis: "family-price",
    })
  })

  test("the Claude slot: its anthropic catalog's newest, a tie to the higher price", async () => {
    const anthropic = [
      catalogModel("anthropic", "claude-haiku-5", { time: { released: SEP_22 }, cost: [price(1, 5)] }),
      catalogModel("anthropic", "claude-opus-5-5", { time: { released: SEP_22 }, cost: [price(15, 75)] }),
    ]
    await using s = await setup({ registry: await seats(), catalog: { openai: OPENAI, anthropic }, claude: CLAUDE_ON })
    const listed = await s.presets.list({ group: "claude-sub" }, rpcContext())
    expect<unknown>(listed).toMatchObject({
      groups: [{ group: "claude-sub", defaultModel: { id: "claude-opus-5-5", source: "auto", basis: "newest" } }],
    })
  })

  test("compat: the first model of the group's first account; another server's account starts on its own first", async () => {
    const registry = await registryWith([
      { kind: "compat", label: "vLLM", slug: "cpa1", baseURL: "http://127.0.0.1:1/v1" },
      { kind: "compat", label: "LM", slug: "cpb2", baseURL: "http://127.0.0.1:2/v1" },
    ])
    const template = (ids: ReadonlyArray<string>) => {
      const built = Templates.fromCompat(
        ids.map((id) => ({ id, contextLimit: 128_000 })),
        "2026-10-01T00:00:00Z",
      )
      if (!built.ok) throw new Error(built.reason)
      return built.template
    }
    const withTemplates: Registry.File = {
      ...registry,
      slots: Object.fromEntries(
        Object.entries(registry.slots).map(([id, slot]) => [
          id,
          { ...slot, modelTemplate: OwnID.TemplateID.make(`tpl_${id.replaceAll("-", "_")}`) },
        ]),
      ),
      modelTemplates: {
        tpl_own_compat_cpa1: template(["qwen3-coder", "llama-4"]),
        tpl_own_compat_cpb2: template(["gemma-4"]),
      },
    }
    await using s = await setup({ registry: withTemplates })
    // Whichever account asks first, the group's value comes from its first account in registry order.
    expect(await s.presets.defaultFor({ kind: "compat", providerID: Kind.ProviderID.from("compat", "cpb2") })).toEqual({
      providerID: "own-compat-cpb2",
      id: "gemma-4",
    })
    expect<string | undefined>(s.presets.known("compat")?.id).toBe("qwen3-coder")
    await s.settle(["compat"])
    expect<unknown>((await s.file()).groups.compat?.defaultModel).toEqual({
      id: "qwen3-coder",
      source: "auto",
      basis: "first",
    })
    expect(await s.presets.defaultFor({ kind: "compat", providerID: Kind.ProviderID.from("compat", "cpb2") })).toEqual({
      providerID: "own-compat-cpb2",
      id: "gemma-4",
    })
  })
})

describe("presets.defaults.set (07 §8.1)", () => {
  test("a user default serves every account of the group; null returns to auto, decided again now", async () => {
    await using s = await setup({ registry: await seats(), codex: { "config.toml": CONFIG } })
    await s.settle(["codex"])
    const set = await s.presets.defaultsSet(
      { group: "codex", defaultModel: { id: Model.ID.make("gpt-6-sol"), variant: Model.VariantID.make("xhigh") } },
      rpcContext(),
    )
    expect<unknown>(set).toMatchObject({
      group: "codex",
      defaultModel: { id: "gpt-6-sol", variant: "xhigh", source: "user" },
    })
    expect(await s.presets.defaultFor({ kind: "codex", providerID: CODEX_B })).toEqual({
      providerID: CODEX_B,
      id: "gpt-6-sol",
      variant: "xhigh",
    })
    // A user value never yields to the migration or to Codex.
    await s.settle()
    expect<unknown>((await s.file()).groups.codex?.defaultModel).toMatchObject({ id: "gpt-6-sol", source: "user" })

    await fs.writeFile(path.join(s.codexHome, "config.toml"), 'model = "gpt-6-luna"\n')
    const reset = await s.presets.defaultsSet({ group: "codex", defaultModel: null }, rpcContext())
    expect<unknown>(reset).toMatchObject({
      group: "codex",
      defaultModel: { id: "gpt-6-luna", source: "auto", basis: "codex-config" },
    })
  })

  test("a user model no account has is kept, listed as missing, and new sessions use the group rule", async () => {
    await using s = await setup({ registry: await seats(), codex: { "config.toml": CONFIG } })
    const set = await s.presets.defaultsSet(
      { group: "codex", defaultModel: { id: Model.ID.make("gpt-5.5-pro") } },
      rpcContext(),
    )
    expect<unknown>(set).toMatchObject({
      group: "codex",
      defaultModel: { id: "gpt-5.5-pro", source: "user", missing: true },
    })
    expect(await s.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-astra",
      variant: "high",
    })
    expect<unknown>((await s.file()).groups.codex?.defaultModel).toEqual({ id: "gpt-5.5-pro", source: "user" })
    // A group without accounts is listed while the file names it.
    const ds = await s.presets.defaultsSet(
      { group: "ds", defaultModel: { id: Model.ID.make("deepseek-flash") } },
      rpcContext(),
    )
    expect<unknown>(ds).toMatchObject({
      group: "ds",
      defaultModel: { id: "deepseek-flash", source: "user", missing: true },
    })
    const listed = await s.presets.list({}, rpcContext())
    expect(failure(listed)).toBeUndefined()
    expect("groups" in listed ? listed.groups.map((row) => row.group) : []).toEqual(["codex", "ds"])
  })

  test("an unusable presets.json is never overwritten; defaults still work from memory", async () => {
    await using s = await setup({ registry: await seats(), codex: { "config.toml": CONFIG } })
    await Bun.write(s.deps.runtime.layout.presets, "{ not json")
    expect(await s.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toMatchObject({ id: "gpt-6-astra" })
    // The leader's write fails; the decided value stays in memory, so presets.list and new sessions agree.
    s.presets.onEvent?.(sessionEvent("provider.updated", {}), { local: true })
    s.t.clock.advance(PresetStore.SETTLE_MS)
    const listed = await s.presets.list({}, rpcContext())
    expect<unknown>(listed).toMatchObject({
      groups: [
        { group: "codex", defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" } },
      ],
    })
    expect<string | undefined>(s.presets.known("codex")?.id).toBe("gpt-6-astra")
    const set = await s.presets.defaultsSet({ group: "codex", defaultModel: null }, rpcContext())
    expect(failure(set)?.type).toBe("internal_error")
    expect(await Bun.file(s.deps.runtime.layout.presets).text()).toBe("{ not json")
  })

  test("presets.list (read scope) never writes presets.json; the leader writes the value it answered", async () => {
    await using s = await setup({ registry: await seats(), codex: { "config.toml": CONFIG } })
    const listed = await s.presets.list({}, rpcContext())
    expect<unknown>(listed).toMatchObject({
      groups: [
        { group: "codex", defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" } },
      ],
    })
    expect(await Bun.file(s.deps.runtime.layout.presets).exists()).toBe(false)
    expect(s.events).not.toContain("presets.changed")
    // The Codex config changes before the leader writes: the value already answered is the one written (U3).
    await fs.writeFile(path.join(s.codexHome, "config.toml"), 'model = "gpt-6-luna"\n')
    await s.settle(["codex"])
    expect<unknown>((await s.file()).groups.codex?.defaultModel).toMatchObject({ id: "gpt-6-astra", variant: "high" })
  })

  test("an account added later joins its group's existing default (no second decision)", async () => {
    await using s = await setup({ registry: await seats(), codex: { "config.toml": CONFIG } })
    await s.settle(["codex"])
    await fs.writeFile(path.join(s.codexHome, "config.toml"), 'model = "gpt-6-sol"\n')
    const created = await s.slots.mutate((current) => {
      const account = current.accounts[0]
      const slot = current.slots[CODEX_A]
      if (!account || !slot) return undefined
      const providerID = Kind.ProviderID.from("codex", "cccc")
      const added = { ...account, id: Account.ID.make("acc_cccc"), providerID }
      return { ...current, accounts: [...current.accounts, added], slots: { ...current.slots, [providerID]: slot } }
    })
    expect(created.accounts).toHaveLength(3)
    expect(await s.presets.defaultFor({ kind: "codex", providerID: "own-codex-cccc" })).toMatchObject({
      id: "gpt-6-astra",
      variant: "high",
    })
  })
})
