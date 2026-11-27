// Split panes (03 §4.1.1, 05 §8.5): the chords a native browser view hands to its window instead of the page.
import { describe, expect, test } from "bun:test"
import { paneChord } from "../src/main/pane-keys"

const input = (code: string, mods: { control?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
  type: "keyDown" as const,
  code,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
})

describe("pane chords from a native view", () => {
  test("F6, Shift+F6 and Ctrl+Alt+1–4 go to the window", () => {
    expect(paneChord(input("F6"))).toEqual({ code: "F6", ctrl: false, alt: false, shift: false })
    expect(paneChord(input("F6", { shift: true }))).toEqual({ code: "F6", ctrl: false, alt: false, shift: true })
    for (const digit of [1, 2, 3, 4])
      expect(paneChord(input(`Digit${digit}`, { control: true, alt: true }))).toEqual({
        code: `Digit${digit}`,
        ctrl: true,
        alt: true,
        shift: false,
      })
  })

  test("everything else stays with the page", () => {
    expect(paneChord(input("Digit5", { control: true, alt: true }))).toBeUndefined()
    expect(paneChord(input("Digit1", { control: true }))).toBeUndefined()
    expect(paneChord(input("Digit1", { control: true, alt: true, shift: true }))).toBeUndefined()
    expect(paneChord(input("F6", { control: true }))).toBeUndefined()
    expect(paneChord(input("F6", { meta: true }))).toBeUndefined()
    expect(paneChord(input("KeyA"))).toBeUndefined()
    expect(paneChord({ ...input("F6"), type: "keyUp" as const })).toBeUndefined()
  })
})
