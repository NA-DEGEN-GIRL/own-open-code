export * as StatusTool from "./status.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Talk } from "../dispatch/talk.js"
import { Classify } from "../git/classify.js"
import { Inventory } from "../git/inventory.js"
import { IntegrateOp } from "../integrate/op.js"
import { Verify } from "../integrate/verify.js"
import { Confirm } from "../ops/confirm.js"
import { Undo } from "../ops/undo.js"
import { OpWords } from "../ops/words.js"
import { Teams } from "../registry/team.js"
import { Digest } from "../report/digest.js"
import { Fold } from "../report/fold.js"
import { Texts } from "../report/texts.js"
import type { Services } from "../services.js"
import { MainTools } from "./main.js"
import type { OwnerTools } from "./owner.js"
import { Targets } from "./targets.js"

/**
 * `team_status{area?}` (06 §2.8): the current team update (5.6 form) from the digest; no side effects. The main gets
 * the whole team (each area's state, the owner's latest report, direct user talk, Main 멈춤, waiting requests and the
 * `할 일:` line), or one area with a team summary; an owner or an area peer (동료) gets its own area and a team summary,
 * and since 2026-10-16 also the other areas, its own asks, watches and the notes held for it (06 §5.8; the description
 * stays as it was, so the main's catalog does not change: the role text tells owners and peers).
 * The main's view of one area also lists the folder's other root conversations that are no owner or peer (title and
 * short id), so the main and the user can name one to register as a peer or to seat as the owner; a conversation that
 * was the owner before and is not archived is among them, marked `전 담당`.
 *
 * 2026-11-12 (담당 메모): an area with at least one peer gets a roster line ({@link roster}), the owner first with the
 * user's note about it, then each peer with its key and role: `대화: 담당 메모 "…", 리뷰어(reviewer) 역할 "…"`. The
 * main's whole-team view has one per such area (the area's name first), its view of one area has that area's, and an
 * owner or a peer has its own area's, so each can tell whom to ask. An area without peers has none: its goal already
 * says what the owner does. The note is on that line only; the digest text above it never repeats it. `detail: true` adds what the screen's 자세히 and 로그 보기 show ({@link details}, 06 §2.9).
 *
 * 2026-10-16 (06 §8.1): the main's whole-team view also lists the work folders left outside the team (`team.external`,
 * kept by reconcile, read from the registry: no git), so the main can regroup an existing project in plain words with
 * `team_reorganize{areas[].adopt}` instead of reading `git worktree list` through the shell; with `detail` each one's
 * uncommitted changes and commits the target lacks (one inventory read). A tool result, so no cache cost.
 *
 * 2026-11-14 (whole texts): the update quotes only the start of a report or a relay; the main's view of one area adds
 * the whole texts ({@link whole}): the newest report of each kind of the owner and of each peer, the user's relays and
 * the reports kept during the area's current or last direct work. The viewed area's role and the roster's note and
 * peer roles are printed whole there and in an owner's or a peer's own view; the whole-team view keeps its quotes. The
 * output has no bound of its own: core bounds a tool's output and saves the whole.
 */

export const NAME = "status"

export const DESCRIPTION = [
  "Current team update: each area's state, waiting main requests, Main pause and direct user talk. The team main sees the whole team (or one area); an owner sees its own area and a team summary. Read-only.",
  "detail: true adds the running op and its confirms (numbered for team_control answer), the last op that can be undone and, with area, its last integration with the end of its check log; the team main also gets the accounts, the models in use and the area presets.",
].join("\n")

export const Input = Schema.Struct({
  area: optional(Schema.String.annotate({ description: "Area id, slug or name (team main only). Omit for the team." })),
  detail: optional(
    Schema.Boolean.annotate({ description: "Also ops, confirms, undo, the last integration and accounts." }),
  ),
})

/** The end of a check log `detail` shows. */
export const LOG_TAIL = 2048

/** Other conversations listed at most. */
const OTHERS = 8

/** Folders outside the team listed at most. */
const OUTSIDE = 8

export async function run(
  services: Services.Context,
  caller: MainTools.Caller | OwnerTools.AreaCaller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  const more = async (text: string, area: OwnTeam.Area | undefined) =>
    input.detail === true ? `${text}\n${await details(services, caller, area)}` : withWait(services, caller, text)
  if (caller.role !== "main") {
    const text = await services.features().digest.render({
      teamID: caller.team.id,
      areaID: caller.area.id,
      // 06 §5.8: an owner or a peer also sees the other areas, its asks, watches and the notes held for it.
      viewer: caller.role === "peer" ? { peer: caller.peer.key } : {},
      causes: true,
    })
    return { ok: true, text: await more([text, ...roster(caller.area, "대화", true)].join("\n"), caller.area) }
  }
  if (input.area === undefined) {
    const [text, areas] = await Promise.all([
      services.features().digest.render({ teamID: caller.team.id, causes: true }),
      services.registry.areas.list(caller.team.id),
    ])
    const rosters = areas
      .filter((item) => item.state !== "retired")
      .flatMap((item) => roster(item, `${item.name} 대화`, false))
    const left = outside(caller.team)
    return {
      ok: true,
      text: await more([text, ...rosters, ...(left === undefined ? [] : [left])].join("\n"), undefined),
    }
  }
  const area = await MainTools.area(services, caller.team.id, input.area)
  if (!area) return { ok: false, text: MainTools.NO_AREA }
  const [text, texts, others] = await Promise.all([
    services.features().digest.render({ teamID: caller.team.id, areaID: area.id, causes: true }),
    whole(services, caller.team, area),
    conversations(services, caller.team, area),
  ])
  const lines = [text, ...texts, ...roster(area, "대화", true), ...(others === undefined ? [] : [others])]
  return { ok: true, text: await more(lines.join("\n"), area) }
}

/** How much of the owner's note and of a peer's role the whole-team roster quotes; labels and keys are never cut. */
export const PEER_ROLE_QUOTE = 120

/**
 * `대화: 담당 메모 "화면을 만든다", 리뷰어(reviewer) 역할 "보안 위주로 읽는다"`: who talks with the team in the area, the
 * owner first (`담당` alone without a note), then each peer (2026-10-26, 2026-11-12); nothing for an area without peers.
 * `whole`: the note and the roles on one line but not cut (a view of one area, 2026-11-14).
 */
function roster(area: OwnTeam.Area, head: string, whole: boolean) {
  const peers = area.peers ?? []
  if (peers.length === 0) return []
  const quote = (text: string) => (whole ? flat(text).join("") : clipped(text))
  const note = quote(area.owner.note ?? "")
  const listed = peers.map((peer) => {
    const role = quote(peer.role)
    return role === "" ? `${peer.label}(${peer.key})` : `${peer.label}(${peer.key}) 역할 "${role}"`
  })
  return [`${head}: ${[note === "" ? "담당" : `담당 메모 "${note}"`, ...listed].join(", ")}`]
}

/** On one line and at most {@link PEER_ROLE_QUOTE} code points, the last one `…` when cut. */
function clipped(text: string) {
  const points = flat(text)
  return points.length <= PEER_ROLE_QUOTE ? points.join("") : `${points.slice(0, PEER_ROLE_QUOTE - 1).join("")}…`
}

/** The code points of `text` on one line. */
function flat(text: string) {
  return Array.from(text.replace(/\s+/g, " ").trim())
}

/**
 * The main's view of one area (2026-11-14): the whole texts the update only quotes, read once from KV `report:` and
 * `stretch:` (`report/texts.ts`), newest first: the newest report of each kind of the owner and of each peer, the
 * user's relays, and the reports kept during the current or last direct work (one already printed above is not
 * repeated). Without a readable `report:` value (an area that has not reported since this release) the digest's
 * excerpts, marked `전문 없음`. Texts are escaped (`</` → `<\/`).
 */
async function whole(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area) {
  const [texts, stretch, state] = await Promise.all([
    Texts.load(services.kv, services.log, team.id, area.id),
    Texts.loadStretch(services.kv, services.log, team.id, area.id),
    Digest.load(services.kv, team.id),
  ])
  const reports = texts === undefined ? [] : texts.reports.toSorted((a, b) => b.at - a.at)
  const relays = texts?.relays ?? []
  const shown = (item: Texts.TextItem) =>
    reports.some((report) => report.kind === item.kind && report.at === item.at && report.peer === item.peer)
  // The current or last stretch, and the one handed back before a new one began (kept until that one is handed back).
  const stretches = [stretch, stretch?.previous].filter(
    (item): item is NonNullable<typeof item> => item !== undefined && item.items.length > 0,
  )
  return [
    ...(texts === undefined
      ? excerpts(area, Fold.area(state, area.id))
      : reports.flatMap((item) => [
          `${seat(area, item.peer)} 보고(${item.kind}, ${when(item)}):`,
          escapedText(item.text),
        ])),
    ...(relays.length === 0
      ? []
      : [
          `사용자 부탁(최근 ${relays.length}개):`,
          ...relays.flatMap((item) => [`· ${seat(area, item.peer)}, ${Talk.clock(item.at)}:`, escapedText(item.text)]),
        ]),
    ...(texts?.relaysDropped === undefined
      ? []
      : [`(앞선 부탁 ${texts.relaysDropped}개는 ${Texts.RELAY_CHARS.toLocaleString("en-US")}자를 넘어 남기지 못함)`]),
    ...stretches.flatMap((item) => [
      item.until === undefined
        ? `직접 작업 중 보고 ${item.items.length}개(${Talk.clock(item.since)}부터):`
        : `지난 직접 작업(${Talk.clock(item.since)}~${Talk.clock(item.until)}) 보고 ${item.items.length}개:`,
      ...item.items
        .toReversed()
        .filter((kept) => !shown(kept))
        .flatMap((kept) => [`· ${seat(area, kept.peer)} ${kept.kind}, ${when(kept)}:`, escapedText(kept.text)]),
      ...(item.dropped === undefined
        ? []
        : [
            `(앞선 보고 ${item.dropped}개는 한 번의 직접 작업에 남기는 ${Texts.STRETCH_CHARS.toLocaleString("en-US")}자를 넘어 남기지 못함)`,
          ]),
    ]),
  ]
}

/** The digest's excerpts of the newest report of each kind, when the area's whole texts cannot be read. */
function excerpts(area: OwnTeam.Area, fold: Fold.AreaFold) {
  const of = (reports: Fold.AreaFold["reports"], peer?: string) =>
    Fold.ReportKind.literals.flatMap((kind) => {
      const report = reports[kind]
      return report ? [{ ...report, kind, ...(peer === undefined ? {} : { peer }) }] : []
    })
  const all = [
    ...of(fold.reports),
    ...Object.entries(fold.peers ?? {}).flatMap(([key, peer]) => of(peer.reports, key)),
  ].toSorted((a, b) => b.at - a.at)
  return all.flatMap((item) => [
    `${seat(area, item.peer)} 보고(${item.kind}, ${when(item)})(전문 없음):`,
    escapedText(item.text),
  ])
}

/** `담당`, or `동료 리뷰어(reviewer)`. */
function seat(area: OwnTeam.Area, peer: string | undefined) {
  if (peer === undefined) return "담당"
  const label = (area.peers ?? []).find((item) => item.key === peer)?.label ?? peer
  return `${OwnTeamText.PEER} ${label}(${peer})`
}

/** `2026-11-14 13:02` and the task label when there is one. */
function when(item: { readonly at: number; readonly task?: string }) {
  return `${Talk.clock(item.at)}${item.task === undefined ? "" : ` · ${item.task}`}`
}

/** A whole model or user text: never cut, `</` escaped so no closing tag can end a block around it. */
function escapedText(text: string) {
  return text.replaceAll("</", "<\\/")
}

/**
 * `detail` (06 §2.9): the running op and the confirms it waits for (numbered from 1, as `team_control{action:
 * "answer", step}` takes them; text and size, never a nonce), the last op that can still be undone, and with an area its
 * last integration (state, checks, the end of its log). The main also gets the accounts, the models the team uses and
 * each area's preset; an owner or a peer only what is about its own area.
 */
async function details(
  services: Services.Context,
  caller: MainTools.Caller | OwnerTools.AreaCaller,
  area: OwnTeam.Area | undefined,
) {
  const team = caller.team
  const mine = (op: OwnTeam.Op | undefined) =>
    op !== undefined && (caller.role === "main" || op.areaID === caller.area.id) ? op : undefined
  const [active, ops] = await Promise.all([services.journal.active(team.id), services.journal.list(team.id)])
  const running = mine(active)
  const last = mine(ops.at(-1))
  const undoable = last?.undo?.available === true && last.state !== "running" ? last : undefined
  const pending = running ? Confirm.pending(running) : []
  const areas = running?.areaID === undefined ? [] : await services.registry.areas.list(team.id)
  const lines = [
    "자세히:",
    running ? opLine(running, areas, services.clock.now(), services.status.controller()) : "- 지금 도는 작업: 없음",
    ...pending.map(
      (item, index) =>
        `  ${index + 1}. ${item.text}${Targets.size(item)} · ${OpWords.minutes(item.expiresAt - Confirm.TTL_MS, services.clock.now())}`,
    ),
    undoable
      ? `- 되돌릴 수 있는 마지막 작업: ${Targets.opWord(undoable.kind)} (${undoable.id})`
      : "- 되돌릴 수 있는 마지막 작업: 없음",
    ...(area === undefined ? [] : await integration(services, team, area)),
    ...(caller.role === "main" ? await accounts(services, team) : []),
    ...(caller.role === "main" && area === undefined ? await outsideDetail(team) : []),
  ]
  return lines.join("\n")
}

/**
 * RH-20: without `detail`, an op that waits (a step's wait, or only confirms) still gets its line, so the main reads why
 * it waits instead of `도는 중`.
 */
async function withWait(services: Services.Context, caller: MainTools.Caller | OwnerTools.AreaCaller, text: string) {
  const op = await services.journal.active(caller.team.id)
  if (!op || (caller.role !== "main" && op.areaID !== caller.area.id)) return text
  const waits = op.state === "waiting" || op.steps.some((step) => step.state === "pending" && step.wait !== undefined)
  const controller = services.status.controller()
  if (!waits && controller.state !== "lock") return text
  const areas = op.areaID === undefined ? [] : await services.registry.areas.list(caller.team.id)
  return `${text}\n${opLine(op, areas, services.clock.now(), controller)}`
}

/** A wait this long tells the main to tell the user instead of looking again (RH-20). */
export const TELL_MS = 5 * 60_000

/**
 * RH-20: `- 지금 도는 작업: 새 대화로 이어가기 · 'api' (op_…) · 1/5 영역이 쉬기를 기다림 · 17분째 · 기다리는 것: … · 할 수
 * 있는 것: 사용자에게 [명령 멈추고 진행]이나 [취소]를 부탁하세요`: the step, what it waits for and since when, and what
 * the user can do; past {@link TELL_MS} the main tells the user instead of polling.
 */
export function opLine(
  op: OwnTeam.Op,
  areas: ReadonlyArray<OwnTeam.Area>,
  now: number,
  controller: OwnTeam.Controller,
) {
  const area = op.areaID === undefined ? undefined : areas.find((item) => item.id === op.areaID)
  const index = op.steps.findIndex((step) => step.state === "pending" || step.state === "needs_confirm")
  const step = index < 0 ? undefined : op.steps[index]
  const head = [OpWords.of(op.kind), ...(area ? [`'${area.name}'`] : [])].join(" · ")
  const confirms = op.steps.filter((item) => item.state === "needs_confirm")
  const parts = [
    `${head} (${op.id})`,
    ...(step
      ? [
          `${index + 1}/${op.steps.length} ${step.wait ? OpWords.waiting(step.wait.why) : op.state === "waiting" ? "확인 기다림" : "도는 중"}`,
        ]
      : []),
  ]
  const wait = step?.wait
  const since =
    wait?.since ??
    (op.state === "waiting" ? confirms[0]?.confirm && confirms[0].confirm.expiresAt - Confirm.TTL_MS : step?.startedAt)
  const lock =
    controller.state === "lock"
      ? [`팀 서비스를 다른 프로세스(pid ${controller.holder?.pid ?? "?"})가 잡고 있어 멈춰 있음`]
      : []
  const long = since !== undefined && now - since >= TELL_MS
  const tail = [
    ...(since === undefined ? [] : [OpWords.minutes(since, now)]),
    ...(wait ? [`기다리는 것: ${wait.text}`] : []),
    ...(wait?.actions && wait.actions.length > 0
      ? [`할 수 있는 것: 사용자에게 ${OpWords.actions(wait.actions)} 부탁하세요`]
      : op.state === "waiting" && confirms.length > 0
        ? ["할 수 있는 것: 사용자에게 확인에 답하거나 [취소]를 부탁하세요"]
        : []),
    ...lock,
    ...(long ? ["5분 넘게 기다리고 있어요. team_status를 다시 부르지 말고 사용자에게 알리세요"] : []),
  ]
  return `- 지금 도는 작업: ${[...parts, ...tail].join(" · ")}`
}

/** `팀 밖 작업 폴더 2개(팀에 넣으려면 …): D:/work/feat, …` (8.1); `undefined` when every folder is in the team. */
function outside(team: OwnTeam.Team) {
  const left = team.external.filter((item) => item.why === "left")
  if (left.length === 0) return undefined
  const listed = left.slice(0, OUTSIDE).map((item) => item.directory)
  const more = left.length - listed.length
  return `팀 밖 작업 폴더 ${left.length}개(팀에 넣으려면 team_reorganize의 areas[{slug, name, adopt: {worktree}}]): ${listed.join(", ")}${more > 0 ? ` 외 ${more}개` : ""}`
}

/** With `detail`: each folder outside the team with its changes and the commits the target lacks (one inventory). */
async function outsideDetail(team: OwnTeam.Team) {
  const left = team.external.filter((item) => item.why === "left").slice(0, OUTSIDE)
  if (left.length === 0) return []
  const inventory = await Inventory.collect(team.commonDir, team.target, [])
  if (!inventory.ok) return ["- 팀 밖 작업 폴더: git으로 읽지 못함"]
  return left.map((item) => {
    const found = inventory.worktrees.find((entry) => Classify.same(entry.path, item.directory))
    return found === undefined
      ? `- 팀 밖 작업 폴더 ${item.directory}: 찾지 못함`
      : `- 팀 밖 작업 폴더 ${item.directory}: 줄기 ${found.branch ?? "없음"} · 변경 ${found.changes?.uncommitted ?? 0} · 대상에 없는 커밋 ${found.ahead ?? 0}`
  })
}

/** The area's last integration: state, checks and the end of the code check's log. */
async function integration(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area) {
  const last = (await IntegrateOp.list(services, team.id)).findLast((item) => item.areaID === area.id)
  if (!last) return [`- ${area.name}의 마지막 반영: 없음`]
  const code = last.verify.code && (await Verify.withLog(Teams.records(team), last.verify.code))
  const checks =
    code === undefined
      ? "검사 기록 없음"
      : code.ok
        ? "검사 통과"
        : `검사 실패${code.failed === undefined ? "" : `: ${code.failed}`}`
  const tail = code?.log === undefined || code.log === "" ? [] : ["  검사 로그 끝:", code.log.slice(-LOG_TAIL)]
  return [
    `- ${area.name}의 마지막 반영: ${STATES[last.state]}${last.failure === undefined ? "" : `(${last.failure})`} · ${checks} (${last.id})`,
    ...tail,
  ]
}

const STATES: { readonly [K in OwnTeam.IntegrationState]: string } = {
  running: "도는 중",
  waiting: "기다림",
  conflict: "겹친 변경",
  failed: "실패",
  done: "반영됨",
  undone: "되돌림",
}

/** The team main's extra lines: own.accounts' accounts, the models in use and each area's preset. */
async function accounts(services: Services.Context, team: OwnTeam.Team) {
  const [listed, presets, used, areas] = await Promise.all([
    services.accounts.accountsList(),
    services.accounts.presetsList({}),
    Targets.inUse(services, team),
    services.registry.areas.list(team.id),
  ])
  const names = new Map(
    (presets.ok ? presets.value.groups : []).flatMap((row) =>
      (row.presets ?? []).map((preset) => [String(preset.id), preset.name] as const),
    ),
  )
  const views = listed.ok
    ? listed.value.accounts.map((account) => `${account.label}(${account.providerID}, ${account.billing})`)
    : undefined
  const active = areas.filter((item) => item.state !== "retired")
  return [
    `- 계정: ${views === undefined ? "읽지 못함" : views.join(", ") || "없음"}`,
    `- 팀이 쓰는 모델: ${used.join(", ") || "알 수 없음"}`,
    `- 영역 프리셋: ${active.map((item) => `${item.name} → ${names.get(item.preset) ?? item.preset}`).join(", ") || "없음"}`,
  ]
}

/**
 * `이 영역의 다른 대화(동료로 등록되지 않음): "제목"(ses_abc123), "옛 제목"(ses_def456, 전 담당), …`: root conversations
 * of the area's folder that are not its owner or a peer, newest first; `undefined` when there is none (or the service
 * cannot say). A conversation that was the owner before is listed with `전 담당` unless it is archived (a rotation
 * archives the one it replaces; a seat move does not), so the main can name it to seat it again.
 */
async function conversations(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area) {
  const listed = await services.http.session.list({
    directory: area.directory,
    parentID: null,
    order: "desc",
    limit: OTHERS + 8,
  })
  if (!listed.ok) return undefined
  const known = new Set<string>([
    team.main.sessionID,
    ...(area.owner.sessionID === null ? [] : [area.owner.sessionID]),
    ...(area.peers ?? []).map((peer) => peer.sessionID),
  ])
  const previous = new Set<string>(area.owner.previous.map((item) => item.sessionID))
  const placed = await Promise.all(
    listed.value.data
      .filter(
        (session) =>
          !known.has(session.id) &&
          (!previous.has(session.id) ||
            (session.metadata?.[Undo.ARCHIVED] === undefined && session.time.archived === undefined)),
      )
      .map(async (session) => {
        // A subfolder that is another area (nested) is that area's.
        const place = await services.locate.directory(session.location.directory)
        return place?.area?.id === area.id ? [session] : []
      }),
  )
  const all = placed.flat()
  const others = all.slice(0, OTHERS)
  if (others.length === 0) return undefined
  const named = others.map(
    (session) =>
      `"${(session.title ?? "제목 없음").replace(/\s+/g, " ").slice(0, 60)}"(${session.id.slice(0, 12)}${previous.has(session.id) ? ", 전 담당" : ""})`,
  )
  const more = all.length - others.length
  return `이 영역의 다른 대화(동료로 등록되지 않음): ${named.join(", ")}${more > 0 ? ` 외 ${more}개` : ""}`
}
