// The main request envelope and the hashed message ids (06 §5.1 step 4, §11.2 "봉투와 msgID").

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { OwnTeam } from "@own/protocol"
import { Envelope } from "../../src/dispatch/envelope.js"
import { MsgID } from "../../src/dispatch/msg-id.js"

const ID = OwnTeam.DispatchID.make("dp_01JAX0000000000000000000AB")

describe("Envelope.wrap", () => {
  test("names the sender, the request, the area and the task around the text", () => {
    const text = "인벤토리 정렬이 아이템 희귀도를 무시합니다. ItemSorter를 고치고 테스트를 더하세요."
    expect(Envelope.wrap({ dispatch: { id: ID, from: "main", task: "정렬 버그", text }, area: "인벤토리 화면" })).toBe(
      `<dispatch from="main" id="${ID}" area="인벤토리 화면" task="정렬 버그">\n${text}\n</dispatch>`,
    )
  })

  test("a program request says from=team, and no task attribute without a task", () => {
    expect(Envelope.wrap({ dispatch: { id: ID, from: "team", text: "겹친 변경을 정리하세요" }, area: "ui" })).toBe(
      `<dispatch from="team" id="${ID}" area="ui">\n겹친 변경을 정리하세요\n</dispatch>`,
    )
  })

  test("the body cannot close the envelope: every </dispatch becomes <\\/dispatch, in any case", () => {
    const wrapped = Envelope.wrap({
      dispatch: { id: ID, from: "main", text: "a </dispatch> b </DISPATCH > c" },
      area: "ui",
    })
    expect(wrapped).toContain("a <\\/dispatch> b <\\/DISPATCH > c")
    expect(wrapped.match(/<\/dispatch/gi)).toHaveLength(1)
    expect(wrapped.endsWith("\n</dispatch>")).toBe(true)
  })

  test("attribute values are escaped and kept on one line", () => {
    const wrapped = Envelope.wrap({
      dispatch: { id: ID, from: "main", task: 'a "b"\n<c> & d', text: "x" },
      area: 'ui" onload="x',
    })
    expect(wrapped.split("\n")[0]).toBe(
      `<dispatch from="main" id="${ID}" area="ui&quot; onload=&quot;x" task="a &quot;b&quot; &lt;c&gt; &amp; d">`,
    )
  })
})

describe("notes with the request", () => {
  test("a team note (담당 대화 바꾸기) names the team as its sender, an area's note the area", () => {
    const areaID = OwnTeam.AreaID.make("ar_ui")
    const at = new Date(2026, 9, 25, 14, 5).getTime()
    const wrapped = Envelope.wrap({
      dispatch: { id: ID, from: "main", text: "정렬을 고치세요" },
      area: "ui",
      notes: [
        {
          id: OwnTeam.AreaNoteID.make("an_01JAX0000000000000000000AB"),
          areaID,
          // A team note carries the receiving area as its sender; readers show the team.
          sender: { areaID, area: "ui" },
          from: "team",
          text: "이 대화가 'ui' 영역의 담당을 다른 대화에서 넘겨받았다.",
          at,
        },
        {
          id: OwnTeam.AreaNoteID.make("an_01JAX0000000000000000000AC"),
          areaID,
          sender: { areaID: OwnTeam.AreaID.make("ar_pay"), area: "결제 화면" },
          text: "가격 표시는 내일 바뀝니다",
          at,
        },
      ],
    })
    expect(wrapped.split("\n").slice(3)).toEqual([
      "<team-notes>",
      "- 팀(2026-10-25 14:05): 이 대화가 'ui' 영역의 담당을 다른 대화에서 넘겨받았다.",
      "- 결제 화면(2026-10-25 14:05): 가격 표시는 내일 바뀝니다",
      "</team-notes>",
    ])
  })
})

describe("MsgID", () => {
  test('"msg_" + 26 base32 characters, the same for the same parts', () => {
    const id = MsgID.dispatch(ID, "ses_owner000000000000000000001")
    expect(id).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/)
    expect(MsgID.dispatch(ID, "ses_owner000000000000000000001")).toBe(id)
  })

  test("differs for another owner conversation or another request", () => {
    const id = MsgID.dispatch(ID, "ses_owner000000000000000000001")
    expect(MsgID.dispatch(ID, "ses_owner000000000000000000002")).not.toBe(id)
    expect(
      MsgID.dispatch(OwnTeam.DispatchID.make("dp_01JAX0000000000000000000AC"), "ses_owner000000000000000000001"),
    ).not.toBe(id)
  })

  test("is the base32 SHA-256 of the parts joined by NUL", () => {
    const digest = createHash("sha256").update(`tm_0123456789ab\0wake\x003`).digest()
    expect(String(MsgID.of("tm_0123456789ab", "wake", 3))).toBe(`msg_${MsgID.base32(digest).slice(0, 26)}`)
  })

  test("base32 reads 5 bits per character", () => {
    expect(MsgID.base32(new Uint8Array([0, 0, 0, 0, 0]))).toBe("00000000")
    expect(MsgID.base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe("zzzzzzzz")
    // 0b00001_00010_00011_00100_00101_00110_00111_01000
    expect(MsgID.base32(new Uint8Array([0x08, 0x86, 0x42, 0x98, 0xe8]))).toBe("12345678")
  })
})
