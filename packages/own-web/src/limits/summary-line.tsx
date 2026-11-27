// The limits summary's folded line (03 §7.2, LV 2026-10-24), on its own so the switcher rows take it without the
// unfolded rows (./meter, ./kit): the switcher's listbox options cannot hold the summary's button. Lazy.
import type { Limit } from "@own/protocol"
import { For, Show } from "solid-js"
import { useI18n } from "@/i18n"
import { windowsTitle } from "./display"
import { foldedGroups, foldedParts } from "./summary-model"
import { useLimitSummaryText } from "./summary-strings"
import "./summary.css"

/**
 * The folded line: `주간 남음 26% (3일 4시간 후 리셋) · 5시간 남음 98%` (the first window's reset attached to it, faint and
 * in parentheses, UX 2026-10-26), a Claude billing verdict last, `— 알 수 없음` when no window has a value. Each window
 * with its reset is one unbreakable group that carries its `·` before it; the line clips the one that would start a
 * wrapped line (styles/seps.css `.own-seps`), so no line starts or ends with a separator. `lead` keeps the first window
 * alone, without its reset (the head of an unfolded summary, whose rows show the rest).
 */
export function LimitSummaryLine(props: {
  readonly windows: readonly Limit.Window[] | undefined
  readonly now: () => number
  /** Windows to name (default two). */
  readonly max?: number
  /** The session's or the row's model: its model weekly bucket may lead (./windows `ranked`). */
  readonly model?: string
  /** Only the leading window's `{label} {value}`. */
  readonly lead?: boolean
  readonly testid?: string
}) {
  const i18n = useI18n()
  const t = useLimitSummaryText()
  const groups = () => {
    const all = foldedGroups(
      foldedParts(i18n, props.windows ?? [], props.now(), props.max ?? 2, undefined, props.model),
    )
    return props.lead ? all.slice(0, 1).map((group) => ({ part: group.part, reset: undefined })) : all
  }
  return (
    <span
      class="own-lsum-line own-seps"
      title={windowsTitle(i18n, props.windows ?? [], props.now())}
      data-testid={props.testid ?? "limit-summary-line"}
    >
      <span class="own-seps-in">
        <For
          each={groups()}
          fallback={
            <span class="own-lsum-group">
              <span class="own-lsum-part" data-role="unknown">
                {i18n.t("own.limit.unknown")}
              </span>
            </span>
          }
        >
          {(group) => (
            <span class="own-lsum-group">
              <span
                class="own-lsum-part"
                data-role={group.part.role}
                data-tone={group.part.tone}
                data-window={group.part.role === "window" ? group.part.key : undefined}
              >
                {group.part.text}
              </span>
              <Show when={group.reset}>
                {(reset) => (
                  <>
                    {" "}
                    <span class="own-lsum-part" data-role="reset">
                      {t("own.lim.sum.reset", { reset: reset().text })}
                    </span>
                  </>
                )}
              </Show>
            </span>
          )}
        </For>
      </span>
    </span>
  )
}
