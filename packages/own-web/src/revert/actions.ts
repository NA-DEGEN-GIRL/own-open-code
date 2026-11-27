// Revert actions (03 §18.7): stage (`POST …/revert/stage {messageID, files}`), clear (`DELETE …/revert`), commit
// (`POST …/revert/commit`), and /undo, /redo (18.13) with upstream `session/revert.ts` semantics, re-written for
// own-web. A running turn is interrupted first (core refuses a stage while the session is active). After a stage the
// queued messages are cancelled (they were written against the rewound history; toast `own.revert.queueDropped`)
// and the rewound message goes back into the composer (window event, attachments included).
//
// Sending a prompt while a revert is staged commits it (core `Session.prompt`); so does a compaction (02 §4.7.4).
import type { SessionMessageInfo } from "@opencode/client"
import type { ServerRuntime } from "@/data"
import { requestComposerRestore } from "@/attachments/intents"
import { draftFrom } from "@/attachments/model"
import { failureReason, isPending, redoTarget, staleQueue, undoTarget, userMessages } from "./model"

export interface RevertTarget {
  readonly runtime: ServerRuntime
  readonly serverKey: string
  readonly sessionID: string
}

export type RevertOutcome =
  | { readonly ok: true; readonly dropped: number }
  /** `pending`: the message still waits in the inbox (not a message yet); `nothing`: no turn for /undo, /redo. */
  | { readonly ok: false; readonly reason: "busy" | "nothing" | "pending" | string }

/** Text a stage put back per draft, so `복원 취소` clears it only while the user has not changed it. */
const restored = new Map<string, string>()
const draftKey = (target: RevertTarget) => `${target.serverKey}/${target.sessionID}`

export async function stageRevert(
  target: RevertTarget,
  input: {
    readonly messageID: string
    /** The boundary message, when the caller holds it (a transcript's own pages; else looked up in the store). */
    readonly message?: SessionMessageInfo
    readonly files: boolean
    /** The user confirmed stopping a running turn (the dialog's `중단하고 복원`); otherwise a running session is `busy`. */
    readonly interrupt?: boolean
  },
): Promise<RevertOutcome> {
  const client = target.runtime.client()
  const data = target.runtime.data
  const sessionID = target.sessionID
  if (isPending(data.session.pending.list(sessionID), input.messageID)) return { ok: false, reason: "pending" }
  try {
    if (await sessionBusy(target)) {
      if (!input.interrupt) return { ok: false, reason: "busy" }
      await client.session.interrupt({ sessionID }).catch(() => undefined)
      await client.session.wait({ sessionID }).catch(() => undefined)
    }
    // Snapshot the local queue before the stage, then sweep it together with the authoritative inbox.
    const local = [...data.session.pending.list(sessionID)]
    await client.session.revert.stage({ sessionID, messageID: input.messageID, files: input.files })
    const cutoff = Date.now()
    const authoritative = await client.session.inbox.list({ sessionID }).catch(() => [])
    const stale = staleQueue(local, authoritative, cutoff)
    await Promise.all(
      stale.map((inboxID) => client.session.inbox.cancel({ sessionID, inboxID }).catch(() => undefined)),
    )
    // By id over the list: the position index can lag behind optimistic inserts.
    const message = input.message ?? data.session.message.list(sessionID).find((item) => item.id === input.messageID)
    if (message?.type === "user") {
      const draft = draftFrom(message)
      restored.set(draftKey(target), draft.text)
      requestComposerRestore({
        serverKey: target.serverKey,
        sessionID,
        text: draft.text,
        attachments: draft.attachments,
        mode: "replace",
      })
    }
    return { ok: true, dropped: stale.length }
  } catch (error) {
    console.error("[own-web] revert stage failed", error)
    return { ok: false, reason: failureReason(error) }
  }
}

/** `복원 취소` (and /redo at the end): files come back, the rewound turns show again. */
export async function clearRevert(target: RevertTarget): Promise<RevertOutcome> {
  try {
    await target.runtime.client().session.revert.clear({ sessionID: target.sessionID })
    const text = restored.get(draftKey(target))
    restored.delete(draftKey(target))
    if (text !== undefined)
      requestComposerRestore({
        serverKey: target.serverKey,
        sessionID: target.sessionID,
        text: "",
        attachments: [],
        mode: "replace",
        ifDraft: text,
      })
    return { ok: true, dropped: 0 }
  } catch (error) {
    console.error("[own-web] revert clear failed", error)
    return { ok: false, reason: failureReason(error) }
  }
}

/** `복원 확정`: the rewound messages are deleted for good (a cold point for the cache, 01 §17.1 #8). */
export async function commitRevert(target: RevertTarget): Promise<RevertOutcome> {
  try {
    await target.runtime.client().session.revert.commit({ sessionID: target.sessionID })
    restored.delete(draftKey(target))
    return { ok: true, dropped: 0 }
  } catch (error) {
    console.error("[own-web] revert commit failed", error)
    return { ok: false, reason: failureReason(error) }
  }
}

/** The boundary `/undo` moves to: one turn back, the last turn when nothing is staged. */
export function undoBoundary(target: RevertTarget) {
  const data = target.runtime.data
  const users = userMessages(data.session.message.list(target.sessionID), data.session.pending.list(target.sessionID))
  return undoTarget(users, data.session.get(target.sessionID)?.revert?.messageID)
}

/** `/undo` — 마지막 턴 복원(파일 포함): moves the boundary one turn back (the last turn when nothing is staged). */
export function undoRevert(target: RevertTarget): Promise<RevertOutcome> {
  const messageID = undoBoundary(target)
  if (!messageID) return Promise.resolve({ ok: false, reason: "nothing" })
  return stageRevert(target, { messageID, files: true })
}

/** `/redo` — moves the boundary one turn forward; at the last turn it clears the staged revert. */
export function redoRevert(target: RevertTarget): Promise<RevertOutcome> {
  const data = target.runtime.data
  const users = userMessages(data.session.message.list(target.sessionID), data.session.pending.list(target.sessionID))
  const boundary = data.session.get(target.sessionID)?.revert?.messageID
  const step = redoTarget(users, boundary)
  if (!step) return Promise.resolve({ ok: false, reason: "nothing" })
  if (step.kind === "clear") return clearRevert(target)
  return stageRevert(target, { messageID: step.messageID, files: true })
}

/**
 * Whether the session runs a turn. The event-fed status can lag (one status per session while executions overlap, e.g.
 * a title run ending after the next turn started), so an idle answer is checked against `GET /api/session/active`.
 */
export async function sessionBusy(target: RevertTarget) {
  if (target.runtime.data.session.status(target.sessionID) === "running") return true
  const active = await target.runtime
    .client()
    .session.active()
    .catch(() => undefined)
  return active?.[target.sessionID]?.type === "running"
}
