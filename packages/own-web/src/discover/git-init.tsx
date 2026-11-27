// `Git 저장소로 만들기…` (03 §4.3.1, 06 §3.0) from anywhere (the dimmed `[팀]` and `⑂` buttons, the project and session
// `⋯`, the palette, the first-run hints, team mode's "no first save point yet" notice) without the caller holding UI:
// a request signal and one `<GitInitHost>` mounted by the shell, which loads the dialog chunk only when it is asked for.
import { createRoot, createSignal, lazy, Show, Suspense } from "solid-js"
import type { ServerKey } from "@/data"

export interface GitInitRequest {
  readonly serverKey: ServerKey
  /** The project row's folder (its canonical root). */
  readonly directory: string
  readonly projectID?: string
  /** The conversation whose `⋯` asked: `팀 모드 켜기…` afterwards starts from it, as that menu's own entry does. */
  readonly sessionID?: string
}

const request = createRoot(() => {
  const [value, setValue] = createSignal<GitInitRequest>()
  return { value, setValue }
})

export function openGitInit(value: GitInitRequest) {
  request.setValue(value)
}

const GitInitDialog = lazy(() => import("./git-init-dialog"))

/** Mount once (shell). Renders nothing until the dialog is asked for. */
export function GitInitHost() {
  return (
    <Show when={request.value()} keyed>
      {(value) => (
        <Suspense>
          <GitInitDialog request={value} onClose={() => request.setValue(undefined)} />
        </Suspense>
      )}
    </Show>
  )
}
