// 03 §12 automated IME cases: event orders A1, A2 (Chromium/Edge) and B (Safari) each send exactly once; the
// switcher/palette variant commits on the first Enter and applies on the next one; the composer's `보내는 키` choices
// (Enter or Ctrl+Enter sends) keep the same orders, with Enter as a plain new line under Ctrl+Enter.
import { describe, expect, test } from "bun:test"
import { createImeEnter, enterAction, type ImeKeyEvent, type SendKey } from "./ime-enter"

type KeyInit = Partial<Omit<ImeKeyEvent, "preventDefault">>

function key(init: KeyInit) {
  const event = {
    code: "Enter",
    key: "Enter",
    keyCode: 13,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    prevented: false,
    ...init,
    preventDefault() {
      event.prevented = true
    },
  }
  return event
}

const composingEnter = () => key({ key: "Process", keyCode: 229, isComposing: true })
const frame = () => new Promise((resolve) => setTimeout(resolve, 80))

function setup(commitOnly = false) {
  const sent: boolean[] = []
  const ime = createImeEnter({ onEnter: (modifier) => sent.push(modifier), commitOnly })
  return { ime, sent }
}

describe("createImeEnter (composer)", () => {
  test("A1: Enter during composition, commit, then a second Enter keydown → one send", async () => {
    const { ime, sent } = setup()
    ime.compositionstart()
    ime.input()
    const first = composingEnter()
    expect(ime.keydown(first)).toBe(true)
    expect(first.prevented).toBe(false) // the commit must not be blocked
    ime.compositionend()
    const second = key({})
    expect(ime.keydown(second)).toBe(true)
    expect(second.prevented).toBe(true)
    ime.keyup(second)
    await frame()
    expect(sent).toEqual([false])
  })

  test("A2: Enter during composition, commit, no second keydown → one send", async () => {
    const { ime, sent } = setup()
    ime.compositionstart()
    ime.keydown(composingEnter())
    ime.compositionend()
    await frame()
    expect(sent).toEqual([false])
  })

  test("A1 where the duplicate keydown arrives after the frame is still one send", async () => {
    const { ime, sent } = setup()
    ime.compositionstart()
    ime.keydown(composingEnter())
    ime.compositionend()
    await frame()
    const late = key({})
    ime.keydown(late)
    expect(late.prevented).toBe(true)
    expect(sent).toEqual([false])
  })

  test("B (Safari): commit, then keydown(Enter, 229, isComposing false) → one send", async () => {
    const { ime, sent } = setup()
    ime.compositionstart()
    ime.compositionend()
    const enter = key({ key: "Enter", keyCode: 229, isComposing: false })
    expect(ime.keydown(enter)).toBe(true)
    expect(enter.prevented).toBe(true)
    await frame()
    expect(sent).toEqual([false])
  })

  test("the next message after a commit-send sends again once there is new input", async () => {
    const { ime, sent } = setup()
    ime.compositionstart()
    ime.keydown(composingEnter())
    ime.compositionend()
    await frame()
    ime.compositionstart()
    ime.input()
    ime.compositionend()
    ime.input()
    ime.keydown(key({}))
    expect(sent).toEqual([false, false])
  })

  test("plain Enter sends at once; Shift+Enter is a newline; Ctrl+Enter reports the modifier", () => {
    const { ime, sent } = setup()
    ime.input()
    const shift = key({ shiftKey: true })
    expect(ime.keydown(shift)).toBe(false)
    expect(shift.prevented).toBe(false)
    ime.keydown(key({}))
    ime.input()
    ime.keydown(key({ ctrlKey: true }))
    expect(sent).toEqual([false, true])
  })

  test("NumpadEnter and synthetic events without code count as Enter", () => {
    const { ime, sent } = setup()
    ime.keydown(key({ code: "NumpadEnter" }))
    ime.input()
    ime.keydown(key({ code: "", key: "Enter" }))
    expect(sent).toEqual([false, false])
  })

  test("other keys during composition are left alone (rule 3)", () => {
    const { ime, sent } = setup()
    ime.compositionstart()
    for (const code of ["ArrowUp", "Tab", "Escape", "KeyK"]) {
      const event = key({ code, key: "Process", keyCode: 229, isComposing: true })
      expect(ime.keydown(event)).toBe(true)
      expect(event.prevented).toBe(false)
    }
    expect(sent).toEqual([])
  })

  test("auto-repeat Enter does not send twice", () => {
    const { ime, sent } = setup()
    ime.keydown(key({}))
    ime.keydown(key({ repeat: true }))
    expect(sent).toEqual([false])
  })
})

describe("createImeEnter (commitOnly: switcher and palette search)", () => {
  test("A1: the committing Enter and its duplicate keydown do not apply; the next press does", () => {
    const { ime, sent } = setup(true)
    ime.compositionstart()
    const commit = composingEnter()
    ime.keydown(commit)
    expect(commit.prevented).toBe(false)
    ime.compositionend()
    ime.keydown(key({}))
    ime.keyup(key({}))
    expect(sent).toEqual([])
    ime.keydown(key({}))
    expect(sent).toEqual([false])
  })

  test("A2: commit without a duplicate; the next press applies", () => {
    const { ime, sent } = setup(true)
    ime.compositionstart()
    ime.keydown(composingEnter())
    ime.compositionend()
    ime.keyup(key({}))
    ime.keydown(key({}))
    expect(sent).toEqual([false])
  })

  test("B (Safari): the 229 Enter after compositionend only commits", () => {
    const { ime, sent } = setup(true)
    ime.compositionstart()
    ime.compositionend()
    const commit = key({ keyCode: 229 })
    ime.keydown(commit)
    expect(commit.prevented).toBe(true)
    ime.keyup(commit)
    expect(sent).toEqual([])
    ime.keydown(key({}))
    expect(sent).toEqual([false])
  })
})

describe("enterAction (보내는 키, 03 §4.6)", () => {
  test("Enter로 보내기: Enter sends, Ctrl/⌘+Enter is the other delivery, Shift/Alt+Enter are no send", () => {
    expect(enterAction(key({}))).toBe("send")
    expect(enterAction(key({ code: "NumpadEnter" }))).toBe("send")
    expect(enterAction(key({ ctrlKey: true }))).toBe("other")
    expect(enterAction(key({ metaKey: true }))).toBe("other")
    expect(enterAction(key({ shiftKey: true }))).toBeUndefined()
    expect(enterAction(key({ altKey: true }))).toBeUndefined()
    expect(enterAction(key({ ctrlKey: true, shiftKey: true }))).toBeUndefined() // the dock focus key (03 §10)
    expect(enterAction(key({ code: "KeyA", key: "a" }))).toBeUndefined()
  })

  test("Ctrl+Enter로 보내기: Ctrl/⌘+Enter sends, Alt+Enter is the other delivery, Enter and Shift+Enter break lines", () => {
    expect(enterAction(key({}), "modEnter")).toBeUndefined()
    expect(enterAction(key({ shiftKey: true }), "modEnter")).toBeUndefined()
    expect(enterAction(key({ ctrlKey: true }), "modEnter")).toBe("send")
    expect(enterAction(key({ metaKey: true }), "modEnter")).toBe("send")
    expect(enterAction(key({ code: "NumpadEnter", ctrlKey: true }), "modEnter")).toBe("send")
    expect(enterAction(key({ altKey: true }), "modEnter")).toBe("other")
    expect(enterAction(key({ ctrlKey: true, altKey: true }), "modEnter")).toBeUndefined()
    expect(enterAction(key({ ctrlKey: true, shiftKey: true }), "modEnter")).toBeUndefined()
    expect(enterAction(key({ altKey: true, shiftKey: true }), "modEnter")).toBeUndefined()
  })
})

describe("createImeEnter (sendKey: Ctrl+Enter로 보내기)", () => {
  function setupMod() {
    const sent: boolean[] = []
    let mode: SendKey = "modEnter"
    const ime = createImeEnter({ onEnter: (modifier) => sent.push(modifier), sendKey: () => mode })
    return { ime, sent, setMode: (next: SendKey) => void (mode = next) }
  }

  test("Enter and Shift+Enter are left to the textarea (a new line): not handled, not prevented, no send", () => {
    const { ime, sent } = setupMod()
    ime.input()
    for (const event of [key({}), key({ shiftKey: true }), key({ code: "NumpadEnter" })]) {
      expect(ime.keydown(event)).toBe(false)
      expect(event.prevented).toBe(false)
    }
    expect(sent).toEqual([])
  })

  test("Ctrl+Enter and ⌘+Enter send the setting's way; Alt+Enter the other delivery; auto-repeat does not", () => {
    const { ime, sent } = setupMod()
    const ctrl = key({ ctrlKey: true })
    expect(ime.keydown(ctrl)).toBe(true)
    expect(ctrl.prevented).toBe(true)
    ime.input()
    ime.keydown(key({ metaKey: true }))
    ime.input()
    const alt = key({ altKey: true })
    ime.keydown(alt)
    expect(alt.prevented).toBe(true)
    ime.keydown(key({ altKey: true, repeat: true }))
    expect(sent).toEqual([false, false, true])
  })

  test("Enter during a composition only commits (A1 duplicate keydown is a new line, never a send)", async () => {
    const { ime, sent } = setupMod()
    ime.compositionstart()
    ime.input()
    const commit = composingEnter()
    expect(ime.keydown(commit)).toBe(true)
    expect(commit.prevented).toBe(false)
    expect(ime.awaitingCommit()).toBe(false)
    ime.compositionend()
    const duplicate = key({})
    expect(ime.keydown(duplicate)).toBe(false)
    expect(duplicate.prevented).toBe(false)
    await frame()
    expect(sent).toEqual([])
  })

  test("Safari (B): the 229 Enter after compositionend is no send either", async () => {
    const { ime, sent } = setupMod()
    ime.compositionstart()
    ime.compositionend()
    const enter = key({ keyCode: 229 })
    expect(ime.keydown(enter)).toBe(true)
    expect(enter.prevented).toBe(false)
    await frame()
    expect(sent).toEqual([])
  })

  test("A1: Ctrl+Enter during a composition sends once after the commit; the duplicate keydown is dropped", async () => {
    const { ime, sent } = setupMod()
    ime.compositionstart()
    ime.input()
    const first = key({ key: "Process", keyCode: 229, isComposing: true, ctrlKey: true })
    expect(ime.keydown(first)).toBe(true)
    expect(first.prevented).toBe(false) // the commit must not be blocked
    expect(ime.awaitingCommit()).toBe(true)
    ime.compositionend()
    expect(ime.awaitingCommit()).toBe(false)
    const duplicate = key({ ctrlKey: true })
    expect(ime.keydown(duplicate)).toBe(true)
    expect(duplicate.prevented).toBe(true)
    await frame()
    expect(sent).toEqual([false])
  })

  test("A2: Alt+Enter during a composition, commit without a second keydown → one send, the other delivery", async () => {
    const { ime, sent } = setupMod()
    ime.compositionstart()
    ime.keydown(key({ key: "Process", keyCode: 229, isComposing: true, altKey: true }))
    ime.compositionend()
    await frame()
    expect(sent).toEqual([true])
  })

  test("B (Safari): commit, then keydown(Alt+Enter, 229) → one send with the other delivery", async () => {
    const { ime, sent } = setupMod()
    ime.compositionstart()
    ime.compositionend()
    const enter = key({ keyCode: 229, altKey: true })
    expect(ime.keydown(enter)).toBe(true)
    expect(enter.prevented).toBe(true)
    await frame()
    expect(sent).toEqual([true])
  })

  test("the setting is read on every keydown: switching back makes Enter send again", () => {
    const { ime, sent, setMode } = setupMod()
    expect(ime.keydown(key({}))).toBe(false)
    setMode("enter")
    expect(ime.keydown(key({}))).toBe(true)
    ime.input()
    ime.keydown(key({ ctrlKey: true }))
    expect(sent).toEqual([false, true])
  })

  test("without a sendKey (titles, search boxes, dialogs) Alt+Enter stays untouched", () => {
    const { ime, sent } = setup()
    const alt = key({ altKey: true })
    expect(ime.keydown(alt)).toBe(false)
    expect(alt.prevented).toBe(false)
    expect(sent).toEqual([])
  })
})
