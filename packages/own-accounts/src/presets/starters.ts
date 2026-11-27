export * as PresetStarters from "./starters.js"

import type { Preset } from "@own/protocol"

/**
 * Owner: PRESETS (07 §3.4 시작 틀). The three starters (`Preset.STARTERS`: `가볍게 나눠 쓰기`, `다른 회사 리뷰`,
 * `로컬로 탐색`) are data relative to the main; `Preset.suggest` fills them from the live candidates and returns each
 * one greyed with its problem when nothing can fill it (`로컬로 탐색` until a local model's running window is verified,
 * PG9; `다른 회사 리뷰` without another company's subscription). A starter never contains a paid target.
 *
 * A starter's draft carries the starter's name. Moving a session to another group looks the preset up by name (07
 * §5.3), so the draft is named apart from the group's presets: a second `가볍게 나눠 쓰기` becomes
 * `가볍게 나눠 쓰기 2`. A fresh draft (no starter) has no name yet and stays as it is.
 */
export function named(suggestion: Preset.Suggestion, taken: ReadonlyArray<string>): Preset.Suggestion {
  const base = suggestion.draft.name
  if (base === "" || !taken.includes(base)) return suggestion
  const name =
    Array.from({ length: taken.length + 1 }, (_, index) => `${base} ${index + 2}`).find(
      (candidate) => !taken.includes(candidate),
    ) ?? base
  return { ...suggestion, draft: { ...suggestion.draft, name } }
}
