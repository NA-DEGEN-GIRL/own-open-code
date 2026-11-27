// Mounted once by the shell (03 §4.4.1 아이디어 노트): resolves `own:open-ideas`, owns the `idea.capture` shortcut and
// the palette's `아이디어 적기` / `아이디어 노트 열기`, and loads the quick capture and the board (lazy chunks) on first
// use. The quick capture is a small popover over whatever is on screen: the composer keeps its draft, and focus goes
// back to it when the popover closes. While the board is open the board's own capture field takes the shortcut.
import { createSignal, lazy, onCleanup, Show, Suspense } from "solid-js"
import { translate, useI18n } from "@/i18n"
import { chordLabel, useShortcut } from "@/keyboard"
import { usePaletteCommands } from "@/palette"
import { effectiveKeymap } from "@/palette/keymap-store"
import { isOpenIdeas, OPEN_IDEAS, openIdeas, type IdeasView } from "./intents"
import { ideasText, useIdeasText } from "./strings"
import "./ideas.css"

const IdeaCapture = lazy(() => import("./capture"))
const IdeaBoard = lazy(() => import("./board"))

/** Words people type for this feature, in both languages (the palette matches them, never shows them). */
const WORDS = ["idea", "ideas", "sticky", "note", "memo", "아이디어", "스티키", "메모", "포스트잇", "생각"]

export function IdeasLayer() {
  const i18n = useI18n()
  const [view, setView] = createSignal<IdeasView>()
  const open = (next: IdeasView) => {
    // The board has a capture field of its own; it listens to the same request and focuses it.
    if (next === "capture" && view() === "board") return
    setView(next)
  }
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && isOpenIdeas(event.detail)) open(event.detail.view)
  }
  window.addEventListener(OPEN_IDEAS, listener)
  onCleanup(() => window.removeEventListener(OPEN_IDEAS, listener))

  useShortcut("idea.capture", () => {
    if (view() === "capture") return setView(undefined)
    openIdeas("capture")
  })

  usePaletteCommands(() => {
    const other = i18n.locale() === "ko" ? "en" : "ko"
    const words = (key: "own.ideas.palette.capture" | "own.ideas.palette.open") => [
      ideasText.text(other, key),
      translate(other, "own.set.sc.idea.capture"),
      ...WORDS,
    ]
    return [
      {
        id: "ideas.capture",
        group: "notes",
        title: ideasText.text(i18n.locale(), "own.ideas.palette.capture"),
        keywords: words("own.ideas.palette.capture"),
        shortcut: "idea.capture",
        run: () => openIdeas("capture"),
      },
      {
        id: "ideas.open",
        group: "notes",
        title: ideasText.text(i18n.locale(), "own.ideas.palette.open"),
        keywords: words("own.ideas.palette.open"),
        run: () => openIdeas("board"),
      },
    ]
  })

  return (
    <>
      <Show when={view() === "capture"}>
        <Suspense>
          <IdeaCapture onClose={() => setView(undefined)} onOpenBoard={() => setView("board")} />
        </Suspense>
      </Show>
      <Show when={view() === "board"}>
        <Suspense>
          <IdeaBoard onClose={() => setView(undefined)} />
        </Suspense>
      </Show>
    </>
  )
}

/**
 * The header's `아이디어` button (03 §4.4): a bulb named `아이디어 노트`, the tooltip says it is global and gives the
 * quick capture's keys. Icon only: the header's pills need the room on a narrow main column.
 */
export function IdeasButton() {
  const text = useIdeasText()
  const keys = () =>
    effectiveKeymap()
      ["idea.capture"].chords.map((chord) => chordLabel(chord))
      .join(", ") || "—"
  return (
    <button
      type="button"
      class="own-icon-button own-target"
      aria-label={text("own.ideas.title")}
      title={text("own.ideas.buttonHint", { keys: keys() })}
      aria-haspopup="dialog"
      data-testid="header-ideas"
      onClick={() => openIdeas("board")}
    >
      <BulbIcon />
    </button>
  )
}

/** A light bulb in the stroke style of the shell icons (shell/icons.tsx). */
export function BulbIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0012 3z" />
    </svg>
  )
}
