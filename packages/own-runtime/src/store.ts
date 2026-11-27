export * as Store from "./store.js"

import { Option, Schema } from "effect"
import type { Account } from "@own/protocol"
import { CodexModels, Policy, Preserve, Preset, Ratecard, Registry, Voice } from "@own/protocol"
import { readText, writeAtomic } from "./fsx.js"
import type { Layout } from "./home.js"
import { Mutex, withFile, type FileOptions } from "./lock.js"

/** A registry file exists but cannot be used. It is never overwritten automatically, so nothing is lost. */
export class StoreError extends Error {
  constructor(
    readonly file: string,
    readonly reason: "parse_failed" | "invalid",
    detail: string,
  ) {
    super(`${file}: ${reason}: ${detail}`)
    this.name = "Store.StoreError"
  }
}

export interface JsonFileOptions<S extends Schema.Codec<unknown, unknown>> {
  readonly file: string
  readonly schema: S
  /** Value used when the file does not exist yet. */
  readonly fallback: () => S["Type"] | Promise<S["Type"]>
  /** Cross-process lease taken around every write (`locks\registry.lock`). */
  readonly lock?: string
  readonly lockOptions?: FileOptions
  /** In-process mutex; files that share one lock file should share one mutex. */
  readonly mutex?: Mutex
  /**
   * Applied to every value read from the file (not the fallback), before {@link JsonFile.read} returns it or
   * {@link JsonFile.update} hands it to its change: an older shape is upgraded before anything is decided on it. The
   * file keeps the older shape until a change writes it.
   */
  readonly normalize?: (value: S["Type"]) => S["Type"]
  /** Applied to every changed value before it is written, e.g. to bump `revision`. */
  readonly beforeWrite?: (previous: S["Type"], next: S["Type"]) => S["Type"]
}

/**
 * One JSON file owned by the runtime (02 §2.3 "파일 쓰기 규칙"). Decoded and encoded with
 * `Preserve` (keeping undeclared keys), so fields written by a newer build survive a rewrite by an older one. Writes are
 * read-modify-write under an in-process mutex and the cross-process lock, then temp → fsync → rename.
 */
export class JsonFile<S extends Schema.Codec<unknown, unknown>> {
  readonly #options: JsonFileOptions<S>
  readonly #mutex: Mutex
  readonly #decode: (input: unknown) => Option.Option<S["Type"]>
  readonly #encode: (input: S["Type"]) => unknown
  #cached: S["Type"] | undefined
  #writing: S["Type"] | undefined

  constructor(options: JsonFileOptions<S>) {
    this.#options = options
    this.#mutex = options.mutex ?? new Mutex()
    this.#decode = Preserve.decode(options.schema)
    this.#encode = Preserve.encode(options.schema)
  }

  get file() {
    return this.#options.file
  }

  /** The value last read or written by this process, without touching the disk. */
  cached() {
    return this.#cached
  }

  /**
   * The value {@link update} is writing now, from before its rename until the write returns. A file watcher can wake
   * on the rename before that continuation runs (on a busy loop), while {@link cached} still has the value before it.
   */
  writing() {
    return this.#writing
  }

  /** Reads the file, or the fallback when it does not exist. Throws {@link StoreError} for unusable content. */
  async read(): Promise<S["Type"]> {
    const text = await readText(this.#options.file)
    const normalize = this.#options.normalize ?? ((value: S["Type"]) => value)
    const value = text === undefined ? await this.#options.fallback() : normalize(this.#parse(text))
    this.#cached = value
    return value
  }

  /** Replaces the whole file. */
  write(value: S["Type"]) {
    return this.update(() => value)
  }

  /**
   * Re-reads the file under the locks, applies `change`, and writes the result. Returning `undefined` (or the same
   * object) from `change` leaves the file untouched.
   */
  update(change: (current: S["Type"]) => S["Type"] | undefined): Promise<S["Type"]> {
    return this.#mutex.run(() =>
      this.#locked(async () => {
        const current = await this.read()
        const changed = change(current)
        if (changed === undefined || changed === current) return current
        const next = this.#options.beforeWrite ? this.#options.beforeWrite(current, changed) : changed
        // Known from before the rename, so a watcher woken by it tells this process's own write from another's.
        this.#writing = next
        await writeAtomic(this.#options.file, `${JSON.stringify(this.#encode(next), null, 2)}\n`).finally(() => {
          this.#writing = undefined
        })
        this.#cached = next
        return next
      }),
    )
  }

  #locked<T>(section: () => Promise<T>) {
    if (!this.#options.lock) return section()
    return withFile(this.#options.lock, section, this.#options.lockOptions)
  }

  #parse(text: string): S["Type"] {
    const json = Option.getOrUndefined(decodeJson(text))
    if (json === undefined) throw new StoreError(this.#options.file, "parse_failed", "not JSON")
    const value = this.#decode(json)
    if (Option.isNone(value)) throw new StoreError(this.#options.file, "invalid", "does not match its schema")
    return value.value
  }
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** An `accounts.json` with nothing registered yet. */
export function emptyRegistry(): Registry.File {
  return {
    schemaVersion: Registry.SCHEMA_VERSION,
    revision: 0,
    cacheDomains: {},
    quotaDomains: {},
    accounts: [],
    slots: {},
    modelTemplates: {},
  }
}

/** Shared by the registry files so writes from one process never contend on the lock file with each other. */
export interface Shared {
  readonly layout: Layout
  readonly mutex: Mutex
  readonly lockOptions?: FileOptions
}

/** `accounts.json` (02 §2.4.1). Every write bumps `revision`. */
export function accounts(shared: Shared) {
  return new JsonFile({
    file: shared.layout.accounts,
    schema: Registry.File,
    fallback: emptyRegistry,
    lock: shared.layout.registryLock,
    lockOptions: shared.lockOptions,
    mutex: shared.mutex,
    beforeWrite: (previous, next) => ({ ...next, revision: previous.revision + 1 }),
  })
}

/** `policy.json` (02 §2.4.3). Built-in defaults until the first write. */
export function policy(shared: Shared) {
  return new JsonFile({
    file: shared.layout.policy,
    schema: Policy.File,
    fallback: (): Policy.File => Policy.defaults,
    lock: shared.layout.registryLock,
    lockOptions: shared.lockOptions,
    mutex: shared.mutex,
  })
}

/**
 * `ratecards.json` (02 §2.4.4). When it does not exist, the seed (`app\<version>\templates\ratecards.default.json`, or
 * `own/config/ratecards.default.json` in development) is decoded instead; without a seed there are no cards.
 */
export function ratecards(shared: Shared, seed = shared.layout.ratecardsSeed) {
  const decodeSeed = Schema.decodeUnknownOption(Schema.fromJsonString(Ratecard.File))
  return new JsonFile({
    file: shared.layout.ratecards,
    schema: Ratecard.File,
    fallback: async (): Promise<Ratecard.File> => {
      const text = await readText(seed)
      const decoded = text === undefined ? undefined : Option.getOrUndefined(decodeSeed(text))
      return decoded ?? { schemaVersion: 1, updatedAt: "1970-01-01", cards: [] }
    },
    lock: shared.layout.registryLock,
    lockOptions: shared.lockOptions,
    mutex: shared.mutex,
  })
}

/** `trust.json`: project plugin approvals (02 §2.3, 01 §13.2). */
export function trust(shared: Shared) {
  return new JsonFile({
    file: shared.layout.trust,
    schema: Registry.TrustFile,
    fallback: (): Registry.TrustFile => [],
    lock: shared.layout.registryLock,
    lockOptions: shared.lockOptions,
    mutex: shared.mutex,
  })
}

/**
 * `presets.json` (07 §8.1): no presets until the first write. Kept apart from `accounts.json` so changing a preset
 * never re-registers providers. A version 1 file is read, and written, as version 2 (`Preset.upgrade`).
 */
export function presets(shared: Shared) {
  return new JsonFile({
    file: shared.layout.presets,
    schema: Preset.File,
    fallback: Preset.empty,
    normalize: Preset.upgrade,
    beforeWrite: (_, next) => Preset.upgrade(next),
    lock: shared.layout.registryLock,
    lockOptions: shared.lockOptions,
    mutex: shared.mutex,
  })
}

/**
 * `voice.json` (02 §3.9): voice input settings and usage minutes, the defaults (off) until the first write. Kept apart
 * from `policy.json` because every recognition adds to its usage. No secrets: the keys are vault items.
 */
export function voice(shared: Shared) {
  return new JsonFile({
    file: shared.layout.voice,
    schema: Voice.File,
    fallback: (): Voice.File => Voice.defaults,
    lock: shared.layout.registryLock,
    lockOptions: shared.lockOptions,
    mutex: shared.mutex,
  })
}

/**
 * `codex-meta.json` (07 §4.5): the Codex model metadata own-accounts fetched, one snapshot per kind; nothing until the
 * first fetch. A cache with one writer (the instance that fetched), so it takes no lock: the atomic rename keeps the
 * file whole, and two writers would each write a whole fetched list. Like every store an unusable file is never
 * overwritten; the fetched list then stays in memory.
 */
export function codexMeta(layout: Pick<Layout, "codexMeta">) {
  return new JsonFile({ file: layout.codexMeta, schema: CodexModels.File, fallback: CodexModels.empty })
}

/** The live (not retired) account that owns an own slot, for hot-path lookups by provider id. */
export function accountFor(registry: Registry.File, providerID: string): Account.Info | undefined {
  return registry.accounts.find((account) => account.providerID === providerID && account.status !== "retired")
}
