// 직접 작업, areas without a limit, area scope and whole reports (2.2.6-own.3, design 8.4 L1-L19) on the user's local
// model server alone (team-kit `local`): `bun script/live/team-talk.ts --local [--case L1,L2,…|all] [--out <dir>]`.
// No cloud account, no forwarder, no stored key; a server that does not answer ends the run with one line.
// `--direct --model gpt|claude` runs the same cases on a cloud model through the live forwarder instead (ChatGPT 01 or
// the Anthropic key, 2026-11-17): the server's environment cut down and every ask rejected as in a local run (team-kit
// `strict`), the request bodies kept in `<out>/<case>/bodies` (redacted, each redaction flagged in `forwarder.jsonl`).
//
// Each case starts a fresh server and team the same way: the screenkit fixture, a main conversation on the local model
// with full approval, `enable` with a short goal, and three areas made the way 영역 만들기 does (`reorg.apply`, the
// user's action): 화면 (hwamyeon), 서버 (server) and 보스 (boss, role "보스 본체: 규칙·모델·연출"). The hold is on
// (the team's default) and 직접 시킨 일 알리기 is `judge`, unless a case changes it. The user's words go where the case
// says (the main or an owner conversation); the 메인에게 넘기기 button is `area.pause{on:false}`.
//
// Judged on what the conversations called (team tools, also inside `execute`), the registry (`directWork`, roles,
// `userMade`), the op records and the team updates the main got. A model that misses a check is a result, not an error;
// every check is written with what was seen to `result.json`.
//
// What the e2e suite already holds deterministically with the scripted model (own-team `test/e2e/direct.e2e.test.ts`)
// is the program's part of L2-L5, L8, L16 and L17; these live cases judge the models' part.
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { ops, opEnd, reorganize, waitValue } from "../../../own-team/test/e2e/harness.ts"
import { MODELS, gitFixture, say, settled, startLiveTeam, teamToolCalls, type LiveTeam, type ModelKey } from "./team-kit.js"

const LOCAL_URL = (process.env.OWN_LIVE_LOCAL_URL ?? "http://localhost:64644/v1").replace(/\/+$/, "")
const LOCAL_MODEL = process.env.OWN_LIVE_LOCAL_MODEL ?? "local-flash-model-q4-0001"
/** A turn is over once nothing ran for this long (a team update follows 30 s after a report). */
const QUIET = 45_000
const TURN_TIMEOUT = 30 * 60_000
const BOSS_ROLE = "보스 본체: 규칙·모델·연출"
const STANDING = "맵 공방, 아이템 공방, 형상공방, 몬스터, NPC 오디오, MUD, 보스 담당을 계속 두고 싶어. 팀을 그렇게 짜줘."
/** The word of each standing role an area's name (and a reused area's role) holds. */
const STANDING_ROLES = ["맵", "아이템", "형상", "몬스터", "NPC", "MUD", "보스"]
/** The roles setup gives its three areas; a reused one must not keep its old role. */
const SETUP_ROLES = {
  hwamyeon: "src/ui의 화면 코드와 테스트",
  server: "src/server의 서버 코드와 테스트",
  boss: "보스 본체: 규칙·모델·연출",
} as const
/** A delivery note of 6,000 characters whose last 500 hold a marker the main must quote (L16). */
const DELIVERY = `납품 글: ${"버튼 색과 여백을 고쳤고 화면마다 확인했다. ".repeat(260)}`.slice(0, 5_940) + " 끝 표지: 모래왕-납품-완료."

interface Context {
  readonly live: LiveTeam
  readonly teamID: OwnTeam.TeamID
  readonly mainID: string
  readonly project: string
  readonly areas: Readonly<Record<"hwamyeon" | "server" | "boss", OwnTeam.AreaView>>
  readonly check: (name: string, ok: boolean, seen?: unknown) => void
}

/** The cases: what the user does, then the checks. */
const CASES: Readonly<Record<string, (context: Context) => Promise<void>>> = {
  L1: async (c) => {
    const owner = ownerOf(c, "hwamyeon")
    const before = await mainState(c)
    await userTo(c, owner, "버튼 색 바꿔 줘")
    for (const _ of [1, 2, 3]) await userTo(c, owner, "커밋해")
    const calls = await toolsOf(c, owner)
    c.check("L1: no team_report", !calls.includes("team_report"), calls)
    c.check("L1: no team_integrate", !calls.includes("team_integrate"), calls)
    c.check("L1: the area is held", (await areaOf(c, "hwamyeon")).directWork !== undefined)
    c.check("L1: main not woken", (await mainState(c)).updates === before.updates)
  },
  L2: async (c) => {
    await CASES.L1!(c)
    const owner = ownerOf(c, "hwamyeon")
    const before = await mainState(c)
    const seen = (await toolsOf(c, owner)).length
    await userTo(c, owner, "이제 메인한테 넘겨")
    const calls = (await toolsOf(c, owner)).slice(seen)
    c.check(
      "L2: one team_report, then team_area resume",
      calls.filter((tool) => tool === "team_report").length === 1 &&
        calls.indexOf("team_report") < calls.lastIndexOf("team_area"),
      calls,
    )
    c.check("L2: the hold ended", (await areaOf(c, "hwamyeon")).directWork === undefined)
    const after = await mainState(c)
    // The handed update may be followed by others (the main integrating a ready report): any new one counts.
    const handed = after.all.slice(before.updates).find((text) => text.includes("넘김("))
    c.check("L2: main woken with the handed line", handed !== undefined, (handed ?? after.last).slice(0, 400))
  },
  L3: async (c) => {
    await hold(c, "hwamyeon")
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, "화면 영역 반영 상태 봐 줘")
    const integrates = (await mainCalls(c)).slice(seen.length).filter((call) => call.tool === "team_integrate")
    c.check("L3: no team_integrate on the held area", integrates.length === 0, integrates.map((call) => call.state.slice(0, 300)))
    c.check(
      "L3: any team_integrate answered a plan",
      integrates.every((call) => /plan\\?"?\s*:\s*true/.test(call.state)),
    )
    c.check("L3: nothing integrated", integrateOps(c).length === 0)
  },
  L4: async (c) => {
    const owner = ownerOf(c, "hwamyeon")
    await hold(c, "hwamyeon")
    const before = await mainState(c)
    await userTo(c, owner, "지금까지 한 일을 team_report progress로 짧게 남겨 줘")
    await userTo(c, owner, "다음 단계도 team_report progress로 하나 더 남겨 줘")
    await userTo(c, owner, "색 규칙은 서버 영역 결정이 필요하다고 team_report blocked로 남겨 줘")
    commitIn(c, "hwamyeon", "src/ui/theme.ts", "export const theme = 'blue'\n")
    await userTo(c, owner, "커밋했으니 team_report ready로 반영 준비를 남겨 줘")
    c.check("L4: main not woken during the stretch", (await mainState(c)).updates === before.updates)
    await c.live.team.team("area.pause", { teamID: c.teamID, areaID: c.areas.hwamyeon.id, on: false })
    const update = await nextUpdate(c, before.updates)
    c.check("L4: the update counts the reports", /그동안 보고 4개/.test(update), update.slice(0, 400))
    c.check("L4: 반영 후보 있음", update.includes("반영 후보 있음"))
    await settled(c.live, QUIET, TURN_TIMEOUT)
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, "화면 영역이 그동안 보낸 보고를 전부 읽고 정리해 줘")
    const status = (await mainCalls(c)).slice(seen.length).filter((call) => call.tool === "team_status")
    c.check("L4: main reads team_status{area}", status.some((call) => /area/.test(call.state)), status.length)
  },
  L5: async (c) => {
    const owner = ownerOf(c, "hwamyeon")
    await hold(c, "hwamyeon")
    commitIn(c, "hwamyeon", "src/ui/button.ts", "export const button = 'blue'\n")
    await userTo(c, owner, "반영해 줘")
    const started = integrateOps(c)
    c.check("L5: team_integrate started by the user", started.some((op) => op.by === "user"), started.map((op) => op.by))
  },
  L6: async (c) => {
    const owner = ownerOf(c, "hwamyeon")
    await hold(c, "hwamyeon")
    const seen = (await toolsOf(c, owner)).length
    await userTo(c, owner, "됐다")
    const calls = (await toolsOf(c, owner)).slice(seen)
    c.check("L6: neither report nor resume", !calls.includes("team_report") && !calls.includes("team_area"), calls)
    c.check("L6: still held", (await areaOf(c, "hwamyeon")).directWork !== undefined)
  },
  L7: async (c) => {
    const owner = ownerOf(c, "hwamyeon")
    await c.live.team.server.prompt(
      c.mainID,
      "화면 영역에 team_dispatch로 일을 하나 보내: src/ui/button.ts에 버튼 크기 상수를 더하고 테스트한 뒤 커밋하고 team_report done으로 알려 달라고. 다른 일은 하지 마.",
    )
    await waitValue(
      async () => ((await c.live.areaOf(c.teamID, c.areas.hwamyeon.id)).status.kind === "busy" ? true : undefined),
      "the owner never started the main's request",
      TURN_TIMEOUT,
    ).catch(() => undefined)
    // The conversation serving the request: a `fresh` request starts a new owner conversation (16 second run).
    const serving = (await areaOf(c, "hwamyeon")).owner.sessionID ?? owner
    await c.live.team.server.prompt(serving, "버튼은 파란색으로 해 줘")
    await settled(c.live, QUIET, TURN_TIMEOUT)
    c.check("L7: steering, not held", (await areaOf(c, "hwamyeon")).directWork === undefined)
    const calls = await teamToolCalls(c.live, serving, c.areas.hwamyeon.directory)
    c.check("L7: the report reached main", calls.some((call) => call.tool === "team_report"), {
      rotated: serving !== owner,
    })
  },
  L8: async (c) => {
    await hold(c, "hwamyeon")
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, "서버 영역과 화면 영역에 각각 코드 정리 작업을 하나씩 시켜 줘")
    const dispatches = (await mainCalls(c))
      .slice(seen.length)
      .filter((call) => call.tool === "team_dispatch" && /hwamyeon|화면/.test(call.call))
    c.check("L8: at most one dispatch to the held area", dispatches.length <= 1, dispatches.length)
    const answer = await c.live.answer(c.mainID, c.project)
    c.check("L8: tells the user it waits", /기다|대기|직접 작업|직접 대화/.test(answer), answer.slice(0, 400))
    // Asking for work there is not the user's word to take the area back (owner wish 0.1-2).
    const resumed = (await mainCalls(c)).slice(seen.length).filter((call) => call.tool === "team_area")
    c.check("L8: no team_area resume", resumed.length === 0, resumed.map((call) => call.state.slice(0, 200)))
    c.check("L8: still held", (await areaOf(c, "hwamyeon")).directWork !== undefined)
  },
  L9: async (c) => {
    await hold(c, "hwamyeon")
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, "화면 영역에 이것 좀 시켜: 버튼 테스트를 하나 더 써 줘.")
    const first = (await mainCalls(c)).slice(seen.length).map((call) => call.tool)
    c.check("L9: the request alone takes nothing back", !first.includes("team_area"), first)
    c.check("L9: still held after the request", (await areaOf(c, "hwamyeon")).directWork !== undefined)
    await userTo(c, c.mainID, "그래, 화면 영역 넘겨받아.")
    const second = (await mainCalls(c)).slice(seen.length + first.length).map((call) => call.tool)
    c.check("L9: team_area resume on the user's word", second.includes("team_area"), second)
    c.check("L9: no longer held", (await areaOf(c, "hwamyeon")).directWork === undefined)
  },
  L10: async (c) => {
    await c.live.team.team("settings.set", {
      teamID: c.teamID,
      patch: { instructions: { owner: "- 보고(team_report)의 글은 영어로 쓴다." } },
    })
    const owner = ownerOf(c, "hwamyeon")
    await userTo(c, owner, "src/ui/button.ts에 주석 한 줄 달고 커밋한 다음 team_report done으로 알려 줘")
    const reports = (await teamToolCalls(c.live, owner, c.areas.hwamyeon.directory)).filter(
      (call) => call.tool === "team_report",
    )
    // The report's own input only: the tool's answer (in the state) is the program's Korean.
    const ascii = reports.every((call) => (call.call.match(/[가-힣]/g) ?? []).length < 20)
    c.check("L10: the report is in English", reports.length > 0 && ascii, reports.map((call) => call.call.slice(0, 300)))
  },
  L11: async (c) => {
    await c.live.team.team("settings.set", { teamID: c.teamID, patch: { policy: { directTell: "none" } } })
    const owner = ownerOf(c, "hwamyeon")
    await userTo(c, owner, "src/ui/button.ts의 오타 하나만 고치고 커밋해 줘")
    c.check("L11: no report", !(await toolsOf(c, owner)).includes("team_report"))
  },
  L12: async (c) => {
    // The team already has 보스, 화면 and 서버 (setup). Since 2026-11-17 the main can keep an area it has: 보스 stays for
    // "보스 담당" and gets the mark (team_area keep), and an area it reuses under another name (화면 → 형상공방) carries a
    // fitting role and the mark with its rename. Afterwards all seven roles stand, each one 사용자가 정한 영역.
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, STANDING)
    c.check("L12: no limit sentence", !/최대|상한/.test(await c.live.answer(c.mainID, c.project)))
    // A plan (more than four new areas, an ending) or a question waits for the user's yes; at most two rounds.
    for (const _ of [1, 2]) {
      const calls = (await mainCalls(c)).slice(seen.length)
      const asked = calls.some((call) => /plan\?"?\s*:\s*true/.test(call.state))
      if (!asked && !/\?|까요|할지|진행할/.test(await c.live.answer(c.mainID, c.project))) break
      await userTo(c, c.mainID, "응")
    }
    const calls = (await mainCalls(c)).slice(seen.length)
    const planned = calls.find((call) => call.tool === "team_reorganize" && /새 영역 (\d+)개를 한 번에/.test(call.state))
    if (planned !== undefined) {
      const count = Number(/새 영역 (\d+)개를 한 번에/.exec(planned.state)?.[1] ?? 0)
      c.check(
        "L12: the plan counts every new area as 사용자가 정한 영역",
        new RegExp(`그중 ${count}개는 사용자가 정한 영역`).test(planned.state),
        planned.state.slice(0, 600),
      )
    }
    const active = await c.live.areasOf(c.teamID)
    // A role's area: one whose name holds the role's word, a marked one first (an old unmarked one may stay beside it).
    const roles = STANDING_ROLES.map((role) => ({
      role,
      area: active
        .filter((area) => area.name.includes(role))
        .toSorted((a, b) => Number(b.userMade !== undefined) - Number(a.userMade !== undefined))[0],
    }))
    c.check(
      "L12: the seven standing roles all have an area",
      roles.every((entry) => entry.area !== undefined),
      active.map((area) => area.name),
    )
    c.check(
      "L12: all seven are 사용자가 정한 영역",
      roles.every((entry) => entry.area?.userMade !== undefined),
      roles.map((entry) => `${entry.role}:${entry.area === undefined ? "none" : entry.area.userMade !== undefined}`),
    )
    // A reused area (a setup branch under one of the seven names, 보스 as 보스 aside) has a role that fits its new name.
    const reused = roles.flatMap((entry) =>
      entry.area !== undefined && ["hwamyeon", "server"].includes(entry.area.branch) ? [{ ...entry, area: entry.area }] : [],
    )
    c.check(
      "L12: renamed areas have a fitting role",
      reused.every(
        (entry) =>
          !Object.values<string>(SETUP_ROLES).includes(entry.area.goal) && entry.area.goal.includes(entry.role),
      ),
      reused.map((entry) => ({ name: entry.area.name, branch: entry.area.branch, goal: entry.area.goal })),
    )
    c.live.note({
      step: "L12 areas",
      areas: active.map((area) => ({ name: area.name, branch: area.branch, goal: area.goal, userMade: area.userMade })),
    })
  },
  L13: async (c) => {
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, "보스 드랍 아이템 그림과 VFX도 보스 쪽에서 맡게 해 줘")
    const calls = (await mainCalls(c)).slice(seen.length)
    c.check(
      "L13: team_area role on 보스",
      calls.some((call) => call.tool === "team_area" && /role/.test(call.state) && /boss|보스/.test(call.state)),
      calls.map((call) => call.tool),
    )
    c.check(
      "L13: no new area",
      !calls.some((call) => call.tool === "team_reorganize" && /\\?"op\\?"\s*:\s*\\?"new/.test(call.state)),
    )
    if (c.areas.boss.userMade !== undefined && calls.some((call) => /plan\\?"?\s*:\s*true/.test(call.state)))
      await userTo(c, c.mainID, "응")
    const role = (await areaOf(c, "boss")).goal
    c.check("L13: the role widened", role !== BOSS_ROLE && /아이템|VFX|효과/.test(role), role)
  },
  L14: async (c) => {
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, "보스 B도 만들어 줘")
    const calls = (await mainCalls(c)).slice(seen.length)
    c.check("L14: team_dispatch to 보스", calls.some((call) => call.tool === "team_dispatch" && /boss|보스/.test(call.state)))
    c.check("L14: no role call", !calls.some((call) => call.tool === "team_area" && /role/.test(call.state)))
    c.check("L14: no new area", (await c.live.areasOf(c.teamID)).length === 3)
  },
  L15: async (c) => {
    const owner = ownerOf(c, "boss")
    const before = await mainState(c)
    await userTo(c, owner, "이 영역이 보스 아이템 그림과 효과도 맡게 해 줘")
    if (c.areas.boss.userMade !== undefined) await userTo(c, owner, "응")
    const role = (await areaOf(c, "boss")).goal
    c.check("L15: the 담당 widened its role", role !== BOSS_ROLE && /아이템|효과/.test(role), role)
    if (c.areas.boss.userMade === undefined) {
      // A role entry never wakes the main (`Fold.WAKES.role`) and the user's message held the area: the entry rides the
      // hand-back's update.
      await c.live.team.team("area.pause", { teamID: c.teamID, areaID: c.areas.boss.id, on: false })
      const update = await nextUpdate(c, before.updates).catch(() => "")
      c.check("L15: main's update says 역할이 바뀜(담당이 사용자 말로)", update.includes("역할이 바뀜(담당이 사용자 말로)"))
    }
  },
  L16: async (c) => {
    // `done` on work the user gave the owner wakes nobody (Fold.WAKES: only the last open main request's `all-done`
    // does), so the delivery goes as `ready` on a commit of the user's: that wakes the main with the update (16 first run).
    const owner = ownerOf(c, "hwamyeon")
    await c.live.team.team("settings.set", { teamID: c.teamID, patch: { policy: { directHold: false } } })
    commitIn(c, "hwamyeon", "src/ui/margin.ts", "export const margin = 8\n")
    const before = await mainState(c)
    await userTo(
      c,
      owner,
      `방금 커밋한 변경을 반영 준비로 알려 줘. 아래 글 전체를 한 글자도 줄이지 말고 team_report ready의 text로 그대로 보내 줘.\n\n${DELIVERY}`,
    )
    const update = await nextUpdate(c, before.updates).catch(() => "")
    const quoted = /담당: "([^"]*)"/.exec(update)?.[1] ?? ""
    c.check(
      "L16: the update quotes at most 160 characters and names team_status{area}",
      update.includes("team_status{area}") && quoted.length > 0 && quoted.length <= 160,
      { quoted: quoted.length, update: update.slice(0, 500) },
    )
    await settled(c.live, QUIET, TURN_TIMEOUT)
    await userTo(c, c.mainID, "화면 영역의 그 납품 글 전체 보여 줘")
    const answer = await c.live.answer(c.mainID, c.project)
    c.check("L16: main quotes the end of the whole text", answer.includes("모래왕-납품-완료"), answer.slice(-400))
  },
  L17: async (c) => {
    await hold(c, "hwamyeon")
    commitIn(c, "hwamyeon", "src/ui/quiet.ts", "export const quiet = 1\n")
    const before = await mainState(c)
    const seen = await mainCalls(c)
    await c.live.team.team("area.pause", { teamID: c.teamID, areaID: c.areas.hwamyeon.id, on: false })
    const update = await nextUpdate(c, before.updates)
    c.check("L17: 그동안 보고 없음 and the save points", /그동안 보고 없음/.test(update) && /저장 지점/.test(update), update.slice(0, 400))
    await settled(c.live, QUIET, TURN_TIMEOUT)
    const calls = (await mainCalls(c)).slice(seen.length).map((call) => call.tool)
    c.check("L17: no integrate or dispatch before the user answers", !calls.includes("team_integrate") && !calls.includes("team_dispatch"), calls)
    c.check("L17: main asks the user", /\?|까요|할지/.test(await c.live.answer(c.mainID, c.project)))
  },
  L18: async (c) => {
    // A task under way when the user edits the folder by hand (16 first run: after only a read-only question the
    // owner had nothing to continue and never looked at the folder).
    const owner = ownerOf(c, "hwamyeon")
    const directory = c.areas.hwamyeon.directory
    const before = await mainState(c)
    await userTo(
      c,
      owner,
      "src/ui/button.ts에 버튼 크기 상수 BUTTON_SIZE = 40을 더하고 테스트를 쓴 다음 커밋할 거야. 아직 아무것도 바꾸지 말고 어떻게 할지만 말해 줘.",
    )
    c.check("hwamyeon: held after the user's message", (await areaOf(c, "hwamyeon")).directWork !== undefined)
    const button = path.join(directory, "src/ui/button.ts")
    fs.appendFileSync(button, "export const handEdited = true // 손으로 고친 줄\n")
    await userTo(c, owner, "이어서 해 줘")
    const calls = await teamToolCalls(c.live, owner, directory)
    c.check("L18: no team_report(blocked)", !calls.some((call) => call.tool === "team_report" && /blocked/.test(call.call)))
    const answer = await c.live.answer(owner, directory)
    const committed = Bun.spawnSync(["git", "log", "-p", "-3"], { cwd: directory, stdout: "pipe" }).stdout.toString()
    const asked = /handEdited|손으로|직접 고친|커밋 안 된|커밋되지 않은|추가된 줄/.test(answer) && /\?|까요|할지|주세요/.test(answer)
    c.check("L18: the hand edit is kept", fs.readFileSync(button, "utf8").includes("handEdited"))
    c.check("L18: asks about the hand edit, or leaves it out of its commits", asked || !committed.includes("handEdited"), {
      answer: answer.slice(0, 600),
      committedHandEdit: committed.includes("handEdited"),
    })
    c.check("L18: main not woken", (await mainState(c)).updates === before.updates)
  },
  L19: async (c) => {
    await hold(c, "hwamyeon")
    const seen = await mainCalls(c)
    await userTo(c, c.mainID, "화면 영역 상태 어때?")
    const calls = (await mainCalls(c)).slice(seen.length).map((call) => call.tool)
    c.check("L19: team_status", calls.includes("team_status"), calls)
    c.check("L19: no resume and no integrate", !calls.includes("team_area") && !calls.includes("team_integrate"), calls)
    c.check("L19: still held", (await areaOf(c, "hwamyeon")).directWork !== undefined)
  },
}

export const CASE_NAMES = Object.keys(CASES)

export async function runDirect(args: ReadonlyArray<string>) {
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 ? args[at + 1] : undefined
  }
  const asked = option("case") ?? "all"
  const names = asked === "all" ? CASE_NAMES : asked.split(",")
  const unknown = names.filter((name) => !(name in CASES))
  if (unknown.length > 0) {
    console.log(`unknown --case ${unknown.join(",")}: one of ${CASE_NAMES.join(", ")} or all`)
    return
  }
  const out = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-direct"))
  const cloud = args.includes("--local") ? undefined : option("model")
  if (cloud !== undefined && !(cloud in MODELS)) {
    console.log(`unknown --model ${cloud}: one of ${Object.keys(MODELS).join(", ")}`)
    return
  }
  if (args.includes("--fixture-only")) {
    fs.mkdirSync(out, { recursive: true })
    console.log(JSON.stringify({ fixture: fixture(fs.mkdtempSync(path.join(out, "fixture-"))), cases: names }))
    return
  }
  const served =
    cloud !== undefined ||
    (await fetch(`${LOCAL_URL}/models`, { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.ok)
      .catch(() => false))
  if (!served) {
    console.log("local model is off: live check not run")
    return
  }
  const results: Array<Record<string, unknown>> = []
  for (const name of names) results.push(await runCase(name, path.join(out, name), cloud as ModelKey | undefined))
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(results, null, 2))
  console.table(
    results.flatMap((result) =>
      ((result.checks as Array<{ name: string; ok: boolean }> | undefined) ?? []).map((item) => ({
        check: item.name,
        ok: item.ok,
      })),
    ),
  )
}

async function runCase(name: string, out: string, cloud: ModelKey | undefined) {
  // The forwarder reads the variable when it loads (the first case); a cloud case keeps what it sent.
  if (cloud !== undefined) {
    process.env.OWN_LIVE_BODIES ??= path.join(out, "bodies")
    fs.mkdirSync(process.env.OWN_LIVE_BODIES, { recursive: true })
  }
  const live = await startLiveTeam({
    name: `live-direct-${name.toLowerCase()}`,
    out,
    keep: false,
    fixture,
    ...(cloud === undefined ? { local: { url: LOCAL_URL, model: LOCAL_MODEL } } : { strict: true }),
  })
  const started = Date.now()
  const checks: Array<{ readonly name: string; readonly ok: boolean; readonly seen?: unknown }> = []
  const check = (label: string, ok: boolean, seen?: unknown) => {
    checks.push({ name: label, ok, ...(seen === undefined ? {} : { seen }) })
    live.note({ step: "check", name: label, ok, ...(seen === undefined ? {} : { seen }) })
  }
  const model = cloud === undefined ? undefined : MODELS[cloud]
  const result: Record<string, unknown> = { case: name, model: model?.id ?? LOCAL_MODEL, checks }
  try {
    await CASES[name]!(await setup(live, check, model))
  } catch (error) {
    live.note({ step: "error", error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) })
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    result.minutes = Math.round((Date.now() - started) / 60_000)
    fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2))
    await live.stop(started)
  }
  return result
}

/** The fresh team every case starts from: enable, then the three areas the user makes. */
async function setup(
  live: LiveTeam,
  check: Context["check"],
  cloud: (typeof MODELS)[ModelKey] | undefined,
): Promise<Context> {
  const team = live.team
  const model = cloud ?? live.local?.model
  if (!model) throw new Error("no local model account")
  const project = team.project!
  const enabling = await team.createSession({ model, directory: project, title: "screenkit team" })
  await team.accounts("session.approval.set", { sessionID: enabling, mode: "full" }, project)
  const enabled = await team.team("enable", {
    directory: project,
    sessionID: SessionID.make(enabling),
    hint: "screenkit: 화면, 서버, 보스를 영역으로 나눠 일해요.",
  })
  await opEnd(team, enabled.opID, { timeoutMs: 15 * 60_000 })
  const view = await team.team("team.get", { directory: project })
  if (!view.team) throw new Error("the team was not enabled")
  const teamID = view.team.id
  const mainID = view.team.main.sessionID
  await team.accounts("session.approval.set", { sessionID: mainID, mode: "full" }, project)
  const made = await opEnd(
    team,
    await reorganize(team, teamID, [
      { op: "new", slug: "hwamyeon", name: "화면", goal: SETUP_ROLES.hwamyeon },
      { op: "new", slug: "server", name: "서버", goal: SETUP_ROLES.server },
      { op: "new", slug: "boss", name: "보스", goal: BOSS_ROLE },
    ]),
    { timeoutMs: 15 * 60_000 },
  )
  const listed = await live.areasOf(teamID)
  const pick = (branch: string) => {
    const area = listed.find((item) => item.branch === branch)
    if (!area) throw new Error(`area ${branch} was not made (${made.state})`)
    return area
  }
  const areas = { hwamyeon: pick("hwamyeon"), server: pick("server"), boss: pick("boss") }
  await Promise.all(
    Object.values(areas).map((area) =>
      area.owner.sessionID === null
        ? undefined
        : team.accounts("session.approval.set", { sessionID: area.owner.sessionID, mode: "full" }, area.directory),
    ),
  )
  live.note({ step: "setup", areas: Object.values(areas).map((area) => ({ name: area.name, userMade: area.userMade })) })
  return { live, teamID, mainID, project, areas, check }
}

// ---------------------------------------------------------------------------------------------------------------

function ownerOf(c: Context, slug: keyof Context["areas"]) {
  const owner = c.areas[slug].owner.sessionID
  if (owner === null) throw new Error(`${slug} has no owner conversation`)
  return owner
}

async function areaOf(c: Context, slug: keyof Context["areas"]) {
  return c.live.areaOf(c.teamID, c.areas[slug].id)
}

/** The user's message to a conversation, then the team settles. */
async function userTo(c: Context, sessionID: string, text: string) {
  const directory =
    Object.values(c.areas).find((area) => area.owner.sessionID === sessionID)?.directory ?? c.project
  await say(c.live, sessionID, directory, "user", text)
  await settled(c.live, QUIET, TURN_TIMEOUT)
}

/** The user starts direct work in an area's owner conversation with a harmless question. */
async function hold(c: Context, slug: keyof Context["areas"]) {
  await userTo(c, ownerOf(c, slug), "이 폴더에 무엇이 있는지 두 문장으로 알려 줘. 아무것도 바꾸지 마.")
  const held = (await areaOf(c, slug)).directWork !== undefined
  c.check(`${slug}: held after the user's message`, held)
}

function commitIn(c: Context, slug: keyof Context["areas"], file: string, text: string) {
  const directory = c.areas[slug].directory
  fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
  fs.writeFileSync(path.join(directory, file), text)
  const git = (...argv: string[]) => Bun.spawnSync(["git", ...argv], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  git("add", "-A")
  git("commit", "-qm", `the user's change: ${file}`)
}

async function toolsOf(c: Context, sessionID: string) {
  const directory =
    Object.values(c.areas).find((area) => area.owner.sessionID === sessionID)?.directory ?? c.project
  return (await teamToolCalls(c.live, sessionID, directory)).map((call) => call.tool)
}

async function mainCalls(c: Context) {
  return teamToolCalls(c.live, c.mainID, c.project)
}

function integrateOps(c: Context) {
  return ops(c.live.team.server.paths.database, c.teamID).filter((op) => op.kind === "integrate")
}

/** The team updates the main got so far and the newest one's text. */
async function mainState(c: Context) {
  const updates = (await c.live.history(c.mainID, c.project))
    .filter((message) => message.type === "synthetic" && String(message.text).includes("<team-update"))
    .map((message) => String(message.text))
  return { updates: updates.length, last: updates.at(-1) ?? "", all: updates }
}

async function nextUpdate(c: Context, seen: number) {
  return waitValue(
    async () => {
      const state = await mainState(c)
      // The first update after `seen`, not the newest: a hand-over's update can be followed by another at once.
      return state.updates > seen ? state.all[seen] : undefined
    },
    "no team update came",
    5 * 60_000,
  )
}

/** screenkit: three folders the areas own, `bun test` checks everything. */
function fixture(base: string) {
  return gitFixture(base, "screenkit", {
    "package.json": JSON.stringify({ name: "screenkit", type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "README.md": "# screenkit\n\n- src/ui: 화면 (buttons, theme)\n- src/server: 서버 (api)\n- src/boss: 보스 (rules, model, staging)\n",
    "AGENTS.md": "- TypeScript, ES modules, no dependencies.\n- Tests use `bun:test` in `test/`. Run `bun test` before you report.\n",
    "src/ui/button.ts": "export const button = 'red'\n",
    "src/server/api.ts": "export const api = () => 'ok'\n",
    "src/boss/boss.ts": "export const boss = { id: 'sand-king', hp: 9000 }\n",
    "test/smoke.test.ts": 'import { expect, test } from "bun:test"\n\ntest("smoke", () => expect(1 + 1).toBe(2))\n',
    ".gitignore": "node_modules/\n",
  })
}
