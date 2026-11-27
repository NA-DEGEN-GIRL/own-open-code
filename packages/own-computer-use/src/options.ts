export * as Options from "./options.js"

import { Effect, Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/**
 * `ctx.options` of own.computer-use. Every field is optional; decoding fills the documented defaults, so the rest of
 * the plugin only sees complete values. No secrets.
 */

const withDefault = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)))

const Helper = Schema.Struct({
  /** `driver: "helper"` only. Default: `own-cu-helper.exe` in the app directory of `home` (own-runtime `Home.layout`). */
  exePath: optional(Schema.String),
  /** `driver: "helper"` only: replaces the helper command line, e.g. `["bun", "test/fixtures/fake-helper.ts"]`. */
  command: optional(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
  /**
   * Per-request timeout of the desktop worker (`windows`) or the helper (`helper`); after it the worker is abandoned
   * or the helper killed, computer use stops (kill switch) and the next request starts a new one. Default 10 s.
   */
  timeoutMs: withDefault(Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 })), 10_000),
})

const Image = Schema.Struct({
  /** `standard`: long edge ≤ 1568 px and ≤ 1.15 MP. `high`: long edge ≤ 2000 px. Default `standard`. */
  tier: withDefault(Schema.Literals(["standard", "high"]), "standard"),
  /**
   * Base64 budget per image; below core's 5 MiB pass-through limit so core never rescales. Default 4.5 MB. Images are
   * also held to an equal share of 20 MiB per request (`Budget.imageLimit`: about 1.43 MiB with the default history).
   */
  maxBase64Bytes: withDefault(Schema.Int.check(Schema.isBetween({ minimum: 100_000, maximum: 4_500_000 })), 4_500_000),
  /**
   * `auto`: PNG, then JPEG 85/75/60 until it fits. `png`: PNG or fail, so busy screens can exceed the per-image share
   * above and fail with `image_too_large`; pair it with a smaller history. Default `auto`.
   */
  format: withDefault(Schema.Literals(["auto", "png"]), "auto"),
})

const History = Schema.Struct({
  /** Newest screenshots always kept in model requests. Default 8. */
  keep: withDefault(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })), 8),
  /** Older screenshots are dropped this many at a time to keep the prompt cache. Default 7. */
  batch: withDefault(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })), 7),
})

const Policy = Schema.Struct({
  /** Apps (exe names, `.exe` optional) usable without asking; exclusive in `session` approval mode when non-empty. */
  allowApps: withDefault(Schema.Array(Schema.String), []),
  /** Apps added to the built-in deny list. */
  denyApps: withDefault(Schema.Array(Schema.String), []),
  /** Lifts the terminal part of the deny list. Default false. */
  allowTerminals: withDefault(Schema.Boolean, false),
  /** Lets subagents (child sessions) use computer tools. Default false. */
  allowSubagents: withDefault(Schema.Boolean, false),
  /** Chords never sent in addition to super+r, ctrl+alt+delete and the stop chord. */
  blockedChords: withDefault(Schema.Array(Schema.String), []),
})

export const Info = Schema.Struct({
  /** `OWN_HOME` (02 §2.3); the audit log lives under it. */
  home: optional(Schema.String),
  /** Test override of the build id. */
  buildId: optional(Schema.String),
  /**
   * `windows`: in-process Win32 calls (`bun:ffi`) on worker threads. `helper`: the separate `own-cu-helper.exe`, a
   * fallback. `fake`: an in-memory desktop for tests. Default `windows`.
   */
  driver: withDefault(Schema.Literals(["windows", "helper", "fake"]), "windows"),
  helper: withDefault(Helper, {}),
  image: withDefault(Image, {}),
  history: withDefault(History, {}),
  policy: withDefault(Policy, {}),
  /**
   * `session`: enabling computer use for a session is the consent for every app that is not denied. `question`: the
   * first action on each app asks the user (allow for this session / deny). Default `session`.
   */
  approval: withDefault(Schema.Literals(["session", "question"]), "session"),
  /** Register the tools behind Code Mode's `execute` (like the browser tools). Default true. */
  codemode: withDefault(Schema.Boolean, true),
  /** Attach a fresh screenshot to the result of every input action. Default `never`. */
  returnScreenshot: withDefault(Schema.Literals(["never", "after_action"]), "never"),
  /** Write the redacted audit log. Default true. */
  audit: withDefault(Schema.Boolean, true),
  /** Seconds after which an idle session loses the desktop lease to another session. Default 120. */
  leaseIdleSeconds: withDefault(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 3_600 })), 120),
})
export type Info = typeof Info.Type

const decodeInfo = Schema.decodeUnknownSync(Info)

export function decode(input: unknown): Info {
  return decodeInfo(input ?? {})
}

/** `decode` without throwing: a failure makes the plugin report `invalid_options` instead of failing to load. */
export const decodeResult = (input: unknown) => Schema.decodeUnknownResult(Info)(input ?? {})
