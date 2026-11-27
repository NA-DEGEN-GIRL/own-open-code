// One session's thread note (03 §19.10): the saved value (metadata text + whether the instruction entry exists), its
// loading, and saving by `planSave`. The metadata is written as read-modify-write because `PATCH {metadata}` replaces
// the whole object (core `Session.setMetadata`); every other key (pin/archive flags, other hosts) is kept.
import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { entryNote, NOTE_ENTRY, noteOf, planSave, withNote, type NoteValue } from "./model"

export type NoteRuntime = Pick<ServerRuntime, "client" | "bus" | "connection" | "rpc">

export interface NoteState {
  status: "loading" | "ready" | "error"
  error?: string
  saved: NoteValue
  /** The server has the instruction-entry API (experimental); without it notes stay UI-only. */
  entries: boolean
  saving: boolean
}

export function createNoteController(input: { readonly runtime: NoteRuntime; readonly sessionID: string }) {
  const runtime = input.runtime
  const sessionID = input.sessionID
  const [state, setState] = createStore<NoteState>({
    status: "loading",
    saved: { text: "", visible: false },
    entries: true,
    saving: false,
  })
  let loads = 0

  async function load() {
    const token = ++loads
    if (state.status !== "ready") setState("status", "loading")
    try {
      const client = runtime.client()
      const [info, entries] = await Promise.all([
        client.session.get({ sessionID }),
        client.session.instructions.entry.list({ sessionID }).catch(() => undefined),
      ])
      if (token !== loads) return
      const text = noteOf(info.metadata)
      const visible = entries !== undefined && entryNote(entries) !== undefined
      setState({
        status: "ready",
        error: undefined,
        entries: entries !== undefined,
        // A model-visible note another client wrote without the metadata copy still shows its text.
        saved: { text: text || (entries ? (entryNote(entries) ?? "") : ""), visible },
      })
    } catch (error) {
      if (token !== loads) return
      setState({ status: "error", error: message(error) })
    }
  }

  createEffect(
    on(
      () => runtime.connection.status(),
      (status) => {
        if (status === "connected") void load()
      },
    ),
  )
  onCleanup(
    runtime.bus.on("session.metadata.updated", (event) => {
      if (event.data.sessionID !== sessionID || state.status !== "ready") return
      const text = noteOf(event.data.metadata)
      if (text !== state.saved.text) setState("saved", "text", text)
    }),
  )
  // Entry changes reach the model at a step boundary as `session.instructions.updated` (key `api/own.note`).
  onCleanup(
    runtime.bus.on("session.instructions.updated", (event) => {
      if (event.data.sessionID === sessionID && `api/${NOTE_ENTRY}` in event.data.delta) void load()
    }),
  )

  /** Model-visible notes change model input: gateway devices need the `prompt` scope (02 §9.1). */
  const canShowModel = () => state.entries && runtime.rpc.can("prompt")

  async function save(next: NoteValue) {
    const target: NoteValue = { text: next.text, visible: next.visible && canShowModel() }
    const plan = planSave(state.saved, target)
    setState({ saving: true, error: undefined })
    try {
      const client = runtime.client()
      if (plan.metadata) {
        const info = await client.session.get({ sessionID })
        await client.session.update({ sessionID, metadata: withNote(info.metadata, target.text) })
      }
      if (plan.entry === "put")
        await client.session.instructions.entry.put({ sessionID, key: NOTE_ENTRY, value: target.text })
      if (plan.entry === "remove") await client.session.instructions.entry.remove({ sessionID, key: NOTE_ENTRY })
      setState("saved", { text: target.text, visible: target.visible && target.text.trim() !== "" })
      return true
    } catch (error) {
      setState("error", message(error))
      // Part of the write may have landed: show what the server holds now.
      void load()
      return false
    } finally {
      setState("saving", false)
    }
  }

  return { state, load, save, canShowModel }
}

export type NoteController = ReturnType<typeof createNoteController>

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
