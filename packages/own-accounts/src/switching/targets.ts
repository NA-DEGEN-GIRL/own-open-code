export * as Targets from "./targets.js"

import type { Model } from "@opencode/schema/model"
import { Preset, type Account, type Estimate, type Policy } from "@own/protocol"
import { Estimator } from "./estimator.js"

/** A candidate slot × model for automatic switching or the "recommended" order (02 §5.7). */
export interface Candidate {
  readonly side: Estimator.Side
  readonly accountID: Account.ID | null
  readonly target: Model.Ref
  /** Why the candidate cannot be chosen (exhausted, policy, breaker, …); it stays in the list with its reason. */
  readonly excluded?: string
  /** `min(1 − used%/100)` over the account's windows, corrected for resets within the hour. */
  readonly headroom: number | null
}

export interface Ranked extends Estimate.Candidate {
  readonly unit: Estimate.Unit
}

/**
 * Ranks candidates (02 §5.7): excluded ones last with their reason; billing-unit groups in fallback-chain order (a
 * chain orders units, never mixes them); inside a unit `score = Δ_now + H·c_req` ascending, ties by headroom. A target
 * the context does not fit is scored with its compaction option. Returning to a warm slot scores lower by itself.
 */
export function rank(input: {
  readonly source: Estimator.Side
  readonly candidates: ReadonlyArray<Candidate>
  readonly ctx: Estimator.Context
  readonly thresholds: Policy.Thresholds
  readonly chain: ReadonlyArray<string>
  readonly sourceAvailable: boolean
}): Ranked[] {
  const scored = input.candidates.map((candidate) => {
    const plan = Estimator.plan({
      source: input.source,
      target: candidate.side,
      ctx: input.ctx,
      sourceAvailable: input.sourceAvailable,
      thresholds: input.thresholds,
      variantOnly: null,
    })
    const compacting = plan.options.find(
      (option) =>
        (option.strategy === "compact-then-switch" || option.strategy === "switch-then-compact") && option.available,
    )
    const delta = plan.fits ? plan.deltaNow : (compacting?.delta ?? plan.deltaNow)
    const perRequest = plan.fits ? plan.perRequest : (compacting?.perRequestAfter ?? plan.perRequest)
    const score =
      delta && perRequest !== null && perRequest !== undefined ? delta.hi + input.ctx.horizon * perRequest : null
    const unfit = !plan.fits && compacting === undefined ? "target_context_too_small" : undefined
    const excluded = candidate.excluded ?? unfit
    return {
      providerID: candidate.target.providerID,
      accountID: candidate.accountID,
      target: candidate.target,
      score: score === null ? null : Estimator.round(score),
      deltaNow: plan.deltaNow,
      perRequest: plan.perRequest,
      headroom: candidate.headroom === null ? null : Estimator.round(candidate.headroom),
      ...(excluded === undefined ? {} : { excludedReason: excluded }),
      unit: candidate.side.rates.unit,
    } satisfies Ranked
  })
  // Units the chain lists come first in chain order, then the source's own unit, then the rest.
  const unitOrder = (unit: Estimate.Unit) => {
    const indexes = scored
      .filter((item) => item.unit === unit)
      .map((item) => input.chain.indexOf(item.providerID))
      .filter((index) => index >= 0)
    if (indexes.length > 0) return Math.min(...indexes)
    return unit === input.source.rates.unit ? input.chain.length : input.chain.length + 1
  }
  return scored.toSorted(
    (a, b) =>
      Number(a.excludedReason !== undefined) - Number(b.excludedReason !== undefined) ||
      compareNumbers(unitOrder(a.unit), unitOrder(b.unit)) ||
      compareNullable(a.score, b.score) ||
      compareNullable(a.headroom === null ? null : -a.headroom, b.headroom === null ? null : -b.headroom),
  )
}

/**
 * Another subscription of the target's company (07 §5.5): a session running on it while the main moves to `target`
 * would have one root use both subscriptions. Another company, metered and prepaid accounts, local and built-in
 * providers (no member) are never rivals.
 */
export function rival(member: Preset.Member | undefined, target: Preset.Member | undefined) {
  return (
    member?.billing === "subscription" &&
    target?.billing === "subscription" &&
    Preset.company(member) === Preset.company(target) &&
    !Preset.oneSubscription(member, target)
  )
}

/**
 * 팀 거르기 (06 §10.1, 07 §5.5): a subscription account of a company the team already has an account of, other than
 * that one subscription. Ranking and suggestions leave it out, and only own.team's team account operation (`teamOp`)
 * may move a team session there. The same-login `codex`/`siwc` sibling of a team account stays in.
 */
export function outsideTeam(member: Preset.Member | undefined, team: Preset.Team, lookup: Preset.Lookup) {
  if (member?.billing !== "subscription") return false
  const company = Preset.company(member)
  const ofCompany = team.accounts.flatMap((accountID) => {
    const known = lookup(accountID)
    return known && Preset.company(known) === company ? [known] : []
  })
  return ofCompany.length > 0 && !ofCompany.some((known) => Preset.oneSubscription(known, member))
}

/** Account headroom from its limit windows (02 §5.7): a window resetting within 60 minutes counts as partly free. */
export function headroom(
  windows: ReadonlyArray<{ readonly usedPercent?: number; readonly resetAt?: number }>,
  now: number,
) {
  const values = windows.flatMap((window) => {
    if (window.usedPercent === undefined) return []
    const free = Math.max(0, 1 - window.usedPercent / 100)
    if (window.resetAt === undefined || window.resetAt <= now) return [free]
    const minutes = (window.resetAt - now) / 60_000
    return [minutes >= 60 ? free : free + (1 - free) * (1 - minutes / 60)]
  })
  return values.length === 0 ? null : Math.min(...values)
}

function compareNumbers(a: number, b: number) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function compareNullable(a: number | null, b: number | null) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return compareNumbers(a, b)
}
