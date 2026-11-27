// Limits dashboard `/limits` (03 §5.5), lazy (20.2 R5). Summary line (the tightest limit and its reset, this month's
// API spend from the local ledger), one card per account grouped by provider with its limits summary (./summary, every
// window once unfolded), the 5 h / 7 d trend and the "at this rate" estimate, the per-session usage table and the
// legend of 7.3. Quota comes from OwnStore
// events (never polled); usage from `accounts.usage` on open.
import type { Account, Ledger } from "@own/protocol"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { minuteNow } from "@/shell/clock"
import { kindLabel, pageSections, TYPE_LABEL, typeTag } from "@/accounts/model"
import { resetOf, windowValue } from "./display"
import { duration, usd } from "./format"
import { Dot, ProviderMark, Tag } from "./kit"
import { Bar } from "./meter"
import { observe, points } from "./observations"
import { statusLine } from "./shared"
import { AccountLimits } from "./summary"
import { useLimitSummaryText } from "./summary-strings"
import { eta } from "./trend"
import { SessionUsageTable, UsageSparkline } from "./usage"
import { tighter, tightest, type WindowView } from "./windows"

export default function LimitsPage() {
  const data = useData()
  const i18n = useI18n()
  const summary = useLimitSummaryText()
  const own = data.local().own
  observe(own)
  const now = minuteNow
  const accounts = () =>
    own.state.accountOrder.flatMap((id) => {
      const account = own.state.accounts[id]
      return account && account.status !== "retired" ? [account] : []
    })
  const sections = createMemo(() => pageSections(accounts()))
  const worst = createMemo(() => {
    const candidates = accounts().flatMap((account) => {
      const item = tightest(own.state.quota[account.id] ?? [], now())
      return item ? [{ account, item }] : []
    })
    // Every account's leading window (./windows `ranked`, account-wide only: the page has no session), ranked again.
    return candidates.toSorted((a, b) => tighter(a.item, b.item))[0]
  })
  const [spend, setSpend] = createSignal<number>()
  const monthStart = () => {
    const date = new Date()
    return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
  }
  void own.rpc
    .call("accounts.usage", { from: monthStart(), to: Date.now(), groupBy: "day" })
    .then((output) => setSpend(sumUSD(output.rows)))
    .catch(() => setSpend(undefined))

  return (
    <section class="mx-auto w-full max-w-[1040px] px-4 pb-12 pt-6 tablet:px-7" data-testid="page-limits">
      <h1 class="m-0 mb-1 text-[20px] font-semibold leading-7">{i18n.t("own.page.limits")}</h1>
      <div
        class="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px] leading-5 text-own-muted"
        data-testid="limits-summary"
      >
        <Show when={worst()} fallback={<span>{i18n.t("own.lim.noLimits")}</span>}>
          {(item) => (
            <span>
              {i18n.t("own.lim.tightest", {
                account: item().account.label,
                window: item().item.label,
                percent: windowValue(i18n, item().item),
              })}
              {/* The reset as on the cards (UX 2026-10-27): faint, in parentheses after the value. */}
              <Show when={resetOf(i18n, item().item, now())}>
                {(reset) => (
                  <>
                    {" "}
                    <span class="text-own-faint">{summary("own.lim.sum.reset", { reset: reset() })}</span>
                  </>
                )}
              </Show>
            </span>
          )}
        </Show>
        <span>
          {i18n.t("own.lim.monthSpend", { amount: spend() === undefined ? "—" : usd(spend()!, true) })}{" "}
          <Tag title={i18n.t("own.lim.localNote")}>{i18n.t("own.conf.local")}</Tag>
        </span>
      </div>
      <Show
        when={accounts().length}
        fallback={
          <p class="own-placeholder px-0">
            {own.state.status === "ready" ? i18n.t("own.empty.accounts") : statusLine(i18n, own.state.status)}
          </p>
        }
      >
        <For each={sections()}>
          {(section) => (
            <section class="own-psec">
              <div class="own-psec-head">
                <ProviderMark kind={section.kind} />
                <h2>{kindLabel(i18n, section.kind)}</h2>
              </div>
              <div class="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5">
                <For each={section.ids}>
                  {(id) => (
                    <Show when={own.state.accounts[id]}>
                      {(account) => <DashboardCard account={account()} now={now} />}
                    </Show>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
      <SessionUsageTable now={now} />
      <Legend />
    </section>
  )
}

function DashboardCard(props: { readonly account: Account.View; readonly now: () => number }) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const windows = () => own.state.quota[props.account.id]
  const tight = () => tightest(windows() ?? [], props.now())
  const soon = () => {
    const item = tight()
    if (!item || item.kind !== "rolling_quota") return undefined
    return eta(points(props.account.id, item.id), props.now(), item.resetAt)
  }
  return (
    <article class="own-acard !mt-0" data-account-id={props.account.id} data-testid="limits-card">
      <div class="mb-2.5 flex min-w-0 items-center gap-1.5">
        <Dot color={props.account.color} />
        <b class="min-w-0 truncate text-[13px]">{props.account.label}</b>
        <Tag tone={typeTag(props.account) === "unofficial" ? "danger" : "soft"}>
          {i18n.t(TYPE_LABEL[typeTag(props.account)])}
        </Tag>
      </div>
      <AccountLimits
        surface="accounts"
        windows={windows()}
        kind={props.account.kind}
        now={props.now}
        rates
        resetCredits={props.account.id}
      />
      <Show when={props.account.thirdParty}>
        <p class="m-0 mt-2 text-[12px] leading-4 text-own-warn">{i18n.t("own.claude.costUnknown")}</p>
      </Show>
      <Show when={soon()}>
        {(ms) => (
          <p
            class="m-0 mt-2 flex flex-wrap items-center gap-1.5 text-[12px] leading-4 text-own-warn"
            data-testid="limits-eta"
          >
            {i18n.t("own.limit.eta", { duration: duration(i18n, ms()) })}
          </p>
        )}
      </Show>
      <UsageSparkline accountID={props.account.id} now={props.now} />
    </article>
  )
}

/** 5.5 legend: 7.3 tags, hatched/faded bars, and the data sources. */
function Legend() {
  const i18n = useI18n()
  const t = useLimitSummaryText()
  const sample = (hatched: boolean, faded: boolean): WindowView => ({
    id: "legend",
    label: "",
    kind: "rolling_quota",
    percent: 40,
    unknown: false,
    hatched,
    faded,
    resetEstimated: false,
    resetAt: undefined,
    tone: "neutral",
    confidence: "live",
    source: "header",
    observedAt: 0,
    status: "ok",
    remaining: undefined,
    limit: undefined,
    unit: undefined,
  })
  return (
    <section class="own-psec" data-testid="limits-legend">
      <div class="own-psec-head">
        <h2>{t("own.lim.legend")}</h2>
      </div>
      <div class="flex flex-wrap items-center gap-3 text-[12px] text-own-muted">
        <Tag tone="plain">{t("own.lim.legendLive")}</Tag>
        <Tag>{t("own.lim.legendRecent")}</Tag>
        <Tag tone="warn">{t("own.lim.legendStale")}</Tag>
        <Tag tone="dashed">{i18n.t("own.conf.estimated")}</Tag>
        <Tag tone="dashed">{i18n.t("own.conf.calibrating")}</Tag>
        <Tag title={i18n.t("own.lim.localNote")}>{i18n.t("own.conf.local")}</Tag>
        <span>{i18n.t("own.limit.unknown")}</span>
        <span class="inline-flex items-center gap-1.5">
          {t("own.lim.legendHatched")}
          <span class="inline-block w-[60px]">
            <Bar view={sample(true, false)} label={t("own.lim.legendHatched")} valueText="" />
          </span>
        </span>
        <span class="inline-flex items-center gap-1.5">
          {t("own.lim.legendFaded")}
          <span class="inline-block w-[60px]">
            <Bar view={sample(false, true)} label={t("own.lim.legendFaded")} valueText="" />
          </span>
        </span>
      </div>
      <p class="m-0 mt-2 text-[12px] leading-[18px] text-own-faint">{t("own.lim.legendSources")}</p>
    </section>
  )
}

function sumUSD(rows: readonly Pick<Ledger.UsageRow, "cost">[]) {
  return rows.reduce(
    (sum, row) => sum + row.cost.filter((item) => item.unit === "USD").reduce((part, item) => part + item.amount, 0),
    0,
  )
}
