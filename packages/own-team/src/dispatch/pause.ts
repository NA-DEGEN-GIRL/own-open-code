export * as Pause from "./pause.js"

import type { OwnTeam } from "@own/protocol"
import { Areas } from "../registry/area.js"
import { Services } from "../services.js"
import { Outbox } from "./dispatch.js"

/**
 * Main 멈춤 (06 §5.3), one switch per area (`area.paused`):
 * - `area.pause{on}` sets `"user"`; while it is on, new main and team requests wait in the outbox. Requests that already
 *   went in stay (the user stops the run or removes the queue item).
 * - The owner's (or an area peer's) run ended by the user's stop (`interrupted{reason: "user"}`) turns it on as
 *   `"user"` (`stopped`), or the folder would look idle and the next request would start the stopped owner again. A
 *   stop while an own op runs on the area is that op's own interrupt (core reports every API interrupt as `user`) and
 *   changes nothing.
 * - Off: the first item parked in the owner's queue (else in a peer's) is turned into `steer`, which wakes that
 *   conversation (own-web's `지금 보내기`; core has no other way to wake a stopped session's queue), then the outbox
 *   sends by the 5.1 rule.
 * - 모두 멈추기 (`team.pause{on}`) sets `"all"` on areas without Main 멈춤 and interrupts every working owner and peer;
 *   다시 시작 (`off`) turns off only the `"all"` areas, so an area the user paused stays paused.
 * No clock, no automatic release, no tracking of open screens.
 *
 * 직접 작업 (2026-11-14, `dispatch/direct.ts`): off is also 메인에게 넘기기, so it first ends the area's direct work
 * (`Direct.end`, `handed`; `taken` when the main's approved plan runs it). A held area's user stop does not switch Main
 * 멈춤 on (the user is working there), and 다시 시작 never wakes a held area's parked queue; neither team switch
 * touches `directWork`.
 */
export function create(services: Services.Context): Services.Pause {
  return {
    area: async (input) => {
      const team = await on(services, input.teamID)
      if (!team.ok) return team
      const area = await services.registry.areas.get(input.teamID, input.areaID)
      if (!area || area.state === "retired")
        return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
      if (!input.on)
        await services.features().direct.end({
          teamID: input.teamID,
          areaID: area.id,
          why: input.taken ? "taken" : "handed",
        })
      const target: OwnTeam.Paused = input.on ? "user" : false
      const changed = await update(services, input.teamID, (item) => (item.id === area.id ? target : item.paused))
      if (!input.on) await release(services, changed)
      const current = (await services.registry.areas.get(input.teamID, input.areaID)) ?? area
      return { ok: true, area: Areas.view(current) }
    },
    team: async (input) => {
      const team = await on(services, input.teamID)
      if (!team.ok) return team
      const changed = await update(services, input.teamID, (item) =>
        input.on ? (item.paused === false ? "all" : item.paused) : item.paused === "all" ? false : item.paused,
      )
      await (input.on ? interrupt(services, input.teamID) : release(services, changed))
      return { ok: true, team: (await services.registry.teams.get(input.teamID)) ?? team.team }
    },
    stopped: async (input) => {
      const [team, area, op] = await Promise.all([
        services.registry.teams.get(input.teamID),
        services.registry.areas.get(input.teamID, input.areaID),
        services.journal.active(input.teamID),
      ])
      const ours =
        area?.owner.sessionID === input.sessionID ||
        (area?.peers ?? []).some((peer) => peer.sessionID === input.sessionID)
      if (team?.state !== "on" || !area || area.paused !== false || !ours) return
      // The user stopped a run in an area they work with directly: their own work, not a reason to hold the main.
      if (area.directWork !== undefined) return
      if (op?.state === "running" && Outbox.maintaining(op, area.id, services.steps)) return
      await update(services, input.teamID, (item) =>
        item.id === area.id && item.paused === false ? "user" : item.paused,
      )
    },
  }
}

/** The team, when it exists and is on. */
async function on(services: Services.Context, teamID: OwnTeam.TeamID) {
  const team = await services.registry.teams.get(teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID })
  return { ok: true as const, team }
}

/**
 * Writes `change(area)` to every area of the team that is not retired, in the team's mutex, and announces each area
 * that changed (`area.changed`). Returns the changed areas as written.
 */
async function update(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
  change: (area: OwnTeam.Area) => OwnTeam.Paused,
) {
  const written = await services.write(teamID, async () => {
    const areas = (await services.registry.areas.list(teamID)).filter((area) => area.state !== "retired")
    const changed = areas.flatMap((area) => {
      const paused = change(area)
      return paused === area.paused ? [] : [{ ...area, paused }]
    })
    // One after another: each write raises the team's `rev` (a read-modify-write of the team record).
    return changed.reduce<Promise<Array<{ readonly area: OwnTeam.Area; readonly rev: number | undefined }>>>(
      async (previous, area) => [...(await previous), { area, rev: await services.registry.areas.put(area) }],
      Promise.resolve([]),
    )
  })
  written.forEach((item) => {
    if (item.rev === undefined) return
    services.hub.publish({
      name: "area.changed",
      data: { teamID, areaID: item.area.id, rev: item.rev, status: item.area.status, paused: item.area.paused },
    })
  })
  return written.map((item) => item.area)
}

/**
 * Main 멈춤 went off: wake each owner's parked queue, then let the outboxes send. A held area's queue is not woken
 * (다시 시작 leaves direct work as it is); its outbox lets in only what passes (`Direct.pass`).
 */
async function release(services: Services.Context, areas: ReadonlyArray<OwnTeam.Area>) {
  const released = areas.filter((area) => area.paused === false)
  await Promise.all(released.filter((area) => area.directWork === undefined).map((area) => wake(services, area)))
  await Promise.all(released.map((area) => services.features().admit.drain({ teamID: area.teamID, areaID: area.id })))
}

/**
 * The first item parked in an idle queue of the folder becomes `steer`, which starts that conversation on it: the
 * owner's queue first, then each peer's (동료), and only one of them, since one conversation at a time works in the
 * folder (5.1). Nothing is woken while one of them runs.
 */
export async function wake(services: Services.Context, area: OwnTeam.Area) {
  const sessions = [area.owner.sessionID, ...(area.peers ?? []).map((peer) => peer.sessionID)].filter(
    (sessionID) => sessionID !== null,
  )
  if (sessions.length === 0) return
  const active = await services.http.session.active()
  if (!active.ok || sessions.some((sessionID) => active.value.has(sessionID))) return
  const parked = async (index: number) => {
    const sessionID = sessions[index]
    if (sessionID === undefined) return
    const inbox = await services.http.inbox.list({ sessionID, directory: area.directory })
    // A context reset ahead of it delivers first (core), so the prompt behind it starts the new context (06 §6.1). A
    // passive notice ahead of it rides with it, and so does a steer that waits in an idle queue (RH-20: a notice
    // admitted without a wake, such as own.harness' switch notice or a shell result): core promotes it with the item
    // woken here, so it never hides the parked prompt or request behind it.
    const first = inbox.ok
      ? inbox.value.find((item) => item.type !== "reset" && !item.payload.beforeReset && item.delivery === "queue")
      : undefined
    if (!first || (first.type !== "user" && first.type !== "synthetic")) return parked(index + 1)
    const updated = await services.http.inbox.update({
      sessionID,
      directory: area.directory,
      inboxID: first.id,
      delivery: "steer",
    })
    if (!updated.ok) services.log.warn("pause_wake_failed", { areaID: area.id, message: updated.message })
  }
  await parked(0)
}

/**
 * 모두 멈추기: every owner and area peer whose run is active is interrupted (an idle one's Location is never woken),
 * except the owner of an area under direct work: that run is the user's own, in a conversation the main keeps out of.
 */
async function interrupt(services: Services.Context, teamID: OwnTeam.TeamID) {
  const active = await services.http.session.active()
  if (!active.ok) {
    services.log.warn("pause_interrupt_failed", { teamID, message: active.message })
    return
  }
  const areas = await services.registry.areas.list(teamID)
  await Promise.all(
    areas.flatMap((area) => {
      if (area.state === "retired") return []
      const owner = area.directWork === undefined ? [area.owner.sessionID] : []
      const sessions = [...owner, ...(area.peers ?? []).map((peer) => peer.sessionID)]
      return sessions.flatMap((sessionID) =>
        sessionID && active.value.has(sessionID)
          ? [services.http.session.interrupt({ sessionID, directory: area.directory })]
          : [],
      )
    }),
  )
}
