export * as ChatgptLogin from "./chatgpt.js"

import { timingSafeEqual } from "node:crypto"
import type { Server } from "bun"
import { Kv, OwnID, type Account, type Kind, type OwnAccounts } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Logger } from "../logger.js"
import type { Module } from "../module.js"
import { ChatgptOAuth } from "./oauth.js"
import { ChatgptSharing } from "./sharing.js"

/** How long an authorized login waits for `complete` before its tokens are dropped. */
export const AUTHORIZED_TTL_MS = 10 * 60_000
/** How long a browser login waits for the callback. */
export const BROWSER_TTL_MS = 10 * 60_000
/** Finished attempts stay answerable by `status` this long. */
export const KEEP_MS = 10 * 60_000

export interface Authorized {
  readonly attemptID: OwnID.AttemptID
  /** How the user logged in, stored as the account's `method` (`chatgpt-device` / `-browser` / `-siwc`). */
  readonly method: OwnAccounts.LoginMethod
  /** `codex` for the Codex-style login, `siwc` for Sign in with ChatGPT (token sharing). */
  readonly kind: Kind.OAuth
  readonly tokens: ChatgptOAuth.Tokens
  readonly identity: Account.Identity
  /** `start{accountID}`: re-authenticate this account. */
  readonly target?: Account.ID
  /** New-account flow: an account with the same fingerprint exists; `complete` re-authenticates it (02 §3.2 step 3). */
  readonly duplicateOf?: Account.ID
}

export type StartResult =
  | { readonly ok: true; readonly start: OwnAccounts.LoginStart }
  | { readonly ok: false; readonly reason: string }

interface Attempt {
  readonly id: OwnID.AttemptID
  readonly method: OwnAccounts.LoginMethod
  readonly kind: Kind.OAuth
  readonly target?: Account.ID
  readonly abort: AbortController
  /** Pending timers and the browser callback server of the current phase. */
  readonly cleanups: Array<() => void>
  phase: OwnAccounts.LoginPhase
  /** `complete` stored the tokens; the attempt only answers `status` from now on. */
  completed: boolean
  error?: string
  tokens?: ChatgptOAuth.Tokens
  identity?: Account.Identity
  duplicateOf?: Account.ID
  /**
   * Sign in with ChatGPT: the issued client id this attempt is bound to (the re-login account's saved one, the one of
   * the attempt it retries, or the one its first valid callback returned). Kept after the attempt ends, so neither a
   * retried exchange nor a retry of the attempt registers another client.
   */
  clientId?: string
  /** `complete` is storing these tokens: ending the attempt meanwhile must not revoke the family it stores. */
  storing?: boolean
}

/**
 * ChatGPT login attempts of this instance (02 §3.2, §3.2c). Device code is the default; browser PKCE listens on
 * `localhost:1455`, then 1457; Sign in with ChatGPT listens on `127.0.0.1` on an ephemeral port. Tokens stay in memory
 * only until `complete` stores them in the vault (persist before any use); nothing is written for an attempt that is
 * cancelled, fails, or expires. Login RPCs are global methods, so every call of one attempt reaches the
 * control-location instance that started it.
 */
export class Manager {
  readonly #deps: Deps
  readonly #peers: Module.Peers
  readonly #log: Logger.Logger
  readonly #ports: ReadonlyArray<number>
  readonly #attempts = new Map<string, Attempt>()
  readonly #sweeps = new Set<() => void>()

  constructor(input: {
    readonly deps: Deps
    readonly peers: Module.Peers
    readonly log: Logger.Logger
    /** Browser callback ports; tests pass `[0]`. */
    readonly callbackPorts?: ReadonlyArray<number>
  }) {
    this.#deps = input.deps
    this.#peers = input.peers
    this.#log = input.log
    this.#ports = input.callbackPorts ?? ChatgptOAuth.CALLBACK_PORTS
  }

  async start(input: {
    readonly method: OwnAccounts.LoginMethod
    readonly target?: Account.ID
    /** Sign in with ChatGPT only: ask for consent again (`prompt=consent`). */
    readonly consent?: boolean
    /** Sign in with ChatGPT only: the finished new-account attempt this one tries again; its issued client is reused. */
    readonly retryOf?: string
  }): Promise<StartResult> {
    const attempt: Attempt = {
      id: OwnID.AttemptID.create(),
      method: input.method,
      kind: input.method === "siwc" ? "siwc" : "codex",
      target: input.target,
      abort: new AbortController(),
      cleanups: [],
      phase: "pending",
      completed: false,
    }
    const started =
      input.method === "siwc"
        ? await this.#sharing(attempt, input.consent === true, input.retryOf)
        : input.method === "device"
          ? await this.#device(attempt)
          : await this.#browser(attempt)
    if (!started.ok) {
      this.#stopPhase(attempt)
      return started
    }
    this.#attempts.set(attempt.id, attempt)
    this.#event(attempt, { phase: "awaiting_user" })
    return started
  }

  status(attemptID: string): OwnAccounts.LoginStatus {
    const attempt = this.#attempts.get(attemptID)
    if (!attempt) return { phase: "failed", error: "attempt_not_found" }
    return {
      phase: attempt.phase,
      identity: attempt.identity && { emailMasked: attempt.identity.emailMasked, plan: attempt.identity.plan },
      duplicateOf: attempt.duplicateOf,
      error: attempt.error,
    }
  }

  /**
   * The tokens of an authorized attempt, for `complete`. Refused while another `complete` stores them, or both would
   * store one token family (two accounts sharing a refresh token).
   */
  authorized(
    attemptID: string,
  ): { readonly ok: true; readonly login: Authorized } | { readonly ok: false; readonly reason: string } {
    const attempt = this.#attempts.get(attemptID)
    if (!attempt) return { ok: false, reason: "attempt_not_found" }
    if (attempt.completed) return { ok: false, reason: "attempt_completed" }
    if (attempt.phase !== "authorized" || !attempt.tokens || !attempt.identity)
      return { ok: false, reason: `attempt_${attempt.phase}` }
    if (attempt.storing) return { ok: false, reason: "attempt_storing" }
    attempt.storing = true
    return {
      ok: true,
      login: {
        attemptID: attempt.id,
        method: attempt.method,
        kind: attempt.kind,
        tokens: attempt.tokens,
        identity: attempt.identity,
        target: attempt.target,
        duplicateOf: attempt.duplicateOf,
      },
    }
  }

  /** `complete` could not store the tokens: the attempt owns them again (a later cancel or expiry revokes them). */
  released(attemptID: string) {
    const attempt = this.#attempts.get(attemptID)
    if (attempt) attempt.storing = false
  }

  /** `complete` stored the tokens in the vault: drop them here and keep a tombstone for `status`. */
  completed(attemptID: string) {
    const attempt = this.#attempts.get(attemptID)
    if (!attempt) return
    this.#stopPhase(attempt)
    attempt.completed = true
    attempt.tokens = undefined
    this.#retire(attempt)
  }

  cancel(attemptID: string) {
    const attempt = this.#attempts.get(attemptID)
    if (!attempt || attempt.completed || (attempt.phase !== "pending" && attempt.phase !== "authorized")) return
    this.#finish(attempt, "cancelled")
    this.#event(attempt, { phase: "cancelled" })
  }

  stop() {
    for (const attempt of this.#attempts.values()) this.#stopPhase(attempt)
    for (const sweep of this.#sweeps) sweep()
    this.#sweeps.clear()
    this.#attempts.clear()
  }

  async #device(attempt: Attempt): Promise<StartResult> {
    const issuer = this.#deps.endpoints.url.oauthIssuer
    const device = await ChatgptOAuth.deviceStart(this.#client(attempt))
    if (!device.ok) {
      this.#log.warn("chatgpt_device_start_failed", { reason: device.reason })
      return { ok: false, reason: `device_start_failed:${device.reason}` }
    }
    const expiresAt = this.#deps.clock.now() + ChatgptOAuth.DEVICE_TTL_MS
    // 02 §3.2 step 3: poll every `max(interval, 1s) + 3s`.
    const delay = device.intervalMs + ChatgptOAuth.DEVICE_POLL_MARGIN_MS
    const poll = async () => {
      if (attempt.phase !== "pending") return
      const result = await ChatgptOAuth.devicePoll(this.#client(attempt), device)
      if (attempt.phase !== "pending") return
      if (result.type === "pending") {
        attempt.cleanups.push(this.#deps.clock.schedule(delay, run))
        return
      }
      if (result.type === "failed") return this.#fail(attempt, result.reason)
      this.#authorize(attempt, result.tokens, result.tokens.identity())
    }
    const run = () => {
      void poll().catch((error: unknown) => this.#fail(attempt, "poll_failed", error))
    }
    attempt.cleanups.push(this.#deps.clock.schedule(delay, run))
    this.#expireAt(attempt, expiresAt)
    return {
      ok: true,
      start: {
        attemptID: attempt.id,
        method: "device",
        verificationURL: `${issuer}/codex/device`,
        userCode: device.userCode,
        expiresAt,
      },
    }
  }

  async #browser(attempt: Attempt): Promise<StartResult> {
    const issuer = this.#deps.endpoints.url.oauthIssuer
    const pkce = await ChatgptOAuth.pkce()
    const state = ChatgptOAuth.state()
    const redirect = (port: number | undefined) => `http://localhost:${port}/auth/callback`
    // A reloaded callback page must not exchange the one-time code twice (the second would fail the attempt).
    const flight = { exchanging: false }
    const failed = this.#crashed(attempt, "Login failed. You can close this window.")
    const server = listen("localhost", this.#ports, failed, async (request, port) => {
      const url = new URL(request.url)
      if (url.pathname === "/cancel") {
        this.cancel(attempt.id)
        return page(200, "Login cancelled.")
      }
      if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 })
      if (attempt.phase !== "pending") return page(400, "This login attempt is no longer active.")
      if (url.searchParams.get("error")) {
        this.#fail(attempt, "authorization_denied")
        return page(400, "Login failed. You can close this window.")
      }
      const code = url.searchParams.get("code")
      if (!code || url.searchParams.get("state") !== state) return page(400, "Invalid login callback.")
      if (flight.exchanging) return page(409, "This login is already being completed.")
      flight.exchanging = true
      const exchanged = await ChatgptOAuth.exchange(this.#client(attempt), {
        code,
        verifier: pkce.verifier,
        redirect: redirect(port),
      })
      if (!exchanged.ok) {
        this.#fail(attempt, exchanged.reason)
        return page(400, "Login failed. You can close this window.")
      }
      this.#authorize(attempt, exchanged.tokens, exchanged.tokens.identity())
      return page(200, "Login complete. You can close this window and return to own-open-code.")
    })
    if (!server) return { ok: false, reason: "callback_ports_in_use" }
    // Graceful stop, so the page of the request that ends the attempt is still delivered.
    attempt.cleanups.push(() => void server.stop())
    const expiresAt = this.#deps.clock.now() + BROWSER_TTL_MS
    this.#expireAt(attempt, expiresAt)
    return {
      ok: true,
      start: {
        attemptID: attempt.id,
        method: "browser",
        authorizeURL: ChatgptOAuth.authorizeURL(issuer, { redirect: redirect(server.port), pkce, state }),
        expiresAt,
      },
    }
  }

  /**
   * Sign in with ChatGPT (02 §3.2c): PKCE, state and nonce, a loopback listener on `127.0.0.1` that runs before the
   * authorize URL is returned, and the success page only after the exchange, the sharing-scope check, ID token
   * verification and the account guard. "Add account" registers a new client unless it retries (`retryOf`) a
   * finished new-account attempt that already got one; a re-login reuses the account's issued client id and must be
   * the same `sub`. Stray or forged requests never consume the attempt.
   */
  async #sharing(attempt: Attempt, consent: boolean, retryOf: string | undefined): Promise<StartResult> {
    const issuer = this.#deps.endpoints.url.oauthIssuer
    const hostId = await this.#hostId()
    if (!hostId) return { ok: false, reason: "host_id_unavailable" }
    const target = attempt.target === undefined ? undefined : this.#peers().slots.account(attempt.target)
    attempt.clientId = target ? await this.#savedClientId(target) : this.#issuedTo(retryOf)
    if (target && !attempt.clientId) return { ok: false, reason: "client_id_missing" }
    const pkce = await ChatgptOAuth.pkce()
    const state = ChatgptOAuth.state()
    const nonce = ChatgptOAuth.state()
    const origin = (port: number | undefined) => `${ChatgptSharing.CALLBACK_HOST}:${port}`
    const redirect = (port: number | undefined) => `http://${origin(port)}${ChatgptSharing.CALLBACK_PATH}`
    // A reloaded callback page must not exchange the one-time code twice (the second would fail the attempt).
    const flight = { exchanging: false }
    const callback: Handler = async (request, port) => {
      const url = new URL(request.url)
      // Another host name is a rebinding attempt, not the browser coming back.
      if (request.headers.get("host") !== origin(port)) return page(400, "Invalid request.")
      if (url.pathname !== ChatgptSharing.CALLBACK_PATH) return page(404, "Not found.")
      if (request.method !== "GET") return page(405, "Method not allowed.")
      if (attempt.phase !== "pending") return page(400, "This sign-in attempt is no longer active.")
      const states = url.searchParams.getAll("state")
      if (states.length !== 1 || !same(states[0] ?? "", state)) return page(400, "Invalid sign-in callback.")
      if (url.searchParams.has("error")) {
        // A declined new registration may still name the client it created: a consent retry reuses it.
        const named = url.searchParams.get("client_id") ?? undefined
        if (!attempt.clientId && ChatgptSharing.isClientId(named)) attempt.clientId = named
        this.#fail(attempt, "authorization_denied")
        return page(400, "Sign-in was not completed. You can close this window.")
      }
      const codes = url.searchParams.getAll("code")
      const code = codes.length === 1 ? codes[0] : undefined
      if (!code) return page(400, "Invalid sign-in callback.")
      if (flight.exchanging) return page(409, "This sign-in is already being completed.")
      // A reauthorization may omit `client_id`; a different one is refused without replacing the registration.
      const returned = url.searchParams.get("client_id") ?? undefined
      if (attempt.clientId && returned && returned !== attempt.clientId) return this.#refuse(attempt, "client_mismatch")
      const clientId = attempt.clientId ?? returned
      if (!clientId || clientId === ChatgptSharing.REGISTRATION_CLIENT_ID)
        return this.#refuse(attempt, "client_id_missing")
      if (!ChatgptSharing.isClientId(clientId)) return this.#refuse(attempt, "client_id_invalid")
      attempt.clientId = clientId
      flight.exchanging = true
      const exchanged = await ChatgptSharing.exchange(this.#client(attempt), {
        code,
        clientId,
        redirect: redirect(port),
        verifier: pkce.verifier,
        nonce,
      })
      if (!exchanged.ok && exchanged.transient && attempt.phase === "pending") {
        // The code may still be unused: reloading this page retries with the same issued client.
        flight.exchanging = false
        this.#log.warn("chatgpt_sharing_exchange_retryable", { attemptID: attempt.id, reason: exchanged.reason })
        return page(503, "ChatGPT could not be reached. Reload this page to try again.")
      }
      if (!exchanged.ok) return this.#refuse(attempt, exchanged.reason)
      if (!this.#authorize(attempt, exchanged.tokens, exchanged.identity))
        return page(400, "Sign-in failed. You can close this window.")
      return page(200, "Signed in with ChatGPT. You can close this window and return to own-open-code.")
    }
    const failed = this.#crashed(attempt, "Sign-in failed. You can close this window and try again in own-open-code.")
    const server = listen(ChatgptSharing.CALLBACK_HOST, ChatgptSharing.CALLBACK_PORTS, failed, callback)
    if (!server) return { ok: false, reason: "callback_ports_in_use" }
    // Graceful stop, so the page of the request that ends the attempt is still delivered.
    attempt.cleanups.push(() => void server.stop())
    const expiresAt = this.#deps.clock.now() + BROWSER_TTL_MS
    this.#expireAt(attempt, expiresAt)
    return {
      ok: true,
      start: {
        attemptID: attempt.id,
        method: "siwc",
        authorizeURL: ChatgptSharing.authorizeURL(issuer, {
          redirect: redirect(server.port),
          pkce,
          state,
          nonce,
          hostId,
          clientId: attempt.clientId,
          consent,
        }),
        expiresAt,
      },
    }
  }

  /**
   * The answer to a callback that threw (an exchange or the account guard failing unexpectedly): the attempt fails and
   * ends any token family it holds, instead of staying pending with its exchange marked in flight until it expires.
   */
  #crashed(attempt: Attempt, message: string) {
    return (error: unknown) => {
      this.#fail(attempt, "callback_failed", error)
      return page(500, message)
    }
  }

  /** Fails a Sign in with ChatGPT attempt from its callback and answers the browser. */
  #refuse(attempt: Attempt, reason: string) {
    this.#fail(attempt, reason)
    return page(400, "Sign-in failed. You can close this window and try again in own-open-code.")
  }

  /**
   * This machine's `ext_agent_host_id`, created once and reused for every sign-in (02 §3.2c). `undefined` when the
   * KV store cannot be used: a sign-in must never send a host id it did not persist, and a failed read must never
   * replace the persisted one.
   */
  async #hostId() {
    const storage = this.#deps.ctx.storage
    const unavailable = (error: unknown) => {
      this.#log.warn("chatgpt_host_id_unavailable", { error })
      return undefined
    }
    const stored = await storage.get(Kv.chatgptAgentHost).then((value) => ({ value }), unavailable)
    if (!stored) return undefined
    if (ChatgptSharing.isHostId(stored.value)) return stored.value
    const created = ChatgptSharing.newHostId()
    return storage.set(Kv.chatgptAgentHost, created).then(() => created, unavailable)
  }

  /**
   * The client ChatGPT issued to a finished new-account sign-in, for its retry (02 §3.2c): reusing it keeps a consent
   * retry or another try after a failure from registering a second client. Never a re-login's client: that one belongs
   * to its account.
   */
  #issuedTo(attemptID: string | undefined) {
    const previous = attemptID === undefined ? undefined : this.#attempts.get(attemptID)
    if (!previous || previous.kind !== "siwc" || previous.target !== undefined) return undefined
    return previous.phase === "failed" || previous.phase === "cancelled" ? previous.clientId : undefined
  }

  /** The issued client id of a `siwc` account: its vault item, else its cache domain (both written at sign-in). */
  async #savedClientId(account: Account.Info) {
    const inspected = await this.#deps.runtime.credentials.inspect(account)
    if (ChatgptSharing.isClientId(inspected.clientId)) return inspected.clientId
    const domain = this.#peers().slots.snapshot().cacheDomains[account.cacheDomain]
    return domain?.scope === "chatgpt_sharing" && ChatgptSharing.isClientId(domain.externalId)
      ? domain.externalId
      : undefined
  }

  /** Moves a pending attempt to `authorized`; `false` when it is no longer pending or the guard refused it. */
  #authorize(attempt: Attempt, tokens: ChatgptOAuth.Tokens, identity: Account.Identity) {
    // The attempt was cancelled or expired while its tokens were on the way.
    if (attempt.phase !== "pending") {
      this.#revoke(attempt, tokens)
      return false
    }
    // Held from here on, so a refusal below ends their token family with the attempt (`#finish`).
    attempt.tokens = tokens
    // A Codex login is keyed by its ChatGPT account id; a token-sharing login by its verified `sub` and client.
    if (attempt.kind === "codex" ? !identity.chatgptAccountId : !identity.fingerprint)
      return this.#fail(attempt, "identity_missing")
    const slots = this.#peers().slots
    const target = attempt.target === undefined ? undefined : slots.account(attempt.target)
    if (attempt.target !== undefined && !target) return this.#fail(attempt, "account_not_found")
    // Account guard (02 §3.1 C5): a re-login must be the same user, on an account of the login's kind.
    if (target && (target.kind !== attempt.kind || !sameLogin(target.identity, identity)))
      return this.#fail(attempt, "account_mismatch")
    this.#stopPhase(attempt)
    attempt.phase = "authorized"
    attempt.identity = identity
    attempt.duplicateOf = target ? undefined : duplicateOf(slots.snapshot().accounts, identity, attempt.kind)
    this.#expireAt(attempt, this.#deps.clock.now() + AUTHORIZED_TTL_MS)
    this.#event(attempt, { phase: "authorized", accountID: attempt.target ?? attempt.duplicateOf ?? null })
    return true
  }

  #fail(attempt: Attempt, reason: string, error?: unknown) {
    if (attempt.completed || (attempt.phase !== "pending" && attempt.phase !== "authorized")) return false
    this.#log.warn("chatgpt_login_failed", { attemptID: attempt.id, reason, ...(error === undefined ? {} : { error }) })
    attempt.error = reason
    this.#finish(attempt, "failed")
    this.#event(attempt, { phase: "failed", reason })
    return false
  }

  #finish(attempt: Attempt, phase: "failed" | "cancelled") {
    this.#stopPhase(attempt)
    attempt.phase = phase
    if (attempt.tokens && !attempt.storing) this.#revoke(attempt, attempt.tokens)
    attempt.tokens = undefined
    this.#retire(attempt)
  }

  /**
   * Ends the family of Sign in with ChatGPT tokens that nothing will store, best effort and in the background (02
   * §3.2c): otherwise a renewable session would stay alive at the issuer that no one holds or can end.
   */
  #revoke(attempt: Attempt, tokens: ChatgptOAuth.Tokens) {
    const clientId = tokens.clientId
    if (attempt.kind !== "siwc" || !ChatgptSharing.isClientId(clientId)) return
    // Not the attempt's client: its signal is aborted once the attempt ends, and the revocation must outlive it.
    const client = { issuer: this.#deps.endpoints.url.oauthIssuer, now: this.#deps.clock.now }
    const token = tokens.secret(this.#deps.clock.now()).refresh
    void ChatgptSharing.revoke(client, { token, clientId }).then((revoked) =>
      revoked
        ? this.#log.info("chatgpt_sharing_attempt_revoked", { attemptID: attempt.id })
        : this.#log.warn("chatgpt_sharing_revoke_unconfirmed", { attemptID: attempt.id }),
    )
  }

  #expireAt(attempt: Attempt, at: number) {
    attempt.cleanups.push(this.#deps.clock.schedule(at - this.#deps.clock.now(), () => this.#fail(attempt, "expired")))
  }

  /** Forgets a finished attempt after {@link KEEP_MS}. */
  #retire(attempt: Attempt) {
    const cancel = this.#deps.clock.schedule(KEEP_MS, () => {
      this.#sweeps.delete(cancel)
      if (this.#attempts.get(attempt.id) === attempt) this.#attempts.delete(attempt.id)
    })
    this.#sweeps.add(cancel)
  }

  /** Stops polling, timers and the callback server of the current phase and aborts in-flight requests. */
  #stopPhase(attempt: Attempt) {
    for (const cleanup of attempt.cleanups.splice(0)) cleanup()
    if (attempt.phase === "pending") attempt.abort.abort()
  }

  #client(attempt: Attempt): ChatgptOAuth.Client {
    return { issuer: this.#deps.endpoints.url.oauthIssuer, now: this.#deps.clock.now, signal: attempt.abort.signal }
  }

  #event(
    attempt: Attempt,
    body: { readonly phase: string; readonly accountID?: Account.ID | null; readonly reason?: string },
  ) {
    void this.#deps.emitter.global("account.status", {
      accountID: body.accountID ?? attempt.target ?? null,
      attemptID: attempt.id,
      phase: body.phase,
      reason: body.reason,
    })
  }
}

/** The account guard of 02 §3.1 C5: same fingerprint, or the same ChatGPT account id when none was recorded. */
export function sameLogin(stored: Account.Identity, next: Account.Identity) {
  if (stored.fingerprint !== undefined) return stored.fingerprint === next.fingerprint
  return stored.chatgptAccountId !== undefined && stored.chatgptAccountId === next.chatgptAccountId
}

/** `base` updated with the defined fields of `next`; claims a token does not carry keep their recorded value. */
export function mergeIdentity(base: Account.Identity, next: Account.Identity): Account.Identity {
  return { ...base, ...Object.fromEntries(Object.entries(next).filter((entry) => entry[1] !== undefined)) }
}

/**
 * A live account of `kind` with the same guard fingerprint (duplicate logins re-authenticate, 02 §3.2 step 3). Never
 * across kinds: a token-sharing login must not replace a Codex login's tokens, or the reverse.
 */
export function duplicateOf(accounts: ReadonlyArray<Account.Info>, identity: Account.Identity, kind: Kind.OAuth) {
  if (identity.fingerprint === undefined) return undefined
  return accounts.find(
    (account) =>
      account.kind === kind && account.status !== "retired" && account.identity.fingerprint === identity.fingerprint,
  )?.id
}

type Handler = (request: Request, port: number | undefined) => Promise<Response>

/** A callback server on the first free port; `failed` answers a request whose handler threw. */
function listen(
  hostname: string,
  ports: ReadonlyArray<number>,
  failed: (error: unknown) => Response,
  handler: Handler,
): Server<undefined> | undefined {
  const [port, ...rest] = ports
  if (port === undefined) return undefined
  const guarded: Handler = (request, at) => handler(request, at).catch(failed)
  return bind(hostname, port, guarded) ?? listen(hostname, rest, failed, handler)
}

function bind(hostname: string, port: number, handler: Handler) {
  const holder: { server?: Server<undefined> } = {}
  // Bun.serve throws synchronously when the port is taken (EADDRINUSE); the caller then tries the next port.
  try {
    holder.server = Bun.serve({
      hostname,
      port,
      fetch: (request) => handler(request, holder.server?.port),
    })
    return holder.server
  } catch {
    return undefined
  }
}

/** Constant-time comparison of the callback `state` with the attempt's. */
function same(received: string, expected: string) {
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

// Callback pages carry the authorization code in their URL: never cached, never sent on as a referrer, no scripts.
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
}

function page(status: number, message: string) {
  const html = `<!doctype html><meta charset="utf-8"><title>own-open-code</title><p>${message}</p>`
  return new Response(html, { status, headers: PAGE_HEADERS })
}
