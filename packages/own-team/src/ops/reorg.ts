export * as ReorgOps from "./reorg.js"

import { Option, Schema } from "effect"
import { OwnID, OwnTeam } from "@own/protocol"
import { Keys } from "../registry/keys.js"
import { ReorgPlan } from "../reorg/plan.js"
import { Services } from "../services.js"
import { AreaCreate } from "./area-create.js"
import { Journal } from "./journal.js"

/**
 * A reorganization as one `reorg` op (06 §8.1–8.2): the proposal goes through the V-rules and the plan builder
 * (`reorg/plan.ts`: new areas, renames, 팀에 넣기, 나누기, 묶기, 끝내기, 변환, 대화 옮기기, the TI-9 and TI-13 skip
 * rules), then the runner. `by`: `user` for the user's own action (`reorg.apply{proposal}`) and for the items the user
 * chose of a stored judge proposal (`reorg.apply{proposalID, items}`, 팀 구성 다시 보기, with `author: "auto"`), `auto`
 * for a whole stored judge proposal (`reorg.apply{proposalID}`, older clients), `main` for `team_reorganize`. Heavy
 * folders, shared folders and commands are not changed by a reorganization.
 *
 * Rejected items and actions skipped for their area (Main 멈춤, work, broken) are on the op's card as `skipped` lines,
 * and a skipped action sends the `reorg.skipped` notice when the op starts. A proposal with nothing to run, skip or
 * show (no notes, no suggestion) is `invalid_proposal`; a module's refusal of one action never answers the whole call,
 * since `reorg.apply` declares none of `dirty`, `not_safe_point` or `broken`.
 */

/** A stored judge proposal (KV `proposal:<teamID>:<id>`): kept {@link PROPOSAL_DAYS} days. */
export const Stored = Schema.Struct({ proposal: OwnTeam.Proposal, createdAt: OwnID.EpochMillis })

export const PROPOSAL_DAYS = 7

/** One applied action and the indexes of its steps in the op. */
export type Item = ReorgPlan.Item

export interface Applied {
  readonly op: OwnTeam.Op
  readonly items: ReadonlyArray<Item>
  /** Actions left out now for their area (TI-9, TI-13, broken, an adoption R4 cannot judge). */
  readonly skipped: ReadonlyArray<ReorgPlan.Skipped>
  readonly rejected: ReadonlyArray<OwnTeam.Rejected>
}

export async function apply(
  services: Services.Context,
  input: {
    readonly teamID: string
    readonly proposal: OwnTeam.Proposal
    readonly by: OwnTeam.Op["by"]
    /**
     * Who wrote the proposal when another runs it (`ReorgPlan.build`): the main's that the user's yes runs, the judge's
     * items the user chose in 팀 구성 다시 보기.
     */
    readonly author?: OwnTeam.Op["by"]
  },
): Promise<Services.Result<Applied>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  // Planning reads git; a team that runs another op answers at once (the runner checks again when it starts).
  const active = await services.journal.active(team.id)
  if (active) return busy(active)
  const built = await ReorgPlan.build(services, {
    team,
    proposal: input.proposal,
    by: input.by,
    ...(input.author === undefined ? {} : { author: input.author }),
  })
  if (!built.ok) return built
  const shown = built.lines.some((line) => line.kind === "notes" || line.kind === "suggest")
  if (built.steps.length === 0 && built.skipped.length === 0 && !shown)
    return Services.failure("invalid_proposal", "nothing in the proposal can be applied", { rejected: built.rejected })
  const touched = [...new Set(built.items.map((item) => item.areaID))]
  const started = await services.runner.start({
    teamID: team.id,
    kind: "reorg",
    by: input.by,
    steps: built.steps,
    summary: { lines: built.lines },
    // 8.2 되돌리기: every action but 끝내기 has a way back (`op.undo` reverses a reorganization by what it did).
    undo: { available: built.items.some((item) => item.action !== "retire") },
    ...(touched.length === 1 ? { areaID: touched[0] } : {}),
  })
  if (!started.ok) return busy(started.op)
  // 8.1: what Main 멈춤 or the area's work held back is told where the area is shown.
  built.skipped
    .filter((entry) => entry.notice)
    .forEach((entry) =>
      services.notices.publish({
        teamID: team.id,
        ...(entry.areaID === undefined ? {} : { areaID: entry.areaID }),
        kind: "reorg.skipped",
        text: entry.text,
        data: { item: entry.item, why: entry.why },
      }),
    )
  return { ok: true, op: started.op, items: built.items, skipped: built.skipped, rejected: built.rejected }
}

/** A stored judge proposal, or `undefined` when there is none or it is older than {@link PROPOSAL_DAYS} days. */
export async function stored(services: Services.Context, teamID: string, proposalID: string) {
  const value = Option.getOrUndefined(
    Schema.decodeUnknownOption(Stored)(await services.kv.get(Keys.proposal(teamID, proposalID))),
  )
  if (!value || services.clock.now() - value.createdAt > PROPOSAL_DAYS * 86_400_000) return undefined
  return value.proposal
}

/**
 * Waits until every item's steps other than `setup-run` ran (or the op stopped running, or `ms` passed), so a caller
 * can say what was applied while the setup commands go on. Returns the op as it is then.
 */
export async function settle(services: Services.Context, applied: Applied, ms: number) {
  const ready = (op: OwnTeam.Op) =>
    op.state !== "running" ||
    applied.items.every((item) =>
      item.steps.every((index) => {
        const step = op.steps[index]
        return step === undefined || step.kind === AreaCreate.KIND.setup || step.state !== "pending"
      }),
    )
  const done = Promise.withResolvers<void>()
  const look = async () => {
    const op = await services.journal.get(applied.op.teamID, applied.op.id)
    if (!op || ready(op)) done.resolve()
  }
  const unsubscribe = services.hub.subscribe((event) => {
    if ((event.name === "op.progress" || event.name === "op.done") && event.data.opID === applied.op.id) void look()
  })
  const cancel = services.clock.schedule(ms, () => done.resolve())
  await look()
  await done.promise
  unsubscribe()
  cancel()
  return (await services.journal.get(applied.op.teamID, applied.op.id)) ?? applied.op
}

function busy(op: OwnTeam.Op) {
  return Services.failure("busy", "another team op is running", Journal.busy(op))
}
