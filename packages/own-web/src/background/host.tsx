// Opens the output view (터미널처럼, 03 §19.7) from anywhere — the dock list, the finish toast's `출력 보기` — without
// the caller holding UI: a request signal plus one `<BackgroundHost>` mounted by the shell, which loads the viewer chunk
// only when a request arrives (03 §20.2 R5).
import { createRoot, createSignal, lazy, Show, Suspense } from "solid-js"
import type { ServerKey } from "@/data"

export interface OutputRequest {
  readonly serverKey: ServerKey
  readonly shellID: string
  readonly label: string
  /** The session the shell belongs to (location fallback, `열기`). */
  readonly sessionID?: string
  /** The shell's own location when known (a shell stays where it started, even after `session.move`). */
  readonly directory?: string
}

const request = createRoot(() => {
  const [value, set] = createSignal<OutputRequest>()
  return { value, set }
})

export function openShellOutput(next: OutputRequest) {
  request.set(next)
}

export function closeShellOutput() {
  request.set(undefined)
}

export const shellOutputOpen = () => request.value() !== undefined

const Output = lazy(() => import("./output"))

export function OutputHost() {
  return (
    <Show when={request.value()} keyed>
      {(current) => (
        <Suspense>
          <Output request={current} onClose={closeShellOutput} />
        </Suspense>
      )}
    </Show>
  )
}
