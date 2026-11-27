// Timeline detail strings (03 §19.14, 5.7). Kept next to the module; the keys can move verbatim into src/i18n/ko.ts /
// en.ts (section "timeline-settings").
import { featureText } from "@/queue/text"

export const timelineSettingsKo = {
  "own.timeline.title": "타임라인 상세",
  "own.timeline.note": "대화에서 도구 카드를 얼마나 펼쳐 보일지 정해요. 열린 대화에 바로 적용돼요.",
  "own.timeline.preset.quiet": "간단",
  "own.timeline.preset.compact": "보통",
  "own.timeline.preset.detailed": "자세히",
  "own.timeline.describe.quiet": "답변 위주로 봐요. 도구·셸 실행·생각 과정은 숨기고 파일 편집만 접어서 보여요.",
  "own.timeline.describe.compact": "도구 카드를 한 줄로 묶어 접어 둬요. 기본값이에요.",
  "own.timeline.describe.detailed": "셸 실행과 파일 편집을 펼쳐 보이고, 나머지 도구와 생각 과정은 묶어 둬요.",
} as const satisfies Record<string, string>

export type TimelineSettingsKey = keyof typeof timelineSettingsKo

export const timelineSettingsEn: Partial<Record<TimelineSettingsKey, string>> = {
  "own.timeline.title": "Timeline detail",
  "own.timeline.note": "How far tool cards open up in conversations. Applies to open conversations right away.",
  "own.timeline.preset.quiet": "Simple",
  "own.timeline.preset.compact": "Normal",
  "own.timeline.preset.detailed": "Detailed",
  "own.timeline.describe.quiet": "Answers first: tools, shell runs and thinking are hidden; file edits stay folded.",
  "own.timeline.describe.compact": "Tool cards are grouped and folded into one line. This is the default.",
  "own.timeline.describe.detailed":
    "Shell runs and file edits are shown expanded; other tools and thinking stay grouped.",
}

export const timelineSettingsText = featureText(timelineSettingsKo, timelineSettingsEn)
export const useTimelineSettingsText = timelineSettingsText.use
