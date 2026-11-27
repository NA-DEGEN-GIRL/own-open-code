// The 2026-10-01 catalog (07 Appendix A, 07 §4.1: `gpt-6.1-sol` arrived on 09-29) as the fold sees it, and a harness
// for the presets tests: real slots and presets modules on a temp OWN_HOME, a fake fold over these catalogs, a fake
// Claude slot, core's model list for local providers, recorded events and alerts. Prices and ids follow models.dev of
// that day; accounts, logins and fingerprints are made up. No test reads this PC's `.codex` or any real credential.

import fs from "node:fs/promises"
import path from "node:path"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { Model } from "@opencode/schema/model"
import { Account, Kind, OwnID, type Registry } from "@own/protocol"
import { Modules } from "../../../src/modules.js"
import type { Plugins } from "../../../src/plugins/plugins.js"
import { Presets } from "../../../src/presets/presets.js"
import type { PresetResolve } from "../../../src/presets/resolve.js"
import type { RpcTypes } from "../../../src/rpc/types.js"
import { Templates } from "../../../src/slots/templates.js"
import type { Telemetry } from "../../../src/telemetry/telemetry.js"
import { testDeps } from "../../support/deps.js"
import { catalogModel, fakeEditor, memoryStorage, price, registryWith, type AccountSeed } from "../../slots/support.js"

const at = (month: number, day: number, year = 2026) => Date.UTC(year, month - 1, day)
export const SEP_22 = at(9, 22)
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

/** One catalog model of the day: input price (USD per 1M), family, release date, levels, tools, status, mode base. */
export function model(
  providerID: string,
  id: string,
  input: {
    readonly family: string
    readonly released: number
    readonly price?: number
    readonly variants?: ReadonlyArray<string>
    readonly tools?: boolean
    readonly status?: Model.Info["status"]
    /** A mode entry (`-fast`, `-pro`) names its base model here. */
    readonly base?: string
  },
): Model.Info {
  const base = catalogModel(providerID, id)
  return {
    ...base,
    modelID: Model.ID.make(input.base ?? id),
    family: Model.Family.make(input.family),
    time: { released: input.released },
    cost: input.price === undefined ? [] : [price(input.price, input.price * 5)],
    variants: (input.variants ?? EFFORTS).map((variant) => ({ id: Model.VariantID.make(variant) })),
    capabilities: { ...base.capabilities, tools: input.tools ?? true },
    status: input.status ?? "active",
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  }
}

/**
 * `openai`: Sol and Luna came out the same day after Astra, 6.1 Sol on 09-29. Cheaper decoys a lighter pair must skip:
 * a mode entry, an alpha model, a deprecated one and a tool-less one.
 */
export const OPENAI: ReadonlyArray<Model.Info> = [
  model("openai", "gpt-5.5", { family: "gpt", released: at(4, 23), price: 5, variants: EFFORTS.slice(0, 4) }),
  model("openai", "gpt-5.6-sol", { family: "gpt-sol", released: at(7, 9), price: 4 }),
  model("openai", "gpt-5.6-terra", { family: "gpt-terra", released: at(7, 9), price: 2 }),
  model("openai", "gpt-5.6-luna", { family: "gpt-luna", released: at(7, 9), price: 0.2 }),
  model("openai", "gpt-6-astra", {
    family: "gpt-astra",
    released: at(9, 4),
    price: 10,
    variants: [...EFFORTS, "ultra"],
  }),
  model("openai", "gpt-6-astra-fast", { family: "gpt-astra", released: at(9, 4), price: 0.01, base: "gpt-6-astra" }),
  model("openai", "gpt-6-sol", { family: "gpt-sol", released: SEP_22, price: 2, variants: [...EFFORTS, "ultra"] }),
  model("openai", "gpt-6-luna", { family: "gpt-luna", released: SEP_22, price: 0.1 }),
  model("openai", "gpt-6.1-sol", { family: "gpt-sol", released: at(9, 29), price: 2, variants: [...EFFORTS, "ultra"] }),
  model("openai", "gpt-6-mini", { family: "gpt-mini", released: at(9, 30), price: 0.05, status: "alpha" }),
  model("openai", "gpt-6-nano", { family: "gpt-nano", released: at(9, 1), price: 0.02, status: "deprecated" }),
  model("openai", "gpt-6-pico", { family: "gpt-pico", released: SEP_22, price: 0.01, tools: false }),
]

/** `anthropic` as models.dev has it (the Claude slot's catalog before claude-auth removes the prices). */
export const ANTHROPIC: ReadonlyArray<Model.Info> = [
  model("anthropic", "claude-haiku-4-5", { family: "claude-haiku", released: at(10, 15, 2025), price: 1 }),
  model("anthropic", "claude-sonnet-5", { family: "claude-sonnet", released: at(6, 22), price: 2 }),
  model("anthropic", "claude-opus-5", { family: "claude-opus", released: at(7, 24), price: 5 }),
  model("anthropic", "claude-opus-5-5", { family: "claude-opus", released: SEP_22, price: 4 }),
  model("anthropic", "claude-opus-5-5-fast", {
    family: "claude-opus",
    released: SEP_22,
    price: 0.5,
    base: "claude-opus-5-5",
  }),
  model("anthropic", "claude-fable-5-1", { family: "claude-fable", released: at(9, 1), price: 10 }),
]

/** `deepseek`: three levels only (low, high, max). */
export const DEEPSEEK: ReadonlyArray<Model.Info> = [
  model("deepseek", "deepseek-v4-pro", {
    family: "deepseek-thinking",
    released: at(8, 12),
    price: 0.435,
    variants: ["low", "high", "max"],
  }),
  model("deepseek", "deepseek-flash", {
    family: "deepseek-flash",
    released: at(9, 10),
    price: 0.15,
    variants: ["low", "high", "max"],
  }),
]

/** A discovered Ollama model as core lists it (`local:ollama`): no price, no levels. */
export const OLLAMA: Model.Info = {
  ...model("ollama", "qwen3-coder:30b", { family: "qwen3", released: 0, variants: [] }),
  cost: [],
}

/** ChatGPT logins (`sha256:` form of `chatgpt_account_id:sub`). */
export const LOGIN_01 = `sha256:${"1".repeat(64)}`
export const LOGIN_02 = `sha256:${"2".repeat(64)}`

/** The accounts: two ChatGPT logins, Sign in with ChatGPT on login 01 and on an unknown login, an OpenAI API key, DeepSeek. */
export const CHATGPT_01 = Account.ID.make("acc_aaaa")
export const CHATGPT_02 = Account.ID.make("acc_bbbb")
export const SIWC_01 = Account.ID.make("acc_ssss")
export const SIWC_UNKNOWN = Account.ID.make("acc_uuuu")
export const OPENAI_KEY = Account.ID.make("acc_kkkk")
export const DEEPSEEK_KEY = Account.ID.make("acc_dddd")
export const CLAUDE = Account.ID.claudeSlot

export const CODEX_A = Kind.ProviderID.from("codex", "aaaa")
export const CODEX_B = Kind.ProviderID.from("codex", "bbbb")
export const SIWC_A = Kind.ProviderID.from("siwc", "ssss")
export const OAI = Kind.ProviderID.from("oai", "kkkk")
export const DS = Kind.ProviderID.from("ds", "dddd")

export const SEATS: ReadonlyArray<AccountSeed> = [
  { kind: "codex", label: "ChatGPT 01", slug: "aaaa", identity: { fingerprint: LOGIN_01 } },
  { kind: "codex", label: "ChatGPT 02", slug: "bbbb", identity: { fingerprint: LOGIN_02, login: LOGIN_02 } },
  { kind: "siwc", label: "Sign in 01", slug: "ssss", identity: { fingerprint: "sha256:c1", login: LOGIN_01 } },
  { kind: "siwc", label: "Sign in ?", slug: "uuuu", identity: { fingerprint: "sha256:c2" } },
  { kind: "oai", label: "OpenAI key", slug: "kkkk" },
  { kind: "ds", label: "DeepSeek", slug: "dddd" },
]

export const CLAUDE_ON: Plugins.ClaudeSlot = {
  detected: true,
  version: "1.0.0",
  integrity: "sha512-x",
  verified: true,
}
export const CLAUDE_OFF: Plugins.ClaudeSlot = { detected: false, version: null, integrity: null, verified: false }

/** A registry whose slots carry templates built from this catalog (the same rules a fresh capture applies). */
export async function registry(seeds: ReadonlyArray<AccountSeed> = SEATS, openai = OPENAI): Promise<Registry.File> {
  const base = await registryWith(seeds)
  const sources = [
    ["codex", openai],
    ["siwc", openai],
    ["oai", openai],
    ["ds", DEEPSEEK],
  ] as const
  const built = sources.flatMap(([kind, models]) => {
    const id = templateID(kind)
    if (!(id in base.modelTemplates)) return []
    const result = Templates.fromCatalog(kind, models, "2026-10-01T00:00:00Z")
    if (!result.ok) throw new Error(`template ${kind}: ${result.reason}`)
    return [[id, result.template] as const]
  })
  return { ...base, modelTemplates: { ...base.modelTemplates, ...Object.fromEntries(built) } }
}

export interface HarnessInput {
  readonly registry?: Registry.File
  readonly catalog?: Readonly<Record<string, ReadonlyArray<Model.Info>>>
  readonly claude?: Plugins.ClaudeSlot
  /** Core's model list of this Location (discovered local providers). */
  readonly listed?: ReadonlyArray<Model.Info>
  readonly codex?: Readonly<Record<string, string>>
  readonly resolver?: PresetResolve.Options
}

export interface Recorded {
  readonly name: string
  readonly payload: unknown
}

/** Real slots and presets modules over the fixture catalogs; the Claude slot and core's model list are switchable. */
export async function harness(input: HarnessInput = {}) {
  const kv = memoryStorage()
  const listed = { value: input.listed ?? [] }
  const t = await testDeps({
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: listed.value }) },
      storage: kv.storage,
    },
  })
  const codexHome = path.join(t.home, "codex-fixture")
  await fs.mkdir(codexHome)
  await Promise.all(
    Object.entries(input.codex ?? {}).map(([name, text]) => fs.writeFile(path.join(codexHome, name), text)),
  )
  const deps = { ...t.deps, options: { ...t.deps.options, codexHome } }
  await deps.runtime.registry.write(input.registry ?? (await registry()))
  const claude = { value: input.claude ?? CLAUDE_ON }
  const alerts: Telemetry.AlertInput[] = []
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => claude.value }),
    telemetry: (base, peers) => ({ ...Modules.FACTORIES.telemetry(base, peers), alert: (alert) => alerts.push(alert) }),
    presets: (base, peers) => Presets.create(base, peers, { resolver: input.resolver }),
  })
  await modules.slots.start()
  await modules.presets.start()
  const catalogs = input.catalog ?? { openai: OPENAI, anthropic: ANTHROPIC, deepseek: DEEPSEEK }
  const fold = () =>
    modules.slots.transformProviders(
      fakeEditor(Object.fromEntries(Object.entries(catalogs).map(([id, models]) => [id, { models }]))).editor,
    )
  fold()
  const events: Recorded[] = []
  // SAFETY: the fake implements the only member the emitter uses, `events.emit`.
  const registration = {
    events: { emit: async (name: string, payload: unknown) => void events.push({ name, payload }) },
  }
  deps.emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
  const presets = modules.presets
  return {
    t,
    deps,
    kv,
    modules,
    presets,
    alerts,
    events,
    claude,
    listed,
    file: () => deps.runtime.presets.read(),
    /** Folds again over changed catalogs (a `models-dev.refreshed`). */
    refold: (next: Readonly<Record<string, ReadonlyArray<Model.Info>>>) => {
      Object.assign(catalogs, next)
      fold()
    },
    async [Symbol.asyncDispose]() {
      await presets.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

export type Harness = Awaited<ReturnType<typeof harness>>

/** A template id of the test registry (`tpl_<kind>_test`). */
export function templateID(kind: Kind.Own) {
  return OwnID.TemplateID.make(`tpl_${kind}_test`)
}
