export * as Mirror from "./mirror.js"

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Broker } from "@own/protocol"
import { Creator } from "@own/protocol/creator"
import { CreatorBridge, Fsx, Hash } from "@own/runtime"
import { Schema } from "effect"
import { Safety } from "./safety.js"
import { Staging } from "./staging.js"
import { CreatorStore } from "./store.js"

/**
 * An SSH host's read-only copy of the PC's extensions (17 §10). The PC's broker hands this host a view (`creator.get`)
 * of the extensions that reach it; for each one the host fetches the active version's files (`creator.file`), hashes
 * them and keeps them only when they hash as the PC's version. A C2 version runs the host's own staging in this host's
 * sandbox ({@link Staging.hostCheck}) before its servers register. Then the host's `store.json` is written from the
 * view: the scope is the host's folders (checked again here), the allow-rule approval and the C3 allowance are the
 * PC's, and a C2 call's confirmation stays this host's own. Everything else of the store keeps working as on the PC,
 * from the same files: fragments, rules, retry, compaction, agents, commands, skills, 내 지시문, command tools on this
 * host's shell with its approvals, C2 servers in its sandbox, C3 only with the allowance.
 *
 * The host never writes the PC: it only reads, and reports what applied (`creator.report`), which the PC keeps in
 * memory. Without a session the host keeps the last mirror it applied. When the PC runs another build (`skew_drain`)
 * the host keeps the rest but withdraws its code plugins and approved allow rules (CRM-34): an allowance the user took
 * back on that PC could not reach it.
 */

export interface Options {
  readonly bun: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly configDir?: string
  /** After each applied mirror, in one instance (its own.harness 내 지시문 takeover, 17 §6.4). */
  readonly applied?: (snapshot: CreatorStore.Snapshot) => Promise<void>
  /**
   * This instance re-reads the store and registers what changed. The syncer waits for every attached instance before
   * it reports, so a report of `active` means the host's conversations already have it.
   */
  readonly reload?: () => Promise<void>
}

export interface Result {
  readonly revision: string | undefined
  readonly report: Creator.HostReport | undefined
}

const State = Schema.Struct({
  /** Host staging results of C2 versions, by `<id>:<n>:<hash>`. */
  checks: Schema.Record(
    Schema.String,
    Schema.Struct({ ok: Schema.Boolean, problems: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })) }),
  ),
})
type State = typeof State.Type
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(State))
const decodeGet = Schema.decodeUnknownOption(Broker.CreatorGetResult)
const decodeChunk = Schema.decodeUnknownOption(Broker.CreatorChunk)

const CHECKS_KEPT = 64
const GET_MS = 30_000
const FILE_MS = 30_000

/** One sync against the PC through `link`: fetch, verify, stage, write the store, report. */
export async function sync(store: CreatorStore.Store, link: CreatorBridge.Link, options: Options): Promise<Result> {
  const reply = await link.request("creator.get", {}, GET_MS)
  if (!reply.ok && reply.error === "skew_drain") return withdraw(store, options)
  const got = reply.ok ? decodeGet(reply.result) : undefined
  // No session, a refusal, or no own.creator running on the PC right now: the last mirror stays.
  if (got === undefined || got._tag === "None" || got.value.view === undefined)
    return { revision: undefined, report: undefined }
  const view = got.value.view
  const state = await readState(store)
  const failures = new Map<string, ReadonlyArray<Creator.Problem>>()
  for (const entry of view.extensions) {
    const fetched = await fetchVersion(store, link, entry)
    if (!fetched.ok) {
      failures.set(entry.id, [fetched.problem])
      continue
    }
    if (entry.kind !== "mcp") continue
    const key = `${entry.id}:${entry.version.n}:${entry.version.hash}`
    const known = state.checks[key]
    const checked = known ?? (await stage(store, entry, options))
    if (known === undefined) state.checks[key] = { ok: checked.ok, problems: checked.problems.slice(0, 8) }
    if (!checked.ok) failures.set(entry.id, checked.problems.slice(0, 8))
  }
  await writeState(store, state)
  const previous = await store.read()
  const extensions = view.extensions.flatMap((entry): Creator.Entry[] => {
    if (failures.has(entry.id)) return []
    const folders = Safety.hostFolders(entry.projects, { home: store.home, configDir: options.configDir })
    // A scope that names folders, none of them usable here, never widens to every project.
    if (entry.projects.length > 0 && folders.length === 0) {
      failures.set(entry.id, [{ path: "projects", message: "none of the scope's host folders can be used on this host" }])
      return []
    }
    const n = entry.version.n
    const before = previous.file.extensions.find((item) => item.id === entry.id)
    return [
      {
        id: entry.id,
        active: n,
        enabled: true,
        projects: folders,
        hostProjects: [],
        loosen: entry.loosen ? [n] : [],
        confirmed: (before?.confirmed ?? []).filter((item) => item === n),
        trusted: entry.kind === "plugin" && entry.hostTrusted ? [n] : [],
        hostTrusted: [],
        versions: [entry.version],
        history: [],
        createdAt: entry.version.createdAt,
        updatedAt: entry.version.createdAt,
      },
    ]
  })
  const file: Creator.StoreFile = {
    version: Creator.STORE_VERSION,
    extensions,
    settings: { plugins: view.plugins && view.extensions.some((entry) => entry.kind === "plugin" && entry.hostTrusted) },
  }
  if (JSON.stringify(file) !== JSON.stringify(previous.file) || previous.broken) await store.writeMirror(file)
  await prune(store, view)
  await options.reload?.().catch(() => undefined)
  const snapshot = await store.read()
  await options.applied?.(snapshot).catch(() => undefined)
  const report: Creator.HostReport = {
    revision: view.revision,
    at: Date.now(),
    extensions: view.extensions.map((entry) => {
      const failed = failures.get(entry.id)
      if (failed !== undefined) return { id: entry.id, n: entry.version.n, status: "failed" as const, problems: trim(failed) }
      const loaded = snapshot.loaded.find((item) => item.entry.id === entry.id)
      return {
        id: entry.id,
        n: entry.version.n,
        status: loaded?.status ?? "missing",
        problems: trim(loaded?.problems ?? []),
      }
    }),
  }
  await link.request("creator.report", report, 10_000).catch(() => undefined)
  return { revision: view.revision, report }
}

/** The PC answers no `creator.*` (another build): the code plugins and allow-rule approvals of the last mirror go. */
async function withdraw(store: CreatorStore.Store, options: Options): Promise<Result> {
  const previous = await store.read()
  const code = new Set(
    previous.loaded
      .filter((loaded) => loaded.extension !== undefined && Creator.kindOf(loaded.extension) === "plugin")
      .map((loaded) => loaded.entry.id),
  )
  const file: Creator.StoreFile = {
    ...previous.file,
    extensions: previous.file.extensions.filter((entry) => !code.has(entry.id)).map((entry) => ({ ...entry, loosen: [] })),
    settings: { ...previous.file.settings, plugins: false },
  }
  if (JSON.stringify(file) !== JSON.stringify(previous.file)) {
    await store.writeMirror(file)
    await options.reload?.().catch(() => undefined)
  }
  return { revision: undefined, report: undefined }
}

/**
 * The active version's folder, fetched when it is not here with the PC's hash. The files are written beside the final
 * folder and moved into place only when the whole folder hashes as the PC's version.
 */
async function fetchVersion(
  store: CreatorStore.Store,
  link: CreatorBridge.Link,
  entry: Creator.MirrorEntry,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: Creator.Problem }> {
  const final = store.versionDir(entry.id, entry.version.n)
  const present = await Hash.folder(final).catch(() => undefined)
  if (present === entry.version.hash) return { ok: true }
  const temp = `${final}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  const fail = async (message: string) => {
    await Fsx.removeTree(temp)
    return { ok: false as const, problem: { path: "files", message } }
  }
  const total = entry.files.reduce((sum, file) => sum + file.size, 0)
  if (entry.files.length > Creator.MIRROR_LIMITS.files || total > Creator.MIRROR_LIMITS.bytes)
    return fail("the version is larger than a host takes")
  for (const listed of entry.files) {
    const parts = listed.path.split("/")
    if (parts.some((part) => part === "" || part === "." || part === ".." || /[\\:]/.test(part)))
      return fail(`'${listed.path}' is not a file path of the version`)
    const target = path.join(temp, ...parts)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const chunks: Buffer[] = []
    for (let offset = 0; ; ) {
      const reply = await link.request(
        "creator.file",
        { id: entry.id, n: entry.version.n, path: listed.path, offset } satisfies Broker.CreatorFile,
        FILE_MS,
      )
      const chunk = reply.ok ? decodeChunk(reply.result) : undefined
      if (chunk === undefined || chunk._tag === "None") return fail(`'${listed.path}' could not be fetched from the PC`)
      const data = Buffer.from(chunk.value.data, "base64")
      chunks.push(data)
      offset += data.length
      if (offset > listed.size) return fail(`'${listed.path}' is larger than the PC said`)
      if (chunk.value.end) break
      if (data.length === 0) return fail(`'${listed.path}' ended early`)
    }
    await Fsx.writeSynced(target, Buffer.concat(chunks))
  }
  const hash = await Hash.folder(temp).catch(() => undefined)
  // The host's check of the PC's hash before anything of the version applies (17 §10).
  if (hash !== entry.version.hash) return fail("the files do not hash as the PC's version")
  await Fsx.removeTree(final)
  await fs.mkdir(path.dirname(final), { recursive: true })
  await Fsx.rename(temp, final)
  return { ok: true }
}

/** Host staging of a mirrored C2 version (its tests and smoke in this host's sandbox). */
async function stage(store: CreatorStore.Store, entry: Creator.MirrorEntry, options: Options) {
  const dir = store.versionDir(entry.id, entry.version.n)
  const text = await Fsx.readText(path.join(dir, "extension.json")).catch(() => undefined)
  const decoded = text === undefined ? undefined : CreatorStore.checkManifest(parse(text))
  if (decoded === undefined || !decoded.ok)
    return { ok: false, problems: [{ path: "extension.json", message: "the mirrored version does not decode" }] }
  return Staging.hostCheck(store, decoded.extension, dir, {
    bun: options.bun,
    ...(options.env === undefined ? {} : { env: options.env }),
  })
}

/** Removes the folders of extensions and versions the view no longer names (and dead temp folders). */
async function prune(store: CreatorStore.Store, view: Creator.MirrorView) {
  const root = path.join(store.root, "ext")
  const ids = await fs.readdir(root).catch(() => [] as string[])
  await Promise.all(
    ids.map(async (id) => {
      const entry = view.extensions.find((item) => item.id === id)
      if (entry === undefined) return Fsx.removeTree(path.join(root, id))
      const names = await fs.readdir(path.join(root, id)).catch(() => [] as string[])
      await Promise.all(
        names
          .filter((name) => name !== `v${entry.version.n}`)
          .map((name) => Fsx.removeTree(path.join(root, id, name))),
      )
    }),
  )
}

async function readState(store: CreatorStore.Store): Promise<{ checks: Record<string, State["checks"][string]> }> {
  const text = await Fsx.readText(path.join(store.root, "mirror.json")).catch(() => undefined)
  const decoded = text === undefined ? undefined : decodeState(text)
  return { checks: decoded !== undefined && decoded._tag === "Some" ? { ...decoded.value.checks } : {} }
}

async function writeState(store: CreatorStore.Store, state: { checks: Record<string, State["checks"][string]> }) {
  const kept = Object.fromEntries(Object.entries(state.checks).slice(-CHECKS_KEPT))
  await fs.mkdir(store.root, { recursive: true })
  await Fsx.writeAtomic(path.join(store.root, "mirror.json"), `${JSON.stringify({ checks: kept }, null, 2)}\n`)
}

function trim(problems: ReadonlyArray<Creator.Problem>) {
  return problems.slice(0, 8).map((problem) => ({ path: problem.path.slice(0, 200), message: problem.message.slice(0, 400) }))
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---- the process's syncer ----

interface Slot {
  readonly store: CreatorStore.Store
  readonly attached: Options[]
  running: Promise<void> | undefined
  again: boolean
  unlisten: () => void
}

const KEY = Symbol.for("own-open-code.creator-mirror")

function slots() {
  // One syncer per store in the process, whichever Location's instance (and plugin module copy) attached first.
  const root = globalThis as unknown as Record<symbol, Map<string, Slot> | undefined>
  const existing = root[KEY]
  if (existing) return existing
  const created = new Map<string, Slot>()
  root[KEY] = created
  return created
}

/**
 * Attaches a Location's instance on a host. The first one starts the process's syncer: it syncs whenever the link comes
 * up or the PC says its extensions changed, one sync at a time. Returns the detach function.
 */
export function attach(store: CreatorStore.Store, options: Options) {
  const existing = slots().get(store.root)
  const slot: Slot = existing ?? {
    store,
    attached: [],
    running: undefined,
    again: false,
    unlisten: () => undefined,
  }
  if (existing === undefined) {
    slots().set(store.root, slot)
    slot.unlisten = CreatorBridge.onLink(() => schedule(slot))
  }
  slot.attached.push(options)
  if (CreatorBridge.link() !== undefined) schedule(slot)
  return () => {
    const index = slot.attached.indexOf(options)
    if (index >= 0) slot.attached.splice(index, 1)
    if (slot.attached.length > 0) return
    slot.unlisten()
    if (slots().get(store.root) === slot) slots().delete(store.root)
  }
}

function schedule(slot: Slot) {
  if (slot.running !== undefined) {
    slot.again = true
    return
  }
  slot.running = (async () => {
    do {
      slot.again = false
      const link = CreatorBridge.link()
      const first = slot.attached[0]
      if (link === undefined || first === undefined) break
      const reload = async () => {
        await Promise.all(slot.attached.map((item) => item.reload?.()))
      }
      await sync(slot.store, link, { ...first, reload }).catch((error: unknown) =>
        process.stderr.write(
          `${JSON.stringify({ ts: Date.now(), level: "warn", scope: "own.creator", msg: "mirror_sync_failed", error: String(error) })}\n`,
        ),
      )
    } while (slot.again)
  })().finally(() => {
    slot.running = undefined
  })
}

/** Waits for the running sync (tests). */
export function settled(root: string) {
  return slots().get(root)?.running ?? Promise.resolve()
}
