// Local model form and card rules (02 §3.3a): the reasoning draft of the add form and the `모델 기능` dialog, the
// request field each choice fills per format, the card's local and reasoning lines, and the `accounts.update` items a
// reasoning change sends.
import { describe, expect, test } from "bun:test"
import type { Account } from "@own/protocol"
import {
  draftOf,
  detectedText,
  factsText,
  levelsLine,
  localLine,
  modesOf,
  parseLevels,
  presetURL,
  sendsText,
  settingOf,
  validURL,
} from "./local-model"
import { localEn, localKo, localText, type LocalKey } from "./local-strings"
import { compatSettingsChange } from "./model"

const ko = (key: LocalKey, params?: Record<string, string | number>) => localText.text("ko", key, params)

describe("reasoning draft (02 §3.3a)", () => {
  test("levels as typed: split on commas and spaces, each once", () => {
    expect(parseLevels("low, high ,, max  low")).toEqual(["low", "high", "max"])
    expect(parseLevels("  ")).toEqual([])
  })

  test("a stored setting and back", () => {
    const levels = { style: "effort", levels: ["low", "high", "xhigh", "max"] } as const
    expect(draftOf(undefined, levels)).toEqual({ mode: "auto", levels: "low, high, xhigh, max" })
    expect(draftOf("off")).toEqual({ mode: "off", levels: "" })
    expect(draftOf({ style: "effort", levels: ["low", "max"] }, levels)).toEqual({ mode: "effort", levels: "low, max" })
    expect(draftOf({ style: "toggle" })).toEqual({ mode: "toggle", levels: "" })
    expect(settingOf({ mode: "effort", levels: "low,max" })).toEqual({ style: "effort", levels: ["low", "max"] })
    expect(settingOf({ mode: "effort", levels: " " })).toBeUndefined()
    expect(settingOf({ mode: "auto", levels: "low" })).toBe("auto")
    expect(settingOf({ mode: "budget", levels: "" })).toEqual({ style: "budget" })
  })

  test("a thinking budget is offered for the Anthropic format only", () => {
    expect(modesOf("anthropic")).toContain("budget")
    expect(modesOf("chat")).not.toContain("budget")
  })

  test("what each choice sends", () => {
    expect(sendsText(ko, "chat", "effort")).toBe("보내는 값: reasoning_effort")
    expect(sendsText(ko, "responses", "effort")).toBe("보내는 값: reasoning.effort")
    expect(sendsText(ko, "chat", "toggle")).toBe("보내는 값: chat_template_kwargs.enable_thinking")
    expect(sendsText(ko, "ollama", "toggle")).toBe("보내는 값: reasoning_effort none · high")
    expect(sendsText(ko, "anthropic", "effort")).toBe("보내는 값: thinking.budget_tokens")
    expect(sendsText(ko, "chat", "auto")).toBeUndefined()
  })

  test("what the server reported", () => {
    expect(detectedText(ko, undefined)).toBe("서버가 알려 주지 않았어요")
    expect(detectedText(ko, null)).toBe("서버: 추론하지 않는 모델이에요")
    expect(detectedText(ko, { style: "effort", levels: ["low", "max"], default: "max" })).toBe(
      "서버: 단계 low · max (기본 max)",
    )
  })
})

describe("card lines (02 §3.3a)", () => {
  const view = (compat: Account.CompatView, keyHint?: string) =>
    ({ kind: "compat", compat, identity: keyHint ? { keyHint } : {} }) as const

  test("local line: format, no key, no cost; nothing for other compat accounts", () => {
    expect(localLine(ko, view({ local: { format: "chat" }, models: [] }))).toBe(
      "로컬 모델 · OpenAI 호환 · 키 없음 · 비용 없음",
    )
    expect(localLine(ko, view({ local: { format: "ollama" }, models: [] }, "…abcd"))).toBe(
      "로컬 모델 · Ollama · 비용 없음",
    )
    expect(localLine(ko, view({ models: [] }))).toBeUndefined()
  })

  test("reasoning line: levels with their source; none when no model reasons", () => {
    const capability = { on: true, setting: "auto" } as const
    const model = (id: string, reasoning: Account.CompatReasoning) => ({
      id,
      image: capability,
      tools: capability,
      reasoning,
    })
    expect(
      levelsLine(
        ko,
        view({
          models: [
            model("local-flash-1", {
              setting: "auto",
              detected: { style: "effort", levels: ["low", "max"] },
              levels: ["low", "max"],
            }),
            model("plain", { setting: "off", levels: [] }),
          ],
        }),
      ),
    ).toBe("추론 강도: local-flash-1 low · max(서버 값), plain 없음(직접 정함)")
    expect(levelsLine(ko, view({ models: [model("plain", { setting: "auto", levels: [] })] }))).toBeUndefined()
  })

  test("a detected model's facts", () => {
    expect(
      factsText(
        ko,
        { id: "m", context: 1_048_576, tools: true, reasoning: { style: "effort", levels: ["low", "max"] } },
        (n) => `${Math.round(n / 1024)}k`,
      ),
    ).toBe("창 1024k · 도구 · 추론 low·max")
  })

  test("presets and addresses", () => {
    expect(presetURL(11434)).toBe("http://127.0.0.1:11434/v1")
    expect(validURL("http://localhost:64644/v1")).toBe(true)
    expect(validURL("localhost:64644")).toBe(false)
  })
})

describe("reasoning change (02 §3.3a)", () => {
  const capability = { on: true, setting: "auto" } as const
  const models = [
    { id: "a", image: capability, tools: capability, reasoning: { setting: "auto", levels: [] } },
    // A service older than the reasoning setting lists none: nothing to send for it.
    { id: "b", image: capability, tools: capability },
  ] satisfies Account.CompatView["models"]

  test("only a changed reasoning is sent", () => {
    expect(
      compatSettingsChange(models, {
        a: { image: "auto", tools: "auto", reasoning: { style: "toggle" } },
        b: { image: "auto", tools: "auto", reasoning: "off" },
      }),
    ).toEqual([{ id: "a", reasoning: { style: "toggle" } }])
    expect(compatSettingsChange(models, { a: { image: "auto", tools: "auto", reasoning: "auto" } })).toEqual([])
  })
})

test("every English string has a Korean one", () => {
  expect(Object.keys(localEn).filter((key) => !(key in localKo))).toEqual([])
})
