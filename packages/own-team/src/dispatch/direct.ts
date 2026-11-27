export * as Direct from "./direct.js"

import type { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import { Digest } from "../report/digest.js"
import { Fold } from "../report/fold.js"
import { Texts } from "../report/texts.js"
import type { Services } from "../services.js"
import { Outbox } from "./dispatch.js"
import { Hold } from "./hold.js"
import { Pause } from "./pause.js"
import { Talk } from "./talk.js"

/**
 * 직접 작업 (2026-11-14): the user works with an area's owner directly. A user (not machine) message in the owner
 * conversation starts it (`Policy.directHold` on, the owner not serving a main request) and records it in
 * `Area.directWork`; nothing ends it by time, only a hand-back. While the area is held and Main 멈춤 is off, the main's
 * new requests wait in the outbox (only {@link pass}ing items go), the owner's and peers' reports are stored without
 * waking the main (`report/texts.ts` keeps them whole), and the main neither integrates nor reshapes the area by
 * itself. The hand-back writes one digest entry ({@link handed}) and lets the waiting requests in.
 *
 * This module holds the pure rules every part reads, and the {@link create}d feature (`services.features().direct`).
 */

/**
 * How long a request sent to the owner counts as served before its `session.inbox.enqueued` is folded: the outbox's
 * `sent` and the fold of the inbox event are apart, and a cancelled inbox item leaves the request `sent` for good.
 */
export const FOLD_LAG_MS = 60_000

/** Direct work starts at all (`Policy.directHold`, default on). */
export function hold(team: Pick<OwnTeam.Team, "policy">) {
  return team.policy.directHold ?? true
}

/** Whether owners and peers tell the main about work the user asked them for directly (`Policy.directTell`). */
export function tell(team: Pick<OwnTeam.Team, "policy">): OwnTeam.DirectTell {
  const value = team.policy.directTell
  return value === "none" || value === "always" ? value : "judge"
}

/** The area is held by direct work now: active, `directWork` set and Main 멈춤 off (it holds the area by itself). */
export function live(area: Pick<OwnTeam.Area, "state" | "paused" | "directWork">) {
  return area.state === "active" && area.directWork !== undefined && area.paused === false
}

/**
 * The upkeep rule (TI-13): own's automatic work (a new conversation, reorganizing, large-file steps) leaves the area
 * alone while Main 멈춤 is on or direct work holds it, also under 모두 멈추기.
 */
export function kept(area: Pick<OwnTeam.Area, "state" | "paused" | "directWork">) {
  return area.paused !== false || (area.state === "active" && area.directWork !== undefined)
}

/**
 * The seat (the owner, or a peer for its own reports) serves a main request now, so the user's message steers that
 * work and does not start direct work, and its reports are not held back: a request waits in its inbox; it received
 * one, its run has not ended and it has not answered; or a main or program request of the area went to it within
 * {@link FOLD_LAG_MS} and is not folded yet (a notice or an area message does not count). `seat`: the area and the
 * seat's conversation; `sent`: the area's dispatches (others are ignored). Only the owner's fold records a run's end.
 */
export function serving(
  slot: Fold.Answers,
  seat: { readonly areaID: string; readonly sessionID: SessionID | null },
  sent: ReadonlyArray<Pick<OwnTeam.Dispatch, "id" | "areaID" | "from" | "kind" | "state" | "sentTo">>,
  now: number,
) {
  if (Object.keys(slot.queued ?? {}).length > 0) return true
  const ended = "ended" in slot ? slot.ended : undefined
  if (slot.received !== undefined && ended !== slot.received.dispatchID && Fold.unreported(slot) !== undefined)
    return true
  // Nothing is queued here, so a folded request is the received one. Notices and area messages are never folded
  // into `queued`/`received` (`Fold.request`), so counting them would keep the seat serving for the whole lag.
  return sent.some(
    (item) =>
      item.areaID === seat.areaID &&
      Fold.request(item) &&
      item.state === "sent" &&
      item.sentTo !== undefined &&
      item.sentTo.sessionID === seat.sessionID &&
      item.sentTo.at > now - FOLD_LAG_MS &&
      item.id !== slot.received?.dispatchID,
  )
}

/** The owner's seat of `area`, for {@link serving}. */
export function owner(area: Pick<OwnTeam.Area, "id" | "owner">) {
  return { areaID: area.id, sessionID: area.owner.sessionID }
}

/**
 * What enters a held area: replies and notices (the conversation asked for them), and the program's requests of an
 * integration or op started during the stretch (only the user starts one then) except a target sync. The request's
 * `origin` is that start, so an integration that began before the stretch and asks later (a conflict after its
 * restart) waits too. Everything else, the main's answers included, waits for the hand-back. An area that is not held
 * lets everything in.
 */
export function pass(area: Pick<OwnTeam.Area, "directWork">) {
  return (item: Pick<OwnTeam.Dispatch, "from" | "kind" | "createdAt" | "origin">) =>
    area.directWork === undefined ||
    Outbox.solicited(item) ||
    (item.from === "team" && item.kind !== "sync" && (item.origin ?? item.createdAt) >= area.directWork.since)
}

/**
 * `Area.directWork` after a user message at `at` in the owner conversation: a stretch moves its `at`; none starts one
 * only with `hold` on and the owner not `serving`. `undefined` = not held.
 */
export function marked(
  area: Pick<OwnTeam.Area, "directWork">,
  input: { readonly hold: boolean; readonly serving: boolean; readonly at: number },
): OwnTeam.Area["directWork"] {
  if (area.directWork) return { since: area.directWork.since, at: input.at }
  if (!input.hold || input.serving) return undefined
  return { since: input.at, at: input.at }
}

/** The user's last direct input in the area: the owner conversation's or any peer's (last-activity readers). */
export function touched(area: Pick<OwnTeam.Area, "direct" | "peers">) {
  return Math.max(area.direct?.at ?? 0, ...(area.peers ?? []).map((peer) => peer.direct?.at ?? 0))
}

/** What the hand-back entry knows besides the stretch summary; program facts are read before the team write. */
export interface Facts {
  /** `handed`: the user handed the area back; `taken`: the main took it back. */
  readonly why: "handed" | "taken"
  /** The `team_status{area}` argument that shows the whole reports (the area's slug). */
  readonly area: string
  /** The area has a 반영 후보 (`Area.candidate`). */
  readonly candidate?: boolean
  /** Commits of the area's branch not in the target; 0 or unknown is left out. */
  readonly ahead?: number
  /** The area folder has uncommitted changes; unknown is left out. */
  readonly dirty?: boolean
}

/** Report kinds in the order the hand-back counts them; other kinds follow by name, as written. */
const KINDS: Readonly<Record<string, string>> = {
  ready: "반영 준비",
  blocked: "막힘",
  failed: "실패",
  done: "끝남",
  progress: "진행",
}

/**
 * The hand-back entry (`handed` or `taken`), one line: the time range and right after it the pointer to the whole
 * reports, so the 160-character clip of an area note cuts the counts or the quote, never the pointer; then the report
 * counts, the candidate, the program facts, and the newest report's excerpt last. `summary`: the stretch summary with
 * its `until` (`Fold.stretchEnd`).
 *
 * `사용자가 직접 작업을 마치고 넘김(13:02~15:40) · 전문: team_status{area:"hwamyeon"} · 그동안 보고 3개(반영 준비 1, 진행 2) · 반영 후보 있음 · 본 코드에 없는 저장 지점 2개 · 커밋 안 된 변경 있음 · 마지막 보고: "…"`
 */
export function handed(summary: Fold.StretchSummary, facts: Facts) {
  const lead = facts.why === "taken" ? "메인이 넘겨받음" : "사용자가 직접 작업을 마치고 넘김"
  const known = Object.keys(KINDS).filter((kind) => (summary.kinds[kind] ?? 0) > 0)
  const other = Object.keys(summary.kinds)
    .filter((kind) => !(kind in KINDS) && summary.kinds[kind] > 0)
    .toSorted()
  const counts = [...known, ...other].map((kind) => `${KINDS[kind] ?? kind} ${summary.kinds[kind]}`).join(", ")
  return [
    `${lead}(${span(summary.since, summary.until ?? summary.since)})`,
    `전문: team_status{area:"${facts.area}"}`,
    summary.n > 0 ? `그동안 보고 ${summary.n}개${counts === "" ? "" : `(${counts})`}` : "그동안 보고 없음",
    ...(facts.candidate ? ["반영 후보 있음"] : []),
    ...(facts.ahead !== undefined && facts.ahead > 0 ? [`본 코드에 없는 저장 지점 ${facts.ahead}개`] : []),
    ...(facts.dirty ? ["커밋 안 된 변경 있음"] : []),
    ...(summary.n > 0 && summary.last !== undefined ? [`마지막 보고: "${summary.last.replaceAll("</", "<\\/")}"`] : []),
  ].join(" · ")
}

/** `13:02~15:40` within a day, else both with their dates (a stretch may last days). */
function span(since: number, until: number) {
  const day = (at: number) => Talk.clock(at).slice(0, 10)
  if (day(since) !== day(until)) return `${Talk.clock(since)}~${Talk.clock(until)}`
  return `${Talk.clock(since).slice(11)}~${Talk.clock(until).slice(11)}`
}

/**
 * The direct-work feature. `said`/`spoke` keep, per process, when the user last wrote into each team's main
 * conversation (empty after a restart, so the main's at-once hand-back falls back to a plan).
 */
export function create(services: Services.Context): Services.Direct {
  const spoke = new Map<string, number>()
  // Main and program requests the outbox is sending to an owner now, per `teamID:areaID` (process-local, as the outbox).
  const sending = new Map<string, number>()
  return {
    note: (input) => note(services, input, () => sending.has(`${input.teamID}:${input.areaID}`)),
    sending: (dispatch) => {
      if (dispatch.to !== undefined || !Fold.request(dispatch)) return () => {}
      const key = `${dispatch.teamID}:${dispatch.areaID}`
      sending.set(key, (sending.get(key) ?? 0) + 1)
      return () => {
        const left = (sending.get(key) ?? 1) - 1
        if (left > 0) return void sending.set(key, left)
        sending.delete(key)
      }
    },
    said: (teamID) => {
      spoke.set(teamID, services.clock.now())
    },
    spoke: (teamID) => spoke.get(teamID) ?? 0,
    end: (input) => end(services, input),
    sweep: async (teamID) => {
      const held = (await services.registry.areas.list(teamID)).filter(
        (area) => area.state !== "retired" && area.directWork !== undefined,
      )
      // One after another, so the hand-back entries keep the areas' order.
      await held.reduce<Promise<unknown>>(
        (previous, area) => previous.then(() => end(services, { teamID, areaID: area.id, why: "handed" })),
        Promise.resolve(),
      )
    },
  }
}

/**
 * A user message in the owner conversation (`Services.Direct.note`): the `direct` mark, and `directWork` started or
 * moved (`marked`). `serving` reads the area's fold and its dispatches inside the write, so a request the outbox sent
 * meanwhile is seen; `sending` (read inside the write too) covers one the outbox is still sending.
 */
async function note(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly sessionID: SessionID },
  sending: () => boolean,
) {
  const written = await services.write(input.teamID, async () => {
    const [team, area] = await Promise.all([
      services.registry.teams.get(input.teamID),
      services.registry.areas.get(input.teamID, input.areaID),
    ])
    if (!team || team.state !== "on" || !area) return undefined
    const at = services.clock.now()
    // The seat moved since the hook looked: the mark stays information, as in any other conversation of the folder.
    const seat = area.owner.sessionID === input.sessionID
    const starts = seat && area.directWork === undefined && area.state === "active" && hold(team)
    const busy = starts
      ? sending() ||
        serving(
          Fold.area(await Digest.load(services.kv, team.id), area.id),
          owner(area),
          await services.registry.dispatches.list(team.id, area.id),
          at,
        )
      : false
    const directWork = seat ? marked(area, { hold: starts, serving: busy, at }) : area.directWork
    const next: OwnTeam.Area = {
      ...area,
      direct: { at, sessionID: input.sessionID },
      ...(directWork === undefined ? {} : { directWork }),
    }
    const started = area.directWork === undefined && directWork !== undefined
    return { area: next, started, rev: await services.registry.areas.put(next) }
  })
  if (written?.rev === undefined) return
  if (written.started) services.log.info("direct_started", { teamID: input.teamID, areaID: input.areaID })
  changed(services, written.area, written.rev)
}

/**
 * The hand-back (`Services.Direct.end`): the program facts first (git, outside the team's lock), then one write that
 * removes `directWork`, ends the stretch in the digest summary and in its whole store, and appends the entry; then the
 * main wakes (`handed`), and with Main 멈춤 off the parked queue, the waiting integrations and the outbox go again.
 */
async function end(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly why: "handed" | "taken" },
): Promise<Services.Handed | undefined> {
  const [team, before] = await Promise.all([
    services.registry.teams.get(input.teamID),
    services.registry.areas.get(input.teamID, input.areaID),
  ])
  if (!team || !before?.directWork) return undefined
  const [ahead, dirty] = await Promise.all([lead(team, before), Hold.changes(before.directory)])
  const written = await services.write(input.teamID, async () => {
    const area = await services.registry.areas.get(input.teamID, input.areaID)
    if (!area?.directWork) return undefined
    const since = area.directWork.since
    const until = services.clock.now()
    const ended = Fold.stretchEnd(await Digest.load(services.kv, team.id), { areaID: area.id, since, until })
    const summary = Fold.area(ended, area.id).stretch ?? { since, until, n: 0, kinds: {} }
    const line = handed(summary, {
      why: input.why,
      // `team_status{area}` takes the id without its `ar_` prefix (`MainTools.area`).
      area: area.id.replace(/^ar_/, ""),
      ...(area.candidate === undefined ? {} : { candidate: true }),
      ...(ahead === undefined ? {} : { ahead }),
      ...(dirty.ok ? { dirty: dirty.paths.length > 0 } : {}),
    })
    await Digest.save(
      services.kv,
      Fold.append(ended, Fold.entry({ at: until, reason: input.why, areaID: area.id, text: line })),
    )
    const stretch = await Texts.loadStretch(services.kv, services.log, team.id, area.id)
    await Texts.saveStretch(services.kv, team.id, area.id, Texts.end(stretch, since, until))
    const { directWork: _directWork, ...rest } = area
    return { area: rest, line, rev: await services.registry.areas.put(rest) }
  })
  if (!written) return undefined
  services.log.info("direct_ended", { teamID: input.teamID, areaID: input.areaID, why: input.why })
  if (written.rev !== undefined) changed(services, written.area, written.rev)
  if (input.why === "handed") services.features().wake.request(input.teamID)
  // The main's requests and the program's, as `team_area resume` counts them (area messages and notices apart).
  const waiting = (await services.registry.dispatches.waiting(input.teamID, input.areaID)).filter(Fold.request).length
  if (written.area.paused === false && written.area.state === "active") {
    const features = services.features()
    await Pause.wake(services, written.area)
    await features.integrate.retry(input.teamID)
    await features.admit.drain({ teamID: input.teamID, areaID: input.areaID })
  }
  return { line: written.line, waiting }
}

/** `git rev-list --count <target>..<area branch>` in the main folder; `undefined` when 0 or git cannot say. */
async function lead(team: OwnTeam.Team, area: OwnTeam.Area) {
  const value = await Digest.lead(team, `refs/heads/${area.branch}`)
  return value === 0 ? undefined : value
}

function changed(services: Services.Context, area: OwnTeam.Area, rev: number) {
  services.hub.publish({
    name: "area.changed",
    data: { teamID: area.teamID, areaID: area.id, rev, status: area.status, paused: area.paused },
  })
}
