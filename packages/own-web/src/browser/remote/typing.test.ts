// The hidden field's typing glue (05 §8.10.3): Korean composition as browsers report it, backspace on a field that is
// never empty, Enter and the other real keys, chords, the reset to the rest text.
import { describe, expect, test } from "bun:test"
import { RemoteBrowser } from "@own/protocol/remote-browser"
import { createTyping, REST, type KeyPress } from "./typing"

function field() {
  const sent: RemoteBrowser.InputEvent[] = []
  const typing = createTyping({ send: (events) => sent.push(...events) })
  const state = { value: typing.reset() }
  const apply = (next: string | undefined) => {
    if (next !== undefined) state.value = next
  }
  return {
    sent,
    typing,
    state,
    /** The events sent since the last look. */
    take: () => sent.splice(0),
    /** An `input` event after the field's text became `REST + text`. */
    input(text: string) {
      state.value = REST + text
      apply(typing.changed(state.value))
    },
    /** One IME step: the composing segment after the committed text. */
    compose(committed: string, segment: string) {
      typing.compositionUpdate(segment)
      state.value = REST + committed + segment
      apply(typing.changed(state.value))
    },
    /** The composition ends with `text` in the field (`compositionend`, then the browser's `input`). */
    commit(text: string) {
      state.value = REST + text
      typing.compositionEnd()
      apply(typing.changed(state.value))
      apply(typing.changed(state.value))
    },
  }
}

const key = (name: string, over: Partial<KeyPress> = {}): KeyPress => ({
  key: name,
  keyCode: 0,
  isComposing: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...over,
})

describe("Korean composition", () => {
  test("한글: each syllable is composed on the page, then committed as text", () => {
    const f = field()
    f.typing.compositionStart()
    f.compose("", "ㅎ")
    f.compose("", "하")
    f.compose("", "한")
    expect(f.take()).toEqual([
      { k: "compose", text: "ㅎ" },
      { k: "compose", text: "하" },
      { k: "compose", text: "한" },
    ])
    // The next consonant commits 한 and starts a new syllable.
    f.commit("한")
    f.typing.compositionStart()
    f.compose("한", "ㄱ")
    f.compose("한", "그")
    f.compose("한", "글")
    const second = f.take()
    expect(second).toEqual([
      { k: "text", text: "한" },
      { k: "compose", text: "ㄱ" },
      { k: "compose", text: "그" },
      { k: "compose", text: "글" },
    ])
    f.commit("한글")
    const last = f.take()
    expect(last).toEqual([{ k: "text", text: "글" }])
    for (const event of [...second, ...last]) expect(RemoteBrowser.parseInputEvent(event)).toEqual(event)
  })

  test("backspace inside a syllable shrinks it; removing its last part cancels the composition", () => {
    const f = field()
    f.typing.compositionStart()
    f.compose("", "한")
    f.compose("", "하")
    f.compose("", "ㅎ")
    expect(f.take()).toEqual([
      { k: "compose", text: "한" },
      { k: "compose", text: "하" },
      { k: "compose", text: "ㅎ" },
    ])
    // The keyboard ends the composition with nothing left in the field.
    f.commit("")
    expect(f.take()).toEqual([{ k: "compose", text: "" }])
  })

  test("a keyboard that takes committed text back into its composition does not lose it", () => {
    const f = field()
    f.input("hello")
    f.take()
    // Gboard after a tap into the word: the composing region covers `hello`, then a letter is added.
    f.typing.compositionStart()
    f.compose("", "hellox")
    expect(f.take()).toEqual([
      ...Array.from({ length: 5 }, (): RemoteBrowser.InputEvent => ({ k: "key", key: "Backspace" })),
      { k: "compose", text: "hellox" },
    ])
    f.commit("hellox")
    expect(f.take()).toEqual([{ k: "text", text: "hellox" }])
  })

  test("a composition that the field does not end with is taken as committed text", () => {
    const f = field()
    f.typing.compositionStart()
    f.typing.compositionUpdate("가")
    f.state.value = `${REST}가나`
    f.typing.changed(f.state.value)
    expect(f.take()).toEqual([{ k: "text", text: "가나" }])
  })
})

describe("plain typing and backspace", () => {
  test("typed text is the difference; a deleted letter is a backspace", () => {
    const f = field()
    f.input("a")
    f.input("ab")
    f.input("a")
    f.input("a ")
    expect(f.take()).toEqual([
      { k: "text", text: "a" },
      { k: "text", text: "b" },
      { k: "key", key: "Backspace" },
      { k: "text", text: " " },
    ])
  })

  test("backspace with nothing typed still reaches the page: the field rests on text it can delete", () => {
    const f = field()
    expect(f.state.value).toBe(REST)
    f.state.value = REST.slice(0, -1)
    const next = f.typing.changed(f.state.value)
    expect(f.take()).toEqual([{ k: "key", key: "Backspace" }])
    // … and goes back to the rest text, so the next backspace has something to delete too.
    expect(next).toBe(REST)
    f.state.value = REST.slice(0, -1)
    f.typing.changed(f.state.value)
    expect(f.take()).toEqual([{ k: "key", key: "Backspace" }])
  })

  test("an autocorrection replaces the word on the page", () => {
    const f = field()
    f.input("teh")
    f.take()
    f.input("the ")
    expect(f.take()).toEqual([
      { k: "key", key: "Backspace" },
      { k: "key", key: "Backspace" },
      { k: "text", text: "he " },
    ])
  })

  test("the field is reset once it grew long and nothing is composing, never inside a composition", () => {
    const f = field()
    const long = "x".repeat(40)
    f.typing.compositionStart()
    f.typing.compositionUpdate(long)
    f.state.value = REST + long
    expect(f.typing.changed(f.state.value)).toBeUndefined()
    f.typing.compositionEnd()
    expect(f.typing.changed(f.state.value)).toBe(REST)
    f.take()
    // After the reset typing goes on from the rest text.
    f.input("y")
    expect(f.take()).toEqual([{ k: "text", text: "y" }])
  })

  test("a line break that reaches the field is the Enter key", () => {
    const f = field()
    f.input("ok\n")
    expect(f.take()).toEqual([
      { k: "text", text: "ok" },
      { k: "key", key: "Enter" },
    ])
    f.input("ok\n\nnext")
    expect(f.take()).toEqual([
      { k: "key", key: "Enter" },
      { k: "text", text: "next" },
    ])
  })
})

describe("real keys", () => {
  test("Enter and the named keys go as keys and never into the field", () => {
    const f = field()
    expect(f.typing.key(key("Enter", { keyCode: 13 }))).toBe(true)
    expect(f.typing.key(key("ArrowLeft", { keyCode: 37, shiftKey: true }))).toBe(true)
    expect(f.typing.key(key("Tab", { keyCode: 9 }))).toBe(true)
    expect(f.typing.key(key("Escape", { keyCode: 27 }))).toBe(true)
    expect(f.take()).toEqual([
      { k: "key", key: "Enter" },
      { k: "key", key: "ArrowLeft", shift: true },
      { k: "key", key: "Tab" },
      { k: "key", key: "Escape" },
    ])
  })

  test("a soft keyboard's keys (229) and keys inside a composition are left to the field", () => {
    const f = field()
    expect(f.typing.key(key("Unidentified", { keyCode: 229 }))).toBe(false)
    expect(f.typing.key(key("Enter", { keyCode: 229 }))).toBe(false)
    expect(f.typing.key(key("Enter", { keyCode: 13, isComposing: true }))).toBe(false)
    expect(f.take()).toEqual([])
  })

  test("Backspace, the space bar and letters are counted once, as the field's change", () => {
    const f = field()
    expect(f.typing.key(key("Backspace", { keyCode: 8 }))).toBe(false)
    expect(f.typing.key(key(" ", { keyCode: 32 }))).toBe(false)
    expect(f.typing.key(key("a", { keyCode: 65 }))).toBe(false)
    expect(f.take()).toEqual([])
  })

  test("Ctrl/⌘+A, Z and Y are chords; other Ctrl letters are not sent", () => {
    const f = field()
    for (const letter of ["a", "Z", "y"]) expect(f.typing.key(key(letter, { ctrlKey: true, keyCode: 65 }))).toBe(true)
    expect(f.typing.key(key("z", { metaKey: true, shiftKey: true, keyCode: 90 }))).toBe(true)
    expect(f.typing.key(key("s", { ctrlKey: true, keyCode: 83 }))).toBe(false)
    const sent = f.take()
    expect(sent).toEqual([
      { k: "key", key: "a", ctrl: true },
      { k: "key", key: "z", ctrl: true },
      { k: "key", key: "y", ctrl: true },
      { k: "key", key: "z", shift: true, meta: true },
    ])
    for (const event of sent) expect(RemoteBrowser.parseInputEvent(event)).toEqual(event)
  })
})

describe("the clipboard is the device's, never the PC's", () => {
  test("Ctrl/⌘+C and X are swallowed: nothing is sent, and the field does not take them", () => {
    const f = field()
    for (const letter of ["c", "C", "x", "X"]) {
      expect(f.typing.key(key(letter, { ctrlKey: true, keyCode: 67 }))).toBe(true)
      expect(f.typing.key(key(letter, { metaKey: true, keyCode: 67 }))).toBe(true)
    }
    expect(f.take()).toEqual([])
  })

  test("Ctrl/⌘+V is left to the field: no chord goes to the PC", () => {
    const f = field()
    expect(f.typing.key(key("v", { ctrlKey: true, keyCode: 86 }))).toBe(false)
    expect(f.typing.key(key("V", { metaKey: true, keyCode: 86 }))).toBe(false)
    expect(f.typing.key(key("v", { ctrlKey: true, shiftKey: true, keyCode: 86 }))).toBe(false)
    expect(f.take()).toEqual([])
  })

  test("what the browser pastes into the field (this device's clipboard) arrives as text", () => {
    const f = field()
    f.input("주소: ")
    f.take()
    f.state.value = `${REST}주소: 서울시 중구`
    f.typing.changed(f.state.value, true)
    expect(f.take()).toEqual([{ k: "text", text: "서울시 중구" }])
  })

  test("a pasted line break stays text (it must not press Enter in a form); a typed one is the Enter key", () => {
    const f = field()
    f.state.value = `${REST}첫 줄\n둘째 줄`
    const next = f.typing.changed(f.state.value, true)
    const pasted = f.take()
    expect(pasted).toEqual([{ k: "text", text: "첫 줄\n둘째 줄" }])
    for (const event of pasted) expect(RemoteBrowser.parseInputEvent(event)).toEqual(event)
    // The field keeps the pasted text until it is reset; typing goes on after it.
    expect(next).toBeUndefined()
    f.state.value = `${f.state.value}\n`
    f.typing.changed(f.state.value)
    expect(f.take()).toEqual([{ k: "key", key: "Enter" }])
  })

  test("a long paste is cut into the contract's text sizes and the field goes back to its rest text", () => {
    const f = field()
    const clip = "가".repeat(RemoteBrowser.MAX_TEXT + 500)
    f.state.value = REST + clip
    expect(f.typing.changed(f.state.value, true)).toBe(REST)
    const sent = f.take()
    expect(sent.map((event) => (event.k === "text" ? event.text.length : -1))).toEqual([RemoteBrowser.MAX_TEXT, 500])
  })
})
