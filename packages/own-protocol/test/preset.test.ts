import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Option, Schema } from "effect"
import { Account, Kv, OwnAccounts, OwnID, Preserve, Preset, Registry } from "../src/index.js"
import { CodexModels } from "../src/codex-models.js"
import { optional } from "@opencode/schema/schema"
import { keyedRecord } from "../src/util.js"
import { roundTrip, templateModel } from "./fixtures.js"

const DAY = 86_400_000
const SEP_04 = Date.UTC(2026, 8, 4)
const SEP_22 = Date.UTC(2026, 8, 22)
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

/** A catalog-shaped model (fake values modelled on the 10-01 `openai` catalog, 07 Appendix A). */
function model(id: string, input: { family: string; released: number; price?: number; modelID?: string }) {
  return {
    ...templateModel,
    id,
    modelID: input.modelID ?? id,
    family: input.family,
    variants: EFFORTS.map((effort) => ({ id: effort })),
    time: { released: input.released },
    cost:
      input.price === undefined ? [] : [{ input: input.price, output: input.price * 5, cache: { read: 0, write: 0 } }],
  }
}

/** The ChatGPT group's template on the user's PC: GPT-6 Sol and Luna came out the same day, after Astra. */
const CODEX = [
  model("gpt-5.5", { family: "gpt", released: SEP_04 - 140 * DAY, price: 1.25 }),
  model("gpt-6-astra", { family: "gpt-astra", released: SEP_04, price: 10 }),
  model("gpt-6-astra-fast", { family: "gpt-astra", released: SEP_04, price: 10, modelID: "gpt-6-astra" }),
  model("gpt-6-luna", { family: "gpt-luna", released: SEP_22, price: 0.1 }),
  model("gpt-6-luna-fast", { family: "gpt-luna", released: SEP_22, price: 0.1, modelID: "gpt-6-luna" }),
  model("gpt-6-sol", { family: "gpt-sol", released: SEP_22, price: 2 }),
  model("gpt-5.6-sol", { family: "gpt-sol", released: SEP_04 - 60 * DAY, price: 2 }),
]

/** `models_cache.json` of Codex 0.157.0 (07 Appendix A): Astra first, medium by default. */
const META = [
  { slug: "gpt-6-astra", priority: 1, defaultEffort: "medium" },
  { slug: "gpt-6-sol", priority: 2, defaultEffort: "medium" },
  { slug: "gpt-6-luna", priority: 3, defaultEffort: "medium" },
  { slug: "gpt-5.6-sol", priority: 4, defaultEffort: "low" },
]

/** An `auto` result with plain strings, so expectations are object literals. */
type Plain = { readonly id: string; readonly variant?: string; readonly basis: string } | undefined

const auto = (of: Preset.Group, models: ReadonlyArray<Preset.Entry>, hints?: Preset.CodexHints): Plain =>
  Preset.defaultModel(of, Preset.candidates(models), hints)

const codex = (hints: Preset.CodexHints = {}, models = CODEX) => auto("codex", models, hints)

const SAVED = `pr_${OwnID.ulid(Date.UTC(2026, 9, 1))}`

describe("groups (07 §2.1, P-D2)", () => {
  test("a group is an account kind or a discovered local provider", () => {
    const is = Schema.is(Preset.Group)
    expect(["codex", "claude-sub", "oai", "anth", "ds", "xai", "or", "compat", "local:ollama"].every(is)).toBe(true)
    expect(is("gemini")).toBe(false)
    expect(is("ollama")).toBe(false)
    expect(is("local:")).toBe(false)
  })

  test("local providers mirror upstream's ollama and lmstudio discovery; vllm is not one", () => {
    expect<ReadonlyArray<string>>(Preset.LOCAL_PROVIDERS).toEqual(["ollama", "lmstudio"])
    expect(Preset.isLocal("local:ollama")).toBe(true)
    expect(Preset.isLocal("codex")).toBe(false)
  })

  test("a main provider's group: its account's kind, a local provider, or none", () => {
    expect(Preset.groupOf("own-codex-7k2m", { kind: "codex" })).toBe("codex")
    expect(Preset.groupOf("anthropic", { kind: "claude-sub" })).toBe("claude-sub")
    expect(Preset.groupOf("ollama")).toBe("local:ollama")
    expect(Preset.groupOf("lmstudio")).toBe("local:lmstudio")
    expect(Preset.groupOf("vllm")).toBeUndefined()
    expect(Preset.groupOf("openai")).toBeUndefined()
  })
})

describe("preset ids (07 §2.1)", () => {
  const is = Schema.is(Preset.ID)

  test("a stored preset is pr_<ulid>, a group's 평소대로 is builtin:<group>", () => {
    for (const id of [SAVED, "builtin:codex", "builtin:claude-sub", "builtin:local:ollama"])
      expect<string>(Schema.decodeUnknownSync(Preset.ID)(id)).toBe(id)
    for (const id of [
      "builtin:",
      "builtin:local:",
      "builtin:gemini",
      "pr_x",
      `pr_${SAVED.slice(3).toLowerCase()}`,
      "foo",
    ])
      expect({ id, valid: is(id) }).toEqual({ id, valid: false })
    expect(is(Preset.ID.create())).toBe(true)
  })

  test("isBuiltin and builtinID agree with the decoder", () => {
    for (const group of ["codex", "claude-sub", "ds", "compat", "local:ollama"] as const) {
      const id = Preset.builtinID(group)
      expect<string>(id).toBe(`builtin:${group}`)
      expect([is(id), Preset.isBuiltin(id)]).toEqual([true, true])
    }
    expect([SAVED, "builtin:", "builtin:gemini", "pr_x"].map(Preset.isBuiltin)).toEqual([false, false, false, false])
  })
})

describe("preset shape (07 §2.1, §2.7)", () => {
  test("평소대로: subagents like the main, delegation as the model does, default caps", () => {
    expect<unknown>(Preset.builtin("codex")).toEqual({
      id: "builtin:codex",
      name: "평소대로",
      group: "codex",
      workers: { mode: "same", roles: {} },
      delegation: "model",
      caps: { concurrent: 3, perMessage: 6, perSession: null },
      ultraCaps: null,
      revision: 0,
    })
    expect<unknown>(roundTrip(Preset.Info, Preset.builtin("local:ollama"))).toEqual(Preset.builtin("local:ollama"))
  })

  test("targets: relative (main, lighter) or pinned to an account or a local provider", () => {
    const pinned = { pin: { account: "acc_chatgpt01", model: "gpt-6-luna" } }
    const local = { pin: { account: "local:ollama", model: "qwen3-coder" } }
    for (const target of [{ rel: "main" }, { rel: "lighter" }, pinned, local])
      expect(roundTrip(Preset.Target, target)).toEqual(target)
    for (const target of [{ rel: "other" }, { pin: { account: "chatgpt01", model: "x" } }, { pin: { model: "x" } }])
      expect(() => Schema.decodeUnknownSync(Preset.Target)(target)).toThrow()
  })

  test("a by-role preset round-trips; role keys and efforts are checked", () => {
    const preset = {
      id: SAVED,
      name: "다른 회사 리뷰",
      group: "codex",
      workers: {
        mode: "by-role",
        roles: {
          explore: { targets: [{ rel: "lighter" }], effort: "inherit" },
          "own-review": {
            targets: [{ pin: { account: "acc_claude_slot", model: "claude-opus-5-5" } }],
            effort: "high",
          },
        },
      },
      delegation: "when-useful",
      caps: { concurrent: 3, perMessage: 12, perSession: 100 },
      ultraCaps: "recommended",
      revision: 4,
    }
    expect(roundTrip(Preset.Info, preset)).toEqual(preset)
    const custom = { ...preset, ultraCaps: { concurrent: 8, perMessage: 24, perSession: 200 } }
    expect(roundTrip(Preset.Info, custom)).toEqual(custom)
    const badRole = { ...preset, workers: { ...preset.workers, roles: { review: preset.workers.roles["own-review"] } } }
    expect(() => Schema.decodeUnknownSync(Preset.Info)(badRole)).toThrow()
    expect(() => Schema.decodeUnknownSync(Preset.Info)({ ...preset, delegation: "always" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Preset.Info)({ ...preset, caps: { ...preset.caps, concurrent: 0 } }),
    ).toThrow()
  })

  test("no main model, effort, window or summary fields (U1, P-D8)", async () => {
    // `subagentEffortMax` caps how far a conversation raises a subagent's effort (07 §2.3). The main's effort stays U1's
    // unless the user opts into `forcedEffort` (07 §7.6, the user's request of 2026-11-03): absent by default, and then
    // the composer still picks it, as before.
    expect(Object.keys(Preset.Info.fields)).toEqual([
      "id",
      "name",
      "group",
      "workers",
      "delegation",
      "caps",
      "ultraCaps",
      "subagentEffortMax",
      "forcedEffort",
      "revision",
    ])
    expect(Preset.builtin("codex").forcedEffort).toBeUndefined()
    // No preset, role or pool field sets a window, limit, buffer, compaction or summary threshold. A model pool card
    // (T4) freezes a model's window as a fact the LLM reads, which is no threshold; only it may read `limit`.
    const threshold = /limit|buffer|compact|window|summary/i
    const fieldsOf = (fields: Readonly<Record<string, unknown>>) => Object.keys(fields)
    for (const schema of [Preset.Info, Preset.Workers, Preset.RoleEntry, Preset.Caps, Preset.PoolEntry, Preset.Binding])
      expect(fieldsOf(schema.fields).filter((name) => threshold.test(name))).toEqual([])
    const source = await Bun.file(new URL("../src/preset.ts", import.meta.url)).text()
    expect(source.match(/buffer|compact/gi)).toBeNull()
  })
})

describe("roles (07 §2.4, §3.2)", () => {
  test("five fixed roles; the LLM may name a role without the own- prefix", () => {
    expect<ReadonlyArray<string>>(Preset.ROLES).toEqual(["explore", "general", "own-review", "own-quick", "own-deep"])
    expect(
      ["review", "own-review", "quick", "own-quick", "deep", "own-deep", "explore", "general"].map(Preset.roleOf),
    ).toEqual(["own-review", "own-review", "own-quick", "own-quick", "own-deep", "own-deep", "explore", "general"])
    expect(["own-explore", "reviewer", "openai/gpt-6-sol", ""].map(Preset.roleOf)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe("per-call effort (07 §2.3 대화에서 정하는 강도)", () => {
  const DS = ["low", "high", "max"]
  const LUNA = ["low", "medium", "high", "xhigh", "max", "ultra"]

  test("parser: <target>#<intent>, #<intent> and provider/model#variant; two # stay whole; empty or client-only is invalid", () => {
    expect(
      [
        "review#high",
        "#max",
        "openai/gpt-6-sol#low",
        "gpt-6-luna#xhigh",
        "deepseek-v4-pro#turbo",
        "general#inherit",
      ].map(Preset.effortRequest),
    ).toEqual([
      { type: "effort", target: "review", intent: "high" },
      { type: "effort", intent: "max" },
      { type: "effort", target: "openai/gpt-6-sol", intent: "low" },
      { type: "effort", target: "gpt-6-luna", intent: "xhigh" },
      { type: "effort", target: "deepseek-v4-pro", intent: "turbo" },
      { type: "effort", target: "general", intent: "inherit" },
    ])
    expect([undefined, "review", "openai/gpt-6-sol", "review#high#max"].map(Preset.effortRequest)).toEqual([
      { type: "plain" },
      { type: "plain", target: "review" },
      { type: "plain", target: "openai/gpt-6-sol" },
      { type: "plain", target: "review#high#max" },
    ])
    expect(["#", "review#", "#ultra", "openai/gpt-6-sol#persistent"].map(Preset.effortRequest)).toEqual(
      Array.from({ length: 4 }, () => ({ type: "invalid" })),
    )
    expect(Preset.INTENTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "default", "inherit"])
  })

  test("refit: DeepSeek takes xhigh as max, Luna max as max, a local model none (unplaced), ultra never", () => {
    expect(Preset.fitRequest({ intent: "xhigh", base: "high", variants: DS, ceiling: "max" })).toEqual({
      ok: true,
      variant: "max",
      unplaced: false,
      capped: false,
    })
    expect(Preset.fitRequest({ intent: "max", base: "high", variants: LUNA, ceiling: "max" })).toEqual({
      ok: true,
      variant: "max",
      unplaced: false,
      capped: false,
    })
    expect(Preset.fitRequest({ intent: "high", variants: [], ceiling: "max" })).toEqual({
      ok: true,
      unplaced: true,
      capped: false,
    })
    expect(Preset.fitRequest({ intent: "ultra", base: "high", variants: LUNA, ceiling: "max" })).toEqual({
      ok: false,
      reason: "unknown",
    })
    expect(Preset.fitRequest({ intent: "turbo", base: "high", variants: DS, ceiling: "max" })).toEqual({
      ok: false,
      reason: "unknown",
    })
    // `inherit` is the main's effort fitted like a role row's: GPT xhigh -> DeepSeek max, the row's own value.
    expect(Preset.fitRequest({ intent: "inherit", inherit: "xhigh", base: "max", variants: DS })).toEqual({
      ok: true,
      variant: "max",
      unplaced: false,
      capped: false,
    })
  })

  test("ceiling: lowering always passes; a raise up to the ceiling, rounding the fitted level down to fit it", () => {
    const fit = (intent: string, ceiling?: string, base = "low", variants = DS) =>
      Preset.fitRequest({ intent, base, variants, ...(ceiling === undefined ? {} : { ceiling }) })
    // No raise at all (`off`, or a paid target): only the base or lower.
    expect(fit("low")).toMatchObject({ ok: true, variant: "low" })
    expect(fit("low", undefined, "high")).toMatchObject({ ok: true, variant: "low" })
    expect(fit("high")).toEqual({ ok: false, reason: "cap", max: "low" })
    // xhigh fits DeepSeek's max, which is above an xhigh ceiling: rounded down to high, never rejected.
    expect(fit("xhigh", "xhigh")).toEqual({ ok: true, variant: "high", unplaced: false, capped: true })
    expect(fit("max", "xhigh")).toEqual({ ok: false, reason: "cap", max: "high" })
    expect(fit("max", "high", "low", LUNA)).toEqual({ ok: false, reason: "cap", max: "high" })
    expect(fit("xhigh", "high", "medium", LUNA)).toEqual({ ok: false, reason: "cap", max: "high" })
    expect(fit("max", "max")).toMatchObject({ ok: true, variant: "max", capped: false })
    // A base above the ceiling stays allowed; the round-down never goes below it.
    expect(fit("xhigh", "high", "max")).toMatchObject({ ok: true, variant: "max" })
    // The provider default (`default`, or a base without a variant) has no known rank.
    expect(fit("default", "max", "high")).toMatchObject({ ok: true, unplaced: false })
    expect(fit("default", "xhigh", "high")).toEqual({ ok: false, reason: "cap", max: "high" })
    expect(Preset.fitRequest({ intent: "low", variants: DS })).toEqual({ ok: false, reason: "cap", max: "default" })
    // A level name the usual order does not know is never ranked: a raise to it is refused (remote hosts too).
    expect(Preset.fitRequest({ intent: "turbo", base: "slow", variants: ["slow", "turbo"], ceiling: "max" })).toEqual({
      ok: false,
      reason: "cap",
      max: "slow",
    })
    expect(Preset.fitRequest({ intent: "turbo", base: "turbo", variants: ["slow", "turbo"] })).toMatchObject({
      ok: true,
      variant: "turbo",
    })
  })

  test("the ceiling in force: the preset's (absent = max, unknown = off), once = max, never for a paid target", () => {
    expect(
      [undefined, "max", "xhigh", "high", "off", "medium", "MAX"].map((value) =>
        Preset.effortMaxOf(value === undefined ? {} : { subagentEffortMax: value }),
      ),
    ).toEqual(["max", "max", "xhigh", "high", "off", "off", "off"])
    expect(Preset.effortCeiling("xhigh", { paid: false, once: false })).toBe("xhigh")
    expect(Preset.effortCeiling("off", { paid: false, once: false })).toBeUndefined()
    expect(Preset.effortCeiling("off", { paid: false, once: true })).toBe("max")
    expect(Preset.effortCeiling("max", { paid: true, once: true })).toBeUndefined()
  })

  test("the guidance line: static, only with effort set, never for off or 평소대로", () => {
    const base = { delegation: "on-request" as const, ultra: false, caps: Preset.CAPS, cards: {} }
    expect(Preset.renderGuidance({ ...base, effort: true })?.text).toBe(
      [
        "Session delegation instruction, set by the user for this session. Follow it like AGENTS.md instructions.",
        "Delegation mode: on request. Spawn subagents only when the user or AGENTS.md/skill instructions ask for it. This replaces any earlier delegation mode.",
        "",
        "Reasoning effort: the user lets you choose a subagent's reasoning effort in this session. Append `#<level>` to `model`: `#low` alone keeps the subagent's usual model, `<name>#high` also names one (levels: none, minimal, low, medium, high, xhigh, max, default, inherit). Use a lower effort for simple work; a raise is allowed only within the limit this session allows, and a call over it is declined.",
        "Caps: at most 3 subagents running at once, at most 6 per user message. A call over a cap is declined; continue other work or wait for a running subagent to finish, then retry.",
      ].join("\n"),
    )
    expect(Preset.renderGuidance(base)?.text).not.toContain("Reasoning effort")
    const line = (input: Preset.GuidanceInput) =>
      Preset.renderGuidance(input)
        ?.text.split("\n")
        .find((text) => text.startsWith("Reasoning effort"))
    expect(line({ ...base, effort: true, ultra: true, caps: { concurrent: 8, perMessage: 24, perSession: 200 } })).toBe(
      line({ ...base, effort: true }),
    )
    expect(Preset.renderGuidance({ ...base, delegation: "off", effort: true })?.text).not.toContain("Reasoning effort")
    expect(Preset.renderGuidance({ ...base, delegation: "model", effort: true })).toBeNull()
  })
})

describe("binding (07 §5.1)", () => {
  const binding = {
    presetID: "builtin:codex",
    group: "codex",
    revision: 0,
    appliedAt: 1_790_000_000_000,
    entryHash: null,
  }

  test("round-trips with and without ultra and team; the KV key is per root session", () => {
    expect(roundTrip(Preset.Binding, binding)).toEqual(binding)
    const full = {
      ...binding,
      presetID: SAVED,
      revision: 3,
      entryHash: "sha256:5c1e00",
      ultra: { raiseClaude: true, before: "high" },
      team: {
        teamID: "tm_3f9a0c1b2d4e",
        role: "owner",
        accounts: ["acc_chatgpt01", "acc_claude_slot"],
        pinned: [{ pin: { account: "acc_claude_slot", model: "claude-opus-5-5" } }],
      },
    }
    expect(roundTrip(Preset.Binding, full)).toEqual(full)
    const off = { ...binding, ultra: { before: null } }
    expect(roundTrip(Preset.Binding, off)).toEqual(off)
    expect(() => Schema.decodeUnknownSync(Preset.Binding)({ ...full, team: { ...full.team, role: "area" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Preset.Binding)({ ...binding, presetID: "builtin:" })).toThrow()
    expect(Kv.preset("ses_1")).toBe("sess:ses_1:preset")
  })

  test("the effective preset: the binding's in its group, else the new group's ★, else its 평소대로", () => {
    const decoded = Schema.decodeUnknownSync(Preset.Binding)({ ...binding, presetID: SAVED })
    const star = Preset.ID.make(`pr_${OwnID.ulid(0)}`)
    expect<string>(Preset.effective(decoded, "codex")).toBe(SAVED)
    expect<string>(Preset.effective(decoded, "codex", star)).toBe(SAVED)
    expect<string>(Preset.effective(decoded, "ds")).toBe("builtin:ds")
    expect(Preset.effective(decoded, "ds", star)).toBe(star)
    expect<string>(Preset.effective(undefined, "local:ollama")).toBe("builtin:local:ollama")
    expect(Preset.effective(undefined, "codex", star)).toBe(star)
  })
})

describe("R4: one subscription account per company (07 §5.4, 06 §10.1)", () => {
  const CHATGPT_01 = Account.ID.make("acc_chatgpt01")
  const CHATGPT_02 = Account.ID.make("acc_chatgpt02")
  const CHATGPT_03 = Account.ID.make("acc_chatgpt03")
  const OPENAI_KEY = Account.ID.make("acc_openaikey")
  const DEEPSEEK = Account.ID.make("acc_deepseek")
  const CLAUDE = Account.ID.claudeSlot
  const members: ReadonlyArray<Preset.Member> = [
    { id: CHATGPT_01, kind: "codex", billing: "subscription" },
    { id: CHATGPT_02, kind: "codex", billing: "subscription" },
    { id: CHATGPT_03, kind: "codex", billing: "subscription" },
    { id: OPENAI_KEY, kind: "oai", billing: "metered" },
    { id: DEEPSEEK, kind: "ds", billing: "prepaid" },
    { id: CLAUDE, kind: "claude-sub", billing: "subscription" },
  ]
  const lookup: Preset.Lookup = (id) => members.find((member) => member.id === id)
  const pin = (account: string) => ({ pin: { account, model: "model-x" } })

  /** A preset of `group` whose roles have the given targets (accounts are pinned, `main`/`lighter` are relative). */
  const preset = (group: string, roles: Record<string, ReadonlyArray<string>>, single?: string) =>
    Schema.decodeUnknownSync(Preset.Info)({
      ...Preset.builtin("codex"),
      id: SAVED,
      name: "x",
      group,
      workers: {
        mode: single ? "single" : "by-role",
        ...(single ? { single: pin(single) } : {}),
        roles: Object.fromEntries(
          Object.entries(roles).map(([role, targets]) => [
            role,
            {
              targets: targets.map((target) =>
                target === "main" || target === "lighter" ? { rel: target } : pin(target),
              ),
              effort: "inherit",
            },
          ]),
        ),
      },
    })
  const team = (accounts: ReadonlyArray<string>, pinned: ReadonlyArray<string> = []) =>
    Schema.decodeUnknownSync(Preset.Team)({
      teamID: "tm_3f9a0c1b2d4e",
      role: "main",
      accounts,
      pinned: pinned.map(pin),
    })
  const rejected = (accountID: Account.ID) => ({ ok: false, accountID })

  test("an account's company is its kind's canonical provider; the Claude slot is Anthropic's", () => {
    expect(members.map(Preset.company)).toEqual(["openai", "openai", "openai", "openai", "deepseek", "anthropic"])
    expect(Preset.company({ kind: "anth" })).toBe(Preset.company({ kind: "claude-sub" }))
  })

  test("the four examples of 07 §5.4", () => {
    const twoChatGPT = preset("claude-sub", { explore: [CHATGPT_01], "own-review": [CHATGPT_02] })
    expect(Preset.allowed(twoChatGPT, CLAUDE, lookup)).toEqual(rejected(CHATGPT_02))
    const secondTarget = preset("codex", { "own-review": [CLAUDE, CHATGPT_02] })
    expect(Preset.allowed(secondTarget, CHATGPT_01, lookup)).toEqual(rejected(CHATGPT_02))
    const otherCompany = preset("claude-sub", { "own-review": [CHATGPT_01] })
    expect(Preset.allowed(otherCompany, CLAUDE, lookup)).toEqual({ ok: true })
    const metered = preset("codex", { "own-review": [OPENAI_KEY] })
    expect(Preset.allowed(metered, CHATGPT_01, lookup)).toEqual({ ok: true })
  })

  test("saving (main: null): no subscription of the group's company may be pinned, even the main's own", () => {
    const own = preset("codex", { "own-review": [CHATGPT_01] })
    expect(Preset.allowed(own, CHATGPT_01, lookup)).toEqual({ ok: true })
    expect(Preset.allowed(own, null, lookup)).toEqual(rejected(CHATGPT_01))
    expect(Preset.allowed(preset("claude-sub", { "own-review": [CLAUDE] }), null, lookup)).toEqual(rejected(CLAUDE))
    expect(Preset.allowed(preset("claude-sub", { "own-review": [CHATGPT_01] }), null, lookup)).toEqual({ ok: true })
    const two = preset("claude-sub", { explore: [CHATGPT_01], "own-review": [CHATGPT_02] })
    expect(Preset.allowed(two, null, lookup)).toEqual(rejected(CHATGPT_02))
    expect(Preset.allowed(preset("codex", { "own-review": [OPENAI_KEY, DEEPSEEK] }), null, lookup)).toEqual({
      ok: true,
    })
  })

  test("a metered main keeps every subscription of its company out", () => {
    const sub = preset("oai", { "own-review": [CHATGPT_01] })
    expect(Preset.allowed(sub, OPENAI_KEY, lookup)).toEqual(rejected(CHATGPT_01))
    expect(Preset.allowed(sub, null, lookup)).toEqual(rejected(CHATGPT_01))
    expect(Preset.allowed(preset("oai", { "own-review": [CLAUDE] }), OPENAI_KEY, lookup)).toEqual({ ok: true })
  })

  test("relative, local and removed targets add nothing; inactive single targets still count", () => {
    const relative = preset("codex", { explore: ["lighter"], general: ["main"], "own-quick": ["local:ollama"] })
    expect(Preset.allowed(relative, CHATGPT_01, lookup)).toEqual({ ok: true })
    expect(Preset.allowed(preset("codex", { "own-deep": ["acc_removed"] }), CHATGPT_01, lookup)).toEqual({ ok: true })
    const single = preset("codex", {}, CHATGPT_02)
    const inactive = { ...single, workers: { ...single.workers, mode: "same" as const } }
    expect(Preset.allowed(single, CHATGPT_01, lookup)).toEqual(rejected(CHATGPT_02))
    expect(Preset.allowed(inactive, CHATGPT_01, lookup)).toEqual(rejected(CHATGPT_02))
    expect(Preset.allowed(Preset.builtin("codex"), CHATGPT_01, lookup)).toEqual({ ok: true })
  })

  test("a local group has no company of its own: only one subscription per company", () => {
    const companies = preset("local:ollama", { explore: [CHATGPT_01], "own-review": [CLAUDE] })
    expect(Preset.allowed(companies, null, lookup)).toEqual({ ok: true })
    const two = preset("local:ollama", { explore: [CHATGPT_01], "own-review": [CHATGPT_02] })
    expect(Preset.allowed(two, null, lookup)).toEqual(rejected(CHATGPT_02))
  })

  test("a team: its accounts and pinned targets join S", () => {
    const usual = Preset.builtin("codex")
    expect(Preset.allowed(usual, CHATGPT_01, lookup, team([CHATGPT_03]))).toEqual(rejected(CHATGPT_03))
    expect(Preset.allowed(usual, CHATGPT_01, lookup, team([CHATGPT_01, CLAUDE]))).toEqual({ ok: true })
    expect(Preset.allowed(usual, CHATGPT_01, lookup, team([CHATGPT_01], [CHATGPT_02]))).toEqual(rejected(CHATGPT_02))
    // 06 §10.1: a ChatGPT 01 team may give an area a Claude main, but not a Claude preset pinning ChatGPT 03.
    const area = (target: Account.ID) => preset("claude-sub", { "own-review": [target] })
    expect(Preset.allowed(area(CHATGPT_01), CLAUDE, lookup, team([CHATGPT_01, CLAUDE]))).toEqual({ ok: true })
    expect(Preset.allowed(area(CHATGPT_03), CLAUDE, lookup, team([CHATGPT_01, CLAUDE]))).toEqual(rejected(CHATGPT_03))
  })
})

describe("gate rejection text (07 §5.4)", () => {
  const texts = [
    Preset.rejection({ reason: "model", roles: ["explore", "own-review"] }),
    Preset.rejection({ reason: "budget", roles: ["general"] }),
    Preset.rejection({ reason: "off" }),
  ]

  test("starts with own-preset: and ends by sending the LLM to the user", () => {
    expect(Preset.REJECT_PREFIX).toBe("own-preset:")
    expect(texts[0]).toBe(
      "own-preset: model not in this preset. Allowed roles: explore, own-review. Ask the user if another model is needed.",
    )
    expect(texts.every((text) => text.startsWith(Preset.REJECT_PREFIX))).toBe(true)
    expect(texts.map((text) => text.slice(text.lastIndexOf(". ") + 2))).toEqual([
      "Ask the user if another model is needed.",
      "Ask the user if more budget is needed.",
      "Ask the user if subagents are needed.",
    ])
    expect(Preset.rejection({ reason: "model", roles: [] })).toBe(
      "own-preset: model not in this preset. Ask the user if another model is needed.",
    )
  })

  test("names no provider or model id, account, price or file", () => {
    for (const text of texts) expect(text).not.toMatch(/\/|\$|\d|acc_|own-codex|openai|anthropic|gpt|claude|\.json/i)
  })
})

describe("presets.json (07 §8.1)", () => {
  const file = {
    version: 1,
    groups: {
      codex: { defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" } },
      ds: { defaultModel: { id: "deepseek-flash", source: "user" }, star: SAVED },
    },
  }

  test("round-trips, keeps fields of a later shape and rejects keys that are not groups", () => {
    expect(roundTrip(Preset.File, file)).toEqual(file)
    const later = {
      ...file,
      ultraCaps: "recommended",
      groups: { ...file.groups, codex: { ...file.groups.codex, lighter: { "gpt-6-astra": { model: "gpt-6-luna" } } } },
    }
    expect(roundTrip(Preset.File, later, { keepUnknown: true })).toEqual(later)
    expect(() => Schema.decodeUnknownSync(Preset.File)({ version: 1, groups: { acc_x: {} } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Preset.File)({ version: 1, groups: { codex: { star: "x" } } })).toThrow()
    expect(Preset.empty()).toEqual({ version: 2, groups: {} })
  })

  test("version 1 reads as version 2: exactly 100 per conversation was the default and becomes no cap (SC-1)", () => {
    const stored = (perSession: number | null, id: string = SAVED) =>
      Schema.decodeUnknownSync(Preset.Info)({
        ...Preset.builtin("codex"),
        id,
        name: "많이",
        caps: { concurrent: 4, perMessage: 8, perSession },
      })
    const old = Schema.decodeUnknownSync(Preset.File)({
      version: 1,
      ultraCaps: { concurrent: 5, perMessage: 10, perSession: 100 },
      groups: {
        codex: { star: SAVED, presets: [stored(100), stored(99, "pr_01JB0000000000000000000099")] },
        ds: { defaultModel: { id: "deepseek-flash", source: "user" } },
      },
    })
    const upgraded = Preset.upgrade(old)
    expect(upgraded.version).toBe(2)
    expect(upgraded.groups.codex?.presets?.map((preset) => preset.caps.perSession)).toEqual([null, 99])
    expect<unknown>(upgraded.groups.codex?.star).toBe(SAVED)
    expect(upgraded.groups.ds).toEqual(old.groups.ds)
    // `직접 정하기` ultra numbers were always typed: they stay.
    expect(upgraded.ultraCaps).toEqual({ concurrent: 5, perMessage: 10, perSession: 100 })
    // A version 2 file is the user's own: a 100 there was set on purpose and stays.
    const chosen = { ...upgraded, groups: { codex: { presets: [stored(100)] } } }
    expect(Preset.upgrade(chosen)).toBe(chosen)
    expect(roundTrip(Preset.File, chosen)).toEqual(chosen)
    expect(() => Schema.decodeUnknownSync(Preset.File)({ version: 3, groups: {} })).toThrow()
  })
})

describe("candidates", () => {
  test("only enabled, active models a session starts on; mode entries such as -fast are left out", () => {
    const models = [
      ...CODEX,
      { ...model("gpt-old", { family: "gpt", released: 0 }), status: "deprecated" as const },
      { ...model("gpt-off", { family: "gpt", released: 0 }), enabled: false },
    ]
    expect(Preset.candidates(models).map((item) => item.id)).toEqual([
      "gpt-5.5",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-5.6-sol",
    ])
    expect(Preset.candidates(CODEX)[1]).toEqual({
      id: "gpt-6-astra",
      family: "gpt-astra",
      released: SEP_04,
      price: 10,
      variants: EFFORTS,
    })
  })

  test("a price function replaces the model's own price (free Codex slots priced from the catalog)", () => {
    const free = CODEX.map((item) => ({ ...item, cost: [] }))
    expect(Preset.candidates(free).every((item) => item.price === undefined)).toBe(true)
    expect(
      Preset.candidates(free, (item) => (item.id === "gpt-6-sol" ? 2 : undefined)).map((item) => item.price),
    ).toEqual([undefined, undefined, undefined, 2, undefined])
  })
})

describe("codex auto default (07 §2.2)", () => {
  test("the user's Codex config wins: gpt-6-astra · high", () => {
    expect(codex({ model: "gpt-6-astra", effort: "high", models: META })).toEqual({
      id: "gpt-6-astra",
      variant: "high",
      basis: "codex-config",
    })
  })

  test("without a config, the first Codex metadata priority and that model's default effort", () => {
    expect(codex({ models: META })).toEqual({ id: "gpt-6-astra", variant: "medium", basis: "codex-meta" })
  })

  test("a config model the template lacks falls through; a metadata model the template lacks is skipped", () => {
    const bundled = [
      { slug: "gpt-6.1-sol", priority: 1, defaultEffort: "low" },
      ...META.map((item) => ({ ...item, priority: item.priority + 1 })),
    ]
    expect(codex({ model: "gpt-9", models: bundled })).toEqual({
      id: "gpt-6-astra",
      variant: "medium",
      basis: "codex-meta",
    })
  })

  test("without config and metadata, the newest model of the most expensive family, no effort", () => {
    expect(codex()).toEqual({ id: "gpt-6-astra", basis: "family-price" })
    const withoutAstra = CODEX.filter((item) => item.family !== "gpt-astra")
    expect(codex({}, withoutAstra)).toEqual({ id: "gpt-6-sol", basis: "family-price" })
  })

  // MR8-16: GPT-5.6 Cyber (models.dev, $12.5 input, its own `gpt` family) is priced above every general model and is
  // not in Codex's catalog; the price rule never starts sessions on it, here or with the real template.
  test("a specialised model outside Codex's catalog is never the price rule's pick, however priced", () => {
    const cyber = model("gpt-5.6-cyber", { family: "gpt", released: SEP_22 + DAY, price: 12.5 })
    expect(codex({}, [...CODEX, cyber])).toEqual({ id: "gpt-6-astra", basis: "family-price" })
    expect<unknown>(Preset.defaultModel("siwc", Preset.candidates([cyber, ...CODEX]))).toEqual({
      id: "gpt-6-astra",
      basis: "family-price",
    })
    // Only uncatalogued models: the rule still picks one.
    expect(codex({}, [cyber])).toEqual({ id: "gpt-5.6-cyber", basis: "family-price" })
    expect(CodexModels.catalogued("gpt-6.1-terra-fast")).toBe(true)
    expect(CodexModels.catalogued("gpt-5.6-cyber")).toBe(false)
    expect(CodexModels.catalogued("gpt-5.55")).toBe(false)
  })

  test("the real ChatGPT template's default is a general model, not GPT-5.6 Cyber", async () => {
    type Template = { readonly models: Record<string, Preset.Entry> }
    const [codexTemplate, oai] = (await Promise.all(
      ["codex", "oai"].map((name) =>
        Bun.file(path.join(import.meta.dir, `../../own-accounts/src/slots/templates/${name}.json`)).json(),
      ),
    )) as [Template, Template]
    const openai = new Map(Object.values(oai.models).map((item) => [item.id, Preset.basePrice(item.cost)]))
    const priced = Preset.candidates(Object.values(codexTemplate.models), (item) => openai.get(item.id))
    expect(priced.some((item) => item.id === "gpt-5.6-cyber")).toBe(true)
    const picked = Preset.defaultModel("codex", priced)
    expect(picked?.basis).toBe("family-price")
    expect(CodexModels.catalogued(picked!.id)).toBe(true)
    expect(Preset.defaultModel("siwc", priced)).toEqual(picked)
  })

  test("the GPT-6 Sol/Luna same-day tie no longer picks Luna, the cheapest tier (old rule: newest, then id)", () => {
    const old = Preset.candidates(CODEX).toSorted((a, b) => b.released - a.released || a.id.localeCompare(b.id))[0]
    expect(old?.id).toBe("gpt-6-luna")
    expect(codex()?.id).toBe("gpt-6-astra")
    expect(codex({ models: META })?.id).toBe("gpt-6-astra")
    expect(codex({ model: "gpt-6-astra", effort: "high" })?.id).toBe("gpt-6-astra")
  })

  test("an effort the model does not offer is skipped: client-only values, then the model default, then none", () => {
    expect(codex({ model: "gpt-6-astra", effort: "persistent", models: META })).toMatchObject({ variant: "medium" })
    expect(codex({ model: "gpt-6-astra", effort: "ultra" })).toEqual({ id: "gpt-6-astra", basis: "codex-config" })
    expect(codex({ model: "gpt-6-sol", effort: "xhigh" })).toMatchObject({ id: "gpt-6-sol", variant: "xhigh" })
  })
})

describe("other groups (07 §2.2)", () => {
  const fable = (id: string, released: number, price?: number) => model(id, { family: id, released, price })

  test("claude-sub: the newest, a tie to the higher input price", () => {
    const models = [fable("claude-haiku-5", SEP_22, 1), fable("claude-opus-5-5", SEP_22, 15)]
    expect(auto("claude-sub", models)).toEqual({ id: "claude-opus-5-5", basis: "newest" })
  })

  test("paid API groups: the newest, a tie to the lower input price; an unknown price never wins a tie", () => {
    const models = [
      fable("deepseek-v4-pro", SEP_04, 0.435),
      fable("deepseek-flash", SEP_22, 0.15),
      fable("deepseek-max", SEP_22, 0.9),
      fable("deepseek-new", SEP_22),
    ]
    for (const of of ["ds", "oai", "anth", "xai", "or"] as const)
      expect(auto(of, models)).toEqual({ id: "deepseek-flash", basis: "newest" })
    expect(auto("ds", [fable("deepseek-v4-pro", SEP_04)])?.id).toBe("deepseek-v4-pro")
  })

  test("compat and local groups: the first model; no models, no default", () => {
    const models = [fable("qwen3-coder", 0), fable("llama-4", SEP_22)]
    expect(auto("compat", models)).toEqual({ id: "qwen3-coder", basis: "first" })
    expect(auto("local:ollama", models)).toEqual({ id: "qwen3-coder", basis: "first" })
    expect(auto("codex", [])).toBeUndefined()
  })
})

describe("RPC (07 §8.1, T0 part)", () => {
  const methods = OwnAccounts.Definition.methods

  test("presets.list answers each group's default model, null before the group has one", () => {
    const output = {
      groups: [
        { group: "codex", defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" } },
        { group: "claude-sub", defaultModel: null },
        { group: "ds", defaultModel: { id: "deepseek-chat", source: "user", missing: true } },
      ],
    }
    expect(roundTrip(methods["presets.list"].output, output)).toEqual(output)
    expect(roundTrip(methods["presets.list"].input, {})).toEqual({})
    expect(() => Schema.decodeUnknownSync(methods["presets.list"].input)({ group: "acc_1" })).toThrow()
  })

  test("presets.defaults.set takes a model (user) or null (back to auto) and answers remote_managed remotely", () => {
    const input = methods["presets.defaults.set"].input
    expect(roundTrip(input, { group: "codex", defaultModel: { id: "gpt-6-sol" } })).toEqual({
      group: "codex",
      defaultModel: { id: "gpt-6-sol" },
    })
    expect(roundTrip(input, { group: "codex", defaultModel: null })).toEqual({ group: "codex", defaultModel: null })
    expect(Object.keys(methods["presets.defaults.set"].errors).sort()).toEqual(["internal_error", "remote_managed"])
  })
})

describe("model pool storage (07 §2.1 workers.pool, T4)", () => {
  const card = { name: "GPT-6 Luna", window: 872_000, reasoning: true, image: true, at: 1 }
  const pool = [
    { key: "gpt-6-luna", model: "gpt-6-luna", card },
    { key: "claude-opus-5-5", model: "claude-opus-5-5", account: Account.ID.claudeSlot, effort: "high" },
    { key: "qwen3-32b", model: "qwen3:32b", account: "local:ollama", note: "fast here" },
  ]
  const stored = {
    ...Preset.builtin("codex"),
    id: SAVED,
    name: "모델 묶음",
    workers: { mode: "same", roles: {}, pool },
    delegation: "when-useful",
  }
  const file = { version: 1, groups: { codex: { presets: [stored] } } }

  // The shapes of the build before T4, copied: a rollback reads presets.json with these.
  const OldWorkers = Schema.Struct({
    mode: Schema.Literals(["same", "single", "by-role"]),
    single: optional(Preset.Target),
    roles: keyedRecord(Preset.Role, Preset.RoleEntry),
  })
  const OldInfo = Schema.Struct({ ...Preset.Info.fields, workers: OldWorkers })
  const OldGroupState = Schema.Struct({
    defaultModel: optional(Preset.DefaultModel),
    star: optional(Preset.ID),
    presets: optional(Schema.Array(OldInfo)),
    lighter: optional(Schema.Record(Schema.String, Preset.Lighter)),
    history: optional(Schema.Array(Preset.RepairRecord)),
  })
  const OldFile = Schema.Struct({ ...Preset.File.fields, groups: keyedRecord(Preset.Group, OldGroupState) })

  test("a pool preset is stored with mode same; modeOf reads pool; an empty pool is the stored mode", () => {
    const decoded = Schema.decodeUnknownSync(Preset.File)(file)
    const workers = decoded.groups.codex?.presets?.[0]?.workers
    expect(workers?.mode).toBe("same")
    expect(workers && Preset.modeOf(workers)).toBe("pool")
    expect(Preset.modeOf({ mode: "same", pool: [] })).toBe("same")
    expect(Preset.modeOf({ mode: "by-role", pool: [] })).toBe("by-role")
    expect(Preset.modeOf({ mode: "single" })).toBe("single")
    expect(roundTrip(Preset.File, file)).toEqual(file)
  })

  test("plainWorkers (UC 2026-10-18): 다른 모델 하나로 on 메인과 같게 is 메인과 같은 모델로; other targets stay", () => {
    const main = { rel: "main" } as const
    const lighter = { rel: "lighter" } as const
    expect(Preset.plainWorkers({ mode: "single", single: main, roles: {} })).toEqual({ mode: "same", roles: {} })
    // In another mode the unused `single` on the main goes too; the mode and the rows stay.
    const rows = { explore: { targets: [lighter], effort: "inherit" as const } }
    expect(Preset.plainWorkers({ mode: "by-role", single: main, roles: rows })).toEqual({
      mode: "by-role",
      roles: rows,
    })
    const pooled = Schema.decodeUnknownSync(Preset.Workers)({ mode: "single", single: main, roles: {}, pool })
    expect(Preset.modeOf(Preset.plainWorkers(pooled))).toBe("pool")
    expect(Preset.plainWorkers(pooled).mode).toBe("same")
    const kept = { mode: "single" as const, single: lighter, roles: {} }
    expect(Preset.plainWorkers(kept)).toBe(kept)
    const none = { mode: "single" as const, roles: {} }
    expect(Preset.plainWorkers(none)).toBe(none)
  })

  test("rollback: the pre-pool schema with preserveUnknown keeps pool and poolHistory through a rewrite", () => {
    const withHistory = {
      ...file,
      groups: {
        codex: {
          ...file.groups.codex,
          poolHistory: [{ at: 1, presetID: SAVED, key: "gpt-5-5", from: "gpt-5.5", to: "gpt-6-sol" }],
        },
      },
    }
    const old = Option.getOrThrow(Preserve.decode(OldFile)(withHistory))
    // The old build reads the preset as 모두 메인과 같게.
    expect(old.groups.codex?.presets?.[0]?.workers.mode).toBe("same")
    const rewritten = Preserve.encode(OldFile)(old)
    expect<unknown>(rewritten).toEqual(withHistory)
    expect(Schema.decodeUnknownSync(Preset.File)(rewritten)).toEqual(Schema.decodeUnknownSync(Preset.File)(withHistory))
  })

  test("lenient entries: a long note, a bad key, an unknown card field and a later entry field still decode", () => {
    const loose = [
      { key: "Not A Key!", model: "x", note: "n".repeat(121), card: { name: "X", later: 1 }, later: true },
      { key: "explore", model: "y" },
    ]
    const decoded = Schema.decodeUnknownSync(Preset.Workers)({ mode: "same", roles: {}, pool: loose })
    expect(decoded.pool?.map((item) => item.key)).toEqual(["Not A Key!", "explore"])
    expect(decoded.pool?.[0]?.note?.length).toBe(121)
    const kept = Option.getOrThrow(Preserve.decode(Preset.Workers)({ mode: "same", roles: {}, pool: loose }))
    expect(Preserve.encode(Preset.Workers)(kept)).toEqual({
      mode: "same",
      roles: {},
      pool: loose,
    })
  })

  test("Spot: a place or pool:<key>, in warnings, repairOf, uses and preset_target_unavailable", () => {
    expect(Schema.is(Preset.Spot)("own-review")).toBe(true)
    expect(Schema.is(Preset.Spot)("pool:gpt-6-luna")).toBe(true)
    expect(Schema.is(Preset.Spot)("pool")).toBe(false)
    expect(roundTrip(Preset.Warning, { code: "paid", place: "pool:deepseek-v4-pro" })).toBeDefined()
    expect(roundTrip(Preset.RepairOf, { model: "gpt-5.5", place: "pool:gpt-5.5" })).toBeDefined()
    const use = { kind: "pin", group: "codex", presetID: SAVED, place: "pool:gpt-5.5" }
    expect(roundTrip(Preset.Use, use)).toEqual(use)
    expect(Preset.poolSpot("a")).toBe("pool:a")
    expect(Preset.poolKeyOf("pool:a")).toBe("a")
    expect(Preset.poolKeyOf("single")).toBeUndefined()
  })
})
