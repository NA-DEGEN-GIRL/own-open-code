export * as CreatorStore from "./store.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Creator } from "@own/protocol/creator"
import { Fsx, Hash, Lock } from "@own/runtime"
import { Schema } from "effect"
import { Safety } from "./safety.js"

/**
 * The extension store `OWN_HOME\creator` (17 §4), one for every stage:
 *
 *   store.json              which extensions exist, the active version of each, on/off, project folders, history
 *   ext\<id>\v<n>\          one version, never changed after it was written (`extension.json`, skills' SKILL.md)
 *   trash\<id>-<time>\      removed extensions (the newest 20)
 *   store.lock              the cross-process lease for writes
 *
 * A version folder is written beside its final name and renamed into place, then hashed; the hash is kept in
 * `store.json`, and a version whose files no longer hash the same reads as `tampered` and never applies. Updates add a
 * version and move the pointer; a rollback only moves the pointer. Writes run one at a time in this process and under
 * the lease across processes.
 */

export const TRASH_KEEP = 20

export interface Loaded {
  readonly entry: Creator.Entry
  /** The active version's extension, when it decodes and its files are intact. */
  readonly extension: Creator.Extension | undefined
  readonly status: Creator.Status
  readonly problems: ReadonlyArray<Creator.Problem>
  /** The active version's folder. */
  readonly dir: string
}

export interface Snapshot {
  readonly file: Creator.StoreFile
  readonly loaded: ReadonlyArray<Loaded>
  /** `store.json` did not decode; writes move it aside before they write a new one. */
  readonly broken: boolean
}

export type By = "model" | "user"

/** Names other plugins and the config already use, which an extension may not take (agents, commands, skills). */
export interface Reserved {
  readonly agents?: ReadonlySet<string>
  readonly commands?: ReadonlySet<string>
  readonly tools?: ReadonlySet<string>
}

/** A code version staging built (staging.ts): its folder, moved into place as the new version, and its checks. */
export interface Staged {
  readonly dir: string
  readonly checks: ReadonlyArray<{ readonly name: string; readonly ms: number }>
}

export type Failure =
  | { readonly ok: false; readonly reason: "not_found"; readonly id: string }
  | { readonly ok: false; readonly reason: "plugins_off" }
  | { readonly ok: false; readonly reason: "exists"; readonly id: string }
  | { readonly ok: false; readonly reason: "version_not_found"; readonly id: string; readonly version: number }
  | { readonly ok: false; readonly reason: "invalid"; readonly problems: ReadonlyArray<Creator.Problem> }
  | { readonly ok: false; readonly reason: "scope_invalid"; readonly problems: ReadonlyArray<Creator.Problem> }
  /** A host's mirror (17 §10): only the PC writes extensions; the host keeps read-only copies. */
  | { readonly ok: false; readonly reason: "read_only" }

export type Outcome =
  | { readonly ok: true; readonly snapshot: Snapshot; readonly id: string; readonly version?: number }
  | Failure

const EMPTY: Creator.StoreFile = { version: Creator.STORE_VERSION, extensions: [] }
const validateExtension = Schema.toStandardSchemaV1(Creator.Extension)["~standard"].validate
const encodeExtension = Schema.encodeSync(Creator.Extension)
const decodeStore = Schema.decodeUnknownOption(Creator.StoreFile)

/** Writes of one store in this process, in call order (the lease orders them across processes). */
const mutexes = new Map<string, Lock.Mutex>()

export class Store {
  readonly root: string
  readonly #home: string
  /** The running app's version: a C3 version staged against another one reads as `outdated`. */
  readonly app: string | undefined
  /**
   * An SSH host's read-only mirror of the PC's store (17 §10): every write is refused but the mirror's own
   * ({@link writeMirror}) and a C2 call's confirmation, which is this host's approval.
   */
  readonly mirror: boolean

  constructor(home: string, options: { readonly app?: string; readonly mirror?: boolean } = {}) {
    this.#home = path.resolve(home)
    this.root = path.join(this.#home, "creator")
    this.app = options.app
    this.mirror = options.mirror === true
  }

  get home() {
    return this.#home
  }

  get file() {
    return path.join(this.root, "store.json")
  }

  versionDir(id: string, n: number) {
    return path.join(this.root, "ext", id, `v${n}`)
  }

  async read(): Promise<Snapshot> {
    const raw = await Fsx.readText(this.file).catch(() => undefined)
    const parsed = raw === undefined ? undefined : parseJson(raw)
    const decoded = parsed === undefined ? undefined : decodeStore(parsed)
    const broken = raw !== undefined && (decoded === undefined || decoded._tag === "None")
    const file = decoded !== undefined && decoded._tag === "Some" ? decoded.value : EMPTY
    const loaded = await loadAll(this, file)
    return { file, loaded, broken }
  }

  /** Checks a manifest as `create`/`update` would, without writing (the manage tool's `validate`). */
  async check(manifest: unknown, reserved: Reserved = {}, replacing?: string) {
    const snapshot = await this.read()
    return validate(manifest, snapshot, reserved, replacing)
  }

  /** A new extension at version 1, active and on. A code extension (C2, C3) comes with its staged folder. */
  create(manifest: unknown, by: By, reserved: Reserved = {}, note?: string, staged?: Staged): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const checked = validate(manifest, snapshot, reserved, undefined)
      if (!checked.ok) return checked
      if (snapshot.file.extensions.some((entry) => entry.id === checked.extension.id))
        return { ok: false, reason: "exists", id: checked.extension.id }
      if (Creator.kindOf(checked.extension) === "plugin" && snapshot.file.settings?.plugins !== true)
        return { ok: false, reason: "plugins_off" }
      const now = Date.now()
      const version = await this.#writeVersion(checked.extension, 1, by, now, note, staged)
      const entry: Creator.Entry = {
        id: checked.extension.id,
        active: 1,
        enabled: true,
        projects: [],
        loosen: [],
        confirmed: [],
        trusted: [],
        hostProjects: [],
        hostTrusted: [],
        versions: [version],
        history: [{ at: now, action: "create", version: 1, by }],
        createdAt: now,
        updatedAt: now,
      }
      return { file: { ...snapshot.file, extensions: [...snapshot.file.extensions, entry] }, id: entry.id, version: 1 }
    })
  }

  /** A new version of an existing extension; the pointer moves to it. */
  update(manifest: unknown, by: By, reserved: Reserved = {}, note?: string, staged?: Staged): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const id = idOf(manifest)
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id: id ?? "" }
      const checked = validate(manifest, snapshot, reserved, current.id)
      if (!checked.ok) return checked
      if (current.projects.length > 0 && checked.extension.items.some((item) => Safety.globalOnly(item)))
        return { ok: false, reason: "scope_invalid", problems: [globalOnlyProblem] }
      if (Creator.kindOf(checked.extension) === "plugin" && snapshot.file.settings?.plugins !== true)
        return { ok: false, reason: "plugins_off" }
      const now = Date.now()
      const n = Math.max(0, ...current.versions.map((version) => version.n)) + 1
      const version = await this.#writeVersion(checked.extension, n, by, now, note, staged)
      const entry = trimVersions({
        ...current,
        active: n,
        versions: [...current.versions, version],
        history: capHistory([...current.history, { at: now, action: "update", version: n, by }]),
        updatedAt: now,
      })
      await this.#dropFolders(current, entry)
      return { file: replace(snapshot.file, entry), id: entry.id, version: n }
    })
  }

  enable(id: string, enabled: boolean, by: By, reserved: Reserved = {}): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      if (current.enabled === enabled) return { file: snapshot.file, id }
      if (enabled) {
        const conflicts = await this.#activationProblems(snapshot, current, current.active, reserved)
        if (conflicts.length > 0) return { ok: false, reason: "invalid", problems: conflicts }
      }
      const now = Date.now()
      const entry = {
        ...current,
        enabled,
        history: capHistory([...current.history, { at: now, action: enabled ? "enable" : "disable", by } as const]),
        updatedAt: now,
      }
      return { file: replace(snapshot.file, entry), id }
    })
  }

  /** Points the extension at version `n`, which it already has. A version that would not apply is refused. */
  rollback(id: string, n: number, by: By, reserved: Reserved = {}): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      if (!current.versions.some((version) => version.n === n))
        return { ok: false, reason: "version_not_found", id, version: n }
      const problems = await this.#activationProblems(snapshot, current, n, reserved)
      if (problems.length > 0) return { ok: false, reason: "invalid", problems }
      const now = Date.now()
      const entry = {
        ...current,
        active: n,
        history: capHistory([...current.history, { at: now, action: "rollback", version: n, by } as const]),
        updatedAt: now,
      }
      return { file: replace(snapshot.file, entry), id, version: n }
    })
  }

  /** Removes the extension from the store and moves its folder to the trash. */
  remove(id: string): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      const from = path.join(this.root, "ext", id)
      const trash = path.join(this.root, "trash")
      await fs.mkdir(trash, { recursive: true })
      await Fsx.rename(from, path.join(trash, `${id}-${Date.now()}`)).catch((error: unknown) => {
        if (Fsx.code(error) !== "ENOENT") throw error
      })
      await this.#trimTrash()
      return { file: { ...snapshot.file, extensions: snapshot.file.extensions.filter((entry) => entry.id !== id) }, id }
    })
  }

  /**
   * Limits the extension to `projects` (absolute folders of this PC) and `hostProjects` (folders of SSH hosts, 17 §10)
   * and the folders inside them; both empty is every project. Without `hostProjects` the host folders stay.
   */
  scope(
    id: string,
    projects: ReadonlyArray<string>,
    by: By,
    configDir?: string,
    hostProjects?: ReadonlyArray<Creator.HostFolder>,
  ): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      const checked = await Safety.projects(projects, {
        home: this.#home,
        configDir: configDir ?? process.env.OPENCODE_CONFIG_DIR,
      })
      const hosts = Safety.hostProjects(hostProjects ?? current.hostProjects)
      const problems = [...checked.problems, ...hosts.problems]
      if (problems.length > 0) return { ok: false, reason: "scope_invalid", problems }
      const loaded = snapshot.loaded.find((item) => item.entry.id === id)
      if (
        checked.folders.length + hosts.folders.length > 0 &&
        loaded?.extension?.items.some((item) => Safety.globalOnly(item))
      )
        return { ok: false, reason: "scope_invalid", problems: [globalOnlyProblem] }
      const now = Date.now()
      const entry = {
        ...current,
        projects: checked.folders,
        hostProjects: hosts.folders,
        history: capHistory([...current.history, { at: now, action: "scope", by } as const]),
        updatedAt: now,
      }
      return { file: replace(snapshot.file, entry), id }
    })
  }

  /** Which SSH hosts the extension reaches (Settings only, 17 §10). */
  hosts(id: string, hosts: Creator.Hosts): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      const now = Date.now()
      const entry: Creator.Entry = {
        ...current,
        hosts: { mode: hosts.mode, ids: [...new Set(hosts.ids)] },
        history: capHistory([...current.history, { at: now, action: "hosts", by: "user" }]),
        updatedAt: now,
      }
      return { file: replace(snapshot.file, entry), id }
    })
  }

  /**
   * The user's allowance of version `n` on one SSH host (Settings only, 17 §10): a C3 version runs there, and approved
   * allow rules apply there (CRM-33), only with it. Apart from {@link trust} and {@link loosen}, which are about this
   * PC's service. A version with neither code nor allow rules has nothing to allow per host.
   */
  hostTrust(id: string, host: string, n: number, trusted: boolean): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      const info = current.versions.find((version) => version.n === n)
      if (info === undefined) return { ok: false, reason: "version_not_found", id, version: n }
      if (trusted) {
        const read = await readVersion(this, id, info)
        if (read.extension === undefined) return { ok: false, reason: "invalid", problems: read.problems }
        const loosens = Creator.effects(read.extension).some((effect) => effect.loosens)
        if (Creator.kindOf(read.extension) !== "plugin" && !loosens)
          return {
            ok: false,
            reason: "invalid",
            problems: [{ path: "kind", message: "only code plugins and allow rules are allowed per host" }],
          }
      }
      const now = Date.now()
      const others = current.hostTrusted.filter((item) => !(item.host === host && item.n === n))
      const entry: Creator.Entry = {
        ...current,
        hostTrusted: trusted ? [...others, { host, n }] : others,
        history: capHistory([
          ...current.history,
          { at: now, action: trusted ? "host_trust" : "host_untrust", version: n, by: "user", host },
        ]),
        updatedAt: now,
      }
      return { file: replace(snapshot.file, entry), id }
    })
  }

  /**
   * Replaces the whole store with the PC's mirror (17 §10, a host only): the mirror's version folders are already in
   * place and hash-checked; the store re-hashes them on every read like its own.
   */
  writeMirror(file: Creator.StoreFile): Promise<Outcome> {
    return this.#write(async () => ({ file, id: "" }), true)
  }

  /** The user's approval of version `n`'s allow rules (Settings only). */
  loosen(id: string, n: number, approved: boolean): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      if (!current.versions.some((version) => version.n === n))
        return { ok: false, reason: "version_not_found", id, version: n }
      const now = Date.now()
      const loosen = approved ? [...new Set([...current.loosen, n])] : current.loosen.filter((item) => item !== n)
      const entry = {
        ...current,
        loosen,
        history: capHistory([
          ...current.history,
          { at: now, action: approved ? "approve" : "revoke", version: n, by: "user" } as const,
        ]),
        updatedAt: now,
      }
      return { file: replace(snapshot.file, entry), id }
    })
  }

  /**
   * The user approved a call of version `n` of a C2 extension: full approval stops asking for it (17 §11.5). On a host
   * this is the host's own approval (where the conversation is) and stays in the host's mirror.
   */
  confirm(id: string, n: number): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      if (current.confirmed.includes(n)) return { file: snapshot.file, id }
      return { file: replace(snapshot.file, { ...current, confirmed: [...current.confirmed, n] }), id }
    }, true)
  }

  /** The user's approval of C3 version `n` to load in the service (Settings only, 17 §12.4). */
  trust(id: string, n: number, trusted: boolean): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      const current = snapshot.file.extensions.find((entry) => entry.id === id)
      if (current === undefined) return { ok: false, reason: "not_found", id }
      const info = current.versions.find((version) => version.n === n)
      if (info === undefined) return { ok: false, reason: "version_not_found", id, version: n }
      if (trusted) {
        const read = await readVersion(this, id, info)
        if (read.extension === undefined) return { ok: false, reason: "invalid", problems: read.problems }
        if (Creator.kindOf(read.extension) !== "plugin")
          return { ok: false, reason: "invalid", problems: [{ path: "kind", message: "only code plugins are trusted" }] }
      }
      const now = Date.now()
      const entry = {
        ...current,
        trusted: trusted ? [...new Set([...current.trusted, n])] : current.trusted.filter((item) => item !== n),
        history: capHistory([
          ...current.history,
          { at: now, action: trusted ? "trust" : "untrust", version: n, by: "user" } as const,
        ]),
        updatedAt: now,
      }
      return { file: replace(snapshot.file, entry), id }
    })
  }

  /** The store-wide switches (Settings only): C3's code plugin switch. */
  settings(settings: Creator.Settings): Promise<Outcome> {
    return this.#write(async (snapshot) => {
      if (snapshot.file.settings?.plugins === settings.plugins) return { file: snapshot.file, id: "" }
      return { file: { ...snapshot.file, settings: { ...settings } }, id: "" }
    })
  }

  /** One version's file as written and its problems (Settings' version history). */
  async version(id: string, n: number) {
    const snapshot = await this.read()
    const entry = snapshot.file.extensions.find((item) => item.id === id)
    if (entry === undefined) return { ok: false as const, reason: "not_found" as const }
    const info = entry.versions.find((version) => version.n === n)
    if (info === undefined) return { ok: false as const, reason: "version_not_found" as const }
    const read = await readVersion(this, entry.id, info)
    return { ok: true as const, raw: read.raw, extension: read.extension, problems: read.problems }
  }

  async #activationProblems(snapshot: Snapshot, entry: Creator.Entry, n: number, reserved: Reserved) {
    const info = entry.versions.find((version) => version.n === n)
    if (info === undefined) return [{ path: "version", message: `no version ${n}` }]
    const read = await readVersion(this, entry.id, info)
    if (read.extension === undefined) return read.problems
    const others = snapshot.loaded.filter((item) => item.entry.id !== entry.id)
    const conflicts = [
      ...Safety.conflicts(read.extension, others),
      ...Safety.reservedProblems(read.extension, reserved),
    ]
    if (entry.projects.length > 0 && read.extension.items.some((item) => Safety.globalOnly(item)))
      return [...conflicts, globalOnlyProblem]
    return conflicts
  }

  async #writeVersion(
    extension: Creator.Extension,
    n: number,
    by: By,
    now: number,
    note: string | undefined,
    staged: Staged | undefined,
  ) {
    const final = this.versionDir(extension.id, n)
    await fs.mkdir(path.dirname(final), { recursive: true })
    // A code version arrives staged (its files, own's helpers, installed dependencies); a declarative one is written here.
    const staging = staged?.dir ?? `${final}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    await fs.mkdir(staging, { recursive: true })
    await Fsx.writeSynced(
      path.join(staging, "extension.json"),
      `${JSON.stringify(encodeExtension(extension), null, 2)}\n`,
    )
    // A skill's SKILL.md is the file core shows as the skill's path; its text is the item's.
    await Promise.all(
      extension.items.flatMap((item) => {
        if (item.type !== "skill") return []
        const folder = path.join(staging, "skills", item.name)
        return [
          fs
            .mkdir(folder, { recursive: true })
            .then(() => Fsx.writeSynced(path.join(folder, "SKILL.md"), Safety.skillMarkdown(item))),
        ]
      }),
    )
    // A stale folder of a write that died before its store.json write is replaced (its version was never recorded).
    await Fsx.removeTree(final)
    await Fsx.rename(staging, final)
    const hash = await hashFolder(final)
    return {
      n,
      hash,
      createdAt: now,
      by,
      ...(note === undefined ? {} : { note: note.slice(0, 200) }),
      ...(staged === undefined ? {} : { checks: staged.checks.map((check) => ({ ...check })) }),
      ...(staged !== undefined && this.app !== undefined ? { app: this.app } : {}),
    }
  }

  async #dropFolders(before: Creator.Entry, after: Creator.Entry) {
    const kept = new Set(after.versions.map((version) => version.n))
    await Promise.all(
      before.versions
        .filter((version) => !kept.has(version.n))
        .map((version) => Fsx.removeTree(this.versionDir(before.id, version.n))),
    )
  }

  async #trimTrash() {
    const trash = path.join(this.root, "trash")
    const names = await fs.readdir(trash).catch(() => [] as string[])
    const dated = names
      .map((name) => ({ name, at: Number(name.slice(name.lastIndexOf("-") + 1)) }))
      .filter((item) => Number.isFinite(item.at))
      .toSorted((a, b) => b.at - a.at)
    await Promise.all(dated.slice(TRASH_KEEP).map((item) => Fsx.removeTree(path.join(trash, item.name))))
  }

  /** Runs one write: reads the store, lets `change` decide, writes `store.json` once, answers the new snapshot. */
  #write(
    change: (snapshot: Snapshot) => Promise<Failure | { file: Creator.StoreFile; id: string; version?: number }>,
    mirrored = false,
  ): Promise<Outcome> {
    if (this.mirror && !mirrored) return Promise.resolve({ ok: false, reason: "read_only" })
    const mutex = mutexes.get(this.root) ?? new Lock.Mutex()
    mutexes.set(this.root, mutex)
    return mutex.run(async () => {
      await fs.mkdir(this.root, { recursive: true })
      return Lock.withFile(path.join(this.root, "store.lock"), async () => {
        const snapshot = await this.read()
        const result = await change(snapshot)
        if ("ok" in result) return result
        if (result.file !== snapshot.file) {
          if (snapshot.broken) await Fsx.rename(this.file, `${this.file}.broken-${Date.now()}`).catch(() => undefined)
          await Fsx.writeAtomic(this.file, `${JSON.stringify(result.file, null, 2)}\n`)
        }
        const next = result.file === snapshot.file ? snapshot : await this.read()
        notify(this.root)
        return {
          ok: true as const,
          snapshot: next,
          id: result.id,
          ...(result.version === undefined ? {} : { version: result.version }),
        }
      })
    })
  }
}

const globalOnlyProblem: Creator.Problem = {
  path: "projects",
  message: "harness instructions apply to every project; an extension with them cannot be limited to folders",
}

// ---- change notifications (every Location's instance in this process) ----

const listeners = new Map<string, Set<() => void>>()

/** Calls `listener` after every write to the store at `root` in this process. */
export function onChange(root: string, listener: () => void) {
  const set = listeners.get(root) ?? new Set()
  listeners.set(root, set)
  set.add(listener)
  return () => void set.delete(listener)
}

function notify(root: string) {
  listeners.get(root)?.forEach((listener) => listener())
}

/** Tells every instance in this process to re-read the store (a change outside it: a stopped server). */
export function poke(root: string) {
  notify(root)
}

// ---- reading ----

async function loadAll(store: Store, file: Creator.StoreFile): Promise<ReadonlyArray<Loaded>> {
  const loaded: Loaded[] = []
  // In store order: a later extension that claims a name an earlier active one holds does not apply.
  for (const entry of file.extensions) {
    const info = entry.versions.find((version) => version.n === entry.active)
    const dir = store.versionDir(entry.id, entry.active)
    if (info === undefined) {
      loaded.push({ entry, extension: undefined, status: "missing", problems: [], dir })
      continue
    }
    const read = await readVersion(store, entry.id, info)
    const conflicts = read.extension === undefined || !entry.enabled ? [] : Safety.conflicts(read.extension, loaded)
    const status: Creator.Status =
      read.status !== "active"
        ? read.status
        : !entry.enabled
          ? "disabled"
          : conflicts.length > 0
            ? "invalid"
            : (pluginStatus(store, file, entry, info, read.extension) ?? "active")
    loaded.push({ entry, extension: read.extension, status, problems: [...read.problems, ...conflicts], dir })
  }
  return loaded
}

/**
 * Why an active C3 version does not load now (17 §12.1, §12.4): the switch is off, the user has not approved this
 * version, or it was staged for another app version.
 */
function pluginStatus(
  store: Store,
  file: Creator.StoreFile,
  entry: Creator.Entry,
  info: Creator.VersionInfo,
  extension: Creator.Extension | undefined,
): Creator.Status | undefined {
  if (extension === undefined || Creator.kindOf(extension) !== "plugin") return undefined
  if (file.settings?.plugins !== true) return "unavailable"
  if (store.app !== undefined && info.app !== undefined && info.app !== store.app) return "outdated"
  if (!entry.trusted.includes(entry.active)) return "pending"
  return undefined
}

async function readVersion(store: Store, id: string, info: Creator.VersionInfo) {
  const dir = store.versionDir(id, info.n)
  const text = await Fsx.readText(path.join(dir, "extension.json")).catch(() => undefined)
  if (text === undefined)
    return {
      status: "missing" as const,
      raw: undefined,
      extension: undefined,
      problems: [{ path: "", message: "the version's folder is gone" }],
    }
  const raw = parseJson(text)
  const hashed = await hashFolder(dir).then(
    (hash) => ({ hash }),
    (error: unknown) => ({ hash: "", link: error instanceof Hash.FolderLinkError ? error.file : undefined }),
  )
  // A link inside a version folder could point its files anywhere: such a version never applies (17 §4.2).
  if ("link" in hashed && hashed.link !== undefined)
    return {
      status: "invalid" as const,
      raw,
      extension: undefined,
      problems: [{ path: hashed.link, message: "the version's folder holds a link (symbolic link, junction or reparse point)" }],
    }
  if (hashed.hash !== info.hash)
    return {
      status: "tampered" as const,
      raw,
      extension: undefined,
      problems: [{ path: "", message: "the version's files changed after it was written" }],
    }
  const checked = checkManifest(raw)
  if (!checked.ok) return { status: "invalid" as const, raw, extension: undefined, problems: checked.problems }
  return { status: "active" as const, raw, extension: checked.extension, problems: [] as Creator.Problem[] }
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parseJson(text: string): unknown {
  const decoded = decodeJson(text)
  return decoded._tag === "Some" ? decoded.value : undefined
}

/**
 * sha256 of every file under `dir`: sorted relative paths with "/" and their bytes (own-runtime `Hash.folder`, never
 * cached, rejecting a folder that holds a link).
 */
export function hashFolder(dir: string) {
  return Hash.folder(dir)
}

// ---- validation ----

/** Decodes `manifest` with the format's schema and its own checks (no store): the JSON schema of 17 §3. */
export function checkManifest(
  manifest: unknown,
): { ok: true; extension: Creator.Extension } | { ok: false; problems: ReadonlyArray<Creator.Problem> } {
  const result = validateExtension(manifest)
  if (result instanceof Promise) return { ok: false, problems: [{ path: "", message: "asynchronous schema" }] }
  if (result.issues !== undefined)
    return {
      ok: false,
      problems: result.issues.slice(0, 20).map((issue) => ({
        path: (issue.path ?? [])
          .map((key) => (typeof key === "object" && key !== null && "key" in key ? key.key : key))
          .map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`))
          .join("")
          .replace(/^\./, ""),
        message: issue.message,
      })),
    }
  const extension = result.value
  const problems = [...Creator.problems(extension), ...Safety.problems(extension)]
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, extension }
}

function validate(
  manifest: unknown,
  snapshot: Snapshot,
  reserved: Reserved,
  replacing: string | undefined,
): { ok: true; extension: Creator.Extension } | Failure {
  const checked = checkManifest(manifest)
  if (!checked.ok) return { ok: false, reason: "invalid", problems: checked.problems }
  if (replacing !== undefined && checked.extension.id !== replacing)
    return { ok: false, reason: "invalid", problems: [{ path: "id", message: `the id is '${replacing}'` }] }
  const others = snapshot.loaded.filter((item) => item.entry.id !== checked.extension.id)
  const problems = [
    ...Safety.conflicts(checked.extension, others),
    ...Safety.reservedProblems(checked.extension, reserved),
  ]
  if (problems.length > 0) return { ok: false, reason: "invalid", problems }
  return checked
}

function idOf(manifest: unknown) {
  if (typeof manifest !== "object" || manifest === null || !("id" in manifest)) return undefined
  return typeof manifest.id === "string" ? manifest.id : undefined
}

function replace(file: Creator.StoreFile, entry: Creator.Entry): Creator.StoreFile {
  return { ...file, extensions: file.extensions.map((item) => (item.id === entry.id ? entry : item)) }
}

function capHistory(history: ReadonlyArray<Creator.HistoryEntry>) {
  return history.slice(-100)
}

/** Keeps the newest {@link Creator.LIMITS.versions} versions, plus the active one and approved ones. */
function trimVersions(entry: Creator.Entry): Creator.Entry {
  if (entry.versions.length <= Creator.LIMITS.versions) return entry
  const keep = new Set([entry.active, ...entry.loosen, ...entry.trusted, ...entry.hostTrusted.map((item) => item.n)])
  const newest = entry.versions.slice(-Creator.LIMITS.versions).map((version) => version.n)
  newest.forEach((n) => keep.add(n))
  return { ...entry, versions: entry.versions.filter((version) => keep.has(version.n)) }
}
