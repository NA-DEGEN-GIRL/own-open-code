export * as Options from "./options.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/** `ctx.options` of own-telemetry. `home` and `buildId` must match own-accounts' options. No secrets. */
export const Info = Schema.Struct({
  /** `OWN_HOME` (02 §2.3). */
  home: optional(Schema.String),
  /** Test override of the build id; give own-accounts the same value. */
  buildId: optional(Schema.String),
  logLevel: optional(Schema.Literals(["debug", "info", "warn", "error"])),
})
export type Info = typeof Info.Type

const decodeInfo = Schema.decodeUnknownSync(Info)

export function decode(input: unknown): Info {
  return decodeInfo(input ?? {})
}
