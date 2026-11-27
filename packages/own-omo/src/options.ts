export * as Options from "./options.js"

import { Effect, Schema } from "effect"

/**
 * Which models omo's agents and categories run on (15 §4.4). `inherit` (the MVP): every omo agent and category runs on
 * the parent session's current model, whatever omo would pick. `configured` (accepted, not applied yet): the models in
 * `agents` and `categories`, as `provider/model` or `provider/model#variant`.
 */
export const Models = Schema.Struct({
  policy: Schema.Literals(["inherit", "configured"]),
  agents: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  categories: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type Models = typeof Models.Type

/** `ctx.options` of own.omo. Every field is optional; decoding fills the defaults. No secrets. */
export const Info = Schema.Struct({
  /**
   * `OWN_HOME` (02 §2.3), where omo's folders and own-omo's log go (15 §3.2); absent = `OWN_HOME` or its default. A
   * remote host's managed config names its install's (04 §5.6), as for the other own plugins there.
   */
  home: Schema.optional(Schema.String),
  /** `false` turns the plugin off: no runtime, hooks, agents or tools, and the `omo` harness is not offered. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  models: Models.pipe(Schema.withDecodingDefault(Effect.succeed({ policy: "inherit" as const }))),
  /** omo config merged over own's baseline (config.ts); own's policies still apply on top. */
  config: Schema.optional(Schema.Unknown),
})
export type Info = typeof Info.Type

export const decodeResult = (input: unknown) => Schema.decodeUnknownResult(Info)(input ?? {})
