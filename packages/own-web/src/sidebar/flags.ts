// Session pin and archive flags (03 §19.11, 01 §17.1 #27). v2 has no archive API, so both live in the session's
// metadata under the own namespace: `own.pinned` / `own.archived` = the epoch ms they were set (absent = off).
//
// - Writing: `PATCH /api/session/:id {metadata}` replaces the whole metadata object (core `Session.setMetadata`), so
//   every write reads the current metadata first and changes only its own key; other hosts' keys survive.
// - Reading: `session.metadata.updated` events carry the full metadata (authoritative, every window), and so does
//   every `SessionInfo` this module sees (server search hits, pinned/archived lookups, the connect scan). The last
//   known flags are kept per server in localStorage (per-viewer cache, never secret: ids and times) so the pinned
//   group and hidden archived rows paint before the service answers (PF1).
// - Forks and children copy the parent's metadata (schema `SessionMetadata`), so a fork's flags are cleared as soon
//   as `session.forked` arrives (01 §17.1: "포크하면 이 플래그를 지운다"). Children are never list rows; their
//   inherited flags are ignored.
// - The same goes for own.team's role hint (`TEAM_META.session`, 06 §9.4): a fork of a team main or owner is not the
//   team's, so the fork loses the hint; a child keeps what it copied, and every screen ignores it there (the role
//   comes from the registry, team/store.ts).
// - own.import's hidden summary helpers (09 §4.4, §6 숨김) never get flags: they are never rows anywhere.
// - `프로젝트 보관` (03 §19.11a) archives every root session of a project with one stamp and also writes
//   `own.archivedWithProject` (the same stamp); `프로젝트 복원` takes back exactly those. Unarchiving one session drops
//   both keys, so it leaves the project archive.
import type { JsonValue, OpenCodeClient, SessionInfo } from "@opencode/client"
import { batch, createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { EventBus } from "@/data/events"
import { isImportHelper } from "@/data/import-rpc"
import { TEAM_META } from "@/data/team-rpc"

export type FlagKey = "pinned" | "archived"

export const FLAG_KEYS = { pinned: "own.pinned", archived: "own.archived" } as const satisfies Record<FlagKey, string>

/** Set next to `own.archived` (same stamp) on the sessions `프로젝트 보관` archived. */
export const PROJECT_ARCHIVE_KEY = "own.archivedWithProject"

export interface OwnFlags {
  readonly pinned?: number
  readonly archived?: number
  /** Archived with its project (`프로젝트 보관`), not on its own. */
  readonly project?: number
}

type Metadata = Readonly<Record<string, JsonValue>>

/** Flags in a metadata object (unknown input: event payloads, rows of other clients). */
export function flagsOf(metadata: unknown): OwnFlags {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return {}
  return {
    pinned: FLAG_KEYS.pinned in metadata ? stamp(metadata[FLAG_KEYS.pinned]) : undefined,
    archived: FLAG_KEYS.archived in metadata ? stamp(metadata[FLAG_KEYS.archived]) : undefined,
    project: PROJECT_ARCHIVE_KEY in metadata ? stamp(metadata[PROJECT_ARCHIVE_KEY]) : undefined,
  }
}

/**
 * `metadata` with one flag set (`at`) or removed (`undefined`); every other key unchanged. Unarchiving also drops the
 * project-archive mark: the session is back on its own.
 */
export function withFlag(
  metadata: Metadata | undefined,
  key: FlagKey,
  at: number | undefined,
): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = { ...metadata }
  if (at === undefined) delete next[FLAG_KEYS[key]]
  else next[FLAG_KEYS[key]] = at
  if (key === "archived" && at === undefined) delete next[PROJECT_ARCHIVE_KEY]
  return next
}

/** `metadata` archived together with its project (`at`), or taken out of that archive (`undefined`). */
export function withProjectArchive(metadata: Metadata | undefined, at: number | undefined) {
  const next = withFlag(metadata, "archived", at)
  if (at !== undefined) next[PROJECT_ARCHIVE_KEY] = at
  return next
}

/**
 * `metadata` without both flags and own.team's role hint (what a fork must not keep), or `undefined` when it has none
 * of them (nothing to write).
 */
export function withoutFlags(metadata: Metadata | undefined) {
  const flags = flagsOf(metadata)
  const team = metadata !== undefined && TEAM_META.session in metadata
  if (flags.pinned === undefined && flags.archived === undefined && flags.project === undefined && !team)
    return undefined
  const next = withFlag(withFlag(metadata, "pinned", undefined), "archived", undefined)
  delete next[TEAM_META.session]
  return next
}

function stamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (value === true) return 1
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------

export interface FlagState {
  pinned: Record<string, number>
  archived: Record<string, number>
  /** Sessions archived with their project (`프로젝트 보관`). */
  project: Record<string, number>
}

/** Archived ids kept in the local cache (pinned ones are few and all kept). */
const ARCHIVED_LIMIT = 500
const SAVE_DELAY = 800
/** Parallel metadata writes of a bulk change (`프로젝트 보관`, `선택한 n개 보관 해제`). */
const WRITE_CONCURRENCY = 4

export function createOwnFlags(input: {
  readonly serverKey: string
  readonly bus: EventBus
  readonly client: () => OpenCodeClient
  /** A write failed (the flag is back to its previous value). */
  readonly onError?: (key: FlagKey, on: boolean) => void
}) {
  const storageKey = `own.web.sidebar.flags.${input.serverKey}`
  const [state, setState] = createStore<FlagState>(load(storageKey))
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle(() => write(storageKey, trimmed(state))), SAVE_DELAY)
  }

  function apply(sessionID: string, flags: OwnFlags) {
    // The project mark only means something next to `own.archived`.
    const project = flags.archived === undefined ? undefined : flags.project
    if (
      state.pinned[sessionID] === flags.pinned &&
      state.archived[sessionID] === flags.archived &&
      state.project[sessionID] === project
    )
      return
    setState(
      produce((draft) => {
        if (flags.pinned === undefined) delete draft.pinned[sessionID]
        else draft.pinned[sessionID] = flags.pinned
        if (flags.archived === undefined) delete draft.archived[sessionID]
        else draft.archived[sessionID] = flags.archived
        if (project === undefined) delete draft.project[sessionID]
        else draft.project[sessionID] = project
      }),
    )
    save()
  }

  const current = (sessionID: string): OwnFlags => ({
    pinned: state.pinned[sessionID],
    archived: state.archived[sessionID],
    project: state.project[sessionID],
  })

  /** Authoritative flags of one session from its full metadata. */
  function ingest(sessionID: string, metadata: unknown) {
    apply(sessionID, flagsOf(metadata))
  }

  /** Full session infos (search hits, lookups, list pages): root sessions only, never own.import's helpers. */
  function ingestInfos(infos: readonly SessionInfo[]) {
    batch(() => {
      for (const info of infos) {
        if (info.parentID || isImportHelper(info.metadata)) forget(info.id)
        else ingest(info.id, info.metadata)
      }
    })
  }

  function forget(sessionID: string) {
    if (state.pinned[sessionID] === undefined && state.archived[sessionID] === undefined) return
    apply(sessionID, {})
  }

  /**
   * Archives root sessions together with their project (`on`), or takes them out of it, from full infos (a project's
   * `session.list` pages carry the metadata, so there is no read per session). Shown at once; a failed write puts
   * that session back. Answers the ids written and the ids that failed.
   */
  async function setProject(infos: readonly SessionInfo[], on: boolean) {
    const at = on ? Date.now() : undefined
    const previous = new Map(infos.map((info) => [info.id, current(info.id)]))
    batch(() => infos.forEach((info) => apply(info.id, { ...previous.get(info.id), archived: at, project: at })))
    const queue = [...infos]
    const done: string[] = []
    const failed: string[] = []
    const worker = async () => {
      for (let info = queue.shift(); info !== undefined; info = queue.shift()) {
        const sessionID = info.id
        const ok = await input
          .client()
          .session.update({ sessionID, metadata: withProjectArchive(info.metadata, at) })
          .then(
            () => true,
            (error: unknown) => {
              console.warn("[own-web] project archive write failed", sessionID, error)
              return false
            },
          )
        if (ok) done.push(sessionID)
        else {
          failed.push(sessionID)
          apply(sessionID, previous.get(sessionID) ?? {})
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, infos.length) }, worker))
    return { done, failed }
  }

  /** {@link set} for several sessions, a few at a time; answers the ids that failed. */
  async function setMany(sessionIDs: readonly string[], key: FlagKey, on: boolean) {
    const queue = [...sessionIDs]
    const failed: string[] = []
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) if (!(await set(id, key, on))) failed.push(id)
    }
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, sessionIDs.length) }, worker))
    return failed
  }

  /**
   * Sets or clears one flag: shown at once, then written as read-modify-write of the metadata. A failed write puts
   * the previous value back and reports it.
   */
  async function set(sessionID: string, key: FlagKey, on: boolean) {
    const previous = current(sessionID)
    const at = on ? Date.now() : undefined
    apply(sessionID, { ...previous, [key]: at })
    try {
      const client = input.client()
      const info = await client.session.get({ sessionID })
      await client.session.update({ sessionID, metadata: withFlag(info.metadata, key, at) })
      return true
    } catch (error) {
      console.warn("[own-web] session flag write failed", key, error)
      apply(sessionID, previous)
      input.onError?.(key, on)
      return false
    }
  }

  /**
   * A fork (or anything created from a flagged session) starts unpinned, unarchived and outside any team. A child is
   * left as it is: it is never a list row, and its copied team hint is ignored everywhere.
   */
  async function clearCopied(sessionID: string) {
    try {
      const client = input.client()
      const info = await client.session.get({ sessionID })
      if (info.parentID) return
      const metadata = withoutFlags(info.metadata)
      apply(sessionID, {})
      if (metadata) await client.session.update({ sessionID, metadata })
    } catch (error) {
      console.warn("[own-web] clearing fork flags failed", sessionID, error)
    }
  }

  const stops = [
    input.bus.on("session.metadata.updated", (event) => ingest(event.data.sessionID, event.data.metadata)),
    input.bus.on("session.created", (event) => {
      if (!event.data.parentID && !isImportHelper(event.data.metadata))
        ingest(event.data.sessionID, event.data.metadata)
    }),
    input.bus.on("session.forked", (event) => void clearCopied(event.data.sessionID)),
    input.bus.on("session.deleted", (event) => forget(event.data.sessionID)),
  ]

  return {
    state,
    pinned: (sessionID: string) => state.pinned[sessionID] !== undefined,
    archived: (sessionID: string) => state.archived[sessionID] !== undefined,
    /** Archived with its project (`프로젝트 보관`). */
    projectArchived: (sessionID: string) => state.project[sessionID] !== undefined,
    /** Archived ids, most recently archived first. */
    archivedIDs: () => Object.keys(state.archived).toSorted((a, b) => state.archived[b]! - state.archived[a]!),
    pinnedIDs: () => Object.keys(state.pinned),
    ingest,
    ingestInfos,
    forget,
    set,
    setMany,
    setProject,
    clearCopied,
    dispose() {
      clearTimeout(timer)
      stops.forEach((stop) => stop())
    },
  }
}

export type OwnFlagStore = ReturnType<typeof createOwnFlags>

function trimmed(state: FlagState): FlagState {
  const all = Object.entries(state.archived)
  const archived = Object.fromEntries(
    all.length > ARCHIVED_LIMIT ? all.toSorted((a, b) => b[1] - a[1]).slice(0, ARCHIVED_LIMIT) : all,
  )
  return {
    pinned: { ...state.pinned },
    archived,
    project: Object.fromEntries(Object.entries(state.project).filter(([id]) => id in archived)),
  }
}

function load(key: string): FlagState {
  const empty: FlagState = { pinned: {}, archived: {}, project: {} }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (typeof value !== "object" || value === null) return empty
    return {
      pinned: "pinned" in value ? stamps(value.pinned) : {},
      archived: "archived" in value ? stamps(value.archived) : {},
      project: "project" in value ? stamps(value.project) : {},
    }
  } catch {
    return empty
  }
}

function stamps(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, at]) => {
      const valid = stamp(at)
      return valid === undefined ? [] : [[id, valid] as const]
    }),
  )
}

function write(key: string, value: FlagState) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function idle(fn: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2_000 })
  else setTimeout(fn, 0)
}

// ---------------------------------------------------------------------------------------------------------------
// The live flag store of each server tree, for the other entry points of 19.11 (the session header `⋯`, the palette):
// one store per server, so a pin from the header shows in the sidebar at once and a failed write rolls back there.

const live = createRoot(() => {
  const [stores, setStores] = createSignal<ReadonlyMap<string, OwnFlagStore>>(new Map())
  return { stores, setStores }
})

/** Called by the sidebar controller for its lifetime; returns the removal. */
export function registerFlagStore(serverKey: string, store: OwnFlagStore) {
  live.setStores((current) => new Map(current).set(serverKey, store))
  return () =>
    live.setStores((current) => {
      if (current.get(serverKey) !== store) return current
      const next = new Map(current)
      next.delete(serverKey)
      return next
    })
}

/** The flag store of a server's tree (`undefined` until the sidebar mounted it). */
export function sessionFlags(serverKey: string) {
  return live.stores().get(serverKey)
}
