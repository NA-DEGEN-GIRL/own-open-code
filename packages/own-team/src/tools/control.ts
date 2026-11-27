export * as ControlTool from "./control.js"

import { Option, Result, Schema, SchemaIssue } from "effect"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Direct } from "../dispatch/direct.js"
import { Confirm } from "../ops/confirm.js"
import { Disable } from "../ops/disable.js"
import { TeamHome } from "../ops/home.js"
import { ReorgOps } from "../ops/reorg.js"
import { TeamSettings } from "../ops/settings.js"
import { Fold } from "../report/fold.js"
import type { Services } from "../services.js"
import { Peers } from "../sessions/peer.js"
import { Seat } from "../sessions/seat.js"
import { MainTools } from "./main.js"
import { ReorganizeTool } from "./reorganize.js"
import { Targets } from "./targets.js"
import { VoicePlan } from "./voice.js"

/**
 * `team_control{action, …}` (06 §2.9): the team-wide buttons the user may ask the team main for in plain language.
 * Team main only. Most are plans (`tools/voice.ts`) that run by the user after the user's next message; the scope of
 * each is its button's RPC method's (`OwnTeamRouting.MethodScope`), so a device's answer counts only where its button
 * would (`local` ones only on the PC):
 *
 *   pause_all    모두 멈추기                         at once                 (team.pause, prompt)
 *   resume_all   다시 시작                           plan                    (team.pause, prompt)
 *   main_rotate  메인 새 대화                        at once, by main        (main.rotate, prompt)
 *   unadopt      팀에서 빼기                         plan                    (area.unadopt, admin)
 *   disable      팀 모드 끄기 / 끝난 영역 정리하고 끄기 plan, the areas named  (disable, admin)
 *   home         메인 폴더 [바꾸기]                  plan                    (team.home, admin)
 *   undo         되돌리기 (an op, an area's integration, or the last op) plan  (op.undo / integration.undo, admin)
 *   move         대화 옮기기…                        plan                    (reorg.apply, admin)
 *   account      팀 계정 바꾸기 → [끝나면 바꾸기]       plan from the dry run   (team.account, switch)
 *   push         원격에 올리기… / 검토 요청 올리기…   plan wrapping the push nonce (integration.push.execute, local)
 *   settings     팀 설정                             plan, old → new per key (settings.set, local)
 *   answer       a step confirm: skip at once; do a plan wrapping the step nonce (op.confirm, local)
 *   cancel       취소 of the op that waits (RH-20): a step's wait or its confirms   plan            (op.cancel, prompt);
 *                with `area`, or when no op runs, 되돌리기 취소 of an integration undo that waits (RH-42)
 *                                                                             plan  (integration.undo.cancel, prompt)
 *   peer_add     동료 추가… at once (a plan on an area the user set up, 2026-10-26); 동료로 등록… (an existing
 *                conversation) a plan (area.peer.add, admin)
 *   peer_edit    역할 바꾸기…                        plan                    (area.peer.edit, admin)
 *   peer_remove  동료에서 빼기                       plan                    (area.peer.remove, admin)
 *   seat         이 대화를 담당으로 (a conversation by id or title, or a peer by key or label)
 *                                                    plan                    (area.seat, admin)
 *
 * Targets are found when the plan is made and bound to it (06 §2.9 대상 찾기); no answer holds an inner nonce.
 */

export const NAME = "control"

export const DESCRIPTION = [
  "Team actions the user asks for: pause all, undo, push, settings, confirm, disable, main folder, move, peers, owner seat.",
  "pause_all / resume_all: 모두 멈추기 / 다시 시작. main_rotate: the team main continues in a new conversation.",
  "unadopt {area}, disable {cleanup?}, home {directory}, undo {op? or area?}, move {session, area}, account {model}.",
  "push {area?, pr?}: push the last integration, or open a review request. settings {settings: {policy?, patterns?}}.",
  "answer {choice: do|skip, step?}: a confirm the running op waits for (team_status detail lists them). cancel {op?}: cancel the op that waits.",
  "peer_add {area, label, role?, session?} (without session: a new peer at once), peer_edit {area, peer, label?, role?}, peer_remove {area, peer}.",
  "seat {area, session or peer}: 이 대화를 담당으로 — an existing conversation of the area's folder, or a peer, becomes its owner.",
  "Every action but pause_all, main_rotate, answer skip and a new peer returns a plan: show it, and call again with token only after the user's next message.",
].join("\n")

export const Input = Schema.Struct({
  action: Schema.Literals([
    "pause_all",
    "resume_all",
    "main_rotate",
    "unadopt",
    "disable",
    "home",
    "undo",
    "move",
    "account",
    "push",
    "settings",
    "answer",
    "cancel",
    "peer_add",
    "peer_edit",
    "peer_remove",
    "seat",
  ]),
  area: optional(Schema.String.annotate({ description: "Area id, slug or name." })),
  cleanup: optional(Schema.Boolean),
  directory: optional(Schema.String),
  op: optional(Schema.String),
  pr: optional(Schema.Boolean),
  model: optional(Schema.String.annotate({ description: "provider/model or provider/model#effort." })),
  settings: optional(Schema.Record(Schema.String, Schema.Unknown)),
  choice: optional(Schema.Literals(["do", "skip"])),
  step: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  session: optional(Schema.String),
  peer: optional(Schema.String),
  label: optional(Schema.String),
  role: optional(Schema.String),
  token: optional(Schema.String),
})

type Input = typeof Input.Type
type Action = Input["action"]

interface Context {
  readonly services: Services.Context
  readonly team: OwnTeam.Team
  readonly voice: VoicePlan.Caller
}

export async function run(
  services: Services.Context,
  caller: MainTools.Caller,
  input: Input,
): Promise<MainTools.Reply> {
  const voice = { sessionID: caller.sessionID, directory: caller.team.home.directory }
  if (input.token !== undefined)
    return VoicePlan.redeem(services, voice, { tool: NAME, action: input.action, token: input.token })
  return ACTIONS[input.action]({ services, team: caller.team, voice }, input)
}

const ACTIONS: { readonly [K in Action]: (context: Context, input: Input) => Promise<MainTools.Reply> } = {
  pause_all: async (context) => {
    const paused = await context.services.features().pause.team({ teamID: context.team.id, on: true })
    if (!paused.ok) return MainTools.answer(paused)
    return {
      ok: true,
      text: "모두 멈췄습니다. 일하던 담당과 동료는 멈추고, 새 메인 요청은 대기함에서 기다립니다. 다시 시작하면 이어집니다.",
    }
  },
  resume_all: async (context) => {
    const areas = (await context.services.registry.areas.list(context.team.id)).filter(
      (area) => area.state !== "retired" && area.paused === "all",
    )
    if (areas.length === 0) return { ok: false, text: "모두 멈추기가 켜져 있지 않습니다." }
    return plan(context, "resume_all", "team.pause", {
      text: `모두 멈추기를 풉니다. 영역 ${areas.length}개(${names(areas)})의 대기함이 다시 흐릅니다. 사용자가 영역마다 켠 메인 멈춤은 그대로입니다.`,
      run: async () => {
        const resumed = await context.services.features().pause.team({ teamID: context.team.id, on: false })
        if (!resumed.ok) return MainTools.answer(resumed)
        return { ok: true, text: "다시 시작했습니다." }
      },
    })
  },
  main_rotate: async (context) => {
    const started = await context.services.features().rotate.main({ teamID: context.team.id, by: "main" })
    if (!started.ok) return MainTools.answer(started)
    return {
      ok: true,
      text: "메인 새 대화를 시작합니다. 이 차례가 끝나면 새 메인 대화로 바뀌고 이 대화는 보관됩니다. 팀과 영역은 그대로 이어집니다.",
      opID: started.opID,
    }
  },
  unadopt: async (context, input) => {
    const area = await named(context, input)
    if (!area.ok) return area.reply
    if (area.value.origin !== "adopted")
      return {
        ok: false,
        text: "팀에서 빼기는 팀에 넣은 폴더에만 씁니다. 영역을 끝내려면 team_reorganize의 retire를 쓰세요.",
      }
    return plan(context, "unadopt", "area.unadopt", {
      text: `${area.value.name}을(를) 팀에서 뺍니다. 작업 폴더, 저장 지점, 대화는 그대로 남고, 대기함의 메인 요청은 보내지 않습니다. 다시 넣으려면 팀에 넣기를 쓰면 됩니다.`,
      run: async () => {
        const started = await context.services
          .features()
          .adopt.unadopt({ teamID: context.team.id, areaID: area.value.id })
        if (!started.ok) return MainTools.answer(started)
        return { ok: true, text: `${area.value.name}을(를) 팀에서 빼는 중입니다.`, opID: started.opID }
      },
    })
  },
  disable: async (context, input) => {
    const [areas, waiting, finished] = await Promise.all([
      context.services.registry.areas.list(context.team.id),
      context.services.registry.dispatches.waiting(context.team.id),
      input.cleanup === true ? Disable.finished(context.services, context.team) : Promise.resolve([]),
    ])
    const active = areas.filter((area) => area.state !== "retired")
    const ids = finished.map((area) => area.id)
    return plan(context, "disable", "disable", {
      text: [
        `팀 모드를 끕니다. 영역 ${active.length}개의 작업 폴더·저장 지점·대화는 그대로 남고, 대기함의 메인 요청 ${waiting.filter(Fold.request).length}개는 보내지 않습니다.`,
        ...(input.cleanup !== true
          ? []
          : finished.length === 0
            ? ["끝난 영역이 없어 끝내는 영역 없이 끕니다."]
            : [
                `먼저 끝난 영역 ${names(finished)}을(를) 끝냅니다(폴더를 지우는 확인은 따로 묻습니다). 영역 끝내기는 되돌릴 수 없지만 저장 지점과 대화는 남습니다.`,
              ]),
        "다시 켜면 같은 팀으로 이어 갑니다.",
      ].join(" "),
      run: async () => {
        const started = await Disable.start(context.services, {
          teamID: context.team.id,
          ...(input.cleanup === true ? { cleanup: true, areas: ids } : {}),
        })
        if (!started.ok) return MainTools.answer(started)
        return { ok: true, text: "팀 모드를 끄는 중입니다. 결과는 화면의 결과 카드에 나옵니다.", opID: started.opID }
      },
    })
  },
  home: async (context, input) => {
    const directory = input.directory?.trim()
    if (!directory) return { ok: false, text: "directory가 필요합니다(새 메인 폴더의 경로)." }
    return plan(context, "home", "team.home", {
      text: `메인 폴더를 ${directory}(으)로 바꿉니다. 메인 대화가 그 폴더로 옮겨 가고 폴더 잠금이 바뀝니다. 결과 카드의 되돌리기로 되돌릴 수 있습니다.`,
      run: async () => {
        const started = await TeamHome.start(context.services, { teamID: context.team.id, directory })
        if (!started.ok) return MainTools.answer(started)
        return { ok: true, text: "메인 폴더를 바꾸는 중입니다.", opID: started.opID }
      },
    })
  },
  undo: async (context, input) => {
    if (input.area !== undefined) {
      const area = await named(context, input)
      if (!area.ok) return area.reply
      const integration = await Targets.integrated(context.services, context.team.id, area.value.id)
      if (!integration) return { ok: false, text: `${area.value.name}: 되돌릴 반영이 없습니다.` }
      return plan(context, "undo", "integration.undo", {
        text: `${area.value.name}의 마지막 반영(저장 지점 ${short(integration.candidate ?? integration.source)})을 되돌립니다. 프로젝트 본 코드가 반영 전으로 돌아갑니다. 그 뒤에 본 코드가 더 바뀌었으면 되돌리지 않고 메인에게 맡깁니다.`,
        run: async () => {
          const started = await context.services
            .features()
            .integrate.undo({ integrationID: integration.id, by: "user" })
          if (!started.ok) return MainTools.answer(started)
          return { ok: true, text: `${area.value.name}의 반영을 되돌리는 중입니다.`, opID: started.opID }
        },
      })
    }
    const op = await undoable(context, input.op)
    if (!op.ok) return op.reply
    return plan(context, "undo", "op.undo", {
      text: `"${Targets.opWord(op.value.kind)}" 작업(${op.value.id})을 되돌립니다. 그 작업이 바꾼 것을 되돌리고, 되돌리기 자체는 다시 되돌리지 않습니다.`,
      run: async () => {
        const started = await context.services.features().undo.start({ opID: op.value.id, by: "user" })
        if (!started.ok) return MainTools.answer(started)
        return { ok: true, text: "되돌리는 중입니다.", opID: started.opID }
      },
    })
  },
  move: async (context, input) => {
    if (input.session === undefined) return { ok: false, text: "session이 필요합니다(옮길 대화의 id나 제목)." }
    const area = await named(context, input)
    if (!area.ok) return area.reply
    const session = await Targets.session(context.services, context.team, input.session)
    if (!session.ok) return { ok: false, text: session.text }
    return plan(context, "move", "reorg.apply", {
      text: `대화 "${session.value.title}"(${session.value.id})을(를) ${area.value.name} 영역 폴더(${area.value.directory})로 옮깁니다. 결과 카드의 되돌리기로 되돌릴 수 있습니다.`,
      run: async () => {
        const applied = await ReorgOps.apply(context.services, {
          teamID: context.team.id,
          proposal: { version: 1, ops: [{ op: "move", sessionID: session.value.id, area: area.value.id }] },
          by: "user",
        })
        if (applied.ok) return { ok: true, text: "대화를 옮기는 중입니다.", opID: applied.op.id }
        if (applied.error === "invalid_proposal")
          return {
            ok: false,
            error: applied.error,
            text: `옮기지 못했습니다: ${applied.data.rejected.map((item) => item.why).join(", ")}`,
          }
        return MainTools.answer(applied)
      },
    })
  },
  account: async (context, input) => {
    const target = input.model === undefined ? undefined : Targets.ref(input.model)
    if (target === undefined) {
      const used = await Targets.inUse(context.services, context.team)
      return {
        ok: false,
        text: `model이 필요합니다(provider/model 또는 provider/model#effort). 팀이 쓰는 모델: ${used.join(", ") || "없음"}`,
      }
    }
    const dry = await context.services.features().areaMain.account({ teamID: context.team.id, target, dryRun: true })
    if (!dry.ok) return MainTools.answer(dry)
    if (!("plan" in dry)) return { ok: false, text: "팀 계정 바꾸기를 미리 보지 못했습니다." }
    const areas = await context.services.registry.areas.list(context.team.id)
    const name = (areaID: OwnTeam.AreaID) => areas.find((area) => area.id === areaID)?.name ?? areaID
    const moved = dry.plan.areas.filter((item) => item.rotate)
    const busy = dry.plan.areas.filter((item) => item.busy)
    return plan(context, "account", "team.account", {
      text: [
        `팀 계정을 ${Targets.refText(target)}(으)로 바꿉니다: 팀 메인과 "팀과 같게"인 영역이 따라옵니다.`,
        moved.length > 0 ? `새 대화로 이어 가는 영역: ${moved.map((item) => name(item.areaID)).join(", ")}.` : "",
        busy.length > 0 || dry.plan.busy.sessions > 0
          ? "지금 일하는 대화는 그 일이 끝난 뒤에 바꿉니다."
          : "지금 일하는 대화가 없어 바로 바꿉니다.",
        dry.plan.estimate === null ? "" : Targets.cost(dry.plan.estimate),
        dry.plan.r4.length > 0 ? `팀 규칙에 어긋나 고쳐야 할 프리셋이 ${dry.plan.r4.length}개 생깁니다.` : "",
        "되돌리려면 팀 계정을 다시 바꾸면 됩니다.",
      ]
        .filter(Boolean)
        .join(" "),
      run: async () => {
        const started = await context.services
          .features()
          .areaMain.account({ teamID: context.team.id, target, mode: "after-idle" })
        if (!started.ok) return MainTools.answer(started)
        return {
          ok: true,
          text: "팀 계정을 바꾸는 중입니다. 일하던 대화는 끝난 뒤에 바뀝니다.",
          ...("opID" in started ? { opID: started.opID } : {}),
        }
      },
    })
  },
  push: async (context, input) => {
    const area = input.area === undefined ? undefined : await named(context, input)
    if (area && !area.ok) return area.reply
    const integration = await Targets.integrated(context.services, context.team.id, area?.value.id)
    if (!integration) return { ok: false, text: "올릴 반영이 없습니다. 먼저 프로젝트 본 코드에 반영하세요." }
    const integrate = context.services.features().integrate
    const planned = await integrate.plan({
      integrationID: integration.id,
      ...(input.pr === undefined ? {} : { pr: input.pr }),
    })
    if (!planned.ok) return MainTools.answer(planned)
    // The push nonce stays in this closure: no answer shows it.
    const nonce = planned.nonce
    return plan(context, "push", "integration.push.execute", {
      text: `${input.pr === true ? "검토 요청을 올립니다" : "원격 저장소에 올립니다"}: ${planned.remote} ${planned.ref}. 실행할 명령: ${planned.commands.join(" · ")}. 올린 것은 되돌리지 않습니다(원격에서 지워야 합니다).`,
      expiresAt: planned.expiresAt,
      run: async () => {
        const started = await integrate.push({ nonce })
        if (started.ok) return { ok: true, text: "올리는 중입니다. 결과는 결과 카드에 나옵니다.", opID: started.opID }
        if (started.error === "nonce_invalid")
          return { ok: false, error: started.error, text: "올리기 계획이 끝났습니다. 다시 계획하세요." }
        return MainTools.answer(started)
      },
    })
  },
  settings: async (context, input) => {
    const decoded = decodePatch(input.settings ?? {})
    if (Result.isFailure(decoded))
      return {
        ok: false,
        text: `설정을 읽지 못했습니다: ${SchemaIssue.makeFormatterDefault()(decoded.failure.issue)}`,
      }
    const patch = decoded.success
    // 팀 지시문 is edited on its own screen, where the user sees the whole text (2026-11-14).
    if (patch.instructions !== undefined) return { ok: false, text: INSTRUCTIONS_REFUSED }
    // Before = what own reads: an absent new key is its default.
    const current = new Map<string, unknown>([
      ...Object.entries(context.team.policy),
      ["directHold", Direct.hold(context.team)],
      ["directTell", Direct.tell(context.team)],
    ])
    const changes = [
      ...Object.entries(patch.policy ?? {}).flatMap(([key, value]) => {
        const before = current.get(key)
        return value === undefined || value === before ? [] : [`${key}: ${String(before)} → ${String(value)}`]
      }),
      ...(patch.patterns === undefined || patch.patterns.join("\n") === context.team.patterns.join("\n")
        ? []
        : [`patterns: [${context.team.patterns.join(", ")}] → [${patch.patterns.join(", ")}]`]),
    ]
    if (changes.length === 0) return { ok: false, text: NO_CHANGE }
    return plan(context, "settings", "settings.set", {
      text: `팀 설정을 바꿉니다: ${changes.join("; ")}. 되돌리려면 설정을 다시 바꾸면 됩니다.`,
      run: async () => {
        const written = await TeamSettings.write(context.services, context.team.id, patch)
        if (!written.ok) return MainTools.answer(written)
        return { ok: true, text: "팀 설정을 바꿨습니다." }
      },
    })
  },
  answer: async (context, input) => {
    if (input.choice === undefined) return { ok: false, text: 'choice가 필요합니다("do" 또는 "skip").' }
    const op = await context.services.journal.active(context.team.id)
    const pending = op ? Confirm.pending(op) : []
    if (pending.length === 0) return { ok: false, text: "기다리는 확인이 없습니다." }
    const step = input.step ?? (pending.length === 1 ? 1 : undefined)
    const chosen = step === undefined ? undefined : pending[step - 1]
    if (!chosen)
      return { ok: false, text: `확인이 ${pending.length}개입니다. step(번호)으로 고르세요:\n${listed(pending)}` }
    // The step nonce stays in this closure: no answer shows it.
    const confirm = (choice: "do" | "skip") => async (): Promise<MainTools.Reply> => {
      const answered = await Targets.bounded(
        context.services,
        context.services.runner.confirm({ opID: chosen.opID, stepID: chosen.stepID, choice, nonce: chosen.nonce }),
        ReorganizeTool.WAIT_MS,
      )
      if (answered === undefined)
        return { ok: true, text: "답을 넘겼습니다. 단계는 아직 도는 중이며 결과는 팀 소식과 결과 카드로 옵니다." }
      if (answered.ok)
        return {
          ok: true,
          text: choice === "do" ? "확인에 답했고 단계가 돌았습니다." : "두었습니다(하지 않음).",
          opID: chosen.opID,
        }
      if (answered.error === "nonce_invalid")
        return {
          ok: false,
          error: answered.error,
          text: "확인이 다시 물어졌습니다(시간이 지났거나 목록이 바뀜). 새 확인으로 다시 계획하세요.",
        }
      return MainTools.answer(answered)
    }
    // 두기 does nothing: it needs no plan.
    if (input.choice === "skip") return confirm("skip")()
    return plan(context, "answer", "op.confirm", {
      text: `확인 "${chosen.text}"에 하기로 답합니다${Targets.size(chosen)}. 지우는 확인이면 지운 것은 되돌릴 수 없습니다.`,
      expiresAt: chosen.expiresAt,
      run: confirm("do"),
    })
  },
  cancel: async (context, input) => {
    if (input.area !== undefined) return undoCancel(context, input)
    const op =
      input.op === undefined
        ? await context.services.journal.active(context.team.id)
        : await context.services.journal.find(input.op.trim())
    // RH-42: no op runs, but an undo waits outside its op: that is what there is to cancel.
    if (!op && input.op === undefined) return undoCancel(context, input)
    if (!op || op.teamID !== context.team.id || (op.state !== "running" && op.state !== "waiting"))
      return { ok: false, text: "취소할 작업이 없습니다. team_status{detail: true}로 지금 도는 작업을 보세요." }
    const wait = op.steps.find((step) => step.state === "pending" && step.wait !== undefined)?.wait
    return plan(context, "cancel", "op.cancel", {
      text: `"${Targets.opWord(op.kind)}" 작업(${op.id})을 취소합니다${wait ? `(지금: ${wait.text})` : ""}. 남은 단계는 하지 않고, 이미 한 단계는 그대로 둡니다. 새 대화로 이어가기를 취소하면 그 메인 요청은 지금 담당 대화에 갑니다.`,
      run: async () => {
        const cancelled = await context.services.runner.cancel(op.id)
        if (!cancelled.ok) return MainTools.answer(cancelled)
        return { ok: true, text: "작업을 취소했습니다.", opID: op.id }
      },
    })
  },
  peer_add: async (context, input) => {
    const area = await named(context, input)
    if (!area.ok) return area.reply
    const label = input.label?.trim()
    if (!label) return { ok: false, text: "label이 필요합니다(동료의 화면 이름)." }
    const role = input.role ?? ""
    const peers = context.services.features().peers
    const create = async (): Promise<MainTools.Reply> => {
      const added = await peers.add({ teamID: context.team.id, areaID: area.value.id, create: { label, role } })
      if (!added.ok) return MainTools.answer(added)
      return {
        ok: true,
        text: `${area.value.name}에 동료 "${added.peer.label}"(${added.peer.key})을(를) 만들었습니다.`,
        peer: added.peer.key,
      }
    }
    // 동료 추가… (a new conversation): no plan (user decision 2026-10-09), unless the user set the area up
    // (`Area.userMade`, V-b (5), 2026-10-26): its conversations are the user's to add to.
    if (input.session === undefined && area.value.userMade !== undefined)
      return plan(context, "peer_add", "area.peer.add", {
        text: `사용자가 정한 영역 '${area.value.name}'에 새 동료 "${label}"을(를) 만듭니다. 새 대화는 영역 모델과 프리셋으로 시작하고, 동료에서 빼면 사용자의 대화로 남습니다.`,
        run: create,
      })
    // Direct work: the main does not reshape an area the user works in by itself (2026-11-15).
    if (input.session === undefined && Direct.live(area.value))
      return plan(context, "peer_add", "area.peer.add", {
        text: `사용자가 직접 작업 중인 영역 '${area.value.name}'에 새 동료 "${label}"을(를) 만듭니다. 새 대화는 영역 모델과 프리셋으로 시작하고, 동료에서 빼면 사용자의 대화로 남습니다.`,
        run: create,
      })
    if (input.session === undefined) return create()
    const session = await Targets.session(context.services, context.team, input.session)
    if (!session.ok) return { ok: false, text: session.text }
    const sessionID = Option.getOrUndefined(decodeSession(session.value.id))
    if (sessionID === undefined) return { ok: false, text: `그런 대화를 찾지 못했습니다: "${input.session}"` }
    return plan(context, "peer_add", "area.peer.add", {
      text: `대화 "${session.value.title}"(${session.value.id})을(를) ${area.value.name} 영역의 동료 "${label}"(으)로 등록합니다. 그 대화의 모델과 프리셋은 그대로이고, 첫 메인 요청 때 팀 도구와 동료 역할을 받습니다. 동료에서 빼면 원래 대화로 돌아갑니다.`,
      run: async () => {
        const added = await peers.add({ teamID: context.team.id, areaID: area.value.id, sessionID, label, role })
        if (!added.ok) return MainTools.answer(added)
        return {
          ok: true,
          text: `동료 "${added.peer.label}"(${added.peer.key})을(를) 등록했습니다.`,
          peer: added.peer.key,
        }
      },
    })
  },
  peer_edit: async (context, input) => {
    const found = await peerOf(context, input)
    if (!found.ok) return found.reply
    const area = found.value.area
    const peer = found.value.peer
    const label = input.label?.trim()
    if (label === undefined && input.role === undefined) return { ok: false, text: "바꿀 label이나 role이 필요합니다." }
    return plan(context, "peer_edit", "area.peer.edit", {
      text: [
        `${area.name}의 동료 "${peer.label}"을(를) 바꿉니다:`,
        label === undefined ? "" : `이름 "${peer.label}" → "${label}".`,
        input.role === undefined ? "" : `역할 "${peer.role}" → "${input.role.trim()}".`,
        "다시 바꾸면 되돌릴 수 있습니다.",
      ]
        .filter(Boolean)
        .join(" "),
      run: async () => {
        const edited = await context.services.features().peers.edit({
          teamID: context.team.id,
          areaID: area.id,
          key: peer.key,
          ...(label === undefined ? {} : { label }),
          ...(input.role === undefined ? {} : { role: input.role }),
        })
        if (!edited.ok) return MainTools.answer(edited)
        return { ok: true, text: `동료 "${peer.label}"을(를) 바꿨습니다.` }
      },
    })
  },
  peer_remove: async (context, input) => {
    const found = await peerOf(context, input)
    if (!found.ok) return found.reply
    const area = found.value.area
    const peer = found.value.peer
    return plan(context, "peer_remove", "area.peer.remove", {
      text: `${area.name}의 동료 "${peer.label}"을(를) 뺍니다. 그 대화는 사용자의 대화로 남고(팀 도구와 동료 역할만 뗌), 그 동료를 기다리던 메인 요청은 지웁니다. 다시 쓰려면 동료로 다시 등록하면 됩니다.`,
      run: async () => {
        const removed = await context.services
          .features()
          .peers.remove({ teamID: context.team.id, areaID: area.id, key: peer.key })
        if (!removed.ok) return MainTools.answer(removed)
        return { ok: true, text: `동료 "${peer.label}"을(를) 뺐습니다.` }
      },
    })
  },
  seat: async (context, input) => {
    const name = input.session ?? input.peer
    if (name === undefined)
      return {
        ok: false,
        text: "session이나 peer가 필요합니다(담당으로 삼을 대화의 id나 제목, 또는 동료의 key나 이름).",
      }
    const area = await named(context, input)
    if (!area.ok) return area.reply
    // `team_status` lists a peer by its label and key, never by its conversation: the registry has that.
    const asked = input.session === undefined ? await peerOf(context, input) : undefined
    if (asked?.ok === false) return asked.reply
    const session = await Targets.session(context.services, context.team, asked ? asked.value.peer.sessionID : name)
    if (!session.ok) return { ok: false, text: session.text }
    const sessionID = Option.getOrUndefined(decodeSession(session.value.id))
    if (sessionID === undefined) return { ok: false, text: `그런 대화를 찾지 못했습니다: "${name}"` }
    // Named by its id or title, the conversation may still be a peer: the plan says what the move takes from it.
    const peer = Peers.of(area.value).find((item) => item.sessionID === sessionID)
    // Refused here as the button's RPC refuses it; the op checks again when it starts and before it swaps.
    const able = await Seat.eligible(context.services, context.team, area.value, sessionID)
    if (!able.ok) return MainTools.answer(able)
    return plan(context, "seat", "area.seat", {
      text: `'${area.value.name}' 영역의 담당을 ${peer ? `동료 "${peer.label}"의 ` : ""}"${session.value.title}" 대화(${Targets.refText(able.ref)})로 바꿉니다. 지금 하는 일이 끝난 뒤에 바뀝니다.${peer ? " 그 대화는 담당이 되고 동료에서는 빠집니다." : ""}`,
      run: async () => {
        const started = await context.services
          .features()
          .seat.request({ teamID: context.team.id, areaID: area.value.id, sessionID, by: "user" })
        if (!started.ok) return MainTools.answer(started)
        return { ok: true, text: "담당 바꾸기를 시작했습니다.", opID: started.opID }
      },
    })
  },
}

type Named<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reply: MainTools.Reply }

/** The active area `input.area` names. */
async function named(context: Context, input: Input): Promise<Named<OwnTeam.Area>> {
  if (input.area === undefined) return { ok: false, reply: { ok: false, text: "area가 필요합니다." } }
  const area = await MainTools.area(context.services, context.team.id, input.area)
  if (!area) return { ok: false, reply: { ok: false, text: MainTools.NO_AREA } }
  return { ok: true, value: area }
}

/** The area peer `input.peer` names (its key or label) in `input.area`. */
async function peerOf(
  context: Context,
  input: Input,
): Promise<Named<{ readonly area: OwnTeam.Area; readonly peer: OwnTeam.Peer }>> {
  const area = await named(context, input)
  if (!area.ok) return area
  if (input.peer === undefined)
    return { ok: false, reply: { ok: false, text: "peer가 필요합니다(동료의 key나 이름)." } }
  const peer = Peers.find(area.value, input.peer)
  if (!peer) {
    const listed = Peers.of(area.value).map((item) => `${item.label}(${item.key})`)
    return {
      ok: false,
      reply: {
        ok: false,
        text: `${area.value.name}에 그런 동료가 없습니다. 동료: ${listed.join(", ") || "없음"}`,
      },
    }
  }
  return { ok: true, value: { area: area.value, peer } }
}

/** The op 되돌리기 takes: `opID`, else the team's last op when it can be undone and has ended (own-web's rule). */
async function undoable(context: Context, opID: string | undefined): Promise<Named<OwnTeam.Op>> {
  const refuse = (text: string): Named<OwnTeam.Op> => ({ ok: false, reply: { ok: false, text } })
  if (opID !== undefined) {
    const op = await context.services.journal.find(opID.trim())
    if (!op || op.teamID !== context.team.id) return refuse(`이 팀에 그런 작업이 없습니다: ${opID}`)
    return { ok: true, value: op }
  }
  const last = (await context.services.journal.list(context.team.id)).at(-1)
  if (!last || last.undo?.available !== true || last.state === "running")
    return refuse("되돌릴 수 있는 마지막 작업이 없습니다.")
  return { ok: true, value: last }
}

/**
 * 되돌리기 취소 (RH-42): the integration undo that waits outside its op, of `input.area` or else the team's only one, as
 * a plan (`integration.undo.cancel`).
 */
async function undoCancel(context: Context, input: Input): Promise<MainTools.Reply> {
  const area = input.area === undefined ? undefined : await named(context, input)
  if (area && !area.ok) return area.reply
  const waiting = await Targets.undoing(context.services, context.team.id, area?.value.id)
  const integration = waiting[0]
  if (!integration)
    return {
      ok: false,
      text: area
        ? `${area.value.name}: 기다리는 반영 되돌리기가 없습니다.`
        : "취소할 작업이 없습니다. team_status{detail: true}로 지금 도는 작업을 보세요.",
    }
  const areas = await context.services.registry.areas.list(context.team.id)
  const name = (areaID: OwnTeam.AreaID) => areas.find((item) => item.id === areaID)?.name ?? areaID
  if (waiting.length > 1)
    return {
      ok: false,
      text: `기다리는 반영 되돌리기가 ${waiting.length}개입니다. area로 고르세요: ${waiting.map((item) => name(item.areaID)).join(", ")}`,
    }
  const label = name(integration.areaID)
  return plan(context, "cancel", "integration.undo.cancel", {
    text: `${label}의 기다리는 반영 되돌리기를 취소합니다. 프로젝트 본 코드는 반영한 그대로 남고, 되돌리기를 기다리던 다른 반영이 이어집니다. 나중에 되돌리려면 되돌리기를 다시 하면 됩니다.`,
    run: async () => {
      const cancelled = await context.services.features().integrate.undoCancel({ integrationID: integration.id })
      if (!cancelled.ok) return MainTools.answer(cancelled)
      return { ok: true, text: `${label}의 반영 되돌리기를 취소했습니다.` }
    },
  })
}

/** `1. <text> (120 MB, 파일 3개)` per confirm, numbered from 1; never a nonce. */
function listed(pending: ReadonlyArray<OwnTeam.Confirm>) {
  return pending.map((item, index) => `${index + 1}. ${item.text}${Targets.size(item)}`).join("\n")
}

function names(areas: ReadonlyArray<Pick<OwnTeam.Area, "name">>) {
  return areas.map((area) => area.name).join(", ")
}

function short(sha: string) {
  return sha.slice(0, 8)
}

const decodePatch = Schema.decodeUnknownResult(OwnTeam.SettingsPatch)

/** The policy keys `team_control{settings}` changes, in the order its answer lists them, with their values. */
const POLICY_KEYS: Readonly<Record<keyof NonNullable<OwnTeam.SettingsPatch["policy"]>, string>> = {
  askDownloadBytes: "",
  askDiskBytes: "",
  mergeLocal: "(auto|ask)",
  commitDecisions: "",
  autoAllow: "",
  directHold: "(true|false)",
  directTell: "(none|judge|always)",
}

/** A patch that changes nothing (an older `maxAreas` is no key any more, so it lands here). */
export const NO_CHANGE = `바뀌는 설정이 없습니다. 쓸 수 있는 키: ${Object.entries(POLICY_KEYS)
  .map(([key, values]) => `${key}${values}`)
  .join(", ")}.`

export const INSTRUCTIONS_REFUSED = "지시문은 설정의 '팀 지시문' 화면에서만 고칩니다."
const decodeSession = Schema.decodeUnknownOption(SessionID)

function plan(
  context: Context,
  action: Action,
  method: OwnTeam.MethodName,
  input: { readonly text: string; readonly expiresAt?: number; readonly run: () => Promise<MainTools.Reply> },
) {
  return VoicePlan.issue(context.services, context.voice, { tool: NAME, action, method, ...input })
}
