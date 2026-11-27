// Opens the worktree dialogs from anywhere (session `⋯`, header, palette, sidebar group `⋯`, the selector's `정리…`)
// without the caller holding UI: request signals plus one `<WorktreeHost>` mounted by the shell, which loads each
// dialog chunk only when it is requested (03 §20.2 R5).
import { createRoot, createSignal, lazy, Show, Suspense } from "solid-js"
import type { ServerKey } from "@/data"

export interface MoveRequest {
  readonly serverKey: ServerKey
  readonly sessionID: string
}

export interface RemoveRequest {
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly directory: string
}

const requests = createRoot(() => {
  const [move, setMove] = createSignal<MoveRequest>()
  const [remove, setRemove] = createSignal<RemoveRequest>()
  return { move, setMove, remove, setRemove }
})

/** `다른 워크트리로 옮기기…` (03 §19.3). */
export function openWorktreeMove(request: MoveRequest) {
  requests.setMove(request)
}

/** `정리…`: the cleanup confirmation of one worktree (03 §19.3 "정리(삭제)는 확인 대화상자"). */
export function openWorktreeRemove(request: RemoveRequest) {
  requests.setRemove(request)
}

export const worktreeDialogOpen = () => requests.move() !== undefined || requests.remove() !== undefined

const MoveDialog = lazy(() => import("./move"))
const RemoveDialog = lazy(() => import("./remove"))

/** Mount once (shell). Renders nothing until a dialog is requested. */
export function WorktreeHost() {
  return (
    <>
      <Show when={requests.move()} keyed>
        {(request) => (
          <Suspense>
            <MoveDialog request={request} onClose={() => requests.setMove(undefined)} />
          </Suspense>
        )}
      </Show>
      <Show when={requests.remove()} keyed>
        {(request) => (
          <Suspense>
            <RemoveDialog request={request} onClose={() => requests.setRemove(undefined)} />
          </Suspense>
        )}
      </Show>
    </>
  )
}
