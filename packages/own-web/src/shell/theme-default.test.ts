// Dark default (03 §5.7): seeding the ThemeProvider's stored color scheme and the header toggle's cycle.
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  COLOR_SCHEME_KEY,
  COLOR_SCHEMES,
  DEFAULT_COLOR_SCHEME,
  nextColorScheme,
  seedColorScheme,
  WINDOW_BACKGROUND,
  windowBackground,
  type SchemeStorage,
} from "./theme-default"

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const writes: [string, string][] = []
  const storage: SchemeStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, value])
      values.set(key, value)
    },
  }
  return { storage, values, writes }
}

describe("seedColorScheme", () => {
  test("empty storage → dark, and it is stored so the ThemeProvider starts dark", () => {
    const { storage, values, writes } = memory()
    expect(seedColorScheme(storage)).toBe("dark")
    expect(DEFAULT_COLOR_SCHEME).toBe("dark")
    expect(values.get(COLOR_SCHEME_KEY)).toBe("dark")
    expect(writes).toEqual([[COLOR_SCHEME_KEY, "dark"]])
  })

  test("a stored light choice stays light", () => {
    const { storage, values, writes } = memory({ [COLOR_SCHEME_KEY]: "light" })
    expect(seedColorScheme(storage)).toBe("light")
    expect(values.get(COLOR_SCHEME_KEY)).toBe("light")
    expect(writes).toEqual([])
  })

  test("a stored system choice stays system", () => {
    const { storage, values, writes } = memory({ [COLOR_SCHEME_KEY]: "system" })
    expect(seedColorScheme(storage)).toBe("system")
    expect(values.get(COLOR_SCHEME_KEY)).toBe("system")
    expect(writes).toEqual([])
  })

  test("a stored dark choice is left as is", () => {
    const { storage, writes } = memory({ [COLOR_SCHEME_KEY]: "dark" })
    expect(seedColorScheme(storage)).toBe("dark")
    expect(writes).toEqual([])
  })

  test("an unknown value is replaced by dark (the provider would otherwise use it as a mode)", () => {
    const { storage, values } = memory({ [COLOR_SCHEME_KEY]: "sepia" })
    expect(seedColorScheme(storage)).toBe("dark")
    expect(values.get(COLOR_SCHEME_KEY)).toBe("dark")
  })

  test("other theme keys are not touched", () => {
    const { storage, values } = memory({ "opencode-theme-id": "nord" })
    seedColorScheme(storage)
    expect(values.get("opencode-theme-id")).toBe("nord")
  })

  test("storage that throws or is missing still yields dark without throwing", () => {
    const throwing: SchemeStorage = {
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    }
    expect(seedColorScheme(throwing)).toBe("dark")
    expect(seedColorScheme(undefined)).toBe("dark")
  })

  describe("browser localStorage (default argument)", () => {
    afterEach(() => localStorage.removeItem(COLOR_SCHEME_KEY))

    test("empty → dark is written; light and system are kept", () => {
      localStorage.removeItem(COLOR_SCHEME_KEY)
      expect(seedColorScheme()).toBe("dark")
      expect(localStorage.getItem(COLOR_SCHEME_KEY)).toBe("dark")
      localStorage.setItem(COLOR_SCHEME_KEY, "light")
      expect(seedColorScheme()).toBe("light")
      expect(localStorage.getItem(COLOR_SCHEME_KEY)).toBe("light")
      localStorage.setItem(COLOR_SCHEME_KEY, "system")
      expect(seedColorScheme()).toBe("system")
      expect(localStorage.getItem(COLOR_SCHEME_KEY)).toBe("system")
    })
  })
})

describe("scheme order and the header toggle", () => {
  test("dark is listed first (settings), then light, then system", () => {
    expect([...COLOR_SCHEMES]).toEqual(["dark", "light", "system"])
  })

  test("the toggle cycles dark → light → system → dark", () => {
    expect(nextColorScheme("dark")).toBe("light")
    expect(nextColorScheme("light")).toBe("system")
    expect(nextColorScheme("system")).toBe("dark")
  })
})

describe("windowBackground (desktop window color, theme-color meta)", () => {
  test("the v2 8-digit token loses its alpha: Electron would read #080808ff as #aarrggbb (blue)", () => {
    expect(windowBackground("#080808ff", "dark")).toBe("#080808")
    expect(windowBackground(" #FAFAFAFF ", "light")).toBe("#fafafa")
  })

  test("6-digit values pass through; 3- and 4-digit ones are expanded", () => {
    expect(windowBackground("#1d1f22", "dark")).toBe("#1d1f22")
    expect(windowBackground("#abc", "light")).toBe("#aabbcc")
    expect(windowBackground("#abcf", "light")).toBe("#aabbcc")
  })

  test("other syntaxes fall back to the scheme's default window color", () => {
    expect(windowBackground("rgb(8 8 8)", "dark")).toBe(WINDOW_BACKGROUND.dark)
    expect(windowBackground("", "light")).toBe(WINDOW_BACKGROUND.light)
    expect(WINDOW_BACKGROUND).toEqual({ dark: "#080808", light: "#fafafa" })
  })

  test("the preload paints the same colors before any JS module runs", () => {
    const script = readFileSync(new URL("../../vite/theme-preload.js", import.meta.url), "utf8")
    expect(script).toContain(`dark ? "${WINDOW_BACKGROUND.dark}" : "${WINDOW_BACKGROUND.light}"`)
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
    expect(html).toContain(`<meta name="theme-color" content="${WINDOW_BACKGROUND.dark}" />`)
  })
})

describe("first-paint preload agrees with the seed", () => {
  // vite/theme-preload.js runs before any module; it must pick dark for the same inputs the seed turns into dark.
  const script = readFileSync(new URL("../../vite/theme-preload.js", import.meta.url), "utf8")
  const run = (stored: string | null, systemDark: boolean): { scheme?: string; background: string } => {
    const root = document.documentElement
    delete root.dataset.colorScheme
    root.style.backgroundColor = ""
    const saved = { local: globalThis.localStorage, match: globalThis.matchMedia }
    const values = new Map<string, string>(stored === null ? [] : [[COLOR_SCHEME_KEY, stored]])
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => values.get(key) ?? null },
    })
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: systemDark && query.includes("dark") }) as MediaQueryList,
    })
    try {
      new Function(script)()
      return { scheme: root.dataset.colorScheme, background: root.style.backgroundColor }
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved.local })
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: saved.match })
      delete root.dataset.colorScheme
      delete root.dataset.theme
      root.style.backgroundColor = ""
    }
  }

  test("nothing stored → dark even when the system is light", () => {
    const result = run(null, false)
    expect(result.scheme).toBe("dark")
    expect(result.background).not.toBe("")
  })

  test("stored light → light even when the system is dark", () => {
    expect(run("light", true).scheme).toBe("light")
  })

  test("stored system → follows the system", () => {
    expect(run("system", true).scheme).toBe("dark")
    expect(run("system", false).scheme).toBe("light")
  })

  test("unknown value → dark", () => {
    expect(run("sepia", false).scheme).toBe("dark")
  })
})
