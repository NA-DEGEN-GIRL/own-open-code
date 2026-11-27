// Strings of the limits summary (03 §7.2, LV 2026-10-24) and of the screens that are lazy anyway: 설정 > 일반 >
// 한도 표시 and the dashboard legend. Only lazy chunks read them (the accounts pages, the 계정·한도 tab, the dashboard,
// the switcher, the settings page), so none of them is in the first chunk (PF5).
import { featureText } from "@/queue/text"

export const limitSummaryKo = {
  // ---- the summary: folded line, unfolded rows ----
  "own.lim.sum.show": "모든 한도 보기",
  "own.lim.sum.hide": "한도 접기",
  "own.lim.sum.resetLong": "{duration} 후 리셋 ({clock})",
  "own.lim.sum.reset": "({reset})",
  "own.lim.sum.observedAt": "{date} 관측",
  "own.lim.sum.billing.extra_usage": "추가 사용량으로 청구 중",
  "own.lim.sum.billing.rejected": "추가 사용량 거절됨",
  "own.lim.sum.reason.disabled": "꺼져 있어요",
  "own.lim.sum.reason.credits": "크레딧이 없어요",
  "own.lim.sum.reason.zero": "크레딧 한도가 0이에요",
  "own.lim.sum.reason.cap": "지출 한도에 닿았어요",
  "own.lim.sum.reason.plan": "이 요금제에는 없어요",
  // ---- 설정 > 일반 > 한도 표시 (03 §5.7, §7.2) ----
  "own.set.limits": "한도 표시",
  "own.set.limits.note": "남은 양은 100%에서 줄어들고, 쓴 양은 0%에서 늘어나요. 주의·위험 색의 기준은 같아요.",
  "own.set.limits.mode": "값",
  "own.set.limits.mode.remaining": "남은 양",
  "own.set.limits.mode.used": "쓴 양",
  "own.set.limits.surface.accounts": "계정 페이지",
  "own.set.limits.surface.accountsNote": "계정·한도 페이지의 계정 카드",
  "own.set.limits.surface.lists": "목록·입력창",
  "own.set.limits.surface.listsNote": "전환기, 계정·한도 탭, 사이드바, 입력창",
  "own.set.limits.density.detailed": "자세히",
  "own.set.limits.density.simple": "간단히",
  "own.set.limits.density.minimal": "아주 간단히",
  "own.set.limits.describe.detailed":
    "모든 한도를 처음부터 펼쳐서 막대, 리셋 시각, 관측 시각까지 보여요. 사이드바는 계정 이름 아래에 막대 둘을 보여요. 입력창은 막대 하나, 자리가 모자라면 작은 고리예요.",
  "own.set.limits.describe.simple":
    "가장 빠듯한 한도 둘과 리셋 시각을 한 줄로 보여요. 누르면 모든 한도가 펼쳐져요. 사이드바와 입력창은 막대 하나예요. 입력창에 자리가 모자라면 작은 고리예요.",
  "own.set.limits.describe.minimal":
    "가장 빠듯한 한도 하나만 보여요. 누르면 모든 한도가 펼쳐져요. 사이드바와 입력창은 작은 고리와 %예요. 입력창에 자리가 모자라면 고리만 남아요.",
  "own.set.limits.preview": "미리 보기",
  "own.set.limits.previewAccount": "예시 계정",
  "own.set.limits.reset": "기본값으로",
  // ---- dashboard legend (03 §5.5, §7.3) ----
  "own.lim.legend": "범례",
  "own.lim.legendFaded": "흐린 막대 = 오래됨",
  "own.lim.legendHatched": "빗금 막대 = 추정",
  "own.lim.legendLive": "실측 · 방금 (2분 이내)",
  "own.lim.legendRecent": "실측 · 10분 전 (15분 이내)",
  "own.lim.legendSources":
    "데이터 출처: 응답에서 본 값(헤더·이벤트), 공식 잔액 조회(15분 이상 간격), 이 PC의 사용 기록.",
  "own.lim.legendStale": "오래됨 · 40분 전",
} as const satisfies Record<string, string>

export type LimitSummaryKey = keyof typeof limitSummaryKo

export const limitSummaryEn: Partial<Record<LimitSummaryKey, string>> = {
  "own.lim.sum.show": "Show every limit",
  "own.lim.sum.hide": "Collapse limits",
  "own.lim.sum.resetLong": "resets in {duration} ({clock})",
  "own.lim.sum.reset": "({reset})",
  "own.lim.sum.observedAt": "observed {date}",
  "own.lim.sum.billing.extra_usage": "billed as extra usage",
  "own.lim.sum.billing.rejected": "extra usage refused",
  "own.lim.sum.reason.disabled": "turned off",
  "own.lim.sum.reason.credits": "no credits left",
  "own.lim.sum.reason.zero": "credit limit is 0",
  "own.lim.sum.reason.cap": "spend cap reached",
  "own.lim.sum.reason.plan": "not in this plan",
  "own.set.limits": "Limit display",
  "own.set.limits.note":
    "Remaining starts at 100% and goes down; used starts at 0% and goes up. Warning and danger colors mean the same in both.",
  "own.set.limits.mode": "Value",
  "own.set.limits.mode.remaining": "Remaining",
  "own.set.limits.mode.used": "Used",
  "own.set.limits.surface.accounts": "Accounts page",
  "own.set.limits.surface.accountsNote": "Account cards on the accounts and limits pages",
  "own.set.limits.surface.lists": "Lists and composer",
  "own.set.limits.surface.listsNote": "Switcher, accounts·limits tab, sidebar, composer",
  "own.set.limits.density.detailed": "Detailed",
  "own.set.limits.density.simple": "Simple",
  "own.set.limits.density.minimal": "Minimal",
  "own.set.limits.describe.detailed":
    "Every limit unfolded from the start, with bars, reset and observation times. The sidebar shows two bars under the account's name; the composer shows one, or a small ring where it has no room.",
  "own.set.limits.describe.simple":
    "The two tightest limits and the reset on one line; click it to unfold every limit. The sidebar and composer show one bar; a composer without the room shows a small ring.",
  "own.set.limits.describe.minimal":
    "Only the tightest limit; click it to unfold every limit. The sidebar and composer show a small ring and the %; a composer without the room keeps the ring alone.",
  "own.set.limits.preview": "Preview",
  "own.set.limits.previewAccount": "Sample account",
  "own.set.limits.reset": "Reset to defaults",
  "own.lim.legend": "Legend",
  "own.lim.legendFaded": "Faded bar = stale",
  "own.lim.legendHatched": "Hatched bar = estimate",
  "own.lim.legendLive": "measured · just now (within 2 min)",
  "own.lim.legendRecent": "measured · 10 min ago (within 15 min)",
  "own.lim.legendSources":
    "Sources: values seen in responses (headers and events), official balance lookups (at most every 15 min), this PC's usage records.",
  "own.lim.legendStale": "stale · 40 min ago",
}

export const limitSummaryText = featureText(limitSummaryKo, limitSummaryEn)
export const useLimitSummaryText = limitSummaryText.use
