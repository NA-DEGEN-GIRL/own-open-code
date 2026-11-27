// 02 §4.8: the process-wide speed marks, tier lists and retention counts (made-up account and model ids).

import { describe, expect, test } from "bun:test"
import { SpeedMarks } from "../src/speed-marks.js"

describe("SpeedMarks.Store", () => {
  test("marks are per account, model and tier; a list refresh clears refusals but not cooldowns", () => {
    const store = new SpeedMarks.Store()
    store.mark("acc_a", "gpt-6-astra", { tier: "ultrafast", status: "unavailable", reason: "status_400" })
    store.mark("acc_a", "gpt-6-astra", { tier: "priority", status: "cooldown", reason: "status_429", until: 10 })
    store.mark("acc_b", "gpt-6-astra", { tier: "ultrafast", status: "unavailable", reason: "status_400" })
    expect(store.marks("acc_a", "gpt-6-astra").map((mark) => mark.tier)).toEqual(["ultrafast", "priority"])
    expect(store.marks("acc_a", "gpt-6-sol")).toEqual([])
    store.clear("acc_a")
    expect(store.marks("acc_a", "gpt-6-astra").map((mark) => mark.status)).toEqual(["cooldown"])
    expect(store.marks("acc_b", "gpt-6-astra")).toHaveLength(1)
  })

  test("cooldowns in a row count strikes; a success resets them", () => {
    const store = new SpeedMarks.Store()
    const cooldown = { tier: "fast", status: "cooldown" as const, reason: "status_429", until: 1 }
    store.mark("acc_c", "claude-opus-5-5", cooldown)
    expect(store.strikes("acc_c", "claude-opus-5-5", "fast")).toBe(0)
    store.mark("acc_c", "claude-opus-5-5", { ...cooldown, until: 2 })
    store.mark("acc_c", "claude-opus-5-5", { ...cooldown, until: 3 })
    expect(store.strikes("acc_c", "claude-opus-5-5", "fast")).toBe(2)
    expect(store.unmark("acc_c", "claude-opus-5-5", "fast")).toBe(true)
    expect(store.strikes("acc_c", "claude-opus-5-5", "fast")).toBe(0)
    expect(store.unmark("acc_c", "claude-opus-5-5", "fast")).toBe(false)
  })

  test("a Sign in with ChatGPT list replaces the last one and clears its refusals; retention counts per kind", () => {
    const store = new SpeedMarks.Store()
    store.mark("acc_s", "gpt-6-astra", { tier: "priority", status: "unavailable", reason: "unsupported" })
    store.setList("acc_s", { fetchedAt: 5, models: new Map([["gpt-6-astra", [{ id: "priority" }]]]) })
    expect(store.list("acc_s")?.models.get("gpt-6-astra")).toEqual([{ id: "priority" }])
    expect(store.marks("acc_s", "gpt-6-astra")).toEqual([])
    store.observe("codex", true)
    store.observe("codex", false)
    store.observe("codex", true)
    expect(store.retention("codex")).toEqual({ kept: 2, lost: 1 })
    expect(store.retention("oai")).toBeUndefined()
  })

  test("served answers count the slower ones in a row and remember an honored tier until the list is read again", () => {
    const store = new SpeedMarks.Store()
    expect(store.served("acc_s", "gpt-6.1-sol", "ultrafast", false)).toEqual({ slower: 1, honored: false })
    expect(store.served("acc_s", "gpt-6.1-sol", "ultrafast", false)).toEqual({ slower: 2, honored: false })
    expect(store.served("acc_s", "gpt-6.1-sol", "priority", false)).toEqual({ slower: 1, honored: false })
    expect(store.served("acc_t", "gpt-6.1-sol", "ultrafast", false)).toEqual({ slower: 1, honored: false })
    expect(store.served("acc_s", "gpt-6.1-sol", "ultrafast", true)).toEqual({ slower: 0, honored: true })
    expect(store.served("acc_s", "gpt-6.1-sol", "ultrafast", false)).toEqual({ slower: 1, honored: true })
    store.clear("acc_s")
    expect(store.served("acc_s", "gpt-6.1-sol", "ultrafast", false)).toEqual({ slower: 1, honored: false })
    expect(store.served("acc_t", "gpt-6.1-sol", "ultrafast", false)).toEqual({ slower: 2, honored: false })
  })
})
