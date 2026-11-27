export * as Decisions from "./decisions.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Fsx } from "@own/runtime"
import { Keys } from "../registry/keys.js"
import { Teams } from "../registry/team.js"
import { Services } from "../services.js"

/**
 * Decision records (06 §6.6): `decisions/NNNN-<slug>.md` in the team records folder (`<common dir>/own/team/<teamID>/`,
 * 2.4). That folder is outside every worktree, so integrations never carry the records and no clean-up command reaches
 * them. The main writes one with `team_decide`, the user with 결정 적기 (`decisions.add`). A file starts with its
 * number, date, source and related areas; KV `decision:<teamID>:<NNNN>` is the index (`OwnTeam.DecisionRecord`).
 *
 * Numbers are given out in the team's mutex, one above the highest number in the index or in the folder. Undoing
 * enable removes the index, but the folder keeps its files, so a team enabled again never repeats a number. The file
 * is written before its index entry: a failed write leaves no entry and uses no number. The title and body limits
 * (200 and 65,536 characters) are checked where the input arrives (the `decisions.add` schema, `team_decide`'s input);
 * the title is kept on one line, and the file name takes only its ASCII words.
 *
 * `policy.commitDecisions` (12.2, off by default): the program never writes under the main folder. When the setting is
 * on, the result also carries the copy and the instruction for the main to commit it there.
 */

/** ASCII words of the title a file name keeps, and the characters kept of each. */
export const SLUG_WORDS = 3
const WORD_CHARS = 16
/** The slug of a title without ASCII words. */
export const FALLBACK_SLUG = "decision"

/** Titles the judge gets (3.4): the newest ones. */
export const TITLES = 20

/** With `commitDecisions` on: where the main commits the copy, relative to the main folder. */
export const COPY_DIR = "docs/decisions"

const FOLDER = "decisions"
const NUMBERED = /^(\d+)-.*\.md$/

/** What the record functions need; `Services.Context` has all of it. */
export type Deps = Pick<Services.Base, "kv" | "write" | "clock" | "log"> & {
  readonly registry: Pick<Services.Registry, "teams" | "areas">
  /** Default {@link files}. */
  readonly files?: Files
}

/** The file operations of a decision record. */
export interface Files {
  /** Writes the whole file, and its folders, atomically. */
  write(file: string, text: string): Promise<void>
  /** The names in a folder; none when the folder does not exist. */
  names(dir: string): Promise<ReadonlyArray<string>>
}

export const files: Files = {
  write: Fsx.writeAtomic,
  names: (dir) =>
    fs.readdir(dir).catch((error: unknown) => {
      if (Fsx.code(error) === "ENOENT") return []
      throw error
    }),
}

export interface AddInput {
  readonly teamID: OwnTeam.TeamID
  readonly title: string
  readonly body: string
  readonly source: OwnTeam.DecisionRecord["source"]
  /** Related areas (the ids of `team_decide`'s `areas`); an id the team does not have is refused. */
  readonly areas?: ReadonlyArray<OwnTeam.AreaID>
}

/** The copy the main commits in the main folder (`commitDecisions` on). */
export interface Commit {
  /** The main folder. */
  readonly directory: string
  /** Where the copy goes, relative to the main folder, `/`-separated. */
  readonly path: string
  /** The copy: the record file's text. */
  readonly text: string
  /** What the main does, in Korean (a tool answer or a team update note). */
  readonly instruction: string
}

export interface Added {
  readonly record: OwnTeam.DecisionRecord
  /** The record file's absolute path. */
  readonly path: string
  readonly commit?: Commit
}

const decode = Schema.decodeUnknownOption(OwnTeam.DecisionRecord)
const encode = Schema.encodeSync(OwnTeam.DecisionRecord)

/**
 * Writes a decision record with the next number and indexes it. Runs in the team's mutex, so it must not be called
 * from inside a write section of the same team.
 */
export async function add(deps: Deps, input: AddInput): Promise<Services.Result<Added>> {
  const title = oneLine(input.title)
  if (title === "") return Services.failure("unsupported", "a decision record needs a title", { feature: "decisions" })
  return deps.write(input.teamID, async (): Promise<Services.Result<Added>> => {
    const team = await deps.registry.teams.get(input.teamID)
    if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
    if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
    const areas = await related(deps, team.id, input.areas ?? [])
    if (!areas.ok) return areas
    const number = await next(deps, team)
    const record: OwnTeam.DecisionRecord = {
      number,
      title,
      file: `${FOLDER}/${name(number, title)}`,
      at: deps.clock.now(),
      source: input.source,
      areas: areas.items.map((area) => area.id),
    }
    const target = path.join(Teams.records(team), ...record.file.split("/"))
    const text = render(record, areas.items, input.body)
    const error = await (deps.files ?? files).write(target, text).then(
      () => undefined,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    )
    if (error !== undefined)
      return Services.failure("internal_error", `the decision record was not written: ${error}`, {})
    await deps.kv.set(Keys.decision(team.id, number), Keys.toJson(encode(record)))
    deps.log.info("decision_added", { teamID: team.id, number, source: input.source, areas: record.areas.length })
    return {
      ok: true,
      record,
      path: target,
      ...(team.policy.commitDecisions ? { commit: copy(team, record, target, text) } : {}),
    }
  })
}

/** `decisions.list`: the team's records in number order. */
export async function list(
  deps: Pick<Deps, "kv" | "log" | "registry">,
  teamID: OwnTeam.TeamID,
): Promise<Services.Result<{ readonly items: ReadonlyArray<OwnTeam.DecisionRecord> }>> {
  const team = await deps.registry.teams.get(teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: teamID })
  return { ok: true, items: await records(deps, team.id) }
}

/** The judge's decision input (3.4): the newest `limit` titles as `NNNN 제목`, oldest first. */
export async function titles(deps: Pick<Deps, "kv" | "log">, teamID: OwnTeam.TeamID, limit = TITLES) {
  const items = await records(deps, teamID)
  return items.slice(Math.max(0, items.length - limit)).map((record) => `${pad(record.number)} ${record.title}`)
}

/**
 * The team update note about a decision the user wrote (결정 적기): the main reads it in its next team update and is
 * not woken (5.6). It says where the record is, or, with `commitDecisions` on, what to commit.
 */
export function entry(added: Added): Services.DigestEntry {
  const line = OwnTeamText.decisionLine({
    number: added.record.number,
    title: added.record.title,
    source: added.record.source,
    detail: added.commit?.instruction ?? `내용: ${added.path}`,
  })
  return {
    at: added.record.at,
    reason: "decided",
    // The digest writes a team note as `- <text>`, which gives back the shared decision line (`OwnTeamText.countOf`).
    text: line.replace(/^- /, ""),
    wake: false,
  }
}

/** `NNNN-<slug>.md`; the number has at least four digits. */
export function name(number: number, title: string) {
  return `${pad(number)}-${slug(title)}.md`
}

/** At most {@link SLUG_WORDS} ASCII words of the title, lower case, joined by `-`; {@link FALLBACK_SLUG} without any. */
export function slug(title: string) {
  // NFKD splits accented and full-width letters into ASCII letters and marks; the marks are dropped.
  const words =
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  if (words.length === 0) return FALLBACK_SLUG
  return words
    .slice(0, SLUG_WORDS)
    .map((word) => word.slice(0, WORD_CHARS))
    .join("-")
}

/** The record file: the 6.6 header (number, date, source, related areas), then the body. */
function render(record: OwnTeam.DecisionRecord, areas: ReadonlyArray<Pick<OwnTeam.Area, "id" | "name">>, body: string) {
  const content = body.trimEnd()
  return [
    `# ${OwnTeamText.DECISION} ${pad(record.number)}: ${record.title}`,
    "",
    `- 번호: ${pad(record.number)}`,
    `- 날짜: ${day(record.at)}`,
    `- 출처: ${OwnTeamText.DECIDED_BY[record.source]}`,
    `- 관련 영역: ${areas.length === 0 ? "없음" : areas.map((area) => `${area.name} (${area.id})`).join(", ")}`,
    ...(content.trim() === "" ? [] : ["", content]),
    "",
  ].join("\n")
}

async function records(deps: Pick<Deps, "kv" | "log">, teamID: string) {
  const entries = await deps.kv.scan(Keys.prefix.decisions(teamID))
  return entries
    .flatMap((item) => {
      const record = Option.getOrUndefined(decode(item.value))
      if (record === undefined) deps.log.warn("decision_record_invalid", { key: item.key })
      return record === undefined ? [] : [record]
    })
    .toSorted((a, b) => a.number - b.number)
}

/** One above the highest number in the index or among the folder's files. */
async function next(deps: Deps, team: OwnTeam.Team) {
  const prefix = Keys.prefix.decisions(team.id)
  const [indexed, names] = await Promise.all([
    deps.kv.scan(prefix),
    (deps.files ?? files).names(path.join(Teams.records(team), FOLDER)),
  ])
  const numbers = [
    ...indexed.map((item) => Number(item.key.slice(prefix.length))),
    ...names.flatMap((file) => {
      const match = NUMBERED.exec(file)
      return match ? [Number(match[1])] : []
    }),
  ].filter(Number.isSafeInteger)
  return Math.max(0, ...numbers) + 1
}

/** The related areas in the order given, once each. */
async function related(deps: Deps, teamID: OwnTeam.TeamID, ids: ReadonlyArray<OwnTeam.AreaID>) {
  const unique = [...new Set(ids)]
  const found = await Promise.all(unique.map((id) => deps.registry.areas.get(teamID, id)))
  const missing = unique.find((_, index) => found[index] === undefined)
  if (missing !== undefined)
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: missing })
  return { ok: true as const, items: found.filter((area): area is OwnTeam.Area => area !== undefined) }
}

function copy(team: OwnTeam.Team, record: OwnTeam.DecisionRecord, original: string, text: string): Commit {
  const target = `${COPY_DIR}/${path.posix.basename(record.file)}`
  const number = `${OwnTeamText.DECISION} ${pad(record.number)}`
  return {
    directory: team.home.directory,
    path: target,
    text,
    instruction:
      `결정 기록 사본을 프로젝트에 남기는 설정이 켜져 있습니다. 메인 폴더 ${team.home.directory}에서 ${target} 파일을 ` +
      `원본(${original})과 같은 내용으로 만들고 그 파일만 커밋하세요(git add -- ${target}, ` +
      `git commit -m "<메시지>" -- ${target}). 커밋 메시지에는 "${number}"와 제목을 넣고 저장소의 커밋 규칙을 따르세요. ` +
      "다른 변경은 커밋에 넣지 마세요.",
  }
}

/** The title on one line. */
function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function pad(number: number) {
  return String(number).padStart(4, "0")
}

/** `YYYY-MM-DD` in local time. */
function day(at: number) {
  const date = new Date(at)
  const two = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}
