export * as Spool from "./spool.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Broker, OwnID } from "@own/protocol"
import { Fsx } from "@own/runtime"

/**
 * The remote observation spool (04 §10.2): `<OWN_HOME>/spool/obs-<streamId>.jsonl`, one {@link Broker.Item} per line,
 * `seq` strictly increasing within the stream. It is an event log, not the source of any session: losing it only
 * leaves a marked gap in the totals. Bounded by bytes, items and age; on overflow the oldest ledger/event items go
 * first, limit observations keep only the newest per window, and the dropped range becomes a `gap` item.
 */

export interface Limits {
  readonly bytes: number
  readonly items: number
  readonly ageMs: number
}

export const DEFAULT_LIMITS: Limits = { bytes: 20 * 1024 * 1024, items: 100_000, ageMs: 7 * 24 * 3600_000 }

const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(Broker.Item))
const decodeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ streamId: Schema.String, nextSeq: Schema.Int, ackThrough: Schema.Int })),
)

interface Entry {
  readonly item: Broker.Item
  readonly bytes: number
}

export class Store {
  readonly dir: string
  readonly #now: () => number
  readonly #limits: Limits
  #streamId = ""
  #nextSeq = 1
  #ackThrough = 0
  #entries: Entry[] = []
  #bytes = 0
  #gaps = 0
  #queue: Promise<void> = Promise.resolve()

  private constructor(dir: string, now: () => number, limits: Limits) {
    this.dir = dir
    this.#now = now
    this.#limits = limits
  }

  /** Opens (or creates) the spool of `dir`. A torn last line is dropped (04 §10.2). */
  static async open(input: { readonly dir: string; readonly now?: () => number; readonly limits?: Partial<Limits> }) {
    const spool = new Store(input.dir, input.now ?? Date.now, { ...DEFAULT_LIMITS, ...input.limits })
    await spool.#load()
    return spool
  }

  get streamId() {
    return this.#streamId
  }

  get file() {
    return path.join(this.dir, `obs-${this.#streamId}.jsonl`)
  }

  /** Appends one observation; the write is queued, the item is pending at once. */
  add(type: Broker.ItemType, payload: unknown): Broker.Item {
    const at = this.#now()
    const item: Broker.Item = {
      seq: this.#nextSeq++,
      eventId: OwnID.ulid(at),
      schemaVersion: Broker.ITEM_SCHEMA_VERSION,
      at,
      type,
      payload,
    }
    const line = JSON.stringify(item)
    const entry = { item, bytes: Buffer.byteLength(line) + 1 }
    this.#entries.push(entry)
    this.#bytes += entry.bytes
    if (this.#over()) this.#overflow()
    else this.#enqueue(() => fs.appendFile(this.file, `${line}\n`, { mode: 0o600 }))
    return item
  }

  /** Unacknowledged items in order, bounded like one `observe.push` (256 items, 512 KiB). */
  pending(maxItems: number = Broker.PUSH_MAX_ITEMS, maxBytes: number = Broker.PUSH_MAX_BYTES) {
    const batch: Broker.Item[] = []
    let bytes = 0
    for (const entry of this.#entries) {
      if (batch.length >= maxItems || (batch.length > 0 && bytes + entry.bytes > maxBytes)) break
      batch.push(entry.item)
      bytes += entry.bytes
    }
    return batch
  }

  /** The local side stored everything through `seq` (04 §10.3): drop it here. */
  async ack(through: number) {
    if (through <= this.#ackThrough) return
    this.#ackThrough = through
    const kept = this.#entries.filter((entry) => entry.item.seq > through)
    if (kept.length === this.#entries.length) return this.#saveState()
    this.#entries = kept
    this.#bytes = kept.reduce((sum, entry) => sum + entry.bytes, 0)
    this.#rewrite()
    await this.#queue
  }

  stats() {
    return { backlog: this.#entries.length, bytes: this.#bytes, gaps: this.#gaps }
  }

  /** Resolves once queued file writes are done. */
  flush() {
    return this.#queue
  }

  #over() {
    const oldest = this.#entries[0]
    return (
      this.#entries.length > this.#limits.items ||
      this.#bytes > this.#limits.bytes ||
      (oldest !== undefined && this.#now() - oldest.item.at > this.#limits.ageMs)
    )
  }

  /**
   * 04 §10.2 overflow: limit observations collapse to the newest per window, then the oldest other items are dropped
   * until the spool is back under 90 % of its bounds; one `gap` item (taking the first dropped `seq`) records them.
   */
  #overflow() {
    const now = this.#now()
    const seen = new Set<string>()
    const dropped: number[] = []
    // Newest first: an older limits item whose windows all have a newer observation is redundant.
    const keep = new Set<Entry>()
    for (const entry of [...this.#entries].reverse()) {
      if (entry.item.type !== "limits") {
        keep.add(entry)
        continue
      }
      const windows = windowsOf(entry.item.payload)
      const fresh = windows.some((id) => !seen.has(id))
      for (const id of windows) seen.add(id)
      if (fresh) keep.add(entry)
      else dropped.push(entry.item.seq)
    }
    let entries = this.#entries.filter((entry) => keep.has(entry))
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    const target = { items: Math.floor(this.#limits.items * 0.9), bytes: Math.floor(this.#limits.bytes * 0.9) }
    const tooOld = (entry: Entry) => now - entry.item.at > this.#limits.ageMs
    for (let index = 0; index < entries.length; ) {
      const entry = entries[index]!
      const over = entries.length > target.items || bytes > target.bytes || tooOld(entry)
      if (!over) break
      if (entry.item.type === "limits" && !tooOld(entry) && entries.some((other) => other.item.type !== "limits")) {
        index++
        continue
      }
      entries.splice(index, 1)
      bytes -= entry.bytes
      dropped.push(entry.item.seq)
    }
    if (dropped.length > 0) {
      const fromSeq = Math.min(...dropped)
      const toSeq = Math.max(...dropped)
      const gap: Broker.Item = {
        seq: fromSeq,
        eventId: OwnID.ulid(now),
        schemaVersion: Broker.ITEM_SCHEMA_VERSION,
        at: now,
        type: "gap",
        payload: { fromSeq, toSeq, count: dropped.length } satisfies Broker.GapPayload,
      }
      const line = JSON.stringify(gap)
      const entry = { item: gap, bytes: Buffer.byteLength(line) + 1 }
      entries = [...entries, entry].sort((a, b) => a.item.seq - b.item.seq)
      bytes += entry.bytes
      this.#gaps++
    }
    this.#entries = entries
    this.#bytes = bytes
    this.#rewrite()
  }

  #rewrite() {
    const text = this.#entries.map((entry) => JSON.stringify(entry.item)).join("\n")
    this.#enqueue(async () => {
      await Fsx.writeAtomic(this.file, text.length > 0 ? `${text}\n` : "")
      await this.#writeState()
    })
  }

  #saveState() {
    this.#enqueue(() => this.#writeState())
    return this.#queue
  }

  #writeState() {
    return Fsx.writeAtomic(
      path.join(this.dir, "state.json"),
      `${JSON.stringify({ streamId: this.#streamId, nextSeq: this.#nextSeq, ackThrough: this.#ackThrough })}\n`,
    )
  }

  #enqueue(run: () => Promise<unknown>) {
    this.#queue = this.#queue.then(run).then(
      () => undefined,
      () => undefined,
    )
  }

  async #load() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const stateText = await Fsx.readText(path.join(this.dir, "state.json")).catch(() => undefined)
    const state = stateText === undefined ? undefined : Option.getOrUndefined(decodeState(stateText))
    if (state && /^[0-9a-f]{8,64}$/.test(state.streamId)) {
      this.#streamId = state.streamId
      this.#nextSeq = Math.max(1, state.nextSeq)
      this.#ackThrough = Math.max(0, state.ackThrough)
    } else {
      // One stream per remote install (04 §10.2).
      this.#streamId = randomBytes(8).toString("hex")
      await this.#writeState()
    }
    const text = (await Fsx.readText(this.file).catch(() => undefined)) ?? ""
    const entries: Entry[] = []
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue
      const item = Option.getOrUndefined(decodeItem(line))
      if (!item || item.seq <= this.#ackThrough) continue
      entries.push({ item, bytes: Buffer.byteLength(line) + 1 })
    }
    entries.sort((a, b) => a.item.seq - b.item.seq)
    this.#entries = entries
    this.#bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    this.#nextSeq = Math.max(this.#nextSeq, (entries.at(-1)?.item.seq ?? 0) + 1)
    this.#gaps = entries.filter((entry) => entry.item.type === "gap").length
  }
}

function windowsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || !("windows" in payload) || !Array.isArray(payload.windows))
    return []
  return payload.windows.flatMap((window: unknown) =>
    typeof window === "object" && window !== null && "accountID" in window && "id" in window
      ? [`${String(window.accountID)}\u0000${String(window.id)}`]
      : [],
  )
}
