// The preset keys the first chunk renders (PF5, 01 §16.3): the composer's preset and ultra buttons, the role and error
// names of a session's preset view, the switcher's group names, the sidebar's and the subagent row's words. The rest of
// the preset catalog (the editor, details, target picker, settings 프리셋 page, repair notices) is presets/strings.ts,
// which spreads these and is imported only by lazy screens (decisions MR18). Same `t()` rules as src/i18n.
import type { Preset } from "@own/protocol/preset"
import type { I18nParams } from "@/i18n"
import { catalogText, useCatalogText } from "@/projects/text"

export const presetsBootKo = {
  "own.preset.builtin": "평소대로",
  "own.preset.ultra": "울트라",
  // UC 2026-10-18: the Claude box beside the ultra switch says when it acts (when ultra turns on) and what it raises.
  "own.preset.ultra.raiseClaude": "켤 때 강도도 xhigh로",
  "own.preset.role.general": "일반",
  "own.preset.role.explore": "탐색",
  "own.preset.role.quick": "빠른 일",
  "own.preset.role.deep": "어려운 일",
  "own.preset.role.review": "리뷰",
  "own.preset.groupName.codex": "ChatGPT",
  "own.preset.groupName.siwc": "Sign in with ChatGPT",
  "own.preset.groupName.oai": "OpenAI API",
  "own.preset.groupName.anth": "Anthropic API",
  "own.preset.groupName.ds": "DeepSeek",
  "own.preset.groupName.xai": "xAI",
  "own.preset.groupName.or": "OpenRouter",
  "own.preset.groupName.compat": "OpenAI 호환",
  "own.preset.groupName.claude-sub": "Claude 구독",
  "own.preset.groupName.claude-agent": "Claude Agent",
  "own.preset.groupName.ollama": "Ollama",
  "own.preset.groupName.lmstudio": "LM Studio",
  "own.preset.err.sameCompany":
    "{account}(은)는 쓸 수 없어요: 같은 회사의 구독은 하나만, 메인과 같은 회사면 메인 계정만 쓸 수 있어요",
  "own.preset.err.notFound": "프리셋이 없어요. 다른 창에서 지웠을 수 있어요",
  "own.preset.err.wrongGroup": "이 묶음의 프리셋이 아니에요",
  "own.preset.err.targetUnavailable": "{role} 대상을 쓸 수 없어요(도구를 못 쓰는 모델이거나 없는 모델)",
  "own.preset.err.builtinLocked": "평소대로는 바꾸거나 지울 수 없어요",
  "own.preset.page.readOnly": "이 연결에서는 프리셋을 바꿀 수 없어요.",
  "own.preset.ultraLevel.save": "아껴서",
  "own.preset.ultraLevel.recommended": "추천",
  "own.preset.ultraLevel.large": "크게",
  "own.preset.ultraLevel.custom": "직접 정하기",
  "own.preset.new": "새 프리셋…",
  "own.preset.edit": "편집…",
  "own.preset.needsRepair": "고칠 것 있음",
  "own.preset.ultraLevel.numbers": "동시 {concurrent} · 메시지당 {perMessage} · 대화당 {perSession}",
  "own.preset.caps.none": "제한 없음",
}

export type PresetsBootKey = keyof typeof presetsBootKo

export const presetsBootEn: Partial<Record<PresetsBootKey, string>> = {
  "own.preset.builtin": "As usual",
  "own.preset.ultra": "Ultra",
  "own.preset.ultra.raiseClaude": "Also raise effort to xhigh",
  "own.preset.role.general": "General",
  "own.preset.role.explore": "Explore",
  "own.preset.role.quick": "Quick tasks",
  "own.preset.role.deep": "Hard tasks",
  "own.preset.role.review": "Review",
  "own.preset.groupName.compat": "OpenAI compatible",
  "own.preset.groupName.claude-sub": "Claude subscription",
  "own.preset.groupName.claude-agent": "Claude Agent",
  "own.preset.err.sameCompany":
    "{account} can't be used: one subscription per company, and for the main's company only the main account",
  "own.preset.err.notFound": "The preset is gone. Another window may have removed it",
  "own.preset.err.wrongGroup": "This preset belongs to another group",
  "own.preset.err.targetUnavailable": "The {role} target can't be used (a model without tools, or one that is gone)",
  "own.preset.err.builtinLocked": "'As usual' can't be changed or removed",
  "own.preset.page.readOnly": "Presets can't be changed on this connection.",
  "own.preset.ultraLevel.save": "Frugal",
  "own.preset.ultraLevel.recommended": "Recommended",
  "own.preset.ultraLevel.large": "Large",
  "own.preset.ultraLevel.custom": "Custom",
  "own.preset.new": "New preset…",
  "own.preset.edit": "Edit…",
  "own.preset.needsRepair": "Needs a fix",
  "own.preset.ultraLevel.numbers": "{concurrent} at once · {perMessage} per message · per conversation: {perSession}",
  "own.preset.caps.none": "no limit",
}

export const presetsBootText = catalogText(presetsBootKo, presetsBootEn)

/** `동시 8 · 메시지당 24 · 대화당 제한 없음` (07 §2.6): no conversation cap reads `제한 없음`. */
export function capsNumbers(text: (key: PresetsBootKey, params?: I18nParams) => string, caps: Preset.Caps) {
  return text("own.preset.ultraLevel.numbers", { ...caps, perSession: caps.perSession ?? text("own.preset.caps.none") })
}

export function usePresetsBootText() {
  return useCatalogText(presetsBootText)
}
