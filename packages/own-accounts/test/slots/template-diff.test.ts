import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import type { Registry } from "@own/protocol"
import { TemplateDiff } from "../../src/slots/template-diff.js"
import { Templates } from "../../src/slots/templates.js"
import { catalogModel, price, registryWith } from "./support.js"

const CAPTURED = "2026-09-28T00:00:00Z"
const AT = "2026-10-02T09:00:00Z"
const LATER = "2026-10-03T09:00:00Z"

/** The fold's catalog of one provider. */
function live(providerID: string, models: ReadonlyArray<Model.Info>): Templates.Live {
  return new Map([[providerID, { models: new Map(models.map((model) => [String(model.id), model])) }]])
}

function pinned(kind: Templates.CatalogKind, models: ReadonlyArray<Model.Info>): Registry.ModelTemplate {
  const built = Templates.fromCatalog(kind, models, CAPTURED)
  if (!built.ok) throw new Error(built.reason)
  return built.template
}

function diffOf(kind: Templates.CatalogKind, template: Registry.ModelTemplate, catalog: Templates.Live) {
  const found = TemplateDiff.diff(kind, template, catalog)
  if (!found) throw new Error("no diff")
  return found
}

const ids = (models: ReadonlyArray<{ readonly id: string }>) => models.map((model) => String(model.id))

describe("TemplateDiff.diff (07 §4.4)", () => {
  test("added, removed, live and fixed changes, each sorted by model id", () => {
    const template = pinned("oai", [
      catalogModel("openai", "gpt-c"),
      catalogModel("openai", "gpt-b"),
      catalogModel("openai", "gpt-a"),
    ])
    const catalog = live("openai", [
      catalogModel("openai", "gpt-z"),
      // A display name, a reasoning level list and a capability are fixed fields; a window is live.
      catalogModel("openai", "gpt-b", {
        name: "GPT B renamed",
        variants: [{ id: Model.VariantID.make("high") }],
        limit: { context: 400_000, output: 64_000 },
      }),
      catalogModel("openai", "gpt-a", { status: "beta", cost: [price(2, 8)], time: { released: 1_800_000_000_000 } }),
      catalogModel("openai", "gpt-d"),
    ])
    const found = diffOf("oai", template, catalog)
    expect(ids(found.added)).toEqual(["gpt-d", "gpt-z"])
    expect(found.removed).toEqual([Model.ID.make("gpt-c")])
    expect(found.returned).toEqual([])
    expect(found.live).toEqual([
      { id: Model.ID.make("gpt-a"), fields: ["cost", "released", "status"] },
      { id: Model.ID.make("gpt-b"), fields: ["limit"] },
    ])
    expect(found.fixed).toEqual([{ id: Model.ID.make("gpt-b"), fields: ["name", "variants"] }])
    // Added models are entries of the kind's template: no provider id, the kind's package, priced.
    expect(found.added[0]).not.toHaveProperty("providerID")
    expect(found.added[0]?.package).toBe("@opencode/ai/providers/openai")
    expect(found.added[0]?.cost).toEqual([price(1, 4)])
  })

  test("the same catalog gives an empty diff; no catalog gives none, so nothing is marked missing", () => {
    const models = [catalogModel("openai", "gpt-a"), catalogModel("openai", "gpt-b")]
    const template = pinned("oai", models)
    expect(diffOf("oai", template, live("openai", models))).toEqual({
      added: [],
      removed: [],
      returned: [],
      live: [],
      fixed: [],
    })
    expect(TemplateDiff.diff("oai", template, new Map())).toBeUndefined()
    expect(TemplateDiff.diff("oai", template, live("openai", []))).toBeUndefined()
    expect(TemplateDiff.diff("oai", template, live("anthropic", models))).toBeUndefined()
  })

  test("a catalog that only adds capabilities.temperature (upstream v2.0.32) flags no fixed change", () => {
    const base = catalogModel("openai", "gpt-a")
    const template = pinned("oai", [base])
    const withTemperature = { ...base, capabilities: { ...base.capabilities, temperature: false } }
    expect(diffOf("oai", template, live("openai", [withTemperature])).fixed).toEqual([])
    // A template that records it compares it like any capability.
    const recorded = pinned("oai", [withTemperature])
    const flipped = { ...base, capabilities: { ...base.capabilities, temperature: true } }
    expect(diffOf("oai", recorded, live("openai", [flipped])).fixed).toEqual([
      { id: Model.ID.make("gpt-a"), fields: ["capabilities"] },
    ])
  })

  test("a changed model id is a removal plus an addition: nothing moves to the new id", () => {
    const released = { released: 1_790_000_000_000 }
    const template = pinned("ds", [catalogModel("deepseek", "deepseek-v4-pro", { time: released })])
    const catalog = live("deepseek", [catalogModel("deepseek", "deepseek-v4-max", { time: released })])
    const found = diffOf("ds", template, catalog)
    expect(found.removed).toEqual([Model.ID.make("deepseek-v4-pro")])
    expect(ids(found.added)).toEqual(["deepseek-v4-max"])
    const next = TemplateDiff.apply(template, found, AT)
    expect(next?.models.map((model) => [String(model.id), model.upstream ?? null, model.addedAt ?? null])).toEqual([
      ["deepseek-v4-pro", "missing", null],
      ["deepseek-v4-max", null, AT],
    ])
  })

  test("a model marked missing that the catalog lists again comes back", () => {
    const models = [catalogModel("openai", "gpt-a"), catalogModel("openai", "gpt-b")]
    const base = pinned("oai", models)
    const template = { ...base, models: base.models.map((model) => ({ ...model, upstream: "missing" as const })) }
    const found = diffOf("oai", template, live("openai", models.slice(0, 1)))
    // A marked model the catalog still lacks is not removed again.
    expect(found.removed).toEqual([])
    expect(found.returned).toEqual([Model.ID.make("gpt-a")])
    const next = TemplateDiff.apply(template, found, AT)
    expect(next?.models.map((model) => model.upstream ?? null)).toEqual([null, "missing"])
    expect(next?.models[0]).not.toHaveProperty("upstream")
  })

  test("a pinned model without text output is not gone when core's catalog drops it (upstream 944959566f)", () => {
    const base = pinned("oai", [catalogModel("openai", "gpt-a")])
    const [text] = base.models
    if (!text) throw new Error("no model")
    const image = { ...text, id: Model.ID.make("gpt-image-2"), capabilities: { ...text.capabilities, output: ["image"] } }
    const template = { ...base, models: [text, image] }
    // The catalog no longer lists the image model; a new non-text catalog model is not added either.
    const catalog = live("openai", [
      catalogModel("openai", "gpt-a"),
      catalogModel("openai", "grok-video", { capabilities: { tools: false, input: ["text"], output: ["video"] } }),
    ])
    const found = diffOf("oai", template, catalog)
    expect(found.removed).toEqual([])
    expect(found.added).toEqual([])
    expect(TemplateDiff.apply(template, found, AT)).toBeUndefined()
  })

  test("Codex: only models a ChatGPT token may call are added, free; a price change is no live change", () => {
    const api = { context: 1_050_000, input: 922_000, output: 32_000 }
    const template = pinned("codex", [catalogModel("openai", "gpt-6-sol"), catalogModel("openai", "gpt-6.1-sol")])
    const catalog = live("openai", [
      catalogModel("openai", "gpt-6-sol", { limit: api, cost: [price(9, 9)] }),
      catalogModel("openai", "gpt-6.1-sol", { limit: api }),
      catalogModel("openai", "gpt-6.2-sol", { limit: api }),
      catalogModel("openai", "gpt-5.4"),
      catalogModel("openai", "gpt-5.5-pro"),
    ])
    const found = diffOf("codex", template, catalog)
    expect(ids(found.added)).toEqual(["gpt-6.2-sol"])
    expect(found.added[0]).toMatchObject({ cost: [], limit: api })
    // gpt-6-sol keeps its known Codex window and stays free whatever the catalog says; a model outside the known
    // windows registers with the catalog's.
    expect(found.live).toEqual([{ id: Model.ID.make("gpt-6.1-sol"), fields: ["limit"] }])
    expect(found.fixed).toEqual([])
  })

  test("siwc: the token-sharing set like every kind; the live limit counts, the cost never (02 §3.2c)", async () => {
    const bundled = await Templates.bundled("siwc")
    if (!bundled) throw new Error("no bundled siwc template")
    const listed = bundled.models.filter((model) => model.id !== "gpt-5.5-fast")
    const catalog = live("openai", [
      ...listed.map((model) =>
        catalogModel("openai", model.id, {
          ...model,
          limit: { context: 2_000_000, input: 1_900_000, output: 128_000 },
          cost: [price(5, 5)],
        }),
      ),
      catalogModel("openai", "gpt-6.2-sol"),
    ])
    const found = diffOf("siwc", bundled, catalog)
    // gpt-6.2-sol is not in the sharing set; the vanished sharing model is marked.
    expect(found.added).toEqual([])
    expect(found.removed).toEqual([Model.ID.make("gpt-5.5-fast")])
    // The live window registers like every kind's (upstream 209346a0fe, R8); plan billing keeps the cost pinned.
    expect(found.live.map((change) => String(change.id)).toSorted()).toEqual(
      listed.map((model) => String(model.id)).toSorted(),
    )
    expect(found.live.every((change) => change.fields.join() === "limit")).toBe(true)
    expect(found.fixed).toEqual([])
  })

  test("an anthropic catalog with an unpriced model adds nothing and flags nothing, but still marks removals", () => {
    const template = pinned("anth", [catalogModel("anthropic", "claude-a"), catalogModel("anthropic", "claude-b")])
    const catalog = live("anthropic", [
      catalogModel("anthropic", "claude-a", { name: "Claude A2" }),
      catalogModel("anthropic", "claude-new", { cost: [] }),
    ])
    const found = diffOf("anth", template, catalog)
    expect(found.added).toEqual([])
    expect(found.fixed).toEqual([])
    expect(found.removed).toEqual([Model.ID.make("claude-b")])
  })
})

describe("TemplateDiff.apply", () => {
  test("appends added models with addedAt and keeps every other model byte-identical", () => {
    const template = pinned("oai", [catalogModel("openai", "gpt-b"), catalogModel("openai", "gpt-a")])
    const catalog = live("openai", [
      catalogModel("openai", "gpt-b"),
      catalogModel("openai", "gpt-a", { limit: { context: 1, output: 1 } }),
      catalogModel("openai", "gpt-c"),
    ])
    const next = TemplateDiff.apply(template, diffOf("oai", template, catalog), AT)
    if (!next) throw new Error("no change")
    expect<unknown>(next.models.slice(0, 2)).toEqual(template.models)
    expect(next.models[0]).toBe(template.models[0])
    expect(next.models[1]).toBe(template.models[1])
    expect(next.models[2]).toMatchObject({ id: "gpt-c", addedAt: AT })
    expect(next).not.toHaveProperty("update")
    expect({ ...next, models: [] }).toEqual({ ...template, models: [] })
    // Applying the same catalog again changes nothing.
    expect(TemplateDiff.apply(next, diffOf("oai", next, catalog), LATER)).toBeUndefined()
  })

  test("live-only changes leave the template alone", () => {
    const template = pinned("oai", [catalogModel("openai", "gpt-a")])
    const catalog = live("openai", [
      catalogModel("openai", "gpt-a", { limit: { context: 9, output: 9 }, cost: [price(7, 7)], status: "beta" }),
    ])
    const found = diffOf("oai", template, catalog)
    expect(found.live).toHaveLength(1)
    expect(TemplateDiff.apply(template, found, AT)).toBeUndefined()
  })

  test("fixed-field changes set update once per change and clear it when none is left", () => {
    const template = pinned("oai", [catalogModel("openai", "gpt-a"), catalogModel("openai", "gpt-b")])
    const renamed = live("openai", [
      catalogModel("openai", "gpt-a", { name: "GPT A2" }),
      catalogModel("openai", "gpt-b", { family: Model.Family.make("gpt-z") }),
    ])
    const flagged = TemplateDiff.apply(template, diffOf("oai", template, renamed), AT)
    expect(flagged?.update).toEqual({ detectedAt: AT, fields: ["family", "name"] })
    expect(flagged?.models).toEqual(template.models)
    if (!flagged) throw new Error("no update")
    // The same change later: nothing to write.
    expect(TemplateDiff.apply(flagged, diffOf("oai", flagged, renamed), LATER)).toBeUndefined()
    // Another field changes too: a new detection time.
    const more = live("openai", [
      catalogModel("openai", "gpt-a", {
        name: "GPT A2",
        capabilities: { ...catalogModel("openai", "x").capabilities, tools: false },
      }),
      catalogModel("openai", "gpt-b", { family: Model.Family.make("gpt-z") }),
    ])
    expect(TemplateDiff.apply(flagged, diffOf("oai", flagged, more), LATER)?.update).toEqual({
      detectedAt: LATER,
      fields: ["capabilities", "family", "name"],
    })
    // The catalog went back: the flag goes.
    const back = live("openai", [catalogModel("openai", "gpt-a"), catalogModel("openai", "gpt-b")])
    const cleared = TemplateDiff.apply(flagged, diffOf("oai", flagged, back), LATER)
    expect(cleared).toEqual(template)
  })
})

describe("TemplateDiff.reconcile", () => {
  test("diffs the catalog templates live slots use; reports new adds, marks and updates", async () => {
    const base = await registryWith([
      { kind: "oai", label: "A", slug: "aaaa" },
      { kind: "ds", label: "D", slug: "dddd", retired: true },
    ])
    const oai = pinned("oai", [catalogModel("openai", "gpt-a"), catalogModel("openai", "gpt-b")])
    const ds = pinned("ds", [catalogModel("deepseek", "deepseek-a")])
    const registry = { ...base, modelTemplates: { tpl_oai_test: oai, tpl_ds_test: ds } }
    const catalog: Templates.Live = new Map([
      ...live("openai", [catalogModel("openai", "gpt-a", { name: "GPT A2" }), catalogModel("openai", "gpt-c")]),
      ...live("deepseek", [catalogModel("deepseek", "deepseek-b")]),
    ])
    const reconciled = TemplateDiff.reconcile(registry, catalog, AT)
    expect(reconciled?.applied).toEqual([
      { templateID: "tpl_oai_test", kind: "oai", added: 1, missing: 1, returned: 0, update: ["name"] },
    ])
    // Only the template of a retired slot is left as it was.
    expect(reconciled?.registry.modelTemplates.tpl_ds_test).toBe(ds)
    expect(reconciled?.registry.modelTemplates.tpl_oai_test?.models.map((model) => String(model.id))).toEqual([
      "gpt-a",
      "gpt-b",
      "gpt-c",
    ])
    expect({ ...reconciled?.registry, modelTemplates: {} }).toEqual({ ...registry, modelTemplates: {} })
    if (!reconciled) throw new Error("nothing reconciled")
    expect(TemplateDiff.reconcile(reconciled.registry, catalog, LATER)).toBeUndefined()
  })
})

describe("TemplateDiff.carry (accounts.update{refreshCatalog})", () => {
  test("keeps addedAt of models still listed and the rows marked missing; the new capture has no update", () => {
    const previous: Registry.ModelTemplate = {
      ...pinned("oai", [catalogModel("openai", "gpt-a"), catalogModel("openai", "gpt-b")]),
      update: { detectedAt: AT, fields: ["name"] },
    }
    const marked: Registry.ModelTemplate = {
      ...previous,
      models: previous.models.map((model) =>
        model.id === "gpt-a" ? { ...model, addedAt: AT } : { ...model, upstream: "missing" as const },
      ),
    }
    const next = pinned("oai", [catalogModel("openai", "gpt-a", { name: "GPT A2" }), catalogModel("openai", "gpt-c")])
    const carried = TemplateDiff.carry(marked, next)
    expect(carried.models.map((model) => [String(model.id), model.addedAt ?? null, model.upstream ?? null])).toEqual([
      ["gpt-a", AT, null],
      ["gpt-c", null, null],
      ["gpt-b", null, "missing"],
    ])
    expect(carried.models[0]?.name).toBe("GPT A2")
    expect(carried).not.toHaveProperty("update")
    expect(TemplateDiff.carry(undefined, next)).toBe(next)
  })
})
