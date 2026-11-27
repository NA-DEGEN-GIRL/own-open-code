export * as MainTools from "./main.js"

import type { Schema } from "effect"
import type { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import { OwnerAlias } from "../registry/alias.js"
import type { Services } from "../services.js"
import type { Locate } from "../sessions/locate.js"

/**
 * The team main's tools (06 §2.8, §2.9): `team_dispatch`, `team_reorganize`, `team_decide`, `team_control` (action
 * `team.main`), plus the shared `team_status`, `team_integrate` and `team_area`. The registry is the source of who may
 * call them: the session must be the team's current main. Children (which copy their parent's permissions and
 * metadata), replaced mains and every other session get a short sentence back, never an exception (06 §2.8, §4.9).
 */

export const NAMES = ["dispatch", "reorganize", "decide", "control"] as const

export const NOT_TEAM = "팀 도구는 메인·담당 대화에서만 씁니다"
export const TEAM_OFF = "팀 모드가 꺼져 있습니다"
export const MAIN_ONLY = "이 도구는 팀 메인에서만 씁니다"
export const PREVIOUS_MAIN = "이 대화는 더 이상 팀 메인이 아닙니다"

export const NOT_AVAILABLE = "아직 쓸 수 없는 도구입니다 (not available yet)."

export interface Caller {
  readonly role: "main"
  readonly team: OwnTeam.Team
  readonly sessionID: SessionID
}

/**
 * What every team tool returns (its declared output and, as `text`, its content): one or two plain Korean lines and
 * the structured values (`dispatchID`, `state`, …). `ok: false` is an answer too; tools never throw.
 */
export interface Reply {
  readonly ok: boolean
  readonly text: string
  readonly [key: string]: Schema.Json
}

/** A service failure as a tool answer. */
export function answer(failure: Services.Failure): Reply {
  if (failure.error === "unsupported") return { ok: false, text: NOT_AVAILABLE, error: failure.error }
  if (failure.error === "team_off") return { ok: false, text: TEAM_OFF, error: failure.error }
  if (failure.error === "busy")
    return { ok: false, text: busy(failure.data), error: failure.error, opID: failure.data.opID }
  return { ok: false, text: failure.message, error: failure.error }
}

/**
 * RH-20: the op that holds the team, and what it waits for, so the main tells the user instead of trying again and
 * again (`team_status{detail: true}` names the wait and what the user can do).
 */
function busy(data: Extract<Services.Failure, { readonly error: "busy" }>["data"]) {
  const what = `팀의 다른 작업(${data.kind}, ${data.opID})`
  if (data.waitingFor === "confirm")
    return `${what}이 사용자의 확인을 기다립니다. 사용자에게 그 확인에 답하거나 작업을 취소해 달라고 하세요.`
  if (data.waitingFor === "wait")
    return `${what}이 기다리는 중입니다. team_status{detail: true}로 무엇을 기다리는지 보고 사용자에게 알리세요.`
  return `${what}이 도는 중입니다. 끝나면 다시 하세요.`
}

export type Checked<C> = { readonly ok: true; readonly caller: C } | { readonly ok: false; readonly text: string }

/** The refusal or the caller for a session the registry placed (`Locate.session`). */
export function judge(found: Locate.Session | undefined): Checked<Caller> {
  if (found === undefined) return { ok: false, text: NOT_TEAM }
  if (found.role === "previous-main") return { ok: false, text: PREVIOUS_MAIN }
  if (found.role !== "main")
    return { ok: false, text: found.role === "owner" || found.role === "peer" ? MAIN_ONLY : NOT_TEAM }
  if (found.team.state !== "on") return { ok: false, text: TEAM_OFF }
  return { ok: true, caller: { role: "main", team: found.team, sessionID: found.team.main.sessionID } }
}

export async function check(services: Services.Context, sessionID: string) {
  return judge(await services.locate.session(sessionID))
}

/**
 * An active area named by the model: its id (`ar_x`), slug (`x`) or name, else its owner alias (별칭, without case;
 * `OwnerAlias.problem` keeps an alias from naming another area, and an exact id or name still wins).
 */
export async function area(services: Services.Context, teamID: string, name: string) {
  const id = name.startsWith("ar_") ? name : `ar_${name}`
  const active = (await services.registry.areas.list(teamID)).filter((item) => item.state !== "retired")
  return (
    active.find((item) => item.id === id || item.name === name) ?? active.find((item) => OwnerAlias.matches(item, name))
  )
}

export const NO_AREA = "그런 영역이 없습니다. team_status로 영역 목록을 보세요."
