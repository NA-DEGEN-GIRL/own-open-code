import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createShortcutRegistry, gated } from "@/keyboard"
import { composerInputID, inFocusedPane } from "./pane-context"

function key(code: string, extra: Partial<KeyboardEvent> = {}) {
  return {
    code,
    key: code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    target: document.body,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  }
}

describe("split pane focus (03 §4.1.1)", () => {
  test("shortcuts registered inside a pane run only for the focused pane, whichever registered last", () => {
    const registry = createShortcutRegistry()
    const [focused, setFocused] = createSignal("p1")
    const ran: string[] = []
    // What useShortcut does inside each pane's ShortcutGate (keyboard/index.tsx).
    for (const pane of ["p1", "p2"])
      registry.register(
        "composer.focus",
        () => void ran.push(pane),
        gated(() => focused() === pane),
      )
    // An ungated registration (outside panes) keeps its own condition.
    expect(gated(undefined, { when: () => false })?.when?.()).toBe(false)
    expect(registry.handle(key("KeyL", { ctrlKey: true }))).toBe("composer.focus")
    setFocused("p2")
    registry.handle(key("KeyL", { ctrlKey: true }))
    setFocused("none")
    expect(registry.handle(key("KeyL", { ctrlKey: true }))).toBeUndefined()
    expect(ran).toEqual(["p1", "p2"])
  })

  test("only the focused pane's composer is #own-composer-input; lookups prefer the focused pane", () => {
    expect(composerInputID(undefined)).toBe("own-composer-input")
    expect(composerInputID({ id: "p2", focused: () => true, visible: () => true })).toBe("own-composer-input")
    expect(composerInputID({ id: "p3", focused: () => false, visible: () => true })).toBe("own-composer-input-p3")
    document.body.innerHTML =
      '<section data-pane-id="p1"><button data-testid="composer-switcher" id="a"></button></section>' +
      '<section data-pane-id="p2" data-pane-focused><button data-testid="composer-switcher" id="b"></button></section>'
    expect(inFocusedPane('[data-testid="composer-switcher"]')?.id).toBe("b")
    document.body.innerHTML = '<button data-testid="composer-switcher" id="c"></button>'
    expect(inFocusedPane('[data-testid="composer-switcher"]')?.id).toBe("c")
    document.body.innerHTML = ""
  })
})
