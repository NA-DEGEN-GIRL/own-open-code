export * as Outbox from "./dispatch.js"

import { Option, Schema } from "effect"
import type { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Journal } from "../ops/journal.js"
import type { Steps } from "../ops/steps.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import type { SessionHttp } from "../sessions/http.js"
import { SafePoint } from "../sessions/safe-point.js"
import { TeamContext } from "../sessions/team-context.js"
import { Envelope } from "./envelope.js"
import { Hold } from "./hold.js"
import { MsgID } from "./msg-id.js"
import { Direct } from "./direct.js"
import { Talk } from "./talk.js"

/**
 * Main requests and the outbox (06 §5.1, §5.2, §5.7). A request is recorded as a `waiting` Dispatch; an area sends at
 * most one at a time, oldest first, and only when its whole folder is idle:
 * - Main 멈춤 is off, the area is not `broken` and own does not maintain it (an op on it, or a team-wide op running);
 * - no session placed in the folder is in `session.active` (owner and every other conversation there);
 * - the owner's queue holds no undelivered main request (`own.dispatch` items of `session.inbox.list`).
 * Core takes queued items at the owner's next idle boundary without asking again, so checking right before each send
 * is only enough when one goes in at a time. The checks run again only on events (`dispatch/admit.ts`); no clock.
 *
 * Before sending: a missing owner is created, an owner adopted without its role is attached (delta 1, 3.7) unless its
 * conversation runs on another subscription of the team main's company (the R4 exception, 10.1: it continues on the
 * team account in a new conversation from a program handoff, so that account never runs for the team), `fresh`
 * replaces the owner conversation first (the request then waits while the rotation op runs), and direct user talk
 * since the last sent request plus uncommitted changes leave a hold ref (8.7). An adopted conversation continues as it
 * is whatever its size (U6). Sending is `session.prompt` with the hashed id `msgID(dispatchID, ownerSessionID)`, the
 * envelope, metadata `own.dispatch` and `source: "own.team"`, and `delivery: "queue"`: never `steer`. A resend after
 * a restart reuses the id, so core keeps the first admission.
 *
 * Area peers (동료, 2026-10-09): a request with `to` goes to that peer of the area through the same outbox, in the same
 * order and under the same rule: one at a time per folder, so the queued check reads the owner's inbox and every
 * peer's. Before it goes, the peer is checked against the team's R4 every time (no rotation for a peer: a peer on
 * another subscription of the team main's company is refused, the request cancelled and the main told) and a
 * registered peer gets its allows and role (`Peers.attach`). The envelope then names it (`to="<key>"`); an owner's
 * envelope is unchanged. A request whose peer is gone is cancelled with a team note.
 *
 * Area messages (영역 메시지, 06 §5.8, 2026-10-16): another area's ask or reply (`from="area"`) and the program's notice to
 * an asker or a watcher (`from="team"`, `kind="notice"`) ride the same outbox, one at a time per folder, only when it is
 * idle, never steered into a running turn (the Main 멈춤-off wake of 5.3 may start a parked one, like a main request).
 * They go only to a conversation that is already the team's: they never create a missing owner, attach an adopted
 * owner or a registered peer, or rotate a conversation; such a target refuses them (cancelled, an audit line for the
 * main, a notice to an asker). A reply and a notice are solicited (the conversation asked or watched), so they pass the
 * user's Main 멈춤 (`"user"`) and go in first; 모두 멈추기 (`"all"`) still holds them. The guards (G1–G3) run in the
 * write section that records the message (`dispatch/talk.ts`). Notes (쪽지) held for a conversation follow the envelope
 * of the next request that goes to it, whoever sent the request; their ids are written on its record before it is
 * sent, so a resend carries the same ones, and they leave the store once it went in.
 *
 * 직접 작업 (2026-11-14, `dispatch/direct.ts`): while the user works with the area directly and Main 멈춤 is off
 * (`Direct.live`), only what {@link Direct.pass}es goes (replies, notices, the program's requests of an integration the
 * user started meanwhile); the rest waits as `paused` with `direct`, until the hand-back. No retry timer: the
 * hand-back drains the outbox.
 *
 * Callers serialize the steps of one area (`dispatch/admit.ts`); these functions never hold the team mutex while they
 * call the service or other features.
 */

/**
 * What one admission step of an area did. A request that waits for a failure (RH-20: a step of its preparation failed,
 * the send failed) carries it (`failure`), so the outbox says why and tells the main once.
 */
export type Step =
  | { readonly kind: "sent"; readonly dispatchID: OwnTeam.DispatchID }
  | {
      readonly kind: "waiting"
      readonly why: OwnTeam.WaitReason
      readonly dispatchID?: OwnTeam.DispatchID
      readonly failure?: string
      /** The failure was told to the main already (a failed rotation's own update). */
      readonly quiet?: true
      /** It waits because the user works with the area directly (`why: "paused"`). */
      readonly direct?: true
    }
  | { readonly kind: "empty" }

/**
 * Records a main request, a program request or notice, or an area message (`waiting`). A team that is off records
 * nothing (5.1 step 1). An area message passes the loop guards first, in the same write section (`guard`: held back,
 * nothing written); an ask is open from then on, and the main gets an audit line.
 */
export async function record(
  services: Services.Context,
  input: Services.DispatchInput | Services.MessageInput,
): Promise<Services.Result<{ readonly dispatch: OwnTeam.Dispatch } | { readonly guard: Talk.Guard }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const written: { readonly dispatch: OwnTeam.Dispatch } | { readonly guard: Talk.Guard } | undefined =
    await services.write(team.id, async () => {
      const area = await services.registry.areas.get(team.id, input.areaID)
      if (!area || area.state === "retired") return undefined
      const now = services.clock.now()
      const message = "sender" in input ? input : undefined
      const talk = message ? await Talk.load(services.kv, team.id) : undefined
      if (message && talk) {
        const dispatches = await services.registry.dispatches.list(team.id)
        const held = Talk.guard({ dispatches, state: talk, message, now })
        if (held) return { guard: held } as const
      }
      const request = "sender" in input ? undefined : input
      const dispatch: OwnTeam.Dispatch = {
        id: OwnTeam.DispatchID.create(),
        teamID: team.id,
        areaID: area.id,
        seq: await services.registry.dispatches.next(team.id, area.id),
        from: request ? request.from : "area",
        kind: input.kind,
        ...(request?.task === undefined ? {} : { task: request.task }),
        text: input.text,
        ...(request?.fresh ? { fresh: true } : {}),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(message ? { sender: message.sender } : {}),
        ...(message?.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        state: "waiting",
        createdAt: now,
        ...(request?.origin === undefined ? {} : { origin: request.origin }),
      }
      await services.registry.dispatches.put(dispatch)
      if (message && talk) {
        const what = message.kind === "ask" ? "물음" : message.last ? "답(그 차례의 마지막 답)" : "답"
        const line = Talk.auditLine({ sender: message.sender, to: Talk.who(area, input.to), what, text: input.text })
        await Talk.save(services.kv, team.id, Talk.recorded(talk, { dispatch, line }))
      }
      return { dispatch }
    })
  if (!written) return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  if ("guard" in written) return { ok: true, guard: written.guard }
  await changed(services, team.id, written.dispatch.areaID)
  return { ok: true, dispatch: written.dispatch }
}

/** A reply or a notice: the conversation asked for it (an ask, a watch), so the user's Main 멈춤 lets it in (5.8). */
export function solicited(dispatch: Pick<OwnTeam.Dispatch, "from" | "kind">) {
  return (dispatch.from === "area" && dispatch.kind === "reply") || dispatch.kind === "notice"
}

/** An area message or a program notice: it goes only to a conversation that is already the team's (5.8). */
export function settledOnly(dispatch: Pick<OwnTeam.Dispatch, "from" | "kind">) {
  return dispatch.from === "area" || dispatch.kind === "notice"
}

/**
 * The request that goes next: the oldest, except under the user's Main 멈춤, where the oldest solicited one goes first,
 * and in an area held by direct work, where the oldest that passes goes first (the rest wait for the switch or the
 * hand-back).
 */
function next(area: Pick<OwnTeam.Area, "paused" | "state" | "directWork">, waiting: ReadonlyArray<OwnTeam.Dispatch>) {
  if (area.paused === "user") return waiting.find(solicited) ?? waiting[0]
  if (Direct.live(area)) return waiting.find(Direct.pass(area)) ?? waiting[0]
  return waiting[0]
}

/** One step: sends the area's oldest waiting request when the folder is idle, else says why it waits. */
export async function admit(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID): Promise<Step> {
  const team = await services.registry.teams.get(teamID)
  if (!team || team.state !== "on") return { kind: "empty" }
  const waiting = await services.registry.dispatches.waiting(teamID, areaID)
  if (waiting.length === 0) return { kind: "empty" }
  const area = await services.registry.areas.get(teamID, areaID)
  if (!area) return { kind: "waiting", why: "broken" }
  const head = next(area, waiting)
  if (!head) return { kind: "empty" }
  const found = await conditions(services, team, area, head)
  const target = head.to === undefined ? area.owner.sessionID : peerOf(area, head.to)?.sessionID
  // Sent before a restart, and still waiting in its queue: only the record was missing (5.7).
  if (found.why === "queued" && target && found.queued.includes(MsgID.dispatch(head.id, target)))
    return sent(services, head, target)
  if (found.why)
    return { kind: "waiting", why: found.why, dispatchID: head.id, ...(found.direct ? { direct: true as const } : {}) }
  const ready = await prepare(services, team, area, head)
  if ("refused" in ready) {
    await refuse(services, area, head, ready)
    // The next request goes on under the same rule.
    return admit(services, teamID, areaID)
  }
  if (!ready.ok)
    return {
      kind: "waiting",
      why: ready.why,
      dispatchID: head.id,
      ...(ready.failure === undefined ? {} : { failure: ready.failure }),
      ...(ready.quiet ? { quiet: true as const } : {}),
    }
  // The hold and the send are own work on the folder: a safe point checked meanwhile answers `own` (8.4).
  const step = await SafePoint.during(services, { teamID, areaID }, async (): Promise<Step | undefined> => {
    // The checks above took a while (queues read over HTTP). An op that began meanwhile passed its safe point before
    // this one answered `own` (담당 대화 바꾸기): it holds the area now, or it has moved the seat already.
    if (maintaining(await services.journal.active(teamID), areaID, services.steps))
      return { kind: "waiting", why: "maintaining", dispatchID: head.id }
    // The user started direct work while the checks ran (the prompt hook's write): the request waits for the hand-back.
    // The re-check and the mark that the request is being sent are one team write, as the hook's start of direct work
    // is (`Direct.note` counts the mark as serving until `sent` records the request): one of the two comes first.
    const direct = services.features().direct
    const claimed = await services.write(teamID, async () => {
      const current = await services.registry.areas.get(teamID, areaID)
      if (current && Direct.live(current) && !Direct.pass(current)(head)) return undefined
      return { current, release: direct.sending(head) }
    })
    if (!claimed) return { kind: "waiting", why: "paused", dispatchID: head.id, direct: true }
    const deliver = async (): Promise<Step | undefined> => {
      const current = claimed.current
      const seat = head.to === undefined ? current?.owner.sessionID : current && peerOf(current, head.to)?.sessionID
      if (seat !== ready.target) return undefined
      // Direct talk in the owner's or a peer's conversation: either may have left changes in the shared folder.
      const talked = Math.max(
        ready.area.direct?.at ?? Number.NEGATIVE_INFINITY,
        ...peers(ready.area).map((peer) => peer.direct?.at ?? Number.NEGATIVE_INFINITY),
      )
      if (talked > ready.lastSent) {
        const held = await hold(services, ready.area, head)
        if (!held.ok)
          return {
            kind: "waiting",
            why: held.why,
            dispatchID: head.id,
            ...(held.failure === undefined ? {} : { failure: held.failure }),
          }
      }
      return send(services, ready.area, ready.target, head)
    }
    return deliver().finally(claimed.release)
  })
  // The seat is another conversation's now: the request is looked at again, for the one that holds it.
  return step ?? admit(services, teamID, areaID)
}

/**
 * Why the area's outbox cannot send now (`outbox.list`), with the op that maintains the area; `undefined` when its next
 * request can go.
 */
export async function why(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area) {
  const head = next(area, await services.registry.dispatches.waiting(team.id, area.id))
  const found = await conditions(services, team, area, head)
  if (found.why === undefined) return undefined
  return { why: found.why, ...(found.op ? { op: found.op } : {}), ...(found.direct ? { direct: true as const } : {}) }
}

/**
 * RH-20: the oldest waiting `fresh` main request of the area goes without a new conversation: its `fresh` mark is
 * dropped (the next admission sends it to the current owner as a plain request) and the main reads why in its next
 * team update (a team note; `wake` for a failure). The request it changed, if any.
 */
export async function unfresh(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly why: string
    readonly wake: boolean
  },
) {
  const changed = await services.write(input.teamID, async () => {
    const head = (await services.registry.dispatches.waiting(input.teamID, input.areaID)).find(
      (dispatch) => dispatch.fresh === true,
    )
    if (!head) return undefined
    const { fresh: _fresh, ...rest } = head
    await services.registry.dispatches.put(rest)
    return head
  })
  if (!changed) return undefined
  const area = await services.registry.areas.get(input.teamID, input.areaID)
  services.log.info("dispatch_unfresh", { teamID: input.teamID, areaID: input.areaID, dispatchID: changed.id })
  await services.features().digest.add(
    input.teamID,
    Fold.entry({
      at: services.clock.now(),
      reason: input.wake ? "request-failed" : "request-plain",
      areaID: input.areaID,
      text: `${area?.name ?? input.areaID}: 메인 요청 "${clip(changed.task ?? changed.text)}"을(를) 새 대화 없이 지금 담당 대화에 보냅니다 · ${input.why}`,
    }),
  )
  return changed
}

/**
 * RH-20 (6.2): main requests and area messages sent to `from` (the owner a rotation replaces) that are still in its
 * queue, never taken: each record goes back to `waiting` (it is sent again, to the new owner, with a new message id)
 * and its queue item is withdrawn, in that order, so a restart in between finds it again and loses nothing. `count` is
 * the number that went back; `ok` is `false` when the queue could not be read or an item could not be withdrawn (a
 * rotation goes on regardless, 담당 대화 바꾸기 does not: `sessions/seat.ts`).
 *
 * An item that was listed and is gone when it is withdrawn (404) and is a message of the conversation by now was
 * taken in between: its record goes back to `sent` there, or the request would be delivered a second time to the next
 * owner. `taken` counts those; they are not in `count`, and `ok` is `false` for them.
 */
export async function requeue(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly from: SessionID
    readonly directory: string
  },
): Promise<{ readonly ok: boolean; readonly count: number; readonly taken: number }> {
  const where = { sessionID: input.from, directory: input.directory }
  const inbox = await services.http.inbox.list(where)
  // A conversation that is gone (404) holds nothing.
  if (!inbox.ok) return { ok: inbox.status === 404, count: 0, taken: 0 }
  const undelivered = inbox.value.flatMap((item) => {
    const id = Option.getOrUndefined(decodeMeta(item.payload.metadata?.[OwnTeam.DISPATCH_META]))?.id
    return id === undefined ? [] : [{ inboxID: item.id, dispatchID: id }]
  })
  const back = await Promise.all(
    undelivered.map(async (item) => {
      const sentTo = await services.write(input.teamID, async () => {
        const current = await services.registry.dispatches.find(input.teamID, item.dispatchID)
        if (current?.state !== "sent" || current.sentTo?.sessionID !== input.from) return undefined
        const { sentTo: before, ...rest } = current
        await services.registry.dispatches.put({ ...rest, state: "waiting" })
        return before
      })
      const cancelled = await services.http.inbox.cancel({ ...where, inboxID: item.inboxID })
      if (cancelled.ok) return "back"
      if (cancelled.status !== 404) {
        services.log.warn("rotation_requeue_cancel_failed", { teamID: input.teamID, inboxID: item.inboxID })
        return "kept"
      }
      // Gone from the queue (404): delivered in between, or withdrawn by someone else. A delivered item is a message
      // of the conversation under the same id.
      const message = await services.http.session.message({ ...where, messageID: item.inboxID })
      if (!message.ok) return message.status === 404 ? "back" : "kept"
      await services.write(input.teamID, async () => {
        const current = await services.registry.dispatches.find(input.teamID, item.dispatchID)
        if (current?.state !== "waiting") return
        // A record an earlier, killed look had put back already has no `sentTo` to restore: it is written as sent.
        await services.registry.dispatches.put({
          ...current,
          state: "sent",
          sentTo: sentTo ?? {
            sessionID: input.from,
            msgID: MsgID.dispatch(current.id, input.from),
            at: services.clock.now(),
          },
        })
      })
      services.log.info("rotation_requeue_taken", { teamID: input.teamID, inboxID: item.inboxID })
      return "taken"
    }),
  )
  const count = back.filter((how) => how !== "taken").length
  if (back.length > 0) {
    services.log.info("rotation_requeued", { teamID: input.teamID, areaID: input.areaID, count })
    await changed(services, input.teamID, input.areaID)
  }
  return { ok: back.every((how) => how === "back"), count, taken: back.filter((how) => how === "taken").length }
}

const decodeMeta = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))

/**
 * Cancels waiting requests (`outbox.cancel` with `dispatchID`, or every one of the team or area); returns them. Every
 * cancel comes here (지우기, a refused send, 끝내기, 묶기, 빼기, a removed peer, 끄기), so a cancelled ask lets its asker
 * know (`Talk.cancelled`).
 */
export async function cancel(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID?: OwnTeam.AreaID; readonly dispatchID?: string },
) {
  const cancelled = await services.write(input.teamID, async () => {
    const waiting = (await services.registry.dispatches.waiting(input.teamID, input.areaID)).filter(
      (dispatch) => input.dispatchID === undefined || dispatch.id === input.dispatchID,
    )
    await Promise.all(waiting.map((dispatch) => services.registry.dispatches.put({ ...dispatch, state: "cancelled" })))
    return waiting
  })
  await Promise.all(
    [...new Set(cancelled.map((dispatch) => dispatch.areaID))].map((id) => changed(services, input.teamID, id)),
  )
  await Talk.cancelled(services, input.teamID, cancelled)
  return cancelled.map((dispatch) => ({ areaID: dispatch.areaID, dispatchID: dispatch.id }))
}

/**
 * 06 §8.2 `outbox-migrate`: moves the waiting main requests of `from` to the end of `to`'s outbox, in their `seq`
 * order and after `to`'s own, each marked `movedFrom: from` (a request going back to the area it came from loses the
 * mark). Program requests (`from="team"`: a conflict, a sync, a commit) are about `from`'s folder and never move.
 * `movedFrom` limits it to the requests that came from that area (an undo moves only those back). Nothing is sent:
 * the requests wait in `to`'s outbox until its folder is idle (5.1). A request a crash left in both outboxes (same id,
 * `Dispatches.Store.move`) keeps its copy in `to`. Returns the moved requests as they are now.
 */
export async function migrate(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly from: OwnTeam.AreaID
    readonly to: OwnTeam.AreaID
    readonly movedFrom?: OwnTeam.AreaID
  },
): Promise<ReadonlyArray<OwnTeam.Dispatch>> {
  const moved = await services.write(input.teamID, async () => {
    const store = services.registry.dispatches
    const waiting = (await store.waiting(input.teamID, input.from)).filter(
      (dispatch) =>
        dispatch.from === "main" && (input.movedFrom === undefined || dispatch.movedFrom === input.movedFrom),
    )
    const there = await store.list(input.teamID, input.to)
    const first = there.reduce((next, dispatch) => Math.max(next, dispatch.seq + 1), 0)
    const fresh = waiting.filter((dispatch) => !there.some((item) => item.id === dispatch.id))
    const placed = waiting.map((dispatch) => {
      const copy = there.find((item) => item.id === dispatch.id)
      if (copy) return { current: dispatch, next: copy }
      // A request to one of `from`'s peers goes to `to`'s owner: the peer stays with `from` (동료).
      const { movedFrom: _home, to: _peer, ...rest } = dispatch
      const next: OwnTeam.Dispatch = {
        ...rest,
        areaID: input.to,
        seq: first + fresh.indexOf(dispatch),
        ...(dispatch.movedFrom === input.to ? {} : { movedFrom: input.from }),
      }
      return { current: dispatch, next }
    })
    // Distinct keys: the new ones are free seqs of `to`, the old ones are left behind in `from`.
    await Promise.all(placed.map((item) => store.move(item.current, item.next)))
    return placed.map((item) => item.next)
  })
  if (moved.length > 0)
    await Promise.all([changed(services, input.teamID, input.from), changed(services, input.teamID, input.to)])
  return moved
}

/** Publishes the area's outbox size (`outbox.changed`). */
export async function changed(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID) {
  const waiting = (await services.registry.dispatches.waiting(teamID, areaID)).length
  services.hub.publish({ name: "outbox.changed", data: { teamID, areaID, waiting } })
}

/**
 * Whether own maintains the area (5.1): an op of the area that still runs, a step of the active op that will still act
 * on it (its op's area, or the step's), pending or a confirm of a kind that holds the later steps back, or a team-wide
 * op that still runs. RH-20: a failed step and a confirm that holds nothing back (a need_paths ask, `mergeLocal:
 * "ask"`) of an op that only waits for its confirms do not hold the area's requests, and 메인 새 대화 (a team-wide
 * `rotate`) never touches an area.
 */
export function maintaining(op: OwnTeam.Op | undefined, areaID: OwnTeam.AreaID, steps: Steps.Registry) {
  if (!op || !Journal.ACTIVE.has(op.state)) return false
  if (op.areaID === areaID && op.state === "running") return true
  const acting = (step: OwnTeam.Step) =>
    step.state === "pending" || (step.state === "needs_confirm" && steps.get(step.kind)?.holds === true)
  if (op.steps.some((step) => acting(step) && (op.areaID === areaID || step.args.areaID === areaID))) return true
  return op.areaID === undefined && op.state === "running" && op.kind !== "rotate"
}

interface Found {
  readonly why?: OwnTeam.WaitReason
  /** Ids of undelivered main requests in the owner's and the peers' queues. */
  readonly queued: ReadonlyArray<string>
  /** The op that maintains the area (`maintaining`). */
  readonly op?: OwnTeam.Op
  /** `paused` because the user works with the area directly (`Direct.live`). */
  readonly direct?: true
}

/** Undelivered main requests already steered once by this controller (RH-20); they are not steered again. */
const steered = new WeakMap<object, Set<string>>()

function peers(area: Pick<OwnTeam.Area, "peers">) {
  return area.peers ?? []
}

function peerOf(area: Pick<OwnTeam.Area, "peers">, key: string) {
  return peers(area).find((peer) => peer.key === key)
}

/**
 * The 5.1 conditions for `head`, cheapest first; an answer the service cannot give counts as `busy`. A solicited
 * reply or notice passes the user's Main 멈춤 (5.8), never 모두 멈추기.
 */
async function conditions(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  head: OwnTeam.Dispatch | undefined,
): Promise<Found> {
  if (area.paused === "all" || (area.paused === "user" && !(head && solicited(head))))
    return { why: "paused", queued: [] }
  if (area.state === "broken") return { why: "broken", queued: [] }
  if (area.state !== "active") return { why: "maintaining", queued: [] }
  if (Direct.live(area) && !(head && Direct.pass(area)(head))) return { why: "paused", direct: true, queued: [] }
  const op = await services.journal.active(team.id)
  if (maintaining(op, area.id, services.steps)) return { why: "maintaining", queued: [], ...(op ? { op } : {}) }
  const busy = await SafePoint.active(services, team, area.id)
  if (busy === undefined || busy.length > 0) return { why: "busy", queued: [] }
  // One at a time per folder: a main request still in the owner's queue or in any peer's holds the next one back.
  const sessions = [area.owner.sessionID, ...peers(area).map((peer) => peer.sessionID)].filter(
    (sessionID): sessionID is SessionID => sessionID !== null,
  )
  const inboxes = await Promise.all(
    sessions.map((sessionID) => services.http.inbox.list({ sessionID, directory: area.directory })),
  )
  // A conversation that is gone (404) holds nothing; any other answer the service could not give counts as busy.
  if (inboxes.some((inbox) => !inbox.ok && inbox.status !== 404)) return { why: "busy", queued: [] }
  const queued = inboxes.flatMap((inbox) =>
    inbox.ok ? inbox.value.filter((item) => item.payload.metadata?.[OwnTeam.DISPATCH_META] !== undefined) : [],
  )
  if (queued.length > 0) {
    await nudge(services, area, queued)
    return { why: "queued", queued: queued.map((item) => item.id) }
  }
  return { queued: [] }
}

/**
 * RH-20: a request still in the queue of a conversation that does not run, {@link SafePoint.WAKE_MS} after its
 * admission, got no run (the service stopped between the admission and its execution, a drain failed before taking
 * it), and no event will send it: it is steered once (`지금 보내기`), which wakes that conversation. Main 멈춤 is off
 * here (`conditions` answered `paused` first), and no conversation of the folder runs.
 */
async function nudge(services: Services.Context, area: OwnTeam.Area, queued: ReadonlyArray<SessionHttp.InboxView>) {
  const now = services.clock.now()
  const done = steered.get(services) ?? new Set<string>()
  steered.set(services, done)
  const stale = queued.find(
    (item) =>
      item.delivery === "queue" &&
      item.time !== undefined &&
      now - item.time.created >= SafePoint.WAKE_MS &&
      !done.has(item.id),
  )
  if (!stale) return
  done.add(stale.id)
  const updated = await services.http.inbox.update({
    sessionID: stale.sessionID,
    directory: area.directory,
    inboxID: stale.id,
    delivery: "steer",
  })
  services.log.info("dispatch_nudged", { teamID: area.teamID, areaID: area.id, inboxID: stale.id, ok: updated.ok })
}

type Waits = {
  readonly ok: false
  readonly why: OwnTeam.WaitReason
  readonly failure?: string
  readonly quiet?: true
}

/**
 * A request that never goes: R4 (a peer on another subscription of the team main's company), the peer is gone, or an
 * area message or notice to a conversation that is not the team's yet (5.8).
 */
type Refused = { readonly ok: false; readonly refused: "r4" | "gone" | "unattached"; readonly peer?: OwnTeam.Peer }

type Ready =
  | {
      readonly ok: true
      readonly area: OwnTeam.Area
      /** The owner, or the peer the request is for. */
      readonly target: SessionID
      /** When the area's last request was sent (`-Infinity` if none is on record). */
      readonly lastSent: number
    }
  | Waits
  | Refused

/** 5.1 step 3 up to the hold ref: owner, role (or the R4 rotation) and the `fresh` rotation, in that order. */
async function prepare(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  head: OwnTeam.Dispatch,
): Promise<Ready> {
  const features = services.features()
  const target = { teamID: team.id, areaID: area.id }
  const by = head.from === "main" ? "main" : "auto"
  if (head.to !== undefined) return preparePeer(services, team, area, head.to, settledOnly(head))
  // An area message or notice never creates, attaches or rotates a conversation (5.8).
  if (settledOnly(head) && (!area.owner.sessionID || !area.owner.attached)) return { ok: false, refused: "unattached" }
  if (!area.owner.sessionID) {
    const created = await features.owner.create(target)
    if (!created.ok) return blocked(services, team.id, "owner", created)
    return reread(services, team, area, head)
  }
  if (!area.owner.attached) {
    const other = await rival(services, team, area, area.owner.sessionID)
    // Undecidable fails closed: attaching could put the team on a second subscription of one company (U5).
    if (other === undefined)
      return blocked(
        services,
        team.id,
        "r4",
        Services.failure("internal_error", "the adopted conversation's account could not be judged", {}),
      )
    if (other) {
      // 3.7, 6.2 step 1 (가): no handoff turn there, and nothing of the team is attached to that conversation.
      const started = await features.rotate.request({ ...target, reason: "r4", handoff: "program", by })
      if (started.ok) return { ok: false, why: "maintaining" }
      return blocked(services, team.id, "rotate", started)
    }
    const attached = await features.owner.attach(target)
    if (!attached.ok) return blocked(services, team.id, "attach", attached)
    return reread(services, team, area, head)
  }
  const lastSent = (await services.registry.dispatches.list(team.id, area.id)).reduce(
    (latest, dispatch) => Math.max(latest, dispatch.sentTo?.at ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  )
  if (head.fresh && !rotated(area, Math.max(head.createdAt, lastSent))) {
    // RH-20: after two failed rotations for this request it goes to the current owner as a plain request.
    const failures = (await services.journal.list(team.id)).filter(
      (op) => op.kind === "rotate" && op.areaID === area.id && op.state === "failed" && op.createdAt >= head.createdAt,
    )
    if (failures.length >= FRESH_FAILURES) {
      await unfresh(services, {
        teamID: team.id,
        areaID: area.id,
        why: `새 대화로 바꾸기가 ${failures.length}번 실패했어요`,
        wake: true,
      })
      return { ok: true, area, target: area.owner.sessionID, lastSent }
    }
    const started = await features.rotate.request({ ...target, reason: "fresh", handoff: "warm", by })
    // The rotation op runs now; the request waits for it and goes to the new owner (6.2 step 5).
    if (started.ok) return { ok: false, why: "maintaining" }
    // The last rotation of the area failed moments ago (`Rotation.RETRY_MS`): no op ends for this wait.
    if (started.error === "busy" && !(await services.journal.active(team.id)))
      return {
        ok: false,
        why: "maintaining",
        failure: "새 대화로 바꾸기가 방금 실패해서 잠시 뒤 다시 해요",
        quiet: true,
      }
    if (started.error !== "unsupported") return blocked(services, team.id, "rotate", started)
    services.log.warn("dispatch_fresh_unavailable", { teamID: team.id, areaID: area.id, dispatchID: head.id })
  }
  return { ok: true, area, target: area.owner.sessionID, lastSent }
}

/** Failed rotations of one `fresh` request before it goes as a plain request (RH-20). */
export const FRESH_FAILURES = 2

/**
 * A request to a peer (동료): team R4 every time (refused, never rotated), then a registered peer's allows and role at
 * its first request. A peer that is gone (removed meanwhile, or its conversation deleted) refuses it as well, and so
 * does an unattached peer for an area message or notice (`settled`, 5.8).
 */
async function preparePeer(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  key: string,
  settled: boolean,
): Promise<Ready> {
  const peer = peerOf(area, key)
  if (!peer) return { ok: false, refused: "gone" }
  if (settled && !peer.attached) return { ok: false, refused: "unattached", peer }
  // A deleted peer conversation takes no request (an owner's is created again; a peer is the user's to register).
  const session = await services.http.session.get({ sessionID: peer.sessionID, directory: area.directory })
  if (!session.ok && session.status === 404) return { ok: false, refused: "gone", peer }
  const other = await rival(services, team, area, peer.sessionID)
  if (other === undefined)
    return blocked(
      services,
      team.id,
      "r4",
      Services.failure("internal_error", "the peer conversation's account could not be judged", {}),
    )
  if (other) return { ok: false, refused: "r4", peer }
  if (!peer.attached) {
    const attached = await services.features().peers.attach({ teamID: team.id, areaID: area.id, key })
    if (!attached.ok && attached.error === "not_found") return { ok: false, refused: "gone", peer }
    if (!attached.ok) return blocked(services, team.id, "attach", attached)
    const next = await services.registry.areas.get(team.id, area.id)
    if (!next) return { ok: false, why: "broken" }
    if (!peerOf(next, key)?.attached) return { ok: false, why: "maintaining" }
    return preparePeer(services, team, next, key, settled)
  }
  const lastSent = (await services.registry.dispatches.list(team.id, area.id)).reduce(
    (latest, dispatch) => Math.max(latest, dispatch.sentTo?.at ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY,
  )
  return { ok: true, area, target: peer.sessionID, lastSent }
}

/**
 * A request that never goes (see {@link Refused}): cancelled, and the main told. R4 wakes the main (it asked for work
 * that will not happen); a peer that is gone is a note.
 */
async function refuse(services: Services.Context, area: OwnTeam.Area, head: OwnTeam.Dispatch, refused: Refused) {
  await cancel(services, { teamID: area.teamID, areaID: area.id, dispatchID: head.id })
  if (settledOnly(head)) {
    // An area message or notice: an audit line, no wake; an asker hears of it from the cancel (`Talk.cancelled`).
    const what =
      head.from === "area" && head.sender ? `'${OwnTeamText.senderName(head.sender)}'의 영역 메시지를` : "안내를"
    await Talk.log(
      services,
      area.teamID,
      `${Talk.who(area, head.to)}: ${what} 보내지 않았습니다 · ${UNSENT[refused.refused]}`,
    )
    services.log.info("dispatch_refused", { areaID: area.id, dispatchID: head.id, why: refused.refused })
    return
  }
  const what = clip(head.task ?? head.text)
  const name = `${OwnTeamText.PEER} ${refused.peer?.label ?? head.to}`
  const text =
    refused.refused === "r4"
      ? `${area.name} ${name}: 메인 요청 "${what}"을(를) 보내지 않았습니다 · 그 대화가 팀 메인과 같은 회사의 다른 구독 계정을 씁니다`
      : `${area.name}: ${name}이(가) 없어 메인 요청 "${what}"을(를) 보내지 않았습니다`
  await services.features().digest.add(
    area.teamID,
    Fold.entry({
      at: services.clock.now(),
      reason: refused.refused === "r4" ? "refused" : "reorganized",
      areaID: area.id,
      ...(head.to === undefined ? {} : { peer: head.to }),
      text,
    }),
  )
  services.log.info("dispatch_refused", { areaID: area.id, dispatchID: head.id, why: refused.refused })
}

/** Why an area message or a notice was not sent (5.8). */
const UNSENT: Readonly<Record<Refused["refused"], string>> = {
  r4: "그 대화가 팀 메인과 같은 회사의 다른 구독 계정을 씁니다",
  gone: "받을 대화가 없습니다",
  unattached: "그 대화가 아직 팀에 붙지 않았습니다",
}

/** A request's task or text on one line, at most 60 characters. */
function clip(text: string) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`
}

/** Prepares again with the record the previous step changed. */
async function reread(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area, head: OwnTeam.Dispatch) {
  const next = await services.registry.areas.get(team.id, area.id)
  if (!next) return { ok: false as const, why: "broken" as const }
  if (!next.owner.sessionID || !next.owner.attached) return { ok: false as const, why: "maintaining" as const }
  return prepare(services, team, next, head)
}

/** A `fresh` rotation already replaced the owner after `since` (the request, or the last request sent). */
function rotated(area: OwnTeam.Area, since: number) {
  return area.owner.previous.some((item) => item.why === "fresh" && item.endedAt >= since)
}

/**
 * Whether the adopted owner's conversation must not run for the team (06 §10.1 R4; one ChatGPT login's `codex` and
 * `siwc` accounts are one subscription, a metered or other company's account is none). Read when its first main
 * request goes, as the conversation's account may have changed since the adoption. Fails closed (U5): a conversation
 * without a model would run on core's default, and a provider own.accounts does not know may be another subscription
 * of the team's company, so both count as rivals (the request goes to a new owner on the team's model, the
 * conversation stays the user's); only a discovered local provider is known to be no subscription. One that is gone
 * is left to the attach (`not_found`). `undefined` when it cannot be judged now: the conversation, own.accounts or
 * the team main's model could not be read (the request waits and is tried again). Area peers (동료) are judged the same
 * way when they are registered and before each request to them, and refused rather than rotated.
 */
export async function rival(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area, owner: SessionID) {
  const session = await services.http.session.get({ sessionID: owner, directory: area.directory })
  if (!session.ok) return session.status === 404 ? false : undefined
  const ref = session.value.model
  if (!ref) return true
  // A discovered local provider (07 P-D2) is no subscription: nothing to judge.
  if (Preset.groupOf(ref.providerID) !== undefined) return false
  const [listed, main] = await Promise.all([services.accounts.accountsList(), services.features().main.model(team.id)])
  if (!listed.ok || !main) return undefined
  const account = (providerID: string) => listed.value.accounts.find((item) => item.providerID === providerID)
  const current = account(ref.providerID)
  return current === undefined || TeamContext.rival(current, account(main.providerID))
}

/**
 * The hold ref of 5.1 step 3 after direct user talk: made only when there is uncommitted work, named by the dispatch id
 * and dated by its `createdAt`. A failure keeps the request waiting (TI-1: no request without the copy).
 */
async function hold(
  services: Services.Context,
  area: OwnTeam.Area,
  head: OwnTeam.Dispatch,
): Promise<Waits | { readonly ok: true }> {
  const [changes, links] = await Promise.all([Hold.changes(area.directory), Hold.dirtyLinks(area)])
  if (!changes.ok) return failedHold(services, area, head, changes.message, "maintaining")
  if (changes.paths.length === 0 && links.length === 0) return { ok: true }
  const held = await Hold.create({
    target: { directory: area.directory, gitDir: area.gitDir },
    scope: area.id,
    id: head.id,
    at: head.createdAt,
    links,
  })
  if (!held.ok)
    return failedHold(services, area, head, held.message, held.error === "identity" ? "broken" : "maintaining")
  services.log.info("dispatch_hold", { areaID: area.id, dispatchID: head.id, ref: held.ref, bytes: held.bytes })
  return { ok: true }
}

function failedHold(
  services: Services.Context,
  area: OwnTeam.Area,
  head: OwnTeam.Dispatch,
  message: string,
  why: OwnTeam.WaitReason,
): Waits {
  services.failed(area.teamID, { at: services.clock.now(), message: `요청 ${head.id}: ${message}` })
  return { ok: false, why, failure: `보관 기록을 만들지 못했어요: ${message}` }
}

/** A failed preparation step: the request waits; unexpected failures are kept for `diagnostics.lastErrors`. */
function blocked(services: Services.Context, teamID: OwnTeam.TeamID, what: string, failure: Services.Failure): Waits {
  if (failure.error === "broken") return { ok: false, why: "broken" }
  if (failure.error === "busy") return { ok: false, why: "maintaining" }
  if (failure.error === "not_safe_point") return { ok: false, why: "busy" }
  services.failed(teamID, { at: services.clock.now(), message: `${what}: ${failure.message}` })
  return { ok: false, why: "maintaining", failure: `${PREPARE[what] ?? what}: ${failure.message}` }
}

/** What a failed preparation step was, for the main and the outbox (RH-20). */
const PREPARE: Readonly<Record<string, string>> = {
  owner: "담당 대화를 만들지 못했어요",
  r4: "받아들인 대화의 계정을 판단하지 못했어요",
  rotate: "새 대화로 바꾸지 못했어요",
  attach: "대화를 팀에 붙이지 못했어요",
}

async function send(
  services: Services.Context,
  area: OwnTeam.Area,
  owner: SessionID,
  head: OwnTeam.Dispatch,
): Promise<Step> {
  // The role entry that explains area messages (06 §6.2, §5.8), once per controller and conversation; never blocks.
  const features = services.features()
  const target = { teamID: area.teamID, areaID: area.id }
  await (head.to === undefined ? features.owner.role?.(target) : features.peers.role?.({ ...target, key: head.to }))
  const notes = await notesFor(services, area, head)
  const prompted = await services.http.session.prompt({
    sessionID: owner,
    directory: area.directory,
    id: MsgID.dispatch(head.id, owner),
    text: Envelope.wrap({ dispatch: head, area: area.name, notes }),
    metadata: {
      [OwnTeam.DISPATCH_META]: {
        id: head.id,
        from: head.from,
        teamID: head.teamID,
        areaID: head.areaID,
        ...(head.task === undefined ? {} : { task: head.task }),
        ...(head.to === undefined ? {} : { to: head.to }),
        // Only area messages and notices name their kind and sender (5.8): a main request's metadata stays as it was.
        ...(settledOnly(head) ? { kind: head.kind } : {}),
        ...(head.sender === undefined ? {} : { sender: head.sender }),
        ...(head.replyTo === undefined ? {} : { replyTo: head.replyTo }),
      },
      source: OwnTeam.PROMPT_SOURCE,
    },
    delivery: "queue",
  })
  if (!prompted.ok) {
    services.failed(area.teamID, { at: services.clock.now(), message: `send ${head.id}: ${prompted.message}` })
    return { kind: "waiting", why: "busy", dispatchID: head.id, failure: `보내지 못했어요: ${prompted.message}` }
  }
  return sent(services, head, owner)
}

/**
 * The notes (쪽지) held for the conversation `head` goes to (5.8). The ones chosen are written on its record first, so a
 * resend after a failed answer carries the same ones; they leave the store in {@link sent}.
 */
async function notesFor(
  services: Services.Context,
  area: OwnTeam.Area,
  head: OwnTeam.Dispatch,
): Promise<ReadonlyArray<OwnTeam.AreaNote>> {
  return services.write(head.teamID, async () => {
    const [talk, current, areas] = await Promise.all([
      Talk.load(services.kv, head.teamID),
      services.registry.dispatches.find(head.teamID, head.id),
      services.registry.areas.list(head.teamID),
    ])
    if (current?.state !== "waiting") return []
    const chosen = current.notes
    if (chosen !== undefined) return talk.notes.filter((note) => chosen.includes(note.id))
    const active = new Set<string>(areas.filter((item) => item.state === "active").map((item) => item.id))
    const held = Talk.held(talk, { areaID: area.id, to: head.to, now: services.clock.now(), active })
    if (held.length > 0) await services.registry.dispatches.put({ ...current, notes: held.map((note) => note.id) })
    return held
  })
}

/**
 * Marks the request `sent` (to `owner`, with its message id), drops the notes that went with it from the store, and
 * announces the outbox.
 */
async function sent(services: Services.Context, head: OwnTeam.Dispatch, owner: SessionID): Promise<Step> {
  await services.write(head.teamID, async () => {
    const current = await services.registry.dispatches.find(head.teamID, head.id)
    if (current?.state !== "waiting") return
    await services.registry.dispatches.put({
      ...current,
      state: "sent",
      sentTo: { sessionID: owner, msgID: MsgID.dispatch(head.id, owner), at: services.clock.now() },
    })
    const went = current.notes
    if (went === undefined || went.length === 0) return
    const talk = await Talk.load(services.kv, head.teamID)
    await Talk.save(services.kv, head.teamID, { ...talk, notes: talk.notes.filter((note) => !went.includes(note.id)) })
  })
  await changed(services, head.teamID, head.areaID)
  return { kind: "sent", dispatchID: head.id }
}
