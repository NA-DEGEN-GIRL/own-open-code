// Work panel `계정·한도` tab (03 §4.7.1, AccountsLimitsTab), its own lazy chunk. Top: the "이 세션" card. Then the
// accounts grouped by provider, ordered "this session's account → in use → the rest", each with its limits summary
// (./summary: the tightest windows on one line that unfolds every bar, 설정 > 일반 > 한도 표시); the row's head opens
// its details: request-limit headers, org/workspace, last observation, the auto-compaction line and the sessions
// using it. Hidden tabs stay mounted: while `visible()` is false the minute clock is not read, so nothing re-renders
// on the timer (4.7 "숨긴 탭은 렌더링 작업을 멈춘다"). A Claude Agent conversation whose account nears or reaches a limit
// gets a suggestion of another Claude Agent account under its row (02 §8.10): it only opens the switcher there; nothing
// moves on its own.
import type { Account } from "@own/protocol"
import { createMemo, createSignal, For, lazy, Show } from "solid-js"
import { LOCAL, useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { RouteLink, useRouter } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import {
  compactionSummary,
  compactionSummaryText,
  identityParts,
  importMode,
  isCodexStale,
  kindLabel,
  panelGroups,
  TYPE_LABEL,
  typeTag,
} from "@/accounts/model"
import { focusCompaction } from "@/settings/focus"
import { ago } from "./format"
import { openSwitcher } from "./intents"
import { Dot, Tag } from "./kit"
import { LimitMeterGroup } from "./meter"
import { observe } from "./observations"
import { SessionCard } from "./session-card"
import { createPolicyCache, statusLine } from "./shared"
import { AccountLimits } from "./summary"

const AgentSuggestion = lazy(() => import("./claude-agent-suggest"))

export interface AccountsLimitsTabProps {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}

export default function AccountsLimitsTab(props: AccountsLimitsTabProps) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  observe(own)
  // Frozen while hidden: reading `minuteNow` only when visible keeps the hidden tab off the timer.
  const now = createMemo<number>((last) => (props.visible() ? minuteNow() : last), Date.now())
  const policy = createPolicyCache(own)
  const current = () => {
    const sessionID = props.sessionID()
    const binding = sessionID ? data.get(props.serverKey())?.own.state.binding[sessionID] : undefined
    if (binding?.accountID) return binding.accountID
    return binding?.model ? own.state.accountByProvider[binding.model.providerID] : undefined
  }
  const accounts = () =>
    own.state.accountOrder.flatMap((id) => {
      const account = own.state.accounts[id]
      return account && account.status !== "retired" ? [account] : []
    })
  const groups = createMemo(() => panelGroups(accounts(), current(), now()))
  // Sections and rows are keyed by kind and account id, not by the group objects the memo rebuilds on every minute
  // tick and account change: keyed by object, each rebuild remounted every row and closed the one the user opened.
  const kinds = createMemo(() => groups().map((group) => group.kind))

  return (
    <div class="p-3" data-testid="tab-accounts">
      <Show when={props.sessionID()}>
        {(sessionID) => (
          <SessionCard serverKey={props.serverKey()} sessionID={sessionID()} now={now} active={props.visible} />
        )}
      </Show>
      <Show
        when={own.state.status === "ready" || own.state.accountOrder.length}
        fallback={<p class="own-placeholder p-2">{statusLine(i18n, own.state.status)}</p>}
      >
        <Show
          when={groups().length}
          fallback={
            <div class="px-2 py-6 text-center" data-testid="accounts-empty">
              <p class="m-0 mb-1 font-semibold">{i18n.t("own.empty.accounts")}</p>
              <p class="m-0 mb-3 text-[12.5px] text-own-muted">{i18n.t("own.empty.accountsBody")}</p>
              <RouteLink to={{ name: "accountsAdd" }} class="own-btn" data-variant="primary">
                {i18n.t("own.accounts.add")}
              </RouteLink>
            </div>
          }
        >
          <For each={kinds()}>
            {(kind) => (
              <section aria-label={kindLabel(i18n, kind)}>
                <h3 class="own-sect">{kindLabel(i18n, kind)}</h3>
                <For each={groups().find((group) => group.kind === kind)?.ids ?? []}>
                  {(id) => (
                    <AccountRow
                      id={id}
                      current={current() === id}
                      sessionID={props.sessionID()}
                      serverKey={props.serverKey()}
                      now={now}
                      summary={() => {
                        const account = own.state.accounts[id]
                        return account
                          ? compactionSummaryText(
                              i18n,
                              compactionSummary(account.kind, account.compaction?.setting, policy()?.byKind),
                            )
                          : ""
                      }}
                    />
                  )}
                </For>
              </section>
            )}
          </For>
        </Show>
      </Show>
      <div class="mx-1 mb-1 mt-4 flex justify-between">
        <RouteLink to={{ name: "limits" }} class="own-link" data-testid="link-limits">
          {i18n.t("own.lim.toDashboard")}
        </RouteLink>
        <RouteLink to={{ name: "accounts" }} class="own-link" data-testid="link-accounts">
          {i18n.t("own.lim.toAccounts")}
        </RouteLink>
      </div>
    </div>
  )
}

function AccountRow(props: {
  readonly id: string
  readonly current: boolean
  readonly sessionID: string | undefined
  readonly serverKey: ServerKey
  readonly now: () => number
  readonly summary: () => string
}) {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  const own = data.local().own
  const [open, setOpen] = createSignal(false)
  const account = () => own.state.accounts[props.id]
  const windows = () => own.state.quota[props.id]
  // The tab's conversation runs this model: its model weekly bucket may lead every row (./windows `ranked`).
  const model = () =>
    props.sessionID ? data.get(props.serverKey)?.own.state.binding[props.sessionID]?.model?.id : undefined
  return (
    <Show when={account()}>
      {(item) => (
        <div
          class="own-arow"
          data-current={props.current ? "" : undefined}
          data-account-id={props.id}
          data-testid="account-row"
        >
          <button
            type="button"
            class="own-arow-head"
            aria-expanded={open()}
            onClick={() => setOpen((value) => !value)}
            data-testid="account-row-toggle"
          >
            <Dot color={item().color} />
            <span class="min-w-0 truncate text-[13px] font-semibold">{item().label}</span>
            <Tag tone={typeTag(item()) === "unofficial" ? "danger" : "soft"}>{i18n.t(TYPE_LABEL[typeTag(item())])}</Tag>
            {/* The 이 대화 card names the model; this row is its account (UX 2026-10-26). */}
            <Show when={props.current}>
              <Tag tone="soft" testid="account-row-this">
                {i18n.t("own.lim.thisSession")}
              </Tag>
            </Show>
            <Show when={importMode(item())}>
              {(mode) => <Tag>{i18n.t(mode() === "linked" ? "own.codex.linked" : "own.codex.takeover")}</Tag>}
            </Show>
            <Show when={isCodexStale(item())}>
              <Tag tone="warn" testid="codex-stale">
                ! {i18n.t("own.codex.staleShort")}
              </Tag>
            </Show>
            <span class="ml-auto whitespace-nowrap text-[11.5px] text-own-faint">
              {i18n.t("own.accounts.usage", {
                running: item().sessions?.running ?? 0,
                total: item().sessions?.total ?? 0,
              })}
            </span>
          </button>
          <Show when={unusable(item())}>
            {(reason) => (
              <p class="m-0 -mt-1 mb-1.5 text-[12px] text-own-danger">{i18n.t(reason(), { account: item().label })}</p>
            )}
          </Show>
          {/* 설정 > 일반 > 한도 표시 (목록): `자세히` starts unfolded; otherwise the tightest windows, every bar on click. */}
          <AccountLimits surface="lists" windows={windows()} kind={item().kind} model={model()} now={props.now} />
          <Show when={props.current && props.sessionID && item().kind === "claude-agent" ? props.sessionID : undefined}>
            {(sessionID) => <AgentSuggestion serverKey={props.serverKey} sessionID={sessionID()} accountID={props.id} />}
          </Show>
          <Show when={open()}>
            <div class="own-arow-more" data-testid="account-row-more">
              <Show when={(windows() ?? []).some((window) => window.kind === "rate")}>
                <LimitMeterGroup
                  windows={(windows() ?? []).filter((window) => window.kind === "rate")}
                  rates
                  kind={item().kind}
                  now={props.now}
                />
              </Show>
              <Show when={identityParts(i18n, item()).length}>
                <span>{identityParts(i18n, item()).join(" · ")}</span>
              </Show>
              <Show when={lastObserved(windows())}>
                {(at) => <span>{i18n.t("own.lim.lastObserved", { ago: ago(i18n, props.now(), at()) })}</span>}
              </Show>
              <span class="flex flex-wrap items-center gap-2">
                <span>{props.summary()}</span>
                <button
                  type="button"
                  class="own-link"
                  onClick={() => {
                    focusCompaction({ accountID: props.id })
                    router.navigate({ name: "settings", section: "compaction" })
                  }}
                >
                  {i18n.t("own.lim.change")}
                </button>
              </span>
              <SessionsUsing providerID={item().providerID} />
              <Show when={props.sessionID && !props.current && own.rpc.allowed("switch.estimate")}>
                <div>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    data-testid="switch-here"
                    onClick={() =>
                      openSwitcher({ serverKey: props.serverKey, sessionID: props.sessionID!, accountID: props.id })
                    }
                  >
                    {i18n.t("own.lim.switchHere")}
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Sessions of the local list whose model is on this account (MVP: one provider per account). */
function SessionsUsing(props: { readonly providerID: string }) {
  const data = useData()
  const i18n = useI18n()
  const sessions = () => {
    const index = data.local().sessions.state
    return index.order.filter((id) => index.sessions[id]?.model?.providerID === props.providerID).slice(0, 5)
  }
  return (
    <Show when={sessions().length}>
      <span class="text-own-faint">{i18n.t("own.lim.sessionsUsing")}</span>
      <ul class="m-0 list-none p-0">
        <For each={sessions()}>
          {(id) => (
            <li class="truncate">
              <RouteLink to={{ name: "session", serverKey: LOCAL, sessionID: id }} class="own-link">
                {data.local().sessions.state.sessions[id]?.title || i18n.t("own.shell.untitled")}
              </RouteLink>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function lastObserved(windows: readonly { readonly observedAt: number }[] | undefined) {
  if (!windows?.length) return undefined
  return Math.max(...windows.map((window) => window.observedAt))
}

/** Why an account cannot run now (03 §5.2 "사용할 수 없는 계정" reasons). */
function unusable(account: Account.View) {
  if (account.status === "exhausted") return "own.lim.status.exhausted" as const
  if (account.status === "auth_failed" && account.connection.method !== "codex-linked")
    return "own.banner.authExpired" as const
  // A stale login Claude Code shares (02 §8.7 CS) needs no 다시 로그인: one request in Claude Code, or the own login.
  if (account.claude?.stale) return "own.switcher.unusable.shared" as const
  if (account.status === "needs_reauth") return "own.lim.status.needsReauth" as const
  if (account.status === "disabled") return "own.lim.status.disabled" as const
  if (account.status === "misconfigured") return "own.lim.status.misconfigured" as const
  if (account.status === "unverified") return "own.lim.status.unverified" as const
  return undefined
}
