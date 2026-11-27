// The window before own-web paints (03 §5.7 dark default; 05 §7.1): the early window's background and caption-button
// tone (src/main/window-tone.ts), the upstream behavior that choice relies on, and the fallback page's scheme.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { COLOR_SCHEME_KEY as WEB_SCHEME_KEY, WINDOW_BACKGROUND } from "../../own-web/src/shell/theme-default"
import { COLOR_SCHEME_KEY, fallbackScheme } from "../src/fallback/scheme"
import { DEFAULT_WINDOW_BACKGROUND, hexBackground, initialAppearance, toneOf } from "../src/main/window-tone"

const read = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()

describe("early window appearance (window-tone.ts)", () => {
  test("first start (nothing stored): own-web's dark background, dark tone, stored for the next start", () => {
    expect(initialAppearance(undefined)).toEqual({ background: "#080808", tone: "dark", write: "#080808" })
    expect(DEFAULT_WINDOW_BACKGROUND).toBe(WINDOW_BACKGROUND.dark)
  })

  test("a stored #rrggbb is kept as is, and its tone decides the caption buttons", () => {
    expect(initialAppearance("#080808")).toEqual({ background: "#080808", tone: "dark" })
    expect(initialAppearance(WINDOW_BACKGROUND.light)).toEqual({ background: "#fafafa", tone: "light" })
    // A dark background on a light OS still starts dark (white buttons); a light one on a dark OS starts light.
    expect(initialAppearance("#1d1f22").tone).toBe("dark")
    expect(initialAppearance("#f6f6f7").tone).toBe("light")
  })

  test("an older build's #rrggbbaa (Electron reads #aarrggbb: #080808ff is blue) is cut to six digits", () => {
    expect(initialAppearance("#080808ff")).toEqual({ background: "#080808", tone: "dark", write: "#080808" })
    expect(initialAppearance("#FAFAFAFF")).toEqual({ background: "#fafafa", tone: "light", write: "#fafafa" })
    expect(initialAppearance(" #161616cc ")).toMatchObject({ background: "#161616", write: "#161616" })
  })

  test("#rgb and #rgba expand; other syntax or types fall back to the dark default", () => {
    expect(hexBackground("#fff")).toBe("#ffffff")
    expect(hexBackground("#0808")).toBe("#008800")
    expect(initialAppearance("#FFF")).toEqual({ background: "#ffffff", tone: "light", write: "#ffffff" })
    for (const value of ["rgb(8, 8, 8)", "black", "#12345", "#1234567", "", null, 8, {}, ["#fafafa"]])
      expect(initialAppearance(value)).toEqual({ background: "#080808", tone: "dark", write: "#080808" })
  })

  test("every stored value leaves the early window a 6-digit color, never Electron's alpha-first form", () => {
    for (const value of [undefined, "#080808ff", "#fafafa80", "#abc", "#abcd", "#00000000", "hsl(0 0% 3%)"])
      expect(initialAppearance(value).background).toMatch(/^#[0-9a-f]{6}$/)
  })

  test("tone: the caption-symbol color (white or black) with the better contrast", () => {
    expect(toneOf("#000000")).toBe("dark")
    expect(toneOf("#ffffff")).toBe("light")
    expect(toneOf("#0000ff")).toBe("dark")
    expect(toneOf("#ffff00")).toBe("light")
    // Around the crossover (relative luminance ≈ 0.179).
    expect(toneOf("#737373")).toBe("dark")
    expect(toneOf("#7a7a7a")).toBe("light")
  })
})

describe("upstream behavior the early window relies on (packages/desktop, read only)", () => {
  test("createEarlyWindow takes the stored background and a frameless overlay frame at nativeTheme's tone", async () => {
    const early = await read("../../desktop/src/main/windows/early.ts")
    expect(early).toContain("backgroundColor: storedBackgroundColor(),")
    expect(early).toContain("...platformFrame(tone(), zoom),")
    const defaults = await read("../../desktop/src/main/windows/defaults.ts")
    // Any stored string, as is (own-shell.ts writes `#rrggbb` there right before the early window).
    expect(defaults).toContain("const saved = savedBackgroundColor()")
    expect(defaults).toContain("if (saved !== undefined) return saved")
    expect(defaults).toContain("const stored = getStore().get(BACKGROUND_COLOR_KEY)")
    expect(defaults).toContain("return Predicate.isString(stored) ? stored : undefined")
    expect(defaults).toContain('return nativeTheme.shouldUseDarkColors ? "dark" : "light"')
    expect(defaults).toContain('export function titlebarOverlay(mode: "light" | "dark" = tone(), zoom = 1)')
    expect(defaults).toContain("symbolColor: captionSymbolColor(mode),")
    expect(defaults).toContain('return mode === "dark" ? "white" : "black"')
    // Windows: frameless with the title bar overlay (WCO) own-web's desktop host reads.
    expect(defaults).toContain('if (process.platform === "win32") {\n    frame.frame = false')
    expect(defaults).toContain("frame.titleBarOverlay = titlebarOverlay(mode, zoom)")
    const keys = await read("../../desktop/src/main/storage/keys.ts")
    expect(keys).toContain('export const BACKGROUND_COLOR_KEY = "backgroundColor"')
  })

  test("own-web's reports take over: WindowSetTitlebar sets themeSource, AppSetBackgroundColor the background", async () => {
    const appearance = await read("../../desktop/src/main/windows/appearance.ts")
    expect(appearance).toContain('nativeTheme.themeSource = theme.scheme ?? theme.mode ?? "system"')
    expect(appearance).toContain("if (getBackgroundColor() !== color) getStore().set(BACKGROUND_COLOR_KEY, color)")
  })

  test("the vendored entry prepares the appearance after the renderer root and right before createEarlyWindow", async () => {
    const entry = await read("../src/main/index.ts")
    const order = ["registerRenderer()", "prepareWindowAppearance()", "createEarlyWindow()"].map((call) =>
      entry.indexOf(`    ${call}\n`),
    )
    expect(order.every((at) => at > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const shell = await read("../src/main/own-shell.ts")
    expect(shell).toContain("nativeTheme.themeSource = initial.tone")
    expect(shell).toContain("store.set(BACKGROUND_COLOR_KEY, initial.write)")
  })
})

describe("fallback page scheme (05 §5.5 page, 03 §5.7)", () => {
  test("dark unless own-web's stored choice is light, or system on a light scheme", () => {
    expect(COLOR_SCHEME_KEY).toBe(WEB_SCHEME_KEY)
    expect(fallbackScheme(null, true)).toBe("dark")
    expect(fallbackScheme(undefined, false)).toBe("dark")
    expect(fallbackScheme("dark", true)).toBe("dark")
    expect(fallbackScheme("light", false)).toBe("light")
    expect(fallbackScheme("system", true)).toBe("light")
    expect(fallbackScheme("system", false)).toBe("dark")
    expect(fallbackScheme("sepia", true)).toBe("dark")
  })

  test("index.html paints dark by default; light only under data-scheme=light or a light scheme before main.ts", async () => {
    const html = await read("../src/fallback/index.html")
    const root = /\n {6}:root \{([^}]*)\}/.exec(html)?.[1] ?? ""
    expect(root).toContain("color-scheme: dark;")
    expect(root).toContain(`--bg: ${WINDOW_BACKGROUND.dark};`)
    expect(html).not.toContain("prefers-color-scheme: dark")
    expect(html).not.toContain("color-scheme: light dark")
    const light = /:root\[data-scheme="light"\] \{([^}]*)\}/.exec(html)?.[1] ?? ""
    expect(light).toContain(`--bg: ${WINDOW_BACKGROUND.light};`)
    expect(html).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-scheme\]\) \{/)
    const main = await read("../src/fallback/main.ts")
    expect(main).toContain("document.documentElement.dataset.scheme = fallbackScheme(stored, light.matches)")
  })
})
