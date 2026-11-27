export * as LegacyKey from "./legacy-key.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Credential, type Kind, type OwnError } from "@own/protocol"
import { readBounded } from "./fsx.js"
import { keyHint, short } from "./hash.js"
import { LINKED_MAX_FILE_BYTES, linkedPathProblem, type Client } from "./vault.js"

// API keys saved by the older codex-multi-provider app, linked by reference (02 §3.2b). The old app keeps every key
// as a DPAPI file (CurrentUser, no entropy) at a location derived from its `credential_ref`:
//   legacy:deepseek      <app>\profiles\deepseek.dpapi                          (+ <app>\profiles\provider.json)
//   dpapi:<providerId>   <app>\work\control-center\credentials\<providerId>.dpapi (+ ...\providers.json registry)
// We store only that reference. The file is decrypted in memory by own-vault `linked.get` when a request needs the
// key, re-read when it changes or after a 401, and never written, copied or re-encrypted.

/** The old app's root on this user's PC (the parent of `work\control-center`, `CodexSource.DEFAULT_CONTROL_CENTER`). */
export const DEFAULT_APP_ROOT = "D:\\#Projects\\codex-multi-provider"

/** `providers.json` larger than this is not read (the old app's registry is a few KiB). */
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024

/** A usable key is at most this long, like `accounts.add.key`. */
export const MAX_KEY_CHARS = 8_192

/** Why a linked key cannot be used right now. `vault_unavailable`: own-vault.exe cannot be reached. */
export type Problem = OwnError.LegacyKeyProblem | "vault_unavailable"

/**
 * The old app's root for a codex import control center `<root>\work\control-center` (plugin option
 * `codexImportRoot`, tests point it at a temp copy). `undefined` when the control center is not laid out like that
 * or the root is not a `codex-multi-provider` directory (own-vault would refuse its key files).
 */
export function appRootOf(controlCenter: string) {
  const resolved = path.resolve(controlCenter)
  const work = path.dirname(resolved)
  const root = path.dirname(work)
  const named = (dir: string, name: string) => path.basename(dir).toLowerCase() === name
  if (!named(resolved, "control-center") || !named(work, "work") || !named(root, "codex-multi-provider"))
    return undefined
  return root
}

/** The key file of a credential ref, as the old app's `_secret_path` resolves it. */
export function keyPath(appRoot: string, providerRef: Credential.LegacyProviderRef) {
  if (providerRef === "legacy:deepseek") return path.join(appRoot, "profiles", "deepseek.dpapi")
  return path.join(appRoot, "work", "control-center", "credentials", `${providerRef.slice("dpapi:".length)}.dpapi`)
}

const KIND_BY_HOST: Readonly<Record<string, Kind.Api>> = {
  "api.deepseek.com": "ds",
  "api.openai.com": "oai",
  "api.anthropic.com": "anth",
  "api.x.ai": "xai",
  "openrouter.ai": "or",
}

/**
 * The own kind for an old-app provider: the provider's official API host decides (the kind brings its own endpoint
 * and wire format); any other HTTPS endpoint is `compat` only when the old app spoke Chat Completions to it.
 */
export function kindOf(baseURL: string | null, protocol: string | null): Kind.Api | undefined {
  if (!baseURL || !URL.canParse(baseURL)) return undefined
  const url = new URL(baseURL)
  if (url.protocol !== "https:") return undefined
  const known = KIND_BY_HOST[url.hostname.toLowerCase()]
  if (known) return known
  return protocol === "chat_completions" ? "compat" : undefined
}

export interface Model {
  readonly id: string
  /** The old app's context window, when it recorded one (`compat` needs it, 02 §3.3 step 6). */
  readonly contextLimit?: number
}

/** One API-key provider saved by the old app. No key, and nothing decrypted. */
export interface Candidate {
  readonly providerRef: Credential.LegacyProviderRef
  readonly name: string | null
  readonly kind: Kind.Api | undefined
  readonly baseURL: string | null
  readonly protocol: string | null
  readonly models: ReadonlyArray<Model>
  /** The reference an account stores (`Credential.LinkedLegacyKey.source`). */
  readonly source: Credential.LegacyKeySource
  /** The key file exists as a plain file of at most 16 KiB. */
  readonly keySaved: boolean
  /** Why it cannot be linked; `undefined` when it can. */
  readonly problem?: OwnError.LegacyKeyProblem
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeRegistry = Schema.decodeUnknownOption(Credential.LegacyProvidersFile)
const decodeLegacy = Schema.decodeUnknownOption(Credential.LegacyProviderFile)
const isProviderRef = Schema.is(Credential.LegacyProviderRef)

/**
 * The old app's saved API-key providers. Reads `work\control-center\providers.json` (the manager's registry), or,
 * before the manager wrote one, `profiles\provider.json` (its first DeepSeek connection, `credential_ref`
 * `legacy:deepseek`), the same fallback as the old app's `ProviderRegistry._legacy`. Only non-secret fields are
 * read; key files are only `lstat`ed. `available: false` when neither file can be read.
 */
export async function list(
  appRoot: string,
): Promise<{ readonly available: boolean; readonly candidates: Candidate[] }> {
  const entries = (await registryEntries(appRoot)) ?? (await legacyEntries(appRoot))
  if (!entries) return { available: false, candidates: [] }
  const seen = new Set<string>()
  const unique = entries.filter((entry) => !seen.has(entry.providerRef) && seen.add(entry.providerRef))
  return { available: true, candidates: await Promise.all(unique.map((entry) => candidate(appRoot, entry))) }
}

interface Entry {
  readonly providerRef: Credential.LegacyProviderRef
  readonly name: string | null
  readonly baseURL: string | null
  readonly protocol: string | null
  readonly models: ReadonlyArray<Model>
}

async function registryEntries(appRoot: string): Promise<Entry[] | undefined> {
  const file = await readBounded(path.join(appRoot, "work", "control-center", "providers.json"), MAX_REGISTRY_BYTES)
  const json = file.type === "ok" ? Option.getOrUndefined(decodeJson(file.text)) : undefined
  const registry = json === undefined ? undefined : Option.getOrUndefined(decodeRegistry(json))
  if (!registry) return undefined
  return registry.providers.flatMap((provider): Entry[] => {
    const ref = provider.credential_ref ?? `dpapi:${provider.id}`
    // The old app accepts only `legacy:deepseek` or `dpapi:<its own id>`; anything else is not a key it saved.
    if (!isProviderRef(ref) || (ref !== "legacy:deepseek" && ref !== `dpapi:${provider.id}`)) return []
    const models = (registry.models ?? [])
      .filter((model) => model.provider_id === provider.id)
      .flatMap((model): Model[] => {
        const id = model.wire_model_id ?? model.name
        if (!id) return []
        const context = model.capabilities?.context_window
        return [{ id, ...(typeof context === "number" && context > 0 ? { contextLimit: context } : {}) }]
      })
    return [
      {
        providerRef: ref,
        name: provider.name ?? null,
        baseURL: provider.base_url ?? null,
        protocol: provider.protocol ?? null,
        models,
      },
    ]
  })
}

async function legacyEntries(appRoot: string): Promise<Entry[] | undefined> {
  const file = await readBounded(path.join(appRoot, "profiles", "provider.json"), MAX_REGISTRY_BYTES)
  const json = file.type === "ok" ? Option.getOrUndefined(decodeJson(file.text)) : undefined
  const legacy = json === undefined ? undefined : Option.getOrUndefined(decodeLegacy(json))
  if (!legacy) return undefined
  return [
    {
      providerRef: "legacy:deepseek",
      name: "DeepSeek",
      baseURL: legacy.base_url ?? null,
      protocol: legacy.protocol ?? "responses",
      // The old app's first DeepSeek setup recorded a 1M context for its model (`ProviderRegistry._legacy`).
      models: legacy.model ? [{ id: legacy.model }] : [],
    },
  ]
}

async function candidate(appRoot: string, entry: Entry): Promise<Candidate> {
  const file = keyPath(appRoot, entry.providerRef)
  const stat = await fs.lstat(file).catch(() => undefined)
  const keySaved = stat !== undefined && stat.isFile() && stat.size <= LINKED_MAX_FILE_BYTES
  const kind = kindOf(entry.baseURL, entry.protocol)
  const compatReady = kind !== "compat" || entry.models.some((model) => model.contextLimit !== undefined)
  const problem: OwnError.LegacyKeyProblem | undefined =
    kind === undefined || !compatReady
      ? "unsupported_provider"
      : linkedPathProblem(file) !== undefined
        ? "path_denied"
        : !stat
          ? "not_found"
          : !keySaved
            ? "path_denied"
            : undefined
  return {
    ...entry,
    kind,
    source: Credential.LegacyKeySource.make({
      app: "codex-multi-provider",
      providerRef: entry.providerRef,
      name: entry.name,
      path: file,
    }),
    keySaved,
    ...(problem === undefined ? {} : { problem }),
  }
}

/**
 * A key as read from the old app's file. The private field keeps it out of `JSON.stringify`, `console.log` and
 * enumeration; only {@link Credentials} turns it into request headers.
 */
export class Secret {
  readonly #key: string

  constructor(key: string) {
    this.#key = key
  }

  key() {
    return this.#key
  }

  /** `sk-…9fQ2` (02 §3.3 step 4). */
  hint() {
    return keyHint(this.#key)
  }

  /** `hash8` of the key, to tell two reads apart without keeping either. */
  hash() {
    return short(this.#key)
  }

  toJSON() {
    return "[LegacyKey.Secret]"
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "[LegacyKey.Secret]"
  }
}

/**
 * The decrypted file text as a key: surrounding whitespace is dropped (the old app strips keys it saves), and the
 * key must be non-empty, at most {@link MAX_KEY_CHARS} long and free of whitespace and control characters, the same
 * check the old app runs before using one.
 */
export function normalize(value: string): Secret | undefined {
  const key = value.trim()
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (!key || key.length > MAX_KEY_CHARS || /[\s\u0000-\u001f\u007f]/.test(key)) return undefined
  return new Secret(key)
}

export interface ReaderOptions {
  readonly vault: Client
  readonly now?: () => number
  /** Minimum time between two `stat` calls of the file. Default 1 s. */
  readonly statIntervalMs?: number
  /** The key is read again through the helper after this long, `policy.secretCacheSeconds`. Default 600 s. */
  readonly ttlMs?: number
}

export interface Snapshot {
  readonly secret: Secret
  readonly size: number
  /** The file's last write time as the helper read it (epoch ms, whole milliseconds). */
  readonly mtimeMs: number
  /** When this process read it. */
  readonly readAt: number
}

export type Usable =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly problem: Problem }

/**
 * Linked-key reader of one old-app file (02 §3.2b). Keeps the decrypted key in memory only, keyed by the file's
 * mtime and size: a `stat` (at most once per `statIntervalMs`) that shows a change, an expired TTL, or
 * {@link Reader.invalidate} after a 401 makes the next use read the file again through own-vault `linked.get`. A key
 * the file no longer holds (deleted, unreadable, replaced by an invalid one) is dropped at once and never used again.
 */
export class Reader {
  readonly path: string
  readonly #vault: Client
  readonly #now: () => number
  readonly #statIntervalMs: number
  #ttlMs: number
  #snapshot: Snapshot | undefined
  #checkedAt = Number.NEGATIVE_INFINITY
  #dirty = false
  #problem: Problem | undefined
  #reading: Promise<Usable> | undefined

  constructor(file: string, options: ReaderOptions) {
    this.path = file
    this.#vault = options.vault
    this.#now = options.now ?? Date.now
    this.#statIntervalMs = options.statIntervalMs ?? 1_000
    this.#ttlMs = options.ttlMs ?? 600_000
  }

  /** Changes the TTL, e.g. after `policy.secretCacheSeconds` changed. */
  configure(ttlMs: number) {
    this.#ttlMs = ttlMs
  }

  /** The key, if the file holds a usable one. One read at a time: concurrent requests share it. */
  usable(): Promise<Usable> {
    if (this.#reading) return this.#reading
    const reading = this.#check().finally(() => {
      this.#reading = undefined
    })
    this.#reading = reading
    return reading
  }

  /** The provider answered 401 to this key: the next use reads the file again, even if it looks unchanged. */
  invalidate() {
    this.#dirty = true
    this.#checkedAt = Number.NEGATIVE_INFINITY
  }

  /** What is known without reading the file again. Never the key. */
  status() {
    return {
      keyHint: this.#snapshot?.secret.hint(),
      mtimeMs: this.#snapshot?.mtimeMs,
      problem: this.#problem,
    }
  }

  async #check(): Promise<Usable> {
    const now = this.#now()
    const snapshot = this.#snapshot
    const fresh = snapshot !== undefined && !this.#dirty && now - snapshot.readAt < this.#ttlMs
    if (now - this.#checkedAt < this.#statIntervalMs) {
      if (fresh) return { ok: true, snapshot }
      // A file that just failed is not read again on every request.
      if (this.#problem && !this.#dirty) return { ok: false, problem: this.#problem }
    }
    this.#checkedAt = now
    if (fresh) {
      const stat = await fs.stat(this.path).catch(() => undefined)
      if (stat && Math.floor(stat.mtimeMs) === snapshot.mtimeMs && stat.size === snapshot.size)
        return { ok: true, snapshot }
    }
    const got = await this.#vault.linkedGet(this.path)
    if (!got.ok) return this.#fail(problemOf(got.error))
    const secret = normalize(got.value)
    if (!secret) return this.#fail("invalid_key")
    const next: Snapshot = { secret, size: got.size, mtimeMs: Math.floor(got.mtimeMs), readAt: now }
    this.#snapshot = next
    this.#dirty = false
    this.#problem = undefined
    return { ok: true, snapshot: next }
  }

  #fail(problem: Problem): Usable {
    this.#problem = problem
    this.#dirty = false
    // Only an unreachable helper says nothing about the file; any other failure means the old key is gone.
    if (problem !== "vault_unavailable") this.#snapshot = undefined
    else this.#dirty = true
    return { ok: false, problem }
  }
}

/** A `linked.get` failure as a {@link Problem}. */
export function problemOf(error: string): Problem {
  if (error === "not_found" || error === "decrypt_failed" || error === "path_denied") return error
  if (error === "unavailable") return "vault_unavailable"
  if (error === "unknown_op") return "helper_outdated"
  return "unreadable"
}
