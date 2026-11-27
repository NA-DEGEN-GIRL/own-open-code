// Pin/archive flags (03 §19.11, 01 §17.1 #27): the own metadata namespace, read-modify-write merging, fork clearing,
// event ingest and the local cache. Writes against the real server are covered by e2e/session-ux.
import { describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import {
  createOwnFlags,
  FLAG_KEYS,
  flagsOf,
  PROJECT_ARCHIVE_KEY,
  registerFlagStore,
  sessionFlags,
  withFlag,
  withoutFlags,
  withProjectArchive,
} from "./flags"
import { flattenTree, PINNED_GROUP, rowKey, sessionIDIn, dayMarks } from "./model"

const noClient = (): OpenCodeClient => {
  throw new Error("not connected")
}

function event(type: string, data: Record<string, unknown>): OpenCodeEvent {
  // SAFETY: the test builds the two event shapes the store reads (`type`, `data`); the bus only routes by `type`.
  return { id: `evt_${Math.random()}`, created: Date.now(), type, data } as unknown as OpenCodeEvent
}

describe("metadata flags (own namespace)", () => {
  test("flags read from own keys only; numbers are times, true counts as set, anything else is off", () => {
    expect(FLAG_KEYS).toEqual({ pinned: "own.pinned", archived: "own.archived" })
    expect(flagsOf({ "own.pinned": 1700, "own.archived": true, pinned: 5 })).toEqual({ pinned: 1700, archived: 1 })
    expect(flagsOf({ "own.pinned": "yes", "own.archived": 0 })).toEqual({ pinned: undefined, archived: undefined })
    expect(flagsOf(undefined)).toEqual({ pinned: undefined, archived: undefined })
    expect(flagsOf([1, 2])).toEqual({})
  })

  test("writes change one key and keep every other host's key (PATCH replaces the whole object)", () => {
    const metadata = { "other.host": { a: 1 }, "own.note": "메모" }
    expect(withFlag(metadata, "pinned", 42)).toEqual({ "other.host": { a: 1 }, "own.note": "메모", "own.pinned": 42 })
    expect(withFlag({ ...metadata, "own.archived": 7 }, "archived", undefined)).toEqual(metadata)
    expect(withFlag(undefined, "archived", 9)).toEqual({ "own.archived": 9 })
  })

  test("the project archive (19.11a): one stamp on both keys; unarchiving one session drops the project mark too", () => {
    expect(PROJECT_ARCHIVE_KEY).toBe("own.archivedWithProject")
    const archived = withProjectArchive({ "own.note": "n" }, 9)
    expect(archived).toEqual({ "own.note": "n", "own.archived": 9, "own.archivedWithProject": 9 })
    expect(flagsOf(archived)).toEqual({ archived: 9, project: 9 })
    expect(withProjectArchive(archived, undefined)).toEqual({ "own.note": "n" })
    expect(withFlag(archived, "archived", undefined)).toEqual({ "own.note": "n" })
    // Pinning keeps the mark.
    expect(withFlag(archived, "pinned", 3)).toEqual({ ...archived, "own.pinned": 3 })
    expect(withoutFlags({ "own.archivedWithProject": 1, "own.note": "n" })).toEqual({ "own.note": "n" })
  })

  test("a fork drops both flags and keeps the rest; nothing to write when it has none", () => {
    expect(withoutFlags({ "own.pinned": 1, "own.archived": 2, "own.note": "n" })).toEqual({ "own.note": "n" })
    expect(withoutFlags({ "own.note": "n" })).toBeUndefined()
    expect(withoutFlags(undefined)).toBeUndefined()
  })
})

describe("flag store", () => {
  test("metadata events are authoritative; created children never pin; deleted sessions are forgotten", () => {
    localStorage.clear()
    createRoot((dispose) => {
      const bus = createEventBus()
      const flags = createOwnFlags({ serverKey: "t", bus, client: noClient })
      bus.publish(event("session.metadata.updated", { sessionID: "a", metadata: { "own.pinned": 10 } }))
      bus.publish(event("session.created", { sessionID: "b", metadata: { "own.archived": 20 } }))
      bus.publish(event("session.created", { sessionID: "c", parentID: "b", metadata: { "own.archived": 20 } }))
      bus.flush()
      expect(flags.pinned("a")).toBe(true)
      expect(flags.archived("b")).toBe(true)
      expect(flags.archived("c")).toBe(false)
      bus.publish(event("session.metadata.updated", { sessionID: "a", metadata: {} }))
      bus.publish(event("session.deleted", { sessionID: "b" }))
      bus.flush()
      expect(flags.pinned("a")).toBe(false)
      expect(flags.archived("b")).toBe(false)
      flags.dispose()
      dispose()
    })
  })

  test("infos of subagents drop inherited flags; archived ids come newest first", () => {
    localStorage.clear()
    createRoot((dispose) => {
      const flags = createOwnFlags({ serverKey: "t", bus: createEventBus(), client: noClient })
      flags.ingest("child", { "own.pinned": 1 })
      // SAFETY: only `id`, `parentID` and `metadata` are read from these infos.
      flags.ingestInfos([
        { id: "child", parentID: "root", metadata: { "own.pinned": 1 } },
        { id: "x", metadata: { "own.archived": 5 } },
        { id: "y", metadata: { "own.archived": 9 } },
      ] as never)
      expect(flags.pinned("child")).toBe(false)
      expect(flags.archivedIDs()).toEqual(["y", "x"])
      flags.dispose()
      dispose()
    })
  })

  test("a failed write puts the previous value back", async () => {
    localStorage.clear()
    const failures: string[] = []
    await createRoot(async (dispose) => {
      const flags = createOwnFlags({
        serverKey: "t",
        bus: createEventBus(),
        client: noClient,
        onError: (key, on) => failures.push(`${key}:${on}`),
      })
      flags.ingest("a", { "own.archived": 3 })
      const pending = flags.set("a", "pinned", true)
      expect(await pending).toBe(false)
      expect(flags.pinned("a")).toBe(false)
      expect(flags.archived("a")).toBe(true)
      expect(failures).toEqual(["pinned:true"])
      flags.dispose()
      dispose()
    })
  })

  test("the local cache paints the flags of the last run (PF1) and survives a broken value", async () => {
    localStorage.clear()
    await createRoot(async (dispose) => {
      const first = createOwnFlags({ serverKey: "persist", bus: createEventBus(), client: noClient })
      first.ingest("p", { "own.pinned": 77 })
      // The save runs 800 ms after the change and then in an idle task (setTimeout 0 under happy-dom). A fixed 1.1 s
      // sleep lost to a loaded loop: when both timers were overdue at once, the sleep resolved before the save's task.
      const deadline = Date.now() + 10_000
      while (localStorage.getItem("own.web.sidebar.flags.persist") === null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50))
      const second = createOwnFlags({ serverKey: "persist", bus: createEventBus(), client: noClient })
      expect(second.state.pinned.p).toBe(77)
      localStorage.setItem("own.web.sidebar.flags.broken", "{nope")
      const broken = createOwnFlags({ serverKey: "broken", bus: createEventBus(), client: noClient })
      expect(broken.state).toEqual({ pinned: {}, archived: {}, project: {} })
      ;[first, second, broken].forEach((flags) => flags.dispose())
      dispose()
    })
  })
})

describe("tree with flags (19.11)", () => {
  const NOW = new Date(2026, 8, 23, 15, 0, 0).getTime()
  const sessions: Record<string, { projectID: string; updated: number }> = {
    a1: { projectID: "A", updated: NOW - 1 },
    b1: { projectID: "B", updated: NOW - 2 },
    a2: { projectID: "A", updated: NOW - 3 },
    old: { projectID: "B", updated: NOW - 90 * 24 * 3600_000 },
  }
  const base = {
    session: (id: string) => sessions[id],
    collapsed: () => false,
    expanded: () => false,
    children: () => [],
    marks: dayMarks(NOW),
    more: false,
  }

  test("pinned sessions leave their project for the 고정됨 group, newest first; archived ones are hidden", () => {
    const out = flattenTree({
      ...base,
      order: ["a1", "b1", "a2", "old"],
      pinned: (id) => id === "old" || id === "a2",
      hidden: (id) => id === "b1",
    })
    expect(out.keys).toEqual([rowKey.pinned, "s|a2", "s|old", "p|A", "s|a1"])
    expect(out.counts[PINNED_GROUP]).toBe(2)
    expect(out.positions.get(rowKey.pinned)).toEqual([1, 2])
    expect(out.positions.get("p|A")).toEqual([2, 2])
  })

  test("a folded 고정됨 group keeps its header; search lists pinned and archived sessions in their projects", () => {
    const folded = flattenTree({
      ...base,
      order: ["a1", "a2"],
      pinned: (id) => id === "a2",
      collapsed: (id) => id === PINNED_GROUP,
    })
    expect(folded.keys).toEqual([rowKey.pinned, "p|A", "s|a1"])
    const searching = flattenTree({
      ...base,
      order: ["a1", "b1", "a2"],
      pinned: (id) => id === "a2",
      hidden: (id) => id === "b1",
      match: () => true,
    })
    expect(searching.keys).toEqual(["p|A", "s|a1", "s|a2", "p|B", "s|b1"])
  })

  test("the archive view has no date headers", () => {
    const out = flattenTree({ ...base, order: ["a1", "old"], dates: false })
    expect(out.keys).toEqual(["p|A", "s|a1", "p|B", "s|old"])
  })
})

describe("session id in a pasted value (19.11)", () => {
  const id = "ses_01JABCDEFGHJKMNPQRSTVW"
  test("the id itself, or inside a link or route", () => {
    expect(sessionIDIn(`  ${id} `)).toBe(id)
    expect(sessionIDIn(`http://127.0.0.1:5173/srv/local/s/${id}`)).toBe(id)
    expect(sessionIDIn(`/s/${id}?x=1`)).toBe(id)
    expect(sessionIDIn(`oc://renderer/#/srv/local/s/${id}`)).toBe(id)
  })

  test("titles and short tokens are not ids", () => {
    expect(sessionIDIn("결제 웹훅 ses_01JABCDEFGHJKMNPQRSTVW")).toBeUndefined()
    expect(sessionIDIn("/s/ses_short")).toBeUndefined()
    expect(sessionIDIn("rpc")).toBeUndefined()
  })
})

describe("live flag store per server (header `⋯`, palette)", () => {
  test("the tree's store is found by server key while registered; a stale release does not drop a newer store", () => {
    createRoot((dispose) => {
      const first = createOwnFlags({ serverKey: "live", bus: createEventBus(), client: noClient })
      const second = createOwnFlags({ serverKey: "live", bus: createEventBus(), client: noClient })
      expect(sessionFlags("live")).toBeUndefined()
      const releaseFirst = registerFlagStore("live", first)
      expect(sessionFlags("live")).toBe(first)
      const releaseSecond = registerFlagStore("live", second)
      releaseFirst()
      expect(sessionFlags("live")).toBe(second)
      releaseSecond()
      expect(sessionFlags("live")).toBeUndefined()
      first.dispose()
      second.dispose()
      dispose()
    })
  })
})
