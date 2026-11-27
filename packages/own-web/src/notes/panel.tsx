// Conversation memo editor (`대화 메모`, 03 §19.10), the body of the session-info drawer's memo section (5.6) and of the
// memo dialog. Its memo icon and one-line description keep it apart from the workspace `노트` tab (project notes).
// The textarea is uncontrolled: its value is written only when the saved note is adopted and never while composing
// (IME rule 5). Ctrl+Enter saves after committing a running composition (rules 6 and 8). A draft that was not saved
// is kept per session for this window, so closing and reopening the editor does not lose it.
import { createEffect, createSignal, createUniqueId, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { commitComposition } from "@/ime/ime-enter"
import { chordLabel, isMac } from "@/keyboard"
import { Notice, Spinner, Tag } from "@/limits/kit"
import { InlineIcon } from "@/shell/icons"
import { createNoteController, type NoteRuntime } from "./controller"
import { NOTE_LIMIT, pendingEffect, planSave, type NoteValue } from "./model"
import { useNotesText } from "./strings"
import { DictationButton } from "@/voice"

const drafts = new Map<string, NoteValue>()

export interface ThreadNotesProps {
  readonly runtime: NoteRuntime
  readonly serverKey: string
  readonly sessionID: string
  readonly autofocus?: boolean
}

export function ThreadNotes(props: ThreadNotesProps) {
  const text = useNotesText()
  const id = createUniqueId()
  const ctl = createNoteController({ runtime: props.runtime, sessionID: props.sessionID })
  const draftKey = `${props.serverKey}/${props.sessionID}`
  const restored = drafts.get(draftKey)
  const [draft, setDraft] = createStore<NoteValue>(restored ?? { text: "", visible: false })
  /** The saved note the draft started from; `undefined` until the first load. */
  const [base, setBase] = createSignal<NoteValue>()
  const [status, setStatus] = createSignal<{ tone: "ok" | "danger"; message: string }>()
  let area!: HTMLTextAreaElement
  let composing = false

  const dirty = () => {
    const from = base()
    return !!from && (draft.text !== from.text || draft.visible !== from.visible)
  }
  const saved = () => ctl.state.saved
  /** The saved note changed while this draft was being edited (another window, another device). */
  const stale = () => {
    const from = base()
    return !!from && dirty() && (from.text !== saved().text || from.visible !== saved().visible)
  }
  const tooLong = () => draft.text.length > NOTE_LIMIT
  const effect = () => (dirty() ? pendingEffect(saved(), { text: draft.text, visible: modelOn() }) : undefined)
  const modelOn = () => draft.visible && ctl.canShowModel()

  function adopt(value: NoteValue) {
    setDraft({ text: value.text, visible: value.visible })
    setBase({ ...value })
    if (!composing && area.value !== value.text) area.value = value.text
  }

  // The first load fills the editor (or keeps a restored draft); later saved changes are adopted while the editor
  // holds no changes of its own.
  createEffect(
    on(
      () => (ctl.state.status === "ready" ? { text: saved().text, visible: saved().visible } : undefined),
      (value) => {
        if (!value) return
        // A restored draft stays; it is compared against what the server holds now.
        if (!base()) return restored ? void setBase(value) : adopt(value)
        if (!dirty()) adopt(value)
      },
    ),
  )

  onMount(() => {
    if (restored) area.value = restored.text
    if (props.autofocus) requestAnimationFrame(() => area.focus())
  })
  onCleanup(() => {
    if (dirty()) drafts.set(draftKey, { ...unwrap(draft) })
    else drafts.delete(draftKey)
  })

  async function save() {
    if (ctl.state.saving) return
    await commitComposition(area, composing)
    setDraft("text", area.value)
    if (tooLong()) return setStatus({ tone: "danger", message: text("own.notes.tooLong", { max: NOTE_LIMIT }) })
    const plan = planSave(saved(), { text: draft.text, visible: modelOn() })
    const ok = await ctl.save({ text: draft.text, visible: draft.visible })
    if (!ok) return setStatus({ tone: "danger", message: text("own.notes.failed", { reason: ctl.state.error ?? "" }) })
    adopt(saved())
    drafts.delete(draftKey)
    setStatus({
      tone: "ok",
      message: text(
        plan.entry === "put"
          ? "own.notes.nextRequest"
          : plan.entry === "remove"
            ? "own.notes.removeNext"
            : "own.notes.saved",
      ),
    })
  }

  function revert() {
    adopt(saved())
    drafts.delete(draftKey)
    setStatus(undefined)
  }

  const saveKeys = chordLabel("Mod+Enter")

  return (
    <section class="flex flex-col gap-2" aria-labelledby={`${id}-title`} data-testid="thread-notes">
      <div class="flex items-center gap-2">
        <h3 id={`${id}-title`} class="m-0 flex items-center gap-1.5 text-[13.5px] font-semibold">
          <InlineIcon name="memo" />
          {text("own.notes.title")}
        </h3>
        <Show
          when={saved().visible}
          fallback={<span class="text-[11.5px] text-own-faint">{text("own.notes.uiOnly")}</span>}
        >
          <Tag tone="accent" testid="notes-visible-tag">
            {text("own.notes.visibleBadge")}
          </Tag>
        </Show>
      </div>
      <p id={`${id}-describe`} class="m-0 text-[12px] leading-[18px] text-own-muted" data-testid="notes-describe">
        {text("own.notes.describe")}
      </p>
      <Show when={ctl.state.status === "error" && !base()}>
        <Notice tone="danger" testid="notes-load-error">
          {text("own.notes.loadFailed", { reason: ctl.state.error ?? "" })}{" "}
          <button type="button" class="own-link" onClick={() => void ctl.load()}>
            {text("own.notes.retry")}
          </button>
        </Notice>
      </Show>
      <div class="relative">
        <textarea
          ref={area}
          id={`${id}-text`}
          aria-label={text("own.notes.label")}
          aria-describedby={`${id}-describe ${id}-count`}
          aria-busy={!base()}
          rows={6}
          maxLength={NOTE_LIMIT * 2}
          placeholder={text("own.notes.placeholder")}
          disabled={!base() && ctl.state.status !== "ready"}
          class="block min-h-[120px] w-full resize-y rounded-lg border border-own-border-input bg-own-bg px-3 py-2 text-[13.5px] leading-5 text-own-text outline-none placeholder:text-own-faint focus:border-own-focus disabled:opacity-60"
          data-testid="notes-input"
          onInput={(event) => {
            setDraft("text", event.currentTarget.value)
            setStatus(undefined)
          }}
          onCompositionStart={() => (composing = true)}
          onCompositionEnd={() => (composing = false)}
          onKeyDown={(event) => {
            const enter = event.code === "Enter" || event.code === "NumpadEnter"
            if (!enter || !(isMac ? event.metaKey : event.ctrlKey)) return
            // Ctrl+Enter saves, also mid-composition (the composition is committed first, rule 6).
            event.preventDefault()
            if (!event.repeat) void save()
          }}
        />
        <Show when={!base() && ctl.state.status === "loading"}>
          <span class="absolute top-2 right-3 flex items-center gap-1.5 text-[12px] text-own-faint" role="status">
            <Spinner />
            {text("own.notes.loading")}
          </span>
        </Show>
      </div>
      <div class="flex items-center gap-2 text-[11.5px] text-own-faint">
        <span id={`${id}-count`} classList={{ "text-own-danger": tooLong() }} data-testid="notes-count">
          {text("own.notes.count", { n: draft.text.length, max: NOTE_LIMIT })}
        </span>
        <span class="ml-auto">{text("own.notes.saveHint", { keys: saveKeys })}</span>
        <DictationButton target={() => area} testid="notes-voice" />
      </div>
      <label class="flex items-start gap-2 text-[13px]" classList={{ "opacity-60": !ctl.canShowModel() }}>
        <input
          type="checkbox"
          class="mt-[3px] accent-[var(--own-accent)]"
          checked={modelOn()}
          disabled={!ctl.canShowModel()}
          aria-describedby={`${id}-model-hint`}
          data-testid="notes-model-toggle"
          onChange={(event) => {
            setDraft("visible", event.currentTarget.checked)
            setStatus(undefined)
          }}
        />
        <span class="flex flex-col gap-0.5">
          <span class="font-semibold">{text("own.notes.modelToggle")}</span>
          <span id={`${id}-model-hint`} class="text-[12px] leading-[17px] text-own-muted">
            <Show
              when={ctl.canShowModel() || ctl.state.status !== "ready"}
              fallback={text(ctl.state.entries ? "own.notes.noScope" : "own.notes.unsupported")}
            >
              {text("own.notes.modelHint")}
            </Show>
          </span>
        </span>
      </label>
      <Show when={effect()}>
        {(pending) => (
          <p class="m-0 text-[12px] text-own-accent-text" data-testid="notes-pending">
            {text(pending() === "add" ? "own.notes.nextRequest" : "own.notes.removeNext")}
          </p>
        )}
      </Show>
      <Show when={stale()}>
        <Notice tone="warn" testid="notes-stale">
          {text("own.notes.changedElsewhere")}{" "}
          <button type="button" class="own-link" onClick={() => revert()}>
            {text("own.notes.reload")}
          </button>
        </Notice>
      </Show>
      <div class="flex items-center gap-2">
        <p
          class="m-0 min-w-0 flex-1 text-[12px]"
          classList={{ "text-own-danger": status()?.tone === "danger", "text-own-muted": status()?.tone === "ok" }}
          role="status"
          data-testid="notes-status"
        >
          {ctl.state.saving ? text("own.notes.saving") : (status()?.message ?? "")}
        </p>
        <Show when={dirty()}>
          <button type="button" class="own-btn" data-size="sm" data-testid="notes-revert" onClick={() => revert()}>
            {text("own.notes.revert")}
          </button>
        </Show>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-variant="primary"
          disabled={!dirty() || tooLong() || ctl.state.saving}
          data-testid="notes-save"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void save()}
        >
          {text("own.notes.save")}
        </button>
      </div>
    </section>
  )
}
