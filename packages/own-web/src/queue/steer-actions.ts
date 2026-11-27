// A steer the server has not delivered yet, drawn at the end of the transcript (03 §18.9; upstream 2db9c2e1b3
// `SessionUserActions.pending`, the TUI's behavior): its message row says `끼워 넣기 대기` and offers `대기열로 옮기기`
// (`PATCH …/inbox/:id {delivery:"queue"}`) and `대기 메시지 취소` (`DELETE …/inbox/:id`) without opening the dock.
// The transcript only draws; the inbox writes live here with the rest of the queue's (transcript.test.ts UI-only rule).
import type { ServerRuntime } from "@/data"
import type { QueueProblem } from "./controller"

export function pendingSteerActions(
  runtime: Pick<ServerRuntime, "data" | "client">,
  sessionID: string,
  onProblem: (problem: QueueProblem) => void,
) {
  const failed = () => onProblem("failed")
  return {
    /** Where the message stands in this session's inbox (session-ui shows steers that wait or were stranded). */
    status: (messageID: string) => runtime.data.session.pending.status(sessionID, messageID),
    queue: (input: { readonly sessionID: string; readonly messageID: string }) =>
      runtime
        .client()
        .session.inbox.update({ sessionID: input.sessionID, inboxID: input.messageID, delivery: "queue" })
        .then(() => undefined, failed),
    remove: (input: { readonly sessionID: string; readonly messageID: string }) =>
      runtime
        .client()
        .session.inbox.cancel({ sessionID: input.sessionID, inboxID: input.messageID })
        .then(() => undefined, failed),
  }
}
