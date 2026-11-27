// Words of switcher/cost-dialog only, loaded with its lazy chunk (PF5, MR14): moved out of src/i18n.
import { featureText } from "@/queue/text"

export const costDialogKo = {
  "own.switch.dialogTitle": "계정 전환: {from} → {to}",
  "own.switch.dialogTitleVariant": "추론 강도 변경: {from} → {to}",
  "own.switch.why": "캐시는 계정·모델마다 따로라서, {to}는 이 대화의 문맥을 처음부터 다시 읽어요.",
  "own.switch.optNowDesc": "재작성 ≈ {tokens} · {delta} · {when}",
  "own.switch.whenIdle": "지금 적용",
  "own.switch.whenBusy": "현재 턴이 끝나면 적용",
  "own.switch.compactBenefit": "이후 요청도 작아져요 (약 1/{n}). 최근 15k 토큰은 원문 유지.",
  "own.switch.anthCompactCold": "Anthropic에서는 요약 요청 자체가 캐시 없이 읽힐 수 있어 압축 이득이 작을 수 있어요",
  "own.switch.cantCompact": '현재 계정으로 압축할 수 없어 "전환 후 압축"을 보여 줘요.',
  "own.switch.optColdIdleDesc":
    "지금은 {from}(으)로 계속하고, 약 {minutes}분 쉬면 자동 전환 · 추가 비용 거의 없음(추정)",
  "own.switch.optColdEither": "캐시가 식은 뒤 전환 — 다음 압축 직후 또는 약 {minutes}분 쉰 뒤",
  "own.switch.optColdEitherDesc":
    "지금은 {from}(으)로 계속하고, 먼저 오는 쪽에서 전환 · {delta}(추정) · 기한 안에 둘 다 없으면 다시 묻기",
  "own.switch.optColdCompaction": "캐시가 식은 뒤 전환 — 다음 압축 직후",
  "own.switch.optColdCompactionDesc":
    "지금은 {from}(으)로 계속하고, 다음 압축 직후 전환 · {delta}(추정) · 기한 안에 압축이 없으면 다시 묻기",
  "own.switch.more": "더 보기",
  "own.switch.optForkDesc": "복제한 대화만 {to}(으)로 전환 · 원 대화는 {from} 캐시를 그대로 유지 · {delta}",
  "own.switch.dontAsk": "이 대화에서는 {tokens} 미만이면 다시 묻지 않기",
  "own.switch.coldFree": "추가 비용 거의 없음",
  "own.switch.confirmWait": "대기 (현재 턴 뒤)",
  "own.switch.contextKeep": "{model} 유지 · 현재 문맥 {tokens} 토큰",
  "own.switch.contextLine": "{from} → {to} · 현재 문맥 {tokens} 토큰",
  "own.switch.details": "자세히",
  "own.switch.detailsHide": "자세히 접기",
  "own.switch.optCompactShort": "{from}에서 요약한 뒤 전환 · {delta}",
  "own.switch.optNewSessionCost": "요약을 첫 메시지로 넣은 새 대화 · 문맥 일부 손실 · {delta}",
  "own.switch.optSwitchThenCompactShort": "전환한 뒤 {to}에서 요약해요 · {delta}",
  "own.switch.unitsDiffer": "과금 단위가 달라 권장을 붙이지 않아요",
  "own.switch.whyVariant":
    "이 모델은 추론 강도를 바꾸면 모델 회사 쪽 캐시가 깨져, 이 대화의 문맥을 처음부터 다시 읽어요.",
}

export const costDialogEn: Partial<Record<keyof typeof costDialogKo, string>> = {
  "own.switch.coldFree": "almost no extra cost",
  "own.switch.confirmWait": "Queue (after this turn)",
  "own.switch.contextKeep": "{model} stays · current context {tokens} tokens",
  "own.switch.contextLine": "{from} → {to} · current context {tokens} tokens",
  "own.switch.details": "Details",
  "own.switch.detailsHide": "Hide details",
  "own.switch.optCompactShort": "Summarize on {from}, then switch · {delta}",
  "own.switch.optNewSessionCost": "A new session seeded with a summary · some context is lost · {delta}",
  "own.switch.optSwitchThenCompactShort": "Switch, then summarize on {to} · {delta}",
  "own.switch.unitsDiffer": "Different billing units: no recommendation",
  "own.switch.whyVariant":
    "Changing the reasoning effort on this model breaks the model company's cache, so the session is read again from the start.",
  "own.switch.dialogTitle": "Switch account: {from} → {to}",
  "own.switch.dialogTitleVariant": "Change reasoning effort: {from} → {to}",
  "own.switch.why":
    "Each account and model has its own cache, so {to} reads this conversation's context from the start.",
  "own.switch.optNowDesc": "Rewrite ≈ {tokens} · {delta} · {when}",
  "own.switch.whenIdle": "applies now",
  "own.switch.whenBusy": "applies when the current turn ends",
  "own.switch.compactBenefit":
    "Later requests get smaller too (about 1/{n}). The latest 15k tokens are kept as they are.",
  "own.switch.anthCompactCold":
    "On Anthropic the summary request itself may be read without the cache, so compacting may gain little",
  "own.switch.cantCompact": 'The current account cannot compact, so "Switch, then compact" is shown.',
  "own.switch.optColdIdleDesc":
    "Goes on with {from} for now and switches after about {minutes} min of rest · almost no extra cost (estimate)",
  "own.switch.optColdEither":
    "Switch once the cache is cold: right after the next compaction or after about {minutes} min of rest",
  "own.switch.optColdEitherDesc":
    "Goes on with {from} for now and switches at whichever comes first · {delta} (estimate) · asks again if neither comes in time",
  "own.switch.optColdCompaction": "Switch once the cache is cold: right after the next compaction",
  "own.switch.optColdCompactionDesc":
    "Goes on with {from} for now and switches right after the next compaction · {delta} (estimate) · asks again if none comes in time",
  "own.switch.more": "More",
  "own.switch.optForkDesc":
    "Only the copied conversation switches to {to} · the original keeps its {from} cache · {delta}",
  "own.switch.dontAsk": "Do not ask again in this conversation below {tokens}",
}

export const costDialogText = featureText(costDialogKo, costDialogEn)
export const useCostDialogText = costDialogText.use
