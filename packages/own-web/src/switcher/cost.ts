// When to ask (03 §6.2) and which strategies the cost dialog shows (03 §6.3). Pure functions over the router's
// `switch.estimate` result and `policy.thresholds.confirm`: the router computes every cost and every recommendation,
// the UI only decides how loudly to show them. Numbers never live here (thresholds come from the policy).
import type { Estimate, Policy } from "@own/protocol"

export interface TargetRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/**
 * - `same`: nothing to do (`현재 사용 중`).
 * - `free`: apply at once, no undo needed (variant only with `preservesCache`, or a session without turns).
 * - `immediate`: apply at once with an undo toast (cache rewrite < `silentBelowTokens`, or the current cache is cold).
 * - `inline`: the switcher's Apply button carries the cost (`적용 · +$0.21`) and one more press applies it.
 * - `dialog`: the switch-cost dialog.
 */
export type Level = "same" | "free" | "immediate" | "inline" | "dialog"

export interface Decision {
  readonly level: Level
  /** Why a level was chosen when the UI says so (`추론 강도만 변경`, `새 세션`, `현재 계정 캐시도 이미 식음`). */
  readonly note?: "variant" | "new" | "currentCold"
  /** Cache rewrite range `P − W_t` (03 §7.5 "토큰은 항상 보여 준다"). */
  readonly tokens: { readonly lo: number; readonly hi: number }
}

export function sameRef(a: TargetRef | null | undefined, b: TargetRef | null | undefined) {
  if (!a || !b) return false
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "")
}

/** `P − W^hi … P − W^lo`: the upper bound decides (03 §6.2 "판단에는 상한을 쓴다"). */
export function coldTokens(estimate: Pick<Estimate.Result, "context" | "inputs">) {
  const P = estimate.context.P
  return { lo: Math.max(0, P - estimate.inputs.W_hi), hi: Math.max(0, P - estimate.inputs.W_lo) }
}

export function nowOption(estimate: Pick<Estimate.Result, "options">) {
  return estimate.options.find((option) => option.strategy === "now")
}

export function decide(input: {
  readonly estimate: Estimate.Result
  readonly current: TargetRef | null | undefined
  readonly target: TargetRef
  readonly confirm: Policy.Confirm
  /** `switch.setConfirmOverride` of this session: replaces `dialogAtTokens` only (02 §9.2). */
  readonly dialogAtTokens?: number | null
  /** The current slot's cache is already cold: staying reads everything again anyway (03 §6.2). */
  readonly currentCold?: boolean
}): Decision {
  const estimate = input.estimate
  const tokens = coldTokens(estimate)
  if (sameRef(input.current, input.target)) return { level: "same", tokens }
  if (estimate.variantOnly?.preservesCache) return { level: "free", note: "variant", tokens }
  const now = nowOption(estimate)
  // Target context too small: `now` is disabled and compact-then-switch is forced (03 §6.2 last rows).
  if (!now?.available || !estimate.target.fits) return { level: "dialog", tokens }
  if (estimate.context.P === 0) return { level: "free", note: "new", tokens }
  const confirm = input.confirm
  const dialogAt = input.dialogAtTokens ?? confirm.dialogAtTokens
  const usd = now.delta?.unit === "USD" ? Math.max(now.delta.lo, now.delta.hi) : 0
  // Limit % only when the router calibrated it (03 §6.2 "한도 % 기준은 라우터가 %를 준 경우에만").
  const percent = now.quota?.state !== "calibrating" && now.quota?.percent ? now.quota.percent.hi : 0
  const tokenGate = !input.currentCold && tokens.hi >= dialogAt
  if (tokenGate || percent >= confirm.dialogAtQuotaPercent || usd >= confirm.dialogAtUSD)
    return { level: "dialog", tokens }
  if (input.currentCold) return { level: "immediate", note: "currentCold", tokens }
  if (tokens.hi < confirm.silentBelowTokens) return { level: "immediate", tokens }
  return { level: "inline", tokens }
}

export interface DialogPlan {
  /** Shown at once, in the order of 03 §6.3's table. */
  readonly primary: readonly Estimate.Option[]
  /** Under the collapsed `더 보기` (`display: "secondary"`, today `fork`). */
  readonly secondary: readonly Estimate.Option[]
  /** `compact-then-switch` was replaced by `switch-then-compact` (the current account cannot summarize). */
  readonly cantCompact: boolean
  /** Default selection: the router's recommendation, else `now`, else the first available option. */
  readonly choice: Estimate.Strategy | undefined
  /** Open `더 보기` because the recommended option lives there (03 §6.3 "UI가 스스로 primary로 올리지 않는다"). */
  readonly expandMore: boolean
}

const ORDER: readonly Estimate.Strategy[] = [
  "now",
  "compact-then-switch",
  "switch-then-compact",
  "cold-point",
  "new-session",
  "fork",
]

export function dialogPlan(estimate: Pick<Estimate.Result, "options">): DialogPlan {
  const byStrategy = new Map(estimate.options.map((option) => [option.strategy, option]))
  const stc = byStrategy.get("switch-then-compact")
  const cts = byStrategy.get("compact-then-switch")
  const stcShown = stc?.available === true
  const cantCompact = stcShown && cts?.available !== true
  const visible = ORDER.flatMap((strategy) => {
    const option = byStrategy.get(strategy)
    if (!option) return []
    // The two compaction strategies exclude each other: show the one that applies (03 §6.3 "상호 배타인 것은 숨긴다").
    if (strategy === "switch-then-compact" && !option.available) return []
    if (strategy === "compact-then-switch" && stcShown && !option.available) return []
    return [option]
  })
  const primary = visible.filter((option) => option.display === "primary")
  const secondary = visible.filter((option) => option.display === "secondary")
  const available = visible.filter((option) => option.available)
  const recommended = available.find((option) => option.recommended)
  const choice = (recommended ?? available.find((option) => option.strategy === "now") ?? available[0])?.strategy
  return {
    primary,
    secondary,
    cantCompact,
    choice,
    expandMore: secondary.some((option) => option.strategy === choice),
  }
}

/** `perRequestAfter` of `now` over that of the option: "이후 요청도 작아집니다 (약 1/N)", `undefined` when unknown. */
export function shrinkFactor(estimate: Pick<Estimate.Result, "options">, option: Estimate.Option) {
  const before = nowOption(estimate)?.perRequestAfter
  const after = option.perRequestAfter
  if (!before || !after || after <= 0) return undefined
  const factor = Math.round(before / after)
  return factor >= 2 ? factor : undefined
}

/** A nice upper bound for "이 세션에서는 {tokens} 미만이면 다시 묻지 않기": the next 50k step above the rewrite. */
export function dontAskTokens(tokensHi: number, dialogAtTokens: number) {
  const step = 50_000
  return Math.max(dialogAtTokens, Math.ceil((tokensHi + 1) / step) * step)
}
