// Opens the `이 지점으로 복원` dialog from anywhere (the transcript's user-message action, the palette) without the
// caller holding UI: a request signal plus one `<RevertHost>` mounted by the shell, which loads the dialog chunk only
// when a request arrives (03 §20.2 R5: every new dialog is lazy).
import { createRoot, createSignal, lazy, Show, Suspense } from "solid-js"

export interface RevertRequest {
  readonly serverKey: string
  readonly sessionID: string
  /** The user message that becomes the boundary: it and everything after it are rewound. */
  readonly messageID: string
}

const request = createRoot(() => {
  const [value, set] = createSignal<RevertRequest>()
  return { value, set }
})

export function openRevertDialog(next: RevertRequest) {
  request.set(next)
}

export function closeRevertDialog() {
  request.set(undefined)
}

export const revertDialogOpen = () => request.value() !== undefined

const Dialog = lazy(() => import("./dialog"))

/** Mount once (shell). Renders nothing until a revert is requested. */
export function RevertHost() {
  return (
    <Show when={request.value()} keyed>
      {(current) => (
        <Suspense>
          <Dialog request={current} onClose={closeRevertDialog} />
        </Suspense>
      )}
    </Show>
  )
}
