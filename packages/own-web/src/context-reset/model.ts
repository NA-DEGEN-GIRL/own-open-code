// 문맥 비우기 model (03 §18.18, 11 §7), pure. A context reset (core P-035) is a completed compaction message with
// reason `reset` and no summary: the model's context starts after the newest completed compaction that is not an
// undone reset (the active boundary). Undo works while the reset is that boundary (last in, first out).
import type { SessionInboxInfo, SessionMessageInfo } from "@opencode/client/promise"

export type ResetMessage = Extract<SessionMessageInfo, { type: "compaction"; status: "completed" }>
export type PendingReset = Extract<SessionInboxInfo, { type: "reset" }>

export function isReset(message: SessionMessageInfo | undefined): message is ResetMessage {
  return message?.type === "compaction" && message.status === "completed" && message.reason === "reset"
}

/** A completed compaction that bounds what the model sees: a summary, a native window or a reset not undone. */
export function isBoundary(message: SessionMessageInfo) {
  return message.type === "compaction" && message.status === "completed" && !(isReset(message) && message.undone)
}

/** The newest boundary's index in `messages` (-1 when the model sees everything loaded). */
export function boundaryIndex(messages: readonly SessionMessageInfo[]) {
  return messages.findLastIndex(isBoundary)
}

/** The reset the model's context starts after now, when the newest boundary is one. */
export function activeReset(messages: readonly SessionMessageInfo[]) {
  const message = messages[boundaryIndex(messages)]
  return isReset(message) ? message : undefined
}

/**
 * What the marker line offers (03 §4.5): `active` is the newest boundary (undoable while idle without a staged
 * revert), `blocked` has a later compaction (fork before it instead), `superseded` a later reset, `undone` was undone.
 */
export type MarkerState = "active" | "blocked" | "superseded" | "undone"

export function markerState(messages: readonly SessionMessageInfo[], id: string): MarkerState {
  const index = messages.findIndex((message) => message.id === id)
  const marker = messages[index]
  if (isReset(marker) && marker.undone) return "undone"
  const later = messages.slice(index + 1).filter(isBoundary)
  if (later.some(isReset)) return "superseded"
  return later.length > 0 ? "blocked" : "active"
}

/**
 * Message ids before the active reset, by position in the projected order, not by id: a queued reset's id is made at
 * admission, so a message steered in before it was delivered can have a larger id and still come first.
 */
export function beforeReset(messages: readonly SessionMessageInfo[]): ReadonlySet<string> {
  const index = boundaryIndex(messages)
  if (!isReset(messages[index])) return new Set()
  return new Set(messages.slice(0, index).map((message) => message.id))
}

/** The turns (user messages) before the active reset, for `이전 대화 {n}턴`. */
export function turnsBefore(messages: readonly SessionMessageInfo[]) {
  const index = boundaryIndex(messages)
  if (!isReset(messages[index])) return 0
  return messages.slice(0, index).filter((message) => message.type === "user").length
}

/** Whether anything the model sees follows the active boundary: else `이미 새 문맥이에요`. */
export function hasContext(messages: readonly SessionMessageInfo[]) {
  return messages
    .slice(boundaryIndex(messages) + 1)
    .some((message) => message.type === "user" || message.type === "assistant" || message.type === "synthetic")
}

export function pendingReset(pending: readonly SessionInboxInfo[]) {
  return pending.find((item): item is PendingReset => item.type === "reset")
}

/**
 * `/undo` right after a reset (03 §18.7): a revert to the last turn would delete the marker with it, so the user
 * chooses. True when the active reset has no user message after it.
 */
export function justReset(messages: readonly SessionMessageInfo[]) {
  const index = boundaryIndex(messages)
  return isReset(messages[index]) && !messages.slice(index + 1).some((message) => message.type === "user")
}

/** The size the model last saw on a request: input, cache and output of the newest measured step in `messages`. */
function measured(messages: readonly SessionMessageInfo[]) {
  const step = messages.findLast(
    (message) =>
      message.type === "assistant" &&
      message.tokens !== undefined &&
      message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0,
  )
  if (step?.type !== "assistant" || !step.tokens) return undefined
  const tokens = step.tokens
  return {
    prompt: tokens.input + tokens.cache.read + tokens.cache.write,
    total: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning,
  }
}

/**
 * What an undo would send (03 §18.18 "되돌리기"): about the last size before the reset plus what the conversation
 * after it added (the newest post-reset size minus its first request's), and whether to ask first. It asks when that
 * reaches the auto-compaction point (the next request would compact first), or when the part before the reset is
 * written to the cache again (`cold`, `why`): it was last sent longer ago than the slot's cache lives (`lifetime`),
 * the marker no longer keeps the instruction epoch it ended, so the request does not start byte for byte as before
 * (`baseline`, 11 §7.3: a revert or a fork since), or the conversation after the reset has more content blocks than an
 * Anthropic request's breakpoint looks back over (`lookback`, 02 §6.3). `undefined` when nothing before the reset was
 * measured.
 */
export function undoCost(input: {
  readonly messages: readonly SessionMessageInfo[]
  readonly resetID: string
  /** The auto-compaction point (`cache.state.compaction.triggerTokens`), when known. */
  readonly trigger?: number
  /** How long the slot's cache stays warm after a request (`warmUntil − lastReqAt` of a warm slot), when known. */
  readonly lifetime?: number
  /** The content blocks a breakpoint looks back over (Anthropic: 20), when the session's slot caches that way. */
  readonly lookback?: number
  readonly now: number
}):
  | { readonly tokens: number; readonly ask?: "compacts" | "cold"; readonly why?: "lifetime" | "baseline" | "lookback" }
  | undefined {
  const index = input.messages.findIndex((message) => message.id === input.resetID)
  const marker = input.messages[index]
  if (!isReset(marker)) return undefined
  const earlier = input.messages.slice(0, index)
  const before = measured(earlier)
  if (!before) return undefined
  const sent = earlier.findLast((message) => message.type === "assistant")?.time.created ?? 0
  const after = input.messages.slice(index + 1)
  const first = after.find((message) => message.type === "assistant" && message.tokens !== undefined)
  const newest = measured(after)
  const firstPrompt =
    first?.type === "assistant" && first.tokens
      ? first.tokens.input + first.tokens.cache.read + first.tokens.cache.write
      : undefined
  const added = newest && firstPrompt !== undefined ? Math.max(0, newest.total - firstPrompt) : 0
  const tokens = before.total + added
  if (input.trigger !== undefined && tokens >= input.trigger) return { tokens, ask: "compacts" }
  const cold = { tokens: before.prompt, ask: "cold" as const }
  if (input.lifetime !== undefined && input.now - sent > input.lifetime) return { ...cold, why: "lifetime" }
  if (!marker.baseline) return { ...cold, why: "baseline" }
  if (input.lookback !== undefined && blocks(after) > input.lookback) return { ...cold, why: "lookback" }
  return { tokens }
}

/** Content blocks a stretch of the conversation adds to an Anthropic request: a tool call is its use and its result. */
function blocks(messages: readonly SessionMessageInfo[]) {
  return messages.reduce((sum, message) => {
    if (message.type === "assistant")
      return sum + message.content.reduce((count, part) => count + (part.type === "tool" ? 2 : 1), 0)
    if (message.type === "user") return sum + 1 + (message.files?.length ?? 0)
    return sum + (message.type === "synthetic" || message.type === "system" ? 1 : 0)
  }, 0)
}
