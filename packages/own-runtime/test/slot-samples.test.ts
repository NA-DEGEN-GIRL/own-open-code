import { describe, expect, test } from "bun:test"
import { SlotSamples } from "../src/index.js"

describe("SlotSamples (09 §5.6)", () => {
  test("keeps the most recent samples per slot and kind", () => {
    const store = new SlotSamples.Store()
    expect(store.get("own-ds-aaaa", "Z")).toEqual([])
    Array.from({ length: SlotSamples.KEEP + 3 }, (_, index) => store.add("own-ds-aaaa", "Z", index))
    store.add("own-ds-aaaa", "delta", 7)
    store.add("own-codex-bbbb", "Z", 11)
    expect(store.get("own-ds-aaaa", "Z")).toEqual(Array.from({ length: SlotSamples.KEEP }, (_, index) => index + 3))
    expect(store.get("own-ds-aaaa", "delta")).toEqual([7])
    expect(store.get("own-codex-bbbb", "Z")).toEqual([11])
    expect(store.get("own-codex-bbbb", "delta")).toEqual([])
  })
})
