// Revert module entry (03 §18.7, gap 7): `이 지점으로 복원` (dialog, lazy), the 복원 대기 띠 (lazy, only while a revert is
// staged), commit/clear, /undo and /redo (18.13), the queue sweep and the composer restore. Label rule: the verb is
// `복원`; `되돌리기` stays with `switch.undo` (6.2).
//
// Wiring (integrator, see the report):
//   - shell: mount `<RevertHost />` once; place `<RevertBarSlot serverKey sessionID />` between the transcript and the
//     composer (03 §4.5 "대화 맨 아래").
//   - transcript: `createSessionTimelineRowRenderer({ …, actions: { revert: revertAction(serverKey) } })`, and in
//     src/adapter/ui-i18n.ts map `ui.message.revertMessage` to `own.revert.action` (ko "이 지점으로 복원") — session-ui's
//     default Korean label says "되돌리기", which 18.7 reserves for switch.undo.
//   - composer: listen to `own:composer-restore` (`onComposerRestore`, `restoredText`) and put the text back.
//   - slash commands (18.13): `/undo` → `commands.undo(...)`, `/redo` → `commands.redo(...)` from `useRevertCommands()`,
//     description `own.revertOps.undo` (마지막 턴 복원(파일 포함)).
//   - review tab (18.5): on `own:revert-view-changes` show `Session.revert.files` (detail carries them).
import { createMemo, lazy, Show, Suspense } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { showToast } from "@/switcher/toast"
import type { RevertOutcome } from "./actions"
import { openRevertDialog } from "./host"
import { useRevertText } from "./strings"

// The actions (stage, commit, clear, /undo, /redo) load with the first /undo or /redo, the dialog or the bar.
export { closeRevertDialog, openRevertDialog, RevertHost, revertDialogOpen, type RevertRequest } from "./host"
export { REVERT_VIEW_CHANGES, type RevertViewChangesDetail } from "./events"

const Bar = lazy(() => import("./bar"))

/** The bar's slot: nothing (and no chunk) until the session has a staged revert. */
export function RevertBarSlot(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const runtime = () => data.get(props.serverKey())
  const staged = createMemo(() => {
    const id = props.sessionID()
    return id ? !!runtime()?.data.session.get(id)?.revert : false
  })
  return (
    <Show when={staged() && runtime()}>
      {(current) => (
        <Suspense>
          <Bar runtime={current()} serverKey={props.serverKey()} sessionID={props.sessionID()!} />
        </Suspense>
      )}
    </Show>
  )
}

/** session-ui `actions.revert` for user messages: opens the `이 지점으로 복원` dialog. */
export function revertAction(serverKey: () => ServerKey) {
  return (input: { readonly sessionID: string; readonly messageID: string }) =>
    openRevertDialog({ serverKey: serverKey(), sessionID: input.sessionID, messageID: input.messageID })
}

/** `/undo` and `/redo` (18.13) with the same toasts as the dialog and the bar. */
export function useRevertCommands() {
  const data = useData()
  const i18n = useI18n()
  const text = useRevertText()
  const report = (outcome: RevertOutcome, nothing: "own.revertOps.nothingToUndo" | "own.revertOps.nothingToRedo") => {
    if (outcome.ok) {
      if (outcome.dropped > 0) showToast({ message: i18n.t("own.revert.queueDropped", { n: outcome.dropped }) })
      return true
    }
    if (outcome.reason === "nothing") showToast({ message: text(nothing) })
    else if (outcome.reason === "busy") showToast({ tone: "danger", message: text("own.revertOps.busy") })
    else showToast({ tone: "danger", message: text("own.revertOps.failed", { reason: outcome.reason }) })
    return false
  }
  const target = (serverKey: ServerKey, sessionID: string) => {
    const runtime = data.get(serverKey)
    return runtime ? { runtime, serverKey, sessionID } : undefined
  }
  /**
   * On a running session the turn is stopped only after the user confirms (18.7): the dialog opens on the /undo
   * boundary with `중단하고 복원`. Otherwise the boundary moves at once (it can be taken back with /redo). Right after a
   * context reset (18.18) a revert of the last turn would delete the reset's marker too, so the user picks which.
   */
  const undo = async (serverKey: ServerKey, sessionID: string, turn?: boolean): Promise<boolean> => {
    const resolved = target(serverKey, sessionID)
    if (!resolved) return false
    const last = resolved.runtime.data.session.message
      .list(sessionID)
      .findLast((message) => message.type === "user" || message.type === "compaction")
    if (!turn && last?.type === "compaction" && last.status === "completed" && last.reason === "reset") {
      const reset = await import("@/context-reset")
      const deps = { runtime: resolved.runtime, sessionID, locale: i18n.locale(), toast: showToast }
      if (reset.justReset(resolved.runtime.data.session.message.list(sessionID))) {
        reset.chooseUndo({
          locale: i18n.locale(),
          undoReset: () => void reset.undoReset({ ...deps, resetID: last.id }),
          restoreTurn: () => void undo(serverKey, sessionID, true),
        })
        return true
      }
    }
    const { undoBoundary, undoRevert } = await import("./actions")
    const outcome = await undoRevert(resolved)
    const messageID = !outcome.ok && outcome.reason === "busy" ? undoBoundary(resolved) : undefined
    if (!messageID) return report(outcome, "own.revertOps.nothingToUndo")
    openRevertDialog({ serverKey, sessionID, messageID })
    return true
  }
  return {
    /** Slash-command description (03 §18.13: `마지막 턴 복원(파일 포함)`). */
    undoLabel: () => text("own.revertOps.undo"),
    redoLabel: () => i18n.t("own.revert.clear"),
    undo: (serverKey: ServerKey, sessionID: string) => undo(serverKey, sessionID),
    async redo(serverKey: ServerKey, sessionID: string) {
      const resolved = target(serverKey, sessionID)
      if (!resolved) return false
      const { redoRevert } = await import("./actions")
      return report(await redoRevert(resolved), "own.revertOps.nothingToRedo")
    },
  }
}
