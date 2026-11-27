// Examples from own/docs/02-accounts-providers-cache.md with comments removed and "…" placeholders replaced by
// well-formed fake values. No real credentials.

import { Schema } from "effect"
import { Preserve } from "../src/preserve.js"

/**
 * Decodes wire JSON and encodes it back, returning the re-encoded value for comparison with the input. `keepUnknown`
 * rewrites it the way the registry store does, keeping the keys the schema does not declare.
 */
export function roundTrip(
  schema: Schema.Codec<unknown, unknown>,
  value: unknown,
  options?: { readonly keepUnknown?: boolean },
): unknown {
  if (options?.keepUnknown) return Preserve.roundTrip(schema, value)
  return Schema.encodeUnknownSync(schema)(Schema.decodeUnknownSync(schema)(value))
}

export const CODEX_ACCOUNT = "acc_01JAX3ABCDEFGHJKMNPQRSTVWX"
export const ANTH_ACCOUNT = "acc_01JAX9ABCDEFGHJKMNPQRSTVWX"
export const SESSION = "ses_2f7c0a1b2c3d4e5f6a7b8c9d0e"
export const SESSION_2 = "ses_9a8b7c6d5e4f3a2b1c0d9e8f7a"

/** 02 §2.4.2 */
export const templateModel = {
  id: "gpt-5.5",
  modelID: "gpt-5.5",
  family: "gpt",
  name: "GPT-5.5",
  package: "@opencode/ai/providers/openai",
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
  time: { released: 1767225600000 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 400000, input: 272000, output: 128000 },
}

/** 02 §2.4.1 */
export const accountsFile = {
  schemaVersion: 1,
  revision: 42,
  cacheDomains: {
    cd_7k2m: { kind: "codex", scope: "chatgpt_login", externalId: "chatgpt-account-id", poolingVerified: false },
    cd_w3p8: { kind: "anth", scope: "anthropic_workspace", externalId: "wrkspc_01abc", poolingVerified: false },
    cd_q9x1: { kind: "oai", scope: "openai_org", externalId: "org-abc", poolingVerified: false },
  },
  quotaDomains: {
    qd_7k2m: { kind: "codex", scope: "chatgpt_seat" },
    qd_org_ab: { kind: "anth", scope: "anthropic_org", externalId: "organization-id" },
    qd_q9x1: { kind: "oai", scope: "openai_org_project", externalId: "org-abc/proj_def" },
  },
  accounts: [
    {
      id: CODEX_ACCOUNT,
      kind: "codex",
      label: "업무",
      shortLabel: "업",
      color: "violet",
      providerID: "own-codex-7k2m",
      cacheDomain: "cd_7k2m",
      quotaDomain: "qd_7k2m",
      billing: "subscription",
      identity: {
        chatgptAccountId: "chatgpt-account-id",
        emailMasked: "na***@gmail.com",
        plan: "plus",
        fingerprint: "sha256:5c1e00",
      },
      autoSwitch: false,
      budget: null,
      status: "ready",
      createdAt: "2026-09-26T11:02:00Z",
      lastVerifiedAt: "2026-09-26T11:02:05Z",
      lastUsedAt: "2026-09-26T12:40:11Z",
      pollBalance: null,
    },
    {
      id: ANTH_ACCOUNT,
      kind: "anth",
      label: "회사 · prod",
      shortLabel: "회",
      color: "teal",
      providerID: "own-anth-w3p8",
      cacheDomain: "cd_w3p8",
      quotaDomain: "qd_org_ab",
      billing: "metered",
      identity: { organizationId: "org-id", workspaceId: "wrkspc_01abc", keyHint: "sk-ant-…9fQ2" },
      autoSwitch: true,
      budget: { monthlyUSD: 200 },
      status: "ready",
    },
  ],
  slots: {
    "own-codex-7k2m": {
      kind: "codex",
      accounts: [CODEX_ACCOUNT],
      pooling: "off",
      modelTemplate: "tpl_codex_20260926",
      transport: "websocket",
      defaultModel: { id: "gpt-5.5", variant: "high" },
    },
    "own-anth-w3p8": {
      kind: "anth",
      accounts: [ANTH_ACCOUNT],
      pooling: "off",
      modelTemplate: "tpl_anth_20260926",
      defaultModel: { id: "claude-opus-5-5", variant: "high" },
    },
  },
  modelTemplates: {
    tpl_codex_20260926: {
      kind: "codex",
      sourceProvider: "openai",
      source: "snapshot",
      capturedAt: "2026-09-26T11:02:00Z",
      models: [templateModel],
    },
  },
  claudeSlot: { accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "orange" },
}

/** 02 §2.4.3 */
export const policyFile = {
  schemaVersion: 1,
  autoSwitch: {
    apiToApi: "auto",
    subscriptionToApi: "ask",
    subscriptionToSubscription: "ask",
    toClaudeSlot: "off",
    inTurnFailover: false,
  },
  hysteresis: {
    cooldownMinutes: 30,
    cooldownRequests: 20,
    breakerAutoPerHour: 2,
    breakerFlapMinutes: 10,
    breakerOpenMinutes: 30,
    coldSumFactor: 3,
  },
  thresholds: {
    anthropicWatermarkBlocks: 15,
    unknownTtlIdleMinutes: 60,
    scheduleDeadlineMinMinutes: 30,
    confirm: { silentBelowTokens: 20000, dialogAtTokens: 100000, dialogAtQuotaPercent: 5, dialogAtUSD: 0.5 },
  },
  horizonRequests: 20,
  fallbackChains: { default: ["own-oai-q9x1", "own-oai-z7k3", "own-anth-w3p8"] },
  hideBuiltinProviders: "auto",
  defaults: {
    byKind: { codex: CODEX_ACCOUNT, anth: ANTH_ACCOUNT },
  },
  awayDetect: { enabled: true, hiddenMinutes: 10 },
  compaction: {
    byKind: {
      ds: { triggerPercent: 60, maxTriggerTokens: 200000 },
      compat: { models: { "qwen3-coder-plus": { maxTriggerTokens: 96000 } } },
    },
  },
  secretCacheSeconds: 600,
  credentialBackend: "vault",
}

/** 02 §2.4.4 */
export const ratecardsFile = {
  schemaVersion: 1,
  updatedAt: "2026-09-26",
  cards: [
    {
      match: { kind: "codex", model: "gpt-5.6-sol" },
      unit: "credits",
      in: 100,
      read: 10,
      write: null,
      out: 500,
      ttl: { warmLowerSec: 300, coldUpperSec: null },
      lookback: null,
      note: "프로모션가, 2026-11-21 이후 변동 가능",
    },
    {
      match: { kind: "codex", model: "gpt-5.5" },
      unit: "credits",
      in: 125,
      read: 12.5,
      write: null,
      out: 750,
      ttl: { warmLowerSec: 300, coldUpperSec: null },
    },
    {
      match: { kind: "anth", model: "claude-opus-5-5" },
      unit: "USD",
      in: 4.0,
      read: 0.2,
      write5m: 5.0,
      write1h: 8.0,
      out: 20.0,
      ttl: { warmLowerSec: 300, coldUpperSec: 300, oneHour: { warmLowerSec: 3600, coldUpperSec: 3600 } },
      lookback: { blocks: 20 },
    },
    {
      match: { kind: "oai", modelGte: "gpt-5.6" },
      unit: "USD",
      inFromCatalog: true,
      readMul: 0.1,
      writeMul: 1.25,
      ttl: { warmLowerSec: 1800, coldUpperSec: 1800 },
      lookback: { messageEnds: 20 },
    },
    {
      match: { kind: "oai", modelLt: "gpt-5.6" },
      unit: "USD",
      inFromCatalog: true,
      readMul: 0.1,
      writeMul: 1.0,
      ttl: { warmLowerSec: 1800, coldUpperSec: 86400 },
    },
    {
      match: { kind: "ds", model: "deepseek-v4-pro" },
      unit: "USD",
      in: 1.32,
      read: 0.044,
      write: null,
      offPeakMul: 0.5,
      ttl: { warmLowerSec: 0, coldUpperSec: 259200 },
    },
    {
      match: { kind: "xai" },
      unit: "USD",
      inFromCatalog: true,
      readMul: 0.25,
      ttl: { warmLowerSec: 0, coldUpperSec: null },
    },
    { match: { kind: "compat" }, unit: "USD", inFromCatalog: true, ttl: { warmLowerSec: 0, coldUpperSec: null } },
  ],
}

/** 02 §7.5 */
export const ledgerLine = {
  v: 1,
  ts: 1790001234567,
  sessionID: SESSION,
  messageID: "msg_0123",
  kind: "primary",
  accountID: CODEX_ACCOUNT,
  providerID: "own-codex-7k2m",
  modelID: "gpt-5.5",
  variant: "high",
  credentialRef: null,
  transport: "websocket",
  switchEpoch: 3,
  compactionEpoch: 1,
  tokens: { input: 2890, cacheRead: 149120, cacheWrite: 0, cacheWrite1h: null, output: 812, reasoning: 1204 },
  P: 152010,
  hit: 0.981,
  cost: { unit: "credits", amount: 2.39, source: "ratecard" },
  costUSDOpenCode: 0,
  coldExpected: null,
}

/** 02 §7.3 */
export const limitWindow = {
  id: "codex.primary",
  accountID: CODEX_ACCOUNT,
  providerID: "own-codex-7k2m",
  scope: "account",
  kind: "rolling_quota",
  label: "5시간",
  windowMinutes: 300,
  usedPercent: 42,
  resetAt: 1790003000000,
  status: "ok",
  confidence: "live",
  source: "header",
  observedAt: 1790001234567,
}

/** 02 §9.2 `health` */
export const health = {
  version: "2.0.18-own.1",
  buildId: "b7e2c91a",
  pluginVersions: { accounts: "0.1.0", telemetry: "0.1.0" },
  vaultBackend: { name: "own-vault", version: "0.1.0" },
  vault: "ok",
  guard: "ok",
  registryRevision: 42,
  controlDir: "C:\\Users\\me\\AppData\\Local\\own-open-code\\control",
  locations: [
    { directory: "D:\\work\\repo", allowlist: "ok" },
    { directory: "D:\\tmp\\cloned", allowlist: "blocked_by_plugin" },
  ],
  sizes: { kv: 1048576, ledger: 5242880, db: 73400320 },
  warnings: [],
}

/** 02 §9.2 `accounts.list` */
export const accountsList = {
  revision: 42,
  accounts: [
    {
      id: CODEX_ACCOUNT,
      kind: "codex",
      label: "업무",
      shortLabel: "업",
      color: "violet",
      providerID: "own-codex-7k2m",
      billing: "subscription",
      status: "ready",
      autoSwitch: false,
      thirdParty: false,
      readOnly: false,
      identity: { emailMasked: "na***@gmail.com", plan: "plus" },
      connection: { type: "oauth", method: "chatgpt-device" },
      cacheDomain: { id: "cd_7k2m", sharedWith: [] },
      quotaDomain: { id: "qd_7k2m", sharedWith: [] },
      limitsSummary: { worst: { id: "codex.primary", usedPercent: 42, resetAt: 1790003000000, status: "ok" } },
      sessions: { running: 1, total: 7 },
      lastUsedAt: 1790001200000,
      compaction: {
        setting: null,
        effective: [{ modelID: "gpt-5.5", windowTokens: 272000, triggerTokens: 244800, source: "v2" }],
      },
    },
    {
      id: "acc_claude_slot",
      kind: "claude-sub",
      label: "Claude Max · na***@…",
      shortLabel: "C",
      color: "orange",
      providerID: "anthropic",
      billing: "subscription",
      status: "ready",
      autoSwitch: false,
      thirdParty: true,
      readOnly: true,
      connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@…" },
      plugin: { installed: true, acknowledged: true, version: "0.4.0-beta.5" },
      limitsSummary: { worst: { id: "claude.5h", usedPercent: 61, resetAt: 1790004000000, status: "ok" } },
      sessions: { running: 0, total: 2 },
      lastUsedAt: 1789990000000,
      compaction: {
        setting: null,
        effective: [{ modelID: "claude-opus-5-5", windowTokens: 1000000, triggerTokens: 900000, source: "v2" }],
      },
    },
  ],
}

/** 02 §9.2 `session.binding` */
export const sessionBinding = {
  bindings: [
    {
      sessionID: SESSION,
      model: { providerID: "own-codex-7k2m", id: "gpt-5.5", variant: "high" },
      accountID: CODEX_ACCOUNT,
      builtin: false,
      thirdParty: false,
      home: "own-codex-7k2m",
      switch: { state: "STEADY" },
    },
    {
      sessionID: SESSION_2,
      model: { providerID: "anthropic", id: "claude-opus-5-5" },
      accountID: "acc_claude_slot",
      builtin: false,
      thirdParty: true,
      home: "anthropic",
      switch: { state: "STEADY" },
    },
  ],
}

/** 02 §9.2 `cache.state` */
export const cacheState = {
  sessionID: SESSION,
  now: 1790001300000,
  slots: [
    {
      providerID: "own-codex-7k2m",
      state: "warm",
      L: 150000,
      lastReqAt: 1790001200000,
      warmUntil: 1790001500000,
      coldAfter: null,
      epoch: 1,
      blocksSince: 0,
      ttlMode: "5m",
    },
    { providerID: "own-anth-w3p8", state: "cold", L: 98000, lastReqAt: 1789990000000 },
  ],
  compaction: {
    providerID: "own-codex-7k2m",
    modelID: "gpt-5.5",
    windowTokens: 272000,
    triggerTokens: 244800,
    slotTriggerTokens: 244800,
    source: "v2",
    sessionTriggerTokens: null,
    floorTokens: 63000,
    keepTokens: 15000,
    auto: true,
    P: 153000,
    remainingTokens: 91800,
    cycle: { Z: 12000, delta: 3000, summary: 8000 },
    pendingDue: null,
  },
}

/** 02 §9.2 `plugin.claudeAuth.status` */
export const claudeAuthStatus = {
  installed: true,
  version: "0.4.0-beta.5",
  integrityOk: true,
  order: "ok",
  phase: "ready",
  acknowledged: { at: "2026-09-26T11:30:00Z", version: "0.4.0-beta.5", integrity: "sha512-dVA2AY58", valid: true },
  connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@…" },
  warnings: [],
}

/** 02 §9.2 `switch.estimate` */
export const estimate = {
  estimateID: "est_01JB0000000000000000000000",
  expiresAt: 1790001600000,
  context: { P: 153000, Z: 12000, units: { source: "credits", target: "credits" } },
  target: {
    providerID: "own-codex-p1q2",
    id: "gpt-5.5",
    variant: "high",
    fits: true,
    compactAt: { windowTokens: 272000, triggerTokens: 244800, source: "v2" },
  },
  options: [
    {
      strategy: "now",
      delta: { lo: 13.5, hi: 13.5, unit: "credits" },
      quota: { window: "codex.primary", percent: null, state: "calibrating" },
      perRequestAfter: 1.83,
      available: true,
      display: "primary",
    },
    {
      strategy: "compact-then-switch",
      delta: { lo: 7.3, hi: 7.3, unit: "credits" },
      perRequestAfter: 0.67,
      recommended: true,
      available: true,
      display: "primary",
    },
    { strategy: "switch-then-compact", available: false, reason: "source_available", display: "primary" },
    {
      strategy: "cold-point",
      delta: { lo: 0, hi: 1.1, unit: "credits" },
      trigger: "either",
      idleMinutes: 60,
      uncertain: true,
      available: true,
      display: "primary",
    },
    {
      strategy: "new-session",
      delta: { lo: 5.0, hi: 5.0, unit: "credits" },
      contextLoss: true,
      available: true,
      display: "primary",
    },
    { strategy: "fork", delta: { lo: 13.5, hi: 13.5, unit: "credits" }, available: true, display: "secondary" },
  ],
  warnings: ["same_org_no_headroom"],
  variantOnly: null,
  confidence: { steps: 14, recentError: 0.08 },
  inputs: { W_lo: 0, W_hi: 0, rates: { in: 100, read: 10 }, ttl: { lo: 300, hi: null } },
}

/** 02 §9.2 `plugin.trust.list` */
export const trustList = {
  locations: [
    {
      directory: "D:\\tmp\\cloned",
      status: "blocked_by_plugin",
      plugins: [
        { id: "x", source: "local:D:\\tmp\\cloned\\.opencode\\plugins\\x.ts", sha256: "9f1c", approved: false },
      ],
    },
    { directory: "D:\\work\\repo", status: "ok", plugins: [] },
  ],
}
