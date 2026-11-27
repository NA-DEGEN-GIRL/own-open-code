// Workspace notes (02 §9.2 "워크스페이스 노트"): the RPC handlers over an in-memory stand-in for the plugin KV. Revisions
// never let a save overwrite another device's newer text, a workspace holds at most 200 notes, workspaces never mix,
// removal reports what it did, and every change is announced without its content.
import { describe, expect, test } from "bun:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Kv, Notes } from "@own/protocol"
import { Hash } from "@own/runtime"
import type { Schema } from "effect"
import { Register } from "../../src/rpc/register.js"
import { NotesRpc } from "../../src/rpc/notes.js"
import { call, ok, recordEvents } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"

const WORKSPACE = Notes.workspaceKey({ directory: "D:\\work\\repo" })!
const OTHER = Notes.workspaceKey({ host: "h-abc123", directory: "/home/me/repo" })!
const A = "6f1c2b8e-0d4a-4f7e-9c1d-2a3b4c5d6e7f"
const B = "0b6f3d2c-1e5a-4c7b-8d9e-0f1a2b3c4d5e"

/** The plugin KV as core keeps it: JSON values by key, each `await` a real turn of the event loop. */
function memoryStorage() {
  const values = new Map<string, Schema.Json>()
  const storage: StorageDomain = {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      await Bun.sleep(0)
      values.set(key, structuredClone(value))
    },
    remove: async (key) => {
      await Bun.sleep(0)
      values.delete(key)
    },
    scan: async () => ({ entries: [] }),
  }
  return { storage, values }
}

async function rig() {
  const kv = memoryStorage()
  const t = await testDeps({ ctx: { storage: kv.storage }, control: true })
  return {
    t,
    kv,
    events: recordEvents(t.deps),
    rpc: NotesRpc.handlers(t.deps),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

describe("workspace notes store", () => {
  test("creates, lists in creation order, reads, and saves the title or the text alone", async () => {
    await using r = await rig()
    const first = await ok(r.rpc["notes.put"], {
      workspace: WORKSPACE,
      id: A,
      title: "계획",
      text: "한글 메모\n첫 줄",
      baseRev: 0,
    })
    expect(first).toEqual({ rev: 1, updatedAt: r.t.clock.now() })
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: B, baseRev: 0 })
    r.t.clock.advance(1_000)
    expect(await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, title: "작업 계획", baseRev: 1 })).toEqual({
      rev: 2,
      updatedAt: r.t.clock.now(),
    })
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: B, text: "두 번째", baseRev: 1 })

    const listed = await ok(r.rpc["notes.list"], { workspace: WORKSPACE })
    expect(listed.notes.map((note) => [note.id, note.title, note.rev])).toEqual([
      [A, "작업 계획", 2],
      [B, "", 2],
    ])
    expect(await ok(r.rpc["notes.get"], { workspace: WORKSPACE, id: A })).toEqual({
      id: A,
      title: "작업 계획",
      text: "한글 메모\n첫 줄",
      rev: 2,
      updatedAt: r.t.clock.now(),
    })
    expect((await ok(r.rpc["notes.get"], { workspace: WORKSPACE, id: B })).text).toBe("두 번째")
  })

  test("a stale revision is a conflict with the stored note, never an overwrite", async () => {
    await using r = await rig()
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, title: "계획", text: "PC에서 쓴 글", baseRev: 0 })
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "휴대폰에서 고친 글", baseRev: 1 })

    const stale = await call(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "PC의 늦은 저장", baseRev: 1 })
    expect(stale).toMatchObject({
      ok: false,
      type: "note_conflict",
      data: { current: { id: A, title: "계획", text: "휴대폰에서 고친 글", rev: 2 } },
    })
    // Creating an id that exists is the same conflict.
    expect(await call(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "새 노트", baseRev: 0 })).toMatchObject({
      ok: false,
      type: "note_conflict",
    })
    // A note removed elsewhere: the conflict's current note is null.
    await ok(r.rpc["notes.remove"], { workspace: WORKSPACE, id: A })
    expect(
      await call(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "늦게 온 저장", baseRev: 2 }),
    ).toMatchObject({
      ok: false,
      type: "note_conflict",
      data: { current: null },
    })
    expect((await ok(r.rpc["notes.list"], { workspace: WORKSPACE })).notes).toEqual([])
  })

  test("a workspace holds 200 notes; at the limit a new one is refused and existing ones still save", async () => {
    await using r = await rig()
    for (const index of Array.from({ length: Notes.PER_WORKSPACE_MAX }, (_, value) => value))
      await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: `n${index}`, title: `노트 ${index}`, baseRev: 0 })
    expect(await call(r.rpc["notes.put"], { workspace: WORKSPACE, id: "one-more", baseRev: 0 })).toMatchObject({
      ok: false,
      type: "notes_limit",
      data: { max: Notes.PER_WORKSPACE_MAX },
    })
    expect(await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: "n7", text: "고침", baseRev: 1 })).toMatchObject({
      rev: 2,
    })
    // Another workspace has its own count.
    await ok(r.rpc["notes.put"], { workspace: OTHER, id: "one-more", baseRev: 0 })
    expect((await ok(r.rpc["notes.list"], { workspace: WORKSPACE })).notes).toHaveLength(Notes.PER_WORKSPACE_MAX)
  })

  test("workspaces never mix; KV rows are named by the workspace hash, not its path", async () => {
    await using r = await rig()
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, title: "로컬", text: "D 드라이브", baseRev: 0 })
    await ok(r.rpc["notes.put"], { workspace: OTHER, id: A, title: "원격", text: "SSH 호스트", baseRev: 0 })
    expect((await ok(r.rpc["notes.get"], { workspace: WORKSPACE, id: A })).text).toBe("D 드라이브")
    expect((await ok(r.rpc["notes.get"], { workspace: OTHER, id: A })).text).toBe("SSH 호스트")
    const hash = Hash.short(WORKSPACE, 32)
    expect([...r.kv.values.keys()].sort()).toEqual(
      [
        Kv.notesIndex(hash),
        Kv.noteText(hash, A),
        Kv.notesIndex(Hash.short(OTHER, 32)),
        Kv.noteText(Hash.short(OTHER, 32), A),
      ].sort(),
    )
    expect([...r.kv.values.keys()].some((key) => key.includes("work") || key.includes("home"))).toBe(false)
    expect(r.kv.values.get(Kv.noteText(hash, A))).toBe("D 드라이브")
  })

  test("remove: gone from the list and get, false the second time, and a stale revision conflicts", async () => {
    await using r = await rig()
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, title: "지울 것", text: "내용", baseRev: 0 })
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: B, title: "남길 것", baseRev: 0 })
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "다른 기기에서 고침", baseRev: 1 })
    expect(await call(r.rpc["notes.remove"], { workspace: WORKSPACE, id: A, baseRev: 1 })).toMatchObject({
      ok: false,
      type: "note_conflict",
      data: { current: { text: "다른 기기에서 고침", rev: 2 } },
    })
    expect(await ok(r.rpc["notes.remove"], { workspace: WORKSPACE, id: A, baseRev: 2 })).toEqual({ removed: true })
    expect(await ok(r.rpc["notes.remove"], { workspace: WORKSPACE, id: A })).toEqual({ removed: false })
    expect(await call(r.rpc["notes.get"], { workspace: WORKSPACE, id: A })).toMatchObject({
      ok: false,
      type: "note_not_found",
      data: { id: A },
    })
    expect((await ok(r.rpc["notes.list"], { workspace: WORKSPACE })).notes.map((note) => note.id)).toEqual([B])
    const hash = Hash.short(WORKSPACE, 32)
    expect(r.kv.values.has(Kv.noteText(hash, A))).toBe(false)
    // The last note takes the index row with it.
    await ok(r.rpc["notes.remove"], { workspace: WORKSPACE, id: B })
    expect([...r.kv.values.keys()]).toEqual([])
  })

  test("every saved change is announced with workspace, id and revision only; refused calls announce nothing", async () => {
    await using r = await rig()
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, title: "비밀 제목", text: "비밀 내용", baseRev: 0 })
    await ok(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "더 쓴 내용", baseRev: 1 })
    await call(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "늦은 저장", baseRev: 1 })
    await ok(r.rpc["notes.remove"], { workspace: WORKSPACE, id: A })
    await ok(r.rpc["notes.remove"], { workspace: WORKSPACE, id: A })
    expect(r.events.map((event) => [event.name, event.payload.id, event.payload.rev])).toEqual([
      ["notes.changed", A, 1],
      ["notes.changed", A, 2],
      ["notes.changed", A, null],
    ])
    for (const event of r.events) {
      expect(Object.keys(event.payload).sort()).toEqual(["eventId", "id", "origin", "rev", "workspace"])
      expect(event.payload).toMatchObject({ workspace: WORKSPACE, origin: "global" })
    }
  })

  test("two devices creating notes at the same moment both land in the index", async () => {
    await using r = await rig()
    const ids = Array.from({ length: 8 }, (_, index) => `device-${index}`)
    await Promise.all(ids.map((id) => ok(r.rpc["notes.put"], { workspace: WORKSPACE, id, title: id, baseRev: 0 })))
    expect((await ok(r.rpc["notes.list"], { workspace: WORKSPACE })).notes.map((note) => note.id).sort()).toEqual(
      [...ids].sort(),
    )
    // The same base revision from two devices: exactly one save wins, the other gets the conflict.
    const results = await Promise.all(
      ["PC", "휴대폰"].map((text) => call(r.rpc["notes.put"], { workspace: WORKSPACE, id: ids[0]!, text, baseRev: 1 })),
    )
    expect(results.map((result) => result.ok).sort()).toEqual([false, true])
  })

  test("an unreadable index fails the call and is left as it is", async () => {
    await using r = await rig()
    const key = Kv.notesIndex(Hash.short(WORKSPACE, 32))
    r.kv.values.set(key, { notes: "not a list" })
    expect(await call(r.rpc["notes.put"], { workspace: WORKSPACE, id: A, text: "x", baseRev: 0 })).toMatchObject({
      ok: false,
      type: "internal_error",
    })
    expect(await call(r.rpc["notes.list"], { workspace: WORKSPACE })).toMatchObject({
      ok: false,
      type: "internal_error",
    })
    expect(r.kv.values.get(key)).toEqual({ notes: "not a list" })
  })

  test("a remote service (SSH host) refuses every notes method: the notes live on this PC", async () => {
    await using r = await rig()
    const handlers = Register.remoteHandlers(Register.handlers(r.t.modules(), r.t.deps))
    for (const method of ["notes.list", "notes.get", "notes.put", "notes.remove"] as const) {
      expect(Register.REMOTE_MANAGED).toContain(method)
      expect(await call(handlers[method], { workspace: WORKSPACE, id: A, baseRev: 0 })).toMatchObject({
        ok: false,
        type: "remote_managed",
        data: { method },
      })
    }
    expect(r.kv.values.size).toBe(0)
  })
})
