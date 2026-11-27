export * as Digest from "./digest.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Direct } from "../dispatch/direct.js"
import { Talk } from "../dispatch/talk.js"
import { Identity } from "../git/identity.js"
import { Git } from "../git/run.js"
import { Merge } from "../integrate/merge.js"
import { IntegrateOp } from "../integrate/op.js"
import { Keys } from "../registry/keys.js"
import type { Services } from "../services.js"
import { Fold } from "./fold.js"
import { OpWords } from "../ops/words.js"

/**
 * The digest (06 §5.5–5.6): events folded in KV `digest:<teamID>` until the main is told, and the team update text
 * that `team_status` returns (no bound of its own since 2026-11-14: core bounds a tool's output and saves the whole)
 * and the `<team-update>` message carries (at most 2k tokens). Areas are worded from their
 * current state (status word, the owner's latest report, direct user talk, Main 멈춤, waiting requests); untold entries
 * add notes (a failed run, `끝났지만 보고 없음`, `모두 끝남`, integration results and decision records, the last two as
 * team notes in the shared `OwnTeamText` line forms). An integration that runs or waits has a line of its own
 * (`OwnTeamText.integrationLine`, so own-web counts it) and takes its area out of `할 일:`. The main sees the whole team
 * and a `할 일:` line; an owner sees its own area and a one-line team summary. Rendering has no side effects.
 *
 * Area peers (동료) have a line each under their area's (`OwnTeamText.peerLine`, no leading `- `, so own-web counts no
 * area for it): its state word, its latest report since its last request, its notes, the user's direct talk there and
 * its waiting requests. The area line counts only the owner's requests and direct talk; a peer that answered
 * `blocked` gets a `할 일:` item. The user's note about the owner (담당 메모, `owner.note`) is in no text made here:
 * `team_status` says it once, on the roster line it adds per area with a peer (outside the token bound).
 *
 * Pairs of areas whose branches would conflict when both are integrated share one `반영 때 충돌 예상:` line
 * ({@link conflicts}). It is worded from git when a text is made, never folded, so it never wakes the main.
 *
 * An entry of an area that is no longer in the team (끝내기, 묶기) is a team note: it is the last the main hears of it.
 * A reorganization adds what no step told the main ({@link reorganized}): the actions skipped for their area and the
 * main requests it did not send.
 *
 * Area messages (영역 메시지, 06 §5.8) are no main requests: they never count in `맡긴 일`, never hide `사용자가 직접 대화함`
 * and are counted apart (`영역 메시지 n개 기다림`). The main reads their audit lines, which `dispatch/talk.ts` keeps,
 * in a block after `할 일:` (`영역 메시지 n건:`, never waking it; `fit` drops them first), and a hit of the hourly
 * limit adds a `할 일:` item. An owner's or a peer's own view (`viewer`) adds the other areas (name and slug, status,
 * Main 멈춤, direct talk, branch, goal, latest report, peers), its own asks, its watches and the notes held for it.
 *
 * 사용자 부탁 (5.5, 2026-10-16): what an owner or a peer passed on from the user (`team_report{kind:"relay"}`) is in the
 * main's view only, in a block of its own right after the first line (`사용자 부탁 n건:`), quoted and escaped like
 * every model or user text, with a larger quote budget than other notes ({@link RELAY_QUOTE}) so the user's words
 * arrive whole; `fit` keeps the earliest lines, so it is the last block it would cut. Each adds the `할 일:` item
 * `<영역>: 사용자 부탁 처리하기`.
 *
 * Direct work (직접 작업, 2026-11-14): while the user works with an area directly (`Direct.live`), its line says so with
 * the count of reports kept for the hand-back, and leaves out the owner's report, its failure notes and every `할 일`
 * item: they come with the hand-back line. With `Policy.directHold` on the owner's old `사용자가 직접 대화함` mark is
 * never printed; the 담당 요약 of a direct talk only with `Policy.directTell` `always`.
 *
 * Every cut of a quoted text ends in `…` (2026-11-14); the whole texts are in `team_status{area}` (`report/texts.ts`),
 * and the main's text then ends with {@link CUT_NOTE}. The update's `할 일:` line stays within {@link TODO_TOKENS} in
 * the short pass and is never dropped by `fit`.
 */

/** 06 §5.6: a team update stays within 2k tokens. */
export const MAX_TOKENS = 2_000

/** 06 §5.5 (2026-10-16): what an owner or a peer passed on from its conversation. */
export const RELAY = "사용자 부탁"

/**
 * How much of a relay the team update quotes: its whole excerpt (`Fold.excerpt`, 1,000 code points) in the full text,
 * 300 in the short one; the whole relay is in `team_status{area}`.
 */
export const RELAY_QUOTE = { full: 1_000, short: 300 } as const

/** The head of the main's `할 일:` line, which `fit` never drops. */
export const TODO = "할 일: "

/** How many tokens the `할 일:` line takes at most in the short pass; the rest is counted. */
export const TODO_TOKENS = 500

/** The main's last line when a quoted text was cut (every cut ends in `…`). */
export const CUT_NOTE = "'…'로 끝난 글의 전문: team_status{area}"

/**
 * A conservative token estimate: UTF-8 bytes / 3 (one token per Hangul syllable, more than common tokenizers use for
 * English text).
 */
export function tokens(text: string) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3)
}

export function create(services: Services.Context): Services.Digest {
  return {
    add: async (teamID, entry) => {
      await services.write(teamID, async () => save(services.kv, Fold.append(await load(services.kv, teamID), entry)))
      if (entry.wake) services.features().wake.request(teamID)
    },
    render: async (input) => {
      const team = await services.registry.teams.get(input.teamID)
      if (!team) return "팀 정보를 찾지 못했습니다."
      const facts = await gather(services, team, await load(services.kv, team.id), input.areaID, {
        ...(input.viewer === undefined ? {} : { viewer: input.viewer }),
        ...(input.causes ? { causes: true } : {}),
      })
      // `team_status`: no token bound of its own; the viewed area's role is quoted whole.
      return lines(facts, 160, input.areaID).join("\n")
    },
  }
}

const decode = Schema.decodeUnknownOption(Fold.State)
const encode = Schema.encodeSync(Fold.State)

export async function load(kv: Keys.Store, teamID: OwnTeam.TeamID): Promise<Fold.State> {
  return Option.getOrElse(decode(await kv.get(Keys.digest(teamID))), () => Fold.empty(teamID))
}

/** Inside the team's write section. */
export function save(kv: Keys.Store, state: Fold.State) {
  return kv.set(Keys.digest(state.teamID), Keys.toJson(encode(state)))
}

/** The `<team-update>` message for the main (06 §5.6); `talk`: the last audit line of area messages it carries (5.8). */
export async function update(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly state: Fold.State
    readonly seq: number
    readonly reasons: ReadonlyArray<string>
    readonly talk?: number
  },
) {
  const open = `<team-update seq="${input.seq}" reason="${input.reasons.join(",")}">`
  const close = "</team-update>"
  const body = fit(
    await gather(services, input.team, input.state, undefined, {
      ...(input.talk === undefined ? {} : { talk: input.talk }),
    }),
    MAX_TOKENS - tokens(`${open}\n\n${close}`),
  )
  return [open, body, close].join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Facts

export interface AreaFacts {
  readonly area: OwnTeam.Area
  readonly fold: Fold.AreaFold
  /** Requests in the outbox. */
  readonly waiting: number
  /** Main requests parked in the owner's inbox (`own.dispatch` items, 5.2). */
  readonly queued: number
  /** Area messages and notices for the owner, in the outbox or parked in its inbox (5.8). */
  readonly messages: number
  /** When the last main request was sent to the area. */
  readonly sent?: number
  /**
   * When the main asked for the last request that went in (its `createdAt`). A direct talk after it is news to the
   * main (5.4); a request the main asked for before the talk and that went in after it does not hide the talk.
   */
  readonly decided?: number
  /** Commits of the candidate over the target (반영 준비됨). */
  readonly ahead?: number
  /** 5.4 담당 요약 for a direct talk. */
  readonly summary?: string
  /** Notes from untold entries of the area (a failed run, 끝났지만 보고 없음). */
  readonly notes: ReadonlyArray<string>
  /** The area's integration that runs or waits now (06 §7.2), worded as a line of its own. */
  readonly integration?: OwnTeam.Integration
  /** The area's peers (동료), each worded on a line under the area's. */
  readonly peers: ReadonlyArray<PeerFacts>
  /** `team_status` (RH-20): why the outbox waits, since when and what holds it. */
  readonly held?: { readonly why: OwnTeam.WaitReason; readonly since: number; readonly cause?: OwnTeam.WaitCause }
}

/** One area peer as its line says it. */
export interface PeerFacts {
  readonly peer: OwnTeam.Peer
  readonly fold: Fold.PeerFold
  /** Its run is active now. */
  readonly active: boolean
  /** Requests for it in the outbox plus main requests in its queue. */
  readonly waiting: number
  /** Area messages and notices for it, in the outbox or in its queue (5.8). */
  readonly messages: number
  /** When the last main request was sent to it. */
  readonly sent?: number
  /** When the main asked for the last request that went to it. */
  readonly decided?: number
  /** Notes from untold entries about it (a failed run, 끝났지만 보고 없음, a refused request). */
  readonly notes: ReadonlyArray<string>
}

/** Two areas whose branches would conflict when both are integrated (5.6 충돌 예상), and the conflicted paths. */
export interface Conflict {
  readonly areas: readonly [OwnTeam.Area, OwnTeam.Area]
  readonly paths: ReadonlyArray<string>
}

export interface Facts {
  readonly team: OwnTeam.Team
  readonly now: number
  /** An owner's view of its own area. */
  readonly view?: OwnTeam.AreaID
  readonly areas: ReadonlyArray<AreaFacts>
  /** Requests made since the last `모두 끝남`, and how many of them were answered `done` or `ready`. */
  readonly tasks: { readonly total: number; readonly finished: number }
  /** Untold entries of the whole team (`모두 끝남`). */
  readonly notes: ReadonlyArray<string>
  /** In an owner's view only the pairs with its own area. */
  readonly conflicts: ReadonlyArray<Conflict>
  /** Updates are held past the hourly limit until then. */
  readonly limited?: number
  /** The main's view: the audit lines of area messages no sent update carried yet, oldest first (5.8). */
  readonly talk: ReadonlyArray<Talk.Line>
  /** The main's view: the hourly limit of asks was hit since the last update (`area-limit`). */
  readonly talkLimit: boolean
  /** The main's view: what owners and peers passed on from the user, oldest first (5.5, 2026-10-16). */
  readonly relays: ReadonlyArray<Relay>
  /** An owner's or a peer's own view (5.8). */
  readonly viewer?: ViewerFacts
}

/** One 사용자 부탁: who passed it on and the user's words. */
export interface Relay {
  readonly areaID?: OwnTeam.AreaID
  /** The area's name, else its id (an area that left the team since). */
  readonly area: string
  /** `담당`, or `동료 리뷰어`. */
  readonly who: string
  readonly at: number
  readonly text: string
}

/** What an owner or a peer sees besides its own area (06 §5.8). */
export interface ViewerFacts {
  /** The calling peer's key; absent = the owner. */
  readonly peer?: string
  /** Its asks of the last 12 hours, newest first (at most three), with what became of them. */
  readonly asks: ReadonlyArray<{ readonly dispatch: OwnTeam.Dispatch; readonly to: string; readonly state: string }>
  /** Its watches still waiting. */
  readonly watches: ReadonlyArray<Talk.Watch & { readonly name: string }>
  /** The notes held for it (they go with its next request). */
  readonly held: ReadonlyArray<OwnTeam.AreaNote>
}

/** How many of a viewer's asks its view lists. */
const ASKS_SHOWN = 3

const REPORTS: ReadonlySet<string> = new Set(Fold.ReportKind.literals)
const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: optional(Schema.String) })),
})
const decodeAssistant = Schema.decodeUnknownOption(Assistant)

/**
 * Reads what the text needs: registry, outbox, owner inboxes, the direct talk summary, the candidate's lead, the
 * predicted conflicts.
 */
export async function gather(
  services: Services.Context,
  team: OwnTeam.Team,
  state: Fold.State,
  view: OwnTeam.AreaID | undefined,
  options: {
    /** An owner's or a peer's own view (with `view`). */
    readonly viewer?: { readonly peer?: string }
    /** The last audit line of area messages the text may carry (a team update: what it marks told). */
    readonly talk?: number
    /** `team_status` (RH-20): why each area's waiting requests wait, since when and what holds them. */
    readonly causes?: boolean
  } = {},
): Promise<Facts> {
  const now = services.clock.now()
  const [areas, dispatches, integrations, talk] = await Promise.all([
    services.registry.areas.list(team.id),
    services.registry.dispatches.list(team.id),
    IntegrateOp.list(services, team.id),
    Talk.load(services.kv, team.id),
  ])
  const open = integrations.filter((item) => item.state === "running" || item.state === "waiting")
  const live = areas.filter((area) => area.state !== "retired")
  const present = new Set<string>(live.map((area) => area.id))
  const since = state.allDone ?? -Infinity
  // Area messages and notices are no requests (5.8): 맡긴 일, the last request and direct talk count requests only.
  const requests = dispatches.filter(Fold.request)
  const messages = dispatches.filter((item) => !Fold.request(item) && item.state === "waiting")
  const counted = requests.filter((item) => item.state !== "cancelled" && item.createdAt > since)
  // Whether a peer works now (one read, only when the team has peers; no Location is woken).
  const running = live.some((area) => (area.peers ?? []).length > 0) ? await services.http.session.active() : undefined
  const [facts, predicted] = await Promise.all([
    Promise.all(
      live.map(async (area): Promise<AreaFacts> => {
        const fold = Fold.area(state, area.id)
        const owned = requests.filter((item) => item.to === undefined)
        const sent = lastSent(owned, area.id)
        const decided = lastDecided(owned, area.id)
        // An owner's view words only its own area; the others count by status word.
        const worded = view === undefined || view === area.id
        const talked = talkedOf(team, area, decided)
        const [parked, ahead, summary, peers] = worded
          ? await Promise.all([
              queuedRequests(services, area, area.owner.sessionID),
              area.status.kind === "ready" && area.candidate ? lead(team, area.candidate.sha) : undefined,
              // The 담당 요약 of a direct talk only when owners tell the main about it every time (wish 1).
              talked && Direct.tell(team) === "always" ? directSummary(services, area, fold, talked) : undefined,
              Promise.all(
                (area.peers ?? []).map(async (peer): Promise<PeerFacts> => {
                  const mine = requests.filter((item) => item.to === peer.key)
                  const peerSent = lastSent(mine, area.id)
                  const peerDecided = lastDecided(mine, area.id)
                  const outbox = mine.filter((item) => item.areaID === area.id && item.state === "waiting").length
                  const told = messages.filter((item) => item.areaID === area.id && item.to === peer.key).length
                  const queue = await queuedRequests(services, area, peer.sessionID)
                  return {
                    peer,
                    fold: Fold.peer(fold, peer.key),
                    active: running?.ok === true && running.value.has(peer.sessionID),
                    waiting: outbox + queue.requests,
                    messages: told + queue.messages,
                    ...(peerSent === undefined ? {} : { sent: peerSent }),
                    ...(peerDecided === undefined ? {} : { decided: peerDecided }),
                    notes: [
                      ...new Set(
                        state.entries
                          .filter(
                            (item) =>
                              item.areaID === area.id && item.peer === peer.key && noted(item) && item.text !== "",
                          )
                          .map((item) => item.text),
                      ),
                    ],
                  }
                }),
              ),
            ])
          : [{ requests: 0, messages: 0 }, undefined, undefined, []]
        // While direct work holds the area, its failures go with the hand-back line, not on its line.
        const live = Direct.live(area)
        const notes = state.entries
          .filter(
            (item) =>
              item.areaID === area.id &&
              item.peer === undefined &&
              noted(item) &&
              item.text !== "" &&
              !(live && HANDED_LATER.has(item.reason)),
          )
          .map((item) => item.text)
        // Integration ids are ULIDs: the last one is the newest.
        const integration = open.findLast((item) => item.areaID === area.id)
        const outbox = owned.filter((item) => item.areaID === area.id && item.state === "waiting").length
        const held =
          options.causes && worded && outbox > 0
            ? await services.features().admit.waited?.({ teamID: team.id, areaID: area.id })
            : undefined
        return {
          area,
          fold,
          ...(held === undefined ? {} : { held }),
          // Requests for the area's peers are counted on their own lines.
          waiting: owned.filter((item) => item.areaID === area.id && item.state === "waiting").length,
          queued: parked.requests,
          messages:
            messages.filter((item) => item.areaID === area.id && item.to === undefined).length + parked.messages,
          ...(sent === undefined ? {} : { sent }),
          ...(decided === undefined ? {} : { decided }),
          ...(ahead === undefined ? {} : { ahead }),
          ...(summary === undefined ? {} : { summary }),
          notes: [...new Set(notes)],
          ...(integration === undefined ? {} : { integration }),
          peers,
        }
      }),
    ),
    conflicts(team, live, view),
  ])
  const finished = counted.filter((item) => {
    const fold = Fold.area(state, item.areaID)
    const answered = Fold.finished(item.to === undefined ? fold : Fold.peer(fold, item.to))
    return item.state === "sent" && item.sentTo !== undefined && answered !== undefined && answered >= item.sentTo.at
  }).length
  return {
    team,
    now,
    ...(view === undefined ? {} : { view }),
    areas: facts,
    tasks: { total: counted.length, finished },
    // An area that left the team (끝내기, 묶기) has no line of its own: its entries are team notes.
    notes: [
      ...new Set(
        state.entries
          .filter(
            (item) =>
              (item.areaID === undefined || !present.has(item.areaID)) && item.reason !== "relay" && item.text !== "",
          )
          .map((item) => item.text),
      ),
    ],
    conflicts: predicted,
    ...(state.limited && state.limited.until > now ? { limited: state.limited.until } : {}),
    talk: view === undefined ? Talk.untold(talk, options.talk) : [],
    talkLimit: view === undefined && state.entries.some((item) => item.reason === "area-limit"),
    relays: view === undefined ? relaysOf(state, live) : [],
    ...(view !== undefined && options.viewer
      ? { viewer: viewerFacts({ view, peer: options.viewer.peer, areas: live, dispatches, talk, now }) }
      : {}),
  }
}

/** An entry worded as a note: not a report, and not a 사용자 부탁 (its own block, 5.5). */
function noted(item: Fold.Entry) {
  return !REPORTS.has(item.reason) && item.reason !== "relay"
}

/** Notes a held area's line leaves out (2026-11-14): its failures come with the hand-back line. */
const HANDED_LATER: ReadonlySet<string> = new Set(["failed", "unreported"])

/**
 * The user's direct talk in the owner conversation that is news to the main (5.4): after the last request the main
 * asked for. Never with `Policy.directHold` on: direct work says it instead (2026-11-14).
 */
function talkedOf(team: OwnTeam.Team, area: OwnTeam.Area, decided: number | undefined) {
  if (Direct.hold(team)) return undefined
  return area.direct && (decided === undefined || area.direct.at > decided) ? area.direct : undefined
}

/** The untold relays (5.5): who passed each on, by the area and peer it came from. */
function relaysOf(state: Fold.State, areas: ReadonlyArray<OwnTeam.Area>): ReadonlyArray<Relay> {
  return state.entries.flatMap((item): Relay[] => {
    if (item.reason !== "relay" || item.text === "") return []
    const area = areas.find((entry) => entry.id === item.areaID)
    const peer = item.peer === undefined ? undefined : (area?.peers ?? []).find((entry) => entry.key === item.peer)
    return [
      {
        ...(item.areaID === undefined ? {} : { areaID: item.areaID }),
        area: area?.name ?? item.areaID ?? "?",
        who: item.peer === undefined ? "담당" : `${OwnTeamText.PEER} ${peer?.label ?? item.peer}`,
        at: item.at,
        text: item.text,
      },
    ]
  })
}

/** An owner's or a peer's asks, watches and held notes (06 §5.8). */
function viewerFacts(input: {
  readonly view: OwnTeam.AreaID
  readonly peer: string | undefined
  readonly areas: ReadonlyArray<OwnTeam.Area>
  readonly dispatches: ReadonlyArray<OwnTeam.Dispatch>
  readonly talk: Talk.State
  readonly now: number
}): ViewerFacts {
  const slot: Talk.Slot = { areaID: input.view, ...(input.peer === undefined ? {} : { peer: input.peer }) }
  const area = (id: string) => input.areas.find((item) => item.id === id)
  const open = new Set<string>(Talk.open(input.talk, input.now).map((item) => item.id))
  const asks = input.dispatches
    .filter(
      (item) =>
        item.from === "area" &&
        item.kind === "ask" &&
        item.sender !== undefined &&
        Talk.same(Talk.from(item.sender), slot) &&
        input.now - item.createdAt < Talk.EXPIRE_MS,
    )
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(0, ASKS_SHOWN)
    .map((dispatch) => {
      const receiver = area(dispatch.areaID)
      const reply = input.dispatches.find((item) => item.replyTo === dispatch.id && item.state !== "cancelled")
      const state =
        dispatch.state === "cancelled"
          ? "지워짐"
          : reply
            ? `답 옴(${Talk.clock(reply.createdAt)})`
            : dispatch.state === "waiting"
              ? "대기함에서 기다림"
              : open.has(dispatch.id)
                ? `들어감(${Talk.clock(dispatch.sentTo?.at ?? dispatch.createdAt)})`
                : "답 없이 끝남"
      return { dispatch, to: receiver ? Talk.who(receiver, dispatch.to) : dispatch.areaID, state }
    })
  const watches = input.talk.watches.flatMap((watch) =>
    Talk.same(Talk.from(watch.watcher), slot) && input.now - watch.at < Talk.EXPIRE_MS
      ? [{ ...watch, name: area(watch.areaID)?.name ?? watch.areaID }]
      : [],
  )
  const active = new Set<string>(input.areas.filter((item) => item.state === "active").map((item) => item.id))
  const held = Talk.held(input.talk, {
    areaID: input.view,
    ...(input.peer === undefined ? {} : { to: input.peer }),
    now: input.now,
    active,
  })
  return { ...(input.peer === undefined ? {} : { peer: input.peer }), asks, watches, held }
}

/** Pairs not asked before that one text checks (5.6: four areas ahead are six pairs); later texts check the rest. */
export const NEW_PAIRS = 6

/**
 * 5.6 충돌 예상 (P2-18b): pairs of areas whose branches both have commits the target lacks and conflict with each
 * other (`Merge.predict`, kept per SHA pair: unchanged branches cost the two queries of `Merge.ahead`). An owner's view
 * checks only the pairs with its own area. Pairs of areas only: a conflict with the target is found when integrating
 * (7.3). When git cannot say, there is no line.
 */
async function conflicts(
  team: OwnTeam.Team,
  areas: ReadonlyArray<OwnTeam.Area>,
  view: OwnTeam.AreaID | undefined,
): Promise<ReadonlyArray<Conflict>> {
  if (areas.length < 2) return []
  const listed = await Merge.ahead({
    repo: team.commonDir,
    target: team.target,
    branches: areas.map((area) => area.branch),
  })
  if (!listed.ok) return []
  const tips = areas.flatMap((area) => {
    const sha = listed.tips.get(area.branch)
    return sha === undefined ? [] : [{ area, sha }]
  })
  const pairs = tips.flatMap((first, index) =>
    tips
      .slice(index + 1)
      .filter(
        (second) =>
          first.sha !== second.sha && (view === undefined || first.area.id === view || second.area.id === view),
      )
      .map((second) => ({
        areas: [first.area, second.area] as const,
        pair: { repo: team.commonDir, attrs: listed.target, a: first.sha, b: second.sha },
      })),
  )
  const later = new Set(pairs.filter((item) => !Merge.predicted(item.pair)).slice(NEW_PAIRS))
  const answers = await Promise.all(
    pairs
      .filter((item) => !later.has(item))
      .map(async (item) => ({ areas: item.areas, answer: await Merge.predict(item.pair) })),
  )
  return answers.flatMap((item) =>
    item.answer.ok && !item.answer.clean ? [{ areas: item.areas, paths: item.answer.paths }] : [],
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Reorganizations (06 §8.1, §8.2, §5.6)

/** Why an action was left out for its area (TI-9, TI-13, broken): the main may propose it again later (8.1). */
export const SKIPPED: ReadonlySet<OwnTeam.SkipReason> = new Set(["paused", "busy", "broken"])

/** How the team update and the main's tool answers name a skip's reason (`'api'(메인 멈춤)`). */
export const SKIP_WORDS: Readonly<Partial<Record<OwnTeam.SkipReason, string>>> = {
  paused: "메인 멈춤",
  busy: "일하는 중",
  broken: "멈춘 상태",
}

/** Requests listed by their text in a team note; the rest are counted. */
const LISTED = 5

/**
 * The team notes of a reorganization that ended or waits for its confirms (5.6: folded, no wake): the actions skipped
 * for their area, and the waiting main requests it cancelled (8.2 끝내기·빼기 `outbox-migrate`: `목록을 메인에`), each
 * request by its task or the start of its text.
 */
export function reorganized(input: {
  readonly skipped: ReadonlyArray<{ readonly area: string; readonly why: OwnTeam.SkipReason }>
  readonly cancelled: ReadonlyArray<{ readonly area: string; readonly text: string }>
}): ReadonlyArray<string> {
  const skipped = input.skipped.map((item) => `'${item.area}'(${SKIP_WORDS[item.why] ?? item.why})`)
  const listed = input.cancelled.slice(0, LISTED).map((item) => `'${item.area}' ${quoted(item.text, 60)}`)
  const more = input.cancelled.length - listed.length
  return [
    ...(skipped.length === 0
      ? []
      : [`정리에서 건너뛴 영역: ${[...new Set(skipped)].join(", ")}. 나중에 다시 제안할 수 있습니다`]),
    ...(listed.length === 0
      ? []
      : [`보내지 않은 메인 요청 ${input.cancelled.length}개: ${listed.join(", ")}${more > 0 ? ` 외 ${more}개` : ""}`]),
  ]
}

function lastSent(dispatches: ReadonlyArray<OwnTeam.Dispatch>, areaID: OwnTeam.AreaID) {
  const times = dispatches.flatMap((item) => (item.areaID === areaID && item.sentTo ? [item.sentTo.at] : []))
  return times.length === 0 ? undefined : Math.max(...times)
}

function lastDecided(dispatches: ReadonlyArray<OwnTeam.Dispatch>, areaID: OwnTeam.AreaID) {
  const times = dispatches.flatMap((item) => (item.areaID === areaID && item.sentTo ? [item.createdAt] : []))
  return times.length === 0 ? undefined : Math.max(...times)
}

/** Main requests, and area messages or notices (5.8), in the queue of the area's owner or one of its peers. */
async function queuedRequests(services: Services.Context, area: OwnTeam.Area, sessionID: string | null) {
  if (sessionID === null) return { requests: 0, messages: 0 }
  const inbox = await services.http.inbox.list({ sessionID, directory: area.directory })
  if (!inbox.ok) return { requests: 0, messages: 0 }
  const queued = inbox.value.filter((item) => item.payload.metadata?.[OwnTeam.DISPATCH_META] !== undefined)
  const requests = queued.filter((item) => Fold.requestOf(item.payload.metadata) !== undefined).length
  return { requests, messages: queued.length - requests }
}

/**
 * `git rev-list --count <target>..<rev>` in the main folder (`rev`: the candidate, or an area's branch for the
 * hand-back's program facts); `undefined` when git cannot say.
 */
export async function lead(team: OwnTeam.Team, sha: string) {
  const counted = await Git.run(["rev-list", "--count", `refs/heads/${team.target}..${sha}`], {
    cwd: team.home.directory,
  })
  if (!counted.ok) return undefined
  const value = Number(counted.stdout.trim())
  return Number.isInteger(value) ? value : undefined
}

/**
 * 5.4 담당 요약: the last report after the direct talk, else the first 300 characters of the last answer in that
 * conversation (`session.message`, read only).
 */
async function directSummary(
  services: Services.Context,
  area: OwnTeam.Area,
  fold: Fold.AreaFold,
  direct: NonNullable<OwnTeam.Area["direct"]>,
) {
  const latest = Fold.latest(fold)
  if (latest && latest.at > direct.at) return latest.text
  const messages = await services.http.session.messages({
    sessionID: direct.sessionID,
    directory: area.directory,
    limit: 20,
    order: "desc",
  })
  if (!messages.ok) return undefined
  const answer = messages.value.data
    .flatMap((message) => {
      const assistant = Option.getOrUndefined(decodeAssistant(message))
      const text = assistant?.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("")
      return text ? [text] : []
    })
    .at(0)
  return answer === undefined ? undefined : answer.slice(0, 300)
}

// ---------------------------------------------------------------------------------------------------------------
// Wording

/**
 * The text within `budget` tokens: shorter quotes first, then lines that do not fit are left out (and counted). The
 * `할 일:` line and {@link CUT_NOTE} are kept first (2026-11-14), so a long team never loses what the main acts on.
 */
export function fit(facts: Facts, budget: number) {
  const full = lines(facts, 160)
  if (tokens(full.join("\n")) <= budget) return full.join("\n")
  const short = lines(facts, 60)
  if (tokens(short.join("\n")) <= budget) return short.join("\n")
  const more = (count: number) => `… ${count}줄 더: team_status로 모두 보세요`
  const pinned = (line: string) => line.startsWith(TODO) || line === CUT_NOTE
  const fixed = short.filter(pinned)
  const kept = short.reduce<ReadonlySet<number>>((acc, line, index) => {
    if (pinned(line)) return acc
    const tried = [...fixed, ...short.filter((_, at) => acc.has(at)), line, more(999)]
    return tokens(tried.join("\n")) <= budget ? new Set([...acc, index]) : acc
  }, new Set())
  const shown = short.filter((line, index) => pinned(line) || kept.has(index))
  return [...shown, more(short.length - shown.length)].join("\n")
}

/**
 * The lines of the team update (06 §5.6 형식); `quote` caps quoted texts. `focus`: the area whose role is quoted whole
 * (`team_status` of one area, or an owner's or a peer's own view); every other role is quoted up to {@link ROLE_QUOTE}.
 */
export function lines(facts: Facts, quote: number, focus?: OwnTeam.AreaID): string[] {
  const own = facts.view === undefined ? undefined : facts.areas.find((item) => item.area.id === facts.view)
  const tasks = facts.tasks.total > 0 ? ` · 맡긴 일 ${facts.tasks.total}개 중 ${facts.tasks.finished}개 끝남` : ""
  const held =
    facts.limited === undefined
      ? []
      : [`팀 소식이 한 시간에 ${Fold.PER_HOUR}번을 넘어 ${Talk.clock(facts.limited)}까지 모아 둡니다`]
  if (facts.view !== undefined)
    return [
      `팀: 영역 ${facts.areas.length}개${counts(facts.areas)}${tasks}`,
      ...held,
      ...(own
        ? [areaLine(facts, own, quote, focus), ...peerLines(own, quote)]
        : ["- 이 영역을 팀에서 찾지 못했습니다"]),
      ...(own ? integrationLines(facts, [own]) : []),
      ...viewerLines(facts, quote),
      ...conflictLine(facts, quote),
    ]
  // 5.5: a relayed request is the main's next step for its area, before what the area's state asks.
  const relayed = [...new Set(facts.relays.flatMap((item) => (item.areaID === undefined ? [] : [item.area])))]
  const todo = [
    ...relayed.map((area) => `${area}: ${RELAY} 처리하기`),
    ...facts.areas.flatMap((item) => todoOf(item)),
    ...(facts.talkLimit ? ["영역 메시지 상한 → 주고받은 영역에 할 일을 정해 보내거나 사용자에게 알리기"] : []),
  ]
  const budget = quote >= 160 ? RELAY_QUOTE.full : RELAY_QUOTE.short
  const main = [
    `영역 ${facts.areas.length}개${tasks}`,
    ...held,
    // First after the head, so `fit` keeps the user's words before any other block (5.5).
    ...(facts.relays.length === 0
      ? []
      : [
          `${RELAY} ${facts.relays.length}건:`,
          ...facts.relays.map(
            (item) => `  · ${escaped(item.area)}(${item.who}, ${Talk.clock(item.at)}): ${quoted(item.text, budget)}`,
          ),
        ]),
    ...facts.notes.map((note) => `- ${note}`),
    ...integrationLines(facts, facts.areas),
    ...facts.areas.flatMap((item) => [areaLine(facts, item, quote, focus), ...peerLines(item, quote)]),
    ...conflictLine(facts, quote),
    ...(todo.length === 0 ? [] : [quote < 160 ? todoLine(todo) : `${TODO}${todo.join(" · ")}`]),
    // After 할 일: what the areas told each other, never waking the main; the first lines `fit` drops (5.8).
    ...(facts.talk.length === 0
      ? []
      : [
          `영역 메시지 ${facts.talk.length}건:`,
          ...facts.talk.map((item) => `  · ${Talk.clock(item.at)} ${escaped(clip(item.text, quote + 80))}`),
        ]),
  ]
  return CUT.test(main.join("\n")) ? [...main, CUT_NOTE] : main
}

/** A quoted text, a note or a list that ends in `…`: something was cut (`clip`, `quoted`, `Fold.excerpt`). */
const CUT = /…("|$| · |\))/m

/**
 * `할 일: a · b · 외 3개: team_status로 모두 보세요`: the items in order within {@link TODO_TOKENS}, the rest counted
 * (the short pass of the main's update).
 */
function todoLine(todo: ReadonlyArray<string>) {
  const count = todo.findIndex((_, index) => tokens(`${TODO}${todo.slice(0, index + 1).join(" · ")}`) > TODO_TOKENS)
  if (count < 0) return `${TODO}${todo.join(" · ")}`
  return `${TODO}${[...todo.slice(0, count), `외 ${todo.length - count}개: team_status로 모두 보세요`].join(" · ")}`
}

/**
 * An owner's or a peer's view (06 §5.8): the other active areas, then its own asks, watches and the notes held for it.
 * No line starts with `- `, so `OwnTeamText.countOf` counts none of them.
 */
function viewerLines(facts: Facts, quote: number) {
  const viewer = facts.viewer
  if (!viewer) return []
  const others = facts.areas.filter((item) => item.area.id !== facts.view && item.area.state === "active")
  return [
    ...(others.length === 0 ? [] : ["다른 영역:", ...others.map((item) => otherLine(facts, item, quote))]),
    ...(viewer.asks.length === 0
      ? []
      : [
          `보낸 물음: ${viewer.asks.map((ask) => `${ask.to} ${quoted(ask.dispatch.text, 40)} · ${ask.state}`).join(" · ")}`,
        ]),
    ...(viewer.watches.length === 0
      ? []
      : [
          `지켜보는 영역: ${viewer.watches
            .map(
              (watch) =>
                `${watch.name} ${watch.on === "ready" ? "반영 준비" : "반영"}(${Talk.clock(watch.at + Talk.EXPIRE_MS)}까지)`,
            )
            .join(" · ")}`,
        ]),
    ...(viewer.held.length === 0
      ? []
      : [
          `받은 쪽지 ${viewer.held.length}개(다음 요청과 함께 감): ${viewer.held
            .map((note) => `${OwnTeamText.noteFrom(note)}(${Talk.clock(note.at)}) ${quoted(note.text, quote)}`)
            .join(" · ")}`,
        ]),
  ]
}

/**
 * `  · 세이브 v3(save-v3) · 작업 중 · 사용자와 직접 작업 중 · 줄기 save-v3 · 역할 "…" · 담당: "…" · 동료 리뷰어(reviewer)`:
 * another area.
 */
function otherLine(facts: Facts, item: AreaFacts, quote: number) {
  const area = item.area
  const latest = Fold.latest(item.fold)
  const talked = talkedOf(facts.team, area, item.decided)
  const report = latest && (item.sent === undefined || latest.at >= item.sent) ? latest : undefined
  const peers = (area.peers ?? []).map((peer) => `${peer.label}(${peer.key})`)
  const parts = [
    word(area, facts.now),
    ...(area.paused !== false ? ["메인 멈춤"] : []),
    ...(Direct.live(area) ? ["사용자와 직접 작업 중"] : []),
    ...(talked ? [`사용자가 직접 대화함(${Talk.clock(talked.at)})`] : []),
    `줄기 ${area.branch}`,
    ...(area.goal.trim() === "" ? [] : [`역할 ${quoted(area.goal, 60)}`]),
    ...(report ? [`담당: ${quoted(report.text, quote)}`] : []),
    ...(peers.length === 0 ? [] : [`동료 ${peers.join(", ")}`]),
  ]
  return `  · ${escaped(area.name)}(${area.id.slice("ar_".length)}) · ${parts.join(" · ")}`
}

/**
 * `  · 동료 리뷰어: 쉬는 중 · "…"` (동료, 06 §5.6): each peer under its area's line, without a leading `- ` so
 * `OwnTeamText.countOf` counts no area for it. Its state (작업 중, 막힘 for a `blocked` answer to its last request, else
 * 쉬는 중), its latest report after its last request, its notes, the user's direct talk there, and its waiting requests.
 */
function peerLines(item: AreaFacts, quote: number) {
  return item.peers.map((peer) => {
    const latest = Fold.latest(peer.fold)
    const direct = peer.peer.direct
    const talked = direct && (peer.decided === undefined || direct.at > peer.decided) ? direct : undefined
    const report =
      latest && (peer.sent === undefined || latest.at >= peer.sent)
        ? [`${latest.task ? `(${clip(latest.task, 40)}) ` : ""}${quoted(latest.text, quote)}`]
        : []
    return OwnTeamText.peerLine({
      label: peer.peer.label,
      parts: [
        peerWord(peer),
        ...report,
        ...peer.notes.map((note) => clip(note, quote)),
        ...(talked ? [`사용자가 직접 대화함(${Talk.clock(talked.at)})`] : []),
        ...(peer.waiting > 0 ? [`메인 요청 ${peer.waiting}개 기다림`] : []),
        ...(peer.messages > 0 ? [`영역 메시지 ${peer.messages}개 기다림`] : []),
      ],
    })
  })
}

/** 작업 중, 막힘 (its answer to its last request is `blocked`), or 쉬는 중. */
function peerWord(peer: PeerFacts) {
  if (peer.active) return OwnTeamText.PEER_WORDS.busy
  return Fold.settled(peer.fold) === "blocked" ? OwnTeamText.PEER_WORDS.blocked : OwnTeamText.PEER_WORDS.idle
}

export const CONFLICT = "반영 때 충돌 예상"

/**
 * `반영 때 충돌 예상: <A> ↔ <B>(<path> 외 n개) · …`: the pairs on one line, the first {@link LISTED} named. Without a
 * leading `- `, so `OwnTeamText.countOf` counts no area for it.
 */
function conflictLine(facts: Facts, quote: number) {
  if (facts.conflicts.length === 0) return []
  const listed = facts.conflicts.slice(0, LISTED).map((item) => {
    const first = item.paths[0]
    const more = item.paths.length > 1 ? ` 외 ${item.paths.length - 1}개` : ""
    const paths = first === undefined ? "" : `(${escaped(clip(first, quote))}${more})`
    return `${item.areas[0].name} ↔ ${item.areas[1].name}${paths}`
  })
  const more = facts.conflicts.length - listed.length
  return [`${CONFLICT}: ${listed.join(" · ")}${more > 0 ? ` 외 ${more}쌍` : ""}`]
}

/** `- <영역>: 반영 기다림 · …` for each integration that runs or waits (counted by `OwnTeamText.countOf`). */
function integrationLines(facts: Facts, areas: ReadonlyArray<AreaFacts>) {
  return areas.flatMap((item) => {
    const integration = item.integration
    if (!integration) return []
    const held = item.area.directWork
    // An integration made before the user started working with the area directly waits for the hand-back (2.1.8).
    const detail =
      integration.state === "waiting" && Direct.live(item.area) && held && integration.createdAt < held.since
        ? DIRECT_WAITS
        : integration.state === "waiting" && integration.waiting
          ? waitingDetail(facts.team, integration.waiting)
          : integration.checks
            ? `검사 ${integration.checks.current}/${integration.checks.total}`
            : undefined
    return [
      OwnTeamText.integrationLine({
        area: item.area.name,
        state: integration.state,
        ...(detail === undefined ? {} : { detail }),
      }),
    ]
  })
}

/** A waiting integration of an area held by direct work since before it was made. */
export const DIRECT_WAITS = "직접 작업 중이라 기다림"

/** Why an integration waits (7.2), for the main: the folder that holds the target and what it waits for. */
function waitingDetail(team: OwnTeam.Team, waiting: NonNullable<OwnTeam.Integration["waiting"]>) {
  const folder = Identity.same(team.home.directory, waiting.directory)
    ? "메인 폴더"
    : `${path.basename(waiting.directory)} 폴더`
  if (waiting.why === "dirty")
    return `${folder}의 저장 지점에 넣지 않은 파일 ${waiting.paths?.length ?? 0}개와 겹칩니다`
  if (waiting.why === "in-use") return `${folder}에서 하던 일이 끝나기를 기다립니다`
  if (waiting.why === "in-progress") return `${folder}에서 하던 기록 정리가 끝나기를 기다립니다`
  return `팀 밖의 ${folder}가 ${team.target}을 쓰고 있습니다`
}

/** How much of an area's role (`goal`) its line quotes (2026-10-26). */
export const ROLE_QUOTE = 80

/** The mark of an area the user set up (`Area.userMade`): its structure changes wait for the user (06 §2.9 V-b (5)). */
export const USER_MADE = "사용자가 정한 영역"

/**
 * `- <영역>: <상태> · 역할 "…" · 사용자가 정한 영역 · …`: the status word stays first after the name, so
 * `OwnTeamText.countOf` counts the area as before; the role and the mark follow it (2026-10-26). `focus`: the area
 * whose role is quoted whole. While direct work holds the area (2026-11-14), the line says so with the reports kept
 * for the hand-back, and leaves out the owner's report: it comes with the hand-back line.
 */
function areaLine(facts: Facts, item: AreaFacts, quote: number, focus?: OwnTeam.AreaID) {
  const area = item.area
  const latest = Fold.latest(item.fold)
  const talked = talkedOf(facts.team, area, item.decided)
  const live = Direct.live(area)
  // A report after the direct talk is its 담당 요약 (5.4) and is not repeated.
  const report =
    !live &&
    latest &&
    (item.sent === undefined || latest.at >= item.sent) &&
    !(talked && item.summary !== undefined && latest.at > talked.at)
      ? [
          `담당${latest.task ? `(${clip(latest.task, 40)})` : ""}: ${quoted(latest.text, quote)}` +
            (latest.kind === "ready" && item.ahead !== undefined
              ? ` (${facts.team.target}보다 커밋 ${item.ahead}개 앞섬)`
              : ""),
        ]
      : []
  const direct = talked
    ? [
        `사용자가 직접 대화함(${Talk.clock(talked.at)})` +
          (item.summary === undefined ? "" : ` · 담당 요약: ${quoted(item.summary, quote)}`),
      ]
    : []
  const waiting = item.waiting + item.queued
  const all = waiting + item.messages
  const held = item.held === undefined ? "" : `(${heldWords(item.held, facts.now)})`
  const pause =
    area.paused !== false
      ? [all > 0 ? `메인 멈춤 · 요청 ${all}개 기다림` : "메인 멈춤"]
      : [
          ...(waiting > 0 ? [`메인 요청 ${waiting}개 기다림${held}`] : []),
          ...(item.messages > 0 ? [`영역 메시지 ${item.messages}개 기다림`] : []),
        ]
  const role =
    area.goal.trim() === ""
      ? []
      : [`역할 ${quoted(area.goal, focus === area.id ? Number.POSITIVE_INFINITY : ROLE_QUOTE)}`]
  const parts = [
    word(area, facts.now),
    ...role,
    ...(area.userMade === undefined ? [] : [USER_MADE]),
    ...(live ? [directWords(area, item.fold)] : []),
    ...report,
    ...item.notes.map((note) => clip(note, quote)),
    ...direct,
    ...pause,
  ]
  return `- ${area.name}: ${parts.join(" · ")}`
}

/** `직접 작업 중(2026-11-14 13:02부터) · 모아 둔 보고 3개`: a held area's direct work and the reports kept for it. */
function directWords(area: OwnTeam.Area, fold: Fold.AreaFold) {
  const since = area.directWork?.since ?? 0
  const kept = fold.stretch?.since === since && fold.stretch.until === undefined ? fold.stretch.n : 0
  return `직접 작업 중(${Talk.clock(since)}부터)${kept > 0 ? ` · 모아 둔 보고 ${kept}개` : ""}`
}

/**
 * `새 대화로 이어가기 op_… 때문 · 17분째` or `다시 시도 1분 뒤 · 지난 실패: …` (RH-20): what holds an area's waiting
 * requests in `team_status`.
 */
function heldWords(held: NonNullable<AreaFacts["held"]>, now: number) {
  const cause = held.cause
  const since = OpWords.minutes(held.since, now)
  if (cause?.direct === true) return `사용자가 직접 작업 중이라 기다림 · ${since}`
  if (cause?.opID !== undefined && cause.kind !== undefined)
    return `${OpWords.of(cause.kind)} ${cause.opID} 때문 · ${since}`
  if (cause?.failure !== undefined) {
    const retry =
      cause.retryAt === undefined ? "" : `다시 시도 ${Math.max(1, Math.ceil((cause.retryAt - now) / 60_000))}분 뒤 · `
    return `${retry}지난 실패: ${clip(cause.failure, 80)} · ${since}`
  }
  return `${HELD[held.why]} · ${since}`
}

/** Why an outbox waits (5.1), in the main's words. */
const HELD: Readonly<Record<OwnTeam.WaitReason, string>> = {
  paused: "메인 멈춤",
  busy: "담당이 일하는 중",
  queued: "앞 요청이 아직 담당 대기열에 있음",
  maintaining: "팀 작업이 영역을 쓰는 중",
  broken: "영역이 멈춤",
}

function todoOf(item: AreaFacts) {
  const area = item.area
  // While the user works with the area directly nothing is the main's to do there: it comes with the hand-back.
  if (Direct.live(area)) return []
  // A peer that answered its last request `blocked` waits for the main's decision (동료).
  const peers = item.peers
    .filter((peer) => !peer.active && Fold.settled(peer.fold) === "blocked")
    .map((peer) => `${area.name} ${OwnTeamText.PEER} ${peer.peer.label}: 동료의 보고를 읽고 정하기`)
  // An integration that runs or waits is on its way (a waiting one is tried again when the main wakes, 7.2).
  if (area.status.kind === "ready" && area.candidate && !item.integration)
    return [`${area.name} 반영 가능 → team_integrate("${area.id.slice("ar_".length)}")`, ...peers]
  if (area.status.kind === "blocked") return [`${area.name}: 담당의 보고를 읽고 정하기`, ...peers]
  if (area.status.kind === "failed") return [`${area.name}: 실패 원인 확인`, ...peers]
  return peers
}

/** The status word of a broken area by its reason (06 §9.4); the others are `OwnTeamText.WORDS`. */
const BROKEN: Readonly<Record<OwnTeam.BrokenReason, string>> = {
  missing: "찾을 수 없음",
  identity: "멈춤(폴더 정보 불일치)",
  "branch-gone": "멈춤(기록이 지워짐)",
  "shared-branch": "멈춤(다른 영역과 같은 기록)",
}

function word(area: OwnTeam.Area, now: number) {
  const status = area.status
  if (status.kind === "broken") return area.broken ? BROKEN[area.broken.why] : OwnTeamText.WORDS.broken
  if (status.kind === "busy") {
    const minutes = Math.floor((now - status.at) / 60_000)
    return minutes >= 1 ? OwnTeamText.busyFor(minutes) : OwnTeamText.WORDS.busy
  }
  if (status.kind === "waiting-quota" && status.until !== undefined)
    return OwnTeamText.quotaUntil(Talk.clock(status.until))
  return OwnTeamText.WORDS[status.kind]
}

/** The order of an owner's team summary: what the main acts on first. */
const SUMMARY: ReadonlyArray<OwnTeam.StatusKind> = [
  "ready",
  "blocked",
  "failed",
  "asking",
  "waiting-quota",
  "busy",
  "preparing",
  "idle",
  "broken",
]

/** `반영 준비됨 1 · 작업 중 2` over the areas (an owner's team summary). */
function counts(areas: ReadonlyArray<AreaFacts>) {
  return SUMMARY.flatMap((kind) => {
    const count = areas.filter((item) => item.area.status.kind === kind).length
    return count === 0 ? [] : [` · ${OwnTeamText.WORDS[kind]} ${count}`]
  }).join("")
}

/** A quoted model or user text on one line. */
function quoted(text: string, max: number) {
  return `"${escaped(clip(text, max))}"`
}

/** `</team-update>` inside a text is escaped like the dispatch envelope (5.1). */
function escaped(text: string) {
  return text.replaceAll("</team-update>", "<\\/team-update>")
}

/** At most `max` code points (a relay keeps that many, `tools/report.ts`), so an emoji is never split. */
function clip(text: string, max: number) {
  const flat = Array.from(text.replace(/\s+/g, " ").trim())
  return flat.length <= max ? flat.join("") : `${flat.slice(0, max - 1).join("")}…`
}
