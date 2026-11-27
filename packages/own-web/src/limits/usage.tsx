// Usage views of the limits dashboard (03 §5.5): the per-account 5 h / 7 d trend (UsageSparkline) and the per-session
// usage table (SessionUsageTable). Both read the router ledger through `accounts.usage` (02 §9.2): hourly sums for the
// trend, `groupBy: "session"` rows for the table. Credits and costs are ledger estimates (`≈`, 추정).
import type { Ledger } from "@own/protocol"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { baseName } from "@/projects/path"
import { RouteLink } from "@/routing/router"
import { serverOfSession, ServerTag } from "@/servers"
import { relativeTime } from "@/shell/format"
import { amount, percent, tokens } from "./format"
import { Dot, Segmented, Tag } from "./kit"
import { buckets, type Range } from "./trend"

const DAY = 24 * 3_600_000

export function UsageSparkline(props: { readonly accountID: string; readonly now: () => number }) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const [range, setRange] = createSignal<Range>("5h")
  const [rows, setRows] = createSignal<readonly Ledger.UsageRow[]>()
  const [dirty, setDirty] = createSignal(false)
  const load = () => {
    const to = Date.now()
    void own.rpc
      .call("accounts.usage", { accountID: props.accountID, from: to - 7 * DAY, to, groupBy: "hour" })
      .then((output) => {
        setRows(output.rows)
        setDirty(false)
      })
      .catch(() => setRows([]))
  }
  load()
  // New ledger lines mark the trend dirty; it reloads at most once a minute, on the shared clock (R9).
  onCleanup(
    own.on("ledger.step", (event) => {
      if (event.data.line.accountID === props.accountID) setDirty(true)
    }),
  )
  createEffect(on(props.now, () => dirty() && load(), { defer: true }))
  const values = createMemo(() => buckets(rows() ?? [], range(), props.now()))
  const max = () => Math.max(1, ...values())
  const total = () => values().reduce((sum, value) => sum + value, 0)
  return (
    <div class="mt-3" data-testid="usage-spark">
      <div class="mb-1.5 flex items-center justify-between gap-2">
        <span class="text-[11.5px] text-own-muted">
          {i18n.t(range() === "5h" ? "own.lim.trend5h" : "own.lim.trend7d", { tokens: tokens(total()) })}
        </span>
        <Segmented
          label={i18n.t("own.lim.trend")}
          value={range()}
          options={[
            { value: "5h", label: i18n.t("own.limit.5h") },
            { value: "7d", label: i18n.t("own.limit.7d") },
          ]}
          onChange={setRange}
        />
      </div>
      <Show when={rows()} fallback={<div class="own-spark" aria-busy="true" />}>
        <div
          class="own-spark"
          role="img"
          aria-label={i18n.t(range() === "5h" ? "own.lim.trend5h" : "own.lim.trend7d", { tokens: tokens(total()) })}
        >
          <For each={values()}>{(value) => <span style={{ height: `${Math.max(2, (100 * value) / max())}%` }} />}</For>
        </div>
      </Show>
    </div>
  )
}

type Period = "24h" | "7d" | "30d"
const PERIOD_MS: Record<Period, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY }
const PAGE = 100

/** 5.5 table: session, project, account, model, input (cache %), output, cost/credits, switches, last activity. */
export function SessionUsageTable(props: { readonly now: () => number }) {
  const data = useData()
  const i18n = useI18n()
  const local = data.local()
  const own = local.own
  const [period, setPeriod] = createSignal<Period>("7d")
  const [accountID, setAccountID] = createSignal<string>("")
  const [rows, setRows] = createSignal<readonly Ledger.UsageRow[]>()
  const [shown, setShown] = createSignal(PAGE)
  createEffect(
    on([period, accountID], ([current, account]) => {
      const token = { alive: true }
      onCleanup(() => (token.alive = false))
      setRows(undefined)
      setShown(PAGE)
      const to = Date.now()
      void own.rpc
        .call("accounts.usage", {
          ...(account ? { accountID: account } : {}),
          from: to - PERIOD_MS[current],
          to,
          groupBy: "session",
        })
        .then((output) => token.alive && setRows(output.rows))
        .catch(() => token.alive && setRows([]))
    }),
  )
  const accountOptions = () =>
    own.state.accountOrder.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : []))
  return (
    <section class="own-psec" data-testid="session-usage">
      <div class="own-psec-head flex-wrap">
        <h2>{i18n.t("own.lim.sessionUsage")}</h2>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-own-muted">
            {i18n.t("own.lim.filterAccount")}
            <select
              class="own-input h-7 w-auto py-0"
              value={accountID()}
              onChange={(event) => setAccountID(event.currentTarget.value)}
              data-testid="usage-account"
            >
              <option value="">{i18n.t("own.lim.allAccounts")}</option>
              <For each={accountOptions()}>{(account) => <option value={account.id}>{account.label}</option>}</For>
            </select>
          </label>
          <Segmented
            label={i18n.t("own.lim.period")}
            value={period()}
            options={[
              { value: "24h", label: i18n.t("own.lim.period24h") },
              { value: "7d", label: i18n.t("own.lim.period7d") },
              { value: "30d", label: i18n.t("own.lim.period30d") },
            ]}
            onChange={setPeriod}
            testid="usage-period"
          />
        </div>
      </div>
      <Show when={rows()} fallback={<p class="own-placeholder p-2">{i18n.t("own.shell.loading")}</p>}>
        {(list) => (
          <Show when={list().length} fallback={<p class="own-placeholder p-2">{i18n.t("own.lim.noUsage")}</p>}>
            <div class="overflow-x-auto">
              <table class="own-tbl">
                <thead>
                  <tr>
                    <th scope="col">{i18n.t("own.lim.col.session")}</th>
                    <th scope="col">{i18n.t("own.lim.col.project")}</th>
                    <th scope="col">{i18n.t("own.lim.col.account")}</th>
                    <th scope="col">{i18n.t("own.lim.col.model")}</th>
                    <th scope="col" class="own-r">
                      {i18n.t("own.lim.col.input")}
                    </th>
                    <th scope="col" class="own-r">
                      {i18n.t("own.lim.col.output")}
                    </th>
                    <th scope="col" class="own-r">
                      {i18n.t("own.lim.col.cost")}
                    </th>
                    <th scope="col" class="own-r">
                      {i18n.t("own.lim.col.switches")}
                    </th>
                    <th scope="col" class="own-r">
                      {i18n.t("own.lim.col.last")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={list().slice(0, shown())}>
                    {(row) => {
                      const input = row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite
                      // 04 §10, §16.5: rows of SSH sessions carry the host (`server`, else found by session id).
                      const server = () => rowServer(row) ?? serverOfSession(data, row.key)
                      const index = () => (data.get(server()) ?? local).sessions.state
                      const session = () => index().sessions[row.key]
                      // A project without a name of its own (most folders) shows its folder name; `—` only for an
                      // unknown one (P2-12).
                      const project = () => {
                        const projectID = row.projectID ?? session()?.projectID
                        const entry = projectID ? index().projects[projectID] : undefined
                        return entry?.name || (entry?.directory ? baseName(entry.directory) : undefined)
                      }
                      return (
                        <tr data-testid="usage-row" data-server={server()}>
                          <td class="max-w-[220px] truncate">
                            <span class="inline-flex max-w-full items-center gap-1.5">
                              <ServerTag serverKey={server()} />
                              <RouteLink
                                to={{ name: "session", serverKey: server(), sessionID: row.key }}
                                class="own-link truncate"
                                title={row.key}
                              >
                                {session()?.title || row.key.slice(0, 12)}
                              </RouteLink>
                            </span>
                          </td>
                          <td class="max-w-[140px] truncate text-own-muted">{project() ?? "—"}</td>
                          <td>
                            <span class="flex flex-wrap items-center gap-1.5">
                              <For each={row.accountIDs ?? []}>
                                {(id) => (
                                  <Show when={own.state.accounts[id]}>
                                    {(account) => (
                                      <span class="inline-flex items-center gap-1 whitespace-nowrap">
                                        <Dot color={account().color} />
                                        {account().label}
                                      </span>
                                    )}
                                  </Show>
                                )}
                              </For>
                            </span>
                          </td>
                          <td class="max-w-[160px] truncate text-own-muted">{(row.modelIDs ?? []).join(", ")}</td>
                          <td class="own-r whitespace-nowrap">
                            {tokens(input)} (
                            {input > 0 ? percent(Math.round((100 * row.tokens.cacheRead) / input)) : "—"})
                          </td>
                          <td class="own-r">{tokens(row.tokens.output + row.tokens.reasoning)}</td>
                          <td class="own-r whitespace-nowrap">
                            <Show when={row.cost.length} fallback="—">
                              {row.cost.map((item) => amount(item.amount, item.unit, false)).join(" + ")}
                            </Show>
                          </td>
                          <td class="own-r">{row.switchCount ?? 0}</td>
                          <td class="own-r whitespace-nowrap text-own-muted">
                            {row.lastActivityAt ? relativeTime(i18n, props.now(), row.lastActivityAt) : "—"}
                          </td>
                        </tr>
                      )
                    }}
                  </For>
                </tbody>
              </table>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <Tag tone="dashed">{i18n.t("own.conf.estimated")}</Tag>
              <span class="text-[11.5px] text-own-faint">{i18n.t("own.lim.costNote")}</span>
              <Show when={list().length > shown()}>
                <button type="button" class="own-link ml-auto" onClick={() => setShown((value) => value + PAGE)}>
                  {i18n.t("own.lim.more", { n: list().length - shown() })}
                </button>
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </section>
  )
}

/**
 * The server of an `accounts.usage` session row (04 §16.5 `UsageRow.servers`, sorted `"local"`/`hostId`s): a session
 * runs on one server, so its row names one. Rows written before the field (or several servers) fall back to the
 * session lookup.
 */
export function rowServer(row: Pick<Ledger.UsageRow, "servers">): string | undefined {
  const servers = row.servers ?? []
  return servers.length === 1 && servers[0] ? servers[0] : undefined
}
