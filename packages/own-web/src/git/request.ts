// Requests for a repository-wide Git action from outside the review tab (03 §19.15 palette `Git: 커밋…/푸시/PR 만들기`).
// The actions and their confirmation dock live in the review tab's lazy chunk, so the request waits here until that
// tab (opened in `커밋 안 된 변경` by the caller) has read the repository status and takes it. It only opens the same
// confirmation dock as the Git bar's button: nothing runs without the user confirming the command line.
import { createRoot, createSignal } from "solid-js"
import type { ServerKey } from "@/data"

export type GitRequestAction = "commit" | "push" | "pr"

export interface GitRequest {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly action: GitRequestAction
}

const state = createRoot(() => {
  const [request, setRequest] = createSignal<GitRequest & { readonly seq: number }>()
  return { request, setRequest, seq: 0 }
})

export function requestGitAction(request: GitRequest) {
  state.setRequest({ ...request, seq: ++state.seq })
}

/** The request the review tab has not taken yet. */
export const gitRequest = state.request

/** Called by the review tab once it opened the request's dock (or found it cannot). */
export function takeGitRequest(seq: number) {
  if (state.request()?.seq === seq) state.setRequest(undefined)
}
