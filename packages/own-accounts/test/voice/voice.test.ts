// Voice input (02 §3.9): settings and voice-only keys, recognition through upstream `@opencode/ai` Transcription
// against the fake services (`e2e-kit/fakes/transcription.ts`), the limits, the failure kinds, and the separation from
// model accounts: no fallback to an account's key (or a ChatGPT token), and a voice key never shows up as an account or
// in a model request. Every key here is fake.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Account, Kind, Voice } from "@own/protocol"
import { Schema } from "effect"
import { Modules } from "../../src/modules.js"
import { Register } from "../../src/rpc/register.js"
import { VoiceRpc } from "../../src/rpc/voice.js"
import { VoiceInput } from "../../src/voice/voice.js"
import { hashSecret } from "../e2e-kit/fakes/shared"
import { FAKE_TRANSCRIPT, startFakeTranscription } from "../e2e-kit/fakes/transcription"
import { failure, memoryStorage, registryWith, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const VOICE_OPENAI = "sk-voice-only-openai-fake-0000AAAA"
const VOICE_DEEPGRAM = "dg-voice-only-fake-0000BBBB"
const ACCOUNT_KEY = "sk-model-account-fake-0000CCCC"
/** A made-up recording: an Ogg header and 3000 bytes. Only its size matters to the fakes. */
const RECORDING = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...Array.from({ length: 3000 }, (_, index) => index % 251)])
const AUDIO = Buffer.from(RECORDING).toString("base64")

async function setup(options: { readonly timeoutMs?: number; readonly accounts?: boolean } = {}) {
  const fake = startFakeTranscription()
  const logs: string[] = []
  const storage = memoryStorage().storage
  const t = await testDeps({
    control: true,
    logs,
    options: { endpoints: { openai: fake.openaiBaseURL, deepgram: fake.deepgramBaseURL } },
    ctx: { provider: { reload: async () => {}, list: async () => [] }, storage },
  })
  const voice = options.timeoutMs ? VoiceInput.create(t.deps, { timeoutMs: options.timeoutMs }) : undefined
  const rpc = VoiceRpc.handlers(t.deps)
  const handlers = voice ? { ...rpc, "voice.transcribe": voice.transcribe } : rpc
  return {
    t,
    fake,
    logs,
    get: () => handlers["voice.get"]({}, rpcContext<"voice.get">()),
    set: (input: Voice.SetInput) => handlers["voice.set"](input, rpcContext<"voice.set">()),
    key: (input: Voice.KeyInput) => handlers["voice.key.set"](input, rpcContext<"voice.key.set">()),
    transcribe: (input: Partial<Voice.TranscribeInput> = {}) =>
      handlers["voice.transcribe"](
        { audio: AUDIO, mediaType: "audio/webm", ...input },
        rpcContext<"voice.transcribe">(),
      ),
    async [Symbol.asyncDispose]() {
      await fake.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

function view(value: unknown): Voice.View {
  if (failure(value)) throw new Error(`expected a view, got ${JSON.stringify(value)}`)
  return value as Voice.View
}

function result(value: unknown): Voice.TranscribeResult {
  if (failure(value)) throw new Error(`expected a transcript, got ${JSON.stringify(value)}`)
  return value as Voice.TranscribeResult
}

/** Every file under `root` as text, to prove a value was never written anywhere. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), "utf8")),
  )
}

describe("voice settings (02 §3.9)", () => {
  test("off by default, OpenAI gpt-transcribe in Korean, no keys", async () => {
    await using s = await setup()
    const current = view(await s.get())
    expect(current).toEqual({
      enabled: false,
      provider: "openai",
      language: "ko",
      keys: [
        { provider: "openai", configured: false },
        { provider: "deepgram", configured: false },
      ],
      model: "gpt-transcribe",
      usage: [],
      limits: { maxSeconds: 180, maxAudioBytes: 4 * 1024 * 1024, maxHintChars: 600 },
      vault: "ok",
    })
  })

  test("set changes only the given fields and voice.json holds no secret", async () => {
    await using s = await setup()
    expect(view(await s.set({ enabled: true })).enabled).toBe(true)
    const next = view(await s.set({ provider: "deepgram", language: "auto" }))
    expect([next.enabled, next.provider, next.language, next.model]).toEqual([true, "deepgram", "auto", "nova-3"])
    await s.key({ provider: "deepgram", key: VOICE_DEEPGRAM })
    const stored = JSON.parse(await fs.readFile(path.join(s.t.home, "voice.json"), "utf8"))
    expect(stored).toEqual({ schemaVersion: 1, enabled: true, provider: "deepgram", language: "auto", usage: [] })
  })

  test("a voice key goes into the vault only: the view has a hint, never the key; null removes it", async () => {
    await using s = await setup()
    const stored = view(await s.key({ provider: "openai", key: `  ${VOICE_OPENAI}  ` }))
    expect(stored.keys).toEqual([
      { provider: "openai", configured: true, keyHint: "sk-…AAAA" },
      { provider: "deepgram", configured: false },
    ])
    expect(JSON.stringify(stored)).not.toContain(VOICE_OPENAI)
    expect(JSON.stringify(stored)).not.toContain("0000AAAA")
    for (const text of [...(await filesUnder(s.t.home)), ...s.logs]) expect(text).not.toContain(VOICE_OPENAI)
    const removed = view(await s.key({ provider: "openai", key: null }))
    expect(removed.keys[0]).toEqual({ provider: "openai", configured: false })
    expect(s.logs.some((line) => line.includes("voice_key_set"))).toBe(true)
  })

  test("a key with spaces or control characters is refused", async () => {
    await using s = await setup()
    for (const key of ["sk-abc def", "sk-abc\u0000", "   "])
      expect(failure(await s.key({ provider: "openai", key }))?.type).toBe("voice_key_invalid")
    expect(view(await s.get()).keys[0]?.configured).toBe(false)
  })
})

describe("voice.transcribe (02 §3.9)", () => {
  test("nothing is sent while voice input is off or the service has no voice key", async () => {
    await using s = await setup()
    expect(failure(await s.transcribe())).toMatchObject({
      type: "voice_unavailable",
      data: { reason: "disabled", provider: "openai" },
    })
    await s.set({ enabled: true })
    expect(failure(await s.transcribe())).toMatchObject({
      type: "voice_unavailable",
      data: { reason: "key_missing", provider: "openai" },
    })
    await s.set({ provider: "deepgram" })
    await s.key({ provider: "openai", key: VOICE_OPENAI })
    // The OpenAI key does not stand in for Deepgram's.
    expect(failure(await s.transcribe())).toMatchObject({ data: { reason: "key_missing", provider: "deepgram" } })
    expect(s.fake.calls).toEqual([])
  })

  test("OpenAI: gpt-transcribe with the voice key, the language and the hint; the minutes are counted", async () => {
    await using s = await setup()
    await s.set({ enabled: true })
    await s.key({ provider: "openai", key: VOICE_OPENAI })
    const first = result(await s.transcribe({ durationMs: 2_400, hint: " own-web, Composer, voice.transcribe " }))
    expect(first).toEqual({ text: FAKE_TRANSCRIPT, provider: "openai", model: "gpt-transcribe", seconds: 2.5 })
    const call = s.fake.calls[0]!
    expect(call).toMatchObject({
      service: "openai",
      path: "/v1/audio/transcriptions",
      authorization: hashSecret(`Bearer ${VOICE_OPENAI}`),
      audioBytes: RECORDING.byteLength,
    })
    // gpt-transcribe takes `languages[]`, not `language` (upstream openai-transcription).
    expect(call.fields).toEqual({
      model: ["gpt-transcribe"],
      "languages[]": ["ko"],
      prompt: ["own-web, Composer, voice.transcribe"],
    })
    s.fake.enqueue({ type: "text", text: "  두 번째  " })
    expect(result(await s.transcribe({ language: "auto" })).text).toBe("두 번째")
    // `auto`: the service detects the language. Without a duration from the service, the recorder's length counts.
    expect(s.fake.calls[1]?.fields).toEqual({ model: ["gpt-transcribe"] })
    expect(view(await s.get()).usage).toEqual([
      { month: Voice.monthOf(s.t.clock.now()), provider: "openai", seconds: 2.5, requests: 2 },
    ])
  })

  test("Deepgram: nova-3 with Token auth and the raw recording; English hints become key terms", async () => {
    await using s = await setup()
    await s.set({ enabled: true, provider: "deepgram" })
    await s.key({ provider: "deepgram", key: VOICE_DEEPGRAM })
    s.fake.enqueue({ type: "text", text: "배포 해 줘", seconds: 1.75, language: "ko" })
    expect(result(await s.transcribe({ hint: "own-web, Composer" }))).toEqual({
      text: "배포 해 줘",
      provider: "deepgram",
      model: "nova-3",
      seconds: 1.75,
      language: "ko",
    })
    expect(s.fake.calls[0]).toMatchObject({
      service: "deepgram",
      path: "/v1/listen",
      authorization: hashSecret(`Token ${VOICE_DEEPGRAM}`),
      contentType: "audio/webm",
      audioBytes: RECORDING.byteLength,
    })
    expect(s.fake.calls[0]?.query).toMatchObject({ model: ["nova-3"], language: ["ko"] })
    expect(s.fake.calls[0]?.query.keyterm).toBeUndefined()
    await s.transcribe({ language: "en", hint: "own-web, Composer" })
    expect(s.fake.calls[1]?.query).toMatchObject({ language: ["en"], keyterm: ["own-web", "Composer"] })
    expect(view(await s.get()).usage[0]).toMatchObject({ provider: "deepgram", requests: 2 })
  })

  test("limits: an empty, non-base64, too large or too long recording is refused before any request", async () => {
    await using s = await setup()
    await s.set({ enabled: true })
    await s.key({ provider: "openai", key: VOICE_OPENAI })
    expect(failure(await s.transcribe({ audio: "" }))).toMatchObject({ data: { reason: "empty" } })
    expect(failure(await s.transcribe({ audio: "!!!!" }))).toMatchObject({ data: { reason: "encoding" } })
    const large = Buffer.alloc(Voice.MAX_AUDIO_BYTES + 1, 1).toString("base64")
    expect(failure(await s.transcribe({ audio: large }))).toMatchObject({
      type: "voice_audio_invalid",
      data: { reason: "too_large", max: Voice.MAX_AUDIO_BYTES },
    })
    expect(failure(await s.transcribe({ durationMs: Voice.MAX_SECONDS * 1000 + 1 }))).toMatchObject({
      data: { reason: "too_long", max: Voice.MAX_SECONDS },
    })
    expect(s.fake.calls).toEqual([])
    // The schema the host checks refuses an oversized body or hint before the handler runs.
    const input = Schema.decodeUnknownOption(Voice.TranscribeInput)
    expect(input({ audio: "A".repeat(Voice.MAX_AUDIO_BASE64 + 4), mediaType: "audio/webm" })._tag).toBe("None")
    expect(input({ audio: AUDIO, mediaType: "audio/webm", hint: "x".repeat(601) })._tag).toBe("None")
    expect(input({ audio: AUDIO, mediaType: "video/webm" })._tag).toBe("None")
  })

  test("service failures keep their kind and status, never the service's text; nothing is counted", async () => {
    await using s = await setup({ timeoutMs: 300 })
    await s.set({ enabled: true })
    await s.key({ provider: "openai", key: VOICE_OPENAI })
    s.fake.enqueue(
      { type: "status", status: 401, body: '{"error":{"message":"Incorrect API key provided: sk-voi****AAAA"}}' },
      { type: "status", status: 429 },
      { type: "status", status: 500 },
      { type: "delay", ms: 2_000 },
    )
    const kinds = []
    for (let index = 0; index < 4; index++) kinds.push(failure(await s.transcribe()))
    expect(kinds.map((item) => [item?.type, item?.data])).toEqual([
      ["voice_failed", { provider: "openai", reason: "auth", status: 401, retryable: false }],
      ["voice_failed", { provider: "openai", reason: "rate_limited", status: 429, retryable: true }],
      ["voice_failed", { provider: "openai", reason: "provider", status: 500, retryable: true }],
      ["voice_failed", { provider: "openai", reason: "timeout", retryable: true }],
    ])
    expect(JSON.stringify(kinds)).not.toContain("Incorrect API key")
    expect(view(await s.get()).usage).toEqual([])
  })

  test("the recording and the text are never logged or written", async () => {
    await using s = await setup()
    await s.set({ enabled: true })
    await s.key({ provider: "openai", key: VOICE_OPENAI })
    result(await s.transcribe({ hint: "secret-project-name" }))
    const written = [...(await filesUnder(s.t.home)), ...s.logs]
    for (const text of written) {
      expect(text).not.toContain(FAKE_TRANSCRIPT)
      expect(text).not.toContain(AUDIO.slice(0, 64))
      expect(text).not.toContain("secret-project-name")
      expect(text).not.toContain(VOICE_OPENAI)
    }
    expect(s.logs.some((line) => line.includes("voice_transcribed"))).toBe(true)
  })

  test("a remote service refuses every voice method: the keys and the minutes are this PC's", () => {
    for (const method of ["voice.get", "voice.set", "voice.key.set", "voice.transcribe"] as const)
      expect(Register.REMOTE_MANAGED).toContain(method)
  })
})

describe("voice keys and model accounts never mix (02 §3.9)", () => {
  async function withAccounts() {
    const s = await setup()
    const registry = await registryWith([
      { kind: "oai", label: "OpenAI 업무", slug: "oaitest" },
      { kind: "codex", label: "ChatGPT", slug: "cdxtest", identity: { chatgptAccountId: "chatgpt-fake" } },
    ])
    await s.t.deps.runtime.registry.write(registry)
    const credentials = s.t.deps.runtime.credentials
    expect((await credentials.store("acc_oaitest", { type: "key", key: ACCOUNT_KEY })).ok).toBe(true)
    expect(
      (
        await credentials.store("acc_cdxtest", {
          type: "oauth",
          access: "chatgpt-access-fake",
          refresh: "chatgpt-refresh-fake",
          expiresAt: s.t.clock.now() + 3_600_000,
        })
      ).ok,
    ).toBe(true)
    return Object.assign(s, { registry })
  }

  test("no voice key means no request, even with an OpenAI API account and a ChatGPT account in the vault", async () => {
    await using s = await withAccounts()
    await s.set({ enabled: true })
    expect(failure(await s.transcribe())).toMatchObject({ data: { reason: "key_missing", provider: "openai" } })
    expect(s.fake.calls).toEqual([])
    await s.key({ provider: "openai", key: VOICE_OPENAI })
    result(await s.transcribe())
    expect(s.fake.calls.map((call) => call.authorization)).toEqual([hashSecret(`Bearer ${VOICE_OPENAI}`)])
    for (const secret of [`Bearer ${ACCOUNT_KEY}`, "Bearer chatgpt-access-fake"])
      expect(s.fake.calls[0]?.authorization).not.toBe(hashSecret(secret))
  })

  test("a voice key is never an account, a slot or a model request's credential", async () => {
    await using s = await withAccounts()
    const registry = s.registry
    await s.key({ provider: "openai", key: VOICE_OPENAI })
    await s.key({ provider: "deepgram", key: VOICE_DEEPGRAM })
    // Vault ids of voice keys can never be account ids or slot ids.
    for (const provider of Voice.Provider.literals) {
      expect(Schema.is(Account.ID)(Voice.keyID(provider))).toBe(false)
      expect(Kind.ProviderID.parse(Voice.keyID(provider))).toBeUndefined()
    }
    // accounts.list: the same two accounts, nothing about voice.
    const slots = Modules.create(s.t.deps).slots
    await slots.start()
    try {
      const listed = await slots.list({}, rpcContext<"accounts.list">())
      if (!("accounts" in listed)) throw new Error("accounts.list failed")
      expect(listed.accounts.map((account) => account.id)).toEqual(registry.accounts.map((account) => account.id))
      expect(JSON.stringify(listed)).not.toMatch(/voice|AAAA|BBBB/)
    } finally {
      await slots.stop()
    }
    expect((await s.t.deps.runtime.registry.read()).accounts).toEqual(registry.accounts)
    // Model requests: each account still gets its own credential, never a voice key.
    const credentials = s.t.deps.runtime.credentials
    const oai = registry.accounts.find((account) => account.kind === "oai")!
    const auth = await credentials.headersFor({ account: oai, sessionID: "ses_voice" })
    expect(auth.ok && auth.headers.authorization).toBe(`Bearer ${ACCOUNT_KEY}`)
    const codex = registry.accounts.find((account) => account.kind === "codex")!
    const subscription = await credentials.headersFor({ account: codex, sessionID: "ses_voice" })
    expect(subscription.ok && subscription.headers.authorization).toBe("Bearer chatgpt-access-fake")
  })
})
