// Server-side resolution (07 §4.2) over the 2026-10-01 catalog: relative targets on the main account, the group's
// lighter pairs decided on first need and never again (U3), pinned targets on their own provider, R4 with the
// binding's team, and the fallback order. Fake accounts and catalogs only.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Account, Preset } from "@own/protocol"
import { Templates } from "../../src/slots/templates.js"
import {
  ANTHROPIC,
  CHATGPT_01,
  CHATGPT_02,
  CLAUDE,
  CLAUDE_OFF,
  CODEX_A,
  CODEX_B,
  DEEPSEEK,
  DEEPSEEK_KEY,
  DS,
  OLLAMA,
  OPENAI,
  SIWC_01,
  SIWC_A,
  harness,
  model,
  templateID,
  type Harness,
} from "./fixtures/catalog-2026-10-01.js"

const decodePreset = Schema.decodeUnknownSync(Preset.Info)

/** A stored preset of `group` whose roles have these targets (by role, LLM picks the role). */
function preset(group: Preset.Group, roles: Partial<Record<Preset.Role, ReadonlyArray<unknown>>>) {
  return decodePreset({
    ...Preset.builtin(group),
    id: "pr_01JB0000000000000000000000",
    name: "test",
    workers: {
      mode: "by-role",
      roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
    },
  })
}

const LIGHTER = { rel: "lighter" } as const

/** The explore role of a `가볍게 나눠 쓰기`-like preset resolved for this main Ref. */
async function explore(h: Harness, ref: { providerID: string; id: string; variant?: string }, write = true) {
  const main = await h.presets.resolver.main(ref)
  if (!main) throw new Error(`no main for ${ref.providerID}/${ref.id}`)
  const group = Preset.isLocal(main.account)
    ? main.account
    : h.presets.resolver.lookup(Account.ID.make(main.account))?.kind
  if (!group) throw new Error(`no group for ${main.account}`)
  const resolved = await h.presets.resolver.resolve(preset(group, { explore: [LIGHTER] }), main, { write })
  return resolved.roles.explore
}

describe("lighter pairs (07 §4.2, fixture 2026-10-01)", () => {
  test("gpt-6-astra, gpt-6-sol and gpt-6.1-sol pair with gpt-6-luna on the main's own account", async () => {
    await using h = await harness()
    for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"])
      expect<unknown>((await explore(h, { providerID: CODEX_A, id, variant: "high" }))?.use).toEqual({
        providerID: CODEX_A,
        id: "gpt-6-luna",
        variant: "high",
      })
    // Each pair was decided once and stored as `auto`; the cheaper decoys (a mode entry, an alpha, a deprecated and a
    // tool-less model) never win.
    expect<unknown>((await h.file()).groups.codex?.lighter).toEqual({
      "gpt-6-astra": { model: "gpt-6-luna", source: "auto" },
      "gpt-6-sol": { model: "gpt-6-luna", source: "auto" },
      "gpt-6.1-sol": { model: "gpt-6-luna", source: "auto" },
    })
  })

  test("Claude Opus 5.5 pairs with Claude Haiku 4.5, also from the bundled prices when claude-auth removed them", async () => {
    {
      await using h = await harness()
      expect<unknown>((await explore(h, { providerID: "anthropic", id: "claude-opus-5-5" }))?.use).toEqual({
        providerID: "anthropic",
        id: "claude-haiku-4-5",
      })
    }
    const priceless = ANTHROPIC.map((entry) => ({ ...entry, cost: [] }))
    await using h = await harness({ catalog: { openai: OPENAI, anthropic: priceless } })
    expect<unknown>((await explore(h, { providerID: "anthropic", id: "claude-opus-5-5" }))?.use).toEqual({
      providerID: "anthropic",
      id: "claude-haiku-4-5",
    })
    expect<unknown>((await h.file()).groups["claude-sub"]?.lighter).toEqual({
      "claude-opus-5-5": { model: "claude-haiku-4-5", source: "auto" },
    })
  })

  test("deepseek-v4-pro pairs with deepseek-flash; the main's effort is fitted to the pair", async () => {
    await using h = await harness()
    expect<unknown>((await explore(h, { providerID: DS, id: "deepseek-v4-pro", variant: "max" }))?.use).toEqual({
      providerID: DS,
      id: "deepseek-flash",
      variant: "max",
    })
  })

  test("a siwc slot is priced from the openai catalog like codex: gpt-6-astra pairs with gpt-6-luna", async () => {
    await using h = await harness()
    // The siwc template holds the Sign in with ChatGPT fallback models, gpt-6-luna among them since upstream 209346a0fe.
    expect<unknown>((await explore(h, { providerID: SIWC_A, id: "gpt-6-astra" }))?.use).toEqual({
      providerID: SIWC_A,
      id: "gpt-6-luna",
    })
    expect<unknown>((await h.file()).groups.siwc?.lighter).toEqual({
      "gpt-6-astra": { model: "gpt-6-luna", source: "auto" },
    })
  })

  test("a main already in the cheapest family pairs with itself (none) and the role runs like the main", async () => {
    await using h = await harness()
    const role = await explore(h, { providerID: CODEX_A, id: "gpt-6-luna", variant: "low" })
    expect<unknown>(role).toEqual({
      targets: [{ target: LIGHTER, ref: { providerID: CODEX_A, id: "gpt-6-luna", variant: "low" } }],
      use: { providerID: CODEX_A, id: "gpt-6-luna", variant: "low" },
      fallback: false,
    })
    expect<unknown>((await h.file()).groups.codex?.lighter).toEqual({
      "gpt-6-luna": { model: "gpt-6-luna", source: "none" },
    })
  })

  test("decided once: a newer, cheaper model changes no stored pair (U3); a main seen for the first time uses it", async () => {
    await using h = await harness()
    await explore(h, { providerID: CODEX_A, id: "gpt-6-astra" })
    const flash = model("openai", "gpt-6-flash", { family: "gpt-flash", released: Date.UTC(2026, 9, 1), price: 0.05 })
    const openai = [...OPENAI, flash]
    const built = Templates.fromCatalog("codex", openai, "2026-10-01T12:00:00Z")
    if (!built.ok) throw new Error(built.reason)
    await h.modules.slots.mutate((current) => ({
      ...current,
      modelTemplates: { ...current.modelTemplates, [templateID("codex")]: built.template },
    }))
    h.refold({ openai })
    expect((await explore(h, { providerID: CODEX_A, id: "gpt-6-astra" }))?.use.id).toBe(Model.ID.make("gpt-6-luna"))
    expect((await explore(h, { providerID: CODEX_A, id: "gpt-5.6-sol" }))?.use.id).toBe(Model.ID.make("gpt-6-flash"))
    expect<unknown>((await h.file()).groups.codex?.lighter).toEqual({
      "gpt-6-astra": { model: "gpt-6-luna", source: "auto" },
      "gpt-5.6-sol": { model: "gpt-6-flash", source: "auto" },
    })
  })

  test("a read path keeps the decided pair in memory; the later write stores that same pair", async () => {
    await using h = await harness()
    expect((await explore(h, { providerID: CODEX_A, id: "gpt-6-sol" }, false))?.use.id).toBe(
      Model.ID.make("gpt-6-luna"),
    )
    expect((await h.file()).groups).toEqual({})
    // The catalog changes before anything writes: luna becomes dearer than terra.
    h.refold({ openai: OPENAI.map((entry) => (entry.id === "gpt-6-luna" ? { ...entry, cost: [] } : entry)) })
    expect((await explore(h, { providerID: CODEX_A, id: "gpt-6-sol" }))?.use.id).toBe(Model.ID.make("gpt-6-luna"))
    expect<unknown>((await h.file()).groups.codex?.lighter).toEqual({
      "gpt-6-sol": { model: "gpt-6-luna", source: "auto" },
    })
  })

  test("a local group's pair is never decided: the role runs like the main and says why", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const main = await h.presets.resolver.main({ providerID: "ollama", id: OLLAMA.id })
    expect(main?.account).toBe("local:ollama")
    if (!main) throw new Error("no local main")
    const resolved = await h.presets.resolver.resolve(preset("local:ollama", { explore: [LIGHTER] }), main, {
      write: true,
    })
    expect<unknown>(resolved.roles.explore).toEqual({
      targets: [{ target: LIGHTER, skip: "lighter-unknown" }],
      use: { providerID: "ollama", id: OLLAMA.id },
      fallback: true,
    })
    expect((await h.file()).groups).toEqual({})
  })
})

describe("pinned targets and fallback (07 §4.2, §5.4)", () => {
  const review = (account: string, id: string) => ({ pin: { account, model: id } })

  test("another company's subscription runs on its own provider; R4 with the binding's team skips it", async () => {
    await using h = await harness()
    const main = await h.presets.resolver.main({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" })
    if (!main) throw new Error("no Claude main")
    expect(main.account).toBe(CLAUDE)
    const reviewed = preset("claude-sub", { "own-review": [review(CHATGPT_01, "gpt-6-sol")] })
    expect<unknown>((await h.presets.resolver.resolve(reviewed, main)).roles["own-review"]?.use).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-sol",
      variant: "high",
    })
    const team = (accounts: ReadonlyArray<string>) =>
      Schema.decodeUnknownSync(Preset.Team)({ teamID: "tm_3f9a0c1b2d4e", role: "owner", accounts, pinned: [] })
    // The team already uses ChatGPT 02: ChatGPT 01 would be a second OpenAI subscription.
    const blocked = await h.presets.resolver.resolve(reviewed, main, { team: team([CHATGPT_02]) })
    expect<unknown>(blocked.roles["own-review"]).toEqual({
      targets: [{ target: review(CHATGPT_01, "gpt-6-sol"), skip: "r4" }],
      use: main.ref,
      fallback: true,
    })
    // Sign in with ChatGPT on ChatGPT 01's login is the same subscription.
    const same = await h.presets.resolver.resolve(reviewed, main, { team: team([SIWC_01]) })
    expect(same.roles["own-review"]?.use.providerID).toBe(CODEX_A)
  })

  test("an exhausted target hands over to the next one; with none left the role runs like the main", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const main = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-astra" })
    if (!main) throw new Error("no main")
    const reviewed = preset("codex", {
      "own-review": [review(CLAUDE, "claude-opus-5-5"), review("local:ollama", OLLAMA.id)],
    })
    expect<unknown>((await h.presets.resolver.resolve(reviewed, main)).roles["own-review"]?.use).toEqual({
      providerID: "anthropic",
      id: "claude-opus-5-5",
    })
    h.deps.runtime.limits.exhaust({
      accountID: CLAUDE,
      windowId: null,
      until: h.t.clock.now() + 3_600_000,
      class: "hard",
    })
    const exhausted = await h.presets.resolver.resolve(reviewed, main)
    expect<unknown>(exhausted.roles["own-review"]).toEqual({
      targets: [
        { target: review(CLAUDE, "claude-opus-5-5"), skip: "unavailable" },
        { target: review("local:ollama", OLLAMA.id), ref: { providerID: "ollama", id: OLLAMA.id } },
      ],
      use: { providerID: "ollama", id: OLLAMA.id },
      fallback: false,
    })
    // The local server's list is gone: nothing outside the list is picked, the role runs like the main.
    h.listed.value = []
    const none = await h.presets.resolver.resolve(reviewed, main)
    expect<unknown>(none.roles["own-review"]?.use).toEqual(main.ref)
    expect(none.roles["own-review"]?.fallback).toBe(true)
    // Roles without a row run like the main and are no fallback.
    expect<unknown>(none.roles.general).toEqual({ targets: [], use: main.ref, fallback: false })
  })

  test("main(): an own slot, the installed Claude slot, a local provider; any other provider is in no group", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    expect<unknown>(await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-sol", variant: "xhigh" })).toEqual({
      account: CHATGPT_01,
      ref: { providerID: CODEX_A, id: "gpt-6-sol", variant: "xhigh" },
      variants: ["low", "medium", "high", "xhigh", "max", "ultra"],
    })
    expect(await h.presets.resolver.main({ providerID: "openrouter", id: "x" })).toBeUndefined()
    h.claude.value = CLAUDE_OFF
    expect(await h.presets.resolver.main({ providerID: "anthropic", id: "claude-opus-5-5" })).toBeUndefined()
    // Without the Claude slot its pins are unknown: skipped, never another provider.
    const main = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-astra" })
    if (!main) throw new Error("no main")
    const resolved = await h.presets.resolver.resolve(
      preset("codex", { "own-review": [review(CLAUDE, "claude-opus-5-5")] }),
      main,
    )
    expect(resolved.roles["own-review"]?.targets[0]?.skip).toBe("unavailable")
  })

  test("groupMain: the group's first live account on its new-session default model", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    expect<unknown>((await h.presets.resolver.groupMain("codex"))?.ref).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-astra",
    })
    expect<unknown>((await h.presets.resolver.groupMain("claude-sub"))?.ref).toEqual({
      providerID: "anthropic",
      id: "claude-opus-5-5",
    })
    expect<unknown>((await h.presets.resolver.groupMain("local:ollama"))?.ref).toEqual({
      providerID: "ollama",
      id: OLLAMA.id,
    })
    expect(await h.presets.resolver.groupMain("xai")).toBeUndefined()
  })
})

describe("Codex metadata on codex accounts (07 §2.3, §4.5)", () => {
  /** This PC's Codex cache: fewer levels than the catalog offers, in Codex's order. */
  const CACHE = JSON.stringify({
    models: [
      { slug: "gpt-6-sol", supported_reasoning_levels: ["low", "high", "xhigh", "max"].map((effort) => ({ effort })) },
      { slug: "gpt-6-luna", supported_reasoning_levels: ["low", "high", "max"].map((effort) => ({ effort })) },
      { slug: "gpt-5.6-luna", supported_reasoning_levels: ["low", "max"].map((effort) => ({ effort })) },
    ],
  })

  /** A preset whose roles run at a fixed effort (not `inherit`). */
  function at(group: Preset.Group, effort: string, roles: Partial<Record<Preset.Role, ReadonlyArray<unknown>>>) {
    return decodePreset({
      ...Preset.builtin(group),
      id: "pr_01JB0000000000000000000001",
      name: "effort",
      workers: {
        mode: "by-role",
        roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort }])),
      },
    })
  }

  test("a fixed effort fits the model's levels in the metadata's order: medium goes up to high", async () => {
    await using h = await harness({ codex: { "models_cache.json": CACHE } })
    const main = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-sol", variant: "xhigh" })
    if (!main) throw new Error("no main")
    expect(main.meta?.slug).toBe("gpt-6-sol")
    const resolved = await h.presets.resolver.resolve(
      at("codex", "medium", { explore: [LIGHTER], general: [{ rel: "main" }] }),
      main,
      { write: true },
    )
    // The catalog offers medium on both; Codex lists no medium there, so the next level above is sent.
    expect<unknown>(resolved.roles.explore?.use).toEqual({ providerID: CODEX_A, id: "gpt-6-luna", variant: "high" })
    expect<unknown>(resolved.roles.general?.use).toEqual({ providerID: CODEX_A, id: "gpt-6-sol", variant: "high" })
    // Another company's main pinning a codex model reads the same row.
    const claude = await h.presets.resolver.main({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" })
    if (!claude) throw new Error("no Claude main")
    expect(claude.meta).toBeUndefined()
    const pinned = await h.presets.resolver.resolve(
      at("claude-sub", "medium", { "own-review": [{ pin: { account: CHATGPT_01, model: "gpt-6-sol" } }] }),
      claude,
    )
    expect<unknown>(pinned.roles["own-review"]?.use).toEqual({ providerID: CODEX_A, id: "gpt-6-sol", variant: "high" })
  })

  test("without metadata the catalog's order stands; a siwc account never reads Codex metadata", async () => {
    {
      await using h = await harness()
      const main = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-sol", variant: "xhigh" })
      if (!main) throw new Error("no main")
      expect(main.meta).toBeUndefined()
      const resolved = await h.presets.resolver.resolve(at("codex", "medium", { explore: [LIGHTER] }), main, {
        write: true,
      })
      expect(resolved.roles.explore?.use.variant).toBe(Model.VariantID.make("medium"))
    }
    await using h = await harness({ codex: { "models_cache.json": CACHE } })
    const siwc = await h.presets.resolver.main({ providerID: SIWC_A, id: "gpt-6-astra", variant: "high" })
    if (!siwc) throw new Error("no siwc main")
    expect(siwc.meta).toBeUndefined()
    const resolved = await h.presets.resolver.resolve(at("siwc", "medium", { explore: [LIGHTER] }), siwc, {
      write: true,
    })
    // The siwc pair (gpt-6-luna) keeps medium although Codex lists only low, high and max for it.
    expect<unknown>(resolved.roles.explore?.use).toEqual({ providerID: SIWC_A, id: "gpt-6-luna", variant: "medium" })
  })
})

describe("model pool facts (07 §3.3 모델 묶음, T4)", () => {
  /** A stored model pool preset of `group` (mode `same` and the pool, as presets.set writes it). */
  const pooled = (group: Preset.Group, pool: ReadonlyArray<Record<string, unknown>>) =>
    decodePreset({
      ...Preset.builtin(group),
      id: "pr_01JB0000000000000000000000",
      name: "pool",
      workers: { mode: "same", roles: {}, pool },
      delegation: "when-useful",
    })
  const POOL = [
    { key: "gpt-6-luna", model: "gpt-6-luna" },
    { key: "claude-opus-5-5", model: "claude-opus-5-5", account: CLAUDE },
    { key: "qwen3-coder-30b", model: OLLAMA.id, account: "local:ollama" },
    { key: "deepseek-v4-pro", model: "deepseek-v4-pro", account: DEEPSEEK_KEY },
  ]
  const facts = (resolution: Preset.Resolution) =>
    resolution.pool?.entries.map((entry) => ({
      key: entry.key,
      runs: entry.runs,
      company: entry.company,
      price: entry.price,
    }))

  test("each entry runs on the main account, a subscription, the user's machine or a paid key, at raw prices", async () => {
    await using h = await harness({ listed: [OLLAMA], resolver: { localVerified: () => true } })
    const main = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-sol", variant: "high" })
    if (!main) throw new Error("no main")
    const resolution = await h.presets.resolver.resolve(pooled("codex", POOL), main)
    expect(resolution.pool?.main).toEqual({ runs: "main", company: "openai", price: 2, local: false })
    expect(facts(resolution)).toEqual([
      { key: "gpt-6-luna", runs: "main", company: "openai", price: 0.1 },
      { key: "claude-opus-5-5", runs: "subscription", company: "anthropic", price: 4 },
      { key: "qwen3-coder-30b", runs: "local", company: undefined, price: undefined },
      { key: "deepseek-v4-pro", runs: "paid", company: "deepseek", price: 0.435 },
    ])
    expect<unknown>(resolution.pool?.entries.map((entry) => entry.ref)).toEqual([
      { providerID: CODEX_A, id: "gpt-6-luna", variant: "high" },
      { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
      { providerID: "ollama", id: OLLAMA.id },
      { providerID: DS, id: "deepseek-v4-pro", variant: "high" },
    ])
    // Roles all run like the main; a preset without a pool keeps its resolution's shape.
    expect<unknown>(resolution.roles.explore).toEqual({ targets: [], use: main.ref, fallback: false })
    expect(Object.keys(await h.presets.resolver.resolve(Preset.builtin("codex"), main))).toEqual(["main", "roles"])
  })

  test("the Claude slot's price comes from the bundled anth template when claude-auth removed the catalog's", async () => {
    const priceless = ANTHROPIC.map((entry) => ({ ...entry, cost: [] }))
    await using h = await harness({ catalog: { openai: OPENAI, anthropic: priceless, deepseek: DEEPSEEK } })
    const main = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-sol" })
    if (!main) throw new Error("no main")
    const resolution = await h.presets.resolver.resolve(pooled("codex", POOL), main)
    const claude = resolution.pool?.entries.find((entry) => entry.key === "claude-opus-5-5")
    expect(claude?.price).toBeNumber()
    expect(claude?.runs).toBe("subscription")
  })

  test("facts stay when an account cannot run now or the main moves to another ChatGPT account on the model", async () => {
    await using h = await harness({ listed: [OLLAMA] })
    const main = await h.presets.resolver.main({ providerID: CODEX_A, id: "gpt-6-sol" })
    const other = await h.presets.resolver.main({ providerID: CODEX_B, id: "gpt-6-sol" })
    if (!main || !other) throw new Error("no main")
    const before = await h.presets.resolver.resolve(pooled("codex", POOL), main)
    h.deps.runtime.limits.exhaust({
      accountID: CLAUDE,
      windowId: null,
      until: h.t.clock.now() + 3_600_000,
      class: "hard",
    })
    h.deps.runtime.limits.exhaust({
      accountID: DEEPSEEK_KEY,
      windowId: null,
      until: h.t.clock.now() + 3_600_000,
      class: "hard",
    })
    h.listed.value = []
    const after = await h.presets.resolver.resolve(pooled("codex", POOL), main)
    expect(after.pool?.entries.find((entry) => entry.key === "claude-opus-5-5")?.skip).toBe("unavailable")
    expect(facts(after)).toEqual(facts(before))
    expect(after.pool?.main).toEqual(before.pool?.main)
    const moved = await h.presets.resolver.resolve(pooled("codex", POOL), other)
    expect(facts(moved)).toEqual(facts(before))
    expect(moved.pool?.main).toEqual(before.pool?.main)
    expect<unknown>(moved.pool?.entries[0]?.ref).toEqual({ providerID: CODEX_B, id: "gpt-6-luna" })
  })

  test("a metered group's main-account entries cost money (main-paid); a team-broken pin is skipped as r4", async () => {
    await using h = await harness()
    const metered = await h.presets.resolver.main({ providerID: DS, id: "deepseek-v4-pro" })
    if (!metered) throw new Error("no main")
    const ds = await h.presets.resolver.resolve(
      pooled("ds", [{ key: "deepseek-flash", model: "deepseek-flash" }]),
      metered,
    )
    expect(ds.pool?.main).toEqual({ runs: "main-paid", company: "deepseek", price: 0.435, local: false })
    expect(facts(ds)).toEqual([{ key: "deepseek-flash", runs: "main-paid", company: "deepseek", price: 0.15 }])
    // A Claude-group area that pools another ChatGPT login, in a ChatGPT 01 team.
    const claude = await h.presets.resolver.main({ providerID: "anthropic", id: "claude-opus-5-5" })
    if (!claude) throw new Error("no main")
    const team = Schema.decodeUnknownSync(Preset.Team)({
      teamID: "tm_3f9a0c1b2d4e",
      role: "owner",
      accounts: [CHATGPT_01],
      pinned: [],
    })
    const area = pooled("claude-sub", [{ key: "gpt-6-sol", model: "gpt-6-sol", account: CHATGPT_02 }])
    const broken = await h.presets.resolver.resolve(area, claude, { team })
    expect(broken.pool?.entries[0]).toMatchObject({ key: "gpt-6-sol", skip: "r4", runs: "subscription" })
    const alone = await h.presets.resolver.resolve(area, claude)
    expect<unknown>(alone.pool?.entries[0]?.ref).toEqual({ providerID: CODEX_B, id: "gpt-6-sol" })
  })
})
