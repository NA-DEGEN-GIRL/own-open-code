export * as LedgerWriter from "./ledger-writer.js"

import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { gunzip, gzip } from "node:zlib"
import { Option, Schema } from "effect"
import { Ledger } from "@own/protocol"
import { code, remove, writeAtomic } from "./fsx.js"
import { month } from "./home.js"
import { Mutex } from "./lock.js"
import { Redact } from "./redact.js"

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** `usage-YYYY-MM.jsonl` holds {@link Ledger.Line}s, `events-YYYY-MM.jsonl` holds {@link Event}s (02 §2.3). */
export type Kind = "usage" | "events"

/** Months of raw ledger files kept (01 §5.1 "원본 12개월 보존"). */
export const RETENTION_MONTHS = 12

/** Usage months kept decoded for the process: the current one and the previous one (by `now`). */
export const RECENT_MONTHS = 2

/** Longest synchronous stretch of decoding while reading a month before it yields to the event loop. */
export const SLICE_MS = 10

/**
 * One line of `events-YYYY-MM.jsonl`: switches, alerts, logins, exhaustion (02 §2.3). The envelope is ours; `type`
 * is open (`switch`, `alert`, `login`, `exhaustion`, `refresh`, `import`, …) and `data` is redacted before writing.
 */
export const Event = Schema.Struct({
  v: Schema.Literal(1),
  /** Idempotency key (01 §4 "줄마다 이벤트 id"). */
  eid: Schema.String,
  ts: Schema.Finite,
  type: Schema.String,
  accountID: Schema.optionalKey(Schema.NullOr(Schema.String)),
  providerID: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sessionID: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Own.Runtime.LedgerEvent" })
export type Event = typeof Event.Type

export type EventInput = Omit<Event, "v" | "ts"> & { readonly ts?: number }

/** A usage line as stored: the protocol line plus its event id. */
export interface UsageEntry {
  readonly eid: string
  readonly line: Ledger.Line
}

export type Outcome = "written" | "duplicate"

export interface Options {
  /** `OWN_HOME\ledger`. */
  readonly dir: string
  readonly now?: () => number
  /** Event ids remembered per process for de-duplication. Default 50 000. */
  readonly memory?: number
  /** Bytes read from the end of a file to learn the ids already written there. Default 512 KiB. */
  readonly tailBytes?: number
}

interface Recent {
  /** Sorted by `ts`, then `eid`. */
  readonly entries: UsageEntry[]
  readonly eids: Set<string>
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeEid = Schema.decodeUnknownOption(Schema.Struct({ eid: Schema.String }))
const decodeLine = Schema.decodeUnknownOption(Ledger.Line)
const decodeEvent = Schema.decodeUnknownOption(Event)
const FILE = /^(usage|events)-(\d{4})-(\d{2})\.jsonl(\.gz)?$/

/**
 * The process's single ledger writer (01 §4, 02 §7.5), shared by both plugins through the runtime singleton.
 * Appends are serialized; every line carries an event id, and an id already written (by another Location's
 * duplicate subscription, or before a restart, found by scanning the file's tail) is skipped. Lines are partitioned
 * by the UTC month of their `ts`. Content and token values are never part of a line.
 */
export class Writer {
  readonly #dir: string
  readonly #now: () => number
  readonly #memory: number
  readonly #tailBytes: number
  readonly #mutex = new Mutex()
  readonly #seen = new Map<string, true>()
  readonly #scanned = new Set<string>()
  readonly #recent = new Map<string, Promise<Recent>>()

  constructor(options: Options) {
    this.#dir = options.dir
    this.#now = options.now ?? Date.now
    this.#memory = options.memory ?? 50_000
    this.#tailBytes = options.tailBytes ?? 512 * 1024
  }

  file(kind: Kind, yearMonth: string) {
    return path.join(this.#dir, `${kind}-${yearMonth}.jsonl`)
  }

  /** Appends a usage line (02 §7.5) once per `eid`, typically the id of the step event it was built from. */
  async usage(eid: string, line: Ledger.Line) {
    const outcome = await this.#append("usage", eid, line.ts, JSON.stringify({ eid, ...line }))
    // Queued behind the month's first read, which may already have found the line on disk.
    if (outcome === "written") void this.#recent.get(month(line.ts))?.then((recent) => insert(recent, { eid, line }))
    return outcome
  }

  /** Appends a switch/alert/login/exhaustion event once per `eid`. `data` is redacted as defense in depth. */
  event(input: EventInput) {
    const event: Event = {
      v: 1,
      eid: input.eid,
      ts: input.ts ?? this.#now(),
      type: input.type,
      ...(input.accountID === undefined ? {} : { accountID: input.accountID }),
      ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
      ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
      ...(input.data === undefined ? {} : { data: Redact.record(input.data) }),
    }
    return this.#append("events", event.eid, event.ts, JSON.stringify(event))
  }

  /** Resolves once every append issued so far is on disk (OS buffers; appends are not fsynced). */
  flush() {
    return this.#mutex.run(() => Promise.resolve())
  }

  /**
   * Usage lines of a month in file order, from both the plain and the gzipped file, de-duplicated by `eid`. A month
   * that cannot be read reads as empty, like a missing one: callers on the step-end path must not fail on an old file.
   */
  usageOf(yearMonth: string): Promise<UsageEntry[]> {
    return this.#usage(yearMonth).catch(() => [])
  }

  /** Events of a month, de-duplicated by `eid`; an unreadable month reads as empty. */
  eventsOf(yearMonth: string): Promise<Event[]> {
    return this.#read("events", yearMonth, (value) => decodeEvent(value)).catch(() => [])
  }

  /**
   * Usage lines of a month, oldest first (by `ts`, then `eid`). The {@link RECENT_MONTHS} newest months are decoded once
   * per process and kept current by {@link usage}, so every Location shares one copy; older months are read each time.
   * This relies on every usage line being appended through this writer ({@link maintain} only moves them into `.gz`).
   */
  async usageSorted(yearMonth: string): Promise<UsageEntry[]> {
    const current = index(month(this.#now()))
    const recent = (key: string) => {
      const age = current - index(key)
      return age >= 0 && age < RECENT_MONTHS
    }
    if (!recent(yearMonth)) return sort(await this.usageOf(yearMonth))
    for (const key of this.#recent.keys()) if (!recent(key)) this.#recent.delete(key)
    const cached = this.#recent.get(yearMonth)
    if (cached) return (await cached).entries.slice()
    // A failed read is not kept: its callers see no lines, and the next call reads the files again.
    const decoding: Promise<Recent> = this.#usage(yearMonth).then(
      (entries) => ({ entries: sort(entries), eids: new Set(entries.map((entry) => entry.eid)) }),
      () => {
        if (this.#recent.get(yearMonth) === decoding) this.#recent.delete(yearMonth)
        return { entries: [], eids: new Set<string>() }
      },
    )
    this.#recent.set(yearMonth, decoding)
    return (await decoding).entries.slice()
  }

  /**
   * Gzips the files of past months into `<name>.jsonl.gz` (appending a gzip member when one exists already) and
   * deletes files older than {@link RETENTION_MONTHS} (01 §5.1). Only the leader instance should call this.
   */
  maintain() {
    return this.#mutex.run(async () => {
      const current = index(month(this.#now()))
      const names = await fs.readdir(this.#dir).catch(() => [])
      const compressed: string[] = []
      const removed: string[] = []
      for (const name of names) {
        const match = FILE.exec(name)
        if (!match) continue
        const age = current - (Number(match[2]) * 12 + Number(match[3]) - 1)
        const file = path.join(this.#dir, name)
        if (age > RETENTION_MONTHS) {
          await remove(file)
          removed.push(name)
          continue
        }
        if (age <= 0 || match[4]) continue
        const gz = `${file}.gz`
        const existing = await fs.readFile(gz).catch(() => Buffer.alloc(0))
        const member = await gzipAsync(await fs.readFile(file))
        await writeAtomic(gz, Buffer.concat([existing, member]))
        await remove(file)
        this.#scanned.delete(file)
        compressed.push(name)
      }
      return { compressed, removed }
    })
  }

  #usage(yearMonth: string) {
    return this.#read("usage", yearMonth, (value, eid) => Option.map(decodeLine(value), (line) => ({ eid, line })))
  }

  #append(kind: Kind, eid: string, ts: number, text: string): Promise<Outcome> {
    return this.#mutex.run(async () => {
      const file = this.file(kind, month(ts))
      const id = `${kind}:${eid}`
      await this.#learn(kind, file)
      if (this.#seen.has(id)) return "duplicate"
      await fs.mkdir(this.#dir, { recursive: true })
      await fs.appendFile(file, `${text}\n`, { encoding: "utf8", mode: 0o600 })
      this.#remember(id)
      return "written"
    })
  }

  // Ids written before this process started live only in the file; scan its tail once.
  async #learn(kind: Kind, file: string) {
    if (this.#scanned.has(file)) return
    this.#scanned.add(file)
    const handle = await fs.open(file, "r").catch((error: unknown) => {
      if (code(error) === "ENOENT") return undefined
      throw error
    })
    if (!handle) return
    const text = await (async () => {
      const size = (await handle.stat()).size
      const length = Math.min(size, this.#tailBytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      return buffer.toString("utf8")
    })().finally(() => handle.close())
    for (const line of text.split("\n")) {
      const value = Option.getOrUndefined(decodeJson(line))
      const eid = value === undefined ? undefined : Option.getOrUndefined(decodeEid(value))?.eid
      if (eid !== undefined) this.#remember(`${kind}:${eid}`)
    }
  }

  #remember(id: string) {
    this.#seen.set(id, true)
    if (this.#seen.size <= this.#memory) return
    const oldest = this.#seen.keys().next().value
    if (oldest !== undefined) this.#seen.delete(oldest)
  }

  // Each line is parsed once and its eid decoded once; only the first line of an eid gets the full decode.
  async #read<A>(kind: Kind, yearMonth: string, decode: (value: unknown, eid: string) => Option.Option<A>) {
    const file = this.file(kind, yearMonth)
    // The plain file first: `maintain` copies its lines into the `.gz` before deleting it, so a run in between can only
    // repeat lines (dropped by `eid` below), never lose them. Only a missing file reads as empty; any other error
    // fails the read rather than return part of the month.
    const plain = await fs.readFile(file, "utf8").catch(missing)
    const packed = await fs.readFile(`${file}.gz`).catch(missing)
    const gz = packed === undefined ? "" : (await gunzipAsync(packed)).toString("utf8")
    const lines = `${gz}\n${plain ?? ""}`.split("\n")
    const seen = new Set<string>()
    const values: A[] = []
    const slice = { start: performance.now() }
    for (const [index, line] of lines.entries()) {
      // A heavy month holds tens of thousands of lines; one synchronous pass would stall every session's stream.
      if (index % 64 === 0 && performance.now() - slice.start > SLICE_MS) {
        await new Promise((resolve) => setImmediate(resolve))
        slice.start = performance.now()
      }
      // A crash can leave a partial last line; it fails to parse and is skipped.
      const value = Option.getOrUndefined(decodeJson(line))
      const eid = value === undefined ? undefined : Option.getOrUndefined(decodeEid(value))?.eid
      if (eid === undefined || seen.has(eid)) continue
      seen.add(eid)
      const decoded = decode(value, eid)
      if (Option.isSome(decoded)) values.push(decoded.value)
    }
    return values
  }
}

function missing(error: unknown): undefined {
  if (code(error) === "ENOENT") return undefined
  throw error
}

function index(yearMonth: string) {
  return Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(5, 7)) - 1
}

function sort(entries: ReadonlyArray<UsageEntry>) {
  return entries.toSorted(compare)
}

function compare(a: UsageEntry, b: UsageEntry) {
  return a.line.ts - b.line.ts || a.eid.localeCompare(b.eid)
}

function insert(recent: Recent, entry: UsageEntry) {
  if (recent.eids.has(entry.eid)) return
  recent.eids.add(entry.eid)
  // Lines are appended in time order almost always, so the search from the end stops at once.
  recent.entries.splice(recent.entries.findLastIndex((other) => compare(other, entry) <= 0) + 1, 0, entry)
}
