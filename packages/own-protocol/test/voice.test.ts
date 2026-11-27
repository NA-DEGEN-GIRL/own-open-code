// Voice input contract (02 §3.9): the service table, the vault ids of voice keys (never account ids), the limits the
// host checks, `voice.json` and the usage rows.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Account, Kind, OwnAccounts, OwnError, Voice } from "../src/index.js"

describe("Voice", () => {
  test("OpenAI gpt-transcribe is the default service, Deepgram Nova-3 the option; both file recognition", () => {
    expect(Voice.SERVICES).toEqual({
      openai: { provider: "openai", model: "gpt-transcribe", mode: "file" },
      deepgram: { provider: "deepgram", model: "nova-3", mode: "file" },
    })
    expect(Voice.defaults).toEqual({ schemaVersion: 1, enabled: false, provider: "openai", language: "ko", usage: [] })
    expect(Voice.Language.literals).toEqual(["auto", "ko", "en"])
  })

  test("voice keys live under their own vault ids, which are never account or slot ids", () => {
    expect(Voice.Provider.literals.map(Voice.keyID)).toEqual(["voice-openai", "voice-deepgram"])
    for (const provider of Voice.Provider.literals) {
      expect(Schema.is(Account.ID)(Voice.keyID(provider))).toBe(false)
      expect(Kind.ProviderID.parse(Voice.keyID(provider))).toBeUndefined()
    }
  })

  test("the host refuses an oversized recording, hint or key before the handler runs", () => {
    const input = Schema.decodeUnknownOption(Voice.TranscribeInput)
    expect(input({ audio: "AAAA", mediaType: "audio/webm" })._tag).toBe("Some")
    expect(input({ audio: "", mediaType: "audio/webm" })._tag).toBe("None")
    expect(input({ audio: "A".repeat(Voice.MAX_AUDIO_BASE64 + 1), mediaType: "audio/webm" })._tag).toBe("None")
    expect(input({ audio: "AAAA", mediaType: "audio/webm", hint: "x".repeat(Voice.MAX_HINT_CHARS + 1) })._tag).toBe(
      "None",
    )
    for (const mediaType of Voice.MediaType.literals) expect(input({ audio: "AAAA", mediaType })._tag).toBe("Some")
    expect(input({ audio: "AAAA", mediaType: "video/mp4" })._tag).toBe("None")
    expect(Voice.MAX_AUDIO_BASE64).toBeGreaterThanOrEqual((Voice.MAX_AUDIO_BYTES * 4) / 3)
    const key = Schema.decodeUnknownOption(Voice.KeyInput)
    expect(key({ provider: "deepgram", key: null })._tag).toBe("Some")
    expect(key({ provider: "deepgram", key: "x".repeat(Voice.MAX_KEY_CHARS + 1) })._tag).toBe("None")
    expect(key({ provider: "soniox", key: "k" })._tag).toBe("None")
  })

  test("voice.json holds settings and minutes only", () => {
    const file = Schema.decodeUnknownOption(Voice.File)
    const usage = [{ month: "2026-10", provider: "openai", seconds: 12.5, requests: 3 }]
    expect(file({ ...Voice.defaults, usage })._tag).toBe("Some")
    expect(file({ ...Voice.defaults, usage: [{ ...usage[0], month: "2026-13" }] })._tag).toBe("None")
    expect(Object.keys(Voice.File.fields).sort()).toEqual(["enabled", "language", "provider", "schemaVersion", "usage"])
  })

  test("usage: one row per month and service, newest first, at most USAGE_MONTHS months per service", () => {
    const at = (iso: string) => Date.parse(iso)
    let usage: ReadonlyArray<Voice.Usage> = []
    usage = Voice.addUsage(usage, { at: at("2026-09-30T23:59:59Z"), provider: "openai", seconds: 10 })
    usage = Voice.addUsage(usage, { at: at("2026-10-01T00:00:01Z"), provider: "openai", seconds: 2.25 })
    usage = Voice.addUsage(usage, { at: at("2026-10-02T00:00:00Z"), provider: "openai", seconds: 1.5 })
    usage = Voice.addUsage(usage, { at: at("2026-10-03T00:00:00Z"), provider: "deepgram", seconds: -4 })
    expect(usage).toEqual([
      { month: "2026-10", provider: "openai", seconds: 3.75, requests: 2 },
      { month: "2026-10", provider: "deepgram", seconds: 0, requests: 1 },
      { month: "2026-09", provider: "openai", seconds: 10, requests: 1 },
    ])
    let long: ReadonlyArray<Voice.Usage> = []
    for (let month = 0; month < Voice.USAGE_MONTHS + 6; month++)
      long = Voice.addUsage(long, { at: Date.UTC(2024, month, 15), provider: "openai", seconds: 1 })
    expect(long).toHaveLength(Voice.USAGE_MONTHS)
    expect(long[0]?.month).toBe("2026-06")
    expect(long.at(-1)?.month).toBe("2024-07")
  })

  test("voice methods: their errors and the scopes of 02 §9.1", () => {
    const errors = (method: OwnAccounts.MethodName) =>
      Object.keys(OwnAccounts.Definition.methods[method].errors ?? {}).sort()
    expect(errors("voice.transcribe")).toEqual([
      "internal_error",
      "remote_managed",
      "vault_unavailable",
      "voice_audio_invalid",
      "voice_failed",
      "voice_unavailable",
    ])
    expect(errors("voice.key.set")).toEqual([
      "internal_error",
      "remote_managed",
      "vault_unavailable",
      "voice_key_invalid",
    ])
    expect(Object.keys(OwnError.data.voice_failed.fields).sort()).toEqual(["provider", "reason", "retryable", "status"])
    for (const method of ["voice.get", "voice.set", "voice.key.set", "voice.transcribe"] as const)
      expect(OwnAccounts.MethodLocation[method]).toBe("control")
  })
})
