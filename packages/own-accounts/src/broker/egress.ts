export * as Egress from "./egress.js"

import { createHmac } from "node:crypto"
import { Option, Schema } from "effect"
import { Broker, Unified, type Account, type Limit, type Plugin } from "@own/protocol"
import type { GitHubRelay } from "../github/relay.js"
import type { Logger } from "../logger.js"
import type { ClaudeWire } from "./claude-wire.js"
import { Wire } from "./wire.js"

/**
 * The PC egress relay of the Claude subscription slot (04 §8.11.4.5): one loopback HTTP/1.1 listener per SSH host
 * (`127.0.0.1:E_h`, reached through the host tunnel's second `-R`), one request per connection. A request goes upstream
 * only after these checks, in order, each refusing with a fixed code (`x-own-egress-error`) and no upstream call:
 *
 * 1. `POST /v1/messages`, query empty or exactly `beta=true` (404/405/400 `bad_request`). Host header and absolute
 *    URLs are never read: the upstream origin is a constant.
 * 2. The per-request proof v2 `x-own-egress: v2.<epoch>.<n>.<accountID>.<mac>` (D3; 2026-10-10): the host's current
 *    epoch, a counter not seen in the replay window, the HMAC (covering the Claude account) compared in constant time
 *    (401 `mac`). Failures count in an egress-only bucket per host; past {@link Broker.EGRESS_MAC_FAILURES_PER_MINUTE} a
 *    minute, new requests are answered at once without being read.
 * 3. Rate (10/s, burst 30: 429 `rate_limited`) and concurrency (16: 429 `busy`) per host.
 * 4. The PC's verdict `enabled` (else 403 `<state>`) and no `needs_reauth` hold (403); the proof's Claude account is one
 *    of this PC's accounts the host's account scope allows (else 403 `host_scope`). The request is signed with that
 *    account and no other, never a default (02 §8.7, G5); another account than the slot's own needs the patched plugin
 *    (else 403 `not_ready`).
 * 5. Body ≤ 32 MiB (413 `too_large`), uploaded within 120 s (408 `bad_request`).
 * 6. A JSON object whose `system` is text blocks (a string becomes one block, absent becomes `[]`), else 400.
 * 7. The wire of this PC's claude-auth instance (403 `not_ready`).
 *
 * Then the plugin's own local hook, replayed: `injectClaudeIdentity` on the body's `system`, `prepareClaudeRequest`
 * with no token and the proof's account (the plugin picks that account's token; the conversation is the host's
 * `x-opencode-session-id`), one plain `fetch`, and `finishClaudeResponse` for that account (D2: after a first 401 one
 * recovery at a time for the whole PC; a final 401 holds the host `needs_reauth` for 60 s). The answer streams back as
 * it arrives (pull-based, so a slow host slows the upstream read), its unified limit headers become this PC's limit
 * windows (`origin = hostId`), and a host that goes away aborts the upstream request.
 *
 * Never logged or audited: header values, bodies, proofs, counters. Audit lines are 5-minute sums per host
 * (`remote.egress.claude`).
 *
 * 16 §8 (GH-37): the same listener relays the host's git and git-lfs to GitHub under `/github/<site host>/…`, with its
 * own proof (`x-own-github`, the arm's counter and replay window) over the method, the path and the place header, the
 * same failure bucket, rate and concurrency bounds (its requests in flight counted apart, so the Claude verdict never
 * aborts them), and `GitHubRelay.gate`, which names the account's login and the upstream; a git login goes upstream only
 * from here (Basic), never to the host. Pack streams flow both ways as they arrive (a clone or a push may be large); a
 * Git LFS batch body is read first (at most 1 MiB) to tell a download from an upload, and goes upstream as read and
 * written again (GH-46). GitHub's answer goes back only without the login (GH-45): no header may carry it, and Git
 * LFS's API answers and every answer of status 300 or more are read whole first (at most 1 MiB), an LFS action's
 * `Authorization` that is the login itself is dropped, and an answer still carrying the token or the login in any form
 * is refused (502 `leak`). GitHub's 401 goes back as 403, so the host's git never prompts for a password.
 *
 * 04 §8.14 (SLM): the same listener relays the host's requests of this PC's local models under
 * `/local/<accountID><path>`, with their own proof (`x-own-local`, the arm's counter and replay window) over the
 * account, the method, the path and the query, the same failure bucket and rate, and their own requests in flight
 * (16, counted apart like git's). `HostAccess.local` names the account's server on this PC (its base URL, never one
 * the host sends) and the key headers it needs (none for a keyless one); the path must be under the base URL's path.
 * The request goes there as it came (body and headers, but the host's credentials, cookies, hop-by-hop headers and
 * own's proof), so the server sees the bytes a conversation of this PC sends; the answer streams back as it arrives,
 * and a host that goes away aborts it. Refusals carry `x-own-local-error` and a Korean line for the error card.
 */

export const UPSTREAM = "https://api.anthropic.com"

/** Request headers passed upstream: what core sends on a local request too (`model-request.ts`). */
const FORWARDED = ["content-type", "accept", "anthropic-version", "anthropic-beta"]
const FORWARDED_PREFIX = ["x-opencode-", "x-session-"]
const FORWARDED_EXACT = ["x-parent-session-id"]

/** Response headers never passed back to the host. */
const DROPPED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "set-cookie",
])

/** Audit lines sum this long per host (04 §8.9's window). */
export const AUDIT_WINDOW_MS = Broker.AUDIT_WINDOW_MS

export interface HostAccess {
  /** The host's current epoch key (`setKey`), or none before the first. */
  readonly key: () => { readonly epoch: number; readonly key: Uint8Array } | undefined
  /** The PC's verdict for this host now (04 §8.11.4.3). */
  readonly state: () => Plugin.ClaudeRemoteState
  /**
   * The Claude account a proof names, as this host may use it now: its key in the patched plugin (`key: undefined` =
   * the slot's own account, which an unpatched plugin signs with too), or `undefined` = refused (not one of this PC's
   * accounts, or outside the host's account scope).
   */
  readonly account: (accountID: string) => { readonly key: string | undefined } | undefined
  /** 04 §8.14: the local model a proof names, as this host may use it now (its server and key headers), or why not. */
  readonly local: (accountID: string) => Promise<LocalGate>
}

/**
 * A local model request's way on this PC: the account's server (`origin` and the base URL's path `basePath`, no
 * trailing `/`) and the headers its key needs (none for a keyless account), or the refusal.
 */
export type LocalGate =
  | {
      readonly ok: true
      readonly origin: string
      readonly basePath: string
      readonly headers: Readonly<Record<string, string>>
    }
  | { readonly ok: false; readonly status: number; readonly code: Broker.LocalError }

export interface Backend {
  readonly now: () => number
  readonly log: Logger.Logger
  /** {@link UPSTREAM}; tests only: a loopback fake (`options.broker.claudeUpstream`). */
  readonly upstream: string
  readonly wire: () => Promise<ClaudeWire.Loaded>
  /**
   * Windows the relay observed (`origin = hostId`): this PC's limit store and `limits.updated`. `dropped`: windows the
   * response says the account no longer has (a verified Ultra account's `claude.5h`, 02 §7.1.2).
   */
  readonly limits: (
    windows: ReadonlyArray<Limit.Window>,
    dropped?: ReadonlyArray<Pick<Limit.Window, "accountID" | "id">>,
  ) => void
  /** An events-ledger line `remote.egress.claude` or `remote.egress.local` (5-minute sums). */
  readonly audit: (data: Record<string, unknown>, kind: "claude" | "local") => Promise<void>
  /** A host's relay refused a request or started a hold (requests in flight are read on demand, `status`). */
  readonly changed: (hostId: string) => void
  /** 16 §8: whether a host's git request goes to GitHub and with which login; none = no git relay (404). */
  readonly github?: (hostId: string, ask: GitHubRelay.Ask) => Promise<GitHubRelay.Gate>
}

/** Test seams; production uses the protocol bounds. */
export interface Options {
  readonly idleTimeoutSeconds?: number
  readonly uploadTimeoutMs?: number
}

export interface Status {
  readonly inflight: number
  readonly lastError: Broker.EgressError | null
  readonly holdUntil: number | null
  /** 04 §8.14: relayed local model requests in flight, and the last refusal of one. */
  readonly local: { readonly inflight: number; readonly lastError: Broker.LocalError | null }
}

interface Audit {
  readonly firstAt: number
  count: number
  bytesIn: number
  bytesOut: number
  readonly statuses: Record<string, number>
  readonly refusals: Record<string, number>
}

interface Host {
  readonly id: string
  readonly access: HostAccess
  server: ReturnType<typeof Bun.serve> | undefined
  /** Counters seen in the current epoch (D3): the highest, and the ones within the window below it. */
  replay: { epoch: number; highest: number; readonly seen: Set<number> }
  failures: number[]
  tokens: number
  refilledAt: number
  readonly inflight: Set<AbortController>
  /** Relayed git requests in flight (16 §8): apart from Claude's, which a verdict change aborts. */
  readonly git: Set<AbortController>
  /** Relayed local model requests in flight (04 §8.14), apart like git's. */
  readonly local: Set<AbortController>
  holdUntil: number
  lastError: Broker.EgressError | null
  localError: Broker.LocalError | null
  audit: Audit | undefined
  localAudit: Audit | undefined
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * D2: the PC runs one first-401 recovery at a time, whatever the host, so parallel requests never rotate the refresh
 * token the plugin shares with Claude Code more than once (`forceRefreshActiveAccount` has no lock of its own).
 */
const recovery = { chain: Promise.resolve() as Promise<unknown> }

function serialized<A>(run: () => Promise<A>) {
  const next = recovery.chain.then(run)
  recovery.chain = next.catch(() => undefined)
  return next
}

export class Relay {
  readonly #backend: Backend
  readonly #options: Options
  readonly #hosts = new Map<string, Host>()

  constructor(backend: Backend, options: Options = {}) {
    this.#backend = backend
    this.#options = options
  }

  /** Opens the host's listener if needed; its port, or `undefined` when it cannot listen (Claude stays off there). */
  async listen(hostId: string, access: HostAccess) {
    const host = this.#hosts.get(hostId) ?? this.#create(hostId, access)
    if (host.server) return host.server.port
    try {
      host.server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: this.#options.idleTimeoutSeconds ?? 30,
        fetch: (request, server) => this.#handle(host, request, server),
        error: () => refusal(502, "upstream_unreachable"),
      })
    } catch (error) {
      this.#backend.log.warn("egress_listen_failed", { hostId, error })
      return undefined
    }
    this.#backend.log.info("egress_listening", { hostId, port: host.server.port })
    return host.server.port
  }

  /** A new epoch key: the replay window starts over (`setKey`). */
  reset(hostId: string) {
    const host = this.#hosts.get(hostId)
    if (host) host.replay = { epoch: -1, highest: 0, seen: new Set() }
  }

  /** The host left `enabled` (switched off, consent gone, …): every relayed request in flight ends. */
  abort(hostId: string) {
    const host = this.#hosts.get(hostId)
    if (!host || host.inflight.size === 0) return
    for (const controller of [...host.inflight]) controller.abort()
    this.#backend.log.info("egress_aborted", { hostId })
  }

  status(hostId: string): Status | undefined {
    const host = this.#hosts.get(hostId)
    if (!host) return undefined
    return {
      inflight: host.inflight.size,
      lastError: host.lastError,
      holdUntil: host.holdUntil > this.#backend.now() ? host.holdUntil : null,
      local: { inflight: host.local.size, lastError: host.localError },
    }
  }

  async close(hostId: string) {
    const host = this.#hosts.get(hostId)
    if (!host) return
    this.#hosts.delete(hostId)
    for (const controller of [...host.inflight, ...host.git, ...host.local]) controller.abort()
    await this.#flush(host, true)
    const server = host.server
    host.server = undefined
    await server?.stop(true)
  }

  /** Writes the audit sums whose window ended (the broker's minute sweep). */
  async sweep() {
    for (const host of this.#hosts.values()) await this.#flush(host, false)
  }

  async shutdown() {
    await Promise.allSettled([...this.#hosts.keys()].map((hostId) => this.close(hostId)))
  }

  #create(hostId: string, access: HostAccess): Host {
    const host: Host = {
      id: hostId,
      access,
      server: undefined,
      replay: { epoch: -1, highest: 0, seen: new Set() },
      failures: [],
      tokens: Broker.EGRESS_RATE_BURST,
      refilledAt: this.#backend.now(),
      inflight: new Set(),
      git: new Set(),
      local: new Set(),
      holdUntil: 0,
      lastError: null,
      localError: null,
      audit: undefined,
      localAudit: undefined,
    }
    this.#hosts.set(hostId, host)
    return host
  }

  async #handle(host: Host, request: Request, server: { timeout(request: Request, seconds: number): void }) {
    const now = this.#backend.now()
    host.failures = host.failures.filter((at) => now - at < 60_000)
    // Past the failure bucket nothing of the request is read or checked this minute.
    if (host.failures.length >= Broker.EGRESS_MAC_FAILURES_PER_MINUTE) return refusal(401, "mac")
    const url = new URL(request.url)
    if (url.pathname.startsWith("/github/")) return this.#github(host, request, url, server, now)
    if (url.pathname.startsWith(Broker.LOCAL_PATH_PREFIX)) return this.#local(host, request, url, server, now)
    if (url.pathname !== "/v1/messages") return this.#refuse(host, 404, "bad_request")
    if (request.method !== "POST") return this.#refuse(host, 405, "bad_request")
    if (url.search !== "" && url.search !== "?beta=true") return this.#refuse(host, 400, "bad_request")
    const proof = this.#proof(host, request.headers.get(Broker.EGRESS_HEADER))
    if (!proof) {
      host.failures.push(now)
      return this.#refuse(host, 401, "mac")
    }
    if (!this.#take(host, now)) return this.#refuse(host, 429, "rate_limited")
    if (host.inflight.size >= Broker.EGRESS_MAX_INFLIGHT) return this.#refuse(host, 429, "busy")
    const state = host.access.state()
    if (state !== "enabled") return this.#refuse(host, 403, state)
    if (now < host.holdUntil) return this.#refuse(host, 403, "needs_reauth")
    const account = host.access.account(proof.accountID)
    if (!account) return this.#refuse(host, 403, "host_scope")
    if (Number(request.headers.get("content-length") ?? 0) > Broker.EGRESS_MAX_BODY_BYTES)
      return this.#refuse(host, 413, "too_large")

    const controller = new AbortController()
    host.inflight.add(controller)
    request.signal.addEventListener("abort", () => controller.abort(), { once: true })
    const done = { value: false }
    const release = (bytesOut: number) => {
      if (done.value) return
      done.value = true
      host.inflight.delete(controller)
      this.#audit(host).bytesOut += bytesOut
    }
    const signer = { accountID: proof.accountID, key: account.key }
    const response = await this.#relay(host, request, url.search, controller, server, signer).catch(
      (error: unknown) => {
        if (!controller.signal.aborted) this.#backend.log.warn("egress_failed", { hostId: host.id, error })
        return refusal(502, "upstream_unreachable")
      },
    )
    if (!response.body || response.headers.has(Broker.EGRESS_ERROR_HEADER)) {
      release(0)
      return response
    }
    return new Response(track(response.body, controller, release), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  async #relay(
    host: Host,
    request: Request,
    search: string,
    controller: AbortController,
    server: { timeout(request: Request, seconds: number): void },
    signer: { readonly accountID: string; readonly key: string | undefined },
  ): Promise<Response> {
    const body = await read(request, this.#options.uploadTimeoutMs ?? Broker.EGRESS_UPLOAD_TIMEOUT_MS)
    if (body === "too_large") return this.#refuse(host, 413, "too_large")
    if (body === "timeout") return this.#refuse(host, 408, "bad_request")
    this.#audit(host).bytesIn += body.byteLength
    const json = Option.getOrUndefined(decodeJson(new TextDecoder().decode(body)))
    const parsed = json === undefined ? undefined : normalize(json)
    if (!parsed) return this.#refuse(host, 400, "bad_request")
    const loaded = await this.#backend.wire()
    if (!loaded.ok) {
      this.#backend.log.warn("egress_not_ready", { hostId: host.id, detail: loaded.detail })
      return this.#refuse(host, 403, "not_ready")
    }
    // Another account than the slot's own needs the patched plugin, which signs with the named account only.
    if (signer.key !== undefined && !loaded.multi) return this.#refuse(host, 403, "not_ready")
    // The checks are done: the upstream may be silent for minutes (core's own 300 s limits bound the host side).
    server.timeout(request, 0)
    loaded.wire.injectClaudeIdentity({ model: { providerID: "anthropic" }, system: parsed.system })
    const outgoing = new Request(`${this.#backend.upstream}/v1/messages${search}`, {
      method: "POST",
      headers: forwarded(request.headers),
      body: JSON.stringify(parsed.body),
      signal: controller.signal,
    })
    const conversationID = request.headers.get("x-opencode-session-id") ?? undefined
    const prepared = await loaded.wire
      .prepareClaudeRequest(outgoing, undefined, signer.key, { conversationID })
      .catch((error: unknown) => {
        this.#backend.log.warn("egress_not_ready", { hostId: host.id, detail: "credentials", error })
        return undefined
      })
    if (!prepared) return this.#refuse(host, 403, "not_ready")
    // A copy goes out first: the plugin reads `prepared` again (its body and headers) while finishing.
    const initial = await send(prepared.clone())
    const final =
      initial.status === 401
        ? await serialized(async () => {
            // Another request's recovery failed meanwhile: do not try again for this one (D2).
            if (this.#backend.now() < host.holdUntil) return undefined
            return loaded.wire.finishClaudeResponse(prepared, initial, signer.key, send)
          })
        : await loaded.wire.finishClaudeResponse(prepared, initial, signer.key, send)
    if (!final) {
      await initial.body?.cancel().catch(() => undefined)
      return this.#refuse(host, 403, "needs_reauth")
    }
    const now = this.#backend.now()
    if (final.status === 401) {
      host.holdUntil = now + Broker.EGRESS_REAUTH_HOLD_MS
      host.lastError = "needs_reauth"
      this.#backend.log.warn("egress_reauth_hold", { hostId: host.id, untilMs: Broker.EGRESS_REAUTH_HOLD_MS })
      this.#backend.changed(host.id)
    }
    const windows = Unified.parse(final.headers, now, final.ok ? "header" : "error", signer.accountID as Account.ID)
    const gone = Unified.withoutFiveHour(final.headers, final.status)
      ? [{ accountID: signer.accountID as Account.ID, id: Unified.FIVE_HOUR }]
      : []
    if (windows.length > 0 || gone.length > 0)
      this.#backend.limits(
        windows.map((window) => ({ ...window, origin: host.id })),
        gone,
      )
    const statuses = this.#audit(host).statuses
    statuses[String(final.status)] = (statuses[String(final.status)] ?? 0) + 1
    this.#audit(host).count++
    const headers = new Headers()
    final.headers.forEach((value, name) => {
      if (!DROPPED.has(name.toLowerCase())) headers.set(name, value)
    })
    headers.set("connection", "close")
    headers.set(Broker.EGRESS_HEADER, "1")
    return new Response(final.body, { status: final.status, statusText: final.statusText, headers })
  }

  /**
   * The proof of step 2 (D3, v2): epoch, a fresh counter, the Claude account, the MAC over all of them; the counter is
   * recorded only for a valid proof. Answers the proof, or `undefined`.
   */
  #proof(host: Host, value: string | null) {
    const proof = Broker.parseEgressHeader(value)
    if (!proof) return undefined
    const fresh = this.#fresh(host, proof, (key) =>
      Broker.egressMacInput({ hostId: host.id, epoch: key.epoch, n: proof.n, accountID: proof.accountID }),
    )
    return fresh ? proof : undefined
  }

  /** A git request's proof (16 §8): the same epoch, counter and replay window, a MAC over its method, path and place. */
  #githubProof(
    host: Host,
    value: string | null,
    input: { readonly method: string; readonly path: string; readonly place: string },
  ) {
    const proof = Broker.parseGitHubHeader(value)
    if (!proof) return undefined
    const fresh = this.#fresh(host, proof, (key) =>
      Broker.githubMacInput({ hostId: host.id, epoch: key.epoch, n: proof.n, ...input }),
    )
    return fresh ? proof : undefined
  }

  /**
   * Whether a proof is of the current epoch, its counter not seen in the window and its MAC right (constant time); the
   * counter is recorded only then.
   */
  #fresh(
    host: Host,
    proof: { readonly epoch: number; readonly n: number; readonly mac: string },
    macInput: (key: { readonly epoch: number }) => string,
  ) {
    const key = host.access.key()
    if (!key || proof.epoch !== key.epoch) return false
    if (host.replay.epoch !== key.epoch) host.replay = { epoch: key.epoch, highest: 0, seen: new Set() }
    const replay = host.replay
    if (proof.n <= replay.highest - Broker.EGRESS_REPLAY_WINDOW || replay.seen.has(proof.n)) return false
    const expected = createHmac("sha256", key.key).update(macInput(key)).digest("hex")
    if (!Wire.equal(proof.mac, expected)) return false
    replay.seen.add(proof.n)
    if (proof.n > replay.highest) {
      replay.highest = proof.n
      for (const n of replay.seen) if (n <= replay.highest - Broker.EGRESS_REPLAY_WINDOW) replay.seen.delete(n)
    }
    return true
  }

  /**
   * A git or git-lfs request of the host (16 §8): its proof, the place it names, the bounds, the gate's decision, then
   * the request upstream with the account's login and the answer back as it arrives. Refusals name a fixed code only.
   */
  async #github(
    host: Host,
    request: Request,
    url: URL,
    server: { timeout(request: Request, seconds: number): void },
    now: number,
  ) {
    const gate = this.#backend.github
    if (!gate) return gitRefusal(404, "bad_request")
    const path = url.pathname.slice("/github".length)
    const placeText = request.headers.get(Broker.GITHUB_PLACE_HEADER) ?? ""
    const proof = this.#githubProof(host, request.headers.get(Broker.GITHUB_HEADER), {
      method: request.method,
      path: `${path}${url.search}`,
      place: placeText,
    })
    if (!proof) {
      host.failures.push(now)
      return gitRefusal(401, "mac")
    }
    const place = Option.getOrUndefined(decodePlace(Buffer.from(placeText, "base64url").toString("utf8")))
    if (!place) return gitRefusal(400, "bad_request")
    if (!this.#take(host, now)) return gitRefusal(429, "rate_limited")
    if (host.git.size >= Broker.EGRESS_MAX_INFLIGHT) return gitRefusal(429, "busy")
    // A Git LFS batch says in its body whether it downloads or uploads: read it first (a small JSON). What goes
    // upstream is the batch as read here, so GitHub cannot read another `operation` than the one judged (GH-46).
    const lfs = path.endsWith("/info/lfs/objects/batch")
      ? await readLimited(
          request,
          Broker.GITHUB_LFS_MAX_BODY_BYTES,
          this.#options.uploadTimeoutMs ?? Broker.EGRESS_UPLOAD_TIMEOUT_MS,
        )
      : undefined
    if (lfs === "too_large" || lfs === "timeout") return gitRefusal(400, "bad_request")
    const batch = lfs === undefined ? undefined : lfsBatch(lfs)
    if (lfs !== undefined && !batch) return gitRefusal(400, "bad_request")
    const decision = await gate(host.id, {
      method: request.method,
      path,
      search: url.search,
      place,
      ...(batch?.operation === undefined ? {} : { lfs: batch.operation }),
    }).catch((error: unknown): GitHubRelay.Gate => {
      this.#backend.log.warn("github_gate_failed", { hostId: host.id, error })
      return { ok: false, status: 503, code: "unavailable" }
    })
    if (!decision.ok) return gitRefusal(decision.status, decision.code)
    const controller = new AbortController()
    host.git.add(controller)
    request.signal.addEventListener("abort", () => controller.abort(), { once: true })
    const release = () => void host.git.delete(controller)
    // A clone or a push may stream for long: the checks are done.
    server.timeout(request, 0)
    const headers = gitForwarded(request.headers)
    headers.set("authorization", decision.authorization)
    const body = batch?.body ?? (request.method === "GET" || request.method === "HEAD" ? undefined : request.body)
    // SAFETY: `duplex` is required by fetch for a streamed body; the DOM `RequestInit` type does not list it.
    const init = { method: request.method, headers, body, redirect: "manual", signal: controller.signal, duplex: "half" } as RequestInit
    const upstream = await send(decision.upstream, init).catch((error: unknown) => {
      if (!controller.signal.aborted) this.#backend.log.warn("github_relay_failed", { hostId: host.id, error })
      return undefined
    })
    if (!upstream) {
      release()
      return gitRefusal(502, "unavailable")
    }
    const out = new Headers()
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (!DROPPED.has(lower) && lower !== "www-authenticate") out.set(name, value)
    })
    out.set("connection", "close")
    // GitHub refusing the login: 403, so the host's git does not prompt for a password it cannot be given.
    const status = upstream.status === 401 ? 403 : upstream.status
    if (upstream.status === 401) out.set(Broker.GITHUB_ERROR_HEADER, "problem")
    /** GitHub's answer does not go to the host: aborted upstream, logged by reason only. */
    const refuse = (code: "leak" | "unchecked", where: string) => {
      controller.abort()
      release()
      this.#backend.log.warn("github_answer_refused", { hostId: host.id, code, where, status: upstream.status })
      return gitRefusal(502, code)
    }
    // No header (a redirect's `Location` too) may carry the login back (GH-45).
    const headerText = [...out.entries()].map(([name, value]) => `${name}: ${value}`).join("\n")
    if (carries(headerText, decision.secrets)) return refuse("leak", "header")
    // Pack streams pass as they arrive. Git LFS's API answers (small JSON) and anything but a success are read whole
    // first: an LFS action's `Authorization` that is the login itself is dropped, then the answer must not carry the
    // login in any form (GH-45).
    const checked = path.includes("/info/lfs/") || upstream.status >= 300
    if (!checked) {
      if (!upstream.body) {
        release()
        return new Response(null, { status, statusText: upstream.statusText, headers: out })
      }
      return new Response(track(upstream.body, controller, release), {
        status,
        statusText: upstream.statusText,
        headers: out,
      })
    }
    const whole = await readLimited(
      upstream,
      Broker.GITHUB_CHECKED_ANSWER_MAX_BYTES,
      this.#options.uploadTimeoutMs ?? Broker.EGRESS_UPLOAD_TIMEOUT_MS,
    )
    if (whole === "too_large" || whole === "timeout") return refuse("unchecked", whole)
    const answer = batch ? withoutLogin(whole, decision.authorization) : whole
    if (carries(Buffer.from(answer).toString("latin1"), decision.secrets)) return refuse("leak", "body")
    release()
    return new Response(answer.slice(), { status, statusText: upstream.statusText, headers: out })
  }

  /**
   * A local model request of the host (04 §8.14): its proof, the bounds, the account's gate, the path under the
   * account's base URL, then the request to the account's server on this PC and the answer back as it arrives.
   */
  async #local(
    host: Host,
    request: Request,
    url: URL,
    server: { timeout(request: Request, seconds: number): void },
    now: number,
  ) {
    const rest = url.pathname.slice(Broker.LOCAL_PATH_PREFIX.length)
    const slash = rest.indexOf("/")
    const accountID = slash < 0 ? rest : rest.slice(0, slash)
    const path = slash < 0 ? "/" : rest.slice(slash)
    const proof = this.#localProof(host, request.headers.get(Broker.LOCAL_HEADER), {
      method: request.method,
      path: `${path}${url.search}`,
    })
    if (!proof || proof.accountID !== accountID) {
      host.failures.push(now)
      return this.#refuseLocal(host, 401, "mac")
    }
    if (!this.#take(host, now)) return this.#refuseLocal(host, 429, "rate_limited")
    if (host.local.size >= Broker.EGRESS_MAX_INFLIGHT) return this.#refuseLocal(host, 429, "busy")
    if (request.method !== "POST" && request.method !== "GET") return this.#refuseLocal(host, 405, "bad_request")
    if (Number(request.headers.get("content-length") ?? 0) > Broker.EGRESS_MAX_BODY_BYTES)
      return this.#refuseLocal(host, 413, "too_large")
    const gate = await host.access.local(accountID).catch((error: unknown): LocalGate => {
      this.#backend.log.warn("local_gate_failed", { hostId: host.id, error })
      return { ok: false, status: 403, code: "needs_key" }
    })
    if (!gate.ok) return this.#refuseLocal(host, gate.status, gate.code)
    // Only the account's own server, under its base URL's path (`/v1/…`), never another place the host names.
    if (path !== gate.basePath && !path.startsWith(`${gate.basePath}/`)) return this.#refuseLocal(host, 404, "bad_request")
    const controller = new AbortController()
    host.local.add(controller)
    request.signal.addEventListener("abort", () => controller.abort(), { once: true })
    const done = { value: false }
    const release = (bytesOut: number) => {
      if (done.value) return
      done.value = true
      host.local.delete(controller)
      this.#localAudit(host).bytesOut += bytesOut
    }
    // The body whole first (core sends a buffered one too): the server gets the same `content-length` framing as from a
    // conversation of this PC, never a chunked upload some local servers refuse (SLM, real host RG9).
    const body =
      request.method === "GET"
        ? undefined
        : await read(request, this.#options.uploadTimeoutMs ?? Broker.EGRESS_UPLOAD_TIMEOUT_MS)
    if (body === "too_large" || body === "timeout") {
      release(0)
      return this.#refuseLocal(host, body === "too_large" ? 413 : 408, body === "too_large" ? "too_large" : "bad_request")
    }
    this.#localAudit(host).bytesIn += body?.byteLength ?? 0
    // A local model may think for minutes before its first byte: the checks are done.
    server.timeout(request, 0)
    const headers = localForwarded(request.headers)
    for (const [name, value] of Object.entries(gate.headers)) headers.set(name, value)
    const init: RequestInit = { method: request.method, headers, body: body?.slice(), redirect: "manual", signal: controller.signal }
    const upstream = await send(`${gate.origin}${path}${url.search}`, init).catch((error: unknown) => {
      if (!controller.signal.aborted) this.#backend.log.warn("local_relay_failed", { hostId: host.id, error })
      return undefined
    })
    if (!upstream) {
      release(0)
      return this.#refuseLocal(host, 502, "upstream_unreachable")
    }
    const audit = this.#localAudit(host)
    audit.count++
    audit.statuses[String(upstream.status)] = (audit.statuses[String(upstream.status)] ?? 0) + 1
    if (host.localError !== null) {
      host.localError = null
      this.#backend.changed(host.id)
    }
    const out = new Headers()
    upstream.headers.forEach((value, name) => {
      if (!DROPPED.has(name.toLowerCase())) out.set(name, value)
    })
    out.set("connection", "close")
    out.set(Broker.LOCAL_HEADER, "1")
    if (!upstream.body) {
      release(0)
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: out })
    }
    return new Response(track(upstream.body, controller, release), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    })
  }

  /** A local model request's proof (04 §8.14): the same epoch, counter and replay window, a MAC over its request. */
  #localProof(host: Host, value: string | null, input: { readonly method: string; readonly path: string }) {
    const proof = Broker.parseLocalHeader(value)
    if (!proof) return undefined
    const fresh = this.#fresh(host, proof, (key) =>
      Broker.localMacInput({ hostId: host.id, epoch: key.epoch, n: proof.n, accountID: proof.accountID, ...input }),
    )
    return fresh ? proof : undefined
  }

  #refuseLocal(host: Host, status: number, code: Broker.LocalError) {
    host.localError = code
    const refusals = this.#localAudit(host).refusals
    refusals[code] = (refusals[code] ?? 0) + 1
    this.#backend.changed(host.id)
    return localRefusal(status, code)
  }

  #localAudit(host: Host) {
    host.localAudit ??= { firstAt: this.#backend.now(), count: 0, bytesIn: 0, bytesOut: 0, statuses: {}, refusals: {} }
    return host.localAudit
  }

  /** Token bucket of step 3. */
  #take(host: Host, now: number) {
    host.tokens = Math.min(
      Broker.EGRESS_RATE_BURST,
      host.tokens + (Math.max(0, now - host.refilledAt) / 1000) * Broker.EGRESS_RATE_PER_SECOND,
    )
    host.refilledAt = now
    if (host.tokens < 1) return false
    host.tokens -= 1
    return true
  }

  #refuse(host: Host, status: number, code: Broker.EgressError) {
    host.lastError = code
    const refusals = this.#audit(host).refusals
    refusals[code] = (refusals[code] ?? 0) + 1
    this.#backend.changed(host.id)
    return refusal(status, code)
  }

  #audit(host: Host) {
    host.audit ??= {
      firstAt: this.#backend.now(),
      count: 0,
      bytesIn: 0,
      bytesOut: 0,
      statuses: {},
      refusals: {},
    }
    return host.audit
  }

  async #flush(host: Host, force: boolean) {
    await this.#flushOne(host, host.audit, "claude", force)
    await this.#flushOne(host, host.localAudit, "local", force)
  }

  async #flushOne(host: Host, audit: Audit | undefined, kind: "claude" | "local", force: boolean) {
    if (!audit || (!force && this.#backend.now() - audit.firstAt < AUDIT_WINDOW_MS)) return
    if (kind === "claude") host.audit = undefined
    if (kind === "local") host.localAudit = undefined
    await this.#backend
      .audit({
        hostId: host.id,
        count: audit.count,
        bytesIn: audit.bytesIn,
        bytesOut: audit.bytesOut,
        statuses: audit.statuses,
        refusals: audit.refusals,
        firstAt: audit.firstAt,
        lastAt: this.#backend.now(),
      }, kind)
      .catch((error: unknown) => this.#backend.log.warn("egress_audit_failed", { hostId: host.id, error }))
  }
}

/**
 * The relay's upstream transport, the first send and the plugin's re-sends alike: no time limit of its own (Bun's fetch
 * has one by default), only the request signal ends it (04 §8.11.7).
 */
const send: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, timeout: false }),
  { preconnect: fetch.preconnect },
)

/** Request headers of git and git-lfs passed to GitHub; never the host's own `authorization`. */
const GIT_FORWARDED = ["content-type", "accept", "git-protocol", "content-encoding", "user-agent"]

function gitForwarded(incoming: Headers) {
  const headers = new Headers()
  for (const name of GIT_FORWARDED) {
    const value = incoming.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

/** A git relay refusal: the code (`x-own-github-error`) and a line git may print, nothing of the request. */
function gitRefusal(status: number, code: Broker.GitHubGitError) {
  return new Response(`own: GitHub relay refused (${code})\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", connection: "close", [Broker.GITHUB_ERROR_HEADER]: code },
  })
}

const decodePlace = Schema.decodeUnknownOption(Schema.fromJsonString(Broker.GitHubPlace))

/**
 * A Git LFS batch as it goes upstream: its `operation` (`undefined` when it names none, then judged a push) and the
 * batch written again from what was read, so a key GitHub's parser might read and this one would not (a second
 * `operation`, an escaped name) never goes (GH-46). `undefined`, refused: not a JSON object, or more than one key that
 * is `operation` in any letter case (GitHub's parser may match names without case).
 */
function lfsBatch(body: Uint8Array) {
  const json = Option.getOrUndefined(decodeJson(new TextDecoder().decode(body)))
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  if (Object.keys(json).filter((key) => key.toLowerCase() === "operation").length > 1) return undefined
  const operation = "operation" in json && typeof json.operation === "string" ? json.operation : undefined
  return { operation, body: JSON.stringify(json) }
}

/**
 * Whether `text` carries one of `secrets` (GH-45): as it is, and with JSON's `\/` and `\uXXXX` escapes and URL
 * percent-escapes read, so an escaped base64 login is found too.
 */
function carries(text: string, secrets: ReadonlyArray<string>) {
  const unescaped = text
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll("\\/", "/")
    .replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return secrets.some((secret) => text.includes(secret) || unescaped.includes(secret))
}

/**
 * A Git LFS batch answer without the action headers' `Authorization` that is exactly the login the relay sent (a server
 * that hands the request's own login to the storage step, GH-45): the host's git-lfs never gets it. Any other value
 * (a storage service's short credential for one object) stays; the bytes stay as they are when nothing was dropped.
 */
function withoutLogin(body: Uint8Array, authorization: string) {
  const json = Option.getOrUndefined(decodeJson(new TextDecoder().decode(body)))
  if (!isRecord(json) || !Array.isArray(json.objects)) return body
  const dropped = { count: 0 }
  for (const object of json.objects) {
    if (!isRecord(object) || !isRecord(object.actions)) continue
    for (const action of Object.values(object.actions)) {
      if (!isRecord(action) || !isRecord(action.header)) continue
      const header = action.header
      for (const name of Object.keys(header))
        if (name.toLowerCase() === "authorization" && header[name] === authorization) {
          delete header[name]
          dropped.count += 1
        }
    }
  }
  return dropped.count === 0 ? body : new TextEncoder().encode(JSON.stringify(json))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A fixed refusal: the code, never anything of the request. */
function refusal(status: number, code: Broker.EgressError) {
  const body = { type: "error", error: { type: "own_egress", code, message: CLAUDE_REFUSED[code] } }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", connection: "close", [Broker.EGRESS_ERROR_HEADER]: code },
  })
}

/**
 * The error card's line of each Claude relay refusal (SLM: it showed the bare code before; 04 §8.11.13). The host's
 * retry decision reads the code from `x-own-egress-error`, never this text.
 */
export const CLAUDE_REFUSED: Readonly<Record<Broker.EgressError, string>> = {
  mac: "PC가 이 SSH 서버의 요청을 확인하지 못했어요. 잠시 뒤 다시 보내 주세요(연결이 막 바뀌었을 수 있어요).",
  rate_limited: "이 SSH 서버에서 PC로 가는 Claude 요청이 너무 많아 잠시 멈췄어요. 잠시 뒤 다시 보내 주세요.",
  busy: "이 SSH 서버에서 PC로 가는 Claude 요청이 이미 많이 진행 중이에요. 잠시 뒤 다시 보내 주세요.",
  off: "PC에서 이 SSH 서버의 Claude 구독 사용이 꺼져 있어요. PC의 계정 화면 > Claude 구독 > SSH 원격 호스트에서 켜세요.",
  host_scope: "이 SSH 서버의 계정 범위에 이 Claude 구독 계정이 없어요. PC의 설정 > SSH 원격 호스트에서 범위를 바꾸세요.",
  consent: "PC에서 SSH 원격 호스트의 Claude 구독 사용 동의가 필요해요. PC의 계정 화면 > Claude 구독에서 켜세요.",
  not_ready:
    "PC의 Claude 구독이 아직 준비되지 않았어요(로그인이 만료됐거나 플러그인이 아직 뜨지 않았어요). PC의 계정 화면에서 로그인을 확인한 뒤 다시 보내 주세요.",
  billing: "PC의 Anthropic 연결이 API 키라 SSH 서버에서 Claude 구독으로 쓰지 않아요.",
  needs_reauth: "Anthropic이 PC의 Claude 로그인을 거절했어요. PC에서 Claude Code에 다시 로그인한 뒤 계속하세요.",
  too_large: "요청이 너무 커서(32 MiB 초과) PC가 중계하지 않았어요.",
  bad_request: "PC가 이 요청을 중계하지 않았어요(요청 형식이 맞지 않아요).",
  upstream_unreachable: "PC가 Anthropic에 연결하지 못했어요. PC의 인터넷 연결을 확인한 뒤 다시 보내 주세요.",
}

/**
 * A local model relay refusal (04 §8.14): the code (`x-own-local-error`) and the line the conversation's error card
 * shows (`error.message`), never anything of the request.
 */
function localRefusal(status: number, code: Broker.LocalError) {
  return new Response(JSON.stringify({ error: { type: "own_local_relay", code, message: LOCAL_REFUSED[code] } }), {
    status,
    headers: { "content-type": "application/json", connection: "close", [Broker.LOCAL_ERROR_HEADER]: code },
  })
}

/** The error card's line of each local relay refusal (manual 22 "PC의 로컬 모델"). */
export const LOCAL_REFUSED: Readonly<Record<Broker.LocalError, string>> = {
  mac: "PC가 이 SSH 서버의 요청을 확인하지 못했어요. 잠시 뒤 다시 보내 주세요(연결이 막 바뀌었을 수 있어요).",
  rate_limited: "이 SSH 서버에서 PC로 가는 요청이 너무 많아 잠시 멈췄어요. 잠시 뒤 다시 보내 주세요.",
  busy: "이 SSH 서버에서 PC의 로컬 모델로 가는 요청이 이미 많이 진행 중이에요. 잠시 뒤 다시 보내 주세요.",
  bad_request:
    "PC가 이 요청을 로컬 모델 서버로 보내지 않았어요(계정의 주소와 맞지 않아요). PC의 계정 화면에서 주소를 확인해 주세요.",
  not_found: "PC에 이 로컬 모델 계정이 없어요(지웠거나 다른 종류로 바꿨어요). 다른 모델을 고르세요.",
  host_scope:
    "이 로컬 모델은 이 SSH 서버에서 쓰지 않게 되어 있어요. PC의 설정 > SSH 원격 호스트에서 이 호스트의 계정 범위에 넣거나 다른 모델을 고르세요.",
  needs_key: "PC가 이 로컬 모델의 키를 읽지 못했어요. PC의 계정 화면에서 [연결 확인]을 눌러 보세요.",
  too_large: "요청이 너무 커서(32 MiB 초과) PC가 로컬 모델로 보내지 않았어요.",
  upstream_unreachable:
    "PC가 로컬 모델 서버에 연결하지 못했어요. PC에서 모델 서버가 켜져 있는지 확인한 뒤 다시 보내 주세요.",
}

/** Hop-by-hop and own request headers a local model request never passes on; the host's credentials neither. */
const LOCAL_DROPPED = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "authorization",
  "x-api-key",
  "cookie",
])

/** A local model request's headers as the host sent them, without {@link LOCAL_DROPPED} and own's `x-own-*`. */
function localForwarded(incoming: Headers) {
  const headers = new Headers()
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (!LOCAL_DROPPED.has(lower) && !lower.startsWith("x-own-")) headers.set(lower, value)
  })
  return headers
}

/** The allowed request headers of the host (everything else, credentials and `x-stainless-*` included, is dropped). */
function forwarded(incoming: Headers) {
  const headers = new Headers()
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (
      FORWARDED.includes(lower) ||
      FORWARDED_EXACT.includes(lower) ||
      FORWARDED_PREFIX.some((prefix) => lower.startsWith(prefix))
    )
      headers.set(lower, value)
  })
  return headers
}

/** Step 6: a JSON object; `system` as text blocks (kept as they are), a string as one block, absent as none. */
function normalize(json: unknown) {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const body = json as Record<string, unknown>
  const system = systemOf(body.system)
  if (!system) return undefined
  body.system = system
  return { body, system }
}

function systemOf(value: unknown): Array<ClaudeWire.SystemBlock> | undefined {
  if (value === undefined) return []
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (Array.isArray(value) && value.every(textBlock)) return value
  return undefined
}

function textBlock(value: unknown): value is ClaudeWire.SystemBlock {
  if (typeof value !== "object" || value === null) return false
  const block = value as Record<string, unknown>
  return block.type === "text" && typeof block.text === "string"
}

/** The request body, at most {@link Broker.EGRESS_MAX_BODY_BYTES}, uploaded within `timeoutMs`. */
function read(request: Request, timeoutMs: number) {
  return readLimited(request, Broker.EGRESS_MAX_BODY_BYTES, timeoutMs)
}

/** A request's (or an answer's) body, at most `limit` bytes, arrived within `timeoutMs`. */
async function readLimited(
  message: { readonly body: ReadableStream<Uint8Array> | null },
  limit: number,
  timeoutMs: number,
): Promise<Uint8Array | "too_large" | "timeout"> {
  const reader = message.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  const size = { value: 0 }
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const deadline = new Promise<"timeout">((resolve) => {
    timer.id = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  const outcome = await (async (): Promise<"done" | "too_large" | "timeout"> => {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === "timeout") return "timeout"
      if (next.done) return "done"
      size.value += next.value.byteLength
      if (size.value > limit) return "too_large"
      chunks.push(next.value)
    }
  })().finally(() => clearTimeout(timer.id))
  if (outcome !== "done") {
    await reader.cancel().catch(() => undefined)
    return outcome
  }
  return Buffer.concat(chunks)
}

/**
 * The answer as it arrives: pulled from upstream only as the host reads (backpressure), counted, and ending the
 * upstream request when the host goes away (the plugin's response stream has no `cancel` of its own).
 */
function track(source: ReadableStream<Uint8Array>, controller: AbortController, release: (bytes: number) => void) {
  const reader = source.getReader()
  const bytes = { value: 0 }
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      const next = await reader.read().catch(() => undefined)
      if (!next || next.done) {
        release(bytes.value)
        stream.close()
        return
      }
      bytes.value += next.value.byteLength
      stream.enqueue(next.value)
    },
    cancel(reason) {
      controller.abort()
      release(bytes.value)
      return reader.cancel(reason).catch(() => undefined)
    },
  })
}
