// Dark is own's default color scheme (03 §5.7, §13.1). @opencode/ui ThemeProvider reads the stored choice from
// "opencode-color-scheme" and falls back to "system"; it has no prop for another default. So App seeds the stored
// choice before the provider initializes, and vite/theme-preload.js paints the same default before any JS runs.
// Only an absent (or unknown) value is replaced: a stored light or system choice stays.
import type { ColorScheme } from "@opencode/ui/theme/context"

/** The ThemeProvider storage key (own/upstream-surface.json ui-theme-storage-keys). */
export const COLOR_SCHEME_KEY = "opencode-color-scheme"
export const DEFAULT_COLOR_SCHEME: ColorScheme = "dark"
/** Settings order and the header toggle's cycle: the default first. */
export const COLOR_SCHEMES = ["dark", "light", "system"] as const satisfies readonly ColorScheme[]

export type SchemeStorage = Pick<Storage, "getItem" | "setItem">

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === "dark" || value === "light" || value === "system"
}

/**
 * The stored choice when it is one of the three schemes; otherwise stores and returns the default. Storage that is
 * missing or throws (private mode, blocked site data) leaves the default to the preload and the provider's fallback.
 */
export function seedColorScheme(storage: SchemeStorage | undefined = browserStorage()): ColorScheme {
  let stored: string | null = null
  try {
    stored = storage?.getItem(COLOR_SCHEME_KEY) ?? null
  } catch {}
  if (isColorScheme(stored)) return stored
  try {
    storage?.setItem(COLOR_SCHEME_KEY, DEFAULT_COLOR_SCHEME)
  } catch {}
  return DEFAULT_COLOR_SCHEME
}

/** Header toggle: dark → light → system → dark. */
export function nextColorScheme(scheme: ColorScheme): ColorScheme {
  const index = COLOR_SCHEMES.indexOf(scheme)
  return COLOR_SCHEMES[(index + 1) % COLOR_SCHEMES.length] ?? DEFAULT_COLOR_SCHEME
}

/** Window background per scheme: --own-bg-subtle of the default theme (v2 bg-deep); vite/theme-preload.js paints the same. */
export const WINDOW_BACKGROUND = { dark: "#080808", light: "#fafafa" } as const

/**
 * The window background as `#rrggbb`, for the desktop window (T0-4) and the theme-color meta. The v2 tokens are
 * written `#rrggbbaa`, and Electron's setBackgroundColor reads 8 digits as `#aarrggbb` (`#080808ff` → blue), so the
 * alpha is dropped and `#rgb` is expanded. Any other syntax (rgb(), a custom theme's color-mix) gets the scheme's color.
 */
export function windowBackground(value: string, mode: "light" | "dark"): string {
  const text = value.trim().toLowerCase()
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text)
  if (long) return `#${long[1]}`
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return WINDOW_BACKGROUND[mode]
}

function browserStorage(): SchemeStorage | undefined {
  try {
    return typeof localStorage === "object" ? localStorage : undefined
  } catch {
    return undefined
  }
}
