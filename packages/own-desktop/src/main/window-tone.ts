// The native window before own-web paints (03 §5.7, §13.1: dark is own's default scheme), apart from own-shell.ts so
// tests need no Electron.
//
// Upstream's early window (windows/early.ts) takes its background from the settings store (`backgroundColor`, what
// the renderer reported on its last run) or, with nothing stored, from oc-2's palette for the OS tone, and its
// caption buttons from nativeTheme (windows/defaults.ts titlebarOverlay(tone())). Left alone that gives own-desktop:
//  - a first start on a light OS: a light window with black caption buttons until own-web paints dark;
//  - a dark stored background on a light OS: black caption buttons on it until own-web's first WindowSetTitlebar;
//  - builds before own-web reported 6 digits stored the v2 token as `#rrggbbaa`, which Electron reads as
//    `#aarrggbb` (`#080808ff` → a blue window).
// So right before the early window (own-shell.ts prepareWindowAppearance) the stored background becomes `#rrggbb`
// (the dark default when nothing usable is stored) and nativeTheme starts in that color's tone. From its first
// themed paint own-web's reports take over: AppSetBackgroundColor, and WindowSetTitlebar, which sets
// nativeTheme.themeSource to own-web's scheme (upstream windows/appearance.ts setTitlebar).

/** own-web's dark window background (packages/own-web/src/shell/theme-default.ts WINDOW_BACKGROUND.dark). */
export const DEFAULT_WINDOW_BACKGROUND = "#080808"

export type WindowTone = "dark" | "light"

export interface InitialAppearance {
  /** `#rrggbb`: what the early window paints before the renderer does. */
  readonly background: string
  /** nativeTheme.themeSource until own-web reports its scheme: caption buttons white on dark, black on light. */
  readonly tone: WindowTone
  /** The value to store under `backgroundColor` when the stored one differs (absent, another syntax, 8 digits). */
  readonly write?: string
}

/**
 * A stored background as `#rrggbb`, or undefined when it is not a hex color. Like own-web's windowBackground():
 * 8 and 4 digits are CSS `#rrggbbaa` / `#rgba` (what older own-web builds reported), so the alpha is dropped rather
 * than read as Electron's leading alpha, and `#rgb` is expanded.
 */
export function hexBackground(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim().toLowerCase()
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text)
  if (long) return `#${long[1]}`
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return undefined
}

/** The tone whose caption symbols (white on dark, black on light) contrast better with a `#rrggbb` background. */
export function toneOf(background: string): WindowTone {
  const channel = (offset: number) => {
    const value = Number.parseInt(background.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  // White and black reach the same contrast ratio at a relative luminance of √0.0525 − 0.05 ≈ 0.179.
  return luminance < 0.179 ? "dark" : "light"
}

/** What the early window starts with, from the stored `backgroundColor` (anything, as read from the store). */
export function initialAppearance(stored: unknown): InitialAppearance {
  const background = hexBackground(stored) ?? DEFAULT_WINDOW_BACKGROUND
  return stored === background
    ? { background, tone: toneOf(background) }
    : { background, tone: toneOf(background), write: background }
}
