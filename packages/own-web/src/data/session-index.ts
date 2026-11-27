// Root session list of one server with stale-while-revalidate (03 §4.3, 20.1 PF1): paint the IndexedDB snapshot
// first, replace it with the server list on every `server.connected`, keep it current from events, and persist it
// when idle. Normalized by id; `order` is kept incrementally (newest first) instead of re-sorting a derived list.
// own.import's hidden summary helpers (09 §4.4, §6 숨김) never become rows, whatever their archive time says; the
// ids seen (their `session.created`, `job.progress{helperSessionID}`) are kept so other screens can ask
// (`isHelperSession`).
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { batch } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import type { EventBus } from "./events"
import { importEvent, isImportHelper } from "./import-rpc"
import { CACHE_ROWS, type ProjectRow, type SessionListCache, type SessionRow } from "./session-cache"

export type IndexSource = "empty" | "cache" | "server"

export interface SessionIndexState {
  source: IndexSource
  /** Snapshot time when `source` is "cache". */
  savedAt?: number
  sessions: Record<string, SessionRow>
  /** Root session ids, newest `updated` first. */
  order: string[]
  projects: Record<string, ProjectRow>
  /** Cursor for the next server page, `null` when the list is complete. */
  next: string | null
  loading: boolean
  error?: string
}

const PAGE = 50
const PERSIST_DELAY = 1_000

/** own.import helper sessions each server's index saw (09 §6 숨김), for screens knowing only the server and id. */
const helperIDs = new Map<string, ReadonlySet<string>>()

/** An own.import summary helper of this server: no screen shows it, nor notifies for it. */
export function isHelperSession(serverKey: string, sessionID: string) {
  return helperIDs.get(serverKey)?.has(sessionID) ?? false
}

export function createSessionIndex(input: {
  readonly serverKey: string
  readonly client: () => OpenCodeClient
  readonly bus: EventBus
  readonly cache: SessionListCache
  /** Called when rows land: once from the cache, then after every server list (PF1 marks, 03 §20.3). */
  readonly onRows?: (source: Exclude<IndexSource, "empty">) => void
}) {
  const [state, setState] = createStore<SessionIndexState>({
    source: "empty",
    sessions: {},
    order: [],
    projects: {},
    next: null,
    loading: false,
  })
  let persistTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const fresh = Promise.withResolvers<void>()
  /** own.import helper sessions seen on this server (09 §6 숨김). */
  const helpers = new Set<string>()
  helperIDs.set(input.serverKey, helpers)
  /** A session the list may show: not a helper (remembered when it is one). */
  function listable(info: SessionInfo) {
    if (!isImportHelper(info.metadata)) return true
    helpers.add(info.id)
    return false
  }

  const ready = input.cache.read(input.serverKey).then((cached) => {
    if (disposed || !cached || state.source !== "empty") return
    batch(() => {
      setState("sessions", reconcile(Object.fromEntries(cached.sessions.map((row) => [row.id, row]))))
      setState("order", sortedIDs(cached.sessions))
      setState("projects", reconcile(Object.fromEntries(cached.projects.map((row) => [row.id, row]))))
      setState({ source: "cache", savedAt: cached.savedAt })
    })
    input.onRows?.("cache")
  })

  async function revalidate() {
    setState("loading", true)
    try {
      const [projects, page] = await Promise.all([
        input.client().project.list(),
        input.client().session.list({ parentID: null, limit: PAGE, order: "desc" }),
      ])
      if (disposed) return
      const rows = page.data.filter(listable).map(toRow)
      batch(() => {
        setState(
          "projects",
          reconcile(Object.fromEntries(projects.map((project) => [project.id, projectRow(project)]))),
        )
        setState("sessions", reconcile(Object.fromEntries(rows.map((row) => [row.id, row]))))
        setState("order", reconcile(sortedIDs(rows)))
        setState({ source: "server", savedAt: undefined, next: page.cursor.next ?? null, error: undefined })
      })
      input.onRows?.("server")
      fresh.resolve()
      schedulePersist()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("loading", false)
    }
  }

  function upsert(row: SessionRow) {
    if (row.parentID) return
    batch(() => {
      setState("sessions", row.id, reconcile(row))
      if (row.archived === undefined) return place(row.id, row.updated)
      setState("order", (order) => order.filter((id) => id !== row.id))
    })
    schedulePersist()
  }

  function patch(sessionID: string, fields: Partial<SessionRow>, touched?: number) {
    if (!state.sessions[sessionID]) return
    batch(() => {
      setState("sessions", sessionID, (row) => ({ ...row, ...fields, updated: touched ?? row.updated }))
      if (touched !== undefined) place(sessionID, touched)
    })
    schedulePersist()
  }

  function place(sessionID: string, updated: number) {
    setState(
      "order",
      produce((order) => {
        const from = order.indexOf(sessionID)
        if (from >= 0) order.splice(from, 1)
        const to = order.findIndex((id) => (state.sessions[id]?.updated ?? 0) < updated)
        order.splice(to < 0 ? order.length : to, 0, sessionID)
      }),
    )
  }

  function remove(sessionID: string) {
    if (!state.sessions[sessionID]) return
    batch(() => {
      setState("order", (order) => order.filter((id) => id !== sessionID))
      setState(
        "sessions",
        produce((sessions) => void delete sessions[sessionID]),
      )
    })
    schedulePersist()
  }

  async function fetchRow(sessionID: string) {
    try {
      const info = await input.client().session.get({ sessionID })
      if (!disposed && listable(info)) upsert(toRow(info))
    } catch (error) {
      console.error("[own-web] session lookup failed", sessionID, error)
    }
  }

  // Persist when the page is idle; writes never compete with input (03 §20.2 R6, R8).
  function schedulePersist() {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => idle(persist), PERSIST_DELAY)
  }

  function persist() {
    if (disposed || state.source !== "server") return
    // Plain copies: store proxies cannot be structured-cloned into IndexedDB.
    const raw = unwrap(state)
    const sessions = raw.order.slice(0, CACHE_ROWS).flatMap((id) => {
      const row = raw.sessions[id]
      return row ? [structuredClone(row)] : []
    })
    void input.cache.write({
      serverKey: input.serverKey,
      savedAt: Date.now(),
      sessions,
      projects: Object.values(raw.projects).map((project) => structuredClone(project)),
    })
  }

  const unsubscribe = [
    input.bus.on("server.connected", () => void revalidate()),
    input.bus.on("session.created", (event) => {
      if (isImportHelper(event.data.metadata)) return void helpers.add(event.data.sessionID)
      if (!event.data.parentID) void fetchRow(event.data.sessionID)
    }),
    // A helper made before this window listened (a reload during a job) is named by the job's progress.
    input.bus.listen((raw) => {
      const event = importEvent(raw)
      if (event?.name === "job.progress" && event.data.helperSessionID) helpers.add(event.data.helperSessionID)
    }),
    input.bus.on("session.renamed", (event) => patch(event.data.sessionID, { title: event.data.title }, event.created)),
    input.bus.on("session.model.selected", (event) => patch(event.data.sessionID, { model: event.data.model })),
    input.bus.on("session.moved", (event) =>
      patch(event.data.sessionID, { directory: event.data.location.directory, projectID: event.data.projectID }),
    ),
    input.bus.on("session.status", (event) =>
      patch(
        event.data.sessionID,
        { status: event.data.status.type },
        event.data.status.type === "busy" ? event.created : undefined,
      ),
    ),
    // Core does not publish `session.status`: a turn starting moves the row to the top (03 §4.3, newest activity
    // first), and its end records the outcome for the cached row.
    input.bus.on("session.execution.started", (event) =>
      patch(event.data.sessionID, { status: "busy", outcome: undefined }, event.created),
    ),
    input.bus.on("session.execution.succeeded", (event) =>
      patch(event.data.sessionID, { status: "idle", outcome: "succeeded" }),
    ),
    input.bus.on("session.execution.failed", (event) =>
      patch(event.data.sessionID, { status: "idle", outcome: "failed" }),
    ),
    input.bus.on("session.execution.interrupted", (event) =>
      patch(event.data.sessionID, { status: "idle", outcome: "interrupted" }),
    ),
    input.bus.on("session.deleted", (event) => {
      helpers.delete(event.data.sessionID)
      remove(event.data.sessionID)
    }),
    // 19.11: the own pin/archive flags ride on the row (the sidebar reads them from here); a fork is a new root row.
    input.bus.on("session.metadata.updated", (event) =>
      patch(event.data.sessionID, { metadata: ownFlags(event.data.metadata) }),
    ),
    input.bus.on("session.forked", (event) => void fetchRow(event.data.sessionID)),
  ]

  return {
    state,
    /** Resolves after the cache read (for tests and the first-paint mark). */
    ready,
    /** Resolves after the first server list arrived. */
    fresh: fresh.promise,
    revalidate,
    /** Next page of root sessions (sidebar "more"). */
    async loadMore() {
      if (!state.next || state.loading) return
      setState("loading", true)
      try {
        const page = await input.client().session.list({ cursor: state.next })
        batch(() => {
          for (const row of page.data.filter(listable).map(toRow)) upsert(row)
          setState("next", page.cursor.next ?? null)
        })
      } finally {
        setState("loading", false)
      }
    },
    directory(sessionID: string) {
      return state.sessions[sessionID]?.directory
    },
    /** Directories the UI already knows (control-location fallback, 02 §9.1). */
    directories() {
      return [...new Set(Object.values(state.projects).map((project) => project.directory))]
    },
    dispose() {
      disposed = true
      if (helperIDs.get(input.serverKey) === helpers) helperIDs.delete(input.serverKey)
      clearTimeout(persistTimer)
      unsubscribe.forEach((stop) => stop())
    },
  }
}

export type SessionIndex = ReturnType<typeof createSessionIndex>

export function toRow(info: SessionInfo): SessionRow {
  return {
    id: info.id,
    title: info.title,
    created: info.time.created,
    updated: info.time.updated,
    projectID: info.projectID,
    directory: info.location.directory,
    parentID: info.parentID,
    model: info.model
      ? { providerID: info.model.providerID, id: info.model.id, variant: info.model.variant }
      : undefined,
    archived: info.time.archived,
    metadata: ownFlags(info.metadata),
    outcome: info.outcome,
  }
}

function projectRow(project: { id: string; name?: string; canonical: string }): ProjectRow {
  return { id: project.id, name: project.name, directory: project.canonical }
}

function sortedIDs(rows: readonly SessionRow[]) {
  return rows
    .filter((row) => !row.parentID && row.archived === undefined)
    .toSorted((a, b) => b.updated - a.updated)
    .map((row) => row.id)
}

function idle(fn: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2_000 })
  else setTimeout(fn, 0)
}

/** The own namespace flags of a session's metadata (03 §19.11, 01 §17.1 #27) that list rows carry. */
const OWN_FLAGS = ["own.pinned", "own.archived", "own.archivedWithProject"] as const

function ownFlags(metadata: SessionInfo["metadata"] | undefined): NonNullable<SessionRow["metadata"]> {
  return Object.fromEntries(
    OWN_FLAGS.flatMap((key) => {
      const value = metadata?.[key]
      return typeof value === "number" || typeof value === "boolean" ? [[key, value] as const] : []
    }),
  )
}
