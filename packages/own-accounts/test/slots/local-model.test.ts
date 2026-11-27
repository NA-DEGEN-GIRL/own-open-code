// Local models (02 §3.3a): the package each format registers with, the effort variants of each reasoning style and
// format (Chat Completions `reasoning_effort`, Responses `reasoning.effort`, `enable_thinking`, Anthropic thinking
// budgets), which base URLs count as this PC or the local network, and how the registry follows: a server naming its
// levels in `/models`, `로컬 모델로 바꾸기`, the user's reasoning setting, and the start migration of a compat account
// on a local address.
import { describe, expect, test } from "bun:test"
import { Account, OwnID, type Registry } from "@own/protocol"
import { CompatProbe } from "../../src/slots/compat-probe.js"
import { LocalModel } from "../../src/slots/local-model.js"
import { Templates } from "../../src/slots/templates.js"

const accountID = Account.ID.make("acc_local")
const providerID = "own-compat-l0ca"
const templateID = OwnID.TemplateID.make("tpl_compat_l0ca")

function registry(compat?: Account.Compat, baseURL = "http://127.0.0.1:8000/v1", cost: boolean = false): Registry.File {
  const built = Templates.fromCompat(
    [
      {
        id: "local-flash-1",
        contextLimit: 1_048_576,
        outputLimit: 32_000,
        ...(cost ? { cost: { input: 1, output: 2 } } : {}),
      },
      { id: "plain", contextLimit: 32_768 },
    ],
    "2026-11-03T00:00:00.000Z",
  )
  if (!built.ok) throw new Error(built.reason)
  return {
    schemaVersion: 1,
    revision: 1,
    cacheDomains: {},
    quotaDomains: {},
    accounts: [
      {
        id: accountID,
        kind: "compat",
        label: "Local",
        shortLabel: "L",
        color: "teal",
        providerID: providerID as Account.Info["providerID"],
        cacheDomain: OwnID.CacheDomainID.make("cd_l0ca"),
        quotaDomain: OwnID.QuotaDomainID.make("qd_l0ca"),
        billing: "metered",
        identity: {},
        autoSwitch: true,
        status: "ready",
        ...(compat ? { compat } : {}),
      },
    ],
    slots: {
      [providerID]: { kind: "compat", accounts: [accountID], pooling: "off", modelTemplate: templateID, baseURL },
    } as Registry.File["slots"],
    modelTemplates: { [templateID]: built.template },
  }
}

const modelsOf = (file: Registry.File | undefined) => file?.modelTemplates[templateID]?.models ?? []

describe("effort variants per format (02 §3.3a)", () => {
  const levels = { style: "effort", levels: ["low", "high", "xhigh", "max"] } as const

  test("Chat Completions, Ollama and Responses send the level as the effort", () => {
    for (const format of ["chat", "ollama", "responses"] as const)
      expect(LocalModel.variants(levels, format, 32_000)).toEqual(
        levels.levels.map((level) => ({ id: level, settings: { reasoningEffort: level } })) as never,
      )
  })

  test("a toggle sends enable_thinking; Ollama turns it with its effort none or high", () => {
    expect(LocalModel.variants({ style: "toggle" }, "chat", 32_000)).toEqual([
      { id: "none", body: { chat_template_kwargs: { enable_thinking: false } } },
      { id: "thinking", body: { chat_template_kwargs: { enable_thinking: true } } },
    ] as never)
    expect(LocalModel.variants({ style: "toggle" }, "ollama", 32_000)).toEqual([
      { id: "none", settings: { reasoningEffort: "none" } },
      { id: "thinking", settings: { reasoningEffort: "high" } },
    ] as never)
  })

  test("Anthropic: thinking budgets up to the output cap, none turns thinking off", () => {
    expect(LocalModel.variants({ style: "effort", levels: ["none", "low", "high"] }, "anthropic", 16_001)).toEqual([
      { id: "none", settings: { thinking: { type: "disabled" } } },
      { id: "low", settings: { thinking: { type: "enabled", budgetTokens: 8_000 } } },
      { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
    ] as never)
    expect(LocalModel.variants({ style: "budget" }, "anthropic", 64_000).map((variant) => String(variant.id))).toEqual([
      "none",
      "high",
      "max",
    ])
    // Too small an output cap for any budget: no variants.
    expect(LocalModel.variants({ style: "budget" }, "anthropic", 512)).toEqual([])
    // A budget is Anthropic's only.
    expect(LocalModel.variants({ style: "budget" }, "chat", 64_000)).toEqual([])
  })

  test("no reasoning, no variants; a level given twice is offered once", () => {
    expect(LocalModel.variants(undefined, "chat", 32_000)).toEqual([])
    expect(
      LocalModel.variants({ style: "effort", levels: ["low", "low", "high"] }, "chat", 32_000).map(
        (variant) => String(variant.id),
      ),
    ).toEqual(["low", "high"])
  })

  test("the setting wins over what the server reported; off sends none", () => {
    const detected = { reasoning: levels }
    expect(LocalModel.reasoningOf({ detected })).toEqual(levels)
    expect(LocalModel.reasoningOf({ detected, reasoning: "off" })).toBeUndefined()
    expect(LocalModel.reasoningOf({ detected, reasoning: { style: "toggle" } })).toEqual({ style: "toggle" })
    expect(LocalModel.reasoningOf({ detected: { reasoning: null } })).toBeUndefined()
    expect(LocalModel.reasoningOf(undefined)).toBeUndefined()
  })

  test("each format's package", () => {
    expect(LocalModel.packageOf(undefined)).toBe("@opencode/ai/providers/openai-compatible")
    expect(LocalModel.packageOf({ local: { format: "responses" } })).toBe(
      "@opencode/ai/providers/openai/responses",
    )
    expect(LocalModel.packageOf({ local: { format: "anthropic" } })).toBe("@opencode/ai/providers/anthropic-compatible")
    expect(LocalModel.packageOf({ local: { format: "ollama" } })).toBe("@opencode/ai/providers/openai-compatible")
  })
})

describe("local addresses (02 §3.3a)", () => {
  test("this PC and private networks", () => {
    for (const url of [
      "http://localhost:64644/v1",
      "http://127.0.0.1:11434/v1",
      "http://[::1]:8080/v1",
      "http://192.168.1.57:8088/v1",
      "http://10.0.0.4/v1",
      "http://172.20.1.1:8000/v1",
      "http://100.101.102.103:1234/v1",
      "http://gpu-box.local:8000/v1",
      "http://[fd12:3456::1]:8000/v1",
    ])
      expect(LocalModel.isLocalURL(url)).toBe(true)
  })

  test("public hosts and nonsense are not", () => {
    for (const url of [
      "https://api.fireworks.ai/inference/v1",
      "http://172.32.0.1/v1",
      "http://8.8.8.8/v1",
      "not a url",
      undefined,
    ])
      expect(LocalModel.isLocalURL(url)).toBe(false)
  })
})

describe("the registry follows (02 §3.3a)", () => {
  const result = (reasoning: Account.Reasoning | null | undefined): CompatProbe.Result => ({
    family: "vllm",
    outputs: new Map(),
    capabilities: new Map([
      ["local-flash-1", reasoning === undefined ? {} : { reasoning }],
      ["plain", {}],
    ]),
  })

  test("levels a server names register as variants; a model it says nothing of keeps none", () => {
    const read = CompatProbe.apply(
      registry({ local: { format: "chat" } }),
      accountID,
      result({
        style: "effort",
        levels: ["low", "high", "xhigh", "max"],
        default: "max",
      }),
    )
    const models = modelsOf(read)
    expect(models[0]?.variants.map((variant) => String(variant.id))).toEqual(["low", "high", "xhigh", "max"])
    expect(models[0]?.variants[1]).toEqual({ id: "high", settings: { reasoningEffort: "high" } } as never)
    expect(models[1]?.variants).toEqual([])
    expect(read?.accounts[0]?.compat?.server?.reasoningRead).toBe(true)
  })

  test("로컬 모델로 바꾸기: the format's package, the settings kept; back again marks it not local", () => {
    const start = registry({
      capabilities: { "local-flash-1": { image: "on", detected: { reasoning: { style: "toggle" } } } },
    })
    const made = CompatProbe.localize(start, accountID, { format: "anthropic" })
    expect(made?.accounts[0]?.compat).toEqual({
      capabilities: { "local-flash-1": { image: "on", detected: { reasoning: { style: "toggle" } } } },
      local: { format: "anthropic" },
    })
    expect(modelsOf(made).map((model) => model.package)).toEqual([
      "@opencode/ai/providers/anthropic-compatible",
      "@opencode/ai/providers/anthropic-compatible",
    ])
    expect(modelsOf(made)[0]?.variants.map((variant) => String(variant.id))).toEqual(["none", "thinking"])
    // Image input stays as it was set.
    expect(modelsOf(made)[0]?.capabilities.input).toEqual(["text", "image"])
    const back = CompatProbe.localize(made!, accountID, null)
    expect(back?.accounts[0]?.compat?.local).toBeUndefined()
    expect(back?.accounts[0]?.compat?.notLocal).toBe(true)
    expect(modelsOf(back).map((model) => model.package)).toEqual([
      "@opencode/ai/providers/openai-compatible",
      "@opencode/ai/providers/openai-compatible",
    ])
    // A keyless local model keeps `keyless` when its format changes.
    const keyless = CompatProbe.localize(registry({ local: { format: "chat", keyless: true } }), accountID, {
      format: "responses",
    })
    expect(keyless?.accounts[0]?.compat?.local).toEqual({ format: "responses", keyless: true })
  })

  test("the user's reasoning setting registers its variants; auto follows the server again", () => {
    const start = CompatProbe.apply(registry({ local: { format: "chat" } }), accountID, result(undefined))!
    expect(modelsOf(start)[0]?.variants).toEqual([])
    const set = CompatProbe.configure(start, accountID, [
      { id: "local-flash-1", reasoning: { style: "effort", levels: ["low", "max"] } },
    ])
    if (!set.ok) throw new Error("refused")
    expect(modelsOf(set.registry)[0]?.variants.map((variant) => String(variant.id))).toEqual(["low", "max"])
    const view = CompatProbe.view(set.registry!.accounts[0]!, modelsOf(set.registry), () => undefined)
    expect(view.local).toEqual({ format: "chat" })
    expect(view.models[0]?.reasoning).toEqual({
      setting: { style: "effort", levels: ["low", "max"] },
      detected: undefined,
      levels: ["low", "max"],
    } as never)
    const auto = CompatProbe.configure(set.registry!, accountID, [{ id: "local-flash-1", reasoning: "auto" }])
    if (!auto.ok) throw new Error("refused")
    expect(modelsOf(auto.registry)[0]?.variants).toEqual([])
  })

  test("a compat account on a local address without rates is made local at start, once", () => {
    const local = registry()
    const slot = local.slots[providerID as keyof typeof local.slots]!
    expect(CompatProbe.migratable(local.accounts[0]!, slot, modelsOf(local))).toBe(true)
    // Rates mean money: it stays `기타 OpenAI 호환` (the card offers the change).
    const priced = registry(undefined, "http://127.0.0.1:8000/v1", true)
    expect(CompatProbe.migratable(priced.accounts[0]!, slot, modelsOf(priced))).toBe(false)
    const remote = registry(undefined, "https://api.fireworks.ai/inference/v1")
    const remoteSlot = remote.slots[providerID as keyof typeof remote.slots]!
    expect(CompatProbe.migratable(remote.accounts[0]!, remoteSlot, modelsOf(remote))).toBe(false)
    const declined = registry({ notLocal: true })
    expect(CompatProbe.migratable(declined.accounts[0]!, slot, modelsOf(declined))).toBe(false)
    const already = registry({ local: { format: "chat" } })
    expect(CompatProbe.migratable(already.accounts[0]!, slot, modelsOf(already))).toBe(false)
  })

  test("a local model is free for the money rules; its stored billing stays metered", () => {
    const account = registry({ local: { format: "chat" } }).accounts[0]!
    expect(account.billing).toBe("metered")
    expect(Account.chargeOf(account)).toBe("local")
    expect(Account.chargeOf(registry().accounts[0]!)).toBe("metered")
  })
})
