// 압축 내용 (03 §4.5 "압축 내용 보기", UC 2026-10-18): what the model reads instead of the older messages, one entry per
// compaction of the conversation in order. Pure over the stored `compaction` messages (`message.list{type:
// "compaction"}`) and the messages the transcript has loaded (for the context sizes around each one). Nothing here is
// stored or sent: a summary compaction keeps its summary, the recent messages kept as they were and (own's harness
// checkpoint) the user's own earlier messages; a provider-native one keeps only the provider's encrypted items, so
// only what is known about it is shown (provider, model, size). Since upstream v2.1 a summary stores no copy of the
// kept messages, only where they start (`metadata.keepID`): their text is there only for checkpoints written before.
import type { JsonValue, SessionMessageInfo } from "@opencode/client/promise"
import { CompactionCache } from "@own/protocol/compaction-cache"
import { compactionSizes, markerIndex } from "@/transcript/markers"

export type CompactionMessage = Extract<SessionMessageInfo, { type: "compaction" }>

/** The metadata key own's harness checkpoint keeps the user's earlier messages under (own-harness codex/compaction.ts). */
export const USER_MESSAGES_KEY = "own.harness.codex.userMessages"

export type CompactionContent =
  | {
      readonly kind: "summary"
      readonly summary: string
      /** The newest messages kept word for word after the summary (core's `<recent-context>`), when stored. */
      readonly recent: string
      /** How many of the loaded messages are kept from `metadata.keepID` on (upstream v2.1), when no text is stored. */
      readonly kept?: number
      /** own's checkpoint: the user's earlier messages, put back with the summary. */
      readonly userMessages: ReadonlyArray<string>
    }
  | {
      readonly kind: "native"
      /** The model that made it, the only one that can replay it (`model`). */
      readonly providerID: string
      readonly modelID: string
      /** Encrypted items and their total length in characters (what the provider hands back, nothing readable). */
      readonly items: number
      readonly size: number
    }
  | { readonly kind: "running"; readonly summary: string }
  /** A context reset (core P-035, 11 §7): no summary; `undone` once it was undone. */
  | { readonly kind: "reset"; readonly undone?: number }
  | { readonly kind: "failed"; readonly error: string }

export interface CompactionEntry {
  readonly id: string
  /** When the compaction started (`time.created`; core keeps no end time for it). */
  readonly at: number
  readonly reason: "auto" | "manual" | "reset"
  /** The newest completed one (an undone reset is none): what the model reads now in place of the older messages. */
  readonly current: boolean
  readonly content: CompactionContent
  /** The conversation's model when it ran (`model`), and who actually wrote it when that failed (own's fallback). */
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly fallback?: { readonly model?: string; readonly reason: string }
  /** The compaction request's own usage: its input (cache included) and output. */
  readonly usage?: { readonly input: number; readonly output: number }
  /** The cached share of that input (0–1). */
  readonly cached?: number
  /**
   * The request the summary came from (core P-034, own-accounts' verdict, CC 2026-10-24): the whole conversation
   * (reading the session's cache) or the part before the kept messages, and why; `idle` when own compacted while the
   * user was away. Absent before P-034.
   */
  readonly request?: CompactionCache.Sent
  readonly cost?: number
  /** The context before and after, from the loaded steps around it (`compactionSizes`). */
  readonly before?: number
  readonly after?: number
}

/** The compactions in conversation order, the newest completed one marked `current`. */
export function compactionEntries(
  compactions: ReadonlyArray<CompactionMessage>,
  loaded: ReadonlyArray<SessionMessageInfo>,
): CompactionEntry[] {
  const index = markerIndex(loaded)
  const byID = new Map(loaded.map((message) => [message.id, message]))
  const ordered = compactions.toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  const current = ordered.findLast(
    (message) => message.status === "completed" && !(message.reason === "reset" && message.undone !== undefined),
  )?.id
  return ordered.map((message) => {
    const sizes = compactionSizes(index.compactions.get(message.id), (id) => byID.get(id))
    const tokens = message.status === "running" ? undefined : message.tokens
    const cost = message.status === "running" ? undefined : message.cost
    const fallback = fallbackOf(message.metadata)
    const request = CompactionCache.sentOf(message.metadata)
    const input = tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0
    return {
      id: message.id,
      at: message.time.created,
      reason: message.reason,
      current: message.id === current,
      content: contentOf(message, loaded),
      ...(message.status === "completed" && message.model
        ? { model: { providerID: message.model.providerID, id: message.model.id } }
        : {}),
      ...(fallback ? { fallback } : {}),
      ...(tokens
        ? {
            usage: {
              input: tokens.input + tokens.cache.read + tokens.cache.write,
              output: tokens.output + tokens.reasoning,
            },
          }
        : {}),
      ...(tokens && input > 0 ? { cached: tokens.cache.read / input } : {}),
      ...(request ? { request } : {}),
      ...(cost === undefined ? {} : { cost }),
      ...(sizes.before === undefined ? {} : { before: sizes.before }),
      ...(sizes.after === undefined ? {} : { after: sizes.after }),
    }
  })
}

function contentOf(message: CompactionMessage, loaded: ReadonlyArray<SessionMessageInfo>): CompactionContent {
  if (message.status === "running") return { kind: "running", summary: message.summary }
  if (message.status === "failed") return { kind: "failed", error: message.error.message }
  if (message.reason === "reset")
    return { kind: "reset", ...(message.undone === undefined ? {} : { undone: message.undone }) }
  const native = message.native?.messages
  if (native !== undefined) {
    const encrypted = encryptedOf(native)
    return {
      kind: "native",
      providerID: message.model?.providerID ?? "",
      modelID: message.model?.id ?? "",
      items: encrypted.length,
      size: encrypted.reduce((sum, item) => sum + item.length, 0),
    }
  }
  const users = message.metadata?.[USER_MESSAGES_KEY]
  const recent = message.metadata?.recent
  const kept = keptCount(message, loaded)
  return {
    kind: "summary",
    summary: message.summary,
    recent: typeof recent === "string" ? recent : "",
    ...(typeof recent !== "string" && kept !== undefined ? { kept } : {}),
    userMessages: Array.isArray(users) ? users.filter((item) => typeof item === "string") : [],
  }
}

/** The loaded messages from `metadata.keepID` up to the compaction: what stays word for word after its summary. */
function keptCount(message: CompactionMessage, loaded: ReadonlyArray<SessionMessageInfo>) {
  const keepID = message.metadata?.keepID
  if (typeof keepID !== "string") return undefined
  const from = loaded.findIndex((item) => item.id === keepID)
  const to = loaded.findIndex((item) => item.id === message.id)
  return from < 0 || to < from ? undefined : to - from
}

/**
 * The encrypted payloads of a provider context (canonical messages whose content parts are `{type: "compaction",
 * encrypted}`, packages/ai `CompactionPart`), found wherever they sit in the messages.
 */
function encryptedOf(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(encryptedOf)
  if (value === null || typeof value !== "object") return []
  const own = value.type === "compaction" && typeof value.encrypted === "string" ? [value.encrypted] : []
  return [...own, ...Object.values(value).flatMap(encryptedOf)]
}

/**
 * own's `fallback` metadata on a checkpoint (P-025): the stand-in model (`provider/model`) when another model wrote it
 * (none: code made it), and why the compaction failed.
 */
function fallbackOf(metadata: Readonly<Record<string, JsonValue>> | undefined) {
  const value = metadata?.fallback
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return {
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    reason: typeof value.reason === "string" ? value.reason : "",
  }
}
