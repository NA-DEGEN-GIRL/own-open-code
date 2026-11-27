export * as Registry from "./registry.js"

import { Schema, Struct } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { Account } from "./account.js"
import { Compaction } from "./compaction.js"
import { CacheDomainID, IsoDateTime, QuotaDomainID, TemplateID } from "./id.js"
import { Kind } from "./kind.js"
import { keyedRecord } from "./util.js"

export const SCHEMA_VERSION = 1

export const CacheDomainScope = Schema.Literals([
  "chatgpt_login",
  /** Sign in with ChatGPT token sharing on the public API; never pooled with `chatgpt_login` (02 §3.2c). */
  "chatgpt_sharing",
  "openai_org",
  "anthropic_workspace",
  "deepseek_user",
  /** Conservative per-key domain until the provider domain is confirmed (02 §3.3). */
  "api_key",
]).annotate({ identifier: "Own.Registry.CacheDomainScope" })
export type CacheDomainScope = typeof CacheDomainScope.Type

/** Server prompt-cache sharing boundary (02 §2.1). */
export interface CacheDomain extends Schema.Schema.Type<typeof CacheDomain> {}
export const CacheDomain = Schema.Struct({
  kind: Kind.Own,
  scope: CacheDomainScope,
  externalId: optional(Schema.String),
  /** Pooling in one slot is allowed only after the kind's cross-replay PoC passes (02 §2.2 R-ID-2). */
  poolingVerified: Schema.Boolean,
}).annotate({ identifier: "Own.Registry.CacheDomain" })

export const QuotaDomainScope = Schema.Literals([
  "chatgpt_seat",
  /** The issued Sign in with ChatGPT client's plan allowance (ChatGPT Settings → Usage, 02 §3.2c). */
  "chatgpt_sharing",
  "openai_org",
  "openai_org_project",
  "anthropic_org",
  "anthropic_workspace",
  "deepseek_account",
  "xai_team",
  "openrouter_key",
  "api_key",
]).annotate({ identifier: "Own.Registry.QuotaDomainScope" })
export type QuotaDomainScope = typeof QuotaDomainScope.Type

/** Boundary where limits and spend add up (02 §2.1). */
export interface QuotaDomain extends Schema.Schema.Type<typeof QuotaDomain> {}
export const QuotaDomain = Schema.Struct({
  kind: Kind.Own,
  scope: QuotaDomainScope,
  externalId: optional(Schema.String),
}).annotate({ identifier: "Own.Registry.QuotaDomain" })

export const Pooling = Schema.Literals(["off", "rotate"]).annotate({ identifier: "Own.Registry.Pooling" })
export type Pooling = typeof Pooling.Type

/** One `accounts.json.slots` entry, keyed by its `own-<kind>-<slug>` provider id (02 §2.4.1). */
export interface Slot extends Schema.Schema.Type<typeof Slot> {}
export const Slot = Schema.Struct({
  kind: Kind.Own,
  /** MVP: exactly one account per slot. */
  accounts: Schema.Array(Account.ID).check(Schema.isMinLength(1)),
  pooling: Pooling,
  modelTemplate: TemplateID,
  /** `codex` only. `http` when AC-P15 fails (02 §3.6, §7.1). */
  transport: optional(Provider.Transport),
  /**
   * No longer written or read (07 §2.2): a new session's model is its provider group's default in `presets.json`.
   * Kept so older files still decode; removed from 02 §3.4 later.
   */
  defaultModel: optional(Schema.Struct({ id: Model.ID, variant: optional(Model.VariantID) })),
  /** `compat` (required) and user-specified base URLs; written to provider `settings.baseURL` (02 §3.3). */
  baseURL: optional(Schema.String),
  /** A deleted account's slot stays registered with every model disabled; its id is never reused (R-ID-3). */
  retired: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Registry.Slot" })

export const TemplateSource = Schema.Literals(["snapshot", "bundled", "user"]).annotate({
  identifier: "Own.Registry.TemplateSource",
})
export type TemplateSource = typeof TemplateSource.Type

/**
 * A `Model.Info` copied into a pinned template, without `providerID` (02 §2.4.2). The template diff (07 §4.4, T2) adds
 * two marks, own's and never registered with a provider: `addedAt`, when a model the live catalog gained was added
 * (it only becomes selectable, the model picker's `새` tag), and `upstream: "missing"` for a model the catalog dropped,
 * which the template keeps (never deleted) so the repair notices of 07 §4.3 can follow.
 */
export const TemplateModel = Model.Info.mapFields((fields) => ({
  ...Struct.omit(fields, ["providerID"]),
  addedAt: optional(IsoDateTime),
  upstream: optional(Schema.Literal("missing")),
})).annotate({
  identifier: "Own.Registry.TemplateModel",
})
export type TemplateModel = typeof TemplateModel.Type

/**
 * Pinned model template shared by every slot of the kind (`compat`: one per slot, source `user`) (02 §2.4.2). `update`
 * (07 §4.4, T2): a fixed-field change the template diff found, waiting for `accounts.update{refreshCatalog}`.
 */
export interface ModelTemplate extends Schema.Schema.Type<typeof ModelTemplate> {}
export const ModelTemplate = Schema.Struct({
  kind: Kind.Own,
  /** Catalog provider the snapshot came from; absent for `compat`. */
  sourceProvider: optional(Provider.ID),
  source: TemplateSource,
  capturedAt: IsoDateTime,
  models: Schema.Array(TemplateModel),
  update: optional(Account.TemplateUpdate),
}).annotate({ identifier: "Own.Registry.ModelTemplate" })

/**
 * Display metadata of the synthetic Claude slot account. `label: null` uses the connection label (02 §8.5).
 * `remoteHosts` (04 §8.11.12): the SSH hosts (own-remote ids, `h-xxxxxx`) switched on to use the slot through this
 * PC's egress relay; absent or empty = none. Never mirrored to a host. `configDir` (02 §8.7 CS, 2026-10-22): account 1's
 * own login folder (`<OWN_HOME>\claude-accounts\<id>`) once `own 전용 로그인으로 바꾸기` moved it off Claude Code's
 * `%USERPROFILE%\.claude`; absent = `claude-auth.json`'s folder, else `%USERPROFILE%\.claude`.
 */
export interface ClaudeSlot extends Schema.Schema.Type<typeof ClaudeSlot> {}
export const ClaudeSlot = Schema.Struct({
  accountID: Schema.Literal("acc_claude_slot"),
  label: Schema.NullOr(Schema.String),
  shortLabel: Schema.String,
  color: Account.Color,
  remoteHosts: optional(Schema.Array(Schema.String.check(Schema.isPattern(/^h-[a-z0-9]{6,8}$/)))),
  configDir: optional(Schema.String.check(Schema.isMinLength(1))),
}).annotate({ identifier: "Own.Registry.ClaudeSlot" })

/**
 * A Claude subscription account next to the slot's own (02 §8.7, user decisions C-D1/C-D2 2026-10-10): one Claude Code
 * config directory the patched claude-auth reads as an account of its own. Account 1 is the slot itself
 * (`acc_claude_slot`: display in {@link ClaudeSlot}, directory from `claude-auth.json` or `%USERPROFILE%\.claude`); these
 * are the others. `key` is the normalized directory (resolved, lower-cased on Windows), the account's name inside the
 * plugin. `managed`: own created the directory (`<OWN_HOME>\claude-accounts\<id>`) for a Claude Code login. `email` is
 * masked; `accountUuid` (from `<dir>\.claude.json`, not secret) refuses the same login twice.
 */
export interface ClaudeAccount extends Schema.Schema.Type<typeof ClaudeAccount> {}
export const ClaudeAccount = Schema.Struct({
  accountID: Account.ID,
  key: Schema.String.check(Schema.isMinLength(1)),
  configDir: Schema.String.check(Schema.isMinLength(1)),
  label: Schema.NullOr(Schema.String),
  shortLabel: Schema.String,
  color: Account.Color,
  managed: Schema.Boolean,
  email: optional(Schema.String),
  accountUuid: optional(Schema.String),
  addedAt: IsoDateTime,
}).annotate({ identifier: "Own.Registry.ClaudeAccount" })

/**
 * A Claude Agent account (02 §8.10, CAG 2026-10-31): a Claude Code config folder own made under
 * `<OWN_HOME>\claude-agent\accounts\<id>`, which the user logs into with `claude auth login` and upstream's
 * `claude-agent` provider runs claude in (its `CLAUDE_CONFIG_DIR`). The folder belongs to this route only: claude-auth
 * never lists it, and the route never takes one of claude-auth's folders, so each login has one refresher. Claude Code
 * keeps the login; own reads only whether `.credentials.json` exists and `.claude.json`'s `oauthAccount` e-mail
 * (masked here) and account uuid. Every account's `projects` is a junction to one own-managed transcript folder
 * (`<OWN_HOME>\claude-agent\projects`), so another account resumes the same conversation (phase 2).
 */
export interface ClaudeAgentAccount extends Schema.Schema.Type<typeof ClaudeAgentAccount> {}
export const ClaudeAgentAccount = Schema.Struct({
  accountID: Account.ID,
  configDir: Schema.String.check(Schema.isMinLength(1)),
  label: Schema.NullOr(Schema.String),
  shortLabel: Schema.String,
  color: Account.Color,
  email: optional(Schema.String),
  accountUuid: optional(Schema.String),
  addedAt: IsoDateTime,
  /** The account's auto-compaction setting (02 §4.7.3, §8.10.5, CAG-50); absent = the kind default. */
  compaction: optional(Compaction.Setting),
}).annotate({ identifier: "Own.Registry.ClaudeAgentAccount" })

/** `OWN_HOME\accounts.json` (02 §2.4.1). */
export interface File extends Schema.Schema.Type<typeof File> {}
export const File = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  revision: NonNegativeInt,
  cacheDomains: keyedRecord(CacheDomainID, CacheDomain),
  quotaDomains: keyedRecord(QuotaDomainID, QuotaDomain),
  accounts: Schema.Array(Account.Info),
  /** Keyed by `own-<kind>-<slug>`. */
  slots: keyedRecord(Kind.ProviderID, Slot),
  modelTemplates: keyedRecord(TemplateID, ModelTemplate),
  claudeSlot: optional(ClaudeSlot),
  /** Claude accounts besides the slot's own (02 §8.7); absent = none. */
  claudeAccounts: optional(Schema.Array(ClaudeAccount)),
  /** The Claude account a conversation without a binding uses (02 §8.7); absent = `acc_claude_slot`. */
  claudeDefault: optional(Account.ID),
  /** Claude Agent accounts (02 §8.10); absent = none. */
  claudeAgents: optional(Schema.Array(ClaudeAgentAccount)),
  /** The Claude Agent account a conversation without a binding uses (02 §8.10); absent = the first one. */
  claudeAgentDefault: optional(Account.ID),
  /**
   * The Claude Agent process pool (02 §8.10.12): the cap on live claude processes (absent = 8) and spare processes per
   * account for new conversations (absent = 0).
   */
  claudeAgentPool: optional(Schema.Struct({ processes: optional(Schema.Int), spares: optional(Schema.Int) })),
}).annotate({ identifier: "Own.Registry.File" })

/** One project plugin approval in `OWN_HOME\trust.json` (02 §2.3, 01 §13.2). */
export interface TrustEntry extends Schema.Schema.Type<typeof TrustEntry> {}
export const TrustEntry = Schema.Struct({
  location: Schema.String,
  source: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  approvedAt: IsoDateTime,
}).annotate({ identifier: "Own.Registry.TrustEntry" })

/** `OWN_HOME\trust.json` is a bare array of approvals (02 §2.3). */
export const TrustFile = Schema.Array(TrustEntry).annotate({ identifier: "Own.Registry.TrustFile" })
export type TrustFile = typeof TrustFile.Type
