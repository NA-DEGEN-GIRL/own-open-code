// Queue/steer module entry (03 §18.9, gap 9). Replaces the composer's first `QueueDock`: the same inbox data plus
// reorder (queued prompts only), `지금 보내기`, control items and the WAIT_SAFE notes (02 §5.3: which rows run on the
// current account and which after the pending switch). The default follow-up behavior stays the composer's
// `followUp` (03 §4.6: `끼워 넣기`, upstream default); the panel header shows it.
//
// Wiring (integrator): in the composer, `const queue = createQueue({runtime, serverKey, sessionID, held, onProblem})`,
// render `<QueuePanel queue={queue} onHeldCancel={…} />` (lazy, from `./panel`) where `<QueueDock>` is today, and let the
// `composer.queueEditFirst` shortcut (Ctrl+↑) call `queue.editFirst()` (returns false when there is nothing to edit).
import { useI18n } from "@/i18n"
import { showToast } from "@/switcher/toast"
import type { QueueProblem } from "./controller"
import { useQueueText } from "./strings"

export { createQueue, type Queue, type QueueInput, type QueueProblem } from "./controller"
export { queueRows, reorderPlan, type QueueRow, type RowNote } from "./model"
// The panel itself is a lazy chunk the composer loads once a row is queued (PF5): import it from "./panel".
export type { QueuePanelProps } from "./panel"
export { CONTINUE_PROMPT, continueTurn } from "./continue-action"
export { pendingSteerActions } from "./steer-actions"

/** Toasts for queue problems (03 §9). */
export function useQueueProblems() {
  const i18n = useI18n()
  const text = useQueueText()
  return (problem: QueueProblem) => {
    if (problem === "failed") return showToast({ message: i18n.t("own.composer.queueEditFailed"), tone: "danger" })
    showToast({
      message: text(
        problem === "changed"
          ? "own.queuePanel.changed"
          : problem === "reorderBlocked"
            ? "own.queuePanel.reorderBlocked"
            : "own.queuePanel.revertBlocked",
      ),
    })
  }
}
