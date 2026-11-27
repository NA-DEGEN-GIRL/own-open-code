export * as AreaTool from "./area.js"

import { Option, Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { OwnTeam, type Switch } from "@own/protocol"
import { Direct } from "../dispatch/direct.js"
import { JudgeValidate } from "../judge/validate.js"
import { PathsOp } from "../ops/paths.js"
import { Fold } from "../report/fold.js"
import { AreaEditRpc } from "../rpc/area-edit.js"
import type { Services } from "../services.js"
import { Peers } from "../sessions/peer.js"
import { MainTools } from "./main.js"
import type { OwnerTools } from "./owner.js"
import { Targets } from "./targets.js"
import { VoicePlan } from "./voice.js"

/**
 * `team_area{action, area, …}` (06 §2.9): the area buttons the user may ask for in plain language. The team main names
 * any area; an owner only its own, without `paths` (its own `team_need_paths`) and `cancel` (the main's requests); an
 * area peer (동료) is refused. Actions run at once, or first answer a plan (`tools/voice.ts`) that runs by the user
 * after the user's next message:
 *
 *   pause    메인 멈춤 on                                   at once
 *   resume   메인 멈춤 off                                  plan (a pause the user set is not the model's to lift)
 *            메인에게 넘기기 (direct work, 2026-11-14)       the owner at once in a run the user opened there, the main
 *                                                         (`taken`) at once when the user wrote to it after its last
 *                                                         direct message; otherwise a plan
 *   rotate   새 대화로 이어가기 (reason fresh, warm handoff) at once by main or (owner) auto; a plan under Main 멈춤 or
 *                                                         (main) while the user works there directly
 *   model    모델 바꾸기… (`area.main`, team R4)             always a plan (the user's choice, 06 §0.3), with its cost
 *   preset   프리셋 바꾸기… (`area.preset`)                 always a plan
 *   role     역할 바꾸기 (`area.edit`, 2026-11-14)           the area's whole new role (scope): see {@link role}
 *   keep     내가 정한 영역 on / off (`area.edit`, 2026-11-17) a standing role the user asked to keep: see {@link keep}
 *   unkeep
 *   paths    큰 파일 폴더 가져오기… (main)                  at once by main; a plan under Main 멈춤 or direct work; a
 *                                                         large fetch is still the op's confirm
 *   cancel   기다리는 메인 요청 지우기 (main)                at once: one waiting request, or all of the area with the
 *                                                         main requests still queued in its owner's (and attached
 *                                                         peers') conversations
 *
 * Approved plans run by the user (the button's way): Main 멈춤 does not stop them.
 */

export const NAME = "area"

export const DESCRIPTION = [
  "Area actions the user asks for: Main pause, new conversation, model, preset, role, 내가 정한 영역, large-file folders, cancel.",
  "pause / resume: Main 멈춤 on / off; resume also hands back an area the user works in directly. rotate: the owner continues in a new conversation with a handoff.",
  "model {model}: the area main. preset {preset}: the area preset. Both always return a plan.",
  "role {role}: what the area covers from now on; role is its whole new role text (at most 1,000 characters). Not for a next task inside the same role.",
  "keep: mark an area the team already has as 내가 정한 영역 when the user wants it kept as a standing role (never offered for ending; its later structure changes wait for the user). unkeep: remove the mark (always a plan).",
  "paths {dirs, reason?} (team main): fetch large-file folders. cancel {request?} (team main): waiting main requests and the ones still queued in the owner's conversation.",
  "An owner uses pause, resume, rotate, model, preset, role, keep and unkeep for its own area. resume, model, preset, role, keep, unkeep and actions on an area under Main 멈춤 may return a plan.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals([
    "pause",
    "resume",
    "rotate",
    "model",
    "preset",
    "role",
    "keep",
    "unkeep",
    "paths",
    "cancel",
  ]),
  area: Schema.String.annotate({ description: "Area id, slug or name." }),
  model: optional(
    Schema.String.annotate({ description: 'provider/model or provider/model#effort; "team" = the team main\'s.' }),
  ),
  now: optional(Schema.Boolean),
  preset: optional(Schema.String.annotate({ description: "Preset name or id." })),
  role: optional(Schema.String.annotate({ description: "The area's whole new role text (what it covers), for role." })),
  dirs: optional(Schema.Array(Schema.String)),
  reason: optional(Schema.String),
  request: optional(
    Schema.String.annotate({ description: "A waiting main request's dispatchID; omit for every one of the area." }),
  ),
  token: optional(Schema.String),
})

type Action = (typeof Input.Type)["action"]

/** An area peer called it. */
export const PEER = "동료는 이 도구를 쓰지 않습니다. 팀 메인이나 담당에게 말하세요."
export const OWN_AREA_ONLY = "담당은 자기 영역에만 씁니다."
export const OWNER_PATHS = "담당은 큰 파일 폴더를 team_need_paths로 가져옵니다."
export const OWNER_CANCEL = "메인 요청을 지우는 일은 팀 메인이 합니다. 팀 메인에게 말하세요."
/** `resume` of an area that is neither under Main 멈춤 nor held by direct work. */
export const NOTHING_HELD = (area: string) => `${area}: 메인 멈춤이 꺼져 있고 직접 작업 중도 아닙니다.`
export const ROLE_EMPTY = "role이 필요합니다(바뀐 뒤의 역할 전체)."
export const ROLE_LONG = (count: number) =>
  `역할은 1,000자까지입니다(지금 ${count.toLocaleString("en-US")}자). 줄여서 다시 부르세요.`
export const ROLE_SAME = (area: string) => `'${area}' 영역의 역할이 이미 그 글입니다. 바꾸지 않았습니다.`
/** `keep` of an area already marked, `unkeep` of one that is not (nothing changes). */
export const KEPT_ALREADY = (area: string) => `'${area}'은(는) 이미 사용자가 정한 영역입니다.`
export const UNKEPT_ALREADY = (area: string) => `'${area}'은(는) 사용자가 정한 영역이 아닙니다.`
export const KEPT = (area: string) =>
  `'${area}'을(를) 사용자가 정한 영역으로 표시했습니다. 끝내자는 제안이 붙지 않고, 이름 바꾸기·나누기·묶기·끝내기는 사용자의 답을 받습니다.`
export const UNKEPT = (area: string) => `'${area}'에서 사용자가 정한 영역 표시를 뺐습니다.`
export const ROLE_HELD = (area: string) =>
  `'${area}'은(는) 메인 멈춤이거나 사용자가 직접 일하는 중이라 역할을 바꾸지 않았습니다. 사용자가 이 대화에서 바꾸라고 하면 그 차례에 다시 부르세요.`

export async function run(
  services: Services.Context,
  caller: MainTools.Caller | OwnerTools.AreaCaller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  if (caller.role === "peer") return { ok: false, text: PEER }
  const voice = {
    sessionID: caller.sessionID,
    directory: caller.role === "main" ? caller.team.home.directory : caller.area.directory,
  }
  if (input.token !== undefined)
    return VoicePlan.redeem(services, voice, { tool: NAME, action: input.action, token: input.token })
  const area = await MainTools.area(services, caller.team.id, input.area)
  if (!area) return { ok: false, text: MainTools.NO_AREA }
  if (caller.role === "owner") {
    if (area.id !== caller.area.id) return { ok: false, text: OWN_AREA_ONLY }
    if (input.action === "paths") return { ok: false, text: OWNER_PATHS }
    if (input.action === "cancel") return { ok: false, text: OWNER_CANCEL }
  }
  const context: Context = { services, team: caller.team, area, voice, by: caller.role === "main" ? "main" : "auto" }
  return ACTIONS[input.action](context, input)
}

interface Context {
  readonly services: Services.Context
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly voice: VoicePlan.Caller
  /** Who a direct action runs as: the main, or an owner on its own area (`auto`, like `team_integrate`). */
  readonly by: "main" | "auto"
}

const ACTIONS: { readonly [K in Action]: (context: Context, input: typeof Input.Type) => Promise<MainTools.Reply> } = {
  pause: async (context) => {
    const paused = await context.services
      .features()
      .pause.area({ teamID: context.team.id, areaID: context.area.id, on: true })
    if (!paused.ok) return MainTools.answer(paused)
    return { ok: true, text: `${context.area.name}: 메인 멈춤을 켰습니다. 새 메인 요청은 대기함에서 기다립니다.` }
  },
  resume: async (context) => {
    const area = context.area
    if (area.paused === false && area.directWork === undefined) return { ok: false, text: NOTHING_HELD(area.name) }
    if (area.paused === false) return handBack(context)
    // The waiting requests the switch holds; area messages and notices count apart (06 §5.8).
    const waiting = (await context.services.registry.dispatches.waiting(context.team.id, area.id)).filter(
      Fold.request,
    ).length
    return plan(context, "resume", "area.pause", {
      text: [
        `${area.name}의 메인 멈춤을 끕니다.`,
        waiting > 0 ? `대기함의 메인 요청 ${waiting}개가 폴더가 쉴 때 하나씩 들어갑니다.` : "대기함은 비어 있습니다.",
        "다시 멈추려면 메인 멈춤을 켜면 됩니다.",
      ].join(" "),
      run: async () => {
        const features = context.services.features()
        // The user approved it in the main's conversation: direct work under the pause ends with it, as taken
        // (an owner's run leaves that to the switch, which hands it back).
        const taken =
          context.by === "main" && area.directWork !== undefined
            ? await features.direct.end({ teamID: context.team.id, areaID: area.id, why: "taken" })
            : undefined
        const resumed = await features.pause.area({ teamID: context.team.id, areaID: area.id, on: false })
        if (!resumed.ok) return MainTools.answer(resumed)
        return {
          ok: true,
          text: [`${area.name}: 메인 멈춤을 껐습니다.`, ...(taken === undefined ? [] : [taken.line])].join("\n"),
        }
      },
    })
  },
  rotate: async (context) => {
    const rotate = (input: { readonly reason: "fresh" | "user"; readonly by: OwnTeam.Op["by"] }) => async () => {
      const started = await context.services.features().rotate.request({
        teamID: context.team.id,
        areaID: context.area.id,
        reason: input.reason,
        handoff: "warm",
        by: input.by,
      })
      if (!started.ok) return MainTools.answer(started)
      return {
        ok: true,
        text: `${context.area.name}: 새 대화로 이어 가기를 시작했습니다. 담당이 인계 문서를 쓴 뒤 새 대화로 바뀌고, 옛 대화는 보관됩니다.`,
        opID: started.opID,
      }
    }
    // TI-13: the main does not touch an area under Main 멈춤 or held by direct work by itself; the user's answer makes
    // it the user's action. An owner's own rotate on its area held only by direct work stays immediate: the user who
    // works there is in that conversation, so it starts as the user's (`reason: "user"`: the rotation's TI-13 skip
    // leaves it alone).
    if (!Direct.kept(context.area)) return rotate({ reason: "fresh", by: context.by })()
    if (context.by === "auto" && context.area.paused === false) return rotate({ reason: "user", by: "auto" })()
    return plan(context, "rotate", "area.rotate", {
      text: `${context.area.name}은(는) ${cause(context.area)}. 승인하면 담당 대화를 새 대화로 이어 갑니다: 담당이 인계 문서를 쓴 뒤 새 대화로 바뀌고, 옛 대화는 보관되어 남습니다.`,
      run: rotate({ reason: "user", by: "user" }),
    })
  },
  model: async (context, input) => {
    if (input.model === undefined)
      return { ok: false, text: 'model이 필요합니다: provider/model, provider/model#effort 또는 "team"(팀과 같게).' }
    const used = await Targets.inUse(context.services, context.team)
    const named = input.model.trim() === "team" ? null : Targets.ref(input.model)
    if (named === undefined)
      return {
        ok: false,
        text: `모델 이름을 읽지 못했습니다(provider/model 또는 provider/model#effort). 팀이 쓰는 모델: ${used.join(", ") || "없음"}`,
      }
    const main = await context.services.features().main.model(context.team.id)
    const target = named ?? main
    if (!target) return { ok: false, text: "팀 메인의 모델을 알 수 없습니다. 잠시 뒤 다시 하세요." }
    const owner = context.area.owner.sessionID
    const estimate =
      owner === null
        ? undefined
        : await context.services.accounts.switchEstimate(
            { sessionID: owner, target, reason: MANUAL },
            { directory: context.area.directory },
          )
    if (estimate && !estimate.ok && MISSING.has(estimate.type))
      return {
        ok: false,
        text: `${Targets.refText(target)}(으)로 바꿀 수 없습니다: ${estimate.message}. 팀이 쓰는 모델: ${used.join(", ") || "없음"}`,
      }
    const current = context.area.main?.model ?? main
    const now = input.now === true
    return plan(context, "model", "area.main", {
      text: [
        `${context.area.name} 영역 모델을 ${named === null ? `팀과 같게(${Targets.refText(target)})` : Targets.refText(target)}(으)로 바꿉니다.`,
        how(current, target, now),
        estimate?.ok ? Targets.cost(estimate.value) : "바꿀 때 드는 비용은 미리 셀 수 없습니다.",
        "되돌리려면 영역 모델을 다시 바꾸면 됩니다.",
      ].join(" "),
      run: async () => {
        const set = await context.services.features().areaMain.set({
          teamID: context.team.id,
          areaID: context.area.id,
          model: named,
          by: "user",
          ...(now ? { now } : {}),
        })
        if (!set.ok) return MainTools.answer(set)
        return {
          ok: true,
          text: `${context.area.name}: 영역 모델을 바꿨습니다.`,
          ...(set.opID === undefined ? {} : { opID: set.opID }),
        }
      },
    })
  },
  preset: async (context, input) => {
    if (input.preset === undefined) return { ok: false, text: "preset이 필요합니다(프리셋 이름이나 id)." }
    const model = context.area.main?.model ?? (await context.services.features().main.model(context.team.id))
    const found = await Targets.preset(context.services, { model, name: input.preset })
    if (!found.ok) return { ok: false, text: found.text }
    const preset = found.value.preset
    return plan(context, "preset", "area.preset", {
      text: [
        `${context.area.name} 영역 프리셋을 "${preset.name}"(으)로 바꿉니다. 담당 대화에 바로 적용됩니다.`,
        ...(found.value.heavy ? ["돈이 드는 대상이나 적극적 위임이 있는 프리셋입니다."] : []),
        "되돌리려면 프리셋을 다시 바꾸면 됩니다.",
      ].join(" "),
      run: async () => {
        const set = await context.services
          .features()
          .areaMain.preset({ teamID: context.team.id, areaID: context.area.id, presetID: preset.id })
        if (!set.ok) return MainTools.answer(set)
        return { ok: true, text: `${context.area.name}: 영역 프리셋을 "${preset.name}"(으)로 바꿨습니다.` }
      },
    })
  },
  paths: async (context, input) => {
    const dirs = input.dirs ?? []
    if (dirs.length === 0) return { ok: false, text: "dirs가 필요합니다(가져올 큰 파일 폴더)." }
    const fetch = (by: OwnTeam.Op["by"]) => async () => {
      const started = await PathsOp.start(context.services, {
        teamID: context.team.id,
        areaID: context.area.id,
        add: dirs,
        by,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      if (!started.ok) return MainTools.answer(started)
      return {
        ok: true,
        text: `${context.area.name}: 큰 파일 폴더 ${dirs.join(", ")}을(를) 가져옵니다. 크면 사용자 확인을 먼저 받습니다.`,
        opID: started.opID,
      }
    }
    if (!Direct.kept(context.area)) return fetch("main")()
    return plan(context, "paths", "area.paths", {
      text: `${context.area.name}은(는) ${cause(context.area)}. 승인하면 큰 파일 폴더 ${dirs.join(", ")}을(를) 이 영역 폴더로 가져옵니다(크면 확인을 한 번 더 받습니다). 필요 없어지면 내려놓을 수 있습니다.`,
      run: fetch("user"),
    })
  },
  role: (context, input) => role(context, input),
  keep: (context) => keep(context, true),
  unkeep: (context) => keep(context, false),
  cancel: async (context, input) => {
    const admit = context.services.features().admit
    if (input.request !== undefined) {
      const dispatchID = Option.getOrUndefined(decodeDispatch(input.request.trim()))
      if (dispatchID === undefined) return { ok: false, text: `그런 메인 요청이 없습니다: ${input.request}` }
      const cancelled = await admit.cancel({ teamID: context.team.id, areaID: context.area.id, dispatchID })
      if (!cancelled.ok) return MainTools.answer(cancelled)
      return { ok: true, text: `${context.area.name}: 대기함의 메인 요청 1개를 지웠습니다.` }
    }
    const cancelled = await admit.cancelAll({ teamID: context.team.id, areaID: context.area.id })
    const queued = await clearQueued(context.services, context.area)
    return {
      ok: true,
      text: `${context.area.name}: 대기함의 메인 요청 ${cancelled.length}개, 대화에 아직 들어가지 않은 메인 요청 ${queued}개를 지웠습니다.`,
      cancelled: cancelled.length,
      queued,
    }
  },
}

/**
 * 메인에게 넘기기 (direct work, 2026-11-14) by `resume` on an area held by direct work with Main 멈춤 off. The owner hands it
 * back at once in a run the user opened in its conversation (the user is right there); otherwise the user's next
 * message there approves the plan. The main takes it back at once only when its run was opened by the user and the
 * user wrote to it after the user's last direct message (whether the user asked for it rests on the prompt);
 * otherwise a plan. The main's answer is the hand-back line (the stretch summary and where its whole reports are).
 */
async function handBack(context: Context): Promise<MainTools.Reply> {
  const area = context.area
  const direct = context.services.features().direct
  const end = async (why: "handed" | "taken"): Promise<MainTools.Reply> => {
    const ended = await direct.end({ teamID: context.team.id, areaID: area.id, why })
    if (ended === undefined) return { ok: false, text: NOTHING_HELD(area.name) }
    if (why === "taken") return { ok: true, text: ended.line }
    return {
      ok: true,
      text: `${area.name}: 메인에게 넘겼습니다. 기다리던 메인 요청 ${ended.waiting}개가 폴더가 쉴 때 하나씩 들어옵니다.`,
    }
  }
  if (context.by === "auto") {
    if ((await VoicePlan.backed(context.services, context.voice, "prompt")) === "ok") return end("handed")
    return plan(context, "resume", "area.pause", {
      text: `${area.name}: 직접 작업을 마치고 메인에게 넘깁니다.`,
      run: () => end("handed"),
    })
  }
  const spoke = direct.spoke(context.team.id) > (area.directWork?.at ?? 0)
  if (spoke && (await VoicePlan.backed(context.services, context.voice, "prompt")) === "ok") return end("taken")
  const waiting = (await context.services.registry.dispatches.waiting(context.team.id, area.id)).filter(
    Fold.request,
  ).length
  return plan(context, "resume", "area.pause", {
    text: [
      `${area.name}: 사용자가 직접 작업 중인 영역을 메인이 넘겨받습니다.`,
      waiting > 0 ? `대기함의 메인 요청 ${waiting}개가 폴더가 쉴 때 하나씩 들어갑니다.` : "대기함은 비어 있습니다.",
    ].join(" "),
    run: () => end("taken"),
  })
}

/**
 * 역할 바꾸기 (`team_area{role}`, 2026-11-14, AL-7): the area's whole new role, what it covers from now on. The plan
 * prints the old and the new text whole.
 *
 *   main, a run the user opened, a main-made area, not held          at once
 *   main, a run the user did not open, or an area the user set up      plan
 *   main, an area under Main 멈춤 or direct work                       refused unless the user wrote this turn (then
 *                                                                      as above)
 *   owner, a run the user opened there, a main-made area               at once (the user is in that conversation)
 *   owner, an area the user set up or a run the user did not open      plan (`scope` → the device cannot approve)
 *
 * Peers are refused before (they relay). The change reaches the owner at once and leaves the work alone
 * (`AreaEditRpc.edit`).
 */
async function role(context: Context, input: typeof Input.Type): Promise<MainTools.Reply> {
  const text = JudgeValidate.clean(input.role ?? "", Number.POSITIVE_INFINITY)
  if (text === "") return { ok: false, text: ROLE_EMPTY }
  if (text.length > JudgeValidate.LIMITS.goal) return { ok: false, text: ROLE_LONG(text.length) }
  const area = context.area
  if (text === area.goal) return { ok: true, text: ROLE_SAME(area.name) }
  const edit = async (): Promise<MainTools.Reply> => {
    const edited = await AreaEditRpc.edit(context.services, {
      teamID: context.team.id,
      areaID: area.id,
      goal: text,
      by: context.by === "main" ? "main" : "owner",
    })
    if (!edited.ok) return MainTools.answer(edited)
    return { ok: true, text: `'${area.name}' 영역의 역할을 바꿨습니다. 담당 대화에 바로 알렸습니다.` }
  }
  const planned = {
    text: [
      `'${area.name}' 영역이 맡는 일을 바꿉니다.`,
      `지금: "${area.goal.trim() === "" ? "(없음)" : area.goal}"`,
      `바뀐 뒤: "${text}"`,
      "담당 대화에 바로 알리고, 하던 일과 대기함은 그대로입니다. 다시 바꾸면 되돌릴 수 있습니다.",
    ].join("\n"),
    run: edit,
  }
  if (context.by === "auto") {
    // An owner: the user who asks is in this conversation. A run the user opened here is enough, except on an area
    // the user set up, whose scope changes keep the plan.
    const backed = await VoicePlan.backed(context.services, context.voice, "admin")
    if (backed === "scope") return { ok: false, text: VoicePlan.needsPc("admin") }
    if (backed === "ok" && area.userMade === undefined) return edit()
    return plan(context, "role", "area.edit", planned)
  }
  const asked = await told(context)
  if (Direct.kept(area) && !asked) return { ok: false, text: ROLE_HELD(area.name) }
  if (area.userMade !== undefined || !asked) return plan(context, "role", "area.edit", planned)
  return edit()
}

/**
 * 내가 정한 영역 (`team_area{keep | unkeep}`, 2026-11-17, L12): the mark of an area the team already has, as the area
 * menu's toggle sets it (`area.edit{userMade}`). Marking only protects the area (no `끝낼 수 있음`, its structure
 * changes wait for the user) and leaves its work alone, so a held area takes it too:
 *
 *   keep    main in a run the user opened, owner in a run the user opened there    at once
 *           otherwise                                                              plan
 *   unkeep  always a plan: the mark is the user's, and without it the main may restructure the area
 *
 * An owner whose run came from a device without `admin` is told to use the PC, as for `role`.
 */
async function keep(context: Context, on: boolean): Promise<MainTools.Reply> {
  const area = context.area
  const marked = area.userMade !== undefined
  if (on && marked) return { ok: true, text: KEPT_ALREADY(area.name) }
  if (!on && !marked) return { ok: true, text: UNKEPT_ALREADY(area.name) }
  const edit = async (): Promise<MainTools.Reply> => {
    const edited = await AreaEditRpc.edit(context.services, {
      teamID: context.team.id,
      areaID: area.id,
      userMade: on,
      by: context.by === "main" ? "main" : "owner",
    })
    if (!edited.ok) return MainTools.answer(edited)
    return { ok: true, text: on ? KEPT(area.name) : UNKEPT(area.name) }
  }
  const planned = {
    text: on
      ? `'${area.name}'을(를) 사용자가 정한 영역으로 표시합니다. 끝내자는 제안이 붙지 않고, 팀 메인이 이름을 바꾸거나 나누거나 묶거나 끝내기 전에 사용자의 답을 받습니다. 영역 메뉴의 '내가 정한 영역'으로 다시 끌 수 있습니다.`
      : `'${area.name}'에서 사용자가 정한 영역 표시를 뺍니다. 그 뒤로는 팀 메인이 이 영역의 이름 바꾸기·나누기·묶기를 묻지 않고 할 수 있고, 7일 동안 바뀐 것이 없으면 끝내자는 제안이 붙을 수 있습니다. 영역 메뉴의 '내가 정한 영역'으로 다시 켤 수 있습니다.`,
    run: edit,
  }
  const action = on ? "keep" : "unkeep"
  if (context.by === "auto") {
    const backed = await VoicePlan.backed(context.services, context.voice, "admin")
    if (backed === "scope") return { ok: false, text: VoicePlan.needsPc("admin") }
    if (on && backed === "ok") return edit()
    return plan(context, action, "area.edit", planned)
  }
  if (on && (await told(context))) return edit()
  return plan(context, action, "area.edit", planned)
}

/**
 * The main's run was opened by the user's own message, written after the user's last direct message in the area. It
 * says nothing of what the user asked: that a scope change was asked for rests on the prompt.
 */
async function told(context: Context) {
  const directWork = context.area.directWork
  if (directWork !== undefined && context.services.features().direct.spoke(context.team.id) <= directWork.at)
    return false
  return (await VoicePlan.backed(context.services, context.voice, "admin")) === "ok"
}

/** Why a kept area's action waits for the user (TI-13), for a plan's first sentence. */
function cause(area: OwnTeam.Area) {
  return Direct.live(area) ? "직접 작업 중입니다" : "메인 멈춤 중입니다"
}

/** Why `area.main` changes nothing else of the conversation, or what it does (06 §10.1). */
function how(current: Model.Ref | undefined, target: Model.Ref, now: boolean) {
  if (current !== undefined && current.providerID !== target.providerID && !now)
    return "계정이 바뀌므로 담당은 다음 안전 지점에서 새 대화로 이어 가고, 옛 대화는 보관됩니다."
  return "담당 대화는 지금 대화에서 바뀝니다."
}

const decodeDispatch = Schema.decodeUnknownOption(OwnTeam.DispatchID)

/** The 02 switch reason of the cost estimate: the user's own change. */
const MANUAL: Switch.Reason = "manual"

/** own.accounts errors that say the model or its account is not there. */
const MISSING: ReadonlySet<string> = new Set(["account_not_found", "no_eligible_target", "slot_misconfigured"])

/**
 * `[담당 대기열의 메인 요청 n개 지우기]` (3.8): the main requests still undelivered in the owner's queue and in the queues
 * of the area's attached peers; nothing else of those queues.
 */
async function clearQueued(services: Services.Context, area: OwnTeam.Area) {
  const sessions = [
    ...(area.owner.sessionID === null ? [] : [area.owner.sessionID]),
    ...Peers.of(area).flatMap((peer) => (peer.attached ? [peer.sessionID] : [])),
  ]
  const counts = await Promise.all(
    sessions.map(async (sessionID) => {
      const listed = await services.http.inbox.list({ sessionID, directory: area.directory })
      if (!listed.ok) return 0
      const requests = listed.value.filter(
        (item) => item.type === "user" && item.payload.metadata?.[OwnTeam.DISPATCH_META] !== undefined,
      )
      const done = await Promise.all(
        requests.map((item) => services.http.inbox.cancel({ sessionID, directory: area.directory, inboxID: item.id })),
      )
      return done.filter((result) => result.ok).length
    }),
  )
  return counts.reduce((total, count) => total + count, 0)
}

function plan(
  context: Context,
  action: Action,
  method: OwnTeam.MethodName,
  input: { readonly text: string; readonly run: () => Promise<MainTools.Reply> },
) {
  return VoicePlan.issue(context.services, context.voice, { tool: NAME, action, method, ...input })
}
