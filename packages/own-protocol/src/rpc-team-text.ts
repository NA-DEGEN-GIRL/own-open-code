export * as OwnTeamText from "./rpc-team-text.js"

// Text own.team writes into conversations and own-web reads back (06 §5.1, §5.6, §5.8, §9.4): the envelope of a main
// request or an area message and the notes block after it, the status words a team update's area lines start with, and
// the words of its integration and decision record lines.
// Plain strings without the RPC schema graph (type-only imports), so own-web loads it in any chunk, like
// `rpc-team-routing`; one module keeps writer and reader in step.

import type { OwnTeam } from "./rpc-team.js"

/**
 * The envelope of a main request (06 §5.1): `<dispatch from="main" id="dp_…" area="인벤토리 화면" task="정렬 버그">`, the
 * request, `</dispatch>`. Attribute values are escaped, and a `</dispatch` inside the body becomes `<\/dispatch`, so the
 * body can never close the envelope early.
 *
 * An area message (5.8) names its sender, its kind and, for a reply, the ask it answers:
 * `<dispatch from="area" sender="세이브 v3" kind="reply" reply="dp_…" id="dp_…" area="인벤토리 화면">`; a program notice is
 * `<dispatch from="team" kind="notice" …>`. Notes (쪽지) held for the conversation follow the envelope in a
 * `<team-notes>` block, one line each. Every attribute is written only when given, so the envelopes of main and program
 * requests stay byte for byte.
 */
export function wrap(input: {
  readonly from: string
  /** The area peer it goes to (`to="reviewer"`, 동료); an owner's envelope has no `to`, so it stays byte for byte. */
  readonly to?: string
  /** An area message's sender, as the screen names it (5.8). */
  readonly sender?: string
  /** Only for area messages and program notices (`ask`, `reply`, `notice`). */
  readonly kind?: string
  /** A reply's ask (its dispatch id). */
  readonly reply?: string
  readonly id: string
  /** The area's display name. */
  readonly area: string
  readonly task?: string
  readonly text: string
  /** Notes (쪽지) that go with it: who left each, when (`2026-10-25 14:05`) and its text. */
  readonly notes?: ReadonlyArray<{ readonly from: string; readonly at: string; readonly text: string }>
}) {
  const attributes: ReadonlyArray<readonly [string, string]> = [
    ["from", input.from],
    ...(input.to ? [["to", input.to] as const] : []),
    ...(input.sender ? [["sender", input.sender] as const] : []),
    ...(input.kind ? [["kind", input.kind] as const] : []),
    ...(input.reply ? [["reply", input.reply] as const] : []),
    ["id", input.id],
    ["area", input.area],
    ...(input.task ? [["task", input.task] as const] : []),
  ]
  const head = attributes.map(([name, value]) => `${name}="${attribute(value)}"`).join(" ")
  const notes = input.notes ?? []
  const block =
    notes.length === 0
      ? ""
      : `\n<${NOTES}>\n${notes.map((note) => `- ${attribute(note.from)}(${attribute(note.at)}): ${noteText(note.text)}`).join("\n")}\n</${NOTES}>`
  return `<dispatch ${head}>\n${body(input.text)}\n</dispatch>${block}`
}

/**
 * A main request's text without its envelope (06 §5.1, 5.2): what own-web shows folded and puts back into the composer.
 * Every `<\/dispatch` goes back to `</dispatch`; notes after the envelope are left out; text without the envelope stays
 * as it is.
 */
export function unwrap(text: string) {
  const inner = ENVELOPE.exec(text)?.[1]
  return inner === undefined ? text : inner.replace(/<\\\/dispatch/gi, (match) => `<${match.slice(2)}`)
}

/** The tag of the notes block after an envelope (06 §5.8). */
export const NOTES = "team-notes"

/**
 * The note lines (without their `- `) of the `<team-notes>` block after an envelope; none for text that is no envelope,
 * so a user's own text is never counted.
 */
export function notes(text: string): ReadonlyArray<string> {
  const block = ENVELOPE.exec(text)?.[2]
  if (block === undefined) return []
  return block.split("\n").flatMap((line) => (line.startsWith("- ") ? [line.slice(2)] : []))
}

/** A note on one line that never closes its block or the envelope (`</team-notes`, `</dispatch` as `<\/…`). */
function noteText(text: string) {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim()
    .replace(/<\/(team-notes|dispatch)/gi, (match) => `<\\${match.slice(1)}`)
}

/** The body with every `</dispatch` (any case) written as `<\/dispatch`. */
export function body(text: string) {
  return text.replace(/<\/dispatch/gi, (match) => `<\\${match.slice(1)}`)
}

/** An attribute value on one line, with `& < > "` escaped. */
export function attribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s*[\r\n]+\s*/g, " ")
}

/** The envelope, its body (1) and the lines of a notes block after it (2). */
const ENVELOPE = /^<dispatch\b[^>\n]*>\n([\s\S]*?)\n<\/dispatch>(?:\n<team-notes>\n([\s\S]*)\n<\/team-notes>)?$/

/** An area's status word (06 §9.4), which starts its line in a team update: `- 인벤토리 화면: 반영 준비됨 · …`. */
export const WORDS: { readonly [K in OwnTeam.StatusKind]: string } = {
  idle: "쉬는 중",
  preparing: "준비 중",
  busy: "작업 중",
  asking: "답을 기다림",
  blocked: "막힘",
  "waiting-quota": "한도 대기",
  ready: "반영 준비됨",
  failed: "실패",
  broken: "멈춤",
  retired: "끝낸 영역",
}

/** The idle word before the 2026-10-16 glossary (03 §14.1: 대기 중 means queued only); team updates still parse it. */
export const LEGACY_IDLE = "대기 중"

/** `작업 중(12분째)`: a busy area after its first minute. */
export function busyFor(minutes: number) {
  return `${WORDS.busy}(${minutes}분째)`
}

/** `한도 대기 · 2026-10-25 14:05에 풀림`: a limit wait with its reset time (own.team `Talk.clock`, the service's local time). */
export function quotaUntil(clock: string) {
  return `${WORDS["waiting-quota"]} · ${clock}에 풀림`
}

/**
 * The word of an integration line after the area's name (06 §5.6, §7, §9.7): `- 인벤토리 화면: 반영함 · …`. own.team
 * writes it as a line of its own, never as a part of the area's status line, so own-web counts it.
 */
export const INTEGRATION: { readonly [K in OwnTeam.IntegrationState]: string } = {
  running: "반영하는 중",
  waiting: "반영 기다림",
  conflict: "겹친 변경 정리 중",
  failed: "반영 실패",
  done: "반영함",
  undone: "반영 되돌림",
}

/** `- 인벤토리 화면: 반영함 · 그 뒤 저장 지점 2개는 넣지 않음`: a team update line about an integration. */
export function integrationLine(input: {
  /** The area's display name. */
  readonly area: string
  readonly state: OwnTeam.IntegrationState
  readonly detail?: string
}) {
  return `- ${oneLine(input.area)}: ${INTEGRATION[input.state]}${input.detail ? ` · ${oneLine(input.detail)}` : ""}`
}

/** The screen and team update word of an area peer (06 §1.2, §9.1). */
export const PEER = "동료"

/** An area message's sender as the envelope and the team update name it (5.8): `인벤토리 화면`, `인벤토리 화면 동료 리뷰어`. */
export function senderName(sender: Pick<OwnTeam.Sender, "area" | "peer">) {
  return sender.peer ? `${sender.area} ${PEER} ${sender.peer.label}` : sender.area
}

/** Who a note of own.team itself names as its sender (담당 대화 바꾸기). */
export const TEAM = "팀"

/** A note's sender as the notes block and the screen name it: the area or peer that left it, or `팀` for a team note. */
export function noteFrom(note: {
  readonly sender: Pick<OwnTeam.Sender, "area" | "peer">
  readonly from?: OwnTeam.AreaNote["from"]
}) {
  return note.from === "team" ? TEAM : senderName(note.sender)
}

/** A peer's state words in a team update (`쉬는 중`, `작업 중`, `막힘`). */
export const PEER_WORDS = { idle: WORDS.idle, busy: WORDS.busy, blocked: WORDS.blocked } as const

/**
 * `  · 동료 리뷰어: 쉬는 중 · "…"`: a peer's line under its area's line in a team update (06 §5.6). It has no leading
 * `- `, so {@link countOf} counts no area for it and the update's one-line summary stays the areas'.
 */
export function peerLine(input: { readonly label: string; readonly parts: ReadonlyArray<string> }) {
  return `  · ${PEER} ${oneLine(input.label)}: ${input.parts.map(oneLine).join(" · ")}`
}

/** What a decision record's line starts with (06 §6.6). */
export const DECISION = "결정 기록"

/** Who wrote a decision record (6.6): the main's `team_decide` or the user's 결정 적기. */
export const DECIDED_BY: { readonly [K in OwnTeam.DecisionRecord["source"]]: string } = {
  main: "메인이 적음",
  user: "사용자가 적음",
}

/**
 * `- 결정 기록 0004(사용자가 적음): "필드 이름은 snake_case"`: a team update line about a new decision record, numbered
 * like its file `decisions/0004-….md`. `detail` follows after ` · ` (what the main does with it).
 */
export function decisionLine(input: {
  readonly number: number
  readonly title: string
  readonly source: OwnTeam.DecisionRecord["source"]
  readonly detail?: string
}) {
  const number = String(input.number).padStart(4, "0")
  const detail = input.detail ? ` · ${oneLine(input.detail)}` : ""
  return `- ${DECISION} ${number}(${DECIDED_BY[input.source]}): "${oneLine(input.title)}"${detail}`
}

/** Text on one line that never closes the update: every `</team-update` (any case) is written `<\/team-update`. */
function oneLine(text: string) {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim()
    .replace(/<\/team-update/gi, (match) => `<\\${match.slice(1)}`)
}

/** The area groups a team update's one-line summary counts (`팀 소식 · 반영 준비 1, 진행 중 1`, 06 §9.6), in its order. */
export type UpdateCount = "ready" | "blocked" | "failed" | "waiting" | "busy" | "done"

/**
 * The groups of a team update's event lines that no area group fits: integrations applied or undone, and decision
 * records. The summary names them after the area groups.
 */
export type EventCount = "integrated" | "undone" | "decided"

export type LineCount = UpdateCount | EventCount

/**
 * Line patterns by group. An integration that runs, waits or failed counts with the areas that do; one that was
 * applied or undone has a group of its own.
 */
const COUNTED: ReadonlyArray<readonly [LineCount, ReadonlyArray<string>]> = [
  ["ready", [escape(WORDS.ready)]],
  ["blocked", [escape(WORDS.blocked)]],
  ["failed", [escape(WORDS.failed), escape(INTEGRATION.failed)]],
  [
    "waiting",
    [escape(WORDS.asking), `${escape(WORDS["waiting-quota"])}(?: · [^·]+에 풀림)?`, escape(INTEGRATION.waiting)],
  ],
  [
    "busy",
    [
      `${escape(WORDS.busy)}(?:\\(\\d+분째\\))?`,
      escape(WORDS.preparing),
      escape(INTEGRATION.running),
      escape(INTEGRATION.conflict),
    ],
  ],
  // `대기 중`: the idle word of own-team builds before 2026-10-16 (an SSH host may run one).
  ["done", [escape(WORDS.idle), escape(LEGACY_IDLE)]],
  ["integrated", [escape(INTEGRATION.done)]],
  ["undone", [escape(INTEGRATION.undone)]],
]

const ALTERNATIVES = COUNTED.flatMap(([kind, patterns]) => patterns.map((pattern) => [kind, pattern] as const))

/**
 * `- <name>: <word> · …` or `- <name>: <word>`. The shortest name wins, so a quoted text later in the line never
 * decides the group, while a name holding `: ` still parses. Each alternative is one capture group.
 */
const LINE = new RegExp(`^- .+?: (?:${ALTERNATIVES.map(([, pattern]) => `(${pattern})`).join("|")})(?: · |$)`)

/** `- 결정 기록 0004(…): "`: checked first, so a title holding status words never counts as an area. */
const DECISION_LINE = new RegExp(`^- ${escape(DECISION)} \\d+(?:\\([^)\\n]*\\))?: "`)

/** The group of a team update line (an area, an integration or a decision record); `undefined` for any other line. */
export function countOf(line: string): LineCount | undefined {
  if (DECISION_LINE.test(line)) return "decided"
  const match = LINE.exec(line)
  if (!match) return undefined
  return ALTERNATIVES[match.slice(1).findIndex((group) => group !== undefined)]?.[0]
}

/** The area groups in the order the summary names them. */
export const COUNTS: ReadonlyArray<UpdateCount> = ["ready", "blocked", "failed", "waiting", "busy", "done"]

/** The event groups in the order the summary names them, after {@link COUNTS}. */
export const EVENT_COUNTS: ReadonlyArray<EventCount> = ["integrated", "undone", "decided"]

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
