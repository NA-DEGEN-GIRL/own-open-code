export * as VoiceInput from "./voice.js"

import { Buffer } from "node:buffer"
import { Cause, Effect, Exit, Option } from "effect"
import { AIError, Auth, Media } from "@opencode/ai/effect"
import { Transcription, TranscriptionClient } from "@opencode/ai/experimental"
import { DeepgramTranscription } from "@opencode/ai/protocols/deepgram-transcription"
import { OpenAITranscription } from "@opencode/ai/protocols/openai-transcription"
import { RequestExecutor } from "@opencode/ai/route"
import { Voice } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { RpcTypes } from "../rpc/types.js"

/**
 * Voice input (02 §3.9): settings in `voice.json`, voice-only keys in the vault (`voice-openai`, `voice-deepgram`) and
 * one recognition per call through upstream `@opencode/ai` Transcription (`openai-transcription`,
 * `deepgram-transcription`). This module never reads the account registry and never asks for an account's
 * credential: a model account's key (or a ChatGPT subscription token) cannot reach a transcription endpoint, and a
 * voice key cannot reach a model request (`Credentials.headersFor` only takes accounts).
 *
 * The recording and the recognized text are not stored, logged or put into a session; the log gets sizes, the service
 * and the outcome only. `voice.json` gets the minutes.
 */
export interface Api {
  readonly get: RpcTypes.Handler<"voice.get">
  readonly set: RpcTypes.Handler<"voice.set">
  readonly setKey: RpcTypes.Handler<"voice.key.set">
  readonly transcribe: RpcTypes.Handler<"voice.transcribe">
}

/** A recognition that takes longer is cut off (`timeout`); a 3-minute recording normally takes a few seconds. */
export const TIMEOUT_MS = 90_000

/** Keys are pasted: printable ASCII without spaces. Anything else is a paste mistake, not a key. */
const KEY_PATTERN = /^[\x21-\x7e]+$/

export function create(deps: Deps, options: { readonly timeoutMs?: number } = {}): Api {
  const log = deps.log.child("voice")
  const credentials = deps.runtime.credentials
  const file = deps.runtime.voice

  const view = async (current: Voice.File): Promise<Voice.View> => {
    const keys = await Promise.all(
      Voice.Provider.literals.map(async (provider) => {
        const state = await credentials.inspectFeatureKey(Voice.keyID(provider))
        return { provider, state }
      }),
    )
    return {
      enabled: current.enabled,
      provider: current.provider,
      language: current.language,
      keys: keys.map((key) => ({
        provider: key.provider,
        configured: key.state.configured,
        ...(key.state.keyHint ? { keyHint: key.state.keyHint } : {}),
      })),
      model: Voice.SERVICES[current.provider].model,
      usage: current.usage,
      limits: {
        maxSeconds: Voice.MAX_SECONDS,
        maxAudioBytes: Voice.MAX_AUDIO_BYTES,
        maxHintChars: Voice.MAX_HINT_CHARS,
      },
      vault: keys.some((key) => key.state.problem === "vault_unavailable") ? "unavailable" : "ok",
    }
  }

  return {
    get: async (_input, context) =>
      file.read().then(view, (error: unknown) => {
        log.error("voice_settings_unreadable", { error })
        return context.error("internal_error", "voice.json cannot be read", {})
      }),

    set: async (input, context) =>
      file
        .update((current) => ({
          ...current,
          enabled: input.enabled ?? current.enabled,
          provider: input.provider ?? current.provider,
          language: input.language ?? current.language,
        }))
        .then(
          (next) => {
            log.info("voice_settings_set", { enabled: next.enabled, provider: next.provider, language: next.language })
            return view(next)
          },
          (error: unknown) => {
            log.error("voice_settings_unwritable", { error })
            return context.error("internal_error", "voice.json cannot be written", {})
          },
        ),

    setKey: async (input, context) => {
      const id = Voice.keyID(input.provider)
      const key = input.key?.trim()
      if (key !== undefined && !KEY_PATTERN.test(key))
        return context.error("voice_key_invalid", "not a key: empty, or holds spaces or control characters", {})
      const stored =
        key === undefined ? await credentials.removeFeatureKey(id) : await credentials.storeFeatureKey(id, key)
      if (!stored.ok) {
        log.warn("voice_key_vault_failed", { provider: input.provider, problem: stored.problem })
        return context.error("vault_unavailable", "the vault did not answer", {})
      }
      // Never the key or its hint: only which service and whether it is set now.
      log.info("voice_key_set", { provider: input.provider, configured: key !== undefined })
      return file.read().then(view, () => context.error("internal_error", "voice.json cannot be read", {}))
    },

    transcribe: async (input, context) => {
      const settings = await file.read().catch(() => undefined)
      if (!settings) return context.error("internal_error", "voice.json cannot be read", {})
      const provider = settings.provider
      if (!settings.enabled)
        return context.error("voice_unavailable", "voice input is off", { reason: "disabled", provider })
      const audio = decodeAudio(input.audio)
      if (!audio.ok)
        return context.error("voice_audio_invalid", "the recording cannot be used", {
          reason: audio.reason,
          ...(audio.reason === "too_large" ? { max: Voice.MAX_AUDIO_BYTES } : {}),
        })
      if ((input.durationMs ?? 0) > Voice.MAX_SECONDS * 1000)
        return context.error("voice_audio_invalid", "the recording is too long", {
          reason: "too_long",
          max: Voice.MAX_SECONDS,
        })
      const auth = await credentials.featureHeaders(Voice.keyID(provider), provider === "deepgram" ? "Token" : "Bearer")
      if (!auth.ok) {
        if (auth.problem === "not_found")
          return context.error("voice_unavailable", "no voice key for this service", {
            reason: "key_missing",
            provider,
          })
        log.warn("voice_key_unusable", { provider, problem: auth.problem })
        return context.error("vault_unavailable", "the voice key cannot be read", {})
      }
      const service = Voice.SERVICES[provider]
      const language = input.language ?? settings.language
      const started = deps.clock.now()
      const exit = await Effect.runPromiseExit(
        // Suspended, so a request the route cannot build fails as `voice_failed` instead of throwing out of the handler.
        Effect.suspend(() =>
          Transcription.generate(
            request({
              provider,
              model: service.model,
              headers: auth.headers,
              baseURL: provider === "deepgram" ? deps.endpoints.url.deepgram : deps.endpoints.url.openai,
              audio: Media.bytes(audio.bytes, input.mediaType),
              language: language === "auto" ? undefined : language,
              hint: input.hint?.trim() || undefined,
            }),
          ),
        ).pipe(
          Effect.timeout(options.timeoutMs ?? TIMEOUT_MS),
          Effect.provide(TranscriptionClient.layer),
          Effect.provide(RequestExecutor.fetchLayer),
        ),
        { signal: context.signal },
      )
      const ms = deps.clock.now() - started
      if (Exit.isFailure(exit)) {
        const failure = classify(exit.cause)
        log.warn("voice_transcribe_failed", { provider, bytes: audio.bytes.byteLength, ms, ...failure })
        return context.error("voice_failed", "the recognition service failed", { provider, ...failure })
      }
      const response = exit.value
      const usage = response.usage?.type === "seconds" ? response.usage.seconds : undefined
      const seconds = response.durationSeconds ?? usage ?? (input.durationMs ?? 0) / 1000
      await file
        .update((current) => ({
          ...current,
          usage: Voice.addUsage(current.usage, { at: deps.clock.now(), provider, seconds }),
        }))
        .catch((error: unknown) => log.warn("voice_usage_unwritable", { error }))
      log.info("voice_transcribed", { provider, bytes: audio.bytes.byteLength, seconds, ms })
      return {
        text: response.text.trim(),
        provider,
        model: service.model,
        seconds,
        ...(response.language ? { language: response.language } : {}),
      }
    },
  }
}

function request(input: {
  readonly provider: Voice.Provider
  readonly model: string
  readonly headers: Readonly<Record<string, string>>
  readonly baseURL: string
  readonly audio: Media.Asset
  readonly language: string | undefined
  readonly hint: string | undefined
}) {
  // The voice key's header is the whole auth: no env variable or config credential is read (`Auth.headers`).
  const deployment = { auth: Auth.headers(input.headers), baseURL: input.baseURL }
  if (input.provider === "deepgram")
    return Transcription.request({
      model: DeepgramTranscription.model({ ...deployment, id: input.model }),
      audio: input.audio,
      language: input.language,
      // Deepgram takes no prompt; key terms help English only (Nova-3 keyterm prompting).
      providerOptions: input.hint && input.language === "en" ? { keyterm: terms(input.hint) } : undefined,
    })
  return Transcription.request({
    model: OpenAITranscription.model({ ...deployment, id: input.model }),
    audio: input.audio,
    language: input.language,
    prompt: input.hint,
  })
}

/** Up to 20 key terms of a hint (comma or line separated). */
function terms(hint: string) {
  return hint
    .split(/[,\n]/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 20)
}

function decodeAudio(
  value: string,
):
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "empty" | "encoding" | "too_large" } {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return { ok: false, reason: "encoding" }
  const bytes = Buffer.from(value, "base64")
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" }
  if (bytes.byteLength > Voice.MAX_AUDIO_BYTES) return { ok: false, reason: "too_large" }
  return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
}

/** The service's failure as `voice_failed` data. Never its message or body: only the kind and the HTTP status. */
function classify(cause: Cause.Cause<unknown>): {
  readonly reason: Voice.Failure
  readonly status?: number
  readonly retryable: boolean
} {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  // The caller went away (the RPC was aborted): the same recording can be sent again.
  if (error === undefined && Cause.hasInterrupts(cause)) return { reason: "network", retryable: true }
  if (Cause.isTimeoutError(error)) return { reason: "timeout", retryable: true }
  if (!(error instanceof AIError)) return { reason: "provider", retryable: true }
  const reason = error.reason
  const status = "http" in reason ? reason.http?.status : undefined
  const withStatus = status === undefined ? {} : { status }
  switch (reason._tag) {
    case "Authentication":
      return { reason: "auth", retryable: false, ...withStatus }
    case "RateLimit":
      return { reason: "rate_limited", retryable: true, ...withStatus }
    case "QuotaExceeded":
      return { reason: "quota", retryable: false, ...withStatus }
    case "InvalidRequest":
    case "UnsupportedOperation":
    case "ContentPolicy":
      return { reason: "rejected", retryable: false, ...withStatus }
    case "Transport":
      return { reason: "network", retryable: true, ...withStatus }
    case "Timeout":
      return { reason: "timeout", retryable: true, ...withStatus }
    default:
      return { reason: "provider", retryable: true, ...withStatus }
  }
}
