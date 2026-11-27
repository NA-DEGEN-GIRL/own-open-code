// Presets in own-web (07 §7.1, §7.3, §8.1): the OwnStore presets state over a fake own.accounts transport and the real
// event bus, the editor's draft and its two questions, the live resolution line (the same `Preset.resolve` the service
// runs), the target picker's sections (PG2: same-company subscriptions never listed; PG11: paid accounts only behind
// the paid row, with their budget), the open-editor request, and the strings. Every account, login and model is fake.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account, type Limit } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import {
  budgetSpent,
  catalogOf,
  clashes,
  closePresetEditor,
  copyLines,
  defaultItems,
  draftMode,
  draftOf,
  guidanceOf,
  lighterFor,
  mainOf,
  openPresetEditor,
  parseBudget,
  pickerSections,
  pinnables,
  poolAccountOf,
  poolBand,
  poolFacts,
  poolRuns,
  poolSections,
  presetEditorRequest,
  problems,
  provenance,
  resolutionLine,
  shownRoles,
  toSave,
  withDelegation,
  withMode,
  withoutPoolEntry,
  withPoolAccount,
  withPoolEntry,
  withPrefill,
  withRecommended,
  withStarter,
  withTarget,
  withoutRole,
  WORKER_MODES,
  type CatalogModel,
} from "./model"
import { pinnedAccounts, usedTargets } from "./session-view"
import { presetsEn, presetsKo, presetsText, type PresetsKey } from "./strings"

const tick = () => new Promise((resolve) => setTimeout(resolve, 60))

// ---- fixtures ----

const LOGIN_01 = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
const LOGIN_02 = "sha256:2222222222222222222222222222222222222222222222222222222222222222"

const CHATGPT_01 = Account.ID.make("acc_chatgpt01")
const CHATGPT_02 = Account.ID.make("acc_chatgpt02")
const SIWC_01 = Account.ID.make("acc_siwc01")
const CLAUDE = Account.ID.claudeSlot
const OPENAI_KEY = Account.ID.make("acc_openaikey")
const DEEPSEEK = Account.ID.make("acc_deepseek")
const RETIRED = Account.ID.make("acc_retired")

function account(
  id: Account.ID,
  kind: Account.View["kind"],
  providerID: string,
  extra: Partial<Account.View> = {},
): Account.View {
  return {
    id,
    kind,
    label: id.slice(4),
    shortLabel: id.slice(4, 6),
    color: "indigo",
    providerID: Provider.ID.make(providerID),
    billing: kind === "oai" || kind === "compat" ? "metered" : kind === "ds" ? "prepaid" : "subscription",
    status: "ready",
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: kind === "oai" || kind === "ds" ? "key" : "oauth" },
    ...extra,
  }
}

// Identities as `accounts.list` carries them (own-accounts `Views.account`): never the guard fingerprint; a codex
// account's login is its fingerprint, a siwc account's the login it recorded at sign-in (07 §5.4 R4).
const ACCOUNTS: ReadonlyArray<Account.View> = [
  account(CHATGPT_01, "codex", "own-codex-aaaa", { identity: { login: LOGIN_01 } }),
  account(CHATGPT_02, "codex", "own-codex-bbbb", { identity: { login: LOGIN_02 } }),
  // Sign in with ChatGPT on ChatGPT 01's login: the same subscription, still never a pinned target of a ChatGPT preset.
  account(SIWC_01, "siwc", "own-siwc-cccc", { identity: { login: LOGIN_01 } }),
  account(CLAUDE, "claude-sub", "anthropic"),
  account(OPENAI_KEY, "oai", "own-oai-dddd", { budget: { monthlyUSD: 20 } }),
  account(DEEPSEEK, "ds", "own-ds-eeee"),
  account(RETIRED, "anth", "own-anth-ffff", { status: "retired" }),
]
const BY_ID = Object.fromEntries(ACCOUNTS.map((item) => [item.id, item]))
const lookup: Preset.Lookup = (id) => BY_ID[id]
const accountOf = (providerID: string) => ACCOUNTS.find((item) => item.providerID === providerID)

const DAY = 86_400_000
function model(
  providerID: string,
  id: string,
  input: {
    readonly price?: number
    readonly family?: string
    readonly released?: number
    readonly variants?: ReadonlyArray<string>
    readonly tools?: boolean
    readonly image?: boolean
    readonly context?: number
  } = {},
): CatalogModel {
  return {
    id,
    modelID: id,
    providerID,
    name: id.toUpperCase(),
    family: input.family,
    capabilities: { tools: input.tools ?? true, input: input.image ? ["text", "image"] : ["text"], output: ["text"] },
    variants: (input.variants ?? []).map((variant) => ({ id: variant })),
    time: { released: input.released ?? 0 },
    cost:
      input.price === undefined ? [] : [{ input: input.price, output: input.price * 5, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: input.context ?? 400_000, output: 128_000 },
  }
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"]
const CODEX = (providerID: string) => [
  model(providerID, "gpt-6-astra", { family: "gpt-astra", released: 20 * DAY, variants: LEVELS, image: true }),
  model(providerID, "gpt-6-luna", { family: "gpt-luna", released: 30 * DAY, variants: LEVELS }),
]
const MODELS: ReadonlyArray<CatalogModel> = [
  ...CODEX("own-codex-aaaa"),
  ...CODEX("own-codex-bbbb"),
  ...CODEX("own-siwc-cccc"),
  model("anthropic", "claude-opus-5-5", { family: "claude-opus", released: 10 * DAY, variants: ["high", "max"] }),
  model("anthropic", "claude-haiku-4-5", { family: "claude-haiku", released: 5 * DAY }),
  // The API catalog carries the prices the free subscription slots lack (07 §3.4).
  model("own-oai-dddd", "gpt-6-astra", { price: 10, family: "gpt-astra", released: 20 * DAY, variants: LEVELS }),
  model("own-oai-dddd", "gpt-6-luna", { price: 0.1, family: "gpt-luna", released: 30 * DAY, variants: LEVELS }),
  model("own-ds-eeee", "deepseek-flash", { price: 0.3, family: "deepseek", released: 3 * DAY }),
  model("own-ds-eeee", "deepseek-embed", { price: 0.01, tools: false }),
  model("ollama", "qwen3", { context: 131_072 }),
  model("own-anth-ffff", "claude-opus-5-5", { price: 15 }),
]

const pin = (account: string, model: string) => Schema.decodeUnknownSync(Preset.Target)({ pin: { account, model } })

// ---- OwnStore ----

function transport(answers: Record<string, unknown>) {
  const calls: { method: string; input: unknown }[] = []
  const client = {
    rpc: {
      call: async (input: { method: string; input?: unknown }) => {
        calls.push({ method: input.method, input: input.input })
        const entry = answers[input.method]
        const answer = typeof entry === "function" ? await entry(input.input) : entry
        if (answer instanceof Error) throw answer
        return { output: answer ?? {} }
      },
    },
  }
  // SAFETY: the store only reaches `rpc.call` here.
  return { calls, client: client as unknown as OpenCodeClient }
}

function ownFrame(name: string, data: Record<string, unknown>): OpenCodeEvent {
  // SAFETY: shaped like `V2EventRpc`, the variant the server sends for plugin RPC events.
  return {
    id: `evt_${Math.random()}`,
    created: Date.now(),
    type: `rpc.own.accounts.${name}`,
    location: { directory: "D:\\ctl" },
    data: { eventId: `01JAX${Math.random().toString(36).slice(2, 12)}`, origin: "global", ...data },
  } as OpenCodeEvent
}

const SAVED = Preset.ID.make("pr_01JB0000000000000000000000")

function listAnswer(revision: number) {
  return {
    groups: [
      {
        group: "codex",
        defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" },
        presets: [
          { ...Preset.builtin("codex"), status: "ok" },
          {
            ...Preset.builtin("codex"),
            id: SAVED,
            name: "Claude 리뷰",
            revision,
            status: "ok",
            workers: {
              mode: "by-role",
              roles: { "own-review": { targets: [pin(CLAUDE, "claude-opus-5-5")], effort: "inherit" } },
            },
            delegation: "when-useful",
          },
        ],
        star: SAVED,
        lighter: { "gpt-6-astra": { model: "gpt-6-luna", source: "auto" } },
        status: "ok",
        label: "codex-config",
      },
      { group: "ds", defaultModel: null },
    ],
    newSession: "last-light",
    recent: [SAVED],
    ultraCaps: "large",
  }
}

function sessionView(presetID: string) {
  return {
    binding: { presetID, group: "codex", revision: 1, appliedAt: 1, entryHash: null },
    preset: null,
    resolution: null,
    caps: Preset.CAPS,
    counts: { running: 0, message: 0, session: 0 },
    spend: 0,
  }
}

function setup(answers: Record<string, unknown> = {}) {
  let revision = 1
  let presetID = "builtin:codex"
  const { calls, client } = transport({
    health: { version: "local", buildId: "b", guard: "ok", controlDir: "D:\\ctl" },
    "accounts.list": { revision: 1, accounts: [] },
    "quota.snapshot": { windows: [] },
    "policy.get": { policy: { defaults: { byKind: {} } } },
    "presets.list": () => listAnswer(revision++),
    "session.preset.get": () => sessionView(presetID),
    ...answers,
  })
  return createRoot((dispose) => {
    const bus = createEventBus()
    const rpc = createOwnRpc({
      client: () => client,
      routing: { control: async () => "D:\\ctl", sessionDirectory: () => "D:\\p" },
      scopes: () => ALL_SCOPES,
    })
    const own = createOwnStore({ rpc, bus, client: () => client, sessionDirectory: () => "D:\\p" })
    const publish = (event: OpenCodeEvent) => {
      bus.publish(event)
      bus.flush()
    }
    const count = (method: string) => calls.filter((call) => call.method === method).length
    return { own, publish, count, dispose, setPreset: (id: string) => (presetID = id) }
  })
}

describe("OwnStore presets state (07 §8.1)", () => {
  test("presets.list fills every group's view, the group defaults and the global settings", async () => {
    const { own, publish, dispose } = setup()
    publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(Object.keys(own.state.presetGroups).sort()).toEqual(["codex", "ds"])
    expect(own.state.presetGroups.codex?.star).toBe(SAVED)
    expect<unknown>(own.state.presetGroups.codex?.presets?.map((item) => item.id)).toEqual(["builtin:codex", SAVED])
    expect<string | undefined>(own.state.presetGroups.codex?.lighter?.["gpt-6-astra"]?.model).toBe("gpt-6-luna")
    // T0 behaviour kept: groups without a default yet stay out of the new-session defaults.
    expect<unknown>(own.state.groupDefaults).toEqual({
      codex: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" },
    })
    expect<unknown>({ ...own.state.presetSettings, recent: [...own.state.presetSettings.recent] }).toEqual({
      newSession: "last-light",
      recent: [SAVED],
      ultraCaps: "large",
    })
    dispose()
  })

  test("an older service without the T1 fields: ★ new sessions, no recent presets, the recommended level", async () => {
    const { own, publish, dispose } = setup({
      "presets.list": { groups: [{ group: "codex", defaultModel: null }] },
    })
    publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(own.state.presetSettings.newSession).toBe("star")
    expect(own.state.presetSettings.recent).toEqual([])
    expect(own.state.presetSettings.ultraCaps).toBe(Preset.ULTRA_LEVEL)
    expect(own.state.presetGroups.codex?.presets).toBeUndefined()
    dispose()
  })

  test("presets.changed reads presets.list again; refreshPresets reads it now", async () => {
    const { own, publish, count, dispose } = setup()
    publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    const before = count("presets.list")
    publish(ownFrame("presets.changed", {}))
    await tick()
    expect(count("presets.list")).toBe(before + 1)
    expect(own.state.presetGroups.codex?.presets?.[1]?.revision).toBe(2)
    await own.refreshPresets()
    expect(count("presets.list")).toBe(before + 2)
    expect(count("policy.get")).toBe(1)
    dispose()
  })

  test("a watched session's preset view loads, follows session.preset.changed, binding.changed and presets.changed", async () => {
    const { own, publish, count, setPreset, dispose } = setup()
    publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    expect(count("session.preset.get")).toBe(0)
    const release = own.watchPreset("ses_root")
    await tick()
    expect(count("session.preset.get")).toBe(1)
    expect<string | undefined>(own.state.sessionPreset.ses_root?.binding?.presetID).toBe("builtin:codex")

    setPreset(SAVED)
    publish(ownFrame("session.preset.changed", { sessionID: "ses_root", binding: sessionView(SAVED).binding }))
    await tick()
    expect(count("session.preset.get")).toBe(2)
    expect<string | undefined>(own.state.sessionPreset.ses_root?.binding?.presetID).toBe(SAVED)

    publish(ownFrame("binding.changed", { sessionID: "ses_root" }))
    await tick()
    expect(count("session.preset.get")).toBe(3)
    publish(ownFrame("presets.changed", {}))
    await tick()
    expect(count("session.preset.get")).toBe(4)

    // Another session's change reads nothing; a second watcher shares the view.
    publish(ownFrame("session.preset.changed", { sessionID: "ses_other", binding: sessionView(SAVED).binding }))
    await tick()
    expect(count("session.preset.get")).toBe(4)
    const second = own.watchPreset("ses_root")
    await tick()
    expect(count("session.preset.get")).toBe(4)

    // A resync reads watched views again; the last release drops the view.
    publish({ type: "server.connected", id: "y", data: {} } as OpenCodeEvent)
    await tick()
    expect(count("session.preset.get")).toBe(5)
    release()
    expect(own.state.sessionPreset.ses_root).toBeDefined()
    second()
    expect(own.state.sessionPreset.ses_root).toBeUndefined()
    publish(ownFrame("session.preset.changed", { sessionID: "ses_root", binding: sessionView(SAVED).binding }))
    await tick()
    expect(count("session.preset.get")).toBe(5)
    dispose()
  })
})

// ---- editor state (07 §7.1) ----

describe("editor draft (07 §7.1)", () => {
  const stored: Preset.Info = {
    ...Preset.builtin("codex"),
    id: SAVED,
    name: "Claude 리뷰",
    revision: 3,
    workers: {
      mode: "by-role",
      roles: {
        "own-review": {
          targets: [pin(CLAUDE, "claude-opus-5-5"), { rel: "lighter" }],
          effort: Model.VariantID.make("high"),
        },
      },
    },
    delegation: "when-useful",
  }

  test("a new preset: every role like the main, model default, the default caps, no main model or effort (U1)", () => {
    const draft = draftOf("codex")
    expect(draft).toEqual({
      name: "",
      group: "codex",
      workers: { mode: "same", roles: {} },
      delegation: "model",
      caps: Preset.CAPS,
      ultraCaps: null,
    })
    // `평소대로` is locked: editing it starts a new preset.
    expect(draftOf("codex", Preset.builtin("codex"))).toEqual(draft)
    const keys = Object.keys(toSave({ ...draft, name: "x" })).sort()
    expect(keys).toEqual(["caps", "delegation", "group", "name", "ultraCaps", "workers"])
    expect(draftOf("codex", stored)).toMatchObject({ id: SAVED, name: "Claude 리뷰", delegation: "when-useful" })
    expect(toSave({ ...draftOf("codex", stored), name: "  Claude 리뷰  " })).toMatchObject({
      id: SAVED,
      name: "Claude 리뷰",
    })
  })

  test("① modes keep the rows; role rows: 메인과 같게 removes the row, another target becomes the first", () => {
    const draft = draftOf("codex", stored)
    expect(withMode(draft, "same").workers.roles["own-review"]?.targets).toHaveLength(2)
    const lighter = withTarget(draft, "explore", { rel: "lighter" })
    expect(lighter.workers.roles.explore).toEqual({ targets: [{ rel: "lighter" }], effort: "inherit" })
    // The first target is replaced; the later ones stay (their order is 자세히, T2), without duplicates.
    const replaced = withTarget(draft, "own-review", { rel: "lighter" })
    expect<unknown>(replaced.workers.roles["own-review"]).toEqual({ targets: [{ rel: "lighter" }], effort: "high" })
    const local = withTarget(draft, "own-review", pin("local:ollama", "qwen3"))
    expect(local.workers.roles["own-review"]?.targets).toEqual([pin("local:ollama", "qwen3"), { rel: "lighter" }])
    expect(withTarget(draft, "own-review", { rel: "main" }).workers.roles["own-review"]).toBeUndefined()
    expect(withoutRole(lighter, "explore").workers.roles.explore).toBeUndefined()
    expect(withTarget(draft, "single", { rel: "lighter" }).workers.single).toEqual({ rel: "lighter" })
    expect(withDelegation(draft, "active").delegation).toBe("active")
  })

  test("UC 2026-10-18: 다른 모델 하나로 never points at the main; picked or stored, it is 메인과 같은 모델로", () => {
    const named = { ...draftOf("codex"), name: "x" }
    // Picking `메인과 같게` there is the first radio; `다른 모델 하나로` again starts with no target and waits for one.
    const picked = withTarget(withMode(named, "single"), "single", { rel: "main" })
    expect(picked.workers).toEqual({ mode: "same", roles: {} })
    expect(draftMode(picked)).toBe("same")
    const again = withMode({ ...named, workers: { mode: "by-role", single: { rel: "main" }, roles: {} } }, "single")
    expect(again.workers).toEqual({ mode: "single", roles: {} })
    expect(problems(again, lookup).map((item) => item.code)).toEqual(["single"])
    // A stored one (an older service lists it as it is) opens on the first radio and saves as `same`.
    const old = { ...stored, workers: { mode: "single" as const, single: { rel: "main" as const }, roles: {} } }
    expect(draftMode(draftOf("codex", old))).toBe("same")
    expect(toSave(draftOf("codex", old)).workers).toEqual({ mode: "same", roles: {} })
    // Another target stays where it is, through a mode change and back.
    const lighter = withTarget(withMode(named, "single"), "single", { rel: "lighter" })
    expect(withMode(withMode(lighter, "by-role"), "single").workers.single).toEqual({ rel: "lighter" })
  })

  test("the shown roles: 탐색·일반·리뷰 always, 빠른 일·어려운 일 when they have a row or were added", () => {
    const draft = draftOf("codex")
    expect(shownRoles(draft, [])).toEqual(["explore", "general", "own-review"])
    expect(shownRoles(draft, ["own-deep"])).toEqual(["explore", "general", "own-review", "own-deep"])
    expect(shownRoles(withTarget(draft, "own-quick", { rel: "lighter" }), [])).toContain("own-quick")
  })

  test("a refusal chip's prefill opens 일마다 정하기 with the role's first target set (nothing saved)", () => {
    const draft = withPrefill(draftOf("codex"), { role: "own-review", target: pin(DEEPSEEK, "deepseek-flash") }, lookup)
    expect(draftMode(draft)).toBe("by-role")
    expect(draft.workers.roles["own-review"]?.targets).toEqual([pin(DEEPSEEK, "deepseek-flash")])
  })

  test("a starter fills the rows and delegation and names the preset only while the name is empty", () => {
    const starter = Preset.suggest("codex", [], "light-split").draft
    const fresh = withStarter(draftOf("codex"), starter)
    expect(fresh.name).toBe("가볍게 나눠 쓰기")
    expect(fresh.workers.roles.explore?.targets).toEqual([{ rel: "lighter" }])
    expect(fresh.delegation).toBe("when-useful")
    expect(withStarter({ ...draftOf("codex"), name: "내 프리셋" }, starter).name).toBe("내 프리셋")
  })

  test("provenance: 추천 while a row equals presets.suggest's, 직접 고름 once picked or when it differs", () => {
    const suggestion = Preset.suggest("codex", pinnables(sections("codex")))
    expect(suggestion.rows["own-review"]?.targets).toEqual([pin(CLAUDE, "claude-opus-5-5")])
    const draft = withTarget(draftOf("codex"), "own-review", pin(CLAUDE, "claude-opus-5-5"))
    expect(provenance(draft, "own-review", [], suggestion)).toBe("suggested")
    expect(provenance(draft, "own-review", ["own-review"], suggestion)).toBe("user")
    expect(provenance(draft, "general", [], suggestion)).toBe("suggested")
    expect(provenance(withTarget(draft, "general", { rel: "lighter" }), "general", [], suggestion)).toBe("user")
    expect(provenance(draft, "general", [], undefined)).toBeUndefined()
    // No row while the suggestion is another target: nobody chose `메인과 같게` for it.
    expect(suggestion.rows.explore?.targets).toEqual([{ rel: "lighter" }])
    expect(provenance(draft, "explore", [], suggestion)).toBeUndefined()
    expect(provenance(withTarget(draft, "explore", { rel: "lighter" }), "explore", [], suggestion)).toBe("suggested")
    expect(provenance(draft, "single", [], suggestion)).toBeUndefined()
  })

  test("problems: a name, a single target, and R4 as presets.set judges it (main: null)", () => {
    expect(problems(draftOf("codex"), lookup).map((item) => item.code)).toEqual(["name"])
    const single = withMode({ ...draftOf("codex"), name: "x" }, "single")
    expect(problems(single, lookup).map((item) => item.code)).toEqual(["single"])
    // A ChatGPT preset can never pin a ChatGPT subscription, the same login's siwc account included (07 §5.4).
    for (const accountID of [CHATGPT_02, SIWC_01])
      expect(
        problems(withTarget({ ...draftOf("codex"), name: "x" }, "explore", pin(accountID, "gpt-6-luna")), lookup),
      ).toEqual([{ code: "same-company", accountID }])
    // A Claude preset may pin one ChatGPT subscription (the same login's codex and siwc count as one), never two.
    const claude = withTarget({ ...draftOf("claude-sub"), name: "x" }, "explore", pin(CHATGPT_01, "gpt-6-luna"))
    expect(problems(withTarget(claude, "own-review", pin(SIWC_01, "gpt-6-astra")), lookup)).toEqual([])
    expect(problems(withTarget(claude, "own-review", pin(CHATGPT_02, "gpt-6-astra")), lookup)).toEqual([
      { code: "same-company", accountID: CHATGPT_02 },
    ])
    expect(clashes(claude, "own-review", pin(CHATGPT_02, "gpt-6-astra"), lookup)).toBe(true)
    expect(clashes(claude, "own-review", pin(SIWC_01, "gpt-6-astra"), lookup)).toBe(false)
    expect(clashes(claude, "explore", pin(CHATGPT_02, "gpt-6-astra"), lookup)).toBe(false)
    expect(clashes(claude, "own-review", { rel: "lighter" }, lookup)).toBe(false)
  })
})

// ---- resolution line (07 §7.1, §4.2) ----

describe("live resolution (Preset.resolve, the service's code)", () => {
  const main = mainOf({ providerID: "own-codex-aaaa", id: "gpt-6-astra", variant: "high" }, accountOf, MODELS)!

  test("the main of a session: its account, Ref and the model's own levels", () => {
    expect(main).toMatchObject({ account: CHATGPT_01, ref: { id: "gpt-6-astra", variant: "high" }, variants: LEVELS })
    expect(mainOf({ providerID: "ollama", id: "qwen3" }, accountOf, MODELS)?.account).toBe("local:ollama")
    expect(mainOf(undefined, accountOf, MODELS)).toBeUndefined()
  })

  test("lighter pairs: the stored one wins; without one the preview picks like the service, priced from the API twin", () => {
    expect<unknown>(lighterFor("codex", undefined, main, MODELS)["gpt-6-astra"]).toEqual({
      model: "gpt-6-luna",
      source: "auto",
    })
    const user = { "gpt-6-astra": { model: Model.ID.make("gpt-6-astra"), source: "none" as const } }
    expect(lighterFor("codex", user, main, MODELS)).toEqual(user)
    // Without prices there is no pick: the role says `더 가벼운 모델을 아직 정하지 않음`.
    const free = MODELS.filter((item) => item.providerID !== "own-oai-dddd")
    expect(lighterFor("codex", undefined, main, free)).toEqual({})
  })

  test("roles resolve against the main; the line lists each role with a row, [복사] carries provider/model#variant", () => {
    const draft = withTarget(
      withTarget(withMode(draftOf("codex"), "by-role"), "explore", { rel: "lighter" }),
      "own-review",
      pin(CLAUDE, "claude-opus-5-5"),
    )
    const resolution = Preset.resolve(
      draft,
      main,
      catalogOf(BY_ID, MODELS),
      lighterFor("codex", undefined, main, MODELS),
    )
    const line = resolutionLine(draft, resolution)
    expect(line).toMatchObject({
      kind: "roles",
      items: [
        { role: "explore", ref: { providerID: "own-codex-aaaa", id: "gpt-6-luna", variant: "high" }, fallback: false },
        {
          role: "own-review",
          ref: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
          fallback: false,
        },
      ],
    })
    expect(copyLines(line)).toBe("explore: own-codex-aaaa/gpt-6-luna#high\nown-review: anthropic/claude-opus-5-5#high")
    expect(resolutionLine(withMode(draft, "same"), resolution)).toEqual({ kind: "same" })
    expect(copyLines({ kind: "same" })).toBe("")
  })

  test("an account that cannot serve is skipped and the role runs like the main (fallback)", () => {
    const exhausted = { ...BY_ID, [CLAUDE]: { ...BY_ID[CLAUDE]!, status: "exhausted" as const } }
    const draft = withTarget(withMode(draftOf("codex"), "by-role"), "own-review", pin(CLAUDE, "claude-opus-5-5"))
    const resolution = Preset.resolve(draft, main, catalogOf(exhausted, MODELS), {})
    expect(resolution.roles["own-review"]?.targets[0]?.skip).toBe("unavailable")
    expect(resolutionLine(draft, resolution)).toMatchObject({
      kind: "roles",
      items: [{ role: "own-review", fallback: true }],
    })
  })

  test("다른 모델 하나로 shows one target for every subagent", () => {
    const draft = withTarget(withMode(draftOf("codex"), "single"), "single", pin(CLAUDE, "claude-haiku-4-5"))
    const resolution = Preset.resolve(draft, main, catalogOf(BY_ID, MODELS), {})
    expect(resolutionLine(draft, resolution)).toMatchObject({ kind: "single", ref: { id: "claude-haiku-4-5" } })
  })
})

// ---- target picker (PG2, PG11) ----

function sections(group: Preset.Group, local?: Parameters<typeof pickerSections>[0]["local"]) {
  return pickerSections({ group, accounts: ACCOUNTS, models: MODELS, local })
}

describe("target picker sections (07 §7.1, §7.3, §3.4)", () => {
  test("PG2: a ChatGPT preset never lists a ChatGPT subscription (other logins, the same login's siwc); it says so", () => {
    const result = sections("codex")
    expect(result.subscriptions.map((section) => section.account.id)).toEqual([CLAUDE])
    const listed = [...result.subscriptions, ...result.paid].flatMap((section) => section.rows.map((row) => row.target))
    for (const accountID of [CHATGPT_01, CHATGPT_02, SIWC_01])
      expect(listed.some((target) => "pin" in target && target.pin.account === accountID)).toBe(false)
    expect(result.hidden).toBe("openai")
    // Every listed target passes R4 as presets.set judges it.
    for (const target of listed)
      expect(
        Preset.allowed({ group: "codex", workers: { mode: "single", single: target, roles: {} } }, null, lookup),
      ).toEqual({
        ok: true,
      })
  })

  test("a Claude preset lists the ChatGPT subscriptions and hides other Claude subscriptions", () => {
    const result = sections("claude-sub")
    expect(result.subscriptions.map((section) => section.account.id)).toEqual([CHATGPT_01, CHATGPT_02, SIWC_01])
    expect(result.hidden).toBe("anthropic")
    expect(sections("ds").hidden).toBeUndefined()
  })

  test("PG11: metered and prepaid accounts are only in the paid section, with the same company's API key allowed", () => {
    const result = sections("codex")
    expect(result.paid.map((section) => section.account.id)).toEqual([OPENAI_KEY, DEEPSEEK])
    expect(result.paid[0]?.rows.every((row) => row.badge === "metered")).toBe(true)
    expect(result.paid[1]?.rows.every((row) => row.badge === "prepaid")).toBe(true)
    expect(result.subscriptions.flatMap((section) => section.rows).every((row) => row.badge === "subscription")).toBe(
      true,
    )
    // Suggestions never use them (the service's rule; the client fallback uses the same function).
    const suggested = Preset.suggest("codex", pinnables(result))
    const targets = Object.values(suggested.rows).flatMap((row) => row.targets)
    expect(
      targets.some(
        (target) => "pin" in target && (target.pin.account === OPENAI_KEY || target.pin.account === DEEPSEEK),
      ),
    ).toBe(false)
  })

  test("retired accounts, tool-less models and an unacknowledged Claude slot are not listed", () => {
    const result = sections("codex")
    expect([...result.subscriptions, ...result.paid].some((section) => section.account.id === RETIRED)).toBe(false)
    expect(result.paid[1]?.rows.map((row) => row.name)).toEqual(["DEEPSEEK-FLASH"])
    const unacknowledged = ACCOUNTS.map((item) =>
      item.id === CLAUDE ? { ...item, status: "unverified" as const } : item,
    )
    expect(pickerSections({ group: "codex", accounts: unacknowledged, models: MODELS }).subscriptions).toEqual([])
  })

  test("cards: window, price band from the price order (the API twin prices free slots), levels, images, release", () => {
    const result = sections("claude-sub")
    const astra = result.subscriptions[0]?.rows.find((row) => row.name === "GPT-6-ASTRA")
    expect(astra).toMatchObject({
      window: 400_000,
      band: "high",
      levels: 5,
      image: true,
      released: 20 * DAY,
      price: 10,
    })
    const luna = result.subscriptions[0]?.rows.find((row) => row.name === "GPT-6-LUNA")
    expect(luna).toMatchObject({ band: "low", image: false })
    expect(
      sections("codex").subscriptions[0]?.rows.find((row) => row.name === "CLAUDE-HAIKU-4-5")?.band,
    ).toBeUndefined()
  })

  test("local LLMs: `창 확인 안 됨` until the running window is verified, then that window", () => {
    const unverified = sections("codex").local
    expect(unverified).toEqual([
      { providerID: "ollama", rows: [expect.objectContaining({ badge: "local", verified: false, window: undefined })] },
    ])
    expect(unverified[0]?.rows[0]?.target).toEqual(pin("local:ollama", "qwen3"))
    const verified = sections("codex", () => ({ status: "verified", runtime: 65_536 })).local
    expect(verified[0]?.rows[0]).toMatchObject({ verified: true, window: 65_536 })
  })

  test("budget and spend: the budget window's spend, a typed budget (empty = 상한 없음)", () => {
    const window = {
      id: "api.budget_month",
      accountID: OPENAI_KEY,
      providerID: Provider.ID.make("own-oai-dddd"),
      scope: "account",
      kind: "budget",
      label: "이번 달 예산",
      remaining: 12.5,
      limit: 20,
      unit: "USD",
      status: "ok",
      confidence: "live",
      source: "ledger",
      observedAt: 1,
    } satisfies Limit.Window
    expect(budgetSpent([window])).toBe(7.5)
    expect(budgetSpent([])).toBeUndefined()
    expect(parseBudget("")).toBeNull()
    expect(parseBudget("$1,200")).toBe(1200)
    expect(parseBudget("-3")).toBeUndefined()
    expect(parseBudget("abc")).toBeUndefined()
  })
})

// ---- 모델 묶음 (07 §3.3, §8.1; pool design P09) ----

const card = (name: string, extra: Partial<Preset.PoolCard> = {}): Preset.PoolCard => ({ name, at: 1, ...extra })
const poolModel = (id: string, input: Partial<Preset.PoolModel> & { readonly name: string }): Preset.PoolModel => ({
  id,
  released: input.released ?? 0,
  ...(input.family === undefined ? {} : { family: input.family }),
  ...(input.price === undefined ? {} : { price: input.price }),
  card: input.card ?? card(input.name),
})
const ASTRA = poolModel("gpt-6-astra", {
  name: "GPT-6 Astra",
  family: "gpt-astra",
  released: 20 * DAY,
  price: 10,
  card: card("GPT-6 Astra", { window: 400_000, reasoning: true, image: true }),
})
const LUNA = poolModel("gpt-6-luna", { name: "GPT-6 Luna", family: "gpt-luna", released: 30 * DAY, price: 0.1 })

/** A Claude group's checklist, as `presets.suggest` builds it (`Preset.poolOffer`): ChatGPT 02 is the roomiest. */
const CLAUDE_OFFER = Preset.poolOffer([
  {
    runs: "main",
    company: "anthropic",
    models: [
      poolModel("claude-opus-5-5", { name: "Claude Opus 5.5", family: "claude-opus", released: 10 * DAY, price: 15 }),
      poolModel("claude-haiku-4-5", { name: "Claude Haiku 4.5", family: "claude-haiku", released: 5 * DAY, price: 1 }),
    ],
  },
  { runs: "subscription", account: CHATGPT_02, company: "openai", models: [ASTRA, LUNA] },
  { runs: "subscription", account: CHATGPT_01, company: "openai", models: [ASTRA] },
  {
    runs: "local",
    account: "local:ollama",
    models: [poolModel("qwen3", { name: "Qwen3", card: card("Qwen3", { window: 32_768, windowVerified: true }) })],
  },
  {
    runs: "paid",
    account: DEEPSEEK,
    company: "deepseek",
    models: [poolModel("deepseek-flash", { name: "DeepSeek Flash", price: 0.3 })],
  },
])
const candidate = (key: string, account?: string) =>
  CLAUDE_OFFER.candidates.find((item) => item.key === key && item.account === account)!
const claudeDraft = () => ({ ...draftOf("claude-sub"), name: "모델 묶음" })
const claudeMain = mainOf({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" }, accountOf, MODELS)!

describe("모델 묶음 in the editor's draft (07 §2.1, §8.1)", () => {
  test("① choices are Preset.modeOf values, simplest first; the pool is stored as mode same with the pool", () => {
    expect(WORKER_MODES).toEqual(["same", "single", "pool", "by-role"])
    const entry = { key: "claude-haiku-4-5", model: Model.ID.make("claude-haiku-4-5") }
    const pooled = withMode(withTarget(claudeDraft(), "explore", { rel: "lighter" }), "pool", [entry])
    expect(pooled.workers).toMatchObject({ mode: "same", pool: [entry] })
    expect(Preset.modeOf(pooled.workers)).toBe("pool")
    expect(draftMode(pooled)).toBe("pool")
    expect(toSave(pooled).workers).toMatchObject({ mode: "same", pool: [entry] })
    // Leaving the pool drops it (the editor keeps the list while open); the role rows stay.
    const roles = withMode(pooled, "by-role")
    expect(roles.workers.pool).toBeUndefined()
    expect("pool" in roles.workers).toBe(false)
    expect(roles.workers.roles.explore).toBeDefined()
    expect(draftMode(withMode(pooled, "same"))).toBe("same")
    // Choosing the pool before checking a model: the radio stays on the pool, saving waits for a model.
    const empty = withMode(claudeDraft(), "pool")
    expect(draftMode(empty)).toBe("pool")
    expect(Preset.modeOf(empty.workers)).toBe("same")
    expect(problems(empty, lookup)).toEqual([{ code: "pool" }])
  })

  test("a stored empty pool is no pool (Preset.modeOf), so the draft opens on the stored mode", () => {
    const stored: Preset.Info = {
      ...Preset.builtin("claude-sub"),
      id: SAVED,
      name: "x",
      workers: { mode: "by-role", roles: {}, pool: [] },
    }
    expect(draftOf("claude-sub", stored).workers.pool).toBeUndefined()
    expect(draftMode(draftOf("claude-sub", stored))).toBe("by-role")
  })

  test("the checklist's sections: the main account, one company with its accounts (roomiest first), local, paid", () => {
    const sections = poolSections(CLAUDE_OFFER.candidates)
    expect(sections.main.map((item) => item.key)).toEqual(["claude-opus-5-5", "claude-haiku-4-5"])
    expect(sections.main.every((item) => item.account === undefined && item.runs === "main")).toBe(true)
    expect(sections.companies.map((item) => item.company)).toEqual(["openai"])
    expect<unknown>(sections.companies[0]?.accounts.map((item) => item.account)).toEqual([CHATGPT_02, CHATGPT_01])
    // One company's subscription accounts share a model's key (only one of them can be in a pool).
    expect(candidate("gpt-6-astra", CHATGPT_01).key).toBe(candidate("gpt-6-astra", CHATGPT_02).key)
    expect<unknown>(sections.local.map((item) => item.account)).toEqual(["local:ollama"])
    expect<unknown>(sections.paid.map((item) => item.account)).toEqual([DEEPSEEK])
    expect(poolSections([])).toEqual({ main: [], companies: [], local: [], paid: [] })
  })

  test("check and uncheck: the candidate's key unless taken, a target only once", () => {
    const opus = candidate("claude-opus-5-5")
    const checked = withPoolEntry(withMode(claudeDraft(), "pool"), opus)
    expect(checked.workers.pool).toEqual([{ key: opus.key, model: opus.model, card: opus.card! }])
    expect(withPoolEntry(checked, opus)).toBe(checked)
    // A key another entry already has (here from a chip's prefill) gets Preset.poolKey's tail.
    const prefilled = withPrefill(claudeDraft(), { pool: { model: Model.ID.make("gpt-6-astra") } }, lookup)
    const astra = candidate("gpt-6-astra", CHATGPT_02)
    const both = withPoolEntry(prefilled, astra)
    expect(both.workers.pool?.map((entry) => entry.key)).toEqual([
      "gpt-6-astra",
      Preset.poolKey("gpt-6-astra", ["gpt-6-astra"], "subscription"),
    ])
    expect(withoutPoolEntry(both, "gpt-6-astra").workers.pool?.map((entry) => entry.account)).toEqual([CHATGPT_02])
    expect(draftMode(withoutPoolEntry(checked, opus.key))).toBe("pool")
  })

  test("one account per company: the section uses the pinned one, else the picked one, else the roomiest", () => {
    const accounts = poolSections(CLAUDE_OFFER.candidates).companies[0]!.accounts
    const empty = withMode(claudeDraft(), "pool")
    expect(poolAccountOf(empty, accounts)).toBe(CHATGPT_02)
    expect(poolAccountOf(empty, accounts, CHATGPT_01)).toBe(CHATGPT_01)
    const draft = [
      candidate("gpt-6-astra", CHATGPT_02),
      candidate("gpt-6-luna", CHATGPT_02),
      candidate("claude-opus-5-5"),
    ].reduce(withPoolEntry, empty)
    expect(poolAccountOf(draft, accounts, CHATGPT_01)).toBe(CHATGPT_02)
    // Switching moves the checks to the same models of the new account; a model it lacks leaves the pool.
    const moved = withPoolAccount(draft, accounts, CHATGPT_01)
    expect<unknown>(moved.workers.pool?.map((entry) => [entry.key, entry.account])).toEqual([
      ["gpt-6-astra", CHATGPT_01],
      ["claude-opus-5-5", undefined],
    ])
    expect(moved.workers.pool?.[0]?.card).toEqual(candidate("gpt-6-astra", CHATGPT_01).card!)
    expect(problems(moved, lookup)).toEqual([])
    expect(poolAccountOf(moved, accounts)).toBe(CHATGPT_01)
    // Two ChatGPT logins in one pool break R4 (07 §5.4), judged as presets.set does.
    const clash = withPoolEntry(withPoolEntry(empty, candidate("gpt-6-astra", CHATGPT_01)), {
      ...candidate("gpt-6-luna", CHATGPT_02),
      key: "gpt-6-luna",
    })
    expect(problems(clash, lookup)).toEqual([{ code: "same-company", accountID: CHATGPT_02 }])
  })

  test("R4 for a ChatGPT group: the main account's models are no pin; another ChatGPT login is", () => {
    const draft = withPoolEntry(withMode({ ...draftOf("codex"), name: "x" }, "pool"), {
      key: "gpt-6-luna",
      model: Model.ID.make("gpt-6-luna"),
    })
    expect(problems(draft, lookup)).toEqual([])
    const pinned = withPoolEntry(draft, { key: "gpt-6-astra", model: Model.ID.make("gpt-6-astra"), account: SIWC_01 })
    expect(problems(pinned, lookup)).toEqual([{ code: "same-company", accountID: SIWC_01 }])
  })

  test("추천 묶음: the recommended keys, a subscription on the section's account by model id, nothing paid", () => {
    expect(CLAUDE_OFFER.recommended).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5",
      "gpt-6-astra",
      "gpt-6-luna",
      "qwen3",
    ])
    const noted = withPoolEntry(withMode(claudeDraft(), "pool"), candidate("qwen3", "local:ollama"))
    const withNote = {
      ...noted,
      workers: { ...noted.workers, pool: noted.workers.pool!.map((entry) => ({ ...entry, note: "빠른 검색용" })) },
    }
    const filled = withRecommended(withNote, CLAUDE_OFFER, () => CHATGPT_01)
    expect<unknown>(filled.workers.pool?.map((entry) => [entry.key, entry.account])).toEqual([
      ["claude-opus-5-5", undefined],
      ["claude-haiku-4-5", undefined],
      ["gpt-6-astra", CHATGPT_01],
      ["qwen3", "local:ollama"],
    ])
    expect(filled.workers.pool?.find((entry) => entry.key === "qwen3")?.note).toBe("빠른 검색용")
    expect(filled.workers.pool?.some((entry) => entry.account === DEEPSEEK)).toBe(false)
    expect(
      withRecommended(claudeDraft(), CLAUDE_OFFER, () => CHATGPT_02).workers.pool?.filter(
        (entry) => entry.account === CHATGPT_02,
      ),
    ).toHaveLength(2)
  })

  test("a chip's pool prefill checks the model in the pool, keeping the pool; runs give the key's tail", () => {
    const start = withPoolEntry(withMode(claudeDraft(), "pool"), candidate("claude-opus-5-5"))
    const added = withPrefill(start, { pool: { model: Model.ID.make("deepseek-flash"), account: DEEPSEEK } }, lookup)
    expect(added.workers.pool?.map((entry) => entry.key)).toEqual(["claude-opus-5-5", "deepseek-flash"])
    expect<unknown>(added.workers.pool?.[1]).toEqual({
      key: "deepseek-flash",
      model: "deepseek-flash",
      account: DEEPSEEK,
    })
    expect(poolRuns(undefined, lookup)).toBe("main")
    expect(poolRuns("local:ollama", lookup)).toBe("local")
    expect(poolRuns(CLAUDE, lookup)).toBe("subscription")
    expect(poolRuns(DEEPSEEK, lookup)).toBe("paid")
    expect(poolRuns(Account.ID.make("acc_unknown"), lookup)).toBeUndefined()
  })

  test("price bands from the candidates' raw ranking prices", () => {
    expect(poolBand(candidate("gpt-6-luna", CHATGPT_02).price, CLAUDE_OFFER.candidates)).toBe("low")
    expect(poolBand(candidate("claude-opus-5-5").price, CLAUDE_OFFER.candidates)).toBe("high")
    expect(poolBand(undefined, CLAUDE_OFFER.candidates)).toBeUndefined()
  })
})

describe("모델 묶음 previews over the server's facts (07 §3.3, D8)", () => {
  const draft = [
    candidate("claude-opus-5-5"),
    candidate("claude-haiku-4-5"),
    candidate("gpt-6-astra", CHATGPT_02),
    candidate("qwen3", "local:ollama"),
  ].reduce(withPoolEntry, withMode(claudeDraft(), "pool"))
  const pool = draft.workers.pool!

  test("the candidates' facts; the main's from the main account's candidate of the main model", () => {
    const facts = poolFacts({ pool, candidates: CLAUDE_OFFER.candidates, main: claudeMain })
    expect(facts.main).toEqual({
      model: "claude-opus-5-5",
      side: { runs: "main", company: "anthropic", price: 15, local: false },
    })
    expect(facts.entries.map((entry) => entry.side.runs)).toEqual(["main", "main", "subscription", "local"])
    expect(facts.entries[2]?.side).toEqual({ runs: "subscription", company: "openai", price: 10 })
    expect(facts.entries.map((entry) => entry.card?.name)).toEqual([
      "Claude Opus 5.5",
      "Claude Haiku 4.5",
      "GPT-6 Astra",
      "Qwen3",
    ])
  })

  test("the session's Resolution.pool wins for an entry it names with facts", () => {
    const session: Preset.PoolResolution = {
      main: { runs: "main", company: "anthropic", price: 20, local: false },
      entries: [{ key: "gpt-6-astra", runs: "subscription", company: "openai", price: 25 }, { key: "qwen3" }],
    }
    const facts = poolFacts({ pool, candidates: CLAUDE_OFFER.candidates, session, main: claudeMain })
    expect(facts.main.side.price).toBe(20)
    expect(facts.entries.find((entry) => entry.key === "gpt-6-astra")?.side.price).toBe(25)
    // A served entry without facts (an older service) falls back to the candidate's.
    expect(facts.entries.find((entry) => entry.key === "qwen3")?.side.runs).toBe("local")
  })

  test("guidance and default line: Preset.renderGuidance with Preset.poolGuidance (poolRelation, poolDefaults)", () => {
    const facts = poolFacts({ pool, candidates: CLAUDE_OFFER.candidates, main: claudeMain })
    const guidance = Preset.poolGuidance(facts.entries, facts.main)
    expect(guidance.relation).toEqual({
      "claude-opus-5-5": "same",
      "claude-haiku-4-5": "lighter",
      "gpt-6-astra": "lighter",
      qwen3: "lighter",
    })
    expect(guidance.defaults).toEqual(Preset.poolDefaults(facts.entries, facts.main))
    const text = guidanceOf({ ...draft, delegation: "when-useful" }, {}, guidance)?.text ?? ""
    expect<string | undefined>(text).toBe(
      Preset.renderGuidance({
        delegation: "when-useful",
        ultra: false,
        caps: Preset.caps(draft, false),
        cards: {},
        pool: guidance,
        effort: true,
      })?.text,
    )
    expect(text).toContain("- gpt-6-astra: GPT-6 Astra, OpenAI, on the user's subscription.")
    expect(defaultItems(guidance.defaults)).toEqual([
      { key: "claude-haiku-4-5", roles: ["explore", "own-quick"] },
      { key: "gpt-6-astra", roles: ["own-review"] },
      { key: undefined, roles: ["own-deep", "general"] },
    ])
  })

  test("the resolution line lists each model's Ref, or that it is skipped (07 §7.1)", () => {
    const exhausted = { ...BY_ID, [CHATGPT_02]: { ...BY_ID[CHATGPT_02]!, status: "exhausted" as const } }
    const resolution = Preset.resolve(draft, claudeMain, catalogOf(exhausted, MODELS))
    const line = resolutionLine(draft, resolution)
    expect(line).toMatchObject({
      kind: "pool",
      items: [
        { key: "claude-opus-5-5", ref: { providerID: "anthropic", id: "claude-opus-5-5" } },
        { key: "claude-haiku-4-5", ref: { providerID: "anthropic", id: "claude-haiku-4-5" } },
        { key: "gpt-6-astra", skip: "unavailable" },
        { key: "qwen3", ref: { providerID: "ollama", id: "qwen3" } },
      ],
    })
    expect(copyLines(line)).toBe(
      "claude-opus-5-5: anthropic/claude-opus-5-5#high\nclaude-haiku-4-5: anthropic/claude-haiku-4-5\nqwen3: ollama/qwen3",
    )
    // Before a model is checked the line has none (the editor says to pick one).
    const empty = withMode(draft, "pool")
    expect(resolutionLine(empty, Preset.resolve(empty, claudeMain, catalogOf(BY_ID, MODELS)))).toEqual({
      kind: "pool",
      items: [],
    })
  })

  test("the composer's banner and the team's worst case read the pool's pins through Preset.targetsOf", () => {
    const paid = withPoolEntry(draft, candidate("deepseek-flash", DEEPSEEK))
    expect(usedTargets(paid.workers)).toEqual(Preset.targetsOf({ ...paid.workers, roles: {} }))
    expect(pinnedAccounts(paid)).toEqual([CHATGPT_02, DEEPSEEK])
    // Leftover rows of another mode send nothing.
    const roles = withMode(withTarget(paid, "own-review", pin(CLAUDE, "claude-opus-5-5")), "pool", paid.workers.pool)
    expect(pinnedAccounts(roles)).toEqual([CHATGPT_02, DEEPSEEK])
    expect(pinnedAccounts(withMode(roles, "by-role"))).toEqual([CLAUDE])
    expect(Preset.heavy(paid, lookup)).toBe(true)
  })
})

describe("modes are read through Preset.modeOf only (pool design §2.7)", () => {
  test("no own-web file reads the stored mode but Preset.modeOf", async () => {
    const root = path.join(import.meta.dir, "..", "..")
    const files = [...new Glob("{src,e2e}/**/*.{ts,tsx}").scanSync(root)]
    const offenders = await Promise.all(
      files.map(async (file) =>
        /\bworkers\??\.mode\b/.test(await Bun.file(path.join(root, file)).text()) ? [file] : [],
      ),
    )
    expect(offenders.flat()).toEqual([])
  })
})

// ---- the open-editor request ----

describe("openPresetEditor", () => {
  test("sets a fresh request every time; closing clears it", () => {
    const request = { group: "codex" as const, presetID: SAVED }
    openPresetEditor(request)
    const first = presetEditorRequest()
    expect(first).toEqual(request)
    openPresetEditor(request)
    expect(presetEditorRequest()).not.toBe(first)
    openPresetEditor({ group: "codex", prefill: { role: "own-review", target: pin(DEEPSEEK, "deepseek-flash") } })
    expect(presetEditorRequest()?.prefill).toEqual({ role: "own-review", target: pin(DEEPSEEK, "deepseek-flash") })
    closePresetEditor()
    expect(presetEditorRequest()).toBeUndefined()
  })
})

// ---- strings (07 §7.5) ----

describe("strings", () => {
  test("English keys exist in Korean; every key is own.preset.*", () => {
    for (const key of Object.keys(presetsEn)) expect(Object.hasOwn(presetsKo, key)).toBe(true)
    for (const key of Object.keys(presetsKo)) expect(key.startsWith("own.preset.")).toBe(true)
  })

  test("07 §7.5 keys of the T1 screens are there", () => {
    const keys = [
      "own.preset.effort.inherit",
      "own.preset.builtin",
      "own.preset.star",
      "own.preset.group.shared",
      "own.preset.setGroupDefault",
      "own.preset.groupDefault",
      "own.preset.ultra",
      "own.preset.ultra.raiseClaude",
      "own.preset.workers.same",
      "own.preset.workers.single",
      "own.preset.workers.byRole",
      "own.preset.target.main",
      "own.preset.target.lighter",
      "own.preset.lighter.none",
      "own.preset.role.general",
      "own.preset.role.explore",
      "own.preset.role.quick",
      "own.preset.role.deep",
      "own.preset.role.review",
      "own.preset.delegation.off",
      "own.preset.delegation.model",
      "own.preset.delegation.onRequest",
      "own.preset.delegation.whenUseful",
      "own.preset.delegation.active",
      "own.preset.caps.concurrent",
      "own.preset.caps.perMessage",
      "own.preset.caps.perSession",
      "own.preset.caps.raiseOnce",
      "own.preset.waiting",
      "own.preset.badge.subscription",
      "own.preset.badge.metered",
      "own.preset.badge.prepaid",
      "own.preset.badge.local",
      "own.preset.badge.mainAccount",
      "own.preset.paidRow",
      "own.preset.sameCompanyHidden",
    ]
    for (const key of keys) expect(Object.hasOwn(presetsKo, key)).toBe(true)
  })

  test("the model pool keys of the pool design §8.3 are there in Korean and English", () => {
    const keys: ReadonlyArray<readonly [PresetsKey, string, string]> = [
      ["own.preset.workers.pool", "모델 묶음에서 알아서", "From a model pool"],
      [
        "own.preset.workers.poolHint",
        "쓸 모델만 고르면 LLM이 일마다 골라 씀",
        "Check models; the LLM picks one per task",
      ],
      ["own.preset.pool.recommended", "추천 묶음", "Recommended pool"],
      ["own.preset.pool.mainAccount", "메인 계정에서", "On the main account"],
      [
        "own.preset.pool.mainAccountHint",
        "어느 {group} 계정이 메인이든 그 계정에서 돌아요",
        "Runs on whichever {group} account is the main",
      ],
      ["own.preset.pool.mainPaid", "메인 계정 · 종량제 · 돈이 들어요", "Main account · pay-per-use · costs money"],
      ["own.preset.pool.defaults", "모델을 고르지 않으면: {list}", "When no model is named: {list}"],
      ["own.preset.pool.empty", "모델 묶음에 모델을 하나 이상 고르세요", "Pick at least one model for the pool"],
      ["own.preset.pool.refreshCards", "카드 새로 고치기", "Refresh cards"],
      ["own.preset.pool.note", "메모", "Note"],
      ["own.preset.pool.addFromChip", "묶음에 추가…", "Add to pool…"],
      [
        "own.preset.pool.paidCard",
        "돈이 들어요 · 다른 모델로 안 될 때만 써요",
        "Costs money · used only when no other model can",
      ],
      ["own.preset.summary.pool", "모델 {n}개", "{n} models"],
    ]
    for (const [key, korean, english] of keys) {
      expect<string>(presetsKo[key]).toBe(korean)
      expect(presetsEn[key]).toBe(english)
    }
    expect(presetsText("ko", "own.preset.pool.mainAccountHint", { group: "ChatGPT" })).toBe(
      "어느 ChatGPT 계정이 메인이든 그 계정에서 돌아요",
    )
  })

  test("Korean is the default and fills params", () => {
    expect(presetsText("ko", "own.preset.group.shared", { group: "ChatGPT", n: 7 })).toBe(
      "모든 ChatGPT 계정(7개)에서 써요",
    )
    expect(presetsText("ko", "own.preset.paidRow")).toBe("API 키로 돌리기 · 돈이 들어요")
    expect(presetsText("en", "own.preset.caps.concurrent", { n: 3 })).toBe("3 at once")
  })
})
