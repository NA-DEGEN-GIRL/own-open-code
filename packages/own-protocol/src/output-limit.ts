export * as OutputLimit from "./output-limit.js"

import { Schema } from "effect"
import { PositiveInt } from "@opencode/schema/schema"
import type { Compaction } from "./compaction.js"

/**
 * The main reply's output limit (02 §4.9, 03 §5.7.4, user decision 2026-10-19 OL): `policy.outputLimit`, one setting
 * for the service and, through the policy mirror, its SSH hosts. Only main requests (the session `context` hook)
 * follow it: compaction keeps core's 32,000 summary cap, and titles and `generate` the provider default.
 * - `cap` (`이 값을 넘기지 않기`): the model's output limit fitted to the room the prompt leaves, at most `maxTokens`.
 *   With {@link CORE_CAP} that is core's own default, so the default setting sends what core sends.
 * - `omit` (`출력 상한 보내지 않기`): none, so the model's or provider's default applies. Where a value has to go out it
 *   is the one that would otherwise be filled in, fitted the same way: Claude {@link CLAUDE_DEFAULT} (the Messages API
 *   requires `max_tokens`), DeepSeek with thinking off {@link DS_THINKING_OFF} (its server default ends answers).
 * ChatGPT, OpenAI API keys and OpenRouter never get one, whatever the setting (02 §4.1).
 */

export const Mode = Schema.Literals(["cap", "omit"]).annotate({ identifier: "Own.OutputLimit.Mode" })
export type Mode = typeof Mode.Type

/** `policy.json` `outputLimit`. `omit` keeps the number so choosing `cap` again restores it. */
export interface Setting extends Schema.Schema.Type<typeof Setting> {}
export const Setting = Schema.Struct({ mode: Mode, maxTokens: PositiveInt }).annotate({
  identifier: "Own.OutputLimit.Setting",
})

/** `policy.set{patch.outputLimit}`: any integer, so the handler answers `setting_out_of_range` ({@link check}). */
export interface SettingInput extends Schema.Schema.Type<typeof SettingInput> {}
export const SettingInput = Schema.Struct({ mode: Mode, maxTokens: Schema.Int }).annotate({
  identifier: "Own.OutputLimit.SettingInput",
})

/** Core's cap on its default output limit (`OUTPUT_TOKEN_MAX`, surface `session-output-limit`). */
export const CORE_CAP = 256_000
/** The setting when `policy.json` has none: core's default. */
export const DEFAULT: Setting = { mode: "cap", maxTokens: CORE_CAP }
/** Below this a thinking model cannot think and answer (Claude's budget must stay under the limit, at least 1,024). */
export const MIN_TOKENS = 4_096
/** The number is only a ceiling: a request never asks more than the model's own limit. */
export const MAX_TOKENS = 1_000_000
/** What the Anthropic Messages adapter sends when a request has no limit (surface `anthropic-default-max-tokens`). */
export const CLAUDE_DEFAULT = 32_000
/**
 * DeepSeek with thinking off when nothing set a limit (external-repos P0-4 option C, decision D2): its server default
 * is 8K, which ends long answers and file writes silently; 65,536 is its thinking-on default.
 */
export const DS_THINKING_OFF = 65_536

/** The stored setting, or the default. */
export function resolve(setting: Setting | undefined): Setting {
  return setting ?? DEFAULT
}

/** A patch value outside {@link MIN_TOKENS}..{@link MAX_TOKENS}, as `setting_out_of_range` data. */
export function check(input: SettingInput): Compaction.OutOfRange | undefined {
  if (Number.isInteger(input.maxTokens) && input.maxTokens >= MIN_TOKENS && input.maxTokens <= MAX_TOKENS) return
  return { field: "outputLimit.maxTokens", min: MIN_TOKENS, max: MAX_TOKENS }
}
