// 02 §4.8 speed: the pure choice, offer, resolve and inherit rules, with made-up tiers and catalog entries.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CodexModels, Speed } from "../src/index.js"

const NOW = 1_790_000_000_000

describe("Speed: tiers and mode entries", () => {
  test("choiceOf: priority (and its fast alias, or a tier named Fast) is Fast; default, flex and auto are none", () => {
    expect(Speed.choiceOf({ id: "priority" })).toBe("fast")
    expect(Speed.choiceOf({ id: "fast" })).toBe("fast")
    expect(Speed.choiceOf({ id: "ultrafast" })).toBe("ultrafast")
    expect(Speed.choiceOf({ id: "priority-2", name: "Fast" })).toBe("fast")
    expect(Speed.choiceOf({ id: "uf", name: "Ultra Fast" })).toBe("ultrafast")
    for (const id of ["default", "standard", "flex", "auto"]) expect(Speed.choiceOf({ id })).toBeUndefined()
  })

  test("requestTier never sends fast or default", () => {
    expect(Speed.requestTier("fast")).toBe("priority")
    expect(Speed.requestTier("priority")).toBe("priority")
    expect(Speed.requestTier("ultrafast")).toBe("ultrafast")
    expect(Speed.requestTier("default")).toBeUndefined()
  })

  test("modeOf finds core's <model>-fast and -ultrafast entries only", () => {
    expect(Speed.modeOf({ id: "gpt-6-astra-fast", modelID: "gpt-6-astra" })).toBe("fast")
    expect(Speed.modeOf({ id: "gpt-6-astra-ultrafast", modelID: "gpt-6-astra" })).toBe("ultrafast")
    expect(Speed.modeOf({ id: "gpt-6-astra-pro", modelID: "gpt-6-astra" })).toBeUndefined()
    expect(Speed.modeOf({ id: "gpt-6-astra", modelID: "gpt-6-astra" })).toBeUndefined()
    // A real model id that happens to end in -fast (OpenRouter) is no mode entry.
    expect(Speed.modeOf({ id: "morph/morph-v3-fast", modelID: "morph/morph-v3-fast" })).toBeUndefined()
    expect(Speed.modeOf({ id: "claude-opus-5-5-fast" })).toBeUndefined()
  })

  test("listed: an account's tiers become candidates; fast is sent as priority, default dropped", () => {
    const candidates = Speed.listed(
      [
        { id: "fast", name: "Fast", description: "2x speed" },
        { id: "ultrafast", name: "Ultrafast" },
        { id: "default", name: "Standard" },
        { id: "flex" },
      ],
      { billing: (tier) => ({ type: "plan", included: tier === "ultrafast" ? 8 : 2.5, credits: null }) },
    )
    expect(candidates).toEqual([
      {
        choice: "fast",
        tier: "priority",
        wire: "service_tier",
        basis: "account",
        verified: true,
        name: "Fast",
        description: "2x speed",
        billing: { type: "plan", included: 2.5, credits: null },
      },
      {
        choice: "ultrafast",
        tier: "ultrafast",
        wire: "service_tier",
        basis: "account",
        verified: true,
        name: "Ultrafast",
        billing: { type: "plan", included: 8, credits: null },
      },
    ])
  })

  test("modes: OpenAI service_tier and Anthropic speed from the base model's mode entries", () => {
    const entries = [
      { id: "gpt-6-astra-fast", modelID: "gpt-6-astra", body: { service_tier: "priority" }, price: 20 },
      { id: "gpt-6-astra-ultrafast", modelID: "gpt-6-astra", body: { service_tier: "ultrafast" }, price: 60 },
      { id: "gpt-6-astra-pro", modelID: "gpt-6-astra", body: { reasoning: { mode: "pro" } }, price: 10 },
      { id: "gpt-6-sol-fast", modelID: "gpt-6-sol", body: { service_tier: "priority" }, price: 4 },
    ]
    const offered = Speed.modes(entries, "gpt-6-astra", {
      billing: (entry) => ({ type: "api", input: entry.price, output: entry.price * 5 }),
    })
    expect(offered.map((item) => [item.choice, item.tier, item.wire, item.billing])).toEqual([
      ["fast", "priority", "service_tier", { type: "api", input: 20, output: 100 }],
      ["ultrafast", "ultrafast", "service_tier", { type: "api", input: 60, output: 300 }],
    ])
    const claude = Speed.modes(
      [{ id: "claude-opus-5-5-fast", modelID: "claude-opus-5-5", body: { speed: "fast" } }],
      "claude-opus-5-5",
    )
    expect(claude).toEqual([{ choice: "fast", tier: "fast", wire: "speed", basis: "catalog", verified: true }])
  })

  test("CodexModels.tiers: service_tiers, else the deprecated additional_speed_tiers, else not reported", () => {
    const decoded = CodexModels.decode({
      // Models of the bundled Codex catalog: a model own does not know is left out before its tiers are read.
      models: [
        {
          slug: "gpt-6-astra",
          service_tiers: [{ id: "priority", name: "Fast" }, { name: "broken" }, { id: "ultrafast" }],
        },
        { slug: "gpt-6.1-sol", additional_speed_tiers: ["fast"] },
        { slug: "gpt-6-sol" },
        { slug: "gpt-6-luna", service_tiers: "garbage", max_context_window: 872_000 },
        { slug: "gpt-5.5", service_tiers: [] },
      ],
    })
    expect(decoded?.rejected).toBe(0)
    const rows = decoded?.models ?? []
    expect(rows.map((row) => CodexModels.tiers(row))).toEqual([
      [{ id: "priority", name: "Fast" }, { id: "ultrafast" }],
      [{ id: "priority", name: "Fast" }],
      undefined,
      undefined,
      [],
    ])
    // A malformed tier list never costs the row its window (R8).
    expect(rows[3]?.max_context_window).toBe(872_000)
  })
})

const fast = (status: Speed.Status = "available", basis: Speed.Basis = "account"): Speed.Offer => ({
  choice: "fast",
  tier: "priority",
  wire: "service_tier",
  basis,
  status,
})
const ultra = (status: Speed.Status = "available"): Speed.Offer => ({
  choice: "ultrafast",
  tier: "ultrafast",
  wire: "service_tier",
  basis: "account",
  status,
})

describe("Speed: offers and marks", () => {
  test("the account's list beats the catalog; an unconfirmed candidate is unverified", () => {
    const catalog = Speed.modes([{ id: "m-fast", modelID: "m", body: { service_tier: "priority" } }], "m", {
      verified: false,
    })
    const account = Speed.listed([{ id: "priority", name: "Fast" }])
    expect(Speed.offers(catalog, [], NOW)).toEqual([fast("unverified", "catalog")])
    expect(Speed.offers([...catalog, ...account], [], NOW)).toEqual([{ ...fast(), name: "Fast" }])
  })

  test("marks: unavailable until a refresh, cooldown until its end", () => {
    const candidates = Speed.listed([{ id: "priority" }, { id: "ultrafast" }])
    const marks: Speed.Mark[] = [
      { tier: "ultrafast", status: "unavailable", reason: "status_400" },
      { tier: "priority", status: "cooldown", reason: "status_429", until: NOW + 60_000 },
    ]
    expect(Speed.offers(candidates, marks, NOW)).toEqual([
      { ...fast("cooldown"), until: NOW + 60_000, reason: "status_429" },
      { ...ultra("unavailable"), reason: "status_400" },
    ])
    // The cooldown is over: Fast is available again; the refused Ultrafast stays refused.
    expect(Speed.offers(candidates, marks, NOW + 60_000).map((offer) => offer.status)).toEqual([
      "available",
      "unavailable",
    ])
  })
})

describe("Speed: resolve (decision 6) and inherit (07 §2.10)", () => {
  test("a usable choice is sent as chosen; Standard sends nothing", () => {
    expect(Speed.resolve("fast", [fast()])).toEqual({ effective: "fast", offer: fast(), fell: false })
    expect(Speed.resolve("ultrafast", [fast(), ultra()])).toMatchObject({ effective: "ultrafast", fell: false })
    expect(Speed.resolve("standard", [fast(), ultra()])).toEqual({ effective: "standard", fell: false })
    expect(Speed.resolve("fast", [fast("unverified", "catalog")])).toMatchObject({ effective: "fast", fell: false })
  })

  test("falls back Ultrafast → Fast → Standard", () => {
    expect(Speed.resolve("ultrafast", [fast(), ultra("unavailable")])).toMatchObject({ effective: "fast", fell: true })
    expect(Speed.resolve("ultrafast", [fast("cooldown"), ultra("unavailable")])).toEqual({
      effective: "standard",
      fell: true,
    })
    expect(Speed.resolve("fast", [])).toEqual({ effective: "standard", fell: true })
    // A Fast choice never climbs to Ultrafast.
    expect(Speed.resolve("fast", [fast("unavailable"), ultra()])).toEqual({ effective: "standard", fell: true })
  })

  test("a child inherits only on the root main's account when its model lists the same speed", () => {
    const root = { providerID: "own-codex-aaaa", effective: "ultrafast" as const }
    expect(Speed.inherit({ root, child: { providerID: "own-codex-aaaa", offers: [fast(), ultra()] } })).toMatchObject({
      effective: "ultrafast",
      fell: false,
    })
    // The child's lighter model lists Fast only: Standard, never a slower fallback.
    expect(Speed.inherit({ root, child: { providerID: "own-codex-aaaa", offers: [fast()] } })).toEqual({
      effective: "standard",
      fell: true,
    })
    // A pinned target on another provider or account never inherits.
    expect(Speed.inherit({ root, child: { providerID: "own-oai-bbbb", offers: [fast(), ultra()] } })).toEqual({
      effective: "standard",
      fell: false,
    })
    expect(
      Speed.inherit({
        root: { ...root, effective: "standard" },
        child: { providerID: root.providerID, offers: [fast()] },
      }),
    ).toEqual({ effective: "standard", fell: false })
  })

  test("downgraded: default or standard served for a faster request; the fast alias is the same tier", () => {
    expect(Speed.downgraded("priority", "default")).toBe(true)
    expect(Speed.downgraded("priority", "priority")).toBe(false)
    expect(Speed.downgraded("priority", "fast")).toBe(false)
    expect(Speed.downgraded("ultrafast", "priority")).toBe(true)
    expect(Speed.downgraded("fast", "standard")).toBe(true)
    expect(Speed.downgraded("fast", "fast")).toBe(false)
    expect(Speed.downgraded("priority", null)).toBe(false)
    // 02 §4.8 (2026-10-10): what an Ultrafast request may be answered with on every OpenAI-family kind.
    expect(Speed.downgraded("ultrafast", "ultrafast")).toBe(false)
    expect(Speed.downgraded("ultrafast", "default")).toBe(true)
    expect(Speed.downgraded("ultrafast", "flex")).toBe(true)
    expect(Speed.downgraded("ultrafast", undefined)).toBe(false)
  })

  test("a tier never honored and served slower IGNORED_AFTER times is announced as ignored", () => {
    expect(Speed.IGNORED_AFTER).toBeGreaterThan(1)
    expect(Schema.decodeUnknownSync(Speed.Reason)("ignored")).toBe("ignored")
  })
})

describe("Speed: stored state", () => {
  test("KV state and consent decode; a new conversation (no value) is Standard without the beta", () => {
    const decode = Schema.decodeUnknownSync(Speed.State)
    expect(decode({})).toEqual({})
    const state: unknown = { choice: "fast", setAt: NOW, beta: { since: NOW, modelID: "claude-opus-5-5" } }
    expect(decode(state)).toEqual(decode(structuredClone(state)))
    expect(String(decode(state).beta?.modelID)).toBe("claude-opus-5-5")
    expect(() => decode({ choice: "turbo" })).toThrow()
    expect(Schema.decodeUnknownSync(Speed.Consent)({ at: NOW })).toEqual({ at: NOW })
  })
})
