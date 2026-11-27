// "이 대화 압축 설정" strings (03 §5.8.5): the dialog's own words, lazy with it (session-compaction.tsx), so they do not
// count against PF5. The words it shares with the context meter and the switcher come from `useI18n().t`.
import { featureText } from "@/queue/text"

export const sessionCompactionKo = {
  "own.compactSession.title": "이 대화 압축 설정",
  "own.compactSession.follow": "계정·모델 설정 따름 ({tokens}에서 압축)",
  "own.compactSession.earlier": "더 일찍 압축 — 이 대화는 아래 크기에서 압축",
  "own.compactSession.unit": "토큰",
  "own.compactSession.invalid": "숫자를 입력하세요",
  "own.compactSession.range": "입력 범위: {min} 이상, {max} 미만",
  "own.compactSession.save": "저장",
  "own.compactSession.saved": "이 대화 압축 설정을 저장했어요",
} as const satisfies Record<string, string>

export type SessionCompactionKey = keyof typeof sessionCompactionKo

export const sessionCompactionEn: Partial<Record<SessionCompactionKey, string>> = {
  "own.compactSession.title": "Compaction for this session",
  "own.compactSession.follow": "Follow the account/model setting (compacts at {tokens})",
  "own.compactSession.earlier": "Compact earlier — this session compacts at",
  "own.compactSession.unit": "tokens",
  "own.compactSession.invalid": "Enter a number",
  "own.compactSession.range": "Range: at least {min}, below {max}",
  "own.compactSession.save": "Save",
  "own.compactSession.saved": "Saved the compaction setting for this session",
}

export const sessionCompactionText = featureText(sessionCompactionKo, sessionCompactionEn)
