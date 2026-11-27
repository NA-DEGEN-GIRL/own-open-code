// The transcript's marker words (03 §4.5, §14): the account and model switch line and the compaction line, also read by
// the compactions viewer, and the turn footer's words for the account that signed a step (./signer, SL 2026-10-26).
// Only the lazy transcript and viewer read them, so none of it is in the first chunk (PF5).
import { featureText } from "@/queue/text"

export const markerKo = {
  "own.marker.switch": "계정 전환 · {from} → {to}",
  "own.marker.compact": "문맥 압축 · {before} → {after}",
  "own.marker.switchTitle": "계정 전환",
  "own.marker.modelTitle": "모델 전환",
  "own.marker.variantTitle": "추론 강도 변경",
  "own.marker.modelKept": "{model} 유지",
  "own.marker.modelChanged": "{from} → {to}",
  "own.marker.rewrite": "캐시 재작성 {tokens}",
  "own.marker.rewriteCost": "캐시 재작성 {cost}",
  "own.marker.uiOnly": "화면 전용",
  "own.marker.uiOnlyHint": "이 표시는 화면 전용이며 모델에 전달되지 않아요",
  "own.marker.reason": "사유: {reason}",
  "own.marker.appliedAt": "적용 {time}",
  "own.marker.reason.manual": "사용자",
  "own.marker.reason.hard": "한도 도달 후 사용자 선택",
  "own.marker.reason.auth": "인증 실패 후 사용자 선택",
  "own.marker.reason.schedule": "예약(캐시가 식은 뒤)",
  "own.marker.reason.fork": "곁가지 포크",
  "own.marker.reason.unknown": "기록 없음",
  "own.marker.compactBy": "{account}에서 요약",
  "own.marker.compactByFallback": "{account}에서 대체 요약",
  "own.marker.compactByCode": "모델 없이 줄임 — 일부 내용이 빠졌을 수 있음",
  "own.marker.compactFailure": "원래 압축이 실패한 이유: {reason}",
  "own.marker.compactAuto": "자동",
  "own.marker.compactAutoAt": "자동({tokens} 지점)",
  "own.marker.compactManual": "수동",
  "own.marker.compactSession": "이 대화 설정({tokens})",
  "own.marker.compactSwitch": "전환 준비",
  "own.marker.compactAfterPending": "다음 단계에서 측정",
  "own.marker.compactRunning": "문맥 압축 중…",
  "own.marker.showSummary": "요약 보기",
  "own.marker.hideSummary": "요약 접기",
  "own.marker.removedAccount": "뺀 계정",
  "own.marker.stepAccount": "계정",
  "own.marker.accountRewrite": "계정이 바뀌어서 캐시가 비었어요",
  "own.marker.accountRewriteHint":
    "앞 단계는 {from}, 이 턴의 첫 단계는 {to}에서 실행됐어요. 캐시는 계정마다 따로라서 첫 단계가 캐시를 새로 썼어요.",
} as const satisfies Record<string, string>

export type MarkerKey = keyof typeof markerKo

export const markerEn: Partial<Record<MarkerKey, string>> = {
  "own.marker.switch": "Account switch · {from} → {to}",
  "own.marker.compact": "Context compacted · {before} → {after}",
  "own.marker.switchTitle": "Account switch",
  "own.marker.modelTitle": "Model switch",
  "own.marker.variantTitle": "Reasoning effort changed",
  "own.marker.modelKept": "{model} kept",
  "own.marker.modelChanged": "{from} → {to}",
  "own.marker.rewrite": "cache rewrite {tokens}",
  "own.marker.rewriteCost": "cache rewrite {cost}",
  "own.marker.uiOnly": "UI only",
  "own.marker.uiOnlyHint": "This marker is shown on screen only and is never sent to the model",
  "own.marker.reason": "Reason: {reason}",
  "own.marker.appliedAt": "Applied {time}",
  "own.marker.reason.manual": "User",
  "own.marker.reason.hard": "User choice after a limit",
  "own.marker.reason.auth": "User choice after an auth failure",
  "own.marker.reason.schedule": "Scheduled (after the cache cools)",
  "own.marker.reason.fork": "Side fork",
  "own.marker.reason.unknown": "Not recorded",
  "own.marker.compactBy": "summarized on {account}",
  "own.marker.compactByFallback": "fallback summary on {account}",
  "own.marker.compactByCode": "reduced without a model — some details may be missing",
  "own.marker.compactFailure": "Why the compaction failed: {reason}",
  "own.marker.compactAuto": "automatic",
  "own.marker.compactAutoAt": "automatic (at {tokens})",
  "own.marker.compactManual": "manual",
  "own.marker.compactSession": "this session's setting ({tokens})",
  "own.marker.compactSwitch": "before a switch",
  "own.marker.compactAfterPending": "measured after the next step",
  "own.marker.compactRunning": "Compacting context…",
  "own.marker.showSummary": "Show summary",
  "own.marker.hideSummary": "Hide summary",
  "own.marker.removedAccount": "Removed account",
  "own.marker.stepAccount": "Account",
  "own.marker.accountRewrite": "Account changed, so the cache was empty",
  "own.marker.accountRewriteHint":
    "The step before ran on {from}, this turn's first step on {to}. Each account has its own cache, so the first step wrote it anew.",
}

export const markerText = featureText(markerKo, markerEn)
export const useMarkerText = markerText.use
