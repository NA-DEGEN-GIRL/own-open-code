// Idea notes (02 §9.2 "아이디어 노트"): the RPC boundary of the global sticky notes. It takes ids without separators,
// some visible text up to 2,000 characters, the five paper colors, and a new idea only with its text.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Ideas, OwnAccounts, Portable } from "../src/index.js"
import { roundTrip } from "./fixtures.js"

const methods = OwnAccounts.Definition.methods
const ID = "6f1c2b8e-0d4a-4f7e-9c1d-2a3b4c5d6e7f"
const decode = (name: keyof typeof methods, input: unknown) => Schema.decodeUnknownSync(methods[name].input)(input)

describe("ideas RPC boundary", () => {
  test("put creates with text, and changes any field alone afterwards", () => {
    const create = { id: ID, text: "회의록 자동 요약 #도구", color: "pink", pinned: true, baseRev: 0 }
    expect(roundTrip(methods["ideas.put"].input, create)).toEqual(create)
    expect(decode("ideas.put", { id: ID, text: "가".repeat(Ideas.TEXT_MAX), baseRev: 0 })).toEqual({
      id: ID,
      text: "가".repeat(Ideas.TEXT_MAX),
      baseRev: 0,
    })
    expect(decode("ideas.put", { id: ID, pinned: false, baseRev: 3 })).toEqual({ id: ID, pinned: false, baseRev: 3 })
    expect(decode("ideas.put", { id: ID, color: "blue", baseRev: 1 })).toEqual({ id: ID, color: "blue", baseRev: 1 })
    // An undone removal comes back with its creation time.
    expect(decode("ideas.put", { id: ID, text: "x", createdAt: 1790000000000, baseRev: 0 })).toEqual({
      id: ID,
      text: "x",
      createdAt: 1790000000000,
      baseRev: 0,
    })
    const portable = Portable.definition(OwnAccounts.Definition).methods["ideas.put"]
    expect<unknown>(portable.input["~standard"].validate(create)).toEqual({ value: create })
    expect(portable.input["~standard"].validate({ id: ID, baseRev: 0 })).toHaveProperty("issues")
  })

  test("put rejects a new idea without text, blank or long text, other colors, bad ids and revisions", () => {
    const valid = { id: ID, text: "아이디어", baseRev: 0 }
    for (const broken of [
      { id: ID, baseRev: 0 },
      { id: ID, color: "yellow", baseRev: 0 },
      { ...valid, text: "" },
      { ...valid, text: " \n\t " },
      { ...valid, text: "x".repeat(Ideas.TEXT_MAX + 1) },
      { ...valid, color: "red" },
      { ...valid, pinned: "yes" },
      { ...valid, id: "" },
      { ...valid, id: "a:b" },
      { ...valid, id: "a/b" },
      { ...valid, id: "x".repeat(65) },
      { ...valid, baseRev: -1 },
      { ...valid, baseRev: 1.5 },
      { ...valid, createdAt: -5 },
    ])
      expect(() => decode("ideas.put", broken)).toThrow()
  })

  test("list, remove, their outputs and errors round-trip", () => {
    expect(decode("ideas.list", {})).toEqual({})
    expect(decode("ideas.remove", { id: ID, baseRev: 2 })).toEqual({ id: ID, baseRev: 2 })
    expect(decode("ideas.remove", { id: ID })).toEqual({ id: ID })
    expect(() => decode("ideas.remove", { id: ID, baseRev: 0 })).toThrow()
    const idea = {
      id: ID,
      text: "주말에 해 볼 것",
      color: "green",
      pinned: false,
      rev: 2,
      createdAt: 1790000000000,
      updatedAt: 1790000000500,
    }
    expect(roundTrip(methods["ideas.list"].output, { ideas: [idea] })).toEqual({ ideas: [idea] })
    expect(roundTrip(methods["ideas.put"].output, idea)).toEqual(idea)
    expect(() => Schema.decodeUnknownSync(methods["ideas.put"].output)({ ...idea, rev: 0 })).toThrow()
    expect(roundTrip(methods["ideas.put"].errors.idea_conflict, { current: idea })).toEqual({ current: idea })
    expect(roundTrip(methods["ideas.remove"].errors.idea_conflict, { current: null })).toEqual({ current: null })
    expect(roundTrip(methods["ideas.put"].errors.ideas_limit, { max: Ideas.MAX })).toEqual({ max: Ideas.MAX })
  })

  test("the list is a read, writes are prompt, all at the control location; the event is global", () => {
    expect(OwnAccounts.MethodScope["ideas.list"]).toBe("read")
    expect(OwnAccounts.MethodScope["ideas.put"]).toBe("prompt")
    expect(OwnAccounts.MethodScope["ideas.remove"]).toBe("prompt")
    for (const name of ["ideas.list", "ideas.put", "ideas.remove"] as const)
      expect(OwnAccounts.MethodLocation[name]).toBe("control")
    expect(OwnAccounts.EventOrigin["ideas.changed"]).toBe("global")
  })

  test("a whole idea is far below the gateway's 64 KiB body inspection", () => {
    const fullest = {
      input: {
        id: "x".repeat(64),
        text: "가".repeat(Ideas.TEXT_MAX),
        color: "purple",
        pinned: true,
        createdAt: 1790000000000,
        baseRev: 999999,
      },
    }
    expect(new TextEncoder().encode(JSON.stringify(fullest)).byteLength).toBeLessThan(64 * 1024)
  })
})
