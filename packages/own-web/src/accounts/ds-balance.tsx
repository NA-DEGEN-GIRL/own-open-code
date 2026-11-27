// DeepSeek balance actions (03 §5.4, 02 §7.2): `충전 · 사용량` on a `ds` account card, and the session banner of a `ds`
// account the router stopped for a 402 (top up, or switch). The balance and its 보너스 part are limit windows the
// card already draws (`ds.balance`, `ds.balance.granted`). Both links are plain browser pages on the DeepSeek
// platform; nothing of the account is sent with them, and the user signs in there.
import { Show } from "solid-js"
import type { ServerKey } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { openSwitcher } from "@/limits/intents"

export const TOP_UP_URL = "https://platform.deepseek.com/top_up"
export const USAGE_URL = "https://platform.deepseek.com/usage"

/**
 * The reason the router names in `account.status{reason}` when DeepSeek answers 402 Insufficient Balance (telemetry
 * classify `status_402`); it leaves with the next `ready`. shell/session-banners.tsx repeats it inline so the first
 * chunk does not load this file.
 */
export const BALANCE_CODE = "status_402"

/** `충전 · 사용량` on a DeepSeek account card. */
export function DsBalanceLinks() {
  const host = useHost()
  const i18n = useI18n()
  return (
    <span class="flex flex-wrap items-center gap-1" data-testid="ds-balance-links">
      <button type="button" class="own-link" onClick={() => host.openExternal(TOP_UP_URL)} data-testid="ds-top-up">
        {i18n.t("own.ds.topUp")}
      </button>
      <span aria-hidden="true">·</span>
      <button type="button" class="own-link" onClick={() => host.openExternal(USAGE_URL)} data-testid="ds-usage">
        {i18n.t("own.ds.usage")}
      </button>
    </span>
  )
}

/**
 * Session banner of a DeepSeek account out of balance (402): top up first, or switch with the switcher. It promises
 * no time: the account comes back with the router's next `ready`.
 */
export function DsBalanceBanner(props: {
  readonly account: string
  readonly serverKey?: ServerKey
  readonly sessionID?: string
}) {
  const host = useHost()
  const i18n = useI18n()
  return (
    <div class="own-notice" data-tone="danger" role="alert" data-testid="ds-balance-out">
      <span class="font-extrabold" aria-hidden="true">
        !
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 font-semibold">{i18n.t("own.ds.balanceOut", { account: props.account })}</p>
        <p class="m-0 mt-0.5 text-own-muted">{i18n.t("own.ds.balanceOutHelp")}</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            onClick={() => host.openExternal(TOP_UP_URL)}
            data-testid="ds-balance-top-up"
          >
            {i18n.t("own.ds.topUp")}
          </button>
          <Show when={props.serverKey && props.sessionID}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => openSwitcher({ serverKey: props.serverKey!, sessionID: props.sessionID! })}
            >
              {i18n.t("own.action.switchOther")}
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
