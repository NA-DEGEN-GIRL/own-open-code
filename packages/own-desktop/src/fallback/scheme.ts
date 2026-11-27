// The fallback page's color scheme (03 §5.7: dark is own's default), apart from main.ts so tests need no DOM.
// The page is served from own-web's origin (oc://renderer), so it reads the choice own-web stored.

/** own-web's stored choice (packages/own-web/src/shell/theme-default.ts COLOR_SCHEME_KEY, @opencode/ui's key). */
export const COLOR_SCHEME_KEY = "opencode-color-scheme"

/**
 * Dark unless the stored choice is light, or system while the page sees a light scheme. In the shell that is the
 * tone main started the window in (window-tone.ts: the tone of what own-web last reported for its system choice),
 * because the fallback page never reports a scheme that would hand nativeTheme back to the OS.
 */
export function fallbackScheme(stored: string | null | undefined, prefersLight: boolean): "dark" | "light" {
  if (stored === "light") return "light"
  if (stored === "system" && prefersLight) return "light"
  return "dark"
}
