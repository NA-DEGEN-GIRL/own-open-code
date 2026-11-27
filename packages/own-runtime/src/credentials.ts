export * as Credentials from "./credentials.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { Credential, Kind, type Account } from "@own/protocol"
import { CodexSource } from "./codex-source.js"
import { auth, keyHint } from "./hash.js"
import { LegacyKey } from "./legacy-key.js"
import { Refresh } from "./refresh.js"
import { Cache, DEFAULT_TTL_SECONDS } from "./secret-cache.js"
import { generationOf, type Client } from "./vault.js"

/** Why no auth headers could be produced. Hooks then inject nothing and the request fails with 401 (02 §4.1). */
export type Problem =
  /** No vault item for the account. */
  | "not_found"
  /** The vault item cannot be decrypted (other user/PC, damaged file). `hasPrev` tells whether `.prev` exists. */
  | "decrypt_failed"
  /** The vault item decrypts but is not a 02 §2.4.5 item. */
  | "corrupt"
  | "vault_unavailable"
  /** The refresh token family is dead (02 §3.5 F4, F5). */
  | "needs_reauth"
  /** The access token expired and no refresh could run. */
  | "expired"
  /** A transient refresh failure; `retryAt` says when the next attempt may run. */
  | "refresh_backoff"
  /** Linked source: expired or rejected tokens the old app has not refreshed yet (`codex_source_stale`). */
  | "source_stale"
  /**
   * Linked source cannot be used; `detail` is the `OwnError.SourceProblem` (codex) or `OwnError.LegacyKeyProblem`
   * (old-app API key).
   */
  | "source_invalid"
  /**
   * The item does not fit the account kind: OAuth items only for the OAuth kinds and only of the kind's family
   * (`codex` ↔ `openai-chatgpt`, `siwc` ↔ `openai-chatgpt-sharing`), keys for the others.
   */
  | "kind_mismatch"
  /** A `codex` account without a ChatGPT account id for `chatgpt-account-id`. */
  | "identity_missing"

export interface Failure {
  readonly ok: false
  readonly problem: Problem
  readonly detail?: string
  readonly retryAt?: number
  readonly hasPrev?: boolean
}

export type Auth =
  | {
      readonly ok: true
      readonly headers: Readonly<Record<string, string>>
      /** `hash8` of the credential header, for the auth swap check (02 §4.2). */
      readonly hash: string
      /** Access token expiry for OAuth, `null` for API keys. */
      readonly expiresAt: number | null
      readonly source: "vault" | "linked"
    }
  | Failure

export interface HeadersInput {
  readonly account: Account.Info
  readonly sessionID: string
  /** Token endpoint call used when the vault OAuth item is due or was rejected. Without it nothing is refreshed. */
  readonly refresher?: Refresh.Refresher
}

/** A secret to store; the runtime assigns `v` and a `generation` above the stored one. */
export type NewSecret =
  | { readonly type: "key"; readonly key: string }
  | {
      readonly type: "oauth"
      /** Default `openai-chatgpt` (codex). */
      readonly family?: Credential.OAuthFamily
      readonly access: string
      readonly refresh: string
      readonly idToken?: string
      readonly expiresAt: number
      readonly obtainedAt?: number
      /** Token sharing: the issued client id, the granted scopes and `earliest_refresh_at` (epoch ms). */
      readonly clientId?: string
      readonly scopes?: ReadonlyArray<string>
      readonly earliestRefreshAt?: number
    }

/** Non-secret state of an account's credential. */
export interface Inspection {
  readonly source: "vault" | "linked"
  readonly ok: boolean
  readonly problem?: Problem
  readonly detail?: string
  readonly type?: "key" | "oauth"
  readonly generation?: number
  readonly expiresAt?: number | null
  /** API keys only, e.g. `sk-ant-…9fQ2`. */
  readonly keyHint?: string
  /** Token sharing OAuth items only: the issued client id a re-login must reuse. Not secret. */
  readonly clientId?: string
  readonly hasPrev?: boolean
  /** Linked sources only. */
  readonly identity?: CodexSource.Identity
  readonly lastRefresh?: string | null
}

/** Headers of an old-app key read for an import (`legacyAuth`); the key itself is never returned. */
export type LegacyAuth =
  | {
      readonly ok: true
      readonly headers: Readonly<Record<string, string>>
      /** `hash8` of the credential header, to find an account that already uses the same key. */
      readonly hash: string
      readonly keyHint: string
    }
  | { readonly ok: false; readonly problem: LegacyKey.Problem }

export interface Options {
  readonly vault: Client
  readonly now?: () => number
  readonly pid?: number
  readonly secretCacheSeconds?: number
  /** Called with the `hash8` of every credential header produced, for `LastResponse.recordInjected`. */
  readonly onInjected?: (sessionID: string, providerID: string, hash: string) => void
  readonly refresh?: Omit<Refresh.Options, "vault" | "now" | "pid">
  readonly reader?: Omit<CodexSource.ReaderOptions, "now" | "ttlMs" | "expected">
}

const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(Credential.VaultItem))

/**
 * Vault ids of keys that belong to a feature, not to an account: voice input's keys (02 §3.9, `Voice.keyID`) and web
 * search services' keys (02 §9.2, `SearchKey.keyID`). Account ids are `acc_…`, so the two never meet:
 * {@link Service.headersFor} takes an account and never sees these, and these methods never take an account id, so a
 * model request never gets a feature key and a feature never gets an account's key (or a ChatGPT token).
 */
export type FeatureKeyID = `voice-${string}` | `websearch-${string}` | McpSecretID | GitHubSecretID

/**
 * The vault item of an MCP server own added (03 §18.14, SM): its environment values, header values and the part of its
 * URL after `?`, one JSON text per server. Only {@link Service.mcpSecrets} reads it, for that server's process or
 * requests.
 */
export type McpSecretID = `mcp-${string}`

/**
 * The vault item of a GitHub account own connected (16 §3, GH): one JSON text per account with its token (and, for a
 * device login of an app whose tokens expire, the refresh token and the expiry). Only {@link Service.githubSecret}
 * reads it, for that account's own GitHub requests and git's credential requests.
 */
export type GitHubSecretID = `github-${string}`

/**
 * How a feature key goes into its request: an `Authorization` scheme, `Bearer` (OpenAI) or `Token` (Deepgram), or a
 * header of its own that holds the key alone (Brave's `X-Subscription-Token`).
 */
export type FeatureScheme = "Bearer" | "Token" | { readonly header: string }

/** Non-secret state of a feature key. */
export interface FeatureKeyState {
  readonly configured: boolean
  /** `sk-…9fQ2`; never the key. */
  readonly keyHint?: string
  readonly problem?: Problem
}

/**
 * Auth headers per account without ever handing out a raw secret getter (01 §13.2(c)). Accounts use one of three
 * credential kinds (`Account.Info.credential`, absent = vault):
 *
 * - `vault` / `takeover-codex-source`: a 02 §2.4.5 item in `own-vault.exe`, cached per `accountId:generation`, and
 *   refreshed here (single-flight + lease) through the caller's {@link Refresh.Refresher}.
 * - `linked-codex-source`: the old app's `auth.json`, read-only via {@link CodexSource.Reader}. Never written, never
 *   refreshed.
 * - `linked-legacy-key`: an API key file the old app saved, decrypted in memory by own-vault `linked.get` through
 *   {@link LegacyKey.Reader} (re-read when the file changes and after a 401). Never written; nothing in our vault.
 */
export class Service {
  readonly #vault: Client
  readonly #now: () => number
  readonly #cache: Cache<Credential.VaultItem, Failure>
  readonly #refresh: Refresh.Coordinator
  readonly #readers = new Map<string, CodexSource.Reader>()
  readonly #keys = new Map<string, LegacyKey.Reader>()
  // Generation of the OAuth item whose headers were served last, and the one that then got a 401: that generation is
  // refreshed once on next use even if not due (02 §3.5 F1). Tracked apart from the cache, which may be disabled.
  readonly #served = new Map<string, number>()
  readonly #rejected = new Map<string, number>()
  // OAuth generations the provider declared unusable for good ({@link reject}): served as `needs_reauth` until a new
  // login stores a newer generation.
  readonly #refused = new Map<string, { readonly generation: number; readonly reason: string }>()
  readonly #onInjected: Options["onInjected"]
  readonly #readerOptions: Options["reader"]
  #ttlSeconds: number

  constructor(options: Options) {
    this.#vault = options.vault
    this.#now = options.now ?? Date.now
    this.#ttlSeconds = options.secretCacheSeconds ?? DEFAULT_TTL_SECONDS
    this.#cache = new Cache({ ttlSeconds: this.#ttlSeconds, now: this.#now })
    this.#refresh = new Refresh.Coordinator({
      ...options.refresh,
      vault: options.vault,
      now: this.#now,
      pid: options.pid,
    })
    this.#onInjected = options.onInjected
    this.#readerOptions = options.reader
  }

  /** Applies `policy.secretCacheSeconds` (0 = no cache) to vault items and linked sources. */
  configure(options: { readonly secretCacheSeconds: number }) {
    this.#ttlSeconds = options.secretCacheSeconds
    this.#cache.configure(options.secretCacheSeconds)
    for (const reader of this.#readers.values()) reader.configure(options.secretCacheSeconds * 1000)
    for (const reader of this.#keys.values()) reader.configure(options.secretCacheSeconds * 1000)
  }

  /**
   * Auth headers of 02 §4.1 for one request: codex `Authorization`, `chatgpt-account-id`, `session-id`,
   * `originator: opencode`; siwc `Authorization: Bearer` only; anth `x-api-key`; the other kinds
   * `Authorization: Bearer`. Never throws.
   */
  async headersFor(input: HeadersInput): Promise<Auth> {
    const credential = credentialOf(input.account)
    const result = await (
      credential.type === "linked-codex-source"
        ? this.#linked(input, credential)
        : credential.type === "linked-legacy-key"
          ? this.#legacy(input.account, credential)
          : this.#fromVault(input)
    ).catch(
      (): Failure => ({
        ok: false,
        problem: linked(input.account) ? "source_invalid" : "vault_unavailable",
      }),
    )
    if (result.ok) this.#onInjected?.(input.sessionID, input.account.providerID, result.hash)
    return result
  }

  /**
   * The provider answered 401 to this account (02 §3.5 F1). Linked sources are re-read and count as stale until the
   * old app writes new tokens; a vault OAuth item is refreshed once on its next use.
   */
  unauthorized(account: Account.Info): "reread_source" | "refresh_next" | "none" {
    const credential = credentialOf(account)
    if (credential.type === "linked-codex-source") {
      this.#reader(account, credential.source.authPath).reject()
      return "reread_source"
    }
    if (credential.type === "linked-legacy-key") {
      this.#keyReader(credential.source.path).invalidate()
      return "reread_source"
    }
    const generation = this.#served.get(account.id)
    if (generation === undefined) return "none"
    this.#rejected.set(account.id, generation)
    return "refresh_next"
  }

  /**
   * The provider said the account's token family can no longer be used, e.g. a Sign in with ChatGPT
   * `subscription_sharing_invalid_user` (02 §3.2c). The served generation answers `needs_reauth` from now on, without
   * a refresh, until a new login stores a newer one. Linked sources are not ours to judge: `false`.
   */
  reject(account: Account.Info, reason: string) {
    if (linked(account)) return false
    const generation = this.#served.get(account.id)
    if (generation === undefined) return false
    this.#refused.set(account.id, { generation, reason })
    return true
  }

  /** Warms the cache (02 §2.4.5 "미리 채우기": setup, `switch.apply`, `switch.estimate`). */
  async prefetch(account: Account.Info) {
    const credential = credentialOf(account)
    if (credential.type === "linked-codex-source")
      return (await this.#reader(account, credential.source.authPath).usable()).ok
    if (credential.type === "linked-legacy-key") return (await this.#keyReader(credential.source.path).usable()).ok
    return (await this.#load(account.id)).ok
  }

  /**
   * Reads an old-app key file for an import (02 §3.2b plan/execute) and returns the request headers of `kind` for it,
   * its hint and its header hash; never the key. Uses the same reader (and in-memory cache) the account will use.
   */
  async legacyAuth(source: Credential.LegacyKeySource, kind: Kind.Own): Promise<LegacyAuth> {
    const reader = this.#keyReader(source.path)
    // An import always looks at the file as it is now.
    reader.invalidate()
    const usable = await reader.usable().catch((): LegacyKey.Usable => ({ ok: false, problem: "unreadable" }))
    if (!usable.ok) return usable
    const headers = keyHeaders(kind, usable.snapshot.secret.key())
    return { ok: true, headers, hash: auth(headers)[0]?.hash ?? "", keyHint: usable.snapshot.secret.hint() }
  }

  /**
   * Stores a new secret (login completion, `replaceKey`, takeover) with a generation above the stored one, then
   * caches it. `ok` means it is on disk (02 §3.5 F4). Use `keepPrev` when replacing a working secret.
   */
  async store(
    accountID: string,
    secret: NewSecret,
    options: { readonly keepPrev?: boolean } = {},
  ): Promise<{ readonly ok: true; readonly generation: number } | Failure> {
    const attempt = async (tries: number): Promise<{ readonly ok: true; readonly generation: number } | Failure> => {
      const current = await this.#vault.get(accountID)
      if (!current.ok && current.error !== "not_found" && current.error !== "decrypt_failed")
        return { ok: false, problem: "vault_unavailable", detail: current.error }
      const stored = current.ok ? (current.generation ?? generationOf(current.value)) : null
      const item = build(secret, (stored ?? 0) + 1, this.#now())
      const put = await this.#vault.put(accountID, JSON.stringify(item), {
        keepPrev: options.keepPrev,
        ifGeneration: stored ?? undefined,
      })
      if (put.ok) {
        this.#cache.evict(accountID)
        this.#cache.set(accountID, item)
        this.#rejected.delete(accountID)
        this.#refused.delete(accountID)
        this.#refresh.reset(accountID)
        return { ok: true, generation: item.generation }
      }
      if (put.error === "conflict" && tries > 1) return attempt(tries - 1)
      return { ok: false, problem: "vault_unavailable", detail: put.error }
    }
    return attempt(3)
  }

  /**
   * Deletes the account's vault item and `.prev` (02 §3.5 F7) and forgets cached state. Never touches a source file:
   * a linked old-app key has no vault item, so only the in-memory reader goes (the registry entry is the caller's).
   * Sign-out passes `revoker`, which ends the token family at its issuer (the HTTP lives in own-accounts, like the
   * refresher): it gets the stored OAuth item read before the delete, and only once the delete succeeded, so a
   * removal that fails leaves a working login.
   */
  async remove(
    account: Account.Info,
    options: { readonly shred?: boolean; readonly revoker?: (item: Credential.OAuthSecret) => void } = {},
  ) {
    const credential = credentialOf(account)
    if (credential.type === "linked-legacy-key") {
      this.#keys.delete(key(credential.source.path))
      this.#cache.evict(account.id)
      return { ok: true, deleted: false } as const
    }
    const held = options.revoker && !linked(account) ? await this.#load(account.id).catch(() => undefined) : undefined
    if (credential.type === "linked-codex-source") this.#readers.delete(key(credential.source.authPath))
    this.#cache.evict(account.id)
    this.#served.delete(account.id)
    this.#rejected.delete(account.id)
    this.#refused.delete(account.id)
    this.#refresh.reset(account.id)
    const deleted = await this.#vault.delete(account.id, { shred: options.shred ?? true })
    // As for a feature key: a read that started while the delete ran must not stay cached.
    this.#cache.evict(account.id)
    if (!deleted.ok) return { ok: false, problem: "vault_unavailable", detail: deleted.error } satisfies Failure
    if (held?.ok && held.value.type === "oauth") options.revoker?.(held.value)
    return { ok: true, deleted: deleted.deleted } as const
  }

  /** Non-secret state for `accounts.test`, health and the Accounts screen. */
  async inspect(account: Account.Info): Promise<Inspection> {
    const credential = credentialOf(account)
    if (credential.type === "linked-codex-source") {
      const usable = await this.#reader(account, credential.source.authPath).usable()
      if (usable.ok) return linkedInspection(usable.snapshot.summary, true)
      if (usable.reason === "stale")
        return { ...linkedInspection(usable.summary, false), problem: "source_stale", detail: usable.cause }
      return { source: "linked", ok: false, problem: "source_invalid", detail: usable.problem }
    }
    if (credential.type === "linked-legacy-key") {
      const usable = await this.#keyReader(credential.source.path).usable()
      if (usable.ok)
        return { source: "linked", ok: true, type: "key", expiresAt: null, keyHint: usable.snapshot.secret.hint() }
      if (usable.problem === "vault_unavailable")
        return { source: "linked", ok: false, type: "key", problem: "vault_unavailable" }
      return { source: "linked", ok: false, type: "key", problem: "source_invalid", detail: usable.problem }
    }
    const loaded = await this.#load(account.id)
    if (!loaded.ok) return { source: "vault", ...loaded }
    const item = loaded.value
    if (item.type === "key")
      return {
        source: "vault",
        ok: true,
        type: "key",
        generation: item.generation,
        expiresAt: null,
        keyHint: keyHint(item.key),
      }
    return {
      source: "vault",
      ok: true,
      type: "oauth",
      generation: item.generation,
      expiresAt: item.expiresAt,
      clientId: item.clientId,
    }
  }

  /**
   * Refreshes a vault OAuth item now when it is due, or before that with `force`. Even a forced refresh waits for the
   * token endpoint's `earliest_refresh_at` while the current token still works (`deferred`, {@link
   * Refresh.deferredUntil}). Returns no token values. Linked sources are never refreshed by us.
   */
  async refresh(account: Account.Info, refresher: Refresh.Refresher, options: { readonly force?: boolean } = {}) {
    if (linked(account)) return { type: "unavailable", reason: "linked_source" } as const
    const loaded = await this.#load(account.id)
    if (!loaded.ok) return { type: "unavailable", reason: loaded.problem } as const
    if (loaded.value.type !== "oauth") return { type: "unavailable", reason: "not_oauth" } as const
    const item = loaded.value
    const now = this.#now()
    if (!options.force && !Refresh.due(item, now))
      return { type: "current", generation: item.generation, expiresAt: item.expiresAt } as const
    const until = Refresh.deferredUntil(item, now)
    if (until !== undefined)
      return { type: "deferred", until, generation: item.generation, expiresAt: item.expiresAt } as const
    const result = await this.#refresh.run(account.id, refresher, item.generation)
    if (result.type === "refreshed" || result.type === "current") {
      this.#cache.set(account.id, result.item)
      return { type: result.type, generation: result.item.generation, expiresAt: result.item.expiresAt } as const
    }
    if (result.type === "needs_reauth") this.#cache.evict(account.id)
    return result
  }

  /**
   * Takeover import: copies the source's tokens into the vault once; from then on we are the single refresher. The
   * source file is only read. `expected` is the login the source must hold (for a re-import: the account's identity,
   * see {@link expectedOf}).
   */
  async takeover(
    accountID: string,
    source: Credential.CodexSource,
    options: { readonly expected?: CodexSource.Expected } = {},
  ) {
    const now = this.#now()
    const result = await CodexSource.read(source.authPath, { now, expected: options.expected })
    if (!result.ok) return { ok: false, problem: "source_invalid", detail: result.problem } satisfies Failure
    const summary = result.snapshot.summary
    const stored = await this.store(
      accountID,
      {
        type: "oauth",
        access: result.snapshot.secret.access(),
        refresh: result.snapshot.secret.refresh(),
        idToken: result.snapshot.secret.idToken(),
        expiresAt: summary.expiresAt,
        obtainedAt: CodexSource.parseLastRefresh(summary.lastRefresh) ?? now,
      },
      { keepPrev: true },
    )
    if (!stored.ok) return stored
    this.#readers.delete(key(source.authPath))
    return {
      ok: true,
      generation: stored.generation,
      identity: summary.identity,
      expiresAt: summary.expiresAt,
    } as const
  }

  /** Stores a feature key (02 §3.9) with a generation above the stored one; a replaced key stays as `.prev`. */
  async storeFeatureKey(id: FeatureKeyID, key: string) {
    return this.store(id, { type: "key", key }, { keepPrev: true })
  }

  /** The auth header of a feature key, for that feature's own request only. Never the key itself. */
  async featureHeaders(
    id: FeatureKeyID,
    scheme: FeatureScheme,
  ): Promise<{ readonly ok: true; readonly headers: Readonly<Record<string, string>> } | Failure> {
    const loaded = await this.#load(id).catch((): Failure => ({ ok: false, problem: "vault_unavailable" }))
    if (!loaded.ok) return loaded
    if (loaded.value.type !== "key") return { ok: false, problem: "kind_mismatch" }
    const headers =
      typeof scheme === "string"
        ? { authorization: `${scheme} ${loaded.value.key}` }
        : { [scheme.header]: loaded.value.key }
    return { ok: true, headers }
  }

  /**
   * `url` with a feature key as its query parameter `param`, for that feature's own request only: Exa's MCP server
   * takes its key as `exaApiKey` (02 §9.2). Never the key itself; the URL must never be logged.
   */
  async featureURL(
    id: FeatureKeyID,
    url: string,
    param: string,
  ): Promise<{ readonly ok: true; readonly url: string } | Failure> {
    const loaded = await this.#load(id).catch((): Failure => ({ ok: false, problem: "vault_unavailable" }))
    if (!loaded.ok) return loaded
    if (loaded.value.type !== "key") return { ok: false, problem: "kind_mismatch" }
    const target = new URL(url)
    target.searchParams.set(param, loaded.value.key)
    return { ok: true, url: target.href }
  }

  /**
   * The stored text of an MCP server's values (`mcp-<id>`, SM), for that server's process or connection only: own's
   * `mcp.transform` and its connection test. `not_found` when the server stores none. Never logged or answered.
   */
  async mcpSecrets(id: McpSecretID): Promise<{ readonly ok: true; readonly text: string } | Failure> {
    const loaded = await this.#load(id).catch((): Failure => ({ ok: false, problem: "vault_unavailable" }))
    if (!loaded.ok) return loaded
    if (loaded.value.type !== "key") return { ok: false, problem: "kind_mismatch" }
    return { ok: true, text: loaded.value.key }
  }

  /**
   * The stored text of a GitHub account (`github-<id>`, GH), for that account's GitHub requests and git's credential
   * requests only. `not_found` when the account stores none. Never logged or answered.
   */
  async githubSecret(id: GitHubSecretID): Promise<{ readonly ok: true; readonly text: string } | Failure> {
    const loaded = await this.#load(id).catch((): Failure => ({ ok: false, problem: "vault_unavailable" }))
    if (!loaded.ok) return loaded
    if (loaded.value.type !== "key") return { ok: false, problem: "kind_mismatch" }
    return { ok: true, text: loaded.value.key }
  }

  /** Whether a feature key is stored and its hint; `not_found` is simply "not configured". */
  async inspectFeatureKey(id: FeatureKeyID): Promise<FeatureKeyState> {
    const loaded = await this.#load(id).catch((): Failure => ({ ok: false, problem: "vault_unavailable" }))
    if (loaded.ok)
      return loaded.value.type === "key"
        ? { configured: true, keyHint: keyHint(loaded.value.key) }
        : { configured: false, problem: "kind_mismatch" }
    return loaded.problem === "not_found" ? { configured: false } : { configured: false, problem: loaded.problem }
  }

  /**
   * Deletes a feature key and its `.prev`, shredded. Evicted before the delete, which cancels a read under way, and
   * after it, since a read that started while the delete ran may still have found the key.
   */
  async removeFeatureKey(id: FeatureKeyID) {
    this.#cache.evict(id)
    const deleted = await this.#vault.delete(id, { shred: true })
    this.#cache.evict(id)
    if (!deleted.ok) return { ok: false, problem: "vault_unavailable", detail: deleted.error } satisfies Failure
    return { ok: true, deleted: deleted.deleted } as const
  }

  /**
   * Puts `.prev` back as the current item (own-vault README §6.4). OAuth refresh tokens rotate, so an OAuth `.prev`
   * may already be spent; it is restored only with `allowOAuth` (after the user confirmed).
   */
  async restorePrevious(accountID: string, options: { readonly allowOAuth?: boolean } = {}) {
    const previous = await this.#vault.get(accountID, { prev: true })
    if (!previous.ok)
      return {
        ok: false,
        problem:
          previous.error === "not_found" || previous.error === "decrypt_failed" ? previous.error : "vault_unavailable",
      } satisfies Failure
    const item = Option.getOrUndefined(decodeItem(previous.value))
    if (!item) return { ok: false, problem: "corrupt" } satisfies Failure
    if (item.type === "oauth" && !options.allowOAuth)
      return { ok: false, problem: "needs_reauth", detail: "oauth_restore_needs_confirmation" } satisfies Failure
    return this.store(accountID, item.type === "key" ? { type: "key", key: item.key } : item)
  }

  async #fromVault(input: HeadersInput): Promise<Auth> {
    const account = input.account
    const loaded = await this.#load(account.id)
    if (!loaded.ok) return loaded
    const item = loaded.value
    if (item.type === "key") {
      if (Kind.isOAuth(account.kind)) return { ok: false, problem: "kind_mismatch" }
      return result(keyHeaders(account.kind, item.key), null, "vault")
    }
    if (!Kind.isOAuth(account.kind) || item.family !== Credential.familyOf[account.kind])
      return { ok: false, problem: "kind_mismatch" }
    const usable = await this.#usableOAuth(account.id, item, input.refresher)
    if (!usable.ok) return usable
    this.#served.set(account.id, usable.item.generation)
    // Token sharing is plain Bearer auth on the public API: no account or originator header. Its session headers are
    // not credentials; own-accounts' request hook adds them from the session (02 §3.2c).
    if (account.kind === "siwc")
      return result({ authorization: `Bearer ${usable.item.access}` }, usable.item.expiresAt, "vault")
    const chatgptAccountId = account.identity.chatgptAccountId
    if (!chatgptAccountId) return { ok: false, problem: "identity_missing" }
    return result(codexHeaders(usable.item.access, chatgptAccountId, input.sessionID), usable.item.expiresAt, "vault")
  }

  async #usableOAuth(
    accountID: string,
    item: Credential.OAuthSecret,
    refresher: Refresh.Refresher | undefined,
  ): Promise<{ readonly ok: true; readonly item: Credential.OAuthSecret } | Failure> {
    const revoked = this.#refused.get(accountID)
    if (revoked?.generation === item.generation) return { ok: false, problem: "needs_reauth", detail: revoked.reason }
    const now = this.#now()
    const rejected = this.#rejected.get(accountID) === item.generation
    const due = Refresh.due(item, now) || rejected
    const valid = item.expiresAt > now
    if (!due || !refresher) return valid ? { ok: true, item } : { ok: false, problem: "expired" }
    this.#rejected.delete(accountID)
    const refreshed = await this.#refresh.run(accountID, refresher, item.generation)
    if (refreshed.type === "refreshed" || refreshed.type === "current") {
      this.#cache.set(accountID, refreshed.item)
      return { ok: true, item: refreshed.item }
    }
    if (refreshed.type === "needs_reauth") {
      this.#cache.evict(accountID)
      return { ok: false, problem: "needs_reauth", detail: refreshed.reason }
    }
    // A transient failure keeps using the current access token while it is still valid (02 §3.5 F5).
    if (valid) return { ok: true, item }
    if (refreshed.type === "backoff")
      return { ok: false, problem: "refresh_backoff", detail: refreshed.reason, retryAt: refreshed.until }
    return { ok: false, problem: "expired", detail: refreshed.reason }
  }

  async #linked(input: HeadersInput, credential: Credential.LinkedCodexSource): Promise<Auth> {
    if (input.account.kind !== "codex") return { ok: false, problem: "kind_mismatch" }
    const usable = await this.#reader(input.account, credential.source.authPath).usable()
    if (!usable.ok) {
      if (usable.reason === "stale") return { ok: false, problem: "source_stale", detail: usable.cause }
      return { ok: false, problem: "source_invalid", detail: usable.problem }
    }
    const summary = usable.snapshot.summary
    const chatgptAccountId = summary.identity.chatgptAccountId ?? input.account.identity.chatgptAccountId
    if (!chatgptAccountId) return { ok: false, problem: "identity_missing" }
    return result(
      codexHeaders(usable.snapshot.secret.access(), chatgptAccountId, input.sessionID),
      summary.expiresAt,
      "linked",
    )
  }

  async #legacy(account: Account.Info, credential: Credential.LinkedLegacyKey): Promise<Auth> {
    if (Kind.isOAuth(account.kind)) return { ok: false, problem: "kind_mismatch" }
    const usable = await this.#keyReader(credential.source.path).usable()
    if (!usable.ok) {
      if (usable.problem === "vault_unavailable") return { ok: false, problem: "vault_unavailable" }
      return { ok: false, problem: "source_invalid", detail: usable.problem }
    }
    return result(keyHeaders(account.kind, usable.snapshot.secret.key()), null, "linked")
  }

  #keyReader(file: string) {
    const existing = this.#keys.get(key(file))
    if (existing) return existing
    const reader = new LegacyKey.Reader(file, { vault: this.#vault, now: this.#now, ttlMs: this.#ttlSeconds * 1000 })
    this.#keys.set(key(file), reader)
    return reader
  }

  #load(accountID: string) {
    return this.#cache.read(accountID, async () => {
      const got = await this.#vault.get(accountID)
      if (!got.ok) {
        if (got.error === "not_found" || got.error === "decrypt_failed")
          return { ok: false, problem: got.error, hasPrev: got.hasPrev }
        return { ok: false, problem: "vault_unavailable", detail: got.error }
      }
      const item = Option.getOrUndefined(decodeItem(got.value))
      if (!item) return { ok: false, problem: "corrupt" }
      return { ok: true, value: item }
    })
  }

  #reader(account: Account.Info, authPath: string) {
    const existing = this.#readers.get(key(authPath))
    if (existing) {
      existing.expect(expectedOf(account))
      return existing
    }
    const reader = new CodexSource.Reader(authPath, {
      ...this.#readerOptions,
      now: this.#now,
      ttlMs: this.#ttlSeconds * 1000,
      expected: expectedOf(account),
    })
    this.#readers.set(key(authPath), reader)
    return reader
  }
}

/** The login an imported codex source must keep holding: the account's registry identity (02 §3.1 C5). */
export function expectedOf(account: Account.Info): CodexSource.Expected {
  return { accountId: account.identity.chatgptAccountId, fingerprint: account.identity.fingerprint }
}

/** An account's credential ref; a registry account without one uses the vault. */
export function credentialOf(account: Account.Info): Credential.Ref {
  return account.credential ?? { type: "vault" }
}

/**
 * Whether the account's secret lives in a file the old app owns (a linked codex login or a linked API key): we never
 * write, refresh or shred it, and removing the account removes only our reference.
 */
export function linked(account: Account.Info) {
  const type = credentialOf(account).type
  return type === "linked-codex-source" || type === "linked-legacy-key"
}

/** Codex request headers (02 §4.1). `session-id` is the session, never an account-specific value (R10). */
export function codexHeaders(access: string, chatgptAccountId: string, sessionID: string): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    "chatgpt-account-id": chatgptAccountId,
    "session-id": sessionID,
    originator: "opencode",
  }
}

/** API key headers (02 §4.1): `x-api-key` for Anthropic, `Authorization: Bearer` for every other kind. */
export function keyHeaders(kind: Kind.Own, key: string): Record<string, string> {
  if (kind === "anth") return { "x-api-key": key }
  return { authorization: `Bearer ${key}` }
}

function result(headers: Record<string, string>, expiresAt: number | null, source: "vault" | "linked"): Auth {
  return { ok: true, headers, hash: auth(headers)[0]?.hash ?? "", expiresAt, source }
}

function build(secret: NewSecret, generation: number, now: number): Credential.VaultItem {
  if (secret.type === "key") return { v: 1, type: "key", key: secret.key, generation }
  return {
    v: 1,
    type: "oauth",
    family: secret.family ?? "openai-chatgpt",
    access: secret.access,
    refresh: secret.refresh,
    idToken: secret.idToken,
    expiresAt: secret.expiresAt,
    obtainedAt: secret.obtainedAt ?? now,
    generation,
    clientId: secret.clientId,
    scopes: secret.scopes,
    earliestRefreshAt: secret.earliestRefreshAt,
  }
}

function linkedInspection(summary: CodexSource.Summary, ok: boolean): Inspection {
  return {
    source: "linked",
    ok,
    type: "oauth",
    expiresAt: summary.expiresAt,
    identity: summary.identity,
    lastRefresh: summary.lastRefresh,
  }
}

// Windows paths are case-insensitive; one reader per file.
function key(authPath: string) {
  const resolved = path.resolve(authPath)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
