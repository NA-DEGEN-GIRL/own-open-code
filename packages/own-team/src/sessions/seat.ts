export * as Seat from "./seat.js"

import fs from "node:fs/promises"
import { Option, Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Outbox } from "../dispatch/dispatch.js"
import { Talk } from "../dispatch/talk.js"
import { Adopt } from "../ops/adopt.js"
import { AreaCreate } from "../ops/area-create.js"
import { Journal } from "../ops/journal.js"
import { Steps } from "../ops/steps.js"
import { Undo } from "../ops/undo.js"
import { Wait } from "../ops/wait.js"
import { Settle } from "../reorg/settle.js"
import { Cursor } from "../report/cursor.js"
import { Digest } from "../report/digest.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import { Permissions } from "../tools/permissions.js"
import type { AccountsRpc } from "./accounts-rpc.js"
import type { SessionHttp } from "./http.js"
import { RoleInstructions } from "./instructions.js"
import { OwnerSession } from "./owner.js"
import { Peers } from "./peer.js"
import { SafePoint } from "./safe-point.js"
import { TeamContext } from "./team-context.js"

/**
 * 담당 대화 바꾸기 (`area.seat`, 2026-11-12): the owner seat of an area moves onto an existing root conversation of
 * the area's folder. Routing does not change (`area.owner.sessionID`, read when a request goes), no conversation is
 * made, no LLM turn runs and the conversation that leaves the seat is not archived: it stays an ordinary conversation
 * of the folder and may take the seat again. A `seat` op on the area (new main requests wait meanwhile:
 * `Outbox.maintaining`), its steps:
 *
 *   seat.wait      waits for the area's safe point, the queue of the conversation that takes the seat included; never
 *                  forced (취소, or 명령 멈추고 진행 for a command left running). The conversation is judged again on
 *                  every check ({@link eligible}): it can change while the op waits
 *   seat.requeue   main requests and area messages that were sent but never taken go back to the outbox, from the old
 *                  seat and from the conversation that takes it (a peer has a queue of its own); fails when a queue
 *                  cannot be read, and verifies that neither holds a team request
 *   seat.claim     the target, written ahead in `owner.release` (after any sweep from outside that began before
 *                  the op: {@link sweep}): archive mark off, team context on its own preset, the owner's team allows,
 *                  the program's handoff note (no LLM call) and the owner role entry
 *   seat.settle    asks the old seat took and has not answered: the asker is told (the notice an interrupted run
 *                  gives), then their `Talk` entries go. After the claim, so a conversation that cannot be claimed
 *                  costs the old seat none of its asks
 *   seat.swap      the registry write first: `owner.sessionID` = the target, the old seat in `previous`
 *                  (`why: "seat"`) and in `release`, every other owner field as it was; the area takes the target's
 *                  model and preset as an adopted area does. The target stays listed in `release` (and among the
 *                  peers, when it was one) until {@link complete} has done what follows the write: a promoted peer's
 *                  slot becomes the owner slot, a team note for the incoming seat and one line for the main's next
 *                  update (no wake). Whoever meets that mark later finishes it: the step again, a cancel, a sweep
 *   seat.release   always acts: `fresh` requests become plain ones, the peer entry of a promoted peer goes, the team
 *                  context is pushed, and {@link sweep} strips whoever is listed in `owner.release` without being the
 *                  owner. Never fails the op: what could not be stripped stays listed for a later sweep
 *
 * Every step observes the registry first, so an op whose process was killed goes on from the step it was in. An owner
 * that is neither the old seat nor the target fails the op where it is seen (the claim is taken back by the sweep that
 * follows every op). The old seat stays the owner until the swap; after it the registry refuses its team tool calls
 * (`previous-owner`), whether or not the sweep has reached it yet.
 */

export const KIND = {
  wait: "seat.wait",
  requeue: "seat.requeue",
  claim: "seat.claim",
  settle: "seat.settle",
  swap: "seat.swap",
  release: "seat.release",
} as const

const Args = Schema.Struct({ areaID: OwnTeam.AreaID, from: Schema.NullOr(SessionID), to: SessionID })
type Args = typeof Args.Type

const DONE: Steps.Outcome = { ok: true }
const STOPPED = "서비스가 닫혀 멈췄어요"
const GONE = "담당 대화가 그사이 바뀌었어요"
const UNKNOWN = "이 대화의 계정을 지금 확인할 수 없어요. 잠시 뒤 다시 해 주세요"
const RIVAL = "이 대화는 팀 메인과 같은 회사의 다른 구독 계정을 써요. 담당으로 두려면 그 대화의 계정을 바꿔 주세요"
const NO_ACCOUNT = "이 대화의 계정을 확인할 수 없어요. 모델을 고른 뒤 다시 해 주세요"
const TAKEN = "옛 담당 대화가 그사이 요청을 받았어요. 그 일이 끝난 뒤 다시 해 주세요"
const TAKEN_TARGET = "고른 대화가 그사이 요청을 받았어요. 그 일이 끝난 뒤 다시 해 주세요"
const TEAM_RIVAL =
  "이 대화는 팀이 이미 쓰는 계정과 같은 회사의 다른 구독 계정을 써요. 담당으로 두려면 그 대화의 계정을 바꿔 주세요"

/** Why a conversation cannot take the seat (`seat_invalid`), as the server says it. */
export const INVALID = {
  child: "하위 대화는 담당이 될 수 없어요",
  main: "팀 메인은 영역 담당이 될 수 없어요",
  owner: "이미 이 영역의 담당이에요",
  elsewhere: "이 영역의 폴더에 있는 대화만 담당이 될 수 있어요",
  account: NO_ACCOUNT,
  unknown: UNKNOWN,
} as const

/** Outside sweeps in flight, per controller and area (`teamID:areaID`): a claim waits for the one that began first. */
const outside = new WeakMap<object, Map<string, Promise<void>>>()

/** Why `Outbox.unfresh` made a `fresh` request a plain one (a line of the main's update). */
const CHOSEN = "사용자가 담당 대화를 직접 골랐어요"

export function create(services: Services.Context): Services.Seat {
  for (const kind of kinds()) services.steps.register(kind)
  const leftover = async (teamID: OwnTeam.TeamID) => {
    const areas = await services.registry.areas.list(teamID)
    for (const area of areas.filter((item) => (item.owner.release ?? []).length > 0))
      await sweep(services, { teamID, areaID: area.id })
  }
  // A seat op that failed leaves its claim listed in `owner.release` and is never retried; an op that retired an area
  // may have skipped the step that sweeps it. Whatever op ends, what is still listed in the team is swept.
  const stop = services.hub.subscribe((event) => {
    if (event.name !== "op.done") return
    void leftover(event.data.teamID).catch((error: unknown) =>
      services.log.warn("seat_sweep_failed", { teamID: event.data.teamID, error }),
    )
  })
  return {
    request: (input) => request(services, input),
    sweep: (input) => sweep(services, input),
    resume: async () => {
      const teams = await services.registry.teams.list()
      await Promise.all(teams.map((team) => leftover(team.id)))
    },
    close: async () => stop(),
  }
}

async function request(
  services: Services.Context,
  input: Parameters<Services.Seat["request"]>[0],
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired" || area.state === "retiring")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  if (area.state === "broken")
    return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  const able = await eligible(services, team, area, input.sessionID)
  if (!able.ok) return able
  const args: Args = { areaID: area.id, from: area.owner.sessionID, to: input.sessionID }
  const started = await services.runner.start({
    teamID: team.id,
    kind: "seat",
    by: input.by,
    areaID: area.id,
    steps: Object.values(KIND).map((kind) => ({ kind, args })),
    undo: { available: false },
  })
  if (!started.ok) return Services.failure("busy", "팀의 다른 작업이 진행 중이에요", Journal.busy(started.op))
  return { ok: true, opID: started.op.id }
}

/** What the area's seat would hold with this conversation in it. */
interface Held {
  /** The conversation's own preset in force, when it is of its model's group. */
  readonly used: Preset.Info | undefined
  /** The preset the area takes with the seat; `undefined` when the model has no group (the area keeps its own). */
  readonly preset: Preset.Info | undefined
  readonly binding: AccountsRpc.Output<"session.preset.get">["binding"]
  /** The team's R4 set once the seat has moved. */
  readonly after: TeamContext.State
}

/**
 * Whether a conversation may take the area's seat: a root conversation of the area's folder that is not the team
 * main, not this area's owner and no part of another area, and whose account passes R4 against the team main (as a
 * peer's does) and against the rest of the team with its own model and preset. A current peer of the area may (it is
 * promoted), and so may a conversation that held the seat before. Asked by the request, on every check of the wait,
 * and again by the claim and the swap: the conversation and its account can change while the op waits.
 */
export async function eligible(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  sessionID: SessionID,
): Promise<
  Services.Result<{ readonly session: SessionHttp.SessionView; readonly ref: Model.Ref; readonly held: Held }>
> {
  const session = await services.http.session.get({ sessionID, directory: area.directory })
  if (!session.ok)
    return session.status === 404
      ? Services.failure("not_found", "대화를 찾을 수 없어요", { what: "session", id: sessionID })
      : Services.failure("internal_error", `대화를 읽지 못했어요: ${session.message}`, {})
  if (session.value.parentID !== undefined) return Services.failure("seat_invalid", INVALID.child, { why: "child" })
  const [role, where] = await Promise.all([
    services.locate.session(sessionID),
    services.locate.directory(session.value.location.directory),
  ])
  if (role?.role === "main" || role?.role === "previous-main")
    return Services.failure("seat_invalid", INVALID.main, { why: "main" })
  if (role?.role === "owner" && role.team.id === team.id && role.area.id === area.id)
    return Services.failure("seat_invalid", INVALID.owner, { why: "owner" })
  if (where?.team.id !== team.id || where.area?.id !== area.id)
    return Services.failure("seat_invalid", INVALID.elsewhere, { why: "elsewhere" })
  if (role !== undefined && (role.team.id !== team.id || role.area.id !== area.id))
    return Services.failure("seat_invalid", INVALID.elsewhere, { why: "elsewhere" })
  const other = await Outbox.rival(services, team, area, sessionID)
  const snapshot = other === undefined ? undefined : await TeamContext.load(services, team.id)
  if (other === undefined || !snapshot) return Services.failure("seat_invalid", INVALID.unknown, { why: "unknown" })
  const ref = session.value.model
  if (other || !ref) {
    const account = ref && snapshot.account(ref.providerID)
    return account
      ? Services.failure("same_company_subscription", RIVAL, { accountID: account.id })
      : Services.failure("seat_invalid", INVALID.account, { why: "account" })
  }
  const view = await services.accounts.presetGet({ sessionID }, { directory: area.directory })
  if (!view.ok) return Services.failure("seat_invalid", INVALID.unknown, { why: "unknown" })
  const held = holding(snapshot, area, ref, view.value)
  const broken = TeamContext.breaks(snapshot.state, held.after)
  if (broken !== undefined) return Services.failure("same_company_subscription", TEAM_RIVAL, { accountID: broken })
  return { ok: true, session: session.value, ref, held }
}

/**
 * The area follows its seat, as an adopted area does: the conversation's own preset when it has one of its model's
 * group; else the group's ★ preset, or the built-in one when ★ would break R4. No preset is ever put on the
 * conversation to make it fit.
 */
function holding(
  snapshot: TeamContext.Snapshot,
  area: OwnTeam.Area,
  ref: Model.Ref,
  view: AccountsRpc.Output<"session.preset.get">,
): Held {
  const group = TeamContext.groupOf({ ref, account: snapshot.account(ref.providerID) })
  const used = view.preset && view.preset.group === group ? view.preset : undefined
  const star = group === undefined ? undefined : snapshot.preset(snapshot.group(group).star ?? Preset.builtinID(group))
  const fits =
    star !== undefined &&
    TeamContext.breaks(snapshot.state, TeamContext.change(snapshot, area.id, { ref, preset: star })) === undefined
  const preset = used ?? (group === undefined ? undefined : fits ? star : Preset.builtin(group))
  return {
    used,
    preset,
    binding: view.binding,
    after: TeamContext.change(snapshot, area.id, { ref, ...(preset === undefined ? {} : { preset }) }),
  }
}

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.wait, Args, {
      observe: async (args, input) => {
        const services = input.services
        const held = { directory: "" }
        const answer = await Wait.until<Steps.Observed>(input, {
          why: "safe-point",
          text: "지금 일이 끝나면 바꿔요",
          actions: Settle.START,
          wakes: (event) => Settle.FOLDER_EVENTS.some((prefix) => event.type.startsWith(prefix)),
          check: async (report) => {
            const [team, area] = await Promise.all([
              services.registry.teams.get(input.op.teamID),
              areaOf(input, args.areaID),
            ])
            const where = standing(area, args)
            if (where === "moved") return { state: "satisfied" }
            if (!team || !area || where === "gone") return { state: "failed", note: GONE }
            if (area.state === "broken") return { state: "failed", note: `'${area.name}' 영역이 멈춰 있어요` }
            const able = await eligible(services, team, area, args.to)
            // What cannot be read now (an account, a restarting service) may be readable in a moment.
            if (
              !able.ok &&
              (able.error === "internal_error" || (able.error === "seat_invalid" && able.data.why === "unknown"))
            ) {
              report({ text: able.message, actions: Settle.START })
              return undefined
            }
            if (!able.ok) return { state: "failed", note: able.message }
            const safe = await services.features().safePoint.check({
              teamID: input.op.teamID,
              areaID: area.id,
              also: [args.to],
              signal: input.signal,
            })
            if (safe.ok) return { state: "satisfied" }
            held.directory = area.directory
            report(Settle.reason(`${area.name}: `, safe))
            return undefined
          },
          // No `answer`: the move is never forced past a working conversation.
          force: {
            stopShell: async (shells) => {
              await SafePoint.stop(services, held.directory, shells)
            },
          },
        })
        return answer ?? { state: "failed", note: STOPPED }
      },
      act: async () => DONE,
      verify: async () => DONE,
    }),

    Steps.define(KIND.requeue, Args, {
      observe: async (args, input) => {
        const where = standing(await areaOf(input, args.areaID), args)
        if (where === "moved") return { state: "satisfied" }
        return where === "gone" ? { state: "failed", note: GONE } : { state: "pending" }
      },
      act: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        if (!area) return { ok: false, note: GONE }
        const queues = seats(args)
        const back = await Promise.all(
          queues.map((from) =>
            Outbox.requeue(input.services, {
              teamID: input.op.teamID,
              areaID: args.areaID,
              from,
              directory: area.directory,
            }),
          ),
        )
        // The note names the conversation that took it: the user waits for that one's work.
        const taker = queues.find((_, index) => (back[index]?.taken ?? 0) > 0)
        if (taker !== undefined) return { ok: false, note: taker === args.to ? TAKEN_TARGET : TAKEN }
        if (back.some((result) => !result.ok)) return { ok: false, note: "대화에 남은 요청을 되돌리지 못했어요" }
        const count = back.reduce((sum, result) => sum + result.count, 0)
        return count > 0 ? { ok: true, note: `요청 ${count}개는 바꾼 뒤 새 담당에게 보내요` } : DONE
      },
      verify: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        if (!area) return { ok: false, note: GONE }
        const queues = await Promise.all(
          seats(args).map((sessionID) =>
            input.services.http.inbox.list({ sessionID, directory: area.directory }, { signal: input.signal }),
          ),
        )
        // A conversation that is gone (404) holds nothing.
        const empty = queues.every((queue) =>
          queue.ok
            ? queue.value.every((item) => item.payload.metadata?.[OwnTeam.DISPATCH_META] === undefined)
            : queue.status === 404,
        )
        return empty ? DONE : { ok: false, note: "대화에 팀 요청이 아직 남아 있어요" }
      },
    }),

    Steps.define(KIND.claim, Args, {
      observe: async (args, input) => {
        const where = standing(await areaOf(input, args.areaID), args)
        if (where === "moved") return { state: "satisfied" }
        // The op ends here; the sweep that follows every op takes back a claim an earlier run of it made.
        return where === "gone" ? { state: "failed", note: GONE } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const teamID = input.op.teamID
        // 2026-11-14: one debug line per part (`seat_claim`), to see where a slow claim spends its time.
        const clock = { at: performance.now() }
        const part = (name: string) => {
          const now = performance.now()
          services.log.debug("seat_claim", { teamID, areaID: args.areaID, part: name, ms: Math.round(now - clock.at) })
          clock.at = now
        }
        // A sweep from outside that began before this op did may still be stripping this very conversation.
        await outside.get(services)?.get(`${teamID}:${args.areaID}`)
        part("outside")
        // Write-ahead: from here on a failure, a cancel or a kill leaves a record of who may hold owner things.
        const listed = await services.write(teamID, async () => {
          const current = await services.registry.areas.get(teamID, args.areaID)
          if (!current || standing(current, args) !== "ready") return undefined
          if ((current.owner.release ?? []).includes(args.to)) return current
          const next: OwnTeam.Area = {
            ...current,
            owner: { ...current.owner, release: [...(current.owner.release ?? []), args.to] },
          }
          await AreaCreate.save(services, next)
          return next
        })
        const team = await services.registry.teams.get(teamID)
        part("listed")
        if (!listed || !team) return { ok: false, note: GONE }
        const area = listed
        const where = { sessionID: args.to, directory: area.directory }
        const call = { signal: input.signal }
        const able = await eligible(services, team, area, args.to)
        part("eligible")
        if (!able.ok) return { ok: false, note: able.message }
        if (able.session.metadata?.[Undo.ARCHIVED] !== undefined) {
          const shown = await services.http.session.metadata(
            {
              ...where,
              change: (current) =>
                Object.fromEntries(Object.entries(decodeMetadata(current)).filter(([key]) => key !== Undo.ARCHIVED)),
            },
            call,
          )
          if (!shown.ok) return { ok: false, note: `보관해 둔 대화를 다시 꺼내지 못했어요: ${shown.message}` }
          part("archive")
        }
        if (input.signal.aborted) return { ok: false, note: STOPPED }
        const held = able.held
        const context: Preset.Team = {
          teamID,
          role: "owner",
          ...TeamContext.context(held.after, TeamContext.offenders(held.after)),
        }
        // Only the conversation's own preset is ever applied; one without a preset in force is left as it is.
        if (
          held.used &&
          !(held.binding?.presetID === held.used.id && TeamContext.holds(held.binding.team ?? undefined, context))
        ) {
          const applied = await services.accounts.presetApply(
            { sessionID: args.to, presetID: held.used.id, team: context },
            { directory: area.directory },
          )
          if (!applied.ok)
            return {
              ok: false,
              note:
                applied.type === "same_company_subscription"
                  ? TEAM_RIVAL
                  : `프리셋을 적용하지 못했어요: ${applied.message}`,
            }
          part("preset")
        }
        if (input.signal.aborted) return { ok: false, note: STOPPED }
        const allowed = await Permissions.write(services, { ...where, role: "owner" })
        part("allows")
        if (!allowed.ok) return { ok: false, note: allowed.message }
        if (input.signal.aborted) return { ok: false, note: STOPPED }
        // The program's handoff note (no LLM call), written while the old seat is still the owner; one this op wrote
        // before a kill is used again.
        if (!(area.handoff !== null && area.handoff.at >= input.op.createdAt)) {
          const made = await services.features().handoff.program({ teamID, areaID: args.areaID, seat: true })
          if (!made.ok) return { ok: false, note: made.message }
          const saved = await services
            .features()
            .handoff.write({ teamID, areaID: args.areaID, text: made.text, by: "program" })
          if (!saved.ok) return { ok: false, note: saved.message }
        }
        const handoff = await services.features().handoff.read({ teamID, areaID: args.areaID })
        if (handoff === undefined) return { ok: false, note: "인계 메모가 없어요" }
        if (input.signal.aborted) return { ok: false, note: STOPPED }
        const noted = await RoleInstructions.put(services, {
          ...where,
          key: RoleInstructions.HANDOFF,
          value: handoff,
          signal: input.signal,
        })
        part("handoff")
        if (!noted.ok) return { ok: false, note: noted.message }
        if (input.signal.aborted) return { ok: false, note: STOPPED }
        // Last: the entry that tells a conversation it is the owner.
        const told = await RoleInstructions.put(services, {
          ...where,
          key: RoleInstructions.OWNER,
          value: RoleInstructions.owner({
            team,
            area,
            blocks: await RoleInstructions.blocks(services.kv, services.log, teamID),
          }),
          signal: input.signal,
        })
        part("role")
        return told.ok ? DONE : { ok: false, note: told.message }
      },
      verify: async (args, input) => {
        const services = input.services
        const area = await areaOf(input, args.areaID)
        if (!area) return { ok: false, note: GONE }
        const where = { sessionID: args.to, directory: area.directory }
        const [session, entries] = await Promise.all([
          services.http.session.get(where, { signal: input.signal }),
          services.http.instructions.list(where, { signal: input.signal }),
        ])
        const actions: ReadonlySet<string> = new Set(Object.values(Permissions.ACTIONS))
        // The owner entry is there; its text is not compared: a settings or 팀 지시문 save between act and verify
        // would fail the move, and the owners' next `role` after `owner.stale` brings the text up to date.
        const ready =
          session.ok &&
          entries.ok &&
          (session.value.permissions ?? []).some((rule) => actions.has(rule.action)) &&
          entries.value.some((entry) => entry.key === RoleInstructions.OWNER)
        return ready ? DONE : { ok: false, note: "고른 대화를 담당으로 준비하지 못했어요" }
      },
    }),

    Steps.define(KIND.settle, Args, {
      observe: async (args, input) => {
        const where = standing(await areaOf(input, args.areaID), args)
        if (where === "moved" || args.from === null) return { state: "satisfied" }
        return where === "gone" ? { state: "failed", note: GONE } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const from = args.from
        const area = await areaOf(input, args.areaID)
        if (!area || from === null) return DONE
        // Whatever the follower can still read of the old seat is folded while it is the owner.
        await services.features().events.catchUp(input.op.teamID)
        const asks = await taken(services, input.op.teamID, args.areaID, from)
        // The notice first: a kill in between repeats it once; the other order could lose it.
        await Talk.settle(services, {
          teamID: input.op.teamID,
          sessionID: from,
          directory: area.directory,
          ended: asks.map((id) => ({ id, how: "interrupted" as const })),
        })
        await services.write(input.op.teamID, async () => {
          const state = await Talk.load(services.kv, input.op.teamID)
          const open = state.open.filter((item) => !asks.includes(item.id))
          if (open.length !== state.open.length) await Talk.save(services.kv, input.op.teamID, { ...state, open })
        })
        return asks.length > 0 ? { ok: true, note: `답하지 못한 물음 ${asks.length}개를 물은 쪽에 알렸어요` } : DONE
      },
      verify: async (args, input) => {
        if (args.from === null) return DONE
        const left = await taken(input.services, input.op.teamID, args.areaID, args.from)
        return left.length === 0 ? DONE : { ok: false, note: "옛 담당 대화가 받은 물음을 정리하지 못했어요" }
      },
    }),

    Steps.define(KIND.swap, Args, {
      observe: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        const where = standing(area, args)
        if (where === "gone") return { state: "failed", note: GONE }
        // A kill inside the swap leaves the seat moved and its conversation still listed: what follows is not done.
        return where === "moved" && !(area?.owner.release ?? []).includes(args.to)
          ? { state: "satisfied" }
          : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const teamID = input.op.teamID
        const [team, area] = await Promise.all([services.registry.teams.get(teamID), areaOf(input, args.areaID)])
        const where = standing(area, args)
        if (!team || !area || where === "gone") return { ok: false, note: GONE }
        if (where === "ready") {
          const able = await eligible(services, team, area, args.to)
          if (!able.ok) return { ok: false, note: able.message }
          const mark = await Adopt.watermark(services, { sessionID: args.to, directory: area.directory })
          if (!mark.ok) return { ok: false, note: `대화 기록을 읽지 못했어요: ${mark.message}` }
          const seated = await services.write(teamID, async () => {
            const current = await services.registry.areas.get(teamID, args.areaID)
            if (!current || standing(current, args) !== "ready") return false
            // A promoted peer is followed already; any other conversation is read from here on.
            if (Peers.of(current).every((item) => item.sessionID !== args.to) && mark.seq !== undefined)
              await Cursor.set(services.kv, args.to, mark.seq)
            // Every owner field the seat does not change stays (the user's note, and whatever is added later).
            const { pending, release: _release, ...kept } = current.owner
            // The registry first: the seat has moved once this is written, and nothing that tells of the move is
            // written before it. The target stays listed (and a peer, when it was one) until `complete` is through.
            await AreaCreate.save(services, {
              ...current,
              owner: {
                ...kept,
                sessionID: args.to,
                attached: true,
                previous: [
                  ...current.owner.previous.filter((item) => item.sessionID !== args.to),
                  ...(args.from === null
                    ? []
                    : [{ sessionID: args.from, endedAt: services.clock.now(), why: "seat" as const }]),
                ],
                ...(pending === undefined || pending === args.to ? {} : { pending }),
                release: [
                  ...(current.owner.release ?? []).filter((id) => id !== args.to && id !== args.from),
                  ...(args.from === null ? [] : [args.from]),
                  args.to,
                ],
              },
              // The area follows its seat, as an adopted area does: nothing is left for a later bind to apply.
              main: { model: able.ref, chosenBy: "adopted" },
              ...(able.held.preset === undefined ? {} : { preset: able.held.preset.id }),
            })
            return true
          })
          if (!seated) return { ok: false, note: GONE }
        }
        await complete(services, { teamID, areaID: args.areaID })
        const swapped = await areaOf(input, args.areaID)
        if (!swapped || standing(swapped, args) !== "moved") return { ok: false, note: GONE }
        input.summary({ kind: "area", areaID: args.areaID, change: "seated" })
        services.notices.publish({
          teamID,
          areaID: args.areaID,
          kind: "seat.moved",
          text: `${swapped.name}: 담당 대화를 바꿨어요.`,
          data: { sessionID: args.to, ...(args.from === null ? {} : { previous: args.from }) },
        })
        return DONE
      },
      verify: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        const seated =
          area !== undefined &&
          standing(area, args) === "moved" &&
          !(area.owner.release ?? []).includes(args.to) &&
          Peers.of(area).every((peer) => peer.sessionID !== args.to) &&
          area.owner.previous.every((item) => item.sessionID !== args.to)
        return seated ? DONE : { ok: false, note: "담당 대화가 바뀌지 않았어요" }
      },
    }),

    {
      ...Steps.define(KIND.release, Args, {
        // Always acts: the duties follow the swap's write, and a process killed right after it must still do them.
        observe: async () => ({ state: "pending" }),
        act: async (args, input) => {
          await finish(input.services, { teamID: input.op.teamID, areaID: args.areaID, to: args.to })
          return DONE
        },
        verify: async () => DONE,
      }),
      // A cancel after the claim takes the claim back; one after the swap completes the duties that follow it.
      cancel: async (input) => {
        const args = Option.getOrUndefined(decodeArgs(input.step.args))
        if (!args) return
        await finish(input.services, { teamID: input.op.teamID, areaID: args.areaID, to: args.to })
      },
    },
  ]
}

/**
 * What follows the swap's registry write, for an area whose seat is still listed in its own `owner.release` (the mark
 * that write leaves): a promoted peer's requests, messages and report slot become the owner's, the incoming seat gets
 * its team note, the main one line for its next update (no wake), and last the mark goes, with the peer record. Each
 * part is safe to repeat, so a kill anywhere leaves the mark and the next caller does it again: the swap step, the
 * release step or a cancel ({@link finish}), or a sweep after the op ended. `true` when there was something to do.
 */
async function complete(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID },
) {
  return services.write(input.teamID, async () => {
    const current = await services.registry.areas.get(input.teamID, input.areaID)
    const to = current?.owner.sessionID
    if (!current || !to || !(current.owner.release ?? []).includes(to)) return false
    const peer = Peers.of(current).find((item) => item.sessionID === to)
    const rest = Peers.of(current).filter((item) => item.sessionID !== to)
    const release = (current.owner.release ?? []).filter((id) => id !== to)
    const last = current.owner.previous.at(-1)
    const { release: _release, ...owner } = current.owner
    // SM-23: a promoted peer's role is kept as the 담당 메모 when the seat had none (both at most 1,024 characters).
    const note =
      (owner.note ?? "").trim() === "" && peer !== undefined && peer.role.trim() !== "" ? peer.role : undefined
    const next: OwnTeam.Area = {
      ...current,
      owner: { ...owner, ...(release.length === 0 ? {} : { release }), ...(note === undefined ? {} : { note }) },
      peers: rest.length === 0 ? undefined : rest,
      ...(peer?.direct !== undefined && (current.direct === undefined || peer.direct.at > current.direct.at)
        ? { direct: { at: peer.direct.at, sessionID: to } }
        : {}),
    }
    const sender = Talk.senderOf(next)
    const now = services.clock.now()
    if (peer !== undefined) {
      const dispatches = await services.registry.dispatches.list(input.teamID)
      await Promise.all(
        dispatches.flatMap((dispatch) => {
          const moved = promote(dispatch, next, peer.key, sender)
          return moved === dispatch ? [] : [services.registry.dispatches.put(moved)]
        }),
      )
    }
    const talk = await Talk.load(services.kv, input.teamID)
    const slots = peer === undefined ? talk : promoted(talk, next.id, peer.key, sender)
    const text = `이 대화가 '${next.name}' 영역의 담당을 다른 대화에서 넘겨받았다. 네가 묻지 않은 물음의 답(kind="reply")이 올 수 있다.`
    const mine = (note: OwnTeam.AreaNote) => note.areaID === next.id && note.to === undefined
    // Only when a conversation gave the seat away: the swap listed it for release with its `seat` entry.
    const handed = last?.why === "seat" && release.includes(last.sessionID)
    const added: ReadonlyArray<OwnTeam.AreaNote> =
      !handed || slots.notes.some((note) => mine(note) && note.from === "team" && note.text === text)
        ? []
        : [{ id: OwnTeam.AreaNoteID.create(), areaID: next.id, sender, from: "team", text, at: now }]
    const kept = [...slots.notes.filter(mine), ...added].toSorted((a, b) => a.at - b.at).slice(-Talk.NOTES_PER_TARGET)
    await Talk.save(services.kv, input.teamID, {
      ...slots,
      notes: [...slots.notes.filter((note) => !mine(note)), ...kept].toSorted((a, b) => a.at - b.at),
    })
    const digest = await Digest.load(services.kv, input.teamID)
    const folded =
      peer === undefined
        ? digest
        : Fold.withArea(digest, next.id, (fold) =>
            fold.peers === undefined
              ? fold
              : { ...fold, peers: Object.fromEntries(Object.entries(fold.peers).filter(([key]) => key !== peer.key)) },
          )
    // One line for the main's next update; it never wakes the main. The key is the move's (who took the seat, and
    // when the one before left it), so doing this again adds no second line.
    await Digest.save(
      services.kv,
      Fold.append(
        folded,
        Fold.entry({
          at: now,
          reason: "seated",
          areaID: next.id,
          // A promoted peer: the main may still hold its key, and a `member` request to it would now be refused.
          text: `'${next.name}' 영역의 담당이 사용자가 고른 다른 대화로 바뀌었습니다. 요청은 전처럼 그 영역으로 보내면 됩니다.${
            peer === undefined
              ? ""
              : ` 동료 ${peer.label}(${peer.key})이(가) 담당이 되어 동료에서 빠졌습니다. 그 동료에게 맡기던 일은 member 없이 영역으로 보내세요.`
          }`,
        }),
        `seat:${next.id}:${to}:${last?.endedAt ?? 0}`,
      ),
    )
    // The mark last: a kill before it leaves the seat listed and all of this runs again.
    await AreaCreate.save(services, next)
    return true
  })
}

/**
 * Strips every conversation listed in the area's `owner.release` of what an owner holds, by its role now: the owner
 * (and a team main) keeps everything, a peer keeps its allows and its peer entry, any other conversation loses the
 * team allows, the role entries and the team context. A conversation that was stripped, or is gone, leaves the list;
 * one that could not be reached stays for a later sweep. Idempotent, and it never fails its caller. A swap that an op
 * left unfinished is finished first ({@link complete}, then what follows a swap).
 *
 * `inside`: the caller is a step of the op that holds the area. Any other caller skips an area an op maintains:
 * between a seat op's claim and its swap the target is listed without being the owner yet, and a sweep from outside
 * would strip the conversation the op is about to seat. Outside sweeps of one area run one after another, and a claim
 * waits for the one in flight (`outside`): a sweep that began before the op did never strips what the claim wrote.
 */
export async function sweep(services: Services.Context, input: Parameters<Services.Seat["sweep"]>[0]) {
  if (input.inside === true) return strip(services, input)
  const turns = outside.get(services) ?? new Map<string, Promise<void>>()
  outside.set(services, turns)
  const key = `${input.teamID}:${input.areaID}`
  const turn = (turns.get(key) ?? Promise.resolve()).then(async () => {
    if (Outbox.maintaining(await services.journal.active(input.teamID), input.areaID, services.steps)) return
    await strip(services, input)
  })
  const tail = turn.catch(() => undefined)
  turns.set(key, tail)
  void tail.then(() => {
    if (turns.get(key) === tail) turns.delete(key)
  })
  return turn
}

async function strip(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID },
) {
  if (await complete(services, input)) await seated(services, input)
  const [team, area] = await Promise.all([
    services.registry.teams.get(input.teamID),
    services.registry.areas.get(input.teamID, input.areaID),
  ])
  const listed = area?.owner.release ?? []
  if (!team || !area || listed.length === 0) return
  // A folder that is gone has no Location; the home serves a request about its conversations.
  const present = await fs.lstat(area.directory).then(
    () => true,
    () => false,
  )
  const directory = present ? area.directory : team.home.directory
  const keys = [RoleInstructions.OWNER, RoleInstructions.HANDOFF]
  const done = (
    await Promise.all(
      listed.map(async (sessionID) => {
        const found = await services.locate.session(sessionID)
        if (found?.role === "owner" || found?.role === "main") return [sessionID]
        const stripped = await OwnerSession.strip(
          services,
          found?.role === "peer"
            ? // A registered peer has no team context of its own; a created one is bound again by the push below.
              {
                sessionID,
                directory,
                keys,
                allows: !found.peer.attached,
                context: found.peer.origin === "registered",
              }
            : { sessionID, directory, keys: [...keys, RoleInstructions.PEER], allows: true, context: true },
        ).catch((error: unknown): Services.Result => Services.failure("internal_error", String(error), {}))
        if (stripped.ok || stripped.error === "not_found") return [sessionID]
        services.log.warn("seat_release_kept", {
          teamID: input.teamID,
          areaID: area.id,
          sessionID,
          message: stripped.message,
        })
        return []
      }),
    )
  ).flat()
  if (done.length > 0)
    await services.write(input.teamID, async () => {
      const current = await services.registry.areas.get(input.teamID, input.areaID)
      if (!current) return
      const release = (current.owner.release ?? []).filter((id) => !done.includes(id))
      const { release: _release, ...owner } = current.owner
      await AreaCreate.save(services, {
        ...current,
        owner: { ...owner, ...(release.length === 0 ? {} : { release }) },
      })
    })
  await services.features().teamContext.push(input.teamID)
}

/**
 * What the release step does once the seat has moved, each part safe to repeat: a waiting `fresh` request goes as a
 * plain one, a promoted peer's peer entry goes, the team context is pushed and the outbox looks again.
 */
async function seated(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID },
) {
  const area = await services.registry.areas.get(input.teamID, input.areaID)
  const to = area?.owner.sessionID
  if (!area || !to) return
  // A `fresh` request that waits would replace the conversation the user just chose: it goes as a plain one.
  const plain = async (): Promise<void> => {
    const changed = await Outbox.unfresh(services, { ...input, why: CHOSEN, wake: false })
    if (changed) return plain()
  }
  await plain()
  const where = { sessionID: to, directory: area.directory }
  const entries = await services.http.instructions.list(where)
  // A promoted peer: the owner entry is its role now.
  if (entries.ok && entries.value.some((entry) => entry.key === RoleInstructions.PEER))
    await services.http.instructions.remove({ ...where, key: RoleInstructions.PEER })
  await services.features().teamContext.push(input.teamID)
  await Outbox.changed(services, input.teamID, input.areaID)
}

/**
 * The release step and a cancel: when the seat is the op's target, what its swap left unfinished ({@link complete})
 * and what follows a swap ({@link seated}); then the sweep. When the area's owner is not `to` (the swap never
 * happened) only the sweep runs, which takes the claim back.
 */
async function finish(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly to: SessionID },
) {
  const done = async () => {
    const area = await services.registry.areas.get(input.teamID, input.areaID)
    if (area?.owner.sessionID === input.to) {
      await complete(services, input)
      await seated(services, input)
    }
    await sweep(services, { teamID: input.teamID, areaID: input.areaID, inside: true })
  }
  await done().catch((error: unknown) =>
    services.log.warn("seat_finish_failed", { teamID: input.teamID, areaID: input.areaID, error }),
  )
}

/** A promoted peer's requests and messages: what waited for it goes to the owner slot, what it sent is the owner's. */
function promote(dispatch: OwnTeam.Dispatch, area: OwnTeam.Area, key: string, owner: OwnTeam.Sender) {
  if (dispatch.state === "cancelled") return dispatch
  const sent = dispatch.sender?.areaID === area.id && dispatch.sender.peer?.key === key
  const held = dispatch.state === "waiting" && dispatch.areaID === area.id && dispatch.to === key
  if (!sent && !held) return dispatch
  const { to: _to, ...rest } = dispatch
  const moved: OwnTeam.Dispatch = { ...(held ? rest : dispatch), ...(sent ? { sender: owner } : {}) }
  // What the peer and the owner had waiting for each other would now go from the seat to itself.
  const self =
    moved.state === "waiting" &&
    moved.areaID === area.id &&
    moved.to === undefined &&
    moved.sender?.areaID === area.id &&
    moved.sender.peer === undefined
  return self ? { ...moved, state: "cancelled" as const } : moved
}

/** The area messages of a promoted peer: its slot becomes the owner slot. */
function promoted(state: Talk.State, areaID: OwnTeam.AreaID, key: string, owner: OwnTeam.Sender): Talk.State {
  const slot = (item: Talk.Slot): Talk.Slot => (item.areaID === areaID && item.peer === key ? { areaID } : item)
  const sender = (item: OwnTeam.Sender) => (item.areaID === areaID && item.peer?.key === key ? owner : item)
  const watches = state.watches.map((watch) => ({ ...watch, watcher: sender(watch.watcher) }))
  return {
    ...state,
    // An ask between the peer and the owner has both ends in one conversation now.
    open: state.open
      .map((item) => ({ ...item, from: slot(item.from), to: slot(item.to) }))
      .filter((item) => !Talk.same(item.from, item.to)),
    // One watch per watcher, area and event: the newer one stays.
    watches: watches.filter(
      (watch, index) =>
        !watches.some(
          (other, at) =>
            at !== index &&
            Talk.same(Talk.from(other.watcher), Talk.from(watch.watcher)) &&
            other.areaID === watch.areaID &&
            other.on === watch.on &&
            (other.at > watch.at || (other.at === watch.at && at > index)),
        ),
    ),
    notes: state.notes.map((note) => {
      const from = { ...note, sender: sender(note.sender) }
      if (note.areaID !== areaID || note.to !== key) return from
      const { to: _to, ...rest } = from
      return rest
    }),
  }
}

/**
 * The asks the old seat took and has not settled: `Talk` entries to the owner slot that were delivered in it, or
 * whose request is still `sent` to it after the requeue step (taken, its delivery not folded yet).
 */
async function taken(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID, from: SessionID) {
  const [state, dispatches] = await Promise.all([
    Talk.load(services.kv, teamID),
    services.registry.dispatches.list(teamID),
  ])
  return state.open
    .filter(
      (item) =>
        item.to.areaID === areaID &&
        item.to.peer === undefined &&
        (item.delivered === from ||
          dispatches.some(
            (dispatch) => dispatch.id === item.id && dispatch.state === "sent" && dispatch.sentTo?.sessionID === from,
          )),
    )
    .map((item) => item.id)
}

/** The conversations whose queue the move empties of team requests: the old seat and the one that takes it. */
function seats(args: Args) {
  return [args.from, args.to].filter((id): id is SessionID => id !== null)
}

/** `ready`: the old seat still holds the area; `moved`: the target does; `gone`: something else changed it. */
function standing(area: OwnTeam.Area | undefined, args: Args) {
  if (!area || area.state === "retired" || area.state === "retiring") return "gone"
  if (area.owner.sessionID === args.to) return "moved"
  return area.owner.sessionID === args.from ? "ready" : "gone"
}

function areaOf(input: Steps.Input, areaID: OwnTeam.AreaID) {
  return input.services.registry.areas.get(input.op.teamID, areaID)
}

const decodeArgs = Schema.decodeUnknownOption(Args)

const decodeMetadata = (value: unknown) =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(value), () => ({}))
