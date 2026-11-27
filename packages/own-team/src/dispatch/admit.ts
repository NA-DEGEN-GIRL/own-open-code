export * as Admit from "./admit.js"

import { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import { Talk } from "./talk.js"
import { Lock } from "@own/runtime"
import type { Hub } from "../hub.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import { Outbox } from "./dispatch.js"

/**
 * Main requests and the outbox (06 §5.1–5.2, §5.7): `team_dispatch` records a request and sends it at once when the
 * area folder is idle; otherwise it waits in the outbox, oldest first, and is checked again on events:
 * - a run of a session ends (`session.execution.succeeded|failed|interrupted`) or an inbox item is cancelled;
 * - an own op ends (`op.done`), Main 멈춤 goes off (`dispatch/pause.ts`), a new request arrives;
 * - the controller starts or a new instance appears (`resume`, 5.7: waiting requests go again with the same id).
 * The owner's own stop (`interrupted{reason: "user"}`) is not a reason to send: it turns Main 멈춤 on (5.3).
 *
 * RH-20: a wait that no event ends (a failed preparation, a rotation that failed moments ago, a service that could
 * not answer) is looked at again on a timer, 30 s doubling up to 5 minutes, until the request went or the outbox is
 * empty; Main 멈춤, direct work (`dispatch/direct.ts`: the hand-back drains) and a broken area wait for the user.
 * Each area keeps why it waits, since when and what holds it (`wait`), which `outbox.list` and `team_status` show; a
 * failed rotation of the area, or a preparation that failed for a request, is told to the main once (a waking team
 * update).
 *
 * The steps of one area run one at a time (cancelling included), so a request is never sent twice nor sent after it
 * was cancelled; a step requested while another waits to start joins it.
 */

/** Core events after which an area's folder may have become idle. */
const WAKES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.cancelled",
])

/** The first look again of a wait no event ends; it doubles up to {@link RETRY_MAX_MS}. */
export const RETRY_MS = 30_000
export const RETRY_MAX_MS = 5 * 60_000

/** Why an area's outbox waits, as this controller saw it (RH-20). */
export interface Waited {
  readonly why: OwnTeam.WaitReason
  readonly since: number
  readonly failure?: { readonly text: string; readonly at: number }
  readonly retryAt?: number
  /** `paused` because the user works with the area directly (2026-11-14). */
  readonly direct?: true
}

export function create(services: Services.Context): Services.Admit {
  const locks = new Map<string, Lock.Mutex>()
  const queued = new Set<string>()
  const waits = new Map<string, Waited>()
  const retries = new Map<string, { readonly tries: number; readonly cancel: () => void }>()
  /** Failures already told to the main, by request and text. */
  const told = new Set<string>()
  const state = { closed: false }
  const lock = (key: string) => {
    const existing = locks.get(key)
    if (existing) return existing
    const created = new Lock.Mutex()
    locks.set(key, created)
    return created
  }
  /** Runs `section` after the area's current step. */
  const serial = <T>(teamID: string, areaID: string, section: () => Promise<T>) =>
    lock(`${teamID}:${areaID}`).run(section)
  /** One admission step of the area; a step already waiting to start covers this request too (`undefined`). */
  const step = (teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID): Promise<Outbox.Step | undefined> => {
    const key = `${teamID}:${areaID}`
    if (queued.has(key)) return serial(teamID, areaID, async () => undefined)
    queued.add(key)
    return serial(teamID, areaID, async () => {
      queued.delete(key)
      const result = await Outbox.admit(services, teamID, areaID)
      await settle(teamID, areaID, result)
      return result
    })
  }
  /** Keeps why the area waits, looks again later when no event will, and tells the main of a failure once. */
  const settle = async (teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID, result: Outbox.Step) => {
    const key = `${teamID}:${areaID}`
    const now = services.clock.now()
    if (result.kind !== "waiting") {
      waits.delete(key)
      retries.get(key)?.cancel()
      retries.delete(key)
      return
    }
    const before = waits.get(key)
    const again = result.why !== "paused" && result.why !== "broken" && !state.closed
    const tries = again ? (retries.get(key)?.tries ?? 0) + 1 : 0
    const delay = Math.min(RETRY_MS * 2 ** Math.max(0, tries - 1), RETRY_MAX_MS)
    const same = before?.why === result.why && before.direct === result.direct
    waits.set(key, {
      why: result.why,
      since: same ? before.since : now,
      ...(result.direct ? { direct: true as const } : {}),
      ...(result.failure === undefined
        ? same && before.failure
          ? { failure: before.failure }
          : {}
        : { failure: { text: result.failure, at: now } }),
      ...(again ? { retryAt: now + delay } : {}),
    })
    retries.get(key)?.cancel()
    retries.delete(key)
    if (again)
      retries.set(key, {
        tries,
        cancel: services.clock.schedule(delay, () => {
          if (state.closed) return
          void step(teamID, areaID).catch((error: unknown) =>
            services.log.warn("dispatch_retry_failed", { teamID, areaID, error }),
          )
        }),
      })
    if (!same || result.failure !== undefined)
      services.log.info("dispatch_step", {
        teamID,
        areaID,
        why: result.why,
        failure: result.failure,
        retryMs: delay,
        ...(result.direct ? { direct: true } : {}),
      })
    if (result.failure !== undefined && result.dispatchID !== undefined && !result.quiet) {
      const said = `${result.dispatchID}:${result.failure}`
      if (told.has(said)) return
      told.add(said)
      const area = await services.registry.areas.get(teamID, areaID)
      await services.features().digest.add(
        teamID,
        Fold.entry({
          at: now,
          reason: "request-failed",
          areaID,
          text: `${area?.name ?? areaID}: 메인 요청을 아직 보내지 못했습니다 · ${result.failure} · 다시 해 봅니다`,
        }),
      )
    }
  }
  /** A step for every area of the team (or `areaID`) with waiting requests. */
  const drain = async (teamID: OwnTeam.TeamID, areaID?: OwnTeam.AreaID) => {
    const waiting = await services.registry.dispatches.waiting(teamID, areaID)
    await Promise.all([...new Set(waiting.map((dispatch) => dispatch.areaID))].map((id) => step(teamID, id)))
  }
  const drainAll = async () => {
    const teams = await services.registry.teams.list()
    await Promise.all(teams.filter((team) => team.state === "on").map((team) => drain(team.id)))
  }

  const stopEvents = services.hub.on(async (event) => {
    if (!WAKES.has(event.type)) return
    if (await stopped(services, event, serial)) return
    await drainAll()
  })
  const stopOps = services.hub.subscribe((event) => {
    if (event.name !== "op.done") return
    void (async () => {
      // RH-20: a rotation that failed is the main's to know (its request waits, and is tried again).
      if (event.data.state === "failed") await rotationFailed(services, event.data)
      await drain(event.data.teamID)
    })().catch((error: unknown) => services.log.warn("dispatch_drain_failed", { teamID: event.data.teamID, error }))
  })

  /** The step after a record, and what became of the request or message. */
  const admitted = async (dispatch: OwnTeam.Dispatch) => {
    const result = await step(dispatch.teamID, dispatch.areaID)
    const current = await services.registry.dispatches.find(dispatch.teamID, dispatch.id)
    if (current?.state === "sent") return { ok: true as const, dispatchID: dispatch.id, state: "queued" as const }
    // A request to a peer the team's R4 refused (or whose peer is gone), or an area message to a conversation that is
    // not the team's yet, went nowhere (`Outbox.admit`).
    if (current?.state === "cancelled") return { ok: true as const, dispatchID: dispatch.id, state: "refused" as const }
    // The oldest request waits for this reason, and every later one behind it.
    if (result?.kind === "waiting")
      return {
        ok: true as const,
        dispatchID: dispatch.id,
        state: "waiting" as const,
        why: result.why,
        ...(result.direct ? { direct: true as const } : {}),
      }
    const [team, area] = await Promise.all([
      services.registry.teams.get(dispatch.teamID),
      services.registry.areas.get(dispatch.teamID, dispatch.areaID),
    ])
    // An older request just went in (or another step ran): this one waits behind it.
    const found = team && area ? await Outbox.why(services, team, area) : { why: "broken" as const }
    return {
      ok: true as const,
      dispatchID: dispatch.id,
      state: "waiting" as const,
      why: found?.why ?? "queued",
      ...(found && "direct" in found && found.direct ? { direct: true as const } : {}),
    }
  }

  /** Why the area's outbox waits now, with since when and what holds it (RH-20). */
  const wait = async (team: OwnTeam.Team, area: OwnTeam.Area) => {
    const seen = waits.get(`${team.id}:${area.id}`)
    // Nothing holds the next request now, but its last try failed and the next one is due later.
    const now = (await Outbox.why(services, team, area)) ?? (seen?.failure ? { why: seen.why } : undefined)
    if (now === undefined) return undefined
    const oldest = (await services.registry.dispatches.waiting(team.id, area.id))[0]
    const direct = "direct" in now && now.direct === true
    // A wait whose cause changed (Main 멈춤 ↔ direct work) starts again.
    const since =
      seen?.why === now.why && (seen.direct === true) === direct
        ? seen.since
        : (oldest?.createdAt ?? services.clock.now())
    const cause: OwnTeam.WaitCause = direct
      ? { direct: true }
      : "op" in now && now.op
        ? { opID: now.op.id, kind: now.op.kind }
        : seen?.why === now.why && seen.failure
          ? {
              failure: seen.failure.text,
              at: seen.failure.at,
              ...(seen.retryAt === undefined ? {} : { retryAt: seen.retryAt }),
            }
          : seen?.retryAt === undefined
            ? {}
            : { retryAt: seen.retryAt }
    return { why: now.why, since, ...(Object.keys(cause).length === 0 ? {} : { cause }) }
  }

  return {
    dispatch: async (input) => {
      const recorded = await Outbox.record(services, input)
      if (!recorded.ok) return recorded
      // Only area messages pass the guards (`message`).
      if ("guard" in recorded) return Services.failure("internal_error", "a request was held back by a guard", {})
      return admitted(recorded.dispatch)
    },
    message: async (input) => {
      const recorded = await Outbox.record(services, input)
      if (!recorded.ok) return recorded
      if ("guard" in recorded) return { ok: true, guard: recorded.guard }
      return admitted(recorded.dispatch)
    },
    drain: (input) => drain(input.teamID, input.areaID),
    list: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
      const area = await services.registry.areas.get(input.teamID, input.areaID)
      if (!area) return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
      const [items, talk, areas] = await Promise.all([
        services.registry.dispatches.waiting(input.teamID, input.areaID),
        Talk.load(services.kv, input.teamID),
        services.registry.areas.list(input.teamID),
      ])
      const waited = items.length > 0 && team.state === "on" ? await wait(team, area) : undefined
      // The notes (쪽지) held for the area's owner and each peer (5.8), oldest first.
      const active = new Set<string>(areas.filter((item) => item.state === "active").map((item) => item.id))
      const now = services.clock.now()
      const notes = [undefined, ...(area.peers ?? []).map((peer) => peer.key)]
        .flatMap((to) => Talk.held(talk, { areaID: area.id, ...(to === undefined ? {} : { to }), now, active }))
        .toSorted((a, b) => a.at - b.at)
      return { ok: true, items, ...(waited ?? {}), ...(notes.length === 0 ? {} : { notes }) }
    },
    waited: async (input) => {
      const [team, area] = await Promise.all([
        services.registry.teams.get(input.teamID),
        services.registry.areas.get(input.teamID, input.areaID),
      ])
      if (!team || !area || team.state !== "on") return undefined
      if ((await services.registry.dispatches.waiting(team.id, area.id)).length === 0) return undefined
      return wait(team, area)
    },
    cancel: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
      if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
      const cancelled = await serial(input.teamID, input.areaID, () => Outbox.cancel(services, input))
      if (cancelled.length === 0)
        return Services.failure("not_found", "no such waiting request", { what: "dispatch", id: input.dispatchID })
      return { ok: true }
    },
    cancelAll: async (input) => {
      const waiting = await services.registry.dispatches.waiting(input.teamID, input.areaID)
      const areas = [...new Set(waiting.map((dispatch) => dispatch.areaID))]
      const cancelled = await Promise.all(
        areas.map((areaID) =>
          serial(input.teamID, areaID, () => Outbox.cancel(services, { teamID: input.teamID, areaID })),
        ),
      )
      return cancelled.flat()
    },
    resume: async () => {
      const now = services.clock.now()
      const teams = await services.registry.teams.list()
      await Promise.all(
        teams.map((team) => services.write(team.id, () => services.registry.dispatches.prune(team.id, now))),
      )
      await drainAll()
    },
    close: async () => {
      state.closed = true
      retries.forEach((retry) => retry.cancel())
      retries.clear()
      stopEvents()
      stopOps()
    },
  }
}

/** A failed rotation of an area: a waking team update with the failed step's note (RH-20), once per op. */
async function rotationFailed(services: Services.Context, data: Hub.Body<"op.done">) {
  const op = await services.journal.get(data.teamID, data.opID)
  if (op?.kind !== "rotate" || op.areaID === undefined) return
  const area = await services.registry.areas.get(op.teamID, op.areaID)
  const failed = op.steps.find((step) => step.state === "failed")
  await services.features().digest.add(
    op.teamID,
    Fold.entry({
      at: services.clock.now(),
      reason: "request-failed",
      areaID: op.areaID,
      text: `${area?.name ?? op.areaID}: 새 대화로 바꾸지 못했어요(${failed?.note ?? "이유를 알 수 없음"})`,
    }),
  )
}

/**
 * The owner's (or an area peer's) run stopped by the user (stop button, revert: `interrupted{reason: "user"}`) turns
 * Main 멈춤 on instead of letting the next request start (5.3); handled in the area's order, so a step queued after it
 * sees the switch.
 */
async function stopped(
  services: Services.Context,
  event: Hub.Incoming,
  serial: <T>(teamID: string, areaID: string, section: () => Promise<T>) => Promise<T>,
) {
  if (event.type !== "session.execution.interrupted" || event.data.reason !== "user") return false
  const found = await services.locate.session(event.data.sessionID)
  if (found?.role !== "owner" && found?.role !== "peer") return false
  await serial(found.team.id, found.area.id, () =>
    services.features().pause.stopped({
      teamID: found.team.id,
      areaID: found.area.id,
      sessionID: SessionID.make(event.data.sessionID),
    }),
  )
  return true
}
