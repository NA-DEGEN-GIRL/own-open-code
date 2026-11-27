// Local models (02 §3.3a): the add form's formats and server presets, each model's reasoning setting as the form edits
// it (`추론 강도`: 자동 / 끔 / 단계 / 켬·끔 / 생각 예산), and the card's local and reasoning lines. Pure: the components are
// local-model-form.tsx, reasoning-setting.tsx and local-convert.tsx.
import type { Account, OwnAccounts } from "@own/protocol"
import type { FeatureText } from "@/queue/text"
import type { LocalKey } from "./local-strings"

export const FORMATS: ReadonlyArray<Account.LocalFormat> = ["chat", "responses", "anthropic", "ollama"]

/** Common local servers and their default ports; Ollama has a format of its own. */
export const PRESETS = [
  { id: "ollama", port: 11434, format: "ollama" },
  { id: "lmstudio", port: 1234, format: "chat" },
  { id: "llamacpp", port: 8080, format: "chat" },
  { id: "vllm", port: 8000, format: "chat" },
] as const satisfies ReadonlyArray<{ readonly id: string; readonly port: number; readonly format: Account.LocalFormat }>

export type Preset = (typeof PRESETS)[number]["id"]

/** A preset's base URL on this PC. */
export function presetURL(port: number) {
  return `http://127.0.0.1:${port}/v1`
}

export type ReasoningMode = "auto" | "off" | "effort" | "toggle" | "budget"

/** One model's reasoning as the form edits it: the mode and, for `effort`, the levels as typed. */
export interface ReasoningDraft {
  readonly mode: ReasoningMode
  readonly levels: string
}

export const AUTO: ReasoningDraft = { mode: "auto", levels: "" }

/** The modes a format offers: a thinking budget is Anthropic's only. */
export function modesOf(format: Account.LocalFormat): ReadonlyArray<ReasoningMode> {
  return format === "anthropic" ? ["auto", "off", "effort", "toggle", "budget"] : ["auto", "off", "effort", "toggle"]
}

/** `low, high , ,max` → `["low", "high", "max"]`, each once. */
export function parseLevels(text: string) {
  const levels = text
    .split(/[,\s]+/)
    .map((level) => level.trim())
    .filter((level) => level.length > 0)
  return levels.filter((level, index) => levels.indexOf(level) === index)
}

/**
 * The form's draft of a stored setting; `effort` levels start from the setting's, else what the server reported, so
 * picking `단계` on a server that names its levels shows them.
 */
export function draftOf(
  setting: Account.ReasoningSetting | undefined,
  detected?: Account.Reasoning | null,
): ReasoningDraft {
  const known = detected?.style === "effort" ? detected.levels.join(", ") : ""
  if (setting === undefined || setting === "auto") return { mode: "auto", levels: known }
  if (setting === "off") return { mode: "off", levels: known }
  if (setting.style === "effort") return { mode: "effort", levels: setting.levels.join(", ") }
  return { mode: setting.style, levels: known }
}

/** The setting a draft stores; `undefined` while `단계` has no level (the form then refuses to save). */
export function settingOf(draft: ReasoningDraft): Account.ReasoningSetting | undefined {
  if (draft.mode === "auto" || draft.mode === "off") return draft.mode
  if (draft.mode === "toggle") return { style: "toggle" }
  if (draft.mode === "budget") return { style: "budget" }
  const levels = parseLevels(draft.levels)
  return levels.length > 0 ? { style: "effort", levels } : undefined
}

/** What the server reported of a model's reasoning, for under the setting. */
export function detectedText(text: FeatureText<LocalKey>, detected: Account.Reasoning | null | undefined) {
  if (detected === undefined) return text("own.local.detected.unknown")
  if (detected === null) return text("own.local.detected.none")
  if (detected.style === "toggle") return text("own.local.detected.toggle")
  if (detected.style === "budget") return text("own.local.detected.budget")
  const levels = detected.levels.join(" · ")
  return detected.default
    ? text("own.local.detected.effortDefault", { levels, default: detected.default })
    : text("own.local.detected.effort", { levels })
}

/** The request field a reasoning mode fills in a format, for the form's hint. */
export function sendsText(text: FeatureText<LocalKey>, format: Account.LocalFormat, mode: ReasoningMode) {
  if (mode === "auto" || mode === "off") return undefined
  if (format === "anthropic") return text("own.local.reasoning.sendBudget")
  if (mode === "budget") return text("own.local.reasoning.budgetOnly")
  if (mode === "toggle")
    return text(format === "ollama" ? "own.local.reasoning.sendOllamaToggle" : "own.local.reasoning.sendToggle")
  return text(format === "responses" ? "own.local.reasoning.sendResponses" : "own.local.reasoning.sendEffort")
}

/** Whether an account view is a local model (02 §3.3a). */
export function isLocal(account: Pick<Account.View, "kind" | "compat">) {
  return account.kind === "compat" && account.compat?.local !== undefined
}

/** The card's `로컬 모델 · OpenAI 호환 · 키 없음 · 비용 없음`; `undefined` for any other account. */
export function localLine(text: FeatureText<LocalKey>, account: Pick<Account.View, "kind" | "compat" | "identity">) {
  const local = account.kind === "compat" ? account.compat?.local : undefined
  if (!local) return undefined
  return [
    text("own.local.card", { format: text(`own.local.format.${local.format}`) }),
    ...(account.identity?.keyHint ? [] : [text("own.local.cardKeyless")]),
    text("own.local.cardFree"),
  ].join(" · ")
}

/**
 * The card's `추론 강도: deepseek low · high · xhigh · max(서버 값)`; `undefined` from a service older than 02 §3.3a or
 * an account none of whose models reasons and none has a setting.
 */
export function levelsLine(text: FeatureText<LocalKey>, account: Pick<Account.View, "compat">) {
  const models = account.compat?.models ?? []
  const listed = models.flatMap((model) => (model.reasoning ? [{ id: model.id, reasoning: model.reasoning }] : []))
  if (listed.length === 0) return undefined
  if (listed.every((model) => model.reasoning.levels.length === 0 && model.reasoning.setting === "auto"))
    return undefined
  const parts = listed.map((model) => {
    const source =
      model.reasoning.setting !== "auto" ? "user" : model.reasoning.detected === undefined ? "unknown" : "server"
    return text("own.local.levelsModel", {
      model: model.id,
      levels: model.reasoning.levels.length ? model.reasoning.levels.join(" · ") : text("own.local.levelsNone"),
      source: text(`own.local.from.${source}`),
    })
  })
  return text("own.local.levels", { list: parts.join(", ") })
}

/** A detected model's facts for the pick list: `창 1M · 그림 · 도구 · 추론 low·high`. */
export function factsText(
  text: FeatureText<LocalKey>,
  model: OwnAccounts.LocalDetectedModel,
  tokens: (n: number) => string,
) {
  const reasoning = model.reasoning
  return [
    model.context ? text("own.local.facts.context", { tokens: tokens(model.context) }) : undefined,
    model.image ? text("own.local.facts.image") : undefined,
    model.tools ? text("own.local.facts.tools") : undefined,
    reasoning
      ? text("own.local.facts.reasoning", {
          levels:
            reasoning.style === "effort" ? reasoning.levels.join("·") : text(`own.local.reasoning.${reasoning.style}`),
        })
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ")
}

/** Whether a base URL reads as an http(s) address. */
export function validURL(value: string) {
  return /^https?:\/\/\S+$/.test(value.trim())
}
