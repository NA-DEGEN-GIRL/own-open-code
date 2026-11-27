export * as Rehome from "./rehome.js"

import fs from "node:fs"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import { Git } from "../git/run.js"
import { Steps } from "../ops/steps.js"
import { Services } from "../services.js"
import { Peers } from "../sessions/peer.js"
import { SafePoint } from "../sessions/safe-point.js"
import { Settle } from "./settle.js"
import { Journal } from "../ops/journal.js"

/**
 * 대화 옮기기 (06 §8.2, §4.14): the user moves a conversation into an area's folder. core's `session.move` is a control
 * item with a fresh id in the conversation's inbox, so it is not idempotent, and it moves no children (`[R-adopt]`,
 * core session/move.ts); a revert to a point before the move restores from the snapshot store of the folder it is in
 * now, so it will most likely fail (4.14). Hence a user action only (by:user; the judge may only `suggest` it), at a
 * safe point, and one `session-move` step:
 *
 *   observe  only by:user (anything else fails); the conversation already in the folder is done (no-op), and so is one
 *            whose inbox already holds a move (core delivers it at the next idle boundary; a second one is never
 *            queued, the reconcile rule of `reconcile/area.ts`); a git operation stopped half way (rebase, merge, …,
 *            `Inventory.operations`) in the folder it leaves or the folder it goes to skips the move (8.2). A
 *            conversation that is not idle (running, queued input that starts a run or that the user or the team
 *            parked there, a permission request) or a destination area away from its extended safe point (8.4: 대화
 *            옮기기 is one of its steps) is waited for, with the reason on the card (TI-9: the user's action waits)
 *   act      `ctx.session.move{delivery: "queue"}` through a live instance (as `ops/home.ts` and `reconcile/area.ts`),
 *            then {@link OwnTeam.MOVED_META} `{at, from, to}` in the session metadata, which own-web's moved banner
 *            reads (`이 대화는 옮기기 전 지점으로 되돌릴 수 없습니다`)
 *   verify   the conversation is in the folder, or the move waits in its inbox
 *
 * {@link start} refuses up front what the step would never do: by main or auto, and the team main and current owners
 * (their folder is the registry's: 메인 폴더 바꾸기, 팀에서 빼기). {@link undo} moves it back to the folder it came
 * from. Session reads use the home as the location, so no idle area Location is woken.
 */

/** The step kind (own-web label `own.team.step.kind.sessionMove`). */
export const STEP = "session-move"

const USER_ONLY = "대화 옮기기는 사용자만 할 수 있어요"

const Args = Schema.Struct({
  sessionID: SessionID,
  /** The folder the conversation was in when the move was planned (where {@link undo} takes it back). */
  from: Schema.String,
  to: Schema.String,
  /** The destination area; absent when moving back to a folder that is not an area (the home, another folder). */
  areaID: optional(OwnTeam.AreaID),
  /** The proposal item (`ops/3`) for the card's `skipped` line. */
  item: optional(Schema.String),
})
type Args = typeof Args.Type
const decodeArgs = Schema.decodeUnknownOption(Args)
const decodeMetadata = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

/** A `session-move` step (always by the user's op, mode `auto`: a move deletes nothing). */
export function spec(input: Args): Steps.Spec {
  return { kind: STEP, mode: "auto", args: { ...input } }
}

/** Registers `session-move` once per controller (before an op starts or resumes). */
export function register(services: Services.Context) {
  if (!services.steps.get(STEP)) services.steps.register(KIND)
}

/**
 * The user's move of `sessionID` into the area's folder, as an undoable `reorg` op. Refused for anything but by:user
 * and for the team main and current owners; away from a safe point its step waits (TI-9); a conversation already
 * there makes an op whose step is done at once.
 */
export async function start(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly sessionID: SessionID
    readonly areaID: OwnTeam.AreaID
    readonly by: OwnTeam.Op["by"]
  },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  if (input.by !== "user") return Services.failure("unsupported", USER_ONLY, { feature: "reorg.move" })
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
  const [role, areas] = await Promise.all([
    services.locate.session(input.sessionID),
    services.registry.areas.list(team.id),
  ])
  // Their folder is the registry's (메인 폴더 바꾸기, 팀에서 빼기), and an owner being created is one too.
  if (role?.role === "main" || role?.role === "owner" || pendingOwner(areas, input.sessionID))
    return Services.failure("unsupported", "팀 메인과 담당 대화는 이 동작으로 옮기지 않습니다", {
      feature: "reorg.move",
    })
  const session = await services.http.session.get({ sessionID: input.sessionID, directory: team.home.directory })
  if (!session.ok) return Services.failure("not_found", session.message, { what: "session", id: input.sessionID })
  // core moves a conversation without its children (8.2); a child alone is never moved.
  if (session.value.parentID !== undefined)
    return Services.failure("unsupported", "하위 대화는 따로 옮기지 않습니다", { feature: "reorg.move" })
  const from = session.value.location.directory
  const active = await services.journal.active(team.id)
  if (active) return busy(active)
  register(services)
  const started = await services.runner.start({
    teamID: team.id,
    kind: "reorg",
    by: "user",
    areaID: area.id,
    steps: [spec({ sessionID: input.sessionID, from, to: area.directory, areaID: area.id })],
    undo: { available: true },
  })
  if (!started.ok) return busy(started.op)
  return { ok: true, opID: started.op.id }
}

/** The steps that move the conversations of a `reorg` op back where they came from (8.2 되돌려 옮기기). */
export function undo(op: OwnTeam.Op): ReadonlyArray<Steps.Spec> | undefined {
  const moved = op.steps.flatMap((step) => {
    if (step.kind !== STEP || step.state !== "done") return []
    const args = Option.getOrUndefined(decodeArgs(step.args))
    return args === undefined ? [] : [args]
  })
  if (moved.length === 0) return undefined
  return moved.toReversed().map((args) =>
    spec({
      sessionID: args.sessionID,
      from: args.to,
      to: args.from,
      ...(args.item === undefined ? {} : { item: args.item }),
    }),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The step kind

const KIND: Steps.Kind = {
  ...Steps.define(STEP, Args, {
    observe: async (args, input) => {
      if (input.op.by !== "user") return { state: "failed", note: USER_ONLY }
      const services = input.services
      const team = await services.registry.teams.get(input.op.teamID)
      if (!team) return { state: "skip", note: "팀을 찾을 수 없어요" }
      const call = { signal: input.signal }
      const session = await services.http.session.get(
        { sessionID: args.sessionID, directory: team.home.directory },
        call,
      )
      if (!session.ok)
        return session.status === 404
          ? skip(input, args, "invalid", "옮길 대화가 없어요")
          : { state: "failed", note: session.message }
      const at = session.value.location.directory
      if (Identity.same(at, args.to)) return { state: "satisfied", note: "대화가 이미 그 폴더에 있어요" }
      // core's move is not idempotent: one waiting in the inbox is the move (the reconcile rule).
      const inbox = await services.http.inbox.list({ sessionID: args.sessionID, directory: team.home.directory }, call)
      if (!inbox.ok) return { state: "failed", note: inbox.message }
      if (inbox.value.some((item) => item.type === "move"))
        return { state: "satisfied", note: "옮기기가 대화의 대기열에서 기다려요" }
      if (!fs.existsSync(args.to)) return skip(input, args, "invalid", "옮겨 갈 폴더가 없어요")
      const place = await destination(services, team, args)
      if (place.area && place.area.state !== "active")
        return skip(input, args, "broken", `'${place.area.name}' 영역을 쓸 수 없어 대화를 옮기지 않았어요`)
      const gitDirs = [place.area?.gitDir, ...(await Promise.all([at, args.to].map(gitDirOf)))]
      if (gitDirs.some((gitDir) => gitDir !== undefined && Inventory.operations(gitDir).length > 0))
        return skip(input, args, "busy", "진행 중인 Git 작업이 있는 폴더라 대화를 옮기지 않았어요")
      // TI-9: the user's move waits for the conversation and the folder to be idle and says why on the card.
      const safe = await Settle.until(
        input,
        async (report) => {
          const checked = await ready(services, team, place, args.sessionID, input.signal)
          if (checked.ok) return checked
          report(Settle.reason("", checked))
          return undefined
        },
        { force: async (): Promise<Services.Safe> => ({ ok: true }) },
      )
      if (safe === undefined) return { state: "failed", note: "서비스가 닫혀 멈췄어요" }
      return { state: "pending" }
    },
    act: async (args, input) => {
      const services = input.services
      const team = await services.registry.teams.get(input.op.teamID)
      if (!team) return { ok: false, note: "팀을 찾을 수 없어요" }
      const session = await services.http.session.get({ sessionID: args.sessionID, directory: team.home.directory })
      if (!session.ok) return { ok: false, note: session.message }
      const from = session.value.location.directory
      const instance = services.instance(args.to)
      if (!instance) return { ok: false, note: "이 폴더의 팀 서비스가 아직 준비되지 않았어요" }
      // `queue`: never into a running turn; core delivers it at the conversation's idle boundary.
      const moved = await instance.ctx.session
        .move({ sessionID: args.sessionID, directory: args.to, delivery: "queue" })
        .then(
          () => undefined,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
      if (moved !== undefined) return { ok: false, note: `대화를 옮기지 못했어요: ${moved}` }
      const at = services.clock.now()
      const marked = await services.http.session.metadata({
        sessionID: args.sessionID,
        directory: args.to,
        change: (current) => ({
          ...Option.getOrElse(decodeMetadata(current), () => ({})),
          [OwnTeam.MOVED_META]: { at, from, to: args.to },
        }),
      })
      // The move went; only own-web's banner is missing.
      if (!marked.ok) services.log.warn("rehome_mark_failed", { sessionID: args.sessionID, message: marked.message })
      // A peer conversation moved out of its area's folder is no peer of it any more (동료).
      await Peers.drop(services, {
        teamID: team.id,
        sessionID: args.sessionID,
        ...(args.areaID === undefined ? {} : { except: args.areaID }),
      })
      return { ok: true }
    },
    verify: async (args, input) => {
      const services = input.services
      const team = await services.registry.teams.get(input.op.teamID)
      if (!team) return { ok: false, note: "팀을 찾을 수 없어요" }
      const where = { sessionID: args.sessionID, directory: team.home.directory }
      const session = await services.http.session.get(where)
      if (session.ok && Identity.same(session.value.location.directory, args.to)) return { ok: true }
      // Delivered at the conversation's next idle boundary (`team-session-move-inbox`).
      const inbox = await services.http.inbox.list(where)
      return inbox.ok && inbox.value.some((item) => item.type === "move")
        ? { ok: true }
        : { ok: false, note: "대화를 옮기지 못했어요" }
    },
  }),
  reverses: true,
}

/** A skipped move: a `skipped` card line and the `reorg.skipped` notice (8.1). */
function skip(input: Steps.Input, args: Args, why: OwnTeam.SkipReason, note: string): Steps.Observed {
  const item = args.item ?? STEP
  input.summary({ kind: "skipped", item, ...(args.areaID === undefined ? {} : { areaID: args.areaID }), why })
  input.services.notices.publish({
    teamID: input.op.teamID,
    ...(args.areaID === undefined ? {} : { areaID: args.areaID }),
    kind: "reorg.skipped",
    text: note,
    data: { item, why, sessionID: args.sessionID },
  })
  return { state: "skip", note }
}

/** Where the conversation goes: the named area, else the team folder (home or area) holding `to`, else none. */
async function destination(
  services: Services.Context,
  team: OwnTeam.Team,
  args: Args,
): Promise<{ readonly area?: OwnTeam.Area; readonly home?: true }> {
  if (args.areaID !== undefined) {
    const area = await services.registry.areas.get(team.id, args.areaID)
    return area ? { area } : {}
  }
  const place = await services.locate.directory(args.to)
  if (!place || place.team.id !== team.id) return {}
  return place.area ? { area: place.area } : { home: true }
}

/**
 * A safe point for the move: the conversation is idle (not running, no queued input that starts a run, no permission
 * request) and the folder it goes to is at its extended safe point (8.4; none for a folder outside the team).
 */
async function ready(
  services: Services.Context,
  team: OwnTeam.Team,
  place: { readonly area?: OwnTeam.Area; readonly home?: true },
  sessionID: SessionID,
  signal?: AbortSignal,
): Promise<Services.Safe> {
  const call = signal ? { signal } : undefined
  const where = { sessionID, directory: team.home.directory }
  // The queue before `session.active`, as every safe point reads them (`SafePoint.check`): input woken between the
  // two reads finds the conversation active.
  const [inbox, asking] = await Promise.all([
    services.http.inbox.list(where, call),
    services.http.permission.list(where, call),
  ])
  const now = services.clock.now()
  const active = await services.http.session.active(call)
  if (!active.ok || active.value.has(sessionID)) return unsafe("session", sessionID)
  // RH-34: queued input counts as at every safe point (`SafePoint.runs`): a waiting context reset (core orders it with
  // the move), a passive notice and a notice parked for the next prompt (own.harness' switch notice) are no work; the
  // move's wake delivers a parked notice first, in the conversation's folder, then the move. A move already waiting
  // is the move (`observe` above). The user's or the team's input parked there (`SafePoint.work`, a prompt left after
  // the user stopped the conversation) still holds it: that wake would run it before the move.
  if (
    !inbox.ok ||
    inbox.value.some((item) => item.type !== "move" && (SafePoint.runs(item, now) || SafePoint.work(item)))
  )
    return unsafe("inbox", sessionID)
  if (!asking.ok || asking.value.length > 0) return unsafe("permission", sessionID)
  if (!place.area && !place.home) return { ok: true }
  return services.features().safePoint.check({
    teamID: team.id,
    ...(place.area === undefined ? {} : { areaID: place.area.id }),
    extended: true,
    ...(signal === undefined ? {} : { signal }),
  })
}

/**
 * The git dir of the checkout a folder is in (for `Inventory.operations`), or `undefined` outside one. A session's
 * folder may be a subfolder of its worktree, so git may look above it here (no worktree ceiling); nothing is written.
 */
async function gitDirOf(directory: string) {
  if (!Git.isNative(directory) || !fs.existsSync(directory)) return undefined
  const found = await Git.run(["rev-parse", "--absolute-git-dir"], { cwd: directory })
  return found.ok ? found.stdout.trim() : undefined
}

/** The session is an owner being created (6.2 step 3) of one of the team's areas. */
function pendingOwner(areas: ReadonlyArray<OwnTeam.Area>, sessionID: string) {
  return areas.some((area) => area.state !== "retired" && area.owner.pending === sessionID)
}

function unsafe(why: Services.SafeWhy, sessionID: SessionID): Services.Safe {
  return { ok: false, why, sessionIDs: [sessionID] }
}

function busy(op: OwnTeam.Op) {
  return Services.failure("busy", "another team op is running", Journal.busy(op))
}
