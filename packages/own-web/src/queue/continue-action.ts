// `이어서` under a turn that a stalled model stream or core's inactivity stop ended (core patch P-018, 03 §4.5): a new
// prompt `계속`, which stays in the conversation like the wait-and-continue of 6.6. The transcript only draws the
// button; the write lives here with the queue's other session writes (transcript.test.ts UI-only rule).
import type { ServerRuntime } from "@/data"
import { storedLocale } from "@/i18n"

/** The prompt `이어서` sends, in the screen's language. */
export const CONTINUE_PROMPT = { ko: "계속", en: "Continue" } as const

export function continueTurn(runtime: Pick<ServerRuntime, "data">, sessionID: string) {
  return runtime.data.session.prompt({ sessionID, text: CONTINUE_PROMPT[storedLocale()] })
}
