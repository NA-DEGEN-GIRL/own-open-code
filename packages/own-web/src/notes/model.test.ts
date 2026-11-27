// Thread notes (03 §19.10, 01 §17.1 #26): UI-only text in the own metadata namespace, model-visible only through the
// appended instruction entry, and a save plan that writes the entry only when the model's view changes.
import { describe, expect, test } from "bun:test"
import { entryNote, NOTE_ENTRY, NOTE_KEY, noteOf, pendingEffect, planSave, withNote } from "./model"

describe("note text in metadata (UI only)", () => {
  test("reads own.note; merges without touching other keys; a blank note removes the key", () => {
    expect(NOTE_KEY).toBe("own.note")
    expect(noteOf({ "own.note": "메모", "own.pinned": 1 })).toBe("메모")
    expect(noteOf({ "own.note": 3 })).toBe("")
    expect(noteOf(null)).toBe("")
    const metadata = { "own.pinned": 5, other: { a: true } }
    expect(withNote(metadata, "새 메모")).toEqual({ "own.pinned": 5, other: { a: true }, "own.note": "새 메모" })
    expect(withNote({ ...metadata, "own.note": "x" }, "   ")).toEqual(metadata)
  })

  test("the entry key is a valid instruction entry key and its value reads back", () => {
    expect(NOTE_ENTRY).toMatch(/^[a-z0-9][a-z0-9._-]*$/)
    expect(entryNote([{ key: "other", value: "x" }])).toBeUndefined()
    expect(entryNote([{ key: NOTE_ENTRY, value: "보이는 노트" }])).toBe("보이는 노트")
    expect(entryNote([{ key: NOTE_ENTRY, value: { a: 1 } }])).toBe('{"a":1}')
  })
})

describe("save plan (prefix-safe)", () => {
  const off = (text: string) => ({ text, visible: false })
  const on = (text: string) => ({ text, visible: true })

  test("UI-only edits never touch the entry", () => {
    expect(planSave(off(""), off("a"))).toEqual({ metadata: true, entry: "none" })
    expect(planSave(off("a"), off("a"))).toEqual({ metadata: false, entry: "none" })
  })

  test("turning it on puts the entry; editing a visible note puts it again; unchanged writes nothing", () => {
    expect(planSave(off("a"), on("a"))).toEqual({ metadata: false, entry: "put" })
    expect(planSave(on("a"), on("b"))).toEqual({ metadata: true, entry: "put" })
    expect(planSave(on("a"), on("a"))).toEqual({ metadata: false, entry: "none" })
  })

  test("turning it off or clearing a visible note removes the entry; a blank note is never visible", () => {
    expect(planSave(on("a"), off("a"))).toEqual({ metadata: false, entry: "remove" })
    expect(planSave(on("a"), on(""))).toEqual({ metadata: true, entry: "remove" })
    expect(planSave(off(""), on("  "))).toEqual({ metadata: true, entry: "none" })
  })

  test("the pending line says what the next request carries", () => {
    expect(pendingEffect(off("a"), on("a"))).toBe("add")
    expect(pendingEffect(on("a"), off("a"))).toBe("remove")
    expect(pendingEffect(off("a"), off("b"))).toBeUndefined()
  })
})
