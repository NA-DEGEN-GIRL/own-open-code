export * as OwnerTools from "./owner.js"

import type { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { Locate } from "../sessions/locate.js"
import { MainTools } from "./main.js"

/**
 * The owners' tools (06 §2.8): `team_report`, `team_need_paths`, `team_handoff` and `team_message` (action
 * `team.owner`), plus the shared `team_status` and `team_integrate` (its own area only). The session must be the area's
 * current owner in the registry. During a rotation the old owner stays current until the registry swap (6.2 step 4),
 * so its reports are accepted until then; after the swap it is a previous owner and is refused.
 *
 * Area peers (동료, 2026-10-09) carry the owner's allows, so they see the same tools; the registry narrows what they
 * may do: `team_report` with `progress`, `done` and `blocked`, `team_need_paths`, `team_status` and `team_message`
 * (06 §5.8, 2026-10-16) ({@link checkArea}). `ready`, `team_integrate` and `team_handoff` stay the owner's ({@link
 * check}, `tools/report.ts`, `tools/integrate.ts`).
 */

export const NAMES = ["report", "need_paths", "handoff", "message"] as const

export const PREVIOUS_OWNER = "이 대화는 더 이상 이 영역의 담당이 아닙니다"
export const OWNER_ONLY = "이 도구는 영역 담당 대화에서만 씁니다"
/** A peer called an owner-only tool or report kind. */
export const PEER_REFUSED =
  '이 일은 영역 담당이 합니다. 동료는 team_report(kind:"progress"·"done"·"blocked"·"relay"), team_need_paths, team_status, team_message만 씁니다'

export interface Caller {
  readonly role: "owner"
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly sessionID: SessionID
}

/** An area peer (동료) as a tool caller. */
export interface PeerCaller {
  readonly role: "peer"
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly peer: OwnTeam.Peer
  readonly sessionID: SessionID
}

/** The owner or a peer of an area. */
export type AreaCaller = Caller | PeerCaller

export function judge(found: Locate.Session | undefined): MainTools.Checked<Caller> {
  if (found === undefined) return { ok: false, text: MainTools.NOT_TEAM }
  if (found.role === "previous-owner") return { ok: false, text: PREVIOUS_OWNER }
  if (found.role === "peer") return { ok: false, text: PEER_REFUSED }
  if (found.role !== "owner") return { ok: false, text: found.role === "main" ? OWNER_ONLY : MainTools.NOT_TEAM }
  if (found.team.state !== "on") return { ok: false, text: MainTools.TEAM_OFF }
  const sessionID = found.area.owner.sessionID
  if (sessionID === null) return { ok: false, text: MainTools.NOT_TEAM }
  return { ok: true, caller: { role: "owner", team: found.team, area: found.area, sessionID } }
}

/** The owner, or an area peer of a team that is on. */
export function judgeArea(found: Locate.Session | undefined): MainTools.Checked<AreaCaller> {
  if (found?.role !== "peer") return judge(found)
  if (found.team.state !== "on") return { ok: false, text: MainTools.TEAM_OFF }
  return {
    ok: true,
    caller: { role: "peer", team: found.team, area: found.area, peer: found.peer, sessionID: found.peer.sessionID },
  }
}

export async function check(services: Services.Context, sessionID: string) {
  return judge(await services.locate.session(sessionID))
}

export async function checkArea(services: Services.Context, sessionID: string) {
  return judgeArea(await services.locate.session(sessionID))
}
