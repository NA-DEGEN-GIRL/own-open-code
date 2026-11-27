// 압축 내용 strings (03 §4.5 "압축 내용 보기", UC 2026-10-18): the label of the `⋯` item and the marker's button.
// The marker's own words (`{account}에서 요약`, `자동`, `수동`, `모델 없이 줄임`) are the transcript's (`own.marker.*`,
// src/transcript/marker-strings.ts); a context reset's are src/context-reset/strings.ts.
// The dialog's own words are ./dialog-strings.ts (lazy, with the dialog).
import { featureText } from "@/queue/text"

export const compactionsKo = {
  "own.compactions.open": "압축 내용 보기",
  "own.compactions.idle": "자리를 비운 사이 압축했어요",
} as const satisfies Record<string, string>

export type CompactionsKey = keyof typeof compactionsKo

export const compactionsEn: Partial<Record<CompactionsKey, string>> = {
  "own.compactions.open": "View compacted content",
  "own.compactions.idle": "Compacted while you were away",
}

export const compactionsText = featureText(compactionsKo, compactionsEn)
export const useCompactionsText = compactionsText.use
