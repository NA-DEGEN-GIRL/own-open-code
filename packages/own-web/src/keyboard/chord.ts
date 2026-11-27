// Key chords by `event.code` (03 §10): with the Korean IME on, `event.key` is "Process". Synthetic events from
// automation or some virtual keyboards have an empty `code`; only then fall back to `key` (the prototype's `kc`).

export interface ChordEvent {
  readonly code: string
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

const PUNCTUATION: Record<string, string> = {
  ".": "Period",
  ">": "Period",
  ",": "Comma",
  "<": "Comma",
  "/": "Slash",
  "?": "Slash",
  ";": "Semicolon",
  ":": "Semicolon",
  "'": "Quote",
  '"': "Quote",
  "[": "BracketLeft",
  "{": "BracketLeft",
  "]": "BracketRight",
  "}": "BracketRight",
  "\\": "Backslash",
  "|": "Backslash",
  "`": "Backquote",
  "~": "Backquote",
  "=": "Equal",
  "+": "Equal",
  "-": "Minus",
  _: "Minus",
  " ": "Space",
}

export function eventCode(event: Pick<ChordEvent, "code" | "key">) {
  if (event.code) return event.code
  const key = event.key
  if (!key || key === "Process" || key === "Unidentified") return ""
  if (key.length !== 1) return key
  if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`
  if (/[0-9]/.test(key)) return `Digit${key}`
  return PUNCTUATION[key] ?? ""
}

export const isMac =
  typeof navigator === "object" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "")

/**
 * Canonical chord string: modifiers in the order Mod, Alt, Shift, then the code. `Mod` is Ctrl on Windows/Linux
 * and ⌘ on macOS; a Ctrl on macOS stays `Ctrl`.
 */
export function chordOf(event: ChordEvent, mac = isMac) {
  const code = eventCode(event)
  if (!code) return ""
  const mod = mac ? event.metaKey : event.ctrlKey
  const ctrl = mac && event.ctrlKey
  return [mod && "Mod", ctrl && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", code]
    .filter(Boolean)
    .join("+")
}

/** Normalizes a written chord ("Shift+Mod+KeyK" → "Mod+Shift+KeyK") so maps compare equal. */
export function normalizeChord(chord: string) {
  const parts = chord.split("+")
  const code = parts.at(-1) ?? ""
  const has = (name: string) => parts.slice(0, -1).includes(name)
  return [has("Mod") && "Mod", has("Ctrl") && "Ctrl", has("Alt") && "Alt", has("Shift") && "Shift", code]
    .filter(Boolean)
    .join("+")
}

const LABELS: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Equal: "=",
  Minus: "-",
  ArrowUp: "↑",
  ArrowDown: "↓",
  NumpadEnter: "Enter",
}

/** Display form for help and tooltips: "Ctrl+Shift+R" (⌘ on macOS). */
export function chordLabel(chord: string, mac = isMac) {
  return chord
    .split("+")
    .map((part) => {
      if (part === "Mod") return mac ? "⌘" : "Ctrl"
      if (part.startsWith("Key")) return part.slice(3)
      if (part.startsWith("Digit")) return part.slice(5)
      return LABELS[part] ?? part
    })
    .join("+")
}
