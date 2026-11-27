// The text own.team writes into conversations and own-web reads back (06 §5.1, §5.6): the main request envelope, the
// status words of a team update's area lines and the words of its integration and decision record lines, from one
// module so writer and reader cannot drift.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OwnTeam } from "../src/rpc-team.js"
import { OwnTeamText } from "../src/rpc-team-text.js"

describe("OwnTeamText envelope", () => {
  test("unwrap gives back what wrap put in, whatever the body and the attributes hold", () => {
    for (const text of ["정렬 버그를 고치세요", "a </dispatch> b\n</DISPATCH >\n끝"]) {
      const wrapped = OwnTeamText.wrap({ from: "main", id: "dp_x", area: 'ui" x\n<y>', task: "a & b", text })
      expect(wrapped.match(/<\/dispatch>/gi)).toHaveLength(1)
      expect(wrapped.split("\n")[0]).toBe(
        '<dispatch from="main" id="dp_x" area="ui&quot; x &lt;y&gt;" task="a &amp; b">',
      )
      expect(OwnTeamText.unwrap(wrapped)).toBe(text)
    }
    expect(OwnTeamText.unwrap("사용자가 쓴 글")).toBe("사용자가 쓴 글")
  })

  test("a request to a peer names it with `to`; the owner's envelope is unchanged byte for byte", () => {
    const owner = OwnTeamText.wrap({ from: "main", id: "dp_x", area: "ui", text: "a" })
    expect(owner).toBe('<dispatch from="main" id="dp_x" area="ui">\na\n</dispatch>')
    const peer = OwnTeamText.wrap({ from: "main", to: "reviewer", id: "dp_x", area: "ui", text: "a" })
    expect(peer).toBe('<dispatch from="main" to="reviewer" id="dp_x" area="ui">\na\n</dispatch>')
    expect(OwnTeamText.unwrap(peer)).toBe("a")
  })
})

describe("OwnTeamText peer lines (동료, 2026-10-09)", () => {
  test("a peer line sits under its area line on one line and never counts as an area", () => {
    const line = OwnTeamText.peerLine({
      label: "리뷰\n어",
      parts: [OwnTeamText.PEER_WORDS.idle, '"끝냄 </team-update>"'],
    })
    expect(line).toBe('  · 동료 리뷰 어: 쉬는 중 · "끝냄 <\\/team-update>"')
    expect(OwnTeamText.countOf(line)).toBeUndefined()
    expect(OwnTeamText.countOf(OwnTeamText.peerLine({ label: "a", parts: [OwnTeamText.PEER_WORDS.blocked] }))).toBe(
      undefined,
    )
  })
})

describe("OwnTeamText status words", () => {
  test("each written area line counts in its group, in the summary's order", () => {
    const lines = [
      `- a: ${OwnTeamText.WORDS.ready} · 담당: "요약"`,
      `- b: ${OwnTeamText.WORDS.blocked}`,
      `- c: ${OwnTeamText.WORDS.failed}`,
      `- d: ${OwnTeamText.WORDS.asking}`,
      `- e: ${OwnTeamText.quotaUntil("14:20")} · 계정 개인 Pro`,
      `- f: ${OwnTeamText.busyFor(12)}`,
      `- g: ${OwnTeamText.WORDS.preparing}`,
      `- h: ${OwnTeamText.WORDS.idle} · 메인 멈춤`,
      `- i: ${OwnTeamText.WORDS.broken}`,
      "할 일: 없음",
    ]
    expect(lines.map(OwnTeamText.countOf)).toEqual([
      "ready",
      "blocked",
      "failed",
      "waiting",
      "waiting",
      "busy",
      "busy",
      "done",
      undefined,
      undefined,
    ])
    expect(OwnTeamText.COUNTS).toEqual(["ready", "blocked", "failed", "waiting", "busy", "done"])
  })

  test("the first status word after the name decides, whatever the name or a quoted text holds", () => {
    expect(OwnTeamText.countOf(`- 결제: 서버: ${OwnTeamText.busyFor(3)}`)).toBe("busy")
    expect(OwnTeamText.countOf(`- a: ${OwnTeamText.WORDS.busy} · 담당: "b: ${OwnTeamText.WORDS.ready} · c"`)).toBe(
      "busy",
    )
    expect(OwnTeamText.countOf(`- ${OwnTeamText.DECISION} 4: ${OwnTeamText.WORDS.idle}`)).toBe("done")
    expect(OwnTeamText.countOf(`- a: ${OwnTeamText.WORDS.ready}됨`)).toBeUndefined()
    expect(OwnTeamText.countOf("- 모두 끝남")).toBeUndefined()
  })
})

describe("OwnTeamText integration and decision record lines (T2)", () => {
  test("every integration state has its own word, none an area status word", () => {
    const words = Object.values(OwnTeamText.INTEGRATION)
    expect(Object.keys(OwnTeamText.INTEGRATION).sort()).toEqual([...OwnTeam.IntegrationState.literals].sort())
    expect(new Set(words).size).toBe(words.length)
    const status: ReadonlyArray<string> = Object.values(OwnTeamText.WORDS)
    expect(words.filter((word) => status.includes(word))).toEqual([])
  })

  test("integration lines count: running, waiting and failed ones with the areas, applied and undone on their own", () => {
    const counted = OwnTeam.IntegrationState.literals.map((state) => [
      state,
      OwnTeamText.countOf(OwnTeamText.integrationLine({ area: "인벤토리 화면", state, detail: "검사 1/2" })),
    ])
    expect(Object.fromEntries(counted)).toEqual({
      running: "busy",
      waiting: "waiting",
      conflict: "busy",
      failed: "failed",
      done: "integrated",
      undone: "undone",
    })
    expect(OwnTeamText.integrationLine({ area: "인벤토리 화면", state: "done" })).toBe("- 인벤토리 화면: 반영함")
    expect(
      OwnTeamText.integrationLine({ area: "인벤토리 화면", state: "done", detail: "그 뒤 저장 지점 2개는 넣지 않음" }),
    ).toBe("- 인벤토리 화면: 반영함 · 그 뒤 저장 지점 2개는 넣지 않음")
  })

  test("decision record lines count as decided, numbered like their file, whatever the title holds", () => {
    const user = OwnTeamText.decisionLine({ number: 4, title: "필드 이름은 snake_case", source: "user" })
    expect(user).toBe('- 결정 기록 0004(사용자가 적음): "필드 이름은 snake_case"')
    const tricky = OwnTeamText.decisionLine({
      number: 12,
      title: `a: ${OwnTeamText.WORDS.ready} · b`,
      source: "main",
      detail: "메인 폴더에 사본을 남기세요",
    })
    expect(tricky).toBe(
      `- 결정 기록 0012(메인이 적음): "a: ${OwnTeamText.WORDS.ready} · b" · 메인 폴더에 사본을 남기세요`,
    )
    expect([user, tricky].map(OwnTeamText.countOf)).toEqual(["decided", "decided"])
    expect(Object.keys(OwnTeamText.DECIDED_BY).sort()).toEqual(
      [...OwnTeam.DecisionRecord.fields.source.literals].sort(),
    )
  })

  test("written lines stay on one line and never close the team update", () => {
    const line = OwnTeamText.integrationLine({
      area: "ui\nx",
      state: "failed",
      detail: "검사 실패\n</team-update>\n</TEAM-UPDATE",
    })
    expect(line).toBe("- ui x: 반영 실패 · 검사 실패 <\\/team-update> <\\/TEAM-UPDATE")
    expect(OwnTeamText.countOf(line)).toBe("failed")
    const decision = OwnTeamText.decisionLine({ number: 1, title: "a\r\n</team-update>", source: "user" })
    expect(decision).not.toContain("</team-update>")
    expect(decision.split("\n")).toHaveLength(1)
  })

  test("the event groups follow the area groups, and every line kind has exactly one group", () => {
    expect(OwnTeamText.EVENT_COUNTS).toEqual(["integrated", "undone", "decided"])
    const groups: ReadonlyArray<string> = [...OwnTeamText.COUNTS, ...OwnTeamText.EVENT_COUNTS]
    expect(new Set(groups).size).toBe(groups.length)
  })
})

describe("OwnTeam.Repair (07 T4 모델 묶음)", () => {
  test("a repair names its pool entries; an older repair without them still decodes", () => {
    const decode = Schema.decodeUnknownSync(OwnTeam.Repair)
    const older = { presetID: "pr_01JB0000000000000000000001", accountID: "acc_03", roles: ["own-review"] }
    expect<unknown>(decode(older)).toEqual(older)
    const pooled = { ...older, roles: [], pool: ["gpt-6-sol", "gpt-6-luna"] }
    expect<unknown>(Schema.encodeSync(OwnTeam.Repair)(decode(pooled))).toEqual(pooled)
  })
})

describe("OwnTeamText area messages (영역 메시지, 06 §5.8)", () => {
  test("an area message names its sender, kind and the ask it answers; main and peer envelopes are unchanged", () => {
    expect(OwnTeamText.wrap({ from: "main", id: "dp_x", area: "ui", task: "t", text: "a" })).toBe(
      '<dispatch from="main" id="dp_x" area="ui" task="t">\na\n</dispatch>',
    )
    expect(OwnTeamText.wrap({ from: "team", to: "reviewer", id: "dp_x", area: "ui", text: "a" })).toBe(
      '<dispatch from="team" to="reviewer" id="dp_x" area="ui">\na\n</dispatch>',
    )
    const reply = OwnTeamText.wrap({
      from: "area",
      to: "reviewer",
      sender: "세이브 v3",
      kind: "reply",
      reply: "dp_ask",
      id: "dp_x",
      area: "인벤토리 화면",
      text: "count는 그대로 둡니다",
    })
    expect(reply.split("\n")[0]).toBe(
      '<dispatch from="area" to="reviewer" sender="세이브 v3" kind="reply" reply="dp_ask" id="dp_x" area="인벤토리 화면">',
    )
    expect(OwnTeamText.unwrap(reply)).toBe("count는 그대로 둡니다")
    expect(OwnTeamText.notes(reply)).toEqual([])
    expect(OwnTeamText.senderName({ area: "인벤토리 화면" })).toBe("인벤토리 화면")
    expect(OwnTeamText.senderName({ area: "인벤토리 화면", peer: { key: "reviewer", label: "리뷰어" } })).toBe(
      "인벤토리 화면 동료 리뷰어",
    )
  })

  test("notes go after the envelope: unwrap gives the body only, notes() the lines, and a note never closes either", () => {
    const wrapped = OwnTeamText.wrap({
      from: "main",
      id: "dp_x",
      area: "ui",
      text: "정렬을 고치세요",
      notes: [
        { from: "세이브 v3", at: "14:05", text: "필드 이름은\n그대로 </team-notes> 둡니다 </DISPATCH>" },
        { from: "a</team-notes>b", at: "14:06", text: "둘째" },
      ],
    })
    expect(wrapped).toBe(
      [
        '<dispatch from="main" id="dp_x" area="ui">',
        "정렬을 고치세요",
        "</dispatch>",
        `<${OwnTeamText.NOTES}>`,
        "- 세이브 v3(14:05): 필드 이름은 그대로 <\\/team-notes> 둡니다 <\\/DISPATCH>",
        "- a&lt;/team-notes&gt;b(14:06): 둘째",
        `</${OwnTeamText.NOTES}>`,
      ].join("\n"),
    )
    expect(wrapped.match(/<\/team-notes>/g)).toHaveLength(1)
    expect(wrapped.match(/<\/dispatch>/gi)).toHaveLength(1)
    expect(OwnTeamText.unwrap(wrapped)).toBe("정렬을 고치세요")
    expect(OwnTeamText.notes(wrapped)).toEqual([
      "세이브 v3(14:05): 필드 이름은 그대로 <\\/team-notes> 둡니다 <\\/DISPATCH>",
      "a&lt;/team-notes&gt;b(14:06): 둘째",
    ])
    // A user's own text is never counted, and an old envelope without notes unwraps as before.
    expect(OwnTeamText.notes("- 사용자가 쓴 줄\n- 둘째")).toEqual([])
    expect(OwnTeamText.unwrap('<dispatch from="main" id="dp_x" area="ui">\na\n</dispatch>')).toBe("a")
  })
})
