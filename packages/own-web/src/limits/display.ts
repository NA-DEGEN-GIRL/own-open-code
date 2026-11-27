// How limit windows are drawn (03 §7.2, 설정 > 일반 > 한도 표시): the remaining share by default (a bar that starts
// full and shrinks, `남음 62%`) or the used share (`사용 38%`), and how much of each account a surface shows (자세히 /
// 간단히 / 아주 간단히), separately for the accounts pages and for the lists (switcher, 계정·한도 tab, sidebar,
// composer). Per viewer in localStorage like the theme, the list density and the timeline preset: there is no
// synced UI-preference store, and a phone may well want a sparser view than the PC. Other windows of the same origin
// follow through the `storage` event. First-chunk safe: no component imports.
//
// The router always reports the used share (`usedPercent`, 02 §7.3); everything here derives the displayed value
// from it. Colors do not depend on the mode (./windows `tone`, keyed on what remains).
import { createRoot, createSignal } from "solid-js"
import type { Limit } from "@own/protocol"
import type { I18n } from "@/i18n"
import { ago, amount, percent, resetText } from "./format"
import { primary, stateOnly, view, type WindowView } from "./windows"

export const LIMIT_MODES = ["remaining", "used"] as const
export type LimitMode = (typeof LIMIT_MODES)[number]

export const LIMIT_DENSITIES = ["detailed", "simple", "minimal"] as const
export type LimitDensity = (typeof LIMIT_DENSITIES)[number]

/** `accounts`: the 계정 page cards, the Claude card and the /limits cards. `lists`: switcher rows, 계정·한도 tab, sidebar, composer. */
export const LIMIT_SURFACES = ["accounts", "lists"] as const
export type LimitSurface = (typeof LIMIT_SURFACES)[number]

export interface LimitDisplay {
  readonly mode: LimitMode
  readonly density: Readonly<Record<LimitSurface, LimitDensity>>
}

/**
 * Remaining by default (falling values read more naturally). Every surface starts folded (LV 2026-10-24): the two
 * tightest windows and the reset on one line that unfolds every window on click (./summary), one bar in the sidebar and
 * the composer (./glance).
 */
export const DEFAULT_LIMIT_DISPLAY: LimitDisplay = {
  mode: "remaining",
  density: { accounts: "simple", lists: "simple" },
}

export const LIMIT_DISPLAY_KEY = "own.web.limits.display"

/** A stored value (JSON text or parsed) to a full setting; unknown or missing parts take the defaults. */
export function parseLimitDisplay(value: unknown): LimitDisplay {
  const parsed = typeof value === "string" ? json(value) : value
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  const density =
    record.density && typeof record.density === "object" ? (record.density as Record<string, unknown>) : {}
  return {
    mode: LIMIT_MODES.find((mode) => mode === record.mode) ?? DEFAULT_LIMIT_DISPLAY.mode,
    density: {
      accounts: LIMIT_DENSITIES.find((item) => item === density.accounts) ?? DEFAULT_LIMIT_DISPLAY.density.accounts,
      lists: LIMIT_DENSITIES.find((item) => item === density.lists) ?? DEFAULT_LIMIT_DISPLAY.density.lists,
    },
  }
}

const store = createRoot(() => {
  const [display, setDisplay] = createSignal(parseLimitDisplay(read()))
  if (typeof window === "object")
    window.addEventListener("storage", (event) => {
      if (event.key === LIMIT_DISPLAY_KEY) setDisplay(parseLimitDisplay(event.newValue))
    })
  return { display, setDisplay }
})

/** The current setting (reactive). */
export const limitDisplay = store.display

export const limitMode = () => store.display().mode

export const limitDensity = (surface: LimitSurface) => store.display().density[surface]

export function setLimitMode(mode: LimitMode) {
  save({ ...store.display(), mode })
}

export function setLimitDensity(surface: LimitSurface, density: LimitDensity) {
  save({ ...store.display(), density: { ...store.display().density, [surface]: density } })
}

/** Back to the defaults (also clears the stored value). */
export function resetLimitDisplay() {
  store.setDisplay(DEFAULT_LIMIT_DISPLAY)
  try {
    localStorage.removeItem(LIMIT_DISPLAY_KEY)
  } catch {}
}

function save(next: LimitDisplay) {
  store.setDisplay(next)
  try {
    localStorage.setItem(LIMIT_DISPLAY_KEY, JSON.stringify(next))
  } catch {}
}

function read() {
  try {
    return localStorage.getItem(LIMIT_DISPLAY_KEY)
  } catch {
    return null
  }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---- pure helpers: every surface draws through these ----

/** The share left of a used percent, clamped to 0..100. */
export function remainingOf(used: number) {
  return Math.min(100, Math.max(0, 100 - used))
}

/** The number a surface writes: the remaining share in `remaining` mode, else the used share as reported. */
export function shown(used: number, mode: LimitMode = limitMode()) {
  return mode === "remaining" ? remainingOf(used) : used
}

/** Bar fill width (0..100): full and shrinking in `remaining` mode, empty and growing in `used` mode. */
export function fill(used: number, mode: LimitMode = limitMode()) {
  return Math.min(100, Math.max(0, shown(used, mode)))
}

/** The visible value: `남음 62%` / `사용 38%` (`62% left` / `38% used`). */
export function limitText(i18n: I18n, used: number, mode: LimitMode = limitMode()) {
  return i18n.t(mode === "remaining" ? "own.lim.left" : "own.lim.used", { percent: percent(shown(used, mode)) })
}

/** The bare number for the sparsest view (`62%`); its mode is spelled out by {@link limitSpeech}. */
export function limitNumber(used: number, mode: LimitMode = limitMode()) {
  return percent(shown(used, mode))
}

/** The screen-reader amount, always explicit: `62% 남음` / `38% 사용` (`62% left` / `38% used`). */
export function limitSpeech(i18n: I18n, used: number, mode: LimitMode = limitMode()) {
  return i18n.t(mode === "remaining" ? "own.lim.leftSpeech" : "own.lim.usedSpeech", {
    percent: percent(shown(used, mode)),
  })
}

/**
 * A window's value on every surface (7.2): `남음 62%` (or `사용 38%`), an amount (`¥12.30`), the state of a window known
 * only by it ({@link stateWord}), or `— 알 수 없음`.
 */
export function windowValue(i18n: I18n, item: WindowView, mode?: LimitMode) {
  if (item.percent !== undefined) return limitText(i18n, item.percent, mode)
  if (item.remaining !== undefined && !item.unknown) return amount(item.remaining, item.unit)
  if (stateOnly(item)) return stateWord(i18n, item.status)
  return i18n.t("own.limit.unknown")
}

/** `허용` / `주의` / `차단` (03 §7.1), for a window known only by its state. */
export function stateWord(i18n: I18n, status: Limit.Status) {
  if (status === "exhausted") return i18n.t("own.limit.state.exhausted")
  return i18n.t(status === "warning" ? "own.limit.state.warning" : "own.limit.state.ok")
}

/**
 * 7.2 screen reader sentence, explicit about the mode: `5시간 한도 38% 남음, 2시간 14분 후 리셋, 1분 전 관측`
 * (remaining) or `5시간 한도 62% 사용, …` (used).
 */
export function valueText(i18n: I18n, item: WindowView, now: number, mode?: LimitMode) {
  const value = item.percent === undefined ? i18n.t("own.conf.unknown") : limitSpeech(i18n, item.percent, mode)
  const reset = resetOf(i18n, item, now)
  return i18n.t("own.lim.aria", {
    label: item.label,
    amount: value,
    reset: reset ? `, ${reset}` : "",
    observed: ago(i18n, now, item.observedAt),
  })
}

/**
 * Hover text of every folded view (the glance, the summary line): every window but the per-minute ones, one line each
 * (`5시간 남음 62% · 2시간 14분 후 리셋`, `주간 · Opus 차단 · 월 오전 9:00 리셋`); a model weekly bucket names its model in
 * its label.
 */
export function windowsTitle(i18n: I18n, windows: readonly Limit.Window[], now: number, mode?: LimitMode) {
  return primary(windows)
    .map((window) => view(window, now))
    .map((item) =>
      [`${item.label} ${windowValue(i18n, item, mode)}`, resetOf(i18n, item, now)].filter(Boolean).join(" · "),
    )
    .join("\n")
}

/** A window's reset as the folded views write it: `2시간 14분 후 리셋`, `월 오전 9:00 리셋`, `리셋됨(추정)`. */
export function resetOf(i18n: I18n, item: WindowView, now: number) {
  if (item.resetEstimated) return i18n.t("own.limit.resetEstimated")
  return item.resetAt ? resetText(i18n, now, item.resetAt) : undefined
}
