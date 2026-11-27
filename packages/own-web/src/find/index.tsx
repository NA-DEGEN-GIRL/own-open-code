// Find in session (03 §19.13, [gap] 29): `Ctrl+F` opens a find bar over the virtualized transcript, the search index
// lives in a worker, matches are jumped to and highlighted; `Ctrl+Alt+[` / `]` move between messages (turns).
//
// Mount `<SessionFind>` inside the transcript area (a `position: relative` box; the bar floats at its top right). Best
// from the transcript view, which can hand over its virtualizer's `revealMessage`, `follow.unpin` and scroller; from
// anywhere else it finds the open transcript's scroller in the DOM and seeks turns itself. Loaded with the transcript
// chunk (lazy); the worker starts only when the bar opens.
import type { SessionMessageInfo } from "@opencode/client"
import { createEffect, onCleanup, type Accessor } from "solid-js"
import type { ServerRuntime } from "@/data"
import { useShortcut } from "@/keyboard"
import { usePaneFocused } from "@/shell/pane-context"
import { FindBar } from "./bar"
import { createSessionFind } from "./controller"
import { claimSessionFind } from "./priority"

export { createSessionFind, type SessionFindController } from "./controller"
export { documentsOf, turnsOf, type FindDoc } from "./model"

export interface SessionFindProps {
  readonly runtime: Accessor<Pick<ServerRuntime, "data"> | undefined>
  readonly sessionID: Accessor<string | undefined>
  /** The transcript is on screen (the view is selected and no page covers it). Default: always. */
  readonly active?: Accessor<boolean>
  /** The transcript's scroll element; default: the open transcript's, looked up in the DOM. */
  readonly scroller?: Accessor<HTMLElement | undefined>
  /**
   * Brings a turn into the transcript's message window before the bar seeks it; a promise while a page this view
   * dropped is read again (transcript/history.ts).
   */
  readonly reveal?: (turnID: string, partID?: string) => void | Promise<void>
  /** The transcript's `follow.unpin`. */
  readonly unpin?: () => void
  /** Runs before the bar opens (the transcript unfolds what a context reset folded, 03 §4.5). */
  readonly onOpen?: () => void
  /** The messages the transcript holds (its pages and the store's); default: the store's. */
  readonly messages?: Accessor<readonly SessionMessageInfo[]>
  /** The transcript would hold this message if it still existed (a match of a removed message is dropped). */
  readonly covers?: (messageID: string) => boolean
  /** Older messages to read, reading them and whether a read runs; default: the store's paging. */
  readonly more?: Accessor<boolean>
  readonly loadingOlder?: Accessor<boolean>
  readonly loadOlder?: () => Promise<void>
}

const NO_MESSAGES: readonly SessionMessageInfo[] = []

export function SessionFind(props: SessionFindProps) {
  const data = () => props.runtime()?.data
  // 03 §4.1.1: only the focused split pane's transcript takes Ctrl+F and message navigation.
  const paneFocused = usePaneFocused()
  const active = () => paneFocused() && (props.active?.() ?? true) && !!props.sessionID() && !!data()
  const find = createSessionFind({
    sessionID: props.sessionID,
    messages: () => {
      if (props.messages) return props.messages()
      const id = props.sessionID()
      const current = data()
      return id && current ? current.session.message.list(id) : NO_MESSAGES
    },
    covers: props.covers,
    active,
    scroller: () => props.scroller?.() ?? transcriptScroller(props.sessionID()),
    reveal: props.reveal,
    unpin: props.unpin,
    more: () => {
      if (props.more) return props.more()
      const id = props.sessionID()
      return !!id && !!data()?.session.message.more(id)
    },
    loadingOlder: () => {
      if (props.loadingOlder) return props.loadingOlder()
      const id = props.sessionID()
      return !!id && !!data()?.session.message.loading(id)
    },
    loadOlder: async () => {
      if (props.loadOlder) return props.loadOlder()
      const id = props.sessionID()
      if (id) await data()?.session.message.loadMore(id)
    },
  })
  // Without an open session the browser's own find stays available (the handler lets the key through).
  const open = () => {
    props.onOpen?.()
    find.open()
  }
  useShortcut("session.find", () => (active() ? open() : false), { when: active })
  // Ahead of session-ui's file find, which takes Ctrl+F page-wide once a file viewer mounted (./priority.ts).
  createEffect(() => {
    if (active()) onCleanup(claimSessionFind(() => void open()))
  })
  useShortcut("message.previous", () => (active() ? find.navigateTurn(-1) : false), { when: active })
  useShortcut("message.next", () => (active() ? find.navigateTurn(1) : false), { when: active })
  return <FindBar find={find} />
}

/** The open transcript's scroll element (the vendored virtualizer's `ScrollView` viewport). */
function transcriptScroller(sessionID: string | undefined) {
  if (!sessionID || typeof document !== "object") return undefined
  return (
    document.querySelector<HTMLElement>(
      `[data-testid="transcript-body"][data-session-id="${CSS.escape(sessionID)}"] [data-slot="session-timeline-scroll"] .scroll-view__viewport`,
    ) ?? undefined
  )
}
