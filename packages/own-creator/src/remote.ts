export * as Remote from "./remote.js"

import fs from "node:fs/promises"
import path from "node:path"
import type { Broker } from "@own/protocol"
import { Creator } from "@own/protocol/creator"
import { CreatorBridge, Hash } from "@own/runtime"
import type { CreatorStore } from "./store.js"

/**
 * This PC's side of extensions on SSH hosts (17 §10): what each host may have of the store, read only. The broker
 * (own-accounts) asks through {@link CreatorBridge}: `creator.get` gets {@link view}, `creator.file` one chunk of a file
 * that view names ({@link file}); nothing a host sends writes the store (its `creator.report` stays in memory).
 *
 * An extension reaches a host when it is in force here (status `active`; for C3 intact with the switch on), the host
 * selection includes the host, and its scope is every project or names folders of that host. C3 goes only with the
 * user's allowance of the active version for that host; it is PC-only otherwise and its files are never offered.
 * Approved allow rules (`loosen`) go to a host only with that host's allowance of the version too (CRM-33): this PC's
 * approval is about this PC's conversations, and a host's baseline asks stay until the user allows the host.
 */

export interface Reach {
  readonly reach: Creator.HostReach
  /** `sent`: the host's folders of the scope (empty = every project there). */
  readonly projects: ReadonlyArray<string>
  readonly hostTrusted: boolean
}

/** Whether `loaded` reaches `hostId`, and with which folders. */
export function reach(snapshot: CreatorStore.Snapshot, loaded: CreatorStore.Loaded, hostId: string): Reach {
  const no = (value: Creator.HostReach): Reach => ({ reach: value, projects: [], hostTrusted: false })
  const entry = loaded.entry
  const extension = loaded.extension
  if (extension === undefined) return no("inactive")
  const plugin = Creator.kindOf(extension) === "plugin"
  // A C3 version waiting for this PC's own approval may still be allowed on a host; anything else must be in force.
  const inForce = plugin ? loaded.status === "active" || loaded.status === "pending" : loaded.status === "active"
  if (!inForce) return no(plugin && loaded.status === "unavailable" ? "pc_only" : "inactive")
  if (!Creator.reaches(Creator.hostsOf(entry), hostId)) return no("excluded")
  const hostTrusted = entry.hostTrusted.some((item) => item.host === hostId && item.n === entry.active)
  if (plugin && (!hostTrusted || snapshot.file.settings?.plugins !== true)) return no("pc_only")
  const scoped = entry.projects.length + entry.hostProjects.length > 0
  const folders = entry.hostProjects.filter((item) => item.host === hostId).map((item) => item.directory)
  if (scoped && folders.length === 0) return no("out_of_scope")
  return { reach: "sent", projects: folders, hostTrusted }
}

/** The extensions that reach `hostId`, with their active version's record and files. */
export async function view(store: CreatorStore.Store, snapshot: CreatorStore.Snapshot, hostId: string) {
  const extensions: Creator.MirrorEntry[] = []
  for (const loaded of snapshot.loaded) {
    const decided = reach(snapshot, loaded, hostId)
    const info = loaded.entry.versions.find((version) => version.n === loaded.entry.active)
    if (decided.reach !== "sent" || info === undefined || loaded.extension === undefined) continue
    const files = await list(store.versionDir(loaded.entry.id, info.n))
    if (files === undefined) continue
    extensions.push({
      id: loaded.entry.id,
      kind: Creator.kindOf(loaded.extension),
      version: info,
      files,
      projects: [...decided.projects],
      loosen: loaded.entry.loosen.includes(info.n) && decided.hostTrusted,
      hostTrusted: decided.hostTrusted,
    })
  }
  const body = { plugins: snapshot.file.settings?.plugins === true, extensions }
  return { revision: Hash.stable(body), ...body } satisfies Creator.MirrorView
}

/**
 * The files of a version folder, sorted, `/`-separated; `undefined` when it holds a link or is over the mirror's limits
 * (such a version is not sent).
 */
export async function list(dir: string): Promise<Creator.MirrorFile[] | undefined> {
  const found: Creator.MirrorFile[] = []
  const walk = async (folder: string, prefix: string): Promise<boolean> => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => undefined)
    if (entries === undefined) return false
    for (const entry of entries) {
      const full = path.join(folder, entry.name)
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      const stat = await fs.lstat(full)
      if (stat.isSymbolicLink()) return false
      if (stat.isDirectory()) {
        if (!(await walk(full, rel))) return false
        continue
      }
      if (!stat.isFile()) return false
      found.push({ path: rel, size: stat.size })
    }
    return true
  }
  if (!(await walk(dir, ""))) return undefined
  const bytes = found.reduce((sum, file) => sum + file.size, 0)
  if (found.length > Creator.MIRROR_LIMITS.files || bytes > Creator.MIRROR_LIMITS.bytes) return undefined
  return found.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** One chunk of a file `view` names (else `undefined`): read only, from the version folder. */
export async function file(
  store: CreatorStore.Store,
  current: Creator.MirrorView,
  request: Broker.CreatorFile,
): Promise<Broker.CreatorChunk | undefined> {
  const entry = current.extensions.find((item) => item.id === request.id && item.version.n === request.n)
  const listed = entry?.files.find((item) => item.path === request.path)
  if (entry === undefined || listed === undefined) return undefined
  const target = path.join(store.versionDir(entry.id, entry.version.n), ...listed.path.split("/"))
  // Still the plain file of the listed size: a link put there after the view was built is not followed.
  const stat = await fs.lstat(target).catch(() => undefined)
  if (stat === undefined || !stat.isFile() || stat.size !== listed.size) return undefined
  const handle = await fs.open(target, "r").catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const size = (await handle.stat()).size
    const length = Math.max(0, Math.min(Creator.MIRROR_LIMITS.chunk, size - request.offset))
    const buffer = Buffer.alloc(length)
    const read = length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, request.offset)
    const end = request.offset + read.bytesRead >= size
    return { data: buffer.subarray(0, read.bytesRead).toString("base64"), size, end }
  } finally {
    await handle.close()
  }
}

/**
 * Publishes this store as the PC's source on the bridge (17 §10). Views are kept per host until the store changes
 * (`invalidate`): a host fetching a version asks for many chunks, and each answer must come from the view it was sent.
 */
export function provide(store: CreatorStore.Store) {
  const cache = new Map<string, Promise<Creator.MirrorView>>()
  const current = (hostId: string) => {
    const cached = cache.get(hostId)
    if (cached !== undefined) return cached
    const created = store.read().then((snapshot) => view(store, snapshot, hostId))
    cache.set(hostId, created)
    created.catch(() => cache.delete(hostId))
    return created
  }
  const undo = CreatorBridge.provideSource({
    view: (hostId) => current(hostId),
    file: async (hostId, request) => file(store, await current(hostId), request),
  })
  return {
    /** The store changed: views are built again and every host asks again. */
    invalidate: () => {
      cache.clear()
      CreatorBridge.changed()
    },
    close: undo,
  }
}

/**
 * The host lines of every extension's card (17 §10): each host the broker serves or that reported, with the PC's
 * decision and the host's last report. A report is shown for the version in force here; one of another version waits
 * for the host's next sync. When the PC no longer sends an extension but the host's last report still has it applied
 * (`active`), the line keeps that state: the host runs it until it syncs again (offline, another build, CRM-34), and
 * Settings says so instead of showing it gone.
 */
export function hostViews(snapshot: CreatorStore.Snapshot) {
  const reports = CreatorBridge.reports()
  const served = CreatorBridge.hosts()
  const ids = [...new Set([...served.map((host) => host.id), ...reports.keys()])].toSorted()
  const hosts = ids.map((id) => {
    const reportedAt = reports.get(id)?.at
    return {
      id,
      connected: served.some((host) => host.id === id && host.connected),
      ...(reportedAt === undefined ? {} : { reportedAt }),
    }
  })
  const lines = (loaded: CreatorStore.Loaded) =>
    ids.map((host) => {
      const decided = reach(snapshot, loaded, host)
      const state = reports.get(host)?.extensions.find((item) => item.id === loaded.entry.id)
      const shown =
        state !== undefined &&
        (decided.reach === "sent" ? state.n === loaded.entry.active : state.status === "active")
      return {
        host,
        reach: decided.reach,
        ...(!shown ? {} : { state: { ...state, problems: state.problems.map((problem) => ({ ...problem })) } }),
      }
    })
  return { hosts, lines }
}
