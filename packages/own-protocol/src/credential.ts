export * as Credential from "./credential.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { EpochMillis, IsoDateTime } from "./id.js"
import { Kind } from "./kind.js"

/**
 * An existing ChatGPT login stored by the older codex-multi-provider app, at
 * `<control-center>\profiles\<profileID>\codex\auth.json` (alias from `<control-center>\state.json`).
 * Holds only the location of the source, never token values.
 */
export interface CodexSource extends Schema.Schema.Type<typeof CodexSource> {}
export const CodexSource = Schema.Struct({
  app: Schema.Literal("codex-multi-provider"),
  profileID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  alias: Schema.NullOr(Schema.String),
  /** Absolute path of the source `auth.json`. It is only ever read, never written. */
  authPath: Schema.String.check(Schema.isMinLength(1)),
}).annotate({ identifier: "Own.Credential.CodexSource" })

/** Import mode for a codex-multi-provider profile. */
export const CodexImportMode = Schema.Literals(["linked", "takeover"]).annotate({
  identifier: "Own.Credential.CodexImportMode",
})
export type CodexImportMode = typeof CodexImportMode.Type

/** Default: the secret lives in our vault as `vault\<accountId>.dpapi` (02 §2.4.5). */
export interface Vault extends Schema.Schema.Type<typeof Vault> {}
export const Vault = Schema.Struct({ type: Schema.Literal("vault") }).annotate({ identifier: "Own.Credential.Vault" })

/**
 * Linked mode (import default). The old app stays the single refresher of the token family (02 §3.5 C3):
 * we never write the source file and never call the token endpoint for it. The runtime reads the source's
 * current tokens and re-reads them when the file changes or after a 401. Nothing is copied to the vault.
 */
export interface LinkedCodexSource extends Schema.Schema.Type<typeof LinkedCodexSource> {}
export const LinkedCodexSource = Schema.Struct({
  type: Schema.Literal("linked-codex-source"),
  source: CodexSource,
  linkedAt: IsoDateTime,
}).annotate({ identifier: "Own.Credential.LinkedCodexSource" })

/**
 * Takeover mode. The source tokens were copied into our vault once (an `oauth` vault item) and we are now the
 * single refresher. The source is marked superseded in our registry only (the source file is never written);
 * the UI warns that the old app's profile may need to log in again.
 */
export interface TakeoverCodexSource extends Schema.Schema.Type<typeof TakeoverCodexSource> {}
export const TakeoverCodexSource = Schema.Struct({
  type: Schema.Literal("takeover-codex-source"),
  source: CodexSource,
  takenOverAt: IsoDateTime,
}).annotate({ identifier: "Own.Credential.TakeoverCodexSource" })

/**
 * The old app's `credential_ref` of a saved API key (`scripts\manager_core\providers.py` `_secret_path`):
 * `legacy:deepseek` = `<app>\profiles\deepseek.dpapi`, `dpapi:<providerId>` =
 * `<app>\work\control-center\credentials\<providerId>.dpapi`. The server derives the file path from it, so the
 * value can never point anywhere else.
 */
export const LegacyProviderRef = Schema.String.check(
  Schema.isPattern(/^(legacy:deepseek|dpapi:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/),
).annotate({ identifier: "Own.Credential.LegacyProviderRef" })
export type LegacyProviderRef = typeof LegacyProviderRef.Type

/**
 * An API key saved by the older codex-multi-provider app: a DPAPI (CurrentUser, no entropy) file of that app. Holds
 * only the location of the file, never the key. The file is decrypted in memory by `own-vault.exe` `linked.get`
 * at request time and is never written, copied or re-encrypted (02 §3.2b).
 */
export interface LegacyKeySource extends Schema.Schema.Type<typeof LegacyKeySource> {}
export const LegacyKeySource = Schema.Struct({
  app: Schema.Literal("codex-multi-provider"),
  providerRef: LegacyProviderRef,
  /** The provider's display name in the old app, e.g. `DeepSeek`. */
  name: Schema.NullOr(Schema.String),
  /** Absolute path of the old app's `.dpapi` file. Only ever read (own-vault `linked.get` allowlist). */
  path: Schema.String.check(Schema.isMinLength(1)),
}).annotate({ identifier: "Own.Credential.LegacyKeySource" })

/**
 * Linked API key (02 §3.2b). Like {@link LinkedCodexSource}, the old app stays the owner: if it deletes or replaces
 * the key, this account follows (re-read when the file changes and after a 401). Nothing is stored in our vault;
 * removing the account removes only this reference.
 */
export interface LinkedLegacyKey extends Schema.Schema.Type<typeof LinkedLegacyKey> {}
export const LinkedLegacyKey = Schema.Struct({
  type: Schema.Literal("linked-legacy-key"),
  source: LegacyKeySource,
  linkedAt: IsoDateTime,
}).annotate({ identifier: "Own.Credential.LinkedLegacyKey" })

/** Where an account's credential comes from. A registry account without `credential` uses `vault`. */
export const Ref = Schema.Union([Vault, LinkedCodexSource, TakeoverCodexSource, LinkedLegacyKey])
  .annotate({ identifier: "Own.Credential.Ref" })
  .pipe(Schema.toTaggedUnion("type"))
export type Ref = typeof Ref.Type

/**
 * Token family of an OAuth vault item: the Codex-style ChatGPT login (`openai-chatgpt`) or Sign in with ChatGPT token
 * sharing (`openai-chatgpt-sharing`). The families use different clients, token endpoints and APIs and never mix.
 */
export const OAuthFamily = Schema.Literals(["openai-chatgpt", "openai-chatgpt-sharing"]).annotate({
  identifier: "Own.Credential.OAuthFamily",
})
export type OAuthFamily = typeof OAuthFamily.Type

/** The family each OAuth kind stores; an item of another family is a `kind_mismatch` (02 §2.4.5). */
export const familyOf: Readonly<Record<Kind.OAuth, OAuthFamily>> = {
  codex: "openai-chatgpt",
  siwc: "openai-chatgpt-sharing",
}

/** Plaintext form of a ChatGPT OAuth vault item after decryption (02 §2.4.5). Secret. */
export interface OAuthSecret extends Schema.Schema.Type<typeof OAuthSecret> {}
export const OAuthSecret = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("oauth"),
  family: OAuthFamily,
  access: Schema.String,
  refresh: Schema.String,
  idToken: optional(Schema.String),
  expiresAt: EpochMillis,
  obtainedAt: EpochMillis,
  generation: NonNegativeInt,
  // Non-secret token-sharing metadata that must travel with the token family through every refresh. Items written
  // before these fields existed omit them.
  /** The issued client id (`oaiapp_…`) every token call of the family uses. Never `dynamic_agent_client`. */
  clientId: optional(Schema.String),
  /** Granted scopes of the last token response; a refresh that omits `scope` keeps them. */
  scopes: optional(Schema.Array(Schema.String)),
  /** No refresh before this time, unless the access token was rejected (token response `earliest_refresh_at`). */
  earliestRefreshAt: optional(EpochMillis),
}).annotate({ identifier: "Own.Credential.OAuthSecret" })

/** Plaintext form of an API key vault item after decryption (02 §2.4.5). Secret. */
export interface KeySecret extends Schema.Schema.Type<typeof KeySecret> {}
export const KeySecret = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("key"),
  key: Schema.String.check(Schema.isMinLength(1)),
  generation: NonNegativeInt,
}).annotate({ identifier: "Own.Credential.KeySecret" })

export const VaultItem = Schema.Union([OAuthSecret, KeySecret])
  .annotate({ identifier: "Own.Credential.VaultItem" })
  .pipe(Schema.toTaggedUnion("type"))
export type VaultItem = typeof VaultItem.Type

/**
 * The Codex CLI `auth.json` written by the old app. Secret. Decode with the default excess-property handling so
 * unknown fields are dropped from memory; the file itself is never rewritten.
 */
export interface CodexAuthFile extends Schema.Schema.Type<typeof CodexAuthFile> {}
export const CodexAuthFile = Schema.Struct({
  /**
   * Codex CLI omits it for logins written before the field existed; like its `resolved_mode`, a missing mode is
   * `apikey` when `OPENAI_API_KEY` is set and `chatgpt` otherwise (see {@link codexAuthMode}).
   */
  auth_mode: optional(Schema.NullOr(Schema.String)),
  OPENAI_API_KEY: optional(Schema.NullOr(Schema.String)),
  tokens: optional(
    Schema.NullOr(
      Schema.Struct({
        id_token: Schema.String,
        access_token: Schema.String,
        refresh_token: Schema.String,
        account_id: optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  /** RFC 3339 time of the old app's last refresh (may carry nanoseconds). */
  last_refresh: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Own.Credential.CodexAuthFile" })

/** The effective mode of a Codex `auth.json`, mirroring Codex CLI `AuthDotJson::resolved_mode`. */
export function codexAuthMode(file: Pick<CodexAuthFile, "auth_mode" | "OPENAI_API_KEY">) {
  return file.auth_mode ?? (file.OPENAI_API_KEY == null ? "chatgpt" : "apikey")
}

/**
 * A `CodexAuthFile` that can back a `codex` account: ChatGPT mode (explicit, or implied by a missing mode, see
 * {@link codexAuthMode}) with a full token set.
 */
export interface CodexChatgptAuthFile extends Schema.Schema.Type<typeof CodexChatgptAuthFile> {}
export const CodexChatgptAuthFile = Schema.Struct({
  auth_mode: optional(Schema.NullOr(Schema.Literal("chatgpt"))),
  tokens: Schema.Struct({
    id_token: Schema.String.check(Schema.isMinLength(1)),
    access_token: Schema.String.check(Schema.isMinLength(1)),
    refresh_token: Schema.String.check(Schema.isMinLength(1)),
    account_id: optional(Schema.NullOr(Schema.String)),
  }),
  last_refresh: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Own.Credential.CodexChatgptAuthFile" })

/**
 * The non-secret subset of the old app's provider registry `<app>\work\control-center\providers.json` (API-key
 * providers and their model bindings). Unknown fields are dropped from memory.
 */
export interface LegacyProvidersFile extends Schema.Schema.Type<typeof LegacyProvidersFile> {}
export const LegacyProvidersFile = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: optional(Schema.NullOr(Schema.String)),
      base_url: optional(Schema.NullOr(Schema.String)),
      protocol: optional(Schema.NullOr(Schema.String)),
      credential_ref: optional(Schema.NullOr(Schema.String)),
    }),
  ),
  models: optional(
    Schema.Array(
      Schema.Struct({
        provider_id: Schema.String,
        wire_model_id: optional(Schema.NullOr(Schema.String)),
        name: optional(Schema.NullOr(Schema.String)),
        capabilities: optional(Schema.NullOr(Schema.Struct({ context_window: optional(Schema.NullOr(Schema.Int)) }))),
      }),
    ),
  ),
}).annotate({ identifier: "Own.Credential.LegacyProvidersFile" })

/** The old app's first (pre-registry) DeepSeek connection `<app>\profiles\provider.json`. Not secret. */
export interface LegacyProviderFile extends Schema.Schema.Type<typeof LegacyProviderFile> {}
export const LegacyProviderFile = Schema.Struct({
  base_url: optional(Schema.NullOr(Schema.String)),
  protocol: optional(Schema.NullOr(Schema.String)),
  model: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Own.Credential.LegacyProviderFile" })

/** The subset of the old app's `state.json` we read to list profiles and their aliases. */
export interface CodexStateFile extends Schema.Schema.Type<typeof CodexStateFile> {}
export const CodexStateFile = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      alias: optional(Schema.NullOr(Schema.String)),
      auth_mode: optional(Schema.NullOr(Schema.String)),
      login_state: optional(Schema.NullOr(Schema.String)),
    }),
  ),
}).annotate({ identifier: "Own.Credential.CodexStateFile" })
