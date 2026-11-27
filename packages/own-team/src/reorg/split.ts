export * as AreaSplit from "./split.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Handoff } from "../docs/handoff.js"
import { AreaCreate } from "../ops/area-create.js"
import { Steps } from "../ops/steps.js"
import { Fold } from "../report/fold.js"
import { Services } from "../services.js"
import { OwnerTurn } from "../sessions/turn.js"
import { SafePoint } from "../sessions/safe-point.js"
import { Direct } from "../dispatch/direct.js"
import { Settle } from "./settle.js"

/**
 * 나누기 A → A, A2 (06 §8.2): a new area that starts where A is, with A's handoff, area main and preset. A itself does
 * not change: its folder, branch, owner and records stay as they are (only its handoff document is new when its owner
 * writes one). The main then splits the work between the two (its next team update says so; `reorganized` does not
 * wake it, 5.6). The steps, each observe → act → verify (TI-11):
 *
 *   split-begin      A's safe point (8.4, TI-9: a user's split waits for it and says why on the card); a split by the
 *                    main or the judge stops with the reason when A is busy or under Main 멈춤 (TI-13), so nothing of
 *                    it runs
 *   split-handoff    team_handoff(A) (6.2 step 1): a warm turn of A's owner, never on an adopted conversation that does
 *                    not have the team yet, on an account out of its limit, or on an empty conversation; skipped then
 *                    (the program writes A2's starting document, 6.2 step 2, without an LLM call)
 *   branch-create    AreaCreate's steps for A2 `from` A: the branch create-only at A's tip, the code-only (or plain)
 *   worktree-create  worktree locked as `own.team area:<A2>`, the record (06 §4.5)
 *   area-record
 *   session-create   A2's record takes A's area main and preset (10.1: the team's accounts do not change, so team R4
 *                    holds), then A2's owner (`sessions/owner.ts`) starts from A's handoff: the one A's owner wrote in
 *                    this op, else a program handoff of A (read only, A's document is not replaced), on the
 *                    에이전트 방식 of A's owner (2026-10-26)
 *   setup-run        AreaCreate's, last
 *
 * Undo = 끝내기 of A2 ({@link undone}; the retire op is `reorg/retire.ts`'s). The helpers below ({@link ready},
 * {@link handoffTurn}, {@link requestTurn}, {@link warm}, {@link written}) are shared with 영역 묶기 (`reorg/merge.ts`).
 */

export const KIND = { begin: "split-begin", handoff: "split-handoff", owner: "session-create" } as const

/** How often a wait looks again without an event: own work on a folder or a git operation ends without one. */
export const RECHECK_MS = Settle.RECHECK_MS

/** The steps of one split. `areaID`: A, the area that is split; `slug`, `name`, `goal`: A2 (V6, V12 applied). */
export async function plan(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly areaID: OwnTeam.AreaID
    readonly slug: string
    readonly name: string
    readonly goal?: string
    readonly by: OwnTeam.Op["by"]
  },
): Promise<Services.Result<{ readonly areaID: OwnTeam.AreaID; readonly steps: ReadonlyArray<Steps.Spec> }>> {
  const area = await services.registry.areas.get(input.team.id, input.areaID)
  if (area?.state === "broken")
    return Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  if (!area || area.state !== "active")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  // A2 starts at A's branch tip; an adopted area whose name waits (3.7) has no branch yet.
  if (area.deferredName)
    return Services.failure("invalid_proposal", "the area has no branch yet", {
      rejected: [{ item: area.id, why: "아직 기록 이름이 없는 영역은 나눌 수 없어요" }],
    })
  const planned = await services.features().areas.plan({
    team: input.team,
    slug: input.slug,
    name: input.name,
    from: area.id.slice("ar_".length),
    by: input.by,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
  })
  if (!planned.ok) return planned
  const made = planned.steps.filter((step) => step.kind !== AreaCreate.KIND.owner)
  const pair = { areaID: area.id, to: planned.areaID, name: input.name }
  return {
    ok: true,
    areaID: planned.areaID,
    steps: [
      { kind: KIND.begin, args: pair },
      { kind: KIND.handoff, args: pair },
      ...made.filter((step) => step.kind !== AreaCreate.KIND.setup),
      { kind: KIND.owner, args: { areaID: planned.areaID, from: area.id } },
      ...made.filter((step) => step.kind === AreaCreate.KIND.setup),
    ],
  }
}

/** Registers the split step kinds once per controller (AreaCreate's own kinds come with the `areas` feature). */
export function register(services: Services.Context) {
  kinds()
    .filter((kind) => !services.steps.get(kind.kind))
    .forEach((kind) => services.steps.register(kind))
}

/** 나누기 되돌리기 = A2 끝내기 (8.2): the areas a split op made (`from`: the area each was split from). */
export function undone(op: OwnTeam.Op) {
  return op.steps.flatMap((step) =>
    step.kind === KIND.begin && step.state === "done"
      ? Option.toArray(decodePair(step.args)).map((args) => ({ areaID: args.to, from: args.areaID }))
      : [],
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Shared with 영역 묶기 (reorg/merge.ts)

const PAUSED = "메인 멈춤이 켜진 영역이라 건너뛰었어요"
const STOPPED = "서비스가 닫혀 멈췄어요"

/**
 * TI-9 and TI-13 when a reorganization step starts: every area active, then each at its safe point (8.4). A user's
 * action waits for them and says why on the card (`op.progress`); one of the main or the judge stops with the reason
 * when an area is busy or under Main 멈춤 (its plan skipped such areas, 06 §8.1; a change since then fails the step,
 * so no later step of the op runs). `undefined` when the controller stopped meanwhile.
 */
export function ready(input: Steps.Input, areaIDs: ReadonlyArray<OwnTeam.AreaID>) {
  const services = input.services
  const user = input.op.by === "user"
  return Settle.until(input, async (report): Promise<Steps.Observed | undefined> => {
    const found = await Promise.all(areaIDs.map((id) => services.registry.areas.get(input.op.teamID, id)))
    const areas = found.filter((area): area is OwnTeam.Area => area?.state === "active")
    if (areas.length !== areaIDs.length) return { state: "failed", note: "영역이 없거나 쓸 수 없는 상태라 멈췄어요" }
    if (!user && areas.some(Direct.kept)) return { state: "failed", note: PAUSED }
    const checks = await Promise.all(
      areas.map((area) =>
        services.features().safePoint.check({ teamID: input.op.teamID, areaID: area.id, signal: input.signal }),
      ),
    )
    const index = checks.findIndex((check) => !check.ok)
    const busy = areas[index]
    const check = checks[index]
    if (busy === undefined || check === undefined || check.ok) return { state: "satisfied" }
    if (!user) return { state: "failed", note: `'${busy.name}' 영역에서 일하는 중이라 건너뛰었어요` }
    report(Settle.reason(`${busy.name}: `, check))
    return undefined
  })
}

/** A handoff document was written for the area since the op started (by its owner or the program). */
export function written(area: OwnTeam.Area, op: OwnTeam.Op) {
  return area.handoff !== null && area.handoff.at >= op.createdAt
}

/**
 * Whether the area's owner gets a warm handoff turn (6.2 step 1): not without an owner, not for an adopted
 * conversation the team is not attached to (3.7: its account may be another subscription of the team main's company,
 * which never runs for the team, U5), not when its account is out of its limit (BLOCKED), not for a conversation
 * without a message yet, and not while the user's or the team's input is parked in its queue (RH-20,
 * `SafePoint.work`: core would run that input first).
 */
export async function warm(services: Services.Context, area: OwnTeam.Area, opID?: string) {
  const owner = area.owner.sessionID
  if (owner === null || !area.owner.attached) return false
  const [state, messages, inbox] = await Promise.all([
    services.accounts.switchState({ sessionID: owner }, { directory: area.directory }),
    services.http.session.messages({ sessionID: owner, directory: area.directory, limit: 1 }),
    services.http.inbox.list({ sessionID: owner, directory: area.directory }),
  ])
  if (state.ok && state.value.state === "BLOCKED") return false
  if (!inbox.ok && inbox.status !== 404) return false
  if (inbox.ok && inbox.value.some((item) => SafePoint.work(item, opID))) return false
  return !messages.ok || messages.value.data.length > 0
}

/**
 * The warm handoff turn: `lead` and the 6.4 format as a {@link requestTurn} of kind `handoff`. `written`: the owner
 * wrote the area's handoff (`team_handoff`) since the op started.
 */
export async function handoffTurn(
  input: Steps.Input,
  area: OwnTeam.Area,
  lead: string,
): Promise<"written" | "none" | "stopped"> {
  const turn = await requestTurn(input, area, {
    kind: "handoff",
    text: request(area, input.services.clock.now(), lead),
    label: `'${area.name}' 담당 대화가 인계 메모를 쓰는 중이에요`,
  })
  if (turn === "stopped") return "stopped"
  if (turn !== "over") return "none"
  const after = await input.services.registry.areas.get(area.teamID, area.id)
  return after && written(after, input.op) ? "written" : "none"
}

/**
 * One turn of the area's owner on an op's request (`OwnerTurn.request`, RH-20: bounded by {@link TURN_MS}, a request
 * nothing will take is withdrawn). `none`: there is no owner or the request could not be sent; `withdrawn` and
 * `interrupted` end it without the owner's answer.
 */
export async function requestTurn(
  input: Steps.Input,
  area: OwnTeam.Area,
  request: { readonly kind: string; readonly text: string; readonly label: string },
): Promise<OwnerTurn.Ended> {
  const owner = area.owner.sessionID
  if (owner === null) return "none"
  return OwnerTurn.request(
    input,
    { sessionID: owner, directory: area.directory, areaID: area.id },
    { kind: request.kind, text: request.text, label: request.label, deadlineMs: TURN_MS },
  )
}

/** RH-20: how long an owner's turn on an op's request (a handoff, a commit) may take. */
export const TURN_MS = 15 * 60_000

/** The handoff request (6.2 step 1, 6.4); the model never sees metadata, so the text says it all. */
function request(area: OwnTeam.Area, now: number, lead: string) {
  const body = [
    lead,
    "새 일은 시작하지 말고 team_handoff{text}로 인계 문서를 쓴 뒤 짧게 답하고 끝내세요. 8 KB 이하로 쓰세요(64 KB를 넘으면 잘립니다).",
    `첫 줄: ${Handoff.title(area, now)}`,
    "그 아래: ## 목표, ## 지금 상태(줄기, 대상 줄기 대비 앞섬·뒤처짐, 마지막 커밋), ## 끝낸 것, ## 남은 것(다음 첫 단계를 맨 앞에), ## 결정과 이유, ## 주의(함정, 돌려 본 명령과 결과), ## 받은 큰 파일 폴더(이유와 함께).",
    "커밋 안 된 변경은 커밋·되돌리기·stash하지 말고 ## 주의에 적으세요.",
  ]
    .join("\n")
    .replace(/<\/team-request/gi, (match) => `<\\${match.slice(1)}`)
  return `<team-request kind="handoff" area="${OwnTeamText.attribute(area.name)}">\n${body}\n</team-request>`
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

/** A and A2 (with A2's name, which its record gets only later). */
const PairArgs = Schema.Struct({ areaID: OwnTeam.AreaID, to: OwnTeam.AreaID, name: Schema.String })
const decodePair = Schema.decodeUnknownOption(PairArgs)
const OwnerArgs = Schema.Struct({ areaID: OwnTeam.AreaID, from: OwnTeam.AreaID })

const DONE: Steps.Outcome = { ok: true }
const GONE = "나누려던 영역이 없어요"
const PROGRAM = "이 앱이 인계 메모를 만들어요"

function areaOf(input: Steps.Input, areaID: OwnTeam.AreaID) {
  return input.services.registry.areas.get(input.op.teamID, areaID)
}

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.begin, PairArgs, {
      // A2 on record: the split went past its start already (a resume).
      observe: async (args, input) =>
        (await areaOf(input, args.to))
          ? { state: "satisfied" }
          : ((await ready(input, [args.areaID])) ?? { state: "failed", note: STOPPED }),
      act: async () => DONE,
      verify: async () => DONE,
    }),

    Steps.define(KIND.handoff, PairArgs, {
      observe: async (args, input) => {
        const [area, made] = await Promise.all([areaOf(input, args.areaID), areaOf(input, args.to)])
        if (made?.owner.sessionID) return { state: "satisfied" }
        if (!area) return { state: "failed", note: GONE }
        if (written(area, input.op)) return { state: "satisfied" }
        return (await warm(input.services, area, input.op.id)) ? { state: "pending" } : { state: "skip", note: PROGRAM }
      },
      act: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        if (!area) return { ok: false, note: GONE }
        const turn = await handoffTurn(
          input,
          area,
          `이 영역에서 '${args.name}' 영역을 새로 나눕니다. 새 영역의 담당 대화는 이 영역의 인계 문서로 시작합니다. 이 대화는 그대로 이어집니다.`,
        )
        if (turn === "stopped") return { ok: false, note: STOPPED }
        return { ok: true, note: turn === "written" ? "담당이 인계 메모를 썼어요" : PROGRAM }
      },
      verify: async () => DONE,
    }),

    Steps.define(KIND.owner, OwnerArgs, {
      observe: async (args, input) => {
        const area = await areaOf(input, args.areaID)
        if (!area) return { state: "failed", note: `${args.areaID} 영역이 팀 기록에 없어요` }
        return area.owner.sessionID === null ? { state: "pending" } : { state: "satisfied" }
      },
      act: async (args, input) => {
        const services = input.services
        const teamID = input.op.teamID
        const source = await areaOf(input, args.from)
        if (!source) return { ok: false, note: GONE }
        const seeded = await seed(services, teamID, args.areaID, source)
        if (!seeded) return { ok: false, note: `${args.areaID} 영역이 팀 기록에 없어요` }
        const handoff = await starting(input, source, seeded)
        if (!handoff.ok) return { ok: false, note: handoff.message }
        const owner = source.owner.sessionID
        const created = await services.features().owner.create({
          teamID,
          areaID: args.areaID,
          handoff: handoff.text,
          // 2026-10-26: A2's owner starts on the 에이전트 방식 of A's owner.
          ...(owner === null ? {} : { harnessFrom: { sessionID: owner, directory: source.directory } }),
          signal: input.signal,
        })
        if (!created.ok) return { ok: false, note: created.message }
        input.summary({ kind: "area", areaID: args.areaID, change: "split", from: args.from })
        await services.features().digest.add(
          teamID,
          Fold.entry({
            at: services.clock.now(),
            reason: "reorganized",
            areaID: args.areaID,
            text: `${source.name}에서 '${seeded.name}' 영역을 나눴습니다. 두 영역에 맡길 일을 다시 나눠 보내세요`,
          }),
        )
        return { ok: true, note: created.sessionID }
      },
      verify: async (args, input) =>
        (await areaOf(input, args.areaID))?.owner.sessionID
          ? DONE
          : { ok: false, note: `${args.areaID} 영역에 담당 대화가 없어요` },
    }),
  ]
}

/** A2's record takes A's area main and preset (10.1), in the team's mutex; the record as it is then. */
function seed(services: Services.Context, teamID: OwnTeam.TeamID, areaID: OwnTeam.AreaID, source: OwnTeam.Area) {
  return services.write(teamID, async () => {
    const current = await services.registry.areas.get(teamID, areaID)
    if (!current) return undefined
    const { main: _main, ...rest } = current
    const next: OwnTeam.Area = {
      ...rest,
      ...(source.main === undefined ? {} : { main: source.main }),
      preset: source.preset,
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) await AreaCreate.save(services, next)
    return next
  })
}

/**
 * The document A2's owner starts from (6.4): A's handoff written in this op, else a program handoff of A (read only,
 * so A's own document stays), under a lead that says where the area comes from.
 */
async function starting(
  input: Steps.Input,
  source: OwnTeam.Area,
  area: OwnTeam.Area,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }> {
  const handoff = input.services.features().handoff
  const target = { teamID: input.op.teamID, areaID: source.id }
  const own = written(source, input.op) ? await handoff.read(target) : undefined
  const program = own === undefined ? await handoff.program(target) : undefined
  if (program && !program.ok) return { ok: false, message: program.message }
  const text = own ?? (program?.ok ? program.text : "")
  return {
    ok: true,
    text: Handoff.cap(
      [
        `# 나눈 영역의 시작: ${area.name}`,
        "",
        `이 영역은 '${source.name}' 영역에서 나눈 새 영역이고, 그 영역의 기록 끝에서 시작합니다. 아래는 '${source.name}'의 인계 문서입니다. 메인이 이 영역에 맡길 일을 다시 나눠 보냅니다.`,
        "",
        text,
      ].join("\n"),
    ),
  }
}
