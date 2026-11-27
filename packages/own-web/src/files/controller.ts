// State of the files tab for the session on screen (03 §19.4, §19.5): the location's tree, the session's tabs, file
// contents, and the refreshes that stand in for a file watcher.
//
// Watcher: v2 publishes no working-tree events (`filesystem.changed` only follows the VCS HEAD file, core
// `location-watcher.ts`; upstream `open-artifact.tsx` "V2 publishes no workspace file change events"). The tab
// therefore refreshes the expanded folders and the active file on the events that change files: a tool finishing in
// this folder (`session.tool.success`: write/edit/patch/shell), a turn ending, a restore, a `!` shell command, a
// branch switch (`filesystem.changed`, `vcs.branch.updated`), a reconnect, and the window regaining focus (edits made
// in another editor). At most one refresh per REFRESH_MS while a turn streams (20.2 R3), none while the tab is hidden
// (it runs once when the tab shows again), and no timers otherwise (R9).
import { abort } from "@opencode/util/abort"
import { batch, createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useData, type ServerKey } from "@/data"
import { decodeFile, loadsDirect, mediaSource, readUrl, sameContent, viewKind, type FileContent } from "./content"
import { createFileActions } from "./actions"
import { pendingFile, takeFile } from "./intents"
import { dirname, isAbsolute, locate, parseLink } from "./paths"
import { fileTabs } from "./tabs"
import { treeFor } from "./tree"

const REFRESH_MS = 800
const CONTENT_MAX = 24

export type FileEntry =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly content: FileContent; readonly version: number }
  /** Media shown straight from the server URL (content.ts `mediaSource`). */
  | { readonly status: "direct"; readonly url: string; readonly version: number }
  | { readonly status: "missing"; readonly version: number }
  | { readonly status: "outside" }
  | { readonly status: "error"; readonly message: string; readonly version: number }

export function createFilesController(input: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}) {
  const data = useData()
  const runtime = () => data.get(input.serverKey())
  const directory = () => {
    const sessionID = input.sessionID()
    if (!sessionID) return undefined
    const current = runtime()
    return current?.data.session.get(sessionID)?.location.directory ?? current?.sessions.directory(sessionID)
  }
  const sessionKey = () => {
    const sessionID = input.sessionID()
    return sessionID ? `${input.serverKey()}\n${sessionID}` : undefined
  }
  const locationKey = () => {
    const folder = directory()
    return folder ? `${input.serverKey()}\n${folder}` : undefined
  }

  const tree = createMemo(() => {
    const key = locationKey()
    const folder = directory()
    const serverKey = input.serverKey()
    if (!key || !folder) return undefined
    return treeFor(key, async (path) => {
      const client = data.get(serverKey)?.client()
      if (!client) throw new Error("not connected")
      const output = await client.file.list({ location: { directory: folder }, path: path || undefined })
      return output.data
    })
  })
  // The root loads as soon as the tab shows a folder.
  createEffect(() => {
    const current = tree()
    if (current && input.visible() && runtime()?.connection.status() === "connected") void current.load("")
  })

  const tabs = () => {
    const key = sessionKey()
    return key ? fileTabs.get(key) : undefined
  }
  const active = () => {
    const current = tabs()
    return current?.tabs.find((tab) => tab.path === current.active)
  }

  // ---- contents ----
  const [contents, setContents] = createStore<Record<string, FileEntry | undefined>>({})
  const [sync, setSync] = createStore({ version: 0, dirty: false, busy: false })
  const loads = new Map<string, { readonly token: number; readonly version: number; readonly abort: AbortController }>()
  const tokens = { next: 0 }
  const order: string[] = []
  const contentKey = (path: string) => `${locationKey()}\n${path}`
  const source = () => mediaSource(runtime()?.entry(), location.origin)

  function remember(key: string) {
    const index = order.indexOf(key)
    if (index >= 0) order.splice(index, 1)
    order.push(key)
    const open = new Set((tabs()?.tabs ?? []).map((tab) => contentKey(tab.path)))
    const evictable = order.filter((item) => !open.has(item))
    for (const old of evictable.slice(0, Math.max(0, order.length - CONTENT_MAX))) {
      order.splice(order.indexOf(old), 1)
      loads.get(old)?.abort.abort()
      loads.delete(old)
      setContents(old, undefined)
    }
  }

  /** Reads `path` unless it is current; `force` re-reads, `large` decodes text above the automatic limit. */
  function ensure(path: string, options: { readonly force?: boolean; readonly large?: boolean } = {}) {
    const current = runtime()
    const folder = directory()
    if (!current || !folder) return
    const key = contentKey(path)
    const version = sync.version
    const entry = untrack(() => contents[key])
    remember(key)
    if (isAbsolute(path)) return void setContents(key, { status: "outside" })
    const kind = viewKind(path)
    if (loadsDirect(kind) && untrack(source) === "direct") {
      if (entry?.status === "direct" && entry.version === version && !options.force) return
      const known = untrack(() => tree()?.typeOf(path))
      const listed = untrack(() => tree()?.state.children[dirname(path)]) !== undefined
      if (listed && known === undefined) return void setContents(key, { status: "missing", version })
      const baseUrl = current.entry()?.baseUrl ?? location.origin
      const url = `${readUrl(baseUrl, folder, path)}${version ? `&v=${version}` : ""}`
      return void setContents(key, { status: "direct", url, version })
    }
    const stale = !entry || entry.status === "loading" || !("version" in entry) || entry.version < version
    if (!stale && !options.force && !options.large) return
    // A read of this version is under way; one started before the last refresh is replaced.
    if ((loads.get(key)?.version ?? -1) >= version && !options.force && !options.large) return
    loads.get(key)?.abort.abort()
    const controller = new AbortController()
    const token = ++tokens.next
    loads.set(key, { token, version, abort: controller })
    if (!entry) setContents(key, { status: "loading" })
    const done = () => loads.get(key)?.token === token
    Promise.resolve()
      .then(() => current.client().file.read({ location: { directory: folder }, path }, { signal: controller.signal }))
      .then((bytes) => {
        if (!done()) return
        const decoded = decodeFile(
          path,
          bytes,
          options.large || (entry?.status === "ready" && entry.content.type === "text"),
        )
        const previous = untrack(() => contents[key])
        const unchanged = previous?.status === "ready" && sameContent(previous.content, decoded)
        setContents(key, { status: "ready", content: unchanged ? previous.content : decoded, version })
      })
      .catch((error: unknown) => {
        if (!done() || controller.signal.aborted) return
        const name = error instanceof Error ? error.name : ""
        if (name === "FileNotFoundError") return setContents(key, { status: "missing", version })
        setContents(key, { status: "error", message: error instanceof Error ? error.message : String(error), version })
      })
      .finally(() => {
        if (done()) loads.delete(key)
      })
  }

  onCleanup(() => loads.forEach((load) => abort(load.abort)))

  // The active tab loads while the tab is visible; a refresh bumps the version and reloads it.
  createEffect(() => {
    const tab = active()
    if (!tab || !input.visible() || runtime()?.connection.status() !== "connected") return
    sync.version
    untrack(() => ensure(tab.path))
  })

  // ---- refresh (the watcher stand-in) ----
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  function run() {
    timer.id = undefined
    if (!untrack(input.visible)) return void setSync("dirty", true)
    const current = untrack(tree)
    batch(() => {
      setSync("dirty", false)
      setSync("version", (value) => value + 1)
      setSync("busy", true)
    })
    void (current?.refresh() ?? Promise.resolve()).finally(() => setSync("busy", false))
  }
  function schedule() {
    if (timer.id === undefined) timer.id = setTimeout(run, REFRESH_MS)
  }
  onCleanup(() => clearTimeout(timer.id))
  createEffect(
    on(input.visible, (visible) => {
      if (visible && untrack(() => sync.dirty)) run()
    }),
  )

  createEffect(() => {
    const current = runtime()
    if (!current) return
    const folder = () => untrack(directory)
    const here = (location: { readonly directory?: string } | undefined, sessionID?: string) =>
      location?.directory
        ? location.directory === folder()
        : sessionID !== undefined && sessionID === untrack(input.sessionID)
    const ofSession = (sessionID: string) => sessionID === untrack(input.sessionID)
    const offs = [
      current.bus.on("session.tool.success", (event) => here(event.location, event.data.sessionID) && schedule()),
      current.bus.on(
        "session.execution.succeeded",
        (event) => here(event.location, event.data.sessionID) && schedule(),
      ),
      current.bus.on("session.execution.failed", (event) => here(event.location, event.data.sessionID) && schedule()),
      current.bus.on(
        "session.execution.interrupted",
        (event) => here(event.location, event.data.sessionID) && schedule(),
      ),
      current.bus.on("session.shell.ended", (event) => here(event.location, event.data.sessionID) && schedule()),
      current.bus.on("session.revert.committed", (event) => ofSession(event.data.sessionID) && schedule()),
      current.bus.on("session.revert.staged", (event) => ofSession(event.data.sessionID) && schedule()),
      current.bus.on("session.revert.cleared", (event) => ofSession(event.data.sessionID) && schedule()),
      current.bus.on("filesystem.changed", (event) => here(event.location) && schedule()),
      current.bus.on("vcs.branch.updated", (event) => here(event.location) && schedule()),
      current.bus.on("server.connected", () => schedule()),
    ]
    onCleanup(() => offs.forEach((off) => off()))
  })
  const onFocus = () => schedule()
  const onVisibility = () => document.visibilityState === "visible" && schedule()
  window.addEventListener("focus", onFocus)
  document.addEventListener("visibilitychange", onVisibility)
  onCleanup(() => {
    window.removeEventListener("focus", onFocus)
    document.removeEventListener("visibilitychange", onVisibility)
  })

  // ---- opening ----
  /** Opens a tab for a link or a typed path (`src/a.ts:12`, absolute, `file://`); folders expand in the tree. */
  async function open(raw: string, options: { readonly line?: number; readonly base?: string } = {}) {
    const key = sessionKey()
    const folder = directory()
    const target = parseLink(raw)
    if (!key || !folder || !target) return
    const place = locate(folder, target.path, options.base)
    if (place.inside && !place.path) return
    const current = tree()
    if (place.inside && current) {
      // Links are guessed from text: list the parent again so a file the agent just wrote is known.
      await current.load(dirname(place.path), true).catch(() => undefined)
      if (current.typeOf(place.path) === "directory") {
        await current.reveal(place.path)
        await current.expand(place.path)
        return
      }
    }
    fileTabs.open(key, place.path, options.line ?? target.line)
    if (place.inside && current) void current.reveal(place.path)
  }

  // Requests from the conversation (intents.ts) for this session.
  createEffect(() => {
    const request = pendingFile()
    const sessionID = input.sessionID()
    if (!request || !sessionID || !directory()) return
    if (request.serverKey !== input.serverKey() || request.sessionID !== sessionID) return
    takeFile(request.seq)
    void untrack(() => open(request.path, { line: request.line, base: request.base }))
  })

  // ---- editor and Explorer (19.5) ----
  const files = createFileActions({ serverKey: input.serverKey, directory })

  return {
    runtime,
    directory,
    sessionID: input.sessionID,
    sessionKey,
    tree,
    tabs,
    active,
    contents: (path: string) => contents[contentKey(path)],
    ensure,
    open,
    close: (path: string) => {
      const key = sessionKey()
      if (key) fileTabs.close(key, path)
    },
    activate: (path: string) => {
      const key = sessionKey()
      if (key) fileTabs.activate(key, path)
    },
    move: (path: string, to: number) => {
      const key = sessionKey()
      if (key) fileTabs.move(key, path, to)
    },
    /** Manual refresh (the ⟳ button): tree and every open tab. */
    refresh: () => {
      clearTimeout(timer.id)
      run()
    },
    refreshing: () => sync.busy,
    actions: files.available,
    absolute: files.absolute,
    openInEditor: files.openInEditor,
    editorUrl: files.editorUrl,
    reveal: files.reveal,
  }
}

export type FilesController = ReturnType<typeof createFilesController>
