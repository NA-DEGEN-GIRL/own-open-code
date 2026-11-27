// Where a workspace notebook is kept (05 §8.8): this PC's service for a workspace with a key, this browser otherwise.
import { OwnRpcError, type ServerRuntime } from "@/data"
import type { NoteMeta, NotesTransport, StoredNote, WriteResult } from "./workspace-store"

/**
 * own.accounts `notes.*` of this PC (02 §9.2) for one workspace key, through the local runtime: this PC's service on
 * the desktop, `/srv/local` behind the gateway on a phone or another PC's window. Saving needs the `prompt` scope.
 */
export function serviceTransport(
  runtime: Pick<ServerRuntime, "rpc" | "own" | "connection">,
  workspace: string,
): NotesTransport {
  return {
    synced: true,
    ready: () => runtime.connection.status() === "connected",
    writable: () => runtime.rpc.allowed("notes.put"),
    list: () => runtime.rpc.call("notes.list", { workspace }).then((result) => result.notes),
    get: (id) =>
      runtime.rpc.call("notes.get", { workspace, id }).catch((error: unknown) => {
        if (error instanceof OwnRpcError && error.type === "note_not_found") return undefined
        throw error
      }),
    put: (input) =>
      runtime.rpc.call("notes.put", { workspace, ...input }).then(
        (result): WriteResult => ({ type: "ok", rev: result.rev }),
        (error: unknown) => refused(error),
      ),
    remove: (id, baseRev) =>
      runtime.rpc.call("notes.remove", { workspace, id, baseRev }).then(
        () => ({ type: "ok" }) as const,
        (error: unknown) => {
          const result = refused(error)
          if (result.type === "conflict") return result
          throw error
        },
      ),
    watch: (changed) =>
      runtime.own.on("notes.changed", (event) => {
        if (event.data.workspace === workspace) changed({ id: event.data.id, rev: event.data.rev })
      }),
  }
}

/** The declared refusals of a save; anything else (the connection, the scope) stays an error. */
function refused(error: unknown): Exclude<WriteResult, { type: "ok" }> {
  if (!(error instanceof OwnRpcError)) throw error
  // SAFETY: own.accounts declares these errors' data (`{current: Note | null}`, `{max}`) and encodes it with that schema.
  if (error.type === "note_conflict")
    return { type: "conflict", current: (error.data as { current: StoredNote | null }).current }
  if (error.type === "notes_limit") return { type: "limit", max: (error.data as { max: number }).max }
  throw error
}

/**
 * This browser's notebook of a workspace without a key (no project folder yet): the layout it had before NOTES, an
 * index `own.web.notes.<workspace>` and one text per note, and the last write wins between this browser's windows, as
 * it did. The same reader hands a keyed workspace's old notebook to its one-time move to the PC.
 */
export function browserTransport(storage: Storage, workspace: string): NotesTransport {
  const key = `own.web.notes.${workspace}`
  return {
    synced: false,
    ready: () => true,
    writable: () => true,
    list: async () => readIndex(storage, key).notes,
    get: async (id) => {
      const meta = readIndex(storage, key).notes.find((note) => note.id === id)
      return meta && { ...meta, text: storage.getItem(`${key}.${id}`) ?? "" }
    },
    // Writes before the first await, so a save started by `pagehide` lands before the page goes.
    put: async (input) => {
      const index = readIndex(storage, key)
      const meta = index.notes.find((note) => note.id === input.id)
      const next = { id: input.id, title: input.title ?? meta?.title ?? "", rev: (meta?.rev ?? 0) + 1 }
      if (input.text !== undefined) storage.setItem(`${key}.${input.id}`, input.text)
      // Other fields of the index (the tab layout before NOTES) stay as they were.
      storage.setItem(
        key,
        JSON.stringify({
          ...index.raw,
          notes: meta ? index.notes.map((note) => (note.id === input.id ? next : note)) : [...index.notes, next],
        }),
      )
      return { type: "ok", rev: next.rev }
    },
    remove: async (id) => {
      const index = readIndex(storage, key)
      storage.setItem(key, JSON.stringify({ ...index.raw, notes: index.notes.filter((note) => note.id !== id) }))
      storage.removeItem(`${key}.${id}`)
      return { type: "ok" }
    },
    watch: (changed) => {
      const listener = (event: StorageEvent) => {
        if (event.storageArea === storage && event.key === key) changed()
      }
      window.addEventListener("storage", listener)
      return () => window.removeEventListener("storage", listener)
    },
  }
}

/** The notebook index as stored: notes before NOTES have no revision (1). Unreadable values read as empty. */
function readIndex(storage: Storage, key: string): { readonly raw: object; readonly notes: readonly NoteMeta[] } {
  const parsed = parse(storage.getItem(key))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { raw: {}, notes: [] }
  const notes = "notes" in parsed && Array.isArray(parsed.notes) ? parsed.notes : []
  return {
    raw: parsed,
    notes: notes.flatMap((note: unknown) =>
      typeof note === "object" &&
      note !== null &&
      "id" in note &&
      typeof note.id === "string" &&
      "title" in note &&
      typeof note.title === "string"
        ? [{ id: note.id, title: note.title, rev: "rev" in note && typeof note.rev === "number" ? note.rev : 1 }]
        : [],
    ),
  }
}

function parse(value: string | null): unknown {
  if (value === null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
