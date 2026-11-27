// The effort and subagent-role fixes (PE 2026-11-08, 07 §2.3, §2.4): a pool entry's one `추론 강도` choice holding its
// effort and its fixed level, what each role may do (the role lists the permission hooks enforce), whether the main is
// told about it, and where it runs now under a preset (`Preset.resolve`, the pool's default rule, `강도 고정`). Every
// account and model is fake.
import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { catalogOf, draftOf, mainOf, withMode, withTarget, type CatalogModel } from "./model"
import { presetEffortText, ROLE_PURPOSE } from "./pe-strings"
import { accessOf, entryChoices, entryValue, presetRuns, roleRuns, withPoolChoice } from "./roles"

const CHATGPT = Account.ID.make("acc_chatgpt01")
const CLAUDE = Account.ID.claudeSlot

function account(id: Account.ID, kind: Account.View["kind"], providerID: string): Account.View {
  return {
    id,
    kind,
    label: id.slice(4),
    shortLabel: id.slice(4, 6),
    color: "indigo",
    providerID: Provider.ID.make(providerID),
    billing: "subscription",
    status: "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: "oauth" },
  }
}

const ACCOUNTS = Object.fromEntries(
  [account(CHATGPT, "codex", "own-codex-aaaa"), account(CLAUDE, "claude-sub", "anthropic")].map((item) => [
    item.id,
    item,
  ]),
)

function model(providerID: string, id: string, variants: ReadonlyArray<string>): CatalogModel {
  return {
    id,
    modelID: id,
    providerID,
    name: id.toUpperCase(),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: variants.map((variant) => ({ id: variant })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 400_000, output: 128_000 },
  }
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"]
const MODELS = [
  model("own-codex-aaaa", "gpt-6-astra", LEVELS),
  model("own-codex-aaaa", "gpt-6-luna", LEVELS),
  model("anthropic", "claude-opus-5-5", ["low", "high", "max"]),
]
const main = mainOf(
  { providerID: "own-codex-aaaa", id: "gpt-6-astra", variant: "xhigh" },
  (providerID) => Object.values(ACCOUNTS).find((item) => item.providerID === providerID),
  MODELS,
)!
const catalog = catalogOf(ACCOUNTS, MODELS)
const OPUS: Preset.Target = { pin: { account: CLAUDE, model: Model.ID.make("claude-opus-5-5") } }
const pooled = (entries: ReadonlyArray<Preset.PoolEntry>) => withMode(draftOf("codex"), "pool", entries)
const ENTRY: Preset.PoolEntry = { key: "claude-opus-5-5", model: Model.ID.make("claude-opus-5-5"), account: CLAUDE }

describe("a pool entry's one 추론 강도 (07 §2.3 강도 고정)", () => {
  test("usual efforts, then the fixed levels the model has; nothing to choose without levels", () => {
    const opus = entryChoices(["low", "high", "max"], undefined)
    expect<unknown>(opus?.efforts.map((item) => item.value)).toEqual(["inherit", "default", ...LEVELS])
    expect(opus?.fixed.map((item) => item.level)).toEqual(["low", "high", "max"])
    // Unknown levels: the whole scale and every fixed level.
    expect(entryChoices(undefined, undefined)?.fixed.map((item) => item.level)).toEqual([
      ...Preset.ForcedEffort.literals,
    ])
    expect(entryChoices([], undefined)).toBeUndefined()
    // A stored fixed level the model lacks stays listed, dimmed, so it shows and can be changed.
    expect(entryChoices([], "medium")?.fixed).toEqual([{ value: "fixed:medium", level: "medium", available: false }])
  })

  test("the fixed level is the value while set; choosing an effort drops it, choosing a level keeps the effort", () => {
    const draft = pooled([{ ...ENTRY, effort: Model.VariantID.make("high") }])
    expect(entryValue(draft.workers.pool?.[0])).toBe("high")
    const fixed = withPoolChoice(draft, ENTRY.key, "fixed:low")
    expect(fixed.workers.pool?.[0]).toMatchObject({ effort: "high", forcedEffort: "low" })
    expect(entryValue(fixed.workers.pool?.[0])).toBe("fixed:low")
    const back = withPoolChoice(fixed, ENTRY.key, "inherit")
    expect(back.workers.pool?.[0]).toEqual(ENTRY)
    expect(entryValue(back.workers.pool?.[0])).toBe("inherit")
    expect(withPoolChoice(fixed, ENTRY.key, "max").workers.pool?.[0]).toEqual({
      ...ENTRY,
      effort: Model.VariantID.make("max"),
    })
  })
})

describe("the subagent role guide (07 §2.4)", () => {
  test("what each role may do follows the lists the permission hooks enforce", () => {
    expect(Object.fromEntries(Preset.ROLES.map((role) => [role, accessOf(role)]))).toEqual({
      explore: "search",
      general: "full",
      "own-review": "review",
      "own-quick": "full",
      "own-deep": "full",
    })
    // Every role has a purpose in Korean and English.
    Preset.ROLES.forEach((role) => {
      expect(presetEffortText.text("ko", ROLE_PURPOSE[role])).not.toBe("")
      expect(presetEffortText.text("en", ROLE_PURPOSE[role])).not.toBe(presetEffortText.text("ko", ROLE_PURPOSE[role]))
    })
  })

  test("평소대로: every role like the main; only explore and general are known to the main", () => {
    const runs = presetRuns({
      preset: Preset.builtin("codex"),
      main,
      accounts: ACCOUNTS,
      models: MODELS,
      lighter: {},
      candidates: [],
    })
    expect(runs.map((run) => [run.role, run.source, run.ref?.id, run.account, run.effort, run.named])).toEqual(
      Preset.ROLES.map((role) => [
        role,
        "main",
        "gpt-6-astra",
        CHATGPT,
        { kind: "level", level: "xhigh" },
        role === "explore" || role === "general",
      ]),
    )
  })

  test("by role: a pinned review runs on its account at the main's level fitted; a fixed effort wins", () => {
    const draft = {
      ...withTarget(withMode(draftOf("codex"), "by-role"), "own-review", OPUS),
      delegation: "active" as const,
    }
    const runs = presetRuns({ preset: draft, main, accounts: ACCOUNTS, models: MODELS, lighter: {}, candidates: [] })
    const review = runs.find((run) => run.role === "own-review")
    // xhigh has no place on Opus (low/high/max): the next level above, max.
    expect(review).toMatchObject({
      source: "role",
      ref: { providerID: "anthropic", id: "claude-opus-5-5", variant: "max" },
      account: CLAUDE,
      effort: { kind: "level", level: "max" },
      named: true,
    })
    expect(runs.find((run) => run.role === "own-quick")).toMatchObject({ source: "main", named: false })
    const fixed = presetRuns({
      preset: { ...draft, forcedEffort: "medium" },
      main,
      accounts: ACCOUNTS,
      models: MODELS,
      lighter: {},
      candidates: [],
    })
    // Fixed medium on Opus runs at high (its next level above); on the main's model at medium.
    expect(fixed.find((run) => run.role === "own-review")?.effort).toEqual({
      kind: "fixed",
      level: "medium",
      sent: "high",
    })
    expect(fixed.find((run) => run.role === "general")?.effort).toEqual({
      kind: "fixed",
      level: "medium",
      sent: "medium",
    })
  })

  test("a model pool: the default rule's entry with its own fixed level, the rest like the main", () => {
    const draft = pooled([{ ...ENTRY, forcedEffort: "low" }])
    const resolution = Preset.resolve(draft, main, catalog)
    const runs = roleRuns({
      preset: draft,
      main,
      resolution,
      catalog,
      named: Preset.namedRoles({
        delegation: draft.delegation,
        ultra: false,
        cards: {},
        pool: {
          entries: [],
          relation: {},
          defaults: {},
        },
      }),
      defaults: { "own-review": ENTRY.key },
    })
    expect(runs.find((run) => run.role === "own-review")).toMatchObject({
      source: "pool-default",
      account: CLAUDE,
      effort: { kind: "fixed", level: "low", sent: "low" },
      named: true,
    })
    expect(runs.find((run) => run.role === "own-deep")).toMatchObject({ source: "pool-main", account: CHATGPT })
    // A pool names every role to the main.
    expect(runs.every((run) => run.named)).toBe(true)
  })

  test("without a main: where it would come from, nothing about where it runs", () => {
    const draft = withTarget(withMode(draftOf("codex"), "by-role"), "explore", OPUS)
    const runs = roleRuns({ preset: draft, main: undefined, resolution: undefined, catalog, named: [] })
    expect(runs.map((run) => [run.role, run.source, run.ref])).toEqual(
      Preset.ROLES.map((role) => [role, role === "explore" ? "role" : "main", undefined]),
    )
  })

  test("delegation off names no role", () => {
    expect(Preset.namedRoles({ delegation: "off", ultra: false, cards: {} })).toEqual([])
    expect(Preset.namedRoles({ delegation: "off", ultra: true, cards: {} })).toEqual(["explore", "general"])
  })
})
