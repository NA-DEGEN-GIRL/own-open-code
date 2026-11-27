// 자세히 (07 §7.2): per-role effort and what it sends now (`Preset.effortToVariant` through `Preset.resolve`), the
// ordered target lists as `presets.set` stores them (never a main model or effort, PG4), delegation `안 함` only here,
// caps validation, the preset's own ultra level, the guidance preview (`Preset.renderGuidance` over the service's card
// rule), the lighter-pair table and `짝 바꾸기`, the ★ toggle, copying to another group (R4 judged for that group), the
// repair history and dimmed retirement dates (never a toast), the `focusRole` request and the lazy mount. The panel's
// logic is model.ts (pure); the component itself is checked through its source where only wiring is left. Every
// account and model is fake.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import {
  catalogOf,
  closePresetEditor,
  copyInput,
  defaultItems,
  DELEGATIONS,
  draftOf,
  effortChoices,
  effortLine,
  guidanceOf,
  historyOf,
  levelChoices,
  lighterChoices,
  lighterRows,
  listedTargets,
  mainOf,
  monthDay,
  openPresetEditor,
  poolFacts,
  poolHistoryOf,
  presetEditorRequest,
  presetUltraChoice,
  previewCards,
  PRESET_ULTRA_CHOICES,
  readCaps,
  retirementOf,
  retiringOf,
  stamp,
  starToggle,
  toSave,
  ULTRA_CHOICES,
  ultraCapsOf,
  withAddedTarget,
  withDelegation,
  withEffort,
  withMode,
  withMovedTarget,
  withoutPoolEntry,
  withPoolCards,
  withPoolEffort,
  withPoolEntry,
  withPoolNote,
  withRemovedTarget,
  withTarget,
  type CatalogModel,
} from "./model"
import { presetsText } from "./strings"

const SRC = path.join(import.meta.dir, "..")
const read = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()
/** Source without comments, so spec examples in comments are not taken for code. */
const code = (source: string) => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

// ---- fixtures ----

const CHATGPT_01 = Account.ID.make("acc_chatgpt01")
const CLAUDE = Account.ID.claudeSlot
const DEEPSEEK = Account.ID.make("acc_deepseek")

function account(id: Account.ID, kind: Account.View["kind"], providerID: string): Account.View {
  return {
    id,
    kind,
    label: id.slice(4),
    shortLabel: id.slice(4, 6),
    color: "indigo",
    providerID: Provider.ID.make(providerID),
    billing: kind === "ds" ? "prepaid" : "subscription",
    status: "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: kind === "ds" ? "key" : "oauth" },
  }
}

const ACCOUNTS: ReadonlyArray<Account.View> = [
  account(CHATGPT_01, "codex", "own-codex-aaaa"),
  account(CLAUDE, "claude-sub", "anthropic"),
  account(DEEPSEEK, "ds", "own-ds-bbbb"),
]
const BY_ID = Object.fromEntries(ACCOUNTS.map((item) => [item.id, item]))
const lookup: Preset.Lookup = (id) => BY_ID[id]
const accountOf = (providerID: string) => ACCOUNTS.find((item) => item.providerID === providerID)

function model(
  providerID: string,
  id: string,
  input: { readonly price?: number; readonly variants?: ReadonlyArray<string>; readonly tools?: boolean } = {},
): CatalogModel {
  return {
    id,
    modelID: id,
    providerID,
    name: id.toUpperCase(),
    capabilities: { tools: input.tools ?? true, input: ["text"], output: ["text"] },
    variants: (input.variants ?? []).map((variant) => ({ id: variant })),
    time: { released: 0 },
    cost: input.price === undefined ? [] : [{ input: input.price, output: input.price, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 400_000, output: 128_000 },
  }
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"]
const MODELS: ReadonlyArray<CatalogModel> = [
  model("own-codex-aaaa", "gpt-6-astra", { variants: LEVELS }),
  model("own-codex-aaaa", "gpt-6-luna", { variants: LEVELS }),
  model("own-codex-aaaa", "gpt-6-mini", { variants: LEVELS }),
  model("own-codex-aaaa", "gpt-6-image", { tools: false }),
  // The ChatGPT slot is plan-billed: the API catalog's twins carry the prices (07 §3.4).
  { ...model("openai", "gpt-6-astra", { price: 10 }), enabled: false },
  { ...model("openai", "gpt-6-luna", { price: 1 }), enabled: false },
  { ...model("openai", "gpt-6-mini", { price: 3 }), enabled: false },
  model("anthropic", "claude-opus-5-5", { price: 15, variants: ["low", "high", "max"] }),
  model("own-ds-bbbb", "deepseek-v4-pro", { price: 2, variants: ["low", "high", "max", "none"] }),
  model("ollama", "qwen3"),
]

const CLAUDE_PIN: Preset.Target = { pin: { account: CLAUDE, model: Model.ID.make("claude-opus-5-5") } }
const DS_PIN: Preset.Target = { pin: { account: DEEPSEEK, model: Model.ID.make("deepseek-v4-pro") } }
const LOCAL_PIN: Preset.Target = { pin: { account: "local:ollama", model: Model.ID.make("qwen3") } }
const LIGHTER: Preset.Target = { rel: "lighter" }
const PAIRS: Record<string, Preset.Lighter> = { "gpt-6-astra": { model: Model.ID.make("gpt-6-luna"), source: "auto" } }

const main = (variant?: string) =>
  mainOf({ providerID: "own-codex-aaaa", id: "gpt-6-astra", ...(variant ? { variant } : {}) }, accountOf, MODELS)!
const resolve = (draft: Preset.Draft, variant?: string) =>
  Preset.resolve(draft, main(variant), catalogOf(BY_ID, MODELS), PAIRS)
const byRole = (name = "") => ({ ...withMode(draftOf("codex"), "by-role"), name })
const SAVED = Preset.ID.make("pr_01JB0000000000000000000000")
const OTHER = Preset.ID.make("pr_01JB0000000000000000000001")

// ---- tests ----

describe("per-role effort (07 §2.3)", () => {
  test("a pinned role sends its intent fitted by Preset.effortToVariant: medium → high로 보냄", () => {
    const draft = withEffort(withTarget(byRole(), "explore", DS_PIN), "explore", Model.VariantID.make("medium"))
    const line = effortLine(Model.VariantID.make("medium"), main("high"), resolve(draft, "high").roles.explore)
    const fit = Preset.effortToVariant("medium", ["low", "high", "max", "none"])
    expect<unknown>(line).toEqual({ intent: "medium", level: "high", unplaced: false })
    expect<unknown>(line?.unplaced === false && line.level).toBe(fit.variant)
    expect(
      presetsText("ko", "own.preset.detail.sendsAs", {
        intent: "medium",
        level: "high",
      }),
    ).toBe("medium → high로 보냄")
  })

  test("메인과 같게 takes the main's level as the intent (GPT xhigh → DeepSeek max)", () => {
    const draft = withTarget(byRole(), "own-review", DS_PIN)
    expect<unknown>(effortLine("inherit", main("xhigh"), resolve(draft, "xhigh").roles["own-review"])).toEqual({
      intent: "xhigh",
      level: Preset.effortToVariant("xhigh", ["low", "high", "max"]).variant,
      unplaced: false,
    })
    // Nothing to fit: the main has no level, or the role sends 기본.
    expect(effortLine("inherit", main(), resolve(draft).roles["own-review"])).toBeUndefined()
    expect(effortLine("default", main("high"), resolve(draft, "high").roles["own-review"])).toBeUndefined()
  })

  test("a model without levels sends none and says so; a role without targets has no line", () => {
    const draft = withTarget(byRole(), "explore", LOCAL_PIN)
    expect<unknown>(effortLine("inherit", main("high"), resolve(draft, "high").roles.explore)).toEqual({
      intent: "high",
      unplaced: true,
    })
    expect(presetsText("ko", "own.preset.detail.sendsDefault", { intent: "high" })).toBe(
      "high → 맞는 단계가 없어 기본으로 보냄",
    )
    expect(effortLine("inherit", main("high"), resolve(draft, "high").roles.general)).toBeUndefined()
  })

  test("choices: the whole scale for a relative target; a pinned model's own levels, the missing ones dimmed", () => {
    const values = (choices: ReturnType<typeof effortChoices>): unknown => choices?.map((item) => item.value)
    const scale = ["inherit", "default", ...LEVELS]
    expect(values(effortChoices(undefined, undefined))).toEqual(scale)
    expect(values(effortChoices(LIGHTER, undefined))).toEqual(scale)
    expect(effortChoices(LIGHTER, undefined)?.every((item) => item.available)).toBe(true)
    const pinned = effortChoices(DS_PIN, ["low", "high", "max", "none"])
    // Unknown names are offered by name after the scale.
    expect(values(pinned)).toEqual([...scale, "none"])
    expect<unknown>(pinned?.filter((item) => !item.available).map((item) => item.value)).toEqual(["medium", "xhigh"])
    // A pinned model without levels shows no effort; one the catalog lacks gets the whole scale.
    expect(effortChoices(LOCAL_PIN, [])).toBeUndefined()
    expect(values(effortChoices(DS_PIN, undefined))).toEqual(scale)
  })

  test("a level on a role without a row gives it 메인과 같게 with that level; back to 메인과 같게 removes it", () => {
    const draft = byRole()
    expect(withEffort(draft, "general", "inherit")).toBe(draft)
    const high = withEffort(draft, "general", Model.VariantID.make("high"))
    expect<unknown>(high.workers.roles.general).toEqual({ targets: [{ rel: "main" }], effort: "high" })
    expect(listedTargets(high.workers.roles.general)).toEqual([])
    expect(withEffort(high, "general", "inherit").workers.roles.general).toBeUndefined()
    // A row with targets keeps them.
    const pinned = withEffort(withTarget(draft, "explore", DS_PIN), "explore", "default")
    expect(pinned.workers.roles.explore).toEqual({ targets: [DS_PIN], effort: "default" })
  })
})

describe("ordered targets (07 §7.2, 1순위 2순위 …, then 메인과 같게)", () => {
  test("add, move and remove give the order presets.set stores; the payload never carries a main or its effort", () => {
    const added = [LIGHTER, DS_PIN].reduce(
      (draft, target) => withAddedTarget(draft, "own-review", target),
      withTarget(byRole("리뷰 셋"), "own-review", CLAUDE_PIN),
    )
    expect(added.workers.roles["own-review"]?.targets).toEqual([CLAUDE_PIN, LIGHTER, DS_PIN])
    const moved = withMovedTarget(added, "own-review", 2, -1)
    expect(moved.workers.roles["own-review"]?.targets).toEqual([CLAUDE_PIN, DS_PIN, LIGHTER])
    expect(withMovedTarget(moved, "own-review", 0, -1)).toBe(moved)
    expect(withMovedTarget(moved, "own-review", 2, 1)).toBe(moved)
    const removed = withRemovedTarget(moved, "own-review", 0)
    const save = toSave({ ...removed, id: SAVED })
    expect(save.workers.roles["own-review"]).toEqual({ targets: [DS_PIN, LIGHTER], effort: "inherit" })
    expect(Object.keys(save).toSorted()).toEqual(["caps", "delegation", "group", "id", "name", "ultraCaps", "workers"])
    // The main the preview resolved against (07 §7.1) is never part of a preset (U1, PG4).
    const resolution = resolve(removed, "high")
    expect(resolution.roles["own-review"]?.use.id).toBe(Model.ID.make("deepseek-v4-pro"))
    expect(JSON.stringify(save)).not.toContain("gpt-6-astra")
    expect(JSON.stringify(save)).not.toMatch(/"variant"|"main"\s*:|"model"\s*:\s*\{/)
  })

  test("adding 메인과 같게 or a listed target changes nothing; an effort-only row takes the first target", () => {
    const draft = withTarget(byRole(), "explore", DS_PIN)
    expect(withAddedTarget(draft, "explore", { rel: "main" })).toBe(draft)
    expect(withAddedTarget(draft, "explore", DS_PIN)).toBe(draft)
    const level = withEffort(byRole(), "general", Model.VariantID.make("low"))
    expect<unknown>(withAddedTarget(level, "general", LIGHTER).workers.roles.general).toEqual({
      targets: [LIGHTER],
      effort: "low",
    })
  })

  test("removing the last target runs the role like the main (its own level kept on 메인과 같게)", () => {
    const draft = withTarget(byRole(), "explore", DS_PIN)
    expect(withRemovedTarget(draft, "explore", 0).workers.roles.explore).toBeUndefined()
    const level = withEffort(draft, "explore", Model.VariantID.make("max"))
    expect<unknown>(withRemovedTarget(level, "explore", 0).workers.roles.explore).toEqual({
      targets: [{ rel: "main" }],
      effort: "max",
    })
  })
})

describe("delegation 안 함, caps and the preset's ultra level (07 §2.5, §2.6)", () => {
  test("안 함 is set in 자세히 only: the simple editor's choices do not offer it", async () => {
    expect(DELEGATIONS).not.toContain("off")
    expect(code(await read("details.tsx"))).toMatch(/withDelegation\(\s*props\.draft,\s*[^)]*\?\s*"off"\s*:\s*"model"/)
    expect(withDelegation(byRole(), "off").delegation).toBe("off")
  })

  test("caps: whole numbers of 1 or more, at once and per message never above per conversation", () => {
    expect(readCaps({ concurrent: "4", perMessage: "10", perSession: "80" })).toEqual({
      concurrent: 4,
      perMessage: 10,
      perSession: 80,
    })
    expect(readCaps({ concurrent: "0", perMessage: "10", perSession: "80" })).toBe("format")
    expect(readCaps({ concurrent: "4", perMessage: "", perSession: "80" })).toBe("format")
    expect(readCaps({ concurrent: "1.5", perMessage: "10", perSession: "80" })).toBe("format")
    expect(readCaps({ concurrent: "4", perMessage: "90", perSession: "80" })).toBe("order")
    expect(readCaps({ concurrent: "81", perMessage: "10", perSession: "80" })).toBe("order")
    expect(readCaps({ concurrent: "80", perMessage: "80", perSession: "80" })).toEqual({
      concurrent: 80,
      perMessage: 80,
      perSession: 80,
    })
    expect(presetsText("ko", "own.preset.detail.capsInvalid")).toContain("대화당 상한")
    // No conversation cap (the default, 제한 없음): nothing to be above.
    expect(readCaps({ concurrent: "40", perMessage: "90", perSession: null })).toEqual({
      concurrent: 40,
      perMessage: 90,
      perSession: null,
    })
    expect(readCaps({ concurrent: "4", perMessage: "10", perSession: "" })).toBe("format")
  })

  test("ultra: the global level (null), 아껴서 / 추천 / 크게, or the preset's own numbers, which win when ultra is on", () => {
    expect(PRESET_ULTRA_CHOICES).toEqual(["global", ...ULTRA_CHOICES])
    expect(presetUltraChoice(null)).toBe("global")
    expect(presetUltraChoice("save")).toBe("save")
    expect(presetUltraChoice({ concurrent: 5, perMessage: 10, perSession: 50 })).toBe("custom")
    const custom = { concurrent: 5, perMessage: 10, perSession: 50 }
    expect(ultraCapsOf("global", custom)).toBeNull()
    expect(ultraCapsOf("large", custom)).toBe("large")
    expect(ultraCapsOf("custom", custom)).toEqual(custom)
    // The preset's level wins over the global one (07 §2.6); the caps are the larger of the preset's and the level's.
    const draft = { ...byRole(), ultraCaps: ultraCapsOf("large", custom) }
    expect(Preset.caps(draft, true, "save")).toEqual(Preset.levelCaps("large"))
    expect(Preset.caps({ ...draft, ultraCaps: null }, true, "save")).toEqual({
      concurrent: 3,
      perMessage: 12,
      perSession: null,
    })
  })
})

describe("guidance preview (07 §3.3)", () => {
  const cards = (draft: Preset.Draft, variant = "high") =>
    previewCards({
      workers: draft.workers,
      main: main(variant),
      resolution: resolve(draft, variant),
      accounts: BY_ID,
      models: MODELS,
    })

  test("equals Preset.renderGuidance over the service's cards: a stronger Claude review, a lighter explore", () => {
    const draft = withDelegation(
      withTarget(withTarget(byRole(), "own-review", CLAUDE_PIN), "explore", LIGHTER),
      "when-useful",
    )
    const roles = cards(draft)
    expect(roles).toEqual({
      explore: { relation: "lighter", runs: "main" },
      "own-review": { relation: "stronger", runs: "subscription", company: "anthropic" },
    })
    const guidance = guidanceOf(draft, roles)
    expect(guidance).toEqual(
      Preset.renderGuidance({
        delegation: "when-useful",
        ultra: false,
        caps: Preset.caps(draft, false),
        cards: roles,
        effort: true,
      }),
    )
    expect(guidance?.text).toContain(
      "- own-review: a model from another company (Anthropic) on the user's subscription, at least as strong as you.",
    )
    expect(guidance?.text).toContain("- explore: a lighter, faster model from your own provider on the same account.")
  })

  test("a cheaper paid pin is lighter, an unpriced local one too; the pair of the main itself is the main's card", () => {
    const draft = withTarget(withTarget(byRole(), "own-quick", DS_PIN), "own-deep", LOCAL_PIN)
    expect(cards(draft)).toEqual({
      "own-quick": { relation: "lighter", runs: "paid", company: "deepseek" },
      "own-deep": { relation: "lighter", runs: "local" },
    })
    const none = previewCards({
      workers: withTarget(byRole(), "explore", LIGHTER).workers,
      main: main("high"),
      resolution: Preset.resolve(withTarget(byRole(), "explore", LIGHTER), main("high"), catalogOf(BY_ID, MODELS), {
        "gpt-6-astra": { model: Model.ID.make("gpt-6-astra"), source: "none" },
      }),
      accounts: BY_ID,
      models: MODELS,
    })
    expect(none).toEqual({ explore: Preset.MAIN_CARD })
  })

  test("like 평소대로 it adds nothing; 안 함 adds the off sentence; one place for all lists no role cards", () => {
    expect(guidanceOf(draftOf("codex"), {})).toBeNull()
    expect(guidanceOf(withDelegation(draftOf("codex"), "off"), {})?.text).toContain("Delegation mode: off.")
    const single = {
      ...withMode(draftOf("codex"), "single"),
      workers: { mode: "single" as const, single: CLAUDE_PIN, roles: {} },
    }
    const text = guidanceOf(withDelegation(single, "active"), cards(single))?.text ?? ""
    expect(text).toContain("Delegation mode: active.")
    expect(text).not.toContain("Subagent roles.")
  })
})

describe("대화에서 하위 에이전트 강도 올리기 (07 §2.3)", () => {
  const stored: Preset.Info = {
    ...Preset.builtin("codex"),
    id: Preset.ID.create(),
    name: "강도",
    subagentEffortMax: "high",
  }

  test("a stored ceiling comes back in the draft and goes out with the save; absent stays absent", () => {
    expect(draftOf("codex", stored).subagentEffortMax).toBe("high")
    expect(toSave(draftOf("codex", stored)).subagentEffortMax).toBe("high")
    expect("subagentEffortMax" in toSave(draftOf("codex"))).toBe(false)
    // A value a later build stored raises nothing here (fail closed, `Preset.effortMaxOf`).
    expect(draftOf("codex", { ...stored, subagentEffortMax: "medium" }).subagentEffortMax).toBe("off")
  })

  test("the guidance preview carries the effort line unless the preset never raises; 평소대로 still adds none", () => {
    const draft = withDelegation(draftOf("codex"), "when-useful")
    expect(guidanceOf(draft, {})?.text).toContain("Reasoning effort: the user lets you choose")
    expect(guidanceOf({ ...draft, subagentEffortMax: "off" }, {})?.text).not.toContain("Reasoning effort")
    expect(guidanceOf(draftOf("codex"), {})).toBeNull()
  })

  test("four choices in 자세히, written to the draft as picked", async () => {
    expect(Preset.EffortMax.literals.map((item) => presetsText("ko", `own.preset.detail.effortMax.${item}`))).toEqual([
      "max까지 허용(기본)",
      "xhigh까지",
      "high까지",
      "올리지 않음",
    ])
    expect(presetsText("ko", "own.preset.detail.effortMax")).toBe("대화에서 하위 에이전트 강도 올리기")
    expect(code(await read("details.tsx"))).toMatch(
      /onChange=\{\(item\) => props\.update\(\{ \.\.\.props\.draft, subagentEffortMax: item \}\)\}/,
    )
  })
})

describe("lighter pairs, ★ and copying (07 §4.2, §7.2)", () => {
  test("the table: stored rows with 없어짐 kept, the preview's main first while it has no pair", () => {
    const stored: Record<string, Preset.Lighter> = {
      "gpt-6-astra": { model: Model.ID.make("gpt-6-luna"), source: "auto" },
      "gpt-6-sol": { model: Model.ID.make("gpt-6-nano"), source: "user", missing: true },
    }
    expect(lighterRows(stored, "gpt-6-astra")).toEqual([
      { main: "gpt-6-astra", pair: stored["gpt-6-astra"] },
      { main: "gpt-6-sol", pair: stored["gpt-6-sol"] },
    ])
    expect(lighterRows(stored, "gpt-6-mini").map((row) => row.main)).toEqual(["gpt-6-mini", "gpt-6-astra", "gpt-6-sol"])
    expect(lighterRows(undefined, undefined)).toEqual([])
    expect(presetsText("ko", "own.preset.detail.lighterGone")).toBe("없어짐")
    expect(presetsText("ko", "own.preset.detail.lighterRow", { main: "A", model: "B" })).toBe("A → B")
  })

  test("짝 바꾸기 offers the main account's other models with tools, cheapest first, and writes presets.defaults.set{lighter}", async () => {
    expect(lighterChoices(MODELS, "own-codex-aaaa", "gpt-6-astra").map((item) => item.id)).toEqual([
      "gpt-6-luna",
      "gpt-6-mini",
    ])
    expect(code(await read("details.tsx"))).toMatch(
      /call\("presets\.defaults\.set",\s*\{\s*group: group\(\),\s*lighter: \{ mainModelID: Model\.ID\.make\(mainModelID\), model: Model\.ID\.make\(choice\(\)\) \}/,
    )
  })

  test("★ toggles between this preset and the group's 평소대로", async () => {
    expect(starToggle("codex", SAVED, Preset.builtinID("codex"))).toBe(SAVED)
    expect(starToggle("codex", SAVED, OTHER)).toBe(SAVED)
    expect(starToggle("codex", SAVED, SAVED)).toBe(Preset.builtinID("codex"))
    expect(code(await read("details.tsx"))).toMatch(/star: starToggle\(group\(\), id, star\(\)\)/)
  })

  test("a copy is a new preset of the other group; R4 is judged for that group and its error is shown", async () => {
    const draft = { ...withTarget(byRole("Claude 리뷰"), "own-review", CLAUDE_PIN), id: SAVED }
    const copy = copyInput(draft, "claude-sub")
    expect(copy).toEqual({
      name: "Claude 리뷰",
      group: "claude-sub",
      workers: draft.workers,
      delegation: draft.delegation,
      caps: draft.caps,
      ultraCaps: null,
    })
    expect(Preset.allowed(copyInput(draft, "ds"), null, lookup).ok).toBe(true)
    // A Claude preset cannot pin a Claude subscription: the service answers same_company_subscription{accountID}.
    expect(Preset.allowed(copy, null, lookup)).toEqual({ ok: false, accountID: CLAUDE })
    const details = code(await read("details.tsx"))
    expect(details).toMatch(/call\("presets\.set", \{ preset: copyInput\(props\.draft, to\) \}\)/)
    expect(details).toMatch(/copyStatus\.error\(props\.errorText\(error\)\)/)
    const editor = code(await read("editor.tsx"))
    expect(editor).toContain("errorText={saveError}")
    expect(editor).toContain('type === "same_company_subscription"')
  })
})

describe("repair history and retirement dates (07 §4.3, §7.2)", () => {
  const at = (month: number, day: number, hour = 0, minute = 0) =>
    new Date(2026, month - 1, day, hour, minute).getTime()
  const record = (presetID: Preset.ID, when: number, from: string): Preset.RepairRecord => ({
    at: when,
    presetID,
    place: "own-review",
    from: Model.ID.make(from),
    to: CLAUDE_PIN,
  })
  const view: Preset.GroupView = {
    group: "codex",
    defaultModel: null,
    history: [
      record(SAVED, at(10, 1), "gpt-5.4"),
      record(OTHER, at(10, 2), "gpt-5.4"),
      record(SAVED, at(10, 14, 9), "gpt-5.5"),
    ],
    retirements: { "claude-opus-5-5": at(10, 14), "deepseek-v4-pro": at(11, 2) },
  }

  test("this preset's repairs, newest first, with `10-14 09:00`; a preset not saved yet has none", () => {
    expect(historyOf(view, SAVED).map((item) => item.from)).toEqual([
      Model.ID.make("gpt-5.5"),
      Model.ID.make("gpt-5.4"),
    ])
    expect(historyOf(view, undefined)).toEqual([])
    expect(historyOf(undefined, SAVED)).toEqual([])
    expect(stamp(at(10, 14, 9))).toBe("10-14 09:00")
    expect(presetsText("ko", "own.preset.repair.record", { role: "리뷰", from: "GPT-5.5", to: "GPT-5.6 SOL" })).toBe(
      "리뷰: GPT-5.5 없어짐 → GPT-5.6 SOL로 고침",
    )
  })

  test("retirement dates: beside a pinned target only, each model once, soonest first", () => {
    expect(retirementOf(view, CLAUDE_PIN)).toBe(at(10, 14))
    expect(retirementOf(view, LIGHTER)).toBeUndefined()
    expect(retirementOf(view, LOCAL_PIN)).toBeUndefined()
    const draft = withTarget(
      withAddedTarget(withTarget(byRole(), "own-review", DS_PIN), "own-review", CLAUDE_PIN),
      "explore",
      CLAUDE_PIN,
    )
    expect(retiringOf(view, draft)).toEqual([
      { target: CLAUDE_PIN, at: at(10, 14) },
      { target: DS_PIN, at: at(11, 2) },
    ])
    expect(monthDay(at(10, 14))).toBe("10-14")
    expect(presetsText("ko", "own.preset.retirement", { date: "10-14" })).toBe("10-14 은퇴 예정(Codex)")
  })

  test("a retirement date is a dimmed label, never a toast or a successor (U3)", async () => {
    for (const file of ["details.tsx", "editor.tsx"]) {
      const source = code(await read(file))
      const toasts = [...source.matchAll(/showToast\(\{\s*message:\s*text\("([^"]+)"/g)].map((match) => match[1])
      expect(toasts.every((key) => key === "own.preset.copyToGroup.done" || key === "own.preset.editor.saved")).toBe(
        true,
      )
      expect(source).toMatch(/class="text-\[12px\] text-own-faint" data-testid="preset-retirement"/)
      expect(source).not.toContain("successor")
    }
  })
})

describe("a model pool in 자세히 (07 §7.2 모델 묶음)", () => {
  const card = (name: string): Preset.PoolCard => ({ name, window: 400_000, reasoning: true, at: Date.UTC(2026, 9, 9) })
  const OFFER = Preset.poolOffer([
    {
      runs: "main",
      company: "openai",
      models: [
        { id: "gpt-6-astra", released: 0, price: 10, card: card("GPT-6 Astra") },
        { id: "gpt-6-luna", released: 0, price: 1, card: card("GPT-6 Luna") },
      ],
    },
    {
      runs: "subscription",
      account: CLAUDE,
      company: "anthropic",
      models: [{ id: "claude-opus-5-5", released: 0, price: 15, card: card("Claude Opus 5.5") }],
    },
    {
      runs: "paid",
      account: DEEPSEEK,
      company: "deepseek",
      models: [{ id: "deepseek-v4-pro", released: 0, price: 2, card: card("DeepSeek V4 Pro") }],
    },
  ])
  const pooled = (name = "") =>
    OFFER.candidates
      .filter((item) => item.model !== "gpt-6-astra")
      .reduce(withPoolEntry, { ...withMode(draftOf("codex"), "pool"), name })

  test("each entry's effort: 메인과 같게 first (none stored), the model's own levels, what it sends now", () => {
    const draft = withPoolEffort(pooled(), "deepseek-v4-pro", Model.VariantID.make("medium"))
    expect(draft.workers.pool?.find((entry) => entry.key === "deepseek-v4-pro")?.effort).toBe(
      Model.VariantID.make("medium"),
    )
    expect(withPoolEffort(draft, "deepseek-v4-pro", "inherit").workers.pool?.[2]).not.toHaveProperty("effort")
    const values = (choices: ReturnType<typeof levelChoices>): unknown => choices?.map((item) => item.value)
    expect(values(levelChoices(["low", "high", "max", "none"]))).toEqual(["inherit", "default", ...LEVELS, "none"])
    expect(values(levelChoices(undefined))).toEqual(["inherit", "default", ...LEVELS])
    expect(levelChoices([])).toBeUndefined()
    const resolution = resolve(draft, "high")
    const entry = resolution.pool?.entries.find((item) => item.key === "deepseek-v4-pro")
    expect<unknown>(effortLine(Model.VariantID.make("medium"), main("high"), entry && { targets: [entry] })).toEqual({
      intent: "medium",
      level: Preset.effortToVariant("medium", ["low", "high", "max", "none"]).variant,
      unplaced: false,
    })
  })

  test("a one-line note (at most 120 characters, a blank one stores none) and 빼기", async () => {
    const noted = withPoolNote(pooled(), "gpt-6-luna", "탐색은 이것으로")
    expect(noted.workers.pool?.[0]?.note).toBe("탐색은 이것으로")
    expect(withPoolNote(noted, "gpt-6-luna", "  ").workers.pool?.[0]).not.toHaveProperty("note")
    expect(Preset.NOTE_MAX).toBe(120)
    expect(code(await read("details.tsx"))).toContain("maxLength={Preset.NOTE_MAX}")
    const removed = withoutPoolEntry(noted, "gpt-6-luna")
    expect(removed.workers.pool?.map((entry) => entry.key)).toEqual(["claude-opus-5-5", "deepseek-v4-pro"])
  })

  test("카드 새로 고치기 sends the stored preset with refreshCards and takes the frozen cards by key and target", async () => {
    const fresh = OFFER.candidates.map((item) => ({ ...item, card: { ...item.card, at: Date.UTC(2026, 10, 1) } }))
    const draft = pooled()
    const refreshed = withPoolCards(draft, [
      ...fresh.filter((item) => item.model !== "gpt-6-astra"),
      { key: "claude-opus-5-5", model: Model.ID.make("claude-opus-5-5"), card: { name: "other target" } },
    ])
    expect(refreshed.workers.pool?.map((entry) => entry.card?.at)).toEqual([
      Date.UTC(2026, 10, 1),
      Date.UTC(2026, 10, 1),
      Date.UTC(2026, 10, 1),
    ])
    expect(withPoolCards(draftOf("codex"), [])).toEqual(draftOf("codex"))
    expect(code(await read("details.tsx"))).toMatch(
      /call\("presets\.set", \{ preset: toSave\(draftOf\(preset\.group, preset\)\), refreshCards: true \}\)/,
    )
  })

  test("the guidance and default-rule previews: the candidates' facts, the session's when opened from one", () => {
    const draft = withDelegation(pooled(), "when-useful")
    const facts = poolFacts({ pool: draft.workers.pool!, candidates: OFFER.candidates, main: main("high") })
    const guidance = guidanceOf(draft, {}, Preset.poolGuidance(facts.entries, facts.main))
    expect(guidance).toEqual(
      Preset.renderGuidance({
        delegation: "when-useful",
        ultra: false,
        caps: Preset.caps(draft, false),
        cards: {},
        pool: Preset.poolGuidance(facts.entries, facts.main),
        effort: true,
      }),
    )
    expect(guidance?.text).toContain(
      "- deepseek-v4-pro: DeepSeek V4 Pro, DeepSeek, on a pay-per-use API key: it costs the user money.",
    )
    expect(guidance?.text).toContain(
      "Compared with you: lighter: gpt-6-luna, deepseek-v4-pro; stronger: claude-opus-5-5.",
    )
    expect(defaultItems(Preset.poolGuidance(facts.entries, facts.main).defaults)).toEqual([
      { key: "gpt-6-luna", roles: ["explore", "own-quick"] },
      { key: "claude-opus-5-5", roles: ["own-review", "own-deep"] },
      { key: undefined, roles: ["general"] },
    ])
    // Opened from a session: its `Resolution.pool` facts decide (here Claude is cheaper than the main there).
    const session: Preset.PoolResolution = {
      main: { runs: "main", company: "openai", price: 10, local: false },
      entries: [{ key: "claude-opus-5-5", runs: "subscription", company: "anthropic", price: 5 }],
    }
    const served = poolFacts({ pool: draft.workers.pool!, candidates: OFFER.candidates, session, main: main("high") })
    expect(Preset.poolGuidance(served.entries, served.main).relation["claude-opus-5-5"]).toBe("lighter")
    expect(presetsText("ko", "own.preset.pool.defaults", { list: "탐색·빠른 일 → GPT-6 Luna" })).toBe(
      "모델을 고르지 않으면: 탐색·빠른 일 → GPT-6 Luna",
    )
  })

  test("the pool's repair history, newest first; the role rows and their order are hidden; no stale-catalog hint", async () => {
    const view: Preset.GroupView = {
      group: "codex",
      defaultModel: null,
      poolHistory: [
        { at: 1, presetID: SAVED, key: "gpt-5-5", from: Model.ID.make("gpt-5.5"), to: "gpt-6-luna" },
        { at: 2, presetID: OTHER, key: "x", from: Model.ID.make("x") },
        { at: 3, presetID: SAVED, key: "claude-opus-4-5", from: Model.ID.make("claude-opus-4-5") },
      ],
    }
    expect(poolHistoryOf(view, SAVED).map((record) => record.at)).toEqual([3, 1])
    expect(poolHistoryOf(view, undefined)).toEqual([])
    expect(
      presetsText("ko", "own.preset.pool.historyRecord", { key: "gpt-5-5", from: "GPT-5.5", to: "GPT-6 Luna" }),
    ).toBe("모델 묶음 gpt-5-5: GPT-5.5 없어짐 → GPT-6 Luna로 고침")
    const details = code(await read("details.tsx"))
    expect(details).toContain('<Show when={draftMode(props.draft) === "by-role"}>')
    expect(details).toContain("<PoolEntries />")
    expect(details).toContain("poolHistoryOf(view(), props.draft.id)")
    expect(details).not.toMatch(/stale|카탈로그와 다름/)
    expect(details).toContain("props.focusRole === Preset.poolSpot(key)")
  })
})

describe("focusRole and the 자세히 mount (07 §7.2)", () => {
  test("openPresetEditor carries focusRole (a repair notice's 직접 고르기, the team view's 고치기)", () => {
    openPresetEditor({ group: "codex", presetID: SAVED, focusRole: "own-review" })
    expect(presetEditorRequest()).toEqual({ group: "codex", presetID: SAVED, focusRole: "own-review" })
    openPresetEditor({ group: "codex", presetID: SAVED, focusRole: "single" })
    expect(presetEditorRequest()?.focusRole).toBe("single")
    closePresetEditor()
    expect(presetEditorRequest()).toBeUndefined()
  })

  test("editor.tsx registers 자세히 as a lazy chunk; nothing imports details statically", async () => {
    const editor = code(await read("editor.tsx"))
    expect(editor).toContain('registerPresetDetail(lazy(() => import("./details")))')
    expect(editor).toMatch(/focusRole=\{focus\}/)
    const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC)]
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !/\.test\.tsx?$/.test(file))
    const offenders = await Promise.all(
      files.map(async (file) => {
        const local = file.startsWith("presets/") ? "|\\./details" : ""
        const pattern = new RegExp(String.raw`^import[^;]*from\s+["'](@/presets/details${local})["']`, "m")
        return pattern.test(await Bun.file(path.join(SRC, file)).text()) ? [file] : []
      }),
    )
    expect(offenders.flat()).toEqual([])
  })

  test("no model id, window or price is written in the editor, its pool checklist or 자세히 (07 §3.5)", async () => {
    for (const file of ["details.tsx", "editor.tsx", "pool-list.tsx"]) {
      const source = code(await read(file))
      expect(source).not.toMatch(/(gpt|claude|deepseek|qwen|gemini|llama|grok|mistral|opus|sonnet|haiku)[-\s]?\d/i)
      expect(source).not.toMatch(/\b\d{3}[_,]?000\b|\b\d{3}k\b/i)
    }
  })

  test("PG4: editing and 자세히 call presets.* only, never a switch of the main's model or effort", async () => {
    const methods = async (file: string) =>
      [...code(await read(file)).matchAll(/\.call\(\s*"([^"]+)"/g)].map((match) => match[1]).toSorted()
    // `presets.set`: a copy to another group, and `카드 새로 고치기` of the stored pool.
    expect(await methods("details.tsx")).toEqual([
      "presets.defaults.set",
      "presets.defaults.set",
      "presets.set",
      "presets.set",
    ])
    expect(await methods("editor.tsx")).toEqual(["presets.set", "presets.suggest"])
  })
})
