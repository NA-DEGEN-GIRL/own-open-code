import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Compaction, Kind, type CodexModels } from "@own/protocol"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import { Registration } from "../../src/slots/registration.js"
import { Templates } from "../../src/slots/templates.js"
import { catalogModel, price, registryWith } from "./support.js"

const AT = "2026-09-27T03:00:00Z"

describe("Templates.fromCatalog", () => {
  test("codex keeps only ChatGPT-eligible models with their maximum subscription window", () => {
    const openai = [
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "gpt-5.6-luna",
      "gpt-6-sol",
      "o3",
    ].map((id) => catalogModel("openai", id, { settings: { baseURL: "https://elsewhere.test/v1" } }))
    const pro = catalogModel("openai", "gpt-6-sol-pro", {
      modelID: "gpt-6-sol" as never,
      body: { reasoning: { mode: "pro" } },
    })
    // models.dev's flex processing mode (an API-key service tier, upstream v2.4.0) never reaches a ChatGPT template.
    const flex = catalogModel("openai", "gpt-6-sol-flex", {
      modelID: "gpt-6-sol" as never,
      body: { service_tier: "flex" },
    })
    const built = Templates.fromCatalog("codex", [...openai, pro, flex], AT)
    if (!built.ok) throw new Error(built.reason)
    expect(built.template).toMatchObject({
      kind: "codex",
      sourceProvider: "openai",
      source: "snapshot",
      capturedAt: AT,
    })
    // Since upstream v2.1 Codex rejects gpt-5.5 and older for ChatGPT accounts, gpt-5.3-codex-spark included.
    expect(Object.fromEntries(built.template.models.map((model) => [model.id, model.limit]))).toEqual({
      "gpt-5.6-luna": { context: 1_000_000, input: 872_000, output: 32_000 },
      "gpt-6-sol": { context: 1_000_000, input: 872_000, output: 32_000 },
    })
    for (const model of built.template.models) {
      expect(model.cost).toEqual([])
      expect(model.package).toBe("@opencode/ai/providers/openai")
      expect(model).not.toHaveProperty("providerID")
      expect(model).not.toHaveProperty("canonical")
      expect(model.settings?.baseURL).toBeUndefined()
    }
  })

  test("siwc keeps the token-sharing fallback set, plan-billed with summary compaction on every model", () => {
    const openai = ["gpt-5.5", "gpt-5.5-fast", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.4", "gpt-5.5-pro", "o3"].map((id) =>
      catalogModel("openai", id, {
        settings: { baseURL: "https://elsewhere.test/v1", compaction: { type: "native" } },
      }),
    )
    const pro = catalogModel("openai", "gpt-6-astra", { body: { reasoning: { mode: "pro" } } })
    const built = Templates.fromCatalog("siwc", [...openai, pro], AT)
    if (!built.ok) throw new Error(built.reason)
    expect(built.template).toMatchObject({ kind: "siwc", sourceProvider: "openai", source: "snapshot" })
    expect(built.template.models.map((model) => String(model.id))).toEqual([
      "gpt-5.5",
      "gpt-5.5-fast",
      "gpt-5.6-sol",
      "gpt-6-astra",
    ])
    for (const model of built.template.models) {
      expect(model.cost).toEqual([])
      expect(model.settings).toEqual({ compaction: { type: "summary" } })
      expect(model.package).toBe("@opencode/ai/providers/openai")
    }
    expect(built.dropped).toEqual([])
    expect(Templates.fromCatalog("siwc", [catalogModel("openai", "o3")], AT)).toEqual({
      ok: false,
      reason: "no_eligible_models",
    })
  })

  test("known Codex maxima cap the API window and lift old pinned 272k values (07 §6.2 #4)", () => {
    const legacy = { context: 400_000, input: 272_000, output: 128_000 }
    const api = { context: 1_050_000, input: 922_000, output: 128_000 }
    const astra = catalogModel("openai", "gpt-6-astra", { limit: legacy })
    expect(Templates.limit("codex", astra)).toEqual({ context: 1_000_000, input: 872_000, output: 128_000 })
    expect(Templates.limit("codex", { ...astra, limit: api })).toEqual({
      context: 1_000_000,
      input: 872_000,
      output: 128_000,
    })
    expect(Templates.codexLimit(catalogModel("openai", "gpt-5.6-sol-fast"))).toEqual({
      context: 1_000_000,
      input: 872_000,
    })
    expect(Templates.limit("codex", catalogModel("openai", "gpt-5.5-fast", { limit: api }))).toEqual(legacy)
    expect(Templates.codexLimit(catalogModel("openai", "gpt-5.3-codex-spark"))).toEqual({
      context: 128_000,
      input: 100_000,
    })
    expect(Templates.limit("oai", astra)).toBe(legacy)
    expect(Registration.threshold("codex", {}, astra, {})).toMatchObject({
      windowTokens: 872_000,
      triggerTokens: 741_200,
    })
    expect(Registration.threshold("codex", { compaction: { maxTriggerTokens: 200_000 } }, astra, {})).toMatchObject({
      triggerTokens: 200_000,
      source: "account",
    })
  })

  test("a Codex model outside the known list keeps its catalog window, never the 272k guess", () => {
    const api = { context: 1_050_000, input: 922_000, output: 128_000 }
    const sol = catalogModel("openai", "gpt-6.1-sol", { limit: api })
    expect(Templates.codexLimit(sol)).toBeUndefined()
    expect(Templates.limit("codex", sol)).toBe(api)
    const built = Templates.fromCatalog("codex", [sol], AT)
    if (!built.ok) throw new Error(built.reason)
    expect(built.template.models[0]?.limit).toEqual(api)
    expect(Registration.threshold("codex", {}, sol, {})).toMatchObject({
      windowTokens: 922_000,
      triggerTokens: 783_700,
      effectiveInput: null,
    })
  })

  test("metered kinds drop unpriced models and anth refuses a snapshot with any of them", () => {
    const models = [catalogModel("openai", "gpt-a"), catalogModel("openai", "gpt-free", { cost: [] })]
    const oai = Templates.fromCatalog("oai", models, AT)
    if (!oai.ok) throw new Error(oai.reason)
    expect(oai.template.models.map((model) => String(model.id))).toEqual(["gpt-a"])
    expect(oai.dropped).toEqual(["gpt-free"])
    expect(oai.template.models[0]?.cost).toEqual(models[0]?.cost)

    const anthropic = [catalogModel("anthropic", "claude-a"), catalogModel("anthropic", "claude-b", { cost: [] })]
    expect(Templates.fromCatalog("anth", anthropic, AT)).toEqual({ ok: false, reason: "cost_missing" })
    expect(Templates.fromCatalog("ds", [], AT)).toEqual({ ok: false, reason: "catalog_empty" })
  })

  test("each kind writes its native package on every model (DeepSeek explicitly)", () => {
    for (const kind of Templates.CATALOG_KINDS) {
      const source = Templates.SOURCE[kind]
      const built = Templates.fromCatalog(kind, [catalogModel(source, Kind.isOAuth(kind) ? "gpt-5.6-sol" : "m-1")], AT)
      if (!built.ok) throw new Error(`${kind}: ${built.reason}`)
      expect(built.template.models[0]?.package).toBe(Kind.meta[kind].package)
    }
    const ds = Templates.fromCatalog("ds", [catalogModel("deepseek", "deepseek-v4-pro")], AT)
    expect(ds.ok && ds.template.models[0]?.package).toBe("@opencode/ai/providers/deepseek")
  })
})

describe("Templates.live (07 §4.4)", () => {
  const snapshot = (providerID: string, models: ReadonlyArray<Model.Info>): Templates.Live =>
    new Map([[providerID, { models: new Map(models.map((model) => [String(model.id), model])) }]])
  const pinned = (kind: Templates.CatalogKind, models: ReadonlyArray<Model.Info>) => {
    const built = Templates.fromCatalog(kind, models, AT)
    if (!built.ok) throw new Error(built.reason)
    return built.template.models
  }

  test("limit, price, status and release date come from the live catalog; prefix fields stay pinned", () => {
    const [model] = pinned("oai", [
      catalogModel("openai", "gpt-a", { status: "beta", time: { released: 1 }, cost: [price(1, 4)] }),
    ])
    if (!model) throw new Error("no model")
    const live = catalogModel("openai", "gpt-a", {
      name: "Renamed upstream",
      family: Model.Family.make("gpt-z"),
      variants: [{ id: Model.VariantID.make("high") }],
      limit: { context: 400_000, output: 64_000 },
      cost: [price(2, 8)],
      status: "active",
      time: { released: 2 },
    })
    const current = Templates.live("oai", model, snapshot("openai", [live]))
    expect(current).toEqual({
      ...model,
      limit: { context: 400_000, output: 64_000 },
      cost: [price(2, 8)],
      status: "active",
      time: { released: 2 },
    })
    expect(current).toMatchObject({ name: model.name, family: model.family, variants: [], package: model.package })
    // A live entry without a price keeps the pinned one; a model the catalog lacks keeps every pinned value.
    expect(Templates.live("oai", model, snapshot("openai", [{ ...live, cost: [] }])).cost).toEqual([price(1, 4)])
    expect(Templates.live("oai", model, new Map())).toEqual(model)
  })

  test("Codex: out-of-list models take the live window, known ones the Codex maximum, and stay free", () => {
    const legacy = { context: 400_000, input: 272_000, output: 128_000 }
    const api = { context: 1_050_000, input: 922_000, output: 128_000 }
    const models = pinned("codex", [
      catalogModel("openai", "gpt-6.1-sol", { limit: legacy }),
      catalogModel("openai", "gpt-6-astra", { limit: legacy }),
    ])
    const live = snapshot("openai", [
      catalogModel("openai", "gpt-6.1-sol", { limit: api, cost: [price(2, 8)] }),
      catalogModel("openai", "gpt-6-astra", { limit: api }),
    ])
    const current = models.map((model) => Templates.live("codex", model, live))
    expect(Object.fromEntries(current.map((model) => [model.id, model.limit]))).toEqual({
      "gpt-6.1-sol": api,
      "gpt-6-astra": { context: 1_000_000, input: 872_000, output: 128_000 },
    })
    expect(current.map((model) => model.cost)).toEqual([[], []])
    // Without a live entry the pinned 272k stays for an unknown id; a known id is still lifted to 872k.
    expect(models.map((model) => Templates.live("codex", model, new Map()).limit.input)).toEqual([272_000, 872_000])
  })

  test("compat models are the user's: no catalog overrides them", () => {
    const built = Templates.fromCompat([{ id: "gpt-a", contextLimit: 128_000 }], AT)
    if (!built.ok) throw new Error(built.reason)
    const [model] = built.template.models
    if (!model) throw new Error("no model")
    const live = snapshot("openai", [catalogModel("openai", "gpt-a", { limit: { context: 1, output: 1 } })])
    expect(Templates.live("compat", model, live)).toEqual(model)
  })
})

describe("Codex windows from the metadata snapshot (07 §4.5, §6.2 #4, PG6)", () => {
  const api = { context: 1_050_000, input: 922_000, output: 128_000 }
  /** A backend snapshot with the rows of 07 Appendix A that the window rule reads. */
  const meta = (models: ReadonlyArray<CodexModels.Model>): CodexModels.Snapshot => ({
    source: "backend",
    fetchedAt: 1,
    clientVersion: "0.157.0",
    models,
  })
  const META = meta([
    { slug: "gpt-6.1-sol", context_window: 272_000, max_context_window: 872_000 },
    { slug: "gpt-6-sol", context_window: 272_000, max_context_window: 872_000 },
    { slug: "gpt-5.5", context_window: 272_000, max_context_window: 272_000 },
  ])
  const trigger = (model: Model.Info, snapshot?: CodexModels.Snapshot) =>
    Compaction.resolve(
      Compaction.chain({ kind: "codex", modelID: model.id }),
      Templates.limit("codex", model, snapshot),
    )?.triggerTokens

  test("metadata 872k for gpt-6.1-sol registers 741,200; without it the live catalog 922k registers 783,700", () => {
    const sol = catalogModel("openai", "gpt-6.1-sol", { limit: api })
    expect(Templates.codexLimit(sol, META)).toEqual({ context: 1_000_000, input: 872_000 })
    expect(Templates.limit("codex", sol, META)).toEqual({ context: 1_000_000, input: 872_000, output: 128_000 })
    expect(trigger(sol, META)).toBe(741_200)
    // No metadata, outside the stand-in list: the catalog window, never a shorter guess, and `codex_window_unverified`.
    expect(Templates.codexLimit(sol, undefined)).toBeUndefined()
    expect(trigger(sol, undefined)).toBe(783_700)
    // A `-fast` twin reads its base model's row.
    expect(Templates.codexLimit(catalogModel("openai", "gpt-6.1-sol-fast", { limit: api }), META)?.input).toBe(872_000)
  })

  test("R8: a row with only context_window (Codex's 272k default) never shortens a window", () => {
    // Another client_version's answer or an older models_cache.json may lack max_context_window.
    const defaults = meta(
      ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-terra"].map((slug) => ({ slug, context_window: 272_000 })),
    )
    // Outside the stand-in list: the live catalog window (922k → core compaction 783,700) and `codex_window_unverified`.
    const sol = catalogModel("openai", "gpt-6.1-sol", { limit: api })
    expect(Templates.codexLimit(sol, defaults)).toBeUndefined()
    expect(trigger(sol, defaults)).toBe(783_700)
    // In the stand-in list: still 872k (core compaction 741,200), not 272k.
    for (const id of ["gpt-6-sol", "gpt-5.6-terra"]) {
      const model = catalogModel("openai", id, { limit: api })
      expect(Templates.codexLimit(model, defaults)).toEqual({ context: 1_000_000, input: 872_000 })
      expect(trigger(model, defaults)).toBe(741_200)
    }
  })

  test("listed models keep their windows until T2.21; a metadata row is the source when it has one", () => {
    const listed = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]
    for (const id of listed) {
      const model = catalogModel("openai", id, { limit: api })
      expect(Templates.limit("codex", model, undefined)).toEqual({
        context: 1_000_000,
        input: 872_000,
        output: 128_000,
      })
      expect(trigger(model, undefined)).toBe(741_200)
    }
    // With the metadata the same values come from the row; GPT-5.5 stays at 272k either way.
    const sol = catalogModel("openai", "gpt-6-sol", { limit: api })
    expect(Templates.limit("codex", sol, META)).toEqual(Templates.limit("codex", sol, undefined))
    const legacy = { context: 400_000, input: 272_000, output: 128_000 }
    const old = catalogModel("openai", "gpt-5.5", { limit: api })
    expect(Templates.limit("codex", old, META)).toEqual(legacy)
    expect(Templates.limit("codex", old, undefined)).toEqual(legacy)
    // The row wins over the list (the list only stands in for a missing row).
    expect(Templates.codexLimit(sol, meta([{ slug: "gpt-6-sol", max_context_window: 500_000 }]))?.input).toBe(500_000)
  })

  test("codex only: siwc and API keys take the live catalog window (siwc stays plan-billed)", () => {
    const pinnedSiwc = Templates.fromCatalog("siwc", [catalogModel("openai", "gpt-6-astra")], AT)
    if (!pinnedSiwc.ok) throw new Error(pinnedSiwc.reason)
    const [pinned] = pinnedSiwc.template.models
    if (!pinned) throw new Error("no model")
    // A template an older build lowered to its account catalog's window (R8: upstream 209346a0fe reads no such window).
    const model = { ...pinned, limit: { context: 272_000, input: 272_000, output: 128_000 } }
    const live: Templates.Live = new Map([
      ["openai", { models: new Map([["gpt-6-astra", catalogModel("openai", "gpt-6-astra", { limit: api })]]) }],
    ])
    const astra = meta([{ slug: "gpt-6-astra", max_context_window: 500_000 }])
    expect(Templates.live("siwc", model, live, astra)).toMatchObject({ limit: api, cost: [] })
    // Without a live entry the pinned window stays.
    expect(Templates.live("siwc", model, new Map(), astra).limit).toEqual(model.limit)
    expect(Templates.limit("siwc", { ...model, limit: api }, astra)).toEqual(api)
    expect(Templates.limit("oai", { ...model, limit: api }, astra)).toEqual(api)
    expect(Templates.live("codex", { ...model, cost: [] }, live, astra).limit).toEqual({
      context: 628_000,
      input: 500_000,
      output: 128_000,
    })
  })

  test("a model with a metadata row is no longer unverified", async () => {
    const registry = await registryWith([{ kind: "codex", label: "P", slug: "pppp" }])
    const built = Templates.fromCatalog("codex", [catalogModel("openai", "gpt-6.1-sol")], AT)
    if (!built.ok) throw new Error(built.reason)
    const withNew = { ...registry, modelTemplates: { ...registry.modelTemplates, tpl_codex_test: built.template } }
    expect(Templates.unverifiedCodex(withNew, undefined)).toEqual(["gpt-6.1-sol"])
    expect(Templates.unverifiedCodex(withNew, META)).toEqual([])
  })
})

describe("Templates.unverifiedCodex", () => {
  test("lists enabled models of live Codex slots that have no known Codex window", async () => {
    const registry = await registryWith([
      { kind: "codex", label: "P", slug: "pppp" },
      { kind: "oai", label: "K", slug: "kkkk" },
    ])
    // The bundled template's GPT-6.1 Sol and Terra models (and their speed modes) take their window from the Codex
    // metadata only (listed from Codex 0.164.0 on); without a snapshot they register with the catalog window. Codex
    // lists no GPT-5.6 Cyber at all.
    expect(Templates.unverifiedCodex(registry, undefined)).toEqual([
      "gpt-5.6-cyber",
      "gpt-6.1-sol",
      "gpt-6.1-sol-fast",
      "gpt-6.1-sol-ultrafast",
      "gpt-6.1-terra",
      "gpt-6.1-terra-fast",
    ])
    const listed: CodexModels.Snapshot = {
      source: "backend",
      fetchedAt: 1,
      clientVersion: CodexMeta.BACKEND.clientVersion,
      models: [
        { slug: "gpt-6.1-sol", context_window: 272_000, max_context_window: 872_000 },
        { slug: "gpt-6.1-terra", context_window: 500_000, max_context_window: 872_000 },
      ],
    }
    expect(Templates.unverifiedCodex(registry, listed)).toEqual(["gpt-5.6-cyber"])
    const built = Templates.fromCatalog(
      "codex",
      ["gpt-6.1-sol", "gpt-6-astra", "gpt-7-nova", "gpt-5.5"].map((id) => catalogModel("openai", id)),
      AT,
    )
    if (!built.ok) throw new Error(built.reason)
    const template = {
      ...built.template,
      models: built.template.models.map((model) => (model.id === "gpt-7-nova" ? { ...model, enabled: false } : model)),
    }
    const withNew = { ...registry, modelTemplates: { ...registry.modelTemplates, tpl_codex_test: template } }
    expect(Templates.unverifiedCodex(withNew)).toEqual(["gpt-6.1-sol"])
    const retired = Object.fromEntries(
      Object.entries(withNew.slots).map(([id, slot]) => [
        id,
        slot.kind === "codex" ? { ...slot, retired: true } : slot,
      ]),
    )
    expect(Templates.unverifiedCodex({ ...withNew, slots: retired })).toEqual([])
  })
})

describe("Templates.fromCompat", () => {
  test("builds one template from the user's models and requires the context window", () => {
    const built = Templates.fromCompat(
      [{ id: "qwen3-coder", contextLimit: 128_000, cost: { input: 1, output: 2, cacheRead: 0.1 } }],
      AT,
    )
    if (!built.ok) throw new Error(built.reason)
    expect(built.template).toMatchObject({ kind: "compat", source: "user" })
    expect(built.template.models[0]).toMatchObject({
      id: "qwen3-coder",
      modelID: "qwen3-coder",
      package: "@opencode/ai/providers/openai-compatible",
      limit: { context: 128_000, output: 32_000 },
      cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }],
    })
    expect(Templates.fromCompat([{ id: "x" }], AT)).toEqual({ ok: false, reason: "compat_context_required:x" })
    expect(Templates.fromCompat([], AT).ok).toBe(false)
  })

  test("image input and tools follow the user's settings, else the server's report, else text in with tools (02 §3.3)", () => {
    const built = Templates.fromCompat(
      [
        { id: "plain", contextLimit: 32_768 },
        { id: "vision", contextLimit: 32_768, image: "on" },
        { id: "chat", contextLimit: 32_768, image: "auto", tools: "off" },
      ],
      AT,
    )
    if (!built.ok) throw new Error(built.reason)
    expect(built.template.models.map((model) => model.capabilities)).toEqual([
      { tools: true, input: ["text"], output: ["text"] },
      { tools: true, input: ["text", "image"], output: ["text"] },
      { tools: false, input: ["text"], output: ["text"] },
    ])
    const of = Templates.compatCapabilities
    expect(of(undefined)).toEqual({ tools: true, input: ["text"], output: ["text"] })
    expect(of({ detected: { image: true, tools: false } })).toEqual({
      tools: false,
      input: ["text", "image"],
      output: ["text"],
    })
    expect(of({ detected: { image: true, tools: false }, image: "off", tools: "on" })).toEqual({
      tools: true,
      input: ["text"],
      output: ["text"],
    })
    // A server that said nothing about tools keeps them on; only a reported `false` turns them off.
    expect(of({ detected: {} }).tools).toBe(true)
    const stored = { detected: { image: false }, image: "on" as const }
    expect(Templates.compatSettings(stored, {})).toEqual(stored)
    expect(Templates.compatSettings(stored, { image: "auto", tools: "off" })).toEqual({
      detected: { image: false },
      tools: "off",
    })
    expect(Templates.compatSettings(undefined, { image: "auto", tools: "auto" })).toEqual({})
  })
})

describe("bundled templates", () => {
  test("every catalog kind has a valid bundled template that follows the kind rules", async () => {
    for (const kind of Templates.CATALOG_KINDS) {
      const template = await Templates.bundled(kind)
      expect(template?.kind).toBe(kind)
      expect(template?.source).toBe("bundled")
      expect(template?.models.length).toBeGreaterThan(0)
      for (const model of template?.models ?? []) expect(model.package).toBe(Kind.meta[kind].package)
      if (Templates.METERED.has(kind))
        for (const model of template?.models ?? []) expect(model.cost.length).toBeGreaterThan(0)
    }
    const codex = await Templates.bundled("codex")
    expect(codex?.models.every((model) => Templates.codexAllowed(model) && model.cost.length === 0)).toBe(true)
    expect(codex?.models.map((model) => String(model.id))).toContain("gpt-5.6-sol")
    // The bundled catalog holds the whole token-sharing fallback set.
    const siwc = await Templates.bundled("siwc")
    expect(new Set(siwc?.models.map((model) => String(model.id)))).toEqual(new Set(Templates.SHARING_MODELS))
    expect(
      siwc?.models.every((model) => model.cost.length === 0 && model.settings?.compaction?.type === "summary"),
    ).toBe(true)
  })
})

describe("Templates ids and defaults", () => {
  test("a template id is never reused", () => {
    const now = Date.UTC(2026, 8, 27)
    expect<unknown>(Templates.newID("codex", now, {})).toBe("tpl_codex_20260927")
    expect<unknown>(Templates.newID("codex", now, { tpl_codex_20260927: {} })).toBe("tpl_codex_20260927_2")
    expect<unknown>(Templates.newID("codex", now, { tpl_codex_20260927: {}, tpl_codex_20260927_2: {} })).toBe(
      "tpl_codex_20260927_3",
    )
  })
})

describe("slot compaction windows (02 §4.7.3–4.7.4)", () => {
  const threshold = (
    kind: Parameters<typeof Registration.threshold>[0],
    limit: { readonly context: number; readonly input?: number; readonly output: number },
    account: { readonly compaction?: Compaction.Setting | null } = {},
    compaction: Registration.CompactionInput = {},
  ) => Registration.threshold(kind, account, { id: Model.ID.make("m"), modelID: Model.ID.make("m"), limit }, compaction)

  test("every kind keeps its maximum model window, custom (compat) providers included", () => {
    const pro = { context: 1_000_000, output: 64_000 }
    expect(threshold("ds", pro)).toMatchObject({ effectiveInput: null, triggerTokens: 850_000 })
    expect(threshold("codex", { context: 400_000, input: 272_000, output: 128_000 })?.effectiveInput).toBeNull()
    expect(threshold("anth", pro)?.effectiveInput).toBeNull()
    expect(threshold("oai", pro)?.effectiveInput).toBeNull()
    expect(threshold("xai", { context: 500_000, output: 30_000 })?.triggerTokens).toBe(425_000)
    expect(threshold("or", { context: 163_840, output: 8_000 })?.triggerTokens).toBe(139_264)
    // Core keeps 15% free (upstream v2.1), and 16k below a 106,667 window (upstream d9987ef9c8). A compat model, often
    // a small local window, stays at 90% through a registered input above its window at every size (R8, US-1).
    expect(threshold("or", { context: 128_000, output: 8_000 })).toMatchObject({
      effectiveInput: null,
      triggerTokens: 108_800,
    })
    expect(threshold("compat", { context: 128_000, output: 8_000 })).toMatchObject({
      effectiveInput: 135_529,
      triggerTokens: 115_200,
    })
    expect(threshold("compat", { context: 50_000, output: 8_000 })).toMatchObject({
      effectiveInput: 61_000,
      triggerTokens: 45_000,
    })
    expect(threshold("compat", { context: 200_000, output: 8_000 })).toMatchObject({
      effectiveInput: 211_764,
      triggerTokens: 180_000,
    })
    expect(threshold("compat", { context: 0, output: 8_000 })).toBeUndefined()
  })

  test("account, account×model and policy settings move the registered window (02 §4.7.4)", () => {
    const pro = { context: 1_000_000, output: 64_000 }
    const codex = { context: 400_000, input: 272_000, output: 128_000 }
    // An account cap on a v2 kind lowers codex from 231.2k to 200k.
    const capped = threshold("codex", codex, { compaction: { maxTriggerTokens: 200_000 } })
    expect(capped).toMatchObject({ triggerTokens: 200_000, source: "account" })
    expect(Compaction.ceiling(capped?.effectiveInput ?? 0)).toBe(200_000)
    // Account × model wins over the account.
    const model = threshold("codex", codex, {
      compaction: { maxTriggerTokens: 200_000, models: { m: { maxTriggerTokens: 150_000 } } },
    })
    expect(model).toMatchObject({ triggerTokens: 150_000, source: "accountModel" })
    // The policy changes the kind default; the account still wins.
    const policy = { ds: { triggerPercent: 30 } }
    expect(threshold("ds", pro, {}, { policy })).toMatchObject({ triggerTokens: 300_000, source: "kind" })
    expect(threshold("ds", pro, {}, { policy: { ds: { maxTriggerTokens: 100_000 } } })).toMatchObject({
      triggerTokens: 100_000,
    })
    expect(threshold("ds", pro, { compaction: Compaction.V2 }, { policy })).toMatchObject({
      triggerTokens: 850_000,
      effectiveInput: null,
    })
    // A larger keep (own global config) raises the floor.
    expect(
      threshold(
        "ds",
        { context: 120_000, output: 8_000 },
        {},
        { keep: 30_000, policy: { ds: { triggerPercent: 60 } } },
      ),
    ).toMatchObject({
      triggerTokens: 78_000,
      floorTokens: 78_000,
    })
  })
})
