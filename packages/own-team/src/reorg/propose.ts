export * as ReorgPropose from "./propose.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Decisions } from "../docs/decisions.js"
import { Classify } from "../git/classify.js"
import { Identity } from "../git/identity.js"
import { JudgeFallback } from "../judge/fallback.js"
import { JudgePrompt } from "../judge/prompt.js"
import { JudgeSchema } from "../judge/schema.js"
import { JudgeValidate } from "../judge/validate.js"
import { Direct } from "../dispatch/direct.js"
import { ReorgOps } from "../ops/reorg.js"
import { Keys } from "../registry/keys.js"
import { Services } from "../services.js"
import { ReorgPlan } from "./plan.js"
import { Journal } from "../ops/journal.js"

/**
 * `reorg.propose{teamID, hint?}` (06 §8.1 팀 구성 다시 보기, §3.4): the judge call of a reorganization. The controller
 * calls the team main's one-off self-HTTP `POST /api/session/<main>/generate{prompt}` (never `ctx.generate.text`), so
 * the call passes the session hooks (own-accounts authenticates it), lands in the ledger and reuses the main's cached
 * prefix, without a trace in the main conversation. The input (at most 20k tokens) is the fixed Korean reorganization
 * instructions, the areas with their state, the folders outside the team, the heavy folders, the decision record
 * titles (`Decisions.titles`) and the hint. An answer that does not decode (V1) is asked for once more with its errors;
 * a second failure gives the rule-based proposal ({@link fallback}).
 *
 * The proposal is planned as `reorg.apply{proposalID}` would run it (by `auto`, the same V-rules and skip rules) and
 * stored as `{proposal, createdAt}` under `proposal:<teamID>:<id>` (`ReorgOps.Stored`, kept 7 days: older ones go when
 * a new one is stored). Nothing else is written. The RPC method answers `unsupported` until it is wired (T3.15).
 *
 * 2026-10-16: 팀 구성 다시 보기 shows this plan for the user to choose items (the hint is what the user typed there, and
 * the judge follows it within its rules); the chosen ones run by `user`, where an area that works waits for its safe
 * point. `plan.skipped` names the Main 멈춤 and busy skips the by-`auto` run would make, so the screen offers them
 * unchecked. Since 2026-10-27 the screen sends the chosen items by id (`reorg.apply{proposalID, items}`) and the run
 * keeps the proposal the judge's (`author: "auto"`): what only the user sets never comes from the judge's answer,
 * which is stored as it came. `reorg.apply{proposalID}` alone (by `auto`) stays for older clients.
 */

export interface Proposed {
  readonly proposalID: OwnTeam.ProposalID
  readonly proposal: OwnTeam.Proposal
  readonly plan: OwnTeam.Plan
  /** `fallback`: the judge did not answer usably twice. */
  readonly source: "judge" | "fallback"
}

export async function propose(
  services: Services.Context,
  input: { readonly teamID: string; readonly hint?: string; readonly signal?: AbortSignal },
): Promise<Services.Result<Proposed>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  // Planning reads git; a team that runs another op answers at once.
  const active = await services.journal.active(team.id)
  if (active) return Services.failure("busy", "another team op is running", Journal.busy(active))
  const areas = await services.registry.areas.list(team.id)
  const gathered = await ReorgPlan.gather(services, team, areas)
  const prompt = JudgePrompt.reorganize({
    target: team.target,
    home: team.home.directory,
    areas: areas.filter((area) => area.state !== "retired").map((area) => view(area, gathered)),
    worktrees: (gathered?.facts.worktrees ?? []).filter(
      (item) => !areas.some((area) => area.state !== "retired" && Identity.same(area.directory, item.path)),
    ),
    heavy: team.heavy.dirs,
    decisions: await Decisions.titles(services, team.id),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
  })
  const judged = await judge(services, {
    team,
    prompt,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  const proposal = judged ?? fallback({ areas, gathered })
  const built = await ReorgPlan.build(services, {
    team,
    proposal,
    by: "auto",
    ...(gathered === undefined ? {} : { gathered }),
  })
  // A repository failure (a `#` worktree root, a Git without sparse support) is the plan's answer, not the call's.
  const plan = built.ok ? built.plan : { steps: [], rejected: [{ item: "proposal", why: built.message }] }
  const proposalID = OwnTeam.ProposalID.create()
  await store(services, team.id, proposalID, proposal)
  return { ok: true, proposalID, proposal, plan, source: judged === undefined ? "fallback" : "judge" }
}

/**
 * The rule-based reorganization (06 §3.4's rule for a reorganization): every active folder outside the team with a
 * named branch is adopted (팀에 넣기), and every area whose retirement the program verified (V13) is suggested for
 * 끝내기. Nothing else: no area is made, split, merged or removed by a rule.
 */
export function fallback(input: {
  readonly areas: ReadonlyArray<OwnTeam.Area>
  readonly gathered: ReorgPlan.Gathered | undefined
}): OwnTeam.Proposal {
  const facts = input.gathered?.facts
  const live = input.areas.filter((area) => area.state !== "retired")
  const adopt = (facts?.worktrees ?? []).filter(
    (item) =>
      item.class === "candidate" &&
      item.active &&
      item.branch !== null &&
      !live.some((area) => Identity.same(area.directory, item.path)),
  )
  const retire = live.filter(
    (area) => area.state === "active" && (facts?.retirable.has(Classify.key(area.directory)) ?? false),
  )
  return {
    version: 1,
    ...(adopt.length === 0
      ? {}
      : {
          areas: adopt.map((item) => {
            const name = path.posix.basename(item.path.replaceAll("\\", "/"))
            return {
              slug: JudgeValidate.slugify(name),
              name,
              adopt: { worktree: item.path, branch: item.branch, owner: item.sessions[0] ?? null },
              create: null,
            }
          }),
        }),
    ...(retire.length === 0
      ? {}
      : {
          suggest: retire.map((area) => ({
            kind: "retire" as const,
            area: area.id.slice("ar_".length),
            why: "반영이 끝났고 남은 변경이 없어요",
          })),
        }),
    notes: JudgeFallback.NOTES,
  }
}

/** The one call on the team main (3.4), one retry with the errors; `undefined` when neither answer decodes (V1). */
async function judge(
  services: Services.Context,
  input: { readonly team: OwnTeam.Team; readonly prompt: string; readonly signal?: AbortSignal },
) {
  const team = input.team
  const ask = async (text: string): Promise<JudgeSchema.Parsed> => {
    const answer = await services.http.session.generate(
      { sessionID: team.main.sessionID, directory: team.home.directory, prompt: text },
      input.signal === undefined ? {} : { signal: input.signal },
    )
    if (answer.ok) return JudgeSchema.parse(answer.value)
    services.log.warn("reorg_judge_failed", { teamID: team.id, status: answer.status, type: answer.type })
    return { ok: false, errors: [`판단 호출이 실패했습니다 (${answer.type})`] }
  }
  const first = await ask(input.prompt)
  const second = first.ok ? first : await ask(JudgePrompt.retry(input.prompt, first.errors))
  if (second.ok) return second.proposal
  services.log.warn("reorg_judge_fallback", { teamID: team.id, errors: second.errors })
  return undefined
}

/** An area as the judge sees it: the record, and what git said of its folder. */
function view(area: OwnTeam.Area, gathered: ReorgPlan.Gathered | undefined): JudgePrompt.ReorgArea {
  const entry = gathered?.inventory.worktrees.find((item) => Identity.same(item.path, area.directory))
  return {
    slug: area.id.slice("ar_".length),
    name: area.name,
    ...(area.subtitle === undefined || area.subtitle === "" ? {} : { subtitle: area.subtitle }),
    goal: area.goal,
    state: area.state,
    status: area.status.kind,
    // TI-13: the judge reads `메인 멈춤` for an area held by direct work too; there it only means "do not touch".
    paused: Direct.kept(area),
    branch: area.branch,
    shape: area.shape,
    ahead: entry?.ahead ?? null,
    changes: entry?.changes?.uncommitted ?? null,
    owner: area.owner.sessionID !== null,
    retirable: gathered?.facts.retirable.has(Classify.key(area.directory)) ?? false,
  }
}

const DAY = 86_400_000

/** Stores the proposal (KV `proposal:<teamID>:<id>`); the team's proposals older than 7 days go in the same write. */
async function store(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
  proposalID: OwnTeam.ProposalID,
  proposal: OwnTeam.Proposal,
) {
  const now = services.clock.now()
  const value = Keys.toJson(Schema.encodeSync(ReorgOps.Stored)({ proposal, createdAt: now }))
  const decode = Schema.decodeUnknownOption(ReorgOps.Stored)
  await services.write(teamID, async () => {
    const old = await services.kv.scan(Keys.prefix.proposals(teamID))
    const expired = old.filter((entry) =>
      Option.match(decode(entry.value), {
        onNone: () => true,
        onSome: (stored) => now - stored.createdAt > ReorgOps.PROPOSAL_DAYS * DAY,
      }),
    )
    await Promise.all(expired.map((entry) => services.kv.remove(entry.key)))
    await services.kv.set(Keys.proposal(teamID, proposalID), value)
  })
}
