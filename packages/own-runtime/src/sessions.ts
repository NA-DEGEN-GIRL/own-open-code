export * as Sessions from "./sessions.js"

import { Option, Schema } from "effect"
import { readText, writeAtomic } from "./fsx.js"

/**
 * Process-wide session → slot index (02 §9.2 `accounts.list.sessions`, `accounts.remove.plan.affectedSessions`,
 * `compactionImpact`). Account RPCs run in the control Location while sessions live in their own Locations, so the
 * instance of each session's Location writes what it observes here and every instance reads it. Only facts, no
 * content: provider/model binding, busy flag, last measured context `P`, staged revert, parent. Persisted to
 * `state\sessions.json` (leader saves) so bindings survive a restart; sessions never seen since the index existed are
 * unknown until their next event.
 */

export interface Entry {
  readonly sessionID: string
  readonly directory: string | null
  readonly parentID: string | null
  /** The session's current model binding (`model.selected`, `session.created`, a session lookup). */
  readonly providerID: string | null
  readonly modelID: string | null
  readonly variant: string | null
  /** An execution is running. Never persisted as `true`: a restarted process has nothing running. */
  readonly busy: boolean
  /** Last step's `input + cache.read + cache.write + output + reasoning` (02 §4.7.4 `P`). */
  readonly P: number | null
  readonly revertStaged: boolean
  readonly updatedAt: number
}

export type Patch = Partial<Omit<Entry, "sessionID" | "updatedAt">>

/** Entries kept (most recently updated first); older ones are forgotten. */
export const MAX_ENTRIES = 20_000

const Stored = Schema.Struct({
  sessionID: Schema.String,
  directory: Schema.NullOr(Schema.String),
  parentID: Schema.NullOr(Schema.String),
  providerID: Schema.NullOr(Schema.String),
  modelID: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
  P: Schema.NullOr(Schema.Finite),
  revertStaged: Schema.Boolean,
  updatedAt: Schema.Finite,
})

const SnapshotFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  savedAt: Schema.Finite,
  sessions: Schema.Array(Stored),
})

const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(SnapshotFile))

export class Index {
  readonly #file: string
  readonly #now: () => number
  readonly #max: number
  readonly #entries = new Map<string, Entry>()
  #dirty = false

  constructor(options: { readonly file: string; readonly now?: () => number; readonly max?: number }) {
    this.#file = options.file
    this.#now = options.now ?? Date.now
    this.#max = options.max ?? MAX_ENTRIES
  }

  get(sessionID: string) {
    return this.#entries.get(sessionID)
  }

  /** Merges `patch` into the session's entry (creating it) and returns the new entry. */
  update(sessionID: string, patch: Patch): Entry {
    const previous = this.#entries.get(sessionID)
    const next: Entry = {
      sessionID,
      directory: null,
      parentID: null,
      providerID: null,
      modelID: null,
      variant: null,
      busy: false,
      P: null,
      revertStaged: false,
      ...previous,
      ...defined(patch),
      updatedAt: this.#now(),
    }
    // Re-inserted so iteration order is least recently updated first.
    this.#entries.delete(sessionID)
    this.#entries.set(sessionID, next)
    this.#dirty = this.#dirty || persisted(previous) !== persisted(next)
    this.#trim()
    return next
  }

  remove(sessionID: string) {
    if (this.#entries.delete(sessionID)) this.#dirty = true
  }

  /** Entries, optionally only those bound to one provider id. */
  list(filter: { readonly providerID?: string } = {}) {
    return [...this.#entries.values()].filter(
      (entry) => filter.providerID === undefined || entry.providerID === filter.providerID,
    )
  }

  /** `accounts.list` `sessions` of one provider id. */
  counts(providerID: string) {
    const bound = this.list({ providerID })
    return { running: bound.filter((entry) => entry.busy).length, total: bound.length }
  }

  children(parentID: string) {
    return [...this.#entries.values()].filter((entry) => entry.parentID === parentID)
  }

  /** Loads `state\sessions.json`; a missing or unreadable file starts empty (it is a cache of observations). */
  async load() {
    const text = await readText(this.#file).catch(() => undefined)
    const snapshot = text === undefined ? undefined : Option.getOrUndefined(decodeSnapshot(text))
    if (!snapshot) return false
    for (const stored of snapshot.sessions)
      if (!this.#entries.has(stored.sessionID)) this.#entries.set(stored.sessionID, { ...stored, busy: false })
    this.#trim()
    this.#dirty = false
    return true
  }

  /** Writes `state\sessions.json` when something persistent changed since the last save or load. */
  async save() {
    if (!this.#dirty) return false
    this.#dirty = false
    const snapshot = {
      schemaVersion: 1 as const,
      savedAt: this.#now(),
      sessions: [...this.#entries.values()].map((entry) => stored(entry)),
    }
    await writeAtomic(this.#file, `${JSON.stringify(snapshot)}\n`).catch((error: unknown) => {
      this.#dirty = true
      throw error
    })
    return true
  }

  #trim() {
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) return
      this.#entries.delete(oldest)
      this.#dirty = true
    }
  }
}

function defined(patch: Patch): Patch {
  return Object.fromEntries(Object.entries(patch).filter((entry) => entry[1] !== undefined))
}

function stored(entry: Entry) {
  return {
    sessionID: entry.sessionID,
    directory: entry.directory,
    parentID: entry.parentID,
    providerID: entry.providerID,
    modelID: entry.modelID,
    variant: entry.variant,
    P: entry.P,
    revertStaged: entry.revertStaged,
    updatedAt: entry.updatedAt,
  }
}

/** The persisted part of an entry (busy and the update time are not worth a write). */
function persisted(entry: Entry | undefined) {
  if (!entry) return ""
  const { updatedAt: _updatedAt, busy: _busy, ...rest } = entry
  return JSON.stringify(rest)
}
