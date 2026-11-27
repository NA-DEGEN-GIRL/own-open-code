import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { Keys } from "../../src/core/keys.js"

const chord = (text: string) => Result.getOrThrow(Keys.parseChord(text))
const sequence = (text: string) => Result.getOrThrow(Keys.parse(text))
const error = (result: Result.Result<unknown, string>) => {
  if (Result.isSuccess(result)) throw new Error("expected a parse failure")
  return result.failure
}
const blockedList = Result.getOrThrow(Keys.blockList(Keys.DEFAULT_BLOCKED))
const isBlocked = (text: string) => Keys.blocked(chord(text), blockedList)

describe("chord parsing", () => {
  test("modifiers come out in canonical order with their virtual keys", () => {
    expect(chord("ctrl+shift+t")).toEqual({
      modifiers: ["ctrl", "shift"],
      key: { name: "t", vk: 0x54, extended: false },
    })
    expect(chord("shift+ctrl+T")).toEqual(chord("ctrl+shift+t"))
    expect(chord("super+alt+ctrl+shift+a").modifiers).toEqual(["ctrl", "alt", "shift", "super"])
    expect(chord("ctrl+ctrl+a").modifiers).toEqual(["ctrl"])
    expect(Keys.MODIFIER_KEYS.super).toEqual({ name: "super", vk: 0x5b, extended: true })
  })

  test.each([
    ["cmd+r", "super"],
    ["win+r", "super"],
    ["Meta+r", "super"],
    ["windows+r", "super"],
    ["control+r", "ctrl"],
    ["Control_L+r", "ctrl"],
    ["ctl+r", "ctrl"],
    ["Alt_R+r", "alt"],
    ["option+r", "alt"],
    ["Shift_L+r", "shift"],
  ] as const)("%s uses the %s modifier", (text, modifier) => {
    expect(chord(text).modifiers).toEqual([modifier])
  })

  test.each([
    ["Return", 0x0d, false],
    ["enter", 0x0d, false],
    ["KP_Enter", 0x0d, true],
    ["Tab", 0x09, false],
    ["Escape", 0x1b, false],
    ["esc", 0x1b, false],
    ["BackSpace", 0x08, false],
    ["Delete", 0x2e, true],
    ["Home", 0x24, true],
    ["End", 0x23, true],
    ["Page_Up", 0x21, true],
    ["Prior", 0x21, true],
    ["Page_Down", 0x22, true],
    ["Next", 0x22, true],
    ["Left", 0x25, true],
    ["Up", 0x26, true],
    ["Right", 0x27, true],
    ["Down", 0x28, true],
    ["space", 0x20, false],
    ["F1", 0x70, false],
    ["F12", 0x7b, false],
    ["F24", 0x87, false],
    ["KP_0", 0x60, false],
    ["KP_9", 0x69, false],
    ["KP_Divide", 0x6f, true],
    ["Print", 0x2c, true],
    ["Menu", 0x5d, true],
    ["Hangul", 0x15, false],
    ["Hangul_Hanja", 0x19, false],
    ["XF86AudioMute", 0xad, true],
    ["a", 0x41, false],
    ["Z", 0x5a, false],
    ["7", 0x37, false],
    ["minus", 0xbd, false],
    ["bracketleft", 0xdb, false],
  ] as const)("%s → vk %d (extended %s)", (name, vk, extended) => {
    expect(chord(name).key).toMatchObject({ vk, extended })
    expect(chord(`ctrl+${name}`).key).toMatchObject({ vk, extended })
  })

  test("bare symbols are typed as themselves; with modifiers they name the US-layout key", () => {
    expect(chord("+").key).toEqual({ unicode: "+" })
    expect(chord("!").key).toEqual({ unicode: "!" })
    expect(chord("가").key).toEqual({ unicode: "가" })
    expect(chord("ctrl++").key).toMatchObject({ vk: 0xbb })
    expect(chord("ctrl+plus").key).toMatchObject({ vk: 0xbb })
    expect(chord("ctrl+-").key).toMatchObject({ vk: 0xbd })
    expect(chord("ctrl+/").key).toMatchObject({ vk: 0xbf })
    expect(error(Keys.parseChord("ctrl+가"))).toContain("Unknown key")
    expect(error(Keys.parseChord("ctrl+!"))).toContain("Unknown key")
  })

  test("modifier-only chords have no key", () => {
    expect(chord("shift")).toEqual({ modifiers: ["shift"] })
    expect(chord("ctrl+alt")).toEqual({ modifiers: ["ctrl", "alt"] })
    expect(Result.getOrThrow(Keys.parseModifiers("shift+ctrl"))).toEqual(["ctrl", "shift"])
    expect(error(Keys.parseModifiers("ctrl+a"))).toContain("not a modifier list")
  })

  test("malformed chords are refused with a reason", () => {
    expect(error(Keys.parseChord("ctrl+"))).toContain("Invalid key combination")
    expect(error(Keys.parseChord("+ctrl"))).toContain("Invalid key combination")
    expect(error(Keys.parseChord("foo+a"))).toContain('"foo"')
    expect(error(Keys.parseChord("a+b"))).toContain("not a modifier")
    expect(error(Keys.parseChord("Foo_Bar"))).toContain('Unknown key "Foo_Bar"')
    expect(error(Keys.parseChord("F25"))).toContain("Unknown key")
  })

  test("sequences split on whitespace and are bounded", () => {
    expect(sequence("ctrl+a ctrl+c")).toHaveLength(2)
    expect(sequence("  Down \t Down  Return ")).toHaveLength(3)
    expect(sequence(Array.from({ length: Keys.MAX_SEQUENCE }, () => "a").join(" "))).toHaveLength(Keys.MAX_SEQUENCE)
    expect(error(Keys.parse(Array.from({ length: Keys.MAX_SEQUENCE + 1 }, () => "a").join(" ")))).toContain("At most")
    expect(error(Keys.parse("   "))).toContain("empty")
    expect(error(Keys.parse("ctrl+a nope"))).toContain("nope")
  })

  test("format prints the canonical chord", () => {
    expect(Keys.format(chord("Shift+Control+t"))).toBe("ctrl+shift+t")
    expect(Keys.format(chord("Return"))).toBe("Return")
    expect(Keys.format(chord("가"))).toBe("가")
    expect(Keys.format(chord("alt"))).toBe("alt")
  })
})

describe("blocked chords", () => {
  test.each([
    "super+r",
    "win+R",
    "cmd+r",
    "super+shift+r",
    "super+x",
    "win+X",
    "ctrl+alt+delete",
    "ctrl+alt+Delete",
    "ctrl+alt+del",
    "ctrl+alt+shift+delete",
    Keys.KILL_CHORD,
    "shift+alt+ctrl+Q",
    "ctrl+alt+shift+super+q",
  ])("%s is blocked", (text) => {
    expect(isBlocked(text)).toBe(true)
  })

  test.each([
    "r",
    "super",
    "super+e",
    "x",
    "ctrl+r",
    "ctrl+alt+q",
    "alt+shift+q",
    "ctrl+delete",
    "alt+F4",
    "ctrl+shift+Escape",
  ])("%s is allowed", (text) => {
    expect(isBlocked(text)).toBe(false)
  })

  test("a modifier-only block entry blocks every chord with those modifiers", () => {
    const list = Result.getOrThrow(Keys.blockList(["super"]))
    expect(Keys.blocked(chord("super+e"), list)).toBe(true)
    expect(Keys.blocked(chord("super"), list)).toBe(true)
    expect(Keys.blocked(chord("ctrl+e"), list)).toBe(false)
  })

  test("configured block lists reject invalid entries", () => {
    expect(Result.isFailure(Keys.blockList(["super+r", "hyper+x"]))).toBe(true)
  })
})

describe("navigates", () => {
  // The password-field rule lets only these through: nothing that can enter or insert text, including pastes.
  test.each([
    ["Tab", true],
    ["shift+Tab", true],
    ["Return", true],
    ["KP_Enter", true],
    ["Escape", true],
    ["Left", true],
    ["shift+End", true],
    ["Page_Down", true],
    ["shift", true],
    ["super", true],
    ["a", false],
    ["shift+a", false],
    ["가", false],
    ["space", false],
    ["BackSpace", false],
    ["Delete", false],
    ["ctrl+v", false],
    ["ctrl+shift+v", false],
    ["shift+Insert", false],
    ["super+v", false],
    ["ctrl+Tab", false],
    ["alt+Tab", false],
    ["ctrl+a", false],
  ] as const)("%s → %s", (text, expected) => {
    expect(Keys.navigates(chord(text))).toBe(expected)
  })
})

describe("character", () => {
  // Any other chord can move focus, so the step after it waits for that to settle before it is checked.
  test.each([
    ["a", true],
    ["shift+a", true],
    ["7", true],
    ["space", true],
    ["KP_5", true],
    ["minus", true],
    ["가", true],
    ["+", true],
    ["ctrl+a", false],
    ["alt+a", false],
    ["super+a", false],
    ["Return", false],
    ["Tab", false],
    ["alt+Tab", false],
    ["BackSpace", false],
    ["F5", false],
    ["shift", false],
  ] as const)("%s → %s", (text, expected) => {
    expect(Keys.character(chord(text))).toBe(expected)
  })
})
