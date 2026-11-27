// Queue/steer panel model (03 §18.9), pure: which rows the `≡ 대기 {n}` dock shows, in delivery order, with the note
// each row carries (current account vs. after the pending switch, 02 §5.3 WAIT_SAFE), and how a reorder is carried
// out. The inbox API cannot reorder rows, so a reorder re-admits the changed suffix of the queued prompts (parked with
// `resume:false`) and cancels the originals — the algorithm of upstream `session/composer/queue.ts` `rewrite`,
// re-written for own-web.
// Team messages (06 §5.2, §9.6), shared with the transcript and the session banners: who put a message in (a main
// request of own.team carries `own.dispatch`), the request's text without its envelope, and the one-line summary of a
// team update (`own.team.update`) in the team main.
import type { JsonValue, SessionInboxInfo } from "@opencode/client"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { TEAM_META } from "@/data/team-rpc"

export type QueuedUser = Extract<SessionInboxInfo, { type: "user" }>
type Control = Extract<SessionInboxInfo, { type: "compaction" | "move" | "reset" }>
type Metadata = Readonly<Record<string, JsonValue>> | undefined

/**
 * Who put a message in (06 §9.6): the team main or the program (own.team main requests, 5.1), another area (an area
 * message, 5.8), else the user.
 */
export type MessageSource = "main" | "team" | "area" | "user"

/** Who sent an area message (06 §5.8): the sender's area, its peer when a peer sent it, and whether it is a reply. */
export interface MessageSender {
  readonly area: string
  readonly label?: string
  readonly reply: boolean
}

export type RowNote =
  /** Steer while a switch waits: runs inside this turn on the current account (03 §4.6 steerNote). */
  | { readonly kind: "steerNow"; readonly account: string }
  | { readonly kind: "steerTurn" }
  /** Queue while a switch waits: runs after the switch (03 §18.9). */
  | { readonly kind: "afterSwitch"; readonly account: string }
  | { readonly kind: "afterTurn" }
  /** Queued while idle (re-admitted with `resume:false`): nothing runs until someone sends it. */
  | { readonly kind: "parked" }

export type QueueRow =
  | {
      readonly kind: "user"
      readonly id: string
      readonly delivery: "steer" | "queue"
      /** A main request shows `메인이 보냄` (or `팀이 보냄`) and its text without the envelope (06 §5.2). */
      readonly source: MessageSource
      /** An area message's sender (5.8). */
      readonly sender?: MessageSender
      readonly text: string
      readonly attachments: number
      readonly note: RowNote
    }
  | {
      readonly kind: "control"
      readonly id: string
      readonly type: Control["type"]
      readonly delivery: "steer" | "queue"
    }
  /** Held by this window during a compact-then-switch (03 §6.5), sent after `switch.recorded`. */
  | { readonly kind: "held"; readonly index: number; readonly text: string }

export interface RowsInput {
  readonly pending: readonly SessionInboxInfo[]
  readonly held: readonly string[]
  readonly busy: boolean
  /** Label of the account the session runs on now. */
  readonly current: string
  /** Label of the WAIT_SAFE/COMPACTING target, when a switch waits for the turn to end. */
  readonly pendingTarget?: string
}

/**
 * Rows in delivery order: steers first (at the next safe step boundary; a steered compaction before other steers),
 * then queued items one per turn in enqueue order, then messages held on the client. Synthetic items are internal
 * (subagent results, system notices) and not shown.
 */
export function queueRows(input: RowsInput): QueueRow[] {
  const visible = input.pending.filter((item) => item.type !== "synthetic")
  const byGroup = (delivery: "steer" | "queue") => {
    const group = visible.filter((item) => item.delivery === delivery)
    if (delivery === "queue") return group
    return [
      ...group.filter((item) => item.type === "compaction"),
      ...group.filter((item) => item.type !== "compaction"),
    ]
  }
  const rows = [...byGroup("steer"), ...byGroup("queue")].map((item): QueueRow => {
    if (item.type !== "user")
      return { kind: "control", id: item.id, type: item.type as Control["type"], delivery: item.delivery }
    const source = messageSource(item.payload.metadata)
    const sender = source === "area" ? messageSender(item.payload.metadata) : undefined
    return {
      kind: "user",
      id: item.id,
      delivery: item.delivery,
      source,
      ...(sender === undefined ? {} : { sender }),
      text: source === "user" ? displayText(item) : OwnTeamText.unwrap(item.payload.text),
      attachments: attachmentCount(item),
      note: noteFor(item.delivery, input),
    }
  })
  return [...rows, ...input.held.map((text, index): QueueRow => ({ kind: "held", index, text }))]
}

function noteFor(delivery: "steer" | "queue", input: RowsInput): RowNote {
  if (delivery === "steer")
    return input.pendingTarget ? { kind: "steerNow", account: input.current } : { kind: "steerTurn" }
  if (input.pendingTarget) return { kind: "afterSwitch", account: input.pendingTarget }
  return input.busy ? { kind: "afterTurn" } : { kind: "parked" }
}

/** The text the user typed (`metadata.displayText`), as upstream `queuedPromptText`. */
export function displayText(item: QueuedUser) {
  const display = item.payload.metadata?.["displayText"]
  return typeof display === "string" && display.length > 0 ? display : item.payload.text
}

function attachmentCount(item: QueuedUser) {
  const references = item.payload.metadata?.["attachments"]
  return (
    (item.payload.files?.filter((file) => !file.mention).length ?? 0) +
    (Array.isArray(references) ? references.length : 0)
  )
}

/** First line, trimmed to 120 characters, for the one-line row. */
export function firstLine(text: string) {
  const line = text.split("\n", 1)[0] ?? ""
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

// ---------------------------------------------------------------------------------------------------------------
// Team messages (06 §5.1, §5.6, §9.6)

/** Of a queued item or a delivered message; anything without `own.dispatch` is the user's (5.4). */
export function messageSource(metadata: Metadata): MessageSource {
  const dispatch = metadata?.[TEAM_META.dispatch]
  if (typeof dispatch !== "object" || dispatch === null || Array.isArray(dispatch)) return "user"
  if (dispatch.from === "area") return "area"
  return dispatch.from === "team" ? "team" : "main"
}

/** The sender of an area message (`own.dispatch.sender`, 06 §5.8), or `undefined` for anything else. */
export function messageSender(metadata: Metadata): MessageSender | undefined {
  const dispatch = metadata?.[TEAM_META.dispatch]
  if (typeof dispatch !== "object" || dispatch === null || Array.isArray(dispatch)) return undefined
  const sender = dispatch.sender
  if (typeof sender !== "object" || sender === null || Array.isArray(sender) || typeof sender.area !== "string")
    return undefined
  const peer = sender.peer
  const label =
    typeof peer === "object" && peer !== null && !Array.isArray(peer) && typeof peer.label === "string"
      ? peer.label
      : undefined
  return { area: sender.area, ...(label === undefined ? {} : { label }), reply: dispatch.kind === "reply" }
}

/** A team update's metadata (`own.team.update {seq, reasons}`, 5.6): why the main was woken. */
export function teamUpdateOf(metadata: Metadata): { readonly reasons: readonly string[] } | undefined {
  const update = metadata?.[TEAM_META.update]
  if (typeof update !== "object" || update === null || Array.isArray(update)) return undefined
  const reasons = update.reasons
  return { reasons: Array.isArray(reasons) ? reasons.filter((reason) => typeof reason === "string") : [] }
}

/**
 * Areas by status in a team update, for its one-line summary (`팀 소식 · 반영 준비 1, 진행 중 1`, 9.6): its area lines
 * start with the status word own-team writes (`- 인벤토리 화면: 반영 준비됨 · 담당: …`), both from
 * `@own/protocol/rpc-team-text`. Integrations applied or undone and decision records follow the area groups. Idle areas
 * count as done only in the update that says everything is done (`all-done`).
 */
export function teamUpdateCounts(text: string, reasons: readonly string[]) {
  const kinds = text.split("\n").flatMap((line) => (line.startsWith("- ") ? [OwnTeamText.countOf(line)] : []))
  return [...OwnTeamText.COUNTS, ...OwnTeamText.EVENT_COUNTS].flatMap((kind) => {
    if (kind === "done" && !reasons.includes("all-done")) return []
    const n = kinds.filter((item) => item === kind).length
    return n > 0 ? [{ kind, n }] : []
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Reordering (queued user prompts only, 03 §18.9 "대기열끼리만")

export type ReorderPlan =
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly reason: "control" | "changed" }
  /** Re-admit `readmit` in this order (parked), then cancel `cancel`. */
  | { readonly kind: "rewrite"; readonly readmit: readonly QueuedUser[]; readonly cancel: readonly string[] }

/**
 * `pending` is the authoritative inbox (fetched right before), `order` the queued prompt ids in the wanted order.
 * Only the suffix from the first changed position is rewritten, so items before it keep their ids.
 */
export function reorderPlan(pending: readonly SessionInboxInfo[], order: readonly string[]): ReorderPlan {
  if (pending.some((item) => item.delivery === "queue" && item.type !== "user" && item.type !== "synthetic"))
    return { kind: "blocked", reason: "control" }
  const current = pending.filter((item): item is QueuedUser => item.type === "user" && item.delivery === "queue")
  const ordered = order.flatMap((id) => current.filter((item) => item.id === id))
  if (ordered.length !== current.length || new Set(order).size !== order.length)
    return { kind: "blocked", reason: "changed" }
  const changed = ordered.findIndex((item, index) => item.id !== current[index]?.id)
  if (changed < 0) return { kind: "none" }
  return {
    kind: "rewrite",
    readmit: ordered.slice(changed),
    cancel: current.slice(changed).map((item) => item.id),
  }
}

/** Moves one id by `delta` positions (keyboard reorder); unchanged at the ends. */
export function moveBy(ids: readonly string[], id: string, delta: number) {
  const from = ids.indexOf(id)
  const to = Math.max(0, Math.min(ids.length - 1, from + delta))
  if (from < 0 || to === from) return [...ids]
  return moveTo(ids, from, to)
}

export function moveTo<T>(items: readonly T[], from: number, to: number) {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

/**
 * Drop position while dragging: `centers` are the rows' vertical centers measured when the drag started, `from` the
 * dragged row, `center` its current center. The row lands after every row whose center it passed.
 */
export function dropIndex(centers: readonly number[], from: number, center: number) {
  let to = from
  for (let index = from + 1; index < centers.length; index++) if (center > centers[index]!) to = index
  for (let index = from - 1; index >= 0; index--) if (center < centers[index]!) to = index
  return to
}
