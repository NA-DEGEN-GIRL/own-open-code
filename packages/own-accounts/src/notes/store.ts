export * as NoteStore from "./store.js"

import { Option, Schema } from "effect"
import { Kv, Notes } from "@own/protocol"
import { Hash } from "@own/runtime"
import type { Deps } from "../deps.js"

// Workspace notes (02 §9.2 "워크스페이스 노트", 05 §8.8) in the own-accounts KV, which core keeps in its database: one
// index row per workspace (titles and revisions, small, read whole by `list`) and one text row per note, so a list
// never reads every text. The RPC boundary has already checked keys, ids and lengths.

const Meta = Schema.Struct({ id: Schema.String, title: Schema.String, rev: Schema.Int, updatedAt: Schema.Finite })
const Index = Schema.Struct({ notes: Schema.Array(Meta) })
const decodeIndex = Schema.decodeUnknownOption(Index)
const toJson = Schema.decodeUnknownSync(Schema.Json)

export type Meta = typeof Meta.Type
export type Note = Meta & { readonly text: string }

export type PutResult =
  | { readonly type: "ok"; readonly rev: number; readonly updatedAt: number }
  | { readonly type: "conflict"; readonly current: Note | null }
  | { readonly type: "limit" }

export type RemoveResult =
  | { readonly type: "removed"; readonly rev: number }
  | { readonly type: "missing" }
  | { readonly type: "conflict"; readonly current: Note }

type Store = Pick<Deps, "ctx" | "runtime" | "clock">

export async function list(deps: Store, workspace: string) {
  return index(deps, hash(workspace))
}

export async function get(deps: Store, workspace: string, id: string): Promise<Note | undefined> {
  const key = hash(workspace)
  const meta = (await index(deps, key)).find((note) => note.id === id)
  return meta && withText(deps, key, meta)
}

/**
 * Saves when `baseRev` is the stored revision (0: no such note, which creates it); otherwise the stored note comes
 * back as the conflict. Every write of the process goes through the runtime's notes mutex, so two devices saving at
 * once cannot drop each other's index change.
 */
export function put(
  deps: Store,
  input: {
    readonly workspace: string
    readonly id: string
    readonly title?: string
    readonly text?: string
    readonly baseRev: number
  },
): Promise<PutResult> {
  return deps.runtime.notes.run(async () => {
    const key = hash(input.workspace)
    const notes = await index(deps, key)
    const meta = notes.find((note) => note.id === input.id)
    if ((meta?.rev ?? 0) !== input.baseRev)
      return { type: "conflict", current: meta ? await withText(deps, key, meta) : null }
    if (!meta && notes.length >= Notes.PER_WORKSPACE_MAX) return { type: "limit" }
    const next: Meta = {
      id: input.id,
      title: input.title ?? meta?.title ?? "",
      rev: input.baseRev + 1,
      updatedAt: deps.clock.now(),
    }
    // The text before the index: a crash in between leaves the index one revision behind its text, and the next save
    // (from that older revision) simply writes again. The other order could list a revision whose text is missing.
    if (input.text !== undefined || !meta) await deps.ctx.storage.set(Kv.noteText(key, input.id), input.text ?? "")
    await write(deps, key, meta ? notes.map((note) => (note.id === input.id ? next : note)) : [...notes, next])
    return { type: "ok", rev: next.rev, updatedAt: next.updatedAt }
  })
}

/** Removes a note; with `baseRev`, only while that is the stored revision. */
export function remove(
  deps: Store,
  input: { readonly workspace: string; readonly id: string; readonly baseRev?: number },
): Promise<RemoveResult> {
  return deps.runtime.notes.run(async () => {
    const key = hash(input.workspace)
    const notes = await index(deps, key)
    const meta = notes.find((note) => note.id === input.id)
    if (!meta) return { type: "missing" }
    if (input.baseRev !== undefined && input.baseRev !== meta.rev)
      return { type: "conflict", current: await withText(deps, key, meta) }
    // The index first: a crash in between leaves only an unlisted text row, never a listed note without text.
    await write(
      deps,
      key,
      notes.filter((note) => note.id !== input.id),
    )
    await deps.ctx.storage.remove(Kv.noteText(key, input.id))
    return { type: "removed", rev: meta.rev }
  })
}

/** Workspace keys are paths: KV rows use their hash, a fixed size without `:`. */
function hash(workspace: string) {
  return Hash.short(workspace, 32)
}

async function index(deps: Store, key: string): Promise<readonly Meta[]> {
  const stored = await deps.ctx.storage.get(Kv.notesIndex(key))
  if (stored === undefined) return []
  // An index this build cannot read is never replaced by an empty one: the call fails and the row stays.
  return Option.getOrThrowWith(decodeIndex(stored), () => new Error(`notes index ${key} is unreadable`)).notes
}

async function withText(deps: Store, key: string, meta: Meta): Promise<Note> {
  const text = await deps.ctx.storage.get(Kv.noteText(key, meta.id))
  return { ...meta, text: typeof text === "string" ? text : "" }
}

function write(deps: Store, key: string, notes: readonly Meta[]) {
  if (notes.length === 0) return deps.ctx.storage.remove(Kv.notesIndex(key))
  return deps.ctx.storage.set(Kv.notesIndex(key), toJson({ notes }))
}
