export * as Keys from "./keys.js"

import { Result, Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/**
 * xdotool-style key names (the syntax models know from Anthropic's and OpenAI's computer tools) → Windows virtual-key
 * codes. `ctrl+shift+t`, `Return`, `KP_0`, `F13`, `Page_Down`, `super+e` and single characters all parse; names are
 * case-insensitive, so `ctrl+A` is ctrl+a (no implied shift).
 */

export const Modifier = Schema.Literals(["ctrl", "alt", "shift", "super"])
export type Modifier = typeof Modifier.Type

export const Key = Schema.Struct({
  name: Schema.String,
  vk: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 254 })),
  /** E0-prefixed scan code: arrows, Insert/Delete/Home/End/PgUp/PgDn, numpad Enter and Divide, the Windows keys. */
  extended: Schema.Boolean,
})
export type Key = typeof Key.Type

/** A character without a key of its own; sent as KEYEVENTF_UNICODE, so it is never composed by an IME. */
export const Unicode = Schema.Struct({ unicode: Schema.String })
export type Unicode = typeof Unicode.Type

export const Chord = Schema.Struct({
  /** Canonical order ctrl, alt, shift, super; pressed in this order and released in reverse. */
  modifiers: Schema.Array(Modifier),
  /** Absent for a modifier-only chord such as `shift` (click modifiers) or `super`. */
  key: optional(Schema.Union([Key, Unicode])),
})
export type Chord = typeof Chord.Type

/** At most this many space-separated chords in one `key` call. */
export const MAX_SEQUENCE = 16

/** The physical stop chord the helper registers with RegisterHotKey. We never inject it (it would stop ourselves). */
export const KILL_CHORD = "ctrl+alt+shift+q"

/**
 * Never sent. `super+r` opens the Run dialog and `super+x` the Win+X menu (Run, Terminal, Task Manager); the policy
 * also denies the Run dialog itself (an explorer.exe `#32770` dialog), which right-clicking Start still reaches.
 * Ctrl+Alt+Del is the secure attention sequence, which injected input cannot trigger, so it is refused loudly instead
 * of failing silently.
 */
export const DEFAULT_BLOCKED = ["super+r", "super+x", "ctrl+alt+delete", KILL_CHORD] as const

const MODIFIERS: Readonly<Record<string, Modifier>> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  ctrl_l: "ctrl",
  ctrl_r: "ctrl",
  alt: "alt",
  alt_l: "alt",
  alt_r: "alt",
  option: "alt",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
  super: "super",
  super_l: "super",
  super_r: "super",
  win: "super",
  windows: "super",
  cmd: "super",
  command: "super",
  meta: "super",
  meta_l: "super",
  meta_r: "super",
}

const ORDER: ReadonlyArray<Modifier> = ["ctrl", "alt", "shift", "super"]

export const MODIFIER_KEYS: Readonly<Record<Modifier, Key>> = {
  ctrl: { name: "ctrl", vk: 0x11, extended: false },
  alt: { name: "alt", vk: 0x12, extended: false },
  shift: { name: "shift", vk: 0x10, extended: false },
  super: { name: "super", vk: 0x5b, extended: true },
}

const named = (entries: ReadonlyArray<readonly [ReadonlyArray<string>, number, boolean?]>) =>
  entries.flatMap(([names, vk, extended]) =>
    names.map((name) => [name, { name: names[0]!, vk, extended: extended ?? false }] as const),
  )

/** Character keys of the US layout (the base of the Korean layout too); used with modifiers, e.g. `ctrl+minus`. */
const OEM = named([
  [["minus", "-"], 0xbd],
  [["equal", "="], 0xbb],
  [["plus", "+"], 0xbb],
  [["comma", ","], 0xbc],
  [["period", "."], 0xbe],
  [["slash", "/"], 0xbf],
  [["semicolon", ";"], 0xba],
  [["apostrophe", "quoteright", "'"], 0xde],
  [["bracketleft", "["], 0xdb],
  [["bracketright", "]"], 0xdd],
  [["backslash", "\\"], 0xdc],
  [["grave", "quoteleft", "`"], 0xc0],
])

const NAMED = new Map<string, Key>(
  [
    ...named([
      [["Return", "enter"], 0x0d],
      [["KP_Enter"], 0x0d, true],
      [["Tab"], 0x09],
      [["Escape", "esc"], 0x1b],
      [["BackSpace"], 0x08],
      [["Delete", "del"], 0x2e, true],
      [["Insert", "ins"], 0x2d, true],
      [["Home"], 0x24, true],
      [["End"], 0x23, true],
      [["Page_Up", "pageup", "prior", "pgup"], 0x21, true],
      [["Page_Down", "pagedown", "next", "pgdn"], 0x22, true],
      [["Left"], 0x25, true],
      [["Up"], 0x26, true],
      [["Right"], 0x27, true],
      [["Down"], 0x28, true],
      [["space"], 0x20],
      [["Caps_Lock", "capslock"], 0x14],
      [["Num_Lock", "numlock"], 0x90, true],
      [["Scroll_Lock", "scrolllock"], 0x91],
      [["Print", "printscreen", "sys_req"], 0x2c, true],
      [["Pause", "break"], 0x13],
      [["Menu", "apps"], 0x5d, true],
      [["Hangul"], 0x15],
      [["Hangul_Hanja", "hanja"], 0x19],
      [["KP_Multiply"], 0x6a],
      [["KP_Add"], 0x6b],
      [["KP_Subtract"], 0x6d],
      [["KP_Decimal"], 0x6e],
      [["KP_Divide"], 0x6f, true],
      [["XF86AudioMute"], 0xad, true],
      [["XF86AudioLowerVolume"], 0xae, true],
      [["XF86AudioRaiseVolume"], 0xaf, true],
      [["XF86AudioNext"], 0xb0, true],
      [["XF86AudioPrev"], 0xb1, true],
      [["XF86AudioStop"], 0xb2, true],
      [["XF86AudioPlay"], 0xb3, true],
    ]),
    ...Array.from(
      { length: 24 },
      (_, index) => [`f${index + 1}`, { name: `F${index + 1}`, vk: 0x70 + index, extended: false }] as const,
    ),
    ...Array.from(
      { length: 10 },
      (_, index) => [`kp_${index}`, { name: `KP_${index}`, vk: 0x60 + index, extended: false }] as const,
    ),
    ...OEM.filter(([name]) => name.length > 1),
  ].map(([name, key]) => [name.toLowerCase(), key]),
)

const CHARACTERS = new Map<string, Key>([
  ...Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(0x61 + index)
    return [letter, { name: letter, vk: 0x41 + index, extended: false }] as const
  }),
  ...Array.from(
    { length: 10 },
    (_, index) => [`${index}`, { name: `${index}`, vk: 0x30 + index, extended: false }] as const,
  ),
])

const SYMBOLS = new Map<string, Key>(OEM.filter(([name]) => name.length === 1))

/** Parses `text` as one or more space-separated chords, e.g. `ctrl+a ctrl+c` or `Down Down Return`. */
export function parse(text: string): Result.Result<ReadonlyArray<Chord>, string> {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "")
  if (tokens.length === 0) return Result.fail("Key text is empty")
  if (tokens.length > MAX_SEQUENCE) return Result.fail(`At most ${MAX_SEQUENCE} key combinations per call`)
  return Result.all(tokens.map(parseChord))
}

/** Parses a click/scroll modifier list such as `shift` or `ctrl+shift`; a non-modifier key is an error. */
export function parseModifiers(text: string): Result.Result<ReadonlyArray<Modifier>, string> {
  return Result.flatMap(parseChord(text.trim()), (chord) =>
    chord.key === undefined
      ? Result.succeed(chord.modifiers)
      : Result.fail(`"${text}" is not a modifier list; use shift, ctrl, alt, super or combinations like ctrl+shift`),
  )
}

export function parseChord(token: string): Result.Result<Chord, string> {
  // `+` separates keys, so a trailing `++` (or a lone `+`) names the plus key itself.
  const parts =
    token === "+" ? ["+"] : token.endsWith("++") ? [...token.slice(0, -2).split("+"), "+"] : token.split("+")
  if (parts.some((part) => part === "")) return Result.fail(`Invalid key combination "${token}"`)
  const last = parts[parts.length - 1]!
  const lastModifier = MODIFIERS[last.toLowerCase()]
  const names = lastModifier === undefined ? parts.slice(0, -1) : parts
  const unknown = names.find((name) => MODIFIERS[name.toLowerCase()] === undefined)
  if (unknown !== undefined)
    return Result.fail(
      `"${unknown}" in "${token}" is not a modifier (shift, ctrl, alt, super); only the last key may be another key`,
    )
  const modifiers = ORDER.filter((modifier) => names.some((name) => MODIFIERS[name.toLowerCase()] === modifier))
  if (lastModifier !== undefined) return Result.succeed({ modifiers })
  const key = keyOf(last, modifiers.length > 0)
  if (key === undefined) return Result.fail(`Unknown key "${last}" in "${token}"`)
  return Result.succeed({ modifiers, key })
}

/** Canonical text of a chord, e.g. `ctrl+shift+t`, used in audit entries and error messages. */
export function format(chord: Chord) {
  const key = chord.key === undefined ? [] : ["unicode" in chord.key ? chord.key.unicode : chord.key.name]
  return [...chord.modifiers, ...key].join("+")
}

/**
 * Whether `chord` is blocked by any entry of `blocked`: same key and at least the entry's modifiers, so adding a modifier
 * (`ctrl+alt+shift+delete`) does not get around a block.
 */
export function blocked(chord: Chord, list: ReadonlyArray<Chord>) {
  return list.some(
    (entry) => entry.modifiers.every((modifier) => chord.modifiers.includes(modifier)) && sameKey(entry.key, chord.key),
  )
}

/** Parses a configured block list; invalid entries are reported instead of being ignored silently. */
export function blockList(entries: ReadonlyArray<string>) {
  return Result.all(entries.map(parseChord))
}

/**
 * Whether `chord` only moves between or out of fields: Tab, Return, Escape, the arrows, Home/End and Page Up/Down,
 * alone or with shift, or a modifier alone. Everything else can enter or insert text: characters, and shortcuts that
 * paste (ctrl+v, shift+Insert) or open a panel that does (super+v). The password-field rule lets only these through.
 */
export function navigates(chord: Chord) {
  if (chord.key === undefined) return true
  if ("unicode" in chord.key) return false
  return NAVIGATION.has(chord.key.vk) && chord.modifiers.every((modifier) => modifier === "shift")
}

/**
 * Whether `chord` types one character into the focused field and nothing else (a letter, digit, symbol or space,
 * alone or with shift). Any other chord can move focus or switch windows, so the next step waits for that to settle.
 */
export function character(chord: Chord) {
  if (chord.key === undefined) return false
  if ("unicode" in chord.key) return true
  const vk = chord.key.vk
  const typed =
    vk === 0x20 ||
    (vk >= 0x30 && vk <= 0x39) ||
    (vk >= 0x41 && vk <= 0x5a) ||
    (vk >= 0x60 && vk <= 0x6f) ||
    (vk >= 0xba && vk <= 0xc0) ||
    (vk >= 0xdb && vk <= 0xde)
  return typed && chord.modifiers.every((modifier) => modifier === "shift")
}

// Tab, Return (and KP_Enter), Escape, Page Up/Down, End, Home, Left, Up, Right, Down.
const NAVIGATION: ReadonlySet<number> = new Set([0x09, 0x0d, 0x1b, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28])

function keyOf(name: string, withModifiers: boolean): Key | Unicode | undefined {
  const lower = name.toLowerCase()
  const key = NAMED.get(lower) ?? CHARACTERS.get(lower)
  if (key) return key
  if ([...name].length !== 1) return undefined
  // A bare symbol is typed as itself; with modifiers it is the US-layout key that carries it (`ctrl+-` zooms out).
  if (withModifiers) return SYMBOLS.get(name)
  return { unicode: name }
}

function sameKey(left: Chord["key"], right: Chord["key"]) {
  if (left === undefined || right === undefined) return left === undefined
  if ("unicode" in left || "unicode" in right)
    return "unicode" in left && "unicode" in right && left.unicode === right.unicode
  return left.vk === right.vk
}
