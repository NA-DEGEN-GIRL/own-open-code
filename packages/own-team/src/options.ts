export * as Options from "./options.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

export const LogLevel = Schema.Literals(["debug", "info", "warn", "error"])
export type LogLevel = typeof LogLevel.Type

/**
 * `ctx.options` of own.team (`{ "package": "<dir>", "options": { … } }`). The installed build needs none of them.
 * `service` carries the service password of a source run or a test: it is only ever sent as `Authorization` to that
 * loopback URL and never logged (06 §12.2).
 */
export const Info = Schema.Struct({
  /**
   * `remote`: inside the own service of an SSH host (04 §9.1, 06 §4.13). Guard 1 also wants `OWN_REMOTE=1`; the plugin
   * then loads in full and own's git calls find the bundled git-lfs (`<home>/tools/git-lfs/current`) first.
   */
  mode: optional(Schema.Literals(["local", "remote"])),
  /** `OWN_HOME` (02 §2.3). Development and tests set it; the remote managed config gives its absolute path (04 §5.6). */
  home: optional(Schema.String),
  /** Overrides the bundle build id; tests give every own plugin of one server the same value. */
  buildId: optional(Schema.String),
  /**
   * The self-HTTP service of a source run or a test (06 §2.6, §12.2): a loopback `http:` URL and its password. The
   * installed build reads the channel's registration file instead (`ServiceTarget.Service`).
   */
  service: optional(Schema.Struct({ url: Schema.String, password: Schema.String })),
  /** Seconds the controller outlives its last reference (06 §2.6). Default 30. */
  lingerSeconds: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 }))),
  logLevel: optional(LogLevel),
})
export type Info = typeof Info.Type

const decodeInfo = Schema.decodeUnknownSync(Info)

export function decode(input: unknown): Info {
  return decodeInfo(input ?? {})
}
