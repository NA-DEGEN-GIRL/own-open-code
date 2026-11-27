// Workspace notebooks (05 §8.8, the workspace `노트` tab). The notes of a project live on this PC's service
// (own.accounts `notes.*`, 02 §9.2), so the desktop app, a phone through the gateway and another PC's window show the
// same notes, and clearing a browser's data loses none. Only the layout of this window stays in localStorage: which
// notes are open as tabs and which one is active. A workspace without a key (no project folder yet) keeps the
// browser-only notebook it had before (`browserTransport`).
// - Edits go out 350 ms after the last keystroke, and at once when the page hides or a tab closes. Each save names the
//   revision it started from; when another device saved first the note shows the conflict notice (`note_conflict`)
//   and waits for the user, it never overwrites the newer text.
// - The transport has no keepalive, so a page that closes right after a keystroke keeps its unsent edits in
//   localStorage (`unsent`) and sends them on the next load (as any save: a newer note on the PC is a conflict).
// - `notes.changed` from another client reloads the list and every open note that has no unsaved edits.
import { batch, createEffect, on, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Notes } from "@own/protocol/notes"

export interface NoteMeta {
  readonly id: string
  readonly title: string
  /** The stored revision; 0 for a note this window has not saved yet. */
  readonly rev: number
}

export interface StoredNote extends NoteMeta {
  readonly text: string
}

export type WriteResult =
  | { readonly type: "ok"; readonly rev: number }
  | { readonly type: "conflict"; readonly current: StoredNote | null }
  | { readonly type: "limit"; readonly max: number }

export type RemoveResult = { readonly type: "ok" } | { readonly type: "conflict"; readonly current: StoredNote | null }

export interface NoteChange {
  readonly id: string
  /** `null`: removed. */
  readonly rev: number | null
}

/** Where one workspace's notes are kept: this PC's service, or this browser for a workspace without a key. */
export interface NotesTransport {
  /** `true`: this PC's service; `false`: this browser only. */
  readonly synced: boolean
  /** Calls can go out now (the PC's connection is up); reactive. */
  readonly ready: () => boolean
  /** This connection may save (a gateway device needs the `prompt` scope); reactive. */
  readonly writable: () => boolean
  list(): Promise<readonly NoteMeta[]>
  /** `undefined` when the note does not exist. */
  get(id: string): Promise<StoredNote | undefined>
  put(input: {
    readonly id: string
    readonly title?: string
    readonly text?: string
    readonly baseRev: number
  }): Promise<WriteResult>
  remove(id: string, baseRev: number): Promise<RemoveResult>
  /** `changed` gets a note another client saved or removed, or nothing when anything may have changed. */
  watch(changed: (change?: NoteChange) => void): () => void
}

export interface NoteDoc {
  status: "loading" | "ready" | "error"
  error?: string
  title: string
  text: string
  /** The stored revision `title` and `text` started from; 0 = never saved. */
  rev: number
  /** Bumped whenever `title` and `text` are replaced from outside the editor (load, reload, another device). */
  version: number
  /** A newer stored note (`null`: removed elsewhere). This note is not saved until the user picks one. */
  conflict?: StoredNote | null
}

export type SaveFailure =
  | { readonly reason: "error"; readonly message: string }
  | { readonly reason: "limit" | "tooLong"; readonly max: number }

interface Fields {
  readonly title: boolean
  readonly text: boolean
}

interface View {
  readonly open?: unknown
  readonly active?: unknown
}

export function createWorkspaceNotes(input: {
  readonly transport: NotesTransport
  /** Per-window layout (open tabs, active tab); `fallback` seeds it, e.g. the notebook's layout before NOTES. */
  readonly view: { readonly key: string; readonly fallback?: string }
  /** This browser's notebook before NOTES, moved to the PC once (`marker` records it). */
  readonly legacy?: { readonly transport: NotesTransport; readonly marker: string }
  /** Where unsaved edits wait while the page is gone (synced notebooks). */
  readonly unsent?: string
  readonly storage?: Storage
}) {
  const transport = input.transport
  const storage = input.storage ?? localStorage
  const [state, setState] = createStore({
    status: "loading" as "loading" | "ready" | "error",
    error: undefined as string | undefined,
    notes: [] as NoteMeta[],
    open: [] as string[],
    active: undefined as string | undefined,
    docs: {} as Record<string, NoteDoc>,
    failure: undefined as SaveFailure | undefined,
    pending: false,
    /** Notes of the old notebook that were too big to move to the PC (they stay in localStorage). */
    skipped: 0,
  })
  const dirty = new Map<string, Fields>()
  const inflight = new Set<string>()
  const failed = new Map<string, SaveFailure>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading: Promise<void> | undefined

  const status = () => (state.failure ? "error" : state.pending ? "pending" : "saved")

  function load() {
    loading ??= transport
      .list()
      .then(migrate)
      .then(
        (listed) => {
          const unsent = read<Record<string, Partial<Record<"title" | "text" | "rev", unknown>>>>(input.unsent) ?? {}
          const view =
            read<View>(input.view.key) ?? (input.view.fallback ? read<View>(input.view.fallback) : undefined) ?? {}
          const restored = Object.entries(unsent).flatMap(([id, note]) =>
            Notes.ID_PATTERN.test(id) &&
            typeof note.title === "string" &&
            typeof note.text === "string" &&
            typeof note.rev === "number" &&
            Number.isInteger(note.rev) &&
            note.rev >= 0
              ? [[id, { title: note.title, text: note.text, rev: note.rev }] as const]
              : [],
          )
          const notes = [
            ...listed,
            ...restored
              .filter(([id]) => !listed.some((note) => note.id === id))
              .map(([id, note]) => ({ id, title: note.title, rev: note.rev })),
          ]
          const open = (Array.isArray(view.open) ? view.open : []).filter(
            (id): id is string => typeof id === "string" && notes.some((note) => note.id === id),
          )
          batch(() => {
            setState({
              status: "ready",
              error: undefined,
              notes,
              open,
              active: typeof view.active === "string" && open.includes(view.active) ? view.active : open.at(-1),
            })
            restored.forEach(([id, note]) => {
              setState("docs", id, { status: "ready", title: note.title, text: note.text, rev: note.rev, version: 1 })
              dirty.set(id, { title: true, text: true })
            })
          })
          // The edits are in memory now; the next hide writes them again if they are still unsent.
          quietly(() => input.unsent && storage.removeItem(input.unsent))
          void flush()
        },
        (error: unknown) => void setState({ status: "error", error: message(error) }),
      )
      .finally(() => {
        loading = undefined
      })
    return loading
  }

  /**
   * The one-time move of this browser's old notebook. When the PC has no notes for the workspace yet, the old notes
   * go up with their ids and titles; the old values stay in localStorage as a backup. When the PC already has notes
   * nothing is merged: those are what the other devices see, and a merge could bring back a note another device
   * deleted or double one edited on both. A move cut short (`started`) goes on with the notes still missing.
   */
  async function migrate(listed: readonly NoteMeta[]) {
    const legacy = input.legacy
    const marker = legacy ? read<string>(legacy.marker) : "done"
    if (!legacy || marker === "done") return listed
    const old = listed.length && marker !== "started" ? [] : await legacy.transport.list()
    if (!old.length) {
      write(legacy.marker, "done")
      return listed
    }
    write(legacy.marker, "started")
    const missing = old.filter((note) => !listed.some((item) => item.id === note.id))
    const skipped = await missing.reduce(async (count, meta) => {
      const before = await count
      const note = await legacy.transport.get(meta.id)
      const fits =
        note !== undefined &&
        Notes.ID_PATTERN.test(note.id) &&
        note.title.length <= Notes.TITLE_MAX &&
        note.text.length <= Notes.TEXT_MAX
      if (!fits) return before + 1
      // `conflict`: another window of this browser moved the same note first (the id is kept).
      const result = await transport.put({ id: note.id, title: note.title, text: note.text, baseRev: 0 })
      return result.type === "limit" ? before + 1 : before
    }, Promise.resolve(0))
    write(legacy.marker, "done")
    setState("skipped", skipped)
    return transport.list()
  }

  /** The PC's list and every open note again (another client's change, a reconnect). */
  async function refresh() {
    const listed = await transport.list().catch(() => undefined)
    if (!listed) return
    batch(() => {
      // Notes this window created and has not saved yet are not on the PC: they stay.
      const local = state.notes.filter((note) => note.rev === 0 && !listed.some((item) => item.id === note.id))
      setState(
        "notes",
        reconcile([
          ...listed.map((meta) =>
            dirty.get(meta.id)?.title ? { ...meta, title: state.docs[meta.id]?.title ?? meta.title } : meta,
          ),
          ...local,
        ]),
      )
      Object.entries(state.docs).forEach(([id, doc]) => {
        if (doc.rev === 0 || inflight.has(id) || doc.status !== "ready") return
        const meta = listed.find((note) => note.id === id)
        if (meta?.rev === doc.rev) return
        // Unsaved edits wait for their own save, which reports a newer note as the conflict; a removal shows now.
        if (dirty.has(id)) {
          if (!meta) setState("docs", id, "conflict", null)
          return
        }
        if (!meta) return drop(id)
        void reload(id)
      })
    })
    void flush()
  }

  async function reload(id: string) {
    const note = await transport.get(id).catch(() => undefined)
    if (dirty.has(id) || inflight.has(id)) return
    if (note) adopt(note)
  }

  function ensure(id: string) {
    const meta = state.notes.find((note) => note.id === id)
    const doc = state.docs[id]
    if (!meta || (doc && doc.status !== "error")) return
    setState("docs", id, {
      status: "loading",
      error: undefined,
      title: meta.title,
      text: "",
      rev: meta.rev,
      version: 0,
    })
    transport.get(id).then(
      (note) => (note ? adopt(note) : drop(id)),
      (error: unknown) => setState("docs", id, { status: "error", error: message(error) }),
    )
  }

  /** Takes the stored note as this window's (load, reload, the user's `새 내용 불러오기`). */
  function adopt(note: StoredNote) {
    dirty.delete(note.id)
    failed.delete(note.id)
    batch(() => {
      setState(
        "docs",
        note.id,
        (doc): NoteDoc => ({
          status: "ready",
          error: undefined,
          title: note.title,
          text: note.text,
          rev: note.rev,
          version: (doc?.version ?? 0) + 1,
          conflict: undefined,
        }),
      )
      setState("notes", (notes) => upsert(notes, { id: note.id, title: note.title, rev: note.rev }))
      settled()
    })
  }

  /** Forgets a note in this window: removed here or elsewhere, or never saved. */
  function drop(id: string) {
    dirty.delete(id)
    failed.delete(id)
    batch(() => {
      setState(
        produce((value) => {
          value.notes = value.notes.filter((note) => note.id !== id)
          value.open = value.open.filter((entry) => entry !== id)
          if (value.active === id) value.active = value.open.at(-1)
          delete value.docs[id]
        }),
      )
      settled()
    })
    saveView()
  }

  function flush(): Promise<boolean> {
    clearTimeout(timer)
    if (state.status !== "ready" || !transport.writable()) return Promise.resolve(status() === "saved")
    const sends = [...dirty].flatMap(([id, fields]) => {
      const doc = state.docs[id]
      if (!doc || doc.status !== "ready" || doc.conflict !== undefined || inflight.has(id)) return []
      if (doc.text.length > Notes.TEXT_MAX) {
        failed.set(id, { reason: "tooLong", max: Notes.TEXT_MAX })
        return []
      }
      dirty.delete(id)
      inflight.add(id)
      const sent = { title: doc.title, text: doc.text }
      const fresh = doc.rev === 0
      return [
        transport
          .put({
            id,
            baseRev: doc.rev,
            ...(fresh || fields.title ? { title: sent.title } : {}),
            ...(fresh || fields.text ? { text: sent.text } : {}),
          })
          .then(
            (result) => settle(id, fields, sent, result),
            (error: unknown) => settle(id, fields, sent, { type: "error", message: message(error) }),
          ),
      ]
    })
    settled()
    return Promise.all(sends).then(() => status() === "saved")
  }

  function settle(
    id: string,
    fields: Fields,
    sent: { readonly title: string; readonly text: string },
    result: WriteResult | { readonly type: "error"; readonly message: string },
  ) {
    inflight.delete(id)
    // A conflict with exactly what was sent is this save landing earlier (a page that closed while it was out).
    const landed =
      result.type === "conflict" && result.current?.title === sent.title && result.current.text === sent.text
    const rev =
      result.type === "ok" ? result.rev : landed && result.type === "conflict" ? result.current?.rev : undefined
    batch(() => {
      if (rev !== undefined) {
        failed.delete(id)
        if (state.docs[id]) setState("docs", id, "rev", rev)
        setState("notes", (notes) => upsert(notes, { id, title: state.docs[id]?.title ?? sent.title, rev }))
      }
      if (rev === undefined) {
        // Edits made while the save was out are in `dirty` already; the ones it carried go back so none is lost.
        const later = dirty.get(id)
        dirty.set(id, { title: fields.title || !!later?.title, text: fields.text || !!later?.text })
        if (result.type === "conflict") failed.delete(id)
        if (result.type === "conflict" && state.docs[id]) setState("docs", id, "conflict", result.current)
        if (result.type === "limit") failed.set(id, { reason: "limit", max: result.max })
        if (result.type === "error") failed.set(id, { reason: "error", message: result.message })
      }
      settled()
    })
    if (rev !== undefined && dirty.has(id)) schedule()
    backup(false)
  }

  /** Recomputes the save status after `dirty`, `inflight` or `failed` changed. */
  function settled() {
    setState("failure", [...failed.values()].at(-1))
    setState(
      "pending",
      inflight.size > 0 || [...dirty.keys()].some((id) => state.docs[id] && state.docs[id].conflict === undefined),
    )
  }

  function schedule() {
    settled()
    clearTimeout(timer)
    timer = setTimeout(() => void flush(), 350)
  }

  /**
   * Keeps the unsaved edits in localStorage (`force`: the page is hiding; otherwise only while a save is failing) and
   * forgets them once everything is saved.
   */
  function backup(force: boolean) {
    const key = input.unsent
    if (!key) return
    const unsaved = [...new Set([...dirty.keys(), ...inflight])].flatMap((id) => {
      const doc = state.docs[id]
      return doc?.status === "ready" ? [[id, { title: doc.title, text: doc.text, rev: doc.rev }] as const] : []
    })
    if (!unsaved.length) return quietly(() => storage.removeItem(key))
    if (force || failed.size) quietly(() => storage.setItem(key, JSON.stringify(Object.fromEntries(unsaved))))
  }

  function saveView() {
    quietly(() => storage.setItem(input.view.key, JSON.stringify({ open: state.open, active: state.active })))
  }

  function read<T>(key: string | undefined): T | undefined {
    const raw = key === undefined ? null : quietly(() => storage.getItem(key))
    // SAFETY: written by this module; a value of another shape is checked where it is used (view, unsent ids).
    return raw ? (quietly(() => JSON.parse(raw)) as T | undefined) : undefined
  }

  function write(key: string, value: unknown) {
    quietly(() => storage.setItem(key, JSON.stringify(value)))
  }

  const changed = (change?: NoteChange) => {
    if (state.status !== "ready") return
    if (change && inflight.has(change.id)) return
    const known = change && (state.docs[change.id]?.rev ?? state.notes.find((note) => note.id === change.id)?.rev)
    // An echo of this window's own save, or a removal of a note it does not have.
    if (change && change.rev !== null && known !== undefined && change.rev <= known) return
    if (change && change.rev === null && known === undefined) return
    void refresh()
  }
  const unwatch = transport.watch(changed)
  createEffect(
    on(transport.ready, (ready, was) => {
      if (!ready) return
      if (state.status !== "ready") return void load()
      // Back after a drop: what changed meanwhile, then the edits that waited.
      if (was === false) void refresh()
    }),
  )

  const hide = () => {
    void flush()
    backup(true)
  }
  const visibility = () => {
    if (window.document.visibilityState === "hidden") hide()
  }
  window.addEventListener("pagehide", hide)
  window.document.addEventListener("visibilitychange", visibility)
  onCleanup(() => {
    hide()
    unwatch()
    window.removeEventListener("pagehide", hide)
    window.document.removeEventListener("visibilitychange", visibility)
  })

  return {
    state,
    /** This PC's service (`true`) or this browser only. */
    synced: transport.synced,
    writable: transport.writable,
    status,
    load,
    ensure,
    flush,
    create(title: string, options: { readonly draft?: boolean } = {}) {
      if (!transport.writable() || state.notes.length >= Notes.PER_WORKSPACE_MAX) return undefined
      const id = crypto.randomUUID()
      setState(
        produce((value) => {
          value.notes.push({ id, title, rev: 0 })
          value.docs[id] = { status: "ready", title, text: "", rev: 0, version: 1 }
          value.open.push(id)
          value.active = id
        }),
      )
      saveView()
      // A draft (the first note of an empty notebook) is saved with its first edit, not for being shown.
      if (!options.draft) {
        dirty.set(id, { title: true, text: true })
        schedule()
      }
      return id
    },
    open(id: string) {
      if (!state.notes.some((note) => note.id === id)) return
      setState((value) => ({ open: value.open.includes(id) ? value.open : [...value.open, id], active: id }))
      saveView()
      ensure(id)
    },
    close(id: string) {
      void flush()
      setState((value) => {
        const open = value.open.filter((entry) => entry !== id)
        return { open, active: value.active === id ? open.at(-1) : value.active }
      })
      saveView()
    },
    update(id: string, patch: { readonly title?: string; readonly text?: string }) {
      const doc = state.docs[id]
      if (!doc || doc.status !== "ready" || !transport.writable()) return
      const title = patch.title
      batch(() => {
        if (title !== undefined) {
          setState("docs", id, "title", title)
          setState("notes", (notes) => notes.map((note) => (note.id === id ? { ...note, title } : note)))
        }
        if (patch.text !== undefined) setState("docs", id, "text", patch.text)
      })
      const fields = dirty.get(id)
      dirty.set(id, {
        title: !!fields?.title || patch.title !== undefined,
        text: !!fields?.text || patch.text !== undefined,
      })
      schedule()
    },
    /** Removes a note everywhere; a note another device changed meanwhile shows the conflict instead. */
    async remove(id: string) {
      const rev = state.docs[id]?.rev ?? state.notes.find((note) => note.id === id)?.rev ?? 0
      if (rev === 0) return drop(id)
      const result = await transport.remove(id, rev).catch((error: unknown) => {
        failed.set(id, { reason: "error", message: message(error) })
        settled()
        return undefined
      })
      if (result?.type === "ok") return drop(id)
      if (result?.type === "conflict" && result.current) return adopt(result.current)
      if (result?.type === "conflict") drop(id)
    },
    /** Ends a conflict: the stored note (`theirs`) or this window's text saved on top of it (`mine`), never silently. */
    resolve(id: string, choice: "theirs" | "mine") {
      const doc = state.docs[id]
      if (!doc || doc.conflict === undefined) return
      const current = doc.conflict
      if (choice === "theirs") return current ? adopt(current) : drop(id)
      setState("docs", id, { conflict: undefined, rev: current?.rev ?? 0 })
      dirty.set(id, { title: true, text: true })
      void flush()
    },
  }
}

export type WorkspaceNotes = ReturnType<typeof createWorkspaceNotes>

function upsert(notes: readonly NoteMeta[], meta: NoteMeta) {
  return notes.some((note) => note.id === meta.id)
    ? notes.map((note) => (note.id === meta.id ? meta : note))
    : [...notes, meta]
}

/** localStorage may refuse (private mode, quota): the layout and the unsent copy are conveniences. */
function quietly<T>(run: () => T) {
  try {
    return run()
  } catch {
    return undefined
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
