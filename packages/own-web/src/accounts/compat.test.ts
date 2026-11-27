// Compat account card and form rules (07 §6.2 #2 overflow warning, #7 output caps, #8 Ollama running windows; 02 §3.3
// image input and tools).
import { describe, expect, test } from "bun:test"
import type { Account } from "@own/protocol"
import { compatEn, compatKo, compatText, type CompatKey } from "./compat-strings"
import {
  compatCapabilitiesText,
  compatFactsText,
  compatOverflowWarning,
  compatSettingsChange,
  compatWithoutTools,
  outputLimitOf,
  raiseHint,
  runningWindows,
  runningWindowText,
} from "./model"

const ko = (key: CompatKey, params?: Record<string, string | number>) => compatText.text("ko", key, params)
const en = (key: CompatKey, params?: Record<string, string | number>) => compatText.text("en", key, params)

function compat(view: Account.CompatView | undefined, kind: Account.View["kind"] = "compat") {
  return { kind, ...(view ? { compat: view } : {}) }
}

describe("overflow warning (07 §6.2 #2, PG9)", () => {
  test("every compat card warns until the server's overflow was seen classified (or its family PG9-verified)", () => {
    expect(compatOverflowWarning(compat(undefined))).toBe(true)
    expect(compatOverflowWarning(compat({ models: [] }))).toBe(true)
    expect(compatOverflowWarning(compat({ server: { family: "vllm", overflowClassified: false }, models: [] }))).toBe(
      true,
    )
    expect(compatOverflowWarning(compat({ server: { family: "vllm", overflowClassified: true }, models: [] }))).toBe(
      false,
    )
    expect(compatOverflowWarning(compat(undefined, "ds"))).toBe(false)
  })
})

describe("server and output caps (07 §6.2 #7)", () => {
  test("the 32k fallback reads 모름; server and typed values say where they came from", () => {
    const view = compat({
      server: { family: "ollama", overflowClassified: false },
      models: [
        { id: "qwen3:8b", output: { tokens: 16_384, source: "server" } },
        { id: "llama3", output: { tokens: 8_000, source: "user" } },
        { id: "mystery", output: { tokens: 32_000, source: "fallback" } },
        { id: "bare" },
      ],
    })
    expect(compatFactsText(ko, view)).toBe(
      "서버: Ollama · 출력 한도: qwen3:8b 16k(서버 값), llama3 8k(직접 입력), mystery 32k(모름)",
    )
    expect(compatFactsText(en, view)).toBe(
      "Server: Ollama · Output limit: qwen3:8b 16k (from the server), llama3 8k (entered), mystery 32k (unknown)",
    )
    expect(compatFactsText(ko, compat({ models: [{ id: "m", output: { tokens: 32_000, source: "fallback" } }] }))).toBe(
      "출력 한도: m 32k(모름)",
    )
    expect(compatFactsText(ko, compat({ server: { family: "other", overflowClassified: false }, models: [] }))).toBe(
      "서버: OpenAI 호환 서버",
    )
    expect(compatFactsText(ko, compat({ models: [{ id: "bare" }] }))).toBeUndefined()
    expect(compatFactsText(ko, compat(undefined))).toBeUndefined()
  })

  test("the add-account output cap is optional and must read as a token count", () => {
    expect(outputLimitOf("")).toEqual({ ok: true, value: undefined })
    expect(outputLimitOf("  ")).toEqual({ ok: true, value: undefined })
    expect(outputLimitOf("16k")).toEqual({ ok: true, value: 16_000 })
    expect(outputLimitOf("16,384")).toEqual({ ok: true, value: 16_384 })
    expect(outputLimitOf("0")).toEqual({ ok: false })
    expect(outputLimitOf("lots")).toEqual({ ok: false })
  })
})

describe("Ollama running windows (07 §6.2 #8)", () => {
  const view = compat({
    server: { family: "ollama", overflowClassified: false },
    models: [
      { id: "big", localWindow: { runtime: 65_536, needed: 27_000, status: "verified" } },
      { id: "small", localWindow: { runtime: 8_192, needed: 27_000, status: "unverified" } },
      { id: "cold", localWindow: { runtime: null, needed: 30_000, status: "unknown" } },
      { id: "no-window" },
    ],
  })

  test("each model's running window against what a request needs", () => {
    const windows = runningWindows(view)
    expect(windows.map((window) => window.model)).toEqual(["big", "small", "cold"])
    expect(windows.map((window) => runningWindowText(ko, window))).toEqual([
      "big 실행 창 66k · 요청에 필요 27k",
      "small 실행 창 8k · 요청에 필요 27k",
      "cold 실행 창 확인 안 됨 · 요청에 필요 30k",
    ])
  })

  test("how to raise it: to what the largest short model needs; nothing when every model fits", () => {
    expect(raiseHint(runningWindows(view))).toEqual({ needed: 30_000, unknown: true })
    expect(raiseHint(runningWindows(view).slice(0, 2))).toEqual({ needed: 27_000, unknown: false })
    expect(raiseHint(runningWindows(view).slice(0, 1))).toBeUndefined()
    expect(raiseHint([])).toBeUndefined()
    expect(ko("own.compat.raise", { needed: 27_000 })).toContain("OLLAMA_CONTEXT_LENGTH=27000")
    expect(ko("own.compat.raise", { needed: 27_000 })).toContain("num_ctx")
  })
})

describe("image input and tools (02 §3.3)", () => {
  const view = compat({
    server: { family: "ollama", overflowClassified: false },
    models: [
      {
        id: "qwen2.5vl:7b",
        image: { on: true, setting: "auto", detected: true },
        tools: { on: true, setting: "auto", detected: true },
      },
      { id: "gemma3:1b", image: { on: false, setting: "auto" }, tools: { on: false, setting: "off", detected: true } },
      // A service older than the capability settings lists neither.
      { id: "old" },
    ],
  })

  test("the card line says on or off and where it came from; a model without tools is called out", () => {
    expect(compatCapabilitiesText(ko, view)).toBe(
      "모델 기능: qwen2.5vl:7b 그림 입력 켬(서버 값) · 도구 켬(서버 값), gemma3:1b 그림 입력 끔(모름) · 도구 끔(직접 정함)",
    )
    expect(compatCapabilitiesText(en, view)).toBe(
      "Model capabilities: qwen2.5vl:7b image input on (from the server) · tools on (from the server), gemma3:1b image input off (unknown) · tools off (set by you)",
    )
    expect(compatCapabilitiesText(ko, compat({ models: [{ id: "old" }] }))).toBeUndefined()
    expect(compatWithoutTools(view)).toBe(true)
    expect(compatWithoutTools(compat({ models: [{ id: "old" }] }))).toBe(false)
    expect(ko("own.compat.noTools")).toBe("도구가 꺼진 모델은 대화만 해요. 파일을 읽거나 명령을 실행하지 못해요.")
  })

  test("the dialog sends only the settings that changed, per model", () => {
    const models = view.compat!.models
    expect(
      compatSettingsChange(models, {
        "qwen2.5vl:7b": { image: "auto", tools: "auto" },
        "gemma3:1b": { image: "on", tools: "off" },
        old: { image: "on", tools: "on" },
      }),
    ).toEqual([{ id: "gemma3:1b", image: "on" }])
    expect(
      compatSettingsChange(models, {
        "qwen2.5vl:7b": { image: "off", tools: "off" },
        "gemma3:1b": { image: "auto", tools: "auto" },
      }),
    ).toEqual([
      { id: "qwen2.5vl:7b", image: "off", tools: "off" },
      { id: "gemma3:1b", tools: "auto" },
    ])
    expect(compatSettingsChange(models, {})).toEqual([])
  })
})

describe("catalog", () => {
  test("English has only Korean keys, and keeps every placeholder", () => {
    for (const [key, value] of Object.entries(compatEn)) {
      expect(Object.hasOwn(compatKo, key)).toBe(true)
      const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted()
      expect(placeholders(value ?? "")).toEqual(placeholders(compatKo[key as CompatKey]))
    }
  })
})
