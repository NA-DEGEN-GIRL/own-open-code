// Opens the fork dialog from anywhere (the header `⋯`, a transcript message's `여기서 포크`, the palette) without the
// caller holding UI: a request signal plus one `<ForkHost>` mounted by the shell, which loads the dialog chunk only
// when a request arrives (03 §20.2 R5: every new dialog is lazy).
import { createRoot, createSignal, lazy, Show, Suspense } from "solid-js"
import type { ServerKey } from "@/data"

export interface ForkRequest {
  readonly serverKey: string
  readonly sessionID: string
  /** Preselects the user message the fork starts before (a message's `여기서 포크`). */
  readonly messageID?: string
}

const request = createRoot(() => {
  const [value, set] = createSignal<ForkRequest>()
  return { value, set }
})

export function openForkDialog(next: ForkRequest) {
  request.set(next)
}

export function closeForkDialog() {
  request.set(undefined)
}

export const forkDialogOpen = () => request.value() !== undefined

const Dialog = lazy(() => import("./dialog"))

/** Mount once (shell). Renders nothing until a fork is requested. */
export function ForkHost() {
  return (
    <Show when={request.value()} keyed>
      {(current) => (
        <Suspense>
          <Dialog request={current} onClose={closeForkDialog} />
        </Suspense>
      )}
    </Show>
  )
}

/** A user message's `여기서 포크` (same shape as the revert module's `revertAction`). */
export function forkAction(serverKey: () => ServerKey) {
  return (input: { readonly sessionID: string; readonly messageID: string }) =>
    openForkDialog({ serverKey: serverKey(), sessionID: input.sessionID, messageID: input.messageID })
}
