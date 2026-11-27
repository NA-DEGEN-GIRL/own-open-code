export * as Talk from "./talk.js"

import { Option, Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { OwnID, OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Dispatches } from "../registry/dispatch.js"
import { Keys } from "../registry/keys.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import { MsgID } from "./msg-id.js"

/**
 * Area-to-area talk (06 §5.8, 2026-10-16): what own.team keeps beside the outbox for `team_message`, all in KV
 * `talk:<teamID>` and written only in the team's write section, never in a core inbox (a parked item would make the
 * folder unsafe, `sessions/safe-point.ts`):
 * - the notes (쪽지) held for a receiving conversation until its next request goes (they follow its envelope);
 * - the one-shot watches (지켜보기): a notice to the watcher when an area reports ready or is integrated, 12 hours;
 * - the asks still open (G2), and in which conversation each was delivered, so the run that took it settles it;
 * - when the hourly ask limit (G3) last woke the main;
 * - the audit lines of area messages for the main's next team update (`영역 메시지 n건:`), kept apart from the digest
 *   entries so chatter never pushes out an entry that wakes the main, and marked told when an update carrying them went.
 *
 * Asks and replies themselves are outbox records (`from: "area"`, `dispatch/dispatch.ts`); notices to an asker or a
 * watcher are program records (`from: "team"`, `kind: "notice"`). Both go by the outbox rule (one at a time per folder,
 * only when it is idle) and never create, attach or rotate a conversation.
 */

/** G3: asks per rolling hour from one asking conversation (replies are bounded by asks, G1). */
export const ASKS_PER_HOUR = 10
/** G3: asks per rolling hour for the whole team (2026-11-14). */
export const ASKS_PER_HOUR_TEAM = 40
/** An open ask stops counting for G2, and a watch ends, after this (borrowed from Claude Code's notify_when_idle). */
export const EXPIRE_MS = 12 * 60 * 60 * 1000
/** Longest note (쪽지); an ask or a reply may hold 20,000 characters. */
export const NOTE_MAX = 1_000
/** Notes kept per receiving conversation (the newest). */
export const NOTES_PER_TARGET = 5
/** Audit lines kept for the main (the newest). */
export const LINES_MAX = 20
/** Longest reply taken from the last answer of a run that did not reply; a longer one ends in {@link cutReply}'s marker. */
export const REPLY_MAX = 20_000

/**
 * Why a guard held an area message back: G1 (a second reply), G2 (an open ask to the same pair), G3 (`limit`: the
 * asking conversation's hourly limit; `team-limit`: the team's).
 */
export type Guard = "answered" | "open" | "limit" | "team-limit"

const At = OwnID.EpochMillis

/** One end of an area message: an area's owner, or one of its peers. */
const Slot = Schema.Struct({ areaID: OwnTeam.AreaID, peer: optional(OwnTeam.Slug) })
export type Slot = typeof Slot.Type

export const Watch = Schema.Struct({
  watcher: OwnTeam.Sender,
  areaID: OwnTeam.AreaID,
  on: Schema.Literals(["ready", "integrated"]),
  text: Schema.String,
  at: At,
})
export type Watch = typeof Watch.Type

/** An ask not settled yet (G2): no reply, not cancelled, and the run that took it has not ended. */
export const Open = Schema.Struct({
  id: OwnTeam.DispatchID,
  at: At,
  from: Slot,
  to: Slot,
  /** The receiving conversation it was delivered in (`session.inbox.delivered`); its next run end settles it. */
  delivered: optional(Schema.String),
})
export type Open = typeof Open.Type

export const Line = Schema.Struct({ n: NonNegativeInt, at: At, text: Schema.String })
export type Line = typeof Line.Type

export const State = Schema.Struct({
  notes: Schema.Array(OwnTeam.AreaNote),
  watches: Schema.Array(Watch),
  open: Schema.Array(Open),
  /** When the hourly limit last woke the main (at most once an hour). */
  limited: optional(At),
  lines: Schema.Array(Line),
  /** The next line number. */
  next: NonNegativeInt,
  /** The last line a sent team update carried (-1: none). */
  told: Schema.Int,
})
export type State = typeof State.Type

export function empty(): State {
  return { notes: [], watches: [], open: [], lines: [], next: 0, told: -1 }
}

const decode = Schema.decodeUnknownOption(State)
const encode = Schema.encodeSync(State)

export async function load(kv: Keys.Store, teamID: string): Promise<State> {
  return Option.getOrElse(decode(await kv.get(Keys.talk(teamID))), empty)
}

/** Inside the team's write section. */
export function save(kv: Keys.Store, teamID: string, state: State) {
  return kv.set(Keys.talk(teamID), Keys.toJson(encode(state)))
}

// ---------------------------------------------------------------------------------------------------------------
// Pure parts

/** The slot an area message comes from. */
export function from(sender: OwnTeam.Sender): Slot {
  return { areaID: sender.areaID, ...(sender.peer ? { peer: sender.peer.key } : {}) }
}

export function same(a: Slot, b: Slot) {
  return a.areaID === b.areaID && a.peer === b.peer
}

/** The message a guard looks at. */
export interface Message {
  readonly kind: "ask" | "reply"
  readonly areaID: OwnTeam.AreaID
  readonly to?: string
  readonly sender: OwnTeam.Sender
  readonly replyTo?: OwnTeam.DispatchID
}

/**
 * The loop guards (06 §5.8), checked in the write section that records the message, so parallel calls of one Code Mode
 * run cannot both pass: `limit` (G3: {@link ASKS_PER_HOUR} asks from the asking conversation in the rolling hour,
 * whatever became of them), `team-limit` (G3: {@link ASKS_PER_HOUR_TEAM} asks of the whole team), `answered` (G1: a
 * reply to an ask that has one) and `open` (G2: an ask while the same pair has one open).
 */
export function guard(input: {
  readonly dispatches: ReadonlyArray<OwnTeam.Dispatch>
  readonly state: State
  readonly message: Message
  readonly now: number
}): Guard | undefined {
  const message = input.message
  if (message.kind === "reply")
    return input.dispatches.some((item) => item.replyTo === message.replyTo && item.state !== "cancelled")
      ? "answered"
      : undefined
  const asks = input.dispatches.filter(
    (item) => item.from === "area" && item.kind === "ask" && input.now - item.createdAt < Fold.HOUR_MS,
  )
  const sender = from(message.sender)
  if (asks.filter((item) => item.sender !== undefined && same(from(item.sender), sender)).length >= ASKS_PER_HOUR)
    return "limit"
  if (asks.length >= ASKS_PER_HOUR_TEAM) return "team-limit"
  const to: Slot = { areaID: message.areaID, ...(message.to === undefined ? {} : { peer: message.to }) }
  const pair = open(input.state, input.now).some((item) => same(item.from, sender) && same(item.to, to))
  return pair ? "open" : undefined
}

/** The open asks that still count (under {@link EXPIRE_MS}). */
export function open(state: State, now: number) {
  return state.open.filter((item) => now - item.at < EXPIRE_MS)
}

/** Whether `slot` has an ask out that still counts (its run end is no `끝났지만 보고 없음`: it waits for an answer). */
export function asking(state: State, slot: Slot, now: number) {
  return open(state, now).some((item) => same(item.from, slot))
}

/**
 * A recorded area message: an ask is open from now on, a reply settles its ask, and the main gets an audit line.
 */
export function recorded(state: State, input: { readonly dispatch: OwnTeam.Dispatch; readonly line: string }): State {
  const dispatch = input.dispatch
  const sender = dispatch.sender
  const opened =
    dispatch.kind === "ask" && sender
      ? [
          ...state.open,
          {
            id: dispatch.id,
            at: dispatch.createdAt,
            from: from(sender),
            to: { areaID: dispatch.areaID, ...(dispatch.to === undefined ? {} : { peer: dispatch.to }) },
          },
        ]
      : state.open.filter((item) => item.id !== dispatch.replyTo)
  return line({ ...state, open: opened }, { at: dispatch.createdAt, text: input.line })
}

/** Appends an audit line for the main (the newest {@link LINES_MAX} stay). */
export function line(state: State, input: { readonly at: number; readonly text: string }): State {
  const added: Line = { n: state.next, at: input.at, text: input.text }
  return { ...state, next: state.next + 1, lines: [...state.lines, added].slice(-LINES_MAX) }
}

/** The audit lines no sent team update carried yet (up to `upTo`), oldest first. */
export function untold(state: State, upTo = Number.POSITIVE_INFINITY) {
  return state.lines.filter((item) => item.n > state.told && item.n <= upTo)
}

/** The newest line number (what an update made now carries). */
export function last(state: State) {
  return state.lines.reduce((max, item) => Math.max(max, item.n), -1)
}

/** Lines up to `upTo` went with a team update. */
export function told(state: State, upTo: number): State {
  return upTo <= state.told ? state : { ...state, told: upTo }
}

/**
 * The notes held for one receiving conversation (an area's owner, or its peer `to`), oldest first: under 7 days old
 * (the outbox's keep time) and for an area that is still active, at most {@link NOTES_PER_TARGET}.
 */
export function held(
  state: State,
  input: {
    readonly areaID: OwnTeam.AreaID
    readonly to?: string
    readonly now: number
    readonly active: ReadonlySet<string>
  },
) {
  if (!input.active.has(input.areaID)) return []
  return state.notes
    .filter((note) => note.areaID === input.areaID && note.to === input.to && input.now - note.at < Dispatches.KEEP_MS)
    .slice(-NOTES_PER_TARGET)
}

/**
 * Without what lapsed: notes over 7 days or for inactive areas, watches over 12 hours or of inactive areas, asks over
 * 12 hours. Notes that lapsed by age undelivered get one audit line for the main (2026-11-14).
 */
export function prune(state: State, input: { readonly now: number; readonly active: ReadonlySet<string> }): State {
  const aged = state.notes.filter((note) => input.now - note.at >= Dispatches.KEEP_MS).length
  const pruned: State = {
    ...state,
    notes: state.notes.filter((note) => input.active.has(note.areaID) && input.now - note.at < Dispatches.KEEP_MS),
    watches: state.watches.filter(
      (watch) =>
        input.active.has(watch.areaID) && input.active.has(watch.watcher.areaID) && input.now - watch.at < EXPIRE_MS,
    ),
    open: open(state, input.now),
  }
  if (aged === 0) return pruned
  return line(pruned, { at: input.now, text: `전하지 못한 채 7일이 지난 쪽지 ${aged}개를 지웠습니다` })
}

/** A reply taken from a run's last answer, at most {@link REPLY_MAX} characters with a marker when cut. */
export function cutReply(text: string) {
  if (text.length <= REPLY_MAX) return text
  return `${text.slice(0, REPLY_MAX)}
(이후 생략: 전체 ${text.length.toLocaleString("en-US")}자 중 앞부분입니다. 나머지가 필요하면 다시 물으세요)`
}

/**
 * A receiver's log, in order (its write section): an ask delivered in `sessionID` is marked, and the next run end there
 * (succeeded, interrupted, or failed without a limit block, which goes on after the reset) settles every ask it took.
 */
export function follow(
  state: State,
  input: {
    readonly sessionID: string
    readonly events: ReadonlyArray<Fold.Observed>
    /** A failed run was a limit block. */
    readonly blocked: boolean
  },
): { readonly state: State; readonly ended: ReadonlyArray<Ended> } {
  return input.events.reduce<{ state: State; ended: ReadonlyArray<Ended> }>(
    (acc, event) => {
      if (event.type === "session.inbox.delivered") {
        const marked = acc.state.open.map((item) =>
          MsgID.dispatch(item.id, input.sessionID) === event.data.inboxID
            ? { ...item, delivered: input.sessionID }
            : item,
        )
        return marked.some((item, index) => item !== acc.state.open[index])
          ? { ...acc, state: { ...acc.state, open: marked } }
          : acc
      }
      const how: Ended["how"] | undefined =
        event.type === "session.execution.succeeded"
          ? "succeeded"
          : event.type === "session.execution.interrupted"
            ? "interrupted"
            : event.type === "session.execution.failed" && !input.blocked
              ? "failed"
              : undefined
      if (how === undefined) return acc
      const took = acc.state.open.filter((item) => item.delivered === input.sessionID)
      if (took.length === 0) return acc
      return {
        state: { ...acc.state, open: acc.state.open.filter((item) => item.delivered !== input.sessionID) },
        ended: [...acc.ended, ...took.map((item) => ({ id: item.id, how }))],
      }
    },
    { state, ended: [] },
  )
}

/** An ask whose receiving run ended, and how it ended. */
export interface Ended {
  readonly id: OwnTeam.DispatchID
  readonly how: "succeeded" | "interrupted" | "failed"
}

/** `인벤토리 화면 담당`, `인벤토리 화면 동료 리뷰어`: the receiving conversation as tool results and notices name it. */
export function who(area: Pick<OwnTeam.Area, "name" | "peers">, peer?: string) {
  if (peer === undefined) return `${area.name} 담당`
  const label = (area.peers ?? []).find((item) => item.key === peer)?.label ?? peer
  return `${area.name} ${OwnTeamText.PEER} ${label}`
}

/** The sender of an area's owner or one of its peers, with the names they have now. */
export function senderOf(area: Pick<OwnTeam.Area, "id" | "name" | "peers">, peer?: string): OwnTeam.Sender {
  const found = peer === undefined ? undefined : (area.peers ?? []).find((item) => item.key === peer)
  return { areaID: area.id, area: area.name, ...(found ? { peer: { key: found.key, label: found.label } } : {}) }
}

/** `'인벤토리 화면' → '세이브 v3 담당' 물음: "…"`: an audit line of an area message for the main. */
export function auditLine(input: {
  readonly sender: OwnTeam.Sender
  readonly to: string
  readonly what: string
  readonly text: string
}) {
  return `'${OwnTeamText.senderName(input.sender)}' → '${input.to}' ${input.what}: "${clip(input.text, 300)}"`
}

/**
 * `2026-10-25 14:05` in the service's local time: every time own.team writes for a model (the team updates, the status,
 * notes, a watch's expiry). With its date, so a held update's `까지`, a limit's `풀림` or an answer's time never reads as
 * today when it is tomorrow, and an older update still says when (LV 2026-10-25).
 */
export function clock(at: number) {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A text on one line, at most `max` characters. */
export function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// ---------------------------------------------------------------------------------------------------------------
// Writes

/** The ids of the team's active areas. */
async function active(services: Services.Context, teamID: OwnTeam.TeamID): Promise<ReadonlySet<string>> {
  return new Set(
    (await services.registry.areas.list(teamID)).filter((area) => area.state === "active").map((area) => area.id),
  )
}

/**
 * `team_message{kind:"note"}`: a note for a receiving conversation. An identical note there already is kept once
 * (`added: false`); otherwise the newest {@link NOTES_PER_TARGET} for that conversation stay (`pushed`: the oldest
 * went for it), and the main gets an audit line.
 */
export async function note(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly to?: string
    readonly sender: OwnTeam.Sender
    readonly text: string
    /** The receiver as the audit line names it. */
    readonly who: string
  },
): Promise<{ readonly id: OwnTeam.AreaNoteID; readonly added: boolean; readonly pushed: boolean }> {
  return services.write(input.teamID, async () => {
    const now = services.clock.now()
    const state = prune(await load(services.kv, input.teamID), { now, active: await active(services, input.teamID) })
    const existing = state.notes.find(
      (item) =>
        item.areaID === input.areaID &&
        item.to === input.to &&
        item.text === input.text &&
        same(from(item.sender), from(input.sender)),
    )
    if (existing) {
      await save(services.kv, input.teamID, state)
      return { id: existing.id, added: false, pushed: false }
    }
    const added: OwnTeam.AreaNote = {
      id: OwnTeam.AreaNoteID.create(),
      areaID: input.areaID,
      ...(input.to === undefined ? {} : { to: input.to }),
      sender: input.sender,
      text: input.text,
      at: now,
    }
    const target = (item: OwnTeam.AreaNote) => item.areaID === input.areaID && item.to === input.to
    const before = state.notes.filter(target)
    const mine = [...before, added].slice(-NOTES_PER_TARGET)
    const notes = [...state.notes.filter((item) => !target(item)), ...mine].toSorted((a, b) => a.at - b.at)
    const text = auditLine({ sender: input.sender, to: input.who, what: "쪽지", text: input.text })
    await save(services.kv, input.teamID, line({ ...state, notes }, { at: now, text }))
    return { id: added.id, added: true, pushed: before.length >= NOTES_PER_TARGET }
  })
}

/** `team_message{kind:"watch"}`: one watch per watcher, area and event (a new one replaces it), with an audit line. */
export async function watch(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly watcher: OwnTeam.Sender
    readonly area: Pick<OwnTeam.Area, "id" | "name">
    readonly on: Watch["on"]
    readonly text: string
  },
) {
  await services.write(input.teamID, async () => {
    const now = services.clock.now()
    const state = prune(await load(services.kv, input.teamID), { now, active: await active(services, input.teamID) })
    const kept = state.watches.filter(
      (item) =>
        !(same(from(item.watcher), from(input.watcher)) && item.areaID === input.area.id && item.on === input.on),
    )
    const added: Watch = { watcher: input.watcher, areaID: input.area.id, on: input.on, text: input.text, at: now }
    const what = input.on === "ready" ? "지켜보기(반영 준비)" : "지켜보기(반영)"
    const text = auditLine({ sender: input.watcher, to: input.area.name, what, text: input.text })
    await save(services.kv, input.teamID, line({ ...state, watches: [...kept, added] }, { at: now, text }))
  })
}

/**
 * The area reported ready (or an owner's `team_integrate` recorded its candidate), or an integration of it ended done:
 * the watches on it for that event go, and each watcher gets one notice by the outbox rule. Never throws.
 */
export async function fire(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly on: Watch["on"] },
) {
  const now = services.clock.now()
  const taken = await services.write(input.teamID, async () => {
    const state = await load(services.kv, input.teamID)
    const due = state.watches.filter(
      (item) => item.areaID === input.areaID && item.on === input.on && now - item.at < EXPIRE_MS,
    )
    if (due.length === 0) return []
    await save(services.kv, input.teamID, { ...state, watches: state.watches.filter((item) => !due.includes(item)) })
    return due
  })
  if (taken.length === 0) return
  const area = await services.registry.areas.get(input.teamID, input.areaID)
  const name = area?.name ?? input.areaID
  const event =
    input.on === "ready" ? `반영 준비를 마쳤습니다(${clock(now)})` : `프로젝트 본 코드에 반영되었습니다(${clock(now)})`
  await Promise.all(
    taken.map((item) =>
      notice(services, {
        teamID: input.teamID,
        to: from(item.watcher),
        text: `${name} 영역이 ${event}. 지켜보며 남긴 글: "${clip(item.text, 300)}"`,
      }),
    ),
  )
}

/**
 * Asks that were cancelled before an answer (the user's 지우기, a refused send, 끝내기, 묶기, 빼기, a removed peer, 끄기):
 * they stop counting for G2, and each asker of a team that is on gets one notice, so it never waits for nothing. The
 * notices go by the outbox rule; they are not awaited, so a caller that holds an area's step never waits for another's.
 */
export async function cancelled(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
  dispatches: ReadonlyArray<OwnTeam.Dispatch>,
) {
  const asks = dispatches.filter((item) => item.from === "area" && item.kind === "ask" && item.sender)
  if (asks.length === 0) return
  const ids = new Set<string>(asks.map((item) => item.id))
  await services.write(teamID, async () => {
    const state = await load(services.kv, teamID)
    if (!state.open.some((item) => ids.has(item.id))) return
    await save(services.kv, teamID, { ...state, open: state.open.filter((item) => !ids.has(item.id)) })
  })
  const team = await services.registry.teams.get(teamID)
  if (team?.state !== "on") return
  for (const ask of asks) {
    const sender = ask.sender
    if (!sender) continue
    void (async () => {
      const area = await services.registry.areas.get(teamID, ask.areaID)
      const to = area ? who(area, ask.to) : ask.areaID
      await notice(services, {
        teamID,
        to: from(sender),
        text: `${to}에게 보낸 물음이 전해지지 않고 지워졌습니다: "${clip(ask.text, 200)}". 다시 묻거나 team_report(kind:"blocked")로 메인에게 알리세요.`,
      })
    })().catch((error: unknown) => services.log.warn("talk_cancel_notice_failed", { dispatchID: ask.id, error }))
  }
}

/**
 * The asks a receiver's run took and ended (`follow`, after the write section). An ask with a reply needs nothing. A
 * run that succeeded without `team_message{kind:"reply"}` answers with its last answer (what the model most often does
 * is answer in its final message); an interrupted or failed run, or one without an answer, sends the asker a notice.
 */
export async function settle(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly sessionID: string
    readonly directory: string
    readonly ended: ReadonlyArray<Ended>
  },
) {
  for (const item of input.ended) {
    const dispatches = await services.registry.dispatches.list(input.teamID)
    const ask = dispatches.find((dispatch) => dispatch.id === item.id)
    const sender = ask?.sender
    if (!ask || !sender || ask.state === "cancelled") continue
    if (dispatches.some((dispatch) => dispatch.replyTo === ask.id && dispatch.state !== "cancelled")) continue
    const area = await services.registry.areas.get(input.teamID, ask.areaID)
    if (!area) continue
    const receiver = who(area, ask.to)
    const answer =
      item.how === "succeeded"
        ? await lastAnswer(services, { sessionID: input.sessionID, directory: input.directory, askID: ask.id })
        : undefined
    if (answer !== undefined) {
      const replied = await services.features().admit.message({
        teamID: input.teamID,
        areaID: sender.areaID,
        ...(sender.peer ? { to: sender.peer.key } : {}),
        kind: "reply",
        sender: senderOf(area, ask.to),
        replyTo: ask.id,
        text: cutReply(answer),
        last: true,
      })
      if (replied.ok) continue
      services.log.warn("talk_reply_failed", { dispatchID: ask.id, message: replied.message })
      continue
    }
    await notice(services, {
      teamID: input.teamID,
      to: from(sender),
      text: `${receiver}: 물음에 답하지 않고 차례를 마쳤습니다: "${clip(ask.text, 200)}". 다시 묻거나(team_message) 메인에게 알리세요(team_report kind:"blocked").`,
    })
    await log(
      services,
      input.teamID,
      `'${receiver}': '${OwnTeamText.senderName(sender)}'의 물음에 답하지 않고 차례를 마침`,
    )
  }
}

/** One audit line for the main, in its own write section. */
export async function log(services: Services.Context, teamID: OwnTeam.TeamID, text: string) {
  await services.write(teamID, async () => {
    await save(services.kv, teamID, line(await load(services.kv, teamID), { at: services.clock.now(), text }))
  })
}

/** Whether the hourly limit may wake the main now (once an hour); marks it when it may. */
export async function limited(services: Services.Context, teamID: OwnTeam.TeamID) {
  return services.write(teamID, async () => {
    const state = await load(services.kv, teamID)
    const now = services.clock.now()
    if (state.limited !== undefined && now - state.limited < Fold.HOUR_MS) return false
    await save(services.kv, teamID, { ...state, limited: now })
    return true
  })
}

/** A program notice (`from: "team"`, `kind: "notice"`) to an area's owner or peer by the outbox rule; never throws. */
async function notice(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly to: Slot; readonly text: string },
) {
  const sent = await services
    .features()
    .admit.dispatch({
      teamID: input.teamID,
      areaID: input.to.areaID,
      ...(input.to.peer === undefined ? {} : { to: input.to.peer }),
      from: "team",
      kind: "notice",
      text: input.text,
    })
    .catch((error: unknown) => Services.failure("internal_error", String(error), {}))
  if (!sent.ok) services.log.warn("talk_notice_failed", { areaID: input.to.areaID, message: sent.message })
}

const Assistant = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  content: optional(Schema.Array(Schema.Struct({ type: Schema.String, text: optional(Schema.String) }))),
})
const decodeMessage = Schema.decodeUnknownOption(Assistant)

/**
 * The newest answer text of the receiving conversation after the ask's message (read only): what the run that took
 * the ask said last. `undefined` when it said nothing after it.
 */
async function lastAnswer(
  services: Services.Context,
  input: { readonly sessionID: string; readonly directory: string; readonly askID: string },
) {
  const messages = await services.http.session.messages({
    sessionID: input.sessionID,
    directory: input.directory,
    limit: 20,
    order: "desc",
  })
  if (!messages.ok) return undefined
  const asked = MsgID.dispatch(input.askID, input.sessionID)
  const newer = messages.value.data.flatMap((message) => Option.toArray(decodeMessage(message)))
  const before = newer.findIndex((message) => message.id === asked)
  const texts = (before < 0 ? newer : newer.slice(0, before)).flatMap((message) => {
    if (message.type !== "assistant") return []
    const text = (message.content ?? [])
      .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
      .join("")
      .trim()
    return text === "" ? [] : [text]
  })
  return texts[0]
}
