// 프로젝트 순서와 고정 (03 §4.3): `projectList.get` and `projectList.set` over an in-memory stand-in for the plugin KV.
// Every service keeps its own list, an older row that no longer decodes counts as none, each half is changed on its
// own (pinning never touches the order), and every change is announced.
import { describe, expect, test } from "bun:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Kv } from "@own/protocol"
import type { Schema } from "effect"
import { ProjectListRpc } from "../src/rpc/project-list.js"
import { Register } from "../src/rpc/register.js"
import { ok, recordEvents } from "./plugins/support.js"
import { testDeps } from "./support/deps.js"

async function rig() {
  const values = new Map<string, Schema.Json>()
  const storage: Pick<StorageDomain, "get" | "set" | "remove"> = {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, structuredClone(value)),
    remove: async (key) => void values.delete(key),
  }
  const t = await testDeps({ ctx: { storage }, control: true })
  return {
    values,
    events: recordEvents(t.deps),
    now: () => t.deps.clock.now(),
    rpc: ProjectListRpc.handlers(t.deps),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

describe("projectList.*", () => {
  test("nothing pinned and the default order until the user arranges the list", async () => {
    await using r = await rig()
    expect(await ok(r.rpc["projectList.get"], {})).toEqual({ pinned: [], order: null, orderedAt: null })
    r.values.set(Kv.projectList, { pinned: "broken" })
    expect(await ok(r.rpc["projectList.get"], {})).toEqual({ pinned: [], order: null, orderedAt: null })
  })

  test("pinning and ordering change one half each; duplicates go; null is the default order again", async () => {
    await using r = await rig()
    expect(await ok(r.rpc["projectList.set"], { pinned: ["b", "a", "b"] })).toEqual({
      pinned: ["b", "a"],
      order: null,
      orderedAt: null,
    })
    const ordered = await ok(r.rpc["projectList.set"], { order: ["d", "c", "d"] })
    expect(ordered).toMatchObject({ pinned: ["b", "a"], order: ["d", "c"] })
    expect(Math.abs((ordered.orderedAt ?? 0) - r.now())).toBeLessThan(60_000)
    expect(await ok(r.rpc["projectList.set"], { pinned: [] })).toEqual({ ...ordered, pinned: [] })
    expect(await ok(r.rpc["projectList.get"], {})).toEqual({ ...ordered, pinned: [] })
    expect(await ok(r.rpc["projectList.set"], { order: null })).toEqual({ pinned: [], order: null, orderedAt: null })
  })

  test("two devices at once: each keeps the other's half", async () => {
    await using r = await rig()
    await Promise.all([
      ok(r.rpc["projectList.set"], { pinned: ["a"] }),
      ok(r.rpc["projectList.set"], { order: ["b", "c"] }),
      ok(r.rpc["projectList.set"], { pinned: ["a", "d"] }),
    ])
    expect(await ok(r.rpc["projectList.get"], {})).toMatchObject({ pinned: ["a", "d"], order: ["b", "c"] })
  })

  test("every change is announced to the service's other windows and devices", async () => {
    await using r = await rig()
    await ok(r.rpc["projectList.set"], { pinned: ["a"] })
    expect(r.events).toContainEqual(
      expect.objectContaining({
        name: "projectList.changed",
        payload: expect.objectContaining({ list: { pinned: ["a"], order: null, orderedAt: null } }),
      }),
    )
  })

  test("a remote service answers for itself", async () => {
    expect(Register.REMOTE_MANAGED).not.toContain("projectList.set")
  })
})
