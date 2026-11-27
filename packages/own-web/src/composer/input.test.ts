// Composer IME state machine (03 §12): both Chromium event orders (A1 with the duplicate Enter keydown after the
// commit, A2 without it), Safari's order (B), Shift+Enter, Ctrl+Enter, a button send during composition (rule 6),
// the next-frame clear (rule 7) and the Esc-twice interrupt; then the same under `Ctrl+Enter로 보내기` (03 §4.6:
// Enter is a new line, Ctrl+Enter sends, Alt+Enter the other delivery, a modified key commits an open composition
// within 300 ms). Each order must send the committed text exactly once and leave an empty box.
import { describe, expect, test } from "bun:test"
import type { ImeKeyEvent, SendKey } from "@/ime/ime-enter"
import { createComposerInput, type SubmitResult } from "./input"

type KeyInit = Partial<Omit<ImeKeyEvent, "preventDefault">>

function key(init: KeyInit = {}) {
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

/** Enter while the IME is composing: Chromium reports `Process` with keyCode 229 and `isComposing: true`. */
const composingEnter = () => key({ key: "Process", keyCode: 229, isComposing: true })
const frame = () => new Promise((resolve) => setTimeout(resolve, 80))

function setup(submit?: (text: string, modifier: boolean) => SubmitResult, sendKey: SendKey = "enter") {
  const textarea = document.createElement("textarea")
  document.body.append(textarea)
  const sent: { text: string; modifier: boolean }[] = []
  let interrupted = 0
  let busy = false
  let now = 0
  const input = createComposerInput({
    element: () => textarea,
    submit: (text, modifier) => {
      sent.push({ text, modifier })
      return submit?.(text, modifier)
    },
    busy: () => busy,
    interrupt: () => interrupted++,
    now: () => now,
    sendKey: () => sendKey,
  })
  /** Types a Korean syllable the way an IME does: start, input while composing. */
  const compose = (value: string) => {
    input.compositionstart()
    textarea.value = value
    input.input()
  }
  return {
    textarea,
    input,
    sent,
    compose,
    interrupts: () => interrupted,
    setBusy: (value: boolean) => void (busy = value),
    advance: (ms: number) => void (now += ms),
  }
}

describe("composer IME (03 §12 rule 8)", () => {
  test("A1 (Chromium): 229 Enter while composing → compositionend → Enter 13 → one send, empty box", async () => {
    const { textarea, input, sent, compose } = setup()
    compose("안녕")
    const first = composingEnter()
    expect(input.keydown(first)).toBe(true)
    expect(first.prevented).toBe(false) // the commit itself is never blocked
    input.compositionend()
    const duplicate = key()
    expect(input.keydown(duplicate)).toBe(true)
    expect(duplicate.prevented).toBe(true) // no newline from the duplicate
    input.keyup(duplicate)
    await frame()
    expect(sent).toEqual([{ text: "안녕", modifier: false }])
    await frame()
    expect(textarea.value).toBe("")
  })

  test("A2 (Chromium): 229 Enter while composing → compositionend, no second keydown → one send", async () => {
    const { textarea, input, sent, compose } = setup()
    compose("안녕하세요")
    input.keydown(composingEnter())
    input.compositionend()
    await frame()
    expect(sent).toEqual([{ text: "안녕하세요", modifier: false }])
    await frame()
    expect(textarea.value).toBe("")
  })

  test("A1 with the duplicate keydown arriving after the frame still sends once", async () => {
    const { input, sent, compose } = setup()
    compose("한글")
    input.keydown(composingEnter())
    input.compositionend()
    await frame()
    const late = key()
    input.keydown(late)
    expect(late.prevented).toBe(true)
    await frame()
    expect(sent.length).toBe(1)
  })

  test("B (Safari): compositionend → Enter with keyCode 229, not composing → one send", async () => {
    const { textarea, input, sent, compose } = setup()
    compose("가나다")
    input.compositionend()
    const enter = key({ keyCode: 229 })
    expect(input.keydown(enter)).toBe(true)
    expect(enter.prevented).toBe(true)
    await frame()
    expect(sent).toEqual([{ text: "가나다", modifier: false }])
    await frame()
    expect(textarea.value).toBe("")
  })

  test("the value is read after the commit: the committed syllable is part of the send", async () => {
    const { textarea, input, sent, compose } = setup()
    compose("안")
    input.keydown(composingEnter())
    textarea.value = "안녕" // the IME commits the final syllable before compositionend
    input.compositionend()
    await frame()
    expect(sent[0]?.text).toBe("안녕")
  })

  test("Shift+Enter is a newline: never sends, never prevented (also while composing)", async () => {
    const { input, sent, compose, textarea } = setup()
    textarea.value = "첫 줄"
    input.input()
    const shift = key({ shiftKey: true })
    expect(input.keydown(shift)).toBe(false)
    expect(shift.prevented).toBe(false)
    compose("둘")
    const composingShift = key({ key: "Process", keyCode: 229, isComposing: true, shiftKey: true })
    input.keydown(composingShift)
    expect(composingShift.prevented).toBe(false)
    input.compositionend()
    await frame()
    expect(sent).toEqual([])
  })

  test("Ctrl+Enter carries the modifier (the other delivery while running, 03 §4.6)", async () => {
    const { input, sent, textarea } = setup()
    textarea.value = "대기열로"
    input.input()
    input.keydown(key({ ctrlKey: true }))
    expect(sent).toEqual([{ text: "대기열로", modifier: true }])
  })

  test("Ctrl+Enter during composition sends once after the commit, with the modifier", async () => {
    const { input, sent, compose } = setup()
    compose("조합")
    input.keydown(key({ key: "Process", keyCode: 229, isComposing: true, ctrlKey: true }))
    input.compositionend()
    input.keydown(key({ ctrlKey: true }))
    await frame()
    expect(sent).toEqual([{ text: "조합", modifier: true }])
  })

  test("an empty or blank box sends nothing and keeps the text", async () => {
    const { input, sent, textarea } = setup()
    textarea.value = "   \n "
    input.input()
    input.keydown(key())
    await frame()
    expect(sent).toEqual([])
    expect(textarea.value).toBe("   \n ")
  })

  test("a refused send (offline) keeps the text in the box", async () => {
    const { input, sent, textarea } = setup(() => false)
    textarea.value = "초안"
    input.input()
    input.keydown(key())
    await frame()
    expect(sent.length).toBe(1)
    expect(textarea.value).toBe("초안")
  })

  test("the send button during composition commits first (rule 6) and sends the whole text once", async () => {
    const { input, sent, compose, textarea } = setup()
    compose("버튼으로 보내")
    const sending = input.sendNow()
    // Blur/focus makes the IME commit; the real browser fires compositionend.
    textarea.value = "버튼으로 보내기"
    textarea.dispatchEvent(new Event("compositionend"))
    input.compositionend()
    await sending
    await frame()
    expect(sent).toEqual([{ text: "버튼으로 보내기", modifier: false }])
    expect(textarea.value).toBe("")
  })

  test("the clear waits for the next frame (rule 7) and runs the after-clear step once", async () => {
    let after = 0
    const { input, textarea } = setup(() => () => after++)
    textarea.value = "새 대화"
    input.input()
    input.keydown(key())
    expect(textarea.value).toBe("새 대화")
    expect(input.clearing()).toBe(true)
    await frame()
    expect(textarea.value).toBe("")
    expect(input.clearing()).toBe(false)
    expect(after).toBe(1)
  })

  test("auto-repeat Enter and other keys while composing never send", async () => {
    const { input, sent, compose, textarea } = setup()
    textarea.value = "반복"
    input.input()
    input.keydown(key())
    input.keydown(key({ repeat: true }))
    compose("다음")
    for (const code of ["ArrowUp", "Tab", "Escape", "KeyK"]) {
      const event = key({ code, key: "Process", keyCode: 229, isComposing: true })
      expect(input.keydown(event)).toBe(true)
      expect(event.prevented).toBe(false)
    }
    await frame()
    expect(sent.length).toBe(1)
  })

  test("Esc twice within a second interrupts a running turn; once, or while idle, does not", () => {
    const { input, interrupts, setBusy, advance } = setup()
    input.keydown(key({ code: "Escape", key: "Escape", keyCode: 27 }))
    input.keydown(key({ code: "Escape", key: "Escape", keyCode: 27 }))
    expect(interrupts()).toBe(0)
    setBusy(true)
    input.keydown(key({ code: "Escape", key: "Escape", keyCode: 27 }))
    advance(1_500)
    input.keydown(key({ code: "Escape", key: "Escape", keyCode: 27 }))
    expect(interrupts()).toBe(0)
    advance(400)
    input.keydown(key({ code: "Escape", key: "Escape", keyCode: 27 }))
    expect(interrupts()).toBe(1)
  })

  test("Esc during composition only cancels the composition, never counts toward an interrupt", () => {
    const { input, interrupts, setBusy, compose } = setup()
    setBusy(true)
    compose("취소")
    input.keydown(key({ code: "Escape", key: "Process", keyCode: 229, isComposing: true }))
    input.keydown(key({ code: "Escape", key: "Process", keyCode: 229, isComposing: true }))
    expect(interrupts()).toBe(0)
  })
})

describe("composer under Ctrl+Enter로 보내기 (03 §4.6 보내는 키)", () => {
  const mod = () => setup(undefined, "modEnter")
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test("Enter is a new line; Ctrl+Enter sends the multi-line text once and empties the box", async () => {
    const { input, sent, textarea } = mod()
    textarea.value = "첫 줄"
    input.input()
    const enter = key()
    expect(input.keydown(enter)).toBe(false)
    expect(enter.prevented).toBe(false) // the textarea inserts the line break itself
    textarea.value = "첫 줄\n둘째 줄"
    input.input()
    const shift = key({ shiftKey: true })
    expect(input.keydown(shift)).toBe(false)
    expect(shift.prevented).toBe(false)
    const ctrl = key({ ctrlKey: true })
    expect(input.keydown(ctrl)).toBe(true)
    expect(ctrl.prevented).toBe(true)
    expect(sent).toEqual([{ text: "첫 줄\n둘째 줄", modifier: false }])
    await frame()
    expect(textarea.value).toBe("")
  })

  test("⌘+Enter sends too; Alt+Enter carries the other delivery", () => {
    const { input, sent, textarea } = mod()
    textarea.value = "끼워 넣기"
    input.input()
    input.keydown(key({ metaKey: true }))
    input.input()
    textarea.value = "대기열로"
    input.keydown(key({ altKey: true }))
    expect(sent).toEqual([
      { text: "끼워 넣기", modifier: false },
      { text: "대기열로", modifier: true },
    ])
  })

  test("Enter during a composition commits and never sends (A1 duplicate keydown included)", async () => {
    const { input, sent, compose, textarea } = mod()
    compose("안녕")
    const commit = composingEnter()
    expect(input.keydown(commit)).toBe(true)
    expect(commit.prevented).toBe(false)
    input.compositionend()
    const duplicate = key()
    expect(input.keydown(duplicate)).toBe(false)
    expect(duplicate.prevented).toBe(false)
    await frame()
    expect(sent).toEqual([])
    expect(textarea.value).toBe("안녕")
  })

  test("A1: Ctrl+Enter during a composition → commit → duplicate keydown → the committed text once", async () => {
    const { input, sent, compose, textarea } = mod()
    compose("안녕")
    input.keydown(key({ key: "Process", keyCode: 229, isComposing: true, ctrlKey: true }))
    textarea.value = "안녕하세요"
    input.compositionend()
    const duplicate = key({ ctrlKey: true })
    expect(input.keydown(duplicate)).toBe(true)
    expect(duplicate.prevented).toBe(true)
    await frame()
    expect(sent).toEqual([{ text: "안녕하세요", modifier: false }])
    await frame()
    expect(textarea.value).toBe("")
  })

  test("B (Safari): compositionend → Ctrl+Enter with keyCode 229 → one send", async () => {
    const { input, sent, compose } = mod()
    compose("가나다")
    input.compositionend()
    const enter = key({ keyCode: 229, ctrlKey: true })
    expect(input.keydown(enter)).toBe(true)
    expect(enter.prevented).toBe(true)
    await frame()
    expect(sent).toEqual([{ text: "가나다", modifier: false }])
  })

  test("rule 6: Alt+Enter that leaves the composition open commits it by blur/focus after 300 ms, then sends once", async () => {
    const { input, sent, compose, textarea } = mod()
    textarea.focus()
    let blurs = 0
    textarea.addEventListener("blur", () => blurs++)
    compose("대기열로 보내")
    input.keydown(key({ key: "Process", keyCode: 229, isComposing: true, altKey: true }))
    await wait(150)
    expect(blurs).toBe(0)
    expect(sent).toEqual([])
    await wait(250)
    expect(blurs).toBe(1)
    expect(document.activeElement).toBe(textarea)
    // The blur made the IME commit.
    textarea.value = "대기열로 보내기"
    input.compositionend()
    await frame()
    expect(sent).toEqual([{ text: "대기열로 보내기", modifier: true }])
    await wait(350)
    expect(blurs).toBe(1)
    expect(sent.length).toBe(1)
  })

  test("a composition the IME commits at once is never blurred", async () => {
    const { input, sent, compose, textarea } = mod()
    textarea.focus()
    let blurs = 0
    textarea.addEventListener("blur", () => blurs++)
    compose("바로")
    input.keydown(key({ key: "Process", keyCode: 229, isComposing: true, ctrlKey: true }))
    input.compositionend()
    await wait(400)
    expect(blurs).toBe(0)
    expect(sent).toEqual([{ text: "바로", modifier: false }])
  })

  test("Esc twice still interrupts a running turn", () => {
    const { input, interrupts, setBusy } = mod()
    setBusy(true)
    input.keydown(key({ code: "Escape", key: "Escape", keyCode: 27 }))
    input.keydown(key({ code: "Escape", key: "Escape", keyCode: 27 }))
    expect(interrupts()).toBe(1)
  })
})
