export * as IntegrateTool from "./integrate.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { OwnTeam } from "@own/protocol"
import { IntegrateOp } from "../integrate/op.js"
import { ReportEvents } from "../report/events.js"
import type { Services } from "../services.js"
import { Direct } from "../dispatch/direct.js"
import { MainTools } from "./main.js"
import { OwnerTools } from "./owner.js"
import { VoicePlan } from "./voice.js"

/**
 * `team_integrate{area, tip?, token?}` (06 §2.8, §2.9, §7.1): integrating an area into the project's main code. The
 * team main names any area; an owner only its own, and its call first does the `ready` clean check and records the
 * branch tip as the candidate without waking the main (`ReportEvents.ready`). The integration op runs on its own: its
 * result reaches the main in a team update (a failed check or a second conflict wakes it, 5.6). A waiting integration
 * of the area is tried again instead (7.2).
 *
 * `tip: true` (the team main only, "지금 상태로 반영해"): with a candidate or a waiting integration it is the call
 * without `tip`; otherwise it answers a plan (`tools/voice.ts`) built from `IntegrateOp.plan{tip}` (the save points
 * that go in) and bound to the tip's SHA. Approved, it runs by the user with that `source`: a tip that moved since is
 * `conflict` and nothing starts. Every integrate step runs either way; nothing skips the checks.
 *
 * 직접 작업 (2026-11-14, `dispatch/direct.ts`): an area the user works with directly goes in only when the user says
 * so. Its owner integrates at once in a run the user opened in that conversation (`VoicePlan.backed`), else it answers
 * a plan; the main always answers a plan (a user-opened main run cannot tell a question from an integrate request).
 * Either runs by the user. A plan of the owner is approved in the owner conversation, in the area folder.
 * The description changed once in T2 when the tool became available (user decision 2026-10-03), and once with V.
 */

export const NAME = "integrate"

export const DESCRIPTION = [
  "Integrate an area's ready work into the project's main code after verification (team main: any area; owner: its own area). The result arrives in a later team update.",
  "tip: true (team main): without a ready report, the area's current state; it returns a plan bound to that save point, run with token after the user's next message.",
].join("\n")

export const Input = Schema.Struct({
  area: Schema.String.annotate({ description: "Area id, slug or name." }),
  tip: optional(
    Schema.Boolean.annotate({ description: "The area's current state when no ready report came (team main; a plan)." }),
  ),
  token: optional(Schema.String),
})

/** An owner named another area. */
export const OWN_AREA_ONLY = "담당은 자기 영역만 반영할 수 있습니다."
/** `tip` from an owner. */
export const TIP_MAIN_ONLY =
  "지금 상태로 반영하기(tip)는 팀 메인이 사용자의 말을 받아 합니다. 담당은 커밋한 뒤 tip 없이 부르세요."

export async function run(
  services: Services.Context,
  caller: MainTools.Caller | OwnerTools.AreaCaller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  // Integrating is the owner's (동료 see the tool with the owner's allows; the registry narrows).
  if (caller.role === "peer") return { ok: false, text: OwnerTools.PEER_REFUSED }
  if (caller.role === "owner" && input.tip === true) return { ok: false, text: TIP_MAIN_ONLY }
  const voice = {
    sessionID: caller.sessionID,
    directory: caller.role === "main" ? caller.team.home.directory : caller.area.directory,
  }
  if (input.token !== undefined)
    return VoicePlan.redeem(services, voice, { tool: NAME, action: TIP, token: input.token })
  const area = await MainTools.area(services, caller.team.id, input.area)
  if (!area) return { ok: false, text: MainTools.NO_AREA }
  if (caller.role === "owner") {
    if (area.id !== caller.area.id) return { ok: false, text: OWN_AREA_ONLY }
    const ready = await ReportEvents.ready(services, {
      teamID: caller.team.id,
      areaID: area.id,
      sessionID: caller.sessionID,
    })
    if (!ready.ok) return MainTools.answer(ready)
  }
  if (input.tip === true && !area.candidate && !(await waiting(services, area))) return tip(services, voice, area)
  if (Direct.live(area)) return held(services, caller, voice, area)
  const started = await services.features().integrate.start({
    teamID: caller.team.id,
    areaID: area.id,
    by: caller.role === "main" ? "main" : "auto",
  })
  if (!started.ok) return MainTools.answer(started)
  return {
    ok: true,
    text: STARTED(area.name, caller.role === "main"),
    opID: started.opID,
    integrationID: started.integrationID,
  }
}

/**
 * The start answer. The main's own conversation works in the home, so the target moves only after its turn ended (8.4);
 * a main that waits in its turn for the result holds it back (live team test, 2026-10-14: it slept for minutes).
 */
const STARTED = (area: string, main: boolean) =>
  `${area}: 반영을 시작했습니다. 검사와 결과는 다음 팀 소식에 옵니다.` +
  (main ? " 메인 폴더에는 이 턴이 끝난 뒤 들어가니, 기다리지 말고 턴을 끝내세요." : "")

/** The plan's action name. */
const TIP = "tip"

/** Subjects shown in a tip plan at most. */
const SUBJECTS = 8

/** The tip plan: what goes in, bound to the SHA shown; the start rules of 7.1 are checked now and again when it runs. */
async function tip(services: Services.Context, voice: VoicePlan.Caller, area: OwnTeam.Area) {
  const planned = await IntegrateOp.plan(services, { teamID: area.teamID, areaID: area.id, tip: true })
  if (!planned.ok) return MainTools.answer(planned)
  const source = planned.source
  const subjects = planned.subjects
  return VoicePlan.issue(services, voice, {
    tool: NAME,
    action: TIP,
    method: "area.integrate",
    text: [
      `${area.name}의 지금 상태(저장 지점 ${source.slice(0, 8)})를 프로젝트 본 코드에 반영합니다.`,
      subjects.length === 0
        ? "새로 들어갈 저장 지점이 보이지 않습니다."
        : `들어갈 저장 지점 ${subjects.length}개: ${subjects
            .slice(0, SUBJECTS)
            .map((subject) => `"${subject}"`)
            .join(", ")}${subjects.length > SUBJECTS ? " …" : ""}.`,
      "검사를 모두 거친 뒤에만 반영하고, 반영한 뒤에는 되돌리기로 되돌릴 수 있습니다. 그 사이 영역이 더 바뀌면 반영하지 않고 다시 묻습니다.",
    ].join(" "),
    run: async () => {
      const started = await services
        .features()
        .integrate.start({ teamID: area.teamID, areaID: area.id, by: "user", tip: true, source })
      if (started.ok)
        return {
          ok: true,
          text: STARTED(area.name, true),
          opID: started.opID,
          integrationID: started.integrationID,
        }
      if (started.error === "conflict")
        return {
          ok: false,
          error: started.error,
          text: `${area.name}: 보여 준 뒤 영역의 저장 지점이 바뀌어 반영하지 않았습니다. 다시 계획하세요.`,
        }
      return MainTools.answer(started)
    },
  })
}

/**
 * An area held by direct work: the owner at once when the user opened its run there (a device without the admin scope
 * is told so), else a plan; the main always a plan.
 */
async function held(
  services: Services.Context,
  caller: MainTools.Caller | OwnerTools.AreaCaller,
  voice: VoicePlan.Caller,
  area: OwnTeam.Area,
) {
  const run = () => user(services, area, caller.role === "main")
  if (caller.role === "main") return planned(services, voice, area, run)
  const backed = await VoicePlan.backed(services, voice, "admin")
  if (backed === "ok") return run()
  if (backed === "scope")
    return {
      ok: false,
      error: "needs_pc",
      text: `${VoicePlan.needsPc("admin")} 메인에게 넘기기는 그 기기에서도 할 수 있습니다.`,
    }
  return planned(services, voice, area, run)
}

function planned(
  services: Services.Context,
  voice: VoicePlan.Caller,
  area: OwnTeam.Area,
  run: () => Promise<MainTools.Reply>,
) {
  return VoicePlan.issue(services, voice, {
    tool: NAME,
    action: TIP,
    method: "area.integrate",
    text: `${area.name}: 직접 작업한 변경을 프로젝트 본 코드에 반영할까요?`,
    run,
  })
}

/** The integration of a held area, by the user (the user said so in the run or approved the plan). */
async function user(services: Services.Context, area: OwnTeam.Area, main: boolean): Promise<MainTools.Reply> {
  const started = await services.features().integrate.start({ teamID: area.teamID, areaID: area.id, by: "user" })
  if (!started.ok) return MainTools.answer(started)
  return {
    ok: true,
    text: STARTED(area.name, main),
    opID: started.opID,
    integrationID: started.integrationID,
  }
}

/** A waiting integration of the area (7.2): it is tried again, so `tip` plans nothing. */
async function waiting(services: Services.Context, area: OwnTeam.Area) {
  return (await IntegrateOp.list(services, area.teamID)).some(
    (item) => item.state === "waiting" && item.areaID === area.id,
  )
}
