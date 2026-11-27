// Reports and waking, the pure part (06 §5.5–5.6): the wake table exactly as §5.6 has it, entries and their keys,
// the status an owner settles at, `끝났지만 보고 없음`, `모두 끝남`, the 30 s debounce, the hourly limit, the one
// undelivered update in the main inbox, and the session log events own.team folds.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Fold } from "../../src/report/fold.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"

const AREA = OwnTeam.AreaID.make("ar_inventory")
const D1 = OwnTeam.DispatchID.make("dp_01JAX0000000000000000000A1")
const D2 = OwnTeam.DispatchID.make("dp_01JAX0000000000000000000A2")
const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)

function withEntries(...items: ReadonlyArray<{ at: number; reason: Fold.Reason }>) {
  return items.reduce(
    (state, item) => Fold.append(state, Fold.entry({ at: item.at, reason: item.reason, text: item.reason })),
    Fold.empty(TEAM_ID),
  )
}

describe("wake table (06 §5.6)", () => {
  test("wakes the main for 모두 끝남, ready, blocked, a failed run, a failed integration, a refused peer request, the hourly limit of area messages and a main request that could not go (RH-20) only", () => {
    const waking = Object.entries(Fold.WAKES)
      .filter(([, wake]) => wake)
      .map(([reason]) => reason)
      .toSorted()
    expect(waking).toEqual([
      "all-done",
      "area-limit",
      "blocked",
      "failed",
      "handed",
      "integration-failed",
      "ready",
      "refused",
      "relay",
      "request-failed",
    ])
    // 사용자 부탁 (5.5, 2026-10-16) wakes but is no report: the report kinds stay four.
    expect(Fold.ReportKind.literals).toEqual(["progress", "done", "ready", "blocked"])
  })

  test("folds an owner turn, progress, an open done, direct talk, Main 멈춤, completions, a first conflict, questions, limits and 끝났지만 보고 없음", () => {
    for (const reason of [
      "succeeded",
      "progress",
      "done",
      "direct",
      "paused",
      "resumed",
      "reorganized",
      "integrated",
      "conflict",
      "asking",
      "quota",
      "unreported",
    ] as const)
      expect(Fold.WAKES[reason]).toBe(false)
  })

  test("a moved seat (담당 대화 바꾸기) is one line of the next update, kept once per op, and never a wake", () => {
    const entry = Fold.entry({ at: T0, reason: "seated", text: "'ui' 영역의 담당이 바뀌었습니다.", areaID: AREA })
    expect(entry.wake).toBe(false)
    const state = Fold.append(Fold.empty(TEAM_ID), entry, "seat:op_1")
    expect(Fold.append(state, entry, "seat:op_1")).toBe(state)
    expect(state.entries.map((item) => item.reason)).toEqual(["seated"])
    expect(Fold.due(state)).toBeUndefined()
  })

  test("direct work (2026-11-14): a hand-back wakes, the main taking an area back and a role change do not", () => {
    expect(Fold.WAKES.handed).toBe(true)
    expect(Fold.WAKES.taken).toBe(false)
    expect(Fold.WAKES.role).toBe(false)
  })

  test("an entry takes its wake from the table", () => {
    expect(Fold.entry({ at: T0, reason: "ready", text: "x", areaID: AREA })).toEqual({
      at: T0,
      reason: "ready",
      text: "x",
      wake: true,
      areaID: AREA,
    })
    expect(Fold.entry({ at: T0, reason: "progress", text: "x" }).wake).toBe(false)
  })

  test("`wake` overrides the table: a report stored during direct work does not wake", () => {
    expect(Fold.entry({ at: T0, reason: "ready", text: "x", areaID: AREA, wake: false }).wake).toBe(false)
    expect(Fold.entry({ at: T0, reason: "blocked", text: "x", wake: false }).wake).toBe(false)
    expect(Fold.entry({ at: T0, reason: "progress", text: "x", wake: true }).wake).toBe(true)
    expect(Fold.entry({ at: T0, reason: "failed", text: "x" }).wake).toBe(true)
  })
})

describe("excerpts and the stretch summary (2026-11-14)", () => {
  test("an excerpt keeps 1,000 code points and marks a cut with …; it never splits a surrogate pair", () => {
    expect(Fold.EXCERPT).toBe(1_000)
    const short = "가".repeat(1_000)
    expect(Fold.excerpt(short)).toBe(short)
    expect(Fold.excerpt(`${short}나`)).toBe(`${short}…`)
    // 1,000 emoji are 2,000 UTF-16 units and still fit; the 1,001st is cut whole.
    const emoji = "😀".repeat(1_000)
    expect(Fold.excerpt(emoji)).toBe(emoji)
    expect(Fold.excerpt(`${emoji}😀`)).toBe(`${emoji}…`)
    expect(Fold.excerpt("a😀b", 1)).toBe("a…")
    expect(Fold.excerpt("😀😀b", 1)).toBe("😀…")
    expect(Fold.excerpt("", 3)).toBe("")
  })

  test("a report while held counts into the area's stretch: per kind, the newest on one line within 160", () => {
    const first = Fold.stretch(Fold.empty(TEAM_ID), { areaID: AREA, since: T0, kind: "progress", excerpt: "화면 정리" })
    const long = `반영 준비

${"가".repeat(300)}`
    const second = Fold.stretch(first, { areaID: AREA, since: T0, kind: "ready", excerpt: long })
    const third = Fold.stretch(second, { areaID: AREA, since: T0, kind: "progress", excerpt: "다음 화면" })
    expect(Fold.area(second, AREA).stretch).toEqual({
      since: T0,
      n: 2,
      kinds: { progress: 1, ready: 1 },
      last: `반영 준비 ${"가".repeat(Fold.STRETCH_LAST - 6)}…`,
    })
    expect(Fold.area(third, AREA).stretch).toEqual({
      since: T0,
      n: 3,
      kinds: { progress: 2, ready: 1 },
      last: "다음 화면",
    })
    // An unknown kind is counted as written (open string).
    const failed = Fold.stretch(third, { areaID: AREA, since: T0, kind: "failed", excerpt: "실패" })
    expect(Fold.area(failed, AREA).stretch?.kinds).toEqual({ progress: 2, ready: 1, failed: 1 })
    // The hand-back sets `until`; the next stretch starts fresh.
    const ended = Fold.stretchEnd(failed, { areaID: AREA, since: T0, until: T0 + 60_000 })
    expect(Fold.area(ended, AREA).stretch).toMatchObject({ since: T0, until: T0 + 60_000, n: 4 })
    const next = Fold.stretch(ended, { areaID: AREA, since: T0 + 120_000, kind: "done", excerpt: "끝" })
    expect(Fold.area(next, AREA).stretch).toEqual({ since: T0 + 120_000, n: 1, kinds: { done: 1 }, last: "끝" })
    // A stretch without reports still has its time range.
    expect(
      Fold.area(Fold.stretchEnd(Fold.empty(TEAM_ID), { areaID: AREA, since: T0, until: T0 + 1 }), AREA).stretch,
    ).toEqual({
      since: T0,
      until: T0 + 1,
      n: 0,
      kinds: {},
    })
  })

  test("a digest with the new area fields decodes, and one without them still does", () => {
    const decode = Schema.decodeUnknownSync(Fold.State)
    const state = Fold.withArea(Fold.empty(TEAM_ID), AREA, (fold) => ({
      ...fold,
      ended: D1,
      stretch: { since: T0, until: T0 + 1, n: 1, kinds: { relay: 1 }, last: "x" },
    }))
    expect(decode(state)).toEqual(state)
    expect(decode(Fold.empty(TEAM_ID))).toEqual(Fold.empty(TEAM_ID))
  })
})

describe("entries", () => {
  test("numbers entries, keeps a log event once by its key and drops the oldest past the cap", () => {
    const one = Fold.append(Fold.empty(TEAM_ID), Fold.entry({ at: T0, reason: "failed", text: "a" }), "ses_x:4")
    const again = Fold.append(one, Fold.entry({ at: T0, reason: "failed", text: "a" }), "ses_x:4")
    expect(again).toBe(one)
    expect(one.entries.map((item) => [item.n, item.key])).toEqual([[0, "ses_x:4"]])
    const many = Array.from({ length: Fold.MAX_ENTRIES + 5 }, (_, index) => index).reduce(
      (state, index) => Fold.append(state, Fold.entry({ at: T0 + index, reason: "progress", text: String(index) })),
      Fold.empty(TEAM_ID),
    )
    expect(many.entries).toHaveLength(Fold.MAX_ENTRIES)
    expect(many.entries[0]?.n).toBe(5)
    expect(many.next).toBe(Fold.MAX_ENTRIES + 5)
  })

  test("told drops what an update carried; the reasons of the rest are the waking ones, once each", () => {
    const state = withEntries(
      { at: T0, reason: "ready" },
      { at: T0 + 1, reason: "progress" },
      { at: T0 + 2, reason: "failed" },
      { at: T0 + 3, reason: "ready" },
    )
    expect(Fold.reasons(state)).toEqual(["ready", "failed"])
    expect(Fold.told(state, 1).entries.map((item) => item.reason)).toEqual(["failed", "ready"])
  })
})

describe("area fold", () => {
  const received = (at: number, dispatchID = D1): Fold.AreaFold => ({
    reports: {},
    queued: {},
    received: { dispatchID, at },
  })
  const report = (fold: Fold.AreaFold, kind: Fold.ReportKind, at: number): Fold.AreaFold => ({
    ...fold,
    reports: { ...fold.reports, [kind]: { text: kind, at } },
  })

  test("an owner settles at its answer to the last request it received", () => {
    expect(Fold.settled(report(received(T0), "ready", T0 + 1))).toBe("ready")
    expect(Fold.settled(report(received(T0), "blocked", T0 + 1))).toBe("blocked")
    expect(Fold.settled(report(received(T0), "done", T0 + 1))).toBe("idle")
    expect(Fold.settled(report(report(received(T0), "ready", T0 + 1), "done", T0 + 2))).toBe("idle")
    // A ready from before the request it is now working on does not count.
    expect(Fold.settled(report(received(T0 + 5), "ready", T0 + 1))).toBe("idle")
    expect(Fold.settled({ reports: { ready: { text: "x", at: T0 } }, queued: {} })).toBe("ready")
  })

  test("끝났지만 보고 없음: a received request without done, ready or blocked after it, once per request", () => {
    expect(Fold.unreported(received(T0))).toBe(D1)
    expect(Fold.unreported(report(received(T0), "progress", T0 + 1))).toBe(D1)
    expect(Fold.unreported(report(received(T0), "done", T0 + 1))).toBeUndefined()
    expect(Fold.unreported(report(received(T0), "blocked", T0 + 1))).toBeUndefined()
    expect(Fold.unreported({ ...received(T0), unreported: D1 })).toBeUndefined()
    expect(Fold.unreported({ ...received(T0 + 5, D2), unreported: D1 })).toBe(D2)
    expect(Fold.unreported({ reports: {}, queued: {} })).toBeUndefined()
  })

  test("latest and finished read the newest reports", () => {
    const fold = report(report(report(received(T0), "done", T0 + 1), "progress", T0 + 3), "ready", T0 + 2)
    expect(Fold.latest(fold)?.kind).toBe("progress")
    expect(Fold.finished(fold)).toBe(T0 + 2)
  })
})

describe("모두 끝남 (06 §5.6)", () => {
  const idle = { paused: false, waiting: 0, queued: 0, active: false }

  test("every open area idle with done or ready after its last request", () => {
    expect(Fold.allDone([{ ...idle, sent: T0, finished: T0 + 1 }, { ...idle }])).toBe(true)
    expect(
      Fold.allDone([
        { ...idle, sent: T0, finished: T0 + 1 },
        { ...idle, sent: T0, finished: T0 - 1 },
      ]),
    ).toBe(false)
  })

  test("not while a request waits in the outbox or the owner's inbox, or an owner runs", () => {
    const done = { ...idle, sent: T0, finished: T0 + 1 }
    expect(Fold.allDone([{ ...done, waiting: 1 }])).toBe(false)
    expect(Fold.allDone([{ ...done, queued: 1 }])).toBe(false)
    expect(Fold.allDone([{ ...done, active: true }])).toBe(false)
  })

  test("areas with Main 멈춤 are left out; nothing sent, or nothing new since the last 모두 끝남, is not a batch", () => {
    expect(
      Fold.allDone([
        { ...idle, sent: T0, finished: T0 + 1 },
        { ...idle, paused: true, waiting: 3, active: true },
      ]),
    ).toBe(true)
    expect(Fold.allDone([{ ...idle }])).toBe(false)
    expect(Fold.allDone([{ ...idle, paused: true, sent: T0, finished: T0 + 1 }])).toBe(false)
    expect(Fold.allDone([{ ...idle, sent: T0, finished: T0 + 1 }], T0 + 2)).toBe(false)
    expect(Fold.allDone([{ ...idle, sent: T0 + 3, finished: T0 + 4 }], T0 + 2)).toBe(true)
  })
})

describe("timing (06 §5.6 묶기)", () => {
  test("debounces 30 s after the last waking entry; folds alone never wake", () => {
    expect(Fold.due(withEntries({ at: T0, reason: "progress" }))).toBeUndefined()
    expect(Fold.due(withEntries({ at: T0, reason: "ready" }))).toBe(T0 + Fold.DEBOUNCE_MS)
    expect(
      Fold.due(
        withEntries(
          { at: T0, reason: "ready" },
          { at: T0 + 10_000, reason: "blocked" },
          { at: T0 + 20_000, reason: "progress" },
        ),
      ),
    ).toBe(T0 + 10_000 + Fold.DEBOUNCE_MS)
  })

  test("an undelivered update is looked at again after CHECK_MS, a failed send retried after RETRY_MS", () => {
    const state = withEntries({ at: T0, reason: "ready" })
    const sent = { ...state, pending: { seq: 1, msgID: "msg_x", sessionID: MAIN_SESSION, at: T0, sent: true, upTo: 0 } }
    expect(Fold.due(sent)).toBe(T0 + Fold.CHECK_MS)
    expect(Fold.due({ ...sent, pending: { ...sent.pending, checked: T0 + 1_000 } })).toBe(T0 + 1_000 + Fold.CHECK_MS)
    expect(Fold.due({ ...sent, pending: { ...sent.pending, sent: false } })).toBe(T0 + Fold.RETRY_MS)
  })

  test("at most 12 an hour: the 13th waits until the oldest of the last 12 is an hour old", () => {
    const sends = Array.from({ length: 12 }, (_, index) => T0 + index * 60_000)
    expect(Fold.limit(sends.slice(1), T0 + 12 * 60_000)).toBeUndefined()
    expect(Fold.limit(sends, T0 + 12 * 60_000)).toBe(T0 + Fold.HOUR_MS)
    expect(Fold.limit([T0 - Fold.HOUR_MS, ...sends.slice(1)], T0 + 12 * 60_000)).toBeUndefined()
    expect(Fold.recent([T0 - Fold.HOUR_MS, T0], T0 + 1)).toEqual([T0])
  })
})

describe("the main inbox (one undelivered team update)", () => {
  const MAIN = MAIN_SESSION
  const base = withEntries({ at: T0, reason: "ready" }, { at: T0 + 1, reason: "failed" })
  const pending = (sent: boolean, upTo = 0): Fold.State => ({
    ...base,
    seq: 3,
    pending: { seq: 3, msgID: "msg_three", sessionID: MAIN, at: T0 + 5, sent, upTo },
  })

  test("ours still in the inbox: wait (and an unconfirmed send counts as sent, its entries told)", () => {
    const looked = Fold.inbox(pending(false), { sessionID: MAIN, undelivered: ["msg_three"], now: T0 + 9 })
    expect(looked.wait).toBe(true)
    expect(looked.state.pending).toMatchObject({ sent: true, checked: T0 + 9 })
    expect(looked.state.entries.map((item) => item.reason)).toEqual(["failed"])
  })

  test("ours gone after it was sent: delivered, the next may go; another update in the inbox: wait", () => {
    expect(Fold.inbox(pending(true), { sessionID: MAIN, undelivered: [], now: T0 + 9 })).toMatchObject({
      wait: false,
      state: { pending: null },
    })
    expect(Fold.inbox(pending(true), { sessionID: MAIN, undelivered: ["msg_other"], now: T0 + 9 }).wait).toBe(true)
    expect(Fold.inbox(base, { sessionID: MAIN, undelivered: ["msg_other"], now: T0 + 9 }).wait).toBe(true)
  })

  test("ours unconfirmed and not in the inbox: sent again with the same id", () => {
    const looked = Fold.inbox(pending(false), { sessionID: MAIN, undelivered: [], now: T0 + 9 })
    expect(looked.wait).toBe(false)
    expect(looked.retry?.msgID).toBe("msg_three")
  })

  test("a replaced main never gets the old update; its entries wait for the new main", () => {
    const looked = Fold.inbox(pending(false), {
      sessionID: "ses_main0000000000000000000002",
      undelivered: [],
      now: T0 + 9,
    })
    expect(looked).toMatchObject({ wait: false, state: { pending: null } })
    expect(looked.retry).toBeUndefined()
    expect(looked.state.entries).toHaveLength(2)
  })

  test("delivered or cancelled clears the pending update; another id changes nothing", () => {
    expect(Fold.delivered(pending(true), "msg_three").pending).toBeNull()
    expect(Fold.delivered(pending(true), "msg_other")).toEqual(pending(true))
    expect(Fold.delivered(pending(false, 1), "msg_three").entries).toEqual([])
  })
})

describe("session log events", () => {
  const durable = (seq: number) => ({
    id: `evt_${seq}`,
    created: T0 + seq,
    durable: { aggregateID: "ses_o", seq, version: 1 },
  })

  test("decodes execution and inbox events, the main request an admission carries, and nothing else", () => {
    expect(
      Fold.observe({
        ...durable(1),
        type: "session.execution.failed",
        data: { sessionID: "ses_o", error: { type: "x", message: "boom" } },
      }),
    ).toMatchObject({ type: "session.execution.failed", data: { error: { message: "boom" } } })
    expect(
      Fold.observe({
        ...durable(2),
        type: "session.execution.interrupted",
        data: { sessionID: "ses_o", reason: "user" },
      }),
    ).toMatchObject({ data: { reason: "user" } })
    const enqueued = Fold.observe({
      ...durable(3),
      type: "session.inbox.enqueued",
      data: {
        sessionID: "ses_o",
        inboxID: "msg_a",
        item: {
          type: "user",
          delivery: "queue",
          payload: {
            text: "<dispatch>",
            metadata: { [OwnTeam.DISPATCH_META]: { id: D1, from: "main", teamID: TEAM_ID, areaID: AREA } },
          },
        },
      },
    })
    expect(enqueued?.type === "session.inbox.enqueued" && Fold.requestOf(enqueued.data.item.payload.metadata)).toBe(D1)
    expect(Fold.requestOf({ source: "own.accounts" })).toBeUndefined()
    // An area message or a program notice is no request (06 §5.8); a program request is one.
    const meta = (extra: Readonly<Record<string, unknown>>) => ({
      [OwnTeam.DISPATCH_META]: { id: D1, teamID: TEAM_ID, areaID: AREA, ...extra },
    })
    const sender = { areaID: AREA, area: "ui" }
    expect(Fold.requestOf(meta({ from: "area", kind: "ask", sender }))).toBeUndefined()
    expect(Fold.requestOf(meta({ from: "area", kind: "reply", sender, replyTo: D1 }))).toBeUndefined()
    expect(Fold.requestOf(meta({ from: "team", kind: "notice" }))).toBeUndefined()
    expect(Fold.requestOf(meta({ from: "team" }))).toBe(D1)
    expect([Fold.request({ from: "main", kind: "task" }), Fold.request({ from: "team", kind: "conflict" })]).toEqual([
      true,
      true,
    ])
    expect([Fold.request({ from: "area", kind: "ask" }), Fold.request({ from: "team", kind: "notice" })]).toEqual([
      false,
      false,
    ])
    expect(Fold.observe({ ...durable(4), type: "session.step.started", data: { sessionID: "ses_o" } })).toBeUndefined()
    expect(Fold.observe({ type: "log.synced", aggregateID: "ses_o", seq: 4 })).toBeUndefined()
  })

  test("statuses own's work sets stay; the same status is no change", () => {
    const busy = { kind: "busy", at: T0, text: "" } as const
    expect(Fold.status({ kind: "preparing", at: T0, text: "" }, busy)).toBeUndefined()
    expect(Fold.status({ kind: "broken", at: T0, text: "" }, busy)).toBeUndefined()
    expect(Fold.status(busy, { ...busy, at: T0 + 5 })).toBeUndefined()
    expect(Fold.status({ kind: "idle", at: T0, text: "" }, busy)).toEqual(busy)
  })
})
