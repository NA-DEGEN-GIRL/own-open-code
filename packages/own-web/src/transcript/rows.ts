// Transcript rows: session-ui's projection rows plus one own row per finished turn, the turn footer (03 §4.5).
// Switch and compaction markers are session-ui `Notice` rows (`model-switched`, `compaction` messages) drawn by own
// components, so they need no extra rows; a compaction the server admitted but has not started is session-ui's
// `CompactionQueued` row (upstream 2db9c2e1b3). Row objects keep their identity while unchanged, so the virtualizer
// and the keyed row components never re-create a row that did not change (03 §20.2 R1).
import type { SessionInboxInfo, SessionMessageInfo } from "@opencode/client/promise"
import type { TimelineRow } from "@/adapter/session-ui"

export interface FooterRow {
  readonly _tag: "OwnTurnFooter"
  readonly userMessageID: string
}

export type TranscriptRow = TimelineRow.TimelineRow | FooterRow

export function isFooter(row: TranscriptRow): row is FooterRow {
  return row._tag === "OwnTurnFooter"
}

/**
 * Inserts a footer after the last content row of every turn `withFooter` accepts: notices that trail the turn (a
 * switch or compaction made after the answer) and queued compactions stay below the footer, since they happen after
 * the turn. `footers` caches footer objects by turn. Returns `previous` when nothing moved.
 */
export function withFooters(
  rows: readonly TimelineRow.TimelineRow[],
  withFooter: (turnID: string) => boolean,
  footers: Map<string, FooterRow>,
  previous?: readonly TranscriptRow[],
): TranscriptRow[] {
  const target = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row._tag !== "Notice" && row._tag !== "TurnGap" && row._tag !== "CompactionQueued")
      target.set(row.userMessageID, index)
  })
  const next = rows.flatMap<TranscriptRow>((row, index) => {
    const turn = row.userMessageID
    if (target.get(turn) !== index || !withFooter(turn)) return [row]
    const footer = footers.get(turn) ?? { _tag: "OwnTurnFooter", userMessageID: turn }
    footers.set(turn, footer)
    return [row, footer]
  })
  // Turns that left the rows (a long transcript's window moved on) let their footer go.
  footers.forEach((_, turn) => target.has(turn) || footers.delete(turn))
  if (previous && previous.length === next.length && previous.every((row, index) => row === next[index]))
    return previous as TranscriptRow[]
  return next
}

/**
 * The messages the projection draws (upstream `visibleTimelineMessages` without the revert filter: 03 §18.7 dims the
 * rows after a staged revert instead of hiding them). Queued prompts wait in the composer dock (18.9); pending inputs
 * ({@link pendingInputIDs}) move to the end until delivered, since they do not own assistant work yet, in admission
 * order.
 */
export function visibleMessages(messages: SessionMessageInfo[], pending: readonly SessionInboxInfo[]) {
  const queued = new Set(
    pending.flatMap((item) => (item.type === "user" && item.delivery === "queue" ? [item.id] : [])),
  )
  const inputs = pendingInputIDs(pending)
  if (queued.size === 0 && inputs.size === 0) return messages
  const visible = messages.filter((message) => !queued.has(message.id))
  if (inputs.size === 0) return visible
  return [
    ...visible.filter((message) => !inputs.has(message.id)),
    ...visible.filter((message) => inputs.has(message.id)),
  ]
}

/**
 * Undelivered inputs the timeline keeps below the active work (upstream `pendingInputIDs`, 2db9c2e1b3): user steers and
 * synthetic items, whose notice rows session-ui draws at the end of the active turn (a team update stays hidden until
 * delivery gives it a description, `withTeamNotice`).
 */
export function pendingInputIDs(pending: readonly SessionInboxInfo[]): ReadonlySet<string> {
  return new Set(
    pending.flatMap((item) =>
      (item.type === "user" && item.delivery === "steer") || item.type === "synthetic" ? [item.id] : [],
    ),
  )
}

/**
 * Compactions the server admitted and has not started (upstream `queuedCompactionIDs`, 2db9c2e1b3), in admission
 * order: session-ui draws each as a `문맥 압축 대기 중` divider below the active work until it starts.
 */
export function queuedCompactionIDs(pending: readonly SessionInboxInfo[]): string[] {
  return pending.flatMap((item) => (item.type === "compaction" ? [item.id] : []))
}

/** Row indexes by turn, recomputed for the row list with footers (the projection's indexes exclude them). */
export function rowIndexes(rows: readonly TranscriptRow[]) {
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  rows.forEach((row, index) => {
    if (!first.has(row.userMessageID)) first.set(row.userMessageID, index)
    last.set(row.userMessageID, index)
  })
  return { first, last }
}
