export * as Devices from "./devices.js"

import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { OwnID } from "@own/protocol"
import { Fsx, Hash, Lock } from "@own/runtime"
import { OwnRemote } from "../protocol/rpc-remote.js"

/**
 * Paired devices `OWN_HOME\devices.json` (05 §13.5 "저장"): one record per device, the token as `sha256:<hex>` only.
 * The plaintext token exists once, in the claim response (a cookie or `{token}`); it is never stored, logged or
 * returned again. Revocation is a write here and takes effect on the next request: the gateway verifies against this
 * in-process store (the "cache ≤ 5 s" of 05 §13.5 is 0 here), and re-reads the file when another writer changed it.
 *
 * Scopes added after the first version-1 file (`OwnRemote.EXTRA_DEVICE_SCOPES`: `browser`, 05 §8.10.2) are written to
 * `extraScopes`, beside `scopes`: a build from before them fails the whole file on an unknown word in `scopes` and
 * would lose every device, while it ignores a key it does not know and only loses the extras. In memory a record's
 * `scopes` hold both.
 */

const Record = Schema.Struct({
  deviceId: Schema.String,
  name: Schema.String,
  kind: OwnRemote.DeviceKind,
  scopes: Schema.Array(OwnRemote.DeviceScope),
  servers: OwnRemote.ServerScope,
  tokenHash: Schema.String,
  createdAt: Schema.Finite,
  lastSeenAt: Schema.NullOr(Schema.Finite),
  lastIp: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  expiresAt: Schema.Finite,
  idleTimeoutDays: Schema.Int,
  revokedAt: Schema.NullOr(Schema.Finite),
  /** Last acknowledged feed id (05 §13.6 `feedCursor`). */
  feedCursor: Schema.NullOr(Schema.String),
})
export type DeviceRecord = typeof Record.Type

const Stored = Schema.Struct({ ...Record.fields, extraScopes: Schema.optional(Schema.Array(Schema.String)) })
const File = Schema.Struct({ version: Schema.Literal(1), devices: Schema.Array(Stored) })
const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(File))

function fromStored(stored: typeof Stored.Type): DeviceRecord {
  const { extraScopes, ...record } = stored
  const extras = OwnRemote.EXTRA_DEVICE_SCOPES.filter((scope) => extraScopes?.includes(scope))
  return { ...record, scopes: [...new Set([...record.scopes, ...extras])] }
}

function toStored(record: DeviceRecord): typeof Stored.Type {
  const extras = record.scopes.filter((scope) => OwnRemote.EXTRA_DEVICE_SCOPES.includes(scope))
  return {
    ...record,
    scopes: record.scopes.filter((scope) => !OwnRemote.EXTRA_DEVICE_SCOPES.includes(scope)),
    ...(extras.length > 0 ? { extraScopes: extras } : {}),
  }
}

/** 05 §13.5 / 01 §6.4 initial values: 30 days, expired after 14 days unused. */
export const DEFAULT_EXPIRES_DAYS = 30
export const IDLE_TIMEOUT_DAYS = 14
const DAY = 24 * 60 * 60 * 1000
/** `lastSeenAt` is persisted at most this often per device (the audit keeps the finer numbers). */
const TOUCH_PERSIST_MS = 60_000
/** Revoked and expired records stay listed this long, then leave the file. */
const KEEP_ENDED_MS = 30 * DAY

export type Verified =
  | { readonly ok: true; readonly device: DeviceRecord }
  | { readonly ok: false; readonly reason: "unknown" | "revoked" | "expired"; readonly deviceId?: string }

export function hashToken(token: string) {
  return `sha256:${Hash.sha256(token)}`
}

/** 256-bit token (05 §13.5), base64url. */
export function newToken() {
  return randomBytes(32).toString("base64url")
}

export function newDeviceId() {
  return `dev_${OwnID.ulid()}`
}

export function state(device: DeviceRecord, now: number): "active" | "expired" | "revoked" {
  if (device.revokedAt !== null) return "revoked"
  if (now >= device.expiresAt) return "expired"
  if (now - (device.lastSeenAt ?? device.createdAt) >= device.idleTimeoutDays * DAY) return "expired"
  return "active"
}

export function view(device: DeviceRecord, now: number): OwnRemote.DeviceView {
  return {
    deviceId: device.deviceId as OwnRemote.DeviceID,
    name: device.name,
    kind: device.kind,
    scopes: [...device.scopes],
    servers: device.servers,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    lastIp: device.lastIp,
    userAgent: device.userAgent,
    expiresAt: device.expiresAt,
    idleTimeoutDays: device.idleTimeoutDays,
    revokedAt: device.revokedAt,
    state: state(device, now),
  }
}

export class Store {
  readonly file: string
  readonly #mutex = new Lock.Mutex()
  readonly #now: () => number
  #devices: DeviceRecord[] = []
  /** tokenHash → deviceId */
  #byHash = new Map<string, string>()
  #mtime: number | undefined
  #checkedAt = 0
  readonly #persistedSeen = new Map<string, number>()
  /** Devices whose in-memory `lastSeenAt` is newer than the file. */
  readonly #dirty = new Set<string>()
  #loaded = false

  constructor(input: { readonly ownHome: string; readonly now?: () => number }) {
    this.file = path.join(input.ownHome, "devices.json")
    this.#now = input.now ?? Date.now
  }

  async load() {
    await this.#mutex.run(() => this.#read())
  }

  async #read() {
    const stat = await fs.stat(this.file).catch(() => undefined)
    this.#mtime = stat?.mtimeMs
    this.#checkedAt = this.#now()
    const text = stat ? await Fsx.readText(this.file).catch(() => undefined) : undefined
    const parsed = text ? decodeFile(text) : undefined
    this.#devices = parsed && parsed._tag === "Some" ? parsed.value.devices.map(fromStored) : []
    this.#index()
    this.#loaded = true
  }

  #index() {
    this.#byHash = new Map(this.#devices.map((device) => [device.tokenHash, device.deviceId]))
  }

  /** Re-reads the file when another writer changed it (checked at most once per second). */
  async #fresh() {
    if (!this.#loaded) return this.#mutex.run(() => this.#read())
    if (this.#now() - this.#checkedAt < 1000) return
    this.#checkedAt = this.#now()
    const stat = await fs.stat(this.file).catch(() => undefined)
    if (stat?.mtimeMs !== this.#mtime) await this.#mutex.run(() => this.#read())
  }

  async #write(next: DeviceRecord[]) {
    const now = this.#now()
    const kept = next.filter((device) => {
      const ended = device.revokedAt ?? (state(device, now) === "expired" ? device.expiresAt : null)
      return ended === null || now - ended < KEEP_ENDED_MS
    })
    await Fsx.writeAtomic(this.file, JSON.stringify({ version: 1, devices: kept.map(toStored) }, null, 2) + "\n")
    this.#devices = kept
    this.#index()
    this.#mtime = (await fs.stat(this.file).catch(() => undefined))?.mtimeMs
  }

  list() {
    return [...this.#devices]
  }

  get(deviceId: string) {
    return this.#devices.find((device) => device.deviceId === deviceId)
  }

  async all() {
    await this.#fresh()
    return this.list()
  }

  /** Looks the token up by its hash; a revoked or expired device answers with its reason (401 in the gateway). */
  async verify(token: string): Promise<Verified> {
    await this.#fresh()
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return { ok: false, reason: "unknown" }
    const hash = hashToken(token)
    const id = this.#byHash.get(hash)
    const device = id ? this.get(id) : undefined
    if (!device || !sameHash(device.tokenHash, hash)) return { ok: false, reason: "unknown" }
    const current = state(device, this.#now())
    if (current !== "active") return { ok: false, reason: current, deviceId: device.deviceId }
    return { ok: true, device }
  }

  /** Creates the record of a claimed pairing and returns the plaintext token (once). */
  async create(input: {
    readonly deviceId: string
    readonly name: string
    readonly kind: OwnRemote.DeviceKind
    readonly scopes: ReadonlyArray<OwnRemote.DeviceScope>
    readonly servers: OwnRemote.ServerScope
    readonly expiresDays: number
    readonly userAgent: string | null
    readonly ip: string | null
  }) {
    return this.#mutex.run(async () => {
      await this.#read()
      const now = this.#now()
      const token = newToken()
      const record: DeviceRecord = {
        deviceId: input.deviceId,
        name: input.name,
        kind: input.kind,
        scopes: [...new Set(input.scopes)],
        servers: input.servers,
        tokenHash: hashToken(token),
        createdAt: now,
        lastSeenAt: now,
        lastIp: input.ip,
        userAgent: input.userAgent,
        expiresAt: now + input.expiresDays * DAY,
        idleTimeoutDays: IDLE_TIMEOUT_DAYS,
        revokedAt: null,
        feedCursor: null,
      }
      await this.#write([...this.#devices.filter((device) => device.deviceId !== input.deviceId), record])
      return { record, token }
    })
  }

  async update(deviceId: string, patch: Partial<Pick<DeviceRecord, "name" | "scopes" | "servers" | "feedCursor" | "kind">>) {
    return this.#mutex.run(async () => {
      await this.#read()
      const current = this.get(deviceId)
      if (!current) return undefined
      const next = { ...current, ...patch, ...(patch.scopes ? { scopes: [...new Set(patch.scopes)] } : {}) }
      await this.#write(this.#devices.map((device) => (device.deviceId === deviceId ? next : device)))
      return next
    })
  }

  async revoke(deviceId: string) {
    return this.#mutex.run(async () => {
      await this.#read()
      const current = this.get(deviceId)
      if (!current) return undefined
      if (current.revokedAt !== null) return current
      const next = { ...current, revokedAt: this.#now() }
      await this.#write(this.#devices.map((device) => (device.deviceId === deviceId ? next : device)))
      return next
    })
  }

  async revokeAll() {
    return this.#mutex.run(async () => {
      await this.#read()
      const now = this.#now()
      const revoked = this.#devices.filter((device) => device.revokedAt === null).map((device) => device.deviceId)
      if (revoked.length > 0)
        await this.#write(this.#devices.map((device) => (device.revokedAt === null ? { ...device, revokedAt: now } : device)))
      return revoked
    })
  }

  /** `lastSeenAt`/`lastIp` in memory on every request, on disk at most once a minute per device. */
  touch(deviceId: string, ip: string | null) {
    const device = this.get(deviceId)
    if (!device) return
    const now = this.#now()
    const updated = { ...device, lastSeenAt: now, lastIp: ip ?? device.lastIp }
    this.#devices = this.#devices.map((item) => (item.deviceId === deviceId ? updated : item))
    this.#dirty.add(deviceId)
    const persisted = this.#persistedSeen.get(deviceId) ?? 0
    if (now - persisted < TOUCH_PERSIST_MS) return
    this.#persistedSeen.set(deviceId, now)
    this.#dirty.delete(deviceId)
    void this.#mutex
      .run(async () => {
        const stat = await fs.stat(this.file).catch(() => undefined)
        if (stat?.mtimeMs !== this.#mtime) await this.#read()
        const latest = this.get(deviceId)
        if (!latest || latest.revokedAt !== null) return
        await this.#write(
          this.#devices.map((item) =>
            item.deviceId === deviceId ? { ...item, lastSeenAt: updated.lastSeenAt, lastIp: updated.lastIp } : item,
          ),
        )
      })
      .catch(() => undefined)
  }

  /** Saves the in-memory `lastSeenAt` values (gateway close). */
  async flush() {
    await this.#mutex
      .run(async () => {
        if (!this.#loaded || this.#dirty.size === 0) return
        this.#dirty.clear()
        const memory = new Map(this.#devices.map((device) => [device.deviceId, device]))
        await this.#read()
        const merged = this.#devices.map((device) => {
          const seen = memory.get(device.deviceId)
          return seen && (seen.lastSeenAt ?? 0) > (device.lastSeenAt ?? 0)
            ? { ...device, lastSeenAt: seen.lastSeenAt, lastIp: seen.lastIp }
            : device
        })
        await this.#write(merged)
      })
      .catch(() => undefined)
  }
}

function sameHash(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
