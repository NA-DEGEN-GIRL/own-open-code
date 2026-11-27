export * as PromptHook from "./prompt.js"

import type { SessionPrompt } from "@opencode/plugin/promise/session"
import type { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"

/**
 * The session `prompt` hook (06 §5.4): core calls it before every user admission, the ones plugins send included
 * (synthetic messages never pass it, core session/prompt.ts:39-51). A root session's input in an area folder that is
 * neither a main request (`own.dispatch`) nor a machine source (`own.accounts`' "continue" after a limit reset,
 * `own.team`) is direct user talk: the area records when and where (`area.direct`), for the team update and the hold
 * ref (5.1 step 3). An area peer's conversation (동료, by its registered id) records it for that peer instead
 * (`peer.direct`): talk there is not the user driving the owner's area. In the area's owner or a peer conversation it
 * also brings the role text up to date first (once per controller, 2026-10-16), so a request the user makes there that
 * only the main can do is passed on (`team_report{kind:"relay"}`). Information only: the hook never changes, delays or blocks the prompt. Core waits for every hook
 * without a limit, so the record ({@link record}) runs detached: its self-HTTP lookup and its registry write (which
 * waits until this controller holds the controller lock) never hold the admission.
 *
 * 직접 작업 (2026-11-14, `dispatch/direct.ts`): the user's message in the area's owner conversation goes to
 * `Direct.note`, which also starts or moves the area's direct work; a peer's or any other conversation of the folder
 * keeps only its mark. A user message in a team's main conversation is remembered (`Direct.said`) before the detached
 * record, since the main conversation lives in the home, which is no area.
 */

/** `metadata.source` values of machine prompts (T0: own-accounts' resume prompt; own.team's own prompts). */
const MACHINE = new Set(["own.accounts", OwnTeam.PROMPT_SOURCE])

/**
 * Whether a user input is a machine's, not the user's: a main request (`own.dispatch`) or a machine source
 * (`own.accounts`, `own.team`). The hook below and a voice plan's approval (`tools/voice.ts`, 06 §2.9) share it.
 */
export function machine(metadata: Readonly<Record<string, unknown>> | undefined) {
  if (metadata?.[OwnTeam.DISPATCH_META] !== undefined) return true
  const source = metadata?.source
  return typeof source === "string" && MACHINE.has(source)
}

export function create(services: Services.Context): (input: SessionPrompt) => Promise<void> {
  return async (input) => {
    if (machine(input.metadata)) return
    // A KV read, no team lock: the admission never waits for the controller lock here.
    const teams = await services.registry.teams.list().catch((error: unknown) => {
      services.log.warn("prompt_main_unknown", { sessionID: input.sessionID, error })
      return []
    })
    const main = teams.find((team) => team.state === "on" && team.main.sessionID === input.sessionID)
    if (main) services.features().direct.said(main.id)
    void record(services, input.sessionID).catch((error: unknown) =>
      services.log.warn("prompt_direct_failed", { sessionID: input.sessionID, error }),
    )
  }
}

/**
 * Records `area.direct` when `sessionID` is a root session located in an active team's area folder. The folder decides
 * the area, by the longest path prefix: the owner, previous owner conversations and any conversation the user opened
 * in that folder all count; the home is no area. Child input is its parent agent's.
 */
export async function record(services: Services.Context, sessionID: SessionID) {
  const team = (await services.registry.teams.list()).find((item) => item.state === "on")
  if (!team) return
  // `session.get` is global (no Location is woken), so any folder of a team serves as `location[directory]`.
  const session = await services.http.session.get({ sessionID, directory: team.home.directory })
  if (!session.ok) {
    services.log.warn("prompt_session_unknown", { sessionID, message: session.message })
    return
  }
  if (session.value.parentID !== undefined) return
  const place = await services.locate.directory(session.value.location.directory)
  if (!place?.area || place.team.state !== "on") return
  const areaID = place.area.id
  // An area peer's conversation is recorded for that peer (동료): talk there is not the owner's area being driven by
  // the user, so the main does not hold back work from the owner for it (5.4).
  const peer = (place.area.peers ?? []).find((item) => item.sessionID === sessionID)
  // 06 §6.2 (2026-10-16): the user writes here, so this folder's Location is live anyway: an attached owner or peer
  // gets its current role text once per controller (with the line that passes the main's work on, `relay`).
  const features = services.features()
  // 담당 대화 바꾸기: a conversation that left the seat (or never got it) and could not be reached then is stripped now.
  if ((place.area.owner.release ?? []).includes(sessionID)) await features.seat.sweep({ teamID: place.team.id, areaID })
  const owner = peer === undefined && place.area.owner.sessionID === sessionID
  await (peer !== undefined
    ? features.peers.role?.({ teamID: place.team.id, areaID, key: peer.key })
    : owner
      ? features.owner.role?.({ teamID: place.team.id, areaID })
      : undefined)
  // The owner conversation: the mark and direct work in one write (`Direct.note`).
  if (owner) return features.direct.note({ teamID: place.team.id, areaID, sessionID })
  const written = await services.write(place.team.id, async () => {
    const area = await services.registry.areas.get(place.team.id, areaID)
    if (!area) return undefined
    const at = services.clock.now()
    const next: OwnTeam.Area =
      peer === undefined
        ? { ...area, direct: { at, sessionID } }
        : {
            ...area,
            peers: (area.peers ?? []).map((item) =>
              item.sessionID === sessionID ? { ...item, direct: { at } } : item,
            ),
          }
    return { area: next, rev: await services.registry.areas.put(next) }
  })
  if (written?.rev === undefined) return
  services.hub.publish({
    name: "area.changed",
    data: {
      teamID: place.team.id,
      areaID,
      rev: written.rev,
      status: written.area.status,
      paused: written.area.paused,
    },
  })
}
