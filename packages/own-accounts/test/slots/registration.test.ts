import { describe, expect, test } from "bun:test"
import { Provider } from "@opencode/schema/provider"
import { CodexModels, Compaction, Kind, Preset, type Registry } from "@own/protocol"
import { Endpoints } from "../../src/endpoints.js"
import { Registration } from "../../src/slots/registration.js"
import { Templates } from "../../src/slots/templates.js"
import { catalogModel, fakeEditor, price, registryWith, type AccountSeed } from "./support.js"

const PROD = Endpoints.resolve(undefined)

async function one(seed: AccountSeed, endpoints = PROD) {
  const registry = await registryWith([seed])
  const built = Registration.definitions(registry, endpoints)
  expect(built.problems).toEqual([])
  const definition = built.definitions[0]
  if (!definition) throw new Error("no definition")
  return { registry, definition }
}

describe("provider info (02 §3.6)", () => {
  test("codex replicates the upstream ChatGPT wiring and nothing secret", async () => {
    const { definition } = await one({
      kind: "codex",
      label: "업무",
      slug: "7k2m",
      identity: { chatgptAccountId: "acct-1" },
    })
    expect<unknown>(definition.info).toEqual({
      id: "own-codex-7k2m",
      name: "ChatGPT · 업무",
      canonical: "openai",
      activation: "enabled",
      package: "@opencode/ai/providers/openai",
      settings: {
        baseURL: "https://chatgpt.com/backend-api/codex",
        transport: "websocket",
        encoding: "zstd",
        compaction: { type: "summary" },
      },
      headers: { originator: "opencode", "x-codex-beta-features": "remote_compaction_v2" },
    })
    expect(JSON.stringify(definition.info)).not.toContain("acct-1")
    expect(definition.info).not.toHaveProperty("integrationID")
  })

  test("codex on the HTTP fallback leaves transport out; the base URL follows the endpoint override", async () => {
    const endpoints = Endpoints.resolve({ codex: "http://127.0.0.1:9/backend-api/codex" })
    const { definition } = await one({ kind: "codex", label: "a", slug: "abcd", transport: "http" }, endpoints)
    expect(definition.info.settings).toEqual({
      baseURL: "http://127.0.0.1:9/backend-api/codex",
      compaction: { type: "summary" },
    })
  })

  test("API key kinds: native package, canonical, no auth settings, base URL only when overridden", async () => {
    for (const kind of ["oai", "anth", "ds", "xai", "or"] as const) {
      const { definition } = await one({ kind, label: "k", slug: "q9x1" })
      expect<unknown>(definition.info).toEqual({
        id: `own-${kind}-q9x1`,
        name: `${Registration.KIND_NAMES[kind]} · k`,
        canonical: Kind.meta[kind].canonical,
        activation: "enabled",
        package: Kind.meta[kind].package,
        settings: { compaction: { type: "summary" } },
      })
    }
    const overridden = await one(
      { kind: "oai", label: "k", slug: "q9x2" },
      Endpoints.resolve({ openai: "http://127.0.0.1:1/v1" }),
    )
    expect(overridden.definition.info.settings).toEqual({
      baseURL: "http://127.0.0.1:1/v1",
      compaction: { type: "summary" },
    })
    const ds = await one({ kind: "ds", label: "k", slug: "m2r5" })
    expect(ds.definition.info.package).toBe("@opencode/ai/providers/deepseek")
  })

  test("siwc is served by the public API: no base URL in production, HTTP, zstd bodies, no ChatGPT headers", async () => {
    const { definition } = await one({ kind: "siwc", label: "Plus", slug: "s1k2" })
    expect<unknown>(definition.info).toEqual({
      id: "own-siwc-s1k2",
      name: "ChatGPT · Plus",
      canonical: "openai",
      activation: "enabled",
      package: "@opencode/ai/providers/openai",
      settings: { encoding: "zstd", compaction: { type: "summary" } },
    })
    // The test override of the OpenAI endpoint applies and keeps zstd (the fakes decode it); the Codex endpoint never
    // does.
    const endpoints = Endpoints.resolve({ openai: "http://127.0.0.1:1/v1", codex: "http://127.0.0.1:2/codex" })
    const overridden = await one({ kind: "siwc", label: "Plus", slug: "s1k3", transport: "websocket" }, endpoints)
    expect(overridden.definition.info.settings).toEqual({
      baseURL: "http://127.0.0.1:1/v1",
      encoding: "zstd",
      compaction: { type: "summary" },
    })
    // A base URL of the slot's own is sent plain JSON, as upstream does for a configured one (chatgpt.ts 5673bfa4a8).
    const own = await one({ kind: "siwc", label: "Plus", slug: "s1k4", baseURL: "http://127.0.0.1:3/v1" }, endpoints)
    expect(own.definition.info.settings).toEqual({ baseURL: "http://127.0.0.1:3/v1", compaction: { type: "summary" } })
    // Plan-billed models compact by summary and never show a price.
    for (const model of overridden.definition.models) {
      expect(model.settings?.compaction).toEqual({ type: "summary" })
      expect(model.cost).toEqual([])
      expect(model.package).toBe("@opencode/ai/providers/openai")
    }
  })

  test("compat writes no canonical, uses the user's base URL and window; core compacts at 90% of it (07 §6.2 #2)", async () => {
    const registry = await registryWith([])
    const compat = Templates.fromCompat([{ id: "qwen3-coder", contextLimit: 128_000 }], "2026-09-27T00:00:00Z")
    if (!compat.ok) throw new Error(compat.reason)
    const withCompat: Registry.File = {
      ...registry,
      accounts: [
        {
          id: "acc_c1" as never,
          kind: "compat",
          label: "local",
          shortLabel: "L",
          color: "slate",
          providerID: Kind.ProviderID.from("compat", "b5n0"),
          cacheDomain: "cd_b5n0" as never,
          quotaDomain: "qd_b5n0" as never,
          billing: "metered",
          identity: {},
          autoSwitch: true,
          status: "ready",
        },
      ],
      slots: {
        "own-compat-b5n0": {
          kind: "compat",
          accounts: ["acc_c1" as never],
          pooling: "off",
          modelTemplate: "tpl_compat_b5n0" as never,
          baseURL: "http://127.0.0.1:8080/v1",
        },
      },
      modelTemplates: {
        tpl_compat_b5n0: compat.template,
      },
    }
    const [definition] = Registration.definitions(withCompat, PROD).definitions
    expect<unknown>(definition?.info).toEqual({
      id: "own-compat-b5n0",
      name: "OpenAI-compatible · local",
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      // No route timeouts: a local server may read a long prompt for more than core's five minutes (4c0d0ff478).
      settings: {
        baseURL: "http://127.0.0.1:8080/v1",
        headerTimeout: false,
        chunkTimeout: false,
        compaction: { type: "summary" },
      },
    })
    const [model] = definition?.models ?? []
    if (!model) throw new Error("no compat model")
    // Core alone would keep 15% free (128k − 19.2k = 108.8k, upstream v2.1). The registered input lands its ceiling on
    // 90% instead; the window and the output limit, which core fits to the window, stay the model's.
    expect(model.limit).toEqual({ context: 128_000, input: 135_529, output: 32_000 })
    expect(Compaction.ceiling(model.limit.input ?? 0)).toBe(115_200)
    const [pinned] = compat.template.models
    if (!pinned) throw new Error("no compat template model")
    expect(Registration.threshold("compat", {}, pinned, {})).toMatchObject({
      windowTokens: 128_000,
      triggerTokens: 115_200,
      effectiveInput: 135_529,
      source: "v2",
    })
  })

  test("compat slots register a 90% window at every size; other kinds keep core's ceiling (R8, US-1)", () => {
    const compat = Templates.fromCompat(
      [
        { id: "small", contextLimit: 32_768, outputLimit: 8_192 },
        { id: "large", contextLimit: 262_144 },
      ],
      "2026-09-27T00:00:00Z",
    )
    if (!compat.ok) throw new Error(compat.reason)
    const models = Registration.models({
      providerID: Kind.ProviderID.from("compat", "b5n0"),
      slot: {
        kind: "compat",
        accounts: ["acc_c1" as never],
        pooling: "off",
        modelTemplate: "tpl_compat_b5n0" as never,
      },
      account: {
        id: "acc_c1" as never,
        kind: "compat",
        label: "local",
        shortLabel: "L",
        color: "slate",
        providerID: Kind.ProviderID.from("compat", "b5n0"),
        cacheDomain: "cd_b5n0" as never,
        quotaDomain: "qd_b5n0" as never,
        billing: "metered",
        identity: {},
        autoSwitch: true,
        status: "ready",
      },
      template: compat.template,
    })
    const limits = Object.fromEntries(models.map((model) => [String(model.id), model.limit]))
    // 32,768: 29,491 (90%) rather than core's 16,768; output untouched.
    expect(limits.small).toEqual({ context: 32_768, input: 45_491, output: 8_192 })
    expect(Compaction.ceiling(45_491)).toBe(29_491)
    // Core keeps 15% of a large window free since upstream v2.1, so a large compat window registers its input too.
    expect(limits.large).toEqual({ context: 262_144, input: 277_563, output: 32_000 })
    expect(Compaction.ceiling(277_563)).toBe(235_929)
    // The same 32,768 window on a DeepSeek slot stays at core's ceiling.
    expect(
      Registration.threshold(
        "ds",
        {},
        { id: "m" as never, modelID: "m" as never, limit: { context: 32_768, output: 8_192 } },
        {},
      ),
    ).toMatchObject({ triggerTokens: 16_768, effectiveInput: null })
  })
})

describe("slot models", () => {
  test("pinned template models carry the slot id and the native package; unusable slots are disabled", async () => {
    const { definition, registry } = await one({ kind: "oai", label: "a", slug: "aaaa" })
    const template = registry.modelTemplates.tpl_oai_test
    expect(definition.models).toHaveLength(template?.models.length ?? -1)
    for (const model of definition.models) {
      expect<unknown>(model.providerID).toBe("own-oai-aaaa")
      expect(model.package).toBe("@opencode/ai/providers/openai")
      expect(model.cost.length).toBeGreaterThan(0)
    }
    const retired = await one({ kind: "oai", label: "a", slug: "bbbb", retired: true, status: "retired" })
    expect(retired.definition.models.every((model) => !model.enabled)).toBe(true)
    const disabled = await one({ kind: "oai", label: "a", slug: "cccc", status: "disabled" })
    expect(disabled.definition.models.every((model) => !model.enabled)).toBe(true)
  })

  test("DeepSeek models keep their catalog limits without an implicit smaller input cap", async () => {
    const { definition, registry } = await one({ kind: "ds", label: "d", slug: "dddd" })
    const source = registry.modelTemplates.tpl_ds_test?.models ?? []
    for (const [index, model] of definition.models.entries()) {
      expect(model.limit).toEqual(source[index]?.limit)
    }
  })

  test("limit, price, status and release date follow the live catalog at every registration (07 §4.4)", async () => {
    const { registry } = await one({ kind: "ds", label: "d", slug: "ffff" })
    const template = registry.modelTemplates.tpl_ds_test
    const pinned = template?.models[0]
    if (!pinned) throw new Error("no pinned model")
    const live = (limit: { readonly context: number; readonly output: number }) =>
      new Map([
        [
          "deepseek",
          {
            models: new Map([
              [
                String(pinned.id),
                catalogModel("deepseek", pinned.id, {
                  name: "Renamed upstream",
                  limit,
                  cost: [price(3, 9)],
                  status: "beta",
                  time: { released: 42 },
                }),
              ],
            ]),
          },
        ],
      ])
    const registered = (limit: { readonly context: number; readonly output: number }) =>
      Registration.definitions(registry, PROD, {}, live(limit)).definitions[0]?.models.find(
        (model) => model.id === pinned.id,
      )
    expect(registered({ context: 1_000_000, output: 64_000 })?.limit).toEqual({ context: 1_000_000, output: 64_000 })
    const changed = registered({ context: 512_000, output: 64_000 })
    expect(changed).toMatchObject({
      limit: { context: 512_000, output: 64_000 },
      cost: [price(3, 9)],
      status: "beta",
      time: { released: 42 },
      name: pinned.name,
    })
    // The pinned template itself never changes; without a fold the pinned values register.
    expect(registry.modelTemplates.tpl_ds_test).toBe(template)
    expect(Registration.definitions(registry, PROD).definitions[0]?.models[0]?.limit).toEqual(pinned.limit)
  })

  test("limits and prices come from the fold snapshot under each kind's rule (07 §4.4)", async () => {
    const registry = await registryWith([
      { kind: "oai", label: "o", slug: "o111" },
      { kind: "codex", label: "c", slug: "c111" },
      { kind: "siwc", label: "s", slug: "s111" },
    ])
    const ids = ["gpt-5.5", "gpt-5.6-sol"]
    const api = { context: 1_050_000, input: 922_000, output: 128_000 }
    const snapshot = (cost: ReturnType<typeof price>[]) =>
      new Map([
        [
          "openai",
          { models: new Map(ids.map((id) => [id, catalogModel("openai", id, { limit: api, cost })] as const)) },
        ],
      ])
    const registered = (live: Templates.Live) =>
      new Map(
        Registration.definitions(registry, PROD, {}, live).definitions.map((definition) => [
          String(definition.info.id),
          new Map(definition.models.map((model) => [String(model.id), model])),
        ]),
      )
    const pinnedOf = (kind: "oai" | "siwc", id: string) =>
      registry.modelTemplates[`tpl_${kind}_test`]?.models.find((model) => model.id === id)
    const now = registered(snapshot([price(7, 21)]))
    // Pay as you go: the snapshot's window and price.
    expect(now.get("own-oai-o111")?.get("gpt-5.6-sol")).toMatchObject({ limit: api, cost: [price(7, 21)] })
    // Codex: free, the known Codex window over the API one.
    expect(now.get("own-codex-c111")?.get("gpt-5.6-sol")).toMatchObject({
      limit: { context: 1_000_000, input: 872_000, output: 128_000 },
      cost: [],
    })
    // Codex rejects gpt-5.5 and older for ChatGPT accounts (upstream v2.1): never registered on a Codex slot.
    expect(now.get("own-codex-c111")?.has("gpt-5.5")).toBe(false)
    // siwc: free with its pinned plan window, whatever the snapshot says.
    expect(now.get("own-siwc-s111")?.get("gpt-5.6-sol")).toMatchObject({
      limit: pinnedOf("siwc", "gpt-5.6-sol")?.limit,
      cost: [],
    })
    // A snapshot without a price keeps the pinned one: a metered model never registers as $0.
    const unpriced = registered(snapshot([]))
    expect(unpriced.get("own-oai-o111")?.get("gpt-5.6-sol")?.cost).toEqual(pinnedOf("oai", "gpt-5.6-sol")?.cost)
  })

  test("a model gone upstream stays enabled as deprecated; own's template marks never reach core (07 §4.4)", async () => {
    const { registry } = await one({ kind: "oai", label: "a", slug: "gggg" })
    const template = registry.modelTemplates.tpl_oai_test
    if (!template) throw new Error("no template")
    const marked: Registry.ModelTemplate = {
      ...template,
      models: template.models.map((model, index) =>
        index === 0
          ? { ...model, upstream: "missing" as const }
          : index === 1
            ? { ...model, addedAt: "2026-10-02T00:00:00Z" }
            : model,
      ),
    }
    const models = Registration.definitions({ ...registry, modelTemplates: { tpl_oai_test: marked } }, PROD)
      .definitions[0]?.models
    // Sessions on it keep running (U3); `deprecated` keeps every picker, default and preset target off it.
    expect(models?.map((model) => model.enabled).slice(0, 3)).toEqual([true, true, true])
    expect(models?.[0]?.status).toBe("deprecated")
    for (const model of models ?? []) {
      expect(model).not.toHaveProperty("addedAt")
      expect(model).not.toHaveProperty("upstream")
    }
    // Own's readers (presets, accounts.list) see the marks; a gone model is neither callable nor a new-session pick.
    const [gone, added] = marked.models
    if (!gone || !added) throw new Error("too few models")
    const current = Registration.current("oai", gone, new Map())
    expect(current).toMatchObject({ upstream: "missing", enabled: true, status: "deprecated" })
    expect(Preset.callable(current)).toBe(false)
    expect(Preset.candidates([current]).map((model) => model.id)).toEqual([])
    expect(Registration.current("oai", added, new Map())).toMatchObject({
      addedAt: "2026-10-02T00:00:00Z",
      enabled: true,
    })
  })

  test("a slot whose account or template is missing is reported, not registered", async () => {
    const registry = await registryWith([{ kind: "oai", label: "a", slug: "eeee" }])
    const broken: Registry.File = { ...registry, modelTemplates: {} }
    expect(Registration.definitions(broken, PROD)).toEqual({
      definitions: [],
      problems: [{ providerID: "own-oai-eeee", reason: "template_missing" }],
    })
  })
})

describe("the provider fold", () => {
  test("hideBuiltinProviders: auto hides the catalog providers of the kinds in use, never anthropic", async () => {
    const registry = await registryWith([
      { kind: "codex", label: "c", slug: "c111" },
      { kind: "ds", label: "d", slug: "d111" },
      { kind: "anth", label: "a", slug: "a111" },
    ])
    expect(Registration.hiddenBuiltins(registry, "auto")).toEqual(["deepseek", "openai"])
    const sharing = await registryWith([{ kind: "siwc", label: "s", slug: "s111" }])
    expect(Registration.hiddenBuiltins(sharing, "auto")).toEqual(["openai"])
    expect(
      Registration.hiddenBuiltins(
        registry,
        ["xai", "anthropic", "own-oai-q9x1"].map((id) => Provider.ID.make(id)),
      ),
    ).toEqual(["xai"])
    expect(Registration.hiddenBuiltins(registry, false)).toEqual([])
  })

  test("adds own slots, disables hidden built-ins and anthropic unless the Claude slot is enabled", async () => {
    const registry = await registryWith([{ kind: "oai", label: "a", slug: "ffff" }])
    const built = Registration.definitions(registry, PROD)
    const seed = {
      openai: { info: { activation: "auto" as const }, models: [catalogModel("openai", "gpt-a")] },
      anthropic: { info: { activation: "auto" as const }, models: [catalogModel("anthropic", "claude-a")] },
      xai: { info: { activation: "auto" as const } },
    }
    const closed = fakeEditor(seed)
    Registration.apply(closed.editor, {
      definitions: built.definitions,
      hidden: ["openai", "deepseek"],
      claudeSlot: "off",
    })
    expect(closed.records.get("own-oai-ffff")?.provider.activation).toBe("enabled")
    expect(closed.records.get("openai")?.provider.activation).toBe("disabled")
    expect(closed.records.get("anthropic")?.provider.activation).toBe("disabled")
    expect(closed.records.get("xai")?.provider.activation).toBe("auto")
    // A hidden id without a record is not created.
    expect(closed.records.has("deepseek")).toBe(false)

    const open = fakeEditor(seed)
    Registration.apply(open.editor, { definitions: built.definitions, hidden: [], claudeSlot: "plugin" })
    expect(open.records.get("anthropic")?.provider.activation).toBe("auto")
    expect(open.records.get("anthropic")?.models.get("claude-a")?.cost).toEqual([price(1, 4)])
    expect(open.records.get("openai")?.provider.activation).toBe("auto")

    // 04 §8.11.4.3: a remote service whose PC relays the slot enables anthropic with no prices (no connection here,
    // so core resolves Auth.none); other providers are untouched.
    const relayed = fakeEditor(seed)
    Registration.apply(relayed.editor, { definitions: built.definitions, hidden: [], claudeSlot: "remote" })
    expect(relayed.records.get("anthropic")?.provider.activation).toBe("enabled")
    expect(relayed.records.get("anthropic")?.models.get("claude-a")?.cost).toEqual([])
    expect(relayed.records.get("openai")?.models.get("gpt-a")?.cost).toEqual([price(1, 4)])
    // No anthropic in the catalog: nothing is created.
    const none = fakeEditor({ openai: seed.openai })
    Registration.apply(none.editor, { definitions: [], hidden: [], claudeSlot: "remote" })
    expect(none.records.has("anthropic")).toBe(false)
  })
})

describe("served Codex rows register what no catalog lists yet (10 §6.14, 07 §4.4)", () => {
  const row = (slug: string, input: Partial<CodexModels.HarnessRow> = {}): CodexModels.HarnessRow => ({
    slug,
    display_name: slug.toUpperCase(),
    max_context_window: 900_000,
    visibility: "list",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
    truncation_policy: { mode: "tokens", limit: 10_000 },
    model_messages: {},
    ...input,
  })

  test("a row the codex template and catalog lack registers like its nearest pinned model, with the row's facts", async () => {
    const registry = await registryWith([{ kind: "codex", label: "업무", slug: "7k2m", identity: { chatgptAccountId: "acct-1" } }])
    const template = Object.values(registry.modelTemplates).find((item) => item.kind === "codex")!
    const pinned = template.models.map((model) => model.id)
    const rows = [row("gpt-6.9-sol"), row(pinned[0]!), row("gpt-6.9-hidden", { visibility: "hide" })]
    const served = Registration.served("codex", template, new Map(), rows)
    expect(served.map((model) => String(model.id))).toEqual(["gpt-6.9-sol"])
    const model = served[0]!
    const lender = template.models.find((item) => item.id === CodexModels.nearest("gpt-6.9-sol")) ?? template.models[0]!
    expect(model).toMatchObject({ name: "GPT-6.9-SOL", modelID: "gpt-6.9-sol", package: lender.package, family: lender.family })
    expect(model.limit).toEqual({ context: 900_000 + lender.limit.output, input: 900_000, output: lender.limit.output })
    expect(model.variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(model.variants[0]?.settings).toEqual(lender.variants.find((variant) => variant.id === "low")?.settings)
    expect(model.addedAt).toBeUndefined()
    // It registers on the slot, with the slot's package.
    const definition = Registration.definitions(registry, PROD, {}, new Map(), rows).definitions[0]!
    expect(definition.models.map((item) => String(item.id))).toContain("gpt-6.9-sol")
    // Once the catalog lists it, the catalog's entry (the template diff's) is the one: nothing is synthesized.
    const live: Templates.Live = new Map([["openai", { models: new Map([["gpt-6.9-sol", catalogModel("openai", "gpt-6.9-sol")]]) }]])
    expect(Registration.served("codex", template, live, rows)).toEqual([])
    // Other kinds read no Codex list.
    expect(Registration.served("oai", template, new Map(), rows)).toEqual([])
  })
})
