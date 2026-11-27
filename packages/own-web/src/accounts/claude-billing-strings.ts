// Claude extra-usage warning strings (02 §8.9, 03 §5.4.1(d), user decision CW 2026-10-19 "경고 보이고 확인하기"): the
// Claude cards' info line, the observed billing state and its `자세히` part (on the lazy accounts page), and the
// composer's first-request notice (a lazy chunk too), so none of them is in the first chunk (PF5).
import { featureText } from "@/queue/text"

export const claudeBillingKo = {
  "own.claude.billing.line":
    "Anthropic 정책(2026-04-04)으로 Claude Code 밖에서 쓰는 구독 사용은 구독 한도가 아니라 추가 사용량(종량제)으로 청구될 수 있어요. claude.ai › 설정 › 사용량에서 확인하세요.",
  "own.claude.billing.extraUsage": "이 계정은 지금 추가 사용량으로 청구되고 있어요",
  "own.claude.billing.rejected": "추가 사용량이 꺼져 있어 거절됐어요 · claude.ai에서 켜거나 API 키를 쓰세요",
  "own.claude.billing.seen": "{ago} 응답 기준",
  "own.claude.billing.more": "자세히",
  "own.claude.billing.datesTitle": "바뀐 것",
  "own.claude.billing.date.safeguard":
    "2026-01-09: Anthropic이 Claude Code 밖에서 쓰는 구독 로그인(OAuth)을 서버에서 막기 시작했어요.",
  "own.claude.billing.date.terms":
    "2026-02-19 무렵: Claude Code의 법률 문서가 구독 로그인을 Claude Code와 Anthropic 앱용으로 정하고, 서드파티 앱이 구독 로그인으로 요청을 보내는 것을 허용하지 않는다고 밝혔어요.",
  "own.claude.billing.date.policy":
    "2026-04-04 낮 12시(미국 태평양 시간)부터: 서드파티 도구로 쓴 구독 사용은 구독 한도에 넣지 않고 추가 사용량(지금 이름은 사용량 크레딧, API 요금)으로 청구한다고 알렸어요.",
  "own.claude.billing.date.help":
    "2026-06-15·2026-10-07: Anthropic 도움말은 Agent SDK, claude -p, 서드파티 앱 사용이 구독 한도에서 나간다고 적었어요. 그런데 2026-10 초에도 서드파티 요청이 추가 사용량 오류로 거절된 사례가 보고됐어요. 그래서 이 앱은 어느 쪽인지 장담하지 않아요.",
  "own.claude.billing.knowTitle": "이 앱이 알 수 있는 것",
  "own.claude.billing.know.headers":
    "응답의 한도 정보가 추가 사용량으로 넘어갔다고 알려 주거나, 추가 사용량이 꺼져 있거나 모자라 요청이 거절되면 카드에 바로 보여요.",
  "own.claude.billing.know.unknown":
    "그 밖에는 요청 하나가 구독 한도로 계산됐는지 추가 사용량으로 청구됐는지 응답만으로는 알 수 없어요. Anthropic은 그것을 알려 주는 표시를 밝히지 않았어요. 그래서 비용을 “알 수 없음”으로 보여요.",
  "own.claude.billing.checkTitle": "확인하는 법",
  "own.claude.billing.check.1": "이 계정으로 짧은 메시지를 하나 보내요.",
  "own.claude.billing.check.2":
    "claude.ai › 설정 › 사용량(Settings › Usage)을 열어 사용량 크레딧(Usage credits, 예전 이름 추가 사용량) 칸을 봐요. 결제(Billing)에도 청구가 보여요.",
  "own.claude.billing.check.3":
    "방금 쓴 만큼 금액이 늘었으면 이 앱의 요청은 추가 사용량으로 청구되고 있어요. 금액은 그대로이고 구독 사용량만 늘었으면 구독 한도로 계산된 거예요.",
  "own.claude.billing.openUsage": "claude.ai 사용량 열기",
  "own.claude.billing.sourcesTitle": "출처",
  "own.claude.first.line": "이 계정의 첫 Claude 요청이에요 · 추가 사용량으로 청구될 수 있어요",
  "own.claude.first.continue": "계속",
  "own.claude.first.cancel": "취소",
} as const satisfies Record<string, string>

export type ClaudeBillingKey = keyof typeof claudeBillingKo

export const claudeBillingEn: Partial<Record<ClaudeBillingKey, string>> = {
  "own.claude.billing.line":
    "Under Anthropic's policy (2026-04-04), subscription use outside Claude Code may be billed as extra usage (pay as you go) instead of your plan limits. Check it at claude.ai › Settings › Usage.",
  "own.claude.billing.extraUsage": "This account is being billed as extra usage now",
  "own.claude.billing.rejected": "Refused because extra usage is off · turn it on at claude.ai or use an API key",
  "own.claude.billing.seen": "as of a response {ago}",
  "own.claude.billing.more": "Details",
  "own.claude.billing.datesTitle": "What changed",
  "own.claude.billing.date.safeguard":
    "2026-01-09: Anthropic started blocking subscription sign-ins (OAuth) used outside Claude Code on its servers.",
  "own.claude.billing.date.terms":
    "Around 2026-02-19: Claude Code's legal page set the subscription sign-in aside for Claude Code and Anthropic's apps and said third-party apps may not send requests with it.",
  "own.claude.billing.date.policy":
    "From 2026-04-04, 12 pm PT: Anthropic said subscription use through third-party tools no longer counts against plan limits and is billed as extra usage (now called usage credits, at API rates).",
  "own.claude.billing.date.help":
    "2026-06-15 and 2026-10-07: Anthropic's help says Agent SDK, claude -p and third-party app usage draw from subscription limits. Yet in early October 2026 third-party requests were still reported refused with the extra-usage error, so this app does not promise either way.",
  "own.claude.billing.knowTitle": "What this app can tell",
  "own.claude.billing.know.headers":
    "When a response's limit information says the account moved to extra usage, or a request is refused because extra usage is off or short, the card shows it.",
  "own.claude.billing.know.unknown":
    "Otherwise a response does not tell whether a request counted against the plan or was billed as extra usage; Anthropic has not said what would show it. So the cost reads “unknown”.",
  "own.claude.billing.checkTitle": "How to check",
  "own.claude.billing.check.1": "Send one short message on this account.",
  "own.claude.billing.check.2":
    "Open claude.ai › Settings › Usage and look at Usage credits (formerly extra usage). Billing shows the charges too.",
  "own.claude.billing.check.3":
    "If the amount went up by what you just used, this app's requests are billed as extra usage. If it stayed and only the plan usage went up, they counted against your plan.",
  "own.claude.billing.openUsage": "Open claude.ai usage",
  "own.claude.billing.sourcesTitle": "Sources",
  "own.claude.first.line": "This account's first Claude request · it may be billed as extra usage",
  "own.claude.first.continue": "Continue",
  "own.claude.first.cancel": "Cancel",
}

export const claudeBillingText = featureText(claudeBillingKo, claudeBillingEn)
export const useClaudeBillingText = claudeBillingText.use
