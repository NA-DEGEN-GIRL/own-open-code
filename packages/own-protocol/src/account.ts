export * as Account from "./account.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { Provider } from "@opencode/schema/provider"
import { AccountID } from "./account-id.js"
import { Compaction } from "./compaction.js"
import { Credential } from "./credential.js"
import { CacheDomainID, EpochMillis, IsoDateTime, QuotaDomainID } from "./id.js"
import { Kind } from "./kind.js"
import { Limit } from "./limit.js"

export const ID = AccountID
export type ID = AccountID

export const Status = Schema.Literals([
  "ready",
  "exhausted",
  "auth_failed",
  "needs_reauth",
  "disabled",
  "misconfigured",
  "unverified",
  "retired",
]).annotate({ identifier: "Own.Account.Status" })
export type Status = typeof Status.Type

export const Billing = Schema.Literals(["subscription", "metered", "prepaid"]).annotate({
  identifier: "Own.Account.Billing",
})
export type Billing = typeof Billing.Type

/**
 * How an account is paid for as the screens and the money rules see it (02 §3.3a): its stored {@link Billing}, or
 * `local` for a local model, which costs nothing. `local` is never stored, so an older version still reads the file.
 */
export const Charge = Schema.Union([Billing, Schema.Literal("local")]).annotate({ identifier: "Own.Account.Charge" })
export type Charge = typeof Charge.Type

/** The eight account color tokens (03 §13.2). */
export const Color = Schema.Literals([
  "indigo",
  "teal",
  "amber",
  "rose",
  "violet",
  "green",
  "slate",
  "orange",
]).annotate({
  identifier: "Own.Account.Color",
})
export type Color = typeof Color.Type

/**
 * Whether the local broker leases this account's credential to SSH hosts (04 §8.9). Absent means `allow`; `deny`
 * answers `account_not_remote` and the account's slot is mirrored with every model disabled.
 */
export const RemoteAccess = Schema.Literals(["allow", "deny"]).annotate({ identifier: "Own.Account.RemoteAccess" })
export type RemoteAccess = typeof RemoteAccess.Type

/**
 * Non-secret identity facts. `fingerprint = sha256(chatgpt_account_id + ":" + sub)` guards re-login (02 §3.1 C5); a
 * `siwc` account uses the issued client id in place of the ChatGPT account id (02 §3.2c).
 */
export interface Identity extends Schema.Schema.Type<typeof Identity> {}
export const Identity = Schema.Struct({
  chatgptAccountId: optional(Schema.String),
  emailMasked: optional(Schema.String),
  plan: optional(Schema.String),
  fingerprint: optional(Schema.String),
  /**
   * The ChatGPT login, `sha256(chatgpt_account_id + ":" + sub)` in the fingerprint's form (07 §5.4 R4): equal for the
   * `codex` and `siwc` accounts of one ChatGPT login, which count as one subscription (`Preset.loginOf`). A `codex`
   * account's fingerprint already is its login, and its `accounts.list` view (which drops the fingerprint) carries it
   * here; a `siwc` account records it at sign-in when its ID token carries both values. Absent = unknown, a
   * subscription of its own.
   */
  login: optional(Schema.String),
  organizationId: optional(Schema.NullOr(Schema.String)),
  workspaceId: optional(Schema.NullOr(Schema.String)),
  projectId: optional(Schema.NullOr(Schema.String)),
  teamId: optional(Schema.NullOr(Schema.String)),
  /** Last four characters of an API key, e.g. `sk-ant-…9fQ2`. */
  keyHint: optional(Schema.String),
}).annotate({ identifier: "Own.Account.Identity" })

export interface Budget extends Schema.Schema.Type<typeof Budget> {}
export const Budget = Schema.Struct({
  monthlyUSD: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Own.Account.Budget" })

export const ConnectionType = Schema.Literals(["oauth", "key", "env", "none"]).annotate({
  identifier: "Own.Account.ConnectionType",
})
export type ConnectionType = typeof ConnectionType.Type

export const ConnectionMethod = Schema.Literals([
  "chatgpt-device",
  "chatgpt-browser",
  /** Sign in with ChatGPT (token sharing) on a `siwc` account (02 §3.2c). */
  "chatgpt-siwc",
  "codex-linked",
  "codex-takeover",
  "api-key",
  "claude-code",
  /** An API key the older codex-multi-provider app saved, linked by reference (`credential` `linked-legacy-key`). */
  "legacy-key-linked",
]).annotate({ identifier: "Own.Account.ConnectionMethod" })
export type ConnectionMethod = typeof ConnectionMethod.Type

/** The server software behind a `compat` account (07 §6.2 #2, PG9), as detected from its answers. */
export const CompatFamily = Schema.Literals(["ollama", "lmstudio", "vllm", "llamacpp", "other"]).annotate({
  identifier: "Own.Account.CompatFamily",
})
export type CompatFamily = typeof CompatFamily.Type

/**
 * What own knows of a `compat` account's server: its family, and whether a context overflow from it was seen
 * classified as one (core's overflow recovery then works for it, PG9; the card warning goes away).
 */
export interface CompatServer extends Schema.Schema.Type<typeof CompatServer> {}
export const CompatServer = Schema.Struct({
  family: CompatFamily,
  overflowClassified: Schema.Boolean,
  /** The server was read for its models' reasoning too (02 §3.3a); absent on accounts read before, read again once. */
  reasoningRead: optional(Schema.Boolean),
}).annotate({
  identifier: "Own.Account.CompatServer",
})

/**
 * A `compat` model's output token cap and where it comes from (07 §6.2 #7): the server reported it, the user entered
 * it, or the 32k fallback (shown as `모름`).
 */
export interface CompatOutput extends Schema.Schema.Type<typeof CompatOutput> {}
export const CompatOutput = Schema.Struct({
  tokens: PositiveInt,
  source: Schema.Literals(["server", "user", "fallback"]),
}).annotate({ identifier: "Own.Account.CompatOutput" })

/**
 * A local server's running context window (07 §6.2 #8, PG9): `runtime` as the server reports it (`null` unknown),
 * `needed` = the request size own expects (system, tools and a margin). `verified` only when `runtime >= needed`;
 * the registered window itself is never reduced (R8).
 */
export interface LocalWindow extends Schema.Schema.Type<typeof LocalWindow> {}
export const LocalWindow = Schema.Struct({
  runtime: Schema.NullOr(PositiveInt),
  needed: PositiveInt,
  status: Schema.Literals(["verified", "unverified", "unknown"]),
}).annotate({ identifier: "Own.Account.LocalWindow" })

/**
 * The user's choice for one capability of a `compat` model (02 §3.3, `그림 입력`, `도구`): `auto` follows what the
 * server reported, `on` and `off` override it.
 */
export const CompatSetting = Schema.Literals(["auto", "on", "off"]).annotate({
  identifier: "Own.Account.CompatSetting",
})
export type CompatSetting = typeof CompatSetting.Type

/**
 * The API a local model server speaks (02 §3.3a, `로컬 모델`): OpenAI Chat Completions (`chat`), OpenAI Responses
 * (`responses`), Anthropic Messages (`anthropic`), or an Ollama server (`ollama`: its OpenAI-compatible `/v1`
 * Chat Completions for requests, its native `/api` for what own reads about the models). Every format's base URL ends
 * in `/v1`.
 */
export const LocalFormat = Schema.Literals(["chat", "responses", "anthropic", "ollama"]).annotate({
  identifier: "Own.Account.LocalFormat",
})
export type LocalFormat = typeof LocalFormat.Type

/**
 * How a `compat` model takes a reasoning effort (02 §3.3a): named levels (`effort`, sent as `reasoning_effort` in Chat
 * Completions and `reasoning.effort` in Responses; an Anthropic-format server gets a thinking budget per level),
 * thinking on or off (`toggle`, `chat_template_kwargs.enable_thinking`; Anthropic `thinking` enabled or disabled), or
 * a thinking token budget (`budget`, Anthropic `thinking.budget_tokens`). `default` is the level the server uses when
 * a request names none.
 */
export const Reasoning = Schema.Union([
  Schema.Struct({
    style: Schema.Literal("effort"),
    levels: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
    default: optional(Schema.String),
  }),
  Schema.Struct({ style: Schema.Literal("toggle") }),
  Schema.Struct({ style: Schema.Literal("budget") }),
])
  .annotate({ identifier: "Own.Account.Reasoning" })
  .pipe(Schema.toTaggedUnion("style"))
export type Reasoning = typeof Reasoning.Type

/** The user's reasoning choice for a `compat` model (02 §3.3a): `auto` follows the server, `off` sends none. */
export const ReasoningSetting = Schema.Union([Schema.Literals(["auto", "off"]), Reasoning]).annotate({
  identifier: "Own.Account.ReasoningSetting",
})
export type ReasoningSetting = typeof ReasoningSetting.Type

/**
 * What a `compat` model's server reported (02 §3.3): `image` input and `tools`; an absent field was not reported.
 * `reasoning` (02 §3.3a): how the model takes an effort, `null` when the server says it does not reason.
 */
export interface CompatDetected extends Schema.Schema.Type<typeof CompatDetected> {}
export const CompatDetected = Schema.Struct({
  image: optional(Schema.Boolean),
  tools: optional(Schema.Boolean),
  reasoning: optional(Schema.NullOr(Reasoning)),
}).annotate({ identifier: "Own.Account.CompatDetected" })

/**
 * One `compat` model's capabilities as stored (02 §3.3): what its server reported (`detected`, absent until the server
 * was read) and the user's overrides (absent = `auto`). `reasoning` (02 §3.3a): `off`, or how to send an effort.
 */
export interface CompatCapabilities extends Schema.Schema.Type<typeof CompatCapabilities> {}
export const CompatCapabilities = Schema.Struct({
  detected: optional(CompatDetected),
  image: optional(Schema.Literals(["on", "off"])),
  tools: optional(Schema.Literals(["on", "off"])),
  reasoning: optional(Schema.Union([Schema.Literal("off"), Reasoning])),
}).annotate({ identifier: "Own.Account.CompatCapabilities" })

/**
 * A `compat` model capability as `accounts.list` shows it: whether it is on (registered), the user's setting and what
 * the server reported (absent = not reported).
 */
export interface CompatCapability extends Schema.Schema.Type<typeof CompatCapability> {}
export const CompatCapability = Schema.Struct({
  on: Schema.Boolean,
  setting: CompatSetting,
  detected: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Account.CompatCapability" })

/**
 * A `compat` account that is a local model (02 §3.3a, `로컬 모델`): the server's API format. Such an account needs no
 * key, costs nothing (no rates, never a paid target) and offers its models' reasoning efforts.
 */
export interface Local extends Schema.Schema.Type<typeof Local> {}
export const Local = Schema.Struct({ format: LocalFormat }).annotate({ identifier: "Own.Account.Local" })

/** `accounts[].compat` (`compat` accounts only): what the server reported or the user entered. */
export interface Compat extends Schema.Schema.Type<typeof Compat> {}
export const Compat = Schema.Struct({
  server: optional(CompatServer),
  /** Output cap by model id. */
  outputs: optional(Schema.Record(Schema.String, CompatOutput)),
  /** Image input and tools by model id (02 §3.3). */
  capabilities: optional(Schema.Record(Schema.String, CompatCapabilities)),
  /**
   * Absent = `기타 OpenAI 호환`; present = `로컬 모델` (02 §3.3a). `keyless`: added without a key, so the vault holds none
   * and requests carry no credential (a key added later through `replaceKey` drops it).
   */
  local: optional(Schema.Struct({ ...Local.fields, keyless: optional(Schema.Literal(true)) })),
  /** The user made this local model `기타 OpenAI 호환` again: a local base URL no longer makes it one at start. */
  notLocal: optional(Schema.Literal(true)),
}).annotate({ identifier: "Own.Account.Compat" })

/** Whether an account is a local model (02 §3.3a): a `compat` account marked `local`. */
export function isLocal(account: { readonly kind: string; readonly compat?: Compat | undefined }) {
  return account.kind === "compat" && account.compat?.local !== undefined
}

/** An account's {@link Charge}: `local` for a local model, else its stored billing. */
export function chargeOf(account: Pick<Info, "kind" | "billing" | "compat">): Charge {
  return isLocal(account) ? "local" : account.billing
}

/**
 * A `compat` model's reasoning as `accounts.list` shows it (02 §3.3a): the user's setting, what the server reported
 * (absent = not reported, `null` = no reasoning) and the effort levels it registers with (empty = none).
 */
export interface CompatReasoning extends Schema.Schema.Type<typeof CompatReasoning> {}
export const CompatReasoning = Schema.Struct({
  setting: ReasoningSetting,
  detected: optional(Schema.NullOr(Reasoning)),
  levels: Schema.Array(Schema.String),
}).annotate({ identifier: "Own.Account.CompatReasoning" })

/**
 * `accounts.list` `compat`: the stored facts and, for a local runtime server, each model's running window. `image` and
 * `tools` are absent from services older than the capability settings, `reasoning` and `local` from services older
 * than the local model type.
 */
export interface CompatView extends Schema.Schema.Type<typeof CompatView> {}
export const CompatView = Schema.Struct({
  server: optional(CompatServer),
  local: optional(Local),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      output: optional(CompatOutput),
      localWindow: optional(LocalWindow),
      image: optional(CompatCapability),
      tools: optional(CompatCapability),
      reasoning: optional(CompatReasoning),
    }),
  ),
}).annotate({ identifier: "Own.Account.CompatView" })

/** One `accounts.json.accounts[]` entry (02 §2.4.1). */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  kind: Kind.Own,
  label: Schema.String,
  shortLabel: Schema.String,
  color: Color,
  providerID: Kind.ProviderID,
  cacheDomain: CacheDomainID,
  quotaDomain: QuotaDomainID,
  billing: Billing,
  identity: Identity,
  /** Subscriptions default to `false` (02 §5.10). */
  autoSwitch: Schema.Boolean,
  /** Metered accounts only. */
  budget: optional(Schema.NullOr(Budget)),
  status: Status,
  createdAt: optional(IsoDateTime),
  lastVerifiedAt: optional(IsoDateTime),
  lastUsedAt: optional(IsoDateTime),
  /** `ds`, `or`, `xai` only: `true | false` (default `true`). Other kinds keep `null` (02 §7.2). */
  pollBalance: optional(Schema.NullOr(Schema.Boolean)),
  /** Absent means `{ type: "vault" }`. */
  credential: optional(Credential.Ref),
  /**
   * How the account was connected, for the UI label (`accounts.list` `connection.method`): `chatgpt-device` or
   * `chatgpt-browser` for an own ChatGPT login, `chatgpt-siwc` for Sign in with ChatGPT, `api-key` for key
   * accounts. Imported codex accounts derive theirs from `credential` (`codex-linked` / `codex-takeover`,
   * `legacy-key-linked` for linked old-app keys), which wins over this field. Absent on accounts created before the
   * field existed.
   */
  method: optional(ConnectionMethod),
  /** Account-level auto-compaction setting (02 §4.7.3). Absent or `null` = the kind default. */
  compaction: optional(Schema.NullOr(Compaction.Setting)),
  /** 04 §8.9: remote use of this account through the credential broker. Absent = `allow`. */
  remote: optional(RemoteAccess),
  /** `compat` only (07 §6.2 #2, #7): the server family and each model's output cap with its source. */
  compat: optional(Compat),
}).annotate({ identifier: "Own.Account.Info" })

/** How an account is connected, as shown by `accounts.list` and `plugin.claudeAuth.status` (02 §9.2). */
export interface Connection extends Schema.Schema.Type<typeof Connection> {}
export const Connection = Schema.Struct({
  type: ConnectionType,
  method: optional(ConnectionMethod),
  label: optional(Schema.String),
  /** Imported codex-multi-provider profile. `superseded` is true after a takeover. */
  source: optional(
    Schema.Struct({
      app: Schema.Literal("codex-multi-provider"),
      profileID: Schema.String,
      alias: Schema.NullOr(Schema.String),
      mode: Credential.CodexImportMode,
      superseded: Schema.Boolean,
    }),
  ),
  /**
   * An API key linked from the old app (02 §3.2b): its provider there, never the key or the file path. The old app
   * owns the key; deleting or changing it there changes this account too.
   */
  legacyKey: optional(
    Schema.Struct({
      app: Schema.Literal("codex-multi-provider"),
      providerRef: Credential.LegacyProviderRef,
      name: Schema.NullOr(Schema.String),
    }),
  ),
}).annotate({ identifier: "Own.Account.Connection" })

export interface DomainRef extends Schema.Schema.Type<typeof DomainRef> {}
export const DomainRef = Schema.Struct({ id: Schema.String, sharedWith: Schema.Array(ID) }).annotate({
  identifier: "Own.Account.DomainRef",
})

/**
 * A pinned template's fixed-field change that waits for the user (07 §4.4, `템플릿 갱신 있음`): when the template diff
 * first saw it and which `Model.Info` fields changed (`name`, `family`, `variants`, `package`, `settings`,
 * `capabilities` …). Those fields reach the request bytes, so they change only through the user's
 * `accounts.update{refreshCatalog}`, applied at a cold point (a new session, right after a compaction), which clears
 * it. Kept on `accounts.json` `modelTemplates[].update` and shown on the account's `accounts.list` view.
 */
export interface TemplateUpdate extends Schema.Schema.Type<typeof TemplateUpdate> {}
export const TemplateUpdate = Schema.Struct({
  detectedAt: IsoDateTime,
  fields: Schema.Array(Schema.NonEmptyString),
}).annotate({ identifier: "Own.Account.TemplateUpdate" })

/**
 * A template model own-web marks (07 §4.4, §7.3): added to the pinned template after it was captured (`addedAt`, the
 * model picker's `새` tag; nothing else changes), or gone from the live catalog while the template keeps it
 * (`upstream: "missing"`, the repair notices of 07 §4.3), or registered from a served Codex row (`source`).
 */
export interface ModelMark extends Schema.Schema.Type<typeof ModelMark> {}
export const ModelMark = Schema.Struct({
  id: Model.ID,
  addedAt: optional(IsoDateTime),
  upstream: optional(Schema.Literal("missing")),
  /**
   * `served` (10 §6.14, 07 §4.4): registered from the ChatGPT account's served Codex row because no catalog lists the
   * model yet; its name, window and levels are the row's (the picker's quiet `모델 정보 일부는 서버 목록 기준이에요`).
   */
  source: optional(Schema.Literal("served")),
}).annotate({ identifier: "Own.Account.ModelMark" })

/**
 * A Claude account's refresh line (02 §8.7, CR 2026-10-26), for an account the patched plugin refreshes itself (never
 * one on Claude Code's own login): `failed` = the token endpoint refused its refresh for good (HTTP 400, 401 or 403, or
 * a dead-token code, or the login has no refresh token): the view's status is `needs_reauth` and only `다시 로그인`
 * helps; `retrying` = it failed for now (429, 5xx, no answer): the next request after `retryAt` tries again; `due` = its
 * access token expired and no refresh was tried yet: the first request refreshes it (not an error). `status` = the
 * HTTP status (absent: no answer), `error` = the OAuth error code, `reason` = why there was no usable answer (`network`,
 * `timeout`, `unparsable`, `no_refresh_token`), `at` = when it failed. Never a token.
 */
export interface ClaudeRefresh extends Schema.Schema.Type<typeof ClaudeRefresh> {}
export const ClaudeRefresh = Schema.Struct({
  state: Schema.Literals(["failed", "retrying", "due"]),
  status: optional(NonNegativeInt),
  error: optional(Schema.String),
  reason: optional(Schema.String),
  retryAt: optional(EpochMillis),
  at: optional(EpochMillis),
}).annotate({ identifier: "Own.Account.ClaudeRefresh" })

/**
 * One `accounts.list` item (02 §9.2). Contains no secrets. T2 (07 §4.4) adds, optional so T1 clients and services
 * still decode: `templateUpdate`, the account's template change waiting for `refreshCatalog`, and `models`, the
 * template models with a mark (only those; absent = none).
 */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  id: ID,
  kind: Kind.Any,
  label: Schema.String,
  shortLabel: Schema.String,
  color: Color,
  providerID: Provider.ID,
  /** `local` for a local model (02 §3.3a). */
  billing: Charge,
  status: Status,
  autoSwitch: Schema.Boolean,
  thirdParty: Schema.Boolean,
  readOnly: Schema.Boolean,
  identity: optional(Identity),
  connection: Connection,
  cacheDomain: optional(DomainRef),
  quotaDomain: optional(DomainRef),
  limitsSummary: optional(Limit.Summary),
  sessions: optional(Schema.Struct({ running: NonNegativeInt, total: NonNegativeInt })),
  /** Last step time (epoch ms). */
  lastUsedAt: optional(Schema.NullOr(EpochMillis)),
  budget: optional(Schema.NullOr(Budget)),
  pollBalance: optional(Schema.NullOr(Schema.Boolean)),
  /** Stored setting and the resolved threshold of every template model (02 §4.7.4, §9.2). */
  compaction: optional(Compaction.AccountView),
  /** 04 §8.9: remote use through the credential broker (absent = `allow`). */
  remote: optional(RemoteAccess),
  /** `compat` only (07 §6.2 #2, #7, #8): server family, output caps and local running windows. */
  compat: optional(CompatView),
  templateUpdate: optional(TemplateUpdate),
  models: optional(Schema.Array(ModelMark)),
  /**
   * Claude subscription accounts only (02 §8.7): `default` = what a conversation without a binding uses, `managed` =
   * own made the login folder, `email` masked, `loaded` = the patched plugin holds a login of this folder (`null` while
   * the plugin is not patched or not loaded). Never a credential. `shared` (CS, 2026-10-22) = a login Claude Code
   * itself uses, which own only reads and never refreshes: account 1 on its unmanaged base folder (`%USERPROFILE%\.claude`
   * or the folder `claude-auth.json` names), or any account whose folder or credentials file is one of Claude Code's by
   * realpath or file id (a junction, another spelling, a link); `stale` = its login expired and stays so until Claude
   * Code refreshes it, which an idle Claude Code does on its next request (the view's status is then `needs_reauth`).
   * Both absent from older services. `accountUuid` (SK2, 2026-10-24; `.claude.json` `oauthAccount.accountUuid`, not
   * a secret): names the account of a Claude app's synced skills folder (`skills\synced\<org>_<account>`). `refresh`
   * (CR, 2026-10-26): its {@link ClaudeRefresh} line, absent when there is nothing to say (and from older services).
   */
  claude: optional(
    Schema.Struct({
      managed: Schema.Boolean,
      default: Schema.Boolean,
      folder: Schema.String,
      email: optional(Schema.String),
      loaded: Schema.NullOr(Schema.Boolean),
      shared: optional(Schema.Boolean),
      stale: optional(Schema.Boolean),
      refresh: optional(ClaudeRefresh),
      accountUuid: optional(Schema.String),
    }),
  ),
  /**
   * Claude Agent accounts only (02 §8.10, CAG): `folder` = the login folder own made, `loggedIn` = Claude Code's
   * credentials file exists there (never read), `email` masked, `cli` = a Claude Code was found on this PC, `plan` = the
   * subscription Claude Code reported last (`pro`, `max`, … or `null` for an API key), `checked` = when it did,
   * `default` = new conversations start on it (phase 2), `transcripts` = its `projects` junction to the shared transcript
   * folder (`linked`, or `broken` with the reason own could not repair).
   */
  claudeAgent: optional(
    Schema.Struct({
      folder: Schema.String,
      loggedIn: Schema.Boolean,
      email: optional(Schema.String),
      cli: Schema.Boolean,
      plan: optional(Schema.NullOr(Schema.String)),
      checked: optional(EpochMillis),
      default: optional(Schema.Boolean),
      transcripts: optional(Schema.Literals(["linked", "broken"])),
    }),
  ),
  /** Claude subscription slot only. */
  plugin: optional(
    Schema.Struct({
      installed: Schema.Boolean,
      acknowledged: Schema.Boolean,
      version: Schema.NullOr(Schema.String),
    }),
  ),
}).annotate({ identifier: "Own.Account.View" })

/** Minimal account reference returned by `accounts.add.key` (02 §9.2). */
export interface Brief extends Schema.Schema.Type<typeof Brief> {}
export const Brief = Schema.Struct({ id: ID, providerID: Kind.ProviderID, status: Status }).annotate({
  identifier: "Own.Account.Brief",
})

/** Connection-test detection result (02 §3.3). `null` means the probe did not reveal the value. */
export interface Detected extends Schema.Schema.Type<typeof Detected> {}
export const Detected = Schema.Struct({
  organizationId: optional(Schema.NullOr(Schema.String)),
  workspaceId: optional(Schema.NullOr(Schema.String)),
  projectId: optional(Schema.NullOr(Schema.String)),
  teamId: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Own.Account.Detected" })
