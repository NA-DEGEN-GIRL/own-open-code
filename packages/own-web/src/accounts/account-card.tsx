// Account card of /accounts (03 §5.4 list): name, badges, identity (key hint, masked email, org/workspace), status and
// "실행 중 · 세션", every limit window with source/confidence, the auto-compaction line, codex import connection line,
// the Sign in with ChatGPT plan line ("ChatGPT 요금제 사용 · 사용량 관리", and its usage limit), the DeepSeek line
// (`충전 · 사용량`, and `잔액 부족` after a 402; the balance and its 보너스 part are limit windows), same-org/cache-domain
// notes, the compat server, output cap, running window, model capability and overflow lines (07 §6.2 #2, #7, #8;
// 02 §3.3) with `모델 기능…`, the kind's pinned
// template change waiting for the user (`템플릿 갱신 있음 [갱신]`, 07 §4.4, this PC only), a ChatGPT account's Codex
// models own does not know yet (07 §4.5, CA) and the `⋯` menu. Actions are
// delegated to the page, which owns the dialogs; `[갱신]` and the connection test run here.
import type { Account, Limit } from "@own/protocol"
import { Kind } from "@own/protocol/kind"
import { LimitRank } from "@own/protocol/limit-rank"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n, type I18nKey } from "@/i18n"
import { limitText } from "@/limits/display"
import { Dot, Menu, Tag, createStatus, StatusLine, type MenuEntry } from "@/limits/kit"
import { AccountLimits } from "@/limits/summary"
import type { PolicyState } from "@/limits/shared"
import { tightest } from "@/limits/windows"
import { minuteNow } from "@/shell/clock"
import { ManageUsage } from "./chatgpt-login"
import { USAGE_LIMIT_CODE } from "./chatgpt-plan"
import { CodexStaleBanner } from "./codex-import"
import { CodexUnknownNote } from "./codex-models-ui"
import { useCompatText } from "./compat-strings"
import { BALANCE_CODE, DsBalanceLinks } from "./ds-balance"
import { errorMessage } from "./errors"
import { legacyKeyText } from "./legacy-key-strings"
import { isLocal, levelsLine, localLine } from "./local-model"
import { useLocalText } from "./local-strings"
import {
  compactionSummary,
  compactionSummaryText,
  compatCapabilitiesText,
  compatFactsText,
  compatOverflowWarning,
  compatWithoutTools,
  identityParts,
  importMode,
  isCodexStale,
  kindLabel,
  raiseHint,
  refreshCatalogInput,
  runningWindows,
  runningWindowText,
  shortID,
  templateUpdate,
} from "./model"

export type CardAction =
  | "rename"
  | "color"
  | "default"
  | "autoSwitch"
  | "pollBalance"
  | "budget"
  | "compaction"
  | "relogin"
  | "replaceKey"
  | "takeover"
  | "relink"
  | "remove"
  | "enable"
  | "capabilities"
  | "local"

const POLLED: ReadonlySet<Account.View["kind"]> = new Set(["ds", "or", "xai"])

export function AccountCard(props: {
  readonly id: string
  readonly policy: PolicyState | undefined
  readonly onAction: (action: CardAction, account: Account.View) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const account = () => own.state.accounts[props.id]
  // The account's windows once known (each `quota.updated` replaces them; none once the snapshot is in without any).
  const lead = createMemo(() => {
    const item = account()
    return item && cardLead(item, own.state.quota[props.id] ?? (own.state.quotaLoaded ? [] : undefined), minuteNow())
  })
  const status = createStatus()
  const compatText = useCompatText()
  const localText = useLocalText()
  const [testing, setTesting] = createSignal(false)
  const [refreshing, setRefreshing] = createSignal(false)

  /** `[갱신]` (07 §4.4): the kind's template takes the catalog's fixed fields; the list shows the result. */
  const refresh = async (item: Account.View) => {
    setRefreshing(true)
    status.clear()
    await own.rpc
      .call("accounts.update", refreshCatalogInput(item))
      .then(() => status.ok(i18n.t("own.acct.templateUpdate.done")))
      .catch((error: unknown) =>
        status.error(`${i18n.t("own.acct.templateUpdate.failed")} · ${errorMessage(i18n, error)}`),
      )
    setRefreshing(false)
  }

  const test = async (item: Account.View) => {
    setTesting(true)
    status.clear()
    await own.rpc
      .call("accounts.test", { accountID: item.id })
      .then((result) =>
        result.ok
          ? status.ok(i18n.t("own.acct.testPassed", { ms: Math.round(result.latencyMs) }))
          : status.error(i18n.t("own.acct.testFailedStatus", { status: result.status ?? "—" })),
      )
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setTesting(false)
  }

  const entries = (item: Account.View): MenuEntry[] => {
    const manage = own.rpc.allowed("accounts.update")
    // 02 §3.3a: a local model costs nothing, so no budget and no automatic switching; its key can still change.
    const metered = item.billing === "metered" || item.billing === "prepaid"
    const local = isLocal(item)
    const imported = item.connection.source
    const list: (MenuEntry | false)[] = [
      manage && {
        label: i18n.t("own.acct.rename"),
        onSelect: () => props.onAction("rename", item),
        testid: "menu-rename",
      },
      manage && { label: i18n.t("own.acct.recolor"), onSelect: () => props.onAction("color", item) },
      own.rpc.allowed("policy.set") &&
        item.kind !== "claude-sub" && {
          label: i18n.t("own.acct.makeDefault"),
          checked: isDefault(props.policy, item),
          onSelect: () => props.onAction("default", item),
        },
      manage &&
        metered && {
          label: i18n.t("own.acct.autoSwitch"),
          checked: item.autoSwitch,
          onSelect: () => props.onAction("autoSwitch", item),
        },
      manage &&
        POLLED.has(item.kind) && {
          label: i18n.t("own.accounts.pollOff"),
          checked: item.pollBalance === false,
          onSelect: () => props.onAction("pollBalance", item),
        },
      manage && metered && { label: i18n.t("own.acct.budget"), onSelect: () => props.onAction("budget", item) },
      { label: i18n.t("own.acct.compactionSettings"), onSelect: () => props.onAction("compaction", item) },
      // 02 §3.3: each model's image input, tools and reasoning effort.
      manage &&
        item.kind === "compat" && {
          label: compatText("own.compat.edit"),
          onSelect: () => props.onAction("capabilities", item),
          testid: "menu-compat-capabilities",
        },
      // 02 §3.3a: make it a local model, change its API format, or back to other OpenAI-compatible.
      manage &&
        item.kind === "compat" && {
          label: localText(local ? "own.local.changeFormat" : "own.local.convert"),
          onSelect: () => props.onAction("local", item),
          testid: "menu-local",
        },
      "separator",
      own.rpc.allowed("accounts.test") && {
        label: i18n.t("own.accounts.test"),
        disabled: testing(),
        onSelect: () => void test(item),
        testid: "menu-test",
      },
      manage &&
        Kind.isOAuth(item.kind) && {
          label: i18n.t("own.action.relogin"),
          onSelect: () => props.onAction("relogin", item),
        },
      // A linked old-app key is changed in the old app (02 §3.2b); the router refuses `replaceKey` for it.
      manage &&
        (metered || local) &&
        !item.connection.legacyKey && {
          label: i18n.t("own.acct.replaceKey"),
          onSelect: () => props.onAction("replaceKey", item),
        },
      manage &&
        imported?.mode === "linked" && {
          label: i18n.t("own.codex.takeoverAction"),
          onSelect: () => props.onAction("takeover", item),
          testid: "menu-takeover",
        },
      manage && !!imported && { label: i18n.t("own.codex.relink"), onSelect: () => props.onAction("relink", item) },
      manage &&
        item.status === "disabled" && {
          label: i18n.t("own.acct.enable"),
          onSelect: () => props.onAction("enable", item),
        },
      "separator",
      own.rpc.allowed("accounts.remove.plan") && {
        label: i18n.t("own.acct.remove"),
        tone: "danger" as const,
        onSelect: () => props.onAction("remove", item),
        testid: "menu-remove",
      },
    ]
    return trimSeparators(list.filter((entry): entry is MenuEntry => entry !== false))
  }

  return (
    <Show when={account()}>
      {(item) => (
        <article
          class="own-acard"
          data-account-id={props.id}
          data-attention={["warn", "danger"].includes(statusTone(item(), lead())) ? "" : undefined}
          data-testid="account-card"
        >
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Dot color={item().color} />
            <span class="font-semibold" data-testid="account-name">
              {item().label}
            </span>
            <Show when={isDefault(props.policy, item())}>
              <Tag tone="accent">{i18n.t("own.acct.default")}</Tag>
            </Show>
            <Show when={importMode(item())}>
              {(mode) => <Tag>{i18n.t(mode() === "linked" ? "own.codex.linked" : "own.codex.takeover")}</Tag>}
            </Show>
            <Show when={item().autoSwitch && item().billing !== "subscription" && item().billing !== "local"}>
              <Tag tone="soft">{i18n.t("own.acct.autoSwitchOn")}</Tag>
            </Show>
            <span class="min-w-0 text-[12.5px] text-own-faint" data-testid="account-identity">
              {identityParts(i18n, item()).join(" · ")}
            </span>
            <span class="ml-auto flex items-center gap-2 text-[12px] text-own-muted">
              <Tag tone={statusTone(item(), lead())} testid="account-status">
                {statusText(i18n, item(), lead())}
              </Tag>
              <span class="whitespace-nowrap">
                {i18n.t("own.accounts.usage", {
                  running: item().sessions?.running ?? 0,
                  total: item().sessions?.total ?? 0,
                })}
              </span>
              <Menu
                label={i18n.t("own.acct.menu", { account: item().label })}
                entries={() => entries(item())}
                testid="account-menu"
              />
            </span>
          </div>
          <Show when={isCodexStale(item())}>
            <div class="mt-2">
              <CodexStaleBanner account={item()} onTakeover={() => props.onAction("takeover", item())} />
            </div>
          </Show>
          <div class="mt-2.5">
            <AccountLimits
              surface="accounts"
              windows={own.state.quota[props.id]}
              kind={item().kind}
              rates
              now={minuteNow}
              resetCredits={props.id}
            />
          </div>
          <div class="mt-2 flex flex-col gap-1 text-[12px] leading-[18px] text-own-muted">
            <Show when={item().billing === "subscription" && !item().thirdParty}>
              <span>{i18n.t("own.acct.subscriptionNote")}</span>
            </Show>
            <Show when={item().kind === "siwc"}>
              <span data-testid="chatgpt-plan">
                {i18n.t("own.chatgpt.plan")} · <ManageUsage />
              </span>
              <Show when={own.state.statusReason[props.id] === USAGE_LIMIT_CODE}>
                <span class="text-own-danger" data-testid="chatgpt-plan-limit">
                  {i18n.t("own.chatgpt.usageLimit")}
                </span>
              </Show>
            </Show>
            <Show when={item().kind === "ds"}>
              <span class="flex flex-wrap items-center gap-2" data-testid="ds-balance">
                <Show when={own.state.statusReason[props.id] === BALANCE_CODE}>
                  <span class="text-own-danger" data-testid="ds-balance-out-short">
                    {i18n.t("own.ds.balanceOutShort")}
                  </span>
                </Show>
                <DsBalanceLinks />
              </span>
            </Show>
            <Show when={item().kind === "anth" && item().identity?.organizationId}>
              {(org) => <span>ⓘ {i18n.t("own.accounts.limitScopeNote", { org: shortID(org()) })}</span>}
            </Show>
            <Show when={sharedWith(item(), own.state.accounts)}>
              {(label) => (
                <span data-testid="same-domain">
                  {i18n.t("own.accounts.sameDomain", { account: label() })} · {i18n.t("own.accounts.sameDomainNote")}
                </span>
              )}
            </Show>
            <Show when={item().connection.source}>
              {(source) => (
                <span data-testid="codex-connection">
                  {i18n.t(source().mode === "linked" ? "own.codex.connLinked" : "own.codex.connTakeover", {
                    alias: source().alias ?? source().profileID,
                  })}
                  <Show when={source().superseded}>
                    <span class="ml-1 text-own-faint">· {i18n.t("own.codex.superseded")}</span>
                  </Show>
                </span>
              )}
            </Show>
            {/* 07 §4.5 (CA): the account's Codex list had models own does not know yet. */}
            <Show when={item().kind === "codex"}>
              <CodexUnknownNote accountID={props.id} />
            </Show>
            <Show when={item().connection.legacyKey}>
              {(legacy) => (
                <span data-testid="legacy-key-connection">
                  {legacyKeyText.text(i18n.locale(), "own.legacyKey.conn", {
                    name: legacy().name ?? kindLabel(i18n, item().kind),
                  })}
                </span>
              )}
            </Show>
            <span class="flex flex-wrap items-center gap-2" data-testid="account-compaction">
              {compactionSummaryText(
                i18n,
                compactionSummary(item().kind, item().compaction?.setting, props.policy?.policy.compaction?.byKind),
              )}
              <button type="button" class="own-link" onClick={() => props.onAction("compaction", item())}>
                {i18n.t("own.lim.change")}
              </button>
            </span>
            <Show when={localLine(localText, item())}>{(line) => <span data-testid="local-line">{line()}</span>}</Show>
            <Show when={item().kind === "compat"}>
              <CompatFacts account={item()} />
            </Show>
            <Show when={levelsLine(localText, item())}>
              {(line) => <span data-testid="local-levels">{line()}</span>}
            </Show>
            {/* 02 §3.3a: one click for a compat account on a local server that is not a local model yet. */}
            <Show when={item().kind === "compat" && !isLocal(item()) && own.rpc.allowed("accounts.update")}>
              <span class="flex flex-wrap items-center gap-2" data-testid="local-convert-hint">
                <span>{localText("own.local.convertHint")}</span>
                <button
                  type="button"
                  class="own-link"
                  data-testid="local-convert"
                  onClick={() => props.onAction("local", item())}
                >
                  {localText("own.local.convert")}
                </button>
              </span>
            </Show>
            {/* 07 §6.2 #2: core may not classify a compat server's overflow error, so the window must be exact. */}
            <Show when={compatOverflowWarning(item())}>
              <span class="text-own-warn" data-testid="compat-overflow-warning">
                ⚠ {i18n.t("own.acct.compatOverflow")}
              </span>
            </Show>
            <Show when={templateUpdate(item(), own.rpc.allowed("accounts.update"))}>
              <span class="flex flex-wrap items-center gap-2" data-testid="account-template-update">
                <Tag tone="accent">{i18n.t("own.acct.templateUpdate")}</Tag>
                <button
                  type="button"
                  class="own-link"
                  disabled={refreshing()}
                  data-testid="account-template-refresh"
                  onClick={() => void refresh(item())}
                >
                  {i18n.t("own.acct.templateUpdate.apply")}
                </button>
                <span class="w-full text-own-faint">{i18n.t("own.acct.templateUpdate.note")}</span>
              </span>
            </Show>
          </div>
          <StatusLine status={status} testid="account-card-status" />
        </article>
      )}
    </Show>
  )
}

/**
 * 07 §6.2 #2, #7, #8: a compat account's server and output caps (`모름` for the 32k fallback), each model's image input
 * and tools with their source (02 §3.3) and, for an Ollama server, each model's running window against what a request
 * needs, with how to raise it.
 */
function CompatFacts(props: { readonly account: Account.View }) {
  const text = useCompatText()
  const windows = () => runningWindows(props.account)
  return (
    <>
      <Show when={compatFactsText(text, props.account)}>
        {(facts) => <span data-testid="compat-facts">{facts()}</span>}
      </Show>
      <Show when={compatCapabilitiesText(text, props.account)}>
        {(line) => <span data-testid="compat-capabilities-line">{line()}</span>}
      </Show>
      <Show when={compatWithoutTools(props.account)}>
        <span data-testid="compat-no-tools">ⓘ {text("own.compat.noTools")}</span>
      </Show>
      <For each={windows()}>
        {(window) => (
          <span
            class="flex flex-wrap items-center gap-2"
            data-testid="compat-running-window"
            data-status={window.status}
          >
            {runningWindowText(text, window)}
            <Tag tone={window.status === "verified" ? "ok" : "warn"}>{text(`own.compat.status.${window.status}`)}</Tag>
          </span>
        )}
      </For>
      <Show when={raiseHint(windows())}>
        {(hint) => (
          <span class="text-own-warn" data-testid="compat-raise-window">
            {text("own.compat.notSuggested")} {text("own.compat.raise", { needed: hint().needed })}
            <Show when={hint().unknown}> {text("own.compat.raiseUnknown")}</Show>
          </span>
        )}
      </Show>
    </>
  )
}

/** The default account of its kind (`policy.defaults.byKind`, 5.4 `이 프로바이더의 기본 계정으로`). */
export function isDefault(policy: PolicyState | undefined, account: Account.View) {
  if (account.kind === "claude-sub" || account.kind === "claude-agent") return false
  return policy?.policy.defaults.byKind[account.kind] === account.id
}

function trimSeparators(entries: MenuEntry[]) {
  return entries.filter(
    (entry, index) =>
      entry !== "separator" || (index > 0 && index < entries.length - 1 && entries[index - 1] !== "separator"),
  )
}

/** Accounts sharing this account's cache domain (5.4 "같은 캐시 도메인" mark; MVP never merges them). */
function sharedWith(account: Account.View, accounts: Record<string, Account.View>) {
  const shared = account.cacheDomain?.sharedWith ?? []
  const labels = shared.flatMap((id) => (accounts[id] ? [accounts[id]!.label] : []))
  return labels.length ? labels.join(", ") : undefined
}

/** The window the card's state tag names ({@link cardLead}). */
export interface CardLead {
  /** The window's label; `undefined` when only an older service's `limitsSummary.worst` names it (no label). */
  readonly label: string | undefined
  /** Used share; `undefined` without one (a balance, a window known only by its state). */
  readonly percent: number | undefined
  readonly status: Limit.Status
}

/**
 * The window the card's state tag leads with (03 §5.4, LV 2026-10-25): the first of the one ranking without a model
 * (`tightest`, as own-accounts' `Views.summary` names `limitsSummary.worst`) of the screen's windows, which every
 * `quota.updated` keeps current. `accounts.list` is read again only on `accounts.changed` and a spend sends none, so the
 * list's `limitsSummary.worst` stands in only while the account's windows are not loaded (`windows` undefined), with
 * the label it carries (an older service sends none: the tag then says its state word alone).
 */
export function cardLead(
  account: Account.View,
  windows: readonly Limit.Window[] | undefined,
  now: number,
): CardLead | undefined {
  if (windows) {
    const lead = tightest(windows, now)
    return lead && { label: lead.label, percent: lead.percent, status: lead.status }
  }
  const worst = account.limitsSummary?.worst
  return worst ? { label: worst.label, percent: worst.usedPercent ?? undefined, status: worst.status } : undefined
}

/**
 * The card's state tag. Its limit part is the account's lead window ({@link cardLead}): used up is danger, its bar's
 * warning or danger color (30 % or less left) or a warning state is warn.
 */
export function statusTone(account: Account.View, lead: CardLead | undefined) {
  if (account.status === "exhausted" || account.status === "auth_failed" || account.status === "needs_reauth")
    return "danger"
  if (account.status === "misconfigured" || account.status === "unverified") return "warn"
  if (lead?.status === "exhausted") return "danger"
  if (lead && warned(lead)) return "warn"
  if (account.status === "disabled") return "soft"
  return "ok"
}

/** A lead window that is not used up but warned: its bar's color or its state. */
function warned(lead: CardLead) {
  return lead.status === "warning" || LimitRank.tone(lead.percent, lead.status) !== "neutral"
}

const STATUS_LABEL: Record<Account.Status, I18nKey> = {
  ready: "own.acct.status.ready",
  exhausted: "own.lim.status.exhausted",
  auth_failed: "own.acct.status.authFailed",
  needs_reauth: "own.lim.status.needsReauth",
  disabled: "own.lim.status.disabled",
  misconfigured: "own.lim.status.misconfigured",
  unverified: "own.lim.status.unverified",
  retired: "own.acct.status.retired",
}

/**
 * `정상` / `주의 · 5시간 84%` / `한도 소진` / `한도 소진 · 5시간` / … (5.4 mock), of the lead window ({@link statusTone});
 * a lead without a label (an older service's list, before the windows) reads `주의` or `한도 소진` alone.
 */
export function statusText(i18n: ReturnType<typeof useI18n>, account: Account.View, lead: CardLead | undefined) {
  if (isCodexStale(account)) return i18n.t("own.codex.staleShort")
  // A ready account with its lead window used up is red (statusTone), so the words say why instead of 정상.
  if (account.status === "ready" && lead?.status === "exhausted")
    return lead.label
      ? i18n.t("own.acct.status.exhaustedWindow", { window: lead.label })
      : i18n.t("own.lim.status.exhausted")
  if (account.status === "ready" && lead && warned(lead) && lead.percent !== undefined)
    return lead.label
      ? i18n.t("own.acct.status.warning", { window: lead.label, percent: limitText(i18n, lead.percent) })
      : i18n.t("own.acct.status.warningAlone")
  return i18n.t(STATUS_LABEL[account.status])
}
