// Shortcut audit (03 §10, [gap] 32, 01 §17.1 #32): what a chord may be bound to, and a check of a whole keymap.
//   - conflicts: the same chord twice in overlapping scopes (`findConflicts`),
//   - keys the browser or OS takes first, IME keys, zoom keys (only zoom), text editing keys, and keys that focused
//     surfaces handle themselves (composer send/queue, docks, Esc, terminal copy — the table below with sources),
//   - the upstream-overlap decisions of 03 §10 (Ctrl+B, Ctrl+., Ctrl+Shift+L, Ctrl+Shift+A, Ctrl+W/N/T, Ctrl+Shift+S),
//   - web only (information, not a problem): chords whose browser default own-web takes over (03 open question 31).
// Pure: the settings page and the unit test (the default keymap must pass with no issue) share it.
import { normalizeChord } from "@/keyboard/chord"
import {
  findConflicts,
  PASS_THROUGH_ALLOWED,
  type Keymap,
  type ShortcutDefinition,
  type ShortcutID,
} from "@/keyboard/keymap"
import type { PaletteKey } from "./strings"

export type ChordProblem =
  | { readonly kind: "empty" }
  | { readonly kind: "win" }
  | { readonly kind: "modifier" }
  | { readonly kind: "browser" }
  | { readonly kind: "ime" }
  | { readonly kind: "zoom" }
  | { readonly kind: "editing" }
  | { readonly kind: "composer"; readonly where: PaletteKey }
  | { readonly kind: "conflict"; readonly other: ShortcutID }

/** The browser (tab and window keys it never gives to a page) and the OS. Same list on desktop: one keymap (05 §7.7). */
const RESERVED = new Set(
  [
    "Mod+KeyW",
    "Mod+KeyN",
    "Mod+KeyT",
    "Mod+Shift+KeyW",
    "Mod+Shift+KeyN",
    "Mod+Shift+KeyT",
    "Mod+Tab",
    "Mod+Shift+Tab",
    "Mod+F4",
    "Alt+F4",
    "Alt+Tab",
    "Alt+Space",
    "Alt+Escape",
    "Mod+Escape",
    "Mod+Shift+Escape",
    "Mod+Alt+Delete",
  ].map(normalizeChord),
)
const RESERVED_MAC = new Set(["Mod+KeyQ", "Mod+KeyH", "Mod+KeyM", "Mod+Space", "Mod+Alt+Escape"].map(normalizeChord))
/** ⌘Q is the OS's quit; the app's own quit (05 §7.3) may keep that meaning. */
const QUIT = new Set([`app.quitAll ${normalizeChord("Mod+KeyQ")}`])

/** Input method keys: CJK IME toggles (Windows Ctrl+Space, Shift+Space, Alt+`), 한/영 and 한자 keys. */
const IME = new Set(["Mod+Space", "Shift+Space", "Mod+Shift+Space", "Alt+Backquote"].map(normalizeChord))
const IME_CODES = new Set(["Lang1", "Lang2", "KanaMode", "Convert", "NonConvert", "HangulMode", "HanjaMode"])

const ZOOM = new Set(
  ["Mod+Equal", "Mod+Shift+Equal", "Mod+Minus", "Mod+Digit0", "Mod+NumpadAdd", "Mod+NumpadSubtract", "Mod+Numpad0"].map(
    normalizeChord,
  ),
)
const ZOOM_IDS: ReadonlySet<ShortcutID> = new Set(["zoom.in", "zoom.out", "zoom.reset"])

/** Text fields keep these everywhere (the composer, the palette, search boxes, dialogs). */
const EDITING = new Set(
  [
    "Mod+KeyA",
    "Mod+KeyC",
    "Mod+KeyV",
    "Mod+KeyX",
    "Mod+KeyZ",
    "Mod+KeyY",
    "Mod+Shift+KeyZ",
    "Mod+Shift+KeyV",
    "Mod+Backspace",
    "Mod+Delete",
    "Mod+ArrowLeft",
    "Mod+ArrowRight",
    "Mod+Shift+ArrowLeft",
    "Mod+Shift+ArrowRight",
    "Mod+Home",
    "Mod+End",
    "Mod+Shift+Home",
    "Mod+Shift+End",
    "Shift+ArrowLeft",
    "Shift+ArrowRight",
    "Shift+ArrowUp",
    "Shift+ArrowDown",
    "Shift+Home",
    "Shift+End",
  ].map(normalizeChord),
)

/**
 * Keys that focused surfaces handle before the registry sees them (not in the keymap). A global id on one of these
 * would never fire there, or would steal it elsewhere.
 * - composer: Enter / NumpadEnter send or break the line, Shift+Enter new line (03 §10, composer/index.tsx);
 *   Ctrl+Enter sends or carries the other delivery (4.6 보내는 키) — also 항상 허용 in the permission dock and submit in
 *   the form dock (requests/permission-dock.tsx:79, form-dock.tsx:92); Alt+Enter the other delivery when Ctrl+Enter
 *   sends (reserved in both choices, so switching never frees or steals a chord);
 * - Esc closes popovers and dialogs, twice stops a run (03 §10);
 * - Ctrl+Shift+C copies in the terminal (terminal/view.tsx:214), where pass-through ids stay live.
 */
const FOCUSED: readonly {
  readonly chords: readonly string[]
  readonly where: PaletteKey
  readonly ids?: "pass-through"
}[] = [
  { chords: ["Enter", "NumpadEnter", "Shift+Enter", "Shift+NumpadEnter"], where: "own.keys.where.composerSend" },
  { chords: ["Mod+Enter", "Mod+NumpadEnter"], where: "own.keys.where.composerQueue" },
  { chords: ["Alt+Enter", "Alt+NumpadEnter"], where: "own.keys.where.composerOther" },
  { chords: ["Escape", "Shift+Escape"], where: "own.keys.where.escape" },
  { chords: ["Mod+Shift+KeyC"], where: "own.keys.where.terminalCopy", ids: "pass-through" },
]

export interface ChordCheck {
  readonly mac?: boolean
}

/**
 * Whether `chord` may be bound to `id` in `keymap` (the id's own chords are ignored). The capture UI records chords
 * with `chordOf`, whose Windows form drops the Windows key: pass `win` when it was held.
 */
export function checkChord(
  keymap: Keymap,
  id: ShortcutID,
  chord: string,
  options: ChordCheck & { readonly win?: boolean } = {},
): ChordProblem | undefined {
  if (options.win) return { kind: "win" }
  const key = normalizeChord(chord)
  const problem = staticProblem(id, key, options)
  if (problem) return problem
  const definition = keymap[id]
  const other = (Object.entries(keymap) as [ShortcutID, ShortcutDefinition][]).find(
    ([otherID, otherDefinition]) =>
      otherID !== id &&
      overlaps(definition.scope, otherDefinition.scope) &&
      otherDefinition.chords.some((otherChord) => normalizeChord(otherChord) === key),
  )
  return other ? { kind: "conflict", other: other[0] } : undefined
}

function staticProblem(id: ShortcutID, key: string, options: ChordCheck): ChordProblem | undefined {
  const parts = key.split("+")
  const code = parts.at(-1) ?? ""
  if (!code || MODIFIER_CODES.has(code)) return { kind: "empty" }
  if (IME.has(key) || IME_CODES.has(code)) return { kind: "ime" }
  if (RESERVED.has(key) || (options.mac && RESERVED_MAC.has(key) && !QUIT.has(`${id} ${key}`)))
    return { kind: "browser" }
  if (ZOOM.has(key) && !ZOOM_IDS.has(id)) return { kind: "zoom" }
  if (EDITING.has(key)) return { kind: "editing" }
  const focused = FOCUSED.find(
    (entry) =>
      entry.chords.some((chord) => normalizeChord(chord) === key) &&
      (entry.ids !== "pass-through" || PASS_THROUGH_ALLOWED.has(id)),
  )
  if (focused) return { kind: "composer", where: focused.where }
  const modified = parts.includes("Mod") || parts.includes("Ctrl") || parts.includes("Alt")
  if (!modified && !/^F\d{1,2}$/.test(code)) return { kind: "modifier" }
  return undefined
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
])

function overlaps(a: ShortcutDefinition["scope"], b: ShortcutDefinition["scope"]) {
  return a === "global" || b === "global" || a === b
}

export interface AuditIssue {
  readonly id: ShortcutID
  readonly chord: string
  readonly problem: ChordProblem
}

export type DecisionID = "sidebar" | "switcher" | "selection" | "approval" | "window" | "newSession"

export interface Decision {
  readonly id: DecisionID
  /** The keymap follows the 03 §10 decision. */
  readonly kept: boolean
}

export interface Audit {
  readonly issues: readonly AuditIssue[]
  readonly decisions: readonly Decision[]
  /** Chords checked (all ids, all chords). */
  readonly checked: number
}

/** Every chord of every id: static problems plus same-chord conflicts, and the 03 §10 decisions. */
export function auditKeymap(keymap: Keymap, options: ChordCheck = {}): Audit {
  const entries = Object.entries(keymap) as [ShortcutID, ShortcutDefinition][]
  const statics = entries.flatMap(([id, definition]) =>
    definition.chords.flatMap((chord) => {
      const problem = staticProblem(id, normalizeChord(chord), options)
      return problem ? [{ id, chord: normalizeChord(chord), problem }] : []
    }),
  )
  const conflicts = findConflicts(keymap).flatMap((conflict) =>
    conflict.ids.map((id, index) => ({
      id,
      chord: conflict.chord,
      problem: { kind: "conflict", other: conflict.ids[index === 0 ? 1 : 0]! } as const,
    })),
  )
  return {
    issues: [...statics, ...conflicts],
    decisions: decisions(keymap),
    checked: entries.reduce((sum, [, definition]) => sum + definition.chords.length, 0),
  }
}

function decisions(keymap: Keymap): Decision[] {
  const has = (id: ShortcutID, chord: string) =>
    keymap[id].chords.some((item) => normalizeChord(item) === normalizeChord(chord))
  const unused = (...chords: string[]) =>
    Object.values(keymap).every((definition) =>
      definition.chords.every((item) => !chords.some((chord) => normalizeChord(chord) === normalizeChord(item))),
    )
  const sidebar = keymap["sidebar.toggle"]
  return [
    {
      id: "sidebar",
      kept:
        has("sidebar.toggle", "Mod+KeyB") &&
        "notInComposer" in sidebar &&
        sidebar.notInComposer === true &&
        has("composer.background", "Alt+KeyB"),
    },
    { id: "switcher", kept: has("switcher.open", "Mod+Period") && has("agent.cycle", "Mod+Shift+Period") },
    {
      id: "selection",
      kept:
        has("context.addSelection", "Mod+Shift+KeyL") &&
        has("panel.toggle", "Mod+Alt+KeyB") &&
        has("panel.accounts", "Mod+Shift+KeyU"),
    },
    { id: "approval", kept: has("approval.menu", "Mod+Shift+KeyA") },
    { id: "window", kept: unused("Mod+KeyW", "Mod+KeyN", "Mod+KeyT") },
    { id: "newSession", kept: unused("Mod+Shift+KeyS") && has("session.new", "Alt+KeyN") },
  ]
}

/**
 * Browser defaults own-web takes over in a browser tab (the page prevents them; 03 open question 31 asks to confirm
 * each in an Edge `--app` window). Desktop has no browser menu, so this is only shown on the web.
 */
const BROWSER_DEFAULTS: Readonly<Record<string, PaletteKey>> = {
  "Mod+KeyP": "own.keys.browser.print",
  "Mod+KeyF": "own.keys.browser.find",
  "Mod+KeyO": "own.keys.browser.open",
  "Mod+KeyU": "own.keys.browser.viewSource",
  "Mod+KeyL": "own.keys.browser.address",
  "Mod+KeyK": "own.keys.browser.search",
  "Mod+KeyE": "own.keys.browser.search",
  "Mod+KeyS": "own.keys.browser.save",
  "Mod+KeyH": "own.keys.browser.history",
  "Mod+KeyJ": "own.keys.browser.downloads",
  "Mod+KeyR": "own.keys.browser.reload",
  F5: "own.keys.browser.reload",
  "Mod+Shift+KeyR": "own.keys.browser.hardReload",
  "Mod+Shift+KeyB": "own.keys.browser.bookmarks",
  "Mod+Shift+KeyA": "own.keys.browser.tabSearch",
  "Mod+Shift+KeyU": "own.keys.browser.readAloud",
  "Alt+ArrowLeft": "own.keys.browser.back",
  "Alt+ArrowRight": "own.keys.browser.forward",
}
const BROWSER_DEFAULTS_MAC: Readonly<Record<string, PaletteKey>> = {
  "Mod+BracketLeft": "own.keys.browser.back",
  "Mod+BracketRight": "own.keys.browser.forward",
}

/** The browser action a chord replaces in a browser tab, if any. */
export function browserDefault(chord: string, mac = false): PaletteKey | undefined {
  const key = normalizeChord(chord)
  return BROWSER_DEFAULTS[key] ?? (mac ? BROWSER_DEFAULTS_MAC[key] : undefined)
}
