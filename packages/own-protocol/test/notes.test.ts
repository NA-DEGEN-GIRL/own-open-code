// Workspace notes (02 §9.2 "워크스페이스 노트"): the workspace key every client derives the same way, and the RPC
// boundary that rejects anything else (non-canonical keys, ids with separators or control characters, long titles and
// texts).
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Notes, OwnAccounts, Portable } from "../src/index.js"
import { roundTrip } from "./fixtures.js"

const methods = OwnAccounts.Definition.methods
const ID = "6f1c2b8e-0d4a-4f7e-9c1d-2a3b4c5d6e7f"

describe("workspace keys", () => {
  test("a local project is its directory in one spelling: Windows paths fold case and separators", () => {
    const key = "local:d:\\work\\repo"
    for (const directory of ["D:\\work\\repo", "d:/Work/Repo/", "D:\\\\work\\.\\x\\..\\repo\\", "D:/work//repo"])
      expect({ directory, key: Notes.workspaceKey({ directory }) }).toEqual({ directory, key })
    expect(Notes.workspaceKey({ directory: "D:\\" })).toBe("local:d:\\")
    expect(Notes.workspaceKey({ directory: "D:" })).toBe("local:d:\\")
    expect(Notes.workspaceKey({ directory: "\\\\NAS\\Share\\Repo\\" })).toBe("local:\\\\nas\\share\\repo")
  })

  test("POSIX directories keep their case; an SSH project carries its host id", () => {
    expect(Notes.workspaceKey({ directory: "/home/User//repo/" })).toBe("local:/home/User/repo")
    expect(Notes.workspaceKey({ directory: "/" })).toBe("local:/")
    expect(Notes.workspaceKey({ directory: "/a/../../b" })).toBe("local:/b")
    expect(Notes.workspaceKey({ host: "h-abc123", directory: "/home/me/repo" })).toBe("ssh:h-abc123:/home/me/repo")
    // A Windows SSH host folds like a local Windows path; the same folder on another host is another workspace.
    expect(Notes.workspaceKey({ host: "h-abc123", directory: "C:/Repo" })).toBe("ssh:h-abc123:c:\\repo")
    expect(Notes.workspaceKey({ host: "h-zzz999", directory: "/home/me/repo" })).not.toBe(
      Notes.workspaceKey({ host: "h-abc123", directory: "/home/me/repo" }),
    )
  })

  test("no key without an absolute directory, with control characters, for a non-host server or when too long", () => {
    for (const directory of ["", "repo", ".\\repo", "~/repo", "/repo\u0000", "D:\\re\npo"])
      expect({ directory, key: Notes.workspaceKey({ directory }) }).toEqual({ directory, key: undefined })
    expect(Notes.workspaceKey({ host: "local", directory: "/repo" })).toBeUndefined()
    expect(Notes.workspaceKey({ host: "h-ABC123", directory: "/repo" })).toBeUndefined()
    expect(Notes.workspaceKey({ directory: `/${"a".repeat(Notes.WORKSPACE_MAX)}` })).toBeUndefined()
  })

  test("only keys exactly as workspaceKey writes them are workspace keys", () => {
    for (const key of ["local:d:\\work\\repo", "local:/home/User/repo", "ssh:h-abc123:/home/me/repo", "local:d:\\"])
      expect({ key, ok: Notes.isWorkspaceKey(key) }).toEqual({ key, ok: true })
    for (const key of [
      "local:D:\\work\\repo",
      "local:d:/work/repo",
      "local:d:\\work\\repo\\",
      "local:repo",
      "ssh:h-abc123:repo",
      "ssh:local:/repo",
      "ssh:/repo",
      "/home/me/repo",
      '["local","D:\\\\work"]',
    ])
      expect({ key, ok: Notes.isWorkspaceKey(key) }).toEqual({ key, ok: false })
  })
})

describe("notes RPC boundary", () => {
  const decode = (name: keyof typeof methods, input: unknown) => Schema.decodeUnknownSync(methods[name].input)(input)
  const workspace = "local:d:\\work\\repo"

  test("put accepts a canonical workspace, a note id, the limits and baseRev 0 for a new note", () => {
    const put = { workspace, id: ID, title: "계획", text: "한글 메모\n".repeat(10), baseRev: 0 }
    expect(roundTrip(methods["notes.put"].input, put)).toEqual(put)
    const full = {
      workspace,
      id: ID,
      title: "t".repeat(Notes.TITLE_MAX),
      text: "가".repeat(Notes.TEXT_MAX),
      baseRev: 3,
    }
    expect(decode("notes.put", full)).toEqual(full)
    expect(decode("notes.put", { workspace, id: ID, baseRev: 1 })).toEqual({ workspace, id: ID, baseRev: 1 })
    const portable = Portable.definition(OwnAccounts.Definition).methods["notes.put"]
    expect<unknown>(portable.input["~standard"].validate(put)).toEqual({ value: put })
  })

  test("put rejects other workspaces, ids, long titles and texts, and negative revisions", () => {
    const valid = { workspace, id: ID, baseRev: 0 }
    for (const broken of [
      { ...valid, workspace: "local:D:\\work\\repo" },
      { ...valid, workspace: "D:\\work\\repo" },
      { ...valid, id: "" },
      { ...valid, id: "a:b" },
      { ...valid, id: "a/b" },
      { ...valid, id: "a\u0007b" },
      { ...valid, id: "x".repeat(65) },
      { ...valid, title: "t".repeat(Notes.TITLE_MAX + 1) },
      { ...valid, text: "x".repeat(Notes.TEXT_MAX + 1) },
      { ...valid, baseRev: -1 },
      { ...valid, baseRev: 1.5 },
    ])
      expect(() => decode("notes.put", broken)).toThrow()
  })

  test("list, get, remove and their outputs and errors round-trip", () => {
    expect(decode("notes.list", { workspace })).toEqual({ workspace })
    expect(() => decode("notes.list", { workspace: "local:" })).toThrow()
    expect(decode("notes.get", { workspace, id: ID })).toEqual({ workspace, id: ID })
    expect(decode("notes.remove", { workspace, id: ID, baseRev: 2 })).toEqual({ workspace, id: ID, baseRev: 2 })
    expect(() => decode("notes.remove", { workspace, id: ID, baseRev: 0 })).toThrow()
    const meta = { id: ID, title: "계획", rev: 2, updatedAt: 1790000000000 }
    expect(roundTrip(methods["notes.list"].output, { notes: [meta] })).toEqual({ notes: [meta] })
    expect(roundTrip(methods["notes.get"].output, { ...meta, text: "메모" })).toEqual({ ...meta, text: "메모" })
    expect(() => Schema.decodeUnknownSync(methods["notes.get"].output)({ ...meta, rev: 0, text: "" })).toThrow()
    expect(roundTrip(methods["notes.put"].output, { rev: 3, updatedAt: 1790000000001 })).toEqual({
      rev: 3,
      updatedAt: 1790000000001,
    })
    const conflict = { current: { ...meta, text: "다른 기기의 글" } }
    expect(roundTrip(methods["notes.put"].errors.note_conflict, conflict)).toEqual(conflict)
    expect(roundTrip(methods["notes.remove"].errors.note_conflict, { current: null })).toEqual({ current: null })
    expect(roundTrip(methods["notes.put"].errors.notes_limit, { max: 200 })).toEqual({ max: 200 })
    expect(roundTrip(methods["notes.get"].errors.note_not_found, { id: ID })).toEqual({ id: ID })
  })

  test("reads are read scope, writes are prompt scope, all at the control location; the event is global", () => {
    expect(OwnAccounts.MethodScope["notes.list"]).toBe("read")
    expect(OwnAccounts.MethodScope["notes.get"]).toBe("read")
    expect(OwnAccounts.MethodScope["notes.put"]).toBe("prompt")
    expect(OwnAccounts.MethodScope["notes.remove"]).toBe("prompt")
    for (const name of ["notes.list", "notes.get", "notes.put", "notes.remove"] as const)
      expect(OwnAccounts.MethodLocation[name]).toBe("control")
    expect(OwnAccounts.EventOrigin["notes.changed"]).toBe("global")
  })
})
