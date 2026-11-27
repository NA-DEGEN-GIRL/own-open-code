// Lighter pairs (07 §4.2): decided once on first need from the main account's priced models, stored `auto`, never
// decided again; a user pair wins; local groups and unpriced mains are left to the user. Fake catalogs only.

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Preset } from "@own/protocol"
import { PresetLighter } from "../../src/presets/lighter.js"
import { rpcContext } from "../slots/support.js"
import { CODEX_A, OLLAMA, OPENAI, harness } from "./fixtures/catalog-2026-10-01.js"

const main = (id: string, account = "acc_aaaa"): Preset.Main => ({
  account,
  ref: { providerID: Provider.ID.make(CODEX_A), id: Model.ID.make(id) },
  variants: [],
})

/** Candidates as the main account prices them: a table of input prices by model id. */
const priced = (prices: Readonly<Record<string, number>>, family: (id: string) => string) => async () =>
  Object.entries(prices).map(([id, price]) => ({ id, family: family(id), released: 0, price, variants: [] }))

describe("PresetLighter", () => {
  test("the cheapest cheaper family's newest model; mode entries, alpha, deprecated and tool-less models never win", async () => {
    await using h = await harness()
    const resolved = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-sol" })
    if (!resolved) throw new Error("no main")
    const lighter = PresetLighter.create(h.presets, async (account) => {
      const offer = await h.presets.resolver.inventory(account)
      return offer ? Preset.candidates(offer.models, offer.price) : []
    })
    expect<unknown>(await lighter.pair("codex", resolved, "write")).toEqual({ model: "gpt-6-luna", source: "auto" })
  })

  test("concurrent first needs store one pair; the first stored value stands", async () => {
    await using h = await harness()
    const calls = { count: 0 }
    const family = (id: string) => id
    const lighter = PresetLighter.create(h.presets, async () => {
      calls.count += 1
      // The second decision would pick another model; whichever is stored first is answered to both.
      return priced(calls.count === 1 ? { a: 10, b: 1 } : { a: 10, c: 0.5 }, family)()
    })
    const [first, second] = await Promise.all([
      lighter.pair("codex", main("a"), "write"),
      lighter.pair("codex", main("a"), "write"),
    ])
    expect(first).toEqual(second)
    const stored = (await h.file()).groups.codex?.lighter?.a
    expect(stored).toEqual(first)
    // Stored: never decided again, whatever the candidates say now.
    expect(await lighter.pair("codex", main("a"), "write")).toEqual(stored)
    expect(calls.count).toBe(2)
  })

  test("a user's pair wins and is never replaced; a pair marked missing makes the role run like the main", async () => {
    await using h = await harness()
    const set = await h.presets.defaultsSet(
      { group: "codex", lighter: { mainModelID: Model.ID.make("gpt-6-astra"), model: Model.ID.make("gpt-6-sol") } },
      rpcContext(),
    )
    expect<unknown>("lighter" in set ? set.lighter : undefined).toEqual({
      "gpt-6-astra": { model: "gpt-6-sol", source: "user" },
    })
    const astra = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-astra" })
    if (!astra) throw new Error("no main")
    const preset = { workers: { mode: "single" as const, single: { rel: "lighter" as const }, roles: {} } }
    expect((await h.presets.resolver.resolve(preset, astra, { write: true })).roles.general?.use.id).toBe(
      Model.ID.make("gpt-6-sol"),
    )
    // A hand-marked missing pair (07 §4.3): skipped, never decided again.
    await h.deps.runtime.presets.write({
      version: 1,
      groups: { codex: { lighter: { "gpt-6-astra": { model: Model.ID.make("gpt-6-sol"), missing: true } } } },
    })
    h.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    const missing = await h.presets.resolver.resolve(preset, astra, { write: true })
    expect(missing.roles.general?.targets[0]?.skip).toBe("lighter-missing")
    expect(missing.roles.general?.use).toEqual(astra.ref)
  })

  test("a local group or an unpriced main is never decided; nothing is stored", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const lighter = PresetLighter.create(
      h.presets,
      priced({ a: 10, b: 1 }, (id) => id),
    )
    expect(await lighter.pair("local:ollama", main("a", "local:ollama"), "write")).toBeUndefined()
    const unpriced = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-astra" })
    if (!unpriced) throw new Error("no main")
    h.refold({ openai: OPENAI.map((entry) => (entry.id === "gpt-6-astra" ? { ...entry, cost: [] } : entry)) })
    const resolved = await h.presets.resolver.resolve(
      { workers: { mode: "single", single: { rel: "lighter" }, roles: {} } },
      unpriced,
      { write: true },
    )
    expect(resolved.roles.general?.targets[0]?.skip).toBe("lighter-unknown")
    expect((await h.file()).groups).toEqual({})
  })

  test("an unwritable presets.json keeps the decided pair in memory, the same on every call", async () => {
    await using h = await harness()
    await Bun.write(h.deps.runtime.layout.presets, "{ not json")
    const calls = { count: 0 }
    const lighter = PresetLighter.create(h.presets, async () => {
      calls.count += 1
      return priced(calls.count === 1 ? { a: 10, b: 1 } : { a: 10, c: 0.5 }, (id) => id)()
    })
    expect<unknown>(await lighter.pair("codex", main("a"), "write")).toEqual({ model: "b", source: "auto" })
    expect<unknown>(await lighter.pair("codex", main("a"), "write")).toEqual({ model: "b", source: "auto" })
    expect(calls.count).toBe(1)
    expect(await Bun.file(h.deps.runtime.layout.presets).text()).toBe("{ not json")
  })

  test("saving a preset is no need: a preview answers the rule's pair and neither stores nor remembers it", async () => {
    await using h = await harness()
    const calls = { count: 0 }
    const lighter = PresetLighter.create(h.presets, async () => {
      calls.count += 1
      return priced(calls.count === 1 ? { a: 10, b: 1 } : { a: 10, c: 0.5 }, (id) => id)()
    })
    expect<unknown>(await lighter.pair("codex", main("a"), "preview")).toEqual({ model: "b", source: "auto" })
    expect((await h.file()).groups.codex?.lighter).toBeUndefined()
    // A model released between the save and the first need counts: the first need decides, and stores, `c`.
    expect<unknown>(await lighter.pair("codex", main("a"), "write")).toEqual({ model: "c", source: "auto" })
    expect<unknown>((await h.file()).groups.codex?.lighter?.a).toEqual({ model: "c", source: "auto" })
  })
})

describe("a new Codex priority 1 (07 §4.5, U3)", () => {
  /** This PC's Codex cache before and after a newer list puts gpt-6.1-sol first. */
  const cache = (first: string) =>
    JSON.stringify({
      models: [
        { slug: first, priority: 1, default_reasoning_level: "medium" },
        { slug: "gpt-6-sol", priority: 3, default_reasoning_level: "medium" },
        ...(first === "gpt-6-astra" ? [] : [{ slug: "gpt-6-astra", priority: 2, default_reasoning_level: "low" }]),
      ],
    })

  test("changes neither the group's new-session default nor any lighter pair; a new main pairs by price", async () => {
    await using h = await harness({ codex: { "models_cache.json": cache("gpt-6-astra") } })
    expect(await h.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-astra",
      variant: "medium",
    })
    const pairs = { write: true } as const
    const lighter = { workers: { mode: "single" as const, single: { rel: "lighter" as const }, roles: {} } }
    for (const id of ["gpt-6-astra", "gpt-6-sol"]) {
      const resolved = await h.presets.resolver.main({ providerID: CODEX_A, id })
      if (!resolved) throw new Error("no main")
      await h.presets.resolver.resolve(lighter, resolved, pairs)
    }
    const stored = (await h.file()).groups.codex?.lighter
    expect<unknown>(stored).toEqual({
      "gpt-6-astra": { model: "gpt-6-luna", source: "auto" },
      "gpt-6-sol": { model: "gpt-6-luna", source: "auto" },
    })

    await Bun.write(path.join(h.deps.options.codexHome ?? "", "models_cache.json"), cache("gpt-6.1-sol"))
    expect(await h.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toMatchObject({ id: "gpt-6-astra" })
    expect<unknown>(await h.presets.list({ group: "codex" }, rpcContext())).toMatchObject({
      groups: [{ group: "codex", defaultModel: { id: "gpt-6-astra", source: "auto", basis: "codex-meta" } }],
    })
    const sol = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6.1-sol" })
    if (!sol) throw new Error("no main")
    expect((await h.presets.resolver.resolve(lighter, sol, pairs)).roles.general?.use.id).toBe(
      Model.ID.make("gpt-6-luna"),
    )
    expect<unknown>((await h.file()).groups.codex?.lighter).toEqual({
      ...stored,
      "gpt-6.1-sol": { model: "gpt-6-luna", source: "auto" },
    })
  })
})
