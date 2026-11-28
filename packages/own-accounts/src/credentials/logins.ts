export * as Logins from "./logins.js"

import { Account, Kind, OwnID, type OwnAccounts, type Policy, type Registry } from "@own/protocol"
import { Credentials, Hash, type Refresh } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Nonces } from "../nonces.js"
import type { RpcTypes } from "../rpc/types.js"
import { CompatProbe } from "../slots/compat-probe.js"
import { Slots } from "../slots/slots.js"
import { Templates } from "../slots/templates.js"
import { ChatgptLogin } from "./chatgpt.js"
import { CodexImport } from "./codex.js"
import { LegacyImport } from "./legacy.js"
import { ChatgptOAuth } from "./oauth.js"
import { Probe } from "./probe.js"
import { ChatgptSharing } from "./sharing.js"
import { LoginStatus } from "./status.js"
import { LoginView } from "./view.js"

/**
 * Owner: CREDENTIALS agent. Getting and keeping secrets (02 §3): API keys with the connection probe (§3.3),
 * ChatGPT device/browser login and Sign in with ChatGPT (token sharing, §3.2c) with their token-endpoint refreshers
 * (§3.2, §3.5), codex-multi-provider import
 * (linked = read-only follow, never write the source, never refresh; takeover = plan → execute, vault, sole
 * refresher), linked old-app API keys (02 §3.2b: a reference to the old app's DPAPI file, decrypted in memory by
 * own-vault, never written), the account guard (account id + user fingerprint, C5), and the Claude subscription
 * import call.
 * Secrets live only in the vault via `runtime.credentials`; nothing here logs or returns them.
 */

export type ReplaceResult =
  | { readonly ok: true; readonly keyHint: string; readonly detected: Account.Detected }
  | {
      readonly ok: false
      readonly error: "probe_failed" | "vault_unavailable"
      readonly message: string
      /** HTTP status of a failed probe. */
      readonly status?: number
    }

export interface Api extends Module.Lifecycle {
  /**
   * Auth headers for one request of an own slot (02 §4.1): `runtime.credentials.headersFor` with this module's
   * refresher for vault OAuth items. Never throws; a failure means "inject nothing" and the request gets a 401.
   * The outcome also drives the account status (stale linked source, dead token family).
   */
  headers(account: Account.Info, sessionID: string): Promise<Credentials.Auth>
  /**
   * Token-endpoint refresher of a vault OAuth account (`codex`: `<oauthIssuer>/oauth/token`, `siwc`:
   * `<oauthIssuer>/api/accounts/oauth/token`); `undefined` otherwise.
   */
  refresher(account: Account.Info): Refresh.Refresher | undefined
  /** The provider answered 401 for this account (02 §3.5 F1): linked sources re-read, vault OAuth refreshes next use. */
  unauthorized(account: Account.Info): void
  /**
   * The provider rejected the account's login for good (Sign in with ChatGPT `invalid_user`, `chatpass_v2_*`, 02
   * §3.2c): its tokens stay unused until a new login, and the account shows `needs_reauth`.
   */
  rejected(account: Account.Info, reason: string): Promise<void>
  /**
   * The provider answered a request of the account with a success (RS, 2026-11-28): an `auth_failed` a connection
   * test's 401 left on an account own holds the credential of ends, as its next passing test would end it. A linked
   * source keeps its own check (the source file decides).
   */
  accepted(account: Account.Info): Promise<void>
  /**
   * The provider refused the account's credential a second time, after the refresh the first refusal asked for (RS):
   * an account own holds the credential of shows `auth_failed` until a success, a passing test or a new key or login.
   */
  refused(account: Account.Info): Promise<void>
  /** `accounts.update{replaceKey}`: probe, then store with `keepPrev` (02 §3.3). */
  replaceKey(account: Account.Info, key: string): Promise<ReplaceResult>
  /**
   * Account removal (02 §3.5 F7): `shred` deletes the vault item and `.prev`. A codex source file is never touched. A
   * Sign in with ChatGPT login is revoked at the issuer once the delete succeeded, best effort and in the background.
   */
  forget(account: Account.Info, options: { readonly shred: boolean }): Promise<{ readonly ok: boolean }>

  addKey: RpcTypes.Handler<"accounts.add.key">
  /** 02 §3.3a `서버에서 불러오기`: a local server's models before it is added; stores nothing. */
  localDetect: RpcTypes.Handler<"accounts.local.detect">
  chatgptStart: RpcTypes.Handler<"accounts.add.chatgpt.start">
  chatgptStatus: RpcTypes.Handler<"accounts.add.chatgpt.status">
  chatgptComplete: RpcTypes.Handler<"accounts.add.chatgpt.complete">
  chatgptCancel: RpcTypes.Handler<"accounts.add.chatgpt.cancel">
  codexList: RpcTypes.Handler<"accounts.import.codex.list">
  codexPlan: RpcTypes.Handler<"accounts.import.codex.plan">
  codexExecute: RpcTypes.Handler<"accounts.import.codex.execute">
  keysList: RpcTypes.Handler<"accounts.import.keys.list">
  keysPlan: RpcTypes.Handler<"accounts.import.keys.plan">
  keysExecute: RpcTypes.Handler<"accounts.import.keys.execute">
  test: RpcTypes.Handler<"accounts.test">
  /** `plugin.claudeAuth.importSubscription` (02 §8.2 step 6); checks `plugins.claudeSlot()` ack first. */
  claudeImport: RpcTypes.Handler<"plugin.claudeAuth.importSubscription">
}

/** Test seams that production leaves at their defaults. */
export interface Internal {
  /** Browser login callback ports (default 1455, 1457). */
  readonly callbackPorts?: ReadonlyArray<number>
  /** How long `claudeImport` waits for the `claude-code` OAuth attempt (default 30 s). */
  readonly claudeImportTimeoutMs?: number
}

/** Session id used for connection tests; it never names a real session. */
const TEST_SESSION = "own-accounts:test"

/** A keyless local model's credential (02 §3.3a): nothing to send. */
const KEYLESS: Credentials.Auth = { ok: true, headers: {}, hash: "", expiresAt: null, source: "vault" }

export function create(deps: Deps, peers: Module.Peers, internal: Internal = {}): Api {
  const log = deps.log.child("logins")
  const credentials = deps.runtime.credentials
  const tracker = new LoginStatus.Tracker({ deps, peers, log })
  const chatgpt = new ChatgptLogin.Manager({ deps, peers, log, callbackPorts: internal.callbackPorts })
  const plans = new Nonces.Scope<CodexImport.Plan>(deps.clock)
  const keyPlans = new Nonces.Scope<LegacyImport.Plan>(deps.clock)
  const subscriptions: Array<() => void> = []
  const oauth = { issuer: deps.endpoints.url.oauthIssuer, now: deps.clock.now }

  const refresher = (account: Account.Info) => {
    // Linked sources are refreshed only by the old app (C3, F9); keys have nothing to refresh.
    if (Credentials.credentialOf(account).type === "linked-codex-source") return undefined
    if (account.kind === "siwc") return ChatgptSharing.refresher(oauth, account)
    if (account.kind === "codex") return ChatgptOAuth.refresher(oauth, account)
    return undefined
  }
  /** Ends a Sign in with ChatGPT token family at the issuer; deletion never waits for it (02 §3.2c). */
  const revoke = (item: { readonly refresh: string; readonly clientId?: string }, accountID: Account.ID) => {
    const clientId = item.clientId
    if (!ChatgptSharing.isClientId(clientId)) return
    void ChatgptSharing.revoke(oauth, { token: item.refresh, clientId }).then((revoked) =>
      revoked
        ? log.info("chatgpt_sharing_revoked", { accountID })
        : log.warn("chatgpt_sharing_revoke_unconfirmed", { accountID }),
    )
  }
  const discard = async (accountID: Account.ID) => {
    const removed = await credentials.remove(orphan(accountID), { shred: true })
    if (!removed.ok) log.warn("vault_discard_failed", { accountID, problem: removed.problem })
  }
  const env: CodexImport.Env = { deps, peers, log, tracker, refresher, plans, defaults: { color: nextColor }, discard }
  const legacy: LegacyImport.Env = {
    deps,
    peers,
    log,
    plans: keyPlans,
    defaults: { color: nextColor },
    domains: keyDomains,
  }
  const view = (account: Account.Info) => LoginView.view(deps.runtime, peers().slots.snapshot(), account)
  const readPolicy = () =>
    deps.runtime.policy.read().catch((error: unknown) => {
      log.warn("policy_read_failed", { error })
      return undefined
    })
  const configure = (policy: Policy.File | undefined) => {
    if (policy) credentials.configure({ secretCacheSeconds: policy.secretCacheSeconds })
  }
  const announce = (accountID: Account.ID, status: Account.Status, phase: string) =>
    void deps.emitter.global("account.status", { accountID, status, phase })

  const replaceKey = async (account: Account.Info, key: string): Promise<ReplaceResult> => {
    if (Kind.isOAuth(account.kind)) return { ok: false, error: "probe_failed", message: "not_api_key_account" }
    const probe = await Probe.key({ kind: account.kind, key, endpoints: deps.endpoints, baseURL: baseURLOf(account) })
    if (!probe.ok) return { ok: false, error: "probe_failed", message: probe.message, status: probe.status }
    const stored = await credentials.store(account.id, { type: "key", key }, { keepPrev: true })
    if (!stored.ok) return { ok: false, error: "vault_unavailable", message: stored.problem }
    log.info("key_replaced", { accountID: account.id, generation: stored.generation })
    // SSH hosts drop their lease of the old key (04 §8.9 "폐기").
    deps.runtime.broadcast.emit("credential.replaced", { accountID: account.id, providerID: account.providerID })
    return { ok: true, keyHint: Hash.keyHint(key), detected: probe.detected }
  }

  const baseURLOf = (account: Account.Info) => peers().slots.slot(account.providerID)?.slot.baseURL

  /** Adds fallback models the account catalog lists but the shared `siwc` template lacks (02 §3.2c). */
  const completeTemplate = async (models: ReadonlyArray<ChatgptSharing.RemoteModel>) => {
    const now = deps.clock.now()
    await peers()
      .slots.mutate((registry) => {
        const id = Templates.current(registry, "siwc")
        const template = id === undefined ? undefined : registry.modelTemplates[id]
        const derived = template && ChatgptSharing.deriveModels(models, template, new Date(now).toISOString())
        return derived && Slots.refreshTemplate(registry, "siwc", derived, now)
      })
      .catch((error: unknown) => log.warn("template_complete_failed", { error }))
  }

  /** An existing live account of the kind that already holds this exact key (hash compare, no raw read). */
  const duplicateKey = async (kind: Kind.Api, key: string, baseURL: string | undefined) => {
    const hint = Hash.keyHint(key)
    const hash = Hash.auth(Credentials.keyHeaders(kind, key))[0]?.hash
    const candidates = peers()
      .slots.snapshot()
      .accounts.filter(
        (account) =>
          account.kind === kind &&
          account.status !== "retired" &&
          account.identity.keyHint === hint &&
          (kind !== "compat" || baseURLOf(account) === baseURL),
      )
    const matches = await Promise.all(
      candidates.map(async (account) => {
        const auth = await credentials.headersFor({ account, sessionID: TEST_SESSION })
        return auth.ok && auth.hash === hash ? account.id : undefined
      }),
    )
    return matches.find((id) => id !== undefined)
  }

  /** `lastVerifiedAt`, and `ready` again when a key that failed before works now. */
  const verified = (accountID: Account.ID, status: Account.Status | undefined) =>
    peers()
      .slots.mutate((registry) => ({
        ...registry,
        accounts: registry.accounts.map((account) =>
          account.id === accountID
            ? {
                ...account,
                lastVerifiedAt: new Date(deps.clock.now()).toISOString(),
                ...(status !== undefined && account.status !== "disabled" && account.status !== "retired"
                  ? { status }
                  : {}),
              }
            : account,
        ),
      }))
      .catch((error: unknown) => {
        log.warn("verify_write_failed", { accountID, error })
        return peers().slots.snapshot()
      })

  const api: Api = {
    start: async () => {
      // The slots module started first and read the policy (or another Location's instance did).
      configure(deps.runtime.policy.cached() ?? (await readPolicy()))
      subscriptions.push(
        deps.runtime.broadcast.on("store.changed", (change) => {
          if (change.store === "policy") void readPolicy().then(configure)
          // Only the leader announces; it reads the file because the change may come from another instance.
          if (change.store === "accounts" && deps.runtime.isLeader())
            void deps.runtime.registry.read().then(
              (registry) => tracker.scan(registry),
              (error: unknown) => log.warn("registry_read_failed", { error }),
            )
        }),
      )
      tracker.start()
    },

    stop: async () => {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
      tracker.stop()
      chatgpt.stop()
    },

    headers: async (account, sessionID) => {
      // 02 §3.3a: a local model added without a key sends no credential, here and on an SSH host.
      if (account.compat?.local?.keyless) return KEYLESS
      // Remote service (04 §8.6): the lease of the local broker; no vault, no refresh, no local status verdicts.
      if (deps.remote) return deps.remote.headers(account, sessionID, deps.location.directory)
      const auth = await credentials.headersFor({ account, sessionID, refresher: refresher(account) })
      tracker.observe(account, auth)
      return auth
    },

    refresher,

    unauthorized: (account) => {
      // Remote service (04 §8.8): drop the lease and send `invalidate` with the next `headers.get`.
      if (deps.remote) return deps.remote.unauthorized(account)
      const action = credentials.unauthorized(account)
      log.debug("unauthorized", { accountID: account.id, action })
    },

    replaceKey,

    rejected: async (account, reason) => {
      if (deps.remote || !credentials.reject(account, reason)) return
      log.warn("login_rejected", { accountID: account.id, reason })
      await tracker.apply(account, { ok: false, problem: "needs_reauth", detail: reason })
    },

    accepted: (account) => (deps.remote ? Promise.resolve() : tracker.accepted(account)),
    refused: (account) => (deps.remote ? Promise.resolve() : tracker.refused(account)),

    forget: async (account, options) => {
      tracker.forget(account.id)
      if (!options.shred) return { ok: true }
      const removed = await credentials.remove(account, {
        shred: true,
        revoker: account.kind === "siwc" ? (item) => revoke(item, account.id) : undefined,
      })
      if (!removed.ok) log.warn("vault_shred_failed", { accountID: account.id, problem: removed.problem })
      return { ok: removed.ok }
    },

    addKey: guard(log, "accounts.add.key", async (input, context) => {
      const options = input.options ?? {}
      const kind = input.kind
      if (kind === "compat" && !options.baseURL)
        return context.error("probe_failed", "base_url_required", { message: "base_url_required" })
      // `limit.context` is required: without it core never auto-compacts (02 §3.3 step 6, §4.7).
      const models = options.models ?? []
      if (kind === "compat" && (models.length === 0 || models.some((model) => model.contextLimit === undefined)))
        return context.error("template_unavailable", "compat_models_required", {
          kind,
          reason: models.length === 0 ? "models_required" : "context_limit_required",
        })
      // 02 §3.3a: only a local model may come without a key; its server then gets no credential at all.
      const local = kind === "compat" ? options.local : undefined
      const key = input.key
      if (key === undefined && !local) return context.error("probe_failed", "key_required", { message: "key_required" })
      const duplicate = key === undefined ? undefined : await duplicateKey(kind, key, options.baseURL)
      if (duplicate) return context.error("duplicate_account", "duplicate_account", { accountID: duplicate })
      const probe =
        key === undefined
          ? await Probe.run({
              kind,
              headers: {},
              endpoints: deps.endpoints,
              baseURL: options.baseURL,
              signal: context.signal,
            })
          : await Probe.key({ kind, key, endpoints: deps.endpoints, baseURL: options.baseURL, signal: context.signal })
      if (!probe.ok)
        return context.error("probe_failed", probe.message, {
          ...(probe.status === undefined ? {} : { status: probe.status }),
          message: probe.message,
        })
      const identity = key === undefined ? {} : keyIdentity(key, probe.detected, options)
      const domains = keyDomains(kind, identity)
      const registry = peers().slots.snapshot()
      const id = Account.ID.create()
      // Persist before use (02 §3.3 step 4): the key is in the vault before any slot can reach it.
      const stored = key === undefined ? { ok: true as const } : await credentials.store(id, { type: "key", key })
      if (!stored.ok) return context.error("vault_unavailable", stored.problem, {})
      const created = await peers().slots.createAccount({
        id,
        kind,
        label: input.label,
        color: input.color ?? nextColor(registry),
        identity,
        cacheDomain: domains.cacheDomain,
        quotaDomain: domains.quotaDomain,
        baseURL: options.baseURL,
        compatModels: kind === "compat" ? models : undefined,
        ...(local ? { local: { format: local.format, ...(key === undefined ? { keyless: true as const } : {}) } } : {}),
        status: "ready",
        ...(key === undefined ? {} : { method: "api-key" as const }),
      })
      if (!created.ok) {
        await discard(id)
        return context.error("template_unavailable", created.reason, { kind, reason: created.reason })
      }
      log.info("key_account_added", { accountID: id, kind, providerID: created.account.providerID })
      announce(id, created.account.status, "added")
      return {
        account: { id, providerID: created.account.providerID, status: created.account.status },
        test: { ok: true, detected: probe.detected },
        sameDomainCandidates: sameDomain(registry, kind, domains.cacheDomain),
      }
    }),

    localDetect: guard(log, "accounts.local.detect", async (input) => {
      const started = performance.now()
      const found = await CompatProbe.discover({
        baseURL: input.baseURL.trim(),
        headers: input.key === undefined ? {} : Credentials.keyHeaders("compat", input.key),
      })
      const latencyMs = Math.round(performance.now() - started)
      if (!found.ok)
        return { ok: false, models: [], latencyMs, ...(found.status === undefined ? {} : { status: found.status }) }
      const result = found.result
      return {
        ok: true,
        family: result.family,
        latencyMs,
        models: found.models.map((id) => {
          const detected = result.capabilities.get(id)
          const context = result.contexts?.get(id)
          const output = result.outputs.get(id)
          return {
            id,
            ...(context === undefined ? {} : { context }),
            ...(output === undefined ? {} : { output }),
            ...(detected?.image === undefined ? {} : { image: detected.image }),
            ...(detected?.tools === undefined ? {} : { tools: detected.tools }),
            ...(detected?.reasoning === undefined ? {} : { reasoning: detected.reasoning }),
          }
        }),
      }
    }),

    chatgptStart: guard(log, "accounts.add.chatgpt.start", async (input, context) => {
      // Sign in with ChatGPT re-logs only `siwc` accounts, the Codex-style methods only `codex` ones.
      const kind = input.method === "siwc" ? "siwc" : "codex"
      const target = input.accountID === undefined ? undefined : peers().slots.account(input.accountID)
      if (input.accountID !== undefined && (!target || target.kind !== kind || target.status === "retired"))
        return context.error("account_not_found", "account_not_found", { accountID: input.accountID })
      const started = await chatgpt.start({
        method: input.method,
        target: target?.id,
        consent: input.consent,
        retryOf: input.retryOf,
      })
      if (!started.ok) return context.error("internal_error", started.reason, {})
      return started.start
    }),

    chatgptStatus: guard(log, "accounts.add.chatgpt.status", async (input) => chatgpt.status(input.attemptID)),

    chatgptComplete: guard(log, "accounts.add.chatgpt.complete", async (input, context) => {
      const authorized = chatgpt.authorized(input.attemptID)
      if (!authorized.ok) return context.error("internal_error", authorized.reason, {})
      const login = authorized.login
      const slots = peers().slots
      if (login.target !== undefined && !slots.account(login.target)) {
        // The attempt owns the tokens again: a cancel or expiry ends their family.
        chatgpt.released(login.attemptID)
        return context.error("account_not_found", "account_not_found", { accountID: login.target })
      }
      const now = deps.clock.now()
      // A duplicate removed since `status` falls back to a new account.
      const targetID = login.target ?? (login.duplicateOf && slots.account(login.duplicateOf)?.id)
      if (targetID) {
        // The replaced family stays in `.prev`, not revoked: a re-login reuses the account's issued client, and an issuer
        // that ends the whole user+client grant on revoke would end the new family too (02 §3.2c, ch. 12 #55 ⚠).
        const stored = await credentials.store(targetID, login.tokens.secret(now), { keepPrev: true })
        if (!stored.ok) {
          chatgpt.released(login.attemptID)
          return context.error("vault_unavailable", stored.problem, {})
        }
        chatgpt.completed(login.attemptID)
        const registry = await slots.mutate((current) => ({
          ...current,
          accounts: current.accounts.map((account) =>
            account.id === targetID
              ? {
                  ...account,
                  ...(input.label ? { label: input.label } : {}),
                  ...(input.color ? { color: input.color } : {}),
                  identity: ChatgptLogin.mergeIdentity(account.identity, login.identity),
                  // A fresh own login: the vault item is the credential now (a linked/takeover source no longer is).
                  credential: undefined,
                  method: chatgptMethod(login.method),
                  status: account.status === "disabled" ? account.status : "ready",
                  lastVerifiedAt: new Date(now).toISOString(),
                }
              : account,
          ),
        }))
        const account = registry.accounts.find((candidate) => candidate.id === targetID)
        if (!account) return context.error("account_not_found", "account_not_found", { accountID: targetID })
        log.info("chatgpt_reauthenticated", { accountID: targetID, generation: stored.generation })
        deps.runtime.broadcast.emit("credential.replaced", { accountID: account.id, providerID: account.providerID })
        announce(targetID, account.status, "completed")
        return { account: view(account), reauthenticated: true }
      }
      const id = Account.ID.create()
      const stored = await credentials.store(id, login.tokens.secret(now))
      if (!stored.ok) {
        chatgpt.released(login.attemptID)
        return context.error("vault_unavailable", stored.problem, {})
      }
      chatgpt.completed(login.attemptID)
      // A token-sharing client is bound to one user and workspace: its issued client id is the domain (02 §3.2c).
      const sharing =
        login.kind === "siwc" ? { scope: "chatgpt_sharing" as const, externalId: login.tokens.clientId } : undefined
      const created = await slots.createAccount({
        id,
        kind: login.kind,
        label: input.label || login.identity.emailMasked || "ChatGPT",
        color: input.color ?? nextColor(slots.snapshot()),
        identity: login.identity,
        cacheDomain: sharing ?? { scope: "chatgpt_login", externalId: login.identity.chatgptAccountId },
        quotaDomain: sharing ?? { scope: "chatgpt_seat", externalId: login.identity.chatgptAccountId },
        status: "ready",
        method: chatgptMethod(login.method),
      })
      if (!created.ok) {
        // Nothing keeps these tokens after the discard: a token-sharing family is ended too.
        revoke(login.tokens.secret(now), id)
        await discard(id)
        return context.error("template_unavailable", created.reason, { kind: login.kind, reason: created.reason })
      }
      log.info("chatgpt_account_added", { accountID: id, providerID: created.account.providerID, kind: login.kind })
      announce(id, created.account.status, "completed")
      return { account: view(created.account), reauthenticated: false }
    }),

    chatgptCancel: guard(log, "accounts.add.chatgpt.cancel", async (input) => {
      chatgpt.cancel(input.attemptID)
      return {}
    }),

    codexList: guard(log, "accounts.import.codex.list", async () => CodexImport.list(env)),

    codexPlan: guard(log, "accounts.import.codex.plan", async (input, context) => {
      const planned = await CodexImport.plan(env, input)
      if (planned.ok) return planned.plan
      const failure = planned.failure
      if (failure.type === "source_not_found")
        return context.error("source_not_found", "source_not_found", { profileID: failure.profileID })
      if (failure.type === "source_invalid")
        return context.error("source_invalid", failure.reason, { profileID: failure.profileID, reason: failure.reason })
      if (failure.type === "account_not_found")
        return context.error("account_not_found", "account_not_found", { accountID: failure.accountID })
      return context.error("internal_error", failure.type, {})
    }),

    codexExecute: guard(log, "accounts.import.codex.execute", async (input, context) => {
      const executed = await CodexImport.execute(env, input)
      if (executed.ok) {
        const result = executed.result
        log.info("codex_imported", { accountID: result.account.id, mode: result.mode })
        announce(result.account.id, result.account.status, `imported_${result.mode}`)
        return { account: view(result.account), mode: result.mode, reauthenticated: result.reauthenticated }
      }
      const failure = executed.failure
      if (failure.type === "nonce_invalid") return context.error("nonce_invalid", "nonce_invalid", {})
      if (failure.type === "source_not_found")
        return context.error("source_not_found", "source_not_found", { profileID: failure.profileID })
      if (failure.type === "source_invalid")
        return context.error("source_invalid", failure.reason, { profileID: failure.profileID, reason: failure.reason })
      if (failure.type === "account_not_found")
        return context.error("account_not_found", "account_not_found", { accountID: failure.accountID })
      if (failure.type === "template_unavailable")
        return context.error("template_unavailable", failure.reason, { kind: "codex", reason: failure.reason })
      return context.error("vault_unavailable", "vault_unavailable", {})
    }),

    keysList: guard(log, "accounts.import.keys.list", async () => LegacyImport.list(legacy)),

    keysPlan: guard(log, "accounts.import.keys.plan", async (input, context) => {
      const planned = await LegacyImport.plan(legacy, input)
      if (planned.ok) return planned.plan
      const failure = planned.failure
      if (failure.type === "legacy_key_not_found")
        return context.error("legacy_key_not_found", "legacy_key_not_found", { providerRef: failure.providerRef })
      if (failure.type === "legacy_key_invalid")
        return context.error("legacy_key_invalid", failure.reason, {
          providerRef: failure.providerRef,
          reason: failure.reason,
        })
      if (failure.type === "vault_unavailable") return context.error("vault_unavailable", "vault_unavailable", {})
      return context.error("internal_error", failure.type, {})
    }),

    keysExecute: guard(log, "accounts.import.keys.execute", async (input, context) => {
      const executed = await LegacyImport.execute(legacy, { ...input, signal: context.signal })
      if (executed.ok) {
        const result = executed.result
        const account = result.account
        if (!account)
          return { account: null, dryRun: true, keyHint: result.keyHint, test: { ok: false, skipped: true } }
        announce(account.id, account.status, "imported_legacy_key")
        return {
          account: view(peers().slots.account(account.id) ?? account),
          dryRun: false,
          keyHint: result.keyHint,
          test: { ok: true, skipped: false, detected: result.detected },
        }
      }
      const failure = executed.failure
      if (failure.type === "nonce_invalid") return context.error("nonce_invalid", "nonce_invalid", {})
      if (failure.type === "legacy_key_not_found")
        return context.error("legacy_key_not_found", "legacy_key_not_found", { providerRef: failure.providerRef })
      if (failure.type === "legacy_key_invalid")
        return context.error("legacy_key_invalid", failure.reason, {
          providerRef: failure.providerRef,
          reason: failure.reason,
        })
      if (failure.type === "duplicate_account")
        return context.error("duplicate_account", "duplicate_account", { accountID: failure.accountID })
      if (failure.type === "probe_failed")
        return context.error("probe_failed", failure.message, {
          ...(failure.status === undefined ? {} : { status: failure.status }),
          message: failure.message,
        })
      if (failure.type === "template_unavailable")
        return context.error("template_unavailable", failure.reason, { kind: failure.kind, reason: failure.reason })
      return context.error("vault_unavailable", "vault_unavailable", {})
    }),

    test: guard(log, "accounts.test", async (input, context) => {
      const account = peers().slots.account(input.accountID)
      if (!account || account.status === "retired")
        return context.error("account_not_found", "account_not_found", { accountID: input.accountID })
      const started = performance.now()
      const latencyMs = () => Math.round(performance.now() - started)
      const current = () => peers().slots.account(account.id)?.status ?? account.status
      if (account.kind === "siwc") {
        const auth = await credentials.headersFor({ account, sessionID: TEST_SESSION, refresher: refresher(account) })
        await tracker.apply(account, auth)
        if (!auth.ok && auth.problem === "vault_unavailable")
          return context.error("vault_unavailable", "vault_unavailable", {})
        if (!auth.ok && auth.problem === "needs_reauth")
          return context.error("needs_reauth", auth.detail ?? "needs_reauth", { accountID: account.id })
        if (!auth.ok) return { ok: false, status: current(), latencyMs: latencyMs() }
        // The account's model catalog is the billing-free check that the API accepts the token (02 §3.2c).
        const catalog = await ChatgptSharing.fetchModels(
          baseURLOf(account) ?? deps.endpoints.url.openai,
          auth.headers,
          context.signal,
        )
        // Only a 401 is the token's: a 403 is eligibility, policy or region, which no refresh heals (02 §3.2c), so it
        // is a failed probe naming the code and the token is not marked for an early refresh.
        if (!catalog.ok && catalog.status === 401) {
          credentials.unauthorized(account)
          await verified(account.id, "auth_failed")
          return { ok: false, status: current(), latencyMs: latencyMs() }
        }
        if (!catalog.ok)
          return context.error("probe_failed", catalog.reason, {
            ...(catalog.status === undefined ? {} : { status: catalog.status }),
            message: catalog.reason,
          })
        await completeTemplate(catalog.models)
        // 02 §4.8: the speed tiers the account's catalog names (usually none: the catalog's modes stay unverified).
        peers().speed.sharing(account.id, catalog.models)
        const recovered = account.status === "auth_failed" || account.status === "needs_reauth"
        await verified(account.id, recovered ? "ready" : undefined)
        return { ok: true, status: current(), latencyMs: latencyMs() }
      }
      if (Kind.isOAuth(account.kind)) {
        // No billing-free model call exists for ChatGPT logins: the test checks the token state and refreshes a due
        // vault token (linked sources are only re-read).
        const auth =
          Credentials.credentialOf(account).type === "linked-codex-source"
            ? await credentials.inspect(account)
            : await credentials.headersFor({ account, sessionID: TEST_SESSION, refresher: refresher(account) })
        await tracker.apply(account, auth)
        if (!auth.ok && auth.problem === "vault_unavailable")
          return context.error("vault_unavailable", "vault_unavailable", {})
        if (!auth.ok && auth.problem === "needs_reauth")
          return context.error("needs_reauth", auth.detail ?? "needs_reauth", { accountID: account.id })
        if (!auth.ok) return { ok: false, status: current(), latencyMs: latencyMs() }
        await verified(account.id, undefined)
        return { ok: true, status: current(), latencyMs: latencyMs() }
      }
      const auth = account.compat?.local?.keyless
        ? KEYLESS
        : await credentials.headersFor({ account, sessionID: TEST_SESSION })
      if (!auth.ok) {
        await tracker.apply(account, auth)
        if (auth.problem === "vault_unavailable") return context.error("vault_unavailable", "vault_unavailable", {})
        // A linked old-app key the file no longer holds (deleted, unreadable): the old app has to fix it, not a login.
        if (auth.problem === "source_invalid") return { ok: false, status: current(), latencyMs: latencyMs() }
        return context.error("needs_reauth", auth.problem, { accountID: account.id })
      }
      const probe = await Probe.run({
        kind: account.kind,
        headers: auth.headers,
        endpoints: deps.endpoints,
        baseURL: baseURLOf(account),
        signal: context.signal,
      })
      if (!probe.ok && probe.reason === "unauthorized") {
        await verified(account.id, "auth_failed")
        return { ok: false, status: current(), latencyMs: probe.latencyMs }
      }
      if (!probe.ok)
        return context.error("probe_failed", probe.message, {
          ...(probe.status === undefined ? {} : { status: probe.status }),
          message: probe.message,
        })
      const recovered = account.status === "auth_failed" || account.status === "needs_reauth"
      await verified(account.id, recovered ? "ready" : undefined)
      // 02 §3.3: `연결 확인` reads a compat server again (a model loaded with a projector, a newer server).
      if (account.kind === "compat")
        await peers()
          .slots.probeCompat(account.id)
          .catch((error: unknown) => log.warn("compat_probe_failed", { accountID: account.id, error }))
      return { ok: true, status: current(), detected: probe.detected, latencyMs: probe.latencyMs }
    }),

    claudeImport: guard(log, "plugin.claudeAuth.importSubscription", async (_input, context) => {
      const slot = peers().plugins.claudeSlot()
      if (!slot.detected) return context.error("plugin_not_installed", "plugin_not_installed", {})
      // 02 §8.7: with several Claude accounts the import names the slot's own account (the plugin shows a picker then).
      const claude = peers().claude
      const account = claude.multi() ? claude.entry(Account.ID.claudeSlot)?.key : undefined
      const ok = await importClaude(deps, internal.claudeImportTimeoutMs ?? 30_000, account).catch((error: unknown) => {
        log.warn("claude_import_failed", { error })
        return false
      })
      const active = await deps.ctx.integration.connection.active("anthropic").catch(() => undefined)
      return { ok, connection: claudeConnection(active) }
    }),
  }
  return api
}

/**
 * Runs the `claude-code` OAuth method of integration `anthropic` (02 §8.2 step 6). Its authorize step resolves on
 * its own from Claude Code's stored login, so the attempt is only polled until it ends.
 */
async function importClaude(deps: Deps, timeoutMs: number, account: string | undefined) {
  const integration = deps.ctx.integration
  const attempt = await integration.oauth.connect({
    integrationID: "anthropic",
    methodID: "claude-code",
    ...(account === undefined ? {} : { answer: { account } }),
  })
  const deadline = performance.now() + timeoutMs
  const poll = async (): Promise<boolean> => {
    const status = await integration.oauth.status({ integrationID: "anthropic", attemptID: attempt.data.attemptID })
    if (status.data.status === "complete") return true
    if (status.data.status !== "pending" || performance.now() >= deadline) return false
    await Bun.sleep(250)
    return poll()
  }
  return poll()
}

type ClaudeConnectionInfo =
  | { readonly type: "credential"; readonly label: string; readonly method: "key" | "oauth" | "external" }
  | { readonly type: "env"; readonly name: string }

function claudeConnection(active: ClaudeConnectionInfo | undefined): Account.Connection | null {
  if (!active) return null
  if (active.type === "env") return { type: "env", label: active.name }
  if (active.method === "key") return { type: "key", label: active.label }
  // An external credential (one another app keeps signed in) shows as the subscription sign-in it stands for.
  return { type: "oauth", method: "claude-code", label: active.label }
}

/** Wraps a handler so an unexpected throw becomes a declared `internal_error` instead of HTTP 500 (02 §9.4). */
function guard<N extends RpcTypes.MethodName>(
  log: Deps["log"],
  method: N,
  handler: RpcTypes.Handler<N>,
): RpcTypes.Handler<N> {
  const wrapped = (input: RpcTypes.Input<N>, context: RpcTypes.Context<N>) =>
    handler(input, context).catch((error: unknown) => {
      log.error("rpc_failed", { method, error })
      return internalError(context)
    })
  return wrapped as RpcTypes.Handler<N>
}

function internalError<N extends RpcTypes.MethodName>(context: RpcTypes.Context<N>) {
  // SAFETY: every method's error map contains `internal_error` with empty data (`OwnError.pick` always adds it);
  // TypeScript cannot see that through the generic method name.
  const error = context.error as unknown as (type: "internal_error", message: string, data: object) => never
  return error("internal_error", "unexpected", {})
}

/** Registry identity of an API key account: the key hint plus detected (or user-given) domain ids. */
function keyIdentity(
  key: string,
  detected: Account.Detected,
  options: { readonly organization?: string; readonly project?: string },
): Account.Identity {
  return {
    keyHint: Hash.keyHint(key),
    organizationId: detected.organizationId ?? options.organization ?? undefined,
    projectId: detected.projectId ?? options.project ?? undefined,
    workspaceId: detected.workspaceId ?? undefined,
    teamId: detected.teamId ?? undefined,
  }
}

/** Cache and quota domains of a new key (02 §2.2 kind table, §3.3): per key until the provider domain is known. */
function keyDomains(kind: Kind.Api, identity: Account.Identity) {
  const perKey = { scope: "api_key" } as const
  const org = identity.organizationId ?? undefined
  const project = identity.projectId ?? undefined
  if (kind === "oai")
    return {
      cacheDomain: org ? { scope: "openai_org" as const, externalId: org } : perKey,
      quotaDomain: org
        ? project
          ? { scope: "openai_org_project" as const, externalId: `${org}/${project}` }
          : { scope: "openai_org" as const, externalId: org }
        : perKey,
    }
  if (kind === "anth")
    return {
      cacheDomain: identity.workspaceId
        ? { scope: "anthropic_workspace" as const, externalId: identity.workspaceId }
        : perKey,
      quotaDomain: org ? { scope: "anthropic_org" as const, externalId: org } : perKey,
    }
  if (kind === "xai")
    return {
      cacheDomain: perKey,
      quotaDomain: identity.teamId ? { scope: "xai_team" as const, externalId: identity.teamId } : perKey,
    }
  if (kind === "or") return { cacheDomain: perKey, quotaDomain: { scope: "openrouter_key" as const } }
  return { cacheDomain: perKey, quotaDomain: perKey }
}

/** Accounts already in the detected cache domain (03 §5.4 "같은 캐시 도메인 감지"). */
function sameDomain(
  registry: Registry.File,
  kind: Kind.Api,
  domain: { readonly scope: Registry.CacheDomainScope; readonly externalId?: string },
) {
  if (domain.externalId === undefined) return []
  return registry.accounts
    .filter((account) => account.kind === kind && account.status !== "retired")
    .filter((account) => {
      const existing = registry.cacheDomains[account.cacheDomain]
      return existing?.scope === domain.scope && existing.externalId === domain.externalId
    })
    .map((account) => account.id)
}

/** The first account color not used by a live account (03 §13.2), cycling when all eight are taken. */
function nextColor(registry: Registry.File): Account.Color {
  const live = registry.accounts.filter((account) => account.status !== "retired")
  const used = new Set(live.map((account) => account.color))
  const colors = Account.Color.literals
  return colors.find((color) => !used.has(color)) ?? colors[live.length % colors.length]
}

/**
 * A throwaway account record for a vault item that no registry account references (a create that failed after the
 * secret was stored), so `Credentials.remove` can shred it.
 */
function orphan(id: Account.ID): Account.Info {
  return {
    id,
    kind: "oai",
    label: id,
    shortLabel: "",
    color: "slate",
    providerID: Kind.ProviderID.from("oai", "orphan"),
    cacheDomain: OwnID.CacheDomainID.make("cd_orphan"),
    quotaDomain: OwnID.QuotaDomainID.make("qd_orphan"),
    billing: "metered",
    identity: {},
    autoSwitch: false,
    status: "retired",
  }
}

/** The stored login method of a ChatGPT login (`Account.Info.method`, shown as `connection.method`). */
function chatgptMethod(method: OwnAccounts.LoginMethod): Account.ConnectionMethod {
  if (method === "siwc") return "chatgpt-siwc"
  return method === "device" ? "chatgpt-device" : "chatgpt-browser"
}
