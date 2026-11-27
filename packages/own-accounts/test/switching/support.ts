// Shared fixtures of the switching tests: the development ratecard seed (02 §6.2 values), estimator sides with the
// 02 §6.4 common assumptions, a small registry, and partial fakes of peer modules. Every credential is fake.

import path from "node:path"
import { Schema } from "effect"
import { Compaction, Ratecard, Registry, type Kind } from "@own/protocol"
import type { ClaudeAgent } from "../../src/claude-agent/agent.js"
import { Estimator } from "../../src/switching/estimator.js"
import { Rates } from "../../src/switching/rates.js"
import { REPO_ROOT } from "../e2e-kit"

export const SEED = path.join(REPO_ROOT, "own/config/ratecards.default.json")

export async function seedCards() {
  return Schema.decodeUnknownSync(Ratecard.File)(await Bun.file(SEED).json())
}

export const NOW = Date.UTC(2026, 8, 27, 3, 0, 0)
export const K = 1_000

/** 02 §6.4 common assumptions: P = 153k (L = 150k + 3k new), Z = 12k, δ = 3k, S_sum = 8k, m = 2k, seed 6k. */
export function context(overrides: Partial<Estimator.Context> = {}): Estimator.Context {
  return {
    now: NOW,
    epoch: 0,
    P: 153 * K,
    Z: 12 * K,
    Zu1: 14 * K,
    Zpre: 8 * K,
    delta: 3 * K,
    summary: 8 * K,
    message: 2 * K,
    seed: 6 * K,
    keep: Compaction.KEEP_TOKENS,
    horizon: 20,
    d9: true,
    ...overrides,
  }
}

export function cache(overrides: Partial<Estimator.SlotCache> & { readonly modelID: string }): Estimator.SlotCache {
  return {
    lastReqAt: NOW - 60_000,
    L: 150 * K,
    epoch: 0,
    variant: "high",
    blocksSince: 0,
    messageEndsSince: 0,
    watermark: false,
    ...overrides,
  }
}

export function side(
  cards: Ratecard.File,
  input: {
    readonly providerID: string
    readonly kind: Kind.Any
    readonly modelID: string
    readonly variant?: string
    readonly cacheDomain?: string
    readonly quotaDomain?: string
    readonly poolingVerified?: boolean
    readonly billing?: Estimator.Side["billing"]
    readonly cache?: Estimator.SlotCache
    readonly window?: number
    readonly oneHour?: boolean
    readonly catalog?: Rates.CatalogCost
  },
): Estimator.Side {
  const window = input.window ?? 272 * K
  return {
    providerID: input.providerID,
    kind: input.kind,
    modelID: input.modelID,
    variant: input.variant ?? "high",
    cacheDomain: input.cacheDomain ?? `cd_${input.providerID}`,
    quotaDomain: input.quotaDomain,
    poolingVerified: input.poolingVerified ?? false,
    billing: input.billing ?? (input.kind === "codex" ? "subscription" : "metered"),
    rates: Rates.resolve({
      kind: input.kind,
      card: Rates.match(cards.cards, input.kind, input.modelID),
      catalog: input.catalog,
      oneHour: input.oneHour,
    }),
    cache: input.cache,
    window,
    trigger:
      Compaction.resolve(Compaction.chain({ kind: input.kind, modelID: input.modelID }), { context: window })
        ?.triggerTokens ?? Number.POSITIVE_INFINITY,
  }
}

const decodeRegistry = Schema.decodeUnknownSync(Registry.File)

const template = (kind: Kind.Own, models: ReadonlyArray<{ id: string; input: number; cost?: unknown[] }>) => ({
  kind,
  source: "snapshot",
  capturedAt: "2026-09-26T11:02:00Z",
  models: models.map((model) => ({
    id: model.id,
    modelID: model.id,
    name: model.id.toUpperCase(),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    time: { released: 0 },
    cost: model.cost ?? [],
    status: "active",
    enabled: true,
    limit: { context: model.input + 128_000, input: model.input, output: 128_000 },
  })),
})

const account = (input: {
  id: string
  kind: Kind.Own
  providerID: string
  billing: string
  autoSwitch: boolean
  quotaDomain?: string
}) => ({
  id: input.id,
  kind: input.kind,
  label: input.id,
  shortLabel: input.id.slice(-1),
  color: "violet",
  providerID: input.providerID,
  cacheDomain: `cd_${input.providerID.slice(-4)}`,
  quotaDomain: input.quotaDomain ?? `qd_${input.providerID.slice(-4)}`,
  billing: input.billing,
  identity: {},
  autoSwitch: input.autoSwitch,
  status: "ready",
})

/** Two codex seats (subscription) and two OpenAI API keys (metered, auto-switch allowed). */
export const PROVIDERS = {
  codexA: "own-codex-aaaa",
  codexB: "own-codex-bbbb",
  oaiA: "own-oai-cccc",
  oaiB: "own-oai-dddd",
} as const

export function registry() {
  const slot = (kind: Kind.Own, accountID: string, templateID: string) => ({
    kind,
    accounts: [accountID],
    pooling: "off",
    modelTemplate: templateID,
    defaultModel: { id: kind === "codex" ? "gpt-5.6-sol" : "gpt-5.5", variant: "high" },
  })
  const oaiCost = [{ input: 1.25, output: 10, cache: { read: 0.125, write: 1.25 } }]
  return decodeRegistry({
    schemaVersion: 1,
    revision: 3,
    cacheDomains: Object.fromEntries(
      Object.values(PROVIDERS).map((providerID) => [
        `cd_${providerID.slice(-4)}`,
        { kind: providerID.split("-")[1], scope: "api_key", poolingVerified: false },
      ]),
    ),
    quotaDomains: Object.fromEntries(
      Object.values(PROVIDERS).map((providerID) => [
        `qd_${providerID.slice(-4)}`,
        { kind: providerID.split("-")[1], scope: "api_key" },
      ]),
    ),
    accounts: [
      account({
        id: "acc_codexA",
        kind: "codex",
        providerID: PROVIDERS.codexA,
        billing: "subscription",
        autoSwitch: false,
      }),
      account({
        id: "acc_codexB",
        kind: "codex",
        providerID: PROVIDERS.codexB,
        billing: "subscription",
        autoSwitch: false,
      }),
      account({ id: "acc_oaiA", kind: "oai", providerID: PROVIDERS.oaiA, billing: "metered", autoSwitch: true }),
      account({ id: "acc_oaiB", kind: "oai", providerID: PROVIDERS.oaiB, billing: "metered", autoSwitch: true }),
    ],
    slots: {
      [PROVIDERS.codexA]: slot("codex", "acc_codexA", "tpl_codex"),
      [PROVIDERS.codexB]: slot("codex", "acc_codexB", "tpl_codex"),
      [PROVIDERS.oaiA]: slot("oai", "acc_oaiA", "tpl_oai"),
      [PROVIDERS.oaiB]: slot("oai", "acc_oaiB", "tpl_oai"),
    },
    modelTemplates: {
      tpl_codex: template("codex", [
        { id: "gpt-5.6-sol", input: 272_000 },
        { id: "gpt-5.6-terra", input: 272_000 },
      ]),
      tpl_oai: template("oai", [{ id: "gpt-5.5", input: 272_000, cost: oaiCost }]),
    },
  })
}

/** The Claude Agent module without an account (02 §8.10): no route account, so nothing of it applies. */
export function noClaudeAgent(parts: Partial<ClaudeAgent.Api> = {}) {
  return partial<ClaudeAgent.Api>("claudeAgent", {
    account: () => undefined,
    member: () => undefined,
    lookup: () => undefined,
    ttl: () => "1h",
    views: () => [],
    ...parts,
  })
}

/**
 * A peer module with only the members a test provides; touching any other member throws, like the strict context
 * of `test/support/deps.ts`.
 */
export function partial<T extends object>(name: string, parts: Partial<T>): T {
  const proxy = new Proxy(parts, {
    get: (target, key) => {
      if (typeof key === "symbol" || key === "then") return undefined
      if (key in target) return Object.getOwnPropertyDescriptor(target, key)?.value
      throw new Error(`test peer: ${name}.${key} was not provided`)
    },
  })
  // SAFETY: tests provide the members the code under test uses; any other access throws above.
  return proxy as T
}
