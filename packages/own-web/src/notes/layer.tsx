// Mounted once by the shell: opens the `대화 메모` dialog on `own:open-notes` (03 §19.10). The dialog and the editor
// are a lazy chunk fetched on first use.
import { createSignal, lazy, onCleanup, Show, Suspense } from "solid-js"
import { OPEN_NOTES, type OpenNotesDetail } from "./intents"

const NotesDialog = lazy(() => import("./dialog"))

export function NotesLayer() {
  const [target, setTarget] = createSignal<OpenNotesDetail>()
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && isDetail(event.detail)) setTarget({ ...event.detail })
  }
  window.addEventListener(OPEN_NOTES, listener)
  onCleanup(() => window.removeEventListener(OPEN_NOTES, listener))
  return (
    <Show when={target()} keyed>
      {(current) => (
        <Suspense>
          <NotesDialog
            serverKey={current.serverKey}
            sessionID={current.sessionID}
            onClose={() => setTarget(undefined)}
          />
        </Suspense>
      )}
    </Show>
  )
}

function isDetail(value: unknown): value is OpenNotesDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "serverKey" in value &&
    typeof value.serverKey === "string" &&
    "sessionID" in value &&
    typeof value.sessionID === "string"
  )
}
