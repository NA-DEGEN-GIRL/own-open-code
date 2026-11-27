// Settings shell layout (03 §5.7): a section list beside the page when the main column is wide enough, else a list →
// page drill-down. Decided on the main column's own width, not the window's: at the wide tier the sidebar and the
// pushed panel can leave the main column narrower than a tablet window.

/** Below this main-column width the list and the page take turns (nav ~220 px + a readable page ~420 px). */
export const SETTINGS_SPLIT_MIN = 640

export type SettingsLayout = "split" | "stacked"

/** Width 0 is "not measured yet" (before the first layout), which keeps the split view. */
export function settingsLayout(width: number): SettingsLayout {
  return width > 0 && width < SETTINGS_SPLIT_MIN ? "stacked" : "split"
}

/**
 * Roving focus in a list of `count` items (the section list, the 프리셋 group tabs): the index a key moves to from
 * `index`, wrapping, or `undefined` when the key is not one of the list's keys.
 */
export function navTarget(key: string, index: number, count: number, axis: "vertical" | "horizontal" = "vertical") {
  if (count === 0) return undefined
  if (key === (axis === "vertical" ? "ArrowDown" : "ArrowRight")) return (index + 1) % count
  if (key === (axis === "vertical" ? "ArrowUp" : "ArrowLeft"))
    return index < 0 ? count - 1 : (index - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return undefined
}
