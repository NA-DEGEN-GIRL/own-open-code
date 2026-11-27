// Default keymap (03 §10, including the upstream-conflict decisions of [gap] 32). Ids are stable: users rebind by id
// later (19.15). A chord may appear once per overlapping scope; `findConflicts` checks it and a test enforces it.
import { normalizeChord } from "./chord"

/**
 * - `global`: anywhere except inside a terminal or browser pane, where only `PASS_THROUGH_ALLOWED` survive.
 * - `composer`: only while the composer has focus (in addition to `global`).
 */
export type ShortcutScope = "global" | "composer"

export interface ShortcutDefinition {
  readonly chords: readonly string[]
  readonly scope: ShortcutScope
  /** Not while the composer has focus (Ctrl+B belongs to text editing there, 03 §10). */
  readonly notInComposer?: boolean
}

const global = (...chords: string[]): ShortcutDefinition => ({ chords, scope: "global" })
const composer = (...chords: string[]): ShortcutDefinition => ({ chords, scope: "composer" })

export const DEFAULT_KEYMAP = {
  "palette.open": global("Mod+KeyK"),
  "switcher.open": global("Mod+Period", "Mod+Quote"),
  "agent.cycle": global("Mod+Shift+Period"),
  "sidebar.toggle": { chords: ["Mod+KeyB"], scope: "global", notInComposer: true },
  "panel.toggle": global("Mod+Alt+KeyB"),
  "panel.review": global("Mod+Shift+KeyR"),
  "panel.files": global("Mod+Backslash"),
  "file.open": global("Mod+KeyP"),
  "panel.terminal": global("Mod+Backquote"),
  "terminal.new": global("Mod+Alt+KeyT"),
  "panel.browser": global("Mod+Shift+KeyB"),
  "panel.accounts": global("Mod+Shift+KeyU"),
  "session.new": global("Alt+KeyN"),
  "folder.open": global("Mod+KeyO"),
  "session.previous": global("Alt+ArrowUp"),
  "session.next": global("Alt+ArrowDown"),
  // 03 §19.11a: archive or unarchive the open root session (the palette's `보관` with its keys); text editing keeps
  // its own keys in the composer.
  "session.archive": { chords: ["Mod+Alt+Backspace"], scope: "global", notInComposer: true },
  "history.back": global("Mod+BracketLeft"),
  "history.forward": global("Mod+BracketRight"),
  "message.previous": global("Mod+Alt+BracketLeft"),
  "message.next": global("Mod+Alt+BracketRight"),
  "session.find": global("Mod+KeyF"),
  "composer.focus": global("Mod+KeyL"),
  "session.info": global("Mod+KeyI"),
  "approval.menu": global("Mod+Shift+KeyA"),
  "mcp.list": global("Mod+Semicolon"),
  "settings.open": global("Mod+Comma"),
  "shortcuts.help": global("Mod+Slash"),
  "dock.focus": global("Mod+Shift+Enter"),
  "zoom.in": global("Mod+Equal", "Mod+NumpadAdd"),
  "zoom.out": global("Mod+Minus", "Mod+NumpadSubtract"),
  "zoom.reset": global("Mod+Digit0"),
  "context.addSelection": global("Mod+Shift+KeyL"),
  // 03 §4.6 받아쓰기: held = push to talk, tapped = start/finish; the focused note or else the composer (src/voice).
  "voice.dictate": global("Mod+Alt+KeyV"),
  // 03 §4.5 대화 보기: `대화만 보기` on and off (src/chat-view; R as in reading).
  "view.chatOnly": global("Mod+Alt+KeyR"),
  // 03 §4.1.1 split panes: Ctrl+\ is the file tree, so the split keys add Alt; Ctrl+W stays unused (05 §7.7).
  "pane.splitRight": global("Mod+Alt+Backslash"),
  "pane.splitDown": global("Mod+Alt+Shift+Backslash"),
  "pane.close": global("Mod+Alt+KeyW"),
  "pane.focus1": global("Mod+Alt+Digit1"),
  "pane.focus2": global("Mod+Alt+Digit2"),
  "pane.focus3": global("Mod+Alt+Digit3"),
  "pane.focus4": global("Mod+Alt+Digit4"),
  "pane.next": global("F6"),
  "pane.previous": global("Shift+F6"),
  // 03 §4.4.1 아이디어 노트: the quick capture popover from anywhere, the composer keeps its draft and focus (I as in
  // idea; Ctrl+I is the session info).
  "idea.capture": global("Mod+Alt+KeyI"),
  // 05 §7.3 완전 종료…: desktop only (the shell's dialog, which offers 앱만 종료 too; 취소 is its default). Not inside a
  // terminal, where Ctrl+Q stays the terminal's.
  "app.quitAll": global("Mod+KeyQ"),

  "composer.attach": composer("Mod+KeyU"),
  "composer.shellMode": composer("Mod+Shift+KeyX"),
  "composer.shellExit": composer("Mod+Shift+KeyE"),
  "composer.background": composer("Alt+KeyB"),
  "composer.queueEditFirst": composer("Mod+ArrowUp"),
} as const satisfies Record<string, ShortcutDefinition>

export type ShortcutID = keyof typeof DEFAULT_KEYMAP
export type Keymap = Readonly<Record<ShortcutID, ShortcutDefinition>>

/**
 * While a terminal or the browser pane has focus it gets the keys first; only these stay live (03 §10: palette,
 * panel toggle, terminal toggle, tab switches), so the shell can use Ctrl+B, Ctrl+L, Ctrl+P.
 */
export const PASS_THROUGH_ALLOWED: ReadonlySet<ShortcutID> = new Set([
  "palette.open",
  "panel.toggle",
  "panel.terminal",
  "panel.review",
  "panel.files",
  "panel.browser",
  "panel.accounts",
  // 03 §4.1.1: moving between split panes works from a terminal too (and from a native browser view, whose shell
  // forwards these chords, own-desktop own-browser.ts).
  "pane.focus1",
  "pane.focus2",
  "pane.focus3",
  "pane.focus4",
  "pane.next",
  "pane.previous",
])

export interface Conflict {
  readonly chord: string
  readonly ids: readonly ShortcutID[]
}

/** Same chord in overlapping scopes (`global` overlaps everything). Shown in red in the help (03 §10). */
export function findConflicts(keymap: Keymap): Conflict[] {
  const byChord = new Map<string, { id: ShortcutID; scope: ShortcutScope }[]>()
  for (const [id, definition] of Object.entries(keymap) as [ShortcutID, ShortcutDefinition][])
    for (const chord of definition.chords) {
      const key = normalizeChord(chord)
      byChord.set(key, [...(byChord.get(key) ?? []), { id, scope: definition.scope }])
    }
  return [...byChord].flatMap(([chord, entries]) => {
    const clashing = entries.filter((entry, index) =>
      entries.some((other, otherIndex) => otherIndex !== index && overlaps(entry.scope, other.scope)),
    )
    return clashing.length ? [{ chord, ids: clashing.map((entry) => entry.id) }] : []
  })
}

function overlaps(a: ShortcutScope, b: ShortcutScope) {
  return a === "global" || b === "global" || a === b
}
