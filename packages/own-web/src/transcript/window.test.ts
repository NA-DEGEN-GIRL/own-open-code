// The transcript's message window (window.ts): a long transcript projects WINDOW messages ending at the window's end,
// the tail by default; moving it by an index keeps it full and comes back to the tail at the end of the list.
import { describe, expect, test } from "bun:test"
import { endAt, span, STEP, WINDOW } from "./window"

const list = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `msg_${index}` }))

describe("the transcript window", () => {
  test("a transcript up to WINDOW messages is projected whole, as before", () => {
    expect(span(list(0), undefined)).toEqual([0, 0])
    expect(span(list(WINDOW), undefined)).toEqual([0, WINDOW])
    expect(endAt(list(WINDOW), 10)).toBeUndefined()
  })

  test("at the tail a longer transcript projects its newest WINDOW messages", () => {
    expect(span(list(WINDOW + 50), undefined)).toEqual([50, WINDOW + 50])
  })

  test("paged up to the start, the window starts at the oldest message and ends WINDOW later", () => {
    const messages = list(WINDOW * 3)
    const end = endAt(messages, WINDOW)
    expect(end).toBe(`msg_${WINDOW - 1}`)
    expect(span(messages, end)).toEqual([0, WINDOW])
  })

  test("it keeps its place by message while older pages are prepended", () => {
    const messages = list(WINDOW * 2)
    const end = endAt(messages, WINDOW + STEP)
    const prepended = [...list(20).map((item) => ({ id: `old_${item.id}` })), ...messages]
    expect(span(prepended, end)).toEqual([20 + STEP, 20 + WINDOW + STEP])
  })

  test("moving it stays full and reaches the tail at the end", () => {
    const messages = list(WINDOW + STEP)
    expect(span(messages, endAt(messages, 10))).toEqual([0, WINDOW])
    expect(endAt(messages, WINDOW + STEP)).toBeUndefined()
    expect(endAt(messages, WINDOW + STEP * 2)).toBeUndefined()
  })

  test("an end that left the store (a revert, a reread of the newest page) falls back to the tail", () => {
    expect(span(list(WINDOW + 5), "msg_gone")).toEqual([5, WINDOW + 5])
  })

  test("with newer messages still to read, the end stays on the last message held, never the tail", () => {
    const messages = list(WINDOW + STEP)
    expect(endAt(messages, WINDOW + STEP * 2, true)).toBe(`msg_${WINDOW + STEP - 1}`)
    expect(endAt(messages, 10, true)).toBe(`msg_${WINDOW - 1}`)
    expect(endAt(list(20), 10, true)).toBe("msg_19")
    expect(endAt(list(0), 10, true)).toBeUndefined()
  })
})
