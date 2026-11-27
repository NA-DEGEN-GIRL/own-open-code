// The Claude cards' extra-usage warning (02 §8.9, 03 §5.4.1(d), user decision CW 2026-10-19 "경고 보이고 확인하기"):
// an info line that never goes away, the billing state the account's responses revealed (`claude.overage`
// `meta.billing`), and `자세히` with the dates, what the app can and cannot tell, how to check on claude.ai, and the
// sources. The links open in the browser through the host; nothing of the account goes with them.
import type { Limit } from "@own/protocol"
import { For, Show } from "solid-js"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { Notice } from "@/limits/kit"
import { ago } from "@/limits/format"
import { minuteNow } from "@/shell/clock"
import { billingOf, SOURCES, USAGE_URL } from "./claude-billing"
import { useClaudeBillingText, type ClaudeBillingKey } from "./claude-billing-strings"

const STATE_LABEL = {
  extra_usage: "own.claude.billing.extraUsage",
  rejected: "own.claude.billing.rejected",
} as const satisfies Record<string, ClaudeBillingKey>

export function ClaudeBillingNotice(props: { readonly windows: readonly Limit.Window[] | undefined }) {
  const host = useHost()
  const i18n = useI18n()
  const t = useClaudeBillingText()
  const billing = () => billingOf(props.windows)
  return (
    <div class="mt-2" data-testid="claude-billing">
      <p class="m-0 text-[12.5px] leading-[18px] text-own-warn" data-testid="claude-billing-line">
        {t("own.claude.billing.line")}
      </p>
      <Show when={billing()}>
        {(current) => (
          <div class="mt-1.5">
            <Notice tone={current().state === "rejected" ? "danger" : "warn"} testid="claude-billing-state">
              <span data-state={current().state}>{t(STATE_LABEL[current().state])}</span>
              <span class="text-own-muted">
                {" · "}
                {t("own.claude.billing.seen", { ago: ago(i18n, minuteNow(), current().observedAt) })}
              </span>
            </Notice>
          </div>
        )}
      </Show>
      <details class="mt-1.5 text-[12.5px] leading-[18px]" data-testid="claude-billing-more">
        <summary class="cursor-pointer text-own-muted">{t("own.claude.billing.more")}</summary>
        <div class="mt-1.5 flex flex-col gap-2" lang="ko">
          <section>
            <h4 class="m-0 text-[12.5px] font-semibold">{t("own.claude.billing.datesTitle")}</h4>
            <ul class="m-0 mt-1 flex list-disc flex-col gap-0.5 pl-5">
              <li>{t("own.claude.billing.date.safeguard")}</li>
              <li>{t("own.claude.billing.date.terms")}</li>
              <li>{t("own.claude.billing.date.policy")}</li>
              <li>{t("own.claude.billing.date.help")}</li>
            </ul>
          </section>
          <section>
            <h4 class="m-0 text-[12.5px] font-semibold">{t("own.claude.billing.knowTitle")}</h4>
            <ul class="m-0 mt-1 flex list-disc flex-col gap-0.5 pl-5">
              <li>{t("own.claude.billing.know.headers")}</li>
              <li data-testid="claude-billing-unknown">{t("own.claude.billing.know.unknown")}</li>
            </ul>
          </section>
          <section>
            <h4 class="m-0 text-[12.5px] font-semibold">{t("own.claude.billing.checkTitle")}</h4>
            <ol class="m-0 mt-1 flex list-decimal flex-col gap-0.5 pl-5">
              <li>{t("own.claude.billing.check.1")}</li>
              <li>{t("own.claude.billing.check.2")}</li>
              <li>{t("own.claude.billing.check.3")}</li>
            </ol>
            <button
              type="button"
              class="own-link mt-1"
              onClick={() => host.openExternal(USAGE_URL)}
              data-testid="claude-billing-usage"
            >
              {t("own.claude.billing.openUsage")}
            </button>
          </section>
          <section>
            <h4 class="m-0 text-[12.5px] font-semibold">{t("own.claude.billing.sourcesTitle")}</h4>
            <ul class="m-0 mt-1 flex list-none flex-col gap-0.5 p-0" data-testid="claude-billing-sources">
              <For each={SOURCES}>
                {(source) => (
                  <li>
                    <button type="button" class="own-link text-left" onClick={() => host.openExternal(source.url)}>
                      {typeof source.label === "string" ? source.label : source.label[i18n.locale()]}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </div>
      </details>
    </div>
  )
}
