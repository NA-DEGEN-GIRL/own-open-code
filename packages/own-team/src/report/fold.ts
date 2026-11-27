export * as Fold from "./fold.js"

import { Option, Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { OwnID, OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"

/**
 * The pure part of reports and waking the main (06 §5.5–5.7): the wake table of §5.6, the digest kept in KV
 * `digest:<teamID>`, what an owner's session log means for its area, `끝났지만 보고 없음`, `모두 끝남`, and when the
 * next team update may go (30 s debounce, at most one undelivered in the main inbox, at most 12 an hour).
 * `events.ts` reads and writes around it, `digest.ts` words it and `wake.ts` sends it.
 */

// ---------------------------------------------------------------------------------------------------------------
// The wake table (06 §5.6)

/** Whether an event wakes the main (06 §5.6). Every other event only folds into the next team update. */
export const WAKES = {
  /** 담당 턴 성공. */
  succeeded: false,
  progress: false,
  /** A `done` while other requests are still open; the last one is `all-done`. */
  done: false,
  /** 사용자 직접 대화 (5.4). */
  direct: false,
  /** 메인 멈춤 켜기 / 끄기 (5.3). */
  paused: false,
  resumed: false,
  /**
   * 재구성·합치기 완료. A done integration wakes after all while another area's candidate waits, or when the main started
   * it (controller.ts `advanced`).
   */
  reorganized: false,
  integrated: false,
  /** The first integration conflict: the owner gets a `from="team"` request instead (7.3). */
  conflict: false,
  /** A permission or question waits, or the account's limit blocks: own-web tells the user. */
  asking: false,
  quota: false,
  /** 끝났지만 보고 없음 (5.5). */
  unreported: false,
  /** 모두 끝남: see {@link allDone}. */
  "all-done": true,
  ready: true,
  blocked: true,
  /**
   * 사용자 부탁 (5.5, 2026-10-16): an owner or a peer passed on what the user asked in its conversation that only the
   * main can do. It writes no report, so the area's status and the open request's answer stay as they are.
   */
  relay: true,
  /** `session.execution.failed` of an owner or a peer (not a limit block). */
  failed: true,
  /** A main request to a peer was not sent: its conversation is on another subscription of the team main's company. */
  refused: true,
  /** Integration failed: verification failed or a second conflict (7.3). */
  "integration-failed": true,
  /**
   * The team's hourly limit of asks between areas was hit (G3, 06 §5.8): the main decides (once an hour). Area
   * messages themselves never wake it; their audit lines go with its next update (`dispatch/talk.ts`).
   */
  "area-limit": true,
  /**
   * RH-20: a main request could not go and waits (a step of its preparation failed: the new conversation a `fresh`
   * request asked for, the owner, the attach), or that new conversation failed; it is tried again.
   */
  "request-failed": true,
  /** RH-20: a `fresh` request went to the current owner as a plain request (a command held the folder, a cancel). */
  "request-plain": false,
  /** 담당 대화 바꾸기 (`sessions/seat.ts`): the area's seat moved onto another conversation; requests go as before. */
  seated: false,
  /**
   * 직접 작업 (2026-11-14): the user handed a held area back (메인에게 넘기기, the owner's `team_area resume`, Main 멈춤
   * off, the hold switched off). The entry carries the stretch's summary and where its whole reports are.
   */
  handed: true,
  /** The main took a held area back (its `team_area resume` in a run the user opened): the main is awake already. */
  taken: false,
  /** An area's role changed by the user's word (`area.edit` from the screen or the owner's `team_area role`). */
  role: false,
} as const satisfies Readonly<Record<string, boolean>>

export type Reason = keyof typeof WAKES

/** A digest entry whose `wake` comes from the table, unless `wake` says otherwise. */
export function entry(input: {
  readonly at: number
  readonly reason: Reason
  readonly text: string
  readonly areaID?: OwnTeam.AreaID
  /** The area peer it is about. */
  readonly peer?: string
  /**
   * Overrides {@link WAKES} (2026-11-14): a `ready`, `blocked` or `failed` of an area the user works with directly
   * is stored without waking the main (`false`); it goes along with the hand-back.
   */
  readonly wake?: boolean
}): Services.DigestEntry {
  return {
    at: input.at,
    reason: input.reason,
    text: input.text,
    wake: input.wake ?? WAKES[input.reason],
    ...(input.areaID === undefined ? {} : { areaID: input.areaID }),
    ...(input.peer === undefined ? {} : { peer: input.peer }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Timing (06 §5.6 묶기)

export const DEBOUNCE_MS = 30_000
export const HOUR_MS = 3_600_000
/** Team updates per hour; past it updates wait for the window and the user is told. */
export const PER_HOUR = 12
/** How often an update still in the main inbox is looked at again (its `delivered` event is the usual signal). */
export const CHECK_MS = 300_000
/** A send or an inbox read that failed is tried again after this. */
export const RETRY_MS = 60_000

// ---------------------------------------------------------------------------------------------------------------
// The digest record (KV `digest:<teamID>`)

const At = OwnID.EpochMillis

export const ReportKind = Schema.Literals(["progress", "done", "ready", "blocked"])
export type ReportKind = typeof ReportKind.Type

export const Report = Schema.Struct({ text: Schema.String, task: optional(Schema.String), at: At })
export type Report = typeof Report.Type

/** Code points of a report, relay or candidate text the digest keeps (its whole text is in `report/texts.ts`). */
export const EXCERPT = 1_000

/**
 * The first `max` code points of `text`, ending in `…` when it was cut (2026-11-14): never a split surrogate pair,
 * and a reader always sees that more exists (the whole is in `team_status{area}`).
 */
export function excerpt(text: string, max = EXCERPT) {
  const points = Array.from(text)
  return points.length <= max ? text : `${points.slice(0, max).join("")}…`
}

/** Code points of the newest report a stretch summary quotes ({@link StretchSummary.last}). */
export const STRETCH_LAST = 160

/**
 * What the digest keeps of an area's direct work (2026-11-14): the reports stored while it was held, as a count, a
 * count per kind and the newest one's excerpt on one line. The whole reports are in KV `stretch:<team>:<area>`
 * (`report/texts.ts`). `until`: when the stretch ended; it stays until the next one starts.
 */
export const StretchSummary = Schema.Struct({
  since: At,
  until: optional(At),
  n: NonNegativeInt,
  /** By report kind (`ready`, `progress`, `failed`, …): an open string, like `Entry.reason`. */
  kinds: Schema.Record(Schema.String, NonNegativeInt),
  last: optional(Schema.String),
})
export type StretchSummary = typeof StretchSummary.Type

/**
 * One folded event not yet told to the main. `n` orders the entries and names those a sent update carried; `key`
 * (`<sessionID>:<seq>`) makes a log event folded twice (a crash between the digest and the cursor write) count once.
 */
export const Entry = Schema.Struct({
  n: NonNegativeInt,
  at: At,
  areaID: optional(OwnTeam.AreaID),
  reason: Schema.String,
  text: Schema.String,
  wake: Schema.Boolean,
  key: optional(Schema.String),
  /** The area peer it is about (동료): its note goes under the peer's line, not the area's. */
  peer: optional(Schema.String),
})
export type Entry = typeof Entry.Type

const Reports = Schema.Struct({
  progress: optional(Report),
  done: optional(Report),
  ready: optional(Report),
  blocked: optional(Report),
})
const Received = Schema.Struct({ dispatchID: OwnTeam.DispatchID, at: At })

/**
 * What an area peer's reports and log say about the main requests sent to it (동료, 2026-10-09). A peer reports
 * `progress`, `done` and `blocked` only; its log is folded after its own cursor like the owner's.
 */
export const PeerFold = Schema.Struct({
  reports: Reports,
  /** Main requests admitted to the peer's inbox and not yet delivered or cancelled, by inbox id. */
  queued: optional(Schema.Record(Schema.String, OwnTeam.DispatchID)),
  received: optional(Received),
  unreported: optional(OwnTeam.DispatchID),
})
export type PeerFold = typeof PeerFold.Type

/** What the reports and the owner's log say about one area's main requests. */
export const AreaFold = Schema.Struct({
  /** The latest report of each kind. */
  reports: Reports,
  /** Main requests admitted to the owner's inbox and not yet delivered or cancelled, by inbox id. */
  queued: Schema.Record(Schema.String, OwnTeam.DispatchID),
  /** The last main request the owner received (`session.inbox.delivered`). */
  received: optional(Received),
  /** The request `끝났지만 보고 없음` was folded for (once per request). */
  unreported: optional(OwnTeam.DispatchID),
  /** The area's peers by key (absent in digests written before peers). */
  peers: optional(Schema.Record(Schema.String, PeerFold)),
  /**
   * The request whose owner run ended (succeeded, interrupted while not asking, or failed but not by a limit;
   * 2026-11-14), so the owner no longer serves it (`Direct.serving`).
   */
  ended: optional(OwnTeam.DispatchID),
  /** The area's current or last direct work (2026-11-14), see {@link StretchSummary}. */
  stretch: optional(StretchSummary),
})
export type AreaFold = typeof AreaFold.Type

/** The answer side shared by an owner's and a peer's fold. */
export type Answers = AreaFold | PeerFold

/** The team update sent to the main and not yet delivered (06 §5.6: at most one in the main inbox). */
export const Pending = Schema.Struct({
  seq: NonNegativeInt,
  msgID: Schema.String,
  sessionID: SessionID,
  at: At,
  /** The service admitted it. Until then a retry uses the same id, and core keeps the first admission. */
  sent: Schema.Boolean,
  /** The last entry `n` it carried. */
  upTo: Schema.Int,
  /** When it was last seen still undelivered. */
  checked: optional(At),
})
export type Pending = typeof Pending.Type

export const State = Schema.Struct({
  teamID: OwnTeam.TeamID,
  /** The last team update number (`seq` of `<team-update>` and of its message id). */
  seq: NonNegativeInt,
  /** The next entry `n`. */
  next: NonNegativeInt,
  entries: Schema.Array(Entry),
  areas: Schema.Record(Schema.String, AreaFold),
  pending: Schema.NullOr(Pending),
  /** When updates were sent within the last hour. */
  sent: Schema.Array(At),
  /** Updates are held past the hourly limit until `until` (the user was told once). */
  limited: Schema.NullOr(Schema.Struct({ until: At })),
  /** The last `모두 끝남`; work counts again from requests sent after it. */
  allDone: optional(At),
})
export type State = typeof State.Type

/** Entries kept; the oldest go first (an update words areas from their state, entries only add notes). */
export const MAX_ENTRIES = 200

export function empty(teamID: OwnTeam.TeamID): State {
  return { teamID, seq: 0, next: 0, entries: [], areas: {}, pending: null, sent: [], limited: null }
}

export function append(state: State, entry: Services.DigestEntry, key?: string): State {
  if (key !== undefined && state.entries.some((item) => item.key === key)) return state
  const added: Entry = { ...entry, n: state.next, ...(key === undefined ? {} : { key }) }
  return { ...state, next: state.next + 1, entries: [...state.entries, added].slice(-MAX_ENTRIES) }
}

export function area(state: State, areaID: string): AreaFold {
  return state.areas[areaID] ?? { reports: {}, queued: {} }
}

export function withArea(state: State, areaID: string, change: (fold: AreaFold) => AreaFold): State {
  return { ...state, areas: { ...state.areas, [areaID]: change(area(state, areaID)) } }
}

/** A peer's fold within its area's. */
export function peer(fold: AreaFold, key: string): PeerFold {
  return fold.peers?.[key] ?? { reports: {} }
}

export function withPeer(state: State, areaID: string, key: string, change: (fold: PeerFold) => PeerFold): State {
  return withArea(state, areaID, (fold) => ({ ...fold, peers: { ...fold.peers, [key]: change(peer(fold, key)) } }))
}

/** A peer's report (`progress`, `done`, `blocked`), kept like an owner's. */
export function peerReport(
  state: State,
  input: {
    readonly areaID: string
    readonly key: string
    readonly kind: ReportKind
    readonly text: string
    readonly task?: string
    readonly at: number
  },
): State {
  const value: Report = { text: input.text, at: input.at, ...(input.task === undefined ? {} : { task: input.task }) }
  return withPeer(state, input.areaID, input.key, (fold) => ({
    ...fold,
    reports: { ...fold.reports, [input.kind]: value },
  }))
}

export function report(
  state: State,
  input: {
    readonly areaID: string
    readonly kind: ReportKind
    readonly text: string
    readonly task?: string
    readonly at: number
  },
): State {
  const value: Report = { text: input.text, at: input.at, ...(input.task === undefined ? {} : { task: input.task }) }
  return withArea(state, input.areaID, (fold) => ({ ...fold, reports: { ...fold.reports, [input.kind]: value } }))
}

/**
 * One report stored while the area was held (2026-11-14): counted into the area's stretch summary. A summary of another
 * stretch (`since` differs) is replaced by a fresh one. `excerpt`: the report's text; the summary keeps its first
 * {@link STRETCH_LAST} code points on one line.
 */
export function stretch(
  state: State,
  input: { readonly areaID: string; readonly since: number; readonly kind: string; readonly excerpt: string },
): State {
  return withArea(state, input.areaID, (fold) => {
    const current = fold.stretch?.since === input.since ? fold.stretch : { since: input.since, n: 0, kinds: {} }
    return {
      ...fold,
      stretch: {
        ...current,
        n: current.n + 1,
        kinds: { ...current.kinds, [input.kind]: (current.kinds[input.kind] ?? 0) + 1 },
        last: excerpt(input.excerpt.replace(/\s+/g, " ").trim(), STRETCH_LAST),
      },
    }
  })
}

/** The area's stretch `since` ended at `until` (the hand-back): a stretch without reports gets an empty summary. */
export function stretchEnd(
  state: State,
  input: { readonly areaID: string; readonly since: number; readonly until: number },
): State {
  return withArea(state, input.areaID, (fold) => {
    const current = fold.stretch?.since === input.since ? fold.stretch : { since: input.since, n: 0, kinds: {} }
    return { ...fold, stretch: { ...current, until: input.until } }
  })
}

/** The newest report of any kind. */
export function latest(fold: Answers): (Report & { readonly kind: ReportKind }) | undefined {
  return ReportKind.literals
    .flatMap((kind) => {
      const value = fold.reports[kind]
      return value ? [{ ...value, kind }] : []
    })
    .reduce<(Report & { readonly kind: ReportKind }) | undefined>(
      (best, item) => (best === undefined || item.at >= best.at ? item : best),
      undefined,
    )
}

/** When the area (or a peer) last said its work is finished (`done` or `ready`). */
export function finished(fold: Answers) {
  return newest([fold.reports.done?.at, fold.reports.ready?.at])
}

/**
 * The status an owner's area settles at when its run ends (06 §9.4): its answer to the last request it received
 * (`ready` → 반영 준비됨, `blocked` → 막힘), else idle.
 */
export function settled(fold: Answers): "ready" | "blocked" | "idle" {
  const since = fold.received?.at ?? -Infinity
  const answer = (["done", "ready", "blocked"] as const)
    .flatMap((kind) => {
      const value = fold.reports[kind]
      return value && value.at >= since ? [{ kind, at: value.at }] : []
    })
    .reduce<{ kind: "done" | "ready" | "blocked"; at: number } | undefined>(
      (best, item) => (best === undefined || item.at >= best.at ? item : best),
      undefined,
    )
  if (answer?.kind === "ready" || answer?.kind === "blocked") return answer.kind
  return "idle"
}

/** 5.5 `끝났지만 보고 없음`: the owner received a main request and went idle without answering it (once per request). */
export function unreported(fold: Answers): OwnTeam.DispatchID | undefined {
  const received = fold.received
  if (!received || fold.unreported === received.dispatchID) return undefined
  const answered = newest([fold.reports.done?.at, fold.reports.ready?.at, fold.reports.blocked?.at])
  return answered !== undefined && answered >= received.at ? undefined : received.dispatchID
}

/** One area of the team as `모두 끝남` sees it. */
export interface Open {
  /** Main 멈춤 is on or direct work holds the area (`Direct.kept`, 2026-11-14): such areas are left out. */
  readonly paused: boolean
  /** Requests in the outbox. */
  readonly waiting: number
  /** Main requests still in the owner's inbox. */
  readonly queued: number
  /** The owner's run is active. */
  readonly active: boolean
  /** When the last main request was sent. */
  readonly sent?: number
  /** When the owner last reported `done` or `ready`. */
  readonly finished?: number
}

/**
 * 06 §5.6 모두 끝남: in every area without Main 멈춤 or direct work no main request waits in the outbox or the owner's
 * inbox, the owner is idle, and `done` or `ready` came after the last request sent. At least one request must have been sent since the
 * last `모두 끝남` (`since`), so the main is told once per batch of work.
 */
export function allDone(areas: ReadonlyArray<Open>, since?: number) {
  const open = areas.filter((item) => !item.paused)
  const assigned = open.some((item) => item.sent !== undefined && item.sent > (since ?? -Infinity))
  return (
    assigned &&
    open.every(
      (item) =>
        item.waiting === 0 &&
        item.queued === 0 &&
        !item.active &&
        (item.sent === undefined || (item.finished !== undefined && item.finished >= item.sent)),
    )
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Waking

export function waking(state: State) {
  return state.entries.filter((item) => item.wake)
}

/** The waking reasons of the untold entries, oldest first, once each (`own.team.update.reasons`). */
export function reasons(state: State) {
  return [...new Set(waking(state).map((item) => item.reason))]
}

/** Drops the entries an update carried. */
export function told(state: State, upTo: number): State {
  return { ...state, entries: state.entries.filter((item) => item.n > upTo) }
}

/**
 * When `wake.ts` should look again: 30 s after the last waking entry (debounce), and not before an undelivered update
 * is due for its next look (or a failed send for its retry). `undefined` when nothing waits. The hourly limit is
 * applied when the update would go ({@link limit}).
 */
export function due(state: State): number | undefined {
  const wake = waking(state)
  if (wake.length === 0) return undefined
  const debounced = Math.max(...wake.map((item) => item.at)) + DEBOUNCE_MS
  if (!state.pending) return debounced
  const look = (state.pending.checked ?? state.pending.at) + (state.pending.sent ? CHECK_MS : RETRY_MS)
  return Math.max(debounced, look)
}

/** Until when the hourly limit holds updates back, or `undefined` (06 §5.6: at most 12 in an hour). */
export function limit(sent: ReadonlyArray<number>, now: number) {
  const recent = sent.filter((at) => at > now - HOUR_MS).toSorted((a, b) => a - b)
  if (recent.length < PER_HOUR) return undefined
  return recent[recent.length - PER_HOUR] + HOUR_MS
}

/** The sends that still count for the limit. */
export function recent(sent: ReadonlyArray<number>, now: number) {
  return sent.filter((at) => at > now - HOUR_MS)
}

/**
 * What the main inbox says about the pending update. `wait`: an update is still undelivered (ours or another),
 * so nothing new goes in. `retry`: ours was never confirmed and is gone or unknown, so it is sent again with the same id.
 */
export function inbox(
  state: State,
  input: { readonly sessionID: string; readonly undelivered: ReadonlyArray<string>; readonly now: number },
): { readonly state: State; readonly wait: boolean; readonly retry?: Pending } {
  const pending = state.pending
  // A replaced main never gets the old update; its entries go to the new main with the next number.
  const own = pending && pending.sessionID === input.sessionID ? pending : null
  const cleared = own === pending ? state : { ...state, pending: null }
  if (!own) return { state: cleared, wait: input.undelivered.length > 0 }
  if (input.undelivered.includes(own.msgID)) {
    const confirmed = own.sent ? cleared : told(cleared, own.upTo)
    return { state: { ...confirmed, pending: { ...own, sent: true, checked: input.now } }, wait: true }
  }
  if (own.sent) return { state: { ...cleared, pending: null }, wait: input.undelivered.length > 0 }
  return { state: cleared, wait: input.undelivered.length > 0, retry: own }
}

/** The main's inbox delivered or cancelled `inboxID`: when it is the pending update, the next one may go. */
export function delivered(state: State, inboxID: string): State {
  const pending = state.pending
  if (!pending || pending.msgID !== inboxID) return state
  return { ...(pending.sent ? state : told(state, pending.upTo)), pending: null }
}

// ---------------------------------------------------------------------------------------------------------------
// Session log events

const Durable = { created: At, durable: Schema.Struct({ seq: NonNegativeInt }) }
const Ref = { sessionID: Schema.String }

/** The durable session events own.team folds, as the session log and the event stream carry them. */
export const Observed = Schema.Union([
  Schema.Struct({
    ...Durable,
    type: Schema.Literals(["session.execution.started", "session.execution.succeeded"]),
    data: Schema.Struct(Ref),
  }),
  Schema.Struct({
    ...Durable,
    type: Schema.Literal("session.execution.failed"),
    data: Schema.Struct({ ...Ref, error: Schema.Struct({ message: Schema.String }) }),
  }),
  Schema.Struct({
    ...Durable,
    type: Schema.Literal("session.execution.interrupted"),
    data: Schema.Struct({ ...Ref, reason: Schema.String }),
  }),
  Schema.Struct({
    ...Durable,
    type: Schema.Literal("session.inbox.enqueued"),
    data: Schema.Struct({
      ...Ref,
      inboxID: Schema.String,
      item: Schema.Struct({
        payload: Schema.Struct({ metadata: optional(Schema.Record(Schema.String, Schema.Unknown)) }),
      }),
    }),
  }),
  Schema.Struct({
    ...Durable,
    type: Schema.Literals(["session.inbox.delivered", "session.inbox.cancelled"]),
    data: Schema.Struct({ ...Ref, inboxID: Schema.String }),
  }),
])
export type Observed = typeof Observed.Type

const decodeObserved = Schema.decodeUnknownOption(Observed)
const decodeDispatch = Schema.decodeUnknownOption(OwnTeam.DispatchMeta)

/** The folded meaning of a log item, or `undefined` for every other event. */
export function observe(item: unknown): Observed | undefined {
  return Option.getOrUndefined(decodeObserved(item))
}

/**
 * The main or program request an inbox item carries (`own.dispatch` metadata, 5.1). An area message or a program
 * notice (5.8) is no request: no answer is owed for it (no `received`, no `끝났지만 보고 없음`).
 */
export function requestOf(metadata: Readonly<Record<string, unknown>> | undefined) {
  const meta = Option.getOrUndefined(decodeDispatch(metadata?.[OwnTeam.DISPATCH_META]))
  return meta && request({ from: meta.from, kind: meta.kind ?? "task" }) ? meta.id : undefined
}

/** A main or program request (5.1), not an area message or a program notice (5.8). */
export function request(dispatch: Pick<OwnTeam.Dispatch, "from" | "kind">) {
  return dispatch.from !== "area" && dispatch.kind !== "notice"
}

/** Statuses own's own work sets (setup, a broken folder, retirement); session events never replace them. */
const MANAGED: ReadonlySet<OwnTeam.StatusKind> = new Set(["preparing", "broken", "retired"])

/** The area status after an event, or `undefined` when it stays (managed, or the same kind, text and limit). */
export function status(current: OwnTeam.Status, wanted: OwnTeam.Status): OwnTeam.Status | undefined {
  if (MANAGED.has(current.kind)) return undefined
  if (current.kind === wanted.kind && current.text === wanted.text && current.until === wanted.until) return undefined
  return wanted
}

function newest(values: ReadonlyArray<number | undefined>) {
  const known = values.filter((value) => value !== undefined)
  return known.length === 0 ? undefined : Math.max(...known)
}
