export * as DispatchTool from "./dispatch.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import { Peers } from "../sessions/peer.js"
import { MainTools } from "./main.js"

/**
 * `team_dispatch{area, text, task?, fresh?, member?}` (06 §2.8, §5.1): a main request to an area's owner, or with
 * `member` to one of the area's peers (동료, 2026-10-09, the user registers them; the main never guesses one). It goes
 * into the conversation as a queued user message only when the area folder is idle, one at a time for the whole folder;
 * otherwise it waits in the area's outbox. `fresh: true` (unrelated new work) continues the owner in a new conversation
 * first, so it never goes with `member`. Team main only.
 */

export const NAME = "dispatch"

export const DESCRIPTION =
  "Send a main request to an area's owner, or with member to one of the area's peers the user registered (team_status lists them). It starts when the area's folder is idle, one request at a time for the whole folder; otherwise it waits in the area's outbox. Use fresh: true only for work unrelated to what the owner conversation was doing (it then continues in a new conversation with a handoff; never with member). Result: {dispatchID, state: queued|waiting|refused, why?}."

export const Input = Schema.Struct({
  area: Schema.String.annotate({ description: "Area id, slug or name." }),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description: "The request, written for the owner.",
  }),
  task: optional(Schema.String.check(Schema.isMaxLength(200)).annotate({ description: "A short task label." })),
  fresh: optional(Schema.Boolean.annotate({ description: "Unrelated new work: start a new owner conversation." })),
  member: optional(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "An area peer (key or label) to send it to instead of the owner. Omit for the owner.",
    }),
  ),
})

export async function run(
  services: Services.Context,
  caller: MainTools.Caller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  const area = await MainTools.area(services, caller.team.id, input.area)
  if (!area) return { ok: false, text: MainTools.NO_AREA }
  const peer = input.member === undefined ? undefined : Peers.find(area, input.member)
  if (input.member !== undefined && !peer) return { ok: false, text: noPeer(area) }
  if (peer && input.fresh) return { ok: false, text: FRESH_PEER }
  const sent = await services.features().admit.dispatch({
    teamID: caller.team.id,
    areaID: area.id,
    text: input.text,
    from: "main",
    kind: "task",
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.fresh === undefined ? {} : { fresh: input.fresh }),
    ...(peer === undefined ? {} : { to: peer.key }),
  })
  if (!sent.ok) return MainTools.answer(sent)
  // The user works with the area directly: the main tells the user, or takes the area back when the user asked.
  if (sent.state === "waiting" && sent.direct)
    return { ok: true, text: WAITING_DIRECT(area.name), dispatchID: sent.dispatchID, state: sent.state, why: "paused" }
  const who = peer === undefined ? area.name : `${area.name} ${Peers.title(peer)}`
  const said =
    sent.state === "queued"
      ? peer === undefined
        ? "담당 대화에 넣었습니다."
        : "동료 대화에 넣었습니다."
      : sent.state === "refused"
        ? REFUSED
        : WAITING[sent.why ?? "busy"]
  return {
    ok: sent.state !== "refused",
    text: `${who}: ${said}`,
    dispatchID: sent.dispatchID,
    state: sent.state,
    ...(sent.why === undefined ? {} : { why: sent.why }),
  }
}

/** `member` named no peer of the area: the peers it has, or that it has none. */
function noPeer(area: OwnTeam.Area) {
  const peers = Peers.of(area)
  if (peers.length === 0)
    return `${area.name} 영역에는 동료가 없습니다. 동료는 사용자가 등록합니다. member 없이 담당에게 보내세요.`
  return `${area.name} 영역에 그런 동료가 없습니다. 동료: ${peers.map((peer) => `${peer.label}(${peer.key})`).join(", ")}`
}

const FRESH_PEER = "fresh는 담당 대화를 새로 시작하는 일이라 동료에게는 쓰지 않습니다. fresh 없이 보내세요."

const REFUSED =
  "보내지 않았습니다. 이 동료 대화는 팀 메인과 같은 회사의 다른 구독 계정을 씁니다. 사용자에게 알리고, 담당에게 맡기거나 사용자가 그 대화의 계정을 바꾼 뒤 다시 보내세요."

/** A request waits because the user works with the area's owner directly (2026-11-14, `dispatch/direct.ts`). */
export const WAITING_DIRECT = (area: string) =>
  `${area}: 사용자가 이 영역 담당과 직접 작업 중이라 대기함에서 기다립니다. 사용자에게 한 줄로 알리세요. 사용자가 그 영역을 넘겨받으라고 분명히 말할 때만 team_area(action:"resume")로 넘겨받으세요. 그 영역에 일을 시키라는 말만으로는 넘겨받지 않습니다.`

/** Why a request waits in the outbox (5.1), for the main. */
const WAITING: Readonly<Record<OwnTeam.WaitReason, string>> = {
  paused: "메인 멈춤이 켜져 있어 대기함에서 기다립니다. 사용자가 끄면 들어갑니다.",
  busy: "담당이나 그 폴더의 다른 대화가 일하는 중이라 대기함에서 기다립니다. 폴더가 쉬면 들어갑니다.",
  queued: "앞선 메인 요청이 담당이나 동료 대화에 아직 남아 있어 대기함에서 기다립니다. 차례대로 들어갑니다.",
  maintaining: "프로그램이 이 영역을 손보는 중이라 대기함에서 기다립니다. 끝나면 들어갑니다.",
  broken: "이 영역의 폴더를 지금 쓸 수 없어 대기함에서 기다립니다. 사용자가 고쳐야 들어갑니다.",
}
