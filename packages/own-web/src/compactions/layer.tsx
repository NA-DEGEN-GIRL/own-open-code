// Mounted once by the shell: opens the 압축 내용 dialog on `own:open-compactions` (UC 2026-10-18). The dialog is a lazy
// chunk fetched on first use.
import { createSignal, lazy, onCleanup, Show, Suspense } from "solid-js"
import { OPEN_COMPACTIONS, type OpenCompactionsDetail } from "./intents"

const CompactionsDialog = lazy(() => import("./dialog"))

export function CompactionsLayer() {
  const [target, setTarget] = createSignal<OpenCompactionsDetail>()
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && isDetail(event.detail)) setTarget({ ...event.detail })
  }
  window.addEventListener(OPEN_COMPACTIONS, listener)
  onCleanup(() => window.removeEventListener(OPEN_COMPACTIONS, listener))
  return (
    <Show when={target()} keyed>
      {(current) => (
        <Suspense>
          <CompactionsDialog
            serverKey={current.serverKey}
            sessionID={current.sessionID}
            messageID={current.messageID}
            onClose={() => setTarget(undefined)}
          />
        </Suspense>
      )}
    </Show>
  )
}

function isDetail(value: unknown): value is OpenCompactionsDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    "serverKey" in value &&
    typeof value.serverKey === "string" &&
    "sessionID" in value &&
    typeof value.sessionID === "string"
  )
}
