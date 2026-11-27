// View models of the team screens (06 §9): an area's status word (9.4), the `메인: …` and `프리셋: …` lines of area
// cards, area rows and owner headers (9.1, 07 §7.4), the worst case of concurrent runs (06 §10.3, 07 §7.4), and the
// wording of steps, notices, errors and the view-only notice of gateway devices (9.3, 2.7, 9.8). Pure: model, effort,
// account and area names come resolved from the caller, and the text function binds the locale.
import { Preset } from "@own/protocol/preset"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { OwnRpcError } from "@/data/rpc"
import type { I18nParams } from "@/i18n"
import { usedTargets } from "@/presets/session-view"
import { LfsUploadFailed } from "./lfs"
import type { TeamNotice } from "./store"
import { teamKo, type TeamKey } from "./strings"

export type TeamText = (key: TeamKey, params?: I18nParams) => string

/** How a status word is drawn: neutral, in progress, needs the user, waits for limits, done, failed, paused. */
export type StatusTone = "idle" | "working" | "attention" | "waiting" | "ready" | "done" | "error" | "paused"

export interface AreaStatus {
  readonly word: string
  readonly tone: StatusTone
  /** `메인 요청 n개 기다림`, shown beside the word while Main 멈춤 is off and main requests wait (9.4). */
  readonly waiting?: string
}

const STATUS: Readonly<Record<OwnTeam.StatusKind, { readonly key: TeamKey; readonly tone: StatusTone }>> = {
  idle: { key: "own.team.status.idle", tone: "idle" },
  preparing: { key: "own.team.status.preparing", tone: "working" },
  busy: { key: "own.team.status.busy", tone: "working" },
  asking: { key: "own.team.status.asking", tone: "attention" },
  blocked: { key: "own.team.status.blocked", tone: "attention" },
  "waiting-quota": { key: "own.team.status.waitingQuota", tone: "waiting" },
  ready: { key: "own.team.status.ready", tone: "ready" },
  failed: { key: "own.team.status.failed", tone: "error" },
  broken: { key: "own.team.status.broken.missing", tone: "error" },
  retired: { key: "own.team.status.retired", tone: "done" },
}

const BROKEN: Readonly<Record<OwnTeam.BrokenReason, TeamKey>> = {
  missing: "own.team.status.broken.missing",
  identity: "own.team.status.broken.identity",
  "branch-gone": "own.team.status.broken.branchGone",
  "shared-branch": "own.team.status.broken.sharedBranch",
}

/** A coming time as the screen words it (`@/limits/format` `coming`: `2시간 14분 후`, `월 오전 9:00`). */
export type TeamTime = (at: number) => string

/**
 * An area's status word (06 §9.4). A stopped or finished area says so first; then Main 멈춤 with the requests it holds
 * back; then 직접 작업 중 (`directWork`) with the requests that wait for the hand-back; else the status with its time (`준비 중(설치 약 N분)`, `한도 대기 · 2시간 14분 후에 풀림`; without `time` the word
 * alone).
 */
export function areaStatus(
  text: TeamText,
  area: Pick<OwnTeam.AreaView, "state" | "broken" | "status" | "paused" | "directWork">,
  /** Main requests that wait: the outbox plus main requests parked in the owner's queue (9.4). */
  waiting: number,
  now = Date.now(),
  time?: TeamTime,
): AreaStatus {
  if (area.state === "retired" || area.status.kind === "retired")
    return { word: text("own.team.status.retired"), tone: "done" }
  if (area.state === "broken" || area.status.kind === "broken")
    return { word: text(BROKEN[area.broken?.why ?? "missing"]), tone: "error" }
  if (area.state === "retiring") return { word: text("own.team.status.retiring"), tone: "working" }
  if (area.paused)
    return {
      word: waiting > 0 ? text("own.team.status.pausedWaiting", { n: waiting }) : text("own.team.status.paused"),
      tone: "paused",
    }
  // 직접 작업 (2026-11-14): the user works with the owner, so main requests wait until the user hands it back.
  if (area.directWork)
    return {
      word: waiting > 0 ? text("own.team.status.directWaiting", { n: waiting }) : text("own.team.status.direct"),
      tone: "paused",
    }
  return {
    word: statusWord(text, area.status, now, time),
    tone: STATUS[area.status.kind].tone,
    waiting: waiting > 0 ? text("own.team.status.waiting", { n: waiting }) : undefined,
  }
}

function statusWord(text: TeamText, status: OwnTeam.Status, now: number, time: TeamTime | undefined) {
  if (status.kind === "preparing" && status.until !== undefined)
    return text("own.team.status.preparingEta", { n: Math.max(1, Math.ceil((status.until - now) / 60_000)) })
  if (status.kind === "waiting-quota" && status.until !== undefined && time)
    return text("own.team.status.waitingQuotaUntil", { time: time(status.until) })
  return text(STATUS[status.kind].key)
}

/** A main as the screens name it: the model's display name, the effort's label and the account's label. */
export interface RunningOn {
  readonly model: string
  /** Absent for the model's default effort. */
  readonly effort?: string
  readonly account?: string
}

/** `GPT-6 Astra · high @ 개인 Pro`. */
export function runningOn(text: TeamText, names: RunningOn) {
  const model = names.effort ? text("own.team.main.effort", { model: names.model, effort: names.effort }) : names.model
  return names.account ? text("own.team.main.account", { model, account: names.account }) : model
}

/**
 * The area main line (9.1, 07 §7.4): `메인: <모델> · <강도> @ <계정>` for a main of its own; for one that follows the
 * team (`area.main` absent) `메인: 팀과 같게`, or `메인: 팀과 같게(<팀 메인>)` where the line names the team main
 * (area menu top line, owner header). Area rows pass no team main so the model is not repeated (9.4).
 */
export function mainLine(text: TeamText, own: RunningOn | undefined, team?: RunningOn) {
  if (own) return text("own.team.main.own", { main: runningOn(text, own) })
  return team ? text("own.team.main.sameWith", { main: runningOn(text, team) }) : text("own.team.main.same")
}

/** `프리셋: <이름>`; `short` gives the main row's `프리셋 <이름>` (9.4). */
export function presetLine(text: TeamText, name: string, short = false) {
  return text(short ? "own.team.preset.short" : "own.team.preset.line", { name })
}

/** An area as the worst case counts it. */
export interface WorstArea {
  readonly presetID: string
  /** Ultra is on in the area's owner conversation (07 §2.9; never stored on the area). */
  readonly ultra?: boolean
}

export interface WorstCase {
  readonly areas: number
  /** Subagents that may run at once over all areas. */
  readonly subagents: number
  /** Owners plus subagents. */
  readonly total: number
  /** Some area delegates actively (`적극적으로`), pins a paid target or runs ultra: the screens show the line. */
  readonly heavy: boolean
  readonly line: string
}

/** What `평소대로` and an unknown preset count as (07 §2.7: the default caps, the model's own delegation). */
const USUAL: Pick<Preset.Info, "caps" | "delegation" | "ultraCaps"> = {
  caps: Preset.CAPS,
  delegation: "model",
  ultraCaps: null,
}

/**
 * The most that can run at once (06 §10.3, 07 §7.4): every area's owner plus the subagents its preset lets run at once
 * (`Preset.caps`, ultra areas with the ultra caps). `영역 4개 × (담당 1 + 하위 에이전트 동시 3) = 최대 16개 동시 실행 ·
 * ChatGPT 01 한도를 함께 씁니다`; areas with different caps add up instead. Nothing is blocked by it.
 */
export function worstCase(
  text: TeamText,
  areas: readonly WorstArea[],
  presets: (presetID: string) => Preset.Info | undefined,
  /** The global ultra level (07 §2.6); a preset's own `ultraCaps` wins. */
  ultraCaps: Preset.UltraCaps,
  limits: {
    /** The account whose limits the areas share (the team account). */
    readonly shared?: string
    /** Whether a pinned target's account is paid per use (07 §5.4). */
    readonly metered?: (account: string) => boolean
  } = {},
): WorstCase | undefined {
  const rows = areas.map((area) => {
    const preset = presets(area.presetID)
    const ultra = area.ultra === true
    return {
      concurrent: Preset.caps(preset ?? USUAL, ultra, ultraCaps).concurrent,
      heavy:
        ultra ||
        preset?.delegation === "active" ||
        pinnedAccounts(preset).some((account) => limits.metered?.(account) === true),
    }
  })
  const first = rows[0]
  if (!first) return undefined
  const subagents = rows.reduce((sum, row) => sum + row.concurrent, 0)
  const total = rows.length + subagents
  const line = rows.every((row) => row.concurrent === first.concurrent)
    ? text("own.team.worst.uniform", { areas: rows.length, sub: first.concurrent, total })
    : text("own.team.worst.mixed", { areas: rows.length, sub: subagents, total })
  return {
    areas: rows.length,
    subagents,
    total,
    heavy: rows.some((row) => row.heavy),
    line: limits.shared ? `${line} · ${text("own.team.worst.shared", { account: limits.shared })}` : line,
  }
}

/** Accounts of the targets a preset pins (only the ones its worker mode uses, a model pool's pins included). */
function pinnedAccounts(preset: Preset.Info | undefined) {
  if (!preset) return []
  return usedTargets(preset.workers).flatMap((target) => ("pin" in target ? [target.pin.account] : []))
}

/** A step of an op in plain words (9.3 자세히); step kinds are open, so an unknown one shows as it is. */
export function stepLabel(text: TeamText, kind: string) {
  const key = `own.team.step.kind.${camel(kind)}`
  return isTeamKey(key) ? text(key) : text("own.team.step.kind.other", { kind })
}

/**
 * A notice in own-web's words (2.7 `notice`), filled from its `data` and the area's name. The service names counts
 * `count`, sizes `bytes` (a fetched folder, 06 §4.6) and folders by their path (`folder`, a waiting integration, 7.2),
 * which `names.folder` shortens as 9.1 names folders. The service's own text stands in when the data lacks a value
 * the words need.
 */
export function noticeText(
  text: TeamText,
  notice: Pick<TeamNotice, "kind" | "text" | "data">,
  names: {
    readonly area?: string
    readonly bytes?: (bytes: number) => string
    readonly folder?: (directory: string) => string
    /** A coming time (`until`, e.g. the held updates of `wake.limited`), {@link TeamTime}. */
    readonly time?: TeamTime
  } = {},
) {
  const why = notice.kind === "area.broken" ? notice.data?.why : undefined
  const specific = typeof why === "string" ? `own.team.notice.broken.${camel(why)}` : undefined
  const key = specific && isTeamKey(specific) ? specific : `own.team.notice.${camel(notice.kind)}`
  if (!isTeamKey(key)) return notice.text
  const until = notice.data?.until
  const count = notice.data?.count
  const bytes = notice.data?.bytes
  const folder = notice.data?.folder
  const line = text(key, {
    ...(typeof count === "number" ? { n: count } : {}),
    ...(typeof bytes === "number" && names.bytes ? { size: names.bytes(bytes) } : {}),
    ...scalars(notice.data),
    ...(typeof until === "number" && names.time ? { time: names.time(until) } : {}),
    ...(typeof folder === "string" && names.folder ? { folder: names.folder(folder) } : {}),
    ...(names.area === undefined ? {} : { area: names.area }),
  })
  return /\{\w+\}/.test(line) ? notice.text : line
}

/** Client-side failures of the own.team client (src/data/team-rpc.ts) and the RPC transport. */
const CLIENT_ERRORS: Readonly<Record<string, TeamKey>> = {
  "own.scope_denied": "own.team.error.scopeDenied",
  "rpc.unavailable": "own.team.error.unavailable",
  "rpc.method_not_found": "own.team.error.unavailable",
}

/** An own.team failure in plain words (06 §2.7 error types); anything that is not an RPC answer is the network. */
export function errorText(text: TeamText, error: unknown): string {
  // 06 §4.13: the large-file tool an SSH host needed could not be uploaded; own.remote's answer says why.
  if (error instanceof LfsUploadFailed)
    return text("own.team.enable.lfsFailed", { reason: errorText(text, error.cause) })
  if (!(error instanceof OwnRpcError)) return text("own.team.error.network")
  const data = scalars(error.data)
  const params = typeof data.count === "number" ? { ...data, n: data.count } : data
  if (error.type === "path_forbidden" && data.why === "hash") return text("own.team.error.pathForbiddenHash", params)
  // 동료 (2026-10-09): why a conversation cannot be a peer, or why a peer's name or role was refused.
  const peer = `own.team.error.peerInvalid.${String(data.why)}`
  if (error.type === "peer_invalid" && isTeamKey(peer)) return text(peer)
  // 담당 대화 바꾸기 (2026-11-12): why a conversation cannot take an area's seat, or why the owner note was refused.
  const seat = `own.team.error.seatInvalid.${String(data.why)}`
  if (error.type === "seat_invalid" && isTeamKey(seat)) return text(seat)
  const key = `own.team.error.${camel(error.type)}`
  return text(CLIENT_ERRORS[error.type] ?? (isTeamKey(key) ? key : "own.team.error.internalError"), params)
}

/**
 * A failed peer action (동료로 등록…, 동료 추가…, 역할 바꾸기…, 동료에서 빼기): a registered conversation on another
 * subscription of the team main's company (10.1 R4) says to change that conversation's account; the rest as
 * {@link errorText}.
 */
export function peerErrorText(text: TeamText, error: unknown) {
  if (error instanceof OwnRpcError && error.type === "same_company_subscription")
    return text("own.team.error.peerSameCompany")
  return errorText(text, error)
}

/**
 * A failed seat move (이 대화를 담당으로): a conversation on another subscription of a company the team uses (10.1 R4)
 * says to change that conversation's account; the rest as {@link errorText}.
 */
export function seatErrorText(text: TeamText, error: unknown) {
  if (error instanceof OwnRpcError && error.type === "same_company_subscription")
    return text("own.team.error.seatSameCompany")
  return errorText(text, error)
}

/**
 * What a gateway device shows instead of a confirm or a settings write (06 §9.8): the phone browser or PWA, the
 * Android app, another PC's 원격 PC window and the 모바일 미리보기 are all devices without the `local` scope. It
 * names the PC the service runs on (`<PC 이름>에서 확인하세요`), never "this PC"; without a name, that PC in words.
 */
export function viewOnlyText(text: TeamText, what: "confirm" | "settings", pc?: string) {
  if (what === "confirm") return pc ? text("own.team.viewOnly.confirm", { pc }) : text("own.team.viewOnly.confirmAny")
  return pc ? text("own.team.viewOnly.settings", { pc }) : text("own.team.viewOnly.settingsAny")
}

function isTeamKey(key: string): key is TeamKey {
  return Object.hasOwn(teamKo, key)
}

/** `waiting-quota`, `needs_confirm`, `account.waiting` → `waitingQuota`, `needsConfirm`, `accountWaiting`. */
function camel(name: string) {
  return name.replace(/[-_.]([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** The string and number values of an untyped payload (error data, notice data) as text params. */
function scalars(value: unknown): Record<string, string | number> {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | number] => {
      const item = entry[1]
      return typeof item === "string" || typeof item === "number"
    }),
  )
}
