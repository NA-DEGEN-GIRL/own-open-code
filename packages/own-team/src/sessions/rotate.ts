export * as Rotation from "./rotate.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { type Approval, OwnTeam } from "@own/protocol"
import { OwnHarnessRouting } from "@own/protocol/rpc-harness-routing"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Release } from "../assets/release.js"
import { Direct } from "../dispatch/direct.js"
import { Outbox } from "../dispatch/dispatch.js"
import { Handoff } from "../docs/handoff.js"
import { AreaCreate } from "../ops/area-create.js"
import { Steps } from "../ops/steps.js"
import { Undo } from "../ops/undo.js"
import { Wait } from "../ops/wait.js"
import { Settle } from "../reorg/settle.js"
import { Services } from "../services.js"
import type { SessionHttp } from "./http.js"
import { RoleInstructions } from "./instructions.js"
import { MainSession } from "./main.js"
import { OwnerSession } from "./owner.js"
import { SafePoint } from "./safe-point.js"
import { OwnerTurn } from "./turn.js"
import { Journal } from "../ops/journal.js"

/**
 * Owner conversation rotation (06 §6.1–6.2) and 메인 새 대화 (6.5). A conversation is replaced only at a semantic
 * boundary: a `fresh` main request (`team_dispatch{fresh:true}`, asked by `dispatch/dispatch.ts` before the request
 * goes in), the user's 새 대화로 이어가기 (`area.rotate`), an area or team account change (10.1), a worktree change, or
 * the adopted R4 exception. Never by its size: nothing here reads tokens or windows, and own.team never calls
 * `session.compact` (U6, 07 P-D8); long conversations are core's auto-compaction at 90% of the model window.
 *
 * An owner rotation is a `rotate` op on the area (new main requests wait meanwhile: `maintaining`, 5.1), its steps:
 *
 *   rotate.begin     waits for the area's safe point (8.4; TI-9: a user rotation waits); an automatic one (`by` main or
 *                    auto, reason `fresh` and the like) is skipped with every later step while Main 멈춤 is on
 *                    (TI-13), user and account rotations run regardless
 *   rotate.handoff   warm: `<team-request kind="handoff">` as a queued synthetic message (metadata `source: own.team`)
 *                    to the old owner, then the turn's end; the owner's `team_handoff{text}` writes the document.
 *                    Program handoff (no LLM call, `docs/handoff.ts`) when the turn ends without one, when the handoff
 *                    is `program` (`멈추고 바꾸기`, the adopted R4 exception), when the old owner is an adopted
 *                    conversation that never got the team, or when the old account is BLOCKED
 *   rotate.owner     the new owner (`sessions/owner.ts`: write-ahead `owner.pending`, `session.create` on the area
 *                    main ?? the team main's current Ref and the old owner's 에이전트 방식 (2026-10-26), approval with
 *                    the old owner's mode and never `computerUse`,
 *                    `session.preset.apply{area.preset, team}` with ultra off, `own.team.role` + `own.team.handoff`)
 *   rotate.swap      registry: `owner.sessionID` = pending, the old one in `previous` with the reason, `pending`
 *                    cleared; result line `rotated`, notice `rotation.done`; the folders the old owner fetched go at
 *                    the area's next extended safe point (`Release.afterRotate`, 4.7: after this op, never under
 *                    Main 멈춤)
 *   rotate.archive   the old conversation leaves the team: its binding's `team` cleared (`session.preset.apply{team:
 *                    null}`), metadata `own.archived: true` (read-modify-write); permissions untouched (delta 0)
 *
 * The old owner stays the area's owner until the swap, so its reports and `team_handoff` in the rotation window are
 * accepted and its team tool calls after the swap are refused (`tools/owner.ts`); what the user types into the old
 * conversation stays there. When the op ends (`op.done`) the waiting main requests go to the new owner (5.1), or keep
 * waiting while Main 멈춤 is on. Ops that rotate several areas at once (`team.account`, 10.1) put {@link steps} of
 * each area into their own op: every `prepare` part (safe point, handoff on the old account), then their own steps,
 * then every `replace` part.
 *
 * 메인 새 대화 is a team-wide `rotate` op: the main's tree idle, a new main on the current main's account, model,
 * effort, preset and 에이전트 방식 (ultra off, the old approval mode, no computer use), the registry swap, and the old
 * main archived.
 *
 * RH-20, so that a rotation never holds the team's one op slot for good, and says why it waits:
 * - Every wait goes through `ops/wait.ts` (`op.cancel` ends it; the card and `team_status` show why and since when).
 * - rotate.begin: a safe point that only commands or terminals left running hold (a dev server, a watcher) is skipped
 *   for a `fresh` rotation after {@link BACKGROUND_MS}: the request goes to the current owner as a plain request
 *   (`Outbox.unfresh`) with a team note; the r4 rotation goes on (its handoff is the program's, and nobody works in the
 *   folder). A user's rotation offers 명령 멈추고 진행 (`op.force{stop-shell}`) and 바로 진행 instead. Any other hold
 *   (a working conversation, a permission or question, queued input, git) offers only 취소 (RH-32, `Settle.reason`).
 * - rotate.handoff: input the user or the team parked in the old owner's queue (`SafePoint.work`) makes it the
 *   program's handoff, so no turn runs that input in a conversation about to be replaced (6.2: it stays there; the
 *   rotation's notice counts it); a main request that was sent but never taken goes back to the outbox for the new
 *   owner (`Outbox.requeue`). The warm turn is bounded (`sessions/turn.ts`, {@link HANDOFF_MS}).
 * - rotate.main-idle fails after {@link MAIN_IDLE_MS}: nothing has changed then.
 * - A cancelled `fresh` rotation sends its request to the current owner as a plain request.
 */

export const KIND = {
  begin: "rotate.begin",
  handoff: "rotate.handoff",
  owner: "rotate.owner",
  swap: "rotate.swap",
  archive: "rotate.archive",
  mainIdle: "rotate.main-idle",
  mainCreate: "rotate.main-create",
  mainSwap: "rotate.main-swap",
} as const

/** Rotations the user starts (06 §6.1): they run whatever Main 멈춤 says (TI-13 skips only by:main and by:auto). */
const USER_REASONS: ReadonlySet<OwnTeam.RotationReason> = new Set(["user", "account", "team-account"])

/**
 * An automatic rotation of an area is not started again this soon after one failed, so a failure that repeats (no
 * service, no team main model) never turns the outbox's re-check into a loop of ops. The request waits meanwhile.
 */
export const RETRY_MS = 60_000

/** How often a wait looks again without an event: own work on the folder or a git operation ends without one. */
export const RECHECK_MS = Wait.RECHECK_MS

/** RH-20: how long only commands left running may hold an automatic rotation's safe point. */
export const BACKGROUND_MS = 5 * 60_000
/** RH-20: how long the old owner's warm handoff turn may take. */
export const HANDOFF_MS = 15 * 60_000
/** RH-20: how long 메인 새 대화 waits for the main's tree to be idle before it gives up (nothing changed yet). */
export const MAIN_IDLE_MS = 30 * 60_000

export interface Plan {
  readonly areaID: OwnTeam.AreaID
  /** The owner conversation that is replaced. */
  readonly from: SessionID
  /** The area folder (the old conversation's location). */
  readonly directory: string
  readonly reason: OwnTeam.RotationReason
  /** `warm` = a handoff turn on the old owner; `program` = no LLM call (stop, BLOCKED, the R4 exception). */
  readonly handoff: "warm" | "program"
  readonly by: OwnTeam.Op["by"]
}

/**
 * The steps that replace one area's owner conversation, in the two parts an op may hold apart (6.2, 10.1): `prepare`
 * = the safe point and the handoff (still on the old account), `replace` = the new owner, the swap and the archive.
 */
export function steps(plan: Plan): {
  readonly prepare: ReadonlyArray<Steps.Spec>
  readonly replace: ReadonlyArray<Steps.Spec>
} {
  const area = { areaID: plan.areaID, from: plan.from }
  return {
    prepare: [
      { kind: KIND.begin, args: { ...area, reason: plan.reason, by: plan.by } },
      { kind: KIND.handoff, args: { ...area, handoff: plan.handoff } },
    ],
    replace: [
      { kind: KIND.owner, args: area },
      { kind: KIND.swap, args: { ...area, reason: plan.reason } },
      { kind: KIND.archive, args: { sessionID: plan.from, directory: plan.directory, areaID: plan.areaID } },
    ],
  }
}

/**
 * The steps of 메인 새 대화 (6.5). `sessionID` is the new main's id, chosen ahead: the op record holds it before
 * anything is made, so a retry adopts the session made before (core session.ts:253).
 */
export function mainSteps(input: {
  readonly from: SessionID
  readonly sessionID: SessionID
  readonly directory: string
}): ReadonlyArray<Steps.Spec> {
  const pair = { from: input.from, sessionID: input.sessionID }
  return [
    { kind: KIND.mainIdle, args: { from: input.from } },
    { kind: KIND.mainCreate, args: pair },
    { kind: KIND.mainSwap, args: pair },
    { kind: KIND.archive, args: { sessionID: input.from, directory: input.directory } },
  ]
}

export function create(services: Services.Context): Services.Rotate {
  for (const kind of kinds()) services.steps.register(kind)
  return {
    request: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
      if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
      const area = await services.registry.areas.get(team.id, input.areaID)
      if (!area || area.state === "retired")
        return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
      if (area.state === "broken")
        return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
          areaID: area.id,
          why: area.broken?.why ?? "identity",
        })
      const from = area.owner.sessionID
      if (from === null)
        return Services.failure("not_found", "the area has no owner conversation yet", { what: "session", id: area.id })
      const failed = userStarted(input) ? undefined : await failedLately(services, team.id, area.id)
      if (failed) return busy(failed)
      const planned = steps({
        areaID: area.id,
        from,
        directory: area.directory,
        reason: input.reason,
        handoff: input.handoff,
        by: input.by,
      })
      return start(services, {
        teamID: team.id,
        by: input.by,
        areaID: area.id,
        steps: [...planned.prepare, ...planned.replace],
      })
    },
    main: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
      if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
      return start(services, {
        teamID: team.id,
        by: input.by,
        steps: mainSteps({
          from: team.main.sessionID,
          sessionID: SessionID.create(),
          directory: team.home.directory,
        }),
      })
    },
  }
}

function userStarted(input: { readonly by: OwnTeam.Op["by"]; readonly reason: OwnTeam.RotationReason }) {
  return input.by === "user" || USER_REASONS.has(input.reason)
}

async function start(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly by: OwnTeam.Op["by"]
    readonly areaID?: OwnTeam.AreaID
    readonly steps: ReadonlyArray<Steps.Spec>
  },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const started = await services.runner.start({ ...input, kind: "rotate", undo: { available: false } })
  if (!started.ok) return busy(started.op)
  return { ok: true, opID: started.op.id }
}

function busy(op: OwnTeam.Op) {
  return Services.failure("busy", `another op of the team is running or just failed (${op.kind})`, Journal.busy(op))
}

/** The area's rotation op that failed within {@link RETRY_MS}, if any. */
async function failedLately(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID) {
  const now = services.clock.now()
  return (await services.journal.list(teamID)).findLast(
    (op) => op.kind === "rotate" && op.areaID === areaID && op.state === "failed" && now - op.createdAt < RETRY_MS,
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const AreaArgs = Schema.Struct({ areaID: OwnTeam.AreaID, from: SessionID })
const BeginArgs = Schema.Struct({ ...AreaArgs.fields, reason: OwnTeam.RotationReason, by: OwnTeam.Op.fields.by })
const HandoffArgs = Schema.Struct({ ...AreaArgs.fields, handoff: Schema.Literals(["warm", "program"]) })
const SwapArgs = Schema.Struct({ ...AreaArgs.fields, reason: OwnTeam.RotationReason })
/** `areaID` ties the archive of a replaced owner to its rotation (skipped with it); a main's has none. */
const ArchiveArgs = Schema.Struct({ sessionID: SessionID, directory: Schema.String, areaID: optional(OwnTeam.AreaID) })
const MainIdleArgs = Schema.Struct({ from: SessionID })
const MainArgs = Schema.Struct({ from: SessionID, sessionID: SessionID })

const DONE: Steps.Outcome = { ok: true }
const GONE = "새 대화로 이어가는 동안 영역이나 담당 대화가 바뀌었어요"
const MAIN_GONE = "새 대화로 이어가는 동안 팀 메인이 바뀌었어요"
const STOPPED = "서비스가 닫혀 멈췄어요"
const PAUSED = "메인 멈춤이 켜져 있어 자동으로 새 대화로 이어가지 않았어요"
const DIRECT = "직접 작업 중이라 자동으로 새 대화로 이어가지 않았어요"
const SKIPPED = "새 대화로 이어가기를 건너뛰어 함께 건너뛰었어요"
const BACKGROUND = "실행 중인 명령이 영역을 계속 쓰고 있어 새 대화 없이 지금 담당에게 보냈어요"
const PROCEEDED = "실행 중인 명령은 그대로 두고 새 대화로 이어 갔어요"
const MAIN_BUSY = "팀 메인이 계속 일하는 중이라 새 대화로 바꾸지 못했어요"

/** Core events after which a folder may have reached its safe point (8.4). */
const FOLDER_EVENTS = Settle.FOLDER_EVENTS

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    // Observing waits: the safe point is the step's state, and Main 멈춤 is read again at the moment it is reached, so
    // an automatic rotation that waited is still skipped when the user paused the area meanwhile.
    {
      ...Steps.define(KIND.begin, BeginArgs, {
        observe: async (args, input) => {
          const services = input.services
          const held = { since: undefined as number | undefined, directory: "" }
          const answer = await Wait.until<Steps.Observed>(input, {
            why: "safe-point",
            text: "영역이 쉬기를 기다려요",
            actions: Settle.START,
            wakes: (event) => FOLDER_EVENTS.some((prefix) => event.type.startsWith(prefix)),
            check: async (report) => {
              const area = await areaOf(input, args.areaID)
              const where = standing(area, args.from)
              if (where === "replaced") return { state: "satisfied" }
              if (!area || where === "gone") return { state: "failed", note: GONE }
              if (area.state === "broken") return { state: "failed", note: `'${area.name}' 영역이 멈춰 있어요` }
              // TI-13: Main 멈춤 or direct work (2026-11-14) keeps own's automatic work off the area.
              if (Direct.kept(area) && !userStarted(args))
                return { state: "skip", note: area.paused === false ? DIRECT : PAUSED }
              const safe = await services.features().safePoint.check({
                teamID: input.op.teamID,
                areaID: area.id,
                parked: parked(input.op, args),
                signal: input.signal,
              })
              if (safe.ok) return { state: "satisfied" }
              const now = services.clock.now()
              // Only commands or terminals left running hold the folder: nobody works there (RH-20).
              const background = safe.why === "shell" || safe.why === "pty"
              held.since = background ? (held.since ?? now) : undefined
              held.directory = area.directory
              if (background && held.since !== undefined && now - held.since >= BACKGROUND_MS && !userStarted(args))
                return args.reason === "fresh"
                  ? { state: "skip", note: BACKGROUND }
                  : { state: "satisfied", note: PROCEEDED }
              report(Settle.reason(`${area.name}: `, safe))
              return undefined
            },
            force: {
              answer: async () => ({ state: "satisfied", note: PROCEEDED }),
              stopShell: async (shells) => {
                await SafePoint.stop(services, held.directory, shells)
              },
            },
          })
          if (answer?.state === "skip" && answer.note === BACKGROUND)
            await Outbox.unfresh(services, {
              teamID: input.op.teamID,
              areaID: args.areaID,
              why: "실행 중인 명령이 영역 폴더를 계속 쓰고 있어요",
              wake: false,
            })
          return answer ?? { state: "failed", note: STOPPED }
        },
        act: async () => DONE,
        verify: async () => DONE,
      }),
      // A cancelled `fresh` rotation sends its request to the current owner as a plain request (RH-20).
      cancel: async (input) => {
        const args = Option.getOrUndefined(decodeBegin(input.step.args))
        if (args?.reason !== "fresh") return
        await Outbox.unfresh(input.services, {
          teamID: input.op.teamID,
          areaID: args.areaID,
          why: "사용자가 새 대화로 이어가기를 취소했어요",
          wake: false,
        })
      },
    },

    Steps.define(KIND.handoff, HandoffArgs, {
      observe: async (args, input) => {
        if (abandoned(input, args.areaID)) return { state: "skip", note: SKIPPED }
        const area = await areaOf(input, args.areaID)
        const where = standing(area, args.from)
        if (where === "replaced" || (area && written(area, input.op))) return { state: "satisfied" }
        return where === "gone" ? { state: "failed", note: GONE } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const area = await areaOf(input, args.areaID)
        if (!area) return { ok: false, note: GONE }
        if (await warm(services, args, area, input.op.id)) {
          const turn = await OwnerTurn.request(
            input,
            { sessionID: args.from, directory: area.directory, areaID: area.id },
            {
              kind: "handoff",
              text: request(area, services.clock.now()),
              label: "담당 대화가 인계 메모를 쓰는 중이에요",
              deadlineMs: HANDOFF_MS,
            },
          )
          if (turn === "stopped") return { ok: false, note: STOPPED }
          const after = await areaOf(input, args.areaID)
          if (after && written(after, input.op)) return { ok: true, note: "담당이 인계 메모를 썼어요" }
        }
        // A main request the old owner never took goes to the new owner from the outbox (RH-20).
        const requeued = await Outbox.requeue(services, {
          teamID: input.op.teamID,
          areaID: args.areaID,
          from: args.from,
          directory: area.directory,
        })
        const made = await services.features().handoff.program({ teamID: input.op.teamID, areaID: args.areaID })
        if (!made.ok) return { ok: false, note: made.message }
        const left = await leftover(services, args.from, area.directory, input.op.id)
        const text = left > 0 ? `${made.text}\n${leftNote(left)}\n` : made.text
        const saved = await services
          .features()
          .handoff.write({ teamID: input.op.teamID, areaID: args.areaID, text, by: "program" })
        const note =
          requeued.count > 0
            ? `이 앱이 인계 메모를 썼어요 · 메인 요청 ${requeued.count}개는 새 담당에게 다시 보내요`
            : "이 앱이 인계 메모를 썼어요"
        return saved.ok ? { ok: true, note } : { ok: false, note: saved.message }
      },
      verify: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        return area && written(area, input.op) ? DONE : { ok: false, note: "인계 메모가 써지지 않았어요" }
      },
    }),

    Steps.define(KIND.owner, AreaArgs, {
      observe: async (args, input) => {
        if (abandoned(input, args.areaID)) return { state: "skip", note: SKIPPED }
        const where = standing(await areaOf(input, args.areaID), args.from)
        if (where === "replaced") return { state: "satisfied" }
        return where === "gone" ? { state: "failed", note: GONE } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const area = await areaOf(input, args.areaID)
        if (!area) return { ok: false, note: GONE }
        const [handoff, mode] = await Promise.all([
          services.features().handoff.read({ teamID: input.op.teamID, areaID: args.areaID }),
          approval(services, args.from, area.directory),
        ])
        if (handoff === undefined) return { ok: false, note: "인계 메모가 없어요" }
        const created = await services.features().owner.create({
          teamID: input.op.teamID,
          areaID: args.areaID,
          handoff,
          // 2026-10-26: the new conversation keeps the 에이전트 방식 of the one it replaces.
          harnessFrom: { sessionID: args.from, directory: area.directory },
          signal: input.signal,
          ...(mode === undefined ? {} : { approval: mode }),
        })
        return created.ok ? { ok: true, note: created.sessionID } : { ok: false, note: created.message }
      },
      verify: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        return area?.owner.pending || standing(area, args.from) === "replaced"
          ? DONE
          : { ok: false, note: "새 담당 대화가 없어요" }
      },
    }),

    Steps.define(KIND.swap, SwapArgs, {
      observe: async (args, input) => {
        if (abandoned(input, args.areaID)) return { state: "skip", note: SKIPPED }
        const area = await areaOf(input, args.areaID)
        const where = standing(area, args.from)
        if (where === "replaced") return { state: "satisfied" }
        if (where === "gone") return { state: "failed", note: GONE }
        return area?.owner.pending ? { state: "pending" } : { state: "failed", note: "새 담당 대화가 없어요" }
      },
      act: async (args, input) => {
        const services = input.services
        const now = services.clock.now()
        const swapped = await services.write(input.op.teamID, async () => {
          const current = await services.registry.areas.get(input.op.teamID, args.areaID)
          const next = current?.owner.pending
          if (!current || current.owner.sessionID !== args.from || !next) return undefined
          const area: OwnTeam.Area = {
            ...current,
            owner: {
              sessionID: next,
              previous: [...current.owner.previous, { sessionID: args.from, endedAt: now, why: args.reason }],
              attached: true,
              ...OwnerSession.carried(current.owner),
            },
          }
          await AreaCreate.save(services, area)
          return { area, sessionID: next }
        })
        if (!swapped) return { ok: false, note: GONE }
        input.summary({ kind: "area", areaID: args.areaID, change: "rotated" })
        // RH-20: what the user or the team parked in the old conversation stays there (6.2); the notice counts it.
        const left = await leftover(services, args.from, swapped.area.directory, input.op.id)
        services.notices.publish({
          teamID: input.op.teamID,
          areaID: args.areaID,
          kind: "rotation.done",
          text:
            left > 0
              ? `${swapped.area.name}: 새 대화로 이어졌어요. 지난 대화에 보내지 않은 입력 ${left}개가 남아 있어요.`
              : `${swapped.area.name}: 새 대화로 이어졌어요.`,
          data: {
            sessionID: swapped.sessionID,
            previous: args.from,
            reason: args.reason,
            ...(left > 0 ? { parked: left } : {}),
          },
        })
        // Not awaited: the release is an op of its own, so it waits for this one to end.
        void Release.afterRotate(services, { teamID: input.op.teamID, areaID: args.areaID }).catch((error: unknown) =>
          services.log.warn("rotation_release_failed", { areaID: args.areaID, error }),
        )
        return DONE
      },
      verify: async (args, input) =>
        standing(await areaOf(input, args.areaID), args.from) === "replaced"
          ? DONE
          : { ok: false, note: "담당 대화가 바뀌지 않았어요" },
    }),

    Steps.define(KIND.archive, ArchiveArgs, {
      observe: async (args, input) => {
        if (abandoned(input, args.areaID)) return { state: "skip", note: SKIPPED }
        const found = await input.services.http.session.get(args, { signal: input.signal })
        if (!found.ok)
          return found.status === 404
            ? { state: "skip", note: "지난 대화를 찾을 수 없어요" }
            : { state: "failed", note: found.message }
        return found.value.metadata?.[Undo.ARCHIVED] === true ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        await leave(services, args)
        const written = await services.http.session.metadata(
          {
            sessionID: args.sessionID,
            directory: args.directory,
            change: (current) => ({ ...decodeMetadata(current), [Undo.ARCHIVED]: true }),
          },
          { signal: input.signal },
        )
        return written.ok
          ? DONE
          : { ok: false, note: `대화 ${args.sessionID}에 보관 표시를 하지 못했어요: ${written.message}` }
      },
      verify: async (args, input) => {
        const found = await input.services.http.session.get(args, { signal: input.signal })
        return found.ok && found.value.metadata?.[Undo.ARCHIVED] === true
          ? DONE
          : { ok: false, note: `대화 ${args.sessionID}에 보관 표시가 없어요` }
      },
    }),

    Steps.define(KIND.mainIdle, MainIdleArgs, {
      observe: async (args, input) =>
        (await Wait.until<Steps.Observed>(input, {
          why: "main-idle",
          text: "팀 메인이 쉬기를 기다려요",
          wakes: (event) => FOLDER_EVENTS.some((prefix) => event.type.startsWith(prefix)),
          check: async (report) => {
            const team = await input.services.registry.teams.get(input.op.teamID)
            if (!team) return { state: "failed", note: MAIN_GONE }
            if (team.main.sessionID !== args.from)
              return team.main.previous.includes(args.from)
                ? { state: "satisfied" }
                : { state: "failed", note: MAIN_GONE }
            const busy = await busyTree(input.services, args.from, team.home.directory, { signal: input.signal })
            if (busy === undefined) return { state: "satisfied" }
            report(busy)
            return undefined
          },
          // RH-20: nothing has changed yet, so giving up loses nothing.
          deadline: { ms: MAIN_IDLE_MS, answer: async () => ({ state: "failed", note: MAIN_BUSY }) },
        })) ?? { state: "failed", note: STOPPED },
      act: async () => DONE,
      verify: async () => DONE,
    }),

    Steps.define(KIND.mainCreate, MainArgs, {
      observe: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        if (team?.main.sessionID === args.sessionID) return { state: "satisfied" }
        return team?.main.sessionID === args.from ? { state: "pending" } : { state: "failed", note: MAIN_GONE }
      },
      act: async (args, input) => {
        const services = input.services
        const team = await services.registry.teams.get(input.op.teamID)
        if (!team) return { ok: false, note: MAIN_GONE }
        const home = team.home.directory
        const call = { signal: input.signal }
        const [old, mode, preset] = await Promise.all([
          services.http.session.get({ sessionID: args.from, directory: home }, call),
          approval(services, args.from, home),
          services.accounts.presetGet({ sessionID: args.from }, { directory: home }),
        ])
        if (!old.ok || !old.value.model) return { ok: false, note: "팀 메인의 모델을 알 수 없어요" }
        const presetID = preset.ok ? (preset.value.preset?.id ?? preset.value.binding?.presetID) : undefined
        // 2026-10-26: the new main keeps the old main's 에이전트 방식 (its `own.harness`), else the service's default.
        const id = OwnHarnessRouting.bound(old.value.metadata)
        const opened = await MainSession.open(services, {
          sessionID: args.sessionID,
          directory: home,
          model: old.value.model,
          title: MainSession.TITLE,
          meta: { role: "main", teamID: team.id },
          ...(id === undefined ? {} : { harness: { id, prompt: OwnHarnessRouting.promptOf(old.value.metadata) } }),
          signal: input.signal,
        })
        if (!opened.ok) return { ok: false, note: opened.message }
        const prepared = await MainSession.prepare(services, {
          teamID: team.id,
          role: "main",
          sessionID: args.sessionID,
          directory: home,
          model: opened.model,
          approval: mode ?? MainSession.APPROVAL,
          entries: [
            {
              key: RoleInstructions.MAIN,
              value: RoleInstructions.main({
                team,
                blocks: await RoleInstructions.blocks(services.kv, services.log, team.id),
              }),
            },
          ],
          signal: input.signal,
          ...(presetID === undefined ? {} : { presetID }),
        })
        return prepared.ok ? DONE : { ok: false, note: prepared.message }
      },
      verify: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        if (!team) return { ok: false, note: MAIN_GONE }
        const found = await input.services.http.session.get(
          { sessionID: args.sessionID, directory: team.home.directory },
          { signal: input.signal },
        )
        return found.ok ? DONE : { ok: false, note: `새 팀 메인 대화를 찾을 수 없어요: ${args.sessionID}` }
      },
    }),

    Steps.define(KIND.mainSwap, MainArgs, {
      observe: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        if (team?.main.sessionID === args.sessionID) return { state: "satisfied" }
        return team?.main.sessionID === args.from ? { state: "pending" } : { state: "failed", note: MAIN_GONE }
      },
      act: async (args, input) => {
        const services = input.services
        const written = await services.write(input.op.teamID, async () => {
          const current = await services.registry.teams.get(input.op.teamID)
          if (!current || current.main.sessionID !== args.from) return undefined
          return services.registry.teams.put({
            ...current,
            main: { sessionID: args.sessionID, previous: [...current.main.previous, args.from] },
          })
        })
        if (!written) return { ok: false, note: MAIN_GONE }
        services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
        // RH-35: input the user parked in the old main's queue stays there (its safe point passes it, `busyTree`), and
        // the notice counts it as an area rotation's does.
        const left = await leftover(services, args.from, written.home.directory, input.op.id)
        services.notices.publish({
          teamID: written.id,
          kind: "rotation.done",
          text:
            left > 0
              ? `팀 메인이 새 대화로 이어졌어요. 지난 대화에 보내지 않은 입력 ${left}개가 남아 있어요.`
              : "팀 메인이 새 대화로 이어졌어요.",
          data: {
            sessionID: args.sessionID,
            previous: args.from,
            reason: "user",
            ...(left > 0 ? { parked: left } : {}),
          },
        })
        // Untold team updates go to the new main (one waiting for the old main is dropped, `report/fold.ts`).
        services.features().wake.request(written.id)
        return DONE
      },
      verify: async (args, input) =>
        (await input.services.registry.teams.get(input.op.teamID))?.main.sessionID === args.sessionID
          ? DONE
          : { ok: false, note: "팀 메인 대화가 바뀌지 않았어요" },
    }),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function areaOf(input: Steps.Input, areaID: OwnTeam.AreaID) {
  return input.services.registry.areas.get(input.op.teamID, areaID)
}

/** Where the rotation of `from` stands: `from` is still the owner, was replaced already, or the area moved on. */
function standing(area: OwnTeam.Area | undefined, from: string): "current" | "replaced" | "gone" {
  if (!area || area.state === "retired") return "gone"
  if (area.owner.sessionID === from) return "current"
  return area.owner.previous.some((item) => item.sessionID === from) ? "replaced" : "gone"
}

/** The rotation of `areaID` in this op was skipped at its start (Main 멈춤), so its later steps are skipped too. */
function abandoned(input: Steps.Input, areaID: OwnTeam.AreaID | undefined) {
  return (
    areaID !== undefined &&
    input.op.steps.some((step) => step.kind === KIND.begin && step.state === "skipped" && step.args.areaID === areaID)
  )
}

const decodeBegin = Schema.decodeUnknownOption(BeginArgs)

/**
 * What the user or the team parked in the old owner's queue (RH-20, `SafePoint.work`): it stays with that
 * conversation (6.2). The number of such items.
 */
async function leftover(services: Services.Context, sessionID: SessionID, directory: string, opID: string) {
  const inbox = await services.http.inbox.list({ sessionID, directory })
  return inbox.ok ? inbox.value.filter((item) => SafePoint.work(item, opID)).length : 0
}

/** The handoff document's line about input left in the old conversation. */
function leftNote(count: number) {
  return [
    "## 지난 대화에 남은 입력",
    `- 지난 담당 대화의 대기열에 보내지 않은 입력 ${count}개(사용자가 쓴 것이나 멈춘 요청)가 그대로 남았습니다. 이 대화에는 오지 않습니다. 필요하면 사용자나 메인이 다시 보냅니다.`,
  ].join("\n")
}

/**
 * A team account move that hands this area over without a turn (멈추고 바꾸기, or the old account out of its limit,
 * 06 §10.1): the stopped owner's queue keeps what was parked there for that conversation (6.2: the user's input to
 * the old conversation stays there), so it does not hold the move back.
 */
function parked(op: OwnTeam.Op, args: { readonly areaID: OwnTeam.AreaID; readonly reason: OwnTeam.RotationReason }) {
  return (
    args.reason === "team-account" &&
    op.steps.some(
      (step) => step.kind === KIND.handoff && step.args.areaID === args.areaID && step.args.handoff === "program",
    )
  )
}

/** A handoff document was written for the area since this op started (by the owner or the program). */
function written(area: OwnTeam.Area, op: OwnTeam.Op) {
  return area.handoff !== null && area.handoff.at >= op.createdAt
}

/**
 * Whether the old owner gets a handoff turn (6.2 step 1): not for a `program` handoff, not for an adopted conversation
 * that never got the team (`owner.attached: false`, 3.7: it has no `team_handoff`, and its account may be another
 * subscription of the team main's company, which never runs for the team, U5), not when its account is out of its
 * limit (`switch.state` BLOCKED, 10.1: no turn can run there), not for a conversation without a message yet (an
 * area's first owner replaced by a `fresh` first request has nothing to hand over), not while a context reset waits
 * in its queue (core P-035, 6.1: the request would go in behind it and find an empty context), and not while the user's
 * or the team's input is parked there (RH-20, `SafePoint.work`: core would run it first, in the conversation about to
 * be replaced; it stays there, 6.2). An inbox the service cannot read counts as one with parked input.
 */
async function warm(
  services: Services.Context,
  args: { readonly from: SessionID; readonly handoff: "warm" | "program" },
  area: OwnTeam.Area,
  opID: string,
) {
  if (args.handoff === "program") return false
  if (area.owner.sessionID === args.from && !area.owner.attached) return false
  const directory = area.directory
  const [state, messages, inbox] = await Promise.all([
    services.accounts.switchState({ sessionID: args.from }, { directory }),
    services.http.session.messages({ sessionID: args.from, directory, limit: 1 }),
    services.http.inbox.list({ sessionID: args.from, directory }),
  ])
  if (state.ok && state.value.state === "BLOCKED") return false
  if (!inbox.ok && inbox.status !== 404) return false
  if (inbox.ok && inbox.value.some((item) => item.type === "reset" || SafePoint.work(item, opID))) return false
  return !messages.ok || messages.value.data.length > 0
}

/** The mode a replaced session had (6.2 step 3); `custom` cannot be set again, so the new one gets the default. */
async function approval(
  services: Services.Context,
  sessionID: SessionID,
  directory: string,
): Promise<Approval.SetMode | undefined> {
  const state = await services.accounts.approvalGet({ sessionID }, { directory })
  return state.ok && state.value.mode !== "custom" ? state.value.mode : undefined
}

/** The handoff request the old owner gets (6.2 step 1, 6.4); the model never sees metadata, so the text says it all. */
export function request(area: OwnTeam.Area, now: number) {
  const body = [
    "이 영역의 담당 대화를 새 대화로 이어 갑니다. 새 담당 대화는 인계 문서와 역할 지시만으로 시작합니다.",
    "새 일은 시작하지 말고 team_handoff{text}로 인계 문서를 쓴 뒤 짧게 답하고 끝내세요. 8 KB 이하로 쓰세요(64 KB를 넘으면 잘립니다).",
    `첫 줄: ${Handoff.title(area, now)}`,
    "그 아래: ## 목표, ## 지금 상태(줄기, 대상 줄기 대비 앞섬·뒤처짐, 마지막 커밋), ## 끝낸 것, ## 남은 것(다음 첫 단계를 맨 앞에), ## 결정과 이유, ## 주의(함정, 돌려 본 명령과 결과), ## 받은 큰 파일 폴더(이유와 함께).",
    "커밋 안 된 변경은 커밋·되돌리기·stash하지 말고 ## 주의에 적으세요.",
  ]
    .join("\n")
    .replace(/<\/team-request/gi, (match) => `<\\${match.slice(1)}`)
  return `<team-request kind="handoff" area="${OwnTeamText.attribute(area.name)}">\n${body}\n</team-request>`
}

/**
 * Whether the main's tree works (6.5), and why (RH-20: the reason the step shows): the main or a session under it (a
 * subagent, following `parentID`) runs, or the main has queued input or a pending permission. An answer the service
 * cannot give counts as working. `undefined` when it is idle.
 */
async function busyTree(
  services: Services.Context,
  main: SessionID,
  directory: string,
  call: SessionHttp.Call,
): Promise<Wait.Reason | undefined> {
  // The main's queue before the active list: input leaves the queue only once a run took it, so a run that starts
  // between the two reads still shows as active (see `OwnerTurn.request`).
  const ref = { sessionID: main, directory }
  const [inbox, asking] = await Promise.all([
    services.http.inbox.list(ref, call),
    services.http.permission.list(ref, call),
  ])
  const unknown = { detail: "unknown", text: "팀 메인의 상태를 읽지 못해 기다려요", sessionIDs: [main] }
  if (!inbox.ok || !asking.ok) return unknown
  if (asking.value.length > 0)
    return { detail: "permission", text: "팀 메인이 승인을 기다리고 있어 기다려요", sessionIDs: [main] }
  // Queued input counts as on a safe point (8.4): a waiting context reset, a passive notice and input that waits for
  // the next prompt are no work.
  const now = services.clock.now()
  if (inbox.value.some((item) => SafePoint.runs(item, now)))
    return { detail: "inbox", text: "팀 메인의 대기열에 보낼 입력이 있어 기다려요", sessionIDs: [main] }
  const active = await services.http.session.active(call)
  if (!active.ok) return unknown
  const under = await Promise.all([...active.value].map((id) => rooted(services, id, main, directory, call, 0)))
  const working = [...active.value].filter((_, index) => under[index])
  if (working.length === 0) return undefined
  return {
    detail: "session",
    text: working.includes(main)
      ? "팀 메인이 일하는 중이라 기다려요"
      : "팀 메인의 하위 에이전트가 일하는 중이라 기다려요",
    sessionIDs: working.flatMap((id) => (id.startsWith("ses") ? [SessionID.make(id)] : [])),
  }
}

/** `id` is `root` or a session under it (`parentID` chain, at most 8 levels); unknown answers count as under it. */
async function rooted(
  services: Services.Context,
  id: string,
  root: string,
  directory: string,
  call: SessionHttp.Call,
  depth: number,
): Promise<boolean> {
  if (id === root) return true
  if (depth >= 8) return false
  const session = await services.http.session.get({ sessionID: id, directory }, call)
  if (!session.ok) return session.status !== 404
  const parent = session.value.parentID
  return parent === undefined ? false : rooted(services, parent, root, directory, call, depth + 1)
}

/** 6.2 step 4: the old conversation leaves the team, its binding's `team` cleared (the gate then sees no team). */
async function leave(services: Services.Context, ref: { readonly sessionID: SessionID; readonly directory: string }) {
  const where = { directory: ref.directory }
  const view = await services.accounts.presetGet({ sessionID: ref.sessionID }, where)
  const binding = view.ok ? view.value.binding : null
  if (!binding?.team) return
  const cleared = await services.accounts.presetApply(
    { sessionID: ref.sessionID, presetID: binding.presetID, team: null },
    where,
  )
  if (!cleared.ok) services.log.warn("rotation_team_not_cleared", { sessionID: ref.sessionID, type: cleared.type })
}

const decodeMetadata = (value: unknown) =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(value), () => ({}))
