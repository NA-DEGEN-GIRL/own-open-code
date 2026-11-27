// Fork and manual compaction decisions (03 §19.12, 02 §5.9(e), 01 §17.1 #27), pure so they are unit-tested as tables.
import type { SessionInboxInfo, SessionMessageInfo } from "@opencode/client"
import { draftFrom } from "@/attachments/model"

export interface ForkableMessage {
  readonly id: string
  /** One line: what the user typed (without attachment reference lines). */
  readonly preview: string
  readonly created: number
  /** Still in the inbox (not a message on the server yet): `before` would not find it. */
  readonly pending: boolean
  /** Attachments the message carried (they come back into the forked session's composer). */
  readonly attachments: number
}

const PREVIEW = 200

/**
 * User messages a fork can start before, newest first (upstream `session/commands/fork-dialog.tsx`): `fork{before:id}`
 * copies the history before that message, and the message itself goes into the new session's composer.
 */
export function forkableMessages(
  messages: readonly SessionMessageInfo[],
  pending: readonly SessionInboxInfo[] = [],
): ForkableMessage[] {
  const waiting = new Set(pending.map((item) => item.id))
  return messages
    .flatMap((message) => {
      if (message.type !== "user") return []
      const draft = draftFrom(message)
      const preview = draft.text.replace(/\s+/g, " ").trim().slice(0, PREVIEW)
      if (!preview && !draft.attachments.length) return []
      return [
        {
          id: message.id,
          preview,
          created: message.time.created,
          pending: waiting.has(message.id),
          attachments: draft.attachments.length,
        },
      ]
    })
    .toReversed()
}

/** Case-insensitive search over the previews; an empty query keeps everything. */
export function filterMessages(messages: readonly ForkableMessage[], query: string) {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return [...messages]
  return messages.filter((message) => message.preview.toLowerCase().includes(wanted))
}

/** Pin and archive flags of 19.11 (own metadata namespace), flat keys and the nested `own` object. */
const FLAGS = ["pinned", "archived"] as const

/**
 * 01 §17.1 #27: forks (and children) inherit the parent's metadata, so a fork of a pinned or archived session would be
 * pinned or archived too. Returns the metadata without those flags, or `undefined` when there is nothing to clear.
 */
export function clearForkFlags(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const flat = FLAGS.map((flag) => `own.${flag}`).filter((key) => key in metadata)
  const own = metadata["own"]
  const nested =
    typeof own === "object" && own !== null && !Array.isArray(own)
      ? FLAGS.filter((flag) => flag in (own as Record<string, unknown>))
      : []
  if (!flat.length && !nested.length) return undefined
  const next: Record<string, unknown> = { ...metadata }
  flat.forEach((key) => delete next[key])
  if (nested.length) {
    const inner: Record<string, unknown> = { ...(own as Record<string, unknown>) }
    nested.forEach((flag) => delete inner[flag])
    next["own"] = inner
  }
  return next
}

export type CompactionPhase = "idle" | "requesting" | "queued" | "running" | "failed"

export interface CompactionFacts {
  /** A manual request is in flight (POST /compact). */
  readonly requesting: boolean
  /** A compaction item waits in the inbox (runs at the next step boundary, 02 §4.7). */
  readonly queued: boolean
  /** `session.compaction.started` without `ended`/`failed` yet, or the newest message is a running compaction. */
  readonly running: boolean
  /** A failure seen in this page and not dismissed. */
  readonly failed: boolean
}

/** What the composer shows: running wins over queued (the item leaves the inbox when it starts). */
export function compactionPhase(facts: CompactionFacts): CompactionPhase {
  if (facts.running) return "running"
  if (facts.requesting) return "requesting"
  if (facts.queued) return "queued"
  if (facts.failed) return "failed"
  return "idle"
}

/** A readable reason from a server or request error (never the whole object). */
export function errorText(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    const data = record["data"]
    if (typeof data === "object" && data !== null && typeof (data as Record<string, unknown>)["message"] === "string")
      return (data as Record<string, string>)["message"]!
    if (typeof record["message"] === "string" && record["message"]) return record["message"] as string
  }
  return typeof error === "string" ? error : undefined
}
