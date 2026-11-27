// Area-to-area talk, the pure part (06 §5.8, 2026-10-16): the loop guards (G1 one reply per ask, G2 one open ask per
// pair of conversations with its 12-hour backstop, G3 the team's asks per hour), the notes held for a conversation,
// the receiver's log settling the asks its run took, and the audit lines told to the main. No service.

import { describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { Talk } from "../../src/dispatch/talk.js"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Dispatches } from "../../src/registry/dispatch.js"
import { Fold } from "../../src/report/fold.js"
import { TEAM_ID } from "../support/context.js"

const NOW = Date.UTC(2026, 9, 16, 3, 0, 0)
const UI = OwnTeam.AreaID.make("ar_ui")
const SAVE = OwnTeam.AreaID.make("ar_save")
const ui: OwnTeam.Sender = { areaID: UI, area: "인벤토리 화면" }
const uiPeer: OwnTeam.Sender = { ...ui, peer: { key: "reviewer", label: "리뷰어" } }
const save: OwnTeam.Sender = { areaID: SAVE, area: "세이브 v3" }

function ask(input: {
  readonly sender?: OwnTeam.Sender
  readonly areaID?: OwnTeam.AreaID
  readonly to?: string
  readonly at?: number
  readonly state?: OwnTeam.Dispatch["state"]
}): OwnTeam.Dispatch {
  return {
    id: OwnTeam.DispatchID.create(),
    teamID: TEAM_ID,
    areaID: input.areaID ?? SAVE,
    seq: 0,
    from: "area",
    kind: "ask",
    text: "count 필드 이름을 바꾸나요?",
    ...(input.to === undefined ? {} : { to: input.to }),
    sender: input.sender ?? ui,
    state: input.state ?? "waiting",
    createdAt: input.at ?? NOW,
  }
}

/** The state after `asks` were recorded (each open). */
function opened(asks: ReadonlyArray<OwnTeam.Dispatch>) {
  return asks.reduce((state, dispatch) => Talk.recorded(state, { dispatch, line: "x" }), Talk.empty())
}

describe("guards (06 §5.8)", () => {
  test("G1: a second reply to an ask is held; a cancelled reply does not count", () => {
    const first = ask({})
    const reply: OwnTeam.Dispatch = {
      ...ask({ sender: save, areaID: UI }),
      kind: "reply",
      replyTo: first.id,
    }
    const message = { kind: "reply", areaID: UI, sender: save, replyTo: first.id } as const
    expect(Talk.guard({ dispatches: [first], state: Talk.empty(), message, now: NOW })).toBeUndefined()
    expect(Talk.guard({ dispatches: [first, reply], state: Talk.empty(), message, now: NOW })).toBe("answered")
    const cancelled = { ...reply, state: "cancelled" as const }
    expect(Talk.guard({ dispatches: [first, cancelled], state: Talk.empty(), message, now: NOW })).toBeUndefined()
  })

  test("G2: one open ask per sender and receiver conversation; 12 hours later or settled it counts no more", () => {
    const first = ask({})
    const state = opened([first])
    const again = { kind: "ask", areaID: SAVE, sender: ui } as const
    expect(Talk.guard({ dispatches: [first], state, message: again, now: NOW + 1 })).toBe("open")
    // Another pair: the receiver's peer, the sender's peer, or the other direction.
    expect(Talk.guard({ dispatches: [first], state, message: { ...again, to: "lead" }, now: NOW })).toBeUndefined()
    expect(Talk.guard({ dispatches: [first], state, message: { ...again, sender: uiPeer }, now: NOW })).toBeUndefined()
    expect(
      Talk.guard({ dispatches: [first], state, message: { kind: "ask", areaID: UI, sender: save }, now: NOW }),
    ).toBeUndefined()
    expect(Talk.guard({ dispatches: [first], state, message: again, now: NOW + Talk.EXPIRE_MS })).toBeUndefined()
    // A reply settles it.
    const reply: OwnTeam.Dispatch = { ...ask({ sender: save, areaID: UI }), kind: "reply", replyTo: first.id }
    const answered = Talk.recorded(state, { dispatch: reply, line: "y" })
    expect(answered.open).toEqual([])
    expect(Talk.guard({ dispatches: [first, reply], state: answered, message: again, now: NOW })).toBeUndefined()
  })

  test("G3: ten asks of one conversation in the rolling hour hold its next one, whatever became of them; another conversation passes; replies never count", () => {
    const asks = Array.from({ length: Talk.ASKS_PER_HOUR }, (_, index) =>
      ask({ areaID: OwnTeam.AreaID.make(`ar_a${index}`), at: NOW + index, state: index % 2 ? "cancelled" : "sent" }),
    )
    const message = { kind: "ask", areaID: SAVE, sender: ui } as const
    expect(Talk.guard({ dispatches: asks, state: Talk.empty(), message, now: NOW + 100 })).toBe("limit")
    expect(Talk.guard({ dispatches: asks.slice(1), state: Talk.empty(), message, now: NOW + 100 })).toBeUndefined()
    expect(Talk.guard({ dispatches: asks, state: Talk.empty(), message, now: NOW + Fold.HOUR_MS + 1 })).toBeUndefined()
    // The same area's peer, and another area, are other conversations (2026-11-14).
    for (const sender of [uiPeer, save])
      expect(
        Talk.guard({ dispatches: asks, state: Talk.empty(), message: { ...message, sender }, now: NOW + 100 }),
      ).toBeUndefined()
    const reply = { kind: "reply", areaID: UI, sender: save, replyTo: asks[0]!.id } as const
    expect(Talk.guard({ dispatches: asks, state: Talk.empty(), message: reply, now: NOW + 100 })).toBeUndefined()
  })

  test("G3: forty asks across the team in the rolling hour hold the next one from any conversation", () => {
    const senders = Array.from(
      { length: 4 },
      (_, index): OwnTeam.Sender => ({ areaID: OwnTeam.AreaID.make(`ar_s${index}`), area: `영역 ${index}` }),
    )
    const asks = Array.from({ length: Talk.ASKS_PER_HOUR_TEAM }, (_, index) =>
      ask({ sender: senders[index % senders.length], at: NOW + index }),
    )
    expect(Talk.ASKS_PER_HOUR_TEAM).toBe(40)
    const fresh = { kind: "ask", areaID: SAVE, sender: ui } as const
    expect(Talk.guard({ dispatches: asks, state: Talk.empty(), message: fresh, now: NOW + 100 })).toBe("team-limit")
    expect(
      Talk.guard({ dispatches: asks.slice(1), state: Talk.empty(), message: fresh, now: NOW + 100 }),
    ).toBeUndefined()
    // One conversation's own limit is named first.
    const busy = { ...fresh, sender: senders[0]! }
    expect(Talk.guard({ dispatches: asks, state: Talk.empty(), message: busy, now: NOW + 100 })).toBe("limit")
  })

  test("a reply taken from a long last answer keeps 20,000 characters and says it was cut", () => {
    expect(Talk.REPLY_MAX).toBe(20_000)
    expect(Talk.cutReply("짧은 답")).toBe("짧은 답")
    const long = "가".repeat(25_000)
    const cut = Talk.cutReply(long)
    expect(cut.startsWith("가".repeat(20_000))).toBe(true)
    expect(cut.slice(20_000)).toBe("\n(이후 생략: 전체 25,000자 중 앞부분입니다. 나머지가 필요하면 다시 물으세요)")
  })
})

describe("notes and lines", () => {
  test("held: the newest five of one conversation, none older than 7 days or for an area that is not active", () => {
    const note = (at: number, to?: string, areaID = SAVE): OwnTeam.AreaNote => ({
      id: OwnTeam.AreaNoteID.create(),
      areaID,
      ...(to === undefined ? {} : { to }),
      sender: ui,
      text: `쪽지 ${at}`,
      at,
    })
    const notes = [
      note(NOW - Dispatches.KEEP_MS),
      ...Array.from({ length: 6 }, (_, index) => note(NOW + index)),
      note(NOW, "lead"),
      note(NOW, undefined, UI),
    ]
    const state = { ...Talk.empty(), notes }
    const active = new Set<string>([SAVE, UI])
    const held = Talk.held(state, { areaID: SAVE, now: NOW + 10, active })
    expect(held.map((item) => item.at)).toEqual([NOW + 1, NOW + 2, NOW + 3, NOW + 4, NOW + 5])
    expect(Talk.held(state, { areaID: SAVE, to: "lead", now: NOW, active })).toHaveLength(1)
    expect(Talk.held(state, { areaID: SAVE, now: NOW, active: new Set([UI]) })).toEqual([])
    const pruned = Talk.prune(state, { now: NOW + 10, active: new Set([SAVE]) })
    expect(pruned.notes.some((item) => item.areaID === UI || item.at === NOW - Dispatches.KEEP_MS)).toBe(false)
    // The note that lapsed undelivered by age is told to the main once (2026-11-14); one of an ended area is not.
    expect(Talk.untold(pruned).map((item) => item.text)).toEqual(["전하지 못한 채 7일이 지난 쪽지 1개를 지웠습니다"])
    expect(Talk.untold(Talk.prune(pruned, { now: NOW + 10, active: new Set([SAVE]) }))).toHaveLength(1)
    expect(
      Talk.prune({ ...Talk.empty(), notes: [note(NOW, undefined, UI)] }, { now: NOW, active: new Set() }).lines,
    ).toEqual([])
  })

  test("audit lines: the newest twenty stay, and an update marks what it carried told", () => {
    const state = Array.from({ length: Talk.LINES_MAX + 3 }, (_, index) => index).reduce(
      (acc, index) => Talk.line(acc, { at: NOW + index, text: `줄 ${index}` }),
      Talk.empty(),
    )
    expect(state.lines).toHaveLength(Talk.LINES_MAX)
    expect(Talk.untold(state)[0]?.text).toBe("줄 3")
    const told = Talk.told(state, Talk.last(state) - 2)
    expect(Talk.untold(told).map((item) => item.text)).toEqual([`줄 ${Talk.LINES_MAX + 1}`, `줄 ${Talk.LINES_MAX + 2}`])
    expect(Talk.untold(state, 5).map((item) => item.n)).toEqual([3, 4, 5])
    expect(Talk.told(told, 0)).toBe(told)
  })

  test("an audit line names the sender, the receiver and the message on one line", () => {
    expect(Talk.auditLine({ sender: uiPeer, to: "세이브 v3 담당", what: "물음", text: "필드\n이름?" })).toBe(
      `'인벤토리 화면 동료 리뷰어' → '세이브 v3 담당' 물음: "필드 이름?"`,
    )
  })
})

describe("the receiver's log (06 §5.8)", () => {
  const SESSION = "ses_save000000000000000000001"
  const at = (type: string, data: Readonly<Record<string, unknown>>, seq: number) =>
    Fold.observe({ created: seq, durable: { seq }, type, data: { sessionID: SESSION, ...data } })!

  test("an ask delivered in a conversation is settled by that conversation's next run end, in log order", () => {
    const first = ask({})
    const state = opened([first])
    const inboxID = MsgID.dispatch(first.id, SESSION)
    // The run ended before the delivery (an earlier run): nothing settles.
    const early = Talk.follow(state, {
      sessionID: SESSION,
      events: [at("session.execution.succeeded", {}, 1), at("session.inbox.delivered", { inboxID }, 2)],
      blocked: false,
    })
    expect(early.ended).toEqual([])
    expect(early.state.open[0]?.delivered).toBe(SESSION)
    // A run that fails at once after the delivery settles it (no clock involved).
    const failed = Talk.follow(early.state, {
      sessionID: SESSION,
      events: [at("session.execution.failed", { error: { message: "400" } }, 3)],
      blocked: false,
    })
    expect(failed.ended).toEqual([{ id: first.id, how: "failed" }])
    expect(failed.state.open).toEqual([])
    // A limit block goes on after the reset: it settles nothing.
    const blocked = Talk.follow(early.state, {
      sessionID: SESSION,
      events: [at("session.execution.failed", { error: { message: "limit" } }, 3)],
      blocked: true,
    })
    expect(blocked.ended).toEqual([])
    // Another conversation's delivery or run end changes nothing.
    const other = Talk.follow(state, {
      sessionID: "ses_other00000000000000000001",
      events: [at("session.inbox.delivered", { inboxID }, 1), at("session.execution.succeeded", {}, 2)],
      blocked: false,
    })
    expect(other.state).toBe(state)
    expect(other.ended).toEqual([])
  })

  test("asking: a conversation with an ask out waits for its answer until it settles or 12 hours pass", () => {
    const state = opened([ask({ sender: uiPeer })])
    expect(Talk.asking(state, { areaID: UI, peer: "reviewer" }, NOW)).toBe(true)
    expect(Talk.asking(state, { areaID: UI }, NOW)).toBe(false)
    expect(Talk.asking(state, { areaID: UI, peer: "reviewer" }, NOW + Talk.EXPIRE_MS)).toBe(false)
  })
})
