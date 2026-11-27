// Idea notes (02 §9.2 "아이디어 노트"): the RPC handlers over an in-memory stand-in for the plugin KV. Revisions never
// let a save overwrite another device's newer change, this PC keeps at most 1,000 ideas, removal reports what it did,
// an undone removal keeps its place, every change is announced without its text, and a remote service refuses them.
import { describe, expect, test } from "bun:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Ideas, Kv } from "@own/protocol"
import type { Schema } from "effect"
import { IdeasRpc } from "../../src/rpc/ideas.js"
import { Register } from "../../src/rpc/register.js"
import { call, ok, recordEvents } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"

const A = "6f1c2b8e-0d4a-4f7e-9c1d-2a3b4c5d6e7f"
const B = "0b6f3d2c-1e5a-4c7b-8d9e-0f1a2b3c4d5e"

/** The plugin KV as core keeps it: JSON values by key, scanned in key order, each write a real turn of the loop. */
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
    scan: async (options) => {
      const keys = [...values.keys()]
        .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
        .sort()
      const page = keys.slice(0, options.limit ?? keys.length)
      return {
        entries: page.map((key) => ({ key, value: values.get(key)! })),
        ...(page.length < keys.length ? { next: page.at(-1) } : {}),
      }
    },
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
    rpc: IdeasRpc.handlers(t.deps),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

describe("idea notes store", () => {
  test("creates with defaults, lists every idea, and changes the text, color or pin alone", async () => {
    await using r = await rig()
    const created = await ok(r.rpc["ideas.put"], { id: A, text: "회의록 자동 요약 #도구", baseRev: 0 })
    const now = r.t.clock.now()
    expect(created).toEqual({
      id: A,
      text: "회의록 자동 요약 #도구",
      color: "yellow",
      pinned: false,
      rev: 1,
      createdAt: now,
      updatedAt: now,
    })
    await ok(r.rpc["ideas.put"], { id: B, text: "주말 산책 앱", color: "green", pinned: true, baseRev: 0 })
    r.t.clock.advance(1_000)
    expect(await ok(r.rpc["ideas.put"], { id: A, pinned: true, baseRev: 1 })).toMatchObject({
      text: "회의록 자동 요약 #도구",
      pinned: true,
      rev: 2,
      createdAt: now,
      updatedAt: now + 1_000,
    })
    await ok(r.rpc["ideas.put"], { id: A, color: "blue", baseRev: 2 })
    await ok(r.rpc["ideas.put"], { id: A, text: "회의록 자동 요약\n화자 구분까지", baseRev: 3 })
    const listed = await ok(r.rpc["ideas.list"], {})
    expect(listed.ideas.map((idea) => [idea.id, idea.text, idea.color, idea.pinned, idea.rev]).sort()).toEqual(
      [
        [A, "회의록 자동 요약\n화자 구분까지", "blue", true, 4],
        [B, "주말 산책 앱", "green", true, 1],
      ].sort(),
    )
    expect(r.kv.values.get(Kv.idea(A))).toMatchObject({ text: "회의록 자동 요약\n화자 구분까지", rev: 4 })
  })

  test("a stale revision is a conflict with the stored idea, never an overwrite", async () => {
    await using r = await rig()
    await ok(r.rpc["ideas.put"], { id: A, text: "PC에서 적음", baseRev: 0 })
    await ok(r.rpc["ideas.put"], { id: A, text: "휴대폰에서 고침", baseRev: 1 })
    expect(await call(r.rpc["ideas.put"], { id: A, text: "PC의 늦은 저장", baseRev: 1 })).toMatchObject({
      ok: false,
      type: "idea_conflict",
      data: { current: { id: A, text: "휴대폰에서 고침", rev: 2 } },
    })
    // Creating an id that exists is the same conflict.
    expect(await call(r.rpc["ideas.put"], { id: A, text: "새 아이디어", baseRev: 0 })).toMatchObject({
      ok: false,
      type: "idea_conflict",
    })
    // Removed elsewhere: the conflict's current idea is null.
    await ok(r.rpc["ideas.remove"], { id: A })
    expect(await call(r.rpc["ideas.put"], { id: A, pinned: true, baseRev: 2 })).toMatchObject({
      ok: false,
      type: "idea_conflict",
      data: { current: null },
    })
    expect((await ok(r.rpc["ideas.list"], {})).ideas).toEqual([])
  })

  test("this PC keeps 1,000 ideas; at the limit a new one is refused and existing ones still save", async () => {
    await using r = await rig()
    for (const index of Array.from({ length: Ideas.MAX }, (_, value) => value))
      r.kv.values.set(Kv.idea(`i${index}`), {
        id: `i${index}`,
        text: `아이디어 ${index}`,
        color: "yellow",
        pinned: false,
        rev: 1,
        createdAt: index,
        updatedAt: index,
      })
    expect(await call(r.rpc["ideas.put"], { id: "one-more", text: "하나 더", baseRev: 0 })).toMatchObject({
      ok: false,
      type: "ideas_limit",
      data: { max: Ideas.MAX },
    })
    expect(await ok(r.rpc["ideas.put"], { id: "i7", text: "고침", baseRev: 1 })).toMatchObject({ rev: 2 })
    // Two scan pages, every idea.
    expect((await ok(r.rpc["ideas.list"], {})).ideas).toHaveLength(Ideas.MAX)
  })

  test("remove: gone from the list, false the second time, a stale revision conflicts, undo keeps the place", async () => {
    await using r = await rig()
    const first = await ok(r.rpc["ideas.put"], { id: A, text: "지울 것", baseRev: 0 })
    r.t.clock.advance(5_000)
    await ok(r.rpc["ideas.put"], { id: B, text: "남길 것", baseRev: 0 })
    await ok(r.rpc["ideas.put"], { id: A, text: "다른 기기에서 고침", baseRev: 1 })
    expect(await call(r.rpc["ideas.remove"], { id: A, baseRev: 1 })).toMatchObject({
      ok: false,
      type: "idea_conflict",
      data: { current: { text: "다른 기기에서 고침", rev: 2 } },
    })
    expect(await ok(r.rpc["ideas.remove"], { id: A, baseRev: 2 })).toEqual({ removed: true })
    expect(await ok(r.rpc["ideas.remove"], { id: A })).toEqual({ removed: false })
    expect((await ok(r.rpc["ideas.list"], {})).ideas.map((idea) => idea.id)).toEqual([B])
    expect(r.kv.values.has(Kv.idea(A))).toBe(false)
    // `되돌리기`: the same id again with its creation time; a time from the future is clamped to now.
    expect(
      await ok(r.rpc["ideas.put"], { id: A, text: "다른 기기에서 고침", createdAt: first.createdAt, baseRev: 0 }),
    ).toMatchObject({ rev: 1, createdAt: first.createdAt })
    await ok(r.rpc["ideas.remove"], { id: A })
    expect(
      await ok(r.rpc["ideas.put"], { id: A, text: "미래", createdAt: r.t.clock.now() + 60_000, baseRev: 0 }),
    ).toMatchObject({ createdAt: r.t.clock.now() })
  })

  test("every saved change is announced with id and revision only; refused calls announce nothing", async () => {
    await using r = await rig()
    await ok(r.rpc["ideas.put"], { id: A, text: "비밀 아이디어", baseRev: 0 })
    await ok(r.rpc["ideas.put"], { id: A, pinned: true, baseRev: 1 })
    await call(r.rpc["ideas.put"], { id: A, text: "늦은 저장", baseRev: 1 })
    await ok(r.rpc["ideas.remove"], { id: A })
    await ok(r.rpc["ideas.remove"], { id: A })
    expect(r.events.map((event) => [event.name, event.payload.id, event.payload.rev])).toEqual([
      ["ideas.changed", A, 1],
      ["ideas.changed", A, 2],
      ["ideas.changed", A, null],
    ])
    for (const event of r.events) {
      expect(Object.keys(event.payload).sort()).toEqual(["eventId", "id", "origin", "rev"])
      expect(event.payload).toMatchObject({ origin: "global" })
    }
  })

  test("two devices saving at the same moment: every create lands, one of two same-revision saves wins", async () => {
    await using r = await rig()
    const ids = Array.from({ length: 8 }, (_, index) => `device-${index}`)
    await Promise.all(ids.map((id) => ok(r.rpc["ideas.put"], { id, text: id, baseRev: 0 })))
    expect((await ok(r.rpc["ideas.list"], {})).ideas.map((idea) => idea.id).sort()).toEqual([...ids].sort())
    const results = await Promise.all(
      ["PC", "휴대폰"].map((text) => call(r.rpc["ideas.put"], { id: ids[0]!, text, baseRev: 1 })),
    )
    expect(results.map((result) => result.ok).sort()).toEqual([false, true])
  })

  test("an unreadable row fails the call and is left as it is", async () => {
    await using r = await rig()
    r.kv.values.set(Kv.idea(A), { text: 3 })
    expect(await call(r.rpc["ideas.list"], {})).toMatchObject({ ok: false, type: "internal_error" })
    expect(await call(r.rpc["ideas.put"], { id: A, text: "x", baseRev: 0 })).toMatchObject({
      ok: false,
      type: "internal_error",
    })
    expect(r.kv.values.get(Kv.idea(A))).toEqual({ text: 3 })
  })

  test("a remote service (SSH host) refuses every idea method: the ideas live on this PC", async () => {
    await using r = await rig()
    const handlers = Register.remoteHandlers(Register.handlers(r.t.modules(), r.t.deps))
    for (const method of ["ideas.list", "ideas.put", "ideas.remove"] as const) {
      expect(Register.REMOTE_MANAGED).toContain(method)
      expect(await call(handlers[method], { id: A, text: "x", baseRev: 0 })).toMatchObject({
        ok: false,
        type: "remote_managed",
        data: { method },
      })
    }
    expect(r.kv.values.size).toBe(0)
  })
})
