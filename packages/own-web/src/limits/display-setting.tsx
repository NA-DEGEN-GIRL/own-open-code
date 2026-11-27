// 설정 > 일반 > 한도 표시 (03 §5.7, §7.2): the value (남은 양 by default / 쓴 양), the density of the accounts pages and
// of the lists, and a live preview of every density with sample windows in the chosen value: the summary the cards,
// the 계정·한도 tab and the dashboard show (./summary, LV 2026-10-24) and the bar the sidebar and the composer show
// (./glance). Lazy with the settings page; the setting itself is ./display, its words ./summary-strings.
import type { Limit } from "@own/protocol"
import { For } from "solid-js"
import { useI18n, type I18n } from "@/i18n"
import { minuteNow } from "@/shell/clock"
import {
  LIMIT_DENSITIES,
  LIMIT_MODES,
  LIMIT_SURFACES,
  limitDensity,
  limitMode,
  resetLimitDisplay,
  setLimitDensity,
  setLimitMode,
  type LimitDensity,
} from "./display"
import { LimitGlance } from "./glance"
import { Dot, Segmented, Tag } from "./kit"
import { AccountLimits } from "./summary"
import { useLimitSummaryText } from "./summary-strings"

const MIN = 60_000

export function LimitDisplaySetting() {
  const i18n = useI18n()
  const t = useLimitSummaryText()
  const sample = () => sampleWindows(i18n, minuteNow())
  return (
    <div class="flex flex-col gap-2.5 border-b border-own-border py-3" data-testid="settings-limits">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div class="min-w-[220px] flex-1">
          <b class="block text-[13.5px] font-semibold">{t("own.set.limits")}</b>
          <span class="text-[12px] text-own-muted">{t("own.set.limits.note")}</span>
        </div>
        <Segmented
          label={t("own.set.limits.mode")}
          value={limitMode()}
          options={LIMIT_MODES.map((mode) => ({ value: mode, label: t(`own.set.limits.mode.${mode}`) }))}
          onChange={setLimitMode}
          testid="settings-limits-mode"
        />
      </div>
      <For each={LIMIT_SURFACES}>
        {(surface) => (
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div class="min-w-[220px] flex-1">
              <span class="block text-[13px]">{t(`own.set.limits.surface.${surface}`)}</span>
              <span class="text-[12px] text-own-muted">{t(`own.set.limits.surface.${surface}Note`)}</span>
            </div>
            <Segmented
              label={t(`own.set.limits.surface.${surface}`)}
              value={limitDensity(surface)}
              options={LIMIT_DENSITIES.map((density) => ({
                value: density,
                label: t(`own.set.limits.density.${density}`),
              }))}
              onChange={(density) => setLimitDensity(surface, density)}
              testid={`settings-limits-${surface}`}
            />
          </div>
        )}
      </For>
      <div>
        <span class="mb-1.5 block text-[12px] font-semibold text-own-muted">{t("own.set.limits.preview")}</span>
        <div
          class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2"
          aria-live="polite"
          data-testid="settings-limits-preview"
        >
          <For each={LIMIT_DENSITIES}>{(density) => <PreviewCard density={density} windows={sample()} />}</For>
        </div>
      </div>
      <div>
        <button
          type="button"
          class="own-link text-[12px]"
          onClick={resetLimitDisplay}
          data-testid="settings-limits-reset"
        >
          {t("own.set.limits.reset")}
        </button>
      </div>
    </div>
  )
}

/** One density with the sample account, tagged with the surfaces that use it now. */
function PreviewCard(props: { readonly density: LimitDensity; readonly windows: readonly Limit.Window[] }) {
  const t = useLimitSummaryText()
  const surfaces = () => LIMIT_SURFACES.filter((surface) => limitDensity(surface) === props.density)
  return (
    <section
      class={`rounded-lg border p-2.5 ${surfaces().length ? "border-own-border-strong" : "border-own-border"}`}
      aria-label={`${t("own.set.limits.preview")}: ${t(`own.set.limits.density.${props.density}`)}`}
      data-density={props.density}
      data-testid="settings-limits-sample"
    >
      <div class="mb-2 flex flex-wrap items-center gap-1.5">
        <b class="text-[12.5px]">{t(`own.set.limits.density.${props.density}`)}</b>
        <For each={surfaces()}>{(surface) => <Tag tone="soft">{t(`own.set.limits.surface.${surface}`)}</Tag>}</For>
      </div>
      {/* The sidebar's 사용 중 계정 line (sidebar/accounts-in-use): windows named at 간단히 too, and at 자세히 the name
          on its own row with the bars under it, indented to the name. */}
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px]">
        <Dot color="teal" />
        <span class="min-w-0 flex-[1_1_7em] truncate">{t("own.set.limits.previewAccount")}</span>
        <span class={props.density === "detailed" ? "basis-full pl-4" : "ml-auto"}>
          <LimitGlance
            windows={props.windows}
            density={props.density}
            now={minuteNow}
            layout={props.density === "detailed" ? "rows" : "inline"}
            labels
          />
        </span>
      </div>
      <div class="mt-1.5">
        <AccountLimits windows={props.windows} surface="accounts" density={props.density} now={minuteNow} />
      </div>
      <p class="m-0 mt-2 text-[11.5px] leading-4 text-own-faint">{t(`own.set.limits.describe.${props.density}`)}</p>
    </section>
  )
}

/** Sample windows: a 5-hour window with room left and a weekly one in the warning band (the same in both modes). */
export function sampleWindows(i18n: Pick<I18n, "t">, now: number): Limit.Window[] {
  const base = {
    accountID: "acc_preview" as Limit.Window["accountID"],
    providerID: "own-preview" as Limit.Window["providerID"],
    scope: "account",
    kind: "rolling_quota",
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: now - MIN,
  } as const
  return [
    {
      ...base,
      id: "preview.primary",
      label: i18n.t("own.limit.5h"),
      windowMinutes: 300,
      usedPercent: 38,
      resetAt: now + 134 * MIN,
    },
    {
      ...base,
      id: "preview.secondary",
      label: i18n.t("own.limit.weekly"),
      windowMinutes: 10_080,
      usedPercent: 81,
      status: "warning",
      resetAt: now + 3 * 24 * 60 * MIN,
    },
  ]
}
