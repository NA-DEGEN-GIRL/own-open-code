// Quick capture (03 §4.4.1 아이디어 노트, lazy chunk): a small popover with one field, opened from anywhere with
// `idea.capture` (Ctrl+Alt+I) or the palette's `아이디어 적기`. Enter (or Ctrl+Enter) sticks the idea on the board,
// Shift+Enter starts a new line, Esc closes and keeps the draft for next time. It sits in the top layer over the screen
// and never touches the composer: its draft, chips and IME state stay, and focus goes back to where it was.
// `CaptureForm` is the same field for the board.
import { Ideas } from "@own/protocol/ideas"
import { createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { useData } from "@/data"
import { commitComposition, createImeEnter, isImeKey } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import { Spinner } from "@/limits/kit"
import { showToast } from "@/switcher/toast"
import { DictationButton } from "@/voice"
import { captureFlow } from "./capture-flow"
import { openIdeas } from "./intents"
import { BulbIcon } from "./layer"
import type { Idea } from "./model"
import { ideasOf } from "./store"
import { useIdeasText, type IdeasKey } from "./strings"

/** The counter shows from here on, so a short idea is not watched by a number. */
const COUNT_FROM = Ideas.TEXT_MAX - 200

export default function IdeaCapture(props: { readonly onClose: () => void; readonly onOpenBoard: () => void }) {
  const text = useIdeasText()
  let element!: HTMLDivElement
  const opener = document.activeElement
  const heading = createUniqueId()

  onMount(() => {
    // The top layer keeps it above the header, drawers and the terminal; where the Popover API is missing it is a
    // fixed box all the same.
    if (typeof element.showPopover === "function") element.showPopover()
    // A press outside closes it (the draft stays); the header button and the palette open it again.
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) props.onClose()
    }
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  })
  onCleanup(() => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
  })

  return (
    <div
      ref={element}
      popover="manual"
      class="own-ideas-capture"
      role="dialog"
      aria-labelledby={heading}
      data-testid="idea-capture"
      onKeyDown={(event) => {
        if (eventCode(event) !== "Escape" || isImeKey(event)) return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
    >
      <header class="own-ideas-capture-head">
        <BulbIcon />
        <b id={heading}>{text("own.ideas.capture.title")}</b>
        <span class="own-ideas-faint">{text("own.ideas.where")}</span>
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.ideas.capture.close")}
          data-testid="idea-capture-close"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </header>
      <CaptureForm
        autofocus
        onSaved={() => {
          props.onClose()
          showToast({
            message: text("own.ideas.capture.saved"),
            action: { label: text("own.ideas.capture.open"), run: () => openIdeas("board") },
          })
        }}
      />
    </div>
  )
}

/** The capture field, its colors, dictation and the save button; shared by the popover and the board. */
export function CaptureForm(props: {
  readonly autofocus?: boolean
  readonly onSaved?: (idea: Idea) => void
  readonly ref?: (element: HTMLTextAreaElement) => void
}) {
  const text = useIdeasText()
  const data = useData()
  const ideas = () => ideasOf(data.local())
  const flow = captureFlow
  let area!: HTMLTextAreaElement
  const save = async () => {
    const idea = await flow.save((value, color) => ideas().add(value, color))
    if (!idea) return
    // Cleared after the save, never inside the IME's commit (03 §12 rule 7): the flow emptied the draft already.
    area.value = flow.draft()
    props.onSaved?.(idea)
  }
  const ime = createImeEnter({ onEnter: () => void save() })
  onMount(() => {
    area.value = flow.draft()
    props.ref?.(area)
    if (props.autofocus) {
      area.focus({ preventScroll: true })
      area.setSelectionRange(area.value.length, area.value.length)
    }
  })
  const problem = () => {
    const current = flow.problem()
    if (!current) return undefined
    if (current.kind === "tooLong") return text("own.ideas.tooLong", { max: current.max })
    if (current.kind === "limit") return text("own.ideas.limit", { max: current.max })
    return text("own.ideas.failed", { reason: current.message })
  }
  return (
    <div class="own-ideas-form" data-color={flow.color()} data-testid="idea-capture-form">
      <textarea
        ref={area}
        class="own-ideas-field"
        rows={3}
        aria-label={text("own.ideas.capture.label")}
        placeholder={text("own.ideas.capture.placeholder")}
        disabled={!ideas().writable()}
        data-testid="idea-capture-input"
        onInput={(event) => {
          ime.input()
          flow.input(event.currentTarget.value)
        }}
        onKeyDown={ime.listeners.onKeyDown}
        onKeyUp={ime.listeners.onKeyUp}
        onCompositionStart={ime.listeners.onCompositionStart}
        onCompositionEnd={ime.listeners.onCompositionEnd}
      />
      <div class="own-ideas-form-row">
        <ColorPicker value={flow.color()} onChange={flow.setColor} label={text("own.ideas.color")} />
        <DictationButton target={() => area} testid="idea-voice" />
        <span class="own-ideas-faint own-ideas-hint">{text("own.ideas.capture.hint")}</span>
        <Show when={flow.draft().length >= COUNT_FROM}>
          <span
            class="own-ideas-count"
            data-over={flow.draft().length > Ideas.TEXT_MAX ? "" : undefined}
            data-testid="idea-capture-count"
          >
            {text("own.ideas.count", { n: flow.draft().length, max: Ideas.TEXT_MAX })}
          </span>
        </Show>
        <button
          type="button"
          class="own-btn own-ideas-save"
          data-variant="primary"
          disabled={!ideas().writable() || flow.saving() || !flow.draft().trim()}
          data-testid="idea-capture-save"
          // The field keeps focus; a running IME composition is committed first (03 §12 rule 6).
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void commitComposition(area, ime.composing()).then(save)}
        >
          <Show when={flow.saving()} fallback={text("own.ideas.capture.save")}>
            <Spinner /> {text("own.ideas.capture.saving")}
          </Show>
        </button>
      </div>
      <Show when={!ideas().writable()}>
        <p class="own-ideas-note" role="status">
          {text("own.ideas.readOnly")}
        </p>
      </Show>
      <Show when={problem()}>
        {(message) => (
          <p class="own-ideas-note" data-tone="danger" role="alert" data-testid="idea-capture-problem">
            {message()}
          </p>
        )}
      </Show>
    </div>
  )
}

/** The five paper colors as a radio group; the name of each is its label (color is never the only cue). */
export function ColorPicker(props: {
  readonly value: Idea["color"]
  readonly onChange: (color: Idea["color"]) => void
  readonly label: string
  readonly disabled?: boolean
}) {
  const text = useIdeasText()
  return (
    <span class="own-ideas-colors" role="radiogroup" aria-label={props.label}>
      <For each={Ideas.COLORS}>
        {(color) => (
          <button
            type="button"
            role="radio"
            class="own-ideas-swatch"
            data-color={color}
            aria-checked={props.value === color}
            aria-label={text(`own.ideas.color.${color}` as IdeasKey)}
            title={text(`own.ideas.color.${color}` as IdeasKey)}
            disabled={props.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onChange(color)}
          />
        )}
      </For>
    </span>
  )
}
