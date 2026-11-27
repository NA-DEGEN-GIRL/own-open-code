// Queue/steer panel model (03 §18.9, 02 §5.3): delivery order, WAIT_SAFE notes, hidden synthetic items, held rows,
// and the reorder plan (re-admit the changed suffix, blocked by queued control items or a changed inbox). Team
// messages (06 §5.2, §9.6): who sent a row, the envelope taken off a main request (shown and given back by `편집`,
// TG7), and the counts of a team update's one-line summary.
import { afterEach, describe, expect, test } from "bun:test"
import type { SessionInboxInfo } from "@opencode/client"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { createRoot } from "solid-js"
import { onComposerRestore, type ComposerRestoreDetail } from "@/attachments/intents"
import type { ServerRuntime } from "@/data"
import { createQueue } from "./controller"
import {
  dropIndex,
  firstLine,
  messageSender,
  messageSource,
  moveBy,
  queueRows,
  reorderPlan,
  teamUpdateCounts,
  teamUpdateOf,
} from "./model"

let seq = 0
const user = (id: string, delivery: "steer" | "queue", text = id, extra: Record<string, unknown> = {}) =>
  ({
    id,
    sessionID: "ses_1",
    time: { created: ++seq },
    type: "user",
    delivery,
    payload: { text, ...extra },
  }) as SessionInboxInfo
const control = (id: string, type: "compaction" | "move", delivery: "steer" | "queue") =>
  ({ id, sessionID: "ses_1", time: { created: ++seq }, type, delivery, payload: {} }) as unknown as SessionInboxInfo
const synthetic = (id: string) =>
  ({
    id,
    sessionID: "ses_1",
    time: { created: ++seq },
    type: "synthetic",
    delivery: "steer",
    payload: { text: "x" },
  }) as SessionInboxInfo

describe("queueRows", () => {
  test("steers first (compaction first among them), then queued items, then held messages; synthetic hidden", () => {
    const rows = queueRows({
      pending: [
        user("m1", "queue"),
        user("m2", "steer"),
        control("c1", "compaction", "steer"),
        synthetic("s1"),
        user("m3", "queue"),
      ],
      held: ["보류 1"],
      busy: true,
      current: "Alpha",
    })
    expect(rows.map((row) => (row.kind === "held" ? `held:${row.index}` : row.id))).toEqual([
      "c1",
      "m2",
      "m1",
      "m3",
      "held:0",
    ])
  })

  test("notes without a pending switch: steer into this turn, queue after the turn, parked when idle", () => {
    const pending = [user("m1", "steer"), user("m2", "queue")]
    const busy = queueRows({ pending, held: [], busy: true, current: "Alpha" })
    expect(busy.map((row) => row.kind === "user" && row.note)).toEqual([{ kind: "steerTurn" }, { kind: "afterTurn" }])
    const idle = queueRows({ pending, held: [], busy: false, current: "Alpha" })
    expect(idle[1]).toMatchObject({ note: { kind: "parked" } })
  })

  test("WAIT_SAFE: steers run on the current account, queued rows after the switch (03 §18.9)", () => {
    const rows = queueRows({
      pending: [user("m1", "steer"), user("m2", "queue")],
      held: [],
      busy: true,
      current: "Alpha",
      pendingTarget: "개인 Pro",
    })
    expect(rows.map((row) => row.kind === "user" && row.note)).toEqual([
      { kind: "steerNow", account: "Alpha" },
      { kind: "afterSwitch", account: "개인 Pro" },
    ])
  })

  test("display text and attachment count come from the payload metadata", () => {
    const [row] = queueRows({
      pending: [
        user("m1", "queue", "raw\nAttached file: `/p/a`", {
          metadata: { displayText: "typed", attachments: [{ name: "a", mime: "text/plain", path: "/p/a" }] },
          files: [{ data: "AA==", mime: "image/png", source: { type: "inline" } }],
        }),
      ],
      held: [],
      busy: true,
      current: "Alpha",
    })
    expect(row).toMatchObject({ kind: "user", text: "typed", attachments: 2 })
  })
})

describe("reorderPlan", () => {
  const pending = [user("q1", "queue"), user("q2", "queue"), user("q3", "queue"), user("s1", "steer")]
  test("only the changed suffix is re-admitted and cancelled", () => {
    const plan = reorderPlan(pending, ["q1", "q3", "q2"])
    expect(plan.kind).toBe("rewrite")
    if (plan.kind !== "rewrite") return
    expect(plan.readmit.map((item) => item.id)).toEqual(["q3", "q2"])
    expect(plan.cancel).toEqual(["q2", "q3"])
  })
  test("the same order is a no-op", () => {
    expect(reorderPlan(pending, ["q1", "q2", "q3"])).toEqual({ kind: "none" })
  })
  test("a queued control item blocks reordering; a changed inbox is refused", () => {
    expect(reorderPlan([...pending, control("c", "compaction", "queue")], ["q2", "q1", "q3"])).toEqual({
      kind: "blocked",
      reason: "control",
    })
    expect(reorderPlan(pending, ["q2", "q1"])).toEqual({ kind: "blocked", reason: "changed" })
    expect(reorderPlan(pending, ["q2", "q2", "q1", "q3"])).toEqual({ kind: "blocked", reason: "changed" })
  })
})

test("moveBy and dropIndex", () => {
  expect(moveBy(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"])
  expect(moveBy(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"])
  const centers = [15, 45, 75, 105]
  expect(dropIndex(centers, 0, 50)).toBe(1)
  expect(dropIndex(centers, 0, 110)).toBe(3)
  expect(dropIndex(centers, 3, 40)).toBe(1)
  expect(dropIndex(centers, 2, 70)).toBe(2)
})

test("firstLine", () => {
  expect(firstLine("첫 줄\n둘째 줄")).toBe("첫 줄")
  expect(firstLine("x".repeat(130))).toHaveLength(121)
})

// Main requests as own-team writes them (packages/own-team/src/dispatch/envelope.ts, its envelope.test.ts strings).
const DISPATCH = "dp_01JAX0000000000000000000AB"
const BODY = "인벤토리 정렬이 아이템 희귀도를 무시합니다. ItemSorter를 고치고 테스트를 더하세요."
const ENVELOPE = `<dispatch from="main" id="${DISPATCH}" area="인벤토리 화면" task="정렬 버그">\n${BODY}\n</dispatch>`
const dispatchMeta = (from: "main" | "team") => ({
  "own.dispatch": { id: DISPATCH, from, teamID: "tm_0123456789ab", areaID: "ar_inventory-ui", task: "정렬 버그" },
  source: "own.team",
})

describe("team messages", () => {
  test("messageSource: own.dispatch names the main or the team; anything else is the user's", () => {
    expect(messageSource(dispatchMeta("main"))).toBe("main")
    expect(messageSource(dispatchMeta("team"))).toBe("team")
    expect(messageSource(undefined)).toBe("user")
    expect(messageSource({ displayText: "typed" })).toBe("user")
    expect(messageSource({ source: "own.team" })).toBe("user")
    expect(messageSource({ "own.dispatch": "dp_x" })).toBe("user")
  })

  test("OwnTeamText.unwrap: the body only, with escaped closing tags given back; other text unchanged", () => {
    expect(OwnTeamText.unwrap(ENVELOPE)).toBe(BODY)
    const escaped = `<dispatch from="team" id="${DISPATCH}" area="ui">\na <\\/dispatch> b <\\/DISPATCH > c\n</dispatch>`
    expect(OwnTeamText.unwrap(escaped)).toBe("a </dispatch> b </DISPATCH > c")
    const attributes = `<dispatch from="main" id="${DISPATCH}" area="ui&quot; onload=&quot;x" task="a &lt;c&gt;">\n줄 1\n\n줄 3\n</dispatch>`
    expect(OwnTeamText.unwrap(attributes)).toBe("줄 1\n\n줄 3")
    expect(OwnTeamText.unwrap("그냥 사용자 글")).toBe("그냥 사용자 글")
    expect(OwnTeamText.unwrap(`${ENVELOPE}\n덧붙임`)).toBe(`${ENVELOPE}\n덧붙임`)
    // What own-team wraps comes back unchanged, whatever the body and the attributes hold.
    const body = "a </dispatch> b\n</DISPATCH>\n끝"
    expect(
      OwnTeamText.unwrap(OwnTeamText.wrap({ from: "main", id: DISPATCH, area: 'ui" x', task: "a<b>", text: body })),
    ).toBe(body)
  })

  test("queue rows: a main request carries its source and shows the body; the user's rows stay as typed", () => {
    const rows = queueRows({
      pending: [
        user("d1", "queue", ENVELOPE, { metadata: dispatchMeta("main") }),
        user("d2", "queue", ENVELOPE, { metadata: dispatchMeta("team") }),
        user("u1", "queue", "raw", { metadata: { displayText: "typed" } }),
      ],
      held: [],
      busy: true,
      current: "Alpha",
    })
    expect(rows.map((row) => row.kind === "user" && [row.source, row.text])).toEqual([
      ["main", BODY],
      ["team", BODY],
      ["user", "typed"],
    ])
  })

  test("area messages (06 §5.8): their source is the area, the sender names it, and the rows drop the notes", () => {
    const meta = (kind: "ask" | "reply", peer?: { key: string; label: string }) => ({
      "own.dispatch": {
        id: DISPATCH,
        from: "area",
        teamID: "tm_0123456789ab",
        areaID: "ar_inventory-ui",
        kind,
        sender: { areaID: "ar_save", area: "세이브 v3", ...(peer ? { peer } : {}) },
      },
      source: "own.team",
    })
    expect(messageSource(meta("ask"))).toBe("area")
    expect(messageSender(meta("ask"))).toEqual({ area: "세이브 v3", reply: false })
    expect(messageSender(meta("reply", { key: "reviewer", label: "리뷰어" }))).toEqual({
      area: "세이브 v3",
      label: "리뷰어",
      reply: true,
    })
    expect(messageSender(dispatchMeta("main"))).toBeUndefined()
    const wrapped = OwnTeamText.wrap({
      from: "area",
      sender: "세이브 v3",
      kind: "ask",
      id: DISPATCH,
      area: "인벤토리 화면",
      text: BODY,
      notes: [{ from: "결제", at: "14:05", text: "내일 바뀝니다" }],
    })
    const rows = queueRows({
      pending: [user("a1", "queue", wrapped, { metadata: meta("ask") })],
      held: [],
      busy: true,
      current: "Alpha",
    })
    expect(rows).toMatchObject([{ kind: "user", source: "area", sender: { area: "세이브 v3" }, text: BODY }])
    expect(OwnTeamText.notes(wrapped)).toEqual(["결제(14:05): 내일 바뀝니다"])
  })

  test("teamUpdateOf reads the wake reasons; other synthetic messages are not team updates", () => {
    expect(
      teamUpdateOf({ "own.team.update": { seq: 42, reasons: ["ready", 7, "blocked"] }, source: "own.team" }),
    ).toEqual({ reasons: ["ready", "blocked"] })
    expect(teamUpdateOf({ "own.team.update": { seq: 1 } })).toEqual({ reasons: [] })
    expect(teamUpdateOf({ source: "subagent" })).toBeUndefined()
    expect(teamUpdateOf(undefined)).toBeUndefined()
  })

  test("teamUpdateCounts: areas by the status word that starts their line (06 §5.6 format)", () => {
    const text = [
      '<team-update seq="42" reason="ready">',
      "영역 4개 · 맡긴 일 4개 중 3개 끝남",
      '- 인벤토리 화면: 반영 준비됨 · 담당: "정렬 수정과 테스트 3개" (main보다 커밋 4개 앞섬)',
      '- 세이브 v3: 쉬는 중 · 사용자가 직접 대화함(14:05) · 담당 요약: "필드: 실패 없음" · 메인 멈춤 · 요청 1개 기다림',
      "- 문서: 작업 중(12분째) · 계정 개인 Pro 5시간 창 91%",
      "- 로그인: 한도 대기 · 14:20에 풀림",
      '할 일: 인벤토리 화면 반영 가능 → team_integrate("inventory-ui")',
      "</team-update>",
    ].join("\n")
    expect(teamUpdateCounts(text, ["ready"])).toEqual([
      { kind: "ready", n: 1 },
      { kind: "waiting", n: 1 },
      { kind: "busy", n: 1 },
    ])
    // Idle areas count as done only when the update says everything is done.
    expect(teamUpdateCounts("- a: 쉬는 중\n- b: 쉬는 중 · 메인 멈춤", ["all-done"])).toEqual([{ kind: "done", n: 2 }])
    // An own-team before the 2026-10-16 glossary words idle as 대기 중 (an SSH host may run one); it still counts.
    expect(teamUpdateCounts("- a: 대기 중\n- b: 쉬는 중", ["all-done"])).toEqual([{ kind: "done", n: 2 }])
    expect(teamUpdateCounts('- a: 막힘 · 담당: "?"\n- b: 실패\n- c: 준비 중', [])).toEqual([
      { kind: "blocked", n: 1 },
      { kind: "failed", n: 1 },
      { kind: "busy", n: 1 },
    ])
    expect(teamUpdateCounts("영역 0개", [])).toEqual([])
    // The words own-team writes (`@own/protocol/rpc-team-text`) are the words counted here.
    const written = [
      `- a: ${OwnTeamText.busyFor(3)} · 계정 개인 Pro`,
      `- b: ${OwnTeamText.quotaUntil("09:30")}`,
      `- c: ${OwnTeamText.WORDS.ready}`,
      `- d: ${OwnTeamText.WORDS.asking}`,
    ].join("\n")
    expect(teamUpdateCounts(written, [])).toEqual([
      { kind: "ready", n: 1 },
      { kind: "waiting", n: 2 },
      { kind: "busy", n: 1 },
    ])
  })

  test("teamUpdateCounts: integration and decision record lines follow the area groups (06 §5.6, §9.6)", () => {
    const text = [
      `- a: ${OwnTeamText.WORDS.ready}`,
      OwnTeamText.integrationLine({ area: "b", state: "done", detail: "그 뒤 저장 지점 2개는 넣지 않음" }),
      OwnTeamText.integrationLine({ area: "c", state: "running" }),
      OwnTeamText.integrationLine({ area: "d", state: "undone" }),
      OwnTeamText.decisionLine({ number: 4, title: "필드 이름은 snake_case", source: "user" }),
    ].join("\n")
    expect(teamUpdateCounts(text, [])).toEqual([
      { kind: "ready", n: 1 },
      { kind: "busy", n: 1 },
      { kind: "integrated", n: 1 },
      { kind: "undone", n: 1 },
      { kind: "decided", n: 1 },
    ])
  })
})

describe("편집 of a main request (06 §5.2, TG7)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

  function harness(pending: SessionInboxInfo[]) {
    const cancelled: string[] = []
    const restored: ComposerRestoreDetail[] = []
    cleanups.push(onComposerRestore((detail) => restored.push(detail)))
    // A fixture runtime: an unpinned idle session with this inbox, and the inbox cancel `편집` calls.
    const runtime = {
      own: { state: { binding: {}, switchState: {} } },
      data: {
        session: {
          get: () => undefined,
          status: () => "idle",
          pending: { list: () => pending, invalidate: () => {}, sync: async () => {} },
        },
      },
      client: () => ({
        session: {
          inbox: {
            cancel: async (input: { inboxID: string }) => {
              cancelled.push(input.inboxID)
            },
          },
        },
      }),
    } as unknown as ServerRuntime
    const queue = createRoot((dispose) => {
      cleanups.push(dispose)
      return createQueue({
        runtime: () => runtime,
        serverKey: () => "local",
        sessionID: () => "ses_1",
        held: () => [],
      })
    })
    return { queue, cancelled, restored }
  }

  test("the composer gets the body without the envelope, and the queued request is removed", async () => {
    const { queue, cancelled, restored } = harness([user("d1", "queue", ENVELOPE, { metadata: dispatchMeta("main") })])
    expect(await queue.edit("d1")).toBe(true)
    expect(cancelled).toEqual(["d1"])
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ serverKey: "local", sessionID: "ses_1", text: BODY, mode: "fill" })
    expect(restored[0]!.text).not.toContain("<dispatch")
  })

  test("a team request too; the user's own message goes back as typed", async () => {
    const { queue, restored } = harness([
      user("d2", "queue", ENVELOPE, { metadata: dispatchMeta("team") }),
      user("u1", "queue", "raw", { metadata: { displayText: "typed" } }),
    ])
    await queue.edit("d2")
    await queue.edit("u1")
    expect(restored.map((detail) => detail.text)).toEqual([BODY, "typed"])
  })
})
