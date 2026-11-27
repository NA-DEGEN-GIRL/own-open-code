// Claude subscription plugin (03 §5.4.1, 02 §8.2): it ships inside the app, patched for several accounts and always on
// (user decision 2026-10-18), so there is nothing to install, consent to or remove. This file holds the slot's own card
// (account 1) with the plugin's state, the risk notice as information (a), the subscription import (c), the
// always-on coexistence marks (d), and after every Claude account's card the slot's SSH host switches (04 §8.11.12,
// `ClaudeRemote`, one block for all the accounts, SLM 2026-11-22). Several Claude accounts
// (02 §8.7): the added accounts' cards, `Claude 계정 추가`, `다시 로그인` and the bundle's notices live in
// claude-accounts.tsx. Every step is a router RPC; own-web never calls the integration connect endpoints itself (16.3).
import type { Account, Plugin } from "@own/protocol"
import { claudeAccountsText } from "./claude-accounts-strings"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { useData, type OwnStore } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useI18n } from "@/i18n"
import {
  ColorPicker,
  copyText,
  Dialog,
  Dot,
  Menu,
  Notice,
  ProviderMark,
  Spinner,
  Tag,
  createStatus,
  StatusLine,
} from "@/limits/kit"
import { AccountLimits } from "@/limits/summary"
import { remoteStore } from "@/servers/active"
import { claudeHostState } from "@/servers/claude"
import { minuteNow } from "@/shell/clock"
import { ToggleSwitch } from "@/shell/switch"
import { ClaudeBillingNotice } from "./claude-billing-notice"
import { remoteNotice, riskNotice } from "./claude-notice"
import {
  addedClaudeAccounts,
  AddClaudeAccount,
  ClaudeAccountActions,
  ClaudeAccountCard,
  ClaudeBundleNotice,
  ClaudeRefreshLine,
  ClaudeSharedLogin,
  refreshFailed,
} from "./claude-accounts"
import { remoteRows, switchRemoteHost } from "./claude-remote"
import { errorMessage, errorType } from "./errors"
import { COLORS, kindLabel } from "./model"
import { useClaudeSlotText } from "./claude-slot-strings"

export type ClaudeStatus = OwnOutput<"plugin.claudeAuth.status">

/** `plugin.claudeAuth.status` (02 §9.2), read on open and again whenever a caller asks. */
export function createClaudeStatus(own: OwnStore) {
  const [status, setStatus] = createSignal<ClaudeStatus>()
  const refresh = () =>
    own.rpc
      .call("plugin.claudeAuth.status", {})
      .then((next) => void setStatus(next))
      .catch(() => undefined)
  void refresh()
  return { status, refresh }
}

export type ClaudeStatusStore = ReturnType<typeof createClaudeStatus>

/**
 * The `Claude 구독` step of the add-account dialog (5.4.1): the risk notice as information, then the import of this
 * PC's Claude Code login (c). More accounts are added on the accounts page (`Claude 계정 추가`).
 */
export function ClaudeFlow(props: {
  readonly claude: ClaudeStatusStore
  readonly onClose: () => void
  readonly onUseApiKey?: () => void
}) {
  const i18n = useI18n()
  const st = useClaudeSlotText()
  const [done, setDone] = createSignal(false)
  return (
    <div data-testid="claude-flow" data-stage={done() ? "done" : "import"}>
      <Show
        when={!done()}
        fallback={
          <>
            <Notice tone="ok" testid="claude-done">
              {st("own.acct.claudeDone")}
            </Notice>
            <div class="mt-4 flex justify-end">
              <button type="button" class="own-btn" data-variant="primary" onClick={() => props.onClose()}>
                {i18n.t("own.kit.close")}
              </button>
            </div>
          </>
        }
      >
        <RiskNotice onUseApiKey={props.onUseApiKey} />
        <ImportStep claude={props.claude} onCancel={props.onClose} onDone={() => setDone(true)} />
      </Show>
    </div>
  )
}

/** (a) The risk notice, verbatim and informational: the plugin is in the app, and nothing asks for a consent. */
export function RiskNotice(props: { readonly onUseApiKey?: () => void }) {
  const i18n = useI18n()
  const notice = () => riskNotice(i18n.locale())
  const st = useClaudeSlotText()
  return (
    <div data-testid="claude-notice">
      <h3 class="m-0 mb-2 flex items-center gap-2 text-[14px] font-semibold text-own-danger">
        <Tag tone="danger">{i18n.t("own.accounts.type.unofficial")}</Tag>
        {notice().title}
      </h3>
      <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] leading-5" lang={i18n.locale()}>
        <For each={notice().items}>
          {(item, index) => (
            <li>
              {item}
              <Show when={index() === notice().items.length - 1 && props.onUseApiKey}>
                {" "}
                <button type="button" class="own-btn" data-size="sm" onClick={() => props.onUseApiKey?.()}>
                  {st("own.acct.useApiKey")}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <p class="m-0 mt-2 text-[12px] leading-[18px] text-own-muted">{st("own.claude.builtIn.note")}</p>
    </div>
  )
}

/** (c) Import: one button; the router connects through the plugin's `claude-code` method. */
function ImportStep(props: {
  readonly claude: ClaudeStatusStore
  readonly onCancel: () => void
  readonly onDone: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const st = useClaudeSlotText()
  const own = data.local().own
  const [busy, setBusy] = createSignal(false)
  const [imported, setImported] = createSignal<Account.Connection | null>()
  const status = createStatus()
  const run = async () => {
    if (busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("plugin.claudeAuth.importSubscription", {})
      .then(async (output) => {
        await props.claude.refresh()
        if (!output.ok) return status.error(st("own.acct.claudeImportFailed"))
        setImported(output.connection)
      })
      .catch((error: unknown) =>
        status.error(
          errorType(error) === "plugin_not_installed" ? st("own.claude.builtIn.missing") : errorMessage(i18n, error),
        ),
      )
    setBusy(false)
  }
  return (
    <div class="mt-4" data-testid="claude-import">
      <p class="m-0 text-[13px]">{st("own.claude.needLogin")}</p>
      <Show when={imported()}>
        {(connection) => (
          <div class="mt-3">
            <Notice tone="ok">{st("own.claude.importedAsOf", { label: connection().label ?? "—" })}</Notice>
          </div>
        )}
      </Show>
      <StatusLine status={status} />
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="own-btn" onClick={() => props.onCancel()}>
          {i18n.t("own.kit.cancel")}
        </button>
        <Show
          when={imported()}
          fallback={
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              disabled={busy()}
              onClick={() => void run()}
              data-testid="claude-import-run"
            >
              <Show when={busy()}>
                <Spinner />
              </Show>
              {st("own.claude.import")}
            </button>
          }
        >
          <button type="button" class="own-btn" data-variant="primary" onClick={() => props.onDone()}>
            {st("own.kit.next")}
          </button>
        </Show>
      </div>
    </div>
  )
}

const CONNECTION_LABEL = {
  oauth: "own.acct.claudeConn.oauth",
  key: "own.acct.claudeConn.key",
  env: "own.acct.claudeConn.env",
  none: "own.acct.claudeConn.none",
} as const

const WARNING_LABEL: Readonly<
  Record<string, "own.acct.claudeWarn.integrity" | "own.acct.claudeWarn.notLoaded" | "own.acct.claudeWarn.notBundled">
> = {
  integrity_mismatch: "own.acct.claudeWarn.integrity",
  not_loaded: "own.acct.claudeWarn.notLoaded",
  not_bundled: "own.acct.claudeWarn.notBundled",
}

/**
 * Claude section of /accounts (5.4 list, 5.4.1 (c)(d)): the slot card (account 1) with its real connection type, the
 * env/key billing warning, the "as of import" label, the bundle's state and the risk notice behind a fold, limits from
 * the unified headers and the fixed `비용 알 수 없음` line; then the added accounts and their actions. A service whose
 * bundle is not loaded says so (it ships with the app: a restart loads it).
 */
export function ClaudeSection(props: { readonly claude: ClaudeStatusStore; readonly onRename: (id: string) => void }) {
  const data = useData()
  const i18n = useI18n()
  const st = useClaudeSlotText()
  const local = data.local()
  const own = local.own
  const [changed, setChanged] = createSignal(false)
  const [color, setColor] = createSignal(false)
  const [relogin, setRelogin] = createSignal(false)
  const [flow, setFlow] = createSignal(false)
  const status = createStatus()
  const account = () => own.state.accounts["acc_claude_slot"]
  const claude = () => props.claude.status()
  const present = () => claude()?.installed === true || !!account()
  const connection = () => claude()?.connection ?? account()?.connection ?? null
  /** 02 §8.7: the Claude accounts besides the slot's own, and how many there are in all. */
  const added = () => addedClaudeAccounts(own.state.accountOrder.flatMap((id) => own.state.accounts[id] ?? []))
  const thisPc = () => own.rpc.allowed("plugin.claudeAuth.accounts.add.plan")

  // 5.4.1 (c): Claude Code logins can change without an OpenCode event; when one arrives, say so and re-read.
  onCleanup(
    local.bus.listen((event) => {
      if (
        event.type === "credential.updated" ||
        (event.type === "credential.switched" && event.data.integrationID === "anthropic")
      ) {
        setChanged(true)
        void props.claude.refresh()
      }
    }),
  )

  const reimport = async () => {
    status.clear()
    await own.rpc
      .call("plugin.claudeAuth.importSubscription", {})
      .then((output) =>
        output.ok ? status.ok(st("own.acct.claudeReimported")) : status.error(st("own.acct.claudeImportFailed")),
      )
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    await props.claude.refresh()
  }

  const canManage = () => own.rpc.allowed("plugin.claudeAuth.importSubscription")
  return (
    <section class="own-psec" data-testid="claude-section">
      {/* The two tags go under the title when the page is narrow (a phone). */}
      <div class="own-psec-head flex-wrap">
        <ProviderMark kind="claude-sub" />
        <h2>{kindLabel(i18n, "claude-sub")}</h2>
        <Show when={account()}>
          <span class="text-[12.5px] text-own-muted" data-testid="claude-account-count">
            {st("own.claude.accounts.summary", { n: added().length + 1 })}
          </span>
        </Show>
        <span class="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Tag tone="soft">{i18n.t("own.claude.builtIn.tag")}</Tag>
          <Tag tone="danger">{i18n.t("own.claude.badge")}</Tag>
        </span>
      </div>
      <Show when={changed()}>
        <div class="mb-2">
          <Notice tone="warn">
            {st("own.claude.accountMayHaveChanged")}{" "}
            <button type="button" class="own-link" onClick={() => setChanged(false)}>
              {st("own.kit.dismiss")}
            </button>
          </Notice>
        </div>
      </Show>
      <Show
        when={present()}
        fallback={
          <article class="own-acard" data-testid="claude-slot-missing">
            <Show when={claude()} fallback={<span class="text-own-muted">{i18n.t("own.shell.loading")}</span>}>
              {/* No bundle in this install: a restart cannot help (`bundle_missing`); else it loads the app's. */}
              <Show
                when={claude()?.warnings.includes("bundle_missing")}
                fallback={<ClaudeBundleNotice claude={props.claude} />}
              >
                <Notice tone="warn" testid="claude-bundle-absent">
                  {st("own.claude.builtIn.absent")}
                </Notice>
              </Show>
            </Show>
          </article>
        }
      >
        <article class="own-acard" data-account-id="acc_claude_slot" data-testid="claude-slot-card">
          <div class="flex flex-wrap items-center gap-2">
            <Show when={account()}>{(item) => <Dot color={item().color} />}</Show>
            <span class="font-semibold">{account()?.label ?? i18n.t("own.acct.kind.claude-sub")}</span>
            <Tag tone="danger">{i18n.t("own.accounts.type.unofficial")}</Tag>
            <Show when={connection()}>
              {(item) => (
                <Tag tone={item().type === "oauth" ? "soft" : "danger"}>{st(CONNECTION_LABEL[item().type])}</Tag>
              )}
            </Show>
            <span class="ml-auto flex items-center gap-2 text-[12px] text-own-muted">
              <Show when={claude()?.version}>{(version) => <span class="own-mono">{version()}</span>}</Show>
              <Show when={account()?.sessions}>
                {(sessions) => (
                  <span>{i18n.t("own.accounts.usage", { running: sessions().running, total: sessions().total })}</span>
                )}
              </Show>
              <Show when={canManage()}>
                <Menu
                  label={i18n.t("own.acct.menu", { account: account()?.label ?? "Claude" })}
                  testid="claude-menu"
                  entries={() => [
                    ...(account()
                      ? [
                          { label: i18n.t("own.acct.rename"), onSelect: () => props.onRename("acc_claude_slot") },
                          { label: i18n.t("own.acct.recolor"), onSelect: () => setColor(true) },
                        ]
                      : []),
                    { label: st("own.acct.reimport"), onSelect: () => void reimport() },
                    ...(account() && thisPc()
                      ? [{ label: claudeAccountsText.text(i18n.locale(), "own.claude.accounts.relogin"), onSelect: () => setRelogin(true) }]
                      : []),
                  ]}
                />
              </Show>
            </span>
          </div>
          <Show when={(connection()?.type ?? "none") === "none" && canManage()}>
            <div class="mt-2 flex flex-wrap items-center gap-3 text-[13px]">
              <span class="text-own-muted">{st("own.acct.claudeConn.none")}</span>
              <button
                type="button"
                class="own-btn ml-auto"
                data-size="sm"
                onClick={() => setFlow(true)}
                data-testid="claude-connect"
              >
                {st("own.acct.connect")}
              </button>
            </div>
          </Show>
          <Show when={connection()?.label}>
            {(label) => (
              <p class="m-0 mt-1 text-[12.5px] text-own-muted">{st("own.claude.importedAsOf", { label: label() })}</p>
            )}
          </Show>
          <Show when={connection()?.type === "key" || connection()?.type === "env"}>
            <div class="mt-2">
              <Notice tone="danger">
                {st("own.banner.slotChanged")}{" "}
                <button type="button" class="own-link" onClick={() => void reimport()}>
                  {st("own.acct.reimport")}
                </button>
              </Notice>
            </div>
          </Show>
          <Show when={account()?.status === "needs_reauth" && !account()?.claude?.stale && !refreshFailed(account())}>
            <div class="mt-2">
              <Notice tone="warn">{claudeAccountsText.text(i18n.locale(), "own.claude.accounts.needsLogin")}</Notice>
            </div>
          </Show>
          {/* CR: the login's last refresh, when there is something to say (an account own refreshes itself). */}
          <Show when={account()?.claude?.refresh}>
            {(refresh) => (
              <ClaudeRefreshLine
                refresh={refresh()}
                canRelogin={canManage() && thisPc()}
                onRelogin={() => setRelogin(true)}
              />
            )}
          </Show>
          {/* 02 §8.7 (CS): Claude Code's own login is read only here; `다시 로그인` moves the account off it. */}
          <Show when={account()?.claude?.shared ? account() : undefined}>
            {(item) => (
              <ClaudeSharedLogin account={item()} canMove={canManage() && thisPc()} onMove={() => setRelogin(true)} />
            )}
          </Show>
          <For each={(claude()?.warnings ?? []).filter((code) => WARNING_LABEL[code] || code.startsWith("order_"))}>
            {(code) => (
              <p class="m-0 mt-1.5 text-[12.5px] text-own-warn">
                {code.startsWith("order_")
                  ? i18n.t("own.acct.claudeWarn.order", { order: code.slice("order_".length) })
                  : i18n.t(WARNING_LABEL[code]!)}
              </p>
            )}
          </For>
          <ClaudeBundleNotice claude={props.claude} />
          <details class="mt-2 text-[12.5px]" data-testid="claude-risk">
            <summary class="cursor-pointer text-own-muted">{i18n.t("own.claude.builtIn.risk")}</summary>
            <div class="mt-2">
              <RiskNotice />
            </div>
          </details>
          <div class="mt-2.5">
            <AccountLimits
              surface="accounts"
              windows={own.state.quota["acc_claude_slot"]}
              kind="claude-sub"
              rates
              now={minuteNow}
              resetCredits="acc_claude_slot"
            />
          </div>
          <p class="m-0 mt-2 text-[12.5px] text-own-warn">{i18n.t("own.claude.costUnknown")}</p>
          <ClaudeBillingNotice windows={own.state.quota["acc_claude_slot"]} />
          <p class="m-0 mt-1 text-[12px] text-own-muted">{i18n.t("own.acct.claudeCompaction")}</p>
          <StatusLine status={status} />
        </article>
        <For each={added()}>
          {(item) => <ClaudeAccountCard account={item} canManage={canManage()} onRename={props.onRename} />}
        </For>
        {/* 04 §8.11.12 (SLM): the host switches are the whole slot's, every Claude account of this PC, so they sit
            after all the accounts' cards, never inside account 1's. */}
        <Show when={claude()?.remote}>
          {(remote) => (
            <article class="own-acard" data-testid="claude-remote-block">
              <ClaudeRemote claude={props.claude} remote={remote()} />
            </article>
          )}
        </Show>
        <Show when={account()}>
          <ClaudeAccountActions claude={props.claude} onImport={reimport} />
        </Show>
      </Show>
      <Dialog
        open={flow()}
        title={i18n.t("own.acct.kind.claude-sub")}
        onClose={() => setFlow(false)}
        testid="claude-flow-dialog"
      >
        <ClaudeFlow
          claude={props.claude}
          onClose={() => {
            setFlow(false)
            void props.claude.refresh()
          }}
        />
      </Dialog>
      <Show when={account()}>
        {(item) => <ColorDialog open={color()} account={item()} onClose={() => setColor(false)} />}
      </Show>
      <Show when={relogin() && account()}>
        {(item) => <AddClaudeAccount account={item()} onClose={() => setRelogin(false)} />}
      </Show>
    </section>
  )
}

/** Web and mobile have no service control: the restart command and the 01 §9.4 hint (16.3). */
export function ManualRestart() {
  const i18n = useI18n()
  const st = useClaudeSlotText()
  const [copied, setCopied] = createSignal(false)
  return (
    <div class="mt-3" data-testid="manual-restart">
      <Notice tone="warn">
        <p class="m-0">{st("own.acct.restartManual")}</p>
        <div class="mt-2 flex items-center gap-2">
          <code class="own-mono rounded bg-own-hover px-1.5 py-0.5">own restart</code>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            onClick={() => void copyText("own restart").then(setCopied)}
          >
            {i18n.t(copied() ? "own.acct.copied" : "own.state.copyCommand")}
          </button>
        </div>
      </Notice>
    </div>
  )
}

/** Session titles for plan results (affected / running sessions). */
export function SessionList(props: { readonly ids: readonly string[] }) {
  const data = useData()
  const i18n = useI18n()
  return (
    <ul class="m-0 mt-1.5 list-disc pl-5 text-[12.5px]" data-testid="plan-sessions">
      <For each={props.ids.slice(0, 20)}>
        {(id) => <li>{data.local().sessions.state.sessions[id]?.title || id}</li>}
      </For>
      <Show when={props.ids.length > 20}>
        <li class="list-none text-own-faint">{i18n.t("own.lim.more", { n: props.ids.length - 20 })}</li>
      </Show>
    </ul>
  )
}

/**
 * `SSH 원격 호스트에서 쓰기` (04 §8.11.12): every SSH host of this PC with its state and switch, for every Claude
 * subscription account of this PC at once (the switch names no account), in its own block after the accounts' cards. Switching one on the
 * first time (or after the remote consent went stale) shows the remote notice; `동의하고 켜기` records the consent and
 * switches. Only this PC's windows switch (the methods are `local`); a gateway device sees the states.
 */
function ClaudeRemote(props: { readonly claude: ClaudeStatusStore; readonly remote: Plugin.ClaudeRemoteStatus }) {
  const data = useData()
  const i18n = useI18n()
  const st = useClaudeSlotText()
  const own = data.local().own
  const [busy, setBusy] = createSignal(false)
  const [asking, setAsking] = createSignal<(accepted: boolean) => void>()
  const status = createStatus()
  const rows = () => remoteRows(props.remote, remoteStore()?.state)
  const writable = () => own.rpc.allowed("plugin.claudeAuth.remote.set")
  // The hosts' relay views (`broker.claude`: refusals, holds) change without an own.remote event: read them on open.
  void remoteStore()?.refreshBroker()

  const toggle = async (hostId: string, enabled: boolean) => {
    if (busy()) return
    setBusy(true)
    status.clear()
    await switchRemoteHost({
      call: own.rpc.call,
      status: props.claude.status(),
      hostId,
      enabled,
      locale: i18n.locale(),
      notice: () => new Promise<boolean>((resolve) => setAsking(() => resolve)),
    })
      .then((result) => {
        if (result.kind === "stale") status.error(st("own.acct.claudeAckStale"))
      })
      .catch((error: unknown) =>
        // `remote.ack` refuses a consent that names another plugin build or notice (`ack_required{stale}`).
        status.error(errorType(error) === "ack_required" ? st("own.acct.claudeAckStale") : errorMessage(i18n, error)),
      )
    setAsking(undefined)
    await Promise.all([props.claude.refresh(), remoteStore()?.refreshBroker()])
    setBusy(false)
  }
  const answer = (accepted: boolean) => {
    asking()?.(accepted)
    setAsking(undefined)
  }

  return (
    <div data-testid="claude-remote">
      <h3 class="m-0 text-[13px] font-semibold">{st("own.claude.remote.title")}</h3>
      <p class="m-0 mt-1 text-[12.5px] text-own-muted">{st("own.claude.remote.help")}</p>
      <p class="m-0 mt-1 text-[12px] text-own-faint">{st("own.claude.remote.others")}</p>
      <ul class="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        <For each={rows()}>
          {(row) => (
            <li
              class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]"
              data-testid="claude-remote-host"
              data-host={row.hostId}
              data-state={row.state}
            >
              <span class="font-semibold">{row.name}</span>
              <span class="min-w-0 flex-1 text-[12.5px] text-own-muted" data-testid="claude-remote-state">
                {i18n.t(`own.claude.remote.state.${claudeHostState(row.state, row.host, minuteNow())}`)}
              </span>
              <Show when={writable()}>
                {/* Named by the host, as the row says it. */}
                <ToggleSwitch
                  checked={row.enabled}
                  label={row.name}
                  busy={busy()}
                  testid="claude-remote-switch"
                  onChange={(enabled) => void toggle(row.hostId, enabled)}
                />
              </Show>
            </li>
          )}
        </For>
      </ul>
      <StatusLine status={status} />
      <RemoteNoticeDialog open={asking() !== undefined} onAnswer={answer} />
    </div>
  )
}

/** The remote notice (04 §8.11.12), verbatim with its required checkbox, like the local one (5.4.1 (a)). */
function RemoteNoticeDialog(props: { readonly open: boolean; readonly onAnswer: (accepted: boolean) => void }) {
  return (
    <Show when={props.open}>
      <RemoteNoticeForm onAnswer={props.onAnswer} />
    </Show>
  )
}

function RemoteNoticeForm(props: { readonly onAnswer: (accepted: boolean) => void }) {
  const i18n = useI18n()
  const notice = () => remoteNotice(i18n.locale())
  const st = useClaudeSlotText()
  const [checked, setChecked] = createSignal(false)
  return (
    <Dialog
      open
      title={st("own.claude.remote.notice.title")}
      onClose={() => props.onAnswer(false)}
      testid="claude-remote-notice"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onAnswer(false)}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={!checked()}
            onClick={() => props.onAnswer(true)}
            data-testid="claude-remote-notice-continue"
          >
            {st("own.claude.remote.notice.continue")}
          </button>
        </>
      }
    >
      <h3 class="m-0 mb-2 flex items-center gap-2 text-[14px] font-semibold text-own-danger">
        <Tag tone="danger">{i18n.t("own.accounts.type.unofficial")}</Tag>
        {notice().title}
      </h3>
      <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] leading-5" lang={i18n.locale()}>
        <For each={notice().items}>{(item) => <li>{item}</li>}</For>
      </ul>
      <label class="mt-3 flex items-start gap-2 text-[13px] font-semibold" lang={i18n.locale()}>
        <input
          type="checkbox"
          class="mt-1"
          checked={checked()}
          onChange={(event) => setChecked(event.currentTarget.checked)}
          data-testid="claude-remote-notice-check"
        />
        {notice().check}
      </label>
    </Dialog>
  )
}

/** 5.4 `색 바꾸기`: saves on pick (`accounts.update{color}`). */
export function ColorDialog(props: {
  readonly open: boolean
  readonly account: Account.View
  readonly onClose: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const st = useClaudeSlotText()
  const status = createStatus()
  const pick = (color: Account.Color) =>
    data
      .local()
      .own.rpc.call("accounts.update", { accountID: props.account.id, color })
      .then(() => props.onClose())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  return (
    <Dialog
      open={props.open}
      title={st("own.acct.recolorTitle", { account: props.account.label })}
      onClose={props.onClose}
      dismissable
    >
      <ColorPicker value={props.account.color} colors={COLORS} onChange={(color) => void pick(color)} />
      <StatusLine status={status} />
    </Dialog>
  )
}
