// Viewport tiers (03 §4.2): by window width, not container width; 200% zoom follows the same rules.
import { createMediaQuery } from "@solid-primitives/media"

export type Tier = "wide" | "desk" | "compact" | "tablet" | "phone"

export const TIER_MIN = { wide: 1440, desk: 1280, compact: 1100, tablet: 600, phone: 0 } as const

/** Tier defaults (03 §4.2 table): fixed column widths and whether the panel pushes or overlays. */
export const TIER_LAYOUT = {
  wide: { sidebar: 272, panel: 420, panelMode: "push", sidebarMode: "column", panelOpenByDefault: true },
  desk: { sidebar: 256, panel: 380, panelMode: "push", sidebarMode: "column", panelOpenByDefault: false },
  compact: { sidebar: 240, panel: 420, panelMode: "drawer", sidebarMode: "column", panelOpenByDefault: false },
  tablet: { sidebar: 272, panel: 560, panelMode: "sheet", sidebarMode: "drawer", panelOpenByDefault: false },
  phone: { sidebar: 0, panel: 0, panelMode: "fullscreen", sidebarMode: "list", panelOpenByDefault: false },
} as const satisfies Record<Tier, unknown>

/**
 * The tablet tier on a touch screen (Fold8 pass, 2026-11-20): an unfolded foldable or a tablet in the Android app.
 * From 840 px the conversation list (240 px, the compact tier's) stays beside the conversation, which keeps at least
 * 600 px (the Galaxy Z Fold8's 932 px main screen on its side, the Fold8 Ultra's 859 px upright); below, as on the
 * Fold8 upright (704 px), the drawer. Handheld layouts move the header's idea notes and settings into the
 * conversation `⋯` (shell.css).
 */
export const BESIDE_MIN = 840
export const TABLET_BESIDE = { ...TIER_LAYOUT.tablet, sidebar: 240, sidebarMode: "column" } as const

export function tierOf(width: number): Tier {
  if (width >= TIER_MIN.wide) return "wide"
  if (width >= TIER_MIN.desk) return "desk"
  if (width >= TIER_MIN.compact) return "compact"
  if (width >= TIER_MIN.tablet) return "tablet"
  return "phone"
}

/** Reactive tier from four media queries: no resize listener, no layout reads. */
export function createTier() {
  const wide = createMediaQuery(`(min-width: ${TIER_MIN.wide}px)`)
  const desk = createMediaQuery(`(min-width: ${TIER_MIN.desk}px)`)
  const compact = createMediaQuery(`(min-width: ${TIER_MIN.compact}px)`)
  const tablet = createMediaQuery(`(min-width: ${TIER_MIN.tablet}px)`)
  return (): Tier => {
    if (wide()) return "wide"
    if (desk()) return "desk"
    if (compact()) return "compact"
    if (tablet()) return "tablet"
    return "phone"
  }
}

export function createCoarsePointer() {
  return createMediaQuery("(pointer: coarse)")
}
