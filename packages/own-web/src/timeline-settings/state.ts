// Timeline detail preset (03 §19.14, 5.7 설정 > 일반): `간단 / 보통 / 자세히` pick one of session-ui's timeline presets
// (`quiet` / `compact` / `detailed`, packages/session-ui/src/timeline/detail.ts) — how far tool cards, shell runs,
// edits and thinking are grouped or expanded. `보통` (`compact`) is the transcript's existing default, so nothing
// changes until the user picks another preset. Per viewer (localStorage, like density and theme); other windows of the
// same origin follow through the `storage` event. First-chunk safe: ids only, no session-ui import (see ./detail).
import { createRoot, createSignal } from "solid-js"

export const TIMELINE_PRESETS = ["quiet", "compact", "detailed"] as const
export type TimelinePresetID = (typeof TIMELINE_PRESETS)[number]
export const DEFAULT_TIMELINE_PRESET: TimelinePresetID = "compact"

export const TIMELINE_PRESET_KEY = "own.web.timeline.detail"

export function parsePreset(value: unknown): TimelinePresetID {
  return TIMELINE_PRESETS.find((id) => id === value) ?? DEFAULT_TIMELINE_PRESET
}

const store = createRoot(() => {
  const [preset, setPreset] = createSignal<TimelinePresetID>(parsePreset(read()))
  if (typeof window === "object")
    window.addEventListener("storage", (event) => {
      if (event.key === TIMELINE_PRESET_KEY) setPreset(parsePreset(event.newValue))
    })
  return { preset, setPreset }
})

/** The preset the transcript renders with (reactive). */
export const timelinePreset = store.preset

export function setTimelinePreset(next: TimelinePresetID) {
  store.setPreset(next)
  try {
    localStorage.setItem(TIMELINE_PRESET_KEY, next)
  } catch {}
}

function read() {
  try {
    return localStorage.getItem(TIMELINE_PRESET_KEY)
  } catch {
    return null
  }
}
