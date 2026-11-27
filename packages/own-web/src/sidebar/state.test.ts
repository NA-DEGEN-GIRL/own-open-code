// Sidebar state units: local read state (7.6 `•`), batched binding watches, event signals, saved preferences.
import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { createSidebarPrefs, readSavedAccounts, saveAccounts } from "./local-state"
import { createReadState } from "./read-state"
import { createSessionSignals } from "./signals"
import { newSessionTarget, setNewSessionTarget, targetFor } from "./target"
import { createWatchSet } from "./watch"

describe("read state (7.6 •)", () => {
  test("a finished turn marks unread until the session is seen; never-seen sessions are not unread", () => {
    localStorage.clear()
    const read = createReadState({ storageKey: "t.read", now: () => 1_000 })
    expect(read.isUnread("a", 5_000)).toBe(false)
    read.markUnread("a")
    expect(read.isUnread("a")).toBe(true)
    read.markSeen("a", 10_000)
    expect(read.isUnread("a", 10_000)).toBe(false)
    // Reload path: the server's `updated` moved past the last seen time.
    expect(read.isUnread("a", 13_000)).toBe(true)
    // Within the slack window it still counts as seen.
    expect(read.isUnread("a", 11_500)).toBe(false)
    read.forget("a")
    expect(read.isUnread("a", 99_000)).toBe(false)
    read.dispose()
  })

  test("persists to storage when idle and reads it back", async () => {
    localStorage.clear()
    const first = createReadState({ storageKey: "t.persist" })
    first.markUnread("x")
    first.markSeen("y", 42)
    // Written after a delay and then when idle: under a full parallel run the idle turn can come well after 1.2 s.
    const deadline = Date.now() + 10_000
    while (localStorage.getItem("t.persist") === null && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    const second = createReadState({ storageKey: "t.persist" })
    expect(second.isUnread("x")).toBe(true)
    expect(second.state.seen.y).toBe(42)
    first.dispose()
    second.dispose()
  })

  test("leaving the page writes a pending change at once (a reload right after opening keeps it read)", () => {
    localStorage.clear()
    const read = createReadState({ storageKey: "t.leave" })
    read.markUnread("z")
    window.dispatchEvent(new Event("pagehide"))
    const before = createReadState({ storageKey: "t.leave" })
    expect(before.isUnread("z")).toBe(true)
    before.dispose()
    read.markSeen("z", 99)
    window.dispatchEvent(new Event("pagehide"))
    const after = createReadState({ storageKey: "t.leave" })
    expect(after.isUnread("z")).toBe(false)
    expect(after.state.seen.z).toBe(99)
    read.dispose()
    after.dispose()
  })

  test("a broken stored value reads as empty", () => {
    localStorage.setItem("t.broken", "{not json")
    const read = createReadState({ storageKey: "t.broken" })
    expect(read.state.unread).toEqual({})
    read.dispose()
  })
})

describe("watch set (batched session.binding)", () => {
  test("adds are watched in one call per change set; a batch is released when all its ids left", () => {
    const calls: string[][] = []
    const released: string[] = []
    const watch = createWatchSet((ids) => {
      calls.push([...ids])
      return () => released.push(ids.join(","))
    })
    watch.sync(["a", "b", "c"])
    watch.sync(["a", "b", "c"])
    expect(calls).toEqual([["a", "b", "c"]])
    watch.sync(["b", "c", "d"])
    expect(calls).toEqual([["a", "b", "c"], ["d"]])
    expect(released).toEqual([])
    watch.sync(["d"])
    expect(released).toEqual(["a,b,c"])
    watch.dispose()
    expect(released).toEqual(["a,b,c", "d"])
    expect(watch.size()).toBe(0)
  })
})

function event(type: string, data: Record<string, unknown>, created = 1): OpenCodeEvent {
  // SAFETY: shaped like the server events the signals read (type, created, data.sessionID).
  return { id: `evt_${Math.random()}`, created, type, data } as unknown as OpenCodeEvent
}

describe("session signals (◐ retry, ! failed, finish)", () => {
  test("retry and failure flags follow execution events; finish listeners fire once per turn end", () => {
    createRoot((dispose) => {
      const bus = createEventBus()
      const signals = createSessionSignals(bus)
      const finished: string[] = []
      signals.onFinished((id) => finished.push(id))
      bus.publish(event("session.execution.started", { sessionID: "s" }, 10))
      bus.publish(event("session.retry.scheduled", { sessionID: "s" }, 11))
      bus.flush()
      expect(signals.state.retry.s).toBe(true)
      expect(signals.state.activity.s).toBe(10)
      bus.publish(event("session.execution.failed", { sessionID: "s" }, 12))
      bus.flush()
      expect(signals.state.retry.s).toBeUndefined()
      expect(signals.state.failed.s).toBe(true)
      expect(finished).toEqual(["s"])
      bus.publish(event("session.execution.started", { sessionID: "s" }, 13))
      bus.publish(event("session.execution.succeeded", { sessionID: "s" }, 14))
      bus.flush()
      expect(signals.state.failed.s).toBeUndefined()
      expect(signals.state.activity.s).toBe(14)
      expect(finished).toEqual(["s", "s"])
      signals.dispose()
      bus.dispose()
      dispose()
    })
  })
})

describe("preferences and saved accounts", () => {
  test("collapsed projects and opened subagents survive a reload; storage failures fall back", async () => {
    localStorage.clear()
    await createRoot(async (dispose) => {
      const prefs = createSidebarPrefs("test")
      prefs.toggleProject("A")
      prefs.toggleChildren("s1", true)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const again = createSidebarPrefs("test")
      expect(again.collapsed("A")).toBe(true)
      expect(again.expanded("s1")).toBe(true)
      again.toggleProject("A")
      expect(again.collapsed("A")).toBe(false)
      dispose()
    })
  })

  test("saved accounts keep only display fields", () => {
    localStorage.clear()
    saveAccounts("local", [
      {
        id: "acc_1",
        providerID: "own-oai-a",
        label: "Alpha",
        shortLabel: "Al",
        color: "teal",
        thirdParty: false,
        status: "ready",
        lastUsedAt: 5,
      },
    ])
    const raw = JSON.parse(localStorage.getItem("own.web.sidebar.accounts.local") ?? "[]")
    expect(Object.keys(raw[0]).toSorted()).toEqual(
      ["color", "id", "label", "providerID", "shortLabel", "status", "thirdParty"].toSorted(),
    )
    expect(readSavedAccounts("local")[0]?.label).toBe("Alpha")
    localStorage.setItem("own.web.sidebar.accounts.local", '[{"id":1}]')
    expect(readSavedAccounts("local")).toEqual([])
  })
})

describe("new-session target (18.3 hand-off)", () => {
  test("valid only for the matching server and project", () => {
    setNewSessionTarget({ serverKey: "local", projectID: "prj_a", directory: "D:\\a" })
    expect(newSessionTarget()?.directory).toBe("D:\\a")
    expect(targetFor("local", "prj_a")?.directory).toBe("D:\\a")
    expect(targetFor("local", "prj_b")).toBeUndefined()
    setNewSessionTarget(undefined)
    expect(newSessionTarget()).toBeUndefined()
  })
})
