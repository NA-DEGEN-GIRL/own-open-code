// 변경 보기 → the review tab (03 §18.5 owner) shows `Session.revert.files`: the restore bar's window event. Apart from
// the revert actions so the shell's listener (shell/intents.tsx) keeps them out of the first chunk.
import type { FileDiffInfo } from "@opencode/client"

export const REVERT_VIEW_CHANGES = "own:revert-view-changes"

export interface RevertViewChangesDetail {
  readonly serverKey: string
  readonly sessionID: string
  readonly files: readonly FileDiffInfo[]
}

export function requestRevertChanges(detail: RevertViewChangesDetail) {
  window.dispatchEvent(new CustomEvent<RevertViewChangesDetail>(REVERT_VIEW_CHANGES, { detail }))
}
