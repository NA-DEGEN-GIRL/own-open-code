// Find-in-session strings (03 §19.13). The shortcut names (`own.set.sc.session.find`, `message.previous|next`) are the
// shared catalog's; these are the bar's own. They can move verbatim into src/i18n/ko.ts / en.ts (section "find").
import { featureText } from "@/queue/text"

export const findKo = {
  "own.find.label": "대화 안에서 찾기",
  "own.find.placeholder": "대화에서 찾기",
  "own.find.count": "{n}/{total}",
  "own.find.countCapped": "{n}/{total}+",
  "own.find.none": "결과 없음",
  "own.find.searching": "찾는 중…",
  "own.find.previous": "이전 결과 (Shift+Enter)",
  "own.find.next": "다음 결과 (Enter)",
  "own.find.close": "찾기 닫기 (Esc)",
  "own.find.older": "이전 기록에서 더 찾기",
  "own.find.olderLoading": "이전 기록을 불러오는 중…",
  "own.find.scope": "불러온 대화의 본문과 사용자 메시지에서 찾아요",
  "own.find.status": "결과 {total}개 중 {n}번째",
  "own.find.statusNone": '"{query}" 결과 없음',
} as const satisfies Record<string, string>

export type FindKey = keyof typeof findKo

export const findEn: Partial<Record<FindKey, string>> = {
  "own.find.label": "Find in session",
  "own.find.placeholder": "Find in conversation",
  "own.find.none": "No results",
  "own.find.searching": "Searching…",
  "own.find.previous": "Previous match (Shift+Enter)",
  "own.find.next": "Next match (Enter)",
  "own.find.close": "Close find (Esc)",
  "own.find.older": "Search older messages too",
  "own.find.olderLoading": "Loading older messages…",
  "own.find.scope": "Searches the loaded answers and user messages",
  "own.find.status": "Match {n} of {total}",
  "own.find.statusNone": 'No results for "{query}"',
}

export const findText = featureText(findKo, findEn)
export const useFindText = findText.use
