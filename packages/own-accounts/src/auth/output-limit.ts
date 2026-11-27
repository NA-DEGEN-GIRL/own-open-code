export * as OutputLimitShape from "./output-limit.js"

import type { SessionContext } from "@opencode/plugin/promise/session"
import { Provider } from "@opencode/schema/provider"
import { ClaudeAgent, OutputLimit } from "@own/protocol"
import type { Deps } from "../deps.js"

/**
 * 02 §4.9 (OL, 2026-10-19): the user's output limit on main requests, every provider, own slot or not. It runs first in
 * the session `context` hook, so the auth module's own-slot shaping still removes the limit for codex, oai and or slots
 * and fills DeepSeek's thinking-off default where none is left. Compaction, titles and `generate` never come here.
 *
 * - No setting (the default) changes nothing: core's limit goes out as it is.
 * - `cap`: core's limit without its 256,000 cap (`outputCeiling`, core patch P-032), at most the user's number.
 * - `omit`: no limit, except on Claude, whose Messages API requires one: the adapter's own default, never more than the
 *   model's limit or the room the prompt leaves (`outputCeiling`).
 *
 * A limit an earlier hook removed (upstream's `openai` provider) stays removed. Generation options are no prompt bytes:
 * the prefix and its cache stay the same (02 §4.9 "캐시").
 */
export function apply(event: SessionContext, setting: OutputLimit.Setting | undefined, claude: boolean) {
  const current = event.options.maxTokens
  if (setting === undefined || current === undefined) return
  const ceiling = event.outputCeiling ?? current
  const next =
    setting.mode === "cap"
      ? Math.min(ceiling, setting.maxTokens)
      : claude
        ? Math.min(ceiling, OutputLimit.CLAUDE_DEFAULT)
        : undefined
  if (next !== undefined) {
    event.options.maxTokens = next
    return
  }
  delete event.options.maxTokens
}

/** The `context` handler: the stored setting and whether the request goes to Claude (the `anthropic` slot or `anth`). */
export function handler(deps: Pick<Deps, "runtime">, kindOf: (providerID: string) => string | undefined) {
  return async (event: SessionContext) => {
    const policy = deps.runtime.policy.cached() ?? (await deps.runtime.policy.read())
    const providerID = event.model.providerID
    // Claude Agent (02 §8.10): Claude Code picks its own output budget, and a set one restarts its process on change.
    if (providerID === ClaudeAgent.PROVIDER_ID) return
    apply(event, policy.outputLimit, providerID === Provider.ID.anthropic || kindOf(providerID) === "anth")
  }
}
