// The workspace `노트` tab (05 §8.8): 프로젝트 노트, tabs over one workspace's notebook, kept on this PC's service when
// the workspace has a key (a project folder on this PC or an SSH host), else in this browser as before. Its header and
// notebook icon keep it apart from one conversation's `대화 메모` (./panel, 03 §19.10).
import { Notes } from "@own/protocol/notes"
import { createEffect, createSignal, createUniqueId, For, Match, on, onMount, Show, Switch } from "solid-js"
import { LOCAL, useData } from "@/data"
import { useHost, windowKey } from "@/host"
import { Notice, Spinner } from "@/limits/kit"
import { InlineIcon } from "@/shell/icons"
import { useNotesText } from "./strings"
import { createWorkspaceNotes, type WorkspaceNotes } from "./workspace-store"
import { browserTransport, serviceTransport } from "./workspace-transport"
import { DictationButton } from "@/voice"

export default function WorkspaceNotesPanel(props: {
  /** The shell's workspace key, also the key of this browser's notebook before NOTES. */
  readonly workspaceKey: string
  readonly server: string
  /** The project folder on `server`; absent for a screen without one (no project open yet). */
  readonly directory?: string
}) {
  const text = useNotesText()
  const data = useData()
  const host = useHost()
  // Without a folder there is no key every client could share: such a notebook stays in this browser, as before NOTES.
  const key =
    props.directory === undefined
      ? undefined
      : Notes.workspaceKey({ host: props.server === LOCAL ? undefined : props.server, directory: props.directory })
  const browser = browserTransport(localStorage, props.workspaceKey)
  const notes = createWorkspaceNotes({
    transport: key ? serviceTransport(data.local(), key) : browser,
    view: {
      key: `own.web.notes.view.${windowKey(host)}.${key ?? props.workspaceKey}`,
      fallback: `own.web.notes.${props.workspaceKey}`,
    },
    legacy: key ? { transport: browser, marker: `own.web.notes.migrated.${key}` } : undefined,
    unsent: key ? `own.web.notes.unsent.${key}` : undefined,
  })
  const title = (id: string) => notes.state.notes.find((note) => note.id === id)?.title || text("own.notes.ws.untitled")
  const full = () => notes.state.notes.length >= Notes.PER_WORKSPACE_MAX
  const create = () => notes.create(text("own.notes.ws.new"))
  const [confirming, setConfirming] = createSignal(false)
  const heading = createUniqueId()
  // An empty notebook opens on a note to type in; it is saved with its first edit.
  let seeded = false
  createEffect(() => {
    if (seeded || notes.state.status !== "ready") return
    seeded = true
    if (!notes.state.notes.length) notes.create(text("own.notes.ws.new"), { draft: true })
  })
  const saveStatus = () => {
    const failure = notes.state.failure
    if (!notes.writable()) return text("own.notes.ws.readOnlyStatus")
    if (failure?.reason === "tooLong") return text("own.notes.ws.tooLong", { max: failure.max })
    if (failure?.reason === "limit") return text("own.notes.ws.limit", { max: failure.max })
    if (failure) return text("own.notes.ws.failed")
    if (notes.status() === "pending") return text("own.notes.ws.saving")
    return text(notes.synced ? "own.notes.ws.savedPc" : "own.notes.ws.savedDevice")
  }
  return (
    <section
      class="own-workspace-notes"
      data-testid="workspace-notes"
      data-synced={notes.synced ? "" : undefined}
      aria-busy={notes.state.status === "loading"}
      aria-labelledby={heading}
    >
      <header class="own-note-head" data-testid="workspace-notes-head">
        <InlineIcon name="notebook" />
        <b id={heading}>{text("own.notes.ws.heading")}</b>
        <span>· {text(notes.synced ? "own.notes.ws.headingPc" : "own.notes.ws.headingDevice")}</span>
      </header>
      <Switch>
        <Match when={notes.state.status === "loading"}>
          <p class="own-note-state" role="status" data-testid="note-loading">
            <Spinner /> {text("own.notes.ws.loading")}
          </p>
        </Match>
        <Match when={notes.state.status === "error"}>
          <div class="own-note-state">
            <Notice tone="danger" testid="note-load-error">
              {text("own.notes.ws.loadFailed", { reason: notes.state.error ?? "" })}{" "}
              <button type="button" class="own-link" onClick={() => void notes.load()}>
                {text("own.notes.retry")}
              </button>
            </Notice>
          </div>
        </Match>
        <Match when={notes.state.status === "ready"}>
          <div class="own-note-tabs" role="tablist" aria-label={text("own.notes.ws.tabs")}>
            <For each={notes.state.open}>
              {(id) => (
                <div class="own-note-tab" data-active={notes.state.active === id ? "" : undefined}>
                  <button
                    class="own-tab"
                    type="button"
                    role="tab"
                    aria-selected={notes.state.active === id}
                    onClick={() => notes.open(id)}
                  >
                    {title(id)}
                  </button>
                  <button
                    class="own-icon-button"
                    type="button"
                    aria-label={text("own.notes.ws.closeTab")}
                    onClick={() => notes.close(id)}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
            <Show when={notes.writable()}>
              <button
                class="own-icon-button"
                type="button"
                onClick={create}
                disabled={full()}
                aria-label={text("own.notes.ws.new")}
                title={full() ? text("own.notes.ws.limit", { max: Notes.PER_WORKSPACE_MAX }) : undefined}
                data-testid="note-add"
              >
                +
              </button>
            </Show>
          </div>
          <div class="own-note-toolbar">
            <select
              aria-label={text("own.notes.ws.openSaved")}
              value=""
              onChange={(event) => {
                notes.open(event.currentTarget.value)
                event.currentTarget.value = ""
              }}
            >
              <option value="" disabled>
                {text("own.notes.ws.savedList", { n: notes.state.notes.length })}
              </option>
              <For each={notes.state.notes}>{(note) => <option value={note.id}>{title(note.id)}</option>}</For>
            </select>
            <span
              role="status"
              data-testid="note-save-status"
              title={notes.state.failure?.reason === "error" ? notes.state.failure.message : undefined}
            >
              {saveStatus()}
            </span>
            <Show when={notes.state.failure?.reason === "error"}>
              <button class="own-link" type="button" onClick={() => void notes.flush()}>
                {text("own.notes.ws.retrySave")}
              </button>
            </Show>
            <Show when={notes.writable() && notes.state.active && !confirming()}>
              <button class="own-link" type="button" onClick={() => setConfirming(true)} data-testid="note-delete">
                {text("own.notes.ws.delete")}
              </button>
            </Show>
          </div>
          <Show when={confirming() && notes.state.active}>
            {(id) => (
              <div class="own-note-state">
                <Notice tone="warn" testid="note-delete-confirm">
                  {text("own.notes.ws.deleteConfirm")}{" "}
                  <button
                    type="button"
                    class="own-link"
                    onClick={() => {
                      setConfirming(false)
                      void notes.remove(id())
                    }}
                  >
                    {text("own.notes.ws.deleteYes")}
                  </button>{" "}
                  <button type="button" class="own-link" onClick={() => setConfirming(false)}>
                    {text("own.notes.ws.cancel")}
                  </button>
                </Notice>
              </div>
            )}
          </Show>
          <Show when={!notes.writable()}>
            <div class="own-note-state">
              <Notice tone="info" testid="note-read-only">
                {text("own.notes.ws.readOnly")}
              </Notice>
            </div>
          </Show>
          <Show when={notes.state.skipped > 0}>
            <div class="own-note-state">
              <Notice tone="warn" testid="note-skipped">
                {text("own.notes.ws.skipped", { n: notes.state.skipped })}
              </Notice>
            </div>
          </Show>
          <Show
            when={notes.state.active}
            keyed
            fallback={
              <Show when={notes.writable()}>
                <button class="own-button m-4" type="button" onClick={create} disabled={full()}>
                  {text("own.notes.ws.create")}
                </button>
              </Show>
            }
          >
            {(id) => <NoteEditor id={id} notes={notes} />}
          </Show>
        </Match>
      </Switch>
      <div class="own-note-foot">{text(notes.synced ? "own.notes.ws.footPc" : "own.notes.ws.footDevice")}</div>
    </section>
  )
}

function NoteEditor(props: { readonly id: string; readonly notes: WorkspaceNotes }) {
  const text = useNotesText()
  const doc = () => props.notes.state.docs[props.id]
  let title!: HTMLInputElement
  let area!: HTMLTextAreaElement
  let composing = false
  onMount(() => props.notes.ensure(props.id))
  // Both fields are uncontrolled (IME rule 5): written when a stored note is adopted, never while typing or composing.
  createEffect(
    on(
      () => doc()?.version,
      () => {
        const current = doc()
        if (!current) return
        if (title.value !== current.title) title.value = current.title
        if (!composing && area.value !== current.text) area.value = current.text
      },
    ),
  )
  const editable = () => doc()?.status === "ready" && props.notes.writable()
  return (
    <div class="own-note-editor">
      <Switch>
        <Match when={doc()?.status === "loading"}>
          <p class="own-note-state" role="status" data-testid="note-doc-loading">
            <Spinner /> {text("own.notes.ws.loading")}
          </p>
        </Match>
        <Match when={doc()?.status === "error"}>
          <div class="own-note-state">
            <Notice tone="danger" testid="note-doc-error">
              {text("own.notes.ws.loadFailed", { reason: doc()?.error ?? "" })}{" "}
              <button type="button" class="own-link" onClick={() => props.notes.ensure(props.id)}>
                {text("own.notes.retry")}
              </button>
            </Notice>
          </div>
        </Match>
      </Switch>
      <Show when={doc()?.conflict !== undefined}>
        <div class="own-note-state">
          <Notice tone="warn" testid="note-conflict">
            {text(doc()?.conflict ? "own.notes.ws.changedElsewhere" : "own.notes.ws.removedElsewhere")}{" "}
            <button type="button" class="own-link" onClick={() => props.notes.resolve(props.id, "theirs")}>
              {text(doc()?.conflict ? "own.notes.reload" : "own.notes.ws.discard")}
            </button>{" "}
            <button type="button" class="own-link" onClick={() => props.notes.resolve(props.id, "mine")}>
              {text("own.notes.ws.keepMine")}
            </button>
          </Notice>
        </div>
      </Show>
      <input
        ref={title}
        class="own-note-title"
        aria-label={text("own.notes.ws.titleLabel")}
        maxLength={Notes.TITLE_MAX}
        readOnly={!editable()}
        onInput={(event) => props.notes.update(props.id, { title: event.currentTarget.value })}
      />
      <textarea
        ref={area}
        class="own-note-text"
        aria-label={text("own.notes.ws.textLabel")}
        spellcheck={false}
        readOnly={!editable()}
        placeholder={text("own.notes.ws.placeholder")}
        onInput={(event) => props.notes.update(props.id, { text: event.currentTarget.value })}
        onCompositionStart={() => (composing = true)}
        onCompositionEnd={() => (composing = false)}
        onBlur={() => void props.notes.flush()}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") {
            event.preventDefault()
            void props.notes.flush()
          }
        }}
      />
      {/* 03 §19.10: dictation into this note, only while it can be edited (not on a device without `prompt`). */}
      <DictationButton target={() => area} disabled={() => !editable()} testid="workspace-note-voice" />
    </div>
  )
}
