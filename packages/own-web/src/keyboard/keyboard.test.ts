import { describe, expect, test } from "bun:test"
import { chordLabel, chordOf, eventCode, normalizeChord } from "./chord"
import { DEFAULT_KEYMAP, findConflicts, type Keymap } from "./keymap"
import { createShortcutRegistry, type ShortcutKeyEvent } from "./registry"

function press(init: Partial<ShortcutKeyEvent> & { code: string }) {
  const event = {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    target: null as EventTarget | null,
    defaultPrevented: false,
    prevented: false,
    stopped: false,
    ...init,
    preventDefault() {
      event.prevented = true
    },
    stopPropagation() {
      event.stopped = true
    },
  }
  return event
}

describe("chords", () => {
  test("event.code wins; key fallback only without code; Process is ignored", () => {
    expect(eventCode({ code: "KeyK", key: "Process" })).toBe("KeyK")
    expect(eventCode({ code: "", key: "k" })).toBe("KeyK")
    expect(eventCode({ code: "", key: "." })).toBe("Period")
    expect(eventCode({ code: "", key: "Process" })).toBe("")
    expect(eventCode({ code: "", key: "7" })).toBe("Digit7")
  })

  test("Mod is Ctrl on Windows and ⌘ on macOS", () => {
    const event = press({ code: "Period", ctrlKey: true, shiftKey: true })
    expect(chordOf(event, false)).toBe("Mod+Shift+Period")
    expect(chordOf({ ...event, ctrlKey: false, metaKey: true }, true)).toBe("Mod+Shift+Period")
    expect(chordOf(event, true)).toBe("Ctrl+Shift+Period")
    expect(normalizeChord("Shift+Alt+Mod+KeyB")).toBe("Mod+Alt+Shift+KeyB")
    expect(chordLabel("Mod+Shift+KeyR", false)).toBe("Ctrl+Shift+R")
    expect(chordLabel("Mod+Backquote", true)).toBe("⌘+`")
  })
})

describe("keymap (03 §10)", () => {
  test("the default keymap has no conflicts", () => {
    expect(findConflicts(DEFAULT_KEYMAP)).toEqual([])
  })

  test("conflicts are found across overlapping scopes only", () => {
    const keymap = {
      ...DEFAULT_KEYMAP,
      "composer.attach": { chords: ["Mod+KeyK"], scope: "composer" },
    } as Keymap
    expect(findConflicts(keymap)).toEqual([{ chord: "Mod+KeyK", ids: ["palette.open", "composer.attach"] }])
  })

  test("decisions against upstream: Ctrl+B sidebar, Alt+B background, Ctrl+. switcher, Ctrl+Shift+L add selection", () => {
    expect(DEFAULT_KEYMAP["sidebar.toggle"].chords).toEqual(["Mod+KeyB"])
    expect(DEFAULT_KEYMAP["composer.background"].chords).toEqual(["Alt+KeyB"])
    expect(DEFAULT_KEYMAP["switcher.open"].chords).toEqual(["Mod+Period", "Mod+Quote"])
    expect(DEFAULT_KEYMAP["agent.cycle"].chords).toEqual(["Mod+Shift+Period"])
    expect(DEFAULT_KEYMAP["context.addSelection"].chords).toEqual(["Mod+Shift+KeyL"])
    expect(DEFAULT_KEYMAP["panel.toggle"].chords).toEqual(["Mod+Alt+KeyB"])
  })
})

describe("registry", () => {
  function setup() {
    const registry = createShortcutRegistry({ mac: false })
    const ran: string[] = []
    registry.register("sidebar.toggle", () => void ran.push("sidebar"))
    registry.register("palette.open", () => void ran.push("palette"))
    registry.register("composer.attach", () => void ran.push("attach"))
    registry.register("file.open", () => void ran.push("file"))
    return { registry, ran }
  }

  function inside(keys: string) {
    const host = document.createElement("div")
    host.setAttribute("data-own-keys", keys)
    const child = document.createElement("textarea")
    host.append(child)
    document.body.append(host)
    return child
  }

  test("runs by code and prevents the browser default (e.g. Ctrl+P print)", () => {
    const { registry, ran } = setup()
    const event = press({ code: "KeyP", key: "p", ctrlKey: true })
    expect(registry.handle(event)).toBe("file.open")
    expect(event.prevented).toBe(true)
    expect(ran).toEqual(["file"])
  })

  test("nothing fires during IME composition (isComposing or keyCode 229)", () => {
    const { registry, ran } = setup()
    expect(registry.handle(press({ code: "KeyK", ctrlKey: true, isComposing: true }))).toBeUndefined()
    expect(registry.handle(press({ code: "KeyK", ctrlKey: true, keyCode: 229 }))).toBeUndefined()
    expect(ran).toEqual([])
  })

  test("Ctrl+B stays with text editing in the composer; composer-scope ids only live there", () => {
    const { registry, ran } = setup()
    const composer = inside("composer")
    expect(registry.handle(press({ code: "KeyB", ctrlKey: true, target: composer }))).toBeUndefined()
    expect(registry.handle(press({ code: "KeyU", ctrlKey: true }))).toBeUndefined()
    expect(registry.handle(press({ code: "KeyU", ctrlKey: true, target: composer }))).toBe("composer.attach")
    expect(registry.handle(press({ code: "KeyB", ctrlKey: true }))).toBe("sidebar.toggle")
    expect(ran).toEqual(["attach", "sidebar"])
  })

  test("a terminal or browser pane keeps its keys except palette, panel and tab switches", () => {
    const { registry, ran } = setup()
    const terminal = inside("terminal")
    expect(registry.handle(press({ code: "KeyB", ctrlKey: true, target: terminal }))).toBeUndefined()
    expect(registry.handle(press({ code: "KeyP", ctrlKey: true, target: terminal }))).toBeUndefined()
    expect(registry.handle(press({ code: "KeyK", ctrlKey: true, target: terminal }))).toBe("palette.open")
    expect(ran).toEqual(["palette"])
  })

  test("the latest active registration wins, `when` gates it, and release restores the previous one", () => {
    const registry = createShortcutRegistry({ mac: false })
    const ran: string[] = []
    registry.register("panel.toggle", () => void ran.push("first"))
    const enabled = { value: false }
    const release = registry.register("panel.toggle", () => void ran.push("second"), { when: () => enabled.value })
    registry.handle(press({ code: "KeyB", ctrlKey: true, altKey: true }))
    enabled.value = true
    registry.handle(press({ code: "KeyB", ctrlKey: true, altKey: true }))
    release()
    registry.handle(press({ code: "KeyB", ctrlKey: true, altKey: true }))
    expect(ran).toEqual(["first", "second", "first"])
  })

  test("a handler returning false lets the event through", () => {
    const registry = createShortcutRegistry({ mac: false })
    registry.register("session.find", () => false)
    const event = press({ code: "KeyF", ctrlKey: true })
    expect(registry.handle(event)).toBeUndefined()
    expect(event.prevented).toBe(false)
  })
})
