export * as Pairing from "./pairing.js"

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { OwnID } from "@own/protocol"
import { Hash } from "@own/runtime"
import type { OwnRemote } from "../protocol/rpc-remote.js"
import { Devices } from "./devices.js"

/**
 * Pairings in progress (05 §13.5 흐름), memory only. The code follows upstream's pairing shape (128-bit random
 * base64url, 5 minutes, one use, at most 1,000 open) but is handled by the gateway, never by the service's
 * `/api/pair`. Opening the link does not register anything: it gives the device a claim secret (a cookie) and a
 * 4-digit SAS, and the PC must approve with the same SAS within 2 minutes. Only a claim of an approved pairing
 * creates the device record and its token.
 */

export const CODE_TTL_MS = 5 * 60 * 1000
export const APPROVAL_TTL_MS = 2 * 60 * 1000
export const CLAIM_TTL_MS = 2 * 60 * 1000
export const MAX_OPEN = 1000
/** How long a device polling a finished pairing still learns why it ended. */
const TOMBSTONE_MS = 5 * 60 * 1000
/**
 * A device that has not polled its open pairing for this long is reported once as silent (the app polls every second
 * while it is on screen; Android cuts a background app's network under data saver).
 */
export const SILENT_MS = 10_000

export interface Request {
  readonly name: string
  readonly scopes: ReadonlyArray<OwnRemote.DeviceScope>
  readonly servers: OwnRemote.ServerScope
  readonly expiresDays: number
}

export interface Entry extends Request {
  readonly pairingId: string
  readonly deviceId: string
  readonly codeHash: string
  state: "waiting" | "pending" | "approved"
  expiresAt: number
  sas: string | null
  claimHash: string | null
  userAgent: string | null
  tailscaleUser: string | null
  ip: string | null
  readonly createdAt: number
  /** The device's last contact (the link opened, a poll); `quiet` once it was reported silent. */
  polledAt: number
  quiet: boolean
}

export type Ended = "claimed" | "cancelled" | "rejected" | "expired"

export type DeviceStatus =
  | { readonly state: "pending"; readonly sas: string; readonly name: string; readonly expiresAt: number }
  | { readonly state: "approved"; readonly name: string; readonly expiresAt: number }
  | { readonly state: "rejected" | "expired" | "cancelled" | "claimed" | "unknown" }

export interface Events {
  pending(entry: Entry): void
  ended(entry: Entry, reason: Ended): void
  /** The device stopped polling an open pairing for {@link SILENT_MS} (once per silence). */
  silent?(entry: Entry, silentMs: number): void
  /** A silent device polled again. */
  back?(entry: Entry, silentMs: number): void
}

export class Book {
  readonly #entries = new Map<string, Entry>()
  /** codeHash → pairingId (waiting entries only). */
  readonly #codes = new Map<string, string>()
  /** claimHash → pairingId. */
  readonly #claims = new Map<string, string>()
  /** claimHash → why the pairing ended, for the device's last poll. */
  readonly #tombstones = new Map<string, { readonly reason: Ended; readonly until: number }>()
  readonly #now: () => number
  readonly #events: Events

  constructor(input: { readonly now?: () => number; readonly events: Events }) {
    this.#now = input.now ?? Date.now
    this.#events = input.events
  }

  /** `devices.pair.start`: a new code (returned once, for the link) and its pairing. */
  start(request: Request) {
    this.sweep()
    const open = [...this.#entries.values()]
    if (open.length >= MAX_OPEN) {
      const oldest = open.filter((entry) => entry.state === "waiting").sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) this.#end(oldest, "expired")
    }
    const now = this.#now()
    const code = randomBytes(16).toString("base64url")
    const entry: Entry = {
      ...request,
      scopes: [...new Set(request.scopes)],
      pairingId: `pair_${OwnID.ulid(now)}`,
      deviceId: Devices.newDeviceId(),
      codeHash: Hash.sha256(code),
      state: "waiting",
      expiresAt: now + CODE_TTL_MS,
      sas: null,
      claimHash: null,
      userAgent: null,
      tailscaleUser: null,
      ip: null,
      createdAt: now,
      polledAt: now,
      quiet: false,
    }
    this.#entries.set(entry.pairingId, entry)
    this.#codes.set(entry.codeHash, entry.pairingId)
    return { entry, code }
  }

  /**
   * `GET /auth/connect/<code>`: consumes the code (one use) and moves the pairing to `pending` with a SAS and a claim
   * secret for the device. `undefined` for an unknown, used or expired code.
   */
  open(code: string, info: { readonly userAgent: string | null; readonly tailscaleUser: string | null; readonly ip: string | null }) {
    this.sweep()
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return undefined
    const codeHash = Hash.sha256(code)
    const id = this.#codes.get(codeHash)
    const entry = id ? this.#entries.get(id) : undefined
    if (!entry || entry.state !== "waiting" || !same(entry.codeHash, codeHash)) return undefined
    this.#codes.delete(codeHash)
    const claim = randomBytes(32).toString("base64url")
    entry.state = "pending"
    entry.sas = String(randomInt(0, 10_000)).padStart(4, "0")
    entry.claimHash = Hash.sha256(claim)
    entry.userAgent = info.userAgent
    entry.tailscaleUser = info.tailscaleUser
    entry.ip = info.ip
    entry.expiresAt = this.#now() + APPROVAL_TTL_MS
    entry.polledAt = this.#now()
    this.#claims.set(entry.claimHash, entry.pairingId)
    this.#events.pending(entry)
    return { entry, claim }
  }

  /** `devices.pair.approve`: the SAS must be the one the device shows; a wrong one cancels the pairing (fail closed). */
  approve(pairingId: string, sas: string):
    | { readonly ok: true; readonly entry: Entry }
    | { readonly ok: false; readonly error: "pairing_expired" | "pairing_rejected"; readonly reason?: string } {
    this.sweep()
    const entry = this.#entries.get(pairingId)
    if (!entry) return { ok: false, error: "pairing_expired" }
    if (entry.state !== "pending" || entry.sas === null) return { ok: false, error: "pairing_rejected", reason: "not_pending" }
    if (!same(entry.sas, sas)) {
      this.#end(entry, "rejected")
      return { ok: false, error: "pairing_rejected", reason: "sas_mismatch" }
    }
    entry.state = "approved"
    entry.expiresAt = this.#now() + CLAIM_TTL_MS
    return { ok: true, entry }
  }

  cancel(pairingId: string) {
    const entry = this.#entries.get(pairingId)
    if (entry) this.#end(entry, entry.state === "pending" ? "rejected" : "cancelled")
  }

  /** What a device polling with its claim secret sees. */
  status(claim: string): DeviceStatus {
    this.sweep()
    const hash = Hash.sha256(claim)
    const id = this.#claims.get(hash)
    const entry = id ? this.#entries.get(id) : undefined
    if (entry && entry.state !== "waiting") this.#heard(entry)
    if (entry?.state === "pending" && entry.sas) return { state: "pending", sas: entry.sas, name: entry.name, expiresAt: entry.expiresAt }
    if (entry?.state === "approved") return { state: "approved", name: entry.name, expiresAt: entry.expiresAt }
    const tomb = this.#tombstones.get(hash)
    return { state: tomb?.reason ?? "unknown" }
  }

  /** The approved pairing of this claim secret, removed (one claim). */
  claim(secret: string): Entry | undefined {
    this.sweep()
    const hash = Hash.sha256(secret)
    const id = this.#claims.get(hash)
    const entry = id ? this.#entries.get(id) : undefined
    if (!entry || entry.state !== "approved" || !entry.claimHash || !same(entry.claimHash, hash)) return undefined
    this.#end(entry, "claimed")
    return entry
  }

  list(): Entry[] {
    this.sweep()
    return [...this.#entries.values()]
  }

  get(pairingId: string) {
    return this.#entries.get(pairingId)
  }

  /** Expires what ran out of time (called on every access and by the gateway's timer). */
  sweep() {
    const now = this.#now()
    for (const entry of [...this.#entries.values()]) if (now >= entry.expiresAt) this.#end(entry, "expired")
    for (const [hash, tomb] of this.#tombstones) if (now >= tomb.until) this.#tombstones.delete(hash)
    for (const entry of this.#entries.values()) {
      if (entry.state === "waiting" || entry.quiet || now - entry.polledAt < SILENT_MS) continue
      entry.quiet = true
      this.#events.silent?.(entry, now - entry.polledAt)
    }
  }

  clear() {
    for (const entry of [...this.#entries.values()]) this.#end(entry, "cancelled")
  }

  #heard(entry: Entry) {
    const now = this.#now()
    if (entry.quiet) this.#events.back?.(entry, now - entry.polledAt)
    entry.quiet = false
    entry.polledAt = now
  }

  #end(entry: Entry, reason: Ended) {
    this.#entries.delete(entry.pairingId)
    this.#codes.delete(entry.codeHash)
    if (entry.claimHash) {
      this.#claims.delete(entry.claimHash)
      this.#tombstones.set(entry.claimHash, { reason, until: this.#now() + TOMBSTONE_MS })
    }
    this.#events.ended(entry, reason)
  }
}

export function view(entry: Entry): OwnRemote.PairingView {
  return {
    pairingId: entry.pairingId as OwnRemote.PairingID,
    name: entry.name,
    scopes: [...entry.scopes],
    servers: entry.servers,
    expiresDays: entry.expiresDays,
    state: entry.state,
    expiresAt: entry.expiresAt,
    sas: entry.sas,
    userAgent: entry.userAgent,
    tailscaleUser: entry.tailscaleUser,
  }
}

/**
 * Failure counter of `/auth/connect` (05 §13.8 "시도 속도 제한", MG2 무차별 대입): 5 bad codes per address per minute,
 * 30 per minute in total, then that address (or everyone) waits a minute. Codes are 128-bit, so this only keeps a
 * scanner from filling the log and the CPU.
 */
export class Limiter {
  readonly #failures = new Map<string, number[]>()
  #global: number[] = []
  readonly #blocked = new Map<string, number>()
  #globalBlockedUntil = 0
  readonly #now: () => number
  readonly perAddress: number
  readonly total: number

  constructor(input: { readonly now?: () => number; readonly perAddress?: number; readonly total?: number } = {}) {
    this.#now = input.now ?? Date.now
    this.perAddress = input.perAddress ?? 5
    this.total = input.total ?? 30
  }

  blocked(address: string) {
    const now = this.#now()
    return now < this.#globalBlockedUntil || now < (this.#blocked.get(address) ?? 0)
  }

  fail(address: string) {
    const now = this.#now()
    const since = now - 60_000
    const list = (this.#failures.get(address) ?? []).filter((at) => at > since)
    list.push(now)
    this.#failures.set(address, list)
    this.#global = this.#global.filter((at) => at > since)
    this.#global.push(now)
    if (list.length >= this.perAddress) this.#blocked.set(address, now + 60_000)
    if (this.#global.length >= this.total) this.#globalBlockedUntil = now + 60_000
    if (this.#failures.size > 10_000) this.#failures.clear()
  }
}

function same(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
