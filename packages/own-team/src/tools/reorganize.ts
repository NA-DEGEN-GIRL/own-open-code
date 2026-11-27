export * as ReorganizeTool from "./reorganize.js"

import { Result, Schema, SchemaIssue } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { JudgeValidate } from "../judge/validate.js"
import { AreaCreate } from "../ops/area-create.js"
import { ReorgOps } from "../ops/reorg.js"
import { ReorgPlan } from "../reorg/plan.js"
import { Digest } from "../report/digest.js"
import type { Services } from "../services.js"
import { MainTools } from "./main.js"
import { VoicePlan } from "./voice.js"

/**
 * `team_reorganize{proposal}` (06 §2.8, §8.1): the main proposes structural changes (a 3.4 proposal with `ops` and
 * `areas[].adopt`); the program validates and plans them (`ops/reorg.ts`, `reorg/plan.ts`) and runs them by `main`:
 * the steps that delete nothing at once, confirm steps (a folder removal, a download, a WIP commit) waiting for the
 * user. Actions on an area under Main 멈춤, held by direct work or still working are skipped (TI-9, TI-13), and a
 * conversation move becomes
 * a suggestion (V11: the user's action only). A proposal that ends an area (`retire`, no undo) answers a plan
 * (`tools/voice.ts`, V-f of 06 §2.9) and runs, the whole proposal, by the user after the user's next message (`token`).
 * So does one that renames, splits, merges (either side), converts or ends an area the user set up (`Area.userMade`,
 * V-b (5), 2026-10-26), or makes one again from a stopped or finished one (다시 만들기, which carries the mark), and the
 * work inside those areas (requests, the other areas' changes) stays the main's. Since 2026-10-27 the plan lists every
 * item of the proposal in plain words, not only those changes, and the proposal stays the main's when the user's run
 * applies it (`author: "main"`): what only the user sets (a new area's own model and 에이전트 방식, the user-made mark of
 * an adopted area) is dropped, and a conversation move stays a suggestion (V11), each said on its line. The
 * answer comes once each item's folder, record and owner are done (setup commands go on), or after {@link WAIT_MS}:
 * `{applied, pending, skipped, rejected:[{item, why}]}`. Team main only. It never throws: every answer, a failure
 * included, carries the four lists.
 *
 * 2026-10-16 (06 §8.1, §6.3 상의하고 나누기): `preview: true` plans the proposal (`ReorgPlan.build`, which writes nothing)
 * and answers in plain Korean what applying it now would do: new folders, confirms, what would be skipped or refused.
 * No token, no op: the main shows the options to the user and calls again without `preview` once the user agrees. A
 * proposal with a retire is previewed as the user's run it would become (no busy skips; its plan comes first), and a
 * second dry plan as the main's run names the items whose area is working or under Main 멈춤: the user's run waits for
 * such an area and holds the team's one op slot meanwhile (TC-D3). An applied answer names each skipped area and its
 * reason and tells the main to tell the user, who can redo a skip planned away from the card (`[다시 하기]`, the
 * user's own action that waits for the area's safe point); a skip when the item ran has no such button.
 *
 * 2026-11-14 (no area limit, AL-1, AL-3): a proposal that makes more than {@link JudgeValidate.BATCH} new areas at once
 * (`new`, `split`, `areas[].create`) plans first too, its first line naming them all ({@link PLAN_MANY}). A `new` op
 * with `userMade: true` (a standing role the user asked to keep, AL-9) makes the area the user's (내가 정한 영역).
 *
 * 2026-11-17 (L12): a `rename` that reuses an area for a standing role the user named carries its whole new role
 * (`goal`) and the mark (`userMade: true`) with it; the plan's first line counts those areas apart from the new ones
 * ({@link PLAN_MANY}) and their lines say so ({@link MINE}, {@link ROLE}). An area kept as it is gets the mark from
 * `team_area{keep}`.
 */

export const NAME = "reorganize"

export const DESCRIPTION = [
  'Change the team structure with a proposal {version: 1, ops?: [...], areas?: [...], suggest?: [...], notes?}. ops: {op: "new", slug, name, goal?, from?, userMade?} makes a new area (from = "main" or another area; userMade: true when the user wants it kept as a standing role: it is marked as the user\'s area, is never suggested for ending, and its later structure changes wait for the user); {op: "rename", area, name, subtitle?, goal?, userMade?} renames an area (goal: its whole new role when it is reused for another purpose, always with such a rename; userMade: true as on new when the user wants it kept as a standing role); {op: "split", area, slug, name, goal?} starts a new area at an area\'s tip with its handoff; {op: "merge", area, from} merges area `from` into `area`; {op: "retire", area} ends an area (its branch and conversations stay); {op: "convert", area, shape: "code" | "full"}. areas: [{slug, name, adopt: {worktree}}] adopts a work folder not in the team yet. Only the user moves a conversation: put it in suggest. Folder removals and large downloads wait for the user\'s confirm; areas under Main 멈춤 or still working are skipped. Result: {applied, pending, skipped, rejected:[{item, why}]}.',
  "preview: true only checks the proposal and answers what applying it now would do (new folders, confirms, what would be skipped or refused); nothing changes and no token is given.",
].join("\n")

export const Input = Schema.Struct({
  proposal: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "A team proposal: {version: 1, ops?: [...], areas?: [...], suggest?: [...], notes?}.",
  }),
  preview: optional(
    Schema.Boolean.annotate({
      description: "true: only check the proposal and say what applying it now would do; nothing changes.",
    }),
  ),
  token: optional(Schema.String),
})

/**
 * The plan's action name, the same for its issue and its redeem: a proposal the user's next message runs (one that
 * ends an area, or changes the structure of an area the user set up).
 */
const APPLY = "apply"

/** How long the answer waits for the folders and owners (setup commands are not waited for). */
export const WAIT_MS = 90_000

export const FAILED = "재구성을 하지 못했습니다. 잠시 뒤 다시 부르세요."

/** A pending item that waits for the user's confirm (a removal, a download). */
const CONFIRM = "확인 기다림"

export const PREVIEW_HEAD = "미리 보기입니다. 아무것도 바꾸지 않았습니다."
export const PREVIEW_BUSY = "지금 팀에 다른 작업이 진행 중이라 그 작업이 끝나야 적용할 수 있습니다."
export const PREVIEW_RETIRE = "끝내기가 들어 있어 적용하면 먼저 계획을 보이고 사용자의 다음 답을 받습니다."
/** A preview that makes more than `JudgeValidate.BATCH` new areas at once (AL-3, 2026-11-14): applying it plans first. */
export const PREVIEW_MANY = (count: number) =>
  `새 영역 ${count}개를 한 번에 만들어 적용하면 먼저 계획을 보이고 사용자의 다음 답을 받습니다.`
/**
 * The first line of the plan of a proposal that makes more than `JudgeValidate.BATCH` new areas at once (AL-3); `mine`:
 * how many of them become the user's (`userMade: true`); `reused`: the areas the team has that a rename makes the
 * user's (2026-11-17), by their new names.
 */
export const PLAN_MANY = (names: ReadonlyArray<string>, mine: number, reused: ReadonlyArray<string> = []) =>
  `새 영역 ${names.length}개를 한 번에 만듭니다: ${names.join(", ")}. 영역마다 작업 폴더와 담당 대화가 생기고 설치 명령이 돕니다.${mine > 0 ? ` 그중 ${mine}개는 사용자가 정한 영역이 됩니다.` : ""}${reused.length > 0 ? ` 이름을 바꿔 다시 쓰는 영역 ${reused.map((area) => `'${area}'`).join(", ")}도 사용자가 정한 영역이 됩니다.` : ""}`
/** A preview that changes an area the user set up (V-b (5), 2026-10-26): applying it plans first too. */
export const PREVIEW_USER_MADE = (areas: ReadonlyArray<string>) =>
  `사용자가 정한 영역 ${areas.map((area) => `'${area}'`).join(", ")}을(를) 바꾸므로 적용하면 먼저 계획을 보이고 사용자의 다음 답을 받습니다.`
/** The first line of the plan of a proposal that changes an area the user set up. */
export const PLAN_USER_MADE = (areas: ReadonlyArray<string>) =>
  `사용자가 정한 영역 ${areas.map((area) => `'${area}'`).join(", ")}의 구성을 바꿉니다.`
/** Before the plan's item lines (2026-10-27): the user's yes runs every one of them, not only the changes named above. */
export const PLAN_ITEMS = "적용하면 이 제안의 항목을 모두 합니다:"
/** A line's tail: what only the user sets, which the main wrote and the run leaves out (2026-10-27). */
export const DROPPED = (fields: ReadonlyArray<string>) => ` · ${fields.join(", ")}은(는) 사용자만 정해서 쓰지 않습니다`
/** A line's tail: 다시 만들기 of a stopped or finished area the user set up carries its mark (V-b (5), 2026-10-27). */
export const CARRIED = " · 사용자가 정한 영역 표시를 이어 받습니다"
/**
 * A line's tail: the main's new area for a standing role the user asked to keep (`userMade: true`, 2026-11-14), or an
 * area the team has that its rename makes the user's (2026-11-17).
 */
export const MINE = " · 사용자가 정한 영역이 됩니다"
/** A rename line's tail: the whole new role it carries (2026-11-17). */
export const ROLE = (goal: string) => ` · 역할도 바꿉니다: "${goal}"`
/** A plan's line of a conversation move the main proposed: never run (V11), on the result card as a suggestion. */
export const PLAN_MOVE = " · 대화 옮기기는 사용자만 해서 하지 않고, 결과 카드에 제안으로 올립니다"
export const PREVIEW_NEXT =
  "사용자와 정한 뒤 preview 없이 같은 proposal로 부르세요. 사용자가 고친 것이 있으면 proposal을 고쳐 다시 미리 보세요."
export const NOTHING = "적용할 수 있는 항목이 없습니다."
/** After an applied answer whose card offers `[다시 하기]`: a Main 멈춤 or busy skip at planning (06 §8.1, 2026-10-16). */
export const SKIPPED_NEXT =
  "건너뛴 것은 사용자에게 알리세요. 그 영역이 쉴 때 다시 부르거나, 사용자가 팀 메인 위 카드의 [다시 하기]를 누르면 됩니다."
/** After an applied answer with only skips when the items ran (their card lines have no `[다시 하기]`). */
export const SKIPPED_LATER = "건너뛴 것은 사용자에게 알리세요. 그 영역이 쉴 때 다시 부르세요."
/** A skip when the item ran whose card line names no reason (its area left the team meanwhile, …). */
const RAN_SKIPPED = "실행할 때 건너뜀"
/** A by-user preview's item on an area that is working now: it waits and holds the team's other work meanwhile. */
export const PREVIEW_WAITS = (area: string) =>
  `- '${area}'에서 일하는 중이라 그 영역이 쉴 때 하고, 그동안 팀의 다른 일(메인 요청, 반영)이 기다립니다`
/** A by-user preview's item on a Main 멈춤 area: the user's run goes on there. */
export const PREVIEW_PAUSED = (area: string) =>
  `- '${area}'은(는) 메인 멈춤이지만 사용자의 실행이라 그대로 합니다. 그 영역이 일하는 중이면 쉴 때까지 팀의 다른 일이 기다립니다`

const decode = Schema.decodeUnknownResult(OwnTeam.Proposal)

type Entry = Readonly<Record<string, string>>

type Outcome =
  | { readonly kind: "applied" | "pending" | "skipped"; readonly entry: Entry }
  | { readonly kind: "rejected"; readonly rejected: OwnTeam.Rejected }

export function run(
  services: Services.Context,
  caller: MainTools.Caller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  return reorganize(services, caller, input).catch((error: unknown) => {
    services.log.warn("team_reorganize_failed", { teamID: caller.team.id, error })
    return { ok: false, text: FAILED, ...lists({}) }
  })
}

async function reorganize(
  services: Services.Context,
  caller: MainTools.Caller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  const voice = { sessionID: caller.sessionID, directory: caller.team.home.directory }
  if (input.token !== undefined)
    return VoicePlan.redeem(services, voice, { tool: NAME, action: APPLY, token: input.token })
  const proposal = decode(input.proposal)
  if (Result.isFailure(proposal)) {
    const why = SchemaIssue.makeFormatterDefault()(proposal.failure.issue)
    return { ok: false, text: `제안을 읽지 못했습니다: ${why}`, ...lists({ rejected: [{ item: "proposal", why }] }) }
  }
  const ops = proposal.success.ops ?? []
  const retiring = ops.flatMap((op, index) => (op.op === "retire" ? [{ item: `ops/${index}`, area: op.area }] : []))
  const touched = await userMade(services, caller.team.id, proposal.success)
  const made = madeOf(proposal.success)
  const asks = {
    retire: retiring.length > 0,
    userMade: [...new Set(touched.flatMap((entry) => entry.areas))],
    many: made.names.length > JudgeValidate.BATCH ? made.names.length : 0,
    // Items that change a user-made area; a new one among them is 다시 만들기, which carries the mark.
    carries: new Set(touched.map((entry) => entry.item)),
  }
  // A proposal that plans first runs by the user after its plan, so it is previewed that way (no busy skips).
  if (input.preview === true)
    return preview(
      services,
      caller,
      proposal.success,
      asks.retire || asks.userMade.length > 0 || asks.many > 0 ? "user" : "main",
      asks,
    )
  // V-f and V-b (5) (06 §2.9): ending an area has no undo, and an area the user set up is the user's to restructure,
  // so the proposal waits for the user's answer, the whole proposal with it: the plan lists every item, since the
  // user's yes runs them all (2026-10-27). So does one that makes many areas at once (AL-3, 2026-11-14).
  if (asks.retire || touched.length > 0 || asks.many > 0) {
    // A retire says what it does on its own line; the other changes of user-made areas are named in the lead.
    const changing = touched.filter((entry) => !retiring.some((retire) => retire.item === entry.item))
    const changes = [
      ...(changing.length > 0 ? [PLAN_USER_MADE([...new Set(changing.flatMap((entry) => entry.areas))])] : []),
      PLAN_ITEMS,
      ...(await planLines(services, caller, proposal.success, asks.carries)),
    ]
    return VoicePlan.issue(services, voice, {
      tool: NAME,
      action: APPLY,
      method: "reorg.apply",
      text: [
        ...(asks.many > 0 ? [PLAN_MANY(made.names, made.mine, made.reused)] : []),
        ...(asks.retire
          ? [
              `영역 ${retiring.map((entry) => entry.area).join(", ")}을(를) 끝냅니다. 끝낸 영역의 작업 폴더는 지우기 전에 따로 확인을 받고, 저장 지점과 대화는 남습니다. 영역 끝내기는 되돌릴 수 없습니다.`,
            ]
          : []),
        ...changes,
      ].join("\n"),
      run: () => applied(services, caller, proposal.success, "user"),
    })
  }
  return applied(services, caller, proposal.success, "main")
}

/**
 * The proposal's actions that change the structure of an area the user set up (`Area.userMade`, V-b (5)): a rename,
 * split, conversion or retire of one, or a merge with one on either side, among the areas that are not finished; and
 * 다시 만들기 from a stopped or finished one (`ops[]` `new` or `areas[].create` with it as `from`, 2026-10-27: the
 * V-rules make both the same new area), which carries its mark. Areas are named as the V-rules name them (id, slug or
 * name), a live one first. A `from` naming a new area made earlier in the proposal (`ops`, then `areas`, as the
 * V-rules read them) starts where that one starts, as `reorg/plan.ts` plans it: from main it is no 다시 만들기.
 */
async function userMade(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
  proposal: OwnTeam.Proposal,
): Promise<ReadonlyArray<{ readonly item: string; readonly areas: ReadonlyArray<string> }>> {
  const all = await services.registry.areas.list(teamID)
  const live = all.filter((area) => area.state !== "retired")
  const named = (name: string) => (area: OwnTeam.Area) =>
    area.id === name || area.id === `ar_${name}` || area.name === name
  // A new area's slug → where it starts: `main` or an area as the proposal names it.
  const starts = new Map<string, string>()
  const again = (item: string, slug: string, from: string | undefined) => {
    const written = from?.trim() ?? ""
    const start = written === "" || written === "main" ? "main" : (starts.get(written) ?? written)
    starts.set(slug, start)
    const source = start === "main" ? undefined : (live.find(named(start)) ?? all.find(named(start)))
    return source?.userMade !== undefined && source.state !== "active" ? [{ item, areas: [source.name] }] : []
  }
  const ops = (proposal.ops ?? []).flatMap((op, index) => {
    const item = `ops/${index}`
    if (op.op === "new") return again(item, op.slug, op.from)
    if (op.op === "split") starts.set(op.slug, op.area)
    const names = op.op === "merge" ? [op.area, op.from] : op.op === "move" ? [] : [op.area]
    const marked = names.flatMap((name) => {
      const area = live.find(named(name))
      return area?.userMade === undefined ? [] : [area.name]
    })
    return marked.length === 0 ? [] : [{ item, areas: marked }]
  })
  const areas = (proposal.areas ?? []).flatMap((area, index) =>
    area.create ? again(`areas/${index}`, area.slug, area.create.from) : [],
  )
  return [...ops, ...areas]
}

/**
 * The new areas a proposal makes (`new` and `split` ops, then `areas[].create`) by name, how many of them the main
 * marks as the user's (`userMade: true` on a `new` op or a created area, AL-9), and the renamed areas it marks
 * (`reused`, by their new names, 2026-11-17). The V-rules may still refuse some: the plan's item lines say which.
 */
function madeOf(proposal: OwnTeam.Proposal) {
  const ops = (proposal.ops ?? []).flatMap((op) =>
    op.op === "new" || op.op === "split" ? [{ name: op.name, mine: op.op === "new" && op.userMade === true }] : [],
  )
  const areas = (proposal.areas ?? []).flatMap((area) =>
    area.create ? [{ name: area.name, mine: area.userMade === true }] : [],
  )
  const all = [...ops, ...areas]
  const reused = (proposal.ops ?? []).flatMap((op) => (op.op === "rename" && op.userMade === true ? [op.name] : []))
  return { names: all.map((entry) => entry.name), mine: all.filter((entry) => entry.mine).length, reused }
}

/**
 * The plan's line for every item of the proposal (06 §2.9 V-b (5), 2026-10-27: the user's yes runs them all), worded
 * as {@link preview} words them (`- '아이템 에셋'을(를) '몬스터 에셋'에 묶습니다`) from a dry plan of the user's run of the
 * main's proposal (nothing is written), in proposal order. What the run leaves out (what only the user sets, a
 * conversation move) and an item it would refuse or skip are said on the item's line; then what is no item (a
 * `heavy` list, …) and the suggestions the card shows.
 */
async function planLines(
  services: Services.Context,
  caller: MainTools.Caller,
  proposal: OwnTeam.Proposal,
  carries: ReadonlySet<string>,
) {
  const [built, areas] = await Promise.all([
    ReorgPlan.build(services, { team: caller.team, proposal, by: "user", author: "main" }),
    services.registry.areas.list(caller.team.id),
  ])
  const name = nameOf(areas)
  const items = [
    ...(proposal.ops ?? []).map((_, index) => `ops/${index}`),
    ...(proposal.areas ?? []).map((_, index) => `areas/${index}`),
  ]
  if (!built.ok) return items.map((item) => `- ${words(proposal, item, name)}`)
  const lines = items.map((item) => {
    const said = `- ${words(proposal, item, name)}`
    const planned = built.items.find((entry) => entry.item === item)
    if (planned) return itemLine(built, proposal, planned, name, carries)
    const skipped = built.skipped.find((entry) => entry.item === item)
    if (skipped) return `${said} · 하지 않음: ${skipped.text}`
    const refused = built.rejected.find((entry) => entry.item === item)
    if (refused?.why === JudgeValidate.MOVE_REFUSED) return `${said}${PLAN_MOVE}`
    return refused === undefined ? said : `${said} · 하지 않음: ${refused.why}`
  })
  const listed = new Set(items)
  const moves = built.rejected.filter((entry) => entry.why === JudgeValidate.MOVE_REFUSED).length
  const suggested = built.lines.filter((line) => line.kind === "suggest").length - moves
  return [
    ...lines,
    ...built.rejected
      .filter((entry) => !listed.has(entry.item))
      .map((entry) => `- 하지 않음(${entry.item}): ${entry.why}`),
    ...(suggested > 0 ? [`- 제안 ${suggested}개는 적용할 때 사용자에게 카드로 보입니다`] : []),
  ]
}

/** Applies the proposal by `by` and answers once its items are done (or {@link WAIT_MS} passed). */
async function applied(
  services: Services.Context,
  caller: MainTools.Caller,
  proposal: OwnTeam.Proposal,
  by: OwnTeam.Op["by"],
): Promise<MainTools.Reply> {
  // The proposal stays the main's when the user's yes runs it (V-f, V-b (5)): what only the user sets stays out of it
  // and its conversation moves stay suggestions (2026-10-27).
  const started = await ReorgOps.apply(services, { teamID: caller.team.id, proposal, by, author: "main" })
  if (!started.ok) {
    if (started.error === "invalid_proposal")
      return { ok: false, text: NOTHING, ...lists({ rejected: started.data.rejected }) }
    if (started.error === "busy")
      return { ok: false, text: "팀에 다른 작업이 진행 중입니다. 끝난 뒤 다시 부르세요.", ...lists({}) }
    return { ...MainTools.answer(started), ...lists({}) }
  }
  const op = await ReorgOps.settle(services, started, WAIT_MS)
  const results = started.items.map((item) => outcome(op, item))
  const of = (kind: "applied" | "pending" | "skipped") =>
    results.flatMap((result) => (result.kind === kind ? [result.entry] : []))
  const applied = of("applied")
  const pending = of("pending")
  const lines = op.summary?.lines ?? []
  // Skipped when it ran (its area got busy or paused by then): the card line's reason, never the step's own note,
  // which may be English (`the area is gone`).
  const ran = of("skipped").map((entry): Entry => {
    const line = lines.find((item) => item.kind === "skipped" && item.item === entry.item)
    const word = line?.kind === "skipped" ? Digest.SKIP_WORDS[line.why] : undefined
    return { ...entry, why: word ?? RAN_SKIPPED }
  })
  const skipped = [
    ...started.skipped.map((entry) => ({
      item: entry.item,
      ...(entry.areaID === undefined ? {} : { area: entry.areaID.slice("ar_".length) }),
      why: entry.text,
    })),
    ...ran,
  ]
  const rejected = [
    ...started.rejected,
    ...results.flatMap((result) => (result.kind === "rejected" ? [result.rejected] : [])),
  ]
  const suggested = lines.filter((line) => line.kind === "suggest").length
  // 8.1 (2026-10-16): each skip by its area and reason, so the main can tell the user what did not happen.
  const areas = await services.registry.areas.list(caller.team.id)
  const named = (areaID: string | undefined) => areas.find((area) => area.id === areaID)?.name
  const reasons = [
    ...started.skipped.map((entry) => {
      const area = named(entry.areaID)
      const word = Digest.SKIP_WORDS[entry.why]
      return area === undefined || word === undefined ? entry.text : `'${area}' ${word}`
    }),
    ...ran.map((entry) => `'${named(`ar_${entry.area}`) ?? entry.area}' ${entry.why}`),
  ]
  // The card offers `[다시 하기]` only on a skip planned away for Main 멈춤 or work, which carries its `ops/N` action
  // (`ReorgPlan.build`); a skip when the item ran has no such line.
  const redo = started.skipped.some(
    (entry) => (entry.why === "paused" || entry.why === "busy") && entry.item.startsWith("ops/"),
  )
  return {
    ok: applied.length + pending.length > 0,
    text: [
      applied.length > 0 ? `적용함 ${applied.length}개` : "",
      pending.length > 0 ? `진행 중 ${pending.length}개` : "",
      skipped.length > 0 ? `건너뜀 ${skipped.length}개(${reasons.join(", ")})` : "",
      rejected.length > 0 ? `거절 ${rejected.length}개` : "",
      suggested > 0 ? `제안 ${suggested}개는 사용자에게 카드로 보였습니다` : "",
      applied.some((entry) => entry.state === "preparing") ? "새 영역의 준비 명령은 뒤에서 이어집니다." : "",
      pending.some((entry) => entry.why === CONFIRM) ? "확인 단계는 사용자가 고를 때까지 기다립니다." : "",
      redo ? SKIPPED_NEXT : ran.length > 0 ? SKIPPED_LATER : "",
    ]
      .filter(Boolean)
      .join(" · "),
    opID: op.id,
    ...lists({ applied, pending, skipped, rejected }),
  }
}

/**
 * `preview: true` (06 §8.1, 2026-10-16): what applying the proposal by `by` would do now, in plain Korean, from a dry
 * plan. Nothing is written and no token is given.
 */
async function preview(
  services: Services.Context,
  caller: MainTools.Caller,
  proposal: OwnTeam.Proposal,
  by: OwnTeam.Op["by"],
  asks: {
    readonly retire: boolean
    readonly userMade: ReadonlyArray<string>
    readonly many: number
    readonly carries: ReadonlySet<string>
  },
): Promise<MainTools.Reply> {
  const [built, areas, active, unwaited] = await Promise.all([
    ReorgPlan.build(services, { team: caller.team, proposal, by, author: "main" }),
    services.registry.areas.list(caller.team.id),
    services.journal.active(caller.team.id),
    // The user's run skips no area: the same plan as the main's run names the items that would wait for theirs.
    by === "user" ? ReorgPlan.build(services, { team: caller.team, proposal, by: "main" }) : undefined,
  ])
  if (!built.ok) return { ...MainTools.answer(built), preview: true, planned: [], ...lists({}) }
  const name = nameOf(areas)
  const confirms = (item: ReorgPlan.Item) => item.steps.some((index) => built.steps[index]?.mode === "confirm")
  const planned = built.items.map((item) => ({
    item: item.item,
    action: item.action,
    area: item.areaID.slice("ar_".length),
    confirm: confirms(item),
    folder: item.action === "new" || item.action === "split",
  }))
  const skipped = built.skipped.map((entry) => ({
    item: entry.item,
    ...(entry.areaID === undefined ? {} : { area: entry.areaID.slice("ar_".length) }),
    why: Digest.SKIP_WORDS[entry.why] ?? entry.text,
  }))
  const suggested = built.lines.filter((line) => line.kind === "suggest").length
  const tail = [
    ...built.rejected.map((entry) => `- 하지 않음(${entry.item}): ${entry.why}`),
    ...(suggested > 0 ? [`- 제안 ${suggested}개는 적용할 때 사용자에게 카드로 보입니다`] : []),
  ]
  const answer = { preview: true, planned, ...lists({ skipped, rejected: built.rejected }) }
  if (planned.length + skipped.length === 0) return { ok: false, text: [NOTHING, ...tail].join("\n"), ...answer }
  const lines = built.items.map((item) => itemLine(built, proposal, item, name, asks.carries))
  const waits = (unwaited?.ok ? unwaited.skipped : []).flatMap((entry) => {
    const area = entry.areaID === undefined ? undefined : areas.find((item) => item.id === entry.areaID)?.name
    if (area === undefined) return []
    if (entry.why === "busy") return [PREVIEW_WAITS(area)]
    return entry.why === "paused" ? [PREVIEW_PAUSED(area)] : []
  })
  const skips = built.skipped.map((entry) => {
    const area = entry.areaID === undefined ? undefined : areas.find((item) => item.id === entry.areaID)?.name
    const word = Digest.SKIP_WORDS[entry.why]
    return area === undefined || word === undefined
      ? `- 지금 하면 건너뜀: ${entry.text}`
      : `- 지금 하면 건너뜀: '${area}'(${word})`
  })
  return {
    ok: true,
    text: [
      PREVIEW_HEAD,
      ...lines,
      ...new Set(waits),
      ...skips,
      ...tail,
      ...(active ? [PREVIEW_BUSY] : []),
      ...(asks.retire ? [PREVIEW_RETIRE] : []),
      ...(asks.many > 0 ? [PREVIEW_MANY(asks.many)] : []),
      ...(asks.userMade.length > 0 ? [PREVIEW_USER_MADE(asks.userMade)] : []),
      PREVIEW_NEXT,
    ].join("\n"),
    ...answer,
  }
}

/**
 * `- <words> · 새 작업 폴더 · 이 단계는 사용자가 화면에서 확인합니다`: one planned item of a dry plan, with the user-made
 * mark 다시 만들기 carries ({@link CARRIED}) or the main's mark of a standing role ({@link MINE}), and what the main wrote
 * that only the user sets ({@link DROPPED}). `carries`: the items that change a user-made area (a new one carries its
 * mark).
 */
function itemLine(
  built: ReorgPlan.Built,
  proposal: OwnTeam.Proposal,
  item: ReorgPlan.Item,
  name: (area: string) => string,
  carries: ReadonlySet<string>,
) {
  const steps = item.steps.flatMap((index) => built.steps[index] ?? [])
  const setup = steps.some((step) => step.kind === AreaCreate.KIND.setup)
  const creates = item.action === "new" || item.action === "split"
  const folder = creates ? (setup ? " · 새 작업 폴더와 준비 명령" : " · 새 작업 폴더") : ""
  const confirm = steps.some((step) => step.mode === "confirm") ? " · 이 단계는 사용자가 화면에서 확인합니다" : ""
  const marked = steps.some((step) => step.kind === AreaCreate.KIND.record && step.args?.userMade === true)
  // A mark 다시 만들기 carries is said so (the main's own mark on it adds nothing); else it is the main's standing role.
  const carried = marked && (carries.has(item.item) || !askedMine(proposal, item.item))
  // A rename that reuses the area says its new role and the mark it sets (2026-11-17).
  const renamed = steps.find((step) => step.kind === AreaCreate.KIND.rename)?.args
  const role = typeof renamed?.goal === "string" ? ROLE(renamed.goal) : ""
  // `carries` holds the items that change a user-made area: a rename there keeps the mark it had.
  const kept = renamed?.userMade === true && !carries.has(item.item)
  const tail = carried ? CARRIED : marked || kept ? MINE : ""
  const dropped = droppedOf(proposal, item.item)
  return `- ${words(proposal, item.item, name)}${folder}${confirm}${role}${tail}${dropped.length > 0 ? DROPPED(dropped) : ""}`
}

/**
 * What the main wrote into an item that only the user sets (영역 만들기, 2026-10-26), in screen words: a new area's own
 * model and 에이전트 방식, and the mark of an adopted folder. A new area's mark the main keeps (AL-9, 2026-11-14).
 */
function droppedOf(proposal: OwnTeam.Proposal, item: string) {
  const [section, index] = item.split("/")
  if (section === "areas") {
    const area = proposal.areas?.[Number(index)]
    return area?.adopt && area.userMade === true ? [USER_MADE_MARK] : []
  }
  const op = proposal.ops?.[Number(index)]
  if (op?.op !== "new") return []
  return [...(op.main === undefined ? [] : ["모델"]), ...(op.harness === undefined ? [] : ["에이전트 방식"])]
}

/** The main marked this new area as the user's (`userMade: true` on a `new` op or a created area, AL-9). */
function askedMine(proposal: OwnTeam.Proposal, item: string) {
  const [section, index] = item.split("/")
  if (section === "areas") {
    const area = proposal.areas?.[Number(index)]
    return area?.create !== undefined && area.create !== null && area.userMade === true
  }
  const op = proposal.ops?.[Number(index)]
  return op?.op === "new" && op.userMade === true
}

const USER_MADE_MARK = "사용자가 정한 영역 표시"

/** An area as the proposal names it (its id, slug or name), by its screen name; the name given when unknown. */
function nameOf(areas: ReadonlyArray<OwnTeam.Area>) {
  return (area: string) => {
    const id = area.startsWith("ar_") ? area : `ar_${area}`
    return areas.find((item) => item.id === id || item.name === area)?.name ?? area
  }
}

/** One planned item in plain words, by its pointer into the proposal (`ops/0`, `areas/1`). */
function words(proposal: OwnTeam.Proposal, item: string, name: (area: string) => string) {
  const [section, index] = item.split("/")
  if (section === "areas") {
    const area = proposal.areas?.[Number(index)]
    if (area?.adopt) return `'${area.adopt.worktree}' 폴더를 '${area.name}' 영역으로 팀에 넣습니다`
    return `새 영역 '${area?.name ?? item}'을(를) 만듭니다`
  }
  const op = proposal.ops?.[Number(index)]
  if (op === undefined) return item
  switch (op.op) {
    case "new":
      return `새 영역 '${op.name}'을(를) 만듭니다`
    case "rename":
      return `'${name(op.area)}' 영역 이름을 '${op.name}'(으)로 바꿉니다`
    case "split":
      return `'${name(op.area)}'에서 새 영역 '${op.name}'을(를) 나눕니다`
    case "merge":
      return `'${name(op.from)}'을(를) '${name(op.area)}'에 묶습니다`
    case "retire":
      return `'${name(op.area)}' 영역을 끝냅니다(되돌릴 수 없음)`
    case "convert":
      return `'${name(op.area)}'을(를) ${op.shape === "code" ? "가벼운 폴더" : "전체 폴더"}로 바꿉니다`
    case "move":
      return `대화 하나를 '${name(op.area)}' 영역 폴더로 옮깁니다`
  }
}

/**
 * An item by the state of its steps: failed, waiting for a confirm, still running, skipped when it ran (its area
 * was busy or under Main 멈춤 by then), or applied (setup may go on).
 */
function outcome(op: OwnTeam.Op, item: ReorgOps.Item): Outcome {
  const steps = item.steps.flatMap((index) => (op.steps[index] ? [op.steps[index]] : []))
  const area = item.areaID.slice("ar_".length)
  const failed = steps.find((step) => step.state === "failed")
  if (failed) return { kind: "rejected", rejected: { item: item.item, why: `실패: ${failed.note ?? failed.kind}` } }
  if (steps.some((step) => step.state === "needs_confirm"))
    return { kind: "pending", entry: { item: item.item, area, why: CONFIRM } }
  const work = steps.filter((step) => step.kind !== AreaCreate.KIND.setup)
  if (work.some((step) => step.state === "pending"))
    return { kind: "pending", entry: { item: item.item, area, why: "진행 중" } }
  const skipped = work.find((step) => step.state === "skipped")
  if (skipped && work.every((step) => step.state === "skipped"))
    return { kind: "skipped", entry: { item: item.item, area, why: skipped.note ?? "건너뛰었습니다" } }
  const preparing = steps.some((step) => step.kind === AreaCreate.KIND.setup && step.state === "pending")
  return {
    kind: "applied",
    entry: { item: item.item, action: item.action, area, state: preparing ? "preparing" : "done" },
  }
}

/** The four lists every answer carries. */
function lists(input: {
  readonly applied?: ReadonlyArray<Entry>
  readonly pending?: ReadonlyArray<Entry>
  readonly skipped?: ReadonlyArray<Entry>
  readonly rejected?: ReadonlyArray<OwnTeam.Rejected>
}) {
  return {
    applied: (input.applied ?? []).map((entry) => ({ ...entry })),
    pending: (input.pending ?? []).map((entry) => ({ ...entry })),
    skipped: (input.skipped ?? []).map((entry) => ({ ...entry })),
    rejected: (input.rejected ?? []).map((entry) => ({ item: entry.item, why: entry.why })),
  }
}
