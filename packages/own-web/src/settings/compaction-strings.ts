// 설정 > 자동 압축 > 압축 실패 시 대체 모델 strings that only the lazy settings page reads (compaction-fallback.tsx), so
// they stay out of the shared catalogs and the first chunk (PF5). All of the section's words are here (the rest moved
// from src/i18n when the browser view on a device filled the first chunk's budget, MBR 2026-11-21).
import { featureText } from "@/queue/text"

export const compactionKo = {
  "own.compact.fallback.title": "압축 실패 시 대체 모델",
  "own.compact.fallback.automatic": "자동",
  "own.compact.fallback.chosen": "직접 고름",
  "own.compact.fallback.note":
    "대화의 모델이 압축에 실패하면(오류·거부) 위에서부터 차례로 대신 요약해요. 실패한 계정은 건너뛰고 최대 3개까지 시도해요. 모두 실패하면 모델 없이 코드로 줄여요. 자동이면 GPT-6 Astra → GPT-6.1 Sol → Claude Opus 5.5 → DeepSeek V4 Pro 순으로, 가진 계정에서 골라요.",
  "own.compact.fallback.empty": "대체 모델 없음 — 실패하면 바로 모델 없이 줄여요",
  "own.compact.fallback.add": "모델 추가…",
  "own.compact.fallback.edit": "목록 바꾸기",
  "own.compact.fallback.up": "위로",
  "own.compact.fallback.down": "아래로",
  "own.compact.fallback.remove": "빼기",
  "own.compact.fallback.saved": "대체 모델 순서를 저장했어요",
  "own.compact.fallback.savedAuto": "대체 모델을 자동으로 고르게 했어요",
  "own.compact.fallback.unavailable": "이 서비스에서는 대체 모델을 정할 수 없어요.",
  "own.compact.fallback.retry": "다시 시도",
}

export type CompactionKey = keyof typeof compactionKo

export const compactionEn: Partial<Record<CompactionKey, string>> = {
  "own.compact.fallback.title": "Fallback models for a failed compaction",
  "own.compact.fallback.automatic": "Automatic",
  "own.compact.fallback.chosen": "Chosen",
  "own.compact.fallback.note":
    "When the conversation's model fails to compact (an error or a refusal), these write the summary instead, from the top. The account that failed is skipped and at most three are tried. If all fail, code reduces the conversation without a model. Automatic picks GPT-6 Astra → GPT-6.1 Sol → Claude Opus 5.5 → DeepSeek V4 Pro from your accounts.",
  "own.compact.fallback.empty": "No fallback models — a failed compaction is reduced without a model right away",
  "own.compact.fallback.add": "Add a model…",
  "own.compact.fallback.edit": "Change the list",
  "own.compact.fallback.up": "Move up",
  "own.compact.fallback.down": "Move down",
  "own.compact.fallback.remove": "Remove",
  "own.compact.fallback.saved": "Saved the fallback order",
  "own.compact.fallback.savedAuto": "Fallback models are chosen automatically",
  "own.compact.fallback.unavailable": "This service cannot set fallback models.",
  "own.compact.fallback.retry": "Try again",
}

export const compactionText = featureText(compactionKo, compactionEn)
export const useCompactionText = compactionText.use
