// Preset id → what the transcript's projection and virtualizer take (03 §19.14). Same derivation as upstream
// `packages/app/src/session/timeline/controller.tsx` (reasoning mode and tool default-open follow the preset's
// details). Imports session-ui through the adapter, so only the lazy transcript chunk may import this file.
import { timelinePresets, type ReasoningMode, type TimelineDetail } from "@/adapter/session-ui"
import { DEFAULT_TIMELINE_PRESET, type TimelinePresetID } from "./state"

export interface TimelineView {
  readonly detail: TimelineDetail
  readonly reasoningMode: ReasoningMode
  readonly shellToolDefaultOpen: boolean
  readonly editToolDefaultOpen: boolean
  /** Virtualizer `presentationKey`: measurements and open tool cards are kept per preset. */
  readonly presentationKey: string
}

export function timelineView(id: TimelinePresetID): TimelineView {
  const preset =
    timelinePresets.find((item) => item.id === id) ??
    timelinePresets.find((item) => item.id === DEFAULT_TIMELINE_PRESET)!
  const detail: TimelineDetail = preset.value
  return {
    detail,
    reasoningMode:
      detail.thinking.placement === "hidden" ? "hidden" : detail.thinking.details === "expanded" ? "full" : "compact",
    shellToolDefaultOpen: detail.shell.details === "expanded",
    editToolDefaultOpen: detail.edit.details === "expanded",
    presentationKey: preset.id,
  }
}
