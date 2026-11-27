export * as Disable from "./disable.js"

import fs from "node:fs"
import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { AssetsVerify } from "../assets/verify.js"
import { Talk } from "../dispatch/talk.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import { Verify } from "../integrate/verify.js"
import { Retire } from "../reorg/retire.js"
import { RemoteLfs } from "../remote/lfs.js"
import { Services } from "../services.js"
import { TeamHome } from "./home.js"
import type { Steps } from "./steps.js"
import { Journal } from "./journal.js"

/**
 * `disable{teamID, cleanup?}` (06 §3.8 끄기) as a `disable` op. `그대로 두고 끄기`:
 *
 *   disable.state    the team record goes `off`: team tools answer `팀 모드가 꺼져 있습니다` (permissions are not
 *                    rewritten, so the tool catalog does not change) and no main request is sent any more
 *   disable.outbox   waiting main requests become `cancelled` and are listed on the card; they are the main's
 *                    instructions, still in the main conversation, and turning the team on again never revives them
 *   disable.queued   main requests still in an owner's (or an area peer's) queue are counted for `[담당 대기열의 메인 요청
 *                    n개 지우기]`
 *   disable.peers    each area's attached peers (동료) lose their team allows and role entry; the records stay, so
 *                    turning the team on again attaches them at their next main request
 *   team.release     each area folder's and the linked home's own lock is released (also a retired area's folder that a
 *                    `두기` kept), except a folder with worktrees nested inside, which keeps a lock with the reason
 *                    `own: nested worktrees inside`; so are the locks of own's check folders `.verify` and `.assets`
 *                    (no user work in them): the worktree panel can then remove them, which is how the `.assets`
 *                    confirm says to undo it (06 §9.7). Turning the team on again locks them again before use
 *   lfs-restore      on an SSH host, the repository's LFS filter as it was before own's (`remote/lfs.ts`, 4.13)
 *
 * Sessions, branches, worktrees and instruction entries stay. Turning the team on again converges on the same records
 * (`enable`).
 *
 * `cleanup: true` (끝난 영역 정리하고 끄기): every active area whose commits are all in the target and whose folder is
 * clean, and that had commits of its own (`Retire.facts`: V13's rule without its 7 days), is retired by 8.2 and 8.6 in
 * one op whose first step `disable.cleanup` marks it; all its removals are asked at once (own-web shows them in one
 * dialog, each bound to its own list). An area away from its safe point is left out with a `skipped` line. Once that op
 * ended (every removal answered; a removal that failed leaves its folder and the others still go), {@link after} turns
 * the team off with the steps above. Without such an area it is the plain disable at once. `areas` limits the
 * retirements to the areas a voice plan named ({@link finished} when it was shown, 06 §2.9).
 */

/** The marker step of 끝난 영역 정리하고 끄기's op (it does nothing itself). */
export const CLEANUP = "disable.cleanup"

export async function start(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly cleanup?: boolean
    /**
     * With `cleanup`: only these finished areas are retired (`team_control{action: "disable"}` binds the ones its
     * plan named, 06 §2.9); absent = every finished area.
     */
    readonly areas?: ReadonlyArray<OwnTeam.AreaID>
  },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  if (input.cleanup === true) return cleanup(services, team, input.areas)
  return off(services, team, [])
}

/**
 * The areas 끝난 영역 정리하고 끄기 retires (3.8): active, with commits of their own, all of them in the target, and a
 * clean folder (`Retire.facts`: V13's rule without its 7 days). Whether each is at its safe point is decided when the
 * op starts.
 */
export async function finished(services: Services.Context, team: OwnTeam.Team): Promise<ReadonlyArray<OwnTeam.Area>> {
  const now = services.clock.now()
  const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state === "active")
  const checked = await Promise.all(
    areas.map(async (area) => ({ area, facts: await Retire.facts({ team, area, now }) })),
  )
  return checked.flatMap((item) =>
    item.facts !== undefined && item.facts.commits > 0 && item.facts.unapplied === 0 && item.facts.clean
      ? [item.area]
      : [],
  )
}

/** Whether `op` is the op of 끝난 영역 정리하고 끄기. */
export function cleaning(op: OwnTeam.Op) {
  return op.kind === "disable" && op.steps[0]?.kind === CLEANUP
}

/**
 * 끝난 영역 정리하고 끄기 after its retirements: once its op ended (done, or failed: a removal that failed leaves its
 * folder, which is safe) and no op came after it, the team goes off. Called when the op ends and on resume.
 */
export async function after(services: Services.Context, op: OwnTeam.Op) {
  if (!cleaning(op) || (op.state !== "done" && op.state !== "failed")) return
  const team = await services.registry.teams.get(op.teamID)
  if (!team || team.state !== "on") return
  if ((await services.journal.list(team.id)).at(-1)?.id !== op.id) return
  const started = await off(services, team, [])
  if (!started.ok) services.log.warn("cleanup_disable_failed", { teamID: team.id, error: started.error })
}

/** {@link after} for every team that is on (a controller stopped between the cleanup and its disable). */
export async function resume(services: Services.Context) {
  const teams = (await services.registry.teams.list()).filter((team) => team.state === "on")
  await Promise.all(
    teams.map(async (team) => {
      const last = (await services.journal.list(team.id)).at(-1)
      if (last) await after(services, last)
    }),
  )
}

async function cleanup(
  services: Services.Context,
  team: OwnTeam.Team,
  only: ReadonlyArray<OwnTeam.AreaID> | undefined,
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  services.features().reorg.register()
  const active = await services.journal.active(team.id)
  if (active) return busy(team.id, active)
  const done = (await finished(services, team)).filter((area) => only === undefined || only.includes(area.id))
  // 3.8: an area that is working now is left out (a skipped line) rather than waited for.
  const safe = await Promise.all(
    done.map((area) => services.features().safePoint.check({ teamID: team.id, areaID: area.id })),
  )
  const retiring = done.filter((_, index) => safe[index]?.ok === true)
  const busyLines = done.flatMap((area, index): OwnTeam.SummaryLine[] =>
    safe[index]?.ok === true ? [] : [{ kind: "skipped", item: area.id, areaID: area.id, why: "busy" }],
  )
  const planned = await Promise.all(retiring.map((area) => Retire.plan(services, { team, area, by: "user" })))
  const steps = planned.flatMap((result) => (result.ok ? result.steps : []))
  const lines = [
    ...busyLines,
    ...planned.flatMap((result, index): OwnTeam.SummaryLine[] => {
      if (result.ok) return [...result.lines]
      const area = retiring[index]
      if (!area) return []
      const why = result.error === "not_safe_point" ? "busy" : result.error === "broken" ? "broken" : "invalid"
      return [{ kind: "skipped", item: area.id, areaID: area.id, why }]
    }),
  ]
  if (steps.length === 0) return off(services, team, lines)
  const started = await services.runner.start({
    teamID: team.id,
    kind: "disable",
    by: "user",
    undo: { available: false },
    steps: [{ id: "cleanup", kind: CLEANUP, args: { areaIDs: retiring.map((area) => area.id) } }, ...steps],
    summary: { lines },
  })
  if (!started.ok) return busy(team.id, started.op)
  return { ok: true, opID: started.op.id }
}

/** `그대로 두고 끄기` (see the module comment); `lines` start its card. */
async function off(
  services: Services.Context,
  team: OwnTeam.Team,
  lines: ReadonlyArray<OwnTeam.SummaryLine>,
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const [waiting, areas] = await Promise.all([
    services.registry.dispatches.waiting(team.id),
    services.registry.areas.list(team.id),
  ])
  const started = await services.runner.start({
    teamID: team.id,
    kind: "disable",
    by: "user",
    undo: { available: false },
    ...(lines.length === 0 ? {} : { summary: { lines } }),
    steps: [
      { id: "state", kind: "disable.state" },
      {
        id: "outbox",
        kind: "disable.outbox",
        // Written ahead: a resumed step still lists what it cancelled.
        args: { waiting: waiting.map((item) => ({ areaID: item.areaID, dispatchID: item.id })) },
      },
      { id: "queued", kind: "disable.queued" },
      // Area peers (동료) go back to being the user's conversations: their team allows and role come off.
      ...areas
        .filter((area) => area.state !== "retired" && (area.peers ?? []).some((peer) => peer.attached))
        .map((area) => ({ id: `peers:${area.id}`, kind: PEERS, args: { areaID: area.id } })),
      ...(team.home.linked
        ? [
            {
              id: "release:home",
              kind: "team.release",
              args: { directory: team.home.directory, reason: TeamHome.reason(team.id) },
            },
          ]
        : []),
      ...areas
        // A retired area's folder kept by `두기` still has own's lock: TI-12 releases it only right before a removal.
        .filter((area) => area.state !== "retired" || fs.existsSync(area.directory))
        .map((area) => ({
          id: `release:${area.id}`,
          kind: "team.release",
          args: { directory: area.directory, reason: Worktree.lockReason(area.id) },
        })),
      // own's check folders hold no user work; unlocked, the worktree panel can remove them (9.7 how to undo).
      {
        id: "release:verify",
        kind: "team.release",
        args: { directory: Verify.directory(team), reason: Verify.LOCK_REASON },
      },
      {
        id: "release:assets",
        kind: "team.release",
        args: { directory: AssetsVerify.directory(team), reason: AssetsVerify.LOCK_REASON },
      },
      // 4.13: on an SSH host the repository's own LFS filter comes back.
      ...(Git.tools() === undefined ? [] : [RemoteLfs.restoreSpec({ directory: team.home.directory })]),
    ],
  })
  if (!started.ok) return busy(team.id, started.op)
  return { ok: true, opID: started.op.id }
}

function busy(teamID: OwnTeam.TeamID, op: OwnTeam.Op) {
  return Services.failure("busy", "another team op is running", Journal.busy(op))
}

/** The step that detaches an area's attached peers (동료). */
export const PEERS = "disable.peers"

/** Registers the `disable` op's kinds (from `ops/undo.ts`, once per controller). */
export function register(services: Services.Context) {
  services.steps.register(cleanupKind())
  services.steps.register(stateKind())
  services.steps.register(outboxKind())
  services.steps.register(queuedKind())
  services.steps.register(peersKind())
}

const PeersArgs = Schema.Struct({ areaID: OwnTeam.AreaID })
const decodePeers = Schema.decodeUnknownSync(PeersArgs)

/** Every attached peer of the area loses its team allows and role entry (one delta each); the records stay. */
function peersKind(): Steps.Kind {
  const attached = async (input: Steps.Input) => {
    const area = await input.services.registry.areas.get(input.op.teamID, decodePeers(input.step.args).areaID)
    return (area?.peers ?? []).some((peer) => peer.attached)
  }
  return {
    kind: PEERS,
    observe: async (input) => ((await attached(input)) ? { state: "pending" } : { state: "satisfied" }),
    act: async (input) => {
      const detached = await input.services.features().peers.detach({
        teamID: input.op.teamID,
        areaID: decodePeers(input.step.args).areaID,
        signal: input.signal,
      })
      return detached.ok ? { ok: true } : { ok: false, note: detached.message }
    },
    verify: async (input) =>
      (await attached(input)) ? { ok: false, note: "동료의 팀 설정이 남아 있어요" } : { ok: true },
  }
}

/** The marker of 끝난 영역 정리하고 끄기's op: nothing to do; its op ending is what counts ({@link after}). */
function cleanupKind(): Steps.Kind {
  return {
    kind: CLEANUP,
    observe: async () => ({ state: "satisfied" }),
    act: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
  }
}

const Waiting = Schema.Struct({
  waiting: Schema.Array(Schema.Struct({ areaID: OwnTeam.AreaID, dispatchID: OwnTeam.DispatchID })),
})
const decodeWaiting = Schema.decodeUnknownSync(Waiting)

function stateKind(): Steps.Kind {
  const team = async (input: Steps.Input) => {
    const found = await input.services.registry.teams.get(input.op.teamID)
    if (!found) throw new Error(`팀 기록이 없어요: ${input.op.teamID}`)
    return found
  }
  return {
    kind: "disable.state",
    observe: async (input) => ((await team(input)).state === "off" ? { state: "satisfied" } : { state: "pending" }),
    act: async (input) => {
      const written = await input.services.write(input.op.teamID, async () =>
        input.services.registry.teams.put({ ...(await team(input)), state: "off" }),
      )
      input.services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
      return { ok: true }
    },
    verify: async (input) =>
      (await team(input)).state === "off" ? { ok: true } : { ok: false, note: "팀 모드를 끄지 못했어요" },
  }
}

function outboxKind(): Steps.Kind {
  return {
    kind: "disable.outbox",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const args = decodeWaiting(input.step.args)
      const teamID = input.op.teamID
      const cancelled = await input.services.features().admit.cancelAll({ teamID })
      // What the outbox service left waiting (an older build of it) is cancelled here: the team is off already.
      const left = await input.services.write(teamID, async () => {
        const waiting = await input.services.registry.dispatches.waiting(teamID)
        await Promise.all(
          waiting.map((item) => input.services.registry.dispatches.put({ ...item, state: "cancelled" })),
        )
        // A team turned off keeps no notes, watches or open asks between areas (06 §5.8, 3.8: nothing revives).
        await Talk.save(input.services.kv, teamID, Talk.empty())
        return waiting
      })
      for (const areaID of new Set(left.map((item) => item.areaID)))
        input.services.hub.publish({ name: "outbox.changed", data: { teamID, areaID, waiting: 0 } })
      const listed = [
        ...args.waiting,
        ...cancelled,
        ...left.map((item) => ({ areaID: item.areaID, dispatchID: item.id })),
      ]
      const records = await Promise.all(
        listed
          .filter((item, index, all) => all.findIndex((other) => other.dispatchID === item.dispatchID) === index)
          .map(async (item) => ({
            item,
            record: await input.services.registry.dispatches.find(teamID, item.dispatchID),
          })),
      )
      for (const found of records)
        if (found.record?.state === "cancelled")
          input.summary({ kind: "cancelled", areaID: found.item.areaID, dispatchID: found.item.dispatchID })
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}

/** Main requests (`own.dispatch` metadata) still undelivered in each owner's queue (3.8). */
function queuedKind(): Steps.Kind {
  return {
    kind: "disable.queued",
    observe: async () => ({ state: "pending" }),
    act: async (input) => {
      const areas = await input.services.registry.areas.list(input.op.teamID)
      const counted = await Promise.all(
        areas.flatMap((area) => {
          if (area.state === "retired") return []
          // The owner's queue and each area peer's (동료).
          const sessions = [area.owner.sessionID, ...(area.peers ?? []).map((peer) => peer.sessionID)]
          return sessions.flatMap((sessionID) => {
            if (sessionID === null) return []
            return [
              input.services.http.inbox.list({ sessionID, directory: area.directory }).then((listed) => {
                if (!listed.ok) {
                  input.services.log.warn("disable_inbox_unreadable", { areaID: area.id, type: listed.type })
                  return []
                }
                const count = listed.value.filter(
                  (item) => item.payload.metadata?.[OwnTeam.DISPATCH_META] !== undefined,
                ).length
                return count === 0 ? [] : [{ kind: "queued" as const, areaID: area.id, sessionID, count }]
              }),
            ]
          })
        }),
      )
      for (const line of counted.flat()) input.summary(line)
      return { ok: true }
    },
    verify: async () => ({ ok: true }),
  }
}
