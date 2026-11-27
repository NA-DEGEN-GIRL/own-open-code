// Account chip and model name (03 §1 "계정 칩", §4.3 row line 2, §5.2.1 variants): `[● 개인 Pro] GPT-5.6 Sol`,
// `◌ 기본 openai · 전역 계정 ⚠` (built-in provider), `◌ 기본값(미고정) ⚠` (unpinned), plus `비공식` for third-party
// slots. Accounts are told apart by color dot and always by name (11장).
import { Match, Show, Switch } from "solid-js"
import type { Account } from "@own/protocol"
import { useI18n } from "@/i18n"
import type { ChipView } from "./model"
import { useSidebarText } from "./strings"

export function AccountDot(props: { readonly color: Account.Color }) {
  return (
    <span
      class="inline-block size-2 flex-none rounded-full [filter:var(--own-dot-filter)]"
      style={{ background: `var(--own-account-${props.color})` }}
      aria-hidden="true"
    />
  )
}

const CHIP =
  "own-chip inline-flex max-w-full min-w-0 flex-none items-center gap-[5px] overflow-hidden rounded-[var(--own-radius-chip)] text-[12px] leading-[18px] whitespace-nowrap"

export function AccountChip(props: {
  readonly view: ChipView
  /** Subagent rows: the child runs on another account than its parent (4.3). */
  readonly strong?: boolean
  /** Compact density: dot and the first two characters of the name (4.3). */
  readonly compact?: boolean
}) {
  const i18n = useI18n()
  const text = useSidebarText()
  return (
    <Switch>
      <Match when={props.view.kind === "account" && props.view}>
        {(view) => (
          <>
            <span
              class={`${CHIP} bg-own-hover py-0 pr-[7px] pl-[6px] text-own-text`}
              classList={{
                "font-semibold": props.strong,
                "shadow-[inset_0_0_0_1px_var(--own-danger)]": view().problem,
              }}
              data-testid="account-chip"
              data-account-id={view().account.id}
              title={view().account.label}
            >
              <AccountDot color={view().account.color} />
              <span class="min-w-0 truncate">
                {props.compact ? Array.from(view().account.label).slice(0, 2).join("") : view().account.label}
              </span>
              <Show when={view().problem}>
                <span class="font-extrabold text-own-danger" role="img" aria-label={text("own.sidebar.chip.problem")}>
                  !
                </span>
              </Show>
            </span>
            <Show when={view().account.thirdParty && !props.compact}>
              <span class="flex-none rounded border border-own-border px-1 text-[10.5px] leading-[16px] text-own-muted">
                {text("own.sidebar.unofficial")}
              </span>
            </Show>
          </>
        )}
      </Match>
      <Match when={props.view.kind === "builtin" && props.view}>
        {(view) => (
          <span
            class={`${CHIP} border border-dashed border-own-border-strong px-1.5 text-own-muted`}
            data-testid="account-chip"
            data-chip="builtin"
            title={i18n.t("own.binding.builtinWarn")}
          >
            <span aria-hidden="true">◌</span>
            <span class="min-w-0 truncate">{i18n.t("own.binding.builtin", { provider: view().provider })}</span>
            <span class="text-own-warn" aria-hidden="true">
              ⚠
            </span>
          </span>
        )}
      </Match>
      <Match when={props.view.kind === "unpinned"}>
        <span
          class={`${CHIP} border border-dashed border-own-border-strong px-1.5 text-own-muted`}
          data-testid="account-chip"
          data-chip="unpinned"
          title={i18n.t("own.binding.unpinnedWarn")}
        >
          <span aria-hidden="true">◌</span>
          <span class="min-w-0 truncate">{i18n.t("own.binding.unpinned")}</span>
          <span class="text-own-warn" aria-hidden="true">
            ⚠
          </span>
        </span>
      </Match>
      <Match when={props.view.kind === "loading"}>
        <span class="inline-block h-[14px] w-12 flex-none rounded bg-own-hover" aria-hidden="true" />
      </Match>
    </Switch>
  )
}
