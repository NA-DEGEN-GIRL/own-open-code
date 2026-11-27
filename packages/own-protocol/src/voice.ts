export * as Voice from "./voice.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { NonNegative } from "./id.js"

/**
 * Voice input (받아쓰기, 02 §3.9, 03 §5.7.4): own-web records, own.accounts sends the recording to a speech-to-text
 * service with a voice-only key from the vault, and the text goes into the draft at the cursor (never sent by itself).
 * Phase 1 is file recognition after the recording ends. Each service is a row of {@link SERVICES}, so a realtime
 * service can be added later as another row with its own `mode`.
 */

/** The recognition services. Their keys are voice-only vault items, never an account's key (02 §3.9). */
export const Provider = Schema.Literals(["openai", "deepgram"]).annotate({ identifier: "Own.Voice.Provider" })
export type Provider = typeof Provider.Type

/** `auto`: the service detects the language. */
export const Language = Schema.Literals(["auto", "ko", "en"]).annotate({ identifier: "Own.Voice.Language" })
export type Language = typeof Language.Type

/** How a service recognizes speech: `file` = one upload after the recording ends (phase 1). */
export type Mode = "file"

export interface Service {
  readonly provider: Provider
  readonly model: string
  readonly mode: Mode
}

/** OpenAI `gpt-transcribe` is the default (own/reports/voice-input-2026-10-09.md §1); Deepgram Nova-3 the option. */
export const SERVICES: Readonly<Record<Provider, Service>> = {
  openai: { provider: "openai", model: "gpt-transcribe", mode: "file" },
  deepgram: { provider: "deepgram", model: "nova-3", mode: "file" },
}

/** The vault item of a service's key. Never `acc_…`, so it can never be taken for an account's credential. */
export function keyID(provider: Provider) {
  return `voice-${provider}` as const
}

/** Longest recording: own-web stops at this length, the service refuses a longer one. */
export const MAX_SECONDS = 180
/** Largest recording (bytes before base64); 3 minutes of 32 kbit/s Opus is about 0.7 MiB. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024
/** `audio` is base64 in the JSON body. */
export const MAX_AUDIO_BASE64 = Math.ceil(MAX_AUDIO_BYTES / 3) * 4
/** The hint (project file names, identifiers) the service gets as context for technical words. */
export const MAX_HINT_CHARS = 600
/** API keys are short; anything longer is a paste mistake. */
export const MAX_KEY_CHARS = 512
/** `usage` keeps this many month rows. */
export const USAGE_MONTHS = 24

/** What MediaRecorder produces (Chromium `audio/webm`, Firefox `audio/ogg`, Safari `audio/mp4`) and test files. */
export const MediaType = Schema.Literals(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"]).annotate({
  identifier: "Own.Voice.MediaType",
})
export type MediaType = typeof MediaType.Type

const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))

/** Recognized audio of one service in one month (UTC). Only lengths and counts: no audio, no text. */
export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({
  month: Month,
  provider: Provider,
  seconds: NonNegative,
  requests: NonNegativeInt,
}).annotate({ identifier: "Own.Voice.Usage" })

/** `OWN_HOME\voice.json` (02 §2.3). No secrets: the keys are vault items `voice-<provider>`. */
export interface File extends Schema.Schema.Type<typeof File> {}
export const File = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  enabled: Schema.Boolean,
  provider: Provider,
  language: Language,
  /** Newest month first, at most {@link USAGE_MONTHS} rows per service. */
  usage: Schema.Array(Usage),
}).annotate({ identifier: "Own.Voice.File" })

/** Off until the user turns it on (it spends paid API minutes); OpenAI and Korean when they do. */
export const defaults: File = { schemaVersion: 1, enabled: false, provider: "openai", language: "ko", usage: [] }

/** Whether a service has its key. `keyHint` is the key's last four characters (`sk-…9fQ2`), never the key. */
export interface KeyState extends Schema.Schema.Type<typeof KeyState> {}
export const KeyState = Schema.Struct({
  provider: Provider,
  configured: Schema.Boolean,
  keyHint: optional(Schema.String),
}).annotate({ identifier: "Own.Voice.KeyState" })

/** `voice.get` result and the result of every settings change. */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  enabled: Schema.Boolean,
  provider: Provider,
  language: Language,
  /** One row per service. */
  keys: Schema.Array(KeyState),
  /** The selected service's model, e.g. `gpt-transcribe`. */
  model: Schema.String,
  usage: Schema.Array(Usage),
  limits: Schema.Struct({ maxSeconds: NonNegativeInt, maxAudioBytes: NonNegativeInt, maxHintChars: NonNegativeInt }),
  /** `unavailable`: the vault helper does not answer, so key states are unknown. */
  vault: Schema.Literals(["ok", "unavailable"]),
}).annotate({ identifier: "Own.Voice.View" })

export interface SetInput extends Schema.Schema.Type<typeof SetInput> {}
export const SetInput = Schema.Struct({
  enabled: optional(Schema.Boolean),
  provider: optional(Provider),
  language: optional(Language),
}).annotate({ identifier: "Own.Voice.SetInput" })

/** `key: null` removes the service's key. The key goes only into the vault and never comes back. */
export interface KeyInput extends Schema.Schema.Type<typeof KeyInput> {}
export const KeyInput = Schema.Struct({
  provider: Provider,
  key: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_KEY_CHARS))),
}).annotate({ identifier: "Own.Voice.KeyInput" })

export interface TranscribeInput extends Schema.Schema.Type<typeof TranscribeInput> {}
export const TranscribeInput = Schema.Struct({
  /** The recording, base64. Not stored, not logged, never in a session. */
  audio: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_AUDIO_BASE64)),
  mediaType: MediaType,
  /** The recorder's measured length; the service refuses more than {@link MAX_SECONDS}. */
  durationMs: optional(NonNegativeInt),
  /** Absent: the setting. */
  language: optional(Language),
  /** Project file names and identifiers, for technical words. */
  hint: optional(Schema.String.check(Schema.isMaxLength(MAX_HINT_CHARS))),
}).annotate({ identifier: "Own.Voice.TranscribeInput" })

export interface TranscribeResult extends Schema.Schema.Type<typeof TranscribeResult> {}
export const TranscribeResult = Schema.Struct({
  text: Schema.String,
  provider: Provider,
  model: Schema.String,
  /** The audio length counted in `usage`. */
  seconds: NonNegative,
  /** As the service detected or echoed it. */
  language: optional(Schema.String),
}).annotate({ identifier: "Own.Voice.TranscribeResult" })

/** Why a recognition failed (`voice_failed`). `retryable`: the same recording may succeed when sent again. */
export const Failure = Schema.Literals([
  "auth",
  "rate_limited",
  "quota",
  "rejected",
  "network",
  "timeout",
  "provider",
]).annotate({ identifier: "Own.Voice.Failure" })
export type Failure = typeof Failure.Type

/** `YYYY-MM` of an epoch millisecond in UTC. */
export function monthOf(at: number) {
  return new Date(at).toISOString().slice(0, 7)
}

/**
 * Adds one recognition to the usage rows: one row per month and service, newest month first (services in
 * {@link Provider} order within a month), {@link USAGE_MONTHS} months per service.
 */
export function addUsage(
  usage: ReadonlyArray<Usage>,
  input: { readonly at: number; readonly provider: Provider; readonly seconds: number },
) {
  const month = monthOf(input.at)
  const current = usage.find((row) => row.month === month && row.provider === input.provider)
  const next: Usage = {
    month,
    provider: input.provider,
    seconds: Math.round(((current?.seconds ?? 0) + Math.max(0, input.seconds)) * 1000) / 1000,
    requests: (current?.requests ?? 0) + 1,
  }
  const order = Provider.literals
  return [next, ...usage.filter((row) => row !== current)]
    .toSorted((a, b) =>
      a.month === b.month ? order.indexOf(a.provider) - order.indexOf(b.provider) : a.month < b.month ? 1 : -1,
    )
    .filter(
      (row, _, rows) =>
        rows.filter((other) => other.provider === row.provider && other.month >= row.month).length <= USAGE_MONTHS,
    )
}
