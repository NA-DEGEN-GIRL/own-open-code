// Several Claude subscription accounts (02 §8.7, 03 §5.4.1, user decisions 2026-10-10): one card per added account
// (the slot's own card stays in claude-slot.tsx), `Claude 계정 추가` and `다시 로그인` through Claude Code's own login
// window on this PC, `이 PC의 기존 Claude Code 로그인 가져오기`, `계정 빼기…`, and the bundled plugin's notices (02
// §8.2: it ships with the app; a mismatch or an old copy loaded asks for a restart or a reinstall of the app). own-web
// never sees a password or a token: the router opens the login window and reports the outcome.
import type { Account } from "@own/protocol"
import { claudeAccountsText } from "./claude-accounts-strings"
import { createSignal, onCleanup, Show } from "solid-js"
import { useData } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useHost } from "@/host"
import { type I18n, useI18n } from "@/i18n"
import { Dialog, Dot, Menu, Notice, Spinner, StatusLine, Tag, createStatus } from "@/limits/kit"
import { AccountLimits } from "@/limits/summary"
import { minuteNow } from "@/shell/clock"
import { ClaudeBillingNotice } from "./claude-billing-notice"
import { claudeRefreshReason, useClaudeRefreshText } from "./claude-refresh-strings"
import { useClaudeSharedText } from "./claude-shared-strings"
import { ColorDialog, ManualRestart, SessionList, type ClaudeStatusStore } from "./claude-slot"
import { errorMessage, errorType } from "./errors"

/** How often the login window's progress is asked (the router watches the window itself). */
const POLL_MS = 1_000

/** The Claude accounts besides the slot's own, in the router's order. */
export function addedClaudeAccounts(accounts: readonly Account.View[]) {
  return accounts.filter((account) => account.kind === "claude-sub" && account.id !== "acc_claude_slot")
}

/** One added Claude account: label, default mark, its limits, `⋯` 라벨 바꾸기 · 색 바꾸기 · 다시 로그인 · 계정 빼기…. */
export function ClaudeAccountCard(props: {
  readonly account: Account.View
  readonly canManage: boolean
  readonly onRename: (id: string) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const [color, setColor] = createSignal(false)
  const [remove, setRemove] = createSignal(false)
  const [relogin, setRelogin] = createSignal(false)
  const status = createStatus()
  const thisPc = () => own.rpc.allowed("plugin.claudeAuth.accounts.add.plan")
  const makeDefault = () =>
    own.rpc
      .call("plugin.claudeAuth.default.set", { accountID: props.account.id })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  return (
    <article class="own-acard" data-account-id={props.account.id} data-testid="claude-account-card">
      <div class="flex flex-wrap items-center gap-2">
        <Dot color={props.account.color} />
        <span class="font-semibold">{props.account.label}</span>
        <Tag tone="danger">{i18n.t("own.accounts.type.unofficial")}</Tag>
        <Show when={props.account.claude?.default}>
          <Tag tone="soft">{claudeAccountsText.text(i18n.locale(), "own.claude.accounts.default")}</Tag>
        </Show>
        <span class="ml-auto flex items-center gap-2 text-[12px] text-own-muted">
          <Show when={props.account.sessions}>
            {(sessions) => (
              <span>{i18n.t("own.accounts.usage", { running: sessions().running, total: sessions().total })}</span>
            )}
          </Show>
          <Show when={props.canManage}>
            <Menu
              label={i18n.t("own.acct.menu", { account: props.account.label })}
              testid="claude-account-menu"
              entries={() => [
                { label: i18n.t("own.acct.rename"), onSelect: () => props.onRename(props.account.id) },
                { label: i18n.t("own.acct.recolor"), onSelect: () => setColor(true) },
                ...(props.account.claude?.default
                  ? []
                  : [{ label: claudeAccountsText.text(i18n.locale(), "own.claude.accounts.makeDefault"), onSelect: () => void makeDefault() }]),
                ...(thisPc()
                  ? [{ label: claudeAccountsText.text(i18n.locale(), "own.claude.accounts.relogin"), onSelect: () => setRelogin(true) }]
                  : []),
                "separator" as const,
                {
                  label: claudeAccountsText.text(i18n.locale(), "own.claude.accounts.remove"),
                  tone: "danger" as const,
                  onSelect: () => setRemove(true),
                },
              ]}
            />
          </Show>
        </span>
      </div>
      <Show when={props.account.claude?.email}>
        {(email) => <p class="m-0 mt-1 text-[12.5px] text-own-muted">{email()}</p>}
      </Show>
      <Show
        when={props.account.status === "needs_reauth" && !props.account.claude?.stale && !refreshFailed(props.account)}
      >
        <div class="mt-2">
          <Notice tone="warn">
            {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.needsLogin")}
            <Show when={props.canManage && thisPc()}>
              {" "}
              <button
                type="button"
                class="own-link"
                onClick={() => setRelogin(true)}
                data-testid="claude-account-relogin"
              >
                {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.relogin")}
              </button>
            </Show>
          </Notice>
        </div>
      </Show>
      <Show when={props.account.claude?.refresh}>
        {(refresh) => (
          <ClaudeRefreshLine
            refresh={refresh()}
            canRelogin={props.canManage && thisPc()}
            onRelogin={() => setRelogin(true)}
          />
        )}
      </Show>
      {/* 02 §8.7 (CS): any account on a login Claude Code uses (a junction, a link, the account source's folder). */}
      <Show when={props.account.claude?.shared}>
        <ClaudeSharedLogin
          account={props.account}
          canMove={props.canManage && thisPc()}
          onMove={() => setRelogin(true)}
        />
      </Show>
      <div class="mt-2.5">
        <AccountLimits
          surface="accounts"
          windows={own.state.quota[props.account.id]}
          kind="claude-sub"
          rates
          now={minuteNow}
          resetCredits={props.account.id}
        />
      </div>
      <p class="m-0 mt-2 text-[12.5px] text-own-warn">{i18n.t("own.claude.costUnknown")}</p>
      <ClaudeBillingNotice windows={own.state.quota[props.account.id]} />
      <StatusLine status={status} />
      <ColorDialog open={color()} account={props.account} onClose={() => setColor(false)} />
      <Show when={remove()}>
        <RemoveClaudeAccount account={props.account} onClose={() => setRemove(false)} />
      </Show>
      <Show when={relogin()}>
        <AddClaudeAccount account={props.account} onClose={() => setRelogin(false)} />
      </Show>
    </article>
  )
}

/** CR: the card's refresh line says why it needs a new login (the generic notice is not shown then). */
export const refreshFailed = (account: Account.View | undefined) => account?.claude?.refresh?.state === "failed"

/**
 * 02 §8.7 (CR, 2026-10-26): a Claude card's refresh line (`claude.refresh`, an account the plugin refreshes itself):
 * `failed` warns with what the token endpoint said and `다시 로그인`; `retrying` is a short plain note (the next request
 * tries again); `due` a muted one (the first request refreshes it, not an error).
 */
export function ClaudeRefreshLine(props: {
  readonly refresh: Account.ClaudeRefresh
  readonly canRelogin: boolean
  readonly onRelogin: () => void
}) {
  const i18n = useI18n()
  const text = useClaudeRefreshText()
  const reason = () => claudeRefreshReason(props.refresh, text)
  return (
    <div class="mt-2" data-testid="claude-refresh" data-state={props.refresh.state}>
      <Show when={props.refresh.state === "failed"}>
        <Notice tone="warn" testid="claude-refresh-failed">
          {text("own.claude.refresh.failed", { reason: reason() })}
          <Show when={props.canRelogin}>
            {" "}
            <button
              type="button"
              class="own-link"
              onClick={() => props.onRelogin()}
              data-testid="claude-refresh-relogin"
            >
              {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.relogin")}
            </button>
          </Show>
        </Notice>
      </Show>
      <Show when={props.refresh.state === "retrying"}>
        <p class="m-0 text-[12.5px]" data-testid="claude-refresh-retrying">
          {text("own.claude.refresh.retrying", { reason: reason() })}
        </p>
      </Show>
      <Show when={props.refresh.state === "due"}>
        <p class="m-0 text-[12.5px] text-own-muted" data-testid="claude-refresh-due">
          {text("own.claude.refresh.due")}
        </p>
      </Show>
    </div>
  )
}

/**
 * 02 §8.7 (CS): a Claude account on a login Claude Code itself uses (`claude.shared`: account 1 on Claude Code's folder,
 * or any account own marks read only), on its card: the note, or once its token expired the stale text (one request in
 * Claude Code refreshes it), and `own 전용 로그인으로 바꾸기` (its `다시 로그인` plan moves it to an own login).
 */
export function ClaudeSharedLogin(props: {
  readonly account: Account.View
  readonly canMove: boolean
  readonly onMove: () => void
}) {
  const shared = useClaudeSharedText()
  return (
    <div class="mt-2" data-testid="claude-shared" data-stale={props.account.claude?.stale ? "true" : "false"}>
      <Show
        when={props.account.claude?.stale}
        fallback={
          <p class="m-0 text-[12.5px]" data-testid="claude-shared-note">
            {shared("own.claude.shared.note")}
          </p>
        }
      >
        <Notice tone="warn" testid="claude-shared-stale">
          {shared("own.claude.shared.stale", { account: props.account.label })}
        </Notice>
      </Show>
      <Show when={props.canMove}>
        <button
          type="button"
          class="own-btn mt-2"
          data-size="sm"
          onClick={() => props.onMove()}
          data-testid="claude-shared-move"
        >
          {shared("own.claude.shared.move")}
        </button>
      </Show>
    </div>
  )
}

/**
 * `Claude 계정 추가` and `이 PC의 기존 Claude Code 로그인 가져오기` under the Claude cards. Both act on this PC only
 * (the methods are `local`): another device sees `로그인 추가는 이 PC의 창에서만 할 수 있습니다.`.
 */
export function ClaudeAccountActions(props: {
  readonly claude: ClaudeStatusStore
  readonly onImport: () => Promise<void>
}) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const [adding, setAdding] = createSignal(false)
  const [found, setFound] = createSignal<OwnOutput<"plugin.claudeAuth.accounts.detect">>()
  const status = createStatus()
  const thisPc = () => own.rpc.allowed("plugin.claudeAuth.accounts.add.plan")
  /** The loaded plugin is the verified bundle with its multi-account exports (02 §8.2). */
  const multi = () => props.claude.status()?.patch?.state === "patched" && props.claude.status()?.patch?.loaded
  const detect = () =>
    own.rpc
      .call("plugin.claudeAuth.accounts.detect", {})
      .then((next) => void setFound(next))
      .catch(() => undefined)
  if (thisPc()) void detect()
  const importLogin = async () => {
    status.clear()
    await props.onImport()
    await detect()
  }
  return (
    <div class="mt-2 flex flex-col gap-2" data-testid="claude-account-actions">
      <Show
        when={thisPc()}
        fallback={<p class="m-0 text-[12.5px] text-own-muted">{claudeAccountsText.text(i18n.locale(), "own.claude.accounts.pcOnly")}</p>}
      >
        <Show when={found() && !found()!.imported}>
          <div class="flex flex-wrap items-center gap-2 text-[13px]" data-testid="claude-import-existing">
            <Show
              when={found()!.found}
              fallback={<span class="text-own-muted">{claudeAccountsText.text(i18n.locale(), "own.claude.accounts.notFound")}</span>}
            >
              {(login) => (
                <span>
                  {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.found", { email: login().email ?? "—", folder: login().folder })}
                </span>
              )}
            </Show>
            <button
              type="button"
              class="own-btn ml-auto"
              data-size="sm"
              disabled={!found()!.found}
              onClick={() => void importLogin()}
              data-testid="claude-import-existing-run"
            >
              {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.import")}
            </button>
          </div>
        </Show>
        <Show when={multi()}>
          <div>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => setAdding(true)}
              data-testid="claude-account-add"
            >
              {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.add")}
            </button>
          </div>
        </Show>
      </Show>
      <StatusLine status={status} />
      <Show when={adding()}>
        <AddClaudeAccount onClose={() => setAdding(false)} />
      </Show>
    </div>
  )
}

/**
 * `Claude 계정 추가`: plan (finds Claude Code) → `로그인 시작` (the window opens on this PC) → polled outcome. With
 * `account`, `다시 로그인`: the same window into that account's own folder (an expired or revoked login). An account on
 * Claude Code's own login (`claude.shared`, CS 2026-10-22) is never logged into there: the dialog explains why and
 * the login goes into a folder of this app's own (`own 전용 로그인으로 바꾸기`, the plan's `move`). A move whose login is
 * another Claude account (`mismatch`) changes nothing and offers `새 계정으로 추가` (the dialog of `Claude 계정 추가`).
 */
export function AddClaudeAccount(props: { readonly account?: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const [plan, setPlan] = createSignal<OwnOutput<"plugin.claudeAuth.accounts.add.plan">>()
  const [waiting, setWaiting] = createSignal(false)
  const [done, setDone] = createSignal(false)
  const status = createStatus()
  const shared = useClaudeSharedText()
  /** `새 계정으로 추가` after a `mismatch`: the dialog becomes `Claude 계정 추가`. */
  const [asNew, setAsNew] = createSignal(false)
  const [mismatch, setMismatch] = createSignal(false)
  const account = () => (asNew() ? undefined : props.account)
  // The plan decides once it arrived (a folder Claude Code uses is never logged into); until then the view's flag.
  const move = () => {
    const current = plan()
    return current === undefined ? account()?.claude?.shared === true : current.move === true
  }
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  onCleanup(() => clearTimeout(timer.id))
  const load = (target: Account.View | undefined) =>
    void own.rpc
      .call("plugin.claudeAuth.accounts.add.plan", target ? { accountID: target.id } : {})
      .then((next) => void setPlan(next))
      .catch((error: unknown) => status.error(unavailable(i18n, error)))
  load(props.account)
  const addNew = () => {
    setAsNew(true)
    setMismatch(false)
    setDone(false)
    setPlan(undefined)
    status.clear()
    load(undefined)
  }
  const poll = (attemptID: string) => {
    timer.id = setTimeout(async () => {
      const next = await own.rpc.call("plugin.claudeAuth.accounts.add.status", { attemptID }).catch(() => undefined)
      if (!next || next.state === "waiting") return poll(attemptID)
      setWaiting(false)
      setDone(true)
      if (next.state === "added")
        return status.ok(
          move()
            ? shared("own.claude.shared.moved", { label: next.label ?? "Claude" })
            : claudeAccountsText.text(i18n.locale(), account() ? "own.claude.accounts.relogged" : "own.claude.accounts.added", {
                label: next.label ?? "Claude",
              }),
        )
      if (next.state === "duplicate") return status.info(claudeAccountsText.text(i18n.locale(), "own.claude.accounts.duplicate"))
      if (next.state === "mismatch") {
        setMismatch(true)
        return status.error(shared("own.claude.shared.mismatch"))
      }
      status.error(claudeAccountsText.text(i18n.locale(), next.state === "timeout" ? "own.claude.accounts.timeout" : "own.claude.accounts.failed"))
    }, POLL_MS)
  }
  const start = async () => {
    const current = plan()
    if (!current || waiting()) return
    status.clear()
    setWaiting(true)
    await own.rpc
      .call("plugin.claudeAuth.accounts.add.execute", { nonce: current.nonce })
      .then((started) => poll(started.attemptID))
      .catch((error: unknown) => {
        setWaiting(false)
        status.error(unavailable(i18n, error))
      })
  }
  return (
    <Dialog
      open
      title={
        !account()
          ? claudeAccountsText.text(i18n.locale(), "own.claude.accounts.add")
          : move()
            ? shared("own.claude.shared.moveTitle", { account: account()!.label })
            : claudeAccountsText.text(i18n.locale(), "own.claude.accounts.reloginTitle", { account: account()!.label })
      }
      onClose={() => props.onClose()}
      testid="claude-account-add-dialog"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t(done() ? "own.kit.close" : "own.kit.cancel")}
          </button>
          <Show when={mismatch()}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              onClick={addNew}
              data-testid="claude-account-add-new"
            >
              {shared("own.claude.shared.addNew")}
            </button>
          </Show>
          <Show when={!done()}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              disabled={!plan()?.cli || waiting()}
              onClick={() => void start()}
              data-testid="claude-account-add-start"
            >
              <Show when={waiting()}>
                <Spinner />
              </Show>
              {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.start")}
            </button>
          </Show>
        </>
      }
    >
      <p class="m-0" lang="ko" data-testid={move() ? "claude-account-move-body" : undefined}>
        {move()
          ? shared("own.claude.shared.moveBody", {
              account: account()?.label ?? "Claude",
              folder: account()?.claude?.folder ?? "",
            })
          : claudeAccountsText.text(i18n.locale(), account() ? "own.claude.accounts.reloginBody" : "own.claude.accounts.addBody")}
      </p>
      <Show when={plan() && plan()!.cli === null}>
        <div class="mt-3">
          <Notice tone="warn" testid="claude-cli-missing">
            {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.cliMissing")}
          </Notice>
        </div>
      </Show>
      <Show when={waiting()}>
        <p class="m-0 mt-3 flex items-center gap-2 text-[13px]" data-testid="claude-account-waiting">
          <Spinner />
          {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.waiting")}
        </p>
      </Show>
      <StatusLine status={status} testid="claude-account-add-status" />
    </Dialog>
  )
}

/** `계정 빼기…`: the conversations that move to the default account, and the folder choice (own folders only). */
function RemoveClaudeAccount(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const [plan, setPlan] = createSignal<OwnOutput<"plugin.claudeAuth.accounts.remove.plan">>()
  const [folder, setFolder] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  void own.rpc
    .call("plugin.claudeAuth.accounts.remove.plan", { accountID: props.account.id })
    .then((next) => {
      setPlan(next)
      setFolder(next.deleteFolder.default)
    })
    .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  const run = async () => {
    const current = plan()
    if (!current || busy()) return
    setBusy(true)
    await own.rpc
      .call("plugin.claudeAuth.accounts.remove.execute", { nonce: current.nonce, deleteFolder: folder() })
      .then(() => props.onClose())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }
  return (
    <Dialog
      open
      title={claudeAccountsText.text(i18n.locale(), "own.claude.accounts.removeTitle", { account: props.account.label })}
      onClose={() => props.onClose()}
      testid="claude-account-remove-dialog"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="danger"
            disabled={!plan() || busy()}
            onClick={() => void run()}
            data-testid="claude-account-remove-confirm"
          >
            {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.removeConfirm")}
          </button>
        </>
      }
    >
      <Show when={plan()}>
        {(current) => (
          <div class="flex flex-col gap-2">
            <Show
              when={current().boundSessions.length}
              fallback={<p class="m-0">{claudeAccountsText.text(i18n.locale(), "own.claude.accounts.removeNone")}</p>}
            >
              <div>
                <p class="m-0">{claudeAccountsText.text(i18n.locale(), "own.claude.accounts.removeSessions", { n: current().boundSessions.length })}</p>
                <SessionList ids={current().boundSessions} />
              </div>
            </Show>
            <Show when={current().deleteFolder.offered}>
              <label class="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={folder()}
                  onChange={(event) => setFolder(event.currentTarget.checked)}
                  data-testid="claude-account-remove-folder"
                />
                {claudeAccountsText.text(i18n.locale(), "own.claude.accounts.removeFolder")}
              </label>
            </Show>
          </div>
        )}
      </Show>
      <StatusLine status={status} />
    </Dialog>
  )
}

/**
 * The bundled plugin's state on the slot card (02 §8.2): its files differ from the app's record (reinstall the app),
 * the loaded claude-auth is not the app's (the former install: a restart loads the bundle), or the loaded module lacks
 * the multi-account exports (restart). Nothing to do while it is the verified bundle.
 */
export function ClaudeBundleNotice(props: { readonly claude: ClaudeStatusStore }) {
  const i18n = useI18n()
  const data = useData()
  const own = data.local().own
  const warnings = () => props.claude.status()?.warnings ?? []
  const canRestart = () => own.rpc.allowed("plugin.claudeAuth.importSubscription")
  const restartable = () => ["not_bundled", "not_loaded", "patch_restart"].some((code) => warnings().includes(code))
  return (
    <>
      <Show when={props.claude.status()?.patch?.state === "modified" && !warnings().includes("not_bundled")}>
        <div class="mt-2">
          <Notice tone="danger" testid="claude-bundle-modified">
            {i18n.t("own.claude.bundle.modified")}
          </Notice>
        </div>
      </Show>
      <Show when={restartable()}>
        <div class="mt-2">
          <Notice tone="info" testid="claude-bundle-restart">
            {i18n.t("own.claude.bundle.restart")}
            <Show when={canRestart()}>
              <RestartButton />
            </Show>
          </Notice>
        </div>
      </Show>
    </>
  )
}

/**
 * Restarts the service through the desktop host, or shows the manual command (web and mobile). A refusal (a
 * conversation is running) or a failed start is said.
 */
function RestartButton() {
  const host = useHost()
  const i18n = useI18n()
  const [manual, setManual] = createSignal(false)
  const status = createStatus()
  const restart = async () => {
    if (!host.capabilities.serviceControl || !host.service) return void setManual(true)
    status.clear()
    const restarted = await host.service.restart({ force: false })
    if (restarted.ok) return
    status.error(
      restarted.refused === "session_running"
        ? i18n.t("own.desktop.launcherRefused")
        : i18n.t("own.desktop.startFailed"),
    )
  }
  return (
    <>
      {" "}
      <button type="button" class="own-link" onClick={() => void restart()} data-testid="claude-bundle-restart-now">
        {i18n.t("own.claude.bundle.restartNow")}
      </button>
      <Show when={manual()}>
        <ManualRestart />
      </Show>
      <StatusLine status={status} testid="claude-bundle-restart-status" />
    </>
  )
}

/** The router's refusal of a login as the card's words (`claude_account_unavailable`). */
function unavailable(i18n: I18n, error: unknown) {
  if (errorType(error) !== "claude_account_unavailable") return errorMessage(i18n, error)
  const reason = (error as { data?: { reason?: string } }).data?.reason
  if (reason === "cli_missing") return claudeAccountsText.text(i18n.locale(), "own.claude.accounts.cliMissing")
  if (reason === "not_patched") return i18n.t("own.claude.bundle.restart")
  return claudeAccountsText.text(i18n.locale(), "own.claude.accounts.waiting")
}
