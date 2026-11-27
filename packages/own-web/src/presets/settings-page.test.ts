// Settings > 프리셋 (07 §7.1, §2.2, §2.6, §5.1): the group tabs (only groups with an account; `siwc` its own group; a
// discovered local provider), the preset list (★ first, `평소대로` always), the group's new-session default model and
// its source label, the ultra levels and `직접 정하기`, the route and section, and that the page and the editor stay
// lazy chunks. Every account and model is fake.
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { en } from "@/i18n/en"
import { ko } from "@/i18n/ko"
import { parseRoute, routePath, SETTINGS_SECTIONS } from "@/routing/routes"
import {
  defaultLabel,
  groupAccounts,
  groupMain,
  capsFields,
  parseCaps,
  PER_SESSION_START,
  presetRows,
  presetTabs,
  starOf,
  ULTRA_CHOICES,
  ultraChoice,
  type CatalogModel,
} from "./model"
import { capsNumbers, presetsText, type PresetsKey } from "./strings"

const SRC = path.join(import.meta.dir, "..")

function account(id: string, kind: Account.View["kind"], providerID: string, status: Account.Status = "ready") {
  return {
    id: Account.ID.make(id),
    kind,
    label: id,
    shortLabel: id.slice(4, 6),
    color: "indigo",
    providerID: Provider.ID.make(providerID),
    billing: kind === "ds" ? "prepaid" : kind === "oai" ? "metered" : "subscription",
    status,
    autoSwitch: false,
    thirdParty: kind === "claude-sub",
    readOnly: false,
    connection: { type: "oauth" },
  } satisfies Account.View
}

function model(providerID: string, id: string, released = 0, price?: number): CatalogModel {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "high" }],
    time: { released },
    cost: price === undefined ? [] : [{ input: price, output: price, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 400_000, output: 128_000 },
  }
}

const ACCOUNTS = [
  account("acc_claude_slot", "claude-sub", "anthropic"),
  account("acc_ds01", "ds", "own-ds-aaaa"),
  account("acc_chatgpt02", "codex", "own-codex-bbbb", "exhausted"),
  account("acc_chatgpt01", "codex", "own-codex-aaaa"),
  account("acc_siwc01", "siwc", "own-siwc-cccc"),
  account("acc_gone", "anth", "own-anth-dddd", "retired"),
]

describe("group tabs (07 §7.1 `ChatGPT | Claude 구독 | DeepSeek | Ollama …`)", () => {
  test("only groups with an account, in the switcher's kind order; siwc is its own group; retired accounts do not count", () => {
    expect(presetTabs(ACCOUNTS, [])).toEqual(["codex", "siwc", "ds", "claude-sub"])
    expect(presetTabs([], [])).toEqual([])
  })

  test("a discovered local provider with models gets a tab after the account groups", () => {
    const models = [model("ollama", "qwen3"), model("lmstudio", "gemma", 0)]
    expect(presetTabs(ACCOUNTS, models)).toEqual([
      "codex",
      "siwc",
      "ds",
      "claude-sub",
      "local:ollama",
      "local:lmstudio",
    ])
    expect(presetTabs(ACCOUNTS, [{ ...model("ollama", "qwen3"), enabled: false }])).not.toContain("local:ollama")
  })

  test("the shared line counts the group's accounts, not other kinds (`모든 ChatGPT 계정(2개)`)", () => {
    expect<unknown>(groupAccounts("codex", ACCOUNTS).map((item) => item.id)).toEqual(["acc_chatgpt02", "acc_chatgpt01"])
    expect(groupAccounts("anth", ACCOUNTS)).toEqual([])
    expect(presetsText("ko", "own.preset.group.shared", { group: "ChatGPT", n: 2 })).toBe(
      "모든 ChatGPT 계정(2개)에서 써요",
    )
    expect(presetsText("ko", "own.preset.groupName.siwc")).toBe(ko["own.acct.kind.siwc"])
  })
})

describe("preset list (★ first, 평소대로 always)", () => {
  const SAVED = Preset.ID.make("pr_01JB0000000000000000000000")
  const OTHER = Preset.ID.make("pr_01JB0000000000000000000001")
  const listed = (id: Preset.ID, name: string): Preset.Listed => ({
    ...Preset.builtin("codex"),
    id,
    name,
    status: "ok",
  })

  test("an older service lists no presets: 평소대로 alone, and it is the ★", () => {
    expect<unknown>(presetRows("codex", undefined).map((item) => item.id)).toEqual(["builtin:codex"])
    expect<unknown>(presetRows("codex", { group: "codex", defaultModel: null }).map((item) => item.id)).toEqual([
      "builtin:codex",
    ])
    expect(starOf("codex", undefined)).toBe(Preset.builtinID("codex"))
  })

  test("the ★ comes first; 평소대로 stays in the list when another preset is the ★", () => {
    const view: Preset.GroupView = {
      group: "codex",
      defaultModel: null,
      presets: [{ ...Preset.builtin("codex"), status: "ok" }, listed(SAVED, "Claude 리뷰"), listed(OTHER, "가볍게")],
      star: OTHER,
    }
    expect<unknown>(presetRows("codex", view).map((item) => item.id)).toEqual([OTHER, "builtin:codex", SAVED])
    expect(starOf("codex", view)).toBe(OTHER)
    // A list without the builtin (a hand-made answer) still shows it.
    const without: Preset.GroupView = { ...view, presets: [listed(SAVED, "Claude 리뷰")], star: undefined }
    expect<unknown>(presetRows("codex", without).map((item) => item.id)).toEqual(["builtin:codex", SAVED])
  })
})

describe("a model pool preset's row (07 §7.1 모델 묶음)", () => {
  test("`모델 묶음에서 알아서 · 모델 n개 · <나눠 맡기기>`, the mode read through Preset.modeOf", async () => {
    const page = (await Bun.file(path.join(SRC, "settings", "presets.tsx")).text()).replaceAll(/^\s*\/\/.*$/gm, "")
    expect(page).toContain("const mode = Preset.modeOf(workers)")
    expect(page).toContain('pool: "own.preset.workers.pool"')
    expect(page).toContain(
      '...(mode === "pool" ? [text("own.preset.summary.pool", { n: workers.pool?.length ?? 0 })] : [])',
    )
    const pooled: Preset.Workers = {
      mode: "same",
      roles: {},
      pool: ["gpt-6-luna", "claude-opus-5-5", "qwen3", "deepseek-v4-pro"].map((id) => ({
        key: id,
        model: Model.ID.make(id),
      })),
    }
    expect(Preset.modeOf(pooled)).toBe("pool")
    expect(
      [
        presetsText("ko", "own.preset.workers.pool"),
        presetsText("ko", "own.preset.summary.pool", { n: pooled.pool?.length ?? 0 }),
        presetsText("ko", "own.preset.delegation.whenUseful"),
      ].join(" · "),
    ).toBe("모델 묶음에서 알아서 · 모델 4개 · 도움될 때")
    expect(presetsText("en", "own.preset.summary.pool", { n: 4 })).toBe("4 models")
  })
})

describe("new-session default model row (07 §2.2, T0 behaviour kept)", () => {
  const models = [
    model("own-codex-aaaa", "gpt-6-luna", 30, 0.1),
    model("own-codex-aaaa", "gpt-6-astra", 20, 10),
    model("own-codex-bbbb", "gpt-6-astra", 20, 10),
    model("ollama", "qwen3"),
  ]

  test("the group default on the group's first account that can serve, with its effort", () => {
    const view: Preset.GroupView = {
      group: "codex",
      defaultModel: {
        id: Model.ID.make("gpt-6-astra"),
        variant: Model.VariantID.make("high"),
        source: "auto",
        basis: "codex-config",
      },
      label: "codex-config",
    }
    expect(groupMain("codex", ACCOUNTS, view.defaultModel, models)).toEqual({
      providerID: "own-codex-aaaa",
      id: "gpt-6-astra",
      variant: "high",
    })
    expect(defaultLabel(view)).toBe("codex-config")
    expect(defaultLabel({ ...view, label: undefined })).toBe("codex-config")
    expect(defaultLabel({ group: "codex", defaultModel: { ...view.defaultModel!, source: "user" } })).toBe("user")
    expect(presetsText("ko", "own.preset.groupDefault.label.codex-config")).toBe("Codex 설정을 따름")
  })

  test("a default the account does not offer falls back to the group rule; a local group uses its provider", () => {
    const gone: Preset.DefaultModel = { id: Model.ID.make("gpt-5.5"), source: "auto" }
    expect(groupMain("codex", ACCOUNTS, gone, models)?.providerID).toBe("own-codex-aaaa")
    expect(groupMain("local:ollama", ACCOUNTS, null, models)).toEqual({ providerID: "ollama", id: "qwen3" })
    expect(groupMain("oai", ACCOUNTS, null, models)).toBeUndefined()
  })

  test("a ChatGPT login's free models are priced by their API twins, like the service (07 §2.2 siwc)", () => {
    const priced = [
      model("own-siwc-cccc", "gpt-6-luna", 30),
      model("own-siwc-cccc", "gpt-6-astra", 20),
      // The API catalog's same models carry the prices; the login itself is plan-billed (`cost: []`).
      { ...model("openai", "gpt-6-luna", 30, 0.1), enabled: false },
      { ...model("openai", "gpt-6-astra", 20, 10), enabled: false },
    ]
    // The newest model of the most expensive family, not the newest model.
    expect(groupMain("siwc", ACCOUNTS, null, priced)).toEqual({ providerID: "own-siwc-cccc", id: "gpt-6-astra" })
  })
})

describe("ultra caps (07 §2.6: 아껴서 / 추천 / 크게 / 직접 정하기)", () => {
  test("the levels are the protocol's numbers; 추천 is the default", () => {
    expect(ULTRA_CHOICES).toEqual(["save", "recommended", "large", "custom"])
    expect(Preset.levelCaps("save")).toEqual({ concurrent: 3, perMessage: 12, perSession: null })
    expect(Preset.levelCaps(Preset.ULTRA_LEVEL)).toEqual({ concurrent: 8, perMessage: 24, perSession: null })
    expect(Preset.levelCaps("large")).toEqual({ concurrent: 64, perMessage: 128, perSession: null })
    expect(ultraChoice("recommended")).toBe("recommended")
    expect(ultraChoice({ concurrent: 4, perMessage: 8, perSession: 50 })).toBe("custom")
    expect(presetsText("ko", "own.preset.ultraLevel.recommended")).toBe("추천")
    // No level caps the conversation: the numbers line says 제한 없음 (SC 2026-11-03).
    const ko = (key: PresetsKey, params?: Readonly<Record<string, string | number>>) => presetsText("ko", key, params)
    expect(capsNumbers(ko, Preset.levelCaps("recommended"))).toBe("동시 8 · 메시지당 24 · 대화당 제한 없음")
    expect(capsNumbers(ko, { concurrent: 4, perMessage: 8, perSession: 50 })).toBe("동시 4 · 메시지당 8 · 대화당 50")
  })

  test("직접 정하기 takes whole numbers of 1 or more", () => {
    expect(parseCaps({ concurrent: "4", perMessage: " 8 ", perSession: "50" })).toEqual({
      concurrent: 4,
      perMessage: 8,
      perSession: 50,
    })
    expect(parseCaps({ concurrent: "0", perMessage: "8", perSession: "50" })).toBeUndefined()
    expect(parseCaps({ concurrent: "2.5", perMessage: "8", perSession: "50" })).toBeUndefined()
    expect(parseCaps({ concurrent: "", perMessage: "8", perSession: "50" })).toBeUndefined()
  })

  test("직접 정하기 needs no conversation cap: off is 제한 없음, on needs a whole number", () => {
    expect(parseCaps({ concurrent: "4", perMessage: "8", perSession: null })).toEqual({
      concurrent: 4,
      perMessage: 8,
      perSession: null,
    })
    expect(parseCaps({ concurrent: "4", perMessage: "8", perSession: "" })).toBeUndefined()
    expect(capsFields(Preset.levelCaps("save"))).toEqual({ concurrent: "3", perMessage: "12", perSession: null })
    expect(PER_SESSION_START).toBe("100")
  })
})

describe("route, section and lazy chunks", () => {
  test("/settings/presets is a section; the merged devices and experimental sections stay", () => {
    expect(SETTINGS_SECTIONS).toContain("presets")
    expect(SETTINGS_SECTIONS).toContain("devices")
    expect(SETTINGS_SECTIONS).toContain("experimental")
    expect(parseRoute("/settings/presets").route).toEqual({ name: "settings", section: "presets" })
    expect(routePath({ name: "settings", section: "presets" })).toBe("/settings/presets")
    expect(ko["own.settings.presets"]).toBe("프리셋")
    expect(en["own.settings.presets"]).toBe("Presets")
  })

  test("the page and the editor are lazy: only dynamic imports reach them", async () => {
    const index = await Bun.file(path.join(SRC, "settings", "index.tsx")).text()
    expect(index).toContain('lazy(() => import("./presets"))')
    const page = await Bun.file(path.join(SRC, "settings", "presets.tsx")).text()
    expect(page).toContain('lazy(() => import("@/presets/editor"))')
    // A static import would put them in the importer's chunk (the first one, for the composer).
    const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC)]
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !/\.test\.tsx?$/.test(file))
    const statically = (file: string) => {
      const local = file.startsWith("presets/") ? "|\\./editor" : file.startsWith("settings/") ? "|\\./presets" : ""
      return new RegExp(String.raw`^import[^;]*from\s+["'](@/presets/editor|@/settings/presets${local})["']`, "m")
    }
    const offenders = await Promise.all(
      files.map(async (file) => (statically(file).test(await Bun.file(path.join(SRC, file)).text()) ? [file] : [])),
    )
    expect(offenders.flat()).toEqual([])
  })
})
