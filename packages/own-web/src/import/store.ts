// own.import state of one server for the first chunk (09 §6 들어가는 곳 1–4): whether own.import is there and this
// connection may list (`health` plus the scope table, 09 §5.5), the sidebar's `새 N개` per project (also entry 4's
// count on an empty new conversation), and the per-viewer setting `사이드바에 보이기`. Nothing is asked at startup
// (03 §20.2 R8): an open project row, entry 4, a project menu or the palette asks once the session list was painted
// (PF1 `own:sessions-visible`) and the page is idle; the import page asks at once. `index.changed` (09 §5.3) refreshes
// the counts it concerns, a succeeded `job.finished` every watched one. Types only from the protocol (R5).
import { createEffect, createRoot, createSignal, on } from "solid-js"
import { createStore } from "solid-js/store"
import { importEvent, type ImportOutput, type ImportRpc, type ServerRuntime } from "@/data"
import type { EventBus } from "@/data/events"
import { markTime } from "@/perf/marks"
import { samePath } from "@/projects/path"

export type ImportHealth = ImportOutput<"health">

/** One key per conversation of another tool: its kind, root and id (09 §5.2 `SourceRef`). */
export function refKey(ref: { readonly kind: string; readonly rootID: string; readonly id: string }) {
  return `${ref.kind}/${ref.rootID}/${ref.id}`
}

/**
 * What this server's own.import offers this connection (09 §5.5): its build's features and the method scopes. With
 * the I2 scopes (Q2) a gateway device with `read` lists, views and searches its projects' conversations, with `prompt`
 * it also moves them; `sources.configure` and the `모든 폴더` view (`scope: "all"`, every conversation on the PC) stay
 * `local`, this PC's windows only.
 */
export function importGates(health: ImportHealth | null | undefined, allowed: ImportRpc["allowed"]) {
  const has = (feature: ImportHealth["features"][number]) => !!health && health.features.includes(feature)
  return {
    list: !!health && allowed("sessions.list"),
    view: has("view") && allowed("sessions.read"),
    search: has("search") && allowed("sessions.search"),
    roots: !!health && allowed("sources.list"),
    configure: !!health && allowed("sources.configure"),
    allFolders: !!health && allowed("sessions.list", { scope: "all" }),
    migrate: has("migrate") && allowed("migrate.plan"),
  }
}

export interface ImportStoreInput {
  readonly rpc: Pick<ImportRpc, "call" | "allowed">
  readonly bus: Pick<EventBus, "listen">
  readonly connected: () => boolean
  /** Runs deferred questions (after the list paint, when idle); tests run them at once. */
  readonly later?: (run: () => void) => void
}

export type ImportStore = ReturnType<typeof createImportStore>

export function createImportStore(input: ImportStoreInput) {
  const later = input.later ?? afterListPaint
  const [state, setState] = createStore<{
    /** `undefined`: not asked yet; `null`: no own.import here (an RPC error, an SSH host, an old service). */
    health: ImportHealth | null | undefined
    /** projectID → conversations not imported yet (`sessions.list{limit: 0}.fresh`). */
    fresh: Record<string, number>
  }>({ health: undefined, fresh: {} })
  /** Projects whose `새 N개` is shown somewhere: projectID → the folder its list is asked for. */
  const watched = new Map<string, string>()
  const due = new Set<string>()
  let asking: Promise<ImportHealth | null> | undefined
  let flushing = false

  function ensure(): Promise<ImportHealth | null> {
    if (state.health !== undefined) return Promise.resolve(state.health)
    if (!input.connected()) return Promise.resolve(null)
    asking ??= input.rpc.call("health", {}).then(
      (health) => settle(health),
      () => settle(null),
    )
    return asking
  }
  function settle(health: ImportHealth | null) {
    asking = undefined
    setState("health", health)
    return health
  }
  const gates = () => importGates(state.health, input.rpc.allowed)
  const available = () => (state.health === undefined ? undefined : gates().list)
  /** A watched project's conversations not imported yet; 0 while unknown, without own.import or not allowed here. */
  const fresh = (projectID: string) => (available() === true ? (state.fresh[projectID] ?? 0) : 0)

  /** Counts the due projects once own.import answered; one deferred pass however many rows asked. */
  function schedule(projectID: string) {
    due.add(projectID)
    if (flushing) return
    flushing = true
    later(() => {
      flushing = false
      void flush()
    })
  }
  async function flush() {
    const health = await ensure()
    if (!health || !input.rpc.allowed("sessions.list")) return due.clear()
    const projects = [...due]
    due.clear()
    for (const projectID of projects) {
      const directory = watched.get(projectID)
      if (!directory) continue
      const output = await input.rpc.call("sessions.list", { directory, limit: 0 }).catch(() => undefined)
      if (output) setState("fresh", projectID, output.fresh)
    }
  }

  const stop = input.bus.listen((raw) => {
    const event = importEvent(raw)
    // An import that succeeded made a conversation `가져옴`, which is no longer new (09 §6 entry 1); own.import says
    // nothing else about it (`index.changed` is about the sources), and the job does not name its project here.
    if (event?.name === "job.finished" && event.data.outcome === "succeeded") {
      for (const projectID of watched.keys()) schedule(projectID)
      return
    }
    if (event?.name !== "index.changed" || watched.size === 0) return
    const named = event.data.directories
    const matching = named
      ? [...watched].filter(([, directory]) => named.some((item) => samePath(item, directory)))
      : []
    // Without a named folder of a watched project (or with none named), any watched list may have changed.
    for (const [projectID] of matching.length ? matching : watched) schedule(projectID)
  })

  // Rows that asked before the connection was up are counted once it is; a service restart can bring own.import (or
  // take it away), so a reconnect asks `health` again.
  const dispose = createRoot((dispose) => {
    createEffect(
      on(input.connected, (connected, was) => {
        // `was` is undefined on the first run: only a change from disconnected counts.
        if (!connected || was !== false) return
        if (state.health !== undefined) setState("health", undefined)
        for (const projectID of watched.keys()) schedule(projectID)
      }),
    )
    return dispose
  })

  return {
    state,
    /** own.import's `health`: `undefined` until asked, `null` when absent. */
    health: () => state.health,
    /** Entries 1–3 (09 §6): own.import is there and this connection may list (`undefined` while unknown). */
    available,
    /** The screens' gates (list, view, search, roots, configure, migrate) for this connection. */
    gates,
    /** Asks `health` now (the import pages). */
    ensure,
    /** Asks `health` after the list paint, when idle (the project menu, the palette). */
    prepare() {
      if (state.health === undefined && !asking) later(() => void ensure())
    },
    /** An open project row (entry 1): counts its `새 N개` after the list paint and on every related `index.changed`. */
    watch(projectID: string, directory: string) {
      const known = watched.get(projectID)
      if (known !== undefined && samePath(known, directory)) return
      watched.set(projectID, directory)
      schedule(projectID)
    },
    /** The sidebar row's N; 0 hides the row: nothing new, the setting off, own.import absent or not allowed here. */
    entry(projectID: string) {
      return importSidebarShown() ? fresh(projectID) : 0
    },
    /** Entry 4's N (09 §6): the same count, whatever `사이드바에 보이기` says. */
    fresh,
    /** A full list read the same count (the import page keeps the sidebar in step). */
    setFresh(projectID: string, fresh: number) {
      if (watched.has(projectID) || state.fresh[projectID] !== undefined) setState("fresh", projectID, fresh)
    },
    dispose() {
      stop()
      dispose()
      watched.clear()
      due.clear()
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One store per server runtime, made on first use (never at startup).

const stores = new WeakMap<ServerRuntime, ImportStore>()
/** Bumped when a store is made, so a reader that looked before (the sidebar tree) looks again. */
const [made, setMade] = createSignal(0)

export function importStore(runtime: ServerRuntime) {
  const known = stores.get(runtime)
  if (known) return known
  const store = createImportStore({
    rpc: runtime.imports,
    bus: runtime.bus,
    connected: () => runtime.connection.status() === "connected",
  })
  stores.set(runtime, store)
  setMade((value) => value + 1)
  return store
}

/** The sidebar row's N for a project of this server (0: no row); never makes a store. */
export function importEntryCount(runtime: ServerRuntime, projectID: string) {
  made()
  return stores.get(runtime)?.entry(projectID) ?? 0
}

// ---------------------------------------------------------------------------------------------------------------
// 설정 > 다른 도구 > `사이드바에 보이기` (on by default): a per-viewer convenience in localStorage.

const SIDEBAR_KEY = "own.web.import.sidebar"
const [sidebarShown, setSidebarShownSignal] = createSignal(readSidebar())

export const importSidebarShown = sidebarShown

export function setImportSidebarShown(shown: boolean) {
  setSidebarShownSignal(shown)
  try {
    if (shown) return localStorage.removeItem(SIDEBAR_KEY)
    localStorage.setItem(SIDEBAR_KEY, "off")
  } catch {}
}

function readSidebar() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "off"
  } catch {
    return true
  }
}

/**
 * After the session list was painted (PF1 `own:sessions-visible`, 03 §20.3) and the page is idle. A list that never
 * paints (no session yet) does not hold the entries back for longer than a few seconds.
 */
function afterListPaint(run: () => void) {
  const idle = () => {
    if (typeof requestIdleCallback === "function") return void requestIdleCallback(() => run(), { timeout: 2_000 })
    setTimeout(run, 0)
  }
  const painted = () => typeof performance !== "undefined" && markTime("own:sessions-visible") !== undefined
  if (painted() || typeof PerformanceObserver !== "function") return idle()
  let done = false
  const go = () => {
    if (done) return
    done = true
    observer.disconnect()
    clearTimeout(timer)
    idle()
  }
  const observer = new PerformanceObserver(() => {
    if (painted()) go()
  })
  const timer = setTimeout(go, 5_000)
  try {
    observer.observe({ type: "mark", buffered: true })
  } catch {
    go()
  }
}
