// presets.defaults.set and presets.list (07 §2.2, §2.6, §4.2, §5.1, §8.1): ★, the user's lighter pair, the start
// preset rule, the global ultra level, the new-session default model (T0 rules kept, siwc on the codex rule without
// Codex CLI hints), and the per-group list. The Codex home is a temp fixture folder; every account is fake.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Preset } from "@own/protocol"
import { failure, price, rpcContext } from "../slots/support.js"
import { CLAUDE, CODEX_A, OPENAI, SIWC_A, harness, type Harness } from "./fixtures/catalog-2026-10-01.js"

const decodeSave = Schema.decodeUnknownSync(Preset.Save)
const decodeInfo = Schema.decodeUnknownSync(Preset.Info)

function save(group: Preset.Group, name: string, roles: Record<string, ReadonlyArray<unknown>> = {}) {
  return decodeSave({
    name,
    group,
    workers: {
      mode: "by-role",
      roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
    },
    delegation: "when-useful",
    caps: Preset.CAPS,
    ultraCaps: null,
  })
}

async function stored(h: Harness, input: Preset.Save) {
  const out = await h.presets.set({ preset: input }, rpcContext())
  if (!("preset" in out)) throw new Error(`set failed: ${JSON.stringify(out)}`)
  return out.preset
}

async function listed(h: Harness, group?: Preset.Group) {
  const out = await h.presets.list(group ? { group } : {}, rpcContext())
  if (!("groups" in out)) throw new Error("list failed")
  return out
}

describe("presets.defaults.set (07 §8.1)", () => {
  test("★ names a preset of the group, its 평소대로 id clears it, and presets.list puts it first", async () => {
    await using h = await harness()
    const light = await stored(h, save("codex", "가볍게 나눠 쓰기", { explore: [{ rel: "lighter" }] }))
    const review = await stored(
      h,
      save("codex", "다른 회사 리뷰", { "own-review": [{ pin: { account: CLAUDE, model: "claude-opus-5-5" } }] }),
    )
    const view = await h.presets.defaultsSet({ group: "codex", star: review.id }, rpcContext())
    expect(view).toMatchObject({ group: "codex", star: review.id })
    expect("presets" in view ? view.presets?.map((preset) => preset.id) : []).toEqual([
      review.id,
      Preset.builtinID("codex"),
      light.id,
    ])
    expect(h.presets.star("codex")).toBe(review.id)
    expect((await h.file()).groups.codex?.star).toBe(review.id)

    // Neither an unknown preset nor another group's may be ★; nothing changes.
    const unknown = Preset.ID.make("pr_01JB0000000000000000000000")
    expect(failure(await h.presets.defaultsSet({ group: "codex", star: unknown }, rpcContext()))).toMatchObject({
      type: "internal_error",
      message: "preset_not_found",
    })
    expect(
      failure(await h.presets.defaultsSet({ group: "codex", star: Preset.builtinID("ds") }, rpcContext())),
    ).toMatchObject({ type: "internal_error", message: "preset_wrong_group" })
    expect(failure(await h.presets.defaultsSet({ group: "ds", star: review.id }, rpcContext()))).toMatchObject({
      message: "preset_not_found",
    })
    expect(h.presets.star("codex")).toBe(review.id)

    const cleared = await h.presets.defaultsSet({ group: "codex", star: Preset.builtinID("codex") }, rpcContext())
    expect(cleared).toMatchObject({ star: Preset.builtinID("codex") })
    expect(h.presets.star("codex")).toBeUndefined()
    expect((await h.file()).groups.codex?.star).toBeUndefined()
  })

  test("the user's lighter pair, the start preset and the ultra level are stored in one write", async () => {
    await using h = await harness()
    const view = await h.presets.defaultsSet(
      {
        group: "codex",
        lighter: { mainModelID: Model.ID.make("gpt-6-astra"), model: Model.ID.make("gpt-6-sol") },
        newSession: "last-light",
        ultraCaps: "large",
      },
      rpcContext(),
    )
    expect<unknown>("lighter" in view ? view.lighter : undefined).toEqual({
      "gpt-6-astra": { model: "gpt-6-sol", source: "user" },
    })
    const file = await h.file()
    expect(file).toMatchObject({ newSession: "last-light", ultraCaps: "large" })
    expect(h.events.filter((event) => event.name === "presets.changed")).toHaveLength(1)
    expect(h.presets.settings()).toEqual({ newSession: "last-light", recent: [], ultraCaps: "large" })

    // The user's own numbers; per-message or concurrent above per-conversation make no sense.
    await h.presets.defaultsSet(
      { group: "codex", ultraCaps: { concurrent: 16, perMessage: 48, perSession: 300 } },
      rpcContext(),
    )
    expect(h.presets.settings().ultraCaps).toEqual({ concurrent: 16, perMessage: 48, perSession: 300 })
    expect(
      failure(
        await h.presets.defaultsSet(
          { group: "codex", ultraCaps: { concurrent: 16, perMessage: 400, perSession: 300 } },
          rpcContext(),
        ),
      ),
    ).toMatchObject({ type: "internal_error", message: "caps_invalid" })
    const list = await listed(h)
    expect(list).toMatchObject({
      newSession: "last-light",
      recent: [],
      ultraCaps: { concurrent: 16, perMessage: 48, perSession: 300 },
    })
  })

  test("the default model keeps its T0 rules next to the T1 fields: user wins, null returns to auto", async () => {
    await using h = await harness({
      codex: { "config.toml": 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n' },
    })
    const light = await stored(h, save("codex", "가볍게 나눠 쓰기", { explore: [{ rel: "lighter" }] }))
    const set = await h.presets.defaultsSet(
      {
        group: "codex",
        defaultModel: { id: Model.ID.make("gpt-6-sol"), variant: Model.VariantID.make("xhigh") },
        star: light.id,
      },
      rpcContext(),
    )
    expect(set).toMatchObject({
      defaultModel: { id: "gpt-6-sol", variant: "xhigh", source: "user" },
      label: "user",
      star: light.id,
    })
    expect(await h.presets.defaultFor({ kind: "codex", providerID: CODEX_A })).toEqual({
      providerID: CODEX_A,
      id: "gpt-6-sol",
      variant: "xhigh",
    })
    const reset = await h.presets.defaultsSet({ group: "codex", defaultModel: null }, rpcContext())
    expect(reset).toMatchObject({
      defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" },
      label: "codex-config",
      star: light.id,
    })
  })
})

describe("presets.list (07 §8.1)", () => {
  test("per group: ★ first, 평소대로 always, statuses, the lighter table and the default model's label", async () => {
    await using h = await harness()
    const list = await listed(h)
    expect(list.groups.map((group) => group.group)).toEqual(["codex", "siwc", "oai", "ds", "claude-sub"])
    expect(list).toMatchObject({ newSession: "star", recent: [], ultraCaps: "recommended" })
    expect(list.groups[0]).toEqual({
      group: "codex",
      defaultModel: { id: Model.ID.make("gpt-6-astra"), source: "auto", basis: "family-price" },
      presets: [{ ...Preset.builtin("codex"), status: "ok" }],
      star: Preset.builtinID("codex"),
      lighter: {},
      status: "ok",
      label: "family-price",
    })

    // A hand edit pins a Claude model that does not exist (gone from the catalog) and marks a pair missing.
    const gone = Preset.ID.make("pr_01JB00000000000000000000CC")
    await h.deps.runtime.presets.write({
      version: 1,
      groups: {
        codex: {
          presets: [
            decodeInfo({
              ...save("codex", "오래된 리뷰", {
                "own-review": [{ pin: { account: CLAUDE, model: "claude-opus-4-1" } }],
              }),
              id: gone,
              revision: 2,
            }),
          ],
          lighter: { "gpt-5.5": { model: Model.ID.make("gpt-5.4-nano"), source: "auto", missing: true } },
        },
      },
      recent: [gone, Preset.ID.make("pr_01JB00000000000000000000DD")],
    })
    h.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "external" })
    const codex = (await listed(h, "codex")).groups[0]
    expect(codex?.status).toBe("needs_repair")
    expect(codex?.presets?.map((preset) => [preset.name, preset.status])).toEqual([
      ["평소대로", "ok"],
      ["오래된 리뷰", "needs_repair"],
    ])
    expect(codex?.lighter).toMatchObject({ "gpt-5.5": { missing: true } })
    // Recent names only presets that exist.
    expect((await listed(h)).recent).toEqual([gone])
  })
})

describe("siwc new-session default (07 §2.2, T1.01 decision)", () => {
  test("the codex rule without Codex CLI hints: the priciest family's newest, priced from the openai catalog", async () => {
    // gpt-6-luna, the newest of its family, is priced above every other family here, so a price-blind rule (the
    // newest) would pick gpt-6.1-sol.
    const openai = OPENAI.map((entry) => (entry.id === "gpt-6-luna" ? { ...entry, cost: [price(40, 200)] } : entry))
    await using h = await harness({
      catalog: { openai },
      codex: {
        "config.toml": 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n',
        "models_cache.json": JSON.stringify({
          models: [{ slug: "gpt-6-astra", priority: 1, default_reasoning_level: "low" }],
        }),
      },
    })
    const list = await listed(h)
    const of = (group: Preset.Group) => list.groups.find((row) => row.group === group)?.defaultModel
    // ChatGPT (codex) follows this PC's Codex config; Sign in with ChatGPT never reads it.
    expect<unknown>(of("codex")).toEqual({ id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" })
    expect<unknown>(of("siwc")).toEqual({ id: "gpt-6-luna", source: "auto", basis: "family-price" })
    expect(await h.presets.defaultFor({ kind: "siwc", providerID: SIWC_A })).toEqual({
      providerID: SIWC_A,
      id: "gpt-6-luna",
    })
  })
})
