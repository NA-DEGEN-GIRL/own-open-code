export * as CodexSource from "./codex-source.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Credential, type OwnError } from "@own/protocol"
import { readBounded } from "./fsx.js"
import { short } from "./hash.js"
import { chatgpt, maskEmail } from "./jwt.js"

// Imports ChatGPT logins from the older codex-multi-provider app (user decision, extension of 02 §3.1 C3):
//   <control-center>\state.json                         profiles[].{id, alias}
//   <control-center>\profiles\<id>\codex\auth.json      {auth_mode:"chatgpt", tokens:{...}, last_refresh}
// Source files are only ever read, never written. Linked mode leaves the old app as the single refresher of the token
// family; takeover copies the tokens into our vault once (Credentials.takeover).

/** The control center of this user's installation. Callers may pass another root. */
export const DEFAULT_CONTROL_CENTER = "D:\\#Projects\\codex-multi-provider\\work\\control-center"

/** `auth.json` files larger than this are refused, like the old app's own reader does. */
export const MAX_BYTES = 1024 * 1024

export type Problem = OwnError.SourceProblem

/** Non-secret facts about a source login. */
export interface Identity {
  readonly chatgptAccountId?: string
  readonly sub?: string
  readonly emailMasked?: string
  readonly plan?: string
  /** `sha256:` guard fingerprint (02 §3.1 C5), when both the account id and `sub` are known. */
  readonly fingerprint?: string
}

export interface Summary {
  readonly identity: Identity
  /** Access token expiry, epoch ms. */
  readonly expiresAt: number
  /** The source's `last_refresh` as written (RFC 3339, possibly with nanoseconds). */
  readonly lastRefresh: string | null
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Token values of one read. Private fields keep them out of `JSON.stringify`, `console.log` and enumeration; only
 * {@link Credentials} and the takeover path call the accessors.
 */
export class Secret {
  readonly #access: string
  readonly #refresh: string
  readonly #idToken: string

  constructor(tokens: { readonly access: string; readonly refresh: string; readonly idToken: string }) {
    this.#access = tokens.access
    this.#refresh = tokens.refresh
    this.#idToken = tokens.idToken
  }

  access() {
    return this.#access
  }

  refresh() {
    return this.#refresh
  }

  idToken() {
    return this.#idToken
  }

  /** `hash8` of the access token, to recognize a token that was rejected with 401. */
  accessHash() {
    return short(this.#access)
  }

  toJSON() {
    return "[CodexSource.Secret]"
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "[CodexSource.Secret]"
  }
}

export interface Snapshot {
  readonly summary: Summary
  readonly secret: Secret
  /** When this process read the file (epoch ms). */
  readonly readAt: number
}

/**
 * The login a linked or taken-over source must keep holding (02 §3.1 C5): the registry's `identity.chatgptAccountId`
 * and, when recorded, its guard `fingerprint`. The fingerprint also covers `sub`, so another member of the same
 * ChatGPT Business workspace (same account id, different user) is refused too.
 */
export interface Expected {
  readonly accountId?: string
  readonly fingerprint?: string
}

export type ReadResult =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly problem: Problem }

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeAuth = Schema.decodeUnknownOption(Credential.CodexAuthFile)
const decodeChatgpt = Schema.decodeUnknownOption(Credential.CodexChatgptAuthFile)
const decodeState = Schema.decodeUnknownOption(Credential.CodexStateFile)
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Reads one `auth.json` read-only and parses its tokens and claims. Token values never leave the returned
 * {@link Secret}. A source that no longer holds the `expected` login is `account_mismatch` (02 §3.1 C5).
 */
export async function read(
  authPath: string,
  options: { readonly now?: number; readonly expected?: Expected } = {},
): Promise<ReadResult> {
  const file = await readBounded(authPath, MAX_BYTES)
  if (file.type !== "ok") return { ok: false, problem: "unreadable" }
  const json = Option.getOrUndefined(decodeJson(file.text))
  const auth = json === undefined ? undefined : Option.getOrUndefined(decodeAuth(json))
  if (!auth) return { ok: false, problem: "parse_failed" }
  if (Credential.codexAuthMode(auth) !== "chatgpt") return { ok: false, problem: "not_chatgpt" }
  const full = Option.getOrUndefined(decodeChatgpt(json))
  if (!full) return { ok: false, problem: "missing_tokens" }
  const claims = chatgpt({ idToken: full.tokens.id_token, accessToken: full.tokens.access_token })
  if (claims.expiresAt === undefined) return { ok: false, problem: "parse_failed" }
  const fileAccount = full.tokens.account_id ?? undefined
  if (fileAccount !== undefined && claims.accountId !== undefined && fileAccount !== claims.accountId)
    return { ok: false, problem: "account_mismatch" }
  const accountId = fileAccount ?? claims.accountId
  if (!matches(options.expected, accountId, claims.fingerprint)) return { ok: false, problem: "account_mismatch" }
  return {
    ok: true,
    snapshot: {
      summary: {
        identity: {
          chatgptAccountId: accountId,
          sub: claims.sub,
          emailMasked: claims.email === undefined ? undefined : maskEmail(claims.email),
          plan: claims.plan,
          fingerprint: claims.fingerprint,
        },
        expiresAt: claims.expiresAt,
        lastRefresh: full.last_refresh ?? null,
        mtimeMs: file.mtimeMs,
        size: file.size,
      },
      secret: new Secret({
        access: full.tokens.access_token,
        refresh: full.tokens.refresh_token,
        idToken: full.tokens.id_token,
      }),
      readAt: options.now ?? Date.now(),
    },
  }
}

export type Inspection =
  | { readonly ok: true; readonly summary: Summary; readonly expired: boolean }
  | { readonly ok: false; readonly problem: Problem }

/** One read without keeping token values: what an import picker shows. */
export async function inspect(
  authPath: string,
  options: { readonly now?: number; readonly expected?: Expected } = {},
): Promise<Inspection> {
  const now = options.now ?? Date.now()
  const result = await read(authPath, { now, expected: options.expected })
  if (!result.ok) return result
  return { ok: true, summary: result.snapshot.summary, expired: result.snapshot.summary.expiresAt <= now }
}

export interface Profile {
  readonly profileID: string
  readonly alias: string | null
  /** The profile as a credential source ref (`Credential.CodexSource`). */
  readonly source: Credential.CodexSource
  readonly inspection: Inspection
}

/**
 * Profiles of a control center: `state.json` gives ids and aliases, each profile's `auth.json` is inspected.
 * `available: false` when there is no readable `state.json`. Profiles with ids that are not plain names are skipped
 * so an id can never point outside `profiles\`.
 */
export async function list(
  root: string,
  options: { readonly now?: number } = {},
): Promise<{ readonly available: boolean; readonly profiles: ReadonlyArray<Profile> }> {
  const file = await readBounded(path.join(root, "state.json"), 16 * MAX_BYTES)
  const json = file.type === "ok" ? Option.getOrUndefined(decodeJson(file.text)) : undefined
  const state = json === undefined ? undefined : Option.getOrUndefined(decodeState(json))
  if (!state) return { available: false, profiles: [] }
  const profiles = await Promise.all(
    state.profiles
      .filter((profile) => PROFILE_ID.test(profile.id))
      .map(async (profile): Promise<Profile> => {
        const ref = source(root, { id: profile.id, alias: profile.alias ?? null })
        return {
          profileID: profile.id,
          alias: profile.alias ?? null,
          source: ref,
          inspection: await inspect(ref.authPath, options),
        }
      }),
  )
  return { available: true, profiles }
}

/** One codex-multi-provider account home: `<control-center>\profiles\<id>\codex` (a `CODEX_HOME`). */
export interface ProfileHome {
  readonly profileID: string
  readonly alias: string | null
  readonly home: string
}

/**
 * The account homes of a control center for finding skills (09 §9.1, SK2 2026-10-24): `state.json` only, its profile
 * ids and aliases. The home is built from the id (a plain name, as in {@link list}); the file's own `home` field is
 * ignored and no `auth.json` is opened or stat'ed, so this can run on every skills list without touching a login.
 * Empty when there is no readable `state.json`.
 */
export async function profileHomes(root: string): Promise<ReadonlyArray<ProfileHome>> {
  const file = await readBounded(path.join(root, "state.json"), 16 * MAX_BYTES)
  const json = file.type === "ok" ? Option.getOrUndefined(decodeJson(file.text)) : undefined
  const state = json === undefined ? undefined : Option.getOrUndefined(decodeState(json))
  if (!state) return []
  const ids = state.profiles.map((profile) => profile.id)
  return state.profiles
    .filter((profile, index) => PROFILE_ID.test(profile.id) && ids.indexOf(profile.id) === index)
    .map((profile) => ({
      profileID: profile.id,
      alias: profile.alias?.trim() || null,
      home: path.join(root, "profiles", profile.id, "codex"),
    }))
}

function matches(expected: Expected | undefined, accountId: string | undefined, fingerprint: string | undefined) {
  if (expected?.accountId !== undefined && accountId !== expected.accountId) return false
  return expected?.fingerprint === undefined || fingerprint === expected.fingerprint
}

/** The credential source ref of one profile. */
export function source(root: string, profile: { readonly id: string; readonly alias: string | null }) {
  return Credential.CodexSource.make({
    app: "codex-multi-provider",
    profileID: profile.id,
    alias: profile.alias,
    authPath: path.join(root, "profiles", profile.id, "codex", "auth.json"),
  })
}

/** Epoch ms of an RFC 3339 `last_refresh` (fractional seconds of any length), or `undefined`. */
export function parseLastRefresh(value: string | null | undefined) {
  if (!value) return undefined
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"))
  return Number.isFinite(ms) ? ms : undefined
}

export interface ReaderOptions {
  readonly now?: () => number
  /** Minimum time between two `stat` calls of the source. Default 1 s. */
  readonly statIntervalMs?: number
  /** Tokens are dropped and the file read again after this long, `policy.secretCacheSeconds`. Default 600 s. */
  readonly ttlMs?: number
  /** A token closer than this to its expiry counts as expired. Default 60 s. */
  readonly expiryMarginMs?: number
  /** Failed reads (e.g. a torn write) during which the last good tokens are still used. Default 3. */
  readonly graceReads?: number
  /** The registry login the source must keep holding. */
  readonly expected?: Expected
}

export type Usable =
  | { readonly ok: true; readonly snapshot: Snapshot; readonly degraded: boolean }
  /** The tokens are expired or were rejected, and the old app has not written new ones yet (`codex_source_stale`). */
  | { readonly ok: false; readonly reason: "stale"; readonly cause: "expired" | "rejected"; readonly summary: Summary }
  | { readonly ok: false; readonly reason: "invalid"; readonly problem: Problem }

/**
 * Linked-mode reader of one source file. It never writes the file and never refreshes the token family: it re-reads
 * the file when its mtime or size changes (checked at most once per `statIntervalMs`), when the cached tokens are
 * older than the TTL, and after {@link Reader.reject} reports a 401. A torn read during the old app's in-place write
 * keeps the last good tokens for a few reads.
 */
export class Reader {
  readonly authPath: string
  readonly #now: () => number
  readonly #statIntervalMs: number
  #ttlMs: number
  readonly #marginMs: number
  readonly #graceReads: number
  #expected: Expected | undefined
  #snapshot: Snapshot | undefined
  #checkedAt = Number.NEGATIVE_INFINITY
  #dirty = false
  #failures = 0
  #problem: Problem | undefined
  #rejected: string | undefined
  #reading: Promise<Current> | undefined

  constructor(authPath: string, options: ReaderOptions = {}) {
    this.authPath = authPath
    this.#now = options.now ?? Date.now
    this.#statIntervalMs = options.statIntervalMs ?? 1_000
    this.#ttlMs = options.ttlMs ?? 600_000
    this.#marginMs = options.expiryMarginMs ?? 60_000
    this.#graceReads = options.graceReads ?? 3
    this.#expected = options.expected
  }

  /** Updates the login the source must hold; a change forces a re-read. */
  expect(expected: Expected | undefined) {
    if (expected?.accountId === this.#expected?.accountId && expected?.fingerprint === this.#expected?.fingerprint)
      return
    this.#expected = expected
    this.#dirty = true
    this.#checkedAt = Number.NEGATIVE_INFINITY
  }

  /** Changes the token TTL, e.g. after `policy.secretCacheSeconds` changed. */
  configure(ttlMs: number) {
    this.#ttlMs = ttlMs
  }

  /** Current tokens if they can be used for a request. */
  async usable(): Promise<Usable> {
    const current = await this.#current()
    if (!current.ok) return current
    const summary = current.snapshot.summary
    if (this.#rejected === current.snapshot.secret.accessHash())
      return { ok: false, reason: "stale", cause: "rejected", summary }
    if (summary.expiresAt - this.#marginMs <= this.#now())
      return { ok: false, reason: "stale", cause: "expired", summary }
    return current
  }

  /**
   * Reports that the provider answered 401 to the current access token (02 §3.5 F1 "401을 받은 뒤"). The file is read
   * again on the next use; until the old app writes a different token, the source is stale.
   */
  reject() {
    if (this.#snapshot) this.#rejected = this.#snapshot.secret.accessHash()
    this.#dirty = true
    this.#checkedAt = Number.NEGATIVE_INFINITY
  }

  /** What is known without reading the file again. No token values. */
  status() {
    return {
      summary: this.#snapshot?.summary,
      problem: this.#problem,
      rejected: this.#rejected !== undefined && this.#rejected === this.#snapshot?.secret.accessHash(),
    }
  }

  // One read at a time: concurrent requests share it.
  #current(): Promise<Current> {
    if (this.#reading) return this.#reading
    const reading = this.#check().finally(() => {
      this.#reading = undefined
    })
    this.#reading = reading
    return reading
  }

  async #check(): Promise<Current> {
    const now = this.#now()
    const snapshot = this.#snapshot
    const fresh = snapshot !== undefined && !this.#dirty && now - snapshot.readAt < this.#ttlMs
    if (now - this.#checkedAt < this.#statIntervalMs) {
      if (fresh) return { ok: true, snapshot, degraded: false }
      if (this.#problem) return this.#failed(snapshot, this.#problem)
    }
    this.#checkedAt = now
    if (fresh) {
      const stat = await fs.stat(this.authPath).catch(() => undefined)
      if (stat && stat.mtimeMs === snapshot.summary.mtimeMs && stat.size === snapshot.summary.size)
        return { ok: true, snapshot, degraded: false }
    }
    const result = await read(this.authPath, { now, expected: this.#expected })
    if (result.ok) {
      this.#snapshot = result.snapshot
      this.#dirty = false
      this.#failures = 0
      this.#problem = undefined
      return { ok: true, snapshot: result.snapshot, degraded: false }
    }
    this.#failures += 1
    this.#problem = result.problem
    this.#dirty = true
    // Tokens of a different login must never be used again.
    if (result.problem === "account_mismatch") this.#snapshot = undefined
    return this.#failed(this.#snapshot, result.problem)
  }

  #failed(snapshot: Snapshot | undefined, problem: Problem): Current {
    const transient = problem === "parse_failed" || problem === "unreadable"
    if (snapshot && transient && this.#failures <= this.#graceReads) return { ok: true, snapshot, degraded: true }
    return { ok: false, reason: "invalid", problem }
  }
}

type Current =
  | { readonly ok: true; readonly snapshot: Snapshot; readonly degraded: boolean }
  | { readonly ok: false; readonly reason: "invalid"; readonly problem: Problem }
