// Whole report texts outside the digest (2026-11-14, `report/texts.ts`): the newest report of each kind per seat,
// relays newest first kept by size with a dropped count, the reports of a stretch of direct work kept by size with the
// newest always kept, open report kinds, and an invalid stored value read as absent with a warning. The KV is an
// in-memory store; the logger writes to a list.

import { describe, expect, test } from "bun:test"
import type { Schema } from "effect"
import { Log } from "../../src/log.js"
import { Keys } from "../../src/registry/keys.js"
import { Texts } from "../../src/report/texts.js"
import { TEAM_ID } from "../support/context.js"

const AREA = "ar_inventory"
const T0 = Date.UTC(2026, 10, 14, 4, 0, 0)

function memory(): Keys.Store {
  const values = new Map<string, Schema.Json>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async (prefix) =>
      [...values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  }
}

function logger() {
  const lines: string[] = []
  return { lines, log: Log.create({ scope: "test", sink: (line) => lines.push(line) }) }
}

const item = (kind: string, text: string, at: number, peer?: string): Texts.TextItem => ({
  kind,
  text,
  at,
  ...(peer === undefined ? {} : { peer }),
})

describe("an area's whole reports and relays", () => {
  test("one report per seat and kind: a newer one replaces it in place, other seats and kinds stay", () => {
    const first = Texts.report(undefined, item("progress", "시작", T0))
    const second = Texts.report(first, item("ready", "준비됨", T0 + 1))
    const peer = Texts.report(second, item("progress", "동료 진행", T0 + 2, "reviewer"))
    const replaced = Texts.report(peer, item("progress", "중간", T0 + 3))
    expect(replaced.reports).toEqual([
      item("progress", "중간", T0 + 3),
      item("ready", "준비됨", T0 + 1),
      item("progress", "동료 진행", T0 + 2, "reviewer"),
    ])
    const long = "가".repeat(20_000)
    expect(Texts.report(replaced, item("blocked", long, T0 + 4)).reports.at(-1)?.text).toBe(long)
  })

  test("relays newest first, kept while they fit 100,000 characters; the dropped ones are counted", () => {
    expect(Texts.RELAY_CHARS).toBe(100_000)
    const big = (n: number) => "x".repeat(n)
    const one = Texts.relay(undefined, item("relay", big(60_000), T0))
    expect(one).toEqual({ reports: [], relays: [item("relay", big(60_000), T0)] })
    const two = Texts.relay(one, item("relay", big(40_000), T0 + 1))
    expect(two.relays?.map((relay) => relay.at)).toEqual([T0 + 1, T0])
    expect(two.relaysDropped).toBeUndefined()
    const three = Texts.relay(two, item("relay", "짧은 부탁", T0 + 2))
    expect(three.relays?.map((relay) => relay.at)).toEqual([T0 + 2, T0 + 1])
    expect(three.relaysDropped).toBe(1)
    // One relay longer than the whole budget is still kept (always at least one), and the count adds up.
    const huge = Texts.relay(Texts.report(three, item("done", "끝", T0 + 3)), item("relay", big(150_000), T0 + 4))
    expect(huge.relays?.map((relay) => relay.at)).toEqual([T0 + 4])
    expect(huge.relaysDropped).toBe(3)
    expect(huge.reports).toEqual([item("done", "끝", T0 + 3)])
  })
})

describe("the reports of a stretch of direct work", () => {
  test("appended oldest first; another stretch starts fresh, keeping the handed one; the hand-back sets `until`", () => {
    expect(Texts.STRETCH_CHARS).toBe(100_000)
    const first = Texts.append(undefined, T0, item("progress", "하나", T0 + 1))
    const second = Texts.append(first, T0, item("blocked", "둘", T0 + 2, "reviewer"))
    expect(second).toEqual({
      since: T0,
      items: [item("progress", "하나", T0 + 1), item("blocked", "둘", T0 + 2, "reviewer")],
    })
    const ended = Texts.end(second, T0, T0 + 9)
    expect(ended).toEqual({ ...second, until: T0 + 9 })
    // The next stretch keeps the handed one as `previous` (its hand-back line points the main at it) until it is
    // handed back in turn (2026-11-15).
    const next = Texts.append(ended, T0 + 100, item("done", "셋", T0 + 101))
    expect(next).toEqual({ since: T0 + 100, items: [item("done", "셋", T0 + 101)], previous: ended })
    expect(Texts.append(next, T0 + 100, item("progress", "넷", T0 + 102)).previous).toEqual(ended)
    expect(Texts.end(next, T0 + 100, T0 + 200)).toEqual({
      since: T0 + 100,
      until: T0 + 200,
      items: [item("done", "셋", T0 + 101)],
    })
    // A stretch still open when another starts (not handed back: the area was retired) is not kept.
    expect(Texts.append(second, T0 + 100, item("done", "셋", T0 + 101))).toEqual({
      since: T0 + 100,
      items: [item("done", "셋", T0 + 101)],
    })
    // A stretch without reports keeps its time range.
    expect(Texts.end(undefined, T0, T0 + 5)).toEqual({ since: T0, until: T0 + 5, items: [] })
  })

  test("past 100,000 characters the oldest go and are counted; the newest always stays", () => {
    const stretch = [40_000, 40_000, 30_000].reduce<Texts.Stretch | undefined>(
      (current, size, index) => Texts.append(current, T0, item("progress", "x".repeat(size), T0 + index)),
      undefined,
    )
    expect(stretch?.items.map((kept) => kept.at)).toEqual([T0 + 1, T0 + 2])
    expect(stretch?.dropped).toBe(1)
    const huge = Texts.append(stretch, T0, item("ready", "y".repeat(120_000), T0 + 3))
    expect(huge.items.map((kept) => kept.at)).toEqual([T0 + 3])
    expect(huge.dropped).toBe(3)
  })
})

describe("stored values", () => {
  test("saved and loaded under their keys; an unknown kind decodes; nothing stored is absent without a warning", async () => {
    const kv = memory()
    const quiet = logger()
    expect(await Texts.load(kv, quiet.log, TEAM_ID, AREA)).toBeUndefined()
    expect(await Texts.loadStretch(kv, quiet.log, TEAM_ID, AREA)).toBeUndefined()
    expect(quiet.lines).toEqual([])
    const texts = Texts.relay(
      Texts.report(undefined, item("failed-later-kind", "새 종류", T0)),
      item("relay", "부탁", T0),
    )
    await Texts.save(kv, TEAM_ID, AREA, texts)
    expect(await kv.get(Keys.report(TEAM_ID, AREA))).toBeDefined()
    expect(await Texts.load(kv, quiet.log, TEAM_ID, AREA)).toEqual(texts)
    const stretch = Texts.end(Texts.append(undefined, T0, item("progress", "진행", T0 + 1)), T0, T0 + 2)
    await Texts.saveStretch(kv, TEAM_ID, AREA, stretch)
    expect(await Texts.loadStretch(kv, quiet.log, TEAM_ID, AREA)).toEqual(stretch)
    expect(quiet.lines).toEqual([])
    expect(Keys.ofTeam(TEAM_ID)).toEqual(
      expect.arrayContaining([`report:${TEAM_ID}:`, `stretch:${TEAM_ID}:`, `instructions:${TEAM_ID}`]),
    )
  })

  test("an invalid value reads as absent and is logged; another area's value is untouched", async () => {
    const kv = memory()
    const noisy = logger()
    await kv.set(Keys.report(TEAM_ID, AREA), { reports: "nope" })
    await kv.set(Keys.stretch(TEAM_ID, AREA), { since: "x", items: [] })
    const other = Texts.report(undefined, item("done", "다른 영역", T0))
    await Texts.save(kv, TEAM_ID, "ar_other", other)
    expect(await Texts.load(kv, noisy.log, TEAM_ID, AREA)).toBeUndefined()
    expect(await Texts.loadStretch(kv, noisy.log, TEAM_ID, AREA)).toBeUndefined()
    expect(noisy.lines).toHaveLength(2)
    expect(noisy.lines.every((line) => JSON.parse(line).level === "warn")).toBe(true)
    expect(await Texts.load(kv, noisy.log, TEAM_ID, "ar_other")).toEqual(other)
  })
})
