export * as Options from "./options.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { ServiceTarget } from "@own/runtime"

/**
 * `ctx.options` of own.import (`{ "package": "<dir>", "options": { … } }`). The installed build needs none of them.
 * `service` carries the service password of a source run or a test: it is only ever sent as `Authorization` to that
 * loopback URL and never logged (06 §12.2). `roots` replaces the default roots of a kind (09 §7.3): tests always set
 * both, so they never read the user's `~/.codex` or `~/.claude`.
 */

/** A loopback `http:` origin, the only kind of service a password may go to (own-runtime `ServiceTarget`). */
const LoopbackUrl = Schema.String.check(
  Schema.makeFilter((url) => {
    const parsed = URL.parse(url)
    if (!parsed || parsed.protocol !== "http:") return "service.url must be an http: URL"
    return (
      parsed.hostname === "localhost" ||
      ServiceTarget.isLoopback(parsed.hostname) ||
      "service.url must be a loopback address"
    )
  }),
)

const Folders = Schema.Array(Schema.NonEmptyString)

export const Info = Schema.Struct({
  /** `OWN_HOME` (02 §2.3): `state/import-sources.json`, `state/import-index.json` and `tmp/` live under it. */
  home: optional(Schema.String),
  /** Overrides the bundle build id; tests give every own plugin of one server the same value. */
  buildId: optional(Schema.String),
  /** The service channel whose registration file the installed build reads; default `ctx.app.channel`. */
  channel: optional(Schema.String),
  /** The self-HTTP service of a source run or a test (06 §12.2): a loopback `http:` URL and its password. */
  service: optional(Schema.Struct({ url: LoopbackUrl, password: Schema.NonEmptyString })),
  /**
   * Root folders per kind. A given list (even an empty one) replaces that kind's default root (`$CODEX_HOME` or
   * `%USERPROFILE%\.codex`, `$CLAUDE_CONFIG_DIR` or `%USERPROFILE%\.claude`); added roots still apply.
   */
  roots: optional(Schema.Struct({ codex: optional(Folders), claude: optional(Folders) })),
  /**
   * own's global skills folder, where imported skills are copied (09 §9.4); default `%OPENCODE_CONFIG_DIR%\skills`
   * (core reads `skills\` of the global config folder). Tests always set it. Without either, nothing is copied.
   */
  skillsDir: optional(Schema.NonEmptyString),
  /**
   * The codex-multi-provider control center whose account homes (`profiles\<id>\codex`) the skills list reads, from
   * its `state.json` only (SK2, 09 §9.1); `null` reads none. Default: `CodexSource.DEFAULT_CONTROL_CENTER` while Codex's
   * root is the default one (no `roots.codex`), so tests and source runs never reach this PC's.
   */
  controlCenter: optional(Schema.NullOr(Schema.NonEmptyString)),
})
export type Info = typeof Info.Type

const decodeInfo = Schema.decodeUnknownSync(Info)

export function decode(input: unknown): Info {
  return decodeInfo(input ?? {})
}

/** `decode` without throwing: a failure makes the plugin log `invalid_options` instead of failing to load. */
export const decodeResult = (input: unknown) => Schema.decodeUnknownResult(Info)(input ?? {})
