// "사용 중 계정" (03 §4.3 bottom, §7.2 mini meter): accounts used in the last 24 hours, at most three, each with its
// tightest limit window at the list density and mode of 설정 > 일반 > 한도 표시 (every window on hover). Clicking
// opens the work panel's 계정·한도 tab (4.7.1). Quota updates arrive coalesced at 250 ms by OwnStore (R3: side surfaces
// update at most 4×/s while streaming).
//
// Layout (UX 2026-10-26, the user's report that the names went missing): at 간단히 and 아주 간단히 one row `[dot][name]
// [glance]` where the name gives way first but keeps at least 7em (the glance wraps under it before that) and the
// windows are named (`5시간 ▬ 남음 58%`, `잔액 $7.42`; the ring of 아주 간단히 keeps `58%`); at 자세히 the name has its
// own row and the two windows sit under it on one grid shared by every account (label | bar | value), so every bar
// starts at one x. The heading, the dots and the footer's 설정 icon share one left edge (14 px from the column's).
import { createMemo, For, Show } from "solid-js"
import type { Limit } from "@own/protocol"
import { useI18n } from "@/i18n"
import { limitDensity, type LimitDensity } from "@/limits/display"
import { LimitGlance } from "@/limits/glance"
import { tightest } from "@/limits/windows"
import { minuteNow } from "@/shell/clock"
import { useShell } from "@/shell/context"
import { AccountDot } from "./chip"
import { useSidebar } from "./context"
import { accountsInUse, type AccountLike } from "./model"
import { useSidebarText } from "./strings"

const DAY = 24 * 60 * 60_000

export function AccountsInUse() {
  const ctl = useSidebar()
  const shell = useShell()
  const i18n = useI18n()
  const own = ctl.runtime.own
  // Last use per account: `accounts.list` `lastUsedAt` (refreshed on resync), raised by the turns this window saw
  // start or end since (the list does not change on every step, so a turn that just ran counts right away).
  const list = createMemo(() => {
    const now = minuteNow()
    const since = now - DAY
    const latest = new Map<string, number>()
    for (const id of own.state.accountOrder) latest.set(id, own.state.accounts[id]?.lastUsedAt ?? 0)
    for (const [sessionID, at] of Object.entries(ctl.signals.state.activity)) {
      if (at < since) continue
      const account = ctl.accountOf(sessionID)
      if (account && latest.has(account.id)) latest.set(account.id, Math.max(latest.get(account.id) ?? 0, at))
    }
    const accounts = [...latest].flatMap(([id, lastUsedAt]) => {
      const account = own.state.accounts[id]
      return account ? [{ id, status: account.status, lastUsedAt }] : []
    })
    return accountsInUse(accounts, Math.max(now, Date.now())).map((account) => account.id)
  })
  const density = () => limitDensity("lists")
  return (
    <Show when={list().length > 0}>
      <section
        class="flex-none border-t border-own-border px-2 pt-2.5 pb-1.5"
        aria-labelledby="own-accounts-in-use"
        data-testid="accounts-in-use"
      >
        <h2 id="own-accounts-in-use" class="m-0 mb-1.5 px-1.5 text-[11.5px] font-semibold text-own-muted">
          {i18n.t("own.nav.accountsInUse")}
        </h2>
        {/* 자세히: one grid for every account (dot | label | bar | value; the first track holds the line's 6 px inset
            and the dot), each line a subgrid of it. */}
        <div
          class={
            density() === "detailed"
              ? "grid grid-cols-[14px_max-content_34px_minmax(0,1fr)] gap-x-[5px] gap-y-0.5"
              : "flex flex-col gap-0.5"
          }
          data-density={density()}
        >
          <For each={list()}>
            {(id) => (
              <AccountLine
                account={own.state.accounts[id]!}
                windows={own.state.quota[id]}
                density={density()}
                onOpen={() => shell.openTab("accounts")}
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  )
}

function AccountLine(props: {
  readonly account: AccountLike
  readonly windows: readonly Limit.Window[] | undefined
  readonly density: LimitDensity
  readonly onOpen: () => void
}) {
  const text = useSidebarText()
  const known = () => tightest(props.windows ?? [], minuteNow())
  const detailed = () => props.density === "detailed"
  return (
    <button
      type="button"
      class={`own-target min-h-[26px] w-full rounded-md px-1.5 py-0.5 text-left text-[12.5px] hover:bg-own-hover ${
        detailed()
          ? "col-span-full grid grid-cols-subgrid items-center gap-y-0.5"
          : "flex flex-wrap items-center gap-x-[5px] gap-y-0.5"
      }`}
      data-account-id={props.account.id}
      onClick={() => props.onOpen()}
    >
      <AccountDot color={props.account.color} />
      {/* The name keeps at least 7em: past that the glance wraps under it rather than squeezing it to nothing. */}
      <span
        class={detailed() ? "col-[2/-1] min-w-0 truncate" : "min-w-[7em] flex-[1_1_7em] truncate"}
        data-testid="in-use-name"
      >
        {props.account.label}
      </span>
      <Show
        when={known()}
        fallback={
          <span
            class={`own-num text-[11.5px] text-own-muted ${detailed() ? "col-[2/-1]" : "ml-auto flex-none text-right"}`}
          >
            {text("own.sidebar.meterUnknown")}
          </span>
        }
      >
        <span class={detailed() ? "contents" : "ml-auto flex-none"}>
          <LimitGlance
            windows={props.windows}
            density={limitDensity("lists")}
            now={minuteNow}
            layout={detailed() ? "rows" : "inline"}
            labels
            subgrid={detailed()}
          />
        </span>
      </Show>
    </button>
  )
}
