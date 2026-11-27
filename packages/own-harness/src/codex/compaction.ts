// Codex's local compaction (codex-rs/core/src/compact.rs, rust-v0.162.1) on core's summary compaction: Codex keeps
// the user's messages (newest first within 20k tokens, oldest first in order) beside the summary. Since 2026-10-13 the
// summary comes from own's checkpoint prompt for every model (checkpoint.ts, own/docs/11 §6) and renders as one
// `<conversation-checkpoint>` message with those user messages. Checkpoints written earlier with Codex's prompt
// (`PROMPT`, kept as the evaluation's baseline) still render as Codex's replacement history: the user messages, then
// `SUMMARY_PREFIX\n<summary>`. Core's checkpoint also keeps the newest exchanges it did not summarize (`recent`); they
// follow the summary in core's `<recent-context>` form. Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as CodexCompaction from "./compaction.js"

import { Message } from "@opencode/ai/effect"
import COMPACT_PROMPT from "../../codex-data/compact-prompt.md" with { type: "text" }
import SUMMARY_PREFIX from "../../codex-data/compact-summary-prefix.md" with { type: "text" }
import { Checkpoint } from "../checkpoint.js"
import { Truncate } from "./truncate/index.js"

export const PROMPT = COMPACT_PROMPT
export { SUMMARY_PREFIX }

/** Checkpoint metadata (P-025): the user messages Codex keeps, oldest first. */
export const USER_MESSAGES_KEY = "own.harness.codex.userMessages"

/** Checkpoint metadata: which prompt wrote the summary. Absent means Codex's summary prompt (earlier checkpoints). */
export const FORMAT_KEY = "own.harness.compaction.format"
export const CHECKPOINT_FORMAT = "checkpoint-v1"

/** `COMPACT_USER_MESSAGE_MAX_TOKENS`. */
const MAX_TOKENS = 20_000

/** User messages that are context, not something the user said (Codex's contextual fragments and own's markers). */
const CONTEXTUAL = [
  "# AGENTS.md instructions for ",
  "<environment_context>",
  "<turn_aborted>",
  "<codex_internal_context",
  "<conversation-checkpoint>",
  "<harness_switch>",
  "<subagent ",
]

/** `build_compacted_history_with_limit`: the user messages to keep, newest first within the budget, in order. */
export function retained(history: ReadonlyArray<Message>) {
  const said = history.flatMap((entry) => {
    if (entry.role !== "user") return []
    const text = entry.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    if (text === "" || text.startsWith(`${SUMMARY_PREFIX}\n`)) return []
    return CONTEXTUAL.some((prefix) => text.startsWith(prefix)) ? [] : [text]
  })
  const picked = said.toReversed().reduce<{ readonly kept: ReadonlyArray<string>; readonly remaining: number; readonly done: boolean }>(
    (state, text) => {
      if (state.done || state.remaining === 0) return { ...state, done: true }
      const tokens = Truncate.approxTokenCount(text)
      if (tokens <= state.remaining) return { kept: [...state.kept, text], remaining: state.remaining - tokens, done: false }
      return {
        kept: [...state.kept, Truncate.truncateText(text, { mode: "tokens", limit: state.remaining })],
        remaining: 0,
        done: true,
      }
    },
    { kept: [], remaining: MAX_TOKENS, done: false },
  )
  return picked.kept.toReversed()
}

/**
 * Each checkpoint's metadata by its message id, from the session's history (`ctx.session.context`). Since @opencode/ai
 * v2.2.6 split Message by role, core's checkpoint message no longer carries the compaction's metadata.
 */
export type Checkpoints = ReadonlyMap<string, Readonly<Record<string, unknown>>>

export function checkpoints(
  history: ReadonlyArray<{ readonly id: string; readonly type: string; readonly metadata?: unknown }>,
): Checkpoints {
  return new Map(
    history.flatMap((message): Array<[string, Readonly<Record<string, unknown>>]> =>
      message.type === "compaction" && typeof message.metadata === "object" && message.metadata !== null
        ? [[message.id, message.metadata as Readonly<Record<string, unknown>>]]
        : [],
    ),
  )
}

/** Core's checkpoint message as Codex's replacement history; other messages pass through. */
export function render(entry: Message, checkpoints: Checkpoints = new Map()): ReadonlyArray<Message> {
  const first = entry.content[0]
  if (entry.role !== "user" || first?.type !== "text" || !first.text.startsWith("<conversation-checkpoint>\n")) return [entry]
  const summary = /<summary>\n([\s\S]*)\n<\/summary>/.exec(first.text)?.[1] ?? ""
  const recent = /<recent-context>\n([\s\S]*)\n<\/recent-context>/.exec(first.text)?.[1]
  const metadata = entry.id === undefined ? undefined : checkpoints.get(entry.id)
  const kept = metadata?.[USER_MESSAGES_KEY]
  const users = Array.isArray(kept) ? kept.filter((text): text is string => typeof text === "string") : []
  const recentBlock = recent === undefined ? "" : `\n<recent-context>\n${recent}\n</recent-context>`
  // own's checkpoint prompt (checkpoint.ts): one message with the checkpoint and the user's earlier words.
  if (metadata?.[FORMAT_KEY] === CHECKPOINT_FORMAT)
    return [
      Message.make({
        id: entry.id,
        role: "user",
        content: `${Checkpoint.render(summary, users, { notice: fallbackNotice(metadata?.fallback) })}${recentBlock}`,
      }),
    ]
  // A checkpoint core wrote with its own prompt (another harness, before own's prompt applied to all) stays as it is.
  if (kept === undefined) return [entry]
  return [
    ...users.map((text, index) => Message.make({ id: `${entry.id}-user-${index}`, role: "user", content: text })),
    Message.make({
      id: entry.id,
      role: "user",
      content: `${SUMMARY_PREFIX}\n${summary}${recent === undefined ? "" : `\n\n<recent-context>\n${recent}\n</recent-context>`}`,
    }),
  ]
}

/** How a fallback checkpoint was made (core's `fallback` metadata, P-025), for the model reading it. */
function fallbackNotice(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  const fallback = value as { failed?: unknown; reason?: unknown; model?: unknown }
  const reason = typeof fallback.reason === "string" ? fallback.reason : "unknown error"
  if (typeof fallback.model === "string")
    return `It was written by ${fallback.model} because ${String(fallback.failed)} could not compact (${reason}).`
  return `It was made by code without a model because compaction failed (${reason}), so details of the condensed part are missing; check files or ask the user when unsure.`
}
