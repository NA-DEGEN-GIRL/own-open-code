// Voice input in own-web (03 §4.6 받아쓰기, §5.7.4, 02 §3.9): insertion at the cursor with spacing, IME-composition
// deferral, the dictation state machine with a fake recorder and service (permission denied, retry with the same
// recording, cancel, the length limit), the service call (size limit before sending, error mapping), the hint, the
// settings store, the strings, and the wiring into the composer, both note editors and the settings page (Solid
// components do not render under `bun test`, so the wiring is checked in the sources). Everything here is fake.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { Voice } from "@own/protocol/voice"
import { createRoot } from "solid-js"
import { OwnRpcError, type OwnRpc } from "@/data/rpc"
import { DEFAULT_KEYMAP } from "@/keyboard/keymap"
import { auditKeymap } from "@/palette/audit"
import { createDictation, DictationFailure, failureOf, toBase64, transcribeOn, type DictationDeps } from "./controller"
import { buildHint, namesOf, technical } from "./hint"
import { createInserter, insertText, joinAt } from "./insert"
import { mediaTypeOf, problemOf, RecorderError, type Recorder, type Recording } from "./recorder"
import { minutes } from "./settings"
import { loadVoice, resetVoiceStore, voiceReady, voiceUnsupported, voiceView } from "./store"
import { voiceSettingsEn, voiceSettingsKo, voiceSettingsText } from "./settings-strings"
import { voiceEn, voiceKo } from "./strings"

const here = import.meta.dir
const read = (file: string) => Bun.file(path.join(here, file)).text()
const frame = () => new Promise((resolve) => setTimeout(resolve, 80))

function textarea(value = "", caret = value.length) {
  const element = document.createElement("textarea")
  document.body.append(element)
  element.value = value
  element.setSelectionRange(caret, caret)
  return element
}

function recording(size = 12): Recording {
  return {
    blob: new Blob([new Uint8Array(size).fill(7)], { type: "audio/webm" }),
    mediaType: "audio/webm",
    durationMs: 2_000,
  }
}

function view(extra: Partial<Voice.View> = {}): Voice.View {
  return {
    enabled: true,
    provider: "openai",
    language: "ko",
    keys: [
      { provider: "openai", configured: true, keyHint: "sk-…AAAA" },
      { provider: "deepgram", configured: false },
    ],
    model: "gpt-transcribe",
    usage: [],
    limits: { maxSeconds: 180, maxAudioBytes: 4 * 1024 * 1024, maxHintChars: 600 },
    vault: "ok",
    ...extra,
  }
}

function fakeRpc(input: {
  readonly answer?: (method: string, payload: unknown) => unknown
  readonly scopes?: string[]
}) {
  const calls: { method: string; payload: unknown; signal?: AbortSignal }[] = []
  const scopes = new Set(input.scopes ?? ["read", "prompt", "switch", "admin", "local"])
  const scopeOf: Record<string, string> = {
    "voice.get": "read",
    "voice.transcribe": "prompt",
    "voice.key.set": "local",
  }
  const rpc = {
    calls,
    allowed: (method: string) => scopes.has(scopeOf[method] ?? "read"),
    scope: (method: string) => scopeOf[method] ?? "read",
    can: (scope: string) => scopes.has(scope),
    call: async (method: string, payload: unknown, options?: { signal?: AbortSignal }) => {
      calls.push({ method, payload, signal: options?.signal })
      return input.answer?.(method, payload)
    },
  }
  // SAFETY: the code under test uses `call` and `allowed` with the voice methods only.
  return rpc as unknown as OwnRpc & { readonly calls: typeof calls }
}

/** A dictation over a fake recorder; `stop` resolves with `made`, `transcribe` with the queued answers. */
function rig(input: { readonly start?: DictationDeps["start"]; readonly answers?: Array<string | Error> } = {}) {
  const answers = [...(input.answers ?? ["  안녕하세요 Composer  "])]
  const log: string[] = []
  const inserted: string[] = []
  const sent: Recording[] = []
  const signals: AbortSignal[] = []
  const made = recording()
  let limit: (() => void) | undefined
  const recorder: Recorder = {
    stop: async () => {
      log.push("stop")
      return made
    },
    cancel: () => void log.push("cancel"),
  }
  let insertResult: "inserted" | "deferred" = "inserted"
  const dictation = createRoot(() =>
    createDictation({
      start:
        input.start ??
        (async (options) => {
          log.push("start")
          limit = options.onLimit
          return recorder
        }),
      transcribe: async (value, signal) => {
        sent.push(value)
        signals.push(signal)
        const answer = answers.shift() ?? ""
        if (answer instanceof Error) throw answer
        return answer
      },
      insert: (text) => {
        inserted.push(text)
        return insertResult
      },
      maxMs: () => 180_000,
    }),
  )
  return {
    dictation,
    log,
    inserted,
    sent,
    signals,
    made,
    limit: () => limit?.(),
    deferNext: () => {
      insertResult = "deferred"
    },
  }
}

describe("insertion at the cursor (03 §4.6)", () => {
  test("spaces only where the transcript would run into a word", () => {
    expect(joinAt("", 0, 0, "안녕")).toEqual({ value: "안녕", inserted: "안녕", caret: 2 })
    expect(joinAt("앞말", 2, 2, "뒤말")).toEqual({ value: "앞말 뒤말", inserted: " 뒤말", caret: 5 })
    expect(joinAt("앞 뒤", 1, 1, "가운데")).toEqual({ value: "앞 가운데 뒤", inserted: " 가운데", caret: 5 })
    expect(joinAt("앞 뒤", 2, 2, "가운데")).toEqual({ value: "앞 가운데 뒤", inserted: "가운데 ", caret: 6 })
    expect(joinAt("abc", 3, 3, ", 그리고")).toMatchObject({ value: "abc, 그리고" })
    // A selection is replaced.
    expect(joinAt("고칠 부분 끝", 3, 5, "새말")).toMatchObject({ value: "고칠 새말 끝" })
  })

  test("the field gets the text at its cursor and an input event, like typing", () => {
    const element = textarea("첫 줄 끝", 4)
    const seen: string[] = []
    element.addEventListener("input", (event) => seen.push((event as InputEvent).data ?? ""))
    insertText(element, "중간")
    expect(element.value).toBe("첫 줄 중간 끝")
    expect(element.selectionStart).toBe(7)
    expect(seen).toEqual(["중간 "])
    element.remove()
  })

  test("during an IME composition the text waits for compositionend, then goes in on the next frame", async () => {
    const element = textarea("한글 입력", 5)
    const inserter = createInserter(() => element)
    inserter.watch()
    element.dispatchEvent(new CompositionEvent("compositionstart"))
    expect(inserter.insert("받아쓰기")).toBe("deferred")
    expect(element.value).toBe("한글 입력")
    element.value = "한글 입력중"
    element.setSelectionRange(6, 6)
    element.dispatchEvent(new CompositionEvent("compositionend"))
    expect(element.value).toBe("한글 입력중")
    await frame()
    expect(element.value).toBe("한글 입력중 받아쓰기")
    expect(inserter.insert("또")).toBe("inserted")
    inserter.dispose()
    expect(createInserter(() => undefined).insert("x")).toBe("no_target")
    element.remove()
  })
})

describe("the dictation state machine", () => {
  test("record → done → the trimmed transcript goes in; never sent anywhere else", async () => {
    const r = rig()
    await r.dictation.start()
    expect(r.dictation.phase().name).toBe("recording")
    await r.dictation.done()
    expect(r.dictation.phase()).toEqual({ name: "idle" })
    expect(r.inserted).toEqual(["안녕하세요 Composer"])
    expect(r.sent).toEqual([r.made])
    expect(r.dictation.outcome()).toBe("inserted")
    expect(r.log).toEqual(["start", "stop"])
  })

  test("permission denied: the reason, and retry asks for the microphone again", async () => {
    let tries = 0
    const r = rig({
      start: async () => {
        tries++
        throw new RecorderError("denied")
      },
    })
    await r.dictation.start()
    expect(r.dictation.phase()).toEqual({ name: "error", problem: "denied", params: {}, retry: "record" })
    r.dictation.retry()
    await frame()
    expect(tries).toBe(2)
    expect(r.sent).toEqual([])
  })

  test("a failed recognition keeps the recording; retry sends the same recording again", async () => {
    const r = rig({ answers: [new DictationFailure("rate_limited"), "두 번째에 됨"] })
    await r.dictation.start()
    await r.dictation.done()
    expect(r.dictation.phase()).toEqual({ name: "error", problem: "rate_limited", params: {}, retry: "resend" })
    expect(r.dictation.holding()).toBe(true)
    r.dictation.retry()
    await frame()
    expect(r.sent).toEqual([r.made, r.made])
    expect(r.inserted).toEqual(["두 번째에 됨"])
    expect(r.dictation.holding()).toBe(false)
  })

  test("cancel stops the recorder, aborts the request and drops a late answer", async () => {
    const recordingRig = rig()
    await recordingRig.dictation.start()
    recordingRig.dictation.cancel()
    expect(recordingRig.log).toEqual(["start", "cancel"])
    expect(recordingRig.sent).toEqual([])

    let finish: (value: string) => void = () => {}
    const slow = createRoot(() =>
      createDictation({
        start: async () => ({ stop: async () => recording(), cancel: () => {} }),
        transcribe: (_value, signal) =>
          new Promise<string>((resolve) => {
            finish = resolve
            signal.addEventListener("abort", () => {})
          }),
        insert: () => {
          throw new Error("a cancelled dictation must not insert")
        },
        maxMs: () => 1_000,
      }),
    )
    await slow.start()
    const done = slow.done()
    await frame()
    expect(slow.phase().name).toBe("transcribing")
    slow.cancel()
    finish("늦은 답")
    await done
    expect(slow.phase()).toEqual({ name: "idle" })
    expect(slow.holding()).toBe(false)
  })

  test("the length limit finishes the recording by itself; nothing heard inserts nothing", async () => {
    const r = rig({ answers: ["   "] })
    await r.dictation.start()
    r.limit()
    await frame()
    expect(r.log).toEqual(["start", "stop"])
    expect(r.inserted).toEqual([])
    expect(r.dictation.outcome()).toBe("nothing")
  })

  test("a transcript that waits for the IME says so", async () => {
    const r = rig()
    r.deferNext()
    await r.dictation.start()
    await r.dictation.done()
    expect(r.dictation.outcome()).toBe("deferred")
  })
})

describe("the service call", () => {
  test("sends base64 audio, the type, the measured length and the hint to voice.transcribe", async () => {
    const rpc = fakeRpc({ answer: () => ({ text: "결과", provider: "openai", model: "gpt-transcribe", seconds: 2 }) })
    const value = recording(5)
    const text = await transcribeOn(rpc, value, {
      maxBytes: 100,
      hint: " own-web ",
      signal: new AbortController().signal,
    })
    expect(text).toBe("결과")
    expect(rpc.calls[0]).toMatchObject({
      method: "voice.transcribe",
      payload: { audio: btoa("\x07\x07\x07\x07\x07"), mediaType: "audio/webm", durationMs: 2_000, hint: "own-web" },
    })
    expect(rpc.calls[0]?.signal).toBeDefined()
  })

  test("a recording over the size limit fails before anything is sent", async () => {
    const rpc = fakeRpc({})
    const failure = await transcribeOn(rpc, recording(101), {
      maxBytes: 100,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ problem: "too_large", params: { max: 100 } })
    expect(rpc.calls).toEqual([])
  })

  test("service errors become reasons the user can act on", () => {
    const problem = (type: string, data?: unknown) => failureOf(new OwnRpcError(type, type, data)).problem
    expect(problem("voice_unavailable", { reason: "disabled", provider: "openai" })).toBe("disabled")
    expect(problem("voice_unavailable", { reason: "key_missing", provider: "openai" })).toBe("key_missing")
    expect(problem("voice_audio_invalid", { reason: "too_long", max: 180 })).toBe("too_long")
    expect(failureOf(new OwnRpcError("voice_audio_invalid", "x", { reason: "too_long", max: 180 })).params).toEqual({
      max: 180,
    })
    for (const reason of ["auth", "rate_limited", "quota", "rejected", "network", "timeout", "provider"] as const)
      expect(problem("voice_failed", { provider: "openai", reason, retryable: true })).toBe(reason)
    expect(problem("voice_failed", { reason: "unknown" })).toBe("provider")
    expect(problem("vault_unavailable")).toBe("vault")
    expect(problem("remote_managed")).toBe("remote")
    expect(problem("own.scope_denied")).toBe("scope")
    const offline = new Error("not connected")
    offline.name = "NotConnectedError"
    expect(failureOf(offline).problem).toBe("offline")
    expect(failureOf(new TypeError("fetch failed")).problem).toBe("network")
  })

  test("base64 of a large blob in chunks", async () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 256)
    expect(await toBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString("base64"))
  })

  test("microphone errors and recorder types", () => {
    expect(problemOf({ name: "NotAllowedError" })).toBe("denied")
    expect(problemOf({ name: "SecurityError" })).toBe("denied")
    expect(problemOf({ name: "NotFoundError" })).toBe("no_device")
    expect(problemOf({ name: "NotReadableError" })).toBe("busy")
    expect(problemOf(new Error("x"))).toBe("failed")
    expect(mediaTypeOf("audio/webm;codecs=opus")).toBe("audio/webm")
    expect(mediaTypeOf("audio/ogg; codecs=opus")).toBe("audio/ogg")
    expect(mediaTypeOf("audio/mp4")).toBe("audio/mp4")
    expect(mediaTypeOf("video/mp4")).toBeUndefined()
  })
})

describe("the hint", () => {
  test("file names first, then the most frequent technical identifiers; no Korean, no plain words, cut at terms", () => {
    const hint = buildHint({
      names: ["packages", "own", ".git", "README.md", "package.json"],
      texts: [
        "own-web의 Composer에서 voice.transcribe를 부르고 Composer 버튼을 고칩니다",
        "createDictation, createDictation, MAX_SECONDS 그리고 the plain words",
      ],
    })
    expect(hint.split(", ")).toEqual([
      "packages",
      "own",
      "README.md",
      "package.json",
      "createDictation",
      "own-web",
      "voice.transcribe",
      "MAX_SECONDS",
    ])
    expect(technical("Composer")).toBe(false)
    expect(technical("own-web")).toBe(true)
    expect(buildHint({ names: ["a".repeat(30), "b".repeat(30)], texts: [], max: 40 })).toBe("a".repeat(30))
    expect(buildHint({ names: [], texts: ["x".repeat(10)] })).toBe("")
    expect(namesOf([{ path: "D:\\work\\repo\\src" }, { path: "/home/me/repo/README.md" }, { path: "" }])).toEqual([
      "src",
      "README.md",
    ])
  })
})

describe("the settings store", () => {
  test("ready only when on, the selected service has its key and the connection may prompt", () => {
    const rpc = fakeRpc({})
    expect(voiceReady(view(), rpc)).toBe(true)
    expect(voiceReady(view({ enabled: false }), rpc)).toBe(false)
    expect(voiceReady(view({ provider: "deepgram" }), rpc)).toBe(false)
    expect(voiceReady(view(), fakeRpc({ scopes: ["read"] }))).toBe(false)
    expect(voiceReady(undefined, rpc)).toBe(false)
  })

  test("loads once per 30 s unless forced; an older service without voice is reported", async () => {
    resetVoiceStore()
    const rpc = fakeRpc({ answer: () => view() })
    await loadVoice(rpc)
    await loadVoice(rpc)
    expect(rpc.calls.map((call) => call.method)).toEqual(["voice.get"])
    expect(voiceView()?.model).toBe("gpt-transcribe")
    await loadVoice(rpc, { force: true })
    expect(rpc.calls).toHaveLength(2)
    resetVoiceStore()
    const old = fakeRpc({
      answer: () => {
        throw new OwnRpcError("rpc.method_not_found", "no voice")
      },
    })
    await loadVoice(old)
    expect(voiceUnsupported()).toBe(true)
    expect(voiceView()).toBeUndefined()
    resetVoiceStore()
  })

  test("minutes with one decimal", () => {
    expect(minutes(0)).toBe("0")
    expect(minutes(27)).toBe("0.5")
    expect(minutes(750)).toBe("12.5")
  })
})

describe("strings", () => {
  test("every problem has a message in both languages", () => {
    const problems = [
      "denied",
      "no_device",
      "busy",
      "insecure",
      "unsupported",
      "failed",
      "empty",
      "too_large",
      "too_long",
      "encoding",
      "disabled",
      "key_missing",
      "auth",
      "rate_limited",
      "quota",
      "rejected",
      "network",
      "timeout",
      "provider",
      "vault",
      "scope",
      "offline",
      "remote",
    ]
    for (const problem of problems) {
      expect(Object.hasOwn(voiceKo, `own.voice.problem.${problem}`)).toBe(true)
      expect(Object.hasOwn(voiceEn, `own.voice.problem.${problem}`)).toBe(true)
    }
    expect(Object.keys(voiceEn).filter((key) => !Object.hasOwn(voiceKo, key))).toEqual([])
    expect(Object.keys(voiceSettingsEn).filter((key) => !Object.hasOwn(voiceSettingsKo, key))).toEqual([])
    // The control's chunk carries no settings text.
    expect(Object.keys(voiceKo).filter((key) => key.startsWith("own.voice.set."))).toEqual([])
    expect(voiceSettingsText.text("ko", "own.voice.set.keyRemoveConfirm", { name: "OpenAI API 키" })).toStartWith(
      "OpenAI API 키를 지울까요?",
    )
  })
})

describe("wiring (sources)", () => {
  test("the composer and both note editors mount the same control on their field", async () => {
    const composer = await read("../composer/index.tsx")
    expect(composer).toContain("<DictationButton")
    expect(composer).toContain("target={element}")
    expect(composer).toContain('shortcut="default"')
    expect(composer).toContain("projectHint({")
    const panel = await read("../notes/panel.tsx")
    expect(panel).toContain("<DictationButton target={() => area}")
    const workspace = await read("../notes/workspace.tsx")
    expect(workspace).toContain("<DictationButton target={() => area}")
    expect(workspace).toContain("ref={area}")
  })

  test("the control never sends a message and inserts through the IME-aware inserter", async () => {
    const button = await read("button.tsx")
    expect(button).toContain("inserter.insert(value)")
    expect(button).not.toMatch(/session\.prompt|\.send\(|sendNow/)
    expect(button).toContain('"voice.dictate"')
    expect(button).toContain("data.local().own.rpc")
  })

  test("settings: a lazy page; keys in password fields that are emptied before the request", async () => {
    const index = await read("../settings/index.tsx")
    expect(index).toContain('lazy(() => import("@/voice/settings"))')
    const settings = await read("settings.tsx")
    expect(settings).toContain('type="password"')
    const save = settings.slice(settings.indexOf("const send = async"))
    expect(save.indexOf('setKey("")')).toBeGreaterThan(-1)
    expect(save.indexOf('setKey("")')).toBeLessThan(save.indexOf('rpc\n      .call("voice.key.set"'))
    expect(settings).not.toMatch(/console\.(log|info|debug)/)
  })

  test("push to talk has a default chord the shortcut audit accepts", () => {
    expect(DEFAULT_KEYMAP["voice.dictate"]).toEqual({ chords: ["Mod+Alt+KeyV"], scope: "global" })
    const issues = auditKeymap(DEFAULT_KEYMAP, { mac: false }).issues.filter((issue) => issue.id === "voice.dictate")
    expect(issues).toEqual([])
  })
})
