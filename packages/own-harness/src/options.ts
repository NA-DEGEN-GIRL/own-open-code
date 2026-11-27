export * as Options from "./options.js"

import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect, Schema } from "effect"

/** `ctx.options` of own.harness. Every field is optional; decoding fills the defaults. No secrets. */
export const Info = Schema.Struct({
  /** The harness a new top-level session gets when its creator names none (10 §3.2). Default `codex`. */
  default: OwnHarness.HarnessID.pipe(Schema.withDecodingDefault(Effect.succeed("codex" as const))),
  /**
   * The base prompt variant a new top-level session runs when its creator names none (10 §3.9). Default own's revision
   * (H-D7, amended 2026-10-17); a default saved in Settings > 일반 (`defaults.set`) wins.
   */
  prompt: OwnHarness.PromptID.pipe(Schema.withDecodingDefault(Effect.succeed("own" as const))),
  /**
   * The automatic choice of models a failed compaction falls back to, by model ID, most preferred first (own/docs/11
   * §3): each ID is looked for on the user's accounts, the account that failed skipped. Used until the user picks the
   * models in Settings (own.harness `compaction.set`).
   */
  compactionFallback: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(["gpt-6-astra", "gpt-6.1-sol", "claude-opus-5-5", "deepseek-v4-pro"])),
  ),
})
export type Info = typeof Info.Type

export const decodeResult = (input: unknown) => Schema.decodeUnknownResult(Info)(input ?? {})
