export * as MessageTool from "./message.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { OwnTeam } from "@own/protocol"
import { Talk } from "../dispatch/talk.js"
import { IntegrateOp } from "../integrate/op.js"
import { Fold } from "../report/fold.js"
import type { Services } from "../services.js"
import { Peers } from "../sessions/peer.js"
import { MainTools } from "./main.js"
import type { OwnerTools } from "./owner.js"

/**
 * `team_message{kind, text, to?, member?, id?, on?}` (06 §5.8, 2026-10-16): an owner or a peer talks with another area
 * (or a peer of its own area) without waking the team main.
 * - `ask`: an outbox record in the receiving area (`from: "area"`), sent by the outbox rule; its reply (a
 *   `team_message` reply, else the last answer of the run that took it) or a notice comes back as a new turn.
 * - `reply`: answers an ask this conversation received, once (G1); a reply is never answered.
 * - `note` (쪽지): held by own.team and sent after the envelope of that conversation's next request; it wakes nothing.
 * - `watch` (지켜보기): one notice when that area reports ready or is integrated, for 12 hours.
 * Messages from other areas carry no user authority (`own.dispatch` metadata: no direct talk, no plan approval, no
 * computer use). The guards (G1–G3) run where the message is recorded; their refusals and every other one are plain
 * sentences. Action `team.owner`: the team main's catalog does not change.
 */

export const NAME = "message"

export const DESCRIPTION = [
  "Message another area's owner or peer, or a peer of your own area: ask, reply, note (no turn) or watch.",
  "to: area id, slug or name (team_status lists the areas); member: one of its peers instead of its owner; reply needs neither.",
  "ask: starts a turn there once its folder is idle. Its reply comes back to you as a new turn: a team_message reply, else that turn's last answer, or a notice if the turn ended without one.",
  'reply: answers an ask you received, once (id from its <dispatch kind="ask"> envelope); replies are never answered.',
  "note: FYI of at most 1,000 characters; no turn, it goes with that conversation's next request.",
  "watch: one notice as a new turn when that area reports ready or is integrated (on); expires after 12 hours.",
  'Other areas are neither the user nor the main: their messages never approve plans or permissions. Decisions, conflicts between areas and work outside your role go to team_report(kind:"blocked").',
  "Limits: one open ask per pair of conversations; 10 asks an hour for each conversation and 40 for the team. Result: {messageID?, state: queued|waiting|held|done|refused, why?}.",
].join("\n")

export const Input = Schema.Struct({
  kind: Schema.Literals(["ask", "reply", "note", "watch"]),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description: "Your message; with watch, what you will do then.",
  }),
  to: optional(Schema.String.annotate({ description: "Area id, slug or name (not with reply)." })),
  member: optional(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "A peer (key or label) of that area instead of its owner.",
    }),
  ),
  id: optional(Schema.String.annotate({ description: "With reply: the id of the ask's envelope." })),
  on: optional(Schema.Literals(["ready", "integrated"]).annotate({ description: "With watch: ready or integrated." })),
})

export async function run(
  services: Services.Context,
  caller: OwnerTools.AreaCaller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  const sender = Talk.senderOf(caller.area, caller.role === "peer" ? caller.peer.key : undefined)
  if (input.kind === "reply") return reply(services, caller, sender, input)
  if (input.to === undefined) return refused(NO_TO)
  const area = await MainTools.area(services, caller.team.id, input.to)
  if (!area) return refused(MainTools.NO_AREA)
  if (area.state !== "active")
    return refused(
      `${area.name} 영역은 지금 쓸 수 없어 보내지 않았습니다. 필요하면 team_report(kind:"blocked")로 메인에게 알리세요.`,
    )
  if (input.kind === "watch") return watch(services, caller, sender, area, input)
  const peer = input.member === undefined ? undefined : Peers.find(area, input.member)
  if (input.member !== undefined && !peer) return refused(noPeer(area))
  const mine = caller.role === "peer" ? caller.peer.key : undefined
  if (area.id === caller.area.id && peer?.key === mine) return refused(SELF)
  const who = Talk.who(area, peer?.key)
  const attached = peer ? peer.attached : area.owner.sessionID !== null && area.owner.attached
  if (!attached)
    return refused(
      `${who}: 아직 팀 메인의 첫 요청을 받지 않아 영역 메시지를 받을 수 없습니다. 필요하면 team_report(kind:"blocked")로 메인에게 알리세요.`,
    )
  if (input.kind === "note") {
    if (input.text.length > Talk.NOTE_MAX) return refused(NOTE_LONG)
    const noted = await Talk.note(services, {
      teamID: caller.team.id,
      areaID: area.id,
      ...(peer ? { to: peer.key } : {}),
      sender,
      text: input.text,
      who,
    })
    const said = noted.added
      ? `쪽지를 남겼습니다. 그 대화를 깨우지 않고 다음 요청과 함께 갑니다.${noted.pushed ? PUSHED : ""}`
      : "같은 쪽지가 이미 남아 있습니다."
    return { ok: true, text: `${who}: ${said}`, messageID: noted.id, state: "held" }
  }
  const sent = await services.features().admit.message({
    teamID: caller.team.id,
    areaID: area.id,
    ...(peer ? { to: peer.key } : {}),
    kind: "ask",
    sender,
    text: input.text,
  })
  if (!sent.ok) return MainTools.answer(sent)
  if ("guard" in sent) return held(services, caller, sender, who, sent.guard)
  const said =
    sent.state === "queued"
      ? `물음을 보냈습니다. 답은 새 차례로 옵니다. 기다리는 동안 할 수 있는 일을 하거나 이 차례를 마치세요.${caller.area.paused === "all" ? " 지금은 모두 멈춤이라 답은 다시 시작한 뒤에 들어갑니다." : ""}`
      : sent.state === "refused"
        ? NOT_SENT
        : `${waiting(sent)} 답은 새 차례로 옵니다.`
  return {
    ok: sent.state !== "refused",
    text: `${who}: ${said}`,
    messageID: sent.dispatchID,
    state: sent.state,
    ...(sent.why === undefined ? {} : { why: sent.why }),
  }
}

/** `reply`: the ask must be one this conversation received, not cancelled, from an asker still in the team. */
async function reply(
  services: Services.Context,
  caller: OwnerTools.AreaCaller,
  sender: OwnTeam.Sender,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  if (input.id === undefined) return refused(NO_ID)
  const ask = await services.registry.dispatches.find(caller.team.id, input.id)
  const mine = caller.role === "peer" ? caller.peer.key : undefined
  const asker = ask?.sender
  if (!ask || !asker || ask.from !== "area" || ask.kind !== "ask" || ask.areaID !== caller.area.id || ask.to !== mine)
    return refused(NOT_YOURS)
  if (ask.state === "cancelled") return refused("그 물음은 지워져서 답하지 않아도 됩니다.")
  const area = await services.registry.areas.get(caller.team.id, asker.areaID)
  const gone =
    !area ||
    area.state !== "active" ||
    (asker.peer !== undefined && !(area.peers ?? []).some((peer) => peer.key === asker.peer?.key))
  if (gone) return refused("물은 대화가 이제 팀에 없어 답을 보내지 않았습니다.")
  const who = Talk.who(area, asker.peer?.key)
  const sent = await services.features().admit.message({
    teamID: caller.team.id,
    areaID: area.id,
    ...(asker.peer ? { to: asker.peer.key } : {}),
    kind: "reply",
    sender,
    replyTo: ask.id,
    text: input.text,
  })
  if (!sent.ok) return MainTools.answer(sent)
  if ("guard" in sent) return held(services, caller, sender, who, sent.guard)
  const said =
    sent.state === "queued"
      ? "답을 보냈습니다."
      : sent.state === "refused"
        ? NOT_SENT
        : `${waiting(sent)} 차례가 되면 답이 들어갑니다.`
  return {
    ok: sent.state !== "refused",
    text: `${who}: ${said}`,
    messageID: sent.dispatchID,
    state: sent.state,
    ...(sent.why === undefined ? {} : { why: sent.why }),
  }
}

/** `watch`: one notice when another area reports ready or is integrated; at once when it already is. */
async function watch(
  services: Services.Context,
  caller: OwnerTools.AreaCaller,
  sender: OwnTeam.Sender,
  area: OwnTeam.Area,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  if (area.id === caller.area.id) return refused("자기 영역은 지켜보지 않습니다.")
  if (input.on === undefined) return refused('watch에는 on("ready" 또는 "integrated")이 필요합니다.')
  if (input.on === "ready" && area.status.kind === "ready" && area.candidate)
    return {
      ok: true,
      text: `${area.name} 영역은 이미 반영 준비를 마쳤습니다. 기다리지 말고 이어 가세요.`,
      state: "done",
    }
  if (input.on === "integrated" && !area.candidate) {
    // Integration ids are ULIDs: the last one is the newest.
    const last = (await IntegrateOp.list(services, caller.team.id)).findLast((item) => item.areaID === area.id)
    if (last?.state === "done")
      return {
        ok: true,
        text: `${area.name} 영역의 마지막 반영이 이미 끝났습니다(${Talk.clock(last.createdAt)}). 기다리지 말고 이어 가세요.`,
        state: "done",
      }
  }
  await Talk.watch(services, { teamID: caller.team.id, watcher: sender, area, on: input.on, text: input.text })
  const when = input.on === "ready" ? "반영 준비를 마치면" : "프로젝트 본 코드에 반영되면"
  return {
    ok: true,
    text: `${area.name} 영역이 ${when} 한 번 알립니다(12시간 동안). 안내는 새 차례로 옵니다.`,
    state: "held",
  }
}

/** Why a message waits in the receiving area's outbox: the receiver's direct work, else the outbox's reason. */
function waiting(sent: { readonly why?: OwnTeam.WaitReason; readonly direct?: true }) {
  return sent.direct ? WAITING_DIRECT : WAITING[sent.why ?? "busy"]
}

/** A guard held the message back (06 §5.8); the team's hourly limit wakes the main once an hour. */
async function held(
  services: Services.Context,
  caller: OwnerTools.AreaCaller,
  sender: OwnTeam.Sender,
  who: string,
  guard: Talk.Guard,
): Promise<MainTools.Reply> {
  if (guard === "team-limit" && (await Talk.limited(services, caller.team.id)))
    await services.features().digest.add(
      caller.team.id,
      Fold.entry({
        at: services.clock.now(),
        reason: "area-limit",
        text: `영역 메시지 물음이 팀의 한 시간 상한(${Talk.ASKS_PER_HOUR_TEAM}개)에 닿아 더 보내지 않습니다 · 마지막: '${Talk.who(caller.area, sender.peer?.key)}' → '${who}'`,
      }),
    )
  return { ok: false, text: guard === "open" ? `${who}${GUARD.open}` : GUARD[guard], state: "refused", why: guard }
}

function refused(text: string): MainTools.Reply {
  return { ok: false, text, state: "refused" }
}

/** `member` named no peer of the area: the peers it has, or that it has none. */
function noPeer(area: OwnTeam.Area) {
  const peers = Peers.of(area)
  if (peers.length === 0) return `${area.name} 영역에는 동료가 없습니다. member 없이 담당에게 보내세요.`
  return `${area.name} 영역에 그런 동료가 없습니다. 동료: ${peers.map((peer) => `${peer.label}(${peer.key})`).join(", ")}`
}

const NO_TO =
  "받을 영역이 없습니다. to에 영역 id, slug, 이름 중 하나를 넣으세요(team_status에 다른 영역 목록이 있습니다)."
const NO_ID = '답할 물음의 id가 없습니다. 받은 <dispatch from="area" kind="ask">의 id를 id에 넣으세요.'
const NOT_YOURS =
  '이 대화가 받은 물음이 아닙니다. 답은 이 대화에 온 <dispatch from="area" kind="ask">의 id로만 보냅니다.'
const SELF = "자기 자신에게는 보내지 않습니다."
const NOTE_LONG = `쪽지는 ${Talk.NOTE_MAX.toLocaleString("en-US")}자까지입니다. 줄이거나 kind:"ask"로 보내세요.`
const NOT_SENT =
  '보내지 않았습니다. 그 대화는 지금 영역 메시지를 받을 수 없습니다. 필요하면 team_report(kind:"blocked")로 메인에게 알리세요.'

/** Why a guard held a message back (G1–G3). `open` follows the receiver's name. */
const GUARD: Readonly<Record<Talk.Guard, string>> = {
  answered: "그 물음에는 이미 답했습니다. 답은 한 번만 보냅니다.",
  open: '에게 보낸 앞선 물음이 아직 열려 있습니다. 답이 오거나 그 대화가 차례를 마친 뒤에 다시 물으세요. 알리기만 할 것은 kind:"note"로 남기세요.',
  limit: `이 대화의 물음이 지난 한 시간에 ${Talk.ASKS_PER_HOUR}개에 닿아 보내지 않았습니다. 꼭 필요하면 team_report(kind:"blocked")로 메인에게 알리세요.`,
  "team-limit": `팀의 물음이 지난 한 시간에 ${Talk.ASKS_PER_HOUR_TEAM}개에 닿아 보내지 않았습니다. 꼭 필요하면 team_report(kind:"blocked")로 메인에게 알리세요.`,
}

/** Added to a note's answer when the receiver already held its five notes (2026-11-14). */
const PUSHED = ` 받는 쪽에 쪽지가 ${Talk.NOTES_PER_TARGET}개라 가장 오래된 쪽지가 밀려났습니다.`

/** A message waits because the receiving area works with the user directly (2026-11-14). */
const WAITING_DIRECT = "상대 영역이 사용자와 직접 작업 중이라 기다립니다."

/** Why an area message waits in the receiving area's outbox (5.1). */
const WAITING: Readonly<Record<OwnTeam.WaitReason, string>> = {
  paused: "그 영역에 메인 멈춤이 켜져 있어 대기함에서 기다립니다. 사용자가 끄면 들어갑니다.",
  busy: "그 폴더에서 일하는 대화가 있어 대기함에서 기다립니다. 폴더가 쉬면 들어갑니다.",
  queued: "그 폴더에 앞선 요청이 아직 남아 있어 대기함에서 기다립니다. 차례대로 들어갑니다.",
  maintaining: "프로그램이 그 영역을 손보는 중이라 대기함에서 기다립니다. 끝나면 들어갑니다.",
  broken: "그 영역의 폴더를 지금 쓸 수 없어 대기함에서 기다립니다.",
}
