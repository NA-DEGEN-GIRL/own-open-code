export * as ReportEvents from "./events.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnAccounts, OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Release } from "../assets/release.js"
import { Direct } from "../dispatch/direct.js"
import { Talk } from "../dispatch/talk.js"
import { Symlinks } from "../assets/symlinks.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import type { Hub } from "../hub.js"
import { Services } from "../services.js"
import type { Locate } from "../sessions/locate.js"
import { MainTools } from "../tools/main.js"
import { OwnerTools } from "../tools/owner.js"
import { Cursor } from "./cursor.js"
import { Digest } from "./digest.js"
import { Fold } from "./fold.js"
import { Texts } from "./texts.js"

/**
 * Session events and owner reports (06 §5.5, §5.7). What own.team observes without a tool: owner runs that start,
 * succeed, fail or are interrupted, main requests admitted to and delivered from the owner's inbox, the team update
 * delivered in the main inbox (durable, from the session logs), pending permissions and questions (ephemeral, live
 * events and the lists after a restart) and own-accounts limit blocks (`switch.state` BLOCKED, `waitReset`). They
 * update `area.status`, fold into the digest and wake the main by the table of §5.6.
 *
 * Durable events are folded after the session's cursor (`cursor.ts`): a live event of a team main or owner is kept and
 * folded together with that session's log read, and the controller reads every main and owner log when it starts and
 * whenever an instance appears. So an event is folded once, in order, whether it arrived live or (on a server that
 * keeps event rows) while nobody listened. A user stop of an owner run (`interrupted{reason:"user"}`) turns Main 멈춤
 * on (`pause.stopped`, 5.3).
 *
 * Area peers (동료) are followed the same way, each after its own cursor: the main requests they receive, their runs
 * (`끝났지만 보고 없음`, a failed run, a user stop) and their `team_report` (`progress`, `done`, `blocked`) fold under the
 * peer, never into the area's status or candidate; `모두 끝남` counts each peer like an owner.
 *
 * The candidate's life (5.5, 7.1): `ready` records the branch tip after the clean check (with `assets: true` when the
 * owner reports that the change needs an engine run, so the integration runs the `.assets` check, 4.10), an owner's
 * `team_integrate` does the same without a report or a wake ({@link ready}: a candidate already at the tip keeps its
 * report text and that mark), and an integration that ends `done` takes it away again ({@link integrated}). A `done`
 * report asks for the automatic release of the fetched heavy folders at the area's next extended safe point (4.7,
 * `Release.onDone`).
 *
 * Area messages (06 §5.8): an ask or a reply and a program notice delivered to an owner or a peer is no main request
 * (`Fold.requestOf`): it is never `received`, owes no answer and makes no `끝났지만 보고 없음`; neither does a run that
 * ends while the conversation waits for the answer to its own ask. An ask delivered in a conversation is settled by
 * that conversation's next run end in its ordered log (`Talk.follow`, then `Talk.settle` after the write section). A
 * ready report and an owner's `team_integrate` fire the watches on the area (`Talk.fire`).
 *
 * Whole texts (2026-11-14): a report's text is kept whole in KV `report:<team>:<area>` (`report/texts.ts`); the digest,
 * its entry and the candidate keep its excerpt (`Fold.excerpt`). While the user works with the area directly
 * (`Area.directWork`), every report of its owner and peers and every failed owner run is also kept in the stretch
 * (`stretch:<team>:<area>`, counted in the digest's stretch summary). While the area is held (`Direct.live`) and its
 * owner serves no main request (`Direct.serving`), none of them wakes the main: `quiet` is decided inside the team
 * write, and the wake after it follows the entry it wrote. The hand-back (`Direct.end`) carries them to the main.
 */

const SWITCH_STATE = `rpc.${OwnAccounts.ID}.switch.state`

/** `team_report{kind:"ready"}` with uncommitted tracked changes (06 §5.5). */
export const DIRTY =
  '커밋되지 않은 변경이 있습니다. 이번 일에서 만든 변경이면 커밋한 뒤 다시 알려 주세요. 아니면 건드리지 말고 team_report(kind:"blocked")로 알리세요'

const ANSWERS: Readonly<Record<Fold.ReportKind, string>> = {
  progress: "팀 소식에 적었습니다.",
  done: "끝난 일로 적었습니다. 메인은 다음 팀 소식에서 봅니다.",
  ready: "반영 후보로 적고 메인에게 알렸습니다.",
  blocked: "메인에게 알렸습니다. 메인의 답을 기다리세요.",
}

/** The answers that differ while the user works with the area directly and the main is not woken (2026-11-14). */
export const QUIET = {
  ready: "반영 후보로 적었습니다. 직접 작업 중이라 메인을 깨우지 않았고, 메인에게 넘길 때 함께 갑니다.",
  blocked:
    "막힌 일로 적었습니다. 직접 작업 중이라 메인을 깨우지 않았고 넘길 때 함께 갑니다. 지금 이 대화에서 사용자에게 말하세요.",
} as const

/** The answer to a report: a quiet `ready` or `blocked` says the main was not woken. */
function answer(kind: Fold.ReportKind, quiet: boolean) {
  return quiet && (kind === "ready" || kind === "blocked") ? QUIET[kind] : ANSWERS[kind]
}

export function create(services: Services.Context): Services.Events {
  const following = new Map<string, Promise<void>>()
  const again = new Set<string>()
  /** Live durable events per session not folded yet (the local server's log keeps none, see `cursor.ts`). */
  const live = new Map<string, Cursor.Item[]>()

  const take = (sessionID: string) => {
    const items = live.get(sessionID) ?? []
    live.delete(sessionID)
    return items
  }

  /** Folds a session's log after its cursor; a call while it reads makes it read once more afterwards. */
  const follow = (sessionID: string): Promise<void> => {
    const running = following.get(sessionID)
    if (running) {
      again.add(sessionID)
      return running
    }
    const run = (async () => {
      do {
        again.delete(sessionID)
        await followOnce(services, sessionID, take(sessionID))
      } while (again.has(sessionID))
    })().finally(() => following.delete(sessionID))
    following.set(sessionID, run)
    return run
  }

  const catchUp = async (teamID?: OwnTeam.TeamID) => {
    const teams =
      teamID === undefined
        ? await services.registry.teams.list()
        : [await services.registry.teams.get(teamID)].filter((team) => team !== undefined)
    await Promise.all(
      teams
        .filter((team) => team.state === "on")
        .map(async (team) => {
          const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state === "active")
          const owners = areas.flatMap((area) => (area.owner.sessionID !== null ? [area.owner.sessionID] : []))
          // Area peers (동료) have logs of their own, each after its own cursor.
          const peers = areas.flatMap((area) => (area.peers ?? []).map((peer) => peer.sessionID))
          await Promise.all([team.main.sessionID, ...owners, ...peers].map((sessionID) => follow(sessionID)))
          await refresh(services, team)
          await allDone(services, team.id)
          services.features().wake.request(team.id)
        }),
    )
  }

  const stop = services.hub.on(async (event) => {
    const target = trigger(event)
    if (!target) return
    // Kept before any await, so live items stay in stream order.
    const item = target.kind === "log" ? Cursor.item(event) : undefined
    if (item) live.set(target.sessionID, [...(live.get(target.sessionID) ?? []), item])
    const found = await services.locate.session(target.sessionID)
    // The main's log matters for its inbox only (a delivered team update lets the next one go).
    const folds =
      found?.team.state === "on" &&
      target.kind === "log" &&
      (found.role === "owner" || found.role === "peer" || (found.role === "main" && target.inbox))
    if (item && !folds) {
      const rest = (live.get(target.sessionID) ?? []).filter((kept) => kept !== item)
      live.set(target.sessionID, rest)
      if (rest.length === 0) live.delete(target.sessionID)
    }
    if (!found || found.team.state !== "on") return
    if (target.kind === "log") {
      if (folds) await follow(target.sessionID)
      return
    }
    if (found.role !== "owner") return
    if (target.kind === "asking") return asking(services, found, target.on)
    return quota(services, found, target.blocked)
  })

  return {
    report: (input) => report(services, input),
    catchUp,
    resume: () => catchUp(),
    close: async () => stop(),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// team_report (06 §5.5)

async function report(
  services: Services.Context,
  input: Services.ReportInput,
): Promise<Services.Result<{ readonly text: string }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team || team.state !== "on") return Services.failure("team_off", MainTools.TEAM_OFF, { teamID: input.teamID })
  const area = await services.registry.areas.get(input.teamID, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", MainTools.NO_AREA, { what: "area", id: input.areaID })
  if (input.peer !== undefined) return peerReport(services, area, { ...input, peer: input.peer })
  if (area.owner.sessionID !== input.sessionID) return previousOwner(input.sessionID)
  const candidate = input.kind === "ready" ? await clean(area) : undefined
  if (candidate && !candidate.ok) return candidate
  const now = services.clock.now()
  const text = Fold.excerpt(input.text)
  const task = input.task === undefined ? {} : { task: input.task }
  const written = await services.write(input.teamID, async () => {
    const current = await services.registry.areas.get(input.teamID, input.areaID)
    // A rotation swapped the owner meanwhile: the old one's later reports are refused (06 §6.2).
    if (!current || current.owner.sessionID !== input.sessionID) return undefined
    const loaded = await Digest.load(services.kv, input.teamID)
    const quiet = await quietNow(services, current, Fold.area(loaded, current.id), Direct.owner(current), now)
    const stored = Fold.report(loaded, { areaID: input.areaID, kind: input.kind, text, at: now, ...task })
    const entry = Fold.entry({
      at: now,
      areaID: input.areaID,
      reason: input.kind,
      text,
      ...(quiet ? { wake: false } : {}),
    })
    const item = { kind: input.kind, text: input.text, at: now, ...task }
    await Digest.save(services.kv, await keep(services, current, Fold.append(stored, entry), item))
    const assets = input.assets === true ? { assets: true } : {}
    const marked = candidate?.ok ? { ...current, candidate: { sha: candidate.sha, at: now, text, ...assets } } : current
    const wanted =
      input.kind === "ready" || input.kind === "blocked" ? { kind: input.kind, at: now, text: "" } : undefined
    const status = wanted === undefined ? undefined : Fold.status(marked.status, wanted)
    if (marked !== current || status !== undefined) await put(services, { ...marked, ...(status ? { status } : {}) })
    return { quiet }
  })
  if (!written) return previousOwner(input.sessionID)
  if (!written.quiet && Fold.WAKES[input.kind]) services.features().wake.request(input.teamID)
  if (!written.quiet && input.kind === "ready") fireReady(services, input.teamID, input.areaID)
  // 4.7: the release waits for the extended safe point, so the owner's answer never waits for it.
  if (input.kind === "done")
    void Release.onDone(services, { teamID: input.teamID, areaID: input.areaID }).catch((error: unknown) =>
      services.log.warn("release_on_done_failed", { areaID: input.areaID, error }),
    )
  return { ok: true, text: answer(input.kind, written.quiet) }
}

/** A peer's `team_report` after the peer was removed (or its conversation moved away). */
export const NOT_PEER = "이 대화는 더 이상 이 영역의 동료가 아닙니다"

/**
 * An area peer's `team_report` (동료; `progress`, `done`, `blocked`, the tool refuses `ready`): folded under the peer, a
 * team update entry about it, and `blocked` wakes the main like an owner's (not while the area is quiet, 2026-11-14).
 * The area's status and candidate stay the owner's, and no release is asked for (the cone is the area's).
 */
async function peerReport(
  services: Services.Context,
  area: OwnTeam.Area,
  input: Services.ReportInput & { readonly peer: string },
): Promise<Services.Result<{ readonly text: string }>> {
  const now = services.clock.now()
  const text = Fold.excerpt(input.text)
  const task = input.task === undefined ? {} : { task: input.task }
  const written = await services.write(input.teamID, async () => {
    const current = await services.registry.areas.get(input.teamID, input.areaID)
    const peer = (current?.peers ?? []).find((item) => item.key === input.peer)
    if (!current || !peer || peer.sessionID !== input.sessionID) return undefined
    const loaded = await Digest.load(services.kv, input.teamID)
    // The peer's own seat: a peer working on the main's request reports to the main even while the owner is held.
    const quiet = await quietNow(
      services,
      current,
      Fold.peer(Fold.area(loaded, current.id), peer.key),
      { areaID: current.id, sessionID: peer.sessionID },
      now,
    )
    const stored = Fold.peerReport(loaded, {
      areaID: input.areaID,
      key: peer.key,
      kind: input.kind,
      text,
      at: now,
      ...task,
    })
    const entry = Fold.entry({
      at: now,
      areaID: input.areaID,
      peer: peer.key,
      reason: input.kind,
      text,
      ...(quiet ? { wake: false } : {}),
    })
    const item = { kind: input.kind, text: input.text, at: now, peer: peer.key, ...task }
    await Digest.save(services.kv, await keep(services, current, Fold.append(stored, entry), item))
    return { quiet }
  })
  if (!written) return Services.failure("not_found", NOT_PEER, { what: "session", id: input.sessionID })
  if (!written.quiet && Fold.WAKES[input.kind]) services.features().wake.request(input.teamID)
  return { ok: true, text: answer(input.kind, written.quiet) }
}

/**
 * Whether a report of the area stays quiet (2026-11-14): direct work holds the area and the reporting seat (the owner,
 * or the peer) serves no main request (`Direct.serving`, which also counts a request sent and not folded yet). Inside
 * the team write.
 */
async function quietNow(
  services: Services.Context,
  area: OwnTeam.Area,
  slot: Fold.Answers,
  seat: Parameters<typeof Direct.serving>[1],
  now: number,
) {
  if (!Direct.live(area)) return false
  return !Direct.serving(slot, seat, await services.registry.dispatches.list(area.teamID), now)
}

/**
 * Inside the team write: a report's whole text as its seat's newest of its kind (KV `report:`) and, while direct work
 * holds the area, in its stretch too (KV `stretch:` and the digest's stretch summary). Returns the digest state.
 */
async function keep(services: Services.Context, area: OwnTeam.Area, state: Fold.State, item: Texts.TextItem) {
  const texts = await Texts.load(services.kv, services.log, area.teamID, area.id)
  await Texts.save(services.kv, area.teamID, area.id, Texts.report(texts, item))
  const held = area.directWork
  if (held === undefined) return state
  await stretch(services, area, held.since, [item])
  return Fold.stretch(state, { areaID: area.id, since: held.since, kind: item.kind, excerpt: item.text })
}

/** Appends whole texts to the area's stretch `since` (KV `stretch:`), inside the team write. */
async function stretch(
  services: Services.Context,
  area: OwnTeam.Area,
  since: number,
  items: ReadonlyArray<Texts.TextItem>,
) {
  if (items.length === 0) return
  const stored = await Texts.loadStretch(services.kv, services.log, area.teamID, area.id)
  const next = items.reduce<Texts.Stretch | undefined>((acc, item) => Texts.append(acc, since, item), stored)
  if (next !== undefined) await Texts.saveStretch(services.kv, area.teamID, area.id, next)
}

/** `candidate.text` of a candidate an owner's `team_integrate` recorded (no report text comes with it). */
export const INTEGRATE_TEXT = "담당이 team_integrate로 반영을 시작함"

/**
 * An owner's `team_integrate` (06 §2.8): the `ready` clean check and the candidate record of 5.5 for the caller's own
 * area, without a report and without waking the main (the integration's result reaches it). A candidate already at
 * the branch tip keeps its report text.
 */
export async function ready(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly sessionID: string },
): Promise<Services.Result<{ readonly sha: string }>> {
  const area = await services.registry.areas.get(input.teamID, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", MainTools.NO_AREA, { what: "area", id: input.areaID })
  if (area.owner.sessionID !== input.sessionID) return previousOwner(input.sessionID)
  if (area.state === "broken")
    return Services.failure("broken", `${area.name} 영역이 멈춰 있습니다`, {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  const candidate = await clean(area)
  if (!candidate.ok) return candidate
  const written = await services.write(input.teamID, async () => {
    const current = await services.registry.areas.get(input.teamID, input.areaID)
    if (!current || current.owner.sessionID !== input.sessionID) return false
    if (current.candidate?.sha !== candidate.sha)
      await put(services, {
        ...current,
        candidate: { sha: candidate.sha, at: services.clock.now(), text: INTEGRATE_TEXT },
      })
    return true
  })
  if (!written) return previousOwner(input.sessionID)
  fireReady(services, input.teamID, input.areaID)
  return { ok: true, sha: candidate.sha }
}

/** The watches on an area that reported ready or recorded its candidate (5.8); the answer never waits for them. */
function fireReady(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID) {
  void Talk.fire(services, { teamID, areaID, on: "ready" }).catch((error: unknown) =>
    services.log.warn("talk_fire_failed", { areaID, error }),
  )
}

/**
 * An integration of the area ended `done` (7.2 step 9, or `이미 합쳐져 있습니다` at step 2): the candidate `source` is
 * in the target now. The candidate goes, `반영 준비됨` settles to idle, and the owner's `ready` report counts as `done`
 * from now on, so a run that ends later does not bring `반영 준비됨` back (`Fold.settled`). A newer candidate (reported
 * while the integration ran) stays with everything about it.
 */
export async function integrated(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly source: string },
) {
  await services.write(input.teamID, async () => {
    const area = await services.registry.areas.get(input.teamID, input.areaID)
    if (!area || area.candidate?.sha !== input.source) return
    const now = services.clock.now()
    const status =
      area.status.kind === "ready" ? Fold.status(area.status, { kind: "idle", at: now, text: "" }) : undefined
    await put(services, { ...area, candidate: undefined, ...(status ? { status } : {}) })
    const stored = await Digest.load(services.kv, input.teamID)
    const reports = Fold.area(stored, input.areaID).reports
    const answered = reports.ready
    if (!answered) return
    // The later of the two answers stays the area's `done`, so `Fold.finished` and 모두 끝남 see the same time.
    const done = reports.done && reports.done.at > answered.at ? reports.done : answered
    await Digest.save(
      services.kv,
      Fold.withArea(stored, input.areaID, (fold) => ({ ...fold, reports: { ...reports, ready: undefined, done } })),
    )
  })
}

function previousOwner(sessionID: string) {
  return Services.failure("not_found", OwnerTools.PREVIOUS_OWNER, { what: "session", id: sessionID })
}

/**
 * `ready` (06 §5.5, §7.1): the area's tracked files are clean, link copies own wrote included (4.12: their skip flags
 * hide edits from status), and the candidate is the branch tip.
 */
async function clean(area: OwnTeam.Area): Promise<Services.Result<{ readonly sha: string }>> {
  const status = await Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=no"], {
    cwd: area.directory,
    worktree: true,
  })
  if (!status.ok) return Services.failure("internal_error", `작업 폴더 상태를 읽지 못했습니다: ${status.message}`, {})
  const changed = Porcelain.status(status.stdout).entries.flatMap((entry) =>
    entry.kind === "untracked" || entry.kind === "ignored" ? [] : [entry.path],
  )
  const dirty = [...changed, ...(await Symlinks.dirtyCopies(area)).map((copy) => copy.path)]
  if (dirty.length > 0)
    return Services.failure(
      "dirty",
      `${DIRTY} (바뀐 파일 ${dirty.length}개: ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""})`,
      { directory: area.directory, count: dirty.length, paths: dirty.slice(0, 20) },
    )
  const tip = await Git.run(["rev-parse", "--verify", `refs/heads/${area.branch}^{commit}`], {
    cwd: area.directory,
    worktree: true,
  })
  const sha = tip.ok ? tip.stdout.trim() : ""
  if (!Git.isOid(sha)) return Services.failure("internal_error", "이 영역의 마지막 저장 지점을 읽지 못했습니다", {})
  return { ok: true, sha }
}

// ---------------------------------------------------------------------------------------------------------------
// Live events

type Trigger =
  | { readonly kind: "log"; readonly sessionID: string; readonly inbox: boolean }
  | { readonly kind: "asking"; readonly sessionID: string; readonly on: boolean }
  | { readonly kind: "quota"; readonly sessionID: string; readonly blocked: Blocked | undefined }

/** A limit block: `until` = when the limit resets or the wait ends, when known. */
type Blocked = { readonly until?: number }

const decodeSwitch = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionID: Schema.String,
    state: Schema.String,
    detail: optional(
      Schema.Struct({
        nextResetAt: optional(Schema.NullOr(Schema.Finite)),
        waitReset: optional(Schema.Struct({ resumeAt: Schema.Finite })),
      }),
    ),
  }),
)

function trigger(event: Hub.Incoming): Trigger | undefined {
  switch (event.type) {
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { kind: "log", sessionID: event.data.sessionID, inbox: false }
    case "session.inbox.enqueued":
    case "session.inbox.delivered":
    case "session.inbox.cancelled":
      return { kind: "log", sessionID: event.data.sessionID, inbox: true }
    case "permission.asked":
      return { kind: "asking", sessionID: event.data.sessionID, on: true }
    case "permission.replied":
    case "form.replied":
    case "form.cancelled":
      return { kind: "asking", sessionID: event.data.sessionID, on: false }
    case "form.created":
      return { kind: "asking", sessionID: event.data.form.sessionID, on: true }
  }
  if (event.type !== SWITCH_STATE) return undefined
  const decoded = Option.getOrUndefined(decodeSwitch(event.data))
  if (!decoded) return undefined
  const until = decoded.detail?.waitReset?.resumeAt ?? decoded.detail?.nextResetAt ?? undefined
  return {
    kind: "quota",
    sessionID: decoded.sessionID,
    blocked: decoded.state === "BLOCKED" ? (until === undefined ? {} : { until }) : undefined,
  }
}

type Owner = Extract<Locate.Session, { readonly role: "owner" }>

/** A permission or question of the owner waits (답을 기다림) or was answered. */
async function asking(services: Services.Context, found: Owner, on: boolean) {
  await services.write(found.team.id, async () => {
    const area = await services.registry.areas.get(found.team.id, found.area.id)
    if (!area || area.owner.sessionID !== found.area.owner.sessionID) return
    const now = services.clock.now()
    if (!on && area.status.kind !== "asking") return
    const status = Fold.status(area.status, { kind: on ? "asking" : "busy", at: now, text: "" })
    if (status) await put(services, { ...area, status })
  })
}

/** own-accounts says the owner's account is blocked by its limit (한도 대기), or no longer. */
async function quota(services: Services.Context, found: Owner, blocked: Blocked | undefined) {
  await services.write(found.team.id, async () => {
    const area = await services.registry.areas.get(found.team.id, found.area.id)
    if (!area || area.owner.sessionID !== found.area.owner.sessionID) return
    const now = services.clock.now()
    if (!blocked && area.status.kind !== "waiting-quota") return
    const settled = Fold.settled(Fold.area(await Digest.load(services.kv, found.team.id), area.id))
    const wanted: OwnTeam.Status = blocked
      ? { kind: "waiting-quota", at: now, text: "", ...(blocked.until === undefined ? {} : { until: blocked.until }) }
      : { kind: settled, at: now, text: "" }
    const status = Fold.status(area.status, wanted)
    if (status) await put(services, { ...area, status })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Session logs

type Effect = () => Promise<void>

async function followOnce(services: Services.Context, sessionID: string, live: ReadonlyArray<Cursor.Item>) {
  const found = await services.locate.session(sessionID)
  if (!found || found.team.state !== "on" || (found.role !== "main" && found.role !== "owner" && found.role !== "peer"))
    return
  const effects = await services.write(found.team.id, async (): Promise<ReadonlyArray<Effect>> => {
    const current = await services.locate.session(sessionID)
    if (!current || current.team.state !== "on") return []
    if (current.role === "main") {
      const folded = await Cursor.follow({
        kv: services.kv,
        http: services.http,
        ref: { sessionID, directory: current.team.home.directory },
        live,
        fold: (items) => foldMain(services, current.team, items),
      })
      return folded.value
    }
    if (current.role === "peer") {
      const folded = await Cursor.follow({
        kv: services.kv,
        http: services.http,
        ref: { sessionID, directory: current.area.directory },
        live,
        fold: (items) => foldPeer(services, current, items),
      })
      return folded.value
    }
    if (current.role !== "owner") return []
    const folded = await Cursor.follow({
      kv: services.kv,
      http: services.http,
      ref: { sessionID, directory: current.area.directory },
      live,
      fold: (items) => foldOwner(services, current, items),
    })
    return folded.value
  })
  // After the write section: these take it again (Main 멈춤, 모두 끝남) or plan the wake.
  for (const effect of effects) await effect()
}

/** The main's log: a delivered or cancelled team update lets the next one go (06 §5.6 묶기). */
async function foldMain(
  services: Services.Context,
  team: OwnTeam.Team,
  items: ReadonlyArray<Cursor.Item>,
): Promise<ReadonlyArray<Effect>> {
  const gone = items.flatMap((item) => {
    const event = Fold.observe(item.item)
    return event?.type === "session.inbox.delivered" || event?.type === "session.inbox.cancelled"
      ? [event.data.inboxID]
      : []
  })
  if (gone.length === 0) return []
  const stored = await Digest.load(services.kv, team.id)
  const settled = gone.reduce((state, inboxID) => Fold.delivered(state, inboxID), stored)
  if (settled !== stored) await Digest.save(services.kv, settled)
  return [async () => services.features().wake.request(team.id)]
}

interface Folding {
  readonly state: Fold.State
  readonly status: OwnTeam.Status
  readonly stopped: boolean
  readonly ended: boolean
  /** Failed runs kept in the area's stretch (2026-11-14), written after the fold. */
  readonly stretched: ReadonlyArray<Texts.TextItem>
}

/** An owner's log: area status, main requests received, 끝났지만 보고 없음, failed runs, user stops. */
async function foldOwner(
  services: Services.Context,
  place: Owner,
  items: ReadonlyArray<Cursor.Item>,
): Promise<ReadonlyArray<Effect>> {
  const teamID = place.team.id
  const area = place.area
  const sessionID = area.owner.sessionID
  if (sessionID === null) return []
  const events = items.flatMap((item) => {
    const event = Fold.observe(item.item)
    return event ? [{ seq: item.seq, event }] : []
  })
  if (events.length === 0) return []
  // A failed run is a limit block when own-accounts says so now (06 §5.5: 한도로 막힘 does not wake the main).
  const blocked = events.some((item) => item.event.type === "session.execution.failed")
    ? await blockedNow(services, sessionID, area.directory)
    : undefined
  const [stored, talk] = await Promise.all([Digest.load(services.kv, teamID), Talk.load(services.kv, teamID)])
  // An owner that waits for the answer to its own ask owes no report yet (5.8).
  const asking = Talk.asking(talk, { areaID: area.id }, services.clock.now())
  // Whether a failed run serves a main request needs the area's sent requests (only while direct work holds it).
  const sent =
    Direct.live(area) && events.some((item) => item.event.type === "session.execution.failed")
      ? await services.registry.dispatches.list(teamID)
      : []
  const folded = events.reduce<Folding>(
    (acc, item) => step(acc, { area, key: `${sessionID}:${item.seq}`, event: item.event, blocked, asking, sent }),
    { state: stored, status: area.status, stopped: false, ended: false, stretched: [] },
  )
  if (area.directWork !== undefined) await stretch(services, area, area.directWork.since, folded.stretched)
  const followed = Talk.follow(talk, {
    sessionID,
    events: events.map((item) => item.event),
    blocked: blocked !== undefined,
  })
  if (folded.state !== stored) await Digest.save(services.kv, folded.state)
  if (followed.state !== talk) await Talk.save(services.kv, teamID, followed.state)
  if (folded.status !== area.status) await put(services, { ...area, status: folded.status })
  const woke = folded.state.entries.some((entry) => entry.wake && !stored.entries.some((old) => old.n === entry.n))
  return [
    ...(folded.stopped ? [() => services.features().pause.stopped({ teamID, areaID: area.id, sessionID })] : []),
    ...(folded.ended ? [() => allDone(services, teamID)] : []),
    ...(woke ? [async () => services.features().wake.request(teamID)] : []),
    ...settled(services, { teamID, sessionID, directory: area.directory, ended: followed.ended }),
  ]
}

/** The asks a run took and ended are settled after the write section (`Talk.settle`: a reply or a notice). */
function settled(services: Services.Context, input: Parameters<typeof Talk.settle>[1]): ReadonlyArray<Effect> {
  if (input.ended.length === 0) return []
  return [
    () =>
      Talk.settle(services, input).catch((error: unknown) =>
        services.log.warn("talk_settle_failed", { sessionID: input.sessionID, error }),
      ),
  ]
}

function step(
  acc: Folding,
  input: {
    readonly area: OwnTeam.Area
    readonly key: string
    readonly event: Fold.Observed
    readonly blocked: Blocked | undefined
    /** The owner waits for the answer to its own ask (5.8). */
    readonly asking: boolean
    /** The team's requests (read only while direct work holds the area and a run failed), for `Direct.serving`. */
    readonly sent: ReadonlyArray<OwnTeam.Dispatch>
  },
): Folding {
  const event = input.event
  const at = event.created
  const areaID = input.area.id
  const status = (wanted: OwnTeam.Status) => Fold.status(acc.status, wanted) ?? acc.status
  const fold = Fold.area(acc.state, areaID)
  // The run of the request it received ended, so the owner no longer serves it (`Direct.serving`, 2026-11-14).
  const ended = (state: Fold.State) => {
    const received = fold.received
    if (received === undefined) return state
    return Fold.withArea(state, areaID, (current) => ({ ...current, ended: received.dispatchID }))
  }
  switch (event.type) {
    case "session.execution.started":
      return { ...acc, status: status({ kind: "busy", at, text: "" }) }
    case "session.execution.succeeded":
    case "session.execution.interrupted": {
      const missing = input.asking ? undefined : Fold.unreported(fold)
      const settled = input.asking ? acc.state : ended(acc.state)
      const state =
        missing === undefined
          ? settled
          : Fold.append(
              Fold.withArea(settled, areaID, (current) => ({ ...current, unreported: missing })),
              Fold.entry({ at, areaID, reason: "unreported", text: "끝났지만 보고 없음" }),
              input.key,
            )
      return {
        ...acc,
        state,
        status: status({ kind: Fold.settled(fold), at, text: "" }),
        stopped: acc.stopped || (event.type === "session.execution.interrupted" && event.data.reason === "user"),
        ended: true,
      }
    }
    case "session.execution.failed": {
      if (input.blocked)
        return {
          ...acc,
          status: status({
            kind: "waiting-quota",
            at,
            text: "",
            ...(input.blocked.until === undefined ? {} : { until: input.blocked.until }),
          }),
        }
      const text = `실행 실패: ${event.data.error.message}`
      // While direct work holds the area and the run served no main request, it waits for the hand-back (2026-11-14).
      const quiet = Direct.live(input.area) && !Direct.serving(fold, Direct.owner(input.area), input.sent, at)
      const before = ended(acc.state)
      const noted = Fold.append(
        before,
        Fold.entry({ at, areaID, reason: "failed", text, ...(quiet ? { wake: false } : {}) }),
        input.key,
      )
      const since = input.area.directWork?.since
      // A log event folded twice (`key`) is kept in the stretch once.
      const kept = since !== undefined && noted.next !== before.next
      return {
        ...acc,
        state: kept ? Fold.stretch(noted, { areaID, since, kind: "failed", excerpt: text }) : noted,
        status: status({ kind: "failed", at, text: event.data.error.message.slice(0, 200) }),
        stretched: kept ? [...acc.stretched, { kind: "failed", text, at }] : acc.stretched,
      }
    }
    case "session.inbox.enqueued": {
      const dispatchID = Fold.requestOf(event.data.item.payload.metadata)
      if (dispatchID === undefined) return acc
      return {
        ...acc,
        state: Fold.withArea(acc.state, areaID, (current) => ({
          ...current,
          queued: { ...current.queued, [event.data.inboxID]: dispatchID },
        })),
      }
    }
    case "session.inbox.delivered":
    case "session.inbox.cancelled": {
      const dispatchID = fold.queued[event.data.inboxID]
      if (dispatchID === undefined) return acc
      const queued = Object.fromEntries(
        Object.entries(fold.queued).filter(([inboxID]) => inboxID !== event.data.inboxID),
      )
      return {
        ...acc,
        state: Fold.withArea(acc.state, areaID, (current) => ({
          ...current,
          queued,
          ...(event.type === "session.inbox.delivered" ? { received: { dispatchID, at } } : {}),
        })),
      }
    }
  }
}

type Peer = Extract<Locate.Session, { readonly role: "peer" }>

/**
 * An area peer's log (동료): main requests it received, `끝났지만 보고 없음`, failed runs and user stops, under the
 * peer. The area's status is the owner's and stays; a run that ends lets `모두 끝남` look again.
 */
async function foldPeer(
  services: Services.Context,
  place: Peer,
  items: ReadonlyArray<Cursor.Item>,
): Promise<ReadonlyArray<Effect>> {
  const teamID = place.team.id
  const area = place.area
  const peer = place.peer
  const events = items.flatMap((item) => {
    const event = Fold.observe(item.item)
    return event ? [{ seq: item.seq, event }] : []
  })
  if (events.length === 0) return []
  const blocked = events.some((item) => item.event.type === "session.execution.failed")
    ? await blockedNow(services, peer.sessionID, area.directory)
    : undefined
  const [stored, talk] = await Promise.all([Digest.load(services.kv, teamID), Talk.load(services.kv, teamID)])
  // A peer that waits for the answer to its own ask owes no report yet (5.8).
  const asking = Talk.asking(talk, { areaID: area.id, peer: peer.key }, services.clock.now())
  const name = `${OwnTeamText.PEER} ${peer.label}`
  const folded = events.reduce<{ state: Fold.State; stopped: boolean; ended: boolean }>(
    (acc, item) => {
      const event = item.event
      const at = event.created
      const key = `${peer.sessionID}:${item.seq}`
      const fold = Fold.peer(Fold.area(acc.state, area.id), peer.key)
      const note = (reason: Fold.Reason, text: string, state = acc.state) =>
        Fold.append(state, Fold.entry({ at, areaID: area.id, peer: peer.key, reason, text }), key)
      switch (event.type) {
        case "session.execution.started":
          return acc
        case "session.execution.succeeded":
        case "session.execution.interrupted": {
          const missing = asking ? undefined : Fold.unreported(fold)
          return {
            state:
              missing === undefined
                ? acc.state
                : note(
                    "unreported",
                    `${name}: 끝났지만 보고 없음`,
                    Fold.withPeer(acc.state, area.id, peer.key, (current) => ({ ...current, unreported: missing })),
                  ),
            stopped: acc.stopped || (event.type === "session.execution.interrupted" && event.data.reason === "user"),
            ended: true,
          }
        }
        case "session.execution.failed":
          // A limit block does not wake the main (5.5); own-web tells the user.
          if (blocked) return { ...acc, ended: true }
          return { ...acc, state: note("failed", `${name} 실행 실패: ${event.data.error.message}`), ended: true }
        case "session.inbox.enqueued": {
          const dispatchID = Fold.requestOf(event.data.item.payload.metadata)
          if (dispatchID === undefined) return acc
          return {
            ...acc,
            state: Fold.withPeer(acc.state, area.id, peer.key, (current) => ({
              ...current,
              queued: { ...current.queued, [event.data.inboxID]: dispatchID },
            })),
          }
        }
        case "session.inbox.delivered":
        case "session.inbox.cancelled": {
          const dispatchID = fold.queued?.[event.data.inboxID]
          if (dispatchID === undefined) return acc
          const queued = Object.fromEntries(
            Object.entries(fold.queued ?? {}).filter(([inboxID]) => inboxID !== event.data.inboxID),
          )
          return {
            ...acc,
            state: Fold.withPeer(acc.state, area.id, peer.key, (current) => ({
              ...current,
              queued,
              ...(event.type === "session.inbox.delivered" ? { received: { dispatchID, at } } : {}),
            })),
          }
        }
      }
    },
    { state: stored, stopped: false, ended: false },
  )
  const followed = Talk.follow(talk, {
    sessionID: peer.sessionID,
    events: events.map((item) => item.event),
    blocked: blocked !== undefined,
  })
  if (folded.state !== stored) await Digest.save(services.kv, folded.state)
  if (followed.state !== talk) await Talk.save(services.kv, teamID, followed.state)
  const woke = folded.state.entries.some((entry) => entry.wake && !stored.entries.some((old) => old.n === entry.n))
  return [
    ...(folded.stopped
      ? [() => services.features().pause.stopped({ teamID, areaID: area.id, sessionID: peer.sessionID })]
      : []),
    ...(folded.ended ? [() => allDone(services, teamID)] : []),
    ...(woke ? [async () => services.features().wake.request(teamID)] : []),
    ...settled(services, { teamID, sessionID: peer.sessionID, directory: area.directory, ended: followed.ended }),
  ]
}

/** own-accounts' switch state of the session: a limit block, or `undefined`. */
async function blockedNow(
  services: Services.Context,
  sessionID: string,
  directory: string,
): Promise<Blocked | undefined> {
  const state = await services.accounts.switchState({ sessionID }, { directory })
  if (!state.ok || state.value.state !== "BLOCKED") return undefined
  const until = state.value.waitReset?.resumeAt ?? state.value.nextResetAt ?? undefined
  return until === undefined ? {} : { until }
}

// ---------------------------------------------------------------------------------------------------------------
// After a restart (06 §5.5, §5.7)

/**
 * What the logs cannot say: whether an owner still runs, waits for a permission or question (`session.permission.list`,
 * and `session.form.list` only when its Location is up, 8.4) or is blocked by its limit (`switch.state`).
 */
async function refresh(services: Services.Context, team: OwnTeam.Team) {
  // Areas first: a status that changes while the service is asked came from a newer event and is kept.
  const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state === "active")
  const active = await services.http.session.active()
  if (!active.ok) return
  await Promise.all(
    areas.map(async (area) => {
      const sessionID = area.owner.sessionID
      if (sessionID === null) return
      const running = active.value.has(sessionID)
      const waits = running ? await waitsForAnswer(services, area, sessionID) : false
      const blocked = running ? undefined : await blockedNow(services, sessionID, area.directory)
      await services.write(team.id, async () => {
        const current = await services.registry.areas.get(team.id, area.id)
        if (!current || current.owner.sessionID !== sessionID) return
        if (current.status.kind !== area.status.kind || current.status.at !== area.status.at) return
        const now = services.clock.now()
        const fold = Fold.area(await Digest.load(services.kv, team.id), area.id)
        const kind = current.status.kind
        const wanted: OwnTeam.Status | undefined = running
          ? waits
            ? { kind: "asking", at: now, text: "" }
            : kind === "busy"
              ? undefined
              : { kind: "busy", at: now, text: "" }
          : blocked
            ? {
                kind: "waiting-quota",
                at: now,
                text: "",
                ...(blocked.until === undefined ? {} : { until: blocked.until }),
              }
            : kind === "busy" || kind === "asking" || kind === "waiting-quota"
              ? { kind: Fold.settled(fold), at: now, text: "" }
              : undefined
        const status = wanted === undefined ? undefined : Fold.status(current.status, wanted)
        if (status) await put(services, { ...current, status })
      })
    }),
  )
}

async function waitsForAnswer(services: Services.Context, area: OwnTeam.Area, sessionID: string) {
  const ref = { sessionID, directory: area.directory }
  const permissions = await services.http.permission.list(ref)
  if (permissions.ok && permissions.value.length > 0) return true
  const instance = services.instance(area.directory)
  if (!instance || !Identity.same(instance.directory, area.directory)) return false
  const forms = await services.http.form.list(ref)
  return forms.ok && forms.value.length > 0
}

// ---------------------------------------------------------------------------------------------------------------
// 모두 끝남 (06 §5.6)

/**
 * Folds `모두 끝남` and wakes the main when every open area is done with its requests. An area's peers (동료) count
 * like its owner: each one's runs, its queue and its answer to the last request sent to it.
 */
async function allDone(services: Services.Context, teamID: OwnTeam.TeamID) {
  const team = await services.registry.teams.get(teamID)
  if (!team || team.state !== "on") return
  const areas = (await services.registry.areas.list(teamID)).filter((area) => area.state === "active")
  const active = await services.http.session.active()
  if (!active.ok) return
  /** The owner (no key) and each peer of each area. */
  const targets = areas.flatMap(
    (area): Array<{ area: OwnTeam.Area; sessionID: string | null; key?: string }> => [
      { area, sessionID: area.owner.sessionID },
      ...(area.peers ?? []).map((peer) => ({ area, sessionID: peer.sessionID, key: peer.key })),
    ],
  )
  const queued = await Promise.all(
    targets.map(async (target) => {
      if (target.sessionID === null) return 0
      const inbox = await services.http.inbox.list({ sessionID: target.sessionID, directory: target.area.directory })
      // Unknown counts as not done; a conversation that is gone holds nothing.
      if (!inbox.ok) return inbox.status === 404 ? 0 : Infinity
      return inbox.value.filter((item) => item.payload.metadata?.[OwnTeam.DISPATCH_META] !== undefined).length
    }),
  )
  const done = await services.write(teamID, async () => {
    const [state, dispatches, waiting, current] = await Promise.all([
      Digest.load(services.kv, teamID),
      services.registry.dispatches.list(teamID),
      services.registry.dispatches.counts(teamID),
      services.registry.areas.list(teamID),
    ])
    const open = targets.map((target, index): Fold.Open => {
      const area = target.area
      // Area messages and notices are no requests: 모두 끝남 never waits for an answer to one (5.8).
      const sent = dispatches.flatMap((item) =>
        item.areaID === area.id && item.to === target.key && item.sentTo && Fold.request(item) ? [item.sentTo.at] : [],
      )
      const fold = Fold.area(state, area.id)
      const finished = Fold.finished(target.key === undefined ? fold : Fold.peer(fold, target.key))
      return {
        // Main 멈춤 or direct work keeps the area out (TI-13, 2026-11-14).
        paused: Direct.kept(current.find((item) => item.id === area.id) ?? area),
        // The outbox is the area's: counted once, with its owner.
        waiting: target.key === undefined ? (waiting[area.id] ?? 0) : 0,
        queued: queued[index] ?? 0,
        active: target.sessionID !== null && active.value.has(target.sessionID),
        ...(sent.length === 0 ? {} : { sent: Math.max(...sent) }),
        ...(finished === undefined ? {} : { finished }),
      }
    })
    if (!Fold.allDone(open, state.allDone)) return false
    const now = services.clock.now()
    const entry = Fold.entry({ at: now, reason: "all-done", text: "모든 영역이 맡긴 일을 끝냈습니다" })
    await Digest.save(services.kv, { ...Fold.append(state, entry), allDone: now })
    return true
  })
  if (done) services.features().wake.request(teamID)
}

/** Writes the area (inside the write section) and tells the clients (`area.changed`, leader only). */
async function put(services: Services.Context, area: OwnTeam.Area) {
  const rev = await services.registry.areas.put(area)
  if (rev === undefined) return
  services.hub.publish({
    name: "area.changed",
    data: { teamID: area.teamID, areaID: area.id, rev, status: area.status, paused: area.paused },
  })
}
