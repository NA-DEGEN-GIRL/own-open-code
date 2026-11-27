// Prompt history and draft strings (03 §19.9), `own.history.*`, ready to move into ko.ts/en.ts (section "history").
import { featureText } from "./text"

export const historyKo = {
  "own.history.position": "기록 {index}/{total}",
  "own.history.back": "↓ 쓰던 글로",
  "own.history.hint": "↑ 이전 메시지 · ↓ 다음",
} as const satisfies Record<string, string>

export type HistoryKey = keyof typeof historyKo

export const historyEn: Partial<Record<HistoryKey, string>> = {
  "own.history.position": "History {index}/{total}",
  "own.history.back": "↓ back to draft",
  "own.history.hint": "↑ previous message · ↓ next",
}

const catalog = featureText(historyKo, historyEn)
export const historyText = catalog.text
export const useHistoryText = catalog.use
