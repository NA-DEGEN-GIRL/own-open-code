// 설정 > 일반 > 타임라인 상세 (03 §19.14, 5.7): one settings row with the `간단 / 보통 / 자세히` segmented control and
// the chosen preset's description. The settings page is a lazy chunk; this row is too.
import { Segmented } from "@/limits/kit"
import { setTimelinePreset, TIMELINE_PRESETS, timelinePreset } from "./state"
import { useTimelineSettingsText } from "./strings"

export function TimelineDetailSetting() {
  const text = useTimelineSettingsText()
  return (
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-own-border py-3"
      data-testid="settings-timeline"
    >
      <div class="min-w-[220px] flex-1">
        <b class="block text-[13.5px] font-semibold">{text("own.timeline.title")}</b>
        <span class="text-[12px] text-own-muted">{text("own.timeline.note")}</span>
      </div>
      <Segmented
        label={text("own.timeline.title")}
        value={timelinePreset()}
        options={TIMELINE_PRESETS.map((id) => ({ value: id, label: text(`own.timeline.preset.${id}`) }))}
        onChange={(id) => setTimelinePreset(id)}
        testid="settings-timeline-preset"
      />
      <p class="m-0 w-full text-[12px] text-own-muted" aria-live="polite" data-testid="settings-timeline-describe">
        {text(`own.timeline.describe.${timelinePreset()}`)}
      </p>
    </div>
  )
}
