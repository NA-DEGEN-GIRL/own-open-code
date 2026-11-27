// The idea board (03 §4.4.1 아이디어 노트, lazy chunk): every idea as a sticky note, pinned ones first, then newest
// first. A capture field on top (on the phone behind the floating `+`), a search and the `#tags` as filters. A card
// edits in place (Ctrl+Enter saves, Esc cancels), pins to the top, changes its paper, and becomes a new conversation's
// draft (never sent), a project note, or the clipboard; a removal can be undone for a few seconds. A modal dialog on
// wide screens, the whole screen on the phone.
import { Ideas } from "@own/protocol/ideas"
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { LOCAL, useData } from "@/data"
import { useI18n } from "@/i18n"
import { commitComposition, createImeEnter, isImeKey } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { mergeRecent, openedFolders } from "@/projects"
import { useRouter } from "@/routing/router"
import { useShell } from "@/shell/context"
import { relativeTime } from "@/shell/format"
import { minuteNow } from "@/shell/clock"
import { DictationButton } from "@/voice"
import { copyText, moveToProject, startConversation } from "./actions"
import { CaptureForm, ColorPicker } from "./capture"
import { isOpenIdeas, OPEN_IDEAS } from "./intents"
import { BulbIcon } from "./layer"
import { filterIdeas, segments, sortIdeas, tagCounts, type Idea } from "./model"
import { ideasOf, type IdeasStore } from "./store"
import { useIdeasText } from "./strings"

/** How long `되돌리기` stays after a removal (03 §9: toasts with an action stay 8 s). */
const UNDO_MS = 8_000
const NOTICE_MS = 4_000

export default function IdeaBoard(props: { readonly onClose: () => void }) {
  const text = useIdeasText()
  const data = useData()
  const shell = useShell()
  const router = useRouter()
  const runtime = data.local()
  const ideas = ideasOf(runtime)
  const heading = createUniqueId()
  const opener = document.activeElement
  let dialog!: HTMLDialogElement
  let captureField: HTMLTextAreaElement | undefined

  const [query, setQuery] = createSignal("")
  const [tag, setTag] = createSignal<string>()
  const [capturing, setCapturing] = createSignal(false)
  const [removed, setRemoved] = createSignal<Idea>()
  const [moving, setMoving] = createSignal<Idea>()
  const [notice, setNotice] = createSignal<{ readonly message: string; readonly tone?: "danger" }>()
  const phone = () => shell.tier() === "phone"
  const sorted = createMemo(() => sortIdeas(ideas.state.ideas))
  const shown = createMemo(() => filterIdeas(sorted(), { query: query(), tag: tag() }))
  const tags = createMemo(() => tagCounts(ideas.state.ideas))

  onMount(() => {
    ideas.ensure()
    if (typeof dialog.showModal === "function") dialog.showModal()
    else dialog.setAttribute("open", "")
    if (!phone()) captureField?.focus({ preventScroll: true })
    // `idea.capture` and the palette while the board is open: its own capture field.
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isOpenIdeas(event.detail) || event.detail.view !== "capture") return
      setCapturing(true)
      requestAnimationFrame(() => captureField?.focus())
    }
    window.addEventListener(OPEN_IDEAS, listener)
    onCleanup(() => window.removeEventListener(OPEN_IDEAS, listener))
  })
  onCleanup(() => {
    if (dialog.open && typeof dialog.close === "function") dialog.close()
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
  })
  // A tag no idea carries any more (removed, edited away) stops filtering.
  createEffect(() => {
    const current = tag()
    if (current && !tags().some((entry) => entry.tag === current)) setTag(undefined)
  })
  createEffect(() => {
    if (!removed()) return
    const timer = setTimeout(() => setRemoved(undefined), UNDO_MS)
    onCleanup(() => clearTimeout(timer))
  })
  createEffect(() => {
    if (!notice()) return
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS)
    onCleanup(() => clearTimeout(timer))
  })

  const remove = async (idea: Idea) => {
    const result = await ideas.remove(idea.id)
    if (result.type === "ok") return setRemoved(result.removed)
    if (result.type === "error")
      return setNotice({ message: text("own.ideas.failed", { reason: result.message }), tone: "danger" })
    setNotice({ message: text(result.current ? "own.ideas.changedElsewhere" : "own.ideas.removedElsewhere") })
  }
  const undo = async () => {
    const idea = removed()
    if (!idea) return
    setRemoved(undefined)
    const result = await ideas.restore(idea)
    if (result.type !== "ok")
      setNotice({
        message: text("own.ideas.failed", { reason: result.type === "error" ? result.message : result.type }),
        tone: "danger",
      })
  }
  const start = (idea: Idea) => {
    props.onClose()
    startConversation(idea.text, () => router.navigate({ name: "home" }))
  }
  const copy = async (idea: Idea) => {
    if (await copyText(idea.text)) setNotice({ message: text("own.ideas.copied") })
  }

  return (
    <dialog
      ref={dialog}
      class="own-dialog own-ideas-board"
      aria-labelledby={heading}
      aria-modal="true"
      data-testid="idea-board"
      data-own-keys="dialog"
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (eventCode(event) !== "Escape" || isImeKey(event)) return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
    >
      <header class="own-ideas-board-head">
        <BulbIcon />
        <h2 id={heading}>{text("own.ideas.title")}</h2>
        <Show when={ideas.state.status === "ready"}>
          <span class="own-ideas-faint" data-testid="idea-total">
            {text("own.ideas.total", { n: ideas.state.ideas.length })}
          </span>
        </Show>
        <span class="own-ideas-faint own-ideas-where">{text("own.ideas.where")}</span>
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.ideas.close")}
          data-testid="idea-board-close"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </header>
      <div class="own-ideas-board-body">
        <Show when={!phone() || capturing()}>
          <CaptureForm
            ref={(element) => (captureField = element)}
            autofocus={capturing()}
            onSaved={() => {
              if (phone()) setCapturing(false)
            }}
          />
        </Show>
        <div class="own-ideas-toolbar">
          <input
            type="search"
            class="own-ideas-search"
            aria-label={text("own.ideas.search")}
            placeholder={text("own.ideas.searchPlaceholder")}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            data-testid="idea-search"
          />
          <Show when={tags().length > 0}>
            <div class="own-ideas-tags" role="group" aria-label={text("own.ideas.tags")}>
              <button
                type="button"
                class="own-ideas-chip"
                aria-pressed={tag() === undefined}
                onClick={() => setTag(undefined)}
              >
                {text("own.ideas.allTags")}
              </button>
              <For each={tags()}>
                {(entry) => (
                  <button
                    type="button"
                    class="own-ideas-chip"
                    aria-pressed={tag() === entry.tag}
                    data-testid="idea-tag"
                    onClick={() => setTag(tag() === entry.tag ? undefined : entry.tag)}
                  >
                    #{entry.tag} <span class="own-ideas-faint">{entry.count}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <Switch>
          <Match when={ideas.state.status === "loading"}>
            <p class="own-ideas-state" role="status">
              <Spinner /> {text("own.ideas.loading")}
            </p>
          </Match>
          <Match when={ideas.state.status === "error"}>
            <Notice tone="danger" testid="idea-load-error">
              {text("own.ideas.loadFailed", { reason: ideas.state.error ?? "" })}{" "}
              <button type="button" class="own-link" onClick={() => void ideas.load()}>
                {text("own.ideas.retry")}
              </button>
            </Notice>
          </Match>
          <Match when={ideas.state.ideas.length === 0}>
            <p class="own-ideas-empty" data-testid="idea-empty">
              <BulbIcon />
              {text("own.ideas.empty")}
            </p>
          </Match>
          <Match when={shown().length === 0}>
            <p class="own-ideas-state">{text("own.ideas.noMatch")}</p>
          </Match>
          <Match when={true}>
            <ul class="own-ideas-grid" data-testid="idea-grid">
              <For each={shown()}>
                {(idea) => (
                  <IdeaCard
                    idea={idea}
                    store={ideas}
                    onTag={setTag}
                    onRemove={() => void remove(idea)}
                    onStart={() => start(idea)}
                    onMove={() => setMoving(idea)}
                    onCopy={() => void copy(idea)}
                  />
                )}
              </For>
            </ul>
          </Match>
        </Switch>
      </div>
      <Show when={phone() && !capturing()}>
        <button
          type="button"
          class="own-ideas-fab"
          aria-label={text("own.ideas.capture.fab")}
          data-testid="idea-fab"
          disabled={!ideas.writable()}
          onClick={() => {
            setCapturing(true)
            requestAnimationFrame(() => captureField?.focus())
          }}
        >
          +
        </button>
      </Show>
      <div class="own-ideas-bar" role="status" aria-live="polite">
        <Show when={removed()}>
          <span data-testid="idea-undo-bar">
            {text("own.ideas.deleted")}
            <button type="button" class="own-link" data-testid="idea-undo" onClick={() => void undo()}>
              {text("own.ideas.undo")}
            </button>
          </span>
        </Show>
        <Show when={notice()}>
          {(current) => (
            <span data-tone={current().tone} data-testid="idea-notice">
              {current().message}
            </span>
          )}
        </Show>
      </div>
      <Show when={moving()}>
        {(idea) => (
          <MoveDialog
            idea={idea()}
            store={ideas}
            onClose={() => setMoving(undefined)}
            onMoved={(project) => {
              setMoving(undefined)
              setNotice({ message: text("own.ideas.move.done", { project }) })
            }}
          />
        )}
      </Show>
    </dialog>
  )
}

function IdeaCard(props: {
  readonly idea: Idea
  readonly store: IdeasStore
  readonly onTag: (tag: string) => void
  readonly onRemove: () => void
  readonly onStart: () => void
  readonly onMove: () => void
  readonly onCopy: () => void
}) {
  const text = useIdeasText()
  const i18n = useI18n()
  const [editing, setEditing] = createSignal(false)
  const [base, setBase] = createSignal(0)
  const [conflict, setConflict] = createSignal<"changed" | "removed">()
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [menu, setMenu] = createSignal(false)
  const writable = () => props.store.writable()
  let area: HTMLTextAreaElement | undefined
  let card!: HTMLLIElement

  const edit = () => {
    if (!writable()) return
    setBase(props.idea.rev)
    setConflict(undefined)
    setFailure(undefined)
    setEditing(true)
    // The text is in the field from its first render (the `ref` below); only the focus waits for the frame. A value
    // written here in the frame landed after a fast first input (Playwright's `fill` under load) and joined it.
    requestAnimationFrame(() => {
      if (!area) return
      area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
    })
  }
  const save = async () => {
    if (!area || saving()) return
    const value = area.value.replace(/\s+$/, "")
    if (!/\S/.test(value)) return setFailure(text("own.ideas.failed", { reason: "empty" }))
    if (value.length > Ideas.TEXT_MAX) return setFailure(text("own.ideas.tooLong", { max: Ideas.TEXT_MAX }))
    setSaving(true)
    // A removed idea comes back with this text; otherwise the edit names the revision it started from.
    const result = await (
      conflict() === "removed"
        ? props.store.restore({ ...props.idea, text: value })
        : props.store.edit(props.idea.id, { text: value }, base())
    ).finally(() => setSaving(false))
    if (result.type === "ok") return setEditing(false)
    if (result.type === "conflict") {
      // The card shows the stored text now; the user's stays in the field for `내 글로 저장`.
      setConflict(result.current ? "changed" : "removed")
      if (result.current) setBase(result.current.rev)
      return
    }
    setFailure(
      result.type === "limit"
        ? text("own.ideas.limit", { max: result.max })
        : text("own.ideas.failed", { reason: result.message }),
    )
  }
  const ime = createImeEnter({ onEnter: (modifier) => modifier && void save() })

  // The `⋯` menu closes on a press outside it and on Esc (before the board's own Esc).
  createEffect(() => {
    if (!menu()) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !card.querySelector(".own-ideas-menu-wrap")?.contains(event.target))
        setMenu(false)
    }
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  })
  const act = (run: () => void) => () => {
    setMenu(false)
    run()
  }
  const time = () => {
    const created = relativeTime(i18n, minuteNow(), props.idea.createdAt)
    return props.idea.updatedAt - props.idea.createdAt > 60_000 ? text("own.ideas.edited", { time: created }) : created
  }

  return (
    <li
      ref={card}
      class="own-ideas-card"
      data-color={props.idea.color}
      data-pinned={props.idea.pinned ? "" : undefined}
      data-testid="idea-card"
    >
      <Show when={props.idea.pinned}>
        <span class="own-ideas-pin-mark" title={text("own.ideas.pinned")} aria-label={text("own.ideas.pinned")}>
          <PinIcon />
        </span>
      </Show>
      <Show
        when={editing()}
        fallback={
          <p class="own-ideas-text" data-testid="idea-text" onDblClick={edit}>
            <For each={segments(props.idea.text)}>
              {(part) =>
                part.tag ? (
                  <button type="button" class="own-ideas-tag" onClick={() => props.onTag(part.tag!)}>
                    {part.text}
                  </button>
                ) : (
                  part.text
                )
              }
            </For>
          </p>
        }
      >
        <div class="own-ideas-editor">
          <textarea
            ref={(element) => {
              area = element
              element.value = props.idea.text
            }}
            class="own-ideas-field"
            rows={4}
            aria-label={text("own.ideas.editLabel")}
            data-testid="idea-edit-input"
            onInput={() => ime.input()}
            onKeyDown={(event) => {
              if (eventCode(event) === "Escape" && !isImeKey(event, ime.composing())) {
                event.preventDefault()
                event.stopPropagation()
                return setEditing(false)
              }
              // Enter is a new line here; Ctrl+Enter saves (after a running composition commits).
              if (event.ctrlKey || event.metaKey) ime.keydown(event)
            }}
            onKeyUp={ime.listeners.onKeyUp}
            onCompositionStart={ime.listeners.onCompositionStart}
            onCompositionEnd={ime.listeners.onCompositionEnd}
          />
          <Show when={conflict()}>
            {(kind) => (
              <p class="own-ideas-note" role="alert" data-testid="idea-conflict">
                {text(kind() === "changed" ? "own.ideas.changedElsewhere" : "own.ideas.removedElsewhere")}
              </p>
            )}
          </Show>
          <Show when={failure()}>
            {(message) => (
              <p class="own-ideas-note" data-tone="danger" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <div class="own-ideas-form-row">
            <DictationButton target={() => area} testid="idea-edit-voice" />
            <span class="own-ideas-grow" />
            <button type="button" class="own-btn" onClick={() => setEditing(false)}>
              {text("own.ideas.cancel")}
            </button>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              disabled={saving()}
              data-testid="idea-edit-save"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void (area ? commitComposition(area, ime.composing()) : Promise.resolve()).then(save)}
            >
              {text(conflict() ? "own.ideas.keepMine" : "own.ideas.save")}
            </button>
          </div>
        </div>
      </Show>
      <footer class="own-ideas-card-foot">
        <time
          class="own-ideas-faint"
          dateTime={new Date(props.idea.createdAt).toISOString()}
          title={new Date(props.idea.createdAt).toLocaleString(i18n.locale() === "ko" ? "ko-KR" : "en-US")}
        >
          {time()}
        </time>
        <span class="own-ideas-grow" />
        <Show when={writable()}>
          <button
            type="button"
            class="own-icon-button"
            aria-label={text(props.idea.pinned ? "own.ideas.unpin" : "own.ideas.pin")}
            title={text(props.idea.pinned ? "own.ideas.unpin" : "own.ideas.pin")}
            aria-pressed={props.idea.pinned}
            data-testid="idea-pin"
            onClick={() => void props.store.edit(props.idea.id, { pinned: !props.idea.pinned })}
          >
            <PinIcon />
          </button>
          <button
            type="button"
            class="own-icon-button"
            aria-label={text("own.ideas.edit")}
            title={text("own.ideas.edit")}
            data-testid="idea-edit"
            onClick={edit}
          >
            <PencilIcon />
          </button>
        </Show>
        <span class="own-ideas-menu-wrap">
          <button
            type="button"
            class="own-icon-button"
            aria-label={text("own.ideas.more")}
            aria-haspopup="menu"
            aria-expanded={menu()}
            data-testid="idea-more"
            onClick={() => setMenu(!menu())}
          >
            <span aria-hidden="true" class="own-ico own-ico-more" />
          </button>
          <Show when={menu()}>
            <div
              class="own-ideas-menu"
              role="menu"
              data-testid="idea-menu"
              onKeyDown={(event) => {
                if (eventCode(event) !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
                setMenu(false)
              }}
            >
              <Show when={writable()}>
                <ColorPicker
                  value={props.idea.color}
                  label={text("own.ideas.color")}
                  onChange={(color) => void props.store.edit(props.idea.id, { color })}
                />
              </Show>
              <button
                type="button"
                role="menuitem"
                title={text("own.ideas.startChatHint")}
                data-testid="idea-start-chat"
                onClick={act(props.onStart)}
              >
                {text("own.ideas.startChat")}
              </button>
              <Show when={writable()}>
                <button type="button" role="menuitem" data-testid="idea-move" onClick={act(props.onMove)}>
                  {text("own.ideas.moveToProject")}
                </button>
              </Show>
              <button type="button" role="menuitem" data-testid="idea-copy" onClick={act(props.onCopy)}>
                {text("own.ideas.copy")}
              </button>
              <Show when={writable()}>
                <button
                  type="button"
                  role="menuitem"
                  data-tone="danger"
                  data-testid="idea-delete"
                  onClick={act(props.onRemove)}
                >
                  {text("own.ideas.delete")}
                </button>
              </Show>
            </div>
          </Show>
        </span>
      </footer>
    </li>
  )
}

/** The folders of the recent projects on this PC; the idea becomes a note in the chosen one's `노트` tab. */
function MoveDialog(props: {
  readonly idea: Idea
  readonly store: IdeasStore
  readonly onClose: () => void
  readonly onMoved: (project: string) => void
}) {
  const text = useIdeasText()
  const data = useData()
  const runtime = data.local()
  const projects = createMemo(() => mergeRecent(runtime.sessions.state, openedFolders(LOCAL), 12))
  const [busy, setBusy] = createSignal<string>()
  const [failure, setFailure] = createSignal<string>()
  const allowed = () => runtime.rpc.allowed("notes.put")
  const move = async (directory: string, name: string) => {
    setBusy(directory)
    setFailure(undefined)
    const result = await moveToProject(runtime, props.store, props.idea, directory).finally(() => setBusy(undefined))
    if (result.type === "ok") return props.onMoved(name)
    setFailure(text("own.ideas.move.failed", { reason: result.message }))
  }
  return (
    <Dialog open title={text("own.ideas.move.title")} onClose={props.onClose} testid="idea-move-dialog" dismissable>
      <p class="m-0 text-own-muted">{text("own.ideas.move.describe")}</p>
      <Show when={!allowed()}>
        <Notice tone="warn">{text("own.ideas.move.readOnly")}</Notice>
      </Show>
      <Show when={projects().length > 0} fallback={<p class="own-ideas-state">{text("own.ideas.move.none")}</p>}>
        <ul class="own-ideas-projects">
          <For each={projects()}>
            {(project) => (
              <li>
                <button
                  type="button"
                  disabled={!allowed() || busy() !== undefined}
                  data-testid="idea-move-project"
                  onClick={() => void move(project.directory, project.name)}
                >
                  <b>{project.name}</b>
                  <span class="own-ideas-faint">{project.directory}</span>
                  <Show when={busy() === project.directory}>
                    <Spinner />
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={failure()}>{(message) => <Notice tone="danger">{message()}</Notice>}</Show>
    </Dialog>
  )
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  )
}
