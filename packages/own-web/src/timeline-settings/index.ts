// Timeline detail presets (03 §19.14). First-chunk exports: the preset signal. Lazy surfaces import the settings row
// from `@/timeline-settings/setting` and the transcript chunk imports `timelineView` from
// `@/timeline-settings/detail`.
export {
  DEFAULT_TIMELINE_PRESET,
  parsePreset,
  setTimelinePreset,
  TIMELINE_PRESET_KEY,
  TIMELINE_PRESETS,
  timelinePreset,
  type TimelinePresetID,
} from "./state"
