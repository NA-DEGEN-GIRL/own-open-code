// The role texts of team sessions (2026-11-14, `sessions/instructions.ts`): the program's part, the guard and the
// 일하는 방식 block (the default or the user's from 팀 지시문), the parts that follow `directHold` and `directTell`,
// what 팀 지시문 shows (`view`), the stored blocks, and the size pins of fixed fixtures (design 3.4; the message
// test's fixture path depends on `os.tmpdir()`, so its own pin is looser). The KV is an in-memory store; the logger
// writes to a list.

import { describe, expect, test } from "bun:test"
import type { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Log } from "../../src/log.js"
import { Keys } from "../../src/registry/keys.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { TEAM_ID } from "../support/context.js"

const policy = (input: { readonly directHold?: boolean; readonly directTell?: string } = {}) => ({
  ...OwnTeam.POLICY,
  ...input,
})
const team = (input: Parameters<typeof policy>[0] = {}) => ({ target: "main", policy: policy(input) })
const PLAIN = { name: "화면", goal: "", directory: "D:/w/ui", branch: "ui", shape: "plain" as const }
const CODE = { ...PLAIN, shape: "code" as const }
const PEER = { key: "reviewer", label: "리뷰어", role: "" }

const HOLD = "- 사용자가 이 대화에 말하면 이 영역은 '직접 작업'이 된다."

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

describe("the layout: the program's part, the guard, the 일하는 방식 block", () => {
  test("every role ends with the guard and the default block; a user's block takes the default's place", () => {
    const texts = {
      main: RoleInstructions.main({ team: team(), blocks: {} }),
      owner: RoleInstructions.owner({ team: team(), area: PLAIN, blocks: {} }),
      peer: RoleInstructions.peer({ team: team(), area: PLAIN, peer: PEER, blocks: {} }),
    }
    for (const role of RoleInstructions.ROLES) {
      expect(texts[role]).toEndWith(`\n${RoleInstructions.GUARD}\n${RoleInstructions.STANDARD[role]}`)
      expect(texts[role].split(RoleInstructions.GUARD)).toHaveLength(2)
    }
    const custom = { main: "- 보고는 영어로 한다.", owner: "- 커밋 글은 영어로 쓴다.", peer: "- 리뷰는 목록으로 쓴다." }
    const mine = {
      main: RoleInstructions.main({ team: team(), blocks: custom }),
      owner: RoleInstructions.owner({ team: team(), area: PLAIN, blocks: custom }),
      peer: RoleInstructions.peer({ team: team(), area: PLAIN, peer: PEER, blocks: custom }),
    }
    for (const role of RoleInstructions.ROLES) {
      expect(mine[role]).toEndWith(`\n${RoleInstructions.GUARD}\n${custom[role]}`)
      expect(mine[role]).not.toContain(RoleInstructions.STANDARD[role])
      // The program's part is the same whatever the block says.
      expect(mine[role].split(RoleInstructions.GUARD)[0]).toBe(texts[role].split(RoleInstructions.GUARD)[0])
    }
  })

  test("the main's default block names no tool; the program's part keeps every tool rule", () => {
    expect(RoleInstructions.STANDARD.main).not.toMatch(/team_\w+/)
    expect(RoleInstructions.STANDARD.main).toContain("새 일은 먼저 역할이 맞는 영역에 맡긴다")
    const main = RoleInstructions.main({ team: team(), blocks: { main: "- 아무 규칙 없음." } })
    for (const tool of [
      "team_dispatch",
      "team_integrate",
      "team_status",
      "team_reorganize",
      "team_area",
      "team_control",
    ])
      expect(main).toContain(tool)
  })
})

describe("what follows the settings", () => {
  test("the main: '직접 작업 중' with directHold on (the default), the information mark with it off", () => {
    const on = RoleInstructions.main({ team: { policy: OwnTeam.POLICY }, blocks: {} })
    expect(on).toContain("- 팀 소식에 '직접 작업 중'인 영역은 사용자가 그 담당과 직접 일하는 중이다.")
    // Only the user's explicit word takes a held area back; asking for work there is not one (owner wish 0.1-2).
    expect(on).toContain(
      '사용자가 너에게 그 영역을 넘겨받으라고 분명히 말할 때만 team_area(action:"resume")로 넘겨받고(그 영역에 일을 시키라는 말만으로는 넘겨받지 않는다)',
    )
    expect(on).toContain("그동안 보고가 없으면 반영하거나 새 일을 주기 전에 사용자에게 무엇을 할지 묻는다")
    const off = RoleInstructions.main({ team: team({ directHold: false }), blocks: {} })
    expect(off).toContain("- 팀 소식에 '사용자가 직접 대화함'이 있는 영역에는, 사용자가 너에게 시킨 일이 아니면")
    expect(off).not.toContain("직접 작업 중")
    // directTell is not the main's.
    expect(RoleInstructions.main({ team: team({ directTell: "none" }), blocks: {} })).toBe(on)
  })

  test("the owner: the hold sentence only with directHold on, the tell sentence by directTell", () => {
    const on = RoleInstructions.owner({ team: team(), area: PLAIN, blocks: {} })
    expect(on).toContain(HOLD)
    expect(on).toContain(
      "폴더의 커밋 안 된 변경이나 메인 요청과 어긋나는 일은 blocked로 올리지 말고 이 대화에서 사용자에게 묻는다",
    )
    // The unconditional blocked rules of the other lines yield to it, and steering a main request is not direct work.
    expect(on).toContain("(직접 작업 중에는 다른 줄의 blocked보다 이 줄이 먼저다)")
    expect(on).toContain("메인 요청을 하는 중에 한 말은 직접 작업이 아니다.")
    expect(on).toContain("사용자가 일이 끝났다고 하면 메인에게 넘길지 한 번 묻는다")
    expect(RoleInstructions.owner({ team: team({ directHold: false }), area: PLAIN, blocks: {} })).not.toContain(HOLD)
    const tell = (directTell: string) => RoleInstructions.owner({ team: team({ directTell }), area: PLAIN, blocks: {} })
    expect(tell("judge")).toContain(
      "메인이나 다른 영역에 영향이 있을 때(공유 파일, 다른 영역이 기다리는 결과, 반영할 준비)",
    )
    expect(tell("none")).toContain("- 사용자가 직접 시킨 일은 사용자가 알리라고 할 때만 team_report로 알린다.")
    expect(tell("always")).toContain(
      '- 사용자가 직접 시킨 일을 끝냈으면 team_report(kind:"progress")로 한두 줄 요약한다.',
    )
    // An unknown stored value reads as judge.
    expect(tell("later")).toBe(tell("judge"))
  })

  test("the owner's area: `역할: ` only with a role, the role change it makes itself, the large-file line for code", () => {
    const plain = RoleInstructions.owner({ team: team(), area: PLAIN, blocks: {} })
    expect(plain).not.toContain("역할: ")
    expect(plain).not.toContain("목표")
    const goal = RoleInstructions.owner({ team: team(), area: { ...CODE, goal: "정렬 버그와 UI" }, blocks: {} })
    expect(goal.split("\n")[1]).toBe("역할: 정렬 버그와 UI")
    expect(goal).toContain("네 역할 안에서 할 수 있는 만큼만")
    expect(goal).toContain("네 역할 밖의 일은")
    expect(goal).toContain('team_area{action:"role", area, role}에 바뀐 뒤의 역할 전체를 적어 부른다')
    expect(goal).toContain("- 이 폴더는 큰 파일 폴더를 받지 않은 가벼운 폴더다.")
    expect(goal).toContain("영역 끝내기, 팀에서 빼기")
  })

  test("the peer: no hold sentence; the relay names the role change as the main's; `맡은 역할:` only with one", () => {
    const peer = RoleInstructions.peer({ team: team(), area: PLAIN, peer: PEER, blocks: {} })
    expect(peer).not.toContain("'직접 작업'")
    expect(peer).toContain(
      "(새 영역, 나누기, 묶기, 영역 끝내기, 영역 역할 바꾸기, 팀에서 빼기, 대화 옮기기, 다른 영역에 맡길 일)",
    )
    expect(peer).toContain('중간 상황은 team_report(kind:"progress").')
    expect(peer).not.toContain("맡은 역할:")
    const named = RoleInstructions.peer({ team: team(), area: PLAIN, peer: { ...PEER, role: " 리뷰 " }, blocks: {} })
    expect(named.split("\n")[1]).toBe("맡은 역할: 리뷰")
    const none = RoleInstructions.peer({ team: team({ directTell: "none" }), area: PLAIN, peer: PEER, blocks: {} })
    expect(none).toContain("- 사용자가 직접 시킨 일은 사용자가 알리라고 할 때만 team_report로 알린다.")
  })
})

describe("size pins of fixed fixtures (design 3.4)", () => {
  test("main < 2,700 with the hold on; owner plain < 2,900, code < 3,000; peer plain < 2,300", () => {
    expect(RoleInstructions.main({ team: { policy: OwnTeam.POLICY }, blocks: {} }).length).toBeLessThan(2_700)
    expect(RoleInstructions.owner({ team: team(), area: PLAIN, blocks: {} }).length).toBeLessThan(2_900)
    expect(RoleInstructions.owner({ team: team(), area: CODE, blocks: {} }).length).toBeLessThan(3_000)
    expect(RoleInstructions.peer({ team: team(), area: PLAIN, peer: PEER, blocks: {} }).length).toBeLessThan(2_300)
  })

  test("every role reads the team's records through the team tools, never the app's folders (2026-11-16)", () => {
    const line = "사용자가 시키지 않으면 앱의 설치·데이터 폴더와 데이터베이스를 셸로 열지 않는다."
    const owner = RoleInstructions.owner({ team: team(), area: PLAIN, blocks: {} })
    const peer = RoleInstructions.peer({ team: team(), area: PLAIN, peer: PEER, blocks: {} })
    expect(RoleInstructions.main({ team: { policy: OwnTeam.POLICY }, blocks: {} })).toContain(line)
    expect(owner).toContain(line)
    expect(peer).toContain(line)
    // Before a commit an owner or a peer looks for changes it did not make (the user's hand edit, L18).
    expect(owner).toContain("커밋하기 전에 git status와 git diff로 네 변경만 있는지 본다.")
    expect(peer).toContain("커밋하기 전에 git status와 git diff로 네 변경만 있는지 본다.")
  })
})

describe("팀 지시문 as settings.get shows it", () => {
  test("per role the program's part, the guard, the default and the user's block; '…' for the area and the peer", () => {
    const shown = RoleInstructions.view(team(), { owner: "- 커밋 글은 영어로 쓴다." })
    expect(shown.limit).toBe(OwnTeam.INSTRUCTIONS_MAX)
    expect(shown.main.custom).toBeUndefined()
    expect(shown.owner.custom).toBe("- 커밋 글은 영어로 쓴다.")
    for (const role of RoleInstructions.ROLES) {
      expect(shown[role].guard).toBe(RoleInstructions.GUARD)
      expect(shown[role].standard).toBe(RoleInstructions.STANDARD[role])
      expect(shown[role].program).not.toContain(RoleInstructions.GUARD)
    }
    expect(`${shown.main.program}\n${shown.main.guard}\n${shown.main.standard}`).toBe(
      RoleInstructions.main({ team: team(), blocks: {} }),
    )
    expect(shown.owner.program.split("\n").slice(0, 3)).toEqual([
      "# 영역 담당 역할 (own.team): …",
      "역할: …",
      "작업 폴더: … · 줄기: … · 대상 줄기: main",
    ])
    expect(shown.owner.program).not.toContain("큰 파일 폴더를 받지 않은 가벼운 폴더")
    expect(shown.peer.program.split("\n")[0]).toBe("# 영역 동료 역할 (own.team): … · 동료 …")
    // The program part follows the settings.
    expect(RoleInstructions.view(team({ directHold: false }), {}).owner.program).not.toContain(HOLD)
  })
})

describe("the stored blocks (KV `instructions:<teamID>`)", () => {
  test("absent reads as none; saved blocks read back; with none left the key goes", async () => {
    const kv = memory()
    const quiet = logger()
    expect(await RoleInstructions.blocks(kv, quiet.log, TEAM_ID)).toEqual({})
    await RoleInstructions.saveBlocks(kv, TEAM_ID, { main: "- 짧게.", peer: "- 목록으로." })
    expect(await RoleInstructions.blocks(kv, quiet.log, TEAM_ID)).toEqual({ main: "- 짧게.", peer: "- 목록으로." })
    await RoleInstructions.saveBlocks(kv, TEAM_ID, {})
    expect(await kv.get(Keys.instructions(TEAM_ID))).toBeUndefined()
    expect(quiet.lines).toEqual([])
  })

  test("an invalid value reads as none (the defaults) and is logged", async () => {
    const kv = memory()
    const noisy = logger()
    await kv.set(Keys.instructions(TEAM_ID), { main: 7 })
    expect(await RoleInstructions.blocks(kv, noisy.log, TEAM_ID)).toEqual({})
    expect(noisy.lines.some((line) => line.includes("팀 지시문"))).toBe(true)
  })
})
