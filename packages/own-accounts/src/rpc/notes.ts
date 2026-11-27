export * as NotesRpc from "./notes.js"

import { Notes } from "@own/protocol"
import type { Deps } from "../deps.js"
import { NoteStore } from "../notes/store.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: NOTES (02 §9.2 "워크스페이스 노트"). The workspace `노트` tab's notes in the own-accounts KV, for every client
 * of this PC: the desktop app, a phone through the gateway (`read` lists and reads, `prompt` writes) and another PC's
 * window. Global methods: they arrive at the control Location, whose instance leads and sends `notes.changed`.
 * Stateless like the worktree guard, so it needs no module. A remote service refuses them (`REMOTE_MANAGED`).
 */
export type Methods = "notes.list" | "notes.get" | "notes.put" | "notes.remove"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  return {
    "notes.list": (input, context) =>
      NoteStore.list(deps, input.workspace).then(
        (notes) => ({ notes }),
        (error: unknown) => context.error("internal_error", message(error), {}),
      ),
    "notes.get": (input, context) =>
      NoteStore.get(deps, input.workspace, input.id).then(
        (note) => note ?? context.error("note_not_found", "no such note in this workspace", { id: input.id }),
        (error: unknown) => context.error("internal_error", message(error), {}),
      ),
    "notes.put": (input, context) =>
      NoteStore.put(deps, input).then(
        (result) => {
          if (result.type === "conflict")
            return context.error("note_conflict", "the note changed elsewhere", { current: result.current })
          if (result.type === "limit")
            return context.error("notes_limit", `a workspace holds up to ${Notes.PER_WORKSPACE_MAX} notes`, {
              max: Notes.PER_WORKSPACE_MAX,
            })
          void deps.emitter.global("notes.changed", { workspace: input.workspace, id: input.id, rev: result.rev })
          return { rev: result.rev, updatedAt: result.updatedAt }
        },
        (error: unknown) => context.error("internal_error", message(error), {}),
      ),
    "notes.remove": (input, context) =>
      NoteStore.remove(deps, input).then(
        (result) => {
          if (result.type === "conflict")
            return context.error("note_conflict", "the note changed elsewhere", { current: result.current })
          if (result.type === "missing") return { removed: false }
          void deps.emitter.global("notes.changed", { workspace: input.workspace, id: input.id, rev: null })
          return { removed: true }
        },
        (error: unknown) => context.error("internal_error", message(error), {}),
      ),
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
