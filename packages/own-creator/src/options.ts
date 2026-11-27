export * as Options from "./options.js"

import { Effect, Schema } from "effect"

/** `ctx.options` of own.creator. The launcher passes none; every field has a default. No secrets. */
export const Info = Schema.Struct({
  /** `OWN_HOME` (02 §2.3); the store is its `creator` folder. Default: own-runtime's resolution. */
  home: Schema.optionalKey(Schema.String),
  /** `false` loads nothing: no creator agent, no extensions (like own-omo's switch). */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** The npm registry C2 dependencies install from (tests and mirrors); the user's default otherwise. */
  registry: Schema.optionalKey(Schema.String),
  /**
   * `remote` on an SSH host (own-remote's managed config, 17 §10): the store is a read-only mirror of the PC's, kept by
   * the broker; no creator mode, no Settings RPC. `local` (default) is this PC's own store.
   */
  mode: Schema.Literals(["local", "remote"]).pipe(Schema.withDecodingDefault(Effect.succeed("local" as const))),
})
export type Info = typeof Info.Type

export const decodeResult = (input: unknown) => Schema.decodeUnknownResult(Info)(input ?? {})
