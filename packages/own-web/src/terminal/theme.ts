// Terminal colors from own tokens (03 §13): the canvas needs concrete colors, so they are read from an element that
// resolves `--own-bg` / `--own-text` (terminal.css `.own-terminal-screen`) and redone when the theme changes.
/**
 * ANSI colors readable on each scheme's background (03 §11: 4.5:1 for text). ghostty-web's defaults are tuned for dark
 * backgrounds, so on the light theme yellow and bright colors all but vanish (prompts, `ls`, git output).
 */
const ANSI = {
  light: {
    black: "#24292f",
    red: "#b3261e",
    green: "#116329",
    yellow: "#7a4d00",
    blue: "#0550ae",
    magenta: "#8250df",
    cyan: "#0f6b73",
    white: "#57606a",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#0969da",
    brightMagenta: "#6639ba",
    brightCyan: "#1b7c83",
    brightWhite: "#24292f",
  },
  dark: {
    // Black and bright black carry dim secondary output: raised so bright black keeps 4.5:1 on the dark background.
    black: "#6e7681",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#8b949e",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  },
} as const

/** Terminal colors from the own tokens the element resolves (`--own-bg`, `--own-text`), as hex for the canvas. */
export function themeColors(probe: HTMLElement) {
  const style = getComputedStyle(probe)
  const background = toHex(style.backgroundColor) ?? "#ffffff"
  const foreground = toHex(style.color) ?? "#1b1c1f"
  return {
    ...ANSI[colorScheme()],
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: `${foreground}40`,
  }
}

export function colorScheme(): "dark" | "light" {
  return document.documentElement.dataset.colorScheme === "dark" ? "dark" : "light"
}

/**
 * `rgb(1, 2, 3)` / `rgba(…)` / `#abc` → `#010203`; other syntaxes (a theme may resolve to `oklch(…)`) go through a
 * 1×1 canvas; fully transparent or unparsable colors → undefined.
 */
export function toHex(color: string) {
  const trimmed = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(trimmed))
    return `#${[...trimmed.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase()
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(trimmed)
  if (!match) return viaCanvas(trimmed)
  if (match[4] !== undefined && Number.parseFloat(match[4]) === 0) return undefined
  return `#${[match[1], match[2], match[3]].map((value) => Number(value).toString(16).padStart(2, "0")).join("")}`
}

function viaCanvas(color: string) {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!context || !color) return undefined
  // An invalid color leaves the previous (transparent) fill, so it reads back as "no color".
  context.fillStyle = "rgba(0, 0, 0, 0)"
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const pixel = context.getImageData(0, 0, 1, 1).data
  if (!pixel[3]) return undefined
  return `#${[pixel[0], pixel[1], pixel[2]].map((value) => (value ?? 0).toString(16).padStart(2, "0")).join("")}`
}
