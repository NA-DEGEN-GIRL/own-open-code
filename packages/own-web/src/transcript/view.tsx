// Lazy transcript chunk (03 §20.2 R5): session-ui, the vendored virtualizer and the transcript stylesheet load here,
// not in the first chunk. Session views are cached (LRU, upstream `createTimelineCache`): switching back to a recent
// session re-attaches its rows instead of rebuilding them (PF7). A detached view is inactive: it freezes its inputs,
// stops measuring, releases its open-session watch and keeps its scroll offset for the next attach. Split panes
// (03 §4.1.1) each keep their own views, but the detached ones share one window budget (pool.ts): 8 plus the shown ones.
import "./transcript.css"
import { createMemo, createRoot, createSignal, getOwner, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { SessionUiShell } from "@/adapter/session-ui"
import { useI18n } from "@/i18n"
import type { TranscriptRuntime } from "./context"
import { createViewPool, type PooledView } from "./pool"
import { createSwitchRecords } from "./records"
import { SessionTranscript } from "./session"

/** Detached views kept per window, over every pane and server (upstream keeps 16; their DOM stays in memory, T1). */
const CACHED_VIEWS = 8
const pool = createViewPool(CACHED_VIEWS)

export interface TranscriptViewProps {
  readonly runtime: Accessor<TranscriptRuntime | undefined>
  readonly sessionID: Accessor<string>
  readonly active: Accessor<boolean>
  readonly onNavigate: (sessionID: string) => void
  readonly sessionHref: (sessionID: string) => string
}

export default function TranscriptView(props: TranscriptViewProps) {
  const i18n = useI18n()
  return (
    <SessionUiShell locale={i18n.locale}>
      <Show when={props.runtime()} keyed>
        {(runtime) => <RuntimeTranscript {...props} runtime={runtime} />}
      </Show>
    </SessionUiShell>
  )
}

interface CachedView {
  readonly element: JSX.Element
  readonly setSelected: (selected: boolean) => void
  readonly dispose: () => void
  readonly pooled: PooledView
}

function RuntimeTranscript(props: Omit<TranscriptViewProps, "runtime"> & { readonly runtime: TranscriptRuntime }) {
  // Switch records outlive a session view, so a marker still finds the record after switching sessions and back.
  const records = createSwitchRecords(props.runtime.own)
  onCleanup(records.dispose)
  const owner = getOwner()
  const views = new Map<string, CachedView>()
  onCleanup(() =>
    views.forEach((view) => {
      pool.forget(view.pooled)
      view.dispose()
    }),
  )

  const create = (sessionID: string) =>
    createRoot((dispose): CachedView => {
      const [selected, setSelected] = createSignal(true)
      const element = (
        <SessionTranscript
          runtime={props.runtime}
          sessionID={sessionID}
          records={records}
          selected={selected}
          active={() => selected() && props.active()}
          onNavigate={props.onNavigate}
          sessionHref={props.sessionHref}
        />
      )
      const pooled: PooledView = {
        evict() {
          views.delete(sessionID)
          dispose()
        },
      }
      return { element, setSelected, dispose, pooled }
    }, owner)

  let shown: CachedView | undefined
  const current = createMemo(() => {
    const sessionID = props.sessionID()
    const view = sessionID ? (views.get(sessionID) ?? create(sessionID)) : undefined
    if (sessionID && view) views.set(sessionID, view)
    views.forEach((other, key) => other.setSelected(key === sessionID))
    // The pool disposes the least recently used detached view (of any pane) beyond the budget.
    if (shown && shown !== view) pool.detach(shown.pooled)
    shown = view
    if (view) pool.attach(view.pooled)
    return view?.element
  })
  return <>{current()}</>
}
