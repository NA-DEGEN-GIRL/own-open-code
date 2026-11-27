export * as Handoff from "./handoff.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { OwnTeam } from "@own/protocol"
import { Fsx, Hash } from "@own/runtime"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { AreaCreate } from "../ops/area-create.js"
import { Teams } from "../registry/team.js"
import { Digest } from "../report/digest.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"

/**
 * Handoff documents (06 §6.2 step 2, §6.4): `areas/<slug>/handoff.md` in the team records folder
 * (`<common dir>/own/team/<teamID>/`, outside every worktree, so no clean-up command reaches it). The owner writes it
 * with `team_handoff{text}` in its handoff turn; otherwise the program makes a minimal one without an LLM call: the
 * recent main requests and reports, the branch state (ahead/behind the target, last commit, `git diff --stat
 * <target>...<branch>`, uncommitted files), the fetched heavy folders and the first 2 KB of the old conversation's last
 * owner answer (`session.message`, read only). After an adopted conversation that never got the team (the R4
 * exception, 3.7) it says it continues the user's conversation, which had no main request yet, and quotes that
 * conversation's last answer. 8 KB is advised; a document is cut at 64 KB (on a UTF-8 boundary).
 * Writing records `{file, hash, at}` in `area.handoff`; the new owner conversation starts from `read` (6.2 step 3).
 */

/** 06 §6.4: the advised size of a handoff document. */
export const ADVISED_BYTES = 8 * 1024
/** 06 §6.4: the cap; a longer document keeps its first 64 KB. */
export const MAX_BYTES = 64 * 1024
/** 06 §6.2 step 2: what a program handoff quotes of the old conversation's last owner answer. */
export const ANSWER_BYTES = 2 * 1024

/** Main requests a program handoff lists, newest first. */
const REQUESTS = 3
/** Characters of a request or report a program handoff quotes. */
const QUOTE = 400
/** Owner messages read to find the last answer. */
const MESSAGES = 20
/** A hand-edited document larger than this is not read. */
const READ_LIMIT = 1024 * 1024

export function create(services: Services.Context): Services.Handoff {
  return {
    write: (input) => write(services, input),
    program: (input) => program(services, input),
    read: async (input) => {
      const area = await services.registry.areas.get(input.teamID, input.areaID)
      if (!area?.handoff) return undefined
      const found = await Fsx.readBounded(area.handoff.file, READ_LIMIT)
      return found.type === "ok" ? cap(found.text) : undefined
    },
  }
}

/** `areas/<slug>/handoff.md` in the team records folder; the slug is the area id without `ar_` (V6). */
export function file(team: Pick<OwnTeam.Team, "id" | "commonDir">, areaID: OwnTeam.AreaID) {
  return path.join(Teams.records(team), "areas", areaID.slice("ar_".length), "handoff.md")
}

/**
 * The first line of a handoff document (6.4): `# 인계: <영역 이름> (<날짜>, 담당 대화 #N)`, where N numbers the
 * conversation that ends (the previous ones plus one).
 */
export function title(area: Pick<OwnTeam.Area, "name" | "owner">, now: number) {
  return `# 인계: ${area.name} (${day(now)}, 담당 대화 #${area.owner.previous.length + 1})`
}

/** `text` cut to at most {@link MAX_BYTES} UTF-8 bytes. */
export function cap(text: string) {
  return truncate(text, MAX_BYTES)
}

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
export function truncate(text: string, max: number) {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= max) return text
  return bytes.subarray(0, boundary(bytes, max)).toString("utf8")
}

/** The largest index at or below `limit` that starts a UTF-8 character (continuation bytes are `10xxxxxx`). */
function boundary(bytes: Uint8Array, limit: number): number {
  return limit > 0 && ((bytes[limit] ?? 0) & 0xc0) === 0x80 ? boundary(bytes, limit - 1) : limit
}

async function place(services: Services.Context, input: { readonly teamID: string; readonly areaID: string }) {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  return { ok: true as const, team, area }
}

async function write(
  services: Services.Context,
  input: Parameters<Services.Handoff["write"]>[0],
): Promise<Services.Result<{ readonly file: string; readonly hash: string }>> {
  const placed = await place(services, input)
  if (!placed.ok) return placed
  const text = cap(input.text)
  const target = file(placed.team, placed.area.id)
  const error = await Fsx.writeAtomic(target, text).then(
    () => undefined,
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  )
  if (error !== undefined) return Services.failure("internal_error", `인계 메모를 쓰지 못했어요: ${error}`, {})
  const hash = Hash.sha256(text)
  const at = services.clock.now()
  await services.write(placed.team.id, async () => {
    const current = await services.registry.areas.get(placed.team.id, placed.area.id)
    if (current) await AreaCreate.save(services, { ...current, handoff: { file: target, hash, at } })
  })
  services.log.info("handoff_written", {
    teamID: placed.team.id,
    areaID: placed.area.id,
    by: input.by,
    bytes: Buffer.byteLength(text, "utf8"),
  })
  return { ok: true, file: target, hash }
}

// ---------------------------------------------------------------------------------------------------------------
// The program handoff (06 §6.2 step 2): records, git and the old conversation, read only; never an LLM call.

async function program(
  services: Services.Context,
  input: Parameters<Services.Handoff["program"]>[0],
): Promise<Services.Result<{ readonly text: string }>> {
  const placed = await place(services, input)
  if (!placed.ok) return placed
  const owner = placed.area.owner.sessionID
  const [state, requests, branch, answer] = await Promise.all([
    Digest.load(services.kv, placed.team.id),
    services.registry.dispatches.list(placed.team.id, placed.area.id),
    branchState(placed.team, placed.area),
    owner === null ? Promise.resolve(undefined) : lastAnswer(services, owner, placed.area.directory),
  ])
  return {
    ok: true,
    text: render({
      team: placed.team,
      area: placed.area,
      now: services.clock.now(),
      reports: Fold.area(state, placed.area.id).reports,
      // Area messages and notices are no main requests (06 §5.8): they never crowd a request out of `## 남은 것`.
      requests: requests.filter(Fold.request),
      branch,
      ...(answer === undefined ? {} : { answer }),
      ...(input.seat ? { seat: true as const } : {}),
    }),
  }
}

interface Branch {
  /** `<target> 대비 …` or why git could not say. */
  readonly lines: ReadonlyArray<string>
  /** `git diff --stat` output, when there is one. */
  readonly stat?: string
  /** Uncommitted entries in the area folder (`undefined` when unknown). */
  readonly changes?: number
}

/** The branch against the team target (its base commit when the target branch is gone), read in the area folder. */
async function branchState(team: OwnTeam.Team, area: OwnTeam.Area): Promise<Branch> {
  const options = { cwd: area.directory, worktree: true }
  const branch = `refs/heads/${area.branch}`
  const target = (await Refs.read(area.directory, `refs/heads/${team.target}`))
    ? `refs/heads/${team.target}`
    : area.base.sha
  const name = target === area.base.sha ? area.base.sha.slice(0, 10) : team.target
  const label = target === area.base.sha ? `시작 커밋 ${name}` : name
  const [counts, last, stat, status] = await Promise.all([
    Git.run(["rev-list", "--left-right", "--count", `${target}...${branch}`], options),
    Git.run(["log", "-1", "--format=%h %s", branch], options),
    Git.run(["diff", "--stat=100", "--stat-count=40", `${target}...${branch}`], options),
    Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], options),
  ])
  const [behind, ahead] = counts.ok ? counts.stdout.trim().split(/\s+/) : []
  const lines = [
    counts.ok && ahead !== undefined && behind !== undefined
      ? `- 줄기: ${area.branch} · ${label} 대비 커밋 ${ahead}개 앞섬, ${behind}개 뒤처짐`
      : `- 줄기: ${area.branch} (git이 앞섬·뒤처짐을 말하지 않았습니다${counts.ok ? "" : `: ${counts.message}`})`,
    last.ok && last.stdout.trim() ? `- 마지막 커밋: ${last.stdout.trim()}` : "- 마지막 커밋: (읽지 못함)",
  ]
  const trimmed = stat.ok ? stat.stdout.trimEnd() : ""
  return {
    lines,
    ...(trimmed === "" ? {} : { stat: `git diff --stat ${name}...${area.branch}\n${trimmed}` }),
    ...(status.ok ? { changes: Porcelain.status(status.stdout).entries.length } : {}),
  }
}

const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: optional(Schema.String) })),
})
const decodeAssistant = Schema.decodeUnknownOption(Assistant)

/** The first {@link ANSWER_BYTES} of the newest owner answer with text (`session.message`, read only). */
async function lastAnswer(services: Services.Context, sessionID: string, directory: string) {
  const messages = await services.http.session.messages({ sessionID, directory, limit: MESSAGES, order: "desc" })
  if (!messages.ok) return undefined
  const text = messages.value.data
    .map((message) =>
      Option.match(decodeAssistant(message), {
        onNone: () => "",
        onSome: (assistant) =>
          assistant.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join(""),
      }),
    )
    .find((value) => value.trim() !== "")
  return text === undefined ? undefined : truncate(text.trim(), ANSWER_BYTES)
}

/** The opening line after an owner conversation that worked for the team. */
const INTRO =
  "프로그램이 만든 인계 문서입니다. 지난 담당 대화가 인계를 쓰지 않아 팀 기록과 git에서 모았습니다(LLM 호출 없음). 빈 곳은 작업 폴더와 줄기에서 확인하세요."

/**
 * The opening line after an adopted conversation that never got the team (3.7, 10.1: the R4 exception continues it on
 * the team account without a turn there). It worked for the user, so no main request was sent to it.
 */
const ADOPTED_INTRO =
  "프로그램이 만든 인계 문서입니다. 사용자가 팀 밖에서 쓰던 대화를 받아들여 새 담당 대화로 이어 갑니다. 그 대화에서는 LLM을 돌리지 않고 팀 기록과 git, 그 대화의 마지막 답에서 모았습니다. 빈 곳은 작업 폴더와 줄기에서 확인하세요."

/**
 * The opening line when the reader is a conversation that was there already and takes the seat (6.8): it may know
 * the folder better than the note, and nothing about it is new.
 */
const SEAT_INTRO =
  "프로그램이 만든 인계 문서입니다. 사용자가 이 대화를 이 영역의 담당으로 정했습니다. 지난 담당 대화에서는 LLM을 돌리지 않고 팀 기록과 git, 그 대화의 마지막 답에서 모았습니다. 이 대화가 이미 아는 것과 다르면 작업 폴더와 줄기에서 확인하세요."

function render(input: {
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly now: number
  readonly reports: Fold.AreaFold["reports"]
  readonly requests: ReadonlyArray<OwnTeam.Dispatch>
  readonly branch: Branch
  readonly answer?: string
  readonly seat?: true
}) {
  const area = input.area
  // The conversation being replaced is an adopted one that never got the team (`owner.attached: false`).
  const adopted = !area.owner.attached
  const sent = input.requests
    .filter((request) => request.sentTo !== undefined)
    .toSorted((a, b) => (b.sentTo?.at ?? 0) - (a.sentTo?.at ?? 0))
    .slice(0, REQUESTS)
  const waiting = input.requests.filter((request) => request.state === "waiting").length
  const reports = (["done", "ready", "progress"] as const).flatMap((kind) => {
    const report = input.reports[kind]
    return report ? [{ kind, ...report }] : []
  })
  const blocked = input.reports.blocked
  const extra = Object.entries(area.cone.extra)
  const kept = Object.entries(area.cone.kept)
  const changes = input.branch.changes
  return [
    title(area, input.now),
    "",
    input.seat ? SEAT_INTRO : adopted ? ADOPTED_INTRO : INTRO,
    "",
    "## 목표",
    area.goal.trim() === "" ? "(적힌 목표 없음)" : area.goal,
    "",
    "## 지금 상태",
    ...input.branch.lines,
    ...(changes === undefined ? ["- 커밋 안 된 변경: (읽지 못함)"] : [`- 커밋 안 된 변경: 파일 ${changes}개`]),
    ...(input.branch.stat === undefined ? [] : ["", "```", input.branch.stat, "```"]),
    "",
    "## 끝낸 것",
    ...(reports.length === 0
      ? ["(보고 없음)"]
      : reports.map((report) => `- ${report.kind} (${moment(report.at)}): ${quote(report.text)}`)),
    "",
    "## 남은 것",
    ...(sent.length === 0
      ? [adopted ? "(받아들인 대화라 아직 보낸 메인 요청이 없습니다)" : "(보낸 메인 요청 없음)"]
      : sent.map(
          (request, index) =>
            `- ${index === 0 ? "마지막 메인 요청" : "그 전 요청"} (${moment(request.sentTo?.at ?? request.createdAt)}${request.task ? `, 일 "${quote(request.task)}"` : ""}): ${quote(request.text)}`,
        )),
    ...(waiting === 0
      ? []
      : [`- 기다리는 메인 요청 ${waiting}개는 ${input.seat ? "이 대화" : "새 담당 대화"}에 갑니다.`]),
    "",
    "## 결정과 이유",
    "(프로그램 인계에는 결정이 적히지 않습니다. 필요한 결정은 메인이 요청 본문에 적습니다.)",
    "",
    "## 주의",
    ...(blocked ? [`- 마지막 blocked 보고 (${moment(blocked.at)}): ${quote(blocked.text)}`] : []),
    ...(changes !== undefined && changes > 0
      ? [
          input.seat
            ? // The reader may have made them itself before it took the seat: only what it does not know is left alone.
              `- 작업 폴더에 커밋 안 된 변경이 ${changes}개 있습니다. 이 대화가 만든 것도, 지난 담당 대화가 만든 것도 있을 수 있습니다. 누가 만들었는지 모르는 변경은 커밋·되돌리기·stash·덮어쓰기를 하지 말고 team_report(kind:"blocked")로 알리세요.`
            : `- 작업 폴더에 커밋 안 된 변경이 ${changes}개 있습니다. 이번 요청에서 만든 것이 아니면 커밋·되돌리기·stash·덮어쓰기를 하지 말고 team_report(kind:"blocked")로 알리세요.`,
        ]
      : []),
    ...(blocked || (changes !== undefined && changes > 0) ? [] : ["(없음)"]),
    "",
    "## 받은 큰 파일 폴더",
    ...(extra.length === 0 && kept.length === 0
      ? ["(없음)"]
      : [
          ...extra.map(([dir, item]) => `- ${dir}: ${item.reason} (${megabytes(item.bytes)})`),
          ...kept.map(([dir, why]) => `- ${dir}: 내려놓지 못함 (${why})`),
        ]),
    ...(input.answer === undefined
      ? []
      : [
          "",
          adopted ? "## 받아들인 대화의 마지막 답 (앞 2 KB)" : "## 지난 담당의 마지막 답 (앞 2 KB)",
          ...input.answer.split(/\r?\n/).map((line) => `> ${line}`),
        ]),
    "",
  ].join("\n")
}

/** One line of at most {@link QUOTE} characters. */
function quote(text: string) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > QUOTE ? `${line.slice(0, QUOTE)}…` : line
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

/** `YYYY-MM-DD` in local time. */
function day(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `MM-DD HH:mm` in local time. */
function moment(at: number) {
  const date = new Date(at)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function megabytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}
