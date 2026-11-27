// The limits summary (03 §7.2, LV 2026-10-24) on every surface that shows an account's limits: the 계정 cards, the
// 계정·한도 tab rows and the dashboard cards fold an account's windows into one line that unfolds in place
// ({@link AccountLimits}); the switcher rows are listbox options that cannot hold a button, so they show the line
// alone (./summary-line, every window in its hover text). 설정 > 일반 > 한도 표시 decides how a summary starts:
// `자세히` unfolded, `간단히` with the two tightest windows, `아주 간단히` with the tightest one. The words are
// ./summary-model's. Lazy: the first chunk keeps ./glance for the sidebar and the composer. On the 계정 and `/limits`
// cards (`resetCredits`) a ChatGPT subscription's 리셋권 line follows the summary and a Claude account's unfolded
// limits end with the claude.ai note (./reset-credits, 03 §7.1.1).
import type { Account, Limit } from "@own/protocol"
import { createSignal, createUniqueId, Show } from "solid-js"
import { limitDensity, type LimitDensity, type LimitSurface } from "./display"
import { LimitMeterGroup } from "./meter"
import { ClaudeResetNote, ResetCreditLine } from "./reset-credits"
import { LimitSummaryLine } from "./summary-line"
import { useLimitSummaryText } from "./summary-strings"

/** Windows a folded line names per density. */
const FOLDED: Readonly<Record<LimitDensity, number>> = { detailed: 2, simple: 2, minimal: 1 }

/**
 * An account's limits: the folded line as a button that unfolds every window in place (bar, `남음 %`, reset with the
 * clock time, the observation tag; Claude's state-only windows and billing verdict; per-minute rate windows with
 * `rates`). The unfolded rows keep the reset and the tag under the bar on every surface and share their label and
 * value columns, so the bars line up whatever the label or the reset text (./summary.css). An account without windows
 * shows {@link LimitMeterGroup}'s empty text (Sign in with ChatGPT: the hedged no-limits note).
 */
export function AccountLimits(props: {
  readonly windows: readonly Limit.Window[] | undefined
  readonly surface: LimitSurface
  readonly now: () => number
  readonly kind?: Account.View["kind"]
  /** Unfold the per-minute rate windows too. */
  readonly rates?: boolean
  /** The session's model, where the surface has one: its model weekly bucket may lead (./windows `ranked`). */
  readonly model?: string
  /** Override the stored density (the settings preview). */
  readonly density?: LimitDensity
  /**
   * The account, on the surfaces that show its reset credits (03 §7.1.1: the 계정 cards and the `/limits` cards): a
   * ChatGPT subscription's `리셋권` line, Claude's link-only note once unfolded.
   */
  readonly resetCredits?: string
}) {
  const t = useLimitSummaryText()
  const density = () => props.density ?? limitDensity(props.surface)
  const [open, setOpen] = createSignal(density() === "detailed")
  const body = createUniqueId()
  return (
    <>
      <Show
        when={props.windows?.length}
        fallback={<LimitMeterGroup windows={props.windows} kind={props.kind} now={props.now} />}
      >
        <div class="own-lsum" data-open={open() ? "" : undefined} data-density={density()} data-testid="limit-summary">
          <button
            type="button"
            class="own-lsum-head"
            aria-expanded={open()}
            aria-controls={open() ? body : undefined}
            data-testid="limit-summary-toggle"
            onClick={() => setOpen((value) => !value)}
          >
            {/* Unfolded, the rows say everything: the head keeps the tightest value alone and says how to fold it
                (UX 2026-10-26: at 자세히 no other value showed twice). */}
            <LimitSummaryLine
              windows={props.windows}
              now={props.now}
              max={FOLDED[density()]}
              model={props.model}
              lead={open()}
            />
            <Show when={open()} fallback={<span class="sr-only">{t("own.lim.sum.show")}</span>}>
              <span class="own-lsum-hide">{t("own.lim.sum.hide")}</span>
            </Show>
          </button>
          <Show when={open()}>
            <div id={body} class="own-lsum-body" data-testid="limit-summary-body">
              <LimitMeterGroup
                windows={props.windows}
                rates={props.rates}
                kind={props.kind}
                model={props.model}
                clock
                now={props.now}
              />
              <Show when={props.resetCredits !== undefined && props.kind === "claude-sub"}>
                <ClaudeResetNote />
              </Show>
            </div>
          </Show>
        </div>
      </Show>
      {/* Under the summary, folded or not; an account without windows has no unfolded view. */}
      <Show when={props.kind === "codex" && props.resetCredits}>
        {(accountID) => <ResetCreditLine accountID={accountID()} expanded={open() && !!props.windows?.length} />}
      </Show>
    </>
  )
}
