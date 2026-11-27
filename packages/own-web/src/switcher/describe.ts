// Text for estimate results (03 §7.5, §6.3): cost lines, quota impact, warnings and unavailable reasons. Prints the
// router's numbers only; shared by the switcher footer and the cost dialog. Also the two T1 lines of a switch (07 §5.3,
// §5.5): the preset a main takes in another provider group (`프리셋: Claude 리뷰 → 평소대로(Claude 구독)`) and the
// subagents a same-company subscription switch waits for (`ChatGPT 01에서 하위 에이전트 2개가 실행 중입니다`).
import type { Account, Estimate } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import type { I18n } from "@/i18n"
import { limitMode, type LimitMode } from "@/limits/display"
import { presetsBootText } from "@/presets/boot-strings"
import { catalogText } from "@/projects/text"
import { coldTokens, type Decision } from "./cost"
import { formatDelta, formatMoney, formatPercent, formatRange, formatTokens } from "./format"

/** Switch strings of the T1 lines (07 §5.3, §5.5); same rules as src/i18n, so they can move there verbatim. */
const switchKo = {
  "own.switch.presetMove": "프리셋: {from} → {to}({group})",
  "own.switch.children.busy": "{account}에서 하위 에이전트 {n}개가 실행 중이에요",
  "own.switch.children.afterIdle": "끝나면 바꾸기",
  "own.switch.children.stop": "멈추고 바꾸기",
} as const satisfies Record<string, string>

const switchEn: Record<SwitchKey, string> = {
  "own.switch.presetMove": "Preset: {from} → {to} ({group})",
  "own.switch.children.busy": "{n} subagents are running on {account}",
  "own.switch.children.afterIdle": "Switch when they finish",
  "own.switch.children.stop": "Stop them and switch",
}

export type SwitchKey = keyof typeof switchKo
export const switchText = catalogText(switchKo, switchEn)

export interface DescribeContext {
  readonly i18n: I18n
  readonly estimate: Estimate.Result
  /** The target is the third-party Claude subscription slot: cost unknown (03 §7.5 last rule). */
  readonly targetIsClaudeSlot?: boolean
  /**
   * A Claude Agent target (02 §8.10, CAM-7): the plan has no per-token price, so a line without a delta shows the
   * plan's limit impact when known, else this text (the lazy screens pass it: PF5), never "cost unknown".
   */
  readonly planText?: string
}

/** `118k`, or `4k–66k` when the target cache state is uncertain (03 §6.2 "재작성량을 범위로"). */
export function tokenText(estimate: Estimate.Result) {
  const tokens = coldTokens(estimate)
  if (Math.abs(tokens.hi - tokens.lo) < 1_000) return formatTokens(tokens.hi)
  return `${formatTokens(tokens.lo)}–${formatTokens(tokens.hi)}`
}

/** One option's money: Δ in one unit, the target's first request when units differ, or `알 수 없음`. */
export function costText(ctx: DescribeContext, option: Estimate.Option | undefined) {
  const i18n = ctx.i18n
  const delta = option?.delta
  if (ctx.targetIsClaudeSlot) {
    const equivalent =
      delta && delta.unit === "USD" ? ` (${i18n.t("own.claude.costApiEquiv", { money: formatMoney(delta.hi) })})` : ""
    return `${i18n.t("own.claude.costUnknown")}${equivalent}`
  }
  if (ctx.planText && !delta) return quotaText(i18n, option?.quota) ?? ctx.planText
  if (!delta) return i18n.t("own.switcher.costUnknown")
  const units = ctx.estimate.context.units
  const main =
    units.source === units.target
      ? formatDelta(i18n, delta)
      : i18n.t("own.switcher.costFirstOnly", { first: formatRange(i18n, delta) })
  const quota = quotaText(i18n, option?.quota)
  return quota ? `${main} (${quota})` : main
}

/**
 * `5시간 남은 한도 −0–8.5%` (remaining mode, the default) or `5시간 한도 +0–8.5%` (used mode, 설정 > 일반 > 한도 표시),
 * or `보정 중` (03 §7.5 "구독 한도 %", 7.3 UI-derived tag).
 */
export function quotaText(i18n: I18n, quota: Estimate.QuotaImpact | undefined, mode: LimitMode = limitMode()) {
  if (!quota) return undefined
  if (quota.state === "calibrating" || !quota.percent) return i18n.t("own.conf.calibrating")
  const window = windowName(i18n, quota.window)
  const percent = quota.percent
  const left = mode === "remaining"
  if (percent.point !== undefined && quota.state === "calibrated")
    return i18n.t(left ? "own.switcher.quotaPointLeft" : "own.switcher.quotaPoint", {
      window,
      value: formatPercent(percent.point),
    })
  return i18n.t(left ? "own.switcher.quotaRangeLeft" : "own.switcher.quotaRange", {
    window,
    lo: formatPercent(percent.lo),
    hi: formatPercent(percent.hi),
  })
}

/** Limit window ids (02 §7.3) to their short names; other ids print as their label when it is known, else as they are. */
export function windowName(i18n: I18n, id: string, label?: string) {
  if (id.endsWith(".primary") || id === "claude.5h") return i18n.t("own.limit.5h")
  if (id.endsWith(".secondary")) return i18n.t("own.limit.weekly")
  if (id === "claude.7d") return i18n.t("own.limit.7d")
  return label ?? id
}

/** The switcher footer line (03 §5.2 "하단 비용 줄"). */
export function footerCost(ctx: DescribeContext, decision: Decision | undefined) {
  const i18n = ctx.i18n
  const estimate = ctx.estimate
  if (estimate.variantOnly?.preservesCache) return i18n.t("own.switcher.costNoneVariant")
  if (decision?.note === "new") return i18n.t("own.switcher.costNone")
  const now = estimate.options.find((option) => option.strategy === "now")
  return i18n.t("own.switcher.cost", { tokens: tokenText(estimate), delta: costText(ctx, now) })
}

export type NoteTone = "info" | "warn"

/** Warnings of the estimate and of `now` as short notes (03 §5.2, §5.8.6, §6.3). */
export function warningNotes(i18n: I18n, estimate: Estimate.Result, from: { account: string; cacheState: string }) {
  const codes = new Set<Estimate.Warning>([
    ...(estimate.warnings ?? []),
    ...(estimate.options.find((option) => option.strategy === "now")?.warnings ?? []),
  ])
  const notes: { readonly tone: NoteTone; readonly text: string }[] = []
  if (codes.has("target_context_too_small")) notes.push({ tone: "warn", text: i18n.t("own.switch.targetCompactsNow") })
  if (codes.has("target_compacts_soon")) notes.push({ tone: "warn", text: i18n.t("own.switch.targetCompactsSoon") })
  if (codes.has("compaction_may_truncate"))
    notes.push({ tone: "warn", text: i18n.t("own.switch.compactionMayTruncate") })
  if (codes.has("same_org_no_headroom")) notes.push({ tone: "info", text: i18n.t("own.switcher.sameOrg") })
  if (codes.has("cross_provider_reasoning_loss"))
    notes.push({
      tone: "info",
      text: `${i18n.t("own.switch.crossProvider")} ${i18n.t("own.switch.returnHint", from)}`,
    })
  if (codes.has("image_trim")) notes.push({ tone: "info", text: i18n.t("own.switcher.warn.imageTrim") })
  if (codes.has("rate_unknown")) notes.push({ tone: "info", text: i18n.t("own.switcher.warn.rateUnknown") })
  return notes
}

/** Why a dialog option is disabled (03 §6.3 "쓸 수 없을 때"). */
export function unavailableText(i18n: I18n, reason: Estimate.UnavailableReason | undefined, from: string) {
  switch (reason) {
    case "target_context_too_small":
      return i18n.t("own.switch.nowBlocked")
    case "source_already_cold":
      return i18n.t("own.switch.coldAlready")
    case "ttl_too_long":
      return i18n.t("own.switch.coldNoBenefit", { account: from })
    case "source_exhausted":
      return i18n.t("own.switch.unavailable.source_exhausted")
    case "rate_unknown":
      return i18n.t("own.switch.unavailable.rate_unknown")
    case "policy_denied":
      return i18n.t("own.switch.unavailable.policy_denied")
    case "revert_staged":
      return i18n.t("own.switch.unavailable.revert_staged")
    default:
      return i18n.t("own.switch.unavailable.other")
  }
}

/**
 * The preset a root uses now (07 §5.3): `session.preset.get`'s while it is of the main's group; else the binding's
 * (the group's ★ once the main moved to another group), else `평소대로`.
 */
export function presetNow(
  group: Preset.Group,
  session: Preset.SessionView | undefined,
  view: Preset.GroupView | undefined,
): Preset.Info {
  if (session?.preset?.group === group) return session.preset
  const id = Preset.effective(session?.binding ?? undefined, group, view?.star)
  return view?.presets?.find((preset) => preset.id === id) ?? Preset.builtin(group)
}

export interface PresetMove {
  readonly from: Pick<Preset.Info, "id" | "name">
  readonly to: Pick<Preset.Info, "id" | "name">
  readonly group: Preset.Group
}

/**
 * The preset a main moving to another provider group takes (07 §5.3; own-accounts `presets/apply.ts` `rebound`): the
 * group's stored preset named like the one in use, else the group's ★, else its `평소대로`, skipping one that breaks R4
 * with the new main account and the session's team. `undefined` while the group stays, or when either side has none
 * (a built-in provider's main has no preset).
 */
export function presetMove(input: {
  readonly from: Preset.Group | undefined
  readonly to: Preset.Group | undefined
  /** The preset in use now ({@link presetNow}). */
  readonly current: Pick<Preset.Info, "id" | "name">
  /** `presets.list` of the target group; none on a remote server, whose sessions keep `평소대로` (07 §8.1 원격). */
  readonly view: Preset.GroupView | undefined
  /** The new main account; `null` for a local provider. */
  readonly main: Account.ID | null
  readonly lookup: Preset.Lookup
  readonly team?: Preset.Team
}): PresetMove | undefined {
  const group = input.to
  if (!input.from || !group || input.from === group) return undefined
  const stored = (input.view?.presets ?? []).filter((preset) => preset.group === group && !Preset.isBuiltin(preset.id))
  const star = input.view?.star
  const to =
    [
      stored.find((preset) => preset.name === input.current.name),
      star === undefined ? undefined : stored.find((preset) => preset.id === star),
    ].find((preset) => preset !== undefined && Preset.allowed(preset, input.main, input.lookup, input.team).ok) ??
    Preset.builtin(group)
  return { from: input.current, to, group }
}

/** `프리셋: Claude 리뷰 → 평소대로(Claude 구독)` (07 §5.3, the line under the cost line). */
export function presetMoveText(i18n: I18n, move: PresetMove) {
  const locale = i18n.locale()
  const name = (preset: Pick<Preset.Info, "id" | "name">) =>
    Preset.isBuiltin(preset.id) ? presetsBootText(locale, "own.preset.builtin") : preset.name
  return switchText(locale, "own.switch.presetMove", {
    from: name(move.from),
    to: name(move.to),
    group: groupName(i18n, move.group),
  })
}

/** A provider group's name (`ChatGPT`, `Claude 구독`, `Ollama`); a local provider without a name shows its id. */
export function groupName(i18n: I18n, group: Preset.Group) {
  const locale = i18n.locale()
  if (!Preset.isLocal(group)) return presetsBootText(locale, `own.preset.groupName.${group}`)
  const provider = group.slice("local:".length)
  if (provider === "ollama" || provider === "lmstudio")
    return presetsBootText(locale, `own.preset.groupName.${provider}`)
  return provider
}

/** `ChatGPT 01에서 하위 에이전트 2개가 실행 중입니다` (07 §5.5): what a same-company subscription switch waits for. */
export function childWaitText(i18n: I18n, account: string, count: number) {
  return switchText(i18n.locale(), "own.switch.children.busy", { account, n: count })
}

/** `신뢰도 높음/중간/낮음` from measured steps and the recent error (02 §6.5 confidence). */
export function confidenceLevel(i18n: I18n, confidence: Estimate.Result["confidence"]) {
  const error = confidence.recentError
  if (confidence.steps >= 10 && error !== null && error <= 0.15) return i18n.t("own.switch.confidence.high")
  if (confidence.steps >= 3) return i18n.t("own.switch.confidence.medium")
  return i18n.t("own.switch.confidence.low")
}

export function confidenceNote(i18n: I18n, confidence: Estimate.Result["confidence"]) {
  return i18n.t("own.switch.estimateNote", {
    level: confidenceLevel(i18n, confidence),
    n: confidence.steps,
    err: confidence.recentError === null ? "—" : `${Math.round(confidence.recentError * 100)}%`,
  })
}
