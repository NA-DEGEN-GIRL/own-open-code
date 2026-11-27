// Context meter model (03 §4.4 ContextMeter, §5.8.3): fill = P / original window, a tick at the auto-compaction
// point (two ticks when the session compacts earlier than its account/model), tone by distance to the point. All
// values come from `cache.state.compaction`; without the router, the registered limit gives a fallback drawn on a
// plain faint track (no dashes since UX 2026-10-26).
import { Compaction } from "@own/protocol/compaction"
import type { I18n } from "@/i18n"
import { formatTokens } from "@/switcher/format"

export interface MeterMark {
  /** 0..1 along the ring. */
  readonly at: number
  /** The point actually used (the earlier one); the other one is drawn faint. */
  readonly strong: boolean
}

export interface MeterModel {
  /** `fallback`: no router data, drawn on a faint track with `라우터 정보 없음 — 등록 한도 기준` (03 §4.4). */
  readonly mode: "router" | "fallback"
  readonly window: number
  readonly used: number | null
  readonly trigger: number
  readonly slotTrigger: number
  readonly sessionTrigger: number | null
  readonly fill: number
  readonly marks: readonly MeterMark[]
  /** `neutral` < 85 % of the point, `warn` ≥ 85 %, `over` at or past it (`다음 단계 전에 압축`). */
  readonly tone: "neutral" | "warn" | "over"
  readonly remaining: number | null
  readonly source?: Compaction.Source
}

/** Share of the auto-compaction point where the meter turns to the caution color (03 §4.4). */
export const WARN_SHARE = 0.85

export function meterModel(
  view: Compaction.View | null | undefined,
  fallback?: { readonly input?: number; readonly context: number },
): MeterModel | undefined {
  if (view) {
    const window = view.windowTokens
    const used = view.P
    const trigger = view.triggerTokens
    const session = view.sessionTriggerTokens
    const marks: MeterMark[] =
      session === null
        ? [{ at: share(trigger, window), strong: true }]
        : [
            { at: share(view.slotTriggerTokens, window), strong: view.slotTriggerTokens <= session },
            { at: share(session, window), strong: session < view.slotTriggerTokens },
          ]
    return {
      mode: "router",
      window,
      used,
      trigger,
      slotTrigger: view.slotTriggerTokens,
      sessionTrigger: session,
      fill: used === null ? 0 : share(used, window),
      marks,
      tone: tone(used, trigger),
      remaining: view.remainingTokens,
      source: view.source,
    }
  }
  const limit = fallback ? fallback.input || fallback.context : 0
  if (!limit) return undefined
  // Core's ceiling of `limit.input ‖ limit.context` (`Compaction.ceiling`); P is unknown here. A compat slot registers
  // `limit.input` above its window to keep that ceiling at 90% (`Compaction.ceilingOf`), so the window is the smaller
  // of the two.
  const trigger = Compaction.ceiling(limit)
  const window = Math.min(limit, fallback?.context || limit)
  return {
    mode: "fallback",
    window,
    used: null,
    trigger,
    slotTrigger: trigger,
    sessionTrigger: null,
    fill: 0,
    marks: [{ at: share(trigger, window), strong: true }],
    tone: "neutral",
    remaining: null,
  }
}

function share(value: number, window: number) {
  return window > 0 ? Math.min(1, Math.max(0, value / window)) : 0
}

function tone(used: number | null, trigger: number): MeterModel["tone"] {
  if (used === null) return "neutral"
  if (used >= trigger) return "over"
  if (used >= WARN_SHARE * trigger) return "warn"
  return "neutral"
}

/** Hover text (03 §4.4): `문맥 118k / 272k · 자동 압축 245k (v2 기본) · 이 세션: 200k에서 압축 · 다음 압축까지 약 127k`. */
export function meterTitle(i18n: I18n, model: MeterModel) {
  if (model.mode === "fallback")
    return `${i18n.t("own.ctx.fallback", {
      window: formatTokens(model.window),
      trigger: formatTokens(model.trigger),
    })} · ${i18n.t("own.compact.noRouter")}`
  const parts = [
    i18n.t("own.ctx.meter", {
      used: model.used === null ? "—" : formatTokens(model.used),
      window: formatTokens(model.window),
      trigger: formatTokens(model.trigger),
      source: model.source ? i18n.t(`own.compact.source.${model.source}`) : "",
    }),
  ]
  if (model.sessionTrigger !== null)
    parts.push(i18n.t("own.ctx.meterSession", { tokens: formatTokens(model.sessionTrigger) }))
  if (model.remaining !== null && model.remaining > 0)
    parts.push(i18n.t("own.ctx.remaining", { tokens: formatTokens(model.remaining) }))
  return parts.join(" · ")
}

/** Screen reader text (03 §5.8.3): `문맥 118k, 창 272k 중 43%. 자동 압축은 245k에서, 남은 양 127k.` */
export function meterSpeech(i18n: I18n, model: MeterModel) {
  if (model.used === null) return meterTitle(i18n, model)
  return i18n.t("own.ctx.speech", {
    used: formatTokens(model.used),
    window: formatTokens(model.window),
    percent: Math.round(model.fill * 100),
    trigger: formatTokens(model.trigger),
    remaining: formatTokens(model.remaining ?? Math.max(0, model.trigger - model.used)),
  })
}
