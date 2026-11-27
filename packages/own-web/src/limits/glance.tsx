// One account's limits in the space of a bar (03 §7.2, 설정 > 일반 > 한도 표시): the sidebar's 사용 중 계정 and the
// composer button (the cards, the 계정·한도 tab and the switcher rows use the lazy ./summary). It leads with the same
// window as every other surface (./windows `ranked`): `detailed` draws the first two (`주간 ▰▱▱ 남음 19%`, `5시간 ▰▰▱
// 남음 62%`), `simple` the first one, `minimal` a ring and its number. A window known only as blocked draws an empty
// bar and `차단`; a balance writes its amount without a bar. Every window of the account is in the hover text; the
// composer's switcher shows the rest. First-chunk safe: no kit imports, its styles are ./glance.css.
//
// `layout="rows"` (the sidebar at 자세히, UX 2026-10-26) stacks the windows as a grid of label | bar | value, so the
// bars line up from row to row (and across accounts where the parent shares its columns, sidebar/accounts-in-use); a
// balance keeps its empty bar cell. `labels` names each window (default: at `detailed` only; the sidebar names them
// at 간단히 too, `5시간 ▬ 남음 58%`, while 아주 간단히 stays the ring and `58%`).
import type { Limit } from "@own/protocol"
import { For, Show } from "solid-js"
import { useI18n } from "@/i18n"
import { fill, limitNumber, limitSpeech, windowValue, windowsTitle, type LimitDensity, type LimitMode } from "./display"
import { ranked, type WindowView } from "./windows"
import "./glance.css"

export function LimitGlance(props: {
  readonly windows: readonly Limit.Window[] | undefined
  readonly density: LimitDensity
  readonly now: () => number
  /** Override the stored mode (settings preview). */
  readonly mode?: LimitMode
  /** The session's model: its model weekly bucket may lead (./windows `ranked`). */
  readonly model?: string
  /** `inline` (default): the windows side by side; `rows`: one per row on a shared label | bar | value grid. */
  readonly layout?: "inline" | "rows"
  /** Name each window (default: at `detailed`). The ring of `minimal` never carries a name. */
  readonly labels?: boolean
  /**
   * `rows` only: take the parent grid's label | bar | value tracks after its first column (the account's dot), so
   * the bars of every account line up (sidebar/accounts-in-use at 자세히).
   */
  readonly subgrid?: boolean
  readonly testid?: string
}) {
  const i18n = useI18n()
  const items = () =>
    ranked(props.windows ?? [], props.now(), props.model).slice(0, props.density === "detailed" ? 2 : 1)
  const layout = () => props.layout ?? "inline"
  const labels = () => props.density !== "minimal" && (props.labels ?? props.density === "detailed")
  // A blocked window known only by its state has no room left: an empty bar in `remaining` mode, a full one in `used`.
  const used = (item: WindowView) => item.percent ?? 100
  const value = (item: WindowView) =>
    props.density === "minimal" && item.percent !== undefined
      ? limitNumber(item.percent, props.mode)
      : windowValue(i18n, item, props.mode)
  return (
    <Show when={items().length}>
      <span
        class="own-glance"
        data-density={props.density}
        data-layout={layout()}
        data-subgrid={layout() === "rows" && props.subgrid ? "" : undefined}
        title={windowsTitle(i18n, props.windows ?? [], props.now(), props.mode)}
        data-testid={props.testid ?? "limit-glance"}
      >
        <For each={items()}>
          {(item) => (
            <span class="own-glance-item" data-window={item.id} data-tone={item.tone}>
              <Show when={labels()}>
                <span class="own-glance-label" aria-hidden="true">
                  {item.label}
                </span>
              </Show>
              <Show
                when={item.percent !== undefined || item.remaining === undefined}
                fallback={
                  <Show when={layout() === "rows"}>
                    <span class="own-glance-gap" aria-hidden="true" />
                  </Show>
                }
              >
                <Show
                  when={props.density === "minimal"}
                  fallback={
                    <span
                      class="own-glance-bar"
                      data-tone={item.tone}
                      data-hatched={item.hatched ? "" : undefined}
                      data-faded={item.faded ? "" : undefined}
                      aria-hidden="true"
                    >
                      <span style={{ width: `${fill(used(item), props.mode)}%` }} />
                    </span>
                  }
                >
                  <span
                    class="own-glance-ring"
                    data-tone={item.tone}
                    data-faded={item.faded ? "" : undefined}
                    style={{ "--own-glance-fill": `${fill(used(item), props.mode)}%` }}
                    aria-hidden="true"
                  />
                </Show>
              </Show>
              <span class="own-glance-value own-num" data-tone={item.tone} aria-hidden="true">
                {value(item)}
              </span>
              <span class="sr-only">
                {item.label}{" "}
                {item.percent === undefined
                  ? windowValue(i18n, item, props.mode)
                  : limitSpeech(i18n, item.percent, props.mode)}
              </span>
            </span>
          )}
        </For>
      </span>
    </Show>
  )
}
