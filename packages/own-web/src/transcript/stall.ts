// A turn that ended because the model stream stalled, timed out or broke, or that core stopped for inactivity (core
// patch P-018, 03 §4.5): the transcript offers `이어서` (queue/continue-action.ts sends `계속`). Core already retried
// the attempt; the retry row showed that while it ran. Pure, for the tests.
import type { SessionMessageInfo } from "@opencode/client/promise"

/**
 * Failed-turn error types a new prompt can pick up from: transport failures (the P-018 stream watchdog reports a stall
 * as a read timeout), timeouts, a stream that ended early, and core's inactivity stop.
 */
const RESUMABLE = new Set(["provider.transport", "provider.timeout", "provider.invalid-output", "session.inactivity"])

export function resumable(error: { readonly type: string } | undefined) {
  return error !== undefined && RESUMABLE.has(error.type)
}

/**
 * The newest message is the idle row of a turn core stopped for inactivity: P-018 records that stop as
 * `session.execution.failed` with metadata `{reason:"inactivity"}`, which the idle row keeps. Its assistant only says
 * "Step interrupted", so no error card shows it.
 */
export function stoppedForInactivity(messages: readonly SessionMessageInfo[]) {
  const last = messages.at(-1)
  return last?.type === "idle" && last.outcome === "failed" && last.metadata?.reason === "inactivity"
}
