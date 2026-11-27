// Strings of the preset fixes of 2026-11-03 (07 §2.3 강도 고정, §3.4 로컬 모델, §7.1 숨긴 모델; 03 §5.4 Claude Agent 이름):
// the forced effort in the editor's 자세히 and the switcher, the local models' own group, the account names of the
// Claude subscription's `[계정 ▾]` and the hidden models in the pickers and in 설정 > 프리셋. Only lazy screens import
// this file (the editor, the switcher popover, the settings page), so none of it is in the first chunk (PF5).
import { featureText } from "@/queue/text"

export const presetFixesKo = {
  "own.pf.force": "강도 고정",
  "own.pf.forceHint":
    "이 프리셋을 쓰는 대화의 메인과 모든 하위 에이전트가 이 강도로 돌아요. 역할과 모델 묶음의 추론 강도보다 먼저이고 대화가 바꾸지 못해요(모델 묶음 항목에 따로 고정한 강도는 그 항목에서 먼저예요). 모델에 없는 강도면 가장 가까운 단계로 맞춰요.",
  "own.pf.forceOff": "고정 안 함(기본)",
  "own.pf.clamped": "이 모델엔 {level}(이)가 없어 {sent}(으)로 맞춰요",
  "own.pf.noLevels": "이 모델은 강도 단계가 없어 강도 없이 돌아요",
  "own.pf.switcher": "프리셋 '{preset}'(이)가 강도를 {level}(으)로 정해요",
  "own.pf.switcherClamped":
    "프리셋 '{preset}'(이)가 강도를 {level}(으)로 정해요 · 이 모델엔 없어 {sent}(으)로 맞췄어요",
  "own.pf.switcherOverride": "지금은 직접 고른 강도예요",
  "own.pf.switcherBack": "프리셋 강도로",
  "own.pf.local": "로컬 모델",
  "own.pf.localHint": "이 PC나 같은 네트워크의 서버에서 돌아요 · 돈이 들지 않아요",
  "own.pf.accountKind": "{account} · {kind}",
  "own.pf.hide": "목록에서 숨기기",
  "own.pf.unhide": "다시 보이기",
  "own.pf.hideShort": "숨기기",
  "own.pf.unhideShort": "보이기",
  "own.pf.hiddenToast": "{name}(을)를 목록에서 숨겼어요",
  "own.pf.undo": "되돌리기",
  "own.pf.versionLater": "버전은 첫 사용 뒤에 보여요 ·",
  "own.pf.costPlan": "토큰 요금 없이 구독 한도에서 써요",
  "own.pf.hiddenCount": "숨긴 모델 {n}개",
  "own.pf.hiddenTag": "숨김",
  "own.pf.hiddenTitle": "숨긴 모델",
  "own.pf.hiddenBody":
    "숨긴 모델은 모델 고르기와 프리셋의 모델 목록에 나오지 않아요. 이미 쓰는 프리셋과 대화는 그대로 돌아요.",
  "own.pf.hiddenNone": "숨긴 모델이 없어요.",
  "own.pf.hiddenFailed": "바꾸지 못했어요: {message}",
} as const

export type PresetFixesKey = keyof typeof presetFixesKo

export const presetFixesEn: Partial<Record<PresetFixesKey, string>> = {
  "own.pf.force": "Fixed effort",
  "own.pf.forceHint":
    "The main and every subagent of a conversation with this preset run at this effort. It comes before the roles' and the model pool's efforts and the conversation cannot change it (an effort fixed on a pool entry comes first for that entry). A model without it takes its nearest level.",
  "own.pf.forceOff": "Not fixed (default)",
  "own.pf.clamped": "This model has no {level}; it runs at {sent}",
  "own.pf.noLevels": "This model has no effort levels; it runs without one",
  "own.pf.switcher": "Preset '{preset}' sets the effort to {level}",
  "own.pf.switcherClamped": "Preset '{preset}' sets the effort to {level} · this model runs it at {sent}",
  "own.pf.switcherOverride": "You picked another effort for now",
  "own.pf.switcherBack": "Back to the preset's effort",
  "own.pf.local": "Local models",
  "own.pf.localHint": "Run on a server on this PC or your network · free",
  "own.pf.accountKind": "{account} · {kind}",
  "own.pf.hide": "Hide from lists",
  "own.pf.unhide": "Show again",
  "own.pf.hideShort": "Hide",
  "own.pf.unhideShort": "Show",
  "own.pf.hiddenToast": "{name} is hidden from the lists",
  "own.pf.undo": "Undo",
  "own.pf.versionLater": "Version shown after first use ·",
  "own.pf.costPlan": "No per-token price: it uses the plan's limits",
  "own.pf.hiddenCount": "{n} hidden models",
  "own.pf.hiddenTag": "Hidden",
  "own.pf.hiddenTitle": "Hidden models",
  "own.pf.hiddenBody":
    "Hidden models stay out of the model picker and the presets' model lists. Presets and conversations that use one keep working.",
  "own.pf.hiddenNone": "No hidden models.",
  "own.pf.hiddenFailed": "Could not change it: {message}",
}

export const presetFixesText = featureText(presetFixesKo, presetFixesEn)
export const usePresetFixesText = presetFixesText.use
