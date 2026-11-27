// Ports packages/guard/repeat-tool-reminder/src/index.ts as the standard preset configures it (thresholds 3, 5 and 8,
// 500 argument characters): consecutive calls with the same tool name and the same arguments (keys sorted) form a
// chain; the call that makes the chain 3 long gets the gentle reminder, 5 and 8 the detailed one naming the tool, the
// count and the arguments. A user message breaks the chain. Nothing is blocked. dsh appends the reminder as a user
// message after the step's results, so the cached prefix stays as it was; own works it out from the history each
// request (request.ts places it there), so the same history gives the same reminders.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshReminder from "./reminder.js"

import type { Message } from "@opencode/ai/effect"

export const THRESHOLDS = [3, 5, 8] as const
export const ARGUMENTS_PREVIEW_CHARS = 500

export const GENTLE =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is " +
  "not complete, try a different approach or different arguments instead of " +
  "repeating the call."

export function detailed(tool: string, count: number, canonicalArguments: string) {
  return (
    "Repeated tool call detected:\n" +
    `- tool: ${tool}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    "The repeated calls are not making progress. Do not call this tool with " +
    "these exact arguments again. Inspect the latest result and choose a " +
    "different action, different arguments, or finish the task if enough " +
    "evidence has been gathered."
  )
}

/** `canonicalize`: deep key sort, then JSON. */
export function canonicalize(value: unknown) {
  return JSON.stringify(sort(value))
}

/**
 * The reminders each assistant message's calls earn, by the message's index in `history`. `isUser` tells the user's
 * own messages (which break a chain) from the other user-role messages (notices, checkpoints).
 */
export function reminders(history: ReadonlyArray<Message>, isUser: (message: Message) => boolean) {
  const chain = { key: "", count: 0 }
  const found = new Map<number, Array<string>>()
  history.forEach((message, index) => {
    if (isUser(message)) {
      chain.key = ""
      chain.count = 0
      return
    }
    if (message.role !== "assistant") return
    message.content.forEach((part) => {
      if (part.type !== "tool-call" || part.providerExecuted === true) return
      const canonical = canonicalize(part.input)
      const key = JSON.stringify([part.name, canonical])
      chain.count = chain.key === key ? chain.count + 1 : 1
      chain.key = key
      if (!(THRESHOLDS as ReadonlyArray<number>).includes(chain.count)) return
      const text =
        chain.count === THRESHOLDS[0]
          ? GENTLE
          : detailed(part.name, chain.count, preview(canonical, ARGUMENTS_PREVIEW_CHARS))
      found.set(index, [...(found.get(index) ?? []), text])
    })
  })
  return found
}

/** `previewArguments`: the head of the canonical arguments with the count of what is left out. */
export function preview(canonical: string, cap: number) {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
    )
  return value
}
